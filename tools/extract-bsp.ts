/**
 * X1: build a map package (docs/maps.md) from a Source BSP and its extracted assets: the March 2020 CS:GO Mirage
 * (docs/csgo-2020-files.md) into `data/maps/mirage-2020/`.
 *
 *   npx tsx tools/extract-bsp.ts                       # data/source/csgo-2020/ → data/maps/mirage-2020/
 *   npx tsx tools/extract-bsp.ts --src ~/mirage-2020   # another source folder (John's extraction, before it's committed)
 *   npx tsx tools/extract-bsp.ts --check               # rebuild in memory; exit 1 if a committed file is stale
 *   npx tsx tools/extract-bsp.ts --compare             # the built package vs the CS2 one at every recorded sample (markdown)
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
import { MapGeometry, combineMeshes, decodeGeometry, encodeGeometry } from '../src/sim2d/geometry';
import { PLAYER_IDS, mapPackagePaths, type MapId, type PlayerId, type RoundData } from '../src/contracts/index';
import { loadRound, standLevels } from './extract-geometry';
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

/** One package's answer at a recorded sample: is there a stand level within `window` of the recorded z at (x, y)? */
interface SampleFit {
  readonly level: number | null;
  readonly standing: boolean;
}

function fitAt(g: MapGeometry, x: number, y: number, z: number, window: number): SampleFit {
  let best: SampleFit = { level: null, standing: false };
  for (const l of standLevels(g, x, y, z + window, z - window)) if (best.level === null || Math.abs(l.z - z) < Math.abs(best.level - z)) best = { level: l.z, standing: l.standing };
  return best;
}

/** The movement mesh (world + player clips) of a package. */
export function movementGeometry(map: MapId): MapGeometry {
  const p = mapPackagePaths(map);
  return new MapGeometry(combineMeshes(decodeGeometry(new Uint8Array(readFileSync(resolve(ROOT, p.geometry)))), decodeGeometry(new Uint8Array(readFileSync(resolve(ROOT, p.clips))))));
}

/**
 * X1 step 4: the two packages at every recorded track sample (data/round.json, 10 Hz, x/y from the 2020 video, z
 * from the 2020 nav): how often a hull stands right there (a stand level within 32 of the recorded z, the hull free),
 * and how far the floors are from the recording's z. The 2020 package should fit the recording almost everywhere.
 */
export function compareReport(round: RoundData, a: { name: string; g: MapGeometry }, b: { name: string; g: MapGeometry }): string {
  const window = 32;
  const rows: string[] = [];
  const tot = { n: 0, fitA: 0, fitB: 0, dzA: [] as number[], dzB: [] as number[], onlyA: 0, onlyB: 0, diff: [] as number[] };
  for (const id of PLAYER_IDS) {
    const tr = round.tracks[id as PlayerId];
    if (tr === undefined) continue;
    let n = 0;
    let fa = 0;
    let fb = 0;
    for (const s of tr.samples) {
      const ra = fitAt(a.g, s.x, s.y, s.z, window);
      const rb = fitAt(b.g, s.x, s.y, s.z, window);
      n++;
      const okA = ra.level !== null;
      const okB = rb.level !== null;
      if (okA) {
        fa++;
        tot.dzA.push(Math.abs((ra.level as number) - s.z));
      }
      if (okB) {
        fb++;
        tot.dzB.push(Math.abs((rb.level as number) - s.z));
      }
      if (okA && !okB) tot.onlyA++;
      if (okB && !okA) tot.onlyB++;
      if (okA && okB) tot.diff.push(Math.abs((ra.level as number) - (rb.level as number)));
    }
    tot.n += n;
    tot.fitA += fa;
    tot.fitB += fb;
    rows.push(`| ${id} | ${n} | ${fa} (${((100 * fa) / n).toFixed(1)} %) | ${fb} (${((100 * fb) / n).toFixed(1)} %) |`);
  }
  const pct = (v: number[], p: number): string => {
    const s = [...v].sort((x, y) => x - y);
    return s.length === 0 ? '–' : (s[Math.min(s.length - 1, Math.floor(s.length * p))] as number).toFixed(1);
  };
  const within = (v: number[], d: number): string => `${v.filter((x) => x <= d).length}`;
  return [
    `| player | samples | a hull stands there: ${a.name} | ${b.name} |`,
    '| --- | ---: | ---: | ---: |',
    ...rows,
    `| **all** | ${tot.n} | ${tot.fitA} (${((100 * tot.fitA) / tot.n).toFixed(1)} %) | ${tot.fitB} (${((100 * tot.fitB) / tot.n).toFixed(1)} %) |`,
    '',
    `| | ${a.name} | ${b.name} |`,
    '| --- | ---: | ---: |',
    `| samples a hull fits at only on this map | ${tot.onlyA} | ${tot.onlyB} |`,
    `| floor − recorded z, median / 90th / 99th percentile | ${pct(tot.dzA, 0.5)} / ${pct(tot.dzA, 0.9)} / ${pct(tot.dzA, 0.99)} | ${pct(tot.dzB, 0.5)} / ${pct(tot.dzB, 0.9)} / ${pct(tot.dzB, 0.99)} |`,
    `| floor within 1 / 4 / 16 of the recorded z | ${within(tot.dzA, 1)} / ${within(tot.dzA, 4)} / ${within(tot.dzA, 16)} | ${within(tot.dzB, 1)} / ${within(tot.dzB, 4)} / ${within(tot.dzB, 16)} |`,
    '',
    `Where both fit: the two floors differ by median ${pct(tot.diff, 0.5)}, 90th percentile ${pct(tot.diff, 0.9)}, max ${pct(tot.diff, 1)} (${tot.diff.length} samples).`,
  ].join('\n');
}

function main(argv: readonly string[]): void {
  if (argv.includes('--compare')) {
    console.log(compareReport(loadRound(), { name: MIRAGE_2020.id, g: movementGeometry(MIRAGE_2020.id) }, { name: 'mirage-cs2', g: movementGeometry('mirage-cs2') }));
    return;
  }
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
