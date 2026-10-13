// Aukščio profilio grafikas (SVG) su žymekliu 3D vaizde
import * as THREE from 'three';
import { niceStep } from './viewer.js';

export class ProfileChart {
  constructor(container, viewer, units) {
    this.el = container;
    this.viewer = viewer;
    this.units = units;
    this.panel = container.closest('.profile-panel');
    this.current = null;
    this.marker = null;
    new ResizeObserver(() => this.current && this.render()).observe(container);
    container.addEventListener('pointermove', (e) => this._hover(e));
    container.addEventListener('pointerleave', () => this._hover(null));
  }

  show(m) {
    if (!m?.data?.samples) return;
    this.current = m;
    this.panel.hidden = false;
    this.render();
  }

  hide() {
    this.current = null;
    this.panel.hidden = true;
    this._setMarker(null);
  }

  render() {
    const m = this.current;
    if (!m) return;
    const U = this.units, v = this.viewer;
    const S = m.data.samples;
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H) return;
    const pad = { l: 64, r: 18, t: 12, b: 26 };
    const elev = (y) => v.dispElev(y, U);
    const ys = S.filter((s) => !isNaN(s.y)).map((s) => elev(s.y));
    if (!ys.length) {
      this.el.innerHTML = '<div style="padding:20px;opacity:.7">Palei liniją nerasta paviršiaus</div>';
      return;
    }
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    const dy = Math.max(y1 - y0, 1e-6);
    y0 -= dy * 0.08;
    y1 += dy * 0.08;
    const len = U.len(m.data.length);
    const sx = (d) => pad.l + (d / Math.max(len, 1e-9)) * (W - pad.l - pad.r);
    const sy = (y) => pad.t + (1 - (y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
    this._scale = { sx, sy, len, pad, W, H, elev };

    let path = '', area = '', started = false, lastX = 0;
    for (const s of S) {
      if (isNaN(s.y)) {
        if (started) area += `L${lastX},${H - pad.b}Z`;
        started = false;
        continue;
      }
      const x = sx(U.len(s.d)).toFixed(1), y = sy(elev(s.y)).toFixed(1);
      if (!started) {
        path += `M${x},${y}`;
        area += `M${x},${H - pad.b}L${x},${y}`;
        started = true;
      } else {
        path += `L${x},${y}`;
        area += `L${x},${y}`;
      }
      lastX = x;
    }
    if (started) area += `L${lastX},${H - pad.b}Z`;

    // Ašys
    const yStep = niceStep((y1 - y0) / 4);
    const xStep = niceStep(len / 8);
    let grid = '', axis = '';
    for (let y = Math.ceil(y0 / yStep) * yStep; y <= y1; y += yStep) {
      const py = sy(y).toFixed(1);
      grid += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${py}" y2="${py}"/>`;
      axis += `<text x="${pad.l - 8}" y="${py}" text-anchor="end" dominant-baseline="middle">${U.num(y, yStep < 1 ? 2 : 1)}</text>`;
    }
    for (let x = 0; x <= len + 1e-9; x += xStep) {
      const px = sx(x).toFixed(1);
      grid += `<line y1="${pad.t}" y2="${H - pad.b}" x1="${px}" x2="${px}"/>`;
      axis += `<text x="${px}" y="${H - 8}" text-anchor="middle">${U.num(x, xStep < 1 ? 2 : 0)} ${U.display}</text>`;
    }
    this.el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="pgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3fe0d0" stop-opacity=".45"/><stop offset="1" stop-color="#3fe0d0" stop-opacity=".03"/></linearGradient></defs>
      <g class="grid">${grid}</g><g class="axis">${axis}</g>
      <path class="area" d="${area}"/><path class="line" d="${path}"/>
      <g class="cursor" visibility="hidden"><line y1="${pad.t}" y2="${H - pad.b}"/><circle r="5"/><text class="cursor-label"></text></g>
    </svg>`;
    this.cursor = this.el.querySelector('.cursor');

    const d = m.data;
    document.getElementById('profile-title').textContent = m.name;
    document.getElementById('profile-stats').textContent =
      `Ilgis ${U.fmtLen(d.length)}  •  Aukščiai ${U.num(Math.min(...ys))}…${U.num(Math.max(...ys))} ${U.display}  •  Δ ${U.fmtLen(d.maxY - d.minY)}  •  Kilimas ${U.fmtLen(d.gain)}  •  Leidimasis ${U.fmtLen(d.loss)}  •  Maks. nuolydis ${U.fmtPercent(d.maxSlope)}`;
  }

  _hover(e) {
    if (!this.current || !this.cursor || !this._scale) return;
    if (!e) {
      this.cursor.setAttribute('visibility', 'hidden');
      this._setMarker(null);
      return;
    }
    const { sx, sy, len, pad, W, elev } = this._scale;
    const r = this.el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const dDisp = Math.max(0, Math.min(len, ((x - pad.l) / (W - pad.l - pad.r)) * len));
    const S = this.current.data.samples;
    const i = Math.round((dDisp / Math.max(len, 1e-9)) * (S.length - 1));
    const s = S[Math.max(0, Math.min(S.length - 1, i))];
    if (isNaN(s.y)) return;
    const px = sx(this.units.len(s.d)), py = sy(elev(s.y));
    this.cursor.setAttribute('visibility', 'visible');
    const [line, circle, text] = this.cursor.children;
    line.setAttribute('x1', px);
    line.setAttribute('x2', px);
    circle.setAttribute('cx', px);
    circle.setAttribute('cy', py);
    text.setAttribute('x', px + (px > W - 180 ? -10 : 10));
    text.setAttribute('text-anchor', px > W - 180 ? 'end' : 'start');
    text.setAttribute('y', Math.max(py - 10, 24));
    text.textContent = `${this.units.num(this.units.len(s.d))} ${this.units.display}  →  Z ${this.units.num(elev(s.y))} ${this.units.display}`;
    this._setMarker(new THREE.Vector3(s.x, s.y, s.z));
  }

  _setMarker(world) {
    const v = this.viewer;
    if (!this.marker) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      g.beginPath();
      g.arc(32, 32, 24, 0, Math.PI * 2);
      g.fillStyle = '#3fe0d0';
      g.fill();
      g.lineWidth = 8;
      g.strokeStyle = '#ffffff';
      g.stroke();
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.marker = new THREE.Points(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]),
        new THREE.PointsMaterial({ size: 16, sizeAttenuation: false, map: tex, transparent: true, depthTest: false, alphaTest: 0.1 }),
      );
      this.marker.renderOrder = 1002;
      this.marker.frustumCulled = false;
      v.scene.add(this.marker);
    }
    this.marker.visible = !!world;
    if (world) this.marker.position.copy(world);
    v.requestRender();
  }
}
