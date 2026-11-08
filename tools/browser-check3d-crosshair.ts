/**
 * W1 (#32, #77): the crosshair stays at the screen centre through a spray (CS2's cl_crosshair_recoil 0), in headless
 * Chromium on a build (`npm run build:3d`):
 *
 *   npm run check:browser:3d:crosshair [-- --single] [--port 4184]
 *
 * cart plays from the start (`?human=cart`) with the AK-47; a burst of at least 10 shots: the #crosshair element's
 * style and its on-screen box are the same on every sample (the screen centre) while the camera kicks. Then with
 * "Crosshair follows recoil" on, the same burst moves it off centre (where the next bullet goes). Exits 1 on a problem.
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const arg = (n: string, d: string): string => (process.argv.includes(n) ? (process.argv[process.argv.indexOf(n) + 1] ?? d) : d);
const PORT = Number(arg('--port', '4184'));
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

interface PawnLite {
  weapon: string;
}

const cart = (p: Page): Promise<PawnLite> => p.evaluate(() => window.__cs2sim3d?.session().observe().pawns.find((q) => q.id === 'cart') as unknown as PawnLite);
const tickOf = (p: Page): Promise<number> => p.evaluate(() => window.__cs2sim3d?.stats().tick ?? 0);
const shotsOf = (p: Page): Promise<number> => p.evaluate(() => window.__cs2sim3d?.stats().humanShots ?? 0);

async function waitFor(p: Page, f: () => Promise<boolean>, ms = 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await f()) return true;
    await p.waitForTimeout(40);
  }
  return false;
}

/** Wait `n` game ticks (a loaded box runs the round slower than real time). */
async function ticks(p: Page, n: number): Promise<void> {
  const t0 = await tickOf(p);
  await waitFor(p, async () => (await tickOf(p)) >= t0 + n, 120_000);
}

interface Sample {
  readonly style: string | null;
  readonly box: string;
  readonly camPitch: number | null;
}

const sample = (p: Page): Promise<Sample> =>
  p.evaluate(() => {
    const c = document.getElementById('crosshair');
    const r = c?.getBoundingClientRect();
    return { style: c?.getAttribute('style') ?? null, box: r === undefined ? '' : `${r.x},${r.y},${r.width},${r.height}`, camPitch: window.__cs2sim3d?.test.state().camera.pitch ?? null };
  });

async function main(): Promise<void> {
  if (process.env['CHROMIUM_WEBGL_RENDERER'] === undefined) process.env['CHROMIUM_WEBGL_RENDERER'] = 'lavapipe';
  statSync(join(DIR, 'index.html'));
  const server = serve(DIR);
  const exe = process.env['CHROME_PATH'];
  const browser: Browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
  const problems: string[] = [];
  const report: Record<string, unknown> = {};
  try {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    await p.goto(`${ORIGIN}/?human=cart`);
    await p.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 120_000 });
    await p.evaluate(() => window.__cs2sim3d?.perf.start());
    await ticks(p, 90);
    await p.keyboard.press('Digit1');
    await waitFor(p, async () => (await cart(p)).weapon === 'ak47');
    await ticks(p, 80); // the AK's deploy
    const box = await p.locator('#view').boundingBox();
    await p.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
    /** Hold mouse 1 until 10 more shots, sampling the crosshair every poll. */
    const burst = async (): Promise<{ shots: number; samples: Sample[] }> => {
      const s0 = await shotsOf(p);
      const samples: Sample[] = [await sample(p)];
      await p.mouse.down();
      const t0 = Date.now();
      while ((await shotsOf(p)) - s0 < 10 && Date.now() - t0 < 120_000) samples.push(await sample(p));
      samples.push(await sample(p));
      await p.mouse.up();
      return { shots: (await shotsOf(p)) - s0, samples };
    };
    const fixed = await burst();
    const boxes = new Set(fixed.samples.map((s) => s.box));
    const styles = new Set(fixed.samples.map((s) => s.style));
    const pitches = fixed.samples.map((s) => s.camPitch ?? 0);
    report['fixed'] = { shots: fixed.shots, samples: fixed.samples.length, boxes: [...boxes], styles: [...styles], cameraKick: Math.max(...pitches) - Math.min(...pitches) };
    if (fixed.shots < 10) problems.push(`only ${fixed.shots} shots in the burst`);
    if (boxes.size !== 1 || styles.size !== 1 || !styles.has(null)) problems.push(`the crosshair moved with "Crosshair follows recoil" off: ${JSON.stringify(report['fixed'])}`);
    if (Math.max(...pitches) - Math.min(...pitches) < 1) problems.push(`the camera didn't kick: ${JSON.stringify(report['fixed'])}`);
    await ticks(p, 100);
    await p.evaluate(() => {
      const b = document.getElementById('set-xhair-recoil') as HTMLInputElement;
      b.checked = true;
      b.dispatchEvent(new Event('change'));
    });
    const follow = await burst();
    const moved = follow.samples.filter((s) => s.style !== null && s.style.includes('translate'));
    report['follow'] = { shots: follow.shots, samples: follow.samples.length, moved: moved.length, examples: moved.slice(0, 3).map((s) => s.style) };
    if (moved.length === 0) problems.push(`the crosshair didn't follow the recoil with the setting on: ${JSON.stringify(report['follow'])}`);
    report['stored'] = await p.evaluate(() => (JSON.parse(localStorage.getItem('cs2-sim3d-settings') ?? '{}') as { crosshairRecoil?: boolean }).crosshairRecoil ?? null);
    if (report['stored'] !== true) problems.push('the setting was not stored');
  } finally {
    await browser.close();
    server.close();
  }
  console.log(JSON.stringify({ report, problems }, null, 2));
  if (problems.length > 0) process.exit(1);
}

void main();
