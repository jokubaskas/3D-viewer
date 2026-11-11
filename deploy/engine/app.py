# Atea variklis – GPU paslauga: nuotraukos → 3D modelis (pipeline.py) ir realistiškas vaizdas (Gaussian Splatting,
# train.py). Vienas GPU – viena darbų eilė: „Aukšta kokybė“ po modelio automatiškai apmoko ir realistišką vaizdą.
#
# API (tik administratoriui – tikrina nginx + portalas):
#   /nodeodm/…  – NodeODM suderinamas API (programos „Iš nuotraukų“ klientas jį naudoja be pakeitimų):
#                 info, options, task/new/init|upload|commit, task/<uuid>/info|output|download/all.zip,
#                 task/list, task/cancel|remove|restart
#   /health, /jobs, /train, /cancel, /delete – realistiškas vaizdas (splatai)
# Duomenys: /engine-data/<uuid>/ – projektai (images/, work/, odm_* rezultatai – ODM katalogų struktūra);
#           /data/<uuid>/ – splatai (scene.spz, scene.ply, meta.json); /odm-data – seni ODM projektai (tik skaityti).
import io
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid as uuidlib
import zipfile
from typing import List, Optional

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

ODM_DATA = os.environ.get("ODM_DATA", "/odm-data")
ENGINE_DATA = os.environ.get("ENGINE_DATA", "/engine-data")
DATA = os.environ.get("SPLAT_DATA", "/data")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SAFE_NAME = re.compile(r"^[\w\-. ()\[\]]{1,200}$", re.UNICODE)
UPLOAD_EXT = (".jpg", ".jpeg", ".tif", ".tiff", ".png", ".txt", ".geojson", ".json")
HERE = os.path.dirname(os.path.abspath(__file__))
SPLAT_STEPS_HIGH = 30000
VERSION = "1.0"

QUEUED, RUNNING, FAILED, COMPLETED, CANCELED = 10, 20, 30, 40, 50
app = FastAPI()


# ================================================================ darbų eilė (vienas GPU)
class Jobs:
    def __init__(self):
        self.lock = threading.RLock()
        self.queue = []          # [(kind, uuid, args)]
        self.cur = None          # {"kind", "uuid", "p", "started"}
        self.wake = threading.Event()
        self.thread = None

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self._loop, daemon=True)
            self.thread.start()

    def add(self, kind, uuid, args=None, front=False):
        with self.lock:
            self.queue = [j for j in self.queue if not (j[0] == kind and j[1] == uuid)]
            (self.queue.insert(0, (kind, uuid, args or {})) if front else self.queue.append((kind, uuid, args or {})))
        self.wake.set()
        self.start()

    def drop(self, uuid, kind=None):
        with self.lock:
            self.queue = [j for j in self.queue if not (j[1] == uuid and (kind is None or j[0] == kind))]

    def running(self, uuid=None, kind=None):
        with self.lock:
            c = self.cur
            if not c or (c["p"] is not None and c["p"].poll() is not None):
                return False  # p is None – darbas ką tik paleidžiamas (laikomas vykdomu)
            return (uuid is None or c["uuid"] == uuid) and (kind is None or c["kind"] == kind)

    def queued(self, uuid, kind=None):
        with self.lock:
            return any(j[1] == uuid and (kind is None or j[0] == kind) for j in self.queue)

    def busy(self):
        return self.running() or bool(self.queue)

    def stop(self, uuid, kind=None):
        """Sustabdo vykdomą darbą (SIGTERM, po 30 s – SIGKILL)."""
        with self.lock:
            c = self.cur
            if not (c and c["uuid"] == uuid and (kind is None or c["kind"] == kind)):
                return False
            p = c["p"]
        if p is not None and p.poll() is None:
            p.send_signal(signal.SIGTERM)
            try:
                p.wait(30)
            except subprocess.TimeoutExpired:
                p.kill()
        return True

    def _loop(self):
        while True:
            with self.lock:
                job = self.queue.pop(0) if self.queue else None
            if job is None:
                self.wake.wait(5)
                self.wake.clear()
                continue
            kind, uuid, args = job
            with self.lock:
                self.cur = {"kind": kind, "uuid": uuid, "p": None, "started": time.time()}
            try:
                p = (start_pipeline if kind == "pipeline" else start_splat)(uuid, args)
            except Exception as e:  # netikėta klaida paleidžiant
                _fail(kind, uuid, str(e))
                p = None
            if p is None:
                with self.lock:
                    self.cur = None
                continue
            with self.lock:
                self.cur["p"] = p
            code = p.wait()
            try:
                (finish_pipeline if kind == "pipeline" else finish_splat)(uuid, code, args)
            finally:
                with self.lock:
                    self.cur = None


JOBS = Jobs()


def _fail(kind, uuid, msg):
    if kind == "pipeline":
        _update_task(uuid, status=FAILED, errorMessage=msg)
    else:
        _write_splat_status(uuid, state="error", message=msg)


# ================================================================ fotogrametrijos projektai (NodeODM suderinama)
def _tdir(uuid):
    return os.path.join(ENGINE_DATA, uuid)


def _check(uuid):
    if not UUID.match(uuid or ""):
        raise HTTPException(400, "Neteisingas projekto ID")


def _task(uuid):
    try:
        return json.load(open(os.path.join(_tdir(uuid), "task.json")))
    except (OSError, ValueError):
        return None


def _update_task(task_id, **kw):
    t = _task(task_id) or {}
    t.update(kw)
    p = os.path.join(_tdir(task_id), "task.json")
    with open(p + ".tmp", "w") as f:
        json.dump(t, f)
    os.replace(p + ".tmp", p)
    return t


def _opt(t, name, default=None):
    for o in t.get("options", []):
        if o.get("name") == name:
            return o.get("value")
    return default


def _quality(t):
    q = str(_opt(t, "quality", "high"))
    return q if q in ("fast", "high") else "high"


def start_pipeline(uuid, args):
    t = _task(uuid)
    if not t or t.get("status") not in (QUEUED, RUNNING):
        return None
    d = _tdir(uuid)
    try:
        os.remove(os.path.join(d, "cancel"))
    except OSError:
        pass
    _update_task(uuid, status=RUNNING, startedAt=t.get("startedAt") or time.time() * 1000, errorMessage=None)
    log = open(os.path.join(d, "log.txt"), "a")
    return subprocess.Popen([sys.executable, os.path.join(HERE, "pipeline.py"), "--task-dir", d, "--quality", _quality(t)],
                            stdout=log, stderr=subprocess.STDOUT, cwd=HERE)


def finish_pipeline(uuid, code, args):
    t = _task(uuid)
    if t is None:  # pašalintas
        return
    took = t.get("processingTime", 0) + max(0, time.time() * 1000 - (t.get("startedAt") or time.time() * 1000))
    if code == 0:
        _update_task(uuid, status=COMPLETED, processingTime=took, startedAt=None, progress=100)
        if _quality(t) == "high":
            JOBS.add("splat", uuid, {"steps": SPLAT_STEPS_HIGH, "auto": True})
    elif os.path.exists(os.path.join(_tdir(uuid), "cancel")) or code == 2:
        _update_task(uuid, status=CANCELED, processingTime=took, startedAt=None)
    else:
        _update_task(uuid, status=FAILED, processingTime=took, startedAt=None, errorMessage=_last_error(uuid))


def _log_lines(uuid):
    try:
        with open(os.path.join(_tdir(uuid), "log.txt"), encoding="utf-8", errors="replace") as f:
            return f.read().splitlines()
    except OSError:
        return []


def _last_error(uuid):
    lines = _log_lines(uuid)
    for l in reversed(lines):
        if l.startswith("KLAIDA:"):
            return l[7:].strip()[:500]
    for l in reversed(lines[-50:]):
        if re.search(r"error|exception|killed", l, re.I):
            return l.strip()[:500]
    return "Apdorojimas nutrūko (pritrūko atminties arba paslauga perkrauta)"


def _progress(uuid, t):
    if t.get("status") == COMPLETED:
        return 100
    try:
        return float(json.load(open(os.path.join(_tdir(uuid), "progress.json")))["progress"])
    except (OSError, ValueError, KeyError):
        return 0


def _info(uuid):
    t = _task(uuid)
    if t is None:
        raise HTTPException(404, "Užduotis nerasta")
    st = t.get("status", QUEUED)
    if st == RUNNING and not JOBS.running(uuid, "pipeline") and not JOBS.queued(uuid, "pipeline"):
        st = FAILED  # paslauga perkrauta – grąžinama į eilę paleidžiant (recover)
    took = t.get("processingTime", 0)
    if st == RUNNING and t.get("startedAt"):
        took += time.time() * 1000 - t["startedAt"]
    imgs = os.path.join(_tdir(uuid), "images")
    return {"uuid": uuid, "name": t.get("name", ""), "dateCreated": t.get("dateCreated"), "processingTime": int(took),
            "status": {"code": st, **({"errorMessage": t["errorMessage"]} if st == FAILED and t.get("errorMessage") else {})},
            "options": t.get("options", []), "imagesCount": len(os.listdir(imgs)) if os.path.isdir(imgs) else 0,
            "progress": _progress(uuid, t), "engine": "atea", "splat": _splat_status(uuid)}


def recover():
    """Paleidus paslaugą – nebaigti projektai grąžinami į eilę (tęsiama nuo paskutinio atlikto etapo)."""
    if not os.path.isdir(ENGINE_DATA):
        return
    for d in sorted(os.listdir(ENGINE_DATA)):
        t = _task(d) if UUID.match(d) else None
        if t and t.get("status") in (QUEUED, RUNNING) and t.get("committed"):
            if t.get("status") == RUNNING:
                _update_task(d, status=QUEUED, startedAt=None)
            JOBS.add("pipeline", d)


@app.on_event("startup")
def _startup():
    os.makedirs(ENGINE_DATA, exist_ok=True)
    recover()
    JOBS.start()


@app.get("/nodeodm/info")
def odm_info():
    gpu = _gpu_name()
    with JOBS.lock:
        n = len([j for j in JOBS.queue if j[0] == "pipeline"]) + (1 if JOBS.running(kind="pipeline") else 0)
    mem = _meminfo()
    return {"version": VERSION, "engine": "atea", "engineVersion": VERSION, "odmVersion": "Atea variklis " + VERSION,
            "taskQueueCount": n, "maxParallelTasks": 1, "maxImages": None, "gpu": gpu,
            "totalMemory": mem.get("MemTotal"), "availableMemory": mem.get("MemAvailable"), "cpuCores": os.cpu_count()}


@app.get("/nodeodm/options")
def odm_options():
    return [{"name": "quality", "type": "enum", "value": "high", "domain": ["fast", "high"],
             "help": "fast – greitas; high – aukšta kokybė ir realistiškas vaizdas"}]


@app.post("/nodeodm/task/new/init")
def odm_init(name: str = Form(""), options: str = Form("[]"), outputs: Optional[str] = Form(None),
             set_uuid: Optional[str] = Header(None, alias="set-uuid")):
    uuid = set_uuid or str(uuidlib.uuid4())
    _check(uuid)
    if os.path.exists(_tdir(uuid)):
        raise HTTPException(400, "Užduotis su tokiu ID jau yra")
    try:
        opts = json.loads(options or "[]")
        assert isinstance(opts, list)
    except (ValueError, AssertionError):
        raise HTTPException(400, "Neteisingos parinktys")
    os.makedirs(os.path.join(_tdir(uuid), "images"))
    _update_task(uuid, uuid=uuid, name=name[:200], dateCreated=int(time.time() * 1000), options=opts, status=QUEUED,
                 committed=False, processingTime=0)
    return {"uuid": uuid}


def _safe_file(name):
    base = os.path.basename((name or "").replace("\\", "/"))
    if not SAFE_NAME.match(base) or base.startswith(".") or not base.lower().endswith(UPLOAD_EXT):
        raise HTTPException(400, "Netinkamas failo pavadinimas: %s" % base[:80])
    return base


@app.post("/nodeodm/task/new/upload/{uuid}")
async def odm_upload(uuid: str, images: List[UploadFile] = File(...)):
    _check(uuid)
    t = _task(uuid)
    if t is None or t.get("committed"):
        raise HTTPException(400, "Užduotis nerasta arba jau paleista")
    d = os.path.join(_tdir(uuid), "images")
    for f in images:
        dst = os.path.join(d, _safe_file(f.filename))
        with open(dst + ".part", "wb") as out:
            while True:
                chunk = await f.read(4 << 20)
                if not chunk:
                    break
                out.write(chunk)
        os.replace(dst + ".part", dst)
    return {"success": True}


@app.post("/nodeodm/task/new/commit/{uuid}")
def odm_commit(uuid: str):
    _check(uuid)
    t = _task(uuid)
    if t is None:
        raise HTTPException(404, "Užduotis nerasta")
    _update_task(uuid, committed=True, status=QUEUED)
    JOBS.add("pipeline", uuid)
    return {"uuid": uuid}


@app.get("/nodeodm/task/list")
def odm_list():
    if not os.path.isdir(ENGINE_DATA):
        return []
    return [{"uuid": d} for d in sorted(os.listdir(ENGINE_DATA)) if UUID.match(d) and _task(d)]


@app.get("/nodeodm/task/{uuid}/info")
def odm_task_info(uuid: str):
    _check(uuid)
    return _info(uuid)


@app.get("/nodeodm/task/{uuid}/output")
def odm_output(uuid: str, line: int = 0):
    _check(uuid)
    if _task(uuid) is None:
        raise HTTPException(404, "Užduotis nerasta")
    return _log_lines(uuid)[max(0, line):]


async def _form(request: Request):
    ct = request.headers.get("content-type", "")
    if "json" in ct:
        return await request.json()
    return dict(await request.form())


@app.post("/nodeodm/task/cancel")
async def odm_cancel(request: Request):
    f = await _form(request)
    uuid = f.get("uuid", "")
    _check(uuid)
    if _task(uuid) is None:
        return {"success": False, "error": "Užduotis nerasta"}
    open(os.path.join(_tdir(uuid), "cancel"), "w").close()
    JOBS.drop(uuid)
    if not JOBS.stop(uuid, "pipeline"):
        if (_task(uuid) or {}).get("status") in (QUEUED, RUNNING):
            _update_task(uuid, status=CANCELED)
    JOBS.stop(uuid, "splat")
    return {"success": True}


@app.post("/nodeodm/task/remove")
async def odm_remove(request: Request):
    f = await _form(request)
    uuid = f.get("uuid", "")
    _check(uuid)
    if _task(uuid) is None:
        return {"success": False, "error": "Užduotis nerasta"}
    JOBS.drop(uuid)
    open(os.path.join(_tdir(uuid), "cancel"), "w").close()
    JOBS.stop(uuid)
    shutil.rmtree(_tdir(uuid), ignore_errors=True)
    shutil.rmtree(os.path.join(DATA, uuid), ignore_errors=True)
    return {"success": True}


@app.post("/nodeodm/task/restart")
async def odm_restart(request: Request):
    f = await _form(request)
    uuid = f.get("uuid", "")
    _check(uuid)
    t = _task(uuid)
    if t is None:
        return {"success": False, "error": "Užduotis nerasta"}
    if JOBS.running(uuid):
        return {"success": False, "error": "Užduotis dar vykdoma"}
    kw = {"status": QUEUED, "errorMessage": None, "committed": True}
    if f.get("options"):
        try:
            opts = json.loads(f["options"])
        except ValueError:
            return {"success": False, "error": "Neteisingos parinktys"}
        # „rerun-all“ – visi etapai iš naujo (kitaip tęsiama nuo paskutinio atlikto etapo)
        if any(o.get("name") in ("rerun-all", "rerun-from") for o in opts):
            work = os.path.join(_tdir(uuid), "work")
            for n in os.listdir(work) if os.path.isdir(work) else []:
                if n.startswith(".done_"):
                    os.remove(os.path.join(work, n))
            try:
                os.remove(os.path.join(_tdir(uuid), "progress.json"))
            except OSError:
                pass
        kw["options"] = [o for o in opts if o.get("name") not in ("rerun-all", "rerun-from", "rerun")]
    _update_task(uuid, **kw)
    JOBS.add("pipeline", uuid)
    return {"success": True}


OUTPUT_DIRS = ("odm_texturing", "odm_georeferencing", "odm_orthophoto", "odm_dem", "odm_meshing", "odm_filterpoints")


class _Sink(io.RawIOBase):
    def __init__(self):
        self.buf = bytearray()

    def writable(self):
        return True

    def write(self, b):
        self.buf += b
        return len(b)


@app.get("/nodeodm/task/{uuid}/download/all.zip")
def odm_download(uuid: str):
    """Rezultatai vienu ZIP (srautu, be suspaudimo – JPEG / GLB / LAZ / COG jau suspausti)."""
    _check(uuid)
    t = _task(uuid)
    if t is None or t.get("status") != COMPLETED:
        raise HTTPException(404, "Rezultatų dar nėra")
    d = _tdir(uuid)
    files = []
    for sub in OUTPUT_DIRS:
        for root, _, names in os.walk(os.path.join(d, sub)):
            for n in sorted(names):
                if not n.endswith((".tmp", ".part")):
                    p = os.path.join(root, n)
                    files.append((p, os.path.relpath(p, d)))

    def gen():
        sink = _Sink()
        with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
            for p, arc in files:
                with open(p, "rb") as src, z.open(arc, "w", force_zip64=True) as dst:
                    while True:
                        chunk = src.read(1 << 20)
                        if not chunk:
                            break
                        dst.write(chunk)
                        if len(sink.buf) >= 4 << 20:
                            yield bytes(sink.buf)
                            sink.buf.clear()
        yield bytes(sink.buf)

    return StreamingResponse(gen(), media_type="application/zip",
                             headers={"Content-Disposition": 'attachment; filename="all.zip"'})


# ================================================================ realistiškas vaizdas (splatai)
def _source_dir(uuid):
    """Projektas: naujas variklis (/engine-data) arba senas ODM (/odm-data)."""
    e = _tdir(uuid)
    return e if os.path.isdir(e) else os.path.join(ODM_DATA, uuid)


def _write_splat_status(uuid, **kw):
    out = os.path.join(DATA, uuid)
    os.makedirs(out, exist_ok=True)
    p = os.path.join(out, "status.json")
    try:
        cur = json.load(open(p))
    except (OSError, ValueError):
        cur = {}
    cur.update(kw)
    with open(p + ".tmp", "w") as f:
        json.dump(cur, f)
    os.replace(p + ".tmp", p)


def _splat_status(uuid):
    try:
        st = json.load(open(os.path.join(DATA, uuid, "status.json")))
    except (OSError, ValueError):
        return None
    if st.get("state") in ("preparing", "training", "exporting") and not JOBS.running(uuid, "splat"):
        if JOBS.queued(uuid, "splat"):
            st["state"] = "queued"
        else:
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
    return st


def start_splat(uuid, args):
    task = _source_dir(uuid)
    out = os.path.join(DATA, uuid)
    steps = max(1000, min(100000, int(args.get("steps", SPLAT_STEPS_HIGH))))
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    _write_splat_status(uuid, state="preparing", step=0, steps=steps, message="Paleidžiama", started=time.time(),
                        auto=bool(args.get("auto")))
    log = open(os.path.join(out, "train.log"), "w")
    return subprocess.Popen([sys.executable, os.path.join(HERE, "train.py"), "--task-dir", task, "--out-dir", out,
                             "--steps", str(steps)], stdout=log, stderr=subprocess.STDOUT, cwd=HERE)


def finish_splat(uuid, code, args):
    st = _splat_status(uuid) or {}
    if code != 0 and st.get("state") not in ("done", "cancelled", "error"):
        _write_splat_status(uuid, state="cancelled" if os.path.exists(os.path.join(DATA, uuid, "cancel")) else "error",
                            message="Atšaukta" if os.path.exists(os.path.join(DATA, uuid, "cancel")) else
                            "Mokymas nutrūko (kodas %s)" % code)


def _gpu_name():
    try:
        import torch
        return torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    except Exception:
        return None


def _meminfo():
    out = {}
    try:
        for line in open("/proc/meminfo"):
            k, v = line.split(":", 1)
            out[k] = int(v.split()[0]) * 1024
    except (OSError, ValueError):
        pass
    return out


@app.get("/health")
def health():
    return {"ok": True, "gpu": _gpu_name(), "busy": JOBS.busy(), "engine": VERSION}


@app.get("/jobs")
def jobs():
    out = []
    if os.path.isdir(DATA):
        for d in sorted(os.listdir(DATA)):
            if UUID.match(d):
                st = _splat_status(d)
                if st:
                    out.append(st)
    return out


class TrainReq(BaseModel):
    uuid: str
    steps: int = SPLAT_STEPS_HIGH


@app.post("/train")
def train(r: TrainReq):
    _check(r.uuid)
    task = _source_dir(r.uuid)
    if not os.path.isfile(os.path.join(task, "opensfm", "undistorted", "reconstruction.json")):
        raise HTTPException(400, "Projekte nėra ištiesintų nuotraukų ir kamerų (ar projektas baigtas?)")
    if not os.path.isfile(os.path.join(task, "odm_filterpoints", "point_cloud.ply")):
        raise HTTPException(400, "Projekte nėra taškų debesies (odm_filterpoints)")
    if JOBS.running(r.uuid, "splat") or JOBS.queued(r.uuid, "splat"):
        raise HTTPException(409, "Šio projekto realistiškas vaizdas jau mokomas")
    _write_splat_status(r.uuid, state="preparing", step=0, steps=r.steps, message="Eilėje", started=time.time())
    JOBS.add("splat", r.uuid, {"steps": r.steps})
    return _splat_status(r.uuid)


class UuidReq(BaseModel):
    uuid: str


@app.post("/cancel")
def cancel(r: UuidReq):
    _check(r.uuid)
    out = os.path.join(DATA, r.uuid)
    if os.path.isdir(out):
        open(os.path.join(out, "cancel"), "w").close()
    JOBS.drop(r.uuid, "splat")
    JOBS.stop(r.uuid, "splat")
    if os.path.isfile(os.path.join(out, "status.json")):
        st = _splat_status(r.uuid) or {}
        if st.get("state") not in ("done",):
            _write_splat_status(r.uuid, state="cancelled", message="Atšaukta")
    return {"ok": True}


@app.post("/delete")
def delete(r: UuidReq):
    _check(r.uuid)
    if JOBS.running(r.uuid, "splat"):
        raise HTTPException(409, "Pirma atšaukite mokymą")
    JOBS.drop(r.uuid, "splat")
    shutil.rmtree(os.path.join(DATA, r.uuid), ignore_errors=True)
    return {"ok": True}
