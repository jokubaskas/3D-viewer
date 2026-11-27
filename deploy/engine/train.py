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


_SSIM_W = {}


def ssim(img1, img2, window=11, sigma=1.5):
    """SSIM (H×W×3, 0..1) – kaip 3DGS nuostolių funkcijoje. Gauso langas atskiriamas (eilutės, tada stulpeliai) ir visi
    penki vidurkiai skaičiuojami vienu kartu – rezultatas tas pats kaip su 11×11 branduoliu, tik ~5× mažiau skaičiavimų."""
    x, y = img1.permute(2, 0, 1)[None], img2.permute(2, 0, 1)[None]
    key = (x.device, x.dtype, window, sigma)
    if key not in _SSIM_W:
        g = torch.exp(-((torch.arange(window, device=x.device, dtype=x.dtype) - window // 2) ** 2) / (2 * sigma ** 2))
        g = g / g.sum()
        _SSIM_W[key] = (g.view(1, 1, 1, window).repeat(15, 1, 1, 1), g.view(1, 1, window, 1).repeat(15, 1, 1, 1))
    wh, wv = _SSIM_W[key]
    t = torch.cat([x, y, x * x, y * y, x * y], 1)
    t = F.conv2d(F.conv2d(t, wh, padding=(0, window // 2), groups=15), wv, padding=(window // 2, 0), groups=15)
    mx, my, exx, eyy, exy = t.split(3, 1)
    sx, sy, sxy = exx - mx ** 2, eyy - my ** 2, exy - mx * my
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


RES_LEVELS = (0.25, 1 / 3, 0.5, 2 / 3, 0.8, 1.0)  # raiškos lygiai (nuotraukų mastelis), kad gylio talpykla būtų nedidelė


def res_scale(step, steps, r0=0.25, full=0.5):
    """Nuotraukų mastelis žingsniui: auga eksponentiškai nuo r0 iki 1 per pirmą full žingsnių dalį, suapvalinamas žemyn
    iki RES_LEVELS lygio (ne mažiau kaip r0)."""
    end = full * steps
    if r0 >= 1 or step >= end:
        return 1.0
    s = r0 * (1.0 / r0) ** (step / end)
    return max([l for l in RES_LEVELS if l <= s + 1e-9] or [r0])


def step_cost(s):
    """Santykinė žingsnio trukmė pagal mastelį (pastovi dalis + pikselių skaičius) – likusio laiko įvertinimui."""
    return 0.2 + 0.8 * s * s


GPU_IMAGES_SHARE = 0.15  # nuotraukos laikomos GPU, jei užima mažiau nei tokią GPU atminties dalį


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--steps", type=int, default=30000)
    ap.add_argument("--max-size", type=int, default=2400, help="nuotraukų ilgesnė kraštinė mokant (px)")
    ap.add_argument("--cap", type=int, default=3_000_000, help="didžiausias splatų skaičius")
    ap.add_argument("--sh-degree", type=int, default=3)
    ap.add_argument("--max-points", type=int, default=1_500_000)
    ap.add_argument("--depth-weight", type=float, default=0.3, help="gylio priežiūros iš ODM taškų svoris (pradžioje)")
    ap.add_argument("--max-ratio", type=float, default=10.0, help="didžiausias splato ilgio ir pločio santykis (adatos)")
    # Raiškos ir splatų kiekio tvarkaraštis (DashGaussian, CVPR 2025): pradžioje mokoma mažos raiškos nuotraukomis ir su
    # mažiau splatų (forma, spalvos), raiška ir splatų riba auga kartu, pilna raiška – nuo res_full žingsnių dalies
    ap.add_argument("--res-min", type=float, default=0.25, help="pradinė nuotraukų raiška (dalis nuo --max-size)")
    ap.add_argument("--res-full", type=float, default=0.5, help="nuo tokios žingsnių dalies mokoma pilna raiška")
    ap.add_argument("--sh-reg", type=float, default=0.01, help="atspindžių (SH) koeficientų bauda – iš naujų kampų mažiau triukšmo")
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
    # Tamsus / atspindintis stiklas taškų debesyje beveik be taškų: be jų splatų sienose nebūdavo (pradžioje), gylio
    # priežiūra ten nieko nesakė, o eksportuojant jos būdavo išmetamos kaip „debesėliai“ – sienos permatomos.
    # ODM 3D tinklas uždaras ir ten, todėl jo viršūnės toje vietoje papildo pradinius taškus, gylio priežiūrą ir
    # eksporto patikrą.
    keep_kd = kd
    mesh_xyz = splat_io.load_mesh_vertices(a.task_dir)
    if mesh_xyz is not None:
        gap = splat_io.mesh_gap_points(kd, mesh_xyz, max(0.3, 3 * spacing), max(1, a.max_points // 3))
        if len(gap):
            xyz = np.concatenate([xyz, gap])
            rgb = np.concatenate([rgb, np.full((len(gap), 3), 0.5, np.float32)])
            d, _ = cKDTree(xyz).query(xyz, k=4)
        keep_kd = cKDTree(np.concatenate([xyz, mesh_xyz]))
        print("ODM tinklo viršūnių: %d, iš jų be debesies taškų (stiklas): %d" % (len(mesh_xyz), len(gap)), flush=True)
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
    # Visos nuotraukos nuskaitomos ir sumažinamos iš anksto, lygiagrečiai – kitaip pirmas ciklas lėtas (po vieną nuotrauką
    # kiekviename žingsnyje), GPU laukia, o likusio laiko įvertinimas išpučiamas
    write_status(a.out_dir, message="Nuskaitomos nuotraukos")
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 4)) as ex:
        list(ex.map(imgs.get, range(len(cams))))
    # Nuotraukos – vaizdo plokštės atmintyje, jei jos pakanka (nereikia kiekviename žingsnyje kopijuoti ~13 MB per
    # PCIe); kitaip – fiksuotoje (pinned) RAM, kad kopijavimas vyktų lygiagrečiai su skaičiavimu
    if dev.type == "cuda":
        img_bytes = sum(v[0].numel() for v in imgs.cache.values())
        total = torch.cuda.get_device_properties(dev).total_memory
        on_gpu = img_bytes < GPU_IMAGES_SHARE * total
        for k, (t, Kc) in list(imgs.cache.items()):
            imgs.cache[k] = (t.to(dev) if on_gpu else t.pin_memory(), Kc)
        print("Nuotraukos (%.1f GB) laikomos %s; GPU atmintis %.1f GB" % (img_bytes / 1e9, "GPU" if on_gpu else "RAM",
              total / 1e9), flush=True)
    viewmats = torch.tensor(np.stack([c["viewmat"] for c in cams]), device=dev, dtype=torch.float32)

    # Gylio priežiūra: ODM tankus taškų debesis projektuojamas į kiekvieną nuotrauką; langelyje (DEPTH_CELL px)
    # paliekamas artimiausias taškas. Splatai baudžiami, jei jų gylis neatitinka – nebelieka „debesėlių“ ore ir
    # ištirpusių paviršių ten, kur nuotraukų mažai (aeronuotraukos – daug vienodų kampų).
    DEPTH_CELL = 4
    pts_t = torch.tensor(xyz, device=dev)
    depth_cache = {}

    def depth_target(i, H, W, Kc):
        if (i, H) in depth_cache:
            return depth_cache[(i, H)]
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
        depth_cache[(i, H)] = dmin.view(hs, ws)
        return depth_cache[(i, H)]
    t0 = time.time()
    cancel = os.path.join(a.out_dir, "cancel")
    order = []
    scales_sched = np.array([res_scale(k, a.steps, a.res_min, a.res_full) for k in range(a.steps)])
    cost_left = np.cumsum([step_cost(x) for x in scales_sched][::-1])[::-1]  # cost_left[k] – žingsnių k..pabaigos kaina
    n0 = n
    t_warm, w_warm = None, 0.0  # laikas po įšilimo (pirmi žingsniai – CUDA kompiliavimas, nuotraukų skaitymas)
    w_acc = 0.0
    t_block, s_block = time.time(), 0
    write_status(a.out_dir, state="training", message="Mokoma", cameras=len(cams))
    for step in range(a.steps):
        if not order:
            order = list(range(len(cams)))
            random.shuffle(order)
        i = order.pop()
        gt_u8, Kc = imgs.get(i)
        gt = gt_u8.to(dev, non_blocking=True).float() / 255.0
        rs = float(scales_sched[step])
        if rs < 1.0:
            # Mažesnė raiška: forma ir spalvos mokomos greičiau, smulkios detalės – vėliau pilna raiška
            H0, W0 = gt.shape[:2]
            Hs, Ws = max(8, round(H0 * rs)), max(8, round(W0 * rs))
            gt = F.interpolate(gt.permute(2, 0, 1)[None], size=(Hs, Ws), mode="area")[0].permute(1, 2, 0)
            Kc = Kc.copy()
            sx, sy = Ws / W0, Hs / H0
            Kc[0, 0] *= sx
            Kc[1, 1] *= sy
            Kc[0, 2] = (Kc[0, 2] + 0.5) * sx - 0.5  # pikselio centras
            Kc[1, 2] = (Kc[1, 2] + 0.5) * sy - 0.5
        # Splatų riba auga kartu su raiška (mažai raiškai daug splatų nereikia – tik lėtina)
        if a.cap > n0:
            strategy.cap_max = int(n0 + (a.cap - n0) * min(1.0, (rs - a.res_min) / max(1e-6, 1.0 - a.res_min)))
        H, W = gt.shape[:2]
        viewmat = viewmats[i][None]
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
        # Atspindžiai švelnūs: kryptinė spalva išmokstama tik tiek, kiek tikrai matoma nuotraukose (iš kitų kampų – ramiau)
        if a.sh_reg > 0 and step >= 1000:
            loss = loss + a.sh_reg * (params["shN"] ** 2).mean()
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
        w_acc += step_cost(rs)
        if step % 100 == 0 or step == a.steps - 1:
            if t_warm is None and step >= 100:
                t_warm, w_warm = time.time(), w_acc
            eta = None
            if t_warm is not None and w_acc - w_warm > 20:
                # sekundės vienam „kainos“ vienetui (pilnos raiškos žingsniui) × likusių žingsnių kaina
                eta = (time.time() - t_warm) / (w_acc - w_warm) * (float(cost_left[step + 1]) if step + 1 < a.steps else 0.0)
            write_status(a.out_dir, step=step + 1, eta=round(eta) if eta is not None else None, splats=int(params["means"].shape[0]), loss=round(float(l1.detach()), 4))
            if step % 1000 == 0:
                per = (time.time() - t_block) / max(1, step - s_block)
                t_block, s_block = time.time(), step
                print("žingsnis %d/%d, raiška %d×%d, l1 %.4f, splatų %d, %.0f ms/žingsn., liko ~%s min." % (
                      step, a.steps, W, H, float(l1.detach()), params["means"].shape[0], per * 1000,
                      "?" if eta is None else int(eta / 60)), flush=True)
            if os.path.exists(cancel):
                write_status(a.out_dir, state="cancelled", message="Atšaukta")
                return

    write_status(a.out_dir, state="exporting", message="Įrašomas rezultatas")
    with torch.no_grad():
        sc = torch.exp(params["scales"])
        keep = (torch.sigmoid(params["opacities"]) > 0.005) & (sc.max(-1).values / sc.min(-1).values.clamp_min(1e-8) < 50)
        out = {k: v[keep].detach().cpu().numpy() for k, v in params.items()}
    # Splatai toli nuo bet kurio ODM taško ir tinklo – „debesėliai“ ore (dangus, atspindžiai): pašalinami
    far = max(1.0, 8 * spacing)
    near = splat_io.near_points_mask(out["means"], keep_kd, far)
    print("Eksportas: pašalinta %d splatų ore (> %.1f m nuo ODM taškų ir tinklo) iš %d" % (int((~near).sum()), far, len(near)), flush=True)
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
