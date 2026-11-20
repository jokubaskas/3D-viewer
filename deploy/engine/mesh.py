# Atea variklis – 3D tinklas iš tankaus taškų debesies: Screened Poisson (PoissonRecon per COLMAP, MIT) ir valymas:
#   • Poisson paviršius už taškų ploto ribų ir žemiau žemiausių taškų (nulinkę kraštai) – nukerpamas;
#   • Poisson gylis pagal norimą raišką ir srities dydį (ODM mesh-octree-depth logika);
#   • tankio apkirpimas (COLMAP trim) – pašalinami „ekstrapoliuoti“ paviršiai be taškų;
#   • tik labai toli (> 25 m) nuo bet kurio taško nutolę dariniai (mažai taškų turinčios vietos – stogai, asfaltas – lieka);
#   • smulkūs atskiri gabalai; supaprastinimas iki trikampių ribos (ODM mesh-size).
import math
import os

import numpy as np


def poisson_depth(extent, res):
    # Artimiausias gylis norimai raiškai (ne „lubos“: 205 m / 5 cm = 2^12,0 → 12, o ne 13 – 4 × mažiau trikampių, 2 × greičiau)
    return int(np.clip(round(math.log2(max(extent, 1.0) / max(res, 1e-3))), 8, 13))


def effective_res(points, res, max_faces, cell=1.0, oversample=8):
    """Poisson raiška pagal trikampių biudžetą: tinklas vis tiek supaprastinamas iki max_faces, todėl daugiau nei
    ~8 × biudžeto trikampių (plotas / raiška²) tik ilgina Poisson, išlyginimą ir supaprastinimą (205 m sritis: 29 mln.
    → 1 mln. trikampių truko 20 min.), o detalių po supaprastinimo neprideda."""
    ij = np.unique(np.floor(points[:, :2] / cell).astype(np.int64), axis=0)
    area = len(ij) * cell * cell * 1.3          # + sienos ir šlaitai
    return max(res, math.sqrt(2.0 * area / (oversample * max_faces)))


def poisson(points_ply, out_ply, depth, trim=5.0):
    import pycolmap
    o = pycolmap.PoissonMeshingOptions()
    o.depth = depth
    o.trim = trim
    o.color = True
    o.point_weight = 4.0  # ODM: pointWeight 4 – tvirčiau prie taškų, mažiau „išpūtimo“
    pycolmap.poisson_meshing(points_ply, out_ply, o)


def footprint_mask(points, centers, cell=1.0, below=1.5):
    """Trikampiai už taškų ploto ribų (Poisson „sijonas“ – nulinkę kraštai) ir žemiau žemiausio taško
    toje vietoje. Tuščios vietos ploto viduje (vienspalviai stogai, vanduo) – paliekamos."""
    from scipy import ndimage
    lo = points[:, :2].min(0) - 3 * cell
    ij = np.floor((points[:, :2] - lo) / cell).astype(int)
    shape = tuple(ij.max(0) + 4)
    zmin = np.full(shape, np.inf)
    np.minimum.at(zmin, (ij[:, 0], ij[:, 1]), points[:, 2])
    occ = np.isfinite(zmin)
    area = ndimage.binary_fill_holes(ndimage.binary_closing(occ, iterations=3, border_value=0))
    area = ndimage.binary_dilation(area, iterations=1)
    zlow = ndimage.minimum_filter(zmin, size=3, mode="constant", cval=np.inf)
    c = np.floor((centers[:, :2] - lo) / cell).astype(int)
    inside = (c >= 0).all(1) & (c[:, 0] < shape[0]) & (c[:, 1] < shape[1])
    bad = ~inside
    ci = c[inside]
    zl = zlow[ci[:, 0], ci[:, 1]]
    bad[inside] = ~area[ci[:, 0], ci[:, 1]] | (np.isfinite(zl) & (centers[inside, 2] < zl - below))
    return bad


def clamp_above(points, V, cell=1.0, above=0.5):
    """Poisson „balionas“ virš stogo, kuriame mažai taškų (lygus / stiklinis stogas): paviršius išsipučia keliais–
    keliolika metrų virš sienų viršaus, o dėžė nukerpa jo viršų – virš pastato „kabo“ gabalai. Viršūnės, aukštesnės nei
    aukščiausias aplinkinis taškas (~9 m, kur taškų nėra – ~31 m), nuleidžiamos iki jo: lygus stogas sienų viršaus
    aukštyje. Grąžina naujus aukščius ir pakeistų viršūnių skaičių."""
    from scipy import ndimage
    lo = points[:, :2].min(0) - 3 * cell
    ij = np.floor((points[:, :2] - lo) / cell).astype(int)
    shape = tuple(ij.max(0) + 4)
    zmax = np.full(shape, -np.inf)
    np.maximum.at(zmax, (ij[:, 0], ij[:, 1]), points[:, 2])
    zhigh = ndimage.maximum_filter(zmax, size=9, mode="constant", cval=-np.inf)
    zhigh = np.where(np.isfinite(zhigh), zhigh, ndimage.maximum_filter(zmax, size=31, mode="constant", cval=-np.inf))
    c = np.clip(np.floor((V[:, :2] - lo) / cell).astype(int), 0, np.array(shape) - 1)
    zh = zhigh[c[:, 0], c[:, 1]]
    hi = np.isfinite(zh) & (V[:, 2] > zh + above)
    z = V[:, 2].copy()
    z[hi] = zh[hi]
    return z, int(hi.sum())


def clean(mesh, points, spacing, log=print):
    """Pašalina trikampius be taškų atramos ir smulkius gabalus."""
    import open3d as o3d
    from scipy.spatial import cKDTree
    n0 = len(mesh.triangles)
    V = np.asarray(mesh.vertices)
    F = np.asarray(mesh.triangles)
    tree = cKDTree(points)
    d, _ = tree.query(V[F].mean(1), k=1, workers=-1)
    # Tik labai toli nuo bet kurio taško nutolę Poisson dariniai. Vienspalviai stogai, asfaltas, vanduo turi mažai taškų
    # (plataus stogo vidurys – dešimtys metrų nuo artimiausio taško) – ten paviršius paliekamas, apkerpa tik Poisson tankis
    far = (d > max(100 * spacing, 25.0)) | footprint_mask(points, V[F].mean(1), cell=max(1.0, 10 * spacing))
    mesh.remove_triangles_by_mask(far)
    mesh.remove_unreferenced_vertices()
    if len(mesh.triangles):
        cl, cnt, _ = mesh.cluster_connected_triangles()
        cl, cnt = np.asarray(cl), np.asarray(cnt)
        mesh.remove_triangles_by_mask(cnt[cl] < max(200, 0.002 * cnt.max()))
        mesh.remove_unreferenced_vertices()
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_non_manifold_edges()
    log("Tinklo valymas: %d → %d trikampių (be atramos: %d)" % (n0, len(mesh.triangles), int(far.sum())))
    return mesh


def build(points_ply, out_ply, res, max_faces, spacing, work, log=print, smooth_iters=20):
    import open3d as o3d
    pc = o3d.io.read_point_cloud(points_ply)
    P = np.asarray(pc.points)
    if len(P):
        r = effective_res(P, res, max_faces)
        if r > res * 1.05:
            log("Tinklo raiška %.1f cm vietoj %.1f cm – %d trikampių ribai tiek užtenka" % (100 * r, 100 * res, max_faces))
        res = r
    # Poisson įvestis – ne tankesnė nei pusė tinklo raiškos (tankesni taškai detalių neprideda, tik laiką)
    if spacing < res / 2 and len(P):
        n0 = len(P)
        pc = pc.voxel_down_sample(res / 2)
        points_ply = os.path.join(work, "poisson_in.ply")
        o3d.io.write_point_cloud(points_ply, pc)
        log("Tinklui: %d → %d taškų (%.1f cm)" % (n0, len(pc.points), 100 * res / 2))
        P = np.asarray(pc.points)
    # Plotas – be pavienių tolimų taškų (procentiliai), aukštis – visas (aukščiausi stogai neturi būti nupjauti)
    lo, hi = np.percentile(P, 0.5, axis=0), np.percentile(P, 99.5, axis=0)
    lo[2], hi[2] = np.percentile(P[:, 2], 0.01), P[:, 2].max()
    extent = float(np.max(hi - lo))
    depth = poisson_depth(extent, res)
    raw = os.path.join(work, "poisson.ply")
    log("Poisson: gylis %d (~%.1f cm), %d taškų" % (depth, 100 * extent / 2 ** depth, len(P)))
    poisson(points_ply, raw, depth)
    m = o3d.io.read_triangle_mesh(raw)
    if not len(m.triangles):
        raise RuntimeError("Nepavyko sukurti 3D tinklo (Poisson)")
    # Sritis – pagal taškus (Poisson apgaubia visą erdvę)
    # Viršuje – daugiau vietos: kur taškų nėra (vienspalvis stogas), Poisson paviršius išsilenkia virš aukščiausio taško
    box = o3d.geometry.AxisAlignedBoundingBox(lo - 1.0, hi + np.array([1.0, 1.0, 5.0]))
    m = m.crop(box)
    V = np.asarray(m.vertices)
    z, n = clamp_above(P, V, cell=max(1.0, 10 * spacing))
    if n:
        V[:, 2] = z
        m.vertices = o3d.utility.Vector3dVector(V)
        log("Poisson išsipūtimas virš taškų nuleistas: %d viršūnių" % n)
    m = clean(m, P, spacing, log)
    # Išlyginimas (Taubin – nemažina tūrio ir nesuapvalina pastatų kaip paprastas vidurkinimas): pašalina taškų
    # debesies triukšmo „raukšles“ – lygesnis paviršius, tekstūra be trikampių raštų
    m = m.filter_smooth_taubin(number_of_iterations=smooth_iters)
    if len(m.triangles) > max_faces:
        n = len(m.triangles)
        m = m.simplify_quadric_decimation(max_faces)
        m.remove_unreferenced_vertices()
        log("Supaprastinta: %d → %d trikampių" % (n, len(m.triangles)))
    if not len(m.triangles):
        raise RuntimeError("Po valymo 3D tinklas tuščias")
    m.compute_vertex_normals()
    o3d.io.write_triangle_mesh(out_ply, m, write_vertex_colors=True)
    return len(m.triangles)


def flat_fill_mask(points, V, F, area_min=2.0, cell=2.0, tall=4.0):
    """Dideli skylių užtaisymo trikampiai (ReconstructMesh --close-holes) ne ties aukštu statiniu. Stiklinio pastato
    skylės užtaisomos naudingai, bet žemėje (aplink medžius, automobilius) tas pats užtaisymas palieka dideles pilkas
    plokštumas be tekstūros. Paliekami tik tie, kurių vietoje (~10 m) taškų aukščiai skiriasi > tall m."""
    from scipy import ndimage
    T = V[F]
    area = 0.5 * np.linalg.norm(np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]), axis=1)
    big = area > area_min
    if not big.any():
        return big
    lo = points[:, :2].min(0) - 3 * cell
    ij = np.floor((points[:, :2] - lo) / cell).astype(int)
    shape = tuple(ij.max(0) + 4)
    zmax = np.full(shape, -np.inf)
    zmin = np.full(shape, np.inf)
    np.maximum.at(zmax, (ij[:, 0], ij[:, 1]), points[:, 2])
    np.minimum.at(zmin, (ij[:, 0], ij[:, 1]), points[:, 2])
    hi = ndimage.maximum_filter(zmax, size=5, mode="constant", cval=-np.inf)
    lo_z = ndimage.minimum_filter(zmin, size=5, mode="constant", cval=np.inf)
    rel = np.where(np.isfinite(hi) & np.isfinite(lo_z), hi - lo_z, 0.0)
    c = np.floor((T[big].mean(1)[:, :2] - lo) / cell).astype(int)
    ok = (c >= 0).all(1) & (c[:, 0] < shape[0]) & (c[:, 1] < shape[1])
    keep = np.zeros(len(c), bool)
    keep[ok] = rel[c[ok, 0], c[ok, 1]] > tall
    out = np.zeros(len(F), bool)
    out[np.flatnonzero(big)[~keep]] = True
    return out


def finish(mesh_ply, out_ply, points_ply, max_faces, spacing, log=print, smooth_iters=3, facades=True,
           planes_out=None):
    """OpenMVS (ReconstructMesh) tinklas → toks pat rezultatas kaip build(): be dalių už taškų ploto (pasirinkta sritis,
    „sijonas“), be smulkių gabalų, ne daugiau max_faces trikampių."""
    import open3d as o3d
    m = o3d.io.read_triangle_mesh(mesh_ply)
    if not len(m.triangles):
        raise RuntimeError("Tuščias tinklas")
    P = np.asarray(o3d.io.read_point_cloud(points_ply).points)
    n0 = len(m.triangles)
    V, F = np.asarray(m.vertices), np.asarray(m.triangles)
    fills = flat_fill_mask(P, V, F)
    m.remove_triangles_by_mask(footprint_mask(P, V[F].mean(1), cell=max(1.0, 10 * spacing)) | fills)
    m.remove_unreferenced_vertices()
    if fills.any():
        log("Skylių užtaisymai lygioje vietovėje pašalinti: %d trikampių" % int(fills.sum()))
    if len(m.triangles):
        cl, cnt, _ = m.cluster_connected_triangles()
        cl, cnt = np.asarray(cl), np.asarray(cnt)
        m.remove_triangles_by_mask(cnt[cl] < max(200, 0.002 * cnt.max()))
        m.remove_unreferenced_vertices()
    m.remove_degenerate_triangles()
    m.remove_duplicated_triangles()
    m.remove_non_manifold_edges()
    if smooth_iters:
        m = m.filter_smooth_taubin(number_of_iterations=smooth_iters)
    blocks = None
    if facades and len(m.triangles) and os.environ.get("ATEA_BLOCKS", "1") != "0":
        # Pastatai – blokai (tiesios vertikalios sienos, stogas iš aukščių žemėlapio); nestačiakampiai – kaip tinkle
        import massing
        blocks = massing.apply(np.asarray(m.vertices), np.asarray(m.triangles), P, max_faces, log=log)
    if blocks is not None:
        Vb, Fb, planes = blocks
        m = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(Vb), o3d.utility.Vector3iVector(Fb))
        if planes and planes_out:
            save_planes(planes_out, planes)
    elif facades and len(m.triangles):
        # Sienos ieškomos pačiame tinkle (tolygūs taškai paviršiuje): debesyje stiklinių fasadų taškų per mažai
        S = np.asarray(m.sample_points_uniformly(min(3_000_000, 3 * len(m.triangles))).points)
        planes = wall_planes(S, voxel=0.15, dist=0.5, min_pts=2000, log=log)
        if planes and planes_out:
            save_planes(planes_out, planes)
        if planes:
            # OpenMVS jau sumažino trikampius: lygi siena ir skylių užtaisymai („kristalai“) – keli dideli trikampiai,
            # jų viršūnių per mažai išlyginti. Statūs trikampiai susmulkinami iki 0,5 m, po išlyginimo – vėl sumažinami
            import trimesh
            Vm, Fm = np.asarray(m.vertices), np.asarray(m.triangles)
            nrm = np.cross(Vm[Fm[:, 1]] - Vm[Fm[:, 0]], Vm[Fm[:, 2]] - Vm[Fm[:, 0]])
            steep = np.abs(nrm[:, 2]) < 0.6 * np.linalg.norm(nrm, axis=1)
            Vw, Fw = trimesh.remesh.subdivide_to_size(Vm, Fm[steep], max_edge=0.5, max_iter=10)
            m = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(np.concatenate([Vm, Vw])),
                                          o3d.utility.Vector3iVector(np.concatenate([Fm[~steep], Fw + len(Vm)])))
            m.remove_duplicated_vertices()
            m.remove_unreferenced_vertices()
            # Visa sienos ilgis, ±6 m: stiklo fasadas iš statmenų nuotraukų „išlinksta“ keliais metrais (aukštų
            # juostos – horizontalios, todėl gylis kiekviename aukštyje – vienas visai sienai)
            Vr, k = regularize_facades(np.asarray(m.vertices), planes, band=6.0, window=100.0)
            m.vertices = o3d.utility.Vector3dVector(Vr)
            log("Fasadai išlyginti išilgai aukštų: %d viršūnių (%d trikampių)" % (k, len(m.triangles)))
    n1 = len(m.triangles)
    if n1 > max_faces:
        m = m.simplify_quadric_decimation(max_faces)
        m.remove_unreferenced_vertices()
    if not len(m.triangles):
        raise RuntimeError("Po valymo 3D tinklas tuščias")
    log("OpenMVS tinklas: %d → %d (už ploto ribų pašalinta) → %d trikampių" % (n0, n1, len(m.triangles)))
    m.compute_vertex_normals()
    o3d.io.write_triangle_mesh(out_ply, m)
    return len(m.triangles)


def dsm_mesh(points, out_ply, max_faces, cell=0.1, log=print, smooth_iters=10, wall_edge=1.5, planes_out=None):
    """2,5D tinklas (kaip ODM pagal nutylėjimą ir greiti įrankiai statmenoms drono nuotraukoms): aukščių žemėlapis
    (aukščiausias patikimas taškas langelyje) → tinklelio trikampiai. Pastatų sienos – vertikalios nuo stogo krašto iki
    žemės, stogai plokšti; stiklo atspindžių taškai pastato viduje ir po stogu neturi įtakos. Kur taškų nėra (ploto
    viduje) – užpildoma artimiausiu aukščiu."""
    import open3d as o3d
    from scipy import ndimage
    P = np.asarray(points, np.float64)
    lo = P[:, :2].min(0)
    ij = np.floor((P[:, :2] - lo) / cell).astype(np.int64)
    nx, ny = ij.max(0) + 1
    key = ij[:, 0] * ny + ij[:, 1]
    # Langelio aukštis – 2-asis didžiausias taškas (pavienis triukšmo taškas virš stogo neiškelia paviršiaus)
    order = np.lexsort((-P[:, 2], key))
    k, z = key[order], P[order, 2]
    first = np.r_[True, k[1:] != k[:-1]]
    idx = np.flatnonzero(first)
    nxt = np.minimum(idx + 1, len(k) - 1)
    second = np.where(k[nxt] == k[idx], z[nxt], z[idx])
    Z = np.full(nx * ny, np.nan)
    Z[k[idx]] = second
    Z = Z.reshape(nx, ny)
    occ = np.isfinite(Z)
    area = ndimage.binary_fill_holes(ndimage.binary_closing(occ, iterations=5, border_value=0))
    # Tuščių langelių užpildymas artimiausiu aukščiu (tik ploto viduje), tada 5×5 medianinis – be dygių (stogo krašto „šukos“ nuo stiklo atspindžių), kraštai aštrūs
    _, (ii, jj) = ndimage.distance_transform_edt(~occ, return_indices=True)
    Z = Z[ii, jj]
    Z = ndimage.median_filter(Z, size=5)
    n_fill = int((area & ~occ).sum())
    # Tinklelis: viršūnė kiekvienam ploto langeliui, du trikampiai kvadratui (įstrižainė – mažesnio aukščių skirtumo)
    vid = np.full((nx, ny), -1, np.int64)
    vid[area] = np.arange(int(area.sum()))
    gi, gj = np.nonzero(area)
    V = np.c_[lo[0] + (gi + 0.5) * cell, lo[1] + (gj + 0.5) * cell, Z[gi, gj]]
    a, b, c, d = vid[:-1, :-1], vid[1:, :-1], vid[1:, 1:], vid[:-1, 1:]
    ok = (a >= 0) & (b >= 0) & (c >= 0) & (d >= 0)
    za, zb, zc, zd = Z[:-1, :-1][ok], Z[1:, :-1][ok], Z[1:, 1:][ok], Z[:-1, 1:][ok]
    a, b, c, d = a[ok], b[ok], c[ok], d[ok]
    diag_ac = np.abs(za - zc) <= np.abs(zb - zd)
    F = np.concatenate([np.c_[a, b, c][diag_ac], np.c_[a, c, d][diag_ac],
                        np.c_[a, b, d][~diag_ac], np.c_[b, c, d][~diag_ac]])
    m = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(V), o3d.utility.Vector3iVector(F))
    # Tinklelio „laipteliai“ sienose (10 cm) ištiesinami – siena tampa plokštuma, supaprastinus – dideli trikampiai,
    # o tekstūra – iš vienos nuotraukos (be vertikalių juostų). Taubin nemažina tūrio ir beveik neapvalina kraštų
    m = m.filter_smooth_taubin(number_of_iterations=smooth_iters)
    n0 = len(F)
    if n0 > max_faces // 8:
        # Aštuntadalis biudžeto – lygūs paviršiai (žemė, stogai) supaprastinami stipriai, likusieji trikampiai tenka
        # sienų padalijimui (žemiau): kitaip sienų trikampiai lieka po kelis metrus ir tekstūra subyra į juostas
        m = m.simplify_quadric_decimation(max_faces // 8)
        m.remove_unreferenced_vertices()
    m.remove_degenerate_triangles()
    # Sienos 2,5D tinkle – aukšti siauri trikampiai (stogo kraštas → žemė, 30 m × 10 cm): kiekvienas jų gauna vieną
    # nuotrauką, ir siena subyra į vertikalias juostas. Ilgos kraštinės padalijamos iki ~1,5 m – sienos tampa tinkleliu,
    # tekstūros lopai jungiasi į didelius plotus
    import trimesh
    Vm, Fm = np.asarray(m.vertices), np.asarray(m.triangles)
    nrm = np.cross(Vm[Fm[:, 1]] - Vm[Fm[:, 0]], Vm[Fm[:, 2]] - Vm[Fm[:, 0]])
    steep = np.abs(nrm[:, 2]) < 0.5 * np.linalg.norm(nrm, axis=1)     # tik sienos (žemė ir stogai – kaip yra)
    edge = wall_edge
    while True:   # trikampių riba – sienų padalijimas stambesnis, jei netelpa
        Vw, Fw = trimesh.remesh.subdivide_to_size(Vm, Fm[steep], max_edge=edge, max_iter=8)
        # Lygūs paviršiai – ne didesni nei ~4 × sienų: didelio trikampio tekstūra (tiesinė UV, ne perspektyvinė)
        # „nuplaukia“ – ortofoto ant žemės pasislenka
        Vg, Fg = trimesh.remesh.subdivide_to_size(Vm, Fm[~steep], max_edge=4 * edge, max_iter=8)
        if len(Fg) + len(Fw) <= max_faces or edge > 50:
            break
        edge *= 2
    Vd = np.concatenate([Vg, Vw])
    Fd = np.concatenate([Fg, Fw + len(Vg)])
    m = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(Vd), o3d.utility.Vector3iVector(Fd))
    m.remove_duplicated_vertices()
    m.remove_unreferenced_vertices()
    if os.environ.get("ATEA_BLOCKS", "1") != "0":
        import massing
        blocks = massing.apply(np.asarray(m.vertices), np.asarray(m.triangles), P, max_faces, log=log)
        if blocks is not None:
            m = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(blocks[0]), o3d.utility.Vector3iVector(blocks[1]))
            if blocks[2] and planes_out:
                save_planes(planes_out, blocks[2])
    m.compute_vertex_normals()
    o3d.io.write_triangle_mesh(out_ply, m)
    log("2,5D tinklas: %d × %d langelių po %.0f cm (užpildyta %d), %d → %d trikampių (sienos: %d, iki %.1f m)" % (
        nx, ny, cell * 100, n_fill, n0, len(m.triangles), len(Fw), edge))
    return len(m.triangles)


def wall_planes(points, voxel=0.1, dist=0.15, min_pts=1500, max_planes=30, above=3.0, log=print):
    """Pagrindinės vertikalios pastatų sienų plokštumos (RANSAC tarp taškų su horizontalia normale ≥ above m virš
    žemės). Grąžina [(n – vienetinė horizontali normalė, d, Q – plokštumos taškai)], plokštuma n·x + d = 0."""
    import open3d as o3d
    pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(points)).voxel_down_sample(voxel)
    pc.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=4 * voxel, max_nn=30))
    X, N = np.asarray(pc.points), np.asarray(pc.normals)
    ground = np.percentile(X[:, 2], 40)
    rest = pc.select_by_index(np.flatnonzero((np.abs(N[:, 2]) < 0.3) & (X[:, 2] > ground + above)))
    planes, misses = [], 0
    while len(rest.points) >= min_pts and len(planes) < max_planes and misses < 10:
        (a, b, c, d), inl = rest.segment_plane(distance_threshold=dist, ransac_n=3, num_iterations=3000)
        if len(inl) < min_pts:
            break
        Q = np.asarray(rest.points)[inl]
        rest = rest.select_by_index(inl, invert=True)
        n = np.array([a, b, c])
        if abs(n[2]) > 0.05:
            misses += 1
            continue
        n = np.array([a, b, 0.0]) / np.hypot(a, b)
        # Tik didžiausia jungi dalis: ta pati plokštuma gali kirsti kelis pastatus (gretimas pastatas – ne ta siena)
        lab = np.asarray(o3d.geometry.PointCloud(o3d.utility.Vector3dVector(Q)).cluster_dbscan(eps=5 * voxel,
                                                                                               min_points=5))
        if (lab >= 0).any():
            Q = Q[lab == np.bincount(lab[lab >= 0]).argmax()]
        if len(Q) < min_pts:
            misses += 1
            continue
        planes.append((n, -float(np.median(Q @ n)), Q))
    planes = merge_planes(planes)
    log("Sienų plokštumos: %d" % len(planes))
    return planes


def merge_planes(planes, snap_deg=15.0, merge_d=2.5):
    """Pastato sienos – stačiais kampais: normalės pritraukiamos prie pagrindinės krypties (didžiausios sienos) arba
    jai statmenos, jei skiriasi < snap_deg. Tada lygiagrečios plokštumos, nutolusios < merge_d, sujungiamos – stiklinė
    siena, kurios dalis „išlinkusi“, kitaip skyla į kelias plokštumas ir išlyginama tik iš dalies."""
    if not planes:
        return planes
    big = max(planes, key=lambda p: len(p[2]))[0]
    axes = [big, np.array([-big[1], big[0], 0.0])]
    snapped = []
    for n, d, Q in planes:
        best = None
        for a in axes:
            for sgn in (1.0, -1.0):
                if np.degrees(np.arccos(np.clip(n @ (sgn * a), -1, 1))) < snap_deg:
                    best = sgn * a
        n2 = best if best is not None else n
        snapped.append([n2, -float(np.median(Q @ n2)), Q])
    out = []
    for n, d, Q in sorted(snapped, key=lambda p: -len(p[2])):
        for o in out:
            if abs(n @ o[0]) > 0.999 and abs(d - (o[1] if n @ o[0] > 0 else -o[1])) < merge_d:
                o[2] = np.concatenate([o[2], Q])
                o[1] = -float(np.median(o[2] @ o[0]))
                break
        else:
            out.append([n, d, Q])
    return [(n, d, Q) for n, d, Q in out]


def regularize_facades(V, planes, band=1.2, cell=0.1, window=10.0, margin=1.0):
    """Fasadų „bangų“ (stiklo atspindžių triukšmo) išlyginimas išilgai aukštų: viršūnės iki band m nuo sienos
    plokštumos ir jos ribose – atstumas nuo plokštumos keičiamas medianu tame pačiame aukštyje (cell) ~window m
    ruože. Aukštų juostos, atbrailos, įdubos (kinta su aukščiu) lieka, horizontalios bangos (kinta išilgai) dingsta."""
    from scipy.ndimage import median_filter, uniform_filter1d
    V = V.copy()
    done = np.zeros(len(V), bool)
    for n, d, Q in planes:
        u = np.array([-n[1], n[0], 0.0])                       # kryptis išilgai sienos
        tq = Q @ u
        t0, t1 = tq.min() - margin, tq.max() + margin
        z0, z1 = Q[:, 2].min() - margin, Q[:, 2].max() + margin
        s = V @ n + d
        t = V @ u
        sel = (~done) & (np.abs(s) < band) & (t > t0) & (t < t1) & (V[:, 2] > z0) & (V[:, 2] < z1)
        idx = np.flatnonzero(sel)
        if len(idx) < 100:
            continue
        it = ((t[idx] - t0) / cell).astype(int)
        iz = ((V[idx, 2] - z0) / cell).astype(int)
        nt, nz = it.max() + 1, iz.max() + 1
        S = np.full((nt, nz), np.nan)
        # langelio reikšmė – paviršiaus atstumas (mediana), tušti – NaN
        key = it * nz + iz
        o = np.argsort(key)
        ks, ss = key[o], s[idx][o]
        start = np.r_[0, np.flatnonzero(np.diff(ks)) + 1]
        med = np.array([np.median(ss[a:b]) for a, b in zip(start, np.r_[start[1:], len(ks)])])
        S.flat[ks[start]] = med
        w = max(3, int(window / cell) | 1)
        filled = np.where(np.isnan(S), 0.0, S)
        cnt = (~np.isnan(S)).astype(float)
        # tuščių langelių įtaka – per svorį: mediana su NaN sunki, todėl vidurkis per langą be tuščių, tada mediana
        mean = uniform_filter1d(filled, w, axis=0, mode="nearest") / np.maximum(uniform_filter1d(cnt, w, axis=0,
                                                                                                mode="nearest"), 1e-6)
        base = np.where(np.isnan(S), mean, S)
        R = median_filter(base, size=(w, 1), mode="nearest")
        # Aukštyje – be 10 cm „laiptelių“ tarp gretimų eilučių: lengvas vertikalus išlyginimas ir tiesinė interpoliacija
        from scipy.ndimage import gaussian_filter1d
        R = gaussian_filter1d(median_filter(R, size=(1, 3), mode="nearest"), 1.0, axis=1, mode="nearest")
        zf = np.clip((V[idx, 2] - z0) / cell - 0.5, 0, nz - 1)
        z_lo = np.floor(zf).astype(int)
        z_hi = np.minimum(z_lo + 1, nz - 1)
        a = zf - z_lo
        target = R[it, z_lo] * (1 - a) + R[it, z_hi] * a
        V[idx] += np.outer(target - s[idx], n)
        done[idx] = True
    return V, int(done.sum())


def save_planes(path, planes, keep=4000):
    """Sienų plokštumos tekstūrai (kiekvienos – iki keep taškų jos ribai nusakyti)."""
    rng = np.random.default_rng(0)
    Q = [p[2][rng.choice(len(p[2]), min(keep, len(p[2])), replace=False)] for p in planes]
    np.savez(path, n=np.array([p[0] for p in planes]), d=np.array([p[1] for p in planes]),
             Q=np.concatenate(Q), k=np.repeat(np.arange(len(Q)), [len(q) for q in Q]))


def load_planes(path):
    z = np.load(path)
    return [(z["n"][i], float(z["d"][i]), z["Q"][z["k"] == i]) for i in range(len(z["n"]))]
