/**
 * A1: pack John's extracted CS2 sounds into the page's sound bank (docs/cs2-sounds.md, step 3).
 *
 *   npx tsx tools/pack-sounds.ts --list [--variants 2] > sound-paths.txt   (the files to extract, for VRF's -f)
 *   npx tsx tools/pack-sounds.ts <decompiled folder> [--out local/cs2-sound-bank.json] [--kbps 32]
 *                                [--budget-kb 900] [--variants 2] [--dry-run]
 *
 * Input: the folder ValveResourceFormat's CLI decompiled `sounds/**.vsnd_c` into (each file becomes `.wav` or
 * `.mp3` at the same path, e.g. `sounds/weapons/ak47/ak47_01.wav`). For every sound of the table
 * (src/app3d/audio/events.ts) and each CS2 event layered in it (data/audio/cs2-sound-events.json), it takes up to
 * `--variants` of the event's files (CS2 picks one at random per play; footsteps keep 4), trims each to the sound's
 * `keepSec`, and encodes it with ffmpeg to mono Opus (`--kbps`, default 32) in Ogg. First pass: one file per event;
 * second pass: more variants while the total stays under `--budget-kb` (default 900 KB of Opus ≈ 1.2 MB of base64
 * in the page ≈ 1.6 MB more once locked, since the lock base64s the page again: a locked page of ≈ 2.2 MB without
 * sounds stays under the 4 MB limit). Writes `local/cs2-sound-bank.json` (gitignored:
 * Valve's files never go into a commit or next to the page as plain files); the next build embeds it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import manifestJson from '../data/audio/cs2-sound-events.json';
import { SOUNDS, SOUND_IDS, type SoundDef } from '../src/app3d/audio/events';

interface Ev {
  readonly files: readonly string[];
  readonly children: readonly string[];
}
const EVENTS = (manifestJson as unknown as { events: Record<string, Ev> }).events;
const EXTS = ['.wav', '.mp3', '.ogg', '.flac'];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

/** The decompiled file for a CS2 `.vsnd` path, if VRF wrote it. */
export function findDecompiled(dir: string, vsnd: string): string | null {
  const base = join(dir, vsnd.replace(/\.vsnd$/, ''));
  for (const e of EXTS) if (existsSync(base + e)) return base + e;
  return null;
}

interface Want {
  readonly vsnd: string;
  readonly keepSec: number;
  /** 0 = the event's first file (first pass), 1.. = extra variants. */
  readonly rank: number;
}

/** Every file the table wants, in priority order (first pass = rank 0 of every event). */
export function wanted(variants: number): Want[] {
  const out: Want[] = [];
  const seen = new Set<string>();
  const add = (name: string, keepSec: number, footstep: boolean, depth: number): void => {
    const ev = EVENTS[name];
    if (ev === undefined || depth > 3) return;
    const n = footstep ? Math.max(variants, 4) : variants;
    ev.files.slice(0, n).forEach((vsnd, rank) => {
      if (!seen.has(vsnd)) {
        seen.add(vsnd);
        out.push({ vsnd, keepSec, rank });
      }
    });
    for (const c of ev.children) add(c, keepSec, footstep, depth + 1);
  };
  for (const id of SOUND_IDS) {
    const def = SOUNDS[id] as SoundDef;
    for (const name of def.cs2) add(name, def.keepSec ?? 2, def.bus === 'footsteps', 0);
  }
  return out.sort((a, b) => a.rank - b.rank);
}

function encode(input: string, keepSec: number, kbps: number, tmp: string): Buffer {
  const out = join(tmp, 'x.ogg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-t', String(keepSec), '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', `${kbps}k`, '-application', 'audio', '-f', 'ogg', out]);
  return readFileSync(out);
}

function main(): void {
  if (process.argv.includes('--list')) {
    // The .vsnd_c paths inside pak01_dir.vpk to decompile (docs/cs2-sounds.md step 2), one per line.
    const v = Math.max(1, Number(arg('--variants', '2')));
    for (const w of wanted(v)) console.log(`${w.vsnd}_c`);
    return;
  }
  const dir = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
  if (dir === undefined) {
    console.error('usage: tsx tools/pack-sounds.ts <decompiled folder> [--out local/cs2-sound-bank.json] [--kbps 32] [--budget-kb 900] [--variants 2] [--dry-run]');
    process.exit(2);
  }
  const root = resolve(dir);
  const out = resolve(arg('--out', 'local/cs2-sound-bank.json'));
  const kbps = Number(arg('--kbps', '32'));
  const budget = Number(arg('--budget-kb', '900')) * 1024;
  const variants = Math.max(1, Number(arg('--variants', '2')));
  const dry = process.argv.includes('--dry-run');
  const want = wanted(variants);
  const tmp = mkdtempSync(join(tmpdir(), 'pack-sounds-'));
  const files: Record<string, string> = {};
  const missing: string[] = [];
  let total = 0;
  let skipped = 0;
  try {
    for (const w of want) {
      const src = findDecompiled(root, w.vsnd);
      if (src === null) {
        if (w.rank === 0) missing.push(w.vsnd);
        continue;
      }
      if (dry) continue;
      const bytes = encode(src, w.keepSec, kbps, tmp);
      // First-pass files always go in (the page needs one per event); variants only within the budget.
      if (w.rank > 0 && total + bytes.length > budget) {
        skipped++;
        continue;
      }
      files[w.vsnd] = bytes.toString('base64');
      total += bytes.length;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const b64 = Object.values(files).reduce((a, s) => a + s.length, 0);
  console.log(`${Object.keys(files).length} of ${want.length} files packed: ${(total / 1024).toFixed(0)} KB Opus at ${kbps} kbps, ${(b64 / 1024).toFixed(0)} KB base64 in the page (≈ ${((b64 * 4) / 3 / 1024).toFixed(0)} KB more once locked; keep the locked page under 4 MB); ${skipped} variants left out for the budget`);
  if (missing.length > 0) console.log(`not in ${root} (these events keep their placeholder): ${missing.length}\n  ${missing.slice(0, 40).join('\n  ')}${missing.length > 40 ? '\n  …' : ''}`);
  if (total > budget) console.warn(`over the budget (${(budget / 1024).toFixed(0)} KB) with one file per event: lower --kbps or keepSec`);
  if (dry) return;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ version: 1, codec: `opus/ogg ${kbps}k mono`, files }));
  console.log(`→ ${out} (rebuild the page to embed it: npm run build:single:3d)`);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('pack-sounds.ts')) main();
