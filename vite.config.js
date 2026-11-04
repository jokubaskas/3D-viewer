import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Programos versija (rodoma Pagalboje ir vartotojo meniu): APP_VERSION (Docker – perduoda start-windows.bat),
// kitaip – paskutinio pakeitimo data ir git žymė, kitaip – package.json versija
function appVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    const [h, d] = execSync('git log -1 --format=%h_%cs', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('_');
    if (h && d) return `${d} (${h})`;
  } catch {
    /* be git */
  }
  return JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;
}

// `npm run build` – įprastas statinis build'as (dist/), kurį galima talpinti bet kuriame serveryje.
// `npm run build:single` – vienas savarankiškas HTML failas (dist-single/index.html),
// kurį galima atsidaryti dukart spustelėjus, be serverio.
export default defineConfig(({ mode }) => ({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 2000,
    copyPublicDir: mode !== 'single',
    // Vieno failo versijoje viską (įskaitant LAZ dekoderio WASM) įterpiame į HTML
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
  },
}));
