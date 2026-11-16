/**
 * End-to-end check of the whole cs2 site behind its lock, with a throwaway password (docs/deploy.md).
 *
 *   npm run check:locked [-- --web-apps <path>] [--tmp <dir>] [--out logs/locked-check] [--no-build]
 *
 * The cs2 site is web-apps' cs2 pages (index, mirage-round-replay) plus this repo's two sim pages, which this repo's
 * CI deploys itself (tools/pages/deploy.sh). The web-apps checkout is only read: `--web-apps`, else $WEB_APPS_DIR,
 * else a `web-apps` folder next to this repo (or next to its main checkout, from a git worktree). Everything is
 * written to a temp copy (default <os tmpdir>/cs2-e2e, which is /tmp/cs2-e2e on Linux) and the screenshots to
 * `--out`. The check:
 *
 *  1. tools/pages/{encrypt.cjs,lock.html,lock.json} must be byte for byte web-apps' cs2/tools copies (one password
 *     and one salt for every cs2 page); copies <web-apps>/cs2, without any sim/ or sim3d/ of its own, to <tmp>/cs2
 *     and adds dist-single/index.html and dist-single-3d/index.html as sim/ and sim3d/ (built first unless
 *     --no-build), with tools/pages' encrypt.cjs and lock.html;
 *  2. deletes <tmp>/cs2/tools/lock.json (so a fresh salt and verifier are made) and runs
 *     CS2_PASSWORD=test-only-password CS2_NEW_PASSWORD=1 node <tmp>/cs2/tools/encrypt.cjs <tmp>/cs2 <tmp>/out;
 *  3. the plaintext guard: tools/pages/deploy.sh's own grep (its pattern is read from the script) must find nothing
 *     in <tmp>/out, and must match the plaintext sim page (so it would catch that page published unencrypted);
 *     every output page must decrypt, in Node, to its source byte for byte;
 *  4. serves <tmp>/out at http://localhost:<port>/ and, in headless Chromium (playwright-core):
 *     - desktop 1280×860: /sim/ shows the lock screen, a wrong password is refused, the throwaway one opens the
 *       game: the canvas shows the radar, the clock reads 1:39, Start runs ticks; no console or page errors, and
 *       the only request is the page itself;
 *     - the same browser then opens /mirage-round-replay/ and the index without asking again (shared salt), and the
 *       index lists sim/; a fresh browser opens /mirage-round-replay/ with the throwaway password;
 *     - phone 390×844 (DPR 3, touch): lock screen, unlock by tapping and typing, spectate by default, Start by tap,
 *       pinch-zoom, drag-pan and double-tap on the map, 4× and Follow by tap, no sideways scrolling; the spectate
 *       log has the digest of a Node run of the same length (the embedded data decodes to data/*.json);
 *     - screenshots of the lock screen and the unlocked game at both sizes, the index and the replay;
 *  5. checks that the web-apps checkout is byte-for-byte what it was before.
 *
 * Real Safari is not tested (no WebKit here). Browser: PLAYWRIGHT_BROWSERS_PATH, `npx playwright-core install
 * chromium`, or CHROME_PATH.
 */
import { spawnSync } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { Session, parseSessionData } from '../src/app/session';
import { readWorld3d } from './harness';

const REPO = fileURLToPath(new URL('..', import.meta.url));
/** The throwaway password. It only ever locks the temp copy. */
const PASSWORD = 'test-only-password';
const MARKER = '.cs2-e2e';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
/** deploy.sh's plaintext pattern, if it can't be read from deploy.sh. */
const FALLBACK_GUARD = 'sk8ers|Sp4rtaN|snarlbot|WMD\\.';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const NO_BUILD = process.argv.includes('--no-build');
const OUT = resolve(arg('--out', join(REPO, 'logs', 'locked-check')));
const TMP = resolve(arg('--tmp', join(tmpdir(), 'cs2-e2e')));

const problems: string[] = [];
const notes: string[] = [];

function check(ok: boolean, what: string): boolean {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
  return ok;
}

function inside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
}

function kb(n: number): string {
  return `${(n / 1024).toFixed(1)} KB`;
}

/** A copy of the environment without any cs2 password, for every child but the throwaway encrypt. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['CS2_PASSWORD'];
  delete env['CS2_NEW_PASSWORD'];
  return env;
}

function run(cmd: string, args: readonly string[], env: NodeJS.ProcessEnv = cleanEnv()): string {
  const r = spawnSync(cmd, args, { cwd: REPO, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${String(r.status)}):\n${r.stdout}${r.stderr}`);
  return r.stdout + r.stderr;
}

function mainCheckout(): string {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' });
  return r.status === 0 ? dirname(r.stdout.trim()) : REPO;
}

function findWebApps(): string {
  const given = arg('--web-apps', '') || (process.env['WEB_APPS_DIR'] ?? '');
  const candidates = given !== '' ? [given] : [join(REPO, '..', 'web-apps'), join(mainCheckout(), '..', 'web-apps')];
  for (const c of candidates) if (existsSync(join(c, 'cs2', 'tools', 'encrypt.cjs'))) return resolve(c);
  throw new Error(`no web-apps checkout found (tried ${candidates.join(', ')}); pass --web-apps <path> or set WEB_APPS_DIR`);
}

/** sha256 over every file's path and bytes under dir. */
function treeHash(dir: string): string {
  const h = createHash('sha256');
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name))
    .sort();
  for (const f of files) h.update(relative(dir, f)).update('\0').update(readFileSync(f)).update('\0');
  return h.digest('hex');
}

function freshTemp(dir: string, webApps: string): void {
  if (inside(dir, webApps) || inside(webApps, dir) || inside(REPO, dir)) throw new Error(`--tmp ${dir} overlaps the web-apps checkout or this repo`);
  if (existsSync(dir)) {
    if (!existsSync(join(dir, MARKER)) && readdirSync(dir).length > 0) throw new Error(`${dir} exists and was not made by this check: remove it or pass --tmp`);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MARKER), 'Made by cs2-round-replay tools/e2e-locked.ts; safe to delete.\n');
}

interface Payload {
  v: number;
  salt: string;
  iter: number;
  iv: string;
  ct: string;
}

/** Decrypt one locked page in Node, the way tools/lock.html does in the browser. */
function decryptPage(html: string, key: Buffer): Buffer {
  const m = /<script id="payload" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (m?.[1] === undefined) throw new Error('no payload');
  const p = JSON.parse(m[1]) as Payload;
  const ct = Buffer.from(p.ct, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(p.iv, 'base64'));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

interface Served {
  origin: string;
  /** "GET /path" for every request the server got, in order. */
  log: string[];
  close: () => Promise<void>;
}

/** A static server for root on the loopback interface only (127.0.0.1, and ::1 where there is one). */
async function serve(root: string): Promise<Served> {
  const log: string[] = [];
  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    log.push(`${req.method ?? 'GET'} ${path}`);
    const file = resolve(root, '.' + path);
    if (!inside(file, root)) {
      res.writeHead(403).end();
      return;
    }
    let target = file;
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith('/')) {
        res.writeHead(301, { Location: path + '/' }).end();
        return;
      }
      target = join(file, 'index.html');
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(target));
  };
  const servers: Server[] = [];
  const v4 = createServer(handler);
  await new Promise<void>((ok, fail) => v4.once('error', fail).listen(0, '127.0.0.1', ok));
  servers.push(v4);
  const port = (v4.address() as AddressInfo).port;
  const v6 = createServer(handler);
  await new Promise<void>((ok) => v6.once('error', () => ok()).listen(port, '::1', () => (servers.push(v6), ok())));
  return {
    origin: `http://localhost:${port}`,
    log,
    close: () => Promise.all(servers.map((s) => new Promise<void>((ok) => s.close(() => ok())))).then(() => undefined),
  };
}

interface Stats {
  phase: string;
  tick: number;
  speed: number;
  human: string | null;
  overlays: { follow: boolean; ghost: boolean; tracks: boolean; panel: boolean };
  camera: { zoom: number; cx: number; cy: number };
}

async function stats(page: Page): Promise<Stats> {
  return page.evaluate(() => {
    const hook = window.__cs2replay;
    if (hook === undefined) throw new Error('no __cs2replay hook');
    return hook.stats();
  });
}

async function clock(page: Page): Promise<string> {
  return (await page.locator('#clock-text').textContent()) ?? '';
}

/** Share of sampled canvas pixels brighter than the night background, and distinct colours (5 bits a channel). */
async function canvasLook(page: Page): Promise<{ w: number; h: number; lit: number; colours: number }> {
  // No named functions inside evaluate(): tsx would wrap them in a helper the page doesn't have.
  return page.evaluate(() => {
    const c = document.getElementById('view');
    if (!(c instanceof HTMLCanvasElement)) throw new Error('no #view canvas');
    const ctx = c.getContext('2d');
    if (ctx === null) throw new Error('no 2d context');
    const w = c.width;
    const h = c.height;
    const px = ctx.getImageData(0, 0, w, h).data;
    const step = Math.max(1, Math.floor(Math.min(w, h) / 240));
    const seen = new Set<number>();
    let lit = 0;
    let n = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = px[i] ?? 0;
        const g = px[i + 1] ?? 0;
        const b = px[i + 2] ?? 0;
        n++;
        if (r + g + b > 60) lit++;
        seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      }
    }
    return { w, h, lit: lit / n, colours: seen.size };
  });
}

interface Watch {
  /** Requests the page made (Playwright's view), with the step they happened in. */
  requests: { step: string; url: string }[];
  errors: { step: string; text: string }[];
  step: string;
}

function watch(page: Page): Watch {
  const w: Watch = { requests: [], errors: [], step: '' };
  page.on('console', (m) => {
    if (m.type() === 'error') w.errors.push({ step: w.step, text: `console: ${m.text()}` });
  });
  page.on('pageerror', (e) => w.errors.push({ step: w.step, text: `page error: ${e.message}` }));
  page.on('request', (r) => w.requests.push({ step: w.step, url: r.url() }));
  return w;
}

/** The existing replay page loads web fonts and (for its 3D view) three.js from CDNs: stub the fonts, block the rest. */
async function hermetic(ctx: BrowserContext, origin: string, blocked: string[]): Promise<void> {
  await ctx.route(
    (url) => !url.href.startsWith(origin) && !url.protocol.startsWith('data') && !url.protocol.startsWith('blob'),
    async (route) => {
      const url = route.request().url();
      blocked.push(url);
      if (/fonts\.(googleapis|gstatic)\.com/.test(url)) await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      else await route.abort();
    },
  );
}

/** Checks for one unlocked sim page: radar on the canvas, clock 1:39, nothing running yet. */
async function checkReady(page: Page, label: string): Promise<void> {
  await page.waitForFunction(() => window.__cs2replay !== undefined, null, { timeout: 30_000 });
  await page.waitForFunction(() => document.getElementById('status')?.hidden === true, null, { timeout: 10_000 });
  await page.waitForTimeout(300);
  const look = await canvasLook(page);
  // The radar's floors are mid grey-blue; without it the canvas is the night background and a few pawns (~1 % lit).
  check(look.lit > 0.1 && look.colours > 300, `${label}: the canvas shows the radar (${(look.lit * 100).toFixed(0)} % lit, ${look.colours} colours, ${look.w}×${look.h})`);
  const c = await clock(page);
  check(c === '1:39', `${label}: the clock shows ${c} (want 1:39)`);
  const s = await stats(page);
  check(s.phase === 'ready' && s.tick === 1, `${label}: ready at tick ${s.tick}`);
}

async function ticksAdvance(page: Page, label: string, minTicks: number): Promise<number> {
  const before = (await stats(page)).tick;
  await page.waitForFunction((k) => (window.__cs2replay?.stats().tick ?? 0) >= k, before + minTicks, { timeout: 20_000 }).catch(() => undefined);
  const s = await stats(page);
  check(s.phase === 'running' && s.tick >= before + minTicks, `${label}: ticks advance (${before} → ${s.tick}, clock ${await clock(page)})`);
  return s.tick;
}

function onlyThePage(w: Watch, steps: readonly string[], origin: string, page: string, label: string): void {
  const reqs = w.requests.filter((r) => steps.includes(r.step));
  const network = reqs.filter((r) => !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
  const extra = network.filter((r) => r.url !== origin + page);
  const inline = reqs.length - network.length;
  check(
    extra.length === 0 && network.length >= 1,
    `${label}: no requests beyond the page itself (${network.length} network: ${[...new Set(network.map((r) => r.url.replace(origin, '')))].join(', ')}` +
      `${inline > 0 ? `; ${inline} data:/blob: URL(s), decoded in memory` : ''}${extra.length > 0 ? `; EXTRA ${extra.map((r) => r.url).join(', ')}` : ''})`,
  );
  const errs = w.errors.filter((e) => steps.includes(e.step));
  check(errs.length === 0, `${label}: no console or page errors${errs.length > 0 ? `: ${errs.map((e) => e.text).join(' | ')}` : ''}`);
}

async function unlock(page: Page, password: string, touch: boolean): Promise<void> {
  if (touch) {
    await page.tap('#pw');
    await page.keyboard.type(password);
    await page.tap('#go');
  } else {
    await page.fill('#pw', password);
    await page.click('#go');
  }
}

/** One- or two-finger gesture on the canvas through CDP touch events (which become pointer events). */
async function gesture(page: Page, from: readonly { x: number; y: number }[], to: readonly { x: number; y: number }[], steps = 10): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const at = (k: number): { x: number; y: number; id: number }[] =>
    from.map((p, i) => {
      const q = to[i] ?? p;
      return { x: p.x + ((q.x - p.x) * k) / steps, y: p.y + ((q.y - p.y) * k) / steps, id: i };
    });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let k = 1; k <= steps; k++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function desktop(browser: Browser, origin: string, server: Served, blocked: string[]): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await hermetic(ctx, origin, blocked);
  const page = await ctx.newPage();
  const w = watch(page);

  w.step = 'sim';
  const serverFrom = server.log.length;
  await page.goto(origin + '/sim/');
  await page.waitForSelector('#pw', { state: 'visible' });
  await page.screenshot({ path: join(OUT, 'lock-desktop.png') });
  await page.fill('#pw', 'not-the-test-password');
  await page.click('#go');
  await page.waitForSelector('#msg.err', { timeout: 20_000 });
  check(await page.locator('#pw').isVisible(), 'desktop: a wrong password is refused');
  const t0 = Date.now();
  await unlock(page, PASSWORD, false);
  await checkReady(page, 'desktop');
  console.log(`     (unlock to ready: ${((Date.now() - t0) / 1000).toFixed(1)} s, including PBKDF2 600k in the page)`);
  await page.click('#start');
  await ticksAdvance(page, 'desktop', 128);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, 'sim-desktop.png') });
  const serverSim = server.log.slice(serverFrom);
  onlyThePage(w, ['sim'], origin, '/sim/', 'desktop');
  check(
    serverSim.every((l) => l === 'GET /sim/' || l === 'GET /favicon.ico'),
    `desktop: the server saw only ${[...new Set(serverSim)].join(', ')}`,
  );
  if (serverSim.includes('GET /favicon.ico')) notes.push('Chromium asked for /favicon.ico on the lock page (tools/lock.html has no icon link); not the app.');

  // Shared salt: the key remembered by /sim/ opens the existing replay and the index without asking.
  w.step = 'mirage-remembered';
  await page.goto(origin + '/mirage-round-replay/');
  await page.waitForSelector('#map2d', { timeout: 30_000 });
  check(!(await page.locator('#pw').isVisible().catch(() => false)), 'shared salt: /mirage-round-replay/ opens with the key /sim/ remembered, without asking');
  check((await page.title()).includes('Mirage'), `shared salt: the replay's title is "${await page.title()}"`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, 'mirage-desktop.png') });

  w.step = 'index';
  await page.goto(origin + '/');
  await page.waitForSelector('h1:has-text("CS2 pages")', { timeout: 30_000 });
  const cards = await page.locator('a.page').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  check(cards.includes('sim/') && cards.includes('mirage-round-replay/'), `index: opens with the remembered key and lists ${cards.join(', ')}`);
  await page.screenshot({ path: join(OUT, 'index-desktop.png'), fullPage: true });
  w.step = 'index-to-sim';
  await page.click('a.page[href="sim/"]');
  await page.waitForFunction(() => window.__cs2replay !== undefined, null, { timeout: 30_000 });
  check((await clock(page)) === '1:39', 'index: its sim/ card opens the game without asking again');
  onlyThePage(w, ['index-to-sim'], origin, '/sim/', 'sim from the index');
  const late = w.errors.filter((e) => e.step !== 'sim' && e.step !== 'index-to-sim');
  if (late.length > 0) notes.push(`errors on the other pages (blocked CDN requests): ${late.map((e) => `${e.step}: ${e.text}`).join(' | ')}`);
  await ctx.close();

  // A fresh browser (nothing remembered) opens the existing replay with the throwaway password.
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await hermetic(fresh, origin, blocked);
  const p2 = await fresh.newPage();
  await p2.goto(origin + '/mirage-round-replay/');
  await p2.waitForSelector('#pw', { state: 'visible' });
  await unlock(p2, PASSWORD, false);
  await p2.waitForSelector('#map2d', { timeout: 30_000 });
  check(true, 'shared salt: a fresh browser opens /mirage-round-replay/ with the throwaway password');
  await fresh.close();
}

async function phone(browser: Browser, origin: string, blocked: string[]): Promise<{ lines: number; digest: string } | null> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
  await hermetic(ctx, origin, blocked);
  const page = await ctx.newPage();
  const w = watch(page);
  w.step = 'sim';
  await page.goto(origin + '/sim/');
  await page.waitForSelector('#pw', { state: 'visible' });
  await page.screenshot({ path: join(OUT, 'lock-phone.png') });
  await unlock(page, PASSWORD, true);
  await checkReady(page, 'phone');
  const s0 = await stats(page);
  check(s0.human === null && !s0.overlays.panel, `phone: starts spectating (human ${String(s0.human)}), panel ${s0.overlays.panel ? 'open' : 'collapsed'}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `phone: no sideways scrolling (${overflow} px)`);
  await page.screenshot({ path: join(OUT, 'sim-phone-ready.png') });

  await page.tap('#start');
  await ticksAdvance(page, 'phone (Start by tap)', 64);
  const box = await page.locator('#view').boundingBox();
  if (box === null) throw new Error('no canvas box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await gesture(page, [{ x: cx - 40, y: cy }, { x: cx + 40, y: cy }], [{ x: cx - 130, y: cy }, { x: cx + 130, y: cy }]);
  const zoomed = (await stats(page)).camera;
  check(zoomed.zoom > 1.5, `phone: pinch zooms the map (zoom ${zoomed.zoom.toFixed(2)})`);
  await gesture(page, [{ x: cx, y: cy }], [{ x: cx + 90, y: cy + 60 }]);
  const panned = (await stats(page)).camera;
  check(Math.hypot(panned.cx - zoomed.cx, panned.cy - zoomed.cy) > 1, `phone: one-finger drag pans (centre moved ${Math.hypot(panned.cx - zoomed.cx, panned.cy - zoomed.cy).toFixed(1)})`);
  await page.screenshot({ path: join(OUT, 'sim-phone-zoomed.png') });
  await page.touchscreen.tap(cx, cy);
  await page.waitForTimeout(80);
  await page.touchscreen.tap(cx, cy);
  await page.waitForTimeout(200);
  const reset = (await stats(page)).camera;
  check(reset.zoom === 1, `phone: double-tap shows the whole map again (zoom ${reset.zoom.toFixed(2)})`);

  // Embedded data = data/*.json: the spectate log so far has the digest of a Node run of the same length.
  // (Camera gestures and Start are not logged; pause is logged on the next step, which hasn't run yet.)
  await page.tap('#pause');
  const s1 = await stats(page);
  check(s1.phase === 'paused', `phone: Pause by tap (${s1.phase})`);
  const log = await page.evaluate(() => {
    const l = window.__cs2replay?.session().log();
    return l === undefined ? null : { lines: l.length, digest: l.digest() };
  });

  await page.tap('#pause');
  await page.tap('button[data-speed="4"]');
  await page.tap('button[data-overlay="follow"]');
  const s2 = await stats(page);
  check(s2.phase === 'running' && s2.speed === 4 && s2.overlays.follow, `phone: Resume, 4× and Follow by tap (${s2.phase}, ${s2.speed}×, follow ${String(s2.overlays.follow)})`);
  const t2 = await ticksAdvance(page, 'phone at 4×', 256);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'sim-phone.png') });
  console.log(`     (phone at tick ${t2}, clock ${await clock(page)})`);
  onlyThePage(w, ['sim'], origin, '/sim/', 'phone');
  await ctx.close();
  return log;
}

async function main(): Promise<void> {
  const webApps = findWebApps();
  const before = treeHash(join(webApps, 'cs2'));
  console.log(`web-apps (read only): ${webApps}\ntemp copy: ${TMP}\nscreenshots: ${OUT}`);
  freshTemp(TMP, webApps);
  mkdirSync(OUT, { recursive: true });
  const cs2 = join(TMP, 'cs2');
  const out = join(TMP, 'out');
  // 1. The site as published: web-apps' cs2 pages, plus this repo's two builds as sim/ and sim3d/.
  const pagesTools = join(REPO, 'tools', 'pages');
  for (const f of ['encrypt.cjs', 'lock.html', 'lock.json']) {
    check(readFileSync(join(pagesTools, f)).equals(readFileSync(join(webApps, 'cs2', 'tools', f))), `tools/pages/${f} is byte for byte web-apps' cs2/tools/${f}`);
  }
  const ownPage = (src: string): boolean => {
    const top = relative(join(webApps, 'cs2'), src).split(sep)[0];
    return top === 'sim' || top === 'sim3d';
  };
  cpSync(join(webApps, 'cs2'), cs2, { recursive: true, filter: (src) => !src.split(sep).includes('node_modules') && !ownPage(src) });
  if (!NO_BUILD) {
    run('npm', ['run', '--silent', 'build:single']);
    run('npm', ['run', '--silent', 'build:single:3d']);
  }
  for (const [page, dist] of [['sim', 'dist-single'], ['sim3d', 'dist-single-3d']] as const) {
    mkdirSync(join(cs2, page), { recursive: true });
    cpSync(join(REPO, dist, 'index.html'), join(cs2, page, 'index.html'));
  }
  for (const f of ['encrypt.cjs', 'lock.html']) cpSync(join(pagesTools, f), join(cs2, 'tools', f));
  const plain = readFileSync(join(cs2, 'sim', 'index.html'));
  console.log(`sim page: dist-single/index.html (${kb(plain.length)}, gzip ${kb(gzipSync(plain, { level: 9 }).length)})`);

  // 2. Encrypt the temp copy with a fresh salt and the throwaway password.
  const lockJson = join(cs2, 'tools', 'lock.json');
  const realSalt = existsSync(join(webApps, 'cs2', 'tools', 'lock.json')) ? (JSON.parse(readFileSync(join(webApps, 'cs2', 'tools', 'lock.json'), 'utf8')) as { salt: string }).salt : '';
  rmSync(lockJson, { force: true });
  const enc = run(process.execPath, [join(cs2, 'tools', 'encrypt.cjs'), cs2, out], { ...cleanEnv(), CS2_PASSWORD: PASSWORD, CS2_NEW_PASSWORD: '1' });
  console.log(enc.trim());
  const cfg = JSON.parse(readFileSync(lockJson, 'utf8')) as { salt: string; iterations: number; verifier?: string };
  check(cfg.salt !== realSalt && typeof cfg.verifier === 'string', 'encrypt.cjs: made a fresh salt and verifier in the temp copy');

  // 3. Plaintext guard and decryption.
  const deploySh = readFileSync(join(pagesTools, 'deploy.sh'), 'utf8');
  const pattern = /grep -rlE '([^']+)'/.exec(deploySh)?.[1] ?? FALLBACK_GUARD;
  const guard = spawnSync('grep', ['-rlE', pattern, out], { encoding: 'utf8' });
  check(guard.status === 1, `plaintext guard: deploy.sh's grep -rlE '${pattern}' finds nothing in the encrypted output${guard.status === 0 ? `: ${guard.stdout.trim()}` : ''}`);
  const control = spawnSync('grep', ['-cE', pattern, join(cs2, 'sim', 'index.html')], { encoding: 'utf8' });
  check(control.status === 0, `plaintext guard: the same grep matches the plaintext sim page (${control.stdout.trim()} line(s)), so it would catch it unencrypted`);
  const pages = readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(out, join(d.parentPath, d.name)))
    .sort();
  check(pages.join(' ') === ['index.html', join('mirage-round-replay', 'index.html'), join('sim', 'index.html'), join('sim3d', 'index.html')].sort().join(' '), `encrypted output: ${pages.join(', ')}`);
  const key = pbkdf2Sync(PASSWORD.normalize('NFC'), Buffer.from(cfg.salt, 'base64'), cfg.iterations, 32, 'sha256');
  for (const rel of pages) {
    const locked = readFileSync(join(out, rel), 'utf8');
    let ok: boolean;
    try {
      ok = decryptPage(locked, key).equals(readFileSync(join(cs2, rel)));
    } catch {
      ok = false;
    }
    check(ok && !locked.includes('__cs2replay'), `${rel}: a lock page (${kb(Buffer.byteLength(locked))}) that decrypts to its source byte for byte`);
  }
  const lockedSim = statSync(join(out, 'sim', 'index.html')).size;
  const lockedGz = gzipSync(readFileSync(join(out, 'sim', 'index.html')), { level: 9 }).length;

  // 4. In the browser.
  const server = await serve(out);
  const blocked: string[] = [];
  const exe = process.env['CHROME_PATH'];
  const browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
  let log: { lines: number; digest: string } | null;
  try {
    console.log(`serving ${out} at ${server.origin}/ (Chromium ${browser.version()})`);
    await desktop(browser, server.origin, server, blocked);
    log = await phone(browser, server.origin, blocked);
  } finally {
    await browser.close();
    await server.close();
  }
  const data = parseSessionData(
    readFileSync(join(REPO, 'data', 'round.json'), 'utf8'),
    readFileSync(join(REPO, 'data', 'mirage-nav.json'), 'utf8'),
    readFileSync(join(REPO, 'data', 'tuning.json'), 'utf8'),
    readFileSync(join(REPO, 'data', 'mirage-vismask.json'), 'utf8'),
    readWorld3d(REPO),
  );
  const node = new Session({ ...data, seed: 1, human: null });
  for (let i = 0; i < (log?.lines ?? 0); i++) node.step();
  check(log !== null && log.lines > 64 && log.digest === node.log().digest(), `embedded data: the phone's spectate log (${log?.lines ?? 0} lines, ${log?.digest ?? '?'}) matches Node on data/*.json (${node.log().digest()})`);
  if (blocked.length > 0) notes.push(`blocked or stubbed CDN requests from the existing pages: ${[...new Set(blocked.map((u) => new URL(u).host))].join(', ')}`);

  // 5. The real checkout is untouched.
  check(treeHash(join(webApps, 'cs2')) === before, `the web-apps checkout is unchanged (${webApps}/cs2)`);

  const summary = {
    plaintext: { bytes: plain.length, gzip: gzipSync(plain, { level: 9 }).length },
    locked: { bytes: lockedSim, gzip: lockedGz },
    pages,
    screenshots: readdirSync(OUT).filter((f) => f.endsWith('.png')).map((f) => join(OUT, f)),
    notes,
    problems,
  };
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`\nsim page: ${kb(plain.length)} plaintext (gzip ${kb(summary.plaintext.gzip)}), ${kb(lockedSim)} locked (gzip ${kb(lockedGz)})`);
  for (const n of notes) console.log(`note: ${n}`);
  console.log(`screenshots and summary.json in ${OUT}; temp copy left in ${TMP}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`PROBLEM ${p}`);
    process.exitCode = 1;
  } else {
    console.log('All checks passed.');
  }
}

await main();
