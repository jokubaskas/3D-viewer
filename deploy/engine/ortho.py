# Atea variklis – ortofoto, DSM ir DTM iš tekstūruoto 3D modelio (tikra ortoprojekcija: pastatai nevirsta,
# ortofoto tiksliai sutampa su 3D modeliu). Spinduliai iš viršaus (Open3D) dalimis po 2048 × 2048 px:
#   ortofoto – tekstūros spalva pataikymo taške; DSM – pataikymo aukštis; DTM – žemės paviršius iš DSM
#   (morfologinis atvėrimas – pašalinami pastatai ir medžiai iki ~30 m pločio – ir išlyginimas).
# GeoTIFF / COG (UTM, kaip ODM odm_orthophoto.tif ir odm_dem/dsm.tif, dtm.tif).
import os

import numpy as np

TILE = 2048
MAX_PIXELS = 40000


def estimate_gsd(dense_dir):
    """Nuotraukų GSD (m/px): kamerų aukštis virš žemės / židinys (pikseliais)."""
    import texturing
    cams = texturing.load_cameras(dense_dir)
    if not cams:
        return 0.03
    C = np.array([-c["viewmat"][:3, :3].T @ c["viewmat"][:3, 3] for c in cams])
    uv = os.path.join(os.path.dirname(dense_dir), "texture_uv.npz")
    ground = float(np.percentile(np.load(uv)["V"][:, 2], 10)) if os.path.isfile(uv) else float(C[:, 2].min() - 50)
    f = np.array([c["K"][0, 0] for c in cams])
    gsd = float(np.median((C[:, 2] - ground) / f))
    return float(np.clip(gsd, 0.01, 0.2))


def _sample(pages, page, uv):
    """Tekstūros spalva (bilinijinė) lapuose pagal UV (0..1, viršus – 0)."""
    out = np.zeros((len(uv), 3), np.float32)
    for p in np.unique(page):
        sel = page == p
        img = pages[p]
        S = img.shape[0]
        x = np.clip(uv[sel, 0] * S - 0.5, 0, S - 1.001)
        y = np.clip(uv[sel, 1] * S - 0.5, 0, S - 1.001)
        x0, y0 = x.astype(int), y.astype(int)
        fx, fy = (x - x0)[:, None], (y - y0)[:, None]
        c = (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy) +
             img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)
        out[sel] = c
    return out


def _write_cog(path, arr, frame, x0, y1, gsd, nodata=None, alpha=None):
    import rasterio
    from rasterio.shutil import copy as rcopy
    from rasterio.transform import from_origin
    H, W = arr.shape[:2]
    bands = 1 if arr.ndim == 2 else arr.shape[2]
    tmp = path + ".tmp.tif"
    prof = dict(driver="GTiff", width=W, height=H, count=bands + (1 if alpha is not None else 0), dtype=arr.dtype,
                crs="EPSG:%d" % frame.epsg, transform=from_origin(x0 + frame.off_e, y1 + frame.off_n, gsd, gsd),
                tiled=True, blockxsize=512, blockysize=512, compress="DEFLATE", BIGTIFF="IF_SAFER")
    if nodata is not None:
        prof["nodata"] = nodata
    with rasterio.open(tmp, "w", **prof) as dst:
        if arr.ndim == 2:
            dst.write(arr, 1)
        else:
            for b in range(bands):
                dst.write(arr[..., b], b + 1)
        if alpha is not None:
            dst.write(alpha, bands + 1)
            from rasterio.enums import ColorInterp
            dst.colorinterp = [ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha]
    rcopy(tmp, path, driver="COG", compress="DEFLATE", predictor=2, BIGTIFF="IF_SAFER", overview_resampling="average")
    os.remove(tmp)


def dtm_from_dsm(dsm, valid, gsd, window_m=30.0):
    """Žemės paviršius: tuštumos užpildomos, morfologinis atvėrimas (min → max), išlyginimas."""
    from scipy import ndimage
    z = dsm.copy()
    if (~valid).any() and valid.any():
        idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
        z = z[tuple(idx)]
    k = max(3, int(window_m / gsd) | 1)
    # Atvėrimas stambiu langu – per nedidelę rezoliuciją (greičiau), tada atgal
    f = max(1, k // 31)
    small = z[::f, ::f]
    ks = max(3, (k // f) | 1)
    ground = ndimage.grey_opening(small, size=(ks, ks))
    ground = ndimage.uniform_filter(ground, size=max(3, ks // 2))
    if f > 1:
        zoom = (z.shape[0] / ground.shape[0], z.shape[1] / ground.shape[1])
        ground = ndimage.zoom(ground, zoom, order=1)[: z.shape[0], : z.shape[1]]
    # Žemė negali būti aukščiau paviršiaus
    return np.minimum(ground, z)


def make(obj_path, task_dir, frame, gsd, boundary=None, log=print):
    import open3d as o3d
    from PIL import Image
    import geo
    work = os.path.join(task_dir, "work")
    d = np.load(os.path.join(work, "texture_uv.npz"))
    V, F, uv, page = d["V"], d["F"], d["uv"], d["page"]
    pages = [np.asarray(Image.open(str(p)).convert("RGB"), np.float32) for p in d["pages"]]
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(V.astype(np.float32)), o3d.core.Tensor(F.astype(np.uint32)))
    lo, hi = V.min(0), V.max(0)
    poly = None
    if boundary:
        poly = geo.boundary_polygon(open(boundary, encoding="utf-8").read(), frame)
        if poly is not None:
            lo[:2] = np.maximum(lo[:2], poly.min(0))
            hi[:2] = np.minimum(hi[:2], poly.max(0))
    ext = hi[:2] - lo[:2]
    if max(ext) / gsd > MAX_PIXELS:
        gsd = float(max(ext) / MAX_PIXELS)
        log("Ortofoto raiška padidinta iki %.1f cm (didelis plotas)" % (gsd * 100))
    W, H = int(np.ceil(ext[0] / gsd)), int(np.ceil(ext[1] / gsd))
    x0, y1 = float(lo[0]), float(lo[1] + H * gsd)
    rgb = np.zeros((H, W, 3), np.uint8)
    alpha = np.zeros((H, W), np.uint8)
    dsm = np.full((H, W), -9999.0, np.float32)
    top = float(hi[2] + 10.0)
    for ty in range(0, H, TILE):
        for tx in range(0, W, TILE):
            h, w = min(TILE, H - ty), min(TILE, W - tx)
            xs = x0 + (tx + np.arange(w) + 0.5) * gsd
            ys = y1 - (ty + np.arange(h) + 0.5) * gsd
            X, Y = np.meshgrid(xs, ys)
            rays = np.stack([X, Y, np.full_like(X, top), np.zeros_like(X), np.zeros_like(X), -np.ones_like(X)], -1)
            hit = scene.cast_rays(o3d.core.Tensor(rays.astype(np.float32)))
            t = hit["t_hit"].numpy()
            ok = np.isfinite(t)
            if poly is not None:
                ok &= geo.inside_polygon(np.stack([X.ravel(), Y.ravel()], 1), poly).reshape(X.shape)
            if not ok.any():
                continue
            pid = hit["primitive_ids"].numpy()[ok].astype(np.int64)
            bu = hit["primitive_uvs"].numpy()[ok]
            w0 = (1 - bu[:, 0] - bu[:, 1])[:, None]
            tuv = uv[pid, 0] * w0 + uv[pid, 1] * bu[:, :1] + uv[pid, 2] * bu[:, 1:2]
            col = _sample(pages, page[pid], tuv)
            sub = rgb[ty:ty + h, tx:tx + w]
            sub[ok] = np.clip(col, 0, 255).astype(np.uint8)
            alpha[ty:ty + h, tx:tx + w][ok] = 255
            dsm[ty:ty + h, tx:tx + w][ok] = top - t[ok]
    os.makedirs(os.path.join(task_dir, "odm_orthophoto"), exist_ok=True)
    os.makedirs(os.path.join(task_dir, "odm_dem"), exist_ok=True)
    _write_cog(os.path.join(task_dir, "odm_orthophoto", "odm_orthophoto.tif"), rgb, frame, x0, y1, gsd, alpha=alpha)
    log("Ortofoto: %d × %d px, %.1f cm/px" % (W, H, gsd * 100))
    # DSM / DTM – 2 × stambesni (kaip ODM: DEM raiška ≥ ortofoto)
    f = 2
    valid = alpha > 0
    Hs, Ws = H // f, W // f
    if Hs < 2 or Ws < 2:
        return
    ds = dsm[: Hs * f, : Ws * f].reshape(Hs, f, Ws, f)
    vs = valid[: Hs * f, : Ws * f].reshape(Hs, f, Ws, f)
    cnt = vs.sum((1, 3))
    dsm2 = np.where(cnt > 0, np.where(vs, ds, 0).sum((1, 3)) / np.maximum(cnt, 1), -9999.0).astype(np.float32)
    v2 = cnt > 0
    _write_cog(os.path.join(task_dir, "odm_dem", "dsm.tif"), dsm2, frame, x0, y1, gsd * f, nodata=-9999.0)
    dtm = dtm_from_dsm(dsm2, v2, gsd * f).astype(np.float32)
    dtm[~v2] = -9999.0
    _write_cog(os.path.join(task_dir, "odm_dem", "dtm.tif"), dtm, frame, x0, y1, gsd * f, nodata=-9999.0)
    log("DSM / DTM: %d × %d px, %.1f cm/px" % (Ws, Hs, gsd * f * 100))
