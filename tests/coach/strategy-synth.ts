/**
 * K8 test helpers: synthetic Mirage matches for the strategy tables and detectors. Ten players (slots 0–4 team A,
 * 5–9 team B), long rounds (freeze end 100 ticks after the start, end `len` − 100 after it), a row every 8 ticks,
 * sides swapped from round index `swapAt`. Players are put on places by name, at that place's centroid from
 * data/coach/maps/de_mirage/places.json, so lanes, zones and boxes all line up.
 */
import places from '../../data/coach/maps/de_mirage/places.json';
import type { RawDemo } from '../../src/coach/model/raw';
import { TEAM_CT, TEAM_T } from '../../src/coach/model/raw';
import { finish, rows, setFlag, setColumn } from './k4-helpers';
import { synthDemo } from './synth';

export const ROUND_LEN = 6400;
export const FE = 100;

/** Round k (0-based): start, freeze end, end. */
export function R(k: number): { start: number; fe: number; end: number } {
  const start = 100 + k * ROUND_LEN;
  return { start, fe: start + FE, end: start + ROUND_LEN - 100 };
}

/** The tick `sec` seconds after round k's freeze end. */
export function at(k: number, sec: number): number {
  return R(k).fe + Math.round(sec * 64);
}

export interface MirageSpec {
  rounds: number;
  /** Round index from which team A is CT (default: never). */
  swapAt?: number;
  /** Winning team per round index: 'A' or 'B' (default A). */
  winner?: (k: number) => 'A' | 'B';
}

/** Team A's side in round k. */
export function sideOfA(spec: MirageSpec, k: number): 'T' | 'CT' {
  return k >= (spec.swapAt ?? Infinity) ? 'CT' : 'T';
}

export function mirage(spec: MirageSpec): RawDemo {
  const raw = synthDemo({
    players: ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b3', 'b4', 'b5'].map((name) => ({ name })),
    team: (r, p) => {
      const aT = r < (spec.swapAt ?? Infinity);
      return (p < 5) === aT ? TEAM_T : TEAM_CT;
    },
    matchStart: 100,
    rounds: Array.from({ length: spec.rounds }, (_, k) => {
      const w = spec.winner?.(k) ?? 'A';
      const aT = k < (spec.swapAt ?? Infinity);
      return { start: R(k).start, freezeEnd: R(k).fe, end: R(k).end, winner: (w === 'A') === aT ? TEAM_T : TEAM_CT };
    }),
    step: 8,
  });
  raw.header.map = 'de_mirage';
  raw.names.places = ['', ...places.places.map((p) => p.name)];
  // Everyone starts in his spawn for the whole round.
  for (let k = 0; k < spec.rounds; k++) {
    for (let p = 0; p < 10; p++) {
      const aT = k < (spec.swapAt ?? Infinity);
      const isT = (p < 5) === aT;
      put(raw, p, R(k).start, R(k).end, isT ? 'TSpawn' : 'CTSpawn', p);
    }
  }
  return raw;
}

/** Put player p on a place from tick `from` through `to` (the place's centroid, spread a little by slot). */
export function put(raw: RawDemo, p: number, from: number, to: number, name: string, spread = 0): void {
  const id = raw.names.places.indexOf(name);
  if (id < 0) throw new Error(`no place ${name}`);
  const c = places.places.find((x) => x.name === name)?.centroid ?? { x: 0, y: 0, z: 0 };
  const P = raw.players.length;
  const [a, b] = rows(raw, from, to);
  for (let t = a; t < b; t++) {
    const i = t * P + p;
    raw.ticks.place[i] = id;
    raw.ticks.x[i] = c.x + spread * 8;
    raw.ticks.y[i] = c.y;
    raw.ticks.z[i] = c.z;
  }
}

/** A place name the knowledge file does not know (added to the name table). */
export function putUnknown(raw: RawDemo, p: number, from: number, to: number, name: string): void {
  if (!raw.names.places.includes(name)) raw.names.places.push(name);
  const id = raw.names.places.indexOf(name);
  const P = raw.players.length;
  const [a, b] = rows(raw, from, to);
  for (let t = a; t < b; t++) raw.ticks.place[t * P + p] = id;
}

/** Player p is dead from `tick` to round k's end. */
export function die(raw: RawDemo, k: number, p: number, tick: number): void {
  setFlag(raw, p, tick, R(k).end, 1, false);
  setColumn(raw, 'health', p, tick, R(k).end, 0);
}

export function plant(raw: RawDemo, tick: number, p: number, site: number): void {
  raw.events.bomb.push({ tick: tick - 200, kind: 'begin_plant', p, site, hasKit: false });
  raw.events.bomb.push({ tick, kind: 'planted', p, site, hasKit: false });
}

/** Ts of round k (slots) and CTs. */
export function sides(spec: MirageSpec, k: number): { T: number[]; CT: number[] } {
  const a = [0, 1, 2, 3, 4];
  const b = [5, 6, 7, 8, 9];
  return sideOfA(spec, k) === 'T' ? { T: a, CT: b } : { T: b, CT: a };
}

/**
 * A standard T round: three Ts walk through `lane` (a list of place names in order) from 10 s, 8 s per place,
 * reach site `site` at `hitSec` and plant there at hitSec + 5 (unless `plantIt` is false); the other two Ts stay in
 * spawn. CTs: setup given as place names per CT slot (index in the CT list), held the whole round.
 */
export function tRound(raw: RawDemo, spec: MirageSpec, k: number, o: {
  lane: string[]; site: 'A' | 'B'; hitSec: number; plantIt?: boolean; ct: string[];
}): void {
  const { T, CT } = sides(spec, k);
  const sitePlace = o.site === 'A' ? 'BombsiteA' : 'BombsiteB';
  for (const [i, p] of T.slice(0, 3).entries()) {
    let sec = 10;
    for (const name of o.lane) {
      put(raw, p, at(k, sec), at(k, Math.min(o.hitSec, sec + 8)) - 1, name, i);
      sec = Math.min(o.hitSec, sec + 8);
    }
    put(raw, p, at(k, o.hitSec), R(k).end, sitePlace, i);
  }
  CT.forEach((q, i) => { const name = o.ct[i]; if (name !== undefined) put(raw, q, R(k).fe, R(k).end, name, i); });
  if (o.plantIt !== false) plant(raw, at(k, o.hitSec + 5), T[0] as number, o.site === 'A' ? 184 : 185);
}

export { finish };
