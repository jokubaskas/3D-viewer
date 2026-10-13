// Geometriniai skaičiavimai matavimams. Visi taškai – pasaulio koordinatėmis (Y aukštyn).
import * as THREE from 'three';

export const horiz = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

export function polylineLength(pts, closed = false) {
  let l = 0, h = 0;
  const n = pts.length;
  for (let i = 0; i < n - 1 + (closed ? 1 : 0); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    l += a.distanceTo(b);
    h += horiz(a, b);
  }
  return { length: l, horizontal: h };
}

/** Horizontalus (projekcijos) plotas – „Gauso“ formulė XZ plokštumoje. */
export function polygonAreaXZ(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a.x * b.z - b.x * a.z;
  }
  return Math.abs(s) / 2;
}

/** Erdvinio daugiakampio plotas (Newell metodas) ir normalė. */
export function polygonArea3D(pts) {
  const n = new THREE.Vector3();
  for (let i = 0, len = pts.length; i < len; i++) {
    const a = pts[i], b = pts[(i + 1) % len];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  const area = n.length() / 2;
  return { area, normal: area > 0 ? n.normalize() : new THREE.Vector3(0, 1, 0) };
}

export function centroid(pts) {
  const c = new THREE.Vector3();
  pts.forEach((p) => c.add(p));
  return c.divideScalar(Math.max(1, pts.length));
}

/** Taškas daugiakampyje (XZ). */
export function pointInPolygonXZ(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Mažiausių kvadratų plokštuma y = a·x + b·z + c. */
export function fitPlaneY(pts) {
  const c = centroid(pts);
  let sxx = 0, sxz = 0, szz = 0, sxy = 0, szy = 0;
  for (const p of pts) {
    const x = p.x - c.x, z = p.z - c.z, y = p.y - c.y;
    sxx += x * x; sxz += x * z; szz += z * z; sxy += x * y; szy += z * y;
  }
  const det = sxx * szz - sxz * sxz;
  let a = 0, b = 0;
  if (Math.abs(det) > 1e-12) {
    a = (sxy * szz - szy * sxz) / det;
    b = (szy * sxx - sxy * sxz) / det;
  }
  const fn = (x, z) => c.y + a * (x - c.x) + b * (z - c.z);
  const normal = new THREE.Vector3(-a, 1, -b).normalize();
  let rms = 0;
  for (const p of pts) rms += (p.y - fn(p.x, p.z)) ** 2;
  rms = Math.sqrt(rms / Math.max(1, pts.length));
  return { fn, normal, rms, slopeDeg: THREE.MathUtils.radToDeg(Math.acos(Math.min(1, normal.y))) };
}

/** Bendro pavidalo plokštuma (PCA) – išlyginimui. */
export function fitPlaneNormal(pts) {
  if (pts.length === 3) {
    const n = new THREE.Vector3().subVectors(pts[1], pts[0]).cross(new THREE.Vector3().subVectors(pts[2], pts[0])).normalize();
    return n.y < 0 ? n.negate() : n;
  }
  return fitPlaneY(pts).normal;
}

/** Kampas tarp BA ir BC (radianais). */
export function angleAt(a, b, c) {
  const u = new THREE.Vector3().subVectors(a, b), v = new THREE.Vector3().subVectors(c, b);
  return u.angleTo(v);
}

/** Daugiakampio trianguliacija (indeksai), projektuojant į geriausiai tinkančią plokštumą. */
export function triangulate(pts) {
  if (pts.length < 3) return [];
  const { normal } = polygonArea3D(pts);
  const helper = Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(helper, normal).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u);
  const contour = pts.map((p) => new THREE.Vector2(p.dot(u), p.dot(v)));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  return tris.flat();
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Paviršiaus aukščių tinklelis daugiakampio viduje.
 * Grąžina tinklelio mazgų aukščius (NaN – nėra paviršiaus).
 */
export async function sampleGrid(viewer, poly, resolution, onProgress, signal) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const ext = Math.max(maxX - minX, maxZ - minZ, 1e-9);
  const cell = ext / resolution;
  const nx = Math.max(2, Math.ceil((maxX - minX) / cell) + 1);
  const nz = Math.max(2, Math.ceil((maxZ - minZ) / cell) + 1);
  const H = new Float32Array(nx * nz).fill(NaN);
  const inside = new Uint8Array(nx * nz);
  let t0 = performance.now();
  for (let j = 0; j < nz; j++) {
    const z = minZ + j * cell;
    for (let i = 0; i < nx; i++) {
      const x = minX + i * cell;
      // Mazgus imame su nedidele parašte aplink daugiakampį, kad būtų pilni kraštiniai langeliai
      const k = j * nx + i;
      inside[k] = pointInPolygonXZ(x, z, poly) ? 1 : 0;
      if (inside[k] || nearPolygon(x, z, poly, cell * 1.5)) H[k] = viewer.topHeightAt(x, z);
    }
    if (performance.now() - t0 > 30) {
      if (signal?.aborted) throw new DOMException('Atšaukta', 'AbortError');
      onProgress?.(j / nz);
      await tick();
      t0 = performance.now();
    }
  }
  return { H, inside, nx, nz, cell, minX, minZ };
}

function nearPolygon(x, z, poly, d) {
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const dx = b.x - a.x, dz = b.z - a.z;
    const l2 = dx * dx + dz * dz || 1e-12;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(a.x + t * dx - x, a.z + t * dz - z) < d) return true;
  }
  return false;
}

/** Paviršiaus (pagal reljefą) plotas daugiakampio viduje. */
export function surfaceAreaFromGrid(g, poly) {
  const { H, nx, nz, cell, minX, minZ } = g;
  let area = 0, flat = 0, covered = 0, total = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
  const tri = (p, q, r) => new THREE.Vector3().subVectors(q, p).cross(new THREE.Vector3().subVectors(r, p)).length() / 2;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const cx = minX + (i + 0.5) * cell, cz = minZ + (j + 0.5) * cell;
      if (!pointInPolygonXZ(cx, cz, poly)) continue;
      total++;
      const h00 = H[j * nx + i], h10 = H[j * nx + i + 1], h01 = H[(j + 1) * nx + i], h11 = H[(j + 1) * nx + i + 1];
      if (isNaN(h00) || isNaN(h10) || isNaN(h01) || isNaN(h11)) continue;
      covered++;
      a.set(cx - cell / 2, h00, cz - cell / 2);
      b.set(cx + cell / 2, h10, cz - cell / 2);
      c.set(cx - cell / 2, h01, cz + cell / 2);
      d.set(cx + cell / 2, h11, cz + cell / 2);
      area += tri(a, b, d) + tri(a, d, c);
      flat += cell * cell;
    }
  }
  // Ratio leidžia pakoreguoti pagal tikslų horizontalų plotą
  return { ratio: flat > 0 ? area / flat : 1, coverage: total ? covered / total : 0 };
}

/**
 * Tūris tarp paviršiaus ir pagrindo.
 * @param {(x:number,z:number)=>number} baseFn - pagrindo aukštis
 */
export function volumeFromGrid(g, poly, baseFn) {
  const { H, nx, nz, cell, minX, minZ } = g;
  const A = cell * cell;
  let fill = 0, cut = 0, covered = 0, total = 0, maxUp = 0, maxDown = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const cx = minX + (i + 0.5) * cell, cz = minZ + (j + 0.5) * cell;
      if (!pointInPolygonXZ(cx, cz, poly)) continue;
      total++;
      const hs = [H[j * nx + i], H[j * nx + i + 1], H[(j + 1) * nx + i], H[(j + 1) * nx + i + 1]].filter((h) => !isNaN(h));
      if (hs.length < 2) continue;
      covered++;
      const h = hs.reduce((s, v) => s + v, 0) / hs.length;
      const dz = h - baseFn(cx, cz);
      if (dz > 0) fill += dz * A;
      else cut += -dz * A;
      if (dz > maxUp) maxUp = dz;
      if (-dz > maxDown) maxDown = -dz;
    }
  }
  const coverage = total ? covered / total : 0;
  // Nepadengtus langelius kompensuojame proporcingai
  const k = coverage > 0 ? 1 / coverage : 1;
  return { fill: fill * k, cut: cut * k, net: (fill - cut) * k, coverage, maxUp, maxDown, cells: total };
}

/** Aukščio profilis palei polilinija. */
export function sampleProfile(viewer, pts, samples = 400) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = horiz(pts[i], pts[i + 1]);
    segs.push({ a: pts[i], b: pts[i + 1], l, start: total });
    total += l;
  }
  const out = [];
  for (let s = 0; s <= samples; s++) {
    const d = (s / samples) * total;
    const seg = segs.find((g) => d <= g.start + g.l + 1e-9) || segs[segs.length - 1];
    const t = seg.l > 0 ? (d - seg.start) / seg.l : 0;
    const x = seg.a.x + (seg.b.x - seg.a.x) * t;
    const z = seg.a.z + (seg.b.z - seg.a.z) * t;
    out.push({ d, x, z, y: viewer.topHeightAt(x, z) });
  }
  return { samples: out, length: total };
}
