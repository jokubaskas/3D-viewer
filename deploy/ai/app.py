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
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from starlette.concurrency import run_in_threadpool
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
_det_lock = threading.Lock()  # detektorius – po vieną plytelę (kelios užklausos vienu metu)
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


def _judge(name: str, length: float, width: float) -> Optional[str]:
    """Ar objektas su tokiais matmenimis (m) gali būti transporto priemonė; grąžina patikslintą klasę.

    Iš viršaus COCO modelis dažnai painioja automobilį, sunkvežimį ir autobusą, todėl klasė
    nustatoma pagal ilgį. Suoliukai, akmenys, šuliniai ir pan. atmetami kaip per maži.
    """
    if name == "motorcycle":
        return name if 1.2 <= length <= 3.0 and 0.4 <= width <= 1.5 else None
    if length < 2.6 or width < 1.2 or width > 3.4 or length > 25:
        return None
    if length <= 6.4:
        return "car" if name == "bus" else name  # mažas „sunkvežimis“ – pikapas / furgonas
    return "truck" if name == "car" else name


def _refine(img: np.ndarray, box) -> Optional[dict]:
    """MobileSAM kaukė detektoriaus dėžutės viduje -> pasuktas stačiakampis (tikras ilgis, plotis, kryptis)."""
    h, w = img.shape[:2]
    x1, y1, x2, y2 = box
    m = 0.3 * max(x2 - x1, y2 - y1) + 8
    cx0, cy0 = int(max(0, x1 - m)), int(max(0, y1 - m))
    cx1, cy1 = int(min(w, x2 + m)), int(min(h, y2 + m))
    crop = img[cy0:cy1, cx0:cx1]
    if crop.shape[0] < 8 or crop.shape[1] < 8:
        return None
    pred = get_sam()
    with _lock:
        pred.set_image(np.ascontiguousarray(crop))
        masks, scores, _ = pred.predict(box=np.array([x1 - cx0, y1 - cy0, x2 - cx0, y2 - cy0]), multimask_output=True)
    # Iš beveik vienodai patikimų kaukių – mažiausia (didesnės dažnai apima šešėlį ar gretimą automobilį)
    good = [k for k in range(len(scores)) if scores[k] >= scores.max() - 0.05]
    best = min(good, key=lambda k: masks[k].sum())
    mask = masks[best].astype(np.uint8)
    n, comp, stats, _ = cv2.connectedComponentsWithStats(mask)
    if n < 2:
        return None
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    mask = (comp == k).astype(np.uint8)
    area = float(mask.sum())
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    (rx, ry), (rw, rh), ang = cv2.minAreaRect(max(cnts, key=cv2.contourArea))
    # Kaukė turi sutapti su detektoriaus dėžute (kitaip SAM „išsiliejo“ į kelią ar pievą)
    bx, by, bw, bh = cv2.boundingRect(mask)
    ix = max(0.0, min(bx + bw, x2 - cx0) - max(bx, x1 - cx0))
    iy = max(0.0, min(by + bh, y2 - cy0) - max(by, y1 - cy0))
    inter = ix * iy
    iou = inter / (bw * bh + (x2 - x1) * (y2 - y1) - inter + 1e-9)
    fill = area / (rw * rh + 1e-9)
    if iou < 0.55 or fill < 0.6 or scores[best] < 0.6:
        return None
    pts = cv2.boxPoints(((rx + cx0, ry + cy0), (rw, rh), ang))
    length, width = max(rw, rh), min(rw, rh)
    # Kryptis: ilgosios ašies kampas nuo šiaurės (vaizdo viršaus), 0–180°
    v = pts[1] - pts[0] if np.linalg.norm(pts[1] - pts[0]) >= np.linalg.norm(pts[2] - pts[1]) else pts[2] - pts[1]
    heading = float(np.degrees(np.arctan2(v[0], -v[1]))) % 180.0
    return {"corners": pts.tolist(), "length": length, "width": width, "heading": heading}


class Cancelled(Exception):
    """Klientas atšaukė užklausą (uždarė ryšį)."""


async def _check(request: Request):
    if await request.is_disconnected():
        raise Cancelled()


def _predict(model, crop, threshold):
    with _det_lock:
        return model.predict(Image.fromarray(crop), threshold=threshold)


@app.post("/detect")
async def detect(
    request: Request,
    image: UploadFile = File(...),
    classes: str = Form("car,truck,bus,motorcycle"),
    threshold: float = Form(0.5),
    tile: int = Form(640),
    overlap: int = Form(128),
    gsd: float = Form(0.0),
    refine: bool = Form(True),
):
    """Aptinka objektus dideliame vaizde, skaidydamas jį į persidengiančias plyteles.

    gsd – vaizdo pikselio dydis metrais. Jei nurodytas, objektai patikrinami pagal tikrus matmenis,
    o klasė (automobilis / sunkvežimis / autobusas) patikslinama pagal ilgį.
    refine – kiekvienam objektui MobileSAM nustato tikslų (pasuktą) kontūrą.

    Skaičiavimai vyksta atskiroje gijoje po vieną plytelę; jei programa atšaukia užklausą
    (uždaro ryšį), darbas nutraukiamas ties kita plytele ir serveris iškart laisvas kitiems veiksmams.
    """
    try:
        return await _detect(request, image, classes, threshold, tile, overlap, gsd, refine)
    except Cancelled:
        print("[ai] /detect atšaukta", flush=True)
        return {"cancelled": True, "detections": []}


async def _detect(request, image, classes, threshold, tile, overlap, gsd, refine):
    img = read_image(await image.read())
    want = {c.strip() for c in classes.split(",") if c.strip()} or VEHICLES
    # Iš viršaus COCO modelis dažnai painioja automobilį, sunkvežimį ir autobusą – ieškome visų,
    # o galutinę klasę nustatome pagal matmenis.
    search = want | (VEHICLES - {"motorcycle"} if want & VEHICLES and gsd > 0 else set())
    model = await run_in_threadpool(get_detector)
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
            await _check(request)
            det = await run_in_threadpool(_predict, model, crop, threshold)
            for (x1, y1, x2, y2), s, c in zip(det.xyxy, det.confidence, det.class_id):
                name = COCO.get(int(c))
                if name not in search:
                    continue
                boxes.append([x1 + x0, y1 + y0, x2 + x0, y2 + y0])
                scores.append(float(s))
                labels.append(name)
    out = []
    rejected = 0
    if boxes:
        b, s, lab = np.array(boxes, dtype=float), np.array(scores), np.array(labels)
        # Pirmiausia kiekvienai klasei, po to tarp klasių (pvz. „car“ ir „bus“ tam pačiam objektui)
        keep = []
        for name in set(labels):
            idx = np.where(lab == name)[0]
            keep += [int(idx[k]) for k in _nms(b[idx], s[idx], 0.5)]
        keep = np.array(keep)
        for k in _nms(b[keep], s[keep], 0.5):
            i = int(keep[k])
            box = [float(v) for v in b[i]]
            name = str(lab[i])
            d = {"class": name, "score": round(float(s[i]), 3), "box": [round(v, 1) for v in box]}
            if refine:
                await _check(request)
            r = await run_in_threadpool(_refine, img, box) if refine else None
            if gsd > 0:
                cls = _judge(name, r["length"] * gsd, r["width"] * gsd) if r else None
                if not r:
                    # Be tikslaus kontūro – tikriname detektoriaus dėžutę. Pasuktas objektas
                    # ašinėje dėžutėje atrodo platesnis, todėl plotis ribojamas.
                    bw, bh = box[2] - box[0], box[3] - box[1]
                    cls = _judge(name, max(bw, bh) * gsd, min(bw, bh, 2.0 / gsd) * gsd)
                if not cls:
                    rejected += 1
                    continue
                d["class"] = name = cls
            if r:
                d["corners"] = [[round(float(x), 1), round(float(y), 1)] for x, y in r["corners"]]
                d["heading"] = round(r["heading"], 1)
                if gsd > 0:
                    d["length"], d["width"] = round(r["length"] * gsd, 2), round(r["width"] * gsd, 2)
            if name not in want:
                continue
            out.append(d)
        out.sort(key=lambda d: -d["score"])
    return {
        "width": w,
        "height": h,
        "tiles": n_tiles,
        "rejected": rejected,
        "refined": sum(1 for d in out if "corners" in d),
        "seconds": round(time.time() - t0, 2),
        "detections": out,
    }


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
    pred = await run_in_threadpool(get_sam)
    t0 = time.time()

    def run():
        with _lock:
            pred.set_image(img)
            return pred.predict(point_coords=np.array(pts), point_labels=np.array(lbl), multimask_output=True)

    masks, scores, _ = await run_in_threadpool(run)
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
