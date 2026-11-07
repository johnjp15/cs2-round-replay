import { describe, expect, it } from 'vitest';
import type { BombObs, Observe, PawnObs, PlayerId, Team } from '../src/contracts/index';
import { DEAD_FADE_S, GHOST_FADE_S, RadarTracker, SPOT_INTERVAL_S } from '../src/app3d/radar3d';

interface P {
  id: PlayerId;
  team: Team;
  x?: number;
  alive?: boolean;
  sees?: PlayerId[];
}

const NO_BOMB: BombObs = { state: 'carried', carrier: null, pos: null, plantTick: null, defuser: null, defuseEndTick: null };

function obs(tick: number, ps: readonly P[], bomb: BombObs = NO_BOMB): Observe {
  const pawns = ps.map((p) => ({ id: p.id, team: p.team, pos: { x: p.x ?? 0, y: 0, z: 0 }, alive: p.alive ?? true, sees: p.sees ?? [], hp: 100, armor: 0 }) as unknown as PawnObs);
  return { tick, t: tick / 64, pawns, events: [], human: null, round: { bomb } } as unknown as Observe;
}

/** cart (T) and a teammate; donk (CT). */
function world(tick: number, cartSees: PlayerId[], opts: { donkX?: number; donkAlive?: boolean; mateSees?: PlayerId[]; bomb?: BombObs } = {}): Observe {
  return obs(
    tick,
    [
      { id: 'cart', team: 'T', sees: cartSees },
      { id: 'mate', team: 'T', sees: opts.mateSees ?? [] },
      { id: 'donk', team: 'CT', x: opts.donkX ?? 100, alive: opts.donkAlive ?? true },
    ],
    opts.bomb,
  );
}

const SPOT = SPOT_INTERVAL_S * 64;

describe('radar: CS2 rules', () => {
  it('shows teammates always and hides an enemy nobody on the team sees', () => {
    const r = new RadarTracker();
    r.reset(world(0, []));
    const m = r.marks(world(0, []), 'T', 'cs2');
    expect(m.map((x) => x.id).sort()).toEqual(['cart', 'mate']);
    // The CT side sees its own player but not the Ts.
    expect(r.marks(world(0, []), 'CT', 'cs2').map((x) => x.id)).toEqual(['donk']);
  });

  it('shows everyone with the toggle', () => {
    const r = new RadarTracker();
    r.reset(world(0, []));
    expect(r.marks(world(0, []), 'T', 'all').map((x) => x.id).sort()).toEqual(['cart', 'donk', 'mate']);
  });

  it('spots an enemy a teammate sees, on the 0.5 s spotting cadence, then leaves a fading ? at the last spot', () => {
    const r = new RadarTracker();
    r.reset(world(0, []));
    // Seen from tick 1: not yet on the radar (the next evaluation is at tick 32).
    for (let k = 1; k < SPOT; k++) r.ingest(world(k, [], { mateSees: ['donk'] }));
    expect(r.marks(world(SPOT - 1, []), 'T', 'cs2').some((x) => x.id === 'donk')).toBe(false);
    r.ingest(world(SPOT, [], { mateSees: ['donk'], donkX: 150 }));
    const dot = r.marks(world(SPOT, [], { donkX: 150 }), 'T', 'cs2').find((x) => x.id === 'donk');
    expect(dot).toMatchObject({ kind: 'dot', x: 150, alpha: 1 });
    // Out of sight from the next tick: the dot lingers (and follows) until the next evaluation.
    for (let k = SPOT + 1; k < 2 * SPOT; k++) r.ingest(world(k, [], { donkX: 150 + k - SPOT }));
    const still = r.marks(world(2 * SPOT - 1, [], { donkX: 150 + SPOT - 1 }), 'T', 'cs2').find((x) => x.id === 'donk');
    expect(still?.kind).toBe('dot');
    r.ingest(world(2 * SPOT, [], { donkX: 400 }));
    const ghost = r.marks(world(2 * SPOT, [], { donkX: 400 }), 'T', 'cs2').find((x) => x.id === 'donk');
    expect(ghost).toMatchObject({ kind: 'ghost', x: 150 + SPOT - 1, alpha: 1 });
    // Half way through the fade, then gone.
    const half = 2 * SPOT + (GHOST_FADE_S * 64) / 2;
    expect(r.marks(world(half, [], { donkX: 400 }), 'T', 'cs2').find((x) => x.id === 'donk')?.alpha).toBeCloseTo(0.5, 6);
    expect(r.marks(world(2 * SPOT + GHOST_FADE_S * 64, [], { donkX: 400 }), 'T', 'cs2').some((x) => x.id === 'donk')).toBe(false);
  });

  it('marks a spotted enemy dead with a fading X, an unspotted one not at all', () => {
    const seen = new RadarTracker();
    seen.reset(world(0, ['donk']));
    seen.ingest(world(1, ['donk'], { donkAlive: false, donkX: 120 }));
    expect(seen.marks(world(1, [], { donkAlive: false, donkX: 120 }), 'T', 'cs2').find((x) => x.id === 'donk')).toMatchObject({ kind: 'dead', x: 120 });
    const t = 1 + (DEAD_FADE_S * 64) / 4;
    expect(seen.marks(world(t, [], { donkAlive: false }), 'T', 'cs2').find((x) => x.id === 'donk')?.alpha).toBeCloseTo(0.75, 6);
    expect(seen.marks(world(1 + DEAD_FADE_S * 64, [], { donkAlive: false }), 'T', 'cs2').some((x) => x.id === 'donk')).toBe(false);
    const unseen = new RadarTracker();
    unseen.reset(world(0, []));
    unseen.ingest(world(1, [], { donkAlive: false }));
    expect(unseen.marks(world(1, [], { donkAlive: false }), 'T', 'cs2').some((x) => x.id === 'donk')).toBe(false);
  });

  it('puts the bomb icon on a teammate carrier; the planted bomb for everyone, a dropped one for Ts only', () => {
    const r = new RadarTracker();
    const carried: BombObs = { ...NO_BOMB, carrier: 'mate', pos: { x: 0, y: 0, z: 0 } };
    r.reset(world(0, [], { bomb: carried }));
    expect(r.marks(world(0, [], { bomb: carried }), 'T', 'cs2').find((x) => x.id === 'mate')?.bomb).toBe(true);
    const planted: BombObs = { ...NO_BOMB, state: 'planted', pos: { x: 5, y: 6, z: 0 }, plantTick: 10 };
    expect(r.bomb(world(0, [], { bomb: planted }), 'CT', 'cs2')).toMatchObject({ x: 5, y: 6, state: 'planted' });
    const dropped: BombObs = { ...NO_BOMB, state: 'dropped', pos: { x: 5, y: 6, z: 0 } };
    expect(r.bomb(world(0, [], { bomb: dropped }), 'T', 'cs2')).not.toBeNull();
    expect(r.bomb(world(0, [], { bomb: dropped }), 'CT', 'cs2')).toBeNull();
    expect(r.bomb(world(0, [], { bomb: dropped }), 'CT', 'all')).not.toBeNull();
  });
});
