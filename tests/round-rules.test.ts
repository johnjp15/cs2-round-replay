/** C3: round rules in Sim2DHost (elimination, time-out, bomb ends, score, post-round play). */
import { describe, expect, it } from 'vitest';
import { toTick, type Action, type DamageAction, type Observe, type PlayerId, type Score } from '../src/contracts/index';
import { Session } from '../src/app/session';
import { aimPitch } from '../src/sim2d/hitscan';
import { Sim2DHost } from '../src/sim2d/host';
import { checkRoundEnd, freshRound, timeLeftSec } from '../src/sim2d/round';
import { CART_DEATH_TICK, DEFUSE_START_TICK, DEFUSE_TICK, PLANT_TICK, bombTicks, hold, nav, place, roundData, runTo, tuning } from './bomb-fixtures';
import { act, eventsOf, openNav, pawn, roster4, setupActions } from './combat-fixtures';

const SCORE: Score = { ct: 11, t: 15 };
const ORIGIN = { x: 0, y: 0, z: 0 };

/** barely, cart (T) and sp4rtan, zwomp (CT) on the open map, apart; round clock 98.25 s, score 11 – 15. */
function host4(roundTimeSec = 98.25): Sim2DHost {
  const host = new Sim2DHost(openNav, tuning, roster4, { score: SCORE, roundTimeSec });
  host.apply(
    act([
      ...place('barely', { x: -400, y: 0, z: 0 }),
      ...place('cart', { x: -400, y: 200, z: 0 }),
      ...place('sp4rtan', { x: 400, y: 0, z: 0 }),
      ...place('zwomp', { x: 400, y: 200, z: 0 }),
    ]),
  );
  return host;
}

function kill(victim: PlayerId): DamageAction {
  return { type: 'damage', attacker: null, victim, amount: 0, armor: 0, hitgroup: 'chest', weapon: null, lethal: true };
}

/** Apply `actions` at the host's next tick `tick` (runs up to it first). */
function at(host: Sim2DHost, tick: number, actions: Action[]): void {
  runTo(host, tick);
  host.apply(act(actions));
}

function roundEnds(obs: readonly Observe[]): [number, string, string][] {
  return obs.flatMap((o) => eventsOf(o, 'round_end').map((e): [number, string, string] => [o.tick - 1, e.winner, e.reason]));
}

describe('elimination', () => {
  it('all Ts dead before a plant: CT win by elimination, once; the score counts it once', () => {
    const host = host4();
    at(host, 5, [kill('barely')]);
    at(host, 10, [kill('cart')]);
    const obs = runTo(host, 200);
    expect(roundEnds(obs)).toEqual([[10, 'CT', 'elimination']]);
    expect(obs.at(-1)?.round).toMatchObject({ phase: 'over', winner: 'CT', reason: 'elimination', endTick: 10, score: { ct: 12, t: 15 } });
    expect(obs.at(-1)?.round.timeLeftSec).toBe(98.09375); // frozen at the end: 98.25 − 10 / 64
  });

  it('all CTs dead: T win by elimination (two deaths on one tick give one round_end)', () => {
    const host = host4();
    at(host, 7, [kill('sp4rtan'), kill('zwomp')]);
    const obs = runTo(host, 50);
    expect(roundEnds(obs)).toEqual([[7, 'T', 'elimination']]);
    expect(obs.at(-1)?.round.score).toEqual({ ct: 11, t: 16 });
  });

  it('all CTs dead after the plant: T win at once; the bomb still ticks, beeps and explodes, without a second round_end', () => {
    const host = host4();
    at(host, 5, [{ type: 'plant', id: 'barely', pos: ORIGIN }]);
    at(host, 20, [kill('sp4rtan'), kill('zwomp')]);
    const obs = runTo(host, 2600);
    expect(roundEnds(obs)).toEqual([[20, 'T', 'elimination']]);
    const after = obs.find((o) => o.tick === 100) as Observe;
    expect(after.round).toMatchObject({ phase: 'over', winner: 'T', bomb: { state: 'planted' } });
    expect(after.round.timeLeftSec).toBe((5 + 2560 - 100) / 64); // the bomb timer keeps counting
    expect(bombTicks(obs, 'exploded')).toEqual([5 + 2560]);
    expect(obs.at(-1)?.round).toMatchObject({ score: { ct: 11, t: 16 }, reason: 'elimination', timeLeftSec: 0, bomb: { state: 'exploded' } });
  });

  it('all Ts dead after the plant: the round goes on until the explosion (T win) or the defuse (CT win)', () => {
    const boom = host4();
    at(boom, 5, [{ type: 'plant', id: 'barely', pos: ORIGIN }]);
    at(boom, 20, [kill('barely'), kill('cart')]);
    let obs = runTo(boom, 2600);
    expect(obs.find((o) => o.tick === 100)?.round.phase).toBe('planted');
    expect(roundEnds(obs)).toEqual([[5 + 2560, 'T', 'bomb_exploded']]);

    const saved = host4();
    at(saved, 5, [{ type: 'plant', id: 'barely', pos: ORIGIN }]);
    at(saved, 20, [kill('barely'), kill('cart'), { type: 'defuse_start', id: 'zwomp' }]);
    obs = runTo(saved, 2600);
    expect(roundEnds(obs)).toEqual([[20 + 640, 'CT', 'bomb_defused']]);
    expect(bombTicks(obs, 'exploded')).toEqual([]);
  });

  it('the last T and the last CT dying on the same tick: T win (CTs are checked first, as in CS)', () => {
    const host = host4();
    at(host, 3, [kill('barely'), kill('cart'), kill('sp4rtan'), kill('zwomp')]);
    expect(roundEnds(runTo(host, 10))).toEqual([[3, 'T', 'elimination']]);
  });

  it('a side missing from the roster is never "eliminated"', () => {
    const host = new Sim2DHost(openNav, tuning, [{ id: 'cart', team: 'T' }]);
    expect(roundEnds(runTo(host, 100))).toEqual([]);
  });
});

describe('time', () => {
  it('the round clock runs out at t = 98.25 s: CT win by time', () => {
    const host = host4();
    expect(host.observe().round).toMatchObject({ phase: 'live', timeLeftSec: 98.25, score: SCORE, winner: null, reason: null, endTick: null });
    const obs = runTo(host, 6400);
    expect(toTick(98.25)).toBe(6288);
    expect(roundEnds(obs)).toEqual([[6288, 'CT', 'time']]);
    expect(obs.find((o) => o.tick === 6288)?.round.timeLeftSec).toBe(0);
    expect(obs.find((o) => o.tick === 3200)?.round.timeLeftSec).toBe(48.25);
  });

  it('no time-out while the bomb is planted: the explosion decides', () => {
    const host = host4();
    at(host, 6000, [{ type: 'plant', id: 'cart', pos: ORIGIN }]);
    const obs = runTo(host, 8600);
    expect(roundEnds(obs)).toEqual([[6000 + 2560, 'T', 'bomb_exploded']]);
  });

  it('the default round clock is tuning.round.timeSec and the default score 0 – 0', () => {
    const host = new Sim2DHost(openNav, tuning, roster4);
    expect(host.observe().round).toMatchObject({ timeLeftSec: tuning.round.timeSec, score: { ct: 0, t: 0 } });
    expect(() => new Sim2DHost(openNav, tuning, roster4, { score: { ct: -1, t: 0 }, roundTimeSec: 1 })).toThrow(/score/);
  });
});

describe('post-round play', () => {
  it('after the defuse win, pawns still move and shoot: the 69.4 s kill applies and yields a death; round_end and the score count once', () => {
    const host = new Sim2DHost(openNav, tuning, roster4, { score: SCORE, roundTimeSec: 98.25 });
    host.apply(
      act([
        ...setupActions('barely', { x: -1000, y: -1000 }, 0, 'ak47'),
        ...setupActions('cart', { x: 0, y: 0 }, 0, 'ak47'),
        ...setupActions('sp4rtan', { x: 0, y: 500 }, -90, 'deagle'),
        ...setupActions('zwomp', { x: 1000, y: 1000 }, 0, 'm4a4'),
        { type: 'give', id: 'sp4rtan', item: 'defuser', clip: 0, reserve: 0 },
      ]),
    );
    at(host, PLANT_TICK, [{ type: 'plant', id: 'barely', pos: { x: -1000, y: -900, z: 0 } }]);
    at(host, DEFUSE_START_TICK, [{ type: 'defuse_start', id: 'sp4rtan' }]);
    let obs = runTo(host, 4300);
    expect(roundEnds(obs)).toEqual([[DEFUSE_TICK, 'CT', 'bomb_defused']]);
    // cart runs east after the round ended.
    host.apply(act([], [hold('cart', [], 1, 0)]));
    obs = [...obs, ...runTo(host, 4400)];
    host.apply(act([], []));
    obs = [...obs, ...runTo(host, CART_DEATH_TICK)];
    const o = host.observe();
    expect(pawn(o, 'cart').pos.x).toBeGreaterThan(150);
    // sp4rtan aims at cart's head and fires on the recorded tick.
    const sp = pawn(o, 'sp4rtan');
    const cart = pawn(o, 'cart');
    const yaw = (Math.atan2(cart.pos.y - sp.pos.y, cart.pos.x - sp.pos.x) * 180) / Math.PI;
    host.apply(act([], [{ id: 'sp4rtan', forward: 0, side: 0, yaw, pitch: aimPitch(sp, cart, 'head', tuning.damage), buttons: ['ATTACK'] }]));
    obs = [...obs, ...runTo(host, CART_DEATH_TICK + 64)];
    const kill = obs.find((q) => eventsOf(q, 'death').length > 0) as Observe;
    expect(kill.tick - 1).toBe(CART_DEATH_TICK);
    expect(CART_DEATH_TICK).toBe(4442);
    expect(eventsOf(kill, 'death')).toEqual([{ type: 'death', victim: 'cart', attacker: 'sp4rtan', weapon: 'deagle', headshot: true }]);
    expect(pawn(kill, 'cart')).toMatchObject({ hp: 0, alive: false });
    expect(roundEnds(obs)).toEqual([[DEFUSE_TICK, 'CT', 'bomb_defused']]);
    expect(kill.round).toMatchObject({ phase: 'over', score: { ct: 12, t: 15 }, endTick: DEFUSE_TICK });
  });

  it('end_round forces the end once; later ends (forced or by the rules) are ignored', () => {
    const host = host4();
    at(host, 3, [{ type: 'end_round', winner: 'T', reason: 'time' }]);
    const obs = runTo(host, 10);
    host.apply(act([kill('barely'), kill('cart'), { type: 'end_round', winner: 'CT', reason: 'elimination' }]));
    obs.push(...runTo(host, 20));
    expect(roundEnds(obs)).toEqual([[3, 'T', 'time']]);
    expect(obs.at(-1)?.round).toMatchObject({ score: { ct: 11, t: 16 }, winner: 'T', reason: 'time' });
    expect(host.unhandled().map((n) => [n.type, n.reason])).toEqual([['end_round', 'round already over']]);
  });

  it('snapshot / restore after the end keeps score, winner and clock exactly', () => {
    const host = host4();
    at(host, 5, [kill('sp4rtan'), kill('zwomp')]);
    runTo(host, 30);
    const snap = host.snapshot();
    const first = runTo(host, 100);
    const fresh = new Sim2DHost(openNav, tuning, roster4); // other options: the snapshot wins
    fresh.restore(snap);
    expect(runTo(fresh, 100)).toEqual(first);
    expect(fresh.roundState()).toEqual(host.roundState());
  });
});

describe('Session wiring', () => {
  it('the Session passes round.meta.score and clock0: 11 – 15, 98.25 s; the setup gives barely the c4', () => {
    const s = new Session({ round: roundData, nav, tuning, seed: 1 });
    expect(s.observe().round).toEqual({
      phase: 'live',
      score: { ct: 11, t: 15 },
      winner: null,
      reason: null,
      endTick: null,
      timeLeftSec: 98.25,
      bomb: { state: 'carried', carrier: null, pos: null, plantTick: null, defuser: null, defuseEndTick: null },
    });
    s.step();
    expect(s.observe().round.bomb).toMatchObject({ state: 'carried', carrier: 'barely', pos: pawn(s.observe(), 'barely').pos });
  });
});

describe('pure rules', () => {
  const counts = (ctAlive: number, tAlive: number) => ({ ctTotal: 5, ctAlive, tTotal: 5, tAlive });

  it('checkRoundEnd: CTs first, a ticking bomb holds off T elimination and the time-out', () => {
    const r = freshRound(98.25, SCORE);
    expect(r.timeoutTick).toBe(6288);
    expect(checkRoundEnd(r, 0, counts(5, 5), false)).toBeNull();
    expect(checkRoundEnd(r, 0, counts(0, 0), false)).toEqual({ winner: 'T', reason: 'elimination' });
    expect(checkRoundEnd(r, 0, counts(0, 3), true)).toEqual({ winner: 'T', reason: 'elimination' });
    expect(checkRoundEnd(r, 0, counts(2, 0), false)).toEqual({ winner: 'CT', reason: 'elimination' });
    expect(checkRoundEnd(r, 0, counts(2, 0), true)).toBeNull();
    expect(checkRoundEnd(r, 6287, counts(2, 2), false)).toBeNull();
    expect(checkRoundEnd(r, 6288, counts(2, 2), false)).toEqual({ winner: 'CT', reason: 'time' });
    expect(checkRoundEnd(r, 6288, counts(2, 2), true)).toBeNull();
  });

  it('timeLeftSec: round clock, bomb timer, frozen at the defuse, 0 after the explosion', () => {
    const r = freshRound(98.25, SCORE);
    expect(timeLeftSec(r, 64, { state: 'carried', explodeTick: null, defusedTick: null })).toBe(97.25);
    expect(timeLeftSec(r, 99999, { state: 'dropped', explodeTick: null, defusedTick: null })).toBe(0);
    expect(timeLeftSec(r, 1762, { state: 'planted', explodeTick: 4321, defusedTick: null })).toBe(39.984375);
    expect(timeLeftSec(r, 5000, { state: 'defused', explodeTick: 4321, defusedTick: 4275 })).toBe(0.71875);
    expect(timeLeftSec(r, 5000, { state: 'exploded', explodeTick: 4321, defusedTick: null })).toBe(0);
  });
});
