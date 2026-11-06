/**
 * Browser entry: loads the round, builds the Session, runs the 64 Hz loop from requestAnimationFrame,
 * feeds the human's keyboard/mouse input, and draws the canvas (renderer.ts) and the HUD (hud.ts).
 * Wiring only: the logic lives in session.ts, loop.ts, input.ts, scene.ts, camera.ts and hud-model.ts
 * (see docs/app.md).
 *
 * After every Session.step() the Scene ingests the new observe, Core's Act and the host's active
 * effects, so events of every tick reach the kill feed and the effects layer even at 4×.
 *
 * URL parameters: `?seed=<int>` (default 1); `?human=cart|none` (default cart, or none on touch-only
 * devices, which have no controls for the human yet).
 */
import roundUrl from '../../data/round.json?url';
import navUrl from '../../data/mirage-nav.json?url';
import visionUrl from '../../data/mirage-vismask.json?url';
import radarUrl from '../../data/mirage-radar.jpg';
import tuningJson from '../../data/tuning.json';
import { isPlayerId, type PlayerId } from '../contracts/index';
import type { Camera } from './camera';
import { CameraInput } from './camera-dom';
import type { EffectsSource } from './effects';
import { Hud } from './hud';
import { overlayForKey, toggleOverlay, type OverlayKey, type Overlays } from './hud-model';
import { humanInput, yawToward } from './input';
import { InputDom } from './input-dom';
import { FixedLoop, RateMeter, TICK_MS } from './loop';
import { screenToWorld, worldToScreen } from './radar';
import { FOLLOWED, Renderer } from './renderer';
import { Scene, interpolationAlpha } from './scene';
import { DEFAULT_HUMAN, Session, parseSessionData, type SessionData } from './session';

type Phase = 'ready' | 'running' | 'paused';

/** Counters for automated checks (tools/browser-check.ts) and the console. */
export interface AppStats {
  readonly phase: Phase;
  readonly tick: number;
  readonly frames: number;
  readonly ticksRun: number;
  readonly droppedTicks: number;
  readonly speed: number;
  readonly human: PlayerId | null;
  readonly fps: number;
  readonly tps: number;
  readonly overlays: Overlays;
  readonly camera: Camera;
  /** Radar cache rebuilds since load. */
  readonly radarRebuilds: number;
}

declare global {
  interface Window {
    __cs2replay?: {
      stats: () => AppStats;
      session: () => Session;
      /** What the renderer and HUD draw (kill feed, tracers, effects, bomb, statuses). */
      scene: () => Scene;
      /** Viewport (client) coordinates of a world point, for automated mouse input. */
      screenOf: (x: number, y: number) => { x: number; y: number };
    };
  }
}

function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const e = document.getElementById(id);
  if (!(e instanceof type)) throw new Error(`index.html: #${id} missing`);
  return e;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // iOS Safari reads the blob after the click returns; keep it around for a while.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function initialHuman(params: URLSearchParams): PlayerId | null {
  const h = params.get('human');
  if (h === 'none' || h === 'spectate') return null;
  if (h !== null && isPlayerId(h)) return h;
  const touchOnly = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  return touchOnly ? null : DEFAULT_HUMAN;
}

class App {
  private readonly data: SessionData;
  private readonly seed: number;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private readonly hud: Hud;
  private readonly input: InputDom;
  private readonly loop: FixedLoop;
  private readonly fpsMeter = new RateMeter(1000);
  private readonly tpsMeter = new RateMeter(1000);
  private session: Session;
  private scene: Scene;
  private human: PlayerId | null;
  private phase: Phase = 'ready';
  private overlays: Overlays;
  private lastFrame: number | null = null;
  private frames = 0;
  private cursorStyle = '';
  private readonly buttons: {
    start: HTMLButtonElement;
    pause: HTMLButtonElement;
    restart: HTMLButtonElement;
    spectate: HTMLButtonElement;
    speeds: HTMLButtonElement[];
    overlays: HTMLButtonElement[];
  };

  constructor(data: SessionData, radar: HTMLImageElement, seed: number, human: PlayerId | null) {
    this.data = data;
    this.seed = seed;
    this.human = human;
    const canvas = el('view', HTMLCanvasElement);
    this.canvas = canvas;
    this.overlays = { follow: false, ghost: true, tracks: false, panel: window.matchMedia('(min-width: 900px)').matches };
    this.renderer = new Renderer(canvas, radar, data.round);
    this.hud = new Hud(data.round, () => this.toggle('panel'));
    this.loop = new FixedLoop(() => this.stepOnce(), { paused: true });
    this.session = new Session({ ...this.data, seed: this.seed, human: this.human });
    this.scene = this.ready(this.session);
    this.input = new InputDom(canvas, {
      active: () => this.playing(),
      onSlot: (slot) => {
        if (this.phase === 'running') this.session.requestWeaponSlot(slot);
      },
    });
    new CameraInput(canvas, {
      playing: () => this.playing(),
      onZoom: (at, factor) => this.renderer.zoomAt(this.overlays.follow ? null : at, factor),
      onPan: (dx, dy) => {
        if (this.overlays.follow) this.toggle('follow');
        this.renderer.panBy(dx, dy);
      },
      onReset: () => {
        if (this.overlays.follow) this.toggle('follow');
        this.renderer.resetCamera();
      },
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    this.buttons = {
      start: el('start', HTMLButtonElement),
      pause: el('pause', HTMLButtonElement),
      restart: el('restart', HTMLButtonElement),
      spectate: el('spectate', HTMLButtonElement),
      speeds: [...document.querySelectorAll<HTMLButtonElement>('button[data-speed]')],
      overlays: [...document.querySelectorAll<HTMLButtonElement>('button[data-overlay]')],
    };
    this.wireControls();
    this.updateControls();
    window.__cs2replay = {
      stats: () => this.stats(),
      session: () => this.session,
      scene: () => this.scene,
      screenOf: (x, y) => {
        const s = worldToScreen(this.renderer.view, { x, y });
        const rect = canvas.getBoundingClientRect();
        return { x: rect.left + s.x, y: rect.top + s.y };
      },
    };
    requestAnimationFrame(this.frame);
  }

  /** True while keyboard and mouse drive the human pawn. */
  private playing(): boolean {
    return this.phase === 'running' && this.session.human !== null;
  }

  /** The host's grenade effects (Sim2DHost.activeEffects). */
  private effects(s: Session): EffectsSource {
    return s.host;
  }

  /** One tick: step the session, then hand the Scene what happened. */
  private stepOnce(): void {
    const act = this.session.step();
    this.scene.ingest(this.session.observe(), act, this.effects(this.session).activeEffects());
  }

  /** A new session in the ready state: tick 0 (the round setup) has run, so the pawns are on their spots. */
  private newSession(): Session {
    const s = new Session({ ...this.data, seed: this.seed, human: this.human });
    this.scene = this.ready(s);
    return s;
  }

  /** Put a session in the ready state (setup tick run, paused) and start a Scene on it. */
  private ready(s: Session): Scene {
    if (this.loop.speed !== 1) s.control({ type: 'speed', x: this.loop.speed });
    s.step();
    this.phase = 'ready';
    this.loop.paused = true;
    this.loop.reset();
    return new Scene(s.observe(), s.lastAct, this.effects(s).activeEffects(), s.nav);
  }

  private toggle(key: OverlayKey): void {
    this.overlays = toggleOverlay(this.overlays, key);
    if (key === 'follow' && this.overlays.follow) {
      const p = this.scene.pawn(this.session.human ?? FOLLOWED);
      this.renderer.startFollow(p === null ? null : p.pos);
    }
    this.updateControls();
  }

  /** View toggles: F follow, G ghost, T tracks, Tab status panel. */
  private onKey(e: KeyboardEvent): void {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const key = overlayForKey(e.code);
    if (key === null) return;
    // Tab moves focus as usual inside the controls bar; from the page it toggles the panel.
    if (key === 'panel' && document.activeElement !== null && document.activeElement !== document.body && document.activeElement !== this.canvas) return;
    e.preventDefault();
    this.toggle(key);
  }

  private wireControls(): void {
    const b = this.buttons;
    const on = (button: HTMLButtonElement, f: () => void): void => {
      button.addEventListener('click', () => {
        f();
        // Keep keyboard focus off the buttons, so Space or Enter never re-triggers one mid-round.
        button.blur();
        this.updateControls();
      });
    };
    on(b.start, () => {
      if (this.phase !== 'ready') return;
      this.phase = 'running';
      this.loop.reset();
      this.loop.paused = false;
    });
    on(b.pause, () => {
      if (this.phase === 'ready') return;
      const paused = this.phase === 'running';
      this.phase = paused ? 'paused' : 'running';
      this.loop.paused = paused;
      this.session.control({ type: 'pause', paused });
    });
    on(b.restart, () => {
      this.session.restart();
      this.scene = this.ready(this.session);
    });
    on(b.spectate, () => {
      this.human = this.human === null ? DEFAULT_HUMAN : null;
      this.session = this.newSession();
    });
    for (const sb of b.speeds) {
      on(sb, () => {
        const x = Number(sb.dataset['speed']);
        this.loop.speed = x;
        this.session.control({ type: 'speed', x: this.loop.speed });
      });
    }
    for (const ob of b.overlays) {
      on(ob, () => {
        const key = ob.dataset['overlay'];
        if (key === 'follow' || key === 'ghost' || key === 'tracks' || key === 'panel') this.toggle(key);
      });
    }
    on(el('dl-log', HTMLButtonElement), () => {
      download(`${this.fileStem()}.jsonl`, this.session.log().toText(), 'application/x-ndjson');
    });
    on(el('dl-trace', HTMLButtonElement), () => {
      download(`${this.fileStem()}-trace.json`, JSON.stringify(this.session.trace()), 'application/json');
    });
  }

  private updateControls(): void {
    const b = this.buttons;
    b.start.disabled = this.phase !== 'ready';
    b.pause.disabled = this.phase === 'ready';
    b.pause.textContent = this.phase === 'paused' ? 'Resume' : 'Pause';
    b.restart.disabled = false;
    b.spectate.setAttribute('aria-pressed', String(this.human === null));
    for (const sb of b.speeds) sb.setAttribute('aria-pressed', String(Number(sb.dataset['speed']) === this.loop.speed));
    for (const ob of b.overlays) {
      const key = ob.dataset['overlay'] as OverlayKey | undefined;
      if (key !== undefined && key in this.overlays) ob.setAttribute('aria-pressed', String(this.overlays[key]));
    }
  }

  private fileStem(): string {
    return `cs2-replay-seed${this.seed}-${this.session.human ?? 'spectate'}-tick${this.scene.cur.tick}`;
  }

  private readonly frame = (now: number): void => {
    const dt = this.lastFrame === null ? 0 : now - this.lastFrame;
    this.lastFrame = now;
    if (this.phase === 'running') this.feedHuman();
    const n = this.loop.advance(dt);
    this.frames++;
    this.fpsMeter.add(now, 1);
    this.tpsMeter.add(now, n);
    const alpha = interpolationAlpha(this.loop.pending, TICK_MS);
    const s = this.session;
    this.renderer.resize();
    this.renderer.draw({
      scene: this.scene,
      alpha,
      model: s.model,
      clock: s.clock,
      human: s.human,
      overlays: this.overlays,
      aim: this.playing() ? this.input.cursor() : null,
      fovDeg: s.tuning.ai.fovDeg,
      blind: s.host,
      nowMs: now,
    });
    this.hud.update({
      scene: this.scene,
      clock: s.clock,
      human: s.human,
      you: s.human ?? FOLLOWED,
      phase: this.phase,
      speed: this.loop.speed,
      panelOpen: this.overlays.panel,
      tick: this.scene.renderTick(alpha),
      fps: this.fpsMeter.rate(now),
      tps: this.tpsMeter.rate(now),
    });
    this.updateCursor();
    requestAnimationFrame(this.frame);
  };

  /** Crosshair while playing; a grab hand where dragging pans. */
  private updateCursor(): void {
    const c = this.playing() ? 'crosshair' : this.renderer.camera.zoom > 1 && !this.overlays.follow ? 'grab' : 'default';
    if (c === this.cursorStyle) return;
    this.cursorStyle = c;
    this.canvas.style.cursor = c;
  }

  /** Human input for this frame: held keys, and yaw toward the cursor. Used for every tick until the next frame. */
  private feedHuman(): void {
    const id = this.session.human;
    if (id === null) return;
    const p = this.scene.pawn(id);
    if (p === null || !p.alive) return;
    const cursor = this.input.cursor();
    const target = cursor === null ? null : screenToWorld(this.renderer.view, cursor);
    const yaw = target === null ? p.yaw : yawToward(p.pos, target, p.yaw);
    this.session.setHumanInput(humanInput(id, this.input.controls(), yaw, p.pitch));
  }

  private stats(): AppStats {
    const now = performance.now();
    return {
      phase: this.phase,
      tick: this.scene.cur.tick,
      frames: this.frames,
      ticksRun: this.loop.ticksRun,
      droppedTicks: this.loop.droppedTicks,
      speed: this.loop.speed,
      human: this.session.human,
      fps: this.fpsMeter.rate(now),
      tps: this.tpsMeter.rate(now),
      overlays: this.overlays,
      camera: this.renderer.camera,
      radarRebuilds: this.renderer.cacheRebuilds,
    };
  }
}

async function boot(): Promise<void> {
  const status = el('status', HTMLElement);
  try {
    const params = new URLSearchParams(window.location.search);
    const seedParam = Number(params.get('seed') ?? '1');
    const seed = Number.isInteger(seedParam) ? seedParam : 1;
    const [roundJson, navJson, visionJson, radar] = await Promise.all([fetchJson(roundUrl), fetchJson(navUrl), fetchJson(visionUrl), loadImage(radarUrl)]);
    const data = parseSessionData(roundJson, navJson, tuningJson, visionJson);
    new App(data, radar, seed, initialHuman(params));
    status.hidden = true;
  } catch (err) {
    status.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  }
}

void boot();
