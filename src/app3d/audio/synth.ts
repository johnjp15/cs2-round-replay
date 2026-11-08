/**
 * A1 / A2: procedurally generated placeholder sounds (pure, deterministic per key; tested in Node). Every event in
 * the table (events.ts) gets one, so the whole pipeline is audible before John's CS2 files are packed. The page
 * renders them lazily at the AudioContext's own rate (nothing embedded); `tools/audio-analyze.ts` renders the same
 * samples to WAV and measures them (docs/audio.md).
 *
 * A2 rewrite (the A1 bursts clicked, sat at one loudness and sounded alike):
 *  - every sound has an envelope: a raised-cosine fade-in (0.3 ms for transients, 2–5 ms otherwise) and a 6 ms
 *    fade-out, and a 25 Hz high-pass that removes any DC offset; loops crossfade their seam;
 *  - guns are layered: a bright high-passed crack (a few ms), a band-passed body, a sine thump sweeping down to `f`
 *    (60–120 Hz rifles, deeper AWP), a mechanical click, and a reverberant tail (4 combs + 2 all-passes, Schroeder);
 *    suppressed guns have no crack, a "pfft" and a quiet tail;
 *  - footsteps are two filtered noise taps (heel, toe 25–45 ms later) with a low thud, the surface in the cut-off,
 *    grit and (metal) ring; landings one heavier thud;
 *  - foley clicks follow a tap pattern per event (mag out: two taps with a slide; mag in: insert + latch; bolt:
 *    back + forward; …) so different events don't sound the same;
 *  - every sound is normalised to its own loudness (`Synth.level`, the loudest 50 ms in dBFS, by kind by default)
 *    instead of one peak for all, and its peak is kept under −1 dBFS.
 * Variants (`key` = `<id>#<n>`) change the seed and nudge pitch / timing, so repeated steps and shots aren't identical.
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

/** An RBJ biquad (transposed direct form II); `tune` changes the coefficients and keeps the state (sweeps). */
class Biquad {
  private z1 = 0;
  private z2 = 0;
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;

  static make(type: 'lp' | 'hp' | 'bp', hz: number, q: number, rate: number): Biquad {
    const b = new Biquad();
    b.tune(type, hz, q, rate);
    return b;
  }

  tune(type: 'lp' | 'hp' | 'bp', hz: number, q: number, rate: number): void {
    const w = (2 * Math.PI * Math.min(hz, rate * 0.45)) / rate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    let b0: number;
    let b1: number;
    let b2: number;
    if (type === 'lp') {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
    } else if (type === 'hp') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  run(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Schroeder reverb (4 parallel combs, 2 series all-passes) over `x`, wet only. */
function reverb(x: Float32Array, rate: number, decay: number, rnd: () => number): Float32Array {
  const out = new Float32Array(x.length);
  const combs = [29.7, 37.1, 41.1, 43.7].map((ms) => Math.round(((ms * (0.95 + 0.1 * rnd())) / 1000) * rate));
  for (const d of combs) {
    const buf = new Float32Array(d);
    const g = Math.pow(0.001, d / rate / Math.max(0.05, decay));
    let i = 0;
    let lp = 0;
    for (let n = 0; n < x.length; n++) {
      const y = buf[i] as number;
      lp += 0.45 * (y - lp);
      buf[i] = (x[n] as number) + lp * g;
      out[n] = (out[n] as number) + y * 0.25;
      i = (i + 1) % d;
    }
  }
  for (const ms of [5, 1.7]) {
    const d = Math.round((ms / 1000) * rate);
    const buf = new Float32Array(d);
    let i = 0;
    for (let n = 0; n < out.length; n++) {
      const b = buf[i] as number;
      const v = out[n] as number;
      const y = -0.7 * v + b;
      buf[i] = v + 0.7 * y;
      out[n] = y;
      i = (i + 1) % d;
    }
  }
  return out;
}

/** Default loudness by kind (the loudest 50 ms, dBFS). **Assumed** relative levels; see docs/audio.md "Levels". */
const LEVEL: Record<Synth['kind'], number> = {
  gun: -9,
  click: -22,
  step: -24,
  beep: -16,
  whoosh: -22,
  boom: -7,
  hiss: -18,
  crackle: -24,
  dink: -14,
  thump: -16,
  sting: -18,
};

/** Raised-cosine ramp 0..1 over `len` samples. */
const ramp = (i: number, len: number): number => (i >= len ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * i) / len));

/** Render a recipe to mono PCM (−1..1) at `rate`. `key` seeds the noise (and, after a `#`, a variant). */
export function renderSynth(s: Synth, key: string, rate: number): Float32Array<ArrayBuffer> {
  const rnd = seededRng(key);
  const variant = key.includes('#');
  const jit = (amount: number): number => (variant ? 1 + (rnd() * 2 - 1) * amount : 1);
  const dur = s.dur;
  const loop = s.kind === 'crackle';
  const n = Math.max(16, Math.round(dur * rate));
  // Loops render a crossfade's worth more and fold it onto the start.
  const xf = loop ? Math.min(n >> 2, Math.round(rate * 0.08)) : 0;
  const out = new Float32Array(n + xf);
  const noise = (): number => rnd() * 2 - 1;
  const bright = s.bright ?? 0.5;
  const f = s.f * jit(0.04);
  const twoPi = 2 * Math.PI;
  const len = out.length;
  let fadeIn = Math.round(rate * 0.002);
  switch (s.kind) {
    case 'gun': {
      fadeIn = Math.round(rate * 0.0003);
      const muffled = s.muffled === true;
      const crackHp = Biquad.make('hp', 2500 + 2500 * bright, 0.7, rate);
      const bodyBp = Biquad.make('bp', (s.body ?? 700 + 1300 * bright) * jit(0.05), 0.9, rate);
      const mechBp = Biquad.make('bp', 3400 * jit(0.05), 5, rate);
      const pfftBp = Biquad.make('bp', 1600, 1.2, rate);
      const tailLp = Biquad.make('lp', muffled ? 900 : 1400 + 1200 * bright, 0.7, rate);
      const tauBody = muffled ? 0.012 : 0.018 + 0.035 * (1 - bright) + (f < 70 ? 0.03 : 0);
      const tauThump = (muffled ? 1.5 : 4) / f;
      const tailIn = new Float32Array(len);
      let ph = 0;
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        const crack = muffled ? 0 : crackHp.run(noise()) * Math.exp(-t / 0.004) * (0.6 + bright);
        const body = bodyBp.run(noise()) * Math.exp(-t / tauBody) * ramp(i, rate * 0.0008);
        ph += (twoPi * f * (1 + 1.6 * Math.exp(-t / 0.012))) / rate;
        const thump = Math.sin(ph) * Math.exp(-t / tauThump) * ramp(i, rate * 0.001);
        const mech = mechBp.run(noise()) * Math.exp(-Math.max(0, t - 0.002) / 0.003) * (t > 0.002 ? 1 : 0);
        const pfft = muffled ? pfftBp.run(noise()) * Math.exp(-t / 0.02) : 0;
        out[i] = 1.6 * crack + 2.8 * body + 0.75 * thump + (muffled ? 0.9 : 0.35) * mech + 1.6 * pfft;
        // The tail: what the body excites in the room, starting a few ms in.
        tailIn[i] = tailLp.run(noise()) * Math.exp(-t / Math.max(0.03, dur / 6)) * ramp(i, rate * 0.006);
      }
      const wet = reverb(tailIn, rate, dur * 0.7, rnd);
      const amt = (s.tail ?? 0.5) * (muffled ? 0.4 : 1) * 3;
      for (let i = 0; i < len; i++) out[i] = (out[i] as number) + (wet[i] as number) * amt;
      break;
    }
    case 'click': {
      // A tap pattern (seconds): each tap a resonant band-passed ping + a ring + a little low body.
      const taps = (s.taps ?? [0]).map((x, k) => (k === 0 ? x : x * jit(0.08)));
      const slide = s.slide === true;
      const fs = taps.map((_x, k) => f * (k === 0 ? 1 : 0.8 + 0.4 * rnd()));
      const bps = fs.map((ff) => Biquad.make('bp', ff, 4, rate));
      const lows = taps.map(() => Biquad.make('lp', 700, 0.7, rate));
      const slideBp = Biquad.make('bp', f * 0.55, 1, rate);
      const debris = s.debris ?? 0;
      const deb = Array.from({ length: debris }, () => ({ t: 0.012 + rnd() * dur * 0.6, g: 0.15 + 0.35 * rnd(), bp: Biquad.make('bp', f * (0.6 + 0.9 * rnd()), 3, rate) }));
      const tapLen = Math.min(0.03, dur * 0.4);
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        let v = 0;
        for (let k = 0; k < taps.length; k++) {
          const dt = t - (taps[k] as number);
          const w = noise();
          const g = k === 0 ? 1 : 0.75;
          if (dt >= 0 && dt < tapLen) {
            const e = Math.exp(-dt / 0.004) * ramp(dt * rate, rate * 0.0003);
            v += g * ((bps[k] as Biquad).run(w) * 3 * e + Math.sin(twoPi * (fs[k] as number) * 1.62 * dt) * 0.25 * Math.exp(-dt / 0.012) + (lows[k] as Biquad).run(w) * 0.8 * Math.exp(-dt / 0.006));
          } else {
            (bps[k] as Biquad).run(0);
            (lows[k] as Biquad).run(0);
          }
        }
        if (slide && taps.length > 1) {
          const a = taps[0] as number;
          const b = taps[taps.length - 1] as number;
          if (t > a && t < b) v += slideBp.run(noise()) * 0.5 * Math.sin((Math.PI * (t - a)) / (b - a));
        }
        for (const d of deb) {
          const dt = t - d.t;
          if (dt >= 0 && dt < 0.02) v += d.bp.run(noise()) * 2 * d.g * Math.exp(-dt / 0.003);
        }
        out[i] = v;
      }
      break;
    }
    case 'step': {
      // Heel and toe, the surface in the cut-off (f), grit (bright) and a ring for metal.
      const toe = 0.025 + 0.02 * rnd();
      const lp1 = Biquad.make('lp', f, 0.8, rate);
      const lp2 = Biquad.make('lp', f * 1.25, 0.8, rate);
      const grit = Biquad.make('bp', 3800 * jit(0.1), 1.5, rate);
      const metal = f >= 2000;
      const thud = 95 * jit(0.08);
      const heavy = dur > 0.15;
      const tau = heavy ? 0.028 : 0.012;
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        let v = 0;
        const e1 = Math.exp(-t / tau) * ramp(i, rate * 0.0015);
        v += lp1.run(noise()) * (heavy ? 3 : 2.2) * e1 + Math.sin(twoPi * (heavy ? 70 : thud) * t) * (heavy ? 0.5 : 0.7) * Math.exp(-t / (tau * 1.3)) * ramp(i, rate * 0.002);
        const dt = t - toe;
        if (!heavy && dt >= 0) v += lp2.run(noise()) * 1.4 * Math.exp(-dt / 0.009) * ramp(dt * rate, rate * 0.001);
        else lp2.run(0);
        v += grit.run(noise()) * bright * (heavy ? 2.5 : 1.5) * (Math.exp(-t / (heavy ? 0.015 : 0.006)) + (dt >= 0 && !heavy ? Math.exp(-dt / 0.005) : 0));
        if (metal) v += (Math.sin(twoPi * 880 * t) + 0.6 * Math.sin(twoPi * 1430 * t)) * 0.35 * Math.exp(-t / 0.035);
        out[i] = v;
      }
      break;
    }
    case 'beep': {
      // A sine (and a little 3rd harmonic), clean attack and release: no click.
      const a = Math.round(rate * 0.0015);
      const r = Math.round(rate * 0.01);
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        out[i] = (Math.sin(twoPi * f * t) + 0.12 * Math.sin(twoPi * 3 * f * t)) * ramp(i, a) * ramp(len - 1 - i, r);
      }
      break;
    }
    case 'whoosh': {
      const band = Biquad.make('bp', f * 0.6, 1.4, rate);
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        const p = t / dur;
        // Re-tune the band every 32 samples (the sweep).
        if (i % 32 === 0) band.tune('bp', f * (0.6 + 0.8 * p), 1.4, rate);
        out[i] = band.run(noise()) * 2 * Math.sin(Math.PI * Math.min(1, p)) ** 2;
      }
      break;
    }
    case 'boom': {
      fadeIn = Math.round(rate * 0.0005);
      const crackHp = Biquad.make('hp', 1800, 0.7, rate);
      const lp = Biquad.make('lp', 500 + 2500 * bright, 0.7, rate);
      const rumble = Biquad.make('lp', 140, 0.9, rate);
      const tailIn = new Float32Array(len);
      let ph = 0;
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        const w = noise();
        ph += (twoPi * f * (1 + 1.2 * Math.exp(-t / 0.05))) / rate;
        const env = Math.exp(-t / (dur / 5));
        out[i] = crackHp.run(w) * bright * Math.exp(-t / 0.008) * 1.5 + lp.run(w) * 1.2 * env + rumble.run(noise()) * 5 * Math.exp(-t / (dur / 3)) + Math.sin(ph) * 1.2 * Math.exp(-t / 0.15);
        tailIn[i] = lp.run(noise()) * Math.exp(-t / (dur / 4));
      }
      const wet = reverb(tailIn, rate, dur * 0.6, rnd);
      for (let i = 0; i < len; i++) out[i] = (out[i] as number) + (wet[i] as number) * 1.5;
      break;
    }
    case 'hiss': {
      fadeIn = Math.round(rate * 0.03);
      const lp = Biquad.make('lp', f, 0.7, rate);
      const hp = Biquad.make('hp', 300, 0.7, rate);
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        out[i] = hp.run(lp.run(noise())) * 2.2 * Math.exp(-t * (2.5 / dur));
      }
      break;
    }
    case 'crackle': {
      // Loopable: low rumble noise + random pops; the seam is crossfaded below.
      const lp = Biquad.make('lp', f * 0.15, 0.7, rate);
      const popBp = Biquad.make('bp', f, 2, rate);
      let pop = 0;
      for (let i = 0; i < len; i++) {
        if (rnd() < 30 / rate) pop = 0.9;
        else pop *= 0.995;
        out[i] = lp.run(noise()) * 1.6 + popBp.run(noise()) * pop * 2;
      }
      break;
    }
    case 'dink': {
      fadeIn = Math.round(rate * 0.0003);
      const parts = [1, 2.76, 5.4, 8.93];
      const hp = Biquad.make('hp', 2000, 0.7, rate);
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        let v = 0;
        for (let p = 0; p < parts.length; p++) v += (Math.sin(twoPi * f * (parts[p] as number) * 0.5 * t) * Math.exp(-t * (8 + p * 6))) / (p + 1);
        out[i] = v + hp.run(noise()) * 0.6 * Math.exp(-t / 0.003);
      }
      break;
    }
    case 'thump': {
      fadeIn = Math.round(rate * 0.0005);
      const lp = Biquad.make('lp', 600 + 2400 * bright, 0.7, rate);
      const sq = Biquad.make('bp', 2200, 2, rate);
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        const w = noise();
        out[i] = (Math.sin(twoPi * f * t) * 1.2 * Math.exp(-t / (dur / 4)) + lp.run(w) * 1.5 * Math.exp(-t / (dur / 6))) * ramp(i, rate * 0.0008) + sq.run(w) * bright * Math.exp(-t / 0.01);
      }
      break;
    }
    case 'sting': {
      fadeIn = Math.round(rate * 0.02);
      const chord = [1, 1.26, 1.5, 2];
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        let v = 0;
        for (const c of chord) v += Math.sin(twoPi * f * c * t) + 0.3 * Math.sin(twoPi * f * c * 2 * t);
        out[i] = (v / chord.length) * Math.min(1, (dur - t) * 3);
      }
      break;
    }
  }
  let res: Float32Array<ArrayBuffer>;
  if (loop) {
    // Fold the extra tail onto the start (equal power), so the end flows into the beginning.
    res = new Float32Array(n);
    for (let i = 0; i < n; i++) res[i] = out[i] as number;
    for (let i = 0; i < xf; i++) {
      const a = (Math.PI / 2) * (i / xf);
      res[i] = (out[n + i] as number) * Math.cos(a) + (out[i] as number) * Math.sin(a);
    }
  } else res = out;
  // DC: a 25 Hz high-pass (not on loops: it would break the seam's continuity), then the envelope ends.
  if (!loop) {
    const hp = Biquad.make('hp', 25, 0.7, rate);
    for (let i = 0; i < res.length; i++) res[i] = hp.run(res[i] as number);
    const fo = Math.min(res.length >> 1, Math.round(rate * 0.006));
    for (let i = 0; i < res.length; i++) res[i] = (res[i] as number) * ramp(i, fadeIn) * ramp(res.length - 1 - i, fo);
  } else {
    let mean = 0;
    for (let i = 0; i < res.length; i++) mean += res[i] as number;
    mean /= res.length;
    for (let i = 0; i < res.length; i++) res[i] = (res[i] as number) - mean;
  }
  normalise(res, rate, s.level ?? LEVEL[s.kind]);
  return res;
}

/** Scale to `levelDb` (the loudest 50 ms RMS) and keep the peak under −1 dBFS with a soft knee. */
function normalise(x: Float32Array, rate: number, levelDb: number): void {
  const win = Math.max(1, Math.min(x.length, Math.round(rate * 0.05)));
  let e = 0;
  for (let i = 0; i < win; i++) e += (x[i] as number) ** 2;
  let best = e;
  for (let i = win; i < x.length; i++) {
    e += (x[i] as number) ** 2 - (x[i - win] as number) ** 2;
    if (e > best) best = e;
  }
  const rms = Math.sqrt(Math.max(0, best) / win);
  if (rms <= 0) return;
  const g = Math.pow(10, levelDb / 20) / rms;
  const ceil = Math.pow(10, -1 / 20);
  const knee = 0.7 * ceil;
  for (let i = 0; i < x.length; i++) {
    const v = (x[i] as number) * g;
    const a = Math.abs(v);
    // Linear below the knee, tanh-shaped into the ceiling above it.
    x[i] = a <= knee ? v : Math.sign(v) * (knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee)));
  }
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
