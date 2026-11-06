# Atea 3D Matuoklis – Gaussian Splatting mokymas iš baigto ODM projekto (gsplat, Apache 2.0).
# Kameros ir pradiniai taškai imami iš ODM (OpenSfM ištiesintos nuotraukos + odm_filterpoints/point_cloud.ply), todėl
# nuotraukų padėčių iš naujo skaičiuoti nereikia, o rezultatas yra tame pačiame rėme kaip ODM 3D modelis.
# Paleidžia app.py:  python train.py --task-dir /odm-data/<uuid> --out-dir /data/<uuid>
import argparse
import json
import math
import os
import random
import time

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import splat_io

Image.MAX_IMAGE_PIXELS = None


def write_status(out_dir, **kw):
    p = os.path.join(out_dir, "status.json")
    try:
        cur = json.load(open(p))
    except (OSError, ValueError):
        cur = {}
    cur.update(kw, updated=time.time())
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cur, f)
    os.replace(tmp, p)


def ssim(img1, img2, window=11, sigma=1.5):
    """SSIM (H×W×3, 0..1) – kaip 3DGS nuostolių funkcijoje."""
    x, y = img1.permute(2, 0, 1)[None], img2.permute(2, 0, 1)[None]
    g = torch.exp(-((torch.arange(window, device=x.device) - window // 2) ** 2) / (2 * sigma ** 2))
    g = (g / g.sum())[:, None] @ (g / g.sum())[None, :]
    w = g.expand(3, 1, window, window).contiguous()
    f = lambda t: F.conv2d(t, w, padding=window // 2, groups=3)
    mx, my = f(x), f(y)
    sx, sy, sxy = f(x * x) - mx ** 2, f(y * y) - my ** 2, f(x * y) - mx * my
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    return (((2 * mx * my + c1) * (2 * sxy + c2)) / ((mx ** 2 + my ** 2 + c1) * (sx + sy + c2))).mean()


class Images:
    """Nuotraukos sumažintos iki max_size, laikomos RAM (uint8) – skaitomos tik kartą."""

    def __init__(self, cams, max_size):
        self.cams, self.max_size, self.cache = cams, max_size, {}

    def get(self, i):
        if i not in self.cache:
            c = self.cams[i]
            im = Image.open(c["path"]).convert("RGB")
            s = min(1.0, self.max_size / max(im.size))
            if s < 1.0:
                im = im.resize((max(1, round(im.size[0] * s)), max(1, round(im.size[1] * s))), Image.LANCZOS)
            sx, sy = im.size[0] / c["width"], im.size[1] / c["height"]
            K = c["K"].copy()
            K[0] *= sx
            K[1] *= sy
            self.cache[i] = (torch.from_numpy(np.asarray(im).copy()), K)
        return self.cache[i]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--steps", type=int, default=30000)
    ap.add_argument("--max-size", type=int, default=1600, help="nuotraukų ilgesnė kraštinė mokant (px)")
    ap.add_argument("--cap", type=int, default=3_000_000, help="didžiausias splatų skaičius")
    ap.add_argument("--sh-degree", type=int, default=3)
    ap.add_argument("--max-points", type=int, default=1_500_000)
    ap.add_argument("--depth-weight", type=float, default=0.3, help="gylio priežiūros iš ODM taškų svoris (pradžioje)")
    ap.add_argument("--max-ratio", type=float, default=10.0, help="didžiausias splato ilgio ir pločio santykis (adatos)")
    ap.add_argument("--device", default="cuda", help=argparse.SUPPRESS)  # testams: cpu
    a = ap.parse_args()
    os.makedirs(a.out_dir, exist_ok=True)
    write_status(a.out_dir, state="preparing", step=0, steps=a.steps, message="Ruošiamos nuotraukos ir taškai")

    from gsplat import rasterization
    from gsplat.strategy import MCMCStrategy

    if a.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("NVIDIA GPU nepasiekiama (CUDA)")
    dev = torch.device(a.device)
    torch.manual_seed(0)
    random.seed(0)

    cams = splat_io.load_cameras(a.task_dir)
    if len(cams) < 10:
        raise RuntimeError("per mažai kamerų ODM rekonstrukcijoje (%d)" % len(cams))
    pc = os.path.join(a.task_dir, "odm_filterpoints", "point_cloud.ply")
    if not os.path.isfile(pc):
        raise RuntimeError("nerastas ODM taškų debesis (odm_filterpoints/point_cloud.ply)")
    xyz, rgb = splat_io.load_points(pc, a.max_points)
    centers = splat_io.camera_centers(cams)
    scene_scale = float(np.linalg.norm(centers - centers.mean(0), axis=1).max()) * 1.1
    print("Kamerų: %d, taškų: %d, scenos dydis: %.1f m" % (len(cams), len(xyz), scene_scale), flush=True)

    from scipy.spatial import cKDTree
    kd = cKDTree(xyz)
    d, _ = kd.query(xyz, k=4)
    spacing = float(np.median(np.sqrt((d[:, 1:] ** 2).mean(1))))
    dist = np.sqrt((d[:, 1:] ** 2).mean(1)).clip(1e-3, scene_scale * 0.01)
    n = len(xyz)
    deg = a.sh_degree
    K = (deg + 1) ** 2 - 1
    params = torch.nn.ParameterDict({
        "means": torch.nn.Parameter(torch.tensor(xyz, device=dev)),
        "scales": torch.nn.Parameter(torch.log(torch.tensor(dist, device=dev, dtype=torch.float32))[:, None].repeat(1, 3)),
        "quats": torch.nn.Parameter(F.normalize(torch.randn(n, 4, device=dev), dim=-1)),
        "opacities": torch.nn.Parameter(torch.logit(torch.full((n,), 0.5, device=dev))),
        "sh0": torch.nn.Parameter(((torch.tensor(rgb, device=dev) - 0.5) / splat_io.SH_C0)[:, None, :]),
        "shN": torch.nn.Parameter(torch.zeros(n, K, 3, device=dev)),
    })
    lrs = {"means": 1.6e-4 * scene_scale, "scales": 5e-3, "quats": 1e-3, "opacities": 5e-2, "sh0": 2.5e-3, "shN": 2.5e-3 / 20}
    optimizers = {k: torch.optim.Adam([{"params": params[k], "lr": lr, "name": k}], eps=1e-15) for k, lr in lrs.items()}
    sched = torch.optim.lr_scheduler.ExponentialLR(optimizers["means"], gamma=0.01 ** (1.0 / a.steps))
    strategy = MCMCStrategy(cap_max=a.cap, refine_stop_iter=int(a.steps * 0.83))
    strategy.check_sanity(params, optimizers)
    state = strategy.initialize_state()

    imgs = Images(cams, a.max_size)

    # Gylio priežiūra: ODM tankus taškų debesis projektuojamas į kiekvieną nuotrauką; langelyje (DEPTH_CELL px)
    # paliekamas artimiausias taškas. Splatai baudžiami, jei jų gylis neatitinka – nebelieka „debesėlių“ ore ir
    # ištirpusių paviršių ten, kur nuotraukų mažai (aeronuotraukos – daug vienodų kampų).
    DEPTH_CELL = 4
    pts_t = torch.tensor(xyz, device=dev)
    depth_cache = {}

    def depth_target(i, H, W, Kc):
        if i in depth_cache:
            return depth_cache[i]
        V = torch.tensor(cams[i]["viewmat"], device=dev, dtype=torch.float32)
        pc = pts_t @ V[:3, :3].T + V[:3, 3]
        z = pc[:, 2]
        ok = z > 0.1
        u = Kc[0, 0] * pc[:, 0] / z.clamp_min(1e-6) + Kc[0, 2]
        v = Kc[1, 1] * pc[:, 1] / z.clamp_min(1e-6) + Kc[1, 2]
        hs, ws = H // DEPTH_CELL, W // DEPTH_CELL
        ui, vi = (u / DEPTH_CELL).floor().long(), (v / DEPTH_CELL).floor().long()
        ok &= (ui >= 0) & (ui < ws) & (vi >= 0) & (vi < hs)
        dmin = torch.full((hs * ws,), float("inf"), device=dev)
        dmin.scatter_reduce_(0, (vi * ws + ui)[ok], z[ok], reduce="amin")
        depth_cache[i] = dmin.view(hs, ws)
        return depth_cache[i]
    t0 = time.time()
    cancel = os.path.join(a.out_dir, "cancel")
    order = []
    write_status(a.out_dir, state="training", message="Mokoma", cameras=len(cams))
    for step in range(a.steps):
        if not order:
            order = list(range(len(cams)))
            random.shuffle(order)
        i = order.pop()
        gt_u8, Kc = imgs.get(i)
        gt = gt_u8.to(dev, non_blocking=True).float() / 255.0
        H, W = gt.shape[:2]
        viewmat = torch.tensor(cams[i]["viewmat"], device=dev, dtype=torch.float32)[None]
        Kt = torch.tensor(Kc, device=dev, dtype=torch.float32)[None]
        colors = torch.cat([params["sh0"], params["shN"]], 1)
        renders, alphas, info = rasterization(
            params["means"], params["quats"], torch.exp(params["scales"]), torch.sigmoid(params["opacities"]), colors,
            viewmat, Kt, W, H, sh_degree=min(step // 1000, deg), packed=False, near_plane=0.1, render_mode="RGB+ED")
        strategy.step_pre_backward(params, optimizers, state, step, info)
        img = renders[0, ..., :3].clamp(0, 1)
        l1 = (img - gt).abs().mean()
        loss = 0.8 * l1 + 0.2 * (1 - ssim(img, gt))
        sc = torch.exp(params["scales"])
        loss = loss + 0.01 * torch.sigmoid(params["opacities"]).mean() + 0.01 * sc.mean()
        # Adatos: splatas ne daugiau kaip max_ratio karto ilgesnis nei platus
        loss = loss + 0.1 * torch.relu(sc.max(-1).values / sc.min(-1).values.clamp_min(1e-8) - a.max_ratio).mean()
        # Gylis iš ODM (santykinė paklaida langelio centre); svoris mažėja, kad pabaigoje nuotraukos lemtų detales
        if a.depth_weight > 0:
            dt = depth_target(i, H, W, Kc)
            c0 = DEPTH_CELL // 2
            ed = renders[0, c0::DEPTH_CELL, c0::DEPTH_CELL, 3][: dt.shape[0], : dt.shape[1]]
            m = torch.isfinite(dt) & (alphas[0, c0::DEPTH_CELL, c0::DEPTH_CELL, 0][: dt.shape[0], : dt.shape[1]] > 0.5)
            if m.any():
                wd = a.depth_weight * (0.1 + 0.9 * (1 - step / a.steps))
                loss = loss + wd * ((ed[m] - dt[m]).abs() / dt[m]).mean()
        loss.backward()
        for opt in optimizers.values():
            opt.step()
            opt.zero_grad(set_to_none=True)
        sched.step()
        strategy.step_post_backward(params, optimizers, state, step, info, lr=sched.get_last_lr()[0])
        if step % 100 == 0 or step == a.steps - 1:
            el = time.time() - t0
            eta = el / (step + 1) * (a.steps - step - 1)
            write_status(a.out_dir, step=step + 1, eta=round(eta), splats=int(params["means"].shape[0]), loss=round(float(l1.detach()), 4))
            if step % 1000 == 0:
                print("žingsnis %d/%d, l1 %.4f, splatų %d, liko ~%d min." % (step, a.steps, float(l1.detach()), params["means"].shape[0], eta / 60), flush=True)
            if os.path.exists(cancel):
                write_status(a.out_dir, state="cancelled", message="Atšaukta")
                return

    write_status(a.out_dir, state="exporting", message="Įrašomas rezultatas")
    with torch.no_grad():
        sc = torch.exp(params["scales"])
        keep = (torch.sigmoid(params["opacities"]) > 0.005) & (sc.max(-1).values / sc.min(-1).values.clamp_min(1e-8) < 50)
        out = {k: v[keep].detach().cpu().numpy() for k, v in params.items()}
    # Splatai toli nuo bet kurio ODM taško – „debesėliai“ ore (dangus, atspindžiai): pašalinami
    far = max(1.0, 8 * spacing)
    near = splat_io.near_points_mask(out["means"], kd, far)
    print("Eksportas: pašalinta %d splatų ore (> %.1f m nuo ODM taškų) iš %d" % (int((~near).sum()), far, len(near)), flush=True)
    out = {k: v[near] for k, v in out.items()}
    q = out["quats"] / np.linalg.norm(out["quats"], axis=1, keepdims=True)
    args = (out["means"], out["scales"], q, out["opacities"], out["sh0"][:, 0, :], out["shN"])
    splat_io.write_spz(os.path.join(a.out_dir, "scene.spz.tmp"), *args)
    os.replace(os.path.join(a.out_dir, "scene.spz.tmp"), os.path.join(a.out_dir, "scene.spz"))
    splat_io.write_ply(os.path.join(a.out_dir, "scene.ply"), *args)
    m = out["means"]
    lo, hi = np.percentile(m, 2, axis=0), np.percentile(m, 98, axis=0)
    # Peržiūros pradžia – iš drono kameros padėties (įstrižos, jei tokių yra): iš ten vaizdas atrodo geriausiai
    fwd = np.array([c["viewmat"][:3, :3].T @ np.array([0, 0, 1.0]) for c in cams])
    pitch = np.degrees(np.arcsin(np.clip(-fwd[:, 2], -1, 1)))  # 90 – statmenai žemyn
    obl = np.flatnonzero((pitch > 25) & (pitch < 70))
    cand = obl if len(obl) else np.arange(len(cams))
    mid = (lo + hi) / 2
    k = cand[np.argmin(np.linalg.norm(centers[cand, :2] - centers[cand, :2].mean(0), axis=1))]
    tdist = max(1.0, float((mid - centers[k]) @ fwd[k]))
    view = {"position": centers[k].tolist(), "target": (centers[k] + fwd[k] * tdist).tolist()}
    meta = {"splats": int(len(m)), "steps": a.steps, "cameras": len(cams), "bbox": [lo.tolist(), hi.tolist()], "view": view,
            "camera_center": centers.mean(0).tolist(), "created": time.time(), "minutes": round((time.time() - t0) / 60, 1)}
    coords = os.path.join(a.task_dir, "odm_georeferencing", "coords.txt")
    if os.path.isfile(coords):
        lines = open(coords).read().split("\n")
        meta["srs"] = lines[0].strip()
        if len(lines) > 1 and lines[1].strip():
            meta["offset"] = [float(v) for v in lines[1].split()[:2]]
    json.dump(meta, open(os.path.join(a.out_dir, "meta.json"), "w"))
    write_status(a.out_dir, state="done", step=a.steps, message="Baigta", splats=int(len(m)))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # klaida matoma programoje
        import traceback
        traceback.print_exc()
        args = [x for x in os.sys.argv]
        out = args[args.index("--out-dir") + 1] if "--out-dir" in args else "."
        write_status(out, state="error", message=str(e)[:500])
        raise SystemExit(1)
