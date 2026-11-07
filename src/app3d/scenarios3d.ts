/**
 * H3: scenarios in the 3D page (docs/scenarios.md, docs/app3d.md "Scenarios"): `?scenario=<name>` (default the
 * recorded round, `mirage-sp4rtan-1v3`), `?map=` (a recording: which Mirage package; free play: any built map whose
 * spawns the scenario's players use), free play's Session (FreePlayCore, the map's CS2 nav, the 3D host), and the
 * Scenario / Map pickers in the bar (they reload the page with the new parameters).
 *
 * The single-file (locked) page embeds the default scenario only: its pickers list what it has (docs/scenarios.md).
 */
import { MAP_IDS, mapPackagePaths, parseMapInfo, parseTuning, type MapId, type MapInfo, type PlayerId, type Scenario, type Tuning } from '../contracts/index';
import { freePlayCoreFactory, freePlayPlan, freePlayRound, scenarioTuning, type FreePlayPlan } from '../core/index';
import { Cs2Nav } from '../engine/nav/cs2-nav';
import { Session } from '../app/session';
import { MapGeometry, combineMeshes, decodeGeometry } from '../sim2d/index';
import { sim3dHostFactory } from '../sim3d/index';
import type { FreePlayAssets3d } from './assets3d';
import { MIRAGE_RADAR, type RadarTransform } from './coords';

export const DEFAULT_SCENARIO = 'mirage-sp4rtan-1v3';

/** What the page plays (App3D's last constructor argument). */
export interface Scenario3d {
  readonly scenarios: readonly Scenario[];
  readonly current: Scenario;
  readonly map: MapId;
  /** The radar transform of the map (the HUD radar, the floors' colours). */
  readonly radar: RadarTransform;
  /** Free play: builds the session for a human (null watches); null with a recording (App3D's own Session). */
  readonly makeSession: ((human: PlayerId | null) => Session) | null;
  /** The pawn E takes while watching (a recording: its playable pawn; free play: the spectated one, any). */
  readonly playable: PlayerId | null;
  readonly anyPlayable: boolean;
  readonly tuning: Tuning | null;
  readonly plan: FreePlayPlan | null;
}

/** The scenario `?scenario=` names (default: the recorded round), or an error listing the known ones. */
export function pickScenario(list: readonly Scenario[], param: string | null): Scenario {
  const name = param === null || param === '' ? DEFAULT_SCENARIO : param;
  const s = list.find((q) => q.name === name);
  if (s === undefined) throw new Error(`unknown scenario "${name}" (this page has: ${list.map((q) => q.name).join(', ')})`);
  return s;
}

/** The maps a scenario can run on: a recording on the Mirage packages; free play on its map, or any map with spawns if every player starts at a spawn. */
export function mapsFor(s: Scenario): MapId[] {
  if (s.recording !== null) return MAP_IDS.filter((m) => m === 'mirage-cs2' || m === 'mirage-2020');
  if (s.players.some((p) => p.pos !== null)) return [s.map];
  return MAP_IDS.filter((m) => mapPackagePaths(m).info !== null && m !== 'mirage-2020');
}

export function radarOf(info: MapInfo): RadarTransform {
  return { posX: info.radar.posX, posY: info.radar.posY, scale: info.radar.scale };
}

/** Free play in the page: the map's nav and facts, the plan, the synthetic round and a Session factory. */
export function freePlay3d(s: Scenario, map: MapId, a: FreePlayAssets3d, tuningJson: unknown, scenarios: readonly Scenario[]): { scen: Scenario3d; world: MapGeometry } {
  const info = parseMapInfo(a.info);
  const nav = Cs2Nav.fromJson(a.nav, info);
  const onMap: Scenario = { ...s, map };
  const plan = freePlayPlan(onMap, info);
  const round = freePlayRound(onMap, plan, info);
  const tuning = scenarioTuning(parseTuning(tuningJson), onMap);
  const worldMeshData = decodeGeometry(a.geometry);
  const world = new MapGeometry(worldMeshData);
  const movement = new MapGeometry(combineMeshes(worldMeshData, decodeGeometry(a.clips)));
  const first = s.human ?? plan.pawns[0]?.id ?? null;
  const makeSession = (human: PlayerId | null): Session =>
    new Session({ round, nav, tuning, seed: s.seed, vision: null, geometry: movement, human, playable: human ?? first, anyPlayable: true, core: freePlayCoreFactory(plan), host: sim3dHostFactory(world) });
  return { scen: { scenarios, current: onMap, map, radar: radarOf(info), makeSession, playable: first, anyPlayable: true, tuning, plan }, world };
}

/** A recording scenario (the existing page): only the pickers' data. */
export function recording3d(s: Scenario, map: MapId, scenarios: readonly Scenario[]): Scenario3d {
  return { scenarios, current: s, map, radar: MIRAGE_RADAR, makeSession: null, playable: s.recording?.playable ?? null, anyPlayable: false, tuning: null, plan: null };
}

/** The Scenario and Map pickers, first in the bar; a change reloads the page with `?scenario=` / `?map=`. */
export function mountScenarioPickers(bar: HTMLElement, sc: Scenario3d): void {
  const doc = bar.ownerDocument;
  const go = (scenario: string, map: string | null): void => {
    const q = new URLSearchParams(doc.location.search);
    q.set('scenario', scenario);
    if (map === null) q.delete('map');
    else q.set('map', map);
    doc.location.search = q.toString();
  };
  const label = (text: string, title: string, sel: HTMLSelectElement): HTMLLabelElement => {
    const l = doc.createElement('label');
    l.title = title;
    l.append(`${text} `, sel);
    return l;
  };
  const scenarioSel = doc.createElement('select');
  scenarioSel.id = 'set-scenario';
  for (const s of sc.scenarios) {
    const o = doc.createElement('option');
    o.value = s.name;
    o.textContent = s.title;
    o.selected = s.name === sc.current.name;
    scenarioSel.append(o);
  }
  scenarioSel.addEventListener('change', () => go(scenarioSel.value, null));
  const mapSel = doc.createElement('select');
  mapSel.id = 'set-map';
  for (const m of mapsFor(sc.current)) {
    const o = doc.createElement('option');
    o.value = m;
    o.textContent = m;
    o.selected = m === sc.map;
    mapSel.append(o);
  }
  mapSel.disabled = mapSel.options.length < 2;
  mapSel.addEventListener('change', () => go(sc.current.name, mapSel.value));
  const sep = doc.createElement('span');
  sep.className = 'sep';
  bar.prepend(
    label('Scenario', `${sc.current.description} (data/scenarios/; docs/scenarios.md). A scenario without a recording is free play: every bot is live, and E takes over the player you spectate.`, scenarioSel),
    label('Map', 'The map package (docs/maps.md). A recording plays on the Mirage packages; free play on any built map when its players start at the spawns.', mapSel),
    sep,
  );
}
