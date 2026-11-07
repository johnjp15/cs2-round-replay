/**
 * H1: sight on the CS2 mesh for the 3D host (docs/sim3d.md "Sight"), the same idea as G6's MeshSight
 * (`src/sim2d/mesh-sight.ts` on the g6-sight branch; H1 switches to it once it lands on main): a viewer sees a target
 * when a straight segment from its eye to one of the target's **aim points** crosses no world triangle. Like CS2's
 * bots (`CCSBot::IsVisible(player)`: head, gut, feet, the sides), the points are, in the order they are tried:
 *
 *   head  (z + 63, the head hitbox's centre), chest (z + 48), left / right (chest height, `SIDE_UNITS` to either side,
 *   perpendicular to the 2D line of sight), legs (z + 16); crouched heights × crouchEyeHeight / eyeHeight.
 *
 * The world mesh is `data/geometry/mirage-geometry.bin` alone (no player clips: CS2's sight and bullet traces pass
 * through `playerclip`). Glass and bullet-pass railings aren't in the mesh, so they are open. The eye is
 * `pos.z + eyeHeight` (64; 46 crouched) at the pawn's real z.
 *
 * `sees` (contract F5) adds the FOV (`ai.fovDeg / 2` of the viewer's yaw, 2D), flashes (blind see nothing) and
 * smoke (the 2D segment through an active smoke, as in 2D) exactly as `computeSees` does in src/sim2d/vision.ts.
 */
import type { PlayerId, Vec3 } from '../contracts/index';
import { HITBOXES } from '../engine/hitboxes';
import { angleOff, type MapGeometry, type SmokeQuery } from '../sim2d/index';

/** Side points' offset from the body axis (units): the chest box's half width. */
export const SIDE_UNITS = 12;
/** Aim point heights above the feet, standing (head = the head hitbox centre). */
export const AIM_HEIGHTS = { head: (HITBOXES[0] as { a: readonly number[] }).a[2] as number, chest: 48, leg: 16 } as const;

export interface SightBody {
  readonly pos: Vec3;
  readonly crouching: boolean;
}

export interface SeePawn3 extends SightBody {
  readonly id: PlayerId;
  readonly yaw: number;
  readonly alive: boolean;
  readonly blind: boolean;
}

export interface Sight3Options {
  readonly fovDeg: number;
  readonly eyeHeight: number;
  readonly crouchEyeHeight: number;
}

export class MeshSight3 {
  private readonly world: MapGeometry;
  readonly options: Sight3Options;
  /** Segments traced since construction (benchmarks; not state). */
  traces = 0;

  constructor(world: MapGeometry, options: Sight3Options) {
    this.world = world;
    this.options = { ...options };
  }

  /** The world mesh sight and bullets trace against. */
  geometry(): MapGeometry {
    return this.world;
  }

  eye(crouching: boolean): number {
    return crouching ? this.options.crouchEyeHeight : this.options.eyeHeight;
  }

  private scaled(h: number, crouching: boolean): number {
    return crouching ? (h * this.options.crouchEyeHeight) / this.options.eyeHeight : h;
  }

  /** True if the segment a → b crosses no world triangle. */
  clear(a: Vec3, b: Vec3): boolean {
    this.traces++;
    return !this.world.lineBlocked(a, b);
  }

  /** The target's aim points as seen from the viewer (head, chest, left, right, leg). */
  aimPoints(viewer: SightBody, target: SightBody): Vec3[] {
    const t = target.pos;
    const dx = t.x - viewer.pos.x;
    const dy = t.y - viewer.pos.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const px = len > 0 ? (-dy / len) * SIDE_UNITS : 0;
    const py = len > 0 ? (dx / len) * SIDE_UNITS : 0;
    const chest = t.z + this.scaled(AIM_HEIGHTS.chest, target.crouching);
    const pts: Vec3[] = [
      { x: t.x, y: t.y, z: t.z + this.scaled(AIM_HEIGHTS.head, target.crouching) },
      { x: t.x, y: t.y, z: chest },
    ];
    if (len > 0) pts.push({ x: t.x + px, y: t.y + py, z: chest }, { x: t.x - px, y: t.y - py, z: chest });
    pts.push({ x: t.x, y: t.y, z: t.z + this.scaled(AIM_HEIGHTS.leg, target.crouching) });
    return pts;
  }

  /** True if the viewer's eye sees any aim point of the target (no FOV, smoke or flash here). */
  visible(viewer: SightBody, target: SightBody): boolean {
    const eye = { x: viewer.pos.x, y: viewer.pos.y, z: viewer.pos.z + this.eye(viewer.crouching) };
    for (const p of this.aimPoints(viewer, target)) if (this.clear(eye, p)) return true;
    return false;
  }

  /**
   * `sees` for every pawn (in id order; each list sorted by id): FOV and flash per direction, then the aim-point
   * traces (each asked direction on its own: sight is not symmetric) and the 2D smoke test.
   */
  computeSees(pawns: readonly SeePawn3[], smoke: SmokeQuery): PlayerId[][] {
    const half = this.options.fovDeg / 2;
    const out: PlayerId[][] = pawns.map(() => []);
    for (let i = 0; i < pawns.length; i++) {
      const a = pawns[i] as SeePawn3;
      if (!a.alive) continue;
      for (let j = i + 1; j < pawns.length; j++) {
        const b = pawns[j] as SeePawn3;
        if (!b.alive) continue;
        const ab = !a.blind && angleOff(a.yaw, a.pos, b.pos) <= half;
        const ba = !b.blind && angleOff(b.yaw, b.pos, a.pos) <= half;
        if (!ab && !ba) continue;
        if (smoke.smokeBlocks(a.pos, b.pos)) continue;
        if (ab && this.visible(a, b)) (out[i] as PlayerId[]).push(b.id);
        if (ba && this.visible(b, a)) (out[j] as PlayerId[]).push(a.id);
      }
    }
    return out.map((xs) => [...xs].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0)));
  }
}
