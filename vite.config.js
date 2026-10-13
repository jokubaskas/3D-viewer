import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` – įprastas statinis build'as (dist/), kurį galima talpinti bet kuriame serveryje.
// `npm run build:single` – vienas savarankiškas HTML failas (dist-single/index.html),
// kurį galima atsidaryti dukart spustelėjus, be serverio.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 2000,
    copyPublicDir: mode !== 'single',
    // Vieno failo versijoje viską (įskaitant LAZ dekoderio WASM) įterpiame į HTML
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
  },
}));
