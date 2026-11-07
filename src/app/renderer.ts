/**
 * Canvas renderer: the radar, the pawns, the overlays and the effects layer on one 2D canvas, crisp
 * at any devicePixelRatio. Replaces D1's debug renderer and keeps its outward shape: `resize()`, `view`
 * (the `View` input-dom.ts maps the cursor through) and `draw(frame)`. The HUD (clock, kill feed,
 * panels) is DOM, in hud.ts.
 *
 * - **Camera** (camera.ts): full map by default; zoom about a point, pan, follow a pawn. `view`
 *   always reflects the camera, so aiming stays right at any zoom.
 * - **Radar cache**: the radar is drawn once into an offscreen canvas at the current device scale
 *   (with the dusk tint baked in) and blitted 1:1 each frame. It is rebuilt only when the zoom or the
 *   size changes, or when panning leaves the cached area (the cache keeps a margin around the view).
 * - **Interpolation**: every pawn is drawn `alpha` (= loop.pending / TICK_MS) of the way from the
 *   previous observe to the current one (Scene.pose), so 64 Hz motion is smooth on 60–120 Hz displays.
 *
 * Layers, bottom to top: radar · smokes and fires · recorded tracks (and, with them, each LIVE pawn's way
 * to its next waypoint) · bomb · death crosses · tracers · view wedges · recorded ghost · pawns and HP bars ·
 * flying grenades and pops · labels and badges · aim line. Labels keep out of the HUD's rectangles
 * (`RenderFrame.avoid`): a label that can't is dropped and the dot stays.
 */
import type { MapTransform, PawnObs, PlayerId, RoundData, Team } from '../contracts/index';
import type { RoundClock, RoundModel } from '../core/index';
import { cameraView, clampCamera, followTarget, fullCamera, panBy, zoomAt, FOLLOW_ZOOM, MIN_ZOOM, type Camera, type Viewport } from './camera';
import { effectPrimitives, popPrimitives, tracerPrimitive, unitsToPx, type BlindSource, type Primitive } from './effects';
import { airCue, bombCarrier, chooseLabelSpot, rectsOverlap, roundStateOf, statusBadge, type AiDebugSource, type AirCue, type Badge, type Overlays, type ScreenRect } from './hud-model';
import { worldToRadar, worldToScreen, yawToScreenDir, type Point2, type View } from './radar';
import type { Pose, Scene } from './scene';
import { DISPLAY_FONT, PALETTE, teamColor } from './style';

export interface RenderFrame {
  readonly scene: Scene;
  /** loop.pending / TICK_MS (0..1): how far to draw between the previous and the current observe. */
  readonly alpha: number;
  readonly model: RoundModel;
  readonly clock: RoundClock;
  /** The pawn the human plays, or null when spectating. */
  readonly human: PlayerId | null;
  readonly overlays: Overlays;
  /** Cursor in canvas CSS px while the human is playing (for the aim line), else null. */
  readonly aim: Point2 | null;
  /** View-cone width for the facing wedge (tuning.ai.fovDeg). */
  readonly fovDeg: number;
  /** Who is flashed (Sim2DHost.blindUntilTick), or null. */
  readonly blind: BlindSource | null;
  /** Wall time (ms), for camera easing and UI pulses. */
  readonly nowMs: number;
  /** Where the HUD is (CSS px, canvas coordinates; Hud.occupiedRects): labels keep out. Default none. */
  readonly avoid?: readonly ScreenRect[];
  /** The 2D engine's LIVE AI debug view (Sim2DHost.aiDebug): with the tracks overlay, each LIVE pawn's path. */
  readonly ai?: AiDebugSource | null;
  /** G3: the floor height under a point (feet z of a hull standing there, at or below z), or null; absent: no height cue. */
  readonly floorZ?: ((x: number, y: number, z: number) => number | null) | null;
}

/** The pawn the follow camera and the ghost track. */
export const FOLLOWED: PlayerId = 'cart';
/** Seconds of recorded path the tracks overlay shows ahead of now. */
export const TRACKS_AHEAD_SEC = 3;
/** Recorded "now" markers further than this from the pawn (units) get a drift line. */
const DRIFT_LINE_UNITS = 24;
/** Ghost further than this from cart (units) gets a link and a distance. */
const GHOST_LINK_UNITS = 64;
/** Source units are inches. */
const METRES_PER_UNIT = 0.0254;
/** Canvas margin around the radar at zoom 1 (CSS px). */
const MARGIN = 4;
/** Largest radar cache (device px); beyond it the cache keeps no margin. */
const MAX_CACHE_PX = 16_000_000;
/** Multiplied over the radar in the cache: dims it a little toward the dusk palette so marks pop. */
const RADAR_TINT = '#b4bfd0';

const TAU = Math.PI * 2;

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private radar: CanvasImageSource | null;
  private readonly map: MapTransform;
  private readonly colors: ReadonlyMap<PlayerId, string>;
  private cache = new RadarCache();
  private cam: Camera;
  private vp: Viewport = { width: 0, height: 0, margin: MARGIN };
  private viewValue: View;
  private dpr = 1;
  private lastDrawMs: number | null = null;
  private readonly textWidths = new Map<string, number>();
  /** prefers-reduced-motion: no expanding pulse rings (LIVE, bomb, fresh deaths); the static marks stay. */
  private readonly calm: boolean;
  /** The last frame's name labels: where they went, and how many were left out to keep clear of the HUD. */
  private labels: { drawn: ScreenRect[]; dropped: number } = { drawn: [], dropped: 0 };

  constructor(canvas: HTMLCanvasElement, radar: CanvasImageSource | null, round: Pick<RoundData, 'meta' | 'players'>) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) throw new Error('Renderer: no 2D context');
    this.canvas = canvas;
    this.ctx = ctx;
    this.radar = radar;
    this.map = round.meta.map;
    this.colors = new Map(round.players.map((p) => [p.id, p.color]));
    this.cam = fullCamera(this.map);
    this.viewValue = cameraView(this.map, this.cam, this.vp);
    this.calm = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize();
  }

  /** G3: the map layer (the radar, or the height map in the same frame); redrawn from the next frame. */
  setMapLayer(img: CanvasImageSource | null): void {
    if (img === this.radar) return;
    this.radar = img;
    const rebuilds = this.cache.rebuilds;
    this.cache = new RadarCache();
    this.cache.rebuilds = rebuilds;
  }

  /** Where the radar is on the canvas (CSS px); input-dom.ts maps the mouse through it. */
  get view(): View {
    return this.viewValue;
  }

  get camera(): Camera {
    return this.cam;
  }

  /** Radar cache rebuilds so far (for the browser check). */
  get cacheRebuilds(): number {
    return this.cache.rebuilds;
  }

  /** The last frame's labels (CSS px) and how many were dropped (for the browser check). */
  get labelStats(): { readonly drawn: readonly ScreenRect[]; readonly dropped: number } {
    return this.labels;
  }

  /** Match the backing store to the canvas's CSS size × devicePixelRatio. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.vp.width && h === this.vp.height && dpr === this.dpr) return;
    this.vp = { width: w, height: h, margin: MARGIN };
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.setCamera(this.cam);
  }

  setCamera(c: Camera): void {
    this.cam = clampCamera(this.map, c, this.vp);
    this.viewValue = cameraView(this.map, this.cam, this.vp);
  }

  resetCamera(): void {
    this.setCamera(fullCamera(this.map));
  }

  /** Zoom by `factor` about a canvas point (CSS px), or about the centre when `at` is null. */
  zoomAt(at: Point2 | null, factor: number): void {
    const p = at ?? { x: this.vp.width / 2, y: this.vp.height / 2 };
    this.setCamera(zoomAt(this.map, this.cam, this.vp, p, factor));
  }

  panBy(dx: number, dy: number): void {
    this.setCamera(panBy(this.map, this.cam, this.vp, dx, dy));
  }

  /** Start following: zoom in if at the full map, centre on `world` at once. */
  startFollow(world: Point2 | null): void {
    const zoom = this.cam.zoom <= MIN_ZOOM ? FOLLOW_ZOOM : this.cam.zoom;
    const r = world === null ? { x: this.cam.cx, y: this.cam.cy } : worldToRadar(this.map, world);
    this.setCamera({ zoom, cx: r.x, cy: r.y });
  }

  draw(f: RenderFrame): void {
    const dt = this.lastDrawMs === null ? 0 : Math.min(100, f.nowMs - this.lastDrawMs);
    this.lastDrawMs = f.nowMs;
    const scene = f.scene;
    const followed = f.human ?? FOLLOWED;
    if (f.overlays.follow) {
      const pose = scene.pose(followed, f.alpha);
      if (pose !== null) this.setCamera(followTarget(this.map, this.cam, this.vp, worldToRadar(this.map, pose), dt));
    }
    const { ctx } = this;
    const v = this.viewValue;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PALETTE.night;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.radar !== null) this.cache.draw(ctx, this.radar, v, this.vp, dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const tick = scene.renderTick(f.alpha);
    const r = pawnRadius(v);
    const poses = new Map<PlayerId, Pose>();
    for (const p of scene.cur.pawns) {
      const pose = scene.pose(p.id, f.alpha);
      if (pose !== null) poses.set(p.id, pose);
    }

    // Smokes and fires, under everything else.
    for (const e of scene.effects) if (e.phase !== 'flying') this.prims(effectPrimitives(e, v, tick, scene.bornTick(e)));
    if (f.overlays.tracks) this.drawTracks(f, poses, tick, r);
    if (f.overlays.tracks && f.ai !== undefined && f.ai !== null) this.drawAiPaths(f, f.ai, poses, r);
    this.drawBomb(f, tick, r);
    // Dead pawns: a cross at the death spot.
    for (const p of scene.cur.pawns) if (!p.alive) this.drawDeath(p, poses.get(p.id), scene.deaths.get(p.id) ?? null, tick, r);
    for (const t of scene.tracers) {
      const prim = tracerPrimitive(t, v, tick);
      if (prim !== null) this.prims([prim]);
    }
    const alive = scene.cur.pawns.filter((p) => p.alive);
    for (const p of alive) {
      const pose = poses.get(p.id);
      if (pose !== undefined) this.drawWedge(pose, p.team, f.fovDeg, r);
    }
    const ghostNote = f.overlays.ghost ? this.drawGhost(f, followed, poses.get(followed) ?? null, tick, r) : null;
    // CTs, then Ts, then the human on top.
    const order = [...alive].sort((a, b) => drawRank(a, f.human) - drawRank(b, f.human));
    const carrier = bombCarrier(scene.cur);
    for (const p of order) {
      const pose = poses.get(p.id);
      if (pose === undefined) continue;
      const badge = statusBadge(scene.statusOf(p.id)?.mode ?? null, p.id === f.human, p.alive);
      const blindFor = f.blind === null ? 0 : f.blind.blindUntilTick(p.id) - scene.cur.tick;
      const floor = f.floorZ === null || f.floorZ === undefined ? null : f.floorZ(pose.x, pose.y, pose.z);
      const cue = floor === null || p.onGround ? null : airCue(pose.z - floor, v.scale / v.map.scale);
      this.drawPawn(p, pose, badge, p.id === carrier, cue === null ? r : r * cue.scale, f.nowMs, blindFor, cue);
    }
    for (const e of scene.effects) if (e.phase === 'flying') this.prims(effectPrimitives(e, v, tick, null));
    for (const p of scene.pops) this.prims(popPrimitives(p, v, tick));
    this.drawLabels(f, poses, r);
    if (ghostNote !== null) {
      const font = `600 ${labelSize(r) - 1}px ${DISPLAY_FONT}`;
      const w = this.textWidth(ghostNote.text, font);
      if (this.clearOfHud(f, { x: ghostNote.x - w / 2, y: ghostNote.y, w, h: labelSize(r) })) haloText(ctx, ghostNote.text, ghostNote.x, ghostNote.y, font, PALETTE.human, 'center', 'top');
    }
    if (f.aim !== null && f.human !== null) {
      const pose = poses.get(f.human);
      if (pose !== undefined && scene.pawn(f.human)?.alive === true) this.drawAim(pose, f.aim, r);
    }
  }

  // ---- layers --------------------------------------------------------------------------------------

  private prims(list: readonly Primitive[]): void {
    const { ctx } = this;
    for (const p of list) {
      if (p.alpha <= 0) continue;
      ctx.globalAlpha = p.alpha;
      if (p.type === 'circle') {
        if (p.r <= 0) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, TAU);
        if (p.fill !== null) {
          ctx.fillStyle = p.fill;
          ctx.fill();
        }
        if (p.stroke !== null) {
          ctx.setLineDash(p.dash);
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = p.lineWidth;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else {
        ctx.strokeStyle = PALETTE.ink;
        ctx.lineWidth = p.lineWidth + 1.5;
        ctx.globalAlpha = p.alpha * 0.5;
        line(ctx, p.x0, p.y0, p.x1, p.y1);
        ctx.globalAlpha = p.alpha;
        ctx.strokeStyle = p.stroke;
        ctx.lineWidth = p.lineWidth;
        line(ctx, p.x0, p.y0, p.x1, p.y1);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Each pawn's recorded path for the next few seconds (dotted) and its recorded position now. */
  private drawTracks(f: RenderFrame, poses: ReadonlyMap<PlayerId, Pose>, tick: number, r: number): void {
    const { ctx } = this;
    const v = this.viewValue;
    const t = tick / 64;
    const followed = f.human ?? FOLLOWED;
    for (const mp of f.model.players) {
      const now = f.model.trackAt(mp.id, t);
      if (now === null) continue;
      const color = teamColor(mp.team);
      const s0 = worldToScreen(v, now.pos);
      ctx.beginPath();
      ctx.moveTo(s0.x, s0.y);
      let n = 0;
      for (const q of f.model.track(mp.id)) {
        if (q.t <= t) continue;
        if (q.t > t + TRACKS_AHEAD_SEC) break;
        const s = worldToScreen(v, q);
        ctx.lineTo(s.x, s.y);
        n++;
      }
      if (n > 0) {
        ctx.setLineDash([0.1, 5]);
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = PALETTE.ink;
        ctx.globalAlpha = 0.45;
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.85;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (f.overlays.ghost && mp.id === followed) continue;
      const pose = poses.get(mp.id);
      const pawn = f.scene.pawn(mp.id);
      if (pose !== undefined && pawn !== null && pawn.alive && Math.hypot(pose.x - now.pos.x, pose.y - now.pos.y) > DRIFT_LINE_UNITS) {
        const s = worldToScreen(v, pose);
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        line(ctx, s.x, s.y, s0.x, s0.y);
      }
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(s0.x, s0.y, r * 0.62, 0, TAU);
      ctx.lineWidth = 3;
      ctx.strokeStyle = PALETTE.ink;
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /** True if a rectangle (CSS px) is clear of the HUD's rectangles. */
  private clearOfHud(f: RenderFrame, rect: ScreenRect): boolean {
    return !(f.avoid ?? []).some((a) => rectsOverlap(rect, a, 2));
  }

  /**
   * With the tracks overlay: each LIVE pawn's way on (Sim2DHost.aiDebug's path, from its next waypoint on) as a
   * faint dashed magenta line from the pawn, with a small ring at the next waypoint. 2D debug only.
   */
  private drawAiPaths(f: RenderFrame, ai: AiDebugSource, poses: ReadonlyMap<PlayerId, Pose>, r: number): void {
    const { ctx } = this;
    const v = this.viewValue;
    for (const p of f.scene.cur.pawns) {
      if (!p.alive) continue;
      const d = ai.aiDebug(p.id);
      const next = d?.path[0];
      if (d === null || next === undefined) continue;
      const s0 = worldToScreen(v, poses.get(p.id) ?? p.pos);
      ctx.beginPath();
      ctx.moveTo(s0.x, s0.y);
      for (const q of d.path) {
        const s = worldToScreen(v, q);
        ctx.lineTo(s.x, s.y);
      }
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = PALETTE.live;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.setLineDash([]);
      const n = worldToScreen(v, next);
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(2.5, r * 0.35), 0, TAU);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /** The planted bomb: a blinking dot that blinks faster as the timer runs down, and the time left. */
  private drawBomb(f: RenderFrame, tick: number, r: number): void {
    const scene = f.scene;
    const round = roundStateOf(scene.cur);
    const plantTick = round?.bomb.plantTick ?? scene.bomb.plantTick;
    const pos = round?.bomb.pos ?? scene.bomb.pos;
    if (plantTick === null || pos === null) return;
    const state = round !== null ? round.bomb.state : scene.bomb.phase;
    const done = state === 'defused' || state === 'exploded' || (round?.phase ?? null) === 'over' || scene.roundEnd !== null;
    const defusing = state === 'defusing' || (round?.bomb.defuser ?? scene.bomb.defuser) !== null;
    const { ctx } = this;
    const s = worldToScreen(this.viewValue, pos);
    const left = f.clock.bombRemaining(tick, plantTick);
    const frac = Math.max(0, Math.min(1, left / f.clock.bombTimerSec));
    const color = state === 'defused' ? PALETTE.defuse : PALETTE.bomb;
    const size = Math.max(4, r * 0.8);
    if (!done && !this.calm) {
      // Beep rhythm: one blink per second at plant, about seven per second at the end.
      const period = 0.14 + 0.86 * frac;
      const phase = ((tick / 64) % period) / period;
      ctx.globalAlpha = 0.7 * (1 - phase);
      ctx.strokeStyle = PALETTE.bomb;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, size + 2 + phase * r * 2.4, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const lit = done || this.calm || ((tick / 64) % (0.14 + 0.86 * frac)) / (0.14 + 0.86 * frac) < 0.5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, size, 0, TAU);
    ctx.fillStyle = lit ? color : '#7a2422';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = PALETTE.ink;
    ctx.stroke();
    if (defusing && !done) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, size + 4, -Math.PI / 2, -Math.PI / 2 + TAU * 0.999);
      ctx.strokeStyle = PALETTE.defuse;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (!done) {
      const text = f.clock.hudBomb(scene.cur.tick, plantTick);
      const font = `700 ${labelSize(r) + 1}px ${DISPLAY_FONT}`;
      const h = labelSize(r) + 2;
      if (this.clearOfHud(f, { x: s.x + size + 6, y: s.y - h / 2, w: this.textWidth(text, font), h })) haloText(ctx, text, s.x + size + 6, s.y, font, PALETTE.bomb, 'left', 'middle');
    }
  }

  private drawDeath(p: PawnObs, pose: Pose | undefined, deathTick: number | null, tick: number, r: number): void {
    const { ctx } = this;
    const s = worldToScreen(this.viewValue, pose ?? p.pos);
    const k = r * 0.8;
    const fresh = deathTick === null ? 1 : Math.min(1, (tick - deathTick) / 48);
    if (fresh < 1 && !this.calm) {
      ctx.globalAlpha = 1 - fresh;
      ctx.strokeStyle = PALETTE.bomb;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, k + 3 + fresh * r * 2, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 5;
    cross(ctx, s.x, s.y, k);
    ctx.strokeStyle = teamColor(p.team);
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2.5;
    cross(ctx, s.x, s.y, k);
    ctx.globalAlpha = 1;
  }

  /** Facing wedge: a soft cone of the view width, fading out with distance. */
  private drawWedge(pose: Pose, team: Team, fovDeg: number, r: number): void {
    const { ctx } = this;
    const s = worldToScreen(this.viewValue, pose);
    const len = Math.min(r * 9, Math.max(r * 2.8, unitsToPx(this.viewValue, 240)));
    const a = (-pose.yaw * Math.PI) / 180;
    const half = (Math.max(10, Math.min(170, fovDeg)) * Math.PI) / 360;
    const g = ctx.createRadialGradient(s.x, s.y, r * 0.8, s.x, s.y, len);
    g.addColorStop(0, team === 'T' ? 'rgba(235, 199, 94, 0.36)' : 'rgba(139, 188, 243, 0.36)');
    g.addColorStop(1, team === 'T' ? 'rgba(235, 199, 94, 0)' : 'rgba(139, 188, 243, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.arc(s.x, s.y, len, a - half, a + half);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * The recorded position of the followed pawn now: a hollow dashed outline, linked to the pawn when it
   * has strayed. Returns the distance note, drawn later above the labels.
   */
  private drawGhost(f: RenderFrame, id: PlayerId, pose: Pose | null, tick: number, r: number): { text: string; x: number; y: number } | null {
    const rec = f.model.trackAt(id, tick / 64);
    if (rec === null) return null;
    let note: { text: string; x: number; y: number } | null = null;
    const { ctx } = this;
    const g = worldToScreen(this.viewValue, rec.pos);
    const pawn = f.scene.pawn(id);
    if (pose !== null && pawn !== null && pawn.alive) {
      const d = Math.hypot(pose.x - rec.pos.x, pose.y - rec.pos.y);
      if (d > GHOST_LINK_UNITS) {
        const s = worldToScreen(this.viewValue, pose);
        ctx.setLineDash([2, 4]);
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = PALETTE.human;
        ctx.lineWidth = 1.25;
        line(ctx, s.x, s.y, g.x, g.y);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        const metres = d * METRES_PER_UNIT;
        note = { text: `${metres < 10 ? metres.toFixed(1) : Math.round(metres)} m`, x: g.x, y: g.y + r + 4 };
      }
    }
    ctx.beginPath();
    ctx.arc(g.x, g.y, r + 1, 0, TAU);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = PALETTE.ink;
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([3, 2.5]);
    ctx.lineWidth = 1.75;
    ctx.strokeStyle = PALETTE.human;
    ctx.stroke();
    ctx.setLineDash([]);
    return note;
  }

  private drawPawn(p: PawnObs, pose: Pose, badge: Badge, carriesBomb: boolean, r: number, nowMs: number, blindTicks: number, cue: AirCue | null = null): void {
    const { ctx } = this;
    const s = worldToScreen(this.viewValue, pose);
    const color = teamColor(p.team);
    if (cue !== null) {
      // G3: in the air: its shadow on the floor below (offset as if lit from the upper left), and the disc bigger.
      ctx.beginPath();
      ctx.ellipse(s.x + cue.shadowDx, s.y + cue.shadowDy, r / cue.scale, (r / cue.scale) * 0.8, 0, 0, TAU);
      ctx.fillStyle = 'rgba(2, 4, 8, 0.55)';
      ctx.fill();
    }
    if (blindTicks > 0) {
      // Flashed: a white bloom, fading over the last 0.75 s of the blindness.
      const k = Math.min(1, blindTicks / 48);
      const g = ctx.createRadialGradient(s.x, s.y, r, s.x, s.y, r * 3.4);
      g.addColorStop(0, `rgba(255, 251, 224, ${(0.95 * k).toFixed(3)})`);
      g.addColorStop(0.45, `rgba(255, 251, 224, ${(0.55 * k).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255, 251, 224, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 3.4, 0, TAU);
      ctx.fill();
    }
    if (badge.tone === 'human') {
      const g = ctx.createRadialGradient(s.x, s.y, r, s.x, s.y, r * 3.2);
      g.addColorStop(0, 'rgba(255, 255, 255, 0.32)');
      g.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 3.2, 0, TAU);
      ctx.fill();
    }
    if (badge.tone === 'alert' && !this.calm) {
      // LIVE: a pulsing magenta halo that can't be missed.
      const ph = (nowMs % 900) / 900;
      ctx.globalAlpha = 0.85 * (1 - ph);
      ctx.strokeStyle = PALETTE.live;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 3 + ph * r * 2.2, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Facing pointer: a small notch just outside the disc.
    const d = yawToScreenDir(pose.yaw);
    const nx = -d.y;
    const ny = d.x;
    const tip = r + Math.max(4, r * 0.7);
    const base = r - 1;
    const w = Math.max(3, r * 0.5);
    ctx.beginPath();
    ctx.moveTo(s.x + d.x * tip, s.y + d.y * tip);
    ctx.lineTo(s.x + d.x * base + nx * w, s.y + d.y * base + ny * w);
    ctx.lineTo(s.x + d.x * base - nx * w, s.y + d.y * base - ny * w);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = PALETTE.ink;
    ctx.stroke();
    // Disc in the team colour, with the player's own colour (round.json, as on the CS2 radar) at its centre.
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, TAU);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = PALETTE.ink;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 0.42, 0, TAU);
    ctx.fillStyle = this.colors.get(p.id) ?? color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(3, 5, 8, 0.6)';
    ctx.stroke();
    if (cue !== null && cue.lighten > 0) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, TAU);
      ctx.fillStyle = `rgba(255, 255, 255, ${cue.lighten.toFixed(3)})`;
      ctx.fill();
    }
    if (badge.tone === 'human') ring(ctx, s.x, s.y, r + 3.5, PALETTE.human, 2);
    if (badge.tone === 'alert') ring(ctx, s.x, s.y, r + 3, PALETTE.live, 2.5);
    if (carriesBomb) {
      const bw = r * 1.3;
      const bh = r * 0.85;
      ctx.beginPath();
      ctx.roundRect(s.x + r * 0.35, s.y - r * 1.45, bw, bh, 2);
      ctx.fillStyle = PALETTE.bomb;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = PALETTE.ink;
      ctx.stroke();
    }
    // HP (and armor) bar, only once hurt.
    if (p.hp < 100) {
      const bw = Math.max(22, r * 3.6);
      const x = s.x - bw / 2;
      const y = s.y + r + 4;
      ctx.fillStyle = PALETTE.ink;
      ctx.fillRect(x - 1, y - 1, bw + 2, p.armor > 0 ? 7 : 5);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.fillRect(x, y, bw, 3);
      ctx.fillStyle = p.hp > 50 ? PALETTE.defuse : p.hp > 20 ? '#f2b84b' : PALETTE.bomb;
      ctx.fillRect(x, y, (bw * Math.max(0, p.hp)) / 100, 3);
      if (p.armor > 0) {
        ctx.fillStyle = '#b7c4d3';
        ctx.fillRect(x, y + 4, (bw * Math.min(100, p.armor)) / 100, 1.5);
      }
    }
  }

  /**
   * Names above the pawns with their mode badges, nudged apart where they would overlap, and kept out of the HUD
   * (`chooseLabelSpot`): where every spot around a pawn is under the HUD, its text is left out (the dot stays).
   */
  private drawLabels(f: RenderFrame, poses: ReadonlyMap<PlayerId, Pose>, r: number): void {
    const { ctx } = this;
    const v = this.viewValue;
    const size = labelSize(r);
    const font = `600 ${size}px ${DISPLAY_FONT}`;
    const smallFont = `700 ${Math.max(8, size - 3)}px ${DISPLAY_FONT}`;
    const spelled = this.cam.zoom >= 2;
    const placed: ScreenRect[] = [];
    // The HUD, and the outside of the canvas (a label half off the edge is as unreadable).
    const { width: cw, height: ch } = this.vp;
    const avoid: ScreenRect[] = [...(f.avoid ?? []), { x: -1e4, y: -1e4, w: 1e4, h: 3e4 }, { x: cw, y: -1e4, w: 1e4, h: 3e4 }, { x: -1e4, y: -1e4, w: 3e4, h: 1e4 }, { x: -1e4, y: ch, w: 3e4, h: 1e4 }];
    let dropped = 0;
    // Living first so they get the best spots; the human first of all.
    const pawns = [...f.scene.cur.pawns].sort((a, b) => labelRank(a, f.human) - labelRank(b, f.human));
    for (const p of pawns) {
      const pose = poses.get(p.id);
      const s = worldToScreen(v, pose ?? p.pos);
      const badge = statusBadge(f.scene.statusOf(p.id)?.mode ?? null, p.id === f.human, p.alive);
      const nameW = this.textWidth(p.id, font);
      let badgeW = 0;
      if (badge.tone === 'alert') badgeW = this.textWidth('LIVE', smallFont) + 8 + 4;
      else if (badge.tone === 'subtle' || badge.tone === 'dead') badgeW = spelled ? this.textWidth(badge.text, smallFont) + 4 : badge.tone === 'subtle' ? 9 : 0;
      const w = nameW + badgeW;
      const h = size + 2;
      const lift = r + 4;
      const candidates: Point2[] = [
        { x: s.x - w / 2, y: s.y - lift - h },
        { x: s.x + r + 6, y: s.y - h / 2 },
        { x: s.x - w / 2, y: s.y + r + (p.alive && p.hp < 100 ? 12 : 4) },
        { x: s.x - r - 6 - w, y: s.y - h / 2 },
        { x: s.x - w / 2, y: s.y - lift - 2 * h },
      ];
      const at = chooseLabelSpot(candidates, w, h, placed, avoid);
      if (at === null) {
        // Only the HUD counts as dropped; a pawn off or at the edge of the canvas just has no room.
        if (s.x >= 0 && s.y >= 0 && s.x <= cw && s.y <= ch) dropped++;
        continue;
      }
      placed.push({ x: at.x, y: at.y, w, h });
      const color = !p.alive ? PALETTE.dead : badge.tone === 'human' ? PALETTE.human : PALETTE.sand;
      haloText(ctx, p.id, at.x, at.y + h / 2, font, color, 'left', 'middle');
      const bx = at.x + nameW + 4;
      const by = at.y + h / 2;
      if (badge.tone === 'alert') {
        const bw = badgeW - 4;
        ctx.beginPath();
        ctx.roundRect(bx, by - (size - 1) / 2 - 1, bw, size + 1, 3);
        ctx.fillStyle = PALETTE.live;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = PALETTE.ink;
        ctx.stroke();
        ctx.font = smallFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#1c0218';
        ctx.fillText('LIVE', bx + bw / 2, by + 0.5);
      } else if (spelled && (badge.tone === 'subtle' || badge.tone === 'dead')) {
        ctx.globalAlpha = badge.tone === 'subtle' ? 0.62 : 0.75;
        haloText(ctx, badge.text, bx, by + 0.5, smallFont, PALETTE.sandDim, 'left', 'middle');
        ctx.globalAlpha = 1;
      } else if (badge.tone === 'subtle') {
        // A small hollow "play" triangle: the pawn is replaying its recording.
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(bx + 1, by - 3.5);
        ctx.lineTo(bx + 6.5, by);
        ctx.lineTo(bx + 1, by + 3.5);
        ctx.closePath();
        ctx.lineWidth = 3;
        ctx.strokeStyle = PALETTE.ink;
        ctx.stroke();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = PALETTE.sandDim;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    this.labels = { drawn: placed, dropped };
  }

  private drawAim(pose: Pose, aim: Point2, r: number): void {
    const { ctx } = this;
    const s = worldToScreen(this.viewValue, pose);
    const dx = aim.x - s.x;
    const dy = aim.y - s.y;
    const d = Math.hypot(dx, dy);
    if (d < r * 2.5) return;
    const ux = dx / d;
    const uy = dy / d;
    ctx.setLineDash([2, 5]);
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = PALETTE.human;
    ctx.lineWidth = 1.25;
    line(ctx, s.x + ux * (r + 8), s.y + uy * (r + 8), aim.x - ux * 7, aim.y - uy * 7);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private textWidth(text: string, font: string): number {
    const key = `${font}|${text}`;
    let w = this.textWidths.get(key);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      this.textWidths.set(key, w);
    }
    return w;
  }
}

/**
 * The radar drawn once at the current device scale (dusk tint baked in), blitted 1:1 per frame.
 * Covers the visible part of the radar plus a quarter-view margin on each side when zoomed in.
 */
class RadarCache {
  rebuilds = 0;
  private canvas: HTMLCanvasElement | null = null;
  /** Device px per radar px, and the cached radar rectangle (radar px, integers). */
  private s = 0;
  private rx = 0;
  private ry = 0;
  private rw = 0;
  private rh = 0;

  draw(ctx: CanvasRenderingContext2D, img: CanvasImageSource, v: View, vp: Viewport, dpr: number): void {
    const S = v.scale * dpr;
    if (!(S > 0)) return;
    const size = v.map.size;
    const x0 = Math.max(0, -v.ox / v.scale);
    const y0 = Math.max(0, -v.oy / v.scale);
    const x1 = Math.min(size, (vp.width - v.ox) / v.scale);
    const y1 = Math.min(size, (vp.height - v.oy) / v.scale);
    if (x1 <= x0 || y1 <= y0) return;
    const covered = this.canvas !== null && this.s === S && x0 >= this.rx && y0 >= this.ry && x1 <= this.rx + this.rw && y1 <= this.ry + this.rh;
    if (!covered) this.rebuild(img, S, size, x0, y0, x1, y1);
    if (this.canvas === null) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.canvas, Math.round((v.ox + this.rx * v.scale) * dpr), Math.round((v.oy + this.ry * v.scale) * dpr));
  }

  private rebuild(img: CanvasImageSource, S: number, size: number, x0: number, y0: number, x1: number, y1: number): void {
    let mx = (x1 - x0) * 0.25;
    let my = (y1 - y0) * 0.25;
    if ((x1 - x0 + 2 * mx) * (y1 - y0 + 2 * my) * S * S > MAX_CACHE_PX) {
      mx = 0;
      my = 0;
    }
    const rx = Math.max(0, Math.floor(x0 - mx));
    const ry = Math.max(0, Math.floor(y0 - my));
    const rw = Math.min(size, Math.ceil(x1 + mx)) - rx;
    const rh = Math.min(size, Math.ceil(y1 + my)) - ry;
    const c = this.canvas ?? document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(rw * S));
    c.height = Math.max(1, Math.ceil(rh * S));
    const g = c.getContext('2d');
    if (g === null) return;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, rx, ry, rw, rh, 0, 0, rw * S, rh * S);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = RADAR_TINT;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-over';
    this.canvas = c;
    this.s = S;
    this.rx = rx;
    this.ry = ry;
    this.rw = rw;
    this.rh = rh;
    this.rebuilds++;
  }
}

/** Disc radius (CSS px): grows gently with zoom. */
export function pawnRadius(v: View): number {
  return Math.min(11, Math.max(5, v.scale * 7.2));
}

function labelSize(r: number): number {
  return Math.round(Math.min(14, Math.max(10.5, 8 + r * 0.45)));
}

function drawRank(p: PawnObs, human: PlayerId | null): number {
  return p.id === human ? 2 : p.team === 'T' ? 1 : 0;
}

function labelRank(p: PawnObs, human: PlayerId | null): number {
  return p.id === human ? 0 : p.alive ? 1 : 2;
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function cross(ctx: CanvasRenderingContext2D, x: number, y: number, k: number): void {
  ctx.beginPath();
  ctx.moveTo(x - k, y - k);
  ctx.lineTo(x + k, y + k);
  ctx.moveTo(x - k, y + k);
  ctx.lineTo(x + k, y - k);
  ctx.stroke();
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, width: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.lineWidth = width + 2;
  ctx.strokeStyle = PALETTE.ink;
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function haloText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
  color: string,
  align: CanvasTextAlign,
  baseline: CanvasTextBaseline,
): void {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.lineWidth = 3;
  ctx.strokeStyle = PALETTE.ink;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
