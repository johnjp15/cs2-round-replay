/** H1: src/engine/hitboxes.ts: the posed boxes, the ray tests and the Source angle helpers. */
import { describe, expect, it } from 'vitest';
import { HITBOXES, anglesTo, poseHitboxes, rayCapsule, rayHitboxes, raySphere, viewDir } from '../src/engine/hitboxes';

const scale = { eyeHeight: 64, crouchEyeHeight: 46 };
const pose = { pos: { x: 100, y: 0, z: 0 }, yaw: 180, crouching: false };
const from = { x: 0, y: 0, z: 64 };

function hitAt(z: number, crouching = false, y = 0): string | null {
  const p = { ...pose, crouching };
  const a = anglesTo(from, { x: 100, y, z });
  return rayHitboxes(from, viewDir(a.yaw, a.pitch), 1000, p, scale)?.box.group ?? null;
}

describe('hitboxes (H1)', () => {
  it('fit inside the hull', () => {
    for (const crouching of [false, true]) {
      for (const b of poseHitboxes({ pos: { x: 0, y: 0, z: 0 }, yaw: 37, crouching }, scale)) {
        for (const q of [b.a, b.b]) {
          expect(Math.hypot(q.x, q.y) + b.radius).toBeLessThanOrEqual(16 + 1e-9);
          expect(q.z - b.radius).toBeGreaterThanOrEqual(-1e-9);
          expect(q.z + b.radius).toBeLessThanOrEqual(crouching ? 54 : 72);
        }
      }
    }
  });

  it('a ray at each band height hits that band (the bots aim at these, src/sim2d/ai.ts)', () => {
    expect(hitAt(64)).toBe('head');
    expect(hitAt(48)).toBe('chest');
    expect(hitAt(36)).toBe('stomach');
    expect(hitAt(16)).toBe('leg');
    expect(hitAt(57)).toBe('neck');
    expect(hitAt(75)).toBeNull();
    expect(hitAt(64 * (46 / 64), true)).toBe('head');
    expect(hitAt(60, true)).toBeNull();
    // An arm sticks out to the side of the chest.
    expect(hitAt(50, false, 12)).toBe('arm');
  });

  it('ray-sphere and ray-capsule entries', () => {
    const d = { x: 1, y: 0, z: 0 };
    expect(raySphere({ x: 0, y: 0, z: 0 }, d, 100, { x: 10, y: 0, z: 0 }, 2)).toBeCloseTo(8, 12);
    expect(raySphere({ x: 0, y: 0, z: 0 }, d, 5, { x: 10, y: 0, z: 0 }, 2)).toBeNull();
    expect(raySphere({ x: 20, y: 0, z: 0 }, d, 100, { x: 10, y: 0, z: 0 }, 2)).toBeNull();
    expect(raySphere({ x: 10, y: 0, z: 0 }, d, 100, { x: 10, y: 0, z: 0 }, 2)).toBe(0);
    // Vertical capsule: the side, a cap, a miss.
    const a = { x: 10, y: 0, z: 0 };
    const b = { x: 10, y: 0, z: 10 };
    expect(rayCapsule({ x: 0, y: 0, z: 5 }, d, 100, a, b, 2)).toBeCloseTo(8, 12);
    expect(rayCapsule({ x: 0, y: 0, z: 11 }, d, 100, a, b, 2)).toBeCloseTo(10 - Math.sqrt(3), 12);
    expect(rayCapsule({ x: 0, y: 3, z: 5 }, d, 100, a, b, 2)).toBeNull();
  });

  it('Source angles: yaw counter-clockwise from +x, pitch positive = down', () => {
    const v = viewDir(90, 0);
    expect([v.x, v.y, v.z].map((n) => Math.round(n * 1e9) / 1e9 + 0)).toEqual([0, 1, 0]);
    expect(viewDir(0, 90).z).toBeCloseTo(-1, 12);
    const a = anglesTo({ x: 0, y: 0, z: 10 }, { x: -10, y: 0, z: 0 });
    expect(a.yaw).toBeCloseTo(180, 12);
    expect(a.pitch).toBeCloseTo(45, 12);
    expect(HITBOXES.map((h) => h.group)).toEqual(['head', 'neck', 'chest', 'stomach', 'arm', 'arm', 'leg', 'leg']);
  });
});
