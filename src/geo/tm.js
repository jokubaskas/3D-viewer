// Skersinė Merkatoriaus projekcija (Krüger serija, 6-oji eilė, Karney 2011) – milimetrinis tikslumas.
// LKS-94 (EPSG:3346): GRS80, λ0 = 24°, k0 = 0,9998, FE = 500 000, FN = 0.
// UTM (WGS84): λ0 = 6·zona − 183°, k0 = 0,9996, FE = 500 000.

const D2R = Math.PI / 180;

function makeTM({ a, f, lon0, k0, fe, fn }) {
  const n = f / (2 - f);
  const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
  const A = (a / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  const alpha = [
    n / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180 - (127 * n5) / 288 + (7891 * n6) / 37800,
    (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440 + (281 * n5) / 630 - (1983433 * n6) / 1935360,
    (61 * n3) / 240 - (103 * n4) / 140 + (15061 * n5) / 26880 + (167603 * n6) / 181440,
    (49561 * n4) / 161280 - (179 * n5) / 168 + (6601661 * n6) / 7257600,
    (34729 * n5) / 80640 - (3418889 * n6) / 1995840,
    (212378941 * n6) / 319334400,
  ];
  const beta = [
    n / 2 - (2 * n2) / 3 + (37 * n3) / 96 - n4 / 360 - (81 * n5) / 512 + (96199 * n6) / 604800,
    n2 / 48 + n3 / 15 - (437 * n4) / 1440 + (46 * n5) / 105 - (1118711 * n6) / 3870720,
    (17 * n3) / 480 - (37 * n4) / 840 - (209 * n5) / 4480 + (5569 * n6) / 90720,
    (4397 * n4) / 161280 - (11 * n5) / 504 - (830251 * n6) / 7257600,
    (4583 * n5) / 161280 - (108847 * n6) / 3991680,
    (20648693 * n6) / 638668800,
  ];
  const e = Math.sqrt(f * (2 - f));
  const e2 = e * e;
  const kA = k0 * A;

  /** Geodezinės (laipsniais) -> [E, N] */
  function forward(lon, lat) {
    const phi = lat * D2R, lam = (lon - lon0) * D2R;
    const sphi = Math.sin(phi);
    const t = Math.sinh(Math.atanh(sphi) - e * Math.atanh(e * sphi));
    const xiP = Math.atan2(t, Math.cos(lam));
    const etaP = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
    let xi = xiP, eta = etaP;
    for (let j = 1; j <= 6; j++) {
      xi += alpha[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
      eta += alpha[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
    }
    return [fe + kA * eta, fn + kA * xi];
  }

  /** [E, N] -> geodezinės (laipsniais) [lon, lat] */
  function inverse(E, N) {
    const xi = (N - fn) / kA, eta = (E - fe) / kA;
    let xiP = xi, etaP = eta;
    for (let j = 1; j <= 6; j++) {
      xiP -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
      etaP -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    }
    const sinhEta = Math.sinh(etaP);
    const sinXi = Math.sin(xiP), cosXi = Math.cos(xiP);
    const tauP = sinXi / Math.sqrt(sinhEta * sinhEta + cosXi * cosXi);
    // Konforminė -> geodezinė platuma (Niutono metodas)
    let tau = tauP;
    for (let i = 0; i < 6; i++) {
      const s = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
      const tauI = tau * Math.sqrt(1 + s * s) - s * Math.sqrt(1 + tau * tau);
      const d = ((tauP - tauI) / Math.sqrt(1 + tauI * tauI)) * ((1 + (1 - e2) * tau * tau) / ((1 - e2) * Math.sqrt(1 + tau * tau)));
      tau += d;
      if (Math.abs(d) < 1e-14) break;
    }
    const lat = Math.atan(tau) / D2R;
    const lon = lon0 + Math.atan2(sinhEta, cosXi) / D2R;
    return [lon, lat];
  }

  return { forward, inverse };
}

const GRS80 = { a: 6378137, f: 1 / 298.257222101 };
const WGS84 = { a: 6378137, f: 1 / 298.257223563 };

/** LKS-94 (EPSG:3346). Grąžina [E, N] – t. y. geodeziniu žymėjimu [Y, X]. */
export const LKS94 = makeTM({ ...GRS80, lon0: 24, k0: 0.9998, fe: 500000, fn: 0 });

const utmCache = new Map();
export function UTM(zone) {
  if (!utmCache.has(zone)) utmCache.set(zone, makeTM({ ...WGS84, lon0: zone * 6 - 183, k0: 0.9996, fe: 500000, fn: 0 }));
  return utmCache.get(zone);
}

export function utmZoneOf(lon) {
  return (Math.floor((lon + 180) / 6) % 60) + 1;
}

/** UTM (šiaurės pusrutulis) -> LKS-94 [E, N]. ETRS89 ≈ WGS84 laikomi ta pačia sistema (RTK per LitPOS). */
export function utmToLks(zone, E, N) {
  const [lon, lat] = UTM(zone).inverse(E, N);
  return LKS94.forward(lon, lat);
}

/**
 * Greita transformacija daugeliui taškų: kvadratinis polinomas, pritaikytas pagal tikslius
 * taškus srities tinklelyje. Grąžina funkciją (E, N) -> [E', N'] ir didžiausią paklaidą metrais.
 */
export function fitFastTransform(exact, minE, minN, maxE, maxN, grid = 9) {
  const cx = (minE + maxE) / 2, cy = (minN + maxN) / 2;
  const sx = Math.max((maxE - minE) / 2, 1), sy = Math.max((maxN - minN) / 2, 1);
  const rows = [], bx = [], by = [];
  const terms = (u, v) => [1, u, v, u * u, u * v, v * v, u * u * u, u * u * v, u * v * v, v * v * v];
  for (let i = 0; i < grid; i++)
    for (let j = 0; j < grid; j++) {
      const E = minE + ((maxE - minE) * i) / (grid - 1), N = minN + ((maxN - minN) * j) / (grid - 1);
      const [e2, n2] = exact(E, N);
      rows.push(terms((E - cx) / sx, (N - cy) / sy));
      bx.push(e2 - E);
      by.push(n2 - N);
    }
  const cxCoef = leastSquares(rows, bx), cyCoef = leastSquares(rows, by);
  const fn = (E, N) => {
    const t = terms((E - cx) / sx, (N - cy) / sy);
    let dx = 0, dy = 0;
    for (let k = 0; k < t.length; k++) {
      dx += cxCoef[k] * t[k];
      dy += cyCoef[k] * t[k];
    }
    return [E + dx, N + dy];
  };
  // Patikrinimas tarpiniuose taškuose
  let maxErr = 0;
  for (let i = 0; i < grid - 1; i++)
    for (let j = 0; j < grid - 1; j++) {
      const E = minE + ((maxE - minE) * (i + 0.5)) / (grid - 1), N = minN + ((maxN - minN) * (j + 0.5)) / (grid - 1);
      const a = exact(E, N), b = fn(E, N);
      maxErr = Math.max(maxErr, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
  return { fn, maxErr };
}

function leastSquares(A, b) {
  const m = A[0].length;
  const M = Array.from({ length: m }, () => new Float64Array(m + 1));
  for (let r = 0; r < A.length; r++)
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) M[i][j] += A[r][i] * A[r][j];
      M[i][m] += A[r][i] * b[r];
    }
  for (let i = 0; i < m; i++) {
    let p = i;
    for (let k = i + 1; k < m; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]];
    const d = M[i][i] || 1e-30;
    for (let k = i + 1; k < m; k++) {
      const f = M[k][i] / d;
      for (let j = i; j <= m; j++) M[k][j] -= f * M[i][j];
    }
  }
  const x = new Float64Array(m);
  for (let i = m - 1; i >= 0; i--) {
    let s = M[i][m];
    for (let j = i + 1; j < m; j++) s -= M[i][j] * x[j];
    x[i] = s / (M[i][i] || 1e-30);
  }
  return x;
}
