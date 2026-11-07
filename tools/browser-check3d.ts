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
 *     the shot was fired (the HUD's ammo drops, a tracer); screenshot (f) first person; then (H2b) sprays ~0.8 s: the
 *     camera kicks up and the crosshair rises to where the bullets go (screenshot (g)), and both recover after release;
 *     with the "Recoil tracking" setting at 0 the camera stays still while the crosshair climbs, at 1 the camera takes
 *     all the recoil and the crosshair stays centred;
 *  4. U1, spectating: at the start the T radar shows no CT (nobody spotted), "show everyone" shows all ten; first
 *     person through Sp4rtaN's eyes shows his HP / armor / ammo / weapon, the crosshair, the spectator panel
 *     ("SPECTATING sp4rtan", 1st person) and "Watching"; mouse 1 / Space / mouse 2 switch player, V cycles 1st → 3rd
 *     (no crosshair) → free → 1st; then the round plays at 4× until an enemy spotted earlier shows as the "?" ghost;
 *     screenshots app3d-spectate-*.jpg;
 *  5. A1 (tools/browser-check3d-a1.ts): audio starts on a click, firing schedules a sound, the AK reload animation
 *     runs for its reload time; viewmodel screenshots (docs/img/app3d-viewmodel-*.jpg);
 *  6. fails on page errors, console errors or requests to other origins.
 * Port: `--port <n>` or CHECK3D_PORT (default 4180).
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
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : (process.env['CHECK3D_PORT'] ?? '4180'));
const ORIGIN = `http://127.0.0.1:${PORT}`;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

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
  followed: string;
  look: { yaw: number; pitch: number };
  humanShots: number;
  humanHits: number;
  triangles: number;
  hud: { hp: string; clock: string; mode: string; killfeed: number };
  guard: { leaveGuard: boolean; keyboardLocked: boolean; fullscreen: boolean; duckKey: string };
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

type Mark = { id: string; team: string; kind: string; alpha: number };

/** U1: the radar's CS2 rules, first-person spectating (HUD, crosshair, panel) and the spectator controls. */
async function spectateChecks(browser: Browser, problems: string[], shots: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const p = await open(browser, 1280, 720, problems);
  const radar = (): Promise<{ team: string | null; marks: Mark[] }> => p.evaluate(() => window.__cs2sim3d?.radar() as unknown as { team: string | null; marks: Mark[] });
  const text = (id: string): Promise<string> => p.evaluate((id) => document.getElementById(id)?.textContent ?? '', id);
  const hidden = (id: string): Promise<boolean> => p.evaluate((id) => document.getElementById(id)?.hidden ?? true, id);
  // (1) The start: cart's (T) radar has the five Ts and exactly the CTs a T sees now (the reset evaluates the spotting
  // at once); the others are hidden. The toggle shows all ten.
  const r0 = await radar();
  const seenByT = await p.evaluate(() => {
    const o = window.__cs2sim3d?.session().observe();
    const ids = new Set<string>();
    for (const q of o?.pawns ?? []) if (q.team === 'T' && q.alive) for (const x of q.sees) ids.add(x);
    return (o?.pawns ?? []).filter((q) => q.team === 'CT' && q.alive && ids.has(q.id)).map((q) => q.id).sort();
  });
  const ctShown = r0.marks.filter((m) => m.team === 'CT').map((m) => m.id).sort();
  out['startRadar'] = { team: r0.team, ids: r0.marks.map((m) => m.id), ctSeenByT: seenByT };
  if (r0.team !== 'T' || r0.marks.filter((m) => m.team === 'T').length !== 5 || JSON.stringify(ctShown) !== JSON.stringify(seenByT) || ctShown.length >= 5) problems.push(`spectate: start radar (CS2 rules) ${JSON.stringify(out['startRadar'])}`);
  await p.click('#radar-rules');
  await p.waitForTimeout(150);
  const rAll = await radar();
  const label = await text('radar-rules');
  if (rAll.marks.length !== 10 || label !== 'Radar: show everyone') problems.push(`spectate: radar toggle ${JSON.stringify({ n: rAll.marks.length, label })}`);
  const stored = await p.evaluate(() => localStorage.getItem('cs2-sim3d-settings') ?? '');
  if (!stored.includes('"radar":"all"')) problems.push(`spectate: radar setting not stored: ${stored}`);
  await p.click('#radar-rules');
  // (2) First person through Sp4rtaN's eyes: his HUD, the crosshair, the panel.
  await seek(p, 49.95);
  await p.evaluate(() => window.__cs2sim3d?.camera('pov', 'sp4rtan'));
  await p.waitForTimeout(400);
  const want = await p.evaluate(() => {
    const s = window.__cs2sim3d?.session().observe().pawns.find((q) => q.id === 'sp4rtan');
    return s === undefined ? null : { hp: String(Math.round(s.hp)), armor: String(Math.round(s.armor)), clip: String(s.ammo.clip), weapon: s.weapon };
  });
  const got = { hp: await text('hp'), armor: await text('armor'), clip: await text('clip'), weapon: await text('weapon'), crosshair: !(await hidden('crosshair')), panel: await text('spec'), panelHidden: await hidden('spec'), vignette: !(await hidden('vignette')), mode: await text('mode') };
  out['firstPerson'] = { want, got };
  if (want === null || got.hp !== want.hp || got.armor !== want.armor || got.clip !== want.clip || !got.weapon.startsWith('sp4rtan')) problems.push(`spectate: first-person HUD ${JSON.stringify(out['firstPerson'])}`);
  if (!got.crosshair || got.panelHidden || !got.vignette || !got.panel.startsWith('SPECTATINGsp4rtan1st person') || !got.mode.startsWith('Watching')) problems.push(`spectate: first-person panel / crosshair ${JSON.stringify(got)}`);
  shots.push(await shot(p, 'spectate-first-person'));
  // (3) Controls: mouse 1 next, mouse 2 previous, Space next; V 1st → 3rd → free → 1st.
  const followed = async (): Promise<string> => (await stats(p)).followed;
  const box = await p.locator('#view').boundingBox();
  const order: string[] = [await followed()];
  if (box !== null) {
    await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'left' });
    await p.waitForTimeout(100);
    order.push(await followed());
    await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await p.waitForTimeout(100);
    order.push(await followed());
  }
  await p.keyboard.press('Space');
  await p.waitForTimeout(100);
  order.push(await followed());
  out['switch'] = order;
  if (order.length !== 4 || order[1] === order[0] || order[2] !== order[0] || order[3] !== order[1]) problems.push(`spectate: mouse 1 / mouse 2 / Space ${JSON.stringify(order)}`);
  const modes: { camera: string; crosshair: boolean; mode: string }[] = [];
  for (let i = 0; i < 3; i++) {
    await p.keyboard.press('KeyV');
    await p.waitForTimeout(150);
    modes.push({ camera: (await stats(p)).camera, crosshair: !(await hidden('crosshair')), mode: await text('spec-mode') });
    if (i === 0) shots.push(await shot(p, 'spectate-third-person'));
  }
  out['modes'] = modes;
  const m = modes.map((x) => `${x.camera}:${x.crosshair ? 'x' : '-'}:${x.mode}`).join(' ');
  if (m !== 'follow:-:3rd person free:-:free camera pov:x:1st person') problems.push(`spectate: V cycle ${m}`);
  // (4) The "?": play from 15 s at 4× following cart until an enemy (CT) spotted before shows as the ghost.
  // The clicks on the view may have locked the pointer (then every click goes to the canvas): let go.
  await p.evaluate(() => document.exitPointerLock());
  await p.evaluate(() => window.__cs2sim3d?.camera('pov', 'cart'));
  await seek(p, 15);
  await p.evaluate(() => {
    const b = document.getElementById('pause');
    if (b instanceof HTMLButtonElement && b.textContent === 'Resume') b.click();
  });
  await p.click('button[data-speed="4"]');
  let ghost: Mark | null = null;
  let spotted = false;
  for (let i = 0; i < 300 && ghost === null; i++) {
    await p.waitForTimeout(100);
    const r = await radar();
    const enemy = r.marks.filter((x) => x.team !== r.team);
    if (enemy.some((x) => x.kind === 'dot')) spotted = true;
    ghost = enemy.find((x) => x.kind === 'ghost') ?? null;
  }
  if (ghost !== null) {
    await p.evaluate(() => window.__cs2sim3d?.test.freeze(true));
    await p.waitForTimeout(250);
    shots.push(await shot(p, 'spectate-radar-ghost'));
  }
  out['ghost'] = { spotted, ghost, tick: (await stats(p)).tick };
  if (!spotted || ghost === null) problems.push(`spectate: no spotted enemy / "?" ghost on cart's radar ${JSON.stringify(out['ghost'])}`);
  await p.close();
  return out;
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
    // Ctrl+W (crouch forward) while playing: the page blocks it, the leave-site guard is on.
    const ctrlW = await p.evaluate(() => {
      // No named functions in here (tsx's __name helper isn't in the page).
      const specs: [string, string, boolean][] = [
        ['keydown', 'ControlLeft', true],
        ['keydown', 'KeyW', true],
        ['keydown', 'KeyT', true],
        ['keyup', 'KeyW', true],
        ['keyup', 'KeyT', true],
        ['keyup', 'ControlLeft', false],
      ];
      const evs = specs.map((x) => new KeyboardEvent(x[0], { code: x[1], ctrlKey: x[2], bubbles: true, cancelable: true }));
      for (const e of evs) document.body.dispatchEvent(e);
      return { prevented: evs.slice(0, 3).map((e) => e.defaultPrevented) };
    });
    const g0 = (await stats(p)).guard;
    report['ctrlW'] = { ...ctrlW, guard: g0 };
    if (!ctrlW.prevented.every((x) => x) || !g0.leaveGuard || g0.duckKey !== 'Control') problems.push(`Ctrl+W guard: ${JSON.stringify(report['ctrlW'])}`);
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
    // 3b. H2b: recoil on the camera and the crosshair. Spray ~0.8 s at the floor in front of cart (the bullets kick
    // the camera up by 45 % of the punch and move the crosshair to where they go), then release: both recover.
    const camPitch = async (): Promise<number> => (await p.evaluate(() => window.__cs2sim3d?.test.state().camera.pitch ?? null)) ?? 0;
    const crossXf = async (): Promise<string> => p.evaluate(() => document.getElementById('crosshair')?.style.transform ?? '');
    await p.waitForTimeout(1500);
    const pitch0 = await camPitch();
    const look0 = (await stats(p)).look.pitch;
    if (box !== null) {
      await p.mouse.down();
      await p.waitForTimeout(800);
    }
    const pitchSpray = await camPitch();
    const xfSpray = await crossXf();
    shots.push(await shot(p, 'g-spray-kick'));
    if (box !== null) await p.mouse.up();
    await p.waitForTimeout(1500);
    const pitchAfter = await camPitch();
    const xfAfter = await crossXf();
    const lookAfter = (await stats(p)).look.pitch;
    const crossY = (xf: string): number => Number(/translate\([^,]+,\s*(-?[\d.]+)px\)/.exec(xf)?.[1] ?? 0);
    report['recoil'] = { cameraPitch: { before: pitch0, spraying: pitchSpray, after: pitchAfter }, look: [look0, lookAfter], crosshair: { spraying: xfSpray, after: xfAfter } };
    // Source pitch: − = up. The camera kicks up at least 1.5° (45 % of ≥ 3.5° of punch after ~8 bullets) and the
    // crosshair rises above the centre; 1.5 s later both are back (within 0.2° and 2 px).
    if (!(pitchSpray < pitch0 - 1.5)) problems.push(`recoil: camera did not kick (${JSON.stringify(report['recoil'])})`);
    if (!(crossY(xfSpray) < -5)) problems.push(`recoil: crosshair did not rise (${JSON.stringify(report['recoil'])})`);
    if (!(Math.abs(pitchAfter - lookAfter) < 0.2 && Math.abs(crossY(xfAfter)) < 2)) problems.push(`recoil: did not recover (${JSON.stringify(report['recoil'])})`);
    // 3c. H2b: the "Recoil tracking" setting (view_recoil_tracking) sets the camera's share of the recoil: spray for
    // 0.5 s at 0 (camera still but for the screen shake, < 0.6°; the crosshair takes it all) and at 1 (the camera takes
    // it all; the crosshair stays within a few px of the centre: the screen shake, which the bullets don't follow).
    const tracking: Record<string, { camera: number; crosshairY: number }> = {};
    for (const k of ['0', '1']) {
      await p.evaluate((v) => {
        const f = document.getElementById('set-tracking');
        if (f instanceof HTMLInputElement) {
          f.value = v;
          f.dispatchEvent(new Event('change'));
        }
      }, k);
      await p.waitForTimeout(1500);
      const lk = (await stats(p)).look.pitch;
      if (box !== null) await p.mouse.down();
      await p.waitForTimeout(500);
      const cam = await camPitch();
      const xf = await crossXf();
      const lk2 = (await stats(p)).look.pitch;
      if (box !== null) await p.mouse.up();
      tracking[k] = { camera: cam - (lk + lk2) / 2, crosshairY: crossY(xf) };
    }
    const stored = await p.evaluate(() => (JSON.parse(localStorage.getItem('cs2-sim3d-settings') ?? '{}') as { recoilTracking?: number }).recoilTracking ?? null);
    report['recoilTracking'] = { ...tracking, stored };
    if (!(Math.abs(tracking['0']?.camera ?? 9) < 0.6 && (tracking['0']?.crosshairY ?? 0) < -10)) problems.push(`recoil tracking 0: ${JSON.stringify(report['recoilTracking'])}`);
    if (!((tracking['1']?.camera ?? 0) < -2 && Math.abs(tracking['1']?.crosshairY ?? 99) < 8)) problems.push(`recoil tracking 1: ${JSON.stringify(report['recoilTracking'])}`);
    if (stored !== 1) problems.push(`recoil tracking not persisted: ${JSON.stringify(report['recoilTracking'])}`);
    await p.evaluate(() => {
      const f = document.getElementById('set-tracking');
      if (f instanceof HTMLInputElement) {
        f.value = '0.45';
        f.dispatchEvent(new Event('change'));
      }
    });
    await p.close();
    // 4. Spectating (U1).
    report['spectate'] = await spectateChecks(browser, problems, shots);
    report['screenshots'] = shots.map((x) => x.replace(ROOT + '/', ''));
    // 5. A1: sound and the viewmodels.
    await a1Checks(browser, { open: (w, h) => open(browser, w, h, problems), seek, out: OUT, root: ROOT }, problems, report);
  } finally {
    await browser.close();
    server.close();
  }
  report['problems'] = problems;
  mkdirSync(join(ROOT, 'logs'), { recursive: true });
  writeFileSync(join(ROOT, 'logs', 'browser-check3d.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (problems.length > 0) {
    console.error(`browser check 3D: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log('browser check 3D: ok');
}

await main();
