/**
 * Ghost round: the whole recorded round with no human. ReplayCore drives all ten pawns
 * as puppets in Sim2DHost, and each pawn's path is measured against the raw recording.
 * Each pawn is measured up to its recorded death tick (with B3 it also dies there) and
 * is no longer driven once its track (plus the hold) ends. The same run, with B3's
 * scripted events checked (kills, HP, shots), is `npm run scripted` (tools/scripted-round.ts).
 *
 *   npm run ghost        # writes logs/ghost-round.jsonl and logs/ghost-trace.json, prints the table
 *
 * tests/ghost-round.test.ts runs the same thing and asserts on it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PLAYER_IDS,
  SessionLog,
  canonicalize,
  parseRound,
  parseTuning,
  stableStringify,
  toReplayTrace,
  type Act,
  type Control,
  type ICore,
  type Observe,
  type PlayerId,
  type RoundData,
  type Team,
  type Tuning,
  type Vec3,
} from '../src/contracts/index';
import { EventSchedule, ReplayCore, RoundModel, describeEvent, type PuppetTrack } from '../src/core/index';
import { NavMesh, navOptionsFromTuning } from '../src/sim2d/nav';
import { Sim2DHost } from '../src/sim2d/host';
import { VisMask, visOptionsFromTuning } from '../src/sim2d/vision';
import { NavWalkQuery } from '../src/sim2d/walk-query';
import { writeSessionLog } from './session-log-io';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const GHOST_SEED = 2;
/** A pawn is "behind" when more than this far (units, 2D) from its recorded position. Same as replay.driftNudgeUnits. */
const BEHIND_UNITS = 24;

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8')) as unknown;
}

export interface GhostInputs {
  readonly round: RoundData;
  readonly tuning: Tuning;
  readonly nav: NavMesh;
  /** The sight mask (C4), as the Session loads it. */
  readonly vision: VisMask;
}

export function loadGhostInputs(): GhostInputs {
  const tuning = parseTuning(readJson('data/tuning.json'));
  return {
    round: parseRound(readJson('data/round.json')),
    tuning,
    nav: NavMesh.fromJson(readJson('data/mirage-nav.json'), navOptionsFromTuning(tuning)),
    vision: VisMask.fromJson(readJson('data/mirage-vismask.json'), visOptionsFromTuning(tuning.ai)),
  };
}

/** A host the driver can advance: IHost plus the 2D sim's tick(). */
interface TickingHost {
  observe(): Observe;
  apply(act: Act): void;
  tick(): void;
}

/**
 * Driver loop for an engine whose clock the driver owns: observe (canonical) → controls →
 * core.step → log → host.apply → host.tick, `ticks` times. `onApplied` runs after each
 * apply, before the tick (the actions, e.g. teleports, are in effect; the move is not).
 */
export function drive(
  host: TickingHost,
  core: ICore,
  ticks: number,
  controlsAt: ReadonlyMap<number, readonly Control[]> = new Map(),
  onApplied: (o: Observe, a: Act) => void = () => undefined,
): SessionLog {
  const log = new SessionLog();
  for (let i = 0; i < ticks; i++) {
    const o = canonicalize(host.observe());
    const controls = controlsAt.get(o.tick) ?? [];
    for (const c of controls) core.control(c);
    const a = core.step(o);
    log.append(o, a, controls);
    host.apply(a);
    onApplied(o, a);
    host.tick();
  }
  return log;
}

export interface Snap {
  readonly id: PlayerId;
  readonly tick: number;
}

export interface GhostRun {
  readonly inputs: GhostInputs;
  readonly model: RoundModel;
  readonly core: ReplayCore;
  /** The engine after the last tick (for its `unhandled()` notes and `combatLog()`). */
  readonly host: Sim2DHost;
  readonly log: SessionLog;
  readonly ticks: number;
  /** positions[tick][i] = pawn PLAYER_IDS[i] at `tick`, after that tick's actions (setup, snaps) and before its move. */
  readonly positions: readonly (readonly Vec3[])[];
  /** Puppet snaps (teleports after the setup tick), in order. */
  readonly snaps: readonly Snap[];
  /** Body blocks (C3 collision): a pawn whose move on `tick` an enemy cut short (`host.blockedBy`), in order. */
  readonly bodyBlocks: readonly BodyBlock[];
}

export interface BodyBlock {
  readonly id: PlayerId;
  /** The engine tick whose move was cut. */
  readonly tick: number;
  readonly by: PlayerId;
}

/** Ticks to run: one past the latest track end plus the hold, so every sample can be interpolated. */
export function ghostTicks(model: RoundModel, tuning: Tuning): number {
  let end = 0;
  for (const id of PLAYER_IDS) end = Math.max(end, (model.track(id).at(-1) as { tick: number }).tick);
  return end + Math.round(tuning.replay.holdLastPositionSec * 64) + 2;
}

export function runGhostRound(inputs: GhostInputs = loadGhostInputs(), ticks: number | null = null): GhostRun {
  const { round, tuning, nav, vision } = inputs;
  const model = new RoundModel(round);
  const core = new ReplayCore(model, new EventSchedule(round), tuning, GHOST_SEED, new NavWalkQuery(nav));
  // Like the Session: the round's score before it (CT 11 – T 15), its clock at t = 0 (98.25 s), the sight mask and the seed.
  const host = new Sim2DHost(
    nav,
    tuning,
    model.players.map((p) => ({ id: p.id, team: p.team })),
    { score: round.meta.score, roundTimeSec: round.meta.clock0 },
    { mask: vision, seed: GHOST_SEED },
  );
  host.setHuman(null);
  const n = ticks ?? ghostTicks(model, tuning);
  const positions: Vec3[][] = [];
  const snaps: Snap[] = [];
  const bodyBlocks: BodyBlock[] = [];
  const log = drive(host, core, n, new Map([[0, [{ type: 'start' }]]]), (o, a) => {
    positions.push(host.observe().pawns.map((p) => p.pos));
    if (o.tick === 0) return;
    // blockedBy describes the previous tick's move (this tick's move hasn't run yet).
    for (const id of PLAYER_IDS) {
      const by = host.blockedBy(id);
      if (by !== null) bodyBlocks.push({ id, tick: o.tick - 1, by });
    }
    for (const x of a.actions) if (x.type === 'teleport') snaps.push({ id: x.id, tick: o.tick });
  });
  return { inputs, model, core, host, log, ticks: n, positions, snaps, bodyBlocks };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface ErrorStats {
  readonly samples: number;
  readonly rms: number;
  readonly max: number;
  /** t of the max error (s), or null without samples. */
  readonly maxT: number | null;
}

export interface GhostRow {
  readonly id: PlayerId;
  readonly team: Team;
  readonly observed: ErrorStats;
  /** Estimated and inferred samples. */
  readonly other: ErrorStats;
  /** Inferred samples only (the CT target). */
  readonly inferred: ErrorStats;
  /** Smallest / largest uncertainty radius over the inferred samples, or null. */
  readonly radiusMin: number | null;
  readonly radiusMax: number | null;
  readonly snaps: readonly number[];
  /** % of measured ticks more than BEHIND_UNITS from the raw recording. */
  readonly behindPct: number;
  /** Last measured tick (recorded death tick, or the track's last sample). */
  readonly lastTick: number;
}

function stats(errs: readonly { t: number; e: number }[]): ErrorStats {
  let sum = 0;
  let max = 0;
  let maxT: number | null = null;
  for (const x of errs) {
    sum += x.e * x.e;
    if (maxT === null || x.e > max) {
      max = x.e;
      maxT = x.t;
    }
  }
  return { samples: errs.length, rms: errs.length === 0 ? 0 : Math.sqrt(sum / errs.length), max, maxT };
}

/** Pawn position at video time t (linear between the two ticks around it). */
function pawnAt(run: GhostRun, idx: number, t: number): Vec3 {
  const f = t * 64;
  const k0 = Math.min(run.positions.length - 1, Math.floor(f));
  const k1 = Math.min(run.positions.length - 1, k0 + 1);
  const a = (run.positions[k0] as Vec3[])[idx] as Vec3;
  const b = (run.positions[k1] as Vec3[])[idx] as Vec3;
  const u = f - k0;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u };
}

export function measureGhost(run: GhostRun): GhostRow[] {
  const rows: GhostRow[] = [];
  PLAYER_IDS.forEach((id, idx) => {
    const p = run.model.player(id);
    const samples = run.model.track(id);
    const death = p.deathTick;
    const last = samples[samples.length - 1] as { tick: number };
    const lastTick = death === null ? last.tick : Math.min(death, last.tick);
    const obs: { t: number; e: number }[] = [];
    const other: { t: number; e: number }[] = [];
    const inf: { t: number; e: number }[] = [];
    let rMin: number | null = null;
    let rMax: number | null = null;
    for (const s of samples) {
      if (s.tick > lastTick) break;
      const q = pawnAt(run, idx, s.t);
      const e = Math.hypot(q.x - s.x, q.y - s.y);
      if (s.confidence === 'observed') obs.push({ t: s.t, e });
      else other.push({ t: s.t, e });
      if (s.confidence === 'inferred') {
        inf.push({ t: s.t, e });
        const u = s.uncertainty ?? null;
        if (u !== null) {
          rMin = rMin === null ? u : Math.min(rMin, u);
          rMax = rMax === null ? u : Math.max(rMax, u);
        }
      }
    }
    let behind = 0;
    let measured = 0;
    for (let k = (samples[0] as { tick: number }).tick; k <= lastTick && k < run.positions.length; k++) {
      const rec = run.model.trackAtTick(id, k);
      if (rec === null) continue;
      const q = (run.positions[k] as Vec3[])[idx] as Vec3;
      measured++;
      if (Math.hypot(q.x - rec.pos.x, q.y - rec.pos.y) > BEHIND_UNITS) behind++;
    }
    rows.push({
      id,
      team: p.team,
      observed: stats(obs),
      other: stats(other),
      inferred: stats(inf),
      radiusMin: rMin,
      radiusMax: rMax,
      snaps: run.snaps.filter((x) => x.id === id).map((x) => x.tick),
      behindPct: measured === 0 ? 0 : (100 * behind) / measured,
      lastTick,
    });
  });
  return rows;
}

function cell(s: ErrorStats): string {
  if (s.samples === 0) return '0 | – | –';
  return `${s.samples} | ${s.rms.toFixed(1)} | ${s.max.toFixed(0)} (${(s.maxT ?? 0).toFixed(1)} s)`;
}

/** Markdown table of the ghost round (units). */
export function ghostTable(rows: readonly GhostRow[]): string {
  const lines = [
    '| player | team | observed n | RMS | max (at t) | est./inf. n | RMS | max (at t) | inferred RMS | radius (min–max) | snaps (t) | ticks > 24 behind |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
  ];
  for (const r of rows) {
    const radius = r.radiusMin === null ? '–' : r.radiusMin === r.radiusMax ? `${r.radiusMin}` : `${r.radiusMin}–${r.radiusMax}`;
    const inf = r.inferred.samples === 0 ? '–' : r.inferred.rms.toFixed(1);
    const snaps = r.snaps.length === 0 ? '0' : `${r.snaps.length} (${r.snaps.map((k) => (k / 64).toFixed(2)).join(', ')})`;
    lines.push(`| ${r.id} | ${r.team} | ${cell(r.observed)} | ${cell(r.other)} | ${inf} | ${radius} | ${snaps} | ${r.behindPct.toFixed(1)} % |`);
  }
  return lines.join('\n');
}

/** Spikes and discontinuities found per player, one line each. */
export function trackEventsReport(core: ReplayCore): string {
  const lines: string[] = [];
  for (const id of PLAYER_IDS) {
    const c = core.puppet(id);
    if (c === null) continue;
    const tr: PuppetTrack = c.track;
    const sum = tr.summary();
    lines.push(`${id}: ${sum.spikes.length} spike(s), ${sum.discontinuities.length} discontinuity(ies)`);
    for (const e of tr.events) lines.push(`  ${describeEvent(e)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const run = runGhostRound();
  const jsonl = resolve(ROOT, 'logs/ghost-round.jsonl');
  const tracePath = resolve(ROOT, 'logs/ghost-trace.json');
  writeSessionLog(jsonl, run.log);
  mkdirSync(dirname(tracePath), { recursive: true });
  writeFileSync(tracePath, stableStringify(toReplayTrace(run.log)) + '\n', 'utf8');
  console.log(`ghost round: ${run.ticks} ticks, ${run.snaps.length} snap(s), digest ${run.log.digest()}`);
  console.log(`wrote ${jsonl}\nwrote ${tracePath}\n`);
  console.log(ghostTable(measureGhost(run)));
  console.log(`\n${trackEventsReport(run.core)}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
