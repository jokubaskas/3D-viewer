# Atea variklis – tekstūra iš nuotraukų (mvs-texturing / ODM logika, savas kodas):
#   1. matomumas: kiekvienai ištiesintai kamerai – spindulių sekimas tinkle (Open3D), kiek pikselių mato kiekvieną
#      trikampį (projekcijos plotas su užstojimais; kadro centras – svaresnis, kraštai – mažiau);
#   2. kiekvienam trikampiui – 3 geriausios nuotraukos; parinkimas išlyginamas tarp kaimynų (mažiau siūlių);
#   3. tos pačios nuotraukos gretimi trikampiai – „lopai“; nuotraukos iškarpos sudedamos į tekstūrų lapus (atlasą);
#   4. rezultatas: OBJ + MTL + JPEG lapai, GLB (naršyklei) ir trikampių UV (ortofoto kūrimui).
import os

import numpy as np

TOP = 10  # kandidatinių nuotraukų trikampiui (spalvų nuoseklumui; fasadui – kad viena nuotrauka padengtų daugiau)


def load_cameras(dense_dir):
    """Ištiesintos kameros (PINHOLE) iš COLMAP darbo katalogo."""
    import pycolmap
    rec = pycolmap.Reconstruction(os.path.join(dense_dir, "sparse"))
    cams = []
    for im in sorted(rec.images.values(), key=lambda i: i.name):
        if not im.has_pose:
            continue
        c = im.camera
        fx, fy, cx, cy = c.params[:4] if len(c.params) >= 4 else (c.params[0], c.params[0], c.params[1], c.params[2])
        T = im.cam_from_world()
        V = np.eye(4)
        V[:3, :3] = T.rotation.matrix()
        V[:3, 3] = T.translation
        cams.append({"name": im.name, "path": os.path.join(dense_dir, "images", im.name), "viewmat": V,
                     "K": np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1.0]]), "width": c.width, "height": c.height})
    return cams


def face_adjacency(F):
    """Trikampių poros, turinčios bendrą kraštinę (E×2)."""
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    fid = np.tile(np.arange(len(F)), 3)
    e.sort(1)
    key = e[:, 0].astype(np.int64) * (int(F.max()) + 1) + e[:, 1]
    order = np.argsort(key, kind="stable")
    k, f = key[order], fid[order]
    same = np.flatnonzero(k[1:] == k[:-1])
    return np.stack([f[same], f[same + 1]], 1)


def face_geometry(V, F):
    """Trikampių centrai, vienetinės normalės ir plotai."""
    A, B, C = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    n = np.cross(B - A, C - A)
    area = 0.5 * np.linalg.norm(n, axis=1)
    n = n / np.maximum(2 * area[:, None], 1e-12)
    return (A + B + C) / 3.0, n, area


def smoothed_normals(V, F, iters=15):
    """Trikampių normalės iš išlyginto tinklo – nuotraukai parinkti. 2,5D tinklo siena, nelygiagreti tinkleliui, yra
    10 cm „laipteliai“: tikros normalės kaitaliojasi (x / y), kaimyniniai trikampiai pasirenka skirtingas nuotraukas ir
    siena subyra į vertikalias juostas. Išlyginus – visa siena turi vieną kryptį."""
    import open3d as o3d
    m = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(V), o3d.utility.Vector3iVector(F))
    m = m.filter_smooth_laplacian(number_of_iterations=iters, lambda_filter=0.5)
    Vs = np.asarray(m.vertices)
    n = np.cross(Vs[F[:, 1]] - Vs[F[:, 0]], Vs[F[:, 2]] - Vs[F[:, 0]])
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    _, N0, _ = face_geometry(V, F)
    return np.where(ln > 1e-12, n / np.maximum(ln, 1e-12), N0)


def visibility(V, F, cams, size=1600, log=print, normals=None, oriented=False):
    """Kiekvienam trikampiui – TOP geriausių nuotraukų (indeksai, balai); −1 – nematoma.
    Kaip mvs-texturing: trikampio centras projektuojamas į kiekvieną nuotrauką ir tikrinamas gylio žemėlapiu
    (užstoja mašina, medis, kitas pastatas – ta nuotrauka netinka). Balas – trikampio plotas nuotraukoje (px²):
    arčiau ir statmeniau – geriau, kadro kraštai – silpniau. Smulkūs trikampiai įvertinami taip pat tiksliai."""
    import open3d as o3d
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(V.astype(np.float32)), o3d.core.Tensor(F.astype(np.uint32)))
    nF = len(F)
    Cf, Nf, Af = face_geometry(V, F)
    if normals is not None:
        Nf = normals
    Cf32 = Cf.astype(np.float32)
    Vf32 = np.asarray(V, np.float32)
    best_s = np.zeros((nF, TOP), np.float32)
    best_c = np.full((nF, TOP), -1, np.int32)
    fb_s = np.zeros(nF, np.float32)  # be užstojimo patikros – tik visai nematomiems
    fb_c = np.full(nF, -1, np.int32)
    for ci, cam in enumerate(cams):
        s = min(1.0, size / max(cam["width"], cam["height"]))
        W, H = max(8, int(cam["width"] * s)), max(8, int(cam["height"] * s))
        K = cam["K"].copy()
        K[:2] *= s
        R, tv = cam["viewmat"][:3, :3], cam["viewmat"][:3, 3]
        rays = o3d.t.geometry.RaycastingScene.create_rays_pinhole(o3d.core.Tensor(K), o3d.core.Tensor(cam["viewmat"]), W, H)
        t = scene.cast_rays(rays)["t_hit"].numpy()
        d = rays.numpy()[..., 3:]
        # Taškas = centras + t · d (d – nebūtinai vienetinis), gylis kameros ašyje: z = t · (d · R₂)
        zbuf = np.where(np.isfinite(t), t * (d @ R[2].astype(np.float32)), np.inf)
        # 3 × 3 maksimumas – trikampio centras ant briaunos neturi būti laikomas užstotu
        zpad = np.pad(np.where(np.isfinite(zbuf), zbuf, 1e9), 1, mode="edge")
        zmax = np.max(np.stack([zpad[dy:dy + H, dx:dx + W] for dy in range(3) for dx in range(3)]), 0)
        Y = Cf32 @ R.T.astype(np.float32) + tv.astype(np.float32)
        z = Y[:, 2]
        ok = z > 0.1
        u = np.where(ok, K[0, 0] * Y[:, 0] / np.maximum(z, 1e-6) + K[0, 2], -1)
        v = np.where(ok, K[1, 1] * Y[:, 1] / np.maximum(z, 1e-6) + K[1, 2], -1)
        ok &= (u >= 0) & (u < W) & (v >= 0) & (v < H)
        # Visos trikampio viršūnės – nuotraukoje su atsarga (lopo kraštai ir siūlių išlyginimas ima ir gretimus
        # pikselius: už nuotraukos ribų – spalvos nėra, siūlėse atsiranda ryškios linijos)
        Yv = Vf32 @ R.T.astype(np.float32) + tv.astype(np.float32)
        zv = np.maximum(Yv[:, 2], 1e-6)
        mg = 0.01 * max(W, H) + 2
        uv_in = ((Yv[:, 2] > 0.1) & (K[0, 0] * Yv[:, 0] / zv + K[0, 2] >= mg) & (K[0, 0] * Yv[:, 0] / zv + K[0, 2] < W - mg)
                 & (K[1, 1] * Yv[:, 1] / zv + K[1, 2] >= mg) & (K[1, 1] * Yv[:, 1] / zv + K[1, 2] < H - mg))
        ok &= uv_in[F].all(1)
        idx = np.flatnonzero(ok)
        if not len(idx):
            continue
        ui, vi = u[idx].astype(np.int64), v[idx].astype(np.int64)
        center = -R.T @ tv
        vd = center[None, :] - Cf[idx]
        dist = np.linalg.norm(vd, axis=1)
        cos = np.einsum("ij,ij->i", Nf[idx], vd) / np.maximum(dist, 1e-9)
        # Tinklas su patikima orientacija (2,5D – normalės į viršų / lauką): tik kameros priešais paviršių. Kitaip
        # sienai tekstūrą duotų ir kamera už jos (pastato viduje matomas kitas fasadas) – juostos ir šiukšlės
        cos = cos if oriented else np.abs(cos)
        uu, vv = (u[idx] / W - 0.5), (v[idx] / H - 0.5)
        sc = (Af[idx] * cos * (K[0, 0] / z[idx]) ** 2 * (1.0 - 0.8 * (uu * uu + vv * vv))).astype(np.float32)
        good = cos > 0.1
        # Atsarginis (be užstojimo) – kad neliktų pilkų trikampių
        better = good & (sc > fb_s[idx])
        fb_s[idx[better]] = sc[better]
        fb_c[idx[better]] = ci
        tol = np.maximum(0.015 * z[idx], 0.08)
        vis = good & (z[idx] <= zmax[vi, ui] + tol)
        idx, sc = idx[vis], sc[vis]
        if not len(idx):
            continue
        cand_s = np.concatenate([best_s[idx], sc[:, None]], 1)
        cand_c = np.concatenate([best_c[idx], np.full((len(idx), 1), ci, np.int32)], 1)
        o = np.argsort(-cand_s, 1)[:, :TOP]
        best_s[idx] = np.take_along_axis(cand_s, o, 1)
        best_c[idx] = np.take_along_axis(cand_c, o, 1)
    unseen = best_c[:, 0] < 0
    rescue = unseen & (fb_c >= 0)
    best_c[rescue, 0], best_s[rescue, 0] = fb_c[rescue], fb_s[rescue]
    log("Matomumas: %d nuotraukų, trikampių be aiškaus vaizdo %d iš %d (iš jų %d – iš artimiausios nuotraukos)"
        % (len(cams), int(unseen.sum()), nF, int(rescue.sum())))
    return best_c, best_s


def sample_colors(V, F, cams, best_c, size=800):
    """Trikampio centro spalva kiekvienoje kandidatinėje nuotraukoje (sumažintose iki `size` px): [trikampiai, TOP, 3]."""
    from PIL import Image
    Cf, _, _ = face_geometry(V, F)
    col = np.full(best_c.shape + (3,), np.nan, np.float32)
    for ci in np.unique(best_c[best_c >= 0]):
        cam = cams[ci]
        img = Image.open(cam["path"]).convert("RGB")
        sc = min(1.0, size / max(img.size))
        if sc < 1:
            img = img.resize((max(1, int(img.width * sc)), max(1, int(img.height * sc))), Image.BILINEAR)
        a = np.asarray(img, np.float32)
        f, k = np.nonzero(best_c == ci)
        Y = Cf[f] @ cam["viewmat"][:3, :3].T + cam["viewmat"][:3, 3]
        z = np.maximum(Y[:, 2], 1e-6)
        u = (cam["K"][0, 0] * Y[:, 0] / z + cam["K"][0, 2]) * sc
        v = (cam["K"][1, 1] * Y[:, 1] / z + cam["K"][1, 2]) * sc
        ok = (Y[:, 2] > 0) & (u >= 0) & (v >= 0) & (u < a.shape[1] - 1) & (v < a.shape[0] - 1)
        col[f[ok], k[ok]] = a[v[ok].astype(int), u[ok].astype(int)]
    return col


def photo_consistency(best_c, best_s, col, thr=30.0, log=print):
    """Spalvų nuoseklumo patikra (mvs-texturing „outlier removal“): kai trikampį mato ≥ 3 nuotraukos, atmetamos tos,
    kurių spalva toli nuo daugumos – važiuojantys automobiliai, praeiviai, modelyje neatkurti užstojantys objektai.
    Kitaip jų gabalai lieka tekstūroje kaip „trikampiukai“ ant kelio ar žolės."""
    valid = (best_c >= 0) & np.isfinite(col[..., 0])
    n = valid.sum(1)
    m = np.nanmedian(np.where(valid[..., None], col, np.nan), axis=1) if valid.any() else None
    if m is None:
        return best_c, best_s
    dist = np.nanmean(np.abs(col - m[:, None, :]), axis=2)
    bad = valid & (n[:, None] >= 3) & (dist > thr)
    # Visų neatmetame – lieka bent viena (artimiausia daugumai)
    allbad = bad.sum(1) == valid.sum(1)
    if allbad.any():
        keep = np.nanargmin(np.where(valid[allbad], dist[allbad], np.inf), axis=1)
        bad[np.flatnonzero(allbad), keep] = False
    c = np.where(bad, -1, best_c)
    s = np.where(bad, 0, best_s)
    o = np.argsort(-s, 1, kind="stable")
    c, s = np.take_along_axis(c, o, 1), np.take_along_axis(s, o, 1)
    col[:] = np.take_along_axis(np.where(bad[..., None], np.nan, col), o[..., None], 1)
    log("Spalvų nuoseklumas: atmesta %d kandidatinių vaizdų (%d trikampių) – judantys ar neatkurti objektai"
        % (int(bad.sum()), int(bad.any(1).sum())))
    return c, s


def exposure_gains(cams, best_c, col, log=print):
    """Ekspozicijos išlyginimas (paprastas „seam leveling“): kiekvienai nuotraukai – spalvos koeficientai (R, G, B),
    kad tas pats paviršius skirtingose nuotraukose būtų vienodos spalvos (mažiau „lopų“)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.linalg import lsqr
    cand = best_c
    rows, cols, vals, rhs = [], [], [], [[], [], []]
    r = 0
    for k in range(1, TOP):
        ok = np.isfinite(col[:, 0, 0]) & np.isfinite(col[:, k, 0]) & (cand[:, k] >= 0) & (cand[:, 0] >= 0)
        ok &= (np.nanmin(col[:, 0], 1) > 8) & (np.nanmin(col[:, k], 1) > 8) & (np.nanmax(col[:, 0], 1) < 250) & (np.nanmax(col[:, k], 1) < 250)
        idx = np.flatnonzero(ok)
        if len(idx) > 200_000:
            idx = np.random.default_rng(k).choice(idx, 200_000, replace=False)
        n = len(idx)
        if not n:
            continue
        ri = np.arange(r, r + n)
        rows += [ri, ri]
        cols += [cand[idx, 0], cand[idx, k]]
        vals += [np.ones(n), -np.ones(n)]
        for ch in range(3):  # log(c_k) − log(c_0) ≈ g_0 − g_k
            rhs[ch].append(np.log(col[idx, k, ch]) - np.log(col[idx, 0, ch]))
        r += n
    nC = len(cams)
    if r < 50 or nC < 2:
        return np.ones((nC, 3), np.float32)
    lam = 0.1 * np.sqrt(r / nC)  # silpnas traukimas į 1 (be jo sprendinys neapibrėžtas)
    rows.append(np.arange(r, r + nC)); cols.append(np.arange(nC)); vals.append(np.full(nC, lam))
    A = coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(r + nC, nC)).tocsr()
    g = np.ones((nC, 3), np.float32)
    for ch in range(3):
        b = np.concatenate(rhs[ch] + [np.zeros(nC)])
        x = lsqr(A, b, atol=1e-6, btol=1e-6, iter_lim=500)[0]
        g[:, ch] = np.exp(np.clip(x - np.median(x), -0.4, 0.4))
    log("Ekspozicijos išlyginimas: %d nuotraukų, koeficientai %.2f–%.2f" % (nC, float(g.min()), float(g.max())))
    return g


def smooth_labels(best_c, best_s, adj, iters=10, weight=1.0):
    """Kaimynų išlyginimas (paprastas MRF / ICM): kandidatas = TOP nuotraukų, balas = matomumo dalis + kaimynų sutapimas."""
    nF = len(best_c)
    lab = best_c[:, 0].copy()
    norm = np.maximum(best_s[:, :1], 1e-6)
    rel = best_s / norm  # 1 – geriausia
    a, b = adj[:, 0], adj[:, 1]
    deg = np.bincount(np.concatenate([a, b]), minlength=nF).astype(np.float32)
    for _ in range(iters):
        score = np.where(best_c >= 0, rel, -1e9).astype(np.float32)
        for k in range(TOP):
            ck = best_c[:, k]
            agree = np.zeros(nF, np.float32)
            m = lab[b] == ck[a]
            np.add.at(agree, a[m], 1)
            m = lab[a] == ck[b]
            np.add.at(agree, b[m], 1)
            score[:, k] += weight * agree / np.maximum(deg, 1)
        new = best_c[np.arange(nF), np.argmax(score, 1)]
        if np.array_equal(new, lab):
            break
        lab = new
    return lab


def patches(labels, adj):
    """Lopai: gretimi tos pačios nuotraukos trikampiai (sujungtos komponentės)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    nF = len(labels)
    m = labels[adj[:, 0]] == labels[adj[:, 1]]
    a, b = adj[m, 0], adj[m, 1]
    g = coo_matrix((np.ones(len(a), np.int8), (a, b)), shape=(nF, nF))
    _, comp = connected_components(g, directed=False)
    return comp


def project(cam, X):
    Y = X @ cam["viewmat"][:3, :3].T + cam["viewmat"][:3, 3]
    z = np.maximum(Y[:, 2], 1e-6)
    return np.stack([cam["K"][0, 0] * Y[:, 0] / z + cam["K"][0, 2], cam["K"][1, 1] * Y[:, 1] / z + cam["K"][1, 2]], 1)


class Packer:
    """Paprastas lentynų (shelf) pakavimas į kvadratinius lapus."""

    def __init__(self, size):
        self.size = size
        self.pages = 0
        self._new_page()

    def _new_page(self):
        self.page = self.pages
        self.pages += 1
        self.x = self.y = self.shelf = 0
        # 0 lapo kampas – pilka spalva nematomiems trikampiams
        if self.page == 0:
            self.x = 8
            self.shelf = 8

    def place(self, w, h):
        if self.x + w > self.size:
            self.x, self.y, self.shelf = 0, self.y + self.shelf, 0
        if self.y + h > self.size:
            self._new_page()
            return self.place(w, h)
        p = (self.page, self.x, self.y)
        self.x += w + 2
        self.shelf = max(self.shelf, h + 2)
        return p


def facade_labels(labels, best_c, best_s, V, F, planes, band=2.5, log=print):
    """Vienas fasadas – viena nuotrauka: stiklas kiekvienoje nuotraukoje atspindi vis ką kita, todėl lopai iš kelių
    nuotraukų sudaro „mozaiką“ ir aukštų juostos lūžinėja ties siūlėmis. Kiekvienai sienos plokštumai parenkama
    nuotrauka, kuri tarp kandidatų turi didžiausią bendrą balą, ir ji priskiriama visiems tos sienos trikampiams,
    kuriems ji yra kandidatė (kitiems – lieka kaip buvo)."""
    labels = labels.copy()
    C = V[F].mean(1)
    n_tri = 0
    for n, d, Q in planes:
        u = np.array([-n[1], n[0], 0.0])
        tq = Q @ u
        t = C @ u
        on = (np.abs(C @ n + d) < band) & (t > tq.min() - 1) & (t < tq.max() + 1) & \
             (C[:, 2] > Q[:, 2].min() - 1) & (C[:, 2] < Q[:, 2].max() + 1)
        idx = np.flatnonzero(on)
        if len(idx) < 50:
            continue
        # Godus padengimas: geriausia nuotrauka (didžiausias bendras balas) – visiems jos matomiems sienos
        # trikampiams, likusiems – kita geriausia ir t. t. (siena – iš kelių didelių vientisų lopų)
        left = idx
        for _ in range(4):
            cand, sc = best_c[left], best_s[left]
            ok = cand >= 0
            if not ok.any():
                break
            cam = int(np.argmax(np.bincount(cand[ok], weights=sc[ok])))
            has = (cand == cam).any(1)
            labels[left[has]] = cam
            n_tri += int(has.sum())
            left = left[~has]
            if len(left) < 50:
                break
    if n_tri:
        log("Fasadų tekstūra – po vieną nuotrauką sienai: %d trikampių" % n_tri)
    return labels


def texture(dense_dir, mesh_ply, out_prefix, work=None, page_size=8192, quality=90, max_pages=6, log=print,
            oriented=False, planes=None):
    """Tekstūruoja tinklą. Rezultatas: <out_prefix>.obj/.mtl, _<n>.jpg lapai, .glb; work/texture_uv.npz – ortofoto."""
    import open3d as o3d
    from PIL import Image
    m = o3d.io.read_triangle_mesh(mesh_ply)
    V = np.asarray(m.vertices)
    F = np.asarray(m.triangles).astype(np.int64)
    if not len(F):
        raise RuntimeError("Tuščias tinklas – nėra ką tekstūruoti")
    cams = load_cameras(dense_dir)
    Ns = smoothed_normals(V, F)
    best_c, best_s = visibility(V, F, cams, log=log, normals=Ns, oriented=oriented)
    adj = face_adjacency(F)
    col = sample_colors(V, F, cams, best_c)
    # Sienos (stačios): stiklas kiekvienoje nuotraukoje atspindi vis ką kita – spalvų nuoseklumo patikra jas atmestų
    # atsitiktinai, o skirtingos kaimynų nuotraukos subyra į juostas. Sienoms – be patikros ir stipresnis išlyginimas
    steep = np.abs(Ns[:, 2]) < 0.4
    c0, s0, col0 = best_c.copy(), best_s.copy(), col[steep].copy()
    best_c, best_s = photo_consistency(best_c, best_s, col, log=log)
    best_c[steep], best_s[steep], col[steep] = c0[steep], s0[steep], col0
    labels = smooth_labels(best_c, best_s, adj, iters=30, weight=np.where(steep, 4.0, 1.0).astype(np.float32))
    if planes:
        labels = facade_labels(labels, best_c, best_s, V, F, planes, log=log)
    gains = exposure_gains(cams, best_c, col, log=log)
    if work:
        np.save(os.path.join(work, "texture_labels.npy"), labels.astype(np.int32))   # pvz. siūlių išlyginimui (texrecon -L)
    comp = patches(labels, adj)
    n_patch = comp.max() + 1
    log("Lopų: %d (nuotraukų panaudota: %d)" % (n_patch, len(np.unique(labels[labels >= 0]))))

    # Kiekvieno lopo nuotraukos iškarpa (pikseliais) – pagal visų jo trikampių projekcijas
    corner_xy = np.zeros((len(F), 3, 2))
    for ci in np.unique(labels[labels >= 0]):
        f = np.flatnonzero(labels == ci)
        corner_xy[f] = project(cams[ci], V[F[f]].reshape(-1, 3)).reshape(-1, 3, 2)
    order = np.argsort(comp, kind="stable")
    starts = np.flatnonzero(np.r_[True, comp[order][1:] != comp[order][:-1]])
    ends = np.r_[starts[1:], len(order)]
    info = []
    for s0, s1 in zip(starts, ends):
        f = order[s0:s1]
        cam = labels[f[0]]
        if cam < 0:
            continue
        xy = corner_xy[f].reshape(-1, 2)
        W, H = cams[cam]["width"], cams[cam]["height"]
        x0, y0 = np.clip(np.floor(xy.min(0)) - 2, 0, [W - 1, H - 1]).astype(int)
        x1, y1 = np.clip(np.ceil(xy.max(0)) + 2, 1, [W, H]).astype(int)
        info.append((f, cam, x0, y0, max(1, x1 - x0), max(1, y1 - y0)))
    # Didesni – pirma (geresnis pakavimas)
    info.sort(key=lambda t: -t[5])
    total_px = sum(w * h for *_, w, h in info)
    # Jei viskas netilptų į max_pages lapus – visos iškarpos proporcingai sumažinamos
    scale = float(min(1.0, np.sqrt(max_pages * 0.8 * page_size ** 2 / max(total_px, 1))))
    if scale < 1:
        log("Tekstūros raiška sumažinta iki %.0f %% (didelis plotas)" % (100 * scale))
    packer = Packer(page_size)
    face_page = np.zeros(len(F), np.int32)
    face_uv = np.full((len(F), 3, 2), 4.0 / page_size)  # nematomi – pilkas kampas
    placed = []
    for f, cam, x0, y0, w, h in info:
        sc = min(scale, (page_size - 4) / max(w, h))
        pw, ph = max(1, int(round(w * sc))), max(1, int(round(h * sc)))
        page, px, py = packer.place(pw, ph)
        placed.append((cam, x0, y0, w, h, page, px, py, pw, ph))
        uv = (corner_xy[f] - [x0, y0]) * [pw / w, ph / h] + [px, py]
        face_uv[f] = uv / page_size
        face_page[f] = page
    pages = [np.full((page_size, page_size, 3), 128, np.uint8) for _ in range(packer.pages)]
    by_cam = {}
    for p in placed:
        by_cam.setdefault(p[0], []).append(p)
    for cam, items in by_cam.items():
        img = Image.open(cams[cam]["path"]).convert("RGB")
        if not np.allclose(gains[cam], 1.0):
            img = Image.fromarray(np.clip(np.asarray(img, np.float32) * gains[cam], 0, 255).astype(np.uint8))
        for _, x0, y0, w, h, page, px, py, pw, ph in items:
            crop = img.crop((x0, y0, x0 + w, y0 + h))
            if (pw, ph) != (w, h):
                crop = crop.resize((pw, ph), Image.BILINEAR)
            pages[page][py:py + ph, px:px + pw] = np.asarray(crop)
    base = os.path.basename(out_prefix)
    out_dir = os.path.dirname(out_prefix)
    names = []
    for i, pg in enumerate(pages):
        n = "%s_map_%d.jpg" % (base, i)
        Image.fromarray(pg).save(os.path.join(out_dir, n), quality=quality)
        names.append(n)
    log("Tekstūra: %d lapai po %d px" % (len(pages), page_size))
    write_obj(out_prefix, V, F, face_uv, face_page, names)
    write_glb(out_prefix + ".glb", V, F, face_uv, face_page, [os.path.join(out_dir, n) for n in names])
    if work:
        np.savez(os.path.join(work, "texture_uv.npz"), V=V, F=F, uv=face_uv.astype(np.float32), page=face_page,
                 pages=np.array([os.path.join(out_dir, n) for n in names]))
    return len(pages)


def _unique_corners(F, face_uv, face_page, sel):
    """Viršūnės su UV: (padėties indeksas, UV) unikalios poros (siūlėse viršūnės padvigubinamos)."""
    uvq = np.round(face_uv[sel].reshape(-1, 2) * 2 ** 20).astype(np.int64)
    key = np.stack([F[sel].reshape(-1), uvq[:, 0], uvq[:, 1]], 1)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    return uniq[:, 0], uniq[:, 1:] / 2.0 ** 20, inv.reshape(-1, 3)


def write_obj(prefix, V, F, face_uv, face_page, page_names):
    base = os.path.basename(prefix)
    with open(prefix + ".mtl", "w") as f:
        for i, n in enumerate(page_names):
            f.write("newmtl material%d\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\nillum 1\nmap_Kd %s\n\n" % (i, n))
    vid, uv, tri = _unique_corners(F, face_uv, face_page, np.arange(len(F)))
    with open(prefix + ".obj", "w") as f:
        f.write("mtllib %s.mtl\n" % base)
        np.savetxt(f, V, fmt="v %.4f %.4f %.4f")
        np.savetxt(f, np.c_[uv[:, 0], 1.0 - uv[:, 1]], fmt="vt %.6f %.6f")
        for p in range(len(page_names)):
            sel = np.flatnonzero(face_page == p)
            if not len(sel):
                continue
            f.write("usemtl material%d\n" % p)
            vv = F[sel] + 1
            tt = tri[sel] + 1
            np.savetxt(f, np.stack([vv[:, 0], tt[:, 0], vv[:, 1], tt[:, 1], vv[:, 2], tt[:, 2]], 1), fmt="f %d/%d %d/%d %d/%d")


def write_glb(path, V, F, face_uv, face_page, page_paths):
    """GLB: kiekvienam lapui – atskiras tinklas su JPEG tekstūra (ODM vietinės koordinatės, Z – aukštis)."""
    import trimesh
    from PIL import Image
    scene = trimesh.Scene()
    normals = trimesh.Trimesh(V, F, process=False).vertex_normals  # viršūnių normalės iš viso tinklo – be siūlių
    for p, img_path in enumerate(page_paths):
        sel = np.flatnonzero(face_page == p)
        if not len(sel):
            continue
        vid, uv, tri = _unique_corners(F, face_uv, face_page, sel)
        img = Image.open(img_path)
        img.format = "JPEG"
        mat = trimesh.visual.material.PBRMaterial(baseColorTexture=img, metallicFactor=0.0, roughnessFactor=1.0)
        vis = trimesh.visual.TextureVisuals(uv=np.c_[uv[:, 0], 1.0 - uv[:, 1]], material=mat)
        tm = trimesh.Trimesh(V[vid], tri, visual=vis, vertex_normals=normals[vid], process=False)
        scene.add_geometry(tm, geom_name="page%d" % p)
    scene.export(path, include_normals=True)


def import_obj(obj_path, out_prefix, work=None, quality=90, log=print):
    """Tekstūruotas OBJ (OpenMVS TextureMesh) → tie patys rezultatai kaip texture(): <out_prefix>.obj/.mtl,
    _map_<n>.jpg lapai, .glb ir work/texture_uv.npz (ortofoto)."""
    from PIL import Image
    src_dir = os.path.dirname(obj_path)
    V, VT, F, FT, FP = [], [], [], [], []
    mtl_file, mats, cur = None, [], -1
    with open(obj_path) as f:
        for line in f:
            if line.startswith("v "):
                V.append(line.split()[1:4])
            elif line.startswith("vt "):
                VT.append(line.split()[1:3])
            elif line.startswith("f "):
                c = [p.split("/") for p in line.split()[1:4]]
                F.append([int(p[0]) - 1 for p in c])
                FT.append([int(p[1]) - 1 for p in c])
                FP.append(cur)
            elif line.startswith("usemtl "):
                name = line.split(None, 1)[1].strip()
                if name not in mats:
                    mats.append(name)
                cur = mats.index(name)
            elif line.startswith("mtllib "):
                mtl_file = line.split(None, 1)[1].strip()
    maps = {}
    if mtl_file:
        name = None
        with open(os.path.join(src_dir, mtl_file)) as f:
            for line in f:
                if line.startswith("newmtl "):
                    name = line.split(None, 1)[1].strip()
                elif line.strip().startswith("map_Kd") and name:
                    maps[name] = line.strip().split(None, 1)[1].strip()
    V = np.array(V, np.float64)
    VT = np.array(VT, np.float64)
    F = np.array(F, np.int64)
    FP = np.array(FP, np.int32)
    if not len(F) or (FP < 0).any() or any(m not in maps for m in mats):
        raise RuntimeError("Netinkamas tekstūruotas OBJ")
    uv = VT[np.array(FT)]
    face_uv = np.stack([uv[..., 0], 1.0 - uv[..., 1]], -1)
    base = os.path.basename(out_prefix)
    out_dir = os.path.dirname(out_prefix)
    names = []
    for i, m in enumerate(mats):
        n = "%s_map_%d.jpg" % (base, i)
        Image.open(os.path.join(src_dir, maps[m])).convert("RGB").save(os.path.join(out_dir, n), quality=quality)
        names.append(n)
    log("Tekstūra (OpenMVS): %d trikampių, %d lapai" % (len(F), len(names)))
    write_obj(out_prefix, V, F, face_uv, FP, names)
    write_glb(out_prefix + ".glb", V, F, face_uv, FP, [os.path.join(out_dir, n) for n in names])
    if work:
        np.savez(os.path.join(work, "texture_uv.npz"), V=V, F=F, uv=face_uv.astype(np.float32), page=FP,
                 pages=np.array([os.path.join(out_dir, n) for n in names]))
    return len(names)


def seam_level(dense_dir, mesh_ply, out_prefix, work, binary, log=print, run=None, timeout=3600):
    """Siūlių išlyginimas kaip ODM: mvs-texturing (texrecon) su mūsų parinktomis nuotraukomis (-L): lopų ribose
    spalvos sulyginamos Puasono redagavimu – nebelieka ryškių „laiptų“ tarp nuotraukų. Bendras (globalus) spalvų
    sulyginimas išjungtas: su dideliais fasadų lopais jis nudažo sienas rausvai / žaliai. Rezultatas – kaip texture()."""
    import shutil
    import subprocess
    labels = np.load(os.path.join(work, "texture_labels.npy")).astype(np.int64)
    cams = load_cameras(dense_dir)
    scene = os.path.join(work, "texrecon_scene")
    shutil.rmtree(scene, ignore_errors=True)
    os.makedirs(scene)
    for i, c in enumerate(cams):
        # Vardai – pagal eilę (texrecon rūšiuoja failus ir ieško nuotraukos po .cam): i-oji kamera = i-asis vaizdas
        ext = os.path.splitext(c["name"])[1].lower()
        base = os.path.join(scene, "v%05d" % i)
        os.symlink(os.path.abspath(c["path"]), base + (ext if ext in (".jpg", ".jpeg", ".png", ".tiff") else ".jpg"))
        K, Vm = c["K"], c["viewmat"]
        m = max(c["width"], c["height"])
        with open(base + ".cam", "w") as f:
            f.write(" ".join("%.10f" % v for v in list(Vm[:3, 3]) + list(Vm[:3, :3].ravel())) + "\n")
            f.write("%.10f 0 0 %.10f %.10f %.10f\n" % (K[0, 0] / m, K[1, 1] / K[0, 0], K[0, 2] / c["width"],
                                                         K[1, 2] / c["height"]))
    lab = os.path.join(work, "texture_labels.bin")
    (labels + 1).clip(0).astype(np.uint64).tofile(lab)          # 0 – nematomas, i + 1 – i-oji kamera
    out = os.path.join(work, "texrecon")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    cmd = [binary, scene, mesh_ply, os.path.join(out, "m"), "-L", lab, "-t", "none", "--skip_global_seam_leveling",
           "--keep_unseen_faces", "--no_intermediate_results"]
    if run:
        run(cmd)
    else:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, timeout=timeout)
    n = import_obj(os.path.join(out, "m.obj"), out_prefix, work=work, log=log)
    shutil.rmtree(out, ignore_errors=True)
    shutil.rmtree(scene, ignore_errors=True)
    return n
