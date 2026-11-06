/**
 * Sim2DHost: the 2D engine behind IHost. v0 = movement only (stepMove on the nav mesh) plus the
 * bookkeeping actions (teleport, set_hp, give, set_weapon, set_mode). Combat, bomb and round-end
 * actions and all Control messages are recorded in `unhandled()` instead of being dropped.
 *
 * Driver loop: observe() → core.step → apply(act) → tick(). IHost has no tick(); the app (or the
 * game, for the CS2 host) owns the clock.
 *
 * Deterministic: no randomness, no clocks, no object-key iteration. Acts and human input are
 * canonicalized on arrival and the state is rounded to the log's 6 decimals after every tick, so
 * observe() is already canonical, a session log fully determines the trajectory, and snapshot() is
 * an exact JSON round-trip.
 */
import {
  canonicalize,
  compareOrdinal,
  isPlayerId,
  roundNumber,
  toJsonValue,
  type Act,
  type Ammo,
  type Control,
  type Goal,
  type HostSnapshot,
  type IHost,
  type JsonValue,
  type Observe,
  type PawnInput,
  type PawnObs,
  type PlayerId,
  type SettableMode,
  type Team,
  type Tuning,
  type Vec3,
  type WeaponId,
} from '../contracts/index';
import { TICKS_PER_SEC, TICK_DT, stepMove, type MoveState } from './movement';
import type { NavMesh } from './nav';

/** One pawn of the round: who and which side. The host does not read round.json itself. */
export interface RosterEntry {
  readonly id: PlayerId;
  readonly team: Team;
}

/**
 * One carried item. `item` is a string, not WeaponId, so items B1 adds to the contracts
 * (`glock`, `defuser`) are kept even before the shared types know them.
 */
export interface InventoryItem {
  readonly item: string;
  readonly clip: number;
  readonly reserve: number;
}

/** Per-pawn engine state (plain data; this is what snapshot() serializes). */
export interface PawnState {
  readonly id: PlayerId;
  readonly team: Team;
  move: MoveState;
  hp: number;
  armor: number;
  helmet: boolean;
  alive: boolean;
  /** Active item; ammo is the inventory entry for it. */
  weapon: WeaponId;
  /** Sorted by item (ordinal), one entry per item. */
  inventory: InventoryItem[];
  /** Recorded from set_mode; v0 does not act on it. */
  mode: SettableMode;
  goal: Goal | null;
}

/** Something the host received but did not (fully) apply. */
export interface HostNote {
  readonly tick: number;
  readonly kind: 'action' | 'control' | 'input';
  /** Action / control type (`damage`, `seek`, …) or `input`. */
  readonly type: string;
  readonly reason: string;
  /** The message as received (canonical JSON). */
  readonly data: JsonValue;
}

export const UNSUPPORTED_V0 = 'unsupported in v0';

const HOST_SNAPSHOT_VERSION = 1;
/** CS2 spawn state for a pawn before Core sets it up (game rules, not calibration). */
const SPAWN_HP = 100;
const SPAWN_WEAPON: WeaponId = 'knife';
/** Items that can be carried but not held. */
const NON_WIELDABLE: readonly string[] = ['defuser'];

/** Fields B1 adds to set_hp; read when present. */
interface SetHpExtras {
  readonly helmet?: unknown;
}

interface HostState {
  readonly version: number;
  readonly tick: number;
  readonly human: PlayerId | null;
  readonly humanInput: PawnInput | null;
  /** Core inputs from the last apply(), sorted by id. */
  readonly inputs: readonly PawnInput[];
  readonly pawns: readonly PawnState[];
}

export class Sim2DHost implements IHost {
  private readonly nav: NavMesh;
  private readonly tuning: Tuning;
  private tickNo = 0;
  private human: PlayerId | null = 'cart';
  private humanInput: PawnInput | null = null;
  private inputs: PawnInput[] = [];
  /** Sorted by id. */
  private pawns: PawnState[];
  private readonly notes: HostNote[] = [];

  constructor(nav: NavMesh, tuning: Tuning, roster: readonly RosterEntry[]) {
    if (roster.length === 0) throw new Error('Sim2DHost: empty roster');
    const seen = new Set<string>();
    for (const r of roster) {
      if (!isPlayerId(r.id)) throw new Error(`Sim2DHost: unknown player id ${String(r.id)}`);
      if (seen.has(r.id)) throw new Error(`Sim2DHost: duplicate player id ${r.id}`);
      seen.add(r.id);
    }
    this.nav = nav;
    this.tuning = tuning;
    this.pawns = [...roster].sort((a, b) => compareOrdinal(a.id, b.id)).map((r) => spawnPawn(r));
  }

  // ---- IHost ---------------------------------------------------------------------------------

  observe(): Observe {
    return {
      tick: this.tickNo,
      t: this.tickNo / TICKS_PER_SEC,
      pawns: this.pawns.map((p) => pawnObs(p)),
      events: [],
      human: this.human,
    };
  }

  /** Store `inputs` for the following ticks (replacing the previous set) and apply `actions` in order. */
  apply(act: Act): void {
    const a = canonicalize(act);
    const inputs: PawnInput[] = [];
    for (const input of a.inputs) {
      if (this.pawn(input.id) === null) {
        this.note('input', 'input', 'unknown pawn', input);
      } else if (inputs.some((q) => q.id === input.id)) {
        this.note('input', 'input', 'duplicate input for pawn; first one kept', input);
      } else {
        inputs.push(input);
      }
    }
    this.inputs = inputs.sort((p, q) => compareOrdinal(p.id, q.id));
    for (const action of a.actions) this.applyAction(action);
  }

  control(c: Control): void {
    this.note('control', c.type, UNSUPPORTED_V0, c);
  }

  snapshot(): HostSnapshot {
    const state: HostState = {
      version: HOST_SNAPSHOT_VERSION,
      tick: this.tickNo,
      human: this.human,
      humanInput: this.humanInput,
      inputs: this.inputs,
      pawns: this.pawns,
    };
    return { kind: 'host', data: toJsonValue(state) };
  }

  restore(s: HostSnapshot): void {
    if (s.kind !== 'host') throw new Error(`Sim2DHost.restore: expected a host snapshot, got ${String(s.kind)}`);
    const d = s.data as unknown as HostState;
    if (typeof d !== 'object' || d === null || d.version !== HOST_SNAPSHOT_VERSION) {
      throw new Error('Sim2DHost.restore: unsupported snapshot version');
    }
    if (!Number.isInteger(d.tick) || !Array.isArray(d.pawns) || !Array.isArray(d.inputs)) {
      throw new Error('Sim2DHost.restore: malformed snapshot');
    }
    const ids = d.pawns.map((p) => p.id).join(',');
    if (ids !== this.pawns.map((p) => p.id).join(',')) {
      throw new Error(`Sim2DHost.restore: snapshot roster [${ids}] does not match this host`);
    }
    // Deep copy so later mutation never aliases the snapshot.
    const copy = JSON.parse(JSON.stringify(d)) as HostState;
    this.tickNo = copy.tick;
    this.human = copy.human;
    this.humanInput = copy.humanInput;
    this.inputs = [...copy.inputs];
    this.pawns = copy.pawns.map((p) => ({ ...p, inventory: [...p.inventory] }));
  }

  // ---- Sim2D-specific ------------------------------------------------------------------------

  /** Advance one tick (1/64 s): every alive pawn runs one movement step with its input. */
  tick(): void {
    const m = this.tuning.movement;
    for (const p of this.pawns) {
      if (!p.alive) {
        p.move = { ...p.move, vel: { x: 0, y: 0, z: 0 } };
        continue;
      }
      const step = stepMove(p.move, this.inputFor(p.id), p.weapon, this.nav, m, TICK_DT);
      p.move = roundMove(step.state);
    }
    this.tickNo++;
  }

  /** Which pawn the human controls (default `cart`); null = bots only. Clears any human input. */
  setHuman(id: PlayerId | null): void {
    if (id !== null && this.pawn(id) === null) throw new Error(`Sim2DHost.setHuman: ${id} is not in the roster`);
    this.human = id;
    this.humanInput = null;
  }

  /**
   * Input for the human pawn, used instead of any Core input for it until replaced or cleared (null;
   * the pawn then falls back to Core input). `input.id` must be the human pawn.
   */
  setHumanInput(input: PawnInput | null): void {
    if (input === null) {
      this.humanInput = null;
      return;
    }
    if (this.human === null || input.id !== this.human) {
      throw new Error(`Sim2DHost.setHumanInput: input is for ${input.id} but the human pawn is ${String(this.human)}`);
    }
    this.humanInput = canonicalize(input);
  }

  /** Actions, inputs and controls received but not (fully) applied, in arrival order. Not part of snapshots. */
  unhandled(): readonly HostNote[] {
    return this.notes.slice();
  }

  /** Deep copy of one pawn's engine state (inventory, helmet, recorded mode/goal), or null for an unknown id. */
  pawnState(id: PlayerId): PawnState | null {
    const p = this.pawn(id);
    return p === null ? null : (JSON.parse(JSON.stringify(p)) as PawnState);
  }

  // ---- internals -----------------------------------------------------------------------------

  private pawn(id: string): PawnState | null {
    return this.pawns.find((p) => p.id === id) ?? null;
  }

  private inputFor(id: PlayerId): PawnInput | null {
    if (id === this.human && this.humanInput !== null) return this.humanInput;
    return this.inputs.find((q) => q.id === id) ?? null;
  }

  private note(kind: HostNote['kind'], type: string, reason: string, data: unknown): void {
    this.notes.push({ tick: this.tickNo, kind, type, reason, data: toJsonValue(data) });
  }

  private applyAction(action: Act['actions'][number]): void {
    // Switch on the string so action types added later fall into `default` instead of vanishing.
    const type: string = action.type;
    switch (action.type) {
      case 'teleport': {
        const p = this.pawn(action.id);
        if (p === null) return this.note('action', type, 'unknown pawn', action);
        p.move = { ...p.move, pos: { x: action.pos.x, y: action.pos.y, z: action.pos.z }, vel: { x: 0, y: 0, z: 0 }, yaw: action.yaw };
        return;
      }
      case 'set_hp': {
        const p = this.pawn(action.id);
        if (p === null) return this.note('action', type, 'unknown pawn', action);
        p.hp = Math.max(0, action.hp);
        p.armor = Math.max(0, action.armor);
        const helmet = (action as SetHpExtras).helmet;
        if (typeof helmet === 'boolean') p.helmet = helmet;
        p.alive = p.hp > 0;
        if (!p.alive) p.move = { ...p.move, vel: { x: 0, y: 0, z: 0 } };
        return;
      }
      case 'give': {
        const p = this.pawn(action.id);
        if (p === null) return this.note('action', type, 'unknown pawn', action);
        const item: string = action.item;
        const entry: InventoryItem = { item, clip: action.clip, reserve: action.reserve };
        p.inventory = [...p.inventory.filter((q) => q.item !== item), entry].sort((x, y) => compareOrdinal(x.item, y.item));
        return;
      }
      case 'set_weapon': {
        const p = this.pawn(action.id);
        if (p === null) return this.note('action', type, 'unknown pawn', action);
        const weapon: string = action.weapon;
        if (NON_WIELDABLE.includes(weapon)) return this.note('action', type, 'item cannot be held', action);
        if (!p.inventory.some((q) => q.item === weapon)) return this.note('action', type, 'not in inventory', action);
        p.weapon = action.weapon;
        return;
      }
      case 'set_mode': {
        const p = this.pawn(action.id);
        if (p === null) return this.note('action', type, 'unknown pawn', action);
        p.mode = action.mode;
        p.goal = action.goal;
        return;
      }
      case 'log':
        // For the app's status panel; it reads Core logs from the Act / SessionLog.
        return;
      default:
        this.note('action', type, UNSUPPORTED_V0, action);
    }
  }
}

function spawnPawn(r: RosterEntry): PawnState {
  return {
    id: r.id,
    team: r.team,
    move: { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, crouching: false },
    hp: SPAWN_HP,
    armor: 0,
    helmet: false,
    alive: true,
    weapon: SPAWN_WEAPON,
    inventory: [{ item: SPAWN_WEAPON, clip: 0, reserve: 0 }],
    mode: 'REPLAY',
    goal: null,
  };
}

function pawnObs(p: PawnState): PawnObs {
  const held = p.inventory.find((q) => q.item === p.weapon);
  const ammo: Ammo = held === undefined ? { clip: 0, reserve: 0 } : { clip: held.clip, reserve: held.reserve };
  return {
    id: p.id,
    team: p.team,
    pos: copyVec(p.move.pos),
    vel: copyVec(p.move.vel),
    yaw: p.move.yaw,
    pitch: p.move.pitch,
    hp: p.hp,
    armor: p.armor,
    alive: p.alive,
    weapon: p.weapon,
    ammo,
    crouching: p.move.crouching,
    sees: [],
  };
}

function copyVec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function roundVec(v: Vec3): Vec3 {
  return { x: roundNumber(v.x), y: roundNumber(v.y), z: roundNumber(v.z) };
}

/** State as the session log stores it (6 decimals), so snapshots and logs reproduce it exactly. */
function roundMove(s: MoveState): MoveState {
  return { pos: roundVec(s.pos), vel: roundVec(s.vel), yaw: roundNumber(s.yaw), pitch: roundNumber(s.pitch), crouching: s.crouching };
}
