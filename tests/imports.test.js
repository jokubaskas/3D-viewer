// Visi santykiniai importai (ir dinaminiai import('…')) src/ kataloge rodo į esamus failus –
// ESLint jų netikrina, o klaida pasimatytų tik atidarius atitinkamą funkciją.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const files = [];
const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.js$/.test(f) && files.push(join(d, f))));
walk('src');

test('santykiniai importai rodo į esamus failus', () => {
  const bad = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)(['"])(\.{1,2}\/[^'"]+)\1/g)) {
      if (!existsSync(resolve(dirname(f), m[2]))) bad.push(`${f}: ${m[2]}`);
    }
  }
  assert.deepEqual(bad, []);
});
