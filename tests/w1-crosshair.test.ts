/** W1 (#32, #77): the crosshair stays at the screen centre (CS2's cl_crosshair_recoil 0) unless it follows the recoil. */
import { describe, expect, it } from 'vitest';
import { crosshairOffsetPx } from '../src/app3d/input3d';
import { aimOffsetPx } from '../src/app3d/spectate';

describe('crosshair (cl_crosshair_recoil)', () => {
  const cam = { yaw: 10, pitch: -2 };
  const bullet = { yaw: 10.5, pitch: -6 };
  const px = (c: { yaw: number; pitch: number }, a: { yaw: number; pitch: number }) => aimOffsetPx(c, a, 73.74, 1000);
  it('stays at the screen centre by default, whatever the punch', () => {
    expect(crosshairOffsetPx(false, cam, bullet, px)).toEqual({ x: 0, y: 0 });
  });
  it('with "Crosshair follows recoil" it sits where the next bullet goes (above centre in a spray)', () => {
    const o = crosshairOffsetPx(true, cam, bullet, px);
    expect(o.y).toBeLessThan(-20);
    expect(o).toEqual(px(cam, bullet));
    expect(crosshairOffsetPx(true, cam, cam, px)).toEqual({ x: 0, y: 0 });
  });
});
