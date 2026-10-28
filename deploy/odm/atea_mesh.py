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


def _refine_level(args):
    # Tikslinimo raiška pagal taškų debesies kokybę (kaip DensifyPointCloud): aukštesnė kokybė – tikslesnės nuotraukos
    return {"ultra": 0, "high": 1, "medium": 2, "low": 3, "lowest": 3}.get(getattr(args, "pc_quality", "medium"), 2)


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
        gpu = "-1" if has_gpu(args) else "-2"

        # 1) Tinklas iš taškų su matomumu
        log.ODM_INFO("Atea: OpenMVS tinklas (ReconstructMesh) iš %s" % os.path.basename(scene))
        recon = os.path.join(work, "mesh.mvs")
        def reconstruct(dev):
            system.run('"%s" -i "%s" -o "%s" -w "%s" --archive-type 3 --export-type ply --max-threads %s --cuda-device %s '
                       '--remove-spurious 20 --close-holes 30 --smooth 1 -v 0' % (_bin("ReconstructMesh"), scene, recon, wdir, threads, dev))
        try:
            reconstruct(gpu)
        except system.SubprocessException:
            if gpu == "-2":
                raise
            log.ODM_WARNING("Atea: ReconstructMesh su GPU nepavyko – kartojama procesoriumi")
            reconstruct("-2")
        mesh_ply = os.path.join(work, "mesh.ply")
        if not io.file_exists(mesh_ply):
            raise Exception("ReconstructMesh nesukūrė tinklo")

        # 2) Tikslinimas pagal nuotraukas (nepavykus – naudojamas netikslintas tinklas)
        best = mesh_ply
        refined = os.path.join(work, "mesh_refine.mvs")
        log.ODM_INFO("Atea: tinklo tikslinimas pagal nuotraukas (RefineMesh)")
        def refine(dev):
            system.run('"%s" -i "%s" -m "%s" -o "%s" -w "%s" --archive-type 3 --export-type ply --max-threads %s --cuda-device %s '
                       '--resolution-level %s --min-resolution 640 --max-views 8 --max-face-area 16 --scales 2 -v 0'
                       % (_bin("RefineMesh"), recon, mesh_ply, refined, wdir, threads, dev, _refine_level(args)))
        try:
            try:
                refine(gpu)
            except system.SubprocessException:
                if gpu == "-2":
                    raise
                log.ODM_WARNING("Atea: RefineMesh su GPU nepavyko – kartojama procesoriumi")
                refine("-2")
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
