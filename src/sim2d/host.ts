/**
 * Sim2DHost: the 2D engine behind IHost. Movement (stepMove on the nav mesh), weapons (fire cadence,
 * reload, deploy), hitscan bullets with CS damage and armor, grenades (smoke, flash, HE, molotov), the
 * Core's scripted `damage` and `block_damage` / `unblock_damage`, deaths and sounds, plus the bookkeeping
 * actions (teleport, set_hp, give, set_weapon, set_mode). Bomb and round-end actions and all Control
 * messages are recorded in `unhandled()` instead of being dropped (task C3).
 *
 * Driver loop: observe() → core.step → apply(act) → tick(). IHost has no tick(); the app (or the
 * game, for the CS2 host) owns the clock. Per-tick order: docs/combat.md.
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
  type DamageAction,
  type Goal,
  type Hitgroup,
  type HostSnapshot,
  type IHost,
  type JsonValue,
  type ObsEvent,
  type Observe,
  type PawnInput,
  type PawnObs,
  type PlayerId,
  type SettableMode,
  type SoundKind,
  type Team,
  type Tuning,
  type Vec3,
  type WeaponId,
} from '../contracts/index';
import { activeEffects, smokeBlocks, stepGrenades, throwGrenade, type Grenade, type GrenadeEffect, type GrenadeOutcome } from './grenades';
import { traceShot, type ScanPawn } from './hitscan';
import { TICKS_PER_SEC, TICK_DT, stepMove, type MoveState } from './movement';
import type { NavMesh, NavPoint } from './nav';
import {
  armorDamage,
  bulletDamage,
  deploySec,
  deployState,
  fallbackWeapon,
  freshWeaponState,
  gunStats,
  isArmored,
  isGrenade,
  reached,
  stepWeapon,
  type HitDamage,
  type WeaponState,
} from './weapons';

/** One pawn of the round: who and which side. The host does not read round.json itself. */
export interface RosterEntry {
  readonly id: PlayerId;
  readonly team: Team;
}

/**
 * One carried item. `item` is a string, not WeaponId, so unknown items are kept rather than dropped.
 * Guns, c4 and the defuser have one entry each; each grenade is its own entry (two smokes = two entries).
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
  /** Sorted by item (ordinal). */
  inventory: InventoryItem[];
  /** Recorded from set_mode; the host does not act on it. */
  mode: SettableMode;
  goal: Goal | null;
  /** Fire / reload / deploy timers of the held item. */
  wpn: WeaponState;
  /** Blind (flashed) while the observed tick is below this. */
  blindUntilTick: number;
  /** Earliest tick for the next footstep sound. */
  nextFootstepTick: number;
}

/** Something the host received but did not (fully) apply. */
export interface HostNote {
  readonly tick: number;
  readonly kind: 'action' | 'control' | 'input';
  /** Action / control type (`plant`, `seek`, …) or `input`. */
  readonly type: string;
  readonly reason: string;
  /** The message as received (canonical JSON). */
  readonly data: JsonValue;
}

/** A debugging line about combat (blocked hits); not part of observe() or snapshots. */
export interface CombatLogLine {
  readonly tick: number;
  readonly text: string;
}

/** An attacker → victim pair whose engine damage is blocked. */
export interface BlockedPair {
  readonly attacker: PlayerId;
  readonly victim: PlayerId;
}

export const UNSUPPORTED_V0 = 'unsupported in v0';

const HOST_SNAPSHOT_VERSION = 2;
/** CS2 spawn state for a pawn before Core sets it up (game rules, not calibration). */
const SPAWN_HP = 100;
const SPAWN_WEAPON: WeaponId = 'knife';
/** Items that can be carried but not held. */
const NON_WIELDABLE: readonly string[] = ['defuser'];

interface HostState {
  readonly version: number;
  readonly tick: number;
  readonly human: PlayerId | null;
  readonly humanInput: PawnInput | null;
  /** Core inputs from the last apply(), sorted by id. */
  readonly inputs: readonly PawnInput[];
  readonly pawns: readonly PawnState[];
  /** Flying grenades, smoke clouds and fires, by seq. */
  readonly grenades: readonly Grenade[];
  readonly nextGrenadeSeq: number;
  /** Sorted by attacker, then victim. */
  readonly blocked: readonly BlockedPair[];
  /** Scripted damage from apply(), applied in the next tick() in Core order. */
  readonly pendingDamage: readonly DamageAction[];
  /** Events of the last tick, as observe() reports them. */
  readonly events: readonly ObsEvent[];
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
  private grenades: Grenade[] = [];
  private nextGrenadeSeq = 1;
  private blocked: BlockedPair[] = [];
  private pendingDamage: DamageAction[] = [];
  /** Events of the last completed tick (observe()). */
  private events: ObsEvent[] = [];
  /** Events being emitted by the tick in progress. */
  private outbox: ObsEvent[] = [];
  private readonly notes: HostNote[] = [];
  private readonly combat: CombatLogLine[] = [];

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
      events: this.events.map((e) => ({ ...e })),
      human: this.human,
    };
  }

  /**
   * Store `inputs` for the following ticks (replacing the previous set) and apply `actions` in order.
   * Scripted `damage` is queued and applied in the next tick() after shots and grenades.
   */
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
    const teleported = new Set<string>();
    for (const action of a.actions) this.applyAction(action, teleported);
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
      grenades: this.grenades,
      nextGrenadeSeq: this.nextGrenadeSeq,
      blocked: this.blocked,
      pendingDamage: this.pendingDamage,
      events: this.events,
    };
    return { kind: 'host', data: toJsonValue(state) };
  }

  restore(s: HostSnapshot): void {
    if (s.kind !== 'host') throw new Error(`Sim2DHost.restore: expected a host snapshot, got ${String(s.kind)}`);
    const d = s.data as unknown as HostState;
    if (typeof d !== 'object' || d === null || d.version !== HOST_SNAPSHOT_VERSION) {
      throw new Error('Sim2DHost.restore: unsupported snapshot version');
    }
    if (
      !Number.isInteger(d.tick) ||
      !Array.isArray(d.pawns) ||
      !Array.isArray(d.inputs) ||
      !Array.isArray(d.grenades) ||
      !Array.isArray(d.blocked) ||
      !Array.isArray(d.pendingDamage) ||
      !Array.isArray(d.events)
    ) {
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
    this.grenades = [...copy.grenades];
    this.nextGrenadeSeq = copy.nextGrenadeSeq;
    this.blocked = [...copy.blocked];
    this.pendingDamage = [...copy.pendingDamage];
    this.events = [...copy.events];
  }

  // ---- Sim2D-specific ------------------------------------------------------------------------

  /**
   * Advance one tick (1/64 s). Order (docs/combat.md): movement and footsteps; per alive pawn in id order
   * its weapon (reload, fire with hitscan and damage, grenade throw); grenades (pops, effects, fire);
   * the scripted damage queued by apply(). Deaths are applied at the damage that causes them, so a
   * pawn killed earlier in the tick does not act later in it. Events become observe()'s events.
   */
  tick(): void {
    const t = this.tickNo;
    this.outbox = [];
    this.moveAll(t);
    for (const p of this.pawns) if (p.alive) this.stepPawnWeapon(p, t);
    this.stepGrenades(t);
    const queued = this.pendingDamage;
    this.pendingDamage = [];
    for (const a of queued) this.applyScriptedDamage(a);
    this.tickNo++;
    this.events = this.outbox;
    this.outbox = [];
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

  /** Debug lines about combat (blocked hits), in order. Not part of snapshots. */
  combatLog(): readonly CombatLogLine[] {
    return this.combat.slice();
  }

  /** Deep copy of one pawn's engine state (inventory, helmet, weapon timers, mode/goal), or null for an unknown id. */
  pawnState(id: PlayerId): PawnState | null {
    const p = this.pawn(id);
    return p === null ? null : (JSON.parse(JSON.stringify(p)) as PawnState);
  }

  /** Attacker → victim pairs whose engine damage is currently blocked. */
  blockedPairs(): readonly BlockedPair[] {
    return this.blocked.map((b) => ({ ...b }));
  }

  /** True if the 2D segment a–b crosses an active smoke at the current tick (for vision, task C4). */
  smokeBlocks(a: NavPoint, b: NavPoint): boolean {
    return smokeBlocks(this.grenades, this.tickNo, a, b, this.tuning.grenades);
  }

  /** The pawn is blind while the current tick is below this (0 = never flashed; unknown ids give 0). */
  blindUntilTick(id: PlayerId): number {
    return this.pawn(id)?.blindUntilTick ?? 0;
  }

  /** Flying grenades, smoke clouds and fires at the current tick, by seq (for the renderer). */
  activeEffects(): GrenadeEffect[] {
    return activeEffects(this.grenades, this.tickNo, this.tuning.grenades);
  }

  // ---- tick phases ---------------------------------------------------------------------------

  private moveAll(t: number): void {
    const m = this.tuning.movement;
    const snd = this.tuning.sound;
    for (const p of this.pawns) {
      if (!p.alive) {
        p.move = { ...p.move, vel: { x: 0, y: 0, z: 0 } };
        continue;
      }
      const step = stepMove(p.move, this.inputFor(p.id), p.weapon, this.nav, m, TICK_DT);
      p.move = roundMove(step.state);
      const speed = Math.hypot(p.move.vel.x, p.move.vel.y);
      if (speed > snd.footstepSpeed && reached(t, p.nextFootstepTick)) {
        this.sound(p, 'footstep');
        p.nextFootstepTick = roundNumber(t + snd.footstepIntervalSec * TICKS_PER_SEC);
      }
    }
  }

  private stepPawnWeapon(p: PawnState, t: number): void {
    const input = this.inputFor(p.id);
    const buttons = input === null ? [] : input.buttons;
    const held = p.inventory.find((q) => q.item === p.weapon) ?? null;
    const gun = gunStats(p.weapon, this.tuning);
    const step = stepWeapon(p.wpn, {
      tick: t,
      item: p.weapon,
      ammo: gun === null || held === null ? null : { clip: held.clip, reserve: held.reserve },
      gun,
      attack: buttons.includes('ATTACK'),
      reload: buttons.includes('RELOAD'),
      discardMagazine: this.tuning.damage.reloadDiscardsMagazine,
    });
    p.wpn = step.state;
    if (step.ammo !== null) this.setAmmo(p, p.weapon, step.ammo);
    if (step.reloadStarted) this.sound(p, 'reload');
    if (step.fired && gun !== null) {
      this.outbox.push({ type: 'shot', shooter: p.id, weapon: p.weapon });
      this.sound(p, 'shot');
      const hit = traceShot(scanPawn(p), this.pawns.map((q) => scanPawn(q)), this.nav, this.tuning.damage);
      if (hit !== null) {
        const victim = this.pawn(hit.victim) as PawnState;
        const dmg = bulletDamage(gun, hit.distance, hit.hitgroup, victim.armor, victim.helmet, this.tuning.damage);
        this.engineDamage(p.id, victim, p.weapon, hit.hitgroup, dmg);
      }
    }
    if (step.thrown && isGrenade(p.weapon)) this.throwHeld(p, t);
  }

  private throwHeld(p: PawnState, t: number): void {
    const kind = p.weapon;
    if (!isGrenade(kind)) return;
    const g = throwGrenade(kind, { id: p.id, team: p.team, pos: p.move.pos, yaw: p.move.yaw, pitch: p.move.pitch, crouching: p.move.crouching }, t, this.nextGrenadeSeq, this.nav, this.tuning.grenades, this.tuning.damage);
    this.nextGrenadeSeq++;
    this.grenades = [...this.grenades, g];
    const i = p.inventory.findIndex((q) => q.item === kind);
    if (i >= 0) p.inventory = [...p.inventory.slice(0, i), ...p.inventory.slice(i + 1)];
    if (!p.inventory.some((q) => q.item === kind)) {
      p.weapon = fallbackWeapon(p.inventory.map((q) => q.item));
    }
    p.wpn = deployState(p.wpn, t, deploySec(p.weapon, this.tuning));
  }

  private stepGrenades(t: number): void {
    if (this.grenades.length === 0) return;
    const r = stepGrenades(this.grenades, t, {
      nav: this.nav,
      pawns: this.pawns.map((p) => ({ id: p.id, team: p.team, pos: p.move.pos, yaw: p.move.yaw, alive: p.alive })),
      grenades: this.tuning.grenades,
      damage: this.tuning.damage,
      ai: this.tuning.ai,
    });
    this.grenades = r.grenades;
    for (const o of r.outcomes) this.applyGrenadeOutcome(o);
  }

  private applyGrenadeOutcome(o: GrenadeOutcome): void {
    switch (o.type) {
      case 'pop': {
        this.outbox.push({ type: 'sound', source: o.thrower, pos: { ...o.pos }, kind: 'grenade' });
        return;
      }
      case 'hurt': {
        const victim = this.pawn(o.victim);
        if (victim === null || !victim.alive) return;
        const dmg = armorDamage(o.damage, o.armorPen, victim.armor, isArmored('generic', victim.helmet), this.tuning.damage);
        this.engineDamage(o.thrower, victim, o.kind, 'generic', dmg);
        return;
      }
      case 'blind': {
        const victim = this.pawn(o.victim);
        if (victim === null || !victim.alive) return;
        victim.blindUntilTick = Math.max(victim.blindUntilTick, o.untilTick);
        return;
      }
    }
  }

  // ---- damage --------------------------------------------------------------------------------

  /** Bullet or grenade damage: skipped (logged) for a blocked pair, else applied. */
  private engineDamage(attacker: PlayerId, victim: PawnState, weapon: WeaponId, hitgroup: Hitgroup, dmg: HitDamage): void {
    if (this.isBlocked(attacker, victim.id)) {
      this.combat.push({ tick: this.tickNo, text: `blocked ${attacker} -> ${victim.id} ${weapon} ${hitgroup}: ${dmg.health} hp / ${dmg.armor} armor not applied` });
      return;
    }
    this.hurt(attacker, victim, weapon, hitgroup, dmg.health, dmg.armor, false, false);
  }

  private applyScriptedDamage(a: DamageAction): void {
    const victim = this.pawn(a.victim);
    if (victim === null) return this.note('action', 'damage', 'unknown pawn', a);
    if (!victim.alive) return this.note('action', 'damage', 'victim is dead', a);
    this.hurt(a.attacker, victim, a.weapon, a.hitgroup, Math.max(0, a.amount), Math.max(0, a.armor), true, a.lethal);
  }

  /**
   * Remove HP and armor (each capped at what the victim has; `lethal` takes all HP), emit `damage` with the
   * amounts actually removed, and on HP ≤ 0 kill the victim and emit `death`.
   */
  private hurt(attacker: PlayerId | null, victim: PawnState, weapon: WeaponId | null, hitgroup: Hitgroup, hp: number, armor: number, scripted: boolean, lethal: boolean): void {
    const hpRemoved = lethal ? victim.hp : Math.min(victim.hp, hp);
    const armorRemoved = Math.min(victim.armor, armor);
    victim.hp = roundNumber(victim.hp - hpRemoved);
    victim.armor = roundNumber(victim.armor - armorRemoved);
    this.outbox.push({ type: 'damage', attacker, victim: victim.id, amount: hpRemoved, armor: armorRemoved, weapon, hitgroup, scripted });
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.alive = false;
      victim.move = { ...victim.move, vel: { x: 0, y: 0, z: 0 } };
      victim.wpn = { ...victim.wpn, reloadEndTick: null, grenadePrimed: false };
      this.outbox.push({ type: 'death', victim: victim.id, attacker, weapon, headshot: hitgroup === 'head' });
    }
  }

  private isBlocked(attacker: PlayerId, victim: PlayerId): boolean {
    return this.blocked.some((b) => b.attacker === attacker && b.victim === victim);
  }

  // ---- internals -----------------------------------------------------------------------------

  private pawn(id: string): PawnState | null {
    return this.pawns.find((p) => p.id === id) ?? null;
  }

  private inputFor(id: PlayerId): PawnInput | null {
    if (id === this.human && this.humanInput !== null) return this.humanInput;
    return this.inputs.find((q) => q.id === id) ?? null;
  }

  private sound(p: PawnState, kind: SoundKind): void {
    this.outbox.push({ type: 'sound', source: p.id, pos: copyVec(p.move.pos), kind });
  }

  private setAmmo(p: PawnState, item: string, ammo: Ammo): void {
    p.inventory = p.inventory.map((q) => (q.item === item ? { item, clip: ammo.clip, reserve: ammo.reserve } : q));
  }

  private note(kind: HostNote['kind'], type: string, reason: string, data: unknown): void {
    this.notes.push({ tick: this.tickNo, kind, type, reason, data: toJsonValue(data) });
  }

  private applyAction(action: Act['actions'][number], teleported: Set<string>): void {
    // Switch on the string so action types added later fall into `default` instead of vanishing.
    const type: string = action.type;
    switch (action.type) {
      case 'teleport': {
        const p = this.pawn(action.id);
        if (p === null) return this.note('action', type, 'unknown pawn', action);
        p.move = { ...p.move, pos: { x: action.pos.x, y: action.pos.y, z: action.pos.z }, vel: { x: 0, y: 0, z: 0 }, yaw: action.yaw };
        teleported.add(p.id);
        return;
      }
      case 'set_hp': {
        const p = this.pawn(action.id);
        if (p === null) return this.note('action', type, 'unknown pawn', action);
        p.hp = Math.max(0, action.hp);
        p.armor = Math.max(0, action.armor);
        p.helmet = action.helmet;
        p.alive = p.hp > 0;
        if (!p.alive) p.move = { ...p.move, vel: { x: 0, y: 0, z: 0 } };
        return;
      }
      case 'give': {
        const p = this.pawn(action.id);
        if (p === null) return this.note('action', type, 'unknown pawn', action);
        const item: string = action.item;
        const entry: InventoryItem = { item, clip: action.clip, reserve: action.reserve };
        const kept = isGrenade(item) ? p.inventory : p.inventory.filter((q) => q.item !== item);
        p.inventory = [...kept, entry].sort((x, y) => compareOrdinal(x.item, y.item));
        return;
      }
      case 'set_weapon': {
        const p = this.pawn(action.id);
        if (p === null) return this.note('action', type, 'unknown pawn', action);
        const weapon: string = action.weapon;
        if (NON_WIELDABLE.includes(weapon)) return this.note('action', type, 'item cannot be held', action);
        if (!p.inventory.some((q) => q.item === weapon)) return this.note('action', type, 'not in inventory', action);
        if (p.weapon === action.weapon) return;
        p.weapon = action.weapon;
        // A switch that comes with a teleport in the same act is state placement (setup, rewind): ready at once.
        p.wpn = deployState(p.wpn, this.tickNo, teleported.has(p.id) ? 0 : deploySec(weapon, this.tuning));
        return;
      }
      case 'set_mode': {
        const p = this.pawn(action.id);
        if (p === null) return this.note('action', type, 'unknown pawn', action);
        p.mode = action.mode;
        p.goal = action.goal;
        return;
      }
      case 'damage':
        this.pendingDamage.push(action);
        return;
      case 'block_damage':
      case 'unblock_damage': {
        if (this.pawn(action.attacker) === null || this.pawn(action.victim) === null) return this.note('action', type, 'unknown pawn', action);
        const others = this.blocked.filter((b) => !(b.attacker === action.attacker && b.victim === action.victim));
        this.blocked =
          action.type === 'block_damage'
            ? [...others, { attacker: action.attacker, victim: action.victim }].sort((x, y) => compareOrdinal(x.attacker, y.attacker) || compareOrdinal(x.victim, y.victim))
            : others;
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
    wpn: freshWeaponState(),
    blindUntilTick: 0,
    nextFootstepTick: 0,
  };
}

function scanPawn(p: PawnState): ScanPawn {
  return { id: p.id, team: p.team, pos: p.move.pos, yaw: p.move.yaw, pitch: p.move.pitch, crouching: p.move.crouching, alive: p.alive };
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
