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
