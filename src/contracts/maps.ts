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
 * - H3: any awpy-data map built by tools/build-map.ts (`de_dust2`): its CS2 collision mesh, clips from its CS2 nav,
 *   the nav itself (`nav.json`), radar and facts (`map.json`: bomb sites, spawns) in data/maps/<id>/. No recording
 *   plays there: free-play scenarios only (docs/scenarios.md).
 *
 * Chosen with `?map=` in both apps, `--map` in the harnesses and tools/snap-tracks.ts, and a scenario's `map` field.
 */

export const MAP_IDS = ['mirage-cs2', 'mirage-2020', 'de_dust2'] as const;
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
  /** H3: the CS2 nav for the LIVE AI (`nav.json`, src/engine/nav/cs2-nav.ts), the facts (`map.json`, MapInfo), the radar image and the height image; null where the package has none. */
  readonly nav: string | null;
  readonly info: string | null;
  readonly radar: string | null;
  readonly height: string | null;
}

/** H3: the map's awpy / CS2 name (the round's frame for both Mirage packages). */
export function mapName(id: MapId): string {
  return id === 'mirage-cs2' || id === 'mirage-2020' ? 'de_mirage' : id;
}

/** H3: a package that has a recording to play (the Mirage round): only the Mirage ones. */
export function hasRecording(id: MapId): boolean {
  return mapName(id) === 'de_mirage';
}

export function mapPackagePaths(id: MapId): MapPackagePaths {
  // Both Mirage packages share the CS2 nav and facts (one frame); mirage-cs2's mesh lives in data/geometry/ (G2).
  const mirage = { nav: 'data/maps/mirage-cs2/nav.json', info: 'data/maps/mirage-cs2/map.json', radar: null, height: 'data/geometry/mirage-height.png' };
  if (id === 'mirage-cs2') {
    return { geometry: 'data/geometry/mirage-geometry.bin', clips: 'data/geometry/mirage-clips.bin', tracks: 'data/geometry/mirage-tracks.json', render: null, manifest: 'data/geometry/mirage-geometry.json', ...mirage };
  }
  const dir = `data/maps/${id}`;
  if (id === 'mirage-2020') {
    return { geometry: `${dir}/geometry.bin`, clips: `${dir}/clips.bin`, tracks: `${dir}/tracks.json`, render: `${dir}/render.bin`, manifest: `${dir}/manifest.json`, ...mirage };
  }
  return { geometry: `${dir}/geometry.bin`, clips: `${dir}/clips.bin`, tracks: `${dir}/tracks.json`, render: null, manifest: `${dir}/geometry.json`, nav: `${dir}/nav.json`, info: `${dir}/map.json`, radar: `${dir}/radar.png`, height: `${dir}/height.png` };
}
