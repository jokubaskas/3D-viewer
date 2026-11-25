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
OTHER = "__other__"
_HERE = os.path.dirname(os.path.abspath(__file__))
# Markių ir modelių sąrašas (eilė – pagal populiarumą Lietuvoje). Atnaujintas iš Regitros failo sąrašas
# (deploy\\atnaujinti-auto-modelius.bat) laikomas /models/custom – išlieka atnaujinus programą.
DB_PATHS = [os.environ.get("ATEA_AI_VEHICLE_DB", ""), "/models/custom/vehicle_models.json", os.path.join(_HERE, "vehicle_models.json")]


def load_db() -> tuple:
    """(lengvųjų markės → modeliai, sunkiųjų markės → modeliai, šaltinis)."""
    import json

    for path in DB_PATHS:
        if path and os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                db = json.load(f)
            cars = {m["name"]: m.get("models", []) for m in db["makes"] if m.get("models")}
            heavy = {m["name"]: m.get("heavy", []) for m in db["makes"] if m.get("heavy")}
            return cars, heavy, path
    raise FileNotFoundError("vehicle_models.json nerastas")


MAKES, HEAVY, DB_SOURCE = load_db()
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
    table = HEAVY if heavy else MAKES  # sunkvežimiams / autobusams – tik jų markės ir modeliai
    makes = list(table)
    noun = {"truck": "truck", "bus": "bus"}.get(kind, "car")
    make = attr("make", f"make:{noun}", makes + [OTHER], [f"a photo of a {k} {noun}." for k in makes] + [f"a photo of a {noun} of some other brand."])
    if make == OTHER or out["make"].get("guess") == OTHER:
        out["make"] = {"value": None, "p": out["make"]["p"], "other": True}
        make = None
    if make and table.get(make):
        # Papildomas variantas „kitas šios markės modelis“: jei jis laimi – modelis neatpažintas,
        # užuot priskyrus artimiausią sąraše (bandymuose dauguma modelio klaidų – modelio nebuvo sąraše)
        models = table[make] + [OTHER]
        attr("model", f"model:{noun}:{make}", models, [f"a photo of a {make} {mo}." for mo in table[make]] + [f"a photo of a {make} {noun} of some other model."])
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
