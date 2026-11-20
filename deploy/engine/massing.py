# Atea variklis – pastatų „blokai“ statmenoms (nadir) drono nuotraukoms. Iš statmenų nuotraukų stogo kraštas matomas
# tiksliai, o stiklo fasadai – tik smailiu kampu ir su atspindžiais: 3D tinklas juose banguotas, su skylėmis ir šukėmis.
# Todėl pastatas atkuriamas kaip blokas:
#   • pado kontūras – iš stogo (aukščių žemėlapis), tiesios stačiakampės linijos pasuktame tinklelyje;
#   • stogas – aukščių žemėlapis (mediana), parapetas išlygintas, stiklinio stogo „skylės“ užpildytos;
#   • sienos – vertikalios plokštumos; jų vieta kiekviename aukštyje – pagal tankų debesį (įtrauktas / išsikišęs
#     fasadas), kitaip tekstūra tarp nuotraukų „slysta“;
#   • aplink – plokščia žemės juosta (šukių vietoje).
# Pastatai, kurių kontūras nestačiakampis (IoU < 0,85), lieka kaip 3D tinkle.
import warnings

import numpy as np
from scipy import ndimage

def _grid_top(P, lo, cell, shape):
    ij = np.floor((P[:, :2] - lo) / cell).astype(np.int64)
    ok = (ij >= 0).all(1) & (ij[:, 0] < shape[0]) & (ij[:, 1] < shape[1])
    ij, z = ij[ok], P[ok, 2]
    key = ij[:, 0] * shape[1] + ij[:, 1]
    o = np.lexsort((-z, key))
    k, zs = key[o], z[o]
    first = np.flatnonzero(np.r_[True, k[1:] != k[:-1]])
    nxt = np.minimum(first + 1, len(k) - 1)
    sec = np.where(k[nxt] == k[first], zs[nxt], zs[first])
    top = np.full(shape[0] * shape[1], np.nan)
    top[k[first]] = sec
    low = np.full(shape[0] * shape[1], np.inf)
    np.minimum.at(low, key, z)
    return top.reshape(shape), low.reshape(shape)


def _min_rect_angle(xy):
    from scipy.spatial import ConvexHull
    h = xy[ConvexHull(xy).vertices]
    best = (np.inf, 0.0)
    for a, b in zip(h, np.roll(h, -1, 0)):
        th = np.arctan2(b[1] - a[1], b[0] - a[0])
        c, s = np.cos(th), np.sin(th)
        u, v = h @ [c, s], h @ [-s, c]
        area = np.ptp(u) * np.ptp(v)
        if area < best[0]:
            best = (area, th)
    return best[1]


def find_buildings(P, cell=0.5, min_h=5.0, min_area=150.0, ground_win=60.0, log=print):
    """Aukšti (> min_h m virš žemės) ir dideli (> min_area m²) plotai – pastatų kandidatai: [(xy langelių centrai,
    pagrindinė kryptis)] ir žemės modelis."""
    lo = P[:, :2].min(0)
    shape = tuple(np.floor((P[:, :2].max(0) - lo) / cell).astype(int) + 1)
    top, low = _grid_top(P, lo, cell, shape)
    # žemė: žemiausių taškų „atidarymas“ ground_win m langu (pastatai, medžiai išnyksta), tada išlyginimas
    g = np.where(np.isfinite(low), low, np.nanmax(top))
    w = int(ground_win / cell) | 1
    dtm = ndimage.uniform_filter(ndimage.grey_opening(g, size=(w, w)), int(10 / cell))
    nd = np.where(np.isfinite(top), top - dtm, 0)
    high = ndimage.binary_fill_holes(ndimage.binary_closing(nd > min_h, iterations=2))
    high = ndimage.binary_opening(high, iterations=int(2 / cell))
    lab, n = ndimage.label(high)
    out = []
    for k in range(1, n + 1):
        msk = lab == k
        if msk.sum() * cell * cell < min_area:
            continue
        ii, jj = np.nonzero(msk)
        xy = np.c_[lo[0] + (ii + 0.5) * cell, lo[1] + (jj + 0.5) * cell]
        out.append((xy, _min_rect_angle(xy)))
    return out, (lo, cell, dtm)


def _cuts(prof, cell, reg, n):
    from scipy.ndimage import gaussian_filter1d
    g = np.abs(np.diff(gaussian_filter1d(prof.astype(float), 0.75 / cell)))
    thr = max(0.5 * reg / cell, 0.05 * prof.max())
    cand = [i for i in range(1, len(g) - 1) if g[i] >= g[i - 1] and g[i] >= g[i + 1] and g[i] > thr]
    cand.sort(key=lambda i: -g[i])
    sel = []
    for i in cand:
        if all(abs(i - j) * cell >= reg for j in sel):
            sel.append(i)
    return sorted({0, n} | {i + 1 for i in sel})


def rectilinear(hm, cell, reg=2.0):
    """Stačiakampis kontūras: pjūvio linijos ten, kur stogo užimtumas eilutėse / stulpeliuose staigiai keičiasi
    (stogo kraštai), langeliai tarp linijų – pastatas, jei daugiau nei pusė užimta. Kraštai – tiesios linijos,
    triukšmo „dantys“ ir laipteliai < reg m dingsta."""
    cu = _cuts(hm.sum(1), cell, reg, hm.shape[0])
    cv = _cuts(hm.sum(0), cell, reg, hm.shape[1])
    M = np.zeros_like(hm)
    for a, b in zip(cu[:-1], cu[1:]):
        for c, d in zip(cv[:-1], cv[1:]):
            if hm[a:b, c:d].mean() > 0.5:
                M[a:b, c:d] = True
    return M


def build_block(P, xy, th, dtm_info, cell=0.25, reg=2.0, wall_step=1.0, apron=3.0, prof_step=0.5, log=print):
    """Vienas pastatas: stačiakampis (taisyklingas) pado kontūras pasuktame tinklelyje, stogas iš DSM, sienos vertikalios."""
    c, s = np.cos(th), np.sin(th)
    R = np.array([[c, s], [-s, c]])                       # pasaulis → (u, v)
    UV = xy @ R.T
    lo = UV.min(0) - 6.0
    hi = UV.max(0) + 6.0
    shape = tuple(np.ceil((hi - lo) / cell).astype(int))
    # taškai šalia pastato
    box = (P[:, 0] > xy[:, 0].min() - 15) & (P[:, 0] < xy[:, 0].max() + 15) & (P[:, 1] > xy[:, 1].min() - 15) & (P[:, 1] < xy[:, 1].max() + 15)
    Pc = P[box]
    Pr = np.c_[Pc[:, :2] @ R.T, Pc[:, 2]]
    top, low = _grid_top(Pr, lo, cell, shape)
    # pado kaukė: komponento langeliai (0,5 m) → pasuktas tinklelis
    ij = np.floor((UV - lo) / cell).astype(int)
    m0 = np.zeros(shape, bool)
    r = int(np.ceil(0.5 / cell))
    for di in range(-r, r + 1):
        for dj in range(-r, r + 1):
            m0[np.clip(ij[:, 0] + di, 0, shape[0] - 1), np.clip(ij[:, 1] + dj, 0, shape[1] - 1)] = True
    # pado kontūras tiksliau: aukšti langeliai (DSM) šalia komponento
    dlo, dcell, dtm = dtm_info
    gu, gv = np.meshgrid(lo[0] + (np.arange(shape[0]) + 0.5) * cell, lo[1] + (np.arange(shape[1]) + 0.5) * cell, indexing="ij")
    W = np.stack([gu, gv], -1) @ R                        # (u,v) → pasaulis
    di = np.clip(((W[..., 0] - dlo[0]) / dcell).astype(int), 0, dtm.shape[0] - 1)
    dj = np.clip(((W[..., 1] - dlo[1]) / dcell).astype(int), 0, dtm.shape[1] - 1)
    G = dtm[di, dj]
    topf = top.copy()
    hole = ~np.isfinite(topf)
    _, (ii, jj) = ndimage.distance_transform_edt(hole, return_indices=True)
    topf = topf[ii, jj]
    nd = topf - G
    near = ndimage.binary_dilation(m0, iterations=int(2 / cell))
    thr = max(4.0, 0.5 * np.percentile(nd[m0], 75))
    hm = near & (nd > thr)
    hm = ndimage.binary_opening(hm, iterations=2)
    hm = ndimage.binary_closing(hm, iterations=2)
    hm = ndimage.binary_fill_holes(hm)
    M = rectilinear(hm, cell, reg)
    lab, n = ndimage.label(M)
    if n == 0:
        return None
    M = lab == np.bincount(lab.ravel())[1:].argmax() + 1
    iou = (M & hm).sum() / max((M | hm).sum(), 1)
    log("Pastatas: %.0f m², kontūro atitikimas %.2f%s" % (M.sum() * cell * cell, iou, "" if iou >= 0.85 else " – paliekamas 3D tinklas"))
    if iou < 0.85:
        return None
    # stogas: mediana 5×5 per pastato langelius
    # Stiklinis stogas / atriumas: taškų nėra, DSM „mato“ pro stiklą žemyn (vidaus grindys). Žemi langeliai pado viduje
    # (< pusės pastato aukščio) laikomi neišmatuotais ir užpildomi gretimu stogu, jei jie – ne didelis kiemas
    low = M & (topf - G < thr)
    lab_l, nl = ndimage.label(low)
    for q in range(1, nl + 1):
        r_ = lab_l == q
        if r_.sum() > 0.25 * M.sum():
            low[r_] = False      # didelis – tikras vidinis kiemas
    good = M & ~low
    _, (ii, jj) = ndimage.distance_transform_edt(~good, return_indices=True)
    topf = np.where(low, topf[ii, jj], topf)
    Z = ndimage.median_filter(topf, size=5)
    # kraštas: tik vidaus langeliai, didesnis langas – lygus parapetas
    inner = ndimage.binary_erosion(M, iterations=2)
    Zi = np.where(inner, Z, np.nan)
    _, (ii, jj) = ndimage.distance_transform_edt(~inner, return_indices=True)
    Ze = ndimage.median_filter(Zi[ii, jj], size=9)
    edge = M & ~inner
    Z = np.where(edge, Ze, Z)
    nu, nv = shape
    cm = np.zeros((nu + 1, nv + 1), bool)
    for a in (0, 1):
        for b in (0, 1):
            cm[a:nu + a, b:nv + b] |= M
    Zp = np.pad(np.where(M, Z, np.nan), 1, constant_values=np.nan)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        Zc = np.nanmedian(np.stack([Zp[a:a + nu + 1, b:b + nv + 1] for a in (0, 1) for b in (0, 1)]), 0)
    Gp = np.pad(G, 1, mode="edge")
    Gc = np.mean(np.stack([Gp[a:a + nu + 1, b:b + nv + 1] for a in (0, 1) for b in (0, 1)]), 0)
    # sienų kraštinės: linija u = i (išilgai v) arba v = j (išilgai u)
    Mp = np.pad(M, 1)
    groups = {}
    du = Mp[1:, 1:-1] != Mp[:-1, 1:-1]
    for i_, j_ in zip(*np.nonzero(du)):
        groups.setdefault((0, i_, 1 if Mp[i_, j_ + 1] else -1), []).append(j_)
    dv = Mp[1:-1, 1:] != Mp[1:-1, :-1]
    for i_, j_ in zip(*np.nonzero(dv)):
        groups.setdefault((1, j_, 1 if Mp[i_ + 1, j_] else -1), []).append(i_)
    from scipy.ndimage import median_filter as mf1, gaussian_filter1d
    runs = []
    top = {}
    for (ax, L, sg), ss in groups.items():
        ss = np.unique(ss)
        for r in np.split(ss, np.flatnonzero(np.diff(ss) > 1) + 1):
            s = np.arange(r[0], r[-1] + 2)
            cs = [(L, x) if ax == 0 else (x, L) for x in s]
            zt = np.array([Zc[c] for c in cs])
            zt = np.where(np.isfinite(zt), zt, np.nanmedian(zt))
            # parapetas – lygus: slankioji mediana ~6 m ir švelnus išlyginimas
            zt = gaussian_filter1d(mf1(zt, size=max(3, int(6 / cell) | 1), mode="nearest"), 1.0 / cell, mode="nearest")
            for c, z in zip(cs, zt):
                top[c] = max(top.get(c, -np.inf), z)
            runs.append((ax, L, sg, s, zt, np.array([Gc[c] for c in cs])))
    for c, z in top.items():
        Zc[c] = z
    vid = np.full((nu + 1, nv + 1), -1)
    ci, cj = np.nonzero(cm)
    vid[ci, cj] = np.arange(len(ci))
    Vs = [np.c_[lo[0] + ci * cell, lo[1] + cj * cell, Zc[ci, cj]]]
    i, j = np.nonzero(M)
    a, b, cc, d = vid[i, j], vid[i + 1, j], vid[i + 1, j + 1], vid[i, j + 1]
    Fs = [np.r_[np.c_[a, b, cc], np.c_[a, cc, d]]]
    nV = len(Vs[0])
    # Fasado vieta kiekvienai sienai: stiklo fasadas dažnai įtrauktas po stogo kraštu arba išsikišęs – poslinkis pagal
    # tankų debesį (dažniausias atstumas nuo stogo krašto linijos aukštų viduryje), kitaip tekstūra „slysta“ tarp nuotraukų
    offs, profs = [], []
    for ax, L, sg, s, zt, zg in runs:
        line = lo[ax] + L * cell
        a0, a1 = lo[1 - ax] + s[0] * cell, lo[1 - ax] + s[-1] * cell
        sd = sg * (Pr[:, ax] - line)
        al = Pr[:, 1 - ax]
        zb, ztop = np.median(zg), np.median(zt)
        k = (sd > -3) & (sd < 6) & (al > a0 + 2) & (al < a1 - 2) & (Pr[:, 2] > zb + 1) & (Pr[:, 2] < ztop)
        zl = np.arange(zb, ztop + prof_step, prof_step)
        prof = np.full(len(zl), np.nan)
        wide = np.zeros(len(zl), bool)
        if a1 - a0 > 6 and k.sum() > 200:
            iz = np.clip(np.round((Pr[k, 2] - zb) / prof_step).astype(int), 0, len(zl) - 1)
            sk, ib = sd[k], np.floor((al[k] - a0) / 4.0).astype(int)
            for q in np.unique(iz):
                sel = np.abs(iz - q) <= 1
                v = sk[sel]
                if len(v) < 40:
                    continue
                h, e = np.histogram(v, bins=36, range=(-3, 6))
                h = np.convolve(h, [1, 2, 1], "same")
                if h.max() > 0.2 * len(v):
                    prof[q] = e[h.argmax()] + 0.125
                # Tas pats gylis per visą sienos ilgį (4 m ruožuose) – tikras fasadas (pvz. įtrauktas viršutinis
                # aukštas), ne atspindys, net jei nuo kitų aukštų skiriasi daug
                modes = []
                for bb in np.unique(ib[sel]):
                    w = v[ib[sel] == bb]
                    if len(w) >= 15:
                        hb, eb = np.histogram(w, bins=36, range=(-3, 6))
                        modes.append(eb[hb.argmax()] + 0.125)
                if len(modes) >= max(4, 0.4 * (a1 - a0) / 4.0) and np.ptp(modes) < 0.8:
                    prof[q] = float(np.median(modes))
                    wide[q] = True
        # visos sienos dažniausias poslinkis; aukštai, kurių reikšmė nuo jo toli (> 1,2 m) – atspindžiai, ne fasadas
        lv = np.isfinite(prof) & (zl > zb + 4)
        og = float(np.median(prof[lv])) if lv.sum() >= 3 else 0.0
        okp = np.isfinite(prof) & ((np.abs(prof - og) < 1.2) | wide)
        # žemiausi ~4 m – automobiliai, įėjimai: be patikimo fasado; imama aukščiau esančių reikšmė
        okp &= (zl > zb + 4) & (zl < ztop - 2.5)
        if okp.sum() >= 5:
            prof = np.interp(zl, zl[okp], np.clip(prof[okp], -3.0, 2.5))
            prof = ndimage.median_filter(prof, size=5, mode="nearest")
            prof = ndimage.gaussian_filter1d(prof, 1.0, mode="nearest")
        else:
            prof = np.full(len(zl), og)
        profs.append((zl, prof))
        offs.append(float(np.median(prof)))
    # sienų galai: pratęsiami / patrumpinami iki kaimyninės (statmenos) sienos poslinkio
    ends = {}
    for r_, (ax, L, sg, s, zt, zg) in enumerate(runs):
        for ci_, side in ((0, -1), (-1, 1)):
            c = (L, s[ci_]) if ax == 0 else (s[ci_], L)
            ends.setdefault(c, []).append((r_, side))
    ext = [[None, None] for _ in runs]
    for c, lst in ends.items():
        if len(lst) != 2:
            continue
        for (ra, sa), (rb, sb) in (lst, lst[::-1]):
            sgb = runs[rb][2]
            # kaimyno išorės normalė išilgai šios sienos krypties (į galą): +1 – iškilus kampas
            ext[ra][0 if sa < 0 else 1] = (rb, 1.0 if sgb == sa else -1.0)
    walls = []
    for (ax, L, sg, s, zt, zg), prof, (e0, e1) in zip(runs, profs, ext):
        length = (len(s) - 1) * cell
        k = max(1, int(np.ceil(length / wall_step)))
        x = np.linspace(s[0], s[-1], k + 1)
        ztx = np.interp(x, s, zt)
        zgx = np.interp(x, s, zg) - 0.5
        nz = max(1, int(np.ceil((ztx - zgx).max() / wall_step)))
        tz = np.linspace(0, 1, nz + 1)
        Zw = zgx[:, None] + (ztx - zgx)[:, None] * tz[None, :]          # (k+1, nz+1)
        # sienos galai – iki kaimyninės sienos fasado tame pačiame aukštyje (kampas be tarpo ir be „pelekų“)
        Xw = np.broadcast_to(x[:, None], Zw.shape).copy()
        for col, e, sgn in ((0, e0, -1.0), (-1, e1, 1.0)):
            if e is not None:
                zl_n, pr_n = profs[e[0]]
                Xw[col] += sgn * e[1] * np.interp(Zw[col], zl_n, pr_n) / cell
        zl_, pr_ = prof
        Ls = L + sg * np.interp(Zw, zl_, pr_) / cell          # (k+1, nz+1)
        o = float(np.interp(ztx.mean(), zl_, pr_))          # viršaus poslinkis – juostai iki stogo
        Lt = L + sg * o / cell

        def to3(lpos, xs, Z):
            xs = np.broadcast_to(xs if np.ndim(xs) == 2 else np.asarray(xs)[:, None], Z.shape)
            a_ = np.broadcast_to(lo[ax] + lpos * cell, Z.shape).ravel()
            b_ = (lo[1 - ax] + xs * cell).ravel()
            return np.c_[a_, b_, Z.ravel()] if ax == 0 else np.c_[b_, a_, Z.ravel()]
        out = np.array([sg, 0.0]) if ax == 0 else np.array([0.0, sg])
        P3 = to3(Ls, Xw, Zw)
        grids = [(P3, Zw.shape)]
        if abs(o) > 0.05:
            # juosta tarp stogo krašto ir sienos viršaus
            Pb = np.concatenate([to3(L, x, ztx[:, None]), to3(Lt, Xw[:, -1], ztx[:, None])]).reshape(2, -1, 3).transpose(1, 0, 2).reshape(-1, 3)
            grids.append((Pb, (len(x), 2)))
        for G3, shp in grids:
            idx = nV + np.arange(len(G3)).reshape(shp)
            a, b, c2, d = idx[:-1, :-1], idx[1:, :-1], idx[1:, 1:], idx[:-1, 1:]
            Fw = np.r_[np.c_[a.ravel(), b.ravel(), c2.ravel()], np.c_[a.ravel(), c2.ravel(), d.ravel()]]
            Vs.append(G3)
            Fs.append(Fw)
            nV += len(G3)
        walls.append((out, P3, length, o))
    # žemės „prijuostė“ aplink pastatą (pašalintų šukių vietoje) – plokščia, žemės aukštyje
    ring = ndimage.binary_dilation(M, iterations=int(round((apron + max([0.0] + [float(p.max()) for _, p in profs])) / cell))) & ~M
    rc = np.zeros((nu + 1, nv + 1), bool)
    for a in (0, 1):
        for b in (0, 1):
            rc[a:nu + a, b:nv + b] |= ring
    ri, rj = np.nonzero(rc)
    rid = np.full((nu + 1, nv + 1), -1)
    rid[ri, rj] = nV + np.arange(len(ri))
    Vs.append(np.c_[lo[0] + ri * cell, lo[1] + rj * cell, Gc[ri, rj] - 0.1])
    i, j = np.nonzero(ring)
    a, b, cc, d = rid[i, j], rid[i + 1, j], rid[i + 1, j + 1], rid[i, j + 1]
    Fs.append(np.r_[np.c_[a, b, cc], np.c_[a, cc, d]])
    V = np.concatenate(Vs)
    F = np.concatenate(Fs)
    nr = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    horiz = np.abs(nr[:, 2]) > 0.5 * np.linalg.norm(nr, axis=1)
    fl = horiz & (nr[:, 2] < 0)
    F[fl] = F[fl][:, [0, 2, 1]]
    # sienos: normalė nuo pastato vidaus (artimiausias pado langelis – viduje)
    cen = V[F].mean(1)
    st = ~horiz
    if st.any():
        nr = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
        dist_in, (ii, jj) = ndimage.distance_transform_edt(~M, return_indices=True)
        q = np.clip(np.floor((cen[st, :2] - lo) / cell).astype(int), 0, np.array(M.shape) - 1)
        inner_xy = np.c_[lo[0] + (ii[q[:, 0], q[:, 1]] + 0.5) * cell, lo[1] + (jj[q[:, 0], q[:, 1]] + 0.5) * cell]
        din = cen[st, :2] - inner_xy
        # langelio viduje (įtraukta siena) – kryptis nuo artimiausio išorės langelio
        dist_out, (oi, oj) = ndimage.distance_transform_edt(M, return_indices=True)
        inside = M[q[:, 0], q[:, 1]]
        outer_xy = np.c_[lo[0] + (oi[q[:, 0], q[:, 1]] + 0.5) * cell, lo[1] + (oj[q[:, 0], q[:, 1]] + 0.5) * cell]
        dirv = np.where(inside[:, None], outer_xy - cen[st, :2], din)
        bad = (nr[st, :2] * dirv).sum(1) < 0
        fi = np.flatnonzero(st)[bad]
        F[fi] = F[fi][:, [0, 2, 1]]
    Vw = np.c_[V[:, :2] @ R, V[:, 2]]
    planes = []
    for out, P3, length, o in walls:
        if length < 3.0:
            continue
        n = np.r_[out @ R, 0.0]
        Q = np.c_[P3[:, :2] @ R, P3[:, 2]]
        planes.append((n, -float(np.median(Q @ n)), Q))
    log("Pastato sienos: %d, fasadai nuo stogo krašto %s m, stogo vietų be taškų (stiklas) %.0f m²" % (len(runs), ", ".join("%+.1f" % o for o in offs), low.sum() * cell * cell))
    foot = dict(R=R, lo=lo, cell=cell, M=M, G=G, grow=max([0.0] + [float(p.max()) for _, p in profs]))
    return Vw, F, planes, foot


def inside_foot(X, foot, dilate=0.0):
    R, lo, cell, M = foot["R"], foot["lo"], foot["cell"], foot["M"]
    Md = ndimage.binary_dilation(M, iterations=int(round(dilate / cell))) if dilate > 0 else M
    uv = X[:, :2] @ R.T
    ij = np.floor((uv - lo) / cell).astype(int)
    ok = (ij >= 0).all(1) & (ij[:, 0] < M.shape[0]) & (ij[:, 1] < M.shape[1])
    r = np.zeros(len(X), bool)
    r[ok] = Md[ij[ok, 0], ij[ok, 1]]
    g = np.full(len(X), np.nan)
    g[ok] = foot["G"][ij[ok, 0], ij[ok, 1]]
    return r, g


def apply(V, F, P, max_faces, log=print):
    """Tinklo (V, F) pastatai pakeičiami blokais. Grąžina (V, F, plokštumos) arba None, jei pastatų nerasta."""
    cands, info = find_buildings(P, log=log)
    blocks = []
    for xy, th in cands:
        b = build_block(P, xy, th, info, log=log)
        if b is not None:
            blocks.append(b)
    if not blocks:
        return None
    C = V[F].mean(1)
    drop = np.zeros(len(F), bool)
    for _, _, _, foot in blocks:
        a, _ = inside_foot(C, foot, dilate=1.0 + foot["grow"])
        b, g = inside_foot(C, foot, dilate=3.0 + foot["grow"])
        # pastato vietoje – viskas; 3 m aplink – tik aukštai kabančios šukės (automobiliai, žmonės lieka)
        drop |= a | (b & (C[:, 2] > g + 2.0))
    import open3d as o3d
    m = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(V), o3d.utility.Vector3iVector(F[~drop]))
    m.remove_unreferenced_vertices()
    nb = sum(len(b[1]) for b in blocks)
    if len(m.triangles) > max_faces - nb:
        m = m.simplify_quadric_decimation(max(1000, max_faces - nb))
        m.remove_unreferenced_vertices()
    Vs, Fs, planes = [np.asarray(m.vertices)], [np.asarray(m.triangles)], []
    off = len(Vs[0])
    for Vb, Fb, pl, _ in blocks:
        Vs.append(Vb)
        Fs.append(Fb + off)
        off += len(Vb)
        planes += pl
    log("Pastatų blokai: %d (%d trikampių), pašalinta 3D tinklo pastatų vietoje: %d trikampių" % (len(blocks), nb, int(drop.sum())))
    return np.concatenate(Vs), np.concatenate(Fs), planes
