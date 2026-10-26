// Pradžios ekranas po prisijungimo: dideli mygtukai pagal vartotojo teises (administratorius / klientas).
import { icon } from '../icons.js';
import { t } from '../i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * @param {{user:{name:string,email:string,role:string}, tiles:{id:string,icon:string,title:string,desc:string,run:()=>void}[],
 *   counts?:()=>Promise<Record<string,number|{n:number,title?:string}>>}} o
 */
export function createHome(o) {
  const page = document.createElement('section');
  page.className = 'home-page';
  page.hidden = true;
  document.getElementById('app').append(page);
  let counts = {};

  function render() {
    const name = o.user.name || o.user.email;
    page.innerHTML = `
      <div class="home-inner">
        <h1>${esc(t('Sveiki, {n}', { n: name }))}</h1>
        <p class="muted">${esc(t(o.user.role === 'admin' ? 'Pasirinkite, ką norite daryti.' : 'Jums priskirti duomenys. Pasirinkite, ką norite peržiūrėti.'))}</p>
        <div class="home-grid">
          ${o.tiles
            .map(
              (x) => `<button class="home-tile" data-home="${x.id}">
                ${counts[x.id] == null ? '' : typeof counts[x.id] === 'object' ? `<span class="home-count alert" title="${esc(t(counts[x.id].title || ''))}">${counts[x.id].n}</span>` : `<span class="home-count">${counts[x.id]}</span>`}
                <span class="home-icon">${icon(x.icon)}</span>
                <b>${esc(t(x.title))}</b>
                <span class="home-desc">${esc(t(x.desc))}</span>
              </button>`,
            )
            .join('')}
        </div>
      </div>`;
  }

  page.addEventListener('click', (e) => {
    const b = e.target.closest('[data-home]');
    const tile = b && o.tiles.find((x) => x.id === b.dataset.home);
    if (!tile) return;
    close();
    tile.run();
  });

  function open() {
    page.hidden = false;
    document.body.classList.add('home-open');
    render();
    o.counts?.()
      .then((c) => {
        counts = c || {};
        if (!page.hidden) render();
      })
      .catch(() => {});
  }
  function close() {
    page.hidden = true;
    document.body.classList.remove('home-open');
  }

  return {
    open,
    close,
    rerender: () => !page.hidden && render(),
    get isOpen() {
      return !page.hidden;
    },
  };
}
