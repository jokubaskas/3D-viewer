// Žemėlapis po modeliu (palydovinė nuotrauka / OpenStreetMap) – tiksliai pagal koordinates.
// Kiekviena XYZ (Web Mercator) plytelė perskaičiuojama į modelio sistemą (LKS-94 arba UTM):
// plytelės tinklelio viršūnės -> lon/lat -> E/N -> modelio lokalios koordinatės. Todėl žemėlapis
// sutampa su modeliu ir už LKS-94 / UTM zonos centro (meridianų konvergencija įskaityta).
import * as THREE from 'three';
import { LKS94, UTM } from './tm.js';

export const BASEMAPS = {
  satellite: {
    name: 'Palydovinė nuotrauka (Esri)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    attribution: '© Esri, Maxar, Earthstar Geographics',
  },
  osm: {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  },
};

const SEG = 8; // plytelės tinklelio dalijimas (kreivumui ir pasukimui)
const MAX_INNER = 64; // plytelių po modeliu
const MAX_OUTER = 48; // plytelių aplinkai

// Web Mercator
const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/** Modelio koordinačių sistemos projekcija arba null, jei modelis negeoreferencuotas. */
export function projectionOf(crs) {
  if (!crs) return null;
  if (crs.id === 'LKS94') return LKS94;
  const m = /^UTM(\d+)$/.exec(crs.id || '');
  return m ? UTM(+m[1]) : null;
}

export class Basemap {
  /** @param {import('../viewer.js').Viewer} viewer */
  constructor(viewer) {
    this.viewer = viewer;
    this.group = new THREE.Group();
    this.group.name = 'basemap';
    this.group.renderOrder = -1;
    this.group.visible = false;
    viewer.modelRoot.add(this.group);
    this.opacity = 1;
    this.source = null;
    this._gen = 0;
    this._loader = new THREE.TextureLoader();
    this._loader.setCrossOrigin('anonymous');
  }

  get visible() {
    return this.group.visible;
  }

  /** Ar galima rodyti žemėlapį (modelis georeferencuotas ir Z – aukštyn). */
  get reason() {
    const v = this.viewer;
    if (!v.hasModel) return 'Pirmiausia atidarykite modelį';
    if (!projectionOf(v.crs)) return 'Modelis neturi koordinačių sistemos (LKS-94 arba UTM) – žemėlapio negalima sulygiuoti.';
    if (v.upAxis !== 'z') return 'Žemėlapiui reikia, kad modelio aukščio ašis būtų Z (Orientacija).';
    return '';
  }

  clear() {
    this._gen++;
    for (const m of [...this.group.children]) {
      m.geometry.dispose();
      m.material.map?.dispose();
      m.material.dispose();
    }
    this.group.clear();
    this.viewer.requestRender();
  }

  hide() {
    this.group.visible = false;
    this.viewer.requestRender();
  }

  setOpacity(a) {
    this.opacity = a;
    for (const m of this.group.children) {
      m.material.opacity = a;
      m.material.transparent = a < 1;
      m.material.depthWrite = a >= 1;
    }
    this.viewer.requestRender();
  }

  /** Pataisa pagal kontrolinius taškus keičia modelio koordinates – žemėlapis paslenkamas atgal. */
  syncDatum() {
    const d = this.viewer.datumShift;
    this.group.position.set(-d.x, -d.y, 0);
  }

  /**
   * Sukuria ir parodo žemėlapį.
   * @param {{url:string, maxZoom?:number}} source
   * @param {(done:number,total:number)=>void} [onProgress]
   */
  async show(source, onProgress) {
    const v = this.viewer;
    if (this.reason) throw new Error(this.reason);
    this.clear();
    const gen = this._gen;
    this.source = source;
    const proj = projectionOf(v.crs);
    const c = v.center;
    this.syncDatum();

    // Modelio ribos lokaliomis (modelRoot) koordinatėmis
    const lb = new THREE.Box3();
    const inv = new THREE.Matrix4().copy(v.modelRoot.matrixWorld).invert();
    v.content.updateMatrixWorld(true);
    v.content.traverse((o) => {
      if (!(o.isMesh || o.isPoints)) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      lb.union(o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)));
    });
    const size = lb.getSize(new THREE.Vector3());
    const ext = Math.max(size.x, size.y, 20);
    // Žemėlapis – šiek tiek žemiau žemiausio modelio taško, kad nepersidengtų su paviršiumi
    const gap = Math.max(0.05, ext * 0.0005);
    const baseZ = lb.min.z - gap;

    // Lokalios -> lon/lat ir atgal (vertinant originalias koordinates be pataisos; pataisą taiko group.position)
    const toLonLat = (x, y) => proj.inverse(x + c.x, y + c.y);
    const toLocal = (lon, lat) => {
      const [e, n] = proj.forward(lon, lat);
      return [e - c.x, n - c.y];
    };
    const llBox = (pad) => {
      const pts = [
        [lb.min.x - pad, lb.min.y - pad], [lb.max.x + pad, lb.min.y - pad],
        [lb.max.x + pad, lb.max.y + pad], [lb.min.x - pad, lb.max.y + pad],
      ].map(([x, y]) => toLonLat(x, y));
      return {
        w: Math.min(...pts.map((p) => p[0])), e: Math.max(...pts.map((p) => p[0])),
        s: Math.min(...pts.map((p) => p[1])), n: Math.max(...pts.map((p) => p[1])),
      };
    };
    const tilesFor = (bb, z) => {
      const x0 = Math.floor(lon2x(bb.w, z)), x1 = Math.floor(lon2x(bb.e, z));
      const y0 = Math.floor(lat2y(bb.n, z)), y1 = Math.floor(lat2y(bb.s, z));
      const out = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y, z]);
      return out;
    };
    const pickZoom = (bb, maxTiles, maxZ) => {
      for (let z = maxZ; z > 1; z--) if (tilesFor(bb, z).length <= maxTiles) return z;
      return 1;
    };

    const maxZ = source.maxZoom || 19;
    const inner = llBox(ext * 0.15);
    const zIn = pickZoom(inner, MAX_INNER, maxZ);
    const outer = llBox(Math.max(ext * 1.5, 150));
    const zOut = Math.min(pickZoom(outer, MAX_OUTER, maxZ), zIn - 1);
    const jobs = [
      ...tilesFor(outer, zOut).map((t) => ({ t, z: baseZ - gap, order: -2 })),
      ...tilesFor(inner, zIn).map((t) => ({ t, z: baseZ, order: -1 })),
    ];

    this.group.visible = true;
    let done = 0;
    onProgress?.(0, jobs.length);
    const url = (x, y, z) => source.url.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'abc'[(x + y) % 3]);
    let failed = 0;
    await Promise.all(
      jobs.map(async ({ t: [tx, ty, tz], z, order }) => {
        let tex;
        try {
          tex = await this._loader.loadAsync(url(tx, ty, tz));
        } catch {
          failed++;
          return;
        } finally {
          onProgress?.(++done, jobs.length);
        }
        if (gen !== this._gen) return tex.dispose();
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = v.renderer.capabilities.getMaxAnisotropy?.() || 1;
        const n = SEG + 1;
        const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const k = j * n + i;
            const [lx, ly] = toLocal(x2lon(tx + i / SEG, tz), y2lat(ty + j / SEG, tz));
            pos.set([lx, ly, z], k * 3);
            uv.set([i / SEG, 1 - j / SEG], k * 2);
          }
        }
        const idx = [];
        for (let j = 0; j < SEG; j++) {
          for (let i = 0; i < SEG; i++) {
            const a = j * n + i, b = a + 1, cc = a + n, d = cc + 1;
            idx.push(a, cc, b, b, cc, d);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.setIndex(idx);
        g.computeBoundingSphere();
        const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, toneMapped: false });
        const mesh = new THREE.Mesh(g, mat);
        mesh.renderOrder = order;
        mesh.raycast = () => {}; // matavimai – tik ant modelio
        this.group.add(mesh);
        this.setOpacity(this.opacity);
      }),
    );
    if (gen !== this._gen) return null;
    if (failed === jobs.length) {
      this.group.visible = false;
      throw new Error('Nepavyko atsisiųsti žemėlapio plytelių – patikrinkite interneto ryšį arba žemėlapio adresą.');
    }
    v.requestRender();
    return { tiles: jobs.length, failed, zoom: zIn };
  }
}
