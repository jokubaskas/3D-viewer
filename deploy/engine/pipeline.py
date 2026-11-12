# Atea variklis – nuotraukos → 3D modelis, taškų debesis, ortofoto, DSM / DTM (ir realistiškas vaizdas).
# Etapai pagal ODM logiką, kiekvienam – geriausias laisvos licencijos įrankis:
#   dataset   – nuotraukų EXIF / DJI XMP, GPS, vietinis UTM rėmas (kaip ODM coords.txt)
#   features  – SIFT požymiai (COLMAP, GPU)
#   matching  – poros pagal GPS artumą (be GPS – visos / iš eilės) + geometrinis patikrinimas
#   sfm       – kamerų padėtys: „Greitas“ – globalus (GLOMAP), „Aukšta kokybė“ – nuoseklus su GPS ribojimais
#   georef    – Sim3 į UTM vietinį rėmą pagal GPS (RANSAC) arba kontrolinius taškus (gcp_list.txt)
#   undistort – ištiesintos nuotraukos tankinimui ir tekstūrai
#   dense     – gylio žemėlapiai (COLMAP PatchMatch, CUDA) su geometriniu nuoseklumu
#   fusion    – gylių suliejimas į tankų taškų debesį
#   filter    – sritis, statistinis triukšmo filtras, retinimas
#   mesh      – Poisson (PoissonRecon), smulkių / nepagrįstų dalių šalinimas, supaprastinimas
#   texture   – nuotraukų tekstūra (mvs-texturing, kaip ODM)
#   export    – GLB / OBJ / LAZ / coords.txt ODM katalogų struktūra (programa juos atidaro kaip ODM rezultatus)
#   ortho     – ortofoto, DSM, DTM (GeoTIFF / COG) iš tekstūruoto modelio
# Licencijos: COLMAP / pycolmap – BSD, PoissonRecon – MIT, mvs-texturing – BSD, Open3D – MIT. ODM (AGPL) kodas
# nenaudojamas – tik jo etapų logika ir parametrai.
import argparse
import glob
import json
import os
import shutil
import sys
import time
import traceback

import numpy as np

import geo

HERE = os.path.dirname(os.path.abspath(__file__))
IMG_EXT = (".jpg", ".jpeg", ".tif", ".tiff", ".png")

# Režimų parametrai. ODM atitikmenys: feature-quality, pc-quality, mesh-octree-depth, mesh-size, orthophoto-resolution.
QUALITY = {
    "fast": {
        "label": "Greitas",
        "feature_size": 2048, "max_features": 8192,           # ODM feature-quality: medium–high
        "neighbors": 24, "sfm": "global", "camera_model": "SIMPLE_RADIAL",
        "texture_size": 2048,                                  # ištiesintų nuotraukų dydis (tekstūrai)
        "pm_size": 1024, "pm_iters": 3, "pm_samples": 10, "pm_window_step": 2,   # ODM pc-quality: medium (¼)
        "fusion_min_pixels": 3,
        "mesh_res": 0.08, "mesh_faces": 400_000,               # Poisson gylis pagal ~8 cm, ≤ 0,4 mln. trikampių
        "point_spacing": 0.05, "ortho_gsd": 0.05, "page_size": 4096,
    },
    "high": {
        "label": "Aukšta kokybė",
        "feature_size": 3200, "max_features": 16384,           # ODM feature-quality: high–ultra
        "neighbors": 48, "sfm": "incremental", "camera_model": "OPENCV",
        "texture_size": 4096,
        "pm_size": 2000, "pm_iters": 5, "pm_samples": 15, "pm_window_step": 1,   # ODM pc-quality: high (½)
        "fusion_min_pixels": 5,
        "mesh_res": 0.025, "mesh_faces": 1_500_000,
        "point_spacing": 0.015, "ortho_gsd": 0.0, "page_size": 8192,  # ortofoto 0 – pagal nuotraukų GSD
    },
}

STAGES = [("dataset", 2), ("features", 7), ("matching", 7), ("sfm", 12), ("georef", 1), ("undistort", 3), ("dense", 30),
          ("fusion", 5), ("filter", 2), ("mesh", 7), ("texture", 11), ("export", 5), ("ortho", 8)]
STAGE_LABELS = {"dataset": "nuotraukų nuskaitymas", "features": "požymių paieška", "matching": "nuotraukų porų derinimas",
                "sfm": "kamerų padėtys (SfM)", "georef": "georeferencija", "undistort": "nuotraukų ištiesinimas",
                "dense": "gylio žemėlapiai (GPU)", "fusion": "tankus taškų debesis", "filter": "taškų debesies valymas",
                "mesh": "3D tinklas", "texture": "tekstūra", "export": "rezultatų įrašymas", "ortho": "ortofoto ir DSM / DTM"}


class Cancelled(Exception):
    pass


def pycolmap_device():
    """GPU, jei pycolmap su CUDA ir vaizdo plokštė tikrai yra; kitaip – procesorius."""
    import pycolmap
    try:
        if pycolmap.has_cuda and pycolmap.get_num_cuda_devices() > 0:
            return pycolmap.Device.cuda
    except Exception:
        pass
    return pycolmap.Device.cpu


class Pipeline:
    def __init__(self, task_dir, quality="high", log=None, progress=None):
        if quality not in QUALITY:
            raise ValueError("Nežinomas režimas: %s" % quality)
        self.dir = task_dir
        self.q = dict(QUALITY[quality], name=quality)
        self.images = os.path.join(task_dir, "images")
        self.work = os.path.join(task_dir, "work")
        self.db = os.path.join(self.work, "database.db")
        self.sparse = os.path.join(self.work, "sparse")
        self.dense_dir = os.path.join(self.work, "dense")
        self._log = log or (lambda m: print(m, flush=True))
        self._progress = progress or (lambda p: None)
        self.frame = None
        os.makedirs(self.work, exist_ok=True)

    # ---------------------------------------------------------------- pagalbinės
    def log(self, msg):
        self._log(msg)

    def out(self, *p):
        path = os.path.join(self.dir, *p)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        return path

    def check_cancel(self):
        if os.path.exists(os.path.join(self.dir, "cancel")):
            raise Cancelled()

    def _done_path(self, stage):
        return os.path.join(self.work, ".done_" + stage)

    def done(self, stage):
        try:
            return json.load(open(self._done_path(stage))).get("quality") == self.q["name"]
        except (OSError, ValueError):
            return False

    def run(self, until=None):
        total = sum(w for _, w in STAGES)
        acc = 0
        t_all = time.time()
        for stage, w in STAGES:
            self.check_cancel()
            if self.done(stage):
                self.log("Etapas „%s“ jau atliktas – praleidžiamas" % STAGE_LABELS[stage])
            else:
                self.log("Running %s stage – %s" % (stage, STAGE_LABELS[stage]))
                t0 = time.time()
                getattr(self, "stage_" + stage)()
                json.dump({"quality": self.q["name"], "time": time.time() - t0}, open(self._done_path(stage), "w"))
                self.log("Etapas „%s“ baigtas per %.0f s" % (STAGE_LABELS[stage], time.time() - t0))
            acc += w
            self._progress(100.0 * acc / total)
            if stage == until:
                break
        self.log("Viskas baigta per %.1f min." % ((time.time() - t_all) / 60))

    def _load_frame(self):
        if self.frame is None:
            p = os.path.join(self.work, "frame.json")
            if os.path.isfile(p):
                self.frame = geo.GeoFrame.from_json(json.load(open(p)))
        return self.frame

    def _photos(self):
        return json.load(open(os.path.join(self.work, "photos.json")))

    def _extra_file(self, pattern):
        for d in (self.dir, self.images):
            m = sorted(glob.glob(os.path.join(d, pattern)))
            if m:
                return m[0]
        return None

    # ---------------------------------------------------------------- 1. nuotraukos
    def stage_dataset(self):
        names = sorted(f for f in os.listdir(self.images) if f.lower().endswith(IMG_EXT))
        if len(names) < 3:
            raise RuntimeError("Per mažai nuotraukų (%d) – reikia bent 3" % len(names))
        photos = []
        for n in names:
            try:
                photos.append(geo.read_photo(os.path.join(self.images, n)))
            except Exception as e:  # sugadintas failas – praleidžiamas, kaip ODM
                self.log("Nuotrauka %s praleista: %s" % (n, e))
        geo_txt = self._extra_file("geo.txt")
        if geo_txt:
            g = geo.parse_geo_txt(open(geo_txt, encoding="utf-8", errors="replace").read())
            n = 0
            for p in photos:
                e = g.get(p["name"])
                if e:
                    alt = e["alt"] if np.isfinite(e["alt"]) else (p.get("gps") or [0, 0, 0])[2]
                    p["gps"] = [e["lat"], e["lon"], alt]
                    if np.isfinite(e["hacc"]):
                        p["acc"] = [e["hacc"], e["vacc"]]
                    n += 1
            self.log("geo.txt: padėtys ir aukščiai %d nuotraukoms (aukščių sistema – kaip parinkta programoje)" % n)
        gps = [p["gps"] for p in photos if p.get("gps")]
        self.log("Nuotraukų: %d, su GPS: %d" % (len(photos), len(gps)))
        if len(gps) >= 3:
            frame = geo.GeoFrame.from_gps(gps)
            json.dump(frame.to_json(), open(os.path.join(self.work, "frame.json"), "w"))
            self.log("Koordinačių sistema: WGS84 / UTM %d%s, poslinkis %d %d" % (frame.zone, "S" if frame.south else "N", frame.off_e, frame.off_n))
        json.dump(photos, open(os.path.join(self.work, "photos.json"), "w"))

    # ---------------------------------------------------------------- 2. požymiai
    def _device(self):
        return pycolmap_device()

    def stage_features(self):
        import pycolmap
        if os.path.exists(self.db):
            os.remove(self.db)
        names = [p["name"] for p in self._photos()]
        eo = pycolmap.FeatureExtractionOptions()
        eo.max_image_size = self.q["feature_size"]
        eo.sift.max_num_features = self.q["max_features"]
        ro = pycolmap.ImageReaderOptions()
        ro.camera_model = self.q["camera_model"]
        pycolmap.extract_features(self.db, self.images, image_names=names, camera_mode=pycolmap.CameraMode.AUTO,
                                  reader_options=ro, extraction_options=eo, device=self._device())
        self._set_camera_priors()

    def _set_camera_priors(self):
        """Kamerų pradiniai parametrai iš nuotraukų metaduomenų (žr. geo.camera_prior)."""
        import pycolmap
        photos = {p["name"]: p for p in self._photos()}
        db = pycolmap.Database.open(self.db)
        fixed, out = True, []
        try:
            first = {}
            for im in db.read_all_images():
                first.setdefault(im.camera_id, im.name)
            for cam in db.read_all_cameras():
                info = photos.get(first.get(cam.camera_id))
                pr = geo.camera_prior(info) if info else None
                if not pr or info["width"] != cam.width or info["height"] != cam.height:
                    fixed = False
                    self.log("Kamera %d: židinys nežinomas – bus įvertintas derinant" % cam.camera_id)
                    continue
                prm = list(cam.params)
                if cam.model_name == "OPENCV":
                    prm[:4] = [pr["f"], pr["f"], pr["cx"], pr["cy"]]
                    if pr["k"]:
                        prm[4:8] = pr["k"]
                elif cam.model_name in ("SIMPLE_RADIAL", "RADIAL"):
                    prm[:3] = [pr["f"], pr["cx"], pr["cy"]]
                    if pr["k"] and cam.model_name == "SIMPLE_RADIAL":
                        prm[3] = pr["k"][0]
                cam.params = prm
                cam.has_prior_focal_length = True
                db.update_camera(cam)
                self.log("Kamera %d (%dx%d): židinys %.1f px (%s)" % (cam.camera_id, cam.width, cam.height, pr["f"], pr["source"]))
                out.append({"camera_id": cam.camera_id, **pr})
        finally:
            db.close()
        json.dump({"fixed_focal": fixed, "cameras": out}, open(os.path.join(self.work, "cameras.json"), "w"))

    # ---------------------------------------------------------------- 3. porų derinimas
    def stage_matching(self):
        import pycolmap
        photos = self._photos()
        mo = pycolmap.FeatureMatchingOptions()
        n_gps = sum(1 for p in photos if p.get("gps"))
        if n_gps >= 0.8 * len(photos):
            po = pycolmap.SpatialPairingOptions()
            po.max_num_neighbors = self.q["neighbors"]
            # Nuotraukos persidengia iki ~2 × skrydžio aukščio atstumu (įstrižos – dar toliau)
            rel = [p["xmp"].get("RelativeAltitude") for p in photos if isinstance(p.get("xmp", {}).get("RelativeAltitude"), float)]
            h = float(np.median(rel)) if rel else 80.0
            po.max_distance = float(max(60.0, 3.0 * abs(h)))
            po.ignore_z = False
            self.log("Poros pagal GPS: iki %d kaimynų, iki %.0f m" % (po.max_num_neighbors, po.max_distance))
            pycolmap.match_spatial(self.db, matching_options=mo, pairing_options=po, device=self._device())
        elif len(photos) <= 250:
            self.log("GPS nėra – derinamos visos poros")
            pycolmap.match_exhaustive(self.db, matching_options=mo, device=self._device())
        else:
            self.log("GPS nėra – derinama iš eilės (nuotraukų tvarka)")
            po = pycolmap.SequentialPairingOptions()
            po.overlap = 30
            po.quadratic_overlap = True
            pycolmap.match_sequential(self.db, matching_options=mo, pairing_options=po, device=self._device())

    # ---------------------------------------------------------------- 4. kamerų padėtys
    def stage_sfm(self):
        import pycolmap
        shutil.rmtree(self.sparse, ignore_errors=True)
        os.makedirs(self.sparse)
        # Židinys – iš kameros duomenų ir nekeičiamas (statmenose plokščios vietovės nuotraukose jis nenustatomas: laisvai
        # derinant „nuplaukia“ ~10–15 %, modelis skyla į dalis, suspaudžiami aukščiai ir išlinksta paviršius)
        fixed = self._fixed_focal()
        if self.q["sfm"] == "global":
            opts = pycolmap.GlobalPipelineOptions()
            opts.mapper.bundle_adjustment.refine_focal_length = not fixed
            recs = pycolmap.global_mapping(self.db, self.images, self.sparse, opts)
            if not recs or max(r.num_reg_images() for r in recs.values()) < 0.8 * len(self._photos()):
                self.log("Globalus derinimas nepavyko visoms nuotraukoms – naudojamas nuoseklus")
                shutil.rmtree(self.sparse, ignore_errors=True)
                os.makedirs(self.sparse)
                recs = pycolmap.incremental_mapping(self.db, self.images, self.sparse, self._incremental_options(fixed))
        else:
            recs = pycolmap.incremental_mapping(self.db, self.images, self.sparse, self._incremental_options(fixed))
        if not recs:
            raise RuntimeError("Nepavyko sujungti nuotraukų (per mažai bendrų taškų). Patikrinkite persidengimą (≥ 70 %).")
        best = max(recs.values(), key=lambda r: r.num_reg_images())
        n = len(self._photos())
        self.log("Sujungta nuotraukų: %d iš %d, taškų: %d, paklaida %.2f px (dalių: %d)"
                 % (best.num_reg_images(), n, best.num_points3D(), best.compute_mean_reprojection_error(), len(recs)))
        if best.num_reg_images() < max(3, 0.5 * n):
            raise RuntimeError("Sujungta tik %d iš %d nuotraukų – per mažas persidengimas arba nuotraukos per skirtingos"
                               % (best.num_reg_images(), n))
        out = os.path.join(self.work, "sfm")
        shutil.rmtree(out, ignore_errors=True)
        os.makedirs(out)
        best.write(out)

    def _fixed_focal(self):
        try:
            return bool(json.load(open(os.path.join(self.work, "cameras.json")))["fixed_focal"])
        except (OSError, ValueError, KeyError):
            return False

    def _incremental_options(self, fixed):
        import pycolmap
        o = pycolmap.IncrementalPipelineOptions()
        o.multiple_models = True
        o.ba_refine_focal_length = not fixed
        o.mapper.abs_pose_refine_focal_length = not fixed
        # Kol iškraipymas dar neįvertintas (pirmos nuotraukos) – leidžiama didesnė reprojekcijos paklaida
        o.mapper.abs_pose_max_error = 24.0
        o.mapper.filter_max_reproj_error = 8.0
        return o

    # ---------------------------------------------------------------- 5. georeferencija
    def _triangulate(self, rec, obs):
        """Kontrolinio taško padėtis SfM rėme iš jo matymų nuotraukose (spindulių artimiausias taškas)."""
        by_name = {im.name: im for im in rec.images.values() if im.has_pose}
        A = np.zeros((3, 3))
        b = np.zeros(3)
        k = 0
        for name, u, v in obs:
            im = by_name.get(name)
            if im is None:
                continue
            ray_c = np.append(im.camera.cam_from_img(np.array([u, v], float)), 1.0)
            Rw = im.cam_from_world().rotation.matrix().T
            d = Rw @ ray_c
            d /= np.linalg.norm(d)
            c = im.projection_center()
            P = np.eye(3) - np.outer(d, d)
            A += P
            b += P @ c
            k += 1
        if k < 2:
            return None
        return np.linalg.solve(A, b)

    def _align(self, rec, quiet=False):
        """Sim3 į vietinį UTM rėmą: pagal kontrolinius taškus (gcp_list.txt) arba GPS (RANSAC pagal tikslumą)."""
        import pycolmap
        log = (lambda m: None) if quiet else self.log
        frame = self._load_frame()
        if frame is None:
            return None
        gcp_file = self._extra_file("gcp*.txt")
        if gcp_file:
            gcps = geo.parse_gcp(open(gcp_file, encoding="utf-8", errors="replace").read(), frame)
            src, dst = [], []
            for g in gcps.values():
                p = self._triangulate(rec, g["obs"])
                if p is not None:
                    src.append(p)
                    dst.append(g["xyz"])
            if len(src) >= 3:
                sim = pycolmap.estimate_sim3d(np.array(src), np.array(dst))
                if sim is not None:
                    res = np.linalg.norm(np.array([sim * p for p in src]) - np.array(dst), axis=1)
                    log("Kontroliniai taškai: %d, liekamoji paklaida vid. %.3f m, didž. %.3f m" % (len(src), res.mean(), res.max()))
                    return sim
            else:
                log("Kontrolinių taškų per mažai (%d, reikia ≥ 3 su ≥ 2 matymais) – naudojamas GPS" % len(src))
        photos = {p["name"]: p for p in self._photos()}
        names, locs, acc = [], [], []
        for im in rec.images.values():
            p = photos.get(im.name)
            if im.has_pose and p and p.get("gps"):
                names.append(im.name)
                locs.append(frame.to_local(*p["gps"]))
                if p.get("acc"):
                    acc.append(max(p["acc"]))
                elif p.get("xmp", {}).get("RtkFlag") == 50.0:
                    acc.append(0.05)
                else:
                    acc.append(3.0)
        if len(names) < 3:
            return None
        ro = pycolmap.RANSACOptions()
        # RANSAC riba pagal GPS tikslumą (RTK FIX – ~5 cm, be RTK – ~3 m)
        ro.max_error = float(np.clip(2.0 * np.median(acc), 0.1, 6.0)) if acc else 3.0
        sim = pycolmap.align_reconstruction_to_locations(rec, names, np.array(locs), 3, ro)
        if sim is not None:
            by = {im.name: im for im in rec.images.values()}
            err = [np.linalg.norm(sim * by[n].projection_center() - l) for n, l in zip(names, locs)]
            log("Georeferencija pagal GPS (%s): %d nuotraukų, paklaida mediana %.2f m"
                % ("RTK" if ro.max_error < 0.5 else "be RTK", len(names), float(np.median(err))))
        return sim

    def _observability(self, rec):
        """Ar židinį galima nustatyti iš pačių nuotraukų: įstrižų nuotraukų dalis (> 15° nuo statmens) ir reljefas –
        kiek skiriasi taškų atstumai nuo kameros vienoje nuotraukoje (pastatai, šlaitai). Plokščia + statmenos – ne."""
        imgs = [im for im in rec.images.values() if im.has_pose]
        if not imgs:
            return 0.0, 0.0
        obl = float(np.mean([abs(im.viewing_direction()[2]) < np.cos(np.radians(15)) for im in imgs]))
        rel = []
        P = {pid: p.xyz for pid, p in rec.points3D.items()}
        for im in imgs[:: max(1, len(imgs) // 60)]:
            ids = [q.point3D_id for q in im.points2D if q.has_point3D()]
            if len(ids) < 30:
                continue
            X = np.array([P[i] for i in ids])
            T = im.cam_from_world()
            z = (X @ T.rotation.matrix().T + T.translation)[:, 2]
            z = z[z > 0]
            if len(z) > 30:
                rel.append((np.percentile(z, 95) - np.percentile(z, 5)) / np.median(z))
        return obl, float(np.median(rel)) if rel else 0.0

    def _refine_focal(self, rec):
        """Su įstrižomis nuotraukomis ar reljefu židinys patikslinamas bendru derinimu ir modelis georeferencuojamas
        iš naujo; neįtikėtinas pokytis (> 8 %) atmetamas. Vien statmenos plokščios vietovės – lieka kameros židinys."""
        import pycolmap
        import tempfile
        obl, rel = self._observability(rec)
        if obl < 0.1 and rel < 0.12:
            self.log("Židinys – iš kameros duomenų (statmenos nuotraukos, reljefas %.0f %%)" % (100 * rel))
            return
        f0 = {c: rec.cameras[c].mean_focal_length() for c in rec.cameras}
        backup = tempfile.mkdtemp(dir=self.work)
        rec.write(backup)
        o = pycolmap.BundleAdjustmentOptions()
        o.refine_focal_length = True
        o.refine_extra_params = True
        pycolmap.bundle_adjustment(rec, o)
        f1 = {c: rec.cameras[c].mean_focal_length() for c in rec.cameras}
        change = max(abs(f1[c] / f0[c] - 1) for c in f0)
        desc = ", ".join("%.1f → %.1f px" % (f0[c], f1[c]) for c in f0)
        if change > 0.08:
            self.log("Židinio patikslinimas atmestas (%s – per didelis pokytis)" % desc)
            rec.read(backup)
        else:
            self.log("Židinys patikslintas (įstrižų %.0f %%, reljefas %.0f %%): %s" % (100 * obl, 100 * rel, desc))
            sim = self._align(rec)
            if sim is not None:
                rec.transform(sim)
        shutil.rmtree(backup, ignore_errors=True)

    def stage_georef(self):
        import pycolmap
        rec = pycolmap.Reconstruction(os.path.join(self.work, "sfm"))
        sim = self._align(rec)
        if sim is not None:
            rec.transform(sim)
            self._refine_focal(rec)
        else:
            self.log("Dėmesio: nėra GPS – modelis be georeferencijos ir be mastelio")
        out = os.path.join(self.work, "sfm_geo")
        shutil.rmtree(out, ignore_errors=True)
        os.makedirs(out)
        rec.write(out)

    # ---------------------------------------------------------------- 6. ištiesinimas
    def stage_undistort(self):
        import pycolmap
        shutil.rmtree(self.dense_dir, ignore_errors=True)
        uo = pycolmap.UndistortCameraOptions()
        uo.max_image_size = self.q["texture_size"]
        pycolmap.undistort_images(self.dense_dir, os.path.join(self.work, "sfm_geo"), self.images,
                                  output_type="COLMAP", undistort_options=uo)

    # ---------------------------------------------------------------- 7–8. tankus debesis
    def stage_dense(self):
        import pycolmap
        if pycolmap_device() != pycolmap.Device.cuda:
            raise RuntimeError("Gylio žemėlapiams reikia NVIDIA vaizdo plokštės (CUDA) – ji nerasta")
        o = pycolmap.PatchMatchOptions()
        o.max_image_size = self.q["pm_size"]
        o.num_iterations = self.q["pm_iters"]
        o.num_samples = self.q["pm_samples"]
        o.window_step = self.q["pm_window_step"]
        o.geom_consistency = True
        o.filter = True
        o.cache_size = 16.0
        o.gpu_index = "0"
        pycolmap.patch_match_stereo(self.dense_dir, options=o)

    def stage_fusion(self):
        import pycolmap
        o = pycolmap.StereoFusionOptions()
        o.max_image_size = self.q["pm_size"]
        o.min_num_pixels = self.q["fusion_min_pixels"]
        o.cache_size = 16.0
        pycolmap.stereo_fusion(os.path.join(self.dense_dir, "fused.ply"), self.dense_dir, input_type="geometric",
                               output_type="PLY", options=o)

    # ---------------------------------------------------------------- 9. valymas
    def stage_filter(self):
        import open3d as o3d
        pc = o3d.io.read_point_cloud(os.path.join(self.dense_dir, "fused.ply"))
        n0 = len(pc.points)
        if n0 == 0:
            raise RuntimeError("Tankus taškų debesis tuščias – gylio žemėlapiai nepavyko")
        frame = self._load_frame()
        bfile = self._extra_file("*.geojson")
        if bfile and frame is not None:
            poly = geo.boundary_polygon(open(bfile, encoding="utf-8").read(), frame)
            if poly is not None:
                keep = geo.inside_polygon(np.asarray(pc.points)[:, :2], poly)
                pc = pc.select_by_index(np.flatnonzero(keep))
                self.log("Pagal pasirinktą sritį palikta %d iš %d taškų" % (len(pc.points), n0))
                if not len(pc.points):
                    raise RuntimeError("Pasirinktoje srityje neliko taškų – patikrinkite sritį")
        sp = self.q["point_spacing"]
        pc = pc.voxel_down_sample(sp)
        pc, _ = pc.remove_statistical_outlier(nb_neighbors=16, std_ratio=2.5)  # ODM pc-filter 2.5
        if not pc.has_normals():
            pc.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=6 * sp, max_nn=30))
        self.log("Taškų debesis: %d → %d taškų (retinimas %.1f cm, triukšmo filtras)" % (n0, len(pc.points), sp * 100))
        o3d.io.write_point_cloud(self.out("odm_filterpoints", "point_cloud.ply"), pc)

    # ---------------------------------------------------------------- 10. tinklas
    def stage_mesh(self):
        import mesh as meshmod
        meshmod.build(self.out("odm_filterpoints", "point_cloud.ply"), self.out("odm_meshing", "odm_mesh.ply"),
                      res=self.q["mesh_res"], max_faces=self.q["mesh_faces"], spacing=self.q["point_spacing"],
                      work=self.work, log=self.log)

    # ---------------------------------------------------------------- 11. tekstūra
    def stage_texture(self):
        import texturing
        texturing.texture(self.dense_dir, self.out("odm_meshing", "odm_mesh.ply"),
                          self.out("odm_texturing", "odm_textured_model_geo"), work=self.work,
                          page_size=self.q["page_size"], log=self.log)

    # ---------------------------------------------------------------- 12. rezultatai
    def stage_export(self):
        import export
        frame = self._load_frame()
        if frame is not None:
            frame.save(self.out("odm_georeferencing", "coords.txt"))
        export.laz(self.out("odm_filterpoints", "point_cloud.ply"),
                   self.out("odm_georeferencing", "odm_georeferenced_model.laz"), frame, log=self.log)
        export.opensfm_compat(self.dense_dir, self.dir, log=self.log)

    # ---------------------------------------------------------------- 13. ortofoto, DSM, DTM
    def stage_ortho(self):
        import ortho
        frame = self._load_frame()
        if frame is None:
            self.log("Be georeferencijos ortofoto nekuriamas")
            return
        gsd = self.q["ortho_gsd"] or ortho.estimate_gsd(self.dense_dir)
        ortho.make(self.out("odm_texturing", "odm_textured_model_geo.obj"), self.dir, frame, gsd,
                   boundary=self._extra_file("*.geojson"), log=self.log)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task-dir", required=True)
    ap.add_argument("--quality", default="high", choices=sorted(QUALITY))
    ap.add_argument("--until", default=None)
    a = ap.parse_args()
    st = os.path.join(a.task_dir, "progress.json")

    def progress(p):
        json.dump({"progress": round(p, 1), "updated": time.time()}, open(st + ".tmp", "w"))
        os.replace(st + ".tmp", st)

    try:
        Pipeline(a.task_dir, a.quality, progress=progress).run(until=a.until)
    except Cancelled:
        print("Atšaukta", flush=True)
        sys.exit(2)
    except Exception as e:
        traceback.print_exc()
        print("KLAIDA: %s" % e, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    sys.path.insert(0, HERE)
    main()
