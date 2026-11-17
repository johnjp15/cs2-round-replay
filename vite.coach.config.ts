/**
 * The demo coach page (coach/index.html → src/coach-app/main.tsx). `npm run dev:coach` serves it, `npm run build:coach`
 * builds it to dist-coach/ (`npm run preview:coach` serves that). Preact through @preact/preset-vite.
 *
 * Both servers also serve the map packs at `/data/coach/maps/<map>/…` from the repo (the page's `MAP_PACK_BASE`);
 * the build does not copy them: where the published page gets its packs is card K7's decision.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import preact from '@preact/preset-vite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const MAPS = resolve(ROOT, 'data/coach/maps');
const TYPES: Record<string, string> = { '.json': 'application/json', '.png': 'image/png', '.gz': 'application/gzip' };

function mapPacks(): Plugin {
  const serve = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
    const at = path.indexOf('/data/coach/maps/');
    if (at < 0) { next(); return; }
    const file = resolve(MAPS, path.slice(at + '/data/coach/maps/'.length));
    if (!file.startsWith(MAPS + sep) || !existsSync(file) || !statSync(file).isFile()) { next(); return; }
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(file).pipe(res);
  };
  return {
    name: 'coach-map-packs',
    configureServer(s) { s.middlewares.use(serve); },
    configurePreviewServer(s) { s.middlewares.use(serve); },
  };
}

export default defineConfig({
  root: resolve(ROOT, 'coach'),
  base: './',
  publicDir: false,
  plugins: [preact(), mapPacks()],
  server: { fs: { allow: [ROOT] } },
  worker: { format: 'es' },
  build: {
    outDir: resolve(ROOT, 'dist-coach'),
    emptyOutDir: true,
  },
});
