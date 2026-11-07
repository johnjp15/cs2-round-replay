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
