/**
 * X1: the map packages a session can run on (docs/maps.md). Both are Mirage in the round's frame; they differ in
 * where the 3D world comes from:
 *
 * - `mirage-cs2` (default): CS2's collision mesh (awpy-data, decimated, no clips) with player clips rebuilt from the
 *   CS2 nav (data/geometry/, docs/geometry.md).
 * - `mirage-2020`: the March 2020 CS:GO `de_mirage.bsp` the round was played on: its brushes, displacements, props
 *   and real player clips, plus a render mesh with its materials and lightmaps (data/maps/mirage-2020/, built by
 *   tools/extract-bsp.ts from John's extraction, docs/csgo-2020-files.md).
 *
 * Chosen with `?map=` in both apps, `--map` in the harnesses and tools/snap-tracks.ts, and a scenario's `map` field.
 */

export const MAP_IDS = ['mirage-cs2', 'mirage-2020'] as const;
export type MapId = (typeof MAP_IDS)[number];
export const DEFAULT_MAP: MapId = 'mirage-cs2';

export class MapIdError extends Error {
  override readonly name = 'MapIdError';
}

export function isMapId(v: unknown): v is MapId {
  return typeof v === 'string' && (MAP_IDS as readonly string[]).includes(v);
}

/** A `?map=` / `--map` value: absent or empty means the default; anything else must be a known package. */
export function parseMapId(v: string | null | undefined): MapId {
  if (v === null || v === undefined || v === '') return DEFAULT_MAP;
  if (!isMapId(v)) throw new MapIdError(`unknown map package "${v}" (known: ${MAP_IDS.join(', ')})`);
  return v;
}

/** A package's files, repo-relative. `render` is null when the package has no render mesh (the app derives one). */
export interface MapPackagePaths {
  readonly geometry: string;
  readonly clips: string;
  readonly tracks: string;
  readonly render: string | null;
  readonly manifest: string;
}

export function mapPackagePaths(id: MapId): MapPackagePaths {
  if (id === 'mirage-cs2') {
    return { geometry: 'data/geometry/mirage-geometry.bin', clips: 'data/geometry/mirage-clips.bin', tracks: 'data/geometry/mirage-tracks.json', render: null, manifest: 'data/geometry/mirage-geometry.json' };
  }
  const dir = `data/maps/${id}`;
  return { geometry: `${dir}/geometry.bin`, clips: `${dir}/clips.bin`, tracks: `${dir}/tracks.json`, render: `${dir}/render.bin`, manifest: `${dir}/manifest.json` };
}
