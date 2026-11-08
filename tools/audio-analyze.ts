/**
 * A2: render every placeholder sound (src/app3d/audio/synth.ts, exactly the samples the page plays) and measure it
 * (tools/audio-metrics.ts). Writes `logs/audio/<tag>/<id>.wav`, `logs/audio/<tag>/metrics.json` (gitignored) and
 * prints a table with the problems found:
 *
 *   npx tsx tools/audio-analyze.ts [--tag after] [--rate 48000] [--no-wav] [--compare logs/audio/before/metrics.json]
 *
 * Problems: clipping (> 0 dBFS), DC offset, a click (no envelope at the start or the end), a silent sound, a
 * duration outside the range expected for its kind (`EXPECT`), two different CS2 events with the same sound
 * (fingerprint similarity ≥ 0.995), and a loop whose ends don't meet.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SOUNDS, SOUND_IDS, type SoundDef } from '../src/app3d/audio/events';
import { renderSynth, wavBytes } from '../src/app3d/audio/synth';
import { measure, similarity, type PcmMetrics } from './audio-metrics';

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

/** Expected duration ranges (seconds) by sound id prefix; see docs/audio.md "What a CS2 sound is like". */
export const EXPECT: readonly (readonly [RegExp, number, number])[] = [
  [/^fire\.(ak47|m4a4|deagle|glock|p2000)$/, 0.15, 0.9],
  [/^fire\.(awp|ssg08)$/, 0.4, 1.6],
  [/^fire\.(m4a1s|usps)$/, 0.1, 0.5],
  [/^step\./, 0.06, 0.16],
  [/^land\./, 0.08, 0.3],
  [/^c4\.beep$/, 0.06, 0.2],
  [/^reload\.|^cycle\.|^draw\.|^dry\.|^zoom\.|^pin\./, 0.03, 0.5],
  [/^bounce\./, 0.03, 0.25],
  [/^pop\.|^c4\.explode$/, 0.4, 4],
];

export interface Row {
  readonly id: string;
  readonly kind: string;
  readonly m: Omit<PcmMetrics, 'fingerprint'>;
  readonly problems: string[];
}

export function analyze(rate: number): { rows: Row[]; prints: Map<string, Float32Array>; pcm: Map<string, Float32Array> } {
  const rows: Row[] = [];
  const prints = new Map<string, Float32Array>();
  const pcm = new Map<string, Float32Array>();
  for (const id of SOUND_IDS) {
    const def = SOUNDS[id] as SoundDef;
    const x = renderSynth(def.synth, id, rate);
    pcm.set(id, x);
    const { fingerprint, ...m } = measure(x, rate);
    prints.set(id, fingerprint);
    const problems: string[] = [];
    if (m.peakDb > 0) problems.push(`clips (${m.peakDb.toFixed(1)} dBFS)`);
    if (m.clipped > 0) problems.push(`${m.clipped} samples > 1`);
    if (Math.abs(m.dc) > 0.005) problems.push(`DC ${m.dc.toFixed(3)}`);
    if (m.peakDb < -60) problems.push('silent');
    if (def.loop !== true) {
      if (m.startAbs > 0.02) problems.push(`click at start (${m.startAbs.toFixed(2)})`);
      if (m.endAbs > 0.01) problems.push(`click at end (${m.endAbs.toFixed(2)})`);
    } else {
      const jump = Math.abs((x[0] as number) - (x[x.length - 1] as number));
      if (jump > 0.05) problems.push(`loop seam jump ${jump.toFixed(2)}`);
    }
    for (const [re, lo, hi] of EXPECT) {
      if (!re.test(id)) continue;
      if (m.durSec < lo || m.durSec > hi) problems.push(`duration ${(m.durSec * 1000).toFixed(0)} ms (expected ${lo * 1000}–${hi * 1000})`);
      break;
    }
    rows.push({ id, kind: def.synth.kind, m, problems });
  }
  // Same sound for different CS2 events.
  for (let i = 0; i < SOUND_IDS.length; i++) {
    for (let j = i + 1; j < SOUND_IDS.length; j++) {
      const a = SOUND_IDS[i] as string;
      const b = SOUND_IDS[j] as string;
      const ea = (SOUNDS[a] as SoundDef).cs2.join('+');
      const eb = (SOUNDS[b] as SoundDef).cs2.join('+');
      if (ea === eb) continue;
      const s = similarity(prints.get(a) as Float32Array, prints.get(b) as Float32Array);
      if (s >= 0.995) {
        (rows[i] as Row).problems.push(`same as ${b} (${s.toFixed(3)})`);
        (rows[j] as Row).problems.push(`same as ${a} (${s.toFixed(3)})`);
      }
    }
  }
  return { rows, prints, pcm };
}

function main(): void {
  const tag = arg('--tag', 'current') as string;
  const rate = Number(arg('--rate', '48000'));
  const dir = resolve('logs/audio', tag);
  mkdirSync(dir, { recursive: true });
  const { rows, pcm } = analyze(rate);
  if (!process.argv.includes('--no-wav')) for (const [id, x] of pcm) writeFileSync(join(dir, `${id}.wav`), wavBytes(x, rate));
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify({ rate, rows }, null, 1));
  const f = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '-inf');
  console.log('| id | kind | dur ms | peak dBFS | RMS dBFS | 50 ms max dBFS | attack ms | centroid Hz | 60–120 Hz % | > 4 kHz % | problems |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const r of rows) {
    const m = r.m;
    console.log(`| ${r.id} | ${r.kind} | ${f(m.durSec * 1000, 0)} | ${f(m.peakDb)} | ${f(m.rmsDb)} | ${f(m.shortDb)} | ${f(m.attackMs)} | ${f(m.centroidHz, 0)} | ${f(m.bands[1] * 100)} | ${f(m.bands[4] * 100)} | ${r.problems.join('; ')} |`);
  }
  const bad = rows.filter((r) => r.problems.length > 0);
  const count = (re: RegExp): number => rows.filter((r) => r.problems.some((p) => re.test(p))).length;
  console.log(`\n${rows.length} sounds at ${rate} Hz → ${dir}; ${bad.length} with problems: clicks ${count(/click/)}, same-as ${count(/same as/)}, duration ${count(/duration/)}, clipping ${count(/clips|> 1/)}, DC ${count(/DC/)}, silent ${count(/silent/)}`);
  const cmp = arg('--compare');
  if (cmp !== null) {
    const old = JSON.parse(readFileSync(cmp, 'utf8')) as { rows: Row[] };
    const oldBad = old.rows.filter((r) => r.problems.length > 0).length;
    console.log(`before (${cmp}): ${oldBad} with problems`);
  }
}

if (process.argv[1]?.endsWith('audio-analyze.ts')) main();
