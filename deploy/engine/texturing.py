# Atea variklis – tekstūra iš nuotraukų (mvs-texturing / ODM logika, savas kodas):
#   1. matomumas: kiekvienai ištiesintai kamerai – spindulių sekimas tinkle (Open3D), kiek pikselių mato kiekvieną
#      trikampį (projekcijos plotas su užstojimais; kadro centras – svaresnis, kraštai – mažiau);
#   2. kiekvienam trikampiui – 3 geriausios nuotraukos; parinkimas išlyginamas tarp kaimynų (mažiau siūlių);
#   3. tos pačios nuotraukos gretimi trikampiai – „lopai“; nuotraukos iškarpos sudedamos į tekstūrų lapus (atlasą);
#   4. rezultatas: OBJ + MTL + JPEG lapai, GLB (naršyklei) ir trikampių UV (ortofoto kūrimui).
import os

import numpy as np

TOP = 3


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


def visibility(V, F, cams, size=768, log=print):
    """Kiekvienam trikampiui – TOP geriausių kamerų (indeksai, balai); −1 – nematoma."""
    import open3d as o3d
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(V.astype(np.float32)), o3d.core.Tensor(F.astype(np.uint32)))
    nF = len(F)
    best_s = np.zeros((nF, TOP), np.float32)
    best_c = np.full((nF, TOP), -1, np.int32)
    for ci, cam in enumerate(cams):
        s = min(1.0, size / max(cam["width"], cam["height"]))
        W, H = max(8, int(cam["width"] * s)), max(8, int(cam["height"] * s))
        K = cam["K"].copy()
        K[:2] *= s
        rays = o3d.t.geometry.RaycastingScene.create_rays_pinhole(o3d.core.Tensor(K), o3d.core.Tensor(cam["viewmat"]), W, H)
        hit = scene.cast_rays(rays)
        pid = hit["primitive_ids"].numpy().astype(np.int64)
        ok = pid < nF
        # Kadro kraštai – silpnesni (vinjetė, likę iškraipymai), statūs kampai – jau mažesnis plotas
        u, v = np.meshgrid((np.arange(W) + 0.5) / W - 0.5, (np.arange(H) + 0.5) / H - 0.5)
        w = (1.0 - 0.8 * (u * u + v * v))
        sc = np.bincount(pid[ok], weights=w[ok], minlength=nF).astype(np.float32) / (s * s)
        idx = np.flatnonzero(sc > 0)
        if not len(idx):
            continue
        cand_s = np.concatenate([best_s[idx], sc[idx, None]], 1)
        cand_c = np.concatenate([best_c[idx], np.full((len(idx), 1), ci, np.int32)], 1)
        o = np.argsort(-cand_s, 1)[:, :TOP]
        best_s[idx] = np.take_along_axis(cand_s, o, 1)
        best_c[idx] = np.take_along_axis(cand_c, o, 1)
    log("Matomumas: %d kamerų, nematomų trikampių %d iš %d" % (len(cams), int((best_c[:, 0] < 0).sum()), nF))
    return best_c, best_s


def smooth_labels(best_c, best_s, adj, iters=6, weight=0.6):
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


def texture(dense_dir, mesh_ply, out_prefix, work=None, page_size=8192, quality=90, log=print):
    """Tekstūruoja tinklą. Rezultatas: <out_prefix>.obj/.mtl, _<n>.jpg lapai, .glb; work/texture_uv.npz – ortofoto."""
    import open3d as o3d
    from PIL import Image
    m = o3d.io.read_triangle_mesh(mesh_ply)
    V = np.asarray(m.vertices)
    F = np.asarray(m.triangles).astype(np.int64)
    if not len(F):
        raise RuntimeError("Tuščias tinklas – nėra ką tekstūruoti")
    cams = load_cameras(dense_dir)
    best_c, best_s = visibility(V, F, cams, log=log)
    adj = face_adjacency(F)
    labels = smooth_labels(best_c, best_s, adj)
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
    # Jei viskas netilptų į ~6 lapus – visos iškarpos proporcingai sumažinamos
    scale = float(min(1.0, np.sqrt(6 * 0.8 * page_size ** 2 / max(total_px, 1))))
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
    for p, img_path in enumerate(page_paths):
        sel = np.flatnonzero(face_page == p)
        if not len(sel):
            continue
        vid, uv, tri = _unique_corners(F, face_uv, face_page, sel)
        img = Image.open(img_path)
        img.format = "JPEG"
        mat = trimesh.visual.material.PBRMaterial(baseColorTexture=img, metallicFactor=0.0, roughnessFactor=1.0)
        vis = trimesh.visual.TextureVisuals(uv=np.c_[uv[:, 0], 1.0 - uv[:, 1]], material=mat)
        scene.add_geometry(trimesh.Trimesh(V[vid], tri, visual=vis, process=False), geom_name="page%d" % p)
    scene.export(path)
