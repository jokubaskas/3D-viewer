# Atea 3D Matuoklis – „Sujungtas modelis“: realistiško vaizdo (splatų) ir ODM 3D modelio suliejimas į vieną
# tikroviškai atrodantį 3D modelį (GLB su spalvomis), kuris tinka matavimams, eksportui ir portalui.
#
# Kiekvienai drono kamerai:
#   • modelio gylis – spindulių sekimas ODM tinkle (Open3D RaycastingScene, išvalytas odm_meshing/odm_mesh.ply);
#   • splatų gylis ir spalva – atvaizdavimas (gsplat; testuose – pakaitalas).
# Taisyklės kiekviename taške:
#   • splatas arčiau kameros nei modelis (≥ TOL) – modelyje trūksta (skylė, medis, parapetas, stulpas) → splatas;
#   • splatas toliau už modelį – atspindys stikle („virtualus“ vaizdas už paviršiaus) → modelis (išlygintas fasadas);
#   • abu sutampa → modelis (tikslesnė geometrija);
#   • modelio ten nėra, splatas nepermatomas → splatas.
# Spalva – iš splatų (vidurkis iš daugelio kampų – be atspindžių šuolių). Suliejimas – TSDF (Open3D, MIT): paviršius
# iš visų kampų, atsitiktiniai neatitikimai (debesėliai) „ištrinami“ kitų kampų laisvos erdvės.
import json
import os
import time

import numpy as np

TOL = 0.5          # m – kiek arčiau turi būti splatas, kad būtų laikomas modelyje trūkstama dalimi (+ 2 % atstumo)
MAX_TRIANGLES = 6_000_000  # naršyklei (~150 MB GLB)
STRIDE = 4         # Open3D DepthTouch žingsnis (pikseliais)
MIN_TOUCH = 16     # mažiausiai tiek tinkamų pikselių (kas STRIDE-ojo), kad kadras būtų suliejamas
ALPHA_MIN = 0.9    # splato nepermatomumas, nuo kurio jo gylis patikimas


def _o3d():
    import open3d as o3d
    return o3d


BLOCKS = 60_000      # pradinė TSDF blokų (16³ vokselių) talpa; prireikus Open3D ją padidina
TRI_BUDGET = 8_000_000  # suliejamo paviršiaus trikampių riba (atmintis: ~1,1 GB / 1 mln.; žr. mem_budget)
GB = 1024 ** 3


def mem_available():
    """Laisva atmintis baitais: mažesnė iš /proc/meminfo MemAvailable ir konteinerio (cgroup) ribos likučio."""
    avail = None
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemAvailable:"):
                avail = int(line.split()[1]) * 1024
    except OSError:
        pass
    try:
        lim = open("/sys/fs/cgroup/memory.max").read().strip()
        if lim != "max":
            used = int(open("/sys/fs/cgroup/memory.current").read())
            left = int(lim) - used
            avail = left if avail is None else min(avail, left)
    except (OSError, ValueError):
        pass
    return avail


def max_rss_gb():
    import resource
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / 1024


def tri_budget(avail=None):
    """Kiek trikampių galima sulieti: išmatuota ~1,1 GB atminties milijonui (suliejimas, išgavimas, valymas,
    supaprastinimas), imama pusė laisvos atminties, ne daugiau TRI_BUDGET."""
    avail = mem_available() if avail is None else avail
    if not avail:
        return TRI_BUDGET
    return int(np.clip(0.5 * avail / (1.1 * GB) * 1e6, 1e6, TRI_BUDGET))


def auto_voxel(lo, hi, triangles=TRI_BUDGET):
    """Vokselio dydis pagal srities plotą: paviršius ≈ 2,5 × plotas, ~2 trikampiai vienam vokselio kvadratui.
    8 mln. trikampių: 40×40 m – ~3 cm, 80×80 m – ~6 cm, 200×200 m – ~15 cm."""
    area = max(1.0, float(hi[0] - lo[0]) * float(hi[1] - lo[1]))
    return float(np.clip(np.sqrt(2 * 2.5 * area / triangles), 0.02, 0.15))


def sees_region(cam, lo, hi):
    """Ar kamera mato bent dalį srities (kampų ar centro projekcija kadre)."""
    P = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])] + [(lo + hi) / 2])
    V = cam["viewmat"]
    c = P @ V[:3, :3].T + V[:3, 3]
    ok = c[:, 2] > 0.1
    if not ok.any():
        return False
    uv = (c[ok] @ cam["K"].T)
    uv = uv[:, :2] / uv[:, 2:]
    lo_uv, hi_uv = uv.min(0), uv.max(0)
    return lo_uv[0] < cam["width"] and hi_uv[0] > 0 and lo_uv[1] < cam["height"] and hi_uv[1] > 0


def in_region(d, cam, K, lo, hi):
    """Pikseliai, kurių 3D taškas srities ribose (kiti nesuliejami – taupoma atmintis)."""
    H, W = d.shape
    u, v = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    x = (u - K[0, 2]) / K[0, 0] * d
    y = (v - K[1, 2]) / K[1, 1] * d
    Vi = np.linalg.inv(cam["viewmat"])
    P = np.stack([x, y, d], -1) @ Vi[:3, :3].T + Vi[:3, 3]
    return np.all((P >= lo) & (P <= hi), -1)


def mesh_depth(scene, cam, W, H, K):
    """Modelio z gylis (kameros koordinatėse) kiekvienam pikseliui; inf – nepataikyta."""
    o3d = _o3d()
    V = cam["viewmat"]
    rays = o3d.t.geometry.RaycastingScene.create_rays_pinhole(
        o3d.core.Tensor(K, dtype=o3d.core.Dtype.Float64), o3d.core.Tensor(V, dtype=o3d.core.Dtype.Float64), W, H)
    ans = scene.cast_rays(rays)
    t = ans["t_hit"].numpy()  # [H, W]
    r = rays.numpy()  # [H, W, 6] – pradžia ir kryptis pasaulio koordinatėmis
    hit = np.isfinite(t)
    p = r[..., :3] + r[..., 3:] * np.where(hit, t, 0)[..., None]
    z = p @ V[2, :3] + V[2, 3]
    return np.where(hit, z, np.inf).astype(np.float32)


def fuse_depth(d_mesh, d_splat, alpha, tol=TOL):
    """Sujungtas gylis pagal taisykles (žr. viršuje). Grąžina (gylis, šaltinis: 0 – nėra, 1 – modelis, 2 – splatas)."""
    ok_s = np.isfinite(d_splat) & (alpha >= ALPHA_MIN) & (d_splat > 0)
    ok_m = np.isfinite(d_mesh)
    tolz = tol + 0.02 * np.where(ok_m, d_mesh, 0)
    use_s = ok_s & (~ok_m | (d_splat < d_mesh - tolz))
    use_m = ok_m & ~use_s
    d = np.where(use_s, d_splat, np.where(use_m, d_mesh, 0)).astype(np.float32)
    src = np.where(use_s, 2, np.where(use_m, 1, 0)).astype(np.uint8)
    return d, src


def fuse(cams, render_fn, mesh_path, bounds, out_glb, max_size=1024, voxel=None, min_views=3.0, log=print, progress=None,
         stage=None):
    """
    cams – splat_io.load_cameras(); render_fn(cam, W, H, K) → (rgb H×W×3 0..1, gylis H×W, nepermatomumas H×W);
    mesh_path – ODM tinklas (gali nebūti); bounds – (lo[3], hi[3]) suliejimo sritis.
    """
    o3d = _o3d()
    lo, hi = np.asarray(bounds[0], float), np.asarray(bounds[1], float)
    if voxel is None:
        avail = mem_available()
        voxel = auto_voxel(lo, hi, tri_budget(avail))
        log("Laisva atmintis: %s, vokselis %.1f cm" % ("%.1f GB" % (avail / GB) if avail else "nežinoma", voxel * 100))
    cams = [c for c in cams if sees_region(c, lo, hi)]
    if not cams:
        raise RuntimeError("Nė viena kamera nemato pasirinktos srities")
    margin = 8 * voxel
    scene = None
    if mesh_path and os.path.isfile(mesh_path):
        m = o3d.t.io.read_triangle_mesh(mesh_path)
        scene = o3d.t.geometry.RaycastingScene()
        scene.add_triangles(m)
    T = o3d.core
    dev = T.Device("CPU:0")
    trunc = 4.0
    vbg = o3d.t.geometry.VoxelBlockGrid(attr_names=("tsdf", "weight", "color"), attr_dtypes=(T.float32, T.float32, T.float32),
                                        attr_channels=(1, 1, 3), voxel_size=voxel, block_resolution=16,
                                        block_count=BLOCKS, device=dev)
    stats = np.zeros(3, np.int64)
    used = 0
    t0 = time.time()
    for i, cam in enumerate(cams):
        s = min(1.0, max_size / max(cam["width"], cam["height"]))
        W, H = max(1, round(cam["width"] * s)), max(1, round(cam["height"] * s))
        K = cam["K"].copy()
        K[0] *= W / cam["width"]
        K[1] *= H / cam["height"]
        rgb, d_s, a = render_fn(cam, W, H, K)
        d_m = mesh_depth(scene, cam, W, H, K) if scene is not None else np.full((H, W), np.inf, np.float32)
        d, src = fuse_depth(d_m, d_s, a)
        d[~np.isfinite(d)] = 0
        out = (d > 0) & ~in_region(d, cam, K, lo - margin, hi + margin)
        d[out], src[out] = 0, 0
        stats += np.bincount(src.ravel(), minlength=3)[:3]
        # Open3D blokus parenka tik iš kas STRIDE-ojo pikselio ir be jų nutraukia darbą – kameros, kurios sritį mato
        # tik keliais pikseliais (kraštu), praleidžiamos
        if (d[::STRIDE, ::STRIDE] > 0).sum() >= MIN_TOUCH:
            dep = o3d.t.geometry.Image(T.Tensor(np.ascontiguousarray(d, np.float32)))
            col = o3d.t.geometry.Image(T.Tensor(np.ascontiguousarray(np.clip(rgb, 0, 1), np.float32)))
            Kt, E = T.Tensor(K), T.Tensor(np.ascontiguousarray(cam["viewmat"], np.float64))
            try:
                blocks = vbg.compute_unique_block_coordinates(dep, Kt, E, 1.0, 1e6, trunc)
                vbg.integrate(blocks, dep, col, Kt, Kt, E, 1.0, 1e6, trunc)
                used += 1
            except RuntimeError as e:
                if "No block is touched" not in str(e):
                    raise
        if progress:
            progress(i + 1, len(cams), time.time() - t0)
    if not used:
        raise RuntimeError("Nė viena kamera nemato paviršiaus pasirinktoje srityje – padidinkite atstumą arba rinkitės visą projektą")
    tot = max(1, stats[1] + stats[2])
    log("Suliejimas: modelis %.0f %%, splatai %.0f %% (vokselis %.1f cm)" % (100 * stats[1] / tot, 100 * stats[2] / tot, voxel * 100))
    stage = stage or (lambda m: None)
    nblocks = vbg.hashmap().size()
    # Išgaunant paviršių atmintis dar išauga (išmatuota ~0,36 MB blokui) – geriau aiški klaida nei nutrauktas procesas
    need, avail = nblocks * 0.36e6, mem_available()
    log("TSDF blokų: %d, atminties naudota iki šiol: %.1f GB, laisva: %s" % (nblocks, max_rss_gb(), "%.1f GB" % (avail / GB) if avail else "?"))
    if avail and need > 0.9 * avail:
        raise RuntimeError("Per mažai atminties paviršiui išgauti (reikia ~%.0f GB, laisva %.0f GB) – sumažinkite atstumą"
                           % (need / GB, avail / GB))
    stage("Išgaunamas paviršius")
    tmesh = vbg.extract_triangle_mesh(weight_threshold=min_views)
    del vbg
    log("Išgauta trikampių: %d (atmintis iki šiol %.1f GB)" % (tmesh.triangle.indices.shape[0], max_rss_gb()))
    mesh = tmesh.to_legacy()
    del tmesh
    stage("Valomi smulkūs gabalai")
    # Sritis ir smulkūs atskiri gabalai
    box = o3d.geometry.AxisAlignedBoundingBox(lo, hi)
    mesh = mesh.crop(box)
    if len(mesh.triangles):
        cl, n, _ = mesh.cluster_connected_triangles()
        cl, n = np.asarray(cl), np.asarray(n)
        mesh.remove_triangles_by_mask(n[cl] < max(50, 0.002 * len(cl)))
        mesh.remove_unreferenced_vertices()
    if not len(mesh.triangles):
        raise RuntimeError("Suliejus paviršius neliko (per mažai kamerų mato tą pačią vietą) – padidinkite atstumą")
    if len(mesh.triangles) > MAX_TRIANGLES:
        log("Supaprastinama: %d → %d trikampių" % (len(mesh.triangles), MAX_TRIANGLES))
        stage("Supaprastinama")
        mesh = mesh.simplify_quadric_decimation(MAX_TRIANGLES)
    stage("Įrašoma")
    mesh.compute_vertex_normals()
    V = np.asarray(mesh.vertices)
    F = np.asarray(mesh.triangles)
    # glTF COLOR_0 – tiesinės spalvos, o nuotraukų (splatų) – sRGB
    c = np.clip(np.asarray(mesh.vertex_colors), 0, 1)
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    C = np.round(c * 255).astype(np.uint8)
    import trimesh
    tm = trimesh.Trimesh(V, F, vertex_colors=np.c_[C, np.full(len(C), 255, np.uint8)], process=False)
    tm.export(out_glb)
    log("Sujungtas modelis: %d trikampių (naudota kamerų: %d iš %d, atminties daugiausia %.1f GB)" % (len(F), used, len(cams), max_rss_gb()))
    return {"triangles": int(len(F)), "voxel": voxel, "from_mesh": float(stats[1] / tot), "from_splats": float(stats[2] / tot)}


# ---------------------------------------------------------------- paleidimas (splat paslauga, su GPU)
def gsplat_renderer(ply_path, device="cuda"):
    """Apmokytų splatų (scene.ply) atvaizdavimas: spalva, tikėtinas gylis, nepermatomumas."""
    import torch
    from gsplat import rasterization
    import splat_io

    v = splat_io.read_ply_vertices(ply_path)
    names = v.dtype.names
    nrest = len([n for n in names if n.startswith("f_rest_")])
    K = nrest // 3
    deg = {0: 0, 3: 1, 8: 2, 15: 3}.get(K, 0)
    f = lambda *ks: np.stack([v[k] for k in ks], 1).astype(np.float32)
    dev = torch.device(device)
    means = torch.tensor(f("x", "y", "z"), device=dev)
    quats = torch.nn.functional.normalize(torch.tensor(f("rot_0", "rot_1", "rot_2", "rot_3"), device=dev), dim=-1)
    scales = torch.exp(torch.tensor(f("scale_0", "scale_1", "scale_2"), device=dev))
    opac = torch.sigmoid(torch.tensor(v["opacity"].astype(np.float32), device=dev))
    sh0 = f("f_dc_0", "f_dc_1", "f_dc_2")[:, None, :]
    rest = f(*["f_rest_%d" % i for i in range(nrest)]).reshape(-1, 3, K).transpose(0, 2, 1) if K else np.zeros((len(sh0), 0, 3), np.float32)
    colors = torch.tensor(np.concatenate([sh0, rest], 1), device=dev)

    def render(cam, W, H, Kc):
        with torch.no_grad():
            vm = torch.tensor(cam["viewmat"], device=dev, dtype=torch.float32)[None]
            Kt = torch.tensor(Kc, device=dev, dtype=torch.float32)[None]
            out, alpha, _ = rasterization(means, quats, scales, opac, colors, vm, Kt, W, H, sh_degree=deg,
                                          packed=False, near_plane=0.1, render_mode="RGB+ED")
            o = out[0].float().cpu().numpy()
            return o[..., :3], o[..., 3], alpha[0, ..., 0].float().cpu().numpy()

    return render


def region(pts, centers, radius=0, cx=None, cy=None):
    """Suliejimo sritis: visas projektas (1–99 % taškų) arba kvadratas ±radius aplink centrą (numatyta – kamerų vidurys,
    orbitos misijoje tai pastatas). Aukštis – iš taškų toje srityje."""
    if radius and radius > 0:
        c = np.array([np.median(centers[:, 0]) if cx is None else cx, np.median(centers[:, 1]) if cy is None else cy])
        sel = np.all(np.abs(pts[:, :2] - c) <= radius, 1)
        if sel.sum() < 100:
            raise RuntimeError("Pasirinktoje srityje beveik nėra taškų – padidinkite spindulį")
        z = np.percentile(pts[sel, 2], [0.5, 99.9])
        return np.array([c[0] - radius, c[1] - radius, z[0] - 1.0]), np.array([c[0] + radius, c[1] + radius, z[1] + 1.0])
    return np.percentile(pts, 1, axis=0) - 2.0, np.percentile(pts, 99, axis=0) + 2.0


def main():
    import argparse
    import splat_io
    ap = argparse.ArgumentParser()
    ap.add_argument("--task-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--max-size", type=int, default=1024)
    ap.add_argument("--voxel", type=float, default=None)
    ap.add_argument("--radius", type=float, default=0, help="srities pusplotis (m) aplink centrą; 0 – visas projektas")
    ap.add_argument("--cx", type=float, default=None, help="srities centras (ODM vietinės koordinatės); numatyta – kamerų centras")
    ap.add_argument("--cy", type=float, default=None)
    ap.add_argument("--device", default="cuda", help=argparse.SUPPRESS)
    a = ap.parse_args()
    st_path = os.path.join(a.out_dir, "fuse_status.json")

    def status(**kw):
        try:
            cur = json.load(open(st_path))
        except (OSError, ValueError):
            cur = {}
        cur.update(kw, updated=time.time())
        json.dump(cur, open(st_path + ".tmp", "w"))
        os.replace(st_path + ".tmp", st_path)

    try:
        status(state="preparing", message="Ruošiamas suliejimas")
        cams = splat_io.load_cameras(a.task_dir)
        ply = os.path.join(a.out_dir, "scene.ply")
        if not os.path.isfile(ply):
            raise RuntimeError("Pirma apmokykite realistišką vaizdą")
        pts, _ = splat_io.load_points(os.path.join(a.task_dir, "odm_filterpoints", "point_cloud.ply"), 2_000_000)
        lo, hi = region(pts, splat_io.camera_centers(cams), a.radius, a.cx, a.cy)
        render = gsplat_renderer(ply, a.device)
        mesh = os.path.join(a.task_dir, "odm_meshing", "odm_mesh.ply")
        out = os.path.join(a.out_dir, "fused.glb")
        status(state="fusing", step=0, steps=len(cams), message="Suliejama")
        res = fuse(cams, render, mesh, (lo, hi), out + ".tmp.glb", a.max_size, a.voxel, log=lambda m: print(m, flush=True),
                   progress=lambda i, n, el: (i % 10 == 0 or i == n) and status(step=i, steps=n, eta=round(el / i * (n - i))),
                   stage=lambda m: (print(m, flush=True), status(state="finishing", message=m)))
        os.replace(out + ".tmp.glb", out)
        coords = os.path.join(a.task_dir, "odm_georeferencing", "coords.txt")
        if os.path.isfile(coords):
            import shutil
            shutil.copy(coords, os.path.join(a.out_dir, "coords.txt"))
        status(state="done", message="Baigta", **res)
    except Exception as e:
        import traceback
        traceback.print_exc()
        status(state="error", message=str(e)[:500])
        raise SystemExit(1)


if __name__ == "__main__":
    main()
