# Tekstūravimo dalys be GPU: spalvų nuoseklumo patikra (judantys objektai) ir ekspozicijos išlyginimas.
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import texturing  # noqa: E402

T = texturing.TOP


def _cands(cams, scores, colors):
    c = np.full((len(cams), T), -1, np.int32)
    s = np.zeros((len(cams), T), np.float32)
    col = np.full((len(cams), T, 3), np.nan, np.float32)
    for i, (cc, ss, cl) in enumerate(zip(cams, scores, colors)):
        c[i, :len(cc)] = cc
        s[i, :len(ss)] = ss
        col[i, :len(cl)] = cl
    return c, s, col


def test_moving_car_view_rejected():
    """Kelią mato 4 nuotraukos, vienoje (su didžiausiu balu) – pravažiuojantis raudonas automobilis: ji atmetama."""
    gray, red = [110, 112, 108], [230, 20, 25]
    c, s, col = _cands([[7, 2, 3, 4]], [[9.0, 5.0, 4.0, 3.0]], [[red, gray, gray, gray]])
    c2, s2 = texturing.photo_consistency(c, s, col, log=lambda m: None)
    assert c2[0, 0] == 2 and 7 not in c2[0]
    assert np.allclose(col[0, 0], gray)  # spalvos perrikiuotos kartu su kandidatais


def test_two_views_kept_and_all_bad_keeps_one():
    gray, red = [110, 112, 108], [230, 20, 25]
    # Tik 2 nuotraukos – daugumos nėra, nieko neatmetama
    c, s, col = _cands([[1, 2]], [[2.0, 1.0]], [[red, gray]])
    c2, _ = texturing.photo_consistency(c, s, col, log=lambda m: None)
    assert list(c2[0, :2]) == [1, 2]
    # Visos skirtingos – lieka bent viena
    c, s, col = _cands([[1, 2, 3]], [[3.0, 2.0, 1.0]], [[red, gray, [20, 200, 30]]])
    c2, _ = texturing.photo_consistency(c, s, col, log=lambda m: None)
    assert (c2[0] >= 0).sum() >= 1


def test_exposure_gains_recover_brighter_camera():
    """Nuotrauka 1 – 20 % šviesesnė: jos koeficientas ~0,83 kitų atžvilgiu."""
    rng = np.random.default_rng(0)
    n = 2000
    base = rng.uniform(40, 200, (n, 3)).astype(np.float32)
    cams = [{}, {}, {}]
    c = np.full((n, T), -1, np.int32)
    col = np.full((n, T, 3), np.nan, np.float32)
    for i in range(n):
        a, b = rng.choice(3, 2, replace=False)
        c[i, :2] = [a, b]
        col[i, 0] = base[i] * (1.2 if a == 1 else 1.0)
        col[i, 1] = base[i] * (1.2 if b == 1 else 1.0)
    g = texturing.exposure_gains(cams, c, col, log=lambda m: None)
    ratio = g[1] / g[[0, 2]].mean(0)
    assert np.all(np.abs(ratio - 1 / 1.2) < 0.03), ratio


def test_facade_labels_greedy_cover():
    """Sienos trikampiai: kamera 3 – geriausia daugumai, kamera 7 – likusiems; kiti trikampiai neliečiami."""
    import numpy as np
    import texturing
    V = np.array([[0, y, z] for y in range(0, 41) for z in range(0, 21)], float)
    idx = lambda y, z: y * 21 + z
    F = np.array([[idx(y, z), idx(y + 1, z), idx(y, z + 1)] for y in range(40) for z in range(20)])
    nF = len(F)
    best_c = np.full((nF, 3), -1, np.int32)
    best_s = np.zeros((nF, 3), np.float32)
    best_c[:, 0], best_s[:, 0] = 5, 1.0          # visiems geriausia pavieniui – vis kita (5)
    best_c[:600, 1], best_s[:600, 1] = 3, 0.9    # 3 – dauguma
    best_c[600:, 1], best_s[600:, 1] = 7, 0.9    # 7 – likusieji
    best_c[:, 0] = np.arange(nF) % 50 + 10       # „mozaika“
    labels = best_c[:, 0].copy()
    Q = V
    out = texturing.facade_labels(labels, best_c, best_s, V, F, [(np.array([1.0, 0, 0]), 0.0, Q)], log=lambda m: None)
    assert (out[:600] == 3).all() and (out[600:] == 7).all()
