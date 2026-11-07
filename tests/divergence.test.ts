/**
 * B4 divergence (src/core/divergence.ts): the five triggers as pure functions over synthetic Observes, the
 * expected-encounter index, the scheduled encounter built from the round, goal building, and the LIVE switch's
 * actions through ReplayCore. Scenario-level behaviour is in tests/scenarios.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, type ObsEvent, type Observe, type PawnObs, type PlayerId, type RoundObs, type Vec3 } from '../src/contracts/index';
import {
  Divergence,
  EventSchedule,
  ReplayCore,
  RoundModel,
  ScriptedEvents,
  blockedTrigger,
  blockingPawn,
  damageTrigger,
  dwellSpot,
  gunfireTrigger,
  humanOnCourse,
  intText,
  liveGoal,
  liveIntent,
  outlivedTrigger,
  sightingObservers,
  sightingTrigger,
  tenthsText,
  thinRoute,
  type ContactState,
  type EncounterState,
  type PawnMode,
} from '../src/core/index';
import { liveRound } from './fakes';
import { loadRound, loadTuning } from './round-fixture';

const round = loadRound();
const tuning = loadTuning();
const model = new RoundModel(round);
const schedule = new EventSchedule(round);
const script = new ScriptedEvents(model, schedule, tuning);
const div = new Divergence(model, schedule, script.plan, tuning);
const index = div.index;
const encs = div.encounters;
const waiting: EncounterState[] = encs.map((e) => ({ key: e.key, phase: 'waiting', seenTick: null, shotTick: null, blocked: false, puppetSightTick: null }));

function pawn(id: PlayerId, x: number, y: number, extra: Partial<PawnObs> = {}): PawnObs {
  return {
    id,
    team: model.player(id).team,
    pos: { x, y, z: -100 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 100,
    armor: 100,
    alive: true,
    weapon: 'ak47',
    ammo: { clip: 30, reserve: 90 },
    crouching: false,
    sees: [],
    ...extra,
  };
}

/** All ten pawns far apart (x = 10,000 × index), with the given ones replaced. */
function obs(tick: number, over: readonly PawnObs[], events: readonly ObsEvent[] = [], human: PlayerId | null = 'cart', round: RoundObs = liveRound(tick)): Observe {
  const pawns = PLAYER_IDS.map((id, i) => over.find((p) => p.id === id) ?? pawn(id, 10000 * (i + 1), 0));
  return { tick, t: tick / 64, pawns, events, human, round };
}

function modes(live: readonly PlayerId[] = [], human: PlayerId | null = 'cart'): PawnMode[] {
  return PLAYER_IDS.map((id) => ({ id, mode: id === human ? 'HUMAN' : live.includes(id) ? 'LIVE' : 'REPLAY' }));
}

describe('trigger 1: unscripted damage', () => {
  const hit = (attacker: PlayerId | null, scripted = false): ObsEvent => ({ type: 'damage', attacker, victim: 'zwomp', amount: 26.6, armor: 4, weapon: 'ak47', hitgroup: 'chest', scripted });
  it('a hit from the human or a LIVE pawn switches; from a puppet, the world or itself it does not', () => {
    expect(damageTrigger(obs(100, [], [hit('cart')]), modes(), 'zwomp')).toEqual({ id: 'zwomp', trigger: 'damage', reason: 'hit by cart (27 hp, ak47)' });
    expect(damageTrigger(obs(100, [], [hit('barely')]), modes(['barely']), 'zwomp')?.trigger).toBe('damage');
    expect(damageTrigger(obs(100, [], [hit('barely', true)]), modes(), 'zwomp')).toBeNull();
    expect(damageTrigger(obs(100, [], [hit(null)]), modes(), 'zwomp')).toBeNull();
    expect(damageTrigger(obs(100, [], [hit('zwomp')]), modes(), 'zwomp')).toBeNull();
    expect(damageTrigger(obs(100, [], [hit('cart')]), modes(), 'lokier')).toBeNull();
  });
});

describe('trigger 2: unscripted sighting', () => {
  const at = (id: PlayerId, tick: number): Vec3 => model.trackAtTick(id, tick)?.pos ?? model.player(id).startPos;
  it('an off-course human the recording has no duel with switches the puppet that sees him', () => {
    const o = obs(2000, [pawn('zwomp', 0, 0, { sees: ['cart'] }), pawn('cart', 300, 0)]);
    expect(humanOnCourse(model, o, tuning)).toBe(false);
    expect(sightingTrigger(o, modes(), 'zwomp', model, index, encs, waiting, tuning)).toEqual({ id: 'zwomp', trigger: 'sighting', reason: 'sees cart (the human), not in the recording' });
  });

  it('not when the human is on course (within offCourseUnits of his recorded track): that is the recording', () => {
    const p = at('cart', 700);
    const o = obs(700, [pawn('lokier', -2387, 815, { sees: ['cart'] }), pawn('cart', p.x + 40, p.y)]);
    expect(humanOnCourse(model, o, tuning)).toBe(true);
    expect(sightingTrigger(o, modes(), 'lokier', model, index, encs, waiting, tuning)).toBeNull();
  });

  it('a LIVE enemy switches, unless the recording has the pair engaging or sighted then (± expectedSightingWindowSec)', () => {
    const o = (tick: number): Observe => obs(tick, [pawn('donk', -1590, 790, { sees: ['sp4rtan', 'barely'] }), pawn('sp4rtan', -1068, 748)]);
    expect(sightingTrigger(o(2500), modes(['sp4rtan']), 'donk', model, index, encs, waiting, tuning)?.reason).toBe('sees sp4rtan (LIVE), not in the recording');
    // donk ↔ sp4rtan: recorded sighting 49.9–50.45 s and the spray 49.85–50.35 s; the window is 2 s.
    expect(sightingTrigger(o(3194), modes(['sp4rtan']), 'donk', model, index, encs, waiting, tuning)).toBeNull();
    expect(sightingTrigger(o(3229 + 128), modes(['sp4rtan']), 'donk', model, index, encs, waiting, tuning)).toBeNull();
    expect(sightingTrigger(o(3229 + 129), modes(['sp4rtan']), 'donk', model, index, encs, waiting, tuning)?.trigger).toBe('sighting');
    // A REPLAY enemy, a LIVE teammate: no.
    expect(sightingTrigger(o(2500), modes(), 'donk', model, index, encs, waiting, tuning)).toBeNull();
    expect(sightingTrigger(o(2500), modes(['barely']), 'donk', model, index, encs, waiting, tuning)).toBeNull();
  });

  it('a waiting encounter owns Lokier seeing cart at the recorded spot; elsewhere the normal rule applies', () => {
    const atSpot = obs(2000, [pawn('lokier', -2139, 439, { sees: ['cart'] }), pawn('cart', -1764 + 100, 800)]);
    expect(sightingTrigger(atSpot, modes(), 'lokier', model, index, encs, waiting, tuning)).toBeNull();
    const away = obs(2000, [pawn('lokier', -2139, 439, { sees: ['cart'] }), pawn('cart', -1764 + 300, 800)]);
    expect(sightingTrigger(away, modes(), 'lokier', model, index, encs, waiting, tuning)?.trigger).toBe('sighting');
    const seen: EncounterState[] = [{ key: 'enc:0', phase: 'seen', seenTick: 1990, shotTick: 2054, blocked: false, puppetSightTick: null }];
    expect(sightingTrigger(away, modes(), 'lokier', model, index, encs, seen, tuning)).toBeNull();
  });
});

describe('trigger 3: unscripted gunfire nearby', () => {
  const shot = (source: PlayerId, x: number): ObsEvent => ({ type: 'sound', source, pos: { x, y: 0, z: -100 }, kind: 'shot' });
  const me = pawn('zwomp', 0, 0);
  it('an enemy shot from the human or a LIVE pawn within hearingRangeUnits that is not recorded fire', () => {
    expect(gunfireTrigger(obs(2000, [me], [shot('cart', 1500)]), modes(), 'zwomp', model, index, encs, waiting, tuning)).toEqual({ id: 'zwomp', trigger: 'gunfire', reason: 'heard cart fire 1500 u away' });
    expect(gunfireTrigger(obs(2000, [me], [shot('cart', 1501)]), modes(), 'zwomp', model, index, encs, waiting, tuning)).toBeNull();
    expect(gunfireTrigger(obs(2000, [me], [shot('barely', 800)]), modes(), 'zwomp', model, index, encs, waiting, tuning)).toBeNull();
    expect(gunfireTrigger(obs(2000, [me], [shot('barely', 800)]), modes(['barely']), 'zwomp', model, index, encs, waiting, tuning)?.trigger).toBe('gunfire');
    expect(gunfireTrigger(obs(2000, [pawn('donk', 0, 0)], [shot('cart', 800)]), modes(), 'donk', model, index, encs, waiting, tuning)).toBeNull();
  });

  it('cart’s recorded fire (18.5–19.0 s, ± expectedGunfireWindowSec) is no divergence, and shifts with a started encounter', () => {
    expect(gunfireTrigger(obs(1190, [me], [shot('cart', 800)]), modes(), 'zwomp', model, index, encs, waiting, tuning)).toBeNull();
    expect(gunfireTrigger(obs(1216 + 128, [me], [shot('cart', 800)]), modes(), 'zwomp', model, index, encs, waiting, tuning)).toBeNull();
    expect(gunfireTrigger(obs(1216 + 129, [me], [shot('cart', 800)]), modes(), 'zwomp', model, index, encs, waiting, tuning)?.trigger).toBe('gunfire');
    // Seen 3 s late: cart's fire at Lokier is expected 3 s late too.
    const late: EncounterState[] = [{ key: 'enc:0', phase: 'fired', seenTick: 1117 + 192, shotTick: 1117 + 256, blocked: false, puppetSightTick: null }];
    expect(gunfireTrigger(obs(1216 + 192 + 64, [me], [shot('cart', 800)]), modes(), 'zwomp', model, index, encs, late, tuning)).toBeNull();
  });
});

describe('trigger 4: outlived its recording', () => {
  it('from outliveGraceSec after the recorded death', () => {
    const o = (tick: number): Observe => obs(tick, []);
    expect(outlivedTrigger(o(1203 + 191), model, 'lokier', tuning)).toBeNull();
    expect(outlivedTrigger(o(1203 + 192), model, 'lokier', tuning)).toEqual({ id: 'lokier', trigger: 'outlived', reason: 'outlived recording (+3.0 s)' });
    expect(outlivedTrigger(o(4000), model, 'sp4rtan', tuning)).toBeNull();
  });
});

describe('trigger 5: pushed off course while visible', () => {
  const ref: Vec3 = { x: 0, y: 200, z: -100 };
  const contact = (behind: number, stalledSince: number | null = null): ContactState => ({ id: 'sp4rtan', sinceTick: 90, behind, stalledSince });
  const scene = (seen: boolean, cartAt: [number, number], me: [number, number] = [0, 0], vel = 0): Observe =>
    obs(100, [pawn('sp4rtan', me[0], me[1], { vel: { x: vel, y: 0, z: 0 } }), pawn('cart', cartAt[0], cartAt[1], { sees: seen ? ['sp4rtan'] : [] })]);
  it('blockingPawn: a solid pawn in contact between the puppet and its reference', () => {
    expect(blockingPawn(scene(true, [0, 33]), 'sp4rtan', ref, tuning)).toBe('cart');
    expect(blockingPawn(scene(true, [0, 37]), 'sp4rtan', ref, tuning)).toBeNull();
    expect(blockingPawn(scene(true, [0, -33]), 'sp4rtan', ref, tuning)).toBeNull();
    expect(blockingPawn(obs(100, [pawn('barely', 0, 0), pawn('cart', 0, 33)]), 'barely', ref, tuning)).toBeNull(); // teammates pass through
  });

  it('pushed: the drift the contact added beyond offCourseUnits, seen by the human', () => {
    expect(blockedTrigger(scene(true, [0, 33]), 'sp4rtan', ref, contact(135), tuning)).toEqual({ id: 'sp4rtan', trigger: 'blocked', reason: 'blocked by cart, pushed 65 u off course, seen by cart' });
    expect(blockedTrigger(scene(true, [0, 33]), 'sp4rtan', ref, contact(136), tuning)).toBeNull();
    expect(blockedTrigger(scene(false, [0, 33]), 'sp4rtan', ref, contact(0), tuning)).toBeNull();
    expect(blockedTrigger(scene(true, [0, 33]), 'sp4rtan', ref, null, tuning)).toBeNull();
  });

  it('held: stalled in the contact for blockedSec while more than offCourseUnits off course', () => {
    const held = blockedTrigger(scene(true, [0, 33]), 'sp4rtan', ref, contact(190, 100 - 16), tuning);
    expect(held?.reason).toBe('blocked by cart, held 200 u off course, seen by cart');
    expect(blockedTrigger(scene(true, [0, 33]), 'sp4rtan', ref, contact(190, 100 - 15), tuning)).toBeNull();
    expect(blockedTrigger(scene(true, [0, 33]), 'sp4rtan', { x: 0, y: 60, z: -100 }, contact(0, 0), tuning)).toBeNull();
  });
});

describe('expected encounters and the scheduled encounter', () => {
  it('reads the round’s pairs: shots, hits, kills and sightings, symmetric', () => {
    expect(sightingObservers("eradicate's radar")).toEqual(['eradicate']);
    expect(sightingObservers('cart / barely')).toEqual(['barely', 'cart']);
    expect(index.saw('lokier', 'cart', 1117 - 128)).toBe(true);
    expect(index.saw('cart', 'lokier', 1117 - 129)).toBe(false);
    expect(index.saw('cart', 'lokier', 1216 + 128)).toBe(true);
    expect(index.saw('zwomp', 'barely', 2134)).toBe(true); // barely's count-only burst at zwomp, 33.35–48.85 s
    expect(index.saw('sp4rtan', 'cart', 3750)).toBe(true); // "cart / barely" see sp4rtan on B, 58.6 s
    expect(index.fired('cart', null, 1185, 0)).toBe(true);
    expect(index.fired('cart', 'lokier', 1500, 300)).toBe(true);
    expect(index.fired('cart', 'sp4rtan', 1500, 300)).toBe(false);
  });

  it('builds one encounter: Lokier’s 73 HP / 7 armor SSG 08 hit on cart, from the 17.45 s sighting, at the window', () => {
    expect(encs).toHaveLength(1);
    const e = encs[0];
    expect(e).toMatchObject({ key: 'enc:0', shooter: 'lokier', victim: 'cart', band: 'chest', weapon: 'ssg08', recordedSightTick: 1117, holdFromTick: 1161 });
    expect(e?.damage).toMatchObject({ tick: 1184, amount: 73, armor: 7, lethal: false });
    expect(e?.spot).toEqual(model.trackAtTick('cart', 1184)?.pos);
    expect(e?.fireKeys.map((k) => script.plan.fire.find((f) => f.key === k)?.shotTicks)).toEqual([[1184]]);
    expect(e?.aimKeys).toHaveLength(1);
  });
});

describe('goals', () => {
  it('thinRoute keeps corners and drops points on straight runs', () => {
    const v = (x: number, y: number): Vec3 => ({ x, y, z: 0 });
    expect(thinRoute([v(0, 0), v(50, 1), v(100, 0), v(100, 50), v(100, 100)], 10)).toEqual([v(0, 0), v(100, 0), v(100, 100)]);
    expect(thinRoute([v(0, 0), v(50, 20), v(100, 0)], 10)).toEqual([v(0, 0), v(50, 20), v(100, 0)]);
    expect(thinRoute([v(0, 0)], 10)).toEqual([v(0, 0)]);
  });

  it('dwellSpot finds the post-plant stays: barely on the Tunnel stairs, donk in the Apartments', () => {
    // barely: 37.4–44.6 s on the Tunnel / underpass stairs below Catwalk (from where he kills Zwomp at 44.2 s).
    const b = dwellSpot(model.track('barely'), 1761, tuning.replay.dwellUnits);
    expect(b).toEqual({ pos: { x: -818, y: 360, z: -345 }, tick: 2394 });
    // donk: 28.5–49.9 s in the Apartments over B ("scoped in Apartments watching east").
    const d = dwellSpot(model.track('donk'), 1761, tuning.replay.dwellUnits);
    expect(d).toEqual({ pos: { x: -1556, y: 781, z: -48 }, tick: 1824 });
  });

  it('roles by team, phase and the round’s roles', () => {
    const planted = (tick: number): RoundObs => ({ ...liveRound(tick), phase: 'planted', bomb: { ...liveRound(tick).bomb, state: 'planted', carrier: null, plantTick: 1760 } });
    const role = (id: PlayerId, r: RoundObs): string => liveIntent(model, id, obs(r.bomb.plantTick === null ? 1000 : 2000, [], [], 'cart', r), tuning).role;
    expect(role('barely', liveRound(1000, 'barely'))).toBe('plant');
    expect(role('donk', liveRound(1000, 'barely'))).toBe('take_site');
    expect(role('donk', planted(2000))).toBe('guard_bomb');
    expect(role('lokier', liveRound(1000))).toBe('hold');
    expect(role('incredibad', liveRound(10))).toBe('hold');
    expect(role('zwomp', liveRound(1000))).toBe('rotate');
    expect(role('sp4rtan', liveRound(1000))).toBe('retake');
    expect(role('sp4rtan', planted(2000))).toBe('defuse');
  });

  it('liveGoal: the remaining recorded track as a thinned route to the hold spot', () => {
    const o = obs(1300, [pawn('zwomp', -1180, -500)]);
    const g = liveGoal(model, 'zwomp', o, tuning);
    expect(g.role).toBe('rotate');
    expect(g.hold).toEqual((({ x, y, z }) => ({ x, y, z }))(model.track('zwomp').at(-1) as Vec3));
    expect(g.route.length).toBeGreaterThan(1);
    expect(g.route.length).toBeLessThan(15);
    // An outlived pawn has no recorded track left: straight to its hold spot.
    expect(liveGoal(model, 'lokier', obs(1395, [pawn('lokier', -2146, 432)]), tuning).route).toEqual([]);
  });
});

describe('the switch to LIVE', () => {
  it('unblocks every pair involving the pawn (its self pair and both directions with every non-human enemy), then set_mode and a log line', () => {
    const core = new ReplayCore(model, schedule, tuning, 1);
    core.control({ type: 'start' });
    const setup = core.step(obs(0, []));
    expect(setup.status.find((s) => s.id === 'cart')).toEqual({ id: 'cart', mode: 'HUMAN', trigger: null, sinceTick: 0 });
    // lokier is still alive 3 s after his recorded death (the others who died by then are dead).
    const dead = (['incredibad', 'snakelore', 'eradicate', 'snarlbot'] as const).map((id, i) => pawn(id, 50000 + 100 * i, 0, { alive: false, hp: 0 }));
    const act = core.step(obs(1395, [pawn('lokier', -2146, 432), ...dead]));
    const unblocks = act.actions.filter((a) => a.type === 'unblock_damage').map((a) => (a.type === 'unblock_damage' ? `${a.attacker}>${a.victim}` : ''));
    // Every pair the setup blocked (cart is the human: never blocked), dead enemies' included.
    expect(unblocks).toEqual(['lokier>barely', 'barely>lokier', 'lokier>donk', 'donk>lokier', 'lokier>eradicate', 'eradicate>lokier', 'lokier>lokier', 'lokier>snarlbot', 'snarlbot>lokier']);
    expect(act.actions.filter((a) => a.type === 'set_mode').map((a) => (a.type === 'set_mode' ? a.id : ''))).toEqual(['lokier']);
    const set = act.actions.find((a) => a.type === 'set_mode');
    expect(set).toMatchObject({ type: 'set_mode', id: 'lokier', mode: 'LIVE', goal: { role: 'hold', route: [] } });
    expect(act.actions.some((a) => a.type === 'log' && a.text === 'lokier LIVE: outlived recording (+3.0 s); goal hold, 0 waypoints')).toBe(true);
    expect(act.status.find((s) => s.id === 'lokier')).toEqual({ id: 'lokier', mode: 'LIVE', trigger: 'outlived', sinceTick: 1395 });
    expect(act.inputs.some((i) => i.id === 'lokier')).toBe(false);
    expect(core.triggerOf('lokier')).toBe('outlived');
  });

  it('the human never goes LIVE, and a Core built with {divergence: false} switches nobody', () => {
    const core = new ReplayCore(model, schedule, tuning, 1);
    core.control({ type: 'start' });
    core.step(obs(0, []));
    const act = core.step(obs(4442 + 192, []));
    expect(act.status.find((s) => s.id === 'cart')?.mode).toBe('HUMAN');
    const off = new ReplayCore(model, schedule, tuning, 1, null, { divergence: false });
    off.control({ type: 'start' });
    off.step(obs(0, []));
    expect(off.step(obs(1395, [pawn('lokier', -2146, 432)])).actions.some((a) => a.type === 'set_mode')).toBe(false);
  });

  it('formats integers and tenths with integer arithmetic only', () => {
    expect([intText(26.5), intText(-0.4), intText(1499.6)]).toEqual(['27', '0', '1500']);
    expect([tenthsText(192, true), tenthsText(-13, true), tenthsText(0, true), tenthsText(605, false)]).toEqual(['+3.0', '-0.2', '+0.0', '9.5']);
  });
});
