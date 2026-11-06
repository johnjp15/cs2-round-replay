/**
 * ReplayCore: the ICore that replays the recording. It sets the round up, drives
 * every REPLAY pawn along its recorded track (B2 puppets, src/core/puppet.ts), makes
 * the puppets act the recording (B3 scripted events, src/core/scripted.ts: aim, fire,
 * damage, weapons, utility, plant, defuse) and reports status. See docs/core.md
 * "ReplayCore", "Puppets" and "Scripted events".
 */
import {
  PLAYER_IDS,
  Rng,
  toJsonValue,
  type Act,
  type Action,
  type Control,
  type CoreSnapshot,
  type ICore,
  type Mode,
  type Observe,
  type PawnInput,
  type PawnObs,
  type PawnStatus,
  type PlayerId,
  type SettableMode,
  type Tuning,
  type WalkQuery,
} from '../contracts/index';
import { RoundClock } from './clock';
import { PuppetController, PuppetTrack, type PuppetState } from './puppet';
import type { RoundModel } from './round-model';
import type { EventSchedule } from './schedule';
import { ScriptedEvents, type ScriptState } from './scripted';
import { startActions, startYaw } from './start-state';

/** Per-pawn status bookkeeping. */
interface PawnState {
  id: PlayerId;
  mode: Mode;
  /** Tick the current mode began. */
  since: number;
}

/** Everything ReplayCore keeps between steps; this is what snapshot() writes. */
interface ReplayCoreState {
  /** Set by start/restart; the next step emits startActions and clears it. */
  setupPending: boolean;
  /** Tick of the step that last emitted startActions, or null before the first start. */
  startTick: number | null;
  /** Tick of the last step, or null before the first. */
  lastTick: number | null;
  paused: boolean;
  speed: number;
  /** All ten pawns, in PLAYER_IDS order. */
  pawns: PawnState[];
  /** True on the step that emits the setup (puppets hold still: the observe predates the teleports). */
  setupThisStep: boolean;
}

export class ReplayCore implements ICore {
  readonly model: RoundModel;
  readonly schedule: EventSchedule;
  readonly tuning: Tuning;
  readonly clock: RoundClock;
  /**
   * Seeded PRNG for later tasks. Draw through `rng.fork(label)` keyed by tick and id
   * (e.g. `aim:1203:cart`): forks depend only on the seed, so snapshots stay seed-only.
   */
  readonly rng: Rng;
  /**
   * One puppet controller per player (PLAYER_IDS order), or null when the Core was
   * built without a WalkQuery: then every REPLAY pawn gets the neutral input (holds
   * still), as in B1. Tests with fake hosts that don't model the map use that.
   */
  private readonly puppets: readonly PuppetController[] | null;
  /** B3: the scripted events plan, its per-tick rules and its state (bomb events seen, decisions made). */
  readonly script: ScriptedEvents;
  private state: ReplayCoreState;

  /**
   * @param walk the engine's walkable-line query (2D sim: `NavWalkQuery`); null = no puppet movement.
   */
  constructor(model: RoundModel, schedule: EventSchedule, tuning: Tuning, seed: number, walk: WalkQuery | null = null) {
    this.model = model;
    this.schedule = schedule;
    this.tuning = tuning;
    this.clock = new RoundClock(model.meta.clock0, model.meta.bombTimerSec);
    this.rng = new Rng(seed);
    this.puppets = walk === null ? null : PLAYER_IDS.map((id) => new PuppetController(PuppetTrack.fromModel(model, schedule, tuning, id), tuning, walk));
    this.script = new ScriptedEvents(model, schedule, tuning);
    this.state = initialState();
  }

  step(o: Observe): Act {
    const s = this.state;
    const actions: Action[] = [];
    s.setupThisStep = false;
    if (s.setupPending) {
      for (const a of startActions(this.model, this.tuning)) actions.push(a);
      s.setupPending = false;
      s.setupThisStep = true;
      s.startTick = o.tick;
      for (const p of s.pawns) {
        p.mode = 'REPLAY';
        p.since = o.tick;
      }
      if (this.puppets !== null) for (const c of this.puppets) c.reset(startYaw(this.model, c.id).yaw);
      this.script.reset();
      for (const a of this.script.blockActions(o, s.pawns)) actions.push(a);
    }

    const byId = new Map<PlayerId, PawnObs>();
    for (const p of o.pawns) byId.set(p.id, p);

    // Status: DEAD once the engine reports the pawn dead; otherwise LIVE stays LIVE (B4 sets it
    // through setPawnMode) and anything else is REPLAY.
    for (const p of s.pawns) {
      const obs = byId.get(p.id);
      if (obs === undefined) continue;
      const mode: Mode = !obs.alive ? 'DEAD' : p.mode === 'LIVE' ? 'LIVE' : 'REPLAY';
      if (mode !== p.mode) {
        p.mode = mode;
        p.since = o.tick;
      }
    }

    this.scheduledActions(o, actions);

    // Inputs for every REPLAY pawn (alive, not the human's, not LIVE), in id order:
    // the puppet's movement (B2), then the scripted look and buttons (B3).
    const inputs: PawnInput[] = [];
    for (const p of s.pawns) {
      const obs = byId.get(p.id);
      if (obs === undefined || !obs.alive || p.id === o.human || p.mode !== 'REPLAY') continue;
      const c = this.puppet(p.id);
      const prevYaw = c?.state.yaw ?? obs.yaw;
      const base = this.pawnInput(obs, o, actions);
      inputs.push(s.setupThisStep ? base : this.scriptedInput(base, obs, o, prevYaw));
    }

    const status: PawnStatus[] = s.pawns.map((p) => ({ id: p.id, mode: p.mode, trigger: null, sinceTick: p.since }));
    s.lastTick = o.tick;
    return { inputs, actions, status };
  }

  control(c: Control): void {
    switch (c.type) {
      case 'start':
      case 'restart':
        this.state = { ...initialState(), paused: this.state.paused, speed: this.state.speed, setupPending: true };
        this.script.reset();
        return;
      case 'pause':
        this.state.paused = c.paused;
        return;
      case 'speed':
        if (!Number.isFinite(c.x) || c.x <= 0) throw new RangeError(`speed: expected a positive multiplier, got ${c.x}`);
        this.state.speed = c.x;
        return;
      case 'seek':
      case 'checkpoint':
      case 'rewind':
        throw new Error(`${c.type}: not implemented until B5`);
    }
  }

  get paused(): boolean {
    return this.state.paused;
  }

  get speed(): number {
    return this.state.speed;
  }

  /** The puppet controller for `id`, or null when puppets are off (no WalkQuery). */
  puppet(id: PlayerId): PuppetController | null {
    return this.puppets === null ? null : (this.puppets.find((c) => c.id === id) ?? null);
  }

  /** A pawn's Core mode (REPLAY, LIVE or DEAD). */
  modeOf(id: PlayerId): Mode {
    const p = this.state.pawns.find((q) => q.id === id);
    if (p === undefined) throw new Error(`ReplayCore.modeOf: unknown pawn ${id}`);
    return p.mode;
  }

  /** Snaps since the last start / restart, all pawns. */
  get snapCount(): number {
    let n = 0;
    if (this.puppets !== null) for (const c of this.puppets) n += c.state.snaps;
    return n;
  }

  snapshot(): CoreSnapshot {
    const puppets: PuppetState[] = this.puppets === null ? [] : this.puppets.map((c) => c.state);
    return { kind: 'core', data: toJsonValue({ seed: this.rng.seed, state: this.state, puppets, script: this.script.state }) };
  }

  restore(snap: CoreSnapshot): void {
    if (snap.kind !== 'core') throw new Error('ReplayCore.restore: not a core snapshot');
    const d = snap.data as unknown as { seed: number; state: ReplayCoreState; puppets: PuppetState[]; script: ScriptState };
    if (d.seed !== this.rng.seed) throw new Error(`ReplayCore.restore: snapshot seed ${d.seed} != core seed ${this.rng.seed}`);
    const st = d.state;
    this.state = {
      setupPending: st.setupPending,
      setupThisStep: st.setupThisStep,
      startTick: st.startTick,
      lastTick: st.lastTick,
      paused: st.paused,
      speed: st.speed,
      pawns: PLAYER_IDS.map((id) => {
        const p = st.pawns.find((q) => q.id === id);
        if (p === undefined) throw new Error(`ReplayCore.restore: no state for ${id}`);
        return { id, mode: p.mode, since: p.since };
      }),
    };
    if (d.script === undefined || d.script === null) throw new Error('ReplayCore.restore: snapshot has no scripted-events state (made before B3)');
    this.script.restore(d.script);
    if (this.puppets !== null) {
      for (const c of this.puppets) {
        const ps = d.puppets.find((q) => q.id === c.id);
        if (ps === undefined) throw new Error(`ReplayCore.restore: no puppet state for ${c.id}`);
        c.restore(ps);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Extension points
  // -------------------------------------------------------------------------

  /**
   * The input for one REPLAY pawn this tick (alive, not the human's), called in id
   * order after `scheduledActions`. The puppet controller drives it along its track
   * and may append a snap (`teleport` + `log`) to `actions`. Without puppets (no
   * WalkQuery) the pawn holds still, looking where it already looks.
   *
   * On the setup step (puppets on or off) every pawn holds still at the yaw of its setup
   * `teleport`: this observe predates the teleports, and the engine applies the input's
   * yaw after them, so the observed (pre-setup) yaw would undo the start yaw.
   */
  protected pawnInput(p: PawnObs, o: Observe, actions: Action[]): PawnInput {
    if (this.state.setupThisStep) return { id: p.id, forward: 0, side: 0, yaw: startYaw(this.model, p.id).yaw, pitch: 0, buttons: [] };
    const c = this.puppet(p.id);
    if (c === null) return { id: p.id, forward: 0, side: 0, yaw: p.yaw, pitch: p.pitch, buttons: [] };
    const r = c.input(p, o, o.tick);
    for (const a of r.actions) actions.push(a);
    return r.input;
  }

  /**
   * B3 (scripted events): append this tick's scripted actions (damage, weapons, grenade
   * selection, plant / defuse fallbacks, drop logs) after the setup actions. See
   * `ScriptedEvents.actions`.
   */
  protected scheduledActions(o: Observe, actions: Action[]): void {
    this.script.actions(o, this.state.pawns, actions);
  }

  /**
   * B3: the scripted look (aim, defuse, grenade pitch) and buttons (ATTACK, USE) on top of the
   * puppet's movement input, for every REPLAY pawn except on the setup step. The commanded yaw
   * is written back to the puppet, so its turn limit continues from where the aim left it.
   * `prevYaw` is the puppet's last commanded yaw (before this tick's movement input).
   */
  protected scriptedInput(base: PawnInput, p: PawnObs, o: Observe, prevYaw: number): PawnInput {
    const input = this.script.input(base, p, o, prevYaw);
    const c = this.puppet(p.id);
    if (c !== null) c.state.yaw = input.yaw;
    return input;
  }

  /**
   * Change a pawn's Core mode from `tick` (B4 triggers: REPLAY <-> LIVE). Scripted shots and
   * damage involving a LIVE pawn are dropped; a LIVE pawn gets no input.
   */
  protected setPawnMode(id: PlayerId, mode: SettableMode, tick: number): void {
    const p = this.state.pawns.find((q) => q.id === id);
    if (p === undefined) throw new Error(`ReplayCore.setPawnMode: unknown pawn ${id}`);
    if (p.mode === mode) return;
    p.mode = mode;
    p.since = tick;
  }
}

function initialState(): ReplayCoreState {
  return {
    setupPending: false,
    setupThisStep: false,
    startTick: null,
    lastTick: null,
    paused: false,
    speed: 1,
    pawns: PLAYER_IDS.map((id) => ({ id, mode: 'REPLAY' as Mode, since: 0 })),
  };
}
