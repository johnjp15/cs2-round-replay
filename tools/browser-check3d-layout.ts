/**
 * L1: the game fills the whole viewport, so the crosshair is at the true screen centre whether the bottom menu is shown
 * or hidden; the menu overlays the bottom and the ` key / buttons / setting hide it. Headless Chromium on a build
 * (`npm run build:3d`):
 *
 *   npm run check:browser:3d:layout [-- --single] [--port 4185] [--shot docs/img/app3d-menu-shown.jpg]
 *
 * At 1280x720 and 1920x1080, bar shown and hidden: the canvas is the viewport, the #crosshair centre is within 1 px of
 * the viewport centre, the health/ammo panels sit above the bar when it is shown. Exits 1 on a problem.
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const arg = (n: string, d: string): string => (process.argv.includes(n) ? (process.argv[process.argv.indexOf(n) + 1] ?? d) : d);
const PORT = Number(arg('--port', '4185'));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DIR = resolve(ROOT, process.argv.includes('--single') ? 'dist-single-3d' : 'dist-3d');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.bin': 'application/octet-stream', '.css': 'text/css' };

function serve(dir: string): Server {
  const s = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const file = join(dir, path.endsWith('/') ? path + 'index.html' : path);
    try {
      if (!file.startsWith(dir) || !statSync(file).isFile()) throw new Error('not found');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  s.listen(PORT, '127.0.0.1');
  return s;
}


async function main(): Promise<void> {
  if (process.env['CHROMIUM_WEBGL_RENDERER'] === undefined) process.env['CHROMIUM_WEBGL_RENDERER'] = 'lavapipe';
  statSync(join(DIR, 'index.html'));
  const server = serve(DIR);
  const exe = process.env['CHROME_PATH'];
  const browser: Browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
  let bad = 0;
  const check = (ok: boolean, msg: string): void => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
    if (!ok) bad++;
  };
  try {
    for (const [w, h] of [[1280, 720], [1920, 1080]] as const) {
      const p = await browser.newPage({ viewport: { width: w, height: h } });
      await p.goto(`${ORIGIN}/?human=cart`);
      await p.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 120_000 });
      await p.evaluate(() => window.__cs2sim3d?.perf.start());
      await p.waitForFunction(() => document.getElementById('crosshair')?.hidden === false, null, { timeout: 120_000 });
      for (const hidden of [false, true]) {
        // Toggle with the real hotkey; the first pass checks the default (shown).
        if (hidden) await p.keyboard.press('Backquote');
        await p.waitForTimeout(400);
        const m = await p.evaluate(() => {
                    const x = document.getElementById('crosshair')?.getBoundingClientRect();
          const c = document.getElementById('view')?.getBoundingClientRect();
          const bar = document.getElementById('bar')?.getBoundingClientRect();
          const v = document.getElementById('vitals')?.getBoundingClientRect();
          return { cx: x?.x ?? NaN, cy: x?.y ?? NaN, cw: c?.width ?? 0, ch: c?.height ?? 0, barTop: bar?.top ?? NaN, vBottom: v?.bottom ?? NaN, vw: innerWidth, vh: innerHeight, cls: document.getElementById('app')?.className ?? '', vfov: window.__cs2sim3d?.test.state().camera.vfovDeg ?? 0, cam: window.__cs2sim3d?.test.state().camera };
        });
        const tag = `${w}x${h} bar ${hidden ? 'hidden' : 'shown'}`;
        const off = Math.hypot(m.cx - m.vw / 2, m.cy - m.vh / 2);
        console.log(`${tag}: crosshair (${m.cx}, ${m.cy}) vs centre (${m.vw / 2}, ${m.vh / 2}) = ${off.toFixed(3)} px; canvas ${m.cw}x${m.ch}; vfov ${m.vfov.toFixed(2)}`);
        check(off <= 1, `${tag}: crosshair within 1 px of the viewport centre`);
        check(m.cw === m.vw && m.ch === m.vh, `${tag}: the canvas is the whole viewport`);
        check(m.cam?.width === m.cw && m.cam?.height === m.ch, `${tag}: the camera uses the full canvas size`);
        check(m.cls.includes('bar-hidden') === hidden, `${tag}: class ${m.cls}`);
        if (!hidden) check(m.vBottom <= m.barTop + 0.5, `${tag}: health panel above the bar`);
        else check(m.vh - m.vBottom <= 12, `${tag}: health panel at the screen bottom`);
        const shot = arg('--shot', '');
        if (shot !== '' && w === 1280) await p.screenshot({ path: shot.replace('.jpg', hidden ? '-hidden.jpg' : '-shown.jpg'), type: 'jpeg', quality: 55 });
      }
      await p.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (bad > 0) process.exit(1);
}

void main();
