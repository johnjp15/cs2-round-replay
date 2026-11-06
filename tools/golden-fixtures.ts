/**
 * Golden fixtures for the C# port (F3) and the TS gate: `npm run fixtures:update` (docs/golden.md).
 *
 *   npm run fixtures:update            # regenerate fixtures/golden/* and fixtures/scripts/cart-follows-recording.json
 *   npm run fixtures:update -- --check # change nothing; exit 1 if anything would change
 *
 * Each fixture is a harness run (tools/harness.ts) written as
 * - `<name>.jsonl.gz`: the SessionLog, every tick, full observe + act + controls (gzip, deterministic header);
 * - `<name>.walk.jsonl.gz`: the walk oracle, every `WalkQuery.isWalkableLine` call the Core made, per tick, in call
 *   order, with the answer, so a Core port can be tested without porting the 2D nav mesh;
 * - an entry in `manifest.json`: digest, tick count, seed, the hashes of the inputs and the commit.
 *
 * Re-running is idempotent: a fixture whose content is unchanged keeps its bytes and its manifest entry (commit
 * included), so a diff under fixtures/ always means the behaviour changed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fnv1a32Hex, stableStringify, type PlayerId } from '../src/contracts/index';
import { tickOf } from '../src/core/index';
import { updateFollowScript, FOLLOW_SCRIPT } from './follow-script';
import {
  DEFAULT_SEED,
  ROOT,
  ScriptDriver,
  canonicalHash,
  loadHarnessData,
  logDigest,
  parseHumanScript,
  prettyStable,
  runHarness,
  type HarnessData,
  type HarnessRun,
  type WalkCall,
} from './harness';

export const GOLDEN_DIR = 'fixtures/golden';
export const MANIFEST = `${GOLDEN_DIR}/manifest.json`;
export const MANIFEST_VERSION = 1;
/** gzip header OS byte: 255 = unknown, so the header doesn't depend on the platform that wrote it. */
const GZIP_OS_UNKNOWN = 0xff;

export interface FixtureSpec {
  readonly name: string;
  readonly description: string;
  readonly human: PlayerId | null;
  /** Input script (path from the repo root), or null. */
  readonly script: string | null;
  /** Seconds, or 'end' (the golden length). */
  readonly until: number | 'end';
  readonly seed: number;
}

export const FIXTURE_SPECS: readonly FixtureSpec[] = [
  {
    name: 'round-nohuman',
    description: 'The golden master: no human, the Core drives all ten pawns for the whole round (npm run harness -- --human none --until end).',
    human: null,
    script: null,
    until: 'end',
    seed: DEFAULT_SEED,
  },
  {
    name: 'round-cart-idle',
    description: 'Human cart stands still in Back Alley (fixtures/scripts/cart-idle.json) for 20 s: the Core skips him and his scripted damage.',
    human: 'cart',
    script: 'fixtures/scripts/cart-idle.json',
    until: 20,
    seed: DEFAULT_SEED,
  },
];

export interface FixtureEntry {
  readonly name: string;
  readonly description: string;
  /** The SessionLog, gzipped (`<name>.jsonl.gz`). */
  readonly file: string;
  /** The walk oracle, gzipped (`<name>.walk.jsonl.gz`). */
  readonly walkFile: string;
  readonly human: PlayerId | null;
  readonly script: string | null;
  /** canonicalHash of the script file, or null. */
  readonly scriptHash: string | null;
  readonly seed: number;
  readonly until: number | 'end';
  /** Lines (one per tick; no repeated ticks). */
  readonly ticks: number;
  readonly firstTick: number;
  readonly lastTick: number;
  /** SessionLog.digest(): FNV-1a 32-bit of the uncompressed JSONL. */
  readonly digest: string;
  readonly rawBytes: number;
  readonly bytes: number;
  readonly walkCalls: number;
  /** FNV-1a 32-bit of the uncompressed walk oracle. */
  readonly walkDigest: string;
  readonly walkBytes: number;
  /** canonicalHash (FNV-1a of the canonical JSON) of data/tuning.json, data/round.json and data/mirage-nav.json. */
  readonly tuningHash: string;
  readonly roundHash: string;
  readonly navHash: string;
  /** `git rev-parse HEAD` when generated, and whether src/, data/ or tools/ had uncommitted changes then. */
  readonly commit: string;
  readonly sourceDirty: boolean;
}

export interface Manifest {
  readonly about: string;
  readonly version: number;
  readonly fixtures: readonly FixtureEntry[];
}

/** gzip with fixed settings and a platform-independent header (mtime 0, no file name, OS unknown). */
export function gzipDeterministic(text: string): Buffer {
  const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  // RFC 1952 header: ID1 ID2 CM FLG MTIME(4) XFL OS. Node writes FLG 0 and MTIME 0; pin OS.
  if (gz[0] !== 0x1f || gz[1] !== 0x8b || gz[3] !== 0 || gz.readUInt32LE(4) !== 0) throw new Error('gzipDeterministic: unexpected gzip header');
  gz[9] = GZIP_OS_UNKNOWN;
  return gz;
}

export function gunzipText(buf: Buffer): string {
  return gunzipSync(buf).toString('utf8');
}

/** The walk oracle: one line per tick that made calls, `{"calls":[{"a":Vec3,"b":Vec3,"walkable":bool},…],"tick":k}`. */
export function walkOracleText(calls: readonly WalkCall[]): string {
  const lines: string[] = [];
  let i = 0;
  while (i < calls.length) {
    const tick = (calls[i] as WalkCall).tick;
    const row: { a: WalkCall['a']; b: WalkCall['b']; walkable: boolean }[] = [];
    for (; i < calls.length && (calls[i] as WalkCall).tick === tick; i++) {
      const c = calls[i] as WalkCall;
      row.push({ a: c.a, b: c.b, walkable: c.walkable });
    }
    lines.push(stableStringify({ calls: row, tick }));
  }
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

export interface OracleTick {
  readonly tick: number;
  readonly calls: readonly { readonly a: WalkCall['a']; readonly b: WalkCall['b']; readonly walkable: boolean }[];
}

export function parseWalkOracle(text: string): OracleTick[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as OracleTick);
}

/** Run one fixture spec through the harness, recording the walk calls. */
export function runFixture(data: HarnessData, spec: FixtureSpec, root = ROOT): HarnessRun {
  const driver = spec.script === null || spec.human === null ? null : new ScriptDriver(parseHumanScript(readFileSync(resolve(root, spec.script), 'utf8')), spec.human);
  return runHarness(data, { human: spec.human, driver, lastTick: spec.until === 'end' ? 'end' : tickOf(spec.until), seed: spec.seed, recordWalk: true });
}

function git(args: readonly string[], root: string): string {
  try {
    return execFileSync('git', [...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export function readManifest(root = ROOT): Manifest | null {
  const path = resolve(root, MANIFEST);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Manifest) : null;
}

export interface UpdateResult {
  readonly manifest: Manifest;
  /** Files whose content changed (or would change with --check). */
  readonly changed: readonly string[];
}

/**
 * Regenerate every fixture. Unchanged content keeps its bytes and manifest entry (unless that entry was made from a
 * dirty tree and this one is clean, which only refreshes the provenance). With `write` false nothing is written.
 */
export function updateFixtures(data: HarnessData, write: boolean, root = ROOT): UpdateResult {
  const old = readManifest(root);
  const commit = git(['rev-parse', 'HEAD'], root) || 'unknown';
  const dirty = git(['status', '--porcelain', '--', 'src', 'data', 'tools'], root) !== '';
  const hashes = { tuningHash: canonicalHash(data.sources.tuning), roundHash: canonicalHash(data.sources.round), navHash: canonicalHash(data.sources.nav) };
  const changed: string[] = [];
  const entries: FixtureEntry[] = [];
  if (write) mkdirSync(resolve(root, GOLDEN_DIR), { recursive: true });
  for (const spec of FIXTURE_SPECS) {
    const run = runFixture(data, spec, root);
    const text = run.log.toText();
    const walkText = walkOracleText(run.walk ?? []);
    const file = `${spec.name}.jsonl.gz`;
    const walkFile = `${spec.name}.walk.jsonl.gz`;
    const logPath = resolve(root, GOLDEN_DIR, file);
    const walkPath = resolve(root, GOLDEN_DIR, walkFile);
    const same = (path: string, want: string): boolean => existsSync(path) && gunzipText(readFileSync(path)) === want;
    const logSame = same(logPath, text);
    const walkSame = same(walkPath, walkText);
    if (!logSame) changed.push(`${GOLDEN_DIR}/${file}`);
    if (!walkSame) changed.push(`${GOLDEN_DIR}/${walkFile}`);
    const gz = logSame ? readFileSync(logPath) : gzipDeterministic(text);
    const walkGz = walkSame ? readFileSync(walkPath) : gzipDeterministic(walkText);
    if (write && !logSame) writeFileSync(logPath, gz);
    if (write && !walkSame) writeFileSync(walkPath, walkGz);
    const first = run.entries[0]?.observe.tick ?? 0;
    const last = run.entries[run.entries.length - 1]?.observe.tick ?? -1;
    const fresh: FixtureEntry = {
      name: spec.name,
      description: spec.description,
      file,
      walkFile,
      human: spec.human,
      script: spec.script,
      scriptHash: spec.script === null ? null : canonicalHash(readFileSync(resolve(root, spec.script), 'utf8')),
      seed: spec.seed,
      until: spec.until,
      ticks: run.ticks,
      firstTick: first,
      lastTick: last,
      digest: logDigest(run.log),
      rawBytes: Buffer.byteLength(text, 'utf8'),
      bytes: gz.length,
      walkCalls: run.walk?.length ?? 0,
      walkDigest: fnv1a32Hex(walkText),
      walkBytes: walkGz.length,
      ...hashes,
      commit,
      sourceDirty: dirty,
    };
    const prev = old?.fixtures.find((f) => f.name === spec.name) ?? null;
    const keep = prev !== null && logSame && walkSame && !(prev.sourceDirty && !dirty) && stableStringify({ ...prev, commit: '', sourceDirty: false }) === stableStringify({ ...fresh, commit: '', sourceDirty: false });
    entries.push(keep ? prev : fresh);
  }
  const manifest: Manifest = {
    about: 'Golden fixtures (docs/golden.md): a C# Core must reproduce every act of every line, feeding every line in order. Regenerate with npm run fixtures:update.',
    version: MANIFEST_VERSION,
    fixtures: entries,
  };
  const manifestText = prettyStable(manifest);
  const manifestPath = resolve(root, MANIFEST);
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== manifestText) {
    changed.push(MANIFEST);
    if (write) writeFileSync(manifestPath, manifestText, 'utf8');
  }
  return { manifest, changed };
}

function main(): void {
  const check = process.argv.includes('--check');
  const data = loadHarnessData();
  const changed: string[] = [];
  const f = updateFollowScript(data, !check);
  if (f.changed) changed.push(FOLLOW_SCRIPT);
  console.log(`${FOLLOW_SCRIPT}: ${f.changed ? (check ? 'would change' : 'written') : 'unchanged'} (${f.entries} entries, replays byte for byte, run digest ${f.digest})`);
  const r = updateFixtures(data, !check);
  changed.push(...r.changed);
  let total = 0;
  console.log('| fixture | ticks | digest | log.gz | walk calls | walk.gz | commit |');
  console.log('| --- | ---: | --- | ---: | ---: | ---: | --- |');
  for (const f of r.manifest.fixtures) {
    total += f.bytes + f.walkBytes;
    console.log(`| ${f.name} | ${f.ticks} (${f.firstTick}–${f.lastTick}) | ${f.digest} | ${f.bytes} | ${f.walkCalls} | ${f.walkBytes} | ${f.commit.slice(0, 7)}${f.sourceDirty ? ' (dirty)' : ''} |`);
  }
  console.log(`golden fixtures: ${total} bytes gzipped`);
  console.log(changed.length === 0 ? 'nothing changed' : `${check ? 'would change' : 'changed'}: ${changed.join(', ')}`);
  if (check && changed.length > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
