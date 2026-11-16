/**
 * K4 table `economy.buys`: one row per player and played round.
 *
 * - Purchases: `item_purchase` from the round start through the round's `buytime_ended` (fallback: freeze end +
 *   `buys.buyTimeSec`), checked against the money column (`purchasesOf`): in the test demo the event re-sends the
 *   player's whole purchase list whenever it changes (90 records come after buy time, and its `was_sold` flag marks
 *   items replaced later, e.g. a vest upgraded to a helmet), so only the records that the balance change on their tick
 *   pays for are purchases, and a balance rise on a record's tick is a sale of the bought items it refunds.
 * - Money at the round's start row, equipment value at freeze end, money left at the end of buy time.
 * - Armor, helmet and kit at the end of buy time (the tick grid); the loadout after the buy = the freeze-end inventory
 *   plus what was bought after freeze end (the demo records inventories at freeze end, deaths and round ends only).
 * - The player's own buy class from his equipment value after the buy (the larger of freeze end and buy end) with the team thresholds (`economy` in data/coach/tuning.json);
 *   the team's buy type from `Match`.
 */
import type { BuyType, Side, TeamId } from '../../model/match';
import { FLAG } from '../../model/raw';
import { cell, flag, present, rowAt, rowBefore, secToTicks, sideOf } from '../positioning/grid';
import type { AnalysisContext, TableDef } from '../../analyze/context';
import { isGrenade, isPrimary, itemKind, itemPrice } from './prices';
import { ECONOMY_TUNING } from './tuning';

export interface BuyRow {
  round: number;
  p: number;
  team: TeamId;
  side: Side;
  moneyStart: number;
  /** Items bought in buy time, sold-back ones removed, in purchase order. */
  bought: string[];
  spent: number;
  equipFreeze: number;
  /** Equipment value after the buy (end of buy time, or just before an earlier death): late buys included. */
  equipAfterBuy: number;
  /** After the buy (end of buy time, or the player's death if earlier). */
  armor: number;
  helmet: boolean;
  kit: boolean;
  /** Items carried after the buy (sorted) and the grenades among them. */
  items: string[];
  grenades: string[];
  primary: string | null;
  moneyLeft: number;
  /** The player's own class from his equipment value after the buy; the team's from `Match` (freeze end). */
  buyClass: BuyType;
  teamBuy: BuyType;
}

export function buyClassOf(ctx: Pick<AnalysisContext, 'tuning'>, roundNumber: number, kind: string, equip: number): BuyType {
  const e = ctx.tuning.economy;
  if (kind === 'regulation' && ctx.tuning.rounds.pistolRounds.includes(roundNumber)) return 'pistol';
  if (equip < e.ecoBelowPerPlayer) return 'eco';
  if (equip >= e.fullFromPerPlayer) return 'full';
  return 'force';
}

export interface Bought {
  item: string;
  tick: number;
  cost: number;
}

/** Subset of `items` (indexes, at most 8 considered) whose costs sum to `target`; latest entries preferred. */
function subsetSum(costs: readonly number[], target: number): number[] | null {
  const n = Math.min(costs.length, 8);
  const off = costs.length - n;
  let best: number[] | null = null;
  let bestKey = -1;
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0;
    let key = 0;
    const pick: number[] = [];
    for (let i = 0; i < n; i++) {
      if ((mask & (1 << i)) === 0) continue;
      sum += costs[off + i] ?? 0;
      key += 1 << i;
      pick.push(off + i);
    }
    if (sum !== target) continue;
    // Fewest items first, then the latest ones.
    const score = (16 - pick.length) * 65536 + key;
    if (score > bestKey) { bestKey = score; best = pick; }
  }
  return best;
}

/**
 * The player's purchases in [t0, t1], from `item_purchase` checked against `money`: per tick with records, the
 * balance change on that tick (row at the tick minus the row before) is either paid by a subset of that tick's records
 * (those are purchases) or, when it rises, refunds a subset of the items bought so far (those are sold back). A tick
 * whose change matches nothing keeps its records only when the change is a fall at least their total cost.
 */
export function purchasesOf(ctx: Pick<AnalysisContext, 'raw'>, p: number, t0: number, t1: number): Bought[] {
  const { raw } = ctx;
  const ticks: number[] = [];
  const by = new Map<number, Bought[]>();
  for (const e of raw.events.purchases) {
    if (e.p !== p || e.tick < t0 || e.tick > t1) continue;
    const g = by.get(e.tick);
    if (g) g.push({ item: e.item, tick: e.tick, cost: e.cost });
    else { by.set(e.tick, [{ item: e.item, tick: e.tick, cost: e.cost }]); ticks.push(e.tick); }
  }
  const out: Bought[] = [];
  for (const tick of ticks) {
    const group = by.get(tick) ?? [];
    const now = rowAt(raw, tick);
    if (raw.ticks.tick[now] !== tick) continue;
    const delta = (raw.ticks.money[cell(raw, now, p)] ?? 0) - (raw.ticks.money[cell(raw, rowBefore(raw, tick), p)] ?? 0);
    if (delta < 0) {
      const pick = subsetSum(group.map((b) => b.cost), -delta);
      if (pick) for (const i of pick) out.push(group[i] as Bought);
      else if (group.reduce((s, b) => s + b.cost, 0) <= -delta) out.push(...group);
    } else if (delta > 0) {
      const pick = subsetSum(out.map((b) => b.cost), delta);
      if (pick) for (const i of [...pick].sort((a, b) => b - a)) out.splice(i, 1);
    }
  }
  return out;
}

export function buildBuys(ctx: AnalysisContext): BuyRow[] {
  const { raw, match } = ctx;
  const tune = ECONOMY_TUNING.buys;
  const out: BuyRow[] = [];
  for (const round of match.rounds) {
    if (!round.played || round.freezeEndTick === null) continue;
    let buyEnd = round.freezeEndTick + secToTicks(raw, tune.buyTimeSec);
    for (const e of raw.events.rounds) {
      if (e.kind === 'buytime_ended' && e.tick >= round.freezeEndTick && e.tick <= round.endTick) { buyEnd = e.tick; break; }
    }
    buyEnd = Math.min(buyEnd, round.endTick);
    const rStart = round.rowStart;
    const rFreeze = round.refRow;
    for (const team of ['A', 'B'] as const) {
      for (const p of round.roster[team]) {
        if (!present(raw, rFreeze, p)) continue;
        const bought = purchasesOf(ctx, p, round.startTick, buyEnd);
        const freezeInv = raw.inventories.find((v) => v.at === 'freeze_end' && v.p === p && v.tick === round.freezeEndTick)?.items ?? [];
        const items = [...freezeInv];
        for (const b of bought) {
          if (b.tick <= (round.freezeEndTick ?? 0)) continue;
          if (b.item === 'vest' || b.item === 'vesthelm' || b.item === 'defuser') continue;
          items.push(b.item);
        }
        items.sort();
        // Death during buy time: read the state just before it.
        let endTick = buyEnd;
        for (const k of raw.events.kills) if (k.victim === p && k.tick >= round.freezeEndTick && k.tick < endTick) { endTick = k.tick - 1; break; }
        const rEnd = rowAt(raw, endTick);
        const primaries = items.filter(isPrimary);
        primaries.sort((a, b) => itemPrice(b) - itemPrice(a) || (a < b ? -1 : a > b ? 1 : 0));
        const equip = raw.ticks.equip[cell(raw, rFreeze, p)] ?? 0;
        out.push({
          round: round.number, p, team, side: sideOf(round, team) as Side,
          moneyStart: raw.ticks.money[cell(raw, rStart, p)] ?? 0,
          bought: bought.map((b) => b.item), spent: bought.reduce((s, b) => s + b.cost, 0),
          equipFreeze: equip, equipAfterBuy: raw.ticks.equip[cell(raw, rEnd, p)] ?? 0,
          armor: raw.ticks.armor[cell(raw, rEnd, p)] ?? 0, helmet: flag(raw, rEnd, p, FLAG.helmet), kit: flag(raw, rEnd, p, FLAG.kit),
          items, grenades: items.filter(isGrenade), primary: primaries[0] ?? null,
          moneyLeft: raw.ticks.money[cell(raw, rEnd, p)] ?? 0,
          buyClass: buyClassOf(ctx, round.number, round.kind, Math.max(equip, raw.ticks.equip[cell(raw, rEnd, p)] ?? 0)), teamBuy: round.economy[team].buy,
        });
      }
    }
  }
  return out;
}

/** Rifle or sniper. */
export function isRifle(item: string | null): boolean {
  if (item === null) return false;
  const k = itemKind(item);
  return k === 'rifle' || k === 'sniper';
}

export const BUYS: TableDef<BuyRow[]> = { id: 'economy.buys', build: buildBuys };
