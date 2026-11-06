/**
 * Headless Chrome check of the built app (docs/app.md "Browser check").
 *
 *   npm run build && npx tsx tools/browser-check.ts [--out logs/browser-check] [--seconds 10]
 *
 * Serves dist/ with `vite preview`, opens it in headless Chromium (playwright-core; the browser
 * comes from PLAYWRIGHT_BROWSERS_PATH, `npx playwright-core install chromium`, or CHROME_PATH),
 * and:
 *  1. desktop 1280×860: screenshot of the ready state (round set up, 1:39), Start, a few seconds
 *     at 1×, screenshot again;
 *  2. plays cart: aims east of him with the mouse and holds S for 1 s (he must face east and move
 *     south: WASD is screen-relative), presses 3 (knife) and downloads the log and the trace;
 *  3. measures frames/s and ticks/s at 4× over `--seconds` (target 256 ticks/s ± 1 %);
 *  4. an iPhone-sized viewport (390×844, touch, DPR 3): starts in spectate mode, screenshot;
 *  5. checks determinism: the phone's spectate log has the same digest as a Node run of the same
 *     length, and the desktop's downloaded log (with a human) replays identically against a fresh Core;
 *  6. fails on console errors, page errors or requests to other origins.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { SessionLog, replay } from '../src/contracts/index';
import { ReplayCore } from '../src/core/index';
import { Session, parseSessionData } from '../src/app/session';

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

interface Stats {
  phase: string;
  tick: number;
  frames: number;
  ticksRun: number;
  droppedTicks: number;
  speed: number;
  human: string | null;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const OUT = resolve(arg('--out', 'logs/browser-check'));
const SECONDS = Number(arg('--seconds', '10'));
const PORT = 4179;
const ORIGIN = `http://127.0.0.1:${PORT}`;

async function waitForServer(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`server at ${url} did not start`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function startPreview(): ChildProcess {
  // Run Vite's bin with node directly (not through npx), so kill() stops the server itself.
  const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
  return spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
}

async function stats(page: Page): Promise<Stats & { now: number }> {
  return page.evaluate(() => {
    const hook = window.__cs2replay;
    if (hook === undefined) throw new Error('no __cs2replay hook');
    return { ...hook.stats(), now: performance.now() };
  });
}

async function cart(page: Page): Promise<{ x: number; y: number; yaw: number; weapon: string }> {
  return page.evaluate(() => {
    const p = window.__cs2replay?.session().observe().pawns.find((q) => q.id === 'cart');
    if (p === undefined) throw new Error('no cart');
    return { x: p.pos.x, y: p.pos.y, yaw: p.yaw, weapon: p.weapon };
  });
}

async function clockText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const s = window.__cs2replay?.session();
    return s === undefined ? '' : s.clock.hudClock(s.tick);
  });
}

function watch(page: Page, problems: string[]): void {
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('request', (r) => {
    if (!r.url().startsWith(ORIGIN) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) problems.push(`foreign request: ${r.url()}`);
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const server = startPreview();
  const problems: string[] = [];
  try {
    await waitForServer(ORIGIN + '/', 15_000);
    const exe = process.env['CHROME_PATH'];
    const browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
    console.log(`browser: ${browser.version()}`);

    // 1. Desktop: ready, then running at 1x.
    const desk = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    watch(desk, problems);
    await desk.goto(ORIGIN + '/');
    await desk.waitForFunction(() => window.__cs2replay !== undefined);
    await desk.waitForTimeout(500);
    const ready = await stats(desk);
    console.log(`ready: tick ${ready.tick}, clock ${await clockText(desk)}, human ${ready.human}, phase ${ready.phase}`);
    await desk.screenshot({ path: join(OUT, 'desktop-ready.png') });
    await desk.click('#start');
    await desk.waitForTimeout(3000);
    const ran = await stats(desk);
    console.log(`after ~3 s at 1x: tick ${ran.tick}, clock ${await clockText(desk)}`);
    await desk.screenshot({ path: join(OUT, 'desktop-running.png') });
    await desk.screenshot({ path: join(OUT, 'desktop-running.jpg'), type: 'jpeg', quality: 80 });

    let logPath = '';
    // 2. Play cart: aim east, hold S (screen-down = south) for 1 s, switch to the knife, download.
    const c0 = await cart(desk);
    const aim = await desk.evaluate(([x, y]) => window.__cs2replay?.screenOf(x, y), [c0.x + 400, c0.y] as const);
    if (aim === undefined) throw new Error('no screenOf');
    await desk.mouse.move(aim.x, aim.y);
    await desk.keyboard.down('s');
    await desk.waitForTimeout(1000);
    await desk.keyboard.up('s');
    await desk.keyboard.press('3');
    await desk.waitForTimeout(300);
    const c1 = await cart(desk);
    console.log(
      `human: aimed east, held S 1 s: cart (${c0.x}, ${c0.y}) yaw ${c0.yaw} ${c0.weapon} -> (${c1.x.toFixed(1)}, ${c1.y.toFixed(1)}) yaw ${c1.yaw} ${c1.weapon}`,
    );
    if (!(c0.y - c1.y > 100 && Math.abs(c1.x - c0.x) < 5)) problems.push('S did not move cart south');
    // The cursor stayed put while cart moved, so he now faces it at a slant.
    const expectYaw = (Math.atan2(c0.y - c1.y, c0.x + 400 - c1.x) * 180) / Math.PI;
    if (Math.abs(c1.yaw - expectYaw) > 1) problems.push(`cart does not face the cursor (yaw ${c1.yaw}, expected ${expectYaw.toFixed(2)})`);
    if (c1.weapon !== 'knife') problems.push(`key 3 did not switch to the knife (${c1.weapon})`);
    for (const [button, name] of [
      ['#dl-log', 'log'],
      ['#dl-trace', 'trace'],
    ] as const) {
      const [dl] = await Promise.all([desk.waitForEvent('download'), desk.click(button)]);
      const path = join(OUT, dl.suggestedFilename());
      await dl.saveAs(path);
      console.log(`download ${name}: ${dl.suggestedFilename()} (${statSync(path).size} bytes)`);
      if (name === 'log') logPath = path;
    }

    // 3. Rate at 4x.
    await desk.click('button[data-speed="4"]');
    await desk.waitForTimeout(1000);
    const a = await stats(desk);
    await desk.waitForTimeout(SECONDS * 1000);
    const b = await stats(desk);
    const sec = (b.now - a.now) / 1000;
    const fps = (b.frames - a.frames) / sec;
    const tps = (b.ticksRun - a.ticksRun) / sec;
    const err = (tps / 256 - 1) * 100;
    console.log(
      `4x over ${sec.toFixed(2)} s: ${fps.toFixed(1)} fps, ${tps.toFixed(1)} ticks/s (target 256, ${err >= 0 ? '+' : ''}${err.toFixed(2)} %), ` +
        `dropped ${b.droppedTicks - a.droppedTicks}, speed ${b.speed}`,
    );
    if (Math.abs(err) > 1) problems.push(`ticks/s at 4x off by ${err.toFixed(2)} %`);
    await desk.close();

    // 4. Phone-sized, touch: spectate by default.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    watch(phone, problems);
    await phone.goto(ORIGIN + '/');
    await phone.waitForFunction(() => window.__cs2replay !== undefined);
    await phone.tap('#start');
    await phone.waitForTimeout(2000);
    const ph = await stats(phone);
    console.log(`phone: human ${ph.human}, tick ${ph.tick}, clock ${await clockText(phone)}`);
    if (ph.human !== null) problems.push('phone did not start in spectate mode');
    await phone.screenshot({ path: join(OUT, 'phone-spectate.png') });
    await phone.click('#pause');
    const browserLog = await phone.evaluate(() => {
      const log = window.__cs2replay?.session().log();
      return log === undefined ? null : { lines: log.length, digest: log.digest() };
    });
    await phone.close();

    // 5. Determinism, Node vs. Chrome.
    const data = parseSessionData(read('../data/round.json'), read('../data/mirage-nav.json'), read('../data/tuning.json'));
    const node = new Session({ ...data, seed: 1, human: null });
    for (let i = 0; i < (browserLog?.lines ?? 0); i++) node.step();
    console.log(`spectate log: Chrome ${browserLog?.lines} lines ${browserLog?.digest}, Node ${node.log().length} lines ${node.log().digest()}`);
    if (browserLog === null || browserLog.digest !== node.log().digest()) problems.push('spectate log differs between Chrome and Node');
    const human = SessionLog.fromText(readFileSync(logPath, 'utf8'));
    const result = replay(human, new ReplayCore(node.model, node.schedule, data.tuning, 1));
    console.log(`desktop log (human cart, ${human.length} lines) replayed in Node: identical ${result.identical}`);
    if (!result.identical) problems.push(`desktop log does not replay: first mismatch at tick ${result.firstMismatchTick}`);

    await browser.close();
  } finally {
    server.kill();
  }
  console.log(`screenshots in ${OUT}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`PROBLEM ${p}`);
    process.exitCode = 1;
  }
}

await main();
