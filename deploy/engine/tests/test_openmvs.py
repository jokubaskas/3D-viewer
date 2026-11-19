# OpenMVS gylio etapas su netikromis programomis (be GPU): komandos, debesies perkėlimas, suliejimo praleidimas,
# grįžimas prie COLMAP, kai OpenMVS nepavyksta.
import os
import stat
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
pycolmap = pytest.importorskip("pycolmap")
import pipeline  # noqa: E402

FAKE = """#!%s
import os, sys
a = sys.argv[1:]
open(os.environ["FAKE_LOG"], "a").write(os.path.basename(sys.argv[0]) + " " + " ".join(a) + "\\n")
out = a[a.index("-o") + 1]
if os.path.basename(sys.argv[0]) == "DensifyPointCloud":
    if os.environ.get("FAKE_FAIL"):
        print("CUDA error"); sys.exit(3)
    print("depth-maps 1 (50%%, 1s, ETA 1s)...\\rdepth-maps 2 (100%%, 2s, ETA 0s)...\\rDensifying point-cloud completed")
    out = out[:-4] + ".ply"
    open(out[:-4] + ".mvs", "w").write("mvs")
    open(os.path.join(os.path.dirname(out), "x.dmap"), "w").write("d")
if os.path.basename(sys.argv[0]) == "ReconstructMesh":
    import shutil
    shutil.copyfile(os.environ["FAKE_MESH"], out)
    sys.exit(0)
open(out, "w").write("ply")
""" % sys.executable


@pytest.fixture
def pl(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for b in ("InterfaceCOLMAP", "DensifyPointCloud", "ReconstructMesh"):
        f = bin_dir / b
        f.write_text(FAKE)
        f.chmod(f.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(pipeline, "OPENMVS", str(bin_dir))
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "calls.txt"))
    p = pipeline.Pipeline(str(tmp_path / "task"), "high", log=lambda m: logs.append(m))
    logs = []
    p.logs = logs
    os.makedirs(os.path.join(p.dense_dir, "sparse"))
    pycolmap.Reconstruction().write(os.path.join(p.dense_dir, "sparse"))
    return p


def test_openmvs_dense_and_fusion_skip(pl, tmp_path):
    assert pipeline.openmvs_available()
    pl.stage_dense()
    assert open(os.path.join(pl.dense_dir, "fused.ply")).read() == "ply"
    ws = os.path.join(pl.work, "openmvs")
    assert not os.path.exists(os.path.join(ws, "x.dmap"))                 # gylio žemėlapiai išvalyti
    assert os.path.isfile(os.path.join(ws, "dense.mvs"))                  # scena lieka tinklui
    calls = open(tmp_path / "calls.txt").read().splitlines()
    assert calls[0].startswith("InterfaceCOLMAP")
    assert "--max-resolution 1024" in calls[1] and "--number-views 12" in calls[1] and "--cuda-device -2" in calls[1]
    assert any("Densifying point-cloud completed" in m for m in pl.logs)
    assert sum("depth-maps" in m for m in pl.logs) == 1                 # progresas – ne dažniau kaip kas minutę
    pl.stage_fusion()                                                    # COLMAP suliejimas nepaleidžiamas
    assert any("OpenMVS" in m for m in pl.logs)


def test_openmvs_failure_falls_back_to_colmap(pl, monkeypatch):
    monkeypatch.setenv("FAKE_FAIL", "1")
    used = []
    monkeypatch.setattr(pipeline.Pipeline, "_dense_colmap", lambda self: used.append(1))
    pl.stage_dense()
    assert used and not os.path.exists(os.path.join(pl.dense_dir, ".openmvs"))
    assert any("CUDA error" in m for m in pl.logs) and any("COLMAP" in m for m in pl.logs)


def test_cancel_kills_tool(pl):
    open(os.path.join(pl.dir, "cancel"), "w").close()
    with pytest.raises(pipeline.Cancelled):
        pl.stage_dense()


def test_openmvs_mesh_cropped_and_workspace_removed(pl, tmp_path, monkeypatch):
    import numpy as np
    o3d = pytest.importorskip("open3d")
    pl.stage_dense()
    # Taškai – 20 × 20 m plotas; OpenMVS tinklas – 60 × 60 m plokštuma (už taškų ribų turi būti nukirpta)
    g = np.random.default_rng(0).uniform(-10, 10, (20000, 2))
    o3d.io.write_point_cloud(pl.out("odm_filterpoints", "point_cloud.ply"),
                             o3d.geometry.PointCloud(o3d.utility.Vector3dVector(np.c_[g, np.zeros(len(g))])))
    big = o3d.geometry.TriangleMesh.create_box(60, 60, 0.01).translate((-30, -30, -0.01)).subdivide_midpoint(7)
    o3d.io.write_triangle_mesh(str(tmp_path / "m.ply"), big)
    monkeypatch.setenv("FAKE_MESH", str(tmp_path / "m.ply"))
    pl.stage_mesh()
    V = np.asarray(o3d.io.read_triangle_mesh(pl.out("odm_meshing", "odm_mesh.ply")).vertices)
    assert len(V) and np.abs(V[:, :2]).max() < 14
    assert os.path.isfile(os.path.join(pl.work, "openmvs", "dense.mvs"))    # scena lieka tekstūrai
    assert any("OpenMVS tinklas" in m for m in pl.logs)


def test_import_textured_obj(tmp_path):
    import numpy as np
    from PIL import Image
    import texturing
    src = tmp_path / "src"
    src.mkdir()
    Image.new("RGB", (64, 32), (200, 10, 10)).save(src / "t_map0.png")
    Image.new("RGB", (32, 32), (10, 200, 10)).save(src / "t_map1.png")
    (src / "t.mtl").write_text("newmtl m0\nmap_Kd t_map0.png\nnewmtl m1\nmap_Kd t_map1.png\n")
    (src / "t.obj").write_text("mtllib t.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\n"
                               "vt 0 0\nvt 1 0\nvt 0 1\nvt 1 1\nusemtl m0\nf 1/1 2/2 3/3\nusemtl m1\nf 2/2 4/4 3/3\n")
    out = tmp_path / "out"
    out.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    assert texturing.import_obj(str(src / "t.obj"), str(out / "m"), work=str(work)) == 2
    d = np.load(work / "texture_uv.npz")
    assert list(d["page"]) == [0, 1] and d["F"].tolist() == [[0, 1, 2], [1, 3, 2]]
    assert np.allclose(d["uv"][0, 2], [0, 0])          # vt (0, 1) → viršus (v apverstas)
    assert (out / "m.glb").is_file() and (out / "m_map_1.jpg").is_file()
