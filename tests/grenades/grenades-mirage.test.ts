/** H5: public CS2 Mirage lineups and the recorded round's utility on the real CS2 mesh (docs/grenades.md, Lineups). */
import { describe, expect, it } from 'vitest';
import { createGrenadeState, smokeBlocks, smokeDensityAt, stepGrenades, throwGrenade } from '../../src/engine/grenades/index';
import { cs2Tuning, MirageWorld } from './mirage-world';
import { LINEUPS, MARKET_WINDOW_FRONT, placesNear, RECORDED_AIM, recordedUtility, REPORTED, runLineup, runRecorded } from './lineups';

const t = cs2Tuning();
const world = new MirageWorld();

describe('Mirage lineups (cs2util.com setpos / setang)', () => {
  for (const l of LINEUPS) {
    it(`${l.name} lands in ${l.expectPlace}`, () => {
      const r = runLineup(l, world, t);
      // A flash pops in the air: compare with the callout's floor up to 250 below it.
      expect(placesNear(r.pos, 48, l.type === 'flash' ? 250 : 160)).toContain(l.expectPlace);
      if (l.expectSpot !== null) {
        const d = Math.hypot(r.pos.x - l.expectSpot.x, r.pos.y - l.expectSpot.y, r.pos.z - l.expectSpot.z);
        expect(d).toBeLessThanOrEqual(l.tolerance);
      }
    });
  }
  it('the window smoke fills the window room and blocks the mid → window sight line', () => {
    const l = LINEUPS[0];
    if (l === undefined) throw new Error('no lineup');
    const r = runLineup(l, world, t);
    const s = createGrenadeState(1);
    throwGrenade(s, { type: 'smoke', thrower: 'p', team: 'T', eye: { x: l.setpos[0], y: l.setpos[1], z: l.setpos[2] }, pitch: l.setang[0], yaw: l.setang[1], strength: 1, velocity: { x: 0, y: 0, z: 0 } }, world, { tuning: t });
    let pop = -1;
    for (let k = 0; k < 64 * 12 && pop < 0; k++) for (const e of stepGrenades(s, world, { pawns: [], friendlyFire: false }, { tuning: t })) if (e.type === 'smoke_start') pop = e.tick;
    expect(pop).toBeGreaterThan(0);
    const later = pop + 64 * 3;
    // A player in the window (behind the sill) looking at top mid, and the reverse.
    const inWindow = { x: -1140, y: -625, z: -168 + 64 };
    const topMid = { x: 360, y: -690, z: -100 };
    expect(smokeDensityAt(s, { x: r.pos.x, y: r.pos.y, z: r.pos.z + 30 }, later, t)).toBe(1);
    expect(smokeBlocks(s, inWindow, topMid, later, t)).toBe(true);
    expect(smokeBlocks(s, inWindow, topMid, pop + 64 * 21, t)).toBe(false);
  });
  it('the B flash blinds a CT on B site looking at Apartments', () => {
    const l = LINEUPS.find((x) => x.type === 'flash');
    if (l === undefined) throw new Error('no flash lineup');
    const s = createGrenadeState(1);
    throwGrenade(s, { type: 'flash', thrower: 'p', team: 'T', eye: { x: l.setpos[0], y: l.setpos[1], z: l.setpos[2] }, pitch: l.setang[0], yaw: l.setang[1], strength: 1, velocity: { x: 0, y: 0, z: 0 } }, world, { tuning: t });
    const plant = { x: -2000, y: 450, z: -160 };
    const yaw = (Math.atan2(664 - plant.y, -1472 - plant.x) * 180) / Math.PI;
    const ct = { id: 'sp4rtan', team: 'CT' as const, alive: true, pos: plant, height: 72, eye: { x: plant.x, y: plant.y, z: plant.z + 64 }, yaw, pitch: -10 };
    let blind = null;
    for (let k = 0; k < 120; k++) for (const e of stepGrenades(s, world, { pawns: [ct], friendlyFire: false }, { tuning: t })) if (e.type === 'blind') blind = e.blind;
    expect(blind).not.toBeNull();
    expect(blind?.holdSec ?? 0).toBeGreaterThan(1);
  });
  it('lineups are deterministic', () => {
    const a = LINEUPS.map((l) => runLineup(l, world, t).pos);
    const b = LINEUPS.map((l) => runLineup(l, world, t).pos);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it('reported T-spawn jump throws still detonate (docs: where they land and why they miss)', () => {
    for (const l of REPORTED) expect(runLineup(l, world, t).sec).toBeLessThan(15);
  });
});

describe("the recorded round's 8 throws (plausible aim)", () => {
  it('each detonates on the mesh', () => {
    const u = recordedUtility();
    expect(u).toHaveLength(8);
    u.forEach((x, k) => {
      const aim = RECORDED_AIM[k];
      if (aim === undefined) throw new Error('no aim');
      const r = runRecorded(x, aim, world, t);
      expect(r.sec).toBeGreaterThan(0.5);
      expect(r.sec).toBeLessThan(12);
    });
  });
  it("cart's B-site smoke lands at the Market window and blocks the sight line through it (backlog 21)", () => {
    const u = recordedUtility()[6];
    const aim = RECORDED_AIM[6];
    if (u === undefined || aim === undefined) throw new Error('no throw');
    expect(u.thrower).toBe('cart');
    const r = runRecorded(u, aim, world, t);
    expect(Math.hypot(r.pos.x - MARKET_WINDOW_FRONT.x, r.pos.y - MARKET_WINDOW_FRONT.y)).toBeLessThanOrEqual(48);
    const s = createGrenadeState(1);
    throwGrenade(s, { type: 'smoke', thrower: 'cart', team: 'T', eye: { x: r.stand.x, y: r.stand.y, z: r.stand.z + t.eyeHeight }, pitch: r.pitch, yaw: r.yaw, strength: 1, velocity: { x: 0, y: 0, z: 0 } }, world, { tuning: t });
    let pop = -1;
    for (let k = 0; k < 64 * 12 && pop < 0; k++) for (const e of stepGrenades(s, world, { pawns: [], friendlyFire: false }, { tuning: t })) if (e.type === 'smoke_start') pop = e.tick;
    expect(pop).toBeGreaterThan(0);
    // A CT in Market behind the window looking straight out onto B site: a clear line through the opening.
    const inMarket = { x: -1921, y: -330, z: -104 };
    const onSite = { x: -1921, y: -100, z: -104 };
    expect(world.traceLine(inMarket.x, inMarket.y, inMarket.z, onSite.x, onSite.y, onSite.z)).toBe(1);
    expect(smokeBlocks(s, inMarket, onSite, pop + 64 * 3, t)).toBe(true);
    expect(smokeBlocks(s, inMarket, onSite, pop + 64 * 21, t)).toBe(false);
  });
});
