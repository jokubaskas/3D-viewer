# Tinklo valymas ir gylio ribos (be GPU).
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
o3d = pytest.importorskip("open3d")
pytest.importorskip("pycolmap")
import mesh  # noqa: E402
import pipeline  # noqa: E402


def _scene(rng):
    """Lygi žemė 60×60 m ir 20 m aukščio pastatas 16×12 m; stogo viduryje taškų nėra (vienspalvis stogas)."""
    g = rng.uniform(-30, 30, (60000, 2))
    inb = (np.abs(g[:, 0]) < 8) & (np.abs(g[:, 1]) < 6)
    ground = np.c_[g[~inb], rng.normal(0, 0.02, (~inb).sum())]
    r = rng.uniform([-8, -6], [8, 6], (8000, 2))
    edge = (np.abs(r[:, 0]) > 3.5) | (np.abs(r[:, 1]) > 2.5)
    roof = np.c_[r[edge], np.full(edge.sum(), 20.0)]
    walls = []
    for z in np.arange(0.2, 20, 0.25):
        t = np.linspace(-8, 8, 64)
        walls += [np.c_[t, np.full(64, -6), np.full(64, z)], np.c_[t, np.full(64, 6), np.full(64, z)]]
        t = np.linspace(-6, 6, 48)
        walls += [np.c_[np.full(48, -8), t, np.full(48, z)], np.c_[np.full(48, 8), t, np.full(48, z)]]
    return np.concatenate([ground, roof] + walls)


def test_mesh_no_drooping_edges_roof_kept(tmp_path):
    P = _scene(np.random.default_rng(0))
    pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(P))
    pc.colors = o3d.utility.Vector3dVector(np.full((len(P), 3), 0.5))
    pc.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=1.0, max_nn=30))
    pc.orient_normals_to_align_with_direction([0, 0, 1])
    pts = str(tmp_path / "p.ply")
    o3d.io.write_point_cloud(pts, pc)
    out = str(tmp_path / "m.ply")
    mesh.build(pts, out, res=0.25, max_faces=200_000, spacing=0.1, work=str(tmp_path), log=lambda m: None)
    m = o3d.io.read_triangle_mesh(out)
    V = np.asarray(m.vertices)
    assert V[:, 2].min() > -1.6, V[:, 2].min()  # be nulinkusių kraštų
    assert np.abs(V[:, :2]).max() < 32
    # Stogo vidurys be taškų – paviršius lieka ~20 m aukštyje
    sc = o3d.t.geometry.RaycastingScene()
    sc.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(m))
    rays = np.array([[x, y, 40, 0, 0, -1] for x in (-3, 0, 3) for y in (-2, 0, 2)], np.float32)
    t = sc.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
    assert np.all(np.abs(40 - t - 20) < 2.5), 40 - t


def test_depth_bounds_keep_tall_roof():
    """Ne nadiro nuotrauka: 2 % taškų – stogas 30 m nuo kameros, likusieji – žemė 56 m."""
    rng = np.random.default_rng(1)
    ground = [rng.normal(56, 0.5, 5000) for _ in range(20)]
    edge = [np.r_[rng.normal(56, 0.5, 9800), rng.normal(30, 0.3, 50)]]
    dmin, dmax = pipeline.depth_bounds(ground + edge)
    assert dmin < 28 and 57 < dmax < 80
    assert pipeline.depth_bounds([np.ones(5)]) is None


def test_footprint_mask_cuts_skirt_keeps_roof_hole():
    P = _scene(np.random.default_rng(0))
    C = np.array([
        [0, 0, 20],      # stogo vidurys be taškų – paliekamas
        [10, 10, 0],     # žemė – paliekama
        [10, 10, -4],    # po žeme (Poisson „sijonas“)
        [36, 0, -3],     # už ploto ribos – nulinkęs kraštas
        [29.5, 0, -0.5],  # pats kraštas – paliekamas
    ], float)
    bad = mesh.footprint_mask(P, C, cell=1.0)
    assert list(bad) == [False, False, True, True, False]
