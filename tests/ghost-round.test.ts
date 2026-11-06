/**
 * Ghost round: ReplayCore (B1 + B2 puppets) drives all ten pawns in Sim2DHost for the
 * whole round with no human, and every path is measured against the raw recording.
 * Run with `--reporter=verbose` to see the table (also in docs/core.md "Puppets").
 */
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, SessionLog, replay, toReplayTrace, DISPLAY_IDS } from '../src/contracts/index';
import { EventSchedule, ReplayCore, RoundModel } from '../src/core/index';
import { NavWalkQuery } from '../src/sim2d/walk-query';
import { GHOST_SEED, ghostTable, loadGhostInputs, measureGhost, runGhostRound, trackEventsReport } from '../tools/ghost-round';

const inputs = loadGhostInputs();
const run = runGhostRound(inputs);
const rows = measureGhost(run);

describe('ghost round (no human, all ten pawns puppets)', () => {
  it('prints the per-player table (units; run with --reporter=verbose)', () => {
    console.log(`[ghost] ${run.ticks} ticks, ${run.snaps.length} snap(s), digest ${run.log.digest()}\n${ghostTable(rows)}`);
    console.log(`[ghost] track preprocessing\n${trackEventsReport(run.core)}`);
    expect(rows.map((r) => r.id)).toEqual([...PLAYER_IDS]);
  });

  it('every T stays within 24 units RMS of its observed samples', () => {
    for (const r of rows.filter((q) => q.team === 'T')) {
      expect(r.observed.samples, r.id).toBeGreaterThan(0);
      expect(r.observed.rms, r.id).toBeLessThan(24);
    }
  });

  it("every CT's inferred samples are within that player's (smallest) uncertainty radius, RMS", () => {
    for (const r of rows.filter((q) => q.team === 'CT')) {
      expect(r.inferred.samples, r.id).toBeGreaterThan(0);
      expect(r.radiusMin, r.id).not.toBeNull();
      expect(r.inferred.rms, r.id).toBeLessThan(r.radiusMin as number);
    }
  });

  it('snaps happen only at teleport points (or after a spike), each is logged, fewer than 10 in total', () => {
    expect(run.snaps.length).toBeLessThan(10);
    expect(run.snaps.length).toBe(run.core.snapCount);
    for (const s of run.snaps) {
      const c = run.core.puppet(s.id);
      expect(c?.track.isTeleportPoint(s.tick), `${s.id} @ ${s.tick}`).toBe(true);
      const logs = run.log.get(s.tick)?.act.actions.filter((a) => a.type === 'log' && a.level === 'info' && a.text.startsWith(`puppet ${s.id}: snap`));
      expect(logs, `${s.id} @ ${s.tick}`).toHaveLength(1);
    }
  });

  it('is deterministic: a second run gives the same SessionLog digest, and the log replays identically', () => {
    const again = runGhostRound(inputs);
    expect(again.log.digest()).toBe(run.log.digest());
    const core = new ReplayCore(new RoundModel(inputs.round), new EventSchedule(inputs.round), inputs.tuning, GHOST_SEED, new NavWalkQuery(inputs.nav));
    const res = replay(SessionLog.fromText(run.log.toText()), core);
    expect(res).toMatchObject({ identical: true, mismatchCount: 0, ticks: run.ticks });
  });

  it('converts to a replay-page trace with all ten tracks', () => {
    const trace = toReplayTrace(run.log);
    for (const id of PLAYER_IDS) expect(trace.tracks[DISPLAY_IDS[id]]?.length, id).toBeGreaterThan(600);
    expect(trace.events.filter((e) => e.kind === 'info')).toHaveLength(run.snaps.length);
  });
});
