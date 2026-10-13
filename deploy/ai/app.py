"""Atea 3D Matuoklis – vietinė AI paslauga.

Veikia jūsų serveryje / kompiuteryje, be interneto ir be mokamų paslaugų:
  * /detect  – transporto (automobilių, sunkvežimių, autobusų…) aptikimas vaizde iš viršaus.
               Modelis: RF-DETR (Roboflow, Apache 2.0), apmokytas su COCO.
  * /segment – objekto kontūras vienu spustelėjimu (pvz. krūvos kraštas).
               Modelis: MobileSAM (Apache 2.0) – lengva Segment Anything versija.

Naršyklė atsiunčia ortografinį vaizdą (PNG) – grąžinamos pikselių koordinatės,
kurias programa paverčia LKS-94 / modelio koordinatėmis.
"""
from __future__ import annotations

import io
import os
import threading
import time
from typing import Optional

import cv2
import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

MODELS_DIR = os.environ.get("ATEA_AI_MODELS", "/models")
DETECTOR_SIZE = os.environ.get("ATEA_AI_DETECTOR", "medium")  # nano | small | medium
DEVICE = os.environ.get("ATEA_AI_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
torch.set_num_threads(int(os.environ.get("ATEA_AI_THREADS", os.cpu_count() or 4)))

# COCO klasės, kurios aktualios dronų vaizdams
COCO = {1: "person", 2: "bicycle", 3: "car", 4: "motorcycle", 5: "airplane", 6: "bus", 7: "train", 8: "truck", 9: "boat"}
VEHICLES = {"car", "truck", "bus", "motorcycle"}

app = FastAPI(title="Atea 3D AI", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_lock = threading.Lock()
_detector = None
_sam = None


# ---------------------------------------------------------------------------
# Modelių įkėlimas (tingus – tik pirmą kartą prireikus)
# ---------------------------------------------------------------------------
def get_detector():
    global _detector
    with _lock:
        if _detector is None:
            import rfdetr

            cls = {"nano": "RFDETRNano", "small": "RFDETRSmall", "medium": "RFDETRMedium"}[DETECTOR_SIZE]
            weights = os.path.join(MODELS_DIR, f"rf-detr-{DETECTOR_SIZE}.pth")
            kwargs = {"pretrain_weights": weights} if os.path.exists(weights) else {}
            t0 = time.time()
            model = getattr(rfdetr, cls)(device=DEVICE, **kwargs)
            try:
                model.optimize_for_inference()
            except Exception:  # pragma: no cover – neprivaloma
                pass
            _detector = model
            print(f"[ai] RF-DETR {DETECTOR_SIZE} įkeltas per {time.time() - t0:.1f} s ({DEVICE})", flush=True)
        return _detector


def get_sam():
    global _sam
    with _lock:
        if _sam is None:
            from mobile_sam import SamPredictor, sam_model_registry

            t0 = time.time()
            sam = sam_model_registry["vit_t"](checkpoint=os.path.join(MODELS_DIR, "mobile_sam.pt"))
            sam.to(DEVICE).eval()
            _sam = SamPredictor(sam)
            print(f"[ai] MobileSAM įkeltas per {time.time() - t0:.1f} s ({DEVICE})", flush=True)
        return _sam


def read_image(data: bytes) -> np.ndarray:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Netinkamas vaizdas: {e}") from e
    if img.mode == "RGBA":
        # Permatomos vietos (už modelio ribų) – juodos
        bg = Image.new("RGB", img.size, (0, 0, 0))
        bg.paste(img, mask=img.split()[3])
        img = bg
    return np.asarray(img.convert("RGB"))


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    return {
        "ok": True,
        "device": DEVICE,
        "detector": f"RF-DETR {DETECTOR_SIZE} (Apache 2.0)",
        "segmenter": "MobileSAM (Apache 2.0)",
        "detector_loaded": _detector is not None,
        "segmenter_loaded": _sam is not None,
        "weights": sorted(os.listdir(MODELS_DIR)) if os.path.isdir(MODELS_DIR) else [],
    }


def _nms(boxes: np.ndarray, scores: np.ndarray, iou: float) -> list[int]:
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.clip(xx2 - xx1, 0, None) * np.clip(yy2 - yy1, 0, None)
        area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
        ovr = inter / (area[i] + area[order[1:]] - inter + 1e-9)
        # Taip pat šaliname dėžutes, kurios beveik visiškai yra kitos viduje (plytelių kraštai)
        inside = inter / (area[order[1:]] + 1e-9)
        order = order[1:][(ovr < iou) & (inside < 0.8)]
    return keep


@app.post("/detect")
async def detect(
    image: UploadFile = File(...),
    classes: str = Form("car,truck,bus,motorcycle"),
    threshold: float = Form(0.5),
    tile: int = Form(640),
    overlap: int = Form(128),
):
    """Aptinka objektus dideliame vaizde, skaidydamas jį į persidengiančias plyteles."""
    img = read_image(await image.read())
    want = {c.strip() for c in classes.split(",") if c.strip()} or VEHICLES
    model = get_detector()
    h, w = img.shape[:2]
    tile = max(256, min(tile, 2048))
    step = max(64, tile - overlap)
    boxes, scores, labels = [], [], []
    t0 = time.time()
    ys = list(range(0, max(1, h - overlap), step)) or [0]
    xs = list(range(0, max(1, w - overlap), step)) or [0]
    n_tiles = 0
    for y0 in ys:
        for x0 in xs:
            crop = img[y0 : y0 + tile, x0 : x0 + tile]
            if crop.size == 0 or crop.mean() < 2:  # tuščia (už modelio ribų)
                continue
            n_tiles += 1
            det = model.predict(Image.fromarray(crop), threshold=threshold)
            for (x1, y1, x2, y2), s, c in zip(det.xyxy, det.confidence, det.class_id):
                name = COCO.get(int(c))
                if name not in want:
                    continue
                boxes.append([x1 + x0, y1 + y0, x2 + x0, y2 + y0])
                scores.append(float(s))
                labels.append(name)
    out = []
    if boxes:
        b, s, lab = np.array(boxes, dtype=float), np.array(scores), np.array(labels)
        # Pirmiausia kiekvienai klasei, po to tarp klasių (pvz. „car“ ir „bus“ tam pačiam objektui)
        keep = []
        for name in set(labels):
            idx = np.where(lab == name)[0]
            keep += [int(idx[k]) for k in _nms(b[idx], s[idx], 0.5)]
        keep = np.array(keep)
        for k in _nms(b[keep], s[keep], 0.6):
            i = int(keep[k])
            out.append({"class": str(lab[i]), "score": round(float(s[i]), 3), "box": [round(float(v), 1) for v in b[i]]})
        out.sort(key=lambda d: -d["score"])
    return {"width": w, "height": h, "tiles": n_tiles, "seconds": round(time.time() - t0, 2), "detections": out}


@app.post("/segment")
async def segment(
    image: UploadFile = File(...),
    x: float = Form(...),
    y: float = Form(...),
    neg: Optional[str] = Form(None),
    simplify: float = Form(0.004),
):
    """Grąžina objekto, ant kurio spustelėta, kontūrą (pikseliais)."""
    img = read_image(await image.read())
    h, w = img.shape[:2]
    if not (0 <= x < w and 0 <= y < h):
        raise HTTPException(400, "Taškas už vaizdo ribų")
    pts = [[x, y]]
    lbl = [1]
    if neg:
        for p in neg.split(";"):
            if p.strip():
                nx, ny = map(float, p.split(","))
                pts.append([nx, ny])
                lbl.append(0)
    pred = get_sam()
    t0 = time.time()
    with _lock:
        pred.set_image(img)
        masks, scores, _ = pred.predict(point_coords=np.array(pts), point_labels=np.array(lbl), multimask_output=True)
    # Renkamės didžiausią patikimą kaukę (krūvos dažnai segmentuojamos per smulkiai)
    order = np.argsort(-scores)
    best = int(order[0])
    for k in order:
        if scores[k] >= scores[order[0]] - 0.08 and masks[k].sum() > masks[best].sum():
            best = int(k)
    mask = masks[best].astype(np.uint8)
    # Tik ta sritis, kurioje yra spustelėtas taškas
    n, comp = cv2.connectedComponents(mask)
    cid = comp[int(y), int(x)]
    if cid == 0:
        cid = int(np.argmax(np.bincount(comp.ravel())[1:]) + 1) if n > 1 else 0
    mask = (comp == cid).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        raise HTTPException(422, "Objekto nepavyko atskirti")
    c = max(contours, key=cv2.contourArea)
    eps = max(1.0, simplify * cv2.arcLength(c, True))
    poly = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
    touches = bool(mask[0, :].any() or mask[-1, :].any() or mask[:, 0].any() or mask[:, -1].any())
    return {
        "width": w,
        "height": h,
        "score": round(float(scores[best]), 3),
        "area_px": int((mask > 0).sum()),
        "touches_border": touches,
        "polygon": poly.astype(float).tolist(),
        "seconds": round(time.time() - t0, 2),
    }
