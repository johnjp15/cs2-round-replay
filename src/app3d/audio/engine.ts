/**
 * A1: the Web Audio engine (docs/cs2-sounds.md). Created on the first user gesture (browsers keep an AudioContext
 * suspended until then). Implements the director's `SoundSink`.
 *
 * Graph: voice (AudioBufferSource → low-pass (occlusion) → gain (CS2 distance curve × occlusion × event volume) →
 * PannerNode (HRTF) for world sounds) → bus (CS2 mixgroups, events.ts BUSES) → effects / music → master →
 * compressor (a limiter, so a full spray doesn't clip) → speakers. The listener sits at the camera, facing the view.
 * The panner only gives direction (rolloffFactor 0): the loudness by distance is the CS2 event's own curve
 * (spatial.ts), re-evaluated every frame as the listener and the emitter move; occlusion traces the 4 rays on the
 * collision mesh every 0.1 s per voice.
 *
 * Buffers: the real CS2 files from the packed bank (bank.ts) when present, else the placeholders (synth.ts). Voices
 * are pooled (no per-frame allocation; one AudioBufferSourceNode per sound, which Web Audio requires).
 */
import manifestJson from '../../../data/audio/cs2-sound-events.json';
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
}
const MANIFEST = manifestJson as unknown as { readonly events: Readonly<Record<string, ManifestEventLite>> };

/** One layer of a sound: a CS2 event (its curve, volume, occlusion) and the buffers it picks from. */
interface Layer {
  readonly ev: ManifestEventLite;
  buffers: AudioBuffer[];
  /** True when the buffers are Valve's files (else placeholders). */
  real: boolean;
  /** Placeholder only: low-pass for a child layer (the distant layer). */
  readonly childLowpass: number;
}

interface Voice {
  readonly gain: GainNode;
  readonly filter: BiquadFilterNode;
  readonly panner: PannerNode | null;
  src: AudioBufferSourceNode | null;
  layer: Layer | null;
  bus: Bus;
  readonly pos: P3;
  /** Gain apart from the distance curve: event volume × random × cue gain. */
  base: number;
  blocked: number;
  nextOcclusion: number;
  endAt: number;
  startedAt: number;
  loopKey: string | null;
}

export interface AudioSettings {
  master: number;
  effects: number;
  music: number;
}

export interface AudioWorld {
  lineBlocked(a: P3, b: P3): boolean;
}

const SETTINGS_KEY = 'cs2-sim3d-audio';
const EMPTY_LAYER: Layer[] = [];

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export class AudioEngine implements SoundSink {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private effectsGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private readonly buses = new Map<Bus, GainNode>();
  private readonly layers = new Map<string, Layer[]>();
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
  private starting: Promise<void> | null = null;

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
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.knee.value = 6;
    comp.ratio.value = 12;
    comp.attack.value = 0.002;
    comp.release.value = 0.15;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(comp);
    this.effectsGain = ctx.createGain();
    this.musicGain = ctx.createGain();
    this.effectsGain.connect(this.master);
    this.musicGain.connect(this.master);
    for (const b of BUSES) {
      const g = ctx.createGain();
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
      return { gain, filter, panner, src: null, layer: null, bus: 'weapons', pos: { x: 0, y: 0, z: 0 }, base: 0, blocked: 0, nextOcclusion: 0, endAt: 0, startedAt: 0, loopKey: null };
    };
    const n = AUDIO_TUNING.maxVoices;
    this.world = Array.from({ length: n }, () => mk(true));
    this.local = Array.from({ length: Math.max(8, n >> 2) }, () => mk(false));
    this.buildPlaceholders(ctx);
    if (ctx.state === 'suspended') await ctx.resume();
    await this.loadBank(ctx);
  }

  private buildPlaceholders(ctx: AudioContext): void {
    const rate = AUDIO_TUNING.placeholderRate;
    for (const id of SOUND_IDS) {
      const def = SOUNDS[id] as SoundDef;
      const pcm = renderSynth(def.synth, id, rate);
      const buf = ctx.createBuffer(1, pcm.length, rate);
      buf.copyToChannel(pcm, 0);
      const layers: Layer[] = [];
      const add = (name: string, child: boolean): void => {
        const ev = MANIFEST.events[name];
        if (ev === undefined) return;
        layers.push({ ev, buffers: [buf], real: false, childLowpass: child ? 2500 : AUDIO_TUNING.occlusion.openLowpassHz });
        if (!child) for (const c of ev.children) add(c, true);
      };
      for (const name of def.cs2) add(name, false);
      if (layers.length === 0) layers.push({ ev: { files: [], volume: 1, pitch: 1, pitchRandom: [0, 0], volumeRandom: [0, 0], delay: 0, curve: [], occlusion: 0, offset: [0, 0, 0], children: [] }, buffers: [buf], real: false, childLowpass: 20000 });
      this.layers.set(id, layers);
    }
  }

  /** Decode the packed CS2 files (if the build has the bank) and put them in place of the placeholders. */
  private async loadBank(ctx: AudioContext): Promise<void> {
    const files = bankFiles();
    if (files === null) return;
    const decoded = new Map<string, AudioBuffer>();
    for (const [path, b64] of Object.entries(files)) {
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        decoded.set(path, await ctx.decodeAudioData(bytes.buffer));
      } catch {
        // This browser can't decode it (e.g. an old Safari and Opus): that event keeps its placeholder.
      }
    }
    this.realFiles = decoded.size;
    for (const layers of this.layers.values()) {
      for (const l of layers) {
        const bufs = l.ev.files.map((f) => decoded.get(f)).filter((b): b is AudioBuffer => b !== undefined);
        if (bufs.length > 0) {
          l.buffers = bufs;
          l.real = true;
        }
      }
      // A child layer without its own real files would replay the parent's placeholder: once the parent is real, drop it.
      const parentReal = layers[0]?.real === true;
      if (parentReal) for (const l of layers) if (!l.real) l.buffers = [];
    }
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

  /** The listener at the camera (Source position, yaw, pitch in degrees). Call once per frame. */
  setListener(eye: Vec3, yaw: number, pitch: number): void {
    this.ear.x = eye.x;
    this.ear.y = eye.y;
    this.ear.z = eye.z;
    const c = this.ctx;
    if (c === null) return;
    const l = c.listener;
    const [x, y, z] = toThree(eye.x, eye.y, eye.z);
    const yr = (yaw * Math.PI) / 180;
    const pr = (pitch * Math.PI) / 180;
    const [fx, fy, fz] = toThree(Math.cos(pr) * Math.cos(yr), Math.cos(pr) * Math.sin(yr), -Math.sin(pr));
    const [ux, uy, uz] = toThree(Math.sin(pr) * Math.cos(yr), Math.sin(pr) * Math.sin(yr), Math.cos(pr));
    if (l.positionX !== undefined) {
      const t = c.currentTime;
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

  private pick(pool: Voice[], now: number): Voice {
    let best = pool[0] as Voice;
    for (const v of pool) {
      if (v.src === null || now >= v.endAt) return v;
      if (v.loopKey === null && v.startedAt < best.startedAt) best = v;
    }
    this.release(best);
    return best;
  }

  private release(v: Voice): void {
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
  }

  play(id: string, pos: Vec3 | null, opts: CueOptions = {}, loopKey: string | null = null): void {
    const c = this.ctx;
    if (c === null || c.state !== 'running') return;
    const def = SOUNDS[id];
    if (def === undefined) return;
    const layers = this.layers.get(id) ?? EMPTY_LAYER;
    const now = c.currentTime;
    const local = def.space === 'local' || pos === null || opts.self === true;
    for (const layer of layers) {
      if (layer.buffers.length === 0) continue;
      const ev = layer.ev;
      const buf = layer.buffers[Math.floor(this.rnd() * layer.buffers.length)] as AudioBuffer;
      const v = this.pick(local ? this.local : this.world, now);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = def.loop === true && loopKey !== null;
      const pr = ev.pitchRandom;
      src.playbackRate.value = ev.pitch * (1 + ((pr[0] ?? 0) + ((pr[1] ?? 0) - (pr[0] ?? 0)) * this.rnd()) * (this.rnd() < 0.5 ? -1 : 1));
      src.connect(v.filter);
      const vr = ev.volumeRandom;
      v.base = ev.volume * (1 - ((vr[0] ?? 0) + ((vr[1] ?? 0) - (vr[0] ?? 0)) * this.rnd())) * (opts.gain ?? 1);
      v.layer = layer;
      v.bus = def.bus;
      v.loopKey = loopKey;
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
      // Own sounds sit at the curve's nearest point; world sounds start at their gain now (update() follows them).
      const g = local ? v.base * distanceGain(1, ev.curve, 0) : this.voiceGain(v, now);
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(g, now);
      v.filter.frequency.setValueAtTime(local ? layer.childLowpass : Math.min(layer.childLowpass, v.filter.frequency.value), now);
      if (v.panner !== null) this.place(v.panner, v.pos, now);
      const when = now + Math.max(0, ev.delay);
      src.start(when);
      v.src = src;
      v.startedAt = now;
      v.endAt = src.loop ? Infinity : when + buf.duration / Math.max(0.01, src.playbackRate.value) + 0.05;
      if (local && v.panner === null) v.loopKey = loopKey;
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
    return v.base * curve * occ.gain;
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
      v.gain.gain.setTargetAtTime(this.voiceGain(v, now), now, AUDIO_TUNING.smoothSec);
    }
    for (const v of this.local) if (v.src !== null && now >= v.endAt) this.release(v);
  }

  /** Voices playing now (stats). */
  playing(): number {
    let n = 0;
    for (const v of this.world) if (v.src !== null) n++;
    for (const v of this.local) if (v.src !== null) n++;
    return n;
  }
}
