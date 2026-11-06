/**
 * Camera over the radar: zoom and pan. Pure and DOM-free; camera-dom.ts turns wheel, drag and pinch
 * into these calls, and the renderer turns the camera into the `View` every other module uses
 * (input-dom.ts maps the cursor through it, so aiming stays right at any zoom).
 *
 * State: `zoom` (1 = the whole radar fitted inside the canvas, as radar.ts `fitView`) and the radar
 * pixel at the centre of the canvas. clampCamera() keeps the radar covering the canvas once it is
 * bigger than the canvas, and centred while it is smaller.
 */
import type { MapTransform } from '../contracts/index';
import { fitView, type Point2, type View } from './radar';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** Zoom the follow camera switches to when it starts from the full map. */
export const FOLLOW_ZOOM = 3;
/** Wheel zoom per 100 px of deltaY (a mouse notch). */
export const WHEEL_ZOOM_STEP = 1.25;

export interface Camera {
  readonly zoom: number;
  /** Radar pixel at the canvas centre. */
  readonly cx: number;
  readonly cy: number;
}

/** The canvas area the camera fills, in CSS px, and the margin kept around the radar at zoom 1. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly margin: number;
}

/** The whole radar, centred. */
export function fullCamera(map: MapTransform): Camera {
  return { zoom: MIN_ZOOM, cx: map.size / 2, cy: map.size / 2 };
}

export function isFullView(map: MapTransform, cam: Camera): boolean {
  return cam.zoom <= MIN_ZOOM && cam.cx === map.size / 2 && cam.cy === map.size / 2;
}

/** The View for a camera: `fitView` scaled by `zoom` about the camera centre. */
export function cameraView(map: MapTransform, cam: Camera, vp: Viewport): View {
  const base = fitView(map, vp.width, vp.height, vp.margin);
  const scale = base.scale * cam.zoom;
  return { map, scale, ox: vp.width / 2 - cam.cx * scale, oy: vp.height / 2 - cam.cy * scale, side: map.size * scale };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Zoomed in, the radar may leave at most this share of the canvas empty past its edge (per axis). */
export const MAX_EMPTY_SHARE = 0.25;

/**
 * Zoom within MIN_ZOOM..MAX_ZOOM. At the minimum zoom the radar is centred. Zoomed in, on each axis
 * the canvas centre may move until the radar's edge is MAX_EMPTY_SHARE of the canvas in from the
 * canvas edge (or, where the radar is narrower than the canvas, until the radar sticks out that far),
 * one continuous rule at every zoom, so zooming about the cursor keeps the point under it.
 */
export function clampCamera(map: MapTransform, cam: Camera, vp: Viewport): Camera {
  const zoom = clamp(Number.isFinite(cam.zoom) ? cam.zoom : MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
  const scale = fitView(map, vp.width, vp.height, vp.margin).scale * zoom;
  if (!(scale > 0) || zoom <= MIN_ZOOM) return { zoom, cx: map.size / 2, cy: map.size / 2 };
  const axis = (c: number, extent: number): number => {
    const half = extent / 2 / scale;
    const over = 2 * half * MAX_EMPTY_SHARE;
    const lo = Math.min(half, map.size - half) - over;
    const hi = Math.max(half, map.size - half) + over;
    return clamp(Number.isFinite(c) ? c : map.size / 2, lo, hi);
  };
  return { zoom, cx: axis(cam.cx, vp.width), cy: axis(cam.cy, vp.height) };
}

/** Radar pixel under a canvas point. */
export function radarAt(v: View, s: Point2): Point2 {
  return v.scale > 0 ? { x: (s.x - v.ox) / v.scale, y: (s.y - v.oy) / v.scale } : { x: v.map.size / 2, y: v.map.size / 2 };
}

/**
 * Multiply the zoom by `factor`, keeping the radar point under `at` (canvas CSS px) where it is
 * (unless the clamp has to move it at the edges).
 */
export function zoomAt(map: MapTransform, cam: Camera, vp: Viewport, at: Point2, factor: number): Camera {
  const v = cameraView(map, cam, vp);
  const r = radarAt(v, at);
  const zoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const scale = (v.scale / cam.zoom) * zoom;
  if (!(scale > 0)) return clampCamera(map, { ...cam, zoom }, vp);
  return clampCamera(map, { zoom, cx: r.x - (at.x - vp.width / 2) / scale, cy: r.y - (at.y - vp.height / 2) / scale }, vp);
}

/** Drag the map by (dx, dy) CSS px. */
export function panBy(map: MapTransform, cam: Camera, vp: Viewport, dx: number, dy: number): Camera {
  const scale = cameraView(map, cam, vp).scale;
  if (!(scale > 0)) return cam;
  return clampCamera(map, { zoom: cam.zoom, cx: cam.cx - dx / scale, cy: cam.cy - dy / scale }, vp);
}

/**
 * Ease the centre toward `target` (radar px) over `dtMs`: exponential approach with time constant
 * `tauMs`, so the follow camera is smooth and independent of the frame rate.
 */
export function followTarget(map: MapTransform, cam: Camera, vp: Viewport, target: Point2, dtMs: number, tauMs = 90): Camera {
  const k = dtMs <= 0 ? 0 : 1 - Math.exp(-dtMs / tauMs);
  return clampCamera(map, { zoom: cam.zoom, cx: cam.cx + (target.x - cam.cx) * k, cy: cam.cy + (target.y - cam.cy) * k }, vp);
}

/** Zoom factor for a wheel event's deltaY in pixels (negative = zoom in). */
export function wheelFactor(deltaY: number): number {
  return Math.pow(WHEEL_ZOOM_STEP, -clamp(deltaY, -400, 400) / 100);
}
