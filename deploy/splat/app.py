# Atea 3D Matuoklis – „Realistiškas vaizdas“ (Gaussian Splatting) paslauga. Reikia NVIDIA GPU.
# Mokoma iš baigto ODM projekto (NodeODM tomas /odm-data, tik skaityti); rezultatai – /data/<uuid>/ (scene.spz – naršyklei,
# scene.ply – archyvui, meta.json). Failus atiduoda nginx (/splat/files/…), API – tik administratoriui (portalo patikra).
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

ODM_DATA = os.environ.get("ODM_DATA", "/odm-data")
DATA = os.environ.get("SPLAT_DATA", "/data")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
HERE = os.path.dirname(os.path.abspath(__file__))

app = FastAPI()
_lock = threading.Lock()
_proc = {"uuid": None, "p": None, "kind": None}


def _status(uuid):
    try:
        st = json.load(open(os.path.join(DATA, uuid, "status.json")))
    except (OSError, ValueError):
        return None
    running = _proc["uuid"] == uuid and _proc["kind"] == "train" and _proc["p"] is not None and _proc["p"].poll() is None
    if st.get("state") in ("preparing", "training", "exporting") and not running:
        st["state"] = "error"
        st["message"] = "Mokymas nutrūko (paslauga perkrauta arba pritrūko atminties)"
        try:
            with open(os.path.join(DATA, uuid, "train.log"), encoding="utf-8", errors="replace") as f:
                tail = [l.strip() for l in f.readlines()[-30:] if l.strip()]
            err = next((l for l in reversed(tail) if "Error" in l or "error" in l), None)
            if err:
                st["message"] = err[:300]
        except OSError:
            pass
    st["uuid"] = uuid
    st["has_result"] = os.path.isfile(os.path.join(DATA, uuid, "scene.spz"))
    st["fuse"] = _fuse_status(uuid)
    return st


def _fuse_status(uuid):
    """„Sujungto modelio“ būsena (atskiras darbas po mokymo)."""
    try:
        st = json.load(open(os.path.join(DATA, uuid, "fuse_status.json")))
    except (OSError, ValueError):
        return None
    p = _proc["p"] if _proc["uuid"] == uuid and _proc["kind"] == "fuse" else None
    running = p is not None and p.poll() is None
    if st.get("state") in ("preparing", "fusing", "finishing") and not running:
        st["state"] = "error"
        code = p.returncode if p is not None else None
        where = (" (etapas: %s)" % st["message"]) if st.get("message") else ""
        st["message"] = ("Suliejimas nutrūko – pritrūko atminties%s. Sumažinkite atstumą (pvz. 20–30 m) arba "
                         "padidinkite Docker atmintį (WSL2: .wslconfig → memory)" % where if code in (-9, 137)
                         else "Suliejimas nutrūko%s (paslauga perkrauta arba pritrūko atminties)" % where)
        try:
            with open(os.path.join(DATA, uuid, "fuse.log"), encoding="utf-8", errors="replace") as f:
                tail = [l.strip() for l in f.readlines()[-40:] if l.strip()]
            err = next((l for l in reversed(tail) if "Error" in l or "error" in l), None)
            if err:
                st["message"] += ": " + err[:300]
        except OSError:
            pass
    st["has_result"] = os.path.isfile(os.path.join(DATA, uuid, "fused.glb"))
    return st


def _busy():
    return _proc["p"] is not None and _proc["p"].poll() is None


def _check(uuid):
    if not UUID.match(uuid or ""):
        raise HTTPException(400, "Neteisingas projekto ID")


@app.get("/health")
def health():
    gpu = None
    try:
        import torch
        gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    except Exception:
        pass
    return {"ok": True, "gpu": gpu, "busy": _busy(), "fuse": True}


@app.get("/jobs")
def jobs():
    out = []
    if os.path.isdir(DATA):
        for d in sorted(os.listdir(DATA)):
            if UUID.match(d):
                st = _status(d)
                if st:
                    out.append(st)
    return out


class TrainReq(BaseModel):
    uuid: str
    steps: int = 30000


@app.post("/train")
def train(r: TrainReq):
    _check(r.uuid)
    task = os.path.join(ODM_DATA, r.uuid)
    if not os.path.isfile(os.path.join(task, "opensfm", "undistorted", "reconstruction.json")):
        raise HTTPException(400, "Projekte nėra ištiesintų nuotraukų ir kamerų (ar projektas baigtas? ar nebuvo taupoma vieta diske?)")
    if not os.path.isfile(os.path.join(task, "odm_filterpoints", "point_cloud.ply")):
        raise HTTPException(400, "Projekte nėra taškų debesies (odm_filterpoints)")
    with _lock:
        if _busy():
            raise HTTPException(409, "Jau vyksta kitas darbas – palaukite, kol baigsis")
        out = os.path.join(DATA, r.uuid)
        shutil.rmtree(out, ignore_errors=True)
        os.makedirs(out)
        with open(os.path.join(out, "status.json"), "w") as f:
            json.dump({"state": "preparing", "step": 0, "steps": r.steps, "message": "Paleidžiama", "started": time.time()}, f)
        log = open(os.path.join(out, "train.log"), "w")
        steps = max(1000, min(100000, int(r.steps)))
        _proc["p"] = subprocess.Popen([sys.executable, os.path.join(HERE, "train.py"), "--task-dir", task, "--out-dir", out,
                                       "--steps", str(steps)], stdout=log, stderr=subprocess.STDOUT, cwd=HERE)
        _proc["uuid"] = r.uuid
        _proc["kind"] = "train"
    return _status(r.uuid)


class FuseReq(BaseModel):
    uuid: str
    radius: float = 0        # m aplink centrą; 0 – visas projektas
    cx: float | None = None  # ODM vietinės koordinatės; None – kamerų centras
    cy: float | None = None


@app.post("/fuse")
def fuse(r: FuseReq):
    _check(r.uuid)
    task = os.path.join(ODM_DATA, r.uuid)
    out = os.path.join(DATA, r.uuid)
    if not os.path.isfile(os.path.join(out, "scene.ply")):
        raise HTTPException(400, "Pirma sukurkite realistišką vaizdą")
    if not os.path.isfile(os.path.join(task, "opensfm", "undistorted", "reconstruction.json")):
        raise HTTPException(400, "Projekte nebėra ištiesintų nuotraukų ir kamerų")
    with _lock:
        if _busy():
            raise HTTPException(409, "Jau vyksta kitas darbas – palaukite, kol baigsis")
        for f in ("fused.glb", "fuse_status.json"):
            try:
                os.remove(os.path.join(out, f))
            except OSError:
                pass
        with open(os.path.join(out, "fuse_status.json"), "w") as f:
            json.dump({"state": "preparing", "message": "Paleidžiama", "started": time.time()}, f)
        log = open(os.path.join(out, "fuse.log"), "w")
        cmd = [sys.executable, os.path.join(HERE, "fuse.py"), "--task-dir", task, "--out-dir", out,
               "--radius", str(max(0.0, min(5000.0, float(r.radius))))]
        if r.cx is not None and r.cy is not None:
            cmd += ["--cx", str(float(r.cx)), "--cy", str(float(r.cy))]
        _proc["p"] = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, cwd=HERE)
        _proc["uuid"] = r.uuid
        _proc["kind"] = "fuse"
    return _status(r.uuid)


class UuidReq(BaseModel):
    uuid: str


@app.post("/cancel")
def cancel(r: UuidReq):
    _check(r.uuid)
    out = os.path.join(DATA, r.uuid)
    if os.path.isdir(out):
        open(os.path.join(out, "cancel"), "w").close()
    p = _proc["p"]
    if _proc["uuid"] == r.uuid and p is not None and p.poll() is None:
        p.send_signal(signal.SIGTERM)
        try:
            p.wait(30)
        except subprocess.TimeoutExpired:
            p.kill()
        st = os.path.join(out, "fuse_status.json" if _proc["kind"] == "fuse" else "status.json")
        try:
            cur = json.load(open(st))
            cur.update(state="cancelled", message="Atšaukta")
            json.dump(cur, open(st, "w"))
        except (OSError, ValueError):
            pass
    return {"ok": True}


@app.post("/delete")
def delete(r: UuidReq):
    _check(r.uuid)
    if _proc["uuid"] == r.uuid and _proc["p"] is not None and _proc["p"].poll() is None:
        raise HTTPException(409, "Pirma atšaukite vykdomą darbą")
    shutil.rmtree(os.path.join(DATA, r.uuid), ignore_errors=True)
    return {"ok": True}
