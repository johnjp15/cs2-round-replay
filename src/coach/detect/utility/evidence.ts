/**
 * K4: evidence and text helpers shared by the utility, positioning and economy detectors.
 */
import type { AnalysisContext } from '../../analyze/context';
import { pos, rowAt, secToTicks, type Vec3 } from '../../derive/positioning/grid';
import type { Annotation, ColorRole, Evidence, MetricValue } from '../../model/report';
import { fixed, grouped, playerLabel, rankOf } from '../../report/format';

/** A player's feet position at a tick. */
export function at(ctx: AnalysisContext, tick: number, p: number): Vec3 {
  return pos(ctx.raw, rowAt(ctx.raw, tick), p);
}

/** "you" for the user, the anonymous team label (A1…B5) for anyone else. */
export function who(ctx: AnalysisContext, user: number, p: number): string {
  return p === user ? 'you' : playerLabel(ctx.match, p);
}

/** The colour role of a player relative to the user. */
export function roleOf(ctx: AnalysisContext, user: number, p: number): ColorRole {
  if (p === user) return 'user';
  return ctx.teamOf(p) === ctx.teamOf(user) ? 'teammate' : 'enemy';
}

/** A replay evidence moment `beforeSec` before through `afterSec` after `focus`. */
export function replayAt(
  ctx: AnalysisContext, round: number, focus: number, beforeSec: number, afterSec: number, players: number[],
  annotations: Annotation[], caption: string,
): Evidence {
  const uniq = [...new Set(players.filter((p) => p >= 0))].sort((a, b) => a - b);
  return {
    kind: 'replay', round, tick0: focus - secToTicks(ctx.raw, beforeSec), tick1: focus + secToTicks(ctx.raw, afterSec), focus,
    players: uniq, annotations, caption,
  };
}

export function label(at3: Vec3, text: string, tick0: number, tick1: number, role: ColorRole): Annotation {
  return { kind: 'label', at: at3, text, tick0, tick1, role };
}

export function line(from: Vec3, to: Vec3, tick0: number, tick1: number, role: ColorRole, text?: string, dashed?: boolean): Annotation {
  return { kind: 'line', from, to, tick0, tick1, role, ...(text !== undefined ? { label: text } : {}), ...(dashed === true ? { dashed } : {}) };
}

export function circle(center: Vec3, radius: number, tick0: number, tick1: number, role: ColorRole, text?: string): Annotation {
  return { kind: 'circle', center, radius, tick0, tick1, role, ...(text !== undefined ? { label: text } : {}) };
}

export function path(points: Vec3[], ticks: number[], tick0: number, tick1: number, role: ColorRole, text?: string): Annotation {
  return { kind: 'path', points, ticks, tick0, tick1, role, ...(text !== undefined ? { label: text } : {}) };
}

/** Rounds (numbers) the slot's team lost. */
export function roundsLost(ctx: AnalysisContext, slot: number, rounds: readonly number[]): number {
  const team = ctx.teamOf(slot);
  const set = new Set(rounds);
  return ctx.match.rounds.filter((r) => set.has(r.number) && r.winner !== null && r.winner !== team).length;
}

/** The metric values that exist, in order. */
export function present(...mvs: (MetricValue | null)[]): MetricValue[] {
  return mvs.filter((m): m is MetricValue => m !== null && Number.isFinite(m.value));
}

/** "4th of 10" for a metric, or '' without a rank. */
export function rankText(mv: MetricValue | null): string {
  if (mv === null || mv.lobbyRank < 1) return '';
  return rankOf(mv.lobbyRank, mv.lobby.filter((v) => Number.isFinite(v)).length);
}

/** Seconds with one decimal: "2.3 s". */
export function secs(x: number): string {
  return `${fixed(x, 1)} s`;
}

/** Dollars: "$1,250". */
export function dollars(x: number): string {
  return `$${grouped(x)}`;
}
