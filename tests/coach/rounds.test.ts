import { describe, expect, it } from 'vitest';
import { ingestMatch } from '../../src/coach/ingest/index';
import { aliveTimeline, playedRounds, roundAtTick } from '../../src/coach/ingest/access';
import { ROUND_END_REASON, TEAM_CT, TEAM_T, liveRange } from '../../src/coach/model/raw';
import { fourPlayers, roundsFrom, synthDemo } from './synth';

describe('coach ingest: rounds', () => {
  it('numbers rounds, keeps teams across the side swap and scores by team', () => {
    // 4 rounds, sides swap from round index 2; T wins every round.
    const raw = synthDemo({ ...fourPlayers(2), matchStart: 100, rounds: roundsFrom(100, 4) });
    const m = ingestMatch(raw);
    expect(m.rounds.map((r) => r.number)).toEqual([1, 2, 3, 4]);
    expect(m.players.map((p) => p.team)).toEqual(['A', 'A', 'B', 'B']);
    expect(m.rounds.map((r) => r.sides.T)).toEqual(['A', 'A', 'B', 'B']);
    expect(m.rounds.map((r) => r.winner)).toEqual(['A', 'A', 'B', 'B']);
    expect(m.meta.score).toEqual({ A: 2, B: 2 });
    expect(m.meta.winner).toBeNull();
    expect(m.rounds.every((r) => r.played)).toBe(true);
    expect(m.rounds[1]?.officialEndTick).toBe(m.rounds[2]?.startTick);
    expect(m.rounds[3]?.officialEndTick).toBeNull();
  });

  it('drops warmup: the grid and the rounds start at begin_new_match', () => {
    const rounds = [{ start: 0, freezeEnd: 50, end: 80, warmup: true }, ...roundsFrom(200, 2)];
    const raw = synthDemo({ ...fourPlayers(), matchStart: 200, rounds });
    expect(liveRange(raw.events.rounds, 0, 2000).start).toBe(200);
    const m = ingestMatch(raw);
    expect(m.rounds.map((r) => [r.number, r.startTick])).toEqual([[1, 200], [2, 1200]]);
  });

  it('marks a round that ends in freeze time (surrender) as not played but counts its result', () => {
    const rounds = [...roundsFrom(100, 2), { start: 2100, freezeEnd: null, end: 2300, winner: TEAM_T, reason: ROUND_END_REASON.ct_surrender }];
    const m = ingestMatch(synthDemo({ ...fourPlayers(), matchStart: 100, rounds }));
    expect(m.rounds.map((r) => r.played)).toEqual([true, true, false]);
    expect(m.meta.score).toEqual({ A: 3, B: 0 });
    expect(m.meta.surrendered).toBe('B');
    expect(m.rounds[2]?.reasonName).toBe('ct_surrender');
    expect(playedRounds(m).length).toBe(2);
  });

  it('drops a round restarted before it ended', () => {
    const rounds = [...roundsFrom(100, 1), { start: 1100, freezeEnd: 1200, end: null }, ...roundsFrom(2100, 1)];
    const m = ingestMatch(synthDemo({ ...fourPlayers(), matchStart: 100, rounds }));
    expect(m.rounds.map((r) => [r.number, r.startTick])).toEqual([[1, 100], [2, 2100]]);
    expect(m.meta.notes.some((n) => n.includes('restarted'))).toBe(true);
  });

  it('a later begin_new_match (restart, or the match after a knife round) discards everything before it', () => {
    const rounds = [...roundsFrom(100, 2), ...roundsFrom(5000, 2)];
    const raw = synthDemo({ ...fourPlayers(), matchStart: 100, rounds });
    raw.events.rounds.push({ tick: 4990, kind: 'match_start', roundsPlayed: 0, warmup: false, winner: 0, reason: 0, message: '' });
    raw.events.rounds.sort((a, b) => a.tick - b.tick);
    for (const e of raw.events.rounds) if (e.tick >= 4990 && e.kind === 'start') e.roundsPlayed = e.tick === 5000 ? 0 : 1;
    const m = ingestMatch(raw);
    expect(m.rounds.map((r) => [r.number, r.startTick])).toEqual([[1, 5000], [2, 6000]]);
  });

  it('detects a knife round and does not count it', () => {
    const rounds = [{ start: 100, freezeEnd: 200, end: 1000, items: ['knife'] }, ...roundsFrom(1100, 2)];
    const m = ingestMatch(synthDemo({ ...fourPlayers(), matchStart: 100, rounds }));
    expect(m.rounds[0]?.kind).toBe('knife');
    expect(m.rounds[0]?.played).toBe(false);
    expect(m.meta.score).toEqual({ A: 2, B: 0 });
  });

  it('labels overtime rounds and pistol rounds', () => {
    const raw = synthDemo({ ...fourPlayers(12), matchStart: 100, rounds: roundsFrom(100, 26, 1000, { equip: 900 }) });
    const m = ingestMatch(raw);
    expect(m.rounds.filter((r) => r.kind === 'overtime').map((r) => r.number)).toEqual([25, 26]);
    expect(m.rounds.filter((r) => r.economy.A.buy === 'pistol').map((r) => r.number)).toEqual([1, 13]);
    expect(m.rounds[1]?.economy.A.buy).toBe('eco');
    expect(m.rounds[24]?.economy.A.buy).toBe('eco');
  });

  it('classifies buys from the equipment value per player', () => {
    const rounds = [100, 1500, 3000, 4500].map((equip, k) => ({ start: 100 + k * 1000, freezeEnd: 200 + k * 1000, end: 900 + k * 1000, equip }));
    const m = ingestMatch(synthDemo({ ...fourPlayers(), matchStart: 100, rounds }));
    expect(m.rounds.map((r) => r.economy.B.buy)).toEqual(['pistol', 'force', 'force', 'full']);
    expect(m.rounds[3]?.economy.B).toMatchObject({ equipValue: 9000, players: 2 });
  });

  it('a demo that starts mid-match carries the round number and score in', () => {
    const raw = synthDemo({ ...fourPlayers(), rounds: roundsFrom(100, 2), firstRoundsPlayed: 5, firstScore: [3, 2] });
    const m = ingestMatch(raw);
    expect(m.meta.startedMidMatch).toBe(true);
    expect(m.rounds.map((r) => r.number)).toEqual([6, 7]);
    expect(m.meta.score).toEqual({ A: 5, B: 2 });
  });

  it('keeps a player who leaves, and puts a bot that takes over on the right team', () => {
    // Slot 4 is a bot that appears from round index 1 on the CT side in place of slot 3, who left.
    const players = [{ name: 'a1' }, { name: 'a2' }, { name: 'b1' }, { name: 'b2' }, { name: 'bot', bot: true }];
    const team = (r: number, p: number): number => (p < 2 ? TEAM_T : p === 2 ? TEAM_CT : p === 3 ? (r === 0 ? TEAM_CT : 0) : r >= 1 ? TEAM_CT : 0);
    const m = ingestMatch(synthDemo({ players, team, matchStart: 100, rounds: roundsFrom(100, 3) }));
    expect(m.players.map((p) => p.team)).toEqual(['A', 'A', 'B', 'B', 'B']);
    expect(m.players[3]?.rounds).toEqual([1]);
    expect(m.players[4]?.rounds).toEqual([2, 3]);
    expect(m.rounds[1]?.roster.B).toEqual([2, 4]);
    expect(m.meta.notes.some((n) => n.includes('slot 3 left'))).toBe(true);
  });

  it('a demo cut off mid-round keeps the round as not played', () => {
    const rounds = [...roundsFrom(100, 1), { start: 1100, freezeEnd: 1200, end: null }];
    const m = ingestMatch(synthDemo({ ...fourPlayers(), matchStart: 100, rounds }));
    expect(m.rounds.length).toBe(2);
    expect(m.rounds[1]).toMatchObject({ played: false, winner: null });
  });

  it('alive timeline and round lookup', () => {
    const raw = synthDemo({ ...fourPlayers(), matchStart: 100, rounds: roundsFrom(100, 2) });
    const m = ingestMatch(raw);
    const r = m.rounds[0];
    if (!r) throw new Error('no round');
    const tl = aliveTimeline(raw, m, r);
    expect(tl.tick.length).toBe(r.rowEnd - r.rowStart);
    expect(tl.alive.A[0]).toBe(2);
    expect(tl.alive.B[tl.alive.B.length - 1]).toBe(2);
    expect(roundAtTick(m, 1500)?.number).toBe(2);
    expect(roundAtTick(m, 1050)).toBeNull();
    expect(TEAM_CT).toBe(3);
  });
});
