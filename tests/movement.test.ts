import { describe, expect, it } from 'vitest';
import type { Button } from '../src/contracts/index';
import {
  TICKS_PER_SEC,
  applyFriction,
  maxSpeed,
  runSpeed,
  stepMove,
  wishFromInput,
  type MoveInput,
  type MoveState,
} from '../src/sim2d/movement';
import { WEAPON_IDS } from '../src/contracts/types';
import { nav, tuning } from './sim2d-fixtures';

const m = tuning.movement;
const AK = 215;

/** T Spawn: walkable for > 1,500 units straight south. */
const T_SPAWN = { x: 1362.5, y: 175 };
/** Bombsite B: walkable for 200 units in all eight compass directions. */
const B_OPEN = { x: -1700, y: 400 };

function at(x: number, y: number, yaw = 0): MoveState {
  return { pos: { x, y, z: nav.zAt({ x, y }) }, vel: { x: 0, y: 0, z: 0 }, yaw, pitch: 0, crouching: false, onGround: true, jumpHeld: false, stamina: 0 };
}

function input(forward: number, side: number, yaw: number, buttons: Button[] = []): MoveInput {
  return { forward, side, yaw, pitch: 0, buttons };
}

const speed = (s: MoveState): number => Math.hypot(s.vel.x, s.vel.y);

/** Run `ticks` steps with a fixed input; returns every state (index 0 = start) and whether any step clipped. */
function run(start: MoveState, inp: MoveInput | null, ticks: number, weapon = 'ak47'): { states: MoveState[]; clipped: boolean } {
  const states = [start];
  let clipped = false;
  let s = start;
  for (let i = 0; i < ticks; i++) {
    const r = stepMove(s, inp, weapon, nav, m);
    clipped ||= r.clipped;
    s = r.state;
    states.push(s);
  }
  return { states, clipped };
}

describe('tuning covers every holdable weapon', () => {
  it('has a run speed for each WeaponId', () => {
    for (const w of WEAPON_IDS) expect(m.runSpeedByWeapon[w], w).toBeGreaterThan(0);
    expect(runSpeed('ak47', m)).toBe(AK);
    expect(runSpeed('defuser', m)).toBe(m.runSpeedByWeapon['knife']);
  });
});

describe('acceleration and stopping (AK-47, open ground)', () => {
  it('accelerates from rest toward 215 without exceeding it, then stops with no input', () => {
    const go = run(at(T_SPAWN.x, T_SPAWN.y, 270), input(1, 0, 270), 2 * TICKS_PER_SEC);
    expect(go.clipped).toBe(false);
    const speeds = go.states.map(speed);
    for (const v of speeds) expect(v).toBeLessThanOrEqual(AK + 1e-9);
    expect(speeds[speeds.length - 1]).toBeCloseTo(AK, 9);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeGreaterThanOrEqual((speeds[i - 1] as number) - 1e-9);
    const t95Ticks = speeds.findIndex((v) => v >= 0.95 * AK);
    const t95 = t95Ticks / TICKS_PER_SEC;
    const tFull = speeds.findIndex((v) => v >= AK - 1e-9) / TICKS_PER_SEC;
    // Heading south: x unchanged, y decreasing.
    const last = go.states[go.states.length - 1] as MoveState;
    expect(last.pos.x).toBeCloseTo(T_SPAWN.x, 9);
    expect(last.pos.y).toBeLessThan(T_SPAWN.y - 300);

    const stop = run(last, null, 2 * TICKS_PER_SEC);
    expect(stop.clipped).toBe(false);
    const stopSpeeds = stop.states.map(speed);
    const stopTicks = stopSpeeds.findIndex((v) => v === 0);
    expect(stopTicks).toBeGreaterThan(0);
    const stopTime = stopTicks / TICKS_PER_SEC;
    const end = stop.states[stopTicks] as MoveState;
    const stopDist = Math.hypot(end.pos.x - last.pos.x, end.pos.y - last.pos.y);
    // Never re-accelerates.
    for (const v of stopSpeeds.slice(stopTicks)) expect(v).toBe(0);

    console.log(
      `[movement] AK-47 run ${AK}: 95 % speed after ${t95Ticks} ticks (${t95.toFixed(4)} s), full speed after ${tFull.toFixed(4)} s; ` +
        `stop from ${AK} with no input: ${stopTicks} ticks (${stopTime.toFixed(4)} s), ${stopDist.toFixed(2)} units`,
    );
    expect(t95).toBeGreaterThanOrEqual(0.1);
    expect(t95).toBeLessThanOrEqual(0.8);
    expect(stopTime).toBeGreaterThanOrEqual(0.05);
    expect(stopTime).toBeLessThanOrEqual(0.5);
  });

  it('friction matches the Source formula (stop-speed floor below svStopSpeed)', () => {
    const dt = 1 / TICKS_PER_SEC;
    const fast = applyFriction({ x: 200, y: 0, z: 0 }, m, dt);
    expect(fast.x).toBeCloseTo(200 - 200 * m.svFriction * dt, 12);
    const slow = applyFriction({ x: 0, y: 40, z: 0 }, m, dt);
    expect(slow.y).toBeCloseTo(40 - m.svStopSpeed * m.svFriction * dt, 12);
    expect(applyFriction({ x: 3, y: 0, z: 0 }, m, dt).x).toBe(0);
  });
});

describe('speed caps', () => {
  const cases: [string, Button[], string, number][] = [
    ['run', [], 'ak47', AK],
    ['walk', ['WALK'], 'ak47', AK * m.walkFactor],
    ['crouch', ['DUCK'], 'ak47', AK * m.crouchFactor],
    ['crouch-walk', ['DUCK', 'WALK'], 'ak47', AK * m.crouchFactor * m.walkFactor],
    ['knife run', [], 'knife', 250],
    ['knife walk', ['WALK'], 'knife', 250 * m.walkFactor],
  ];
  it.each(cases)('%s caps at the expected speed', (_name, buttons, weapon, cap) => {
    expect(maxSpeed(weapon, buttons, m)).toBeCloseTo(cap, 9);
    const r = run(at(T_SPAWN.x, T_SPAWN.y, 270), input(1, 0, 270, buttons), 3 * TICKS_PER_SEC, weapon);
    expect(r.clipped).toBe(false);
    const speeds = r.states.map(speed);
    for (const v of speeds) expect(v).toBeLessThanOrEqual(cap + 1e-9);
    expect(speeds[speeds.length - 1]).toBeCloseTo(cap, 6);
    expect((r.states[r.states.length - 1] as MoveState).crouching).toBe(buttons.includes('DUCK'));
  });
});

describe('acceleration scale floor (movement.accelScaleFloor)', () => {
  const crouch = input(1, 0, 270, ['DUCK']);
  const top = (mt: typeof m): number => {
    let s = at(T_SPAWN.x, T_SPAWN.y, 270);
    let best = 0;
    for (let i = 0; i < 3 * TICKS_PER_SEC; i++) {
      s = stepMove(s, crouch, 'ak47', nav, mt).state;
      best = Math.max(best, speed(s));
    }
    return best;
  };

  it('plain Source scaling (floor 0) cannot crouch-walk: accel per tick < the sv_stopspeed friction floor', () => {
    const plain = { ...m, accelScaleFloor: 0 };
    const accelPerTick = (plain.svAccelerate * AK * plain.crouchFactor) / TICKS_PER_SEC;
    const frictionFloor = (plain.svStopSpeed * plain.svFriction) / TICKS_PER_SEC;
    expect(accelPerTick).toBeLessThan(frictionFloor);
    // Peaks at one tick of acceleration and never builds up.
    expect(top(plain)).toBeCloseTo(accelPerTick, 6);
  });

  it('with the tuned floor a crouching pawn reaches its cap, and running is unchanged', () => {
    expect(top(m)).toBeCloseTo(AK * m.crouchFactor, 6);
    const w = wishFromInput(input(1, 0, 0), 'ak47', m);
    expect(w.accelScale).toBe(w.speed);
  });
});

describe('sign conventions', () => {
  it('yaw 90 (north) + side = +1 strafes east; side = -1 west; forward = +1 north', () => {
    const start = at(B_OPEN.x, B_OPEN.y, 90);
    const east = run(start, input(0, 1, 90), 16).states.at(-1) as MoveState;
    expect(east.pos.x - start.pos.x).toBeGreaterThan(10);
    expect(Math.abs(east.pos.y - start.pos.y)).toBeLessThan(1e-9);
    const west = run(start, input(0, -1, 90), 16).states.at(-1) as MoveState;
    expect(west.pos.x - start.pos.x).toBeLessThan(-10);
    const north = run(start, input(1, 0, 90), 16).states.at(-1) as MoveState;
    expect(north.pos.y - start.pos.y).toBeGreaterThan(10);
    expect(Math.abs(north.pos.x - start.pos.x)).toBeLessThan(1e-9);
  });

  it('wish direction: forward = (cos yaw, sin yaw), right = yaw - 90', () => {
    const w = wishFromInput(input(0, 1, 0), 'ak47', m);
    expect(w.dirX).toBeCloseTo(0, 12);
    expect(w.dirY).toBeCloseTo(-1, 12);
    const f = wishFromInput(input(1, 0, 30), 'ak47', m);
    expect(f.dirX).toBeCloseTo(Math.cos(Math.PI / 6), 12);
    expect(f.dirY).toBeCloseTo(Math.sin(Math.PI / 6), 12);
  });
});

describe('analog input', () => {
  it('diagonal (1, 1) is normalized: full run speed at 45° between forward and right', () => {
    const w = wishFromInput(input(1, 1, 90), 'ak47', m);
    expect(w.speed).toBeCloseTo(AK, 9);
    expect(w.dirX).toBeCloseTo(Math.SQRT1_2, 12);
    expect(w.dirY).toBeCloseTo(Math.SQRT1_2, 12);
    const r = run(at(B_OPEN.x, B_OPEN.y, 90), input(1, 1, 90), TICKS_PER_SEC);
    expect(r.clipped).toBe(false);
    const end = r.states.at(-1) as MoveState;
    // North + east in equal parts.
    expect(end.pos.x - B_OPEN.x).toBeCloseTo(end.pos.y - B_OPEN.y, 6);
    const speeds = r.states.map(speed);
    for (const v of speeds) expect(v).toBeLessThanOrEqual(AK + 1e-9);
    expect(speeds.at(-1)).toBeCloseTo(AK, 6);
  });

  it('partial stick scales wish speed: (0.5, 0) -> half run speed', () => {
    expect(wishFromInput(input(0.5, 0, 0), 'ak47', m).speed).toBeCloseTo(AK / 2, 9);
    expect(wishFromInput(input(0, 0, 0), 'ak47', m).speed).toBe(0);
  });
});

describe('walls (Shop)', () => {
  it('a pawn pushed into the Shop wall slides along it and never leaves walkable space', () => {
    // From inside Shop, run south-south-west: the south wall is ~38 units away, then it slides west.
    const start = at(-2300, -662, 250);
    expect(nav.isWalkable(start.pos)).toBe(true);
    let s = start;
    let firstClip = -1;
    let clipTicks = 0;
    for (let i = 0; i < TICKS_PER_SEC; i++) {
      const r = stepMove(s, input(1, 0, 250), 'ak47', nav, m);
      expect(nav.isWalkable(r.state.pos)).toBe(true);
      if (r.clipped) {
        clipTicks++;
        if (firstClip < 0) firstClip = i;
        // Velocity is the actual displacement: never more than the speed before the step.
        expect(speed(r.state)).toBeLessThanOrEqual(AK + 1e-6);
        const dx = r.state.pos.x - s.pos.x;
        const dy = r.state.pos.y - s.pos.y;
        expect(r.state.vel.x).toBeCloseTo(dx * TICKS_PER_SEC, 6);
        expect(r.state.vel.y).toBeCloseTo(dy * TICKS_PER_SEC, 6);
      }
      s = r.state;
    }
    expect(firstClip).toBeGreaterThan(0);
    expect(clipTicks).toBeGreaterThan(5);
    // It hit the wall (moved < 40 units south) but kept sliding west well past where it hit.
    expect(start.pos.y - s.pos.y).toBeLessThan(40);
    expect(start.pos.x - s.pos.x).toBeGreaterThan(40);
    // The blocked (southward) part of the velocity is gone, the tangential part remains.
    const sliding = stepMove(s, input(1, 0, 250), 'ak47', nav, m).state;
    expect(Math.abs(sliding.vel.y)).toBeLessThan(Math.abs(sliding.vel.x));
  });

  it('a pawn teleported off the mesh is not frozen: it moves unclamped until back on walkable space', () => {
    const off = at(-3000, 2000, 0);
    expect(nav.isWalkable(off.pos)).toBe(false);
    const r = run(off, input(1, 0, 0), 8);
    expect((r.states.at(-1) as MoveState).pos.x).toBeGreaterThan(off.pos.x);
  });
});
