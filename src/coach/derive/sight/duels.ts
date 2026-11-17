/**
 * K6 table `sight.duels`: one row per meeting of two enemies (docs/coach/sight.md, "Duels").
 *
 * A meeting joins the sightings of one enemy pair in one round, both directions, whose gaps are at most
 * `duels.mergeGapSec`. For each side: the first row it saw the other, its first bullet at him (K2's `TARGETS`), its
 * first damaging hit, the damage it did, whether it was holding still or moving at its first sight (the one-tick
 * velocity lag applied: `speedAt`) and the weapon in hand. Shots and damage count from `preSec` before the meeting to
 * `postSec` after its last sighting (or the kill). The outcome: `kill` when one killed the other in that window,
 * `other` when one of them died to someone else, else `disengaged`.
 */
import type { AnalysisContext, TableDef } from '../../analyze/context';
import { HURTS } from '../hurts';
import { SHOTS } from '../aim/shots';
import { TARGETS } from '../aim/targets';
import { speedAt } from '../movement/speed';
import { rowAtOrAfter } from '../../model/raw';
import { SEE, SIGHTINGS, type Sighting } from './sightings';
import { SIGHT_TUNING } from './tuning';

export interface DuelSide {
  readonly p: number;
  /** First tick / row this side saw the other in the meeting (null: never). */
  readonly sightTick: number | null;
  readonly sightRow: number | null;
  /** The other's head point was visible at that row. */
  readonly sightHead: boolean;
  /** First bullet at the other (index into SHOTS / raw bullets) and its tick. */
  readonly shotTick: number | null;
  readonly shot: number | null;
  readonly shots: number;
  /** First hurt with damage on the other (index into HURTS) and its tick. */
  readonly damageTick: number | null;
  readonly hurt: number | null;
  readonly damage: number;
  /** Speed (units/s) at the first sight (or the meeting's start when it never saw), and holding = speed ≤ holdSpeed. */
  readonly speed: number;
  readonly holding: boolean;
  readonly weapon: string;
}

export interface DuelRow {
  readonly id: number;
  readonly round: number;
  /** a.p < b.p. */
  readonly a: DuelSide;
  readonly b: DuelSide;
  /** First and last row / tick of the merged sightings. */
  readonly r0: number;
  readonly r1: number;
  readonly tick0: number;
  readonly tick1: number;
  readonly outcome: 'kill' | 'other' | 'disengaged';
  /** The killer's slot when outcome is `kill`, else -1; and the kill tick. */
  readonly winner: number;
  readonly killTick: number | null;
  /** Eye to eye at the first row, units. */
  readonly distance: number;
}

export interface DuelTables {
  readonly available: boolean;
  readonly duels: readonly DuelRow[];
}

/** The side of a duel for slot p (null when p is in neither side). */
export function sideOf(d: DuelRow, p: number): { me: DuelSide; them: DuelSide } | null {
  if (d.a.p === p) return { me: d.a, them: d.b };
  if (d.b.p === p) return { me: d.b, them: d.a };
  return null;
}

export const DUELS: TableDef<DuelTables> = {
  id: 'sight.duels',
  build(ctx) {
    const tab = ctx.table(SIGHTINGS);
    if (!tab.available) return { available: false, duels: [] };
    const raw = ctx.raw;
    const T = raw.ticks;
    const P = ctx.P;
    const rate = raw.header.tickRate || 64;
    const tun = SIGHT_TUNING.duels;
    const gap = Math.round(tun.mergeGapSec * rate);
    const pre = Math.round(tun.preSec * rate);
    const post = Math.round(tun.postSec * rate);
    const { shots } = ctx.table(SHOTS);
    const targets = ctx.table(TARGETS).rows;
    const hurts = ctx.table(HURTS);
    const kills = raw.events.kills;

    // Group sightings by round and unordered pair.
    const groups = new Map<number, Sighting[]>();
    for (const s of tab.sightings) {
      const k = (s.round * P + Math.min(s.obs, s.tgt)) * P + Math.max(s.obs, s.tgt);
      const l = groups.get(k);
      if (l === undefined) groups.set(k, [s]);
      else l.push(s);
    }
    const meetings: { round: number; a: number; b: number; list: Sighting[] }[] = [];
    for (const k of [...groups.keys()].sort((x, y) => x - y)) {
      const list = (groups.get(k) as Sighting[]).slice().sort((x, y) => x.r0 - y.r0 || x.obs - y.obs);
      const first = list[0] as Sighting;
      const a = Math.min(first.obs, first.tgt);
      const b = Math.max(first.obs, first.tgt);
      let cur: Sighting[] = [];
      let end = -Infinity;
      for (const s of list) {
        if (cur.length > 0 && s.r0 > end + gap) {
          meetings.push({ round: first.round, a, b, list: cur });
          cur = [];
        }
        cur.push(s);
        end = Math.max(cur.length === 1 ? -Infinity : end, s.r1);
      }
      if (cur.length > 0) meetings.push({ round: first.round, a, b, list: cur });
    }

    const duels: DuelRow[] = [];
    for (const m of meetings) {
      const r0 = Math.min(...m.list.map((s) => s.r0));
      const r1 = Math.max(...m.list.map((s) => s.r1));
      const tick0 = T.tick[r0] ?? 0;
      const tick1 = T.tick[r1] ?? 0;
      let killTick: number | null = null;
      let winner = -1;
      let other = false;
      for (const k of kills) {
        if (k.tick < tick0) continue;
        if (k.tick > tick1 + post) break;
        if ((k.attacker === m.a && k.victim === m.b) || (k.attacker === m.b && k.victim === m.a)) {
          killTick = k.tick;
          winner = k.attacker;
          break;
        }
        if ((k.victim === m.a || k.victim === m.b) && killTick === null) other = true;
      }
      const w0 = tick0 - pre;
      const w1 = killTick ?? tick1 + post;
      const side = (p: number, q: number): DuelSide => {
        const mine = m.list.filter((s) => s.obs === p);
        const sightRow = mine.length > 0 ? Math.min(...mine.map((s) => s.r0)) : null;
        let shot: number | null = null;
        let nShots = 0;
        for (const s of shots) {
          if (s.p !== p || s.tick < w0) continue;
          if (s.tick > w1) break;
          if (targets[s.i]?.target !== q) continue;
          nShots++;
          if (shot === null) shot = s.i;
        }
        let hurt: number | null = null;
        let damage = 0;
        for (const h of hurts) {
          if (h.hurt.tick < w0) continue;
          if (h.hurt.tick > w1) break;
          if (h.hurt.attacker !== p || h.hurt.victim !== q || h.damage <= 0) continue;
          damage += h.damage;
          if (hurt === null) hurt = h.i;
        }
        const sr = sightRow ?? r0;
        const speed = speedAt(raw, sr, p);
        const wi = T.weapon[sr * P + p] ?? 0;
        return {
          p, sightTick: sightRow === null ? null : (T.tick[sightRow] ?? 0), sightRow,
          sightHead: sightRow !== null && ((tab.state[(sightRow * P + p) * P + q] ?? 0) & SEE.head) !== 0,
          shotTick: shot === null ? null : (shots[shot]?.tick ?? null), shot, shots: nShots,
          damageTick: hurt === null ? null : (hurts[hurt]?.hurt.tick ?? null), hurt, damage,
          speed: Math.round(speed * 10) / 10, holding: speed <= tun.holdSpeed, weapon: raw.names.weapons[wi] ?? '',
        };
      };
      const ia = r0 * P + m.a;
      const ib = r0 * P + m.b;
      const distance = Math.hypot((T.x[ia] ?? 0) - (T.x[ib] ?? 0), (T.y[ia] ?? 0) - (T.y[ib] ?? 0), (T.z[ia] ?? 0) - (T.z[ib] ?? 0));
      duels.push({
        id: duels.length, round: m.round, a: side(m.a, m.b), b: side(m.b, m.a), r0, r1, tick0, tick1,
        outcome: killTick !== null ? 'kill' : other ? 'other' : 'disengaged', winner, killTick, distance: Math.round(distance),
      });
    }
    duels.sort((x, y) => x.tick0 - y.tick0 || x.a.p - y.a.p || x.b.p - y.b.p);
    return { available: true, duels: duels.map((d, id) => ({ ...d, id })) };
  },
};

/** Row of a tick (clamped). */
export function rowOfTick(ctx: AnalysisContext, tick: number): number {
  return Math.min(ctx.raw.ticks.count - 1, rowAtOrAfter(ctx.raw.ticks, tick));
}
