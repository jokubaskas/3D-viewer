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
    print("Geometric-consistent estimated depth-maps 1 (50%%, 1s, ETA 1s)...\\rDensifying point-cloud completed")
    out = out[:-4] + ".ply"
open(out, "w").write("ply")
""" % sys.executable


@pytest.fixture
def pl(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for b in ("InterfaceCOLMAP", "DensifyPointCloud"):
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
    assert not os.path.exists(os.path.join(pl.work, "openmvs"))   # gylio žemėlapiai išvalyti
    calls = open(tmp_path / "calls.txt").read().splitlines()
    assert calls[0].startswith("InterfaceCOLMAP")
    assert "--max-resolution 2048" in calls[1] and "--number-views 5" in calls[1] and "--cuda-device -1" in calls[1]
    assert any("Densifying point-cloud completed" in m for m in pl.logs)
    assert not any("depth-maps 1 (" in m for m in pl.logs)              # progreso eilutės neužteršia žurnalo
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
