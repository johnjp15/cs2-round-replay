/**
 * Checkpoints (B5): the driver's ring of saved states for rewind and seek. Plain data and no engine code, so the CS2
 * plugin's driver can use the C# port as is. A checkpoint is taken between two steps, before the step of `tick`:
 *
 * - `core`: ReplayCore.snapshot() (puppets, scripted events, divergence, the loadout ledger);
 * - `host`: the engine's snapshot when it has the `snapshot` capability (exact rewind), else null (resync rewind);
 * - `observe`: the observe that step sees (canonical). A resync feeds it to the Core again;
 * - `logLength`: the SessionLog's lines before it (a rewind cuts the log back to this, so the log stays one straight
 *   run that replays);
 * - `hazards`: why a resync to it would not reproduce the round (a plant or defuse in progress), empty if none;
 * - `extra`: the driver's own bits (the app's Session: controls not yet logged, queued weapon slots, pause, speed).
 *
 * The store keeps at most `max` (tuning `replay.checkpointMax`), dropping the oldest added; ids are unique (adding an
 * id again replaces it). A rewind drops every checkpoint after its tick: they belong to the abandoned future.
 */
import type { CoreSnapshot, HostSnapshot, JsonValue, Observe } from '../contracts/index';
import { TICK_RATE } from './clock';

export interface Checkpoint {
  readonly id: string;
  /** Observe tick of the step it precedes. */
  readonly tick: number;
  /** Taken automatically every `replay.checkpointSec` (else on demand, `checkpoint {id}`). */
  readonly auto: boolean;
  readonly core: CoreSnapshot;
  readonly host: HostSnapshot | null;
  readonly observe: Observe;
  readonly logLength: number;
  readonly hazards: readonly string[];
  readonly extra: JsonValue;
}

/** The id of the automatic checkpoint at a tick. */
export function autoCheckpointId(tick: number): string {
  return `auto:${tick}`;
}

/** Ticks between automatic checkpoints for `checkpointSec` (at least 1). */
export function checkpointInterval(checkpointSec: number): number {
  const n = Math.floor(checkpointSec * TICK_RATE + 0.5);
  return n < 1 ? 1 : n;
}

export class CheckpointStore {
  readonly max: number;
  /** Insertion order (oldest first). */
  private items: Checkpoint[] = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError(`CheckpointStore: max must be a positive integer, got ${max}`);
    this.max = max;
  }

  get size(): number {
    return this.items.length;
  }

  /** Add (or replace by id); drops the oldest beyond `max`. */
  add(c: Checkpoint): void {
    this.items = this.items.filter((x) => x.id !== c.id);
    this.items.push(c);
    while (this.items.length > this.max) this.items.shift();
  }

  get(id: string): Checkpoint | null {
    return this.items.find((x) => x.id === id) ?? null;
  }

  /** True if a checkpoint (auto or not) was taken at `tick`. */
  hasAt(tick: number): boolean {
    return this.items.some((x) => x.tick === tick);
  }

  /** All checkpoints by tick (then insertion). */
  list(): Checkpoint[] {
    return this.items.map((x, i) => ({ x, i })).sort((a, b) => a.x.tick - b.x.tick || a.i - b.i).map((e) => e.x);
  }

  /**
   * The latest checkpoint at or before `tick` (the last added among equals), or null. `safe`: only those without
   * hazards (a driver that resyncs).
   */
  atOrBefore(tick: number, safe: boolean): Checkpoint | null {
    let best: Checkpoint | null = null;
    for (const x of this.items) {
      if (x.tick > tick || (safe && x.hazards.length > 0)) continue;
      if (best === null || x.tick >= best.tick) best = x;
    }
    return best;
  }

  /** Drop every checkpoint after `tick`. */
  dropAfter(tick: number): void {
    this.items = this.items.filter((x) => x.tick <= tick);
  }

  clear(): void {
    this.items = [];
  }

  /** Approximate memory: UTF-16 code units of the snapshots, observes and extras as JSON (×2 for bytes). */
  jsonSize(): { core: number; host: number; observe: number; extra: number; total: number } {
    let core = 0;
    let host = 0;
    let observe = 0;
    let extra = 0;
    for (const x of this.items) {
      core += JSON.stringify(x.core).length;
      host += x.host === null ? 0 : JSON.stringify(x.host).length;
      observe += JSON.stringify(x.observe).length;
      extra += JSON.stringify(x.extra).length;
    }
    return { core, host, observe, extra, total: core + host + observe + extra };
  }
}
