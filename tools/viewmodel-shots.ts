/**
 * W2: first-person viewmodel screenshots per weapon class (the A1 gallery's poses, tools/browser-check3d-a1.ts), the
 * lower-right quarter of a 1280×720 view where the viewmodel sits, as small JPEGs for before / after comparisons.
 *
 *   npm run build:3d && npx tsx tools/viewmodel-shots.ts --tag after [--out docs/img] [--team T|CT] [--port 4188]
 *
 * Writes `<out>/w2-vm-<weapon>-<tag>.jpg` (ak47, usps, glock, knife, he, awp) and prints the paths.
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};
const root = resolve(new URL('..', import.meta.url).pathname);
const dir = resolve(root, 'dist-3d');
const port = Number(arg('--port', '4188'));
const out = resolve(root, arg('--out', 'docs/img'));
const tag = arg('--tag', 'after');
const only = arg('--weapons', 'ak47,usps,glock,knife,he,awp').split(',');
mkdirSync(out, { recursive: true });
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.bin': 'application/octet-stream' };
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  const file = join(dir, path.endsWith('/') ? path + 'index.html' : path);
  try {
    if (!file.startsWith(dir) || !statSync(file).isFile()) throw new Error('404');
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(port, '127.0.0.1');
if (process.env['CHROMIUM_WEBGL_RENDERER'] === undefined) process.env['CHROMIUM_WEBGL_RENDERER'] = 'lavapipe';
const exe = process.env['CHROME_PATH'];
const browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
const written: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 180_000 });
  await page.click('#start').catch(() => undefined);
  await page.evaluate(() => window.__cs2sim3d?.seek(18.2));
  await page.waitForFunction(() => (window.__cs2sim3d?.stats().tick ?? 0) >= Math.round(18.2 * 64), null, { timeout: 180_000 });
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(1500);
  await page.keyboard.press('KeyP');
  await page.evaluate(() => window.__cs2sim3d?.setLook(-120, 6));
  const poses: Record<string, Record<string, unknown>> = {
    ak47: { weapon: 'ak47' },
    usps: { weapon: 'usps' },
    glock: { weapon: 'glock' },
    knife: { weapon: 'knife' },
    he: { weapon: 'he' },
    awp: { weapon: 'awp' },
  };
  for (const w of only) {
    const pose = poses[w];
    if (pose === undefined) continue;
    await page.evaluate((p) => window.__cs2a1?.preview(p as { weapon: string }), pose);
    await page.waitForTimeout(600);
    const path = join(out, `w2-vm-${w}-${tag}.jpg`);
    await page.screenshot({ path, type: 'jpeg', quality: 72, clip: { x: 480, y: 250, width: 800, height: 360 } });
    written.push(path.replace(root + '/', ''));
  }
} finally {
  await browser.close();
  server.close();
}
console.log(written.join('\n'));
