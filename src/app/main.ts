/**
 * Browser entry: loads the round, builds the Session, runs the 64 Hz loop from requestAnimationFrame,
 * feeds the human's keyboard/mouse input and draws with the debug renderer. Wiring only: the logic
 * lives in session.ts, loop.ts, input.ts and debug-render.ts (see docs/app.md).
 *
 * URL parameters: `?seed=<int>` (default 1); `?human=cart|none` (default cart, or none on touch-only
 * devices, which have no controls for the human yet).
 */
import roundUrl from '../../data/round.json?url';
import navUrl from '../../data/mirage-nav.json?url';
import radarUrl from '../../data/mirage-radar.jpg';
import tuningJson from '../../data/tuning.json';
import { isPlayerId, type Observe, type PlayerId } from '../contracts/index';
import { DebugRenderer } from './debug-render';
import { humanInput, yawToward } from './input';
import { InputDom } from './input-dom';
import { FixedLoop, RateMeter } from './loop';
import { screenToWorld, worldToScreen } from './radar';
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
}

declare global {
  interface Window {
    __cs2replay?: {
      stats: () => AppStats;
      session: () => Session;
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
  private readonly renderer: DebugRenderer;
  private readonly input: InputDom;
  private readonly loop: FixedLoop;
  private readonly fpsMeter = new RateMeter(1000);
  private readonly tpsMeter = new RateMeter(1000);
  private session: Session;
  private human: PlayerId | null;
  private phase: Phase = 'ready';
  private obs: Observe;
  private lastFrame: number | null = null;
  private frames = 0;
  private readonly buttons: {
    start: HTMLButtonElement;
    pause: HTMLButtonElement;
    restart: HTMLButtonElement;
    spectate: HTMLButtonElement;
    speeds: HTMLButtonElement[];
  };

  constructor(data: SessionData, radar: HTMLImageElement, seed: number, human: PlayerId | null) {
    this.data = data;
    this.seed = seed;
    this.human = human;
    const canvas = el('view', HTMLCanvasElement);
    this.renderer = new DebugRenderer(canvas, radar, data.round.meta.map);
    this.loop = new FixedLoop(() => this.session.step(), { paused: true });
    this.session = this.newSession();
    this.obs = this.session.observe();
    this.input = new InputDom(canvas, {
      active: () => this.phase === 'running' && this.session.human !== null,
      onSlot: (slot) => {
        if (this.phase === 'running') this.session.requestWeaponSlot(slot);
      },
    });
    this.buttons = {
      start: el('start', HTMLButtonElement),
      pause: el('pause', HTMLButtonElement),
      restart: el('restart', HTMLButtonElement),
      spectate: el('spectate', HTMLButtonElement),
      speeds: [...document.querySelectorAll<HTMLButtonElement>('button[data-speed]')],
    };
    this.wireControls();
    this.updateControls();
    window.__cs2replay = {
      stats: () => this.stats(),
      session: () => this.session,
      screenOf: (x, y) => {
        const s = worldToScreen(this.renderer.view, { x, y });
        const rect = canvas.getBoundingClientRect();
        return { x: rect.left + s.x, y: rect.top + s.y };
      },
    };
    requestAnimationFrame(this.frame);
  }

  /** A new session in the ready state: tick 0 (the round setup) has run, so the pawns are on their spots. */
  private newSession(): Session {
    const s = new Session({ ...this.data, seed: this.seed, human: this.human });
    this.ready(s);
    return s;
  }

  private ready(s: Session): void {
    if (this.loop.speed !== 1) s.control({ type: 'speed', x: this.loop.speed });
    s.step();
    this.phase = 'ready';
    this.loop.paused = true;
    this.loop.reset();
    this.obs = s.observe();
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
      this.ready(this.session);
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
  }

  private fileStem(): string {
    return `cs2-replay-seed${this.seed}-${this.session.human ?? 'spectate'}-tick${this.obs.tick}`;
  }

  private readonly frame = (now: number): void => {
    const dt = this.lastFrame === null ? 0 : now - this.lastFrame;
    this.lastFrame = now;
    if (this.phase === 'running') this.feedHuman();
    const n = this.loop.advance(dt);
    this.frames++;
    this.fpsMeter.add(now, 1);
    this.tpsMeter.add(now, n);
    this.obs = this.session.observe();
    this.renderer.resize();
    this.renderer.draw({
      observe: this.obs,
      clock: this.session.clock.hudClock(this.obs.tick),
      human: this.session.human,
      phase: this.phase === 'ready' ? 'ready: press Start' : this.phase,
      speed: this.loop.speed,
      fps: this.fpsMeter.rate(now),
      tps: this.tpsMeter.rate(now),
    });
    requestAnimationFrame(this.frame);
  };

  /** Human input for this frame: held keys, and yaw toward the cursor. Used for every tick until the next frame. */
  private feedHuman(): void {
    const id = this.session.human;
    if (id === null) return;
    const p = this.obs.pawns.find((q) => q.id === id);
    if (p === undefined || !p.alive) return;
    const cursor = this.input.cursor();
    const target = cursor === null ? null : screenToWorld(this.renderer.view, cursor);
    const yaw = target === null ? p.yaw : yawToward(p.pos, target, p.yaw);
    this.session.setHumanInput(humanInput(id, this.input.controls(), yaw, p.pitch));
  }

  private stats(): AppStats {
    const now = performance.now();
    return {
      phase: this.phase,
      tick: this.obs.tick,
      frames: this.frames,
      ticksRun: this.loop.ticksRun,
      droppedTicks: this.loop.droppedTicks,
      speed: this.loop.speed,
      human: this.session.human,
      fps: this.fpsMeter.rate(now),
      tps: this.tpsMeter.rate(now),
    };
  }
}

async function boot(): Promise<void> {
  const status = el('status', HTMLElement);
  try {
    const params = new URLSearchParams(window.location.search);
    const seedParam = Number(params.get('seed') ?? '1');
    const seed = Number.isInteger(seedParam) ? seedParam : 1;
    const [roundJson, navJson, radar] = await Promise.all([fetchJson(roundUrl), fetchJson(navUrl), loadImage(radarUrl)]);
    const data = parseSessionData(roundJson, navJson, tuningJson);
    new App(data, radar, seed, initialHuman(params));
    status.hidden = true;
  } catch (err) {
    status.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  }
}

void boot();
