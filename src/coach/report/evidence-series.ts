/**
 * Evidence series (K5): the short channels the duel view and the spray plot draw, built at analysis time from K2's
 * combat tables so a report reopened from the library still shows them (docs/coach/report.md "Viewers",
 * docs/coach/contracts.md "Evidence series").
 *
 * - **duel** (`axis: 'tick'`, the evidence window, every grid row): `speed` (the velocity column one row late, as the
 *   server used it: docs/coach/mechanics.md) with the accurate-speed line (`moveFraction` × the weapon's max speed in
 *   the mode fired) as `ref`; `angle` from the crosshair (view) to the target's head while he is alive; `duck`
 *   (only when the player crouched); and on the bullet ticks `inaccuracy` (the game's own, mrad), `standing` (what the
 *   same bullet would have had standing) and `shots` (marks `hit` / `miss`).
 * - **spray** (`axis: 'bullet'`, the spray at the evidence's focus): `aim_x` / `aim_y` (the recoil-compensated aim,
 *   i.e. the bullet's zero-spread direction = view + 2 × punch, relative to the target's chest; x right, y up; marks
 *   `hit`, `on` (crossed the body, no damage) or `miss`), `view_x` / `view_y` (where the crosshair was) and
 *   `ideal_x` / `ideal_y` (where the crosshair had to be for the bullet to land on the chest: the weapon's pattern from
 *   data/weapons.json, or the bullet's own measured kick when the weapon has no pattern or fires in its second mode,
 *   whose pattern the table does not hold).
 *
 * Deterministic; values rounded (speed 0.1 u/s, angles 0.01°, mrad 0.01).
 */
import type { AnalysisContext } from '../analyze/context';
import { defaultLosTuning } from '../derive/los';
import { SHOTS, SPRAYS, type ShotRow } from '../derive/aim/index';
import { angleToPoint, bodyPoints, crouchScale, dirOf, wrap180, type V3 } from '../derive/aim/geom';
import { AIM_TUNING } from '../derive/aim/tuning';
import { speedAt } from '../derive/movement/speed';
import { FLAG, rowAtOrAfter } from '../model/raw';
import { SERIES, type Evidence, type EvidenceSeries, type Finding } from '../model/report';

const r1 = (x: number): number => (Number.isFinite(x) ? Math.round(x * 10) / 10 : NaN);
const r2 = (x: number): number => (Number.isFinite(x) ? Math.round(x * 100) / 100 : NaN);

/** The user's bullet at `tick` (the evidence's focus), else his first bullet inside the window. */
function focusShot(shots: readonly ShotRow[], p: number, ev: Evidence): ShotRow | null {
  let first: ShotRow | null = null;
  for (const s of shots) {
    if (s.p !== p || s.tick < ev.tick0 || s.tick > ev.tick1) continue;
    if (s.tick === ev.focus) return s;
    first ??= s;
  }
  return first;
}

/** Duel channels over the evidence window. */
export function duelSeries(ctx: AnalysisContext, ev: Evidence): EvidenceSeries[] {
  const p = ev.players[0];
  if (p === undefined) return [];
  const target = ev.players[1] ?? -1;
  const T = ctx.raw.ticks;
  const P = ctx.P;
  const { shots } = ctx.table(SHOTS);
  const focus = focusShot(shots, p, ev);
  const r0 = rowAtOrAfter(T, ev.tick0);
  const ticks: number[] = [];
  const speed: number[] = [];
  const angle: number[] = [];
  const duck: number[] = [];
  const los = defaultLosTuning();
  for (let r = r0; r < T.count && (T.tick[r] ?? 0) <= ev.tick1; r++) {
    const i = r * P + p;
    ticks.push(T.tick[r] ?? 0);
    if (T.present[i] !== 1 || ((T.flags[i] ?? 0) & FLAG.alive) === 0) {
      speed.push(NaN);
      angle.push(NaN);
      duck.push(NaN);
      continue;
    }
    speed.push(r1(speedAt(ctx.raw, r, p)));
    const d = (T.duck[i] ?? 0) / 255;
    duck.push(r2(d));
    const j = r * P + target;
    if (target >= 0 && T.present[j] === 1 && ((T.flags[j] ?? 0) & FLAG.alive) !== 0) {
      const eye: V3 = [T.x[i] ?? 0, T.y[i] ?? 0, (T.z[i] ?? 0) + los.eyeHeight * crouchScale(d)];
      const head = bodyPoints([T.x[j] ?? 0, T.y[j] ?? 0, T.z[j] ?? 0], (T.duck[j] ?? 0) / 255, AIM_TUNING.body)[0];
      angle.push(r2(angleToPoint(eye, dirOf(T.pitch[i] ?? 0, T.yaw[i] ?? 0), head)));
    } else angle.push(NaN);
  }
  const mine = shots.filter((s) => s.p === p && s.tick >= ev.tick0 && s.tick <= ev.tick1);
  const out: EvidenceSeries[] = [];
  const threshold = focus ? focus.maxSpeed * AIM_TUNING.counterStrafe.moveFraction : NaN;
  out.push({
    name: SERIES.speed, label: 'Speed', unit: 'u/s', axis: 'tick', x: ticks, values: speed,
    ...(Number.isFinite(threshold) ? { ref: { value: r1(threshold), label: 'accurate below' } } : {}),
  });
  if (target >= 0 && angle.some((a) => Number.isFinite(a))) out.push({ name: SERIES.angle, label: 'Crosshair to head', unit: '°', axis: 'tick', x: [...ticks], values: angle });
  if (duck.some((d) => d > 0.05)) out.push({ name: SERIES.duck, label: 'Crouch', unit: '0–1', axis: 'tick', x: [...ticks], values: duck });
  if (mine.length > 0) {
    const x = mine.map((s) => s.tick);
    out.push({ name: SERIES.inaccuracy, label: 'Inaccuracy', unit: 'mrad', axis: 'tick', x, values: mine.map((s) => r2(s.inaccuracy * 1000)) });
    out.push({ name: 'standing', label: 'Same shot standing', unit: 'mrad', axis: 'tick', x: [...x], values: mine.map((s) => r2(s.stillInaccuracy * 1000)) });
    out.push({ name: SERIES.shots, label: 'Shots', unit: 'count', axis: 'tick', x: [...x], values: mine.map(() => 1), marks: mine.map((s) => (s.hitEnemy ? 'hit' : 'miss')) });
  }
  return out;
}

/** Spray channels for the spray at the evidence's focus (empty when it has no measured spray). */
export function spraySeries(ctx: AnalysisContext, ev: Evidence): EvidenceSeries[] {
  const p = ev.players[0];
  if (p === undefined) return [];
  const { shots } = ctx.table(SHOTS);
  const focus = focusShot(shots, p, ev);
  if (focus === null) return [];
  const spray = ctx.table(SPRAYS).find((s) => s.burst === focus.burst);
  if (spray === undefined || spray.bullets.length === 0) return [];
  const n = spray.bullets.map((b) => b.n);
  const rows = spray.bullets.map((b) => shots[b.shot]);
  const pattern = focus.mode === 0 ? ctx.weapons.sprays[focus.wid] : undefined;
  const fromPattern = pattern !== undefined && pattern.length >= Math.max(...n);
  const kick = (s: ShotRow | undefined): [number, number] => (s ? [s.pitch - s.viewPitch, wrap180(s.yaw - s.viewYaw)] : [NaN, NaN]);
  const idealX: number[] = [];
  const idealY: number[] = [];
  spray.bullets.forEach((b, k) => {
    // Bullet = view + offset (pitch + down, yaw + left): on the chest when the view sits at (yaw, pitch) of the offset.
    const off = fromPattern ? (pattern?.[b.n - 1] ?? [NaN, NaN]) : kick(rows[k]);
    idealX.push(r2(off[1]));
    idealY.push(r2(off[0]));
  });
  const viewX = spray.bullets.map((b, k) => r2(b.right + kick(rows[k])[1]));
  const viewY = spray.bullets.map((b, k) => r2(b.up + kick(rows[k])[0]));
  const marks = spray.bullets.map((b) => (b.hit ? 'hit' : b.onTarget ? 'on' : 'miss'));
  const src = fromPattern ? 'pattern' : 'measured kick';
  return [
    { name: SERIES.aimX, label: 'Aim, right of the target', unit: '°', axis: 'bullet', x: n, values: spray.bullets.map((b) => r2(b.right)), marks },
    { name: SERIES.aimY, label: 'Aim, above the target', unit: '°', axis: 'bullet', x: [...n], values: spray.bullets.map((b) => r2(b.up)), marks: [...marks] },
    { name: 'view_x', label: 'Crosshair, right of the target', unit: '°', axis: 'bullet', x: [...n], values: viewX },
    { name: 'view_y', label: 'Crosshair, above the target', unit: '°', axis: 'bullet', x: [...n], values: viewY },
    { name: SERIES.idealX, label: `Ideal crosshair (${src})`, unit: '°', axis: 'bullet', x: [...n], values: idealX },
    { name: SERIES.idealY, label: `Ideal crosshair (${src})`, unit: '°', axis: 'bullet', x: [...n], values: idealY },
    { name: 'distance', label: 'Distance', unit: 'units', axis: 'bullet', x: [...n], values: spray.bullets.map((b) => Math.round(b.dist)) },
  ];
}

/** Fill `series` on every duel and spray evidence of the finding that has none. */
export function addEvidenceSeries(ctx: AnalysisContext, f: Finding): void {
  for (const ev of f.evidence) {
    if (ev.series !== undefined) continue;
    const s = ev.kind === 'duel' ? duelSeries(ctx, ev) : ev.kind === 'spray' ? spraySeries(ctx, ev) : [];
    if (s.length > 0) ev.series = s;
  }
}
