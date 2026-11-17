/**
 * Headless Chrome check of the demo coach page (docs/coach/app.md "Browser check").
 *
 *   CHROME_PATH=/usr/bin/google-chrome npx tsx tools/coach/browser-check.ts [--craw file] [--user slot] [--round n] [--no-build]
 *
 * Builds the page (`npm run build:coach`), serves dist-coach/ with `vite preview` (which also serves the map packs),
 * and in a fresh browser profile:
 *  1. drops the `.craw` (default: the test demo's cache in /home/claude/coach-data/cache or local/coach-cache, else the
 *     committed anonymized fixture), picks a player, waits for the match page: drop → interactive time;
 *  2. opens every played round from the round strip; checks every living player sits on a drawn (walkable) part of
 *     the radar (within 30 units) at seven ticks per round and inside the bounding box of his place name (data/coach/maps/<map>/places.json);
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
import type { Annotation, ChartPayload, Finding, MatchReport, ReplayTrack } from '../../src/coach/model/report';
import { metricValue } from '../../src/coach/report/format';

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
const USER = Number(arg('--user', '6'));
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
      // The most opaque, brightest pixel within 6 radar px (about 30 units: a player can stand on a ledge or a wall
      // top just past the drawn floor, e.g. on top of mid's walls).
      let alpha = 0;
      let lum = 0;
      const d = g.getImageData(Math.round(px) - 6, Math.round(py) - 6, 13, 13).data;
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

/** Everything the report part of the page must show for this report. */
async function checkReport(page: Page, report: MatchReport, id: string, fail: (m: string) => void): Promise<void> {
  // Names hidden: no real player name anywhere in the page text.
  const text = await page.evaluate(() => document.body.innerText);
  const leaked = report.match.players.map((p) => p.name).filter((n) => n.length >= 3 && text.includes(n));
  if (leaked.length) fail(`names shown with "Hide names" on: ${leaked.length}`);
  const fixes = await page.$$eval('[data-testid="fix-card"]', (els) => els.map((e) => ({
    id: e.getAttribute('data-id') ?? '', key: e.querySelector('[data-testid="key-number"]')?.textContent ?? '',
    strip: e.querySelector('[data-testid="rank-strip"] svg circle') !== null, watch: e.querySelectorAll('[data-testid="watch"]').length,
  })));
  console.log(`fix cards: ${fixes.map((f) => `${f.id} = ${f.key}`).join('; ')}`);
  if (fixes.length !== report.topFixes.length || fixes.some((f, k) => f.id !== report.topFixes[k])) fail('fix cards do not match report.topFixes');
  for (const f of fixes) {
    const fd = report.findings.find((x) => x.id === f.id);
    const m = fd?.metrics[0];
    if (m && f.key !== metricValue(m.value, m.unit)) fail(`${f.id}: key number "${f.key}", expected "${metricValue(m.value, m.unit)}"`);
    if (!f.strip) fail(`${f.id}: no rank strip`);
    if (f.watch !== (fd?.evidence.length ?? 0)) fail(`${f.id}: ${f.watch} Watch buttons for ${fd?.evidence.length ?? 0} moments`);
  }
  const strengths = await page.$$eval('[data-testid="strength-card"]', (els) => els.length);
  if (strengths !== report.strengths.length) fail(`${strengths} strength cards for ${report.strengths.length} strengths`);
  const areas = await page.$$eval('[data-testid="area"]', (els) => els.map((e) => `${e.getAttribute('data-area') ?? ''}=${e.querySelector('[data-testid="area-status"]')?.textContent ?? ''}`));
  console.log(`areas: ${areas.join(', ')}`);
  for (const a of ['aim', 'movement', 'utility', 'positioning', 'economy']) if (areas.includes(`${a}=not analyzed`)) fail(`${a} says "not analyzed"`);
  const strips = await page.$$eval('[data-testid="rank-strip"]', (els) => ({ n: els.length, tied: els.filter((e) => e.getAttribute('data-tied') !== '1').length }));
  console.log(`rank strips: ${strips.n} (${strips.tied} with the user tied)`);
  if (strips.n < report.metrics.filter((m) => m.lobby.some((v) => Number.isFinite(v))).length) fail('a metric without a rank strip');
  if (/\b0\.\d+ %/.test(text)) fail('a raw share printed as a percentage');
  // Duel view and spray plot from the report's own evidence.
  for (const kind of ['duel', 'spray'] as const) {
    const fi = report.findings.findIndex((f) => f.evidence.some((e) => e.kind === kind && (e.series?.length ?? 0) > 0));
    if (fi < 0) {
      // The committed fixture has ticks for round 4 only, so a player may have no aim evidence there.
      const msg = `no ${kind} evidence with series in this report (pick a player who has one)`;
      if (CRAW.endsWith('test-demo-r4.craw.gz')) console.log(`  note: ${msg}`);
      else fail(msg);
      continue;
    }
    const k = report.findings[fi]?.evidence.findIndex((e) => e.kind === kind) ?? 0;
    const ev = report.findings[fi]?.evidence[k];
    await page.click(`a[data-testid="watch"][href*="ev=${fi}.${k}"]`);
    const sel = kind === 'duel' ? '[data-testid="duel-view"] svg path.dv-line' : '[data-testid="spray-plot"] svg .sp-b circle';
    const ok = await page.waitForSelector(sel, { timeout: 5000 }).then(() => true).catch(() => false);
    await page.waitForFunction((r) => (window as unknown as { __coach: Hook }).__coach.replay?.track?.round === r, ev?.round ?? 0, { timeout: 5000 }).catch(() => undefined);
    const st = await engineState(page);
    console.log(`${kind}: finding ${report.findings[fi]?.id ?? ''} evidence ${k}, round ${st.round} tick ${st.tick.toFixed(0)} (focus ${ev?.focus ?? 0}), viewer ${ok}`);
    if (!ok) fail(`the ${kind} viewer did not render`);
    if (st.round !== ev?.round || !st.evidence) fail(`the ${kind} Watch did not open its round with the evidence`);
    await page.evaluate(() => (window as unknown as { __coach: Hook }).__coach.replay?.play(false));
    await page.screenshot({ path: join(OUT, `2${kind === 'duel' ? 'b-duel' : 'c-spray'}.png`), fullPage: false });
  }
  await page.goto(`${ORIGIN}/#/m/${id}`);
}

/** Synthetic chart payloads of every kind, as K6 and K8 will fill them. */
function syntheticCharts(f: Finding, kill: { ax: number; ay: number; vx: number; vy: number } | undefined): Record<string, ChartPayload> {
  const link = { finding: f.id, evidence: 0 };
  const k = kill ?? { ax: 0, ay: 0, vx: 500, vy: 500 };
  return {
    'aim.placement': {
      kind: 'scatter', area: 'aim', title: 'Where enemies appeared (synthetic)', caption: 'Degrees from your crosshair; rings at 1°, 3°, 5°.',
      x: { label: 'Horizontal', unit: '°', min: -8, max: 8 }, y: { label: 'Vertical', unit: '°', min: -8, max: 8 }, rings: [1, 3, 5],
      categories: [{ key: 'hold', label: 'Holding', role: 'ct' }, { key: 'peek', label: 'Peeking', role: 't' }],
      points: [{ x: 0.5, y: -0.4, cat: 'hold', label: 'r4', link }, { x: -2.2, y: 1.1, cat: 'peek' }, { x: 4.1, y: -2.5, cat: 'peek' }, { x: 1.4, y: 0.2, cat: 'hold' }],
    },
    'aim.synthetic_bars': {
      kind: 'bars', area: 'aim', title: 'First-bullet hits by distance (synthetic)', unit: '%',
      bars: [{ label: 'close', value: 62, n: 13 }, { label: 'mid', value: 41, n: 22, user: true }, { label: 'long', value: 18, n: 9 }], ref: { value: 45, label: 'lobby' },
    },
    'strat.lane': {
      kind: 'boards', area: 'strategy', title: 'Round boards (synthetic)', legend: [{ key: 'ct', label: 'CT', role: 'ct' }, { key: 't', label: 'T', role: 't' }],
      boards: [1, 2, 3].map((r) => ({
        round: r, caption: r === 2 ? 'Long taken, nobody contested' : 'Contested', highlight: r === 2, link,
        dots: [{ x: k.ax, y: k.ay, role: 't' as const }, { x: k.vx, y: k.vy, role: 'ct' as const, shape: r === 2 ? 'cross' as const : 'dot' as const }],
        zones: [{ polygon: [[k.vx - 300, k.vy - 300], [k.vx + 300, k.vy - 300], [k.vx + 300, k.vy + 300], [k.vx - 300, k.vy + 300]] as [number, number][], role: 'accent' as const, label: 'lane' }],
      })),
    },
    'strat.synthetic_series': {
      kind: 'series', area: 'strategy', title: 'A series chart (synthetic)', x: { label: 'Round', unit: '#' }, y: { label: 'Alive', unit: 'players' },
      series: [{ name: 'ct', label: 'CT alive', role: 'ct', x: [1, 2, 3, 4], y: [5, 4, 2, 1] }, { name: 't', label: 'T alive', role: 't', x: [1, 2, 3, 4], y: [5, 5, 4, 3] }],
    },
  };
}

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

    // 1. Drop the .craw and pick a player (names hidden: every screenshot shows A1…B5 only).
    await page.goto(ORIGIN + '/');
    await page.evaluate(() => localStorage.setItem('cs2-coach.hideNames', '1'));
    await page.reload();
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

    // 1b. The report (K5): fix cards with formatted numbers and rank strips, strengths, skill areas, names hidden,
    // a duel view and a spray plot from the report's own evidence.
    const report = await page.evaluate(async (mid) => (window as unknown as { __coach: Hook }).__coach.library.loadReport(mid), id);
    if (!report) fail('report not in the library');
    else await checkReport(page, report, id, fail);

    // 2. Every played round (from the strip): players on the radar and in their places, at seven ticks each.
    const mapName = await page.evaluate(() => ((window as unknown as { __coach: Hook }).__coach.replay as unknown as { map: { map: string } }).map.map);
    const placesFile = resolve(ROOT, `data/coach/maps/${mapName}/places.json`);
    const boxes = existsSync(placesFile)
      ? (JSON.parse(readFileSync(placesFile, 'utf8')) as { places: { name: string; bounds: { minX: number; minY: number; maxX: number; maxY: number } }[] }).places
      : [];
    const played = await page.evaluate(async (mid) => {
      const r = await (window as unknown as { __coach: Hook }).__coach.library.loadReport(mid);
      return (r?.match.rounds ?? []).filter((x) => x.played).map((x) => x.number);
    }, id);
    // The committed fixture has the full tick grid for round 4 only.
    const checkRounds = CRAW.includes('test-demo-r4') ? [ROUND] : [...played.filter((n) => n !== ROUND), ROUND];
    let onRadar = 0;
    let offRadar = 0;
    let inPlace = 0;
    let outPlace = 0;
    const openRound = async (n: number): Promise<{ tick0: number; step: number; samples: number; phases: ReplayTrack['phases']; kills: ReplayTrack['events']['kills']; side: number[] }> => {
      await page.click(`.rounds a[href$="/r/${n}"]`);
      await page.waitForFunction((x) => (window as unknown as { __coach: Hook }).__coach.replay?.track?.round === x, n);
      return page.evaluate(() => {
        const t = (window as unknown as { __coach: Hook }).__coach.replay?.track;
        if (!t) throw new Error('no track');
        return { tick0: t.tick0, step: t.step, samples: t.samples, phases: t.phases, kills: t.events.kills, side: [...t.side] };
      });
    };
    let track = await openRound(checkRounds[0] ?? ROUND);
    for (const [i, n] of checkRounds.entries()) {
      if (i > 0) track = await openRound(n);
      const live0 = track.phases.freezeEnd ?? track.tick0;
      for (let s = 0; s <= 6; s++) {
        const tick = live0 + Math.round(((track.phases.end - live0) * s) / 6);
        await seekTo(page, tick);
        for (const q of await placed(page)) {
          if (q.alpha > 0 && q.lum > 20) onRadar++;
          else { offRadar++; console.log(`  off radar: round ${n} slot ${q.p} at ${q.x},${q.y} (px ${q.px.toFixed(0)},${q.py.toFixed(0)}) tick ${tick}`); }
          const box = boxes.find((b) => b.name === q.place);
          if (!box) continue;
          if (q.x >= box.bounds.minX - 1 && q.x <= box.bounds.maxX + 1 && q.y >= box.bounds.minY - 1 && q.y <= box.bounds.maxY + 1) inPlace++;
          else { outPlace++; console.log(`  outside ${q.place}: round ${n} slot ${q.p} at ${q.x},${q.y}`); }
        }
      }
    }
    const live = track.phases.freezeEnd ?? track.tick0;
    console.log(`rounds checked: ${checkRounds.join(' ')}`);
    console.log(`positions: ${onRadar} on the radar's drawn area, ${offRadar} off it; ${inPlace} inside their place's box, ${outPlace} outside`);
    if (offRadar > 0) fail(`${offRadar} player positions off the radar's walkable area`);
    if (outPlace > 0) fail(`${outPlace} player positions outside their place name's box`);
    if (onRadar < 20) fail(`only ${onRadar} positions checked`);
    await seekTo(page, live + 25 * 64);
    await page.screenshot({ path: join(OUT, '3-round.png') });

    // 3. Kill lines on their kills' ticks (every kill of the round with both positions, 200+ units apart).
    const colors = await page.evaluate(() => {
      const st = getComputedStyle(document.documentElement);
      return { t: st.getPropertyValue('--t'), ct: st.getPropertyValue('--ct') };
    });
    const lineKills = track.kills.filter((k) => k.attacker >= 0 && k.ax !== -32768 && k.vx !== -32768 && Math.hypot(k.ax - k.vx, k.ay - k.vy) > 200);
    const kill = lineKills[0];
    if (!kill) fail('no kill with two positions in the round');
    let linesOk = 0;
    for (const k of lineKills) {
      const mx = (k.ax + k.vx) / 2;
      const my = (k.ay + k.vy) / 2;
      const want = hex((track.side[k.attacker] ?? 0) === 2 ? colors.t : colors.ct);
      await seekTo(page, k.tick - 8);
      const before = await pixelAt(page, mx, my);
      await seekTo(page, k.tick);
      const at = await pixelAt(page, mx, my);
      if (k === kill) await page.screenshot({ path: join(OUT, '4-kill.png') });
      const ok = dist(at, want) < dist(before, want) && dist(at, before) > 30;
      console.log(`  kill at tick ${k.tick}: midpoint ${before.join(',')} → ${at.join(',')} (killer side ${want.join(',')}) ${ok ? 'line' : 'NO LINE'}`);
      if (ok) linesOk++;
      else fail(`no kill line at tick ${k.tick}`);
      const feed = await page.locator('[data-testid="kill-feed"] li').count();
      if (feed < 1) fail(`the kill feed is empty on the kill at tick ${k.tick}`);
    }
    console.log(`kill lines: ${linesOk} of ${lineKills.length} drawn on their tick`);

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
        metrics: [{ id: 'check.metric', value: 0.42, unit: '%', n: 9, lobbyRank: 8, lobby: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
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
      await page.evaluate(async ([mid, f, charts]) => {
        const lib = (window as unknown as { __coach: Hook }).__coach.library;
        const r = await lib.loadReport(mid);
        if (!r) throw new Error('report not in the library');
        r.findings = [f];
        r.topFixes = [f.id];
        r.strengths = [];
        r.charts = charts;
        await lib.putReport(mid, r);
      }, [id, finding, syntheticCharts(finding, kill)] as [string, Finding, Record<string, ChartPayload>]);
      await page.goto(`${ORIGIN}/#/m/${id}`);
      await page.reload();
      await page.waitForSelector('[data-testid="watch"]');
      // The synthetic charts render in their areas (scatter and bars in Aim, boards in Strategy).
      const charts = await page.$$eval('[data-testid="chart"]', (els) => els.map((e) => `${e.getAttribute('data-chart') ?? ''}:${e.getAttribute('data-kind') ?? ''}:${e.querySelectorAll('circle,rect,polygon,path').length}`));
      console.log(`charts: ${charts.join(', ')}`);
      if (charts.length !== 4 || charts.some((c) => c.endsWith(':0'))) fail(`expected 4 non-empty charts, got ${charts.join(', ')}`);
      const boards = await page.$$eval('[data-testid="board"] image', (els) => els.length);
      if (boards < 3) fail(`round boards without the radar: ${boards}`);
      await page.locator('[data-testid="chart"]').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(OUT, '6b-charts.png'), fullPage: true });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(OUT, '6-finding.png') });
      const watchHref = await page.getAttribute('[data-testid="watch"]', 'href');
      await page.click('[data-testid="watch"]');
      await page.waitForSelector('[data-testid="evidence-caption"]');
      // Effects run after the paint that shows the caption: wait for the engine to take the evidence.
      await page.waitForFunction((n) => {
        const e = (window as unknown as { __coach: Hook }).__coach.replay;
        return e?.track?.round === n && e.evidence !== null;
      }, ROUND, { timeout: 5000 }).catch(() => undefined);
      console.log(`Watch link ${watchHref ?? ''} → ${page.url().replace(ORIGIN, '')}`);
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

    // 5b. Feedback: a thumbs-down with a note on the synthetic finding, kept per match, exported from the library.
    await page.goto(`${ORIGIN}/#/m/${id}`);
    await page.waitForSelector('[data-testid="fix-card"] [data-testid="fb-down"]');
    await page.click('[data-testid="fix-card"] [data-testid="fb-down"]');
    await page.fill('[data-testid="fix-card"] [data-testid="fb-note"]', 'checked by the browser check');
    await page.press('[data-testid="fix-card"] [data-testid="fb-note"]', 'Enter');
    await page.locator('[data-testid="fix-card"] [data-testid="fb-note"]').blur();
    const stored = await page.evaluate((mid) => localStorage.getItem(`cs2-coach.feedback.${mid}`), id);
    console.log(`feedback stored: ${stored ?? 'nothing'}`);
    if (!stored?.includes('"down"') || !stored.includes('checked by the browser check')) fail('feedback not stored');

    // 6. Reload and reopen from the library.
    await page.goto(`${ORIGIN}/#/`);
    await page.reload();
    await page.waitForSelector('[data-testid="open-match"]');
    const dl = page.waitForEvent('download', { timeout: 10_000 }).catch(() => null);
    await page.click('[data-testid="export-feedback"]');
    const download = await dl;
    const exported = await page.evaluate(() => (window as unknown as { __coach: Record<string, unknown> }).__coach['lastFeedbackExport'] as { matches: { id: string; findings: { id: string; vote: string; title?: string }[] }[] } | undefined);
    const exp = exported?.matches.find((m) => m.id === id)?.findings.find((f) => f.id === 'check.synthetic');
    console.log(`feedback export: ${download ? download.suggestedFilename() : 'no download'}; ${JSON.stringify(exp ?? null)}`);
    if (!download || exp?.vote !== 'down' || exp.title !== 'Synthetic check finding') fail('feedback export missing the entry');
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
