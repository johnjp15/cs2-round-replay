/**
 * G2: CS2 collision geometry (src/sim2d/geometry.ts, tools/extract-geometry.ts, docs/geometry.md).
 *
 * - the G2GM format and the committed data: deterministic rebuild from data/source/cs2/, hashes, embed budget;
 * - every query on small synthetic meshes (floor, wall, 45° wall slide, step, slope, ceiling, start-solid);
 * - the Mirage mesh at known spots (the brief's spot checks and their explanations), a wall that blocks, a box top
 *   that is standable, a stair that steps, a drop, the hand-picked blocked sight lines, and the query costs.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  CROUCHING_HULL,
  GeometryError,
  MapGeometry,
  STANDING_HULL,
  STEP_HEIGHT,
  TRACE_SKIN,
  decodeGeometry,
  encodeGeometry,
  type BoxTrace,
  type GeometryMesh,
} from '../src/sim2d/geometry';
import { BIN_PATH, HEIGHT_PATH, MANIFEST_PATH, MESH_PATH, PARAMS, RADAR_PATH, buildMesh, decodePngRgba, readAwmh, standLevels } from '../tools/extract-geometry';

const ROOT = new URL('..', import.meta.url);
const bytes = (rel: string): Uint8Array => new Uint8Array(readFileSync(new URL(rel, ROOT)));
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(readFileSync(new URL(MANIFEST_PATH, ROOT), 'utf8')) as {
  binary: { sha256: string; bytes: number; gzipBase64Bytes: number };
  sources: { file: string; sha256: string }[];
  stats: { triangles: number; vertices: number };
  heightImage: { rgbaSha256: string };
};
const mirage = MapGeometry.fromBytes(bytes(BIN_PATH));

/** A mesh from world-unit triangles (each 9 numbers), quantized like the extractor (1/8 unit). */
function meshOf(tris: number[][]): MapGeometry {
  const verts: number[] = [];
  const idx: number[] = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      idx.push(verts.length / 3);
      verts.push(Math.round((t[k * 3] as number) * 8), Math.round((t[k * 3 + 1] as number) * 8), Math.round((t[k * 3 + 2] as number) * 8));
    }
  }
  return new MapGeometry({ quant: 8, verts: Int32Array.from(verts), tris: Int32Array.from(idx) });
}

/** Two triangles: the rectangle (x0, y0) – (x1, y1) at height z. */
function floorQuad(x0: number, y0: number, x1: number, y1: number, z: number): number[][] {
  return [
    [x0, y0, z, x1, y0, z, x1, y1, z],
    [x0, y0, z, x1, y1, z, x0, y1, z],
  ];
}

/** A vertical quad from (x0, y0) to (x1, y1), z from z0 to z1. */
function wallQuad(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): number[][] {
  return [
    [x0, y0, z0, x1, y1, z0, x1, y1, z1],
    [x0, y0, z0, x1, y1, z1, x0, y0, z1],
  ];
}

/** An axis-aligned closed box (12 triangles). */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[][] {
  return [...floorQuad(x0, y0, x1, y1, z0), ...floorQuad(x0, y0, x1, y1, z1), ...wallQuad(x0, y0, x1, y0, z0, z1), ...wallQuad(x1, y0, x1, y1, z0, z1), ...wallQuad(x1, y1, x0, y1, z0, z1), ...wallQuad(x0, y1, x0, y0, z0, z1)];
}

/** Source's ClipVelocity (overbounce 1): remove the part of v going into the plane. */
function clip(v: [number, number, number], t: BoxTrace): [number, number, number] {
  const d = v[0] * t.normalX + v[1] * t.normalY + v[2] * t.normalZ;
  return [v[0] - d * t.normalX, v[1] - d * t.normalY, v[2] - d * t.normalZ];
}

/** A minimal Source TryPlayerMove: up to 4 bumps, clipping the velocity against each plane hit. Returns the end. */
function slideMove(g: MapGeometry, p: { x: number; y: number; z: number }, vel: [number, number, number], dt: number): { x: number; y: number; z: number; v: [number, number, number] } {
  let pos = { ...p };
  let v = vel;
  let left = dt;
  for (let bump = 0; bump < 4 && left > 0; bump++) {
    const to = { x: pos.x + v[0] * left, y: pos.y + v[1] * left, z: pos.z + v[2] * left };
    const t = g.traceBox(pos, to);
    pos = { x: t.endX, y: t.endY, z: t.endZ };
    if (!t.hit) break;
    left *= 1 - t.fraction;
    v = clip(v, t);
  }
  return { ...pos, v };
}

/** A minimal Source StepMove for one horizontal move: slide; if blocked, try again raised by STEP_HEIGHT, then drop back to the floor. */
function stepMove(g: MapGeometry, p: { x: number; y: number; z: number }, dx: number, dy: number): { x: number; y: number; z: number } {
  const flat = g.traceBox(p, { x: p.x + dx, y: p.y + dy, z: p.z });
  if (!flat.hit) return { x: flat.endX, y: flat.endY, z: flat.endZ };
  const up = g.traceBox(p, { x: p.x, y: p.y, z: p.z + STEP_HEIGHT });
  const raised = { x: up.endX, y: up.endY, z: up.endZ };
  const fwd = g.traceBox(raised, { x: raised.x + dx, y: raised.y + dy, z: raised.z });
  const ahead = { x: fwd.endX, y: fwd.endY, z: fwd.endZ };
  const down = g.traceBox(ahead, { x: ahead.x, y: ahead.y, z: ahead.z - STEP_HEIGHT - 1 });
  return { x: down.endX, y: down.endY, z: down.endZ };
}

describe('G2GM format', () => {
  it('round-trips a canonical mesh and rejects bad files', () => {
    const mesh: GeometryMesh = { quant: 8, verts: Int32Array.from([0, 0, 0, 80, 0, 0, 0, 80, 0, -5, 3, 1000]), tris: Int32Array.from([0, 1, 2, 0, 3, 1]) };
    const enc = encodeGeometry(mesh);
    const dec = decodeGeometry(enc);
    expect([...dec.verts]).toEqual([...mesh.verts]);
    expect([...dec.tris]).toEqual([...mesh.tris]);
    expect(dec.quant).toBe(8);
    expect(() => decodeGeometry(Uint8Array.from([1, 2, 3, 4, 1, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(GeometryError);
    expect(() => decodeGeometry(enc.slice(0, enc.length - 1))).toThrow(/truncated/);
    expect(() => decodeGeometry(Uint8Array.from([...enc, 0]))).toThrow(/trailing/);
    expect(() => encodeGeometry({ quant: 8, verts: mesh.verts, tris: Int32Array.from([1, 0, 2]) })).toThrow(/canonical/);
  });

  it('the committed binary is the deterministic build of the committed CS2 mesh', () => {
    const mesh = bytes(MESH_PATH);
    expect(sha256(mesh)).toBe(manifest.sources.find((s) => s.file === MESH_PATH)?.sha256);
    expect(sha256(bytes(RADAR_PATH))).toBe(manifest.sources.find((s) => s.file === RADAR_PATH)?.sha256);
    const a = encodeGeometry(buildMesh(readAwmh(mesh), PARAMS.quant).mesh);
    const b = encodeGeometry(buildMesh(readAwmh(mesh), PARAMS.quant).mesh);
    expect(sha256(a)).toBe(sha256(b));
    expect(sha256(a)).toBe(manifest.binary.sha256);
    expect(sha256(bytes(BIN_PATH))).toBe(manifest.binary.sha256);
    expect(mirage.triangleCount).toBe(manifest.stats.triangles);
    expect(mirage.vertexCount).toBe(manifest.stats.vertices);
  });

  it('fits the page budget: gzip + base64 well under 1.5 MB', () => {
    const b64 = Math.ceil(gzipSync(bytes(BIN_PATH), { level: 9 }).length / 3) * 4;
    expect(b64).toBe(manifest.binary.gzipBase64Bytes);
    expect(b64).toBeLessThan(1_500_000);
  });

  it('the committed height image matches the manifest (pixels)', () => {
    const img = decodePngRgba(bytes(HEIGHT_PATH));
    expect(img.width).toBe(1024);
    expect(sha256(img.rgba)).toBe(manifest.heightImage.rgbaSha256);
  });
});

describe('queries on synthetic geometry', () => {
  const floor = meshOf(floorQuad(-512, -512, 512, 512, 0));

  it('a hull resting on a floor is free; one cutting into it is blocked', () => {
    expect(floor.hullBlocked(0, 0, 0)).toBe(false);
    expect(floor.hullBlocked(0, 0, 0.5)).toBe(false);
    expect(floor.hullBlocked(0, 0, -0.5)).toBe(true);
    expect(floor.boxBlocked(-16, -16, -72, 16, 16, 0)).toBe(false);
    const f = floor.floorBelow(10, 20, 5);
    expect(f?.z).toBe(0);
    expect(f?.walkable).toBe(true);
    expect(floor.floorBelow(10, 20, -30)).toBeNull();
  });

  it('traceBox: sliding along the floor is free, falling onto it stops TRACE_SKIN above', () => {
    const slide = floor.traceBox({ x: 0, y: 0, z: 0 }, { x: 40, y: 10, z: 0 });
    expect(slide.hit).toBe(false);
    expect(slide.fraction).toBe(1);
    expect(slide.startSolid).toBe(false);
    const fall = floor.traceBox({ x: 0, y: 0, z: 40 }, { x: 0, y: 0, z: -40 });
    expect(fall.hit).toBe(true);
    expect(fall.endZ).toBeCloseTo(TRACE_SKIN, 9);
    expect([fall.normalX, fall.normalY, fall.normalZ]).toEqual([0, 0, 1]);
    const ground = floor.traceBox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -2 });
    expect(ground.hit).toBe(true);
    expect(ground.fraction).toBe(0);
  });

  it('a wall stops a hull TRACE_SKIN short, with the face normal', () => {
    const g = meshOf([...floorQuad(-512, -512, 512, 512, 0), ...wallQuad(100, -200, 100, 200, 0, 200)]);
    const t = g.traceBox({ x: 50, y: 0, z: 0 }, { x: 150, y: 0, z: 0 });
    expect(t.hit).toBe(true);
    expect(t.endX).toBeCloseTo(100 - 16 - TRACE_SKIN, 9);
    expect(Math.abs(t.normalX)).toBeCloseTo(1, 12);
    expect(t.normalX).toBeLessThan(0);
    expect(g.hullBlocked(t.endX, t.endY, t.endZ)).toBe(false);
    // A hull 4 units into the wall: blocked, can back out, can't go deeper.
    expect(g.hullBlocked(88, 0, 0)).toBe(true);
    const out = g.traceBox({ x: 88, y: 0, z: 0 }, { x: 60, y: 0, z: 0 });
    expect(out.startSolid).toBe(true);
    expect(out.hit).toBe(false);
    const deeper = g.traceBox({ x: 88, y: 0, z: 0 }, { x: 95, y: 0, z: 0 });
    expect(deeper.fraction).toBe(0);
    // Sight through the wall is blocked, over it is not; touching an end doesn't count.
    expect(g.lineBlocked({ x: 0, y: 0, z: 64 }, { x: 200, y: 0, z: 64 })).toBe(true);
    expect(g.lineBlocked({ x: 0, y: 0, z: 264 }, { x: 200, y: 0, z: 264 })).toBe(false);
    expect(g.lineBlocked({ x: 0, y: 0, z: 64 }, { x: 100, y: 0, z: 64 })).toBe(false);
  });

  it('slides along a 45° wall without snagging (exact plane normals)', () => {
    // The wall x + y = 300, and a hull running east into it at 250 u/s for 64 ticks.
    const g = meshOf([...floorQuad(-1024, -1024, 1024, 1024, 0), ...wallQuad(1300, -1000, -700, 1000, 0, 200)]);
    let p = { x: 200, y: 0, z: 0 };
    let v: [number, number, number] = [250, 0, 0];
    let first: BoxTrace | null = null;
    for (let tick = 0; tick < 64; tick++) {
      const t = g.traceBox(p, { x: p.x + v[0] / 64, y: p.y + v[1] / 64, z: p.z });
      if (t.hit && first === null) first = t;
      const r = slideMove(g, p, [250, 0, 0], 1 / 64);
      p = { x: r.x, y: r.y, z: r.z };
      v = r.v;
    }
    expect(first?.normalX).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(first?.normalY).toBeCloseTo(-Math.SQRT1_2, 9);
    // Clipped speed along the wall is 250 · cos 45° = 176.8 u/s; after contact the hull keeps all of it.
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(250 * Math.SQRT1_2, 6);
    // Hull corner on the wall: x + y = 300 − 32 (its +x +y corner touches), minus the skin.
    expect(p.x + p.y).toBeGreaterThan(300 - 32 - 0.1);
    expect(p.x + p.y).toBeLessThanOrEqual(300 - 32);
    // No snag: 68 units to reach the wall (17.4 ticks at 250 u/s), then the remaining 46.6 ticks at the full clipped
    // speed, 125 u/s south: y = −46.592 × 125 / 64 = −91.0. A voxel staircase would lose most of this.
    expect(p.y).toBeCloseTo(-91.0, 1);
  });

  it('steps up a step of 16, not a ledge of 20; floorBelow sees the step top', () => {
    const g = meshOf([...floorQuad(-512, -512, 512, 512, 0), ...box(100, -200, 0, 400, 200, 16), ...box(-400, -200, 0, -100, 200, 20)]);
    const at = stepMove(g, { x: 70, y: 0, z: 0 }, 20, 0);
    expect(at.z).toBeCloseTo(16 + TRACE_SKIN, 6);
    expect(at.x).toBeGreaterThan(84);
    expect(g.floorBelow(at.x, at.y, at.z)?.z).toBe(16);
    // A 20-unit ledge: raised by 18 the hull still hits its face, so it drops back to the floor at the face.
    const ledge = stepMove(g, { x: -70, y: 0, z: 0 }, -20, 0);
    expect(ledge.z).toBeCloseTo(TRACE_SKIN, 6);
    expect(ledge.x).toBeCloseTo(-100 + 16 + TRACE_SKIN, 6);
  });

  it('on a slope the footprint rests at its uphill edge; ceilingAbove finds the lowest surface overhead', () => {
    // Plane z = 0.5 x (26.6°, walkable), and a ceiling at 300.
    const g = meshOf([
      [0, -512, 0, 512, -512, 256, 512, 512, 256],
      [0, -512, 0, 512, 512, 256, 0, 512, 0],
      ...floorQuad(0, -512, 512, 512, 300),
    ]);
    const f = g.floorBelow(100, 0, 60, 16, 18);
    expect(f?.z).toBeCloseTo(58, 9); // 0.5 × (100 + 16)
    expect(f?.walkable).toBe(true);
    expect(f?.normalZ).toBeCloseTo(2 / Math.sqrt(5), 9);
    expect(g.ceilingAbove(100, 0, 58)).toBe(300);
    expect(g.ceilingAbove(100, 0, 301)).toBe(Infinity);
    expect(g.hullBlocked(100, 0, 58)).toBe(false);
    expect(g.hullBlocked(100, 0, 57)).toBe(true);
  });

  it('is deterministic: two loads answer bit for bit the same', () => {
    const other = MapGeometry.fromBytes(bytes(BIN_PATH));
    const probes = [
      [-1982, 311, -160],
      [240, -1500, -176],
      [-786, 391, -318],
      [-2364, -674, -168],
    ] as const;
    for (const [x, y, z] of probes) {
      expect(other.floorBelow(x, y, z)).toEqual(mirage.floorBelow(x, y, z));
      expect(other.traceBox({ x, y, z: z + 1 }, { x: x + 3.3, y: y - 2.1, z: z - 5 })).toEqual(mirage.traceBox({ x, y, z: z + 1 }, { x: x + 3.3, y: y - 2.1, z: z - 5 }));
    }
  });
});

describe('Mirage (CS2 collision mesh)', () => {
  const floorAt = (x: number, y: number, z: number): number | null => mirage.floorBelow(x, y, z, 16, STEP_HEIGHT, 64)?.z ?? null;

  it('matches the 2020 heights at the brief’s spot checks', () => {
    expect(floorAt(-1982, 311, -160)).toBe(-160); // B plant
    expect(floorAt(240, -1500, -176)).toBe(-176); // top of T ramp
    expect(floorAt(-1761, 794, -48)).toBe(-48); // Apartments
    expect(Math.abs((floorAt(-786, 391, -318) as number) + 318)).toBeLessThanOrEqual(8); // Tunnel Stairs (a step: −312)
    expect(mirage.surfacesAt(-786, 391).some(([z]) => z === -320)).toBe(true);
    for (const [x, y, z] of [
      [-1982, 311, -160],
      [240, -1500, -176],
      [-1761, 794, -48],
    ] as const)
      expect(mirage.hullBlocked(x, y, floorAt(x, y, z) as number)).toBe(false);
  });

  it('explains the mismatching spots: recorded positions inside walls, not missing floors', () => {
    // Catwalk (−726, 243): the walkway is 64 units west; the spot is in its east wall.
    expect(mirage.hullBlocked(-726, 243, -170.95)).toBe(true);
    expect(Math.abs((floorAt(-790, 243, -172) as number) + 172)).toBeLessThanOrEqual(2);
    expect(mirage.hullBlocked(-790, 243, floorAt(-790, 243, -172) as number)).toBe(false);
    // Shop (−2364, −674): 10–12 units inside the Shop's south wall (y ≈ −662), next to shelving; the floor is −168.
    expect(mirage.surfacesAt(-2364, -674).map(([z]) => z)).toEqual([144]);
    expect(floorAt(-2340, -640, -168)).toBe(-168);
    expect(mirage.hullBlocked(-2340, -640, -168)).toBe(false);
    // Back Alley (−391, 909) = cart's start: 5 units past the north edge of the −84 platform, against its railing.
    expect(mirage.hullBlocked(-391, 909, -83.5)).toBe(true);
    const platform = floorAt(-391, 880, -84) as number;
    expect(Math.abs(platform + 84)).toBeLessThanOrEqual(1);
    expect(mirage.hullBlocked(-391, 880, platform)).toBe(false);
    expect(floorAt(-391, 940, -144)).toBe(-144);
  });

  it('a wall blocks: the Back Alley corridor’s north wall', () => {
    const z = (floorAt(-600, 600, -80) as number) + STEP_HEIGHT; // above the corridor's rising floor edge
    const t = mirage.traceBox({ x: -600, y: 600, z }, { x: -600, y: 680, z });
    expect(t.hit).toBe(true);
    expect(t.normalY).toBeLessThan(-0.99);
    expect(t.endY).toBeGreaterThan(600);
    expect(t.endY).toBeLessThan(632 - 16);
    expect(mirage.hullBlocked(-600, t.endY, z)).toBe(false);
  });

  it('a box top on B site is standable, 70 units above the site floor', () => {
    const f = mirage.floorBelow(-1940, 396, -90, 16, STEP_HEIGHT, 64);
    expect(f?.z).toBeCloseTo(-90.375, 9);
    expect(f?.walkable).toBe(true);
    expect(mirage.hullBlocked(-1940, 396, -90.375)).toBe(false);
    expect(mirage.ceilingAbove(-1940, 396, -90.375)).toBeGreaterThan(-90.375 + 72);
    expect(-90.375 - (floorAt(-1982, 311, -160) as number)).toBeGreaterThan(64); // too high to jump onto from the floor
  });

  it('the Tunnel Stairs can be climbed step by step (Source step-up, 18 units)', () => {
    let p = { x: -827, y: 380, z: floorAt(-827, 380, -336) as number };
    expect(p.z).toBe(-336);
    let maxRise = 0;
    for (let i = 0; i < 16; i++) {
      const next = stepMove(mirage, p, 4, 0);
      maxRise = Math.max(maxRise, next.z - p.z);
      p = next;
    }
    expect(p.x).toBeCloseTo(-827 + 64, 6);
    expect(p.z).toBeGreaterThan(-300);
    expect(maxRise).toBeLessThanOrEqual(STEP_HEIGHT + 1);
  });

  it('a drop: walking off the Balcony lands on the level below, 90 units down', () => {
    const top = floorAt(-2090, 700, -44.5) as number;
    expect(Math.abs(top + 44.5)).toBeLessThan(0.5);
    const walk = mirage.traceBox({ x: -2090, y: 700, z: top + TRACE_SKIN }, { x: -2122, y: 700, z: top + TRACE_SKIN });
    expect(walk.hit).toBe(false);
    const fall = mirage.traceBox({ x: -2122, y: 700, z: top + TRACE_SKIN }, { x: -2122, y: 700, z: top - 200 });
    expect(fall.hit).toBe(true);
    expect(fall.endZ).toBeLessThan(top - 80);
    expect(fall.normalZ).toBeGreaterThan(0.7);
    const below = mirage.floorBelow(-2122, 700, top, 16, 0, 300)?.z as number;
    expect(fall.endZ - below).toBeGreaterThan(0);
    expect(fall.endZ - below).toBeLessThan(0.1);
  });

  it('eye-height sight: every hand-picked blocked pair is blocked by the 3D mesh', () => {
    const labels = JSON.parse(readFileSync(new URL('tests/fixtures/vision-labels.json', ROOT), 'utf8')) as { mustNotSee: { id: string; a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number } }[] };
    const eye = (p: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
      let best = p.z;
      let d = Infinity;
      for (const l of standLevels(mirage, p.x, p.y, p.z + 48, p.z - 64))
        if (Math.abs(l.z - p.z) < d) {
          d = Math.abs(l.z - p.z);
          best = l.z;
        }
      return { x: p.x, y: p.y, z: best + 64 };
    };
    expect(labels.mustNotSee.length).toBe(12);
    for (const m of labels.mustNotSee) expect([m.id, mirage.lineBlocked(eye(m.a), eye(m.b))]).toEqual([m.id, true]);
    // The Apartments windows over B are open (glass is not in the mesh): a line through the west window at eye height.
    expect(mirage.lineBlocked({ x: -1784, y: 700, z: 16 }, { x: -1784, y: 560, z: -40 })).toBe(false);
  });

  it('crouched hull fits where standing does not (under the Tunnel Stairs)', () => {
    const lv = standLevels(mirage, -755, 380, -360, -380);
    expect(lv.length).toBe(1);
    expect(lv[0]?.standing).toBe(false);
    expect(mirage.hullBlocked(-755, 380, lv[0]?.z as number, STANDING_HULL)).toBe(true);
    expect(mirage.hullBlocked(-755, 380, lv[0]?.z as number, CROUCHING_HULL)).toBe(false);
  });

  it('is cheap enough for 10 pawns at 256 ticks/s', () => {
    const pos: { x: number; y: number; z: number }[] = [
      { x: -1982, y: 311, z: -160 },
      { x: 240, y: -1500, z: -176 },
      { x: -1761, y: 794, z: -48 },
      { x: -790, y: 243, z: -170.95 },
      { x: -2340, y: -640, z: -168 },
    ];
    const reps = 20_000;
    let acc = 0;
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) {
      const p = pos[i % pos.length] as { x: number; y: number; z: number };
      acc += mirage.traceBox({ x: p.x, y: p.y, z: p.z + TRACE_SKIN }, { x: p.x + 3, y: p.y + 2, z: p.z + TRACE_SKIN }).fraction;
      acc += mirage.floorBelow(p.x, p.y, p.z + 1)?.z ?? 0;
      acc += mirage.hullBlocked(p.x, p.y, p.z + 0.5) ? 1 : 0;
    }
    const usPerQuery = ((performance.now() - t0) * 1000) / (reps * 3);
    expect(acc).not.toBe(0);
    // Measured ≈ 2 µs in Node 22 (docs/geometry.md, Costs); the bound leaves room for slow CI machines.
    expect(usPerQuery).toBeLessThan(25);
  });
});
