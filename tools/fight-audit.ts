/**
 * F1: audit of every fight's aim (docs/fights.md). Runs the 3D harness (no human, or a scenario) and, for each kill in
 * the run (and both directions of it: killer → victim, victim → killer), measures from the log:
 *
 * - `los`: first tick of the last unbroken line-of-sight run (MeshSight, eye to body, no field-of-view limit, smokes
 *   included) that reaches the kill (or the viewer's death); `sees`: first tick of the last unbroken `sees` run (the
 *   engine's, 106° field of view) reaching it;
 * - the angle error at `los`: yaw and pitch from the viewer's view to the other's head (Source pitch, + = down);
 * - the largest per-tick yaw / pitch change in [los − 3 s, kill] ("before") and in [kill, kill + 1 s] ("after"); a
 *   change over 25°/tick at 64 tick is a visible snap;
 * - `flick`: seconds from `los` to the first tick the view is within 2° of the head (yaw and pitch);
 * - the first shot (`shot` event) after `los − 1 s` and the error at that shot.
 *
 *   npx tsx tools/fight-audit.ts [--scenario fixtures/scenarios/<name>.json] [--json <out.json>]
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { LogEntry, PlayerId, Tuning, Vec3 } from '../src/contracts/index';
import { bandPoint, bearing, pitchTo, tOf, tickOf, yawDelta } from '../src/core/index';
import { smokeBlocks } from '../src/sim2d/grenades';
import { SEES_AB } from '../src/sim2d/vision';
import { HumanBot, loadScenario } from './human-bot';
import { host3d, loadHarness3dData, runHarness3d } from './harness3d';
import { DEFAULT_SEED, type HarnessOptions, type HarnessRun } from './harness';

const TICK = 64;
const SNAP_DEG = 25;
const ON_TARGET_DEG = 2;
/** Ticks 0–2 are the setup (teleports to the start spots): not turns. */
const SKIP_SETUP = 3;

export interface DirectionAudit {
  readonly viewer: PlayerId;
  readonly other: PlayerId;
  readonly los: number | null;
  readonly sees: number | null;
  readonly yawErrAtLos: number | null;
  readonly pitchErrAtLos: number | null;
  readonly maxYawStepBefore: number;
  readonly maxPitchStepBefore: number;
  readonly maxYawStepAfter: number;
  readonly snapsBefore: number;
  readonly flickSec: number | null;
  readonly firstShot: number | null;
  readonly yawErrAtShot: number | null;
  /** Mode (REPLAY / LIVE / HUMAN) of the viewer at the kill. */
  readonly mode: string;
}

export interface FightAudit {
  readonly tick: number;
  readonly killer: PlayerId;
  readonly victim: PlayerId;
  readonly dirs: readonly DirectionAudit[];
}

interface Look {
  yaw: number;
  pitch: number;
}

/** Yaw / pitch from `v`'s eye to `o`'s head. */
function lookAt(v: { pos: Vec3; crouching: boolean }, o: { pos: Vec3; crouching: boolean }, t: Tuning): Look {
  const head = bandPoint(o.pos, o.crouching, 'head', t.damage);
  return { yaw: bearing(v.pos, head), pitch: pitchTo(v.pos, v.crouching, head, t.damage) };
}

/** Every per-tick view change over SNAP_DEG (yaw or pitch) of an alive pawn in the whole run (after the setup). */
export function snapsOf(run: HarnessRun): { tick: number; id: PlayerId; dyaw: number; dpitch: number; mode: string }[] {
  const out: { tick: number; id: PlayerId; dyaw: number; dpitch: number; mode: string }[] = [];
  for (let i = 1; i < run.entries.length; i++) {
    const a = run.entries[i - 1] as LogEntry;
    const b = run.entries[i] as LogEntry;
    if (b.observe.tick < SKIP_SETUP || b.observe.tick !== a.observe.tick + 1) continue;
    for (const p1 of b.observe.pawns) {
      const p0 = a.observe.pawns.find((q) => q.id === p1.id);
      if (p0 === undefined || !p0.alive || !p1.alive) continue;
      const dyaw = Math.abs(yawDelta(p0.yaw, p1.yaw));
      const dpitch = Math.abs(p1.pitch - p0.pitch);
      if (dyaw > SNAP_DEG || dpitch > SNAP_DEG) out.push({ tick: b.observe.tick, id: p1.id, dyaw, dpitch, mode: b.act.status.find((m) => m.id === p1.id)?.mode ?? '?' });
    }
  }
  return out;
}

export function auditRun(run: HarnessRun): FightAudit[] {
  const host = host3d(run) as unknown as {
    meshSight: { pairSight(a: { pos: Vec3; crouching: boolean }, b: { pos: Vec3; crouching: boolean }, ab: boolean, ba: boolean): number };
    grenades: Parameters<typeof smokeBlocks>[0];
  };
  const tuning = run.data.tuning;
  const byTick = new Map<number, LogEntry>();
  for (const e of run.entries) byTick.set(e.observe.tick, e);
  const pawn = (tick: number, id: PlayerId) => byTick.get(tick)?.observe.pawns.find((p) => p.id === id);
  const losCache = new Map<string, boolean>();
  const los = (tick: number, a: PlayerId, b: PlayerId): boolean => {
    const k = `${tick}:${a}:${b}`;
    const c = losCache.get(k);
    if (c !== undefined) return c;
    const pa = pawn(tick, a);
    const pb = pawn(tick, b);
    let r = false;
    if (pa !== undefined && pb !== undefined && pa.alive && pb.alive) {
      r = (host.meshSight.pairSight(pa, pb, true, false) & SEES_AB) !== 0 && !smokeBlocks(host.grenades, tick, pa.pos, pb.pos, tuning.grenades);
    }
    losCache.set(k, r);
    return r;
  };
  const kills: { tick: number; killer: PlayerId; victim: PlayerId }[] = [];
  for (const e of run.entries) for (const ev of e.observe.events) if (ev.type === 'death' && ev.attacker !== null) kills.push({ tick: e.observe.tick, killer: ev.attacker, victim: ev.victim });

  const out: FightAudit[] = [];
  for (const k of kills) {
    const dirs: DirectionAudit[] = [];
    for (const [viewer, other] of [
      [k.killer, k.victim],
      [k.victim, k.killer],
    ] as [PlayerId, PlayerId][]) {
      // The fight's end for this viewer: the kill (the victim's last alive observe is k.tick − 1).
      const end = k.tick - 1;
      let losFrom: number | null = null;
      let gap = 0;
      for (let t = end; t >= Math.max(0, end - 8 * TICK); t--) {
        if (los(t, viewer, other)) {
          losFrom = t;
          gap = 0;
        } else if (losFrom === null ? end - t > TICK / 2 : ++gap > 2) {
          // A run must reach to within 0.5 s of the kill; 2-tick gaps (a pixel of geometry) don't break it.
          break;
        }
      }
      let seesFrom: number | null = null;
      for (let t = end; t >= Math.max(0, end - 8 * TICK); t--) {
        const p = pawn(t, viewer);
        if (p !== undefined && p.sees.includes(other)) seesFrom = t;
        else if (seesFrom !== null) break;
      }
      const ref = losFrom ?? end - TICK;
      const step = (a: number, b: number): { yaw: number; pitch: number; snaps: number } => {
        let my = 0;
        let mp = 0;
        let snaps = 0;
        for (let t = Math.max(SKIP_SETUP, a); t <= b; t++) {
          const p0 = pawn(t - 1, viewer);
          const p1 = pawn(t, viewer);
          if (p0 === undefined || p1 === undefined || !p0.alive || !p1.alive) continue;
          const dy = Math.abs(yawDelta(p0.yaw, p1.yaw));
          const dp = Math.abs(p1.pitch - p0.pitch);
          if (dy > SNAP_DEG) snaps++;
          my = Math.max(my, dy);
          mp = Math.max(mp, dp);
        }
        return { yaw: my, pitch: mp, snaps };
      };
      const before = step(ref - 3 * TICK, end);
      const after = step(k.tick, k.tick + TICK);
      const err = (t: number): Look | null => {
        const v = pawn(t, viewer);
        const o = pawn(t, other);
        if (v === undefined || o === undefined || !v.alive || !o.alive) return null;
        const want = lookAt(v, o, tuning);
        return { yaw: yawDelta(want.yaw, v.yaw), pitch: v.pitch - want.pitch };
      };
      const e0 = losFrom === null ? null : err(losFrom);
      let flick: number | null = null;
      if (losFrom !== null) {
        for (let t = losFrom; t <= end; t++) {
          const e = err(t);
          if (e !== null && Math.abs(e.yaw) <= ON_TARGET_DEG && Math.abs(e.pitch) <= ON_TARGET_DEG) {
            flick = (t - losFrom) / TICK;
            break;
          }
        }
      }
      let firstShot: number | null = null;
      for (let t = ref - TICK; t <= end + 1; t++) {
        if (byTick.get(t)?.observe.events.some((ev) => ev.type === 'shot' && ev.shooter === viewer)) {
          firstShot = t;
          break;
        }
      }
      // The shot event is in the observe after the act that fired; the view that fired is the observe before it.
      const es = firstShot === null ? null : err(firstShot - 1);
      const mode = byTick.get(end)?.act.status.find((m) => m.id === viewer)?.mode ?? '?';
      dirs.push({
        viewer,
        other,
        los: losFrom,
        sees: seesFrom,
        yawErrAtLos: e0?.yaw ?? null,
        pitchErrAtLos: e0?.pitch ?? null,
        maxYawStepBefore: before.yaw,
        maxPitchStepBefore: before.pitch,
        maxYawStepAfter: after.yaw,
        snapsBefore: before.snaps,
        flickSec: flick,
        firstShot,
        yawErrAtShot: es?.yaw ?? null,
        mode: String(mode),
      });
    }
    out.push({ ...k, dirs });
  }
  return out;
}

const f1 = (x: number | null): string => (x === null ? '–' : x.toFixed(1));
const sec = (t: number | null): string => (t === null ? '–' : tOf(t).toFixed(2));

export function formatAudit(fights: readonly FightAudit[]): string {
  const lines = ['| kill t | viewer → other | mode | LOS t | sees t | yaw / pitch err at LOS (°) | max °/tick yaw / pitch before | snaps > 25° | on target after LOS (s) | 1st shot t | yaw err at shot | max °/tick after kill |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const f of fights) {
    for (const d of f.dirs) {
      lines.push(
        `| ${sec(f.tick)} | ${d.viewer} → ${d.other} | ${d.mode} | ${sec(d.los)} | ${sec(d.sees)} | ${f1(d.yawErrAtLos)} / ${f1(d.pitchErrAtLos)} | ${f1(d.maxYawStepBefore)} / ${f1(d.maxPitchStepBefore)} | ${d.snapsBefore} | ${d.flickSec === null ? '–' : d.flickSec.toFixed(2)} | ${sec(d.firstShot)} | ${f1(d.yawErrAtShot)} | ${f1(d.maxYawStepAfter)} |`,
      );
    }
  }
  return lines.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const scenarioPath = arg('--scenario');
  const jsonOut = arg('--json');
  const until = arg('--until');
  const data = loadHarness3dData();
  let options: HarnessOptions = { human: null, driver: null, lastTick: until === null ? 'end' : tickOf(Number(until)), seed: DEFAULT_SEED, takeover: null };
  if (scenarioPath !== null) {
    const sc = loadScenario(scenarioPath);
    const bot = HumanBot.fromScenario(data, sc);
    options = { human: sc.human, driver: bot, seed: sc.seed, lastTick: sc.until === 'end' ? 'end' : tickOf(sc.until), takeover: sc.takeover === null ? null : tickOf(sc.takeover) };
  }
  const run = runHarness3d(data, options);
  const fights = auditRun(run);
  console.log(formatAudit(fights));
  const snaps = snapsOf(run);
  console.log(`\nview changes over ${SNAP_DEG}°/tick in the whole run: ${snaps.length}`);
  for (const x of snaps) console.log(`  ${tOf(x.tick).toFixed(2)} s (tick ${x.tick}) ${x.id} ${x.mode}: yaw ${x.dyaw.toFixed(1)}°, pitch ${x.dpitch.toFixed(1)}°`);
  if (jsonOut !== null) writeFileSync(resolve(jsonOut), JSON.stringify({ fights, snaps }, null, 1));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
