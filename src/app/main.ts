/**
 * Browser entry: loads the round, builds the Session, runs the 64 Hz loop from requestAnimationFrame,
 * feeds the human's keyboard/mouse input, and draws the canvas (renderer.ts) and the HUD (hud.ts).
 * Wiring only: the logic lives in session.ts, loop.ts, input.ts, scene.ts, camera.ts and hud-model.ts
 * (see docs/app.md).
 *
 * After every Session.step() the Scene ingests the new observe, Core's Act and the host's active
 * effects, so events of every tick reach the kill feed and the effects layer even at 4×.
 *
 * B5: the timeline under the map (timeline.ts) seeks by dragging; −10 s / −5 s / +5 s and `[` / `]` seek from
 * the current tick. A seek runs Session.advanceSeek in slices of about 10 ms per animation frame (no rendering of
 * the skipped ticks), then the Scene restarts from where it landed. The summary overlay (summary-overlay.ts)
 * appears 2 s of round time after the round end, without pausing (the post-round kill still happens).
 *
 * G4: the page starts watching (nobody controls cart; the round plays as recorded). "Take control of cart" or E hands
 * him to the player from that tick on (Session.takeControl; a 4× speed drops to 1×); Restart, or a rewind to before
 * it, is watching again. Touch-only devices have no controls for the human, so they only watch (takeover.ts).
 *
 * URL parameters: `?seed=<int>` (default 1); `?human=cart` plays cart from the start (`none`, the default: watching).
 *
 * Data: `loadAssets()` fetches the round, nav and sight-mask JSON and the radar (assets.ts). The single-file
 * build (vite.single.config.ts) redirects that import to assets-embedded.ts, which reads them from the page.
 */
import tuningJson from '../../data/tuning.json';
import { isPlayerId, parseMapId, type PlayerId, type RoundSummary } from '../contracts/index';
import { summarize, tickOf } from '../core/index';
import { loadAssets, loadFreePlayNav, scenarioList } from './assets';
import { DEFAULT_SCENARIO_2D, freePlay2d } from './scenarios';
import type { Camera } from './camera';
import { CameraInput } from './camera-dom';
import type { EffectsSource } from './effects';
import { Hud } from './hud';
import { overlayForKey, toggleOverlay, type OverlayKey, type Overlays, type ScreenRect } from './hud-model';
import { humanInput, yawToward } from './input';
import { InputDom } from './input-dom';
import { keyMapFor } from './input';
import { KeyBindsStore, PageKeysStore, pageStorage } from './keybinds';
import { KeyBindsDom, PageKeyDom } from './keybinds-dom';
import { PlayGuard } from './play-guard';
import { FixedLoop, RateMeter, TICK_MS } from './loop';
import { screenToWorld, worldToScreen } from './radar';
import { FOLLOWED, Renderer } from './renderer';
import { Scene, interpolationAlpha } from './scene';
import { Session, parseSessionData, type SessionData } from './session';
import { STANDING_HULL, TRACE_SKIN } from '../sim2d/index';
import { SummaryCache } from './run-entries';
import { SUMMARY_DELAY_TICKS, SummaryOverlay, summaryDue, summaryView } from './summary-overlay';
import { TAKEOVER_KEY, startHuman, takeoverButtonView, youNote } from './takeover';
import { TimelineDom, seekFraction, seekStepForKey, stepTarget, timelineSpanTicks } from './timeline';

/** A seek's wall-time budget per animation frame (ms), so the page stays responsive. */
const SEEK_FRAME_MS = 10;
/** Ticks per advanceSeek call inside that budget. */
const SEEK_SLICE_TICKS = 16;

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
  /** G4: the tick the player took control (0: from the start), or null while watching; and whether he can now. */
  readonly takeoverTick: number | null;
  readonly canTakeControl: boolean;
  readonly fps: number;
  readonly tps: number;
  readonly overlays: Overlays;
  readonly camera: Camera;
  /** Radar cache rebuilds since load. */
  readonly radarRebuilds: number;
  /** The last frame's pawn labels (canvas CSS px) and the HUD's rectangles they keep out of; labels left out. */
  readonly labels: { readonly drawn: readonly ScreenRect[]; readonly dropped: number; readonly hud: readonly ScreenRect[] };
  /** B5: a seek is running. */
  readonly seeking: boolean;
  /** B5: the summary overlay is showing. */
  readonly summaryOpen: boolean;
  readonly checkpoints: number;
  /** play-guard.ts: the leave-site guard is on, the keyboard is locked (fullscreen, Chromium), the duck key. */
  readonly guard: { readonly leaveGuard: boolean; readonly keyboardLocked: boolean; readonly fullscreen: boolean; readonly duckKey: string };
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
      /** B5: the end-of-round summary of the run so far (summarize(model, log)). */
      summary: () => RoundSummary;
      /** B5: seek to video second t, as the timeline does (chunked per frame). */
      seek: (t: number) => void;
      /** G4: take control of cart, as the button and E do (no-op when it can't). */
      takeControl: () => void;
    };
  }
}

function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const e = document.getElementById(id);
  if (!(e instanceof type)) throw new Error(`index.html: #${id} missing`);
  return e;
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

/** Touch-only devices (phones, tablets without a mouse) have no controls for the human: they watch. */
function isTouchOnly(): boolean {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

class App {
  private readonly data: SessionData;
  private readonly seed: number;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private readonly hud: Hud;
  private readonly input: InputDom;
  /** The key-binding setting (duck / walk / jump / use) and the Ctrl+W guard (fullscreen Keyboard Lock, leave-site). */
  private readonly keys = new KeyBindsStore(pageStorage());
  /** U2: the take-cart key (C), rebindable under Keys. */
  private readonly pageKeys = new PageKeysStore(pageStorage(), () => this.keys.binds);
  /** U2: the player the takeover button and E take (the picker beside the button; the 2D page has no spectating). */
  private picked: PlayerId = FOLLOWED;
  private readonly guard: PlayGuard;
  private readonly loop: FixedLoop;
  private readonly fpsMeter = new RateMeter(1000);
  private readonly tpsMeter = new RateMeter(1000);
  private session: Session;
  private scene: Scene;
  /** Who plays from the start (`?human=`): null = watching until the player takes control (G4). */
  private readonly human: PlayerId | null;
  /** G4: no keyboard and mouse: watch only. */
  private readonly touchOnly = isTouchOnly();
  /** G4: the takeover button's last view (it changes with cart's death and seeks, so it is checked every frame). */
  private takeoverKey = '';
  private phase: Phase = 'ready';
  private overlays: Overlays;
  /** The map layers: the radar, and (G3) the height map. */
  private readonly radar: HTMLImageElement;
  private readonly height: HTMLImageElement | null;
  /** G3: floor height lookup for the renderer's height cue, or null with 2D movement. */
  private readonly floorZ: ((x: number, y: number, z: number) => number | null) | null;
  private lastFrame: number | null = null;
  private frames = 0;
  private cursorStyle = '';
  private readonly timeline: TimelineDom;
  private readonly overlay: SummaryOverlay;
  /** Ticks the timeline spans. */
  private readonly span: number;
  /** While a seek runs: the phase to go back to when it lands. */
  private seekResume: Phase | null = null;
  /** The summary was closed for this round end (it comes back after a rewind past it, or with the Summary button). */
  private summaryDismissed = false;
  /** P1: the summary, computed once per (round end, deaths) from incrementally parsed log entries. */
  private readonly summaryCache = new SummaryCache();
  /** Deaths ingested, and the count the open summary was made with (a later death, the post-round kill, refreshes it). */
  private deaths = 0;
  private summaryDeaths = -1;
  private readonly buttons: {
    start: HTMLButtonElement;
    pause: HTMLButtonElement;
    restart: HTMLButtonElement;
    takeover: HTMLButtonElement;
    summary: HTMLButtonElement;
    back5: HTMLButtonElement;
    back10: HTMLButtonElement;
    fwd5: HTMLButtonElement;
    speeds: HTMLButtonElement[];
    overlays: HTMLButtonElement[];
  };

  /** @param makeSession H3: free play's session factory (null: the recorded round's Session). */
  constructor(data: SessionData, radar: HTMLImageElement, seed: number, human: PlayerId | null, height: HTMLImageElement | null = null, makeSession: ((seed: number, human: PlayerId | null) => Session) | null = null) {
    this.data = data;
    this.radar = radar;
    this.height = height;
    const g = data.geometry ?? null;
    // G3: the floor under a pawn (a standing hull's footprint, at or below its feet), for the height cue.
    this.floorZ =
      g === null
        ? null
        : (x: number, y: number, z: number): number | null => {
            const f = g.floorBelow(x, y, z + TRACE_SKIN, STANDING_HULL.halfWidth, 0, FLOOR_LOOKUP_DOWN);
            return f === null ? null : f.z;
          };
    this.seed = seed;
    this.human = human;
    const canvas = el('view', HTMLCanvasElement);
    this.canvas = canvas;
    this.overlays = { follow: false, ghost: true, tracks: false, panel: window.matchMedia('(min-width: 900px)').matches, height: false };
    this.renderer = new Renderer(canvas, radar, data.round);
    this.hud = new Hud(data.round, () => this.toggle('panel'));
    this.loop = new FixedLoop(() => this.stepOnce(), { paused: true });
    this.session = makeSession !== null ? makeSession(this.seed, this.human) : new Session({ ...this.data, seed: this.seed, human: this.human });
    this.scene = this.ready(this.session);
    const m = this.session.model;
    this.span = timelineSpanTicks(
      m.players.map((p) => m.track(p.id).at(-1)?.tick ?? 0),
      data.tuning.replay.holdLastPositionSec,
    );
    this.timeline = new TimelineDom(el('timeline', HTMLElement), { onSeek: (tick) => this.startSeek(tick / 64) });
    this.overlay = new SummaryOverlay(el('summary', HTMLElement), {
      onRewind: () => {
        this.overlay.hide();
        this.startSeek(stepTarget(this.session.tick, -10));
      },
      onRestart: () => this.restart(),
      onDismiss: () => {
        this.summaryDismissed = true;
        this.updateControls();
      },
    });
    this.input = new InputDom(canvas, {
      active: () => this.playing(),
      onSlot: (slot) => {
        if (this.phase === 'running') this.session.requestWeaponSlot(slot);
      },
      keyboardLocked: () => this.guard.keyboardLocked,
    });
    this.input.keyMap = keyMapFor(this.keys.binds);
    this.keys.onChange((b) => (this.input.keyMap = keyMapFor(b)));
    this.guard = new PlayGuard({
      button: document.getElementById('fullscreen') as HTMLButtonElement | null,
      hint: document.getElementById('kbhint'),
      // The leave-site guard is on while cart is the player's and alive (paused too).
      playing: () => this.session.human !== null && this.phase !== 'ready' && this.scene.pawn(this.session.human)?.alive === true,
      binds: () => this.keys.binds,
      pointerLock: false,
    });
    const keybinds = document.getElementById('keybinds');
    if (keybinds !== null && !this.touchOnly) {
      new KeyBindsDom(keybinds, this.keys, this.guard.mac);
      new PageKeyDom(keybinds, this.pageKeys, this.keys, this.guard.mac);
    }
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
      takeover: el('takeover', HTMLButtonElement),
      summary: el('summary-open', HTMLButtonElement),
      back5: el('back5', HTMLButtonElement),
      back10: el('back10', HTMLButtonElement),
      fwd5: el('fwd5', HTMLButtonElement),
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
      summary: () => summarize(this.session.model, this.session.log()),
      seek: (t) => this.startSeek(t),
      takeControl: () => this.takeControl(),
    };
    requestAnimationFrame(this.frame);
  }

  /** True while keyboard and mouse drive the human pawn. */
  private playing(): boolean {
    return this.phase === 'running' && this.seekResume === null && this.session.human !== null;
  }

  /**
   * B5: seek to video second `t` (the timeline, the ±5 s / −10 s buttons and keys, the summary's Rewind 10 s). The
   * loop stops while it runs; it lands paused, or running if the round was running. A forward seek past what the
   * human has played leaves him standing (his held keys are let go).
   */
  private startSeek(t: number): void {
    const s = this.session;
    if (s.seeking !== null) s.cancelSeek();
    const target = tickOf(Math.max(0, t));
    const from = s.tick;
    if (target === from) return;
    if (target > from && !s.capabilities.seek) return;
    this.seekResume ??= this.phase === 'running' ? 'running' : 'paused';
    this.loop.paused = true;
    if (s.human !== null && target > from && s.tapeEnd === null) s.setHumanInput(null);
    s.beginSeek(target / 64);
    this.updateControls();
  }

  /** One frame of a running seek: advance for about SEEK_FRAME_MS, then land when done. */
  private advanceSeek(): void {
    const s = this.session;
    const t0 = performance.now();
    let p = s.seeking;
    while (p !== null && !p.done && performance.now() - t0 < SEEK_FRAME_MS) p = s.advanceSeek(SEEK_SLICE_TICKS);
    if (p === null || p.done) this.landSeek();
  }

  /** The seek is done: restart the Scene where it landed and resume. */
  private landSeek(): void {
    const s = this.session;
    if (s.speed !== this.loop.speed) s.control({ type: 'speed', x: this.loop.speed });
    this.scene = new Scene(s.observe(), s.lastAct, this.effects(s).activeEffects(), s.tracerSight());
    this.phase = this.seekResume ?? this.phase;
    this.seekResume = null;
    this.loop.reset();
    this.loop.paused = this.phase !== 'running';
    if (this.scene.cur.round.phase !== 'over') {
      this.overlay.hide();
      this.summaryDismissed = false;
    }
    this.updateControls();
  }

  /**
   * G4: the player takes control of cart from the next tick on (the button, or E while watching). The pawn keeps what
   * the puppet had; a 4× (or any) speed drops to 1×, since nobody plays at 4× (the speed buttons still work).
   */
  /** Take control of `id` (default: the picked player; C: cart, U2); refused while he is dead or during a seek. */
  private takeControl(id: PlayerId = this.picked): void {
    const s = this.session;
    if (this.touchOnly || this.seekResume !== null || !s.canTakeControlOf(id)) return;
    if (this.loop.speed !== 1) {
      this.loop.speed = 1;
      s.control({ type: 'speed', x: 1 });
    }
    s.takeControl(id);
    this.updateControls();
  }

  /** Back to the ready state (the Restart button and the summary's Restart). */
  private restart(): void {
    this.session.cancelSeek();
    this.seekResume = null;
    this.overlay.hide();
    this.summaryDismissed = false;
    this.session.restart();
    this.scene = this.ready(this.session);
    this.updateControls();
  }

  /**
   * Show the summary of the run so far. P1: from log entries parsed a few per frame since the round ended
   * (run-entries.ts), computed once per (round end, deaths); false while the entries are still catching up (call
   * again next frame). `now` parses whatever is left at once (the Summary button).
   */
  private showSummary(now = false): boolean {
    const s = this.session;
    const r = this.scene.cur.round;
    const sum = this.summaryCache.get(s.model, s.log(), `${r.endTick}|${this.deaths}|${s.human ?? ''}`, now ? Infinity : undefined);
    if (sum === null) return false;
    this.overlay.show(summaryView(sum, (id) => s.model.player(id).team));
    this.summaryDeaths = this.deaths;
    this.updateControls();
    return true;
  }

  /** The host's grenade effects (Sim2DHost.activeEffects). */
  private effects(s: Session): EffectsSource {
    return s.host;
  }

  /** One tick: step the session, then hand the Scene what happened. */
  private stepOnce(): void {
    const act = this.session.step();
    const o = this.session.observe();
    for (const e of o.events) if (e.type === 'death') this.deaths++;
    this.scene.ingest(o, act, this.effects(this.session).activeEffects());
  }

  /** Put a session in the ready state (setup tick run, paused) and start a Scene on it. */
  private ready(s: Session): Scene {
    if (this.loop.speed !== 1) s.control({ type: 'speed', x: this.loop.speed });
    s.step();
    this.phase = 'ready';
    this.loop.paused = true;
    this.loop.reset();
    return new Scene(s.observe(), s.lastAct, this.effects(s).activeEffects(), s.tracerSight());
  }

  private toggle(key: OverlayKey): void {
    this.overlays = toggleOverlay(this.overlays, key);
    if (key === 'follow' && this.overlays.follow) {
      const p = this.scene.pawn(this.session.human ?? FOLLOWED);
      this.renderer.startFollow(p === null ? null : p.pos);
    }
    if (key === 'height') this.renderer.setMapLayer(this.overlays.height && this.height !== null ? this.height : this.radar);
    this.updateControls();
  }

  /** View toggles: F follow, G ghost, T tracks, Tab status panel, H height map (G3); B5: `[` / `]` seek 5 s back / ahead. */
  private onKey(e: KeyboardEvent): void {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    // G4: E while watching takes control of the picked player (while playing it is USE, InputDom's); U2: C (the
    // take-cart key; while playing C ducks) always cart.
    if (e.code === TAKEOVER_KEY && this.session.human === null) {
      e.preventDefault();
      this.takeControl();
      return;
    }
    if (e.code === this.pageKeys.keys.takeCart && this.session.human === null && this.session.playable !== null) {
      e.preventDefault();
      this.takeControl(this.session.playable);
      return;
    }
    const step = seekStepForKey(e.code);
    if (step !== null) {
      e.preventDefault();
      if (this.phase !== 'ready' || this.session.tick > 1) this.startSeek(stepTarget(this.session.tick, step));
      return;
    }
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
      if (this.phase !== 'ready' || this.seekResume !== null) return;
      this.phase = 'running';
      this.loop.reset();
      this.loop.paused = false;
    });
    on(b.pause, () => {
      if (this.phase === 'ready') return;
      if (this.seekResume !== null) {
        // Pausing during a seek: land paused.
        this.seekResume = this.seekResume === 'running' ? 'paused' : 'running';
        return;
      }
      const paused = this.phase === 'running';
      this.phase = paused ? 'paused' : 'running';
      this.loop.paused = paused;
      this.session.control({ type: 'pause', paused });
    });
    on(b.restart, () => this.restart());
    on(b.summary, () => {
      if (this.overlay.open) this.overlay.hide();
      else this.showSummary(true);
    });
    on(b.back5, () => this.startSeek(stepTarget(this.session.tick, -5)));
    on(b.back10, () => this.startSeek(stepTarget(this.session.tick, -10)));
    on(b.fwd5, () => this.startSeek(stepTarget(this.session.tick, 5)));
    on(b.takeover, () => this.takeControl());
    this.wirePicker();
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
    const seeking = this.seekResume !== null;
    const over = this.scene.cur.round.phase === 'over';
    b.summary.disabled = !over;
    b.summary.setAttribute('aria-pressed', String(this.overlay.open));
    const started = this.scene.cur.tick > 1;
    b.back5.disabled = !started;
    b.back10.disabled = !started;
    b.fwd5.disabled = !this.session.capabilities.seek;
    b.start.disabled = this.phase !== 'ready' || seeking;
    this.updateTakeover(true);
    for (const sb of b.speeds) sb.setAttribute('aria-pressed', String(Number(sb.dataset['speed']) === this.loop.speed));
    for (const ob of b.overlays) {
      const key = ob.dataset['overlay'] as OverlayKey | undefined;
      if (key !== undefined && key in this.overlays) ob.setAttribute('aria-pressed', String(this.overlays[key]));
    }
  }

  /** G4: the takeover button (label, E cap, disabled, pressed, tooltip); only touches the DOM when it changed. */
  private updateTakeover(force = false): void {
    const s = this.session;
    const v = takeoverButtonView(s.human, this.picked, s.takeControlBlocked(this.picked), this.touchOnly, this.seekResume !== null);
    const pick = document.getElementById('takeover-pick') as HTMLSelectElement | null;
    if (pick !== null) pick.disabled = s.human !== null || this.touchOnly;
    const key = `${v.label}|${v.disabled}|${v.pressed}|${v.key}|${v.title}`;
    if (!force && key === this.takeoverKey) return;
    this.takeoverKey = key;
    const b = this.buttons.takeover;
    const label = b.querySelector('span');
    if (label !== null) label.textContent = v.label;
    const cap = b.querySelector('kbd');
    if (cap !== null) cap.hidden = !v.key;
    b.disabled = v.disabled;
    b.title = v.title;
    b.setAttribute('aria-pressed', String(v.pressed));
  }

  /** U2: the player picker beside the takeover button: every player, T then CT; the pick is what E and the button take. */
  private wirePicker(): void {
    const pick = document.getElementById('takeover-pick') as HTMLSelectElement | null;
    if (pick === null) return;
    pick.replaceChildren();
    for (const team of ['T', 'CT'] as const) {
      const g = document.createElement('optgroup');
      g.label = team;
      for (const p of this.session.model.players) {
        if (p.team !== team) continue;
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.id;
        g.append(o);
      }
      pick.append(g);
    }
    pick.value = this.picked;
    pick.addEventListener('change', () => {
      if (isPlayerId(pick.value)) this.picked = pick.value;
      pick.blur();
      this.updateControls();
    });
  }

  private fileStem(): string {
    return `cs2-replay-seed${this.seed}-${this.session.human ?? 'watching'}-tick${this.scene.cur.tick}`;
  }

  private readonly frame = (now: number): void => {
    const dt = this.lastFrame === null ? 0 : now - this.lastFrame;
    this.lastFrame = now;
    if (this.seekResume !== null) this.advanceSeek();
    if (this.playing()) this.feedHuman();
    const n = this.loop.advance(dt);
    this.guard.update();
    this.updateSummary();
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
      avoid: this.hud.occupiedRects(),
      ai: s.host,
      floorZ: this.floorZ,
    });
    this.hud.update({
      scene: this.scene,
      clock: s.clock,
      human: s.human,
      you: s.human ?? FOLLOWED,
      youNote: youNote(s.human, s.human ?? FOLLOWED, this.picked, s.canTakeControlOf(this.picked), this.touchOnly),
      phase: this.phase,
      speed: this.loop.speed,
      panelOpen: this.overlays.panel,
      tick: this.scene.renderTick(alpha),
      fps: this.fpsMeter.rate(now),
      tps: this.tpsMeter.rate(now),
      ai: s.host,
      floorZ: this.floorZ,
    });
    this.updateTimeline();
    this.updateTakeover();
    this.updateCursor();
    requestAnimationFrame(this.frame);
  };

  /** The summary overlay: due 2 s after the round end, unless closed; gone once a rewind takes the round back. */
  private updateSummary(): void {
    if (this.seekResume !== null) return;
    const cur = this.scene.cur;
    if (cur.round.phase !== 'over') {
      this.summaryCache.invalidate();
      if (this.overlay.open || this.summaryDismissed) {
        this.overlay.hide();
        this.summaryDismissed = false;
        this.updateControls();
      }
      return;
    }
    if (!this.overlay.open && !this.summaryDismissed && summaryDue(cur.round, cur.tick, SUMMARY_DELAY_TICKS)) this.showSummary();
    else if (this.overlay.open && this.summaryDeaths !== this.deaths) this.showSummary();
    else if (!this.overlay.open) this.summaryCache.warm(this.session.log());
    if (this.buttons.summary.disabled) this.updateControls();
  }

  private updateTimeline(): void {
    const s = this.session;
    const seek = s.seeking;
    const cur = this.scene.cur;
    const tick = seek === null ? cur.tick : seek.tick;
    this.timeline.update({
      tick,
      span: Math.max(this.span, tick),
      marks: s.checkpoints.list().map((c) => ({ tick: c.tick, auto: c.auto })),
      endTick: seek === null && cur.round.endTick !== null ? cur.round.endTick + 1 : null,
      tapeEnd: s.tapeEnd,
      seek: seek === null ? null : { target: seek.target, fraction: seekFraction(seek.start, seek.target, seek.tick) },
    });
    const started = tick > 1;
    if (this.buttons.back5.disabled === started) this.updateControls();
  }

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
      takeoverTick: this.session.takeoverTick,
      canTakeControl: !this.touchOnly && this.session.canTakeControl,
      fps: this.fpsMeter.rate(now),
      tps: this.tpsMeter.rate(now),
      overlays: this.overlays,
      camera: this.renderer.camera,
      radarRebuilds: this.renderer.cacheRebuilds,
      labels: { ...this.renderer.labelStats, hud: this.hud.occupiedRects() },
      seeking: this.seekResume !== null,
      summaryOpen: this.overlay.open,
      checkpoints: this.session.checkpoints.size,
      guard: { leaveGuard: this.guard.guarded, keyboardLocked: this.guard.keyboardLocked, fullscreen: this.guard.fullscreen, duckKey: this.keys.binds.duck },
    };
  }
}

/** G3: how far below a pawn's feet the height cue looks for a floor (units). */
const FLOOR_LOOKUP_DOWN = 1024;

async function boot(): Promise<void> {
  const status = el('status', HTMLElement);
  try {
    const params = new URLSearchParams(window.location.search);
    const seedParam = Number(params.get('seed') ?? '1');
    const seed = Number.isInteger(seedParam) ? seedParam : 1;
    // H3: ?scenario= (default the recorded round); free play on Mirage (docs/scenarios.md).
    const name = params.get('scenario') ?? DEFAULT_SCENARIO_2D;
    const sc = scenarioList().find((q) => q.name === name);
    if (sc === undefined) throw new Error(`unknown scenario "${name}" (this page has: ${scenarioList().map((q) => q.name).join(', ')})`);
    const a = await loadAssets(params.get('map') === null && sc.recording === null ? 'mirage-cs2' : parseMapId(params.get('map') ?? sc.map));
    const data = parseSessionData(a.round, a.nav, tuningJson, a.vision, a.world3d);
    if (sc.recording === null) {
      const n = await loadFreePlayNav(sc.map);
      const f = freePlay2d(data, sc, n.info, n.nav);
      new App(f.data, a.radar, sc.seed, startHuman(params.get('human')) ?? sc.human, a.height, f.makeSession);
    } else new App(data, a.radar, seed, startHuman(params.get('human')), a.height);
    status.hidden = true;
  } catch (err) {
    status.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  }
}

void boot();
