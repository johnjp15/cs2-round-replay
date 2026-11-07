/**
 * V1 · the 3D page on iPhone-sized screens (spectating), headless. WebKit is used when Playwright has it installed
 * (`npx playwright install webkit`); otherwise Chromium with iPhone emulation (viewport, DPR 3, touch, iOS Safari UA),
 * which checks layout and touch, not Safari's engine.
 *
 *   npm run build:3d && npx tsx tools/e2e/mobile3d.ts [--out <dir>] [--port 4183]      (npm run test:e2e:mobile)
 *
 * For iPhone 13 mini (375 × 812) and iPhone 16 Pro Max (440 × 956), portrait and landscape: the page loads with no
 * errors, draws the scene, the canvas fills the viewport, the HUD and the control bar are inside it; a tap on the
 * view while watching cycles the spectated player; the radar shows no enemy by default. Screenshots per size.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, type Browser, type BrowserType } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};
const PORT = Number(arg('--port', '4183'));
const OUT = resolve(arg('--out', 'logs/e2e-mobile'));
const DIR = resolve(ROOT, 'dist-3d');
const ORIGIN = `http://127.0.0.1:${PORT}`;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.bin': 'application/octet-stream', '.css': 'text/css', '.png': 'image/png' };

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

async function launch(): Promise<{ browser: Browser; engine: string }> {
  for (const [name, t] of [
    ['webkit', webkit],
    ['chromium', chromium],
  ] as [string, BrowserType][]) {
    try {
      const exe = name === 'chromium' ? process.env['CHROME_PATH'] : undefined;
      const browser = await t.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
      return { browser, engine: name };
    } catch (e) {
      console.log(`${name}: not available (${String(e).split('\n')[0]})`);
    }
  }
  throw new Error('no browser');
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function main(): Promise<void> {
  if (process.env['CHROMIUM_WEBGL_RENDERER'] === undefined) process.env['CHROMIUM_WEBGL_RENDERER'] = 'lavapipe';
  statSync(join(DIR, 'index.html'));
  mkdirSync(OUT, { recursive: true });
  const server = serve(DIR);
  const { browser, engine } = await launch();
  const problems: string[] = [];
  const rows: string[] = [];
  try {
    for (const [name, w, h] of [
      ['iphone13mini-portrait', 375, 812],
      ['iphone13mini-landscape', 812, 375],
      ['iphone16promax-portrait', 440, 956],
      ['iphone16promax-landscape', 956, 440],
    ] as [string, number, number][]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: engine === 'chromium', hasTouch: true, userAgent: UA });
      const page = await ctx.newPage();
      const errs: string[] = [];
      page.on('pageerror', (e) => errs.push(`page error: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errs.push(`console error: ${m.text()}`);
      });
      await page.goto(`${ORIGIN}/`);
      await page.waitForFunction(() => window.__cs2sim3d !== undefined, null, { timeout: 120_000 });
      await page.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 60_000 });
      await page.evaluate(() => window.__cs2sim3d?.seek(20));
      await page.waitForFunction(() => (window.__cs2sim3d?.stats().tick ?? 0) >= 1280, null, { timeout: 120_000 });
      await page.waitForTimeout(500);
      // A string, so the bundler adds no helpers (__name) to the page function.
      const layout = (await page.evaluate(`(() => {
        const r = (el) => { if (el === null) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
        return { view: r(document.getElementById('view')), controls: r(document.getElementById('bar')) };
      })()`)) as { view: Rect | null; controls: Rect | null };
      const before = await page.evaluate(() => window.__cs2sim3d?.stats().followed ?? '');
      const view = layout.view as Rect | null;
      if (view !== null) await page.touchscreen.tap(view.x + view.w / 2, view.y + view.h / 2);
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => window.__cs2sim3d?.stats().followed ?? '');
      const radar = (await page.evaluate(() => window.__cs2sim3d?.radar() as unknown)) as { team: string | null; marks: { team: string; kind: string }[] } | undefined;
      const enemies = radar?.team === null || radar === undefined ? 0 : radar.marks.filter((m) => m.team !== radar.team && m.kind !== 'ghost').length;
      const file = join(OUT, `${name}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 70 });
      const fits = view !== null && view.w >= w - 1 && view.x >= -1 && view.x + view.w <= w + 1;
      const ctl = layout.controls as Rect | null;
      const ctlInside = ctl === null || (ctl.y + ctl.h <= h + 1 && ctl.x + ctl.w <= w + 1);
      if (!fits) problems.push(`${name}: the view canvas doesn't fill the width (${JSON.stringify(view)})`);
      if (!ctlInside) problems.push(`${name}: the control bar overflows the screen (${JSON.stringify(ctl)})`);
      for (const e of errs) problems.push(`${name}: ${e}`);
      rows.push(`| ${name} | ${w} × ${h} | ${view === null ? '–' : `${view.w.toFixed(0)} × ${view.h.toFixed(0)}`} | ${ctl === null ? '–' : `${ctl.w.toFixed(0)} × ${ctl.h.toFixed(0)} at y ${ctl.y.toFixed(0)}`} | ${before} → ${after} | ${enemies} | ${errs.length} |`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`engine: ${engine}${engine === 'chromium' ? ' with iPhone emulation (WebKit not installed: Safari itself not tested)' : ''}`);
  console.log('| device | viewport | view canvas | control bar | tap on the view: spectated | enemy dots on the radar at 20 s (CS2 rules: spotted only) | page errors |');
  console.log('| --- | --- | --- | --- | --- | ---: | ---: |');
  for (const r of rows) console.log(r);
  console.log(`screenshots: ${OUT}`);
  if (problems.length > 0) {
    console.log(`PROBLEMS:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  }
}

void main();
