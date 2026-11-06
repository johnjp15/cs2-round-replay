/**
 * Scripted round: the whole recording with no human (the golden master). ReplayCore drives all ten pawns
 * in Sim2DHost (the ghost-round driver, tools/ghost-round.ts) and B3's scripted events act the recording:
 * aim, shots, scripted damage and kills, weapon changes, utility, plant and defuse. This tool checks the
 * outcome against the recording (kills, HP, shot ticks, USE windows) and measures the 2D engine's
 * input and action latency.
 *
 *   npm run scripted     # writes logs/scripted-round.jsonl and logs/scripted-trace.json, prints the tables
 *
 * tests/scripted-round.test.ts runs the same thing and asserts on it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PLAYER_IDS,
  canonicalize,
  stableStringify,
  toReplayTrace,
  type Act,
  type Action,
  type Button,
  type PawnInput,
  type PlayerId,
  type SessionLog,
  type WeaponId,
} from '../src/contracts/index';
import type { FireItem, ScriptPlan } from '../src/core/index';
import { Sim2DHost } from '../src/sim2d/host';
import { loadGhostInputs, runGhostRound, type GhostInputs, type GhostRun } from './ghost-round';
import { writeSessionLog } from './session-log-io';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type ScriptedRun = GhostRun;

/** The golden master: no human, all ten pawns puppets, for the whole recording. */
export function runScriptedRound(inputs: GhostInputs = loadGhostInputs(), ticks: number | null = null): ScriptedRun {
  return runGhostRound(inputs, ticks);
}

// ---------------------------------------------------------------------------
// Latency (apply -> tick -> observe)
// ---------------------------------------------------------------------------

export interface Latency {
  /** Ticks from ATTACK in the Act of tick k to the `shot` event in an Observe. */
  readonly input: number;
  /** Ticks from a `damage` action in the Act of tick k to the `damage` event in an Observe. */
  readonly action: number;
  /** Ticks from a `set_weapon` action to the Observe that shows the weapon. */
  readonly setWeapon: number;
}

const NO_INPUT: Omit<PawnInput, 'id'> = { forward: 0, side: 0, yaw: 0, pitch: 0, buttons: [] };

function act(inputs: readonly PawnInput[], actions: readonly Action[]): Act {
  return { inputs, actions, status: [] };
}

/**
 * Measure Sim2DHost's latencies the way the driver runs it: at observe tick k the Core's Act is applied,
 * then the host ticks; the effect is looked for in the following observes. Two pawns (cart with an AK,
 * zwomp as the victim) are set up on tick 0 and measured from tick 2 on.
 */
export function measureLatency(inputs: GhostInputs = loadGhostInputs()): Latency {
  const { tuning, nav, round } = inputs;
  const roster = round.players.map((p) => ({ id: p.id, team: p.team }));
  const pos = (id: PlayerId): { x: number; y: number; z: number } => {
    const p = round.players.find((q) => q.id === id);
    if (p === undefined) throw new Error(`no player ${id}`);
    return p.start.pos;
  };
  const setup: Action[] = [
    { type: 'teleport', id: 'cart', pos: pos('cart'), yaw: 0 },
    { type: 'give', id: 'cart', item: 'ak47', clip: 30, reserve: 90 },
    { type: 'give', id: 'cart', item: 'deagle', clip: 7, reserve: 35 },
    { type: 'set_weapon', id: 'cart', weapon: 'ak47' },
  ];
  const until = (host: Sim2DHost, k: number, a: Act, hit: (h: Sim2DHost) => boolean): number => {
    host.apply(canonicalize(a));
    host.tick();
    for (let i = 1; i <= 8; i++) {
      if (hit(host)) return host.observe().tick - k;
      host.apply(act([], []));
      host.tick();
    }
    throw new Error('measureLatency: no effect within 8 ticks');
  };
  const fresh = (): Sim2DHost => {
    const h = new Sim2DHost(nav, tuning, roster);
    h.setHuman(null);
    h.apply(act([], setup));
    h.tick();
    h.apply(act([], []));
    h.tick();
    return h;
  };

  const h1 = fresh();
  const k1 = h1.observe().tick;
  const attack: Button[] = ['ATTACK'];
  const input = until(h1, k1, act([{ id: 'cart', ...NO_INPUT, buttons: attack }], []), (h) => h.observe().events.some((e) => e.type === 'shot' && e.shooter === 'cart'));

  const h2 = fresh();
  const k2 = h2.observe().tick;
  const dmg: Action = { type: 'damage', attacker: 'cart', victim: 'zwomp', amount: 10, armor: 0, hitgroup: 'chest', weapon: 'ak47', lethal: false };
  const action = until(h2, k2, act([], [dmg]), (h) => h.observe().events.some((e) => e.type === 'damage' && e.victim === 'zwomp'));

  const h3 = fresh();
  const k3 = h3.observe().tick;
  const want: WeaponId = 'deagle';
  const setWeapon = until(h3, k3, act([], [{ type: 'set_weapon', id: 'cart', weapon: want }]), (h) => h.observe().pawns.find((p) => p.id === 'cart')?.weapon === want);
  return { input, action, setWeapon };
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export interface DeathSeen {
  readonly tick: number;
  readonly victim: PlayerId;
  readonly attacker: PlayerId | null;
  readonly weapon: WeaponId | null;
  readonly headshot: boolean;
}

/** Every `death` event, at the tick of the observe it is in. */
export function deaths(log: SessionLog): DeathSeen[] {
  const out: DeathSeen[] = [];
  for (let i = 0; i < log.length; i++) {
    const o = log.at(i)?.observe;
    if (o === undefined) continue;
    for (const e of o.events) if (e.type === 'death') out.push({ tick: o.tick, victim: e.victim, attacker: e.attacker, weapon: e.weapon, headshot: e.headshot });
  }
  return out;
}

export interface HpChange {
  readonly tick: number;
  readonly hp: number;
  readonly armor: number;
}

/** A pawn's HP and armor at the first logged tick and at every change after it. */
export function hpChanges(log: SessionLog, id: PlayerId): HpChange[] {
  const out: HpChange[] = [];
  for (let i = 0; i < log.length; i++) {
    const o = log.at(i)?.observe;
    const p = o?.pawns.find((q) => q.id === id);
    if (o === undefined || p === undefined) continue;
    const last = out[out.length - 1];
    if (last === undefined || last.hp !== p.hp || last.armor !== p.armor) out.push({ tick: o.tick, hp: p.hp, armor: p.armor });
  }
  return out;
}

export interface ShotSeen {
  readonly tick: number;
  readonly shooter: PlayerId;
  readonly weapon: WeaponId;
}

/** Every `shot` event, at the tick of the observe it is in. */
export function shots(log: SessionLog): ShotSeen[] {
  const out: ShotSeen[] = [];
  for (let i = 0; i < log.length; i++) {
    const o = log.at(i)?.observe;
    if (o === undefined) continue;
    for (const e of o.events) if (e.type === 'shot') out.push({ tick: o.tick, shooter: e.shooter, weapon: e.weapon });
  }
  return out;
}

export interface ShotMatch {
  readonly shooter: PlayerId;
  readonly weapon: WeaponId;
  readonly kind: FireItem['kind'];
  readonly recorded: number;
  /** The observed shot matched to it, or null. */
  readonly seen: number | null;
}

/**
 * Pair every recorded exact-time shot of a fire item with the shooter's observed shots, in order: each
 * recorded shot takes the first unused observed shot within 3 ticks.
 */
export function matchShots(plan: ScriptPlan, seen: readonly ShotSeen[]): ShotMatch[] {
  const out: ShotMatch[] = [];
  for (const id of PLAYER_IDS) {
    const mine = seen.filter((s) => s.shooter === id).map((s) => s.tick);
    const used: boolean[] = mine.map(() => false);
    for (const f of plan.fireOf(id)) {
      for (const r of f.recordedTicks) {
        let found: number | null = null;
        for (let k = 0; k < mine.length; k++) {
          const t = mine[k] as number;
          if (used[k] === true || Math.abs(t - r) > 3) continue;
          used[k] = true;
          found = t;
          break;
        }
        out.push({ shooter: id, weapon: f.weapon, kind: f.kind, recorded: r, seen: found });
      }
    }
  }
  return out.sort((a, b) => a.recorded - b.recorded || (a.shooter < b.shooter ? -1 : 1));
}

export interface ButtonSpan {
  readonly from: number;
  readonly to: number;
}

/** Act ticks at which `id`'s input holds `button`, as inclusive spans. */
export function buttonSpans(log: SessionLog, id: PlayerId, button: Button): ButtonSpan[] {
  const out: ButtonSpan[] = [];
  let open: number | null = null;
  let last = -1;
  for (let i = 0; i < log.length; i++) {
    const e = log.at(i);
    if (e === null) continue;
    const held = e.act.inputs.find((q) => q.id === id)?.buttons.includes(button) === true;
    const tick = e.observe.tick;
    if (held && open === null) open = tick;
    if (!held && open !== null) {
      out.push({ from: open, to: last });
      open = null;
    }
    last = tick;
  }
  if (open !== null) out.push({ from: open, to: last });
  return out;
}

/** Core `log` actions, with their tick. */
export function coreLogs(log: SessionLog): { tick: number; level: string; text: string }[] {
  const out: { tick: number; level: string; text: string }[] = [];
  for (let i = 0; i < log.length; i++) {
    const e = log.at(i);
    if (e === null) continue;
    for (const a of e.act.actions) if (a.type === 'log') out.push({ tick: e.observe.tick, level: a.level, text: a.text });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const sec = (tick: number): string => (tick / 64).toFixed(2);
const delta = (d: number): string => (d > 0 ? `+${d}` : `${d}`);

/** Markdown: the kill table against the recording. */
export function killTable(run: ScriptedRun): string {
  const seen = deaths(run.log);
  const lines = ['| t (s) | killer → victim | weapon | HS | recorded tick | death event tick | Δ |', '| ---: | --- | --- | --- | ---: | ---: | ---: |'];
  for (const k of run.inputs.round.kills) {
    const d = seen.find((x) => x.victim === k.victim);
    const ok = d !== undefined && d.attacker === k.killer && d.weapon === k.weapon && d.headshot === k.hs;
    lines.push(
      `| ${k.t.toFixed(2)} | ${k.killer} → ${k.victim} | ${k.weapon} | ${k.hs ? 'yes' : ''} | ${k.tick} | ` +
        `${d === undefined ? '–' : `${d.tick}${ok ? '' : ' (mismatch)'}`} | ${d === undefined ? '–' : delta(d.tick - k.tick)} |`,
    );
  }
  return lines.join('\n');
}

/** Markdown: HP / armor changes per pawn. */
export function hpTable(run: ScriptedRun): string {
  const lines = ['| player | HP (armor) over time: value @ tick |', '| --- | --- |'];
  for (const id of PLAYER_IDS) {
    const ch = hpChanges(run.log, id);
    lines.push(`| ${id} | ${ch.map((c) => `${c.hp} (${c.armor}) @ ${c.tick}`).join(' → ')} |`);
  }
  return lines.join('\n');
}

/** Markdown: recorded exact-time shots against the shot events. */
export function shotTable(run: ScriptedRun): string {
  const m = matchShots(run.core.script.plan, shots(run.log));
  const lines = ['| t (s) | shooter | weapon | fire item | recorded tick | shot event tick | Δ |', '| ---: | --- | --- | --- | ---: | ---: | ---: |'];
  for (const s of m) lines.push(`| ${sec(s.recorded)} | ${s.shooter} | ${s.weapon} | ${s.kind} | ${s.recorded} | ${s.seen ?? '–'} | ${s.seen === null ? '–' : delta(s.seen - s.recorded)} |`);
  return lines.join('\n');
}

function spans(s: readonly ButtonSpan[]): string {
  return s.length === 0 ? '–' : s.map((x) => `${x.from}–${x.to}`).join(', ');
}

function main(): void {
  const inputs = loadGhostInputs();
  const run = runScriptedRound(inputs);
  const lat = measureLatency(inputs);
  const jsonl = resolve(ROOT, 'logs/scripted-round.jsonl');
  const tracePath = resolve(ROOT, 'logs/scripted-trace.json');
  writeSessionLog(jsonl, run.log);
  mkdirSync(dirname(tracePath), { recursive: true });
  writeFileSync(tracePath, stableStringify(toReplayTrace(run.log)) + '\n', 'utf8');
  const r = inputs.tuning.replay;
  console.log(`scripted round: ${run.ticks} ticks, digest ${run.log.digest()}`);
  console.log(`wrote ${jsonl}\nwrote ${tracePath}\n`);
  console.log(`latency (Sim2DHost, apply -> tick -> observe): input ${lat.input} tick(s), damage action ${lat.action}, set_weapon ${lat.setWeapon}; tuning inputLatencyTicks ${r.inputLatencyTicks}, actionLatencyTicks ${r.actionLatencyTicks}\n`);
  console.log(killTable(run));
  console.log(`\n${hpTable(run)}`);
  console.log(`\n${shotTable(run)}`);
  const pl = run.core.script.plan.plant;
  const df = run.core.script.plan.defuse;
  if (pl !== null) console.log(`\nplant ${pl.id}: USE ${spans(buttonSpans(run.log, pl.id, 'USE'))} (plan ${pl.useFrom}–${pl.useTo}, recorded plant ${pl.tick})`);
  if (df !== null) console.log(`defuse ${df.id}: USE ${spans(buttonSpans(run.log, df.id, 'USE'))} (plan ${df.useFrom}–${df.useTo}, recorded ${df.startTick}–${df.endTick})`);
  console.log('\nCore logs:');
  for (const l of coreLogs(run.log)) console.log(`  ${l.tick} ${l.level} ${l.text}`);
  const notes = run.host.unhandled().filter((n) => n.kind === 'action');
  console.log(`\nhost notes (actions not applied): ${notes.length}`);
  for (const n of notes) console.log(`  ${n.tick} ${n.type}: ${n.reason}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
