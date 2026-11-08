/** H5: aimAtLanding — aim a throw at a landing spot (data/round.json utility[].landing; docs/grenades.md). */
import { describe, expect, it } from 'vitest';
import { aimAtLanding, simulateThrow } from '../../src/engine/grenades/index';
import { BoxWorld } from './box-world';
import { cs2Tuning, MirageWorld } from './mirage-world';
import { freeStand, MARKET_WINDOW_FRONT, recordedUtility } from './lineups';

const t = cs2Tuning();
const cfg = { tuning: t };

describe('aimAtLanding', () => {
  it('finds a throw onto an open-floor target and reproduces it', () => {
    const world = BoxWorld.flat();
    const base = { type: 'smoke' as const, thrower: 'p', team: 'T' as const, eye: { x: 0, y: 0, z: 64 }, velocity: { x: 0, y: 0, z: 0 } };
    const target = { x: 520, y: 180, z: 0 };
    const a = aimAtLanding(base, target, world, cfg);
    expect(a.error).toBeLessThan(12);
    const r = simulateThrow({ ...base, pitch: a.pitch, yaw: a.yaw, strength: a.strength }, world, cfg);
    expect(r.detonation?.pos).toEqual(a.landing);
    expect(JSON.stringify(aimAtLanding(base, target, world, cfg))).toBe(JSON.stringify(a));
  });
  it("cart's B-site smoke: onto the Market window, and onto the measured landing deep in Shop (S1)", () => {
    const world = new MirageWorld();
    const u = recordedUtility()[6];
    if (u === undefined || u.landing === null) throw new Error('no landing');
    const stand = freeStand(u.throwPos, world);
    const base = { type: 'smoke' as const, thrower: 'cart', team: 'T' as const, eye: { x: stand.x, y: stand.y, z: stand.z + t.eyeHeight }, velocity: { x: 0, y: 0, z: 0 } };
    expect(aimAtLanding(base, MARKET_WINDOW_FRONT, world, cfg).error).toBeLessThan(30);
    // S1's measured spot (deep inside Shop, by the freezer counter ~320 u south of the window): reachable from cart's
    // running release (his puppet's velocity at the throw, ~243 u/s holding the smoke) at full strength.
    const s1 = aimAtLanding({ ...base, velocity: { x: 176, y: -168, z: 0 } }, u.landing, world, cfg, { strengths: [1] });
    expect(s1.landing).not.toBeNull();
    expect(s1.error).toBeLessThan(u.landing.uncertainty);
    expect(s1.landing?.y ?? 0).toBeLessThan(-500);
  });
});
