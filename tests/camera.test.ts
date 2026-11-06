import { describe, expect, it } from 'vitest';
import {
  MAX_EMPTY_SHARE,
  MAX_ZOOM,
  MIN_ZOOM,
  cameraView,
  clampCamera,
  followTarget,
  fullCamera,
  panBy,
  radarAt,
  wheelFactor,
  zoomAt,
  type Camera,
  type Viewport,
} from '../src/app/camera';
import { fitView, screenToWorld, worldToScreen } from '../src/app/radar';

const MIRAGE = { posx: -3230, posy: 1713, scale: 5, size: 1024 };
const DESK: Viewport = { width: 1280, height: 780, margin: 4 };
const PHONE: Viewport = { width: 390, height: 640, margin: 4 };

function near(a: number, b: number, eps = 1e-6): void {
  expect(Math.abs(a - b)).toBeLessThan(eps);
}

describe('camera view', () => {
  it('at zoom 1 equals fitView (the whole radar, centred)', () => {
    for (const vp of [DESK, PHONE]) {
      const v = cameraView(MIRAGE, fullCamera(MIRAGE), vp);
      const f = fitView(MIRAGE, vp.width, vp.height, vp.margin);
      near(v.scale, f.scale);
      near(v.ox, f.ox);
      near(v.oy, f.oy);
      near(v.side, f.side);
    }
  });

  it('world → screen → world round-trips at any zoom and pan', () => {
    const cams: Camera[] = [
      { zoom: 1, cx: 512, cy: 512 },
      { zoom: 2.5, cx: 300, cy: 700 },
      { zoom: 8, cx: 410, cy: 180 },
      { zoom: 3.7, cx: 900, cy: 120 },
    ];
    const points = [
      { x: -1180, y: -500 },
      { x: -391, y: 909 },
      { x: 1500, y: -2000 },
      { x: -3230, y: 1713 },
    ];
    for (const vp of [DESK, PHONE]) {
      for (const c of cams) {
        const v = cameraView(MIRAGE, clampCamera(MIRAGE, c, vp), vp);
        for (const p of points) {
          const back = screenToWorld(v, worldToScreen(v, p));
          expect(back).not.toBeNull();
          near(back?.x ?? NaN, p.x, 1e-6);
          near(back?.y ?? NaN, p.y, 1e-6);
        }
      }
    }
  });

  it('puts the camera centre in the middle of the canvas', () => {
    const c = clampCamera(MIRAGE, { zoom: 4, cx: 400, cy: 300 }, DESK);
    const v = cameraView(MIRAGE, c, DESK);
    const centre = radarAt(v, { x: DESK.width / 2, y: DESK.height / 2 });
    near(centre.x, c.cx);
    near(centre.y, c.cy);
  });
});

describe('camera clamp', () => {
  it('keeps zoom within MIN_ZOOM..MAX_ZOOM and centres the radar at the minimum', () => {
    expect(clampCamera(MIRAGE, { zoom: 0.2, cx: 10, cy: 10 }, DESK)).toEqual({ zoom: MIN_ZOOM, cx: 512, cy: 512 });
    expect(clampCamera(MIRAGE, { zoom: 99, cx: 512, cy: 512 }, DESK).zoom).toBe(MAX_ZOOM);
    expect(clampCamera(MIRAGE, { zoom: Number.NaN, cx: Number.NaN, cy: 0 }, DESK)).toEqual({ zoom: MIN_ZOOM, cx: 512, cy: 512 });
  });

  it('zoomed in, the radar leaves at most a quarter of the canvas empty, or sticks out at most a quarter', () => {
    const vp = DESK;
    const q = (extent: number): number => extent * MAX_EMPTY_SHARE + 1e-9;
    for (const zoom of [1.1, 1.6, 2, 4, 8]) {
      for (const far of [-5000, 5000]) {
        const v = cameraView(MIRAGE, clampCamera(MIRAGE, { zoom, cx: far, cy: far }, vp), vp);
        for (const [o, extent] of [
          [v.ox, vp.width],
          [v.oy, vp.height],
        ] as const) {
          if (v.side >= extent) {
            // Covers the axis: empty space on either side at most a quarter.
            expect(o).toBeLessThanOrEqual(q(extent));
            expect(extent - (o + v.side)).toBeLessThanOrEqual(q(extent));
          } else {
            // Narrower than the axis: what sticks out past either edge at most a quarter.
            expect(-o).toBeLessThanOrEqual(q(extent));
            expect(o + v.side - extent).toBeLessThanOrEqual(q(extent));
          }
        }
      }
    }
  });

  it('zoomed in a lot, the same clamp leaves exactly a quarter empty at the extremes', () => {
    const v = cameraView(MIRAGE, clampCamera(MIRAGE, { zoom: 4, cx: -500, cy: 512 }, DESK), DESK);
    near(v.ox, DESK.width * MAX_EMPTY_SHARE, 1e-9);
  });
});

describe('zoom about a point and pan', () => {
  it('keeps the world point under the cursor in place', () => {
    const at = { x: 563.4, y: 330.2 };
    let cam = fullCamera(MIRAGE);
    const before = screenToWorld(cameraView(MIRAGE, cam, DESK), at);
    for (let i = 0; i < 8; i++) cam = zoomAt(MIRAGE, cam, DESK, at, wheelFactor(-100));
    near(cam.zoom, Math.pow(1.25, 8), 1e-9);
    const after = screenToWorld(cameraView(MIRAGE, cam, DESK), at);
    near(after?.x ?? NaN, before?.x ?? NaN, 1e-6);
    near(after?.y ?? NaN, before?.y ?? NaN, 1e-6);
  });

  it('zooming back out ends at the full map', () => {
    let cam: Camera = { zoom: 3, cx: 300, cy: 300 };
    for (let i = 0; i < 20; i++) cam = zoomAt(MIRAGE, cam, PHONE, { x: 40, y: 600 }, wheelFactor(100));
    expect(cam).toEqual(fullCamera(MIRAGE));
  });

  it('dragging moves the map with the finger', () => {
    const cam = clampCamera(MIRAGE, { zoom: 4, cx: 512, cy: 512 }, PHONE);
    const v0 = cameraView(MIRAGE, cam, PHONE);
    const w = screenToWorld(v0, { x: 100, y: 200 });
    const moved = panBy(MIRAGE, cam, PHONE, 30, -20);
    const v1 = cameraView(MIRAGE, moved, PHONE);
    const s = worldToScreen(v1, w ?? { x: 0, y: 0 });
    near(s.x, 130, 1e-6);
    near(s.y, 180, 1e-6);
  });

  it('follow eases toward the target, independent of frame rate', () => {
    const vp = DESK;
    const start = clampCamera(MIRAGE, { zoom: 3, cx: 400, cy: 400 }, vp);
    const target = { x: 500, y: 450 };
    let a = start;
    for (let i = 0; i < 60; i++) a = followTarget(MIRAGE, a, vp, target, 1000 / 60);
    let b = start;
    for (let i = 0; i < 120; i++) b = followTarget(MIRAGE, b, vp, target, 1000 / 120);
    near(a.cx, b.cx, 1e-6);
    near(a.cy, b.cy, 1e-6);
    near(a.cx, 500, 0.01);
    expect(followTarget(MIRAGE, start, vp, target, 0)).toEqual(start);
  });

  it('a wheel notch zooms by 1.25, either way', () => {
    near(wheelFactor(-100), 1.25);
    near(wheelFactor(100), 0.8);
    near(wheelFactor(0), 1);
    near(wheelFactor(-10_000), Math.pow(1.25, 4));
  });
});
