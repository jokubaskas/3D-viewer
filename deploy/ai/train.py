"""Atea 3D Matuoklis – savo AI modelio mokymas (RF-DETR, Apache 2.0) iš YOLO duomenų rinkinio.

Paleidžiamas AI paslaugos (app.py) kaip atskiras procesas:
    python train.py <rinkinys.zip|aplankas> <darbo aplankas> --size medium --epochs 40 --name "Šalmai"

Rinkinys – Label Studio / CVAT / Roboflow YOLO eksportas: images/, labels/ ir classes.txt (arba data.yaml).
Rinkinys padalijamas į mokymo (85 %) ir patikros (15 %) dalis, mokoma nuo COCO svorių (fine-tuning),
geriausias modelis išsaugomas į /models/custom/<id>/ kartu su klasių sąrašu ir rezultatais.
Būsena rašoma į <darbo aplankas>/status.json – ją skaito programa.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import sys
import threading
import time
import zipfile
from pathlib import Path

MODELS_DIR = Path(os.environ.get("ATEA_AI_MODELS", "/models"))
CUSTOM_DIR = MODELS_DIR / "custom"
IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
# Pradiniai COCO svoriai: kelios nuorodos ir MD5 (kaip rfdetr ModelWeights)
WEIGHTS = {
    "nano": "fb6504cce7fbdc783f7a46991f07639f",
    "small": "fb37061c1af7bace359c91b723a8d5c1",
    "medium": "7223f764a87b863f02eb8d52bf0ce2ee",
}
WEIGHT_URLS = (
    "https://repo.roboflow.com/rfdetr/{s}_coco/checkpoint_best_regular.pth",
    "https://storage.googleapis.com/rfdetr/{s}_coco/checkpoint_best_regular.pth",
)


class Status:
    def __init__(self, path: Path):
        self.path = path
        self.data = {"phase": "preparing", "epoch": 0, "epochs": 0, "started": time.time(), "message": ""}
        self.write()

    def set(self, **kw):
        self.data.update(kw)
        self.write()

    def write(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)


def _md5(path: Path) -> str:
    import hashlib

    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_weights(size: str, dest: Path, st: Status, attempts: int = 8) -> None:
    """Atsisiunčia pradinius svorius patikimai: pakartojimai, tęsimas nuo nutrūkusios vietos, atsarginė nuoroda."""
    import requests

    want = WEIGHTS[size]
    if dest.exists() and _md5(dest) == want:
        return
    part = dest.with_suffix(".part")
    last_err = None
    for i in range(attempts):
        url = WEIGHT_URLS[i % len(WEIGHT_URLS)].format(s=size)
        have = part.stat().st_size if part.exists() else 0
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            with requests.get(url, stream=True, timeout=(20, 120), headers=headers) as r:
                if r.status_code == 416:  # jau viskas atsiųsta
                    pass
                else:
                    r.raise_for_status()
                    if have and r.status_code != 206:  # serveris netęsia – iš naujo
                        have = 0
                    total = have + int(r.headers.get("Content-Length") or 0)
                    shown = 0.0
                    with open(part, "ab" if have else "wb") as f:
                        for chunk in r.iter_content(1 << 20):
                            f.write(chunk)
                            have += len(chunk)
                            if total and time.time() - shown > 2:
                                shown = time.time()
                                st.set(phase="downloading", download=round(100 * have / total), message="")
            if _md5(part) == want:
                part.replace(dest)
                st.set(download=100, message="")
                return
            part.unlink(missing_ok=True)  # sugadintas failas – iš naujo
            last_err = RuntimeError("MD5 nesutampa")
        except Exception as e:  # noqa: BLE001 – tinklo klaidos kartojamos
            last_err = e
        wait = min(60, 5 * (i + 1))
        print(f"[mokymas] svorių atsisiuntimas nepavyko ({last_err}); kartojama po {wait} s", flush=True)
        st.set(phase="downloading", message=f"Ryšys nutrūko, kartojama ({i + 1}/{attempts})…")
        time.sleep(wait)
    raise RuntimeError(
        f"Nepavyko atsisiųsti pradinių modelio svorių ({last_err}). Patikrinkite interneto ryšį ir pabandykite dar kartą "
        f"arba įdėkite failą rf-detr-{size}.pth rankiniu būdu."
    )


def find_dataset(root: Path) -> tuple[Path, Path, list[str]]:
    """Randa images/ ir labels/ aplankus bei klasių sąrašą (bet kuriame gylyje)."""
    labels_dir = None
    for p in sorted(root.rglob("labels")):
        if p.is_dir() and (p.parent / "images").is_dir():
            labels_dir = p
            break
    if labels_dir is None:
        raise SystemExit("Rinkinyje nerasta aplankų images/ ir labels/ (YOLO formatas).")
    base = labels_dir.parent
    names: list[str] = []
    for cand in [base / "classes.txt", *root.rglob("classes.txt")]:
        if cand.is_file():
            names = [l.strip() for l in cand.read_text(encoding="utf-8").splitlines() if l.strip()]
            break
    if not names:
        for cand in [*base.glob("data.y*ml"), *root.rglob("data.y*ml")]:
            import yaml

            data = yaml.safe_load(cand.read_text(encoding="utf-8")) or {}
            n = data.get("names")
            names = [n[k] for k in sorted(n)] if isinstance(n, dict) else list(n or [])
            if names:
                break
    if not names:
        raise SystemExit("Nerastas klasių sąrašas (classes.txt arba data.yaml).")
    return base / "images", labels_dir, names


PERSON_RE = re.compile(r"^(person|people|human|zmogus|žmogus|žmonės|zmones|worker|darbuotojas)$", re.I)
ATTR_RE = re.compile(r"helmet|hard.?hat|šalm|salm|vest|liemen", re.I)


def _iou(a, b) -> float:
    """IoU dviem YOLO dėžutėms (cx, cy, w, h; 0…1)."""
    ax1, ay1, ax2, ay2 = a[0] - a[2] / 2, a[1] - a[3] / 2, a[0] + a[2] / 2, a[1] + a[3] / 2
    bx1, by1, bx2, by2 = b[0] - b[2] / 2, b[1] - b[3] / 2, b[0] + b[2] / 2, b[1] + b[3] / 2
    iw, ih = max(0.0, min(ax2, bx2) - max(ax1, bx1)), max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = iw * ih
    return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-12)


def dedupe_people(lines: list[str], names: list[str]) -> tuple[list[str], int]:
    """Žmogus pažymėtas du kartus – „person“ ir „helmet“ / „no_helmet“ per visą žmogų: paliekame tik pastarąjį.

    Tas pats objektas su dviem klasėmis trukdo mokytis (klasės konkuruoja) ir aptikime vienas rėmelis
    panaikintų kitą, todėl „person“ dėžutė, beveik sutampanti su šalmo / be šalmo dėžute, pašalinama.
    """
    person = {i for i, n in enumerate(names) if PERSON_RE.match(n.strip())}
    attr = {i for i, n in enumerate(names) if ATTR_RE.search(n)}
    if not person or not attr:
        return lines, 0
    parsed = [(int(l.split()[0]), [float(v) for v in l.split()[1:5]]) for l in lines]
    attr_boxes = [b for c, b in parsed if c in attr]
    out, removed = [], 0
    for line, (c, b) in zip(lines, parsed):
        if c in person and any(_iou(b, a) > 0.7 for a in attr_boxes):
            removed += 1
            continue
        out.append(line)
    return out, removed


def prepare(src: Path, work: Path, val_share: float = 0.15, seed: int = 7):
    """Išskleidžia rinkinį ir sudeda į RF-DETR (Roboflow / YOLO) struktūrą: train/ ir valid/."""
    raw = work / "raw"
    if raw.exists():
        shutil.rmtree(raw)
    if src.is_file() and zipfile.is_zipfile(src):
        with zipfile.ZipFile(src) as z:
            z.extractall(raw)
    elif src.is_dir():
        shutil.copytree(src, raw)
    else:
        raise SystemExit(f"Rinkinys nerastas: {src}")
    images_dir, labels_dir, names = find_dataset(raw)

    pairs, empty, boxes, per_class, dup = [], 0, 0, [0] * len(names), 0
    for img in sorted(images_dir.iterdir()):
        if img.suffix.lower() not in IMG_EXT:
            continue
        lab = labels_dir / (img.stem + ".txt")
        lines = []
        if lab.exists():
            for line in lab.read_text(encoding="utf-8").splitlines():
                v = line.split()
                if len(v) < 5:
                    continue
                c = int(float(v[0]))
                if 0 <= c < len(names):
                    lines.append(" ".join([str(c), *v[1:5]]))
        lines, removed = dedupe_people(lines, names)
        dup += removed
        for l in lines:
            per_class[int(l.split()[0])] += 1
        boxes += len(lines)
        empty += not lines
        pairs.append((img, lines))
    if len(pairs) < 4:
        raise SystemExit(f"Per mažai kadrų mokymui: {len(pairs)} (reikia bent 4, rekomenduojama 300+).")

    random.Random(seed).shuffle(pairs)
    n_val = max(1, round(len(pairs) * val_share))
    ds = work / "dataset"
    if ds.exists():
        shutil.rmtree(ds)
    for split, items in (("valid", pairs[:n_val]), ("train", pairs[n_val:])):
        (ds / split / "images").mkdir(parents=True)
        (ds / split / "labels").mkdir(parents=True)
        for img, lines in items:
            # Label Studio pavadinimuose būna tarpų ir lietuviškų raidžių – supaprastiname
            stem = re.sub(r"[^\w.-]+", "_", img.stem)
            shutil.copy2(img, ds / split / "images" / (stem + img.suffix.lower()))
            (ds / split / "labels" / (stem + ".txt")).write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    yaml_text = "path: .\ntrain: train/images\nval: valid/images\nnames:\n" + "".join(f"  {i}: {json.dumps(n, ensure_ascii=False)}\n" for i, n in enumerate(names))
    (ds / "data.yaml").write_text(yaml_text, encoding="utf-8")
    stats = {"images": len(pairs), "train": len(pairs) - n_val, "valid": n_val, "boxes": boxes, "empty": empty, "per_class": dict(zip(names, per_class)), "person_duplicates_removed": dup}
    return ds, names, stats


def read_metrics(out: Path) -> dict:
    """Geriausi patikros rezultatai (mAP) iš RF-DETR žurnalo, jei jis yra."""
    best = {}
    for f in [out / "log.txt", *out.rglob("metrics.csv")]:
        if not f.exists():
            continue
        try:
            if f.suffix == ".txt":
                for line in f.read_text(encoding="utf-8").splitlines():
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    ap = r.get("test_coco_eval_bbox") or r.get("ema_test_coco_eval_bbox")
                    if ap and ap[0] >= best.get("map50_95", -1):
                        best = {"map50_95": round(ap[0], 4), "map50": round(ap[1], 4), "epoch": r.get("epoch")}
            else:
                import csv

                for r in csv.DictReader(f.open(encoding="utf-8")):
                    for k50, k in (("val/mAP_50", "val/mAP_50_95"), ("val/map50", "val/map")):
                        if r.get(k):
                            v = float(r[k])
                            if v >= best.get("map50_95", -1):
                                best = {"map50_95": round(v, 4), "map50": round(float(r.get(k50) or 0), 4), "epoch": r.get("epoch")}
        except Exception:
            pass
    return best


def last_epoch(out: Path):
    """Paskutinė baigta epocha (1…N) pagal RF-DETR žurnalus."""
    best = None
    for f in [out / "log.txt", *out.rglob("metrics.csv")]:
        if not f.exists():
            continue
        try:
            if f.suffix == ".txt":
                for line in f.read_text(encoding="utf-8").splitlines():
                    try:
                        e = json.loads(line).get("epoch")
                    except Exception:
                        continue
                    if e is not None:
                        best = max(best or 0, int(e) + 1)
            else:
                import csv

                for r in csv.DictReader(f.open(encoding="utf-8")):
                    if r.get("epoch") not in (None, ""):
                        best = max(best or 0, int(float(r["epoch"])) + 1)
        except Exception:
            pass
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset")
    ap.add_argument("work")
    ap.add_argument("--size", default=os.environ.get("ATEA_AI_DETECTOR", "medium"), choices=["nano", "small", "medium"])
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=2)
    ap.add_argument("--name", default="Savas modelis")
    ap.add_argument("--id", default=time.strftime("%Y%m%d-%H%M%S"))
    a = ap.parse_args()

    work = Path(a.work)
    work.mkdir(parents=True, exist_ok=True)
    st = Status(work / "status.json")
    try:
        ds, names, stats = prepare(Path(a.dataset), work)
        st.set(phase="training", epochs=a.epochs, classes=names, stats=stats, message="")
        print(f"[mokymas] {stats}", flush=True)

        import torch
        import rfdetr

        threads = int(os.environ.get("ATEA_AI_THREADS", os.cpu_count() or 4))
        torch.set_num_threads(threads)
        cls = {"nano": "RFDETRNano", "small": "RFDETRSmall", "medium": "RFDETRMedium"}[a.size]
        # Pradiniai COCO svoriai: AI paslaugos dydžiui – jau atvaizde; kitiems – atsisiunčiami vieną kartą į tomą
        weights = MODELS_DIR / f"rf-detr-{a.size}.pth"
        if not weights.exists():
            (CUSTOM_DIR / "_weights").mkdir(parents=True, exist_ok=True)
            weights = CUSTOM_DIR / "_weights" / f"rf-detr-{a.size}.pth"
            fetch_weights(a.size, weights, st)
            st.set(phase="training", message="")
        model = getattr(rfdetr, cls)(pretrain_weights=str(weights))
        out = work / "output"
        device = "cuda" if torch.cuda.is_available() else "cpu"

        # Eiga: atskira gija kas 10 s skaito RF-DETR rezultatų failus (paskutinė epocha, mAP)
        t_train = time.time()
        stop = threading.Event()

        def watch():
            while not stop.wait(10):
                e = last_epoch(out)
                if e is None:
                    continue
                el = time.time() - t_train
                st.set(epoch=e, eta=round(el / e * (a.epochs - e)) if e else None, metrics=read_metrics(out))

        threading.Thread(target=watch, daemon=True).start()
        try:
            model.train(
                dataset_dir=str(ds),
                dataset_file="yolo",
                epochs=a.epochs,
                batch_size=a.batch,
                # Mažam rinkiniui – be kaupimo (daugiau svorių atnaujinimų per epochą)
                grad_accum_steps=1 if stats["train"] < 400 else max(1, 8 // a.batch),
                lr=1e-4,
                output_dir=str(out),
                device=device,
                num_workers=0,
                early_stopping=True,
                run_test=False,
                progress_bar=False,
            )
        finally:
            stop.set()

        ckpt = None
        # Mažas patikros rinkinys greitai „prisisotina“ (mAP = 1 jau po kelių epochų), tada „geriausias“ modelis
        # būtų beveik neapmokytas – tokiu atveju imame paskutinį (EMA) modelį.
        ckpt_names = ("checkpoint_best_total.pth", "checkpoint_best_ema.pth", "checkpoint_best_regular.pth", "checkpoint.pth")
        if stats["valid"] < 30:
            ckpt_names = ("last_ema.pth", *ckpt_names)
        for nm in ckpt_names:
            found = sorted(out.rglob(nm))
            if found:
                ckpt = found[0]
                break
        if ckpt is None:
            found = sorted(out.rglob("*.pth")) + sorted(out.rglob("*.ckpt"))
            ckpt = found[-1] if found else None
        if ckpt is None:
            raise SystemExit("Mokymas baigėsi, bet modelio failas nerastas.")

        dest = CUSTOM_DIR / a.id
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ckpt, dest / "model.pth")
        meta = {
            "id": a.id,
            "name": a.name,
            "size": a.size,
            "classes": names,
            "created": time.strftime("%Y-%m-%d %H:%M"),
            "epochs": a.epochs,
            "seconds": round(time.time() - st.data["started"]),
            "stats": stats,
            "metrics": read_metrics(out),
            "device": device,
        }
        (dest / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        st.set(phase="done", epoch=last_epoch(out) or a.epochs, model=meta, message="")
        # Darbiniai failai dideli (kontroliniai taškai ~0,5 GB) – paliekame tik žurnalą ir rezultatus
        for f in out.rglob("metrics.csv"):
            shutil.copy2(f, work / "metrics.csv")
        shutil.rmtree(out, ignore_errors=True)
        shutil.rmtree(work / "raw", ignore_errors=True)
        shutil.rmtree(work / "dataset", ignore_errors=True)
        (work / "dataset.zip").unlink(missing_ok=True)
    except SystemExit as e:
        st.set(phase="error", message=str(e))
        raise
    except Exception as e:  # pragma: no cover
        st.set(phase="error", message=f"{type(e).__name__}: {e}")
        raise


if __name__ == "__main__":
    main()
