// Programą atidarius tiesiai iš disko (file://) – suranda vietinį Atea serverį (deploy/).
// start-windows.bat gali parinkti ne 8080, o kitą laisvą prievadą (8081, 8082…), todėl tikriname kelis.
const PORTS = Array.from({ length: 20 }, (_, i) => 8080 + i);
let found = null; // Promise<string|null>

async function getJson(url, signal) {
  const r = await fetch(url, { signal, cache: 'no-store' });
  if (!r.ok) return null;
  try {
    return await r.json();
  } catch {
    return null;
  }
}

async function probe(port) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  const base = `http://localhost:${port}/`;
  try {
    const ai = await getJson(base + 'ai/health', ctl.signal).catch(() => null);
    if (ai && 'segmenter' in ai) return true;
    const odm = await getJson(base + 'odm/info', ctl.signal).catch(() => null);
    return !!(odm && 'engineVersion' in odm);
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {Promise<string|null>} pvz. "http://localhost:8081/" arba null */
export function findLocalServer(force = false) {
  if (location.protocol !== 'file:') return Promise.resolve(null);
  if (found && !force) return found;
  found = new Promise((resolve) => {
    // Pirmenybė mažesniam prievadui: laukiame iš eilės, bet tikriname lygiagrečiai
    const checks = PORTS.map((p) => probe(p).catch(() => false));
    (async () => {
      for (let i = 0; i < PORTS.length; i++) {
        if (await checks[i]) return resolve(`http://localhost:${PORTS[i]}/`);
      }
      resolve(null);
    })();
  }).then((r) => {
    if (!r) found = null; // kitą kartą bandysime vėl (serveris gal dar paleidžiamas)
    return r;
  });
  return found;
}
