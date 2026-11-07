/** Test-only GrenadeWorld on the real CS2 de_mirage collision mesh (src/sim2d/geometry.ts, docs/geometry.md). */
import { readFileSync } from 'node:fs';
import { MapGeometry } from '../../src/sim2d/geometry';
import type { GrenadeWorld, HullTrace } from '../../src/engine/grenades/index';
import { parseTuning, type GrenadeCs2Tuning } from '../../src/contracts/index';

const ROOT = new URL('../..', import.meta.url);

let cached: MapGeometry | null = null;

export function mirageGeometry(): MapGeometry {
  if (cached === null) cached = MapGeometry.fromBytes(new Uint8Array(readFileSync(new URL('data/geometry/mirage-geometry.bin', ROOT))));
  return cached;
}

export class MirageWorld implements GrenadeWorld {
  constructor(readonly geo: MapGeometry = mirageGeometry()) {}
  traceHull(cx: number, cy: number, cz: number, half: number, dx: number, dy: number, dz: number): HullTrace {
    const r = this.geo.traceAabb(cx, cy, cz, half, half, half, dx, dy, dz);
    return { fraction: r.fraction, hit: r.hit, nx: r.normalX, ny: r.normalY, nz: r.normalZ, startSolid: r.startSolid, allSolid: r.allSolid };
  }
  traceLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    return this.geo.traceLine(ax, ay, az, bx, by, bz);
  }
}

/** The repo's tuning `grenades.cs2`. */
export function cs2Tuning(): GrenadeCs2Tuning {
  return parseTuning(readFileSync(new URL('data/tuning.json', ROOT), 'utf8')).grenades.cs2;
}

/** Callout regions of the 2020 Mirage nav (`data/mirage-nav.json` place names): the place under (x, y) nearest in z. */
export function placeAt(x: number, y: number, z: number): string {
  const nav = JSON.parse(readFileSync(new URL('data/mirage-nav.json', ROOT), 'utf8')) as {
    places: string[];
    areas: { x1: number; y1: number; x2: number; y2: number; z1: number; z2: number; place: number }[];
  };
  let best = '';
  let bestDz = Infinity;
  for (const a of nav.areas) {
    if (x < a.x1 || x > a.x2 || y < a.y1 || y > a.y2) continue;
    const dz = Math.abs(z - (a.z1 + a.z2) / 2);
    if (dz < bestDz) {
      bestDz = dz;
      best = nav.places[a.place] ?? '';
    }
  }
  return best;
}
