/**
 * G6: sight and bullets on the CS2 mesh (src/sim2d/mesh-sight.ts, docs/vision.md). Synthetic meshes for the rules
 * (aim points, crouching, the shared eye-to-eye trace, player clips), then CS2 Mirage: the hand-picked blocked pairs,
 * John's case (donk's AWP kill of Lokier through the Apartments in cart-dies can't happen), the recorded duels at the
 * snapped positions (tools/sight-snap.ts), bullets and grenade effects through the host, and the cost of `sees`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, parseRound, type PlayerId, type Vec3 } from '../src/contracts/index';
import { MapGeometry, combineMeshes, type GeometryMesh } from '../src/sim2d/geometry';
import { aimPitch, traceShot, type LosQuery, type ScanPawn } from '../src/sim2d/hitscan';
import { Sim2DHost } from '../src/sim2d/host';
import { MeshSight, meshSightOptionsFromTuning } from '../src/sim2d/mesh-sight';
import { SEES_AB, SEES_BA, computeSees, type SeePawn } from '../src/sim2d/vision';
import { stepGrenades, type Grenade } from '../src/sim2d/grenades';
import { loadMovementGeometry } from '../tools/extract-clips';
import { loadHarnessData } from '../tools/harness';
import { clearAimPoints } from '../tools/sight-check';
import { recordedDuels } from '../tools/sight-snap';
import { MUST_NOT_SEE } from '../tools/vision-labels';
import { act, eventsOf, input, setupActions } from './combat-fixtures';
import { nav, tuning } from './sim2d-fixtures';

const ROOT = new URL('..', import.meta.url);
const mirage = loadMovementGeometry(new URL('.', ROOT).pathname);
const sightOpts = meshSightOptionsFromTuning(tuning);
const msight = new MeshSight(mirage, sightOpts);

/** A mesh from world-unit triangles (each 9 numbers), quantized like the extractor (1/8 unit). */
function meshData(tris: number[][]): GeometryMesh {
  const verts: number[] = [];
  const idx: number[] = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      idx.push(verts.length / 3);
      verts.push(Math.round((t[k * 3] as number) * 8), Math.round((t[k * 3 + 1] as number) * 8), Math.round((t[k * 3 + 2] as number) * 8));
    }
  }
  return { quant: 8, verts: Int32Array.from(verts), tris: Int32Array.from(idx) };
}

/** A vertical wall from (x0, y0) to (x1, y1), z0 to z1 (two triangles). */
function wall(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): number[][] {
  return [
    [x0, y0, z0, x1, y1, z0, x1, y1, z1],
    [x0, y0, z0, x1, y1, z1, x0, y0, z1],
  ];
}

const floor: number[][] = [
  [-2000, -2000, 0, 2000, -2000, 0, 2000, 2000, 0],
  [-2000, -2000, 0, 2000, 2000, 0, -2000, 2000, 0],
];

const body = (x: number, y: number, z = 0, crouching = false): { pos: Vec3; crouching: boolean } => ({ pos: { x, y, z }, crouching });
const seePawn = (id: PlayerId, x: number, y: number, z: number, yaw: number, extra: Partial<SeePawn> = {}): SeePawn => ({ id, pos: { x, y, z }, yaw, crouching: false, alive: true, blind: false, ...extra });

describe('MeshSight rules (synthetic meshes)', () => {
  it('a full wall hides every aim point; a waist-high wall hides the legs and chest but not the head', () => {
    const full = new MeshSight(new MapGeometry(meshData([...floor, ...wall(0, -100, 0, 100, 0, 200)])), sightOpts);
    expect(full.visible(body(-300, 0), body(300, 0))).toBe(false);
    expect(full.pairSight(body(-300, 0), body(300, 0), true, true)).toBe(0);
    const low = new MeshSight(new MapGeometry(meshData([...floor, ...wall(0, -100, 0, 100, 0, 52)])), sightOpts);
    expect(low.visible(body(-300, 0), body(300, 0))).toBe(true); // eye 64 over the wall to the head 64
    // Crouched behind the 52-unit wall (eye and head 46): neither side sees the other.
    expect(low.pairSight(body(-300, 0, 0, true), body(300, 0, 0, true), true, true)).toBe(0);
    // One crouched: the standing one sees nothing of him (head 46 below the wall top all the way), and he sees nothing either.
    expect(low.pairSight(body(-300, 0), body(30, 0, 0, true), true, true)).toBe(0);
  });

  it('a pillar on the line of sight hides the body axis, not the side points', () => {
    // 6-unit-wide pillar in front of the target: head, chest and legs behind it, the side points (12 out) clear.
    const g = new MeshSight(new MapGeometry(meshData([...floor, ...wall(250, -3, 250, 3, 0, 200)])), sightOpts);
    const pts = g.aimPoints(body(-300, 0), body(300, 0));
    expect(pts.map((p) => p.name)).toEqual(['head', 'chest', 'left', 'right', 'leg']);
    expect(pts.find((p) => p.name === 'left')?.pos).toEqual({ x: 300, y: 12, z: 48 });
    expect(g.visible(body(-300, 0), body(300, 0))).toBe(true);
    // Under a wall whose bottom 22 units are open, 50 units in front of him: seen by the leg point alone.
    const slotMesh = new MapGeometry(meshData([...floor, ...wall(250, -200, 250, 200, 22, 300)]));
    const slot = new MeshSight(slotMesh, sightOpts);
    expect(slot.visible(body(-300, 0), body(300, 0))).toBe(true);
    expect(clearAimPoints(slotMesh, tuning, body(-300, 0), body(300, 0))).toEqual(['leg']);
  });

  it('pairSight shares the eye-to-eye trace and agrees with two separate visible() calls', () => {
    const g = new MeshSight(new MapGeometry(meshData([...floor, ...wall(0, -100, 0, 100, 0, 52), ...wall(400, 50, 420, 50, 0, 200)])), sightOpts);
    const spots = [body(-300, 0), body(300, 0), body(300, 0, 0, true), body(-50, 80, 30), body(500, 60), body(-310, 10, 0, true)];
    for (const a of spots) {
      for (const b of spots) {
        if (a === b) continue;
        const bits = g.pairSight(a, b, true, true);
        expect((bits & SEES_AB) !== 0).toBe(g.visible(a, b));
        expect((bits & SEES_BA) !== 0).toBe(g.visible(b, a));
        expect(g.pairSight(a, b, true, false)).toBe(bits & SEES_AB);
        expect(g.pairSight(a, b, false, true)).toBe(bits & SEES_BA);
      }
    }
    // Clear eye to eye: one trace for both directions.
    const before = g.traces;
    expect(g.pairSight(body(-300, 300), body(300, 300), true, true)).toBe(SEES_AB | SEES_BA);
    expect(g.traces - before).toBe(1);
  });

  it('player clips stop movement, not sight or bullets (combineMeshes marks them movement-only)', () => {
    const world = meshData(floor);
    const clips = meshData(wall(0, -100, 0, 100, 0, 512));
    const g = new MapGeometry(combineMeshes(world, clips));
    expect(g.sightTriangleCount).toBe(2);
    expect(g.traceLine(-300, 0, 64, 300, 0, 64)).toBeLessThan(1);
    expect(g.traceSight(-300, 0, 64, 300, 0, 64)).toBe(1);
    expect(new MeshSight(g, sightOpts).pairSight(body(-300, 0), body(300, 0), true, true)).toBe(SEES_AB | SEES_BA);
    expect(() => new MapGeometry({ ...world, sightTriangles: 3 })).toThrow(/sightTriangles/);
  });

  it('traceSight is traceLine on the world triangles (CS2 Mirage, 2,000 segments between recorded positions)', () => {
    const w = MapGeometry.fromBytes(new Uint8Array(readFileSync(new URL('data/geometry/mirage-geometry.bin', ROOT))));
    const round = parseRound(readFileSync(new URL('data/round.json', ROOT), 'utf8'));
    const pts = PLAYER_IDS.flatMap((id) => (round.tracks[id]?.samples ?? []).filter((_, i) => i % 7 === 0).map((s) => ({ x: s.x, y: s.y, z: s.z + 64 })));
    let blocked = 0;
    for (let i = 0; i < 2000; i++) {
      const a = pts[(i * 37) % pts.length] as Vec3;
      const b = pts[(i * 101 + 13) % pts.length] as Vec3;
      const f = mirage.traceSight(a.x, a.y, a.z, b.x, b.y, b.z);
      expect(f).toBe(w.traceLine(a.x, a.y, a.z, b.x, b.y, b.z));
      if (f < 1) blocked++;
    }
    expect(blocked).toBeGreaterThan(500);
  });
});

describe('CS2 Mirage: what sees what', () => {
  it('the hand-picked blocked pairs (tests/fixtures/vision-labels.json) are blocked, every aim point, both ways', () => {
    for (const m of MUST_NOT_SEE) expect([m.id, msight.pairSight(body(m.a.x, m.a.y, m.a.z), body(m.b.x, m.b.y, m.b.z), true, true)]).toEqual([m.id, 0]);
  });

  it("John's case: donk in Back Alley can't see Lokier at the Truck through the Apartments (cart-dies, tick 721)", () => {
    const donk = { x: -296, y: 558, z: -79 };
    const lokier = { x: -2271, y: 798, z: -124 };
    expect(msight.pairSight(body(donk.x, donk.y, donk.z), body(lokier.x, lokier.y, lokier.z), true, true)).toBe(0);
    // A perfect AWP headshot at him: the bullet hits the Apartments' walls, not Lokier.
    const yaw = (Math.atan2(lokier.y - donk.y, lokier.x - donk.x) * 180) / Math.PI;
    const shooter: ScanPawn = { id: 'donk', team: 'T', pos: donk, yaw, pitch: aimPitch({ pos: donk, crouching: false }, { pos: lokier, crouching: false }, 'head', tuning.damage), crouching: false, alive: true };
    const victim: ScanPawn = { id: 'lokier', team: 'CT', pos: lokier, yaw: 0, pitch: 0, crouching: false, alive: true };
    const mesh: LosQuery = { lineOfSight: () => true, shotClear: (a, b) => msight.clear(a, b) };
    expect(traceShot(shooter, [shooter, victim], mesh, tuning.damage)).toBeNull();
    // Without the wall test the same shot is a headshot (so it is the geometry that stops it).
    expect(traceShot(shooter, [shooter, victim], { lineOfSight: () => true }, tuning.damage)).toMatchObject({ victim: 'lokier', hitgroup: 'head' });
  });

  it('…and through the host: no sees either way, and an AWP held on his head for 2 s never damages him', () => {
    const roster = [
      { id: 'donk' as const, team: 'T' as const },
      { id: 'lokier' as const, team: 'CT' as const },
    ];
    const host = new Sim2DHost(nav, tuning, roster, null, null, mirage);
    host.apply(act([...setupActions('donk', { x: -296, y: 558, z: -79 }, 0, 'awp'), ...setupActions('lokier', { x: -2271, y: 798, z: -124 }, 0, 'ssg08')]));
    host.tick();
    const o = host.observe();
    const d = o.pawns.find((p) => p.id === 'donk')?.pos as Vec3;
    const l = o.pawns.find((p) => p.id === 'lokier')?.pos as Vec3;
    const yaw = (Math.atan2(l.y - d.y, l.x - d.x) * 180) / Math.PI;
    const pitch = aimPitch({ pos: d, crouching: false }, { pos: l, crouching: false }, 'head', tuning.damage);
    let shots = 0;
    for (let k = 0; k < 128; k++) {
      host.apply(act([], [input('donk', yaw, pitch, ['ATTACK']), input('lokier', yaw + 180, 0)]));
      host.tick();
      const ob = host.observe();
      shots += eventsOf(ob, 'shot').length;
      expect(eventsOf(ob, 'damage')).toEqual([]);
      expect(ob.pawns.every((p) => p.sees.length === 0)).toBe(true);
    }
    expect(shots).toBeGreaterThan(0);
  });

  it('the Apartments window over B: Lokier sees cart close to it, not at the back of the room behind the sill', () => {
    const lokier = body(-2128, 470, -156);
    expect(msight.pairSight(lokier, body(-1712, 700, -48), true, true)).toBe(SEES_AB | SEES_BA);
    expect(msight.pairSight(lokier, body(-1712, 700, -48, true), true, true)).toBe(SEES_AB | SEES_BA);
    // The recording's spot at the hit, 100 units further back: the sill (z -24) is above every line.
    expect(msight.pairSight(lokier, body(-1764, 800, -48), true, true)).toBe(0);
  });

  it('every recorded duel is in sight at every sample at the snapped positions (tools/sight-snap.ts, pass 5)', () => {
    const data = loadHarnessData();
    const duels = recordedDuels(data.recorded ?? data.round);
    expect(duels.map((d) => `${d.a}-${d.b}`)).toEqual(['eradicate-lokier', 'cart-lokier', 'donk-sp4rtan', 'cart-sp4rtan']);
    for (const d of duels) {
      const ta = data.round.tracks[d.a]?.samples ?? [];
      const tb = data.round.tracks[d.b]?.samples ?? [];
      for (let i = Math.ceil(d.t0 * 10 - 1e-9); i <= Math.floor(d.t1 * 10 + 1e-9); i++) {
        const a = ta[i] as { x: number; y: number; z: number };
        const b = tb[i] as { x: number; y: number; z: number };
        expect([d.label, i, msight.pairSight(body(a.x, a.y, a.z), body(b.x, b.y, b.z), true, true)]).toEqual([d.label, i, SEES_AB | SEES_BA]);
      }
    }
  });

  it('sight-check re-traces agree with MeshSight (independent aim points)', () => {
    const cases = [
      [body(-2128, 470, -156), body(-1712, 700, -48)],
      [body(-2128, 470, -156), body(-1764, 800, -48)],
      [body(-296, 558, -79), body(-2271, 798, -124)],
      [body(-1074, 742, -80), body(-1593, 793, -48)],
    ] as const;
    for (const [a, b] of cases) expect(clearAimPoints(mirage, tuning, a, b).length > 0).toBe(msight.visible(a, b));
  });
});

describe('grenades on the mesh', () => {
  const flash = (center: Vec3): Grenade => ({ seq: 1, kind: 'flash', thrower: 'cart', team: 'T', throwTick: 0, from: center, to: center, vz: 0, landTick: 0, popTick: 10, phase: 'flying', center: null, untilTick: 10, fireSteps: 0 });
  const world = (meshSight: MeshSight | null) => ({
    nav:
      meshSight === null
        ? { lineOfSight: () => true, zAt: () => 0 }
        : { lineOfSight: () => true, zAt: () => 0, effectClear: (a: Vec3, b: Vec3) => meshSight.clear(a, b), effectOrigin: (p: Vec3, landed: boolean) => meshSight.effectOrigin(p, landed) },
    pawns: [{ id: 'sp4rtan' as const, team: 'CT' as const, pos: { x: 300, y: 0, z: 0 }, yaw: 180, alive: true }],
    grenades: tuning.grenades,
    damage: tuning.damage,
    ai: tuning.ai,
  });

  it('a flash behind a wall does not blind (the 2D test alone would)', () => {
    const g = new MeshSight(new MapGeometry(meshData([...floor, ...wall(150, -200, 150, 200, 0, 300)])), sightOpts);
    expect(stepGrenades([flash({ x: 0, y: 0, z: 2 })], 10, world(g)).outcomes.filter((o) => o.type === 'blind')).toEqual([]);
    expect(stepGrenades([flash({ x: 0, y: 0, z: 2 })], 10, world(null)).outcomes.filter((o) => o.type === 'blind')).toHaveLength(1);
    const open = new MeshSight(new MapGeometry(meshData(floor)), sightOpts);
    expect(stepGrenades([flash({ x: 0, y: 0, z: 2 })], 10, world(open)).outcomes.filter((o) => o.type === 'blind')).toHaveLength(1);
  });

  it('a landed grenade traces from the CS2 floor under it, not from inside a step the nav models low', () => {
    const step = new MeshSight(new MapGeometry(meshData([...floor, [-50, -50, 20, 50, -50, 20, 50, 50, 20], [-50, -50, 20, 50, 50, 20, -50, 50, 20]])), sightOpts);
    expect(step.effectOrigin({ x: 0, y: 0, z: 4 }, true)).toEqual({ x: 0, y: 0, z: 22 });
    expect(step.effectOrigin({ x: 0, y: 0, z: 4 }, false)).toEqual({ x: 0, y: 0, z: 4 });
  });
});

describe('cost of sees on the mesh', () => {
  it('10 viewers × 9 targets at the snapped positions every 0.5 s of the round: < 0.5 ms per tick (printed)', () => {
    const data = loadHarnessData();
    const frames: SeePawn[][] = [];
    for (let t = 0; t <= 70; t += 0.5) {
      frames.push(
        PLAYER_IDS.map((id) => {
          const ss = data.round.tracks[id]?.samples ?? [];
          const i = Math.max(0, Math.min(ss.length - 1, Math.round(t * 10)));
          const s = ss[i] ?? { x: 0, y: 0, z: 0 };
          const q = ss[Math.min(ss.length - 1, i + 5)] ?? s;
          const yaw = q.x === s.x && q.y === s.y ? (i * 47) % 360 : (Math.atan2(q.y - s.y, q.x - s.x) * 180) / Math.PI;
          return seePawn(id, s.x, s.y, s.z, yaw);
        }),
      );
    }
    const noSmoke = { smokeBlocks: (): boolean => false };
    const opts = { fovDeg: tuning.ai.fovDeg, eyeHeight: tuning.damage.eyeHeight, crouchEyeHeight: tuning.damage.crouchEyeHeight };
    for (const f of frames) computeSees(f, msight, noSmoke, opts);
    const reps = 5;
    const traces0 = msight.traces;
    const full0 = msight.fullTraces;
    const t0 = performance.now();
    let seen = 0;
    for (let r = 0; r < reps; r++) for (const f of frames) seen += computeSees(f, msight, noSmoke, opts).reduce((a, x) => a + x.length, 0);
    const perTick = (performance.now() - t0) / (reps * frames.length);
    const traces = (msight.traces - traces0) / (reps * frames.length);
    const full = (msight.fullTraces - full0) / (reps * frames.length);
    console.log(`[sight3d] sees on the mesh: ${perTick.toFixed(3)} ms per tick (10 × 9, ${frames.length} frames), ${traces.toFixed(1)} segment tests per tick, ${full.toFixed(1)} full traces, ${(seen / (reps * frames.length)).toFixed(1)} entries per tick`);
    expect(perTick).toBeLessThan(0.5);
  });
});
