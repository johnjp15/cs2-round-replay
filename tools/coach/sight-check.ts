/**
 * K6: timings, ground truth, radar-flag comparison, lobby table and spot checks of the sight tables
 * (docs/coach/sight.md). Prints Markdown; writes the details to logs/coach/sight-check.json.
 *
 *   npx tsx tools/coach/sight-check.ts [file.craw[.gz]] [--user 3] [--runs 3] [--no-truth] [--no-stress] [--evidence 4,9]
 *
 * 1. Timings: the sightings table for all pairs and for the user's pairs (best of --runs), with what is skipped.
 * 2. Ground truth: the same table at step 1 (every row), against the default step.
 * 3. Radar flags (`spottedBy`, `spotted`) against computed sight.
 * 4. Stress: the same pair geometry on the Inferno mesh (positions mapped affinely from Mirage's nav hull box onto
 *    Inferno's), so most segments run through real Inferno walls.
 * 5. The lobby table of every K6 metric (players A1…B5).
 * 6. Spot checks: ten sightings and ten duels across rounds, each recomputed independently at its rows with
 *    `LosWorld.visible` (all seven points, with smoke) and `inFov`, against the events at those ticks.
 * 7. With --evidence: every evidence moment of the K6 findings in those players' reports, checked the same way.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createContext, type AnalysisContext } from '../../src/coach/analyze/context';
import { analyze, computeLobby } from '../../src/coach/analyze/index';
import { median } from '../../src/coach/derive/aim/select';
import { angleToPoint, dirOf } from '../../src/coach/derive/aim/geom';
import { SHOTS } from '../../src/coach/derive/aim/shots';
import { LosWorld, SmokeField, inFov } from '../../src/coach/derive/los';
import { DUELS, FIRSTS, SEE, SIGHTINGS, buildSightings, compareRadar, smokeDetonations, type SightTable } from '../../src/coach/derive/sight/index';
import { placementSights } from '../../src/coach/derive/sight/select';
import { ingestMatch } from '../../src/coach/ingest/index';
import { ALL_METRICS } from '../../src/coach/metrics/index';
import { decodeRawDemo } from '../../src/coach/model/raw-codec';
import type { RawDemo } from '../../src/coach/model/raw';
import { playerLabel, roundClock } from '../../src/coach/report/format';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT = '/home/claude/coach-data/cache/84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2.craw';

function loadRaw(f: string): RawDemo {
  const buf = readFileSync(f);
  return decodeRawDemo(f.endsWith('.gz') ? gunzipSync(buf) : buf);
}
function loadWorld(map: string): LosWorld {
  return LosWorld.fromBytes(new Uint8Array(gunzipSync(readFileSync(resolve(ROOT, `data/coach/maps/${map}/los.bin.gz`)))));
}
function hullBox(map: string): { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number } {
  const p = JSON.parse(readFileSync(resolve(ROOT, `data/coach/maps/${map}/pack.json`), 'utf8')) as { los: { cull: { hull: [number, number][]; zMin: number; zMax: number } } };
  const xs = p.los.cull.hull.map((h) => h[0]);
  const ys = p.los.cull.hull.map((h) => h[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z0: p.los.cull.zMin, z1: p.los.cull.zMax };
}

function best(runs: number, f: () => void): number {
  let b = Infinity;
  for (let k = 0; k < runs; k++) {
    const t0 = performance.now();
    f();
    b = Math.min(b, performance.now() - t0);
  }
  return b;
}

const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : '–');
const pctS = (a: number, b: number): string => (b === 0 ? '–' : `${((100 * a) / b).toFixed(1)} %`);

/** Independent recompute at row r: any point visible (with smoke), head visible, some visible point in view. */
function recompute(ctx: AnalysisContext, smoke: SmokeField, r: number, o: number, t: number): { los: boolean; head: boolean; inView: boolean; dist: number } {
  const los = ctx.los as LosWorld;
  const T = ctx.raw.ticks;
  const P = ctx.P;
  const i = r * P + o;
  const j = r * P + t;
  const eye = los.eyePosition({ x: T.x[i] ?? 0, y: T.y[i] ?? 0, z: T.z[i] ?? 0 }, (T.duck[i] ?? 0) / 255);
  const tgt = { x: T.x[j] ?? 0, y: T.y[j] ?? 0, z: T.z[j] ?? 0, yaw: T.yaw[j] ?? 0, duck: (T.duck[j] ?? 0) / 255 };
  const v = los.visible(eye, tgt, smoke, T.tick[r] ?? 0);
  let inView = false;
  for (let k = 0; k < 7; k++) if ((v.mask & (1 << k)) !== 0 && inFov(T.yaw[i] ?? 0, T.pitch[i] ?? 0, eye, los.bodyPoint(tgt, k))) inView = true;
  return { los: v.any, head: v.head, inView, dist: Math.round(Math.hypot(tgt.x - eye.x, tgt.y - eye.y, tgt.z - eye.z)) };
}

function main(argv: readonly string[]): void {
  let file = DEFAULT;
  let user = 3;
  let runs = 3;
  let truth = true;
  let stress = true;
  const evidenceFor: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--user') user = Number(argv[++i]);
    else if (a === '--runs') runs = Number(argv[++i]);
    else if (a === '--no-truth') truth = false;
    else if (a === '--no-stress') stress = false;
    else if (a === '--evidence') evidenceFor.push(...(argv[++i] ?? '').split(',').map(Number));
    else file = a;
  }
  const raw = loadRaw(file);
  const match = ingestMatch(raw);
  const world = loadWorld(raw.header.map);
  const ctx = createContext(raw, match, { los: world });
  const L = (p: number): string => playerLabel(match, p);
  const out: Record<string, unknown> = {};
  const T = raw.ticks;
  const P = ctx.P;
  const rate = raw.header.tickRate || 64;
  const played = match.rounds.filter((r) => r.played);
  const liveRows = played.reduce((s, r) => s + (r.rowEnd - (r.freezeEndTick === null ? r.rowEnd : rowOf(raw, r.freezeEndTick))), 0);
  const freezeRows = played.reduce((s, r) => s + ((r.freezeEndTick === null ? r.rowEnd : rowOf(raw, r.freezeEndTick)) - r.rowStart), 0);
  const scale = 24 / played.length;

  // 1. Timings
  let all: SightTable = buildSightings(ctx);
  const msAll = best(runs, () => (all = buildSightings(ctx)));
  let mine: SightTable = buildSightings(ctx, { slots: [user] });
  const msUser = best(runs, () => (mine = buildSightings(ctx, { slots: [user] })));
  const s = all.stats;
  console.log(`## Timings (${raw.header.map}, ${played.length} played rounds, ${T.count} rows, best of ${runs})\n`);
  console.log('| | ms | ms × 24/' + played.length + ' (full match) | pair-rows | live | dead | far | evaluated | segment tests | smokes flooded |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [name, ms, st] of [['all pairs', msAll, s], [`user (${L(user)}) pairs`, msUser, mine.stats]] as const) {
    console.log(`| ${name} | ${ms.toFixed(0)} | ${(ms * scale).toFixed(0)} | ${st.pairRows} | ${pctS(st.liveRows, st.pairRows)} | ${pctS(st.deadRows, st.pairRows)} | ${pctS(st.farRows, st.pairRows)} | ${st.evaluated} | ${st.segmentTests} | ${st.smokeFloods} |`);
  }
  console.log(`\nFreeze time: ${freezeRows} of ${freezeRows + liveRows} round rows (${pctS(freezeRows, freezeRows + liveRows)}) are never evaluated. Segment tests per second (all pairs): ${(s.segmentTests / (msAll / 1000) / 1e6).toFixed(2)} M.`);
  out['timings'] = { msAll, msUser, stats: s, userStats: mine.stats, freezeRows, liveRows };

  // 2. Ground truth
  if (truth) {
    const t0 = performance.now();
    const g = buildSightings(ctx, { step: 1 });
    const msTruth = performance.now() - t0;
    let seenG = 0;
    let seenA = 0;
    let diff = 0;
    let losDiff = 0;
    let maxLos = 0;
    for (let k = 0; k < g.state.length; k++) {
      const a = all.state[k] ?? 0;
      const b = g.state[k] ?? 0;
      if (b & SEE.seen) seenG++;
      if (a & SEE.seen) seenA++;
      if ((a ^ b) & SEE.seen) diff++;
      if ((a ^ b) & SEE.los) losDiff++;
      if (b & SEE.los) {
        const r = Math.floor(k / (P * P));
        const o = Math.floor(k / P) % P;
        const t = k % P;
        const i = r * P + o;
        const j = r * P + t;
        maxLos = Math.max(maxLos, Math.hypot((T.x[i] ?? 0) - (T.x[j] ?? 0), (T.y[i] ?? 0) - (T.y[j] ?? 0), (T.z[i] ?? 0) - (T.z[j] ?? 0)));
      }
    }
    const key = (x: { obs: number; tgt: number; r0: number }): string => `${x.obs},${x.tgt},${x.r0}`;
    const ka = new Set(all.sightings.map(key));
    const missed = g.sightings.filter((x) => !ka.has(key(x)));
    const short = missed.filter((x) => x.r1 - x.r0 + 1 < 8).length;
    // Duels: first sights from the step-8 table against the step-1 table (a context with the truth table).
    const ctxT = createContext(raw, match, { los: world });
    ctxT.table({ id: SIGHTINGS.id, build: () => g });
    const dA = ctx.table(DUELS).duels;
    const dT = ctxT.table(DUELS).duels;
    const firstDiff: number[] = [];
    let matched = 0;
    for (const d of dT) {
      const m = dA.find((x) => x.a.p === d.a.p && x.b.p === d.b.p && x.round === d.round && Math.abs(x.tick0 - d.tick0) <= rate);
      if (m === undefined) continue;
      matched++;
      for (const [u, v] of [[d.a, m.a], [d.b, m.b]] as const) if (u.sightTick !== null && v.sightTick !== null) firstDiff.push(Math.abs(u.sightTick - v.sightTick));
    }
    console.log(`\n## Step 8 against every row (ground truth, ${msTruth.toFixed(0)} ms)\n`);
    console.log(`- seen pair-rows: ${seenA} at step 8, ${seenG} at step 1; ${diff} differ (${pctS(diff, seenG)} of the true seen rows); line-of-sight rows differing: ${losDiff}`);
    console.log(`- sightings: ${all.sightings.length} at step 8, ${g.sightings.length} at step 1; ${missed.length} true sightings do not start on the same row at step 8, ${short} of them shorter than 8 rows (lengths ${missed.map((x) => x.r1 - x.r0 + 1).sort((a, b) => a - b).join(', ')})`);
    console.log(`- duels: ${dA.length} at step 8, ${dT.length} at step 1, ${matched} matched; first-sight ticks equal in ${firstDiff.filter((x) => x === 0).length} of ${firstDiff.length} sides, median |Δ| ${median(firstDiff)} ticks, max ${Math.max(0, ...firstDiff)}`);
    console.log(`- longest line of sight between live enemies: ${maxLos.toFixed(0)} units (maxDistance ${4500})`);
    out['truth'] = { msTruth, seenA, seenG, diff, losDiff, sightingsA: all.sightings.length, sightingsG: g.sightings.length, missed: missed.length, short, duelsA: dA.length, duelsT: dT.length, matched, firstDiff, maxLos };
  }

  // 3. Radar
  const rc = compareRadar(ctx, all);
  const conf = (c: { both: number; sightOnly: number; radarOnly: number; neither: number }): string => {
    const sight = c.both + c.sightOnly;
    const radar = c.both + c.radarOnly;
    return `${c.both} | ${c.sightOnly} | ${c.radarOnly} | ${pctS(c.both, sight)} | ${pctS(c.both, radar)}`;
  };
  console.log('\n## Radar flags against computed sight\n');
  console.log('| radar flag | against | both | sight only | radar only | sight rows flagged | flagged rows with sight |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  console.log(`| spottedBy (per observer) | seen | ${conf(rc.seen)} |`);
  console.log(`| spottedBy (per observer) | line of sight | ${conf(rc.los)} |`);
  console.log(`| spotted (per target) | some enemy sees him | ${conf(rc.spottedSeen)} |`);
  console.log(`| spotted (per target) | some enemy has line of sight | ${conf(rc.spottedLos)} |`);
  console.log(`\n- sighting start → spottedBy set: median ${f1(rc.start.medianMs)} ms (p10 ${f1(rc.start.p10Ms)}, p90 ${f1(rc.start.p90Ms)}) over ${rc.start.n}; ${rc.start.none} sightings never flagged within ±2 s`);
  console.log(`- sightings of ≥ 1 s flagged: ${rc.long.flagged} of ${rc.long.n}`);
  console.log(`- sighting end → spottedBy clear: median ${f1(rc.end.medianMs)} ms (p10 ${f1(rc.end.p10Ms)}, p90 ${f1(rc.end.p90Ms)}) over ${rc.end.n} flagged sightings; ${rc.end.none} not cleared within 2 s`);
  console.log(`- radar bit with line of sight but outside the view: ${rc.radarLosNotInView} pair-rows`);
  out['radar'] = rc;

  // 4. Stress on Inferno
  if (stress) {
    const inf = loadWorld('de_inferno');
    const a = hullBox(raw.header.map);
    const b = hullBox('de_inferno');
    const mapped: RawDemo = { ...raw, ticks: { ...T, x: new Float32Array(T.x), y: new Float32Array(T.y), z: new Float32Array(T.z) }, events: { ...raw.events, detonations: raw.events.detonations.map((d) => ({ ...d })) } };
    const fx = (x: number): number => b.x0 + ((x - a.x0) * (b.x1 - b.x0)) / (a.x1 - a.x0);
    const fy = (y: number): number => b.y0 + ((y - a.y0) * (b.y1 - b.y0)) / (a.y1 - a.y0);
    const fz = (z: number): number => b.z0 + ((z - a.z0) * (b.z1 - b.z0)) / (a.z1 - a.z0);
    for (let k = 0; k < mapped.ticks.x.length; k++) {
      mapped.ticks.x[k] = fx(T.x[k] ?? 0);
      mapped.ticks.y[k] = fy(T.y[k] ?? 0);
      mapped.ticks.z[k] = fz(T.z[k] ?? 0);
    }
    for (const d of mapped.events.detonations) {
      d.x = fx(d.x);
      d.y = fy(d.y);
      d.z = fz(d.z);
    }
    const ctxI = createContext(mapped, match, { los: inf });
    let st = buildSightings(ctxI);
    const msInf = best(Math.min(runs, 2), () => (st = buildSightings(ctxI)));
    let stU = buildSightings(ctxI, { slots: [user] });
    const msInfU = best(Math.min(runs, 2), () => (stU = buildSightings(ctxI, { slots: [user] })));
    console.log('\n## Stress: the same pair geometry on the Inferno mesh\n');
    console.log('| | ms | ms × full match | evaluated | segment tests | M tests/s | live pair-rows with line of sight |');
    console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    const losShare = (tab: SightTable): string => {
      let n = 0;
      let l = 0;
      for (const v of tab.state) {
        if ((v & SEE.eval) === 0) continue;
        n++;
        if (v & SEE.los) l++;
      }
      return pctS(l, n);
    };
    console.log(`| all pairs | ${msInf.toFixed(0)} | ${(msInf * scale).toFixed(0)} | ${st.stats.evaluated} | ${st.stats.segmentTests} | ${(st.stats.segmentTests / msInf / 1000).toFixed(2)} | ${losShare(st)} |`);
    console.log(`| user pairs | ${msInfU.toFixed(0)} | ${(msInfU * scale).toFixed(0)} | ${stU.stats.evaluated} | ${stU.stats.segmentTests} | ${(stU.stats.segmentTests / msInfU / 1000).toFixed(2)} | ${losShare(stU)} |`);
    console.log(`\n(Mirage for comparison: live pair-rows with line of sight ${losShare(all)}.)`);
    out['stress'] = { msInf, msInfU, stats: st.stats, userStats: stU.stats };
  }

  // 5. Lobby table
  const lobby = computeLobby(ctx, ALL_METRICS.filter((m) => /^(aim\.(placement|time_to_damage|habits)|pos\.death_context)\./.test(m.id)));
  const slots = match.players.map((p) => p.slot).sort((x, y) => L(x).localeCompare(L(y)));
  console.log('\n## Lobby table\n');
  console.log(`| metric | ${slots.map(L).join(' | ')} |`);
  console.log(`| --- | ${slots.map(() => '---:').join(' | ')} |`);
  const fmt = (v: number, unit: string): string => (!Number.isFinite(v) ? '–' : unit === '%' ? `${(v * 100).toFixed(0)} %` : unit === 'deg' ? `${v.toFixed(1)}°` : unit === 'ms' ? `${v.toFixed(0)}` : `${v}`);
  for (const m of lobby) console.log(`| \`${m.def.id}\` (${m.def.unit}) | ${slots.map((p) => `${fmt(m.values[p] ?? NaN, m.def.unit)} (${m.n[p] ?? 0})`).join(' | ')} |`);
  const signed = (k: 'up' | 'right'): string => slots.map((p) => f1(median(placementSights(ctx, p).map((x) => x[k])))).join(' | ');
  console.log(`| signed vertical (+ = crosshair low) | ${signed('up')} |`);
  console.log(`| signed horizontal (+ = enemy right of it) | ${signed('right')} |`);
  // Leetify's own "first seen" is any visible part of the body, with no field of view: the same figure measured from
  // the first row of the line of sight that runs into our first sight.
  const shotsTab = ctx.table(SHOTS).shots;
  const losVariant = (p: number): number => {
    const moved: number[] = [];
    for (const x of placementSights(ctx, p)) {
      if (x.moved === null || x.damageMs === null) continue;
      let r = x.row;
      while (r > 0 && ((all.state[((r - 1) * P + p) * P + x.enemy] ?? 0) & SEE.los) !== 0) r--;
      const dmgTick = x.tick + Math.round(x.damageMs / (1000 / rate));
      const shot = shotsTab.find((sh) => sh.p === p && sh.tick === dmgTick);
      if (shot === undefined) continue;
      moved.push(angleToPoint([0, 0, 0], dirOf(T.pitch[r * P + p] ?? 0, T.yaw[r * P + p] ?? 0), dirOf(shot.viewPitch, shot.viewYaw)));
    }
    return median(moved);
  };
  console.log(`| Leetify-style from the first line of sight (no field of view) | ${slots.map((p) => `${f1(losVariant(p))}°`).join(' | ')} |`);
  out['lobby'] = lobby.map((m) => ({ id: m.def.id, values: m.values, n: m.n }));

  // 6. Spot checks
  const smoke = new SmokeField(world, smokeDetonations(ctx));
  const sightings = all.sightings;
  const picks: typeof sightings[number][] = [];
  for (const r of played) {
    const inR = sightings.filter((x) => x.round === r.number && x.r1 - x.r0 >= 16).sort((x, y) => (y.r1 - y.r0) - (x.r1 - x.r0) || x.tick0 - y.tick0);
    const pick = inR[Math.floor(inR.length / 2)];
    if (pick) picks.push(pick);
  }
  const shortest = [...sightings].sort((x, y) => (x.r1 - x.r0) - (y.r1 - y.r0) || x.tick0 - y.tick0)[0];
  if (shortest && !picks.includes(shortest)) picks.push(shortest);
  console.log('\n## Spot checks: sightings\n');
  console.log('Each row: the table says the observer sees the target from tick0 to tick1. Recomputed independently (all seven points, with smoke, `inFov`) at the row before tick0, at tick0 and at tick1, and the radar bit at tick0 + 0.5 s.\n');
  console.log('| round, clock | observer → target | ticks | places | distance | before: los / view | tick0: los / head / view | tick1: view | angle off at tick0 | radar | ok |');
  console.log('| --- | --- | --- | --- | ---: | --- | --- | --- | ---: | --- | --- |');
  const checks: unknown[] = [];
  const firsts = ctx.table(FIRSTS);
  for (const g of picks.slice(0, 10)) {
    const before = recompute(ctx, smoke, g.r0 - 1, g.obs, g.tgt);
    const at = recompute(ctx, smoke, g.r0, g.obs, g.tgt);
    const end = recompute(ctx, smoke, g.r1, g.obs, g.tgt);
    const blindBefore = all.blind[(g.r0 - 1) * P + g.obs] === 1;
    const okStart = at.los && at.inView && (!before.inView || blindBefore || ((all.state[((g.r0 - 1) * P + g.obs) * P + g.tgt] ?? 0) & SEE.eval) === 0);
    const ok = okStart && end.inView;
    const radar = (((T.spottedBy[Math.min(T.count - 1, g.r0 + 32) * P + g.tgt] ?? 0) >> g.obs) & 1) === 1;
    const fs = (firsts.bySlot[g.obs] ?? []).find((x) => x.row === g.r0 && x.enemy === g.tgt);
    const place = (p: number, r: number): string => raw.names.places[T.place[r * P + p] ?? 0] ?? '';
    console.log(`| ${roundClock(match, g.tick0)} | ${L(g.obs)} → ${L(g.tgt)} | ${g.tick0}–${g.tick1} | ${place(g.obs, g.r0)} → ${place(g.tgt, g.r0)} | ${at.dist} | ${before.los ? 'y' : 'n'} / ${before.inView ? 'y' : 'n'}${blindBefore ? ' (blind)' : ''} | ${at.los ? 'y' : 'n'} / ${at.head ? 'y' : 'n'} / ${at.inView ? 'y' : 'n'} | ${end.inView ? 'y' : 'n'} | ${fs ? `${fs.angle.toFixed(1)}°` : '(not a duel start)'} | ${radar ? 'on' : 'off'} | ${ok ? 'yes' : 'NO'} |`);
    checks.push({ g, before, at, end, ok, radar });
  }
  const duels = ctx.table(DUELS).duels;
  const dPicks: typeof duels[number][] = [];
  for (const r of played) {
    const inR = duels.filter((d) => d.round === r.number);
    const k = inR.find((d) => d.outcome === 'kill');
    if (k) dPicks.push(k);
  }
  for (const want of ['disengaged', 'other'] as const) {
    const d = duels.find((x) => x.outcome === want && !dPicks.includes(x));
    if (d) dPicks.push(d);
  }
  console.log('\n## Spot checks: duels\n');
  console.log('Each row: the duel table, then the events at those ticks: the kill event (attacker → victim, weapon), the bullets of each side at the other and the hurts between them inside the duel window, recounted from `raw.events`.\n');
  console.log('| round, clock | a vs b | sight a / b | first shot a / b | first damage a / b | damage a→b / b→a | outcome | kill event | bullets a→b / b→a (events) | ok |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const dChecks: unknown[] = [];
  for (const d of dPicks.slice(0, 10)) {
    const w0 = d.tick0 - Math.round(0.5 * rate);
    const w1 = d.killTick ?? d.tick1 + rate;
    const k = raw.events.kills.find((x) => x.tick >= d.tick0 && x.tick <= d.tick1 + rate && ((x.attacker === d.a.p && x.victim === d.b.p) || (x.attacker === d.b.p && x.victim === d.a.p)));
    const hurtSum = (from: number, to: number): number => {
      let sum = 0;
      for (const h of ctx.raw.events.hurts) if (h.tick >= w0 && h.tick <= w1 && h.attacker === from && h.victim === to) sum++;
      return sum;
    };
    const bullets = (from: number): number => raw.events.bullets.filter((b) => b.p === from && b.tick >= w0 && b.tick <= w1).length;
    const ok = (d.outcome === 'kill') === (k !== undefined) && (k === undefined || k.attacker === d.winner) && (d.a.damage > 0) === (hurtSum(d.a.p, d.b.p) > 0) && (d.b.damage > 0) === (hurtSum(d.b.p, d.a.p) > 0) && d.a.shots <= bullets(d.a.p) && d.b.shots <= bullets(d.b.p);
    const t = (x: number | null): string => (x === null ? '–' : String(x));
    console.log(`| ${roundClock(match, d.tick0)} | ${L(d.a.p)} vs ${L(d.b.p)} | ${t(d.a.sightTick)} / ${t(d.b.sightTick)} | ${t(d.a.shotTick)} / ${t(d.b.shotTick)} | ${t(d.a.damageTick)} / ${t(d.b.damageTick)} | ${d.a.damage} / ${d.b.damage} | ${d.outcome}${d.winner >= 0 ? ` (${L(d.winner)})` : ''} | ${k ? `${k.tick}: ${L(k.attacker)} → ${L(k.victim)} ${k.weapon}${k.headshot ? ' HS' : ''}` : 'none'} | ${d.a.shots}/${bullets(d.a.p)} · ${d.b.shots}/${bullets(d.b.p)} | ${ok ? 'yes' : 'NO'} |`);
    dChecks.push({ d, k, ok });
  }
  out['spot'] = { sightings: checks, duels: dChecks };

  // 7. Every evidence moment of the K6 findings in the reports of the --evidence players.
  const evUsers = evidenceFor.length > 0 ? evidenceFor : [];
  const evOut: unknown[] = [];
  for (const u of evUsers) {
    const rep = analyze(raw, match, { user: u, los: world });
    const mine = rep.findings.filter((f) => /^(aim\.(placement|time_to_damage|habits)|pos\.death_context)\./.test(f.id));
    console.log(`\n## Evidence checks: ${L(u)}\n`);
    console.log('| finding | polarity | moment | caption | independent check | ok |');
    console.log('| --- | --- | --- | --- | --- | --- |');
    for (const f of mine) {
      for (const e of f.evidence) {
        const r = rowOf(raw, e.focus);
        let check = '';
        let ok = false;
        const other = e.players.find((p) => p !== u) ?? -1;
        if (f.id.startsWith('aim.placement') || f.id.startsWith('aim.time_to_damage')) {
          const now = recompute(ctx, smoke, r, u, other);
          const prev = recompute(ctx, smoke, r - 1, u, other);
          const blindNow = all.blind[r * P + u] === 1;
          const fs = (firsts.bySlot[u] ?? []).find((x) => x.tick === e.focus && x.enemy === other);
          const labelAng = e.annotations.find((a) => a.kind === 'label');
          ok = now.los && now.inView && !blindNow && fs !== undefined;
          check = `${L(u)} sees ${L(other)} at ${e.focus}: los ${now.los ? 'y' : 'n'}, view ${now.inView ? 'y' : 'n'} (row before: view ${prev.inView ? 'y' : 'n'}); ${fs ? `angle ${fs.angle.toFixed(1)}°, ttd ${fs.damageMs ?? '–'} ms, outcome ${fs.outcome}` : 'no first sight'}${labelAng && labelAng.kind === 'label' ? ` · label "${labelAng.text}"` : ''}`;
          if (f.id.startsWith('aim.time_to_damage') && fs !== undefined && fs.damageMs !== null) {
            const h = raw.events.hurts.find((x) => x.attacker === u && x.victim === other && x.tick === e.focus + Math.round((fs.damageMs as number) / (1000 / rate)));
            check += h ? ` · hurt event at ${h.tick} (${h.weapon}, ${h.hitgroup})` : ' · NO hurt event at the damage tick';
            ok &&= h !== undefined;
          }
        } else if (f.id.startsWith('pos.death_context')) {
          const k = raw.events.kills.find((x) => x.tick === e.focus && x.victim === u);
          let sawKiller = false;
          if (k) for (let rr = rowOf(raw, e.focus - 3 * rate); rr < r; rr++) { const v = recompute(ctx, smoke, rr, u, k.attacker); if (v.los && v.inView && all.blind[rr * P + u] !== 1) sawKiller = true; }
          const seers = k ? match.players.filter((pl) => pl.team !== match.players[u]?.team).filter((pl) => { const v = recompute(ctx, smoke, r - 1, pl.slot, u); return v.los && v.inView && all.blind[(r - 1) * P + pl.slot] !== 1; }).map((pl) => L(pl.slot)) : [];
          ok = k !== undefined && (!f.id.endsWith('.unseen') || !sawKiller);
          check = k ? `kill event ${k.tick}: ${L(k.attacker)} → ${L(u)} ${k.weapon}; ${L(u)} saw the killer in the 3 s before: ${sawKiller ? 'yes' : 'no'}; enemies seeing ${L(u)} the row before: ${seers.join(', ') || 'none'}` : 'NO kill event at the focus tick';
        } else if (f.id === 'aim.habits.airborne' || f.id === 'aim.habits.flashed') {
          const b = raw.events.bullets.find((x) => x.p === u && x.tick === e.focus);
          const rr = rowOf(raw, e.focus);
          const air = ((T.flags[rr * P + u] ?? 0) & 0x8) !== 0;
          const blind = all.blind[(rr - 1) * P + u] === 1;
          ok = b !== undefined && (f.id.endsWith('airborne') ? air : blind);
          check = b ? `bullet ${b.weapon} at ${b.tick}; airborne flag ${air ? 'y' : 'n'}; flash column ${(T.flash[(rr - 1) * P + u] ?? 0).toFixed(2)} s, blind ${blind ? 'y' : 'n'}` : 'NO bullet at the focus tick';
        } else if (f.id === 'aim.habits.scoped_moving') {
          const rr = rowOf(raw, e.focus);
          const flags = T.flags[rr * P + u] ?? 0;
          const sp = Math.hypot(T.vx[(rr + 1) * P + u] ?? 0, T.vy[(rr + 1) * P + u] ?? 0);
          ok = (flags & 0x2) !== 0 && sp > 34;
          check = `row ${rr}: ${raw.names.weapons[T.weapon[rr * P + u] ?? 0]}, scoped ${(flags & 0x2) !== 0 ? 'y' : 'n'}, speed ${sp.toFixed(0)} units/s`;
        } else if (f.id === 'aim.habits.repeek') {
          const v = recompute(ctx, smoke, r, other, u);
          ok = v.los && v.inView;
          check = `${L(other)} sees ${L(u)} at ${e.focus}: ${v.los && v.inView ? 'yes' : 'no'}`;
        }
        console.log(`| \`${f.id}\` | ${f.polarity} | ${roundClock(match, e.focus)} (${e.focus}) | ${e.caption.replace(/\|/g, '/')} | ${check} | ${ok ? 'yes' : 'NO'} |`);
        evOut.push({ user: u, finding: f.id, focus: e.focus, ok, check });
      }
    }
  }
  out['evidence'] = evOut;
  mkdirSync(resolve(ROOT, 'logs/coach'), { recursive: true });
  writeFileSync(resolve(ROOT, 'logs/coach/sight-check.json'), JSON.stringify(out, null, 1));
}

function rowOf(raw: RawDemo, tick: number): number {
  let lo = 0;
  let hi = raw.ticks.count;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if ((raw.ticks.tick[m] ?? 0) < tick) lo = m + 1;
    else hi = m;
  }
  return lo;
}

main(process.argv.slice(2));
