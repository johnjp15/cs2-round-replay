/** KM: the line-of-sight service (src/coach/derive/los.ts) on synthetic meshes. */
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ALL_POINTS_MASK, BODY_POINTS, HEAD_BIT, LosWorld, SmokeField, defaultLosTuning, inFov } from '../../src/coach/derive/los';
import { MapGeometry, encodeGeometry, type GeometryMesh } from '../../src/sim2d/geometry';

/** A mesh from quads (four corners each, integer units). */
function mesh(quads: readonly (readonly [number, number, number])[][]): MapGeometry {
  const verts: number[] = [];
  const tris: number[] = [];
  for (const q of quads) {
    const base = verts.length / 3;
    for (const p of q) verts.push(p[0], p[1], p[2]);
    tris.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const m: GeometryMesh = { quant: 1, verts: Int32Array.from(verts), tris: Int32Array.from(tris) };
  return new MapGeometry(m);
}

/** A floor at z 0 over ±2000, and optionally a wall across x = 0 from y −500 to 500, z 0 → top. */
function world(wallTop: number | null): LosWorld {
  const quads: (readonly [number, number, number])[][] = [
    [
      [-2000, -2000, 0],
      [2000, -2000, 0],
      [2000, 2000, 0],
      [-2000, 2000, 0],
    ],
  ];
  if (wallTop !== null)
    quads.push([
      [0, -500, 0],
      [0, 500, 0],
      [0, 500, wallTop],
      [0, -500, wallTop],
    ]);
  return new LosWorld(mesh(quads));
}

const target = (x: number, duck = 0, yaw = 180) => ({ x, y: 0, z: 0, yaw, duck });

describe('LosWorld', () => {
  it('puts the eye at 64 standing, 46 crouched, linear between (clamped)', () => {
    const w = world(null);
    const t = defaultLosTuning();
    expect(t.eyeHeight).toBe(64);
    expect(t.crouchEyeHeight).toBe(46);
    expect(w.eyePosition({ x: 1, y: 2, z: 10 }, 0)).toEqual({ x: 1, y: 2, z: 74 });
    expect(w.eyePosition({ x: 1, y: 2, z: 10 }, 1).z).toBe(56);
    expect(w.eyePosition({ x: 1, y: 2, z: 10 }, 0.5).z).toBe(65);
    expect(w.eyeHeight(-1)).toBe(64);
    expect(w.eyeHeight(2)).toBe(46);
  });

  it('samples seven body points from the hitboxes, posed by yaw and duck', () => {
    expect(BODY_POINTS.map((p) => p.name)).toEqual(['head', 'upper_chest', 'pelvis', 'shoulder_l', 'shoulder_r', 'knee_l', 'knee_r']);
    const w = world(null);
    const head = w.bodyPoint({ x: 100, y: 50, z: 10, yaw: 90, duck: 0 }, 0);
    expect(head).toEqual({ x: 100, y: 50, z: 73 });
    // Facing north (yaw 90): left is −x.
    const sl = w.bodyPoint({ x: 100, y: 50, z: 10, yaw: 90, duck: 0 }, 3);
    expect(sl.x).toBeCloseTo(89, 9);
    expect(sl.y).toBeCloseTo(50, 9);
    expect(sl.z).toBe(62);
    // Crouched: z scaled by 46/64 (the head is at the crouched eye less one unit).
    expect(w.bodyPoint({ x: 0, y: 0, z: 0, yaw: 0, duck: 1 }, 0).z).toBeCloseTo((63 * 46) / 64, 9);
  });

  it('sees every point in the open and none through a full wall', () => {
    expect(world(null).visible({ x: -300, y: 0, z: 64 }, target(300))).toEqual({ any: true, head: true, mask: ALL_POINTS_MASK });
    expect(world(200).visible({ x: -300, y: 0, z: 64 }, target(300))).toEqual({ any: false, head: false, mask: 0 });
  });

  it('a waist-high wall hides the legs and pelvis but not the head, chest and shoulders', () => {
    // The wall (top 42) stands 30 units in front of the target.
    const w = world(42);
    const v = w.visible({ x: -300, y: 0, z: 64 }, target(30));
    expect(v.head).toBe(true);
    expect(v.mask).toBe(HEAD_BIT | 2 | 8 | 16);
    // The same target crouched behind it: only the head clears (the line to it crosses the wall at 47).
    const c = w.visible({ x: -300, y: 0, z: 64 }, target(30, 1));
    expect(c.mask).toBe(HEAD_BIT);
  });

  it('stops at the first visible point when asked, and counts segment tests', () => {
    const w = world(null);
    const before = w.segmentTests;
    expect(w.visible({ x: -300, y: 0, z: 64 }, target(300), null, 0, ALL_POINTS_MASK, true).mask).toBe(HEAD_BIT);
    expect(w.segmentTests - before).toBe(1);
  });

  it('loads G2GM bytes and rejects gzipped ones', () => {
    const m: GeometryMesh = { quant: 8, verts: Int32Array.from([0, 0, 0, 80, 0, 0, 0, 80, 0]), tris: Int32Array.from([0, 1, 2]) };
    const bin = encodeGeometry(m);
    expect(LosWorld.fromBytes(bin).geometry.triangleCount).toBe(1);
    expect(() => LosWorld.fromBytes(new Uint8Array(gzipSync(bin)))).toThrow(/gzipped/);
  });
});

describe('inFov', () => {
  const eye = { x: 0, y: 0, z: 0 };
  it('is a 90° (4:3) frustum widened to 106.3° at 16:9', () => {
    const at = (yawDeg: number, pitchUpDeg = 0) => ({ x: Math.cos((yawDeg * Math.PI) / 180) * 100, y: Math.sin((yawDeg * Math.PI) / 180) * 100, z: Math.tan((pitchUpDeg * Math.PI) / 180) * 100 });
    expect(inFov(0, 0, eye, at(0))).toBe(true);
    expect(inFov(0, 0, eye, at(180))).toBe(false);
    expect(inFov(0, 0, eye, at(50))).toBe(true); // half width 53.1° at 16:9
    expect(inFov(0, 0, eye, at(-54))).toBe(false);
    expect(inFov(0, 0, eye, at(50), 90, 4 / 3)).toBe(false); // 45° at 4:3
    expect(inFov(0, 0, eye, at(44), 90, 4 / 3)).toBe(true);
    expect(inFov(0, 0, eye, at(0, 35))).toBe(true); // half height 36.9°
    expect(inFov(0, 0, eye, at(0, 38))).toBe(false);
  });
  it('follows the view yaw and pitch (pitch positive = down)', () => {
    expect(inFov(90, 0, eye, { x: 0, y: 100, z: 0 })).toBe(true);
    expect(inFov(90, 0, eye, { x: 100, y: 0, z: 0 })).toBe(false);
    expect(inFov(0, 80, eye, { x: 10, y: 0, z: -100 })).toBe(true);
    expect(inFov(0, -80, eye, { x: 10, y: 0, z: -100 })).toBe(false);
  });
});

describe('SmokeField', () => {
  const w = world(null);
  const a = { x: -400, y: 0, z: 64 };
  const b = { x: 400, y: 0, z: 64 };
  it('blocks a line through a grown smoke, not before it grows or after it expires', () => {
    const f = new SmokeField(w, [{ x: 0, y: 0, z: 2, startTick: 1000, endTick: 2400 }]);
    expect(f.blocks(a, b, 999)).toBe(false);
    expect(f.floods).toBe(0);
    expect(f.blocks(a, b, 1001)).toBe(false); // a voxel or two, not yet opaque
    expect(f.blocks(a, b, 1200)).toBe(true);
    expect(f.blocks(a, b, 2400)).toBe(false);
    expect(f.floods).toBe(1);
    // A line far from it never floods anything new.
    expect(f.blocks({ x: -400, y: 900, z: 64 }, { x: 400, y: 900, z: 64 }, 1200)).toBe(false);
  });
  it('lasts the model lifetime without an expiry, and leaves sight above the cloud', () => {
    const f = new SmokeField(w, [{ x: 0, y: 0, z: 2, startTick: 0, endTick: null }]);
    const t = defaultLosTuning().smoke;
    expect(f.endTick(0)).toBe(Math.round((t.smokeFullSec + t.smokeFadeSec) * 64));
    expect(f.blocks({ x: -400, y: 0, z: 600 }, { x: 400, y: 0, z: 600 }, 300)).toBe(false);
  });
  it('is used by visible()', () => {
    const f = new SmokeField(w, [{ x: 0, y: 0, z: 2, startTick: 0, endTick: 2000 }]);
    expect(w.visible({ x: -400, y: 0, z: 64 }, target(400), f, 300).any).toBe(false);
    expect(w.visible({ x: -400, y: 0, z: 64 }, target(400), f, 2000).any).toBe(true);
  });
});
