/**
 * Human-bot (B4): a scripted "human" for scenario tests and the harness. It produces the human pawn's per-tick
 * input from high-level commands, never through the Core (the Core sends the human nothing; this plays the human):
 *
 *   followRecording(untilT)  play the pawn's own recording until t (a shadow puppet, as tools/follow-script.ts)
 *   walkTo(pos, walk?)       walk there: straight if the 2D line is walkable, else along a nav path
 *   aimAt(id, band?, offsetDeg?)  look at a pawn's head (or another band) with B3's aim math, until changed; null =
 *                            stop. G1: `offsetDeg` (default 0) aims that many degrees left (+) of it, so a spray misses
 *   fire(untilDead, maxSec)  hold ATTACK while the aim target is in sight and the aim is on it
 *   holdStill(sec | until)   no stick (the aim, if any, goes on)
 *   throw(kind, at)          draw a grenade, look at a point with the pitch that lands it there, pull and release
 *   teleport(pos, yaw)       scenario setup only: an engine-side teleport (not in the logged Act, like the human's own
 *                            movement; the logged observes carry it, so the log still replays)
 *   weapon(weapon)           switch weapon (the app's weapon-slot keys)
 *
 * Steps run one after the other; `teleport`, `aimAt` and `weapon` take no time. Scenario files
 * (`fixtures/scenarios/*.json`) are `{name, description, human, seed, until, takeover?, steps: [{do: <command>, …}]}`;
 * `npm run harness -- --scenario <file>` runs one, tests/scenarios.test.ts asserts them. G4: `takeover` (seconds) has
 * nobody play until then (the no-human round), where the human takes control of his pawn as the puppet left it; the
 * steps start on that tick (aim and view from where the puppet looked). Absent or null: the human plays from tick 0.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PLAYER_IDS,
  canonicalize,
  isPlayerId,
  type Button,
  type GrenadeId,
  type LogEntry,
  type Observe,
  type PawnInput,
  type PawnObs,
  type PlayerId,
  type Tuning,
  type Vec3,
  type WeaponId,
} from '../src/contracts/index';
import {
  AIM_BANDS,
  EventSchedule,
  ReplayCore,
  RoundModel,
  bandPoint,
  bearing,
  ceilTicks,
  dist2,
  lookToward,
  maxSpeedOf,
  pitchTo,
  roundYaw,
  startYaw,
  stickToward,
  tickOf,
  turnToward,
  yawDelta,
  type AimBand,
  type Look,
} from '../src/core/index';
import { gunStats, throwElevation, type MapGeometry, type NavMesh } from '../src/sim2d/index';
import { aimAtLanding } from '../src/engine/grenades/index';
import { MeshGrenadeWorld } from '../src/sim3d/grenades';
import { walkQueryOf } from '../src/app/index';
import type { Session, SessionData } from '../src/app/index';
import { FollowAim } from './follow-aim';
import { parseMapId, type MapId } from '../src/contracts/maps';
import type { HumanCommand, HumanDriver } from './harness';

/** A step's position: [x, y] (z from the nav floor). */
export type XY = readonly [number, number];

export type BotStep =
  | { readonly do: 'followRecording'; readonly until: number }
  | { readonly do: 'walkTo'; readonly pos: XY; readonly walk: boolean }
  | { readonly do: 'aimAt'; readonly id: PlayerId | null; readonly band: AimBand; readonly offsetDeg: number }
  | { readonly do: 'fire'; readonly untilDead: boolean; readonly maxSec: number }
  | { readonly do: 'holdStill'; readonly sec: number | null; readonly until: number | null }
  | { readonly do: 'throw'; readonly kind: GrenadeId; readonly at: XY }
  | { readonly do: 'teleport'; readonly pos: XY; readonly yaw: number }
  | { readonly do: 'weapon'; readonly weapon: WeaponId };

export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly human: PlayerId;
  readonly seed: number;
  /** Last observe tick to run: seconds (tick round(t × 64)) or 'end'. */
  readonly until: number | 'end';
  /** G4: seconds; the human takes control on tick round(t × 64) (nobody plays before), or null: from the start. */
  readonly takeover: number | null;
  readonly steps: readonly BotStep[];
  /** X1: the map package the scenario runs on (docs/maps.md), or null: the harness's `--map` / the default. */
  readonly map: MapId | null;
}

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioError';
  }
}

const GRENADES: readonly GrenadeId[] = ['smoke', 'flash', 'he', 'molotov'];
const WEAPONS: readonly WeaponId[] = ['ak47', 'awp', 'ssg08', 'deagle', 'm4a4', 'glock', 'knife', 'c4', 'smoke', 'flash', 'he', 'molotov'];
/** A waypoint (or walkTo's goal) counts as reached within this distance (units, 2D). */
const ARRIVE_UNITS = 16;
/** The aim is on target when the look is within this of the target's band point (degrees, yaw and pitch). */
const AIM_ON_DEG = 0.5;

function num(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ScenarioError(`${where}: expected a number`);
  return v;
}

function xy(v: unknown, where: string): XY {
  if (!Array.isArray(v) || v.length !== 2) throw new ScenarioError(`${where}: expected [x, y]`);
  return [num(v[0], `${where}[0]`), num(v[1], `${where}[1]`)];
}

function keys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ScenarioError(`${where}: unknown key "${k}"`);
}

/** Validate one step (`{do, …}`); defaults: walkTo walk false, aimAt band head and offsetDeg 0, fire untilDead true / maxSec 3. */
export function parseStep(v: unknown, where: string): BotStep {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ScenarioError(`${where}: expected an object`);
  const o = v as Record<string, unknown>;
  switch (o['do']) {
    case 'followRecording':
      keys(o, ['do', 'until'], where);
      return { do: 'followRecording', until: num(o['until'], `${where}.until`) };
    case 'walkTo':
      keys(o, ['do', 'pos', 'walk'], where);
      return { do: 'walkTo', pos: xy(o['pos'], `${where}.pos`), walk: o['walk'] === true };
    case 'aimAt': {
      keys(o, ['do', 'id', 'band', 'offsetDeg'], where);
      const id = o['id'];
      if (id !== null && (typeof id !== 'string' || !isPlayerId(id))) throw new ScenarioError(`${where}.id: expected a player id or null`);
      const band = o['band'] ?? 'head';
      if (!(AIM_BANDS as readonly unknown[]).includes(band)) throw new ScenarioError(`${where}.band: expected ${AIM_BANDS.join(' ')}`);
      const offsetDeg = o['offsetDeg'] === undefined ? 0 : num(o['offsetDeg'], `${where}.offsetDeg`);
      return { do: 'aimAt', id, band: band as AimBand, offsetDeg };
    }
    case 'fire':
      keys(o, ['do', 'untilDead', 'maxSec'], where);
      return { do: 'fire', untilDead: o['untilDead'] !== false, maxSec: o['maxSec'] === undefined ? 3 : num(o['maxSec'], `${where}.maxSec`) };
    case 'holdStill': {
      keys(o, ['do', 'sec', 'until'], where);
      const sec = o['sec'] === undefined ? null : num(o['sec'], `${where}.sec`);
      const until = o['until'] === undefined ? null : num(o['until'], `${where}.until`);
      if ((sec === null) === (until === null)) throw new ScenarioError(`${where}: give exactly one of sec, until`);
      return { do: 'holdStill', sec, until };
    }
    case 'throw': {
      keys(o, ['do', 'kind', 'at'], where);
      const kind = o['kind'];
      if (!(GRENADES as readonly unknown[]).includes(kind)) throw new ScenarioError(`${where}.kind: expected ${GRENADES.join(' ')}`);
      return { do: 'throw', kind: kind as GrenadeId, at: xy(o['at'], `${where}.at`) };
    }
    case 'teleport':
      keys(o, ['do', 'pos', 'yaw'], where);
      return { do: 'teleport', pos: xy(o['pos'], `${where}.pos`), yaw: num(o['yaw'], `${where}.yaw`) };
    case 'weapon': {
      keys(o, ['do', 'weapon'], where);
      const w = o['weapon'];
      if (!(WEAPONS as readonly unknown[]).includes(w)) throw new ScenarioError(`${where}.weapon: unknown weapon ${String(w)}`);
      return { do: 'weapon', weapon: w as WeaponId };
    }
    default:
      throw new ScenarioError(`${where}.do: unknown command ${String(o['do'])}`);
  }
}

/** Validate a scenario (JSON value or text). */
export function parseScenario(json: unknown): Scenario {
  const v = typeof json === 'string' ? (JSON.parse(json) as unknown) : json;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ScenarioError('scenario: expected an object');
  const o = v as Record<string, unknown>;
  keys(o, ['name', 'description', 'human', 'seed', 'until', 'takeover', 'steps', 'map'], 'scenario');
  const human = o['human'] ?? 'cart';
  if (typeof human !== 'string' || !isPlayerId(human)) throw new ScenarioError('scenario.human: expected a player id');
  const until = o['until'] ?? 'end';
  if (until !== 'end') num(until, 'scenario.until');
  const steps = o['steps'];
  if (!Array.isArray(steps)) throw new ScenarioError('scenario.steps: expected an array');
  const takeover = o['takeover'] ?? null;
  if (takeover !== null && num(takeover, 'scenario.takeover') < 0) throw new ScenarioError('scenario.takeover: expected seconds >= 0');
  return {
    name: typeof o['name'] === 'string' ? o['name'] : '',
    description: typeof o['description'] === 'string' ? o['description'] : '',
    human,
    seed: o['seed'] === undefined ? 1 : num(o['seed'], 'scenario.seed'),
    until: until as number | 'end',
    takeover: takeover as number | null,
    steps: steps.map((s: unknown, i) => parseStep(s, `scenario.steps[${i}]`)),
    map: mapOf(o['map']),
  };
}

function mapOf(v: unknown): MapId | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new ScenarioError('scenario.map: expected a map package id');
  try {
    return parseMapId(v);
  } catch (e) {
    throw new ScenarioError(`scenario.map: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function loadScenario(path: string): Scenario {
  return parseScenario(readFileSync(resolve(path), 'utf8'));
}

/** Per-step run state. */
interface Running {
  readonly index: number;
  readonly startTick: number;
  /** walkTo: the nav path (first = start); its next waypoint. */
  path: Vec3[] | null;
  next: number;
  /** throw: tick the grenade is drawn, the pull starts, the release. */
  drawnTick: number | null;
  pullTick: number | null;
  releaseTick: number | null;
  previous: WeaponId | null;
  /** throw (S1 / V5): the grenade's look solved on the CS2 grenade engine (the hosts' grenades), or null. */
  aim: Look | null;
}

/**
 * The scripted human (a HumanDriver). Build it with the session data and its steps, either from a Scenario or with the
 * chainable methods (`new HumanBot(data, 'cart').followRecording(18).aimAt('lokier').fire(true, 2)`).
 */
export class HumanBot implements HumanDriver {
  readonly id: PlayerId;
  readonly steps: BotStep[] = [];
  /** One line per step as it starts and ends (`t 18.00 walkTo (-1764, 800) start`), for the timeline. */
  readonly trace: string[] = [];
  private readonly nav: NavMesh;
  private readonly tuning: Tuning;
  /** S1 / V5: the world mesh grenades fly through, or null (2D). */
  private readonly world: MapGeometry | null;
  private readonly model: RoundModel;
  /** Shadow puppet for followRecording: a ReplayCore without divergence that sees the human as a puppet; never snaps. */
  private readonly shadow: ReplayCore;
  /** Where the recording shows him missing, followRecording looks where it has him looking (tools/follow-aim.ts). */
  private readonly followAim: FollowAim;
  private shadowInput: PawnInput | null = null;
  private shadowWeapon: WeaponId | null = null;
  private cur: Running | null = null;
  private nextIndex = 0;
  private look: { id: PlayerId; band: AimBand; offsetDeg: number } | null = null;
  private yaw: number;
  private pitch = 0;
  /** G4: false until the first tick the session has a human (a takeover: the steps start there). */
  private playing = false;

  constructor(data: SessionData, id: PlayerId, seed = 1) {
    this.id = id;
    this.nav = data.nav;
    this.tuning = data.tuning;
    this.world = data.world ?? data.geometry ?? null;
    this.model = new RoundModel(data.round);
    const tuning: Tuning = { ...data.tuning, replay: { ...data.tuning.replay, driftSnapUnits: 1e9 } };
    const schedule = new EventSchedule(data.round);
    this.shadow = new ReplayCore(this.model, schedule, tuning, seed, walkQueryOf(data), { divergence: false });
    this.shadow.control({ type: 'start' });
    this.followAim = new FollowAim(data.round, this.model, schedule, data.tuning, this.shadow.script.plan, id);
    this.yaw = startYaw(this.model, id).yaw;
  }

  static fromScenario(data: SessionData, s: Scenario): HumanBot {
    const bot = new HumanBot(data, s.human, s.seed);
    for (const step of s.steps) bot.steps.push(step);
    return bot;
  }

  followRecording(untilT: number): this {
    this.steps.push({ do: 'followRecording', until: untilT });
    return this;
  }
  walkTo(pos: XY, walk = false): this {
    this.steps.push({ do: 'walkTo', pos, walk });
    return this;
  }
  aimAt(id: PlayerId | null, band: AimBand = 'head', offsetDeg = 0): this {
    this.steps.push({ do: 'aimAt', id, band, offsetDeg });
    return this;
  }
  fire(untilDead = true, maxSec = 3): this {
    this.steps.push({ do: 'fire', untilDead, maxSec });
    return this;
  }
  holdStill(sec: number): this {
    this.steps.push({ do: 'holdStill', sec, until: null });
    return this;
  }
  holdUntil(t: number): this {
    this.steps.push({ do: 'holdStill', sec: null, until: t });
    return this;
  }
  throw(kind: GrenadeId, at: XY): this {
    this.steps.push({ do: 'throw', kind, at });
    return this;
  }
  teleport(pos: XY, yaw: number): this {
    this.steps.push({ do: 'teleport', pos, yaw });
    return this;
  }
  weapon(weapon: WeaponId): this {
    this.steps.push({ do: 'weapon', weapon });
    return this;
  }

  /** True once every step has finished. */
  get finished(): boolean {
    return this.cur === null && this.nextIndex >= this.steps.length;
  }

  command(tick: number, session: Session): HumanCommand {
    let o = canonicalize(session.observe());
    if (o.tick !== tick) throw new Error(`HumanBot: observe tick ${o.tick}, expected ${tick}`);
    this.stepShadow(o);
    // G4: before a takeover nobody plays (the shadow still sees every tick); from it, the view is where the puppet left it.
    if (o.human === null) return { input: null, weapon: null };
    const me = pawn(o, this.id);
    if (!this.playing) {
      this.playing = true;
      if (tick > 0 && me !== undefined) {
        this.yaw = roundYaw(me.yaw);
        this.pitch = me.pitch;
      }
    }
    // The setup tick's observe predates the setup: hold still at the setup yaw.
    if (tick === 0 || me === undefined) return { input: this.neutral(), weapon: null };
    if (!me.alive) return { input: null, weapon: null };
    let weapon: WeaponId | null = null;
    for (let guard = 0; guard < 1000; guard++) {
      if (this.cur === null) {
        if (this.nextIndex >= this.steps.length) return { input: this.idle(o, me), weapon };
        this.cur = { index: this.nextIndex++, startTick: tick, path: null, next: 1, drawnTick: null, aim: null, pullTick: null, releaseTick: null, previous: null };
        this.note(tick, 'start');
      }
      const step = this.steps[this.cur.index] as BotStep;
      // Steps that take no time.
      if (step.do === 'teleport') {
        const pos = { x: step.pos[0], y: step.pos[1], z: this.nav.zAt({ x: step.pos[0], y: step.pos[1] }) };
        session.host.apply({ inputs: [], actions: [{ type: 'teleport', id: this.id, pos, yaw: step.yaw }], status: [] });
        this.yaw = roundYaw(step.yaw);
        o = canonicalize(session.observe());
        this.end(tick);
        continue;
      }
      if (step.do === 'aimAt') {
        this.look = step.id === null ? null : { id: step.id, band: step.band, offsetDeg: step.offsetDeg };
        this.end(tick);
        continue;
      }
      if (step.do === 'weapon') {
        weapon = step.weapon;
        this.end(tick);
        continue;
      }
      const mine = pawn(o, this.id) as PawnObs;
      const r = this.run(step, this.cur, tick, o, mine);
      if (r.weapon !== null) weapon = r.weapon;
      if (r.done) {
        this.end(tick);
        if (r.input === null) continue;
      }
      if (r.input !== null) {
        this.yaw = r.input.yaw;
        this.pitch = r.input.pitch;
        return { input: r.input, weapon };
      }
    }
    throw new Error('HumanBot: too many steps finished on one tick');
  }

  private note(tick: number, what: string): void {
    if (this.cur === null) return;
    this.trace.push(`t ${(tick / 64).toFixed(2)} ${describeStep(this.steps[this.cur.index] as BotStep)} ${what}`);
  }

  private end(tick: number): void {
    this.note(tick, 'done');
    this.cur = null;
  }

  /** Steps the shadow puppet while a followRecording step is still to come (it has to see every tick from 0). */
  private stepShadow(o: Observe): void {
    const need = this.steps.some((s, i) => s.do === 'followRecording' && i >= (this.cur?.index ?? this.nextIndex));
    if (!need) {
      this.shadowInput = null;
      this.shadowWeapon = null;
      return;
    }
    const act = canonicalize(this.shadow.step({ ...o, human: null }));
    const input = act.inputs.find((q) => q.id === this.id) ?? null;
    this.shadowInput = input === null ? null : this.followAim.adjust(o.tick, input);
    this.shadowWeapon = null;
    if (o.tick > 0) for (const a of act.actions) if (a.type === 'set_weapon' && a.id === this.id) this.shadowWeapon = a.weapon;
  }

  private neutral(): PawnInput {
    return { id: this.id, forward: 0, side: 0, yaw: this.yaw, pitch: this.pitch, buttons: [] };
  }

  /** After the last step: stand still, keeping the aim. */
  private idle(o: Observe, me: PawnObs): PawnInput {
    const look = this.aim(o, me);
    return { id: this.id, forward: 0, side: 0, yaw: look.yaw, pitch: look.pitch, buttons: [] };
  }

  /** The look for this tick: toward the aim target's band point (B3's lookToward, aimTurnRateDegPerTick), else held. */
  private aim(o: Observe, me: PawnObs): Look {
    const prev: Look = { yaw: this.yaw, pitch: this.pitch };
    if (this.look === null) return prev;
    const t = pawn(o, this.look.id);
    if (t === undefined || !t.alive) return prev;
    const d = this.tuning.damage;
    return lookToward(prev, me.pos, me.crouching, this.aimPoint(me, t), d, this.tuning.replay.aimTurnRateDegPerTick);
  }

  /** The aim target's band point, turned `offsetDeg` about the shooter (counter-clockwise: to its left). */
  private aimPoint(me: PawnObs, t: PawnObs): Vec3 {
    const look = this.look as { band: AimBand; offsetDeg: number };
    const p = bandPoint(t.pos, t.crouching, look.band, this.tuning.damage);
    if (look.offsetDeg === 0) return p;
    const a = (look.offsetDeg * Math.PI) / 180;
    const dx = p.x - me.pos.x;
    const dy = p.y - me.pos.y;
    return { x: me.pos.x + dx * Math.cos(a) - dy * Math.sin(a), y: me.pos.y + dx * Math.sin(a) + dy * Math.cos(a), z: p.z };
  }

  /** True when `look` is on the aim point (the target's band point, turned by the offset; within AIM_ON_DEG) and the target is in sight. */
  private onTarget(o: Observe, me: PawnObs, look: Look): boolean {
    if (this.look === null) return false;
    const t = pawn(o, this.look.id);
    if (t === undefined || !t.alive || !me.sees.includes(t.id)) return false;
    const d = this.tuning.damage;
    const p = this.aimPoint(me, t);
    return Math.abs(yawDelta(look.yaw, bearing(me.pos, p))) <= AIM_ON_DEG && Math.abs(look.pitch - pitchTo(me.pos, me.crouching, p, d)) <= AIM_ON_DEG;
  }

  private run(step: BotStep, cur: Running, tick: number, o: Observe, me: PawnObs): { input: PawnInput | null; weapon: WeaponId | null; done: boolean } {
    const el = tick - cur.startTick;
    switch (step.do) {
      case 'followRecording': {
        if (tick > tickOf(step.until)) return { input: null, weapon: null, done: true };
        const input = this.shadowInput ?? this.neutral();
        return { input: { ...input, id: this.id }, weapon: this.shadowWeapon, done: false };
      }
      case 'holdStill': {
        const end = step.until !== null ? tickOf(step.until) : cur.startTick + Math.round((step.sec ?? 0) * 64);
        if (tick >= end) return { input: null, weapon: null, done: true };
        return { input: this.idle(o, me), weapon: null, done: false };
      }
      case 'walkTo': {
        const goal = { x: step.pos[0], y: step.pos[1], z: this.nav.zAt({ x: step.pos[0], y: step.pos[1], z: me.pos.z }) };
        // Straight when the 2D line is walkable (as the puppets steer: drops and ledges count), else the nav path.
        if (cur.path === null) cur.path = this.nav.segmentWalkable(me.pos, goal) ? [me.pos, goal] : (this.nav.path(me.pos, goal) ?? [me.pos, goal]);
        if (dist2(me.pos, goal) <= ARRIVE_UNITS) return { input: null, weapon: null, done: true };
        const path = cur.path;
        while (cur.next < path.length - 1 && dist2(me.pos, path[cur.next] as Vec3) <= ARRIVE_UNITS) cur.next++;
        const wp = path[Math.min(cur.next, path.length - 1)] as Vec3;
        const look = this.look === null ? { yaw: turnToward(this.yaw, bearing(me.pos, wp), this.tuning.replay.maxTurnRateDegPerTick), pitch: 0 } : this.aim(o, me);
        const buttons: Button[] = step.walk ? ['WALK'] : [];
        const cap = maxSpeedOf(me.weapon, buttons, this.tuning.movement);
        const remaining = dist2(me.pos, goal);
        const scale = cap > 0 ? Math.min(1, remaining / (cap * this.tuning.replay.lookaheadSec)) : 0;
        const s = stickToward(wp.x - me.pos.x, wp.y - me.pos.y, look.yaw, scale);
        if (el > 64 * 30) return { input: null, weapon: null, done: true };
        return { input: { id: this.id, forward: s.forward, side: s.side, yaw: look.yaw, pitch: look.pitch, buttons }, weapon: null, done: false };
      }
      case 'fire': {
        const t = this.look === null ? null : pawn(o, this.look.id);
        if (step.untilDead && t !== null && t !== undefined && !t.alive) return { input: null, weapon: null, done: true };
        if (el >= Math.round(step.maxSec * 64)) return { input: null, weapon: null, done: true };
        const look = this.aim(o, me);
        const gun = gunStats(me.weapon, this.tuning);
        const ready = this.look === null || this.onTarget(o, me, look);
        // Automatic guns hold ATTACK; semi-automatic ones press on even ticks and release on odd ones.
        const press = ready && (gun === null || gun.automatic || el % 2 === 0);
        return { input: { id: this.id, forward: 0, side: 0, yaw: look.yaw, pitch: look.pitch, buttons: press ? ['ATTACK'] : [] }, weapon: null, done: false };
      }
      case 'throw': {
        const at = { x: step.at[0], y: step.at[1], z: me.pos.z };
        if (cur.drawnTick === null) {
          cur.drawnTick = tick;
          cur.previous = me.weapon;
          return { input: this.idle(o, me), weapon: step.kind, done: false };
        }
        // S1 / V5: every grenade flies on the CS2 grenade engine in the hosts (src/sim3d/grenades.ts): aim it on the world
        // mesh from where he stands (once; flat throws, -10...+20 deg, which stay under ceilings); runs without the mesh:
        // the 2D model's flat-ground pitch.
        if (this.world !== null && cur.aim === null) {
          const eye = { x: me.pos.x, y: me.pos.y, z: me.pos.z + (me.crouching ? this.tuning.damage.crouchEyeHeight : this.tuning.damage.eyeHeight) };
          const a = aimAtLanding({ type: step.kind, thrower: this.id, team: me.team, eye, velocity: { x: 0, y: 0, z: 0 } }, at, new MeshGrenadeWorld(this.world), { tuning: this.tuning.grenades.cs2 }, { strengths: [1], pitchMin: -10, pitchMax: 20 });
          cur.aim = { yaw: Math.round(a.yaw * 1000) / 1000, pitch: Math.round(a.pitch * 1000) / 1000 };
        }
        const want: Look = cur.aim ?? { yaw: bearing(me.pos, at), pitch: this.throwPitch(dist2(me.pos, at), me.crouching) };
        const rate = this.tuning.replay.aimTurnRateDegPerTick;
        const look: Look = { yaw: turnToward(this.yaw, want.yaw, rate), pitch: clampStep(this.pitch, want.pitch, rate) };
        const deployed = tick >= cur.drawnTick + ceilTicks(this.tuning.grenades.deploySec) + 1;
        const settled = Math.abs(yawDelta(look.yaw, want.yaw)) <= AIM_ON_DEG && Math.abs(look.pitch - want.pitch) <= AIM_ON_DEG;
        if (cur.pullTick === null && deployed && settled && me.weapon === step.kind) cur.pullTick = tick;
        const hold = Math.max(1, Math.round(this.tuning.replay.throwHoldSec * 64));
        if (cur.pullTick !== null && cur.releaseTick === null && tick >= cur.pullTick + hold) cur.releaseTick = tick;
        if (cur.releaseTick !== null && tick > cur.releaseTick) {
          return { input: null, weapon: cur.previous !== null && cur.previous !== step.kind ? cur.previous : null, done: true };
        }
        const pulling = cur.pullTick !== null && cur.releaseTick === null;
        if (el > 64 * 10) return { input: null, weapon: null, done: true };
        return { input: { id: this.id, forward: 0, side: 0, yaw: look.yaw, pitch: look.pitch, buttons: pulling ? ['ATTACK'] : [] }, weapon: null, done: false };
      }
      default:
        return { input: null, weapon: null, done: true };
    }
  }

  /**
   * The view pitch that throws a grenade `dist` units on flat ground (the 2D engine's flight, sim2d/grenades.ts): range
   * falls as the pitch goes down from 45° elevation, so bisect the pitch between that and straight down. Rounded to
   * 0.001°.
   */
  private throwPitch(dist: number, crouching: boolean): number {
    const g = this.tuning.grenades;
    const eye = crouching ? this.tuning.damage.crouchEyeHeight : this.tuning.damage.eyeHeight;
    const range = (pitch: number): number => {
      const e = (throwElevation(pitch, g) * Math.PI) / 180;
      const vx = g.throwSpeed * Math.cos(e);
      const vz = g.throwSpeed * Math.sin(e);
      return vx * ((vz + Math.sqrt(vz * vz + 2 * g.gravity * eye)) / g.gravity);
    };
    let lo = -((45 - g.throwPitchOffsetDeg) * 90) / (90 - g.throwPitchOffsetDeg); // 45° elevation
    let hi = 89;
    if (dist >= range(lo)) return Math.round(lo * 1000) / 1000;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (range(mid) > dist) lo = mid;
      else hi = mid;
    }
    return Math.round(((lo + hi) / 2) * 1000) / 1000;
  }
}

function clampStep(from: number, to: number, max: number): number {
  const d = to - from;
  return Math.round((from + (d > max ? max : d < -max ? -max : d)) * 1000) / 1000;
}

function pawn(o: Observe, id: PlayerId): PawnObs | undefined {
  return o.pawns.find((p) => p.id === id);
}

export function describeStep(s: BotStep): string {
  switch (s.do) {
    case 'followRecording':
      return `followRecording(${s.until})`;
    case 'walkTo':
      return `walkTo(${s.pos[0]}, ${s.pos[1]}${s.walk ? ', walk' : ''})`;
    case 'aimAt':
      return `aimAt(${s.id ?? 'none'}${s.band === 'head' ? '' : `, ${s.band}`}${s.offsetDeg === 0 ? '' : `, ${s.offsetDeg}°`})`;
    case 'fire':
      return `fire(${s.untilDead ? 'until dead, ' : ''}max ${s.maxSec} s)`;
    case 'holdStill':
      return s.until !== null ? `holdStill(until ${s.until})` : `holdStill(${s.sec ?? 0} s)`;
    case 'throw':
      return `throw(${s.kind} at ${s.at[0]}, ${s.at[1]})`;
    case 'teleport':
      return `teleport(${s.pos[0]}, ${s.pos[1]}, yaw ${s.yaw})`;
    case 'weapon':
      return `weapon(${s.weapon})`;
  }
}

// ---------------------------------------------------------------------------
// Timelines
// ---------------------------------------------------------------------------

export interface TimelineEvent {
  readonly tick: number;
  /**
   * `live`, `rejoin` (G1: heading back, or back on the tape), `death`, `encounter`, `bomb`, `round_end`, `dropped` (B3's
   * dropped scripted item), `takeover` (G4: the human took control of his pawn).
   */
  readonly kind: string;
  readonly text: string;
}

/**
 * The compact scenario timeline from a run's log: every switch to LIVE (the Core's log line, which names the trigger),
 * G1's rejoin lines (`<id> rejoin: …` when a LIVE pawn heads back, `<id> REPLAY: rejoined …` when it is back, and a
 * late plant), the encounters' log lines, B3's drops (`script: dropped …`), deaths, bomb events and the round end, in
 * tick order.
 */
export function timeline(entries: readonly LogEntry[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const e of entries) {
    const o = e.observe;
    for (const ev of o.events) {
      if (ev.type === 'death') out.push({ tick: o.tick, kind: 'death', text: `${ev.attacker ?? 'world'} killed ${ev.victim}${ev.weapon === null ? '' : ` (${ev.weapon}${ev.headshot ? ', HS' : ''})`}` });
      if (ev.type === 'bomb') out.push({ tick: o.tick, kind: 'bomb', text: `bomb ${ev.phase}${ev.id === null ? '' : ` by ${ev.id}`}` });
      if (ev.type === 'round_end') out.push({ tick: o.tick, kind: 'round_end', text: `round_end ${ev.winner} ${ev.reason}, score CT ${o.round.score.ct} – T ${o.round.score.t}` });
    }
    for (const a of e.act.actions) {
      if (a.type !== 'log') continue;
      if (/^[a-z0-9]+ LIVE: /.test(a.text)) out.push({ tick: o.tick, kind: 'live', text: a.text });
      else if (/^[a-z0-9]+ (REPLAY: rejoined|rejoin: )/.test(a.text) || a.text.startsWith('script: plant by ')) out.push({ tick: o.tick, kind: 'rejoin', text: a.text });
      else if (a.text.startsWith('encounter ')) out.push({ tick: o.tick, kind: 'encounter', text: a.text });
      else if (a.text.startsWith('takeover: ')) out.push({ tick: o.tick, kind: 'takeover', text: a.text });
      else if (a.text.startsWith('script: dropped')) out.push({ tick: o.tick, kind: 'dropped', text: a.text });
    }
  }
  return out;
}

export function formatTimeline(events: readonly TimelineEvent[]): string {
  return events.map((e) => `${(e.tick / 64).toFixed(2).padStart(6)} s  ${String(e.tick).padStart(4)}  ${e.kind.padEnd(9)} ${e.text}`).join('\n');
}

/**
 * Every switch to LIVE in a run, with the tick and trigger from the status (a pawn that rejoined its recording, G1,
 * can switch again: one entry per switch).
 */
export function liveSwitches(entries: readonly LogEntry[]): { id: PlayerId; tick: number; trigger: string | null }[] {
  const out: { id: PlayerId; tick: number; trigger: string | null }[] = [];
  for (const e of entries) {
    for (const s of e.act.status) {
      if (s.mode !== 'LIVE' || s.sinceTick !== e.observe.tick) continue;
      out.push({ id: s.id, tick: e.observe.tick, trigger: s.trigger });
    }
  }
  return out.sort((a, b) => a.tick - b.tick || PLAYER_IDS.indexOf(a.id) - PLAYER_IDS.indexOf(b.id));
}

/** G1: every rejoin (LIVE → REPLAY) in a run, from the status (mode REPLAY with trigger `rejoin` starting on its tick). */
export function rejoins(entries: readonly LogEntry[]): { id: PlayerId; tick: number }[] {
  const out: { id: PlayerId; tick: number }[] = [];
  for (const e of entries) {
    for (const s of e.act.status) if (s.mode === 'REPLAY' && s.trigger === 'rejoin' && s.sinceTick === e.observe.tick) out.push({ id: s.id, tick: e.observe.tick });
  }
  return out;
}
