# Kamerų palyginimo (compare_sfm.py) pagalbinės dalys: Sim3 suderinimas, ODM trukmė iš žurnalo, ODM kamerų centrai.
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import compare_sfm  # noqa: E402


def test_umeyama_recovers_sim3():
    rng = np.random.default_rng(0)
    A = rng.normal(size=(50, 3)) * 30
    th = 0.3
    R = np.array([[np.cos(th), -np.sin(th), 0], [np.sin(th), np.cos(th), 0], [0, 0, 1]])
    B = 1.02 * A @ R.T + [5, -3, 2]
    s, R2, t = compare_sfm.umeyama(A, B)
    assert abs(s - 1.02) < 1e-9 and np.allclose(R2, R) and np.allclose(t, [5, -3, 2])


def test_odm_sfm_minutes(tmp_path):
    log = tmp_path / "task_output.txt"
    log.write_text("\n".join([
        "[INFO]    Running opensfm stage",
        '[INFO]    running "/code/opensfm" detect_features "/x"',
        "2026-11-24 13:54:37,950 INFO: Planning",
        "2026-11-24 14:01:25,453 DEBUG: Loaded",
        "2026-11-24 14:02:25,451 DEBUG: Undistorting image",
        "[INFO]    Running openmvs stage",
        "14:02:46 [App     ] OpenMVS",
    ]))
    assert abs(compare_sfm.odm_sfm_minutes(str(log)) - (7 * 60 + 48) / 60) < 1e-6
    assert compare_sfm.odm_sfm_minutes(str(tmp_path / "nera.txt")) is None


def test_odm_centers(tmp_path):
    task = tmp_path / "t"
    (task / "opensfm" / "undistorted").mkdir(parents=True)
    (task / "odm_georeferencing").mkdir()
    # kamera be posūkio ties (1, 2, 50): t = −R·C
    rec = [{"shots": {"a.JPG": {"rotation": [0, 0, 0], "translation": [-1, -2, -50]}}}]
    json.dump(rec, open(task / "opensfm" / "undistorted" / "reconstruction.json", "w"))
    (task / "odm_georeferencing" / "coords.txt").write_text("WGS84 UTM 34N\n684268 6087837\n")
    c, zone = compare_sfm.odm_centers(str(task))
    assert zone == "WGS84 UTM 34N" and np.allclose(c["a.JPG"], [684269, 6087839, 50])


def test_latest_odm_project(tmp_path):
    for i, u in enumerate(("u1", "u2")):
        p = tmp_path / u / "opensfm" / "undistorted"
        p.mkdir(parents=True)
        (p / "reconstruction.json").write_text("[]")
        os.utime(p / "reconstruction.json", (1000 + i, 1000 + i))
    (tmp_path / "u3").mkdir()
    assert compare_sfm.latest_odm_project(str(tmp_path)) == "u2"


def test_compare_end_to_end(tmp_path, monkeypatch, capsys):
    """Sintetinis ODM projektas (tikrosios kameros OpenSfM formatu) → palyginimas su COLMAP 4 + GLOMAP."""
    import pytest
    pytest.importorskip("pycolmap")
    pytest.importorskip("open3d")
    from scipy.spatial.transform import Rotation
    import geo
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import synth
    u = "12345678-1234-1234-1234-1234567890ab"
    task = tmp_path / "odm" / u
    cams = synth.make_dataset(str(task / "images"), oblique=True, gps_noise=0.5)
    lat0, lon0, alt0 = synth.ORIGIN
    zone, south = geo.utm_zone(lat0, lon0)
    o = geo.GeoFrame(zone, south, 0, 0).to_local(lat0, lon0, alt0)
    off = np.round(o[:2])
    shots = {}
    for c in cams:
        R = np.asarray(c["viewmat"])[:3, :3]
        cl = np.asarray(c["center"]) + [o[0] - off[0], o[1] - off[1], o[2]]
        shots[c["name"]] = {"rotation": Rotation.from_matrix(R).as_rotvec().tolist(), "translation": (-R @ cl).tolist()}
    (task / "opensfm" / "undistorted").mkdir(parents=True)
    json.dump([{"shots": shots}], open(task / "opensfm" / "undistorted" / "reconstruction.json", "w"))
    (task / "odm_georeferencing").mkdir()
    (task / "odm_georeferencing" / "coords.txt").write_text("WGS84 UTM %d%s\n%d %d\n" % (zone, "S" if south else "N", off[0], off[1]))
    monkeypatch.setattr(compare_sfm, "ODM_DATA", str(tmp_path / "odm"))
    monkeypatch.setattr(compare_sfm, "ENGINE_DATA", str(tmp_path / "engine"))
    monkeypatch.setattr(sys, "argv", ["compare_sfm.py"])
    compare_sfm.main()
    rep = open(tmp_path / "engine" / "sfm-palyginimas" / u / "ataskaita.txt", encoding="utf-8").read()
    assert "Sujungta nuotraukų" in rep and ("%d" % len(cams)) in rep
    line = next(l for l in rep.split("\n") if l.startswith("Tarpusavio"))
    rms = float(line.split("RMS ")[1].split(" m")[0])
    assert rms < 0.5, line
