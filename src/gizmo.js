// Ašių indikatorius (SVG). Rodomos „geodezinės“ ašys: X – rytai, Y – šiaurė, Z – aukštyn.
import * as THREE from 'three';
import { t } from './i18n.js';

const AXES = [
  { label: 'X', dir: new THREE.Vector3(1, 0, 0), color: '#ff5f57', view: 'right', neg: 'left' },
  { label: 'Y', dir: new THREE.Vector3(0, 0, -1), color: '#8dc63f', view: 'back', neg: 'front' },
  { label: 'Z', dir: new THREE.Vector3(0, 1, 0), color: '#4fa8ff', view: 'top', neg: 'bottom' },
];

export class Gizmo {
  constructor(svg, viewer) {
    this.svg = svg;
    this.viewer = viewer;
    this.q = new THREE.Quaternion();
    svg.addEventListener('click', (e) => {
      const v = e.target.closest('[data-view]')?.dataset.view;
      if (v) viewer.setView(v);
    });
  }

  update() {
    const inv = this.q.copy(this.viewer.camera.quaternion).invert();
    const R = 34;
    const items = [];
    for (const a of AXES) {
      for (const sign of [1, -1]) {
        const v = a.dir.clone().multiplyScalar(sign).applyQuaternion(inv);
        items.push({ a, sign, x: v.x * R, y: -v.y * R, z: v.z });
      }
    }
    items.sort((p, q) => p.z - q.z);
    let html = '<circle class="ax-bg" r="48" />';
    for (const it of items) {
      const pos = it.sign > 0;
      if (pos) html += `<line x1="0" y1="0" x2="${it.x.toFixed(1)}" y2="${it.y.toFixed(1)}" stroke="${it.a.color}" stroke-width="3" stroke-linecap="round" />`;
      const r = pos ? 9 : 6;
      html += `<circle class="end" data-view="${pos ? it.a.view : it.a.neg}" cx="${it.x.toFixed(1)}" cy="${it.y.toFixed(1)}" r="${r}" fill="${pos ? it.a.color : 'rgba(255,255,255,.18)'}" stroke="${it.a.color}" stroke-width="${pos ? 0 : 1.5}"><title>${viewTitle(pos ? it.a.view : it.a.neg)}</title></circle>`;
      if (pos) html += `<text x="${it.x.toFixed(1)}" y="${it.y.toFixed(1)}" fill="#0b1a14">${it.a.label}</text>`;
    }
    if (html !== this._last) {
      this.svg.innerHTML = html;
      this._last = html;
    }
  }
}

function viewTitle(v) {
  return t({ top: 'Iš viršaus', bottom: 'Iš apačios', front: 'Iš pietų (priekis)', back: 'Iš šiaurės', right: 'Iš rytų', left: 'Iš vakarų' }[v]);
}
