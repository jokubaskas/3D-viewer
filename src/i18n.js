// Kalbos (LT / EN) palaikymas.
// Šaltinio kalba – lietuvių: tekstai kode rašomi lietuviškai, o EN žodynas juos verčia.
// Statiniai tekstai (HTML, mygtukai, etiketės) verčiami automatiškai pagal tikslų atitikmenį;
// tekstai su kintamaisiais – per t('… {n} …', { n }).
import { EN } from './i18n.en.js';

const LS_KEY = 'atea3d.lang';
let lang = 'lt';
try {
  lang = localStorage.getItem(LS_KEY) || (navigator.language?.toLowerCase().startsWith('lt') ? 'lt' : 'en');
} catch {
  /* privatus režimas */
}
if (lang !== 'en' && lang !== 'lt') lang = 'lt';

const listeners = new Set();

export const getLang = () => lang;
export const locale = () => (lang === 'en' ? 'en-GB' : 'lt-LT');

/** Išverčia tekstą; {vardas} pakeičiami reikšmėmis. */
export function t(s, vars) {
  let r = lang === 'en' ? EN[s] ?? s : s;
  if (vars) r = r.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return r;
}

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setLang(l) {
  if (l === lang || (l !== 'lt' && l !== 'en')) return;
  lang = l;
  try {
    localStorage.setItem(LS_KEY, l);
  } catch {
    /* ignoruojame */
  }
  document.documentElement.lang = l;
  translateDom(document.body);
  document.title = t('Atea 3D Matuoklis');
  listeners.forEach((fn) => fn(l));
}

// ---------------------------------------------------------------------------
// Automatinis DOM vertimas
// ---------------------------------------------------------------------------
const ATTRS = ['title', 'placeholder', 'aria-label'];
const origText = new WeakMap(); // Text -> { src: LT tekstas, set: paskutinis mūsų įrašytas }
const origAttr = new WeakMap(); // Element -> { attr: { src, set } }

function translated(src) {
  if (lang === 'lt') return src;
  const key = src.trim();
  if (!key || !(key in EN)) return src;
  return src.replace(key, EN[key]);
}

function translateText(node) {
  const cur = node.nodeValue;
  let rec = origText.get(node);
  // Jei tekstą pakeitė programa (ne mes) – tai naujas šaltinis
  if (!rec || (cur !== rec.set && cur !== rec.src)) {
    rec = { src: cur, set: cur };
    origText.set(node, rec);
  }
  const next = translated(rec.src);
  rec.set = next;
  if (next !== cur) node.nodeValue = next;
}

function translateAttrs(el) {
  let map = origAttr.get(el);
  for (const a of ATTRS) {
    if (!el.hasAttribute?.(a)) continue;
    const cur = el.getAttribute(a);
    if (!map) origAttr.set(el, (map = {}));
    let rec = map[a];
    if (!rec || (cur !== rec.set && cur !== rec.src)) rec = map[a] = { src: cur, set: cur };
    const next = translated(rec.src);
    rec.set = next;
    if (next !== cur) el.setAttribute(a, next);
  }
}

export function translateDom(root) {
  if (!root) return;
  if (root.nodeType === 3) return translateText(root);
  if (root.nodeType !== 1) return;
  translateAttrs(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 1 && (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 3) translateText(n);
    else translateAttrs(n);
  }
}

let observing = false;
/** Stebi DOM ir verčia naujai įterptus elementus. */
export function startI18n() {
  document.documentElement.lang = lang;
  document.title = t('Atea 3D Matuoklis');
  translateDom(document.body);
  if (observing) return;
  observing = true;
  new MutationObserver((muts) => {
    if (lang === 'lt') return;
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach((n) => translateDom(n));
      else if (m.type === 'characterData') translateText(m.target);
      else if (m.type === 'attributes') translateAttrs(m.target);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
