/**
 * G3: 3D movement (Source's PlayerMove on the CS2 mesh, src/sim2d/movement.ts `stepMove3d`; docs/movement.md "3D
 * movement"): jump apex and airtime against sv_jump_impulse / sv_gravity, ground movement equal to the nav model on
 * flat ground, stairs, walls and slides, a jump onto a B-site ledge, the player clips (data/geometry/mirage-clips.bin)
 * keeping a pawn off a wall top, falls with and without damage, crouch jumps, ceilings, and the landing penalty.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Button } from '../src/contracts/index';
import { MapGeometry, STANDING_HULL, TRACE_SKIN } from '../src/sim2d/geometry';
import { TICK_DT, fallDamageFor, restingState, settle, stepMove, stepMove3d, type MoveInput, type MoveState, type MoveStep } from '../src/sim2d/movement';
import { loadMovementGeometry } from '../tools/extract-clips';
import { nav, tuning } from './sim2d-fixtures';

const m = tuning.movement;
const ROOT = new URL('..', import.meta.url);
const mirage = loadMovementGeometry(new URL('.', ROOT).pathname);
const world = MapGeometry.fromBytes(new Uint8Array(readFileSync(new URL('data/geometry/mirage-geometry.bin', ROOT))));

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

function floorQuad(x0: number, y0: number, x1: number, y1: number, z: number): number[][] {
  return [
    [x0, y0, z, x1, y0, z, x1, y1, z],
    [x0, y0, z, x1, y1, z, x0, y1, z],
  ];
}

function wallQuad(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): number[][] {
  return [
    [x0, y0, z0, x1, y1, z0, x1, y1, z1],
    [x0, y0, z0, x1, y1, z1, x0, y0, z1],
  ];
}

const FLAT = meshOf(floorQuad(-4000, -4000, 4000, 4000, 0));

function input(forward: number, yaw: number, buttons: Button[] = []): MoveInput {
  return { forward, side: 0, yaw, pitch: 0, buttons };
}

/** A pawn placed at (x, y, z) and settled on the floor, as a teleport does. */
function placed(g: MapGeometry, x: number, y: number, z: number, yaw = 0): MoveState {
  const s = settle(g, { x, y, z }, false, m);
  return { ...restingState(s.pos, yaw), onGround: s.onGround };
}

interface Run {
  readonly states: MoveState[];
  readonly steps: MoveStep[];
}

/** Steps with the input `plan(tick)` gives; states[0] is the start. */
function run(g: MapGeometry, start: MoveState, ticks: number, plan: (k: number) => MoveInput | null, weapon = 'knife'): Run {
  const states = [start];
  const steps: MoveStep[] = [];
  let s = start;
  for (let k = 0; k < ticks; k++) {
    const r = stepMove3d(s, plan(k), weapon, g, m);
    steps.push(r);
    s = r.state;
    states.push(s);
  }
  return { states, steps };
}

const last = (r: Run): MoveState => r.states[r.states.length - 1] as MoveState;
const maxZ = (r: Run): number => Math.max(...r.states.map((s) => s.pos.z));

describe('the CS2 values (data/tuning.json movement, docs/movement.md)', () => {
  it('are the convar defaults of CS2 build 2000942 and Source SDK 2013', () => {
    expect(m.gravity).toBe(800);
    expect(m.jumpImpulse).toBe(301.99338);
    expect(m.airAccelerate).toBe(12);
    expect(m.airMaxWishSpeed).toBe(30);
    expect(m.stepSize).toBe(18);
    expect(m.standableNormal).toBe(0.7);
    expect([m.staminaMax, m.staminaLandCost, m.staminaRecoveryRate]).toEqual([80, 0.05, 60]);
    expect([m.fallSafeSpeed, m.fallFatalSpeed, m.fallDamageScale]).toEqual([580, 1024, 1]);
    // sv_jump_impulse = sqrt(2 · sv_gravity · 57).
    expect((m.jumpImpulse * m.jumpImpulse) / (2 * m.gravity)).toBeCloseTo(57, 3);
  });
});

describe('jump', () => {
  const s0 = placed(FLAT, 0, 0, 0);
  const jump = run(FLAT, s0, 70, (k) => input(0, 0, k === 0 ? ['JUMP'] : []));

  it('rises 57.0 units (impulse² / 2g, sampled at 64 Hz) and lands after 48 ticks (2v / g = 0.755 s)', () => {
    const apex = maxZ(jump) - s0.pos.z;
    expect(apex).toBeCloseTo(56.9975, 3);
    expect(apex).toBeLessThanOrEqual((m.jumpImpulse * m.jumpImpulse) / (2 * m.gravity));
    expect(jump.steps[0]?.jumped).toBe(true);
    const landTick = jump.steps.findIndex((r) => r.landSpeed > 0);
    expect(landTick + 1).toBe(48);
    expect((landTick + 1) * TICK_DT).toBeLessThanOrEqual((2 * m.jumpImpulse) / m.gravity);
    const landed = jump.states[landTick + 1] as MoveState;
    expect(landed.onGround).toBe(true);
    expect(landed.pos.z).toBeCloseTo(s0.pos.z, 9);
    expect(jump.steps[landTick]?.fallDamage).toBe(0);
    // Every airborne tick is on the parabola from the take-off (positions are exact at tick boundaries).
    for (let k = 1; k <= landTick; k++) {
      const t = k * TICK_DT;
      expect((jump.states[k] as MoveState).pos.z - s0.pos.z).toBeCloseTo(m.jumpImpulse * t - (m.gravity * t * t) / 2, 6);
    }
  });

  it('needs a fresh press: holding JUMP jumps once', () => {
    const held = run(FLAT, s0, 120, () => input(0, 0, ['JUMP']));
    expect(held.steps.filter((r) => r.jumped)).toHaveLength(1);
  });

  it('in the air the wish speed is capped at sv_air_max_wishspeed: a standing jump drifts at most 30 u/s', () => {
    const drift = run(FLAT, s0, 40, (k) => input(1, 0, k === 0 ? ['JUMP'] : []));
    const v = Math.hypot(last(drift).vel.x, last(drift).vel.y);
    expect(v).toBeGreaterThan(29);
    expect(v).toBeLessThanOrEqual(m.airMaxWishSpeed + 1e-9);
  });

  it('a ceiling stops the rise: under a ceiling 100 above the floor the head bumps at 28', () => {
    const g = meshOf([...floorQuad(-500, -500, 500, 500, 0), ...floorQuad(-500, -500, 500, 500, 100)]);
    const r = run(g, placed(g, 0, 0, 0), 60, (k) => input(0, 0, k === 0 ? ['JUMP'] : []));
    expect(maxZ(r)).toBeLessThanOrEqual(100 - STANDING_HULL.height);
    expect(maxZ(r)).toBeGreaterThan(100 - STANDING_HULL.height - 1);
    expect(last(r).onGround).toBe(true);
  });
});

describe('ground movement equals the nav model on flat open ground', () => {
  it('same horizontal positions and velocities every tick (run, walk, stop)', () => {
    const start2d: MoveState = restingState({ x: 1362.5, y: 175, z: nav.zAt({ x: 1362.5, y: 175 }) }, 270);
    const start3d = placed(FLAT, 1362.5, 175, 0, 270);
    let a = start2d;
    let b = start3d;
    for (let k = 0; k < 128; k++) {
      const inp = k < 48 ? input(1, 270) : k < 80 ? input(1, 270, ['WALK']) : null;
      a = stepMove(a, inp, 'ak47', nav, m).state;
      b = stepMove3d(b, inp, 'ak47', FLAT, m).state;
      expect(b.pos.x).toBeCloseTo(a.pos.x, 9);
      expect(b.pos.y).toBeCloseTo(a.pos.y, 9);
      expect(b.vel.x).toBeCloseTo(a.vel.x, 9);
      expect(b.vel.y).toBeCloseTo(a.vel.y, 9);
      expect(b.onGround).toBe(true);
    }
  });
});

describe('stairs, walls and slides', () => {
  it('runs up the Tunnel Stairs at full speed, one step (≤ 18) at a time, never leaving the ground', () => {
    const s0 = placed(mirage, -827, 380, -336);
    expect(s0.pos.z).toBeCloseTo(-336 + TRACE_SKIN, 9);
    const r = run(mirage, s0, 120, () => input(1, 0));
    let rise = 0;
    for (let k = 1; k < r.states.length; k++) {
      rise = Math.max(rise, (r.states[k] as MoveState).pos.z - (r.states[k - 1] as MoveState).pos.z);
      expect((r.states[k] as MoveState).onGround, `tick ${k}`).toBe(true);
    }
    expect(rise).toBeLessThanOrEqual(m.stepSize + TRACE_SKIN);
    expect(last(r).pos.z).toBeGreaterThan(-100);
    expect(last(r).vel.x).toBeCloseTo(250, 6);
    // And back down without leaving the ground.
    const down = run(mirage, last(r), 140, () => input(1, 180));
    expect(down.states.every((s) => s.onGround)).toBe(true);
    expect(last(down).pos.z).toBeLessThan(-360);
  });

  it('is stopped by a wall, and slides along a 45° one (the push into it is clipped away every tick)', () => {
    const wall = meshOf([...floorQuad(-500, -500, 500, 500, 0), ...wallQuad(100, -500, 100, 500, 0, 200)]);
    const r = run(wall, placed(wall, 0, 0, 0), 64, () => input(1, 0));
    expect(last(r).pos.x).toBeCloseTo(100 - STANDING_HULL.halfWidth - TRACE_SKIN, 3);
    expect(last(r).vel.x).toBe(0);
    expect(r.steps.some((s) => s.clipped)).toBe(true);
    const diag = meshOf([...floorQuad(-500, -500, 500, 500, 0), ...wallQuad(0, 200, 400, -200, 0, 200)]);
    const d = run(diag, placed(diag, -100, 0, 0), 128, () => input(1, 0));
    const v = Math.hypot(last(d).vel.x, last(d).vel.y);
    // Velocity along the wall (direction (1, -1)), faster than the clipped run speed (cos 45° × 250) because each tick
    // accelerates east again before the clip, and below the run speed.
    expect(last(d).vel.x + last(d).vel.y).toBeCloseTo(0, 6);
    expect(v).toBeGreaterThan(250 * Math.SQRT1_2);
    expect(v).toBeLessThan(250);
    expect(last(d).pos.x - last(d).pos.y).toBeGreaterThan(0);
  });
});

describe('jumping onto things', () => {
  it('a running jump lands on the ledge west of B site, 33 units above the floor', () => {
    const r = run(mirage, placed(mirage, -2150, 560, -160, 180), 100, (k) => input(1, 180, k === 20 ? ['JUMP'] : []));
    expect(r.states[0]?.pos.z).toBeCloseTo(-158.6, 0);
    expect(last(r).onGround).toBe(true);
    expect(last(r).pos.z).toBeCloseTo(-126.6, 0);
    expect(last(r).pos.x).toBeLessThan(-2300);
  });

  it('a crouch jump clears the 57.8-unit A-site box; a plain jump does not', () => {
    const plain = run(mirage, placed(mirage, -100, -2145, -168), 70, (k) => input(1, 0, k === 14 ? ['JUMP'] : []));
    expect(last(plain).pos.z).toBeCloseTo(-168 + TRACE_SKIN, 3);
    const crouch = run(mirage, placed(mirage, -100, -2145, -168), 70, (k) => input(1, 0, k === 14 ? ['JUMP', 'DUCK'] : k > 14 ? ['DUCK'] : []));
    expect(last(crouch).pos.z).toBeCloseTo(-110.25, 1);
    expect(last(crouch).onGround).toBe(true);
    expect(last(crouch).crouching).toBe(true);
    // The tucked feet: the crouch-jump apex is airDuckLift above the plain one.
    expect(maxZ(crouch) - maxZ(plain)).toBeGreaterThan(m.airDuckLift - 1);
  });

  it('the player clips keep a pawn off a wall top: the raw CS2 mesh lets a jump land on the 29-unit ledge at (-1379, -1128), the clipped one does not', () => {
    const plan = (k: number): MoveInput => input(1, -90, k === 9 ? ['JUMP'] : []);
    const raw = run(world, placed(world, -1379, -1040, -168, -90), 70, plan);
    expect(last(raw).pos.z).toBeGreaterThan(-140);
    expect(last(raw).onGround).toBe(true);
    const clipped = run(mirage, placed(mirage, -1379, -1040, -168, -90), 70, plan);
    expect(last(clipped).pos.z).toBeCloseTo(-168 + TRACE_SKIN, 3);
    expect(clipped.states.every((s) => s.onGround || s.pos.z < -100)).toBe(true);
  });
});

describe('falling', () => {
  it('walking off the Balcony drops about 90 units, no damage', () => {
    const r = run(mirage, placed(mirage, -2090, 700, -44.5, 180), 60, () => input(1, 180));
    const land = r.steps.find((s) => s.landSpeed > 0);
    expect(land).toBeDefined();
    expect(last(r).pos.z).toBeLessThan(-120);
    expect(r.steps.every((s) => s.fallDamage === 0)).toBe(true);
  });

  it("follows Source's fall damage: a walk-off hurts from 222.3 units (the CS:GO mapper's reference: 223 at 64 tick), fatal speed 100 HP", () => {
    const drop = (h: number): MoveStep | undefined => {
      const g = meshOf([...floorQuad(-500, -500, 0, 500, h), ...floorQuad(-500, -500, 500, 500, 0)]);
      const r = run(g, placed(g, -40, 0, h, 0), 120, () => input(1, 0));
      return r.steps.find((s) => s.landSpeed > 0);
    };
    // Landing on airborne tick n: vel.z at its start is −(12.5 (n − 1) + 6.25) (the walk-off tick ends with half a
    // tick of gravity, as in Source), the drop after n ticks is 12.5 / 64 × n (n + 1) / 2, and the 2-unit ground check
    // lands it once it is that close. Tick 47 (≤ 222.3 units) lands at 581.25 u/s, 1.25 over the safe speed: 0 HP.
    expect(drop(213)?.fallDamage).toBe(0);
    expect(drop(222)?.landSpeed).toBeCloseTo(581.25, 6);
    expect(drop(222)?.fallDamage).toBe(0);
    expect(drop(223)?.landSpeed).toBeCloseTo(593.75, 6);
    expect(drop(223)?.fallDamage).toBe(3);
    const big = drop(300);
    expect(big?.fallDamage).toBe(fallDamageFor(big?.landSpeed ?? 0, m));
    expect(big?.fallDamage).toBeGreaterThan(15);
    expect(fallDamageFor(m.fallFatalSpeed, m)).toBe(100);
    expect(fallDamageFor(m.fallSafeSpeed, m)).toBe(0);
  });

  it('a landing slows the pawn down (stamina), recovering at 60 per second', () => {
    const land = run(FLAT, placed(FLAT, 0, 0, 0), 200, (k) => input(1, 0, k === 40 ? ['JUMP'] : []));
    const t = land.steps.findIndex((s) => s.landSpeed > 0);
    const after = land.states[t + 1] as MoveState;
    expect(after.stamina).toBeCloseTo(Math.min(m.staminaMax, m.staminaLandCost * (land.steps[t]?.landSpeed ?? 0)), 6);
    const v = (k: number): number => Math.hypot((land.states[k] as MoveState).vel.x, (land.states[k] as MoveState).vel.y);
    expect(v(t + 3)).toBeLessThan(v(t) - 20);
    expect(v(land.states.length - 1)).toBeCloseTo(250, 3);
  });
});
