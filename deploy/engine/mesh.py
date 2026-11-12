# Atea variklis – 3D tinklas iš tankaus taškų debesies: Screened Poisson (PoissonRecon per COLMAP, MIT) ir valymas:
#   • Poisson gylis pagal norimą raišką ir srities dydį (ODM mesh-octree-depth logika);
#   • tankio apkirpimas (COLMAP trim) – pašalinami „ekstrapoliuoti“ paviršiai be taškų;
#   • tik labai toli (> 25 m) nuo bet kurio taško nutolę dariniai (mažai taškų turinčios vietos – stogai, asfaltas – lieka);
#   • smulkūs atskiri gabalai; supaprastinimas iki trikampių ribos (ODM mesh-size).
import math
import os

import numpy as np


def poisson_depth(extent, res):
    return int(np.clip(math.ceil(math.log2(max(extent, 1.0) / max(res, 1e-3))), 8, 13))


def poisson(points_ply, out_ply, depth, trim=5.0):
    import pycolmap
    o = pycolmap.PoissonMeshingOptions()
    o.depth = depth
    o.trim = trim
    o.color = True
    o.point_weight = 4.0  # ODM: pointWeight 4 – tvirčiau prie taškų, mažiau „išpūtimo“
    pycolmap.poisson_meshing(points_ply, out_ply, o)


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
    far = d > max(100 * spacing, 25.0)
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


def build(points_ply, out_ply, res, max_faces, spacing, work, log=print):
    import open3d as o3d
    pc = o3d.io.read_point_cloud(points_ply)
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
    m = clean(m, P, spacing, log)
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
