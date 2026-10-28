import { t } from '../i18n.js';
// NodeODM REST API klientas (https://github.com/OpenDroneMap/NodeODM/blob/master/docs/index.adoc)

export const STATUS = { QUEUED: 10, RUNNING: 20, FAILED: 30, COMPLETED: 40, CANCELED: 50 };
export const STATUS_LABELS = { 10: 'Eilėje', 20: 'Apdorojama', 30: 'Nepavyko', 40: 'Baigta', 50: 'Atšaukta' };

export class NodeODM {
  /**
   * @param {string} baseUrl – pvz. „./odm/“ (per nginx) arba „http://serveris:3000/“
   * @param {string} [token]
   */
  constructor(baseUrl, token = '') {
    this.base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.token = token;
  }

  url(path, params = {}) {
    const u = new URL(this.base + path.replace(/^\//, ''), location.href);
    if (this.token) u.searchParams.set('token', this.token);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  async _json(res) {
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if ([502, 503, 504].includes(res.status))
        throw new Error(t('Apdorojimo serveris (NodeODM) dar paleidžiamas arba neveikia. Palaukite 1–2 min. ir bandykite dar kartą; jei nepadeda – Docker Desktop patikrinkite, ar veikia konteineris „nodeodm“.'));
      if (/^\s*</.test(text))
        throw new Error(t('Adresu {u} atsako ne apdorojimo serveris (gautas HTML puslapis). Paleiskite serverį (deploy/start-windows.bat arba docker compose) ir patikrinkite adresą.', { u: this.base }));
      throw new Error(t('Serveris grąžino netikėtą atsakymą (HTTP {s})', { s: res.status }));
    }
    if (data && data.error) {
      if (/authentication token/i.test(data.error))
        throw new Error(t(this.token ? 'Neteisingas raktas. Įveskite raktą iš deploy/.env (NODEODM_TOKEN) arba palikite tuščią, jei programa atidaryta per http://localhost:8080.' : 'Serveris reikalauja rakto. Įveskite NODEODM_TOKEN reikšmę iš deploy/.env failo.'));
      throw new Error(data.error);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return data;
  }

  async _fetch(url, init) {
    try {
      return await fetch(url, init);
    } catch {
      const local = /localhost|127\.0\.0\.1/.test(this.base) && !this.base.startsWith(location.origin);
      throw new Error(
        t('Nepavyko prisijungti prie {u} – ar paleistas apdorojimo serveris (Docker)?', { u: this.base }) +
          (local ? ' ' + t('Jei start-windows.bat parodė kitą adresą (pvz. http://localhost:8081), atidarykite programą tuo adresu arba „Iš nuotraukų“ → „Apdorojimo serveris“ įrašykite jį ir spauskite „Tikrinti ryšį“.') : ''),
      );
    }
  }

  async get(path, params) {
    return this._json(await this._fetch(this.url(path, params)));
  }

  async postForm(path, fields, headers) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, v);
    return this._json(await this._fetch(this.url(path), { method: 'POST', body: fd, headers }));
  }

  /** NodeODM /task/cancel, /remove, /restart priima tik urlencoded arba JSON kūną (ne multipart). */
  async postEncoded(path, fields) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) if (v != null) body.append(k, v);
    const data = await this._json(await this._fetch(this.url(path), { method: 'POST', body }));
    if (data && data.success === false) throw new Error(data.error || t('Serveris atmetė užklausą'));
    return data;
  }

  /** Serverio informacija: versija, eilė, RAM, branduoliai. */
  info() {
    return this.get('info');
  }

  /**
   * @param {string} [uuid] – iš anksto parinktas užduoties ID (NodeODM „set-uuid“), kad parinktyse
   *   būtų galima nurodyti kelią iki kartu įkeliamo failo (pvz. boundary.geojson)
   * @returns {Promise<string>} uuid
   */
  async init(name, options, outputs, uuid) {
    const r = await this.postForm('task/new/init', {
      name,
      options: JSON.stringify(options),
      outputs: outputs ? JSON.stringify(outputs) : null,
    }, uuid ? { 'set-uuid': uuid } : undefined);
    if (!r.uuid) throw new Error(t('Serveris negrąžino užduoties ID'));
    return r.uuid;
  }

  /**
   * Įkelia failus dalimis su progresu ir pakartojimais.
   * @param {{name:string, file:File|Blob}[]} items
   * @param {(sentBytes:number, totalBytes:number, doneFiles:number)=>void} onProgress
   */
  async upload(uuid, items, onProgress, { signal, concurrency = 3, batchBytes = 120 * 1024 * 1024, batchFiles = 25 } = {}) {
    const batches = [];
    let cur = [], curBytes = 0;
    for (const it of items) {
      if (cur.length && (curBytes + it.file.size > batchBytes || cur.length >= batchFiles)) {
        batches.push(cur);
        cur = [];
        curBytes = 0;
      }
      cur.push(it);
      curBytes += it.file.size;
    }
    if (cur.length) batches.push(cur);

    const total = items.reduce((s, it) => s + it.file.size, 0);
    const sentPerBatch = new Array(batches.length).fill(0);
    let doneFiles = 0, next = 0;
    const report = () => onProgress?.(sentPerBatch.reduce((a, b) => a + b, 0), total, doneFiles);

    const sendBatch = (bi) =>
      new Promise((resolve, reject) => {
        const fd = new FormData();
        for (const it of batches[bi]) fd.append('images', it.file, it.name);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', this.url(`task/new/upload/${uuid}`));
        xhr.upload.onprogress = (e) => {
          sentPerBatch[bi] = e.loaded * (batches[bi].reduce((s, it) => s + it.file.size, 0) / Math.max(1, e.total));
          report();
        };
        xhr.onload = () => {
          try {
            const d = JSON.parse(xhr.responseText);
            if (d.error) return reject(new Error(d.error));
            if (xhr.status >= 400) return reject(new Error(`HTTP ${xhr.status}`));
            resolve();
          } catch {
            reject(new Error(`HTTP ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error(t('Ryšio klaida')));
        xhr.ontimeout = () => reject(new Error(t('Baigėsi laikas')));
        signal?.addEventListener('abort', () => xhr.abort(), { once: true });
        xhr.onabort = () => reject(new DOMException('Atšaukta', 'AbortError'));
        xhr.send(fd);
      });

    const worker = async () => {
      while (next < batches.length) {
        const bi = next++;
        for (let attempt = 1; ; attempt++) {
          try {
            await sendBatch(bi);
            break;
          } catch (e) {
            if (e.name === 'AbortError' || attempt >= 4) throw e;
            sentPerBatch[bi] = 0;
            await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
          }
        }
        sentPerBatch[bi] = batches[bi].reduce((s, it) => s + it.file.size, 0);
        doneFiles += batches[bi].length;
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  }

  commit(uuid) {
    return this.postForm(`task/new/commit/${uuid}`, {});
  }

  /** Ar serveris palaiko ODM parinktį (pvz. „mesh-method“ – tik Atea ODM atvaizde). */
  async supports(name) {
    const opts = await this.get('options').catch(() => []);
    return Array.isArray(opts) && opts.some((o) => o.name === name);
  }

  taskInfo(uuid) {
    return this.get(`task/${uuid}/info`);
  }

  /** Apdorojimo žurnalas nuo nurodytos eilutės. */
  output(uuid, line = 0) {
    return this.get(`task/${uuid}/output`, { line });
  }

  list() {
    return this.get('task/list');
  }

  cancel(uuid) {
    return this.postEncoded('task/cancel', { uuid });
  }
  remove(uuid) {
    return this.postEncoded('task/remove', { uuid });
  }
  restart(uuid, options) {
    return this.postEncoded('task/restart', { uuid, options: options ? JSON.stringify(options) : null });
  }

  /** Atskiri rezultatų failai (tik per šios programos serverį – nginx /odm/files/; kitaip 404 ir naudojamas all.zip). */
  filesUrl(uuid) {
    return new URL(`${this.base}files/${uuid}/`, location.href).toString();
  }

  downloadUrl(uuid) {
    return this.url(`task/${uuid}/download/all.zip`);
  }
}
