/**
 * Shared number and time formatting for finding texts. Deterministic and locale-free (no `toLocaleString`): the same
 * report in Node and in every browser. Conventions: a space before `%` and units, none before `°` and `×`; en dash
 * for ranges; thousands with a comma.
 */
import { ITEM_DEFS } from '../model/items';
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

/** The display name of a coach item name: `ak47` → "AK-47", `m4a1` → "M4A4"; unknown names as given. */
export function weaponName(item: string): string {
  for (const k of Object.keys(ITEM_DEFS).map(Number).sort((a, b) => a - b)) {
    const d = ITEM_DEFS[k];
    if (d !== undefined && d[0] === item && item !== 'knife') return d[1];
  }
  return item === 'knife' ? 'knife' : item;
}

/**
 * Metric values (K5). **A metric's value is stored in the unit its `unit` names, except `%`: a `%` metric stores a
 * 0–1 share** (0.78 = 78 %), like every share the detectors compute. Every renderer (the page, the CLI, the docs)
 * formats through `metricValue`, so nothing prints a raw share.
 *
 * | unit | stored | shown |
 * | --- | --- | --- |
 * | `%` | 0–1 share | `78 %` |
 * | `deg` | degrees | `1.8°` |
 * | `ms` | milliseconds | `125 ms` |
 * | `x` | ratio | `16.9×` |
 * | `units` | Source units | `942 units` |
 * | `count` | a count or a mean count | `5`, `0.14` |
 * | `per_round` | per round | `0.56 / round` |
 * | `$/round` | dollars per round | `$122 / round` |
 * | anything else | as is | `<value> <unit>` |
 */
export function metricValue(v: number, unit: string): string {
  if (!Number.isFinite(v)) return '–';
  switch (unit) {
    case '%': return pct(v);
    case 'deg': return deg(v);
    case 'ms': return ms(v);
    case 'x': return times(v);
    case 'units': return units(v);
    case 'count': return Number.isInteger(v) ? grouped(v) : fixed(v, 2);
    case 'per_round': return `${fixed(v, 2)} / round`;
    case '$/round': return `$${grouped(v)} / round`;
    default: return unit ? `${fixed(v, 2)} ${unit}` : fixed(v, 2);
  }
}

/** A value on the metric's own axis as a plain number (for chart scales): `%` → percent, the rest unchanged. */
export function metricAxisValue(v: number, unit: string): number {
  return unit === '%' ? v * 100 : v;
}

/** A metric's rank among the players with a value: competition rank (1 = best), how many have a value, how many share it. */
export interface LobbyRankInfo {
  rank: number;
  of: number;
  /** Players with exactly the same value (the user included): 1 = no tie. */
  tied: number;
}

/** Rank information of a slot's value, or null without a value or a rank. */
export function lobbyRankInfo(mv: { value: number; lobbyRank: number; lobby: readonly number[] }): LobbyRankInfo | null {
  if (!Number.isFinite(mv.value) || mv.lobbyRank < 1) return null;
  const vals = mv.lobby.filter((v) => Number.isFinite(v));
  return { rank: mv.lobbyRank, of: vals.length, tied: vals.filter((v) => v === mv.value).length };
}

/** "8th of 10", "tied 2nd of 8", "all 8 tied"; '' without a rank. */
export function rankPhrase(r: LobbyRankInfo | null): string {
  if (r === null) return '';
  if (r.tied >= r.of && r.of > 1) return `all ${r.of} tied`;
  return `${r.tied > 1 ? 'tied ' : ''}${rankOf(r.rank, r.of)}`;
}

/** The same for a metric value. */
export function lobbyRankText(mv: { value: number; lobbyRank: number; lobby: readonly number[] } | null): string {
  return mv === null ? '' : rankPhrase(lobbyRankInfo(mv));
}

/** Confidence in plain words: ≥ 0.6 "high", ≥ 0.35 "moderate", else "low". */
export function confidenceWord(c: number): 'high' | 'moderate' | 'low' {
  return c >= 0.6 ? 'high' : c >= 0.35 ? 'moderate' : 'low';
}

/** "high confidence (0.74)". */
export function confidenceText(c: number): string {
  return `${confidenceWord(c)} confidence`;
}
