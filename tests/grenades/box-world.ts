/** Test-only GrenadeWorld made of axis-aligned boxes (exact slab sweeps), for the mechanics tests. */
import type { GrenadeWorld, HullTrace } from '../../src/engine/grenades/index';

export interface Box {
  readonly min: [number, number, number];
  readonly max: [number, number, number];
}

const SKIN = 0.03125;
const NONE: HullTrace = { fraction: 1, hit: false, nx: 0, ny: 0, nz: 0, startSolid: false, allSolid: false };

export class BoxWorld implements GrenadeWorld {
  constructor(readonly boxes: readonly Box[]) {}

  /** Ground plane z = 0 over ±10000 (a 100-unit thick slab) plus the given boxes. */
  static flat(extra: readonly Box[] = []): BoxWorld {
    return new BoxWorld([{ min: [-10000, -10000, -100], max: [10000, 10000, 0] }, ...extra]);
  }

  private sweep(o: number[], d: number[], h: number): { t: number; axis: number; sign: number; inside: boolean } | null {
    let best: { t: number; axis: number; sign: number; inside: boolean } | null = null;
    for (const b of this.boxes) {
      let tIn = -Infinity;
      let tOut = Infinity;
      let axis = -1;
      let sign = 0;
      let inside = true;
      let miss = false;
      for (let a = 0; a < 3; a++) {
        const lo = (b.min[a] as number) - h;
        const hi = (b.max[a] as number) + h;
        const oa = o[a] as number;
        const da = d[a] as number;
        if (oa <= lo || oa >= hi) inside = false;
        if (da === 0) {
          if (oa <= lo || oa >= hi) {
            miss = true;
            break;
          }
          continue;
        }
        let t0 = (lo - oa) / da;
        let t1 = (hi - oa) / da;
        let s = -1;
        if (t0 > t1) {
          [t0, t1] = [t1, t0];
          s = 1;
        }
        if (t0 > tIn) {
          tIn = t0;
          axis = a;
          sign = s;
        }
        tOut = Math.min(tOut, t1);
      }
      if (miss) continue;
      if (inside) return { t: 0, axis: -1, sign: 0, inside: true };
      if (axis < 0 || tIn > tOut || tIn < 0 || tIn > 1) continue;
      if (best === null || tIn < best.t) best = { t: tIn, axis, sign, inside: false };
    }
    return best;
  }

  traceHull(cx: number, cy: number, cz: number, half: number, dx: number, dy: number, dz: number): HullTrace {
    const r = this.sweep([cx, cy, cz], [dx, dy, dz], half);
    if (r === null) return NONE;
    if (r.inside) return { fraction: 0, hit: true, nx: 0, ny: 0, nz: 1, startSolid: true, allSolid: true };
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return {
      fraction: Math.max(0, r.t - SKIN / len),
      hit: true,
      nx: r.axis === 0 ? r.sign : 0,
      ny: r.axis === 1 ? r.sign : 0,
      nz: r.axis === 2 ? r.sign : 0,
      startSolid: false,
      allSolid: false,
    };
  }

  traceLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    const r = this.sweep([ax, ay, az], [bx - ax, by - ay, bz - az], 0);
    if (r === null) return 1;
    return r.inside ? 0 : Math.max(1e-9, r.t);
  }
}
