# Atea variklis – kamerų padėčių (SfM) palyginimas: ODM (OpenSfM) prieš COLMAP 4 + GLOMAP (Atea variklio „Aukšta kokybė“).
# Imamos to paties baigto ODM projekto nuotraukos (ir geo.txt / gcp_list.txt), Atea variklis paleidžiamas iki
# georeferencijos, o rezultatai lyginami su ODM: laikas, sujungtos nuotraukos, taškai, perprojekcijos paklaida, kamerų
# atitikimas GPS padėtims ir abiejų sprendinių tarpusavio skirtumas.
# Paleidimas (serveryje):  palyginti-sfm.bat [projekto ID]   – be ID imamas naujausias baigtas ODM projektas.
#   docker compose exec engine python3 compare_sfm.py [uuid] [--keep]
import argparse
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime

import numpy as np

ODM_DATA = os.environ.get("ODM_DATA", "/odm-data")
ENGINE_DATA = os.environ.get("ENGINE_DATA", "/engine-data")
TS = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)")


def latest_odm_project(root=None):
    root = root or ODM_DATA
    best, t = None, -1
    for d in os.listdir(root) if os.path.isdir(root) else []:
        p = os.path.join(root, d, "opensfm", "undistorted", "reconstruction.json")
        if os.path.isfile(p) and os.path.getmtime(p) > t:
            best, t = d, os.path.getmtime(p)
    return best


def odm_sfm_minutes(log_path):
    """ODM kamerų etapo trukmė pagal OpenSfM laiko žymes žurnale: nuo požymių paieškos iki OpenMVS etapo pradžios
    (įskaitant nuotraukų ištiesinimą, ~0,5–1 min.)."""
    try:
        lines = open(log_path, encoding="utf-8", errors="replace").read().split("\n")
    except OSError:
        return None
    start = next((i for i, l in enumerate(lines) if "detect_features" in l), None)
    end = next((i for i, l in enumerate(lines) if "Running openmvs stage" in l), None)
    if start is None or end is None:
        return None
    ts = [TS.match(l) for l in lines[start:end]]
    ts = [datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S") for m in ts if m]
    return (ts[-1] - ts[0]).total_seconds() / 60 if len(ts) >= 2 else None


def umeyama(src, dst):
    """Sim3: dst ≈ s·R·src + t. Grąžina (s, R, t)."""
    ms, md = src.mean(0), dst.mean(0)
    a, b = src - ms, dst - md
    U, S, Vt = np.linalg.svd(b.T @ a / len(src))
    D = np.eye(3)
    D[2, 2] = np.sign(np.linalg.det(U @ Vt))
    R = U @ D @ Vt
    s = np.trace(np.diag(S) @ D) / (a ** 2).sum(1).mean()
    return s, R, md - s * R @ ms


def odm_centers(task):
    """ODM kamerų centrai absoliučiomis UTM koordinatėmis {vardas: (E, N, h)} ir zona."""
    rec = json.load(open(os.path.join(task, "opensfm", "undistorted", "reconstruction.json")))
    lines = open(os.path.join(task, "odm_georeferencing", "coords.txt")).read().split("\n")
    zone = lines[0].strip()
    off = [float(v) for v in lines[1].split()[:2]]
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import splat_io
    out = {}
    for r in rec:
        for name, shot in r.get("shots", {}).items():
            R = splat_io._rotation_matrix(shot["rotation"])
            c = -R.T @ np.asarray(shot["translation"], float)
            out[name] = np.array([c[0] + off[0], c[1] + off[1], c[2]])
    return out, zone


def odm_stats(task):
    try:
        s = json.load(open(os.path.join(task, "opensfm", "stats", "stats.json")))
    except (OSError, ValueError):
        return {}
    r = s.get("reconstruction_statistics", {})
    return {"points": r.get("reconstructed_points_count"), "shots": r.get("reconstructed_shots_count"),
            "reproj_px": r.get("reprojection_error_pixels"), "track": r.get("average_track_length"),
            "components": r.get("components")}


def residuals(centers, gps):
    names = [n for n in centers if n in gps]
    if not names:
        return None
    d = np.array([centers[n] - gps[n] for n in names])
    return {"n": len(names), "h_med": float(np.median(np.linalg.norm(d[:, :2], axis=1))),
            "v_med": float(np.median(np.abs(d[:, 2]))), "v_bias": float(np.median(d[:, 2]))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("uuid", nargs="?", help="ODM projekto ID (be jo – naujausias baigtas)")
    ap.add_argument("--keep", action="store_true", help="nenaikinti ankstesnių skaičiavimų (tik ataskaita)")
    a = ap.parse_args()
    uuid = a.uuid or latest_odm_project()
    if not uuid:
        sys.exit("Nerasta baigtų ODM projektų (%s)" % ODM_DATA)
    task = os.path.join(ODM_DATA, uuid)
    if not os.path.isfile(os.path.join(task, "opensfm", "undistorted", "reconstruction.json")):
        sys.exit("Projektas %s neturi ODM kamerų (ar jis baigtas?)" % uuid)
    print("Projektas: %s" % uuid, flush=True)

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import pipeline

    work = os.path.join(ENGINE_DATA, "sfm-palyginimas", uuid)
    if not a.keep:
        shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)
    if not os.path.exists(os.path.join(work, "images")):
        os.symlink(os.path.join(task, "images"), os.path.join(work, "images"))
    gcp = os.path.join(task, "gcp")
    for f in os.listdir(gcp) if os.path.isdir(gcp) else []:
        if f.lower().endswith(".txt"):
            shutil.copy(os.path.join(gcp, f), os.path.join(work, f))

    p = pipeline.Pipeline(work, "high")
    t0 = time.time()
    p.run(until="georef")
    minutes = (time.time() - t0) / 60
    stage_t = {}
    for s in ("dataset", "features", "matching", "sfm", "georef"):
        try:
            stage_t[s] = json.load(open(p._done_path(s)))["time"] / 60
        except (OSError, ValueError, KeyError):
            pass

    import pycolmap
    rec = pycolmap.Reconstruction(os.path.join(work, "work", "sfm_geo"))
    frame = p._load_frame()
    off = np.array([frame.off_e, frame.off_n, 0.0]) if frame else np.zeros(3)
    col = {im.name: np.asarray(im.projection_center()) + off for im in rec.images.values() if im.has_pose}
    gps = {}
    if frame:
        for ph in p._photos():
            if ph.get("gps"):
                gps[ph["name"]] = frame.to_local(*ph["gps"]) + off
    odm, zone = odm_centers(task)
    st = odm_stats(task)
    n_photos = len(p._photos())

    common = sorted(set(odm) & set(col))
    shape = None
    if len(common) >= 3:
        A, B = np.array([col[n] for n in common]), np.array([odm[n] for n in common])
        raw = np.linalg.norm(A - B, axis=1)
        s, R, t = umeyama(A, B)
        fit = np.linalg.norm((s * (R @ A.T)).T + t - B, axis=1)
        shape = {"n": len(common), "raw_med": float(np.median(raw)), "raw_max": float(raw.max()),
                 "fit_rms": float(np.sqrt((fit ** 2).mean())), "fit_max": float(fit.max()), "scale": float(s)}

    def f(v, fmt="%.2f"):
        return "–" if v is None else fmt % v

    rg_odm, rg_col = residuals(odm, gps), residuals(col, gps)
    L = []
    L.append("KAMERŲ PADĖČIŲ PALYGINIMAS – projektas %s (%d nuotr., %s)" % (uuid, n_photos, zone))
    L.append("")
    L.append("%-38s %18s %18s" % ("", "ODM (OpenSfM)", "COLMAP 4 + GLOMAP"))
    L.append("%-38s %18s %18s" % ("Trukmė, min.", f(odm_sfm_minutes(os.path.join(task, "task_output.txt")), "%.1f"),
                                  "%.1f" % minutes))
    L.append("%-38s %18s %18s" % ("Sujungta nuotraukų", f(st.get("shots") or len(odm), "%d"), "%d" % len(col)))
    L.append("%-38s %18s %18s" % ("Taškų", f(st.get("points"), "%d"), "%d" % rec.num_points3D()))
    L.append("%-38s %18s %18s" % ("Perprojekcijos paklaida, px", f(st.get("reproj_px")),
                                  "%.2f" % rec.compute_mean_reprojection_error()))
    if rg_odm or rg_col:
        L.append("%-38s %18s %18s" % ("Nuo GPS: horizont. mediana, m", f(rg_odm and rg_odm["h_med"]), f(rg_col and rg_col["h_med"])))
        L.append("%-38s %18s %18s" % ("Nuo GPS: vertik. mediana, m", f(rg_odm and rg_odm["v_med"]), f(rg_col and rg_col["v_med"])))
    L.append("")
    L.append("COLMAP etapai, min.: " + ", ".join("%s %.1f" % (k, v) for k, v in stage_t.items()))
    if shape:
        L.append("Tarpusavio skirtumas (%d bendrų kamerų): be suderinimo mediana %.2f m (didž. %.2f m); "
                 "suderinus (Sim3) RMS %.3f m, didž. %.3f m, mastelio santykis %.4f"
                 % (shape["n"], shape["raw_med"], shape["raw_max"], shape["fit_rms"], shape["fit_max"], shape["scale"]))
        L.append("  Suderinus RMS < 0,05 m – sprendiniai praktiškai vienodi; didesnis – vienas iš jų išlinkęs "
                 "(tikrinti pagal GPS / kontrolinius taškus).")
    L.append("ODM trukmė – nuo požymių paieškos iki OpenMVS (su nuotraukų ištiesinimu); ODM požymiai 4000 px / 15000, "
             "COLMAP – %d px / %d." % (p.q["feature_size"], p.q["max_features"]))
    text = "\n".join(L)
    print("\n" + text, flush=True)
    open(os.path.join(work, "ataskaita.txt"), "w", encoding="utf-8").write(text + "\n")
    print("\nAtaskaita įrašyta: %s" % os.path.join(work, "ataskaita.txt"))


if __name__ == "__main__":
    main()
