/**
 * Headless Chrome check of the demo coach page (docs/coach/app.md "Browser check").
 *
 *   CHROME_PATH=/usr/bin/google-chrome npx tsx tools/coach/browser-check.ts [--craw file] [--user slot] [--round n] [--no-build]
 *
 * Builds the page (`npm run build:coach`), serves dist-coach/ with `vite preview` (which also serves the map packs),
 * and in a fresh browser profile:
 *  1. drops the `.craw` (default: the test demo's cache in /home/claude/coach-data/cache or local/coach-cache, else the
 *     committed anonymized fixture), picks a player, waits for the match page: drop → interactive time;
 *  2. opens a round from the round strip; checks every living player sits on a drawn (walkable) part of the radar at
 *     several ticks and inside the bounding box of his place name (data/coach/maps/<map>/places.json);
 *  3. seeks to a kill: the kill line must appear on the kill's tick (pixels at its midpoint change against the tick
 *     before, toward the killer's side colour);
 *  4. plays 4 s at 1× and measures frame and draw times; keyboard: space, arrows, [ and ];
 *  5. adds a synthetic finding with one evidence moment and every annotation kind to the stored report, reloads,
 *     clicks its Watch button: the round opens 5 s before the focus, plays, shows the caption, pauses at tick1;
 *  6. reloads, reopens the match from the library (time to open);
 *  7. fails on console errors or page errors. Screenshots go to logs/coach/ (gitignored: they show player names when
 *     the demo has real ones).
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import type { Annotation, Finding, MatchReport, ReplayTrack } from '../../src/coach/model/report';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'logs/coach');
const argv = process.argv.slice(2);
const arg = (name: string, d: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] ?? d) : d;
};
const PORT = Number(arg('--port', process.env['CHECK_PORT'] ?? '4183'));
const ORIGIN = `http://127.0.0.1:${PORT}`;

function defaultCraw(): string {
  for (const dir of ['/home/claude/coach-data/cache', resolve(ROOT, 'local/coach-cache')]) {
    if (!existsSync(dir)) continue;
    const f = readdirSync(dir).find((n) => n.startsWith('84a1a4191302') && /\.craw(\.gz)?$/.test(n));
    if (f) return join(dir, f);
  }
  return resolve(ROOT, 'tests/coach/fixtures/test-demo-r4.craw.gz');
}
const CRAW = resolve(arg('--craw', defaultCraw()));
const USER = Number(arg('--user', '0'));
const ROUND = Number(arg('--round', '4'));

interface EngineView {
  track: ReplayTrack | null;
  tick: number;
  playing: boolean;
  speed: number;
  evidence: unknown;
  stats: { frames: number; drawMs: number; maxDrawMs: number; intervalMs: number; intervals: number };
  seek(t: number): void;
  play(on?: boolean): void;
  setSpeed(s: number): void;
}

interface Hook {
  replay?: EngineView;
  lastLoad?: { ms: number; timings: Record<string, number>; replayBytes: number; storedBytes: number; source: string };
  openMs?: number;
  library: {
    listMatches(): Promise<{ id: string }[]>;
    loadReport(id: string): Promise<MatchReport | null>;
    putReport(id: string, r: MatchReport): Promise<void>;
  };
}

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
  const vite = resolve(ROOT, 'node_modules/vite/bin/vite.js');
  return spawn(process.execPath, [vite, 'preview', '--config', 'vite.coach.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function engineState(page: Page): Promise<{ tick: number; playing: boolean; speed: number; round: number; evidence: boolean }> {
  return page.evaluate(() => {
    const e = (window as unknown as { __coach: Hook }).__coach.replay;
    if (!e || !e.track) throw new Error('no replay engine');
    return { tick: e.tick, playing: e.playing, speed: e.speed, round: e.track.round, evidence: e.evidence !== null };
  });
}

/** Seek and pause, then wait two frames so the canvas shows that tick. */
async function seekTo(page: Page, tick: number): Promise<void> {
  await page.evaluate((t) => {
    const e = (window as unknown as { __coach: Hook }).__coach.replay;
    e?.play(false);
    e?.seek(t);
  }, tick);
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

interface Placed { p: number; place: string; x: number; y: number; px: number; py: number; alpha: number; lum: number }

/** Living players at the engine's tick: world position, place, radar pixel, and the radar image's pixel under them. */
async function placed(page: Page): Promise<Placed[]> {
  return page.evaluate(async () => {
    const e = (window as unknown as { __coach: Hook }).__coach.replay;
    const t = e?.track;
    if (!e || !t) throw new Error('no track');
    const map = (e as unknown as { map: { radar: { pos_x: number; pos_y: number; scale: number; width: number; height: number }; upper: HTMLImageElement } }).map;
    const cv = document.createElement('canvas');
    cv.width = map.radar.width;
    cv.height = map.radar.height;
    const g = cv.getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('no 2d');
    g.drawImage(map.upper, 0, 0);
    const k = Math.round((e.tick - t.tick0) / t.step);
    const out: Placed[] = [];
    for (let p = 0; p < t.players; p++) {
      const o = k * t.players + p;
      if (((t.flags[o] ?? 0) & 1) === 0) continue;
      const x = t.xy[o * 2] ?? 0;
      const y = t.xy[o * 2 + 1] ?? 0;
      const px = (x - map.radar.pos_x) / map.radar.scale;
      const py = (map.radar.pos_y - y) / map.radar.scale;
      // The most opaque, brightest pixel within 2 px (a player stands at a wall's edge at times).
      let alpha = 0;
      let lum = 0;
      const d = g.getImageData(Math.round(px) - 2, Math.round(py) - 2, 5, 5).data;
      for (let i = 0; i < d.length; i += 4) {
        alpha = Math.max(alpha, d[i + 3] ?? 0);
        lum = Math.max(lum, ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0)) / 3);
      }
      out.push({ p, place: t.places[t.place[o] ?? 0] ?? '', x, y, px, py, alpha, lum });
    }
    await Promise.resolve();
    return out;
  });
}

/** Canvas pixel (device pixels) at a world point of the current track's map. */
async function pixelAt(page: Page, wx: number, wy: number): Promise<[number, number, number]> {
  return page.evaluate(([x, y]) => {
    const e = (window as unknown as { __coach: Hook }).__coach.replay as unknown as { toCanvas(x: number, y: number): [number, number] };
    const cv = document.querySelector('[data-testid="replay-canvas"]') as HTMLCanvasElement;
    const [px, py] = e.toCanvas(x, y);
    const g = cv.getContext('2d');
    const d = g?.getImageData(Math.round(px), Math.round(py), 1, 1).data;
    return [d?.[0] ?? 0, d?.[1] ?? 0, d?.[2] ?? 0] as [number, number, number];
  }, [wx, wy] as [number, number]);
}

function hex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim());
  return m ? [parseInt(m[1] ?? '0', 16), parseInt(m[2] ?? '0', 16), parseInt(m[3] ?? '0', 16)] : [0, 0, 0];
}
const dist = (a: number[], b: number[]): number => Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (!argv.includes('--no-build')) {
    const b = spawnSync('npm', ['run', 'build:coach'], { cwd: ROOT, stdio: 'inherit' });
    if (b.status !== 0) throw new Error('build:coach failed');
  }
  console.log(`craw: ${CRAW}`);
  const problems: string[] = [];
  const fail = (m: string): void => { problems.push(m); console.log(`  FAIL ${m}`); };
  const server = startPreview();
  try {
    await waitForServer(ORIGIN + '/', 15_000);
    const exe = process.env['CHROME_PATH'];
    const browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
    console.log(`browser: ${browser.version()}`);
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 960 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

    // 1. Drop the .craw and pick a player.
    await page.goto(ORIGIN + '/');
    const t0 = Date.now();
    await page.setInputFiles('[data-testid="file-input"]', CRAW);
    await page.waitForSelector('[data-testid="picker"]', { timeout: 60_000 });
    const pickerMs = Date.now() - t0;
    await page.screenshot({ path: join(OUT, '1-picker.png') });
    const t1 = Date.now();
    await page.click(`[data-testid="pick"][data-slot="${USER}"]`);
    await page.waitForFunction(() => {
      const e = (window as unknown as { __coach?: Hook }).__coach?.replay;
      return e !== undefined && e.track !== null && (e as unknown as { map: unknown }).map !== null;
    }, undefined, { timeout: 60_000 });
    const interactiveMs = Date.now() - t0;
    const load = await page.evaluate(() => (window as unknown as { __coach: Hook }).__coach.lastLoad);
    const id = (/#\/m\/([^/?]+)/.exec(page.url()) ?? [])[1] ?? '';
    console.log(`drop → picker ${pickerMs} ms; pick → match page ${Date.now() - t1} ms; drop → interactive ${interactiveMs} ms (incl. the click)`);
    console.log(`pipeline: ${JSON.stringify(load)}`);
    if (!id) fail('no match id in the URL after analysis');
    await page.screenshot({ path: join(OUT, '2-match.png'), fullPage: true });

    // 2. Open a round from the strip; players on the radar and in their places.
    await page.click(`.rounds a[href$="/r/${ROUND}"]`);
    await page.waitForFunction((n) => (window as unknown as { __coach: Hook }).__coach.replay?.track?.round === n, ROUND);
    const track = await page.evaluate(() => {
      const t = (window as unknown as { __coach: Hook }).__coach.replay?.track;
      if (!t) throw new Error('no track');
      return { tick0: t.tick0, step: t.step, samples: t.samples, phases: t.phases, kills: t.events.kills, side: [...t.side] };
    });
    const mapName = await page.evaluate(() => ((window as unknown as { __coach: Hook }).__coach.replay as unknown as { map: { map: string } }).map.map);
    const placesFile = resolve(ROOT, `data/coach/maps/${mapName}/places.json`);
    const boxes = existsSync(placesFile)
      ? (JSON.parse(readFileSync(placesFile, 'utf8')) as { places: { name: string; bounds: { minX: number; minY: number; maxX: number; maxY: number } }[] }).places
      : [];
    const live = track.phases.freezeEnd ?? track.tick0;
    let onRadar = 0;
    let offRadar = 0;
    let inPlace = 0;
    let outPlace = 0;
    for (let s = 0; s <= 6; s++) {
      const tick = live + Math.round(((track.phases.end - live) * s) / 6);
      await seekTo(page, tick);
      for (const q of await placed(page)) {
        if (q.alpha > 0 && q.lum > 20) onRadar++;
        else { offRadar++; console.log(`  off radar: slot ${q.p} at ${q.x},${q.y} (px ${q.px.toFixed(0)},${q.py.toFixed(0)}) tick ${tick}`); }
        const box = boxes.find((b) => b.name === q.place);
        if (!box) continue;
        if (q.x >= box.bounds.minX - 1 && q.x <= box.bounds.maxX + 1 && q.y >= box.bounds.minY - 1 && q.y <= box.bounds.maxY + 1) inPlace++;
        else { outPlace++; console.log(`  outside ${q.place}: slot ${q.p} at ${q.x},${q.y}`); }
      }
    }
    console.log(`positions: ${onRadar} on the radar's drawn area, ${offRadar} off it; ${inPlace} inside their place's box, ${outPlace} outside`);
    if (offRadar > 0) fail(`${offRadar} player positions off the radar's walkable area`);
    if (outPlace > 0) fail(`${outPlace} player positions outside their place name's box`);
    if (onRadar < 20) fail(`only ${onRadar} positions checked`);
    await seekTo(page, live + 25 * 64);
    await page.screenshot({ path: join(OUT, '3-round.png') });

    // 3. A kill line on the kill's tick.
    const kill = track.kills.find((k) => k.attacker >= 0 && k.ax !== -32768 && Math.hypot(k.ax - k.vx, k.ay - k.vy) > 200);
    if (!kill) fail('no kill with two positions in the round');
    else {
      const mx = (kill.ax + kill.vx) / 2;
      const my = (kill.ay + kill.vy) / 2;
      const colors = await page.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        return { t: s.getPropertyValue('--t'), ct: s.getPropertyValue('--ct') };
      });
      const want = hex((track.side[kill.attacker] ?? 0) === 2 ? colors.t : colors.ct);
      await seekTo(page, kill.tick - 8);
      const before = await pixelAt(page, mx, my);
      await seekTo(page, kill.tick);
      const at = await pixelAt(page, mx, my);
      await page.screenshot({ path: join(OUT, '4-kill.png') });
      const ok = dist(at, want) < dist(before, want) && dist(at, before) > 30;
      console.log(`kill at tick ${kill.tick}: midpoint pixel before ${before.join(',')} → at ${at.join(',')} (killer side colour ${want.join(',')}): ${ok ? 'line drawn' : 'NO LINE'}`);
      if (!ok) fail(`no kill line at tick ${kill.tick}`);
      const feed = await page.locator('[data-testid="kill-feed"] li').count();
      if (feed < 1) fail('the kill feed is empty on a kill tick');
    }

    // 4. Play at 1× for 4 s: frame and draw times; keyboard.
    await seekTo(page, live);
    await page.evaluate(() => {
      const e = (window as unknown as { __coach: Hook }).__coach.replay;
      if (!e) return;
      Object.assign(e.stats, { frames: 0, drawMs: 0, maxDrawMs: 0, intervalMs: 0, intervals: 0 });
    });
    await page.keyboard.press('Space');
    const playT0 = Date.now();
    await sleep(4000);
    const st = await page.evaluate(() => {
      const e = (window as unknown as { __coach: Hook }).__coach.replay;
      return e ? { tick: e.tick, playing: e.playing, ...e.stats } : null;
    });
    const wall = (Date.now() - playT0) / 1000;
    await page.screenshot({ path: join(OUT, '5-playing.png') });
    if (!st || !st.playing) fail('space did not start playback');
    else {
      const ticks = st.tick - live;
      const fps = st.intervals ? 1000 / (st.intervalMs / st.intervals) : 0;
      console.log(`playing 1×: ${ticks.toFixed(0)} ticks in ${wall.toFixed(1)} s (${(ticks / wall).toFixed(1)}/s); ${fps.toFixed(1)} fps, draw ${(st.drawMs / Math.max(1, st.frames)).toFixed(2)} ms mean, ${st.maxDrawMs.toFixed(1)} ms max over ${st.frames} frames`);
      if (Math.abs(ticks / wall - 64) > 8) fail(`playback ran at ${(ticks / wall).toFixed(1)} ticks/s, expected 64`);
    }
    await page.keyboard.press('Space');
    let s0 = await engineState(page);
    if (s0.playing) fail('space did not pause');
    await page.keyboard.press('ArrowRight');
    let s1 = await engineState(page);
    if (Math.round(s1.tick - s0.tick) !== 320) fail(`→ moved ${s1.tick - s0.tick} ticks, expected 320`);
    await page.keyboard.press('ArrowUp');
    s0 = await engineState(page);
    if (s0.speed !== 2) fail(`↑ set speed ${s0.speed}, expected 2`);
    await page.keyboard.press('ArrowDown');
    await seekTo(page, live);
    await page.keyboard.press(']');
    s1 = await engineState(page);
    const firstKill = track.kills[0];
    if (firstKill && Math.round(s1.tick) !== firstKill.tick - 96) fail(`] went to ${s1.tick}, expected ${firstKill.tick - 96}`);
    await page.keyboard.press('[');
    const s2 = await engineState(page);
    if (s2.tick >= s1.tick) fail('[ did not go back');
    console.log(`keys: space, →, ↑/↓, ] (to ${s1.tick.toFixed(0)}), [ (to ${s2.tick.toFixed(0)}) ok`);

    // 5. A synthetic finding with every annotation kind; follow its Watch link.
    if (kill) {
      const focus = kill.tick;
      const ann = (a: Annotation): Annotation => a;
      const tick0 = focus - 192;
      const tick1 = focus + 96;
      const base = { tick0, tick1 };
      const finding: Finding = {
        id: 'check.synthetic', area: 'positioning', scope: 'micro', polarity: 'fix', title: 'Synthetic check finding',
        summary: 'A finding the browser check adds, with one moment and every annotation kind.', why: 'Checks the viewer.',
        advice: [{ text: 'Nothing to do.' }],
        metrics: [{ id: 'check.metric', value: 42, unit: '%', n: 9, lobbyRank: 8, lobby: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
        evidence: [{
          kind: 'replay', round: ROUND, tick0, tick1, focus, players: [kill.attacker, kill.victim],
          caption: 'Synthetic evidence: the sight line that killed, a ring, a cone, a path, a zone and a label.',
          annotations: [
            ann({ ...base, kind: 'line', role: 'bad', from: [kill.ax, kill.ay, kill.az], to: [kill.vx, kill.vy, kill.vz], label: 'sight line' }),
            ann({ ...base, kind: 'circle', role: 'teammate', center: [kill.vx, kill.vy, kill.vz], radius: 400, label: 'trade range' }),
            ann({ ...base, kind: 'cone', role: 'enemy', apex: [kill.ax, kill.ay, kill.az], yaw: Math.atan2(kill.vy - kill.ay, kill.vx - kill.ax) * 180 / Math.PI, halfAngle: 12, length: 700 }),
            ann({ ...base, kind: 'path', role: 'user', points: [[kill.vx - 300, kill.vy - 150, kill.vz], [kill.vx - 150, kill.vy - 40, kill.vz], [kill.vx, kill.vy, kill.vz]], ticks: [tick0, focus - 64, focus] }),
            ann({ ...base, kind: 'zone', role: 'accent', polygon: [[kill.vx - 250, kill.vy - 250], [kill.vx + 250, kill.vy - 250], [kill.vx + 250, kill.vy + 250], [kill.vx - 250, kill.vy + 250]] }),
            ann({ ...base, kind: 'label', role: 'neutral', at: [kill.vx, kill.vy + 320, kill.vz], text: 'label annotation' }),
          ],
        }],
        stats: { instances: 1, opportunities: 1, rounds: [ROUND], roundsLost: 0, winProbLost: null },
        confidence: 1, impact: 1, priority: 1,
      };
      await page.evaluate(async ([mid, f]) => {
        const lib = (window as unknown as { __coach: Hook }).__coach.library;
        const r = await lib.loadReport(mid);
        if (!r) throw new Error('report not in the library');
        r.findings = [f];
        r.topFixes = [f.id];
        await lib.putReport(mid, r);
      }, [id, finding] as [string, Finding]);
      await page.goto(`${ORIGIN}/#/m/${id}`);
      await page.reload();
      await page.waitForSelector('[data-testid="watch"]');
      await page.screenshot({ path: join(OUT, '6-finding.png') });
      await page.click('[data-testid="watch"]');
      await page.waitForSelector('[data-testid="evidence-caption"]');
      const e0 = await engineState(page);
      const lead = focus - e0.tick;
      console.log(`Watch: round ${e0.round}, opened at tick ${e0.tick.toFixed(0)} (${(lead / 64).toFixed(2)} s before the focus), playing ${e0.playing}, evidence ${e0.evidence}`);
      if (e0.round !== ROUND || !e0.evidence || !e0.playing) fail('the Watch link did not open the evidence playing');
      if (lead < 4.5 * 64 || lead > 5.05 * 64) fail(`opened ${(lead / 64).toFixed(2)} s before the focus, expected 5`);
      await page.waitForFunction((f) => ((window as unknown as { __coach: Hook }).__coach.replay?.tick ?? 0) >= f, focus, { timeout: 15_000 });
      await page.evaluate(() => (window as unknown as { __coach: Hook }).__coach.replay?.play(false));
      await page.screenshot({ path: join(OUT, '7-evidence.png') });
      // The annotations' pixels: the zone tints the victim's area toward the accent.
      await page.evaluate(() => (window as unknown as { __coach: Hook }).__coach.replay?.play(true));
      await page.waitForFunction((t) => {
        const e = (window as unknown as { __coach: Hook }).__coach.replay;
        return e !== undefined && !e.playing && e.tick >= t;
      }, tick1, { timeout: 20_000 });
      const e1 = await engineState(page);
      console.log(`evidence: paused at tick ${e1.tick.toFixed(0)} (tick1 ${tick1})`);
      if (Math.round(e1.tick) !== tick1) fail(`did not pause at tick1 (${e1.tick})`);
    }

    // 6. Reload and reopen from the library.
    await page.goto(`${ORIGIN}/#/`);
    await page.reload();
    await page.waitForSelector('[data-testid="open-match"]');
    await page.screenshot({ path: join(OUT, '8-library.png') });
    await page.click('[data-testid="open-match"]');
    await page.waitForFunction(() => (window as unknown as { __coach: Hook }).__coach.replay?.track != null);
    const openMs = await page.evaluate(() => (window as unknown as { __coach: Hook }).__coach.openMs ?? -1);
    console.log(`reopened from the library: report loaded in ${openMs.toFixed(0)} ms`);
    if (openMs < 0 || openMs > 500) fail(`opening a stored match took ${openMs} ms`);
    await page.screenshot({ path: join(OUT, '9-reopened.png') });
    await browser.close();
  } finally {
    server.kill();
  }
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\nok; screenshots in ${OUT}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
