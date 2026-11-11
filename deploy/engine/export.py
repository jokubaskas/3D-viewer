# Atea variklis – rezultatų įrašymas ODM katalogų struktūra (programa juos atidaro kaip ODM rezultatus):
#   odm_georeferencing/odm_georeferenced_model.laz – taškų debesis UTM koordinatėmis (LAS 1.4, spalvos 16 bit)
#   opensfm/undistorted/reconstruction.json + images/ – kameros realistiško vaizdo (splatų) mokymui
import json
import os

import numpy as np


def laz(points_ply, out_path, frame, log=print):
    import laspy
    import open3d as o3d
    pc = o3d.io.read_point_cloud(points_ply)
    P = np.asarray(pc.points)
    if frame is not None:
        P = P + [frame.off_e, frame.off_n, 0.0]
    hdr = laspy.LasHeader(point_format=7, version="1.4")
    hdr.offsets = np.floor(P.min(0)) if len(P) else np.zeros(3)
    hdr.scales = np.array([0.001, 0.001, 0.001])
    if frame is not None:
        from pyproj import CRS
        hdr.add_crs(CRS.from_epsg(frame.epsg))
    las = laspy.LasData(hdr)
    las.x, las.y, las.z = P[:, 0], P[:, 1], P[:, 2]
    if pc.has_colors():
        C = (np.clip(np.asarray(pc.colors), 0, 1) * 65535).astype(np.uint16)
        las.red, las.green, las.blue = C[:, 0], C[:, 1], C[:, 2]
    tmp = out_path + ".tmp.laz"
    las.write(tmp)
    os.replace(tmp, out_path)
    log("Taškų debesis (LAZ): %d taškų" % len(P))


def _axis_angle(R):
    from scipy.spatial.transform import Rotation
    return Rotation.from_matrix(R).as_rotvec()


def opensfm_compat(dense_dir, task_dir, log=print):
    """Ištiesintos kameros OpenSfM formatu (kaip ODM opensfm/undistorted) – realistiško vaizdo mokymas jas skaito."""
    import texturing
    cams = texturing.load_cameras(dense_dir)
    und = os.path.join(task_dir, "opensfm", "undistorted")
    img_dir = os.path.join(und, "images")
    os.makedirs(img_dir, exist_ok=True)
    cameras, shots = {}, {}
    for c in cams:
        w, h = c["width"], c["height"]
        s = max(w, h)
        key = "cam_%dx%d_%.2f" % (w, h, c["K"][0, 0])
        cameras[key] = {"projection_type": "brown", "width": w, "height": h,
                        "focal_x": c["K"][0, 0] / s, "focal_y": c["K"][1, 1] / s,
                        "c_x": (c["K"][0, 2] - w / 2.0) / s, "c_y": (c["K"][1, 2] - h / 2.0) / s,
                        "k1": 0.0, "k2": 0.0, "k3": 0.0, "p1": 0.0, "p2": 0.0}
        shots[c["name"]] = {"camera": key, "rotation": list(map(float, _axis_angle(c["viewmat"][:3, :3]))),
                            "translation": list(map(float, c["viewmat"][:3, 3]))}
        dst = os.path.join(img_dir, c["name"])
        if not os.path.exists(dst):
            try:
                os.link(c["path"], dst)
            except OSError:
                import shutil
                shutil.copy(c["path"], dst)
    with open(os.path.join(und, "reconstruction.json"), "w") as f:
        json.dump([{"cameras": cameras, "shots": shots}], f)
    log("Kameros realistiškam vaizdui: %d" % len(shots))
