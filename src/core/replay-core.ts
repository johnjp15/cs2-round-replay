/**
 * ReplayCore: the ICore that replays the recording. B1 skeleton: it sets the round
 * up, holds every puppet still and reports status. B2 (movement) and B3 (scripted
 * events) extend it through the two hooks marked below. See docs/core.md "ReplayCore".
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
  type Tuning,
} from '../contracts/index';
import { RoundClock } from './clock';
import type { RoundModel } from './round-model';
import type { EventSchedule } from './schedule';
import { startActions } from './start-state';

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
  private state: ReplayCoreState;

  constructor(model: RoundModel, schedule: EventSchedule, tuning: Tuning, seed: number) {
    this.model = model;
    this.schedule = schedule;
    this.tuning = tuning;
    this.clock = new RoundClock(model.meta.clock0, model.meta.bombTimerSec);
    this.rng = new Rng(seed);
    this.state = initialState();
  }

  step(o: Observe): Act {
    const s = this.state;
    const actions: Action[] = [];
    if (s.setupPending) {
      for (const a of startActions(this.model, this.tuning)) actions.push(a);
      s.setupPending = false;
      s.startTick = o.tick;
      for (const p of s.pawns) {
        p.mode = 'REPLAY';
        p.since = o.tick;
      }
    }

    const byId = new Map<PlayerId, PawnObs>();
    for (const p of o.pawns) byId.set(p.id, p);

    // Status: DEAD once the engine reports the pawn dead, REPLAY otherwise.
    for (const p of s.pawns) {
      const obs = byId.get(p.id);
      if (obs === undefined) continue;
      const mode: Mode = obs.alive ? 'REPLAY' : 'DEAD';
      if (mode !== p.mode) {
        p.mode = mode;
        p.since = o.tick;
      }
    }

    this.scheduledActions(o, actions);

    const inputs: PawnInput[] = [];
    for (const id of PLAYER_IDS) {
      const obs = byId.get(id);
      if (obs === undefined || !obs.alive || id === o.human) continue;
      inputs.push(this.pawnInput(obs, o));
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

  snapshot(): CoreSnapshot {
    return { kind: 'core', data: toJsonValue({ seed: this.rng.seed, state: this.state }) };
  }

  restore(snap: CoreSnapshot): void {
    if (snap.kind !== 'core') throw new Error('ReplayCore.restore: not a core snapshot');
    const d = snap.data as unknown as { seed: number; state: ReplayCoreState };
    if (d.seed !== this.rng.seed) throw new Error(`ReplayCore.restore: snapshot seed ${d.seed} != core seed ${this.rng.seed}`);
    const st = d.state;
    this.state = {
      setupPending: st.setupPending,
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
  }

  // -------------------------------------------------------------------------
  // Extension points
  // -------------------------------------------------------------------------

  /**
   * B2 (movement) hook: the input for one alive, non-human pawn this tick. B1 holds
   * it still, looking where it already looks. Called in id order.
   */
  protected pawnInput(p: PawnObs, o: Observe): PawnInput {
    void o;
    return { id: p.id, forward: 0, side: 0, yaw: p.yaw, pitch: p.pitch, buttons: [] };
  }

  /**
   * B3 (scripted events) hook: append this tick's actions for scheduled entries
   * (`this.schedule.at(o.tick)`), after the setup actions. B1 adds none.
   */
  protected scheduledActions(o: Observe, actions: Action[]): void {
    void o;
    void actions;
  }
}

function initialState(): ReplayCoreState {
  return {
    setupPending: false,
    startTick: null,
    lastTick: null,
    paused: false,
    speed: 1,
    pawns: PLAYER_IDS.map((id) => ({ id, mode: 'REPLAY' as Mode, since: 0 })),
  };
}
