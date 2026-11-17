/**
 * K4 test helpers on top of `synth.ts`: a 5-on-5 demo with a row every `step` ticks (2 by default),
 * and setters for positions, deaths, damage, flashes, grenades and purchases.
 */
import { createContext, type AnalysisContext } from '../../src/coach/analyze/context';
import { ingestMatch } from '../../src/coach/ingest/index';
import type { Match } from '../../src/coach/model/match';
import { FLAG, PATH_STEP, TEAM_CT, TEAM_T, rowAtOrAfter } from '../../src/coach/model/raw';
import type { RawDemo, RawDetonation, RawHurt, RawKill } from '../../src/coach/model/raw';
import { roundsFrom, synthDemo, type SynthRound } from './synth';

/** Slots 0–4 start T (team A), 5–9 start CT (team B). Rounds of 1000 ticks from 100: start, freeze end +100, end +900. */
export function tenPlayers(nRounds = 1, extra: Partial<SynthRound> = {}, step = 2): RawDemo {
  const raw = synthDemo({
    players: ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b3', 'b4', 'b5'].map((name) => ({ name })),
    team: (_r, p) => (p < 5 ? TEAM_T : TEAM_CT),
    matchStart: 100,
    rounds: roundsFrom(100, nRounds, 1000, extra),
    step,
  });
  // Spread everyone out (1,000 units apart) so nothing is near by accident; tests move players where needed.
  for (let p = 0; p < 10; p++) setPos(raw, p, 0, Infinity, p * 1000, p < 5 ? 0 : 5000, 0);
  return raw;
}

export function rows(raw: RawDemo, from: number, to: number): [number, number] {
  return [rowAtOrAfter(raw.ticks, from), Math.min(raw.ticks.count, rowAtOrAfter(raw.ticks, to === Infinity ? Number.MAX_SAFE_INTEGER : to + 1))];
}

export function setPos(raw: RawDemo, p: number, from: number, to: number, x: number, y: number, z = 0): void {
  const P = raw.players.length;
  const [a, b] = rows(raw, from, to);
  for (let t = a; t < b; t++) {
    raw.ticks.x[t * P + p] = x;
    raw.ticks.y[t * P + p] = y;
    raw.ticks.z[t * P + p] = z;
  }
}

export function setFlag(raw: RawDemo, p: number, from: number, to: number, bit: number, on = true): void {
  const P = raw.players.length;
  const [a, b] = rows(raw, from, to);
  for (let t = a; t < b; t++) {
    const i = t * P + p;
    raw.ticks.flags[i] = on ? (raw.ticks.flags[i] ?? 0) | bit : (raw.ticks.flags[i] ?? 0) & ~bit;
  }
}

export function setColumn(raw: RawDemo, col: 'money' | 'equip' | 'armor' | 'health' | 'flash', p: number, from: number, to: number, v: number): void {
  const P = raw.players.length;
  const [a, b] = rows(raw, from, to);
  for (let t = a; t < b; t++) raw.ticks[col][t * P + p] = v;
}

/** Active weapon from `from` through `to` (adds the name to the table). */
export function setWeapon(raw: RawDemo, p: number, from: number, to: number, item: string): void {
  let id = raw.names.weapons.indexOf(item);
  if (id < 0) { raw.names.weapons.push(item); id = raw.names.weapons.length - 1; }
  const P = raw.players.length;
  const [a, b] = rows(raw, from, to);
  for (let t = a; t < b; t++) raw.ticks.weapon[t * P + p] = id;
}

/** Everyone holds an AK (so "had a gun" checks pass) unless a test says otherwise. */
export function armAll(raw: RawDemo): void {
  for (let p = 0; p < raw.players.length; p++) setWeapon(raw, p, 0, Infinity, 'ak47');
}

/** A death: the kill event, and the victim dead (alive flag off, health 0) from the tick through his round's end. */
export function kill(raw: RawDemo, tick: number, attacker: number, victim: number, o: Partial<RawKill> = {}): void {
  raw.events.kills.push({
    tick, victim, attacker, assister: -1, weapon: 'ak47', headshot: false, penetrated: 0, thruSmoke: false, attackerBlind: false,
    noScope: false, assistedFlash: false, distance: 0, hitgroup: 'head', ...o,
  });
  const end = raw.events.rounds.find((r) => r.kind === 'end' && r.tick >= tick)?.tick ?? Infinity;
  setFlag(raw, victim, tick, end, FLAG.alive, false);
  setColumn(raw, 'health', victim, tick, end, 0);
}

export function hurt(raw: RawDemo, tick: number, attacker: number, victim: number, health: number, weapon = 'ak47', o: Partial<RawHurt> = {}): void {
  raw.events.hurts.push({ tick, victim, attacker, weapon, hitgroup: 'chest', dmgHealth: 100, dmgArmor: 0, health, armor: 0, ...o });
}

export function det(raw: RawDemo, tick: number, kind: RawDetonation['kind'], p: number, entity: number, x: number, y: number, z = 0): void {
  raw.events.detonations.push({ tick, kind, p, entity, x, y, z });
}

/** A projectile flying in a straight line from `from` to `to` between t0 and t1. */
export function projectile(raw: RawDemo, type: string, thrower: number, entity: number, t0: number, t1: number, from: [number, number, number], to: [number, number, number]): void {
  const n = Math.floor((t1 - t0) / PATH_STEP) + 1;
  const path = new Int16Array(n * 3);
  for (let k = 0; k < n; k++) {
    const f = n === 1 ? 1 : k / (n - 1);
    path[k * 3] = Math.round(from[0] + (to[0] - from[0]) * f);
    path[k * 3 + 1] = Math.round(from[1] + (to[1] - from[1]) * f);
    path[k * 3 + 2] = Math.round(from[2] + (to[2] - from[2]) * f);
  }
  raw.projectiles.push({ type, thrower, entity, t0, t1: t0 + (n - 1) * PATH_STEP, path });
}

export function blind(raw: RawDemo, tick: number, attacker: number, victim: number, duration: number, entity: number): void {
  raw.events.blinds.push({ tick, victim, attacker, duration, entity });
}

/** A purchase record; with `pay`, the money column drops by its cost from that tick on (to the round end). */
export function purchase(raw: RawDemo, tick: number, p: number, item: string, cost: number, pay = true, sold = false): void {
  raw.events.purchases.push({ tick, p, item, cost, sold });
  if (!pay) return;
  const P = raw.players.length;
  const [a, b] = rows(raw, tick, raw.events.rounds.find((r) => r.kind === 'end' && r.tick >= tick)?.tick ?? Infinity);
  for (let t = a; t < b; t++) raw.ticks.money[t * P + p] = Math.max(0, (raw.ticks.money[t * P + p] ?? 0) - cost);
}

/** Sort every event list by tick (stable), as the contract requires. */
export function finish(raw: RawDemo): { raw: RawDemo; match: Match } {
  const ev = raw.events as unknown as Record<string, { tick: number }[]>;
  for (const k of Object.keys(ev)) ev[k]?.sort((a, b) => a.tick - b.tick);
  raw.inventories.sort((a, b) => a.tick - b.tick || a.p - b.p);
  return { raw, match: ingestMatch(raw) };
}

export function ctxOf(raw: RawDemo): AnalysisContext {
  const { match } = finish(raw);
  return createContext(raw, match);
}
