// Automobilių pavyzdžių galerija (tik administratoriui): perskaitytų numerių automobiliai patvirtinami arba
// pataisomi (markė, modelis, spalva, kėbulas), jų iškarpos išsaugomos AI paslaugoje kaip pavyzdžiai. Atpažįstant
// naujus automobilius jie lyginami ir su šiais pavyzdžiais – iš to paties aukščio ir kampo, kaip filmuojama.
// Klientams kortelė nerodoma, o AI paslaugos /ai/gallery keliai serveryje leidžiami tik administratoriui.
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { vehicleShort } from './plates.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const blobOf = (c) => new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
const thumb = (c, w = 320) => {
  const k = Math.min(1, w / c.width), x = document.createElement('canvas');
  x.width = Math.round(c.width * k);
  x.height = Math.round(c.height * k);
  x.getContext('2d').drawImage(c, 0, 0, x.width, x.height);
  return x.toDataURL('image/jpeg', 0.85);
};

/**
 * @param {{after:HTMLElement, getAi:()=>Promise<import('../ai/client.js').AiClient>, plates:()=>import('./plates.js').PlateBook[], toast:Function, isAdmin:()=>boolean}} o
 */
export function createGalleryUI(o) {
  const card = document.createElement('section');
  card.className = 'card admin-only';
  card.dataset.card = 'gallery';
  card.innerHTML = `
    <h3>${esc(t('Automobilių pavyzdžiai'))}</h3>
    <p class="small muted">${esc(t('Patvirtinkite ar pataisykite atpažintų automobilių markę ir modelį – jie tampa pavyzdžiais, ir AI vis geriau atpažįsta automobilius iš jūsų drono vaizdo. Matoma tik administratoriui.'))}</p>
    <div id="gal-sum" class="small muted"></div>
    <div class="pane-actions">
      <button class="btn btn-sm btn-primary" data-gal="review">${icon('check')}<span id="gal-rev-l"></span></button>
      <button class="btn btn-sm btn-outline" data-gal="list">${esc(t('Galerija'))}</button>
    </div>`;
  o.after.after(card);

  const dlg = document.createElement('dialog');
  dlg.className = 'dialog gal-dialog';
  document.body.append(dlg);

  let opts = null; // {cars, heavy, colors, bodies}
  let total = null;
  const done = new WeakSet(); // jau patvirtinti / praleisti įrašai

  const pending = () =>
    o
      .plates()
      .flatMap((b) => b.recs)
      .filter((r) => r.sure && r.vcrops?.length && !done.has(r));

  async function refresh() {
    if (!o.isAdmin()) return;
    card.querySelector('#gal-rev-l').textContent = t('Tikrinti automobilius ({n})', { n: pending().length });
    try {
      const ai = await o.getAi();
      const g = await ai.galleryList();
      total = g.total;
      card.querySelector('#gal-sum').textContent = t('Galerijoje: {n} pavyzdžių, {m} skirtingų automobilių', { n: g.total, m: Object.keys(g.counts).length });
    } catch (e) {
      card.querySelector('#gal-sum').textContent = e.message;
    }
  }

  async function loadOpts() {
    if (!opts) opts = await (await o.getAi()).galleryOptions();
    return opts;
  }

  function form(r) {
    const heavy = r.cls === 'truck' || r.cls === 'bus';
    const table = heavy ? opts.heavy : opts.cars;
    const v = r.veh || {};
    const val = (a) => a?.value || '';
    return `
      <div class="gal-rec">
        <img src="${thumb(r.photo || r.vcrops[0].c, 420)}" alt="" />
        <div>
          <div><span class="plate-chip">${esc(r.text)}</span> <span class="small muted">${esc(t('AI'))}: ${esc(vehicleShort(v) || t('neatpažinta'))}</span></div>
          <label class="row">${esc(t('Markė'))} <input id="gal-make" list="gal-makes" value="${esc(val(v.make))}" autocomplete="off" /></label>
          <datalist id="gal-makes">${Object.keys(table).map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
          <label class="row">${esc(t('Modelis'))} <input id="gal-model" list="gal-models" value="${esc(val(v.model))}" autocomplete="off" /></label>
          <datalist id="gal-models"></datalist>
          <label class="row">${esc(t('Spalva'))} <select id="gal-color"><option value="">–</option>${Object.entries(opts.colors).map(([k, l]) => `<option value="${esc(k)}" ${val(v.color) === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label class="row">${esc(t('Kėbulas'))} <select id="gal-body"><option value="">–</option>${Object.entries(opts.bodies).map(([k, l]) => `<option value="${esc(k)}" ${val(v.body) === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <p class="small muted">${esc(t('Palikite tuščią, ko nežinote – geriau nieko, nei klaida.'))}</p>
        </div>
      </div>`;
  }

  function fillModels(r) {
    const heavy = r.cls === 'truck' || r.cls === 'bus';
    const table = heavy ? opts.heavy : opts.cars;
    const make = dlg.querySelector('#gal-make').value.trim();
    const key = Object.keys(table).find((m) => m.toLowerCase() === make.toLowerCase());
    dlg.querySelector('#gal-models').innerHTML = (table[key] || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
  }

  async function review() {
    try {
      await loadOpts();
    } catch (e) {
      return o.toast(e.message, 'error', 6000);
    }
    const list = pending();
    if (!list.length) return o.toast(t('Naujų automobilių su perskaitytu numeriu nėra.'), 'info', 4000);
    let i = 0;
    const show = () => {
      const r = list[i];
      dlg.innerHTML = `<form method="dialog">
        <h2>${esc(t('Automobilis {i} iš {n}', { i: i + 1, n: list.length }))}</h2>
        ${form(r)}
        <menu>
          <button value="close" class="btn btn-ghost" formnovalidate>${esc(t('Uždaryti'))}</button>
          <button value="skip" class="btn btn-outline" formnovalidate>${esc(t('Praleisti'))}</button>
          <button value="ok" class="btn btn-primary">${esc(t('Patvirtinti'))}</button>
        </menu></form>`;
      fillModels(r);
      dlg.querySelector('#gal-make').addEventListener('input', () => fillModels(r));
    };
    dlg.onclose = async () => {
      const act = dlg.returnValue;
      const r = list[i];
      if (act === 'ok') {
        const meta = {
          make: dlg.querySelector('#gal-make').value.trim(),
          model: dlg.querySelector('#gal-model').value.trim(),
          color: dlg.querySelector('#gal-color').value,
          body: dlg.querySelector('#gal-body').value,
          kind: r.cls || 'car',
          plate: r.text,
        };
        if (!meta.make && !meta.color && !meta.body) {
          o.toast(t('Nurodykite bent markę, spalvą ar kėbulą.'), 'error', 5000);
          return dlg.showModal();
        }
        try {
          const ai = await o.getAi();
          const res = await ai.galleryAdd(await Promise.all(r.vcrops.map((x) => blobOf(x.c))), meta);
          // Patvirtinti duomenys – ir šio įrašo ataskaitai
          const conf = (value, ltName) => (value ? { value, p: 1, confirmed: true, ...(ltName ? { lt: ltName } : {}) } : null);
          r.veh = {
            ...(r.veh || {}),
            ...(meta.make ? { make: conf(meta.make) } : {}),
            ...(meta.model ? { model: conf(meta.model) } : {}),
            ...(meta.color ? { color: conf(meta.color, opts.colors[meta.color]) } : {}),
            ...(meta.body ? { body: conf(meta.body, opts.bodies[meta.body]) } : {}),
          };
          r.galleryGroup = res.group;
          done.add(r);
          o.toast(t('Išsaugota. Galerijoje: {n} pavyzdžių.', { n: res.total }), 'success', 3000);
        } catch (e) {
          o.toast(e.message, 'error', 7000);
          return dlg.showModal();
        }
      } else if (act === 'skip') done.add(r);
      else return refresh();
      if (++i < list.length) {
        show();
        dlg.showModal();
      } else refresh();
    };
    show();
    dlg.showModal();
  }

  async function gallery() {
    let g, ai;
    try {
      ai = await o.getAi();
      g = await ai.galleryList();
    } catch (e) {
      return o.toast(e.message, 'error', 6000);
    }
    // Vienas patvirtinimas = grupė (kelios to paties automobilio iškarpos) – rodoma viena nuotrauka
    const groups = [];
    for (const it of g.items) {
      const k = it.group || it.id;
      let x = groups.find((y) => y.k === k);
      if (!x) groups.push((x = { k, it, n: 0, ids: [] }));
      x.n++;
      x.ids.push(it.id);
    }
    dlg.innerHTML = `<form method="dialog">
      <h2>${esc(t('Galerija ({n} pavyzdžių)', { n: g.total }))}</h2>
      <div class="gal-grid">${
        groups
          .map(({ k, it, n, ids }) => `<figure data-gk="${esc(k)}"><img src="${esc(ai.galleryImg(it.id))}" alt="" loading="lazy" />${ids.length > 1 ? `<div class="gal-strip">${ids.slice(1).map((i) => `<img src="${esc(ai.galleryImg(i))}" alt="" loading="lazy" />`).join('')}</div>` : ''}<figcaption><b>${esc([it.make, it.model].filter(Boolean).join(' ') || '–')}</b><br><span class="small muted">${esc([opts?.colors?.[it.color] || it.color, opts?.bodies?.[it.body] || it.body, it.plate].filter(Boolean).join(' · '))}${n > 1 ? ` · ×${n}` : ''}</span></figcaption><button type="button" class="btn btn-ghost btn-sm icon-only danger" data-gdel="${esc(k)}" title="${esc(t('Ištrinti'))}">${icon('trash')}</button></figure>`)
          .join('') || `<p class="small muted">${esc(t('Dar nėra pavyzdžių.'))}</p>`
      }</div>
      <menu><button value="close" class="btn btn-primary">${esc(t('Uždaryti'))}</button></menu></form>`;
    dlg.onclose = () => refresh();
    dlg.showModal();
  }

  dlg.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-gdel]');
    if (!b) return;
    if (!confirm(t('Ištrinti šį pavyzdį?'))) return;
    try {
      await (await o.getAi()).galleryDelete([b.dataset.gdel]);
      b.closest('figure').remove();
    } catch (ex) {
      o.toast(ex.message, 'error', 6000);
    }
  });
  card.addEventListener('click', (e) => {
    const b = e.target.closest('[data-gal]');
    if (!b) return;
    if (b.dataset.gal === 'review') review();
    else {
      loadOpts().catch(() => {});
      gallery();
    }
  });

  return {
    refresh,
    /** Kviečiama periodiškai – atnaujinamas laukiančių skaičius mygtuke (be užklausų serveriui). */
    tick() {
      if (o.isAdmin()) card.querySelector('#gal-rev-l').textContent = t('Tikrinti automobilius ({n})', { n: pending().length });
    },
    get total() {
      return total;
    },
  };
}
