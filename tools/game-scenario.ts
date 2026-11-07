/**
 * H3: scenarios (`data/scenarios/<name>.json`, docs/scenarios.md) in Node: load and validate one, and run free play
 * headless in the 3D engine. The harnesses take a scenario with `--game <name|path>` (`--scenario` is the human-bot
 * script flag: fixtures/scenarios/).
 *
 *   npx tsx tools/game-scenario.ts --check                  # validate every scenario (and free play's on its map)
 *   npx tsx tools/game-scenario.ts dust2-5v5 [--until <s>]  # run a free-play scenario headless; prints the round
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Session } from '../src/app/index';
import { mapPackagePaths, parseMapInfo, parseScenario, parseTuning, type MapInfo, type ObsEvent, type PlayerId, type RoundData, type Scenario, type Tuning } from '../src/contracts/index';
import { checkScenarioOnMap, freePlayCoreFactory, freePlayPlan, freePlayRound, scenarioTuning, type FreePlayPlan } from '../src/core/index';
import { Cs2Nav } from '../src/engine/nav/cs2-nav';
import { MapGeometry, combineMeshes, decodeGeometry } from '../src/sim2d/index';
import { sim3dHostFactory, type Sim3DHost } from '../src/sim3d/index';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCENARIO_DIR = 'data/scenarios';
export const DEFAULT_SCENARIO = 'mirage-sp4rtan-1v3';

/** A scenario argument: a name in data/scenarios/, or a path to a .json file. */
export function scenarioFile(arg: string, root: string = ROOT): string {
  if (arg.endsWith('.json')) return resolve(arg);
  return resolve(root, SCENARIO_DIR, `${arg}.json`);
}

export function loadGameScenario(arg: string, root: string = ROOT): Scenario {
  const file = scenarioFile(arg, root);
  if (!existsSync(file)) throw new Error(`no scenario ${arg} (${file}); known: ${scenarioNames(root).join(', ')}`);
  return parseScenario(readFileSync(file, 'utf8'), basename(file, '.json'));
}

export function scenarioNames(root: string = ROOT): string[] {
  return readdirSync(resolve(root, SCENARIO_DIR))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

/** The map package's facts and CS2 nav. */
export function loadMapNav(s: Pick<Scenario, 'map'>, root: string = ROOT): { info: MapInfo; nav: Cs2Nav } {
  const p = mapPackagePaths(s.map);
  if (p.info === null || p.nav === null) throw new Error(`map package ${s.map} has no map.json / nav.json`);
  const info = parseMapInfo(readFileSync(resolve(root, p.info), 'utf8'));
  return { info, nav: Cs2Nav.fromJson(readFileSync(resolve(root, p.nav), 'utf8'), info) };
}

export interface FreePlayWorld {
  readonly scenario: Scenario;
  readonly info: MapInfo;
  readonly nav: Cs2Nav;
  /** World + player clips (movement) and the world alone (sight, bullets). */
  readonly movement: MapGeometry;
  readonly world: MapGeometry;
  readonly tuning: Tuning;
  readonly plan: FreePlayPlan;
  readonly round: RoundData;
}

export function loadFreePlay(s: Scenario, root: string = ROOT): FreePlayWorld {
  if (s.recording !== null) throw new Error(`scenario ${s.name} has a recording: it plays through the harness, not free play`);
  const { info, nav } = loadMapNav(s, root);
  const p = mapPackagePaths(s.map);
  const worldMesh = decodeGeometry(new Uint8Array(readFileSync(resolve(root, p.geometry))));
  const clips = decodeGeometry(new Uint8Array(readFileSync(resolve(root, p.clips))));
  const tuning = scenarioTuning(parseTuning(JSON.parse(readFileSync(resolve(root, 'data/tuning.json'), 'utf8')) as unknown), s);
  const plan = freePlayPlan(s, info);
  return { scenario: s, info, nav, movement: new MapGeometry(combineMeshes(worldMesh, clips)), world: new MapGeometry(worldMesh), tuning, plan, round: freePlayRound(s, plan, info) };
}

/** A free-play Session in the 3D engine (watching unless `human`; any pawn may be taken over). */
export function freePlaySession(w: FreePlayWorld, human: PlayerId | null = w.scenario.human, seed: number = w.scenario.seed): Session {
  return new Session({
    round: w.round,
    nav: w.nav,
    tuning: w.tuning,
    seed,
    vision: null,
    geometry: w.movement,
    human,
    playable: human ?? w.scenario.players[0]?.id ?? null,
    anyPlayable: true,
    core: freePlayCoreFactory(w.plan),
    host: sim3dHostFactory(w.world),
  });
}

export interface FreePlayRun {
  readonly session: Session;
  readonly ticks: number;
  /** The round_end, or null if the run stopped first. */
  readonly end: { readonly tick: number; readonly winner: string; readonly reason: string } | null;
  readonly kills: readonly { readonly tick: number; readonly attacker: PlayerId | null; readonly victim: PlayerId; readonly weapon: string | null }[];
  readonly bomb: readonly { readonly tick: number; readonly phase: string; readonly id: PlayerId | null }[];
  readonly ms: number;
}

/** Step a free-play session until the round ends (plus `afterSec`) or `maxSec`. */
export function runFreePlay(session: Session, maxSec: number, afterSec = 1): FreePlayRun {
  const t0 = performance.now();
  const kills: { tick: number; attacker: PlayerId | null; victim: PlayerId; weapon: string | null }[] = [];
  const bomb: { tick: number; phase: string; id: PlayerId | null }[] = [];
  let end: FreePlayRun['end'] = null;
  const max = Math.round(maxSec * 64);
  let stopAt = max;
  let k = 0;
  for (; k <= stopAt; k++) {
    session.step();
    const host = session.host as unknown as Sim3DHost;
    const o = host.observe();
    for (const e of o.events as readonly ObsEvent[]) {
      if (e.type === 'death') kills.push({ tick: o.tick, attacker: e.attacker, victim: e.victim, weapon: e.weapon });
      else if (e.type === 'bomb') bomb.push({ tick: o.tick, phase: e.phase, id: e.id });
      else if (e.type === 'round_end' && end === null) {
        end = { tick: o.tick, winner: e.winner, reason: e.reason };
        stopAt = Math.min(max, o.tick + Math.round(afterSec * 64));
      }
    }
  }
  return { session, ticks: k, end, kills, bomb, ms: performance.now() - t0 };
}

function fmt(tick: number): string {
  return `${(tick / 64).toFixed(2)} s`;
}

function main(argv: readonly string[]): void {
  if (argv.includes('--check')) {
    let bad = 0;
    for (const n of scenarioNames()) {
      try {
        const s = loadGameScenario(n);
        const problems = s.recording === null ? checkScenarioOnMap(s, loadMapNav(s).info) : [];
        for (const p of problems) console.error(`${n}: ${p}`);
        bad += problems.length;
        console.log(`${n}: ok (${s.map}, ${s.recording === null ? 'free play' : 'recording'})`);
      } catch (e) {
        bad++;
        console.error(`${n}: ${(e as Error).message}`);
      }
    }
    if (bad > 0) process.exitCode = 1;
    return;
  }
  const name = argv.find((a) => !a.startsWith('--')) ?? 'mirage-5v5';
  const ui = argv.indexOf('--until');
  const until = ui >= 0 ? Number(argv[ui + 1]) : 180;
  const s = loadGameScenario(name);
  const w = loadFreePlay(s);
  const run = runFreePlay(freePlaySession(w), until);
  console.log(`scenario ${s.name}: ${s.title} (${s.map}); Ts go for ${w.plan.site}`);
  for (const k of run.kills) console.log(`  ${fmt(k.tick)}  ${k.attacker ?? 'world'} killed ${k.victim} (${k.weapon ?? '-'})`);
  for (const b of run.bomb) console.log(`  ${fmt(b.tick)}  bomb ${b.phase}${b.id === null ? '' : ` (${b.id})`}`);
  console.log(run.end === null ? `no round end within ${until} s` : `round end ${fmt(run.end.tick)}: ${run.end.winner} win by ${run.end.reason}`);
  console.log(`${run.ticks} ticks in ${(run.ms / 1000).toFixed(1)} s (${((run.ms * 1000) / run.ticks).toFixed(0)} µs/tick)`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
