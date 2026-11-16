/**
 * Contract 2 of the demo coach: what detectors produce and the page renders. Types only; nothing computes them yet
 * (K2 and later: detectors; K5: the prioritizer and `MatchReport`).
 *
 * World coordinates are Source units in the map's frame (the same as `RawDemo.ticks.x/y/z`); ticks are demo ticks;
 * players are slots of `RawDemo.players` / `Match.players`.
 */
import type { Match, MatchRound, TeamId } from './match';

export const REPORT_FORMAT = 'coach-report@1';

export type FindingArea = 'aim' | 'movement' | 'utility' | 'positioning' | 'trading' | 'decisions' | 'economy' | 'strategy';
export type FindingScope = 'mechanics' | 'micro' | 'macro';
export type Polarity = 'fix' | 'strength' | 'observation';

/** Colour roles the viewer maps to the theme; detectors never pick colours. */
export type ColorRole = 'user' | 'teammate' | 'enemy' | 'ct' | 't' | 'accent' | 'good' | 'bad' | 'neutral';

interface AnnotationBase {
  /** Visible from tick0 through tick1 (inclusive). */
  tick0: number;
  tick1: number;
  role: ColorRole;
  /** Optional short text shown on hover or next to the mark. */
  label?: string;
}

/** A drawing in world coordinates, so any detector can point at things in the 2D replay without the viewer knowing it. */
export type Annotation =
  | (AnnotationBase & { kind: 'line'; from: [number, number, number]; to: [number, number, number]; dashed?: boolean })
  | (AnnotationBase & { kind: 'circle'; center: [number, number, number]; radius: number })
  /** A view cone: apex, yaw (degrees, CCW from +x), half-angle (degrees), length (units). */
  | (AnnotationBase & { kind: 'cone'; apex: [number, number, number]; yaw: number; halfAngle: number; length: number })
  /** A polyline; `ticks` (same length as points) lets the viewer reveal it over time. */
  | (AnnotationBase & { kind: 'path'; points: [number, number, number][]; ticks?: number[] })
  /** A filled polygon (x, y only), e.g. a lane or a site. */
  | (AnnotationBase & { kind: 'zone'; polygon: [number, number][] })
  | (AnnotationBase & { kind: 'label'; at: [number, number, number]; text: string });

export interface Evidence {
  kind: 'replay' | 'duel' | 'spray' | 'map' | 'board';
  /** Round number (`MatchRound.number`). */
  round: number;
  tick0: number;
  tick1: number;
  /** The tick the viewer opens at / centres on. */
  focus: number;
  players: number[];
  annotations: Annotation[];
  caption: string;
}

export interface MetricValue {
  /** Metric id, e.g. `aim.counter_strafe.early_share`. */
  id: string;
  value: number;
  unit: string;
  /** Sample size behind the value. */
  n: number;
  /** 1 = best of the lobby. */
  lobbyRank: number;
  /** The same metric for every slot (index = slot; NaN where not defined). */
  lobby: number[];
  /** Earlier matches of the same user, oldest first. */
  history?: number[];
}

export interface Advice {
  text: string;
  drill?: string;
}

export interface Finding {
  /** The detector, e.g. `aim.counter_strafe.early_shot`. */
  id: string;
  area: FindingArea;
  scope: FindingScope;
  polarity: Polarity;
  /** Imperative and short: "Stop before you shoot". */
  title: string;
  /** One sentence with the numbers in it. */
  summary: string;
  /** What it costs, in rounds or fights. */
  why: string;
  advice: Advice[];
  metrics: MetricValue[];
  evidence: Evidence[];
  stats: { instances: number; opportunities: number; rounds: number[]; roundsLost: number; winProbLost: number | null };
  /** 0–1: the detector's measured precision × a sample-size factor. */
  confidence: number;
  /** Estimated cost, comparable across detectors. */
  impact: number;
  /** Set by the prioritizer. */
  priority: number;
}

/** One round's summary line for the round strip. */
export interface RoundSummary {
  number: number;
  winner: TeamId | null;
  reasonName: string;
  /** Short tags, e.g. `pistol`, `clutch`, `planted`. */
  tags: string[];
  /** The user's kills, deaths and damage in the round. */
  user: { kills: number; died: boolean; damage: number };
}

/** Bits of `ReplayTrack.flags` (Uint8 per sample and player). */
export const REPLAY_FLAG = {
  alive: 1 << 0,
  /** Has a defuse kit. */
  kit: 1 << 1,
  /** Carries the bomb (from the bomb pickup / drop / plant events). */
  bomb: 1 << 2,
  defusing: 1 << 3,
  scoped: 1 << 4,
  /** Blinded (`flash_duration` > 0). */
  flashed: 1 << 5,
  airborne: 1 << 6,
  reloading: 1 << 7,
} as const;

/** `ReplayTrack.xy` / `z` value for an absent player. */
export const REPLAY_ABSENT = -32768;

/** A kill with both players' positions (feet, whole units) at the kill tick. */
export interface ReplayKill {
  tick: number;
  attacker: number;
  victim: number;
  assister: number;
  weapon: string;
  headshot: boolean;
  penetrated: number;
  thruSmoke: boolean;
  noScope: boolean;
  attackerBlind: boolean;
  /** Attacker position (absent attacker, e.g. the world: `REPLAY_ABSENT`). */
  ax: number;
  ay: number;
  az: number;
  vx: number;
  vy: number;
  vz: number;
}

/** A trigger pull (`weapon_fire`) from the shooter's position along his view yaw; `hit` = the victim it hurt on that tick, or -1. */
export interface ReplayShot {
  tick: number;
  p: number;
  weapon: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hit: number;
}

/** A hit: health removed (before minus after, never `dmg_health`). */
export interface ReplayHurt {
  tick: number;
  attacker: number;
  victim: number;
  weapon: string;
  damage: number;
  /** Health after the hit. */
  health: number;
  hitgroup: string;
}

export interface ReplayBlind {
  tick: number;
  attacker: number;
  victim: number;
  /** Seconds. */
  duration: number;
}

/** A grenade in flight: x, y, z every `step` ticks from t0 (`REPLAY_ABSENT` = missing sample). */
export interface ReplayGrenade {
  type: string;
  thrower: number;
  t0: number;
  t1: number;
  step: number;
  path: Int16Array;
}

/** A grenade effect with its lifetime: smokes and fires until their expiry event, HE and flash bursts briefly. */
export interface ReplayEffect {
  kind: 'smoke' | 'fire' | 'he' | 'flash' | 'decoy';
  p: number;
  tick0: number;
  tick1: number;
  x: number;
  y: number;
  z: number;
}

/** A bomb event with the position of the player involved (the planter at the plant, the dropper at a drop). */
export interface ReplayBombEvent {
  tick: number;
  kind: 'begin_plant' | 'abort_plant' | 'planted' | 'begin_defuse' | 'abort_defuse' | 'defused' | 'exploded' | 'dropped' | 'pickup';
  p: number;
  site: number;
  hasKit: boolean;
  x: number;
  y: number;
  z: number;
}

export interface ReplayEvents {
  kills: ReplayKill[];
  shots: ReplayShot[];
  hurts: ReplayHurt[];
  blinds: ReplayBlind[];
  grenades: ReplayGrenade[];
  effects: ReplayEffect[];
  bomb: ReplayBombEvent[];
}

/**
 * One round for the 2D replay (`src/coach/report/replay.ts`): every player sampled at `hz` (sample k = demo tick
 * `tick0 + k * step`) as small typed arrays, plus the round's events with their ticks. Arrays marked
 * [samples × players] are indexed `k * players + p`.
 */
export interface ReplayTrack {
  round: number;
  tick0: number;
  hz: number;
  /** Demo ticks per sample (tick rate / hz). */
  step: number;
  samples: number;
  players: number;
  /** The round's phases (demo ticks; null where the round has none). */
  phases: { start: number; freezeEnd: number | null; plant: number | null; end: number; officialEnd: number | null };
  /** [players] side in this round: 2 T, 3 CT, 0 not present. */
  side: Uint8Array;
  /** [samples × players × 2] Int16, x then y (whole units); `REPLAY_ABSENT` = absent. */
  xy: Int16Array;
  /** [samples × players] feet z (whole units), for two-level radars. */
  z: Int16Array;
  /** [samples × players] yaw in whole degrees (Int16). */
  yaw: Int16Array;
  /** [samples × players] health (Uint8, 0 = dead or absent). */
  health: Uint8Array;
  /** [samples × players] active weapon: index into `weapons` (0 = none). */
  weapon: Uint8Array;
  /** [samples × players] `REPLAY_FLAG` bits. */
  flags: Uint8Array;
  /** [samples × players] place (callout): index into `places` (0 = unknown). */
  place: Uint8Array;
  weapons: string[];
  places: string[];
  events: ReplayEvents;
}

export interface MatchReport {
  format: typeof REPORT_FORMAT;
  /** The match facts (without per-tick data). */
  match: Pick<Match, 'meta' | 'players'> & { rounds: Omit<MatchRound, 'rowStart' | 'rowEnd' | 'refRow'>[] };
  /** The user's slot. */
  user: number;
  /** Every metric for every slot. */
  metrics: MetricValue[];
  findings: Finding[];
  /** Ids of the chosen top fixes (at most three) and strengths (one or two), in order. */
  topFixes: string[];
  strengths: string[];
  rounds: RoundSummary[];
  replay: ReplayTrack[];
  /** Version of the analysis code that wrote this report. */
  coachVersion: string;
}
