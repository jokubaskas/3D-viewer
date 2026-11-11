# Atea variklis – geografija: nuotraukų EXIF / DJI XMP, WGS84 → UTM, ODM tipo coords.txt, kontroliniai taškai
# (gcp_list.txt, ODM formatas) ir sritis (GeoJSON). Vietinis rėmas – kaip ODM: UTM minus suapvalintas poslinkis, Z – aukštis.
import json
import os
import re

import numpy as np

XMP_KEYS = ("RelativeAltitude", "AbsoluteAltitude", "GimbalPitchDegree", "GimbalYawDegree", "FlightYawDegree", "RtkFlag",
            "RtkStdLon", "RtkStdLat", "RtkStdHgt")


def _num(v):
    try:
        if isinstance(v, tuple) and len(v) == 2:
            return float(v[0]) / float(v[1]) if float(v[1]) else None
        return float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _dms(v, ref):
    if v is None:
        return None
    try:
        d, m, s = (_num(x) for x in v)
        x = d + m / 60.0 + s / 3600.0
    except (TypeError, ValueError):
        return None
    return -x if ref in ("S", "W", b"S", b"W") else x


def read_xmp(path, limit=256 * 1024):
    """DJI XMP laukai (drone-dji:…) iš JPEG pradžios."""
    try:
        with open(path, "rb") as f:
            head = f.read(limit)
    except OSError:
        return {}
    i = head.find(b"<x:xmpmeta")
    if i < 0:
        return {}
    j = head.find(b"</x:xmpmeta>", i)
    xmp = head[i:j if j > 0 else None].decode("utf-8", "replace")
    out = {}
    for k in XMP_KEYS:
        m = re.search(r'drone-dji:%s\s*=\s*"([^"]*)"' % k, xmp) or re.search(r"<drone-dji:%s>([^<]*)<" % k, xmp)
        if m:
            try:
                out[k] = float(m.group(1))
            except ValueError:
                out[k] = m.group(1)
    return out


def read_photo(path):
    """Nuotraukos metaduomenys: dydis, kamera, židinys, GPS (lat, lon, alt), DJI XMP."""
    from PIL import Image
    info = {"name": os.path.basename(path)}
    with Image.open(path) as im:
        info["width"], info["height"] = im.size
        ex = im.getexif()
        sub = ex.get_ifd(0x8769)
        gps = ex.get_ifd(0x8825)
    info["make"] = str(ex.get(0x010F, "") or "").strip("\x00 ")
    info["model"] = str(ex.get(0x0110, "") or "").strip("\x00 ")
    info["focal_mm"] = _num(sub.get(0x920A))
    info["focal35"] = _num(sub.get(0xA405))
    info["time"] = str(sub.get(0x9003, "") or ex.get(0x0132, "") or "")
    lat = _dms(gps.get(2), gps.get(1))
    lon = _dms(gps.get(4), gps.get(3))
    alt = _num(gps.get(6))
    if alt is not None and gps.get(5) in (1, b"\x01"):
        alt = -alt
    if lat is not None and lon is not None and (abs(lat) > 1e-6 or abs(lon) > 1e-6):
        info["gps"] = [lat, lon, alt if alt is not None else 0.0]
    info["xmp"] = read_xmp(path)
    return info


def utm_zone(lat, lon):
    zone = int((lon + 180) // 6) + 1
    return zone, lat < 0


def utm_epsg(zone, south):
    return (32700 if south else 32600) + zone


def transformer(zone, south, inverse=False):
    from pyproj import Transformer
    if inverse:
        return Transformer.from_crs(utm_epsg(zone, south), 4326, always_xy=True)
    return Transformer.from_crs(4326, utm_epsg(zone, south), always_xy=True)


class GeoFrame:
    """Vietinis rėmas: x = E − offE, y = N − offN, z = aukštis (m)."""

    def __init__(self, zone, south, off_e, off_n):
        self.zone, self.south, self.off_e, self.off_n = int(zone), bool(south), float(off_e), float(off_n)
        self._fwd = transformer(zone, south)
        self._inv = transformer(zone, south, inverse=True)

    @classmethod
    def from_gps(cls, lat_lon_alt):
        a = np.asarray(lat_lon_alt, float)
        lat, lon = float(np.median(a[:, 0])), float(np.median(a[:, 1]))
        zone, south = utm_zone(lat, lon)
        e, n = transformer(zone, south).transform(lon, lat)
        return cls(zone, south, round(e), round(n))

    def to_local(self, lat, lon, alt):
        e, n = self._fwd.transform(np.asarray(lon, float), np.asarray(lat, float))
        return np.stack([np.asarray(e) - self.off_e, np.asarray(n) - self.off_n, np.asarray(alt, float)], -1)

    def to_wgs84(self, x, y):
        lon, lat = self._inv.transform(np.asarray(x, float) + self.off_e, np.asarray(y, float) + self.off_n)
        return lat, lon

    @property
    def epsg(self):
        return utm_epsg(self.zone, self.south)

    def coords_txt(self):
        return "WGS84 UTM %d%s\n%d %d\n" % (self.zone, "S" if self.south else "N", self.off_e, self.off_n)

    def save(self, path):
        with open(path, "w") as f:
            f.write(self.coords_txt())

    def to_json(self):
        return {"zone": self.zone, "south": self.south, "off_e": self.off_e, "off_n": self.off_n}

    @classmethod
    def from_json(cls, d):
        return cls(d["zone"], d["south"], d["off_e"], d["off_n"])


# ---------------------------------------------------------------- geo.txt (ODM formatas)
def parse_geo_txt(text):
    """ODM geo.txt: 1 eilutė – EPSG:4326; toliau: nuotrauka lon lat alt [yaw pitch roll [hAcc vAcc]].
    Programa jį kuria su perskaičiuotais aukščiais (elipsoidiniai / EGM96 / normaliniai) ir RTK tikslumu."""
    out = {}
    lines = [l.strip() for l in text.splitlines() if l.strip() and not l.startswith("#")]
    if not lines or "4326" not in lines[0].replace(" ", ""):
        return out
    for l in lines[1:]:
        p = l.split()
        if len(p) < 3:
            continue
        try:
            lon, lat = float(p[1]), float(p[2])
            alt = float(p[3]) if len(p) > 3 else float("nan")
            hacc = float(p[7]) if len(p) > 8 else float("nan")
            vacc = float(p[8]) if len(p) > 8 else float("nan")
        except ValueError:
            continue
        out[p[0]] = {"lat": lat, "lon": lon, "alt": alt, "hacc": hacc, "vacc": vacc}
    return out


# ---------------------------------------------------------------- kontroliniai taškai (ODM gcp_list.txt)
def parse_gcp(text, frame):
    """ODM gcp_list.txt: 1 eilutė – koordinačių sistema (EPSG:xxxx, „WGS84 UTM 34N“ ar proj4), toliau:
    geo_x geo_y geo_z im_x im_y nuotrauka [pavadinimas]. Grąžina {pavadinimas: {"xyz": vietinės, "obs": [(nuotr., x, y)]}}."""
    from pyproj import CRS, Transformer
    lines = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]
    if not lines:
        return {}
    head = lines[0]
    m = re.match(r"WGS84\s+UTM\s+(\d+)\s*([NS])", head, re.I)
    if m:
        src = CRS.from_epsg(utm_epsg(int(m.group(1)), m.group(2).upper() == "S"))
    else:
        src = CRS.from_user_input(head.replace("+init=", ""))
    t = Transformer.from_crs(src, frame.epsg, always_xy=True)
    out = {}
    for l in lines[1:]:
        p = l.split()
        if len(p) < 6:
            continue
        x, y, z, u, v = (float(q) for q in p[:5])
        img = p[5]
        name = p[6] if len(p) > 6 else "%.3f_%.3f_%.3f" % (x, y, z)
        e, n = t.transform(x, y)
        g = out.setdefault(name, {"xyz": np.array([e - frame.off_e, n - frame.off_n, z]), "obs": []})
        g["obs"].append((img, u, v))
    return out


# ---------------------------------------------------------------- sritis (GeoJSON, WGS84)
def boundary_polygon(geojson, frame):
    """Pirmasis (didžiausias) poligonas vietinėmis koordinatėmis (N×2) arba None."""
    if isinstance(geojson, str):
        try:
            geojson = json.loads(geojson)
        except ValueError:
            return None
    polys = []

    def walk(g):
        if not isinstance(g, dict):
            return
        t = g.get("type")
        if t == "FeatureCollection":
            for f in g.get("features", []):
                walk(f)
        elif t == "Feature":
            walk(g.get("geometry"))
        elif t == "Polygon":
            polys.append(g["coordinates"][0])
        elif t == "MultiPolygon":
            for p in g["coordinates"]:
                polys.append(p[0])
    walk(geojson)
    if not polys:
        return None
    best = None
    for ring in polys:
        a = np.asarray(ring, float)
        loc = frame.to_local(a[:, 1], a[:, 0], np.zeros(len(a)))[:, :2]
        area = abs(np.dot(loc[:-1, 0], loc[1:, 1]) - np.dot(loc[1:, 0], loc[:-1, 1])) / 2
        if best is None or area > best[0]:
            best = (area, loc)
    return best[1]


def inside_polygon(xy, poly):
    """Taškai poligono viduje (spindulio metodas, vektorizuotas)."""
    x, y = xy[:, 0], xy[:, 1]
    inside = np.zeros(len(xy), bool)
    px, py = poly[:, 0], poly[:, 1]
    n = len(poly)
    for i in range(n):
        j = (i - 1) % n
        cond = (py[i] > y) != (py[j] > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            xint = (px[j] - px[i]) * (y - py[i]) / (py[j] - py[i]) + px[i]
        inside ^= cond & (x < xint)
    return inside
