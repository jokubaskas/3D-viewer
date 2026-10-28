# Atea 3D Matuoklis – ODM pakeitimas atvaizdo kūrimo metu (deploy/odm/Dockerfile).
# Prideda parinktį --mesh-method poisson|openmvs ir jos naudojimą 3D tinklo etape (opendm/atea_mesh.py).
# Jei ODM naujoje versijoje šios vietos pasikeitė – nieko nekeičiama (visi pakeitimai arba nė vieno): parinkties
# nebus, NodeODM ją praleis ir bus naudojamas įprastas Poisson, t. y. apdorojimas nesugrius.
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/code"
CONFIG = ROOT + "/opendm/config.py"
MESHING = ROOT + "/stages/odm_meshing.py"

edits = {
    CONFIG: [
        ("    'mesh_size': 'odm_meshing',\n",
         "    'mesh_size': 'odm_meshing',\n    'mesh_method': 'odm_meshing',\n"),
        ("    parser.add_argument('--fast-orthophoto',\n",
         "    parser.add_argument('--mesh-method',\n"
         "                        metavar='<string>',\n"
         "                        action=StoreValue,\n"
         "                        default='poisson',\n"
         "                        choices=['poisson', 'openmvs'],\n"
         "                        help=('3D mesh method: poisson (ODM default) or openmvs (Atea: OpenMVS ReconstructMesh + '\n"
         "                              'RefineMesh - sharper edges; falls back to poisson on failure). Can be one of: %(choices)s. Default: %(default)s'))\n"
         "\n"
         "    parser.add_argument('--fast-orthophoto',\n"),
    ],
    MESHING: [
        ("              log.ODM_INFO('Writing ODM Mesh file in: %s' % tree.odm_mesh)\n\n"
         "              mesh.screened_poisson_reconstruction(",
         "              log.ODM_INFO('Writing ODM Mesh file in: %s' % tree.odm_mesh)\n\n"
         "              # Atea: OpenMVS tinklas (deploy/odm/atea_mesh.py); nepavykus – Poisson\n"
         "              atea_done = False\n"
         "              if getattr(args, 'mesh_method', 'poisson') == 'openmvs':\n"
         "                  try:\n"
         "                      from opendm import atea_mesh\n"
         "                      atea_done = atea_mesh.openmvs_mesh(tree, args, tree.odm_mesh, self.params.get('max_vertex'), self.params.get('max_concurrency'))\n"
         "                  except Exception as e:\n"
         "                      log.ODM_WARNING('Atea: OpenMVS tinklas nepasiekiamas (%s) - naudojamas Poisson' % str(e))\n"
         "\n"
         "              if not atea_done: mesh.screened_poisson_reconstruction("),
    ],
}

texts = {p: open(p, encoding="utf-8").read() for p in edits}
missing = [(p, a[:60]) for p, lst in edits.items() for a, _ in lst if texts[p].count(a) != 1]
if missing:
    print("ATEA PATCH: ODM pakeitimo vietos nerastos – naudojamas originalus ODM (Poisson):", missing)
    sys.exit(0)
for p, lst in edits.items():
    for a, b in lst:
        texts[p] = texts[p].replace(a, b)
    open(p, "w", encoding="utf-8").write(texts[p])
print("ATEA PATCH: --mesh-method openmvs įdiegtas")
