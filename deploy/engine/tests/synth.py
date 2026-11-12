# Sintetinis drono nuotraukų rinkinys testams: kvartalas (žemė + pastatai) su tekstūra, nuotraukos su EXIF GPS
# (DJI tipo) ir žinomomis kameromis. Atvaizduojama Open3D spindulių sekimu (be GPU).
import math
import os

import numpy as np
from PIL import Image

ORIGIN = (54.6872, 25.2797, 120.0)  # Vilnius, aukštis (m)


def scene_mesh():
    import open3d as o3d
    m = o3d.geometry.TriangleMesh.create_box(160, 160, 0.2).translate((-80, -80, -0.2))
    for x, y, w, d, h in ((-25, -20, 18, 14, 12), (10, -25, 14, 20, 8), (-5, 15, 24, 12, 16), (30, 20, 10, 10, 6)):
        m += o3d.geometry.TriangleMesh.create_box(w, d, h).translate((x, y, 0))
    return m


def texture(P):
    """Spalva pagal 3D tašką: langeliai (1,1 m) + stambesnės dėmės (4,7 m) – gerai atpažįstami SIFT taškai."""
    rng = np.random.default_rng(7)
    lut = rng.uniform(0.15, 0.95, (4096, 3)).astype(np.float32)
    c = np.floor((P + 0.37) / 1.1).astype(np.int64)
    h = (c[..., 0] * 73856093 ^ c[..., 1] * 19349663 ^ c[..., 2] * 83492791) & 4095
    col = lut[h]
    c2 = np.floor((P + 1.13) / 4.7).astype(np.int64)
    h2 = (c2[..., 0] * 2654435761 ^ c2[..., 1] * 40503 ^ c2[..., 2] * 9973) & 4095
    return np.clip(0.45 * col + 0.55 * lut[h2], 0, 1)


def look(eye, target):
    z = target - eye
    z = z / np.linalg.norm(z)
    x = np.cross(z, [0, 0, 1.0])
    if np.linalg.norm(x) < 1e-6:
        x = np.array([1.0, 0, 0])
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    R = np.stack([x, y, z])
    V = np.eye(4)
    V[:3, :3] = R
    V[:3, 3] = -R @ eye
    return V


def local_to_wgs84(E, N, U):
    from pyproj import Transformer
    lat0, lon0, alt0 = ORIGIN
    zone = int((lon0 + 180) // 6) + 1
    t = Transformer.from_crs(4326, 32600 + zone, always_xy=True)
    e0, n0 = t.transform(lon0, lat0)
    lon, lat = t.transform(e0 + E, n0 + N, direction="INVERSE")
    return lat, lon, alt0 + U


def _rational(v):
    from PIL.TiffImagePlugin import IFDRational
    from fractions import Fraction
    f = Fraction(v).limit_denominator(10000)
    return IFDRational(f.numerator, f.denominator)


def _dms(v):
    v = abs(v)
    d = int(v)
    m = int((v - d) * 60)
    s = (v - d - m / 60) * 3600
    return (_rational(d), _rational(m), _rational(round(s, 4)))


def save_jpeg(path, rgb, lat, lon, alt, focal_px, W, calibrated=False):
    img = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8))
    ex = Image.Exif()
    ex[0x010F] = "DJI"
    ex[0x0110] = "SYNTH"
    sub = ex.get_ifd(0x8769)
    sensor_w = 13.2
    f_mm = focal_px * sensor_w / W
    sub[0x920A] = _rational(f_mm)
    # 35 mm ekvivalentas apibrėžtas pagal įstrižainę (43,27 mm), kaip tikrose kamerose; DJI XMP – tiksli kalibracija
    sub[0xA405] = int(round(f_mm * 43.2666 / (sensor_w * np.hypot(W, rgb.shape[0]) / W)))
    gps = ex.get_ifd(0x8825)
    gps[1] = "N" if lat >= 0 else "S"
    gps[2] = _dms(lat)
    gps[3] = "E" if lon >= 0 else "W"
    gps[4] = _dms(lon)
    gps[5] = b"\x00"
    gps[6] = _rational(round(alt, 3))
    xmp = None
    if calibrated:
        xmp = ('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
               '<rdf:Description xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" drone-dji:CalibratedFocalLength="%.3f" '
               'drone-dji:RelativeAltitude="+%.2f"/></rdf:RDF></x:xmpmeta>' % (focal_px, alt - ORIGIN[2])).encode()
    img.save(path, quality=95, exif=ex, **({"xmp": xmp} if xmp else {}))


def distorted_rays(K, V, W, H, k1, k2=0.0):
    """Spinduliai iškraipytos (radialinis k1, k2 – kaip tikras objektyvas) kameros pikseliams."""
    u, v = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    xd, yd = (u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1]
    xu, yu = xd.copy(), yd.copy()
    for _ in range(20):  # atvirkštinis iškraipymas (iteracijos)
        r2 = xu * xu + yu * yu
        f = 1 + k1 * r2 + k2 * r2 * r2
        xu, yu = xd / f, yd / f
    d_cam = np.stack([xu, yu, np.ones_like(xu)], -1)
    R, t = V[:3, :3], V[:3, 3]
    C = -R.T @ t
    d = d_cam @ R  # R.T @ d_cam
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    return np.concatenate([np.broadcast_to(C, d.shape), d], -1).astype(np.float32)


def make_dataset(out_dir, W=800, H=600, focal=640.0, alt=55.0, step=14.0, oblique=False, gps_noise=0.0, seed=1, k1=0.0,
                 extent=42.0, calibrated=False):
    """Grąžina kamerų sąrašą (name, viewmat, K, center) ir įrašo JPEG su EXIF GPS į out_dir."""
    import open3d as o3d
    os.makedirs(out_dir, exist_ok=True)
    sc = o3d.t.geometry.RaycastingScene()
    sc.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(scene_mesh()))
    K = np.array([[focal, 0, W / 2], [0, focal, H / 2], [0, 0, 1]])
    rng = np.random.default_rng(seed)
    cams = []
    xs = np.arange(-extent, extent + 0.1, step)
    i = 0
    for yi, y in enumerate(np.arange(-extent, extent + 0.1, step)):
        for x in (xs if yi % 2 == 0 else xs[::-1]):
            eye = np.array([x, y, alt])
            tgt = np.array([x + (8 if oblique and i % 2 else 0), y + 0.5, 0.0])
            V = look(eye, tgt)
            rays = (distorted_rays(K, V, W, H, k1) if k1 else
                    o3d.t.geometry.RaycastingScene.create_rays_pinhole(o3d.core.Tensor(K), o3d.core.Tensor(V), W, H).numpy())
            t = sc.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
            P = rays[..., :3] + rays[..., 3:] * np.where(np.isfinite(t), t, 0)[..., None]
            n = sc.cast_rays(o3d.core.Tensor(rays))["primitive_normals"].numpy()
            shade = 0.75 + 0.25 * np.abs(n[..., 2:3])
            rgb = np.where(np.isfinite(t)[..., None], texture(P) * shade, np.array([0.6, 0.75, 0.95]))
            name = "DJI_%04d_W.JPG" % (i + 1)
            g = eye + rng.normal(0, gps_noise, 3) if gps_noise else eye
            lat, lon, a = local_to_wgs84(*g)
            save_jpeg(os.path.join(out_dir, name), rgb, lat, lon, a, focal, W, calibrated)
            cams.append({"name": name, "viewmat": V, "K": K, "center": eye})
            i += 1
    return cams
