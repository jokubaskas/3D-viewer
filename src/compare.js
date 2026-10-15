// Dviejų datų palyginimas: antras modelis (kita data) toje pačioje vietoje, aukščių skirtumų
// žemėlapis ir pridėto / pašalinto tūrio skaičiavimas.
import * as THREE from 'three';
import { buildPointGrid, pointGridHeight } from './viewer.js';
import { pointInPolygonXZ } from './compute.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

export class CompareModel {
  /** @param {import('./viewer.js').Viewer} viewer */
  constructor(viewer) {
    this.viewer = viewer;
    this.root = new THREE.Group();
    this.root.name = 'compare';
    viewer.modelRoot.add(this.root);
    this.object = null;
    this.meshes = [];
    this.pointClouds = [];
    this.box = new THREE.Box3();
    this._grid = null;
    this._ray = new THREE.Raycaster();
    this._ray.firstHitOnly = true;
    viewer.addEventListener('orientation', () => this._updateBox());
  }

  get loaded() {
    return !!this.object;
  }

  /**
   * Įdeda modelį pagal jo originalias koordinates (tas pačias kaip pagrindinio modelio).
   * @param {{object:THREE.Object3D, originOffset:THREE.Vector3}} res – loadModelFiles rezultatas
   */
  async set(res, name, onStatus) {
    this.clear();
    const v = this.viewer;
    this.name = name;
    this.crs = res.crs || null;
    this.object = res.object;
    // Pagrindinio modelio lokalios koordinatės = originalios − viewer.center
    this.root.position.copy(res.originOffset || new THREE.Vector3()).sub(v.center);
    this.root.add(res.object);
    const toIndex = [];
    res.object.traverse((o) => {
      if (o.isMesh) {
        this.meshes.push(o);
        o.userData.origMaterial = o.material;
        o.material = Array.isArray(o.material) ? o.material.map((m) => v._basicFrom(m)) : v._basicFrom(o.material);
        toIndex.push(o.geometry);
      } else if (o.isPoints) {
        this.pointClouds.push(o);
        if (o.material.isPointsMaterial) {
          o.material.size = v.pointSize;
          o.material.sizeAttenuation = false;
        }
      }
    });
    for (let i = 0; i < toIndex.length; i++) {
      onStatus?.(i, toIndex.length);
      await tick();
      toIndex[i].computeBoundsTree({ maxLeafTris: 10 });
    }
    this._updateBox();
    v.requestRender();
  }

  clear() {
    if (this.object) {
      this.root.remove(this.object);
      this.object.traverse((o) => {
        o.geometry?.disposeBoundsTree?.();
        o.geometry?.dispose();
        [].concat(o.userData.origMaterial || o.material || []).forEach((m) => {
          m?.map?.dispose();
          m?.dispose?.();
        });
      });
    }
    this.object = null;
    this.meshes = [];
    this.pointClouds = [];
    this._grid = null;
    this.box.makeEmpty();
    this.viewer.requestRender();
  }

  set visible(on) {
    this.root.visible = on;
    this.viewer.requestRender();
  }
  get visible() {
    return this.root.visible;
  }

  _updateBox() {
    this._grid = null;
    this.box.makeEmpty();
    if (this.object) {
      this.root.updateMatrixWorld(true);
      this.box.setFromObject(this.root, false);
    }
  }

  /** Palyginimo modelio viršutinio paviršiaus aukštis (pasaulio Y) arba NaN. */
  heightAt(x, z) {
    if (this.meshes.length) {
      const b = this.box;
      this._ray.set(new THREE.Vector3(x, b.max.y + (b.max.y - b.min.y + 1) * 0.1, z), new THREE.Vector3(0, -1, 0));
      const h = this._ray.intersectObjects(this.meshes, false)[0];
      return h ? h.point.y : NaN;
    }
    if (this.pointClouds.length) {
      if (!this._grid) this._grid = buildPointGrid(this.pointClouds, this.box);
      return pointGridHeight(this._grid, x, z);
    }
    return NaN;
  }
}

/**
 * Aukščių skirtumai tarp dviejų paviršių tinklelyje.
 * @param {(x:number,z:number)=>number} oldAt – ankstesnio paviršiaus aukštis
 * @param {(x:number,z:number)=>number} newAt – vėlesnio paviršiaus aukštis
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} bounds – pasaulio koordinatėmis
 * @param {{cell:number, poly?:THREE.Vector3[]|null, threshold:number, onProgress?:(p:number)=>void, signal?:AbortSignal}} o
 */
export async function analyzeChange(oldAt, newAt, bounds, { cell, poly = null, threshold = 0.05, onProgress, signal }) {
  const { minX, minZ } = bounds;
  const nx = Math.max(2, Math.ceil((bounds.maxX - minX) / cell) + 1);
  const nz = Math.max(2, Math.ceil((bounds.maxZ - minZ) / cell) + 1);
  // Hn – aukštesnis iš dviejų paviršių (ant jo piešiamas pokyčių sluoksnis, kad būtų matomas)
  const Hn = new Float32Array(nx * nz).fill(NaN);
  const D = new Float32Array(nx * nz).fill(NaN);
  let t0 = performance.now();
  for (let j = 0; j < nz; j++) {
    const z = minZ + j * cell;
    for (let i = 0; i < nx; i++) {
      const x = minX + i * cell;
      if (poly && !pointInPolygonXZ(x, z, poly)) continue;
      const hn = newAt(x, z);
      if (isNaN(hn)) continue;
      const ho = oldAt(x, z);
      if (isNaN(ho)) continue;
      Hn[j * nx + i] = Math.max(hn, ho);
      D[j * nx + i] = hn - ho;
    }
    if (performance.now() - t0 > 30) {
      if (signal?.aborted) throw new DOMException('Atšaukta', 'AbortError');
      onProgress?.(j / nz);
      await tick();
      t0 = performance.now();
    }
  }

  // Tūriai – langelių centrai (keturių mazgų vidurkis), triukšmas iki slenksčio neskaičiuojamas
  const A = cell * cell;
  let fill = 0, cut = 0, fillArea = 0, cutArea = 0, area = 0, maxUp = 0, maxDown = 0, sum = 0;
  const abs = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i;
      const ds = [D[k], D[k + 1], D[k + nx], D[k + nx + 1]].filter((d) => !isNaN(d));
      if (ds.length < 3) continue;
      const d = ds.reduce((s, x) => s + x, 0) / ds.length;
      area += A;
      sum += d * A;
      if (Math.abs(d) >= threshold) abs.push(Math.abs(d));
      if (d > maxUp) maxUp = d;
      if (-d > maxDown) maxDown = -d;
      if (d >= threshold) {
        fill += d * A;
        fillArea += A;
      } else if (d <= -threshold) {
        cut += -d * A;
        cutArea += A;
      }
    }
  }
  abs.sort((a, b) => a - b);
  // Spalvų skalės riba – 95 % pakitusių langelių pokyčio
  const p95 = abs.length ? abs[Math.floor(abs.length * 0.95)] : 0;
  return {
    grid: { Hn, D, nx, nz, cell, minX, minZ },
    fill, cut, net: fill - cut, fillArea, cutArea, area,
    maxUp, maxDown, meanChange: area ? sum / area : 0, p95, threshold,
  };
}

/** Spalva pagal aukščio pokytį: mėlyna – pašalinta, raudona – pridėta. */
export function changeColor(d, range, threshold) {
  const a = Math.abs(d);
  if (a < threshold) return null;
  const t = Math.min(1, (a - threshold) / Math.max(1e-6, range - threshold));
  // Nuo šviesios iki sodrios spalvos
  return d > 0 ? [0.98 - 0.14 * t, 0.75 - 0.6 * t, 0.42 - 0.3 * t] : [0.55 - 0.45 * t, 0.78 - 0.45 * t, 0.98 - 0.12 * t];
}

/** Skirtumų sluoksnis: tinklelis ant vėlesnio paviršiaus su spalvomis pagal pokytį. */
export function buildChangeMesh(res, lift) {
  const { Hn, D, nx, nz, cell, minX, minZ } = res.grid;
  const range = Math.max(res.p95, res.threshold * 2);
  const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 4);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      pos.set([minX + i * cell, isNaN(Hn[k]) ? 0 : Hn[k] + lift, minZ + j * cell], k * 3);
      const c = isNaN(D[k]) ? null : changeColor(D[k], range, res.threshold);
      col.set(c ? [...c, 0.82] : [1, 1, 1, 0], k * 4);
    }
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      if (isNaN(D[a]) || isNaN(D[b]) || isNaN(D[c]) || isNaN(D[d])) continue;
      // Visiškai permatomų langelių nepiešiame
      if (col[a * 4 + 3] + col[b * 4 + 3] + col[c * 4 + 3] + col[d * 4 + 3] === 0) continue;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 5;
  mesh.raycast = () => {};
  mesh.userData.range = range;
  return mesh;
}
