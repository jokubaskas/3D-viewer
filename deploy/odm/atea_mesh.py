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
                       '--resolution-level %s --min-resolution 640 --max-views %s --max-face-area %s --scales 2 -v 0'
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
