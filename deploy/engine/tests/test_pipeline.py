# Visa variklio grandinė su sintetiniu drono rinkiniu (be GPU): SfM, georeferencija, (gylio žemėlapiai – pakeičiami
# tiksliais scenos taškais, nes PatchMatch veikia tik su CUDA), valymas, tinklas, tekstūra, GLB / OBJ / LAZ, ortofoto,
# DSM / DTM, kameros realistiškam vaizdui. Tikrinama geometrija ir georeferencija prieš žinomą sceną.
import json
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
pycolmap = pytest.importorskip("pycolmap")
o3d = pytest.importorskip("open3d")
pytest.importorskip("rasterio")
pytest.importorskip("laspy")

import geo  # noqa: E402
import pipeline  # noqa: E402
import synth  # noqa: E402


def _gt_offset(task):
    """Sintetinės scenos (vietinis ENU nuo ORIGIN) → variklio vietinis rėmas (UTM − poslinkis)."""
    frame = geo.GeoFrame.from_json(json.load(open(os.path.join(task, "work", "frame.json"))))
    lat0, lon0, alt0 = synth.ORIGIN
    return frame.to_local(lat0, lon0, alt0)


ROOF = (-5, 15, 24, 12, 16)  # (x, y, plotis, gylis, aukštis) – synth.scene_mesh() pastatas


def _on_roof(P):
    x, y, w, d, h = ROOF
    return (P[:, 0] > x) & (P[:, 0] < x + w) & (P[:, 1] > y) & (P[:, 1] < y + d) & (P[:, 2] > h - 0.5)


def fake_dense(pl):
    """Vietoj PatchMatch: kiekvienai ištiesintai kamerai – tikslus scenos gylis, spalva iš nuotraukos.
    Vieno pastato stogas – be taškų (kaip vienspalvis stogas, kurio PatchMatch neatkuria)."""
    import texturing
    from PIL import Image
    off = _gt_offset(pl.dir)
    m = synth.scene_mesh().translate(off)
    sc = o3d.t.geometry.RaycastingScene()
    sc.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(m))
    P, C, N = [], [], []
    for cam in texturing.load_cameras(pl.dense_dir):
        W, H = cam["width"], cam["height"]
        rays = o3d.t.geometry.RaycastingScene.create_rays_pinhole(o3d.core.Tensor(cam["K"]), o3d.core.Tensor(cam["viewmat"]), W, H)
        hit = sc.cast_rays(rays)
        t = hit["t_hit"].numpy()
        ok = np.isfinite(t)
        r = rays.numpy()
        pts = (r[..., :3] + r[..., 3:] * np.where(ok, t, 0)[..., None])[ok]
        img = np.asarray(Image.open(cam["path"]).convert("RGB"), np.float32)[ok] / 255
        sel = (np.random.default_rng(0).random(len(pts)) < 0.25) & ~_on_roof(pts - off)
        P.append(pts[sel]); C.append(img[sel]); N.append(hit["primitive_normals"].numpy()[ok][sel])
    pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(np.concatenate(P)))
    pc.colors = o3d.utility.Vector3dVector(np.concatenate(C))
    pc.normals = o3d.utility.Vector3dVector(np.concatenate(N))
    pc = pc.voxel_down_sample(0.05)
    o3d.io.write_point_cloud(os.path.join(pl.dense_dir, "fused.ply"), pc)


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    # ENGINE_TEST_DIR – kūrimo metu: pakartotinai paleidžiant tęsiama nuo jau atliktų etapų
    task = os.environ.get("ENGINE_TEST_DIR") or str(tmp_path_factory.mktemp("task"))
    cams = synth.make_dataset(os.path.join(task, "images"), oblique=True, gps_noise=0.8)
    pl = pipeline.Pipeline(task, "fast")
    pl.q.update(mesh_res=0.12, mesh_faces=120_000, point_spacing=0.08, ortho_gsd=0.1, page_size=2048, texture_size=800)
    pl.stage_dense = lambda: None
    pl.stage_fusion = lambda: fake_dense(pl)
    logs = []
    pl._log = lambda m: logs.append(m)
    prog = []
    pl._progress = prog.append
    pl.run()
    return task, cams, logs, prog


def test_sfm_and_georef(run):
    task, cams, logs, prog = run
    import pycolmap
    rec = pycolmap.Reconstruction(os.path.join(task, "work", "sfm_geo"))
    assert rec.num_reg_images() == len(cams)
    off = _gt_offset(task)
    gt = {c["name"]: c["center"] + off for c in cams}
    err = [np.linalg.norm(im.projection_center() - gt[im.name]) for im in rec.images.values()]
    # GPS triukšmas 0,8 m – po Sim3 per visas nuotraukas vidutinė padėties paklaida turi būti mažesnė
    assert np.median(err) < 0.6, np.median(err)
    assert prog[-1] == 100.0
    assert open(os.path.join(task, "odm_georeferencing", "coords.txt")).read().startswith("WGS84 UTM 35N")


def test_mesh_matches_scene(run):
    task, *_ = run
    m = o3d.io.read_triangle_mesh(os.path.join(task, "odm_meshing", "odm_mesh.ply"))
    assert 10_000 < len(m.triangles) <= 120_000
    gt = synth.scene_mesh().translate(_gt_offset(task))
    sc = o3d.t.geometry.RaycastingScene()
    sc.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(gt))
    d = sc.compute_distance(o3d.core.Tensor(np.asarray(m.vertices, np.float32))).numpy()
    assert np.percentile(d, 90) < 0.25, np.percentile(d, 90)
    # Stogas be taškų – Poisson paviršius paliekamas (ne skylė): spindulys iš viršaus pataiko į paviršių ~stogo aukštyje
    off = _gt_offset(task)
    ms = o3d.t.geometry.RaycastingScene()
    ms.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(m))
    x, y, w, dd, h = ROOF
    xs, ys = np.meshgrid(np.linspace(x + 2, x + w - 2, 8), np.linspace(y + 2, y + dd - 2, 5))
    rays = np.stack([xs.ravel() + off[0], ys.ravel() + off[1], np.full(xs.size, off[2] + 40), np.zeros(xs.size), np.zeros(xs.size), -np.ones(xs.size)], 1)
    t = ms.cast_rays(o3d.core.Tensor(rays.astype(np.float32)))["t_hit"].numpy()
    z = off[2] + 40 - t - off[2]
    assert np.isfinite(t).all(), "stoge skylė"
    assert np.median(z) > h - 3, np.median(z)


def test_texture_glb_obj(run):
    task, *_ = run
    import trimesh
    tex = os.path.join(task, "odm_texturing")
    assert os.path.isfile(os.path.join(tex, "odm_textured_model_geo.obj"))
    assert os.path.isfile(os.path.join(tex, "odm_textured_model_geo.mtl"))
    g = trimesh.load(os.path.join(tex, "odm_textured_model_geo.glb"))
    geoms = list(g.geometry.values())
    assert geoms and all(getattr(x.visual, "uv", None) is not None for x in geoms)
    # Tekstūra – iš nuotraukų (spalvota), ne pilka
    from PIL import Image
    pg = np.asarray(Image.open(os.path.join(tex, "odm_textured_model_geo_map_0.jpg")), np.float32)
    assert pg.std() > 30


def test_ortho_and_dems(run):
    task, cams, *_ = run
    import rasterio
    with rasterio.open(os.path.join(task, "odm_orthophoto", "odm_orthophoto.tif")) as r:
        assert r.crs.to_epsg() == 32635 and r.count == 4
        a = r.read(4)
        assert (a > 0).mean() > 0.8
        rgb = r.read([1, 2, 3])
    # Ortofoto spalvos atitinka sceną toje pačioje vietoje (georeferencija + tekstūra + ortoprojekcija)
    frame = geo.GeoFrame.from_json(json.load(open(os.path.join(task, "work", "frame.json"))))
    off = _gt_offset(task)
    with rasterio.open(os.path.join(task, "odm_orthophoto", "odm_orthophoto.tif")) as r, \
            rasterio.open(os.path.join(task, "odm_dem", "dsm.tif")) as d:
        img = r.read([1, 2, 3, 4]).transpose(1, 2, 0).astype(float)
        dsm = d.read(1)
        assert d.nodata == -9999.0
        rows, cols = np.meshgrid(np.arange(30, r.height - 30, 7), np.arange(30, r.width - 30, 7), indexing="ij")
        rows, cols = rows.ravel(), cols.ravel()
        xs, ys = (np.array(v) for v in rasterio.transform.xy(r.transform, rows, cols))
        dr, dc = rasterio.transform.rowcol(d.transform, xs, ys)
        z = dsm[np.clip(dr, 0, d.height - 1), np.clip(dc, 0, d.width - 1)]
        zz = dsm[dsm > -9999]
    ok = (img[rows, cols, 3] > 0) & (z > -9000)
    P = np.stack([xs - frame.off_e - off[0], ys - frame.off_n - off[1], z - off[2]], 1)[ok]
    got = img[rows, cols, :3][ok]
    err = np.median(np.abs(synth.texture(P) * 255 - got).mean(1))
    err_shift = np.median(np.abs(synth.texture(P + [1.0, 0, 0]) * 255 - got).mean(1))
    assert err < 22 and err_shift > 1.6 * err, (err, err_shift)
    # Žemė ~ ORIGIN aukštis, pastatai iki +16 m
    assert abs(np.percentile(zz, 20) - synth.ORIGIN[2]) < 0.5 and np.percentile(zz, 99.5) > synth.ORIGIN[2] + 10
    with rasterio.open(os.path.join(task, "odm_dem", "dtm.tif")) as d:
        t = d.read(1)
        tt = t[t > -9999]
        assert np.percentile(tt, 99) < synth.ORIGIN[2] + 3   # pastatai pašalinti


def test_laz_and_splat_cameras(run):
    task, cams, *_ = run
    import laspy
    las = laspy.read(os.path.join(task, "odm_georeferencing", "odm_georeferenced_model.laz"))
    assert len(las.points) > 1000 and las.header.parse_crs().to_epsg() == 32635
    assert 300000 < float(np.mean(las.x)) < 800000
    rec = json.load(open(os.path.join(task, "opensfm", "undistorted", "reconstruction.json")))
    assert len(rec[0]["shots"]) == len(cams)
    import splat_io
    sc = splat_io.load_cameras(task)
    assert len(sc) == len(cams) and os.path.isfile(sc[0]["path"])


def test_resume_skips_done_stages(run):
    task, *_ = run
    pl = pipeline.Pipeline(task, "fast")
    logs = []
    pl._log = logs.append
    pl.run(until="georef")
    assert sum("jau atliktas" in l for l in logs) == 5


def test_gcp_georeference(run, tmp_path):
    """Kontroliniai taškai (gcp_list.txt, ODM formatas) – georeferencija pagal juos, ne pagal (triukšmingą) GPS."""
    import shutil
    task, cams, *_ = run
    t2 = str(tmp_path / "t2")
    os.makedirs(os.path.join(t2, "work"))
    for f in ("sfm", "frame.json", "photos.json"):
        src = os.path.join(task, "work", f)
        (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, os.path.join(t2, "work", f))
    frame = geo.GeoFrame.from_json(json.load(open(os.path.join(task, "work", "frame.json"))))
    lat0, lon0, alt0 = synth.ORIGIN
    # Pastatų stogų kampai ir žemės taškai (sintetinės scenos koordinatės)
    pts = {"A": (-24, -19, 12), "B": (-8, -7, 12), "C": (11, -24, 8), "D": (23, -6, 8), "E": (-4, 26, 16), "F": (39, 29, 6)}
    lines = ["WGS84 UTM %dN" % frame.zone]
    for name, p in pts.items():
        lat, lon, alt = synth.local_to_wgs84(*p)
        e, n = frame._fwd.transform(lon, lat)
        k = 0
        for c in cams:
            Y = c["viewmat"][:3, :3] @ np.array(p, float) + c["viewmat"][:3, 3]
            u, v = c["K"][0, 0] * Y[0] / Y[2] + c["K"][0, 2], c["K"][1, 1] * Y[1] / Y[2] + c["K"][1, 2]
            if Y[2] > 0 and 20 < u < 780 and 20 < v < 580 and k < 6:
                lines.append("%.3f %.3f %.3f %.2f %.2f %s %s" % (e, n, alt, u, v, c["name"], name))
                k += 1
    open(os.path.join(t2, "gcp_list.txt"), "w").write("\n".join(lines) + "\n")
    pl = pipeline.Pipeline(t2, "fast")
    logs = []
    pl._log = logs.append
    pl.stage_georef()
    assert any("Kontroliniai taškai: 6" in l for l in logs), logs
    rec = pycolmap.Reconstruction(os.path.join(t2, "work", "sfm_geo"))
    off = _gt_offset(task)
    gt = {c["name"]: c["center"] + off for c in cams}
    err = [np.linalg.norm(im.projection_center() - gt[im.name]) for im in rec.images.values()]
    assert np.median(err) < 0.15, np.median(err)


def test_boundary_polygon():
    frame = geo.GeoFrame(35, False, 500000, 6060000)
    lat, lon = frame.to_wgs84(np.array([0, 100, 100, 0, 0.0]), np.array([0, 0, 50, 50, 0.0]))
    gj = {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [list(map(list, zip(lon, lat)))]}}
    poly = geo.boundary_polygon(json.dumps(gj), frame)
    assert np.allclose(poly[0], [0, 0], atol=0.01)
    inside = geo.inside_polygon(np.array([[50, 25], [150, 25], [50, -5], [99, 49]]), poly)
    assert list(inside) == [True, False, False, True]


def test_geo_txt_overrides_exif():
    g = geo.parse_geo_txt("EPSG:4326\nDJI_0001_W.JPG 25.1 54.2 101.5 nan nan nan 0.020 0.040\nbad line\nX.JPG 25 54 nan\n")
    assert g["DJI_0001_W.JPG"]["alt"] == 101.5 and g["DJI_0001_W.JPG"]["hacc"] == 0.02
    assert np.isnan(g["X.JPG"]["alt"]) and len(g) == 2


def test_nadir_planar_distorted_flight(tmp_path):
    """Tik statmenos nuotraukos plokščioje vietovėje su objektyvo iškraipymu: visos nuotraukos sujungiamos vienu
    modeliu, žemė neišlinkusi, pastato aukštis teisingas (židinys – iš kameros duomenų, nekeičiamas)."""
    task = str(tmp_path / "t")
    synth.make_dataset(os.path.join(task, "images"), k1=-0.12, gps_noise=1.0, calibrated=True)
    pl = pipeline.Pipeline(task, "fast")
    logs = []
    pl._log = logs.append
    pl.run(until="georef")
    assert any("CalibratedFocalLength" in l for l in logs), logs
    rec = pycolmap.Reconstruction(os.path.join(task, "work", "sfm_geo"))
    assert rec.num_reg_images() == 49
    P = np.array([q.xyz for q in rec.points3D.values()]) - _gt_offset(task)
    g = P[np.abs(P[:, 2]) < 2]
    r = np.hypot(g[:, 0], g[:, 1])
    rings = [np.median(g[(r >= a) & (r < a + 15), 2]) for a in (0, 15, 30, 45)]
    assert max(rings) - min(rings) < 0.3, rings          # be „dubens“
    assert abs(np.median(g[:, 2])) < 0.5, np.median(g[:, 2])
    x, y, w, d, h = ROOF
    roof = P[(P[:, 0] > x + 1) & (P[:, 0] < x + w - 1) & (P[:, 1] > y + 1) & (P[:, 1] < y + d - 1) & (P[:, 2] > 8)]
    assert abs(np.median(roof[:, 2]) - h) < 0.6, np.median(roof[:, 2])


def test_dji_camera_prior():
    base = {"width": 5280, "height": 3956, "focal35": 24.0}
    p = geo.camera_prior(dict(base, xmp={"DewarpData": "2022-06-08;3713.29,3713.29,7.02,-8.72,-0.112,0.0149,-0.00027,0.00021,-0.0057",
                                       "DewarpFlag": 0.0}))
    assert p["source"] == "DJI DewarpData" and abs(p["f"] - 3713.29) < 0.01 and abs(p["cx"] - 2647.02) < 0.01 and p["k"][0] == -0.112
    p = geo.camera_prior(dict(base, xmp={"DewarpData": "2022-06-08;3713.29,3713.29,7.02,-8.72,-0.112,0.0149,-0.00027,0.00021,-0.0057",
                                       "DewarpFlag": 1.0}))
    assert p["k"] is None
    p = geo.camera_prior(dict(base, xmp={}))
    assert p["source"] == "EXIF 35 mm" and abs(p["f"] - 24 / 43.2666 * np.hypot(5280, 3956)) < 0.1
    assert geo.camera_prior(dict(base, focal35=None, xmp={})) is None
