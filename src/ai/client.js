// Vietinės AI paslaugos (deploy/ai) klientas
import { t } from '../i18n.js';

export const AI_CLASSES = {
  car: { lt: 'Automobilis', many: 'Automobiliai', color: '#ffd23f' },
  truck: { lt: 'Sunkvežimis', many: 'Sunkvežimiai', color: '#ff8a3d' },
  bus: { lt: 'Autobusas', many: 'Autobusai', color: '#4fc3f7' },
  motorcycle: { lt: 'Motociklas', many: 'Motociklai', color: '#e57cff' },
  bicycle: { lt: 'Dviratis', many: 'Dviračiai', color: '#c9f27b' },
  person: { lt: 'Žmogus', many: 'Žmonės', color: '#ff5fd2' },
  boat: { lt: 'Valtis', many: 'Valtys', color: '#3fe0d0' },
  train: { lt: 'Traukinys', many: 'Traukiniai', color: '#b0bec5' },
  airplane: { lt: 'Lėktuvas', many: 'Lėktuvai', color: '#ffffff' },
};

export class AiClient {
  constructor(base) {
    this.base = base.endsWith('/') ? base : base + '/';
  }

  url(path) {
    return new URL(this.base + path, location.href).toString();
  }

  async _req(path, init) {
    let res;
    try {
      res = await fetch(this.url(path), init);
    } catch {
      throw new Error(t('AI paslauga nepasiekiama ({u}). Ar paleistas serveris su AI (docker compose)?', { u: this.base }));
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if ([502, 503, 504].includes(res.status)) throw new Error(t('AI paslauga dar paleidžiama arba neveikia. Palaukite minutę ir bandykite dar kartą.'));
      throw new Error(t('AI paslauga nepasiekiama ({u}). Ar paleistas serveris su AI (docker compose)?', { u: this.base }));
    }
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    return data;
  }

  health() {
    return this._req('health');
  }

  /** @returns {Promise<{width:number,height:number,detections:{class:string,score:number,box:number[]}[]}>} */
  detect(blob, { classes, threshold = 0.35, tile = 640, overlap = 128, gsd = 0 } = {}) {
    const fd = new FormData();
    fd.append('image', blob, 'ortho.jpg');
    fd.append('classes', classes.join(','));
    fd.append('threshold', String(threshold));
    fd.append('tile', String(tile));
    fd.append('overlap', String(overlap));
    if (gsd > 0) fd.append('gsd', String(gsd));
    return this._req('detect', { method: 'POST', body: fd });
  }

  /** @returns {Promise<{polygon:number[][], touches_border:boolean, score:number, area_px:number}>} */
  segment(blob, x, y) {
    const fd = new FormData();
    fd.append('image', blob, 'ortho.jpg');
    fd.append('x', String(x));
    fd.append('y', String(y));
    return this._req('segment', { method: 'POST', body: fd });
  }
}
