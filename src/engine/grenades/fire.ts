/**
 * Molotov / incendiary fire (docs/grenades.md, Fire). CS2's inferno convars set the shape: up to 16 flames
 * (`inferno_max_flames`) 42 units apart (`inferno_flame_spacing`) within 150 of the burst (110 for the CT
 * incendiary), at most 4 generations deep, each new flame placed on the floor next to an existing one (walls block
 * it; it may climb a step or drop down a ledge), biased along the grenade's velocity (× 0.003), the first attempts
 * 0.02 s apart and slowing down (fitted to the measured ~1.8 s to full spread); flames burn out 6–7 s after the
 * burst (5.5 s for the incendiary). CS2's real placement uses a position-hashed generator that is not public: the
 * placement here is an approximation with the same constants, deterministic by seed. Damage is 40/s in 0.2 s steps
 * to every pawn touching a flame; an inferno dies when more than a third of its flames are in smoke, and a flame
 * never starts inside smoke.
 */
import type { GrenadeCs2Tuning, Team, Vec3 } from '../../contracts/index';
import { hashRandom, secToTicks, TICK_RATE } from './math';
import { teamScale } from './he';
import { smokeDensityAt } from './smoke';
import type { Flame, GrenadeEvent, GrenadePawn, GrenadeState, GrenadeWorld, Inferno } from './types';

/** A point counts as "in smoke" at this density. */
const SMOKED = 0.5;
/** Flames are tested for smoke this high above their floor. */
const SMOKE_PROBE = 8;
/** A new flame may not be closer than this × spacing to another. */
const MIN_GAP = 0.7;
/** Spawn attempts per inferno (failed attempts retry next tick with a new random direction). */
const ATTEMPTS_PER_FLAME = 8;
/** Pawns burn from this far below a flame's floor (stairs). */
const BELOW = 8;

function isCt(type: Inferno['type']): boolean {
  return type === 'incendiary';
}

/** The floor under (x, y) between zTop and zTop − depth, or null. */
export function floorUnder(world: GrenadeWorld, x: number, y: number, zTop: number, depth: number): number | null {
  const f = world.traceLine(x, y, zTop, x, y, zTop - depth);
  return f < 1 ? zTop - depth * f : null;
}

export type InfernoStart = { readonly inferno: Inferno } | { readonly inferno: null; readonly reason: 'airburst' | 'smoke' };

/** Start the fire of a molotov / incendiary that burst at `pos` with velocity `vel`. */
export function createInferno(
  seq: number,
  type: Inferno['type'],
  thrower: string,
  team: Team,
  pos: Vec3,
  vel: Vec3,
  tick: number,
  world: GrenadeWorld,
  state: GrenadeState,
  t: GrenadeCs2Tuning,
): InfernoStart {
  const z = floorUnder(world, pos.x, pos.y, pos.z + t.hullHalf + 1, t.hullHalf + 1 + t.molotovAirburstDrop);
  if (z === null) return { inferno: null, reason: 'airburst' };
  const center = { x: pos.x, y: pos.y, z };
  if (smokeDensityAt(state, { x: center.x, y: center.y, z: center.z + SMOKE_PROBE }, tick, t) >= SMOKED) return { inferno: null, reason: 'smoke' };
  const life = isCt(type) ? t.infernoLifetimeCt : t.infernoLifetime;
  const first: Flame = { pos: center, depth: 0, bornTick: tick, dieTick: tick + secToTicks(life - t.infernoLifetimeJitter * hashRandom(state.seed, seq, 0, 7)), children: 0 };
  const speedMult = isCt(type) ? t.infernoSpreadSpeedMultCt : t.infernoSpreadSpeedMult;
  const interval = t.infernoInitialSpawnInterval / Math.max(1e-6, speedMult);
  return {
    inferno: {
      seq,
      type,
      thrower,
      team,
      center,
      popTick: tick,
      biasX: vel.x * t.infernoVelocityFactor,
      biasY: vel.y * t.infernoVelocityFactor,
      flames: [first],
      attempts: 0,
      misses: 0,
      nextSpawnTick: tick + Math.max(1, Math.round(interval * TICK_RATE)),
      spawnInterval: interval,
      damageSteps: 0,
    },
  };
}

function alive(f: Flame, tick: number): boolean {
  return tick >= f.bornTick && tick < f.dieTick;
}

/** Try to place one new flame; returns it or null. */
function trySpawn(inf: Inferno, world: GrenadeWorld, state: GrenadeState, tick: number, t: GrenadeCs2Tuning): { flame: Flame; parent: Flame } | null {
  const parents = inf.flames
    .map((f, k) => ({ f, k }))
    .filter((e) => alive(e.f, tick) && e.f.depth < t.infernoMaxDepth)
    .sort((a, b) => a.f.children - b.f.children || a.f.depth - b.f.depth || a.k - b.k);
  // After failed attempts, move on to the next candidate parent (a surrounded flame must not stall the spread).
  const pick = parents[inf.misses % Math.max(1, parents.length)];
  if (pick === undefined) return null;
  const parent = pick.f;
  const ang = 2 * Math.PI * hashRandom(state.seed, inf.seq, inf.attempts, 1);
  // Velocity bias: |v| × inferno_velocity_factor, capped at the random unit vector's length, × decay per generation.
  const bl = Math.sqrt(inf.biasX * inf.biasX + inf.biasY * inf.biasY);
  const decay = Math.pow(t.infernoVelocityDecay, parent.depth) / Math.max(1, bl);
  let dx = Math.cos(ang) + inf.biasX * decay;
  let dy = Math.sin(ang) + inf.biasY * decay;
  const dl = Math.sqrt(dx * dx + dy * dy);
  if (dl === 0) return null;
  dx /= dl;
  dy /= dl;
  const sp = t.infernoFlameSpacing;
  const cx = parent.pos.x + dx * sp;
  const cy = parent.pos.y + dy * sp;
  const range = isCt(inf.type) ? t.infernoMaxRangeCt : t.infernoMaxRange;
  if (Math.sqrt((cx - inf.center.x) ** 2 + (cy - inf.center.y) ** 2) > range) return null;
  for (const f of inf.flames) if (alive(f, tick) && Math.sqrt((cx - f.pos.x) ** 2 + (cy - f.pos.y) ** 2) < sp * MIN_GAP) return null;
  // Spread along the surface: straight across at the surface offset, else over a step of up to infernoClimb.
  const base = parent.pos.z + t.infernoSurfaceOffset;
  let startZ = base;
  if (world.traceLine(parent.pos.x, parent.pos.y, base, cx, cy, base) < 1) {
    const high = base + t.infernoClimb;
    if (world.traceLine(parent.pos.x, parent.pos.y, base, parent.pos.x, parent.pos.y, high) < 1) return null;
    if (world.traceLine(parent.pos.x, parent.pos.y, high, cx, cy, high) < 1) return null;
    startZ = high;
  }
  const z = floorUnder(world, cx, cy, startZ, startZ - parent.pos.z + t.infernoDrop);
  if (z === null) return null;
  const pos = { x: cx, y: cy, z };
  if (smokeDensityAt(state, { x: cx, y: cy, z: z + SMOKE_PROBE }, tick, t) >= SMOKED) return null;
  const life = isCt(inf.type) ? t.infernoLifetimeCt : t.infernoLifetime;
  const r = hashRandom(state.seed, inf.seq, inf.flames.length, 7);
  return { flame: { pos, depth: parent.depth + 1, bornTick: tick, dieTick: inf.popTick + secToTicks(life - t.infernoLifetimeJitter * r), children: 0 }, parent };
}

/** True if the pawn's hull touches the flame (xy distance from the flame to the ±16 box, feet height band). */
export function touchesFlame(p: GrenadePawn, f: Flame, t: GrenadeCs2Tuning): boolean {
  const dz = p.pos.z - f.pos.z;
  if (dz < -BELOW || dz > t.flameHeight) return false;
  const qx = Math.max(0, Math.abs(p.pos.x - f.pos.x) - 16);
  const qy = Math.max(0, Math.abs(p.pos.y - f.pos.y) - 16);
  return qx * qx + qy * qy <= t.flameRadius * t.flameRadius;
}

/** Advance one inferno by one tick. Returns false once it is out. */
export function stepInferno(
  inf: Inferno,
  world: GrenadeWorld,
  state: GrenadeState,
  pawns: readonly GrenadePawn[],
  friendlyFire: boolean,
  tick: number,
  t: GrenadeCs2Tuning,
  events: GrenadeEvent[],
): boolean {
  // Spread.
  const maxAttempts = t.infernoMaxFlames * ATTEMPTS_PER_FLAME;
  if (tick >= inf.nextSpawnTick && inf.flames.length < t.infernoMaxFlames && inf.attempts < maxAttempts) {
    const got = trySpawn(inf, world, state, tick, t);
    inf.attempts++;
    if (got !== null) {
      inf.misses = 0;
      got.parent.children++;
      inf.flames.push(got.flame);
      inf.spawnInterval = Math.min(t.infernoMaxSpawnInterval, inf.spawnInterval * t.infernoSpawnGrowth);
      inf.nextSpawnTick = tick + Math.max(1, Math.round(inf.spawnInterval * TICK_RATE));
    } else {
      inf.misses++;
      inf.nextSpawnTick = tick + 1;
    }
  }
  const burning = inf.flames.filter((f) => alive(f, tick));
  // Smoke puts it out.
  if (state.smokes.length > 0 && burning.length > 0) {
    let smoked = 0;
    for (const f of burning) if (smokeDensityAt(state, { x: f.pos.x, y: f.pos.y, z: f.pos.z + SMOKE_PROBE }, tick, t) >= SMOKED) smoked++;
    if (smoked > t.infernoSmokeFraction * burning.length) {
      events.push({ type: 'fire_end', tick, seq: inf.seq, reason: 'smoked' });
      return false;
    }
  }
  if (burning.length === 0) {
    events.push({ type: 'fire_end', tick, seq: inf.seq, reason: 'burnt_out' });
    return false;
  }
  // Damage: step k at popTick + round(k × timer × 64).
  const ct = isCt(inf.type);
  const perStep = (ct ? t.infernoDamageCt : t.infernoDamage) * t.infernoDamageTimer;
  const ratio = ct ? t.incendiaryArmorRatio : t.molotovArmorRatio;
  while (inf.popTick + Math.round(inf.damageSteps * t.infernoDamageTimer * TICK_RATE) <= tick) {
    for (const p of pawns) {
      if (!p.alive) continue;
      const scale = teamScale(p, inf.thrower, inf.team, friendlyFire, t);
      if (scale <= 0) continue;
      if (!burning.some((f) => touchesFlame(p, f, t))) continue;
      events.push({
        type: 'hurt',
        tick,
        seq: inf.seq,
        grenade: inf.type,
        thrower: inf.thrower,
        victim: p.id,
        damage: perStep * scale,
        armorPen: t.fireUsesArmor ? ratio * 0.5 : 1,
        flinchSmall: ct ? t.incendiaryFlinchSmall : t.molotovFlinchSmall,
        flinchLarge: ct ? t.incendiaryFlinchLarge : t.molotovFlinchLarge,
      });
    }
    inf.damageSteps++;
  }
  return true;
}
