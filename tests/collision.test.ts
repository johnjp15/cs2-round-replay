/** C3: pawn-pawn collision (enemies solid, teammates and the dead not). */
import { describe, expect, it } from 'vitest';
import type { Observe, PlayerId, Tuning } from '../src/contracts/index';
import { collideMove, contactTime } from '../src/sim2d/collision';
import { Sim2DHost } from '../src/sim2d/host';
import { hold, place, runTo, tuning } from './bomb-fixtures';
import { act, openNav, pawn, roster4, wallNav } from './combat-fixtures';

const R = 2 * tuning.collision.pawnRadius;
const EPS = 1e-6;

function dist(o: Observe, a: PlayerId, b: PlayerId): number {
  const p = pawn(o, a).pos;
  const q = pawn(o, b).pos;
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/** cart (T) at the origin running east; `other` standing at `at`; everyone else far away. */
function runInto(other: PlayerId, at: { x: number; y: number }, t: Tuning = tuning, ticks = 160): { host: Sim2DHost; obs: Observe[] } {
  const host = new Sim2DHost(openNav, t, roster4);
  const park = roster4.filter((r) => r.id !== 'cart' && r.id !== other).map((r, i) => place(r.id, { x: -3000, y: -3000 + 200 * i, z: 0 }));
  host.apply(act([...park.flat(), ...place('cart', { x: 0, y: 0, z: 0 }, 'knife'), ...place(other, { x: at.x, y: at.y, z: 0 })], [hold('cart', [], 1, 0)]));
  const obs = runTo(host, ticks);
  return { host, obs };
}

describe('collision between pawns', () => {
  it('an alive enemy blocks: cart stops 32 units short of sp4rtan, who does not move', () => {
    const { host, obs } = runInto('sp4rtan', { x: 200, y: 0 });
    for (const o of obs) expect(dist(o, 'cart', 'sp4rtan'), `tick ${o.tick}`).toBeGreaterThanOrEqual(R - EPS);
    const last = obs.at(-1) as Observe;
    expect(pawn(last, 'cart').pos.x).toBeCloseTo(200 - R, 1);
    expect(pawn(last, 'cart').vel.x).toBeLessThan(1);
    expect(pawn(last, 'sp4rtan').pos).toEqual({ x: 200, y: 0, z: 0 });
    expect(host.blockedBy('cart')).toBe('sp4rtan');
    expect(host.pawnState('cart')?.blockedBy).toBe('sp4rtan');
    expect(host.blockedBy('sp4rtan')).toBeNull();
  });

  it('a glancing hit slides around the enemy like a wall and goes on', () => {
    const { host, obs } = runInto('sp4rtan', { x: 200, y: 10 }, tuning, 200);
    for (const o of obs) expect(dist(o, 'cart', 'sp4rtan'), `tick ${o.tick}`).toBeGreaterThanOrEqual(R - EPS);
    expect(obs.some((o) => pawn(o, 'cart').pos.y < -1)).toBe(true); // deflected to the far side
    expect(pawn(obs.at(-1) as Observe, 'cart').pos.x).toBeGreaterThan(300);
    expect(host.blockedBy('cart')).toBeNull();
  });

  it('teammates pass through each other (collision.solidTeammates false)', () => {
    const { host, obs } = runInto('barely', { x: 200, y: 0 });
    expect(Math.min(...obs.map((o) => dist(o, 'cart', 'barely')))).toBeLessThan(5);
    expect(pawn(obs.at(-1) as Observe, 'cart').pos.x).toBeGreaterThan(300);
    expect(host.blockedBy('cart')).toBeNull();
  });

  it('with solidTeammates true, teammates block too', () => {
    const solid: Tuning = { ...tuning, collision: { ...tuning.collision, solidTeammates: true } };
    const { obs } = runInto('barely', { x: 200, y: 0 }, solid);
    for (const o of obs) expect(dist(o, 'cart', 'barely')).toBeGreaterThanOrEqual(R - EPS);
  });

  it('dead pawns are not solid', () => {
    const host = new Sim2DHost(openNav, tuning, roster4);
    host.apply(
      act(
        [...place('cart', { x: 0, y: 0, z: 0 }, 'knife'), ...place('sp4rtan', { x: 200, y: 0, z: 0 }), { type: 'set_hp', id: 'sp4rtan', hp: 0, armor: 0, helmet: false }],
        [hold('cart', [], 1, 0)],
      ),
    );
    const obs = runTo(host, 160);
    expect(Math.min(...obs.map((o) => dist(o, 'cart', 'sp4rtan')))).toBeLessThan(5);
    expect(pawn(obs.at(-1) as Observe, 'cart').pos.x).toBeGreaterThan(300);
  });

  it('two enemies running head-on never overlap, and the result is deterministic (id order)', () => {
    const run = (): Observe[] => {
      const host = new Sim2DHost(openNav, tuning, roster4);
      host.apply(act([...place('cart', { x: 0, y: 0, z: 0 }, 'knife'), ...place('sp4rtan', { x: 300, y: 3, z: 0 }, 'knife', 180)], [hold('cart', [], 1, 0), hold('sp4rtan', [], 1, 180)]));
      return runTo(host, 200);
    };
    const a = run();
    for (const o of a) expect(dist(o, 'cart', 'sp4rtan'), `tick ${o.tick}`).toBeGreaterThanOrEqual(R - EPS);
    expect(run()).toEqual(a);
  });

  it('a pawn teleported into an enemy may move out but not deeper', () => {
    const host = new Sim2DHost(openNav, tuning, roster4);
    host.apply(act([...place('cart', { x: 0, y: 0, z: 0 }, 'knife'), ...place('sp4rtan', { x: 10, y: 0, z: 0 })], [hold('cart', [], 1, 0)]));
    runTo(host, 20);
    expect(dist(host.observe(), 'cart', 'sp4rtan')).toBeGreaterThanOrEqual(10 - EPS); // pushing in: held
    host.apply(act([], [hold('cart', [], 1, 180)]));
    runTo(host, 60);
    expect(dist(host.observe(), 'cart', 'sp4rtan')).toBeGreaterThan(R);
  });

  it('slides stay on walkable ground next to a wall', () => {
    const host = new Sim2DHost(wallNav, tuning, roster4);
    host.apply(act([...place('cart', { x: 300, y: 5, z: 0 }, 'knife', 180), ...place('sp4rtan', { x: 80, y: 0, z: 0 })], [hold('cart', [], 1, 180)]));
    const obs = runTo(host, 200);
    for (const o of obs) {
      expect(wallNav.isWalkable(pawn(o, 'cart').pos)).toBe(true);
      expect(dist(o, 'cart', 'sp4rtan')).toBeGreaterThanOrEqual(R - EPS);
    }
  });
});

describe('collideMove (pure)', () => {
  it('contactTime: first touch of the 32-unit separation along the move', () => {
    expect(contactTime({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 0 }, 32)).toBeCloseTo(0.18, 12);
    expect(contactTime({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 50, y: 0 }, 32)).toBeNull(); // short of it
    expect(contactTime({ x: 0, y: 0 }, { x: -100, y: 0 }, { x: 50, y: 0 }, 32)).toBeNull(); // moving away
    expect(contactTime({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 40 }, 32)).toBeNull(); // passes by
  });

  it('cuts a move at the contact point (backed off 0.01) and reports the obstacle; a free move is untouched', () => {
    const obstacle = [{ id: 'sp4rtan' as const, x: 50, y: 0 }];
    const hit = collideMove({ x: 0, y: 0 }, { x: 30, y: 0 }, obstacle, 16, null);
    expect(hit.blockedBy).toBe('sp4rtan');
    expect(hit.x).toBeCloseTo(18 - 0.01, 9);
    expect(hit.y).toBe(0);
    expect(collideMove({ x: 0, y: 0 }, { x: 10, y: 0 }, obstacle, 16, null)).toEqual({ x: 10, y: 0, blockedBy: null });
  });
});
