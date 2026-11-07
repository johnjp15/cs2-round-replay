/**
 * H1: the 3D page (docs/app3d.md). Loads the round and the CS2 world, builds the app's Session (src/app/session.ts,
 * unchanged driver logic: checkpoints, takeover, input tape) on the 3D engine (Sim3DHost, src/sim3d), runs the 64 Hz
 * loop (src/app/loop.ts) from requestAnimationFrame and draws the Three.js view (renderer3d.ts) and the HUD
 * (hud3d.ts).
 *
 * The page starts **watching** (nobody controls cart; the round plays as recorded) with a spectator camera: third
 * person behind the followed pawn (cart), first person through its eyes, or free fly (V cycles; Z / X pick another
 * player). E or "Take control of cart" hands him to the player from that tick on (a speed other than 1× drops to 1×):
 * first-person camera at his eye (64 standing, 46 crouched), pointer-lock mouse look, WASD, Space, Ctrl, Shift,
 * mouse 1, R, 1–5, E (input3d.ts). Dead, the camera goes back to spectating. Restart watches again.
 *
 * URL parameters: `?seed=<int>` (default 1), `?human=cart` plays cart from the start, `?sens=<CS2 sensitivity>`
 * (default 2), `?fov=<deg>` (horizontal-ish vertical FOV of the camera, default 74).
 */
import tuningJson from '../../data/tuning.json';
import type { PlayerId, Vec3, WeaponId } from '../contracts/index';
import { summarize, tickOf } from '../core/index';
import { FixedLoop, RateMeter, TICK_MS } from '../app/loop';
import { Scene, interpolationAlpha, lerpAngle } from '../app/scene';
import { Session, parseSessionData, type SessionData } from '../app/session';
import { startHuman, takeoverButtonView } from '../app/takeover';
import { anglesTo, poseHitboxes } from '../engine/hitboxes';
import { sim3dHostFactory, worldMesh, type Sim3DHost } from '../sim3d/index';
import type { MapGeometry } from '../sim2d/index';
import { loadAssets3d } from './assets3d';
import { ControlsDom } from './controls-dom';
import { MIRAGE_RADAR } from './coords';
import { Hud3D } from './hud3d';
import { DEFAULT_SENSITIVITY, flyStep, fpsInput, turnView, wrapYaw, type Look } from './input3d';
import { Renderer3D, type DrawPawn, type DrawTracer } from './renderer3d';
import { RadarSampler, buildWorldTiles, floorArt, type RgbaImage } from './world-mesh';

type Phase = 'ready' | 'running' | 'paused';
export type CameraMode = 'follow' | 'pov' | 'free';
const CAMERA_MODES: readonly CameraMode[] = ['follow', 'pov', 'free'];
/** Tracers last this long (ticks of round time). */
const TRACER_TICKS = 10;
/** Third-person camera: distance behind and height above the followed pawn's eye (units). */
const FOLLOW_BACK = 150;
const FOLLOW_UP = 28;
const FREE_SPEED = 600;

export interface App3DStats {
  readonly phase: Phase;
  readonly tick: number;
  readonly frames: number;
  readonly ticksRun: number;
  readonly droppedTicks: number;
  readonly speed: number;
  readonly human: PlayerId | null;
  readonly takeoverTick: number | null;
  readonly canTakeControl: boolean;
  readonly fps: number;
  readonly tps: number;
  readonly camera: CameraMode;
  readonly followed: PlayerId;
  readonly look: Look;
  readonly locked: boolean;
  readonly triangles: number;
  readonly humanShots: number;
  readonly humanHits: number;
  readonly costMs: { readonly sim: number; readonly draw: number; readonly render: number; readonly hud: number };
  readonly hud: { readonly hp: string; readonly clock: string; readonly mode: string; readonly killfeed: number };
}

declare global {
  interface Window {
    __cs2sim3d?: {
      stats: () => App3DStats;
      session: () => Session;
      takeControl: () => void;
      /** Look at a pawn's head hitbox (yaw and pitch), as if the mouse had moved there. */
      aimAt: (id: PlayerId) => Look;
      setLook: (yaw: number, pitch: number) => void;
      /** Mouse counts as under pointer lock (automation: headless pages can't lock). */
      mouse: (dx: number, dy: number) => void;
      camera: (mode: CameraMode, id?: PlayerId) => void;
      /** Free camera at a Source position with these angles. */
      fly: (x: number, y: number, z: number, yaw: number, pitch: number) => void;
      /** Seek to video second t (run ahead or rewind with the Session's seek). */
      seek: (t: number) => void;
      summary: () => string;
      /** The renderer (debugging, benchmarks). */
      debug: () => Renderer3D;
    };
  }
}

function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const e = document.getElementById(id);
  if (!(e instanceof type)) throw new Error(`#${id} missing`);
  return e;
}

function isTouchOnly(): boolean {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/** Decode an image to RGBA (for the floor colours). */
function rgbaOf(img: HTMLImageElement): RgbaImage {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('no 2D canvas');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { width: d.width, height: d.height, data: d.data };
}

class App3D {
  private readonly data: SessionData;
  private readonly world: MapGeometry;
  private readonly seed: number;
  private readonly renderer: Renderer3D;
  private readonly hud: Hud3D;
  private readonly controls: ControlsDom;
  private readonly loop: FixedLoop;
  private readonly fpsMeter = new RateMeter(1000);
  private readonly tpsMeter = new RateMeter(1000);
  private readonly touchOnly = isTouchOnly();
  private readonly sensitivity: number;
  private readonly fov: number;
  private session: Session;
  private scene: Scene;
  private phase: Phase = 'ready';
  private camMode: CameraMode = 'follow';
  private followed: PlayerId = 'cart';
  /** The human's view (mouse look), or the spectator's orbit / free-fly view. */
  private look: Look = { yaw: 0, pitch: 0 };
  /** Spectator orbit offsets in follow mode (mouse under pointer lock). */
  private orbit: Look = { yaw: 0, pitch: 12 };
  private freePos: Vec3 = { x: -1500, y: 500, z: 200 };
  private tracers: { from: Vec3; to: Vec3; team: 'T' | 'CT'; tick: number }[] = [];
  private lastHumanShotMs = -1e9;
  private lastHit: { ms: number; head: boolean } | null = null;
  private humanShots = 0;
  private humanHits = 0;
  private eyeZ = 64;
  private lastFrame: number | null = null;
  private frames = 0;
  private seekResume: Phase | null = null;
  /** Smoothed per-frame costs (ms): the ticks, the whole draw, the WebGL render call, the HUD. */
  private cost = { sim: 0, draw: 0, render: 0, hud: 0 };
  private readonly buttons: { start: HTMLButtonElement; pause: HTMLButtonElement; restart: HTMLButtonElement; takeover: HTMLButtonElement; camera: HTMLButtonElement; speeds: HTMLButtonElement[] };

  constructor(data: SessionData, world: MapGeometry, radar: HTMLImageElement, seed: number, human: PlayerId | null, sensitivity: number, fov: number, resolution: number) {
    this.data = data;
    this.world = world;
    this.seed = seed;
    this.sensitivity = sensitivity;
    this.fov = fov;
    const canvas = el('view', HTMLCanvasElement);
    const rgba = rgbaOf(radar);
    const art = floorArt(rgba);
    const { tiles } = buildWorldTiles(world, new RadarSampler(art, MIRAGE_RADAR), MIRAGE_RADAR, rgba);
    this.session = this.newSession(human);
    this.renderer = new Renderer3D(canvas, tiles, art, this.session.model.players.map((p) => ({ id: p.id, team: p.team })), resolution);
    this.hud = new Hud3D(radar, MIRAGE_RADAR);
    this.loop = new FixedLoop(() => this.stepOnce(), { paused: true });
    this.scene = this.ready(this.session);
    this.controls = new ControlsDom(canvas, {
      onSlot: (slot) => {
        if (this.playing()) this.session.requestWeaponSlot(slot);
      },
      onKey: (code) => this.onKey(code),
      onFire: () => undefined,
    });
    this.buttons = {
      start: el('start', HTMLButtonElement),
      pause: el('pause', HTMLButtonElement),
      restart: el('restart', HTMLButtonElement),
      takeover: el('takeover', HTMLButtonElement),
      camera: el('camera', HTMLButtonElement),
      speeds: [...document.querySelectorAll<HTMLButtonElement>('button[data-speed]')],
    };
    this.wire();
    this.updateControls();
    window.__cs2sim3d = {
      stats: () => this.stats(),
      session: () => this.session,
      takeControl: () => this.takeControl(),
      aimAt: (id) => this.aimAt(id),
      setLook: (yaw, pitch) => {
        this.look = { yaw: wrapYaw(yaw), pitch: Math.max(-89, Math.min(89, pitch)) };
      },
      mouse: (dx, dy) => this.controls.addMouse(dx, dy),
      camera: (mode, id) => {
        this.camMode = mode;
        if (id !== undefined) this.followed = id;
        this.updateControls();
      },
      fly: (x, y, z, yaw, pitch) => {
        this.camMode = 'free';
        this.freePos = { x, y, z };
        this.look = { yaw: wrapYaw(yaw), pitch };
        this.updateControls();
      },
      seek: (t) => this.startSeek(t),
      summary: () => summarize(this.session.model, this.session.log()).headline,
      debug: () => this.renderer,
    };
    requestAnimationFrame(this.frame);
  }

  private host(s: Session = this.session): Sim3DHost {
    return s.host as unknown as Sim3DHost;
  }

  private newSession(human: PlayerId | null): Session {
    return new Session({ ...this.data, seed: this.seed, human, playable: 'cart', host: sim3dHostFactory(this.world) });
  }

  private playing(): boolean {
    const h = this.session.human;
    return this.phase === 'running' && this.seekResume === null && h !== null && this.scene.pawn(h)?.alive === true;
  }

  private ready(s: Session): Scene {
    if (this.loop.speed !== 1) s.control({ type: 'speed', x: this.loop.speed });
    s.step();
    this.phase = 'ready';
    this.loop.paused = true;
    this.loop.reset();
    this.tracers = [];
    const sc = new Scene(s.observe(), s.lastAct, this.host(s).activeEffects(), null);
    const cart = sc.pawn(this.followed);
    if (cart !== null) this.orbit = { yaw: 0, pitch: 12 };
    if (s.human !== null && cart !== null) this.look = { yaw: cart.yaw, pitch: cart.pitch };
    return sc;
  }

  private stepOnce(): void {
    const s = this.session;
    const act = s.step();
    const o = s.observe();
    const h = this.host();
    const tick = o.tick - 1;
    for (const shot of h.shots()) {
      const p = o.pawns.find((q) => q.id === shot.shooter);
      if (p === undefined) continue;
      this.tracers.push({ from: shot.from, to: shot.to, team: p.team, tick });
      if (shot.shooter === s.human) {
        this.humanShots++;
        this.lastHumanShotMs = performance.now();
      }
    }
    for (const e of o.events) {
      if (e.type === 'damage' && e.attacker !== null && e.attacker === s.human && !e.scripted) {
        this.humanHits++;
        this.lastHit = { ms: performance.now(), head: e.hitgroup === 'head' };
      }
    }
    this.tracers = this.tracers.filter((t) => tick - t.tick < TRACER_TICKS);
    this.scene.ingest(o, act, h.activeEffects());
  }

  private takeControl(): void {
    const s = this.session;
    if (this.touchOnly || this.seekResume !== null || !s.canTakeControl) return;
    if (this.loop.speed !== 1) {
      this.loop.speed = 1;
      s.control({ type: 'speed', x: 1 });
    }
    s.takeControl();
    const p = this.scene.pawn(s.human ?? 'cart');
    if (p !== null) this.look = { yaw: p.yaw, pitch: p.pitch };
    this.controls.release();
    if (this.phase === 'ready') this.start();
    void this.controls.lock();
    this.updateControls();
  }

  private start(): void {
    if (this.phase !== 'ready') return;
    this.phase = 'running';
    this.loop.reset();
    this.loop.paused = false;
  }

  private restart(): void {
    this.session.cancelSeek();
    this.seekResume = null;
    this.session.restart();
    this.scene = this.ready(this.session);
    this.updateControls();
  }

  private startSeek(t: number): void {
    const s = this.session;
    if (s.seeking !== null) s.cancelSeek();
    const target = tickOf(Math.max(0, t));
    if (target === s.tick) return;
    this.seekResume ??= this.phase === 'ready' ? 'paused' : this.phase;
    this.loop.paused = true;
    s.beginSeek(target / 64);
  }

  private advanceSeek(): void {
    const s = this.session;
    const t0 = performance.now();
    let p = s.seeking;
    while (p !== null && !p.done && performance.now() - t0 < 12) p = s.advanceSeek(16);
    if (p === null || p.done) {
      this.scene = new Scene(s.observe(), s.lastAct, this.host().activeEffects(), null);
      this.tracers = [];
      this.phase = this.seekResume ?? 'paused';
      this.seekResume = null;
      this.loop.reset();
      this.loop.paused = this.phase !== 'running';
      this.updateControls();
    }
  }

  private aimAt(id: PlayerId): Look {
    const me = this.scene.pawn(this.session.human ?? this.followed);
    const t = this.scene.pawn(id);
    if (me === null || t === null) return this.look;
    const eye = { x: me.pos.x, y: me.pos.y, z: me.pos.z + (me.crouching ? 46 : 64) };
    const head = (poseHitboxes(t, this.data.tuning.damage)[0] as { a: Vec3 }).a;
    const a = anglesTo(eye, head);
    this.look = { yaw: wrapYaw(a.yaw), pitch: a.pitch };
    return this.look;
  }

  private alivePawns(): PlayerId[] {
    return this.scene.cur.pawns.filter((p) => p.alive).map((p) => p.id);
  }

  private onKey(code: string): boolean {
    const s = this.session;
    if (code === 'KeyE' && s.human === null) {
      this.takeControl();
      return true;
    }
    if (code === 'KeyV' && !this.playing()) {
      this.camMode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.camMode) + 1) % CAMERA_MODES.length] as CameraMode;
      if (this.camMode === 'free') {
        const p = this.scene.pawn(this.followed);
        if (p !== null) this.freePos = { x: p.pos.x, y: p.pos.y, z: p.pos.z + 120 };
        this.look = { yaw: p?.yaw ?? 0, pitch: 20 };
      }
      this.updateControls();
      return true;
    }
    if ((code === 'KeyZ' || code === 'KeyX') && !this.playing()) {
      const alive = this.alivePawns();
      if (alive.length > 0) {
        const i = alive.indexOf(this.followed);
        const n = code === 'KeyX' ? 1 : -1;
        this.followed = alive[(Math.max(0, i) + n + alive.length) % alive.length] as PlayerId;
      }
      return true;
    }
    if (code === 'KeyP') {
      this.togglePause();
      return true;
    }
    return false;
  }

  private togglePause(): void {
    if (this.phase === 'ready') return;
    const paused = this.phase === 'running';
    this.phase = paused ? 'paused' : 'running';
    this.loop.paused = paused;
    this.session.control({ type: 'pause', paused });
    this.updateControls();
  }

  private wire(): void {
    const b = this.buttons;
    const on = (button: HTMLButtonElement, f: () => void): void => {
      button.addEventListener('click', () => {
        f();
        button.blur();
        this.updateControls();
      });
    };
    on(b.start, () => this.start());
    on(b.pause, () => this.togglePause());
    on(b.restart, () => this.restart());
    on(b.takeover, () => this.takeControl());
    on(b.camera, () => this.onKey('KeyV'));
    for (const sb of b.speeds) {
      on(sb, () => {
        this.loop.speed = Number(sb.dataset['speed']);
        this.session.control({ type: 'speed', x: this.loop.speed });
      });
    }
  }

  private updateControls(): void {
    const b = this.buttons;
    const s = this.session;
    b.start.disabled = this.phase !== 'ready';
    b.pause.disabled = this.phase === 'ready';
    b.pause.textContent = this.phase === 'paused' ? 'Resume' : 'Pause';
    const v = takeoverButtonView(s.human, s.playable, s.takeControlBlocked(), this.touchOnly, this.seekResume !== null);
    const label = b.takeover.querySelector('span');
    if (label !== null && label.textContent !== v.label) label.textContent = v.label;
    b.takeover.disabled = v.disabled;
    b.takeover.title = v.title;
    b.takeover.setAttribute('aria-pressed', String(v.pressed));
    const cam = b.camera.querySelector('span');
    const camText = this.playing() ? 'Camera: first person' : `Camera: ${this.camMode === 'pov' ? 'eyes' : this.camMode}`;
    if (cam !== null && cam.textContent !== camText) cam.textContent = camText;
    b.camera.disabled = this.playing();
    for (const sb of b.speeds) sb.setAttribute('aria-pressed', String(Number(sb.dataset['speed']) === this.loop.speed));
  }

  private readonly frame = (now: number): void => {
    const dt = this.lastFrame === null ? 0 : Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    if (this.seekResume !== null) this.advanceSeek();
    const mouse = this.controls.takeMouse();
    const s = this.session;
    if (this.playing()) {
      this.look = turnView(this.look, mouse.dx, mouse.dy, this.sensitivity);
      s.setHumanInput(fpsInput(s.human as PlayerId, this.controls.controls(), this.look));
    } else if (this.camMode === 'free') {
      this.look = turnView(this.look, mouse.dx, mouse.dy, this.sensitivity);
      this.freePos = flyStep(this.freePos, this.look, this.controls.controls(), dt / 1000, FREE_SPEED);
    } else if (this.camMode === 'follow') {
      this.orbit = turnView(this.orbit, mouse.dx, mouse.dy, this.sensitivity);
    }
    const t0 = performance.now();
    const n = this.loop.advance(dt);
    const t1 = performance.now();
    this.frames++;
    this.fpsMeter.add(now, 1);
    this.tpsMeter.add(now, n);
    if (n > 0 || this.frames % 30 === 0) this.updateControls();
    this.draw(now);
    const t2 = performance.now();
    this.cost = { sim: this.cost.sim * 0.95 + (t1 - t0) * 0.05, draw: this.cost.draw * 0.95 + (t2 - t1) * 0.05, render: this.cost.render, hud: this.cost.hud };
    requestAnimationFrame(this.frame);
  };

  /** Camera, pawns and effects for this frame. */
  private draw(now: number): void {
    const s = this.session;
    const alpha = interpolationAlpha(this.loop.pending, TICK_MS);
    const human = s.human;
    const humanPawn = human === null ? null : this.scene.pawn(human);
    const firstPerson = humanPawn !== null && humanPawn.alive;
    if (!firstPerson) {
      const f = this.scene.pawn(this.followed);
      if (f === null || !f.alive) {
        const next = this.alivePawns()[0];
        if (next !== undefined && this.camMode !== 'free' && f !== null && this.scene.deaths.has(f.id) && this.scene.cur.tick - (this.scene.deaths.get(f.id) ?? 0) > 128) this.followed = next;
      }
    }
    const viewId = firstPerson ? (human as PlayerId) : this.followed;
    const vp = this.scene.pose(viewId, alpha);
    const vo = this.scene.pawn(viewId);
    const crouch = vo?.crouching ?? false;
    const wantEye = crouch ? 46 : 64;
    this.eyeZ += (wantEye - this.eyeZ) * Math.min(1, 0.35);
    let eye: Vec3;
    let yaw: number;
    let pitch: number;
    if (firstPerson || this.camMode === 'pov') {
      eye = vp === null ? this.freePos : { x: vp.x, y: vp.y, z: vp.z + this.eyeZ };
      if (firstPerson) {
        yaw = this.look.yaw;
        pitch = this.look.pitch;
      } else {
        const prevPitch = this.scene.prev?.pawns.find((p) => p.id === viewId)?.pitch ?? vo?.pitch ?? 0;
        yaw = vp?.yaw ?? 0;
        pitch = prevPitch + ((vo?.pitch ?? 0) - prevPitch) * alpha;
      }
    } else if (this.camMode === 'follow' && vp !== null) {
      yaw = lerpAngle(vp.yaw, vp.yaw + this.orbit.yaw, 1);
      pitch = this.orbit.pitch;
      const yr = (yaw * Math.PI) / 180;
      const pr = (pitch * Math.PI) / 180;
      const head = { x: vp.x, y: vp.y, z: vp.z + this.eyeZ + FOLLOW_UP };
      let back = FOLLOW_BACK;
      const want = { x: head.x - Math.cos(pr) * Math.cos(yr) * back, y: head.y - Math.cos(pr) * Math.sin(yr) * back, z: head.z + Math.sin(pr) * back };
      // Keep the camera out of walls: pull it in to just before the first surface between the head and it.
      const fr = this.world.traceLine(head.x, head.y, head.z, want.x, want.y, want.z);
      if (fr < 1) back = Math.max(10, back * fr - 8);
      eye = { x: head.x - Math.cos(pr) * Math.cos(yr) * back, y: head.y - Math.cos(pr) * Math.sin(yr) * back, z: head.z + Math.sin(pr) * back };
    } else {
      eye = this.freePos;
      yaw = this.look.yaw;
      pitch = this.look.pitch;
    }
    const watchingTeam = human === null ? null : this.scene.pawn(human)?.team;
    const pawns: DrawPawn[] = this.scene.cur.pawns.map((p) => {
      const pose = this.scene.pose(p.id, alpha);
      return {
        id: p.id,
        team: p.team,
        pos: pose === null ? p.pos : { x: pose.x, y: pose.y, z: pose.z },
        yaw: pose?.yaw ?? p.yaw,
        pitch: p.pitch,
        crouching: p.crouching,
        alive: p.alive,
        human: p.id === human,
        tag: p.alive && (watchingTeam === null || watchingTeam === undefined || p.team === watchingTeam),
        hidden: (firstPerson || this.camMode === 'pov') && p.id === viewId && p.alive,
      };
    });
    const rt = this.scene.renderTick(alpha);
    const tracers: DrawTracer[] = this.tracers.map((t) => {
      // The human's own tracers start at the viewmodel's muzzle, a little right of and below the eye.
      return { from: t.from, to: t.to, team: t.team, age: Math.min(1, Math.max(0, (rt - t.tick) / TRACER_TICKS)) };
    });
    const o = this.scene.cur;
    const b = o.round.bomb;
    const bomb = b.pos !== null && b.state !== 'carried' ? { pos: b.pos, planted: b.state === 'planted' } : null;
    const weapon: WeaponId | null = firstPerson && humanPawn !== null ? humanPawn.weapon : null;
    const r0 = performance.now();
    this.renderer.render({
      pawns,
      eye,
      yaw,
      pitch,
      fovDeg: this.fov,
      tracers,
      effects: this.scene.effects,
      bomb,
      viewmodel: weapon === null ? null : { weapon, sinceShot: (now - this.lastHumanShotMs) / 1000 },
      nowMs: now,
    });
    const r1 = performance.now();
    const over = o.round.phase === 'over' && o.round.endTick !== null && o.tick > o.round.endTick + 128;
    const mode = firstPerson
      ? `You: ${human} · Esc frees the mouse`
      : human !== null
        ? `${human} is dead · spectating ${this.followed} · V camera · Z / X player`
        : `Watching · ${this.camMode === 'free' ? 'free camera' : this.followed} · ${s.canTakeControl && !this.touchOnly ? 'E: take control of cart · ' : ''}V camera · Z / X player`;
    this.hud.update({
      scene: this.scene,
      clock: s.clock,
      viewer: viewId,
      human,
      at: { x: eye.x, y: eye.y, yaw },
      mode: this.phase === 'ready' && human === null ? 'Press Start to watch, or E to play cart' : mode,
      crosshair: firstPerson,
      hit: this.lastHit === null ? null : { ageMs: now - this.lastHit.ms, head: this.lastHit.head },
      perf: `${this.fpsMeter.rate(now).toFixed(0)} fps · ${this.tpsMeter.rate(now).toFixed(0)} ticks/s · ${this.loop.speed}×`,
      summary: over ? `${summarize(s.model, s.log()).headline}<small>Restart to watch again, or take control of cart earlier.</small>` : null,
      tick: o.tick,
      nowMs: now,
    });
    const r2 = performance.now();
    this.cost.render = this.cost.render * 0.95 + (r1 - r0) * 0.05;
    this.cost.hud = this.cost.hud * 0.95 + (r2 - r1) * 0.05;
  }

  private stats(): App3DStats {
    const now = performance.now();
    const text = (id: string): string => document.getElementById(id)?.textContent ?? '';
    return {
      phase: this.phase,
      tick: this.scene.cur.tick,
      frames: this.frames,
      ticksRun: this.loop.ticksRun,
      droppedTicks: this.loop.droppedTicks,
      speed: this.loop.speed,
      human: this.session.human,
      takeoverTick: this.session.takeoverTick,
      canTakeControl: !this.touchOnly && this.session.canTakeControl,
      fps: this.fpsMeter.rate(now),
      tps: this.tpsMeter.rate(now),
      camera: this.camMode,
      followed: this.followed,
      look: this.look,
      locked: this.controls.locked,
      triangles: this.renderer.drawnTriangles,
      humanShots: this.humanShots,
      humanHits: this.humanHits,
      costMs: { ...this.cost },
      hud: { hp: text('hp'), clock: text('clock'), mode: text('mode'), killfeed: document.getElementById('killfeed')?.childElementCount ?? 0 },
    };
  }
}

async function boot(): Promise<void> {
  const status = el('status', HTMLElement);
  try {
    const params = new URLSearchParams(window.location.search);
    const seedParam = Number(params.get('seed') ?? '1');
    const seed = Number.isInteger(seedParam) ? seedParam : 1;
    const sens = Number(params.get('sens') ?? String(DEFAULT_SENSITIVITY));
    const fov = Number(params.get('fov') ?? '74');
    const res = Number(params.get('res') ?? '1');
    const a = await loadAssets3d();
    const data = parseSessionData(a.round, a.nav, tuningJson, a.vision, a.world3d);
    const world = worldMesh(a.world3d.geometry);
    new App3D(data, world, a.radar, seed, startHuman(params.get('human')), Number.isFinite(sens) && sens > 0 ? sens : DEFAULT_SENSITIVITY, Number.isFinite(fov) && fov > 30 && fov < 130 ? fov : 74, Number.isFinite(res) && res >= 0.25 && res <= 2 ? res : 1);
    status.hidden = true;
  } catch (err) {
    status.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  }
}

void boot();
