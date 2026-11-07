/**
 * X1: fetch and extract the March 2020 CS:GO Mirage files (docs/csgo-2020-files.md). John runs this on his Mac; the
 * cloud sessions can't log in to Steam.
 *
 *   npx tsx tools/csgo2020-files.ts fetch --username <steam user> [--raw ~/csgo-2020-raw] [--out ~/mirage-2020]
 *       [--depotdownloader <path>] [--loginid <n>]
 *       Runs DepotDownloader (SteamRE) for CS:GO depot 731 at manifest 7867263815789485437 (build 4743948, the
 *       5 March 2020 update, live until 22 March 2020) in rounds: first the manifest listing, the BSP, the nav and
 *       pak01_dir.vpk; then only the pak01_NNN.vpk chunks that hold files Mirage references, until nothing new is
 *       needed. Then runs `extract`.
 *   npx tsx tools/csgo2020-files.ts plan <raw dir>            what is referenced, which chunks hold it, sizes
 *   npx tsx tools/csgo2020-files.ts extract <raw dir> <out>   copy the referenced files into <out> (mirage-2020/)
 *
 * `<raw dir>` is a DepotDownloader `-dir` (or an old CS:GO install folder, the one that contains `csgo/`). The out
 * folder gets `maps/de_mirage.bsp`, `maps/de_mirage.nav`, the materials (VMT + VTF) and models (MDL, VVD, PHY,
 * DX90 VTX) the map uses, under their game paths, and `MANIFEST.json` (every file's SHA-256, where it came from, what
 * was referenced but not found).
 *
 * References: the BSP's texdata names (world faces, overlays, displacements), its pak file (cubemap patch materials
 * and their `include`s), the sky (`skyname`), static props (`sprp`), entity models (`model` keys under `models/`),
 * and transitively each material's textures and each model's materials.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BspFile } from './bsp/bsp';
import { AssetError, VpkDir, VPK_DIR_ARCHIVE, mdlMaterialPaths, normalizePath, readMdl, readVmt, zipEntries, zipRead, type ZipEntry } from './bsp/assets';

/** CS:GO (app 730) common content depot and the manifest live on 12 March 2020 (docs/csgo-2020-files.md "Evidence"). */
export const CSGO_2020 = {
  app: 730,
  depot: 731,
  manifest: '7867263815789485437',
  build: 4743948,
  patch: '1.37.4.4',
  liveFrom: '2020-03-05',
  liveUntil: '2020-03-22',
  map: 'de_mirage',
} as const;

/** Texture parameters of a VMT whose VTFs are worth copying (colour, blends, detail). */
const TEXTURE_PARAMS = ['$basetexture', '$basetexture2', '$basetexture3', '$basetexture4', '$blendmodulatetexture', '$detail', '$bumpmap', '$bumpmap2', '$normalmap'] as const;
/** Model files kept per model. */
const MODEL_EXTS = ['.mdl', '.vvd', '.phy', '.dx90.vtx'] as const;

/** Where a referenced file lives. */
export type Source = { readonly kind: 'pakfile'; readonly entry: ZipEntry } | { readonly kind: 'vpk'; readonly archive: number; readonly offset: number; readonly length: number; readonly preload: number } | { readonly kind: 'loose'; readonly path: string };

/** A game-file reader over the BSP's pak file, pak01 and loose files (in that order, as the engine mounts them). */
export class GameFiles {
  private readonly pak: Map<string, ZipEntry>;
  private readonly pakBytes: Uint8Array;
  constructor(
    readonly raw: string,
    bsp: BspFile,
    readonly vpk: VpkDir | null,
  ) {
    this.pakBytes = bsp.pakfile();
    this.pak = new Map(zipEntries(this.pakBytes).map((e) => [e.name, e]));
  }

  where(path: string): Source | null {
    const p = normalizePath(path);
    const z = this.pak.get(p);
    if (z !== undefined) return { kind: 'pakfile', entry: z };
    const v = this.vpk?.get(p);
    if (v !== undefined) return { kind: 'vpk', archive: v.archive, offset: v.offset, length: v.length, preload: v.preload.length };
    const loose = join(this.raw, 'csgo', p);
    if (existsSync(loose)) return { kind: 'loose', path: loose };
    return null;
  }

  /** The file's bytes, or null if its VPK chunk isn't on disk yet (or it doesn't exist). */
  read(path: string): Uint8Array | null {
    const s = this.where(path);
    if (s === null) return null;
    if (s.kind === 'pakfile') return zipRead(this.pakBytes, s.entry);
    if (s.kind === 'loose') return new Uint8Array(readFileSync(s.path));
    const vpk = this.vpk as VpkDir;
    const e = vpk.get(path);
    if (e === undefined) return null;
    if (e.archive !== VPK_DIR_ARCHIVE && e.length > 0 && !existsSync(chunkPath(this.raw, e.archive))) return null;
    return vpk.read(e, (archive, offset, length) => readSlice(chunkPath(this.raw, archive), offset, length));
  }
}

export function chunkPath(raw: string, archive: number): string {
  return join(raw, 'csgo', VpkDir.archiveName('pak01', archive));
}

function readSlice(file: string, offset: number, length: number): Uint8Array {
  const fd = openSync(file, 'r');
  try {
    const out = new Uint8Array(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, out, got, length - got, offset + got);
      if (n === 0) break;
      got += n;
    }
    return out.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

export interface Collected {
  /** Every referenced path that exists (normalised game paths, sorted). */
  readonly files: readonly string[];
  /** Referenced paths not found anywhere (some are expected: e.g. models without a .phy). */
  readonly missing: readonly string[];
  /** Files whose content couldn't be read yet (their chunk isn't downloaded), so their own references are unknown. */
  readonly unread: readonly string[];
  /** The pak01 chunks that hold the files. */
  readonly chunks: readonly number[];
}

/** Optional files: a model may have no .phy (not solid) and many have no VTX for dx90; textures may be absent. */
function optional(path: string): boolean {
  return path.endsWith('.phy') || path.endsWith('.vtx') || path.endsWith('.vvd');
}

/** Follow every reference from the BSP through materials and models. */
export function collect(bsp: BspFile, files: GameFiles, mapName: string = CSGO_2020.map): Collected {
  const found = new Set<string>();
  const missing = new Set<string>();
  const unread = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [];
  const want = (p: string): void => {
    const n = normalizePath(p);
    if (seen.has(n)) return;
    seen.add(n);
    queue.push(n);
  };
  const material = (name: string): void => {
    const n = normalizePath(name).replace(/\.vmt$/, '');
    want(`materials/${n}.vmt`);
  };
  for (const name of bsp.texDataStrings()) material(name);
  for (const e of zipEntries(bsp.pakfile())) if (e.name.endsWith('.vmt')) want(e.name);
  const entities = bsp.entities();
  const sky = entities.find((e) => e.get('classname') === 'worldspawn')?.get('skyname');
  if (sky !== undefined && sky !== '') for (const side of ['bk', 'dn', 'ft', 'lf', 'rt', 'up']) material(`skybox/${sky}${side}`);
  const model = (m: string): void => {
    const base = normalizePath(m).replace(/\.mdl$/, '');
    for (const ext of MODEL_EXTS) want(`${base}${ext}`);
  };
  for (const m of bsp.staticProps()?.models ?? []) model(m);
  for (const e of entities) {
    const m = e.get('model');
    if (m !== undefined && m.toLowerCase().startsWith('models/') && m.toLowerCase().endsWith('.mdl')) model(m);
  }
  want(`maps/${mapName}.nav`);
  while (queue.length > 0) {
    const p = queue.shift() as string;
    if (files.where(p) === null) {
      if (!optional(p) && !p.startsWith(`maps/${mapName}.`)) missing.add(p);
      continue;
    }
    found.add(p);
    if (!p.endsWith('.vmt') && !p.endsWith('.mdl')) continue;
    const bytes = files.read(p);
    if (bytes === null) {
      unread.add(p);
      continue;
    }
    try {
      if (p.endsWith('.vmt')) {
        const vmt = readVmt(new TextDecoder('latin1').decode(bytes));
        if (vmt.include !== null) want(vmt.include.endsWith('.vmt') ? vmt.include : `${vmt.include}.vmt`);
        for (const k of TEXTURE_PARAMS) {
          const t = vmt.params.get(k);
          if (t !== undefined && t !== '' && !t.startsWith('_rt_')) want(`materials/${normalizePath(t).replace(/\.vtf$/, '')}.vtf`);
        }
        for (const k of ['$bottommaterial', '$fallbackmaterial'] as const) {
          const t = vmt.params.get(k);
          if (t !== undefined && t !== '') material(t);
        }
      } else {
        const mdl = readMdl(bytes);
        for (let i = 0; i < mdl.textures.length; i++) {
          // The first search path that has the material is the one the engine uses; ask for all, keep what exists.
          for (const c of mdlMaterialPaths(mdl, i)) {
            if (files.where(c) !== null) {
              want(c);
              break;
            }
          }
        }
      }
    } catch (e) {
      if (!(e instanceof AssetError)) throw e;
      missing.add(`${p} (unreadable: ${e.message})`);
    }
  }
  const chunks = new Set<number>();
  for (const p of found) {
    const s = files.where(p);
    if (s?.kind === 'vpk' && s.archive !== VPK_DIR_ARCHIVE && s.length > 0) chunks.add(s.archive);
  }
  const sorted = (s: Set<string>): string[] => [...s].sort();
  return { files: sorted(found), missing: sorted(missing), unread: sorted(unread), chunks: [...chunks].sort((a, b) => a - b) };
}

/** A DepotDownloader `-manifest-only` listing: path (normalised, with `csgo/`) → size and SHA-1. */
export function readManifestListing(text: string): Map<string, { size: number; sha1: string }> {
  const out = new Map<string, { size: number; sha1: string }>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+([0-9a-f]{40})\s+[0-9a-f]+\s+(.+?)\s*$/.exec(line);
    if (m !== null) out.set(normalizePath(m[4] as string), { size: Number(m[1]), sha1: m[3] as string });
  }
  return out;
}

function findListing(raw: string): Map<string, { size: number; sha1: string }> | null {
  const dirs = [raw, join(raw, '.DepotDownloader')];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (/^manifest_731_\d+\.txt$/.test(f)) return readManifestListing(readFileSync(join(d, f), 'utf8'));
  }
  return null;
}

function mib(n: number): string {
  return `${(n / 1048576).toFixed(1)} MiB`;
}

interface Opened {
  readonly bsp: BspFile;
  readonly files: GameFiles;
  readonly bspBytes: Uint8Array;
}

function open(raw: string): Opened {
  const bspPath = join(raw, 'csgo', 'maps', `${CSGO_2020.map}.bsp`);
  if (!existsSync(bspPath)) throw new Error(`${bspPath}: not found (run fetch, or point at a folder that contains csgo/maps/)`);
  const bspBytes = new Uint8Array(readFileSync(bspPath));
  const bsp = new BspFile(bspBytes);
  const dirPath = join(raw, 'csgo', 'pak01_dir.vpk');
  const vpk = existsSync(dirPath) ? new VpkDir(new Uint8Array(readFileSync(dirPath))) : null;
  return { bsp, files: new GameFiles(raw, bsp, vpk), bspBytes };
}

/** Print what's referenced, which chunks are needed and which of them are missing; returns the missing chunks. */
export function plan(raw: string, log: (s: string) => void = console.log): { missingChunks: number[]; collected: Collected } {
  const { bsp, files } = open(raw);
  const c = collect(bsp, files);
  const listing = findListing(raw);
  const missingChunks = c.chunks.filter((a) => !existsSync(chunkPath(raw, a)));
  log(`de_mirage.bsp: version ${bsp.version}, map revision ${bsp.mapRevision}`);
  log(`referenced files found: ${c.files.length} (not found: ${c.missing.length}; not readable yet: ${c.unread.length})`);
  let total = 0;
  for (const a of c.chunks) {
    const name = `csgo/${VpkDir.archiveName('pak01', a)}`;
    const size = listing?.get(name)?.size;
    if (size !== undefined) total += size;
    log(`  ${name}${size === undefined ? '' : `  ${mib(size)}`}${missingChunks.includes(a) ? '  (to download)' : ''}`);
  }
  if (listing !== null) log(`chunks needed: ${c.chunks.length}, ${mib(total)} in all`);
  return { missingChunks, collected: c };
}

/** Copy every referenced file (and the BSP) into `out`, with MANIFEST.json. */
export function extract(raw: string, out: string, log: (s: string) => void = console.log): void {
  const { bsp, files, bspBytes } = open(raw);
  const c = collect(bsp, files);
  if (c.unread.length > 0) throw new Error(`${c.unread.length} referenced files are in chunks that aren't downloaded (first: ${c.unread[0] as string}); run plan/fetch first`);
  const listing = findListing(raw);
  const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
  const sha1 = (b: Uint8Array): string => createHash('sha1').update(b).digest('hex');
  const write = (rel: string, b: Uint8Array): void => {
    const dst = join(out, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, b);
  };
  const entries: { path: string; bytes: number; sha256: string; from: string }[] = [];
  write(`maps/${CSGO_2020.map}.bsp`, bspBytes);
  const bspSha1 = sha1(bspBytes);
  const expected = listing?.get(`csgo/maps/${CSGO_2020.map}.bsp`);
  if (expected !== undefined && expected.sha1 !== bspSha1) throw new Error(`de_mirage.bsp: SHA-1 ${bspSha1} differs from the depot manifest's ${expected.sha1}`);
  entries.push({ path: `maps/${CSGO_2020.map}.bsp`, bytes: bspBytes.length, sha256: sha256(bspBytes), from: 'depot' });
  let bytes = bspBytes.length;
  for (const p of c.files) {
    const b = files.read(p);
    const s = files.where(p);
    if (b === null || s === null) throw new Error(`${p}: unreadable`);
    write(p, b);
    bytes += b.length;
    entries.push({ path: p, bytes: b.length, sha256: sha256(b), from: s.kind === 'vpk' ? (s.archive === VPK_DIR_ARCHIVE ? 'pak01_dir.vpk' : VpkDir.archiveName('pak01', s.archive)) : s.kind });
  }
  const manifest = {
    format: 'cs2-round-replay/csgo-2020-files@1',
    source: { ...CSGO_2020, bspSha1, bspDepotSha1: expected?.sha1 ?? null, listing: listing !== null },
    counts: { files: entries.length, bytes, missing: c.missing.length },
    files: entries,
    missing: c.missing,
  };
  writeFileSync(join(out, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  log(`wrote ${entries.length} files (${mib(bytes)}) to ${out}; ${c.missing.length} referenced files not found (MANIFEST.json "missing")`);
}

function depotDownloader(exe: string, args: readonly string[]): void {
  const r = spawnSync(exe, args, { stdio: 'inherit' });
  if (r.error !== undefined) throw new Error(`${exe}: ${r.error.message} (install it: brew tap steamre/tools && brew install depotdownloader)`);
  if (r.status !== 0) throw new Error(`${exe} exited with ${String(r.status)}`);
}

function fetch(raw: string, username: string | null, exe: string, out: string, loginId: string | null): void {
  mkdirSync(raw, { recursive: true });
  const base = ['-app', String(CSGO_2020.app), '-depot', String(CSGO_2020.depot), '-manifest', CSGO_2020.manifest, '-dir', raw, ...(username === null ? [] : ['-username', username, '-remember-password']), ...(loginId === null ? [] : ['-loginid', loginId])];
  const list = join(raw, 'filelist.txt');
  if (findListing(raw) === null) depotDownloader(exe, [...base, '-manifest-only']);
  writeFileSync(list, [`csgo/maps/${CSGO_2020.map}.bsp`, `csgo/maps/${CSGO_2020.map}.nav`, 'csgo/pak01_dir.vpk', ''].join('\n'));
  depotDownloader(exe, [...base, '-filelist', list]);
  for (let round = 1; round <= 8; round++) {
    const { missingChunks, collected } = plan(raw);
    if (missingChunks.length === 0 && collected.unread.length === 0) break;
    console.log(`round ${round}: downloading ${missingChunks.length} chunk(s)`);
    writeFileSync(list, `${missingChunks.map((a) => `csgo/${VpkDir.archiveName('pak01', a)}`).join('\n')}\n`);
    depotDownloader(exe, [...base, '-filelist', list]);
  }
  extract(raw, out);
}

function main(argv: readonly string[]): void {
  const [cmd, ...rest] = argv;
  const flag = (name: string): string | null => {
    const i = rest.indexOf(name);
    return i >= 0 ? (rest[i + 1] ?? null) : null;
  };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && (rest[i - 1] as string).startsWith('--')));
  if (cmd === 'plan' && positional[0] !== undefined) plan(resolve(positional[0]));
  else if (cmd === 'extract' && positional[0] !== undefined && positional[1] !== undefined) extract(resolve(positional[0]), resolve(positional[1]));
  else if (cmd === 'fetch') {
    const raw = resolve(flag('--raw') ?? join(homedir(), 'csgo-2020-raw'));
    fetch(raw, flag('--username'), flag('--depotdownloader') ?? 'DepotDownloader', resolve(flag('--out') ?? join(homedir(), 'mirage-2020')), flag('--loginid'));
  } else {
    console.error('usage: csgo2020-files.ts fetch --username <steam user> [--raw dir] [--out dir] | plan <raw> | extract <raw> <out>');
    process.exitCode = 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}

