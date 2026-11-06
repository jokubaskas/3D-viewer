# splat_io ir app.py testai be GPU: netikras ODM projektas (OpenSfM rekonstrukcija + taškų debesis).
import gzip
import json
import math
import os
import struct
import sys
import time

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import splat_io  # noqa: E402

PIL = pytest.importorskip("PIL.Image")


def _fake_task(root, n_cams=12):
    """ODM užduoties katalogas: opensfm/undistorted/{reconstruction.json, images/*.tif}, odm_filterpoints/point_cloud.ply."""
    und = root / "opensfm" / "undistorted"
    (und / "images").mkdir(parents=True)
    shots = {}
    for i in range(n_cams):
        name = "DJI_%04d.JPG" % i
        # kamera 50 m virš (i, 0) taško, žiūri žemyn: R = diag(1,-1,-1) (OpenCV: z pirmyn → žemyn)
        C = np.array([i * 5.0, 0.0, 50.0])
        R = np.diag([1.0, -1.0, -1.0])
        rvec = np.array([math.pi, 0, 0])  # Rodrigues(π apie x) = diag(1,-1,-1)
        shots[name] = {"camera": "cam", "rotation": rvec.tolist(), "translation": (-R @ C).tolist()}
        PIL.new("RGB", (400, 300), (i * 10, 100, 200)).save(und / "images" / (name + ".tif"))
    rec = [{"cameras": {"cam": {"projection_type": "perspective", "width": 400, "height": 300, "focal": 0.8}}, "shots": shots}]
    (und / "reconstruction.json").write_text(json.dumps(rec))
    fp = root / "odm_filterpoints"
    fp.mkdir()
    pts = np.zeros(500, dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("nx", "<f4"), ("ny", "<f4"), ("nz", "<f4"),
                                ("red", "u1"), ("green", "u1"), ("blue", "u1"), ("views", "u1")])
    rng = np.random.default_rng(0)
    pts["x"], pts["y"], pts["z"] = rng.uniform(0, 50, 500), rng.uniform(-10, 10, 500), rng.uniform(0, 2, 500)
    pts["red"], pts["green"], pts["blue"] = 255, 128, 0
    with open(fp / "point_cloud.ply", "wb") as f:
        f.write(b"ply\nformat binary_little_endian 1.0\nelement vertex 500\n")
        for nm, t in [("x", "float"), ("y", "float"), ("z", "float"), ("nx", "float"), ("ny", "float"), ("nz", "float"),
                      ("red", "uchar"), ("green", "uchar"), ("blue", "uchar"), ("views", "uchar")]:
            f.write(("property %s %s\n" % (t, nm)).encode())
        f.write(b"end_header\n")
        f.write(pts.tobytes())
    return root


def test_load_cameras_and_points(tmp_path):
    task = _fake_task(tmp_path)
    cams = splat_io.load_cameras(str(task))
    assert len(cams) == 12
    c = cams[3]
    assert c["width"] == 400 and abs(c["K"][0, 0] - 320) < 1e-6 and abs(c["K"][0, 2] - 200) < 1e-6
    # kameros centras atkuriamas; taškas po kamera projektuojamas į vaizdo centrą
    C = splat_io.camera_centers(cams)[3]
    assert np.allclose(C, [15, 0, 50], atol=1e-6)
    p = c["viewmat"] @ np.array([15, 0, 0, 1.0])
    uv = c["K"] @ (p[:3] / p[2])
    assert p[2] > 0 and np.allclose(uv[:2], [200, 150], atol=1e-6)
    xyz, rgb = splat_io.load_points(str(task / "odm_filterpoints" / "point_cloud.ply"))
    assert xyz.shape == (500, 3) and np.allclose(rgb[0], [1, 128 / 255, 0], atol=1e-6)


def test_spz_roundtrip(tmp_path):
    """SPZ v2 iškoduojamas pagal formatą: pozicijos (24 b), alfa, spalva (×0.15), mastelis (log), sukimas, SH."""
    rng = np.random.default_rng(1)
    n = 1000
    means = rng.uniform(-300, 300, (n, 3))
    scales = rng.uniform(-5, 1, (n, 3))
    q = rng.normal(size=(n, 4))
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    op = rng.uniform(-3, 3, n)
    sh0 = rng.uniform(-1.5, 1.5, (n, 3))
    shN = rng.uniform(-0.5, 0.5, (n, 15, 3))
    p = tmp_path / "s.spz"
    splat_io.write_spz(str(p), means, scales, q, op, sh0, shN)
    raw = gzip.open(p).read()
    magic, ver, cnt, deg, fb, _, _ = struct.unpack("<IIIBBBB", raw[:16])
    assert (magic, ver, cnt, deg) == (0x5053474E, 2, n, 3)
    o = 16
    b = np.frombuffer(raw[o:o + 9 * n], np.uint8).reshape(n, 3, 3).astype(np.int64)
    fx = b[..., 0] | (b[..., 1] << 8) | (b[..., 2] << 16)
    fx = np.where(fx & 0x800000, fx - (1 << 24), fx)
    assert np.abs(fx / (1 << fb) - means).max() < 1.0 / (1 << fb)
    o += 9 * n
    a = np.frombuffer(raw[o:o + n], np.uint8) / 255.0
    assert np.abs(a - 1 / (1 + np.exp(-op))).max() < 0.003
    o += n
    col = np.frombuffer(raw[o:o + 3 * n], np.uint8).reshape(n, 3)
    assert np.abs((col / 255.0 - 0.5) / 0.15 - np.clip(sh0, -0.5 / 0.15, 0.5 / 0.15)).max() < 0.03
    o += 3 * n
    sc = np.frombuffer(raw[o:o + 3 * n], np.uint8).reshape(n, 3)
    assert np.abs(sc / 16.0 - 10 - scales).max() < 0.04
    o += 3 * n
    r = (np.frombuffer(raw[o:o + 3 * n], np.uint8).reshape(n, 3) - 127.5) / 127.5
    qq = np.where(q[:, :1] < 0, -q, q)
    assert np.abs(r - qq[:, 1:]).max() < 0.01
    o += 3 * n
    sh = (np.frombuffer(raw[o:o + 45 * n], np.uint8).reshape(n, 15, 3).astype(float) - 128) / 128
    assert np.abs(sh - shN).max() < 0.005
    assert len(raw) == o + 45 * n


def test_ply_header(tmp_path):
    n = 10
    p = tmp_path / "s.ply"
    splat_io.write_ply(str(p), np.zeros((n, 3)), np.zeros((n, 3)), np.tile([1, 0, 0, 0], (n, 1)), np.zeros(n), np.zeros((n, 3)), np.zeros((n, 3, 3)))
    v = splat_io.read_ply_vertices(str(p))
    assert len(v) == n and v.dtype.names[-1] == "rot_3" and "f_rest_8" in v.dtype.names and "f_rest_9" not in v.dtype.names


def test_app_train_status(tmp_path, monkeypatch):
    """API: netinkamas ID, nebaigtas projektas, paleidimas (be GPU – baigiasi klaida, matoma būsenoje), trynimas."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    task_root = tmp_path / "odm"
    uuid = "aaaaaaaa-1111-2222-3333-444444444444"
    _fake_task(task_root / uuid)
    monkeypatch.setenv("ODM_DATA", str(task_root))
    monkeypatch.setenv("SPLAT_DATA", str(tmp_path / "out"))
    import importlib
    import app as splat_app
    importlib.reload(splat_app)
    c = TestClient(splat_app.app)
    assert c.post("/train", json={"uuid": "../x"}).status_code == 400
    assert c.post("/train", json={"uuid": "bbbbbbbb-1111-2222-3333-444444444444"}).status_code == 400
    r = c.post("/train", json={"uuid": uuid, "steps": 1000})
    assert r.status_code == 200, r.text
    splat_app._proc["p"].wait(120)
    jobs = c.get("/jobs").json()
    assert len(jobs) == 1 and jobs[0]["uuid"] == uuid
    assert jobs[0]["state"] == "error" and jobs[0]["message"]  # be gsplat / GPU
    assert c.post("/delete", json={"uuid": uuid}).json()["ok"]
    assert c.get("/jobs").json() == []


def test_train_pipeline_with_fake_rasterizer(tmp_path, monkeypatch):
    """train.py logika be GPU: gsplat pakeičiamas paprastu (diferencijuojamu) imitaciniu atvaizdavimu.
    Tikrinama: kameros, gylio taikiniai, nuostoliai, eksporto valymas (splatai ore), meta.json su pradiniu vaizdu."""
    torch = pytest.importorskip("torch")
    pytest.importorskip("scipy")
    import types

    def rasterization(means, quats, scales, opacities, colors, viewmats, Ks, width, height, render_mode="RGB", **kw):
        # vidutinė spalva + gylis = vidutinis z kameros koordinatėse (užtenka formoms ir gradientams)
        pc = means @ viewmats[0, :3, :3].T + viewmats[0, :3, 3]
        rgb = (colors[:, 0, :] * 0.28209479177387814 + 0.5).mean(0) * opacities.mean() + 0 * scales.mean() + 0 * quats.mean()
        img = rgb.view(1, 1, 1, 3).expand(1, height, width, 3)
        if render_mode == "RGB+ED":
            img = torch.cat([img, pc[:, 2].mean().view(1, 1, 1, 1).expand(1, height, width, 1)], -1)
        return img, torch.ones(1, height, width, 1), {}

    class MCMCStrategy:
        def __init__(self, **kw):
            pass

        def check_sanity(self, params, optimizers):
            assert set(params.keys()) == set(optimizers.keys())

        def initialize_state(self):
            return {}

        def step_pre_backward(self, *a, **k):
            pass

        def step_post_backward(self, params, optimizers, state, step, info, lr):
            assert lr > 0

    g = types.ModuleType("gsplat")
    g.rasterization = rasterization
    gs = types.ModuleType("gsplat.strategy")
    gs.MCMCStrategy = MCMCStrategy
    monkeypatch.setitem(sys.modules, "gsplat", g)
    monkeypatch.setitem(sys.modules, "gsplat.strategy", gs)

    task = _fake_task(tmp_path / "task")
    out_dir = tmp_path / "out"
    import importlib
    import train
    importlib.reload(train)
    monkeypatch.setattr(sys, "argv", ["train.py", "--task-dir", str(task), "--out-dir", str(out_dir), "--steps", "120",
                                      "--device", "cpu", "--max-size", "200"])
    train.main()
    st = json.load(open(out_dir / "status.json"))
    assert st["state"] == "done", st
    meta = json.load(open(out_dir / "meta.json"))
    assert meta["splats"] == 500
    assert len(meta["view"]["position"]) == 3 and len(meta["view"]["target"]) == 3
    v = splat_io.read_ply_vertices(str(out_dir / "scene.ply"))
    assert len(v) == 500 and (out_dir / "scene.spz").stat().st_size > 1000


def test_near_points_mask():
    from scipy.spatial import cKDTree
    pts = np.random.default_rng(0).uniform(0, 10, (1000, 3))
    m = splat_io.near_points_mask(np.array([[5, 5, 5], [5, 5, 30], [50, 0, 0]]), cKDTree(pts), 1.0)
    assert m.tolist() == [True, False, False]
