/**
 * Session: the DOM-free driver that owns one Sim2DHost, one ReplayCore and the SessionLog, and runs
 * the per-tick contract (docs/contracts.md, docs/movement.md):
 *
 *   observe (canonicalized) → core.step → log.append → host.apply → host.tick
 *
 * Used by the browser app (main.ts) and, later, the headless harness (C5) in Node. No DOM, clocks
 * or randomness: the same config and the same calls give a byte-identical log.
 *
 * - A new Session is armed: `start` has already been delivered to Core, so the first step() (tick 0)
 *   emits the round setup. It is logged in that line's `controls`.
 * - Controls go to Core when control() is called and are logged with the next step's line ("delivered
 *   since the previous tick"). pause and speed are paced by the driver (see loop.ts); Sim2DHost has no
 *   use for them. checkpoint / rewind / seek are the driver's (B5, below): not logged, except the `rewind`
 *   a resync sends the Core.
 * - B5 checkpoints: one every `replay.checkpointSec` (taken before the step of a tick multiple) and on demand,
 *   the last `replay.checkpointMax` kept (src/core/checkpoints.ts). A rewind is exact when the host can snapshot
 *   (host and Core restored, log cut back: what follows is byte-identical given the same inputs), else a resync
 *   (Core restored, log cut back, `rewind {id}` to the Core and the checkpoint's observe fed to the next step, whose
 *   Act puts the engine back: CS2). Seek: back = rewind to the latest checkpoint at or before t, then forward = step
 *   tick by tick, replaying the human's recorded inputs and weapon slots, so a seek lands where a straight run would.
 * - The human pawn's input comes from setHumanInput(); weapon-slot requests (keys 1–5) are queued and
 *   turned into `set_weapon` actions for the human pawn, appended after Core's actions when the act
 *   is applied to the host. Neither is in the logged Act: in CS2 the human moves and switches weapons
 *   natively, and the Replayer diffs Core's own output. The next observe shows the result.
 */
import {
  ALL_CAPABILITIES,
  SessionLog,
  applyTracks3d,
  canonicalize,
  parseRound,
  parseTracks3d,
  parseTuning,
  toReplayTrace,
  type Act,
  type Action,
  type Control,
  type CoreSnapshot,
  type HostCapabilities,
  type HostSnapshot,
  type JsonValue,
  type Observe,
  type PawnInput,
  type PlayerId,
  type ReplayTrace,
  type RoundData,
  type Tuning,
  type WalkQuery,
} from '../contracts/index';
import { CheckpointStore, EventSchedule, ReplayCore, RoundModel, autoCheckpointId, checkpointInterval, tickOf, type Checkpoint, type RoundClock } from '../core/index';
import { HullWalkQuery, MapGeometry, NavMesh, NavWalkQuery, Sim2DHost, nav3dFor, VisMask, combineMeshes, decodeGeometry, navOptionsFromTuning, visOptionsFromTuning, type HostNote, type PawnState, type RosterEntry } from '../sim2d/index';
import { weaponForSlot, type WeaponSlot } from './input';

/** The pawn a human plays unless told otherwise. */
export const DEFAULT_HUMAN: PlayerId = 'cart';

/** The parsed data files a session is built from. */
export interface SessionData {
  /** The round the Session plays: `round.json`, with the snapped 3D tracks applied when there is a 3D world (G3). */
  readonly round: RoundData;
  readonly nav: NavMesh;
  readonly tuning: Tuning;
  /** The sight mask (`mirage-vismask.json`, C4), or null for the nav mesh's line of sight. */
  readonly vision: VisMask | null;
  /** G3: the movement mesh (world + player clips) for 3D movement, or null for the nav's 2D movement. */
  readonly geometry?: MapGeometry | null;
  /** G3: `round.json` as recorded (before snapping); the same object as `round` without a 3D world. */
  readonly recorded?: RoundData;
}

/**
 * G3: the 3D world's files: `data/geometry/mirage-geometry.bin` (CS2 collision), `mirage-clips.bin` (player clips)
 * and `mirage-tracks.json` (the snapped tracks; JSON value or text). docs/geometry.md, docs/movement.md.
 */
export interface World3dFiles {
  readonly geometry: Uint8Array;
  readonly clips: Uint8Array;
  readonly tracks: unknown;
}

/**
 * Parse `round.json`, `mirage-nav.json`, `tuning.json` and `mirage-vismask.json` (as JSON values or text; the mask
 * may be null), and (G3) the 3D world: with it the session moves pawns in 3D on the CS2 mesh and plays the snapped
 * tracks. Throws on bad data.
 */
export function parseSessionData(roundJson: unknown, navJson: unknown, tuningJson: unknown, visionJson: unknown = null, world3d: World3dFiles | null = null): SessionData {
  const tuning = parseTuning(tuningJson);
  const nav = NavMesh.fromJson(typeof navJson === 'string' ? (JSON.parse(navJson) as unknown) : navJson, navOptionsFromTuning(tuning));
  const vis = typeof visionJson === 'string' ? (JSON.parse(visionJson) as unknown) : visionJson;
  const vision = vis === null ? null : VisMask.fromJson(vis, visOptionsFromTuning(tuning.ai));
  const recorded = parseRound(roundJson);
  if (world3d === null) return { round: recorded, nav, tuning, vision, geometry: null, recorded };
  const geometry = new MapGeometry(combineMeshes(decodeGeometry(world3d.geometry), decodeGeometry(world3d.clips)));
  // Paths (the LIVE AI, G1's pathLength) only through portals a hull can cross on the CS2 mesh.
  const nav3d = nav.with3d(nav3dFor(geometry, tuning.movement.stepSize));
  return { round: applyTracks3d(recorded, parseTracks3d(world3d.tracks)), nav: nav3d, tuning, vision, geometry, recorded };
}

/** What a Core is built from. */
export interface CoreParts {
  readonly model: RoundModel;
  readonly schedule: EventSchedule;
  readonly tuning: Tuning;
  readonly seed: number;
  readonly nav: NavMesh;
  /** G3: the movement mesh, or null with 2D movement. */
  readonly geometry?: MapGeometry | null;
}

export type CoreFactory = (parts: CoreParts) => ReplayCore;

/**
 * The WalkQuery the app's Core uses: with 3D movement (G3) the hull sweep on the movement mesh (`HullWalkQuery`), so
 * puppets steer around the walls they actually collide with; otherwise the nav mesh's (B2). Paths are the nav's either way.
 */
export function walkQueryOf(p: { readonly nav: NavMesh; readonly geometry?: MapGeometry | null; readonly tuning: Tuning }): WalkQuery {
  const g = p.geometry ?? null;
  return g === null ? new NavWalkQuery(p.nav) : new HullWalkQuery(g, p.nav, p.tuning.movement.stepSize);
}

/** The Core every session uses unless told otherwise: puppets steer with `walkQueryOf` (B2, G3). */
export function defaultCore(p: CoreParts): ReplayCore {
  return new ReplayCore(p.model, p.schedule, p.tuning, p.seed, walkQueryOf(p));
}

export interface SessionConfig {
  /** Parsed `data/round.json` (parseRound). */
  readonly round: RoundData;
  readonly nav: NavMesh;
  readonly tuning: Tuning;
  readonly seed: number;
  /** The sight mask (C4); without it (or null) the engine uses the nav mesh's line of sight. */
  readonly vision?: VisMask | null;
  /** G3: the movement mesh for 3D movement (SessionData.geometry); without it (or null) the nav's 2D movement. */
  readonly geometry?: MapGeometry | null;
  /** The pawn the human plays: `cart` by default, or null to spectate (all ten pawns replay). */
  readonly human?: PlayerId | null;
  /** Builds the Core (default: defaultCore). For tests, benchmarks and Core variants. */
  readonly core?: CoreFactory;
  /**
   * B5: turn host capabilities off (they are and-ed with the host's): `{snapshot: false}` makes rewinds resync the
   * engine as on a CS2 server (tests); `{seek: false}` refuses forward seeks; `{speed: false}` the speed control.
   */
  readonly capabilities?: Partial<HostCapabilities>;
}

/** B5: what a seek is doing. */
export interface SeekProgress {
  /** Tick when the seek began (before any rewind). */
  readonly from: number;
  /** Tick the forward stepping began (after a rewind: the checkpoint's). */
  readonly start: number;
  readonly target: number;
  /** The tick the next step runs. */
  readonly tick: number;
  /** The checkpoint it rewound to first (a seek back), or null. */
  readonly rewound: string | null;
  readonly done: boolean;
}

/** What Session keeps in a checkpoint's `extra` (plain JSON). */
interface CheckpointExtra {
  readonly pending: Control[];
  readonly slotRequests: WeaponSlot[];
  readonly paused: boolean;
  readonly speed: number;
}

/** One entry of the human's input history: what was set before the step of `tick` (null = no input). */
interface HumanInputAt {
  readonly tick: number;
  readonly input: PawnInput | null;
}

interface SlotAt {
  readonly tick: number;
  readonly slot: WeaponSlot;
}

const SNAPSHOT_VERSION = 1;

/** Everything needed to put a Session back exactly where it was (plain JSON data). */
export interface SessionSnapshot {
  readonly kind: 'session';
  readonly version: number;
  readonly seed: number;
  readonly human: PlayerId | null;
  readonly host: HostSnapshot;
  readonly core: CoreSnapshot;
  /** Controls delivered to Core but not yet logged. */
  readonly pending: readonly Control[];
  /** Weapon-slot requests not yet applied. */
  readonly slotRequests: readonly WeaponSlot[];
  readonly paused: boolean;
  readonly speed: number;
  readonly lastAct: Act | null;
  /** The log up to this point. restore() cuts the log back to it, so the log stays replayable. */
  readonly logLines: readonly string[];
}

export class Session {
  readonly round: RoundData;
  readonly nav: NavMesh;
  /** G3: the movement mesh, or null (2D movement). */
  readonly geometry: MapGeometry | null;
  readonly tuning: Tuning;
  readonly seed: number;
  readonly human: PlayerId | null;
  readonly model: RoundModel;
  readonly schedule: EventSchedule;
  /** For inspection (renderer, tests); drive the session through its own methods. */
  readonly host: Sim2DHost;
  readonly core: ReplayCore;
  private sessionLog = new SessionLog();
  private pending: Control[] = [];
  private slotRequests: WeaponSlot[] = [];
  private lastActValue: Act | null = null;
  private pausedValue = false;
  private speedValue = 1;
  /** State right after construction; restart() returns to it. */
  private readonly initial: SessionSnapshot;
  /** B5: the host's capabilities as this session uses them (and-ed with SessionConfig.capabilities). */
  readonly capabilities: HostCapabilities;
  /** B5: rewind / seek targets (read them; Session adds and drops them). */
  readonly checkpoints: CheckpointStore;
  private readonly checkpointTicks: number;
  /** B5: after a resync rewind, the checkpoint's observe for the next step (else null). */
  private resyncObserve: Observe | null = null;
  /** B5: the human's inputs and weapon-slot presses by tick in this run so far (a seek back replays them). */
  private humanTrack: HumanInputAt[] = [];
  private slotTrack: SlotAt[] = [];
  /**
   * B5: the "tape": what the human did after the current tick before a rewind or seek took the run back. A forward
   * seek replays it (scrubbing back and forth keeps the run); the first live step (not a seek) discards it.
   */
  private tapeInputs: HumanInputAt[] = [];
  private tapeSlots: SlotAt[] = [];
  /** How far the run the tape comes from got (its next tick then), or null without a tape. */
  private tapeUntil: number | null = null;
  /** True while advanceSeek steps (inputs are replayed, the tape is kept). */
  private replaying = false;
  /** B5: the seek in progress. */
  private seekState: { from: number; start: number; target: number; rewound: string | null } | null = null;

  constructor(config: SessionConfig) {
    this.round = config.round;
    this.nav = config.nav;
    this.tuning = config.tuning;
    this.seed = config.seed;
    this.human = config.human === undefined ? DEFAULT_HUMAN : config.human;
    this.model = new RoundModel(config.round);
    this.schedule = new EventSchedule(config.round);
    const roster: RosterEntry[] = this.model.players.map((p) => ({ id: p.id, team: p.team }));
    this.geometry = config.geometry ?? null;
    this.host = new Sim2DHost(
      config.nav,
      config.tuning,
      roster,
      { score: config.round.meta.score, roundTimeSec: config.round.meta.clock0 },
      { mask: config.vision ?? null, seed: config.seed },
      this.geometry,
    );
    this.host.setHuman(this.human);
    const makeCore = config.core ?? defaultCore;
    this.core = makeCore({ model: this.model, schedule: this.schedule, tuning: config.tuning, seed: config.seed, nav: config.nav, geometry: this.geometry });
    const hc = this.host.capabilities();
    const want = { ...ALL_CAPABILITIES, ...(config.capabilities ?? {}) };
    this.capabilities = { snapshot: hc.snapshot && want.snapshot, seek: hc.seek && want.seek, speed: hc.speed && want.speed };
    this.checkpoints = new CheckpointStore(config.tuning.replay.checkpointMax);
    this.checkpointTicks = checkpointInterval(config.tuning.replay.checkpointSec);
    this.control({ type: 'start' });
    this.initial = this.snapshot();
  }

  /**
   * Run one tick. Returns Core's Act for it (as logged). Before the step of every `replay.checkpointSec` tick
   * multiple it takes an automatic checkpoint (not logged; it changes nothing).
   */
  step(): Act {
    if (this.resyncObserve === null && this.tick % this.checkpointTicks === 0 && !this.checkpoints.hasAt(this.tick)) this.takeCheckpoint(autoCheckpointId(this.tick), true);
    // Played live: the run goes its own way from here, and the old future is gone.
    if (!this.replaying && this.tapeUntil !== null) this.dropTape();
    const o = this.resyncObserve ?? canonicalize(this.host.observe());
    this.resyncObserve = null;
    const controls = this.pending;
    this.pending = [];
    const act = this.core.step(o);
    this.sessionLog.append(o, act, controls);
    this.host.apply(this.withHumanActions(act));
    this.host.tick();
    this.lastActValue = act;
    return act;
  }

  /**
   * App → Core / engine control.
   * - `restart`: restart() (a driver-level reset, see there).
   * - `start`, `pause`, `speed`: to Core (it validates them). The driver paces pause/speed. `speed` throws without
   *   the speed capability.
   * - `checkpoint {id}`, `rewind {id}`, `seek {t}` (B5): checkpoint(), rewind(), seek(); driver work, not logged
   *   (a resync rewind logs the `rewind` it sends the Core).
   * Every control that reaches Core is logged with the next step.
   */
  control(c: Control): void {
    switch (c.type) {
      case 'restart':
        this.restart();
        return;
      case 'checkpoint':
        this.checkpoint(c.id);
        return;
      case 'rewind':
        this.rewind(c.id);
        return;
      case 'seek':
        this.seek(c.t);
        return;
      case 'start':
        this.core.control(c);
        break;
      case 'pause':
        this.core.control(c);
        this.pausedValue = c.paused;
        break;
      case 'speed':
        if (!this.capabilities.speed) throw new Error('speed: the host can only run in real time');
        this.core.control(c);
        this.speedValue = c.x;
        break;
    }
    this.pending.push(canonicalize(c));
  }

  // ---- B5: checkpoints, rewind, seek ------------------------------------------------------------

  /** Take a checkpoint now (before the next step) under `id`, replacing one with that id. Not logged. */
  checkpoint(id: string): Checkpoint {
    if (typeof id !== 'string' || id === '') throw new Error('checkpoint: expected an id');
    if (this.resyncObserve !== null) throw new Error('checkpoint: a resync is pending; step first');
    return this.takeCheckpoint(id, false);
  }

  /**
   * Back to checkpoint `id` (see the file comment): exact with the snapshot capability, else a resync on the next
   * step. Later checkpoints are dropped; what the human did after the checkpoint becomes the tape a forward seek
   * replays. Throws for an unknown id.
   */
  rewind(id: string): Checkpoint {
    const cp = this.checkpoints.get(id);
    if (cp === null) throw new Error(`rewind: no checkpoint ${id}`);
    this.seekState = null;
    const lastInput = this.humanTrack.length === 0 ? -1 : (this.humanTrack[this.humanTrack.length - 1] as HumanInputAt).tick;
    const lastSlot = this.slotTrack.length === 0 ? -1 : (this.slotTrack[this.slotTrack.length - 1] as SlotAt).tick;
    this.tapeInputs = [...this.humanTrack.filter((e) => e.tick >= cp.tick), ...this.tapeInputs.filter((e) => e.tick > lastInput)];
    this.tapeSlots = [...this.slotTrack.filter((e) => e.tick >= cp.tick), ...this.tapeSlots.filter((e) => e.tick > lastSlot)];
    this.humanTrack = this.humanTrack.filter((e) => e.tick < cp.tick);
    this.slotTrack = this.slotTrack.filter((e) => e.tick < cp.tick);
    if (this.human !== null) this.tapeUntil = Math.max(this.tick, this.tapeUntil ?? 0);
    this.rewindTo(cp);
    return cp;
  }

  /** The checkpoint a rewind or seek to `tick` starts from: the latest at or before it (without hazards when resyncing). */
  checkpointFor(tick: number): Checkpoint | null {
    return this.checkpoints.atOrBefore(tick, !this.capabilities.snapshot);
  }

  /**
   * Start a seek to video second `t` (B5). Behind the current tick: rewind to checkpointFor(t) first. Then (seek
   * capability) step to the target with advanceSeek, replaying the human's inputs and weapon slots from the tape
   * (what he did on those ticks before); without it the seek ends at the checkpoint (a live server can't run ahead).
   * A forward seek without the capability throws.
   */
  beginSeek(t: number): SeekProgress {
    if (!Number.isFinite(t) || t < 0) throw new RangeError(`seek: expected seconds >= 0, got ${t}`);
    const target = tickOf(t);
    const from = this.tick;
    if (target >= from && !this.capabilities.seek) throw new Error('seek: the host can only run in real time (no seeking ahead)');
    let rewound: string | null = null;
    if (target < from) {
      const cp = this.checkpointFor(target);
      if (cp === null) throw new Error(`seek: no checkpoint at or before tick ${target}`);
      this.rewind(cp.id);
      rewound = cp.id;
    }
    this.seekState = { from, start: this.tick, target: this.capabilities.seek ? target : this.tick, rewound };
    return this.seekProgress();
  }

  /** Step at most `maxTicks` toward the seek target (no rendering: the app calls this per animation frame). */
  advanceSeek(maxTicks: number): SeekProgress {
    const sk = this.seekState;
    if (sk === null) throw new Error('advanceSeek: no seek in progress');
    this.replaying = true;
    try {
      for (let n = 0; n < maxTicks && this.tick < sk.target; n++) {
        const k = this.tick;
        const inputs = this.tapeInputs.filter((e) => e.tick === k);
        const slots = this.tapeSlots.filter((e) => e.tick === k);
        if (inputs.length > 0) this.tapeInputs = this.tapeInputs.filter((e) => e.tick !== k);
        if (slots.length > 0) this.tapeSlots = this.tapeSlots.filter((e) => e.tick !== k);
        for (const e of inputs) this.setHumanInput(e.input);
        for (const e of slots) this.requestWeaponSlot(e.slot);
        this.step();
      }
    } finally {
      this.replaying = false;
    }
    const p = this.seekProgress();
    if (p.done) this.seekState = null;
    return p;
  }

  /** The seek in progress, or null. */
  get seeking(): SeekProgress | null {
    return this.seekState === null ? null : this.seekProgress();
  }

  /** Stop a seek where it is. */
  cancelSeek(): void {
    this.seekState = null;
  }

  /** A whole seek at once (Node, tests; the app chunks it with beginSeek / advanceSeek). */
  seek(t: number): SeekProgress {
    this.beginSeek(t);
    return this.advanceSeek(Number.POSITIVE_INFINITY);
  }

  /** Seek `sec` seconds back from the next tick (the −5 s / −10 s buttons), not before 0. */
  rewindBy(sec: number): SeekProgress {
    return this.seek(Math.max(0, this.tick - sec * 64) / 64);
  }

  /**
   * How far the human's replayable future (the tape) reaches: the tick the run it comes from had got to, while that is
   * ahead of now; else null. A forward seek up to it replays what he did; past it his last input stays held.
   */
  get tapeEnd(): number | null {
    return this.tapeUntil !== null && this.tapeUntil > this.tick ? this.tapeUntil : null;
  }

  private dropTape(): void {
    this.tapeInputs = [];
    this.tapeSlots = [];
    this.tapeUntil = null;
  }

  private seekProgress(): SeekProgress {
    const sk = this.seekState;
    const tick = this.tick;
    if (sk === null) return { from: tick, start: tick, target: tick, tick, rewound: null, done: true };
    return { from: sk.from, start: sk.start, target: sk.target, tick, rewound: sk.rewound, done: tick >= sk.target };
  }

  private takeCheckpoint(id: string, auto: boolean): Checkpoint {
    const o = canonicalize(this.host.observe());
    const extra: CheckpointExtra = { pending: [...this.pending], slotRequests: [...this.slotRequests], paused: this.pausedValue, speed: this.speedValue };
    const cp: Checkpoint = {
      id,
      tick: o.tick,
      auto,
      core: this.core.snapshot(),
      host: this.capabilities.snapshot ? this.host.snapshot() : null,
      observe: o,
      logLength: this.sessionLog.length,
      hazards: this.core.checkpointHazards(o),
      extra: extra as unknown as JsonValue,
    };
    this.checkpoints.add(cp);
    return cp;
  }

  /** Restore Core (and the host, when it can) to a checkpoint; cut the log back; arm a resync otherwise. */
  private rewindTo(cp: Checkpoint): void {
    const x = cp.extra as unknown as CheckpointExtra;
    this.core.restore(cp.core);
    this.pending = [...x.pending];
    this.slotRequests = [...x.slotRequests];
    this.pausedValue = x.paused;
    this.speedValue = x.speed;
    if (cp.logLength < this.sessionLog.length) this.sessionLog = this.sessionLog.head(cp.logLength);
    this.lastActValue = cp.logLength === 0 ? null : (this.sessionLog.at(cp.logLength - 1)?.act ?? null);
    this.checkpoints.dropAfter(cp.tick);
    if (this.capabilities.snapshot && cp.host !== null) {
      this.host.restore(cp.host);
      this.resyncObserve = null;
    } else {
      const c: Control = { type: 'rewind', id: cp.id };
      this.core.control(c);
      this.pending.push(c);
      this.resyncObserve = cp.observe;
    }
  }

  /**
   * Back to the state right after construction, byte for byte: host and Core restored from the
   * snapshot taken then (so `start` is pending again, the log is empty, human input and slot
   * requests are cleared, and pause/speed are Core's defaults). A run after restart() logs exactly
   * what the first run logged, given the same calls. The app re-sends speed if it is not 1×.
   */
  restart(): void {
    this.restore(this.initial);
    this.checkpoints.clear();
    this.humanTrack = [];
    this.slotTrack = [];
    this.dropTape();
  }

  /**
   * Input for the human pawn, used for every tick until replaced; null hands the pawn back to Core.
   * `input.id` must be the human pawn. Throws while spectating.
   */
  setHumanInput(input: PawnInput | null): void {
    if (input !== null && this.human === null) throw new Error('Session.setHumanInput: spectating (no human pawn)');
    this.host.setHumanInput(input);
    if (this.human === null) return;
    // B5 history: the last input set before each step (a seek replays it).
    const tick = this.tick;
    const last = this.humanTrack[this.humanTrack.length - 1];
    const copy = input === null ? null : canonicalize(input);
    if (last !== undefined && last.tick === tick) this.humanTrack[this.humanTrack.length - 1] = { tick, input: copy };
    else this.humanTrack.push({ tick, input: copy });
  }

  /**
   * Queue a weapon-slot press for the human pawn (keys 1–5). On the next step it becomes a
   * `set_weapon` for the weapon weaponForSlot() picks, applied after Core's actions; nothing happens
   * if the slot is empty. Returns false (and queues nothing) while spectating.
   */
  requestWeaponSlot(slot: WeaponSlot): boolean {
    if (this.human === null) return false;
    this.slotRequests.push(slot);
    this.slotTrack.push({ tick: this.tick, slot });
    return true;
  }

  snapshot(): SessionSnapshot {
    return {
      kind: 'session',
      version: SNAPSHOT_VERSION,
      seed: this.seed,
      human: this.human,
      host: this.host.snapshot(),
      core: this.core.snapshot(),
      pending: [...this.pending],
      slotRequests: [...this.slotRequests],
      paused: this.pausedValue,
      speed: this.speedValue,
      lastAct: this.lastActValue,
      logLines: this.sessionLog.lines(),
    };
  }

  /**
   * Return to a snapshot of this session (same seed and human). The log is cut back to the
   * snapshot's lines, so stepping on reproduces what followed the snapshot the first time.
   * Rebuilding a long log re-parses it (roughly 0.1 s per 1,000 ticks); restoring to the current
   * length or to an empty log is free.
   */
  restore(s: SessionSnapshot): void {
    if (s.kind !== 'session' || s.version !== SNAPSHOT_VERSION) throw new Error('Session.restore: not a session snapshot of this version');
    if (s.seed !== this.seed) throw new Error(`Session.restore: snapshot seed ${s.seed} != session seed ${this.seed}`);
    if (s.human !== this.human) throw new Error(`Session.restore: snapshot human ${String(s.human)} != session human ${String(this.human)}`);
    this.host.restore(s.host);
    this.core.restore(s.core);
    this.pending = [...s.pending];
    this.slotRequests = [...s.slotRequests];
    this.pausedValue = s.paused;
    this.speedValue = s.speed;
    this.lastActValue = s.lastAct;
    this.sessionLog = logFromLines(this.sessionLog, s.logLines);
    // B5: what came after the snapshot is gone.
    this.resyncObserve = null;
    this.seekState = null;
    const tick = this.tick;
    this.checkpoints.dropAfter(tick);
    this.humanTrack = this.humanTrack.filter((e) => e.tick < tick);
    this.slotTrack = this.slotTrack.filter((e) => e.tick < tick);
    this.dropTape();
  }

  /** The current state as the next step will see it (already canonical). After a resync rewind: the checkpoint's. */
  observe(): Observe {
    return this.resyncObserve ?? this.host.observe();
  }

  /** The tick the next step() runs. */
  get tick(): number {
    return this.resyncObserve?.tick ?? this.host.observe().tick;
  }

  /** Core's Act from the last step (status for the UI), or null before the first. */
  get lastAct(): Act | null {
    return this.lastActValue;
  }

  /** Last pause / speed sent to Core. */
  get paused(): boolean {
    return this.pausedValue;
  }

  get speed(): number {
    return this.speedValue;
  }

  get clock(): RoundClock {
    return this.core.clock;
  }

  /** The session log. Owned by the session: read it, don't append to it. */
  log(): SessionLog {
    return this.sessionLog;
  }

  /** The log as the web replay page's trace (toReplayTrace). */
  trace(): ReplayTrace {
    return toReplayTrace(this.sessionLog);
  }

  /** Engine state of one pawn (inventory, helmet), or null. */
  pawnState(id: PlayerId): PawnState | null {
    return this.host.pawnState(id);
  }

  /** What the host received but did not apply (v0: combat, bomb and round-end actions). */
  hostNotes(): readonly HostNote[] {
    return this.host.unhandled();
  }

  /** Core's act plus `set_weapon` actions for queued slot presses (not logged; see the file comment). */
  private withHumanActions(act: Act): Act {
    if (this.slotRequests.length === 0) return act;
    const requests = this.slotRequests;
    this.slotRequests = [];
    const pawn = this.human === null ? null : this.host.pawnState(this.human);
    if (pawn === null || !pawn.alive) return act;
    const carried = pawn.inventory.map((q) => q.item);
    let current: string = pawn.weapon;
    const extra: Action[] = [];
    for (const slot of requests) {
      const weapon = weaponForSlot(slot, carried, current);
      if (weapon === null) continue;
      extra.push({ type: 'set_weapon', id: pawn.id, weapon });
      current = weapon;
    }
    return extra.length === 0 ? act : { ...act, actions: [...act.actions, ...extra] };
  }
}

/** A SessionLog holding exactly `lines`, reusing `current` when it already does. */
function logFromLines(current: SessionLog, lines: readonly string[]): SessionLog {
  if (lines.length === 0) return new SessionLog();
  if (current.length === lines.length) {
    // Usually the very same strings, so this is a pointer comparison per line.
    const have = current.lines();
    let same = true;
    for (let i = 0; same && i < lines.length; i++) same = have[i] === lines[i];
    if (same) return current;
  }
  return SessionLog.fromText(lines.join('\n'));
}
