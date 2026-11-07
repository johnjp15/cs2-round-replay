/**
 * A1: the sound and viewmodel part of the 3D browser check (tools/browser-check3d.ts calls `a1Checks`).
 *
 *  1. Before any gesture the AudioContext doesn't exist; a click on the view starts it (state `running`).
 *  2. Taking control of cart and firing schedules a sound: the director's cue `fire.<gun>` and an engine voice.
 *  3. R starts the reload: the viewmodel's phase is `reload` for the reload time the weapon state machine reports
 *     (Sim3DHost's `reloadEndTick`; the AK-47's 2.5 s in data/tuning.json), its progress about half-way at half
 *     time, and idle again after it; the reload sounds (`reload.<gun>.clipout` / `clipin` / `bolt`) were cued.
 *  4. Screenshots `docs/img/app3d-viewmodel-*.jpg`: the AK idle, firing, mid-reload; the M4A1-S, AWP, Desert Eagle,
 *     USP-S, knife, C4 and HE in first person (the mount's preview pose); the world models in third person.
 */
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';

interface A1StatsLite {
  audio: { state: string; started: number; playing: number; lastIds: string[]; realFiles: number; bank: boolean };
  cues: { played: number; recent: { tick: number; id: string }[] };
  viewmodel: { weapon: string; phase: string; progress: number; visible: boolean } | null;
  anim: { weapon: string; reloadSec: number | null; deploySec: number | null } | null;
}

const a1 = (page: Page): Promise<A1StatsLite> => page.evaluate(() => (window.__cs2a1 as NonNullable<typeof window.__cs2a1>).stats() as unknown as A1StatsLite);

export interface A1Context {
  readonly open: (w: number, h: number) => Promise<Page>;
  readonly seek: (page: Page, t: number) => Promise<void>;
  readonly out: string;
  readonly root: string;
}

async function shotTo(page: Page, ctx: A1Context, name: string, shots: string[]): Promise<void> {
  const path = join(ctx.out, `app3d-viewmodel-${name}.jpg`);
  await page.screenshot({ path, type: 'jpeg', quality: 80 });
  shots.push(path.replace(ctx.root + '/', ''));
}

export async function a1Checks(_browser: Browser, ctx: A1Context, problems: string[], report: Record<string, unknown>): Promise<void> {
  const p = await ctx.open(1280, 720);
  const r: Record<string, unknown> = {};
  report['a1'] = r;
  const shots: string[] = [];
  // 1. Audio starts on the first gesture.
  const before = await a1(p);
  r['audioBefore'] = before.audio.state;
  if (before.audio.state !== 'none') problems.push(`a1: audio before any gesture: ${before.audio.state}`);
  await p.click('#view');
  await p.waitForFunction(() => window.__cs2a1?.stats().audio.state === 'running', null, { timeout: 10_000 }).catch(() => undefined);
  // With a CS2 bank in the build, wait for its files to decode.
  await p.waitForFunction(() => {
    const a = window.__cs2a1?.stats().audio;
    return a !== undefined && (!a.bank || a.realFiles > 0);
  }, null, { timeout: 60_000 }).catch(() => undefined);
  const started = await a1(p);
  r['audioAfterClick'] = started.audio.state;
  r['bank'] = { inBuild: started.audio.bank, realFiles: started.audio.realFiles };
  if (started.audio.state !== 'running') problems.push(`a1: audio after a click: ${started.audio.state}`);
  if (started.audio.bank && started.audio.realFiles === 0) problems.push('a1: the build has a CS2 sound bank but no file decoded');
  // 2. Take control of cart and fire: a sound is scheduled.
  await p.click('#start').catch(() => undefined);
  await ctx.seek(p, 18.2);
  await p.evaluate(() => {
    const b = document.getElementById('pause');
    if (b instanceof HTMLButtonElement && b.textContent === 'Resume') b.click();
  });
  await p.keyboard.press('KeyE');
  await p.waitForTimeout(1400);
  const s0 = await a1(p);
  await p.evaluate(() => window.__cs2sim3d?.aimAt('lokier'));
  const box = await p.locator('#view').boundingBox();
  if (box !== null) {
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    await p.waitForTimeout(120);
    await p.mouse.up();
  }
  await p.waitForTimeout(300);
  const s1 = await a1(p);
  const weapon = s1.anim?.weapon ?? 'none';
  const fired = s1.cues.recent.filter((c) => c.id.startsWith('fire.')).map((c) => c.id);
  r['fire'] = { weapon, cues: fired, voicesStarted: [s0.audio.started, s1.audio.started], lastIds: s1.audio.lastIds.slice(-6) };
  if (!fired.includes(`fire.${weapon}`) || s1.audio.started <= s0.audio.started) problems.push(`a1: firing scheduled no sound: ${JSON.stringify(r['fire'])}`);
  // 3. Reload: phase `reload` for the state machine's reload time.
  // Held over a few frames: the page samples the keys once per frame.
  await p.keyboard.down('KeyR');
  await p.waitForTimeout(250);
  await p.keyboard.up('KeyR');
  const rs = await a1(p);
  const reloadSec = rs.anim?.reloadSec ?? null;
  // Timed in game ticks, not wall time: a loaded machine runs the round slower than real time.
  const tickNow = (): Promise<number> => p.evaluate(() => window.__cs2sim3d?.stats().tick ?? 0);
  const samples: { tick: number; phase: string; progress: number }[] = [];
  let firstTick: number | null = null;
  let lastTick: number | null = null;
  let mid = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const s = await a1(p);
    const tick = await tickNow();
    const phase = s.viewmodel?.phase ?? 'none';
    samples.push({ tick, phase, progress: Math.round((s.viewmodel?.progress ?? 0) * 100) / 100 });
    if (phase === 'reload') {
      firstTick ??= tick - Math.round((s.viewmodel?.progress ?? 0) * (reloadSec ?? 0) * 64);
      lastTick = tick;
      if (!mid && (s.viewmodel?.progress ?? 0) > 0.3 && (s.viewmodel?.progress ?? 0) < 0.5) {
        mid = true;
        await shotTo(p, ctx, 'ak47-reload', shots);
      }
    } else if (firstTick !== null) break;
    await p.waitForTimeout(60);
  }
  const endTick = samples.length > 0 ? (samples[samples.length - 1] as { tick: number }).tick : 0;
  const end = await a1(p);
  const reloadCues = end.cues.recent.filter((c) => c.id.startsWith('reload.')).map((c) => c.id);
  // The animation ran from firstTick until somewhere between the last reload sample and the first idle one.
  const ranSec = firstTick === null || lastTick === null ? null : { atLeast: (lastTick - firstTick) / 64, atMost: (endTick - firstTick) / 64 };
  r['reload'] = { weapon: rs.anim?.weapon, reloadSec, ranSec, samples: samples.filter((_, i) => i % 4 === 0).slice(0, 40), cues: reloadCues, after: end.viewmodel?.phase };
  if (weapon === 'ak47' && (reloadSec === null || Math.abs(reloadSec - 2.5) > 1e-6)) problems.push(`a1: AK reload time ${reloadSec} (want 2.5 s, data/tuning.json)`);
  if (reloadSec === null || ranSec === null) problems.push(`a1: no reload animation: ${JSON.stringify(r['reload'])}`);
  else if (ranSec.atLeast > reloadSec + 0.05 || ranSec.atMost < reloadSec - 0.05) problems.push(`a1: reload animation ran ${JSON.stringify(ranSec)} s, reload time ${reloadSec} s`);
  if (end.viewmodel?.phase === 'reload') problems.push('a1: still reloading after the reload time');
  if (!reloadCues.some((c) => c.endsWith('.clipout')) || !reloadCues.some((c) => c.endsWith('.clipin')) || !reloadCues.some((c) => c.endsWith('.bolt'))) problems.push(`a1: reload sounds: ${reloadCues.join(', ')}`);
  // 4. Screenshots: pause the round, then fixed poses.
  await p.keyboard.press('KeyP');
  await p.evaluate(() => window.__cs2sim3d?.setLook(-120, 6));
  const poses: [string, Record<string, unknown>][] = [
    ['ak47-idle', { weapon: 'ak47' }],
    ['ak47-fire', { weapon: 'ak47', sinceShot: 0.012 }],
    ['m4a1s', { weapon: 'm4a1s' }],
    ['awp', { weapon: 'awp' }],
    ['deagle', { weapon: 'deagle' }],
    ['usps', { weapon: 'usps', sinceShot: 0.02 }],
    ['knife', { weapon: 'knife', swing: 0.14 }],
    ['c4', { weapon: 'c4', plant: 0.6 }],
    ['he', { weapon: 'he', primed: true }],
  ];
  for (const [name, pose] of poses) {
    await p.evaluate((pose) => window.__cs2a1?.preview(pose as { weapon: string }), pose);
    await p.waitForTimeout(250);
    await shotTo(p, ctx, name, shots);
  }
  await p.evaluate(() => window.__cs2a1?.preview(null));
  await p.close();
  // World models: watching, third person, at the start.
  const w = await ctx.open(1280, 720);
  await w.evaluate(() => window.__cs2sim3d?.fly(-300, -400, 120, 140, 12));
  await ctx.seek(w, 3);
  await w.evaluate(() => window.__cs2sim3d?.camera('follow', 'cart'));
  await w.waitForTimeout(400);
  await shotTo(w, ctx, 'world', shots);
  await w.close();
  r['screenshots'] = shots;
}

/** Standalone: `npx tsx tools/browser-check3d-a1.ts [--port 4187] [--out docs/img]` (after npm run build:3d). */
async function standalone(): Promise<void> {
  const { createServer } = await import('node:http');
  const { readFileSync, statSync, mkdirSync } = await import('node:fs');
  const { extname, resolve } = await import('node:path');
  const { chromium } = await import('playwright-core');
  const arg = (n: string, d: string): string => {
    const i = process.argv.indexOf(n);
    return i >= 0 ? (process.argv[i + 1] ?? d) : d;
  };
  const root = resolve(new URL('..', import.meta.url).pathname);
  const dir = resolve(root, 'dist-3d');
  const port = Number(arg('--port', process.env['BROWSER_CHECK_PORT'] ?? '4187'));
  const out = resolve(root, arg('--out', 'docs/img'));
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
  const problems: string[] = [];
  const report: Record<string, unknown> = {};
  const open = async (w: number, h: number): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 120_000 });
    return page;
  };
  const seek = async (page: Page, t: number): Promise<void> => {
    await page.evaluate((t) => window.__cs2sim3d?.seek(t), t);
    await page.waitForFunction((k) => (window.__cs2sim3d?.stats().tick ?? 0) >= k, Math.round(t * 64), { timeout: 120_000 });
    await page.waitForTimeout(400);
  };
  try {
    await a1Checks(browser, { open, seek, out, root }, problems, report);
  } finally {
    await browser.close();
    server.close();
  }
  report['problems'] = problems;
  console.log(JSON.stringify(report, null, 2));
  if (problems.length > 0) process.exit(1);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('browser-check3d-a1.ts')) await standalone();
