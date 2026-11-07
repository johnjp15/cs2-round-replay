/**
 * A1: procedurally generated placeholder sounds (pure, deterministic per id; tested in Node). Every event in the
 * table (events.ts) gets one, so the whole pipeline is audible before John's CS2 files are packed. The page renders
 * them at audio start (a few ms, nothing embedded); `tools/gen-placeholder-sounds.ts` renders the same samples to
 * WAV files and through `tools/pack-sounds.ts` to check the real-sound path end to end.
 */
import type { Synth } from './events';

/** mulberry32 seeded from a string (FNV-1a). */
export function seededRng(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One-pole low-pass coefficient for a cut-off. */
function lpk(hz: number, rate: number): number {
  return 1 - Math.exp((-2 * Math.PI * Math.min(hz, rate * 0.45)) / rate);
}

/** Render a recipe to mono PCM (−1..1) at `rate`. */
export function renderSynth(s: Synth, key: string, rate: number): Float32Array<ArrayBuffer> {
  const n = Math.max(1, Math.round(s.dur * rate));
  const out = new Float32Array(n);
  const rnd = seededRng(key);
  const noise = (): number => rnd() * 2 - 1;
  const gain = s.gain ?? 0.8;
  const bright = s.bright ?? 0.5;
  let lp = 0;
  let lp2 = 0;
  let hp = 0;
  const twoPi = 2 * Math.PI;
  switch (s.kind) {
    case 'gun': {
      // A crack (bright noise, fast decay) + a body (low-passed noise) + a thump (sine sweeping down).
      const kBody = lpk(900 + 1500 * bright, rate);
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const w = noise();
        lp += kBody * (w - lp);
        const crack = (w - lp) * Math.exp(-t * 90) * bright;
        const body = lp * Math.exp(-t * (8 / s.dur));
        const thump = Math.sin(twoPi * s.f * t * (1 - 0.4 * Math.min(1, t * 8))) * Math.exp(-t * 30);
        const attack = Math.min(1, t * rate / 24);
        out[i] = attack * (0.9 * crack + 1.1 * body + 0.8 * thump);
      }
      break;
    }
    case 'click': {
      const k = lpk(s.f, rate);
      const k2 = lpk(s.f * 0.35, rate);
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const w = noise();
        lp += k * (w - lp);
        lp2 += k2 * (lp - lp2);
        const band = lp - lp2;
        const tick = i < rate * 0.002 ? 1 - i / (rate * 0.002) : 0;
        const second = t > s.dur * 0.45 && t < s.dur * 0.45 + 0.002 ? 0.6 : 0;
        out[i] = (band * 3 * Math.exp(-t * 60) + tick + second) * 0.8;
      }
      break;
    }
    case 'step': {
      const k = lpk(s.f, rate);
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        lp += k * (noise() - lp);
        const env = Math.min(1, t * 400) * Math.exp(-t * (6 / s.dur));
        out[i] = (lp * 2.5 + Math.sin(twoPi * 70 * t) * 0.5) * env;
      }
      break;
    }
    case 'beep': {
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const env = Math.min(1, t * 300) * Math.min(1, (s.dur - t) * 300);
        out[i] = Math.sin(twoPi * s.f * t) * env;
      }
      break;
    }
    case 'whoosh': {
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const p = t / s.dur;
        const f = s.f * (0.6 + 0.8 * p);
        const k = lpk(f, rate);
        lp += k * (noise() - lp);
        hp = lp - lp2;
        lp2 += lpk(f * 0.4, rate) * (lp - lp2);
        out[i] = hp * 3 * Math.sin(Math.PI * Math.min(1, p)) ** 2;
      }
      break;
    }
    case 'boom': {
      const k = lpk(400 + 2500 * bright, rate);
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const w = noise();
        lp += k * (w - lp);
        lp2 += lpk(120, rate) * (w - lp2);
        const env = Math.min(1, t * 2000) * Math.exp(-t * (4 / s.dur));
        out[i] = (lp * 1.2 + lp2 * 4 + Math.sin(twoPi * s.f * t) * Math.exp(-t * 6)) * env + (w - lp) * bright * Math.exp(-t * 60);
      }
      break;
    }
    case 'hiss': {
      const k = lpk(s.f, rate);
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        lp += k * (noise() - lp);
        const env = Math.min(1, t * 20) * Math.exp(-t * (2.5 / s.dur));
        out[i] = lp * 2.2 * env;
      }
      break;
    }
    case 'crackle': {
      // Loopable: low rumble noise + random pops; faded at both ends only for the non-looping use.
      const k = lpk(s.f * 0.15, rate);
      for (let i = 0; i < n; i++) {
        lp += k * (noise() - lp);
        const pop = rnd() < 30 / rate ? 1 : 0;
        hp = pop > 0 ? 0.9 : hp * 0.97;
        out[i] = lp * 1.6 + hp * noise() * 0.8;
      }
      // Crossfade the ends so the loop has no click.
      const f = Math.min(n >> 2, Math.round(rate * 0.05));
      for (let i = 0; i < f; i++) {
        const a = i / f;
        const j = n - f + i;
        out[i] = (out[i] as number) * a + (out[j] as number) * (1 - a);
      }
      break;
    }
    case 'dink': {
      const parts = [1, 2.76, 5.4, 8.93];
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        let v = 0;
        for (let p = 0; p < parts.length; p++) v += Math.sin(twoPi * s.f * (parts[p] as number) * 0.5 * t) * Math.exp(-t * (8 + p * 6)) / (p + 1);
        out[i] = v * Math.min(1, t * 3000);
      }
      break;
    }
    case 'thump': {
      const k = lpk(800 + 2000 * bright, rate);
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        lp += k * (noise() - lp);
        out[i] = (Math.sin(twoPi * s.f * t) * 1.2 + lp * 1.5) * Math.min(1, t * 1500) * Math.exp(-t * (6 / s.dur));
      }
      break;
    }
    case 'sting': {
      const chord = [1, 1.26, 1.5, 2];
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        let v = 0;
        for (const c of chord) v += Math.sin(twoPi * s.f * c * t) + 0.3 * Math.sin(twoPi * s.f * c * 2 * t);
        out[i] = (v / chord.length) * Math.min(1, t * 40) * Math.min(1, ((s.dur - t) * 3));
      }
      break;
    }
  }
  // Normalise to the recipe's peak gain.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i] as number));
  const g = peak > 0 ? gain / peak : 0;
  for (let i = 0; i < n; i++) out[i] = (out[i] as number) * g;
  return out;
}

/** 16-bit PCM mono WAV bytes (tools; the browser uses the Float32Array directly). */
export function wavBytes(pcm: Float32Array, rate: number): Uint8Array {
  const n = pcm.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round((pcm[i] as number) * 32767))), true);
  return new Uint8Array(buf);
}
