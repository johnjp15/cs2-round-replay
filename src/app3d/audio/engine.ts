/**
 * A1 / A2: the Web Audio engine (docs/cs2-sounds.md, docs/audio.md). Created on the first user gesture (browsers keep
 * an AudioContext suspended until then). Implements the director's `SoundSink`.
 *
 * Graph: voice (AudioBufferSource → low-pass (occlusion) → gain (event volume × CS2 mixgroup volume × CS2 distance
 * curve × occlusion) → PannerNode (HRTF) for world sounds) → bus → effects / music → master → headroom → limiter
 * (a fast compressor, its make-up gain cancelled, then a soft clipper whose curve never leaves ±0.98) → speakers.
 * The listener sits at the camera, facing the view. The panner only gives direction (rolloffFactor 0): the loudness
 * by distance is the CS2 event's own curve (spatial.ts), re-evaluated every frame as the listener and the emitter
 * move; occlusion traces the 4 rays on the collision mesh every 0.1 s per voice.
 *
 * A2:
 *  - CS2's mixer: every layer is scaled by its event's mixgroup `vol` in CS2's `Default_Mix` (scripts/soundmixers.txt:
 *    Weapons 0.6, WeaponsDistant 0.6, Footsteps 0.8, BulletImpacts 0.3, Explosions 0.7, the rest 1);
 *  - CS2's `instance_limit`: an entity plays at most that many of an event at once (the AK-47's shot: 1), the oldest
 *    fading out over the event's fade time (0.1 s for shots), so a spray doesn't pile up tails;
 *  - timing: cues carry their tick; the engine maps ticks to audio time with a one-tick jitter buffer
 *    (`AUDIO_TUNING.timing`), so shots fired on consecutive ticks keep their spacing even when one frame runs several
 *    ticks, and nothing is scheduled late by more than a tick;
 *  - placeholders render lazily at the context's own rate (A1 rendered all 145 at 24 kHz on the first click), with
 *    `variants` per sound (CS2 picks one of several files too);
 *  - loops (the molotov) fade out while the game is paused and come back on resume;
 *  - `meter()`: an AudioWorklet tap before and after the limiter for the browser check (peaks, samples over 0 dBFS,
 *    a recording of the output).
 *
 * Buffers: the real CS2 files from the packed bank (bank.ts) when present, else the placeholders (synth.ts). Voices
 * are pooled (no per-frame allocation; one AudioBufferSourceNode per sound, which Web Audio requires).
 */
import manifestJson from '../../../data/audio/cs2-sound-runtime.json';
import type { Vec3 } from '../../contracts/index';
import { toThree } from '../coords';
import { SOUNDS, SOUND_IDS, BUSES, type Bus, type SoundDef } from './events';
import type { CueOptions, SoundSink } from './director';
import { distanceGain, occlusion, occlusionTargets, type CurvePoint, type P3 } from './spatial';
import { renderSynth, seededRng } from './synth';
import { AUDIO_TUNING } from './tuning';
import { bankFiles } from './bank';

interface ManifestEventLite {
  readonly files: readonly string[];
  readonly volume: number;
  readonly pitch: number;
  readonly pitchRandom: readonly number[];
  readonly volumeRandom: readonly number[];
  readonly delay: number;
  readonly curve: readonly CurvePoint[];
  readonly occlusion: number;
  readonly offset: readonly number[];
  readonly children: readonly string[];
  readonly mixgroup?: string;
  readonly limit?: number;
  readonly fade?: number;
}
interface RuntimeManifest {
  readonly events: Readonly<Record<string, ManifestEventLite>>;
  readonly mixers?: Readonly<Record<string, { readonly vol: number; readonly parent: string }>>;
}
const MANIFEST = manifestJson as unknown as RuntimeManifest;

/** CS2's Default_Mix volume of a mixgroup, times its parents' (All = 1). Unknown or empty: 1. */
export function mixgroupGain(group: string | undefined): number {
  let g = 1;
  let name = group ?? '';
  for (let depth = 0; name !== '' && depth < 8; depth++) {
    const m = MANIFEST.mixers?.[name];
    if (m === undefined) break;
    g *= m.vol;
    name = m.parent;
  }
  return g;
}

/** One layer of a sound: a CS2 event (its curve, volume, occlusion) and the buffers it picks from. */
interface Layer {
  readonly name: string;
  readonly ev: ManifestEventLite;
  buffers: AudioBuffer[];
  /** True when the buffers are Valve's files (else placeholders, rendered on first use). */
  real: boolean;
  /** A child layer muted because its parent plays a real file (it would replay the parent's placeholder). */
  muted: boolean;
  /** Placeholder only: low-pass for a child layer (the distant layer). */
  readonly childLowpass: number;
  /** The CS2 mixgroup volume. */
  readonly mix: number;
}

interface Voice {
  readonly gain: GainNode;
  readonly filter: BiquadFilterNode;
  readonly panner: PannerNode | null;
  src: AudioBufferSourceNode | null;
  layer: Layer | null;
  bus: Bus;
  readonly pos: P3;
  /** Gain apart from the distance curve: event volume × mixgroup × random × cue gain. */
  base: number;
  blocked: number;
  nextOcclusion: number;
  endAt: number;
  startedAt: number;
  loopKey: string | null;
  /** The entity that made it (instance limits), or null. */
  source: string | null;
  /** Fading out (stolen by the instance limit). */
  stopping: boolean;
  /** Its start record while metering. */
  rec: VoiceRecord | null;
}

export interface AudioSettings {
  master: number;
  effects: number;
  music: number;
}

export interface AudioWorld {
  lineBlocked(a: P3, b: P3): boolean;
}

/** Levels before and after the limiter since the meter started (the browser check). */
export interface MeterStats {
  readonly seconds: number;
  readonly pre: { readonly peak: number; readonly over: number; readonly rms: number };
  readonly post: { readonly peak: number; readonly over: number; readonly rms: number };
  /** The output (left channel) since `record`, when asked. */
  readonly rec?: Float32Array;
}

const SETTINGS_KEY = 'cs2-sim3d-audio';
const EMPTY_LAYER: Layer[] = [];

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** The soft clipper's curve: linear to `knee`, tanh into `ceiling` (never beyond it). */
export function clipCurve(points: number, knee: number, ceiling: number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = a <= knee ? x : Math.sign(x) * (knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee)));
  }
  return c;
}

const METER_WORKLET = `class A2Meter extends AudioWorkletProcessor {
  constructor() { super(); this.reset(); this.port.onmessage = (e) => {
    if (e.data === 'get') this.port.postMessage({ s: this.s, n: this.n, rec: this.rec === null ? null : this.flat() });
    else if (e.data === 'reset') this.reset();
    else if (e.data === 'record') this.rec = [];
  }; }
  reset() { this.s = [{ peak: 0, over: 0, sq: 0 }, { peak: 0, over: 0, sq: 0 }]; this.n = [0, 0]; this.rec = null; }
  flat() { let n = 0; for (const c of this.rec) n += c.length; const o = new Float32Array(n); let k = 0; for (const c of this.rec) { o.set(c, k); k += c.length; } return o; }
  process(inputs) {
    for (let k = 0; k < 2; k++) {
      const inp = inputs[k]; if (!inp || inp.length === 0) continue;
      const st = this.s[k];
      for (const ch of inp) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > st.peak) st.peak = a; if (a > 1) st.over++; st.sq += a * a; }
      this.n[k] += inp[0].length * inp.length;
    }
    if (this.rec !== null && inputs[1] && inputs[1][0]) this.rec.push(new Float32Array(inputs[1][0]));
    return true;
  }
}
registerProcessor('a2-meter', A2Meter);`;

/** Point a Web Audio listener at a Source position / yaw / pitch (degrees): Three.js axes, as the camera. */
export function orientListener(l: AudioListener, t: number, eye: Vec3, yaw: number, pitch: number): void {
  const [x, y, z] = toThree(eye.x, eye.y, eye.z);
  const yr = (yaw * Math.PI) / 180;
  const pr = (pitch * Math.PI) / 180;
  const [fx, fy, fz] = toThree(Math.cos(pr) * Math.cos(yr), Math.cos(pr) * Math.sin(yr), -Math.sin(pr));
  const [ux, uy, uz] = toThree(Math.sin(pr) * Math.cos(yr), Math.sin(pr) * Math.sin(yr), Math.cos(pr));
  if (l.positionX !== undefined) {
    l.positionX.setValueAtTime(x, t);
    l.positionY.setValueAtTime(y, t);
    l.positionZ.setValueAtTime(z, t);
    l.forwardX.setValueAtTime(fx, t);
    l.forwardY.setValueAtTime(fy, t);
    l.forwardZ.setValueAtTime(fz, t);
    l.upX.setValueAtTime(ux, t);
    l.upY.setValueAtTime(uy, t);
    l.upZ.setValueAtTime(uz, t);
  } else {
    l.setPosition(x, y, z);
    l.setOrientation(fx, fy, fz, ux, uy, uz);
  }
}

/** One voice start (while metering): when, what, who, how far, its gain then; `end` when it stopped or will. */
export interface VoiceRecord {
  readonly at: number;
  readonly id: string;
  readonly event: string;
  readonly source: string | null;
  readonly distance: number;
  readonly gain: number;
  readonly local: boolean;
  end: number;
}

export class AudioEngine implements SoundSink {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private headroom: GainNode | null = null;
  private limiterOut: AudioNode | null = null;
  private effectsGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private readonly buses = new Map<Bus, GainNode>();
  private readonly layers = new Map<string, Layer[]>();
  /** Rendered placeholder variants by sound id. */
  private readonly placeholders = new Map<string, AudioBuffer[]>();
  private world: Voice[] = [];
  private local: Voice[] = [];
  private readonly ear: P3 = { x: 0, y: 0, z: 0 };
  private readonly targets: P3[] = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, z: 0 }));
  private readonly rnd = seededRng('a1-audio');
  readonly settings: AudioSettings;
  /** Stats for the browser check: sounds started, the last ids, whether the CS2 bank is in use. */
  started = 0;
  readonly lastIds: string[] = [];
  realFiles = 0;
  /** Cues dropped because they were silent by construction (a cvar at 0). */
  skipped = 0;
  /** Instances faded out by CS2's instance_limit. */
  limited = 0;
  /** Cues whose tick was already past when they arrived (scheduled now instead). */
  late = 0;
  private starting: Promise<void> | null = null;
  private clockTick: number | null = null;
  private clockTime = 0;
  private speed = 1;
  private held = false;
  private meterNode: AudioWorkletNode | null = null;
  private meterStart = 0;
  /** While metering: every tick-bound cue's tick, source, audio start time and lead over the moment it arrived. */
  readonly timing: { tick: number; id: string; source: string | null; at: number; lead: number }[] = [];
  /** While metering: every voice started (and when it ended). */
  readonly voices: VoiceRecord[] = [];
  /** Layers not started because the listener is beyond their CS2 curve (gain 0), as CS2 culls them. */
  culled = 0;

  constructor(private readonly worldMesh: AudioWorld | null) {
    this.settings = { ...AUDIO_TUNING.defaults };
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<AudioSettings>;
      for (const k of ['master', 'effects', 'music'] as const) if (typeof s[k] === 'number' && Number.isFinite(s[k])) this.settings[k] = clamp01(s[k]);
    } catch {
      // no storage: defaults
    }
  }

  /** The AudioContext's state, or 'none' before the first gesture. */
  state(): string {
    return this.ctx?.state ?? 'none';
  }

  /** Start on the first click / key (the browser's autoplay rule). */
  attachGesture(target: EventTarget): void {
    const go = (): void => {
      void this.start();
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) target.addEventListener(ev, go, { capture: true });
  }

  start(): Promise<void> {
    this.starting ??= this.open();
    if (this.ctx !== null && this.ctx.state === 'suspended') void this.ctx.resume();
    return this.starting;
  }

  private async open(): Promise<void> {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) return;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const L = AUDIO_TUNING.limiter;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = L.thresholdDb;
    comp.knee.value = L.kneeDb;
    comp.ratio.value = L.ratio;
    comp.attack.value = L.attackSec;
    comp.release.value = L.releaseSec;
    // The Web Audio compressor adds make-up gain (spec: (1 / gain at 0 dBFS)^0.6); take it back out so quiet
    // sounds keep CS2's levels and only the peaks are squeezed.
    const trim = ctx.createGain();
    trim.gain.value = Math.pow(10, -L.makeupDb / 20);
    const clip = ctx.createWaveShaper();
    clip.curve = clipCurve(4097, L.clipKnee, L.clipCeiling);
    clip.oversample = '2x';
    comp.connect(trim);
    trim.connect(clip);
    clip.connect(ctx.destination);
    this.limiterOut = clip;
    this.headroom = ctx.createGain();
    this.headroom.gain.value = Math.pow(10, AUDIO_TUNING.mix.headroomDb / 20);
    this.headroom.connect(comp);
    this.master = ctx.createGain();
    this.master.connect(this.headroom);
    this.effectsGain = ctx.createGain();
    this.musicGain = ctx.createGain();
    this.effectsGain.connect(this.master);
    this.musicGain.connect(this.master);
    for (const b of BUSES) {
      const g = ctx.createGain();
      g.gain.value = AUDIO_TUNING.mix.bus[b];
      g.connect(b === 'music' ? this.musicGain : this.effectsGain);
      this.buses.set(b, g);
    }
    this.applySettings();
    const mk = (spatial: boolean): Voice => {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = AUDIO_TUNING.occlusion.openLowpassHz;
      const gain = ctx.createGain();
      filter.connect(gain);
      let panner: PannerNode | null = null;
      if (spatial) {
        panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.rolloffFactor = 0;
        panner.refDistance = 1;
        gain.connect(panner);
      }
      return { gain, filter, panner, src: null, layer: null, bus: 'weapons', pos: { x: 0, y: 0, z: 0 }, base: 0, blocked: 0, nextOcclusion: 0, endAt: 0, startedAt: 0, loopKey: null, source: null, stopping: false, rec: null };
    };
    const n = AUDIO_TUNING.maxVoices;
    this.world = Array.from({ length: n }, () => mk(true));
    this.local = Array.from({ length: Math.max(8, n >> 2) }, () => mk(false));
    this.buildLayers();
    if (ctx.state === 'suspended') await ctx.resume();
    await this.loadBank(ctx);
    this.prewarm();
  }

  private buildLayers(): void {
    for (const id of SOUND_IDS) {
      const def = SOUNDS[id] as SoundDef;
      const layers: Layer[] = [];
      const add = (name: string, child: boolean): void => {
        const ev = MANIFEST.events[name];
        if (ev === undefined || (child && ev.files.length === 0)) return;
        layers.push({ name, ev, buffers: [], real: false, muted: false, childLowpass: child ? 2500 : AUDIO_TUNING.occlusion.openLowpassHz, mix: mixgroupGain(ev.mixgroup) });
        if (!child) for (const c of ev.children) add(c, true);
      };
      for (const name of def.cs2) add(name, false);
      if (layers.length === 0) layers.push({ name: id, ev: { files: [], volume: 1, pitch: 1, pitchRandom: [0, 0], volumeRandom: [0, 0], delay: 0, curve: [], occlusion: 0, offset: [0, 0, 0], children: [] }, buffers: [], real: false, muted: false, childLowpass: 20000, mix: 1 });
      this.layers.set(id, layers);
    }
  }

  /** The placeholder variants of a sound, rendered on first use at the context's rate. */
  private placeholder(id: string): AudioBuffer[] {
    const have = this.placeholders.get(id);
    if (have !== undefined || this.ctx === null) return have ?? [];
    const def = SOUNDS[id] as SoundDef;
    const rate = this.ctx.sampleRate;
    const out: AudioBuffer[] = [];
    for (let k = 0; k < Math.max(1, def.variants ?? 1); k++) {
      const pcm = renderSynth(def.synth, k === 0 ? id : `${id}#${k}`, rate);
      const buf = this.ctx.createBuffer(1, pcm.length, rate);
      buf.copyToChannel(pcm, 0);
      out.push(buf);
    }
    this.placeholders.set(id, out);
    return out;
  }

  /** Render the placeholders the game will need, a few per idle slice, so the first shot doesn't wait for its render. */
  private prewarm(): void {
    const todo = SOUND_IDS.filter((id) => (this.layers.get(id) ?? []).some((l) => !l.real && !l.muted));
    const step = (): void => {
      const t0 = performance.now();
      while (todo.length > 0 && performance.now() - t0 < 4) this.placeholder(todo.shift() as string);
      if (todo.length > 0) setTimeout(step, 16);
    };
    setTimeout(step, 0);
  }

  /** Decode the packed CS2 files (if the build has the bank) and put them in place of the placeholders. */
  private async loadBank(ctx: AudioContext): Promise<void> {
    const files = bankFiles();
    if (files === null) return;
    const decoded = new Map<string, AudioBuffer>();
    // In parallel: the browser decodes off the main thread.
    await Promise.all(
      Object.entries(files).map(async ([path, b64]) => {
        try {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          decoded.set(path, await ctx.decodeAudioData(bytes.buffer));
          this.realFiles = decoded.size;
        } catch {
          // This browser can't decode it (e.g. an old Safari and Opus): that event keeps its placeholder.
        }
      }),
    );
    for (const layers of this.layers.values()) {
      for (const l of layers) {
        const bufs = l.ev.files.map((f) => decoded.get(f)).filter((b): b is AudioBuffer => b !== undefined);
        if (bufs.length > 0) {
          l.buffers = bufs;
          l.real = true;
        }
      }
      // A child layer without its own real files would replay the parent's placeholder: once the parent is real, mute it.
      const parentReal = layers[0]?.real === true;
      if (parentReal) for (const l of layers) if (!l.real) l.muted = true;
    }
  }

  /** The buffers a layer plays now (the CS2 files, else the sound's placeholders). */
  private buffersOf(id: string, layer: Layer): AudioBuffer[] {
    if (layer.muted) return [];
    return layer.real ? layer.buffers : this.placeholder(id);
  }

  /** True when a sound would play Valve's file (tests, the browser check). */
  isReal(id: string): boolean {
    return (this.layers.get(id) ?? []).some((l) => l.real);
  }

  applySettings(): void {
    const c = this.ctx;
    if (c === null || this.master === null || this.effectsGain === null || this.musicGain === null) return;
    this.master.gain.setTargetAtTime(this.settings.master, c.currentTime, 0.02);
    this.effectsGain.gain.setTargetAtTime(this.settings.effects, c.currentTime, 0.02);
    this.musicGain.gain.setTargetAtTime(this.settings.music, c.currentTime, 0.02);
  }

  setVolume(k: keyof AudioSettings, v: number): void {
    this.settings[k] = clamp01(v);
    this.applySettings();
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // ignore
    }
  }

  /** The playback speed (1×, 2×, …): ticks are 1 / (64 × speed) s apart in audio time. */
  setSpeed(x: number): void {
    if (x > 0 && x !== this.speed) {
      this.speed = x;
      this.clockTick = null;
    }
  }

  /** Paused (no tick for a while): loops fade out; false brings them back. */
  hold(on: boolean): void {
    this.held = on;
  }

  /**
   * The audio time of a tick: one tick of jitter buffer after the first tick seen, then 1 / (64 × speed) s per tick.
   * Re-anchored when a tick would land in the past (the simulation fell behind) or too far ahead (a jump).
   */
  private when(tick: number | undefined, now: number): number {
    if (tick === undefined) return now;
    const T = AUDIO_TUNING.timing;
    if (this.clockTick !== null) {
      const ideal = this.clockTime + (tick - this.clockTick) / (64 * this.speed);
      if (ideal >= now && ideal <= now + T.maxAheadSec) return ideal;
      if (ideal < now && ideal > now - T.lateSec) {
        this.late++;
        this.clockTick = tick;
        this.clockTime = now;
        return now;
      }
    }
    this.clockTick = tick;
    this.clockTime = now + T.bufferSec;
    return this.clockTime;
  }

  /** The listener at the camera (Source position, yaw, pitch in degrees). Call once per frame. */
  setListener(eye: Vec3, yaw: number, pitch: number): void {
    this.ear.x = eye.x;
    this.ear.y = eye.y;
    this.ear.z = eye.z;
    const c = this.ctx;
    if (c === null) return;
    orientListener(c.listener, c.currentTime, eye, yaw, pitch);
  }

  /**
   * Left / right check (the browser check): an OfflineAudioContext with this engine's listener math, the listener
   * at the origin facing yaw `yaw`, a noise burst 200 u to the Source position's right (−y rotated by yaw); returns
   * the RMS of the left and right channels (right must be louder).
   */
  async probeLR(yaw = 0): Promise<{ left: number; right: number }> {
    const rate = 48000;
    const oc = new OfflineAudioContext(2, rate / 4, rate);
    orientListener(oc.listener, 0, { x: 0, y: 0, z: 0 }, yaw, 0);
    const p = oc.createPanner();
    p.panningModel = 'HRTF';
    p.rolloffFactor = 0;
    const yr = (yaw * Math.PI) / 180;
    // Right of the view in Source (z up): forward (cos, sin) rotated −90° = (sin, −cos).
    const [x, y, z] = toThree(Math.sin(yr) * 200, -Math.cos(yr) * 200, 0);
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
    const buf = oc.createBuffer(1, rate / 4, rate);
    const d = buf.getChannelData(0);
    const r = seededRng('lr');
    for (let i = 0; i < d.length; i++) d[i] = (r() * 2 - 1) * 0.5;
    const src = oc.createBufferSource();
    src.buffer = buf;
    src.connect(p);
    p.connect(oc.destination);
    src.start();
    const out = await oc.startRendering();
    const rms = (ch: Float32Array): number => Math.sqrt(ch.reduce((a, v) => a + v * v, 0) / ch.length);
    return { left: rms(out.getChannelData(0)), right: rms(out.getChannelData(1)) };
  }

  private pick(pool: Voice[], now: number): Voice {
    let best: Voice | null = null;
    for (const v of pool) {
      if (v.src === null || now >= v.endAt) {
        this.release(v);
        return v;
      }
      // Steal the oldest one-shot (a fading one first).
      if (v.loopKey === null && (best === null || (v.stopping && !best.stopping) || (v.stopping === best.stopping && v.startedAt < best.startedAt))) best = v;
    }
    const v = best ?? (pool[0] as Voice);
    this.release(v);
    return v;
  }

  private release(v: Voice): void {
    if (v.rec !== null && this.ctx !== null) v.rec.end = Math.min(v.rec.end, Math.max(v.rec.at, this.ctx.currentTime));
    v.rec = null;
    if (v.src !== null) {
      try {
        v.src.stop();
      } catch {
        // not started
      }
      v.src.disconnect();
      v.src = null;
    }
    v.layer = null;
    v.loopKey = null;
    v.source = null;
    v.stopping = false;
  }

  /** CS2's instance_limit: fade out the oldest instances of `layer` by `source` until a new one fits. */
  private limit(layer: Layer, source: string | null, at: number): void {
    const lim = layer.ev.limit ?? 0;
    if (lim <= 0 || source === null) return;
    const same: Voice[] = [];
    for (const pool of [this.world, this.local]) for (const v of pool) if (v.src !== null && !v.stopping && v.layer === layer && v.source === source) same.push(v);
    if (same.length < lim) return;
    same.sort((a, b) => a.startedAt - b.startedAt);
    const fade = Math.max(0.01, layer.ev.fade !== undefined && layer.ev.fade > 0 && layer.ev.fade < 1 ? layer.ev.fade : AUDIO_TUNING.timing.stealFadeSec);
    for (let i = 0; i <= same.length - lim; i++) {
      const v = same[i] as Voice;
      v.stopping = true;
      v.gain.gain.cancelScheduledValues(at);
      v.gain.gain.setTargetAtTime(0, at, fade / 4);
      try {
        v.src?.stop(at + fade);
      } catch {
        // already stopped
      }
      v.endAt = Math.min(v.endAt, at + fade + 0.02);
      if (v.rec !== null) v.rec.end = Math.min(v.rec.end, at + fade);
      this.limited++;
    }
  }

  play(id: string, pos: Vec3 | null, opts: CueOptions = {}, loopKey: string | null = null): void {
    const c = this.ctx;
    if (c === null || c.state !== 'running') return;
    const def = SOUNDS[id];
    if (def === undefined) return;
    if (opts.gain !== undefined && opts.gain <= 0) {
      this.skipped++;
      return;
    }
    const layers = this.layers.get(id) ?? EMPTY_LAYER;
    const now = c.currentTime;
    const at = this.when(opts.tick, now);
    if (this.meterNode !== null && opts.tick !== undefined && this.timing.length < 8192) this.timing.push({ tick: opts.tick, id, source: opts.source ?? null, at, lead: at - now });
    const local = def.space === 'local' || pos === null || opts.self === true;
    const source = opts.source ?? null;
    for (const layer of layers) {
      const buffers = this.buffersOf(id, layer);
      if (buffers.length === 0) continue;
      const ev = layer.ev;
      // A local sound's child (the distant layer) is silent at the curve's nearest point: don't start it.
      if (local && layer.childLowpass < AUDIO_TUNING.occlusion.openLowpassHz && distanceGain(1, ev.curve, 0) <= 0) continue;
      // Beyond the event's curve (the AK-47's distant layer under 800 u, footsteps past 1,100 u): CS2 plays nothing,
      // so don't take a voice for it either (A1 started every layer at gain 0).
      let dist = 0;
      if (!local && pos !== null && def.loop !== true) {
        dist = Math.hypot(pos.x - this.ear.x, pos.y - this.ear.y, pos.z + (opts.origin === true ? (ev.offset[2] ?? 0) : 0) - this.ear.z);
        if (distanceGain(1, ev.curve, dist) <= 0) {
          this.culled++;
          continue;
        }
      }
      this.limit(layer, source, at);
      const buf = buffers[Math.floor(this.rnd() * buffers.length)] as AudioBuffer;
      const v = this.pick(local ? this.local : this.world, now);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = def.loop === true && loopKey !== null;
      const pr = ev.pitchRandom;
      src.playbackRate.value = ev.pitch * (1 + ((pr[0] ?? 0) + ((pr[1] ?? 0) - (pr[0] ?? 0)) * this.rnd()) * (this.rnd() < 0.5 ? -1 : 1));
      src.connect(v.filter);
      const vr = ev.volumeRandom;
      v.base = ev.volume * layer.mix * (1 - ((vr[0] ?? 0) + ((vr[1] ?? 0) - (vr[0] ?? 0)) * this.rnd())) * (opts.gain ?? 1);
      v.layer = layer;
      v.bus = def.bus;
      v.loopKey = loopKey;
      v.source = source;
      v.stopping = false;
      if (pos !== null) {
        v.pos.x = pos.x;
        v.pos.y = pos.y;
        v.pos.z = pos.z + (opts.origin === true ? (ev.offset[2] ?? 0) : 0);
      }
      v.blocked = 0;
      v.nextOcclusion = 0;
      v.gain.disconnect();
      v.gain.connect(v.panner ?? (this.buses.get(def.bus) as GainNode));
      if (v.panner !== null) {
        v.panner.disconnect();
        v.panner.connect(this.buses.get(def.bus) as GainNode);
      }
      // Own sounds sit at the curve's nearest point (CS2 puts the local player's at the listener); world sounds
      // start at their gain now (update() follows them).
      const g = local ? v.base * distanceGain(1, ev.curve, 0) : this.voiceGain(v, now);
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(g, now);
      v.filter.frequency.cancelScheduledValues(now);
      v.filter.frequency.setValueAtTime(local ? layer.childLowpass : Math.min(layer.childLowpass, v.filter.frequency.value), now);
      if (v.panner !== null) this.place(v.panner, v.pos, now);
      const when = at + Math.max(0, ev.delay);
      src.start(when);
      v.src = src;
      v.startedAt = when;
      v.endAt = src.loop ? Infinity : when + buf.duration / Math.max(0.01, src.playbackRate.value) + 0.05;
      if (this.meterNode !== null && this.voices.length < 20000) {
        v.rec = { at: when, id, event: layer.name, source, distance: dist, gain: g, local, end: v.endAt - 0.05 };
        this.voices.push(v.rec);
      }
    }
    this.started++;
    this.lastIds.push(id);
    if (this.lastIds.length > 32) this.lastIds.shift();
  }

  loop(key: string, id: string, pos: Vec3): void {
    this.stopLoop(key);
    this.play(id, pos, {}, key);
  }

  stopLoop(key: string): void {
    for (const v of this.world) if (v.loopKey === key) this.release(v);
    for (const v of this.local) if (v.loopKey === key) this.release(v);
  }

  stopAll(): void {
    for (const v of this.world) this.release(v);
    for (const v of this.local) this.release(v);
    this.clockTick = null;
  }

  private place(p: PannerNode, pos: P3, t: number): void {
    const [x, y, z] = toThree(pos.x, pos.y, pos.z);
    if (p.positionX !== undefined) {
      p.positionX.setValueAtTime(x, t);
      p.positionY.setValueAtTime(y, t);
      p.positionZ.setValueAtTime(z, t);
    } else p.setPosition(x, y, z);
  }

  /** The voice's gain now: base × curve(distance) × occlusion (re-traced every recheckSec). */
  private voiceGain(v: Voice, now: number): number {
    const layer = v.layer;
    if (layer === null) return 0;
    const d = Math.hypot(v.pos.x - this.ear.x, v.pos.y - this.ear.y, v.pos.z - this.ear.z);
    const curve = distanceGain(1, layer.ev.curve, d);
    if (curve <= 0) return 0;
    if (this.worldMesh !== null && now >= v.nextOcclusion && layer.ev.occlusion > 0) {
      v.nextOcclusion = now + AUDIO_TUNING.occlusion.recheckSec;
      occlusionTargets(this.ear, v.pos, AUDIO_TUNING.occlusion.spread, this.targets);
      let blocked = 0;
      for (const t of this.targets) if (this.worldMesh.lineBlocked(this.ear, t)) blocked++;
      v.blocked = blocked / this.targets.length;
    }
    const occ = occlusion(layer.ev.occlusion, v.blocked);
    v.filter.frequency.setTargetAtTime(Math.min(layer.childLowpass, occ.lowpassHz), now, AUDIO_TUNING.smoothSec);
    return v.base * curve * occ.gain * (this.held && v.loopKey !== null ? 0 : 1);
  }

  /** Per frame: follow every playing world voice's distance and occlusion; free finished voices. */
  update(): void {
    const c = this.ctx;
    if (c === null) return;
    const now = c.currentTime;
    for (const v of this.world) {
      if (v.src === null) continue;
      if (now >= v.endAt) {
        this.release(v);
        continue;
      }
      if (!v.stopping) v.gain.gain.setTargetAtTime(this.voiceGain(v, now), now, AUDIO_TUNING.smoothSec);
    }
    for (const v of this.local) {
      if (v.src !== null && now >= v.endAt) this.release(v);
      else if (v.src !== null && v.loopKey !== null && !v.stopping && v.layer !== null) v.gain.gain.setTargetAtTime(this.held ? 0 : v.base * distanceGain(1, v.layer.ev.curve, 0), now, 0.05);
    }
  }

  /** Voices playing now (stats). */
  playing(): number {
    let n = 0;
    for (const v of this.world) if (v.src !== null) n++;
    for (const v of this.local) if (v.src !== null) n++;
    return n;
  }

  /** The browser check: tap the mix before and after the limiter (an AudioWorklet), reset its counters. */
  async meter(record = false): Promise<boolean> {
    const c = this.ctx;
    if (c === null || this.headroom === null || this.limiterOut === null || c.audioWorklet === undefined) return false;
    if (this.meterNode === null) {
      const url = URL.createObjectURL(new Blob([METER_WORKLET], { type: 'text/javascript' }));
      await c.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(c, 'a2-meter', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
      this.headroom.connect(node, 0, 0);
      this.limiterOut.connect(node, 0, 1);
      const sink = c.createGain();
      sink.gain.value = 0;
      node.connect(sink);
      sink.connect(c.destination);
      this.meterNode = node;
    }
    this.meterNode.port.postMessage('reset');
    this.timing.length = 0;
    this.voices.length = 0;
    if (record) this.meterNode.port.postMessage('record');
    this.meterStart = c.currentTime;
    return true;
  }

  /** The meter's levels since `meter()` (null without one). */
  meterStats(): Promise<MeterStats | null> {
    const node = this.meterNode;
    const c = this.ctx;
    if (node === null || c === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      node.port.onmessage = (e: MessageEvent<{ s: { peak: number; over: number; sq: number }[]; n: number[]; rec: Float32Array | null }>) => {
        const { s, n, rec } = e.data;
        const lvl = (k: number): { peak: number; over: number; rms: number } => ({ peak: (s[k] as { peak: number }).peak, over: (s[k] as { over: number }).over, rms: Math.sqrt((s[k] as { sq: number }).sq / Math.max(1, n[k] as number)) });
        resolve({ seconds: c.currentTime - this.meterStart, pre: lvl(0), post: lvl(1), ...(rec === null ? {} : { rec }) });
      };
      node.port.postMessage('get');
    });
  }

  /** The context's clock (0 before start). */
  now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Sample rate of the context (0 before start). */
  rate(): number {
    return this.ctx?.sampleRate ?? 0;
  }

  /** The context's output latency and base latency (seconds; 0 when the browser doesn't say). */
  latency(): { base: number; output: number } {
    const c = this.ctx;
    return { base: c?.baseLatency ?? 0, output: c?.outputLatency ?? 0 };
  }
}
