/**
 * Convert a SessionLog into the data shape the existing web replay page
 * (johnjp15.github.io/cs2/mirage-round-replay) draws, so a simulated session can
 * be viewed there. Only the fields the page needs to draw dots, kills and the
 * event list are produced:
 *
 * - tracks[displayId] = [t, x, y, z, flag][] sampled at 10 Hz: log ticks
 *   Math.round(i * 6.4) for i = 0, 1, 2… (0, 6, 13, 19, 26, …) up to the last
 *   logged tick; ticks missing from the log are skipped. `t` is the sample's
 *   observe.t rounded to 3 decimals, positions are rounded to whole units, and
 *   flag is always 0 (the page's "observed" confidence; simulated positions are
 *   ground truth). A track ends at the first sample where the pawn is dead.
 * - kills from `death` events, events from bomb / round_end / death events and
 *   Core `log` actions.
 * - players: id, team and death time (the page cuts tracks at `death`).
 */
import type { SessionLog } from './session-log';
import { PLAYER_IDS, type PawnObs, type PlayerId, type Team, type Vec3 } from './types';

export const DISPLAY_IDS: { readonly [K in PlayerId]: string } = {
  barely: 'barely',
  cart: 'cart',
  donk: 'donk',
  eradicate: 'eradicate',
  incredibad: 'Incredibad',
  lokier: 'Lokier',
  snakelore: 'Snakelore',
  snarlbot: 'snarlbot',
  sp4rtan: 'Sp4rtaN',
  zwomp: 'Zwomp',
};

/** Ticks per 10 Hz sample (64 / 10). */
export const TRACE_SAMPLE_TICKS = 6.4;

export type TraceSample = readonly [t: number, x: number, y: number, z: number, flag: number];

export interface TraceKill {
  readonly t: number;
  /** Display id; null for world kills. */
  readonly killer: string | null;
  readonly victim: string;
  readonly weapon: string;
  readonly hs: boolean;
  readonly assist: null;
  readonly kpos: readonly [number, number, number] | null;
  readonly vpos: readonly [number, number, number];
}

export interface TraceEvent {
  readonly t: number;
  readonly kind: 'kill' | 'bomb' | 'state' | 'info';
  readonly text: string;
}

export interface TracePlayer {
  readonly id: string;
  readonly team: Team;
  /** Seconds of death, or null if alive at the end of the log. */
  readonly death: number | null;
}

export interface ReplayTrace {
  readonly players: readonly TracePlayer[];
  readonly tracks: { readonly [displayId: string]: readonly TraceSample[] };
  readonly kills: readonly TraceKill[];
  readonly events: readonly TraceEvent[];
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function pos3(p: Vec3): [number, number, number] {
  return [Math.round(p.x), Math.round(p.y), Math.round(p.z)];
}

export function toReplayTrace(log: SessionLog): ReplayTrace {
  const tracks: Record<string, TraceSample[]> = {};
  const ended: Partial<Record<PlayerId, boolean>> = {};
  const team: Partial<Record<PlayerId, Team>> = {};
  const death: Partial<Record<PlayerId, number>> = {};
  const kills: TraceKill[] = [];
  const events: TraceEvent[] = [];
  for (const id of PLAYER_IDS) tracks[DISPLAY_IDS[id]] = [];

  // Pass 1: every line, for kills / events / teams.
  let lastTick = -1;
  for (let i = 0; i < log.length; i++) {
    const e = log.at(i);
    if (e === null) break;
    const o = e.observe;
    const t = round3(o.t);
    if (o.tick > lastTick) lastTick = o.tick;
    const byId: Partial<Record<PlayerId, PawnObs>> = {};
    for (const p of o.pawns) {
      byId[p.id] = p;
      team[p.id] = p.team;
    }
    for (const ev of o.events) {
      if (ev.type === 'death') {
        const victim = byId[ev.victim];
        const killer = ev.attacker === null ? undefined : byId[ev.attacker];
        if (death[ev.victim] === undefined) death[ev.victim] = t;
        kills.push({
          t,
          killer: ev.attacker === null ? null : DISPLAY_IDS[ev.attacker],
          victim: DISPLAY_IDS[ev.victim],
          weapon: ev.weapon ?? 'world',
          hs: ev.headshot,
          assist: null,
          kpos: killer === undefined ? null : pos3(killer.pos),
          vpos: victim === undefined ? [0, 0, 0] : pos3(victim.pos),
        });
        const by = ev.attacker === null ? 'the world' : DISPLAY_IDS[ev.attacker];
        events.push({ t, kind: 'kill', text: `${by} killed ${DISPLAY_IDS[ev.victim]}${ev.weapon === null ? '' : ` with the ${ev.weapon}`}${ev.headshot ? ' (headshot)' : ''}` });
      } else if (ev.type === 'bomb') {
        events.push({ t, kind: 'bomb', text: `bomb ${ev.phase}${ev.id === null ? '' : ` (${DISPLAY_IDS[ev.id]})`}` });
      } else if (ev.type === 'round_end') {
        events.push({ t, kind: 'state', text: `round end: ${ev.winner} win (${ev.reason})` });
      }
    }
    for (const a of e.act.actions) {
      if (a.type === 'log') events.push({ t, kind: 'info', text: a.text });
    }
  }

  // Pass 2: 10 Hz samples.
  for (let i = 0; Math.round(i * TRACE_SAMPLE_TICKS) <= lastTick; i++) {
    const e = log.get(Math.round(i * TRACE_SAMPLE_TICKS));
    if (e === null) continue;
    const t = round3(e.observe.t);
    for (const p of e.observe.pawns) {
      if (ended[p.id] === true) continue;
      const [x, y, z] = pos3(p.pos);
      tracks[DISPLAY_IDS[p.id]]?.push([t, x, y, z, 0]);
      if (!p.alive) ended[p.id] = true;
    }
  }

  const players: TracePlayer[] = [];
  for (const id of PLAYER_IDS) {
    const tm = team[id];
    if (tm === undefined) continue;
    players.push({ id: DISPLAY_IDS[id], team: tm, death: death[id] ?? null });
  }
  return { players, tracks, kills, events };
}
