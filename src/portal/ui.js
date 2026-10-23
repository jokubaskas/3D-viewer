// „Mano sritis“: skiltys „Mano 3D modeliai“, „Mano gyvos transliacijos“, „Mano ataskaitos“, „Mano įrašai“
// (klientui – tik jam priskirti), administratoriui dar – įkėlimas, priskyrimas klientams ir skiltis „Klientai“.
import { icon } from '../icons.js';
import { t, locale } from '../i18n.js';
import { api, uploadFile, fileUrl } from './api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (s) => (s ? new Date(s * 1000).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);
const INLINE = /\.(pdf|png|jpe?g|webp|mp4|webm|txt|csv)$/i;

const TABS = [
  { id: 'model', label: 'Mano 3D modeliai', icon: 'cube', empty: 'Dar nėra priskirtų 3D modelių.' },
  { id: 'stream', label: 'Mano gyvos transliacijos', icon: 'live', empty: 'Dar nėra priskirtų transliacijų.' },
  { id: 'report', label: 'Mano ataskaitos', icon: 'report', empty: 'Dar nėra ataskaitų.' },
  { id: 'recording', label: 'Mano įrašai', icon: 'record', empty: 'Dar nėra įrašų.' },
];

/**
 * @param {{user:{id:number,email:string,name:string,role:string}, toast:Function, loading:(on:boolean,text?:string,p?:number|null)=>void,
 *   openModel:(files:File[], name:string)=>Promise<void>, openStream:(item:object)=>Promise<void>, lastModelFiles:()=>File[]|null}} app
 */
export function createPortalUI(app) {
  const admin = app.user.role === 'admin';
  let tab = 'model';
  let items = [];
  let users = [];
  const uploads = new Map(); // item.id → eiga 0…1

  const page = document.createElement('section');
  page.className = 'odm-page portal-page';
  page.hidden = true;
  page.innerHTML = `
    <header class="odm-head">
      <div><h2 id="pt-title">Mano sritis</h2><p class="muted small" id="pt-who"></p></div>
      <button class="btn btn-ghost icon-only" data-pa="close" title="Uždaryti">${icon('close')}</button>
    </header>
    <nav class="pt-tabs" id="pt-tabs"></nav>
    <div class="pt-body" id="pt-body"></div>`;
  document.getElementById('app').append(page);
  const $ = (s) => page.querySelector(s);
  $('#pt-who').textContent = `${app.user.name || app.user.email} · ${t(admin ? 'administratorius' : 'klientas')}`;

  // Administratoriui – be „Mano“ (jis valdo visų klientų duomenis)
  const adminLabel = (l) => {
    const r = l.replace(/^Mano /, '');
    return r.charAt(0).toUpperCase() + r.slice(1);
  };
  const tabs = admin ? [...TABS.map((x) => ({ ...x, label: adminLabel(x.label) })), { id: 'clients', label: 'Klientai', icon: 'user' }] : TABS;

  async function load() {
    try {
      [items, users] = await Promise.all([api('items'), admin ? api('users') : Promise.resolve([])]);
    } catch (e) {
      app.toast(e.message, 'error');
    }
    render();
  }

  function render() {
    // Antraštė – pasirinktos skilties pavadinimas (į skiltis patenkama iš pradžios ekrano)
    $('#pt-title').textContent = t(tabs.find((x) => x.id === tab)?.label || 'Mano sritis');
    $('#pt-tabs').innerHTML = tabs
      .map((x) => {
        const n = x.id === 'clients' ? users.filter((u) => u.role === 'client').length : items.filter((i) => i.kind === x.id).length;
        return `<button class="pt-tab ${tab === x.id ? 'active' : ''}" data-ptab="${x.id}">${icon(x.icon)}<span>${esc(t(x.label))}</span><b>${n}</b></button>`;
      })
      .join('');
    $('#pt-body').innerHTML = tab === 'clients' ? clientsHtml() : itemsHtml(tab);
  }

  // ---------------------------------------------------------------- duomenys
  const clientName = (id) => {
    const u = users.find((x) => x.id === id);
    return u ? u.name || u.email : `#${id}`;
  };

  function itemsHtml(kind) {
    const list = items.filter((i) => i.kind === kind);
    const def = TABS.find((x) => x.id === kind);
    let head = '';
    if (admin) {
      head =
        kind === 'stream'
          ? `<div class="pt-hint small muted">${icon('live')}${esc(t('Transliaciją klientui priskirsite transliacijos puslapyje: prie rodomos transliacijos spauskite „Priskirti klientams“. Šaltinio adresas ir raktai lieka serveryje – klientas jų nemato.'))}</div>`
          : `<div class="pane-actions"><button class="btn btn-primary" data-pa="new">${icon('upload')}${esc(t('Įkelti naują'))}</button>${kind === 'model' && app.lastModelFiles() ? `<button class="btn btn-outline" data-pa="new-open">${icon('upload')}${esc(t('Įkelti dabar atidarytą modelį'))}</button>` : ''}</div>`;
    }
    if (!list.length) return `${head}<div class="pt-empty muted">${esc(t(def.empty))}</div>`;
    return `${head}<div class="pt-grid">${list.map(cardHtml).join('')}</div>`;
  }

  function cardHtml(i) {
    const up = uploads.get(i.id);
    const files = i.files || [];
    let main = '';
    if (i.kind === 'model') main = files.length ? `<button class="btn btn-primary btn-sm" data-pa="open">${icon('cube')}${esc(t('Atidaryti 3D'))}</button>` : '';
    else if (i.kind === 'stream') main = `<button class="btn btn-primary btn-sm" data-pa="watch">${icon('play')}${esc(t('Žiūrėti'))}</button>`;
    const fileRows =
      i.kind === 'stream'
        ? ''
        : `<ul class="pt-files">${files
            .map(
              (f) => `<li><span title="${esc(f.name)}">${esc(f.name)}</span><span class="muted">${fmtSize(f.size)}</span>
              ${INLINE.test(f.name) ? `<a class="btn btn-ghost btn-sm icon-only" href="${fileUrl(i, f)}" target="_blank" rel="noopener" title="${esc(t('Peržiūrėti'))}">${icon('eye')}</a>` : ''}
              <a class="btn btn-ghost btn-sm icon-only" href="${fileUrl(i, f, true)}" title="${esc(t('Atsisiųsti'))}">${icon('save')}</a>
              ${admin ? `<button class="btn btn-ghost btn-sm icon-only danger" data-pa="rmfile" data-fid="${f.id}" title="${esc(t('Ištrinti failą'))}">${icon('trash')}</button>` : ''}</li>`,
            )
            .join('')}</ul>`;
    const adm = admin
      ? `<div class="pt-clients small">${icon('eye')}${i.clients?.length ? i.clients.map((c) => `<span class="chip">${esc(clientName(c))}</span>`).join(' ') : `<span class="muted">${esc(t('Nepriskirta – mato tik administratorius'))}</span>`}</div>
         <div class="pane-actions">
           <button class="btn btn-outline btn-sm" data-pa="assign">${esc(t('Priskirti klientams'))}</button>
           ${i.kind !== 'stream' ? `<button class="btn btn-ghost btn-sm" data-pa="addfiles">${icon('upload')}${esc(t('Pridėti failų'))}</button>` : ''}
           <button class="btn btn-ghost btn-sm icon-only" data-pa="edit" title="${esc(t('Redaguoti'))}">${icon('edit')}</button>
           <button class="btn btn-ghost btn-sm icon-only danger" data-pa="del" title="${esc(t('Ištrinti'))}">${icon('trash')}</button>
         </div>`
      : '';
    return `<article class="pt-card" data-item="${i.id}">
      <div class="pt-card-head"><b>${esc(i.title)}</b><span class="muted small">${fmtDate(i.updated)}</span></div>
      ${i.note ? `<p class="small">${esc(i.note)}</p>` : ''}
      ${i.kind !== 'stream' ? `<div class="small muted">${esc(t('{n} failų · {s}', { n: files.length, s: fmtSize(i.size || 0) }))}</div>` : ''}
      ${up != null ? `<div class="progress"><div class="progress-bar" style="width:${Math.round(up * 100)}%"></div></div>` : ''}
      ${main ? `<div class="pane-actions">${main}</div>` : ''}
      ${fileRows}${adm}
    </article>`;
  }

  // ---------------------------------------------------------------- klientai (admin)
  function clientsHtml() {
    const cnt = (id) => items.filter((i) => i.clients?.includes(id)).length;
    return `<form class="pt-newuser" id="pt-newuser" autocomplete="off">
        <input name="email" type="email" placeholder="${esc(t('El. paštas'))}" required />
        <input name="name" placeholder="${esc(t('Vardas / įmonė'))}" />
        <select name="role"><option value="client">${esc(t('Klientas'))}</option><option value="admin">${esc(t('Administratorius'))}</option></select>
        <button class="btn btn-primary" type="submit">${esc(t('Sukurti paskyrą'))}</button>
      </form>
      <div id="pt-invite"></div>
      <table class="pt-users"><thead><tr><th>${esc(t('Vartotojas'))}</th><th>${esc(t('Vaidmuo'))}</th><th>${esc(t('Būsena'))}</th><th>${esc(t('Paskutinis prisijungimas'))}</th><th>${esc(t('Priskirta'))}</th><th></th></tr></thead><tbody>
      ${users
        .map(
          (u) => `<tr data-user="${u.id}"><td><b>${esc(u.name || '—')}</b><div class="small muted">${esc(u.email)}</div></td>
          <td>${esc(t(u.role === 'admin' ? 'Administratorius' : 'Klientas'))}</td>
          <td>${u.disabled ? `<span class="chip">${esc(t('Išjungta'))}</span>` : u.has_password ? `<span class="chip ok">${esc(t('Aktyvi'))}</span>` : `<span class="chip run">${esc(t('Laukia slaptažodžio'))}</span>`}</td>
          <td class="small">${fmtDate(u.last_login)}</td><td>${u.role === 'client' ? cnt(u.id) : '—'}</td>
          <td><div class="pt-actions">${u.id === app.user.id ? `<span class="small muted">${esc(t('tai jūs'))}</span>` : `
            <button class="btn btn-ghost btn-sm" data-pu="invite">${esc(t(u.has_password ? 'Slaptažodžio keitimo nuoroda' : 'Nauja kvietimo nuoroda'))}</button>
            <button class="btn btn-ghost btn-sm" data-pu="toggle">${esc(t(u.disabled ? 'Įjungti' : 'Išjungti'))}</button>
            <button class="btn btn-ghost btn-sm icon-only danger" data-pu="del" title="${esc(t('Ištrinti'))}">${icon('trash')}</button>`}</div></td></tr>`,
        )
        .join('')}</tbody></table>
      <p class="small muted">${esc(t('Kvietimo nuoroda galioja 7 dienas ir tik vieną kartą. Nusiųskite ją klientui – jis pats nusistatys slaptažodį. Išjungus paskyrą klientas iškart atjungiamas.'))}</p>`;
  }

  function showInvite(email, link) {
    const subject = encodeURIComponent(t('Prieiga prie Atea 3D Matuoklio'));
    const body = encodeURIComponent(t('Sveiki,\n\nsukūrėme jums paskyrą. Atidarykite nuorodą ir nusistatykite slaptažodį (nuoroda galioja 7 dienas):\n\n{l}\n', { l: link }));
    $('#pt-invite').innerHTML = `<div class="pt-invite"><div class="small">${esc(t('Nuoroda vartotojui {e}:', { e: email }))}</div>
      <input readonly value="${esc(link)}" />
      <div class="pane-actions"><button class="btn btn-sm btn-primary" data-pi="copy">${icon('copy')}${esc(t('Kopijuoti'))}</button><a class="btn btn-sm btn-outline" href="mailto:${esc(email)}?subject=${subject}&body=${body}">${esc(t('Siųsti el. paštu'))}</a></div></div>`;
  }

  // ---------------------------------------------------------------- dialogai
  function dialog(html, onOk) {
    const d = document.createElement('dialog');
    d.className = 'dialog';
    d.innerHTML = `<form method="dialog">${html}<div class="auth-err" hidden></div><menu><button class="btn btn-ghost" type="button" data-cancel>${esc(t('Atšaukti'))}</button><button class="btn btn-primary" value="ok">${esc(t('Gerai'))}</button></menu></form>`;
    document.body.append(d);
    const f = d.querySelector('form');
    d.querySelector('[data-cancel]').addEventListener('click', () => d.close());
    f.addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'ok') return;
      e.preventDefault();
      try {
        await onOk(f, d);
        d.close();
      } catch (ex) {
        const err = d.querySelector('.auth-err');
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
    d.addEventListener('close', () => d.remove());
    d.showModal();
    return d;
  }
  const clientChecks = (sel = []) => {
    // Išjungti klientai rodomi tik jei jau priskirti – pažymėti ir neaktyvūs, kad išsaugojus priskyrimas nedingtų
    const cl = users.filter((u) => u.role === 'client' && (!u.disabled || sel.includes(u.id)));
    return cl.length
      ? `<div class="pt-checks">${cl.map((u) => `<label class="check small"><input type="checkbox" name="client" value="${u.id}" ${sel.includes(u.id) ? 'checked' : ''} ${u.disabled ? 'disabled' : ''}/> ${esc(u.name || u.email)} <span class="muted">${esc(u.name ? u.email : '')}${u.disabled ? ` · ${esc(t('išjungta'))}` : ''}</span></label>`).join('')}</div>`
      : `<p class="small muted">${esc(t('Dar nėra klientų – sukurkite juos skiltyje „Klientai“.'))}</p>`;
  };
  const checked = (f) => [...f.querySelectorAll('input[name=client]:checked')].map((x) => +x.value);

  /** Naujas įrašas su failais (modelis / ataskaita / įrašas). */
  function newItemDialog(kind, presetFiles = null) {
    const title = presetFiles ? presetFiles[0]?.name.replace(/\.[^.]+$/, '') : '';
    dialog(
      `<h2>${esc(t(tabs.find((x) => x.id === kind).label))}: ${esc(t('naujas'))}</h2>
       <label class="row">${esc(t('Pavadinimas'))} <input name="title" class="num wide" style="text-align:left;width:260px" value="${esc(title)}" required /></label>
       <label class="row">${esc(t('Pastaba'))} <input name="note" class="num wide" style="text-align:left;width:260px" /></label>
       ${presetFiles ? `<p class="small">${esc(t('{n} failų iš atidaryto modelio', { n: presetFiles.length }))}</p>` : `<label class="row">${esc(t('Failai'))} <input name="files" type="file" multiple required /></label>
       <p class="small muted">${esc(kind === 'model' ? t('3D: OBJ + MTL + tekstūros, GLB, PLY, LAS/LAZ, ZIP (pvz. ODM rezultatai). Kelis failus galima pasirinkti kartu.') : t('PDF ataskaitos, AI įrašų ZIP, vaizdo įrašai, GPX, CSV ir kt.'))}</p>`}
       <div class="small">${esc(t('Kam matoma:'))}</div>${clientChecks()}`,
      async (f) => {
        const files = presetFiles || [...f.files.files];
        if (!files.length) throw new Error(t('Pasirinkite failus'));
        const it = await api('items', { method: 'POST', body: { kind, title: f.title.value, note: f.note.value, clients: checked(f) } });
        items.unshift(it);
        render();
        uploadAll(it, files);
      },
    );
  }

  async function uploadAll(it, files) {
    const total = files.reduce((a, f) => a + f.size, 0) || 1;
    let done = 0;
    uploads.set(it.id, 0);
    render();
    try {
      for (const file of files) {
        await uploadFile(it.id, file, file.webkitRelativePath || file.name, (p) => {
          uploads.set(it.id, (done + p * file.size) / total);
          const bar = page.querySelector(`[data-item="${it.id}"] .progress-bar`);
          if (bar) bar.style.width = `${Math.round(uploads.get(it.id) * 100)}%`;
        });
        done += file.size;
      }
      app.toast(t('Įkelta: {n}', { n: it.title }), 'success');
    } catch (e) {
      app.toast(t('Įkelti nepavyko: {e}', { e: e.message }), 'error', 8000);
    } finally {
      uploads.delete(it.id);
      load();
    }
  }

  // ---------------------------------------------------------------- veiksmai
  page.addEventListener('click', async (e) => {
    const tb = e.target.closest('[data-ptab]');
    if (tb) {
      tab = tb.dataset.ptab;
      return render();
    }
    if (e.target.closest('[data-pi=copy]')) {
      const inp = page.querySelector('.pt-invite input');
      await navigator.clipboard.writeText(inp.value).catch(() => inp.select());
      return app.toast(t('Nukopijuota'));
    }
    const pu = e.target.closest('[data-pu]');
    if (pu) return userAction(pu.dataset.pu, +pu.closest('[data-user]').dataset.user);
    const b = e.target.closest('[data-pa]');
    if (!b) return;
    const act = b.dataset.pa;
    if (act === 'close') return close();
    if (act === 'new') return newItemDialog(tab);
    if (act === 'new-open') return newItemDialog('model', app.lastModelFiles());
    const it = items.find((x) => x.id === +b.closest('[data-item]')?.dataset.item);
    if (!it) return;
    try {
      if (act === 'open') await openModel(it);
      else if (act === 'watch') {
        close();
        await app.openStream(it);
      } else if (act === 'assign')
        dialog(`<h2>${esc(t('Kam matoma: {n}', { n: it.title }))}</h2>${clientChecks(it.clients || [])}`, async (f) => {
          await api(`items/${it.id}`, { method: 'PATCH', body: { clients: checked(f) } });
          load();
        });
      else if (act === 'addfiles') {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.multiple = true;
        inp.onchange = () => inp.files.length && uploadAll(it, [...inp.files]);
        inp.click();
      } else if (act === 'edit')
        dialog(
          `<h2>${esc(t('Redaguoti'))}</h2>
           <label class="row">${esc(t('Pavadinimas'))} <input name="title" class="num wide" style="text-align:left;width:260px" value="${esc(it.title)}" required /></label>
           <label class="row">${esc(t('Pastaba'))} <input name="note" class="num wide" style="text-align:left;width:260px" value="${esc(it.note)}" /></label>`,
          async (f) => {
            await api(`items/${it.id}`, { method: 'PATCH', body: { title: f.title.value, note: f.note.value } });
            load();
          },
        );
      else if (act === 'del') {
        if (!confirm(t('Ištrinti „{n}“ su visais failais? Klientai jo nebematys.', { n: it.title }))) return;
        await api(`items/${it.id}`, { method: 'DELETE' });
        load();
      } else if (act === 'rmfile') {
        const f = it.files.find((x) => x.id === +b.dataset.fid);
        if (!confirm(t('Ištrinti failą {n}?', { n: f?.name }))) return;
        await api(`items/${it.id}/files/${b.dataset.fid}`, { method: 'DELETE' });
        load();
      }
    } catch (ex) {
      app.toast(ex.message, 'error', 7000);
    }
  });

  page.addEventListener('submit', async (e) => {
    if (e.target.id !== 'pt-newuser') return;
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('users', { method: 'POST', body: { email: f.email.value, name: f.name.value, role: f.role.value } });
      const email = f.email.value;
      users = await api('users');
      render();
      showInvite(email, r.invite);
    } catch (ex) {
      app.toast(ex.message, 'error', 7000);
    }
  });

  async function userAction(act, id) {
    const u = users.find((x) => x.id === id);
    try {
      if (act === 'invite') {
        const r = await api(`users/${id}/invite`, { method: 'POST' });
        users = await api('users');
        render();
        showInvite(u.email, r.invite);
      } else if (act === 'toggle') {
        await api(`users/${id}`, { method: 'PATCH', body: { disabled: !u.disabled } });
        load();
      } else if (act === 'del') {
        if (!confirm(t('Ištrinti paskyrą {e}? Jos priskyrimai bus pašalinti (duomenys lieka).', { e: u.email }))) return;
        await api(`users/${id}`, { method: 'DELETE' });
        load();
      }
    } catch (ex) {
      app.toast(ex.message, 'error', 7000);
    }
  }

  /** Modelio failai iš serverio → 3D peržiūra (failai lieka tik naršyklės atmintyje). */
  async function openModel(it) {
    const files = [];
    const total = it.size || 1;
    let got = 0;
    app.loading(true, t('Atsisiunčiama…'), 0);
    try {
      for (const f of it.files) {
        const r = await fetch(fileUrl(it, f, true), { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const reader = r.body.getReader();
        const parts = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          got += value.length;
          app.loading(true, t('Atsisiunčiama… {p} %', { p: Math.round((100 * got) / total) }), got / total);
        }
        files.push(new File(parts, f.name.split('/').pop()));
      }
    } catch (e) {
      app.loading(false);
      throw new Error(t('Nepavyko atsisiųsti: {e}', { e: e.message }));
    }
    close();
    await app.openModel(files, it.title);
  }

  function open(which) {
    if (which) tab = which;
    page.hidden = false;
    document.body.classList.add('portal-open');
    load();
  }
  function close() {
    page.hidden = true;
    document.body.classList.remove('portal-open');
  }
  page.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) close();
  });

  return {
    open,
    close,
    get isOpen() {
      return !page.hidden;
    },
    rerender: render,
    reload: load,
    /** Admin: transliacijos priskyrimas klientams (iš transliacijos puslapio). */
    async publishStream(name, source) {
      if (!users.length) users = await api('users').catch(() => []);
      const existing = items.length ? items : await api('items?kind=stream').catch(() => []);
      const same = existing.find((i) => i.kind === 'stream' && JSON.stringify(i.meta?.source || i.meta?.path) === JSON.stringify(source.source || source.path));
      dialog(
        `<h2>${esc(t('Priskirti klientams: {n}', { n: name }))}</h2>
         <label class="row">${esc(t('Pavadinimas klientui'))} <input name="title" class="num wide" style="text-align:left;width:240px" value="${esc(same?.title || name)}" required /></label>
         ${clientChecks(same?.clients || [])}
         <p class="small muted">${esc(t('Klientas matys transliaciją per šį serverį; šaltinio adresas ir raktai jam nerodomi.'))}</p>`,
        async (f) => {
          const body = { kind: 'stream', title: f.title.value, clients: checked(f), meta: source };
          if (same) await api(`items/${same.id}`, { method: 'PATCH', body });
          else await api('items', { method: 'POST', body });
          items = await api('items');
          app.toast(t('Transliacija priskirta'), 'success');
        },
      );
    },
  };
}
