/**
 * Replayer: feed a logged observe stream into any ICore and diff its acts
 * against the logged ones (compared as stableStringify text).
 */
import type { ICore } from './host';
import { canonicalize, stableStringify } from './json';
import type { SessionLog } from './session-log';
import type { Act } from './types';

export const MAX_REPLAY_DIFFS = 20;

export interface ReplayDiff {
  readonly tick: number;
  /** Act as logged. */
  readonly expected: Act;
  /** Act the core returned, canonicalized (as it would be logged). */
  readonly actual: Act;
}

export interface ReplayResult {
  readonly identical: boolean;
  readonly firstMismatchTick: number | null;
  /** First MAX_REPLAY_DIFFS mismatches, in log order. */
  readonly diffs: readonly ReplayDiff[];
  /** Total mismatching lines (may exceed diffs.length). */
  readonly mismatchCount: number;
  /** Lines replayed. */
  readonly ticks: number;
}

/**
 * Replay every line in order: send the line's controls to core.control, then
 * core.step(observe), then compare. The core should be fresh (or restored to the
 * state the session started from).
 */
export function replay(log: SessionLog, core: ICore): ReplayResult {
  const diffs: ReplayDiff[] = [];
  let firstMismatchTick: number | null = null;
  let mismatchCount = 0;
  for (let i = 0; i < log.length; i++) {
    const entry = log.at(i);
    if (entry === null) break;
    for (const c of entry.controls) core.control(c);
    const actual = core.step(entry.observe);
    const actualText = stableStringify(actual);
    if (actualText !== stableStringify(entry.act)) {
      mismatchCount++;
      if (firstMismatchTick === null) firstMismatchTick = entry.observe.tick;
      if (diffs.length < MAX_REPLAY_DIFFS) {
        diffs.push({ tick: entry.observe.tick, expected: entry.act, actual: canonicalize(actual) });
      }
    }
  }
  return { identical: mismatchCount === 0, firstMismatchTick, diffs, mismatchCount, ticks: log.length };
}
