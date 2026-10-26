// „Ortofoto žemėlapis“: GeoTIFF ortofoto peržiūra ant pagrindo žemėlapio, permatomumas, matavimai
// (atstumas, plotas su perimetru, taškas LKS-94 koordinatėmis), eksportas GeoJSON, įkėlimas į portalą klientams.
import { icon } from '../icons.js';
import { t, locale } from '../i18n.js';
import { PlanMap } from '../plan/map.js';
import { LKS94 } from '../geo/tm.js';
import { openOrtho } from './raster.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = (v, d = 0) => new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const fmtLen = (m) => (m >= 1000 ? `${nf(m / 1000, 3)} km` : `${nf(m, 2)} m`);
const fmtArea = (m2) => (m2 >= 10000 ? `${nf(m2 / 10000, 4)} ha (${nf(m2, 0)} m²)` : `${nf(m2, 2)} m²`);
const fmtBytes = (b) => (b >= 1e9 ? `${nf(b / 1e9, 2)} GB` : `${nf(b / 1e6, 1)} MB`);
const D2R = Math.PI / 180;

// GRS80 / WGS84 kreivumo spinduliai – trumpiems atstumams ir plotams (paklaida ≪ 1 cm / 100 m)
const A = 6378137, E2 = 0.00669438002290;
const radii = (lat) => {
  const s = Math.sin(lat * D2R);
  const w = 1 - E2 * s * s;
  return [(A * (1 - E2)) / w ** 1.5, A / Math.sqrt(w)]; // M (meridiano), N (pirmojo vertikalo)
};
function segLen([lon1, lat1], [lon2, lat2]) {
  const lat = (lat1 + lat2) / 2;
  const [M, N] = radii(lat);
  return Math.hypot((lon2 - lon1) * D2R * N * Math.cos(lat * D2R), (lat2 - lat1) * D2R * M);
}
const pathLen = (P, closed = false) => P.reduce((s, p, i) => (i ? s + segLen(P[i - 1], p) : s), 0) + (closed && P.length > 2 ? segLen(P[P.length - 1], P[0]) : 0);
function polyArea(P) {
  if (P.length < 3) return 0;
  const lon0 = P.reduce((s, p) => s + p[0], 0) / P.length, lat0 = P.reduce((s, p) => s + p[1], 0) / P.length;
  const [M, N] = radii(lat0);
  const xy = P.map(([lon, lat]) => [(lon - lon0) * D2R * N * Math.cos(lat0 * D2R), (lat - lat0) * D2R * M]);
  let s = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}
const lks = ([lon, lat]) => LKS94.forward(lon, lat); // [E, N] = [Y, X]
const TOOLS = { distance: { label: 'Atstumas', icon: 'distance', color: '#ffd23f' }, area: { label: 'Plotas', icon: 'area', color: '#3cc4ff' }, point: { label: 'Taškas', icon: 'point', color: '#ff5ec4' } };

/**
 * @param {{toast:Function, loading:(on:boolean,text?:string,p?:number|null)=>void, admin?:()=>boolean,
 *   uploadToPortal?:(o:{blob:Blob,name:string,title:string})=>Promise<void>}} app
 */
export function createOrthoUI(app) {
  let raster = null;
  let source = null; // {src, name, downloadName, item?}
  let tool = null; // null | distance | area | point
  let cur = []; // brėžiamas matavimas
  let hover = null; // [x, y] ekrane
  let measures = [];
  let selected = null;
  let opacity = 1;
  let nextId = 1;

  const page = document.createElement('section');
  page.className = 'odm-page ortho-page';
  page.hidden = true;
  page.innerHTML = `
    <header class="odm-head">
      <div><h2 id="ot-title">Ortofoto žemėlapis</h2><p class="muted small" id="ot-sub">Ortofoto ant žemėlapio, matavimai ir koordinatės LKS-94.</p></div>
      <button class="btn btn-ghost icon-only" data-act="close" title="Uždaryti">${icon('close')}</button>
    </header>
    <div class="odm-body ot-body">
      <aside class="odm-side">
        <section class="card" data-card="info">
          <h3>Ortofoto</h3>
          <div id="ot-info" class="ot-info small"></div>
          <label class="ot-range">Permatomumas <input type="range" id="ot-opacity" min="0" max="100" value="100" /><span id="ot-opv">100 %</span></label>
          <div class="pane-actions" id="ot-actions"></div>
        </section>
        <section class="card" data-card="measure">
          <h3>Matavimai</h3>
          <div class="ot-tools">${Object.entries(TOOLS).map(([k, x]) => `<button class="ot-tool" data-otool="${k}" style="--c:${x.color}">${icon(x.icon)}<span>${x.label}</span></button>`).join('')}</div>
          <p class="small muted" id="ot-hint">Pasirinkite įrankį ir spustelėkite ortofoto.</p>
          <div id="ot-list" class="ot-list"></div>
          <p class="small muted ot-note">Atstumai ir plotai – tikri, žemės paviršiuje (elipsoide); koordinatės – LKS-94 (X – šiaurė, Y – rytai).</p>
          <div class="pane-actions" id="ot-mactions" hidden>
            <button class="btn btn-sm btn-outline" data-ot="export">${icon('save')}GeoJSON</button>
            <button class="btn btn-sm btn-outline" data-ot="csv">${icon('table')}CSV</button>
            <button class="btn btn-sm btn-ghost danger" data-ot="clear">${icon('trash')}Išvalyti</button>
          </div>
        </section>
      </aside>
      <div class="odm-main ot-main">
        <div class="ot-map-wrap">
          <canvas id="ot-map"></canvas>
          <div class="or-map-btns">
            <button class="btn btn-sm icon-only" type="button" data-ot="fit" title="Rodyti visą ortofoto">${icon('fit')}</button>
            <button class="btn btn-sm icon-only" type="button" data-ot="basemap" title="Pagrindas: palydovinė / žemėlapis / be pagrindo">${icon('map')}</button>
          </div>
          <div class="or-drawbar" id="ot-drawbar" hidden>
            <span id="ot-drawhint"></span>
            <span class="or-drawbar-btns">
              <button class="btn btn-sm btn-ghost" type="button" data-ot="undo">${icon('undo')}<span>Atšaukti tašką</span></button>
              <button class="btn btn-sm btn-primary" type="button" data-ot="finish">${icon('check')}<span>Baigti</span></button>
            </span>
          </div>
          <div class="ot-coords small" id="ot-coords" hidden></div>
          <div class="ot-loading small" id="ot-loading" hidden></div>
        </div>
      </div>
    </div>`;
  document.getElementById('app').append(page);
  const $ = (s) => page.querySelector(s);

  const map = new PlanMap($('#ot-map'), {
    onClick: (ll) => addPoint(ll),
    overlay: (g, m) => {
      if (raster) {
        // Rastro kontūras (kol kraunasi plytelės – matyti, kur ortofoto)
        g.save();
        g.strokeStyle = 'rgba(255,255,255,.35)';
        g.setLineDash([6, 4]);
        g.lineWidth = 1;
        g.beginPath();
        raster.outline.forEach((p, i) => (i ? g.lineTo(...m.toScreen(p)) : g.moveTo(...m.toScreen(p))));
        g.closePath();
        g.stroke();
        g.restore();
        raster.draw(g, m, opacity);
      }
      drawMeasures(g, m);
    },
  });
  map.editable = false;
  map.basemap = 'satellite';
  const canvas = $('#ot-map');

  // ---------------------------------------------------------------- atidarymas
  /**
   * @param {{src:string|Blob, name:string, downloadName?:string, downloadUrl?:string, item?:object, canUpload?:boolean}} o
   */
  async function open(o, { quiet = false } = {}) {
    close(true);
    page.hidden = false;
    document.body.classList.add('portal-open');
    source = o;
    $('#ot-title').textContent = o.name || t('Ortofoto žemėlapis');
    $('#ot-info').innerHTML = `<p class="muted">${esc(t('Atidaroma…'))}</p>`;
    $('#ot-actions').innerHTML = '';
    measures = [];
    renderList();
    setLoading(t('Skaitomas ortofoto…'));
    try {
      raster = await openOrtho(o.src, o.name);
    } catch (e) {
      setLoading(null);
      $('#ot-info').innerHTML = `<p class="bad">${esc(e.message)}</p>`;
      if (!quiet) app.toast(t('Nepavyko atidaryti ortofoto: {e}', { e: e.message }), 'error', 9000);
      return false;
    }
    let pending = 0;
    raster.onTile = () => {
      map.redraw();
      const n = raster.queue.length + raster.active;
      setLoading(n ? t('Kraunama… ({n})', { n }) : null);
      pending = n;
    };
    let errShown = false;
    raster.onError = (e) => {
      if (errShown) return;
      errShown = true;
      app.toast(t('Dalies ortofoto nepavyko nuskaityti: {e}', { e: e.message }), 'error', 8000);
    };
    renderInfo();
    map.fit(raster.outline);
    setLoading(pending ? t('Kraunama…') : null);
    return true;
  }

  function setLoading(text) {
    const el = $('#ot-loading');
    el.hidden = !text;
    if (text) el.innerHTML = `<span class="spinner"></span>${esc(text)}`;
  }

  function renderInfo() {
    const r = raster;
    const size = source.src instanceof Blob ? source.src.size : source.item?.size || 0;
    const row = (k, v) => `<div><span class="muted">${esc(t(k))}</span><b>${v}</b></div>`;
    $('#ot-info').innerHTML = `
      ${row('Raiška', `${nf(r.res * 100, r.res < 0.1 ? 1 : 0)} cm/px`)}
      ${row('Plotas', esc(r.areaM2 >= 1e4 ? `${nf(r.areaM2 / 1e4, 2)} ha` : `${nf(r.areaM2)} m²`))}
      ${row('Dydis', `${nf(r.width)} × ${nf(r.height)} px${size ? ` · ${fmtBytes(size)}` : ''}`)}
      ${row('Koordinatės', esc(r.crs.name))}
      ${r.hasOverviews ? '' : `<p class="ot-warn">${esc(t('Faile nėra peržiūros lygių – atitolinus vaizdas krausis lėčiau (skaitomas visas failas). Nauji ODM projektai juos sukuria; senam failui – „Įkelti į portalą“ su perskaičiavimu į LKS-94.'))}</p>`}`;
    const acts = [];
    if (source.downloadUrl) acts.push(`<a class="btn btn-sm btn-outline" href="${esc(source.downloadUrl)}" download="${esc(source.downloadName || 'ortofoto.tif')}">${icon('save')}${esc(t('Atsisiųsti GeoTIFF'))}</a>`);
    else if (source.src instanceof Blob) acts.push(`<button class="btn btn-sm btn-outline" data-ot="download">${icon('save')}${esc(t('Atsisiųsti GeoTIFF'))}</button>`);
    if (source.canUpload && app.uploadToPortal) acts.push(`<button class="btn btn-sm btn-primary" data-ot="upload">${icon('upload')}${esc(t('Įkelti į portalą klientui…'))}</button>`);
    $('#ot-actions').innerHTML = acts.join('');
  }

  // ---------------------------------------------------------------- matavimai
  function setTool(k) {
    if (cur.length) finish();
    tool = tool === k ? null : k;
    page.querySelectorAll('[data-otool]').forEach((b) => b.classList.toggle('on', b.dataset.otool === tool));
    canvas.style.cursor = tool ? 'crosshair' : '';
    syncHint();
  }

  function syncHint() {
    const h = !tool
      ? t('Pasirinkite įrankį ir spustelėkite ortofoto.')
      : tool === 'point'
        ? t('Spustelėkite tašką – bus parodytos jo koordinatės.')
        : t(tool === 'area' ? 'Spustelėkite ploto kampus; užbaikite dukart spustelėję arba „Baigti“.' : 'Spustelėkite taškus; užbaikite dukart spustelėję arba „Baigti“.');
    $('#ot-hint').textContent = h;
    const drawing = tool && tool !== 'point';
    $('#ot-drawbar').hidden = !drawing;
    if (drawing) {
      const v = cur.length ? (tool === 'area' ? `${fmtArea(polyArea(cur))}` : fmtLen(pathLen(cur))) : '';
      $('#ot-drawhint').textContent = cur.length ? `${t(TOOLS[tool].label)}: ${v}` : t(tool === 'area' ? 'Spustelėkite ploto kampus' : 'Spustelėkite pirmą tašką');
      page.querySelector('[data-ot=finish]').disabled = cur.length < (tool === 'area' ? 3 : 2);
      page.querySelector('[data-ot=undo]').disabled = !cur.length;
    }
  }

  function addPoint(ll) {
    if (!tool) {
      // Be įrankio – pasirinkti matavimą spustelėjus šalia jo
      const hit = measures.find((m) => m.pts.some((p) => {
        const [x, y] = map.toScreen(p), [cx, cy] = map.toScreen(ll);
        return Math.hypot(x - cx, y - cy) < 10;
      }));
      selected = hit?.id ?? null;
      renderList();
      map.redraw();
      return;
    }
    if (tool === 'point') {
      measures.push({ id: nextId++, type: 'point', pts: [ll] });
      renderList();
      map.redraw();
      return;
    }
    // Dvigubas spustelėjimas prideda du beveik vienodus taškus – antrasis nereikalingas
    const last = cur[cur.length - 1];
    if (last) {
      const [x1, y1] = map.toScreen(last), [x2, y2] = map.toScreen(ll);
      if (Math.hypot(x1 - x2, y1 - y2) < 4) return;
    }
    cur.push(ll);
    syncHint();
    map.redraw();
  }

  function finish() {
    const need = tool === 'area' ? 3 : 2;
    if (cur.length >= need) {
      measures.push({ id: nextId++, type: tool, pts: cur });
      selected = measures[measures.length - 1].id;
    }
    cur = [];
    renderList();
    syncHint();
    map.redraw();
  }

  function value(m) {
    if (m.type === 'distance') return { main: fmtLen(pathLen(m.pts)), sub: m.pts.length > 2 ? t('{n} atkarpos', { n: m.pts.length - 1 }) : '' };
    if (m.type === 'area') return { main: fmtArea(polyArea(m.pts)), sub: t('perimetras {p}', { p: fmtLen(pathLen(m.pts, true)) }) };
    const [E, N] = lks(m.pts[0]);
    return { main: `X ${nf(N, 2)} · Y ${nf(E, 2)}`, sub: `LKS-94 · ${nf(m.pts[0][1], 7)}, ${nf(m.pts[0][0], 7)}` };
  }

  function renderList() {
    const counts = { distance: 0, area: 0, point: 0 };
    $('#ot-list').innerHTML = measures
      .map((m) => {
        const n = ++counts[m.type];
        const v = value(m);
        return `<div class="ot-m ${m.id === selected ? 'sel' : ''}" data-m="${m.id}" style="--c:${TOOLS[m.type].color}">
          <span class="ot-m-ic">${icon(TOOLS[m.type].icon)}</span>
          <span class="ot-m-t"><span class="muted small">${esc(t(TOOLS[m.type].label))} ${n}</span><b>${esc(v.main)}</b>${v.sub ? `<span class="muted small">${esc(v.sub)}</span>` : ''}</span>
          <button class="btn btn-ghost btn-sm icon-only" data-ot="copy" title="${esc(t('Kopijuoti'))}">${icon('copy')}</button>
          <button class="btn btn-ghost btn-sm icon-only danger" data-ot="del" title="${esc(t('Pašalinti'))}">${icon('close')}</button>
        </div>`;
      })
      .join('');
    $('#ot-mactions').hidden = !measures.length;
  }

  function drawMeasures(g, m) {
    const path = (P, closed) => {
      g.beginPath();
      P.forEach((p, i) => (i ? g.lineTo(...m.toScreen(p)) : g.moveTo(...m.toScreen(p))));
      if (closed) g.closePath();
    };
    const dots = (P, col) =>
      P.forEach((p) => {
        const [x, y] = m.toScreen(p);
        g.beginPath();
        g.arc(x, y, 4.5, 0, Math.PI * 2);
        g.fillStyle = '#fff';
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = col;
        g.stroke();
      });
    const label = (text, [x, y], col) => {
      g.font = '600 12px Inter, Segoe UI, sans-serif';
      const w = g.measureText(text).width + 14;
      g.fillStyle = 'rgba(16,19,21,.85)';
      g.beginPath();
      g.roundRect(x - w / 2, y - 22, w, 20, 10);
      g.fill();
      g.fillStyle = col;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, x, y - 11.5);
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
    };
    const one = (mm, live) => {
      const col = TOOLS[mm.type].color;
      const sel = mm.id === selected || live;
      let P = mm.pts;
      if (live && hover) P = [...P, m.toLL(...hover)];
      if (mm.type === 'point') {
        const [x, y] = m.toScreen(P[0]);
        g.beginPath();
        g.arc(x, y, sel ? 7 : 5.5, 0, Math.PI * 2);
        g.fillStyle = col;
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = '#fff';
        g.stroke();
        if (sel) label(value(mm).main, [x, y - 6], col);
        return;
      }
      const closed = mm.type === 'area' && P.length > 2;
      path(P, closed);
      if (closed) {
        g.fillStyle = `${col}33`;
        g.fill();
      }
      g.lineWidth = sel ? 5 : 4;
      g.strokeStyle = 'rgba(0,0,0,.45)';
      g.stroke();
      g.lineWidth = sel ? 2.5 : 2;
      g.strokeStyle = col;
      g.stroke();
      dots(mm.pts, col);
      if (P.length < 2) return;
      // Užrašas: atstumui – prie paskutinio taško, plotui – centre
      const v = mm.type === 'area' ? (P.length > 2 ? fmtArea(polyArea(P)).replace(/ \(.*\)/, '') : fmtLen(pathLen(P))) : fmtLen(pathLen(P));
      if (mm.type === 'area' && P.length > 2) {
        const c = [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length];
        const [x, y] = m.toScreen(c);
        label(v, [x, y + 10], col);
      } else label(v, m.toScreen(P[P.length - 1]), col);
    };
    measures.forEach((mm) => one(mm, false));
    if (cur.length) one({ type: tool, pts: cur, id: -1 }, true);
  }

  // ---------------------------------------------------------------- įvykiai
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const xy = [e.clientX - r.left, e.clientY - r.top];
    const ll = map.toLL(...xy);
    const [E, N] = lks(ll);
    const el = $('#ot-coords');
    el.hidden = false;
    el.textContent = `X ${nf(N, 2)}  Y ${nf(E, 2)}  (LKS-94)`;
    if (cur.length) {
      hover = xy;
      map.redraw();
      syncHint();
    }
  });
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    $('#ot-coords').hidden = true;
    map.redraw();
  });
  canvas.addEventListener('dblclick', (e) => {
    if (!tool || tool === 'point') return;
    e.preventDefault();
    finish();
  });

  page.addEventListener('click', async (e) => {
    const tb = e.target.closest('[data-otool]');
    if (tb) return setTool(tb.dataset.otool);
    const mEl = e.target.closest('[data-m]');
    const a = e.target.closest('[data-ot]')?.dataset.ot;
    if (mEl && !a) {
      selected = +mEl.dataset.m;
      const mm = measures.find((x) => x.id === selected);
      if (mm) {
        const xs = mm.pts.map((p) => map.toScreen(p));
        const out = xs.some(([x, y]) => x < 0 || y < 0 || x > map.W || y > map.H);
        if (out) mm.pts.length > 1 ? map.fit(mm.pts) : map.setView(mm.pts[0][0], mm.pts[0][1]);
      }
      renderList();
      return map.redraw();
    }
    if (!a) return;
    if (a === 'fit') raster && map.fit(raster.outline);
    else if (a === 'basemap') {
      const order = ['satellite', 'osm', 'none'];
      map.basemap = order[(order.indexOf(map.basemap) + 1) % order.length];
      app.toast(t({ satellite: 'Pagrindas: palydovinė nuotrauka', osm: 'Pagrindas: OpenStreetMap', none: 'Be pagrindo žemėlapio' }[map.basemap]));
      map.redraw();
    } else if (a === 'finish') finish();
    else if (a === 'undo') {
      cur.pop();
      syncHint();
      map.redraw();
    } else if (a === 'del') {
      measures = measures.filter((x) => x.id !== +mEl.dataset.m);
      renderList();
      map.redraw();
    } else if (a === 'copy') {
      const mm = measures.find((x) => x.id === +mEl.dataset.m);
      const v = value(mm);
      await navigator.clipboard?.writeText(`${v.main}${v.sub ? ` (${v.sub})` : ''}`).catch(() => {});
      app.toast(t('Nukopijuota'));
    } else if (a === 'clear') {
      if (!confirm(t('Pašalinti visus matavimus?'))) return;
      measures = [];
      renderList();
      map.redraw();
    } else if (a === 'export') exportGeoJSON();
    else if (a === 'csv') exportCsv();
    else if (a === 'download') download(source.src, source.downloadName || 'ortofoto.tif');
    else if (a === 'upload') uploadDialog();
  });

  $('#ot-opacity').addEventListener('input', (e) => {
    opacity = e.target.value / 100;
    $('#ot-opv').textContent = `${e.target.value} %`;
    map.redraw();
  });

  page.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'Enter' && cur.length) return finish();
    if (e.key === 'Backspace' && cur.length) {
      cur.pop();
      syncHint();
      return map.redraw();
    }
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
      if (cur.length) {
        cur = [];
        syncHint();
        return map.redraw();
      }
      if (tool) return setTool(tool);
      close();
    }
  });

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  const baseName = () => String(source?.name || 'ortofoto').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);

  function exportGeoJSON() {
    const counts = {};
    const features = measures.map((m) => {
      const n = (counts[m.type] = (counts[m.type] || 0) + 1);
      const props = { name: `${t(TOOLS[m.type].label)} ${n}`, type: m.type };
      if (m.type === 'distance') props.length_m = +pathLen(m.pts).toFixed(3);
      if (m.type === 'area') Object.assign(props, { area_m2: +polyArea(m.pts).toFixed(3), perimeter_m: +pathLen(m.pts, true).toFixed(3) });
      if (m.type === 'point') {
        const [E, N] = lks(m.pts[0]);
        Object.assign(props, { lks94_x: +N.toFixed(3), lks94_y: +E.toFixed(3) });
      }
      const geometry = m.type === 'point' ? { type: 'Point', coordinates: m.pts[0] } : m.type === 'area' ? { type: 'Polygon', coordinates: [[...m.pts, m.pts[0]]] } : { type: 'LineString', coordinates: m.pts };
      return { type: 'Feature', properties: props, geometry };
    });
    download(new Blob([JSON.stringify({ type: 'FeatureCollection', name: source?.name || '', features }, null, 1)], { type: 'application/geo+json' }), `${baseName()}_matavimai.geojson`);
  }

  function exportCsv() {
    const counts = {};
    const rows = [[t('Pavadinimas'), t('Tipas'), t('Reikšmė'), t('Perimetras, m'), t('Taškas'), 'LKS-94 X', 'LKS-94 Y', t('Platuma'), t('Ilguma')].join(';')];
    for (const m of measures) {
      const n = (counts[m.type] = (counts[m.type] || 0) + 1);
      const v = m.type === 'distance' ? pathLen(m.pts).toFixed(3) : m.type === 'area' ? polyArea(m.pts).toFixed(3) : '';
      const per = m.type === 'area' ? pathLen(m.pts, true).toFixed(3) : '';
      m.pts.forEach((p, i) => {
        const [E, N] = lks(p);
        rows.push([`${t(TOOLS[m.type].label)} ${n}`, m.type === 'area' ? 'm²' : m.type === 'distance' ? 'm' : t('taškas'), i ? '' : v, i ? '' : per, i + 1, N.toFixed(3), E.toFixed(3), p[1].toFixed(8), p[0].toFixed(8)].join(';'));
      });
    }
    download(new Blob([`﻿${rows.join('\n')}\n`], { type: 'text/csv' }), `${baseName()}_matavimai.csv`);
  }

  async function uploadDialog() {
    try {
      await app.uploadToPortal({ src: source.src, name: `${baseName()}.tif`, title: source.name || t('Ortofoto') });
    } catch (e) {
      if (e?.name !== 'AbortError') app.toast(e.message, 'error', 8000);
    }
  }

  function close(keepPage = false) {
    raster?.dispose();
    raster = null;
    cur = [];
    tool = null;
    page.querySelectorAll('[data-otool]').forEach((b) => b.classList.remove('on'));
    $('#ot-drawbar').hidden = true;
    setLoading(null);
    if (keepPage) return;
    page.hidden = true;
    document.body.classList.remove('portal-open');
  }

  return {
    open,
    close: () => close(),
    get isOpen() {
      return !page.hidden;
    },
    /** Testams (?debug). */
    get debug() {
      return { map, raster, measures };
    },
    rerender() {
      if (page.hidden || !raster) return;
      renderInfo();
      renderList();
      syncHint();
    },
  };
}
