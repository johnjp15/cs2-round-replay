/**
 * Shared table: every `player_hurt` with the health it actually removed (health before − health after; never
 * `dmg_health`, docs/coach/contracts.md "Reconciliation") and the round it belongs to. Health resets to 100 at each
 * round start, as in `computeScoreboard`.
 */
import type { TableDef } from '../analyze/context';
import type { RawHurt } from '../model/raw';

export interface HurtRow {
  /** Index into `raw.events.hurts`. */
  readonly i: number;
  readonly hurt: RawHurt;
  /** Health removed (0 when the hit did nothing). */
  readonly damage: number;
  /** Health before the hit. */
  readonly before: number;
  /** Round number, or 0 outside rounds. */
  readonly round: number;
  /** Attacker and victim are on different teams (both players). */
  readonly enemy: boolean;
}

export const HURTS: TableDef<HurtRow[]> = {
  id: 'core.hurts',
  build(ctx) {
    const rounds = ctx.match.rounds;
    const health = new Array<number>(ctx.P).fill(100);
    let next = 0;
    let cur = 0;
    const out: HurtRow[] = [];
    ctx.raw.events.hurts.forEach((h, i) => {
      while (next < rounds.length && (rounds[next]?.startTick ?? Infinity) <= h.tick) {
        health.fill(100);
        next++;
      }
      const r = rounds[next - 1];
      cur = r !== undefined && h.tick <= r.endTick ? r.number : 0;
      const before = h.victim >= 0 ? (health[h.victim] ?? 100) : 100;
      if (h.victim >= 0) health[h.victim] = h.health;
      const ta = ctx.teamOf(h.attacker);
      const tv = ctx.teamOf(h.victim);
      out.push({ i, hurt: h, damage: Math.max(0, before - h.health), before, round: cur, enemy: ta !== null && tv !== null && ta !== tv });
    });
    return out;
  },
};
