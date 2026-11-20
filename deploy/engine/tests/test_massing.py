# Pastatų blokai statmenoms nuotraukoms (be GPU).
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
pytest.importorskip("scipy")
o3d = pytest.importorskip("open3d")
import massing  # noqa: E402

TH = np.radians(20.0)
ROT = np.array([[np.cos(TH), -np.sin(TH)], [np.sin(TH), np.cos(TH)]])   # pastato (u, v) → pasaulis


def _scene(rng, recess=0.5):
    """Žemė 120×120 m ir pasuktas 30×16 m, 24 m aukščio pastatas. Stogo kraštas – pado riba, fasadas įtrauktas
    recess m; stogo viduryje – „stiklas“ (taškai tik apačioje, kaip pro stiklą)."""
    g = rng.uniform(-60, 60, (150000, 2))
    uv = g @ ROT
    inb = (np.abs(uv[:, 0]) < 15) & (np.abs(uv[:, 1]) < 8)
    ground = np.c_[g[~inb], rng.normal(0, 0.03, (~inb).sum())]
    r = rng.uniform([-15, -8], [15, 8], (40000, 2))
    glass = (np.abs(r[:, 0]) < 3) & (np.abs(r[:, 1]) < 3)
    roof = np.c_[r @ ROT.T, np.where(glass, 3.0, 24.0) + rng.normal(0, 0.05, len(r))]
    walls = []
    for z in np.arange(4.0, 23.5, 0.3):
        for u0, v0, du, dv, n in ((15 - recess, -8, 0, 16, 60), (-15 + recess, -8, 0, 16, 60),
                                  (-15, 8 - recess, 30, 0, 110), (-15, -8 + recess, 30, 0, 110)):
            t = rng.uniform(0, 1, n)
            q = np.c_[u0 + t * du, v0 + t * dv]
            walls.append(np.c_[q @ ROT.T, np.full(n, z)])
    return np.concatenate([ground, roof] + walls)


def _rough_mesh(P):
    """„Banguotas“ 3D tinklas – žemės tinklelis su iškilimu pastato vietoje (kaip iš ReconstructMesh)."""
    x = np.arange(-60, 60.1, 2.0)
    X, Y = np.meshgrid(x, x, indexing="ij")
    uv = np.stack([X, Y], -1) @ ROT
    Z = np.where((np.abs(uv[..., 0]) < 15) & (np.abs(uv[..., 1]) < 8), 24.0, 0.0)
    V = np.c_[X.ravel(), Y.ravel(), Z.ravel()]
    n = len(x)
    i, j = np.meshgrid(np.arange(n - 1), np.arange(n - 1), indexing="ij")
    a = (i * n + j).ravel()
    F = np.r_[np.c_[a, a + n, a + n + 1], np.c_[a, a + n + 1, a + 1]]
    return V, F


def test_block_replaces_building():
    rng = np.random.default_rng(0)
    P = _scene(rng)
    V, F = _rough_mesh(P)
    res = massing.apply(V, F, P, max_faces=200_000, log=lambda *_: None)
    assert res is not None
    Vb, Fb, planes = res
    assert len(Fb) <= 200_000
    assert len(planes) == 4
    for n, d, Q in planes:
        assert abs(n[2]) < 1e-6
        # sienos – vertikalios plokštumos fasado vietoje (įtraukta 0,5 m nuo stogo krašto)
        assert np.abs(Q @ n + d).max() < 0.05
        nu = np.abs(n[:2] @ ROT)
        half = 15.0 if nu[0] > 0.9 else 8.0
        assert abs(-d - (half - 0.5)) < 0.4
    # stogas: aukštis ~24 m ir stiklo vietoje (taškai apačioje) – ne įduba
    uv = Vb[:, :2] @ ROT
    roof = (np.abs(uv[:, 0]) < 12) & (np.abs(uv[:, 1]) < 5) & (Vb[:, 2] > 1)
    assert roof.sum() > 100
    assert np.abs(Vb[roof, 2] - 24.0).max() < 0.5


def test_no_building_on_flat_ground():
    rng = np.random.default_rng(1)
    g = rng.uniform(-40, 40, (50000, 2))
    P = np.c_[g, rng.normal(0, 0.05, len(g))]
    x = np.arange(-40, 40.1, 4.0)
    X, Y = np.meshgrid(x, x, indexing="ij")
    V = np.c_[X.ravel(), Y.ravel(), np.zeros(X.size)]
    n = len(x)
    a = np.arange(n - 1)[:, None] * n + np.arange(n - 1)[None, :]
    F = np.r_[np.c_[a.ravel(), a.ravel() + n, a.ravel() + n + 1], np.c_[a.ravel(), a.ravel() + n + 1, a.ravel() + 1]]
    assert massing.apply(V, F, P, max_faces=10000, log=lambda *_: None) is None
