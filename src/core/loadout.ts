/**
 * The loadout ledger (B5): what every pawn carries, as far as the Core can tell. A resync rewind (no engine snapshot,
 * CS2) has to give every pawn back the items it had at the checkpoint, but `Observe` shows only the held weapon and
 * its ammo, so the Core keeps the rest itself, from:
 *
 * - its own actions: the setup's and B3's `give`s (a gun replaces its entry; each grenade, c4 or defuser `give` adds
 *   one), and `strip` (everything but the knife goes);
 * - every observe: the held item's clip and reserve (ammo only changes while a gun is held: firing, reloading), a
 *   held item the ledger lacks (added), the c4 from `round.bomb` (the carrier has it; dropped, planted, defused or
 *   exploded: nobody), and grenade pops (`sound` kind `grenade`): one grenade of the thrower goes, the kind he was last
 *   seen holding if he still has one, else his first. A grenade in flight is still in the ledger until it pops.
 *
 * `helmet` comes from the round's kit: nobody buys mid-round, and CS2 keeps a helmet until death.
 *
 * Plain data in the Core snapshot; pure functions, ids in PLAYER_IDS order, items sorted ordinally (duplicates in
 * the order they were added), like Sim2DHost's inventory.
 */
import { GRENADE_IDS, PLAYER_IDS, compareOrdinal, type Action, type GrenadeId, type ItemId, type Observe, type PlayerId } from '../contracts/index';
import type { RoundModel } from './round-model';

export interface LoadoutItem {
  readonly item: ItemId;
  readonly clip: number;
  readonly reserve: number;
}

export interface PawnLoadout {
  readonly id: PlayerId;
  /** Everything carried except the knife (every pawn has one), sorted by item. */
  items: LoadoutItem[];
  readonly helmet: boolean;
  /** The grenade this pawn was last seen holding (pop attribution), or null. */
  lastGrenade: GrenadeId | null;
}

/** One per player, PLAYER_IDS order. */
export type LoadoutState = PawnLoadout[];

/** Before the setup: knives only. */
export function initialLoadouts(model: RoundModel): LoadoutState {
  return PLAYER_IDS.map((id) => ({ id, items: [], helmet: model.player(id).helmet, lastGrenade: null }));
}

export function copyLoadouts(s: readonly PawnLoadout[]): LoadoutState {
  return s.map((p) => ({ id: p.id, items: p.items.map((q) => ({ item: q.item, clip: q.clip, reserve: q.reserve })), helmet: p.helmet, lastGrenade: p.lastGrenade }));
}

export function isGrenadeItem(item: string): item is GrenadeId {
  return (GRENADE_IDS as readonly string[]).includes(item);
}

function find(s: LoadoutState, id: PlayerId): PawnLoadout {
  const p = s.find((q) => q.id === id);
  if (p === undefined) throw new Error(`loadout: unknown pawn ${id}`);
  return p;
}

function sorted(items: LoadoutItem[]): LoadoutItem[] {
  // Array.prototype.sort is stable: duplicates keep their order.
  return items.sort((a, b) => compareOrdinal(a.item, b.item));
}

/** Add one item: a grenade, c4 or defuser adds an entry; a gun replaces its entry (the engines' `give`). */
function add(p: PawnLoadout, item: LoadoutItem): void {
  const stackable = isGrenadeItem(item.item);
  const kept = stackable ? p.items : p.items.filter((q) => q.item !== item.item);
  p.items = sorted([...kept, { item: item.item, clip: item.clip, reserve: item.reserve }]);
}

function removeOne(p: PawnLoadout, item: ItemId): boolean {
  const i = p.items.findIndex((q) => q.item === item);
  if (i < 0) return false;
  p.items = [...p.items.slice(0, i), ...p.items.slice(i + 1)];
  return true;
}

/**
 * What an observe tells: the held item and its ammo, grenade pops and the c4. On the setup step the observe predates
 * the setup (everyone holds a knife at the origin) and changes nothing that matters.
 */
export function noteObserve(s: LoadoutState, o: Observe): void {
  for (const pawn of o.pawns) {
    const p = find(s, pawn.id);
    if (!pawn.alive) continue;
    const held: string = pawn.weapon;
    if (held === 'knife') continue;
    if (isGrenadeItem(held)) p.lastGrenade = held;
    const i = p.items.findIndex((q) => q.item === held);
    if (i < 0) {
      // Held but not in the ledger: it is carried.
      add(p, { item: pawn.weapon, clip: pawn.ammo.clip, reserve: pawn.ammo.reserve });
    } else {
      const q = p.items[i] as LoadoutItem;
      if (q.clip !== pawn.ammo.clip || q.reserve !== pawn.ammo.reserve) {
        p.items = p.items.map((x, j) => (j === i ? { item: x.item, clip: pawn.ammo.clip, reserve: pawn.ammo.reserve } : x));
      }
    }
  }
  for (const e of o.events) {
    if (e.type !== 'sound' || e.kind !== 'grenade' || e.source === null) continue;
    const p = find(s, e.source);
    const last = p.lastGrenade;
    if (last !== null && removeOne(p, last)) continue;
    const first = p.items.find((q) => isGrenadeItem(q.item));
    if (first !== undefined) removeOne(p, first.item);
  }
  const b = o.round.bomb;
  if (b.state === 'carried' && b.carrier === null) return;
  for (const p of s) {
    const has = p.items.some((q) => q.item === 'c4');
    const should = b.state === 'carried' && b.carrier === p.id;
    if (has && !should) removeOne(p, 'c4');
    if (!has && should) add(p, { item: 'c4', clip: 0, reserve: 0 });
  }
}

/** The Core's own inventory actions: `give` and `strip` (in Act order). */
export function noteActions(s: LoadoutState, actions: readonly Action[]): void {
  for (const a of actions) {
    if (a.type === 'give') add(find(s, a.id), { item: a.item, clip: a.clip, reserve: a.reserve });
    else if (a.type === 'strip') find(s, a.id).items = [];
  }
}

/** A pawn's ledger entry. */
export function loadoutOf(s: readonly PawnLoadout[], id: PlayerId): PawnLoadout {
  const p = s.find((q) => q.id === id);
  if (p === undefined) throw new Error(`loadout: unknown pawn ${id}`);
  return p;
}
