/**
 * H1: headless Chromium check of the 3D page (docs/app3d.md "Browser check").
 *
 *   npm run build:3d && npm run check:browser:3d [-- --single] [--out docs/img] [--fps-size 640x400] [--seconds 4]
 *
 * Serves dist-3d/ (or, with --single, dist-single-3d/index.html: npm run build:single:3d) on port 4180 with a small
 * static server, opens it in headless Chromium (playwright-core; CHROME_PATH or the installed browser; WebGL through
 * the sandbox's lavapipe unless CHROMIUM_WEBGL_RENDERER is set), and:
 *  1. waits for the scene (the 3D hook and a drawn frame) and screenshots five moments at 1280 × 720:
 *     (a) 0 s, the ready state; (b) 18.5 s, Lokier at B seen from cart's window in Apartments; (c) the plant, 27.6 s;
 *     (d) ~50 s, Sp4rtaN behind donk in Apartments; (e) the defuse, ~64 s, Sp4rtaN on the bomb;
 *  2. measures frames/s and ticks/s while watching at 1× and at 4× (at `--fps-size`, default 640 × 400: headless
 *     WebGL here is software-rendered and a bare WebGL canvas tops out near 26–50 fps at 1280 × 800, so the frame
 *     rate is measured where the browser itself can reach 60; the 1280 × 720 rate is reported too);
 *  3. takes control: restart, seek to 18.2 s, E (keyboard): cart is the human, the HUD says "You: cart", the speed
 *     is 1×; the mouse turns the view by exactly counts × 1.25 × 0.022° (pointer-lock deltas through the page's
 *     automation hook, since a headless page can't lock the pointer); aims at Lokier's head, clicks mouse 1 and checks
 *     the shot was fired (the HUD's ammo drops, a tracer); screenshot (f) first person;
 *  4. A1 (tools/browser-check3d-a1.ts): audio starts on a click, firing schedules a sound, the AK reload animation
 *     runs for its reload time; viewmodel screenshots (docs/img/app3d-viewmodel-*.jpg);
 *  5. fails on page errors, console errors or requests to other origins.
 * Screenshots: `--out` (default docs/img) as app3d-*.jpg.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, loadavg } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright-core';
import { a1Checks } from './browser-check3d-a1';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
/** `--port <n>` or BROWSER_CHECK_PORT (another session may hold 4180). */
const PORT = Number(arg('--port', process.env['BROWSER_CHECK_PORT'] ?? '4180'));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SINGLE = process.argv.includes('--single');
const OUT = resolve(ROOT, arg('--out', 'docs/img'));
const SECONDS = Number(arg('--seconds', '4'));
const [FPS_W, FPS_H] = arg('--fps-size', '640x400').split('x').map(Number) as [number, number];
const DIR = resolve(ROOT, SINGLE ? 'dist-single-3d' : 'dist-3d');

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

interface Stats {
  phase: string;
  tick: number;
  fps: number;
  tps: number;
  speed: number;
  human: string | null;
  camera: string;
  look: { yaw: number; pitch: number };
  humanShots: number;
  humanHits: number;
  triangles: number;
  hud: { hp: string; clock: string; mode: string; killfeed: number };
}

const stats = (page: Page): Promise<Stats> => page.evaluate(() => (window.__cs2sim3d as NonNullable<typeof window.__cs2sim3d>).stats() as unknown as Stats);

async function open(browser: Browser, w: number, h: number, problems: string[], query = ''): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
  });
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:')) problems.push(`request to another origin: ${u}`);
  });
  await page.goto(`${ORIGIN}/${query}`);
  await page.waitForFunction(() => window.__cs2sim3d !== undefined, null, { timeout: 90_000 });
  await page.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 30_000 });
  return page;
}

/** Seek (the Session's, run ahead without drawing) and wait until it lands. */
async function seek(page: Page, t: number): Promise<void> {
  await page.evaluate((t) => window.__cs2sim3d?.seek(t), t);
  await page.waitForFunction((k) => (window.__cs2sim3d?.stats().tick ?? 0) >= k, Math.round(t * 64), { timeout: 120_000 });
  await page.waitForTimeout(400);
}

async function shot(page: Page, name: string): Promise<string> {
  const path = join(OUT, `app3d-${name}.jpg`);
  await page.screenshot({ path, type: 'jpeg', quality: 82 });
  return path;
}

async function rate(page: Page, speed: number): Promise<{ fps: number; tps: number }> {
  await page.click(`button[data-speed="${speed}"]`);
  await page.waitForTimeout(1200);
  const a = await stats(page);
  await page.waitForTimeout(SECONDS * 1000);
  const b = await stats(page);
  return { fps: (a.fps + b.fps) / 2, tps: (a.tps + b.tps) / 2 };
}

async function main(): Promise<void> {
  if (process.env['CHROMIUM_WEBGL_RENDERER'] === undefined) process.env['CHROMIUM_WEBGL_RENDERER'] = 'lavapipe';
  if (process.env['CHROMIUM_LAVAPIPE_THREADS'] === undefined) process.env['CHROMIUM_LAVAPIPE_THREADS'] = 'auto';
  statSync(join(DIR, 'index.html'));
  mkdirSync(OUT, { recursive: true });
  const server = serve(DIR);
  const exe = process.env['CHROME_PATH'];
  const browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
  const problems: string[] = [];
  const report: Record<string, unknown> = { page: SINGLE ? 'dist-single-3d/index.html' : 'dist-3d/', bytes: statSync(join(DIR, 'index.html')).size };
  try {
    // 1. Five moments, watching.
    const page = await open(browser, 1280, 720, problems);
    report['renderer'] = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const e = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl !== null && gl !== undefined && e !== null && e !== undefined ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    });
    const shots: string[] = [];
    shots.push(await shot(page, 'a-start'));
    const s0 = await stats(page);
    if (s0.phase !== 'ready' || s0.human !== null || s0.hud.clock !== '1:39') problems.push(`ready state: ${JSON.stringify(s0)}`);
    const view = await page.evaluate(() => window.__cs2sim3d?.view());
    report['view'] = view;
    if (view === undefined || Math.abs(view.vfov - 73.7398) > 0.01 || Math.abs(view.hfov - 2 * Math.atan(Math.tan((73.7398 * Math.PI) / 360) * view.aspect) * (180 / Math.PI)) > 0.05) problems.push(`camera FOV: ${JSON.stringify(view)}`);
    // (b) Lokier at B from cart's window: cart's eyes, looking at Lokier.
    await seek(page, 18.5);
    await page.evaluate(() => window.__cs2sim3d?.camera('pov', 'cart'));
    await page.waitForTimeout(300);
    shots.push(await shot(page, 'b-lokier-window'));
    // (c) The plant: third person behind barely.
    await seek(page, 27.6);
    await page.evaluate(() => window.__cs2sim3d?.camera('follow', 'barely'));
    await page.waitForTimeout(300);
    shots.push(await shot(page, 'c-plant'));
    const sp = await stats(page);
    // After the plant the clock is the bomb timer (40 → 0 s).
    if (!(Number(sp.hud.clock) > 35 && Number(sp.hud.clock) <= 40)) problems.push(`bomb clock after the plant: ${sp.hud.clock}`);
    // (d) Sp4rtaN behind donk in Apartments.
    await seek(page, 49.95);
    await page.evaluate(() => window.__cs2sim3d?.camera('follow', 'sp4rtan'));
    await page.waitForTimeout(300);
    shots.push(await shot(page, 'd-sp4rtan-donk'));
    // (e) The defuse.
    await seek(page, 64);
    await page.evaluate(() => window.__cs2sim3d?.camera('follow', 'sp4rtan'));
    await page.waitForTimeout(300);
    shots.push(await shot(page, 'e-defuse'));
    const se = await stats(page);
    report['killfeedAt64'] = se.hud.killfeed;
    // 2. Frame rate at 1280 × 720 (reported) …
    await page.evaluate(() => window.__cs2sim3d?.camera('follow', 'cart'));
    await seek(page, 10);
    await page.click('#start').catch(() => undefined);
    await page.evaluate(() => {
      const b = document.getElementById('pause');
      if (b instanceof HTMLButtonElement && b.textContent === 'Resume') b.click();
    });
    report['fps1280x720'] = await rate(page, 1);
    await page.close();
    // … and at the measured size.
    const small = await open(browser, FPS_W, FPS_H, problems);
    await small.click('#start');
    await small.waitForTimeout(800);
    const r1 = await rate(small, 1);
    const r4 = await rate(small, 4);
    report[`fps${FPS_W}x${FPS_H}`] = { x1: r1, x4: r4 };
    // The frame rate depends on the machine: on a shared, overloaded one (load per core > 1.25 during the run) it is
    // reported, not asserted (a starved browser misses frames and ticks whatever the page does).
    const load = loadavg()[0] ?? 0;
    const perCore = load / Math.max(1, cpus().length);
    report['load'] = { loadavg1: load, cores: cpus().length, perCore };
    const rateProblems: string[] = [];
    if (r1.fps < 55) rateProblems.push(`1× at ${FPS_W}×${FPS_H}: ${r1.fps.toFixed(1)} fps (< 55)`);
    if (Math.abs(r1.tps - 64) > 3) rateProblems.push(`1×: ${r1.tps.toFixed(1)} ticks/s (want 64)`);
    if (r4.tps < 200) rateProblems.push(`4×: ${r4.tps.toFixed(1)} ticks/s (want 256)`);
    if (perCore > 1.25) report['rateNotAsserted'] = rateProblems.map((x) => `${x} [machine load ${load.toFixed(1)} on ${cpus().length} cores]`);
    else problems.push(...rateProblems);
    await small.close();
    // 3. Take control and fire.
    const p = await open(browser, 1280, 720, problems);
    await p.click('#start');
    await seek(p, 18.2);
    await p.evaluate(() => {
      const b = document.getElementById('pause');
      if (b instanceof HTMLButtonElement && b.textContent === 'Resume') b.click();
    });
    await p.click('button[data-speed="4"]');
    await p.keyboard.press('KeyE');
    await p.waitForTimeout(500);
    const t0 = await stats(p);
    if (t0.human !== 'cart' || t0.speed !== 1 || !t0.hud.mode.startsWith('You: cart')) problems.push(`takeover: ${JSON.stringify({ human: t0.human, speed: t0.speed, mode: t0.hud.mode })}`);
    const before = t0.look;
    await p.evaluate(() => window.__cs2sim3d?.mouse(200, -50));
    await p.waitForTimeout(200);
    const after = (await stats(p)).look;
    const dYaw = before.yaw - after.yaw;
    const dPitch = after.pitch - before.pitch;
    report['mouse'] = { counts: [200, -50], dYaw, dPitch, want: [200 * 1.25 * 0.022, -50 * 1.25 * 0.022] };
    if (Math.abs(dYaw - 5.5) > 1e-6 || Math.abs(dPitch + 1.375) > 1e-6) problems.push(`mouse look: ${JSON.stringify(report['mouse'])}`);
    const clipBefore = await p.evaluate(() => document.getElementById('clip')?.textContent ?? '');
    await p.evaluate(() => window.__cs2sim3d?.aimAt('lokier'));
    const box = await p.locator('#view').boundingBox();
    if (box !== null) {
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.mouse.down();
      await p.waitForTimeout(60);
      await p.mouse.up();
    }
    await p.waitForTimeout(1000);
    const t1 = await stats(p);
    const clipAfter = await p.evaluate(() => document.getElementById('clip')?.textContent ?? '');
    const feed = await p.evaluate(() => document.getElementById('killfeed')?.textContent ?? '');
    report['fire'] = { shots: t1.humanShots, hits: t1.humanHits, clip: [clipBefore, clipAfter], hp: t1.hud.hp, killfeed: feed };
    if (t1.humanShots < 1 || clipAfter === clipBefore) problems.push(`firing: ${JSON.stringify(report['fire'])}`);
    shots.push(await shot(p, 'f-first-person'));
    report['screenshots'] = shots.map((x) => x.replace(ROOT + '/', ''));
    await p.close();
    // 5. A1: sound and the viewmodels.
    await a1Checks(browser, { open: (w, h) => open(browser, w, h, problems), seek, out: OUT, root: ROOT }, problems, report);
  } finally {
    await browser.close();
    server.close();
  }
  report['problems'] = problems;
  writeFileSync(join(ROOT, 'logs', 'browser-check3d.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (problems.length > 0) {
    console.error(`browser check 3D: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log('browser check 3D: ok');
}

await main();
