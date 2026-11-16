/**
 * The demo coach page (coach/index.html → src/coach-app/main.tsx). `npm run dev:coach` serves it, `npm run build:coach`
 * builds it to dist-coach/ (`npm run preview:coach` serves that). Preact through @preact/preset-vite.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: resolve(ROOT, 'coach'),
  base: './',
  publicDir: false,
  plugins: [preact()],
  server: { fs: { allow: [ROOT] } },
  build: {
    outDir: resolve(ROOT, 'dist-coach'),
    emptyOutDir: true,
  },
});
