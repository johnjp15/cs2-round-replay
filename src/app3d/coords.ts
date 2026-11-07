/**
 * H1: frames for the 3D view (pure, no Three.js import, tested in Node). docs/app3d.md "Frames".
 *
 * The sim is in Source units and Source's world frame: x east, y north, z up (right-handed), yaw counter-clockwise
 * from +x seen from above (0 = east, 90 = north), pitch positive = looking down. Three.js is right-handed with y up.
 * The mapping is the rotation (x, y, z)_Source → (x, z, −y)_Three: Three's +x is east, +y is up, −z is north, so
 * the map seen from above (Three's camera looking down −y) has north up and east right as on the radar, and the
 * winding of every triangle is kept (a proper rotation, determinant +1).
 */

/** A Source point or direction in Three.js coordinates. */
export function toThree(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

/** A Three.js point back in Source coordinates. */
export function fromThree(x: number, y: number, z: number): [number, number, number] {
  return [x, -z, y];
}

/** The Source view direction (unit) for yaw / pitch in degrees, in Three.js coordinates. */
export function viewDirThree(yawDeg: number, pitchDeg: number): [number, number, number] {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  const cp = Math.cos(p);
  return toThree(cp * Math.cos(y), cp * Math.sin(y), -Math.sin(p));
}

/**
 * Three.js Euler angles (order 'YXZ': yaw about +y, then pitch about the camera's x) that make a camera (which looks
 * down its −z) look along Source yaw / pitch. Yaw 0 (east, Three +x) is a turn of −90° about +y; pitch positive
 * (down) is a negative rotation about x.
 */
export function cameraEuler(yawDeg: number, pitchDeg: number): { readonly x: number; readonly y: number } {
  return { x: (-pitchDeg * Math.PI) / 180, y: ((yawDeg - 90) * Math.PI) / 180 };
}

/** Radar pixel of a Source point (CS2 `map_data`: px = (x − pos_x) / scale, py = (pos_y − y) / scale). */
export interface RadarTransform {
  readonly posX: number;
  readonly posY: number;
  readonly scale: number;
}

/** de_mirage (awpy-data map_data.json; the same as the 2020 overview, docs/conventions.md). */
export const MIRAGE_RADAR: RadarTransform = { posX: -3230, posY: 1713, scale: 5 };

export function radarPx(t: RadarTransform, x: number, y: number): { readonly px: number; readonly py: number } {
  return { px: (x - t.posX) / t.scale, py: (t.posY - y) / t.scale };
}
