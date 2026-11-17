/**
 * The shooter's horizontal speed as the server used it. The demo's velocity column lags the positions by one tick:
 * the speed behind a shot (or any action) at row t is the velocity column at row t + 1 (docs/coach/mechanics.md,
 * "Physics check": with it the movement term of `fire_bullets.inaccuracy` matches 97 % of moving bullets; with row t
 * 71 %). Falls back to row t's velocity, then to the position change from row t − 1.
 */
import type { RawDemo } from '../../model/raw';

export function speedAt(raw: RawDemo, t: number, p: number): number {
  const T = raw.ticks;
  const P = raw.players.length;
  const tick = T.tick[t] ?? 0;
  if (t + 1 < T.count && (T.tick[t + 1] ?? 0) === tick + 1) {
    const i = (t + 1) * P + p;
    const vx = T.vx[i] as number;
    const vy = T.vy[i] as number;
    if (Number.isFinite(vx) && Number.isFinite(vy) && T.present[i] === 1) return Math.hypot(vx, vy);
  }
  const i = t * P + p;
  const vx = T.vx[i] as number;
  const vy = T.vy[i] as number;
  if (Number.isFinite(vx) && Number.isFinite(vy)) return Math.hypot(vx, vy);
  if (t > 0) {
    const j = (t - 1) * P + p;
    const dt = (tick - (T.tick[t - 1] ?? 0)) / (raw.header.tickRate || 64);
    if (dt > 0) return Math.hypot((T.x[i] as number) - (T.x[j] as number), (T.y[i] as number) - (T.y[j] as number)) / dt;
  }
  return 0;
}

/** Velocity direction (unit, x/y) behind row t, or null when standing. */
export function velocityDirAt(raw: RawDemo, t: number, p: number): [number, number] | null {
  const T = raw.ticks;
  const P = raw.players.length;
  const r = t + 1 < T.count && (T.tick[t + 1] ?? 0) === (T.tick[t] ?? 0) + 1 ? t + 1 : t;
  const i = r * P + p;
  const vx = T.vx[i] as number;
  const vy = T.vy[i] as number;
  const s = Math.hypot(vx, vy);
  if (!Number.isFinite(s) || s < 1) return null;
  return [vx / s, vy / s];
}
