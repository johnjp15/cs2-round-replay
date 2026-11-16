/**
 * Shared number and time formatting for finding texts. Deterministic and locale-free (no `toLocaleString`): the same
 * report in Node and in every browser. Conventions: a space before `%` and units, none before `°` and `×`; en dash
 * for ranges; thousands with a comma.
 */
import type { Match } from '../model/match';
import { REPORT_TUNING, type ReportTuning } from '../analyze/report-tuning';

/** Fixed decimals without "-0". */
export function fixed(x: number, digits = 0): string {
  if (!Number.isFinite(x)) return '–';
  const s = x.toFixed(digits);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

/** Thousands separators on the integer part: 12345.6 → "12,345.6". */
export function grouped(x: number, digits = 0): string {
  const s = fixed(x, digits);
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const int = dot < 0 ? body : body.slice(0, dot);
  const frac = dot < 0 ? '' : body.slice(dot);
  let out = '';
  for (let i = 0; i < int.length; i++) {
    if (i > 0 && (int.length - i) % 3 === 0) out += ',';
    out += int[i];
  }
  return (neg ? '-' : '') + out + frac;
}

/** A 0–1 share as a percentage: 0.412 → "41 %". */
export function pct(share: number, digits = 0): string {
  return `${fixed(share * 100, digits)} %`;
}

/** Degrees: 1.83 → "1.8°". */
export function deg(x: number, digits = 1): string {
  return `${fixed(x, digits)}°`;
}

/** Milliseconds: 46.9 → "47 ms". */
export function ms(x: number): string {
  return `${fixed(x, 0)} ms`;
}

/** Source units: 1850 → "1,850 units". */
export function units(x: number): string {
  return `${grouped(x, 0)} units`;
}

/** Metres from Source units (1 unit = 0.0254 m in CS2's own conversion of distances): 1850 → "47 m". */
export function metres(u: number): string {
  return `${fixed(u * 0.0254, 0)} m`;
}

/** A ratio: 3.08 → "3.1×". */
export function times(x: number, digits = 1): string {
  return `${fixed(x, digits)}×`;
}

/** "1 shot", "3 shots". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${grouped(n)} ${n === 1 ? word : many}`;
}

/** "4–10", or "4" for a single number. */
export function span(a: number, b: number): string {
  return a === b ? `${a}` : `${a}–${b}`;
}

/** An ordinal for ranks: 1 → "1st", 2 → "2nd", 11 → "11th". */
export function ordinal(n: number): string {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 13) return `${n}th`;
  const m = n % 10;
  return `${n}${m === 1 ? 'st' : m === 2 ? 'nd' : m === 3 ? 'rd' : 'th'}`;
}

/** "3rd of 10". */
export function rankOf(rank: number, of: number): string {
  return `${ordinal(rank)} of ${of}`;
}

/** m:ss from seconds (rounded down; negative clamps to 0). */
export function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The round clock a player saw at `tick`: "round 7, 1:12" (time left, counted from the freeze end), "round 7, bomb
 * 0:28" after the plant, "round 7, freeze time" before the freeze end. Outside any round: "tick 1234".
 */
export function roundClock(match: Match, tick: number, tuning: ReportTuning = REPORT_TUNING): string {
  const r = match.rounds.find((x) => tick >= x.startTick && tick <= x.endTick);
  if (r === undefined) return `tick ${tick}`;
  const rate = match.meta.tickRate || 64;
  if (r.freezeEndTick === null || tick < r.freezeEndTick) return `round ${r.number}, freeze time`;
  if (r.bomb.plantTick !== null && tick >= r.bomb.plantTick) return `round ${r.number}, bomb ${mmss(tuning.clock.bombSec - (tick - r.bomb.plantTick) / rate)}`;
  return `round ${r.number}, ${mmss(tuning.clock.roundSec - (tick - r.freezeEndTick) / rate)}`;
}

/** Ticks to milliseconds at the match's tick rate. */
export function ticksToMs(match: Match, ticks: number): number {
  return (ticks * 1000) / (match.meta.tickRate || 64);
}

/** Anonymous label of a slot: its team and its position among that team's slots, A1…A5, B1…B5. */
export function playerLabel(match: Match, slot: number): string {
  const pl = match.players[slot];
  if (pl === undefined) return `#${slot}`;
  const k = match.players.filter((q) => q.team === pl.team && q.slot <= slot).length;
  return `${pl.team}${k}`;
}
