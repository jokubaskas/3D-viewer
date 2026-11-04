// Prisijungimas, slaptažodžio nusistatymas pagal kvietimą (#invite=…), vartotojo meniu.
import { api } from './api.js';
import { logoSvg } from '../logo.js';
import { t } from '../i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function screen(inner) {
  const el = document.createElement('div');
  el.className = 'auth-screen';
  el.innerHTML = `<form class="auth-card" autocomplete="on" novalidate>${logoSvg('auth-logo')}<div class="auth-sub">3D Matuoklis</div>${inner}<div class="auth-err" hidden></div></form>`;
  document.body.append(el);
  return el;
}

/** Prisijungimo langas; grąžina pažadą, kuris išsipildo prisijungus (puslapis perkraunamas). */
export function showLogin() {
  const el = screen(`
    <h1>Prisijungimas</h1>
    <label>El. paštas<input name="email" type="email" autocomplete="username" required autofocus /></label>
    <label>Slaptažodis<input name="password" type="password" autocomplete="current-password" required /></label>
    <button class="btn btn-primary" type="submit">Prisijungti</button>
    <button class="btn btn-ghost btn-sm" type="button" data-forgot>Pamiršote slaptažodį?</button>
    <p class="small muted">Paskyrą sukuria administratorius.</p>`);
  const f = el.querySelector('form');
  el.querySelector('[data-forgot]').addEventListener('click', () => (el.remove(), showForgot(f.email.value)));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = el.querySelector('.auth-err');
    err.hidden = true;
    f.querySelector('button').disabled = true;
    try {
      await api('auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
      location.reload();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      f.password.value = '';
      f.password.focus();
    } finally {
      f.querySelector('button').disabled = false;
    }
  });
  // Žymeklis į el. paštą – tik jei vartotojas (ar slaptažodžių tvarkyklė) dar nieko nepradėjo pildyti
  setTimeout(() => !f.contains(document.activeElement) && f.email.focus(), 50);
}

/** Slaptažodžio priminimas: nuoroda el. paštu (jei serveryje įjungti laiškai). */
function showForgot(email = '') {
  const el = screen(`
    <h1>Slaptažodžio keitimas</h1>
    <p class="small">Įveskite paskyros el. paštą – atsiųsime nuorodą naujam slaptažodžiui nustatyti.</p>
    <label>El. paštas<input name="email" type="email" autocomplete="username" required value="${esc(email)}" /></label>
    <button class="btn btn-primary" type="submit">Siųsti nuorodą</button>
    <button class="btn btn-ghost btn-sm" type="button" data-back>Grįžti į prisijungimą</button>
    <p class="small auth-ok" hidden></p>`);
  const f = el.querySelector('form');
  el.querySelector('[data-back]').addEventListener('click', () => (el.remove(), showLogin()));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = el.querySelector('.auth-err');
    const ok = el.querySelector('.auth-ok');
    err.hidden = ok.hidden = true;
    if (!f.email.value.includes('@')) {
      err.textContent = t('Įveskite el. paštą');
      err.hidden = false;
      return;
    }
    f.querySelector('button[type=submit]').disabled = true;
    try {
      const r = await api('auth/forgot', { method: 'POST', body: { email: f.email.value } });
      ok.textContent = r.mail
        ? t('Jei tokia paskyra yra, nuoroda išsiųsta. Patikrinkite el. paštą (ir šlamšto aplanką).')
        : t('El. laiškai šiame serveryje neįjungti – kreipkitės į administratorių, jis atsiųs naują nuorodą.');
      ok.hidden = false;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      f.querySelector('button[type=submit]').disabled = false;
    }
  });
  setTimeout(() => f.email.focus(), 50);
}

/** Serveris (portalas) laikinai nepasiekiamas – bandoma vėl kas 5 s. */
export function showDown() {
  const el = screen(`<h1>Serveris paleidžiamas</h1><p>Paskyrų paslauga dar neatsako. Puslapis atsinaujins automatiškai.</p><button class="btn btn-outline" type="submit">Bandyti dabar</button>`);
  el.querySelector('form').addEventListener('submit', (e) => (e.preventDefault(), location.reload()));
  setTimeout(() => location.reload(), 5000);
}

/** Kvietimo nuoroda: slaptažodžio nusistatymas. */
export async function showInvite(token) {
  let info = null;
  try {
    info = await api(`auth/invite?token=${encodeURIComponent(token)}`);
  } catch (ex) {
    const el = screen(`<h1>Nuoroda negalioja</h1><p>${esc(ex.message)}</p><a class="btn btn-outline" href="./">Į prisijungimą</a>`);
    el.querySelector('form').addEventListener('submit', (e) => e.preventDefault());
    return;
  }
  const el = screen(`
    <h1>${esc(t(info.reset ? 'Naujas slaptažodis' : 'Slaptažodžio nustatymas'))}</h1>
    <p class="small">${esc(info.name ? `${info.name} · ` : '')}${esc(info.email)}</p>
    <input type="email" name="username" autocomplete="username" value="${esc(info.email)}" hidden />
    <label>Naujas slaptažodis<input name="password" type="password" autocomplete="new-password" minlength="10" required /></label>
    <label>Pakartokite<input name="password2" type="password" autocomplete="new-password" required /></label>
    <p class="small muted">Bent 10 simbolių. Geriausia – kelių žodžių frazė.</p>
    <button class="btn btn-primary" type="submit">Išsaugoti ir prisijungti</button>`);
  const f = el.querySelector('form');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = el.querySelector('.auth-err');
    err.hidden = true;
    if (f.password.value !== f.password2.value) {
      err.textContent = t('Slaptažodžiai nesutampa');
      err.hidden = false;
      return;
    }
    try {
      await api('auth/invite', { method: 'POST', body: { token, password: f.password.value } });
      history.replaceState(null, '', location.pathname + location.search); // raktas pašalinamas iš adreso
      location.reload();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
  setTimeout(() => !f.contains(document.activeElement) && f.password.focus(), 50);
}

/** Slaptažodžio keitimas (prisijungus). */
export function changePasswordDialog(toast) {
  const d = document.createElement('dialog');
  d.className = 'dialog';
  d.innerHTML = `<form method="dialog" class="auth-dialog">
      <h2>Keisti slaptažodį</h2>
      <input type="text" name="username" autocomplete="username" hidden />
      <label class="row">Dabartinis <input name="current" type="password" autocomplete="current-password" required /></label>
      <label class="row">Naujas <input name="password" type="password" autocomplete="new-password" minlength="10" required /></label>
      <label class="row">Pakartokite <input name="password2" type="password" autocomplete="new-password" required /></label>
      <p class="small muted">Pakeitus kitose naršyklėse ir kompiuteriuose būsite atjungti.</p>
      <div class="auth-err" hidden></div>
      <menu><button class="btn btn-ghost" type="button" data-cancel>Atšaukti</button><button class="btn btn-primary" value="ok">Keisti</button></menu>
    </form>`;
  document.body.append(d);
  const f = d.querySelector('form');
  d.querySelector('[data-cancel]').addEventListener('click', () => d.close());
  f.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const err = d.querySelector('.auth-err');
    err.hidden = true;
    if (f.password.value !== f.password2.value) {
      err.textContent = t('Slaptažodžiai nesutampa');
      err.hidden = false;
      return;
    }
    try {
      await api('me/password', { method: 'POST', body: { current: f.current.value, password: f.password.value } });
      d.close();
      toast(t('Slaptažodis pakeistas'), 'success');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
  d.addEventListener('close', () => d.remove());
  d.showModal();
}

export async function logout() {
  await api('auth/logout', { method: 'POST' }).catch(() => {});
  location.replace(location.pathname);
}
