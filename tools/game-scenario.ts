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
import { mapName, mapPackagePaths, parseMapInfo, parseScenario, parseTuning, type MapId, type MapInfo, type ObsEvent, type PlayerId, type RoundData, type Scenario, type Tuning } from '../src/contracts/index';
import { checkScenarioOnMap, freePlayCoreFactory, freePlayPlan, freePlayRound, scenarioTuning, type FreePlayPlan } from '../src/core/index';
import { Cs2Nav } from '../src/engine/nav/cs2-nav';
import { MapGeometry, NavMesh, Sim2DHost, VisMask, combineMeshes, decodeGeometry, nav3dFor, navOptionsFromTuning, visOptionsFromTuning } from '../src/sim2d/index';
import { sim3dHostFactory } from '../src/sim3d/index';

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
    const o = session.host.observe();
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

/** A scenario with a recording plays through the harness: only data/round.json (the Mirage round) for now. */
export function checkRecording(s: Scenario): void {
  if (s.recording === null) return;
  if (s.recording.round !== 'data/round.json') throw new Error(`scenario ${s.name}: only the data/round.json recording plays in the harness (got ${typeof s.recording.round === 'string' ? s.recording.round : 'inline data'})`);
  if (mapName(s.map) !== 'de_mirage') throw new Error(`scenario ${s.name}: the recording is on Mirage, not ${s.map}`);
}

/** The scenario moved to another map (free play whose players start at the spawns). */
export function onMap(s: Scenario, map: MapId | null): Scenario {
  if (map === null || map === s.map) return s;
  if (s.players.some((p) => p.pos !== null)) throw new Error(`scenario ${s.name}: players with fixed positions can't move to ${map}`);
  return { ...s, map };
}

/**
 * H3: free play in the 2D engine (Sim2DHost with 3D movement), on Mirage only: the CS2 nav for the LIVE AI (as in
 * 3D; the 2020 grid strands bots where its corridors cross CS2 walls), the 2020 grid and sight mask for the engine's
 * 2D parts, the CS2 mesh and clips; starts, sites and spawns from the mirage-cs2 package.
 */
export function freePlaySession2d(s: Scenario, root: string = ROOT, human: PlayerId | null = s.human): Session {
  if (mapName(s.map) !== 'de_mirage') throw new Error(`the 2D engine plays Mirage only (scenario ${s.name} is on ${s.map}); use the 3D harness`);
  const rd = (p: string): string => readFileSync(resolve(root, p), 'utf8');
  const { info } = loadMapNav(s, root);
  const tuning = scenarioTuning(parseTuning(JSON.parse(rd('data/tuning.json')) as unknown), s);
  const p = mapPackagePaths(s.map);
  const worldMesh = decodeGeometry(new Uint8Array(readFileSync(resolve(root, p.geometry))));
  const geometry = new MapGeometry(combineMeshes(worldMesh, decodeGeometry(new Uint8Array(readFileSync(resolve(root, p.clips))))));
  const nav = NavMesh.fromJson(JSON.parse(rd('data/mirage-nav.json')) as unknown, navOptionsFromTuning(tuning)).with3d(nav3dFor(geometry, tuning.movement.stepSize));
  const vision = VisMask.fromJson(JSON.parse(rd('data/mirage-vismask.json')) as unknown, visOptionsFromTuning(tuning.ai));
  const plan = freePlayPlan(s, info);
  // The engine's 2D parts (sight, grenade throws) keep the 2020 grid; the LIVE AI paths on CS2's nav, as in 3D.
  const { nav: cs2 } = loadMapNav(s, root);
  return new Session({
    round: freePlayRound(s, plan, info),
    nav: cs2,
    tuning,
    seed: s.seed,
    vision,
    geometry,
    human,
    playable: human ?? plan.pawns[0]?.id ?? null,
    anyPlayable: true,
    core: freePlayCoreFactory(plan),
    host: (p) => new Sim2DHost(nav, p.tuning, p.roster, p.options, p.vision, p.geometry, cs2),
  });
}

/** The harnesses' `--game` for a free-play scenario: run it and print the round. */
export function playFreePlayCli(s0: Scenario, o: { engine: '2d' | '3d'; map: MapId | null; until: number | null; seed: number | null; human: PlayerId | null }): FreePlayRun {
  const s1 = onMap(s0, o.map);
  const s = o.seed === null ? s1 : { ...s1, seed: o.seed };
  const human = o.human ?? s.human;
  const session = o.engine === '2d' ? freePlaySession2d(s, ROOT, human) : freePlaySession(loadFreePlay(s), human);
  const run = runFreePlay(session, o.until ?? s.rules.roundTimeSec + s.rules.freezeTimeSec + s.rules.c4TimerSec + 10);
  printFreePlay(s, run, o.engine);
  return run;
}

export function printFreePlay(s: Scenario, run: FreePlayRun, engine: string): void {
  console.log(`scenario ${s.name}: ${s.title} (${s.map}, ${engine === '2d' ? 'Sim2DHost' : 'Sim3DHost'}, seed ${s.seed})`);
  for (const k of run.kills) console.log(`  ${fmt(k.tick)}  ${k.attacker ?? 'world'} killed ${k.victim} (${k.weapon ?? '-'})`);
  for (const b of run.bomb) console.log(`  ${fmt(b.tick)}  bomb ${b.phase}${b.id === null ? '' : ` (${b.id})`}`);
  console.log(run.end === null ? `no round end within ${(run.ticks / 64).toFixed(0)} s` : `round end ${fmt(run.end.tick)}: ${run.end.winner} win by ${run.end.reason}`);
  console.log(`${run.ticks} ticks in ${(run.ms / 1000).toFixed(1)} s (${((run.ms * 1000) / run.ticks).toFixed(0)} µs/tick)`);
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
  const mi = argv.indexOf('--map');
  const s = onMap(loadGameScenario(name), mi >= 0 ? (argv[mi + 1] as MapId) : null);
  const w = loadFreePlay(s);
  console.log(`Ts go for ${w.plan.site}`);
  printFreePlay(s, runFreePlay(freePlaySession(w), until), '3d');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
