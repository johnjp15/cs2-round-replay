/**
 * Grenade flight (docs/grenades.md, Projectile): Source `PhysicsToss` with CS2's numbers. Each 64 Hz tick runs
 * `substeps` (2) substeps of 1/128 s: gravity (0.4 × 800) is subtracted from vz and z advances by the average of the
 * old and new vz; the 2-unit box is swept through the world and the pawns; a hit reflects the velocity off the
 * surface normal and scales it by the elasticity (0.45; × 0.3 off a player), then the rest of the substep's move
 * continues with the new velocity (up to 4 bumps). A bounce that leaves < 20 u/s on a surface with normal z > 0.1
 * brings the grenade to rest. There is no air drag.
 */
import type { GrenadeCs2Tuning, Vec3 } from '../../contracts/index';
import { DEG, TICK_RATE, v3 } from './math';
import type { GrenadeEvent, GrenadePawn, GrenadeWorld, Projectile } from './types';

const MAX_BUMPS = 4;
/** Source DIST_EPSILON: sweeps stop this far short of the surface. */
const SKIN = 0.03125;
/** Horizontal half width of a player hull. */
const PAWN_HALF = 16;

export interface Impact {
  readonly pos: Vec3;
  /** Normal of the surface hit; null for an air burst. */
  readonly nz: number | null;
  readonly pawn: string | null;
}

interface PawnHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
  id: string;
}

/** Earliest entry of the swept box (centre p, half h, motion d) into a pawn's hull, excluding `skip`. */
function sweepPawns(p: Vec3, h: number, dx: number, dy: number, dz: number, pawns: readonly GrenadePawn[], skip: string): PawnHit | null {
  let best: PawnHit | null = null;
  for (const pw of pawns) {
    if (!pw.alive || pw.id === skip) continue;
    const lo = [pw.pos.x - PAWN_HALF - h, pw.pos.y - PAWN_HALF - h, pw.pos.z - h];
    const hi = [pw.pos.x + PAWN_HALF + h, pw.pos.y + PAWN_HALF + h, pw.pos.z + pw.height + h];
    const o = [p.x, p.y, p.z];
    const d = [dx, dy, dz];
    let tIn = -Infinity;
    let tOut = Infinity;
    let axis = -1;
    let sign = 0;
    let inside = true;
    for (let a = 0; a < 3; a++) {
      const oa = o[a] as number;
      const da = d[a] as number;
      const la = lo[a] as number;
      const ha = hi[a] as number;
      if (oa <= la || oa >= ha) inside = false;
      if (da === 0) {
        if (oa <= la || oa >= ha) {
          tIn = Infinity;
          break;
        }
        continue;
      }
      let t0 = (la - oa) / da;
      let t1 = (ha - oa) / da;
      let s = -1;
      if (t0 > t1) {
        const tmp = t0;
        t0 = t1;
        t1 = tmp;
        s = 1;
      }
      if (t0 > tIn) {
        tIn = t0;
        axis = a;
        sign = s;
      }
      if (t1 < tOut) tOut = t1;
    }
    if (inside || axis < 0 || tIn > tOut || tIn < 0 || tIn > 1) continue;
    if (best === null || tIn < best.t || (tIn === best.t && pw.id < best.id)) {
      best = { t: tIn, nx: axis === 0 ? sign : 0, ny: axis === 1 ? sign : 0, nz: axis === 2 ? sign : 0, id: pw.id };
    }
  }
  return best;
}

/**
 * Advance one projectile by one tick. Mutates `p`; returns the impact if a molotov / incendiary burst on contact.
 * Events (bounce, rest) are appended to `events`.
 */
export function stepProjectile(
  p: Projectile,
  world: GrenadeWorld,
  pawns: readonly GrenadePawn[],
  t: GrenadeCs2Tuning,
  tick: number,
  events: GrenadeEvent[],
): Impact | null {
  if (p.atRest) {
    p.path.push(p.pos);
    return null;
  }
  const fire = p.type === 'molotov' || p.type === 'incendiary';
  const cosSlope = Math.cos(t.molotovMaxSlopeDeg * DEG);
  const h = 1 / (TICK_RATE * t.substeps);
  const g = t.gravity * t.gravityScale;
  let x = p.pos.x;
  let y = p.pos.y;
  let z = p.pos.z;
  let vx = p.vel.x;
  let vy = p.vel.y;
  let vz = p.vel.z;
  let impact: Impact | null = null;
  outer: for (let sub = 0; sub < t.substeps; sub++) {
    const vz1 = vz - g * h;
    let dx = vx * h;
    let dy = vy * h;
    let dz = ((vz + vz1) / 2) * h;
    vz = vz1;
    let left = 1;
    for (let bump = 0; bump < MAX_BUMPS; bump++) {
      const mx = dx * left;
      const my = dy * left;
      const mz = dz * left;
      if (mx === 0 && my === 0 && mz === 0) break;
      const tr = world.traceHull(x, y, z, t.hullHalf, mx, my, mz);
      if (tr.allSolid) {
        vx = 0;
        vy = 0;
        vz = 0;
        p.atRest = true;
        events.push({ type: 'rest', tick, seq: p.seq, pos: v3(x, y, z) });
        break outer;
      }
      let f = tr.hit ? tr.fraction : 1;
      let nx = tr.nx;
      let ny = tr.ny;
      let nz = tr.nz;
      let pawn: string | null = null;
      const ph = sweepPawns(v3(x, y, z), t.hullHalf, mx, my, mz, pawns, p.thrower);
      const len = Math.sqrt(mx * mx + my * my + mz * mz);
      if (ph !== null) {
        const fp = Math.max(0, ph.t - SKIN / len);
        if (!tr.hit || fp < f) {
          f = fp;
          nx = ph.nx;
          ny = ph.ny;
          nz = ph.nz;
          pawn = ph.id;
        }
      }
      x += mx * f;
      y += my * f;
      z += mz * f;
      if (!tr.hit && pawn === null) break;
      // Reflect off the surface (backoff 2), scale by the elasticity.
      const e = pawn !== null ? t.elasticity * t.playerElasticity : t.elasticity;
      const vn = vx * nx + vy * ny + vz * nz;
      vx = (vx - 2 * vn * nx) * e;
      vy = (vy - 2 * vn * ny) * e;
      vz = (vz - 2 * vn * nz) * e;
      p.bounces++;
      events.push({ type: 'bounce', tick, seq: p.seq, pos: v3(x, y, z), pawn });
      if (fire && (pawn !== null || nz >= cosSlope)) {
        impact = { pos: v3(x, y, z), nz: pawn !== null ? null : nz, pawn };
        vx = 0;
        vy = 0;
        vz = 0;
        break outer;
      }
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (nz > t.restNormalZ && speed < t.restSpeed) {
        vx = 0;
        vy = 0;
        vz = 0;
        p.atRest = true;
        events.push({ type: 'rest', tick, seq: p.seq, pos: v3(x, y, z) });
        break outer;
      }
      left *= 1 - f;
      dx = vx * h;
      dy = vy * h;
      dz = vz * h;
    }
  }
  p.pos = v3(x, y, z);
  p.vel = v3(vx, vy, vz);
  p.path.push(p.pos);
  return impact;
}
