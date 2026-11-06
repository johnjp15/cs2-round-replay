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
 *   use for them. seek / checkpoint / rewind go to Core (it throws until B5) and to the host.
 * - The human pawn's input comes from setHumanInput(); weapon-slot requests (keys 1–5) are queued and
 *   turned into `set_weapon` actions for the human pawn, appended after Core's actions when the act
 *   is applied to the host. Neither is in the logged Act: in CS2 the human moves and switches weapons
 *   natively, and the Replayer diffs Core's own output. The next observe shows the result.
 */
import {
  SessionLog,
  canonicalize,
  parseRound,
  parseTuning,
  toReplayTrace,
  type Act,
  type Action,
  type Control,
  type CoreSnapshot,
  type HostSnapshot,
  type Observe,
  type PawnInput,
  type PlayerId,
  type ReplayTrace,
  type RoundData,
  type Tuning,
} from '../contracts/index';
import { EventSchedule, ReplayCore, RoundModel, type RoundClock } from '../core/index';
import { NavMesh, NavWalkQuery, Sim2DHost, VisMask, navOptionsFromTuning, visOptionsFromTuning, type HostNote, type PawnState, type RosterEntry } from '../sim2d/index';
import { weaponForSlot, type WeaponSlot } from './input';

/** The pawn a human plays unless told otherwise. */
export const DEFAULT_HUMAN: PlayerId = 'cart';

/** The parsed data files a session is built from. */
export interface SessionData {
  readonly round: RoundData;
  readonly nav: NavMesh;
  readonly tuning: Tuning;
  /** The sight mask (`mirage-vismask.json`, C4), or null for the nav mesh's line of sight. */
  readonly vision: VisMask | null;
}

/**
 * Parse `round.json`, `mirage-nav.json`, `tuning.json` and `mirage-vismask.json` (as JSON values or text; the mask
 * may be null). Throws on bad data.
 */
export function parseSessionData(roundJson: unknown, navJson: unknown, tuningJson: unknown, visionJson: unknown = null): SessionData {
  const tuning = parseTuning(tuningJson);
  const nav = NavMesh.fromJson(typeof navJson === 'string' ? (JSON.parse(navJson) as unknown) : navJson, navOptionsFromTuning(tuning));
  const vis = typeof visionJson === 'string' ? (JSON.parse(visionJson) as unknown) : visionJson;
  const vision = vis === null ? null : VisMask.fromJson(vis, visOptionsFromTuning(tuning.ai));
  return { round: parseRound(roundJson), nav, tuning, vision };
}

/** What a Core is built from. */
export interface CoreParts {
  readonly model: RoundModel;
  readonly schedule: EventSchedule;
  readonly tuning: Tuning;
  readonly seed: number;
  readonly nav: NavMesh;
}

export type CoreFactory = (parts: CoreParts) => ReplayCore;

/** The Core every session uses unless told otherwise: puppets steer with the nav mesh's walkable-line query (B2). */
export function defaultCore(p: CoreParts): ReplayCore {
  return new ReplayCore(p.model, p.schedule, p.tuning, p.seed, new NavWalkQuery(p.nav));
}

export interface SessionConfig {
  /** Parsed `data/round.json` (parseRound). */
  readonly round: RoundData;
  readonly nav: NavMesh;
  readonly tuning: Tuning;
  readonly seed: number;
  /** The sight mask (C4); without it (or null) the engine uses the nav mesh's line of sight. */
  readonly vision?: VisMask | null;
  /** The pawn the human plays: `cart` by default, or null to spectate (all ten pawns replay). */
  readonly human?: PlayerId | null;
  /** Builds the Core (default: defaultCore). For tests, benchmarks and Core variants. */
  readonly core?: CoreFactory;
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

  constructor(config: SessionConfig) {
    this.round = config.round;
    this.nav = config.nav;
    this.tuning = config.tuning;
    this.seed = config.seed;
    this.human = config.human === undefined ? DEFAULT_HUMAN : config.human;
    this.model = new RoundModel(config.round);
    this.schedule = new EventSchedule(config.round);
    const roster: RosterEntry[] = this.model.players.map((p) => ({ id: p.id, team: p.team }));
    this.host = new Sim2DHost(config.nav, config.tuning, roster, { score: config.round.meta.score, roundTimeSec: config.round.meta.clock0 }, { mask: config.vision ?? null, seed: config.seed });
    this.host.setHuman(this.human);
    const makeCore = config.core ?? defaultCore;
    this.core = makeCore({ model: this.model, schedule: this.schedule, tuning: config.tuning, seed: config.seed, nav: config.nav });
    this.control({ type: 'start' });
    this.initial = this.snapshot();
  }

  /** Run one tick. Returns Core's Act for it (as logged). */
  step(): Act {
    const o = canonicalize(this.host.observe());
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
   * - `start`, `pause`, `speed`: to Core (it validates them). The driver paces pause/speed.
   * - `seek`, `checkpoint`, `rewind`: to Core (throws until B5), then to the host.
   * Every control that reaches Core is logged with the next step.
   */
  control(c: Control): void {
    switch (c.type) {
      case 'restart':
        this.restart();
        return;
      case 'start':
        this.core.control(c);
        break;
      case 'pause':
        this.core.control(c);
        this.pausedValue = c.paused;
        break;
      case 'speed':
        this.core.control(c);
        this.speedValue = c.x;
        break;
      case 'seek':
      case 'checkpoint':
      case 'rewind':
        this.core.control(c);
        this.host.control(c);
        break;
    }
    this.pending.push(canonicalize(c));
  }

  /**
   * Back to the state right after construction, byte for byte: host and Core restored from the
   * snapshot taken then (so `start` is pending again, the log is empty, human input and slot
   * requests are cleared, and pause/speed are Core's defaults). A run after restart() logs exactly
   * what the first run logged, given the same calls. The app re-sends speed if it is not 1×.
   */
  restart(): void {
    this.restore(this.initial);
  }

  /**
   * Input for the human pawn, used for every tick until replaced; null hands the pawn back to Core.
   * `input.id` must be the human pawn. Throws while spectating.
   */
  setHumanInput(input: PawnInput | null): void {
    if (input !== null && this.human === null) throw new Error('Session.setHumanInput: spectating (no human pawn)');
    this.host.setHumanInput(input);
  }

  /**
   * Queue a weapon-slot press for the human pawn (keys 1–5). On the next step it becomes a
   * `set_weapon` for the weapon weaponForSlot() picks, applied after Core's actions; nothing happens
   * if the slot is empty. Returns false (and queues nothing) while spectating.
   */
  requestWeaponSlot(slot: WeaponSlot): boolean {
    if (this.human === null) return false;
    this.slotRequests.push(slot);
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
  }

  /** The current state as the next step will see it (already canonical). */
  observe(): Observe {
    return this.host.observe();
  }

  /** The tick the next step() runs. */
  get tick(): number {
    return this.host.observe().tick;
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
