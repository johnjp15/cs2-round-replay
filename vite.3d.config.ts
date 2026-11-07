/**
 * H1: the 3D page (sim3d/index.html → src/app3d/main.ts). `npm run dev:3d` serves it, `npm run build:3d` builds it to
 * dist-3d/ (`npm run preview:3d` serves that). The data files are emitted next to the page and fetched
 * (src/app3d/assets3d.ts); the single-file build is vite.single.3d.config.ts.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: resolve(ROOT, 'sim3d'),
  base: './',
  publicDir: false,
  server: { fs: { allow: [ROOT] } },
  build: {
    outDir: resolve(ROOT, 'dist-3d'),
    emptyOutDir: true,
    // Three.js is one ~600 KB chunk; that's expected.
    chunkSizeWarningLimit: 1500,
  },
});
