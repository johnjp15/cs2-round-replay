/**
 * Radar and screen transforms. Pure and DOM-free: the debug renderer, the mouse-to-world mapping
 * in input.ts and (later) D2's renderer all use these.
 *
 * World → radar pixels (docs/conventions.md): `px = (x − posx) / scale`, `py = (posy − y) / scale`
 * on the `size` × `size` overview. Mirage: posx −3230, posy 1713, scale 5, size 1024, read from
 * `round.json` `meta.map` (so `px = (x + 3230) / 5`, `py = (1713 − y) / 5`).
 * Radar → screen: the radar square is fitted inside the canvas (contain) and centred.
 */
import type { MapTransform } from '../contracts/index';

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

/** World (Source units, y north) → radar pixels (y down). */
export function worldToRadar(map: MapTransform, p: Point2): Point2 {
  return { x: (p.x - map.posx) / map.scale, y: (map.posy - p.y) / map.scale };
}

/** Radar pixels → world. */
export function radarToWorld(map: MapTransform, r: Point2): Point2 {
  return { x: r.x * map.scale + map.posx, y: map.posy - r.y * map.scale };
}

/** Where the radar square sits on the canvas, in CSS pixels. */
export interface View {
  readonly map: MapTransform;
  /** CSS pixels per radar pixel. */
  readonly scale: number;
  /** CSS pixel position of radar pixel (0, 0). */
  readonly ox: number;
  readonly oy: number;
  /** Side of the drawn radar square in CSS pixels (`map.size × scale`). */
  readonly side: number;
}

/**
 * Fit the radar inside a `width` × `height` CSS-pixel area (contain), centred, leaving `margin`
 * pixels on every side. Degenerate areas give scale 0 and stay finite.
 */
export function fitView(map: MapTransform, width: number, height: number, margin = 0): View {
  const w = Math.max(0, width - 2 * margin);
  const h = Math.max(0, height - 2 * margin);
  const side = Math.min(w, h);
  const scale = map.size > 0 ? side / map.size : 0;
  return { map, scale, ox: (width - side) / 2, oy: (height - side) / 2, side };
}

/** World → CSS pixels on the canvas. */
export function worldToScreen(v: View, p: Point2): Point2 {
  const r = worldToRadar(v.map, p);
  return { x: v.ox + r.x * v.scale, y: v.oy + r.y * v.scale };
}

/** CSS pixels on the canvas → world. Returns null while the view has no size. */
export function screenToWorld(v: View, s: Point2): Point2 | null {
  if (v.scale === 0) return null;
  return radarToWorld(v.map, { x: (s.x - v.ox) / v.scale, y: (s.y - v.oy) / v.scale });
}

/**
 * Screen direction of a yaw (degrees CCW from +x, map y north). Screen y points down, so the
 * y component flips: yaw 90 (north) → (0, −1).
 */
export function yawToScreenDir(yawDeg: number): Point2 {
  const r = (yawDeg * Math.PI) / 180;
  return { x: Math.cos(r), y: -Math.sin(r) };
}
