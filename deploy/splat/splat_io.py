# Atea 3D Matuoklis – Gaussian Splatting duomenys: ODM (OpenSfM) kameros ir taškai, rezultato įrašymas.
# Tik numpy / Pillow – testuojama be GPU (test_splat_io.py).
#
# Koordinatės: OpenSfM pasaulis = ODM vietinis rėmas (UTM minus poslinkis iš odm_georeferencing/coords.txt, Z aukštyn) –
# tas pats, kuriame yra odm_filterpoints/point_cloud.ply ir 3D modelis. Splat įrašomas tame pačiame rėme.
import gzip
import json
import math
import os
import struct

import numpy as np

SH_C0 = 0.28209479177387814


# ---------------------------------------------------------------- OpenSfM kameros
def _rotation_matrix(rvec):
    """Rodrigues: ašis-kampas → 3×3 (OpenSfM shot.rotation)."""
    r = np.asarray(rvec, dtype=np.float64)
    th = np.linalg.norm(r)
    if th < 1e-12:
        return np.eye(3)
    k = r / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * K @ K


def find_image(images_dir, name):
    """OpenSfM ištiesintos nuotraukos pavadinimas: <originalas>.tif (ODM undistorted_image_format: tif)."""
    for cand in (name + ".tif", name + ".tiff", name, os.path.splitext(name)[0] + ".tif", name + ".jpg", name + ".png"):
        p = os.path.join(images_dir, cand)
        if os.path.isfile(p):
            return p
    return None


def load_cameras(task_dir):
    """ODM užduoties ištiesintos (be iškraipymų) kameros. Grąžina sąrašą dict(name, path, viewmat 4×4 pasaulis→kamera
    (OpenCV: x dešinėn, y žemyn, z pirmyn), K 3×3, width, height)."""
    und = os.path.join(task_dir, "opensfm", "undistorted")
    recs = json.load(open(os.path.join(und, "reconstruction.json")))
    images_dir = os.path.join(und, "images")
    out = []
    for rec in recs:
        cams = rec.get("cameras", {})
        for name, shot in rec.get("shots", {}).items():
            cam = cams.get(shot.get("camera"))
            if not cam or cam.get("projection_type", "perspective") not in ("perspective", "brown", "simple_radial", "radial"):
                continue
            path = find_image(images_dir, name)
            if not path:
                continue
            w, h = int(cam["width"]), int(cam["height"])
            s = max(w, h)
            fx = float(cam.get("focal_x", cam.get("focal", 0.85))) * s
            fy = float(cam.get("focal_y", cam.get("focal", 0.85))) * s
            cx = w / 2.0 + float(cam.get("c_x", 0.0)) * s
            cy = h / 2.0 + float(cam.get("c_y", 0.0)) * s
            V = np.eye(4)
            V[:3, :3] = _rotation_matrix(shot["rotation"])
            V[:3, 3] = np.asarray(shot["translation"], dtype=np.float64)
            K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float64)
            out.append({"name": name, "path": path, "viewmat": V, "K": K, "width": w, "height": h})
    out.sort(key=lambda c: c["name"])
    return out


def camera_centers(cams):
    return np.array([-c["viewmat"][:3, :3].T @ c["viewmat"][:3, 3] for c in cams])


# ---------------------------------------------------------------- PLY
_PLY_TYPES = {"char": "i1", "uchar": "u1", "int8": "i1", "uint8": "u1", "short": "i2", "ushort": "u2", "int16": "i2",
              "uint16": "u2", "int": "i4", "uint": "u4", "int32": "i4", "uint32": "u4", "float": "f4", "float32": "f4",
              "double": "f8", "float64": "f8"}


def read_ply_vertices(path):
    """Dvejetainio (little endian) PLY viršūnės → numpy struktūrinis masyvas (ODM point_cloud.ply)."""
    with open(path, "rb") as f:
        if f.readline().strip() != b"ply":
            raise ValueError("ne PLY failas")
        fmt, props, n, in_vertex = None, [], 0, False
        while True:
            line = f.readline()
            if not line:
                raise ValueError("PLY antraštė nebaigta")
            t = line.decode("latin-1").split()
            if not t:
                continue
            if t[0] == "format":
                fmt = t[1]
            elif t[0] == "element":
                in_vertex = t[1] == "vertex"
                if in_vertex:
                    n = int(t[2])
                elif n and not props:
                    raise ValueError("PLY: vertex elementas turi būti pirmas")
            elif t[0] == "property" and in_vertex:
                if t[1] == "list":
                    raise ValueError("PLY: vertex sąrašų savybės nepalaikomos")
                props.append((t[2], "<" + _PLY_TYPES[t[1]]))
            elif t[0] == "end_header":
                break
        if fmt != "binary_little_endian":
            raise ValueError("palaikomas tik binary_little_endian PLY")
        return np.fromfile(f, dtype=np.dtype(props), count=n)


def load_points(path, max_points=2_000_000, seed=0):
    """Pradiniai taškai splatams: (N×3 koordinatės, N×3 spalvos 0..1)."""
    v = read_ply_vertices(path)
    names = v.dtype.names
    xyz = np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float32)
    if all(c in names for c in ("red", "green", "blue")):
        rgb = np.stack([v["red"], v["green"], v["blue"]], 1).astype(np.float32)
        rgb /= 255.0 if rgb.max() > 1.0 else 1.0
    else:
        rgb = np.full_like(xyz, 0.5)
    ok = np.isfinite(xyz).all(1)
    xyz, rgb = xyz[ok], rgb[ok]
    if len(xyz) > max_points:
        idx = np.random.default_rng(seed).choice(len(xyz), max_points, replace=False)
        xyz, rgb = xyz[idx], rgb[idx]
    return xyz, rgb


def write_ply(path, means, scales, quats, opacities, sh0, shN):
    """Standartinis 3DGS PLY (Inria / gsplat): scales – log, opacities – logit, quats – (w, x, y, z),
    sh0 N×3, shN N×K×3 (f_rest – kanalas išorinis: visi R, tada G, tada B)."""
    n = len(means)
    K = shN.shape[1] if shN is not None and shN.size else 0
    rest = np.ascontiguousarray(shN.transpose(0, 2, 1)).reshape(n, K * 3) if K else np.zeros((n, 0), np.float32)
    cols = [means, np.zeros((n, 3), np.float32), sh0, rest, opacities[:, None], scales, quats]
    data = np.concatenate([np.asarray(c, np.float32).reshape(n, -1) for c in cols], 1)
    names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"] + [f"f_rest_{i}" for i in range(K * 3)] + \
            ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    assert data.shape[1] == len(names)
    with open(path, "wb") as f:
        f.write(("ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % n).encode())
        for nm in names:
            f.write(("property float %s\n" % nm).encode())
        f.write(b"end_header\n")
        f.write(data.astype("<f4").tobytes())


# ---------------------------------------------------------------- SPZ (Niantic, MIT) – versija 2, gzip
# Antraštė 16 B: magic "NGSP" (0x5053474e), versija, taškų skaičius, SH laipsnis, trupmeniniai bitai, vėliavos, rezervas.
# Toliau: pozicijos (24 bitų fiksuotas kablelis), alfa, spalvos, mastelis, sukimas (x, y, z, kai w ≥ 0), SH.
SPZ_MAGIC = 0x5053474E
SPZ_COLOR_SCALE = 0.15


def _spz_bytes(x):
    return np.clip(np.round(x), 0, 255).astype(np.uint8)


def write_spz(path, means, scales, quats, opacities, sh0, shN, sh_degree=None):
    """Kompaktiškas splatų failas naršyklei (~10× mažesnis už PLY). Argumentai – kaip write_ply."""
    n = len(means)
    means = np.asarray(means, np.float64)
    K = shN.shape[1] if shN is not None and shN.size else 0
    deg = {0: 0, 3: 1, 8: 2, 15: 3}[K] if sh_degree is None else sh_degree
    K = {0: 0, 1: 3, 2: 8, 3: 15}[deg]
    # Trupmeniniai bitai pagal sceną: 24 bitai su ženklu → ±2^(23-fb) m
    ext = float(np.abs(means).max()) if n else 1.0
    fb = 12
    while fb > 0 and ext >= (1 << (23 - fb)) * 0.999:
        fb -= 1
    fixed = np.round(means * (1 << fb)).astype(np.int64)
    fixed = np.clip(fixed, -(1 << 23), (1 << 23) - 1) & 0xFFFFFF
    pos = np.stack([fixed & 0xFF, (fixed >> 8) & 0xFF, (fixed >> 16) & 0xFF], -1).astype(np.uint8).reshape(n, 9)
    alpha = _spz_bytes(1.0 / (1.0 + np.exp(-np.asarray(opacities, np.float64))) * 255.0)
    color = _spz_bytes((np.asarray(sh0, np.float64) * SPZ_COLOR_SCALE + 0.5) * 255.0)
    scale = _spz_bytes((np.asarray(scales, np.float64) + 10.0) * 16.0)
    q = np.asarray(quats, np.float64)
    q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    q = np.where(q[:, :1] < 0, -q, q)  # w ≥ 0
    rot = _spz_bytes(q[:, 1:4] * 127.5 + 127.5)  # (x, y, z)
    parts = [struct.pack("<IIIBBBB", SPZ_MAGIC, 2, n, deg, fb, 0, 0), pos.tobytes(), alpha.tobytes(), color.tobytes(),
             scale.tobytes(), rot.tobytes()]
    if K:
        sh = np.asarray(shN, np.float64)[:, :K, :]  # N×K×3: koeficientas išorinis, kanalas vidinis
        parts.append(np.clip(np.round(sh * 128.0) + 128.0, 0, 255).astype(np.uint8).tobytes())
    with gzip.open(path, "wb", compresslevel=6) as f:
        for p in parts:
            f.write(p)
