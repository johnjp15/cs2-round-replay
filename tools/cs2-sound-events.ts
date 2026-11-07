/**
 * A1: build the sound manifest `data/audio/cs2-sound-events.json` from CS2's decompiled sound events.
 *
 *   npx tsx tools/cs2-sound-events.ts <GameTracking-CS2 checkout> [--out data/audio/cs2-sound-events.json]
 *
 * Input: a checkout (sparse is enough) of the public SteamDatabase/GameTracking-CS2 repository with
 * `game/csgo/pak01_dir/soundevents/**.vsndevts` (CS2's sound events, decompiled by ValveResourceFormat) and
 * `game/csgo/pak01_dir.txt` (the file list of pak01_dir.vpk with sizes). For every CS2 event the table in
 * src/app3d/audio/events.ts names, plus the child events it starts (`soundevent_01`, e.g. `Weapon_AK47.Single` →
 * `Weapon_AK47.SingleDistant`), the manifest records, after resolving `base = "..."` inheritance:
 *
 *  - `files`: the `.vsnd` files (`vsnd_files_track_01` / `vsnd_files`; CS2 picks one at random per play);
 *  - `volume`, `pitch`, the random ranges, `delay`;
 *  - `curve`: `distance_volume_mapping_curve` (points `[distance, volume, slopeIn, slopeOut, modeIn, modeOut]`);
 *  - `occlusion`: `occlusion_intensity`; `offset`: `position_offset` (units above the entity origin);
 *  - `mixgroup`, `local` (`is_ui_sound` or `position_relative_to_player`).
 *
 * Valve's sound files are not touched: only event metadata (paths and numbers) from the public dump.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseKv3, type Kv3 } from './kv3';
import { cs2EventNames } from '../src/app3d/audio/events';

type Obj = { [key: string]: Kv3 };

export interface ManifestEvent {
  readonly files: readonly string[];
  readonly volume: number;
  readonly pitch: number;
  readonly pitchRandom: readonly [number, number];
  readonly volumeRandom: readonly [number, number];
  readonly delay: number;
  readonly curve: readonly (readonly number[])[];
  readonly occlusion: number;
  readonly offset: readonly [number, number, number];
  readonly mixgroup: string;
  readonly local: boolean;
  readonly children: readonly string[];
  /** The .vsndevts file it is defined in (relative to soundevents/). */
  readonly defined: string;
}

export interface Manifest {
  readonly source: { readonly repo: string; readonly commit: string; readonly date: string };
  readonly events: Readonly<Record<string, ManifestEvent>>;
  /** Every .vsnd_c file the events use, with its size in pak01 (bytes, compressed as Valve stores it). */
  readonly files: Readonly<Record<string, number>>;
  /** Event names the table asks for that CS2 doesn't have (should be empty). */
  readonly missing: readonly string[];
  /** Files events name that pak01 doesn't contain (dead references in CS2's data); dropped from the events. */
  readonly absent: readonly string[];
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(p));
    else if (d.name.endsWith('.vsndevts')) out.push(p);
  }
  return out.sort();
}

function num(v: Kv3 | undefined, d: number): number {
  return typeof v === 'number' ? v : d;
}

function strs(v: Kv3 | undefined): string[] {
  if (typeof v === 'string') return v === '' ? [] : [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x !== '');
}

export function loadEvents(soundevents: string): Map<string, { def: Obj; file: string }> {
  const all = new Map<string, { def: Obj; file: string }>();
  for (const f of walk(soundevents)) {
    const root = parseKv3(readFileSync(f, 'utf8'));
    if (root === null || typeof root !== 'object' || Array.isArray(root)) continue;
    for (const [name, def] of Object.entries(root)) {
      if (def !== null && typeof def === 'object' && !Array.isArray(def)) all.set(name, { def, file: relative(soundevents, f) });
    }
  }
  return all;
}

/** An event with its `base` chain merged in (the event's own keys win). */
export function resolved(all: Map<string, { def: Obj; file: string }>, name: string, depth = 0): Obj | null {
  const e = all.get(name);
  if (e === undefined || depth > 8) return null;
  const base = typeof e.def['base'] === 'string' ? resolved(all, e.def['base'], depth + 1) : null;
  return { ...(base ?? {}), ...e.def };
}

export function manifestEvent(def: Obj, file: string): ManifestEvent {
  const curve = Array.isArray(def['distance_volume_mapping_curve']) && def['use_distance_volume_mapping_curve'] !== false ? def['distance_volume_mapping_curve'] : [];
  const offset = Array.isArray(def['position_offset']) ? def['position_offset'] : [];
  return {
    files: [...strs(def['vsnd_files_track_01']), ...strs(def['vsnd_files'])],
    volume: num(def['volume'], 1),
    pitch: num(def['pitch'], 1),
    pitchRandom: [num(def['pitch_random_min'], 0), num(def['pitch_random_max'], 0)],
    volumeRandom: [num(def['volume_random_min'], 0), num(def['volume_random_max'], 0)],
    delay: num(def['delay'], 0),
    curve: (curve as Kv3[]).filter((p): p is number[] => Array.isArray(p) && p.every((x) => typeof x === 'number')),
    occlusion: num(def['occlusion_intensity'], 0),
    offset: [num(offset[0], 0), num(offset[1], 0), num(offset[2], 0)],
    mixgroup: typeof def['mixgroup'] === 'string' ? def['mixgroup'] : '',
    local: def['is_ui_sound'] === true || def['position_relative_to_player'] === true,
    children: def['enable_child_events'] === false ? [] : strs(def['soundevent_01']),
    defined: file,
  };
}

export function buildManifest(checkout: string, names: readonly string[]): Manifest {
  const soundevents = join(checkout, 'game/csgo/pak01_dir/soundevents');
  const all = loadEvents(soundevents);
  const sizes = new Map<string, number>();
  for (const line of readFileSync(join(checkout, 'game/csgo/pak01_dir.txt'), 'utf8').split('\n')) {
    const m = /^(sounds\/\S+\.vsnd_c) CRC:\S+ size:(\d+)/.exec(line);
    if (m !== null) sizes.set(m[1] as string, Number(m[2]));
  }
  const events: Record<string, ManifestEvent> = {};
  const missing: string[] = [];
  const absent = new Set<string>();
  const queue = [...names];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (events[name] !== undefined) continue;
    const def = resolved(all, name);
    if (def === null) {
      missing.push(name);
      continue;
    }
    const raw = manifestEvent(def, (all.get(name) as { file: string }).file);
    const ev = sizes.size === 0 ? raw : { ...raw, files: raw.files.filter((f) => sizes.has(`${f}_c`)) };
    for (const f of raw.files) if (sizes.size > 0 && !sizes.has(`${f}_c`)) absent.add(`${f}_c`);
    events[name] = ev;
    queue.push(...ev.children);
  }
  const files: Record<string, number> = {};
  for (const name of Object.keys(events).sort()) for (const f of (events[name] as ManifestEvent).files) files[`${f}_c`] = sizes.get(`${f}_c`) ?? -1;
  let commit = 'unknown';
  let date = 'unknown';
  try {
    commit = execFileSync('git', ['-C', checkout, 'log', '-1', '--format=%H'], { encoding: 'utf8' }).trim();
    date = execFileSync('git', ['-C', checkout, 'log', '-1', '--format=%cI'], { encoding: 'utf8' }).trim();
  } catch {
    // not a git checkout: leave unknown
  }
  const sorted = Object.fromEntries(Object.entries(events).sort(([a], [b]) => (a < b ? -1 : 1)));
  const sortedFiles = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { source: { repo: 'SteamDatabase/GameTracking-CS2', commit, date }, events: sorted, files: sortedFiles, missing: missing.sort(), absent: [...absent].sort() };
}

const sig = (x: number): number => Number(x.toPrecision(4));

/** The engine's subset of the manifest: per event files, volume, pitch, randoms, delay, curve, occlusion, z offset, children. */
export function runtimeManifest(m: Manifest): { events: Record<string, unknown> } {
  const events: Record<string, unknown> = {};
  for (const [name, e] of Object.entries(m.events)) {
    events[name] = {
      files: e.files,
      volume: sig(e.volume),
      pitch: sig(e.pitch),
      pitchRandom: e.pitchRandom.map(sig),
      volumeRandom: e.volumeRandom.map(sig),
      delay: sig(e.delay),
      curve: e.curve.map((p) => p.slice(0, 4).map(sig)),
      occlusion: sig(e.occlusion),
      offset: [0, 0, sig(e.offset[2])],
      children: e.children,
    };
  }
  return { events };
}

function main(): void {
  const args = process.argv.slice(2);
  const checkout = args.find((a) => !a.startsWith('--'));
  const oi = args.indexOf('--out');
  const out = resolve(oi >= 0 ? (args[oi + 1] as string) : 'data/audio/cs2-sound-events.json');
  if (checkout === undefined) {
    console.error('usage: tsx tools/cs2-sound-events.ts <GameTracking-CS2 checkout> [--out file]');
    process.exit(2);
  }
  const m = buildManifest(resolve(checkout), cs2EventNames());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(m, null, 1) + '\n');
  // The page embeds only what the engine plays with (src/app3d/audio/engine.ts), numbers to 4 significant digits.
  const runtime = join(dirname(out), 'cs2-sound-runtime.json');
  writeFileSync(runtime, JSON.stringify(runtimeManifest(m)) + '\n');
  const bytes = Object.values(m.files).reduce((a, b) => a + Math.max(0, b), 0);
  console.log(`${Object.keys(m.events).length} events, ${Object.keys(m.files).length} files (${(bytes / 1024).toFixed(0)} KB in pak01), missing: ${m.missing.join(', ') || 'none'}, absent files: ${m.absent.join(', ') || 'none'} → ${out}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
