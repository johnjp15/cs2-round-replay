/**
 * H3: a map package's facts (`map.json`, docs/maps.md): the radar transform, the bomb sites and the spawns, as
 * tools/build-map.ts writes them from awpy-data's `map_data.json`, the CS2 nav and the map's facts file
 * (`data/source/maps/<map>.json`). Read by the 3D host's map nav (src/engine/nav), the free-play start (scenarios)
 * and the apps (radar). Pure data and a validating parser.
 */
import type { Team, Vec3 } from './types';

export const MAP_INFO_FORMAT = 'cs2-round-replay/map-info@1';

/** An axis-aligned rectangle in the map's xy plane (x1 < x2, y1 < y2). */
export interface MapRect {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface MapBombsite {
  /** "A" or "B". */
  readonly name: string;
  /** The site's floor area: a point is in the site when it lies in one of the rects and between z1 and z2. */
  readonly rects: readonly MapRect[];
  readonly z1: number;
  readonly z2: number;
  /** Where a bot carrying the c4 heads to plant (on the nav). */
  readonly plant: Vec3;
}

export interface MapSpawn {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Degrees, 0 = +x, counter-clockwise (Source yaw). */
  readonly yaw: number;
}

export interface MapInfo {
  readonly format: string;
  /** awpy / CS2 map name (de_mirage). */
  readonly map: string;
  /** The package id (`MapId`). */
  readonly package: string;
  readonly name: string;
  /** awpy `map_data.json`: px = (x − posX) / scale, py = (posY − y) / scale on a `size`² radar. */
  readonly radar: { readonly posX: number; readonly posY: number; readonly scale: number; readonly size: number };
  readonly bombsites: readonly MapBombsite[];
  /** Spawn points per team, in the order players take them. */
  readonly spawns: Readonly<Record<Team, readonly MapSpawn[]>>;
}

export class MapInfoError extends Error {
  override readonly name = 'MapInfoError';
}

function fail(path: string, why: string): never {
  throw new MapInfoError(`map.json: ${path}: ${why}`);
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'expected a finite number');
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v === '') fail(path, 'expected a non-empty string');
  return v;
}

function rec(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'expected an object');
  return v as Record<string, unknown>;
}

function list(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'expected an array');
  return v;
}

function vec(v: unknown, path: string): Vec3 {
  const o = rec(v, path);
  return { x: num(o['x'], `${path}.x`), y: num(o['y'], `${path}.y`), z: num(o['z'], `${path}.z`) };
}

/** Validate a parsed `map.json` (or its text). Throws MapInfoError naming the first bad field. */
export function parseMapInfo(json: unknown): MapInfo {
  const root = rec(typeof json === 'string' ? (JSON.parse(json) as unknown) : json, 'root');
  if (root['format'] !== MAP_INFO_FORMAT) fail('format', `expected "${MAP_INFO_FORMAT}"`);
  const radar = rec(root['radar'], 'radar');
  const r = { posX: num(radar['posX'], 'radar.posX'), posY: num(radar['posY'], 'radar.posY'), scale: num(radar['scale'], 'radar.scale'), size: num(radar['size'], 'radar.size') };
  if (!(r.scale > 0)) fail('radar.scale', 'expected > 0');
  const bombsites = list(root['bombsites'], 'bombsites').map((b, i): MapBombsite => {
    const p = `bombsites[${i}]`;
    const o = rec(b, p);
    const rects = list(o['rects'], `${p}.rects`).map((q, j): MapRect => {
      const rr = rec(q, `${p}.rects[${j}]`);
      const out = { x1: num(rr['x1'], `${p}.rects[${j}].x1`), y1: num(rr['y1'], `${p}.rects[${j}].y1`), x2: num(rr['x2'], `${p}.rects[${j}].x2`), y2: num(rr['y2'], `${p}.rects[${j}].y2`) };
      if (!(out.x1 < out.x2 && out.y1 < out.y2)) fail(`${p}.rects[${j}]`, 'expected x1 < x2 and y1 < y2');
      return out;
    });
    if (rects.length === 0) fail(`${p}.rects`, 'expected at least one rect');
    const z1 = num(o['z1'], `${p}.z1`);
    const z2 = num(o['z2'], `${p}.z2`);
    if (!(z1 < z2)) fail(p, 'expected z1 < z2');
    return { name: str(o['name'], `${p}.name`), rects, z1, z2, plant: vec(o['plant'], `${p}.plant`) };
  });
  const sp = rec(root['spawns'], 'spawns');
  const spawns = (team: Team): MapSpawn[] =>
    list(sp[team], `spawns.${team}`).map((s, i) => {
      const o = rec(s, `spawns.${team}[${i}]`);
      return { x: num(o['x'], `spawns.${team}[${i}].x`), y: num(o['y'], `spawns.${team}[${i}].y`), z: num(o['z'], `spawns.${team}[${i}].z`), yaw: num(o['yaw'], `spawns.${team}[${i}].yaw`) };
    });
  return {
    format: MAP_INFO_FORMAT,
    map: str(root['map'], 'map'),
    package: str(root['package'], 'package'),
    name: str(root['name'], 'name'),
    radar: r,
    bombsites,
    spawns: { CT: spawns('CT'), T: spawns('T') },
  };
}

/** The bomb site `p` stands in (2D rects, z between the site's z1 and z2), or null. */
export function bombsiteAt(info: Pick<MapInfo, 'bombsites'>, p: Vec3): MapBombsite | null {
  for (const s of info.bombsites) {
    if (p.z < s.z1 || p.z > s.z2) continue;
    for (const r of s.rects) if (p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2) return s;
  }
  return null;
}
