/**
 * In-memory session log: one deterministic JSON line per tick,
 * `{"act":…,"controls":[…],"observe":…}` (keys sorted by stableStringify).
 * `controls` are the Control messages the Core received since the previous
 * tick, applied before `step`; the Replayer re-sends them. No file I/O here
 * (see tools/session-log-io.ts).
 */
import { JsonError, fnv1a32Hex, parseJsonLine, stableStringify } from './json';
import type { Act, Control, Observe } from './types';

export interface LogEntry {
  readonly observe: Observe;
  readonly act: Act;
  readonly controls: readonly Control[];
}

export class SessionLog {
  private readonly entries: string[] = [];
  /** observe.tick of every line, so head() needs no parse. */
  private readonly ticks: number[] = [];
  /** First line index for each tick (ticks may repeat after a rewind). */
  private readonly firstIndexByTick = new Map<number, number>();

  /** Append one tick. Returns the stored line. */
  append(observe: Observe, act: Act, controls: readonly Control[] = []): string {
    const line = stableStringify({ act, controls, observe });
    this.push(line, observe.tick);
    return line;
  }

  get length(): number {
    return this.entries.length;
  }

  lines(): readonly string[] {
    return this.entries.slice();
  }

  /** JSONL: every line followed by "\n" (empty log -> ""). */
  toText(): string {
    return this.entries.length === 0 ? '' : this.entries.join('\n') + '\n';
  }

  /** The stored line at an index (no parse), or undefined. */
  line(index: number): string | undefined {
    return this.entries[index];
  }

  /** Parsed entry at line index, or null. */
  at(index: number): LogEntry | null {
    const line = this.entries[index];
    return line === undefined ? null : toEntry(parseJsonLine(line), index);
  }

  /** First entry whose observe.tick === tick, or null. */
  get(tick: number): LogEntry | null {
    const index = this.firstIndexByTick.get(tick);
    return index === undefined ? null : this.at(index);
  }

  /** B5: a new log with this log's first `n` lines (shared, not re-parsed): a rewind cuts the log back with it. */
  head(n: number): SessionLog {
    const out = new SessionLog();
    const end = Math.max(0, Math.min(n, this.entries.length));
    for (let i = 0; i < end; i++) {
      out.push(this.entries[i] as string, this.ticks[i] as number);
    }
    return out;
  }

  /** FNV-1a 32-bit (UTF-8) of toText(), 8 hex digits. */
  digest(): string {
    return fnv1a32Hex(this.toText());
  }

  /** Parse JSONL. Blank lines are skipped; "\r\n" is accepted. Lines are re-canonicalized. */
  static fromText(text: string): SessionLog {
    const log = new SessionLog();
    const raw = text.split('\n');
    for (let i = 0; i < raw.length; i++) {
      const line = raw[i] as string;
      if (line.trim() === '') continue;
      const entry = toEntry(parseJsonLine(line), i);
      log.push(stableStringify(entry), entry.observe.tick);
    }
    return log;
  }

  private push(line: string, tick: number): void {
    if (!this.firstIndexByTick.has(tick)) this.firstIndexByTick.set(tick, this.entries.length);
    this.entries.push(line);
    this.ticks.push(tick);
  }
}

/** Shape check of a parsed line (top-level only; contents are trusted). */
function toEntry(value: unknown, index: number): LogEntry {
  const where = `session log line ${index + 1}`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new JsonError(`${where}: not an object`);
  const rec = value as Record<string, unknown>;
  const observe = rec['observe'];
  const act = rec['act'];
  const controls = rec['controls'] ?? [];
  if (typeof observe !== 'object' || observe === null) throw new JsonError(`${where}: missing observe`);
  if (typeof act !== 'object' || act === null) throw new JsonError(`${where}: missing act`);
  if (!Array.isArray(controls)) throw new JsonError(`${where}: controls is not an array`);
  const tick = (observe as Record<string, unknown>)['tick'];
  if (typeof tick !== 'number' || !Number.isInteger(tick)) throw new JsonError(`${where}: observe.tick is not an integer`);
  return { observe: observe as Observe, act: act as Act, controls: controls as Control[] };
}
