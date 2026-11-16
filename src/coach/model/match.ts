/**
 * `Match`: the normalized view of one demo that the analysis reads (derive, metrics, detectors). Built from a
 * `RawDemo` by `src/coach/ingest` (`ingestMatch`). The per-tick data stays in `RawDemo.ticks`; `Match` holds the facts
 * per round and the mapping from rounds to tick rows, and `src/coach/ingest/access.ts` gives accessors over the grid
 * restricted to live rounds.
 *
 * Conventions: player slots as in `RawDemo.players`. Teams are `A` and `B` and stay with the players across the side
 * swap: `A` is the team on the T side in the first round of the demo. Sides are `T` and `CT`.
 */

export const MATCH_FORMAT = 'coach-match@1';

export type TeamId = 'A' | 'B';
export type Side = 'T' | 'CT';
export type BuyType = 'pistol' | 'eco' | 'force' | 'full';

export interface MatchMeta {
  map: string;
  source: 'valve' | 'faceit' | 'other';
  server: string;
  patch: number | null;
  tickRate: number;
  demoSha256: string;
  /** Final score by team, counting every round that ended with a winner (a surrendered round counts). */
  score: Record<TeamId, number>;
  /** The game's own final score (`team_rounds_total` at the last row), mapped to teams; null where unknown. */
  gameScore: Record<TeamId, number | null>;
  /** The winning team, null for a draw or an unfinished demo. */
  winner: TeamId | null;
  /** The team that surrendered (round-end reason 17/18), if any. */
  surrendered: TeamId | null;
  /** True when the demo has no match start and its first round number is above 1. */
  startedMidMatch: boolean;
  /** Round numbers that are regulation (≤ tuning `regulationRounds`); higher numbers are overtime. */
  regulationRounds: number;
  /** Notes from ingest about anything unusual (restarted rounds dropped, knife round, players who left). */
  notes: string[];
}

export interface MatchPlayer {
  slot: number;
  /** Display name. Never committed for real demos; fixtures carry replaced names. */
  name: string;
  bot: boolean;
  team: TeamId;
  /** Round numbers in which the player was present at the round's reference tick. */
  rounds: number[];
}

export interface RoundBomb {
  /** Demo tick of `bomb_planted`, or null. */
  plantTick: number | null;
  /** The bomb-site entity index from the event (-1 if none); map knowledge names it. */
  site: number;
  planter: number;
  defuseTick: number | null;
  defuser: number;
  explodeTick: number | null;
}

export interface TeamEconomy {
  /** Sum of `current_equip_value` over the team's present players at freeze end (or at the reference tick). */
  equipValue: number;
  /** Sum of `balance` at the round's start row. */
  moneyStart: number;
  /** Players counted. */
  players: number;
  buy: BuyType;
}

export interface MatchRound {
  /** Position in `Match.rounds`. */
  index: number;
  /** The game's round number (total_rounds_played at the round's start + 1). */
  number: number;
  /**
   * `played` = the round had a freeze end and an end (live play happened). A round that ended during freeze time (a
   * surrender) or that the demo cuts off is not played: it is kept, its result counts in the score, but per-round
   * statistics skip it.
   */
  played: boolean;
  kind: 'regulation' | 'overtime' | 'knife';
  startTick: number;
  freezeEndTick: number | null;
  endTick: number;
  /** `round_officially_ended`, null for the last round. */
  officialEndTick: number | null;
  /** Row range [rowStart, rowEnd) in `RawDemo.ticks` from startTick through endTick. */
  rowStart: number;
  rowEnd: number;
  /** Row of the reference tick: freeze end, or the end tick when there is none. Sides, rosters and economy are read here. */
  refRow: number;
  sides: { T: TeamId; CT: TeamId };
  winnerSide: Side | null;
  winner: TeamId | null;
  /** The game's round-end reason code and a name (`bomb_exploded`, `ct_killed`, …). */
  reason: number;
  reasonName: string;
  /** Score after this round. */
  scoreAfter: Record<TeamId, number>;
  bomb: RoundBomb;
  economy: Record<TeamId, TeamEconomy>;
  /** Slots present at the reference tick, per team, ascending. */
  roster: Record<TeamId, number[]>;
}

export interface Match {
  format: typeof MATCH_FORMAT;
  meta: MatchMeta;
  players: MatchPlayer[];
  rounds: MatchRound[];
}

/** Per-row alive counts of one round (accessor output). `tick[k]` is the demo tick of row `rowStart + k`. */
export interface AliveTimeline {
  tick: Int32Array;
  alive: Record<TeamId, Uint8Array>;
}

/** The other team. */
export function otherTeam(t: TeamId): TeamId {
  return t === 'A' ? 'B' : 'A';
}
