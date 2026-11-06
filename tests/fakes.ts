/**
 * Test doubles for the contracts: ScriptedHost (a trivial engine) and EchoCore
 * (a Core whose Act is a pure function of its Observe and a step counter).
 */
import {
  PLAYER_IDS,
  SessionLog,
  canonicalize,
  sortById,
  toJsonValue,
  type Act,
  type Action,
  type Control,
  type CoreSnapshot,
  type HostSnapshot,
  type ICore,
  type HostCapabilities,
  type IHost,
  type Observe,
  type ObsEvent,
  type PawnInput,
  type PawnStatus,
  type PlayerId,
  type RoundObs,
  type Team,
  type Vec3,
} from '../src/contracts/index';

const T_SIDE: readonly PlayerId[] = ['barely', 'snarlbot', 'cart', 'eradicate', 'donk'];

/**
 * A live round at `tick` (98.25 s on the clock at tick 0, score CT 11 – T 15) with the c4 carried by
 * `carrier` at `pos`, for fakes and fixtures that build an Observe by hand.
 */
export function liveRound(tick: number, carrier: PlayerId | null = null, pos: Vec3 | null = null): RoundObs {
  return {
    phase: 'live',
    score: { ct: 11, t: 15 },
    winner: null,
    reason: null,
    endTick: null,
    timeLeftSec: Math.max(0, 98.25 - tick / 64),
    bomb: { state: 'carried', carrier, pos, plantTick: null, defuser: null, defuseEndTick: null },
  };
}
const RUN_SPEED = 250;
const TICK_SEC = 1 / 64;

interface FakePawn {
  id: PlayerId;
  team: Team;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  hp: number;
  alive: boolean;
}

/** Ten pawns on a line; apply() moves them by their input; events are scripted per tick. */
export class ScriptedHost implements IHost {
  tick = 0;
  pawns: FakePawn[];
  readonly script: ReadonlyMap<number, readonly ObsEvent[]>;
  readonly controls: Control[] = [];

  constructor(script: ReadonlyMap<number, readonly ObsEvent[]> = new Map()) {
    this.script = script;
    this.pawns = PLAYER_IDS.map((id, i) => ({
      id,
      team: T_SIDE.includes(id) ? 'T' : 'CT',
      // Deliberately non-round numbers so canonicalization matters.
      pos: { x: -500 + i * 101.123456789, y: 300 - i * 37.7, z: -80.0000001 },
      vel: { x: 0, y: 0, z: 0 },
      yaw: i * 36,
      hp: 100,
      alive: true,
    }));
  }

  /** A test double that can snapshot (B5); the CS2 capabilities are tested through Session. */
  capabilities(): HostCapabilities {
    return { snapshot: true, seek: true, speed: true };
  }

  observe(): Observe {
    const events = this.script.get(this.tick) ?? [];
    for (const ev of events) {
      if (ev.type === 'death') {
        const p = this.pawns.find((q) => q.id === ev.victim);
        if (p !== undefined) {
          p.alive = false;
          p.hp = 0;
        }
      }
    }
    const alive = this.pawns.filter((p) => p.alive).map((p) => p.id);
    const barely = this.pawns.find((p) => p.id === 'barely');
    return {
      tick: this.tick,
      t: this.tick / 64,
      human: 'sp4rtan',
      events,
      round: liveRound(this.tick, barely?.alive === true ? 'barely' : null, barely?.alive === true ? barely.pos : null),
      pawns: sortById(
        this.pawns.map((p) => ({
          id: p.id,
          team: p.team,
          pos: p.pos,
          vel: p.vel,
          yaw: p.yaw,
          pitch: 0,
          hp: p.hp,
          armor: 100,
          alive: p.alive,
          weapon: p.team === 'T' ? 'ak47' : 'm4a4',
          ammo: { clip: 30, reserve: 90 },
          crouching: false,
          onGround: true,
          sees: alive.filter((id) => id !== p.id && p.alive),
        })),
      ),
    };
  }

  apply(act: Act): void {
    for (const input of act.inputs) {
      const p = this.pawns.find((q) => q.id === input.id);
      if (p === undefined || !p.alive) continue;
      const rad = (input.yaw * Math.PI) / 180;
      const speed = RUN_SPEED * input.forward;
      p.yaw = input.yaw;
      p.vel = { x: Math.cos(rad) * speed, y: Math.sin(rad) * speed, z: 0 };
      p.pos = { x: p.pos.x + p.vel.x * TICK_SEC, y: p.pos.y + p.vel.y * TICK_SEC, z: p.pos.z };
    }
    this.tick++;
  }

  control(c: Control): void {
    this.controls.push(c);
  }

  snapshot(): HostSnapshot {
    return { kind: 'host', data: toJsonValue({ tick: this.tick, pawns: this.pawns }) };
  }

  restore(s: HostSnapshot): void {
    const d = s.data as unknown as { tick: number; pawns: FakePawn[] };
    this.tick = d.tick;
    this.pawns = d.pawns.map((p) => ({ ...p }));
  }
}

/**
 * Inputs: every alive pawn runs forward with a yaw derived from tick and index;
 * WALK on odd ticks. Actions: one `log` per tick (plus one per death event).
 * Status: REPLAY for alive pawns, DEAD otherwise.
 */
export class EchoCore implements ICore {
  steps = 0;
  paused = false;

  step(o: Observe): Act {
    this.steps++;
    const inputs: PawnInput[] = [];
    const status: PawnStatus[] = [];
    o.pawns.forEach((p, i) => {
      if (p.alive) {
        inputs.push({
          id: p.id,
          forward: 1,
          side: 0,
          yaw: (o.tick * 3 + i * 36) % 360,
          pitch: 0,
          buttons: o.tick % 2 === 1 ? ['WALK'] : [],
        });
      }
      status.push({ id: p.id, mode: p.alive ? 'REPLAY' : 'DEAD', trigger: p.alive ? null : 'death', sinceTick: 0 });
    });
    const actions: Action[] = [
      { type: 'log', level: 'info', text: `tick ${o.tick} step ${this.steps} alive ${inputs.length}${this.paused ? ' paused' : ''}` },
    ];
    for (const ev of o.events) {
      if (ev.type === 'death') actions.push({ type: 'log', level: 'warn', text: `${ev.victim} died` });
    }
    return { inputs, actions, status };
  }

  control(c: Control): void {
    if (c.type === 'pause') this.paused = c.paused;
  }

  snapshot(): CoreSnapshot {
    return { kind: 'core', data: { steps: this.steps, paused: this.paused } };
  }

  restore(s: CoreSnapshot): void {
    const d = s.data as { steps: number; paused: boolean };
    this.steps = d.steps;
    this.paused = d.paused;
  }
}

/** EchoCore that changes its log text at one tick. */
export class MutatedCore extends EchoCore {
  readonly atTick: number;
  constructor(atTick: number) {
    super();
    this.atTick = atTick;
  }
  override step(o: Observe): Act {
    const act = super.step(o);
    if (o.tick !== this.atTick) return act;
    return { ...act, actions: [{ type: 'log', level: 'info', text: 'mutated' }] };
  }
}

/**
 * Drive host + core for `ticks` ticks and log each one. Observes are canonicalized
 * before step, as a real driver must, so the live run and its replay see the same input.
 */
export function runSession(
  ticks: number,
  host: IHost = new ScriptedHost(),
  core: ICore = new EchoCore(),
  controlsAt: ReadonlyMap<number, readonly Control[]> = new Map(),
): SessionLog {
  const log = new SessionLog();
  for (let i = 0; i < ticks; i++) {
    const o = canonicalize(host.observe());
    const controls = controlsAt.get(o.tick) ?? [];
    for (const c of controls) core.control(c);
    const a = core.step(o);
    log.append(o, a, controls);
    host.apply(a);
  }
  return log;
}
