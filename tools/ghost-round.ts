/**
 * Ghost round: the whole recorded round with no human. ReplayCore drives all ten pawns
 * as puppets in Sim2DHost, and each pawn's path is measured against the raw recording.
 * Each pawn is measured up to its recorded death tick (with B3 it also dies there) and
 * is no longer driven once its track (plus the hold) ends. The run itself is the headless
 * harness's golden master (tools/harness.ts, `runHarness(data, NO_HUMAN)`); this tool prints
 * the tracking table. The same run, with B3's scripted events checked (kills, HP, shots), is
 * `npm run scripted` (tools/scripted-round.ts).
 *
 *   npm run ghost        # writes logs/ghost-round.jsonl and logs/ghost-trace.json, prints the table
 *
 * tests/golden-round.test.ts runs the same thing and asserts on it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLAYER_IDS, stableStringify, toReplayTrace, type Tuning } from '../src/contracts/index';
import { describeEvent, type PuppetTrack, type ReplayCore, type RoundModel } from '../src/core/index';
import type { SessionData } from '../src/app/index';
import { NO_HUMAN, ROOT, driftTable, loadHarnessData, measureDrift, roundTicks, runHarness, type DriftRow, type HarnessData, type HarnessRun } from './harness';
import { writeSessionLog } from './session-log-io';

export type { BodyBlock, ErrorStats, Snap } from './harness';
export { BEHIND_UNITS } from './harness';

/** The data a ghost round is built from (the harness's). */
export type GhostInputs = SessionData;
export type GhostRun = HarnessRun;
export type GhostRow = DriftRow;

export function loadGhostInputs(): HarnessData {
  return loadHarnessData();
}

/** Ticks to run: one past the latest track end plus the hold, so every sample can be interpolated. */
export function ghostTicks(model: RoundModel, tuning: Tuning): number {
  return roundTicks(model, tuning.replay.holdLastPositionSec);
}

/** The golden-master run (no human), `ticks` long (default: the whole round). */
export function runGhostRound(inputs: GhostInputs = loadGhostInputs(), ticks: number | null = null): GhostRun {
  return runHarness(inputs, { ...NO_HUMAN, lastTick: ticks === null ? 'end' : ticks - 1 });
}

/** Per-pawn drift against the raw recording (tools/harness.ts measureDrift). */
export function measureGhost(run: GhostRun): GhostRow[] {
  return measureDrift(run);
}

/** Markdown table of the ghost round (units). */
export function ghostTable(rows: readonly GhostRow[]): string {
  return driftTable(rows);
}

/** Spikes and discontinuities found per player, one line each. */
export function trackEventsReport(core: ReplayCore): string {
  const lines: string[] = [];
  for (const id of PLAYER_IDS) {
    const c = core.puppet(id);
    if (c === null) continue;
    const tr: PuppetTrack = c.track;
    const sum = tr.summary();
    lines.push(`${id}: ${sum.spikes.length} spike(s), ${sum.discontinuities.length} discontinuity(ies)`);
    for (const e of tr.events) lines.push(`  ${describeEvent(e)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const run = runGhostRound();
  const jsonl = resolve(ROOT, 'logs/ghost-round.jsonl');
  const tracePath = resolve(ROOT, 'logs/ghost-trace.json');
  writeSessionLog(jsonl, run.log);
  mkdirSync(dirname(tracePath), { recursive: true });
  writeFileSync(tracePath, stableStringify(toReplayTrace(run.log)) + '\n', 'utf8');
  console.log(`ghost round: ${run.ticks} ticks, ${run.snaps.length} snap(s), digest ${run.log.digest()}`);
  console.log(`wrote ${jsonl}\nwrote ${tracePath}\n`);
  console.log(ghostTable(measureGhost(run)));
  console.log(`\n${trackEventsReport(run.core)}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
