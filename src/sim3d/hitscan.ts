/**
 * H1: 3D hitscan (docs/sim3d.md "Bullets"). A bullet is a ray from the shooter's eye (`pos.z` + 64, 46 crouched)
 * along its view direction (yaw and pitch, Source convention: pitch positive = down), `damage.maxRange` long. It
 * stops at the nearest of: the first world triangle it crosses (the CS2 mesh without player clips; no wall
 * penetration yet, H2 adds it) and the first hitbox it enters (src/engine/hitboxes.ts) of a pawn it may hit (alive,
 * not the shooter, an enemy unless `damage.friendlyFire`). The hitgroup is the hitbox's. The direction is the host's
 * (H2: view + aim punch + the inaccuracy cone), else exactly the view direction. Ties between pawns at the same distance go to the lower id.
 */
import { roundNumber, type DamageTuning, type Hitgroup, type PlayerId, type Team, type Vec3 } from '../contracts/index';
import { rayHitboxes, viewDir, type HitboxScale } from '../engine/hitboxes';
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
}

export function eyeOf(p: Pick<ShotPawn, 'pos' | 'crouching'>, d: Pick<DamageTuning, 'eyeHeight' | 'crouchEyeHeight'>): Vec3 {
  return { x: p.pos.x, y: p.pos.y, z: p.pos.z + (p.crouching ? d.crouchEyeHeight : d.eyeHeight) };
}

/**
 * Trace one bullet of `shooter` through `pawns` and the world mesh, along `direction` (a unit vector: H2's
 * spread + recoil, src/engine/weapons) or, if null, exactly along the shooter's view.
 */
export function traceShot3(shooter: ShotPawn, pawns: readonly ShotPawn[], world: MapGeometry, d: DamageTuning, direction: Vec3 | null = null): Shot3 {
  const o = eyeOf(shooter, d);
  const dir = direction ?? viewDir(shooter.yaw, shooter.pitch);
  const range = d.maxRange;
  const f = world.traceLine(o.x, o.y, o.z, o.x + dir.x * range, o.y + dir.y * range, o.z + dir.z * range);
  const wallT = f * range;
  const scale: HitboxScale = d;
  let best: { id: PlayerId; t: number; group: Hitgroup; box: string } | null = null;
  for (const p of pawns) {
    if (p.id === shooter.id || !p.alive) continue;
    if (!d.friendlyFire && p.team === shooter.team) continue;
    const hit = rayHitboxes(o, dir, wallT, p, scale);
    if (hit === null) continue;
    if (best === null || hit.t < best.t || (hit.t === best.t && p.id < best.id)) best = { id: p.id, t: hit.t, group: hit.box.group, box: hit.box.name };
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
