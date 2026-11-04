// Tikrina, ar visi sąsajos tekstai turi EN vertimą (src/i18n.en.js).
// Ieškoma: t('…') / tr('…') argumentai ir statinis HTML šablonuose (>tekstas<, title / placeholder / aria-label).
// Tekstai su ${…} ar be raidžių praleidžiami. Paleisti: npm run check:i18n  (--list – parodyti trūkstamus)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EN } from '../src/i18n.en.js';

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.js$/.test(f) && !/i18n(\.en)?\.js$/.test(f)) files.push(p);
  }
};
walk('src');
files.push('index.html');

const LT = /[ąčęėįšųūžĄČĘĖĮŠŲŪŽ]/;
const unesc = (s) => s.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');
const missing = new Map();
const need = (s, where, exact = false) => {
  const key = exact ? s : s.trim();
  if (!key || !/\p{L}{2}/u.test(key) || key.includes('${') || /^[\w.-]+$/.test(key) && !LT.test(key)) return;
  if (!(key in EN)) missing.set(key, missing.get(key) || where);
};

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  // t('…') / tr('…') / t("…")
  for (const m of src.matchAll(/\b(?:t|tr)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) need(unesc(m[2]), f, true);
  for (const m of src.matchAll(/\b(?:t|tr)\(\s*`((?:\\.|[^`$])*)`/g)) need(unesc(m[1]), f, true);
  // Statinis HTML: tekstas tarp žymų ir atributai – tik tie, kuriuose yra lietuviškų raidžių
  for (const m of src.matchAll(/>([^<>{}`$]*[ąčęėįšųūžĄČĘĖĮŠŲŪŽ][^<>{}`$]*)</g)) if (!/[;=]|\/\/|\n\s*\w+[:(]/.test(m[1])) need(m[1], f);
  for (const m of src.matchAll(/\b(?:title|placeholder|aria-label)="([^"$]*)"/g)) if (LT.test(m[1])) need(m[1], f);
}

if (missing.size) {
  console.log(`Trūksta EN vertimų: ${missing.size}`);
  if (process.argv.includes('--list') || missing.size <= 50) for (const [k, f] of missing) console.log(`  ${f}: ${JSON.stringify(k)}`);
  process.exit(1);
}
console.log('EN vertimai: visi tekstai išversti');
