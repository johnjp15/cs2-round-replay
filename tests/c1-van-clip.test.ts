import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Button } from '../src/contracts/index';
import { STANDING_HULL } from '../src/sim2d/geometry';
import { restingState, stepMove3d, type MoveState } from '../src/sim2d/movement';
import { MIRAGE_CLIP_PATCH, loadMovementGeometry } from '../tools/extract-clips';
import { tuning } from './sim2d-fixtures';

const g = loadMovementGeometry();
const m = tuning.movement;

/** W held for `fwd` ticks, Space pressed at `jumpAt` (crouch in the air after it), `ticks` in all. */
function run(s0: MoveState, yaw: number, ticks: number, jumpAt = -1, fwd = ticks): MoveState {
  let s = s0;
  for (let i = 0; i < ticks; i++) {
    const buttons: Button[] = [];
    if (jumpAt >= 0 && i >= jumpAt && i < jumpAt + 2) buttons.push('JUMP');
    if (jumpAt >= 0 && i >= jumpAt && !s.onGround) buttons.push('DUCK');
    s = stepMove3d(s, { forward: i < fwd ? 1 : 0, side: 0, yaw, pitch: 0, buttons }, 'knife', g, m).state;
  }
  return s;
}

describe('C1: Mirage B van has no invisible clip', () => {
  it('lists the removed prisms in the committed manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('../data/geometry/mirage-clips.json', import.meta.url), 'utf8')) as { patch: { tri: number; ci: number; cj: number }[] };
    expect(manifest.patch.map((p) => [p.tri, p.ci, p.cj])).toEqual(MIRAGE_CLIP_PATCH.map((p) => [p.tri, p.ci, p.cj]));
  });

  it('a pawn can stand on the long roof (it was inside a 512-unit prism)', () => {
    for (const y of [680, 700, 720, 740, 760]) {
      const f = g.floorBelow(-2402, y, 40, STANDING_HULL.halfWidth, 0, 80);
      expect(f, `roof at y ${y}`).not.toBeNull();
      expect(f?.z).toBeGreaterThan(18);
      expect(g.hullBlocked(-2402, y, (f?.z ?? 0) + 0.03, STANDING_HULL), `hull at y ${y}`).toBe(false);
    }
  });

  it('runs south along the cab roof and the roof without stopping at y 808', () => {
    const s = run(restingState({ x: -2388, y: 830, z: 24 }, 270), 270, 70);
    expect(s.pos.y).toBeLessThan(700);
  });

  it('jumps in place on the roof and lands on it; jumps off it to the ground', () => {
    const up = run(restingState({ x: -2402, y: 740, z: 23.02 }, 270), 270, 90, 0, 0);
    expect(up.onGround).toBe(true);
    const off = run(restingState({ x: -2402, y: 740, z: 23.02 }, 180), 180, 160, 6, 80);
    expect(off.pos.z).toBeLessThan(-60);
  });

  it('jumps from the box roof (z -8) up onto the cab (z 24)', () => {
    const s = run(restingState({ x: -2356, y: 832, z: -8 }, 180), 180, 100, 0, 30);
    expect(s.pos.z).toBeGreaterThan(20);
  });
});
