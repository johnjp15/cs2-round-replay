/**
 * H1: the 3D page (docs/app3d.md). Loads the round and the CS2 world, builds the app's Session (src/app/session.ts,
 * unchanged driver logic: checkpoints, takeover, input tape) on the 3D engine (Sim3DHost, src/sim3d), runs the 64 Hz
 * loop (src/app/loop.ts) from requestAnimationFrame and draws the Three.js view (renderer3d.ts) and the HUD
 * (hud3d.ts).
 *
 * The page starts **watching** (nobody controls cart; the round plays as recorded) with CS2's spectator camera
 * (U1, spectate.ts): first person through the followed pawn's eyes (cart) with its viewmodel, HUD and crosshair,
 * third person, or free fly (V cycles; mouse 1 / Space next player, mouse 2 previous; Z / X too), the spectator
 * panel, and the radar under CS2's spotting rules (radar3d.ts; the panel toggle shows everyone). E or "Take control of cart" hands him to the player from that tick on (a speed other than 1× drops to 1×):
 * first-person camera at his eye (64 standing, 46 crouched), pointer-lock mouse look, WASD, Space, Ctrl, Shift,
 * mouse 1, R, 1–5, E (input3d.ts; duck, walk, jump and use rebindable under Keys). ⛶ Fullscreen locks the keyboard
 * where the browser can, so Ctrl+W crouches forward instead of closing the tab (src/app/play-guard.ts). Dead, the
 * camera goes back to spectating. Restart watches again.
 *
 * The view is CS2's (view-cs2.ts, with sources): mouse counts × sensitivity × m_yaw / m_pitch (0.022°), no
 * acceleration; FOV 90° horizontal at 4:3, hor+ on wider screens (vertical ≈ 73.74°); scoped FOVs and the zoomed
 * sensitivity (mouse 2 with the AWP / SSG 08); viewmodel_fov 60 in its own camera; the eye eases between 64 and 46
 * through a duck. Bullets leave along view + aim punch × 2 + the inaccuracy cone (the host's H2 weapon mechanics, H2b);
 * the camera follows the "Recoil tracking" share (view_recoil_tracking, default 0.45) of the recoil plus the screen
 * shake; the crosshair stays at the screen centre (CS2's cl_crosshair_recoil 0; "Crosshair follows recoil" puts it
 * where the next bullet goes).
 *
 * URL parameters: `?seed=<int>` (default 1), `?human=cart` plays cart from the start, `?sens=<CS2 sensitivity>`
 * (default 1.25; also the settings fields, kept in localStorage), `?res=<render scale>`.
 */
import tuningJson from '../../data/tuning.json';
import { parseMapId, type Observe, type PlayerId, type Team, type Tuning, type Vec3, type WeaponId } from '../contracts/index';
import { summarize, tickOf } from '../core/index';
import { FixedLoop, TICK_MS } from '../app/loop';
import { Scene, interpolationAlpha, lerpAngle } from '../app/scene';
import { Session, parseSessionData, type SessionData } from '../app/session';
import { SummaryCache } from '../app/run-entries';
import { weaponName } from '../app/hud-model';
import { startHuman, takeoverButtonView } from '../app/takeover';
import { keyMapFor } from '../app/input';
import { KeyBindsStore, pageStorage } from '../app/keybinds';
import { KeyBindsDom } from '../app/keybinds-dom';
import { PlayGuard } from '../app/play-guard';
import { anglesTo, poseHitboxes } from '../engine/hitboxes';
import { sim3dHostFactory, worldMesh, type Sim3DHost } from '../sim3d/index';
import type { MapGeometry } from '../sim2d/index';
import { loadAssets3d, loadFreePlayAssets3d, scenarioList } from './assets3d';
import { freePlay3d, mountScenarioPickers, pickScenario, recording3d, type Scenario3d } from './scenarios3d';
import { ControlsDom } from './controls-dom';
import { Hud3D } from './hud3d';
import { runBench } from './bench3d';
import { FPS_PRESETS, FrameDriver, parseFpsLimit, type FpsLimit } from './frame-driver';
import { BucketRate, FrameProbe, Ring, displayHz, meterText } from './perf';
import { DEFAULT_SENSITIVITY, crosshairOffsetPx, flyStep, fpsInput, turnView, wrapYaw, type Look } from './input3d';
import { RadarTracker, type RadarMark, type RadarRules } from './radar3d';
import { Renderer3D, type DrawPawn, type DrawTracer } from './renderer3d';
import { aimOffsetPx, cycleTarget, nextSpectateMode, spectatable, spectatePanel } from './spectate';
import { A1Mount } from './audio/mount';
import { RadarSampler, buildRenderTiles, buildWorldTiles, floorArt, type RgbaImage } from './world-mesh';
import { decodeRenderMesh } from './render-package';
import {
  DEFAULT_ZOOM_RATIO,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  VIEWMODEL_FOV,
  VIEWMODEL_FOV_MAX,
  VIEWMODEL_FOV_MIN,
  VIEW_RECOIL_TRACKING,
  duckStep,
  effectiveSensitivity,
  eyeHeightFor,
  verticalFov,
} from './view-cs2';

type Phase = 'ready' | 'running' | 'paused';
/** The spectator camera (spectate.ts): pov = first person through the followed pawn's eyes (the default). */
export type CameraMode = 'follow' | 'pov' | 'free';
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
  /** play-guard.ts: the leave-site guard is on, the keyboard is locked (fullscreen, Chromium), the duck key. */
  readonly guard: { readonly leaveGuard: boolean; readonly keyboardLocked: boolean; readonly fullscreen: boolean; readonly duckKey: string };
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
      /** The camera's FOVs and the CS2 settings in use. */
      view: () => { vfov: number; hfov: number; aspect: number; viewmodelVfov: number; sensitivity: number; effectiveSensitivity: number; zoom: number; raw: boolean };
      camera: (mode: CameraMode, id?: PlayerId) => void;
      /** U1: spectate the next (1) or previous (−1) player, as mouse 1 / mouse 2 do. */
      spectate: (dir: 1 | -1) => PlayerId;
      /** U1: the radar's rules ('cs2': CS2's spotting; 'all': everyone), as the panel toggle. */
      radarRules: (rules?: RadarRules) => RadarRules;
      /** U1: what the radar shows now (the viewer's team view), for the checks. */
      radar: () => { team: Team | null; marks: RadarMark[] };
      /** Free camera at a Source position with these angles. */
      fly: (x: number, y: number, z: number, yaw: number, pitch: number) => void;
      /** Seek to video second t (run ahead or rewind with the Session's seek). */
      seek: (t: number) => void;
      summary: () => string;
      /** The renderer (debugging, benchmarks). */
      debug: () => Renderer3D;
      /** P1: the per-frame phase timings and the frame driver (tools/bench-app3d.ts, `?bench=1`). */
      perf: PerfHooks;
      /** Deterministic test API (docs/app3d.md "Test API"; V0's video comparison). */
      test: {
        /** Stop (true) or resume (false) the frame loop's drawing; freezing also pauses a running round. */
        freeze: (on: boolean) => void;
        /** Run (or rewind) the round to observe tick `tick`, synchronously; returns the tick reached. */
        seekTick: (tick: number) => number;
        /** Spectate through a player's eyes (its sim yaw / pitch, eye 64 / 46). */
        eyes: (id: PlayerId) => void;
        /** A free camera pose (Source coordinates, degrees). */
        pose: (x: number, y: number, z: number, yaw: number, pitch: number) => void;
        /** Render one frame now at the current tick exactly (no interpolation, no easing, time = tick × 15.625 ms). */
        render: () => TestState;
        state: () => TestState;
      };
    };
  }
}

const SETTINGS_KEY = 'cs2-sim3d-settings';

/** P1: what the bench (bench3d.ts) drives. */
export interface PerfHooks {
  readonly probe: FrameProbe;
  /**
   * 'manual': the page's loop stops and the caller runs frames with `step`; an FPS limit: the page's loop with that
   * limit ('vsync': requestAnimationFrame); 'page': the page's loop with the user's setting.
   */
  driver(mode: 'manual' | 'page' | FpsLimit): void;
  /** Run one frame now (manual driver). */
  step(now: number): void;
  /** Called after every frame (both drivers). */
  onFrame: (() => void) | null;
  speed(x: number): void;
  start(): void;
  /** Three.js renderer counters of the last frame. */
  info(): { calls: number; triangles: number; programs: number; geometries: number; textures: number };
}

/** What the test API reports: the tick and the camera of the last frame drawn. */
export interface TestState {
  readonly tick: number;
  readonly t: number;
  readonly phase: string;
  readonly camera: { readonly mode: CameraMode | 'first-person'; readonly followed: PlayerId; readonly eye: Vec3 | null; readonly yaw: number | null; readonly pitch: number | null; readonly vfovDeg: number; readonly hfovDeg: number; readonly width: number; readonly height: number };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
  /** The recording's data (null in free play: H3's Scenario3d builds the session). */
  private readonly data: SessionData | null;
  /** H3: the scenario this page plays (the recorded round by default), its map and its free-play session factory. */
  private readonly h3: Scenario3d;
  private readonly tuning: Tuning;
  private readonly world: MapGeometry;
  private readonly seed: number;
  private readonly renderer: Renderer3D;
  /** A1: sound (Web Audio, CS2's sound events) and the first-person weapon's animation (src/app3d/audio/mount.ts). */
  private readonly a1: A1Mount;
  private readonly hud: Hud3D;
  private readonly controls: ControlsDom;
  /** The key-binding setting (duck / walk / jump / use) and the Ctrl+W guard (fullscreen Keyboard Lock, leave-site). */
  private readonly keys = new KeyBindsStore(pageStorage());
  private readonly guard: PlayGuard;
  private readonly loop: FixedLoop;
  private readonly fpsMeter = new BucketRate(1000);
  private readonly tpsMeter = new BucketRate(1000);
  /** P1: the frame loop (frame-driver.ts) and its settings: the FPS limit, the low-latency canvas, the render scale. */
  private readonly driver: FrameDriver;
  private fpsLimit: FpsLimit = 'uncapped';
  private lowLatency = false;
  private resScale = 1;
  /** requestAnimationFrame intervals (ms): the display's refresh, whatever the loop does. */
  private readonly vsync = new Ring(120);
  private readonly vsyncScratch = new Float64Array(120);
  private lastVsync: number | null = null;
  /** The tick and time of the last HUD update. */
  private hudTick = -1;
  private hudAt = -1e9;
  /** The headroom meter line, rebuilt at 4 Hz. */
  private meter = '';
  private meterAt = -1e9;
  private readonly touchOnly = isTouchOnly();
  /** CS2 settings: sensitivity, zoom_sensitivity_ratio, viewmodel_fov (the settings fields; localStorage). */
  private sensitivity: number;
  private zoomRatio = DEFAULT_ZOOM_RATIO;
  private viewmodelFov = VIEWMODEL_FOV;
  /** Scope level of the human's weapon (0 = unscoped) and the weapon it is for. */
  private zoom = 0;
  private zoomWeapon: string | null = null;
  /** H2b: the scoped FOV (4:3 degrees) of the current zoom level, from the host's weapon table. */
  private zoomFov4x3 = 90;
  /**
   * H2b: share of the recoil the camera follows (CS:GO `view_recoil_tracking`, default 0.45; the "Recoil tracking"
   * setting, 0–1): 0 = the screen stays still and only the crosshair climbs; 1 = the camera follows the bullets.
   */
  private recoilTracking = VIEW_RECOIL_TRACKING;
  /**
   * W1 (#32, #77): CS2's cl_crosshair_recoil (default 0: the crosshair stays at the centre, the view kicks by the
   * recoil tracking; the bullet still goes where the aim punch puts it). The "Crosshair follows recoil" setting.
   */
  private crosshairRecoil = false;
  /** The camera's duck amount (0..1, view-cs2.ts duckStep). */
  private duck = 0;
  private session: Session;
  private scene: Scene;
  private phase: Phase = 'ready';
  private camMode: CameraMode = 'pov';
  /** U1: the radar (CS2's spotting per team, radar3d.ts) and its rules (the panel toggle; localStorage). */
  private readonly radar = new RadarTracker();
  private radarRules: RadarRules = 'cs2';
  /** U1: kills this round per player (the spectator panel) and when each player last fired (their viewmodel). */
  private kills = new Map<PlayerId, number>();
  private readonly lastShotMs = new Map<PlayerId, number>();
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
  /** Test API: the frame loop doesn't draw (the caller renders with test.render()). */
  private frozen = false;
  private lastCamera: { eye: Vec3; yaw: number; pitch: number; viewId: PlayerId } | null = null;
  private lastView: PlayerId | null = null;
  private lastDraw: number | null = null;
  private lastFrame: number | null = null;
  private frames = 0;
  private seekResume: Phase | null = null;
  /** Smoothed per-frame costs (ms): the ticks, the whole draw, the WebGL render call, the HUD. */
  private cost = { sim: 0, draw: 0, render: 0, hud: 0 };
  /** P1: per-frame phase timings (perf.ts). */
  private readonly probe = new FrameProbe(600);
  private probing = false;
  private hooks: PerfHooks | null = null;
  /** P1: the end-of-round summary, computed once (run-entries.ts). */
  private readonly summaryCache = new SummaryCache();
  /** The last summary line shown (kept while a refresh catches up). */
  private summaryLine: string | null = null;
  private readonly buttons: { start: HTMLButtonElement; pause: HTMLButtonElement; restart: HTMLButtonElement; takeover: HTMLButtonElement; camera: HTMLButtonElement; radar: HTMLButtonElement; speeds: HTMLButtonElement[] };

  constructor(data: SessionData | null, world: MapGeometry, radar: HTMLImageElement, seed: number, human: PlayerId | null, sensitivity: number | null, resolution: number | null, lowLatency: boolean | null, render: Uint8Array | null, h3: Scenario3d) {
    this.data = data;
    this.h3 = h3;
    const tuning = data?.tuning ?? h3.tuning;
    if (tuning === null) throw new Error('App3D: no tuning');
    this.tuning = tuning;
    this.followed = human ?? h3.playable ?? this.followed;
    this.world = world;
    this.seed = seed;
    this.sensitivity = sensitivity ?? DEFAULT_SENSITIVITY;
    this.loadSettings(sensitivity !== null);
    if (resolution !== null) this.resScale = resolution;
    if (lowLatency !== null) this.lowLatency = lowLatency;
    this.driver = new FrameDriver((now) => this.runFrame(now), this.fpsLimit);
    const canvas = el('view', HTMLCanvasElement);
    const rgba = rgbaOf(radar);
    const art = floorArt(rgba);
    // X1: a map package with its own render mesh (?map=mirage-2020) draws that; else the collision mesh coloured from the radar.
    const tiles = render === null ? buildWorldTiles(world, new RadarSampler(art, h3.radar), h3.radar, rgba).tiles : buildRenderTiles(decodeRenderMesh(render));
    this.session = this.newSession(human);
    this.renderer = new Renderer3D(canvas, tiles, art, this.session.model.players.map((p) => ({ id: p.id, team: p.team })), { resolution: this.resScale, desynchronized: this.lowLatency });
    this.hud = new Hud3D(radar, h3.radar);
    this.a1 = new A1Mount(world, this.tuning, document.getElementById('bar'));
    this.a1.vmState = () => this.renderer.viewmodels.last;
    this.loop = new FixedLoop(() => this.stepOnce(), { paused: true });
    this.scene = this.ready(this.session);
    this.controls = new ControlsDom(canvas, {
      onSlot: (slot) => {
        if (this.playing()) this.session.requestWeaponSlot(slot);
      },
      onKey: (code) => this.onKey(code),
      onFire: () => this.spectateClick(1),
      playing: () => this.playing(),
      keyboardLocked: () => this.guard.keyboardLocked,
      // H2b: while playing, mouse 2 reaches the host as ATTACK2 (the input's buttons): the host owns the scope.
      onAttack2: () => {
        if (!this.playing()) this.spectateClick(-1);
      },
    });
    this.controls.keyMap = keyMapFor(this.keys.binds);
    this.keys.onChange((b) => (this.controls.keyMap = keyMapFor(b)));
    this.guard = new PlayGuard({
      button: document.getElementById('fullscreen') as HTMLButtonElement | null,
      hint: document.getElementById('kbhint'),
      // The leave-site guard is on while cart is the player's and alive (paused too).
      playing: () => this.session.human !== null && this.phase !== 'ready' && this.scene.pawn(this.session.human)?.alive === true,
      binds: () => this.keys.binds,
      pointerLock: true,
      // Under Keyboard Lock the browser no longer frees the mouse on a short Esc: do it here.
      onEscape: () => document.exitPointerLock(),
      onChange: () => this.updateControls(),
    });
    const keybinds = document.getElementById('keybinds');
    if (keybinds !== null) new KeyBindsDom(keybinds, this.keys, this.guard.mac);
    this.wireSettings();
    this.buttons = {
      start: el('start', HTMLButtonElement),
      pause: el('pause', HTMLButtonElement),
      restart: el('restart', HTMLButtonElement),
      takeover: el('takeover', HTMLButtonElement),
      camera: el('camera', HTMLButtonElement),
      radar: el('radar-rules', HTMLButtonElement),
      speeds: [...document.querySelectorAll<HTMLButtonElement>('button[data-speed]')],
    };
    mountScenarioPickers(el('bar', HTMLElement), h3);
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
      view: () => this.viewInfo(),
      camera: (mode, id) => {
        this.camMode = mode;
        if (id !== undefined) this.followed = id;
        this.updateControls();
      },
      spectate: (dir) => {
        this.spectateStep(dir);
        return this.followed;
      },
      radarRules: (rules) => {
        if (rules !== undefined) this.setRadarRules(rules);
        return this.radarRules;
      },
      radar: () => {
        const team = this.radarTeam();
        const o = this.scene.cur;
        return { team, marks: team === null ? this.radar.marks(o, 'T', 'all') : this.radar.marks(o, team, this.radarRules) };
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
      perf: this.perfHooks(),
      test: {
        freeze: (on) => {
          this.frozen = on;
          if (on && this.phase === 'running') this.togglePause();
        },
        seekTick: (tick) => this.testSeek(tick),
        eyes: (id) => {
          this.camMode = 'pov';
          this.followed = id;
          this.updateControls();
        },
        pose: (x, y, z, yaw, pitch) => {
          this.camMode = 'free';
          this.freePos = { x, y, z };
          this.look = { yaw: wrapYaw(yaw), pitch };
        },
        render: () => {
          this.draw(this.session.observe().tick * TICK_MS, true);
          return this.testState();
        },
        state: () => this.testState(),
      },
    };
    this.driver.start();
    requestAnimationFrame(this.onVsync);
  }

  /** P1: one rAF per display refresh, only to measure it (the frames come from the driver). */
  private readonly onVsync = (t: number): void => {
    if (this.lastVsync !== null && t - this.lastVsync < 250) this.vsync.push(t - this.lastVsync);
    this.lastVsync = t;
    requestAnimationFrame(this.onVsync);
  };

  /** The headroom meter (docs/app3d.md "Performance"): main-thread ms per frame, its fps-equivalent, the loop's rate, the display. */
  private meterLine(now: number): string {
    if (now - this.meterAt < 250 && now >= this.meterAt) return this.meter;
    this.meterAt = now;
    const hz = displayHz(this.vsync.median(this.vsyncScratch));
    const limit = this.driver.mode === 'uncapped' ? 'uncapped' : this.driver.mode === 'vsync' ? 'vsync' : `cap ${String(this.driver.limit)}`;
    this.meter = `${meterText(this.probe.medianFrameMs(), this.fpsMeter.rate(now), hz, limit)} · ${this.tpsMeter.rate(now).toFixed(0)} ticks/s · ${this.loop.speed}×`;
    return this.meter;
  }

  private host(s: Session = this.session): Sim3DHost {
    return s.host as unknown as Sim3DHost;
  }

  private newSession(human: PlayerId | null): Session {
    if (this.h3.makeSession !== null) return this.h3.makeSession(human);
    if (this.data === null) throw new Error('App3D: no recording to play');
    return new Session({ ...this.data, seed: this.seed, human, playable: this.h3.playable ?? 'cart', host: sim3dHostFactory(this.world) });
  }

  /** H3: the pawn E takes while watching: the scenario's playable pawn, or (free play) the spectated one. */
  private takeTarget(): PlayerId | null {
    return this.h3.anyPlayable ? this.followed : this.session.playable;
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
    this.radar.reset(s.observe());
    this.kills = new Map();
    this.lastShotMs.clear();
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
      this.lastShotMs.set(shot.shooter, performance.now());
      if (shot.shooter === s.human) {
        this.humanShots++;
        this.lastHumanShotMs = performance.now();
      }
    }
    this.radar.ingest(o);
    this.countKills(o);
    for (const e of o.events) {
      if (e.type === 'damage' && e.attacker !== null && e.attacker === s.human && !e.scripted) {
        this.humanHits++;
        this.lastHit = { ms: performance.now(), head: e.hitgroup === 'head' };
      }
    }
    this.tracers = this.tracers.filter((t) => tick - t.tick < TRACER_TICKS);
    this.scene.ingest(o, act, h.activeEffects());
    this.a1.tick(o, h, s.human);
  }

  private takeControl(): void {
    const s = this.session;
    const target = this.takeTarget();
    if (this.touchOnly || this.seekResume !== null || s.takeControlBlocked(target) !== null) return;
    if (this.loop.speed !== 1) {
      this.loop.speed = 1;
      s.control({ type: 'speed', x: 1 });
    }
    s.takeControl(target);
    const p = this.scene.pawn(s.human ?? this.followed);
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
      this.afterJump();
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
    const head = (poseHitboxes(t, this.tuning.damage)[0] as { a: Vec3 }).a;
    const a = anglesTo(eye, head);
    this.look = { yaw: wrapYaw(a.yaw), pitch: a.pitch };
    return this.look;
  }

  /** Who mouse 1 / 2 cycle through: the human's living teammates when dead (CS2 competitive), else everyone alive. */
  private spectateTargets(): PlayerId[] {
    const h = this.session.human;
    const team = h === null ? null : (this.scene.pawn(h)?.team ?? null);
    return spectatable(this.scene.cur.pawns, team);
  }

  /** Nobody controlled, or the human dead: the spectator camera, panel and controls. */
  private spectating(): boolean {
    const h = this.session.human;
    return h === null || this.scene.pawn(h)?.alive !== true;
  }

  private spectateStep(dir: 1 | -1): void {
    this.followed = cycleTarget(this.spectateTargets(), this.followed, dir);
    if (this.camMode === 'free') this.camMode = 'pov';
    this.updateControls();
  }

  /**
   * Mouse 1 (dir 1) / mouse 2 (−1) while spectating. In third person and free fly the mouse turns the camera, so the
   * click that grabs the pointer only grabs it (not on touch screens or in first person, where the mouse is unused).
   */
  private spectateClick(dir: 1 | -1): void {
    if (!this.spectating()) return;
    if (this.camMode !== 'pov' && !this.controls.locked && !this.touchOnly) return;
    this.spectateStep(dir);
  }

  /** The team whose radar view is shown: the human's, else the spectated player's (null: none). */
  private radarTeam(): Team | null {
    const h = this.session.human;
    const id = h !== null && this.scene.pawn(h)?.alive === true ? h : this.followed;
    return this.scene.pawn(id)?.team ?? null;
  }

  private setRadarRules(rules: RadarRules): void {
    this.radarRules = rules;
    this.saveSettings();
    this.updateControls();
  }

  /** After a seek: the radar starts over (nothing spotted yet) and the kills are recounted from the log. */
  private afterJump(): void {
    this.radar.reset(this.session.observe());
    this.lastShotMs.clear();
    this.kills = new Map();
    for (const line of this.session.log().lines()) {
      if (!line.includes('"type":"death"')) continue;
      try {
        this.countKills((JSON.parse(line) as { observe: Observe }).observe);
      } catch {
        // A malformed line: skip it.
      }
    }
  }

  /** Enemy kills in this tick's death events. */
  private countKills(o: Observe): void {
    for (const e of o.events) {
      if (e.type !== 'death' || e.attacker === null || e.attacker === e.victim) continue;
      const a = o.pawns.find((p) => p.id === e.attacker);
      const v = o.pawns.find((p) => p.id === e.victim);
      if (a !== undefined && v !== undefined && a.team !== v.team) this.kills.set(a.id, (this.kills.get(a.id) ?? 0) + 1);
    }
  }

  private onKey(code: string): boolean {
    const s = this.session;
    if (code === 'KeyE' && s.human === null) {
      this.takeControl();
      return true;
    }
    if (code === 'KeyV' && !this.playing()) {
      this.camMode = nextSpectateMode(this.camMode);
      if (this.camMode === 'free') {
        const p = this.scene.pawn(this.followed);
        if (p !== null) this.freePos = { x: p.pos.x, y: p.pos.y, z: p.pos.z + 120 };
        this.look = { yaw: p?.yaw ?? 0, pitch: 20 };
      }
      this.updateControls();
      return true;
    }
    if ((code === 'KeyZ' || code === 'KeyX') && !this.playing()) {
      this.spectateStep(code === 'KeyX' ? 1 : -1);
      return true;
    }
    // CS2's spectator: Space = next player (in free fly Space flies up).
    if (code === 'Space' && this.spectating() && this.camMode !== 'free') {
      this.spectateStep(1);
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
    on(b.radar, () => this.setRadarRules(this.radarRules === 'cs2' ? 'all' : 'cs2'));
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
    const v = takeoverButtonView(s.human, this.takeTarget(), s.takeControlBlocked(this.takeTarget()), this.touchOnly, this.seekResume !== null);
    const label = b.takeover.querySelector('span');
    if (label !== null && label.textContent !== v.label) label.textContent = v.label;
    b.takeover.disabled = v.disabled;
    b.takeover.title = v.title;
    b.takeover.setAttribute('aria-pressed', String(v.pressed));
    const cam = b.camera.querySelector('span');
    const camText = this.playing() ? 'Camera: first person' : `Camera: ${this.camMode === 'pov' ? '1st person' : this.camMode === 'follow' ? '3rd person' : 'free'}`;
    if (cam !== null && cam.textContent !== camText) cam.textContent = camText;
    b.camera.disabled = this.playing();
    this.guard.update();
    const radarLabel = b.radar.querySelector('span');
    const radarText = this.radarRules === 'cs2' ? 'Radar: CS2 rules' : 'Radar: show everyone';
    if (radarLabel !== null && radarLabel.textContent !== radarText) radarLabel.textContent = radarText;
    b.radar.setAttribute('aria-pressed', String(this.radarRules === 'all'));
    for (const sb of b.speeds) sb.setAttribute('aria-pressed', String(Number(sb.dataset['speed']) === this.loop.speed));
  }

  private runFrame(now: number): void {
    this.probe.begin(performance.now());
    this.probing = true;
    const dt = this.lastFrame === null ? 0 : Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    if (this.seekResume !== null) this.advanceSeek();
    const mouse = this.controls.takeMouse();
    const s = this.session;
    if (this.playing()) {
      const p = this.scene.pawn(s.human as PlayerId);
      // H2b: the scope is the host's (src/engine/weapons; FOVs from data/weapons.json).
      const av = this.aimView(s.human as PlayerId, this.look);
      if (p !== null) this.setZoom(p.weapon, av.zoom, av.fov4x3);
      this.look = turnView(this.look, mouse.dx, mouse.dy, effectiveSensitivity(this.sensitivity, this.currentFov4x3(), this.zoomRatio));
      // H2b: the input carries the plain view; the host adds the aim punch × weapon_recoil_scale and the inaccuracy cone.
      const inp = fpsInput(s.human as PlayerId, this.controls.controls(), this.look);
      s.setHumanInput(inp);
      this.a1.input(inp, p, this.scene.cur.tick, this.scene.cur.round.bomb.state === 'planted');
    } else if (this.camMode === 'free') {
      this.look = turnView(this.look, mouse.dx, mouse.dy, this.sensitivity);
      this.freePos = flyStep(this.freePos, this.look, this.controls.controls(), dt / 1000, FREE_SPEED);
    } else if (this.camMode === 'follow') {
      this.orbit = turnView(this.orbit, mouse.dx, mouse.dy, this.sensitivity);
    }
    const t0 = performance.now();
    this.probe.mark('input', t0);
    const n = this.loop.advance(dt);
    const t1 = performance.now();
    this.probe.mark('sim', t1);
    this.frames++;
    this.fpsMeter.add(now, 1);
    this.tpsMeter.add(now, n);
    if (n > 0 || this.frames % 30 === 0) this.updateControls();
    this.probe.mark('hud', performance.now());
    if (!this.frozen) this.draw(now);
    const t2 = performance.now();
    this.probing = false;
    this.probe.end(n);
    this.cost = { sim: this.cost.sim * 0.95 + (t1 - t0) * 0.05, draw: this.cost.draw * 0.95 + (t2 - t1) * 0.05, render: this.cost.render, hud: this.cost.hud };
    this.hooks?.onFrame?.();
  }

  private perfHooks(): PerfHooks {
    const hooks: PerfHooks = {
      probe: this.probe,
      driver: (mode) => {
        this.lastFrame = null;
        if (mode === 'manual') this.driver.stop();
        else {
          this.driver.limit = mode === 'page' ? this.fpsLimit : mode;
          this.driver.start();
        }
      },
      step: (now) => this.runFrame(now),
      onFrame: null,
      speed: (x) => {
        this.loop.speed = x;
        this.session.control({ type: 'speed', x });
        this.updateControls();
      },
      start: () => {
        if (this.phase === 'ready') this.start();
        else if (this.phase === 'paused') this.togglePause();
        this.updateControls();
      },
      info: () => {
        const i = this.renderer.renderer.info;
        return { calls: i.render.calls, triangles: i.render.triangles, programs: i.programs?.length ?? 0, geometries: i.memory.geometries, textures: i.memory.textures };
      },
    };
    this.hooks = hooks;
    return hooks;
  }

  /** Camera, pawns and effects for this frame. */
  private draw(now: number, exact = false): void {
    const s = this.session;
    const alpha = exact ? 0 : interpolationAlpha(this.loop.pending, TICK_MS);
    const human = s.human;
    const humanPawn = human === null ? null : this.scene.pawn(human);
    const firstPerson = humanPawn !== null && humanPawn.alive;
    if (!firstPerson) {
      const f = this.scene.pawn(this.followed);
      if (f === null || !f.alive) {
        const targets = this.spectateTargets();
        if (targets.length > 0 && this.camMode !== 'free' && f !== null && this.scene.deaths.has(f.id) && this.scene.cur.tick - (this.scene.deaths.get(f.id) ?? 0) > 128) this.followed = cycleTarget(targets, f.id, 1);
      }
    }
    if (!firstPerson && this.zoom !== 0) this.setZoom('', 0);
    const viewId = firstPerson ? (human as PlayerId) : this.followed;
    const vp = this.scene.pose(viewId, alpha);
    const vo = this.scene.pawn(viewId);
    const crouch = vo?.crouching ?? false;
    if (this.lastView !== viewId) this.duck = crouch ? 1 : 0;
    this.lastView = viewId;
    this.duck = exact ? (crouch ? 1 : 0) : duckStep(this.duck, crouch, Math.min(0.1, (now - (this.lastDraw ?? now)) / 1000));
    this.lastDraw = now;
    this.eyeZ = eyeHeightFor(this.duck);
    let eye: Vec3;
    let yaw: number;
    let pitch: number;
    /** First person through a spectated pawn's eyes (alive): its view, crosshair and scope as it sees them. */
    const specPov = !firstPerson && this.camMode === 'pov' && vo !== null && vo.alive;
    let aim = { yaw: 0, pitch: 0 };
    let specFov = 90;
    let specZoom = 0;
    if (firstPerson || this.camMode === 'pov') {
      eye = vp === null ? this.freePos : { x: vp.x, y: vp.y, z: vp.z + this.eyeZ };
      if (firstPerson) {
        // H2b: the camera follows `recoilTracking` (view_recoil_tracking, default 0.45) of the recoil plus the screen
        // shake; `aim` is where the next bullet goes (view + aim punch × 2), the crosshair only with follow-recoil on.
        const v = this.aimView(human as PlayerId, this.look);
        yaw = v.camera.yaw;
        pitch = v.camera.pitch;
        aim = v.crosshair;
      } else {
        const prevPitch = this.scene.prev?.pawns.find((p) => p.id === viewId)?.pitch ?? vo?.pitch ?? 0;
        const v = this.spectatedView(viewId, { yaw: vp?.yaw ?? 0, pitch: prevPitch + ((vo?.pitch ?? 0) - prevPitch) * alpha });
        yaw = v.camera.yaw;
        pitch = v.camera.pitch;
        aim = v.crosshair;
        specFov = v.fov4x3;
        specZoom = v.zoom;
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
    // Name tags: the viewer's living teammates; an enemy only while the viewer sees it (never through walls).
    const viewTeam = vo?.team ?? null;
    const viewSees = vo?.alive === true ? vo.sees : [];
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
        tag: p.alive && p.id !== viewId && (p.team === viewTeam || viewSees.includes(p.id)),
        hidden: (firstPerson || this.camMode === 'pov') && p.id === viewId && p.alive,
        weapon: p.weapon,
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
    const weapon: WeaponId | null = firstPerson && humanPawn !== null ? humanPawn.weapon : specPov ? vo.weapon : null;
    const scoped = firstPerson ? this.zoom > 0 : specPov && specZoom > 0;
    const sinceShot = exact ? 1 : (now - (firstPerson ? this.lastHumanShotMs : (this.lastShotMs.get(viewId) ?? -1e9))) / 1000;
    const vfovDeg = verticalFov(firstPerson ? this.currentFov4x3() : specPov ? specFov : 90);
    const vmAnim = this.a1.frame({ eye, yaw, pitch, listener: firstPerson ? human : this.camMode === 'free' ? null : viewId, firstPerson: firstPerson ? humanPawn : null, renderTick: rt, zoom: this.zoom, nowMs: exact ? o.tick * TICK_MS : now });
    const r0 = performance.now();
    if (this.probing) this.probe.mark('scene', r0);
    this.lastCamera = { eye: { ...eye }, yaw, pitch, viewId };
    this.renderer.render({
      pawns,
      eye,
      yaw,
      pitch,
      fovDeg: vfovDeg,
      viewmodelFovDeg: verticalFov(this.viewmodelFov),
      tracers,
      effects: this.scene.effects,
      bomb,
      viewmodel: weapon === null || scoped ? null : { weapon, sinceShot, anim: !firstPerson ? null : exact && vmAnim !== null ? { ...vmAnim, sinceShot: 1e6 } : vmAnim, team: (firstPerson ? humanPawn?.team : vo?.team) ?? 'CT' },
      nowMs: now,
    });
    const r1 = performance.now();
    if (this.probing) this.probe.mark('render', r1);
    const over = o.round.phase === 'over' && o.round.endTick !== null && o.tick > o.round.endTick + 128;
    // P1: the summary line once per (round end, deaths), from log entries parsed a few per frame since the round
    // ended (run-entries.ts); it used to be summarize(model, log) on every frame (~200 ms each).
    let summary: string | null = null;
    if (o.round.phase !== 'over') {
      this.summaryCache.invalidate();
      this.summaryLine = null;
    } else {
      if (over && this.h3.makeSession !== null) {
        // H3: free play has no recording to compare with: the round's result.
        const why = { elimination: 'elimination', bomb_exploded: 'the bomb', bomb_defused: 'the defuse', time: 'time' }[o.round.reason ?? 'time'];
        summary = `${o.round.winner ?? '?'} win by ${why} at ${(o.round.endTick / 64).toFixed(2)} s<small>${this.h3.current.title} · Restart to play it again.</small>`;
      } else if (over) {
        // A test render (exact) parses what is left at once.
        const sum = this.summaryCache.get(s.model, s.log(), `${o.round.endTick}|${this.scene.deaths.size}|${human ?? ''}`, exact ? Infinity : undefined);
        summary = sum === null ? null : `${sum.headline}<small>Restart to watch again, or take control of cart earlier.</small>`;
        if (sum !== null) this.summaryLine = summary;
        else summary = this.summaryLine;
      } else this.summaryCache.warm(s.log());
    }
    const mode = firstPerson ? `You: ${human} · Esc frees the mouse` : human !== null ? `You: ${human} (dead) · spectating` : 'Watching';
    const canTake = human === null && s.takeControlBlocked(this.takeTarget()) === null && !this.touchOnly;
    const spec = firstPerson ? null : spectatePanel(vo, this.kills.get(viewId) ?? 0, this.camMode, vo === null ? '' : weaponName(vo.weapon), canTake, this.takeTarget() ?? 'cart');
    const r = this.renderer.renderer.domElement;
    // W1 (#32, #77): the crosshair stays at the centre (CS2's cl_crosshair_recoil 0: it shows the view, the bullet goes
    // where the aim punch puts it); with "Crosshair follows recoil" it sits where the next bullet goes.
    const off = (firstPerson || specPov) && !scoped ? crosshairOffsetPx(this.crosshairRecoil, { yaw, pitch }, aim, (c, a) => aimOffsetPx(c, a, vfovDeg, r.clientHeight)) : { x: 0, y: 0 };
    const radarTeam = firstPerson ? (humanPawn?.team ?? null) : viewTeam;
    // P1: the HUD (DOM) at most once per sim tick or every 15.6 ms, not on every frame of an uncapped loop.
    const hudDue = exact || o.tick !== this.hudTick || now - this.hudAt >= TICK_MS || now < this.hudAt;
    if (hudDue) {
      this.hudTick = o.tick;
      this.hudAt = now;
    }
    if (hudDue) this.hud.update({
      scene: this.scene,
      clock: s.clock,
      viewer: viewId,
      human,
      at: { x: eye.x, y: eye.y, yaw },
      mode: this.phase === 'ready' && human === null ? 'Watching · press Start, or E to play cart' : mode,
      modeKind: firstPerson ? 'you' : human !== null ? 'dead' : 'watching',
      crosshair: (firstPerson || specPov) && !scoped,
      crosshairAt: { x: Math.round(off.x * 2) / 2, y: Math.round(off.y * 2) / 2 },
      scope: scoped,
      radar: { tracker: this.radar, team: radarTeam, rules: this.radarRules },
      spectate: spec,
      hit: exact || this.lastHit === null ? null : { ageMs: now - this.lastHit.ms, head: this.lastHit.head },
      perf: this.meterLine(now),
      summary: over ? summary : null,
      tick: o.tick,
      nowMs: now,
    });
    const r2 = performance.now();
    if (this.probing) this.probe.mark('hud', r2);
    this.cost.render = this.cost.render * 0.95 + (r1 - r0) * 0.05;
    this.cost.hud = this.cost.hud * 0.95 + (r2 - r1) * 0.05;
  }

  /** Test API: seek synchronously (no frame slicing), the Scene restarted where it lands, tracers cleared. */
  private testSeek(tick: number): number {
    const s = this.session;
    if (s.seeking !== null) s.cancelSeek();
    this.seekResume = null;
    if (!Number.isInteger(tick) || tick < 0) throw new Error(`seekTick: bad tick ${tick}`);
    if (tick !== s.tick) s.seek(tick / 64);
    this.scene = new Scene(s.observe(), s.lastAct, this.host().activeEffects(), null);
    this.afterJump();
    this.tracers = [];
    if (this.phase === 'ready') this.phase = 'paused';
    this.loop.reset();
    this.loop.paused = this.phase !== 'running';
    this.updateControls();
    return s.tick;
  }

  private testState(): TestState {
    const c = this.renderer.camera;
    const cam = this.lastCamera;
    const human = this.session.human;
    const fp = human !== null && this.scene.pawn(human)?.alive === true;
    return {
      tick: this.session.observe().tick,
      t: this.session.observe().t,
      phase: this.phase,
      camera: {
        mode: fp ? 'first-person' : this.camMode,
        followed: this.followed,
        eye: cam === null ? null : cam.eye,
        yaw: cam === null ? null : cam.yaw,
        pitch: cam === null ? null : cam.pitch,
        vfovDeg: c.fov,
        hfovDeg: (2 * Math.atan(Math.tan((c.fov * Math.PI) / 360) * c.aspect) * 180) / Math.PI,
        width: this.renderer.renderer.domElement.width,
        height: this.renderer.renderer.domElement.height,
      },
    };
  }

  /**
   * U1: the first-person view of a spectated pawn looking along `view`: the camera angles, where its crosshair is (the
   * next bullet's direction) and its scope, from the host's weapon mechanics once it has them (H2b's
   * `Sim3DHost.aimView`), else its view with no punch and no scope.
   */
  private spectatedView(id: PlayerId, view: { yaw: number; pitch: number }): { camera: { yaw: number; pitch: number }; crosshair: { yaw: number; pitch: number }; zoom: number; fov4x3: number } {
    return this.aimView(id, view);
  }

  /**
   * H2b: camera, crosshair and scope of `id` looking along `view`, from the host's weapon mechanics
   * (`Sim3DHost.aimView`) with the player's recoil-tracking setting.
   */
  private aimView(id: PlayerId, view: { yaw: number; pitch: number }): { camera: { yaw: number; pitch: number }; crosshair: { yaw: number; pitch: number }; zoom: number; fov4x3: number } {
    return this.host().aimView(id, view, this.recoilTracking);
  }

  /** The view's FOV now (4:3 degrees): 90, or the scoped FOV of the human's weapon (the host's, from data/weapons.json). */
  private currentFov4x3(): number {
    return this.zoomWeapon === null || this.zoom === 0 ? 90 : this.zoomFov4x3;
  }

  /** The human's scope level and its FOV (the overlay is the HUD's: HudFrame.scope). */
  private setZoom(weapon: string, level: number, fov4x3 = 90): void {
    this.zoomWeapon = weapon;
    this.zoom = level;
    this.zoomFov4x3 = level === 0 ? 90 : fov4x3;
  }

  private viewInfo(): { vfov: number; hfov: number; aspect: number; viewmodelVfov: number; sensitivity: number; effectiveSensitivity: number; zoom: number; raw: boolean } {
    const c = this.renderer.camera;
    const hfov = (2 * Math.atan(Math.tan((c.fov * Math.PI) / 360) * c.aspect) * 180) / Math.PI;
    return { vfov: c.fov, hfov, aspect: c.aspect, viewmodelVfov: this.renderer.viewmodelFov(), sensitivity: this.sensitivity, effectiveSensitivity: effectiveSensitivity(this.sensitivity, this.currentFov4x3(), this.zoomRatio), zoom: this.zoom, raw: this.controls.raw };
  }

  /** The settings fields (CS2's sensitivity, zoom_sensitivity_ratio, viewmodel_fov), restored from localStorage. */
  private loadSettings(sensFromUrl: boolean): void {
    try {
      const j = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as { sensitivity?: number; zoomRatio?: number; viewmodelFov?: number; radar?: string; fps?: unknown; lowLatency?: boolean; res?: number; recoilTracking?: number; crosshairRecoil?: boolean };
      if (typeof j.crosshairRecoil === 'boolean') this.crosshairRecoil = j.crosshairRecoil;
      this.fpsLimit = parseFpsLimit(j.fps);
      if (typeof j.lowLatency === 'boolean') this.lowLatency = j.lowLatency;
      if (typeof j.res === 'number' && Number.isFinite(j.res)) this.resScale = clamp(j.res, 0.25, 2);
      if (j.radar === 'cs2' || j.radar === 'all') this.radarRules = j.radar;
      if (!sensFromUrl && typeof j.sensitivity === 'number') this.sensitivity = clamp(j.sensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX);
      if (typeof j.recoilTracking === 'number' && Number.isFinite(j.recoilTracking)) this.recoilTracking = clamp(j.recoilTracking, 0, 1);
      if (typeof j.zoomRatio === 'number') this.zoomRatio = clamp(j.zoomRatio, 0.01, 3);
      if (typeof j.viewmodelFov === 'number') this.viewmodelFov = clamp(j.viewmodelFov, VIEWMODEL_FOV_MIN, VIEWMODEL_FOV_MAX);
    } catch {
      // No storage (private mode): defaults.
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ sensitivity: this.sensitivity, zoomRatio: this.zoomRatio, viewmodelFov: this.viewmodelFov, radar: this.radarRules, recoilTracking: this.recoilTracking, fps: this.fpsLimit, lowLatency: this.lowLatency, res: this.resScale, crosshairRecoil: this.crosshairRecoil }));
    } catch {
      // ignore
    }
  }

  private wireSettings(): void {
    const field = (id: string, get: () => number, set: (v: number) => void): void => {
      const input = document.getElementById(id);
      if (!(input instanceof HTMLInputElement)) return;
      input.value = String(get());
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) set(v);
        input.value = String(get());
        this.saveSettings();
        input.blur();
      });
      // Typing a value mustn't move the player.
      input.addEventListener('keydown', (e) => e.stopPropagation());
    };
    field('set-sens', () => this.sensitivity, (v) => (this.sensitivity = clamp(v, SENSITIVITY_MIN, SENSITIVITY_MAX)));
    field('set-zoom', () => this.zoomRatio, (v) => (this.zoomRatio = clamp(v, 0.01, 3)));
    field('set-vmfov', () => this.viewmodelFov, (v) => (this.viewmodelFov = clamp(v, VIEWMODEL_FOV_MIN, VIEWMODEL_FOV_MAX)));
    field('set-tracking', () => this.recoilTracking, (v) => (this.recoilTracking = clamp(v, 0, 1)));
    const xhair = document.getElementById('set-xhair-recoil');
    if (xhair instanceof HTMLInputElement) {
      xhair.checked = this.crosshairRecoil;
      xhair.addEventListener('change', () => {
        this.crosshairRecoil = xhair.checked;
        this.saveSettings();
        xhair.blur();
      });
    }
    this.wirePerfSettings(field);
  }

  /** P1: the FPS limit (frame-driver.ts: presets, a custom number), the render scale and the low-latency canvas. */
  private wirePerfSettings(field: (id: string, get: () => number, set: (v: number) => void) => void): void {
    field('set-res', () => this.resScale, (v) => {
      this.resScale = clamp(v, 0.25, 2);
      this.renderer.setResolution(this.resScale);
    });
    const menu = document.getElementById('set-fps');
    const custom = document.getElementById('set-fps-custom');
    if (menu instanceof HTMLSelectElement && custom instanceof HTMLInputElement) {
      const show = (): void => {
        const l = this.fpsLimit;
        const preset = typeof l !== 'number' || FPS_PRESETS.includes(l);
        menu.value = preset ? String(l) : 'custom';
        custom.hidden = preset;
        custom.value = typeof l === 'number' ? String(l) : '';
      };
      const apply = (v: unknown): void => {
        this.fpsLimit = parseFpsLimit(v);
        this.driver.limit = this.fpsLimit;
        this.saveSettings();
        show();
      };
      show();
      menu.addEventListener('change', () => {
        if (menu.value === 'custom') {
          custom.hidden = false;
          custom.focus();
        } else {
          apply(menu.value);
          menu.blur();
        }
      });
      custom.addEventListener('change', () => {
        apply(custom.value);
        custom.blur();
      });
      // Typing a value mustn't move the player.
      custom.addEventListener('keydown', (e) => e.stopPropagation());
      menu.addEventListener('keydown', (e) => e.stopPropagation());
    }
    const low = document.getElementById('set-lowlat');
    if (low instanceof HTMLInputElement) {
      low.checked = this.lowLatency;
      low.title += this.renderer.desynchronized ? ' (on now)' : this.lowLatency ? ' (not supported by this browser)' : '';
      low.addEventListener('change', () => {
        this.lowLatency = low.checked;
        this.saveSettings();
        // The context's attributes are fixed when it is made: reload to apply.
        window.location.reload();
      });
    }
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
      guard: { leaveGuard: this.guard.guarded, keyboardLocked: this.guard.keyboardLocked, fullscreen: this.guard.fullscreen, duckKey: this.keys.binds.duck },
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
    const sensParam = params.get('sens');
    const sens = sensParam === null ? NaN : Number(sensParam);
    const resParam = params.get('res');
    const res = resParam === null ? NaN : Number(resParam);
    const lowParam = params.get('lowlatency');
    const sensOut = Number.isFinite(sens) && sens > 0 ? clamp(sens, SENSITIVITY_MIN, SENSITIVITY_MAX) : null;
    const resOut = Number.isFinite(res) && res >= 0.25 && res <= 2 ? res : null;
    const lowOut = lowParam === null ? null : lowParam !== '0';
    // H3: the scenario (?scenario=, default the recorded round) and its map (?map=, default the scenario's).
    const scenarios = scenarioList();
    const sc = pickScenario(scenarios, params.get('scenario'));
    const map = params.get('map') === null ? sc.map : parseMapId(params.get('map'));
    if (sc.recording === null) {
      const fa = await loadFreePlayAssets3d(map);
      const f = freePlay3d(sc, map, fa, tuningJson, scenarios);
      new App3D(null, f.world, fa.radar, sc.seed, startHuman(params.get('human')) ?? sc.human, sensOut, resOut, lowOut, null, f.scen);
    } else {
      const a = await loadAssets3d(map);
      const data = parseSessionData(a.round, a.nav, tuningJson, a.vision, a.world3d);
      const world = worldMesh(a.world3d.geometry);
      new App3D(data, world, a.radar, seed, startHuman(params.get('human')), sensOut, resOut, lowOut, a.render, recording3d(sc, map, scenarios));
    }
    status.hidden = true;
    if (params.get('bench') !== null) void runBench(params);
  } catch (err) {
    status.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  }
}

void boot();
