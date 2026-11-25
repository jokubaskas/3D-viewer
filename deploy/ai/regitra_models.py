"""Automobilių markių ir modelių sąrašo atnaujinimas iš Regitros atvirų duomenų.

Regitra skelbia visų Lietuvoje registruotų transporto priemonių duomenis (data.gov.lt, „Lietuvoje įregistruotų
kelių transporto priemonių duomenys“, failas Atviri_TP_parko_duomenys.zip / .csv). Šis įrankis suskaičiuoja,
kiek kokių markių ir modelių yra, ir įrašo populiariausius į /models/custom/vehicle_models.json – jį naudoja
automobilio požymių atpažinimas (vehicle.py). Asmens duomenų faile nėra; įrašomi tik markių ir modelių pavadinimai.

Naudojimas (AI konteineryje): python3 regitra_models.py <failas.zip|failas.csv> [--out kelias] [--min-make 200] [--min-model 50]
Windows: deploy\\atnaujinti-auto-modelius.bat <failas>
"""
from __future__ import annotations

import argparse
import collections
import csv
import io
import json
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, "vehicle_models.json")
OUT = "/models/custom/vehicle_models.json"

# Kategorijos: M1 – lengvieji, N1 – lengvieji kroviniai (furgonai); N2/N3 – sunkvežimiai, M2/M3 – autobusai
LIGHT = ("M1", "N1")
HEAVY = ("N2", "N3", "M2", "M3")

MAKE_ALIAS = {
    "VW": "Volkswagen", "VOLKSWAGEN": "Volkswagen", "SKODA": "Škoda", "ŠKODA": "Škoda", "CITROEN": "Citroën", "CITROËN": "Citroën",
    "MERCEDES BENZ": "Mercedes-Benz", "MERCEDES-BENZ": "Mercedes-Benz", "MERCEDES": "Mercedes-Benz", "DAIMLERCHRYSLER": "Mercedes-Benz",
    "LAND ROVER": "Land Rover", "LANDROVER": "Land Rover", "MINI": "MINI", "BMW I": "BMW", "SEAT": "SEAT", "ALFA ROMEO": "Alfa Romeo",
    "ROLLS ROYCE": "Rolls-Royce", "ROLLS-ROYCE": "Rolls-Royce", "ASTON MARTIN": "Aston Martin", "LYNK&CO": "Lynk & Co", "LYNK & CO": "Lynk & Co",
    "VAZ": "Lada", "LADA": "Lada", "MAN": "MAN", "DAF": "DAF", "GMC": "GMC", "BYD": "BYD", "MG": "MG", "DS": "DS", "VDL": "VDL", "NIO": "NIO",
    "GREAT WALL": "GWM", "GWM": "GWM", "SSANGYONG": "SsangYong", "KGM": "SsangYong",
}


def norm_make(s: str, known: dict) -> str:
    u = re.sub(r"\s+", " ", s.strip().upper())
    if u in MAKE_ALIAS:
        return MAKE_ALIAS[u]
    for k in known:
        if k.upper() == u:
            return k
    return u.title()


def norm_model(make: str, s: str, known: list) -> str:
    u = re.sub(r"\s+", " ", s.strip().upper().replace("_", " "))
    if not u:
        return ""
    cu = re.sub(r"[^A-Z0-9]", "", u)
    for k in known:  # RAV 4 → RAV4, X-TRAIL → X-Trail
        if re.sub(r"[^A-Z0-9]", "", k.upper()) == cu:
            return k
    # Žinomi pavadinimai – ilgiausias sutampantis pradžioje (PASSAT VARIANT → Passat, C4 PICASSO → C4 Picasso)
    for k in sorted(known, key=len, reverse=True):
        ku = k.upper()
        if u == ku or u.startswith(ku + " ") or u.startswith(ku + "-"):
            return k
    if make == "BMW":
        m = re.match(r"^(\d)\d\d", u)  # 320D, 520I → 3 Series, 5 Series
        if m:
            return f"{m.group(1)} Series"
    if make == "Mercedes-Benz":
        m = re.match(r"^([ABCEGS]|CL|CLA|CLK|CLS|GL|GLA|GLB|GLC|GLE|GLK|GLS|ML|SL|SLK|V)\s?\d", u)  # E 220 → E-Class
        if m:
            c = m.group(1)
            return f"{c}-Class" if len(c) == 1 else c
    first = u.split(" ")[0]
    return first.title() if len(re.sub(r"[^A-Z0-9]", "", first)) >= 2 else ""  # „R 450“ – ne modelio pavadinimas


def read_rows(path: str):
    if path.lower().endswith(".zip"):
        z = zipfile.ZipFile(path)
        name = max((n for n in z.namelist() if n.lower().endswith(".csv")), key=lambda n: z.getinfo(n).file_size)
        raw = z.open(name)
    else:
        raw = open(path, "rb")
    head = raw.read(4096)
    enc = "utf-8-sig"
    try:
        head.decode("utf-8")
    except UnicodeDecodeError:
        enc = "cp1257"
    text = io.TextIOWrapper(io.BufferedReader(_Prepend(head, raw)), encoding=enc, errors="replace", newline="")
    sample = head.decode(enc, errors="replace")
    delim = max([";", ",", "\t", "|"], key=sample.count)
    return csv.DictReader(text, delimiter=delim)


class _Prepend(io.RawIOBase):
    def __init__(self, head: bytes, rest):
        self.head, self.rest = head, rest

    def readable(self):
        return True

    def readinto(self, b):
        if self.head:
            n = min(len(b), len(self.head))
            b[:n] = self.head[:n]
            self.head = self.head[n:]
            return n
        data = self.rest.read(len(b))
        b[: len(data)] = data
        return len(data)


def pick(cols, *keys):
    for k in keys:
        for c in cols:
            if k in c.upper():
                return c
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--min-make", type=int, default=200, help="mažiausias markės automobilių skaičius")
    ap.add_argument("--min-model", type=int, default=50, help="mažiausias modelio automobilių skaičius")
    ap.add_argument("--max-models", type=int, default=45)
    a = ap.parse_args()

    base = json.load(open(BASE, encoding="utf-8"))
    known = {m["name"]: (m.get("models", []), m.get("heavy", [])) for m in base["makes"]}
    rows = read_rows(a.file)
    cols = rows.fieldnames or []
    c_make = pick(cols, "MARK")
    c_model = pick(cols, "KOMERC", "MODEL")
    c_cat = pick(cols, "KATEG", "KLASE")
    if not c_make or not c_model:
        sys.exit(f"Nerasti markės / modelio stulpeliai. Stulpeliai: {cols}")
    print(f"Stulpeliai: markė={c_make}, modelis={c_model}, kategorija={c_cat or '–'}")

    light = collections.Counter()
    heavy = collections.Counter()
    makes_l = collections.Counter()
    makes_h = collections.Counter()
    n = 0
    for r in rows:
        n += 1
        mk_raw = (r.get(c_make) or "").strip()
        if not mk_raw:
            continue
        cat = (r.get(c_cat) or "").strip().upper()[:2] if c_cat else "M1"
        is_heavy = cat in HEAVY
        if not is_heavy and cat not in LIGHT:
            continue  # motociklai, priekabos, traktoriai
        mk = norm_make(mk_raw, known)
        kl, kh = known.get(mk, ([], []))
        md = norm_model(mk, r.get(c_model) or "", kh if is_heavy else kl)
        (makes_h if is_heavy else makes_l)[mk] += 1
        if md:
            (heavy if is_heavy else light)[(mk, md)] += 1
    print(f"Eilučių: {n:,}; lengvųjų ir furgonų: {sum(makes_l.values()):,}; sunkvežimių ir autobusų: {sum(makes_h.values()):,}")

    def models(counter, mk, base_list):
        ms = sorted(((md, c) for (m, md), c in counter.items() if m == mk and c >= a.min_model), key=lambda x: -x[1])
        got = [md for md, _ in ms[: a.max_models]]
        # Žinomi modeliai, kurių faile mažai – sąrašo gale (kad nebūtų priskiriami kitam modeliui)
        return got + [md for md in base_list if md not in got]

    out = []
    for mk, c in makes_l.most_common():
        if c < a.min_make:
            break
        e = {"name": mk, "models": models(light, mk, known.get(mk, ([], []))[0]), "count": c}
        out.append(e)
    by = {e["name"]: e for e in out}
    for mk, c in makes_h.most_common():
        if c < max(20, a.min_make // 10):
            break
        hm = models(heavy, mk, known.get(mk, ([], []))[1])
        if mk in by:
            by[mk]["heavy"] = hm
        else:
            out.append({"name": mk, "models": [], "heavy": hm, "count": c})
    # Žinomos markės, kurių faile mažai (pvz. retos prabangios) – paliekamos sąrašo gale, kad nebūtų priskiriamos kitoms
    for m in base["makes"]:
        if m["name"] not in by and not any(e["name"] == m["name"] for e in out):
            out.append({**m, "count": 0})
    res = {"_info": f"Sugeneruota iš Regitros failo {os.path.basename(a.file)} ({n:,} eilučių). " + base["_info"].split(". ")[1], "makes": out}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print(f"Įrašyta: {a.out} – markių {len(out)}, modelių {sum(len(e['models']) + len(e.get('heavy', [])) for e in out)}")
    print("Populiariausios markės:")
    for e in out[:20]:
        print(f"  {e['name']:15s} {e['count']:>8,}  {', '.join(e['models'][:8])}")


if __name__ == "__main__":
    main()
