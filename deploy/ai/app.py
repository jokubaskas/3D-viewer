"""Atea 3D Matuoklis – vietinė AI paslauga.

Veikia jūsų serveryje / kompiuteryje, be interneto ir be mokamų paslaugų:
  * /detect  – transporto (automobilių, sunkvežimių, autobusų…) aptikimas vaizde iš viršaus.
               Modelis: RF-DETR (Roboflow, Apache 2.0), apmokytas su COCO.
  * /plates  – valstybinių numerių atpažinimas transporto iškarpose (fast-alpr, MIT);
               /plates/fuse – kelių kadrų sujungimas į ryškesnį numerio vaizdą.
  * /segment – objekto kontūras vienu spustelėjimu (pvz. krūvos kraštas).
               Modelis: MobileSAM (Apache 2.0) – lengva Segment Anything versija.

Naršyklė atsiunčia ortografinį vaizdą (PNG) – grąžinamos pikselių koordinatės,
kurias programa paverčia LKS-94 / modelio koordinatėmis.
"""
from __future__ import annotations

import base64
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from typing import Optional

import cv2
import numpy as np
import torch
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
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
CUSTOM_DIR = os.path.join(MODELS_DIR, "custom")  # savi modeliai (Docker tomas – išlieka atnaujinus)
_custom: dict = {}  # id -> (modelis, meta)
_train_proc: Optional[subprocess.Popen] = None
_train_job: Optional[str] = None
_train_cancelled: set = set()


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


def custom_models() -> list[dict]:
    out = []
    if os.path.isdir(CUSTOM_DIR):
        for d in sorted(os.listdir(CUSTOM_DIR)):
            meta = os.path.join(CUSTOM_DIR, d, "meta.json")
            if os.path.isfile(meta) and os.path.isfile(os.path.join(CUSTOM_DIR, d, "model.pth")):
                with open(meta, encoding="utf-8") as f:
                    out.append(json.load(f))
    return out


def active_model() -> str:
    try:
        with open(os.path.join(CUSTOM_DIR, "active.txt"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def get_custom(model_id: str):
    """Savas (apmokytas) modelis ir jo aprašas; įkeliamas vieną kartą."""
    with _lock:
        if model_id not in _custom:
            d = os.path.join(CUSTOM_DIR, os.path.basename(model_id))
            meta_path = os.path.join(d, "meta.json")
            if not os.path.isfile(meta_path):
                raise HTTPException(404, f"Modelis {model_id} nerastas")
            with open(meta_path, encoding="utf-8") as f:
                meta = json.load(f)
            import rfdetr

            cls = {"nano": "RFDETRNano", "small": "RFDETRSmall", "medium": "RFDETRMedium"}[meta.get("size", "medium")]
            t0 = time.time()
            model = getattr(rfdetr, cls)(device=DEVICE, pretrain_weights=os.path.join(d, "model.pth"))
            try:
                model.optimize_for_inference()
            except Exception:  # pragma: no cover
                pass
            _custom.clear()  # atmintyje laikome vieną savą modelį
            _custom[model_id] = (model, meta)
            print(f"[ai] savas modelis „{meta.get('name')}“ ({meta.get('size')}) įkeltas per {time.time() - t0:.1f} s", flush=True)
        return _custom[model_id]


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
        "plates": _has_alpr(),
        "raster": _has_rasterio(),
        "weights": sorted(os.listdir(MODELS_DIR)) if os.path.isdir(MODELS_DIR) else [],
        "custom_models": len(custom_models()),
        "active_model": active_model(),
        "training": _train_proc is not None and _train_proc.poll() is None,
    }


def _has_alpr() -> bool:
    try:
        import fast_alpr  # noqa: F401

        return True
    except ImportError:
        return False


def _has_rasterio() -> bool:
    try:
        import rasterio  # noqa: F401

        return True
    except ImportError:
        return False


# ---------------------------------------------------------------------------
# GeoTIFF perskaičiavimas į LKS-94 (ODM ortofoto / DSM / DTM kuriami UTM sistemoje)
# ---------------------------------------------------------------------------
def _warp_to_lks94(src_path: str, dst_path: str) -> dict:
    import rasterio
    from rasterio.enums import ColorInterp, Resampling
    from rasterio.warp import calculate_default_transform, reproject

    with rasterio.open(src_path) as src:
        if src.crs is None:
            raise HTTPException(400, "Rastras neturi koordinačių sistemos (ne GeoTIFF?)")
        dst_crs = "EPSG:3346"
        # Tas pats pikselio dydis kaip originale
        res = (abs(src.transform.a), abs(src.transform.e))
        transform, width, height = calculate_default_transform(src.crs, dst_crs, src.width, src.height, *src.bounds, resolution=res)
        is_float = src.dtypes[0].startswith("float")
        profile = src.profile.copy()
        profile.update(
            driver="GTiff", crs=dst_crs, transform=transform, width=width, height=height,
            tiled=True, blockxsize=512, blockysize=512, compress="deflate", predictor=3 if is_float else 2,
            BIGTIFF="IF_SAFER",
        )
        for k in ("photometric", "jpeg_quality", "interleave"):
            profile.pop(k, None)
        if src.count >= 3 and not is_float:
            profile["photometric"] = "RGB"
        interp = src.colorinterp
        with rasterio.open(dst_path, "w", **profile) as dst:
            dst.colorinterp = interp
            for b in range(1, src.count + 1):
                alpha = interp[b - 1] == ColorInterp.alpha
                reproject(
                    source=rasterio.band(src, b), destination=rasterio.band(dst, b),
                    src_transform=src.transform, src_crs=src.crs, dst_transform=transform, dst_crs=dst_crs,
                    src_nodata=src.nodata, dst_nodata=src.nodata,
                    resampling=Resampling.nearest if alpha else Resampling.bilinear,
                    num_threads=max(1, (os.cpu_count() or 2) - 1), warp_mem_limit=512,
                )
            # Peržiūros lygiai – greitesnis atidarymas GIS programose
            factors = [f for f in (2, 4, 8, 16, 32) if min(width, height) // f >= 256]
            if factors:
                dst.build_overviews(factors, Resampling.average)
        return {"width": width, "height": height, "src_crs": str(src.crs)}


@app.post("/raster/lks94")
async def raster_lks94(background: BackgroundTasks, file: UploadFile = File(...), name: str = Form("rastras")):
    """Perskaičiuoja GeoTIFF (pvz. ODM ortofoto UTM) į LKS-94 (EPSG:3346). Grąžina naują GeoTIFF."""
    if not _has_rasterio():
        raise HTTPException(501, "AI paslaugoje neįdiegta rasterio (GDAL) – perkurkite AI konteinerį")
    tmp = tempfile.mkdtemp(prefix="lks94_")
    background.add_task(shutil.rmtree, tmp, True)
    src_path, dst_path = os.path.join(tmp, "src.tif"), os.path.join(tmp, "dst.tif")
    with open(src_path, "wb") as f:
        await run_in_threadpool(shutil.copyfileobj, file.file, f, 8 << 20)
    t0 = time.time()
    try:
        info = await run_in_threadpool(_warp_to_lks94, src_path, dst_path)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Nepavyko perskaičiuoti rastro: {e}") from e
    print(f"[ai] {name}: {info['src_crs']} -> EPSG:3346, {info['width']}x{info['height']} per {time.time() - t0:.1f} s", flush=True)
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in name)[:80] or "rastras"
    return FileResponse(dst_path, media_type="image/tiff", filename=f"{safe}_LKS94.tif")


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


def _mask_outline(mask: np.ndarray, ox: float = 0.0, oy: float = 0.0, simplify: float = 0.01) -> Optional[list]:
    """Kaukės (didžiausios dalies) kontūras – supaprastintas daugiakampis vaizdo koordinatėmis."""
    m = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return None
    c = max(cnts, key=cv2.contourArea)
    if cv2.contourArea(c) < 4:
        return None
    eps = max(0.7, simplify * cv2.arcLength(c, True))
    poly = cv2.approxPolyDP(c, eps, True).reshape(-1, 2).astype(float)
    if len(poly) < 3:
        return None
    return [[round(float(x) + ox, 1), round(float(y) + oy, 1)] for x, y in poly]


def _box_iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    i = ix * iy
    return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i + 1e-9)


def _pick_mask(masks, scores, box, grow: float = 0.3):
    """Iš SAM kaukių – visas objektas: didžiausia patikima kaukė, kuri neišeina toli už detektoriaus dėžutės
    (detektorius iš viršaus dažnai apima tik dalį automobilio – be gaubto ar bagažinės). Šešėlis ar gretimas
    objektas išeina už išplėstos dėžutės, todėl tokios kaukės atmetamos. Grąžina indeksą arba None."""
    x1, y1, x2, y2 = box
    m = grow * max(x2 - x1, y2 - y1)
    best, area = None, -1
    for k in range(len(scores)):
        if scores[k] < max(0.5, scores.max() - 0.1):
            continue
        ys, xs = np.nonzero(masks[k])
        if not len(xs):
            continue
        mb = [xs.min(), ys.min(), xs.max() + 1, ys.max() + 1]
        if mb[0] < x1 - m or mb[1] < y1 - m or mb[2] > x2 + m or mb[3] > y2 + m or _box_iou(mb, box) < 0.4:
            continue
        if len(xs) > area:
            best, area = k, len(xs)
    return best


def _outlines(img: np.ndarray, boxes: list) -> list:
    """Tiesioginei transliacijai: vaizdas į MobileSAM įkeliamas vieną kartą, kiekvienam objektui – tik kaukės
    dekoderis (keli ms). Grąžina kontūrą arba None (kai kaukė „išsilieja“ už objekto dėžutės)."""
    if not boxes:
        return []
    pred = get_sam()
    out = []
    with _lock:
        pred.set_image(np.ascontiguousarray(img))
        for b in boxes:
            masks, scores, _ = pred.predict(box=np.array(b, float), multimask_output=True)
            k = _pick_mask(masks, scores, b)
            out.append(None if k is None else _mask_outline(masks[k]))
    return out


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
    # Visas objektas (didžiausia patikima kaukė, neišeinanti toli už dėžutės); jei tokios nėra – mažiausia iš
    # beveik vienodai patikimų (didesnės dažnai apima šešėlį ar gretimą automobilį) ir ji turi sutapti su dėžute
    full = _pick_mask(masks, scores, [x1 - cx0, y1 - cy0, x2 - cx0, y2 - cy0])
    if full is not None:
        best = full
    else:
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
    if full is None:
        # Kaukė turi sutapti su detektoriaus dėžute (kitaip SAM „išsiliejo“ į kelią ar pievą)
        bx, by, bw, bh = cv2.boundingRect(mask)
        if _box_iou([bx, by, bx + bw, by + bh], [x1 - cx0, y1 - cy0, x2 - cx0, y2 - cy0]) < 0.55 or scores[best] < 0.5:
            return None
    fill = area / (rw * rh + 1e-9)
    outline = _mask_outline(mask, cx0, cy0, 0.006)
    if fill < 0.6 or scores[best] < 0.6:
        # Ne stačiakampio formos objektas (žmogus, krūva, savo modelio klasė) – tik kontūras
        return {"outline": outline} if outline else None
    pts = cv2.boxPoints(((rx + cx0, ry + cy0), (rw, rh), ang))
    length, width = max(rw, rh), min(rw, rh)
    # Kryptis: ilgosios ašies kampas nuo šiaurės (vaizdo viršaus), 0–180°
    v = pts[1] - pts[0] if np.linalg.norm(pts[1] - pts[0]) >= np.linalg.norm(pts[2] - pts[1]) else pts[2] - pts[1]
    heading = float(np.degrees(np.arctan2(v[0], -v[1]))) % 180.0
    return {"corners": pts.tolist(), "length": length, "width": width, "heading": heading, "outline": outline}


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
    model: str = Form(""),
    outline: bool = Form(False),
):
    """Aptinka objektus dideliame vaizde, skaidydamas jį į persidengiančias plyteles.

    gsd – vaizdo pikselio dydis metrais. Jei nurodytas, objektai patikrinami pagal tikrus matmenis,
    o klasė (automobilis / sunkvežimis / autobusas) patikslinama pagal ilgį.
    refine – kiekvienam objektui MobileSAM nustato tikslų (pasuktą) kontūrą ir formą („outline“).
    outline – be refine (transliacijai): tik objektų forma, greitai – vaizdas į MobileSAM įkeliamas vieną kartą.

    Skaičiavimai vyksta atskiroje gijoje po vieną plytelę; jei programa atšaukia užklausą
    (uždaro ryšį), darbas nutraukiamas ties kita plytele ir serveris iškart laisvas kitiems veiksmams.
    """
    try:
        return await _detect(request, image, classes, threshold, tile, overlap, gsd, refine, model, outline)
    except Cancelled:
        print("[ai] /detect atšaukta", flush=True)
        return {"cancelled": True, "detections": []}


async def _detect(request, image, classes, threshold, tile, overlap, gsd, refine, model_id="", outline=False):
    img = read_image(await image.read())
    # Savas modelis: „custom“ – aktyvus, kitaip – nurodytas id; klasės – iš jo aprašo (indeksas = YOLO numeris)
    if model_id == "custom":
        model_id = active_model()
        if not model_id:
            raise HTTPException(404, "Aktyvus savas modelis nepasirinktas")
    names = COCO
    if model_id:
        model, meta = await run_in_threadpool(get_custom, model_id)
        names = dict(enumerate(meta["classes"]))
        want = {c.strip() for c in classes.split(",") if c.strip()} or set(meta["classes"])
        search = set(want)
        gsd = 0  # matmenų patikra – tik COCO transportui
    else:
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
                name = names.get(int(c))
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
                cls = _judge(name, r["length"] * gsd, r["width"] * gsd) if r and "length" in r else None
                if not r or "length" not in r:
                    # Be tikslaus kontūro – tikriname detektoriaus dėžutę. Pasuktas objektas
                    # ašinėje dėžutėje atrodo platesnis, todėl plotis ribojamas.
                    bw, bh = box[2] - box[0], box[3] - box[1]
                    cls = _judge(name, max(bw, bh) * gsd, min(bw, bh, 2.0 / gsd) * gsd)
                if not cls:
                    rejected += 1
                    continue
                d["class"] = name = cls
            if r and r.get("outline"):
                d["outline"] = r["outline"]
            if r and "corners" in r:
                d["corners"] = [[round(float(x), 1), round(float(y), 1)] for x, y in r["corners"]]
                d["heading"] = round(r["heading"], 1)
                if gsd > 0:
                    d["length"], d["width"] = round(r["length"] * gsd, 2), round(r["width"] * gsd, 2)
            if name not in want:
                continue
            out.append(d)
        out.sort(key=lambda d: -d["score"])
        if outline and not refine and out:
            await _check(request)
            polys = await run_in_threadpool(_outlines, img, [d["box"] for d in out[:80]])
            for d, p in zip(out, polys):
                if p:
                    d["outline"] = p
    return {
        "width": w,
        "height": h,
        "tiles": n_tiles,
        "rejected": rejected,
        "refined": sum(1 for d in out if "corners" in d),
        "outlined": sum(1 for d in out if "outline" in d),
        "seconds": round(time.time() - t0, 2),
        "detections": out,
    }


# ---------------------------------------------------------------------------
# Savo modelio mokymas (train.py – atskiras procesas) ir modelių sąrašas
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Valstybiniai numeriai (fast-alpr, MIT): numerio vieta (YOLOv9) + simbolių atpažinimas (CCT OCR), ONNX CPU
# ---------------------------------------------------------------------------
_alpr = None
_alpr_lock = threading.Lock()
PLATE_MIN_SIDE = 384  # mažos iškarpos padidinamos – numerio detektorius dirba 384 px įvestimi


def get_alpr():
    global _alpr
    with _alpr_lock:
        if _alpr is None:
            from fast_alpr import ALPR

            t0 = time.time()
            _alpr = ALPR()
            print(f"[ai] numerių atpažinimas (fast-alpr) įkeltas per {time.time() - t0:.1f} s", flush=True)
        return _alpr


def _ocr_chars(img: np.ndarray) -> list:
    """Numerio simbolių atpažinimas jau iškirptame numeryje (BGR): [[simbolis, tikrumas], …]."""
    if img is None or img.shape[0] < 4 or img.shape[1] < 4:
        return []
    alpr = get_alpr()
    with _alpr_lock:
        r = alpr.ocr.predict(img)
    if r is None or not r.text:
        return []
    conf = r.confidence if isinstance(r.confidence, (list, tuple, np.ndarray)) else [float(r.confidence or 0.0)] * len(r.text)
    conf = list(conf) + [0.0] * max(0, len(r.text) - len(conf))
    return [[ch.upper(), round(float(p), 3)] for ch, p in zip(r.text, conf) if ch.isalnum()]


def vote_chars(readings: list, weights: Optional[list] = None) -> list:
    """Balsavimas pagal simbolio vietą (MVCP – „Majority Vote by Character Position“, Nascimento ir kt. 2025):
    dažniausias ilgis, tada kiekvienoje vietoje – simbolis su didžiausia tikrumų suma. Klaida viename kadre
    ar variante (pvz. 3↔8) nugalima kitų, net jei nė vienas skaitymas nebuvo visiškai teisingas.
    Grąžina [[simbolis, dalis 0–1 (kiek balsų už jį toje vietoje)], …]."""
    weights = weights or [1.0] * len(readings)
    by_len: dict = {}
    for r, w in zip(readings, weights):
        if r:
            by_len[len(r)] = by_len.get(len(r), 0.0) + w * float(np.mean([p for _, p in r]))
    if not by_len:
        return []
    L = max(by_len, key=by_len.get)
    acc = [dict() for _ in range(L)]
    for r, w in zip(readings, weights):
        if len(r) == L:
            for i, (c, p) in enumerate(r):
                acc[i][c] = acc[i].get(c, 0.0) + w * p
    out = []
    for a in acc:
        c = max(a, key=a.get)
        out.append([c, round(a[c] / max(1e-6, sum(a.values())) * min(1.0, max(a.values())), 3)])
    return out


def _plate_variants(src: np.ndarray, box, up: float) -> list:
    """Kelių variantų skaitymas (TTA): skirtingi didinimo būdai ir paraštės – OCR klaidos skirtinguose
    variantuose skiriasi, todėl balsavimas jas panaikina (bandymuose 44 px numeriai: 28 % vietoj 17 %)."""
    x1, y1, x2, y2 = box
    H, W = src.shape[:2]
    outs = []
    for pad in (0.0, 0.06):
        px, py = pad * (x2 - x1), pad * (y2 - y1)
        c = src[max(0, int(y1 - py)) : min(H, int(np.ceil(y2 + py)) + 1), max(0, int(x1 - px)) : min(W, int(np.ceil(x2 + px)) + 1)]
        if c.shape[0] < 3 or c.shape[1] < 3:
            continue
        for interp in (cv2.INTER_CUBIC, cv2.INTER_LANCZOS4, cv2.INTER_LINEAR) if up > 1 else (None,):
            v = cv2.resize(c, None, fx=up, fy=up, interpolation=interp) if interp is not None else c
            outs.append(_ocr_chars(v))
    return [o for o in outs if o]


def _summary(chars: list) -> tuple:
    text = "".join(c for c, _ in chars)
    return text, (float(np.mean([p for _, p in chars])) if chars else 0.0)


def _read_plates(img: np.ndarray) -> list:
    h, w = img.shape[:2]
    k = max(1.0, PLATE_MIN_SIDE / max(1, min(h, w)))
    src = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    bgr = cv2.resize(src, (round(w * k), round(h * k)), interpolation=cv2.INTER_CUBIC) if k > 1 else src
    alpr = get_alpr()
    with _alpr_lock:
        dets = alpr.detector.predict(bgr)
    out = []
    for d in dets:
        b = d.bounding_box
        box = [max(0.0, b.x1 / k), max(0.0, b.y1 / k), min(float(w), b.x2 / k), min(float(h), b.y2 / k)]
        # Numeris skaitomas iš ORIGINALIOS iškarpos (ne iš jau padidintos), padidinant iki ~4×
        up = min(4.0, max(1.0, 96 / max(1.0, box[3] - box[1])))
        chars = vote_chars(_plate_variants(src, box, up))
        text, score = _summary(chars)
        out.append({"box": [round(v, 1) for v in box], "text": text, "score": round(score, 3), "chars": chars, "det": round(float(d.confidence), 3)})
    return out


def _sharpness(img: np.ndarray) -> float:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    return float(cv2.Laplacian(g, cv2.CV_64F).var())


def _display_enhance(img: np.ndarray) -> np.ndarray:
    """Žmogui rodomas vaizdas: švelnus kontrastas (CLAHE šviesumui) ir paaštrinimas.
    AI skaito NE šį, o sujungtą vaizdą be paaštrinimo – bandymuose paaštrinimas OCR tikslumą mažino."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(4, 4)).apply(l)
    img = cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)
    blur = cv2.GaussianBlur(img, (0, 0), max(1.0, img.shape[0] / 80))
    return cv2.addWeighted(img, 1.5, blur, -0.5, 0)


def _fuse_plates(imgs: list, inners: list) -> dict:
    """Keli to paties numerio kadrai (iš skirtingų vaizdo kadrų) → sulygiuojami (ECC, afininė transformacija)
    pagal ryškiausią ir suvidurkinami (mediana). Triukšmas ir suspaudimo artefaktai mažėja, smulkios detalės
    ryškėja – naudojami tik tikri pikseliai, nieko neišgalvojama (ne generatyvinis „super-resolution“)."""
    hs = sorted(i.shape[0] for i in imgs)
    ws = sorted(i.shape[1] for i in imgs)
    h0, w0 = hs[len(hs) // 2], ws[len(ws) // 2]
    k = min(4.0, max(1.0, 640 / max(1, w0)))
    W, H = int(round(w0 * k)), int(round(h0 * k))
    up = [cv2.resize(i, (W, H), interpolation=cv2.INTER_CUBIC) for i in imgs]
    sh = [_sharpness(cv2.resize(i, (w0, h0), interpolation=cv2.INTER_AREA)) for i in imgs]
    r = int(np.argmax(sh))
    ref = cv2.cvtColor(up[r], cv2.COLOR_BGR2GRAY).astype(np.float32)
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-4)
    acc = [up[r].astype(np.float32)]
    for i in range(len(up)):
        if i == r or sh[i] < 0.35 * sh[r]:  # labai neryškūs (judesys, fokusas) – tik pablogintų
            continue
        warp = np.eye(2, 3, dtype=np.float32)
        try:
            cc, warp = cv2.findTransformECC(ref, cv2.cvtColor(up[i], cv2.COLOR_BGR2GRAY).astype(np.float32), warp, cv2.MOTION_AFFINE, crit, None, 5)
        except cv2.error:
            continue
        if cc < 0.6:  # nesusilygiavo (kitas kampas, uždengta) – praleidžiama
            continue
        acc.append(cv2.warpAffine(up[i], warp, (W, H), flags=cv2.INTER_CUBIC + cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE).astype(np.float32))
    st = np.stack(acc)
    fused = np.clip(np.median(st, axis=0) if len(acc) >= 5 else st.mean(axis=0), 0, 255).astype(np.uint8)
    x1, y1, x2, y2 = inners[r] if r < len(inners) else (0.0, 0.0, 1.0, 1.0)
    px1, py1 = max(0, int(x1 * W)), max(0, int(y1 * H))
    px2, py2 = min(W, int(np.ceil(x2 * W)) + 1), min(H, int(np.ceil(y2 * H)) + 1)
    pw, ph = px2 - px1, py2 - py1
    chars = vote_chars(_plate_variants(fused, (px1, py1, px2, py2), 1.0)) if pw > 4 and ph > 4 else []
    text, score = _summary(chars)
    ok, jpg = cv2.imencode(".jpg", _display_enhance(fused), [cv2.IMWRITE_JPEG_QUALITY, 92])
    return {"text": text, "score": round(score, 3), "chars": chars, "frames": len(acc), "of": len(imgs), "image": base64.b64encode(jpg.tobytes()).decode() if ok else ""}


@app.post("/plates/fuse")
async def plates_fuse(images: list[UploadFile] = File(...), inner: str = Form("[]")):
    """To paties numerio kelių kadrų sujungimas į vieną ryškesnį vaizdą ir jo atpažinimas.
    inner – numerio vieta kiekvienoje iškarpoje (dalimis 0–1): [[x1, y1, x2, y2], …]."""
    try:
        inners = [tuple(float(v) for v in b) for b in json.loads(inner or "[]")]
    except (ValueError, TypeError) as e:
        raise HTTPException(400, f"Netinkamas inner: {e}") from e
    imgs = [cv2.cvtColor(read_image(await f.read()), cv2.COLOR_RGB2BGR) for f in images[:12]]
    if not imgs:
        raise HTTPException(400, "Nėra vaizdų")
    return await run_in_threadpool(_fuse_plates, imgs, inners)


@app.post("/plates")
async def plates(request: Request, images: list[UploadFile] = File(...)):
    """Valstybinių numerių atpažinimas transporto priemonių iškarpose (naršyklė siunčia iškarpas iš kadro).

    Grąžina kiekvienai iškarpai: [{box (iškarpos pikseliais), text, score (OCR tikrumas 0–1), det}].
    Viskas vyksta šiame kompiuteryje – vaizdai niekur nesiunčiami ir nesaugomi.
    """
    out = []
    try:
        for f in images[:16]:
            await _check(request)
            img = read_image(await f.read())
            out.append(await run_in_threadpool(_read_plates, img))
    except Cancelled:
        return {"cancelled": True, "results": out}
    return {"results": out}


def _job_dir(job: str) -> str:
    return os.path.join(CUSTOM_DIR, "_jobs", job)


@app.post("/train")
async def train_start(
    dataset: UploadFile = File(...),
    name: str = Form("Savas modelis"),
    size: str = Form("small"),
    epochs: int = Form(40),
):
    """Pradeda mokymą iš YOLO rinkinio (ZIP). Vienu metu – viena užduotis."""
    global _train_proc, _train_job
    if _train_proc is not None and _train_proc.poll() is None:
        raise HTTPException(409, "Jau vyksta kitas mokymas")
    if size not in ("nano", "small", "medium"):
        raise HTTPException(400, "Netinkamas modelio dydis")
    job = time.strftime("%Y%m%d-%H%M%S")
    work = _job_dir(job)
    os.makedirs(work, exist_ok=True)
    zpath = os.path.join(work, "dataset.zip")
    with open(zpath, "wb") as f:
        await run_in_threadpool(shutil.copyfileobj, dataset.file, f, 8 << 20)
    log = open(os.path.join(work, "train.log"), "w", encoding="utf-8")
    cmd = [sys.executable, os.path.join(os.path.dirname(__file__), "train.py"), zpath, work, "--size", size, "--epochs", str(max(1, min(epochs, 300))), "--name", name[:80], "--id", job]
    _train_proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, cwd=os.path.dirname(__file__), start_new_session=True)
    _train_job = job
    with open(os.path.join(CUSTOM_DIR, "_jobs", "last.txt"), "w", encoding="utf-8") as f:
        f.write(job)
    print(f"[ai] mokymas {job}: {name}, {size}, {epochs} epochų", flush=True)
    return {"job": job}


def _last_job() -> Optional[str]:
    if _train_job:
        return _train_job
    try:
        with open(os.path.join(CUSTOM_DIR, "_jobs", "last.txt"), encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


@app.get("/train/status")
def train_status():
    job = _last_job()
    if not job:
        return {"job": None}
    work = _job_dir(job)
    try:
        with open(os.path.join(work, "status.json"), encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        st = {"phase": "preparing"}
    running = _train_proc is not None and _train_proc.poll() is None and job == _train_job
    if not running and (st.get("phase") in ("preparing", "downloading", "training") or job in _train_cancelled):
        if job in _train_cancelled:
            st.update(phase="stopped", message="")
        else:
            st["phase"] = "error" if _train_job == job else "stopped"
            st["message"] = st.get("message") or "Mokymas nutrūko (paslauga buvo perkrauta arba pritrūko atminties)"
    tail = ""
    try:
        with open(os.path.join(work, "train.log"), encoding="utf-8", errors="replace") as f:
            lines = [l.rstrip() for l in f.readlines()[-200:] if "Warning" not in l and "warnings.warn" not in l and l.strip()]
            tail = "\n".join(lines[-12:])
    except OSError:
        pass
    return {"job": job, "running": running, "log": tail, **st}


@app.post("/train/cancel")
def train_cancel():
    global _train_proc
    if _train_proc is None or _train_proc.poll() is not None:
        return {"ok": True}
    _train_cancelled.add(_train_job)
    try:
        os.killpg(_train_proc.pid, signal.SIGTERM)
    except Exception:  # pragma: no cover
        _train_proc.terminate()
    return {"ok": True}


@app.get("/models")
def models_list():
    return {"active": active_model(), "models": custom_models(), "standard": f"RF-DETR {DETECTOR_SIZE} (COCO)"}


@app.post("/models/active")
def models_activate(id: str = Form("")):
    if id and not os.path.isfile(os.path.join(CUSTOM_DIR, os.path.basename(id), "model.pth")):
        raise HTTPException(404, "Modelis nerastas")
    os.makedirs(CUSTOM_DIR, exist_ok=True)
    with open(os.path.join(CUSTOM_DIR, "active.txt"), "w", encoding="utf-8") as f:
        f.write(os.path.basename(id))
    return {"active": id}


@app.post("/models/delete")
def models_delete(id: str = Form(...)):
    d = os.path.join(CUSTOM_DIR, os.path.basename(id))
    if not os.path.isdir(d) or os.path.basename(id).startswith("_"):
        raise HTTPException(404, "Modelis nerastas")
    shutil.rmtree(d, ignore_errors=True)
    _custom.pop(id, None)
    if active_model() == id:
        models_activate("")
    return {"ok": True}


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
