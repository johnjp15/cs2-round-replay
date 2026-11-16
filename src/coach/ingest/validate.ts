/**
 * Scoreboard reconciliation: kills, deaths, assists, damage, headshot kills, enemies flashed and utility damage
 * computed from the events must equal the demo's own totals (`RawDemo.scoreboard`, read at the last round's end) for
 * every player. Our counting rules mirror the game's (docs/coach/contracts.md "Reconciliation"):
 * - only events from the live start through the scoreboard tick;
 * - kills: +1 per enemy killed, −1 per teammate killed, suicides and world deaths give the victim a death only;
 * - assists: assister on the other team than the victim (flash assists included);
 * - damage: health actually removed from enemies (victim's health before the hit − after it, so a 120 hit on a 30-HP
 *   player counts 30), team damage excluded;
 * - utility damage: the same for HE grenades and fire (molotov / incendiary);
 * - enemies flashed: `player_blind` on an enemy who is alive, longer than `blindMinSec` (tuning, 1.1 s as Leetify).
 *   The game's own counter follows a rule `player_blind` does not expose (no duration threshold reproduces it: in the
 *   test demo one flash that blinded four enemies for 0.8–3.8 s counts 2), so this stat is approximate and is not
 *   part of `ok`; the difference is printed.
 */
import type { Match, TeamId } from '../model/match';
import { FLAG, rowAtOrAfter } from '../model/raw';
import type { RawDemo } from '../model/raw';
import { COACH_TUNING } from '../tuning';
import type { CoachTuning } from '../tuning';

export const STAT_KEYS = ['kills', 'deaths', 'assists', 'damage', 'headshotKills', 'enemiesFlashed', 'utilityDamage'] as const;
export type StatKey = (typeof STAT_KEYS)[number];
/** The stats that must match exactly; `enemiesFlashed` is approximate (see above). */
export const EXACT_KEYS: readonly StatKey[] = ['kills', 'deaths', 'assists', 'damage', 'headshotKills', 'utilityDamage'];
export type StatLine = Record<StatKey, number>;

export interface ReconRow {
  p: number;
  ours: StatLine;
  demo: StatLine | null;
  /** ours − demo per stat (0 = reconciled); null when the demo has no row for the slot. */
  diff: StatLine | null;
}

export interface Reconciliation {
  tick: number;
  rows: ReconRow[];
  /** Every exact stat (`EXACT_KEYS`) of every player matches. */
  ok: boolean;
  /** Count of (player, exact stat) pairs that differ. */
  mismatches: number;
  /** Count of players whose approximate enemies-flashed count differs. */
  flashMismatches: number;
}

function aliveAt(raw: RawDemo, tick: number, p: number): boolean {
  const t = rowAtOrAfter(raw.ticks, tick);
  if (t >= raw.ticks.count) return false;
  const i = t * raw.players.length + p;
  return raw.ticks.present[i] === 1 && ((raw.ticks.flags[i] ?? 0) & FLAG.alive) !== 0;
}

const UTILITY = new Set(['hegrenade', 'inferno', 'molotov', 'incgrenade']);

const zero = (): StatLine => ({ kills: 0, deaths: 0, assists: 0, damage: 0, headshotKills: 0, enemiesFlashed: 0, utilityDamage: 0 });

/** Our scoreboard from the events. */
export function computeScoreboard(raw: RawDemo, match: Match, tuning: CoachTuning = COACH_TUNING): StatLine[] {
  const P = raw.players.length;
  const lines = Array.from({ length: P }, zero);
  const team = (p: number): TeamId | null => match.players[p]?.team ?? null;
  const t0 = match.rounds[0]?.startTick ?? 0;
  const t1 = raw.scoreboard.tick;
  const inWindow = (tick: number): boolean => tick >= t0 && tick <= t1;
  const enemies = (a: number, b: number): boolean => a >= 0 && b >= 0 && team(a) !== null && team(b) !== null && team(a) !== team(b);

  for (const k of raw.events.kills) {
    if (!inWindow(k.tick)) continue;
    const v = lines[k.victim];
    if (v) v.deaths++;
    const a = lines[k.attacker];
    if (a && k.attacker !== k.victim) {
      if (enemies(k.attacker, k.victim)) {
        a.kills++;
        if (k.headshot) a.headshotKills++;
      } else if (k.victim >= 0) a.kills--;
    }
    const s = lines[k.assister];
    if (s && enemies(k.assister, k.victim)) s.assists++;
  }

  // Damage, capped at the victim's remaining health; health resets at each round start.
  const health = new Array<number>(P).fill(100);
  const starts = match.rounds.map((r) => r.startTick);
  let next = 0;
  for (const h of raw.events.hurts) {
    if (!inWindow(h.tick)) continue;
    while (next < starts.length && (starts[next] ?? Infinity) <= h.tick) { health.fill(100); next++; }
    const prev = health[h.victim] ?? 100;
    // Health actually removed. Not min(dmg_health, prev): the event's dmg_health is sometimes a point or two below the
    // health the hit removed (rounding of fractional damage), and the game's damage_total follows the health.
    const removed = Math.max(0, prev - h.health);
    if (h.victim >= 0) health[h.victim] = h.health;
    const a = lines[h.attacker];
    if (!a || !enemies(h.attacker, h.victim)) continue;
    a.damage += removed;
    if (UTILITY.has(h.weapon)) a.utilityDamage += removed;
  }

  for (const b of raw.events.blinds) {
    if (!inWindow(b.tick)) continue;
    const a = lines[b.attacker];
    if (a && enemies(b.attacker, b.victim) && b.duration > tuning.validate.blindMinSec && aliveAt(raw, b.tick, b.victim)) a.enemiesFlashed++;
  }
  return lines;
}

export function reconcile(raw: RawDemo, match: Match, tuning: CoachTuning = COACH_TUNING): Reconciliation {
  const ours = computeScoreboard(raw, match, tuning);
  let mismatches = 0;
  let flashMismatches = 0;
  const rows: ReconRow[] = ours.map((line, p) => {
    const d = raw.scoreboard.rows.find((r) => r.p === p);
    if (!d) return { p, ours: line, demo: null, diff: null };
    const demo: StatLine = {
      kills: d.kills, deaths: d.deaths, assists: d.assists, damage: d.damage, headshotKills: d.headshotKills,
      enemiesFlashed: d.enemiesFlashed, utilityDamage: d.utilityDamage,
    };
    const diff = zero();
    for (const k of STAT_KEYS) {
      diff[k] = line[k] - demo[k];
      if (diff[k] === 0) continue;
      if (EXACT_KEYS.includes(k)) mismatches++;
      else flashMismatches++;
    }
    return { p, ours: line, demo, diff };
  });
  return { tick: raw.scoreboard.tick, rows, ok: mismatches === 0, mismatches, flashMismatches };
}
