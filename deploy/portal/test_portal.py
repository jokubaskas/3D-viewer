"""Portalo saugumo ir veikimo testai: python -m pytest deploy/portal/test_portal.py (reikia fastapi, httpx, pytest)."""
import importlib
import os
import sys
import tempfile
from pathlib import Path

import pytest

H = {"X-Atea": "1"}


@pytest.fixture()
def env(monkeypatch):
    d = tempfile.mkdtemp()
    monkeypatch.setenv("PORTAL_DATA", d)
    sys.path.insert(0, str(Path(__file__).parent))
    sys.modules.pop("app", None)
    app = importlib.import_module("app")
    from fastapi.testclient import TestClient

    def client():
        return TestClient(app.app, base_url="http://testserver")

    # Administratorius per CLI kvietimą
    with app.db() as con:
        uid = con.execute("INSERT INTO users(email,name,role,created) VALUES('admin@a.lt','Admin','admin',0)").lastrowid
        link = app.new_invite(con, uid)
    adm = client()
    tok = link.split("#invite=")[1]
    r = adm.post("/api/auth/invite", json={"token": tok, "password": "Labai-slaptas-1"}, headers=H)
    assert r.status_code == 200, r.text
    return app, client, adm


def make_client(adm, client, email, pw="Kliento-slaptas-1"):
    r = adm.post("/api/users", json={"email": email, "name": email, "role": "client"}, headers=H)
    assert r.status_code == 200, r.text
    c = client()
    tok = r.json()["invite"].split("#invite=")[1]
    assert c.post("/api/auth/invite", json={"token": tok, "password": pw}, headers=H).status_code == 200
    # Kvietimas vienkartinis
    assert c.post("/api/auth/invite", json={"token": tok, "password": pw}, headers=H).status_code == 404
    return r.json()["id"], c


def test_flow_and_isolation(env):
    app, client, adm = env
    a_id, ca = make_client(adm, client, "a@klientas.lt")
    b_id, cb = make_client(adm, client, "b@klientas.lt")
    # Modelis klientui A
    it = adm.post("/api/items", json={"kind": "model", "title": "Objektas A", "clients": [a_id]}, headers=H).json()
    up = adm.put(f"/api/items/{it['id']}/files", params={"name": "../../etc/passwd"}, content=b"0123456789" * 100, headers=H)
    assert up.status_code == 200 and up.json()["name"] == "etc/passwd"  # kelias „nuvalytas“
    fid = up.json()["id"]
    # A mato, B – ne
    assert [x["id"] for x in ca.get("/api/items").json()] == [it["id"]]
    assert cb.get("/api/items").json() == []
    assert "meta" not in ca.get("/api/items").json()[0]
    url = f"/api/items/{it['id']}/files/{fid}/passwd"
    assert ca.get(url).status_code == 200
    assert cb.get(url).status_code == 404
    assert client().get(url).status_code == 401
    # Range (vaizdo įrašų peršokimas)
    r = ca.get(url, headers={"Range": "bytes=10-19"})
    assert r.status_code == 206 and r.content == b"0123456789"
    # Klientas negali keisti / kurti / matyti vartotojų
    assert ca.get("/api/users").status_code == 403
    assert ca.post("/api/items", json={"kind": "model", "title": "x"}, headers=H).status_code == 403
    assert ca.put(f"/api/items/{it['id']}/files", params={"name": "x"}, content=b"x", headers=H).status_code == 403
    assert ca.delete(f"/api/items/{it['id']}", headers=H).status_code == 403
    # CSRF: be antraštės keičiančios užklausos atmetamos
    assert adm.post("/api/items", json={"kind": "model", "title": "x"}).status_code == 403


def test_auth_check_rules(env):
    app, client, adm = env
    a_id, ca = make_client(adm, client, "a@klientas.lt")
    s = adm.post("/api/items", json={"kind": "stream", "title": "Dronas", "meta": {"source": {"url": "rtsp://slaptas:pw@10.0.0.1/x"}}, "clients": [a_id]}, headers=H).json()
    p = adm.post("/api/items", json={"kind": "stream", "title": "Pushed", "meta": {"path": "drone"}, "clients": []}, headers=H).json()

    def chk(c, uri):
        return c.get("/api/auth/check", headers={"X-Original-URI": uri}).status_code

    for uri in ["/odm/info", "/live/api/v3/paths/list", "/ai/train", "/ai/models/delete", "/ext/diab/atea.diab.app/x"]:
        assert chk(ca, uri) == 403, uri
        assert chk(adm, uri) == 204, uri
    assert chk(ca, f"/live/webrtc/item-{s['id']}/whep") == 204
    assert chk(ca, f"/live/hls/item-{s['id']}/index.m3u8") == 204
    assert chk(ca, "/live/hls/drone/index.m3u8") == 403  # nepriskirta
    assert chk(ca, f"/live/hls/item-{p['id']}/index.m3u8") == 403
    assert chk(ca, "/ai/detect") == 204
    # Keliai, kuriuos nginx normalizuoja kitaip nei jie atrodo – visada atmetami
    for uri in ["/ai/../odm/info", "/ai//train", "/ai/%74rain", "/ai/./train", "/ai/models/../models/delete",
                f"/live/hls/item-{s['id']}/../drone/index.m3u8", f"/live/hls/item-{s['id']}/%2e%2e/drone/x", "/ai/../live/api/v3/paths/list"]:
        assert chk(ca, uri) == 403, uri
    assert chk(ca, f"/live/hls/item-{s['id']}/index.m3u8?_HLS_msn=3&_HLS_part=1") == 204
    assert chk(client(), "/ai/detect") == 401
    # Klientui nerodomas šaltinio adresas su slaptažodžiu
    assert "rtsp://" not in ca.get("/api/items").text


def test_login_throttle_and_disable(env):
    app, client, adm = env
    a_id, ca = make_client(adm, client, "a@klientas.lt")
    c = client()
    for _ in range(5):
        assert c.post("/api/auth/login", json={"email": "a@klientas.lt", "password": "blogas-slaptazodis"}, headers=H).status_code == 401
    r = c.post("/api/auth/login", json={"email": "a@klientas.lt", "password": "Kliento-slaptas-1"}, headers=H)
    assert r.status_code == 429  # užrakinta net su teisingu slaptažodžiu
    # Neegzistuojantis el. paštas – tas pats atsakymas
    assert client().post("/api/auth/login", json={"email": "nera@x.lt", "password": "kazkas-kazkas"}, headers=H).status_code == 401
    # Išjungtas klientas iškart atjungiamas
    assert ca.get("/api/me").status_code == 200
    assert adm.patch(f"/api/users/{a_id}", json={"disabled": True}, headers=H).status_code == 200
    assert ca.get("/api/me").status_code == 401
    # Silpnas slaptažodis atmetamas
    r = adm.post("/api/users", json={"email": "c@k.lt", "role": "client"}, headers=H).json()
    tok = r["invite"].split("#invite=")[1]
    assert client().post("/api/auth/invite", json={"token": tok, "password": "trumpas"}, headers=H).status_code == 400


def test_cookie_flags(env):
    app, client, adm = env
    c = client()
    r = c.post("/api/auth/login", json={"email": "admin@a.lt", "password": "Labai-slaptas-1"}, headers={**H, "X-Forwarded-Proto": "https"})
    sc = r.headers["set-cookie"].lower()
    assert "httponly" in sc and "samesite=strict" in sc and "secure" in sc


def test_inline_types(env):
    app, client, adm = env
    it = adm.post("/api/items", json={"kind": "report", "title": "R"}, headers=H).json()
    h = adm.put(f"/api/items/{it['id']}/files", params={"name": "x.html"}, content=b"<script>alert(1)</script>", headers=H).json()
    p = adm.put(f"/api/items/{it['id']}/files", params={"name": "a.pdf"}, content=b"%PDF-1.4", headers=H).json()
    r = adm.get(f"/api/items/{it['id']}/files/{h['id']}/x.html")
    assert r.headers["content-disposition"].startswith("attachment") and r.headers["content-type"] == "application/octet-stream"
    r = adm.get(f"/api/items/{it['id']}/files/{p['id']}/a.pdf")
    assert r.headers["content-disposition"].startswith("inline") and r.headers["content-type"] == "application/pdf"


SQUARE = {"type": "Polygon", "coordinates": [[[23.9, 54.9], [23.901, 54.9], [23.901, 54.9006], [23.9, 54.9006], [23.9, 54.9]]]}


def test_orders_flow_and_isolation(env):
    app, client, adm = env
    a_id, ca = make_client(adm, client, "a@klientas.lt")
    b_id, cb = make_client(adm, client, "b@klientas.lt")
    body = {"title": "Sandėlio aikštelė", "works": ["ortho", "volume", "nesamas"], "note": "Reikia tūrių", "geometry": SQUARE, "due": "2026-12-01", "contact": "+370 600 00000"}
    r = ca.post("/api/orders", json=body, headers=H)
    assert r.status_code == 200, r.text
    o = r.json()
    assert o["works"] == ["ortho", "volume"] and o["status"] == "new"
    assert 4000 < o["area"] < 4400  # ~64 m × 67 m
    assert "client" not in o
    # Be X-Atea – atmesta; neteisinga geometrija / data / be darbų
    assert ca.post("/api/orders", json=body).status_code == 403
    assert ca.post("/api/orders", json={**body, "geometry": {"type": "Point", "coordinates": [1, 2]}}, headers=H).status_code == 400
    assert ca.post("/api/orders", json={**body, "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 1]]]}}, headers=H).status_code == 400
    assert ca.post("/api/orders", json={**body, "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [500, 1], [1, 2]]]}}, headers=H).status_code == 400
    assert ca.post("/api/orders", json={**body, "due": "rytoj"}, headers=H).status_code == 400
    assert ca.post("/api/orders", json={**body, "works": []}, headers=H).status_code == 400
    # B nemato A užsakymo ir negali jo keisti ar komentuoti
    assert cb.get("/api/orders").json() == []
    assert cb.get(f"/api/orders/{o['id']}").status_code == 404
    assert cb.patch(f"/api/orders/{o['id']}", json={"title": "x"}, headers=H).status_code == 404
    assert cb.post(f"/api/orders/{o['id']}/comments", json={"body": "x"}, headers=H).status_code == 404
    # Administratorius mato – neperskaitytas, su klientu
    lst = adm.get("/api/orders").json()
    assert len(lst) == 1 and lst[0]["unread"] and lst[0]["client"]["email"] == "a@klientas.lt"
    d = adm.get(f"/api/orders/{o['id']}").json()
    assert d["events"][0]["kind"] == "created"
    assert not adm.get("/api/orders").json()[0]["unread"]
    # Klientas: kol naujas – gali keisti; būsenos keisti negali (išskyrus atšaukimą)
    assert ca.patch(f"/api/orders/{o['id']}", json={"note": "Ir 3D", "works": ["ortho", "model3d"]}, headers=H).json()["works"] == ["ortho", "model3d"]
    assert ca.patch(f"/api/orders/{o['id']}", json={"status": "done"}, headers=H).status_code == 403
    assert ca.patch(f"/api/orders/{o['id']}", json={"price": "1 €", "admin_note": "x"}, headers=H).json()["price"] == ""
    # Admin priima, suplanuoja, nurodo kainą; klientas mato pakeitimą kaip neperskaitytą
    r = adm.patch(f"/api/orders/{o['id']}", json={"status": "accepted", "planned": "2026-11-20", "price": "450 € + PVM"}, headers=H)
    assert r.status_code == 200 and r.json()["status"] == "accepted"
    assert adm.patch(f"/api/orders/{o['id']}", json={"status": "kitas"}, headers=H).status_code == 400
    assert ca.get("/api/orders").json()[0]["unread"]
    assert ca.patch(f"/api/orders/{o['id']}", json={"note": "keičiu"}, headers=H).status_code == 400  # priimto keisti negalima
    # Žinutės abiem kryptimis
    assert ca.post(f"/api/orders/{o['id']}/comments", json={"body": "  "}, headers=H).status_code == 400
    ca.post(f"/api/orders/{o['id']}/comments", json={"body": "Ar galima anksčiau?"}, headers=H)
    d = adm.post(f"/api/orders/{o['id']}/comments", json={"body": "Taip, 18 d."}, headers=H).json()
    kinds = [(e["kind"], e["who"]) for e in d["events"]]
    assert ("comment", "client") in kinds and ("comment", "admin") in kinds and ("status", "admin") in kinds
    # Rezultatai: pridėtas modelis automatiškai priskiriamas užsakymo klientui (ir tik jam)
    it = adm.post("/api/items", json={"kind": "model", "title": "Rezultatas"}, headers=H).json()
    adm.patch(f"/api/orders/{o['id']}", json={"items": [it["id"], 99999], "status": "done"}, headers=H)
    assert [x["id"] for x in ca.get("/api/items").json()] == [it["id"]]
    assert cb.get("/api/items").json() == []
    assert ca.get(f"/api/orders/{o['id']}").json()["items"] == [{"id": it["id"], "kind": "model", "title": "Rezultatas"}]
    # Užbaigto atšaukti negalima; trinti – tik administratorius
    assert ca.patch(f"/api/orders/{o['id']}", json={"status": "cancelled"}, headers=H).status_code == 400
    assert ca.delete(f"/api/orders/{o['id']}", headers=H).status_code == 403
    assert adm.delete(f"/api/orders/{o['id']}", headers=H).status_code == 200
    assert ca.get("/api/orders").json() == []


def test_orders_admin_for_client_and_cancel(env):
    app, client, adm = env
    a_id, ca = make_client(adm, client, "a@klientas.lt")
    body = {"title": "Telefonu", "works": ["inspection"], "geometry": SQUARE}
    assert adm.post("/api/orders", json=body, headers=H).status_code == 400  # be kliento
    o = adm.post("/api/orders", json={**body, "client_id": a_id}, headers=H).json()
    assert o["client"]["id"] == a_id
    assert ca.get("/api/orders").json()[0]["id"] == o["id"]
    assert ca.patch(f"/api/orders/{o['id']}", json={"status": "cancelled"}, headers=H).json()["status"] == "cancelled"
    # Išjungtas klientas nebepasiekia
    adm.patch(f"/api/users/{a_id}", json={"disabled": True}, headers=H)
    assert ca.get("/api/orders").status_code == 401


def test_ortho_items_range_and_orders(env):
    app, client, adm = env
    a_id, ca = make_client(adm, client, "a@klientas.lt")
    b_id, cb = make_client(adm, client, "b@klientas.lt")
    it = adm.post("/api/items", json={"kind": "ortho", "title": "Aikštelės ortofoto"}, headers=H).json()
    data = bytes(range(256)) * 400
    f = adm.put(f"/api/items/{it['id']}/files", params={"name": "ortofoto.tif"}, content=data, headers=H).json()
    # Priskiriama per užsakymo rezultatus – tik užsakymo klientui
    o = ca.post("/api/orders", json={"title": "Ortofoto", "works": ["ortho"], "geometry": SQUARE}, headers=H).json()
    adm.patch(f"/api/orders/{o['id']}", json={"items": [it["id"]], "status": "done"}, headers=H)
    assert [x["kind"] for x in ca.get("/api/items").json()] == ["ortho"]
    assert cb.get("/api/items").json() == []
    assert ca.get(f"/api/orders/{o['id']}").json()["items"][0]["kind"] == "ortho"
    # Peržiūra skaito failą dalimis (HTTP Range); TIFF naršyklėje neatidaromas kaip puslapis
    url = f"/api/items/{it['id']}/files/{f['id']}/ortofoto.tif"
    r = ca.get(url, headers={"Range": "bytes=100-199"})
    assert r.status_code == 206 and r.content == data[100:200]
    assert r.headers["content-type"] == "application/octet-stream"
    assert cb.get(url, headers={"Range": "bytes=0-9"}).status_code == 404


def test_relay_push_and_auth(env, monkeypatch):
    app, client, adm = env
    a_id, ca = make_client(adm, client, "a@klientas.lt")
    b_id, cb = make_client(adm, client, "b@klientas.lt")
    calls = []

    class FakeProc:
        def __init__(self, cmd, **kw):
            calls.append(cmd)

        def poll(self):
            return None

    monkeypatch.setattr(app, "RELAY_ON", True)
    monkeypatch.setattr(app, "RELAY_HOST", "2.29.109.25")
    monkeypatch.setattr(app, "RELAY_KEY", "slaptas123")
    monkeypatch.setattr(app.subprocess, "Popen", FakeProc)
    it = adm.post("/api/items", json={"kind": "stream", "title": "Dronas", "clients": [a_id], "meta": {"path": "drone1"}}, headers=H).json()
    # Be relay=1 (vietinis žiūrovas) – į VPS nesiunčiama
    assert ca.post(f"/api/items/{it['id']}/play", headers=H).json() == {"path": "drone1", "relay": False}
    assert calls == []
    # Iš interneto – vienas ffmpeg procesas; pakartotinis kvietimas (kas 25 s) naujo nepaleidžia
    assert ca.post(f"/api/items/{it['id']}/play?relay=1", headers=H).json() == {"path": "drone1", "relay": True}
    assert ca.post(f"/api/items/{it['id']}/play?relay=1", headers=H).json()["relay"] is True
    assert len(calls) == 1
    cmd = calls[0]
    assert cmd[0] == "ffmpeg" and "rtsp://mediamtx:8554/drone1" in cmd and "rtsps://relay:slaptas123@2.29.109.25:8322/drone1" in cmd
    # Kitas klientas – nei transliacijos, nei persiuntimo
    assert cb.post(f"/api/items/{it['id']}/play?relay=1", headers=H).status_code == 404
    # nginx prieigos tikrinimas /live/relay/: tik priskirtam klientui
    chk = lambda c, uri: c.get("/api/auth/check", headers={"X-Original-URI": uri}).status_code  # noqa: E731
    assert chk(ca, "/live/relay/drone1/whep") == 204
    assert chk(cb, "/live/relay/drone1/whep") == 403
    assert chk(ca, "/live/relay/kitas/whep") == 403
    assert chk(ca, "/live/relay/../odm/x") == 403


def test_chunked_upload_resume(env):
    app, client, adm = env
    it = adm.post("/api/items", json={"kind": "recording", "title": "Skrydis"}, headers=H).json()
    data = bytes(range(256)) * 4000  # ~1 MB
    url = f"/api/items/{it['id']}/files"
    q = lambda off: {"name": "skrydis.webm", "upload": "ab" * 16, "offset": off, "total": len(data)}  # noqa: E731
    r = adm.put(url, params=q(0), content=data[:300000], headers=H)
    assert r.json() == {"have": 300000, "done": False}
    # Dalis ne iš eilės (pvz. pakartota po nutrūkimo) – serveris praneša, nuo kur tęsti
    r = adm.put(url, params=q(500000), content=data[500000:600000], headers=H)
    assert r.status_code == 409 and r.json()["have"] == 300000
    assert adm.put(url, params=q(300000), content=data[300000:800000], headers=H).json()["have"] == 800000
    f = adm.put(url, params=q(800000), content=data[800000:], headers=H).json()
    assert f["name"] == "skrydis.webm" and f["size"] == len(data)
    items = adm.get("/api/items").json()
    assert items[0]["files"][0]["size"] == len(data)
    got = adm.get(f"/api/items/{it['id']}/files/{f['id']}/skrydis.webm?download=1").content
    assert got == data
    # Per daug duomenų, neteisingas ID – atmetama
    assert adm.put(url, params={**q(0), "upload": "../x"}, content=b"x", headers=H).status_code == 400
    r = adm.put(url, params={**q(0), "upload": "cd" * 16, "total": 3}, content=b"12345", headers=H)
    assert r.status_code == 400
    # Nebaigtas įkėlimas pašalinamas kartu su įrašu
    adm.put(url, params={**q(0), "upload": "ef" * 16}, content=b"123", headers=H)
    assert list((app.FILES / str(it["id"])).glob(".part-*"))
    adm.delete(f"/api/items/{it['id']}", headers=H)
    assert not list((app.FILES / str(it["id"])).glob(".part-*"))
    # Klientas įkelti negali
    a_id, ca = make_client(adm, client, "a@klientas.lt")
    it2 = adm.post("/api/items", json={"kind": "recording", "title": "x", "clients": [a_id]}, headers=H).json()
    assert ca.put(f"/api/items/{it2['id']}/files", params={**q(0)}, content=b"1", headers=H).status_code == 403


def test_video_normalized_after_upload(env, tmp_path):
    import shutil
    import subprocess
    import time as _t

    if not shutil.which("ffmpeg"):
        pytest.skip("nėra ffmpeg")
    app, client, adm = env
    # Fragmentuotas MP4 – kaip naršyklės MediaRecorder (moov be trukmės, duomenys fragmentais)
    src = tmp_path / "rec.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-movflags", "frag_keyframe+empty_moov", str(src)], check=True)
    it = adm.post("/api/items", json={"kind": "recording", "title": "Skrydis"}, headers=H).json()
    f = adm.put(f"/api/items/{it['id']}/files", params={"name": "rec.mp4"}, content=src.read_bytes(), headers=H).json()
    for _ in range(100):
        with app.db() as con:
            if con.execute("SELECT 1 FROM media_ok WHERE file_id=?", (f["id"],)).fetchone():
                break
        _t.sleep(0.1)
    out = tmp_path / "back.mp4"
    out.write_bytes(adm.get(f"/api/items/{it['id']}/files/{f['id']}/rec.mp4?download=1").content)
    data = out.read_bytes()
    assert data.find(b"moov") < data.find(b"mdat")  # „faststart“: rodyklė pradžioje
    assert b"moof" not in data  # nebe fragmentuotas
    dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)], capture_output=True, text=True).stdout
    assert abs(float(dur) - 3) < 0.3
    assert adm.get("/api/items").json()[0]["files"][0]["size"] == len(data)
