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
