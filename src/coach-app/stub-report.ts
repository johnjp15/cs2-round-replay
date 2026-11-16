/**
 * The report before (or without) the analysis: the match facts, the user's slot, round summaries and the replay, no
 * metrics and no findings. Also used when `analyze()` throws, so the page always has rounds to replay.
 */
import type { Match, MatchRound } from '../coach/model/match';
import type { RawDemo } from '../coach/model/raw';
import { REPORT_FORMAT } from '../coach/model/report';
import type { MatchReport, ReplayTrack } from '../coach/model/report';
import { roundSummaries } from '../coach/report/replay';

export const STUB_VERSION = 'coach-page-stub@1';

export function reportMatch(match: Match): MatchReport['match'] {
  return {
    meta: match.meta,
    players: match.players,
    rounds: match.rounds.map((r) => {
      const c: Partial<MatchRound> = { ...r };
      delete c.rowStart;
      delete c.rowEnd;
      delete c.refRow;
      return c as Omit<MatchRound, 'rowStart' | 'rowEnd' | 'refRow'>;
    }),
  };
}

export function stubReport(raw: RawDemo, match: Match, user: number, replay: ReplayTrack[]): MatchReport {
  return {
    format: REPORT_FORMAT,
    match: reportMatch(match),
    user,
    metrics: [],
    findings: [],
    topFixes: [],
    strengths: [],
    rounds: roundSummaries(raw, match, user),
    replay,
    coachVersion: STUB_VERSION,
  };
}
