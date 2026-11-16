/**
 * K4 table `utility.place_index`: place names for arbitrary world points (grenade landings), from the players' own
 * `last_place_name` samples: the place of the nearest sample within `placeRadius` (3D), '' when none. Deterministic:
 * samples are taken every `placeSampleRows` rows of every played round, in slot order.
 */
import { UTILITY_TUNING } from './tuning';
import type { AnalysisContext, TableDef } from '../../analyze/context';

const CELL = 256;

export class PlaceIndex {
  private readonly names: readonly string[];
  private readonly radius: number;
  private readonly cells = new Map<number, number[]>();
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly zs: number[] = [];
  private readonly ids: number[] = [];

  constructor(names: readonly string[], radius: number) {
    this.names = names;
    this.radius = radius;
  }

  add(x: number, y: number, z: number, place: number): void {
    const k = this.xs.length;
    this.xs.push(x); this.ys.push(y); this.zs.push(z); this.ids.push(place);
    const key = PlaceIndex.key(Math.floor(x / CELL), Math.floor(y / CELL));
    const c = this.cells.get(key);
    if (c) c.push(k);
    else this.cells.set(key, [k]);
  }

  private static key(cx: number, cy: number): number {
    return (cx + 4096) * 8192 + (cy + 4096);
  }

  /** Place name nearest to (x, y, z) within the radius, '' when none. */
  placeAt(x: number, y: number, z: number): string {
    const r = Math.ceil(this.radius / CELL);
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    let best = this.radius * this.radius;
    let id = 0;
    for (let i = cx - r; i <= cx + r; i++) {
      for (let j = cy - r; j <= cy + r; j++) {
        const c = this.cells.get(PlaceIndex.key(i, j));
        if (!c) continue;
        for (const k of c) {
          const dx = (this.xs[k] ?? 0) - x;
          const dy = (this.ys[k] ?? 0) - y;
          const dz = (this.zs[k] ?? 0) - z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < best || (d === best && (this.ids[k] ?? 0) < id)) { best = d; id = this.ids[k] ?? 0; }
        }
      }
    }
    return this.names[id] ?? '';
  }
}

export function buildPlaceIndex(ctx: Pick<AnalysisContext, 'raw' | 'match'>): PlaceIndex {
  const { raw, match } = ctx;
  const tune = UTILITY_TUNING.throws;
  const idx = new PlaceIndex(raw.names.places, tune.placeRadius);
  const P = raw.players.length;
  const step = Math.max(1, Math.round(tune.placeSampleRows));
  for (const r of match.rounds) {
    if (!r.played) continue;
    for (let t = r.rowStart; t < r.rowEnd; t += step) {
      for (let p = 0; p < P; p++) {
        const i = t * P + p;
        if (raw.ticks.present[i] !== 1) continue;
        const place = raw.ticks.place[i] ?? 0;
        if (place === 0) continue;
        idx.add(raw.ticks.x[i] ?? 0, raw.ticks.y[i] ?? 0, raw.ticks.z[i] ?? 0, place);
      }
    }
  }
  return idx;
}

export const PLACE_INDEX: TableDef<PlaceIndex> = { id: 'utility.place_index', build: buildPlaceIndex };
