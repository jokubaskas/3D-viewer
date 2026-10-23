"""Atea 3D Matuoklis – portalas: paskyros, prieigos teisės ir klientams priskirti duomenys.

Vaidmenys:
  admin  – visos programos funkcijos (ODM, AI mokymas, transliacijų serveris, klientų valdymas);
  client – tik jam priskirti duomenys: 3D modeliai, gyvos transliacijos, ataskaitos, įrašai.

Saugumas:
  * slaptažodžiai – scrypt (druska kiekvienam), sesijos ir kvietimų raktai DB saugomi tik kaip SHA-256;
  * sesijos slapukas HttpOnly, SameSite=Strict, Secure (per HTTPS); keičiančioms užklausoms būtina antraštė X-Atea
    (kitos svetainės jos atsiųsti negali – CSRF apsauga);
  * prisijungimo bandymai ribojami (el. paštui ir IP);
  * visi kiti serverio keliai (/odm/, /ai/, /live/, /ext/) tikrinami per nginx auth_request → /api/auth/check;
  * failai atiduodami tik pagal DB įrašą (ne pagal kelią), tik savininkui (admin) ar priskirtam klientui.

Paleidimas: uvicorn app:app;  administratoriaus kvietimas: python app.py create-admin el@pastas.lt "Vardas"
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import unicodedata
import urllib.request
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse

DATA = Path(os.environ.get("PORTAL_DATA", "/data"))
FILES = DATA / "files"
DB_PATH = DATA / "portal.db"
PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://localhost:8080").rstrip("/")
MEDIAMTX_API = os.environ.get("MEDIAMTX_API", "http://mediamtx:9997")
SESSION_DAYS = float(os.environ.get("SESSION_DAYS", "14"))
INVITE_DAYS = 7
COOKIE = "atea_sess"
KINDS = {"model", "stream", "report", "recording"}
MIN_PW = 10

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_db_lock = threading.Lock()


# --------------------------------------------------------------------------- DB
@contextmanager
def db():
    con = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    try:
        yield con
    finally:
        con.close()


def init_db():
    DATA.mkdir(parents=True, exist_ok=True)
    FILES.mkdir(parents=True, exist_ok=True)
    with db() as con:
        con.execute("PRAGMA journal_mode=WAL")
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS users(
              id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '',
              role TEXT NOT NULL CHECK(role IN ('admin','client')), pw TEXT, created REAL NOT NULL,
              disabled INTEGER NOT NULL DEFAULT 0, invite_hash TEXT, invite_exp REAL, last_login REAL);
            CREATE TABLE IF NOT EXISTS sessions(
              hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              created REAL NOT NULL, expires REAL NOT NULL, ip TEXT, ua TEXT);
            CREATE TABLE IF NOT EXISTS items(
              id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
              created REAL NOT NULL, updated REAL NOT NULL, meta TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS files(
              id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
              name TEXT NOT NULL, disk TEXT NOT NULL, size INTEGER NOT NULL, created REAL NOT NULL,
              UNIQUE(item_id, name));
            CREATE TABLE IF NOT EXISTS assign(
              item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(item_id, user_id));
            CREATE TABLE IF NOT EXISTS fails(key TEXT PRIMARY KEY, count INTEGER NOT NULL, until REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at REAL NOT NULL, user_id INTEGER, ip TEXT,
              action TEXT NOT NULL, detail TEXT);
            """
        )


def audit(con, user_id, ip, action, detail=""):
    con.execute("INSERT INTO audit(at,user_id,ip,action,detail) VALUES(?,?,?,?,?)", (time.time(), user_id, ip, action, str(detail)[:500]))


# --------------------------------------------------------------------------- slaptažodžiai ir raktai
def hash_pw(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**15, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)
    return f"scrypt$15$8$1${salt.hex()}${h.hex()}"


def check_pw(pw: str, stored: str | None) -> bool:
    if not stored:
        # Vienodas laikas, kad nebūtų galima atspėti, kurie el. paštai egzistuoja
        hashlib.scrypt(pw.encode(), salt=b"x" * 16, n=2**15, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)
        return False
    try:
        _, n, r, p, salt, h = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2 ** int(n), r=int(r), p=int(p), maxmem=64 * 1024 * 1024, dklen=32)
        return hmac.compare_digest(got.hex(), h)
    except Exception:  # noqa: BLE001
        return False


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def pw_problem(pw: str) -> str | None:
    if len(pw) < MIN_PW:
        return f"Slaptažodis per trumpas – bent {MIN_PW} simbolių"
    if len(pw) > 256:
        return "Slaptažodis per ilgas"
    if len(set(pw)) < 5:
        return "Slaptažodis per paprastas"
    return None


def new_invite(con, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    con.execute("UPDATE users SET invite_hash=?, invite_exp=? WHERE id=?", (sha(token), time.time() + INVITE_DAYS * 86400, user_id))
    return f"{PUBLIC_URL}/#invite={token}"


# --------------------------------------------------------------------------- užklausos
def client_ip(req: Request) -> str:
    return req.headers.get("cf-connecting-ip") or req.headers.get("x-real-ip") or (req.client.host if req.client else "")


def is_https(req: Request) -> bool:
    return req.headers.get("x-forwarded-proto", "").lower() == "https" or req.url.scheme == "https"


def current_user(req: Request, con) -> sqlite3.Row | None:
    tok = req.cookies.get(COOKIE)
    if not tok or len(tok) > 200:
        return None
    row = con.execute(
        "SELECT u.*, s.expires AS s_exp, s.hash AS s_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=?",
        (sha(tok),),
    ).fetchone()
    if not row or row["s_exp"] < time.time() or row["disabled"]:
        return None
    # Slenkantis galiojimas: aktyvi sesija pratęsiama (ne dažniau kaip kartą per valandą)
    if row["s_exp"] - time.time() < SESSION_DAYS * 86400 - 3600:
        con.execute("UPDATE sessions SET expires=? WHERE hash=?", (time.time() + SESSION_DAYS * 86400, row["s_hash"]))
    return row


def need_user(req: Request, con, admin=False) -> sqlite3.Row:
    u = current_user(req, con)
    if not u:
        raise HTTPException(401, "Prisijunkite")
    if admin and u["role"] != "admin":
        raise HTTPException(403, "Tik administratoriui")
    return u


@app.middleware("http")
async def csrf_and_headers(req: Request, call_next):
    # Keičiančios užklausos – tik su mūsų antrašte (kitų svetainių formos / skriptai jos atsiųsti negali)
    if req.method not in ("GET", "HEAD", "OPTIONS") and req.url.path.startswith("/api/") and req.headers.get("x-atea") != "1":
        return JSONResponse({"detail": "Užklausa atmesta"}, status_code=403)
    res = await call_next(req)
    res.headers["Cache-Control"] = res.headers.get("Cache-Control", "no-store")
    res.headers["X-Content-Type-Options"] = "nosniff"
    return res


def user_json(u) -> dict:
    return {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"]}


# --------------------------------------------------------------------------- prisijungimas
def throttle(con, keys: list[str]):
    now = time.time()
    for k in keys:
        r = con.execute("SELECT * FROM fails WHERE key=?", (k,)).fetchone()
        if r and r["until"] > now:
            raise HTTPException(429, f"Per daug bandymų – pabandykite po {int(r['until'] - now) // 60 + 1} min.")


def fail(con, keys: list[str]):
    now = time.time()
    for k in keys:
        r = con.execute("SELECT * FROM fails WHERE key=?", (k,)).fetchone()
        c = (r["count"] if r and r["until"] > now - 3600 else 0) + 1
        # 5 nesėkmės – 1 min., toliau dvigubinama (iki 1 val.); IP – švelniau
        lim = 20 if k.startswith("ip:") else 5
        until = now + min(3600, 60 * 2 ** (c - lim)) if c >= lim else now
        con.execute("INSERT OR REPLACE INTO fails(key,count,until) VALUES(?,?,?)", (k, c, until))


def start_session(con, req: Request, res: Response, user_id: int):
    tok = secrets.token_urlsafe(32)
    now = time.time()
    con.execute("INSERT INTO sessions(hash,user_id,created,expires,ip,ua) VALUES(?,?,?,?,?,?)", (sha(tok), user_id, now, now + SESSION_DAYS * 86400, client_ip(req), req.headers.get("user-agent", "")[:200]))
    con.execute("UPDATE users SET last_login=? WHERE id=?", (now, user_id))
    con.execute("DELETE FROM sessions WHERE expires<?", (now,))
    res.set_cookie(COOKIE, tok, max_age=int(SESSION_DAYS * 86400), httponly=True, samesite="strict", secure=is_https(req), path="/")


@app.post("/api/auth/login")
async def login(req: Request):
    body = await req.json()
    email = str(body.get("email", "")).strip().lower()[:200]
    pw = str(body.get("password", ""))[:256]
    ip = client_ip(req)
    with _db_lock, db() as con:
        keys = [f"email:{email}", f"ip:{ip}"]
        throttle(con, keys)
        u = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if not check_pw(pw, u["pw"] if u else None) or u["disabled"]:
            fail(con, keys)
            audit(con, u["id"] if u else None, ip, "login_fail", email)
            raise HTTPException(401, "Neteisingas el. paštas arba slaptažodis")
        con.execute("DELETE FROM fails WHERE key=?", (f"email:{email}",))
        res = JSONResponse(user_json(u))
        start_session(con, req, res, u["id"])
        audit(con, u["id"], ip, "login")
        return res


@app.post("/api/auth/logout")
def logout(req: Request):
    tok = req.cookies.get(COOKIE)
    with db() as con:
        if tok:
            con.execute("DELETE FROM sessions WHERE hash=?", (sha(tok),))
    res = JSONResponse({"ok": True})
    res.delete_cookie(COOKIE, path="/")
    return res


@app.get("/api/me")
def me(req: Request):
    with db() as con:
        return user_json(need_user(req, con))


@app.post("/api/me/password")
async def change_pw(req: Request):
    body = await req.json()
    with _db_lock, db() as con:
        u = need_user(req, con)
        if not check_pw(str(body.get("current", "")), u["pw"]):
            raise HTTPException(400, "Neteisingas dabartinis slaptažodis")
        new = str(body.get("password", ""))
        if (p := pw_problem(new)) is not None:
            raise HTTPException(400, p)
        con.execute("UPDATE users SET pw=?, invite_hash=NULL, invite_exp=NULL WHERE id=?", (hash_pw(new), u["id"]))
        # Kitos sesijos (pvz. kitame kompiuteryje) atjungiamos
        con.execute("DELETE FROM sessions WHERE user_id=? AND hash<>?", (u["id"], u["s_hash"]))
        audit(con, u["id"], client_ip(req), "password_change")
        return {"ok": True}


def invite_user(con, token: str):
    if not token or len(token) > 200:
        return None
    u = con.execute("SELECT * FROM users WHERE invite_hash=?", (sha(token),)).fetchone()
    return u if u and u["invite_exp"] and u["invite_exp"] > time.time() and not u["disabled"] else None


@app.get("/api/auth/invite")
def invite_info(token: str, req: Request):
    with db() as con:
        throttle(con, [f"ip:{client_ip(req)}"])
        u = invite_user(con, token)
        if not u:
            fail(con, [f"ip:{client_ip(req)}"])
            raise HTTPException(404, "Nuoroda negalioja arba pasibaigė – paprašykite naujos")
        return {"email": u["email"], "name": u["name"]}


@app.post("/api/auth/invite")
async def invite_accept(req: Request):
    body = await req.json()
    with _db_lock, db() as con:
        u = invite_user(con, str(body.get("token", "")))
        if not u:
            raise HTTPException(404, "Nuoroda negalioja arba pasibaigė – paprašykite naujos")
        pw = str(body.get("password", ""))
        if (p := pw_problem(pw)) is not None:
            raise HTTPException(400, p)
        con.execute("UPDATE users SET pw=?, invite_hash=NULL, invite_exp=NULL WHERE id=?", (hash_pw(pw), u["id"]))
        con.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))
        res = JSONResponse(user_json(u))
        start_session(con, req, res, u["id"])
        audit(con, u["id"], client_ip(req), "invite_accepted")
        return res


# --------------------------------------------------------------------------- nginx auth_request
ADMIN_ONLY = re.compile(r"^/(odm/|live/api/|ext/|ai/train|ai/models/(active|delete))")
STREAM_PATH = re.compile(r"^/live/(?:webrtc|hls)/([A-Za-z0-9_-]+)(?:/|$)")
SAFE_PATH = re.compile(r"^/[A-Za-z0-9._~/-]*$")


def clean_path(uri: str) -> str | None:
    """Kelias iš X-Original-URI (nginx $request_uri – neapdorotas). nginx vietą (location) parenka pagal
    normalizuotą kelią (%XX iškoduoti, „..“ išspręsti, „//“ sujungti), todėl tokie keliai atmetami: kitaip
    /ai/../odm/… ar /ai/%74rain patikrą praeitų kaip /ai/…, o nginx juos nukreiptų kitur."""
    path = uri.split("?", 1)[0].split("#", 1)[0]
    if not SAFE_PATH.match(path) or "//" in path or any(seg in (".", "..") for seg in path.split("/")):
        return None
    return path


def allowed_paths(con, user_id: int) -> set[str]:
    rows = con.execute("SELECT i.id, i.meta FROM items i JOIN assign a ON a.item_id=i.id WHERE a.user_id=? AND i.kind='stream'", (user_id,)).fetchall()
    out = set()
    for r in rows:
        out.add(f"item-{r['id']}")
        p = json.loads(r["meta"] or "{}").get("path")
        if p:
            out.add(p)
    return out


@app.get("/api/auth/check")
def auth_check(req: Request):
    """nginx: ar šiam vartotojui leidžiama užklausa X-Original-URI. 204 – taip, 401 / 403 – ne."""
    uri = req.headers.get("x-original-uri", "/")
    with db() as con:
        u = current_user(req, con)
        if not u:
            return Response(status_code=401)
        if u["role"] == "admin":
            return Response(status_code=204)
        uri = clean_path(uri)
        if uri is None or ADMIN_ONLY.match(uri):
            return Response(status_code=403)
        m = STREAM_PATH.match(uri)
        if m:
            return Response(status_code=204 if m.group(1) in allowed_paths(con, u["id"]) else 403)
        if uri.startswith("/ai/"):
            return Response(status_code=204)  # AI aptikimas transliacijoje (klientas gali keisti, ką atpažinti)
        return Response(status_code=403)


# --------------------------------------------------------------------------- vartotojai (admin)
@app.get("/api/users")
def users_list(req: Request):
    with db() as con:
        need_user(req, con, admin=True)
        rows = con.execute("SELECT * FROM users ORDER BY role, name, email").fetchall()
        return [
            {**user_json(r), "disabled": bool(r["disabled"]), "created": r["created"], "last_login": r["last_login"], "invited": bool(r["invite_hash"]) and not r["pw"], "has_password": bool(r["pw"])}
            for r in rows
        ]


EMAIL_RE = re.compile(r"^[^@\s]{1,100}@[^@\s]{1,100}\.[^@\s]{2,20}$")


@app.post("/api/users")
async def users_create(req: Request):
    body = await req.json()
    email = str(body.get("email", "")).strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Neteisingas el. paštas")
    role = body.get("role", "client")
    if role not in ("admin", "client"):
        raise HTTPException(400, "Neteisingas vaidmuo")
    with _db_lock, db() as con:
        a = need_user(req, con, admin=True)
        if con.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            raise HTTPException(409, "Toks el. paštas jau yra")
        cur = con.execute("INSERT INTO users(email,name,role,created) VALUES(?,?,?,?)", (email, str(body.get("name", "")).strip()[:120], role, time.time()))
        link = new_invite(con, cur.lastrowid)
        audit(con, a["id"], client_ip(req), "user_create", f"{email} {role}")
        return {"id": cur.lastrowid, "invite": link}


@app.patch("/api/users/{uid}")
async def users_update(uid: int, req: Request):
    body = await req.json()
    with _db_lock, db() as con:
        a = need_user(req, con, admin=True)
        u = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not u:
            raise HTTPException(404, "Nėra")
        if uid == a["id"] and (body.get("disabled") or body.get("role", "admin") != "admin"):
            raise HTTPException(400, "Savo paskyros išjungti ar paversti klientu negalima")
        name = str(body.get("name", u["name"]))[:120]
        disabled = int(bool(body.get("disabled", u["disabled"])))
        role = body.get("role", u["role"])
        if role not in ("admin", "client"):
            raise HTTPException(400, "Neteisingas vaidmuo")
        con.execute("UPDATE users SET name=?, disabled=?, role=? WHERE id=?", (name, disabled, role, uid))
        if disabled:
            con.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        audit(con, a["id"], client_ip(req), "user_update", f"{uid} {body}")
        return {"ok": True}


@app.post("/api/users/{uid}/invite")
def users_reinvite(uid: int, req: Request):
    with _db_lock, db() as con:
        a = need_user(req, con, admin=True)
        if not con.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
            raise HTTPException(404, "Nėra")
        link = new_invite(con, uid)
        audit(con, a["id"], client_ip(req), "user_invite", uid)
        return {"invite": link}


@app.delete("/api/users/{uid}")
def users_delete(uid: int, req: Request):
    with _db_lock, db() as con:
        a = need_user(req, con, admin=True)
        if uid == a["id"]:
            raise HTTPException(400, "Savo paskyros ištrinti negalima")
        con.execute("DELETE FROM users WHERE id=?", (uid,))
        audit(con, a["id"], client_ip(req), "user_delete", uid)
        return {"ok": True}


# --------------------------------------------------------------------------- duomenys (items)
def item_json(con, r, admin: bool) -> dict:
    files = con.execute("SELECT id,name,size,created FROM files WHERE item_id=? ORDER BY name", (r["id"],)).fetchall()
    meta = json.loads(r["meta"] or "{}")
    out = {
        "id": r["id"],
        "kind": r["kind"],
        "title": r["title"],
        "note": r["note"],
        "created": r["created"],
        "updated": r["updated"],
        "files": [dict(f) for f in files],
        "size": sum(f["size"] for f in files),
        # Klientui – tik vieši nustatymai (be šaltinio adreso ir raktų)
        "public": meta.get("public", {}),
    }
    if admin:
        out["meta"] = meta
        out["clients"] = [x["user_id"] for x in con.execute("SELECT user_id FROM assign WHERE item_id=?", (r["id"],))]
    return out


def get_item(con, u, iid: int) -> sqlite3.Row:
    r = con.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
    if not r:
        raise HTTPException(404, "Nėra")
    if u["role"] != "admin" and not con.execute("SELECT 1 FROM assign WHERE item_id=? AND user_id=?", (iid, u["id"])).fetchone():
        raise HTTPException(404, "Nėra")  # svetimų duomenų buvimas neatskleidžiamas
    return r


@app.get("/api/items")
def items_list(req: Request, kind: str = ""):
    with db() as con:
        u = need_user(req, con)
        q, args = "SELECT i.* FROM items i", []
        conds = []
        if u["role"] != "admin":
            q += " JOIN assign a ON a.item_id=i.id"
            conds.append("a.user_id=?")
            args.append(u["id"])
        if kind:
            conds.append("i.kind=?")
            args.append(kind)
        if conds:
            q += " WHERE " + " AND ".join(conds)
        q += " ORDER BY i.updated DESC"
        return [item_json(con, r, u["role"] == "admin") for r in con.execute(q, args).fetchall()]


@app.post("/api/items")
async def items_create(req: Request):
    body = await req.json()
    kind = body.get("kind")
    if kind not in KINDS:
        raise HTTPException(400, "Neteisingas tipas")
    with _db_lock, db() as con:
        a = need_user(req, con, admin=True)
        now = time.time()
        cur = con.execute(
            "INSERT INTO items(kind,title,note,created,updated,meta) VALUES(?,?,?,?,?,?)",
            (kind, str(body.get("title", "")).strip()[:200] or "Be pavadinimo", str(body.get("note", ""))[:2000], now, now, json.dumps(body.get("meta") or {})),
        )
        iid = cur.lastrowid
        set_clients(con, iid, body.get("clients") or [])
        audit(con, a["id"], client_ip(req), "item_create", f"{iid} {kind}")
        return item_json(con, con.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone(), True)


def set_clients(con, iid: int, ids):
    con.execute("DELETE FROM assign WHERE item_id=?", (iid,))
    for uid in {int(x) for x in ids}:
        if con.execute("SELECT 1 FROM users WHERE id=? AND role='client'", (uid,)).fetchone():
            con.execute("INSERT INTO assign(item_id,user_id) VALUES(?,?)", (iid, uid))


@app.patch("/api/items/{iid}")
async def items_update(iid: int, req: Request):
    body = await req.json()
    with _db_lock, db() as con:
        a = need_user(req, con, admin=True)
        r = get_item(con, a, iid)
        title = str(body.get("title", r["title"])).strip()[:200] or r["title"]
        note = str(body.get("note", r["note"]))[:2000]
        meta = json.dumps(body["meta"]) if "meta" in body else r["meta"]
        con.execute("UPDATE items SET title=?, note=?, meta=?, updated=? WHERE id=?", (title, note, meta, time.time(), iid))
        if "clients" in body:
            set_clients(con, iid, body["clients"])
        audit(con, a["id"], client_ip(req), "item_update", iid)
        return item_json(con, con.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone(), True)


@app.delete("/api/items/{iid}")
def items_delete(iid: int, req: Request):
    with _db_lock, db() as con:
        a = need_user(req, con, admin=True)
        get_item(con, a, iid)
        for f in con.execute("SELECT disk FROM files WHERE item_id=?", (iid,)).fetchall():
            (FILES / f["disk"]).unlink(missing_ok=True)
        con.execute("DELETE FROM items WHERE id=?", (iid,))
        audit(con, a["id"], client_ip(req), "item_delete", iid)
    mtx_delete(f"item-{iid}")
    return {"ok": True}


def safe_name(name: str) -> str:
    """Failo vardas (gali būti su aplankais – OBJ + tekstūros): be „..“, absoliučių kelių ir valdymo simbolių."""
    name = unicodedata.normalize("NFC", str(name)).replace("\\", "/")
    parts = [re.sub(r"[\x00-\x1f<>:\"|?*]", "_", p).strip() for p in name.split("/")]
    parts = [p for p in parts if p and p not in (".", "..")]
    out = "/".join(parts)[:300]
    if not out:
        raise HTTPException(400, "Neteisingas failo vardas")
    return out


@app.put("/api/items/{iid}/files")
async def files_upload(iid: int, name: str, req: Request):
    """Failas siunčiamas kaip užklausos turinys (be multipart) – tinka ir keliems GB."""
    fname = safe_name(name)
    with db() as con:
        a = need_user(req, con, admin=True)
        get_item(con, a, iid)
    disk = f"{iid}/{secrets.token_hex(12)}"
    path = FILES / disk
    path.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    try:
        with open(path, "wb") as f:
            async for chunk in req.stream():
                f.write(chunk)
                size += len(chunk)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    with _db_lock, db() as con:
        if not con.execute("SELECT 1 FROM items WHERE id=?", (iid,)).fetchone():  # ištrintas įkeliant
            path.unlink(missing_ok=True)
            raise HTTPException(404, "Nėra")
        old = con.execute("SELECT disk FROM files WHERE item_id=? AND name=?", (iid, fname)).fetchone()
        if old:
            (FILES / old["disk"]).unlink(missing_ok=True)
            con.execute("DELETE FROM files WHERE item_id=? AND name=?", (iid, fname))
        cur = con.execute("INSERT INTO files(item_id,name,disk,size,created) VALUES(?,?,?,?,?)", (iid, fname, disk, size, time.time()))
        con.execute("UPDATE items SET updated=? WHERE id=?", (time.time(), iid))
        audit(con, a["id"], client_ip(req), "file_upload", f"{iid} {fname} {size}")
        return {"id": cur.lastrowid, "name": fname, "size": size}


@app.delete("/api/items/{iid}/files/{fid}")
def files_delete(iid: int, fid: int, req: Request):
    with _db_lock, db() as con:
        a = need_user(req, con, admin=True)
        f = con.execute("SELECT * FROM files WHERE id=? AND item_id=?", (fid, iid)).fetchone()
        if not f:
            raise HTTPException(404, "Nėra")
        (FILES / f["disk"]).unlink(missing_ok=True)
        con.execute("DELETE FROM files WHERE id=?", (fid,))
        audit(con, a["id"], client_ip(req), "file_delete", f"{iid} {f['name']}")
        return {"ok": True}


@app.get("/api/items/{iid}/files/{fid}/{name:path}")
def files_get(iid: int, fid: int, name: str, req: Request, download: int = 0):
    with db() as con:
        u = need_user(req, con)
        get_item(con, u, iid)
        f = con.execute("SELECT * FROM files WHERE id=? AND item_id=?", (fid, iid)).fetchone()
        if not f:
            raise HTTPException(404, "Nėra")
        if u["role"] != "admin":
            audit(con, u["id"], client_ip(req), "file_get", f"{iid} {f['name']}")
    base = f["name"].split("/")[-1]
    ext = base.rsplit(".", 1)[-1].lower() if "." in base else ""
    # Naršyklėje atidaromi tik saugūs tipai; HTML, SVG ir kt. – tik atsisiunčiami (kitaip jų skriptai veiktų
    # mūsų svetainės vardu su vartotojo sesija)
    inline = not download and ext in INLINE
    res = FileResponse(FILES / f["disk"], filename=base, media_type=INLINE.get(ext) if inline else "application/octet-stream", content_disposition_type="inline" if inline else "attachment")
    res.headers["Cache-Control"] = "private, no-store"
    res.headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'"
    return res


INLINE = {
    "pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
    "mp4": "video/mp4", "webm": "video/webm", "txt": "text/plain; charset=utf-8", "csv": "text/plain; charset=utf-8",
}


# --------------------------------------------------------------------------- transliacijos klientams
def mtx(path: str, body: dict | None = None, method: str = "GET"):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"{MEDIAMTX_API}/v3/{path}", data=data, method=method, headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(r, timeout=5) as resp:
        txt = resp.read()
        return json.loads(txt) if txt else None


def mtx_delete(name: str):
    try:
        mtx(f"config/paths/delete/{name}", method="DELETE")
    except Exception:  # noqa: BLE001
        pass


@app.post("/api/items/{iid}/play")
def items_play(iid: int, req: Request):
    """Paruošia transliaciją serveryje (šaltinis ir jo raktai lieka serveryje – klientas gauna tik kelią)."""
    with db() as con:
        u = need_user(req, con)
        r = get_item(con, u, iid)
    if r["kind"] != "stream":
        raise HTTPException(400, "Ne transliacija")
    meta = json.loads(r["meta"] or "{}")
    if meta.get("path"):
        return {"path": meta["path"]}
    src = meta.get("source") or {}
    if not src.get("url"):
        raise HTTPException(400, "Transliacijai nenurodytas šaltinis")
    name = f"item-{iid}"
    conf = {"source": src["url"], "sourceOnDemand": True, "sourceOnDemandStartTimeout": "8s", "sourceOnDemandCloseAfter": "20s", "rtspTransport": "tcp", **(src.get("extra") or {})}
    try:
        cur = None
        try:
            cur = mtx(f"config/paths/get/{name}")
        except Exception:  # noqa: BLE001
            pass
        if not cur or cur.get("source") != conf["source"] or (cur.get("whepBearerToken") or "") != (conf.get("whepBearerToken") or ""):
            mtx(f"config/paths/replace/{name}", conf, "POST")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Transliacijų serveris nepasiekiamas: {e}") from e
    return {"path": name}


@app.get("/api/health")
def health():
    with db() as con:
        n = con.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND pw IS NOT NULL").fetchone()[0]
    return {"ok": True, "admins": n}


init_db()


# --------------------------------------------------------------------------- komandinė eilutė
def cli():
    if len(sys.argv) >= 3 and sys.argv[1] == "create-admin":
        email = sys.argv[2].strip().lower()
        name = sys.argv[3] if len(sys.argv) > 3 else ""
        if not EMAIL_RE.match(email):
            sys.exit("Neteisingas el. paštas")
        with db() as con:
            u = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            if u:
                con.execute("UPDATE users SET role='admin', disabled=0 WHERE id=?", (u["id"],))
                uid = u["id"]
            else:
                uid = con.execute("INSERT INTO users(email,name,role,created) VALUES(?,?,?,?)", (email, name, "admin", time.time())).lastrowid
            link = new_invite(con, uid)
            audit(con, None, "cli", "admin_invite", email)
        print(f"\nAdministratorius: {email}\nAtidarykite šią nuorodą ir nusistatykite slaptažodį (galioja {INVITE_DAYS} d.):\n\n  {link}\n")
    else:
        print('Naudojimas: python app.py create-admin el@pastas.lt "Vardas Pavardė"')


if __name__ == "__main__":
    cli()
