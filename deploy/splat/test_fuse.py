# „Sujungto modelio“ testas be GPU: sintetinis pastatas (dėžė ant žemės). ODM modelyje sienoje skylė, o „splatai“
# (pakaitalas – spindulių sekimas pilnoje geometrijoje) mato visą sieną ir dar „atspindį“ už stiklo kitoje sienos pusėje.
import os

import numpy as np
import pytest

o3d = pytest.importorskip("open3d")
import fuse  # noqa: E402


def _look_at(eye, target):
    z = target - eye
    z /= np.linalg.norm(z)
    x = np.cross(z, [0, 0, 1.0])
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    R = np.stack([x, y, z])
    V = np.eye(4)
    V[:3, :3] = R
    V[:3, 3] = -R @ eye
    return V


def _cams(n=24, W=160, H=120):
    K = np.array([[120.0, 0, W / 2], [0, 120.0, H / 2], [0, 0, 1]])
    out = []
    for i in range(n):
        a = 2 * np.pi * i / n
        for h, r in ((6.0, 22.0), (14.0, 16.0)):
            eye = np.array([r * np.cos(a), r * np.sin(a), h])
            out.append({"name": "c%d_%g" % (i, h), "viewmat": _look_at(eye, np.array([0, 0, 3.0])), "K": K, "width": W, "height": H})
    return out


def _building(hole):
    """Dėžė 10×10×6 m ant 40×40 m žemės. hole=True – fasade x=+5 išpjauta 3×2 m skylė (y∈[-1.5,1.5], z∈[2,4])."""
    box = o3d.geometry.TriangleMesh.create_box(10, 10, 6).translate((-5, -5, 0))
    box = box.subdivide_midpoint(4)
    ground = o3d.geometry.TriangleMesh.create_box(40, 40, 0.01).translate((-20, -20, -0.01)).subdivide_midpoint(3)
    m = box + ground
    if hole:
        V, F = np.asarray(m.vertices), np.asarray(m.triangles)
        c = V[F].mean(1)
        cut = (np.abs(c[:, 0] - 5) < 1e-3) & (np.abs(c[:, 1]) < 1.5) & (c[:, 2] > 2) & (c[:, 2] < 4)
        assert cut.sum() > 4
        m.remove_triangles_by_mask(cut)
        m.remove_unreferenced_vertices()
    return m


def _fake_splats(full):
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(full))

    def render(cam, W, H, K):
        d = fuse.mesh_depth(scene, cam, W, H, K)
        hit = np.isfinite(d)
        rgb = np.zeros((H, W, 3), np.float32)
        rgb[..., 0] = 0.8
        rgb[..., 1] = 0.4
        # „Atspindys“: kur matoma siena y<-2 (stiklas), splatai mato 3 m už sienos
        rays = o3d.t.geometry.RaycastingScene.create_rays_pinhole(o3d.core.Tensor(K), o3d.core.Tensor(cam["viewmat"]), W, H).numpy()
        t = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
        p = rays[..., :3] + rays[..., 3:] * np.where(np.isfinite(t), t, 0)[..., None]
        glass = hit & (np.abs(p[..., 0] + 5) < 1e-2) & (p[..., 1] < -2) & (p[..., 2] > 1)
        d = np.where(glass, d + 3.0, d)
        return rgb, np.where(hit, d, 0).astype(np.float32), hit.astype(np.float32)

    return render


def test_fuse_depth_rules():
    dm = np.array([10.0, 10.0, 10.0, np.inf, 10.0, np.inf])
    ds = np.array([5.0, 10.1, 14.0, 7.0, 5.0, 7.0])
    a = np.array([1.0, 1.0, 1.0, 1.0, 0.2, 0.2])
    d, src = fuse.fuse_depth(dm, ds, a)
    assert list(src) == [2, 1, 1, 2, 1, 0]          # arčiau – splatas; atitinka / atspindys – modelis; permatoma – modelis
    assert list(d[:5]) == [5.0, 10.0, 10.0, 7.0, 10.0]


def test_fills_hole_and_ignores_reflection(tmp_path):
    mesh_path = str(tmp_path / "odm_mesh.ply")
    o3d.io.write_triangle_mesh(mesh_path, _building(hole=True))
    out = str(tmp_path / "fused.glb")
    res = fuse.fuse(_cams(), _fake_splats(_building(hole=False)), mesh_path, ((-12, -12, -1), (12, 12, 10)), out,
                    max_size=160, voxel=0.12, log=lambda m: None)
    assert os.path.getsize(out) > 0 and res["triangles"] > 1000
    assert 0 < res["from_splats"] < 0.2
    import trimesh
    g = trimesh.load(out, force="mesh")
    V = np.asarray(g.vertices)
    # Skylė užpildyta: sienos x=+5 plokštumoje skylės vietoje yra paviršius
    inhole = (np.abs(V[:, 0] - 5) < 0.3) & (np.abs(V[:, 1]) < 1.2) & (V[:, 2] > 2.3) & (V[:, 2] < 3.7)
    assert inhole.sum() > 20
    # Atspindys ignoruotas: už „stiklo“ (pastato viduje prie x=-2) paviršiaus nėra
    behind = (np.abs(V[:, 0] + 2) < 0.5) & (V[:, 1] < -2.5) & (V[:, 1] > -4.5) & (V[:, 2] > 1.5) & (V[:, 2] < 5)
    assert behind.sum() == 0
    # Spalva iš splatų (glTF – tiesinės: sRGB 0,8 → 0,60; 0,4 → 0,13)
    C = np.asarray(g.visual.vertex_colors)[:, :3].astype(float)
    assert abs(np.median(C[:, 0]) - 153) < 15 and abs(np.median(C[:, 1]) - 34) < 10


def test_region_and_voxel():
    pts = np.random.default_rng(0).uniform([-100, -100, 0], [100, 100, 20], (20000, 3))
    lo, hi = fuse.region(pts, np.array([[10.0, 0, 50], [30.0, 0, 50]]), radius=30)
    assert np.allclose(lo[:2], [-10, -30]) and np.allclose(hi[:2], [50, 30])
    assert 0.03 <= fuse.auto_voxel(lo, hi) < 0.04             # 60×60 m, 16 mln. trikampių – ~3,4 cm
    lo, hi = fuse.region(pts, np.zeros((1, 3)), radius=20)
    assert 0.02 <= fuse.auto_voxel(lo, hi) < 0.025            # 40×40 m – ~2 cm
    lo, hi = fuse.region(pts, np.zeros((1, 3)))
    assert 0.10 < fuse.auto_voxel(lo, hi) <= 0.15             # visas 200×200 m projektas – stambiau
    # Mažai laisvos atminties – mažesnės dalys (ne prastesnis detalumas)
    assert fuse.tile_triangles(64 * fuse.GB) == fuse.TILE_TRIANGLES
    assert fuse.tile_triangles(2 * fuse.GB) == fuse.TILE_TRIANGLES // 2
    assert fuse.tile_triangles(0.1 * fuse.GB) == 300_000


def test_tiles_give_same_surface(tmp_path):
    """Suliejimas dalimis (plytelėmis): tas pats paviršius kaip vienu kartu, skylė užpildyta, siūlės be tarpų."""
    mesh_path = str(tmp_path / "odm_mesh.ply")
    o3d.io.write_triangle_mesh(mesh_path, _building(hole=True))
    render = _fake_splats(_building(hole=False))
    box = ((-12, -12, -1), (12, 12, 10))
    one = fuse.fuse(_cams(), render, mesh_path, box, str(tmp_path / "a.glb"), max_size=160, voxel=0.12, log=lambda m: None, tile=100)
    many = fuse.fuse(_cams(), render, mesh_path, box, str(tmp_path / "b.glb"), max_size=160, voxel=0.12, log=lambda m: None, tile=7,
                     work_dir=str(tmp_path))
    assert one["tiles"] == 1 and many["tiles"] == 16
    assert abs(many["triangles"] - one["triangles"]) < 0.03 * one["triangles"]
    assert not [f for f in os.listdir(tmp_path) if f.startswith("fuse_")]   # laikini kadrai ištrinti
    import trimesh
    a = trimesh.load(str(tmp_path / "a.glb"), force="mesh")
    b = trimesh.load(str(tmp_path / "b.glb"), force="mesh")
    assert abs(a.area - b.area) < 0.02 * a.area
    V = np.asarray(b.vertices)
    assert ((np.abs(V[:, 0] - 5) < 0.3) & (np.abs(V[:, 1]) < 1.2) & (V[:, 2] > 2.3) & (V[:, 2] < 3.7)).sum() > 20
    # Siūlė ties x=-6 (plytelių riba) ant žemės: paviršius be tarpo
    band = (np.abs(V[:, 0] + 6) < 0.2) & (np.abs(V[:, 2]) < 0.3) & (np.abs(V[:, 1]) < 10) & (np.abs(V[:, 1]) > 6)
    assert band.sum() > 20


def test_fuse_api(tmp_path, monkeypatch):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    import app as appmod
    uid = "12345678-1234-1234-1234-123456789abc"
    monkeypatch.setattr(appmod, "DATA", str(tmp_path / "data"))
    monkeypatch.setattr(appmod, "ODM_DATA", str(tmp_path / "odm"))
    und = tmp_path / "odm" / uid / "opensfm" / "undistorted"
    und.mkdir(parents=True)
    (und / "reconstruction.json").write_text("[]")
    calls = []

    class P:
        def __init__(self, cmd, **kw):
            calls.append(cmd)

        def poll(self):
            return None

    monkeypatch.setattr(appmod.subprocess, "Popen", P)
    c = TestClient(appmod.app)
    assert c.post("/fuse", json={"uuid": uid, "radius": 40}).status_code == 400   # dar nėra splatų
    out = tmp_path / "data" / uid
    out.mkdir(parents=True)
    (out / "scene.ply").write_bytes(b"x")
    (out / "status.json").write_text('{"state": "done"}')
    r = c.post("/fuse", json={"uuid": uid, "radius": 40, "cx": 1.5, "cy": -2})
    assert r.status_code == 200 and r.json()["fuse"]["state"] == "preparing" and r.json()["state"] == "done"
    assert calls[0][-6:] == ["--radius", "40.0", "--cx", "1.5", "--cy", "-2.0"]
    assert c.post("/fuse", json={"uuid": uid}).status_code == 409                  # vienu metu – vienas darbas
    assert c.post("/fuse", json={"uuid": "../x"}).status_code == 400


def test_camera_seeing_region_edge_only_is_skipped(tmp_path):
    """Kamera, kuri sritį mato tik keliais pikseliais (ne kas 4-uoju), neturi nutraukti suliejimo (Open3D „No block is touched“)."""
    full = _building(hole=False)
    base = _fake_splats(full)
    cams = _cams()

    def render(cam, W, H, K):
        rgb, d, a = base(cam, W, H, K)
        if cam is cams[0]:  # tik keli nelyginiai pikseliai
            m = np.zeros_like(a)
            m[61:72:4, 81:92:4] = 1  # vaizdo centre (pastatas), bet ne ant kas 4-ojo pikselio
            assert (d * m > 0).sum() == 9
            d, a = d * m, a * m
        return rgb, d, a

    cams[0] = dict(cams[0])
    out = str(tmp_path / "fused.glb")
    res = fuse.fuse(cams, render, None, ((-12, -12, -1), (12, 12, 10)), out, max_size=160, voxel=0.15, log=lambda m: None)
    assert res["triangles"] > 1000


def test_no_surface_in_region_gives_clear_error(tmp_path):
    render = _fake_splats(_building(hole=False))
    with pytest.raises(RuntimeError, match="padidinkite"):
        fuse.fuse(_cams(), render, None, ((50, 50, 0), (60, 60, 5)), str(tmp_path / "f.glb"), max_size=160, voxel=0.15, log=lambda m: None)


def test_fuse_killed_by_oom_message(tmp_path, monkeypatch):
    pytest.importorskip("fastapi")
    import app as appmod
    uid = "12345678-1234-1234-1234-123456789abc"
    monkeypatch.setattr(appmod, "DATA", str(tmp_path))
    (tmp_path / uid).mkdir()
    (tmp_path / uid / "fuse_status.json").write_text('{"state": "finishing", "message": "Išgaunamas paviršius"}')

    class Dead:
        returncode = -9

        def poll(self):
            return -9

    monkeypatch.setitem(appmod._proc, "p", Dead())
    monkeypatch.setitem(appmod._proc, "uuid", uid)
    monkeypatch.setitem(appmod._proc, "kind", "fuse")
    st = appmod._fuse_status(uid)
    assert st["state"] == "error" and "pritrūko atminties (etapas: Išgaunamas paviršius)" in st["message"]


def test_tiles_simplified_keep_seams(tmp_path, monkeypatch):
    """Kiekviena dalis supaprastinama atskirai (be didelio galutinio supaprastinimo), sandūros išlieka."""
    render = _fake_splats(_building(hole=False))
    box = ((-12, -12, -1), (12, 12, 10))
    full = fuse.fuse(_cams(), render, None, box, str(tmp_path / "a.glb"), max_size=160, voxel=0.12, log=lambda m: None, tile=7)
    monkeypatch.setattr(fuse, "MAX_TRIANGLES", full["triangles"] // 4)
    small = fuse.fuse(_cams(), render, None, box, str(tmp_path / "b.glb"), max_size=160, voxel=0.12, log=lambda m: None, tile=7)
    assert small["triangles"] <= 1.2 * fuse.MAX_TRIANGLES
    import trimesh
    a = trimesh.load(str(tmp_path / "a.glb"), force="mesh")
    b = trimesh.load(str(tmp_path / "b.glb"), force="mesh")
    assert abs(a.area - b.area) < 0.03 * a.area                       # forma ta pati
    # Atvirų kraštų (tarpų) ne daugiau nei be supaprastinimo
    def boundary_len(m):
        e = m.edges_sorted
        u, c = np.unique(e, axis=0, return_counts=True)
        return np.linalg.norm(m.vertices[u[c == 1, 0]] - m.vertices[u[c == 1, 1]], axis=1).sum()
    assert boundary_len(b) < 1.3 * boundary_len(a) + 1
