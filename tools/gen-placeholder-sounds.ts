/**
 * A1: render the procedurally generated placeholder sounds (src/app3d/audio/synth.ts) to WAV files.
 *
 *   npx tsx tools/gen-placeholder-sounds.ts [--out local/placeholder-sounds] [--as-cs2 local/fake-cs2-sounds]
 *
 * `--out`: one `<sound id>.wav` per sound of the table, to listen to them (the page renders the same samples itself
 * at audio start, so nothing is embedded). `--as-cs2 <dir>`: the same placeholders written at the CS2 paths the
 * manifest names (`<dir>/sounds/weapons/ak47/ak47_02.wav`, …), as if VRF had decompiled them: a stand-in for John's
 * folder that runs tools/pack-sounds.ts end to end (CI and the PR check use it; no Valve file involved).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import manifestJson from '../data/audio/cs2-sound-events.json';
import { SOUNDS, SOUND_IDS, type SoundDef } from '../src/app3d/audio/events';
import { renderSynth, wavBytes } from '../src/app3d/audio/synth';
import { AUDIO_TUNING } from '../src/app3d/audio/tuning';

const EVENTS = (manifestJson as unknown as { events: Record<string, { files: string[]; children: string[] }> }).events;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function main(): void {
  const out = resolve(arg('--out') ?? 'local/placeholder-sounds');
  const asCs2 = arg('--as-cs2');
  const rate = AUDIO_TUNING.placeholderRate;
  mkdirSync(out, { recursive: true });
  let n = 0;
  let bytes = 0;
  for (const id of SOUND_IDS) {
    const def = SOUNDS[id] as SoundDef;
    const wav = wavBytes(renderSynth(def.synth, id, rate), rate);
    writeFileSync(join(out, `${id}.wav`), wav);
    n++;
    bytes += wav.length;
    if (asCs2 !== null) {
      const names = [...def.cs2, ...def.cs2.flatMap((c) => EVENTS[c]?.children ?? [])];
      for (const name of names) {
        for (const f of EVENTS[name]?.files ?? []) {
          const p = join(resolve(asCs2), f.replace(/\.vsnd$/, '.wav'));
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, wav);
        }
      }
    }
  }
  console.log(`${n} placeholders (${(bytes / 1024).toFixed(0)} KB WAV at ${rate} Hz) → ${out}${asCs2 === null ? '' : `; also at the CS2 paths under ${resolve(asCs2)}`}`);
}

main();
