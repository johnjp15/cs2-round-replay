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
  lineOfSight(a: NavPoint, b: NavPoint): boolean;
  zAt(p: NavPoint): number;
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
  /** Area radius (0 while flying). */
  readonly radius: number;
  /** Tick the effect ends (pop tick while flying). */
  readonly untilTick: number;
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
  readonly damage: Pick<DamageTuning, 'friendlyFire' | 'bandHeights'>;
  readonly ai: Pick<AiTuning, 'fovDeg'>;
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

  for (const gr0 of [...cur]) {
    if (gr0.phase !== 'flying' || tick < gr0.popTick) continue;
    const air = flightPos(gr0, gr0.popTick, g);
    const center = gr0.kind === 'molotov' || gr0.kind === 'smoke' ? roundVec({ x: air.x, y: air.y, z: w.nav.zAt(air) }) : air;
    outcomes.push({ type: 'pop', seq: gr0.seq, kind: gr0.kind, thrower: gr0.thrower, pos: center });
    cur = cur.filter((q) => q.seq !== gr0.seq);
    if (gr0.kind === 'smoke') {
      const r2 = g.smokeRadius * g.smokeRadius;
      cur = cur.filter((q) => !(q.kind === 'molotov' && q.phase === 'active' && q.center !== null && dist2(q.center, center) < r2));
      cur.push({ ...gr0, phase: 'active', center, untilTick: gr0.popTick + secToTicks(g.smokeSec) });
    } else if (gr0.kind === 'molotov') {
      const r2 = g.smokeRadius * g.smokeRadius;
      const smothered = cur.some((q) => isActive(q, 'smoke', tick) && q.center !== null && dist2(q.center, center) < r2);
      if (!smothered) cur.push({ ...gr0, phase: 'active', center, untilTick: gr0.popTick + secToTicks(g.molotovSec) });
    } else if (gr0.kind === 'he') {
      for (const p of w.pawns) {
        if (!p.alive || !canHurt(gr0, p, w.damage.friendlyFire)) continue;
        const body = { x: p.pos.x, y: p.pos.y, z: p.pos.z + (w.damage.bandHeights['stomach'] ?? 0) };
        const dist = Math.hypot(body.x - center.x, body.y - center.y, body.z - center.z);
        if (dist >= g.heRadius || !w.nav.lineOfSight(center, p.pos)) continue;
        const damage = roundNumber(g.heDamage * (1 - dist / g.heRadius));
        outcomes.push({ type: 'hurt', seq: gr0.seq, kind: 'he', thrower: gr0.thrower, victim: p.id, damage, armorPen: g.heArmorPen });
      }
    } else {
      for (const p of w.pawns) {
        if (!p.alive || !w.nav.lineOfSight(p.pos, center)) continue;
        if (g.smokeBlocksFlash && smokeBlocks(cur, tick, p.pos, center, g)) continue;
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
