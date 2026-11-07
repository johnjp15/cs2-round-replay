/**
 * H2: wall penetration (src/engine/weapons/penetration.ts) on the Mirage collision mesh. The engine stays pure: the
 * test builds the host's SolidQuery from MapGeometry (allowed in tests only) the way a host would.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTuning, type Vec3, type WeaponModelTuning } from '../src/contracts/index';
import { bulletDamage, falloff, parseWeaponTable, penetrate, penetrationLoss, traceBulletDamage, weaponDef, type SolidQuery, type SolidSpan } from '../src/engine/weapons/index';
import { MapGeometry } from '../src/sim2d/geometry';

const readText = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const table = parseWeaponTable(JSON.parse(readText('../data/weapons.json')) as unknown);
const tuning = parseTuning(readText('../data/tuning.json'));
const m = tuning.weaponModel as WeaponModelTuning;
const d = tuning.damage;
const mirage = MapGeometry.fromBytes(new Uint8Array(readFileSync(new URL('../data/geometry/mirage-geometry.bin', import.meta.url))));

/**
 * Solids along a ray on a triangle mesh (no materials): the faces the ray crosses, taken in pairs (enter, exit);
 * a face within ADJACENT units after an exit continues the solid (a frame or trim mounted on a wall: their shared
 * face is one triangle). Modifier: the default.
 */
const ADJACENT = 4;
function meshQuery(g: MapGeometry): SolidQuery {
  return (o: Vec3, dir: Vec3, maxDistance: number): SolidSpan[] => {
    const faces: number[] = [];
    let s = 0;
    const ex = o.x + dir.x * maxDistance;
    const ey = o.y + dir.y * maxDistance;
    const ez = o.z + dir.z * maxDistance;
    for (let k = 0; k < 64 && s < maxDistance; k++) {
      const f = g.traceLine(o.x + dir.x * s, o.y + dir.y * s, o.z + dir.z * s, ex, ey, ez);
      if (f >= 1) break;
      const hit = s + f * (maxDistance - s);
      faces.push(hit);
      s = hit + 0.01;
    }
    const spans: SolidSpan[] = [];
    let i = 0;
    while (i + 1 < faces.length) {
      const enter = faces[i] as number;
      let exit = faces[i + 1] as number;
      i += 2;
      while (i < faces.length && (faces[i] as number) - exit <= ADJACENT) {
        exit = faces[i] as number;
        i++;
      }
      spans.push({ enter, exit });
    }
    return spans;
  };
}
const query = meshQuery(mirage);
const north: Vec3 = { x: 0, y: 1, z: 0 };

describe('penetration formula', () => {
  const ak = weaponDef(table, 'ak47');
  it('with no solids it is the open-air falloff of damage.ts', () => {
    for (const dist of [0, 500, 1000, 2000]) expect(penetrate(ak, [], dist, d, m).damage).toBeCloseTo(falloff(36, 0.98, dist, d), 12);
  });

  it('loss per surface: 16 % of the damage + (3 / power × 1.25) × 3 / modifier + thickness² / (24 × modifier)', () => {
    expect(penetrationLoss(ak, 36, 16, 1, m)).toBeCloseTo(36 * 0.16 + (3 / 2) * 1.25 * 3 + 256 / 24, 12);
    const awp = weaponDef(table, 'awp');
    expect(penetrationLoss(awp, 115, 16, 2, m)).toBeCloseTo(115 * 0.16 + (3 / 2.5) * 1.25 * 1.5 + 256 / 48, 12);
  });

  it('stops: weapons with penetration 0 (Zeus), solids thicker than 90 units, after 4 surfaces, and below 1 damage', () => {
    expect(penetrate(weaponDef(table, 'zeus'), [{ enter: 10, exit: 11 }], 50, d, m)).toEqual({ damage: 0, surfaces: 0, stoppedAt: 10 });
    expect(penetrate(ak, [{ enter: 10, exit: 101 }], 200, d, m).stoppedAt).toBe(10);
    const thin = [1, 2, 3, 4, 5].map((k) => ({ enter: k * 10, exit: k * 10 + 0.5 }));
    expect(penetrate(weaponDef(table, 'awp'), thin, 100, d, m)).toMatchObject({ damage: 0, surfaces: 4, stoppedAt: 50 });
    expect(penetrate(weaponDef(table, 'glock'), [{ enter: 10, exit: 30 }], 100, d, m).stoppedAt).toBe(10);
  });

  it('a target in front of the solid is not affected by it', () => {
    expect(penetrate(ak, [{ enter: 300, exit: 310 }], 200, d, m)).toEqual(penetrate(ak, [], 200, d, m));
  });
});

describe('penetration on the Mirage mesh', () => {
  const ak = weaponDef(table, 'ak47');
  const awp = weaponDef(table, 'awp');

  /** The expected damage for one solid by hand: falloff to the surface, the loss, falloff (again, CS's quirk) over the air. */
  function byHand(w: typeof ak, enter: number, thickness: number, target: number): number {
    const d1 = w.damage * Math.pow(w.rangeModifier, enter / 500);
    const lost = d1 * 0.16 + (3 / w.penetration) * 1.25 * 3 + (thickness * thickness) / 24;
    return (d1 - lost) * Math.pow(w.rangeModifier, (target - thickness) / 500);
  }

  it('the B Apartments window frame (x −1824, z 20: wall y 648–660 + frame 660–664, 16 units): AK-47 36 → 13.6, AWP 115 → 80.7', () => {
    const o: Vec3 = { x: -1824, y: 500, z: 20 };
    const spans = query(o, north, 320);
    expect(spans.length).toBe(1);
    expect(spans[0]?.enter).toBeCloseTo(148, 3);
    expect(spans[0]?.exit).toBeCloseTo(164, 3);
    const r = traceBulletDamage(ak, o, north, 320, query, d, m);
    expect(r.surfaces).toBe(1);
    expect(r.damage).toBeCloseTo(byHand(ak, 148, 16, 320), 2);
    expect(r.damage).toBeCloseTo(13.6, 1);
    // Through armor on the chest: 13.6 × 0.775 → 10 HP (vs 27 in the open).
    const hp = Math.trunc(r.damage * 0.775);
    expect(hp).toBe(10);
    expect(bulletDamage(ak, 320, 'chest', 100, true, d).health).toBe(27);
    const ra = traceBulletDamage(awp, o, north, 320, query, d, m);
    expect(ra.damage).toBeCloseTo(byHand(awp, 148, 16, 320), 2);
    expect(ra.damage).toBeCloseTo(80.7, 1);
  });

  it('the Apartments wall between the windows (x −1700: 12 units) costs less than the frame', () => {
    const o: Vec3 = { x: -1700, y: 500, z: 20 };
    const spans = query(o, north, 320);
    expect(spans[0]?.enter).toBeCloseTo(148, 3);
    expect(spans[0]?.exit).toBeCloseTo(160, 3);
    const r = traceBulletDamage(ak, o, north, 320, query, d, m);
    expect(r.damage).toBeCloseTo(byHand(ak, 148, 12, 320), 2);
    expect(r.damage).toBeCloseTo(18.2, 1);
    expect(r.damage).toBeGreaterThan(traceBulletDamage(ak, { x: -1824, y: 500, z: 20 }, north, 320, query, d, m).damage);
  });

  it('the window openings themselves are open: no loss', () => {
    const o: Vec3 = { x: -1790, y: 500, z: 20 };
    expect(query(o, north, 320)).toEqual([]);
    expect(traceBulletDamage(ak, o, north, 320, query, d, m).damage).toBeCloseTo(falloff(36, 0.98, 320, d), 12);
  });

  it("the Apartments hallway door frame on sp4rtan's recorded line to donk (x −1488 … −1504, 16 units): 36 → 13.0 at the recorded 527 u", () => {
    const a: Vec3 = { x: -1068, y: 748, z: -16 };
    const b: Vec3 = { x: -1592, y: 793, z: 16 };
    const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const dir = { x: (b.x - a.x) / L, y: (b.y - a.y) / L, z: (b.z - a.z) / L };
    const spans = query(a, dir, L);
    expect(spans.length).toBe(1);
    expect(spans[0]?.enter).toBeCloseTo(422.33, 1);
    const thick = (spans[0]?.exit ?? 0) - (spans[0]?.enter ?? 0);
    expect(thick).toBeCloseTo(16.08, 1);
    const r = traceBulletDamage(ak, a, dir, L, query, d, m);
    expect(r.damage).toBeCloseTo(byHand(ak, spans[0]?.enter ?? 0, thick, L), 2);
    expect(r.damage).toBeCloseTo(13.0, 1);
    // The recording's 27 / 34 / 26 are full-damage hits (docs/weapons.md): the real line passed beside the frame.
    expect(Math.trunc(r.damage * 0.775)).toBeLessThan(27);
  });
});
