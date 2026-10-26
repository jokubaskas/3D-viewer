// „Užsakymai“: klientas žemėlapyje pažymi teritoriją ir aprašo, kokio darbo reikia; administratorius mato visus
// užsakymus žemėlapyje ir sąraše, keičia būseną, planuoja datą, nurodo kainą, prideda rezultatus, abu susirašinėja.
// Teises tikrina serveris (deploy/portal/app.py) – čia tik sąsaja.
import { icon } from '../icons.js';
import { t, locale } from '../i18n.js';
import { api } from './api.js';
import { PlanMap } from '../plan/map.js';
import { parseArea } from '../plan/plan.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = (v, d = 0) => new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const fmtArea = (m2) => (m2 >= 10000 ? `${nf(m2 / 10000, m2 >= 1e6 ? 0 : 2)} ha` : `${nf(m2)} m²`);
const fmtDay = (s) => (s ? new Date(`${s}T12:00:00`).toLocaleDateString(locale(), { year: 'numeric', month: 'long', day: 'numeric' }) : '');
const fmtWhen = (sec) => {
  const d = new Date(sec * 1000);
  const days = (Date.now() - d) / 864e5;
  if (days < 1 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(locale(), days < 300 ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' });
};
const fmtFull = (sec) => new Date(sec * 1000).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export const STATUS = {
  new: { label: 'Naujas', color: '#4fa8ff' },
  accepted: { label: 'Priimtas', color: '#2ec4b6' },
  in_progress: { label: 'Vykdomas', color: '#ffb627' },
  done: { label: 'Atliktas', color: '#3cc443' },
  cancelled: { label: 'Atšauktas', color: '#8a9490' },
  rejected: { label: 'Atmestas', color: '#ff5e57' },
};
const STEPS = ['new', 'accepted', 'in_progress', 'done'];
export const WORKS = {
  ortho: { label: 'Ortofoto žemėlapis', icon: 'map' },
  model3d: { label: '3D modelis', icon: 'cube' },
  volume: { label: 'Tūrių skaičiavimas', icon: 'volume' },
  topo: { label: 'Topografija / aukščiai', icon: 'mountain' },
  inspection: { label: 'Apžiūra / inspekcija', icon: 'eye' },
  progress: { label: 'Darbų progreso stebėjimas', icon: 'chart' },
  thermal: { label: 'Terminė apžiūra', icon: 'thermo' },
  media: { label: 'Foto / video', icon: 'camera' },
  live: { label: 'Gyva transliacija', icon: 'live' },
  other: { label: 'Kita', icon: 'edit' },
};
const KIND_LABEL = { model: '3D modelis', stream: 'Transliacija', report: 'Ataskaita', recording: 'Įrašas' };
const KIND_ICON = { model: 'cube', stream: 'live', report: 'report', recording: 'record' };
const FILTERS = [
  { id: 'active', label: 'Aktyvūs', test: (o) => ['new', 'accepted', 'in_progress'].includes(o.status) },
  { id: 'new', label: 'Nauji', test: (o) => o.status === 'new' },
  { id: 'done', label: 'Atlikti', test: (o) => o.status === 'done' },
  { id: 'all', label: 'Visi', test: () => true },
];

const ring = (o) => o.geometry.coordinates[0].slice(0, -1);
function inside([x, y], P) {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
/** Plotas m² (vietinė projekcija) – tik rodymui; serveris skaičiuoja pats. */
function areaM2(P) {
  if (P.length < 3) return 0;
  const lat0 = P.reduce((s, p) => s + p[1], 0) / P.length;
  const k = Math.cos((lat0 * Math.PI) / 180) * 111320;
  let s = 0;
  for (let i = 0; i < P.length; i++) {
    const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % P.length];
    s += x1 * k * y2 * 110574 - x2 * k * y1 * 110574;
  }
  return Math.abs(s) / 2;
}
const centroid = (P) => [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length];

/**
 * @param {{user:{id:number,role:string}, toast:Function, openResult:(item:{id:number,kind:string})=>void}} app
 */
export function createOrdersUI(app) {
  const admin = app.user.role === 'admin';
  let orders = [];
  let users = [];
  let filter = admin ? 'active' : 'all';
  let query = '';
  let view = { mode: 'list' }; // list | detail {id, data} | form {step, id?, poly, ...}
  let poll = 0;

  const page = document.createElement('section');
  page.className = 'odm-page orders-page';
  page.hidden = true;
  page.innerHTML = `
    <header class="odm-head">
      <div><h2>${admin ? 'Užsakymai' : 'Mano užsakymai'}</h2><p class="muted small">${admin ? 'Klientų užsakymai: teritorija žemėlapyje, darbas, būsena ir susirašinėjimas.' : 'Pažymėkite teritoriją žemėlapyje ir aprašykite, kokio darbo reikia. Čia matysite užsakymo eigą ir rezultatus.'}</p></div>
      <button class="btn btn-ghost icon-only" data-act="close" title="Uždaryti">${icon('close')}</button>
    </header>
    <div class="or-body">
      <aside class="or-side" id="or-side"></aside>
      <div class="or-map-wrap">
        <canvas id="or-map"></canvas>
        <form class="or-search" id="or-search" autocomplete="off">
          ${icon('search')}<input id="or-q" placeholder="Ieškoti adreso ar vietos…" enterkeyhint="search" />
          <div class="or-results" id="or-results" hidden></div>
        </form>
        <div class="or-map-btns">
          <button class="btn btn-sm icon-only" type="button" data-om="locate" title="Mano vieta">${icon('pin')}</button>
          <button class="btn btn-sm icon-only" type="button" data-om="fit" title="Rodyti visus užsakymus">${icon('fit')}</button>
          <button class="btn btn-sm icon-only" type="button" data-om="basemap" title="Palydovinė / žemėlapis">${icon('map')}</button>
        </div>
        <div class="or-drawbar" id="or-drawbar" hidden>
          <span id="or-drawhint"></span>
          <span class="or-drawbar-btns">
            <button class="btn btn-sm btn-ghost" type="button" data-om="undo">${icon('undo')}<span>Atšaukti tašką</span></button>
            <button class="btn btn-sm btn-primary" type="button" data-om="finish">${icon('check')}<span>Baigti</span></button>
          </span>
        </div>
        <div class="or-maphint small" id="or-maphint" hidden></div>
      </div>
    </div>
    <input type="file" id="or-file" accept=".kml,.geojson,.json" hidden />`;
  document.getElementById('app').append(page);
  const $ = (s) => page.querySelector(s);
  const side = $('#or-side');

  // ---------------------------------------------------------------- žemėlapis
  const map = new PlanMap($('#or-map'), {
    color: '#ffd23f',
    onChange: () => {
      if (view.mode !== 'form') return;
      view.poly = map.closed ? map.poly.map((p) => [p[0], p[1]]) : [];
      if (map.closed && !view.geocoded) reverseGeocode();
      syncDrawbar();
      if (view.step === 1) renderFormArea();
    },
    onClick: (ll) => {
      if (view.mode === 'form') return;
      const hit = visible()
        .filter((o) => inside(ll, ring(o)))
        .sort((a, b) => a.area - b.area)[0];
      if (hit) openDetail(hit.id);
    },
    overlay: drawOrders,
  });
  map.editable = false;

  function drawOrders(g, m) {
    const selId = view.mode === 'detail' ? view.id : view.mode === 'form' ? view.id : null;
    const list = view.mode === 'form' ? orders.filter((o) => o.id !== view.id) : visible();
    const dim = view.mode === 'form';
    const drawOne = (o, sel) => {
      const P = ring(o).map((p) => m.toScreen(p));
      const col = STATUS[o.status]?.color || '#4fa8ff';
      g.beginPath();
      P.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.globalAlpha = dim ? 0.35 : 1;
      g.fillStyle = `${col}${sel ? '40' : '26'}`;
      g.fill();
      if (sel) {
        g.lineWidth = 5;
        g.strokeStyle = 'rgba(255,255,255,.85)';
        g.stroke();
      }
      g.lineWidth = sel ? 2.5 : 1.8;
      g.strokeStyle = col;
      g.stroke();
      // Pavadinimas – jei sritis ekrane pakankamai didelė (arba pasirinkta)
      const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
      const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
      if (!dim && (sel || (w > 70 && h > 26))) {
        const [cx, cy] = m.toScreen(centroid(ring(o)));
        const label = o.title.length > 28 ? `${o.title.slice(0, 27)}…` : o.title;
        g.font = '600 12px Inter, Segoe UI, sans-serif';
        const tw = g.measureText(label).width + 16;
        g.fillStyle = 'rgba(16,19,21,.82)';
        g.beginPath();
        g.roundRect(cx - tw / 2, cy - 11, tw, 22, 11);
        g.fill();
        g.fillStyle = col;
        g.beginPath();
        g.arc(cx - tw / 2 + 10, cy, 3.5, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#fff';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(label, cx - tw / 2 + 17, cy + 0.5);
        g.textBaseline = 'alphabetic';
      }
      g.globalAlpha = 1;
    };
    list.filter((o) => o.id !== selId).forEach((o) => drawOne(o, false));
    const sel = list.find((o) => o.id === selId);
    if (sel) drawOne(sel, true);
  }

  function fitAll() {
    const pts = (view.mode === 'form' && view.poly?.length ? view.poly : visible().flatMap(ring));
    if (pts.length) map.fit(pts);
  }

  // ---------------------------------------------------------------- duomenys
  const visible = () => {
    const f = FILTERS.find((x) => x.id === filter) || FILTERS[3];
    const q = query.trim().toLowerCase();
    return orders.filter((o) => f.test(o) && (!q || `${o.title} ${o.address} ${o.client?.name || ''} ${o.client?.email || ''} #${o.id}`.toLowerCase().includes(q)));
  };

  async function load(quiet = false) {
    try {
      orders = await api('orders');
      if (admin && !users.length) users = await api('users').catch(() => []);
    } catch (e) {
      if (!quiet) app.toast(e.message, 'error');
    }
  }

  // ---------------------------------------------------------------- sąrašas
  function renderList() {
    view = { mode: 'list' };
    map.clear();
    map.editable = false;
    syncDrawbar();
    const list = visible();
    const counts = Object.fromEntries(FILTERS.map((f) => [f.id, orders.filter(f.test).length]));
    side.innerHTML = `
      <div class="or-side-head">
        <button class="btn btn-primary or-new" data-or="new">${icon('plus')}${esc(t(admin ? 'Naujas užsakymas klientui' : 'Naujas užsakymas'))}</button>
        ${orders.length ? `<div class="or-filter seg">${FILTERS.map((f) => `<button data-filter="${f.id}" class="${f.id === filter ? 'active' : ''}">${esc(t(f.label))}<span class="or-n">${counts[f.id]}</span></button>`).join('')}</div>` : ''}
        ${admin && orders.length > 4 ? `<input class="live-input or-find" id="or-find" placeholder="${esc(t('Ieškoti: klientas, pavadinimas, adresas, #nr.'))}" value="${esc(query)}" />` : ''}
      </div>
      <div class="or-list">
        ${list.length ? list.map(cardHtml).join('') : emptyHtml()}
      </div>`;
    map.redraw();
  }

  const emptyHtml = () =>
    orders.length
      ? `<p class="muted small or-empty-f">${esc(t('Šiame sąraše užsakymų nėra.'))}</p>`
      : `<div class="or-empty">
          <span class="or-empty-ic">${icon(admin ? 'order' : 'area')}</span>
          <b>${esc(t(admin ? 'Užsakymų dar nėra' : 'Užsakykite darbą per kelias minutes'))}</b>
          <p class="muted small">${esc(t(admin ? 'Kai klientas pateiks užsakymą, jis atsiras čia ir žemėlapyje. Užsakymą gautą telefonu galite užregistruoti patys.' : '1. Žemėlapyje pažymėkite teritoriją. 2. Pasirinkite, kokio darbo reikia, ir aprašykite. 3. Sekite eigą ir gaukite rezultatus čia.'))}</p>
        </div>`;

  function cardHtml(o) {
    const st = STATUS[o.status] || STATUS.new;
    return `<button class="or-card${o.unread ? ' unread' : ''}" data-open="${o.id}">
      <span class="or-card-top"><span class="or-chip" style="--c:${st.color}">${esc(t(st.label))}</span><span class="muted small">#${o.id} · ${esc(fmtWhen(o.updated))}</span>${o.unread ? `<i class="or-dot" title="${esc(t('Yra naujienų'))}"></i>` : ''}</span>
      <b class="or-card-title">${esc(o.title)}</b>
      ${admin ? `<span class="small or-card-client">${icon('user')}${esc(o.client?.name || o.client?.email || '')}</span>` : ''}
      <span class="or-card-meta small muted">
        <span>${icon('area')}${esc(fmtArea(o.area))}</span>
        ${o.planned ? `<span>${icon('calendar')}${esc(fmtDay(o.planned))}</span>` : o.due ? `<span title="${esc(t('Pageidaujama data'))}">${icon('calendar')}${esc(t('iki {d}', { d: fmtDay(o.due) }))}</span>` : ''}
        ${o.comments ? `<span>${icon('send')}${o.comments}</span>` : ''}
      </span>
      <span class="or-card-works">${o.works.map((w) => `<span title="${esc(t(WORKS[w]?.label || w))}">${icon(WORKS[w]?.icon || 'edit')}</span>`).join('')}</span>
    </button>`;
  }

  // ---------------------------------------------------------------- užsakymo peržiūra
  async function openDetail(id, { fit = true } = {}) {
    try {
      const data = await api(`orders/${id}`);
      const i = orders.findIndex((o) => o.id === id);
      if (i >= 0) orders[i] = { ...orders[i], ...data, unread: false };
      view = { mode: 'detail', id, data };
      map.clear();
      map.editable = false;
      syncDrawbar();
      renderDetail();
      if (fit) map.fit(ring(data));
      map.redraw();
    } catch (e) {
      app.toast(e.message, 'error');
      renderList();
    }
  }

  function stepperHtml(o) {
    if (o.status === 'cancelled' || o.status === 'rejected') return `<div class="or-closed" style="--c:${STATUS[o.status].color}">${icon('close')}${esc(t(o.status === 'cancelled' ? 'Užsakymas atšauktas' : 'Užsakymas atmestas'))}</div>`;
    const cur = STEPS.indexOf(o.status);
    return `<ol class="or-steps">${STEPS.map((s, i) => `<li class="${i < cur ? 'done' : i === cur ? 'cur' : ''}"><span>${i < cur ? icon('check') : i + 1}</span>${esc(t(STATUS[s].label))}</li>`).join('')}</ol>`;
  }

  function renderDetail() {
    const o = view.data;
    const st = STATUS[o.status] || STATUS.new;
    const fact = (ic, label, value) => (value ? `<div class="or-fact">${icon(ic)}<span><span class="muted small">${esc(t(label))}</span><b>${value}</b></span></div>` : '');
    const canEdit = !admin && o.status === 'new';
    const canCancel = !admin && (o.status === 'new' || o.status === 'accepted');
    side.innerHTML = `
      <div class="or-detail">
        <div class="or-d-nav">
          <button class="btn btn-ghost btn-sm" data-or="back">${icon('back')}${esc(t('Visi užsakymai'))}</button>
          <span class="or-d-tools">
            ${canEdit || admin ? `<button class="btn btn-ghost btn-sm icon-only" data-or="edit" title="${esc(t('Redaguoti'))}">${icon('edit')}</button>` : ''}
            ${admin ? `<button class="btn btn-ghost btn-sm icon-only danger" data-or="delete" title="${esc(t('Ištrinti užsakymą'))}">${icon('trash')}</button>` : ''}
          </span>
        </div>
        <div class="or-d-title">
          <span class="or-chip" style="--c:${st.color}">${esc(t(st.label))}</span><span class="muted small">#${o.id} · ${esc(t('pateikta {d}', { d: fmtFull(o.created) }))}</span>
          <h3>${esc(o.title)}</h3>
          ${admin ? `<div class="small or-d-client">${icon('user')}<b>${esc(o.client?.name || '')}</b> <a href="mailto:${esc(o.client?.email)}">${esc(o.client?.email || '')}</a></div>` : ''}
        </div>
        ${stepperHtml(o)}
        <div class="or-facts">
          ${fact('area', 'Plotas', esc(fmtArea(o.area)))}
          ${fact('calendar', 'Pageidaujama data', esc(fmtDay(o.due)))}
          ${fact('calendar', 'Suplanuota', esc(fmtDay(o.planned)))}
          ${fact('euro', 'Kaina', esc(o.price))}
          ${fact('phone', 'Kontaktas', esc(o.contact))}
          ${fact('pin', 'Adresas', esc(o.address))}
        </div>
        <div class="or-works">${o.works.map((w) => `<span class="or-work on">${icon(WORKS[w]?.icon || 'edit')}${esc(t(WORKS[w]?.label || w))}</span>`).join('')}</div>
        ${o.note ? `<div class="or-note"><span class="muted small">${esc(t('Ko reikia'))}</span><p>${esc(o.note)}</p></div>` : ''}
        ${o.admin_note && !admin ? `<div class="or-note or-note-admin"><span class="small">${esc(t('Pastaba nuo Atea'))}</span><p>${esc(o.admin_note)}</p></div>` : ''}
        ${o.items.length || admin ? `<div class="or-results-box"><span class="muted small">${esc(t('Rezultatai'))}</span>
          ${o.items.map((it) => `<button class="or-result" data-result="${it.id}" data-kind="${it.kind}">${icon(KIND_ICON[it.kind] || 'cube')}<span><b>${esc(it.title)}</b><span class="muted small">${esc(t(KIND_LABEL[it.kind] || it.kind))}</span></span><i class="or-fwd">${icon('back')}</i></button>`).join('') || `<p class="muted small" style="margin:4px 0 0">${esc(t('Dar nepridėta.'))}</p>`}
          ${admin ? `<button class="btn btn-outline btn-sm" data-or="results">${icon('plus')}${esc(t('Pridėti rezultatus…'))}</button>` : ''}
        </div>` : ''}
        ${admin ? adminPanelHtml(o) : ''}
        ${canCancel ? `<button class="btn btn-ghost btn-sm danger or-cancel" data-or="cancel">${icon('close')}${esc(t('Atšaukti užsakymą'))}</button>` : ''}
        <h4 class="or-sub">${esc(t('Eiga ir žinutės'))}</h4>
        <div class="or-timeline" id="or-timeline">${timelineHtml(o)}</div>
        <form class="or-chat" id="or-chat">
          <textarea name="body" rows="1" maxlength="4000" placeholder="${esc(t(admin ? 'Žinutė klientui…' : 'Klausimas ar patikslinimas…'))}"></textarea>
          <button class="btn btn-primary icon-only" title="${esc(t('Siųsti (Enter)'))}">${icon('send')}</button>
        </form>
      </div>`;
    const tl = $('#or-timeline');
    tl.scrollTop = tl.scrollHeight;
  }

  function adminPanelHtml(o) {
    return `<form class="or-admin" id="or-admin">
      <span class="muted small">${esc(t('Valdymas'))}</span>
      <div class="or-status-pick">${Object.entries(STATUS).map(([k, s]) => `<label style="--c:${s.color}"><input type="radio" name="status" value="${k}" ${o.status === k ? 'checked' : ''}/><span>${esc(t(s.label))}</span></label>`).join('')}</div>
      <div class="or-grid2">
        <label>${esc(t('Suplanuota data'))}<input type="date" name="planned" value="${esc(o.planned)}" /></label>
        <label>${esc(t('Kaina'))}<input name="price" maxlength="100" placeholder="${esc(t('pvz. 450 € + PVM'))}" value="${esc(o.price)}" /></label>
      </div>
      <label>${esc(t('Pastaba klientui (matoma klientui)'))}<textarea name="admin_note" rows="2" maxlength="5000">${esc(o.admin_note)}</textarea></label>
      <button class="btn btn-primary btn-sm">${icon('check')}${esc(t('Išsaugoti'))}</button>
    </form>`;
  }

  function eventText(e) {
    const s = (k) => t(STATUS[k]?.label || k);
    switch (e.kind) {
      case 'created': return t('Užsakymas pateiktas');
      case 'status': return t('Būsena: {s}', { s: s(e.body) });
      case 'planned': return e.body ? t('Suplanuota data: {d}', { d: fmtDay(e.body) }) : t('Suplanuota data pašalinta');
      case 'price': return e.body ? t('Kaina: {p}', { p: e.body }) : t('Kaina pašalinta');
      case 'admin_note': return t('Atnaujinta pastaba klientui');
      case 'results': return t('Pridėta rezultatų: {n}', { n: e.body });
      case 'edited': return e.body === 'geometry' ? t('Pakeista teritorija') : t('Užsakymas pakeistas');
      default: return e.kind;
    }
  }

  function timelineHtml(o) {
    return o.events
      .map((e) =>
        e.kind === 'comment'
          ? `<div class="or-msg ${e.mine ? 'mine' : ''} ${e.who}"><div class="or-msg-b">${esc(e.body)}</div><span class="muted small">${esc(e.mine ? t('Jūs') : e.who === 'admin' ? (admin ? e.name : 'Atea') : e.name)} · ${esc(fmtFull(e.created))}</span></div>`
          : `<div class="or-ev"><i style="--c:${e.kind === 'status' ? STATUS[e.body]?.color || '#888' : 'var(--muted)'}"></i><span>${esc(eventText(e))}</span><span class="muted small">${esc(fmtWhen(e.created))}</span></div>`,
      )
      .join('');
  }

  // ---------------------------------------------------------------- naujas / redagavimas
  function openForm(o = null) {
    view = {
      mode: 'form',
      step: 1,
      id: o?.id ?? null,
      poly: o ? ring(o) : [],
      title: o?.title || '',
      works: o?.works ? [...o.works] : [],
      note: o?.note || '',
      due: o?.due || '',
      contact: o?.contact || '',
      address: o?.address || '',
      client_id: o?.client?.id || '',
      geocoded: !!o,
      admin,
    };
    map.editable = true;
    if (o) {
      map.setPolygon(view.poly);
      map.fit(view.poly);
    } else map.startDrawing();
    syncDrawbar();
    renderForm();
  }

  function stepsHead() {
    const s = view.step;
    return `<div class="or-d-nav"><button class="btn btn-ghost btn-sm" data-or="form-cancel">${icon('back')}${esc(t('Atšaukti'))}</button><span class="muted small">${esc(t(view.id ? 'Užsakymo #{n} redagavimas' : 'Naujas užsakymas', { n: view.id }))}</span></div>
      <ol class="or-wiz"><li class="${s === 1 ? 'cur' : 'done'}"><span>${s > 1 ? icon('check') : 1}</span>${esc(t('Teritorija'))}</li><li class="${s === 2 ? 'cur' : ''}"><span>2</span>${esc(t('Darbas'))}</li></ol>`;
  }

  function renderForm() {
    if (view.step === 1) {
      side.innerHTML = `<div class="or-form">${stepsHead()}<div id="or-area"></div></div>`;
      renderFormArea();
      return;
    }
    const v = view;
    side.innerHTML = `<form class="or-form" id="or-form" novalidate>
      ${stepsHead()}
      <div class="or-area-mini">${icon('area')}<b>${esc(fmtArea(areaM2(v.poly)))}</b><span class="muted small">${esc(v.address || t('Teritorija pažymėta'))}</span><button type="button" class="btn btn-ghost btn-sm" data-or="step1">${esc(t('Keisti'))}</button></div>
      ${admin ? `<label class="or-field">${esc(t('Klientas'))}<select name="client_id" required><option value="">${esc(t('— pasirinkite —'))}</option>${users.filter((u) => u.role === 'client').map((u) => `<option value="${u.id}" ${+v.client_id === u.id ? 'selected' : ''}>${esc(u.name || u.email)}${u.name ? ` (${esc(u.email)})` : ''}</option>`).join('')}</select></label>` : ''}
      <label class="or-field">${esc(t('Pavadinimas'))}<input name="title" maxlength="160" required placeholder="${esc(t('pvz. Sandėlio aikštelė, Vilnius'))}" value="${esc(v.title)}" /></label>
      <div class="or-field"><span>${esc(t('Kokio darbo reikia?'))} <span class="muted small">${esc(t('galima kelis'))}</span></span>
        <div class="or-works pick">${Object.entries(WORKS).map(([k, w]) => `<button type="button" class="or-work ${v.works.includes(k) ? 'on' : ''}" data-work="${k}" aria-pressed="${v.works.includes(k)}">${icon(w.icon)}${esc(t(w.label))}</button>`).join('')}</div>
      </div>
      <label class="or-field">${esc(t('Aprašymas'))}<textarea name="note" rows="4" maxlength="5000" placeholder="${esc(t('Kas tiksliai reikalinga, kokiam tikslui, ypatingi reikalavimai (tikslumas, formatai, prieiga prie teritorijos, kontaktinis asmuo vietoje)…'))}">${esc(v.note)}</textarea></label>
      <div class="or-grid2">
        <label class="or-field">${esc(t('Pageidaujama data'))}<input type="date" name="due" min="${today()}" value="${esc(v.due)}" /></label>
        <label class="or-field">${esc(t('Kontaktinis telefonas'))}<input name="contact" type="tel" maxlength="200" placeholder="+370…" value="${esc(v.contact)}" /></label>
      </div>
      <label class="or-field">${esc(t('Adresas'))}<input name="address" maxlength="300" value="${esc(v.address)}" /></label>
      <div class="or-form-err small bad" hidden></div>
      <div class="or-form-btns">
        <button type="button" class="btn btn-outline" data-or="step1">${icon('back')}${esc(t('Atgal'))}</button>
        <button class="btn btn-primary" type="submit">${icon(v.id ? 'check' : 'send')}${esc(t(v.id ? 'Išsaugoti' : 'Pateikti užsakymą'))}</button>
      </div>
    </form>`;
    setTimeout(() => !view.title && side.querySelector('[name=title]')?.focus(), 30);
  }

  function renderFormArea() {
    const box = $('#or-area');
    if (!box) return;
    const ok = view.poly.length >= 3;
    box.innerHTML = `
      <p class="small">${esc(t('Pažymėkite teritoriją žemėlapyje: spustelėkite jos kampus, užbaikite paspaudę pirmą tašką arba „Baigti“. Raskite vietą paieška viršuje.'))}</p>
      <div class="or-area-big ${ok ? 'ok' : ''}">${icon('area')}<span><span class="muted small">${esc(t('Plotas'))}</span><b>${ok ? esc(fmtArea(areaM2(view.poly))) : '—'}</b>${view.address ? `<span class="small muted">${esc(view.address)}</span>` : ''}</span></div>
      <div class="pane-actions">
        <button class="btn btn-sm btn-outline" data-or="redraw">${icon('area')}${esc(t(ok ? 'Žymėti iš naujo' : 'Žymėti'))}</button>
        <button class="btn btn-sm btn-ghost" data-or="import">${icon('upload')}KML / GeoJSON</button>
      </div>
      ${ok ? `<p class="small muted">${esc(t('Taškus galima tempti; kraštinės vidurio taškas – nauja viršūnė; dešiniu pelės mygtuku – pašalinti.'))}</p>` : ''}
      <div class="or-form-btns"><span></span><button class="btn btn-primary" data-or="step2" ${ok ? '' : 'disabled'}>${esc(t('Toliau'))}<i class="or-fwd">${icon('back')}</i></button></div>`;
  }

  function syncDrawbar() {
    const drawing = view.mode === 'form' && map.mode === 'draw';
    $('#or-drawbar').hidden = !drawing;
    if (drawing) {
      $('#or-drawhint').textContent = map.poly.length < 3 ? t('Spustelėkite teritorijos kampus ({n} pažymėta)', { n: map.poly.length }) : t('Spustelėkite pirmą tašką arba „Baigti“');
      page.querySelector('[data-om=finish]').disabled = map.poly.length < 3;
      page.querySelector('[data-om=undo]').disabled = !map.poly.length;
    }
    const hint = $('#or-maphint');
    hint.hidden = view.mode === 'form' || !visible().length;
    hint.textContent = t('Spustelėkite sritį žemėlapyje – atsidarys užsakymas');
  }

  function readForm() {
    const f = $('#or-form');
    if (!f) return;
    for (const k of ['title', 'note', 'due', 'contact', 'address', 'client_id']) if (f[k]) view[k] = f[k].value;
  }

  async function submitForm() {
    readForm();
    const err = side.querySelector('.or-form-err');
    const fail = (m) => {
      err.textContent = m;
      err.hidden = false;
    };
    if (admin && !view.id && !view.client_id) return fail(t('Pasirinkite klientą'));
    if (!view.title.trim()) return fail(t('Įrašykite pavadinimą'));
    if (!view.works.length) return fail(t('Pasirinkite bent vieną darbą'));
    const ringClosed = [...view.poly, view.poly[0]];
    const body = { title: view.title, works: view.works, note: view.note, due: view.due, contact: view.contact, address: view.address, geometry: { type: 'Polygon', coordinates: [ringClosed] } };
    if (admin && !view.id) body.client_id = +view.client_id;
    const btn = side.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const o = view.id ? await api(`orders/${view.id}`, { method: 'PATCH', body }) : await api('orders', { method: 'POST', body });
      app.toast(t(view.id ? 'Užsakymas atnaujintas' : admin ? 'Užsakymas užregistruotas' : 'Užsakymas pateiktas – su jumis susisieksime'), 'success', 5000);
      await load(true);
      openDetail(o.id);
    } catch (e) {
      fail(e.message);
      btn.disabled = false;
    }
  }

  async function reverseGeocode() {
    view.geocoded = true;
    const [lon, lat] = centroid(view.poly);
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=${locale().slice(0, 2)}&lat=${lat}&lon=${lon}`);
      const j = await r.json();
      const a = j.address || {};
      const street = [a.road || a.pedestrian || a.industrial || a.neighbourhood, a.house_number].filter(Boolean).join(' ');
      const city = a.city || a.town || a.village || a.municipality || '';
      const addr = [street, city].filter(Boolean).join(', ') || j.display_name || '';
      if (view.mode !== 'form') return;
      if (!view.address) view.address = addr;
      if (!view.title && addr) view.title = addr;
      if (view.step === 1) renderFormArea();
    } catch { /* adresas neprivalomas */ }
  }

  // ---------------------------------------------------------------- administratorius: rezultatai
  async function pickResults() {
    const o = view.data;
    let items = [];
    try {
      items = await api('items');
    } catch (e) {
      return app.toast(e.message, 'error');
    }
    const cur = new Set(o.items.map((i) => i.id));
    const d = document.createElement('dialog');
    d.className = 'dialog wide';
    const groups = ['model', 'report', 'recording', 'stream'];
    d.innerHTML = `<form method="dialog">
      <h2>${esc(t('Užsakymo rezultatai'))}</h2>
      <p class="small muted">${esc(t('Pažymėti duomenys bus priskirti klientui „{c}“ ir matomi užsakyme.', { c: o.client?.name || o.client?.email || '' }))}</p>
      <input class="live-input" id="or-pick-q" placeholder="${esc(t('Ieškoti…'))}" />
      <div class="or-pick">${groups
        .map((g) => {
          const list = items.filter((i) => i.kind === g);
          return list.length ? `<h4>${icon(KIND_ICON[g])}${esc(t(KIND_LABEL[g]))}</h4>${list.map((i) => `<label class="row check" data-q="${esc(i.title.toLowerCase())}"><input type="checkbox" value="${i.id}" ${cur.has(i.id) ? 'checked' : ''}/> ${esc(i.title)} <span class="muted small">${esc(new Date(i.updated * 1000).toLocaleDateString(locale()))}</span></label>`).join('')}` : '';
        })
        .join('') || `<p class="muted">${esc(t('Dar nėra įkeltų duomenų – įkelkite skiltyse „3D modeliai“, „Ataskaitos“ ar „Įrašai“.'))}</p>`}</div>
      <menu><button class="btn btn-ghost" type="button" data-cancel>${esc(t('Atšaukti'))}</button><button class="btn btn-primary" value="ok">${esc(t('Išsaugoti'))}</button></menu>
    </form>`;
    document.body.append(d);
    d.querySelector('[data-cancel]').onclick = () => d.close();
    d.querySelector('#or-pick-q').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      d.querySelectorAll('[data-q]').forEach((l) => (l.hidden = q && !l.dataset.q.includes(q)));
    };
    d.querySelector('form').addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'ok') return;
      const ids = [...d.querySelectorAll('.or-pick input:checked')].map((x) => +x.value);
      try {
        view.data = await api(`orders/${o.id}`, { method: 'PATCH', body: { items: ids } });
        renderDetail();
      } catch (ex) {
        app.toast(ex.message, 'error');
      }
    });
    d.addEventListener('close', () => d.remove());
    d.showModal();
  }

  // ---------------------------------------------------------------- įvykiai
  side.addEventListener('click', async (e) => {
    const card = e.target.closest('[data-open]');
    if (card) return openDetail(+card.dataset.open);
    const f = e.target.closest('[data-filter]');
    if (f) {
      filter = f.dataset.filter;
      renderList();
      return fitAll();
    }
    const w = e.target.closest('[data-work]');
    if (w) {
      const k = w.dataset.work;
      view.works = view.works.includes(k) ? view.works.filter((x) => x !== k) : [...view.works, k];
      w.classList.toggle('on', view.works.includes(k));
      w.setAttribute('aria-pressed', view.works.includes(k));
      return;
    }
    const r = e.target.closest('[data-result]');
    if (r) {
      close();
      return app.openResult({ id: +r.dataset.result, kind: r.dataset.kind });
    }
    const act = e.target.closest('[data-or]')?.dataset.or;
    if (!act) return;
    if (act === 'new') {
      if (admin && !users.length) users = await api('users').catch(() => []);
      return openForm();
    }
    if (act === 'back') {
      renderList();
      return fitAll();
    }
    if (act === 'edit') {
      if (admin && !users.length) users = await api('users').catch(() => []);
      return openForm(view.data);
    }
    if (act === 'form-cancel') {
      if (view.poly.length && !view.id && !confirm(t('Atšaukti užsakymą? Pažymėta teritorija bus prarasta.'))) return;
      const back = view.id;
      return back ? openDetail(back) : (renderList(), fitAll());
    }
    if (act === 'redraw') {
      view.poly = [];
      view.geocoded = !!view.address;
      map.startDrawing();
      return renderFormArea();
    }
    if (act === 'import') return $('#or-file').click();
    if (act === 'step2') {
      if (view.poly.length < 3) return;
      view.step = 2;
      return renderForm();
    }
    if (act === 'step1') {
      readForm();
      view.step = 1;
      return renderForm();
    }
    if (act === 'results') return pickResults();
    if (act === 'cancel') {
      if (!confirm(t('Atšaukti užsakymą „{n}“?', { n: view.data.title }))) return;
      try {
        view.data = await api(`orders/${view.id}`, { method: 'PATCH', body: { status: 'cancelled' } });
        await load(true);
        renderDetail();
        map.redraw();
      } catch (ex) {
        app.toast(ex.message, 'error');
      }
      return;
    }
    if (act === 'delete') {
      if (!confirm(t('Ištrinti užsakymą „{n}“ su visa susirašinėjimo istorija? Klientas jo nebematys.', { n: view.data.title }))) return;
      try {
        await api(`orders/${view.id}`, { method: 'DELETE' });
        await load(true);
        renderList();
      } catch (ex) {
        app.toast(ex.message, 'error');
      }
    }
  });

  side.addEventListener('input', (e) => {
    if (e.target.id === 'or-find') {
      query = e.target.value;
      const pos = e.target.selectionStart;
      renderList();
      const inp = $('#or-find');
      inp?.focus();
      inp?.setSelectionRange(pos, pos);
    }
    if (e.target.matches('.or-chat textarea')) {
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
    }
  });

  side.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.matches('.or-chat textarea')) {
      e.preventDefault();
      e.target.form.requestSubmit();
    }
  });

  side.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'or-form') return submitForm();
    if (e.target.id === 'or-chat') {
      const ta = e.target.body;
      const text = ta.value.trim();
      if (!text) return;
      ta.disabled = true;
      try {
        view.data = await api(`orders/${view.id}/comments`, { method: 'POST', body: { body: text } });
        ta.value = '';
        ta.style.height = '';
        const tl = $('#or-timeline');
        tl.innerHTML = timelineHtml(view.data);
        tl.scrollTop = tl.scrollHeight;
      } catch (ex) {
        app.toast(ex.message, 'error');
      } finally {
        ta.disabled = false;
        ta.focus();
      }
      return;
    }
    if (e.target.id === 'or-admin') {
      const f = e.target;
      const body = { status: f.status.value, planned: f.planned.value, price: f.price.value, admin_note: f.admin_note.value };
      try {
        view.data = await api(`orders/${view.id}`, { method: 'PATCH', body });
        await load(true);
        renderDetail();
        map.redraw();
        app.toast(t('Išsaugota'), 'success');
      } catch (ex) {
        app.toast(ex.message, 'error');
      }
    }
  });

  $('#or-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f || view.mode !== 'form') return;
    try {
      const pts = parseArea(await f.text());
      map.setPolygon(pts);
      map.fit(pts);
    } catch (err) {
      app.toast(t(err.message), 'error', 6000);
    }
  });

  // Žemėlapio mygtukai ir paieška
  page.addEventListener('click', (e) => {
    const b = e.target.closest('[data-om]');
    if (!b) {
      if (!e.target.closest('#or-search')) $('#or-results').hidden = true;
      return;
    }
    const a = b.dataset.om;
    if (a === 'finish') map.finish();
    else if (a === 'undo') {
      map.undo();
      syncDrawbar();
    } else if (a === 'fit') fitAll();
    else if (a === 'basemap') {
      map.basemap = map.basemap === 'satellite' ? 'osm' : 'satellite';
      map.redraw();
    } else if (a === 'locate') {
      if (!navigator.geolocation) return app.toast(t('Naršyklė nepalaiko vietos nustatymo'), 'error');
      navigator.geolocation.getCurrentPosition(
        (p) => map.setView(p.coords.longitude, p.coords.latitude, 17),
        (err) => app.toast(t('Vietos nustatyti nepavyko: {e}', { e: err.message }), 'error'),
        { enableHighAccuracy: true, timeout: 10000 },
      );
    }
  });
  $('#or-map').addEventListener('pointermove', () => view.mode === 'form' && map.mode === 'draw' && syncDrawbar());
  $('#or-map').addEventListener('pointerup', () => setTimeout(syncDrawbar));

  $('#or-search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#or-q').value.trim();
    const box = $('#or-results');
    if (!q) return;
    const c = q.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/);
    if (c) {
      const a = parseFloat(c[1].replace(',', '.')), b = parseFloat(c[2].replace(',', '.'));
      box.hidden = true;
      return Math.abs(a) <= 90 ? map.setView(b, a, 17) : map.setView(a, b, 17);
    }
    box.hidden = false;
    box.innerHTML = `<div class="muted small or-res-wait">${esc(t('Ieškoma…'))}</div>`;
    try {
      // Nominatim: paieška tik paspaudus (jų taisyklės draudžia automatinį pildymą rašant)
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=${locale().slice(0, 2)}&q=${encodeURIComponent(q)}`);
      const hits = await r.json();
      box.innerHTML = hits.length
        ? hits.map((h, i) => `<button type="button" data-hit="${i}">${icon('pin')}<span>${esc(h.display_name)}</span></button>`).join('')
        : `<div class="muted small or-res-wait">${esc(t('Nieko nerasta'))}</div>`;
      box.onclick = (ev) => {
        const h = hits[+ev.target.closest('[data-hit]')?.dataset.hit];
        if (!h) return;
        box.hidden = true;
        const bb = h.boundingbox?.map(Number);
        if (bb && bb[1] - bb[0] < 0.05) map.fit([[bb[2], bb[0]], [bb[3], bb[1]]]);
        else map.setView(+h.lon, +h.lat, 17);
      };
    } catch (err) {
      box.innerHTML = `<div class="small bad or-res-wait">${esc(t('Paieška nepavyko: {e}', { e: err.message }))}</div>`;
    }
  });

  page.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
      if (!$('#or-results').hidden) return ($('#or-results').hidden = true);
      if (view.mode === 'form' && map.mode === 'draw' && map.poly.length) return map.undo(), syncDrawbar();
      if (view.mode !== 'list') return renderList();
      close();
    }
  });

  // Naujienos (kita pusė parašė ar pakeitė būseną) – atnaujinama kas 30 s, kol langas atidarytas
  async function refresh() {
    if (page.hidden || document.hidden) return;
    const before = JSON.stringify(orders.map((o) => [o.id, o.updated, o.unread]));
    await load(true);
    if (JSON.stringify(orders.map((o) => [o.id, o.updated, o.unread])) === before) return;
    if (view.mode === 'list') renderList();
    else if (view.mode === 'detail') {
      const o = orders.find((x) => x.id === view.id);
      if (!o) return renderList();
      if (o.updated === view.data.updated) return;
      const data = await api(`orders/${view.id}`).catch(() => null);
      if (!data || view.mode !== 'detail' || view.id !== data.id) return;
      // Tik eiga – administratoriaus laukeliai ir rašoma žinutė neperrašomi
      view.data = data;
      const tl = $('#or-timeline');
      const atEnd = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 40;
      tl.innerHTML = timelineHtml(data);
      if (atEnd) tl.scrollTop = tl.scrollHeight;
    }
    map.redraw();
  }

  async function open(id) {
    page.hidden = false;
    document.body.classList.add('portal-open');
    await load();
    if (id) openDetail(id);
    else {
      renderList();
      fitAll();
    }
    clearInterval(poll);
    poll = setInterval(refresh, 30000);
  }
  function close() {
    page.hidden = true;
    clearInterval(poll);
    document.body.classList.remove('portal-open');
  }

  return {
    open,
    close,
    get isOpen() {
      return !page.hidden;
    },
    rerender() {
      if (page.hidden) return;
      if (view.mode === 'list') renderList();
      else if (view.mode === 'detail') renderDetail();
      else {
        readForm();
        renderForm();
      }
    },
    /** Pradžios ekranui: kiek užsakymų su naujienomis (admin – ir nauji). */
    async counts() {
      const list = await api('orders');
      return { total: list.length, unread: list.filter((o) => o.unread).length };
    },
  };
}
