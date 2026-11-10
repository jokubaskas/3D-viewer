# Atea 3D Matuoklis – tikslesnis 3D tinklas ODM'ui (--mesh-method openmvs).
#
# ODM 3D tinklą kuria Poisson metodu su užkoduotais parametrais (pointWeight 4, samplesPerNode 1, be tankio
# apkarpymo) – briaunos suapvalinamos, aplink mašinas ir pastatus „pakyla“ žemė. Čia tinklas kuriamas OpenMVS:
#   1) ReconstructMesh – Delaunay tetraedrizacija + grafų pjūvis pagal tai, iš kurių nuotraukų kiekvienas taškas
#      matytas (scene_dense.mvs iš ODM openmvs etapo – ten taškai su pilnu matomumu). Ne *_filtered.mvs: OpenMVS
#      nuotraukų kelius saugo santykinius darbo aplanko atžvilgiu, o ODM tankina su -w depthmaps, bet filtruoja
#      be -w – išfiltruotoje scenoje keliai į nuotraukas neteisingi. Triukšmą šalina 3) žingsnis ir tinklo valymas;
#   2) RefineMesh – tinklo tikslinimas pagal pačias nuotraukas (foto-suderinamumas) – aštrios briaunos;
#   3) apkarpymas pagal ODM išfiltruotą taškų debesį (odm_filterpoints: riba / auto-riba ir triukšmo filtras) ir
#      sumažinimas iki --mesh-size (kaip ODM).
# Jei kas nepavyksta (pvz. nėra scenos po atminties taupymo režimo, pritrūko RAM) – grąžinama False ir ODM
# tęsia įprastu Poisson metodu, t. y. apdorojimas dėl šio pakeitimo nenutrūksta.
import math
import os
import shutil

from opendm import context
from opendm import io
from opendm import log
from opendm import system
from opendm.gpu import has_gpu

CELL = 1.0  # m – apkarpymo tinklelis pagal išfiltruotą taškų debesį
DILATE = 2  # langeliai aplink taškus, kurie dar laikomi modelio dalimi


def _bin(name):
    return os.path.join(os.path.dirname(context.omvs_densify_path), name)


def _scene(tree):
    """(scena, darbo aplankas) – tas pats -w, su kuriuo ODM ją sukūrė (DensifyPointCloud -w depthmaps)."""
    scene = os.path.join(tree.openmvs, "scene_dense.mvs")
    work = os.path.join(tree.openmvs, "depthmaps")
    if io.file_exists(scene) and io.dir_exists(work):
        return scene, work
    return None, None


def _refine_level(args, low_mem=False):
    # Tikslinimo raiška pagal taškų debesies kokybę (kaip DensifyPointCloud): aukštesnė kokybė – tikslesnės nuotraukos;
    # mažai RAM – viena pakopa mažesnė
    lvl = {"ultra": 0, "high": 1, "medium": 2, "low": 3, "lowest": 3}.get(getattr(args, "pc_quality", "medium"), 2)
    return min(3, lvl + (1 if low_mem else 0))


# ---------------------------------------------------------------- atmintis
# ReconstructMesh (Delaunay + grafų pjūvis) RAM poreikis ~ įterptų taškų skaičius. Matyta: 38 mln. taškų įterpiant –
# ~11 GB, grafų pjūviui – daugiau. Imama atsargiai 500 B taškui ir naudojama tik dalis laisvos RAM, kad Docker
# (WSL) nepradėtų keisti atminties disku ir „nesustingtų“.
BYTES_PER_POINT = 500
MEM_SHARE = 0.55
BASE_DIST = 2.5  # px – OpenMVS numatytasis --min-point-distance


def _mem_available():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
    except Exception:
        pass
    return None


def _ply_vertices(path):
    try:
        with open(path, "rb") as f:
            head = f.read(4096).decode("latin-1")
        for line in head.split("\n"):
            if line.startswith("element vertex"):
                return int(line.split()[2])
    except Exception:
        pass
    return None


def _min_point_distance(tree):
    """(--min-point-distance, ar mažai RAM): taškai retinami tiek, kad tinklas tilptų į laisvą atmintį."""
    mem = _mem_available()
    n = _ply_vertices(os.path.join(tree.openmvs, "scene_dense_dense_filtered.ply")) or _ply_vertices(tree.filtered_point_cloud)
    if not mem or not n:
        return BASE_DIST, False
    target = mem * MEM_SHARE / BYTES_PER_POINT
    log.ODM_INFO("Atea: tankus debesis %s mln. taškų, laisva RAM %.1f GB (telpa ~%s mln.)" % (round(n / 1e6, 1), mem / 1e9, round(target / 1e6, 1)))
    if n <= target:
        return BASE_DIST, mem < 24e9
    # Įterpiamų taškų skaičius mažėja ~ atstumo kvadratu
    return min(12.0, round(BASE_DIST * math.sqrt(n / target), 1)), True


def _crop(mesh_in, mesh_out, filtered_pc):
    """Pašalina sieneles, kurių XY nepatenka šalia išfiltruotų taškų (ribos apkarpymas ir triukšmo filtras)."""
    import numpy as np
    import trimesh
    from scipy import ndimage

    pc = trimesh.load(filtered_pc, process=False)
    pts = np.asarray(pc.vertices if hasattr(pc, "vertices") else pc)[:, :2]
    if len(pts) == 0:
        raise Exception("tuščias išfiltruotas taškų debesis")
    mesh = trimesh.load(mesh_in, process=False, force="mesh")
    lo = pts.min(axis=0) - CELL * (DILATE + 1)
    shape = (np.ceil((pts.max(axis=0) + CELL * (DILATE + 1) - lo) / CELL).astype(int) + 1)
    grid = np.zeros(shape, dtype=bool)
    ij = ((pts - lo) / CELL).astype(int)
    grid[ij[:, 0], ij[:, 1]] = True
    grid = ndimage.binary_dilation(grid, iterations=DILATE)
    grid = ndimage.binary_fill_holes(grid)  # pastatų stogų / vidiniai tarpai be taškų – nekarpomi
    v = np.asarray(mesh.vertices, dtype=np.float64)[:, :2]
    f = np.asarray(mesh.faces)
    c = (v[f[:, 0]] + v[f[:, 1]] + v[f[:, 2]]) / 3.0  # sienelių centrai (XY)
    cij = np.floor((c - lo) / CELL).astype(int)
    inside = (cij[:, 0] >= 0) & (cij[:, 1] >= 0) & (cij[:, 0] < shape[0]) & (cij[:, 1] < shape[1])
    keep = np.zeros(len(c), dtype=bool)
    keep[inside] = grid[cij[inside, 0], cij[inside, 1]]
    removed = int((~keep).sum())
    mesh.update_faces(keep)
    mesh.remove_unreferenced_vertices()
    if len(mesh.faces) == 0:
        raise Exception("po apkarpymo neliko tinklo")
    mesh.export(mesh_out, encoding="binary")
    log.ODM_INFO("Atea: apkarpyta pagal išfiltruotą taškų debesį – pašalinta %s sienelių, liko %s" % (removed, len(mesh.faces)))


def openmvs_mesh(tree, args, out_mesh, max_vertex, threads):
    """Sukuria out_mesh (PLY). True – pavyko; False – naudoti įprastą Poisson."""
    try:
        scene, wdir = _scene(tree)
        if not scene:
            log.ODM_WARNING("Atea: OpenMVS scenos nėra (galbūt taupytas diskas ar dalinis tankinimas) – naudojamas Poisson")
            return False
        work = os.path.join(tree.odm_meshing, "openmvs")
        if io.dir_exists(work):
            shutil.rmtree(work)
        system.mkdir_p(work)
        threads = max(1, int(threads))
        # --cuda-device yra tik GPU (CUDA) OpenMVS versijoje – be GPU jo perduoti negalima („unrecognised option“)
        gpu = has_gpu(args)
        dev_gpu, dev_cpu = ("--cuda-device -1", "--cuda-device -2") if gpu else ("", "")

        # 1) Tinklas iš taškų su matomumu (taškai retinami pagal laisvą RAM; tinklas iš karto sumažinamas, kad
        #    tikslinimui reikėtų mažiau atminties)
        dist, low_mem = _min_point_distance(tree)
        faces = max(int(max_vertex) * 4, 1000000)
        # Laisvos erdvės palaikymas: paviršiai, kuriuose mažai taškų (stiklas, atspindžiai, vienspalvės sienos),
        # atkuriami pagal tai, kur matymo spinduliai praeina laisvai – mažiau skylių ir „ištirpusių“ fasadų.
        # Reikia daugiau RAM, todėl tik kai jos pakanka (ne low_mem).
        fss = 0 if low_mem else 1
        log.ODM_INFO("Atea: OpenMVS tinklas (ReconstructMesh) iš %s, min. atstumas tarp taškų %s px%s%s"
                     % (os.path.basename(scene), dist, " (sumažinta dėl RAM)" if dist > BASE_DIST else "",
                        ", laisvos erdvės palaikymas" if fss else ""))
        recon = os.path.join(work, "mesh.mvs")
        def reconstruct(dev):
            system.run('"%s" -i "%s" -o "%s" -w "%s" --archive-type 3 --export-type ply --max-threads %s %s '
                       '--min-point-distance %s --free-space-support %s --target-face-num %s --remove-spurious 20 --close-holes 100 --smooth 1 -v 0'
                       % (_bin("ReconstructMesh"), scene, recon, wdir, threads, dev, dist, fss, faces))
        try:
            reconstruct(dev_gpu)
        except system.SubprocessException:
            if not gpu:
                raise
            log.ODM_WARNING("Atea: ReconstructMesh su GPU nepavyko – kartojama procesoriumi")
            try:
                reconstruct(dev_cpu)
            except system.SubprocessException:
                reconstruct("")
        mesh_ply = os.path.join(work, "mesh.ply")
        if not io.file_exists(mesh_ply):
            raise Exception("ReconstructMesh nesukūrė tinklo")

        # 2) Tikslinimas pagal nuotraukas (nepavykus – naudojamas netikslintas tinklas)
        best = mesh_ply
        refined = os.path.join(work, "mesh_refine.mvs")
        log.ODM_INFO("Atea: tinklo tikslinimas pagal nuotraukas (RefineMesh)")
        def refine(dev):
            system.run('"%s" -i "%s" -m "%s" -o "%s" -w "%s" --archive-type 3 --export-type ply --max-threads %s %s '
                       '--resolution-level %s --min-resolution 640 --max-views %s --max-face-area %s --scales 2 --regularity-weight 0.35 -v 0'
                       % (_bin("RefineMesh"), recon, mesh_ply, refined, wdir, threads, dev, _refine_level(args, low_mem),
                          6 if low_mem else 8, 32 if low_mem else 16))
        try:
            try:
                refine(dev_gpu)
            except system.SubprocessException:
                if not gpu:
                    raise
                log.ODM_WARNING("Atea: RefineMesh su GPU nepavyko – kartojama procesoriumi")
                try:
                    refine(dev_cpu)
                except system.SubprocessException:
                    refine("")
            if io.file_exists(os.path.join(work, "mesh_refine.ply")):
                best = os.path.join(work, "mesh_refine.ply")
        except Exception as e:
            log.ODM_WARNING("Atea: tikslinimas nepavyko (%s) – naudojamas netikslintas OpenMVS tinklas" % str(e))

        # 3) Apkarpymas pagal ODM išfiltruotus taškus ir sumažinimas iki --mesh-size (kaip ODM Poisson atveju)
        cropped = os.path.join(work, "mesh_cropped.ply")
        if io.file_exists(tree.filtered_point_cloud):
            _crop(best, cropped, tree.filtered_point_cloud)
        else:
            shutil.copy(best, cropped)
        system.run('"%s" -i "%s" -o "%s" --archive-type 3 --remove-spikes 0 --remove-spurious 20 --smooth 0 '
                   '--target-face-num %s -v 0' % (_bin("ReconstructMesh"), cropped, out_mesh, int(max_vertex) * 2))
        if not io.file_exists(out_mesh):
            raise Exception("galutinis tinklas nesukurtas")
        if not getattr(args, "optimize_disk_space", False):
            for f in ("mesh.mvs", "mesh_refine.mvs"):
                p = os.path.join(work, f)
                if os.path.exists(p):
                    os.remove(p)
        log.ODM_INFO("Atea: OpenMVS tinklas paruoštas: %s" % out_mesh)
        return True
    except Exception as e:
        log.ODM_WARNING("Atea: OpenMVS tinklas nepavyko (%s) – naudojamas Poisson" % str(e))
        if os.path.exists(out_mesh):
            os.remove(out_mesh)
        return False


# ---------------------------------------------------------------- fasadų lyginimas
# Stiklas ir atspindžiai fotogrametrijai „nematomi“: fasadas tinkle išeina banguotas, su įdubomis. Didelės vertikalios
# plokštumos (fasadai) ir prie jų viršaus esančios horizontalios (plokšti stogai) randamos RANSAC metodu, o viršūnės,
# esančios arti plokštumos ir jos ribose, priglaudžiamos prie jos. Viršūnės prie dviejų plokštumų sankirtos (pastato
# kampai, stogo kraštas) perkeliamos tiesiai ant sankirtos linijos – briaunos aštrios, ne suapvalintos.
# Gilesni nei TOL išsikišimai ar įdubos (balkonai, nišos, stogo įranga, objektai prie sienos) nekeičiami.
FIT = 0.15        # m – plokštumos taškų paklaida ją ieškant
TOL = 0.6         # m – kiek toli nuo fasado viršūnė dar priglaudžiama
TOL_H = 0.3       # m – tas pats stogui (mažiau – stogo įranga, parapetai lieka)
MIN_AREA = 30.0   # m² – mažiausias plokštumos plotas (mažesnės – medžiai, mašinos, triukšmas – neliečiamos)
VERT = 0.2        # |n.z| < VERT – plokštuma laikoma vertikalia
MIN_HEIGHT = 3.5  # m – fasadas bent tokio aukščio (automobilių eilė, tvora, krūmai iš šono – žemesni, neliečiami)
HORIZ = 0.97      # |n.z| > HORIZ – horizontali
ROOF_GAP = 2.0    # m – stogas turi būti ne toliau kaip tiek nuo kurio nors fasado viršaus
ROOF_MIN_H = 8.0  # m – ir bent tiek aukščiau to fasado apačios (2–3 aukštai): terasos, aikštelės prie atraminių sienų,
                  #     vieno aukšto stogai neliečiami
ROOF_MAX_AREA = 3000.0  # m² – didesnė „stogo“ plokštuma – greičiausiai aikštelė ar reljefas, ne stogas
ROOF_NEAR = 3.0   # m – ir dalis stogo ne toliau kaip tiek nuo to fasado (ne tik panašus aukštis kitoje aikštelės vietoje)
CORNER_COS = 0.87 # kampas tarp plokštumų > ~30° – sankirta laikoma briauna
MAX_PLANES = 40
ITERS = 150
BIN = 1.0         # m – plokštumos ribų nustatymo tinklelis
EDGE = 0.3        # m – plokštumos ribos praplatinamos tiek (kad briaunos viršūnės patektų į abi)


def _run_extent(vals, step=BIN):
    """Didžiausios ištisinės srities ribos (be pavienių toli nutolusių taškų, pvz. žemės linijos išilgai plokštumos)."""
    import numpy as np
    lo = vals.min()
    idx = np.floor((vals - lo) / step).astype(int)
    occ = np.bincount(idx) > 0
    best, start, cur = (0, 0), None, 0
    for i, o in enumerate(occ):
        if o:
            if start is None:
                start = i
            if i - start + 1 > best[1] - best[0]:
                best = (start, i + 1)
        else:
            start = None
    return lo + best[0] * step, lo + best[1] * step


def _find_planes(S, SN, per, cand_mask, ok_normal, rng, tree, remaining, max_planes, band):
    """RANSAC: plokštumos, pritaikytos prie atsitiktinio kandidato 3 m aplinkos. Grąžina [(c, n, inlier_points)]."""
    import numpy as np
    out = []
    ns = len(S)
    for _ in range(max_planes):
        idx = np.flatnonzero(remaining)
        cand = np.flatnonzero(remaining & cand_mask)
        if len(cand) * per < MIN_AREA or len(idx) < 50:
            break
        P = S[idx]
        PN = SN[idx]
        best, best_cnt = None, 0
        for _ in range(ITERS):
            a0 = S[cand[rng.integers(len(cand))]]
            nb = [k for k in tree.query_ball_point(a0, 3.0) if remaining[k] and cand_mask[k]]
            if len(nb) < 8:
                continue
            Q = S[nb]
            a = Q.mean(axis=0)
            n = np.linalg.svd(Q - a, full_matrices=False)[2][2]
            if not ok_normal(n):
                continue
            cnt = int(((np.abs((P - a) @ n) < FIT) & (np.abs(PN @ n) > 0.75)).sum())
            if cnt > best_cnt:
                best, best_cnt = (a, n), cnt
        if best is None or best_cnt * per < MIN_AREA:
            break
        a, n = best
        inl = (np.abs((P - a) @ n) < FIT) & (np.abs(PN @ n) > 0.75)
        Q = P[inl]
        c = Q.mean(axis=0)
        n = np.linalg.svd(Q - c, full_matrices=False)[2][2]
        # Pašalinama visa plokštumos juosta (±band), ne tik tikslūs taškai – kitaip banguotas fasadas suskyla į kelias
        # lygiagrečias „plokštumas“, kurios traukia viršūnes kiekviena į save
        remaining[idx[(np.abs((P - c) @ n) < band) & (np.abs(PN @ n) > 0.5)]] = False
        if not ok_normal(n):
            continue
        inl = (np.abs((P - c) @ n) < FIT) & (np.abs(PN @ n) > 0.75)
        if inl.sum() * per < MIN_AREA:
            continue
        out.append((c, n, P[inl]))
    return out


def _flatten(mesh):
    """Fasadų ir stogų lyginimas. Grąžina (naujos viršūnės, pataisytų viršūnių skaičius, plokštumų skaičius)."""
    import numpy as np
    import trimesh

    V = np.asarray(mesh.vertices, dtype=np.float64).copy()
    if len(V) < 2000:
        return V, 0, 0
    rng = np.random.default_rng(0)
    # Taškai tolygiai pagal plotą (ne pagal viršūnes – jų tankis tinkle netolygus) su paviršiaus normalėmis
    ns = 150000
    S, fi = trimesh.sample.sample_surface(mesh, ns, seed=0)
    SN = np.asarray(mesh.face_normals)[fi]
    per = float(mesh.area) / ns  # m² vienam imties taškui

    from scipy.spatial import cKDTree
    tree = cKDTree(S)
    remaining = np.ones(ns, dtype=bool)
    Z = np.array([0.0, 0.0, 1.0])

    # Plokštuma: (centras, normalė, ašis1, ašis2, ribos ašyje1, ribos ašyje2, tolerancija)
    planes = []
    for c, n, Q in _find_planes(S, SN, per, np.abs(SN[:, 2]) < VERT, lambda n: abs(n[2]) < VERT, rng, tree, remaining, MAX_PLANES, TOL):
        u = np.cross(Z, n)
        u /= np.linalg.norm(u)
        u0, u1 = _run_extent((Q - c) @ u)
        z0, z1 = _run_extent(Q[:, 2] - c[2])
        if (u1 - u0) * (z1 - z0) < MIN_AREA or z1 - z0 < MIN_HEIGHT:
            continue
        planes.append((c, n, u, Z, u0 - EDGE, u1 + EDGE, z0 - EDGE, z1 + EDGE, TOL))
    nfac = len(planes)

    # Plokšti stogai – tik prie rastų fasadų viršaus (žemė, aikštelės, šaligatviai, automobiliai neliečiami): fasado
    # viršus panašiame aukštyje IR bent ~1 m² stogo šalia to fasado (nelygioje aikštelėje kito fasado viršus kitur
    # gali būti automobilių stogų aukštyje)
    roofs_info = []
    if planes:
        facades = [(p[0], p[1], p[2], p[4], p[5], p[0][2] + p[7] - EDGE, p[0][2] + p[6] + EDGE) for p in planes]
        X, Y = np.array([1.0, 0.0, 0.0]), np.array([0.0, 1.0, 0.0])
        for c, n, Q in _find_planes(S, SN, per, np.abs(SN[:, 2]) > 0.85, lambda n: abs(n[2]) > HORIZ, rng, tree, remaining, 10, TOL_H):
            h = c[2]
            ends, bot_min = [], None
            for fc, fn, fu, u0, u1, top, bot in facades:
                if abs(top - h) >= ROOF_GAP or h - bot <= ROOF_MIN_H:
                    continue
                t = (Q - fc) @ fu
                near = (np.abs((Q - fc) @ fn) < ROOF_NEAR) & (t > u0) & (t < u1)
                if near.sum() * per >= 1.0:
                    ends += [(fc + fu * u0)[:2], (fc + fu * u1)[:2]]
                    bot_min = bot if bot_min is None else min(bot_min, bot)
            if not ends:
                continue
            # Lyginama tik pastato pagrindo ribose (stačiakampis per jį laikančių fasadų galus): žemė šlaito
            # pusėje stogo lygyje ar automobiliai už pastato nepaliečiami. Vienas fasadas – tik ROOF_NEAR juosta.
            E = np.array(ends)
            pad = EDGE if len(ends) > 2 else ROOF_NEAR
            lo, hi = E.min(axis=0) - pad, E.max(axis=0) + pad
            n = n if n[2] > 0 else -n
            x0, x1 = _run_extent((Q - c) @ X)
            y0, y1 = _run_extent((Q - c) @ Y)
            x0, x1 = max(x0 - EDGE, lo[0] - c[0]), min(x1 + EDGE, hi[0] - c[0])
            y0, y1 = max(y0 - EDGE, lo[1] - c[1]), min(y1 + EDGE, hi[1] - c[1])
            if x1 <= x0 or y1 <= y0 or (x1 - x0) * (y1 - y0) > ROOF_MAX_AREA:
                continue
            planes.append((c, n, X, Y, x0, x1, y0, y1, TOL_H))
            roofs_info.append("%.1f m (%.0f m²)" % (h - bot_min, (x1 - x0) * (y1 - y0)))
    nroof = len(planes) - nfac

    if not planes:
        log.ODM_INFO("Atea: fasadų plokštumų nerasta")
        return V, 0, 0

    # Kiekvienai viršūnei – atstumas iki kiekvienos plokštumos, kurios ribose ir tolerancijoje ji yra.
    # Traukiamos tik į plokštumą atsuktos viršūnės (normalė ~ plokštumos normalė): žemė prie sienos, palangės,
    # mašinų stogai lieka nepaliesti (jų normalė statmena plokštumos normalei).
    VN = np.asarray(mesh.vertex_normals, dtype=np.float64)
    nv = len(V)
    D = np.full((len(planes), nv), np.nan)
    for i, (c, n, a1, a2, r0, r1, s0, s1, tol) in enumerate(planes):
        d = (V - c) @ n
        t1 = (V - c) @ a1
        t2 = (V - c) @ a2
        m = (np.abs(d) < tol) & (np.abs(VN @ n) > 0.3) & (t1 > r0) & (t1 < r1) & (t2 > s0) & (t2 < s1)
        D[i, m] = d[m]
    hit = ~np.isnan(D)
    cnt = hit.sum(axis=0)
    Nm = np.array([p[1] for p in planes])
    moved_v = np.zeros(nv, dtype=bool)
    shift = np.zeros_like(V)

    # Viena plokštuma – priglaudžiama (griežtesnė normalės sąlyga)
    one = np.flatnonzero(cnt == 1)
    if len(one):
        k = np.argmax(hit[:, one], axis=0)
        d = D[k, one]
        ok = np.abs(np.einsum("ij,ij->i", VN[one], Nm[k])) > 0.3
        shift[one[ok]] = -d[ok, None] * Nm[k[ok]]
        moved_v[one[ok]] = True

    # Dvi ar daugiau – briauna: perkeliama ant dviejų artimiausių nelygiagrečių plokštumų sankirtos
    corners = 0
    for v in np.flatnonzero(cnt >= 2):
        ks = np.flatnonzero(hit[:, v])
        ks = ks[np.argsort(np.abs(D[ks, v]))]
        a = ks[0]
        b = next((k for k in ks[1:] if abs(Nm[a] @ Nm[k]) < CORNER_COS), None)
        if b is None:
            shift[v] = -D[a, v] * Nm[a]
        else:
            N2 = Nm[[a, b]]
            r = D[[a, b], v]
            shift[v] = -N2.T @ np.linalg.solve(N2 @ N2.T, r)
            corners += 1
        moved_v[v] = True

    V += shift
    moved = int((np.linalg.norm(shift, axis=1) > 0.02).sum())
    log.ODM_INFO("Atea: rasta fasadų %s, stogų %s; traukiama %s viršūnių, briaunose %s (pataisyta > 2 cm: %s)"
                 % (nfac, nroof, int(moved_v.sum()), corners, moved))
    if roofs_info:
        log.ODM_INFO("Atea: stogai (aukštis virš fasado apačios, plotas): %s" % ", ".join(roofs_info))

    return V, moved, len(planes)


def _save(mesh_path, V, F):
    """Įrašoma per OpenMVS lygiai taip, kaip ODM valo savo tinklą (opendm/mesh.py) – tas pats PLY formatas, kurį
    toliau skaito tekstūravimas. Nepavykus – trimesh įrašytas dvejetainis PLY (jį skaito ir OpenMVS, ir texrecon)."""
    import trimesh
    work = os.path.join(os.path.dirname(mesh_path), "atea_flat")
    system.mkdir_p(work)
    tmp = os.path.join(work, "flat_in.ply")
    trimesh.Trimesh(V, F, process=False).export(tmp, encoding="binary")
    out = os.path.join(work, "flat_out.ply")
    try:
        system.run('"%s" -i "%s" -o "%s" --archive-type 3 --remove-spikes 0 --remove-spurious 0 --smooth 0 '
                   '--target-face-num %s -v 0' % (_bin("ReconstructMesh"), tmp, out, len(F)))
    except Exception as e:
        log.ODM_WARNING("Atea: OpenMVS įrašymas nepavyko (%s) – įrašoma tiesiogiai" % str(e))
    if not io.file_exists(out):
        out = tmp
    shutil.move(out, mesh_path)
    shutil.rmtree(work, ignore_errors=True)


def flatten_facades(mesh_path, args=None):
    """Tik fasadų lyginimas (testams); ODM kviečia improve_mesh."""
    import numpy as np
    import trimesh
    if not io.file_exists(mesh_path):
        return 0
    mesh = trimesh.load(mesh_path, process=False, force="mesh")
    V, moved, n = _flatten(mesh)
    if moved:
        _save(mesh_path, V, np.asarray(mesh.faces))
        log.ODM_INFO("Atea: fasadai išlyginti – %s plokštumų, pataisyta %s viršūnių" % (n, moved))
    return moved


# ---------------------------------------------------------------- tinklo valymas
# Plaukiojantys gabalai: nuo pagrindinio tinklo atskiros dalys – medžių lajų „debesys“ be kamieno, atplaišos prie
# stiklo, pavieniai trikampiai. Šalinamos labai mažos (< SPECK m²) ir tos, kurios kabo ore (žemiausias taškas
# daugiau nei FLOAT_GAP virš pagrindinio tinklo po jomis). Didelės atskiros dalys (> FLOAT_MAX m² arba > 5 % ploto)
# ir ant žemės stovinčios (pvz. atskiras automobilis) paliekamos.
SPECK = 2.0        # m²
FLOAT_MAX = 200.0  # m²
FLOAT_GAP = 1.0    # m
# Mažos skylės (stogo kraštas, palangės): uždaroma, jei kontūro perimetras < HOLE_PERIM m. Didelės (po pastatu,
# neapfotografuotos vietos, modelio kraštas) paliekamos – ten nėra duomenų. Užpildoma prieš tekstūravimą, todėl
# užpildyta vieta gauna tikrą tekstūrą iš nuotraukų.
HOLE_PERIM = 12.0  # m
HOLE_EDGES = 300


def _vertex_components(F, nv):
    import numpy as np
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    g = coo_matrix((np.ones(len(e), dtype=np.int8), (e[:, 0], e[:, 1])), shape=(nv, nv))
    return connected_components(g, directed=False)[1]


def _remove_floating(V, F, face_area):
    """Grąžina (F be plaukiojančių dalių, pašalintų dalių skaičius, pašalintas plotas m²)."""
    import numpy as np
    from scipy.spatial import cKDTree
    lab = _vertex_components(F, len(V))
    flab = lab[F[:, 0]]
    area = np.bincount(flab, weights=face_area, minlength=lab.max() + 1)
    main = int(np.argmax(area))
    big = max(min(FLOAT_MAX, 0.05 * area.sum()), SPECK)
    mv = np.flatnonzero(lab == main)
    tree = cKDTree(V[mv, :2])
    drop = np.zeros(len(area), dtype=bool)
    for c in np.flatnonzero((area > 0) & (area < big)):
        if c == main:
            continue
        if area[c] < SPECK:
            drop[c] = True
            continue
        cv = np.flatnonzero(lab == c)
        P = V[cv]
        lo, hi = P[:, :2].min(axis=0), P[:, :2].max(axis=0)
        r = float(np.linalg.norm(hi - lo)) / 2 + 3.0
        near = tree.query_ball_point((lo + hi) / 2, r)
        if not near:
            continue  # po juo nieko nėra – nežinoma, paliekama
        ground = V[mv[near], 2].min()
        if P[:, 2].min() > ground + FLOAT_GAP:
            drop[c] = True
    keep = ~drop[flab]
    return F[keep], int(drop.sum()), float(area[drop].sum())


def _fill_holes(V, F):
    """Uždaro mažas skyles (vėduoklė iš kontūro centro). Grąžina (V, F, užpildytų skylių skaičius)."""
    import numpy as np
    from collections import Counter
    lab = _vertex_components(F, len(V))
    flab = lab[F[:, 0]]
    main = np.bincount(flab).argmax()
    E = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    key = np.sort(E, axis=1)
    _, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    bd = E[cnt[inv.ravel()] == 1]  # kraštinės, priklausančios vienai sienelei (kryptis kaip sienelėje)
    outdeg = Counter(bd[:, 0].tolist())
    nxt = {int(a): int(b) for a, b in bd if outdeg[int(a)] == 1}
    seen = set()
    newV, newF, filled = [], [], 0
    nv = len(V)
    for start in list(nxt):
        if start in seen:
            continue
        loop, v = [], start
        while v in nxt and v not in seen:
            seen.add(v)
            loop.append(v)
            v = nxt[v]
        if v != start or len(loop) < 3 or len(loop) > HOLE_EDGES or lab[start] != main:
            continue
        P = V[loop]
        per = float(np.linalg.norm(P - np.roll(P, -1, axis=0), axis=1).sum())
        if per > HOLE_PERIM:
            continue
        c = nv + len(newV)
        newV.append(P.mean(axis=0))
        for k in range(len(loop)):
            a, b = loop[k], loop[(k + 1) % len(loop)]
            newF.append((b, a, c))  # priešinga kryptis nei krašto sienelėje – ta pati orientacija
        filled += 1
    if filled:
        V = np.vstack([V, np.array(newV)])
        F = np.vstack([F, np.array(newF, dtype=F.dtype)])
    return V, F, filled


def improve_mesh(mesh_path, args=None):
    """ODM 3D tinklo etapo pabaigoje: plaukiojančių gabalų šalinimas, fasadų lyginimas, mažų skylių užpildymas.
    Kiekvienas žingsnis atskirai – jei vienas nepavyksta, kiti vis tiek atliekami."""
    import numpy as np
    import trimesh
    if not io.file_exists(mesh_path):
        return
    # Originalas palyginimui (programoje galima atidaryti abu PLY ir palyginti)
    if not getattr(args, "optimize_disk_space", False):
        try:
            shutil.copy(mesh_path, os.path.join(os.path.dirname(mesh_path), "odm_mesh_be_valymo.ply"))
        except OSError:
            pass
    mesh = trimesh.load(mesh_path, process=False, force="mesh")
    V = np.asarray(mesh.vertices, dtype=np.float64)
    F = np.asarray(mesh.faces)
    changed = False
    try:
        F2, n, a = _remove_floating(V, F, np.asarray(mesh.area_faces))
        log.ODM_INFO("Atea: pašalinta plaukiojančių gabalų %s (%.1f m²)" % (n, a))
        if n:
            F, changed = F2, True
            mesh = trimesh.Trimesh(V, F, process=False)
            mesh.remove_unreferenced_vertices()
            V, F = np.asarray(mesh.vertices, dtype=np.float64), np.asarray(mesh.faces)
    except Exception as e:
        log.ODM_WARNING("Atea: plaukiojančių gabalų šalinimas praleistas (%s)" % str(e))
    try:
        V2, moved, n = _flatten(mesh)
        if moved:
            V, changed = V2, True
            log.ODM_INFO("Atea: fasadai išlyginti – %s plokštumų, pataisyta %s viršūnių" % (n, moved))
    except Exception as e:
        log.ODM_WARNING("Atea: fasadų lyginimas praleistas (%s)" % str(e))
    try:
        V2, F2, n = _fill_holes(V, F)
        log.ODM_INFO("Atea: užpildyta mažų skylių %s" % n)
        if n:
            V, F, changed = V2, F2, True
    except Exception as e:
        log.ODM_WARNING("Atea: skylių užpildymas praleistas (%s)" % str(e))
    if changed:
        _save(mesh_path, V, F)
