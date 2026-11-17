/**
 * K4: small accessors over `RawDemo.ticks` shared by the utility, positioning and economy tables.
 */
import type { Match, MatchRound, Side, TeamId } from '../../model/match';
import { FLAG, rowAtOrAfter } from '../../model/raw';
import type { RawDemo } from '../../model/raw';

export type Vec3 = [number, number, number];

/** Row of the last sampled tick strictly before `tick` (0 when none). */
export function rowBefore(raw: RawDemo, tick: number): number {
  return Math.max(0, rowAtOrAfter(raw.ticks, tick) - 1);
}

/** Row of the first sampled tick at or after `tick`, clamped to the last row. */
export function rowAt(raw: RawDemo, tick: number): number {
  return Math.min(raw.ticks.count - 1, rowAtOrAfter(raw.ticks, tick));
}

export function cell(raw: RawDemo, t: number, p: number): number {
  return t * raw.players.length + p;
}

export function present(raw: RawDemo, t: number, p: number): boolean {
  return raw.ticks.present[cell(raw, t, p)] === 1;
}

export function alive(raw: RawDemo, t: number, p: number): boolean {
  const i = cell(raw, t, p);
  return raw.ticks.present[i] === 1 && ((raw.ticks.flags[i] ?? 0) & FLAG.alive) !== 0;
}

export function flag(raw: RawDemo, t: number, p: number, bit: number): boolean {
  return ((raw.ticks.flags[cell(raw, t, p)] ?? 0) & bit) !== 0;
}

export function pos(raw: RawDemo, t: number, p: number): Vec3 {
  const i = cell(raw, t, p);
  return [raw.ticks.x[i] ?? 0, raw.ticks.y[i] ?? 0, raw.ticks.z[i] ?? 0];
}

export function dist2d(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0));
}

export function dist3d(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
}

export function weaponAt(raw: RawDemo, t: number, p: number): string {
  return raw.names.weapons[raw.ticks.weapon[cell(raw, t, p)] ?? 0] ?? '';
}

export function placeAt(raw: RawDemo, t: number, p: number): string {
  return raw.names.places[raw.ticks.place[cell(raw, t, p)] ?? 0] ?? '';
}

export function teamOf(match: Match, p: number): TeamId | null {
  return match.players[p]?.team ?? null;
}

export function sideOf(round: MatchRound, team: TeamId | null): Side | null {
  if (team === null) return null;
  return round.sides.T === team ? 'T' : 'CT';
}

/** The round whose [startTick, endTick] contains `tick`, or null. */
export function roundOf(match: Match, tick: number): MatchRound | null {
  for (const r of match.rounds) if (tick >= r.startTick && tick <= r.endTick) return r;
  return null;
}

/** Played rounds only (per-round statistics skip the rest). */
export function liveRoundOf(match: Match, tick: number): MatchRound | null {
  const r = roundOf(match, tick);
  return r !== null && r.played ? r : null;
}

export function ticksToSec(raw: RawDemo, ticks: number): number {
  return ticks / (raw.header.tickRate || 64);
}

export function secToTicks(raw: RawDemo, sec: number): number {
  return Math.round(sec * (raw.header.tickRate || 64));
}

/** Mean position of the players of a side at a round's freeze end (its spawn area); null when nobody is present. */
export function spawnOf(raw: RawDemo, round: MatchRound, side: Side): Vec3 | null {
  const t = round.refRow;
  const team = round.sides[side];
  let n = 0;
  const s: Vec3 = [0, 0, 0];
  for (const p of round.roster[team]) {
    if (!present(raw, t, p)) continue;
    const q = pos(raw, t, p);
    s[0] += q[0]; s[1] += q[1]; s[2] += q[2];
    n++;
  }
  return n === 0 ? null : [s[0] / n, s[1] / n, s[2] / n];
}

/** Round to `digits` decimals. */
export function round1(x: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
