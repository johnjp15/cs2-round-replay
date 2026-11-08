/**
 * A1: sound and the first-person weapon, mounted on the 3D app with three calls from main.ts (docs/cs2-sounds.md,
 * docs/app3d.md "Viewmodels"):
 *
 *   const a1 = new A1Mount(world, tuning, bar);    // once: the audio engine (started on the first click / key),
 *                                                  // the director, the viewmodel tracker, the volume sliders
 *   a1.tick(observe, host, human, speed);          // after every simulated tick (speed: the playback speed)
 *   a1.input(humanInput, pawn, tick);              // every frame while playing (button edges: dry fire, knife...)
 *   const vm = a1.frame({...});                    // every drawn frame: the listener at the camera, the VmAnim
 *
 * `window.__cs2a1` exposes the state for the browser check (audio started, cues scheduled, the viewmodel's phase).
 */
import type { Observe, PawnInput, PawnObs, PlayerId, Team, Tuning, Vec3 } from '../../contracts/index';
import type { Effect } from '../../app/effects';
import { SoundDirector, type Bullet, type CueRecord } from './director';
import { AudioEngine, type AudioSettings, type AudioWorld, type MeterStats, type VoiceRecord } from './engine';
import { AUDIO_TUNING } from './tuning';
import { hasBank } from './bank';
import { VmTracker, readTimers } from '../viewmodels/tracker';
import type { VmAnim } from '../viewmodels/pose';
import { gunOf } from './events';

/** The host calls the mount uses (Sim3DHost has them all). */
export interface A1Host {
  shots(): readonly Bullet[];
  activeEffects(): readonly Effect[];
  pawnState(id: PlayerId): { readonly wpn: unknown } | null;
  /** W1: the knife attacks of the last tick (Sim3DHost.swings). */
  swings?(): readonly { readonly attacker: PlayerId; readonly attack: 'slash' | 'stab'; readonly wall: boolean }[];
}

export interface A1Frame {
  readonly eye: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  /** Whose ears (first person / followed pawn), or null (free camera). */
  readonly listener: PlayerId | null;
  /** The pawn drawn in first person with its viewmodel, or null. */
  readonly firstPerson: PawnObs | null;
  /** Render tick (fractional) of this frame. */
  readonly renderTick: number;
  /** The human's scope level (0 = unscoped). */
  readonly zoom: number;
  readonly nowMs: number;
}

export interface A1Stats {
  readonly audio: {
    readonly state: string;
    readonly started: number;
    readonly playing: number;
    readonly lastIds: readonly string[];
    readonly realFiles: number;
    readonly bank: boolean;
    readonly settings: AudioSettings;
    /** A2: sample rate, cues skipped (silent), instances faded by CS2's instance_limit, cues scheduled late, paused. */
    readonly rate: number;
    readonly skipped: number;
    readonly limited: number;
    readonly late: number;
    readonly culled: number;
    readonly held: boolean;
  };
  readonly cues: { readonly played: number; readonly recent: readonly { tick: number; id: string }[] };
  readonly viewmodel: { weapon: string; phase: string; progress: number; visible: boolean } | null;
  readonly anim: { readonly weapon: string; readonly reloadSec: number | null; readonly deploySec: number | null } | null;
}

declare global {
  interface Window {
    __cs2a1?: {
      stats: () => A1Stats;
      start: () => Promise<void>;
      volume: (k: keyof AudioSettings, v: number) => void;
      /** Screenshots: hold `weapon` in first person in a fixed pose (null: back to the game's). */
      preview: (p: VmPreview | null) => void;
      /** A2: every cue since the director's last reset (seek / rewind), optionally within [from, to] ticks. */
      cues: (from?: number, to?: number) => CueRecord[];
      /** A2: start the level meter before / after the limiter (`record`: keep the output). */
      meter: (record?: boolean) => Promise<boolean>;
      meterStats: () => Promise<MeterStats | null>;
      /** A2: while metering, each tick-bound cue's audio start time and its lead over its arrival (seconds). */
      timing: () => { tick: number; id: string; source: string | null; at: number; lead: number }[];
      latency: () => { base: number; output: number };
      /** A2: while metering, every voice started (event, source, distance, gain, start / end in audio time). */
      voices: () => VoiceRecord[];
      /** A2: render a sound 200 u to the listener's right offline: { left, right } RMS (right must win). */
      probeLR: (yaw?: number) => Promise<{ left: number; right: number }>;
      now: () => number;
    };
  }
}

const USE_KEYPRESS_SEC = 0.45;

/** A fixed viewmodel pose for screenshots (the browser check's gallery). */
export interface VmPreview {
  readonly weapon: string;
  readonly sinceShot?: number;
  readonly reload?: { readonly t: number; readonly dur: number };
  readonly swing?: number;
  readonly primed?: boolean;
  readonly plant?: number;
}

export class A1Mount {
  readonly audio: AudioEngine;
  readonly director: SoundDirector;
  private readonly tracker = new VmTracker();
  private listener: PlayerId | null = null;
  private fpId: PlayerId | null = null;
  private ear: Vec3 = { x: 0, y: 0, z: 0 };
  private prevButtons = new Set<string>();
  private lastZoom = 0;
  private nextKeypress = 0;
  private lastAnim: VmAnim | null = null;
  private preview: VmPreview | null = null;
  /** The viewmodel rig's last pose (the renderer sets it). */
  vmState: () => A1Stats['viewmodel'] = () => null;

  private lastTickMs = 0;
  private held = false;

  constructor(
    world: AudioWorld | null,
    private readonly tuning: Pick<Tuning, 'weapons' | 'bomb'>,
    bar: HTMLElement | null,
  ) {
    this.audio = new AudioEngine(world);
    this.director = new SoundDirector(this.audio, undefined, tuning.bomb.timerSec);
    this.audio.attachGesture(document);
    if (bar !== null) this.sliders(bar);
    window.__cs2a1 = {
      stats: () => this.stats(),
      start: () => this.audio.start(),
      volume: (k, v) => this.audio.setVolume(k, v),
      preview: (p) => {
        this.preview = p;
      },
      cues: (from = -Infinity, to = Infinity) => this.director.log.filter((c) => c.tick >= from && c.tick <= to),
      meter: (record = false) => this.audio.meter(record),
      meterStats: () => this.audio.meterStats(),
      timing: () => [...this.audio.timing],
      latency: () => this.audio.latency(),
      voices: () => this.audio.voices.map((v) => ({ ...v })),
      probeLR: (yaw) => this.audio.probeLR(yaw),
      now: () => this.audio.now(),
    };
  }

  private sliders(bar: HTMLElement): void {
    const box = document.createElement('span');
    box.className = 'a1-volume';
    box.style.cssText = 'display:inline-flex;gap:6px;align-items:center';
    const sep = document.createElement('span');
    sep.className = 'sep';
    bar.insertBefore(sep, bar.querySelector('.help'));
    bar.insertBefore(box, bar.querySelector('.help'));
    const titles: Record<keyof AudioSettings, string> = {
      master: 'CS2 volume (master). Sound starts with your first click or key.',
      effects: 'Game sounds: guns, footsteps, grenades, the bomb.',
      music: 'CS2 music kit (round end, bomb planted) and the announcer, at CS2’s snd_* levels.',
    };
    for (const k of ['master', 'effects', 'music'] as const) {
      const label = document.createElement('label');
      label.title = titles[k];
      label.textContent = k === 'master' ? 'Vol ' : k === 'effects' ? 'FX ' : 'Music ';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '1';
      input.step = '0.05';
      input.value = String(this.audio.settings[k]);
      input.id = `set-${k}-volume`;
      input.style.width = '64px';
      input.addEventListener('input', () => this.audio.setVolume(k, Number(input.value)));
      label.appendChild(input);
      box.appendChild(label);
    }
  }

  private cycleSec(weapon: string): number {
    const w = this.tuning.weapons[weapon];
    return w === undefined ? 0.15 : 60 / w.rpm;
  }

  /** After every simulated tick. `speed`: the playback speed (the engine spaces the tick's cues by it). */
  tick(o: Observe, host: A1Host, human: PlayerId | null, speed = 1): void {
    this.audio.setSpeed(speed);
    this.lastTickMs = performance.now();
    if (this.held) {
      this.held = false;
      this.audio.hold(false);
    }
    const shots = host.shots();
    const effects = host.activeEffects();
    const fp = this.fpId;
    // Weapon timers of the first-person pawn (reload length for the sounds and the animation).
    const timers = fp === null ? null : readTimers(host.pawnState(fp)?.wpn ?? null);
    this.director.ingest({
      observe: o,
      bullets: shots,
      effects,
      listener: this.listener,
      ear: this.ear,
      reloadSec: (id) => {
        const t = id === fp ? timers : readTimers(host.pawnState(id)?.wpn ?? null);
        // The reload started while the host simulated tick o.tick − 1.
        return t === null || t.reloadEndTick === null ? null : Math.max(0, (t.reloadEndTick - (o.tick - 1)) / 64);
      },
      cycleSec: (w) => this.cycleSec(w),
    });
    if (fp !== null) {
      const p = o.pawns.find((q) => q.id === fp);
      if (p !== undefined) {
        const shot = o.events.some((e) => e.type === 'shot' && e.shooter === fp);
        const thrown = effects.some((e) => e.thrower === fp && e.phase === 'flying' && e.untilTick > o.tick && !this.knownNade(e.seq));
        const r = this.tracker.ingest(o.tick, p, timers, shot, thrown);
        if (r.primed && fp === human) this.director.human('pin', p.weapon, p.pos);
        // W1: the knife swings as the host swung it (slash / stab, on CS's timers); the hit sound is the damage event's.
        for (const w of host.swings?.() ?? []) {
          if (w.attacker !== fp) continue;
          this.tracker.swing(o.tick - 1, w.attack);
          this.director.human('knife', p.weapon, p.pos);
          if (w.wall) this.director.human('knifeWall', p.weapon, p.pos);
        }
      }
    } else this.tracker.reset();
  }

  private readonly nades = new Set<number>();
  private knownNade(seq: number): boolean {
    if (this.nades.has(seq)) return true;
    this.nades.add(seq);
    if (this.nades.size > 64) this.nades.delete(this.nades.values().next().value as number);
    return false;
  }

  /** Every frame while the human plays: button edges the host has no event for. */
  input(inp: PawnInput | null, pawn: PawnObs | null, tick: number, bombPlanted: boolean): void {
    if (inp === null || pawn === null || !pawn.alive) {
      this.prevButtons.clear();
      this.tracker.plant(null);
      return;
    }
    const now = new Set<string>(inp.buttons);
    const pressed = (b: string): boolean => now.has(b) && !this.prevButtons.has(b);
    const w = pawn.weapon;
    if (pressed('ATTACK')) {
      // The knife's swings come from the host (tick()).
      if (gunOf(w) !== null && pawn.ammo.clip === 0) this.director.human('dry', w, pawn.pos);
    }
    if (w === 'c4' && !bombPlanted && (now.has('USE') || now.has('ATTACK'))) {
      if (pressed('USE') || pressed('ATTACK')) {
        this.director.human('plantStart', w, pawn.pos);
        this.nextKeypress = tick + USE_KEYPRESS_SEC * 64;
      } else if (tick >= this.nextKeypress) {
        this.director.human('keypress', w, pawn.pos);
        this.nextKeypress = tick + USE_KEYPRESS_SEC * 64;
      }
      this.tracker.plant(tick);
    } else this.tracker.plant(null);
    this.prevButtons = now;
  }

  /** W1: F (+lookatweapon): inspect the first-person weapon from `tick` (not while it is being drawn). */
  inspect(tick: number, nowRenderTick: number): boolean {
    const a = this.tracker.anim(nowRenderTick, 0.1, 0, 0);
    if (a === null || a.deploy !== null || a.reload !== null || a.primed) return false;
    this.tracker.inspect(tick);
    return true;
  }

  /** W1: stop an inspect (scope in, takeover). */
  cancelInspect(): void {
    this.tracker.cancelInspect();
  }

  /** Every drawn frame: the listener and the viewmodel's animation input. */
  frame(f: A1Frame): VmAnim | null {
    this.listener = f.listener;
    this.fpId = f.firstPerson?.id ?? null;
    this.ear = f.eye;
    this.audio.setListener(f.eye, f.yaw, f.pitch);
    // Paused (no tick for a while): loops fade out until the next tick.
    if (!this.held && this.lastTickMs > 0 && performance.now() - this.lastTickMs > AUDIO_TUNING.pauseAfterSec * 1000) {
      this.held = true;
      this.audio.hold(true);
    }
    this.audio.update();
    if (f.zoom !== this.lastZoom && f.firstPerson !== null) this.director.human(f.zoom > this.lastZoom ? 'zoomIn' : 'zoomOut', f.firstPerson.weapon, f.firstPerson.pos);
    this.lastZoom = f.zoom;
    const p = f.firstPerson;
    if (p === null) {
      this.lastAnim = null;
      return null;
    }
    const pv = this.preview;
    if (pv !== null) {
      this.lastAnim = { weapon: pv.weapon, sinceShot: pv.sinceShot ?? 1e6, cycle: this.cycleSec(pv.weapon), reload: pv.reload ?? null, deploy: null, swing: pv.swing ?? null, plant: pv.plant ?? null, primed: pv.primed ?? false, thrown: null, speed: 0, time: 0 };
      return this.lastAnim;
    }
    const speed = Math.hypot(p.vel.x, p.vel.y) / 250;
    this.lastAnim = this.tracker.anim(f.renderTick, this.cycleSec(p.weapon), p.onGround ? speed : 0, f.nowMs / 1000);
    return this.lastAnim;
  }

  /** Team colour of the first-person sleeves. */
  static team(p: PawnObs | null): Team {
    return p?.team ?? 'CT';
  }

  stats(): A1Stats {
    const a = this.lastAnim;
    return {
      audio: {
        state: this.audio.state(),
        started: this.audio.started,
        playing: this.audio.playing(),
        lastIds: [...this.audio.lastIds],
        realFiles: this.audio.realFiles,
        bank: hasBank(),
        settings: { ...this.audio.settings },
        rate: this.audio.rate(),
        skipped: this.audio.skipped,
        limited: this.audio.limited,
        late: this.audio.late,
        culled: this.audio.culled,
        held: this.held,
      },
      cues: { played: this.director.played, recent: [...this.director.recent] },
      viewmodel: this.vmState(),
      anim: a === null ? null : { weapon: a.weapon, reloadSec: a.reload?.dur ?? null, deploySec: a.deploy?.dur ?? null },
    };
  }
}
