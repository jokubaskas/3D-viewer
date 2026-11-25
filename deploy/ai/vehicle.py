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


def _text(prompts: list):
    """Tekstų vektoriai (podėlis kiekvienam tekstui atskirai – sąrašai keičiasi pridėjus galerijos pavyzdžių)."""
    st = _load()
    cache = st["text"]
    missing = [p for p in prompts if p not in cache]
    if missing:
        torch = st["torch"]
        with torch.no_grad():
            f = st["model"].encode_text(st["tok"](missing))
            f = f / f.norm(dim=-1, keepdim=True)
        for p, v in zip(missing, f):
            cache[p] = v
    return st["torch"].stack([cache[p] for p in prompts])


def _logits(img_f, prompts: list) -> np.ndarray:
    st = _load()
    t = _text(prompts)
    m = st["model"]
    with st["torch"].no_grad():
        logits = img_f @ t.T * m.logit_scale.exp()
        if getattr(m, "logit_bias", None) is not None:
            logits = logits + m.logit_bias
        return logits[0].detach().numpy().astype(np.float64)


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - x.max())
    return e / e.sum()


def _pick(p, labels, th) -> Optional[dict]:
    i = int(np.argmax(p))
    return {"value": labels[i], "p": round(float(p[i]), 3)} if p[i] >= th else {"value": None, "p": round(float(p[i]), 3), "guess": labels[i]}


def embed(images: list):
    """Iškarpų vektoriai (normuoti), po vieną kiekvienai iškarpai."""
    st = _load()
    torch = st["torch"]
    with torch.no_grad():
        x = torch.stack([st["prep"](Image.fromarray(i)) for i in images])
        f = st["model"].encode_image(x)
        return f / f.norm(dim=-1, keepdim=True)


# ---------------------------------------------------------------------------
# Pavyzdžių galerija: administratoriaus patvirtinti automobiliai (iš jūsų pačių skrydžių). Atpažįstant
# naujas automobilis lyginamas ir su jais (Tip-Adapter principu: panašumas į pavyzdžius pridedamas prie
# teksto palyginimo), todėl modeliai atpažįstami iš to paties aukščio ir kampo, kaip filmuojate.
# ---------------------------------------------------------------------------
GALLERY_DIR = os.environ.get("ATEA_AI_VEHICLE_GALLERY", "/models/custom/vehicle_gallery")
ALPHA, BETA, TOPK = 15.0, 12.0, 3  # pavyzdžių svoris, panašumo „aštrumas“, kiek panašiausių imama (bandymai – žr. PR #137)
FIELDS = ("make", "model", "color", "body")


class Gallery:
    def __init__(self, root: str = GALLERY_DIR):
        self.root = root
        self.lock = threading.Lock()
        self.items: Optional[list] = None
        self.E: Optional[np.ndarray] = None

    def _index(self):
        return os.path.join(self.root, "index.json")

    def load(self):
        import json

        with self.lock:
            if self.items is not None:
                return
            items = []
            if os.path.isfile(self._index()):
                with open(self._index(), encoding="utf-8") as f:
                    items = json.load(f)
            E = None
            ep = os.path.join(self.root, "emb.npy")
            if os.path.isfile(ep):
                E = np.load(ep)
            if items and (E is None or len(E) != len(items) or E.shape[1] != _embed_dim()):
                # Vektoriai pasenę (pvz. pakeistas modelis) – perskaičiuojami iš išsaugotų nuotraukų
                imgs = [np.asarray(Image.open(os.path.join(self.root, f"{it['id']}.jpg")).convert("RGB")) for it in items]
                E = np.concatenate([embed(imgs[i : i + 16]).numpy() for i in range(0, len(imgs), 16)]).astype(np.float32)
                np.save(ep, E)
            self.items, self.E = items, E if E is not None else np.zeros((0, _embed_dim()), np.float32)

    def _save(self):
        import json

        os.makedirs(self.root, exist_ok=True)
        tmp = self._index() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.items, f, ensure_ascii=False)
        os.replace(tmp, self._index())
        np.save(os.path.join(self.root, "emb.npy"), self.E)

    def add(self, images: list, meta: dict) -> list:
        import uuid

        self.load()
        f = embed(images).numpy().astype(np.float32)
        ids = []
        with self.lock:
            os.makedirs(self.root, exist_ok=True)
            for img, v in zip(images, f):
                i = uuid.uuid4().hex[:16]
                Image.fromarray(img).save(os.path.join(self.root, f"{i}.jpg"), quality=92)
                self.items.append({"id": i, "created": time.time(), **{k: meta.get(k) or None for k in (*FIELDS, "kind", "group", "plate")}})
                self.E = np.vstack([self.E, v[None]])
                ids.append(i)
            self._save()
        return ids

    def delete(self, ids: set) -> int:
        self.load()
        with self.lock:
            keep = [k for k, it in enumerate(self.items) if it["id"] not in ids and it.get("group") not in ids]
            gone = [it for k, it in enumerate(self.items) if k not in set(keep)]
            for it in gone:
                try:
                    os.remove(os.path.join(self.root, f"{it['id']}.jpg"))
                except OSError:
                    pass
            self.items = [self.items[k] for k in keep]
            self.E = self.E[keep] if len(keep) else np.zeros((0, self.E.shape[1]), np.float32)
            self._save()
        return len(gone)

    def scores(self, f: np.ndarray, field: str, heavy: bool, where: Optional[dict] = None) -> dict:
        """Etiketė → kelių panašiausių jos pavyzdžių exp(-β(1 − panašumas)) vidurkis.
        Vidurkis (ne suma), kad daug pavyzdžių turinti etiketė neužgožtų kitų vien kiekiu."""
        self.load()
        if not self.items:
            return {}
        sims = self.E @ f
        per: dict = {}
        for it, sm in zip(self.items, sims):
            lab = it.get(field)
            if not lab or (it.get("kind") in ("truck", "bus")) != heavy:
                continue
            if where and any(it.get(k) != v for k, v in where.items()):
                continue
            per.setdefault(lab, []).append(float(sm))
        return {lab: float(np.mean(np.exp(-BETA * (1.0 - np.sort(v)[::-1][:TOPK])))) for lab, v in per.items()}


def _embed_dim() -> int:
    st = _load()
    if "dim" not in st:
        st["dim"] = int(embed([np.zeros((32, 32, 3), np.uint8)]).shape[1])
    return st["dim"]


GALLERY = Gallery()


def _choose(f_t, f_np, labels: list, prompts: list, field: str, heavy: bool, th: float, where=None, extra_prompt=None):
    """Teksto palyginimas + galerijos pavyzdžiai. Etiketės, kurios yra tik galerijoje, pridedamos."""
    gal = GALLERY.scores(f_np, field, heavy, where)
    tail = 1 if labels and labels[-1] == OTHER else 0  # „kita…“ – visada paskutinė
    bl, bp = list(labels[: len(labels) - tail]), list(prompts[: len(prompts) - tail])
    for lab in gal:
        if lab not in bl:
            bl.append(lab)
            bp.append(extra_prompt(lab) if extra_prompt else f"a photo of a {lab}.")
    labels, prompts = bl + list(labels[len(labels) - tail :]), bp + list(prompts[len(prompts) - tail :])
    lg = _logits(f_t, prompts)
    if gal:
        lg = lg + ALPHA * np.array([gal.get(lab, 0.0) for lab in labels])
    return _pick(_softmax(lg), labels, th), len(gal)


def describe(images: list, kind: str = "car") -> dict:
    """images – to paties automobilio iškarpos (RGB numpy); kind – car / truck / bus (detektoriaus klasė).
    Grąžina požymius su tikimybėmis; value = None – neatpažinta (guess – spėjimas, kurio rodyti kaip fakto nereikėtų)."""
    side = max(min(i.shape[:2]) for i in images)
    f = embed(images).mean(0, keepdim=True)
    f = f / f.norm(dim=-1, keepdim=True)
    f_np = f[0].numpy().astype(np.float32)
    heavy = kind in ("truck", "bus")
    out: dict = {"side": int(side), "frames": len(images), "year": None, "gallery": 0}

    def attr(name, labels, prompts, where=None, extra=None):
        if side < MIN_SIDE[name]:
            out[name] = {"value": None, "p": 0.0, "small": True}
            return None
        out[name], n = _choose(f, f_np, labels, prompts, name, heavy, TH[name], where, extra)
        out["gallery"] = max(out["gallery"], n)
        if out[name].get("value") == OTHER or out[name].get("guess") == OTHER:
            out[name] = {"value": None, "p": out[name]["p"], "other": True}
        return out[name].get("value")

    attr("color", list(COLORS), [f"a photo of a {c} car." for c in COLORS])
    attr("body", list(BODIES), [f"a photo of a {b}." for b in BODIES])
    table = HEAVY if heavy else MAKES  # sunkvežimiams / autobusams – tik jų markės ir modeliai
    makes = list(table)
    noun = {"truck": "truck", "bus": "bus"}.get(kind, "car")
    # Papildomi variantai „kita markė“ / „kitas modelis“: jei jie laimi – neatpažinta, užuot priskyrus
    # artimiausią sąraše (bandymuose dauguma modelio klaidų – modelio nebuvo sąraše)
    make = attr("make", makes + [OTHER], [f"a photo of a {k} {noun}." for k in makes] + [f"a photo of a {noun} of some other brand."],
                extra=lambda k: f"a photo of a {k} {noun}.")
    if make:
        models = table.get(make, [])
        attr("model", models + [OTHER], [f"a photo of a {make} {mo}." for mo in models] + [f"a photo of a {make} {noun} of some other model."],
             where={"make": make}, extra=lambda mo: f"a photo of a {make} {mo}.")
    else:
        out["model"] = {"value": None, "p": 0.0}
    # Lietuviški pavadinimai sąsajai
    for name, table in (("color", COLORS), ("body", BODIES)):
        v = out[name].get("value")
        if v and v in table:
            out[name]["lt"] = table[v]
    return out


def warmup():
    _load()
