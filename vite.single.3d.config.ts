/**
 * H1: the 3D page as one self-contained file, `npm run build:single:3d` → dist-single-3d/index.html, for the
 * password-locked johnjp15.github.io/cs2/sim3d/ (docs/app3d.md "Build and deploy"). As the 2D page's
 * (vite.single.config.ts): main.ts's `./assets3d` is redirected to `./assets3d-embedded`, which reads
 * `virtual:cs2-embedded-assets-3d` (every data file gzipped + base64, the radar a data: URI); Three.js is bundled
 * into the one inlined script; the build fails if anything but index.html is written or the page still points at
 * another file, and prints the sizes (raw, gzip, and the page once locked by cs2/tools/encrypt.cjs).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const OUT_DIR = resolve(ROOT, 'dist-single-3d');
const VIRTUAL = 'virtual:cs2-embedded-assets-3d';
const RESOLVED_VIRTUAL = '\0' + VIRTUAL;
const MAIN = resolve(ROOT, 'src/app3d/main.ts');
const EMBEDDED_LOADER = resolve(ROOT, 'src/app3d/assets3d-embedded.ts');
/** Bytes of cs2/tools/lock.html around the payload, plus the payload's JSON fields (salt, iv, ...). */
const LOCK_OVERHEAD = 6_400;

function kb(n: number): string {
  return `${(n / 1024).toFixed(1)} KB`;
}

function embedAssets3d(): Plugin {
  const data = (name: string): string => resolve(ROOT, 'data', name);
  const gz = (name: string): string => gzipSync(readFileSync(data(name)), { level: 9 }).toString('base64');
  const files = ['round.json', 'mirage-nav.json', 'mirage-vismask.json', 'geometry/mirage-geometry.bin', 'geometry/mirage-clips.bin', 'geometry/mirage-tracks.json', 'source/cs2/de_mirage.png'];
  return {
    name: 'cs2:embed-assets-3d',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (source === VIRTUAL) return RESOLVED_VIRTUAL;
      if (source === './assets3d' && importer !== undefined && resolve(importer) === MAIN) return EMBEDDED_LOADER;
      return null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL) return null;
      for (const f of files) this.addWatchFile(data(f));
      const assets = {
        round: gz('round.json'),
        nav: gz('mirage-nav.json'),
        vision: gz('mirage-vismask.json'),
        geometry: gz('geometry/mirage-geometry.bin'),
        clips: gz('geometry/mirage-clips.bin'),
        tracks: gz('geometry/mirage-tracks.json'),
        radar: `data:image/png;base64,${readFileSync(data('source/cs2/de_mirage.png')).toString('base64')}`,
      };
      return `export default ${JSON.stringify(assets)};`;
    },
  };
}

function checkSingleFile(): Plugin {
  return {
    name: 'cs2:check-single-file-3d',
    apply: 'build',
    enforce: 'post',
    writeBundle(options) {
      const dir = options.dir ?? OUT_DIR;
      const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile());
      const extra = files.map((d) => join(d.parentPath, d.name)).filter((p) => resolve(p) !== resolve(dir, 'index.html'));
      if (extra.length > 0) this.error(`single-file build wrote more than index.html: ${extra.join(', ')}`);
      const html = readFileSync(join(dir, 'index.html'), 'utf8');
      const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '<script></script>');
      const refs = [...markup.matchAll(/\s(?:src|href)\s*=\s*["']?([^"'\s>]*)/g)].map((m) => m[1] ?? '').filter((u) => !u.startsWith('data:') && !u.startsWith('#'));
      if (refs.length > 0) this.error(`single-file build still references other files: ${refs.join(', ')}`);
      const raw = Buffer.byteLength(html);
      const gzBytes = gzipSync(html, { level: 9 }).length;
      const locked = LOCK_OVERHEAD + Math.ceil((raw + 16) / 3) * 4;
      this.info(`dist-single-3d/index.html: ${kb(raw)} (gzip ${kb(gzBytes)}); locked by cs2/tools/encrypt.cjs ≈ ${kb(locked)}`);
    },
  };
}

export default defineConfig({
  root: resolve(ROOT, 'sim3d'),
  base: './',
  publicDir: false,
  plugins: [embedAssets3d(), viteSingleFile(), checkSingleFile()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 4000,
  },
});
