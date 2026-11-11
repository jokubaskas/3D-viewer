# Variklio API: NodeODM suderinamas projektų ciklas (init → upload → commit → info / output → all.zip, cancel, restart,
# remove), automatinis realistiško vaizdo mokymas po „Aukštos kokybės“, failų vardų apsauga. Tikra grandinė pakeista
# trumpu procesu (tikroji tikrinama test_pipeline.py).
import io
import json
import os
import sys
import time
import zipfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
pytest.importorskip("fastapi")
pytest.importorskip("multipart")
from fastapi.testclient import TestClient  # noqa: E402

import app as appmod  # noqa: E402

FAKE = r'''
import json, os, sys, time
d = sys.argv[sys.argv.index("--task-dir") + 1]
q = sys.argv[sys.argv.index("--quality") + 1]
print("Running dataset stage", flush=True)
if os.path.exists(os.path.join(d, "images", "fail.txt")):
    print("KLAIDA: Nepavyko sujungti nuotraukų", flush=True); sys.exit(1)
for i in range(int(open(os.path.join(d, "images", "steps.txt")).read()) if os.path.exists(os.path.join(d, "images", "steps.txt")) else 1):
    if os.path.exists(os.path.join(d, "cancel")): sys.exit(2)
    time.sleep(0.05)
os.makedirs(os.path.join(d, "odm_texturing"), exist_ok=True)
open(os.path.join(d, "odm_texturing", "odm_textured_model_geo.glb"), "wb").write(b"glb" * 100)
os.makedirs(os.path.join(d, "odm_georeferencing"), exist_ok=True)
open(os.path.join(d, "odm_georeferencing", "coords.txt"), "w").write("WGS84 UTM 35N\n1 2\n")
json.dump({"progress": 100}, open(os.path.join(d, "progress.json"), "w"))
print("quality", q, flush=True)
'''


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(appmod, "ENGINE_DATA", str(tmp_path / "engine"))
    monkeypatch.setattr(appmod, "DATA", str(tmp_path / "splat"))
    monkeypatch.setattr(appmod, "ODM_DATA", str(tmp_path / "odm"))
    fake = tmp_path / "fake_pipeline.py"
    fake.write_text(FAKE)

    def start(uuid, args):
        import subprocess
        t = appmod._task(uuid)
        if not t or t.get("status") not in (appmod.QUEUED, appmod.RUNNING):
            return None
        appmod._update_task(uuid, status=appmod.RUNNING, startedAt=time.time() * 1000)
        d = appmod._tdir(uuid)
        try:
            os.remove(os.path.join(d, "cancel"))
        except OSError:
            pass
        return subprocess.Popen([sys.executable, str(fake), "--task-dir", d, "--quality", appmod._quality(t)],
                                stdout=open(os.path.join(d, "log.txt"), "a"), stderr=subprocess.STDOUT)

    splats = []

    def start_splat(uuid, args):
        import subprocess
        splats.append((uuid, args))
        appmod._write_splat_status(uuid, state="done", steps=args["steps"])
        open(os.path.join(appmod.DATA, uuid, "scene.spz"), "wb").write(b"spz")
        return subprocess.Popen([sys.executable, "-c", "pass"])

    monkeypatch.setattr(appmod, "start_pipeline", start)
    monkeypatch.setattr(appmod, "start_splat", start_splat)
    jobs = appmod.Jobs()
    monkeypatch.setattr(appmod, "JOBS", jobs)
    with TestClient(appmod.app) as c:
        c.splats = splats
        yield c


def _wait(c, uuid, codes, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        info = c.get("/nodeodm/task/%s/info" % uuid).json()
        if info["status"]["code"] in codes:
            return info
        time.sleep(0.1)
    raise AssertionError("laukta būsenos %s, gauta %s" % (codes, info))


def _new(c, quality, files=(("a.JPG", b"x"),), uuid=None):
    h = {"set-uuid": uuid} if uuid else {}
    r = c.post("/nodeodm/task/new/init", data={"name": "Bandymas", "options": json.dumps([{"name": "quality", "value": quality}])}, headers=h)
    assert r.status_code == 200, r.text
    u = r.json()["uuid"]
    r = c.post("/nodeodm/task/new/upload/" + u, files=[("images", (n, io.BytesIO(b), "image/jpeg")) for n, b in files])
    assert r.status_code == 200, r.text
    return u


def test_full_cycle_high_trains_splat(client):
    c = client
    assert c.get("/nodeodm/info").json()["engine"] == "atea"
    u = _new(c, "high", files=[("DJI_0001.JPG", b"1"), ("DJI_0002.JPG", b"2"), ("gcp_list.txt", b"WGS84 UTM 35N\n")])
    assert c.post("/nodeodm/task/new/commit/" + u).status_code == 200
    info = _wait(c, u, {40})
    assert info["imagesCount"] == 3 and info["progress"] == 100 and info["name"] == "Bandymas"
    assert any("quality high" in l for l in c.get("/nodeodm/task/%s/output" % u).json())
    assert c.get("/nodeodm/task/%s/output" % u, params={"line": 1}).json()[0] != "Running dataset stage"
    # Po „Aukštos kokybės“ – realistiškas vaizdas automatiškai
    t0 = time.time()
    while not c.splats and time.time() - t0 < 10:
        time.sleep(0.1)
    assert c.splats and c.splats[0][0] == u and c.splats[0][1]["auto"] and c.splats[0][1]["steps"] == 30000
    time.sleep(0.3)
    j = {x["uuid"]: x for x in c.get("/jobs").json()}
    assert j[u]["has_result"]
    assert c.get("/nodeodm/task/%s/info" % u).json()["splat"]["has_result"]
    # all.zip – rezultatai ODM struktūra
    z = zipfile.ZipFile(io.BytesIO(c.get("/nodeodm/task/%s/download/all.zip" % u).content))
    assert sorted(z.namelist()) == ["odm_georeferencing/coords.txt", "odm_texturing/odm_textured_model_geo.glb"]
    assert z.read("odm_georeferencing/coords.txt").startswith(b"WGS84")
    assert {"uuid": u} in c.get("/nodeodm/task/list").json()
    # Pašalinimas – ir splatai
    assert c.post("/nodeodm/task/remove", data={"uuid": u}).json()["success"]
    assert c.get("/nodeodm/task/%s/info" % u).status_code == 404
    assert not os.path.exists(os.path.join(appmod.DATA, u))


def test_fast_no_splat_and_failure_restart(client):
    c = client
    u = _new(c, "fast", files=[("a.JPG", b"1"), ("fail.txt", b"")])
    c.post("/nodeodm/task/new/commit/" + u)
    info = _wait(c, u, {30})
    assert "Nepavyko sujungti" in info["status"]["errorMessage"]
    os.remove(os.path.join(appmod.ENGINE_DATA, u, "images", "fail.txt"))
    assert c.post("/nodeodm/task/restart", data={"uuid": u}).json()["success"]
    _wait(c, u, {40})
    time.sleep(0.5)
    assert not c.splats  # „Greitas“ – be realistiško vaizdo


def test_cancel_running(client):
    c = client
    u = _new(c, "fast", files=[("a.JPG", b"1"), ("steps.txt", b"400")])
    c.post("/nodeodm/task/new/commit/" + u)
    _wait(c, u, {20})
    assert c.post("/nodeodm/task/cancel", data={"uuid": u}).json()["success"]
    assert _wait(c, u, {50})["status"]["code"] == 50


def test_upload_name_safety(client):
    c = client
    r = c.post("/nodeodm/task/new/init", data={"name": "x", "options": "[]"})
    u = r.json()["uuid"]
    for bad in ("../../etc/passwd.jpg", ".hidden.jpg", "a.exe", "x/y/../../z.sh"):
        r = c.post("/nodeodm/task/new/upload/" + u, files=[("images", (bad, io.BytesIO(b"x"), "image/jpeg"))])
        if r.status_code == 200:  # basename – kelias atmetamas, failas lieka projekto aplanke
            assert os.listdir(os.path.join(appmod.ENGINE_DATA, u, "images")) == [os.path.basename(bad)]
            assert os.path.basename(bad).lower().endswith((".jpg",))
            os.remove(os.path.join(appmod.ENGINE_DATA, u, "images", os.path.basename(bad)))
        else:
            assert r.status_code == 400
    assert c.post("/nodeodm/task/new/init", data={"name": "x"}, headers={"set-uuid": "../x"}).status_code == 400
    assert c.get("/nodeodm/task/..%2Fx/info").status_code in (400, 404)


def test_recover_requeues_running(tmp_path, monkeypatch):
    monkeypatch.setattr(appmod, "ENGINE_DATA", str(tmp_path))
    jobs = appmod.Jobs()
    jobs.start = lambda: None
    monkeypatch.setattr(appmod, "JOBS", jobs)
    u = "12345678-1234-1234-1234-123456789abc"
    os.makedirs(tmp_path / u)
    (tmp_path / u / "task.json").write_text(json.dumps({"status": 20, "committed": True}))
    appmod.recover()
    assert jobs.queue[0][:2] == ("pipeline", u) and appmod._task(u)["status"] == 10
