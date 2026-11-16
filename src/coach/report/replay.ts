/**
 * Replay data for the 2D viewer: per round, every player sampled at `tuning.replay.hz` (16 Hz) as small typed
 * arrays, and the round's events with their ticks (kills with positions, shots, hits, blinds, grenade paths, smoke /
 * fire / HE / flash effects with their lifetimes, bomb events with positions). Pure and deterministic: the same
 * RawDemo and Match give the same tracks in Node and in the worker.
 *
 * Range of a round's track: from `freezeLeadSec` before the freeze end (or the round start) to the official end (or
 * `postEndSec` after the end), clamped to the tick grid. A sample takes the grid row nearest its tick.
 */
import type { Match, MatchRound, TeamId } from '../model/match';
import { FLAG, PATH_NONE, PATH_STEP, TEAM_CT, TEAM_T, rowAtOrAfter } from '../model/raw';
import type { RawDemo } from '../model/raw';
import { REPLAY_ABSENT, REPLAY_FLAG } from '../model/report';
import type {
  ReplayBombEvent, ReplayEffect, ReplayEvents, ReplayGrenade, ReplayHurt, ReplayKill, ReplayShot, ReplayTrack, RoundSummary,
} from '../model/report';
import { COACH_TUNING } from '../tuning';
import type { CoachTuning } from '../tuning';

const clamp16 = (v: number): number => {
  if (!Number.isFinite(v)) return REPLAY_ABSENT;
  const r = Math.round(v);
  return r < -32767 ? -32767 : r > 32767 ? 32767 : r;
};

/** Normalize degrees to (-180, 180]. */
function wrapDeg(d: number): number {
  let a = d % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

/** Grid row nearest to `tick` (ties go to the earlier row). */
function nearestRow(raw: RawDemo, tick: number): number {
  const T = raw.ticks.count;
  const r = rowAtOrAfter(raw.ticks, tick);
  if (r >= T) return T - 1;
  if (r > 0 && tick - (raw.ticks.tick[r - 1] ?? 0) <= (raw.ticks.tick[r] ?? 0) - tick) return r - 1;
  return r;
}

/** Grid row at or before `tick` (the last row whose tick ≤ tick), at least 0. */
function rowAtOrBefore(raw: RawDemo, tick: number): number {
  const r = rowAtOrAfter(raw.ticks, tick);
  if (r < raw.ticks.count && (raw.ticks.tick[r] ?? 0) === tick) return r;
  return Math.max(0, r - 1);
}

/** Position of slot p at the row at or before `tick` (walking back to its last present row), or absent. */
function posAt(raw: RawDemo, p: number, tick: number): [number, number, number] {
  if (p < 0 || p >= raw.players.length) return [REPLAY_ABSENT, REPLAY_ABSENT, REPLAY_ABSENT];
  const P = raw.players.length;
  for (let r = rowAtOrBefore(raw, tick), n = 0; r >= 0 && n < 64; r--, n++) {
    const i = r * P + p;
    if (raw.ticks.present[i] === 1) return [clamp16(raw.ticks.x[i] ?? NaN), clamp16(raw.ticks.y[i] ?? NaN), clamp16(raw.ticks.z[i] ?? NaN)];
  }
  return [REPLAY_ABSENT, REPLAY_ABSENT, REPLAY_ABSENT];
}

/** The tick range a round's track covers. */
export function trackRange(raw: RawDemo, round: MatchRound, tuning: CoachTuning = COACH_TUNING): { tick0: number; tick1: number } {
  const rate = raw.header.tickRate;
  const first = raw.ticks.tick[0] ?? 0;
  const last = raw.ticks.tick[raw.ticks.count - 1] ?? 0;
  const lead = Math.round(tuning.replay.freezeLeadSec * rate);
  const tick0 = Math.max(first, round.startTick, round.freezeEndTick !== null ? round.freezeEndTick - lead : round.startTick);
  const end = round.officialEndTick ?? round.endTick + Math.round(tuning.replay.postEndSec * rate);
  return { tick0, tick1: Math.max(tick0, Math.min(last, end)) };
}

/**
 * Who carries the bomb at each tick: the bomb events in order (pickup → that player; dropped, planted, round start →
 * nobody). Returns a lookup over a sorted change list.
 */
function bombCarrier(raw: RawDemo): (tick: number) => number {
  const changes: { tick: number; p: number }[] = [];
  for (const e of raw.events.bomb) {
    if (e.kind === 'pickup') changes.push({ tick: e.tick, p: e.p });
    else if (e.kind === 'dropped' || e.kind === 'planted') changes.push({ tick: e.tick, p: -1 });
  }
  return (tick: number): number => {
    let lo = 0;
    let hi = changes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((changes[mid]?.tick ?? 0) <= tick) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? -1 : (changes[lo - 1]?.p ?? -1);
  };
}

const within = <T extends { tick: number }>(list: readonly T[], t0: number, t1: number): T[] => list.filter((e) => e.tick >= t0 && e.tick <= t1);

/** Build the replay track of one round. */
export function buildRoundTrack(raw: RawDemo, match: Match, round: MatchRound, tuning: CoachTuning = COACH_TUNING,
  carrier: (tick: number) => number = bombCarrier(raw)): ReplayTrack {
  const P = raw.players.length;
  const rate = raw.header.tickRate;
  const hz = tuning.replay.hz;
  const step = Math.max(1, Math.round(rate / hz));
  const { tick0, tick1 } = trackRange(raw, round, tuning);
  const samples = Math.floor((tick1 - tick0) / step) + 1;
  const n = samples * P;
  const xy = new Int16Array(n * 2).fill(REPLAY_ABSENT);
  const z = new Int16Array(n).fill(REPLAY_ABSENT);
  const yaw = new Int16Array(n);
  const health = new Uint8Array(n);
  const weapon = new Uint8Array(n);
  const flags = new Uint8Array(n);
  const place = new Uint8Array(n);
  const tk = raw.ticks;

  for (let k = 0; k < samples; k++) {
    const tick = tick0 + k * step;
    const r = nearestRow(raw, tick);
    const bomb = carrier(tick);
    for (let p = 0; p < P; p++) {
      const i = r * P + p;
      const o = k * P + p;
      if (tk.present[i] !== 1) continue;
      xy[o * 2] = clamp16(tk.x[i] ?? NaN);
      xy[o * 2 + 1] = clamp16(tk.y[i] ?? NaN);
      z[o] = clamp16(tk.z[i] ?? NaN);
      yaw[o] = Math.round(wrapDeg(tk.yaw[i] ?? 0));
      const f = tk.flags[i] ?? 0;
      const alive = (f & FLAG.alive) !== 0;
      health[o] = alive ? (tk.health[i] ?? 0) : 0;
      weapon[o] = tk.weapon[i] ?? 0;
      place[o] = tk.place[i] ?? 0;
      let g = 0;
      if (alive) g |= REPLAY_FLAG.alive;
      if (f & FLAG.kit) g |= REPLAY_FLAG.kit;
      if (alive && bomb === p) g |= REPLAY_FLAG.bomb;
      if (f & FLAG.defusing) g |= REPLAY_FLAG.defusing;
      if (f & FLAG.scoped) g |= REPLAY_FLAG.scoped;
      if ((tk.flash[i] ?? 0) > 0) g |= REPLAY_FLAG.flashed;
      if (f & FLAG.airborne) g |= REPLAY_FLAG.airborne;
      if (f & FLAG.reloading) g |= REPLAY_FLAG.reloading;
      flags[o] = g;
    }
  }

  // Sides of this round, from the match's teams.
  const side = new Uint8Array(P);
  const sideOf: Record<TeamId, number> = { A: round.sides.T === 'A' ? TEAM_T : TEAM_CT, B: round.sides.T === 'B' ? TEAM_T : TEAM_CT };
  for (const pl of match.players) {
    if (pl.rounds.includes(round.number)) side[pl.slot] = sideOf[pl.team];
  }

  return {
    round: round.number, tick0, hz, step, samples, players: P,
    phases: { start: round.startTick, freezeEnd: round.freezeEndTick, plant: round.bomb.plantTick, end: round.endTick, officialEnd: round.officialEndTick },
    side, xy, z, yaw, health, weapon, flags, place,
    weapons: raw.names.weapons.slice(), places: raw.names.places.slice(),
    events: roundEvents(raw, tick0, tick1, tuning),
  };
}

/** The events of [tick0, tick1] in replay form. */
export function roundEvents(raw: RawDemo, tick0: number, tick1: number, tuning: CoachTuning = COACH_TUNING): ReplayEvents {
  const P = raw.players.length;
  const rate = raw.header.tickRate;
  const ev = raw.events;

  const kills: ReplayKill[] = within(ev.kills, tick0, tick1).map((k) => {
    const a = posAt(raw, k.attacker, k.tick);
    const v = posAt(raw, k.victim, k.tick);
    return {
      tick: k.tick, attacker: k.attacker, victim: k.victim, assister: k.assister, weapon: k.weapon, headshot: k.headshot,
      penetrated: k.penetrated, thruSmoke: k.thruSmoke, noScope: k.noScope, attackerBlind: k.attackerBlind,
      ax: a[0], ay: a[1], az: a[2], vx: v[0], vy: v[1], vz: v[2],
    };
  });

  // Hits, with the health actually removed (contracts.md "Reconciliation").
  const lastHealth = new Map<number, number>();
  const hurts: ReplayHurt[] = [];
  for (const h of within(ev.hurts, tick0, tick1)) {
    let before = lastHealth.get(h.victim);
    if (before === undefined) {
      const r = rowAtOrAfter(raw.ticks, h.tick) - 1;
      before = r >= 0 && h.victim >= 0 ? (raw.ticks.health[r * P + h.victim] ?? 100) : 100;
    }
    lastHealth.set(h.victim, h.health);
    hurts.push({ tick: h.tick, attacker: h.attacker, victim: h.victim, weapon: h.weapon, damage: Math.max(0, before - h.health), health: h.health, hitgroup: h.hitgroup });
  }

  const shots: ReplayShot[] = within(ev.shots, tick0, tick1).map((s) => {
    const r = rowAtOrBefore(raw, s.tick);
    const i = r * P + s.p;
    const hit = hurts.find((h) => h.tick === s.tick && h.attacker === s.p && h.victim !== s.p);
    return {
      tick: s.tick, p: s.p, weapon: s.weapon,
      x: clamp16(raw.ticks.x[i] ?? NaN), y: clamp16(raw.ticks.y[i] ?? NaN), z: clamp16(raw.ticks.z[i] ?? NaN),
      yaw: Math.round(wrapDeg(raw.ticks.yaw[i] ?? 0)), hit: hit ? hit.victim : -1,
    };
  });

  const blinds = within(ev.blinds, tick0, tick1).map((b) => ({ tick: b.tick, attacker: b.attacker, victim: b.victim, duration: b.duration }));

  const grenades: ReplayGrenade[] = raw.projectiles
    .filter((g) => g.t1 >= tick0 && g.t0 <= tick1)
    .map((g) => ({ type: g.type, thrower: g.thrower, t0: g.t0, t1: g.t1, step: PATH_STEP, path: g.path.slice() }));

  // Effects: smokes and fires run until the expiry event of the same entity (else a fallback lifetime).
  const effects: ReplayEffect[] = [];
  const dets = ev.detonations;
  const endOf = (i: number, endKind: string, fallbackSec: number): number => {
    const d = dets[i];
    if (!d) return 0;
    for (let j = i + 1; j < dets.length; j++) {
      const e = dets[j];
      if (e && e.kind === endKind && e.entity === d.entity && e.tick >= d.tick) return e.tick;
    }
    return d.tick + Math.round(fallbackSec * rate);
  };
  const t = tuning.replay;
  dets.forEach((d, i) => {
    if (d.tick > tick1) return;
    let end: number;
    let kind: ReplayEffect['kind'];
    if (d.kind === 'smoke') { kind = 'smoke'; end = endOf(i, 'smoke_end', t.smokeFallbackSec); }
    else if (d.kind === 'fire') { kind = 'fire'; end = endOf(i, 'fire_end', t.fireFallbackSec); }
    else if (d.kind === 'decoy') { kind = 'decoy'; end = endOf(i, 'decoy_end', t.decoyFallbackSec); }
    else if (d.kind === 'he') { kind = 'he'; end = d.tick + Math.round(t.heSec * rate); }
    else if (d.kind === 'flash') { kind = 'flash'; end = d.tick + Math.round(t.flashSec * rate); }
    else return;
    if (end < tick0) return;
    effects.push({ kind, p: d.p, tick0: d.tick, tick1: end, x: clamp16(d.x), y: clamp16(d.y), z: clamp16(d.z) });
  });

  const bomb: ReplayBombEvent[] = within(ev.bomb, tick0, tick1).map((b) => {
    const pos = posAt(raw, b.p, b.tick);
    return { tick: b.tick, kind: b.kind, p: b.p, site: b.site, hasKit: b.hasKit, x: pos[0], y: pos[1], z: pos[2] };
  });

  return { kills, shots, hurts, blinds, grenades, effects, bomb };
}

/** Replay tracks for every round of the match, in round order. */
export function buildReplay(raw: RawDemo, match: Match, tuning: CoachTuning = COACH_TUNING): ReplayTrack[] {
  const carrier = bombCarrier(raw);
  return match.rounds.map((r) => buildRoundTrack(raw, match, r, tuning, carrier));
}

/** Bytes the tracks take (typed arrays exactly, plain records as their JSON length): the storage budget's measure. */
export function replayBytes(tracks: readonly ReplayTrack[]): number {
  let n = 0;
  for (const t of tracks) {
    n += t.xy.byteLength + t.z.byteLength + t.yaw.byteLength + t.health.byteLength + t.weapon.byteLength + t.flags.byteLength + t.place.byteLength + t.side.byteLength;
    for (const g of t.events.grenades) n += g.path.byteLength + 40;
    const { grenades: _g, ...rest } = t.events;
    void _g;
    n += JSON.stringify(rest).length + JSON.stringify(t.weapons).length + JSON.stringify(t.places).length + 200;
  }
  return n;
}

/** Every ArrayBuffer under the tracks (to transfer them from the worker instead of copying). */
export function replayTransferables(tracks: readonly ReplayTrack[]): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const t of tracks) {
    for (const a of [t.xy, t.z, t.yaw, t.health, t.weapon, t.flags, t.place, t.side]) out.push(a.buffer as ArrayBuffer);
    for (const g of t.events.grenades) out.push(g.path.buffer as ArrayBuffer);
  }
  return out;
}

/**
 * One line per round for the round strip, from the user's point of view: winner, reason, tags, and the user's kills
 * (enemies only), whether he died and the damage he did (health removed from enemies).
 */
export function roundSummaries(raw: RawDemo, match: Match, user: number): RoundSummary[] {
  const P = raw.players.length;
  const teamOf = (p: number): TeamId | null => match.players[p]?.team ?? null;
  const userTeam = teamOf(user);
  return match.rounds.map((r) => {
    const t0 = r.startTick;
    const t1 = r.endTick;
    let kills = 0;
    let died = false;
    for (const k of raw.events.kills) {
      if (k.tick < t0 || k.tick > t1) continue;
      if (k.attacker === user && k.victim !== user && teamOf(k.victim) !== userTeam) kills++;
      if (k.victim === user) died = true;
    }
    let damage = 0;
    const last = new Map<number, number>();
    for (const h of raw.events.hurts) {
      if (h.tick < t0 || h.tick > t1) continue;
      let before = last.get(h.victim);
      if (before === undefined) {
        const row = rowAtOrAfter(raw.ticks, h.tick) - 1;
        before = row >= 0 && h.victim >= 0 ? (raw.ticks.health[row * P + h.victim] ?? 100) : 100;
      }
      last.set(h.victim, h.health);
      if (h.attacker === user && h.victim >= 0 && teamOf(h.victim) !== userTeam) damage += Math.max(0, before - h.health);
    }
    const tags: string[] = [];
    if (userTeam) {
      const buy = r.economy[userTeam]?.buy;
      if (buy) tags.push(buy);
    }
    if (r.bomb.plantTick !== null) tags.push('planted');
    if (r.bomb.defuseTick !== null) tags.push('defused');
    if (r.bomb.explodeTick !== null) tags.push('exploded');
    if (!r.played) tags.push('not played');
    return { number: r.number, winner: r.winner, reasonName: r.reasonName, tags, user: { kills, died, damage } };
  });
}

/** Path sample i of a grenade (null when missing). */
export function grenadeSample(g: ReplayGrenade, i: number): [number, number, number] | null {
  const x = g.path[i * 3];
  const y = g.path[i * 3 + 1];
  const zz = g.path[i * 3 + 2];
  if (x === undefined || y === undefined || zz === undefined || x === PATH_NONE || y === PATH_NONE) return null;
  return [x, y, zz];
}
