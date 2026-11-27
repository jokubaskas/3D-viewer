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
# ~11 GB, grafų pjūviui – daugiau. Imama atsargiai 500 B taškui ir naudojama tik dalis RAM, kad Docker (WSL)
# nepradėtų keisti atminties disku ir „nesustingtų“.
# Retinimas skaičiuojamas pagal VISĄ kompiuterio RAM, ne pagal tuo metu laisvą: laisva RAM kiekvieną kartą kita
# (50,4 / 49,3 GB…), todėl ir retinimas (3,3 / 3,5 px), ir tinklas tame pačiame projekte išeidavo vis kitoks.
# Atstumas suapvalinamas aukštyn iki DIST_STEP – nedideli tankaus debesies skirtumai jo nekeičia.
BYTES_PER_POINT = 500
BYTES_PER_POINT_FSS = 700  # su laisvos erdvės palaikymu (papildomi svoriai kiekvienam tetraedrui)
FSS_MIN_MEM = 24e9         # mažiau RAM tinklui – be laisvos erdvės palaikymo
MEM_SHARE = 0.5   # visos RAM dalis tinklui
BASE_DIST = 2.5   # px – OpenMVS numatytasis --min-point-distance
DIST_STEP = 0.25  # px


def _meminfo(key):
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith(key + ":"):
                    return int(line.split()[1]) * 1024
    except Exception:
        pass
    return None


def _mem_total():
    return _meminfo("MemTotal")


def _mem_available():
    return _meminfo("MemAvailable")


def _ply_count(path, element):
    try:
        with open(path, "rb") as f:
            head = f.read(4096).decode("latin-1")
        for line in head.split("\n"):
            if line.startswith("element %s " % element):
                return int(line.split()[2])
    except Exception:
        pass
    return None


def _ply_vertices(path):
    return _ply_count(path, "vertex")


PLY_TYPES = {"char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1", "short": "i2", "int16": "i2", "ushort": "u2",
             "uint16": "u2", "int": "i4", "int32": "i4", "uint": "u4", "uint32": "u4", "float": "f4", "float32": "f4",
             "double": "f8", "float64": "f8"}


def _ply_xyz(path, max_points=2000000):
    """Iki max_points tolygiai paimtų viršūnių XYZ iš dvejetainio PLY (be viso failo skaitymo į atmintį)."""
    import numpy as np

    with open(path, "rb") as f:
        head = b""
        while not head.endswith(b"end_header\n"):
            line = f.readline()
            if not line:
                return None
            head += line
        offset = f.tell()
    lines = head.decode("latin-1").split("\n")
    fmt = next((l.split()[1] for l in lines if l.startswith("format ")), "")
    if fmt not in ("binary_little_endian", "binary_big_endian"):
        return None
    end = "<" if fmt == "binary_little_endian" else ">"
    props, n, cur = [], 0, None
    for l in lines:
        w = l.split()
        if not w:
            continue
        if w[0] == "element":
            cur = w[1]
            if cur == "vertex":
                n = int(w[2])
            elif not props:
                return None  # vertex – ne pirmas elementas
        elif w[0] == "property" and cur == "vertex":
            if w[1] == "list" or w[1] not in PLY_TYPES:
                return None
            props.append((w[2], end + PLY_TYPES[w[1]]))
    if not n or not all(k in dict(props) for k in "xyz"):
        return None
    dt = np.dtype(props)
    mm = np.memmap(path, dtype=dt, mode="r", offset=offset, shape=(n,))
    step = max(1, n // max_points)
    sub = mm[::step]
    return np.stack([sub["x"], sub["y"], sub["z"]], axis=1).astype(np.float64), n


ROI_MARGIN = 5.0  # m – atsarga aplink apkarpytą taškų debesį (XY ir apačioje)
# Viršuje – daug didesnė atsarga, kad srities „lubos“ būtų aukščiau už visas kameras. Kitaip ReconstructMesh srities
# krašte palieka uždarantį paviršių, kuris uždengia žemę nuo kamerų: tekstūruojant žemė lieka nematyta (spalvotos
# dėmės), o kraštas matosi kaip plona linija.
ROI_TOP_MARGIN = 1000.0
# Išjungta: tinklą kuriant tik iš srities taškų (--integrate-only-roi) virš aikštelės atsirado pasvirę „lakštai“, o žemė
# liko spalvotomis dėmėmis – be apylinkės taškų OpenMVS neteisingai nustato, kur laisva erdvė srities pakraščiuose.
# Tinklas vėl kuriamas iš visų taškų ir apkarpomas pagal ribą XY plokštumoje (_crop), kaip iki šios funkcijos.
MESH_ROI = False


def _roi(tree, work):
    """Dominanti sritis (OpenMVS OBB failas) iš ODM išfiltruoto (pagal ribą apkarpyto) taškų debesies. Įstrižos
    nuotraukos mato iki horizonto – be jos tankiame debesyje didžioji dalis taškų būna už ribos, dėl jų tenka retinti
    visus taškus, o tinklo detalumas atitenka apylinkei, kuri vėliau vis tiek nupjaunama.
    Grąžina (failas, [min xyz], [max xyz]) arba None."""
    import numpy as np

    try:
        r = _ply_xyz(tree.filtered_point_cloud) if io.file_exists(tree.filtered_point_cloud) else None
        if not r:
            return None
        xyz, _ = r
        lo = np.percentile(xyz, 0.05, axis=0) - ROI_MARGIN
        hi = np.percentile(xyz, 99.95, axis=0) + ROI_MARGIN
        hi[2] += ROI_TOP_MARGIN - ROI_MARGIN
        c, e = (lo + hi) / 2, (hi - lo) / 2
        path = os.path.join(work, "roi.txt")
        with open(path, "w") as f:
            f.write("1 0 0\n0 1 0\n0 0 1\n%.4f %.4f %.4f\n%.4f %.4f %.4f\n" % (*c, *e))
        return path, lo, hi
    except Exception as ex:
        log.ODM_WARNING("Atea: dominančios srities nustatyti nepavyko (%s) – naudojami visi taškai" % ex)
        return None


def _count_in_roi(path, lo, hi):
    """Kiek tankaus debesies taškų patenka į sritį (įvertinta iš tolygios imties)."""
    import numpy as np

    r = _ply_xyz(path)
    if not r:
        return None
    xyz, n = r
    inside = np.all((xyz >= lo) & (xyz <= hi), axis=1)
    return int(round(n * float(inside.mean())))


def _min_point_distance(tree, roi=None):
    """(--min-point-distance, ar mažai RAM, laisvos erdvės palaikymas). Laisvos erdvės palaikymas – stiklo fasadams
    būtinas (be jo stiklinis pirmas aukštas ir fasadų dalys dingsta, pastatas „kabo“), todėl jis įjungiamas visada,
    kai RAM pakanka, o taškai retinami tiek, kad su juo tilptų į laisvą atmintį."""
    total, avail = _mem_total(), _mem_available()
    dense = os.path.join(tree.openmvs, "scene_dense_dense_filtered.ply")
    n = _ply_vertices(dense) or _ply_vertices(tree.filtered_point_cloud)
    if not total or not n:
        return BASE_DIST, False, False
    if roi:
        try:
            n_roi = _count_in_roi(dense, roi[1], roi[2]) if io.file_exists(dense) else None
        except Exception:
            n_roi = None
        if n_roi:
            log.ODM_INFO("Atea: dominančioje srityje (%.0f × %.0f m) – %s mln. taškų iš %s mln."
                         % (*(roi[2] - roi[1])[:2], round(n_roi / 1e6, 1), round(n / 1e6, 1)))
            n = n_roi
    budget = total * MEM_SHARE
    fss = budget >= FSS_MIN_MEM * MEM_SHARE / 0.55  # kaip anksčiau: ≥ 24 GB laisvos RAM – dabar ≥ ~44 GB visos
    # Saugiklis: jei tuo metu kiti procesai užėmė tiek, kad biudžetas netelpa į laisvą RAM, – retinama daugiau (rezultatas
    # tada skirsis, todėl pranešama)
    if avail and budget > 0.9 * avail:
        log.ODM_WARNING("Atea: laisvos RAM tik %.1f GB (iš %.1f GB) – kiti procesai užima atmintį, taškai retinami daugiau "
                        "nei įprastai (tinklas gali skirtis nuo ankstesnių paleidimų)" % (avail / 1e9, total / 1e9))
        budget = 0.9 * avail
        fss = fss and avail >= FSS_MIN_MEM
    target = budget / (BYTES_PER_POINT_FSS if fss else BYTES_PER_POINT)
    log.ODM_INFO("Atea: tankus debesis %s mln. taškų, RAM %.1f GB, tinklui %.1f GB (telpa ~%s mln.)"
                 % (round(n / 1e6, 1), total / 1e9, budget / 1e9, round(target / 1e6, 1)))
    if n <= target:
        return BASE_DIST, not fss, fss
    # Įterpiamų taškų skaičius mažėja ~ atstumo kvadratu; suapvalinama aukštyn iki DIST_STEP (pastovus rezultatas)
    d = BASE_DIST * math.sqrt(n / target)
    return min(12.0, math.ceil(d / DIST_STEP - 1e-9) * DIST_STEP), True, fss


# Skylių diagnostika: kuriame etape (ReconstructMesh / RefineMesh / apkarpymas / valymas) atsiranda kiaurymės.
HOLE_REPORT_MIN = 2.0           # m – mažesnio perimetro skylės neskaičiuojamos
HOLE_REPORT_MAX_FACES = 20000000


def _hole_report(V, F, top=6):
    """Grąžina (skylių skaičius, bendras perimetras m, didžiausių aprašymai). Skylė – sujungta krašto kraštinių grupė;
    ilgiausia (modelio išorinis kraštas) neskaičiuojama."""
    import numpy as np
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    F = np.asarray(F, dtype=np.int64)
    n = len(V)
    E = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    E.sort(axis=1)
    key = E[:, 0] * n + E[:, 1]
    del E
    u, cnt = np.unique(key, return_counts=True)
    b = u[cnt == 1]
    del key, u, cnt
    if len(b) == 0:
        return 0, 0.0, []
    a, c = b // n, b % n
    vs, inv = np.unique(np.concatenate([a, c]), return_inverse=True)
    ia, ic = inv[:len(a)], inv[len(a):]
    g = coo_matrix((np.ones(len(a)), (ia, ic)), shape=(len(vs), len(vs)))
    nc, lab = connected_components(g, directed=False)
    elab = lab[ia]
    L = np.linalg.norm(V[a] - V[c], axis=1)
    per = np.bincount(elab, weights=L, minlength=nc)
    order = np.argsort(-per)[1:]  # be išorinio krašto
    order = order[per[order] >= HOLE_REPORT_MIN]
    info = []
    for k in order[:top]:
        P = V[vs[lab == k]]
        lo, hi = P.min(axis=0), P.max(axis=0)
        info.append("perimetras %.1f m, centras (%.1f; %.1f), z %.1f–%.1f, dydis %.1f×%.1f m"
                    % (per[k], (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2], hi[2], hi[0] - lo[0], hi[1] - lo[1]))
    return len(order), float(per[order].sum()), info


def _log_holes(stage, V=None, F=None, path=None):
    """Įrašo į žurnalą skylių suvestinę. Klaida ar per didelis tinklas – tyliai praleidžiama."""
    try:
        if path is not None:
            if _ply_count(path, "face") > HOLE_REPORT_MAX_FACES:
                return
            import numpy as np
            import trimesh
            m = trimesh.load(path, process=False, force="mesh")
            V, F = np.asarray(m.vertices, dtype=np.float64), np.asarray(m.faces)
        n, per, info = _hole_report(V, F)
        log.ODM_INFO("Atea: skylės (%s): %s vnt. ≥ %.0f m perimetro, bendras perimetras %.0f m"
                     % (stage, n, HOLE_REPORT_MIN, per))
        for d in info:
            log.ODM_INFO("Atea:   skylė: %s" % d)
    except Exception as e:
        log.ODM_WARNING("Atea: skylių suvestinė (%s) praleista (%s)" % (stage, str(e)))


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
        roi = _roi(tree, work) if MESH_ROI else None
        dist, low_mem, fss = _min_point_distance(tree, roi)
        # Tinklas nekarpomas pagal srities dėžę (--crop-to-roi 0) – jį vėliau apkarpo _crop pagal ribą XY plokštumoje
        roi_opt = ' --import-roi-file "%s" --integrate-only-roi 1 --crop-to-roi 0' % roi[0] if roi else ""
        faces = max(int(max_vertex) * 4, 1000000)
        # Laisvos erdvės palaikymas: paviršiai, kuriuose mažai taškų (stiklas, atspindžiai, vienspalvės sienos),
        # atkuriami pagal tai, kur matymo spinduliai praeina laisvai – mažiau skylių ir „ištirpusių“ fasadų.
        fss = 1 if fss else 0
        log.ODM_INFO("Atea: OpenMVS tinklas (ReconstructMesh) iš %s, min. atstumas tarp taškų %s px%s%s"
                     % (os.path.basename(scene), dist, " (sumažinta dėl RAM)" if dist > BASE_DIST else "",
                        ", laisvos erdvės palaikymas" if fss else ""))
        recon = os.path.join(work, "mesh.mvs")
        def reconstruct(dev, fss):
            system.run('"%s" -i "%s" -o "%s" -w "%s" --archive-type 3 --export-type ply --max-threads %s %s '
                       '--min-point-distance %s --free-space-support %s --target-face-num %s --remove-spurious 20 --close-holes 100 --smooth 1%s -v 0'
                       % (_bin("ReconstructMesh"), scene, recon, wdir, threads, dev, dist, fss, faces, roi_opt))
        def reconstruct_any(fss):
            try:
                reconstruct(dev_gpu, fss)
            except system.SubprocessException:
                if not gpu:
                    raise
                log.ODM_WARNING("Atea: ReconstructMesh su GPU nepavyko – kartojama procesoriumi")
                try:
                    reconstruct(dev_cpu, fss)
                except system.SubprocessException:
                    reconstruct("", fss)
        try:
            try:
                reconstruct_any(fss)
            except system.SubprocessException:
                if not roi_opt:
                    raise
                log.ODM_WARNING("Atea: ReconstructMesh su dominančia sritimi nepavyko – kartojama su visais taškais")
                roi_opt = ""
                reconstruct_any(fss)
        except system.SubprocessException:
            if not fss:
                raise
            log.ODM_WARNING("Atea: ReconstructMesh su laisvos erdvės palaikymu nepavyko (RAM?) – kartojama be jo")
            reconstruct_any(0)
        mesh_ply = os.path.join(work, "mesh.ply")
        if not io.file_exists(mesh_ply):
            raise Exception("ReconstructMesh nesukūrė tinklo")

        _log_holes("ReconstructMesh", path=mesh_ply)

        # 2) Tikslinimas pagal nuotraukas (nepavykus – naudojamas netikslintas tinklas)
        best = mesh_ply
        refined = os.path.join(work, "mesh_refine.mvs")
        # RefineMesh tinklą sumažina automatiškai (--decimate numatytasis). Bandyta mažinti mažiau (iki 2–4 mln. sienelių) –
        # mašinos detalesnės, bet stiklinis fasadas be tekstūros tikslinant subyra (skylės, išsibarstę logotipai)
        n_rec = _ply_count(mesh_ply, "face")
        log.ODM_INFO("Atea: tinklo tikslinimas pagal nuotraukas (RefineMesh): %s sienelių" % n_rec)
        def refine(dev):
            system.run('"%s" -i "%s" -m "%s" -o "%s" -w "%s" --archive-type 3 --export-type ply --max-threads %s %s '
                       '--resolution-level %s --min-resolution 640 --max-views %s --max-face-area %s '
                       '--scales 2 --regularity-weight 0.35 -v 0'
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
                log.ODM_INFO("Atea: patikslintas tinklas – %s sienelių" % _ply_count(best, "face"))
        except Exception as e:
            log.ODM_WARNING("Atea: tikslinimas nepavyko (%s) – naudojamas netikslintas OpenMVS tinklas" % str(e))

        if best != mesh_ply:
            _log_holes("RefineMesh", path=best)

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
        log.ODM_INFO("Atea: galutinis tinklas – %s sienelių" % _ply_count(out_mesh, "face"))
        _log_holes("apkarpytas ir sumažintas", path=out_mesh)
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
CORNER_SUPPORT = 0.3  # m – briaunos taškas turi būti tiek arti esamo tinklo (ne suapvalinto kampo „ore“)
SMOOTH_K = 24     # aplinkos imties taškai paviršiaus krypčiai įvertinti
SMOOTH_R = 1.5    # m
SMOOTH_COS = 0.85 # aplinkos paviršius pasisukęs daugiau ~32° nuo plokštumos – netraukiama
SMOOTH_FULL = 0.97  # iki ~14° – traukiama visiškai, tarp jų – silpniau
FADE = 0.75       # tolerancijos dalis, nuo kurios traukimas silpnėja iki 0
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
    """Fasadų ir stogų lyginimas. Grąžina (naujos viršūnės, pataisytų viršūnių skaičius, plokštumų skaičius,
    fasadai [(centras, normalė, ašis, u0, u1)])."""
    import numpy as np
    import trimesh

    V = np.asarray(mesh.vertices, dtype=np.float64).copy()
    if len(V) < 2000:
        return V, 0, 0, []
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
        return V, 0, 0, []

    # Kiekvienai viršūnei – atstumas iki kiekvienos plokštumos, kurios ribose ir tolerancijoje ji yra.
    # Traukiamos tik į plokštumą atsuktos viršūnės (normalė ~ plokštumos normalė): žemė prie sienos, palangės,
    # mašinų stogai lieka nepaliesti (jų normalė statmena plokštumos normalei).
    VN = np.asarray(mesh.vertex_normals, dtype=np.float64)
    nv = len(V)
    D = np.full((len(planes), nv), np.nan)
    Al = np.zeros((len(planes), nv))
    for i, (c, n, a1, a2, r0, r1, s0, s1, tol) in enumerate(planes):
        d = (V - c) @ n
        t1 = (V - c) @ a1
        t2 = (V - c) @ a2
        m = (np.abs(d) < tol) & (np.abs(VN @ n) > 0.3) & (t1 > r0) & (t1 < r1) & (t2 > s0) & (t2 < s1)
        # Paviršius aplink viršūnę (~1.5 m) turi būti lygiagretus plokštumai. Suapvalintas pastato kampas ar
        # išlenkta siena čia pasisuka – jos neištiesinamos (kitaip kampe atsiranda laužis / gumbas)
        idx = np.flatnonzero(m)
        if len(idx):
            dist, nb = tree.query(V[idx], k=SMOOTH_K, distance_upper_bound=SMOOTH_R)
            nb = np.where(np.isfinite(dist), nb, 0)
            # tik šios plokštumos pusės paviršius (statmena kaimyninė siena aštriame kampe neskaičiuojama)
            ok = np.isfinite(dist) & (np.abs((S[nb] - c) @ n) < tol) & (np.abs(SN[nb] @ n) > 0.5)
            G = SN[nb] * ok[..., None]
            G *= np.sign(G @ n)[..., None]
            g = G.sum(axis=1)
            g /= np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-12)
            al = np.abs(g @ n)
            Al[i, idx] = al
            m[idx[al < SMOOTH_COS]] = False
        D[i, m] = d[m]
    hit = ~np.isnan(D)
    cnt = hit.sum(axis=0)
    Nm = np.array([p[1] for p in planes])
    Tol = np.array([p[8] for p in planes])
    moved_v = np.zeros(nv, dtype=bool)
    shift = np.zeros_like(V)

    # Viena plokštuma – priglaudžiama (griežtesnė normalės sąlyga)
    one = np.flatnonzero(cnt == 1)
    if len(one):
        k = np.argmax(hit[:, one], axis=0)
        d = D[k, one]
        ok = np.abs(np.einsum("ij,ij->i", VN[one], Nm[k])) > 0.3
        # Tolerancijos pakraštyje traukiama vis silpniau: kitaip greta esančios viršūnės (viena priglausta, kita – ne)
        # atsiduria iki TOL viena nuo kitos, tarp jų – ištemptos sienelės, siena atrodo suplėšyta
        tol = Tol[k]
        w = np.clip((tol - np.abs(d)) / (tol * (1 - FADE)), 0.0, 1.0)
        # ir kuo labiau aplinka pasisukusi nuo plokštumos (kampo apvalinimo pradžia), tuo silpniau – be laužio
        w *= np.clip((Al[k, one] - SMOOTH_COS) / (SMOOTH_FULL - SMOOTH_COS), 0.0, 1.0)
        shift[one[ok]] = -(w * d)[ok, None] * Nm[k[ok]]
        moved_v[one[ok]] = True

    # Dvi ar daugiau – briauna: perkeliama ant dviejų artimiausių nelygiagrečių plokštumų sankirtos
    corners = 0
    vtree = cKDTree(V)
    for v in np.flatnonzero(cnt >= 2):
        ks = np.flatnonzero(hit[:, v])
        ks = ks[np.argsort(np.abs(D[ks, v]))]
        a = ks[0]
        # Dvi lygiagrečios plokštumos (fasado juosta ir įgilintas stiklas) iš abiejų viršūnės pusių – neaišku, kuriai ji
        # priklauso; traukiant į artimesnę kaimynės išsiskirsto į skirtingus gylius ir siena „suplyšta“
        if any(abs(Nm[a] @ Nm[k]) >= CORNER_COS and D[a, v] * D[k, v] < 0 for k in ks[1:]):
            continue
        b = next((k for k in ks[1:] if abs(Nm[a] @ Nm[k]) < CORNER_COS), None)
        if b is None:
            shift[v] = -D[a, v] * Nm[a]
        else:
            N2 = Nm[[a, b]]
            r = D[[a, b], v]
            s2 = -N2.T @ np.linalg.solve(N2 @ N2.T, r)
            # Aštrus kampas tik ten, kur tinklas jį tikrai turi. Suapvalinto kampo (stiklinis pastato kampas)
            # plokštumų sankirta yra ore už sienos – viršūnės ten nustumiamos, ant sienos atsiranda gumbas.
            if vtree.query(V[v] + s2)[0] <= CORNER_SUPPORT:
                shift[v] = s2
                corners += 1
            elif abs(D[a, v]) < CORNER_SUPPORT / 2:
                shift[v] = -D[a, v] * Nm[a]
            else:
                continue
        moved_v[v] = True

    V += shift
    moved = int((np.linalg.norm(shift, axis=1) > 0.02).sum())
    log.ODM_INFO("Atea: rasta fasadų %s, stogų %s; traukiama %s viršūnių, briaunose %s (pataisyta > 2 cm: %s)"
                 % (nfac, nroof, int(moved_v.sum()), corners, moved))
    if roofs_info:
        log.ODM_INFO("Atea: stogai (aukštis virš fasado apačios, plotas): %s" % ", ".join(roofs_info))

    return V, moved, len(planes), [(p[0], p[1], p[2], p[4], p[5]) for p in planes[:nfac]]


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
    V, moved, n, _ = _flatten(mesh)
    if moved:
        _save(mesh_path, V, np.asarray(mesh.faces))
        log.ODM_INFO("Atea: fasadai išlyginti – %s plokštumų, pataisyta %s viršūnių" % (n, moved))
    return moved


# ---------------------------------------------------------------- fasadų pratęsimas žemyn
# Stiklinis pirmas aukštas (vitrinos, atspindžiai) ir stiklo juostos fasade iš statmenų nuotraukų beveik neturi taškų:
# fasado apačioje lieka tarpas – pastatas „kabo“ virš žemės, o pro skyles sienose matosi kiaurai. Rastos fasado
# plokštumos apatinis kraštas (tinklo kraštinės plokštumoje, virš kurių yra siena) nuleidžiamas vertikaliai žemyn iki
# žemės prie fasado arba iki žemiau toje pačioje plokštumoje esančios sienos dalies (skylė sienoje). Naujos sienelės
# tekstūruojamos iš nuotraukų kaip ir visos kitos.
CURTAIN_ON = 0.25    # m – kraštinės viršūnės ne toliau tiek nuo fasado plokštumos
CURTAIN_MIN = 0.4    # m – trumpesni tarpai nepildomi (maži nelygumai)
CURTAIN_MAX = 20.0   # m – ilgiau nenuleidžiama (už modelio krašto / neaiški žemė)
CURTAIN_R = 4.0      # m – žemės paieškos spindulys aplink kraštinę
CURTAIN_STEP = 2.0   # m – naujų sienelių aukštis (ilgi siauri trikampiai blogai tekstūruojami)


def _extend_facades(V, F, facades):
    """Grąžina (V, F, pratęstų kraštinių skaičius, didžiausias nuleidimas m)."""
    import numpy as np
    from scipy.spatial import cKDTree
    V = np.asarray(V, dtype=np.float64)
    F = np.asarray(F)
    nf = len(F)
    E = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    opp = np.concatenate([F[:, 2], F[:, 0], F[:, 1]])  # trečioji sienelės viršūnė
    _, inv, cnt = np.unique(np.sort(E, axis=1), axis=0, return_inverse=True, return_counts=True)
    bmask = cnt[inv.ravel()] == 1
    if not bmask.any():
        return V, F, 0, 0.0
    BE, BO = E[bmask], opp[bmask]

    # Žemė: į viršų atsuktos viršūnės (vertex normalės iš sienelių)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    vn = np.zeros_like(V)
    for k in range(3):
        np.add.at(vn, F[:, k], fn)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
    up = np.flatnonzero(vn[:, 2] > 0.7)
    if len(up) == 0:
        return V, F, 0, 0.0
    up_tree = cKDTree(V[up, :2])

    bottom = {}   # viršūnė → apačios aukštis
    edges = []
    for c, n, u, u0, u1 in facades:
        d = (V - c) @ n
        t = (V - c) @ u
        onp = (np.abs(d) < CURTAIN_ON) & (t > u0) & (t < u1)
        a, b = BE[:, 0], BE[:, 1]
        sel = onp[a] & onp[b]
        # apatinis kraštas: sienelė virš kraštinės, kraštinė ne stati
        sel &= V[BO, 2] > np.maximum(V[a, 2], V[b, 2]) + 0.05
        L = np.linalg.norm(V[b] - V[a], axis=1)
        sel &= np.abs(V[b, 2] - V[a, 2]) < 0.7 * np.maximum(L, 1e-9)
        idx = np.flatnonzero(sel)
        if not len(idx):
            continue
        wall = np.flatnonzero(np.abs(d) < CURTAIN_ON)
        wall_t, wall_z = t[wall], V[wall, 2]
        for i in idx:
            for v in BE[i]:
                v = int(v)
                if v in bottom:
                    continue
                z = V[v, 2]
                # žemė prie fasado: į viršų atsuktos viršūnės ne plokštumoje, žemiau kraštinės
                near = up[up_tree.query_ball_point(V[v, :2], CURTAIN_R)]
                near = near[(np.abs(d[near]) > 0.5) & (V[near, 2] < z - CURTAIN_MIN)]
                if len(near) < 3:
                    bottom[v] = None
                    continue
                zb = float(np.percentile(V[near, 2], 10))
                # žemiau toje pačioje plokštumoje esanti siena (skylė sienoje) – iki jos viršaus
                below = (np.abs(wall_t - t[v]) < 0.5) & (wall_z < z - CURTAIN_MIN) & (wall_z > zb)
                if below.any():
                    zb = float(wall_z[below].max())
                bottom[v] = zb if CURTAIN_MIN <= z - zb <= CURTAIN_MAX else None
        edges += [tuple(int(x) for x in BE[i]) for i in idx]

    edges = [(a, b) for a, b in set(edges) if bottom.get(a) is not None and bottom.get(b) is not None]
    if not edges:
        return V, F, 0, 0.0
    verts = sorted({v for e in edges for v in e})
    h = max(V[v, 2] - bottom[v] for v in verts)
    K = max(1, int(np.ceil(h / CURTAIN_STEP)))
    # kiekvienai viršūnei – K naujų viršūnių vertikaliai žemyn (lygiais intervalais iki jos apačios)
    col = {}
    newV = []
    base = len(V)
    for v in verts:
        z0, z1 = V[v, 2], bottom[v]
        ids = [v]
        for k in range(1, K + 1):
            p = V[v].copy()
            p[2] = z0 + (z1 - z0) * k / K
            ids.append(base + len(newV))
            newV.append(p)
        col[v] = ids
    newF = []
    for a, b in edges:  # sienelėje kraštinė a→b, naujose – b→a (ta pati orientacija)
        A, B = col[a], col[b]
        for k in range(K):
            newF += [(B[k], A[k], A[k + 1]), (B[k], A[k + 1], B[k + 1])]
    V = np.vstack([V, np.array(newV)])
    F = np.vstack([F, np.array(newF, dtype=F.dtype)])
    return V, F, len(edges), float(h)


# ---------------------------------------------------------------- tinklo valymas
# Plaukiojantys gabalai: nuo pagrindinio tinklo atskiros dalys – medžių lajų „debesys“ be kamieno, atplaišos prie
# stiklo, pavieniai trikampiai. Šalinamos labai mažos (< SPECK m²) ir tos, kurios kabo ore (žemiausias taškas
# daugiau nei FLOAT_GAP virš pagrindinio tinklo po jomis). Didelės atskiros dalys (> FLOAT_MAX m² arba > 5 % ploto)
# ir ant žemės stovinčios (pvz. atskiras automobilis) paliekamos.
SPECK = 2.0        # m²
FLOAT_MAX = 200.0  # m²
FLOAT_GAP = 1.0    # m
FLOAT_NEAR = 1.0   # m
FACADE_H = 2.0     # m – vertikalus ir bent tokio aukščio atskiras gabalas laikomas fasado dalimi (nešalinamas)
FACADE_NEAR = 3.0  # m – gabalas tiek arti pagrindinio tinklo fasado laikomas sienos / stogo krašto atplaiša (nešalinamas)
ROOF_MIN = 20.0    # m² – didelė, daugiausia horizontali plokštuma virš žemės laikoma stogu (nešalinama), net jei nuo
ROOF_FLAT = 0.9    # sienų atskirta tarpu (stiklinis fasadas be taškų); |n.z| > ROOF_FLAT daugiau nei pusei ploto
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


def _remove_floating(V, F, face_area, info=None):
    """Grąžina (F be plaukiojančių dalių, pašalintų dalių skaičius, pašalintas plotas m²).
    Į `info` (jei duotas sąrašas) surašomi pašalintų gabalų aprašai žurnalui."""
    import numpy as np
    from scipy.spatial import cKDTree
    lab = _vertex_components(F, len(V))
    flab = lab[F[:, 0]]
    area = np.bincount(flab, weights=face_area, minlength=lab.max() + 1)
    main = int(np.argmax(area))
    big = max(min(FLOAT_MAX, 0.05 * area.sum()), SPECK)
    mv = np.flatnonzero(lab == main)
    tree = cKDTree(V[mv, :2])
    tree3 = cKDTree(V[mv])
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    # Pagrindinio tinklo fasadų (vertikalių sienelių) viršūnės: gabalas šalia jų – sienos / stogo krašto atplaiša
    # (stiklas, atspindžiai), o ne ore kabantis triukšmas. Ją pašalinus siena lieka kiaura.
    mf = (flab == main) & (np.abs(fn[:, 2]) < VERT)
    fv = np.unique(F[mf])
    ftree = cKDTree(V[fv]) if len(fv) else None
    drop = np.zeros(len(area), dtype=bool)
    for c in np.flatnonzero((area > 0) & (area < big)):
        if c == main:
            continue
        if area[c] < SPECK:
            drop[c] = True
            continue
        cv = np.flatnonzero(lab == c)
        P = V[cv]
        # Fasado atplaiša (stiklinė siena atskirta nuo pastato tarpu) – daugiausia vertikali ir aukšta: paliekama
        fm = flab == c
        if (P[:, 2].max() - P[:, 2].min() > FACADE_H
                and face_area[fm][np.abs(fn[fm, 2]) < VERT].sum() > 0.5 * area[c]):
            continue
        # Stogas (ar jo dalis), atskirtas nuo fasadų – didelė plokščia sritis; ore kabantys triukšmo gabalai nėra plokšti
        if area[c] >= ROOF_MIN and face_area[fm][np.abs(fn[fm, 2]) > ROOF_FLAT].sum() > 0.5 * area[c]:
            continue
        lo, hi = P[:, :2].min(axis=0), P[:, :2].max(axis=0)
        r = float(np.linalg.norm(hi - lo)) / 2 + 3.0
        near = tree.query_ball_point((lo + hi) / 2, r)
        if not near:
            continue  # po juo nieko nėra – nežinoma, paliekama
        ground = V[mv[near], 2].min()
        if P[:, 2].min() <= ground + FLOAT_GAP:
            continue
        # Prie pagrindinio tinklo (≤ FLOAT_NEAR) priglusęs gabalas – pastato dalis, atskirta tik skyle (stogo įranga,
        # fasado juosta), ne ore kabantis triukšmas
        S = P[:: max(1, len(P) // 2000)]
        if tree3.query(S, distance_upper_bound=FLOAT_NEAR)[0].min() <= FLOAT_NEAR:
            continue
        if ftree is not None and ftree.query(S, distance_upper_bound=FACADE_NEAR)[0].min() <= FACADE_NEAR:
            continue
        drop[c] = True
        if info is not None:
            vert = face_area[fm][np.abs(fn[fm, 2]) < VERT].sum() / area[c]
            flat = face_area[fm][np.abs(fn[fm, 2]) > ROOF_FLAT].sum() / area[c]
            m = P.mean(axis=0)
            info.append("%.1f m², z %.1f–%.1f (žemė %.1f), vert. %d %%, plokšč. %d %%, centras (%.1f; %.1f)"
                        % (area[c], P[:, 2].min(), P[:, 2].max(), ground, 100 * vert, 100 * flat, m[0], m[1]))
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


# ---------------------------------------------------------------- didelės skylės fasaduose
# Stiklo juostos, kurios statmenose nuotraukose atspindi dangų, kartais neturi nė vieno taško – fasade lieka didelė
# kiaurymė (pvz. 50 × 13 m nuo sienos vidurio iki stogo krašto), pro kurią matosi vidus. Skylė, kurios kontūras
# daugiausia guli ant rastų fasado plokštumų, užtempiama „plėvele“ (harmoninis paviršius, ištemptas ant kontūro), o
# jos viršūnės priglaudžiamos prie artimiausio fasado – per kampą einanti skylė užsipildo abiem sienom su kampu.
# Užpildoma prieš tekstūravimą: nauja siena gauna tikrą tekstūrą iš nuotraukų.
WALL_HOLE_MAX_PERIM = 400.0  # m
WALL_HOLE_MAX_AREA = 3000.0  # m²
WALL_HOLE_MAX_EDGES = 8000
WALL_HOLE_VERT = 0.5         # kontūro „ploto normalė“ |n.z| < tiek – skylė stačia (ne žemėje / stoge)
WALL_HOLE_ON = 1.0           # m – kontūro viršūnė tiek arti fasado plokštumos laikoma esančia ant jo
WALL_HOLE_SHARE = 0.6        # tiek kontūro turi būti ant fasadų
WALL_HOLE_SNAP = 6.0         # m – užpildo viršūnės tiek arti fasado priglaudžiamos prie jo
WALL_HOLE_MAX_PTS = 60000


def _boundary_loops(F):
    """Uždari krašto kontūrai [viršūnių sąrašas] ta kryptimi, kuria kraštinės eina sienelėse."""
    import numpy as np
    from collections import defaultdict
    F = np.asarray(F)
    E = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    _, inv, cnt = np.unique(np.sort(E, axis=1), axis=0, return_inverse=True, return_counts=True)
    bd = E[cnt[inv.ravel()] == 1]
    out = defaultdict(list)
    for a, b in bd.tolist():
        out[a].append(b)
    loops = []
    for start in list(out):
        while out[start]:
            loop, v = [], start
            while out[v]:
                loop.append(v)
                v = out[v].pop()
                if v == start:
                    break
            if v == start and len(loop) >= 3:
                loops.append(loop)
    return loops


def _inside(Q, poly):
    """Ar taškai Q (n×2) daugiakampio poly (m×2) viduje (spindulio metodas, dalimis – ribota atmintis)."""
    import numpy as np
    a, b = poly, np.roll(poly, -1, axis=0)
    out = np.zeros(len(Q), dtype=bool)
    step = max(1, 4000000 // max(1, len(poly)))
    for i in range(0, len(Q), step):
        x, y = Q[i:i + step, :1], Q[i:i + step, 1:]
        cross = (a[:, 1] > y) != (b[:, 1] > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            xi = a[:, 0] + (y - a[:, 1]) * (b[:, 0] - a[:, 0]) / (b[:, 1] - a[:, 1])
        out[i:i + step] = (cross & (x < xi)).sum(axis=1) % 2 == 1
    return out


def _orient(p, a, b, c):
    return (p[b, 0] - p[a, 0]) * (p[c, 1] - p[a, 1]) - (p[b, 1] - p[a, 1]) * (p[c, 0] - p[a, 0])


def _recover_edges(p, T, need, max_flips=200000):
    """Delaunay trikampiavime atkuria privalomas kraštines (kontūrą) kraštinių apvertimu (Sloan). Grąžina T arba None."""
    import numpy as np
    T = np.asarray(T).copy()
    neg = _orient(p, T[:, 0], T[:, 1], T[:, 2]) < 0
    T[neg] = T[neg][:, [0, 2, 1]]
    tris = T.tolist()
    emap = {}
    vt = {}
    for i, (a, b, c) in enumerate(tris):
        emap[(a, b)] = i
        emap[(b, c)] = i
        emap[(c, a)] = i
        for v in (a, b, c):
            vt.setdefault(v, set()).add(i)

    def o(a, b, c):
        return (p[b, 0] - p[a, 0]) * (p[c, 1] - p[a, 1]) - (p[b, 1] - p[a, 1]) * (p[c, 0] - p[a, 0])

    def crosses(a, b, c, d):  # atkarpos ab ir cd kertasi viduje
        return o(a, b, c) * o(a, b, d) < 0 and o(c, d, a) * o(c, d, b) < 0

    def third(i, a, b):
        t = tris[i]
        return next(x for x in t if x != a and x != b)

    flips = 0
    for a, b in need.tolist():
        if (a, b) in emap or (b, a) in emap:
            continue
        # kertančios kraštinės: einama nuo a link b per trikampius
        queue = []
        start = vt.get(a, ())
        cur = None
        for i in start:
            t = tris[i]
            j = t.index(a)
            c, d = t[(j + 1) % 3], t[(j + 2) % 3]
            if crosses(a, b, c, d):
                cur = (c, d)
                break
        if cur is None:
            return None
        guard = 0
        while True:
            queue.append(cur)
            c, d = cur
            i = emap.get((d, c))
            if i is None:
                return None
            x = third(i, d, c)
            if x == b:
                break
            cur = (c, x) if crosses(a, b, c, x) else (x, d)
            guard += 1
            if guard > 100000:
                return None
        while queue:
            c, d = queue.pop(0)
            i, j = emap.get((c, d)), emap.get((d, c))
            if i is None or j is None:
                if (c, d) in emap or (d, c) in emap:
                    continue
                return None
            x, y = third(i, c, d), third(j, d, c)
            # keturkampis c-y-d-x turi būti iškilas
            if not (o(c, y, x) > 0 and o(y, d, x) > 0 and o(c, y, d) > 0 and o(d, x, c) > 0):
                queue.append((c, d))
                flips += 1
                if flips > max_flips:
                    return None
                continue
            for e in ((c, d), (d, x), (x, c), (d, c), (c, y), (y, d)):
                emap.pop(e, None)
            vt[c].discard(j)
            vt[d].discard(i)
            vt[x].add(j)
            vt[y].add(i)
            tris[i] = [c, y, x]
            tris[j] = [y, d, x]
            for t, k in ((tris[i], i), (tris[j], j)):
                emap[(t[0], t[1])] = k
                emap[(t[1], t[2])] = k
                emap[(t[2], t[0])] = k
            flips += 1
            if flips > max_flips:
                return None
            if {x, y} != {a, b} and crosses(a, b, x, y):
                queue.append((x, y))
    return np.array(tris)


def _flood_inside(T, seeds):
    """Trikampiai (prieš laikrodžio rodyklę), pasiekiami nuo kryptinių kraštinių `seeds` kairės pusės nekertant jų."""
    import numpy as np
    emap = {}
    for i, (a, b, c) in enumerate(T.tolist()):
        emap[(a, b)] = i
        emap[(b, c)] = i
        emap[(c, a)] = i
    wall = set(map(tuple, seeds.tolist())) | set(map(tuple, seeds[:, ::-1].tolist()))
    stack = []
    for e in map(tuple, seeds.tolist()):
        if e not in emap:
            return None
        stack.append(emap[e])
    seen = set()
    while stack:
        i = stack.pop()
        if i in seen:
            continue
        seen.add(i)
        a, b, c = T[i]
        for x, y in ((a, b), (b, c), (c, a)):
            if (x, y) in wall:
                continue
            j = emap.get((y, x))
            if j is not None and j not in seen:
                stack.append(j)
    return T[sorted(seen)]


def _planar_patch(V, loop, spacing):
    """Skylė, kurios kontūras projekcijoje į jos plokštumą – paprastas daugiakampis: trikampiuojama plokštumoje
    (tolygūs trikampiai, be persilenkimų). Grąžina (naujos viršūnės, sienelės kaip _membrane) arba None."""
    import numpy as np
    from scipy.spatial import Delaunay, cKDTree
    P = V[loop]
    if len(set(loop)) != len(loop):
        return None
    vec = np.cross(P, np.roll(P, -1, axis=0)).sum(axis=0)
    n = vec / np.linalg.norm(vec)
    e1 = np.cross([0.0, 0.0, 1.0], n)
    if np.linalg.norm(e1) < 1e-6:
        return None
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(n, e1)
    o = P.mean(axis=0)
    Q = np.c_[(P - o) @ e1, (P - o) @ e2]
    off = (P - o) @ n
    nb = len(loop)
    sq = Q[:, 0] * np.roll(Q[:, 1], -1) - np.roll(Q[:, 0], -1) * Q[:, 1]
    A = 0.5 * sq.sum()  # > 0 – kontūras prieš laikrodžio rodyklę
    # Dantytas tinklo kraštas (trikampių „dantys“) Delaunay trikampiavimui trukdo: smailūs iškilūs kontūro kampai
    # nukerpami (ausys), kol naujas kraštas ne ilgesnis kaip 2 tarpai
    ring = list(range(nb))
    ears = []
    tree = cKDTree(Q)
    for _ in range(2):
        i = 0
        while i < len(ring) and len(ring) > 3:
            p_, v_, n_ = ring[i - 1], ring[i], ring[(i + 1) % len(ring)]
            a, b, c = Q[p_], Q[v_], Q[n_]
            cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            u1, u2 = a - b, c - b
            cosang = u1 @ u2 / max(np.linalg.norm(u1) * np.linalg.norm(u2), 1e-12)
            if cr * A > 0 and cosang > -0.5 and np.linalg.norm(c - a) <= 2 * spacing:
                inside = False
                for j in tree.query_ball_point(b, np.linalg.norm(c - a) + 1e-9):
                    if j in (p_, v_, n_):
                        continue
                    x = Q[j]
                    d1 = (b[0] - a[0]) * (x[1] - a[1]) - (b[1] - a[1]) * (x[0] - a[0])
                    d2 = (c[0] - b[0]) * (x[1] - b[1]) - (c[1] - b[1]) * (x[0] - b[0])
                    d3 = (a[0] - c[0]) * (x[1] - c[1]) - (a[1] - c[1]) * (x[0] - c[0])
                    if (d1 * cr >= 0) and (d2 * cr >= 0) and (d3 * cr >= 0):
                        inside = True
                        break
                if not inside:
                    ears.append((p_, v_, n_))
                    ring.pop(i)
                    i += 1
                    continue
            i += 1
    ring = np.array(ring)
    R = Q[ring]
    nr = len(ring)
    lo, hi = R.min(axis=0), R.max(axis=0)
    h = spacing
    if (hi - lo).prod() / (0.87 * h * h) > 4 * WALL_HOLE_MAX_PTS:
        h = np.sqrt((hi - lo).prod() / (0.87 * 4 * WALL_HOLE_MAX_PTS))
    xs = np.arange(lo[0], hi[0] + h, h)
    ys = np.arange(lo[1], hi[1] + h, 0.87 * h)
    X, Y = np.meshgrid(xs, ys)
    X = X + (np.arange(len(ys)) % 2)[:, None] * 0.5 * h
    G = np.c_[X.ravel(), Y.ravel()]
    G = G[_inside(G, R)]
    if len(G):
        # ne arčiau kaip pusė tarpo iki kontūro kraštinių (ne tik viršūnių) – taškas ant kraštinės ją „perkirstų“
        R2 = np.roll(R, -1, axis=0)
        m = np.maximum(1, np.ceil(np.linalg.norm(R2 - R, axis=1) / (0.25 * h)).astype(int))
        tt = np.concatenate([np.arange(k) / k for k in m])
        ii = np.repeat(np.arange(nr), m)
        S = R[ii] + (R2[ii] - R[ii]) * tt[:, None]
        G = G[cKDTree(S).query(G)[0] > 0.5 * h]
    if len(G) > WALL_HOLE_MAX_PTS:
        return None
    # Rėmas aplink: kolinearūs kontūro taškai iškiloje dangoje qhull'o praleidžiami, todėl kontūras turi būti viduje
    span = float((hi - lo).max()) + 10 * h
    frame = np.array([[lo[0] - span, lo[1] - span], [hi[0] + span, lo[1] - span],
                      [hi[0] + span, hi[1] + span], [lo[0] - span, hi[1] + span]])
    pts = np.vstack([R, G, frame])
    T = Delaunay(pts).simplices
    k = np.arange(nr)
    ring_edges = np.c_[k, (k + 1) % nr]
    T = _recover_edges(pts, T, ring_edges)
    if T is None:
        return None
    # Vidiniai trikampiai – užliejimu nuo kontūro vidinės pusės iki kontūro kraštinių (ne pagal centrą – siauri
    # trikampiai prie triukšmingo krašto klaidintų)
    T = _flood_inside(T, ring_edges if A > 0 else ring_edges[:, ::-1])
    if T is None or not (T < nr + len(G)).all():
        return None
    # indeksai: kontūro viršūnės – pozicija loop'e, vidinės – nb + k
    T = np.where(T < nr, ring[np.minimum(T, nr - 1)], T - nr + nb)
    if ears:
        T = np.vstack([T, np.array(ears)])
    pts = np.vstack([Q, G])
    a, b, c = pts[T[:, 0]], pts[T[:, 1]], pts[T[:, 2]]
    sa = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    keep = np.abs(sa) > 1e-12
    T, sa = T[keep], sa[keep]
    # Patikra: visos kontūro kraštinės yra ir trikampių plotas lygus daugiakampio plotui
    if abs(0.5 * np.abs(sa).sum() - abs(A)) > 1e-3 * abs(A) + 1e-6:
        return None
    # ir užpildas – vientisas paviršius: kontūro kraštinės po vieną kartą, visos kitos – lygiai du kartus
    E = np.sort(np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]), axis=1)
    u, cnt = np.unique(E, axis=0, return_counts=True)
    k = np.arange(nb)
    need = np.sort(np.c_[k, (k + 1) % nb], axis=1)
    once = set(map(tuple, u[cnt == 1].tolist()))
    if (cnt > 2).any() or once != set(map(tuple, need.tolist())):
        return None
    # Naujose sienelėse kontūras eina priešinga kryptimi nei esamose
    flip = (sa > 0) == (A > 0)
    T[flip] = T[flip][:, [0, 2, 1]]
    Xn = np.zeros((len(G), 3))
    if len(G):
        d, j = cKDTree(Q).query(G, k=min(8, nb))
        w = 1.0 / np.maximum(d, 1e-6) ** 2
        go = (w * off[j]).sum(axis=1) / w.sum(axis=1)
        Xn = o + G[:, :1] * e1 + G[:, 1:] * e2 + go[:, None] * n
    T = np.where(T < nb, -T - 1, T - nb)
    return Xn, T


def _membrane(V, loop, spacing):
    """Kontūrą užtempiantis paviršius: (naujos viršūnės, sienelės su indeksais: < 0 – loop[-i-1], ≥ 0 – naujos)."""
    import numpy as np
    from scipy.spatial import Delaunay
    from scipy.sparse import coo_matrix
    from scipy.sparse.linalg import spsolve
    P = V[loop]
    seg = np.linalg.norm(np.roll(P, -1, axis=0) - P, axis=1)
    per = seg.sum()
    ang = 2 * np.pi * np.concatenate([[0.0], np.cumsum(seg)[:-1]]) / per
    B = np.c_[np.cos(ang), np.sin(ang)]
    nb = len(loop)
    # Kontūro „ploto“ dydis – vidinių taškų skaičiui (disko tinklelis atvaizduojamas į skylę)
    area = 0.5 * np.linalg.norm(np.cross(P, np.roll(P, -1, axis=0)).sum(axis=0))
    n_in = int(min(WALL_HOLE_MAX_PTS, max(0.0, area / (0.87 * spacing ** 2))))
    I = np.zeros((0, 2))
    if n_in > 0:
        h = np.sqrt(np.pi / (0.87 * n_in))
        xs = np.arange(-1, 1 + h, h)
        ys = np.arange(-1, 1 + h, h * 0.87)
        G = np.array([(x + (0.5 * h if j % 2 else 0.0), y) for j, y in enumerate(ys) for x in xs])
        r = np.linalg.norm(G, axis=1)
        I = G[r < 1 - 0.5 * max(h, 2 * np.pi / nb)]
    pts = np.vstack([B, I])
    T = Delaunay(pts).simplices
    # Orientacija: kontūras diske eina prieš laikrodžio rodyklę, naujose sienelėse – atvirkščiai (pagal laikrodžio)
    a, b, c = pts[T[:, 0]], pts[T[:, 1]], pts[T[:, 2]]
    sa = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    T = T[np.abs(sa) > 1e-14]
    sa = sa[np.abs(sa) > 1e-14]
    T[sa > 0] = T[sa > 0][:, [0, 2, 1]]
    ni = len(I)
    X = np.zeros((ni, 3))
    if ni:
        # Vidinės viršūnės – kaimynų vidurkis (harmoninis paviršius, kraštas fiksuotas)
        e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
        e = np.unique(np.sort(e, axis=1), axis=0)
        e = np.vstack([e, e[:, ::-1]])
        e = e[e[:, 0] >= nb]
        r, c2 = e[:, 0] - nb, e[:, 1]
        deg = np.bincount(r, minlength=ni).astype(float)
        inner = c2 >= nb
        A = coo_matrix((np.r_[deg, -np.ones(inner.sum())], (np.r_[np.arange(ni), r[inner]], np.r_[np.arange(ni), c2[inner] - nb])),
                       shape=(ni, ni)).tocsr()
        rhs = np.zeros((ni, 3))
        np.add.at(rhs, r[~inner], P[c2[~inner]])
        for k in range(3):
            X[:, k] = spsolve(A, rhs[:, k])
    T = np.where(T < nb, -T - 1, T - nb)
    return X, T


def _fill_wall_holes(V, F, facades, info=None):
    """Grąžina (V, F, užpildytų skylių skaičius, užpildytas plotas m²)."""
    import numpy as np
    V = np.asarray(V, dtype=np.float64)
    F = np.asarray(F)
    if not facades or len(F) == 0:
        return V, F, 0, 0.0
    loops = _boundary_loops(F)
    if not loops:
        return V, F, 0, 0.0
    pers = [float(np.linalg.norm(V[l] - V[np.roll(l, -1)], axis=1).sum()) for l in loops]
    outer = int(np.argmax(pers))
    C = np.array([f[0] for f in facades])
    N = np.array([f[1] for f in facades])
    U = np.array([f[2] for f in facades])
    U0 = np.array([f[3] for f in facades])
    U1 = np.array([f[4] for f in facades])

    def facade_dist(Pt, margin):
        """Atstumas iki artimiausio fasado (tik jo ribose) ir to fasado numeris."""
        d = np.einsum("pk,fk->pf", Pt, N) - np.einsum("fk,fk->f", C, N)
        t = np.einsum("pk,fk->pf", Pt, U) - np.einsum("fk,fk->f", C, U)
        ok = (t > U0 - margin) & (t < U1 + margin)
        ad = np.where(ok, np.abs(d), np.inf)
        k = np.argmin(ad, axis=1)
        return ad[np.arange(len(Pt)), k], k, d[np.arange(len(Pt)), k]

    newV, newF, filled, area_sum = [], [], 0, 0.0
    nv = len(V)
    for i, loop in enumerate(loops):
        if i == outer or pers[i] <= HOLE_PERIM or pers[i] > WALL_HOLE_MAX_PERIM or len(loop) > WALL_HOLE_MAX_EDGES:
            continue
        P = V[loop]
        vec = 0.5 * np.cross(P, np.roll(P, -1, axis=0)).sum(axis=0)
        area = float(np.linalg.norm(vec))
        if area <= 0 or area > WALL_HOLE_MAX_AREA or abs(vec[2]) / area >= WALL_HOLE_VERT:
            continue
        seg = np.linalg.norm(np.roll(P, -1, axis=0) - P, axis=1)
        dist, _, _ = facade_dist(P, 2.0)
        share = seg[dist <= WALL_HOLE_ON].sum() / pers[i]
        if share < WALL_HOLE_SHARE:
            continue
        sp = max(float(np.median(seg)), 0.2)
        r = _planar_patch(V, loop, sp)
        X, T = r if r is not None else _membrane(V, loop, sp)
        if len(X):
            dist, k, d = facade_dist(X, 1.0)
            snap = dist <= WALL_HOLE_SNAP
            X[snap] -= d[snap, None] * N[k[snap]]
        base = nv + sum(len(x) for x in newV)
        lv = np.asarray(loop)
        T = np.where(T < 0, lv[np.where(T < 0, -T - 1, 0)], T + base)
        T = T[(T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2])]
        newV.append(X)
        newF.append(T)
        filled += 1
        area_sum += area
        if info is not None:
            lo, hi = P.min(axis=0), P.max(axis=0)
            info.append("perimetras %.0f m, %.0f m², centras (%.1f; %.1f), z %.1f–%.1f, ant fasadų %d %%"
                        % (pers[i], area, (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2], hi[2], 100 * share))
    if filled:
        V = np.vstack([V] + newV)
        F = np.vstack([F] + [t.astype(F.dtype) for t in newF])
    return V, F, filled, area_sum



# Skylės vietoje likę atskiri stiklo atspindžių gabalai (plaukiojančių gabalų valymas juos palieka kaip fasado
# atplaišas) po užpildymo kyšo prieš naują sieną ar už jos – matosi kaip gumbai. Jei gabalas beveik visas yra
# arti užpildo, jis pašalinamas: sieną jau dengia užpildas.
COVER_DIST = 2.5   # m
COVER_SHARE = 0.8


def _drop_covered_fragments(V, F, first_new):
    """F be atskirų gabalų prie užpildytų skylių (viršūnės nuo first_new – užpildas). Grąžina (F, kiekis, plotas m²)."""
    import numpy as np
    from scipy.spatial import cKDTree
    V = np.asarray(V, dtype=np.float64)
    F = np.asarray(F)
    if first_new >= len(V):
        return F, 0, 0.0
    lab = _vertex_components(F, len(V))
    flab = lab[F[:, 0]]
    fa = 0.5 * np.linalg.norm(np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]), axis=1)
    area = np.bincount(flab, weights=fa, minlength=lab.max() + 1)
    main = int(np.bincount(flab, minlength=lab.max() + 1).argmax())
    patch_area = fa[(F >= first_new).any(axis=1)].sum()
    tree = cKDTree(V[first_new:])
    drop = np.zeros(len(area), dtype=bool)
    for c in np.flatnonzero(area > 0):
        if c == main or area[c] > patch_area:
            continue
        P = V[lab == c]
        P = P[:: max(1, len(P) // 2000)]
        d = tree.query(P, distance_upper_bound=COVER_DIST)[0]
        if (d <= COVER_DIST).mean() >= COVER_SHARE:
            drop[c] = True
    keep = ~drop[flab]
    return F[keep], int(drop.sum()), float(area[drop].sum())


def improve_mesh(mesh_path, args=None):
    """ODM 3D tinklo etapo pabaigoje: plaukiojančių gabalų šalinimas, fasadų lyginimas, didelių skylių fasaduose ir
    mažų skylių užpildymas.
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
        info = []
        F2, n, a = _remove_floating(V, F, np.asarray(mesh.area_faces), info)
        log.ODM_INFO("Atea: pašalinta plaukiojančių gabalų %s (%.1f m²)" % (n, a))
        for d in info[:20]:
            log.ODM_INFO("Atea:   pašalinta: %s" % d)
        if n:
            F, changed = F2, True
            mesh = trimesh.Trimesh(V, F, process=False)
            mesh.remove_unreferenced_vertices()
            V, F = np.asarray(mesh.vertices, dtype=np.float64), np.asarray(mesh.faces)
    except Exception as e:
        log.ODM_WARNING("Atea: plaukiojančių gabalų šalinimas praleistas (%s)" % str(e))
    facades = []
    try:
        V2, moved, n, facades = _flatten(mesh)
        if moved:
            V, changed = V2, True
            log.ODM_INFO("Atea: fasadai išlyginti – %s plokštumų, pataisyta %s viršūnių" % (n, moved))
    except Exception as e:
        log.ODM_WARNING("Atea: fasadų lyginimas praleistas (%s)" % str(e))
    if facades:
        try:
            V2, F2, n, h = _extend_facades(V, F, facades)
            log.ODM_INFO("Atea: fasadai pratęsti žemyn iki žemės / žemiau esančios sienos – %s kraštinių (iki %.1f m)" % (n, h))
            if n:
                V, F, changed = V2, F2, True
        except Exception as e:
            log.ODM_WARNING("Atea: fasadų pratęsimas praleistas (%s)" % str(e))
    if facades:
        try:
            info = []
            V2, F2, n, a = _fill_wall_holes(V, F, facades, info)
            log.ODM_INFO("Atea: užpildyta didelių skylių fasaduose %s (%.0f m²)" % (n, a))
            for d in info:
                log.ODM_INFO("Atea:   užpildyta: %s" % d)
            if n:
                nv0 = len(V)
                V, F, changed = V2, F2, True
                F, k, a = _drop_covered_fragments(V, F, nv0)
                if k:
                    mesh = trimesh.Trimesh(V, F, process=False)
                    mesh.remove_unreferenced_vertices()
                    V, F = np.asarray(mesh.vertices, dtype=np.float64), np.asarray(mesh.faces)
                log.ODM_INFO("Atea: pašalinta stiklo atplaišų prieš / už užpildytos sienos %s (%.1f m²)" % (k, a))
        except Exception as e:
            log.ODM_WARNING("Atea: didelių skylių fasaduose užpildymas praleistas (%s)" % str(e))
    try:
        V2, F2, n = _fill_holes(V, F)
        log.ODM_INFO("Atea: užpildyta mažų skylių %s" % n)
        if n:
            V, F, changed = V2, F2, True
    except Exception as e:
        log.ODM_WARNING("Atea: skylių užpildymas praleistas (%s)" % str(e))
    if changed:
        _save(mesh_path, V, F)
        _log_holes("po valymo", V, F)


# ---------------------------------------------------------------------------------------------------------------
# Nematytų sienelių spalva. texrecon (mvs-texturing) sienelės, kurių nė viena nuotrauka nemato kampu iki 75° ir be
# užstojimo, su --keep-unseen-faces gauna vieną bendrą 3×3 px pleistrą – po siūlių lyginimo jos tampa vienodai
# pilkos (medžių šonai, atraminės sienos, stiklinio pirmo aukšto apačia). Be jo – jos išmetamos ir lieka kiaurymės.
# Čia tos sienelės (visos turi identiškas UV koordinates) gauna savo tekstūrą iš tankaus taškų debesies: OpenMVS
# kiekvieno taško spalvą paėmė iš jį tikrai mačiusių nuotraukų (be 75° ribos), todėl medžio šonas tampa žalias,
# siena – sienos spalvos. Kur taškų nėra – artimiausių taškų spalva (sklandus tęsinys, ne pilka dėmė).
UNSEEN_MIN = 20                 # tiek sienelių su identiškomis UV – texrecon „nematytų“ pleistras
UNSEEN_UV_EXT = 2e-3            # pleistro UV dydis (3 px 1024–8192 px atlase)
FILL_RES = 0.03                 # m/px – tekstūros raiška (didinama, jei netelpa)
FILL_MAX_TEXELS = 8192 * 4096
FILL_CELL_MIN, FILL_CELL_MAX = 4, 32
FILL_K = 8                      # kaimyninių taškų skaičius
FILL_R = 2.0                    # m – taškų paieškos spindulys
FILL_MTL = "material_atea_unseen"

_PLY_TYPES = {"char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1", "short": "<i2", "int16": "<i2",
              "ushort": "<u2", "uint16": "<u2", "int": "<i4", "int32": "<i4", "uint": "<u4", "uint32": "<u4",
              "float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8"}


def _read_ply_points(path):
    """Dvejetainis (little endian) PLY taškų debesis → (xyz, rgb uint8, normalės arba None), be viso failo kopijos."""
    import numpy as np
    with open(path, "rb") as f:
        head = b""
        while not head.endswith(b"end_header\n"):
            line = f.readline()
            if not line:
                raise ValueError("netinkama PLY antraštė")
            head += line
    lines = head.decode("latin-1").split("\n")
    if not any(l.startswith("format binary_little_endian") for l in lines):
        raise ValueError("PLY ne binary_little_endian")
    fields, n, in_vertex = [], 0, False
    for l in lines:
        p = l.split()
        if not p:
            continue
        if p[0] == "element":
            if in_vertex:
                break
            in_vertex = p[1] == "vertex"
            n = int(p[2]) if in_vertex else n
        elif p[0] == "property" and in_vertex:
            if p[1] == "list":
                raise ValueError("PLY taškai su sąrašais")
            fields.append((p[2], _PLY_TYPES[p[1]]))
    if not n:
        raise ValueError("PLY be taškų")
    a = np.memmap(path, dtype=np.dtype(fields), mode="r", offset=len(head), shape=(n,))
    names = a.dtype.names
    col = next((c for c in (("red", "green", "blue"), ("diffuse_red", "diffuse_green", "diffuse_blue"))
                if all(x in names for x in c)), None)
    if col is None:
        raise ValueError("PLY be spalvų")
    nrm = ("nx", "ny", "nz") if all(x in names for x in ("nx", "ny", "nz")) else None
    return a, col, nrm


def _point_colors(pc_path, P, FN, faces_P):
    """Kiekvienam taškui P (m×3) – spalva iš tankaus debesies (svoris pagal atstumą ir normalių sutapimą)."""
    import numpy as np
    from scipy.spatial import cKDTree
    a, col, nrm = _read_ply_points(pc_path)
    # Tik taškai šalia nematytų sienelių (debesis – dešimtys milijonų)
    cell = FILL_R
    lo = faces_P.reshape(-1, 3).min(axis=0) - 2 * cell
    keyc = np.unique(np.floor((faces_P.reshape(-1, 3) - lo) / cell).astype(np.int64), axis=0)
    off = np.array([[i, j, k] for i in (-1, 0, 1) for j in (-1, 0, 1) for k in (-1, 0, 1)])
    keyc = np.unique((keyc[:, None, :] + off[None]).reshape(-1, 3), axis=0)
    dims = keyc.max(axis=0) + 2
    want = np.unique((keyc[:, 0] * dims[1] + keyc[:, 1]) * dims[2] + keyc[:, 2])
    sel = []
    step = 5_000_000
    for s in range(0, len(a), step):
        xyz = np.stack([a["x"][s:s + step], a["y"][s:s + step], a["z"][s:s + step]], axis=1).astype(np.float64)
        q = np.floor((xyz - lo) / cell).astype(np.int64)
        ok = np.all((q >= 0) & (q < dims), axis=1)
        k = (q[:, 0] * dims[1] + q[:, 1]) * dims[2] + q[:, 2]
        ok &= np.isin(k, want)
        sel.append(np.nonzero(ok)[0] + s)
    sel = np.concatenate(sel)
    if len(sel) < FILL_K:
        raise ValueError("šalia nematytų sienelių nėra taškų")
    sub = a[sel]
    X = np.stack([sub["x"], sub["y"], sub["z"]], axis=1).astype(np.float64)
    C = np.stack([sub[c] for c in col], axis=1).astype(np.float64)
    if C.max() > 255:
        C = C / 257.0
    N = np.stack([sub[c] for c in nrm], axis=1).astype(np.float64) if nrm else None
    tree = cKDTree(X)
    out = np.zeros((len(P), 3), dtype=np.float64)
    step = 1_000_000
    for s in range(0, len(P), step):
        p, fn = P[s:s + step], FN[s:s + step]
        d, i = tree.query(p, k=FILL_K, distance_upper_bound=FILL_R, workers=-1)
        valid = i < len(X)
        i = np.where(valid, i, 0)
        w = np.where(valid, 1.0 / (d + 0.02) ** 2, 0.0)
        if N is not None:
            w *= 0.05 + np.clip(np.abs(np.einsum("mkc,mc->mk", N[i], fn)), 0, 1)
        ws = w.sum(axis=1)
        c = np.einsum("mk,mkc->mc", w, C[i]) / np.maximum(ws, 1e-12)[:, None]
        far = ws <= 0
        if far.any():
            _, j = tree.query(p[far], k=1, workers=-1)
            c[far] = C[j]
        out[s:s + step] = c
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def _write_png(path, img):
    try:
        import cv2
        if not cv2.imwrite(path, img[:, :, ::-1]):
            raise IOError(path)
    except ImportError:
        from PIL import Image
        Image.fromarray(img).save(path)


def fill_unseen(obj_path, pc_path):
    """texrecon OBJ: nematytoms sienelėms – nauja tekstūra iš taškų debesies. Grąžina perdažytų sienelių skaičių."""
    import numpy as np
    with open(obj_path) as f:
        lines = f.read().split("\n")
    v_l = [l[2:] for l in lines if l.startswith("v ")]
    vt_l = [l[3:] for l in lines if l.startswith("vt ")]
    V = np.array(" ".join(v_l).split(), dtype=np.float64).reshape(-1, 3)
    VT = np.array(" ".join(vt_l).split(), dtype=np.float64).reshape(-1, 2)
    f_idx = [i for i, l in enumerate(lines) if l.startswith("f ")]
    tok = " ".join(lines[i][2:] for i in f_idx).replace("/", " ").split()
    per = len(lines[f_idx[0]][2:].replace("/", " ").split()) if f_idx else 0
    if per not in (6, 9):
        raise ValueError("netikėtas OBJ sienelių formatas")
    F = np.array(tok, dtype=np.int64).reshape(-1, per) - 1
    fv = F[:, 0::per // 3]
    ft = F[:, 1::per // 3]
    fn_ = F[:, 2::3] if per == 9 else None
    T = VT[ft]                                                  # (n,3,2)
    ext = T.max(axis=1) - T.min(axis=1)
    tiny = np.all(ext < UNSEEN_UV_EXT, axis=1)
    key = np.rint(T.reshape(-1, 6) * 1e6).astype(np.int64)
    _, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    unseen = tiny & (cnt[inv.ravel()] >= UNSEEN_MIN)
    m = int(unseen.sum())
    if not m:
        return 0
    U = np.nonzero(unseen)[0]
    P3 = V[fv[U]]                                               # (m,3,3)
    A, B, C = P3[:, 0], P3[:, 1], P3[:, 2]
    FN = np.cross(B - A, C - A)
    FN /= np.maximum(np.linalg.norm(FN, axis=1), 1e-12)[:, None]
    emax = np.max(np.linalg.norm(P3 - np.roll(P3, 1, axis=1), axis=2), axis=1)
    res = FILL_RES
    while True:
        s = np.clip(np.ceil(emax / res).astype(np.int64) + 1, FILL_CELL_MIN, FILL_CELL_MAX)
        if int((s * s).sum()) <= FILL_MAX_TEXELS or s.max() == FILL_CELL_MIN:
            break
        res *= 1.25
    total = int((s * s).sum())
    W = 1 << max(6, int(math.ceil(math.log2(math.sqrt(total * 1.15)))))
    W = min(W, 8192)
    order = np.argsort(-s, kind="stable")
    X0 = np.zeros(m, dtype=np.int64)
    Y0 = np.zeros(m, dtype=np.int64)
    x = y = row = 0
    for j in order:
        sj = int(s[j])
        if x + sj > W:
            x, y, row = 0, y + row, 0
        X0[j], Y0[j] = x, y
        x += sj
        row = max(row, sj)
    H = y + row
    H = (H + 3) // 4 * 4
    if H > 16384:
        raise ValueError("nematytų sienelių per daug (%s)" % m)
    # Tekselių 3D taškai (trikampis A-B-C → langelio kampai; už įstrižainės – kraštas, kad nebūtų siūlių)
    pts, nrm, pix = [], [], []
    for sv in np.unique(s):
        sv = int(sv)
        g = np.nonzero(s == sv)[0]
        ii, jj = np.meshgrid(np.arange(sv), np.arange(sv), indexing="xy")
        u = (ii.ravel() / (sv - 1.0))
        v = (jj.ravel() / (sv - 1.0))
        tot = u + v
        sc = np.where(tot > 1, 1.0 / np.maximum(tot, 1e-9), 1.0)
        u, v = u * sc, v * sc
        p = A[g][:, None] + u[None, :, None] * (B[g] - A[g])[:, None] + v[None, :, None] * (C[g] - A[g])[:, None]
        pts.append(p.reshape(-1, 3))
        nrm.append(np.repeat(FN[g], sv * sv, axis=0))
        pix.append(np.stack([(X0[g][:, None] + ii.ravel()[None]).ravel(),
                             (Y0[g][:, None] + jj.ravel()[None]).ravel()], axis=1))
    pts, nrm, pix = np.concatenate(pts), np.concatenate(nrm), np.concatenate(pix)
    cols = _point_colors(pc_path, pts, nrm, P3)
    img = np.zeros((H, W, 3), dtype=np.uint8)
    img[:] = np.median(cols, axis=0).astype(np.uint8)
    img[pix[:, 1], pix[:, 0]] = cols
    # OBJ: naujos UV, sienelės perkeliamos į naują medžiagą
    base = os.path.splitext(obj_path)[0]
    png_name = os.path.basename(base) + "_" + FILL_MTL + "_map_Kd.png"
    _write_png(os.path.join(os.path.dirname(obj_path), png_name), img)
    uvA = np.stack([X0 + 0.5, Y0 + 0.5], axis=1)
    uvB = np.stack([X0 + s - 0.5, Y0 + 0.5], axis=1)
    uvC = np.stack([X0 + 0.5, Y0 + s - 0.5], axis=1)
    uv = np.stack([uvA, uvB, uvC], axis=1) / [W, H]
    uv[..., 1] = 1.0 - uv[..., 1]
    nvt = len(VT)
    new_vt = ["vt %.7f %.7f" % (a_, b_) for a_, b_ in uv.reshape(-1, 2)]
    new_f = ["usemtl " + FILL_MTL]
    for r, fi in enumerate(U):
        t = [nvt + 3 * r + k + 1 for k in range(3)]
        if fn_ is not None:
            new_f.append("f " + " ".join("%d/%d/%d" % (fv[fi, k] + 1, t[k], fn_[fi, k] + 1) for k in range(3)))
        else:
            new_f.append("f " + " ".join("%d/%d" % (fv[fi, k] + 1, t[k]) for k in range(3)))
        lines[f_idx[fi]] = None
    mtllib = next((l.split(None, 1)[1].strip() for l in lines if l and l.startswith("mtllib ")), None)
    while lines and lines[-1] == "":
        lines.pop()
    out = [l for l in lines if l is not None] + new_vt + new_f
    tmp = obj_path + ".atea_tmp"
    with open(tmp, "w") as f:
        f.write("\n".join(out) + "\n")
    os.replace(tmp, obj_path)
    if mtllib:
        with open(os.path.join(os.path.dirname(obj_path), mtllib), "a") as f:
            f.write("newmtl %s\nKa 1.000000 1.000000 1.000000\nKd 1.000000 1.000000 1.000000\n"
                    "Ks 0.000000 0.000000 0.000000\nTr 0.000000\nillum 1\nNs 1.000000\nmap_Kd %s\n" % (FILL_MTL, png_name))
    log.ODM_INFO("Atea: nematytos sienelės nudažytos pagal taškų debesį – %s (tekstūra %s×%s, %.0f mm/px)"
                 % (m, W, H, res * 1000))
    return m
