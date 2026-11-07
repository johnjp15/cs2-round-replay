/**
 * V1 · the AK-47's real fire cadence in the 3D app (John 11:02): take control of cart, hold mouse 1 for 2 s and count
 * the shots against the sim ticks and the wall clock, for each FPS setting. 600 RPM = 10 shots per 64 ticks.
 *
 *   npm run build:3d && npx tsx tools/e2e/ak-browser.ts [--port 4184]      (npm run test:e2e:ak-browser)
 */
import { createServer, type Server } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg } from 'node:os';
import { chromium, type Page } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '4184');
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DIR = resolve(ROOT, 'dist-3d');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.bin': 'application/octet-stream', '.css': 'text/css' };

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

interface S {
  tick: number;
  fps: number;
  tps: number;
  human: string | null;
  humanShots: number;
  humanHits: number;
}
const stats = (p: Page): Promise<S> => p.evaluate(() => window.__cs2sim3d?.stats() as unknown as S);

async function main(): Promise<void> {
  if (process.env['CHROMIUM_WEBGL_RENDERER'] === undefined) process.env['CHROMIUM_WEBGL_RENDERER'] = 'lavapipe';
  const server = serve(DIR);
  const exe = process.env['CHROME_PATH'];
  const browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
  const rows: string[] = [];
  try {
    for (const fps of ['uncapped', '60', 'vsync']) {
      for (const [w, h] of [
        [640, 400],
        [1280, 720],
      ] as [number, number][]) {
        const p = await browser.newPage({ viewport: { width: w, height: h } });
        await p.goto(`${ORIGIN}/`);
        await p.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 120_000 });
        await p.selectOption('#set-fps', fps);
        await p.click('#start');
        await p.evaluate(() => window.__cs2sim3d?.seek(8));
        await p.waitForFunction(() => (window.__cs2sim3d?.stats().tick ?? 0) >= 512, null, { timeout: 120_000 });
        await p.evaluate(() => {
          const b = document.getElementById('pause');
          if (b instanceof HTMLButtonElement && b.textContent === 'Resume') b.click();
        });
        await p.keyboard.press('KeyE');
        await p.waitForTimeout(1500);
        // Look at the floor in front (no one to hit), then hold mouse 1 for 2 s of wall time.
        await p.evaluate(() => window.__cs2sim3d?.mouse(0, 800));
        const box = await p.locator('#view').boundingBox();
        if (box === null) throw new Error('no view');
        await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        const a = await stats(p);
        const t0 = Date.now();
        await p.mouse.down();
        await p.waitForTimeout(2000);
        const b = await stats(p);
        const wall = (Date.now() - t0) / 1000;
        await p.mouse.up();
        const shots = b.humanShots - a.humanShots;
        const ticks = b.tick - a.tick;
        rows.push(
          `| ${fps} | ${w} × ${h} | ${a.human ?? '–'} | ${b.fps.toFixed(1)} | ${(ticks / wall).toFixed(1)} | ${shots} in ${ticks} ticks | ${((shots * 64) / Math.max(1, ticks)).toFixed(2)} | ${(shots / wall).toFixed(2)} | ${shots > 1 ? ((ticks / (shots - 1) / 64) * 1000).toFixed(0) : '–'} |`,
        );
        await p.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`machine load ${loadavg()[0]?.toFixed(1)} (2 cores, software WebGL)`);
  console.log('| FPS setting | viewport | human | page fps | sim ticks / wall s | shots | shots per 64 ticks (game s) | shots per wall s | ms per shot (game) |');
  console.log('| --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: |');
  for (const r of rows) console.log(r);
}

void main();
