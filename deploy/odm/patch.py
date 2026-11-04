# Atea 3D Matuoklis – ODM pakeitimai atvaizdo kūrimo metu (deploy/odm/Dockerfile).
# Kiekviena grupė taikoma atskirai ir „visi arba nė vieno“: jei naujoje ODM versijoje grupės vietos pasikeitė, ta grupė
# praleidžiama (ODM veikia kaip originalas), kitos – pritaikomos. Pakartotinai paleidus jau pritaikytos grupės
# nekeičiamos (žymė).
#   mesh    – parinktis --mesh-method poisson|openmvs ir OpenMVS tinklas (opendm/atea_mesh.py)
#   flatten – po 3D tinklo sukūrimo: plaukiojančių gabalų šalinimas, fasadų lyginimas, mažų skylių užpildymas
#   fuse    – tankinant taškas priimamas, kai jį patvirtina ≥ 3 nuotraukos (ne 2) – atmetami atspindžių „taškai“
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/code"
CONFIG = ROOT + "/opendm/config.py"
MESHING = ROOT + "/stages/odm_meshing.py"
OPENMVS = ROOT + "/stages/openmvs.py"

GROUPS = {
  'mesh': ('atea_mesh.openmvs_mesh', {
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
  }),
  'flatten': ('atea_mesh.improve_mesh', {
    MESHING: [
        ("                threads=max(1, self.params.get('max_concurrency') - 1)), # poissonrecon can get stuck on some machines if --threads == all cores\n",
         "                threads=max(1, self.params.get('max_concurrency') - 1)), # poissonrecon can get stuck on some machines if --threads == all cores\n"
         "\n"
         "              # Atea: plaukiojančių gabalų šalinimas, fasadų lyginimas, mažų skylių užpildymas – bet kuriam metodui\n"
         "              try:\n"
         "                  from opendm import atea_mesh\n"
         "                  atea_mesh.improve_mesh(tree.odm_mesh, args)\n"
         "              except Exception as e:\n"
         "                  log.ODM_WARNING('Atea: tinklo valymas praleistas (%s)' % str(e))\n"),
    ],
  }),
  'fuse': ('Atea: taškas patvirtinamas', {
    OPENMVS: [
        ("            number_views_fuse = 2\n",
         "            # Atea: taškas patvirtinamas bent 3 nuotraukose – atspindžių stikle „taškai“ nesutampa ir atmetami\n"
         "            number_views_fuse = 3 if len(photos) >= 30 else 2\n"),
    ],
  }),
}

texts = {}
for name, (marker, edits) in GROUPS.items():
    try:
        for f in edits:
            if f not in texts:
                texts[f] = open(f, encoding="utf-8").read()
    except OSError as e:
        print("ATEA PATCH %s: failas nerastas (%s) – praleista" % (name, e))
        continue
    if any(marker in texts[f] for f in edits):
        print("ATEA PATCH %s: jau pritaikyta" % name)
        continue
    missing = [(f, a[:60]) for f, lst in edits.items() for a, _ in lst if texts[f].count(a) != 1]
    if missing:
        print("ATEA PATCH %s: vietos nerastos – praleista (originalus ODM):" % name, missing)
        continue
    for f, lst in edits.items():
        for a, b in lst:
            texts[f] = texts[f].replace(a, b)
    print("ATEA PATCH %s: pritaikyta" % name)
for f, t in texts.items():
    open(f, "w", encoding="utf-8").write(t)
