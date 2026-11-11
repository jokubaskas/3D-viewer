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


BLOCKS = 20_000      # pradinė TSDF blokų (16³ vokselių) talpa vienai daliai; prireikus Open3D ją padidina
TILE_TRIANGLES = 1_500_000  # apytiksliai trikampių vienoje dalyje (plytelėje) – ~2 GB atminties
TRI_BUDGET = 16_000_000  # suliejamo paviršiaus trikampių (prieš supaprastinimą) riba visai sričiai – nuo jos priklauso
                         # detalumas ir trukmė; atmintis ribojama dalimis (plytelėmis), ne šiuo skaičiumi
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


def tile_triangles(avail=None):
    """Kiek trikampių vienoje dalyje: ~1,5 mln. – ~4 GB atminties (išmatuota); mažai laisvos atminties – mažesnės dalys."""
    avail = mem_available() if avail is None else avail
    if not avail:
        return TILE_TRIANGLES
    return int(np.clip(avail / (4 * GB) * TILE_TRIANGLES, 300_000, TILE_TRIANGLES))


def auto_voxel(lo, hi, triangles=TRI_BUDGET):
    """Vokselio dydis pagal srities plotą: paviršius ≈ 2,5 × plotas, ~2 trikampiai vienam vokselio kvadratui.
    16 mln. trikampių: 40×40 m – ~2 cm, 80×80 m – ~4,5 cm, 200×200 m – ~11 cm."""
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


def world_points(d, cam, K):
    """Gylio vaizdo (z) pikselių 3D taškai pasaulio koordinatėmis (H×W×3)."""
    H, W = d.shape
    u, v = np.meshgrid(np.arange(W, dtype=np.float32) + 0.5, np.arange(H, dtype=np.float32) + 0.5)
    x = (u - K[0, 2]) / K[0, 0] * d
    y = (v - K[1, 2]) / K[1, 1] * d
    Vi = np.linalg.inv(cam["viewmat"])
    return np.stack([x, y, d], -1) @ Vi[:3, :3].T.astype(np.float32) + Vi[:3, 3].astype(np.float32)


def in_region(d, cam, K, lo, hi):
    """Pikseliai, kurių 3D taškas srities ribose."""
    P = world_points(d, cam, K)
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
         stage=None, tile=None, work_dir=None):
    """
    cams – splat_io.load_cameras(); render_fn(cam, W, H, K) → (rgb H×W×3 0..1, gylis H×W, nepermatomumas H×W);
    mesh_path – ODM tinklas (gali nebūti); bounds – (lo[3], hi[3]) suliejimo sritis.
    """
    o3d = _o3d()
    stage = stage or (lambda m, part=None, parts=None: None)
    lo, hi = np.asarray(bounds[0], float), np.asarray(bounds[1], float)
    avail = mem_available()
    if voxel is None:
        voxel = auto_voxel(lo, hi)
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
        del m
    import shutil
    import tempfile
    work = tempfile.mkdtemp(prefix="fuse_", dir=work_dir)
    try:
        # 1. Kiekviena kamera atvaizduojama vieną kartą: sujungtas gylis ir spalva → laikinas failas diske
        frames = []
        stats = np.zeros(3, np.int64)
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
            P = world_points(d, cam, K)
            ok = (d > 0) & np.all((P >= lo - margin) & (P <= hi + margin), -1)
            d[~ok], src[~ok] = 0, 0
            stats += np.bincount(src.ravel(), minlength=3)[:3]
            if ok.sum() >= MIN_TOUCH:
                f = os.path.join(work, "%05d.npz" % i)
                np.savez(f, d=d.astype(np.float32), rgb=np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8))
                xy = P[ok][:, :2]
                frames.append({"cam": cam, "K": K, "file": f, "lo": xy.min(0), "hi": xy.max(0)})
            del rgb, d_s, a, d_m, P
            if progress:
                progress(i + 1, len(cams), time.time() - t0)
        if not frames:
            raise RuntimeError("Nė viena kamera nemato paviršiaus pasirinktoje srityje – padidinkite atstumą arba rinkitės visą projektą")
        tot = max(1, stats[1] + stats[2])
        log("Suliejimas: modelis %.0f %%, splatai %.0f %% (vokselis %.1f cm, kamerų %d)"
            % (100 * stats[1] / tot, 100 * stats[2] / tot, voxel * 100, len(frames)))

        # 2. Plytelėmis: kiekviena suliejama ir išgaunama atskirai – atmintis nepriklauso nuo srities dydžio
        if tile is None:
            tile = float(np.clip(np.sqrt(tile_triangles(avail) * voxel ** 2 / 5.0), 5.0, 200.0))
        nx = max(1, int(np.ceil((hi[0] - lo[0]) / tile)))
        ny = max(1, int(np.ceil((hi[1] - lo[1]) / tile)))
        parts, used = [], set()
        for k, (ix, iy) in enumerate([(ix, iy) for iy in range(ny) for ix in range(nx)]):
            stage("Išgaunamas paviršius", k + 1, nx * ny)
            tlo = np.array([lo[0] + ix * (hi[0] - lo[0]) / nx, lo[1] + iy * (hi[1] - lo[1]) / ny, lo[2]])
            thi = np.array([lo[0] + (ix + 1) * (hi[0] - lo[0]) / nx, lo[1] + (iy + 1) * (hi[1] - lo[1]) / ny, hi[2]])
            # Trikampių riba dalies plotui: visas modelis ≤ MAX_TRIANGLES be didelio galutinio supaprastinimo,
            # kuris pats sunaudotų daug atminties (24 mln. → 6 mln. – > 15 GB)
            cap = int(MAX_TRIANGLES * np.prod(thi[:2] - tlo[:2]) / max(1e-9, np.prod(hi[:2] - lo[:2])))
            V, F, C, n = _fuse_tile(o3d, frames, tlo, thi, voxel, margin, min_views, used, cap)
            if len(F):
                parts.append((V, F, C))
            if nx * ny > 1:
                log("Dalis %d/%d: kamerų %d, trikampių %d, atmintis iki šiol %.1f GB" % (k + 1, nx * ny, n, len(F), max_rss_gb()))
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if not parts:
        raise RuntimeError("Suliejus paviršius neliko (per mažai kamerų mato tą pačią vietą) – padidinkite atstumą")
    off = np.cumsum([0] + [len(p[0]) for p in parts[:-1]])
    mesh = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(np.concatenate([p[0] for p in parts])),
                                     o3d.utility.Vector3iVector(np.concatenate([p[1] + o for p, o in zip(parts, off)])))
    mesh.vertex_colors = o3d.utility.Vector3dVector(np.concatenate([p[2] for p in parts]))
    del parts
    if len(mesh.triangles) > 1.2 * MAX_TRIANGLES:
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
    log("Sujungtas modelis: %d trikampių (kamerų: %d iš %d, dalių: %d, atminties daugiausia %.1f GB)"
        % (len(F), len(used), len(cams), nx * ny, max_rss_gb()))
    return {"triangles": int(len(F)), "voxel": voxel, "tiles": nx * ny,
            "from_mesh": float(stats[1] / tot), "from_splats": float(stats[2] / tot)}


def _fuse_tile(o3d, frames, tlo, thi, voxel, margin, min_views, used, cap=None):
    """Viena plytelė: TSDF iš kadrų, matančių plytelę (su paraštėmis), išgavimas, smulkių gabalų šalinimas ir
    apkirpimas tiksliai iki plytelės ribų (gretimos plytelės susiglaudžia)."""
    T = o3d.core
    blo, bhi = tlo - margin, thi + margin
    vbg = o3d.t.geometry.VoxelBlockGrid(attr_names=("tsdf", "weight", "color"), attr_dtypes=(T.float32, T.float32, T.float32),
                                        attr_channels=(1, 1, 3), voxel_size=voxel, block_resolution=16,
                                        block_count=BLOCKS, device=T.Device("CPU:0"))
    n = 0
    for fr in frames:
        if np.any(fr["hi"] < blo[:2]) or np.any(fr["lo"] > bhi[:2]):
            continue
        z = np.load(fr["file"])
        d, rgb = z["d"], z["rgb"]
        P = world_points(d, fr["cam"], fr["K"])
        d = np.where((d > 0) & np.all((P >= blo) & (P <= bhi), -1), d, 0).astype(np.float32)
        del P
        # Open3D blokus parenka tik iš kas STRIDE-ojo pikselio ir be jų nutraukia darbą
        if (d[::STRIDE, ::STRIDE] > 0).sum() < MIN_TOUCH:
            continue
        dep = o3d.t.geometry.Image(T.Tensor(d))
        col = o3d.t.geometry.Image(T.Tensor(np.ascontiguousarray(rgb.astype(np.float32) / 255.0)))
        Kt, E = T.Tensor(fr["K"]), T.Tensor(np.ascontiguousarray(fr["cam"]["viewmat"], np.float64))
        try:
            blocks = vbg.compute_unique_block_coordinates(dep, Kt, E, 1.0, 1e6, 4.0)
            vbg.integrate(blocks, dep, col, Kt, Kt, E, 1.0, 1e6, 4.0)
            n += 1
            used.add(fr["file"])
        except RuntimeError as e:
            if "No block is touched" not in str(e):
                raise
    empty = (np.zeros((0, 3)), np.zeros((0, 3), np.int64), np.zeros((0, 3)), n)
    if not n:
        return empty
    tm = vbg.extract_triangle_mesh(weight_threshold=min_views)
    del vbg
    if not tm.triangle.indices.shape[0]:
        return empty
    mesh = tm.to_legacy()
    del tm
    # Smulkūs atskiri gabalai („debesėliai“) – su paraštėmis, kad prie ribos nukirsti tikri paviršiai neišnyktų
    cl, cnt, _ = mesh.cluster_connected_triangles()
    cl, cnt = np.asarray(cl), np.asarray(cnt)
    mesh.remove_triangles_by_mask(cnt[cl] < max(50, 0.002 * len(cl)))
    mesh.remove_unreferenced_vertices()
    mesh = mesh.crop(o3d.geometry.AxisAlignedBoundingBox(np.r_[tlo[:2], tlo[2] - margin], np.r_[thi[:2], thi[2] + margin]))
    if cap and len(mesh.triangles) > cap:
        # Kraštai (dalių sandūros) išlaikomi, kad gretimos dalys susiglaustų
        mesh = mesh.simplify_quadric_decimation(cap, boundary_weight=1000.0)
    return np.asarray(mesh.vertices), np.asarray(mesh.triangles), np.asarray(mesh.vertex_colors), n


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
                   work_dir=a.out_dir,
                   progress=lambda i, n, el: (i % 10 == 0 or i == n) and status(step=i, steps=n, eta=round(el / i * (n - i))),
                   stage=lambda m, part=None, parts=None: (print(m, part or "", parts or "", flush=True),
                                                           status(state="finishing", message=m, part=part, parts=parts)))
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
