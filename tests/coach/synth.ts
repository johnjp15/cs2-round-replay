/**
 * A small builder of synthetic RawDemos for the ingest tests: players, rounds with start / freeze end / end ticks,
 * and who is on which side in which round. The grid holds a row every `step` ticks plus every event tick.
 */
import { FLAG, RAW_FORMAT, TEAM_CT, TEAM_T, allocTicks, emptyEvents } from '../../src/coach/model/raw';
import type { RawDemo, RawInventory, RawRoundEvent } from '../../src/coach/model/raw';

export interface SynthRound {
  start: number;
  /** null = no freeze end (a surrender in freeze time, or a round restarted in freeze time). */
  freezeEnd?: number | null;
  /** null = no end (cut off or restarted). */
  end?: number | null;
  winner?: number;
  reason?: number;
  warmup?: boolean;
  /** Equipment value per present player at freeze end (default 4000). */
  equip?: number;
  /** Inventory per player at freeze end (default rifle). */
  items?: string[];
}

export interface SynthSpec {
  players: { name: string; bot?: boolean }[];
  /** Team number (2, 3, or 0 = absent) of player p in round index r. */
  team: (r: number, p: number) => number;
  rounds: SynthRound[];
  /** Tick of begin_new_match (omit for a demo that starts mid-match). */
  matchStart?: number;
  /** total_rounds_played at the first round (default 0). */
  firstRoundsPlayed?: number;
  /** Score (T, CT) on the first row (default 0, 0). */
  firstScore?: [number, number];
  step?: number;
}

export function synthDemo(spec: SynthSpec): RawDemo {
  const P = spec.players.length;
  const step = spec.step ?? 16;
  const events = emptyEvents();
  const rp0 = spec.firstRoundsPlayed ?? 0;
  const rounds: RawRoundEvent[] = [];
  const ev = (tick: number, kind: RawRoundEvent['kind'], roundsPlayed: number, warmup = false, winner = 0, reason = 0): void => {
    rounds.push({ tick, kind, roundsPlayed, warmup, winner, reason, message: '' });
  };
  if (spec.matchStart !== undefined) ev(spec.matchStart, 'match_start', 0);
  let played = rp0;
  spec.rounds.forEach((r, k) => {
    const warm = r.warmup ?? false;
    ev(r.start, 'start', played, warm);
    if (r.freezeEnd !== null) ev(r.freezeEnd ?? r.start + 64, 'freeze_end', played, warm);
    if (r.end !== null) {
      const end = r.end ?? (r.freezeEnd ?? r.start + 64) + 640;
      ev(end, 'end', played, warm, r.winner ?? TEAM_T, r.reason ?? 9);
      if (!warm) played++;
      const next = spec.rounds[k + 1];
      if (next) ev(next.start, 'officially_ended', played, warm);
    }
  });
  rounds.sort((a, b) => a.tick - b.tick);
  events.rounds = rounds;

  // Grid ticks: from the first non-warmup start (or the match start) to the last tick of interest.
  const ticksOfInterest = rounds.map((r) => r.tick);
  const first = spec.matchStart ?? spec.rounds.find((r) => !r.warmup)?.start ?? 0;
  const last = Math.max(...ticksOfInterest);
  const set = new Set<number>();
  for (let t = first; t <= last; t += step) set.add(t);
  for (const t of ticksOfInterest) if (t >= first) set.add(t);
  const tickList = [...set].sort((a, b) => a - b);
  const T = tickList.length;
  const ticks = allocTicks(T, P);
  const roundAt = (tick: number): number => {
    let idx = -1;
    spec.rounds.forEach((r, k) => { if (!r.warmup && r.start <= tick) idx = k; });
    return Math.max(0, idx);
  };
  const score = [...(spec.firstScore ?? [0, 0])] as [number, number];
  tickList.forEach((tick, t) => {
    ticks.tick[t] = tick;
    const k = roundAt(tick);
    ticks.roundsPlayed[t] = rp0 + spec.rounds.slice(0, k).filter((r) => !r.warmup && r.end !== null).length;
    ticks.scoreT[t] = score[0];
    ticks.scoreCT[t] = score[1];
    for (let p = 0; p < P; p++) {
      const team = spec.team(k, p);
      if (team !== TEAM_T && team !== TEAM_CT) continue;
      const i = t * P + p;
      ticks.present[i] = 1;
      ticks.team[i] = team;
      ticks.health[i] = 100;
      ticks.flags[i] = FLAG.alive | FLAG.connected;
      ticks.equip[i] = spec.rounds[k]?.equip ?? 4000;
      ticks.money[i] = 800;
    }
  });

  const inventories: RawInventory[] = [];
  spec.rounds.forEach((r, k) => {
    if (r.freezeEnd === null) return;
    const tick = r.freezeEnd ?? r.start + 64;
    for (let p = 0; p < P; p++) {
      if (spec.team(k, p) === 0) continue;
      inventories.push({ tick, p, at: 'freeze_end', items: [...(r.items ?? ['ak47', 'glock', 'knife'])].sort() });
    }
  });

  return {
    format: RAW_FORMAT,
    header: { map: 'de_synth', server: 'synthetic', source: 'other', gotv: true, patch: null, tickRate: 64, demoSha256: '0'.repeat(64), bytes: 0, parser: 'synth' },
    players: spec.players.map((pl, p) => ({ steamId: pl.bot ? `BOT-${pl.name}` : `7656119900000${String(p + 1).padStart(4, '0')}`, name: pl.name, bot: pl.bot ?? false })),
    names: { weapons: [''], places: [''] },
    ticks,
    events,
    projectiles: [],
    inventories,
    scoreboard: { tick: last, rows: [] },
  };
}

/** Two players per side by default: slots 0–1 start T, 2–3 start CT; sides swap from round index `swapAt` on. */
export function fourPlayers(swapAt = Infinity): Pick<SynthSpec, 'players' | 'team'> {
  return {
    players: [{ name: 'a1' }, { name: 'a2' }, { name: 'b1' }, { name: 'b2' }],
    team: (r, p) => {
      const startsT = p < 2;
      const swapped = r >= swapAt;
      return startsT !== swapped ? TEAM_T : TEAM_CT;
    },
  };
}

/** Consecutive rounds of `len` ticks starting at `t0`. */
export function roundsFrom(t0: number, n: number, len = 1000, extra: Partial<SynthRound> = {}): SynthRound[] {
  return Array.from({ length: n }, (_, k) => ({ start: t0 + k * len, freezeEnd: t0 + k * len + 100, end: t0 + k * len + 900, ...extra }));
}
