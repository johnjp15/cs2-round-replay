/**
 * Headless harness (C5): the round in Node, through the browser app's own driver (`Session`, src/app/session.ts),
 * so it runs exactly what the page runs: the same Core (`defaultCore`: ReplayCore + the nav walk query), the same
 * Sim2DHost, the same per-tick contract and the same SessionLog. Optionally a human plays one pawn from an input
 * script ("chaos cart"). docs/golden.md describes it, and the golden master and the C# port fixtures are built on it.
 *
 *   npm run harness -- [--human none|cart] [--script <path>] [--until <t|end>] [--seed <n>] [--out <dir>]
 *
 * - `--human none` (default): nobody plays, the Core drives all ten pawns (the golden master). `--human cart`: cart
 *   is the human pawn (the Core sends him nothing); without `--script` he gets no input and stands where the setup
 *   put him.
 * - `--script <path>`: JSON `[{t, forward, side, yaw, pitch, buttons, weapon?}]`, each entry held until the next
 *   (see `parseHumanScript`). `yaw` / `pitch` are degrees or `"track"`: the human pawn's recorded yaw (pitch: 0, the
 *   recording has none).
 * - `--until <t|end>`: run up to and including observe tick round(t × 64); `end` (default) is the golden length,
 *   one past the latest track end plus the hold (4,517 ticks, `roundTicks`).
 * - `--seed <n>`: Core seed (default 1, as the app).
 * - `--out <dir>`: writes `log.jsonl` (the SessionLog), `trace.json` (`toReplayTrace`, opens in the replay page) and
 *   `summary.json` (deterministic: deaths, bomb events, round end, final round state, per-pawn modes, snaps, body
 *   blocks, drift against the recording).
 *
 * Without `--out` it prints the summary. Timing goes to stdout only (summary.json stays byte-stable).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BUTTONS,
  PLAYER_IDS,
  WEAPON_IDS,
  fnv1a32Hex,
  isPlayerId,
  sortButtons,
  stableStringify,
  toReplayTrace,
  type Act,
  type Action,
  type Button,
  type Control,
  type LogEntry,
  type Mode,
  type Observe,
  type PawnInput,
  type PlayerId,
  type RoundObs,
  type SessionLog,
  type Team,
  type Vec3,
  type WalkQuery,
  type WeaponId,
} from '../src/contracts/index';
import { PuppetTrack, ReplayCore, startYaw, tOf, tickOf, type RoundModel } from '../src/core/index';
import { NavWalkQuery, type Sim2DHost } from '../src/sim2d/index';
import { SLOT_WEAPONS, Session, defaultCore, parseSessionData, weaponForSlot, type CoreFactory, type SessionData, type WeaponSlot } from '../src/app/index';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The app's default seed (`?seed=` in the page); the fixtures use it too. */
export const DEFAULT_SEED = 1;

/** A pawn is "behind" when more than this far (units, 2D) from its recorded position. Same as replay.driftNudgeUnits. */
export const BEHIND_UNITS = 24;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** The parsed data files plus their text (for the fixture manifest's hashes). */
export interface HarnessData extends SessionData {
  readonly sources: { readonly round: string; readonly nav: string; readonly tuning: string; readonly vision: string };
}

export function loadHarnessData(root: string = ROOT): HarnessData {
  const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');
  const sources = {
    round: read('data/round.json'),
    nav: read('data/mirage-nav.json'),
    tuning: read('data/tuning.json'),
    vision: read('data/mirage-vismask.json'),
  };
  // The sight mask (C4) must be passed explicitly: parseSessionData defaults it to null (nav line of sight),
  // which would make the harness and fixtures disagree with the browser app.
  return { ...parseSessionData(sources.round, sources.nav, sources.tuning, sources.vision), sources };
}

/**
 * SessionLog.digest() (FNV-1a 32-bit over the UTF-8 bytes of toText()), computed on a Buffer: same value, about
 * 6× faster on a 17 MB log. tests/golden-harness.test.ts checks the two agree.
 */
export function logDigest(log: SessionLog): string {
  const bytes = Buffer.from(log.toText(), 'utf8');
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ (bytes[i] as number), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** FNV-1a 32-bit of a JSON file's canonical form (stableStringify of its parsed value), so whitespace and key order don't matter. */
export function canonicalHash(jsonText: string): string {
  return fnv1a32Hex(stableStringify(JSON.parse(jsonText) as unknown));
}

/** Ticks in the golden round: one past the latest track end plus the hold, so every recorded sample can be measured (4,517). */
export function roundTicks(model: RoundModel, holdLastPositionSec: number): number {
  let end = 0;
  for (const id of PLAYER_IDS) end = Math.max(end, (model.track(id).at(-1) as { tick: number }).tick);
  return end + Math.round(holdLastPositionSec * 64) + 2;
}

// ---------------------------------------------------------------------------
// Human input scripts
// ---------------------------------------------------------------------------

/** An absolute angle in degrees, or `"track"` (yaw: the human pawn's recorded yaw; pitch: 0). */
export type AngleSpec = number | 'track';

export interface ScriptEntry {
  /** Video seconds; the entry starts on tick round(t × 64) and holds until the next entry. */
  readonly t: number;
  readonly forward: number;
  readonly side: number;
  readonly yaw: AngleSpec;
  readonly pitch: AngleSpec;
  readonly buttons: readonly Button[];
  /** Switch to this weapon on the entry's first tick (through the app's weapon-slot keys), or null. */
  readonly weapon: WeaponId | null;
}

export interface HumanScript {
  readonly entries: readonly ScriptEntry[];
}

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptError';
  }
}

function angleSpec(v: unknown, where: string): AngleSpec {
  if (v === 'track') return 'track';
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ScriptError(`${where}: expected degrees or "track"`);
  return v;
}

function stick(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < -1 || v > 1) throw new ScriptError(`${where}: expected a number in -1..1`);
  return v;
}

/**
 * Validate a script: a JSON array (value or text) of `{t, forward, side, yaw, pitch, buttons, weapon?}`. `t` ≥ 0 and
 * strictly increasing in ticks (round(t × 64)); `forward` / `side` in −1..1 relative to the yaw (+side = strafe right);
 * `buttons` from BUTTONS (stored in BUTTONS order); `weapon` a WeaponId, null or absent. Unknown keys are an error.
 */
export function parseHumanScript(json: unknown): HumanScript {
  const value = typeof json === 'string' ? (JSON.parse(json) as unknown) : json;
  if (!Array.isArray(value)) throw new ScriptError('script: expected a JSON array of entries');
  const entries: ScriptEntry[] = [];
  let lastTick = -1;
  value.forEach((raw: unknown, i) => {
    const where = `script[${i}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ScriptError(`${where}: expected an object`);
    const e = raw as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!['t', 'forward', 'side', 'yaw', 'pitch', 'buttons', 'weapon'].includes(k)) throw new ScriptError(`${where}: unknown key "${k}"`);
    }
    const t = e['t'];
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) throw new ScriptError(`${where}.t: expected seconds >= 0`);
    const tick = tickOf(t);
    if (tick <= lastTick) throw new ScriptError(`${where}.t: tick ${tick} is not after the previous entry's tick ${lastTick}`);
    lastTick = tick;
    const buttons = e['buttons'];
    if (!Array.isArray(buttons)) throw new ScriptError(`${where}.buttons: expected an array`);
    for (const b of buttons) if (!(BUTTONS as readonly unknown[]).includes(b)) throw new ScriptError(`${where}.buttons: unknown button ${String(b)}`);
    const weapon = e['weapon'] ?? null;
    if (weapon !== null && !(WEAPON_IDS as readonly unknown[]).includes(weapon)) throw new ScriptError(`${where}.weapon: unknown weapon ${String(weapon)}`);
    entries.push({
      t,
      forward: stick(e['forward'], `${where}.forward`),
      side: stick(e['side'], `${where}.side`),
      yaw: angleSpec(e['yaw'], `${where}.yaw`),
      pitch: angleSpec(e['pitch'], `${where}.pitch`),
      buttons: sortButtons([...new Set(buttons as Button[])]),
      weapon: weapon as WeaponId | null,
    });
  });
  return { entries };
}

/**
 * Script text: a JSON array with one entry per line, keys in the documented order (t, forward, side, yaw, pitch,
 * buttons, weapon), numbers as stableStringify writes them. `weapon` is written only when set.
 */
export function formatHumanScript(entries: readonly ScriptEntry[]): string {
  const lines = entries.map((e) => {
    const parts = [
      `"t":${stableStringify(e.t)}`,
      `"forward":${stableStringify(e.forward)}`,
      `"side":${stableStringify(e.side)}`,
      `"yaw":${stableStringify(e.yaw)}`,
      `"pitch":${stableStringify(e.pitch)}`,
      `"buttons":${stableStringify(e.buttons)}`,
    ];
    if (e.weapon !== null) parts.push(`"weapon":${stableStringify(e.weapon)}`);
    return `{${parts.join(',')}}`;
  });
  return `[\n${lines.join(',\n')}\n]\n`;
}

/** What a human driver asks for on one tick. */
export interface HumanCommand {
  /** The human pawn's input from this tick on (held until replaced), or null to leave the current one. */
  readonly input: PawnInput | null;
  /** A weapon to switch to on this tick (app-side weapon-slot presses), or null. */
  readonly weapon: WeaponId | null;
}

/** Produces the human pawn's input each tick, before the Session steps it. */
export interface HumanDriver {
  command(tick: number, session: Session): HumanCommand;
}

/** The recorded-yaw lookup behind `"track"`: the Core's own interpolation (PuppetTrack.recordedYawAt). */
export class TrackYaw {
  private readonly track: PuppetTrack;
  /** The pawn's setup yaw (start-state.ts), held until there is a recorded or absolute yaw. */
  readonly startYaw: number;

  constructor(session: Session, id: PlayerId) {
    this.track = PuppetTrack.fromModel(session.model, session.schedule, session.tuning, id);
    this.startYaw = startYaw(session.model, id).yaw;
  }

  /** Recorded yaw at a tick (rounded to 0.001°), or null where the recording has none. */
  at(tick: number): number | null {
    return this.track.recordedYawAt(tOf(tick));
  }
}

/**
 * The input an entry gives on `tick`. `"track"` yaw is the recorded yaw at that tick, else `lastYaw` (the yaw of the
 * previous tick, or the setup yaw before any); `"track"` pitch is 0.
 */
export function resolveEntry(e: ScriptEntry, id: PlayerId, tick: number, track: TrackYaw, lastYaw: number): PawnInput {
  const yaw = e.yaw === 'track' ? (track.at(tick) ?? lastYaw) : e.yaw;
  const pitch = e.pitch === 'track' ? 0 : e.pitch;
  return { id, forward: e.forward, side: e.side, yaw, pitch, buttons: e.buttons };
}

/** Plays a HumanScript: before the first entry the pawn gets no input; each entry is held until the next. */
export class ScriptDriver implements HumanDriver {
  private readonly script: HumanScript;
  private readonly id: PlayerId;
  private track: TrackYaw | null = null;
  private next = 0;
  private current: ScriptEntry | null = null;
  private lastYaw: number | null = null;

  constructor(script: HumanScript, id: PlayerId) {
    this.script = script;
    this.id = id;
  }

  command(tick: number, session: Session): HumanCommand {
    if (this.track === null) this.track = new TrackYaw(session, this.id);
    let starts = false;
    for (;;) {
      const e = this.script.entries[this.next];
      if (e === undefined || tickOf(e.t) > tick) break;
      this.current = e;
      this.next++;
      starts = tickOf(e.t) === tick;
    }
    const e = this.current;
    if (e === null) return { input: null, weapon: null };
    const input = resolveEntry(e, this.id, tick, this.track, this.lastYaw ?? this.track.startYaw);
    this.lastYaw = input.yaw;
    return { input, weapon: starts ? e.weapon : null };
  }
}

/** Weapon slot of a weapon (src/app/input.ts SLOT_WEAPONS), or null. */
export function slotOf(weapon: WeaponId): WeaponSlot | null {
  for (const s of [1, 2, 3, 4, 5] as const) if (SLOT_WEAPONS[s].includes(weapon)) return s;
  return null;
}

/**
 * Slot presses that switch from `current` to `weapon` with `carried` (weaponForSlot cycles a slot), or null when
 * the weapon can't be reached. 0 when it is already out.
 */
export function slotPresses(weapon: WeaponId, carried: readonly string[], current: string): { slot: WeaponSlot; presses: number } | null {
  const slot = slotOf(weapon);
  if (slot === null) return null;
  if (current === weapon) return { slot, presses: 0 };
  let cur = current;
  for (let n = 1; n <= SLOT_WEAPONS[slot].length; n++) {
    const next = weaponForSlot(slot, carried, cur);
    if (next === null) return null;
    if (next === weapon) return { slot, presses: n };
    cur = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  /** The human pawn, or null: nobody plays and the Core drives all ten (golden master). */
  readonly human: PlayerId | null;
  /** The human's input (a ScriptDriver, or a programmatic driver); null = no input. Requires `human`. */
  readonly driver: HumanDriver | null;
  /** Last observe tick to run (inclusive), or 'end' (roundTicks − 1). */
  readonly lastTick: number | 'end';
  readonly seed: number;
  /** Record every WalkQuery call (the C# port's walk oracle, docs/golden.md). Off by default. */
  readonly recordWalk?: boolean;
  /**
   * Controls to send (`Session.control`) just before the step of their tick, e.g. the `speed` a page sends when
   * its speed buttons are used; they are logged on that tick's line. Default none (the Session sends `start` itself).
   */
  readonly controls?: readonly { readonly tick: number; readonly control: Control }[];
}

export const NO_HUMAN: HarnessOptions = { human: null, driver: null, lastTick: 'end', seed: DEFAULT_SEED };

export interface Snap {
  readonly id: PlayerId;
  readonly tick: number;
  /** The `log` action that came with the teleport (puppet snaps log one), or null. */
  readonly text: string | null;
}

export interface BodyBlock {
  readonly id: PlayerId;
  /** The engine tick whose move was cut. */
  readonly tick: number;
  readonly by: PlayerId;
}

/** One `WalkQuery.isWalkableLine` call the Core made while stepping `tick`. */
export interface WalkCall {
  readonly tick: number;
  readonly a: Vec3;
  readonly b: Vec3;
  readonly walkable: boolean;
}

export interface HarnessRun {
  readonly options: HarnessOptions;
  readonly data: SessionData;
  readonly session: Session;
  readonly model: RoundModel;
  readonly core: ReplayCore;
  /** The engine after the last tick (for its `unhandled()` notes and `combatLog()`). */
  readonly host: Sim2DHost;
  readonly log: SessionLog;
  /** The log's lines, parsed (log.at(i) for every i). */
  readonly entries: readonly LogEntry[];
  readonly ticks: number;
  readonly lastTick: number;
  /** positions[tick][i] = pawn PLAYER_IDS[i] at `tick` after that tick's actions (setup, snaps), before its move. */
  readonly positions: readonly (readonly Vec3[])[];
  /** Teleports after the setup tick (puppet snaps), in order. */
  readonly snaps: readonly Snap[];
  /** Body blocks (C3 collision): a pawn whose move on `tick` an enemy cut short (`host.blockedBy`), in order. */
  readonly bodyBlocks: readonly BodyBlock[];
  /** Every WalkQuery call in order (with `recordWalk`), else null. */
  readonly walk: readonly WalkCall[] | null;
  /** Problems with the human's commands (a weapon that can't be selected), in order. */
  readonly warnings: readonly string[];
  /** Wall time (ms): building the Session, the ticks (steps plus the bookkeeping: reading back the log). */
  readonly ms: { readonly construct: number; readonly ticks: number };
}

/** Wraps the engine's WalkQuery and records every call (pure pass-through: the answers are the inner query's). */
class RecordingWalk implements WalkQuery {
  tick = 0;
  readonly calls: WalkCall[] = [];
  private readonly inner: WalkQuery;

  constructor(inner: WalkQuery) {
    this.inner = inner;
  }

  isWalkableLine(a: Vec3, b: Vec3): boolean {
    const walkable = this.inner.isWalkableLine(a, b);
    this.calls.push({ tick: this.tick, a: { x: a.x, y: a.y, z: a.z }, b: { x: b.x, y: b.y, z: b.z }, walkable });
    return walkable;
  }
}

/** The pawns' positions after the act's actions: the observe's, with teleports applied (as the engine stores them). */
function positionsAfter(e: LogEntry): Vec3[] {
  const pos = e.observe.pawns.map((p) => p.pos);
  for (const a of e.act.actions) {
    if (a.type !== 'teleport') continue;
    const i = e.observe.pawns.findIndex((p) => p.id === a.id);
    if (i >= 0) pos[i] = a.pos;
  }
  return pos;
}

/**
 * Run the round headless. Per tick: the driver's command (human input, weapon-slot presses) and any controls →
 * `session.step()` (observe → core.step → log → host.apply → host.tick, docs/app.md) → body blocks. Then the logged
 * lines are parsed once for the entries, positions and snaps.
 */
export function runHarness(data: SessionData, options: HarnessOptions): HarnessRun {
  const { human, driver, seed } = options;
  if (driver !== null && human === null) throw new Error('runHarness: a driver needs a human pawn');
  const t0 = performance.now();
  // The app's Core (defaultCore), or the same Core with the walk query wrapped by a recorder.
  const recorder = options.recordWalk === true ? new RecordingWalk(new NavWalkQuery(data.nav)) : null;
  const core: CoreFactory = recorder === null ? defaultCore : (p) => new ReplayCore(p.model, p.schedule, p.tuning, p.seed, recorder);
  const session = new Session({ round: data.round, nav: data.nav, tuning: data.tuning, vision: data.vision, seed, human, core });
  const ticks = roundTicks(session.model, data.tuning.replay.holdLastPositionSec);
  const last = options.lastTick === 'end' ? ticks - 1 : options.lastTick;
  if (!Number.isInteger(last) || last < 0) throw new Error(`runHarness: bad last tick ${String(options.lastTick)}`);
  const t1 = performance.now();

  const entries: LogEntry[] = [];
  const positions: Vec3[][] = [];
  const snaps: Snap[] = [];
  const bodyBlocks: BodyBlock[] = [];
  const warnings: string[] = [];
  let lastInput: string | null = null;
  for (let k = 0; k <= last; k++) {
    if (driver !== null && human !== null) {
      const cmd = driver.command(k, session);
      if (cmd.input !== null) {
        // setHumanInput canonicalizes; skip it when nothing changed (the input is held anyway).
        const text = stableStringify(cmd.input);
        if (text !== lastInput) session.setHumanInput(cmd.input);
        lastInput = text;
      }
      if (cmd.weapon !== null) {
        const pawn = session.pawnState(human);
        const how = pawn === null || !pawn.alive ? null : slotPresses(cmd.weapon, pawn.inventory.map((q) => q.item), pawn.weapon);
        if (how === null) warnings.push(`tick ${k}: ${human} can't switch to ${cmd.weapon}${pawn === null || !pawn.alive ? ' (dead)' : ` (holds ${pawn.weapon}, carries ${pawn.inventory.map((q) => q.item).join(' ')})`}`);
        else for (let n = 0; n < how.presses; n++) session.requestWeaponSlot(how.slot);
      }
    }
    for (const c of options.controls ?? []) if (c.tick === k) session.control(c.control);
    if (recorder !== null) recorder.tick = k;
    session.step();
    // blockedBy describes the move of the tick that just ran.
    for (const id of PLAYER_IDS) {
      const by = session.host.blockedBy(id);
      if (by !== null) bodyBlocks.push({ id, tick: k, by });
    }
  }
  // Everything else comes from the logged lines (parsed once, after the loop).
  const log = session.log();
  for (let i = 0; i < log.length; i++) {
    const e = log.at(i);
    if (e === null || e.observe.tick !== i) throw new Error(`runHarness: expected observe tick ${i}, got ${String(e?.observe.tick)}`);
    entries.push(e);
    positions.push(positionsAfter(e));
    if (i === 0) continue;
    e.act.actions.forEach((a, j) => {
      if (a.type !== 'teleport') return;
      const next = e.act.actions[j + 1];
      snaps.push({ id: a.id, tick: i, text: next !== undefined && next.type === 'log' ? next.text : null });
    });
  }
  const t2 = performance.now();
  return {
    options,
    data,
    session,
    model: session.model,
    core: session.core,
    host: session.host,
    log: session.log(),
    entries,
    ticks: entries.length,
    lastTick: last,
    positions,
    snaps,
    bodyBlocks,
    walk: recorder === null ? null : recorder.calls,
    warnings,
    ms: { construct: t1 - t0, ticks: t2 - t1 },
  };
}

// ---------------------------------------------------------------------------
// What happened (from the logged lines)
// ---------------------------------------------------------------------------

export interface DeathSeen {
  readonly tick: number;
  readonly victim: PlayerId;
  readonly attacker: PlayerId | null;
  readonly weapon: WeaponId | null;
  readonly headshot: boolean;
}

/** Every `death` event, at the tick of the observe it is in. */
export function deaths(entries: readonly LogEntry[]): DeathSeen[] {
  const out: DeathSeen[] = [];
  for (const { observe: o } of entries) {
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
export function hpChanges(entries: readonly LogEntry[], id: PlayerId): HpChange[] {
  const out: HpChange[] = [];
  for (const { observe: o } of entries) {
    const p = o.pawns.find((q) => q.id === id);
    if (p === undefined) continue;
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
export function shots(entries: readonly LogEntry[]): ShotSeen[] {
  const out: ShotSeen[] = [];
  for (const { observe: o } of entries) for (const e of o.events) if (e.type === 'shot') out.push({ tick: o.tick, shooter: e.shooter, weapon: e.weapon });
  return out;
}

export interface ButtonSpan {
  readonly from: number;
  readonly to: number;
}

/** Act ticks at which `id`'s Core input holds `button`, as inclusive spans. */
export function buttonSpans(entries: readonly LogEntry[], id: PlayerId, button: Button): ButtonSpan[] {
  const out: ButtonSpan[] = [];
  let open: number | null = null;
  let last = -1;
  for (const e of entries) {
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

export interface RoundEventSeen {
  readonly tick: number;
  /** `bomb <phase>` or `round_end`. */
  readonly kind: string;
  readonly text: string;
}

/** Every `bomb` and `round_end` event, at the tick of the observe it is in. */
export function roundEvents(entries: readonly LogEntry[]): RoundEventSeen[] {
  const out: RoundEventSeen[] = [];
  for (const { observe: o } of entries) {
    for (const e of o.events) {
      if (e.type === 'bomb') out.push({ tick: o.tick, kind: `bomb ${e.phase}`, text: `${e.phase} by ${e.id ?? '-'}` });
      if (e.type === 'round_end') out.push({ tick: o.tick, kind: 'round_end', text: `${e.winner} ${e.reason}` });
    }
  }
  return out;
}

/** Core actions of one type, with their tick. */
export function actionsOfType(entries: readonly LogEntry[], type: Action['type']): { tick: number; action: Action }[] {
  const out: { tick: number; action: Action }[] = [];
  for (const e of entries) for (const a of e.act.actions) if (a.type === type) out.push({ tick: e.observe.tick, action: a });
  return out;
}

/** Core `log` actions, with their tick. */
export function coreLogs(entries: readonly LogEntry[]): { tick: number; level: string; text: string }[] {
  const out: { tick: number; level: string; text: string }[] = [];
  for (const e of entries) for (const a of e.act.actions) if (a.type === 'log') out.push({ tick: e.observe.tick, level: a.level, text: a.text });
  return out;
}

export interface ModeChange {
  readonly tick: number;
  readonly mode: Mode;
}

/** A pawn's Core mode (act.status) on the first logged tick and at every change after it. */
export function modeChanges(entries: readonly LogEntry[], id: PlayerId): ModeChange[] {
  const out: ModeChange[] = [];
  for (const e of entries) {
    const s = e.act.status.find((q) => q.id === id);
    if (s === undefined) continue;
    const last = out[out.length - 1];
    if (last === undefined || last.mode !== s.mode) out.push({ tick: e.observe.tick, mode: s.mode });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drift against the recording
// ---------------------------------------------------------------------------

export interface ErrorStats {
  readonly samples: number;
  readonly rms: number;
  readonly max: number;
  /** t of the max error (s), or null without samples. */
  readonly maxT: number | null;
}

export interface DriftRow {
  readonly id: PlayerId;
  readonly team: Team;
  /** The human pawn (its drift is the script's, not the Core's). */
  readonly human: boolean;
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
  /** Last measured tick: the recorded death tick, the track's last sample or the run's last tick, whichever is first. */
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
function pawnAt(run: HarnessRun, idx: number, t: number): Vec3 {
  const f = t * 64;
  const k0 = Math.min(run.positions.length - 1, Math.floor(f));
  const k1 = Math.min(run.positions.length - 1, k0 + 1);
  const a = (run.positions[k0] as Vec3[])[idx] as Vec3;
  const b = (run.positions[k1] as Vec3[])[idx] as Vec3;
  const u = f - k0;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u };
}

/**
 * Per pawn, the 2D error against the **raw** recording at every 10 Hz sample up to its recorded death (or last
 * sample, or the end of the run), with the pawn interpolated between the ticks around the sample time; and the share
 * of ticks more than BEHIND_UNITS behind. docs/core.md "Ghost round".
 */
export function measureDrift(run: HarnessRun): DriftRow[] {
  const rows: DriftRow[] = [];
  PLAYER_IDS.forEach((id, idx) => {
    const p = run.model.player(id);
    const samples = run.model.track(id);
    const death = p.deathTick;
    const last = samples[samples.length - 1] as { tick: number };
    const lastTick = Math.min(death === null ? last.tick : Math.min(death, last.tick), run.lastTick);
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
      human: id === run.options.human,
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

/** Markdown table of the drift (units), as in docs/core.md "Ghost round". */
export function driftTable(rows: readonly DriftRow[]): string {
  const lines = [
    '| player | team | observed n | RMS | max (at t) | est./inf. n | RMS | max (at t) | inferred RMS | radius (min–max) | snaps (t) | ticks > 24 behind |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
  ];
  for (const r of rows) {
    const radius = r.radiusMin === null ? '–' : r.radiusMin === r.radiusMax ? `${r.radiusMin}` : `${r.radiusMin}–${r.radiusMax}`;
    const inf = r.inferred.samples === 0 ? '–' : r.inferred.rms.toFixed(1);
    const snaps = r.snaps.length === 0 ? '0' : `${r.snaps.length} (${r.snaps.map((k) => (k / 64).toFixed(2)).join(', ')})`;
    lines.push(`| ${r.id}${r.human ? ' (human)' : ''} | ${r.team} | ${cell(r.observed)} | ${cell(r.other)} | ${inf} | ${radius} | ${snaps} | ${r.behindPct.toFixed(1)} % |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface HarnessSummary {
  readonly human: PlayerId | null;
  readonly script: string | null;
  readonly seed: number;
  readonly ticks: number;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly digest: string;
  readonly deaths: readonly DeathSeen[];
  readonly bomb: readonly { tick: number; phase: string; id: PlayerId | null }[];
  readonly roundEnd: readonly { tick: number; winner: Team; reason: string }[];
  /** `observe.round` of the last logged tick. */
  readonly finalRound: RoundObs | null;
  readonly modes: readonly { id: PlayerId; final: Mode; sinceTick: number; everLive: boolean; changes: readonly ModeChange[] }[];
  readonly snaps: readonly Snap[];
  readonly bodyBlocks: readonly BodyBlock[];
  /** Plant / defuse_start fallback actions (the engine didn't do it on time). */
  readonly fallbacks: readonly { tick: number; type: string; id: PlayerId }[];
  readonly coreLogs: readonly { tick: number; level: string; text: string }[];
  /** Actions the host received but did not apply. */
  readonly hostNotes: readonly { tick: number; type: string; reason: string }[];
  readonly drift: readonly {
    id: PlayerId;
    team: Team;
    human: boolean;
    observedN: number;
    observedRms: number;
    observedMax: number;
    inferredN: number;
    inferredRms: number;
    radiusMin: number | null;
    otherN: number;
    otherRms: number;
    behindPct: number;
    snaps: number;
  }[];
  readonly warnings: readonly string[];
}

export function summarize(run: HarnessRun, scriptName: string | null = null): HarnessSummary {
  const e = run.entries;
  const lastObs: Observe | null = e[e.length - 1]?.observe ?? null;
  const bomb: { tick: number; phase: string; id: PlayerId | null }[] = [];
  const roundEnd: { tick: number; winner: Team; reason: string }[] = [];
  for (const { observe: o } of e) {
    for (const ev of o.events) {
      if (ev.type === 'bomb') bomb.push({ tick: o.tick, phase: ev.phase, id: ev.id });
      if (ev.type === 'round_end') roundEnd.push({ tick: o.tick, winner: ev.winner, reason: ev.reason });
    }
  }
  const lastAct: Act | null = e[e.length - 1]?.act ?? null;
  const modes = PLAYER_IDS.map((id) => {
    const changes = modeChanges(e, id);
    const st = lastAct?.status.find((s) => s.id === id);
    return { id, final: st?.mode ?? ('REPLAY' as Mode), sinceTick: st?.sinceTick ?? 0, everLive: changes.some((c) => c.mode === 'LIVE'), changes };
  });
  const fallbacks = [...actionsOfType(e, 'plant'), ...actionsOfType(e, 'defuse_start')]
    .map((x) => ({ tick: x.tick, type: x.action.type, id: (x.action as { id: PlayerId }).id }))
    .sort((a, b) => a.tick - b.tick);
  return {
    human: run.options.human,
    script: scriptName,
    seed: run.options.seed,
    ticks: run.ticks,
    firstTick: e[0]?.observe.tick ?? 0,
    lastTick: lastObs?.tick ?? -1,
    digest: logDigest(run.log),
    deaths: deaths(e),
    bomb,
    roundEnd,
    finalRound: lastObs?.round ?? null,
    modes,
    snaps: run.snaps,
    bodyBlocks: run.bodyBlocks,
    fallbacks,
    coreLogs: coreLogs(e),
    hostNotes: run.host
      .unhandled()
      .filter((n) => n.kind === 'action')
      .map((n) => ({ tick: n.tick, type: n.type, reason: n.reason })),
    drift: measureDrift(run).map((r) => ({
      id: r.id,
      team: r.team,
      human: r.human,
      observedN: r.observed.samples,
      observedRms: r.observed.rms,
      observedMax: r.observed.max,
      inferredN: r.inferred.samples,
      inferredRms: r.inferred.rms,
      radiusMin: r.radiusMin,
      otherN: r.other.samples,
      otherRms: r.other.rms,
      behindPct: r.behindPct,
      snaps: r.snaps.length,
    })),
    warnings: run.warnings,
  };
}

/** Pretty JSON with canonical numbers and sorted keys (stable bytes). */
export function prettyStable(value: unknown): string {
  return JSON.stringify(JSON.parse(stableStringify(value)), null, 2) + '\n';
}

/** Write log.jsonl, trace.json and summary.json into `dir`. */
export function writeOutputs(dir: string, run: HarnessRun, summary: HarnessSummary): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'log.jsonl'), run.log.toText(), 'utf8');
  writeFileSync(resolve(dir, 'trace.json'), stableStringify(toReplayTrace(run.log)) + '\n', 'utf8');
  writeFileSync(resolve(dir, 'summary.json'), prettyStable(summary), 'utf8');
}

/** Human-readable summary lines. */
export function describeSummary(s: HarnessSummary): string {
  const sec = (k: number): string => (k / 64).toFixed(2);
  const lines = [
    `human ${s.human ?? 'none'}${s.script === null ? '' : ` (script ${s.script})`}, seed ${s.seed}: ${s.ticks} ticks (${s.firstTick}–${s.lastTick}), digest ${s.digest}`,
  ];
  for (const d of s.deaths) lines.push(`  death  ${String(d.tick).padStart(5)} (${sec(d.tick)} s) ${d.attacker ?? 'world'} -> ${d.victim} ${d.weapon ?? ''}${d.headshot ? ' HS' : ''}`);
  for (const b of s.bomb) lines.push(`  bomb   ${String(b.tick).padStart(5)} (${sec(b.tick)} s) ${b.phase} ${b.id ?? ''}`);
  for (const r of s.roundEnd) lines.push(`  end    ${String(r.tick).padStart(5)} (${sec(r.tick)} s) ${r.winner} ${r.reason}`);
  if (s.finalRound !== null) lines.push(`  final round: ${s.finalRound.phase}, score CT ${s.finalRound.score.ct} – T ${s.finalRound.score.t}, ${s.finalRound.timeLeftSec} s left`);
  lines.push(`  modes: ${s.modes.map((m) => `${m.id} ${m.final}${m.everLive ? ' (was LIVE)' : ''}`).join(', ')}`);
  lines.push(`  snaps ${s.snaps.length}: ${s.snaps.map((x) => `${x.id}@${x.tick}`).join(' ') || '-'}; body blocks ${s.bodyBlocks.length}; fallbacks ${s.fallbacks.length}; host notes ${s.hostNotes.length}`);
  for (const w of s.warnings) lines.push(`  warning: ${w}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  readonly human: PlayerId | null;
  readonly script: string | null;
  /** Seconds or 'end'. */
  readonly until: number | 'end';
  readonly seed: number;
  readonly out: string | null;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let human: PlayerId | null = null;
  let script: string | null = null;
  let until: number | 'end' = 'end';
  let seed = DEFAULT_SEED;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag}: missing value`);
      return v;
    };
    switch (flag) {
      case '--human': {
        const v = value();
        if (v === 'none') human = null;
        else if (isPlayerId(v)) human = v;
        else throw new Error(`--human: expected none or a player id (cart), got ${v}`);
        break;
      }
      case '--script':
        script = value();
        break;
      case '--until': {
        const v = value();
        if (v === 'end') until = 'end';
        else if (Number.isFinite(Number(v)) && Number(v) >= 0) until = Number(v);
        else throw new Error(`--until: expected seconds or end, got ${v}`);
        break;
      }
      case '--seed': {
        const v = Number(value());
        if (!Number.isInteger(v)) throw new Error('--seed: expected an integer');
        seed = v;
        break;
      }
      case '--out':
        out = value();
        break;
      default:
        throw new Error(`unknown option ${flag} (options: --human none|cart, --script <path>, --until <t|end>, --seed <n>, --out <dir>)`);
    }
  }
  if (script !== null && human === null) throw new Error('--script needs --human (e.g. --human cart)');
  return { human, script, until, seed, out };
}

/** Harness options for parsed CLI arguments (reads the script file). */
export function optionsFromArgs(args: CliArgs): HarnessOptions {
  const driver = args.script === null || args.human === null ? null : new ScriptDriver(parseHumanScript(readFileSync(resolve(args.script), 'utf8')), args.human);
  return { human: args.human, driver, lastTick: args.until === 'end' ? 'end' : tickOf(args.until), seed: args.seed };
}

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const t0 = performance.now();
  const data = loadHarnessData();
  const t1 = performance.now();
  const run = runHarness(data, optionsFromArgs(args));
  const t2 = performance.now();
  const summary = summarize(run, args.script);
  const t3 = performance.now();
  if (args.out !== null) writeOutputs(resolve(args.out), run, summary);
  const t4 = performance.now();
  console.log(describeSummary(summary));
  console.log(`\n${driftTable(measureDrift(run))}\n`);
  if (args.out !== null) console.log(`wrote ${resolve(args.out)}/{log.jsonl,trace.json,summary.json}`);
  const ms = (x: number): string => `${x.toFixed(0)} ms`;
  console.log(
    `time: data ${ms(t1 - t0)}, session ${ms(run.ms.construct)}, ${run.ticks} ticks ${ms(run.ms.ticks)} (${((run.ms.ticks * 1000) / run.ticks).toFixed(0)} µs/tick), ` +
      `summary ${ms(t3 - t2)}${args.out === null ? '' : `, outputs ${ms(t4 - t3)}`}; round (session + ticks + summary) ${ms(run.ms.construct + run.ms.ticks + (t3 - t2))}, total ${ms(t4 - t0)} since start-up`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
