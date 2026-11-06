/** Shared, read-only fixtures for the Sim2D tests: parsed tuning, the Mirage nav mesh, round.json. */
import { readFileSync } from 'node:fs';
import { parseTuning, type PlayerId, type Team } from '../src/contracts/index';
import { NavMesh, navOptionsFromTuning } from '../src/sim2d/nav';
import type { RosterEntry } from '../src/sim2d/host';

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as unknown;
}

export const tuning = parseTuning(readJson('../data/tuning.json'));
export const nav = NavMesh.fromJson(readJson('../data/mirage-nav.json'), navOptionsFromTuning(tuning));

/** The slice of data/round.json these tests read. */
export interface RoundSample {
  t: number;
  tick: number;
  x: number;
  y: number;
  z: number;
  confidence: string;
}
export interface RoundPlayer {
  id: PlayerId;
  team: Team;
  deathT: number | null;
  start: { pos: { x: number; y: number; z: number } };
  startHp: number;
  startArmor: number;
  kit: { primary: string | null; secondary: string | null; clip: number; reserve: number };
}
export interface RoundFile {
  players: RoundPlayer[];
  tracks: Record<string, { samples: RoundSample[]; endT: number }>;
  timelines: { weapon: Record<string, { t: number; weapon: string | null }[]> };
}

export const round = readJson('../data/round.json') as RoundFile;

/** The ten {id, team} entries from round.json, sorted by id. */
export const roster: RosterEntry[] = round.players.map((p) => ({ id: p.id, team: p.team }));
