# Atea 3D Matuoklis – ODM pakeitimai atvaizdo kūrimo metu (deploy/odm/Dockerfile).
# Kiekviena grupė taikoma atskirai ir „visi arba nė vieno“: jei naujoje ODM versijoje grupės vietos pasikeitė, ta grupė
# praleidžiama (ODM veikia kaip originalas), kitos – pritaikomos. Pakartotinai paleidus jau pritaikytos grupės
# nekeičiamos (žymė).
#   mesh    – parinktis --mesh-method poisson|openmvs ir OpenMVS tinklas (opendm/atea_mesh.py)
#   flatten – po 3D tinklo sukūrimo: plaukiojančių gabalų šalinimas, fasadų lyginimas, mažų skylių užpildymas
#   sky     – dangaus kaukė (--sky-removal) išplečiama į pastato pusę ~2 % nuotraukos: ODM ją skaičiuoja 384×384 px
#             vaizde ir ištempia, todėl pastatų kraštai prieš dangų (stogo parapetas) būdavo „nukandami“ – dantytas kraštas
#   unseen  – po texrecon: sienelės, kurių nematė nė viena nuotrauka (vienoda pilka), nudažomos pagal taškų debesį
#   mesh25d – ODM 2.5D tinklas (ortofotografijai): dem2mesh kartais nulūžta (Segmentation fault) sujungdamas dalis – tada
#             bandoma dar 2 kartus su 2× ir 4× retesniu DSM, o ne nutraukiamas visas apdorojimas
#   fuse    – parinktis --pc-fuse-views: kiek nuotraukų turi patvirtinti tašką tankinant (numatyta 2, kaip ODM;
#             3 – mažiau atspindžių triukšmo stikle, bet dingsta ir blizgių automobilių stogų taškai)
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/code"
CONFIG = ROOT + "/opendm/config.py"
MESHING = ROOT + "/stages/odm_meshing.py"
OPENMVS = ROOT + "/stages/openmvs.py"
SKYFILTER = ROOT + "/opendm/skyremoval/skyfilter.py"
MVSTEX = ROOT + "/stages/mvstex.py"

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
  'unseen': ('atea_mesh.fill_unseen', {
    MVSTEX: [
        ("                if r['primary'] and (not r['nadir'] or args.skip_3dmodel):\n                    # GlTF?\n",
         "                # Atea: nematytos sienelės (vienoda pilka) – spalva iš taškų debesies (deploy/odm/atea_mesh.py)\n"
         "                if not r['nadir'] and args.texturing_keep_unseen_faces:\n"
         "                    try:\n"
         "                        from opendm import atea_mesh\n"
         "                        atea_mesh.fill_unseen(odm_textured_model_obj, tree.filtered_point_cloud)\n"
         "                    except Exception as e:\n"
         "                        log.ODM_WARNING('Atea: nematytų sienelių dažymas praleistas (%s)' % str(e))\n"
         "\n"
         "                if r['primary'] and (not r['nadir'] or args.skip_3dmodel):\n                    # GlTF?\n"),
    ],
  }),
  'mesh25d': ('Atea: 2.5D', {
    MESHING: [
        ("              mesh.create_25dmesh(tree.filtered_point_cloud, tree.odm_25dmesh,\n",
         "              # Atea: 2.5D tinklas – nepavykus (dem2mesh lūžta) bandoma su retesniu DSM, apdorojimas nenutraukiamas\n"
         "              for atea_try in range(3):\n"
         "                try:\n"
         "                  mesh.create_25dmesh(tree.filtered_point_cloud, tree.odm_25dmesh,\n"),
        ("                    max_tiles=None if reconstruction.has_geotagged_photos() else math.ceil(len(reconstruction.photos) / 2))\n",
         "                    max_tiles=None if reconstruction.has_geotagged_photos() else math.ceil(len(reconstruction.photos) / 2))\n"
         "                  break\n"
         "                except Exception as e:\n"
         "                  if atea_try == 2:\n"
         "                      raise\n"
         "                  dsm_resolution *= 2.0\n"
         "                  radius_steps = [type(r)(float(r) * 2.0) for r in radius_steps]\n"
         "                  log.ODM_WARNING('Atea: 2.5D tinklas nepavyko (%s) - kartojama su retesniu DSM (%s m)' % (str(e), dsm_resolution))\n"),
    ],
  }),
  'fuse': ('pc_fuse_views', {
    CONFIG: [
        ("    'pc_filter': 'openmvs',\n",
         "    'pc_filter': 'openmvs',\n    'pc_fuse_views': 'openmvs',\n"),
        ("    parser.add_argument('--pc-filter',\n",
         "    parser.add_argument('--pc-fuse-views',\n"
         "                        metavar='<positive integer>',\n"
         "                        action=StoreValue,\n"
         "                        type=int,\n"
         "                        default=2,\n"
         "                        help=('Atea: minimum number of images that must agree on a point during depthmap fusion. '\n"
         "                              '3 removes more reflection noise (glass) but also points on glossy surfaces (car roofs). Default: %(default)s'))\n"
         "\n"
         "    parser.add_argument('--pc-filter',\n"),
    ],
    OPENMVS: [
        ("            number_views_fuse = 2\n",
         "            # Atea: --pc-fuse-views (numatyta 2, kaip ODM)\n"
         "            number_views_fuse = max(2, int(getattr(args, 'pc_fuse_views', 2) or 2))\n"),
    ],
  }),
  'sky': ('Atea: dangaus kaukė', {
    SKYFILTER: [
        ("        res = cv2.threshold(res, 127, 255, cv2.THRESH_BINARY_INV)[1]\n",
         "        res = cv2.threshold(res, 127, 255, cv2.THRESH_BINARY_INV)[1]\n"
         "\n"
         "        # Atea: dangaus kaukė išplečiama į pastato pusę (~2 % nuotraukos) – pastatų kraštai prieš dangų lieka\n"
         "        k = max(3, int(0.02 * max(res.shape[:2])) | 1)\n"
         "        res = cv2.dilate(res, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))\n"),
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
