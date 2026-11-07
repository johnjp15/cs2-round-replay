/**
 * H3: scenarios in the 2D page (docs/scenarios.md): `?scenario=<name>`. The recorded round plays as always; a
 * free-play scenario on Mirage runs in the 2D engine with 3D movement: the LIVE AI on CS2's nav (the map package's
 * `nav.json`), the engine's 2D parts on the 2020 grid and sight mask, starts / sites / spawns from `map.json`.
 * The 2D page plays Mirage only (its radar, nav grid and sight mask are Mirage's); other maps are the 3D page's.
 */
import { mapName, parseMapInfo, type PlayerId, type Scenario } from '../contracts/index';
import { freePlayCoreFactory, freePlayPlan, freePlayRound, scenarioTuning } from '../core/index';
import { Cs2Nav } from '../engine/nav/cs2-nav';
import { Sim2DHost } from '../sim2d/index';
import { Session, type SessionData } from './session';

export const DEFAULT_SCENARIO_2D = 'mirage-sp4rtan-1v3';

/** The free-play session factory and the synthetic round the 2D page draws (renderer, HUD). */
export function freePlay2d(data: SessionData, s: Scenario, infoJson: unknown, navJson: unknown): { data: SessionData; makeSession: (seed: number, human: PlayerId | null) => Session } {
  if (mapName(s.map) !== 'de_mirage') throw new Error(`the 2D page plays Mirage only; open ${s.name} (${s.map}) in the 3D page`);
  if (data.geometry === null || data.geometry === undefined) throw new Error('free play in the 2D page needs the 3D world (movement mesh)');
  const info = parseMapInfo(infoJson);
  const cs2 = Cs2Nav.fromJson(navJson, info);
  const plan = freePlayPlan(s, info);
  const round = freePlayRound(s, plan, info);
  const tuning = scenarioTuning(data.tuning, s);
  const grid = data.nav;
  const out: SessionData = { ...data, round, recorded: round, tuning };
  const makeSession = (seed: number, human: PlayerId | null): Session =>
    new Session({
      round,
      nav: cs2,
      tuning,
      seed,
      vision: data.vision,
      geometry: data.geometry ?? null,
      human,
      playable: human ?? s.human ?? plan.pawns[0]?.id ?? null,
      anyPlayable: true,
      core: freePlayCoreFactory(plan),
      host: (p) => new Sim2DHost(grid, p.tuning, p.roster, p.options, p.vision, p.geometry, cs2),
    });
  return { data: out, makeSession };
}
