# Projekto diagnostika: aukščių pasiskirstymas retame (SfM) ir tankiame debesyje, kameros, taškai ore.
# Naudojimas (Windows PowerShell, programos aplanke):
#   Get-Content deploy\engine\diag.py | docker exec -i (docker ps -qf "name=engine") python3 - <projekto ID>
import os
import sys

import numpy as np


def hist(name, z, ground, step=3.0):
    h = z - ground
    edges = np.arange(np.floor(h.min() / step) * step, h.max() + step, step)
    cnt, _ = np.histogram(h, edges)
    print("%s: %d taškų, aukštis virš žemės (m):" % (name, len(z)))
    for a, c in zip(edges[:-1], cnt):
        if c:
            print("  %6.0f..%-5.0f %9d %s" % (a, a + step, c, "#" * int(40 * c / cnt.max())))


def main(task):
    import pycolmap
    root = task if os.path.isdir(task) else os.path.join("/engine-data", task)
    rec = pycolmap.Reconstruction(os.path.join(root, "work", "sfm_geo"))
    P = np.array([p.xyz for p in rec.points3D.values() if p.track.length() >= 3])
    C = np.array([im.projection_center() for im in rec.images.values()])
    ground = np.percentile(P[:, 2], 5)
    print("Nuotraukų: %d, taškų (≥3 vaizdai): %d, žemė ~%.1f m" % (len(C), len(P), ground))
    print("Kamerų aukštis virš žemės: min %.1f, mediana %.1f, max %.1f" % tuple(np.percentile(C[:, 2] - ground, [0, 50, 100])))
    low = C[:, 2] - ground < 0.5 * np.median(C[:, 2] - ground)
    print("Žemai (kilimas / tūpimas) nufotografuotų nuotraukų: %d" % low.sum())
    for k, cam in rec.cameras.items():
        print("Kamera %d: %s %dx%d, parametrai %s" % (k, cam.model.name, cam.width, cam.height, np.round(cam.params, 4).tolist()))
    hist("Retas debesis (SfM)", P[:, 2], ground)
    import open3d as o3d
    for name, p in (("Tankus debesis", os.path.join(root, "work", "dense", "fused.ply")),
                    ("Išvalytas debesis", os.path.join(root, "odm_filterpoints", "point_cloud.ply"))):
        if os.path.isfile(p):
            D = np.asarray(o3d.io.read_point_cloud(p).points)
            hist(name, D[:, 2], ground)
            top = np.percentile(P[:, 2], 99.9) + 3
            hi = D[:, 2] > top
            if hi.any():
                print("  virš aukščiausių SfM taškų (+3 m): %d taškų, x %.0f..%.0f, y %.0f..%.0f, z iki %.1f" % (
                    hi.sum(), *np.percentile(D[hi, 0], [1, 99]), *np.percentile(D[hi, 1], [1, 99]), D[hi, 2].max() - ground))
            break


if __name__ == "__main__":
    main(sys.argv[1])
