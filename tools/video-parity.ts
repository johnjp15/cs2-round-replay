/**
 * V0: frame-by-frame parity of the sim with the original round's video (docs/parity.md).
 *
 *   npm run parity -- --app 2d|3d [--times "every 0.5" | "<t>,<t>,…"] [--no-events] [--runs watch,follow]
 *                     [--out <dir>] [--video <mp4>] [--no-browser] [--baseline <json>] [--update-baseline]
 *                     [--write-docs <md>] [--sheets all|fails|none] [--spectate <id>]
 *   npm run parity:2d     # the milestone gate: whole round, both runs, against docs/parity/baseline-2d.json
 *   npm run parity:3d     # the same for the 3D app once H1's src/app3d is on main
 *
 * 1. Frames: ffmpeg decodes frame round(t × 60) of the private video for every timestamp (cached in <out>/truth).
 * 2. Ground truth: tools/parity/video_truth.py reads the radar dots (world x/y), the HUD numbers (template-matched
 *    digits) and the 60 fps events (kill feed, C4 icon, score) off the frames.
 * 3. The sim at tick round(t × 64): the headless harness (the app's own Session) for each run; for 2D also
 *    screenshots of the built page (Playwright, port 4181) seeking to each t, cross-checked against the Node run.
 * 4. Metrics (tools/parity/metrics.ts), contact sheets (tools/parity/sheets.py), <out>/index.html, <out>/report.json,
 *    <out>/summary.md; with --write-docs the generated summary goes between the parity markers of that file.
 * 5. Baseline: every check's verdict; a check that passed in the baseline and fails now is a regression (exit 1).
 *
 * The video and audio stay outside the repo: --video (default ../web-apps/cs2/mirage-round-replay/source/
 * video_1080p60_h264.mp4 next to the repo, or $PARITY_VIDEO).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { LogEntry, Observe } from '../src/contracts/index';
import { NO_HUMAN, ROOT, ScriptDriver, deaths, loadHarnessData, parseHumanScript, roundEvents, runHarness, type HarnessOptions } from './harness';
import { loadHarness3dData, runHarness3d } from './harness3d';
import { shots2d, shots3d, VIEW3D, type Shot } from './parity/browser';
import {
  COLOUR, buildTimes, cameraAt, checkKeys, compareEvents, compareFrame, regressions, summarize, summaryMarkdown, tickOfT,
  type Baseline, type FrameResult, type RoundLite, type RunReport, type SimEvents, type SimFrame, type Truth,
} from './parity/metrics';

// ---- args --------------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
function arg(name: string, def: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] as string) : def;
}
const flag = (name: string): boolean => argv.includes(name);

const APP = arg('--app', '2d');
if (APP !== '2d' && APP !== '3d') throw new Error(`--app: 2d or 3d, got ${APP}`);
const TIMES = arg('--times', 'every 0.5');
const EVENTS = !flag('--no-events');
const RUNS = arg('--runs', 'watch,follow').split(',').map((s) => s.trim()).filter((s) => s !== '');
const OUT = resolve(arg('--out', `logs/parity-${APP}`));
/** The web-apps clone next to the repo (or next to the main clone, for a worktree under ../wt/<name>). */
const VIDEO_REL = 'web-apps/cs2/mirage-round-replay/source/video_1080p60_h264.mp4';
const VIDEO_DEFAULT = [resolve(ROOT, '..', VIDEO_REL), resolve(ROOT, '../..', VIDEO_REL)].find((p) => existsSync(p)) ?? resolve(ROOT, '..', VIDEO_REL);
const VIDEO = resolve(arg('--video', process.env['PARITY_VIDEO'] ?? VIDEO_DEFAULT));
const BROWSER = !flag('--no-browser');
const BASELINE = arg('--baseline', '');
const UPDATE_BASELINE = flag('--update-baseline');
const WRITE_DOCS = arg('--write-docs', '');
const SHEETS = arg('--sheets', 'all');
/** 3D: spectate this player's eyes at every timestamp instead of the video's camera schedule (e.g. `--spectate cart`). */
const SPECTATE = arg('--spectate', '');
/** Reuse the 2D app screenshots already in <out>/app (when all are there) instead of driving the browser again. */
const REUSE_SHOTS = flag('--reuse-shots');
const PYTHON = process.env['PYTHON'] ?? 'python3';
const FOLLOW_SCRIPT = 'fixtures/scripts/cart-follows-recording.json';

function log(s: string): void {
  console.log(s);
}

// ---- ground truth ------------------------------------------------------------------------------------------------

function groundTruth(times: readonly number[]): Truth {
  if (!existsSync(VIDEO)) {
    throw new Error(`video not found: ${VIDEO}\n  The parity test needs the private recording (johnjp15/web-apps cs2/mirage-round-replay/source/). Clone web-apps next to this repo or pass --video / $PARITY_VIDEO.`);
  }
  const dir = join(OUT, 'truth');
  mkdirSync(dir, { recursive: true });
  const timesPath = join(dir, 'times.json');
  const truthPath = join(dir, 'truth.json');
  const want = JSON.stringify(times);
  if (existsSync(truthPath) && existsSync(timesPath) && readFileSync(timesPath, 'utf8') === want) {
    log(`ground truth: cached ${relative(ROOT, truthPath)}`);
    return JSON.parse(readFileSync(truthPath, 'utf8')) as Truth;
  }
  writeFileSync(timesPath, want);
  const r = spawnSync(PYTHON, ['-I', resolve(ROOT, 'tools/parity/video_truth.py'), '--video', VIDEO, '--round', resolve(ROOT, 'data/round.json'),
    '--radar', resolve(ROOT, 'data/mirage-radar.jpg'), '--times', timesPath, '--out', dir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`video_truth.py failed (${r.status ?? r.signal}); needs python3 with numpy + opencv and ffmpeg (docs/parity.md)`);
  return JSON.parse(readFileSync(truthPath, 'utf8')) as Truth;
}

// ---- the sim -----------------------------------------------------------------------------------------------------

function mss(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

function simFrame(o: Observe): SimFrame {
  const r = o.round;
  const planted = r.bomb.state === 'planted';
  return {
    tick: o.tick,
    pawns: o.pawns.map((p) => ({ id: p.id, x: p.pos.x, y: p.pos.y, yaw: p.yaw, hp: p.hp, armor: p.armor, alive: p.alive, weapon: p.weapon, clip: p.ammo.clip, reserve: p.ammo.reserve })),
    clockText: planted ? (Math.round(r.timeLeftSec * 10) / 10).toFixed(1) : mss(r.timeLeftSec),
    bombState: r.bomb.state,
  };
}

interface SimRun {
  readonly name: string;
  readonly entries: readonly LogEntry[];
  readonly events: SimEvents;
  readonly digest: string;
}

function runSim(name: string): SimRun {
  const data = loadHarnessData();
  let options: HarnessOptions;
  if (name === 'watch') options = NO_HUMAN;
  else if (name === 'follow') {
    const script = parseHumanScript(readFileSync(resolve(ROOT, FOLLOW_SCRIPT), 'utf8'));
    options = { human: 'cart', driver: new ScriptDriver(script, 'cart'), lastTick: 'end', seed: 1 };
  } else throw new Error(`--runs: unknown run "${name}" (watch, follow)`);
  const run = APP === '3d' ? runHarness3d(loadHarness3dData(), options) : runHarness(data, options);
  const ev = roundEvents(run.entries);
  const plant = ev.find((e) => e.kind === 'bomb planted');
  const end = ev.find((e) => e.kind === 'round_end');
  return {
    name,
    entries: run.entries,
    digest: run.log.digest(),
    events: {
      deaths: deaths(run.entries).map((d) => ({ tick: d.tick, victim: d.victim, attacker: d.attacker })),
      plantTick: plant?.tick ?? null,
      roundEndTick: end?.tick ?? null,
      roundEndText: end?.text ?? null,
    },
  };
}

// ---- report ------------------------------------------------------------------------------------------------------

function html(app: string, reports: readonly RunReport[], sheetsOf: Map<string, string>): string {
  const rows: string[] = [];
  for (const r of reports) {
    rows.push(`<h2>${r.run}</h2><table><tr><th>t</th><th>tick</th><th>camera</th><th>verdict</th><th>worst dot (u)</th><th>fails</th><th>sheet</th></tr>`);
    for (const f of r.frames) {
      const bad = [...f.players.filter((p) => p.verdict === 'fail').map((p) => `${p.id} ${p.error ?? p.note}`), ...f.hud.filter((h) => h.verdict === 'fail').map((h) => `${h.field} ${h.video}≠${h.sim}`)];
      const sheet = sheetsOf.get(`${r.run}|${f.t}`);
      rows.push(`<tr class="${f.verdict}"><td>${f.t}</td><td>${f.tick}</td><td>${f.watched ?? f.layout}</td><td>${f.verdict}</td><td>${f.worstUnits ?? ''}</td><td>${bad.join('; ')}</td><td>${sheet === undefined ? '' : `<a href="${sheet}">sheet</a>`}</td></tr>`);
    }
    rows.push('</table>');
  }
  return `<!doctype html><meta charset="utf-8"><title>Video parity (${app})</title><style>body{font:13px system-ui;background:#111;color:#ddd}table{border-collapse:collapse}td,th{padding:2px 8px;border-bottom:1px solid #333}tr.fail td{color:#f88}a{color:#8cf}</style><h1>Video parity: ${app}</h1><p>summary: <a href="summary.md">summary.md</a>, data: <a href="report.json">report.json</a></p>${rows.join('\n')}`;
}

function writeDocs(path: string, generated: string): void {
  const begin = '<!-- parity:begin (generated by tools/video-parity.ts --write-docs; do not edit by hand) -->';
  const end = '<!-- parity:end -->';
  const block = `${begin}\n${generated}${end}`;
  const text = existsSync(path) ? readFileSync(path, 'utf8') : `# Video parity\n\n${begin}\n${end}\n`;
  const a = text.indexOf(begin);
  const b = text.indexOf(end);
  const next = a >= 0 && b > a ? text.slice(0, a) + block + text.slice(b + end.length) : `${text.trimEnd()}\n\n${block}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  log(`wrote the summary into ${relative(ROOT, path)}`);
}

// ---- 3D view similarity ------------------------------------------------------------------------------------------

interface ViewSummary {
  readonly shots: number;
  readonly edgeF: { readonly mean: number; readonly median: number; readonly min: number };
  readonly ssim: { readonly mean: number; readonly median: number; readonly min: number };
  /** Per spectated player (the camera schedule): shots, mean edge F, mean SSIM. */
  readonly byCamera: Readonly<Record<string, { shots: number; edgeF: number; ssim: number }>>;
  readonly worst: readonly { t: number; watched: string; edgeF: number; ssim: number }[];
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
function stats(xs: readonly number[]): { mean: number; median: number; min: number } {
  const v = [...xs].sort((a, b) => a - b);
  const mid = v.length === 0 ? 0 : v.length % 2 === 1 ? (v[(v.length - 1) / 2] as number) : ((v[v.length / 2 - 1] as number) + (v[v.length / 2] as number)) / 2;
  return { mean: r3(v.reduce((a, b) => a + b, 0) / Math.max(1, v.length)), median: r3(mid), min: r3(v[0] ?? 0) };
}

function similaritySummary(xs: readonly { t: number; edgeF: number; ssim: number; watched: string }[]): ViewSummary {
  const byCamera: Record<string, { shots: number; edgeF: number; ssim: number }> = {};
  for (const id of [...new Set(xs.map((x) => x.watched))].sort()) {
    const g = xs.filter((x) => x.watched === id);
    byCamera[id] = { shots: g.length, edgeF: stats(g.map((x) => x.edgeF)).mean, ssim: stats(g.map((x) => x.ssim)).mean };
  }
  return {
    shots: xs.length,
    edgeF: stats(xs.map((x) => x.edgeF)),
    ssim: stats(xs.map((x) => x.ssim)),
    byCamera,
    worst: [...xs].sort((a, b) => a.edgeF + a.ssim - (b.edgeF + b.ssim)).slice(0, 8),
  };
}

function similarityLine(xs: readonly { t: number; edgeF: number; ssim: number; watched: string }[]): string {
  const v = similaritySummary(xs);
  return `${v.shots} shots, edge F mean ${v.edgeF.mean} (median ${v.edgeF.median}, min ${v.edgeF.min}), SSIM mean ${v.ssim.mean} (median ${v.ssim.median}, min ${v.ssim.min})`;
}

function similarityMarkdown(v: ViewSummary): string {
  const rows = Object.entries(v.byCamera).map(([id, x]) => `| ${id} | ${x.shots} | ${x.edgeF} | ${x.ssim} |`);
  const worst = v.worst.map((x) => `${x.t} s (${x.watched}: F ${x.edgeF}, SSIM ${x.ssim})`).join(', ');
  return `\n### 3D view vs the video (spectated player's eyes, HUD masked; \`sheets.py similarity\`)\n\n` +
    `Edge F-score (Canny, 3 px) mean ${v.edgeF.mean}, median ${v.edgeF.median}, min ${v.edgeF.min}; blurred SSIM mean ${v.ssim.mean}, median ${v.ssim.median}, min ${v.ssim.min} over ${v.shots} shots.\n\n` +
    `| camera | shots | edge F | SSIM |\n| --- | ---: | ---: | ---: |\n${rows.join('\n')}\n\nLowest: ${worst}.\n\n`;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const snapped = (JSON.parse(readFileSync(resolve(ROOT, 'data/geometry/mirage-tracks.json'), 'utf8')) as { tracks: RoundLite['snapped'] }).tracks;
  const round = { ...(JSON.parse(readFileSync(resolve(ROOT, 'data/round.json'), 'utf8')) as RoundLite), ...(snapped === undefined ? {} : { snapped }) };
  const times = buildTimes(TIMES, round, EVENTS);
  log(`video parity (${APP}): ${times.length} timestamps, runs ${RUNS.join(', ')}, out ${relative(ROOT, OUT) || '.'}`);
  if (APP === '3d' && !existsSync(resolve(ROOT, 'src/app3d'))) {
    console.error('parity:3d: src/app3d is not on this branch yet (H1). docs/parity.md "What the 3D mode needs" lists the hooks it will drive.');
    process.exit(2);
  }
  const truth = groundTruth(times);
  log(`ground truth: spectator radar registered (ECC corr ${truth.specCc}), POV radar zoom ${truth.povZoom} u/px (rot ${truth.povRotOffsetDeg}°, ${truth.povCalDots} dots), ` +
    `${truth.events.killFeed.length} kill-feed entries, C4 icon ${truth.events.bombIconT ?? '–'} s, score change ${truth.events.scoreChangeT ?? '–'} s`);

  const reports: RunReport[] = [];
  const sheetSpec: { focus: string | null; out: string; video: string; sim: string | null; simLabel: string; title: string; lines: string[]; dots: unknown[]; simRadar: boolean }[] = [];
  const sheetsOf = new Map<string, string>();
  let similarity: { t: number; edgeF: number; ssim: number; watched: string }[] = [];
  const sheetDir = join(OUT, 'sheets');
  mkdirSync(sheetDir, { recursive: true });

  for (const name of RUNS) {
    const sim = runSim(name);
    log(`sim ${name}: ${sim.entries.length} ticks, log digest ${sim.digest}`);
    // Browser shots: the watch run only (the page plays what the Node run plays; checked per shot below).
    let shots: Map<number, Shot> = new Map();
    if (BROWSER && name === 'watch') {
      const cached = times.map((t) => join(OUT, 'app', `sim-${t.toFixed(3)}.jpg`));
      if (APP === '2d' && REUSE_SHOTS && cached.every((p) => existsSync(p))) {
        shots = new Map(times.map((t, i) => [t, { t, path: cached[i] as string, tick: tickOfT(t), pawns: [] }]));
        log(`app screenshots: reusing ${cached.length} in ${relative(ROOT, join(OUT, 'app'))}`);
      } else if (APP === '2d') {
        const list = await shots2d(ROOT, times, join(OUT, 'app'));
        shots = new Map(list.map((s) => [s.t, s]));
        let worst = 0;
        for (const s of list) {
          const e = sim.entries[s.tick];
          if (e === undefined) continue;
          for (const p of s.pawns) {
            const q = e.observe.pawns.find((x) => x.id === p.id);
            if (q !== undefined) worst = Math.max(worst, Math.hypot(q.pos.x - p.x, q.pos.y - p.y));
          }
        }
        log(`app screenshots: ${list.length}, page vs Node positions at the landed ticks: max ${worst.toFixed(3)} u`);
        if (worst > 0.01) throw new Error('the page does not show the Node run (positions differ): parity screenshots would be wrong');
      } else {
        const schedule = times.map((t) => ({ t, tick: Math.min(tickOfT(t) + 1, sim.entries.length - 1), watched: SPECTATE !== '' ? SPECTATE : cameraAt(round, t) }));
        const list = await shots3d(ROOT, schedule, join(OUT, 'app3d'));
        shots = new Map(list.map((s) => [s.t, s]));
        let worst = 0;
        let tickMismatch = 0;
        for (const s of list) {
          const want = schedule.find((x) => x.t === s.t)?.tick ?? -1;
          if (s.tick !== want) tickMismatch++;
          const e = sim.entries[s.tick];
          if (e === undefined) continue;
          for (const p of s.pawns) {
            const q = e.observe.pawns.find((x) => x.id === p.id);
            if (q !== undefined) worst = Math.max(worst, Math.hypot(q.pos.x - p.x, q.pos.y - p.y, q.pos.z - p.z));
          }
        }
        const cam = list[0]?.camera;
        log(`3D screenshots: ${list.length} at ${VIEW3D.width}x${VIEW3D.height} (hfov ${cam?.hfovDeg.toFixed(2) ?? '?'}°, vfov ${cam?.vfovDeg.toFixed(2) ?? '?'}°), ` +
          `ticks off ${tickMismatch}, page vs Node (Sim3DHost) positions at the landed ticks: max ${worst.toFixed(3)} u`);
        if (worst > 0.01 || tickMismatch > 0) throw new Error('the 3D page does not show the Node Sim3DHost run (positions or ticks differ)');
        const pairs = list.map((s) => ({ t: s.t, watched: s.watched, video: join(OUT, 'truth', 'frames', `f_${String(Math.round(s.t * 60)).padStart(5, '0')}.jpg`), sim: s.path }));
        const specPath = join(OUT, 'similarity-spec.json');
        writeFileSync(specPath, JSON.stringify({ pairs }));
        const r = spawnSync(PYTHON, ['-I', resolve(ROOT, 'tools/parity/sheets.py'), 'similarity', specPath], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`similarity failed: ${r.stderr}`);
        const sim3 = (JSON.parse(r.stdout) as { t: number; edgeF: number; ssim: number }[]).map((x) => ({ ...x, watched: cameraAt(round, x.t) }));
        similarity = sim3;
        writeFileSync(join(OUT, 'similarity.json'), JSON.stringify(sim3, null, 1));
        log(`3D view similarity: ${similarityLine(sim3)} (${relative(ROOT, join(OUT, 'similarity.json'))})`);
      }
    }
    const frames: FrameResult[] = [];
    for (const tt of truth.times) {
      // The state at video time t: the observe after tick round(t × 64) has run (its shots and damage included), as
      // the frame at t shows them.
      const tick = Math.min(tickOfT(tt.t) + 1, sim.entries.length - 1);
      const e = sim.entries[tick] as LogEntry;
      const at = (tt2: number): SimFrame => simFrame((sim.entries[Math.min(tickOfT(tt2) + 1, sim.entries.length - 1)] as LogEntry).observe);
      const f = compareFrame(round, tt, simFrame(e.observe), [at(tt.t - 1 / 60), at(tt.t + 1 / 60)]);
      frames.push(f);
      const shot = shots.get(tt.t);
      const doSheet = SHEETS === 'all' || (SHEETS === 'fails' && f.verdict === 'fail');
      if (doSheet) {
        const out = join(sheetDir, `${name}-${tt.t.toFixed(3)}.jpg`);
        sheetsOf.set(`${name}|${tt.t}`, relative(OUT, out));
        const failing = [
          ...f.players.filter((p) => p.verdict === 'fail').map((p) => `${p.id}: ${p.error === null ? p.note : `${p.error} u (limit ${p.limit}${p.cause ? `, mostly ${p.cause}` : ''})`}`),
          ...f.hud.filter((h) => h.verdict === 'fail').map((h) => `${h.field}: video ${h.video ?? '-'} / sim ${h.sim ?? '-'}`),
        ];
        const hudLine = f.hud.map((h) => `${h.field} ${h.video ?? '-'}|${h.sim ?? '-'}`).join('   ');
        const worst = f.players.filter((p) => p.verdict === 'fail' && p.error !== null).sort((a, b) => (b.error as number) - (a.error as number))[0];
        sheetSpec.push({
          focus: worst?.id ?? null,
          out, video: join(OUT, 'truth', 'frames', `f_${String(tt.frame).padStart(5, '0')}.jpg`), sim: shot?.path ?? null, simLabel: APP === '3d' ? `sim (3D app, ${SPECTATE !== '' ? SPECTATE : cameraAt(round, tt.t)}'s eyes)` : 'sim (2D app)', simRadar: shot === undefined,
          title: `${name} · t ${tt.t.toFixed(3)} s · tick ${f.tick} · frame ${tt.frame} · camera ${f.watched ?? f.layout} · ${f.verdict.toUpperCase()}`,
          lines: [`HUD (video|sim): ${hudLine || '-'}`, ...(failing.length === 0 ? [] : [`FAIL ${failing.join(' · ')}`])],
          dots: f.players.filter((p) => p.video !== null || p.sim !== null).map((p) => ({ id: p.id, colour: p.source === 'video-dot' || p.source === 'recording-observed' ? COLOUR[p.id] : 'ct', video: p.source === 'video-dot' || p.source === 'recording-observed' ? p.video : null, sim: p.sim, ok: p.verdict !== 'fail' })),
        });
      }
    }
    reports.push({ app: APP, run: name, frames, events: compareEvents(round, truth, sim.events) });
  }

  if (sheetSpec.length > 0) {
    const specPath = join(OUT, 'sheets-spec.json');
    writeFileSync(specPath, JSON.stringify({ radar: resolve(ROOT, 'data/mirage-radar.jpg'), entries: sheetSpec }));
    const r = spawnSync(PYTHON, ['-I', resolve(ROOT, 'tools/parity/sheets.py'), 'sheets', specPath], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('sheets.py failed');
    log(`contact sheets: ${sheetSpec.length} in ${relative(ROOT, sheetDir)}`);
  }

  const summaries = reports.map(summarize);
  const date = new Date().toISOString().slice(0, 10);
  const view = similarity.length === 0 ? null : similaritySummary(similarity);
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ app: APP, times, truthEvents: truth.events, summaries, view, similarity, reports }, null, 1));
  writeFileSync(join(OUT, 'summary.md'), summaryMarkdown(APP, date, summaries, reports) + (view === null ? '' : similarityMarkdown(view)));
  writeFileSync(join(OUT, 'index.html'), html(APP, reports, sheetsOf));
  for (const s of summaries) {
    log(`${s.run}: ${s.pass}/${s.timestamps} timestamps pass; radar ${s.radar.checks} checks, ${s.radar.fail} > 40 u, RMS ${s.radar.rms} u, worst ${s.radar.max} u (${s.radar.maxAt}); ` +
      `recording-observed ${s.recObserved.fail}/${s.recObserved.checks} > 40 u; inferred CTs ${s.inferred.fail}/${s.inferred.checks} outside radius; alive/dead ${s.status.fail}; HUD ${Object.entries(s.hud).map(([k, v]) => `${k} ${v.fail}/${v.checks}`).join(', ')}; events ${s.events.fail}/${s.events.checks} (worst ${s.events.worstOffset} ticks)`);
  }
  log(`index: ${relative(ROOT, join(OUT, 'index.html'))}`);
  if (WRITE_DOCS !== '') writeDocs(resolve(WRITE_DOCS), summaryMarkdown(APP, date, summaries, reports, true) + (view === null ? '' : similarityMarkdown(view)));

  let code = 0;
  if (BASELINE !== '') {
    const path = resolve(BASELINE);
    if (UPDATE_BASELINE || !existsSync(path)) {
      const base: Baseline = { app: APP, ...(view === null ? {} : { view }), runs: Object.fromEntries(reports.map((r, i) => [r.run, { summary: summaries[i] as (typeof summaries)[number], checks: checkKeys(r) }])) };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(base, null, 1) + '\n');
      log(`baseline written: ${relative(ROOT, path)}`);
    } else {
      const base = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
      const { regressed, fixed } = regressions(base, reports);
      log(`baseline ${relative(ROOT, path)}: ${fixed.length} checks fixed, ${regressed.length} regressed`);
      for (const x of regressed.slice(0, 40)) log(`  REGRESSED ${x.run} ${x.key}: ${x.was} -> ${x.now}`);
      if (regressed.length > 40) log(`  … ${regressed.length - 40} more (report.json)`);
      for (const x of fixed.slice(0, 20)) log(`  fixed ${x.run} ${x.key}`);
      if (regressed.length > 0) code = 1;
    }
  }
  process.exit(code);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
