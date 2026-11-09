/**
 * Grenades for the 2D sim: throw (2D ballistic flight that stops at the first wall), fuse, and the effects
 * of smoke, flash, HE and molotov. Pure functions over plain data; the host applies the damage and blind
 * outcomes (so blocked pairs, armor and deaths follow the same rules as bullets). docs/combat.md.
 */
import { roundNumber, type AiTuning, type DamageTuning, type GrenadeTuning, type PlayerId, type Team, type Vec3 } from '../contracts/index';
import { TICKS_PER_SEC } from './movement';
import type { NavPoint } from './nav';
import type { GrenadeKind } from './weapons';

const DEG = Math.PI / 180;
/** Bisection steps for the wall clamp (precision throwRange / 2^steps). */
const WALL_STEPS = 24;

/** The nav queries grenades use (NavMesh fits). */
export interface GrenadeNav {
  /** 2D: the throw clamp (and, without `effectClear`, the flash and HE line of sight). */
  lineOfSight(a: NavPoint, b: NavPoint): boolean;
  zAt(p: NavPoint): number;
  /**
   * G6 (3D, MeshSight): a flash or HE whose effect starts at `from` reaches the point `to` (a pawn's eye for a flash,
   * its body for an HE) through no wall of the CS2 mesh. Replaces `lineOfSight` for effects when present.
   */
  effectClear?(from: Vec3, to: Vec3): boolean;
  /** G6: where the effect traces of a grenade at `p` start (`landed`: it lies on the floor). Default: `p`. */
  effectOrigin?(p: Vec3, landed: boolean): Vec3;
}

/** A thrown grenade: flying, then (smoke, molotov) an active area until `untilTick`. Plain data. */
export interface Grenade {
  /** Throw order (unique per host), the sort key everywhere. */
  readonly seq: number;
  readonly kind: GrenadeKind;
  readonly thrower: PlayerId;
  readonly team: Team;
  readonly throwTick: number;
  /** Release point: thrower's x, y and eye z. */
  readonly from: Vec3;
  /** Landing point (x, y, nav floor z). */
  readonly to: Vec3;
  /** Initial vertical speed (units/s), for the in-flight height. */
  readonly vz: number;
  readonly landTick: number;
  /** Tick at which it pops (smoke, flash, HE) or bursts (molotov). */
  readonly popTick: number;
  readonly phase: 'flying' | 'active';
  /** Effect centre once popped, else null. */
  readonly center: Vec3 | null;
  /** End of the active area (exclusive); popTick while flying. */
  readonly untilTick: number;
  /** Molotov damage steps already dealt. */
  readonly fireSteps: number;
}

/** What the thrower needs to provide. */
export interface Thrower {
  readonly id: PlayerId;
  readonly team: Team;
  readonly pos: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly crouching: boolean;
}

/** What effects need to know about a pawn. */
export interface EffectPawn {
  readonly id: PlayerId;
  readonly team: Team;
  readonly pos: Vec3;
  readonly yaw: number;
  readonly alive: boolean;
  /** G6: for the eye a flash traces to (crouchEyeHeight); absent = standing. */
  readonly crouching?: boolean;
}

/** Things the host must apply, in order. */
export type GrenadeOutcome =
  | { readonly type: 'pop'; readonly seq: number; readonly kind: GrenadeKind; readonly thrower: PlayerId; readonly pos: Vec3 }
  | { readonly type: 'hurt'; readonly seq: number; readonly kind: 'he' | 'molotov'; readonly thrower: PlayerId; readonly victim: PlayerId; readonly damage: number; readonly armorPen: number }
  | { readonly type: 'blind'; readonly seq: number; readonly thrower: PlayerId; readonly victim: PlayerId; readonly untilTick: number };

/** An effect for the renderer. */
export interface GrenadeEffect {
  readonly seq: number;
  readonly kind: GrenadeKind;
  /** flying = in the air; smoke = active cloud; fire = burning molotov. */
  readonly phase: 'flying' | 'smoke' | 'fire';
  readonly thrower: PlayerId;
  readonly pos: Vec3;
  /** Area radius (0 while flying). A volumetric smoke: the radius of a disc with its footprint's area. */
  readonly radius: number;
  /** Tick the effect ends (pop tick while flying). */
  readonly untilTick: number;
  /**
   * S1: a volumetric smoke (the CS2 engine's, `GrenadeEngine`): its voxels at this tick, centres and density 0–1 (0 = not
   * grown in yet or faded), each `cellSize` units on a side. Absent for the 2D model's disc smokes.
   */
  readonly cells?: readonly SmokeCellView[];
  readonly cellSize?: number;
  /**
   * V5: a fire of the CS2 engine (`GrenadeEngine`): its burning flames at this tick (the floor point of each fire cell),
   * each `flameRadius` units across its middle. Absent for the 2D model's disc fires.
   */
  readonly flames?: readonly Vec3[];
  readonly flameRadius?: number;
}

/** One voxel of a volumetric smoke for the renderer. */
export interface SmokeCellView {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly d: number;
}

/** What the grenade engine needs to know about a pawn (bounces off players, flash exposure, blast and fire damage). */
export interface EnginePawn {
  readonly id: PlayerId;
  readonly team: Team;
  readonly alive: boolean;
  /** Feet. */
  readonly pos: Vec3;
  readonly crouching: boolean;
  readonly yaw: number;
  readonly pitch: number;
}

/** How a host steps the grenade engine. */
export interface GrenadeStepOptions {
  /** mp_friendlyfire: grenades may hurt the thrower's teammates (default false; the thrower is always hurt). */
  readonly friendlyFire?: boolean;
  /** Report full damage to the thrower and teammates: the host applies its own team-damage ratios (3D, W3). */
  readonly rawTeamDamage?: boolean;
}

/**
 * S1 / V5: the grenades of a host with the CS2 world mesh, on a real grenade engine (src/sim3d/grenades.ts: H5's
 * `src/engine/grenades`, docs/grenades.md): the CS2 throw law (eye, view angles, 1.25 × the thrower's velocity),
 * bounces on the mesh, the detonation rules, the flood-filled volumetric smoke, flash blindness, the HE blast and the
 * molotov's spreading fire. A host without one keeps the 2D model (`throwGrenade` here). Hosts call it in tick order:
 * `throwGrenade` during the tick's shots, `step` once per tick after them. Its state is plain JSON (`snapshot` /
 * `restore`).
 */
export interface GrenadeEngine {
  /** Release a grenade at host tick `tick` (full strength, ATTACK). `seq`: the host's grenade seq (effects carry it). */
  throwGrenade(kind: GrenadeKind, tick: number, seq: number, thrower: PlayerId, team: Team, eye: Vec3, pitch: number, yaw: number, velocity: Vec3): void;
  /**
   * Simulate host tick `tick`: flight, bounces, detonations, clouds growing and running out, fires spreading and
   * burning. Returns what the host applies, in order: `pop` (every detonation: the sound), `hurt` (HE, fire: raw
   * damage before armor), `blind` (flashes).
   */
  step(tick: number, pawns: readonly EnginePawn[], opts?: GrenadeStepOptions): GrenadeOutcome[];
  /** The eye-to-eye line a–b is blocked by smoke at `tick` (the tick just stepped). */
  blocks(a: Vec3, b: Vec3, tick: number): boolean;
  /** Smoke density 0–1 at `p`. */
  densityAt(p: Vec3, tick: number): number;
  /** Flying grenades, clouds and fires at `tick`, by seq (for the renderers). */
  effects(tick: number): GrenadeEffect[];
  /** True while a grenade is in flight or a cloud or fire is up. */
  active(): boolean;
  /** Plain-JSON state (null when idle). */
  snapshot(): unknown;
  restore(s: unknown): void;
  /** Drop every grenade (B5 `set_round`: grenades, clouds and fires don't survive a resync). */
  clear(): void;
}

function roundVec(v: Vec3): Vec3 {
  return { x: roundNumber(v.x), y: roundNumber(v.y), z: roundNumber(v.z) };
}

function secToTicks(sec: number): number {
  return Math.round(sec * TICKS_PER_SEC);
}

/**
 * Source's throw angle: the view pitch (positive = down) is remapped so level aim throws
 * `throwPitchOffsetDeg` upward: p' = −o + p × (90 − o) / 90 looking up, −o + p × (90 + o) / 90 looking down.
 * Returns the elevation above horizontal in degrees (= −p').
 */
export function throwElevation(pitch: number, g: Pick<GrenadeTuning, 'throwPitchOffsetDeg'>): number {
  const o = g.throwPitchOffsetDeg;
  const p = Math.max(-90, Math.min(90, pitch));
  const adjusted = p < 0 ? -o + (p * (90 - o)) / 90 : -o + (p * (90 + o)) / 90;
  return -adjusted;
}

/**
 * Throw a grenade at `tick`. Flight: speed `throwSpeed` at the throw elevation from the eye, gravity
 * `gravity`, until it falls back to the thrower's floor height (flat ground); horizontal range capped at
 * `throwRange`; then cut at the first wall (nav line of sight) and pulled `wallBackoff` units back.
 * Flight time scales with the distance actually flown. Pop: smoke at max(throw + fuseSec, landing);
 * flash and HE at throw + fuseSec (mid-air if still flying); molotov at min(landing, throw + molotovFuseSec).
 */
export function throwGrenade(
  kind: GrenadeKind,
  t: Thrower,
  tick: number,
  seq: number,
  nav: GrenadeNav,
  g: GrenadeTuning,
  d: Pick<DamageTuning, 'eyeHeight' | 'crouchEyeHeight'>,
): Grenade {
  const eye = t.crouching ? d.crouchEyeHeight : d.eyeHeight;
  const elev = throwElevation(t.pitch, g) * DEG;
  const vx = g.throwSpeed * Math.cos(elev);
  const vz = g.throwSpeed * Math.sin(elev);
  // Fall from eye height back to the floor: g/2·τ² − vz·τ − eye = 0.
  const flight = (vz + Math.sqrt(vz * vz + 2 * g.gravity * eye)) / g.gravity;
  const range = Math.max(0, vx * flight);
  let dist = Math.min(range, g.throwRange);
  const dirX = Math.cos(t.yaw * DEG);
  const dirY = Math.sin(t.yaw * DEG);
  const start = { x: t.pos.x, y: t.pos.y };
  const at = (s: number): NavPoint => ({ x: start.x + dirX * s, y: start.y + dirY * s });
  if (dist > 0 && !nav.lineOfSight(start, at(dist))) {
    let lo = 0;
    let hi = dist;
    for (let i = 0; i < WALL_STEPS; i++) {
      const mid = (lo + hi) / 2;
      if (nav.lineOfSight(start, at(mid))) lo = mid;
      else hi = mid;
    }
    dist = Math.max(0, lo - g.wallBackoff);
  }
  const land = at(dist);
  const flightSec = range > 0 ? (flight * dist) / range : flight;
  const landTick = tick + Math.max(1, secToTicks(flightSec));
  const fuseTick = tick + secToTicks(g.fuseSec);
  let popTick: number;
  if (kind === 'smoke') popTick = Math.max(fuseTick, landTick);
  else if (kind === 'molotov') popTick = Math.min(landTick, tick + secToTicks(g.molotovFuseSec));
  else popTick = fuseTick;
  return {
    seq,
    kind,
    thrower: t.id,
    team: t.team,
    throwTick: tick,
    from: roundVec({ x: start.x, y: start.y, z: t.pos.z + eye }),
    to: roundVec({ x: land.x, y: land.y, z: nav.zAt({ x: land.x, y: land.y, z: t.pos.z }) }),
    vz: roundNumber(vz),
    landTick,
    popTick,
    phase: 'flying',
    center: null,
    untilTick: popTick,
    fireSteps: 0,
  };
}

/** Position of a flying grenade at `tick` (linear in x/y, ballistic z, never below the landing floor). */
export function flightPos(gr: Grenade, tick: number, g: Pick<GrenadeTuning, 'gravity'>): Vec3 {
  if (tick >= gr.landTick) return { ...gr.to };
  const f = Math.max(0, (tick - gr.throwTick) / (gr.landTick - gr.throwTick));
  const tau = Math.max(0, tick - gr.throwTick) / TICKS_PER_SEC;
  const z = Math.max(gr.to.z, gr.from.z + gr.vz * tau - (g.gravity * tau * tau) / 2);
  return roundVec({ x: gr.from.x + (gr.to.x - gr.from.x) * f, y: gr.from.y + (gr.to.y - gr.from.y) * f, z });
}

/** Squared distance from point p to segment a–b (2D). */
function segDist2(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let s = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  s = Math.max(0, Math.min(1, s));
  const qx = ax + dx * s - px;
  const qy = ay + dy * s - py;
  return qx * qx + qy * qy;
}

function isActive(gr: Grenade, kind: GrenadeKind, tick: number): boolean {
  return gr.kind === kind && gr.phase === 'active' && gr.center !== null && gr.popTick <= tick && tick < gr.untilTick;
}

/** True if the segment a–b (2D) passes through an active smoke at `tick`. */
export function smokeBlocks(grenades: readonly Grenade[], tick: number, a: NavPoint, b: NavPoint, g: Pick<GrenadeTuning, 'smokeRadius'>): boolean {
  const r2 = g.smokeRadius * g.smokeRadius;
  for (const gr of grenades) {
    if (!isActive(gr, 'smoke', tick) || gr.center === null) continue;
    if (segDist2(a.x, a.y, b.x, b.y, gr.center.x, gr.center.y) < r2) return true;
  }
  return false;
}

/** Flying grenades, smoke clouds and fires at `tick`, by seq. */
export function activeEffects(grenades: readonly Grenade[], tick: number, g: GrenadeTuning): GrenadeEffect[] {
  const out: GrenadeEffect[] = [];
  for (const gr of [...grenades].sort((a, b) => a.seq - b.seq)) {
    if (gr.phase === 'flying') {
      out.push({ seq: gr.seq, kind: gr.kind, phase: 'flying', thrower: gr.thrower, pos: flightPos(gr, tick, g), radius: 0, untilTick: gr.popTick });
    } else if (gr.center !== null && tick < gr.untilTick) {
      const smoke = gr.kind === 'smoke';
      out.push({
        seq: gr.seq,
        kind: gr.kind,
        phase: smoke ? 'smoke' : 'fire',
        thrower: gr.thrower,
        pos: { ...gr.center },
        radius: smoke ? g.smokeRadius : g.molotovRadius,
        untilTick: gr.untilTick,
      });
    }
  }
  return out;
}

/** Can `gr` hurt pawn `p`? Enemies of the thrower and the thrower always; teammates with friendly fire. */
function canHurt(gr: Grenade, p: EffectPawn, friendlyFire: boolean): boolean {
  return p.id === gr.thrower || p.team !== gr.team || friendlyFire;
}

/** Blind time (seconds) for a pawn at distance `dist` whose view is `angleDeg` off the flash. */
export function flashSeconds(dist: number, angleDeg: number, g: GrenadeTuning, ai: Pick<AiTuning, 'fovDeg'>): number {
  const half = ai.fovDeg / 2;
  if (angleDeg > half || dist >= g.flashRange) return 0;
  const distF = 1 - dist / g.flashRange;
  const angleF = 1 - (1 - g.flashEdgeFactor) * (angleDeg / half);
  return g.flashSec * distF * angleF;
}

/** Absolute angle (degrees, 0..180) between yaw and the bearing from `from` to `to`. */
function angleOff(yaw: number, from: NavPoint, to: NavPoint): number {
  const bearing = Math.atan2(to.y - from.y, to.x - from.x) / DEG;
  let diff = (bearing - yaw) % 360;
  if (diff < -180) diff += 360;
  if (diff > 180) diff -= 360;
  return roundNumber(Math.abs(diff));
}

export interface GrenadeWorld {
  readonly nav: GrenadeNav;
  /** All pawns, sorted by id. */
  readonly pawns: readonly EffectPawn[];
  readonly grenades: GrenadeTuning;
  readonly damage: Pick<DamageTuning, 'friendlyFire' | 'bandHeights' | 'eyeHeight' | 'crouchEyeHeight'>;
  readonly ai: Pick<AiTuning, 'fovDeg'>;
  /**
   * S1: the host's other smokes (a `GrenadeEngine`'s volumetric clouds; V5: a host with one throws everything on it): `smokeBlocks` stops a flash through them (with
   * `smokeBlocksFlash`; eye to the flash), `smokeCovers` smothers a molotov that bursts in one and puts out a fire
   * when a cloud pops over it (`smokePops`, this tick's).
   */
  readonly smoke?: {
    smokeBlocks(a: Vec3, b: Vec3): boolean;
    smokeCovers(p: Vec3): boolean;
    readonly pops: readonly Vec3[];
  };
}

/**
 * Advance grenades to `tick` (call once per tick, after shots). In seq order: flying grenades whose pop
 * tick has come pop (smoke: active cloud, puts out fires it covers; flash: blinds; HE: radial damage;
 * molotov: fire, or nothing if it bursts inside a smoke); then each fire deals its due damage steps;
 * then expired clouds and fires are dropped. Returns the new list (by seq) and the outcomes in order.
 */
export function stepGrenades(list: readonly Grenade[], tick: number, w: GrenadeWorld): { grenades: Grenade[]; outcomes: GrenadeOutcome[] } {
  const g = w.grenades;
  const outcomes: GrenadeOutcome[] = [];
  let cur: Grenade[] = [...list].sort((a, b) => a.seq - b.seq);

  const nav = w.nav;
  // S1: a cloud of the host's smoke engine that popped this tick puts out the fires it lands on, as a 2D smoke does.
  const ext = w.smoke;
  if (ext !== undefined && ext.pops.length > 0) {
    const r2 = g.smokeRadius * g.smokeRadius;
    cur = cur.filter((q) => !(q.kind === 'molotov' && q.phase === 'active' && q.center !== null && ext.pops.some((c) => dist2(q.center as Vec3, c) < r2)));
  }
  for (const gr0 of [...cur]) {
    if (gr0.phase !== 'flying' || tick < gr0.popTick) continue;
    const air = flightPos(gr0, gr0.popTick, g);
    const center = gr0.kind === 'molotov' || gr0.kind === 'smoke' ? roundVec({ x: air.x, y: air.y, z: w.nav.zAt(air) }) : air;
    // G6: flash and HE effects trace on the CS2 mesh from here (on the floor if it landed before it popped).
    const origin = nav.effectOrigin === undefined ? center : nav.effectOrigin(center, gr0.popTick >= gr0.landTick);
    outcomes.push({ type: 'pop', seq: gr0.seq, kind: gr0.kind, thrower: gr0.thrower, pos: center });
    cur = cur.filter((q) => q.seq !== gr0.seq);
    if (gr0.kind === 'smoke') {
      const r2 = g.smokeRadius * g.smokeRadius;
      cur = cur.filter((q) => !(q.kind === 'molotov' && q.phase === 'active' && q.center !== null && dist2(q.center, center) < r2));
      cur.push({ ...gr0, phase: 'active', center, untilTick: gr0.popTick + secToTicks(g.smokeSec) });
    } else if (gr0.kind === 'molotov') {
      const r2 = g.smokeRadius * g.smokeRadius;
      const smothered = cur.some((q) => isActive(q, 'smoke', tick) && q.center !== null && dist2(q.center, center) < r2) || (ext !== undefined && ext.smokeCovers({ x: center.x, y: center.y, z: center.z + 8 }));
      if (!smothered) cur.push({ ...gr0, phase: 'active', center, untilTick: gr0.popTick + secToTicks(g.molotovSec) });
    } else if (gr0.kind === 'he') {
      for (const p of w.pawns) {
        if (!p.alive || !canHurt(gr0, p, w.damage.friendlyFire)) continue;
        const body = { x: p.pos.x, y: p.pos.y, z: p.pos.z + (w.damage.bandHeights['stomach'] ?? 0) };
        const dist = Math.hypot(body.x - center.x, body.y - center.y, body.z - center.z);
        if (dist >= g.heRadius) continue;
        if (nav.effectClear === undefined ? !nav.lineOfSight(center, p.pos) : !nav.effectClear(origin, body)) continue;
        const damage = roundNumber(g.heDamage * (1 - dist / g.heRadius));
        outcomes.push({ type: 'hurt', seq: gr0.seq, kind: 'he', thrower: gr0.thrower, victim: p.id, damage, armorPen: g.heArmorPen });
      }
    } else {
      for (const p of w.pawns) {
        if (!p.alive) continue;
        if (nav.effectClear === undefined) {
          if (!nav.lineOfSight(p.pos, center)) continue;
        } else {
          const eye = { x: p.pos.x, y: p.pos.y, z: p.pos.z + (p.crouching === true ? w.damage.crouchEyeHeight : w.damage.eyeHeight) };
          if (!nav.effectClear(origin, eye)) continue;
        }
        if (g.smokeBlocksFlash && smokeBlocks(cur, tick, p.pos, center, g)) continue;
        if (g.smokeBlocksFlash && ext !== undefined) {
          const eye = { x: p.pos.x, y: p.pos.y, z: p.pos.z + (p.crouching === true ? w.damage.crouchEyeHeight : w.damage.eyeHeight) };
          if (ext.smokeBlocks(eye, origin)) continue;
        }
        const sec = flashSeconds(Math.hypot(p.pos.x - center.x, p.pos.y - center.y), angleOff(p.yaw, p.pos, center), g, w.ai);
        if (sec <= 0) continue;
        outcomes.push({ type: 'blind', seq: gr0.seq, thrower: gr0.thrower, victim: p.id, untilTick: gr0.popTick + secToTicks(sec) });
      }
    }
    cur.sort((a, b) => a.seq - b.seq);
  }

  // Fire damage: step k at popTick + ⌈k × molotovTickSec × 64⌉ for k < molotovSec / molotovTickSec.
  const stepTicks = g.molotovTickSec * TICKS_PER_SEC;
  const steps = Math.round(g.molotovSec / g.molotovTickSec);
  const perStep = roundNumber(g.molotovDps * g.molotovTickSec);
  cur = cur.map((gr) => {
    if (gr.kind !== 'molotov' || gr.phase !== 'active' || gr.center === null) return gr;
    let done = gr.fireSteps;
    const c = gr.center;
    while (done < steps && gr.popTick + Math.ceil(roundNumber(done * stepTicks)) <= tick) {
      for (const p of w.pawns) {
        if (!p.alive || !canHurt(gr, p, w.damage.friendlyFire)) continue;
        if (Math.abs(p.pos.z - c.z) > g.fireHeight) continue;
        if (dist2(p.pos, c) > g.molotovRadius * g.molotovRadius) continue;
        outcomes.push({ type: 'hurt', seq: gr.seq, kind: 'molotov', thrower: gr.thrower, victim: p.id, damage: perStep, armorPen: 1 });
      }
      done++;
    }
    return done === gr.fireSteps ? gr : { ...gr, fireSteps: done };
  });

  const next = cur.filter((gr) => gr.phase === 'flying' || tick + 1 < gr.untilTick);
  return { grenades: next, outcomes };
}

function dist2(a: NavPoint, b: NavPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
