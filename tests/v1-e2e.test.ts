/**
 * V1 (docs/audit/v1-e2e-2026-11-07.md): the small proven fixes of the end-to-end audit.
 *
 * - Ducking in the air does not crop the air wish speed: Source's HandleDuckingSpeedCrop applies the duck factor only
 *   with a ground entity (Source SDK 2013 gamemovement.cpp: `( player->GetFlags() & FL_DUCKING ) &&
 *   ( player->GetGroundEntity() != NULL )`). Before V1 a crouched pawn's air strafe used 0.34 × the wish speed.
 */
import { describe, expect, it } from 'vitest';
import type { Button } from '../src/contracts/index';
import { MapGeometry } from '../src/sim2d/geometry';
import { restingState, stepMove3d, type MoveInput, type MoveState } from '../src/sim2d/movement';
import { tuning } from './sim2d-fixtures';

const m = tuning.movement;
const E = 8000;
const FLAT = new MapGeometry({
  quant: 8,
  verts: Int32Array.from([-E, -E, 0, E, -E, 0, E, E, 0, -E, E, 0].map((v) => v * 8)),
  tris: Int32Array.from([0, 1, 2, 0, 2, 3]),
});
const inp = (side: number, yaw: number, buttons: Button[]): MoveInput => ({ forward: 0, side, yaw, pitch: 0, buttons });
const hs = (s: MoveState): number => Math.hypot(s.vel.x, s.vel.y);

/** Airborne and falling at 250 u/s along +x, 200 u above the floor (no rise friction). */
const falling = (crouching: boolean): MoveState => ({ ...restingState({ x: 0, y: 0, z: 200 }, 0, 0, crouching), onGround: false, vel: { x: 250, y: 0, z: -50 } });

describe('V1: ducking in the air does not slow air strafing (Source HandleDuckingSpeedCrop)', () => {
  it('one air tick with a side key gives the same velocity ducked and standing', () => {
    // Wish 90° to the velocity (side −1 = left = +y when facing +x): the air add is capped at 30 − v·wish = 30.
    const up = stepMove3d(falling(false), inp(-1, 0, []), 'knife', FLAT, m).state;
    const duck = stepMove3d(falling(true), inp(-1, 0, ['DUCK']), 'knife', FLAT, m).state;
    expect(up.vel.y).toBeCloseTo(30, 6);
    expect(duck.vel.y).toBeCloseTo(up.vel.y, 9);
    expect(duck.vel.x).toBeCloseTo(up.vel.x, 9);
  });

  it('a knife falling for 1 s with the best air strafe gains as much ducked as standing', () => {
    const DEG = 180 / Math.PI;
    const run = (duck: boolean): number => {
      let s = falling(duck);
      for (let k = 0; k < 64; k++) {
        const vAng = Math.atan2(s.vel.y, s.vel.x) * DEG;
        s = stepMove3d(s, inp(-1, vAng, duck ? ['DUCK'] : []), 'knife', FLAT, m).state;
        if (s.onGround) break;
      }
      return hs(s);
    };
    expect(run(true)).toBeCloseTo(run(false), 6);
    expect(run(true)).toBeGreaterThan(300);
  });

  it('on the ground the duck factor still caps the speed (AK crouch 215 × 0.34 = 73.1)', () => {
    let s = restingState({ x: 0, y: 0, z: 0 });
    for (let k = 0; k < 64; k++) s = stepMove3d(s, { forward: 1, side: 0, yaw: 0, pitch: 0, buttons: ['DUCK'] }, 'ak47', FLAT, m).state;
    expect(hs(s)).toBeCloseTo(215 * m.crouchFactor, 6);
  });
});
