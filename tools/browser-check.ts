/**
 * Headless Chrome check of the built app (docs/app.md "Browser check").
 *
 *   npm run build && npx tsx tools/browser-check.ts [--out logs/browser-check] [--seconds 10]
 *
 * Serves dist/ with `vite preview`, opens it in headless Chromium (playwright-core; the browser
 * comes from PLAYWRIGHT_BROWSERS_PATH, `npx playwright-core install chromium`, or CHROME_PATH),
 * and:
 *  1. desktop 1280×860: screenshot (a) of the ready state (round set up, 1:39), Start, a few seconds
 *     at 1×, screenshot again;
 *  2. plays cart: aims east of him with the mouse and holds S for 1 s (he must face east and move
 *     south: WASD is screen-relative), presses 3 (knife) and downloads the log and the trace;
 *  3. measures frames/s and ticks/s at 4× over `--seconds` with every overlay on (tracks, ghost,
 *     status panel, follow camera zoomed in) (target 256 ticks/s ± 1 %);
 *  4. spectates on the desktop with the tracks overlay: screenshot (b) ~20 s in, when the Ts are
 *     coming through Apartments; checks that the wheel zooms about the cursor;
 *  5. follow camera zoomed in on cart: throws a smoke and fires a burst, checks that aiming through
 *     the zoomed view turns cart toward the cursor, screenshot (c) with the smoke and the tracers;
 *  6. an iPhone-sized viewport (390×844, touch, DPR 3): starts in spectate mode, screenshot (d); then zoomed in
 *     about the Ts near the top of the map, no pawn label may overlap the HUD (scoreboard, kill feed, panel,
 *     status card), screenshot (d2);
 *  6b. labels and the HUD on the desktop: at 900×700 the kill feed (kills at 12.8 s) must not cover the
 *     scoreboard, screenshot (g); with cart idle the 2D AI's LIVE pawns show their behaviour, target and goal in
 *     the status panel and their path with the tracks overlay, screenshot (h);
 *  7. checks determinism: the phone's spectate log has the same digest as a Node run of the same
 *     length, and the desktop's downloaded log (with a human) replays identically against a fresh Core;
 *  8. golden parity (E1): the no-human round runs in the page (`?human=none`, the app's own loop at 4×) to
 *     20 s, and its log through tick 1280 has the digest of the Node harness's (tools/harness.ts) at
 *     the same tick; so does the whole log the page made (to the tick it paused on);
 *  9. B5, rewind and summary: plays cart (no input) at 4×, rewinds with `[`, the −10 s button and by dragging the
 *     timeline, checks the rewound log is one straight run that replays in Node, seeks to 66 s and waits for the
 *     summary overlay 2 s after the round end (screenshot e), closes and reopens it, uses its Rewind 10 s; the same
 *     spectating (screenshot e2, "Played it like the tape") and on the phone (screenshot f). With the overlay showing
 *     (desktop and phone) it is one of the HUD's rectangles and no pawn label overlaps it (F);
 * 10. fails on console errors, page errors or requests to other origins.
 *
 *   npx tsx tools/browser-check.ts --only parity    # just step 8 (about 10 s)
 *   npx tsx tools/browser-check.ts --only b5        # just step 9
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { SessionLog, fnv1a32Hex, replay, stableStringify, type Control } from '../src/contracts/index';
import { Session, defaultCore, parseSessionData } from '../src/app/session';
import { NO_HUMAN, loadHarnessData, readWorld3d, runHarness } from './harness';

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
  overlays: { follow: boolean; ghost: boolean; tracks: boolean; panel: boolean };
  camera: { zoom: number; cx: number; cy: number };
  radarRebuilds: number;
  labels: { drawn: readonly Box[]; dropped: number; hud: readonly Box[] };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const OUT = resolve(arg('--out', 'logs/browser-check'));
const SECONDS = Number(arg('--seconds', '10'));
/** `--only parity` runs just the golden parity check (step 8). */
const ONLY = arg('--only', '');
/** Golden parity: compare the logs through this observe tick (20 s). */
const PARITY_TICK = 20 * 64;
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

/** Screenshot as PNG and as a JPEG (for docs). */
async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.screenshot({ path: join(OUT, `${name}.jpg`), type: 'jpeg', quality: 72 });
}

async function waitTick(page: Page, tick: number, ms = 30_000): Promise<void> {
  await page.waitForFunction((k) => (window.__cs2replay?.stats().tick ?? 0) >= k, tick, { timeout: ms });
}

/** Problems if any pawn label of the last frame overlaps one of the HUD's rectangles. */
async function labelsClearOfHud(page: Page, what: string, problems: string[]): Promise<void> {
  const st = await stats(page);
  const hit = st.labels.drawn.filter((l) => st.labels.hud.some((r) => l.x < r.x + r.w && l.x + l.w > r.x && l.y < r.y + r.h && l.y + l.h > r.y));
  console.log(`${what}: ${st.labels.drawn.length} labels drawn, ${st.labels.dropped} left out under the HUD, ${hit.length} overlapping it (HUD rects ${st.labels.hud.length})`);
  if (hit.length > 0) problems.push(`${what}: ${hit.length} pawn labels overlap the HUD`);
}

/**
 * With the summary overlay showing: it must be one of the HUD's rectangles the renderer keeps labels out of (as must the
 * timeline), and no pawn label of the last frame may overlap any of them.
 */
async function summaryClearOfLabels(page: Page, what: string, problems: string[]): Promise<void> {
  const rects = await page.evaluate(() => {
    const [hud, sum, tl] = ['hud', 'summary', 'timeline'].map((id) => document.getElementById(id)?.getBoundingClientRect() ?? null);
    return { hud: hud ?? null, sum: sum ?? null, tl: tl ?? null };
  });
  const st = await stats(page);
  const base = rects.hud;
  const listed = (r: DOMRect | null): boolean =>
    r !== null && base !== null && st.labels.hud.some((h) => Math.abs(h.x - (r.x - base.x)) < 1 && Math.abs(h.y - (r.y - base.y)) < 1 && Math.abs(h.w - r.width) < 1 && Math.abs(h.h - r.height) < 1);
  console.log(`${what}: summary ${rects.sum === null ? 'missing' : `${rects.sum.width.toFixed(0)}×${rects.sum.height.toFixed(0)} at y ${rects.sum.y.toFixed(0)}`} in the HUD rects ${listed(rects.sum)}, timeline in them ${listed(rects.tl)}`);
  if (!listed(rects.sum)) problems.push(`${what}: the summary overlay is not among the HUD rectangles`);
  if (!listed(rects.tl)) problems.push(`${what}: the timeline is not among the HUD rectangles`);
  await labelsClearOfHud(page, what, problems);
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

/**
 * Golden parity (E1): the page plays the no-human round with its own loop (4×) past 20 s, pauses, and hashes its
 * log through tick PARITY_TICK in the page (FNV-1a over the UTF-8 bytes, as SessionLog.digest); the Node harness
 * runs the same round to the tick the page paused on, and both digests must agree: through 20 s and for the
 * whole log.
 */
async function goldenParity(browser: Awaited<ReturnType<typeof chromium.launch>>, problems: string[]): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  watch(page, problems);
  await page.goto(ORIGIN + '/?human=none&seed=1');
  await page.waitForFunction(() => window.__cs2replay !== undefined);
  await page.click('button[data-speed="4"]');
  await page.click('#start');
  // stats().tick is the newest observe's tick: k + 1 once tick k has been stepped.
  await waitTick(page, PARITY_TICK + 1, 60_000);
  await page.click('#pause');
  // No named functions inside evaluate(): tsx would wrap them in a helper the page doesn't have.
  const b = await page.evaluate((through) => {
    const log = window.__cs2replay?.session().log();
    if (log === undefined) throw new Error('no session log');
    const lines = log.lines();
    const head = lines.slice(0, through + 1);
    const bytes = new TextEncoder().encode(head.join('\n') + '\n');
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ (bytes[i] as number), 0x01000193);
    // The controls the page logged (its speed button sends `speed`), for the Node run to send too.
    const controls: { tick: number; control: unknown }[] = [];
    for (const l of lines) {
      const e = JSON.parse(l) as { observe: { tick: number }; controls: unknown[] };
      for (const c of e.controls) controls.push({ tick: e.observe.tick, control: c });
    }
    return {
      controls,
      lines: lines.length,
      lastTick: (JSON.parse(lines[lines.length - 1] as string) as { observe: { tick: number } }).observe.tick,
      headLast: (JSON.parse(head[head.length - 1] as string) as { observe: { tick: number } }).observe.tick,
      head: (h >>> 0).toString(16).padStart(8, '0'),
      all: log.digest(),
    };
  }, PARITY_TICK);
  await page.close();
  // Tick 0's `start` is the Session's own; the rest (the page's `speed`) the harness sends as the page did.
  const sent = b.controls.filter((c) => !(c.tick === 0 && stableStringify(c.control) === '{"type":"start"}')) as { tick: number; control: Control }[];
  const node = runHarness(loadHarnessData(), { ...NO_HUMAN, lastTick: b.lastTick, controls: sent });
  const nodeHead = fnv1a32Hex(node.log.lines().slice(0, PARITY_TICK + 1).join('\n') + '\n');
  const nodeAll = node.log.digest();
  console.log(
    `golden parity (no human; controls ${stableStringify(b.controls)}): Chrome through tick ${b.headLast} ${b.head}, Node harness ${nodeHead}; ` +
      `whole page log (${b.lines} lines, to tick ${b.lastTick}) ${b.all}, Node ${nodeAll} (${node.ticks} lines)`,
  );
  if (b.headLast !== PARITY_TICK) problems.push(`golden parity: the page's log through ${PARITY_TICK} ends on tick ${b.headLast}`);
  if (b.head !== nodeHead) problems.push(`golden parity: Chrome ${b.head} != Node ${nodeHead} through tick ${PARITY_TICK}`);
  if (b.all !== nodeAll || b.lines !== node.ticks) problems.push(`golden parity: whole log Chrome ${b.all} (${b.lines}) != Node ${nodeAll} (${node.ticks})`);
}

interface B5State {
  tick: number;
  seeking: boolean;
  summaryOpen: boolean;
  checkpoints: number;
  phase: string;
  logLines: number;
  headline: string;
}

async function b5(page: Page): Promise<B5State> {
  return page.evaluate(() => {
    const h = window.__cs2replay;
    if (h === undefined) throw new Error('no hook');
    const st = h.stats();
    return {
      tick: st.tick,
      seeking: st.seeking,
      summaryOpen: st.summaryOpen,
      checkpoints: st.checkpoints,
      phase: st.phase,
      logLines: h.session().log().length,
      headline: document.getElementById('sum-head')?.textContent ?? '',
    };
  });
}

async function landed(page: Page, ms = 30_000): Promise<B5State> {
  await page.waitForFunction(() => window.__cs2replay?.stats().seeking === false, null, { timeout: ms, polling: 'raf' });
  return b5(page);
}

/** Drag the timeline thumb to video second `t` (mouse). */
async function dragTimeline(page: Page, t: number): Promise<void> {
  const box = await page.locator('#scrub .scrub-track').boundingBox();
  if (box === null) throw new Error('no timeline');
  const span = Number(await page.getAttribute('#scrub', 'aria-valuemax'));
  const x = box.x + (box.width * t) / span;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.1, y);
  await page.mouse.down();
  await page.mouse.move((box.x + x) / 2, y, { steps: 4 });
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
}

/** Step 9 (B5). */
async function rewindAndSummary(browser: Awaited<ReturnType<typeof chromium.launch>>, problems: string[]): Promise<void> {
  // Desktop, cart played by nobody (he stands where the setup put him): history changes.
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  watch(page, problems);
  await page.goto(ORIGIN + '/?seed=1');
  await page.waitForFunction(() => window.__cs2replay !== undefined);
  await page.click('button[data-speed="4"]');
  await page.click('#start');
  await waitTick(page, 24 * 64);
  const before = await b5(page);
  await page.keyboard.press('BracketLeft');
  const afterKey = await landed(page);
  console.log(`[ key: tick ${before.tick} -> ${afterKey.tick} (${afterKey.phase}), log ${afterKey.logLines} lines, ${afterKey.checkpoints} checkpoints`);
  if (Math.abs(before.tick - 320 - afterKey.tick) > 40) problems.push(`[ did not seek 5 s back: ${before.tick} -> ${afterKey.tick}`);
  if (afterKey.phase !== 'running') problems.push(`after [ the round is ${afterKey.phase}, not running`);
  await page.click('#pause');
  const p0 = await b5(page);
  await page.click('#back10');
  const afterBtn = await landed(page);
  console.log(`-10 s button: tick ${p0.tick} -> ${afterBtn.tick} (${afterBtn.phase})`);
  if (Math.abs(p0.tick - 640 - afterBtn.tick) > 2) problems.push(`-10 s did not seek 10 s back: ${p0.tick} -> ${afterBtn.tick}`);
  if (afterBtn.phase !== 'paused') problems.push(`after -10 s while paused the round is ${afterBtn.phase}`);
  await dragTimeline(page, 60);
  const t0 = Date.now();
  const afterDrag = await landed(page, 60_000);
  console.log(`timeline drag to 60 s: tick ${afterDrag.tick} in ${Date.now() - t0} ms (seek ahead, chunked per frame), log ${afterDrag.logLines} lines, ${afterDrag.checkpoints} checkpoints`);
  if (Math.abs(afterDrag.tick - 3840) > 8) problems.push(`timeline drag landed on tick ${afterDrag.tick}, not ~3840`);
  await shoot(page, 'e0-desktop-timeline');
  // The rewound log is one straight run: it replays against a fresh Core.
  const text = await page.evaluate(() => window.__cs2replay?.session().log().toText() ?? '');
  const log = SessionLog.fromText(text);
  const data = parseSessionData(read('../data/round.json'), read('../data/mirage-nav.json'), read('../data/tuning.json'), read('../data/mirage-vismask.json'), readWorld3d());
  const ref = new Session({ ...data, seed: 1 });
  const rp = replay(log, defaultCore({ model: ref.model, schedule: ref.schedule, tuning: data.tuning, seed: 1, nav: data.nav, geometry: data.geometry ?? null }));
  const straight = log.lines().every((l, i) => (JSON.parse(l) as { observe: { tick: number } }).observe.tick === i);
  console.log(`page log after the rewinds: ${log.length} lines, straight ${straight}, replays in Node ${rp.identical}`);
  if (!straight || !rp.identical) problems.push(`rewound page log: straight ${straight}, replays ${rp.identical} (first mismatch ${rp.firstMismatchTick})`);
  // To the round end and the summary.
  await page.click('#pause');
  await page.waitForFunction(() => window.__cs2replay?.stats().summaryOpen === true, null, { timeout: 60_000 });
  const shown = await b5(page);
  const timing = await page.evaluate(() => {
    const t = performance.now();
    const s = window.__cs2replay?.summary();
    return { ms: performance.now() - t, verdict: s?.verdict, kills: s?.kills.length };
  });
  console.log(`summary overlay at tick ${shown.tick}: "${shown.headline}" (summarize() in the page: ${timing.ms.toFixed(0)} ms, ${timing.kills} kill rows)`);
  await page.waitForTimeout(400);
  await summaryClearOfLabels(page, 'desktop summary', problems);
  await shoot(page, 'e-desktop-summary');
  const later = await b5(page);
  if (later.tick <= shown.tick) problems.push('the round stopped under the summary overlay');
  await page.click('#sum-keep');
  if ((await b5(page)).summaryOpen) problems.push('Keep watching did not close the summary');
  await page.click('#summary-open');
  if (!(await b5(page)).summaryOpen) problems.push('the Summary button did not reopen it');
  const r0 = await b5(page);
  await page.click('#sum-rewind');
  const r1 = await landed(page);
  console.log(`summary Rewind 10 s: tick ${r0.tick} -> ${r1.tick}, overlay ${r1.summaryOpen ? 'open' : 'closed'}`);
  if (r1.summaryOpen || Math.abs(r0.tick - 640 - r1.tick) > 40) problems.push(`summary Rewind 10 s: ${r0.tick} -> ${r1.tick}, open ${r1.summaryOpen}`);
  await page.close();

  // Desktop, spectating: the tape.
  const spec = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  watch(spec, problems);
  await spec.goto(ORIGIN + '/?human=none&seed=1');
  await spec.waitForFunction(() => window.__cs2replay !== undefined);
  await spec.click('button[data-speed="2"]');
  await spec.click('#start');
  await spec.evaluate(() => window.__cs2replay?.seek(66));
  await spec.waitForFunction(() => window.__cs2replay?.stats().summaryOpen === true, null, { timeout: 60_000 });
  const tape = await b5(spec);
  console.log(`spectating: "${tape.headline}" at tick ${tape.tick}`);
  if (tape.headline !== 'Played it like the tape: CT defuse, 0.72 s left') problems.push(`spectate summary headline: ${tape.headline}`);
  await spec.waitForTimeout(300);
  await shoot(spec, 'e2-desktop-summary-spectate');
  await spec.close();

  // Phone (touch, spectate): the bottom sheet.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  watch(phone, problems);
  await phone.goto(ORIGIN + '/');
  await phone.waitForFunction(() => window.__cs2replay !== undefined);
  await phone.tap('button[data-speed="2"]');
  await phone.tap('#start');
  await waitTick(phone, 5 * 64);
  const ph0 = await b5(phone);
  await phone.tap('#back5');
  const ph1 = await landed(phone);
  console.log(`phone -5 s: tick ${ph0.tick} -> ${ph1.tick}`);
  if (ph1.tick >= ph0.tick) problems.push(`phone -5 s did not rewind: ${ph0.tick} -> ${ph1.tick}`);
  await phone.evaluate(() => window.__cs2replay?.seek(66));
  await phone.waitForFunction(() => window.__cs2replay?.stats().summaryOpen === true, null, { timeout: 60_000 });
  await phone.waitForTimeout(300);
  console.log(`phone summary: "${(await b5(phone)).headline}"`);
  await summaryClearOfLabels(phone, 'phone summary', problems);
  await shoot(phone, 'f-phone-summary');
  await phone.close();
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
    if (ONLY === 'parity') {
      await goldenParity(browser, problems);
      await browser.close();
      return;
    }
    if (ONLY === 'b5') {
      await rewindAndSummary(browser, problems);
      await browser.close();
      return;
    }
    if (ONLY !== '') throw new Error(`--only: expected parity or b5, got ${ONLY}`);

    // 1. Desktop: ready, then running at 1x.
    const desk = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    watch(desk, problems);
    await desk.goto(ORIGIN + '/');
    await desk.waitForFunction(() => window.__cs2replay !== undefined);
    await desk.waitForTimeout(500);
    const ready = await stats(desk);
    console.log(`ready: tick ${ready.tick}, clock ${await clockText(desk)}, human ${ready.human}, phase ${ready.phase}`);
    await shoot(desk, 'a-desktop-ready');
    await desk.click('#start');
    await desk.waitForTimeout(3000);
    const ran = await stats(desk);
    console.log(`after ~3 s at 1x: tick ${ran.tick}, clock ${await clockText(desk)}`);
    await desk.screenshot({ path: join(OUT, 'desktop-running.png') });

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

    // 3. Rate at 4x, every overlay on: tracks (T), ghost (on by default), panel (open on a desktop),
    //    and the follow camera (F, zoomed in, so the radar cache is rebuilt as the camera moves).
    await desk.keyboard.press('t');
    await desk.keyboard.press('f');
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
        `dropped ${b.droppedTicks - a.droppedTicks}, speed ${b.speed}, overlays ${JSON.stringify(b.overlays)}, zoom ${b.camera.zoom.toFixed(2)}, ` +
        `radar cache rebuilds ${b.radarRebuilds - a.radarRebuilds}`,
    );
    if (Math.abs(err) > 1) problems.push(`ticks/s at 4x off by ${err.toFixed(2)} %`);
    if (fps < 55) problems.push(`only ${fps.toFixed(1)} fps at 4x with every overlay on`);
    if (!(b.overlays.tracks && b.overlays.ghost && b.overlays.panel && b.overlays.follow)) problems.push(`overlays not all on: ${JSON.stringify(b.overlays)}`);
    await desk.close();

    // 4. (b) Spectating with the tracks overlay, ~20 s in: the Ts come through Apartments.
    const spec = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    watch(spec, problems);
    await spec.goto(ORIGIN + '/?human=none');
    await spec.waitForFunction(() => window.__cs2replay !== undefined);
    await spec.keyboard.press('t');
    await spec.keyboard.press('f');
    await spec.click('button[data-speed="4"]');
    await spec.click('#start');
    // Rate again at 4x, now with the follow camera moving with cart (the radar cache is rebuilt as it pans).
    await spec.waitForTimeout(700);
    const sa = await stats(spec);
    await spec.waitForTimeout(3500);
    const sb = await stats(spec);
    const ssec = (sb.now - sa.now) / 1000;
    console.log(
      `4x spectating, follow cam on moving cart, every overlay on: ${((sb.frames - sa.frames) / ssec).toFixed(1)} fps, ` +
        `${((sb.ticksRun - sa.ticksRun) / ssec).toFixed(1)} ticks/s over ${ssec.toFixed(2)} s, dropped ${sb.droppedTicks - sa.droppedTicks}, ` +
        `radar cache rebuilds ${sb.radarRebuilds - sa.radarRebuilds}`,
    );
    if ((sb.frames - sa.frames) / ssec < 55) problems.push(`only ${((sb.frames - sa.frames) / ssec).toFixed(1)} fps at 4x with the follow camera moving`);
    await waitTick(spec, 20 * 64);
    await spec.click('#pause');
    // Back to the whole map for the screenshot: follow off, double-click resets the view.
    await spec.keyboard.press('f');
    await spec.dblclick('#view', { position: { x: 640, y: 400 } });
    await spec.waitForTimeout(100);
    const sp = await stats(spec);
    console.log(`spectate: paused at tick ${sp.tick} (${(sp.tick / 64).toFixed(1)} s), clock ${await clockText(spec)}, tracks ${sp.overlays.tracks}`);
    await shoot(spec, 'b-desktop-spectate-tracks');
    // The wheel zooms about the cursor: the world point under it stays put.
    const anchor = { x: -1200, y: 700 };
    const before = await spec.evaluate(([x, y]) => window.__cs2replay?.screenOf(x, y), [anchor.x, anchor.y] as const);
    if (before === undefined) throw new Error('no screenOf');
    await spec.mouse.move(before.x, before.y);
    for (let i = 0; i < 6; i++) await spec.mouse.wheel(0, -100);
    await spec.waitForTimeout(200);
    const after = await spec.evaluate(([x, y]) => window.__cs2replay?.screenOf(x, y), [anchor.x, anchor.y] as const);
    const zoomed = await stats(spec);
    const drift = after === undefined ? Infinity : Math.hypot(after.x - before.x, after.y - before.y);
    console.log(`wheel: 6 notches in about (${anchor.x}, ${anchor.y}): zoom ${zoomed.camera.zoom.toFixed(2)}, point moved ${drift.toFixed(2)} px`);
    if (drift > 2) problems.push(`wheel zoom moved the point under the cursor by ${drift.toFixed(2)} px`);
    await shoot(spec, 'b2-desktop-spectate-zoomed');
    await spec.close();

    // 5. (c) Follow camera zoomed in on cart: a smoke, a burst, aiming through the zoomed view.
    const play = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    watch(play, problems);
    await play.goto(ORIGIN + '/');
    await play.waitForFunction(() => window.__cs2replay !== undefined);
    await play.click('#start');
    await play.keyboard.press('f');
    await play.mouse.move(640, 430);
    for (let i = 0; i < 2; i++) await play.mouse.wheel(0, -100);
    await play.waitForTimeout(600);
    const p0 = await cart(play);
    // Smoke toward the south-west, then the rifle.
    const smokeAim = await play.evaluate(([x, y]) => window.__cs2replay?.screenOf(x, y), [p0.x - 300, p0.y - 250] as const);
    if (smokeAim === undefined) throw new Error('no screenOf');
    await play.mouse.move(smokeAim.x, smokeAim.y);
    await play.keyboard.press('4');
    await play.waitForTimeout(1100);
    await play.mouse.down();
    await play.waitForTimeout(100);
    await play.mouse.up();
    // Let the release throw before switching (set_weapon cancels a primed grenade).
    await play.waitForTimeout(300);
    await play.keyboard.press('1');
    // Step south off the wall cart starts against, into the corridor.
    await play.keyboard.down('s');
    await play.waitForTimeout(700);
    await play.keyboard.up('s');
    await play.waitForTimeout(1300);
    // Aim through the zoomed, following view along the longest clear line (2D nav line of sight, which
    // is also where bullets stop): cart must turn to face it.
    const p1 = await cart(play);
    const yaw = await play.evaluate(([x, y]) => {
      const nav = window.__cs2replay?.session().nav;
      let best = { deg: 0, d: 0 };
      for (let deg = -180; deg < 180; deg += 15) {
        const r = (deg * Math.PI) / 180;
        for (let d = 50; d <= 800; d += 50) {
          if (nav?.lineOfSight({ x, y }, { x: x + Math.cos(r) * d, y: y + Math.sin(r) * d }) !== true) break;
          if (d > best.d) best = { deg, d };
        }
      }
      return best.deg;
    }, [p1.x, p1.y] as const);
    const target = { x: p1.x + Math.cos((yaw * Math.PI) / 180) * 400, y: p1.y + Math.sin((yaw * Math.PI) / 180) * 400 };
    const aimAt = await play.evaluate(([x, y]) => window.__cs2replay?.screenOf(x, y), [target.x, target.y] as const);
    if (aimAt === undefined) throw new Error('no screenOf');
    await play.mouse.move(aimAt.x, aimAt.y);
    await play.waitForTimeout(150);
    const p2 = await cart(play);
    const wantYaw = (Math.atan2(target.y - p2.y, target.x - p2.x) * 180) / Math.PI;
    const camNow = (await stats(play)).camera;
    console.log(`aim at zoom ${camNow.zoom.toFixed(2)} (following): cart yaw ${p2.yaw.toFixed(2)}, expected ${wantYaw.toFixed(2)}`);
    if (Math.abs(p2.yaw - wantYaw) > 2) problems.push(`aiming at zoom ${camNow.zoom.toFixed(2)}: cart yaw ${p2.yaw} != ${wantYaw.toFixed(2)}`);
    // Fire a burst and pause on the frame right after a shot, so its tracer is in the screenshot.
    await play.mouse.down();
    await play.waitForTimeout(200);
    await play.waitForFunction(
      () => {
        const sc = window.__cs2replay?.scene();
        if (sc === undefined || !sc.tracers.some((t) => sc.cur.tick - 1 - t.tick <= 1)) return false;
        document.getElementById('pause')?.click();
        return true;
      },
      null,
      { polling: 'raf', timeout: 5000 },
    );
    await play.mouse.up();
    const fx = await play.evaluate(() => {
      const sc = window.__cs2replay?.scene();
      return sc === undefined ? null : { effects: sc.effects.map((e) => `${e.kind}/${e.phase}`), tracers: sc.tracers.length };
    });
    console.log(`follow cam: effects ${JSON.stringify(fx?.effects)}, tracers on screen ${fx?.tracers}`);
    if (fx === null || !fx.effects.includes('smoke/smoke')) problems.push(`no smoke cloud after the throw: ${JSON.stringify(fx)}`);
    if (fx === null || fx.tracers === 0) problems.push('no tracers after the burst');
    await shoot(play, 'c-desktop-follow-zoomed');
    await play.close();

    // 6. (d) Phone-sized, touch: spectate by default.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    watch(phone, problems);
    await phone.goto(ORIGIN + '/');
    await phone.waitForFunction(() => window.__cs2replay !== undefined);
    await phone.tap('#start');
    await phone.waitForTimeout(3000);
    const ph = await stats(phone);
    console.log(`phone: human ${ph.human}, tick ${ph.tick}, clock ${await clockText(phone)}, panel ${ph.overlays.panel ? 'open' : 'closed'}`);
    if (ph.human !== null) problems.push('phone did not start in spectate mode');
    await shoot(phone, 'd-phone-spectate');
    await phone.click('#pause');
    const browserLog = await phone.evaluate(() => {
      const log = window.__cs2replay?.session().log();
      return log === undefined ? null : { lines: log.length, digest: log.digest() };
    });
    // (d2) Zoomed in about the Ts coming out of T spawn and dragged up under the scoreboard and the kill feed.
    const tsAt = async (): Promise<{ x: number; y: number }> => {
      const p = await phone.evaluate(() => {
        const o = window.__cs2replay?.session().observe();
        const ts = (o?.pawns ?? []).filter((q) => q.team === 'T' && q.alive);
        const x = ts.reduce((a, q) => a + q.pos.x, 0) / Math.max(1, ts.length);
        const y = ts.reduce((a, q) => a + q.pos.y, 0) / Math.max(1, ts.length);
        return window.__cs2replay?.screenOf(x, y);
      });
      if (p === undefined) throw new Error('no screenOf');
      return p;
    };
    const top = await tsAt();
    await phone.mouse.move(top.x, top.y);
    for (let i = 0; i < 12; i++) await phone.mouse.wheel(0, -100);
    await phone.waitForTimeout(100);
    // Then drag the map up so the Ts sit just under the scoreboard (y ≈ 95).
    const zoomedTs = await tsAt();
    const grab = { x: zoomedTs.x, y: zoomedTs.y + 120 };
    await phone.mouse.move(grab.x, grab.y);
    await phone.mouse.down();
    await phone.mouse.move(grab.x, grab.y - (zoomedTs.y - 95) / 2, { steps: 4 });
    await phone.mouse.move(grab.x, grab.y - (zoomedTs.y - 95), { steps: 4 });
    await phone.mouse.up();
    await phone.waitForTimeout(300);
    const draggedTs = await tsAt();
    console.log(`phone: the Ts at (${top.x.toFixed(0)}, ${top.y.toFixed(0)}), after zooming (${zoomedTs.x.toFixed(0)}, ${zoomedTs.y.toFixed(0)}), after the drag (${draggedTs.x.toFixed(0)}, ${draggedTs.y.toFixed(0)})`);
    const phoneZoom = await stats(phone);
    console.log(`phone zoomed: zoom ${phoneZoom.camera.zoom.toFixed(2)} about the Ts (${top.x.toFixed(0)}, ${top.y.toFixed(0)})`);
    if (phoneZoom.camera.zoom < 2) problems.push(`phone: the wheel did not zoom (${phoneZoom.camera.zoom})`);
    await labelsClearOfHud(phone, 'phone zoomed', problems);
    await shoot(phone, 'd2-phone-zoomed-labels');
    await phone.close();

    // 6b. (g) A narrower desktop window: the kill feed moves below the scoreboard instead of covering it.
    const narrow = await browser.newPage({ viewport: { width: 900, height: 700 } });
    watch(narrow, problems);
    await narrow.goto(ORIGIN + '/?human=none');
    await narrow.waitForFunction(() => window.__cs2replay !== undefined);
    await narrow.click('button[data-speed="4"]');
    await narrow.click('#start');
    await waitTick(narrow, Math.round(12.8 * 64));
    await narrow.click('#pause');
    await narrow.waitForTimeout(200);
    // No named functions inside evaluate() (tsx's __name helper isn't in the page).
    const boxes = await narrow.evaluate(() => {
      const [feed, board] = ['killfeed', 'scoreboard'].map((id) => {
        const b = document.getElementById(id)?.getBoundingClientRect();
        return b === undefined ? null : { x: b.left, y: b.top, w: b.width, h: b.height };
      });
      return { feed: feed ?? null, board: board ?? null, rows: document.querySelectorAll('#killfeed li').length };
    });
    const meets = (a: Box | null, b: Box | null): boolean =>
      a !== null && b !== null && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    console.log(`narrow desktop 900×700: kill feed ${boxes.rows} rows at y ${boxes.feed?.y.toFixed(0)}–${((boxes.feed?.y ?? 0) + (boxes.feed?.h ?? 0)).toFixed(0)}, scoreboard to y ${((boxes.board?.y ?? 0) + (boxes.board?.h ?? 0)).toFixed(0)}, overlap ${meets(boxes.feed, boxes.board)}`);
    if (boxes.rows < 2) problems.push(`narrow desktop: expected kills in the feed at 12.8 s, got ${boxes.rows}`);
    if (meets(boxes.feed, boxes.board)) problems.push('narrow desktop: the kill feed covers the scoreboard');
    await labelsClearOfHud(narrow, 'narrow desktop', problems);
    await shoot(narrow, 'g-desktop-narrow-killfeed');
    await narrow.close();

    // (h) LIVE pawns' AI state in the status panel and their paths (tracks on): cart stays in Back Alley, so Lokier
    //     outlives his recording at 21.8 s and goes LIVE, and the Ts who see him follow.
    const live = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    watch(live, problems);
    await live.goto(ORIGIN + '/');
    await live.waitForFunction(() => window.__cs2replay !== undefined);
    await live.keyboard.press('t');
    await live.click('button[data-speed="4"]');
    await live.click('#start');
    await live.waitForFunction(
      () => {
        const s = window.__cs2replay?.session();
        return s !== undefined && s.observe().pawns.filter((p) => s.host.aiDebug(p.id) !== null).length >= 2;
      },
      null,
      { timeout: 60_000 },
    );
    await live.click('#pause');
    await live.waitForTimeout(200);
    const panel = await live.evaluate(() => {
      const s = window.__cs2replay?.session();
      const n = s === undefined ? 0 : s.observe().pawns.filter((p) => p.alive && s.host.aiDebug(p.id) !== null).length;
      return { live: n, rows: [...document.querySelectorAll('#pawn-rows tr.ai td')].map((td) => td.textContent ?? '') };
    });
    console.log(`LIVE AI in the panel at ${await clockText(live)} (${panel.live} LIVE): ${panel.rows.map((t) => JSON.stringify(t)).join(', ')}`);
    if (panel.live < 1 || panel.rows.length !== panel.live) problems.push(`status panel: ${panel.rows.length} AI lines for ${panel.live} LIVE pawns`);
    await labelsClearOfHud(live, 'desktop with the panel open', problems);
    await shoot(live, 'h-desktop-live-aidebug');
    await live.close();

    // 7. Determinism, Node vs. Chrome.
    const data = parseSessionData(read('../data/round.json'), read('../data/mirage-nav.json'), read('../data/tuning.json'), read('../data/mirage-vismask.json'), readWorld3d());
    const node = new Session({ ...data, seed: 1, human: null });
    for (let i = 0; i < (browserLog?.lines ?? 0); i++) node.step();
    console.log(`spectate log: Chrome ${browserLog?.lines} lines ${browserLog?.digest}, Node ${node.log().length} lines ${node.log().digest()}`);
    if (browserLog === null || browserLog.digest !== node.log().digest()) problems.push('spectate log differs between Chrome and Node');
    const human = SessionLog.fromText(readFileSync(logPath, 'utf8'));
    // The app's Core: puppets steer with the nav mesh's walkable-line query (B2).
    const result = replay(human, defaultCore({ model: node.model, schedule: node.schedule, tuning: data.tuning, seed: 1, nav: data.nav, geometry: data.geometry ?? null }));
    console.log(`desktop log (human cart, ${human.length} lines) replayed in Node: identical ${result.identical}`);
    if (!result.identical) problems.push(`desktop log does not replay: first mismatch at tick ${result.firstMismatchTick}`);

    // 8. Golden parity: the no-human round in Chrome against the Node harness.
    await goldenParity(browser, problems);

    // 9. B5: rewind, seek and the summary overlay.
    await rewindAndSummary(browser, problems);

    await browser.close();
  } finally {
    server.kill();
    if (ONLY === '') console.log(`screenshots in ${OUT}`);
    if (problems.length > 0) {
      for (const p of problems) console.error(`PROBLEM ${p}`);
      process.exitCode = 1;
    }
  }
}

await main();
