/**
 * H1: 3D hitscan (docs/sim3d.md "Bullets"). A bullet is a ray from the shooter's eye (`pos.z` + 64, 46 crouched)
 * along its view direction (yaw and pitch, Source convention: pitch positive = down), `damage.maxRange` long. It
 * stops at the nearest of: the first world triangle it crosses (the CS2 mesh without player clips; with H2b's
 * penetration, a pawn behind it if the bullet goes through) and the first hitbox it enters (src/engine/hitboxes.ts) of a pawn it may hit (alive,
 * not the shooter, an enemy unless `damage.friendlyFire`). The hitgroup is the hitbox's. The direction is the host's
 * (H2: view + aim punch + the inaccuracy cone), else exactly the view direction. Ties between pawns at the same distance go to the lower id.
 */
import { roundNumber, type DamageTuning, type Hitgroup, type PlayerId, type Team, type Vec3, type WeaponModelTuning } from '../contracts/index';
import { rayHitboxes, viewDir, type HitboxScale } from '../engine/hitboxes';
import { penetrate, type SolidQuery, type SolidSpan, type WeaponDef } from '../engine/weapons/index';
import type { MapGeometry } from '../sim2d/index';

export interface ShotPawn {
  readonly id: PlayerId;
  readonly team: Team;
  readonly pos: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly crouching: boolean;
  readonly alive: boolean;
}

/** Where one bullet went (for damage, the renderer's tracer and hit marker, and tests). */
export interface Shot3 {
  readonly shooter: PlayerId;
  /** The eye the ray starts from. */
  readonly from: Vec3;
  /** Where it stopped: the hitbox entry point, the wall, or the end of its range. */
  readonly to: Vec3;
  /** The pawn hit, its hitgroup and hitbox, or null (a wall or nothing). */
  readonly victim: PlayerId | null;
  readonly hitgroup: Hitgroup | null;
  readonly hitbox: string | null;
  /** Eye to impact (units), for range falloff. */
  readonly distance: number;
  /** True if a world triangle stopped it. */
  readonly wall: boolean;
  /**
   * H2b, wall penetration (only set for a bullet that went through at least one solid): the surfaces passed and,
   * for a hit behind them, the damage left at the victim (after every surface and the range falloff, before the
   * hitgroup and armor: `damageAfterHitgroup`).
   */
  readonly surfaces?: number;
  readonly penDamage?: number;
}

/** H2b: what a bullet needs to go through walls: the weapon (penetration power, damage), the solids, the model. */
export interface Penetration {
  readonly weapon: WeaponDef;
  readonly query: SolidQuery;
  readonly model: WeaponModelTuning;
}

/** Faces within this distance after a solid's exit face continue that solid (trim on a wall shares no face). */
const SOLID_ADJACENT = 4;

/**
 * H2b: the host's `SolidQuery` (src/engine/weapons/penetration.ts) on a triangle mesh: the faces the ray crosses in
 * order, taken in pairs (enter, exit); a face within 4 u after an exit continues the solid. No materials in the mesh:
 * every surface has the default modifier. The reference implementation of tests/weapons-penetration.test.ts.
 */
export function meshSolidQuery(g: MapGeometry): SolidQuery {
  return (o: Vec3, dir: Vec3, maxDistance: number): SolidSpan[] => {
    const faces: number[] = [];
    let s = 0;
    const ex = o.x + dir.x * maxDistance;
    const ey = o.y + dir.y * maxDistance;
    const ez = o.z + dir.z * maxDistance;
    for (let k = 0; k < 64 && s < maxDistance; k++) {
      const f = g.traceLine(o.x + dir.x * s, o.y + dir.y * s, o.z + dir.z * s, ex, ey, ez);
      if (f >= 1) break;
      const hit = s + f * (maxDistance - s);
      faces.push(hit);
      s = hit + 0.01;
    }
    const spans: SolidSpan[] = [];
    let i = 0;
    while (i + 1 < faces.length) {
      const enter = faces[i] as number;
      let exit = faces[i + 1] as number;
      i += 2;
      while (i < faces.length && (faces[i] as number) - exit <= SOLID_ADJACENT) {
        exit = faces[i] as number;
        i++;
      }
      spans.push({ enter, exit });
    }
    // An odd face left over (the ray ends inside a solid, or a one-sided face): a solid to the end of the ray.
    if (i < faces.length) spans.push({ enter: faces[i] as number, exit: maxDistance });
    return spans;
  };
}

export function eyeOf(p: Pick<ShotPawn, 'pos' | 'crouching'>, d: Pick<DamageTuning, 'eyeHeight' | 'crouchEyeHeight'>): Vec3 {
  return { x: p.pos.x, y: p.pos.y, z: p.pos.z + (p.crouching ? d.crouchEyeHeight : d.eyeHeight) };
}

/**
 * Trace one bullet of `shooter` through `pawns` and the world mesh, along `direction` (a unit vector: H2's
 * spread + recoil, src/engine/weapons) or, if null, exactly along the shooter's view. With `pen` (H2b) a bullet a
 * wall stops may go through it to a pawn behind (CS:GO's penetration model, src/engine/weapons/penetration.ts).
 */
export function traceShot3(shooter: ShotPawn, pawns: readonly ShotPawn[], world: MapGeometry, d: DamageTuning, direction: Vec3 | null = null, pen: Penetration | null = null): Shot3 {
  const o = eyeOf(shooter, d);
  const dir = direction ?? viewDir(shooter.yaw, shooter.pitch);
  const range = d.maxRange;
  const f = world.traceLine(o.x, o.y, o.z, o.x + dir.x * range, o.y + dir.y * range, o.z + dir.z * range);
  const wallT = f * range;
  const scale: HitboxScale = d;
  const nearest = (maxT: number): { id: PlayerId; t: number; group: Hitgroup; box: string } | null => {
    let b: { id: PlayerId; t: number; group: Hitgroup; box: string } | null = null;
    for (const p of pawns) {
      if (p.id === shooter.id || !p.alive) continue;
      if (!d.friendlyFire && p.team === shooter.team) continue;
      const hit = rayHitboxes(o, dir, maxT, p, scale);
      if (hit === null) continue;
      if (b === null || hit.t < b.t || (hit.t === b.t && p.id < b.id)) b = { id: p.id, t: hit.t, group: hit.box.group, box: hit.box.name };
    }
    return b;
  };
  const best = nearest(wallT);
  // H2b: a wall stopped the ray before any hitbox: with penetration, look for a pawn behind it and push the bullet
  // through the solids up to it (penetrate: stops on a thick solid, after 4 surfaces or under the minimum damage).
  if (best === null && f < 1 && pen !== null) {
    const behind = nearest(range);
    if (behind !== null) {
      const r = penetrate(pen.weapon, pen.query(o, dir, behind.t), behind.t, d, pen.model);
      if (r.stoppedAt === null && r.damage > 0) {
        const tt = behind.t;
        return {
          shooter: shooter.id,
          from: { x: roundNumber(o.x), y: roundNumber(o.y), z: roundNumber(o.z) },
          to: { x: roundNumber(o.x + dir.x * tt), y: roundNumber(o.y + dir.y * tt), z: roundNumber(o.z + dir.z * tt) },
          victim: behind.id,
          hitgroup: behind.group,
          hitbox: behind.box,
          distance: roundNumber(tt),
          wall: false,
          surfaces: r.surfaces,
          penDamage: roundNumber(r.damage),
        };
      }
    }
  }
  const t = best === null ? wallT : best.t;
  const to = { x: roundNumber(o.x + dir.x * t), y: roundNumber(o.y + dir.y * t), z: roundNumber(o.z + dir.z * t) };
  return {
    shooter: shooter.id,
    from: { x: roundNumber(o.x), y: roundNumber(o.y), z: roundNumber(o.z) },
    to,
    victim: best === null ? null : best.id,
    hitgroup: best === null ? null : best.group,
    hitbox: best === null ? null : best.box,
    distance: roundNumber(t),
    wall: best === null && f < 1,
  };
}

/** W1: where a knife attack went (host `swings()`, the viewmodel and sounds, tests). */
export interface Melee3 {
  readonly attacker: PlayerId;
  readonly attack: 'slash' | 'stab';
  readonly from: Vec3;
  readonly to: Vec3;
  /** The pawn hit, or null (the world or nothing). */
  readonly victim: PlayerId | null;
  /** True if the world stopped it (CS2's knife wall-hit sound). */
  readonly wall: boolean;
  /** Set by the host for a pawn hit: from behind, and the damage before armor. */
  readonly backstab?: boolean;
  readonly damage?: number;
}

/** Entry fraction (0..1) of segment o + d·s into the box [lo, hi], or null. */
function segmentBox(o: Vec3, d: Vec3, lo: Vec3, hi: Vec3): number | null {
  let t0 = 0;
  let t1 = 1;
  for (const k of ['x', 'y', 'z'] as const) {
    const dk = d[k];
    if (Math.abs(dk) < 1e-12) {
      if (o[k] < lo[k] || o[k] > hi[k]) return null;
      continue;
    }
    let a = (lo[k] - o[k]) / dk;
    let b = (hi[k] - o[k]) / dk;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;
}

/**
 * W1 (#38): CS:GO / CS2's knife trace (CKnife::SwingOrStab, src/engine/weapons/knife.ts): a line from the eye along
 * the view, `reach` units, against the world mesh and the pawns' collision boxes (MASK_SOLID: hull 32 × 32 × 72,
 * 54 crouched; not hitboxes); if it hits nothing, the same sweep with the ±16 × ±16 × ±18 head hull (the world by
 * `traceAabb`, a pawn by its box grown by the hull). Pawns it may hit as bullets: alive, not the attacker, enemies
 * unless `damage.friendlyFire`. Ties go to the lower id.
 */
export function traceMelee3(
  attacker: ShotPawn,
  pawns: readonly ShotPawn[],
  world: MapGeometry,
  d: DamageTuning,
  attack: 'slash' | 'stab',
  reach: number,
  hull: { readonly x: number; readonly y: number; readonly z: number },
  boxOf: (p: ShotPawn) => { readonly halfWidth: number; readonly height: number },
): Melee3 {
  const o = eyeOf(attacker, d);
  const dir = viewDir(attacker.yaw, attacker.pitch);
  const delta = { x: dir.x * reach, y: dir.y * reach, z: dir.z * reach };
  const nearest = (grow: { x: number; y: number; z: number }, maxF: number): { id: PlayerId; f: number } | null => {
    let b: { id: PlayerId; f: number } | null = null;
    for (const p of pawns) {
      if (p.id === attacker.id || !p.alive) continue;
      if (!d.friendlyFire && p.team === attacker.team) continue;
      const bb = boxOf(p);
      const f = segmentBox(o, delta, { x: p.pos.x - bb.halfWidth - grow.x, y: p.pos.y - bb.halfWidth - grow.y, z: p.pos.z - grow.z }, { x: p.pos.x + bb.halfWidth + grow.x, y: p.pos.y + bb.halfWidth + grow.y, z: p.pos.z + bb.height + grow.z });
      if (f === null || f > maxF) continue;
      if (b === null || f < b.f || (f === b.f && p.id < b.id)) b = { id: p.id, f };
    }
    return b;
  };
  const at = (f: number): Vec3 => ({ x: roundNumber(o.x + delta.x * f), y: roundNumber(o.y + delta.y * f), z: roundNumber(o.z + delta.z * f) });
  const from = at(0);
  const lineWall = world.traceLine(o.x, o.y, o.z, o.x + delta.x, o.y + delta.y, o.z + delta.z);
  const line = nearest({ x: 0, y: 0, z: 0 }, lineWall);
  if (line !== null) return { attacker: attacker.id, attack, from, to: at(line.f), victim: line.id, wall: false };
  if (lineWall < 1) return { attacker: attacker.id, attack, from, to: at(lineWall), victim: null, wall: true };
  const box = world.traceAabb(o.x, o.y, o.z, hull.x, hull.y, hull.z, delta.x, delta.y, delta.z);
  const swept = nearest(hull, box.fraction);
  if (swept !== null) return { attacker: attacker.id, attack, from, to: at(swept.f), victim: swept.id, wall: false };
  if (box.fraction < 1) return { attacker: attacker.id, attack, from, to: at(box.fraction), victim: null, wall: true };
  return { attacker: attacker.id, attack, from, to: at(1), victim: null, wall: false };
}
