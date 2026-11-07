/**
 * ReplayCore: the ICore that replays the recording. It sets the round up, drives
 * every REPLAY pawn along its recorded track (B2 puppets, src/core/puppet.ts), makes
 * the puppets act the recording (B3 scripted events, src/core/scripted.ts: aim, fire,
 * damage, weapons, utility, plant, defuse), switches puppets to LIVE when something
 * off-script reaches them (B4 divergence, src/core/divergence.ts), brings LIVE pawns back
 * to their recording once that is over (G1 rejoin, src/core/rejoin.ts) and reports status.
 * See docs/core.md "ReplayCore", "Puppets", "Scripted events" and "Divergence".
 */
import {
  PLAYER_IDS,
  Rng,
  isPlayerId,
  toJsonValue,
  type Act,
  type Action,
  type Control,
  type CoreSnapshot,
  type Goal,
  type ICore,
  type Mode,
  type Observe,
  type PawnInput,
  type PawnObs,
  type PawnStatus,
  type PlayerId,
  type SettableMode,
  type Tuning,
  type Vec3,
  type WalkQuery,
} from '../contracts/index';
import { RoundClock, TICK_RATE } from './clock';
import { Divergence, liveGoal, type DivergenceState } from './divergence';
import { REJOIN_TRIGGER, Rejoin, type RejoinState } from './rejoin';
import { copyLoadouts, initialLoadouts, noteActions, noteObserve, releaseWindowTicks, type LoadoutState } from './loadout';
import { PuppetController, PuppetTrack, roundYaw, type PuppetState } from './puppet';
import { resyncActions, resyncHazards, type StandingBlock } from './resync';
import type { RoundModel } from './round-model';
import type { EventSchedule } from './schedule';
import { ScriptedEvents, type ScriptState } from './scripted';
import { startActions, startYaw } from './start-state';

/**
 * G4: the status trigger of a pawn the human let go of mid-round (it goes LIVE; docs/core.md "Takeover"). One of
 * `TRIGGER_KINDS`.
 */
export const RELEASED_TRIGGER = 'released';

/** Per-pawn status bookkeeping. */
interface PawnState {
  id: PlayerId;
  mode: Mode;
  /** Tick the current mode began. */
  since: number;
  /** B4: the trigger that made the pawn LIVE (`TriggerKind`), else null. */
  trigger: string | null;
  /** B5: went LIVE this run, also once DEAD. */
  everLive: boolean;
  /**
   * G1: its B3 damage blocks are lifted: it went LIVE and hasn't rejoined since (also once DEAD). A resync rewind
   * sets the blocks from this.
   */
  blocksLifted: boolean;
}

/** ReplayCore options (tools and tests). */
export interface ReplayCoreOptions {
  /**
   * B4 divergence (triggers, scheduled encounters). On by default; off gives the B2/B3 puppets alone (a shadow Core
   * that decides a scripted human's input as if he were a puppet, tools/human-bot.ts).
   */
  readonly divergence: boolean;
  /** G1 rejoin (LIVE → REPLAY). On by default (absent = on); needs divergence and a WalkQuery. */
  readonly rejoin?: boolean;
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
  /**
   * B5: set by `rewind {id}` (the driver restored this Core's checkpoint snapshot, but the engine has no snapshot):
   * the next step resyncs the engine to its observe first (`resyncActions`). The checkpoint id, else null.
   */
  resync: string | null;
  /**
   * G4: `observe.human` as of the last step (null before the first). A later step whose observe names another human is
   * a takeover (or a release): `humanChanged`.
   */
  human: PlayerId | null;
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
  /** B4: the triggers, the expected-encounter index and the scheduled encounters, with their state. */
  readonly divergence: Divergence;
  /** False when built with `{divergence: false}`: no trigger is evaluated, no pawn goes LIVE by itself. */
  readonly divergenceOn: boolean;
  /** G1: LIVE → REPLAY (null without a WalkQuery, without divergence or with `{rejoin: false}`). */
  readonly rejoin: Rejoin | null;
  private state: ReplayCoreState;
  /** B5: the loadout ledger (src/core/loadout.ts), for resync rewinds. In the snapshot. */
  private loadout: LoadoutState;

  /**
   * @param walk the engine's walkable-line query (2D sim: `NavWalkQuery`); null = no puppet movement.
   * @param options null = the defaults (divergence on).
   */
  constructor(model: RoundModel, schedule: EventSchedule, tuning: Tuning, seed: number, walk: WalkQuery | null = null, options: ReplayCoreOptions | null = null) {
    this.model = model;
    this.schedule = schedule;
    this.tuning = tuning;
    this.clock = new RoundClock(model.meta.clock0, model.meta.bombTimerSec);
    this.rng = new Rng(seed);
    this.puppets = walk === null ? null : PLAYER_IDS.map((id) => new PuppetController(PuppetTrack.fromModel(model, schedule, tuning, id), tuning, walk));
    this.script = new ScriptedEvents(model, schedule, tuning);
    this.divergence = new Divergence(model, schedule, this.script.plan, tuning);
    this.divergenceOn = options === null || options.divergence;
    this.rejoin = walk === null || !this.divergenceOn || options?.rejoin === false ? null : new Rejoin(model, schedule, tuning, this.divergence, this.script, walk);
    this.state = initialState();
    this.loadout = initialLoadouts(model);
  }

  step(o: Observe): Act {
    const s = this.state;
    const actions: Action[] = [];
    s.setupThisStep = false;
    // B5: the ledger notes what this observe shows (held ammo, pops, the c4); the setup's observe predates the setup.
    if (!s.setupPending) noteObserve(this.loadout, o, releaseWindowTicks(this.tuning.grenades));
    if (s.setupPending) {
      for (const a of startActions(this.model, this.tuning)) actions.push(a);
      s.setupPending = false;
      s.setupThisStep = true;
      s.startTick = o.tick;
      for (const p of s.pawns) {
        p.mode = 'REPLAY';
        p.since = o.tick;
        p.trigger = null;
        p.everLive = false;
        p.blocksLifted = false;
      }
      this.loadout = initialLoadouts(this.model);
      if (this.puppets !== null) for (const c of this.puppets) c.reset(startYaw(this.model, c.id).yaw);
      this.script.reset();
      this.divergence.reset();
      this.rejoin?.reset();
      if (this.divergenceOn) this.divergence.setup(o, this.script);
      for (const a of this.script.blockActions(o, s.pawns)) actions.push(a);
    }

    const byId = new Map<PlayerId, PawnObs>();
    for (const p of o.pawns) byId.set(p.id, p);

    // Status: DEAD once the engine reports the pawn dead; HUMAN for the human's living pawn (B4);
    // otherwise LIVE stays LIVE (set by the B4 triggers through setPawnMode) and anything else is REPLAY.
    for (const p of s.pawns) {
      const obs = byId.get(p.id);
      if (obs === undefined) continue;
      const mode: Mode = !obs.alive ? 'DEAD' : p.id === o.human ? 'HUMAN' : p.mode === 'LIVE' ? 'LIVE' : 'REPLAY';
      if (mode !== p.mode) {
        p.mode = mode;
        p.since = o.tick;
        if (mode !== 'LIVE') p.trigger = null;
      }
    }

    // B5: a resync rewind puts the engine back to this observe before anything else in the Act.
    let prefix: Action[] = [];
    if (s.resync !== null) {
      prefix = resyncActions(this.model, this.tuning, o, s.pawns, this.loadout, this.standingBlocks(), s.resync, this.rejoinGoals());
      s.resync = null;
    }

    // G4: the player took control of a pawn (or let go of one) since the last step. Only after a setup, and not on the
    // setup step: its blocks and encounters already follow the human its observe names (a takeover at tick 0 is a
    // human from the start). Before any start the Core sends nothing.
    if (!s.setupThisStep && s.startTick !== null && o.human !== s.human) this.humanChanged(o, s.human, actions);
    s.human = o.human;

    // B4: the triggers and the scheduled encounters (not on the setup step: that observe predates the setup).
    if (this.divergenceOn && !s.setupThisStep) {
      for (const h of this.divergence.step(o, s.pawns, this.references(o.tick), this.script, actions)) {
        this.setPawnMode(h.id, 'LIVE', o.tick, h.trigger);
        this.script.noteLive(h.id, o.tick);
        this.rejoin?.noteLive(h.id, o.tick, h.trigger);
      }
      // G1: LIVE pawns heading back to, or rejoining, their recording (after this tick's LIVE switches).
      if (this.rejoin !== null && this.puppets !== null) {
        const tracks = this.puppets.map((c) => c.track);
        for (const r of this.rejoin.step(o, s.pawns, tracks, this.loadout, actions)) {
          this.setPawnMode(r.id, 'REPLAY', o.tick, REJOIN_TRIGGER);
          this.script.noteRejoin(r.id, o.tick);
          // The puppet's turn limit continues from where the AI left the pawn looking.
          const c = this.puppet(r.id);
          const obs = byId.get(r.id);
          if (c !== null && obs !== undefined) c.state.yaw = roundYaw(obs.yaw);
        }
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

    const status: PawnStatus[] = s.pawns.map((p) => ({ id: p.id, mode: p.mode, trigger: p.trigger, sinceTick: p.since }));
    s.lastTick = o.tick;
    const all = prefix.length === 0 ? actions : [...prefix, ...actions];
    noteActions(this.loadout, all);
    return { inputs, actions: all, status };
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
      // B5. Checkpoints and seeking are the driver's work: a checkpoint is this Core's snapshot() (plus the engine's,
      // when it has one), a seek steps every tick as usual. The Core only checks them.
      case 'checkpoint':
        checkId(c.type, c.id);
        return;
      case 'seek':
        if (!Number.isFinite(c.t) || c.t < 0) throw new RangeError(`seek: expected seconds >= 0, got ${c.t}`);
        return;
      // The driver has restored this Core to the checkpoint (restore()), and the engine could not be: the next step
      // resyncs it (resyncActions). With an engine snapshot the driver restores both and sends nothing.
      case 'rewind':
        checkId(c.type, c.id);
        this.state.resync = c.id;
        return;
      // G4: engine and driver work (the engine hands the pawn to the human); the Core learns of the takeover from
      // `observe.human` on the next step (humanChanged), the same way it would on a CS2 server, where nothing sends it.
      case 'take_control':
        if (!isPlayerId(c.id)) throw new Error(`take_control: expected a player id, got ${JSON.stringify(c.id)}`);
        return;
    }
  }

  /**
   * G4, docs/core.md "Takeover": `o.human` is not the last step's human (`prev`).
   * - Released: `prev` is alive and no longer the human (CS2: the player left and the bot plays on; the 2D app never
   *   does this, a rewind restores the Core instead): with divergence on it goes LIVE (trigger `released`, its blocks
   *   stay lifted) with its regular goal, and G1 brings it back to its tape once calm.
   * - Taken over: `o.human` was a puppet until now and is the human from this tick on (status HUMAN, no Core input,
   *   nothing scripted for it: B3 checks `observe.human` every tick). Its B3 damage blocks are lifted (`unblock_damage`
   *   for its self pair, then both directions with every enemy whose own blocks aren't lifted, dead ones included, as
   *   a LIVE switch does), so its fights are real; then a `log` line, and (divergence on) its scheduled encounters
   *   become active (`Divergence.takeover`). The pawn keeps what the engine has: position, velocity, view, weapon, HP.
   */
  private humanChanged(o: Observe, prev: PlayerId | null, actions: Action[]): void {
    const s = this.state;
    const tick = o.tick;
    if (prev !== null && this.divergenceOn) {
      const was = o.pawns.find((p) => p.id === prev);
      if (was !== undefined && was.alive) {
        this.setPawnMode(prev, 'LIVE', tick, RELEASED_TRIGGER);
        this.script.noteLive(prev, tick);
        this.rejoin?.noteLive(prev, tick, RELEASED_TRIGGER);
        const goal = liveGoal(this.model, prev, o, this.tuning);
        actions.push({ type: 'set_mode', id: prev, mode: 'LIVE', goal });
        actions.push({ type: 'log', level: 'info', text: `${prev} LIVE: released by the human at tick ${tick}; goal ${goal.role}, ${goal.route.length} waypoint${goal.route.length === 1 ? '' : 's'}` });
      }
    }
    const h = o.human;
    if (h === null) return;
    const me = s.pawns.find((p) => p.id === h);
    if (me === undefined) return;
    let lifted = 0;
    if (!me.blocksLifted) {
      const team = this.model.player(h).team;
      actions.push({ type: 'unblock_damage', attacker: h, victim: h });
      lifted++;
      for (const y of PLAYER_IDS) {
        if (y === h || this.model.player(y).team === team) continue;
        if (s.pawns.find((p) => p.id === y)?.blocksLifted === true) continue;
        actions.push({ type: 'unblock_damage', attacker: h, victim: y });
        actions.push({ type: 'unblock_damage', attacker: y, victim: h });
        lifted += 2;
      }
    }
    // A LIVE span it may have had ends here (nothing in its plan applies to the human anyway).
    this.script.noteRejoin(h, tick);
    const obs = o.pawns.find((p) => p.id === h);
    const what = obs === undefined ? 'not observed' : obs.alive ? `${obs.hp} hp, ${obs.weapon}` : 'dead';
    actions.push({ type: 'log', level: 'info', text: `takeover: ${h} is the human from tick ${tick} (${what}); ${lifted} damage block${lifted === 1 ? '' : 's'} lifted` });
    if (this.divergenceOn) this.divergence.takeover(o, s.pawns, this.script, actions);
  }

  /**
   * B5: why a resync rewind to a checkpoint taken at observe `o` (before its step) would not reproduce the round from
   * there; empty when it would. A driver without engine snapshots skips such checkpoints (resyncHazards).
   */
  checkpointHazards(o: Observe): string[] {
    const pl = this.script.plantItem();
    const planter = pl === null ? null : this.state.pawns.find((p) => p.id === pl.id);
    const onScript = planter !== undefined && planter !== null && planter.id !== o.human && planter.mode === 'REPLAY';
    return resyncHazards(o, pl, onScript);
  }

  /** B5: the loadout ledger (read only; tests and tools). */
  loadouts(): LoadoutState {
    return copyLoadouts(this.loadout);
  }

  /** G1: the rejoin goals in force (LIVE pawns heading back to their track), for a resync. */
  private rejoinGoals(): { id: PlayerId; goal: Goal }[] {
    const out: { id: PlayerId; goal: Goal }[] = [];
    if (this.rejoin === null) return out;
    for (const id of PLAYER_IDS) {
      const g = this.rejoin.goalOf(id);
      if (g !== null) out.push({ id, goal: g });
    }
    return out;
  }

  /** B4 encounter blocks in force (the scripted hit's block_damage shooter → human, not yet lifted). */
  private standingBlocks(): StandingBlock[] {
    const out: StandingBlock[] = [];
    const st = this.divergence.state.encounters;
    this.divergence.encounters.forEach((e, i) => {
      if (st[i]?.blocked === true) out.push({ attacker: e.shooter, victim: e.victim });
    });
    return out;
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

  /** A pawn's Core mode (REPLAY, LIVE, DEAD or HUMAN). */
  modeOf(id: PlayerId): Mode {
    const p = this.state.pawns.find((q) => q.id === id);
    if (p === undefined) throw new Error(`ReplayCore.modeOf: unknown pawn ${id}`);
    return p.mode;
  }

  /** The trigger that made a pawn LIVE (B4), or null. */
  triggerOf(id: PlayerId): string | null {
    const p = this.state.pawns.find((q) => q.id === id);
    if (p === undefined) throw new Error(`ReplayCore.triggerOf: unknown pawn ${id}`);
    return p.trigger;
  }

  /** Snaps since the last start / restart, all pawns. */
  get snapCount(): number {
    let n = 0;
    if (this.puppets !== null) for (const c of this.puppets) n += c.state.snaps;
    return n;
  }

  snapshot(): CoreSnapshot {
    const puppets: PuppetState[] = this.puppets === null ? [] : this.puppets.map((c) => c.state);
    return {
      kind: 'core',
      data: toJsonValue({ seed: this.rng.seed, state: this.state, puppets, script: this.script.state, divergence: this.divergence.state, loadout: this.loadout, rejoin: this.rejoin?.state ?? [] }),
    };
  }

  restore(snap: CoreSnapshot): void {
    if (snap.kind !== 'core') throw new Error('ReplayCore.restore: not a core snapshot');
    const d = snap.data as unknown as { seed: number; state: ReplayCoreState; puppets: PuppetState[]; script: ScriptState; divergence: DivergenceState; loadout?: LoadoutState; rejoin?: RejoinState[] };
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
        const everLive = p.everLive ?? p.mode === 'LIVE';
        return { id, mode: p.mode, since: p.since, trigger: p.trigger, everLive, blocksLifted: p.blocksLifted ?? everLive };
      }),
      resync: st.resync ?? null,
      // Snapshots from before G4 don't have it: the human is the pawn whose status is HUMAN (the human never changed then).
      human: st.human !== undefined ? st.human : (st.pawns.find((p) => p.mode === 'HUMAN')?.id ?? null),
    };
    // Snapshots from before B5 have no ledger: start it empty (a resync from one gives knives only).
    this.loadout = d.loadout === undefined ? initialLoadouts(this.model) : copyLoadouts(d.loadout);
    if (d.script === undefined || d.script === null) throw new Error('ReplayCore.restore: snapshot has no scripted-events state (made before B3)');
    this.script.restore(d.script);
    if (d.divergence === undefined || d.divergence === null) throw new Error('ReplayCore.restore: snapshot has no divergence state (made before B4)');
    this.divergence.restore(d.divergence);
    // Snapshots from before G1 have no rejoin state: LIVE pawns then start their calm clock afresh.
    this.rejoin?.restore(d.rejoin ?? []);
    if (this.rejoin !== null) {
      for (const p of this.state.pawns) if (p.mode === 'LIVE' && !this.rejoin.state.some((r) => r.id === p.id)) this.rejoin.noteLive(p.id, p.since, p.trigger ?? 'unknown');
    }
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
   * Change a pawn's Core mode from `tick` (B4 triggers: REPLAY → LIVE; G1 rejoin: LIVE → REPLAY with trigger
   * `rejoin`; `trigger` is what did it). Scripted shots and damage involving a LIVE pawn are dropped; a LIVE pawn gets
   * no input. The engine is told by the `set_mode` action the triggers and the rejoin emit, not by this.
   */
  protected setPawnMode(id: PlayerId, mode: SettableMode, tick: number, trigger: string | null = null): void {
    const p = this.state.pawns.find((q) => q.id === id);
    if (p === undefined) throw new Error(`ReplayCore.setPawnMode: unknown pawn ${id}`);
    if (p.mode === mode) return;
    p.mode = mode;
    p.since = tick;
    p.trigger = trigger;
    p.blocksLifted = mode === 'LIVE';
    if (mode === 'LIVE') p.everLive = true;
  }

  /**
   * Each puppet's reference position at `tick` (PLAYER_IDS order) for the body-block trigger: its
   * track's reference while the puppet follows it (B2: from the first sample to the last plus
   * `holdLastPositionSec`), else null; all null without puppets.
   */
  private references(tick: number): (Vec3 | null)[] {
    const hold = Math.round(this.tuning.replay.holdLastPositionSec * TICK_RATE);
    return PLAYER_IDS.map((id) => {
      const c = this.puppet(id);
      if (c === null || tick < c.track.startTick || tick > c.track.endTick + hold) return null;
      return c.track.targetAt(tick);
    });
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
    pawns: PLAYER_IDS.map((id) => ({ id, mode: 'REPLAY' as Mode, since: 0, trigger: null, everLive: false, blocksLifted: false })),
    resync: null,
    human: null,
  };
}

function checkId(type: string, id: string): void {
  if (typeof id !== 'string' || id === '') throw new Error(`${type}: expected a checkpoint id, got ${JSON.stringify(id)}`);
}
