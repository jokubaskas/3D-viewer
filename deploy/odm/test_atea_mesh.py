# Atea ODM pakeitimų testai be ODM: opendm moduliai pakeičiami pakaitalais, ReconstructMesh – failo kopija.
# Paleisti: pip install numpy scipy trimesh pytest && pytest deploy/odm
import os
import shutil
import sys
import types

import numpy as np
import pytest

trimesh = pytest.importorskip("trimesh")
pytest.importorskip("scipy")

HERE = os.path.dirname(os.path.abspath(__file__))


def _stub_opendm():
    pkg = types.ModuleType("opendm")
    pkg.__path__ = []
    mods = {}
    for name in ("context", "io", "log", "system", "gpu"):
        m = types.ModuleType("opendm." + name)
        mods[name] = m
        setattr(pkg, name, m)
        sys.modules["opendm." + name] = m
    sys.modules["opendm"] = pkg
    mods["context"].root_path = "/code"
    mods["context"].superbuild_bin_path = "/code/SuperBuild/install/bin"
    mods["context"].omvs_densify_path = "/code/SuperBuild/install/bin/OpenMVS/DensifyPointCloud"
    mods["io"].file_exists = os.path.isfile
    for f in ("ODM_INFO", "ODM_WARNING", "ODM_ERROR", "ODM_DEBUG"):
        setattr(mods["log"], f, lambda *a, **k: None)
    mods["system"].mkdir_p = lambda p: os.makedirs(p, exist_ok=True)

    def run(cmd, *a, **k):  # „ReconstructMesh -i in -o out“ → kopija
        parts = cmd.split('"')
        src, dst = parts[3], parts[5]
        shutil.copy(src, dst)

    mods["system"].run = run
    mods["gpu"].has_gpu = lambda *a, **k: False


_stub_opendm()
sys.path.insert(0, HERE)
import atea_mesh  # noqa: E402


def _grid(x0, x1, z0, z1, step, fn):
    """Vertikali siena plokštumoje y≈fn(x,z) – banguota (kaip stiklas su atspindžiais)."""
    xs = np.arange(x0, x1 + 1e-9, step)
    zs = np.arange(z0, z1 + 1e-9, step)
    V = np.array([[x, fn(x, z), z] for z in zs for x in xs])
    nx = len(xs)
    F = []
    for j in range(len(zs) - 1):
        for i in range(nx - 1):
            a = j * nx + i
            F += [[a, a + 1, a + nx], [a + 1, a + nx + 1, a + nx]]
    return trimesh.Trimesh(V, np.array(F), process=False)


def test_flatten_facades(tmp_path):
    rng = np.random.default_rng(1)
    noise = rng.normal(0, 0.15, 10000)
    facade = _grid(0, 40, 0, 20, 0.5, lambda x, z: 0.25 * np.sin(x * 1.3) * np.cos(z * 0.9) + noise[int(x * 7 + z * 13) % 10000] * 0.5)
    # Žemė – horizontali, su nelygumais: ji neturi būti paliesta
    xs = np.arange(-5, 45.01, 0.5)
    ys = np.arange(-20, 0.01, 0.5)
    G = np.array([[x, y, 0.1 * np.sin(x) * np.sin(y)] for y in ys for x in xs])
    nx = len(xs)
    GF = []
    for j in range(len(ys) - 1):
        for i in range(nx - 1):
            a = j * nx + i
            GF += [[a, a + nx, a + 1], [a + 1, a + nx, a + nx + 1]]
    ground = trimesh.Trimesh(G, np.array(GF), process=False)
    mesh = trimesh.util.concatenate([facade, ground])
    p = str(tmp_path / "odm_mesh.ply")
    mesh.export(p, encoding="binary")

    before = np.abs(facade.vertices[:, 1]).mean()
    moved = atea_mesh.flatten_facades(p)
    assert moved > 100
    out = trimesh.load(p, process=False, force="mesh")
    V = np.asarray(out.vertices)
    nf = len(facade.vertices)
    after = np.abs(V[:nf, 1] - np.median(V[:nf, 1])).mean()
    assert after < before * 0.6, (before, after)
    # Žemės viršūnės nepajudėjo
    assert np.allclose(V[nf:], ground.vertices, atol=1e-6)
    assert not os.path.exists(tmp_path / "atea_flat")


def test_flatten_saves_when_openmvs_fails(tmp_path, monkeypatch):
    """ReconstructMesh nepavyksta – išlygintas tinklas vis tiek įrašomas (ne originalas)."""
    def fail(*a, **k):
        raise Exception("Child returned 1")
    monkeypatch.setattr(atea_mesh.system, "run", fail)
    facade = _grid(0, 40, 0, 20, 0.5, lambda x, z: 0.3 * np.sin(x * 1.3) * np.cos(z * 0.9))
    p = str(tmp_path / "odm_mesh.ply")
    facade.export(p, encoding="binary")
    assert atea_mesh.flatten_facades(p) > 100
    V = np.asarray(trimesh.load(p, process=False, force="mesh").vertices)
    assert np.abs(V[:, 1] - np.median(V[:, 1])).mean() < np.abs(facade.vertices[:, 1]).mean() * 0.6


def _ground(x0, x1, y0, y1, step=0.5):
    xs = np.arange(x0, x1 + 1e-9, step)
    ys = np.arange(y0, y1 + 1e-9, step)
    G = np.array([[x, y, 0.1 * np.sin(x) * np.sin(y)] for y in ys for x in xs])
    nx = len(xs)
    F = []
    for j in range(len(ys) - 1):
        for i in range(nx - 1):
            a = j * nx + i
            F += [[a, a + 1, a + nx], [a + 1, a + nx + 1, a + nx]]
    return trimesh.Trimesh(G, np.array(F), process=False)


def test_flatten_building_corners_and_roof(tmp_path):
    """Pastatas 20×20×15 m su triukšmu: kampai ir stogo kraštas aštrūs, stogas plokščias, žemė nepaliesta."""
    box = trimesh.creation.box(extents=[20, 20, 15])
    box.apply_translation([0, 0, 7.5])
    box.update_faces(box.face_normals[:, 2] > -0.5)  # be apačios
    box.remove_unreferenced_vertices()
    V, F = trimesh.remesh.subdivide_to_size(box.vertices, box.faces, 0.4)
    b = trimesh.Trimesh(V, F, process=True)
    rng = np.random.default_rng(3)
    true_v = b.vertices.copy()
    b.vertices = b.vertices + b.vertex_normals * rng.normal(0, 0.12, (len(b.vertices), 1))
    ground = _ground(-30, 30, -30, 30)
    ground.update_faces(~((np.abs(ground.triangles_center[:, 0]) < 10) & (np.abs(ground.triangles_center[:, 1]) < 10)))
    ground.remove_unreferenced_vertices()
    mesh = trimesh.util.concatenate([b, ground])
    p = str(tmp_path / "odm_mesh.ply")
    mesh.export(p, encoding="binary")

    err0 = np.linalg.norm(b.vertices - true_v, axis=1).mean()
    assert atea_mesh.flatten_facades(p) > 1000
    out = np.asarray(trimesh.load(p, process=False, force="mesh").vertices)
    nb = len(b.vertices)
    err1 = np.linalg.norm(out[:nb] - true_v, axis=1).mean()
    assert err1 < err0 * 0.4, (err0, err1)
    # Briaunos: viršūnės prie vertikalaus kampo ir stogo krašto – ant tikros briaunos
    corner = (np.abs(np.abs(true_v[:, 0]) - 10) < 1e-6) & (np.abs(np.abs(true_v[:, 1]) - 10) < 1e-6) & (true_v[:, 2] > 2) & (true_v[:, 2] < 13)
    roof_edge = (np.abs(true_v[:, 2] - 15) < 1e-6) & ((np.abs(np.abs(true_v[:, 0]) - 10) < 1e-6) | (np.abs(np.abs(true_v[:, 1]) - 10) < 1e-6))
    for sel in (corner, roof_edge):
        e0 = np.linalg.norm(b.vertices[sel] - true_v[sel], axis=1).mean()
        e1 = np.linalg.norm(out[:nb][sel] - true_v[sel], axis=1).mean()
        assert e1 < e0 * 0.5, (sel.sum(), e0, e1)
    # Stogas plokščias
    roof = (np.abs(true_v[:, 2] - 15) < 1e-6) & (np.abs(true_v[:, 0]) < 9) & (np.abs(true_v[:, 1]) < 9)
    assert np.abs(out[:nb][roof, 2] - 15).mean() < 0.03
    # Žemė nepaliesta
    assert np.allclose(out[nb:], ground.vertices, atol=1e-6)


def test_flatten_parked_cars_untouched(tmp_path):
    """Ilga automobilių eilė: tinkle ji „aptraukta“ ištisai (iš šono – 40 m × 1.5 m „siena“) – neturi būti
    ištiesinta ar suplokštinta (tai ne fasadas)."""
    rng = np.random.default_rng(5)
    row = trimesh.creation.box(extents=[40, 1.8, 1.5])
    row.apply_translation([0, 0, 0.75])
    V, F = trimesh.remesh.subdivide_to_size(row.vertices, row.faces, 0.25)
    row = trimesh.Trimesh(V, F, process=True)
    row.vertices = row.vertices + row.vertex_normals * rng.normal(0, 0.05, (len(row.vertices), 1))
    mesh = trimesh.util.concatenate([row, _ground(-30, 30, -15, 15)])
    p = str(tmp_path / "odm_mesh.ply")
    mesh.export(p, encoding="binary")
    atea_mesh.flatten_facades(p)
    out = np.asarray(trimesh.load(p, process=False, force="mesh").vertices)
    assert np.allclose(out, mesh.vertices, atol=1e-5)


def test_flatten_low_terrace_untouched(tmp_path):
    """Žema terasa / aikštelė už 5 m atraminės sienos (nelygi vieta) – ne stogas: jos paviršius nelyginamas."""
    rng = np.random.default_rng(11)
    ter = trimesh.creation.box(extents=[60, 40, 5])
    ter.apply_translation([0, 0, 2.5])
    ter.update_faces(ter.face_normals[:, 2] > -0.5)
    ter.remove_unreferenced_vertices()
    V, F = trimesh.remesh.subdivide_to_size(ter.vertices, ter.faces, 0.5)
    ter = trimesh.Trimesh(V, F, process=True)
    top = ter.vertices[:, 2] > 4.99
    ter.vertices[top, 2] += 0.15 * np.sin(ter.vertices[top, 0]) + rng.normal(0, 0.03, top.sum())  # aikštelės nelygumai
    mesh = trimesh.util.concatenate([ter, _ground(-50, 50, -40, 40)])
    p = str(tmp_path / "odm_mesh.ply")
    mesh.export(p, encoding="binary")
    atea_mesh.flatten_facades(p)
    out = np.asarray(trimesh.load(p, process=False, force="mesh").vertices)[: len(ter.vertices)]
    assert np.allclose(out[top, 2], ter.vertices[top, 2], atol=1e-5)


def test_flatten_small_mesh_untouched(tmp_path):
    m = trimesh.creation.box()
    p = str(tmp_path / "m.ply")
    m.export(p)
    assert atea_mesh.flatten_facades(p) == 0


def test_patch_groups_on_fake_odm(tmp_path):
    """patch.py ant netikro ODM medžio: visos grupės pritaikomos, antrą kartą – „jau pritaikyta“."""
    import re
    import subprocess

    src = open(os.path.join(HERE, "patch.py"), encoding="utf-8").read()
    ns = {"__name__": "x"}
    # Iš patch.py paimamos tik GROUPS (be failų skaitymo)
    head = src.split("\ntexts = {}")[0]
    exec(compile(head.replace("sys.argv[1] if len(sys.argv) > 1 else \"/code\"", repr(str(tmp_path))), "patch", "exec"), ns)
    for _, edits in ns["GROUPS"].values():
        for f, lst in edits.items():
            os.makedirs(os.path.dirname(f), exist_ok=True)
            with open(f, "a", encoding="utf-8") as fh:
                for a, _b in lst:
                    fh.write("# pradžia\n" + a + "# pabaiga\n")
    run = lambda: subprocess.run([sys.executable, os.path.join(HERE, "patch.py"), str(tmp_path)], capture_output=True, text=True, check=True).stdout
    out = run()
    assert len(re.findall(r": pritaikyta", out)) == len(ns["GROUPS"]), out
    out = run()
    assert len(re.findall(r"jau pritaikyta", out)) == len(ns["GROUPS"]), out


def _boundary_edges(F):
    E = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1)
    _, cnt = np.unique(E, axis=0, return_counts=True)
    return int((cnt == 1).sum())


def test_remove_floating(tmp_path):
    """Ore kabanti „laja“ ir smulkūs trupiniai pašalinami; ant žemės stovintis automobilis paliekamas."""
    ground = _ground(-20, 20, -20, 20)
    blob = trimesh.creation.icosphere(subdivisions=3, radius=2.0)
    blob.apply_translation([5, 5, 6])          # kabo ore (be kamieno)
    car = trimesh.creation.box(extents=[4.5, 1.8, 1.5])
    car.apply_translation([-5, -5, 0.8])       # atskiras, bet stovi ant žemės
    speck = trimesh.Trimesh([[0, 0, 3], [0.3, 0, 3], [0, 0.3, 3]], [[0, 1, 2]], process=False)
    mesh = trimesh.util.concatenate([ground, blob, car, speck])
    F, n, a = atea_mesh._remove_floating(np.asarray(mesh.vertices), np.asarray(mesh.faces), np.asarray(mesh.area_faces))
    assert n == 2
    assert len(F) == len(ground.faces) + len(car.faces)


def test_fill_holes():
    """Maža skylė (1×1 m) užpildoma; didelė (6×6 m) ir modelio išorinis kraštas – ne."""
    g = _ground(-20, 20, -20, 20)
    c = g.triangles_center
    small = (np.abs(c[:, 0] - 5) < 0.5) & (np.abs(c[:, 1] - 5) < 0.5)
    large = (np.abs(c[:, 0] + 8) < 3) & (np.abs(c[:, 1] + 8) < 3)
    g.update_faces(~(small | large))
    V, F = np.asarray(g.vertices), np.asarray(g.faces)
    b0 = _boundary_edges(F)
    V2, F2, n = atea_mesh._fill_holes(V, F)
    assert n == 1
    assert _boundary_edges(F2) == b0 - 8  # mažos skylės kontūras – 8 kraštinės (1 m / 0.5 m tinklelis)
    # orientacija: naujų sienelių normalės į tą pačią pusę kaip žemės
    m = trimesh.Trimesh(V2, F2, process=False)
    assert (m.face_normals[len(F):, 2] > 0.9).all()


def test_improve_mesh(tmp_path):
    """Visas žingsnis: pastatas su triukšmu + plaukiojantis gabalas + skylė stoge."""
    box = trimesh.creation.box(extents=[20, 20, 15])
    box.apply_translation([0, 0, 7.5])
    box.update_faces(box.face_normals[:, 2] > -0.5)
    box.remove_unreferenced_vertices()
    V, F = trimesh.remesh.subdivide_to_size(box.vertices, box.faces, 0.4)
    b = trimesh.Trimesh(V, F, process=True)
    c = b.triangles_center
    b.update_faces(~((np.abs(c[:, 2] - 15) < 1e-6) & (np.abs(c[:, 0] - 3) < 0.6) & (np.abs(c[:, 1] - 3) < 0.6)))
    b.remove_unreferenced_vertices()
    rng = np.random.default_rng(3)
    b.vertices = b.vertices + b.vertex_normals * rng.normal(0, 0.1, (len(b.vertices), 1))
    ground = _ground(-30, 30, -30, 30)
    ground.update_faces(~((np.abs(ground.triangles_center[:, 0]) < 10) & (np.abs(ground.triangles_center[:, 1]) < 10)))
    ground.remove_unreferenced_vertices()
    blob = trimesh.creation.icosphere(subdivisions=3, radius=1.5)
    blob.apply_translation([14, 0, 8])
    # pastatas sujungtas su žeme (kaip tikrame tinkle) – čia pakanka, kad būtų atskiras, bet stovintis ant žemės
    mesh = trimesh.util.concatenate([b, ground, blob])
    p = str(tmp_path / "odm_mesh.ply")
    mesh.export(p, encoding="binary")
    atea_mesh.improve_mesh(p)
    out = trimesh.load(p, process=False, force="mesh")
    assert len(out.faces) < len(mesh.faces) - len(blob.faces) + 200  # gabalas pašalintas (+ užpildas)
    assert not (np.linalg.norm(np.asarray(out.vertices) - [14, 0, 8], axis=1) < 1.6).any()
    assert _boundary_edges(np.asarray(out.faces)) < _boundary_edges(np.asarray(mesh.faces)) - len(blob.faces) * 0  # skylė užpildyta


def test_flatten_car_roofs_on_sloped_site(tmp_path):
    """Nelygi aikštelė: įdubime (−4 m) stovinčio pastato viršus (+0.5 m) – vos 1 m žemiau už automobilių stogus
    už 30 m. Automobilių stogai neturi būti palaikyti pastato stogu ir suplokštinti."""
    rng = np.random.default_rng(7)
    bld = trimesh.creation.box(extents=[20, 20, 4.5])
    bld.apply_translation([0, -30, -4 + 2.25])
    bld.update_faces(bld.face_normals[:, 2] > -0.5)
    bld.remove_unreferenced_vertices()
    V, F = trimesh.remesh.subdivide_to_size(bld.vertices, bld.faces, 0.4)
    bld = trimesh.Trimesh(V, F, process=True)
    bld.vertices = bld.vertices + bld.vertex_normals * rng.normal(0, 0.05, (len(bld.vertices), 1))
    cars = []
    for k in range(12):
        car = trimesh.creation.box(extents=[4.5, 1.8, 1.5])
        car.apply_translation([k * 2.2 - 12, 10, 0.75])
        V, F = trimesh.remesh.subdivide_to_size(car.vertices, car.faces, 0.25)
        car = trimesh.Trimesh(V, F, process=True)
        # suapvalintas stogas: vidurys aukščiau už kraštus
        top = car.vertices[:, 2] > 1.4
        car.vertices[top, 2] += 0.08 * (1 - ((car.vertices[top, 0] - (k * 2.2 - 12)) / 2.25) ** 2)
        cars.append(car)
    row = trimesh.util.concatenate(cars)
    mesh = trimesh.util.concatenate([bld, row, _ground(-30, 30, 0, 25)])
    p = str(tmp_path / "odm_mesh.ply")
    mesh.export(p, encoding="binary")
    atea_mesh.flatten_facades(p)
    out = np.asarray(trimesh.load(p, process=False, force="mesh").vertices)
    nb, nr = len(bld.vertices), len(row.vertices)
    assert np.allclose(out[nb:nb + nr], row.vertices, atol=1e-5)


def _box_walls(z0, z1, half=10.0, step=0.5):
    """Pastato sienos (be stogo ir be apačios) nuo z0 iki z1 – kaip stiklinis pirmas aukštas be taškų."""
    box = trimesh.creation.box(extents=[2 * half, 2 * half, z1 - z0])
    box.apply_translation([0, 0, (z0 + z1) / 2])
    box.update_faces(np.abs(box.face_normals[:, 2]) < 0.5)
    box.remove_unreferenced_vertices()
    V, F = trimesh.remesh.subdivide_to_size(box.vertices, box.faces, step)
    return trimesh.Trimesh(V, F, process=True)


def test_extend_facades_to_ground():
    """Stiklinis pirmas aukštas: sienos prasideda 4 m virš žemės – nuleidžiamos iki žemės, viršutinis kraštas ne."""
    walls = _box_walls(4.0, 15.0)
    ground = _ground(-30, 30, -30, 30)
    ground.update_faces(~((np.abs(ground.triangles_center[:, 0]) < 10) & (np.abs(ground.triangles_center[:, 1]) < 10)))
    ground.remove_unreferenced_vertices()
    mesh = trimesh.util.concatenate([walls, ground])
    V, F = np.asarray(mesh.vertices), np.asarray(mesh.faces)
    facades = []
    for n in ([1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]):
        n = np.array(n, float)
        u = np.cross([0, 0, 1.0], n)
        facades.append((n * 10.0 + [0, 0, 9.5], n, u, -10.0, 10.0))
    V2, F2, ne, h = atea_mesh._extend_facades(V, F, facades)
    assert ne > 0 and abs(h - 4.0) < 0.1
    new = trimesh.Trimesh(V2, F2[len(F):], process=False)
    # naujos sienelės – vertikalios, nuo 0 iki 4 m, atsuktos į tą pačią pusę kaip siena
    assert np.abs(new.face_normals[:, 2]).max() < 1e-6
    assert new.vertices[np.unique(new.faces)][:, 2].min() > -0.1
    assert new.vertices[np.unique(new.faces)][:, 2].max() < 4.0 + 1e-6
    c = new.triangles_center
    assert (np.einsum("ij,ij->i", new.face_normals, np.c_[c[:, :2], np.zeros(len(c))]) > 0).all()  # į išorę, kaip sienos
    # viršutinis sienų kraštas (15 m) nenuleistas – ten nėra sienos virš kraštinės
    assert not (V2[len(V):, 2] > 4.0 + 1e-6).any()


def test_extend_facades_fills_wall_hole():
    """Skylė sienoje (stiklo juosta 6–9 m): viršutinė dalis nuleidžiama tik iki apatinės dalies viršaus."""
    lower = _box_walls(0.0, 6.0)
    upper = _box_walls(9.0, 15.0)
    ground = _ground(-30, 30, -30, 30)
    ground.update_faces(~((np.abs(ground.triangles_center[:, 0]) < 10) & (np.abs(ground.triangles_center[:, 1]) < 10)))
    ground.remove_unreferenced_vertices()
    mesh = trimesh.util.concatenate([lower, upper, ground])
    V, F = np.asarray(mesh.vertices), np.asarray(mesh.faces)
    n = np.array([1.0, 0, 0])
    V2, F2, ne, h = atea_mesh._extend_facades(V, F, [(n * 10 + [0, 0, 7.5], n, np.cross([0, 0, 1.0], n), -10.0, 10.0)])
    assert ne > 0 and abs(h - 3.0) < 0.1
    assert V2[len(V):, 2].min() > 6.0 - 1e-6


def test_remove_floating_keeps_facade_fragment():
    """Atskira (tarpu nuo pastato) aukšta vertikali fasado dalis virš žemės – ne „plaukiojantis gabalas“."""
    ground = _ground(-30, 30, -30, 30)
    wall = _grid(-5, 5, 6, 14, 0.5, lambda x, z: 12.0)
    mesh = trimesh.util.concatenate([ground, wall])
    F, n, a = atea_mesh._remove_floating(np.asarray(mesh.vertices), np.asarray(mesh.faces), np.asarray(mesh.area_faces))
    assert n == 0 and len(F) == len(mesh.faces)


def test_remove_floating_keeps_detached_roof():
    """Stogas, atskirtas nuo sienų tarpu (stiklinis fasadas be taškų), paliekamas; ore kabantis gumulas – ne."""
    ground = _ground(-30, 30, -30, 30)
    roof = _ground(-6, 6, -6, 6)
    roof.apply_translation([0, 0, 25])           # 144 m², 25 m virš žemės, be sienų
    blob = trimesh.creation.icosphere(subdivisions=3, radius=2.0)
    blob.apply_translation([15, 15, 8])
    mesh = trimesh.util.concatenate([ground, roof, blob])
    F, n, a = atea_mesh._remove_floating(np.asarray(mesh.vertices), np.asarray(mesh.faces), np.asarray(mesh.area_faces))
    assert n == 1
    assert len(F) == len(ground.faces) + len(roof.faces)


def test_min_point_distance_free_space(tmp_path, monkeypatch):
    """Pakankamai RAM – laisvos erdvės palaikymas įjungiamas net kai taškai retinami (stiklo fasadams)."""
    tree = types.SimpleNamespace(openmvs=str(tmp_path), filtered_point_cloud=str(tmp_path / "x.ply"))
    monkeypatch.setattr(atea_mesh, "_ply_vertices", lambda p: 69_200_000)
    monkeypatch.setattr(atea_mesh, "_mem_available", lambda: 49.3e9)
    dist, low, fss = atea_mesh._min_point_distance(tree)
    assert fss and low and 3.0 < dist < 3.6
    monkeypatch.setattr(atea_mesh, "_mem_available", lambda: 16e9)
    assert atea_mesh._min_point_distance(tree)[2] is False


def _write_ply_points(path, X, C, N):
    dt = np.dtype([("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("nx", "<f4"), ("ny", "<f4"), ("nz", "<f4"),
                   ("red", "u1"), ("green", "u1"), ("blue", "u1"), ("views", "u1")])
    a = np.zeros(len(X), dtype=dt)
    for k, c in enumerate("xyz"):
        a[c] = X[:, k]
        a["n" + c] = N[:, k]
    for k, c in enumerate(("red", "green", "blue")):
        a[c] = C[:, k]
    head = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % len(X)
    head += "".join("property %s %s\n" % ("float" if t == "<f4" else "uchar", n) for n, (t, _) in
                    ((n, (dt[n].str.replace("|", ""), 0)) for n in dt.names))
    head += "end_header\n"
    with open(path, "wb") as f:
        f.write(head.encode())
        f.write(a.tobytes())


def test_fill_unseen_colors_from_point_cloud(tmp_path):
    am = atea_mesh
    # 10×10 m plokštuma: kairė pusė (x<5) – „nematyta“ (identiškos mažytės UV), dešinė – įprastos UV
    n = 10
    xs = np.arange(n + 1, dtype=float)
    V = np.array([[x, y, 0.0] for y in xs for x in xs])
    faces, unseen = [], []
    for j in range(n):
        for i in range(n):
            a, b, c, d = j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i
            for tri in ((a, b, c), (a, c, d)):
                faces.append(tri)
                unseen.append(i < 5)
    lines = ["mtllib m.mtl"] + ["v %f %f %f" % tuple(v) for v in V]
    vt, fl = [], ["usemtl material0000"]
    for k, (tri, u) in enumerate(zip(faces, unseen)):
        if u:
            uvs = [(0.5002, 0.5001), (0.5001, 0.5001), (0.5001, 0.5002)]
        else:
            uvs = [((k % 50) / 60.0, (k // 50) / 10.0 + 0.01 * q) for q in range(3)]
        base = len(vt)
        vt += uvs
        fl.append("f " + " ".join("%d/%d/1" % (tri[q] + 1, base + q + 1) for q in range(3)))
    lines += ["vt %f %f" % t for t in vt] + ["vn 0 0 1"] + fl
    obj = tmp_path / "odm_textured_model_geo.obj"
    obj.write_text("\n".join(lines) + "\n")
    (tmp_path / "m.mtl").write_text("newmtl material0000\nmap_Kd a.png\n")
    # Taškai: kairėje raudoni, dešinėje mėlyni; dar pilki taškai 3 m žemiau (normalė į šoną – mažas svoris)
    g = np.random.default_rng(0).uniform(0, 10, size=(20000, 2))
    X = np.c_[g, np.zeros(len(g))]
    C = np.where(g[:, :1] < 5, [[200, 20, 20]], [[20, 20, 200]])
    N = np.tile([0, 0, 1.0], (len(X), 1))
    _write_ply_points(str(tmp_path / "pc.ply"), X, C, N)
    m = am.fill_unseen(str(obj), str(tmp_path / "pc.ply"))
    assert m == sum(unseen)
    txt = obj.read_text().split("\n")
    assert "usemtl " + am.FILL_MTL in txt
    k = txt.index("usemtl " + am.FILL_MTL)
    new_faces = [l for l in txt[k + 1:] if l.startswith("f ")]
    assert len(new_faces) == m
    assert sum(1 for l in txt if l.startswith("f ")) == len(faces)
    nvt = sum(1 for l in txt if l.startswith("vt "))
    assert max(int(t.split("/")[1]) for l in new_faces for t in l.split()[1:]) == nvt
    mtl = (tmp_path / "m.mtl").read_text()
    assert "newmtl " + am.FILL_MTL in mtl
    png = mtl.strip().split("\n")[-1].split()[1]
    try:
        from PIL import Image
        img = np.asarray(Image.open(tmp_path / png).convert("RGB"))
    except ImportError:
        cv2 = pytest.importorskip("cv2")
        img = cv2.imread(str(tmp_path / png))[:, :, ::-1]
    # Nudažyta raudonai (kairės pusės taškai), ne mėlynai ar pilkai
    used = img.reshape(-1, 3)
    red = (used[:, 0] > 150) & (used[:, 2] < 80)
    assert red.mean() > 0.9
