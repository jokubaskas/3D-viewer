"""Automobilio požymiai iš vaizdo: spalva, kėbulo tipas, markė, modelis.

Modelis: SigLIP 2 (Google, Apache 2.0) per open_clip – vaizdas lyginamas su tekstiniais aprašymais
(„a photo of a white Volkswagen Golf“), papildomai nemokomas. Kelios to paties automobilio iškarpos
(skirtingi kadrai) suvidurkinamos – rezultatas stabilesnis.

Atsakoma tik tada, kai modelis pakankamai tikras; kitaip – null („neatpažinta“), kad neklaidintų.
Metai iš vaizdo patikimai nenustatomi – negrąžinami.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Optional

import numpy as np
from PIL import Image

MODEL = os.environ.get("ATEA_AI_VEHICLE_MODEL", "ViT-B-16-SigLIP2-256")
PRETRAINED = os.environ.get("ATEA_AI_VEHICLE_PRETRAINED", "webli")

# Panašios spalvos sujungtos (pilka/sidabrinė, ruda/smėlio) – kitaip modelis „blaškosi“ tarp jų
COLORS = {
    "white": "balta", "black": "juoda", "silver or gray": "pilka / sidabrinė", "red": "raudona", "blue": "mėlyna",
    "green": "žalia", "yellow": "geltona", "orange": "oranžinė", "brown or beige": "ruda / smėlio",
}
BODIES = {
    "sedan": "sedanas", "hatchback": "hečbekas", "station wagon": "universalas", "SUV": "visureigis (SUV)", "minivan": "vienatūris",
    "cargo van": "furgonas", "pickup truck": "pikapas", "coupe": "kupė", "convertible": "kabrioletas", "truck": "sunkvežimis", "bus": "autobusas",
}
# Dažniausios markės Lietuvoje / Europoje ir populiariausi jų modeliai
MAKES = {
    "Volkswagen": ["Golf", "Golf Plus", "Golf Variant", "Passat", "Passat CC", "Polo", "Tiguan", "Touran", "Sharan", "Touareg", "Transporter", "Multivan", "Caddy", "Jetta", "Bora", "Arteon", "T-Roc", "T-Cross", "Taigo", "ID.3", "ID.4", "ID.Buzz", "Crafter", "Amarok", "Up", "Scirocco", "Beetle", "Phaeton", "Lupo", "Fox"],
    "Audi": ["A1", "A2", "A3", "A4", "A4 Avant", "A5", "A6", "A6 Avant", "A7", "A8", "Q2", "Q3", "Q4 e-tron", "Q5", "Q7", "Q8", "e-tron", "TT", "R8", "80", "100"],
    "BMW": ["1 Series", "2 Series", "2 Series Active Tourer", "3 Series", "3 Series Touring", "4 Series", "5 Series", "5 Series Touring", "6 Series", "7 Series", "8 Series", "X1", "X2", "X3", "X4", "X5", "X6", "X7", "Z4", "i3", "i4", "iX", "iX3", "M3", "M5"],
    "Mercedes-Benz": ["A-Class", "B-Class", "C-Class", "C-Class Estate", "E-Class", "E-Class Estate", "S-Class", "CLA", "CLS", "GLA", "GLB", "GLC", "GLE", "GLS", "G-Class", "ML", "GL", "V-Class", "Vito", "Viano", "Sprinter", "Citan", "EQC", "EQE", "EQS", "SL", "SLK"],
    "Toyota": ["Corolla", "Corolla Verso", "Auris", "Avensis", "Camry", "Yaris", "Yaris Cross", "Aygo", "Prius", "C-HR", "RAV4", "Highlander", "Land Cruiser", "Hilux", "Verso", "Proace", "bZ4X", "Supra", "GT86"],
    "Volvo": ["XC90", "XC60", "XC40", "XC70", "V40", "V50", "V60", "V70", "V90", "S40", "S60", "S80", "S90", "C30", "EX30"],
    "Škoda": ["Octavia", "Octavia Combi", "Superb", "Superb Combi", "Fabia", "Kodiaq", "Karoq", "Kamiq", "Rapid", "Roomster", "Yeti", "Enyaq", "Scala", "Citigo"],
    "Opel": ["Astra", "Insignia", "Corsa", "Zafira", "Vectra", "Meriva", "Mokka", "Antara", "Grandland", "Crossland", "Combo", "Vivaro", "Movano", "Signum", "Omega", "Agila"],
    "Ford": ["Focus", "Mondeo", "Fiesta", "Fusion", "Galaxy", "S-Max", "C-Max", "B-Max", "Kuga", "EcoSport", "Puma", "Edge", "Explorer", "Transit", "Transit Custom", "Transit Connect", "Tourneo", "Ranger", "Mustang", "Mustang Mach-E", "Ka", "F-150"],
    "Renault": ["Megane", "Clio", "Scenic", "Grand Scenic", "Laguna", "Espace", "Talisman", "Kangoo", "Trafic", "Master", "Captur", "Kadjar", "Koleos", "Arkana", "Austral", "Zoe", "Twingo", "Fluence", "Latitude"],
    "Peugeot": ["107", "108", "206", "207", "208", "306", "307", "308", "407", "406", "508", "607", "2008", "3008", "5008", "Partner", "Rifter", "Expert", "Boxer", "Traveller"],
    "Citroën": ["C1", "C2", "C3", "C3 Aircross", "C4", "C4 Picasso", "C4 Grand Picasso", "C5", "C5 Aircross", "C6", "Xsara Picasso", "Berlingo", "Jumpy", "Jumper", "SpaceTourer", "C-Crosser"],
    "Nissan": ["Qashqai", "X-Trail", "Juke", "Leaf", "Note", "Micra", "Almera", "Primera", "Navara", "Pathfinder", "Murano", "Patrol", "NV200", "Primastar", "Ariya", "Tiida"],
    "Honda": ["Civic", "Accord", "CR-V", "HR-V", "Jazz", "FR-V", "Insight", "e"],
    "Mazda": ["Mazda2", "Mazda3", "Mazda5", "Mazda6", "CX-3", "CX-30", "CX-5", "CX-60", "CX-7", "CX-9", "MX-5", "RX-8"],
    "Hyundai": ["i10", "i20", "i30", "i40", "ix20", "ix35", "Tucson", "Santa Fe", "Kona", "Ioniq", "Ioniq 5", "Getz", "Elantra", "Sonata", "H-1", "Bayon", "Matrix", "Trajet"],
    "Kia": ["Picanto", "Rio", "Ceed", "ProCeed", "Venga", "Soul", "Sportage", "Sorento", "Niro", "Stonic", "XCeed", "Carens", "Carnival", "Optima", "EV6", "Stinger"],
    "Subaru": ["Forester", "Outback", "Impreza", "XV", "Legacy", "Levorg", "BRZ", "Tribeca"],
    "Mitsubishi": ["Outlander", "ASX", "Lancer", "Colt", "Pajero", "Pajero Sport", "L200", "Eclipse Cross", "Space Star", "Galant", "Grandis"],
    "Lexus": ["RX", "NX", "IS", "ES", "UX", "LS"],
    "Tesla": ["Model 3", "Model Y", "Model S", "Model X", "Cybertruck"],
    "Fiat": ["500", "500X", "500L", "Panda", "Punto", "Bravo", "Stilo", "Tipo", "Doblo", "Ducato", "Fiorino", "Scudo", "Multipla", "Qubo"],
    "SEAT": ["Leon", "Ibiza", "Altea", "Toledo", "Cordoba", "Ateca", "Arona", "Tarraco", "Alhambra", "Exeo", "Mii"],
    "Cupra": ["Formentor", "Born", "Leon"],
    "Dacia": ["Duster", "Logan", "Logan MCV", "Sandero", "Lodgy", "Dokker", "Jogger", "Spring"],
    "Porsche": ["Cayenne", "Macan", "911", "Panamera", "Taycan", "Boxster", "Cayman"],
    "Land Rover": ["Range Rover", "Range Rover Sport", "Range Rover Evoque", "Range Rover Velar", "Discovery", "Discovery Sport", "Defender", "Freelander"],
    "Jaguar": ["XF", "F-Pace", "XE", "E-Pace", "I-Pace"],
    "MINI": ["Cooper", "Countryman", "Clubman"],
    "Suzuki": ["Vitara", "Swift", "SX4", "Jimny", "Ignis"],
    "Chevrolet": ["Captiva", "Cruze", "Aveo", "Lacetti", "Camaro", "Tahoe"],
    "Jeep": ["Grand Cherokee", "Wrangler", "Compass", "Cherokee", "Renegade"],
    "Dodge": ["Ram", "Challenger", "Charger", "Journey", "Durango"],
    "Chrysler": ["Pacifica", "300C", "Voyager"],
    "Alfa Romeo": ["Giulia", "Stelvio", "159", "Giulietta"],
    "Smart": ["Fortwo", "Forfour"],
    "Saab": ["9-3", "9-5"],
    "Lada": ["Niva", "Vesta", "2107"],
    "BYD": ["Atto 3", "Seal", "Han"],
    "MG": ["ZS", "MG4", "HS"],
    "Polestar": ["Polestar 2"],
    "Ferrari": ["458", "F8", "Roma", "Portofino"],
    "Lamborghini": ["Urus", "Huracan", "Aventador"],
    "Maserati": ["Levante", "Ghibli", "Quattroporte"],
    "Bentley": ["Continental GT", "Bentayga", "Flying Spur"],
    "Rolls-Royce": ["Ghost", "Phantom", "Cullinan"],
    "Aston Martin": ["DB11", "Vantage", "DBX"],
    "Cadillac": ["Escalade", "CTS", "SRX"],
    "GMC": ["Savana", "Sierra", "Yukon"],
    "Infiniti": ["Q50", "QX70", "FX"],
    "Acura": ["MDX", "TL", "RDX"],
    "Lincoln": ["Navigator", "Town Car"],
    "Genesis": ["G80", "GV80"],
    "DS": ["DS 7", "DS 4"],
    "SsangYong": ["Rexton", "Korando", "Tivoli"],
    "Isuzu": ["D-Max"],
    "Geely": ["Coolray"],
    "Iveco": ["Daily"],
    "MAN": ["TGX", "TGS"],
    "Scania": ["R-series", "S-series"],
    "DAF": ["XF", "CF"],
    "Setra": ["S 515"],
    "Solaris": ["Urbino"],
}
OTHER = "__other__"
HEAVY_ONLY = {"MAN", "Scania", "DAF", "Setra", "Solaris"}  # tik sunkvežimiams ir autobusams
# Slenksčiai (tikimybė tarp visų variantų): žemiau – „neatpažinta“. Bandymas su Stanford Cars (400 nuotraukų,
# sumažintų iki 64–160 px pločio): kai tikimybė ≥ 0,7, markė teisinga 92–97 % atsakytų atvejų, atsakoma 53–84 %.
TH = {"color": 0.6, "body": 0.6, "make": 0.7, "model": 0.85}
MIN_SIDE = {"color": 20, "body": 32, "make": 40, "model": 56}  # trumpesnė automobilio iškarpos kraštinė, px

_lock = threading.Lock()
_state: dict = {}


def _load():
    with _lock:
        if "model" not in _state:
            import open_clip
            import torch

            t0 = time.time()
            m, _, prep = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAINED)
            m.eval()
            tok = open_clip.get_tokenizer(MODEL)
            _state.update(model=m, prep=prep, tok=tok, torch=torch, text={})
            print(f"[ai] automobilio požymiai ({MODEL}) įkelti per {time.time() - t0:.1f} s", flush=True)
        return _state


def _text(key: str, prompts: list) -> "np.ndarray":
    st = _load()
    cache = st["text"]
    if key not in cache:
        torch = st["torch"]
        with torch.no_grad():
            f = st["model"].encode_text(st["tok"](prompts))
            f = f / f.norm(dim=-1, keepdim=True)
        cache[key] = f
    return cache[key]


def _probs(img_f, key: str, prompts: list):
    st = _load()
    t = _text(key, prompts)
    m = st["model"]
    with st["torch"].no_grad():
        logits = img_f @ t.T * m.logit_scale.exp()
        if getattr(m, "logit_bias", None) is not None:
            logits = logits + m.logit_bias
        return logits.softmax(-1)[0].detach().numpy()


def _pick(p, labels, th) -> Optional[dict]:
    i = int(np.argmax(p))
    return {"value": labels[i], "p": round(float(p[i]), 3)} if p[i] >= th else {"value": None, "p": round(float(p[i]), 3), "guess": labels[i]}


def describe(images: list, kind: str = "car") -> dict:
    """images – to paties automobilio iškarpos (RGB numpy). Grąžina požymius su tikimybėmis;
    value = None – neatpažinta (guess – spėjimas, kurio rodyti kaip fakto nereikėtų)."""
    st = _load()
    torch = st["torch"]
    side = max(min(i.shape[:2]) for i in images)
    with torch.no_grad():
        x = torch.stack([st["prep"](Image.fromarray(i)) for i in images])
        f = st["model"].encode_image(x)
        f = f / f.norm(dim=-1, keepdim=True)
        f = f.mean(0, keepdim=True)
        f = f / f.norm(dim=-1, keepdim=True)
    out: dict = {"side": int(side), "frames": len(images), "year": None}

    def attr(name, key, labels, prompts):
        if side < MIN_SIDE[name]:
            out[name] = {"value": None, "p": 0.0, "small": True}
            return None
        out[name] = _pick(_probs(f, key, prompts), labels, TH[name])
        return out[name]["value"]

    attr("color", "color", list(COLORS), [f"a photo of a {c} car." for c in COLORS])
    attr("body", "body", list(BODIES), [f"a photo of a {b}." for b in BODIES])
    heavy = kind in ("truck", "bus")
    makes = [k for k in MAKES if heavy or k not in HEAVY_ONLY]
    noun = {"truck": "truck", "bus": "bus"}.get(kind, "car")
    make = attr("make", f"make:{noun}", makes + [OTHER], [f"a photo of a {k} {noun}." for k in makes] + [f"a photo of a {noun} of some other brand."])
    if make == OTHER or out["make"].get("guess") == OTHER:
        out["make"] = {"value": None, "p": out["make"]["p"], "other": True}
        make = None
    if make and MAKES.get(make):
        # Papildomas variantas „kitas šios markės modelis“: jei jis laimi – modelis neatpažintas,
        # užuot priskyrus artimiausią sąraše (bandymuose dauguma modelio klaidų – modelio nebuvo sąraše)
        models = MAKES[make] + [OTHER]
        attr("model", f"model:{make}", models, [f"a photo of a {make} {mo}." for mo in MAKES[make]] + [f"a photo of a {make} car of some other model."])
        if out["model"].get("value") == OTHER or out["model"].get("guess") == OTHER:
            out["model"] = {"value": None, "p": out["model"]["p"], "other": True}
    else:
        out["model"] = {"value": None, "p": 0.0}
    # Lietuviški pavadinimai sąsajai
    for name, table in (("color", COLORS), ("body", BODIES)):
        v = out[name].get("value")
        if v:
            out[name]["lt"] = table[v]
    return out


def warmup():
    _load()
