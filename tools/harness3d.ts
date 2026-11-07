/**
 * Headless harness for the 3D engine (H1): tools/harness.ts with Sim3DHost (src/sim3d) in the app's Session instead of
 * Sim2DHost. Same CLI, same summary line, timeline, drift table and outputs (docs/golden.md, docs/sim3d.md):
 *
 *   npm run harness3d -- [--human none|cart] [--takeover <t>] [--script <path>] [--until <t|end>] [--seed <n>] [--out <dir>]
 *   npm run harness3d -- --scenario fixtures/scenarios/<name>.json [--takeover <t>] [--until <t|end>] [--out <dir>]
 *   npm run harness3d -- --game <data/scenarios name> [--map <package>] [--until <t>] [--human <pawn>]   # H3
 *
 * Plus a line with the 3D bullets the human fired (hitbox, damage) and the sight traces.
 */
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tickOf, summarize as summarizeRound } from '../src/core/index';
import { sim3dHostFactory, worldMesh, type Sim3DHost } from '../src/sim3d/index';
import { HumanBot, formatTimeline, loadScenario, timeline } from './human-bot';
import { checkRecording, loadGameScenario, playFreePlayCli } from './game-scenario';
import { DEFAULT_MAP, type MapId } from '../src/contracts/maps';
import {
  DEFAULT_SEED,
  describeSummary,
  driftTable,
  ROOT,
  loadHarnessData,
  measureDrift,
  optionsFromArgs,
  parseCliArgs,
  runHarness,
  summarize,
  writeOutputs,
  type HarnessData,
  type HarnessOptions,
  type HarnessRun,
} from './harness';

/** The 3D harness's data: the harness's (the Session's movement mesh) plus the world mesh for sight and bullets. */
export interface Harness3dData extends HarnessData {
  readonly world: ReturnType<typeof worldMesh>;
}

export function loadHarness3dData(map: MapId = DEFAULT_MAP): Harness3dData {
  const data = loadHarnessData(ROOT, map);
  return { ...data, world: worldMesh(data.sources.geometry) };
}

/** runHarness with the 3D host. */
export function runHarness3d(data: Harness3dData, options: HarnessOptions): HarnessRun {
  return runHarness(data, { ...options, host: sim3dHostFactory(data.world) });
}

/** The run's engine as the 3D host. */
export function host3d(run: HarnessRun): Sim3DHost {
  return run.host as unknown as Sim3DHost;
}

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  // H3: a data/scenarios/ scenario: free play runs on its own; a recording sets the map and plays as below.
  const game = args.game === null ? null : loadGameScenario(args.game);
  if (game !== null && game.recording === null) {
    playFreePlayCli(game, { engine: '3d', map: args.map, until: args.untilGiven && args.until !== 'end' ? args.until : null, seed: args.seed === DEFAULT_SEED ? null : args.seed, human: args.human });
    return;
  }
  if (game !== null) checkRecording(game);
  const scenario = args.scenario === null ? null : loadScenario(args.scenario);
  const t0 = performance.now();
  const data = loadHarness3dData(args.map ?? game?.map ?? scenario?.map ?? DEFAULT_MAP);
  const t1 = performance.now();
  const bot = scenario === null ? null : HumanBot.fromScenario(data, scenario);
  const options: HarnessOptions =
    scenario === null || bot === null
      ? optionsFromArgs(args)
      : {
          human: scenario.human,
          driver: bot,
          seed: scenario.seed,
          lastTick: args.untilGiven ? (args.until === 'end' ? 'end' : tickOf(args.until)) : scenario.until === 'end' ? 'end' : tickOf(scenario.until),
          takeover: args.takeover !== null ? tickOf(args.takeover) : scenario.takeover === null ? null : tickOf(scenario.takeover),
        };
  const run = runHarness3d(data, options);
  const t2 = performance.now();
  const summary = summarize(run, args.script ?? args.scenario);
  if (scenario !== null && bot !== null) {
    console.log(`scenario ${scenario.name}: ${scenario.description}\n\nbot steps:\n${bot.trace.map((l) => `  ${l}`).join('\n')}\n\ntimeline:\n${formatTimeline(timeline(run.entries))}\n`);
  }
  const t3 = performance.now();
  if (args.out !== null) writeOutputs(resolve(args.out), run, summary);
  const t4 = performance.now();
  console.log(`engine: Sim3DHost (3D hitscan on hitboxes, mesh sight)`);
  console.log(describeSummary(summary));
  console.log(`  round summary: ${summarizeRound(run.model, run.entries).headline}`);
  console.log(`\n${driftTable(measureDrift(run))}\n`);
  if (args.out !== null) console.log(`wrote ${resolve(args.out)}/{log.jsonl,trace.json,summary.json}`);
  const ms = (x: number): string => `${x.toFixed(0)} ms`;
  console.log(
    `time: data ${ms(t1 - t0)}, session ${ms(run.ms.construct)}, ${run.ticks} ticks ${ms(run.ms.ticks)} (${((run.ms.ticks * 1000) / run.ticks).toFixed(0)} µs/tick), ` +
      `summary ${ms(t3 - t2)}${args.out === null ? '' : `, outputs ${ms(t4 - t3)}`}; sight traces ${host3d(run).sightTraces()}`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
