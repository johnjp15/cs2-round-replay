/** Small vector helpers and a stateless seeded hash RNG (deterministic, JSON-free state). */
import type { Vec3 } from '../../contracts/index';

export const TICK_RATE = 64;
export const DEG = Math.PI / 180;

export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function dist3(a: Vec3, b: Vec3): number {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) + (a.z - b.z) * (a.z - b.z));
}

export function dist2(a: Vec3, b: Vec3): number {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}

export function secToTicks(sec: number): number {
  return Math.round(sec * TICK_RATE);
}

/** Unit forward vector of Source angles (pitch + = down). */
export function forward(pitch: number, yaw: number): Vec3 {
  const p = pitch * DEG;
  const y = yaw * DEG;
  return { x: Math.cos(p) * Math.cos(y), y: Math.cos(p) * Math.sin(y), z: -Math.sin(p) };
}

export function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** murmur3 fmix32. */
function fmix32(x: number): number {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Stateless random number in [0, 1) keyed by (seed, a, b, c): the same key always gives the same number, so the
 * engine state needs no RNG stream (a C# port uses the same uint32 arithmetic).
 */
export function hashRandom(seed: number, a: number, b: number, c: number): number {
  let h = fmix32((seed >>> 0) ^ 0x9e3779b9);
  h = fmix32((h ^ (a >>> 0)) >>> 0);
  h = fmix32((h ^ (Math.imul(b >>> 0, 0x27d4eb2d) >>> 0)) >>> 0);
  h = fmix32((h ^ (Math.imul(c >>> 0, 0x165667b1) >>> 0)) >>> 0);
  return h / 4294967296;
}
