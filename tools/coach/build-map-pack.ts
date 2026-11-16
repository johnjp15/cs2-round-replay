/**
 * KM: build the coach's map packs (docs/coach/maps.md): radar, radar transform and sight mesh per map, from an
 * awpy-data release, into `data/coach/maps/<map>/`.
 *
 *   npx tsx tools/coach/build-map-pack.ts                    # every pool map (POOL_MAPS) from COACH_RELEASE
 *   npx tsx tools/coach/build-map-pack.ts de_nuke de_train   # some maps
 *   npx tsx tools/coach/build-map-pack.ts --check            # rebuild in memory from the cache; exit 1 if a committed pack is stale
 *   npx tsx tools/coach/build-map-pack.ts --release 2000943 --offline
 *
 * Built on tools/build-map.ts (`fetchRelease`: download into `logs/awpy/<release>/`, verify each zip's size and
 * SHA-256 against the release manifest; `crc32`; `AWPY_URL`) and tools/extract-geometry.ts (`readAwmh`, `buildMesh`:
 * the G2GM build the sims' `mirage-geometry.bin` uses, quantized to 1/8 unit). Nothing of the sims' packages is
 * touched, and `DEFAULT_RELEASE` (the sims' pin) is not this tool's release.
 *
 * Per map:
 * - `radar.png` (and `radar_lower.png` on two-level maps): the release's `radars/<map>.png` / `<map>_lower.png`, as is.
 * - `los.bin.gz`: the awpy-data collision mesh (`<map>.mesh`, built for line of sight: no clips, sky, glass or
 *   windows) as G2GM, gzipped (level 9) because the browser fetches it from raw.githubusercontent.com, which serves
 *   `.bin` files uncompressed. `pack.json` records the hash of the gzip file and of the G2GM inside it (zlib versions
 *   may change the gzip bytes; `--check` compares the G2GM).
 * - `pack.json` (`coach-map@1`, `CoachMapPack` below): provenance, transform, lower-level split, bounds, counts, files.
 *
 * Deterministic: the same release gives the same G2GM and the same pack.json.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { MapGeometry, encodeGeometry } from '../../src/sim2d/geometry';
import { zipEntries, zipRead } from '../bsp/assets';
import { AWPY_URL, crc32, fetchRelease } from '../build-map';
import { readCs2NavFile } from '../cs2-nav-file';
import { buildMesh, readAwmh, type Awmh } from '../extract-geometry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** The awpy-data release the packs come from: the newest tag on 2026-11-16 (CS2 1.41.9.7); it has every pool map. */
export const COACH_RELEASE = '2000943';
/** Active Duty since 8 July 2026, then the reserve maps awpy-data also carries. */
export const POOL_MAPS = ['de_ancient', 'de_anubis', 'de_cache', 'de_dust2', 'de_inferno', 'de_mirage', 'de_nuke', 'de_overpass', 'de_train', 'de_vertigo'] as const;
export const PACK_FORMAT = 'coach-map@1';
/** Largest pack the page may fetch for one map (bytes, all files). */
export const PACK_BUDGET = 1_500_000;
/**
 * Sight-mesh parameters (written into pack.json). `quant` 2: coordinates are multiples of 1/2 unit (error ≤ 1/4,
 * against hitbox radii of 3–7; the sims' Mirage mesh uses 8). The cull drops triangles no eye-to-body segment can
 * cross: every player stands on or near the CS2 nav, so both ends of a segment lie in the convex prism over the nav's
 * xy convex hull grown by `hullMargin`, between the lowest nav floor − `zBelow` and the highest + `zAbove` (eye 64 +
 * a boost 72 + margin). A triangle that misses that prism (its xy projection outside one hull edge, or entirely above
 * or below the slab) cannot block such a segment.
 */
export const LOS_PARAMS = { quant: 2, hullMargin: 64, zBelow: 64, zAbove: 200 } as const;

export function packDir(map: string): string {
  return `data/coach/maps/${map}`;
}

export interface PackFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  /** For a gzipped file: the size and SHA-256 of what is inside. */
  readonly rawBytes?: number;
  readonly rawSha256?: string;
}

/** `pack.json`. Coordinates are Source units in the map's world frame, z up. */
export interface CoachMapPack {
  readonly format: typeof PACK_FORMAT;
  readonly map: string;
  readonly source: {
    readonly release: string;
    readonly client_version: string;
    readonly patch_version: string;
    readonly buildid: string;
    readonly generated_at: string;
    readonly assets: readonly { readonly asset: string; readonly url: string; readonly sha256: string; readonly member: string; readonly crc32: string; readonly bytes: number }[];
    readonly mapData: Readonly<Record<string, unknown>>;
  };
  /** Radar pixel = ((x − pos_x) / scale, (pos_y − y) / scale), as awpy's map_data.json. */
  readonly radar: {
    readonly pos_x: number;
    readonly pos_y: number;
    readonly scale: number;
    readonly width: number;
    readonly height: number;
    /** Two-level maps: positions with z below this are drawn on `radar_lower.png` (map_data's `verticalsections.lower.AltitudeMax`); null otherwise. */
    readonly lowerBelowZ: number | null;
    readonly files: { readonly default: string; readonly lower: string | null };
  };
  readonly los: {
    readonly file: string;
    readonly quant: number;
    readonly vertices: number;
    readonly triangles: number;
    readonly bounds: { readonly minX: number; readonly minY: number; readonly minZ: number; readonly maxX: number; readonly maxY: number; readonly maxZ: number };
    readonly cull: { readonly hullMargin: number; readonly zBelow: number; readonly zAbove: number; readonly zMin: number; readonly zMax: number; readonly hull: readonly (readonly [number, number])[]; readonly sourceTriangles: number; readonly culledTriangles: number };
  };
  readonly files: readonly PackFile[];
  /** Bytes the page fetches for this map (every file). */
  readonly fetchBytes: number;
}

function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

/** Width and height from a PNG's IHDR. */
export function pngSize(b: Uint8Array): { width: number; height: number } {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) throw new Error('not a PNG');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/** Convex hull (counter-clockwise, no collinear points) of xy points (Andrew's monotone chain; sorts a copy). */
export function convexHull(points: readonly (readonly [number, number])[]): [number, number][] {
  const pts = points.map((p) => [p[0], p[1]] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as [number, number], lower[lower.length - 1] as [number, number], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as [number, number];
    while (upper.length >= 2 && cross(upper[upper.length - 2] as [number, number], upper[upper.length - 1] as [number, number], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** The source mesh without the triangles outside the prism (see LOS_PARAMS). */
export function cullMesh(src: Awmh, hull: readonly (readonly [number, number])[], margin: number, zMin: number, zMax: number): Awmh {
  const edges: number[] = [];
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i] as readonly [number, number];
    const q = hull[(i + 1) % hull.length] as readonly [number, number];
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const l = Math.sqrt(dx * dx + dy * dy);
    // Outward normal of a counter-clockwise edge, and the grown edge's offset.
    edges.push(dy / l, -dx / l, (dy * p[0] - dx * p[1]) / l + margin);
  }
  const keep: number[] = [];
  const v = src.verts;
  for (let t = 0; t < src.tris.length / 3; t++) {
    const a = (src.tris[t * 3] as number) * 3;
    const b = (src.tris[t * 3 + 1] as number) * 3;
    const c = (src.tris[t * 3 + 2] as number) * 3;
    const za = v[a + 2] as number;
    const zb = v[b + 2] as number;
    const zc = v[c + 2] as number;
    if (Math.min(za, zb, zc) > zMax || Math.max(za, zb, zc) < zMin) continue;
    let outside = false;
    for (let e = 0; e < edges.length; e += 3) {
      const nx = edges[e] as number;
      const ny = edges[e + 1] as number;
      const d = edges[e + 2] as number;
      if (nx * (v[a] as number) + ny * (v[a + 1] as number) > d && nx * (v[b] as number) + ny * (v[b + 1] as number) > d && nx * (v[c] as number) + ny * (v[c + 1] as number) > d) {
        outside = true;
        break;
      }
    }
    if (!outside) keep.push(src.tris[t * 3] as number, src.tris[t * 3 + 1] as number, src.tris[t * 3 + 2] as number);
  }
  return { verts: src.verts, tris: Uint32Array.from(keep) };
}

export interface BuiltPack {
  readonly pack: CoachMapPack;
  /** File name → bytes. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The G2GM inside los.bin.gz. */
  readonly g2gm: Uint8Array;
}

interface Manifest {
  readonly client_version: string;
  readonly patch_version: string;
  readonly buildid: string;
  readonly generated_at: string;
  readonly artifacts: Readonly<Record<string, { readonly sha256: string }>>;
  readonly maps: readonly string[];
}

/** Build one map's pack in memory from the release cache (`logs/awpy/<release>/`, fetched and verified if needed). */
export function buildPack(map: string, release: string, offline: boolean): BuiltPack {
  const { dir, manifest: m } = fetchRelease(release, offline);
  const manifest = m as unknown as Manifest;
  if (!manifest.maps.includes(map)) throw new Error(`release ${release} has no map ${map}`);
  const zips = new Map<string, Uint8Array>();
  const zip = (name: string): Uint8Array => {
    let z = zips.get(name);
    if (z === undefined) {
      z = new Uint8Array(readFileSync(join(dir, name)));
      zips.set(name, z);
    }
    return z;
  };
  const assets: CoachMapPack['source']['assets'][number][] = [];
  const member = (zipName: string, name: string, optional: boolean): Uint8Array | null => {
    const z = zip(zipName);
    const e = zipEntries(z).find((q) => q.name === name.toLowerCase());
    if (e === undefined) {
      if (optional) return null;
      throw new Error(`${zipName}: no member ${name}`);
    }
    const b = zipRead(z, e);
    assets.push({ asset: zipName, url: `${AWPY_URL}/${release}/${zipName}`, sha256: manifest.artifacts[zipName]?.sha256 ?? '', member: name, crc32: crc32(b), bytes: b.length });
    return b;
  };
  const meshBytes = member('geometry.zip', `${map}.mesh`, false) as Uint8Array;
  const radar = member('images.zip', `radars/${map}.png`, false) as Uint8Array;
  const radarLower = member('images.zip', `radars/${map}_lower.png`, true);
  const mapDataText = readFileSync(join(dir, 'map_data.json'), 'utf8');
  const allData = JSON.parse(mapDataText) as Record<string, Record<string, unknown>>;
  const mapData = allData[map];
  if (mapData === undefined) throw new Error(`map_data.json has no ${map}`);
  const num = (k: string): number => {
    const v = mapData[k];
    if (typeof v !== 'number') throw new Error(`map_data.json ${map}.${k} is not a number`);
    return v;
  };
  const sections = mapData['verticalsections'] as { lower?: { AltitudeMax?: string } } | undefined;
  const lowerMax = sections?.lower?.AltitudeMax;
  const lowerBelowZ = lowerMax === undefined ? null : Number(lowerMax);
  if (lowerBelowZ !== null && !Number.isFinite(lowerBelowZ)) throw new Error(`${map}: bad lower AltitudeMax ${lowerMax}`);
  if ((lowerBelowZ === null) !== (radarLower === null)) throw new Error(`${map}: a lower radar ${radarLower === null ? 'without' : 'with'} a lower section in map_data.json`);

  const nav = readCs2NavFile(member('navs.zip', `${map}.nav`, false) as Uint8Array);
  const navPts: [number, number][] = [];
  let navZ0 = Infinity;
  let navZ1 = -Infinity;
  for (const area of nav.areas) {
    for (let i = 0; i < area.corners.length; i += 3) {
      navPts.push([area.corners[i] as number, area.corners[i + 1] as number]);
      navZ0 = Math.min(navZ0, area.corners[i + 2] as number);
      navZ1 = Math.max(navZ1, area.corners[i + 2] as number);
    }
  }
  // The hull's corners are rounded out to whole units (and so are the slab's ends), so pack.json stays short and exact.
  const hull = convexHull(navPts).map((p) => [Math.round(p[0]), Math.round(p[1])] as [number, number]);
  const zMin = Math.floor(navZ0) - LOS_PARAMS.zBelow;
  const zMax = Math.ceil(navZ1) + LOS_PARAMS.zAbove;
  const source = readAwmh(meshBytes);
  const culled = cullMesh(source, hull, LOS_PARAMS.hullMargin + 1, zMin, zMax);
  const { mesh } = buildMesh(culled, LOS_PARAMS.quant);
  const g2gm = encodeGeometry(mesh);
  const geo = MapGeometry.fromBytes(g2gm);
  const gz = new Uint8Array(gzipSync(g2gm, { level: 9 }));
  const size = pngSize(radar);
  const files = new Map<string, Uint8Array>();
  files.set('radar.png', radar);
  if (radarLower !== null) files.set('radar_lower.png', radarLower);
  files.set('los.bin.gz', gz);
  const fileList: PackFile[] = [];
  for (const name of [...files.keys()].sort()) {
    const b = files.get(name) as Uint8Array;
    fileList.push(name === 'los.bin.gz' ? { name, bytes: b.length, sha256: sha256(b), rawBytes: g2gm.length, rawSha256: sha256(g2gm) } : { name, bytes: b.length, sha256: sha256(b) });
  }
  // map_data.json's entry with sorted keys (it is copied for provenance; null fields kept).
  const sortedData: Record<string, unknown> = {};
  for (const k of Object.keys(mapData).sort()) sortedData[k] = mapData[k];
  const mapDataBytes = new TextEncoder().encode(mapDataText);
  assets.push({ asset: 'map_data.json', url: `${AWPY_URL}/${release}/map_data.json`, sha256: sha256(mapDataBytes), member: map, crc32: '', bytes: mapDataBytes.length });
  const pack: CoachMapPack = {
    format: PACK_FORMAT,
    map,
    source: { release, client_version: manifest.client_version, patch_version: manifest.patch_version, buildid: manifest.buildid, generated_at: manifest.generated_at, assets, mapData: sortedData },
    radar: { pos_x: num('pos_x'), pos_y: num('pos_y'), scale: num('scale'), width: size.width, height: size.height, lowerBelowZ, files: { default: 'radar.png', lower: radarLower === null ? null : 'radar_lower.png' } },
    los: {
      file: 'los.bin.gz',
      quant: mesh.quant,
      vertices: geo.vertexCount,
      triangles: geo.triangleCount,
      bounds: { minX: geo.minX, minY: geo.minY, minZ: geo.minZ, maxX: geo.maxX, maxY: geo.maxY, maxZ: geo.maxZ },
      cull: { hullMargin: LOS_PARAMS.hullMargin, zBelow: LOS_PARAMS.zBelow, zAbove: LOS_PARAMS.zAbove, zMin, zMax, hull, sourceTriangles: source.tris.length / 3, culledTriangles: (source.tris.length - culled.tris.length) / 3 },
    },
    files: fileList,
    fetchBytes: fileList.reduce((s, f) => s + f.bytes, 0),
  };
  return { pack, files, g2gm };
}

export function packJson(p: CoachMapPack): string {
  return JSON.stringify(p, null, 2) + '\n';
}

/** What differs between a built pack and the committed one (empty: up to date). Gzip files compare by content. */
export function stalePack(b: BuiltPack): string[] {
  const out: string[] = [];
  const d = resolve(ROOT, packDir(b.pack.map));
  const committed = join(d, 'pack.json');
  if (!existsSync(committed)) return [`${packDir(b.pack.map)}/pack.json missing`];
  const old = JSON.parse(readFileSync(committed, 'utf8')) as CoachMapPack;
  for (const [name, bytes] of b.files) {
    const p = join(d, name);
    if (!existsSync(p)) {
      out.push(`${name} missing`);
      continue;
    }
    const have = new Uint8Array(readFileSync(p));
    if (name.endsWith('.gz')) {
      if (sha256(new Uint8Array(gunzipSync(have))) !== sha256(b.g2gm)) out.push(`${name}: content differs`);
    } else if (sha256(have) !== sha256(bytes)) out.push(`${name} differs`);
  }
  // pack.json: everything but the gzip file's own size and hash must match.
  const norm = (p: CoachMapPack): string => packJson({ ...p, files: p.files.map((f) => (f.name.endsWith('.gz') ? { ...f, bytes: 0, sha256: '' } : f)), fetchBytes: 0 });
  if (norm(old) !== norm(b.pack)) out.push('pack.json differs');
  return out;
}

export function writePack(b: BuiltPack): void {
  const d = resolve(ROOT, packDir(b.pack.map));
  mkdirSync(d, { recursive: true });
  for (const [name, bytes] of b.files) writeFileSync(join(d, name), bytes);
  writeFileSync(join(d, 'pack.json'), packJson(b.pack));
}

function main(argv: readonly string[]): void {
  let release = COACH_RELEASE;
  let offline = false;
  let check = false;
  const maps: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--release') release = argv[++i] ?? release;
    else if (a === '--offline') offline = true;
    else if (a === '--check') check = true;
    else maps.push(a);
  }
  const list = maps.length > 0 ? maps : [...POOL_MAPS];
  let bad = 0;
  console.log('| map | radar | lower | los.bin.gz | G2GM | triangles | fetched | budget |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const map of list) {
    const b = buildPack(map, release, offline);
    const f = (n: string): PackFile | undefined => b.pack.files.find((q) => q.name === n);
    const over = b.pack.fetchBytes > PACK_BUDGET;
    if (over) bad++;
    console.log(`| ${map} | ${f('radar.png')?.bytes ?? 0} | ${f('radar_lower.png')?.bytes ?? '–'} | ${f('los.bin.gz')?.bytes ?? 0} | ${b.g2gm.length} | ${b.pack.los.triangles} | ${b.pack.fetchBytes} | ${over ? 'OVER' : 'ok'} |`);
    if (check) {
      const s = stalePack(b);
      if (s.length > 0) {
        bad++;
        console.error(`${map}: stale: ${s.join('; ')}`);
      }
    } else writePack(b);
  }
  if (bad > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
