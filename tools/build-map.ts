/**
 * H3: build the map package of any awpy-data map (docs/maps.md "Building a map package").
 *
 *   npx tsx tools/build-map.ts de_dust2                # download (if needed), verify, extract, build data/maps/de_dust2/
 *   npx tsx tools/build-map.ts de_mirage --check       # rebuild Mirage in memory: byte-identical to mirage-cs2? (exit 1 if not)
 *   npx tsx tools/build-map.ts de_mirage               # (re)write data/maps/mirage-cs2/{map,nav}.json; checks the rest
 *   npx tsx tools/build-map.ts <map> --release 2000942 --offline --skip-clips
 *   npm run map:build -- de_dust2
 *
 * 1. **Download** the awpy-data release assets (`https://github.com/pnxenopoulos/awpy-data/releases/download/<release>/`
 *    `manifest.json`, `map_data.json`, `geometry.zip`, `navs.zip`, `images.zip`) into `logs/awpy/<release>/` (curl,
 *    so the proxy works), unless they are there already, and verify each zip's size and SHA-256 against the release's
 *    `manifest.json` (a mismatch is an error, and the file is downloaded again on the next run).
 * 2. **Extract** the map's members (`<map>.mesh`, `<map>.nav`, `radars/<map>.png`) and its `map_data.json` entry into
 *    `data/source/cs2/<map>/` with `PROVENANCE.json` (URLs, SHA-256s, CRC-32s, the manifest's version fields).
 *    Mirage's three files have been in `data/source/cs2/` since G2: for `de_mirage` the extracted bytes must equal
 *    those (else an error) and nothing new is written there.
 * 3. **Facts**: `data/source/maps/<map>.json` (hand-made, cited): the bomb sites' floor rects (and the retakes planter
 *    spots) and the spawn zones, or the 2020 nav's place names on Mirage; with a built BSP package (`bspPackage`) its
 *    `func_bomb_target` boxes and `info_player_*` spawns win. The CS2 files carry neither (no nav places, no entities).
 * 4. **Build** into the package (`mapPackagePaths(id)`): the G2GM collision mesh, its manifest and height image
 *    (tools/extract-geometry.ts `buildGeometry`), the player clips from the CS2 nav flood (tools/extract-clips.ts
 *    `buildClipsFor`), `nav.json` (the nav for the LIVE AI, src/engine/nav/cs2-nav.ts), `map.json` (radar transform,
 *    bomb sites, spawns: src/contracts/map-info.ts) and `radar.png`. Seeds of the floods: the spawns (Mirage: the ten
 *    recorded start positions, as always, so its package rebuilds byte for byte).
 *
 * Everything is deterministic (same inputs → same bytes). **Valve's files: private repo and encrypted pages only.**
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAP_INFO_FORMAT, mapPackagePaths, parseMapInfo, type MapBombsite, type MapId, type MapInfo, type MapRect, type MapSpawn, type Team } from '../src/contracts/index';
import { CS2_NAV_FORMAT, Cs2Nav, type Cs2NavJson } from '../src/engine/nav/cs2-nav';
import { zipEntries, zipRead } from './bsp/assets';
import { readCs2NavFile, type Cs2NavFile } from './cs2-nav-file';
import { buildClipsFor, mirageClipSpec, type ClipProducts, type ClipSpec } from './extract-clips';
import { BIN_PATH, CS2_NAV_PATH, HEIGHT_PATH, IMAGE, MANIFEST_PATH, MESH_PATH, RADAR_PATH, buildGeometry, decodePngRgba, mirageGeometrySpec, type GeometrySpec, type ImageParams, type Products } from './extract-geometry';
import { CLIPS_MANIFEST_PATH, CLIPS_PATH } from './extract-clips';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_RELEASE = '2000942';
export const AWPY_URL = 'https://github.com/pnxenopoulos/awpy-data/releases/download';
const ASSETS = ['manifest.json', 'map_data.json', 'geometry.zip', 'navs.zip', 'images.zip'] as const;
/** Spawn points per team taken from the zones, and their least spacing (units). */
const SPAWNS_PER_TEAM = 5;
const SPAWN_SPACING = 56;
/** Bomb-site rects grow by this much around the outline and the planter spots (units); z band below / above the nav. */
const SITE_MARGIN = 64;
/** B2: how far past the planter spots' bounding box a Mirage plant zone reaches (CS2's real func_bomb_target boxes need the BSP). */
const SITE_CLIP = 130;
const SITE_Z_BELOW = 32;
const SITE_Z_ABOVE = 96;
/**
 * P3: a `func_bomb_target` is a trigger: a T is in the bomb zone while his collision hull touches its brush (Source
 * triggers fire on hull overlap). The CS:GO / CS2 player hull is 32 x 32 units, 72 high standing (Valve Developer
 * Community, "Dimensions (Half-Life 2 and Counter-Strike: Source)" / CS:GO `CCSGameMovement` hull: mins (-16, -16, 0),
 * maxs (16, 16, 72)). So the zone for the player's origin is the brush's box grown 16 units in x and y, with the origin
 * between (brush bottom - 72) and the brush top.
 */
const HULL_HALF_WIDTH = 16;
const HULL_HEIGHT = 72;

/** P3: the bomb target of site `name` ("A" / "B"): Mirage 2020 names them "A site" / "B site". */
export function bombTargetFor<T extends { readonly name: string }>(targets: readonly T[], name: string): T | null {
  const want = name.toLowerCase();
  return targets.find((b) => b.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== 'site' && w !== 'bombsite' && w !== '').at(-1) === want) ?? null;
}

function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): string {
  let c = 0xffffffff;
  for (const v of b) c = (CRC_TABLE[(c ^ v) & 0xff] as number) ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

// ---- 1–2: download, verify, extract --------------------------------------------------------------------------

interface ReleaseManifest {
  readonly artifacts: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>;
  readonly client_version: string;
  readonly patch_version: string;
  readonly buildid: string;
  readonly source_revision: string;
  readonly generated_at: string;
  readonly maps: readonly string[];
}

function download(url: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const r = spawnSync('curl', ['-sSfL', '--retry', '3', '-o', path, url], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`download failed: ${url}`);
}

/** The release's assets in the cache, downloaded if missing, zips verified against the manifest. */
export function fetchRelease(release: string, offline: boolean): { dir: string; manifest: ReleaseManifest } {
  const dir = resolve(ROOT, 'logs/awpy', release);
  for (const a of ASSETS) {
    const path = join(dir, a);
    if (existsSync(path)) continue;
    if (offline) throw new Error(`--offline: ${path} is missing`);
    console.log(`downloading ${AWPY_URL}/${release}/${a}`);
    download(`${AWPY_URL}/${release}/${a}`, path);
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ReleaseManifest;
  for (const a of ['geometry.zip', 'navs.zip', 'images.zip'] as const) {
    const want = manifest.artifacts[a];
    if (want === undefined) throw new Error(`manifest.json: no artifact ${a}`);
    const b = new Uint8Array(readFileSync(join(dir, a)));
    if (b.length !== want.bytes || sha256(b) !== want.sha256) {
      rmSync(join(dir, a));
      throw new Error(`${a}: size or SHA-256 does not match the release manifest (deleted; run again to re-download)`);
    }
  }
  return { dir, manifest };
}

export interface MapSource {
  readonly mesh: Uint8Array;
  readonly nav: Uint8Array;
  readonly radar: Uint8Array;
  readonly mapData: { readonly pos_x: number; readonly pos_y: number; readonly scale: number; readonly rotate?: number; readonly zoom?: number };
  /** Repo-relative paths of the three files. */
  readonly paths: { readonly mesh: string; readonly nav: string; readonly radar: string };
}

/** Mirage's source files have lived in data/source/cs2/ since G2. */
const MIRAGE_PATHS = { mesh: MESH_PATH, nav: CS2_NAV_PATH, radar: RADAR_PATH } as const;
export const MIRAGE_MAP_DATA = { pos_x: -3230, pos_y: 1713, scale: 5, rotate: 0, zoom: 0 } as const;

export function sourcePaths(map: string): { mesh: string; nav: string; radar: string } {
  if (map === 'de_mirage') return MIRAGE_PATHS;
  const dir = `data/source/cs2/${map}`;
  return { mesh: `${dir}/${map}.mesh`, nav: `${dir}/${map}.nav`, radar: `${dir}/${map}.png` };
}

/** Steps 1–2: the map's three files and transform (from the cache / release; written into data/source/cs2/<map>/). */
export function extractMap(map: string, release: string, offline: boolean): MapSource {
  const { dir, manifest } = fetchRelease(release, offline);
  if (!manifest.maps.includes(map)) throw new Error(`release ${release} has no map ${map} (has: ${manifest.maps.join(', ')})`);
  const member = (zip: string, name: string): Uint8Array => {
    const z = new Uint8Array(readFileSync(join(dir, zip)));
    const e = zipEntries(z).find((q) => q.name === name.toLowerCase());
    if (e === undefined) throw new Error(`${zip}: no member ${name}`);
    return zipRead(z, e);
  };
  const mesh = member('geometry.zip', `${map}.mesh`);
  const nav = member('navs.zip', `${map}.nav`);
  const radar = member('images.zip', `radars/${map}.png`);
  const mapDataText = readFileSync(join(dir, 'map_data.json'), 'utf8');
  const allData = JSON.parse(mapDataText) as Record<string, MapSource['mapData']>;
  const mapData = allData[map];
  if (mapData === undefined) throw new Error(`map_data.json has no ${map}`);
  const paths = sourcePaths(map);
  if (map === 'de_mirage') {
    for (const [what, b] of [
      ['mesh', mesh],
      ['nav', nav],
      ['radar', radar],
    ] as const) {
      if (sha256(new Uint8Array(readFileSync(resolve(ROOT, paths[what])))) !== sha256(b)) throw new Error(`de_mirage: the release's ${what} differs from ${paths[what]} (PROVENANCE.md)`);
    }
    if (mapData.pos_x !== MIRAGE_MAP_DATA.pos_x || mapData.pos_y !== MIRAGE_MAP_DATA.pos_y || mapData.scale !== MIRAGE_MAP_DATA.scale) throw new Error('de_mirage: map_data.json transform changed');
    return { mesh, nav, radar, mapData, paths };
  }
  const out = resolve(ROOT, `data/source/cs2/${map}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(ROOT, paths.mesh), mesh);
  writeFileSync(resolve(ROOT, paths.nav), nav);
  writeFileSync(resolve(ROOT, paths.radar), radar);
  const provenance = {
    format: 'cs2-round-replay/awpy-source@1',
    note: `${map} from the awpy-data release ${release} (pnxenopoulos/awpy-data, built by its CI from a CS2 install). Derived from Valve's game files: private repo / encrypted pages only.`,
    release: { tag: release, client_version: manifest.client_version, patch_version: manifest.patch_version, buildid: manifest.buildid, source_revision: manifest.source_revision, generated_at: manifest.generated_at },
    assets: [
      { asset: 'geometry.zip', url: `${AWPY_URL}/${release}/geometry.zip`, sha256: manifest.artifacts['geometry.zip']?.sha256, member: `${map}.mesh`, crc32: crc32(mesh), bytes: mesh.length, file: paths.mesh, fileSha256: sha256(mesh) },
      { asset: 'navs.zip', url: `${AWPY_URL}/${release}/navs.zip`, sha256: manifest.artifacts['navs.zip']?.sha256, member: `${map}.nav`, crc32: crc32(nav), bytes: nav.length, file: paths.nav, fileSha256: sha256(nav) },
      { asset: 'images.zip', url: `${AWPY_URL}/${release}/images.zip`, sha256: manifest.artifacts['images.zip']?.sha256, member: `radars/${map}.png`, crc32: crc32(radar), bytes: radar.length, file: paths.radar, fileSha256: sha256(radar) },
      { asset: 'map_data.json', url: `${AWPY_URL}/${release}/map_data.json`, sha256: sha256(new TextEncoder().encode(mapDataText)), entry: map, value: mapData },
    ],
  };
  writeFileSync(join(out, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');
  return { mesh, nav, radar, mapData, paths };
}

/** The committed source files of a map (no download): what --check and the tests use. */
export function committedSource(map: string): MapSource {
  const paths = sourcePaths(map);
  const rd = (p: string): Uint8Array => new Uint8Array(readFileSync(resolve(ROOT, p)));
  let mapData: MapSource['mapData'] = MIRAGE_MAP_DATA;
  if (map !== 'de_mirage') {
    const prov = JSON.parse(readFileSync(resolve(ROOT, `data/source/cs2/${map}/PROVENANCE.json`), 'utf8')) as { assets: { asset: string; value?: MapSource['mapData'] }[] };
    const v = prov.assets.find((a) => a.asset === 'map_data.json')?.value;
    if (v === undefined) throw new Error(`${map}: PROVENANCE.json has no map_data entry`);
    mapData = v;
  }
  return { mesh: rd(paths.mesh), nav: rd(paths.nav), radar: rd(paths.radar), mapData, paths };
}

// ---- 3: facts (bomb sites, spawns) ----------------------------------------------------------------------------

type Rect4 = readonly [number, number, number, number];

export interface MapFacts {
  readonly map: string;
  readonly package: string;
  readonly name: string;
  readonly bombsites: readonly { readonly name: string; readonly rects?: readonly Rect4[]; readonly legacyPlace?: string; readonly planter?: readonly (readonly [number, number, number])[] }[];
  readonly spawnZones: Readonly<Record<Team, readonly Rect4[] | string>>;
  readonly bspPackage?: string;
}

export function factsPath(map: string): string {
  return `data/source/maps/${map}.json`;
}

export function loadFacts(map: string): MapFacts {
  const p = resolve(ROOT, factsPath(map));
  if (!existsSync(p)) throw new Error(`no facts file ${factsPath(map)}: bomb sites and spawn zones are needed (docs/maps.md "Map facts")`);
  return JSON.parse(readFileSync(p, 'utf8')) as MapFacts;
}

/** The 2020 nav's areas of a place (Mirage), as rects with their heights. */
function legacyPlaceRects(place: string): { rects: MapRect[]; zMin: number; zMax: number } {
  const nav = JSON.parse(readFileSync(resolve(ROOT, 'data/mirage-nav.json'), 'utf8')) as { places: string[]; areas: { x1: number; y1: number; x2: number; y2: number; z1: number; z2: number; place: number }[] };
  const pi = nav.places.indexOf(place);
  if (pi < 0) throw new Error(`data/mirage-nav.json has no place "${place}"`);
  const areas = nav.areas.filter((a) => a.place === pi);
  return {
    rects: areas.map((a) => ({ x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 })),
    zMin: Math.min(...areas.map((a) => Math.min(a.z1, a.z2))),
    zMax: Math.max(...areas.map((a) => Math.max(a.z1, a.z2))),
  };
}

/** `nav.json` from the parsed .nav: shared corners (rounded to 1/1000), areas in file order. */
export function navJson(map: string, file: Cs2NavFile, navBytes: Uint8Array, navPath: string): Cs2NavJson {
  const corners: number[] = [];
  const index = new Map<string, number>();
  const r3 = (v: number): number => Math.round(v * 1000) / 1000;
  const areas = file.areas.map((a) => {
    const ci: number[] = [];
    for (let k = 0; k < a.corners.length; k += 3) {
      const x = r3(a.corners[k] as number);
      const y = r3(a.corners[k + 1] as number);
      const z = r3(a.corners[k + 2] as number);
      const key = `${x},${y},${z}`;
      let i = index.get(key);
      if (i === undefined) {
        i = corners.length / 3;
        index.set(key, i);
        corners.push(x, y, z);
      }
      ci.push(i);
    }
    return [a.id, a.flags, ci, a.connections.map((e) => e.map((c) => c.area))] as const;
  });
  const ladders = file.ladders.map((l) => ({ id: l.id, top: l.top.map(r3), bottom: l.bottom.map(r3), width: r3(l.width) }));
  return { format: CS2_NAV_FORMAT, map, source: { file: navPath, sha256: sha256(navBytes), version: file.version }, corners, areas, ladders };
}

function inRects(rects: readonly MapRect[], x: number, y: number): boolean {
  return rects.some((r) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2);
}

function rect4(r: Rect4): MapRect {
  return { x1: Math.min(r[0], r[2]), y1: Math.min(r[1], r[3]), x2: Math.max(r[0], r[2]), y2: Math.max(r[1], r[3]) };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

interface BspEntities {
  readonly spawns: readonly { readonly team: 'T' | 'CT'; readonly origin: readonly [number, number, number]; readonly yaw: number; readonly priority: number }[];
  readonly bombTargets: readonly { readonly name: string; readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] }[];
}

/** Bomb sites and spawns (step 3), with the nav for heights and spawn spots. */
export function mapInfo(facts: MapFacts, src: MapSource, file: Cs2NavFile, nav: Cs2Nav, radarSize: number): { info: MapInfo; notes: string[] } {
  const notes: string[] = [];
  let bsp: BspEntities | null = null;
  if (facts.bspPackage !== undefined) {
    const m = resolve(ROOT, `data/maps/${facts.bspPackage}/manifest.json`);
    if (existsSync(m)) {
      bsp = (JSON.parse(readFileSync(m, 'utf8')) as { entities: BspEntities }).entities;
      notes.push(`bomb sites and spawns from the BSP package ${facts.bspPackage}`);
    }
  }
  const navZ = (rects: readonly MapRect[]): { zMin: number; zMax: number } => {
    let zMin = Infinity;
    let zMax = -Infinity;
    for (const a of file.areas) {
      for (let k = 0; k < a.corners.length; k += 3) {
        if (!inRects(rects, a.corners[k] as number, a.corners[k + 1] as number)) continue;
        zMin = Math.min(zMin, a.corners[k + 2] as number);
        zMax = Math.max(zMax, a.corners[k + 2] as number);
      }
    }
    if (!Number.isFinite(zMin)) throw new Error('a bomb site has no nav corners inside');
    return { zMin, zMax };
  };
  const bombsites: MapBombsite[] = facts.bombsites.map((s) => {
    let rects: MapRect[];
    let z: { zMin: number; zMax: number };
    const planter = s.planter ?? [];
    const target = bsp === null ? null : bombTargetFor(bsp.bombTargets, s.name);
    if (target !== null) {
      // The brush grown by the hull (HULL_HALF_WIDTH, HULL_HEIGHT); z1/z2 below add SITE_Z_BELOW/ABOVE back.
      const g = HULL_HALF_WIDTH;
      rects = [{ x1: round3(target.min[0] - g), y1: round3(target.min[1] - g), x2: round3(target.max[0] + g), y2: round3(target.max[1] + g) }];
      z = { zMin: target.min[2] - HULL_HEIGHT + SITE_Z_BELOW, zMax: target.max[2] - SITE_Z_ABOVE };
      notes.push(`bomb site ${s.name}: the BSP's func_bomb_target "${target.name}" grown by the player hull`);
    } else if (s.legacyPlace !== undefined) {
      const l = legacyPlaceRects(s.legacyPlace);
      rects = l.rects;
      z = { zMin: l.zMin, zMax: l.zMax };
      // B2: the 2020 nav paints every area around a site with its place (B reaches Apartments and Market: 1,500 x 950
      // units). The plant zone is the planter spots' bounding box grown by SITE_CLIP (some CS2 planter spots fall in gaps of the 2020 nav), z from the CS2 nav floors in it.
      if (planter.length > 0) {
        const bx1 = Math.min(...planter.map((p) => p[0])) - SITE_CLIP;
        const bx2 = Math.max(...planter.map((p) => p[0])) + SITE_CLIP;
        const by1 = Math.min(...planter.map((p) => p[1])) - SITE_CLIP;
        const by2 = Math.max(...planter.map((p) => p[1])) + SITE_CLIP;
        rects = [{ x1: bx1, y1: by1, x2: bx2, y2: by2 }];
        z = navZ(rects);
      }
    } else {
      // The radar outline and the planter spots, grown by SITE_MARGIN: one bounding rect.
      const xs: number[] = [];
      const ys: number[] = [];
      for (const r of (s.rects ?? []).map(rect4)) {
        xs.push(r.x1, r.x2);
        ys.push(r.y1, r.y2);
      }
      for (const p of planter) {
        xs.push(p[0]);
        ys.push(p[1]);
      }
      if (xs.length === 0) throw new Error(`bomb site ${s.name}: no rects or planter spots`);
      rects = [{ x1: Math.min(...xs) - SITE_MARGIN, y1: Math.min(...ys) - SITE_MARGIN, x2: Math.max(...xs) + SITE_MARGIN, y2: Math.max(...ys) + SITE_MARGIN }];
      z = navZ(rects);
    }
    for (const p of planter) if (!inRects(rects, p[0], p[1])) notes.push(`bomb site ${s.name}: planter spot (${p[0]}, ${p[1]}) is outside its rects`);
    // The plant spot: the planter spots' mean, else the rects' area-weighted centre; on the nav.
    let px = 0;
    let py = 0;
    let pz = 0;
    if (planter.length > 0) {
      for (const p of planter) {
        px += p[0];
        py += p[1];
        pz += p[2];
      }
      px /= planter.length;
      py /= planter.length;
      pz /= planter.length;
    } else {
      let w = 0;
      for (const r of rects) {
        const a = (r.x2 - r.x1) * (r.y2 - r.y1);
        w += a;
        px += (a * (r.x1 + r.x2)) / 2;
        py += (a * (r.y1 + r.y2)) / 2;
      }
      px /= w;
      py /= w;
      pz = (z.zMin + z.zMax) / 2;
    }
    // Inside the site's floor rects (Mirage's planter mean lies on A's box stack, a hole in the 2020 areas).
    if (!inRects(rects, px, py)) {
      let best = { x: px, y: py, d: Infinity };
      for (const r of rects) {
        const x = Math.min(Math.max(px, r.x1 + 8), r.x2 - 8);
        const y = Math.min(Math.max(py, r.y1 + 8), r.y2 - 8);
        const d = Math.hypot(x - px, y - py);
        if (d < best.d) best = { x, y, d };
      }
      notes.push(`bomb site ${s.name}: plant spot moved ${best.d.toFixed(0)} units into the site's rects`);
      px = best.x;
      py = best.y;
    }
    const plant = nav.snap({ x: px, y: py, z: pz });
    return { name: s.name, rects, z1: round3(z.zMin - SITE_Z_BELOW), z2: round3(z.zMax + SITE_Z_ABOVE), plant: { x: round3(plant.x), y: round3(plant.y), z: round3(plant.z) } };
  });
  const sitesMid = { x: bombsites.reduce((s, b) => s + b.plant.x, 0) / Math.max(1, bombsites.length), y: bombsites.reduce((s, b) => s + b.plant.y, 0) / Math.max(1, bombsites.length) };
  const spawnsFor = (team: Team): MapSpawn[] => {
    if (bsp !== null) {
      const list = bsp.spawns.filter((q) => q.team === team).sort((a, b) => a.priority - b.priority);
      if (list.length > 0) return list.map((q) => ({ x: q.origin[0], y: q.origin[1], z: round3(nav.zAt({ x: q.origin[0], y: q.origin[1], z: q.origin[2] })), yaw: q.yaw }));
    }
    const zone = facts.spawnZones[team];
    const rects = typeof zone === 'string' ? legacyPlaceRects(zone).rects : zone.map(rect4);
    // Candidates: nav area centroids (vertex mean) inside the zone; nearest the zone's centre first.
    let w = 0;
    let zx = 0;
    let zy = 0;
    for (const r of rects) {
      const a = (r.x2 - r.x1) * (r.y2 - r.y1);
      w += a;
      zx += (a * (r.x1 + r.x2)) / 2;
      zy += (a * (r.y1 + r.y2)) / 2;
    }
    zx /= w;
    zy /= w;
    const cands: { x: number; y: number; z: number; d: number; id: number }[] = [];
    for (const a of file.areas) {
      const k = a.corners.length / 3;
      let x = 0;
      let y = 0;
      let zz = 0;
      for (let i = 0; i < a.corners.length; i += 3) {
        x += a.corners[i] as number;
        y += a.corners[i + 1] as number;
        zz += a.corners[i + 2] as number;
      }
      x /= k;
      y /= k;
      zz /= k;
      if (!inRects(rects, x, y) || !nav.isWalkable({ x, y, z: zz })) continue;
      cands.push({ x, y, z: nav.zAt({ x, y, z: zz }), d: Math.hypot(x - zx, y - zy), id: a.id });
    }
    cands.sort((a, b) => a.d - b.d || a.id - b.id);
    const out: MapSpawn[] = [];
    for (const c of cands) {
      if (out.length >= SPAWNS_PER_TEAM) break;
      if (out.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < SPAWN_SPACING)) continue;
      const yaw = (Math.atan2(sitesMid.y - c.y, sitesMid.x - c.x) * 180) / Math.PI;
      out.push({ x: round3(c.x), y: round3(c.y), z: round3(c.z), yaw: Math.round(yaw) });
    }
    if (out.length < SPAWNS_PER_TEAM) notes.push(`${team}: only ${out.length} spawn spots in the zone`);
    return out;
  };
  const info: MapInfo = {
    format: MAP_INFO_FORMAT,
    map: facts.map,
    package: facts.package,
    name: facts.name,
    radar: { posX: src.mapData.pos_x, posY: src.mapData.pos_y, scale: src.mapData.scale, size: radarSize },
    bombsites,
    spawns: { CT: spawnsFor('CT'), T: spawnsFor('T') },
  };
  return { info: parseMapInfo(JSON.parse(JSON.stringify(info))), notes };
}

// ---- 4: build ----------------------------------------------------------------------------------------------------

export interface MapBuild {
  readonly id: string;
  /** Repo-relative path → bytes. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly info: MapInfo;
  readonly nav: Cs2Nav;
  readonly notes: readonly string[];
  readonly geometry: Products | null;
  readonly clips: ClipProducts | null;
}

export interface BuildOptions {
  /** Skip the collision mesh and clips (the slow part): map.json, nav.json and radar only. */
  readonly skipGeometry?: boolean;
  readonly skipClips?: boolean;
}

function imageParams(src: MapSource, size: number, file: Cs2NavFile): ImageParams {
  // The height ramp spans the nav's floors (2nd to 98th percentile of the corner heights, rounded out to 10).
  const zs: number[] = [];
  for (const a of file.areas) for (let k = 2; k < a.corners.length; k += 3) zs.push(a.corners[k] as number);
  zs.sort((a, b) => a - b);
  const lo = zs[Math.floor(zs.length * 0.02)] ?? 0;
  const hi = zs[Math.floor(zs.length * 0.98)] ?? 0;
  return { originX: src.mapData.pos_x, originY: src.mapData.pos_y, unitsPerPx: src.mapData.scale, size, maskGrow: IMAGE.maskGrow, jumpUp: IMAGE.jumpUp, zLow: Math.floor(lo / 10) * 10, zHigh: Math.ceil(hi / 10) * 10 };
}

export function buildMap(map: string, src: MapSource, opts: BuildOptions = {}): MapBuild {
  const facts = loadFacts(map);
  const id = facts.package as MapId;
  const paths = mapPackagePaths(id);
  if (paths.nav === null || paths.info === null) throw new Error(`${id}: the package has no nav / map.json paths (src/contracts/maps.ts)`);
  const file = readCs2NavFile(src.nav);
  const nj = navJson(map, file, src.nav, src.paths.nav);
  const radar = decodePngRgba(src.radar);
  // Spawns need the nav (heights, walkable spots); the nav's site knowledge needs the info: two passes.
  const bare = new Cs2Nav(nj, null);
  const { info, notes } = mapInfo(facts, src, file, bare, radar.width);
  const nav = new Cs2Nav(nj, info);
  const files = new Map<string, Uint8Array>();
  const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v) + '\n');
  files.set(paths.nav, enc(nj));
  files.set(paths.info, new TextEncoder().encode(JSON.stringify(info, null, 1) + '\n'));
  if (paths.radar !== null) files.set(paths.radar, src.radar);
  let geometry: Products | null = null;
  let clips: ClipProducts | null = null;
  if (opts.skipGeometry !== true) {
    const mirage = map === 'de_mirage';
    const seeds = [...info.spawns.T, ...info.spawns.CT].map((s) => ({ x: s.x, y: s.y, z: s.z }));
    const img = mirage ? IMAGE : imageParams(src, radar.width, file);
    const gspec: GeometrySpec = mirage
      ? mirageGeometrySpec()
      : { meshPath: src.paths.mesh, radarPath: src.paths.radar, binPath: paths.geometry, heightPath: paths.height ?? `data/maps/${id}/height.png`, img, seeds, note: `${facts.name} (${map}) collision geometry for 3D movement: the CS2 physics mesh from awpy-data, quantized and re-encoded (G2GM, src/sim2d/geometry.ts). Built by tools/build-map.ts; see docs/maps.md. Derived from Valve game files: private repo / encrypted pages only.` };
    geometry = buildGeometry(gspec);
    files.set(mirage ? BIN_PATH : paths.geometry, geometry.bin);
    files.set(mirage ? MANIFEST_PATH : paths.manifest, new TextEncoder().encode(geometry.manifestText));
    files.set(mirage ? HEIGHT_PATH : (paths.height as string), geometry.heightPng);
    if (opts.skipClips !== true) {
      const cspec: ClipSpec = mirage
        ? mirageClipSpec()
        : {
            worldPath: paths.geometry,
            navPath: src.paths.nav,
            clipsPath: paths.clips,
            img,
            seeds,
            seedsPath: factsPath(map),
            previewRgba: () => radar.rgba,
            navRelief: true,
            note: `Player clips for ${facts.name} (${map}): prisms over walkable surfaces a pawn could reach that the CS2 nav does not cover. G2GM; merged into geometry.bin for movement. Built by tools/build-map.ts (tools/extract-clips.ts method); see docs/geometry.md "Player clips".`,
          };
      clips = buildClipsFor(cspec, geometry.bin);
      files.set(mirage ? CLIPS_PATH : paths.clips, clips.bin);
      files.set(mirage ? CLIPS_MANIFEST_PATH : paths.clips.replace(/\.bin$/, '.json'), new TextEncoder().encode(clips.manifestText));
    }
  }
  return { id, files, info, nav, notes, geometry, clips };
}

/** Files whose committed bytes differ from a build (the height PNG compares pixels: zlib versions differ). */
export function staleFiles(b: MapBuild): string[] {
  const out: string[] = [];
  for (const [path, bytes] of b.files) {
    const p = resolve(ROOT, path);
    if (!existsSync(p)) {
      out.push(path);
      continue;
    }
    const have = new Uint8Array(readFileSync(p));
    if (path === CLIPS_MANIFEST_PATH) {
      // Mirage's clips manifest records data/round.json's SHA-256 as the seeds' source; other agents edit the round
      // (data fixes) without moving its start positions, so that one hash doesn't count (the binary does).
      const norm = (b: Uint8Array): string => new TextDecoder().decode(b).replace(/("file": "data\/round\.json",\s*"sha256": ")[0-9a-f]{64}"/, '$1"');
      if (norm(have) !== norm(bytes)) out.push(path);
    } else if (path.endsWith('height.png')) {
      if (sha256(decodePngRgba(have).rgba) !== sha256(decodePngRgba(bytes).rgba)) out.push(path);
    } else if (sha256(have) !== sha256(bytes)) out.push(path);
  }
  return out;
}

function main(argv: readonly string[]): void {
  const map = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
  if (map === undefined) throw new Error('usage: npx tsx tools/build-map.ts <map> [--check] [--offline] [--release <tag>] [--skip-geometry] [--skip-clips]');
  const ri = argv.indexOf('--release');
  const release = ri >= 0 ? (argv[ri + 1] ?? DEFAULT_RELEASE) : DEFAULT_RELEASE;
  const check = argv.includes('--check');
  const t0 = performance.now();
  const src = check ? committedSource(map) : extractMap(map, release, argv.includes('--offline'));
  const b = buildMap(map, src, { skipGeometry: argv.includes('--skip-geometry'), skipClips: argv.includes('--skip-clips') });
  const s = ((performance.now() - t0) / 1000).toFixed(0);
  for (const n of b.notes) console.log(`note: ${n}`);
  if (check) {
    const stale = staleFiles(b);
    if (stale.length > 0) {
      console.error(`stale: ${stale.join(', ')} (run npx tsx tools/build-map.ts ${map})`);
      process.exitCode = 1;
    } else console.log(`${b.id}: ${b.files.size} files up to date (${s} s)`);
    return;
  }
  // Mirage's mesh, clips and height image are the committed mirage-cs2 package: a rebuild must not change them.
  if (map === 'de_mirage') {
    const legacy = [BIN_PATH, MANIFEST_PATH, HEIGHT_PATH, CLIPS_PATH, CLIPS_MANIFEST_PATH];
    const stale = staleFiles({ ...b, files: new Map([...b.files].filter(([p]) => legacy.includes(p))) });
    if (stale.length > 0) throw new Error(`de_mirage: the rebuild differs from the committed mirage-cs2 package: ${stale.join(', ')}`);
  }
  for (const [path, bytes] of b.files) {
    mkdirSync(dirname(resolve(ROOT, path)), { recursive: true });
    writeFileSync(resolve(ROOT, path), bytes);
  }
  const links = b.nav.linkStats();
  console.log(`${b.id}: wrote ${[...b.files.keys()].join(', ')} in ${s} s`);
  console.log(`  nav: ${b.nav.areaCount} areas, links walk ${links.walk} / drop ${links.drop} / jump ${links.jump}, ladders ${b.nav.ladderCount} (unused)`);
  console.log(`  bomb sites: ${b.info.bombsites.map((x) => `${x.name} plant (${x.plant.x}, ${x.plant.y}, ${x.plant.z})`).join('; ')}`);
  console.log(`  spawns: T ${b.info.spawns.T.length}, CT ${b.info.spawns.CT.length}`);
}


if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
