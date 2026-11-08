/**
 * B3 scripted events against a stub host (no engine): the Act stream the Core sends. Button timing for
 * sprays, taps and bursts; the damage emission tick; drops at dead or LIVE pawns; the human's exclusion;
 * weapon changes; utility; plant and defuse windows and fallbacks; aim geometry. The real-engine checks
 * (kills, HP, shot ticks) are in tests/golden-round.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  PLAYER_IDS,
  SessionLog,
  canonicalize,
  sortById,
  toJsonValue,
  type Act,
  type Action,
  type Button,
  type Control,
  type HostSnapshot,
  type HostCapabilities,
  type IHost,
  type Observe,
  type ObsEvent,
  type PawnInput,
  type PlayerId,
  type Vec3,
  type WalkQuery,
  type WeaponId,
} from '../src/contracts/index';
import {
  EventSchedule,
  ReplayCore,
  RoundModel,
  ScriptPlan,
  aimPitchAt,
  aimSpotAt,
  bearing,
  cadenceOffsets,
  fitSpray,
  pitchTo,
  simulateHolds,
} from '../src/core/index';
import { aimPitch } from '../src/sim2d/hitscan';
import { liveRound } from './fakes';
import { loadRound, loadTuning } from './round-fixture';

const round = loadRound();
const tuning = loadTuning();
const model = new RoundModel(round);
const schedule = new EventSchedule(round);
const plan = new ScriptPlan(model, schedule, tuning);
const OPEN: WalkQuery = { isWalkableLine: () => true, pathLength: (a, b) => Math.hypot(b.x - a.x, b.y - a.y) };
const START = new Map<number, readonly Control[]>([[0, [{ type: 'start' }]]]);

// ---------------------------------------------------------------------------
// Stub host: pawns sit on their recorded positions; yaw / pitch follow the inputs; the weapon follows
// set_weapon; deaths and bomb events are scripted. No shots, no damage, no movement.
// ---------------------------------------------------------------------------

interface StubOptions {
  readonly human?: PlayerId | null;
  /** Pawn -> first observe tick at which it is dead. Default: the recorded death ticks. */
  readonly deaths?: ReadonlyMap<PlayerId, number>;
  /** Extra events by observe tick. */
  readonly events?: ReadonlyMap<number, readonly ObsEvent[]>;
  /** G6: every alive pawn sees every other alive one (default: `sees` is empty, nobody sees anyone). */
  readonly seeAll?: boolean;
}

interface StubPawn {
  id: PlayerId;
  yaw: number;
  pitch: number;
  weapon: WeaponId;
}

class StubHost implements IHost {
  tick = 0;
  capabilities(): HostCapabilities {
    return { snapshot: true, seek: true, speed: true };
  }
  readonly human: PlayerId | null;
  readonly deaths: ReadonlyMap<PlayerId, number>;
  readonly events: ReadonlyMap<number, readonly ObsEvent[]>;
  readonly seeAll: boolean;
  pawns: StubPawn[];

  constructor(opts: StubOptions = {}) {
    this.human = opts.human === undefined ? null : opts.human;
    const recorded = new Map<PlayerId, number>();
    for (const p of model.players) if (p.deathTick !== null) recorded.set(p.id, p.deathTick);
    this.deaths = opts.deaths ?? recorded;
    this.events = opts.events ?? new Map();
    this.seeAll = opts.seeAll === true;
    this.pawns = PLAYER_IDS.map((id) => {
      const kit = model.player(id).kit;
      return { id, yaw: 0, pitch: 0, weapon: kit.primary ?? kit.secondary ?? 'knife' };
    });
  }

  posOf(id: PlayerId, tick: number): Vec3 {
    return model.trackAtTick(id, tick)?.pos ?? model.player(id).startPos;
  }

  observe(): Observe {
    const t = this.tick;
    return {
      tick: t,
      t: t / 64,
      human: this.human,
      events: this.events.get(t) ?? [],
      round: liveRound(t, 'barely', model.player('barely').startPos),
      pawns: sortById(
        this.pawns.map((p) => {
          const dead = (this.deaths.get(p.id) ?? Infinity) <= t;
          return {
            id: p.id,
            team: model.player(p.id).team,
            pos: this.posOf(p.id, t),
            vel: { x: 0, y: 0, z: 0 },
            yaw: p.yaw,
            pitch: p.pitch,
            hp: dead ? 0 : 100,
            armor: 100,
            alive: !dead,
            weapon: p.weapon,
            ammo: { clip: 30, reserve: 90 },
            crouching: false,
            onGround: true,
            sees: this.seeAll && !dead ? PLAYER_IDS.filter((q) => q !== p.id && (this.deaths.get(q) ?? Infinity) > t) : [],
          };
        }),
      ),
    };
  }

  apply(act: Act): void {
    for (const a of act.actions) {
      const p = this.pawns.find((q) => 'id' in a && q.id === a.id);
      if (p === undefined) continue;
      if (a.type === 'set_weapon') p.weapon = a.weapon;
      if (a.type === 'teleport') p.yaw = a.yaw;
    }
    for (const i of act.inputs) {
      const p = this.pawns.find((q) => q.id === i.id);
      if (p === undefined) continue;
      p.yaw = i.yaw;
      p.pitch = i.pitch;
    }
    this.tick++;
  }

  control(): void {}

  snapshot(): HostSnapshot {
    return { kind: 'host', data: toJsonValue({ tick: this.tick, pawns: this.pawns }) };
  }

  restore(s: HostSnapshot): void {
    const d = s.data as unknown as { tick: number; pawns: StubPawn[] };
    this.tick = d.tick;
    this.pawns = d.pawns.map((p) => ({ ...p }));
  }
}

/** A Core whose test can make pawns LIVE at a tick (B4 will do this through triggers). */
class LiveCore extends ReplayCore {
  readonly live: ReadonlyMap<number, readonly PlayerId[]>;
  constructor(live: ReadonlyMap<number, readonly PlayerId[]>, walk: WalkQuery | null = null) {
    super(model, schedule, tuning, 3, walk);
    this.live = live;
  }
  protected override scheduledActions(o: Observe, actions: Action[]): void {
    for (const id of this.live.get(o.tick) ?? []) this.setPawnMode(id, 'LIVE', o.tick);
    super.scheduledActions(o, actions);
  }
}

function drive(host: StubHost, core: ReplayCore, ticks: number): SessionLog {
  const log = new SessionLog();
  for (let i = 0; i < ticks; i++) {
    const o = canonicalize(host.observe());
    const controls = START.get(o.tick) ?? [];
    for (const c of controls) core.control(c);
    const a = core.step(o);
    log.append(o, a, controls);
    host.apply(a);
  }
  return log;
}

function stubRun(ticks: number, opts: StubOptions = {}, core: ReplayCore = new ReplayCore(model, schedule, tuning, 3)): { log: SessionLog; core: ReplayCore } {
  return { log: drive(new StubHost(opts), core, ticks), core };
}

interface Span {
  from: number;
  to: number;
}

function spans(log: SessionLog, id: PlayerId, button: Button, from = 0, to = Infinity): Span[] {
  const out: Span[] = [];
  let open: number | null = null;
  for (let i = 0; i < log.length; i++) {
    const e = log.at(i);
    if (e === null || e.observe.tick < from || e.observe.tick > to) continue;
    const held = e.act.inputs.find((q) => q.id === id)?.buttons.includes(button) === true;
    const t = e.observe.tick;
    if (held && open === null) open = t;
    if (!held && open !== null) {
      out.push({ from: open, to: t - 1 });
      open = null;
    }
  }
  if (open !== null) out.push({ from: open, to: Math.min(to, log.length - 1) });
  return out;
}

function input(log: SessionLog, tick: number, id: PlayerId): PawnInput | undefined {
  return log.get(tick)?.act.inputs.find((q) => q.id === id);
}

function actionsAt(log: SessionLog, tick: number): readonly Action[] {
  return log.get(tick)?.act.actions ?? [];
}

function allActions(log: SessionLog): { tick: number; a: Action }[] {
  const out: { tick: number; a: Action }[] = [];
  for (let i = 0; i < log.length; i++) {
    const e = log.at(i);
    if (e !== null) for (const a of e.act.actions) out.push({ tick: e.observe.tick, a });
  }
  return out;
}

function logs(log: SessionLog): { tick: number; level: string; text: string }[] {
  return allActions(log).flatMap((x) => (x.a.type === 'log' ? [{ tick: x.tick, level: x.a.level, text: x.a.text }] : []));
}

// One golden-master run of the act stream (human null), shared by most tests; `seeing`: the same with everyone in sight.
const FULL = 4460;
const golden = stubRun(FULL);
/** Lokier's scout shot at eradicate (act tick of the ATTACK; the kill is observed on 816). */
const LOKIER_FIRES = 814;
const seeing = stubRun(FULL, { seeAll: true });

// ---------------------------------------------------------------------------

describe('fire cadence and spray fit', () => {
  it('a held AK fires at 0, 7, 13, 20, … (10 rounds a second); a held spray lands like the engine', () => {
    const ak = tuning.weapons['ak47'];
    if (ak === undefined) throw new Error('no ak47');
    const cycle = (64 * 60) / ak.rpm;
    expect(cadenceOffsets(11, cycle)).toEqual([0, 7, 13, 20, 26, 32, 39, 45, 52, 58, 64]);
    expect(simulateHolds([100], [5], cycle)).toEqual({ attack: [{ from: 100, to: 126 }], fires: [100, 107, 113, 120, 126] });
    // A second hold that starts late re-phases the cadence (fires on press, then one cycle after it).
    expect(simulateHolds([100, 128], [2, 2], cycle)?.fires).toEqual([100, 107, 128, 135]);
    expect(simulateHolds([100, 107], [2, 2], cycle)).toBeNull(); // no release tick between the holds
  });

  it('fits cart’s spray at Lokier one tick early, and splits the post-round spray that is faster than the AK', () => {
    const cycle = 6.4;
    const lokier = fitSpray([1185, 1191, 1197, 1203, 1210, 1216], cycle, 1);
    expect(lokier).toEqual({ attack: [{ from: 1183, to: 1215 }], shots: [1184, 1191, 1197, 1204, 1210, 1216], maxError: 1 });
    // 69.2 s and 69.267 s are 4 ticks apart (0.067 s; the AK needs 6.4): no single hold gets within a tick.
    const post = fitSpray([4395, 4401, 4407, 4414, 4420, 4429, 4433], cycle, 1);
    expect(post.attack).toHaveLength(2);
    expect(post.maxError).toBe(1);
  });
});

describe('firing (buttons)', () => {
  it('holds ATTACK through a spray and taps semi-automatic shots, one latency tick early', () => {
    const li = tuning.replay.inputLatencyTicks;
    expect(li).toBe(1);
    // cart's AK spray at Lokier: recorded 1185–1216, one hold.
    expect(spans(golden.log, 'cart', 'ATTACK', 1100, 1300)).toEqual([{ from: 1183, to: 1215 }]);
    // Lokier's SSG 08 (semi-automatic): pressed on the shot tick − latency, released the tick after.
    expect(spans(golden.log, 'lokier', 'ATTACK')).toEqual([
      { from: 815 - li, to: 815 - li },
      { from: 1184 - li, to: 1184 - li },
    ]);
    // sp4rtan's spray at donk (recorded 3194–3219), and his one-tap on barely (3763).
    expect(spans(golden.log, 'sp4rtan', 'ATTACK', 3100, 3800)).toEqual([
      { from: 3192, to: 3218 },
      { from: 3763 - li, to: 3763 - li },
    ]);
    // donk's AWP shot at 49.85 s.
    expect(spans(golden.log, 'donk', 'ATTACK', 3100, 3300)).toEqual([{ from: 3190 - li, to: 3190 - li }]);
  });

  it('every recorded exact-time shot is planned within a tick, sprays only for automatic guns', () => {
    for (const f of plan.fire) {
      if (f.kind === 'spray') expect(tuning.weapons[f.weapon]?.automatic, f.key).toBe(true);
      f.recordedTicks.forEach((r, k) => expect(Math.abs((f.shotTicks[k] as number) - r), `${f.key} shot ${k}`).toBeLessThanOrEqual(1));
    }
    const recorded = schedule.ofType('shot').length;
    expect(plan.fire.reduce((n, f) => n + f.recordedTicks.length, 0)).toBe(recorded);
  });

  it('fires one implied shot on the tick of each kill-feed-only kill', () => {
    const implied = plan.fire.filter((f) => f.kind === 'implied').map((f) => [f.shooter, f.target, f.weapon, f.shotTicks[0]]);
    expect(implied).toEqual([
      ['snarlbot', 'incredibad', 'ak47', 32],
      ['snarlbot', 'snakelore', 'ak47', 794],
      ['sp4rtan', 'snarlbot', 'deagle', 1142],
      ['sp4rtan', 'cart', 'ak47', 4442],
    ]);
    expect(spans(golden.log, 'snarlbot', 'ATTACK', 0, 100)).toEqual([{ from: 31, to: 31 }]);
  });

  it('spreads count-only bursts: a hold ending on the related kill, else even taps through the window', () => {
    // barely: 7 shots in 33.35–48.85 s including the 44.20 s kill on Zwomp -> one 7-shot hold whose last shot is the kill.
    const kill = 2829;
    const b1 = spans(golden.log, 'barely', 'ATTACK', 2134, 3126);
    expect(b1).toEqual([{ from: kill - 1 - 39, to: kill - 1 }]);
    const f1 = plan.fire.find((f) => f.kind === 'burst' && f.shooter === 'barely' && f.target === 'zwomp');
    expect(f1?.shotTicks).toHaveLength(7);
    expect(f1?.shotTicks.at(-1)).toBe(kill);
    // barely: 11 shots in 49.40–50.83 s, no kill -> 11 taps, evenly spaced, inside the window.
    const b2 = spans(golden.log, 'barely', 'ATTACK', 3150, 3300);
    expect(b2).toHaveLength(11);
    for (const s of b2) expect(s.to).toBe(s.from);
    expect((b2[0] as Span).from + 1).toBeGreaterThanOrEqual(3162);
    expect((b2[10] as Span).from + 1).toBeLessThanOrEqual(3253);
    for (let k = 1; k < 11; k++) expect((b2[k] as Span).from - (b2[k - 1] as Span).from).toBeGreaterThanOrEqual(8);
    // donk: 1 AWP shot in 37.25–49.40 s -> the middle of the window.
    expect(spans(golden.log, 'donk', 'ATTACK', 2384, 3162)).toEqual([{ from: (2384 + 3162) / 2 - 1, to: (2384 + 3162) / 2 - 1 }]);
  });
});

describe('scripted damage', () => {
  it('blocks every REPLAY enemy pair, and each puppet on itself, on the setup tick', () => {
    const blocks = actionsAt(golden.log, 0).filter((a) => a.type === 'block_damage');
    expect(blocks).toHaveLength(5 * 5 * 2 + 10);
    expect(blocks).toContainEqual({ type: 'block_damage', attacker: 'snarlbot', victim: 'incredibad' });
    expect(blocks).toContainEqual({ type: 'block_damage', attacker: 'donk', victim: 'donk' });
    expect(blocks).not.toContainEqual({ type: 'block_damage', attacker: 'cart', victim: 'barely' });
    expect(allActions(golden.log).filter((x) => x.a.type === 'block_damage' && x.tick !== 0)).toEqual([]);
  });

  it('sends each damage entry one action-latency tick before its recorded tick, as recorded', () => {
    const la = tuning.replay.actionLatencyTicks;
    const sent = allActions(golden.log).flatMap((x) => (x.a.type === 'damage' ? [{ tick: x.tick, ...x.a }] : []));
    expect(sent).toHaveLength(schedule.ofType('damage').length);
    expect(sent.map((d) => [d.tick + la, d.attacker, d.victim, d.lethal ? 'lethal' : d.amount])).toEqual([
      [32, 'snarlbot', 'incredibad', 'lethal'],
      [794, 'snarlbot', 'snakelore', 'lethal'],
      [816, 'lokier', 'eradicate', 'lethal'],
      [1142, 'sp4rtan', 'snarlbot', 'lethal'],
      [1184, 'lokier', 'cart', 73],
      [1203, 'cart', 'lokier', 'lethal'],
      [2829, 'barely', 'zwomp', 'lethal'],
      [3194, 'sp4rtan', 'donk', 27],
      [3200, 'sp4rtan', 'donk', 34],
      [3206, 'sp4rtan', 'donk', 26],
      [3222, 'sp4rtan', 'donk', 'lethal'],
      [3766, 'sp4rtan', 'barely', 'lethal'],
      [4442, 'sp4rtan', 'cart', 'lethal'],
    ]);
    expect(sent.find((d) => d.victim === 'cart' && !d.lethal)).toMatchObject({ amount: 73, armor: 7, hitgroup: 'chest', weapon: 'ssg08' });
    expect(sent.find((d) => d.victim === 'eradicate')).toMatchObject({ hitgroup: 'head', weapon: 'ssg08' });
    expect(sent.find((d) => d.victim === 'donk' && d.lethal)).toMatchObject({ amount: 13, armor: 0, hitgroup: 'chest' });
  });

  it('drops shots and damage at a dead target, and a dead shooter’s, logging each once', () => {
    // donk dies (in this stub) at 48 s, before sp4rtan's spray and his own AWP shot.
    const deaths = new Map<PlayerId, number>([...[...model.players].flatMap((p): [PlayerId, number][] => (p.deathTick === null || p.id === 'donk' ? [] : [[p.id, p.deathTick]]))]);
    deaths.set('donk', 3072);
    const { log } = stubRun(3300, { deaths });
    expect(spans(log, 'sp4rtan', 'ATTACK', 3100, 3300)).toEqual([]);
    expect(allActions(log).filter((x) => x.a.type === 'damage' && x.a.victim === 'donk')).toEqual([]);
    expect(allActions(log).filter((x) => x.a.type === 'set_weapon' && x.a.id === 'donk' && x.tick > 3072)).toEqual([]);
    const dropped = logs(log).filter((l) => l.text.startsWith('script: dropped'));
    expect(dropped.map((l) => [l.tick, l.text])).toEqual([
      [3189, 'script: dropped donk awp tap at sp4rtan (1 shot from tick 3189): donk is dead'],
      [3192, 'script: dropped sp4rtan ak47 spray at donk (5 shots from tick 3192): donk is dead'],
      [3193, 'script: dropped damage sp4rtan -> donk (27 hp at tick 3194): donk is dead'],
      [3199, 'script: dropped damage sp4rtan -> donk (34 hp at tick 3200): donk is dead'],
      [3205, 'script: dropped damage sp4rtan -> donk (26 hp at tick 3206): donk is dead'],
      [3221, 'script: dropped damage sp4rtan -> donk (lethal at tick 3222): donk is dead'],
    ]);
    // The spray at a target that dies mid-spray goes on: cart keeps firing at Lokier after the 18.8 s kill.
    expect(spans(golden.log, 'cart', 'ATTACK', 1100, 1300)).toEqual([{ from: 1183, to: 1215 }]);
    expect(logs(golden.log).filter((l) => l.text.startsWith('script: dropped'))).toEqual([]);
  });

  it('drops shots and damage involving a LIVE pawn (B4), and the LIVE pawn gets no input', () => {
    const core = new LiveCore(new Map([[3100, ['sp4rtan' as PlayerId]]]));
    const { log } = stubRun(3300, {}, core);
    expect(core.modeOf('sp4rtan')).toBe('LIVE');
    expect(log.get(3150)?.act.inputs.some((i) => i.id === 'sp4rtan')).toBe(false);
    expect(log.get(3150)?.act.status.find((s) => s.id === 'sp4rtan')).toMatchObject({ mode: 'LIVE', sinceTick: 3100 });
    const dropped = logs(log).filter((l) => l.text.startsWith('script: dropped'));
    expect(dropped.map((l) => l.text)).toEqual([
      'script: dropped donk awp tap at sp4rtan (1 shot from tick 3189): sp4rtan is LIVE',
      'script: dropped sp4rtan ak47 spray at donk (5 shots from tick 3192): sp4rtan is LIVE',
      'script: dropped damage sp4rtan -> donk (27 hp at tick 3194): sp4rtan is LIVE',
      'script: dropped damage sp4rtan -> donk (34 hp at tick 3200): sp4rtan is LIVE',
      'script: dropped damage sp4rtan -> donk (26 hp at tick 3206): sp4rtan is LIVE',
      'script: dropped damage sp4rtan -> donk (lethal at tick 3222): sp4rtan is LIVE',
    ]);
    // A dropped engagement doesn't aim either: donk keeps the yaw he had.
    expect(input(log, 3189, 'donk')?.yaw).toBe(input(log, 3150, 'donk')?.yaw);
  });
});

describe('the human', () => {
  const human = stubRun(FULL, { human: 'cart' });

  it('blocks no pair with the human, scripts no damage to or from it, and drives it in no way', () => {
    const blocks = actionsAt(human.log, 0).filter((a) => a.type === 'block_damage');
    expect(blocks).toHaveLength(4 * 5 * 2 + 9);
    for (const b of blocks) if (b.type === 'block_damage') expect([b.attacker, b.victim]).not.toContain('cart');
    const all = allActions(human.log);
    expect(all.filter((x) => x.a.type === 'damage' && (x.a.attacker === 'cart' || x.a.victim === 'cart'))).toEqual([]);
    expect(all.filter((x) => (x.a.type === 'set_weapon' || x.a.type === 'give') && x.a.id === 'cart' && x.tick > 0)).toEqual([]);
    for (let i = 1; i < human.log.length; i++) expect(human.log.at(i)?.act.inputs.some((q) => q.id === 'cart')).toBe(false);
    const skipped = logs(human.log).filter((l) => l.level === 'debug');
    expect(skipped.map((l) => l.text)).toEqual([
      'script: no scripted damage lokier -> cart (73 hp at tick 1184): cart is the human',
      'script: no scripted damage cart -> lokier (lethal at tick 1203): cart is the human',
      'script: no scripted damage sp4rtan -> cart (lethal at tick 4442): cart is the human',
    ]);
    // Without the human's kill, Lokier's scripted death doesn't happen; everything else is as in the golden master.
    const others = (log: SessionLog): Action[] => allActions(log).map((x) => x.a).filter((a) => a.type === 'damage' && a.attacker !== 'cart' && a.victim !== 'cart');
    expect(others(human.log)).toEqual(others(golden.log));
  });

  it('puppets still aim and shoot at the human (the engine decides those hits)', () => {
    expect(spans(human.log, 'sp4rtan', 'ATTACK', 4400, 4460)).toEqual([{ from: 4441, to: 4441 }]);
    // B4: Lokier's recorded 73 HP hit on cart is a scheduled encounter. The recorded shot and aim are replaced by a
    // time-shifted one that waits until Lokier sees cart at the window (src/core/divergence.ts); the stub's `sees` is
    // empty, so he never fires, but he holds the angle on the window spot (F1: from 1.5 s before the recorded sighting at
    // 17.45 s, tick 1021, instead of the recorded aim's start at 1161).
    expect(spans(human.log, 'lokier', 'ATTACK', 1100, 1300)).toEqual([]);
    const o = human.log.get(1183)?.observe;
    const lk = o?.pawns.find((p) => p.id === 'lokier');
    const ct = o?.pawns.find((p) => p.id === 'cart');
    if (lk === undefined || ct === undefined) throw new Error('missing pawns');
    // (F1: the hold is eased in, so it is within a degree rather than exactly on the spot.)
    expect(Math.abs((input(human.log, 1183, 'lokier')?.yaw ?? NaN) - bearing(lk.pos, ct.pos))).toBeLessThan(1);
    expect(Math.abs((input(human.log, 1150, 'lokier')?.yaw ?? NaN) - bearing(lk.pos, ct.pos))).toBeLessThan(1);
    expect(Math.abs((input(human.log, 1000, 'lokier')?.yaw ?? NaN) - bearing(lk.pos, ct.pos))).toBeGreaterThan(5);
  });
});

describe('aim', () => {
  // In sight (the stub's seeAll), the shooter tracks the target's body; out of sight (G6), the recorded spot.
  it('snarlbot faces incredibad before 0.50 s, at chest height', () => {
    const k = 31;
    const o = seeing.log.get(k)?.observe;
    const sn = o?.pawns.find((p) => p.id === 'snarlbot');
    const ib = o?.pawns.find((p) => p.id === 'incredibad');
    if (sn === undefined || ib === undefined) throw new Error('missing pawns');
    const i = input(seeing.log, k, 'snarlbot');
    expect(Math.abs((i?.yaw ?? NaN) - bearing(sn.pos, ib.pos))).toBeLessThan(0.01);
    expect(i?.pitch).toBe(aimPitchAt(sn.pos, false, ib.pos, false, 'chest', tuning.damage));
    // The aim starts preAimSec (22 ticks) before the shot press.
    const engagement = plan.engagements.find((e) => e.shooter === 'snarlbot' && e.target === 'incredibad');
    expect(engagement).toMatchObject({ fromTick: 31 - 22, toTick: 31, band: 'chest' });
  });

  it('aims at the head when the recorded kill is a headshot', () => {
    expect(plan.engagements.filter((e) => e.band === 'head').map((e) => [e.shooter, e.target])).toEqual([
      ['lokier', 'eradicate'],
      ['cart', 'lokier'],
      ['sp4rtan', 'barely'],
    ]);
    // F1: the view is exactly on the head on the ATTACK tick (the eased flick closes the last degree there).
    const k = LOKIER_FIRES;
    expect(spans(seeing.log, 'lokier', 'ATTACK', 800, 816)).toEqual([{ from: k, to: k }]);
    const o = seeing.log.get(k)?.observe;
    const lk = o?.pawns.find((p) => p.id === 'lokier');
    const er = o?.pawns.find((p) => p.id === 'eradicate');
    if (lk === undefined || er === undefined) throw new Error('missing pawns');
    expect(input(seeing.log, k, 'lokier')?.pitch).toBe(aimPitchAt(lk.pos, false, er.pos, false, 'head', tuning.damage));
  });

    it('G6: out of sight it holds the pre-aim on the recorded spot, and tracks the body only in sight', () => {
    const eng = plan.engagements.find((e) => e.shooter === 'lokier' && e.target === 'eradicate');
    if (eng === undefined) throw new Error('no engagement');
    const k = LOKIER_FIRES;
    const spot = aimSpotAt(eng, k);
    expect(spot).not.toBeNull();
    const o = golden.log.get(k)?.observe;
    const lk = o?.pawns.find((p) => p.id === 'lokier');
    const er = o?.pawns.find((p) => p.id === 'eradicate');
    if (lk === undefined || er === undefined || spot === null) throw new Error('missing pawns');
    // Nobody sees anyone (the stub's empty sees): Lokier looks at eradicate's recorded spot where the kill lands.
    expect(spot.tick >= k && spot.tick <= eng.toTick).toBe(true);
    // (eradicate's track ends just before the kill: the spot is its last sample)
    const last = model.track('eradicate').at(-1);
    expect(spot.pos).toEqual(model.trackAtTick('eradicate', spot.tick + tuning.replay.inputLatencyTicks)?.pos ?? { x: last?.x, y: last?.y, z: last?.z });
    expect(input(golden.log, k, 'lokier')?.pitch).toBe(aimPitchAt(lk.pos, false, spot.pos, false, 'head', tuning.damage));
    expect(Math.abs((input(golden.log, k, 'lokier')?.yaw ?? NaN) - bearing(lk.pos, spot.pos))).toBeLessThan(0.01);
    // In sight: the body, wherever it is (the two differ while eradicate moves).
    expect(input(seeing.log, k, 'lokier')?.pitch).toBe(aimPitchAt(lk.pos, false, er.pos, false, 'head', tuning.damage));
    // Every engagement has its spots, one per merged window end, in tick order, inside the engagement.
    for (const e of plan.engagements) {
      const ticks = (e.spots ?? []).map((x) => x.tick);
      expect(ticks.length).toBeGreaterThan(0);
      expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
      for (const t of ticks) expect(t >= e.fromTick && t <= e.toTick).toBe(true);
    }
  });

it('agrees with the 2D hitscan on band pitches (shared tuning.damage)', () => {
    const cases: [Vec3, boolean, Vec3, boolean][] = [
      [{ x: 0, y: 0, z: 0 }, false, { x: 500, y: 30, z: 0 }, false],
      [{ x: -1764, y: 794, z: -48 }, true, { x: -2139, y: 439, z: -161 }, false],
      [{ x: 785, y: -1144, z: -264 }, false, { x: 905, y: -1290, z: -109 }, true],
    ];
    for (const [a, ac, b, bc] of cases) {
      for (const band of ['head', 'chest', 'stomach', 'leg'] as const) {
        expect(Math.abs(aimPitchAt(a, ac, b, bc, band, tuning.damage) - aimPitch({ pos: a, crouching: ac }, { pos: b, crouching: bc }, band, tuning.damage))).toBeLessThan(0.001);
      }
    }
  });

  it('F1: eases the view (no snaps), stays on the target after the shot, writes the yaw back and hands back to the movement yaw', () => {
    const core = new ReplayCore(model, schedule, tuning, 3, OPEN);
    const { log } = stubRun(160, {}, core);
    const yaws = Array.from({ length: 150 }, (_, k) => input(log, k + 1, 'snarlbot')?.yaw ?? NaN);
    const steps = yaws.slice(1).map((y, k) => Math.abs(((((y - (yaws[k] as number)) % 360) + 540) % 360) - 180));
    // Never more than the flick's peak; B2's own limit (12°/tick) once the fight aim has let go.
    for (const [k, d] of steps.entries()) expect(d, `tick ${k + 2}`).toBeLessThanOrEqual(tuning.replay.aimTurnRateDegPerTick);
    // After the kill (act tick 31) it stays on incredibad for aimAfterSec, then eases back and lets go.
    const after = Math.round(tuning.replay.aimAfterSec * 64);
    for (let k = 32; k <= 31 + after; k++) expect(steps[k - 2] as number, `tick ${k}`).toBeLessThan(2);
    expect(core.script.state.aim.some((m) => m.id === 'snarlbot')).toBe(false);
    for (let k = 31 + after + 40; k < 150; k++) expect(steps[k - 2] as number, `tick ${k}`).toBeLessThanOrEqual(tuning.replay.maxTurnRateDegPerTick);
    expect(core.puppet('snarlbot')?.state.yaw).toBe(input(log, 159, 'snarlbot')?.yaw);
  });
});

describe('weapons and utility', () => {
  it('switch, pickup (give + one set_weapon) and donk’s Glock -> AWP quick-switch, one action-latency tick early', () => {
    const inv = allActions(golden.log).filter((x) => x.tick > 0 && (x.a.type === 'give' || (x.a.type === 'set_weapon' && x.a.weapon !== 'c4' && !['smoke', 'flash', 'he', 'molotov'].includes(x.a.weapon))));
    const rows = inv.map((x) => (x.a.type === 'give' ? [x.tick, 'give', x.a.id, x.a.item, x.a.clip, x.a.reserve] : x.a.type === 'set_weapon' ? [x.tick, 'set_weapon', x.a.id, x.a.weapon] : []));
    expect(rows).toEqual(
      expect.arrayContaining([
        [1253, 'give', 'sp4rtan', 'ak47', 30, 90],
        [1253, 'set_weapon', 'sp4rtan', 'ak47'],
        [3195, 'set_weapon', 'donk', 'glock'],
        [3204, 'set_weapon', 'donk', 'awp'],
        [3685, 'set_weapon', 'barely', 'knife'],
        [3813, 'set_weapon', 'cart', 'knife'],
        // V4: the video's HUD has cart's AK out at 61.40 s (tick 3930; the page said 63.5 s).
        [3929, 'set_weapon', 'cart', 'ak47'],
      ]),
    );
    expect(rows.filter((r) => r[0] === 1253 && r[1] === 'set_weapon')).toHaveLength(1);
  });

  it('throws a grenade: select it, hold ATTACK (pin) at pitch −10, release on the throw tick, then back to the gun', () => {
    const u = plan.utility[0];
    expect(u).toMatchObject({ id: 'cart', kind: 'smoke', tick: 307 });
    if (u === undefined) throw new Error('no utility');
    const deploy = Math.ceil(tuning.grenades.deploySec * 64);
    const hold = Math.round(tuning.replay.throwHoldSec * 64);
    expect(u).toMatchObject({ releaseTick: 306, attackTo: 305, attackFrom: 306 - hold, selectTick: 306 - hold - deploy, restoreTick: 307, previous: 'ak47' });
    expect(actionsAt(golden.log, u.selectTick)).toContainEqual({ type: 'set_weapon', id: 'cart', weapon: 'smoke' });
    expect(spans(golden.log, 'cart', 'ATTACK', 200, 400)).toEqual([{ from: u.attackFrom, to: u.attackTo }]);
    for (let k = u.attackFrom; k <= u.releaseTick; k++) expect(input(golden.log, k, 'cart')?.pitch).toBe(tuning.replay.throwPitchDeg);
    expect(input(golden.log, u.releaseTick, 'cart')?.buttons).not.toContain('ATTACK');
    // The stub still shows the smoke, so the Core switches back.
    expect(actionsAt(golden.log, u.restoreTick)).toContainEqual({ type: 'set_weapon', id: 'cart', weapon: 'ak47' });
    expect(plan.utility.map((x) => [x.id, x.kind, x.tick])).toEqual(round.utility.map((x) => [x.thrower, x.kind, x.tick]));
  });
});

describe('plant and defuse', () => {
  const pl = plan.plant;
  const df = plan.defuse;
  if (pl === null || df === null) throw new Error('no plant / defuse in the plan');
  const plantTicks = Math.round(tuning.bomb.plantSec * 64);

  it('barely: c4 out, then USE and no stick from plantTick − plantSec (− latency) to plantTick', () => {
    expect(pl).toMatchObject({ id: 'barely', tick: 1761, useFrom: 1761 - plantTicks - 1, useTo: 1761, fallbackTick: 1764, previous: 'ak47' });
    expect(actionsAt(golden.log, pl.selectTick)).toContainEqual({ type: 'set_weapon', id: 'barely', weapon: 'c4' });
    expect(pl.useFrom - pl.selectTick).toBe(Math.ceil(tuning.damage.defaultDeploySec * 64));
    expect(spans(golden.log, 'barely', 'USE')).toEqual([{ from: pl.useFrom, to: pl.useTo }]);
    for (let k = pl.useFrom; k <= pl.useTo; k++) expect(input(golden.log, k, 'barely')).toMatchObject({ forward: 0, side: 0, buttons: ['USE'] });
    expect(spans(golden.log, 'barely', 'ATTACK', pl.selectTick, pl.useTo)).toEqual([]);
  });

  it('falls back to a plant action (logged) when no planted event arrives by plantTick + 3, then draws the gun', () => {
    expect(actionsAt(golden.log, 1764)).toEqual([
      { type: 'plant', id: 'barely', pos: { x: -1982, y: 311, z: -160 } },
      { type: 'log', level: 'info', text: 'script: no planted event by tick 1764, sending plant for barely at (-1982, 311, -160)' },
      { type: 'set_weapon', id: 'barely', weapon: 'ak47' },
    ]);
    expect(allActions(golden.log).filter((x) => x.a.type === 'plant')).toHaveLength(1);
  });

  it('releases USE when the engine reports the plant, and sends no fallback', () => {
    const planted: ObsEvent = { type: 'bomb', phase: 'planted', id: 'barely', pos: { x: -1982, y: 311, z: -160 } };
    const { log } = stubRun(1800, { events: new Map([[1758, [planted]]]) });
    expect(spans(log, 'barely', 'USE')).toEqual([{ from: pl.useFrom, to: 1757 }]);
    expect(allActions(log).filter((x) => x.a.type === 'plant')).toEqual([]);
    expect(actionsAt(log, 1758)).toContainEqual({ type: 'set_weapon', id: 'barely', weapon: 'ak47' });
  });

  it('sp4rtan: faces the bomb, stands still and holds USE from the defuse start (− latency) to the defuse end', () => {
    expect(df).toMatchObject({ id: 'sp4rtan', startTick: 3955, endTick: 4275, useFrom: 3954, useTo: 4275, fallbackTick: 3957 });
    expect(spans(golden.log, 'sp4rtan', 'USE')).toEqual([{ from: 3954, to: 4275 }]);
    for (let k = df.useFrom; k <= df.useTo; k++) expect(input(golden.log, k, 'sp4rtan')).toMatchObject({ forward: 0, side: 0, buttons: ['USE'] });
    const o = golden.log.get(df.useFrom)?.observe;
    const sp = o?.pawns.find((p) => p.id === 'sp4rtan');
    if (sp === undefined) throw new Error('no sp4rtan');
    const i = input(golden.log, df.useFrom, 'sp4rtan');
    expect(i?.yaw).toBe(bearing(sp.pos, df.bombPos));
    expect(i?.pitch).toBe(pitchTo(sp.pos, false, df.bombPos, tuning.damage));
    expect(i?.pitch).toBeGreaterThan(45); // looking down at the c4, 41 units away
  });

  it('falls back to defuse_start (logged) if the engine hasn’t reported one within 2 ticks', () => {
    expect(actionsAt(golden.log, 3957)).toEqual([
      { type: 'defuse_start', id: 'sp4rtan' },
      { type: 'log', level: 'info', text: 'script: no defuse_start event by tick 3957, sending defuse_start for sp4rtan' },
    ]);
  });

  it('with engine bomb events: no fallback, and USE ends at defused', () => {
    const pos = { x: -1982, y: 311, z: -160 };
    const events = new Map<number, readonly ObsEvent[]>([
      [1761, [{ type: 'bomb', phase: 'planted', id: 'barely', pos }]],
      [3955, [{ type: 'bomb', phase: 'defuse_start', id: 'sp4rtan', pos }]],
      [4200, [{ type: 'bomb', phase: 'defused', id: 'sp4rtan', pos }]],
    ]);
    const { log } = stubRun(4300, { events });
    expect(allActions(log).filter((x) => x.a.type === 'plant' || x.a.type === 'defuse_start')).toEqual([]);
    expect(spans(log, 'sp4rtan', 'USE')).toEqual([{ from: 3954, to: 4199 }]);
    expect(spans(log, 'barely', 'USE')).toEqual([{ from: pl.useFrom, to: 1760 }]);
  });
});

describe('determinism and snapshots', () => {
  it('two runs give the same log; a snapshot taken mid-spray continues exactly', () => {
    expect(stubRun(1300).log.digest()).toBe(stubRun(1300).log.digest());
    const host = new StubHost();
    const core = new ReplayCore(model, schedule, tuning, 3, OPEN);
    const steps = (h: StubHost, c: ReplayCore, n: number): string[] => {
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        const o = canonicalize(h.observe());
        if (o.tick === 0) c.control({ type: 'start' });
        const a = c.step(o);
        out.push(JSON.stringify(a));
        h.apply(a);
      }
      return out;
    };
    steps(host, core, 1200); // cart's spray at Lokier runs 1183–1215
    const snap = core.snapshot();
    const hostSnap = host.snapshot();
    const expected = steps(host, core, 40);
    const core2 = new ReplayCore(model, schedule, tuning, 3, OPEN);
    core2.restore(JSON.parse(JSON.stringify(snap)) as typeof snap);
    host.restore(hostSnap);
    expect(steps(host, core2, 40)).toEqual(expected);
    expect(core2.script.state).toEqual(core.script.state);
  });
});
