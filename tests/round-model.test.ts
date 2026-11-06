import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, type TrackSample } from '../src/contracts/index';
import { RoundModel } from '../src/core/index';
import { loadRound } from './round-fixture';

const model = new RoundModel(loadRound());

describe('RoundModel', () => {
  it('lists the ten players sorted by id with their start state', () => {
    expect(model.players.map((p) => p.id)).toEqual([...PLAYER_IDS]);
    const sp4rtan = model.player('sp4rtan');
    expect(sp4rtan).toMatchObject({ team: 'CT', startPos: { x: -505, y: -1460, z: -81 }, startYaw: null, hp: 100, role: 'flank_then_retake' });
    expect(model.player('eradicate').startYaw).toBe(167.2);
    expect(model.player('snarlbot')).toMatchObject({ team: 'T', hp: 44, armor: 100, helmet: true });
    expect(model.player('barely').roles).toEqual(['take_b', 'planter']);
    expect(model.player('cart').isHumanDefault).toBe(true);
    expect(model.bomb.plantTick).toBe(1761);
  });

  it('interpolates tracks linearly and returns null outside them', () => {
    // barely: (-473, 647) at 0.0, (-478, 646) at 0.1, (-490, 643) at 0.2.
    expect(model.trackAt('barely', 0)?.pos).toEqual({ x: -473, y: 647, z: -82 });
    const mid = model.trackAt('barely', 0.05);
    expect(mid?.pos.x).toBeCloseTo(-475.5, 9);
    expect(mid?.pos.y).toBeCloseTo(646.5, 9);
    expect(model.trackAt('barely', 0.2)?.pos).toMatchObject({ x: -490, y: 643 });
    expect(model.trackAtTick('barely', 0)).toEqual(model.trackAt('barely', 0));

    expect(model.trackAt('barely', -0.01)).toBeNull();
    const last = model.track('incredibad').at(-1) as TrackSample;
    expect(last.t).toBe(0.5);
    expect(model.trackAt('incredibad', 0.5)?.pos).toMatchObject({ x: last.x, y: last.y });
    expect(model.trackAt('incredibad', 0.5001)).toBeNull();
    expect(model.trackAt('sp4rtan', 70.3)).not.toBeNull();
    expect(model.trackAt('sp4rtan', 70.31)).toBeNull();
  });

  it('reports the less certain confidence and the larger uncertainty of the bracketing samples', () => {
    expect(model.trackAt('sp4rtan', 0)).toMatchObject({ confidence: 'inferred', uncertainty: 320 });
    expect(model.trackAt('barely', 10)).toMatchObject({ confidence: 'observed', uncertainty: null });

    const samples = model.track('snarlbot');
    const i = samples.findIndex((s, j) => j + 1 < samples.length && s.confidence !== samples[j + 1]?.confidence);
    const a = samples[i] as TrackSample;
    const b = samples[i + 1] as TrackSample;
    expect([a.confidence, b.confidence].sort()).toEqual(['estimated', 'observed']);
    expect(model.trackAt('snarlbot', (a.t + b.t) / 2)?.confidence).toBe('estimated');

    const sp = model.track('sp4rtan');
    const k = sp.findIndex((s, j) => j + 1 < sp.length && s.uncertainty !== undefined && sp[j + 1]?.uncertainty !== undefined && s.uncertainty !== sp[j + 1]?.uncertainty);
    const c = sp[k] as TrackSample;
    const d = sp[k + 1] as TrackSample;
    expect(model.trackAt('sp4rtan', (c.t + d.t) / 2)?.uncertainty).toBe(Math.max(c.uncertainty ?? 0, d.uncertainty ?? 0));
  });

  it('knows deaths and observation', () => {
    expect(model.deathTick('donk')).toBe(3222);
    expect(model.deathTick('cart')).toBe(4442);
    expect(model.deathTick('sp4rtan')).toBeNull();
    expect(model.isAlive('donk', 3221)).toBe(true);
    expect(model.isAlive('donk', 3222)).toBe(false);
    expect(model.isAlive('sp4rtan', 99999)).toBe(true);

    expect(model.isObserved('barely', 10)).toBe(true);
    expect(model.isObserved('snarlbot', 5)).toBe(false); // estimated
    expect(model.isObserved('snarlbot', 15)).toBe(true);
    expect(model.isObserved('sp4rtan', 30)).toBe(false); // inferred
    expect(model.isObserved('lokier', 18)).toBe(true); // sighted by cart
    expect(model.isObserved('incredibad', 5)).toBe(false); // after his track ends
  });
});
