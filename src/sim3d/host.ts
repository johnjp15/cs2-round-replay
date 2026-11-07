/**
 * Sim3DHost (H1): the 3D engine behind IHost, for the 3D app (src/app3d) and tools/harness3d.ts. docs/sim3d.md.
 *
 * It is Sim2DHost (src/sim2d/host.ts) with the parts that were 2D made 3D, and everything else kept exactly, so the
 * Core drives the same puppets along the same snapped tracks with the same inputs, scripted damage, snaps and round
 * rules, and a run nobody plays reproduces the recording as the 2D host does:
 *
 * - **Movement**: always 3D Source movement on the CS2 collision mesh (`stepMove3d`, G3), pawn collision as in 2D.
 * - **View angles**: per pawn yaw and pitch (MoveState; Source: pitch positive = down), from the Core's, the AI's or
 *   the human's input.
 * - **Bullets**: 3D hitscan (src/sim3d/hitscan.ts): a ray from the eye along the view direction, the nearest of the
 *   world mesh and the hitboxes (src/engine/hitboxes.ts); the hitgroup is the hitbox's; damage by the same CS damage
 *   math (`bulletDamage`). No spread or recoil yet (H2).
 * - **Sight** (`sees`), bullets' wall test, the LIVE AI's guard spot and grenade effects: G6's MeshSight
 *   (src/sim2d/mesh-sight.ts), the one implementation both hosts share: eye to the target's head, chest, sides and legs
 *   on the CS2 world mesh, FOV, flash and smoke (`computeSees`, src/sim2d/vision.ts), exactly as in Sim2DHost.
 * - Kept from sim2d as they are: weapons (cadence, reload, deploy), grenades (throws clamp on the 2D mask, effects on the mesh, as in 2D), the bomb,
 *   the round rules, hearing (sound events), the LIVE AI (src/sim2d/ai.ts on the Mirage 2D nav; H3 makes it generic).
 *
 * The class is a copy of Sim2DHost's because its phases are private and src/sim2d is not edited while G5 / G6 work
 * in it; H4 (or the engine refactor after G5 / G6) folds the two into one host with pluggable sight and bullets
 * (docs/sim3d.md "Duplication"). Its public surface is Sim2DHost's (the Session's `SessionHost`) plus `shots()` and
 * `world()`.
 *
 * Deterministic: no randomness, no clocks, no object-key iteration; state rounded to the log's 6 decimals every tick.
 */
import {
  ALL_CAPABILITIES,
  Rng,
  canonicalize,
  compareOrdinal,
  isPlayerId,
  roundNumber,
  sortButtons,
  toJsonValue,
  type Act,
  type Ammo,
  type BombObs,
  type Control,
  type DamageAction,
  type EndRoundAction,
  type Hitgroup,
  type HostCapabilities,
  type HostSnapshot,
  type IHost,
  type ObsEvent,
  type Observe,
  type PawnInput,
  type PawnObs,
  type PlayerId,
  type RoundObs,
  type SetRoundAction,
  type SoundKind,
  type Tuning,
  type Vec3,
  type WeaponId,
} from '../contracts/index';
import weaponsJson from '../../data/weapons.json';
import {
  applyHit,
  armsContext,
  cameraAngles,
  crosshairAngles,
  damageAfterHitgroup,
  freshArms,
  maxSpeedOf,
  parseWeaponTable,
  trackArms,
  trackShot,
  weaponDef,
  type Angle2,
  type ArmsContext,
  type ArmsState,
  type Motion,
  type SolidQuery,
} from '../engine/weapons/index';
import { freshAiState, roleOf, stepAi, type AiOther } from '../sim2d/ai';
import { applyBombAction, bombFromObs, freshBomb, isBombsite, isTicking, lockedPawns, stepBomb, type BombAction, type BombData, type BombOutcome, type BombPawn } from '../sim2d/bomb';
import { collideMove, type CollisionNav, type Obstacle } from '../sim2d/collision';
import type { MapGeometry } from '../sim2d/geometry';
import { activeEffects, smokeBlocks, stepGrenades, throwGrenade, type Grenade, type GrenadeEffect, type GrenadeOutcome } from '../sim2d/grenades';
import { TICKS_PER_SEC, TICK_DT, hullOf, restingState, settle, stepMove3d, type MoveOptions, type MoveState, type MoveStep } from '../sim2d/movement';
import type { NavMesh, NavPoint } from '../sim2d/nav';
import { checkRoundEnd, endRound, freshRound, isOver, roundPhase, timeLeftSec, type RoundEnd, type RoundState, type TeamCounts } from '../sim2d/round';
import { MeshGrenadeNav, MeshSight, meshSightOptionsFromTuning, scriptedHitThroughGeometry } from '../sim2d/mesh-sight';
import { GrenadeSight, Sight, computeSees, sightOptionsFromTuning } from '../sim2d/vision';
import type { AiDebug, BlockedPair, CombatLogLine, HostNote, InventoryItem, PawnState, RosterEntry, Sim2DOptions, Sim2DVision } from '../sim2d/host';
import { meshSolidQuery, traceShot3, type Shot3, type ShotPawn } from './hitscan';
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
} from '../sim2d/weapons';

/** The 3D world: the movement mesh (world + player clips, as the Session's `geometry`) and the world mesh alone (sight, bullets). */
export interface Sim3DWorld {
  readonly movement: MapGeometry;
  readonly world: MapGeometry;
}

/** A pawn's hull can't pass another's when their heights overlap by more than this (units): a pawn can jump over a crouched one only if it clears it. */
const BODY_OVERLAP_Z = 1;
const UNSUPPORTED_V0 = 'unsupported in v0';

/** Queued bomb and round actions (applied in the next tick(), after scripted damage, in Core order). */
type QueuedRoundAction = BombAction | EndRoundAction;

/** Sim2DHost's snapshot version 5 (G3), plus `engine: 'sim3d'` so a 2D snapshot is never restored here. */
const HOST_SNAPSHOT_VERSION = 5;
const ENGINE = 'sim3d';
/** CS2 spawn state for a pawn before Core sets it up (game rules, not calibration). */
const SPAWN_HP = 100;
const SPAWN_WEAPON: WeaponId = 'knife';
/** Items that can be carried but not held. */
const NON_WIELDABLE: readonly string[] = ['defuser'];

interface HostState {
  readonly version: number;
  readonly engine: string;
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
  /** plant / defuse_start / defuse_stop / end_round from apply(), applied in the next tick() after the damage. */
  readonly pendingRound: readonly QueuedRoundAction[];
  readonly bomb: BombData;
  readonly round: RoundState;
  /** Events of the last tick, as observe() reports them. */
  readonly events: readonly ObsEvent[];
  readonly aiSeed: number;
  /** H2: per pawn (pawn order) the weapon mechanics state (accuracy, recoil, punch, scope, tagging); absent in older snapshots. */
  readonly arms?: readonly ArmsState[];
}

export class Sim3DHost implements IHost {
  private readonly nav: NavMesh;
  /** The collision mesh (world + player clips) for movement. */
  private readonly geometry: MapGeometry;
  /** G6: sight (`sees`), the guard spot and grenade effects on the world mesh (MeshSight, shared with Sim2DHost). */
  private readonly meshSight: MeshSight;
  private readonly tuning: Tuning;
  /** The 2D sight (mask + level check): only grenade throws clamp on it (their flight is 2D), as in Sim2DHost. */
  private readonly sight: Sight;
  private readonly grenadeSight: GrenadeSight;
  /** Grenades: throws on the 2D mask, effects (flash, HE) on the mesh. */
  private readonly grenadeNav: MeshGrenadeNav;
  private aiSeed: number;
  /** `sees` of the current state (pawn order), or null when it must be recomputed. */
  private seesCache: PlayerId[][] | null = null;
  /** AI inputs for this tick (LIVE pawns), set at the start of tick(). */
  private aiInputs: PawnInput[] = [];
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
  private pendingRound: QueuedRoundAction[] = [];
  private bomb: BombData = freshBomb();
  private round: RoundState;
  /** Events of the last completed tick (observe()). */
  private events: ObsEvent[] = [];
  /** Events being emitted by the tick in progress. */
  private outbox: ObsEvent[] = [];
  private readonly notes: HostNote[] = [];
  private readonly combat: CombatLogLine[] = [];
  /** Bullets of the last completed tick (renderer, tests); not state. */
  private lastShots: Shot3[] = [];
  private shotsOut: Shot3[] = [];
  /** H2: CS2 weapon mechanics (src/engine/weapons); null if the tuning has no `weapons._engine` (bullets go exactly along the view). */
  private readonly armsCtx: ArmsContext | null;
  /** H2: per pawn (pawn order). */
  private arms: ArmsState[] = [];
  /** H2b: the solids along a bullet on the world mesh, for wall penetration (built on first use). */
  private solids: SolidQuery | null = null;

  /**
   * @param options score before the round and the round clock at tick 0; default 0 – 0 and `tuning.round.timeSec`.
   * @param vision the sight mask (the LIVE AI's and the grenades' 2D sight) and the AI seed; default no mask and seed 0.
   * @param world the movement mesh and the world mesh (sight and bullets).
   */
  constructor(nav: NavMesh, tuning: Tuning, roster: readonly RosterEntry[], options: Sim2DOptions | null, vision: Sim2DVision | null, world: Sim3DWorld) {
    if (roster.length === 0) throw new Error('Sim3DHost: empty roster');
    const seen = new Set<string>();
    for (const r of roster) {
      if (!isPlayerId(r.id)) throw new Error(`Sim3DHost: unknown player id ${String(r.id)}`);
      if (seen.has(r.id)) throw new Error(`Sim3DHost: duplicate player id ${r.id}`);
      seen.add(r.id);
    }
    this.nav = nav;
    this.geometry = world.movement;
    this.tuning = tuning;
    this.sight = new Sight(vision?.mask ?? null, nav, sightOptionsFromTuning(tuning));
    this.grenadeSight = new GrenadeSight(this.sight, nav);
    this.meshSight = new MeshSight(world.world, meshSightOptionsFromTuning(tuning));
    this.grenadeNav = new MeshGrenadeNav(this.grenadeSight, this.meshSight);
    this.aiSeed = vision?.seed ?? 0;
    if (!Number.isInteger(this.aiSeed)) throw new Error(`Sim3DHost: AI seed must be an integer, got ${this.aiSeed}`);
    this.pawns = [...roster].sort((a, b) => compareOrdinal(a.id, b.id)).map((r) => spawnPawn(r));
    const o = options ?? { score: { ct: 0, t: 0 }, roundTimeSec: tuning.round.timeSec };
    if (!Number.isFinite(o.roundTimeSec) || o.roundTimeSec < 0) throw new Error(`Sim3DHost: bad roundTimeSec ${o.roundTimeSec}`);
    if (!Number.isInteger(o.score.ct) || !Number.isInteger(o.score.t) || o.score.ct < 0 || o.score.t < 0) {
      throw new Error(`Sim3DHost: bad score ${o.score.ct}-${o.score.t}`);
    }
    this.round = freshRound(o.roundTimeSec, o.score);
    this.armsCtx = tuning.weaponModel === undefined ? null : armsContext(parseWeaponTable(weaponsJson), tuning, TICKS_PER_SEC);
    this.arms = this.freshArmsAll();
  }

  private freshArmsAll(): ArmsState[] {
    const ctx = this.armsCtx;
    if (ctx === null) return [];
    return this.pawns.map(() => freshArms(ctx, 'knife', 0));
  }

  // ---- IHost ---------------------------------------------------------------------------------

  /** Like the 2D engine: exact snapshots, ticks back to back (seek), any rate. */
  capabilities(): HostCapabilities {
    return { ...ALL_CAPABILITIES };
  }

  observe(): Observe {
    const sees = this.currentSees();
    return {
      tick: this.tickNo,
      t: this.tickNo / TICKS_PER_SEC,
      pawns: this.pawns.map((p, i) => pawnObs(p, sees[i] ?? [])),
      events: this.events.map((e) => ({ ...e })),
      human: this.human,
      round: this.roundObs(),
    };
  }

  /**
   * Store `inputs` for the following ticks (replacing the previous set) and apply `actions` in order.
   * Scripted `damage` is queued and applied in the next tick() after shots and grenades; `plant`,
   * `defuse_start`, `defuse_stop` and `end_round` are queued and applied after that, before the bomb rules.
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
    this.seesCache = null;
  }

  control(c: Control): void {
    this.note('control', c.type, UNSUPPORTED_V0, c);
  }

  snapshot(): HostSnapshot {
    const state: HostState = {
      version: HOST_SNAPSHOT_VERSION,
      engine: ENGINE,
      tick: this.tickNo,
      human: this.human,
      humanInput: this.humanInput,
      inputs: this.inputs,
      pawns: this.pawns,
      grenades: this.grenades,
      nextGrenadeSeq: this.nextGrenadeSeq,
      blocked: this.blocked,
      pendingDamage: this.pendingDamage,
      pendingRound: this.pendingRound,
      bomb: this.bomb,
      round: this.round,
      events: this.events,
      aiSeed: this.aiSeed,
      arms: this.arms,
    };
    return { kind: 'host', data: toJsonValue(state) };
  }

  restore(s: HostSnapshot): void {
    if (s.kind !== 'host') throw new Error(`Sim3DHost.restore: expected a host snapshot, got ${String(s.kind)}`);
    const d = s.data as unknown as HostState;
    if (typeof d !== 'object' || d === null || d.version !== HOST_SNAPSHOT_VERSION || d.engine !== ENGINE) {
      throw new Error('Sim3DHost.restore: unsupported snapshot version');
    }
    if (
      !Number.isInteger(d.tick) ||
      !Array.isArray(d.pawns) ||
      !Array.isArray(d.inputs) ||
      !Array.isArray(d.grenades) ||
      !Array.isArray(d.blocked) ||
      !Array.isArray(d.pendingDamage) ||
      !Array.isArray(d.pendingRound) ||
      typeof d.bomb !== 'object' ||
      d.bomb === null ||
      typeof d.round !== 'object' ||
      d.round === null ||
      !Array.isArray(d.events) ||
      !Number.isInteger(d.aiSeed)
    ) {
      throw new Error('Sim3DHost.restore: malformed snapshot');
    }
    const ids = d.pawns.map((p) => p.id).join(',');
    if (ids !== this.pawns.map((p) => p.id).join(',')) {
      throw new Error(`Sim3DHost.restore: snapshot roster [${ids}] does not match this host`);
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
    this.pendingRound = [...copy.pendingRound];
    this.bomb = copy.bomb;
    this.round = copy.round;
    this.events = [...copy.events];
    this.aiSeed = copy.aiSeed;
    this.arms = copy.arms !== undefined && copy.arms.length === this.pawns.length ? [...copy.arms] : this.freshArmsAll();
    this.seesCache = null;
    this.aiInputs = [];
    this.lastShots = [];
  }

  // ---- engine-specific (Sim2DHost's surface) ------------------------------------------------------------------------

  /**
   * Advance one tick (1/64 s). Order (docs/combat.md): movement with collision and footsteps (planting and
   * defusing pawns don't move); per alive pawn in id order its weapon (reload, fire with hitscan and damage,
   * grenade throw); grenades (pops, effects, fire); the scripted damage queued by apply(); the queued bomb
   * and round actions; the bomb (plant, drop and pickup, explosion, defuse, beeps); the round rules.
   * Deaths are applied at the damage that causes them, so a pawn killed earlier in the tick does not act
   * later in it. Events become observe()'s events.
   */
  tick(): void {
    const t = this.tickNo;
    this.outbox = [];
    this.shotsOut = [];
    this.stepLiveAi(t);
    const locked = lockedPawns(this.bomb, t, this.bombPawns(), this.tuning.bomb);
    this.moveAll(t, locked);
    for (const p of this.pawns) if (p.alive) this.stepPawnWeapon(p, t);
    this.stepGrenades(t);
    const queued = this.pendingDamage;
    this.pendingDamage = [];
    for (const a of queued) this.applyScriptedDamage(a);
    const roundActions = this.pendingRound;
    this.pendingRound = [];
    for (const a of roundActions) this.applyRoundAction(a, t);
    const step = stepBomb(this.bomb, t, this.bombPawns(), this.tuning.bomb, this.tuning.damage.bandHeights['stomach'] ?? 0);
    this.bomb = step.bomb;
    this.applyBombOutcomes(step.outcomes, t);
    const end = checkRoundEnd(this.round, t, this.teamCounts(), isTicking(this.bomb));
    if (end !== null) this.finishRound(end, t);
    this.tickNo++;
    this.events = this.outbox;
    this.outbox = [];
    this.lastShots = this.shotsOut;
    this.shotsOut = [];
    this.seesCache = null;
  }

  /** H1: the bullets fired on the last tick (eye, impact, victim, hitgroup), in firing order. Not part of observe(). */
  shots(): readonly Shot3[] {
    return this.lastShots.map((x) => ({ ...x, from: copyVec(x.from), to: copyVec(x.to) }));
  }

  /** H1: the sight and bullet mesh (the world, no player clips). */
  world(): MeshSight {
    return this.meshSight;
  }

  /** H1: `sight` traces done so far (benchmarks). */
  sightTraces(): number {
    return this.meshSight.traces;
  }

  /** Which pawn the human controls (default `cart`); null = bots only. Clears any human input. */
  setHuman(id: PlayerId | null): void {
    if (id !== null && this.pawn(id) === null) throw new Error(`Sim3DHost.setHuman: ${id} is not in the roster`);
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
      throw new Error(`Sim3DHost.setHumanInput: input is for ${input.id} but the human pawn is ${String(this.human)}`);
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

  /**
   * LIVE AI debug view of a pawn (current behaviour, target, path), or null if it isn't LIVE. For the renderer and
   * status panel; not part of observe() or the contract.
   */
  aiDebug(id: PlayerId): AiDebug | null {
    const p = this.pawn(id);
    if (p === null || p.mode !== 'LIVE' || p.ai === null) return null;
    const a = p.ai;
    const sees = this.currentSees()[this.pawns.indexOf(p)] ?? [];
    return {
      id: p.id,
      role: p.goal === null ? 'hold' : roleOf(p.goal),
      behaviour: a.behaviour,
      target: a.target,
      targetVisible: a.target !== null && sees.includes(a.target),
      lastKnown: a.lastKnown === null ? null : { pos: copyVec(a.lastKnown.pos), tick: a.lastKnown.tick, id: a.lastKnown.id },
      dest: a.path.length === 0 || a.dest === null ? null : copyVec(a.dest),
      path: a.path.slice(a.pathIndex).map((q) => copyVec(q)),
      routeIndex: a.routeIndex,
      repaths: a.repaths,
      sinceTick: a.sinceTick,
    };
  }

  /** `sees` of every pawn at the current state, in roster (id) order; computed once per state. */
  sees(id: PlayerId): readonly PlayerId[] {
    const i = this.pawns.findIndex((p) => p.id === id);
    return i < 0 ? [] : [...(this.currentSees()[i] ?? [])];
  }

  /** The 2D sight query (mask plus level check): grenade throws and tests (Sim2DHost's surface). `world()` is the 3D sight. */
  sightQuery(): Sight {
    return this.sight;
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

  /** The solid pawn that cut `id`'s move short on the last tick (collision), or null. Debug hint, not in observe(). */
  blockedBy(id: PlayerId): PlayerId | null {
    return this.pawn(id)?.blockedBy ?? null;
  }

  /** Deep copy of the bomb state, including a plant or defuse in progress (debug; observe().round.bomb is the contract view). */
  bombState(): BombData {
    return JSON.parse(JSON.stringify(this.bomb)) as BombData;
  }

  /** Deep copy of the round state (score, end, round clock). */
  roundState(): RoundState {
    return JSON.parse(JSON.stringify(this.round)) as RoundState;
  }

  // ---- tick phases ---------------------------------------------------------------------------

  /** `sees` for the current state (contract F5; vision.ts computeSees on MeshSight, as Sim2DHost), cached until the state changes. */
  private currentSees(): PlayerId[][] {
    if (this.seesCache === null) {
      const d = this.tuning.damage;
      this.seesCache = computeSees(
        this.pawns.map((p) => ({ id: p.id, pos: p.move.pos, yaw: p.move.yaw, crouching: p.move.crouching, alive: p.alive, blind: this.tickNo < p.blindUntilTick, busy: this.bomb.plant?.id === p.id || this.bomb.defuse?.id === p.id })),
        this.meshSight,
        this,
        { fovDeg: this.tuning.ai.fovDeg, eyeHeight: d.eyeHeight, crouchEyeHeight: d.crouchEyeHeight },
      );
    }
    return this.seesCache;
  }

  /**
   * The LIVE AI's inputs for this tick (ai.ts), from the state the tick starts with: each LIVE, alive pawn in id
   * order, with its `sees` and last tick's events. A weapon switch it asks for is applied at once (as set_weapon).
   */
  private stepLiveAi(t: number): void {
    this.aiInputs = [];
    if (!this.pawns.some((p) => p.mode === 'LIVE' && p.alive)) return;
    const sees = this.currentSees();
    const others: AiOther[] = this.pawns.map((q) => ({ id: q.id, team: q.team, pos: copyVec(q.move.pos), crouching: q.move.crouching, alive: q.alive }));
    const planted = this.bomb.state === 'planted' || this.bomb.state === 'defused' || this.bomb.state === 'exploded' ? this.bomb.pos : null;
    const root = new Rng(this.aiSeed);
    this.pawns.forEach((p, i) => {
      if (p.mode !== 'LIVE' || !p.alive) return;
      if (p.id === this.human && this.humanInput !== null) return;
      const goal = p.goal ?? { route: [], role: 'hold', hold: null };
      p.ai ??= freshAiState(p.id, t, p.aiDraws);
      const held = p.inventory.find((q) => q.item === p.weapon) ?? null;
      const w = p.wpn;
      const reloading = w.reloadEndTick !== null;
      const step = stepAi(p.ai, {
        tick: t,
        self: {
          id: p.id,
          team: p.team,
          pos: copyVec(p.move.pos),
          vel: copyVec(p.move.vel),
          yaw: p.move.yaw,
          pitch: p.move.pitch,
          crouching: p.move.crouching,
          weapon: p.weapon,
          clip: held?.clip ?? 0,
          reserve: held?.reserve ?? 0,
          items: p.inventory.map((q) => q.item),
          ready: reached(t, w.nextAttackTick) && reached(t, w.deployEndTick) && !reloading,
          reloading,
          defuseEndTick: this.bomb.defuse?.id === p.id ? this.bomb.defuse.endTick : null,
        },
        goal,
        others: others.filter((q) => q.id !== p.id),
        sees: sees[i] ?? [],
        events: this.events,
        bomb: { planted: planted === null ? null : copyVec(planted), ticking: isTicking(this.bomb), explodeTick: this.bomb.explodeTick },
        round: { phase: roundPhase(this.round, isTicking(this.bomb)) },
        nav: this.nav,
        sight: this.meshSight,
        tuning: this.tuning,
        rng: root.fork('ai:' + p.id),
      });
      p.ai = step.state;
      p.aiDraws = step.state.draws;
      if (step.weapon !== null && p.inventory.some((q) => q.item === step.weapon) && p.weapon !== step.weapon) {
        p.weapon = step.weapon;
        p.wpn = deployState(p.wpn, t, deploySec(step.weapon, this.tuning));
      }
      this.aiInputs.push(canonicalize({ id: p.id, ...step.input, buttons: sortButtons(step.input.buttons) }));
    });
  }

  /**
   * Movement in id order. A `locked` pawn (planting or defusing) keeps its position and gets zero velocity, but
   * still turns and crouches. Every other move is cut against the solid pawns (collision.ts): alive enemies,
   * and alive teammates with `collision.solidTeammates`, at their positions so far this tick.
   */
  private moveAll(t: number, locked: readonly PlayerId[]): void {
    const m = this.tuning.movement;
    const snd = this.tuning.sound;
    const g = this.geometry;
    for (const p of this.pawns) {
      p.blockedBy = null;
      if (!p.alive) {
        p.move = { ...p.move, vel: { x: 0, y: 0, z: p.move.vel.z } };
        if (!p.move.onGround) p.move = stepMove3d({ ...p.move, vel: { x: 0, y: 0, z: p.move.vel.z } }, null, p.weapon, g, m, TICK_DT).state;
        p.move = roundMove({ ...p.move, vel: { x: 0, y: 0, z: p.move.onGround ? 0 : p.move.vel.z } });
        continue;
      }
      const input = this.inputFor(p.id);
      const isLocked = locked.includes(p.id);
      const from = p.move.pos;
      const lockedInput = input === null ? null : { ...input, forward: 0, side: 0, buttons: input.buttons.filter((b) => b !== 'JUMP') };
      const base: MoveState = isLocked ? { ...p.move, vel: { x: 0, y: 0, z: p.move.onGround ? 0 : p.move.vel.z } } : p.move;
      const step: MoveStep = stepMove3d(base, isLocked ? lockedInput : input, p.weapon, g, m, TICK_DT, this.moveOptionsFor(p, input));
      let next = step.state;
      if (!isLocked) {
        const obstacles = this.solidFor(p, next);
        if (obstacles.length > 0) {
          const c = collideMove(from, next.pos, obstacles, this.tuning.collision.pawnRadius, new HullClamp(g, next.pos.z, hullOf(next.crouching)));
          if (c.blockedBy !== null) {
            let z = next.pos.z;
            let x = c.x;
            let y = c.y;
            if (g.hullBlocked(x, y, z, hullOf(next.crouching))) {
              // Back where it was in xy, at its old height if that fits (else it doesn't move at all).
              if (!g.hullBlocked(x, y, from.z, hullOf(next.crouching))) z = from.z;
              else {
                x = from.x;
                y = from.y;
                z = from.z;
              }
            }
            next = { ...next, pos: { x, y, z }, vel: { x: (x - from.x) / TICK_DT, y: (y - from.y) / TICK_DT, z: next.vel.z } };
            p.blockedBy = c.blockedBy;
          }
        }
      }
      p.move = roundMove(next);
      if (step.landSpeed >= m.landSoundSpeed) this.sound(p, 'land');
      if (step.fallDamage > 0) this.hurt(null, p, null, 'generic', step.fallDamage, 0, false, false);
      const speed = Math.hypot(p.move.vel.x, p.move.vel.y);
      if (p.alive && p.move.onGround && speed > snd.footstepSpeed && reached(t, p.nextFootstepTick)) {
        this.sound(p, 'footstep');
        p.nextFootstepTick = roundNumber(t + snd.footstepIntervalSec * TICKS_PER_SEC);
      }
    }
  }

  private pawnIndex(id: PlayerId): number {
    return this.pawns.findIndex((q) => q.id === id);
  }

  /** The weapon table id of a held item (the 2D ids are the table's; anything unknown counts as the knife). */
  private armsWeapon(item: string): string {
    return this.armsCtx !== null && this.armsCtx.table.weapons[item] !== undefined ? item : 'knife';
  }

  /**
   * H2b: true when a pawn plays by the weapon mechanics (its bullets' outcome comes from spread, recoil and
   * penetration; its speed from the weapon's max speed and tagging): the human while controlled and LIVE pawns.
   * Puppets (REPLAY) keep their recorded outcomes: scripted damage is the truth, their tracks the table's speeds.
   */
  private mechanical(p: PawnState): boolean {
    return this.armsCtx !== null && !(p.mode === 'REPLAY' && !(p.id === this.human && this.humanInput !== null));
  }

  private static readonly NO_MOVE_OPTIONS: MoveOptions = {};

  /**
   * H2b: the movement options (src/sim2d/movement.ts `MoveOptions`, M1) of a mechanical pawn: `runSpeed` = the held
   * weapon's max speed in its mode (CS2 m_flMaxSpeed: AWP 100 scoped; × attackMovespeedFactor while firing, e.g.
   * the Negev), `velocityModifier` = tagging. Left out where they equal the table's run speed / 1, so a pawn nothing
   * slows moves exactly as before.
   */
  private moveOptionsFor(p: PawnState, input: PawnInput | null): MoveOptions {
    const ctx = this.armsCtx;
    if (ctx === null || !this.mechanical(p)) return Sim3DHost.NO_MOVE_OPTIONS;
    const a = this.arms[this.pawnIndex(p.id)];
    if (a === undefined) return Sim3DHost.NO_MOVE_OPTIONS;
    const run = roundNumber(maxSpeedOf(ctx, { ...a, velocityModifier: 1 }, input !== null && input.buttons.includes('ATTACK')));
    const base = this.tuning.movement.runSpeedByWeapon[p.weapon];
    const o: { runSpeed?: number; velocityModifier?: number } = {};
    if (base === undefined || Math.abs(run - base) > 1e-9) o.runSpeed = run;
    if (a.velocityModifier < 1) o.velocityModifier = a.velocityModifier;
    return o.runSpeed === undefined && o.velocityModifier === undefined ? Sim3DHost.NO_MOVE_OPTIONS : o;
  }

  /** H2: a pawn's weapon mechanics state (recoil, punch, scope, tagging), or null (unknown pawn or no weapon model). */
  armsOf(id: PlayerId): ArmsState | null {
    const i = this.pawnIndex(id);
    return i < 0 ? null : (this.arms[i] ?? null);
  }

  /**
   * H2: for the first-person view of `id` looking along `view`: the camera angles (view + `tracking` (default 0.45)
   * of the punch offset + the view punch), the crosshair angles (where the next bullet goes: view + aim punch × recoilScale) and the zoom
   * level with its FOV (4:3 degrees, from the weapon table; 90 unscoped).
   */
  aimView(id: PlayerId, view: Angle2, tracking?: number): { camera: Angle2; crosshair: Angle2; zoom: number; fov4x3: number } {
    const a = this.armsOf(id);
    const ctx = this.armsCtx;
    if (a === null || ctx === null) return { camera: view, crosshair: view, zoom: 0, fov4x3: 90 };
    const w = ctx.table.weapons[a.weapon];
    const fov = w === undefined || a.zoom <= 0 ? 90 : (w.zoom.fov[Math.min(a.zoom, 2) - 1] ?? 90);
    return { camera: cameraAngles(ctx, a, view, tracking ?? ctx.model.viewRecoilTracking), crosshair: crosshairAngles(ctx, a, view), zoom: a.zoom, fov4x3: fov };
  }

  private stepPawnWeapon(p: PawnState, t: number): void {
    const input = this.inputFor(p.id);
    const buttons = input === null ? [] : input.buttons;
    const held = p.inventory.find((q) => q.item === p.weapon) ?? null;
    const gun = gunStats(p.weapon, this.tuning);
    const ai = this.pawnIndex(p.id);
    const ctx = this.armsCtx;
    const motion: Motion = { velocity: p.move.vel, onGround: p.move.onGround, crouched: p.move.crouching, onLadder: false };
    if (ctx !== null && ai >= 0) {
      this.arms[ai] = trackArms(ctx, this.arms[ai] as ArmsState, {
        tick: t,
        weapon: this.armsWeapon(p.weapon),
        attack2: buttons.includes('ATTACK2'),
        reloading: p.wpn.reloadEndTick !== null,
        nextAttackTick: p.wpn.nextAttackTick,
        motion,
      });
    }
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
      // H2: the bullet leaves along view + aim punch × recoilScale + the inaccuracy / spread cone (seeded per shooter
      // and tick). H2b: the human's and LIVE pawns' bullets land there and may go through walls; a puppet's bullet is
      // drawn there but its outcome is traced along its scripted view exactly as before (scripted damage is the truth).
      let dir: Vec3 | null = null;
      if (ctx !== null && ai >= 0) {
        const rng = new Rng(this.aiSeed).fork(`spread:${p.id}:${t}`);
        const r = trackShot(ctx, this.arms[ai] as ArmsState, rng, { pitch: p.move.pitch, yaw: p.move.yaw }, motion, t, p.wpn.nextAttackTick);
        this.arms[ai] = r.state;
        dir = r.shot.pellets[0] ?? null;
      }
      const world = this.meshSight.geometry();
      const targets = this.pawns.map((q) => shotPawn(q));
      const mech = ctx !== null && this.mechanical(p);
      const pen = mech && ctx !== null ? { weapon: weaponDef(ctx.table, this.armsWeapon(p.weapon)), query: (this.solids ??= meshSolidQuery(world)), model: ctx.model } : null;
      const shot = mech ? traceShot3(shotPawn(p), targets, world, this.tuning.damage, dir, pen) : traceShot3(shotPawn(p), targets, world, this.tuning.damage);
      this.shotsOut.push(mech || dir === null ? shot : traceShot3(shotPawn(p), targets, world, this.tuning.damage, dir));
      if (shot.victim !== null && shot.hitgroup !== null) {
        const victim = this.pawn(shot.victim) as PawnState;
        // Open air: the 2D table's damage (as before); through a wall: the damage penetration left, then hitgroup and armor.
        const dmg =
          shot.penDamage !== undefined && pen !== null
            ? damageAfterHitgroup(pen.weapon, shot.penDamage, shot.hitgroup, victim.armor, victim.helmet, this.tuning.damage)
            : bulletDamage(gun, shot.distance, shot.hitgroup, victim.armor, victim.helmet, this.tuning.damage);
        // G5: the human's bullet on a blocked pair (a recorded duel, docs/core.md): report where it would have hit.
        if (p.id === this.human && this.isBlocked(p.id, victim.id)) this.outbox.push({ type: 'blocked_hit', attacker: p.id, victim: victim.id, weapon: p.weapon, hitgroup: shot.hitgroup });
        // H2: tagging and hit punch for a hit that lands (not on a blocked pair, so the recording's runs are unchanged).
        const vi = this.pawnIndex(victim.id);
        if (ctx !== null && vi >= 0 && !this.isBlocked(p.id, victim.id)) {
          this.arms[vi] = applyHit(ctx, this.arms[vi] as ArmsState, this.armsWeapon(p.weapon), victim.armor > 0 && isArmored(shot.hitgroup, victim.helmet));
        }
        this.engineDamage(p.id, victim, p.weapon, shot.hitgroup, dmg);
      }
    }
    if (step.thrown && isGrenade(p.weapon)) this.throwHeld(p, t);
  }

  private throwHeld(p: PawnState, t: number): void {
    const kind = p.weapon;
    if (!isGrenade(kind)) return;
    const g = throwGrenade(kind, { id: p.id, team: p.team, pos: p.move.pos, yaw: p.move.yaw, pitch: p.move.pitch, crouching: p.move.crouching }, t, this.nextGrenadeSeq, this.grenadeSight, this.tuning.grenades, this.tuning.damage);
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
      nav: this.grenadeNav,
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
    this.auditScriptedHit(a, victim);
    this.hurt(a.attacker, victim, a.weapon, a.hitgroup, Math.max(0, a.amount), Math.max(0, a.armor), true, a.lethal);
  }

  /** G6: a scripted gun hit whose eye-to-victim line crosses a wall of the mesh goes to the combat log (docs/vision.md). */
  private auditScriptedHit(a: DamageAction, victim: PawnState): void {
    const shooter = a.attacker === null ? null : this.pawn(a.attacker);
    if (shooter === null || !shooter.alive || a.weapon === null || gunStats(a.weapon, this.tuning) === null) return;
    const body = (p: PawnState) => ({ id: p.id, pos: p.move.pos, crouching: p.move.crouching });
    const line = scriptedHitThroughGeometry(this.meshSight, body(shooter), body(victim), a.weapon, a.hitgroup, this.tuning.damage.bandHeights, this.tickNo + 1, TICKS_PER_SEC);
    if (line !== null) this.combat.push({ tick: this.tickNo + 1, text: line });
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

  // ---- collision, bomb and round -------------------------------------------------------------

  /** Pawns `p` collides with: alive, not `p`, enemies (and teammates with solidTeammates), in id order. */
  /** The pawns that block `p`'s move to `next`: alive enemies (and teammates with solidTeammates) whose hulls overlap it in height (3D). */
  private solidFor(p: PawnState, next: MoveState): Obstacle[] {
    const mates = this.tuning.collision.solidTeammates;
    const lo = Math.min(p.move.pos.z, next.pos.z);
    const hi = Math.max(p.move.pos.z, next.pos.z) + hullOf(next.crouching).height;
    return this.pawns
      .filter((q) => q.id !== p.id && q.alive && (mates || q.team !== p.team))
      .filter((q) => (q.move.pos.z < hi - BODY_OVERLAP_Z && q.move.pos.z + hullOf(q.move.crouching).height > lo + BODY_OVERLAP_Z))
      .map((q) => ({ id: q.id, x: q.move.pos.x, y: q.move.pos.y }));
  }

  /** What the bomb rules see of each pawn now (id order). Bombsite lookups only for pawns that could plant. */
  private bombPawns(): BombPawn[] {
    return this.pawns.map((p) => {
      const input = this.inputFor(p.id);
      const use = input !== null && input.buttons.includes('USE');
      const hasC4 = p.inventory.some((q) => q.item === 'c4');
      const inSite = p.alive && p.team === 'T' && use && p.weapon === 'c4' && isBombsite(this.nav.placeName(p.move.pos));
      return { id: p.id, team: p.team, pos: copyVec(p.move.pos), alive: p.alive, weapon: p.weapon, use, hasC4, hasKit: p.inventory.some((q) => q.item === 'defuser'), inSite };
    });
  }

  private applyRoundAction(a: QueuedRoundAction, t: number): void {
    if (a.type === 'end_round') {
      if (isOver(this.round)) return this.note('action', a.type, 'round already over', a);
      this.finishRound({ winner: a.winner, reason: a.reason }, t);
      return;
    }
    const r = applyBombAction(this.bomb, a, t, this.bombPawns(), this.tuning.bomb);
    if (r.note !== null) return this.note('action', a.type, r.note, a);
    this.bomb = r.bomb;
    this.applyBombOutcomes(r.outcomes, t);
  }

  private applyBombOutcomes(outcomes: readonly BombOutcome[], t: number): void {
    for (const o of outcomes) {
      switch (o.type) {
        case 'event':
          this.outbox.push(o.event);
          break;
        case 'take_c4': {
          const p = this.pawn(o.id);
          if (p === null) break;
          const i = p.inventory.findIndex((q) => q.item === 'c4');
          if (i >= 0) p.inventory = [...p.inventory.slice(0, i), ...p.inventory.slice(i + 1)];
          // A dead pawn keeps reporting the c4 as its last weapon; a planter draws its best gun.
          if (p.alive && p.weapon === 'c4') {
            p.weapon = fallbackWeapon(p.inventory.map((q) => q.item));
            p.wpn = deployState(p.wpn, t, deploySec(p.weapon, this.tuning));
          }
          break;
        }
        case 'give_c4': {
          const p = this.pawn(o.id);
          if (p === null) break;
          p.inventory = [...p.inventory, { item: 'c4', clip: 0, reserve: 0 }].sort((x, y) => compareOrdinal(x.item, y.item));
          break;
        }
        case 'hurt': {
          const victim = this.pawn(o.victim);
          if (victim === null || !victim.alive) break;
          const dmg = armorDamage(o.damage, this.tuning.bomb.armorPen, victim.armor, isArmored('generic', victim.helmet), this.tuning.damage);
          this.hurt(null, victim, null, 'generic', dmg.health, dmg.armor, false, false);
          break;
        }
        case 'round_end':
          if (!isOver(this.round)) this.finishRound({ winner: o.winner, reason: o.reason }, t);
          break;
      }
    }
  }

  /** End the round on tick `t`: `round_end`, score + 1, phase over. Only call while the round is on. */
  private finishRound(end: RoundEnd, t: number): void {
    this.round = endRound(this.round, t, end);
    this.outbox.push({ type: 'round_end', winner: end.winner, reason: end.reason });
  }

  private teamCounts(): TeamCounts {
    let ctTotal = 0;
    let ctAlive = 0;
    let tTotal = 0;
    let tAlive = 0;
    for (const p of this.pawns) {
      if (p.team === 'CT') {
        ctTotal++;
        if (p.alive) ctAlive++;
      } else {
        tTotal++;
        if (p.alive) tAlive++;
      }
    }
    return { ctTotal, ctAlive, tTotal, tAlive };
  }

  private roundObs(): RoundObs {
    const b = this.bomb;
    const carrier = b.state === 'carried' ? (this.pawns.find((p) => p.inventory.some((q) => q.item === 'c4')) ?? null) : null;
    const bomb: BombObs = {
      state: b.state,
      carrier: carrier === null ? null : carrier.id,
      pos: b.state === 'carried' ? (carrier === null ? null : copyVec(carrier.move.pos)) : b.pos === null ? null : copyVec(b.pos),
      plantTick: b.plantTick,
      defuser: b.defuse !== null ? b.defuse.id : b.defusedBy,
      defuseEndTick: b.defuse !== null ? b.defuse.endTick : b.defusedTick,
    };
    const r = this.round;
    return {
      phase: roundPhase(r, isTicking(b)),
      score: { ct: r.score.ct, t: r.score.t },
      winner: r.winner,
      reason: r.reason,
      endTick: r.endTick,
      timeLeftSec: timeLeftSec(r, this.tickNo, { state: b.state, explodeTick: b.explodeTick, defusedTick: b.defusedTick }),
      bomb,
    };
  }

  // ---- internals -----------------------------------------------------------------------------

  private pawn(id: string): PawnState | null {
    return this.pawns.find((p) => p.id === id) ?? null;
  }

  /** The human's input, else the AI's for a LIVE pawn (Core inputs for it are ignored), else Core's. */
  private inputFor(id: PlayerId): PawnInput | null {
    if (id === this.human && this.humanInput !== null) return this.humanInput;
    const p = this.pawn(id);
    if (p !== null && p.mode === 'LIVE') return this.aiInputs.find((q) => q.id === id) ?? null;
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

  /**
   * B5 `set_round` (resync rewind): the clock becomes `tick` (this tick() processes it, the next observe reports
   * tick + 1) and the round and bomb state the checkpoint's. What CS2 can't put back isn't put back here either:
   * grenades in flight, smokes and fires are dropped (the Core gives an in-flight one back to its thrower), a plant or
   * defuse in progress is gone (bombFromObs), and per-pawn timers (weapon, flash, footsteps) keep running in real
   * time: they move with the clock, like CS2 game-time timers under a relabelled adapter tick.
   */
  private setRound(a: SetRoundAction): void {
    const delta = a.tick - this.tickNo;
    this.tickNo = a.tick;
    this.arms = this.arms.map((a) => ({
      ...a,
      nextAttackTick: roundNumber(a.nextAttackTick + delta),
      nextAltTick: roundNumber(a.nextAltTick + delta),
      lastShotTick: roundNumber(a.lastShotTick + delta),
    }));
    for (const p of this.pawns) {
      p.wpn = shiftWeaponState(p.wpn, delta);
      p.blindUntilTick = p.blindUntilTick === 0 ? 0 : Math.max(0, roundNumber(p.blindUntilTick + delta));
      p.nextFootstepTick = Math.max(0, roundNumber(p.nextFootstepTick + delta));
    }
    this.grenades = [];
    this.pendingDamage = [];
    this.pendingRound = [];
    const r = a.round;
    this.round = { ...this.round, score: { ct: r.score.ct, t: r.score.t }, winner: r.winner, reason: r.reason, endTick: r.endTick };
    this.bomb = bombFromObs(r.bomb, a.tick, this.tuning.bomb);
  }

  private applyAction(action: Act['actions'][number], teleported: Set<string>): void {
    // Switch on the string so action types added later fall into `default` instead of vanishing.
    const type: string = action.type;
    switch (action.type) {
      case 'teleport': {
        const p = this.pawn(action.id);
        if (p === null) return this.note('action', type, 'unknown pawn', action);
        p.move = { ...restingState(action.pos, action.yaw, p.move.pitch, p.move.crouching), jumpHeld: p.move.jumpHeld };
        {
          // 3D: stand it on the floor under the given position (the Core sends feet positions near a floor).
          const at = settle(this.geometry, action.pos, p.move.crouching, this.tuning.movement);
          p.move = roundMove({ ...p.move, pos: at.pos, onGround: at.onGround });
        }
        teleported.add(p.id);
        // A LIVE pawn that is moved re-plans from where it lands.
        if (p.ai !== null) p.ai = { ...p.ai, path: [], pathIndex: 0, dest: null, holdYaw: null };
        return;
      }
      case 'set_hp': {
        const p = this.pawn(action.id);
        if (p === null) return this.note('action', type, 'unknown pawn', action);
        p.hp = Math.max(0, action.hp);
        p.armor = Math.max(0, action.armor);
        p.helmet = action.helmet;
        p.alive = p.hp > 0;
        if (!p.alive) p.move = { ...p.move, vel: { x: 0, y: 0, z: p.move.onGround ? 0 : p.move.vel.z } };
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
        // Every set_mode LIVE starts the goal afresh (route from its first waypoint); REPLAY drops the AI state.
        p.ai = action.mode === 'LIVE' ? freshAiState(p.id, this.tickNo, p.aiDraws) : null;
        return;
      }
      case 'damage':
        this.pendingDamage.push(action);
        return;
      case 'plant':
      case 'defuse_start':
      case 'defuse_stop':
      case 'end_round':
        this.pendingRound.push(action);
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
      case 'set_round':
        this.setRound(action);
        return;
      case 'strip': {
        const p = this.pawn(action.id);
        if (p === null) return this.note('action', type, 'unknown pawn', action);
        // New weapon entities in CS2: no reload, cadence or deploy left over; with a teleport (resync) ready at once.
        p.inventory = [{ item: SPAWN_WEAPON, clip: 0, reserve: 0 }];
        p.weapon = SPAWN_WEAPON;
        p.wpn = deployState(freshWeaponState(), this.tickNo, teleported.has(p.id) ? 0 : deploySec(SPAWN_WEAPON, this.tuning));
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

/** A weapon state's timers moved by `delta` ticks (a `set_round` clock change). */
function shiftWeaponState(w: WeaponState, delta: number): WeaponState {
  return {
    ...w,
    nextAttackTick: roundNumber(w.nextAttackTick + delta),
    deployEndTick: roundNumber(w.deployEndTick + delta),
    reloadEndTick: w.reloadEndTick === null ? null : roundNumber(w.reloadEndTick + delta),
  };
}

function spawnPawn(r: RosterEntry): PawnState {
  return {
    id: r.id,
    team: r.team,
    move: restingState({ x: 0, y: 0, z: 0 }),
    hp: SPAWN_HP,
    armor: 0,
    helmet: false,
    alive: true,
    weapon: SPAWN_WEAPON,
    inventory: [{ item: SPAWN_WEAPON, clip: 0, reserve: 0 }],
    mode: 'REPLAY',
    goal: null,
    ai: null,
    aiDraws: 0,
    wpn: freshWeaponState(),
    blindUntilTick: 0,
    nextFootstepTick: 0,
    blockedBy: null,
  };
}

function shotPawn(p: PawnState): ShotPawn {
  return { id: p.id, team: p.team, pos: p.move.pos, yaw: p.move.yaw, pitch: p.move.pitch, crouching: p.move.crouching, alive: p.alive };
}

function pawnObs(p: PawnState, sees: readonly PlayerId[]): PawnObs {
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
    onGround: p.move.onGround,
    sees: [...sees],
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
  return {
    pos: roundVec(s.pos),
    vel: roundVec(s.vel),
    yaw: roundNumber(s.yaw),
    pitch: roundNumber(s.pitch),
    crouching: s.crouching,
    onGround: s.onGround,
    jumpHeld: s.jumpHeld,
    stamina: roundNumber(s.stamina),
  };
}

/** collideMove's wall check in 3D: a horizontal hull trace at the pawn's height (every point counts as walkable). */
class HullClamp implements CollisionNav {
  constructor(
    private readonly g: MapGeometry,
    private readonly z: number,
    private readonly hull: { readonly halfWidth: number; readonly height: number },
  ) {}

  isWalkable(): boolean {
    return true;
  }

  clampMove(from: NavPoint, to: NavPoint): Vec3 {
    const t = this.g.traceBox({ x: from.x, y: from.y, z: this.z }, { x: to.x, y: to.y, z: this.z }, this.hull);
    return { x: t.endX, y: t.endY, z: this.z };
  }
}
