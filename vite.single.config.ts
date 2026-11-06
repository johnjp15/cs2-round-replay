/**
 * Single-file build: `npm run build:single` writes dist-single/index.html, one self-contained page with the
 * script, the CSS, the round / nav / sight-mask JSON and the radar inlined, for the password-locked
 * johnjp15.github.io/cs2/sim/ (docs/deploy.md). The page makes no network requests.
 *
 * - `embedAssets()` redirects main.ts's `./assets` (which fetches) to `./assets-embedded` and provides
 *   `virtual:cs2-embedded-assets`: the JSON gzipped + base64 (or as text with CS2_SINGLE_RAW=1, to compare
 *   sizes) and the radar as a data: URI.
 * - vite-plugin-singlefile inlines the one script chunk into index.html.
 * - `checkSingleFile()` fails the build if anything but index.html is written or the HTML still points at
 *   another file, and prints the sizes (raw, gzip, and the page once locked).
 *
 * The normal build (vite.config.ts, `npm run build`) is unchanged.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const OUT_DIR = 'dist-single';
const VIRTUAL = 'virtual:cs2-embedded-assets';
const RESOLVED_VIRTUAL = '\0' + VIRTUAL;
const MAIN = resolve(ROOT, 'src/app/main.ts');
const EMBEDDED_LOADER = resolve(ROOT, 'src/app/assets-embedded.ts');
const RAW = process.env['CS2_SINGLE_RAW'] === '1';

/** Bytes of tools/lock.html around the payload, plus the payload's JSON fields (salt, iv, ...). */
const LOCK_OVERHEAD = 6_400;

function kb(n: number): string {
  return `${(n / 1024).toFixed(1)} KB`;
}

function embedAssets(): Plugin {
  const data = (name: string): string => resolve(ROOT, 'data', name);
  const json = (name: string): string => {
    const bytes = readFileSync(data(name));
    return RAW ? bytes.toString('utf8') : gzipSync(bytes, { level: 9 }).toString('base64');
  };
  return {
    name: 'cs2:embed-assets',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (source === VIRTUAL) return RESOLVED_VIRTUAL;
      if (source === './assets' && importer !== undefined && resolve(importer) === MAIN) return EMBEDDED_LOADER;
      return null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL) return null;
      for (const f of ['round.json', 'mirage-nav.json', 'mirage-vismask.json', 'mirage-radar.jpg']) this.addWatchFile(data(f));
      const assets = {
        encoding: RAW ? 'text' : 'gzip-base64',
        round: json('round.json'),
        nav: json('mirage-nav.json'),
        vision: json('mirage-vismask.json'),
        radar: `data:image/jpeg;base64,${readFileSync(data('mirage-radar.jpg')).toString('base64')}`,
      };
      return `export default ${JSON.stringify(assets)};`;
    },
  };
}

function checkSingleFile(): Plugin {
  return {
    name: 'cs2:check-single-file',
    apply: 'build',
    enforce: 'post',
    writeBundle(options) {
      const dir = options.dir ?? resolve(ROOT, OUT_DIR);
      const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile());
      const extra = files.map((d) => join(d.parentPath, d.name)).filter((p) => resolve(p) !== resolve(dir, 'index.html'));
      if (extra.length > 0) this.error(`single-file build wrote more than index.html: ${extra.join(', ')}`);
      const html = readFileSync(join(dir, 'index.html'), 'utf8');
      // Outside the inlined scripts, every src/href must be a data: URI or a fragment.
      const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '<script></script>');
      const refs = [...markup.matchAll(/\s(?:src|href)\s*=\s*["']?([^"'\s>]*)/g)].map((m) => m[1] ?? '').filter((u) => !u.startsWith('data:') && !u.startsWith('#'));
      if (refs.length > 0) this.error(`single-file build still references other files: ${refs.join(', ')}`);
      const raw = Buffer.byteLength(html);
      const gz = gzipSync(html, { level: 9 }).length;
      const locked = LOCK_OVERHEAD + Math.ceil((raw + 16) / 3) * 4;
      this.info(`${OUT_DIR}/index.html: ${kb(raw)} (gzip ${kb(gz)}); locked by cs2/tools/encrypt.cjs ≈ ${kb(locked)}; JSON ${RAW ? 'as text' : 'gzip + base64'}`);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [embedAssets(), viteSingleFile(), checkSingleFile()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    modulePreload: { polyfill: false },
  },
});
