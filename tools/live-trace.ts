/**
 * G8: how a LIVE pawn moves and fights, tick by tick (docs/ai.md "Moving like a player"). Runs a scenario through the
 * harness (2D, or `--3d` the 3D host), records the host's `aiDebug` for every LIVE pawn after each tick, and prints
 * for one pawn a line every `--every` seconds (mode, role, behaviour, position, speed, yaw, target) plus the
 * movement checks of `liveMotion` (idle in the open, jitter, turns, speed, off-mesh positions).
 *
 *   npx tsx tools/live-trace.ts --scenario fixtures/scenarios/<name>.json --pawn eradicate [--3d] [--every 0.5] [--from 10] [--until 40]
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLAYER_IDS, isPlayerId, type LogEntry, type PlayerId, type Tuning } from '../src/contracts/index';
import { tickOf } from '../src/core/index';
import { defaultHost, type HostFactory, type HostParts, type SessionHost } from '../src/app/index';
import type { AiDebug } from '../src/sim2d/host';
import type { NavMesh } from '../src/sim2d/nav';
import { sim3dHostFactory } from '../src/sim3d/index';
import { loadHarnessData, runHarness, type HarnessData, type HarnessRun } from './harness';
import { loadHarness3dData } from './harness3d';
import { HumanBot, formatTimeline, loadScenario, timeline } from './human-bot';

/** aiDebug of every LIVE pawn after each tick: `debug[k]` is the AI state that drove the move into observe tick k + 1. */
export interface LiveTraceRun {
  readonly run: HarnessRun;
  readonly debug: readonly (readonly AiDebug[])[];
}

/** A host factory that records `aiDebug` for every pawn after each `tick()`. */
function recording(inner: HostFactory, sink: AiDebug[][]): HostFactory {
  return (p: HostParts): SessionHost => {
    const host = inner(p);
    const tick = host.tick.bind(host);
    host.tick = (): void => {
      tick();
      const row: AiDebug[] = [];
      for (const id of PLAYER_IDS) {
        const d = host.aiDebug(id);
        if (d !== null) row.push(d);
      }
      sink.push(row);
    };
    return host;
  };
}

/** Run a scenario file with the aiDebug recorder (2D by default, the 3D host with `three`). */
export function liveTrace(scenarioPath: string, three: boolean, data?: HarnessData): LiveTraceRun {
  const s = loadScenario(scenarioPath);
  const d = data ?? (three ? loadHarness3dData() : loadHarnessData());
  const bot = HumanBot.fromScenario(d, s);
  const sink: AiDebug[][] = [];
  const inner: HostFactory = three ? (sim3dHostFactory((d as ReturnType<typeof loadHarness3dData>).world) as unknown as HostFactory) : defaultHost;
  const run = runHarness(d, {
    human: s.human,
    driver: bot,
    seed: s.seed,
    lastTick: s.until === 'end' ? 'end' : tickOf(s.until),
    takeover: s.takeover === null ? null : tickOf(s.takeover),
    host: recording(inner, sink),
  });
  return { run, debug: sink };
}

/** The movement checks for one pawn over its LIVE ticks (docs/ai.md "Moving like a player"). */
export interface LiveMotion {
  readonly liveTicks: number;
  /** Ticks alive, LIVE, slower than 5 u/s, not fighting, not planting / defusing / guarding / holding (stood idle). */
  readonly idleTicks: number;
  /** Longest run of idle ticks. */
  readonly idleRun: { readonly ticks: number; readonly from: number };
  /** Reversals of the horizontal velocity (> 120° within 4 ticks) below 60 u/s while not fighting: jitter. */
  readonly jitter: number;
  /** Largest yaw change in one tick while not fighting (degrees). */
  readonly maxTurnDeg: number;
  /** Largest horizontal speed (u/s) and the run speed of the weapon held then. */
  readonly maxSpeed: number;
  readonly overSpeedTicks: number;
  /** Ticks on the ground on which the pawn's position is not on the nav mesh (a wall clip in 2D terms). */
  readonly offMesh: number;
}

export function liveMotion(t: LiveTraceRun, id: PlayerId, nav: NavMesh, tuning: Tuning, from = 0, to = Infinity): LiveMotion {
  const entries = t.run.entries;
  let liveTicks = 0;
  let idle = 0;
  let run = 0;
  let runFrom = 0;
  let best = { ticks: 0, from: 0 };
  let jitter = 0;
  let maxTurn = 0;
  let maxSpeed = 0;
  let over = 0;
  let offMesh = 0;
  const vels: { x: number; y: number }[] = [];
  for (let k = Math.max(1, from); k < entries.length && k <= to; k++) {
    const e = entries[k] as LogEntry;
    const prev = entries[k - 1] as LogEntry;
    const st = e.act.status.find((s) => s.id === id);
    const p = e.observe.pawns.find((q) => q.id === id);
    const q = prev.observe.pawns.find((x) => x.id === id);
    const dbg = (t.debug[k - 1] ?? []).find((d) => d.id === id) ?? null;
    if (st?.mode !== 'LIVE' || p === undefined || q === undefined || !p.alive || dbg === null) {
      run = 0;
      vels.length = 0;
      continue;
    }
    liveTicks++;
    const fighting = dbg.behaviour === 'fighting' || dbg.behaviour === 'reacting';
    const sp = Math.hypot(p.vel.x, p.vel.y);
    const settled = ['planting', 'defusing', 'guarding', 'holding', 'covering', 'rejoining'].includes(dbg.behaviour);
    if (sp < 5 && !fighting && !settled) {
      idle++;
      if (run === 0) runFrom = k;
      run++;
      if (run > best.ticks) best = { ticks: run, from: runFrom };
    } else run = 0;
    if (!fighting) {
      const d = Math.abs((((p.yaw - q.yaw) % 360) + 540) % 360 - 180);
      if (d > maxTurn) maxTurn = d;
    }
    vels.push({ x: p.vel.x, y: p.vel.y });
    if (vels.length > 5) vels.shift();
    if (!fighting && vels.length === 5) {
      const a = vels[0] as { x: number; y: number };
      const b = vels[4] as { x: number; y: number };
      const la = Math.hypot(a.x, a.y);
      const lb = Math.hypot(b.x, b.y);
      if (la > 2 && lb > 2 && la < 60 && lb < 60 && (a.x * b.x + a.y * b.y) / (la * lb) < Math.cos((120 * Math.PI) / 180)) {
        jitter++;
        vels.length = 0;
      }
    }
    const runSpeed = tuning.movement.runSpeedByWeapon[p.weapon] ?? tuning.movement.runSpeedByWeapon['knife'] ?? 250;
    if (sp > maxSpeed) maxSpeed = sp;
    if (sp > runSpeed * 1.05 + 1 && p.onGround) over++;
    if (p.onGround && !nav.isWalkable(p.pos)) offMesh++;
  }
  return { liveTicks, idleTicks: idle, idleRun: best, jitter, maxTurnDeg: Math.round(maxTurn * 10) / 10, maxSpeed: Math.round(maxSpeed * 10) / 10, overSpeedTicks: over, offMesh };
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (k: string): string | null => {
    const i = argv.indexOf(k);
    return i < 0 ? null : (argv[i + 1] ?? null);
  };
  const scenario = arg('--scenario');
  const pawn = arg('--pawn') ?? 'eradicate';
  if (scenario === null || !isPlayerId(pawn)) throw new Error('usage: --scenario <file> --pawn <id> [--3d] [--every s] [--from s] [--until s]');
  const three = argv.includes('--3d');
  const every = tickOf(Number(arg('--every') ?? '0.5'));
  const from = tickOf(Number(arg('--from') ?? '0'));
  const until = arg('--until') === null ? Infinity : tickOf(Number(arg('--until')));
  const data = three ? loadHarness3dData() : loadHarnessData();
  const t = liveTrace(resolve(scenario), three, data);
  const entries = t.run.entries;
  for (let k = from; k < entries.length && k <= until; k += Math.max(1, every)) {
    const e = entries[k] as LogEntry;
    const p = e.observe.pawns.find((q) => q.id === pawn);
    const st = e.act.status.find((s) => s.id === pawn);
    if (p === undefined || st === undefined) continue;
    const d = (t.debug[k - 1] ?? []).find((x) => x.id === pawn) ?? null;
    const f = (x: number): string => x.toFixed(0).padStart(6);
    console.log(
      `${(k / 64).toFixed(2).padStart(6)} ${String(k).padStart(5)} ${st.mode.padEnd(6)} ${p.alive ? `${String(p.hp).padStart(3)}hp` : 'dead '} (${f(p.pos.x)},${f(p.pos.y)},${f(p.pos.z)}) v ${f(Math.hypot(p.vel.x, p.vel.y))} yaw ${f(p.yaw)} ${p.weapon}${p.crouching ? ' crouch' : ''}` +
        (d === null ? '' : ` | ${d.role}/${d.behaviour}${d.target === null ? '' : ` -> ${d.target}${d.targetVisible ? '' : ' (lost)'}`}${d.dest === null ? '' : ` dest (${f(d.dest.x)},${f(d.dest.y)})`}`) +
        ` sees [${p.sees.join(' ')}]`,
    );
  }
  console.log(`\ntimeline:\n${formatTimeline(timeline(entries))}`);
  console.log(`\nmotion (${pawn}, LIVE ticks):`, liveMotion(t, pawn, data.nav, data.tuning));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
