/** H1: the 3D page's CS2 view (src/app3d/view-cs2.ts, input3d.ts, coords.ts): mouse, FOV, scope, punch, duck, frames. */
import { describe, expect, it } from 'vitest';
import { NO_CONTROLS } from '../src/app/input';
import { cameraEuler, fromThree, toThree, viewDirThree } from '../src/app3d/coords';
import { fpsInput, viewMove } from '../src/app3d/input3d';
import {
  DEFAULT_SENSITIVITY,
  EYE_DUCK,
  EYE_STAND,
  applyMouse,
  cameraAngles,
  duckStep,
  effectiveSensitivity,
  eyeHeightFor,
  firingAngles,
  horizontalFov,
  nextZoom,
  verticalFov,
  zoomFov,
} from '../src/app3d/view-cs2';

describe('CS2 view (H1)', () => {
  it('mouse counts turn the view by sensitivity × 0.022° each, no acceleration; pitch clamps at ±89', () => {
    expect(DEFAULT_SENSITIVITY).toBe(1.25);
    // 1000 counts right at 1.25: 27.5° to the right (yaw decreases), the same in ten steps of 100.
    const one = applyMouse({ yaw: 0, pitch: 0 }, 1000, 0, 1.25);
    let ten = { yaw: 0, pitch: 0 };
    for (let i = 0; i < 10; i++) ten = applyMouse(ten, 100, 0, 1.25);
    expect(one.yaw).toBeCloseTo(-27.5, 10);
    expect(ten.yaw).toBeCloseTo(-27.5, 10);
    // Mouse down = pitch up (positive = looking down in Source).
    expect(applyMouse({ yaw: 0, pitch: 0 }, 0, 100, 2).pitch).toBeCloseTo(4.4, 10);
    expect(applyMouse({ yaw: 0, pitch: 80 }, 0, 10000, 2).pitch).toBe(89);
    expect(applyMouse({ yaw: 0, pitch: -80 }, 0, -10000, 2).pitch).toBe(-89);
    expect(applyMouse({ yaw: 179, pitch: 0 }, -100, 0, 1).yaw).toBeCloseTo(-178.8, 10);
  });

  it('FOV: 90° horizontal at 4:3, vertical ≈ 73.74°, ≈ 106.26° horizontal at 16:9', () => {
    expect(horizontalFov(90, 4 / 3)).toBeCloseTo(90, 10);
    expect(verticalFov(90)).toBeCloseTo(73.7398, 3);
    expect(horizontalFov(90, 16 / 9)).toBeCloseTo(106.2602, 3);
    // A camera with the vertical FOV shows that horizontal FOV at 16:9 (what Three.js does with fov + aspect).
    const h = (2 * Math.atan(Math.tan((verticalFov(90) * Math.PI) / 360) * (16 / 9)) * 180) / Math.PI;
    expect(h).toBeCloseTo(106.2602, 3);
    expect(verticalFov(60)).toBeCloseTo(46.8264, 3);
  });

  it('scope: AWP 40 then 10, SSG 08 40 then 15; zoomed sensitivity scales by FOV / 90 × zoom_sensitivity_ratio', () => {
    expect([zoomFov('awp', 0), zoomFov('awp', 1), zoomFov('awp', 2), zoomFov('ssg08', 2), zoomFov('ak47', 1)]).toEqual([90, 40, 10, 15, 90]);
    expect([nextZoom('awp', 0), nextZoom('awp', 1), nextZoom('awp', 2), nextZoom('ak47', 0)]).toEqual([1, 2, 0, 0]);
    expect(effectiveSensitivity(1.25, 90)).toBe(1.25);
    expect(effectiveSensitivity(2, 40, 1)).toBeCloseTo((2 * 40) / 90, 12);
    expect(effectiveSensitivity(2, 10, 1.5)).toBeCloseTo(2 * (10 / 90) * 1.5, 12);
  });

  it('aim punch: bullets along view + 2 × punch, the camera along view + 0.9 × punch; zero punch = the view', () => {
    expect(firingAngles({ yaw: 10, pitch: 5 })).toEqual({ yaw: 10, pitch: 5 });
    expect(firingAngles({ yaw: 10, pitch: 5 }, { yaw: 1, pitch: -2 })).toEqual({ yaw: 12, pitch: 1 });
    const c = cameraAngles({ yaw: 10, pitch: 5 }, { yaw: 1, pitch: -2 });
    expect(c.yaw).toBeCloseTo(10.9, 12);
    expect(c.pitch).toBeCloseTo(3.2, 12);
  });

  it('the eye eases from 64 to 46 at CS2 m_flDuckSpeed 6.0234375 (0.166 s) both ways (SimpleSpline; M2)', () => {
    expect(eyeHeightFor(0)).toBe(EYE_STAND);
    expect(eyeHeightFor(1)).toBe(EYE_DUCK);
    expect(eyeHeightFor(0.5)).toBeCloseTo(55, 12);
    let d = 0;
    for (let i = 0; i < 5; i++) d = duckStep(d, true, 1 / 60);
    expect(d).toBeCloseTo(5 * (6.0234375 / 60), 9);
    let ticks = 0;
    for (d = 0; d < 1; ticks++) d = duckStep(d, true, 1 / 64);
    expect(ticks).toBe(11); // 10.6 ticks = 0.166 s
    for (ticks = 0; d > 0; ticks++) d = duckStep(d, false, 1 / 64);
    expect(ticks).toBe(11);
  });

  it('WASD is view-relative; the input carries the angles rounded to 6 decimals', () => {
    expect(viewMove({ ...NO_CONTROLS, up: true })).toEqual({ forward: 1, side: 0 });
    expect(viewMove({ ...NO_CONTROLS, up: true, right: true })).toEqual({ forward: 0.707107, side: 0.707107 });
    const i = fpsInput('cart', { ...NO_CONTROLS, left: true, attack: true }, { yaw: 12.3456789, pitch: -3.21 });
    expect(i).toEqual({ id: 'cart', forward: 0, side: -1, yaw: 12.345679, pitch: -3.21, buttons: ['ATTACK'] });
  });

  it('frames: Source (x east, y north, z up) to Three.js (x, z, −y), and the camera Euler matches the view direction', () => {
    expect(toThree(1, 2, 3)).toEqual([1, 3, -2]);
    expect(fromThree(...toThree(1, 2, 3))).toEqual([1, 2, 3]);
    for (const [yaw, pitch] of [[0, 0], [90, 0], [37, 20], [-120, -45]] as const) {
      const e = cameraEuler(yaw, pitch);
      // Three: camera looks along −z, rotated by x (pitch) then y (yaw), order YXZ.
      const d = [-Math.sin(e.y) * Math.cos(e.x), Math.sin(e.x), -Math.cos(e.y) * Math.cos(e.x)];
      const want = viewDirThree(yaw, pitch);
      for (let k = 0; k < 3; k++) expect(d[k]).toBeCloseTo(want[k] as number, 12);
    }
  });
});
