/**
 * `RawDemo` → `Match`: rounds, sides per round, teams that stay together across the swap, scores, bomb facts and
 * economy basics. Deterministic: no clock, no randomness, arrays in a fixed order.
 */
import { MATCH_FORMAT, otherTeam } from '../model/match';
import type { BuyType, Match, MatchPlayer, MatchRound, RoundBomb, Side, TeamEconomy, TeamId } from '../model/match';
import { ROUND_END_REASON, TEAM_CT, TEAM_T, rowAtOrAfter } from '../model/raw';
import type { RawDemo } from '../model/raw';
import { COACH_TUNING } from '../tuning';
import type { CoachTuning } from '../tuning';
import { segmentRounds } from './rounds';

const REASON_NAMES: Readonly<Record<number, string>> = {
  1: 'bomb_exploded', 4: 't_saved', 7: 'bomb_defused', 8: 't_killed', 9: 'ct_killed', 10: 'draw', 12: 'time_ran_out',
  16: 'game_start', 17: 't_surrender', 18: 'ct_surrender',
};

export function reasonName(reason: number): string {
  return REASON_NAMES[reason] ?? `reason_${reason}`;
}

function sideOfTeamNum(n: number): Side | null {
  return n === TEAM_T ? 'T' : n === TEAM_CT ? 'CT' : null;
}

/** Team number of slot p at row t, 0 when absent. */
function teamAt(raw: RawDemo, t: number, p: number): number {
  const P = raw.players.length;
  const i = t * P + p;
  return raw.ticks.present[i] === 1 ? raw.ticks.team[i] ?? 0 : 0;
}

function buyType(number: number, kind: MatchRound['kind'], eq: number, players: number, tuning: CoachTuning): BuyType {
  if (kind === 'regulation' && tuning.rounds.pistolRounds.includes(number)) return 'pistol';
  const per = players > 0 ? eq / players : 0;
  if (per < tuning.economy.ecoBelowPerPlayer) return 'eco';
  if (per >= tuning.economy.fullFromPerPlayer) return 'full';
  return 'force';
}

export function ingestMatch(raw: RawDemo, tuning: CoachTuning = COACH_TUNING): Match {
  const { ticks } = raw;
  const P = raw.players.length;
  const T = ticks.count;
  const firstTick = T > 0 ? ticks.tick[0] ?? 0 : 0;
  const lastTick = T > 0 ? ticks.tick[T - 1] ?? 0 : 0;
  const seg = segmentRounds(raw.events.rounds, firstTick, lastTick, T > 0 ? ticks.roundsPlayed[0] ?? 0 : 0);
  const notes = [...seg.notes];
  const clampRow = (r: number): number => Math.max(0, Math.min(T - 1, r));

  // Rows per segment.
  const segRows = seg.segments.map((s) => {
    const endTick = s.endTick ?? lastTick;
    const rowStart = rowAtOrAfter(ticks, s.startTick);
    const rowEnd = Math.max(rowStart, rowAtOrAfter(ticks, endTick + 1));
    const refTick = s.freezeEndTick ?? endTick;
    return { rowStart, rowEnd, refRow: clampRow(rowAtOrAfter(ticks, refTick)) };
  });

  // Teams: A = the players on T in the first round (at its reference row); later arrivals join by their side then.
  const team = new Array<TeamId | null>(P).fill(null);
  const tSideTeam: TeamId[] = [];
  segRows.forEach((r, k) => {
    // Which team is T this round: majority of already-assigned players on T.
    let aOnT = 0, aOnCT = 0;
    for (let p = 0; p < P; p++) {
      const s = sideOfTeamNum(teamAt(raw, r.refRow, p));
      if (s === null || team[p] === null) continue;
      if ((team[p] === 'A') === (s === 'T')) aOnT++;
      else aOnCT++;
    }
    const tTeam: TeamId = k === 0 || aOnT >= aOnCT ? 'A' : 'B';
    tSideTeam.push(tTeam);
    for (let p = 0; p < P; p++) {
      if (team[p] !== null) continue;
      const s = sideOfTeamNum(teamAt(raw, r.refRow, p));
      if (s !== null) team[p] = s === 'T' ? tTeam : otherTeam(tTeam);
    }
  });
  // Players never present at a reference row: use their first present row anywhere.
  for (let p = 0; p < P; p++) {
    if (team[p] !== null) continue;
    for (let t = 0; t < T; t++) {
      const s = sideOfTeamNum(teamAt(raw, t, p));
      if (s === null) continue;
      const k = segRows.findIndex((r) => t >= r.rowStart && t < r.rowEnd);
      const tTeam = tSideTeam[Math.max(0, k)] ?? 'A';
      team[p] = s === 'T' ? tTeam : otherTeam(tTeam);
      break;
    }
    if (team[p] === null) team[p] = 'A';
  }

  // Initial score (a demo that starts mid-match carries the score so far).
  const score: Record<TeamId, number> = { A: 0, B: 0 };
  const firstNumber = (seg.segments[0]?.roundsPlayedAtStart ?? 0) + 1;
  const startedMidMatch = !seg.hasMatchStart && firstNumber > 1;
  if (startedMidMatch && T > 0) {
    const r0 = segRows[0]?.rowStart ?? 0;
    const tT = tSideTeam[0] ?? 'A';
    const sT = ticks.scoreT[r0] ?? 255, sCT = ticks.scoreCT[r0] ?? 255;
    if (sT !== 255) score[tT] = sT;
    if (sCT !== 255) score[otherTeam(tT)] = sCT;
    notes.push(`demo starts mid-match at round ${firstNumber} (score carried in: A ${score.A}, B ${score.B})`);
  }

  const rounds: MatchRound[] = [];
  let surrendered: TeamId | null = null;
  seg.segments.forEach((s, k) => {
    const rows = segRows[k];
    if (!rows) return;
    const number = s.roundsPlayedAtStart + 1;
    const tTeam = tSideTeam[k] ?? 'A';
    const sides = { T: tTeam, CT: otherTeam(tTeam) };
    const winnerSide = s.endTick === null ? null : sideOfTeamNum(s.winnerTeamNum);
    const winner = winnerSide === null ? null : sides[winnerSide];

    // Roster and economy at the reference row; money at the start row.
    const roster: Record<TeamId, number[]> = { A: [], B: [] };
    const eq: Record<TeamId, number> = { A: 0, B: 0 };
    const money: Record<TeamId, number> = { A: 0, B: 0 };
    for (let p = 0; p < P; p++) {
      const s2 = sideOfTeamNum(teamAt(raw, rows.refRow, p));
      if (s2 === null) continue;
      const tm = sides[s2];
      roster[tm].push(p);
      const i = rows.refRow * P + p;
      eq[tm] += ticks.equip[i] ?? 0;
      money[tm] += ticks.money[clampRow(rows.rowStart) * P + p] ?? 0;
    }

    // Knife round: everyone present carries only a knife (and the bomb) at freeze end.
    let kind: MatchRound['kind'] = number > tuning.rounds.regulationRounds ? 'overtime' : 'regulation';
    if (s.freezeEndTick !== null) {
      const invs = raw.inventories.filter((v) => v.at === 'freeze_end' && v.tick === s.freezeEndTick);
      if (invs.length > 0 && invs.every((v) => v.items.every((it) => it === 'knife' || it === 'c4'))) {
        kind = 'knife';
        notes.push(`round at tick ${s.startTick} is a knife round; not counted`);
      }
    }

    const economy = {} as Record<TeamId, TeamEconomy>;
    for (const tm of ['A', 'B'] as const) {
      economy[tm] = { equipValue: eq[tm], moneyStart: money[tm], players: roster[tm].length, buy: buyType(number, kind, eq[tm], roster[tm].length, tuning) };
    }

    // Bomb facts inside the round.
    const endTick = s.endTick ?? lastTick;
    const bomb: RoundBomb = { plantTick: null, site: -1, planter: -1, defuseTick: null, defuser: -1, explodeTick: null };
    for (const b of raw.events.bomb) {
      if (b.tick < s.startTick || b.tick > endTick) continue;
      if (b.kind === 'planted' && bomb.plantTick === null) { bomb.plantTick = b.tick; bomb.site = b.site; bomb.planter = b.p; }
      else if (b.kind === 'defused' && bomb.defuseTick === null) { bomb.defuseTick = b.tick; bomb.defuser = b.p; }
      else if (b.kind === 'exploded' && bomb.explodeTick === null) bomb.explodeTick = b.tick;
    }

    if (kind !== 'knife' && winner !== null) score[winner]++;
    if (s.reason === ROUND_END_REASON.t_surrender) surrendered = sides.T;
    if (s.reason === ROUND_END_REASON.ct_surrender) surrendered = sides.CT;
    const played = s.freezeEndTick !== null && s.endTick !== null && kind !== 'knife';
    if (!played && kind !== 'knife') notes.push(`round ${number} not played (${s.endTick === null ? 'cut off' : reasonName(s.reason)}); its result still counts in the score`);

    rounds.push({
      index: rounds.length, number, played, kind, startTick: s.startTick, freezeEndTick: s.freezeEndTick, endTick,
      officialEndTick: s.officialEndTick, rowStart: rows.rowStart, rowEnd: rows.rowEnd, refRow: rows.refRow, sides,
      winnerSide, winner, reason: s.reason, reasonName: reasonName(s.reason), scoreAfter: { A: score.A, B: score.B },
      bomb, economy, roster,
    });
  });

  // The game's own final score, from the last row.
  const gameScore: Record<TeamId, number | null> = { A: null, B: null };
  const last = rounds[rounds.length - 1];
  if (last && T > 0) {
    const r = T - 1;
    const sT = ticks.scoreT[r] ?? 255, sCT = ticks.scoreCT[r] ?? 255;
    if (sT !== 255) gameScore[last.sides.T] = sT;
    if (sCT !== 255) gameScore[last.sides.CT] = sCT;
  }
  if ((gameScore.A !== null && gameScore.A !== score.A) || (gameScore.B !== null && gameScore.B !== score.B)) {
    notes.push(`score from round ends (A ${score.A}, B ${score.B}) differs from the game's (A ${gameScore.A}, B ${gameScore.B})`);
  }

  const players: MatchPlayer[] = raw.players.map((pl, p) => ({
    slot: p, name: pl.name, bot: pl.bot, team: team[p] ?? 'A',
    rounds: rounds.filter((r) => r.roster.A.includes(p) || r.roster.B.includes(p)).map((r) => r.number),
  }));
  for (const pl of players) {
    const lastRound = rounds[rounds.length - 1];
    if (lastRound && pl.rounds.length > 0 && !pl.rounds.includes(lastRound.number)) {
      notes.push(`slot ${pl.slot} left after round ${pl.rounds[pl.rounds.length - 1]}`);
    }
  }

  const winner: TeamId | null = score.A > score.B ? 'A' : score.B > score.A ? 'B' : null;
  return {
    format: MATCH_FORMAT,
    meta: {
      map: raw.header.map, source: raw.header.source, server: raw.header.server, patch: raw.header.patch,
      tickRate: raw.header.tickRate, demoSha256: raw.header.demoSha256, score: { A: score.A, B: score.B }, gameScore,
      winner, surrendered, startedMidMatch, regulationRounds: tuning.rounds.regulationRounds, notes,
    },
    players,
    rounds,
  };
}
