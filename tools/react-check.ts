/**
 * G7: "if they can attack, they do" (docs/core.md "Divergence" → Normal bots). A whole-run check, independent of the
 * trigger code's control flow: no alive REPLAY bot has an off-script enemy (the human, or a LIVE pawn) in its `sees`
 * for more than `maxTicks` ticks in a row unless, on each of those ticks, the recording covers it:
 *
 * - the enemy is the human on script (`humanOnScript`: within `offCourseUnits` of his recorded track within
 *   `onCourseDriftSec` of now), so the bot's view of him is the recording's;
 * - a recorded pair covers the tick with the enemy about where the tape has it (`recordedPairInSight`);
 * - the scheduled encounter has the bot engaging him right then: from its sighting at the spot to the hit (`seen`: the
 *   run-time aim), and after the hit while he is at the spot (the recorded duel at the window).
 *
 * Otherwise the bot must have gone LIVE (the engine's AI then fights, after its own reaction time). Two REPLAY enemies
 * seeing each other are both the recording and don't count (the no-human round is the tape by construction).
 */
import { PLAYER_IDS, type LogEntry, type PlayerId, type Tuning } from '../src/contracts/index';
import { dist2, humanOnScript, recordedPairInSight } from '../src/core/index';
import { coreLogs, type HarnessRun } from './harness';

export interface ReactViolation {
  readonly id: PlayerId;
  readonly target: PlayerId;
  /** First and last tick of the uncovered run (inclusive) and its length. */
  readonly from: number;
  readonly to: number;
  readonly ticks: number;
}

/** Ticks [from, to) on which the scheduled encounter has `shooter` engaging `victim` whatever his position (`seen`), and [hit, end] when he is at the spot. */
function encounterSpans(run: HarnessRun): { shooter: PlayerId; victim: PlayerId; seen: number; hit: number; end: number }[] {
  const out: { shooter: PlayerId; victim: PlayerId; seen: number; hit: number; end: number }[] = [];
  for (const p of run.core.divergence.encounters) {
    const logs = coreLogs(run.entries).filter((l) => l.text.startsWith(`encounter ${p.shooter} -> ${p.victim}: `));
    const seen = logs.find((l) => / in sight at the spot (at|since) tick /.test(l.text) || / the recorded hit .* landed on tick /.test(l.text));
    if (seen === undefined) continue;
    const hit = logs.find((l) => / scripted hit .* lands at tick /.test(l.text) || / the recorded hit .* landed on tick /.test(l.text));
    const over = logs.find((l) => / over at tick /.test(l.text)) ?? coreLogs(run.entries).find((l) => l.tick >= seen.tick && l.text.startsWith(`${p.shooter} LIVE: `));
    out.push({ shooter: p.shooter, victim: p.victim, seen: seen.tick, hit: hit?.tick ?? Infinity, end: over?.tick ?? Infinity });
  }
  return out;
}

/**
 * Every uncovered run of more than `maxTicks` ticks (default: `ai.reactionSec` in ticks, a human's reaction) in which
 * an alive REPLAY bot sees an alive off-script enemy. Empty: the invariant holds.
 */
export function reactViolations(run: HarnessRun, tuning: Tuning, maxTicks: number = Math.round(tuning.ai.reactionSec * 64)): ReactViolation[] {
  const model = run.model;
  const index = run.core.divergence.index;
  const spans = encounterSpans(run);
  const encounters = run.core.divergence.encounters;
  const tol = tuning.replay.humanSpotToleranceUnits;
  const open = new Map<string, { from: number; to: number }>();
  const out: ReactViolation[] = [];
  const close = (key: string, id: PlayerId, target: PlayerId): void => {
    const r = open.get(key);
    if (r === undefined) return;
    open.delete(key);
    if (r.to - r.from + 1 > maxTicks) out.push({ id, target, from: r.from, to: r.to, ticks: r.to - r.from + 1 });
  };
  for (let k = 1; k < run.entries.length; k++) {
    const e = run.entries[k] as LogEntry;
    const prev = run.entries[k - 1] as LogEntry;
    const o = e.observe;
    const live = (id: PlayerId): boolean => prev.act.status.find((s) => s.id === id)?.mode === 'LIVE';
    for (const id of PLAYER_IDS) {
      const me = o.pawns.find((p) => p.id === id);
      const replay = e.act.status.find((s) => s.id === id)?.mode === 'REPLAY' && id !== o.human;
      for (const t of PLAYER_IDS) {
        const key = `${id}>${t}`;
        const tp = o.pawns.find((p) => p.id === t);
        const enemy = me !== undefined && tp !== undefined && me.team !== tp.team;
        const offScript = t === o.human || live(t);
        const watching = replay && enemy && me.alive && tp.alive && offScript && me.sees.includes(t);
        let covered = false;
        if (watching) {
          if (t === o.human && humanOnScript(model, o, tuning)) covered = true;
          else if (recordedPairInSight(model, o, index, id, t, tuning)) covered = true;
          else {
            for (const s of spans) {
              if (s.shooter !== id || s.victim !== t) continue;
              const spot = encounters.find((p) => p.shooter === id && p.victim === t)?.spot;
              if (k >= s.seen && k < s.hit) covered = true;
              if (spot !== undefined && k >= s.hit && k <= s.end && dist2(tp.pos, spot) <= tol) covered = true;
            }
          }
        }
        if (watching && !covered) {
          const r = open.get(key);
          if (r === undefined) open.set(key, { from: k, to: k });
          else r.to = k;
        } else close(key, id, t);
      }
    }
  }
  for (const key of [...open.keys()]) {
    const [id, t] = key.split('>') as [PlayerId, PlayerId];
    close(key, id, t);
  }
  return out.sort((a, b) => a.from - b.from || PLAYER_IDS.indexOf(a.id) - PLAYER_IDS.indexOf(b.id));
}

/** One line per violation, for test output. */
export function formatViolations(v: readonly ReactViolation[]): string {
  return v.map((x) => `${x.id} sees ${x.target} uncovered ${x.ticks} ticks (${(x.from / 64).toFixed(2)}–${(x.to / 64).toFixed(2)} s) while REPLAY`).join('\n');
}
