/**
 * K4 table `positioning.trades`: one row per kill in a played round. A kill trades a teammate's death when its victim
 * is that teammate's killer and it comes within `trades.windowSec` (tuning/positioning.json) after the death. A killer
 * dies once a round, so each death is traded at most once; one kill can trade several deaths (its victim had killed
 * two of the trader's teammates inside the window).
 */
import type { AnalysisContext, TableDef } from '../../analyze/context';
import { liveRoundOf, secToTicks, teamOf } from './grid';
import { POSITIONING_TUNING } from './tuning';

export interface KillRow {
  /** Index into `raw.events.kills`. */
  k: number;
  tick: number;
  round: number;
  attacker: number;
  victim: number;
  /** Attacker and victim are players of different teams. */
  enemy: boolean;
  /** This kill traded at least one death. */
  isTrade: boolean;
  /** Kill indexes (`k`) of the deaths this kill traded. */
  trades: number[];
  /** This death was traded. */
  traded: boolean;
  /** `k` of the kill that traded it, -1 if none. */
  tradedBy: number;
}

export function buildTrades(ctx: Pick<AnalysisContext, 'raw' | 'match'>): KillRow[] {
  const { raw, match } = ctx;
  const window = secToTicks(raw, POSITIONING_TUNING.trades.windowSec);
  const rows: KillRow[] = [];
  raw.events.kills.forEach((kill, k) => {
    const round = liveRoundOf(match, kill.tick);
    if (round === null || kill.victim < 0 || kill.victim >= raw.players.length) return;
    const ta = kill.attacker >= 0 ? teamOf(match, kill.attacker) : null;
    const tv = teamOf(match, kill.victim);
    rows.push({
      k, tick: kill.tick, round: round.number, attacker: kill.attacker, victim: kill.victim,
      enemy: ta !== null && tv !== null && ta !== tv, isTrade: false, trades: [], traded: false, tradedBy: -1,
    });
  });
  for (const row of rows) {
    if (!row.enemy) continue;
    const team = teamOf(match, row.attacker);
    for (const d of rows) {
      if (d.round !== row.round || d.traded || !d.enemy || d.k === row.k) continue;
      if (d.attacker !== row.victim || teamOf(match, d.victim) !== team) continue;
      if (d.tick > row.tick || row.tick - d.tick > window) continue;
      d.traded = true;
      d.tradedBy = row.k;
      row.isTrade = true;
      row.trades.push(d.k);
    }
  }
  return rows;
}

export const TRADES: TableDef<KillRow[]> = { id: 'positioning.trades', build: buildTrades };

/** The row of kill index k. */
export function killRow(rows: readonly KillRow[], k: number): KillRow | null {
  for (const r of rows) if (r.k === k) return r;
  return null;
}
