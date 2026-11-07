import { describe, expect, it } from 'vitest';
import type { Act, ObsEvent, Observe, PawnObs, PawnStatus, PlayerId, Team } from '../src/contracts/index';
import type { Effect } from '../src/app/effects';
import { liveRound } from './fakes';
import { TRACER_TICKS } from '../src/app/effects';
import { TICK_MS } from '../src/app/loop';
import {
  KILL_FEED_TICKS,
  KillFeed,
  LOG_MAX,
  NO_BOMB,
  SNAP_UNITS_PER_TICK,
  Scene,
  interpolatePose,
  interpolationAlpha,
  lerpAngle,
  nextBombState,
  normalizeDeg,
  rayEnd,
  type KillEntry,
} from '../src/app/scene';

function pawn(id: PlayerId, team: Team, x: number, y: number, yaw = 0, extra: Partial<PawnObs> = {}): PawnObs {
  return {
    id,
    team,
    pos: { x, y, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    pitch: 0,
    hp: 100,
    armor: 100,
    alive: true,
    weapon: 'ak47',
    ammo: { clip: 30, reserve: 90 },
    crouching: false,
    onGround: true,
    sees: [],
    ...extra,
  };
}

function obs(tick: number, pawns: PawnObs[], events: ObsEvent[] = []): Observe {
  return { tick, t: tick / 64, pawns, events, human: null, round: liveRound(tick) };
}

function status(mode: PawnStatus['mode'] = 'REPLAY'): PawnStatus[] {
  return [
    { id: 'cart', mode, trigger: null, sinceTick: 0 },
    { id: 'lokier', mode: 'REPLAY', trigger: null, sinceTick: 0 },
  ];
}

function act(actions: Act['actions'] = [], mode: PawnStatus['mode'] = 'REPLAY'): Act {
  return { inputs: [], actions, status: status(mode) };
}

const CART = (x = 0, y = 0, yaw = 0, extra: Partial<PawnObs> = {}): PawnObs => pawn('cart', 'T', x, y, yaw, extra);
const LOKIER = (x = 500, y = 0, extra: Partial<PawnObs> = {}): PawnObs => pawn('lokier', 'CT', x, y, 180, extra);

describe('interpolation', () => {
  it('alpha is the owed fraction of a tick, clamped', () => {
    expect(interpolationAlpha(0, TICK_MS)).toBe(0);
    expect(interpolationAlpha(TICK_MS / 4, TICK_MS)).toBe(0.25);
    expect(interpolationAlpha(TICK_MS * 3, TICK_MS)).toBe(1);
    expect(interpolationAlpha(-1, TICK_MS)).toBe(0);
    expect(interpolationAlpha(Number.NaN, TICK_MS)).toBe(0);
    expect(interpolationAlpha(5, 0)).toBe(0);
  });

  it('yaw takes the short way round, in (−180, 180]', () => {
    expect(normalizeDeg(540)).toBe(180);
    expect(normalizeDeg(-180)).toBe(180);
    expect(normalizeDeg(-190)).toBe(170);
    expect(lerpAngle(170, -170, 0.5)).toBe(180);
    expect(lerpAngle(-170, 170, 0.25)).toBeCloseTo(-175, 9);
    expect(lerpAngle(10, 50, 0.5)).toBe(30);
  });

  it('moves a pawn alpha of the way between ticks', () => {
    const a = CART(0, 0, 0);
    const b = CART(4, -2, 20);
    expect(interpolatePose(a, b, 0)).toEqual({ x: 0, y: 0, z: 0, yaw: 0 });
    expect(interpolatePose(a, b, 0.5)).toEqual({ x: 2, y: -1, z: 0, yaw: 10 });
    expect(interpolatePose(a, b, 1)).toEqual({ x: 4, y: -2, z: 0, yaw: 20 });
    expect(interpolatePose(a, b, 7)).toEqual({ x: 4, y: -2, z: 0, yaw: 20 });
  });

  it('snaps (no slide) across teleports, deaths and missing history', () => {
    const a = CART(0, 0, 0);
    const far = CART(SNAP_UNITS_PER_TICK + 1, 0, 90);
    expect(interpolatePose(a, far, 0.5)).toEqual({ x: SNAP_UNITS_PER_TICK + 1, y: 0, z: 0, yaw: 90 });
    const dead = CART(2, 0, 0, { alive: false });
    expect(interpolatePose(a, dead, 0.5)).toEqual({ x: 2, y: 0, z: 0, yaw: 0 });
    expect(interpolatePose(null, CART(3, 3, 5), 0.5)).toEqual({ x: 3, y: 3, z: 0, yaw: 5 });
  });

  it('a 4× frame (four ticks) still interpolates between the last two observes', () => {
    const s = new Scene(obs(1, [CART(0, 0)]), null);
    for (let t = 2; t <= 5; t++) s.ingest(obs(t, [CART((t - 1) * 3, 0)]), act());
    expect(s.prev?.tick).toBe(4);
    expect(s.renderTick(0.5)).toBe(4.5);
    expect(s.pose('cart', 0.5)).toEqual({ x: 10.5, y: 0, z: 0, yaw: 0 });
  });
});

describe('kill feed', () => {
  const kill = (tick: number, victim: PlayerId = 'lokier'): KillEntry => ({
    tick,
    killer: 'cart',
    killerTeam: 'T',
    victim,
    victimTeam: 'CT',
    weapon: 'ak47',
    headshot: false,
  });

  it('shows each kill for 5 s of round time', () => {
    const f = new KillFeed();
    f.push(kill(100));
    expect(f.visible(100)).toHaveLength(1);
    expect(f.visible(100 + KILL_FEED_TICKS - 1)).toHaveLength(1);
    expect(f.visible(100 + KILL_FEED_TICKS)).toHaveLength(0);
    expect(f.lifeLeft(kill(100), 100 + KILL_FEED_TICKS / 2)).toBe(0.5);
  });

  it('keeps the newest five, oldest first', () => {
    const f = new KillFeed();
    for (let i = 0; i < 7; i++) f.push(kill(100 + i * 10));
    const v = f.visible(170);
    expect(v.map((e) => e.tick)).toEqual([120, 130, 140, 150, 160]);
  });

  it('ages entries out one by one, and hides kills after a rewind', () => {
    const f = new KillFeed();
    f.push(kill(0));
    f.push(kill(200));
    expect(f.visible(KILL_FEED_TICKS + 50).map((e) => e.tick)).toEqual([200]);
    expect(f.visible(100).map((e) => e.tick)).toEqual([0]);
    f.clear();
    expect(f.visible(200)).toEqual([]);
  });
});

describe('scene ingest', () => {
  it('builds the kill feed from death events, stamped with the tick they happened in', () => {
    const s = new Scene(obs(10, [CART(), LOKIER()]), act());
    const death: ObsEvent = { type: 'death', victim: 'lokier', attacker: 'cart', weapon: 'ak47', headshot: true };
    s.ingest(obs(11, [CART(), LOKIER(500, 0, { alive: false, hp: 0 })], [death]), act());
    const feed = s.killFeed.visible(10.5);
    expect(feed).toEqual([{ tick: 10, killer: 'cart', killerTeam: 'T', victim: 'lokier', victimTeam: 'CT', weapon: 'ak47', headshot: true }]);
    expect(s.deaths.get('lokier')).toBe(10);
  });

  it('draws a tracer to the pawn the shot damaged', () => {
    const s = new Scene(obs(10, [CART(), LOKIER()]), act());
    s.ingest(
      obs(11, [CART(0, 0, 0), LOKIER(500, 20)], [
        { type: 'shot', shooter: 'cart', weapon: 'ak47' },
        { type: 'damage', attacker: 'cart', victim: 'lokier', amount: 27, armor: 4, weapon: 'ak47', hitgroup: 'chest', scripted: false },
      ]),
      act(),
    );
    expect(s.tracers).toEqual([{ tick: 10, shooter: 'cart', team: 'T', from: { x: 0, y: 0 }, to: { x: 500, y: 20 }, hit: true }]);
  });

  it('stops a missed shot at the first wall, and drops tracers once faded', () => {
    // A wall at x = 300.
    const sight = { lineOfSight: (a: { x: number }, b: { x: number }) => Math.max(a.x, b.x) < 300 };
    const s = new Scene(obs(10, [CART(), LOKIER()]), act(), [], sight);
    s.ingest(obs(11, [CART(0, 0, 0), LOKIER()], [{ type: 'shot', shooter: 'cart', weapon: 'ak47' }]), act());
    const t = s.tracers[0];
    expect(t?.hit).toBe(false);
    expect(t?.to.x).toBeGreaterThan(299);
    expect(t?.to.x).toBeLessThan(300);
    for (let k = 12; k <= 12 + TRACER_TICKS; k++) s.ingest(obs(k, [CART(), LOKIER()]), act());
    expect(s.tracers).toEqual([]);
  });

  it('leaves no tracer for knives and grenades', () => {
    const s = new Scene(obs(10, [CART()]), act());
    s.ingest(obs(11, [CART()], [{ type: 'shot', shooter: 'cart', weapon: 'knife' }]), act());
    expect(s.tracers).toEqual([]);
  });

  it('keeps the statuses of the last Act and the last 20 Core log lines', () => {
    const s = new Scene(obs(0, [CART()]), null);
    expect(s.status).toEqual([]);
    for (let k = 1; k <= 25; k++) s.ingest(obs(k, [CART()]), act([{ type: 'log', level: 'info', text: `line ${k}` }], k === 25 ? 'LIVE' : 'REPLAY'));
    expect(s.logs).toHaveLength(LOG_MAX);
    expect(s.logs[0]).toEqual({ tick: 5, level: 'info', text: 'line 6' });
    expect(s.statusOf('cart')?.mode).toBe('LIVE');
  });

  it('turns a flash that leaves the list into a pop at its grenade sound', () => {
    const flying: Effect = { seq: 3, kind: 'flash', phase: 'flying', thrower: 'cart', pos: { x: 100, y: 0, z: 30 }, radius: 0, untilTick: 12 };
    const s = new Scene(obs(10, [CART()]), act(), [flying]);
    s.ingest(obs(11, [CART()]), act(), [{ ...flying, pos: { x: 120, y: 0, z: 20 } }]);
    expect(s.pops).toEqual([]);
    s.ingest(obs(12, [CART()], [{ type: 'sound', source: 'cart', pos: { x: 125, y: 1, z: 0 }, kind: 'grenade' }]), act(), []);
    expect(s.pops).toEqual([{ seq: 3, kind: 'flash', pos: { x: 125, y: 1 }, tick: 11 }]);
  });

  it('a smoke that pops stays an effect (no pop), and remembers when it bloomed', () => {
    const flying: Effect = { seq: 1, kind: 'smoke', phase: 'flying', thrower: 'cart', pos: { x: 0, y: 0, z: 0 }, radius: 0, untilTick: 20 };
    const s = new Scene(obs(10, [CART()]), act(), [flying]);
    const cloud: Effect = { ...flying, phase: 'smoke', radius: 144, untilTick: 1172 };
    s.ingest(obs(11, [CART()]), act(), [cloud]);
    expect(s.pops).toEqual([]);
    expect(s.bornTick(cloud)).toBe(10);
    expect(s.bornTick(flying)).toBeNull();
  });

  it('follows the bomb through its events', () => {
    let b = nextBombState(NO_BOMB, { type: 'bomb', phase: 'planted', id: 'barely', pos: { x: -1982, y: 311, z: -160 } }, 1761);
    expect(b).toMatchObject({ phase: 'planted', plantTick: 1761, planter: 'barely' });
    b = nextBombState(b, { type: 'bomb', phase: 'defuse_start', id: 'sp4rtan', pos: null }, 3955);
    expect(b).toMatchObject({ phase: 'defusing', defuser: 'sp4rtan', defuseStartTick: 3955, pos: { x: -1982 } });
    b = nextBombState(b, { type: 'bomb', phase: 'defuse_stop', id: 'sp4rtan', pos: null }, 3990);
    expect(b).toMatchObject({ phase: 'planted', defuser: null });
    b = nextBombState(b, { type: 'bomb', phase: 'defused', id: 'sp4rtan', pos: null }, 4275);
    expect(b).toMatchObject({ phase: 'defused', endTick: 4275, plantTick: 1761 });
  });

  it('records the round end, and starts over on a rewind', () => {
    const s = new Scene(obs(10, [CART()]), act());
    s.ingest(obs(11, [CART()], [{ type: 'round_end', winner: 'CT', reason: 'bomb_defused' }]), act());
    expect(s.roundEnd).toEqual({ tick: 10, winner: 'CT', reason: 'bomb_defused' });
    s.ingest(obs(5, [CART()]), act());
    expect(s.roundEnd).toBeNull();
    expect(s.prev).toBeNull();
    expect(s.cur.tick).toBe(5);
  });
});

describe('rayEnd', () => {
  it('runs the full range in the open, along the yaw', () => {
    const e = rayEnd({ x: 0, y: 0 }, 90, 100, null);
    expect(e.x).toBeCloseTo(0, 9);
    expect(e.y).toBeCloseTo(100, 9);
  });
});
