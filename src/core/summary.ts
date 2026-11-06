/**
 * End-of-round summary (B5): how this run compares with what really happened. A pure function of the round data
 * (`RoundModel`) and a SessionLog (or its parsed lines), portable like the rest of the Core: no clocks, no locale
 * formatting (times are written from integer tick arithmetic), ids in PLAYER_IDS order where order is free.
 *
 * - Result: winner, reason and score from the log's `round_end` (else the last observe's round state), against the
 *   recording (CT `bomb_defused`, 12 – 15, from `meta.scoreAfter` and `bomb`).
 * - Kills: each recorded kill (kill feed) against this run's `death` events: `same` (same killer and victim within
 *   `sameTicks`), `shifted` (Δt), `missed` (didn't happen, with why), and every other death as `new`.
 * - LIVE switches (B4): from `status` (mode LIVE starting on its tick) and the Core's `<id> LIVE: <reason>` log line.
 * - One player's stats (the human's pawn, else the default human cart): kills, damage dealt and taken, time alive,
 *   RMS 2D distance from his recorded track while alive.
 * - The bomb: plant, defuse or explosion, and the margin (timer left at the defuse).
 * - A headline: "Played it like the tape: CT defuse, 0.72 s left", "You changed history: Ts win by elimination
 *   (recorded: CT defuse)".
 */
import {
  PLAYER_IDS,
  type BombSummary,
  type KillRow,
  type LogEntry,
  type Observe,
  type PlayerId,
  type PlayerStats,
  type RoundEndReason,
  type RoundResult,
  type RoundSummary,
  type SessionLog,
  type SummaryVerdict,
  type SwitchRow,
  type Team,
  type WeaponId,
} from '../contracts/index';
import { TICK_RATE } from './clock';
import type { RoundModel } from './round-model';

export interface SummaryOptions {
  /** The pawn whose stats are reported; default: the log's human, else the round's default human (cart). */
  readonly player: PlayerId | null;
  /** A recorded kill is `same` when the run's death is at most this many ticks away (default 2, 1/32 s). */
  readonly sameTicks: number;
}

export const DEFAULT_SUMMARY_OPTIONS: SummaryOptions = { player: null, sameTicks: 2 };

/** `x` with two decimals, half away from zero, from integer arithmetic (no locale, no toFixed). */
export function fixed2(x: number): string {
  const c = Math.floor(Math.abs(x) * 100 + 0.5);
  const sign = x < 0 && c > 0 ? '-' : '';
  const frac = c % 100;
  return `${sign}${Math.floor(c / 100)}.${frac < 10 ? '0' : ''}${frac}`;
}

/** Seconds of a tick count, two decimals ("44.63"). */
export function secText(ticks: number): string {
  return fixed2(ticks / TICK_RATE);
}

/** A signed time difference: "+0.30 s", "-0.30 s". */
export function deltaText(ticks: number): string {
  const s = fixed2(ticks / TICK_RATE);
  return `${ticks >= 0 ? '+' : ''}${s} s`;
}

const TEAM_PLURAL: Readonly<Record<Team, string>> = { CT: 'CTs', T: 'Ts' };

/** Short form for "(recorded: …)" and the tape headline: "CT defuse", "T elimination". */
export function resultShort(winner: Team, reason: RoundEndReason): string {
  switch (reason) {
    case 'bomb_defused':
      return `${winner} defuse`;
    case 'bomb_exploded':
      return `${winner} bomb`;
    case 'elimination':
      return `${winner} elimination`;
    case 'time':
      return `${winner} on time`;
  }
}

/** Sentence form: "Ts win by elimination", "CTs win by defusing the bomb". */
export function resultLong(winner: Team, reason: RoundEndReason): string {
  const who = TEAM_PLURAL[winner];
  switch (reason) {
    case 'bomb_defused':
      return `${who} win by defusing the bomb`;
    case 'bomb_exploded':
      return `${who} win: the bomb explodes`;
    case 'elimination':
      return `${who} win by elimination`;
    case 'time':
      return `${who} win on time`;
  }
}

/** The recording's result: the winner from the score change, the reason from the bomb (a defuse here). */
export function recordedResult(model: RoundModel): RoundResult {
  const before = model.meta.score;
  const after = model.meta.scoreAfter;
  const winner: Team | null = after.ct > before.ct ? 'CT' : after.t > before.t ? 'T' : null;
  const b = model.bomb;
  let reason: RoundEndReason | null = null;
  if (winner === 'CT') reason = b.defuseTick !== null ? 'bomb_defused' : b.plantTick === null ? 'time' : 'elimination';
  else if (winner === 'T') reason = b.plantTick !== null ? 'bomb_exploded' : 'elimination';
  // The kill-feed / defuse tick the round ended on.
  const endTick = winner === null ? null : model.meta.roundEndTick;
  return { winner, reason, endTick, score: { ct: after.ct, t: after.t } };
}

/** The recording's bomb: plant, defuse and the margin (bombTimerSec − defuse − plant). */
export function recordedBomb(model: RoundModel): BombSummary {
  const b = model.bomb;
  const margin = b.plantTick !== null && b.defuseTick !== null ? model.meta.bombTimerSec - (b.defuseTick - b.plantTick) / TICK_RATE : null;
  return { plantTick: b.plantTick, defuseTick: b.defuseTick, explodeTick: null, marginSec: margin };
}

interface RunDeath {
  readonly tick: number;
  readonly victim: PlayerId;
  readonly attacker: PlayerId | null;
  readonly weapon: WeaponId | null;
  readonly headshot: boolean;
}

function entriesOf(log: SessionLog | readonly LogEntry[]): readonly LogEntry[] {
  if (Array.isArray(log)) return log as readonly LogEntry[];
  const l = log as SessionLog;
  const out: LogEntry[] = [];
  for (let i = 0; i < l.length; i++) {
    const e = l.at(i);
    if (e !== null) out.push(e);
  }
  return out;
}

function killerText(attacker: PlayerId | null, weapon: WeaponId | null): string {
  if (attacker !== null) return attacker;
  return weapon === null ? 'the bomb' : `the world (${weapon})`;
}

/** Recorded kills against run deaths (see KillRow), sorted by time. */
export function compareKills(model: RoundModel, deaths: readonly RunDeath[], sameTicks: number): KillRow[] {
  const used = new Set<number>();
  const rows: { row: KillRow; at: number; order: number }[] = [];
  model.kills.forEach((k, order) => {
    const di = deaths.findIndex((d, i) => !used.has(i) && d.victim === k.victim);
    const d = di < 0 ? null : (deaths[di] as RunDeath);
    if (d !== null && d.attacker === k.killer) {
      used.add(di);
      const delta = d.tick - k.tick;
      const same = Math.abs(delta) <= sameTicks;
      rows.push({
        row: { status: same ? 'same' : 'shifted', killer: k.killer, victim: k.victim, weapon: d.weapon, headshot: d.headshot, recordedTick: k.tick, runTick: d.tick, deltaTicks: delta, postRound: k.postRound, text: same ? 'same' : deltaText(delta) },
        at: k.tick,
        order,
      });
      return;
    }
    // Why, earliest cause first: the victim was already dead, the killer was, the victim died later to someone else.
    let why: string;
    const killerDeath = deaths.find((x) => x.victim === k.killer);
    if (d !== null && d.tick <= k.tick) why = `${k.victim} died to ${killerText(d.attacker, d.weapon)} at ${secText(d.tick)} s`;
    else if (killerDeath !== undefined && killerDeath.tick < k.tick) why = `${k.killer} was dead (${secText(killerDeath.tick)} s)`;
    else if (d !== null) why = `${k.victim} died to ${killerText(d.attacker, d.weapon)} at ${secText(d.tick)} s`;
    else why = `${k.victim} survived`;
    rows.push({
      row: { status: 'missed', killer: k.killer, victim: k.victim, weapon: k.weapon, headshot: k.hs, recordedTick: k.tick, runTick: null, deltaTicks: null, postRound: k.postRound, text: `didn't happen: ${why}` },
      at: k.tick,
      order,
    });
  });
  deaths.forEach((d, i) => {
    if (used.has(i)) return;
    rows.push({
      row: { status: 'new', killer: d.attacker, victim: d.victim, weapon: d.weapon, headshot: d.headshot, recordedTick: null, runTick: d.tick, deltaTicks: null, postRound: false, text: 'new' },
      at: d.tick,
      order: model.kills.length + i,
    });
  });
  return rows.sort((a, b) => a.at - b.at || a.order - b.order).map((r) => r.row);
}

/** Every switch to LIVE (B4), in tick then id order, with the Core's reason. */
export function liveSwitchRows(entries: readonly LogEntry[]): SwitchRow[] {
  const out: SwitchRow[] = [];
  for (const e of entries) {
    const tick = e.observe.tick;
    for (const s of e.act.status) {
      if (s.mode !== 'LIVE' || s.sinceTick !== tick) continue;
      const prefix = `${s.id} LIVE: `;
      let reason = '';
      for (const a of e.act.actions) {
        if (a.type !== 'log' || !a.text.startsWith(prefix)) continue;
        const rest = a.text.slice(prefix.length);
        const goal = rest.lastIndexOf('; goal ');
        reason = goal < 0 ? rest : rest.slice(0, goal);
        break;
      }
      out.push({ id: s.id, tick, trigger: s.trigger, reason });
    }
  }
  return out;
}

function playerStats(model: RoundModel, entries: readonly LogEntry[], id: PlayerId, human: boolean, deaths: readonly RunDeath[]): PlayerStats {
  let dealt = 0;
  let taken = 0;
  let alive = 0;
  let sq = 0;
  let n = 0;
  for (const e of entries) {
    const o = e.observe;
    for (const ev of o.events) {
      if (ev.type !== 'damage') continue;
      if (ev.attacker === id && ev.victim !== id) dealt += ev.amount;
      if (ev.victim === id) taken += ev.amount;
    }
    const p = o.pawns.find((q) => q.id === id);
    // The setup tick's observe predates the setup (everyone at the origin): not measured.
    if (p === undefined || !p.alive || o.tick === 0) continue;
    alive++;
    const r = model.trackAtTick(id, o.tick);
    if (r === null) continue;
    const dx = p.pos.x - r.pos.x;
    const dy = p.pos.y - r.pos.y;
    sq += dx * dx + dy * dy;
    n++;
  }
  const death = deaths.find((d) => d.victim === id);
  const kills = deaths.filter((d) => d.attacker === id && d.victim !== id).length;
  return {
    id,
    human,
    kills,
    damageDealt: dealt,
    damageTaken: taken,
    aliveSec: alive / TICK_RATE,
    deathTick: death === undefined ? null : death.tick,
    rmsFromRecording: n === 0 ? null : Math.sqrt(sq / n),
    rmsTicks: n,
  };
}

function runResult(entries: readonly LogEntry[]): RoundResult {
  const last = entries[entries.length - 1];
  for (const e of entries) {
    for (const ev of e.observe.events) {
      if (ev.type === 'round_end') return { winner: ev.winner, reason: ev.reason, endTick: e.observe.tick, score: { ct: e.observe.round.score.ct, t: e.observe.round.score.t } };
    }
  }
  const score = last === undefined ? { ct: 0, t: 0 } : { ct: last.observe.round.score.ct, t: last.observe.round.score.t };
  return { winner: null, reason: null, endTick: null, score };
}

function runBomb(entries: readonly LogEntry[]): BombSummary {
  let plant: number | null = null;
  let defuse: number | null = null;
  let explode: number | null = null;
  let margin: number | null = null;
  let prev: Observe | null = null;
  for (const e of entries) {
    const o = e.observe;
    for (const ev of o.events) {
      if (ev.type !== 'bomb') continue;
      if (ev.phase === 'planted' && plant === null) plant = o.tick;
      if (ev.phase === 'defused' && defuse === null) {
        defuse = o.tick;
        margin = o.round.timeLeftSec;
      }
      if (ev.phase === 'exploded' && explode === null) {
        explode = o.tick;
        // A defuse in progress the tick before: how much longer it needed (processed ticks: observe tick − 1).
        const b = prev === null ? null : prev.round.bomb;
        if (margin === null && b !== null && b.defuser !== null && b.defuseEndTick !== null) margin = (o.tick - 1 - b.defuseEndTick) / TICK_RATE;
      }
    }
    prev = o;
  }
  return { plantTick: plant, defuseTick: defuse, explodeTick: explode, marginSec: margin };
}

function headlineOf(verdict: SummaryVerdict, result: RoundResult, recorded: RoundResult, bomb: BombSummary, recBomb: BombSummary, kills: readonly KillRow[], human: boolean): string {
  const rec = recorded.winner !== null && recorded.reason !== null ? resultShort(recorded.winner, recorded.reason) : 'unknown';
  if (verdict === 'unfinished' || result.winner === null || result.reason === null) return `Round still on (recorded: ${rec})`;
  const short = resultShort(result.winner, result.reason);
  const left = bomb.marginSec !== null && result.reason === 'bomb_defused' ? `, ${fixed2(bomb.marginSec)} s left` : '';
  if (verdict === 'tape') return `Played it like the tape: ${short}${left}`;
  if (verdict === 'same_result') {
    const changed = kills.filter((k) => k.status !== 'same').length;
    const recLeft = recBomb.marginSec !== null && left !== '' && fixed2(recBomb.marginSec) !== fixed2(bomb.marginSec ?? 0) ? ` (recorded ${fixed2(recBomb.marginSec)} s)` : '';
    return `Same result, different round: ${short}${left}${recLeft}; ${changed} kill${changed === 1 ? '' : 's'} changed`;
  }
  return `${human ? 'You changed history' : 'History changed'}: ${resultLong(result.winner, result.reason)} (recorded: ${rec})`;
}

/** The end-of-round summary of a run (see the file comment). Works on a partial log too (`unfinished`). */
export function summarize(model: RoundModel, log: SessionLog | readonly LogEntry[], options: Partial<SummaryOptions> = {}): RoundSummary {
  const opts: SummaryOptions = { ...DEFAULT_SUMMARY_OPTIONS, ...options };
  const entries = entriesOf(log);
  const deaths: RunDeath[] = [];
  for (const e of entries) {
    for (const ev of e.observe.events) if (ev.type === 'death') deaths.push({ tick: e.observe.tick, victim: ev.victim, attacker: ev.attacker, weapon: ev.weapon, headshot: ev.headshot });
  }
  const human = entries.find((e) => e.observe.human !== null)?.observe.human ?? null;
  const fallback = model.players.find((p) => p.isHumanDefault)?.id ?? (PLAYER_IDS[0] as PlayerId);
  const id = opts.player ?? human ?? fallback;
  const result = runResult(entries);
  const recorded = recordedResult(model);
  const bomb = runBomb(entries);
  const recBomb = recordedBomb(model);
  const kills = compareKills(model, deaths, opts.sameTicks);
  const sameResult = result.winner === recorded.winner && result.reason === recorded.reason;
  const verdict: SummaryVerdict =
    result.winner === null ? 'unfinished' : !sameResult ? 'changed' : kills.every((k) => k.status === 'same') ? 'tape' : 'same_result';
  const last = entries[entries.length - 1];
  return {
    headline: headlineOf(verdict, result, recorded, bomb, recBomb, kills, human !== null),
    verdict,
    result,
    recorded,
    bomb,
    recordedBomb: recBomb,
    kills,
    switches: liveSwitchRows(entries),
    player: playerStats(model, entries, id, id === human, deaths),
    ticks: entries.length,
    lastTick: last === undefined ? -1 : last.observe.tick,
  };
}
