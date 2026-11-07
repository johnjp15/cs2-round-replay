/**
 * P1: the end-of-round summary off the frame's hot path, for both apps (docs/app.md "Summary", docs/app3d.md "HUD").
 *
 * `summarize(model, log)` (src/core/summary.ts) is ~150–250 ms on a whole round, and ~90 % of that is parsing the
 * session log's JSON lines (SessionLog.at). The 3D page used to call it on every frame from 2 s after the round end
 * (12 fps-equivalent, ~9 MB of garbage per frame); the 2D page called it once when the overlay opened and again on
 * every post-round death (a 200 ms hitch each).
 *
 * `RunEntries` keeps a parsed copy of the log's lines, parsed a few at a time within a per-frame budget, so the
 * summary is `summarize(model, entries)` on already-parsed entries (same result: summarize accepts either; ~5–20 ms,
 * once). A rewind replaces the session's log with a head of it (SessionLog.head: the same line strings), so the
 * parsed prefix whose lines are unchanged is kept. `SummaryCache` computes the summary once per key (the round end,
 * the deaths so far) when the entries are caught up, and returns the cached one otherwise.
 */
import { summarize, type RoundModel } from '../core/index';
import type { LogEntry, RoundSummary, SessionLog } from '../contracts/index';

export class RunEntries {
  private log: SessionLog | null = null;
  private readonly parsed: LogEntry[] = [];
  /** The line each parsed entry came from (shared strings: no copy). */
  private readonly src: string[] = [];

  /** Parsed entries so far (a prefix of the log's lines). */
  get entries(): readonly LogEntry[] {
    return this.parsed;
  }

  /** Lines of the current log not parsed yet. */
  behind(log: SessionLog): number {
    return this.log === log ? log.length - this.parsed.length : log.length;
  }

  /**
   * Parse new lines of `log` until `budgetMs` has passed on `clock` (at least one line when behind). True when every
   * line is parsed.
   */
  sync(log: SessionLog, budgetMs: number, clock: () => number = () => performance.now()): boolean {
    if (this.log !== log) this.adopt(log);
    const n = log.length;
    if (this.parsed.length === n) return true;
    const t0 = clock();
    while (this.parsed.length < n) {
      const i = this.parsed.length;
      const e = log.at(i);
      const line = log.line(i);
      if (e === null || line === undefined) break;
      this.parsed.push(e);
      this.src.push(line);
      if (clock() - t0 >= budgetMs) break;
    }
    return this.parsed.length === n;
  }

  /** Forget everything (a restart). */
  clear(): void {
    this.log = null;
    this.parsed.length = 0;
    this.src.length = 0;
  }

  /** A new log object: keep the parsed prefix whose lines are the same. */
  private adopt(log: SessionLog): void {
    const n = Math.min(log.length, this.parsed.length);
    let k = 0;
    while (k < n && log.line(k) === this.src[k]) k++;
    this.parsed.length = k;
    this.src.length = k;
    this.log = log;
  }
}

/** Per-frame parse budget (ms): ~27 µs a line, so ~70 lines a frame catch a whole-round log up in ~1 s at 60 Hz. */
export const SUMMARY_PARSE_BUDGET_MS = 2;

/** The summary of the run, computed once per key on parsed entries (RunEntries). */
export class SummaryCache {
  readonly entries = new RunEntries();
  private key: string | null = null;
  private value: RoundSummary | null = null;

  /**
   * The summary for `key` (anything that changes when the summary should: the round end, the deaths): the cached one
   * when the key is unchanged; otherwise null until the entries have caught up (parsed within `budgetMs` this call),
   * then computed once. Call it every frame while a summary is wanted.
   */
  get(model: RoundModel, log: SessionLog, key: string, budgetMs = SUMMARY_PARSE_BUDGET_MS): RoundSummary | null {
    if (this.key === key && this.value !== null) return this.value;
    if (!this.entries.sync(log, budgetMs)) return null;
    this.value = summarize(model, this.entries.entries);
    this.key = key;
    return this.value;
  }

  /** Parse ahead (call while the round is over but the summary isn't due yet). */
  warm(log: SessionLog, budgetMs = SUMMARY_PARSE_BUDGET_MS): void {
    this.entries.sync(log, budgetMs);
  }

  /** Forget the summary (a rewind past the round end, a restart); the parsed entries stay (kept by prefix). */
  invalidate(): void {
    this.key = null;
    this.value = null;
  }
}
