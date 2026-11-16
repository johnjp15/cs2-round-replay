/**
 * The 2D replay's canvas engine: draws one round's `ReplayTrack` on the map pack's radar, interpolating between the
 * 16 Hz samples, with players (side colour, name, health ring, weapon, view cone, bomb and kit marks, dead crosses),
 * shots, hits, kill lines, grenades in flight, smokes, fires, flashes, HE, the bomb and its countdown, defuses, and the
 * annotation layer of an evidence moment. Also draws the timeline (phases, event and finding markers, playhead).
 *
 * Imperative and allocation-light so it holds 60 fps: one requestAnimationFrame loop that draws only while playing or
 * after a change, and a HUD callback throttled to `HUD_MS` so the DOM around the canvas updates a few times a second.
 */
import type { Annotation, ColorRole, Evidence, ReplayTrack } from '../../coach/model/report';
import { REPLAY_ABSENT, REPLAY_FLAG } from '../../coach/model/report';
import { BOMB_SEC, DEFUSE_KIT_SEC, DEFUSE_SEC, ROUND_SEC } from '../config';
import type { MapView } from '../maps';
import { clock, weaponName } from '../names';

const HUD_MS = 250;
/** Drawing sizes in CSS pixels, world sizes in Source units. */
const DRAW = {
  marker: 6.5,
  cone: 34,
  coneHalfDeg: 22,
  label: 11,
  tracerSec: 0.09,
  tracerLen: 380,
  hitSec: 0.3,
  killLineSec: 2.5,
  deathFadeSec: 3,
  smokeRadius: 144,
  fireRadius: 120,
  heRadius: 300,
  flashRadius: 160,
  feedSec: 6,
} as const;

export interface FeedKill {
  tick: number;
  attacker: number;
  victim: number;
  assister: number;
  weapon: string;
  headshot: boolean;
  wallbang: boolean;
  smoke: boolean;
  noScope: boolean;
}

export interface HudPlayer {
  slot: number;
  side: number;
  alive: boolean;
  health: number;
  weapon: string;
  place: string;
  bomb: boolean;
  kit: boolean;
}

export interface HudState {
  round: number;
  tick: number;
  playing: boolean;
  speed: number;
  phase: 'freeze' | 'live' | 'planted' | 'over';
  clock: string;
  feed: FeedKill[];
  players: HudPlayer[];
  level: 'upper' | 'lower' | null;
}

export interface Marker {
  tick: number;
  label: string;
}

interface Colors {
  bg: string; ct: string; t: string; accent: string; good: string; bad: string; text: string; dim: string; line: string;
  smoke: string; fire: string; flash: string;
}

function cssColors(el: Element): Colors {
  const s = getComputedStyle(el);
  const v = (n: string, d: string): string => s.getPropertyValue(n).trim() || d;
  return {
    bg: v('--bg', '#111'), ct: v('--ct', '#5b9bd5'), t: v('--t', '#e0a63b'), accent: v('--accent', '#c69cff'),
    good: v('--good', '#7bd88f'), bad: v('--bad', '#e5685d'), text: v('--text', '#e6e8ec'), dim: v('--text-dim', '#9aa1ad'),
    line: v('--border', '#2a2f3a'), smoke: v('--smoke', '#c9cdd4'), fire: v('--fire', '#f07a3a'), flash: v('--flash', '#ffffff'),
  };
}

function lerpAngle(a: number, b: number, f: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return a + d * f;
}

const RAD = Math.PI / 180;

export interface EngineStats {
  frames: number;
  /** Sum and max of the draw time (ms) of the frames drawn while playing. */
  drawMs: number;
  maxDrawMs: number;
  /** Mean interval between frames while playing (ms). */
  intervalMs: number;
  intervals: number;
}

export class ReplayEngine {
  private ctx: CanvasRenderingContext2D;
  private tctx: CanvasRenderingContext2D;
  private colors: Colors;
  private raf = 0;
  private lastTime = -1;
  private lastHud = -1e9;
  private dirty = true;
  private size = 512;
  private dpr = 1;
  private tlW = 600;
  private tlH = 44;
  private ro: ResizeObserver;
  private deaths: ({ tick: number; x: number; y: number; z: number } | null)[] = [];
  /** Per grenade of the track: the tick it stopped moving (a smoke or a molotov lies there for its effect's life). */
  private landed: number[] = [];
  private names: string[];
  private scrubbing = false;

  track: ReplayTrack | null = null;
  map: MapView | null = null;
  tick = 0;
  playing = false;
  speed = 1;
  stopAt: number | null = null;
  evidence: Evidence | null = null;
  markers: Marker[] = [];
  level: 'auto' | 'upper' | 'lower' = 'auto';
  readonly stats: EngineStats = { frames: 0, drawMs: 0, maxDrawMs: 0, intervalMs: 0, intervals: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly timeline: HTMLCanvasElement,
    names: string[],
    private readonly user: number,
    private readonly onHud: (h: HudState) => void,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    const tctx = timeline.getContext('2d');
    if (!ctx || !tctx) throw new Error('canvas 2D is not available');
    this.ctx = ctx;
    this.tctx = tctx;
    this.names = names;
    this.colors = cssColors(canvas);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement ?? canvas);
    this.ro.observe(timeline);
    this.resize();
    timeline.addEventListener('pointerdown', this.onPointer);
    timeline.addEventListener('pointermove', this.onPointer);
    timeline.addEventListener('pointerup', this.onPointerUp);
    timeline.addEventListener('pointercancel', this.onPointerUp);
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.timeline.removeEventListener('pointerdown', this.onPointer);
    this.timeline.removeEventListener('pointermove', this.onPointer);
    this.timeline.removeEventListener('pointerup', this.onPointerUp);
    this.timeline.removeEventListener('pointercancel', this.onPointerUp);
  }

  // ------------------------------------------------------------------ control

  get tick0(): number { return this.track?.tick0 ?? 0; }
  get tick1(): number { return this.track ? this.track.tick0 + (this.track.samples - 1) * this.track.step : 0; }
  private get rate(): number { return this.track ? this.track.hz * this.track.step : 64; }

  setMap(map: MapView): void {
    this.map = map;
    this.invalidate();
  }

  setTrack(track: ReplayTrack, tick?: number): void {
    this.track = track;
    this.deaths = this.computeDeaths(track);
    this.landed = track.events.grenades.map((g) => {
      const n = Math.floor(g.path.length / 3);
      const lx = g.path[(n - 1) * 3] ?? 0;
      const ly = g.path[(n - 1) * 3 + 1] ?? 0;
      let i = n - 1;
      while (i > 0) {
        const x = g.path[(i - 1) * 3] ?? REPLAY_ABSENT;
        if (x !== REPLAY_ABSENT && Math.abs(x - lx) + Math.abs((g.path[(i - 1) * 3 + 1] ?? 0) - ly) > 2) break;
        i--;
      }
      return g.t0 + i * g.step;
    });
    this.seek(tick ?? track.phases.freezeEnd ?? track.tick0);
    this.emitHud(true);
  }

  setEvidence(ev: Evidence | null, rate: number): void {
    this.evidence = ev;
    if (ev) {
      this.speed = 1;
      this.stopAt = ev.tick1;
      this.seek(ev.focus - 5 * rate);
      this.playing = true;
    } else {
      this.stopAt = null;
    }
    this.invalidate();
    this.emitHud(true);
  }

  setMarkers(m: Marker[]): void {
    this.markers = m;
    this.invalidate();
  }

  seek(tick: number): void {
    this.tick = Math.max(this.tick0, Math.min(this.tick1, tick));
    this.lastTime = -1;
    this.invalidate();
    this.emitHud(true);
  }

  play(on: boolean = !this.playing): void {
    if (on && this.tick >= this.tick1) this.seek(this.track?.phases.freezeEnd ?? this.tick0);
    if (on && this.stopAt !== null && this.tick >= this.stopAt) this.stopAt = null;
    this.playing = on;
    this.lastTime = -1;
    this.invalidate();
    this.emitHud(true);
  }

  setSpeed(s: number): void {
    this.speed = s;
    this.emitHud(true);
  }

  setLevel(l: 'auto' | 'upper' | 'lower'): void {
    this.level = l;
    this.invalidate();
  }

  /** Jump to the previous / next kill of the round (dir −1 / +1). */
  jumpKill(dir: -1 | 1): void {
    const ks = this.track?.events.kills ?? [];
    const lead = Math.round(1.5 * this.rate);
    if (dir > 0) {
      const k = ks.find((x) => x.tick - lead > this.tick + 1);
      if (k) this.seek(k.tick - lead);
    } else {
      const prev = ks.filter((x) => x.tick - lead < this.tick - 2);
      const k = prev[prev.length - 1];
      this.seek(k ? k.tick - lead : this.tick0);
    }
  }

  invalidate(): void {
    this.dirty = true;
  }

  // ------------------------------------------------------------------ loop

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    if (this.playing && this.track) {
      if (this.lastTime >= 0) {
        const dt = Math.min(100, now - this.lastTime);
        this.stats.intervalMs += dt;
        this.stats.intervals++;
        this.tick += (dt / 1000) * this.rate * this.speed;
        if (this.stopAt !== null && this.tick >= this.stopAt) { this.tick = this.stopAt; this.playing = false; this.stopAt = null; this.emitHud(true); }
        if (this.tick >= this.tick1) { this.tick = this.tick1; this.playing = false; this.emitHud(true); }
      }
      this.lastTime = now;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const t0 = performance.now();
    this.draw();
    this.drawTimeline();
    const ms = performance.now() - t0;
    if (this.playing) {
      this.stats.frames++;
      this.stats.drawMs += ms;
      this.stats.maxDrawMs = Math.max(this.stats.maxDrawMs, ms);
    }
    if (now - this.lastHud >= HUD_MS) this.emitHud(false, now);
  };

  private resize(): void {
    const parent = this.canvas.parentElement;
    const w = parent ? parent.clientWidth : 512;
    const size = Math.max(200, Math.floor(w));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.size = size;
    this.canvas.width = Math.round(size * this.dpr);
    this.canvas.height = Math.round(size * this.dpr);
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.tlW = Math.max(200, this.timeline.clientWidth || size);
    this.tlH = this.timeline.clientHeight || 44;
    this.timeline.width = Math.round(this.tlW * this.dpr);
    this.timeline.height = Math.round(this.tlH * this.dpr);
    this.invalidate();
  }

  // ------------------------------------------------------------------ samples

  private computeDeaths(t: ReplayTrack): ({ tick: number; x: number; y: number; z: number } | null)[] {
    const out: ({ tick: number; x: number; y: number; z: number } | null)[] = [];
    for (let p = 0; p < t.players; p++) {
      const k = [...t.events.kills].reverse().find((x) => x.victim === p);
      if (k && k.vx !== REPLAY_ABSENT) { out.push({ tick: k.tick, x: k.vx, y: k.vy, z: k.vz }); continue; }
      // Not killed by an event (or no position): the last alive sample before the player turned dead.
      let d: { tick: number; x: number; y: number; z: number } | null = null;
      for (let s = 1; s < t.samples; s++) {
        const a = (t.flags[(s - 1) * t.players + p] ?? 0) & REPLAY_FLAG.alive;
        const b = (t.flags[s * t.players + p] ?? 0) & REPLAY_FLAG.alive;
        if (a && !b) {
          const o = (s - 1) * t.players + p;
          d = { tick: t.tick0 + s * t.step, x: t.xy[o * 2] ?? 0, y: t.xy[o * 2 + 1] ?? 0, z: t.z[o] ?? 0 };
        }
      }
      out.push(d);
    }
    return out;
  }

  /** Interpolated state of slot p at the current tick into `out`; false when absent. */
  private sample(p: number, out: { x: number; y: number; z: number; yaw: number; k: number }): boolean {
    const t = this.track;
    if (!t) return false;
    const s = (this.tick - t.tick0) / t.step;
    const k0 = Math.max(0, Math.min(t.samples - 1, Math.floor(s)));
    const k1 = Math.min(t.samples - 1, k0 + 1);
    const f = Math.max(0, Math.min(1, s - k0));
    const o0 = k0 * t.players + p;
    const o1 = k1 * t.players + p;
    const x0 = t.xy[o0 * 2] ?? REPLAY_ABSENT;
    if (x0 === REPLAY_ABSENT) return false;
    const x1r = t.xy[o1 * 2] ?? REPLAY_ABSENT;
    const alive0 = ((t.flags[o0] ?? 0) & REPLAY_FLAG.alive) !== 0;
    const alive1 = ((t.flags[o1] ?? 0) & REPLAY_FLAG.alive) !== 0;
    const ok1 = x1r !== REPLAY_ABSENT && alive0 === alive1;
    const g = ok1 ? f : 0;
    out.x = x0 + ((ok1 ? x1r : x0) - x0) * g;
    const y0 = t.xy[o0 * 2 + 1] ?? 0;
    out.y = y0 + ((ok1 ? (t.xy[o1 * 2 + 1] ?? y0) : y0) - y0) * g;
    const z0 = t.z[o0] ?? 0;
    out.z = z0 + ((ok1 ? (t.z[o1] ?? z0) : z0) - z0) * g;
    out.yaw = lerpAngle(t.yaw[o0] ?? 0, ok1 ? (t.yaw[o1] ?? 0) : (t.yaw[o0] ?? 0), g);
    out.k = f < 0.5 ? k0 : k1;
    return true;
  }

  /** Position of slot p at an arbitrary tick (nearest sample), or null. */
  private posAt(p: number, tick: number): [number, number] | null {
    const t = this.track;
    if (!t || p < 0 || p >= t.players) return null;
    const k = Math.max(0, Math.min(t.samples - 1, Math.round((tick - t.tick0) / t.step)));
    const o = k * t.players + p;
    const x = t.xy[o * 2] ?? REPLAY_ABSENT;
    return x === REPLAY_ABSENT ? null : [x, t.xy[o * 2 + 1] ?? 0];
  }

  /** A world point in canvas device pixels (for checks). */
  toCanvas(x: number, y: number): [number, number] {
    const m = this.map;
    if (!m) return [0, 0];
    const k = (this.size * this.dpr) / m.view.size;
    return [((x - m.radar.pos_x) / m.radar.scale - m.view.x) * k, ((m.radar.pos_y - y) / m.radar.scale - m.view.y) * k];
  }

  private levelAt(z: number): 'upper' | 'lower' {
    const lb = this.map?.radar.lowerBelowZ ?? null;
    return lb !== null && z < lb ? 'lower' : 'upper';
  }

  /** The radar level shown: fixed, or (auto) the user's level. */
  shownLevel(): 'upper' | 'lower' | null {
    if (!this.map || this.map.radar.lowerBelowZ === null) return null;
    if (this.level !== 'auto') return this.level;
    const s = { x: 0, y: 0, z: 0, yaw: 0, k: 0 };
    if (this.user >= 0 && this.sample(this.user, s)) return this.levelAt(s.z);
    return 'upper';
  }

  private sideColor(side: number): string {
    return side === 2 ? this.colors.t : side === 3 ? this.colors.ct : this.colors.dim;
  }

  private roleColor(role: ColorRole): string {
    const c = this.colors;
    const t = this.track;
    const userSide = t ? (t.side[this.user] ?? 0) : 0;
    switch (role) {
      case 'user': case 'accent': return c.accent;
      case 'teammate': return this.sideColor(userSide);
      case 'enemy': return this.sideColor(userSide === 2 ? 3 : userSide === 3 ? 2 : 0);
      case 'ct': return c.ct;
      case 't': return c.t;
      case 'good': return c.good;
      case 'bad': return c.bad;
      default: return c.dim;
    }
  }

  // ------------------------------------------------------------------ drawing

  private draw(): void {
    const ctx = this.ctx;
    const c = this.colors;
    const map = this.map;
    const t = this.track;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!map) return;
    const r = map.radar;
    const v = map.view;
    const k = (this.size * this.dpr) / v.size;
    ctx.setTransform(k, 0, 0, k, -v.x * k, -v.y * k);
    const level = this.shownLevel();
    const img = level === 'lower' ? map.lower : map.upper;
    if (img) {
      ctx.globalAlpha = 0.92;
      ctx.drawImage(img, 0, 0, r.width, r.height);
      ctx.globalAlpha = 1;
    }
    if (!t) return;
    /** One CSS pixel in radar pixels. */
    const u = v.size / this.size;
    const W = (x: number, y: number): [number, number] => [(x - r.pos_x) / r.scale, (r.pos_y - y) / r.scale];
    const tick = this.tick;
    const rate = this.rate;
    const other = (z: number): boolean => level !== null && this.levelAt(z) !== level;
    const ev = t.events;

    // Smokes and fires (under everything).
    for (const e of ev.effects) {
      if (tick < e.tick0 || tick > e.tick1) continue;
      const age = (tick - e.tick0) / rate;
      const left = (e.tick1 - tick) / rate;
      const [px, py] = W(e.x, e.y);
      ctx.globalAlpha = other(e.z) ? 0.35 : 1;
      if (e.kind === 'smoke') {
        const grow = Math.min(1, age / 1.2);
        const fade = Math.min(1, left / 2);
        ctx.fillStyle = c.smoke;
        ctx.globalAlpha *= 0.62 * fade;
        ctx.beginPath();
        ctx.arc(px, py, (DRAW.smokeRadius / r.scale) * (0.35 + 0.65 * grow), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (e.kind === 'fire') {
        const fade = Math.min(1, left / 1.5, age / 0.4);
        ctx.fillStyle = c.fire;
        ctx.globalAlpha *= 0.38 * fade;
        ctx.beginPath();
        ctx.arc(px, py, (DRAW.fireRadius / r.scale) * (0.9 + 0.1 * Math.sin(tick * 0.4)), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha *= 1.6;
        ctx.strokeStyle = c.fire;
        ctx.lineWidth = 1.2 * u;
        ctx.stroke();
      } else if (e.kind === 'he') {
        const f = Math.min(1, age / ((e.tick1 - e.tick0) / rate || 1));
        ctx.strokeStyle = c.bad;
        ctx.lineWidth = 2.5 * u;
        ctx.globalAlpha *= 1 - f;
        ctx.beginPath();
        ctx.arc(px, py, (DRAW.heRadius / r.scale) * (0.3 + 0.7 * f), 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.kind === 'flash') {
        const f = Math.min(1, age / ((e.tick1 - e.tick0) / rate || 1));
        ctx.fillStyle = c.flash;
        ctx.globalAlpha *= 0.85 * (1 - f);
        ctx.beginPath();
        ctx.arc(px, py, (DRAW.flashRadius / r.scale) * (0.4 + 0.6 * f), 0, Math.PI * 2);
        ctx.fill();
      } else if (e.kind === 'decoy') {
        ctx.strokeStyle = c.dim;
        ctx.lineWidth = 1 * u;
        ctx.beginPath();
        ctx.arc(px, py, 4 * u, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Annotation zones under the players, the rest on top.
    const anns = this.evidence?.round === t.round ? this.evidence.annotations : [];
    for (const a of anns) if (a.kind === 'zone') this.drawAnnotation(a, W, u, tick);

    // Grenades in flight.
    ctx.lineWidth = 1.2 * u;
    for (let gi = 0; gi < ev.grenades.length; gi++) {
      const g = ev.grenades[gi];
      if (!g || tick < g.t0 || tick > Math.min(g.t1, (this.landed[gi] ?? g.t1) + rate / 2)) continue;
      const fi = (tick - g.t0) / g.step;
      const last = Math.floor(fi);
      const col = g.type === 'smoke' ? c.smoke : g.type === 'flashbang' ? c.flash : g.type === 'he_grenade' ? c.bad : g.type === 'molotov' ? c.fire : c.dim;
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      let started = false;
      let hx = 0;
      let hy = 0;
      let hz = 0;
      for (let i = 0; i <= last; i++) {
        const x = g.path[i * 3];
        if (x === undefined || x === REPLAY_ABSENT) continue;
        const [px, py] = W(x, g.path[i * 3 + 1] ?? 0);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        hx = x; hy = g.path[i * 3 + 1] ?? 0; hz = g.path[i * 3 + 2] ?? 0;
      }
      const nx = g.path[(last + 1) * 3];
      if (started && nx !== undefined && nx !== REPLAY_ABSENT) {
        const f = fi - last;
        hx += (nx - hx) * f;
        hy += ((g.path[(last + 1) * 3 + 1] ?? hy) - hy) * f;
        const [px, py] = W(hx, hy);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      if (started) {
        const [px, py] = W(hx, hy);
        ctx.globalAlpha = other(hz) ? 0.4 : 1;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(px, py, 2.6 * u, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Bomb: dropped, planted (with its countdown), defused.
    this.drawBomb(W, u, tick, rate);

    // Kill lines.
    for (const kl of ev.kills) {
      const age = (tick - kl.tick) / rate;
      if (age < 0 || age > DRAW.killLineSec || kl.ax === REPLAY_ABSENT || kl.vx === REPLAY_ABSENT) continue;
      const [ax, ay] = W(kl.ax, kl.ay);
      const [vx, vy] = W(kl.vx, kl.vy);
      ctx.globalAlpha = 1 - age / DRAW.killLineSec;
      ctx.strokeStyle = this.sideColor(t.side[kl.attacker] ?? 0);
      ctx.lineWidth = (kl.headshot ? 2.4 : 1.6) * u;
      ctx.setLineDash(kl.penetrated > 0 || kl.thruSmoke ? [5 * u, 4 * u] : []);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(vx, vy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;

    // Shots as short tracers; hits as a ring on the victim.
    for (const s of ev.shots) {
      const age = (tick - s.tick) / rate;
      if (age < 0 || age > DRAW.tracerSec || s.x === REPLAY_ABSENT) continue;
      const [px, py] = W(s.x, s.y);
      let ex: number;
      let ey: number;
      const hit = s.hit >= 0 ? this.posAt(s.hit, s.tick) : null;
      if (hit) [ex, ey] = W(hit[0], hit[1]);
      else { ex = px + Math.cos(s.yaw * RAD) * (DRAW.tracerLen / r.scale); ey = py - Math.sin(s.yaw * RAD) * (DRAW.tracerLen / r.scale); }
      const grad = ctx.createLinearGradient(px, py, ex, ey);
      grad.addColorStop(0, c.text);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = hit ? c.text : grad;
      ctx.globalAlpha = 0.85 * (1 - age / DRAW.tracerSec);
      ctx.lineWidth = 1 * u;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const h of ev.hurts) {
      const age = (tick - h.tick) / rate;
      if (age < 0 || age > DRAW.hitSec) continue;
      const pos = this.posAt(h.victim, h.tick);
      if (!pos) continue;
      const [px, py] = W(pos[0], pos[1]);
      ctx.strokeStyle = c.bad;
      ctx.globalAlpha = 1 - age / DRAW.hitSec;
      ctx.lineWidth = 2 * u;
      ctx.beginPath();
      ctx.arc(px, py, (DRAW.marker + 3 + 6 * (age / DRAW.hitSec)) * u, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Dead players: crosses at the death spot, fading to a faint mark.
    for (let p = 0; p < t.players; p++) {
      const d = this.deaths[p];
      if (!d || tick < d.tick) continue;
      const age = (tick - d.tick) / rate;
      const [px, py] = W(d.x, d.y);
      ctx.globalAlpha = (0.3 + 0.7 * Math.max(0, 1 - age / DRAW.deathFadeSec)) * (other(d.z) ? 0.5 : 1);
      ctx.strokeStyle = p === this.user ? c.accent : this.sideColor(t.side[p] ?? 0);
      ctx.lineWidth = 2 * u;
      const s = 4.5 * u;
      ctx.beginPath();
      ctx.moveTo(px - s, py - s); ctx.lineTo(px + s, py + s);
      ctx.moveTo(px + s, py - s); ctx.lineTo(px - s, py + s);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Living players.
    const st = { x: 0, y: 0, z: 0, yaw: 0, k: 0 };
    const focus = this.evidence?.round === t.round ? this.evidence.players : [];
    ctx.font = `600 ${DRAW.label * u}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    for (let pass = 0; pass < 2; pass++) {
      for (let p = 0; p < t.players; p++) {
        // The user last, on top.
        const isUser = p === this.user;
        if ((pass === 1) !== isUser) continue;
        if (!this.sample(p, st)) continue;
        const o = st.k * t.players + p;
        const fl = t.flags[o] ?? 0;
        if ((fl & REPLAY_FLAG.alive) === 0) continue;
        const side = t.side[p] ?? 0;
        const col = this.sideColor(side);
        const [px, py] = W(st.x, st.y);
        const off = other(st.z);
        ctx.globalAlpha = off ? 0.45 : 1;
        // View cone.
        const yaw = -st.yaw * RAD;
        const half = DRAW.coneHalfDeg * RAD;
        const cl = DRAW.cone * u;
        const cone = ctx.createRadialGradient(px, py, 0, px, py, cl);
        cone.addColorStop(0, col);
        cone.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = cone;
        ctx.globalAlpha = (off ? 0.45 : 1) * 0.45;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.arc(px, py, cl, yaw - half, yaw + half);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = off ? 0.45 : 1;
        // Focus ring for an evidence's players, the user's accent ring.
        if (focus.includes(p)) {
          ctx.strokeStyle = c.accent;
          ctx.lineWidth = 1.5 * u;
          ctx.setLineDash([3 * u, 3 * u]);
          ctx.beginPath();
          ctx.arc(px, py, (DRAW.marker + 8) * u, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // Body.
        const rad = DRAW.marker * u;
        ctx.fillStyle = (fl & REPLAY_FLAG.flashed) !== 0 ? c.flash : col;
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = off ? c.text : 'rgba(0,0,0,0.65)';
        ctx.lineWidth = 1.2 * u;
        if (off) ctx.setLineDash([2 * u, 2 * u]);
        ctx.stroke();
        ctx.setLineDash([]);
        // Health ring.
        const hp = (t.health[o] ?? 0) / 100;
        ctx.strokeStyle = hp > 0.5 ? c.text : hp > 0.2 ? c.t : c.bad;
        ctx.lineWidth = 2 * u;
        ctx.beginPath();
        ctx.arc(px, py, rad + 2.6 * u, -Math.PI / 2, -Math.PI / 2 + hp * Math.PI * 2);
        ctx.stroke();
        if (isUser) {
          ctx.strokeStyle = c.accent;
          ctx.lineWidth = 2 * u;
          ctx.beginPath();
          ctx.arc(px, py, rad + 5.6 * u, 0, Math.PI * 2);
          ctx.stroke();
        }
        // Bomb and kit marks.
        if (fl & REPLAY_FLAG.bomb) {
          ctx.fillStyle = c.bad;
          ctx.fillRect(px + rad * 0.6, py - rad * 1.6, 5 * u, 5 * u);
        }
        if (fl & REPLAY_FLAG.kit) {
          ctx.strokeStyle = c.ct;
          ctx.lineWidth = 1.6 * u;
          const qx = px + rad * 1.2;
          const qy = py + rad * 1.1;
          ctx.beginPath();
          ctx.moveTo(qx - 2.5 * u, qy); ctx.lineTo(qx + 2.5 * u, qy);
          ctx.moveTo(qx, qy - 2.5 * u); ctx.lineTo(qx, qy + 2.5 * u);
          ctx.stroke();
        }
        if (fl & REPLAY_FLAG.defusing) this.drawDefuse(px, py, u, p, tick, rate);
        // Labels: name above, weapon below.
        const name = this.names[p] ?? `#${p}`;
        ctx.fillStyle = isUser ? c.accent : c.text;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 3 * u;
        ctx.lineJoin = 'round';
        const ly = py - rad - 6 * u;
        ctx.strokeText(name, px, ly);
        ctx.fillText(name, px, ly);
        const wname = weaponName(t.weapons[t.weapon[o] ?? 0] ?? '');
        if (wname) {
          ctx.font = `${(DRAW.label - 1.5) * u}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
          ctx.fillStyle = c.dim;
          const wy = py + rad + 12 * u;
          ctx.strokeText(wname, px, wy);
          ctx.fillText(wname, px, wy);
          ctx.font = `600 ${DRAW.label * u}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
        }
        ctx.globalAlpha = 1;
      }
    }

    for (const a of anns) if (a.kind !== 'zone') this.drawAnnotation(a, W, u, tick);
  }

  private drawDefuse(px: number, py: number, u: number, p: number, tick: number, rate: number): void {
    const t = this.track;
    if (!t) return;
    const begin = [...t.events.bomb].reverse().find((b) => b.kind === 'begin_defuse' && b.p === p && b.tick <= tick);
    if (!begin) return;
    const total = begin.hasKit ? DEFUSE_KIT_SEC : DEFUSE_SEC;
    const f = Math.min(1, (tick - begin.tick) / rate / total);
    const ctx = this.ctx;
    ctx.strokeStyle = this.colors.ct;
    ctx.lineWidth = 3 * u;
    ctx.beginPath();
    ctx.arc(px, py, (DRAW.marker + 10) * u, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
    ctx.stroke();
  }

  private drawBomb(W: (x: number, y: number) => [number, number], u: number, tick: number, rate: number): void {
    const t = this.track;
    if (!t) return;
    const ctx = this.ctx;
    const c = this.colors;
    interface BombState { kind: string; x: number; y: number; tick: number }
    let state = null as BombState | null;
    for (const b of t.events.bomb) {
      if (b.tick > tick) break;
      if (b.kind === 'dropped' || b.kind === 'planted') state = { kind: b.kind, x: b.x, y: b.y, tick: b.tick };
      else if (b.kind === 'pickup') state = null;
      else if ((b.kind === 'defused' || b.kind === 'exploded') && state !== null) state = { kind: b.kind, x: state.x, y: state.y, tick: b.tick };
    }
    if (!state || state.x === REPLAY_ABSENT) return;
    const [px, py] = W(state.x, state.y);
    const s = 5 * u;
    if (state.kind === 'exploded') {
      const age = (tick - state.tick) / rate;
      if (age > 3) return;
      ctx.fillStyle = c.bad;
      ctx.globalAlpha = Math.max(0, 0.5 * (1 - age / 3));
      ctx.beginPath();
      ctx.arc(px, py, (500 / (this.map?.radar.scale ?? 5)) * Math.min(1, age * 2), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }
    ctx.fillStyle = state.kind === 'defused' ? c.good : c.bad;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 1.2 * u;
    ctx.beginPath();
    ctx.rect(px - s, py - s, s * 2, s * 2);
    ctx.fill();
    ctx.stroke();
    if (state.kind === 'planted') {
      const left = BOMB_SEC - (tick - state.tick) / rate;
      // Pulse with the beeps, faster toward the end.
      const pulse = 0.5 + 0.5 * Math.sin((tick - state.tick) / rate * Math.PI * (left < 10 ? 4 : 1.5));
      ctx.strokeStyle = c.bad;
      ctx.globalAlpha = 0.35 + 0.4 * pulse;
      ctx.lineWidth = 2 * u;
      ctx.beginPath();
      ctx.arc(px, py, 11 * u, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.font = `700 ${11 * u}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = c.text;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 3 * u;
      const label = Math.max(0, left).toFixed(1);
      ctx.strokeText(label, px, py - 15 * u);
      ctx.fillText(label, px, py - 15 * u);
    }
  }

  private drawAnnotation(a: Annotation, W: (x: number, y: number) => [number, number], u: number, tick: number): void {
    if (tick < a.tick0 || tick > a.tick1) return;
    const ctx = this.ctx;
    const col = this.roleColor(a.role);
    const scale = this.map?.radar.scale ?? 5;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 2.2 * u;
    ctx.globalAlpha = 1;
    let labelAt: [number, number] | null = null;
    switch (a.kind) {
      case 'line': {
        const [x0, y0] = W(a.from[0], a.from[1]);
        const [x1, y1] = W(a.to[0], a.to[1]);
        ctx.setLineDash(a.dashed ? [6 * u, 4 * u] : []);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.setLineDash([]);
        labelAt = [(x0 + x1) / 2, (y0 + y1) / 2];
        break;
      }
      case 'circle': {
        const [x, y] = W(a.center[0], a.center[1]);
        ctx.beginPath();
        ctx.arc(x, y, a.radius / scale, 0, Math.PI * 2);
        ctx.globalAlpha = 0.12;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.stroke();
        labelAt = [x, y - a.radius / scale - 6 * u];
        break;
      }
      case 'cone': {
        const [x, y] = W(a.apex[0], a.apex[1]);
        const yaw = -a.yaw * RAD;
        const h = a.halfAngle * RAD;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, a.length / scale, yaw - h, yaw + h);
        ctx.closePath();
        ctx.globalAlpha = 0.18;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.stroke();
        labelAt = [x + Math.cos(yaw) * (a.length / scale), y + Math.sin(yaw) * (a.length / scale)];
        break;
      }
      case 'path': {
        ctx.beginPath();
        let n = 0;
        a.points.forEach((pt, i) => {
          if (a.ticks && (a.ticks[i] ?? 0) > tick) return;
          const [x, y] = W(pt[0], pt[1]);
          if (n === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          n++;
          labelAt = [x, y];
        });
        ctx.stroke();
        break;
      }
      case 'zone': {
        ctx.beginPath();
        a.polygon.forEach((pt, i) => {
          const [x, y] = W(pt[0], pt[1]);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.globalAlpha = 0.2;
        ctx.fill();
        ctx.globalAlpha = 0.8;
        ctx.stroke();
        ctx.globalAlpha = 1;
        const p0 = a.polygon[0];
        if (p0) labelAt = W(p0[0], p0[1]);
        break;
      }
      case 'label': {
        labelAt = W(a.at[0], a.at[1]);
        this.drawTag(a.text, labelAt[0], labelAt[1], col, u);
        labelAt = null;
        break;
      }
    }
    if (labelAt && a.label) this.drawTag(a.label, labelAt[0], labelAt[1], col, u);
  }

  private drawTag(text: string, x: number, y: number, col: string, u: number): void {
    const ctx = this.ctx;
    ctx.font = `600 ${11 * u}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
    const w = ctx.measureText(text).width + 10 * u;
    const h = 17 * u;
    ctx.fillStyle = 'rgba(12,14,18,0.86)';
    ctx.strokeStyle = col;
    ctx.lineWidth = 1 * u;
    ctx.beginPath();
    ctx.rect(x - w / 2, y - h / 2, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5 * u);
    ctx.textBaseline = 'alphabetic';
  }

  // ------------------------------------------------------------------ timeline

  private xOf(tick: number): number {
    const span = Math.max(1, this.tick1 - this.tick0);
    return 8 + ((tick - this.tick0) / span) * (this.tlW - 16);
  }

  private tickOf(x: number): number {
    const span = Math.max(1, this.tick1 - this.tick0);
    return this.tick0 + ((x - 8) / Math.max(1, this.tlW - 16)) * span;
  }

  private onPointer = (e: PointerEvent): void => {
    if (e.type === 'pointerdown') {
      this.scrubbing = true;
      this.timeline.setPointerCapture(e.pointerId);
    }
    if (!this.scrubbing) return;
    const rect = this.timeline.getBoundingClientRect();
    this.stopAt = null;
    this.seek(this.tickOf(e.clientX - rect.left));
  };

  private onPointerUp = (): void => {
    this.scrubbing = false;
  };

  private drawTimeline(): void {
    const ctx = this.tctx;
    const c = this.colors;
    const t = this.track;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.tlW, this.tlH);
    if (!t) return;
    const ph = t.phases;
    const y0 = 16;
    const bh = 10;
    const band = (a: number, b: number, col: string, alpha: number): void => {
      const xa = this.xOf(Math.max(this.tick0, a));
      const xb = this.xOf(Math.min(this.tick1, b));
      if (xb <= xa) return;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = col;
      ctx.fillRect(xa, y0, xb - xa, bh);
      ctx.globalAlpha = 1;
    };
    const fe = ph.freezeEnd ?? this.tick0;
    band(this.tick0, fe, c.dim, 0.25);
    band(fe, ph.plant ?? ph.end, c.text, 0.22);
    if (ph.plant !== null) band(ph.plant, ph.end, c.bad, 0.5);
    band(ph.end, this.tick1, c.dim, 0.12);
    // Events: kills (killer's side colour; the user's kills and death in the accent), plant, defuse.
    for (const k of t.events.kills) {
      const x = this.xOf(k.tick);
      const mine = k.attacker === this.user || k.victim === this.user;
      ctx.fillStyle = mine ? c.accent : this.sideColor(t.side[k.attacker] ?? 0);
      if (k.victim === this.user) {
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - 3, y0 + bh + 4); ctx.lineTo(x + 3, y0 + bh + 10);
        ctx.moveTo(x + 3, y0 + bh + 4); ctx.lineTo(x - 3, y0 + bh + 10);
        ctx.stroke();
      }
      ctx.fillRect(x - 1, y0 - 2, 2, bh + 4);
    }
    for (const b of t.events.bomb) {
      if (b.kind !== 'planted' && b.kind !== 'defused') continue;
      const x = this.xOf(b.tick);
      ctx.fillStyle = b.kind === 'planted' ? c.bad : c.good;
      ctx.fillRect(x - 3, y0 + bh + 3, 6, 6);
    }
    // Finding markers: accent triangles above the bar.
    ctx.fillStyle = c.accent;
    for (const m of this.markers) {
      const x = this.xOf(m.tick);
      ctx.beginPath();
      ctx.moveTo(x - 5, 2); ctx.lineTo(x + 5, 2); ctx.lineTo(x, 11);
      ctx.closePath();
      ctx.fill();
    }
    // Evidence range.
    const ev = this.evidence;
    if (ev && ev.round === t.round) {
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1.5;
      const xa = this.xOf(ev.tick0);
      const xb = this.xOf(ev.tick1);
      ctx.strokeRect(xa, y0 - 3, Math.max(2, xb - xa), bh + 6);
    }
    // Playhead.
    const x = this.xOf(this.tick);
    ctx.fillStyle = c.text;
    ctx.fillRect(x - 1, 0, 2, this.tlH);
  }

  // ------------------------------------------------------------------ HUD

  private emitHud(force: boolean, now: number = performance.now()): void {
    const t = this.track;
    if (!t) return;
    if (!force && now - this.lastHud < HUD_MS) return;
    this.lastHud = now;
    const tick = this.tick;
    const rate = this.rate;
    const ph = t.phases;
    let phase: HudState['phase'];
    let clk: string;
    if (ph.freezeEnd !== null && tick < ph.freezeEnd) { phase = 'freeze'; clk = clock((ph.freezeEnd - tick) / rate); }
    else if (tick > ph.end) { phase = 'over'; clk = clock(0); }
    else if (ph.plant !== null && tick >= ph.plant) { phase = 'planted'; clk = clock(BOMB_SEC - (tick - ph.plant) / rate); }
    else { phase = 'live'; clk = clock(ROUND_SEC - (tick - (ph.freezeEnd ?? ph.start)) / rate); }
    const feed: FeedKill[] = [];
    for (const k of t.events.kills) {
      if (k.tick <= tick && tick - k.tick <= DRAW.feedSec * rate) {
        feed.push({ tick: k.tick, attacker: k.attacker, victim: k.victim, assister: k.assister, weapon: k.weapon, headshot: k.headshot, wallbang: k.penetrated > 0, smoke: k.thruSmoke, noScope: k.noScope });
      }
    }
    const k = Math.max(0, Math.min(t.samples - 1, Math.round((tick - t.tick0) / t.step)));
    const players: HudPlayer[] = [];
    for (let p = 0; p < t.players; p++) {
      const o = k * t.players + p;
      if ((t.side[p] ?? 0) === 0) continue;
      const fl = t.flags[o] ?? 0;
      players.push({
        slot: p, side: t.side[p] ?? 0, alive: (fl & REPLAY_FLAG.alive) !== 0, health: t.health[o] ?? 0,
        weapon: weaponName(t.weapons[t.weapon[o] ?? 0] ?? ''), place: t.places[t.place[o] ?? 0] ?? '',
        bomb: (fl & REPLAY_FLAG.bomb) !== 0, kit: (fl & REPLAY_FLAG.kit) !== 0,
      });
    }
    this.onHud({ round: t.round, tick, playing: this.playing, speed: this.speed, phase, clock: clk, feed: feed.slice(-5), players, level: this.shownLevel() });
  }
}
