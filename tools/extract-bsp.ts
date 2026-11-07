/**
 * X1: build a map package (docs/maps.md) from a Source BSP and its extracted assets: the March 2020 CS:GO Mirage
 * (docs/csgo-2020-files.md) into `data/maps/mirage-2020/`.
 *
 *   npx tsx tools/extract-bsp.ts                       # data/source/csgo-2020/ → data/maps/mirage-2020/
 *   npx tsx tools/extract-bsp.ts --src ~/mirage-2020   # another source folder (John's extraction, before it's committed)
 *   npx tsx tools/extract-bsp.ts --check               # rebuild in memory; exit 1 if a committed file is stale
 *   npx tsx tools/extract-bsp.ts --bsp <file.bsp> --out <dir> --map-name <name>   # any BSP (the tests' public maps)
 *
 * Source folder: `maps/<map>.bsp` (required), `maps/<map>.nav`, `materials/`, `models/` and `MANIFEST.json` as
 * tools/csgo2020-files.ts writes them. Outputs (all deterministic):
 *
 * | file | what |
 * | --- | --- |
 * | `geometry.bin` | G2GM: the player-solid world (brushes, displacements, solid props) |
 * | `clips.bin` | G2GM: player clips |
 * | `grenade-clips.bin` | G2GM: grenade clips |
 * | `render.bin` | G2RM: the drawn triangles, a material each, baked vertex colours |
 * | `manifest.json` | provenance (source SHA-256s, the depot manifest), parameters, counts, bounds, entities, materials |
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeGeometry } from '../src/sim2d/geometry';
import { encodeRenderMesh } from '../src/app3d/render-package';
import { BspFile } from './bsp/bsp';
import { normalizePath } from './bsp/assets';
import { PACKAGE_PARAMS, buildPackage, type AssetLookup, type MapPackage } from './bsp/package';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_FORMAT = 'cs2-round-replay/map-package@1';
export const MIRAGE_2020 = { id: 'mirage-2020', mapName: 'de_mirage', src: 'data/source/csgo-2020', out: 'data/maps/mirage-2020' } as const;

/** Game files from an extraction folder (paths as in the game: materials/…, models/…), case-insensitively. */
export class FolderAssets implements AssetLookup {
  private readonly index = new Map<string, string>();
  used = 0;
  constructor(readonly dir: string) {
    const walk = (d: string): void => {
      if (!existsSync(d)) return;
      for (const ent of readdirSorted(d)) {
        const p = join(d, ent.name);
        if (ent.dir) walk(p);
        else this.index.set(normalizePath(relative(dir, p)), p);
      }
    };
    walk(join(dir, 'materials'));
    walk(join(dir, 'models'));
  }
  get size(): number {
    return this.index.size;
  }
  read(path: string): Uint8Array | null {
    const p = this.index.get(normalizePath(path));
    if (p === undefined) return null;
    this.used++;
    return new Uint8Array(readFileSync(p));
  }
}

function readdirSorted(d: string): { name: string; dir: boolean }[] {
  return readdirSync(d, { withFileTypes: true })
    .map((e) => ({ name: e.name, dir: e.isDirectory() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

/** JSON with sorted-insertion objects as built (the builder sorts its lists), one line per array of numbers. */
function stableJson(v: unknown): string {
  return `${JSON.stringify(v, null, 1).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, (_m, inner: string) => `[${inner.replace(/\s+/g, ' ')}]`)}\n`;
}

export interface PackageFiles {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly pkg: MapPackage;
}

export interface SourceInfo {
  /** Path of the source folder as recorded (repo-relative when inside the repo). */
  readonly dir: string;
  readonly bsp: Uint8Array;
  readonly nav: Uint8Array | null;
  /** tools/csgo2020-files.ts's MANIFEST.json, or null. */
  readonly extraction: Uint8Array | null;
  readonly assets: FolderAssets | null;
}

export function readSource(dir: string, mapName: string): SourceInfo {
  const bspPath = join(dir, 'maps', `${mapName}.bsp`);
  if (!existsSync(bspPath)) throw new Error(`${bspPath}: not found (docs/csgo-2020-files.md)`);
  const navPath = join(dir, 'maps', `${mapName}.nav`);
  const manPath = join(dir, 'MANIFEST.json');
  const rel = relative(ROOT, dir);
  return {
    dir: rel.startsWith('..') ? dir.replace(homedir(), '~') : rel,
    bsp: new Uint8Array(readFileSync(bspPath)),
    nav: existsSync(navPath) ? new Uint8Array(readFileSync(navPath)) : null,
    extraction: existsSync(manPath) ? new Uint8Array(readFileSync(manPath)) : null,
    assets: existsSync(join(dir, 'materials')) || existsSync(join(dir, 'models')) ? new FolderAssets(dir) : null,
  };
}

export function buildPackageFiles(src: SourceInfo, mapName: string, id: string): PackageFiles {
  const bsp = new BspFile(src.bsp);
  const pkg = buildPackage(bsp, { mapName, ...(src.assets === null ? {} : { assets: src.assets }) });
  const geometry = encodeGeometry(pkg.world);
  const clips = encodeGeometry(pkg.clips);
  const grenade = encodeGeometry(pkg.grenadeClips);
  const render = encodeRenderMesh(pkg.render);
  let extraction: unknown = null;
  if (src.extraction !== null) {
    const m = JSON.parse(new TextDecoder().decode(src.extraction)) as { source?: unknown; counts?: unknown };
    extraction = { sha256: sha256(src.extraction), source: m.source ?? null, counts: m.counts ?? null };
  }
  const manifest = {
    format: PACKAGE_FORMAT,
    id,
    note: `Built by tools/extract-bsp.ts from ${mapName}.bsp (docs/maps.md). Valve's data: private repo and encrypted pages only.`,
    source: {
      dir: src.dir,
      bsp: { file: `maps/${mapName}.bsp`, bytes: src.bsp.length, sha256: sha256(src.bsp), version: bsp.version, mapRevision: bsp.mapRevision },
      nav: src.nav === null ? null : { file: `maps/${mapName}.nav`, bytes: src.nav.length, sha256: sha256(src.nav) },
      assets: src.assets === null ? null : { files: src.assets.size, read: src.assets.used },
      extraction,
    },
    params: PACKAGE_PARAMS,
    outputs: {
      'geometry.bin': { bytes: geometry.length, sha256: sha256(geometry) },
      'clips.bin': { bytes: clips.length, sha256: sha256(clips) },
      'grenade-clips.bin': { bytes: grenade.length, sha256: sha256(grenade) },
      'render.bin': { bytes: render.length, sha256: sha256(render) },
    },
    counts: {
      worldVertices: pkg.world.verts.length / 3,
      worldTriangles: pkg.world.tris.length / 3,
      clipTriangles: pkg.clips.tris.length / 3,
      grenadeClipTriangles: pkg.grenadeClips.tris.length / 3,
      renderVertices: pkg.render.positions.length / 3,
      renderTriangles: pkg.render.tris.length / 3,
      materials: pkg.materials.length,
    },
    stats: pkg.stats,
    bounds: pkg.bounds,
    entities: pkg.entities,
    render: { materials: pkg.materials.map((m) => ({ name: m.name, color: m.color.map((c) => Math.round(c * 1000) / 1000), source: m.source })) },
  };
  const files = new Map<string, Uint8Array>([
    ['geometry.bin', geometry],
    ['clips.bin', clips],
    ['grenade-clips.bin', grenade],
    ['render.bin', render],
    ['manifest.json', new TextEncoder().encode(stableJson(manifest))],
  ]);
  return { files, pkg };
}

function main(argv: readonly string[]): void {
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const check = argv.includes('--check');
  const bspArg = flag('--bsp');
  let src: SourceInfo;
  let out: string;
  let mapName: string;
  let id: string;
  if (bspArg !== null) {
    mapName = flag('--map-name') ?? 'map';
    id = mapName;
    out = resolve(flag('--out') ?? join('logs', mapName));
    const bytes = new Uint8Array(readFileSync(resolve(bspArg)));
    src = { dir: relative(ROOT, resolve(bspArg)), bsp: bytes, nav: null, extraction: null, assets: null };
  } else {
    mapName = MIRAGE_2020.mapName;
    id = MIRAGE_2020.id;
    const dir = resolve(ROOT, flag('--src') ?? MIRAGE_2020.src);
    out = resolve(ROOT, flag('--out') ?? MIRAGE_2020.out);
    src = readSource(dir, mapName);
  }
  const t0 = performance.now();
  const { files, pkg } = buildPackageFiles(src, mapName, id);
  const ms = performance.now() - t0;
  if (check) {
    const stale = [...files].filter(([name, b]) => !existsSync(join(out, name)) || sha256(new Uint8Array(readFileSync(join(out, name)))) !== sha256(b)).map(([n]) => n);
    if (stale.length > 0) {
      console.error(`stale: ${stale.join(', ')} (run npx tsx tools/extract-bsp.ts)`);
      process.exitCode = 1;
    } else console.log(`${relative(ROOT, out)}: up to date`);
    return;
  }
  mkdirSync(out, { recursive: true });
  for (const [name, b] of files) writeFileSync(join(out, name), b);
  const s = pkg.stats;
  console.log(`${relative(ROOT, out) || out}: built in ${ms.toFixed(0)} ms`);
  console.log(`  world ${s.worldTriangles} triangles (${s.brushes.world ?? 0} brushes, ${s.displacements} displacements / ${s.displacementTriangles} triangles, ${s.solidProps} solid props: ${s.propsFromPhy} from .phy, ${s.propsFromHullBox} boxes, ${s.propsWithoutModel} without model files)`);
  console.log(`  clips ${s.clipTriangles} triangles (${s.brushes.clip ?? 0} brushes), grenade clips ${s.grenadeClipTriangles} (${s.brushes.grenadeClip ?? 0}), ladders ${pkg.entities.ladders.length}, water ${pkg.entities.water.length}`);
  console.log(`  render ${s.renderTriangles} triangles (${s.renderFaces} faces, ${s.skyboxFacesDropped} 3D-skybox faces dropped), materials vtf ${s.materials.vtf} / reflectivity ${s.materials.reflectivity} / palette ${s.materials.palette}`);
  console.log(`  spawns T ${pkg.entities.spawns.filter((x) => x.team === 'T').length} / CT ${pkg.entities.spawns.filter((x) => x.team === 'CT').length}, bomb targets ${pkg.entities.bombTargets.length}, buy zones ${pkg.entities.buyZones.length}`);
  for (const [name, b] of files) console.log(`  ${name}: ${b.length} bytes`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
