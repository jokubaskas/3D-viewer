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
