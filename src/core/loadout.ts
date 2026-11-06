/**
 * The loadout ledger (B5): what every pawn carries, as far as the Core can tell. A resync rewind (no engine snapshot,
 * CS2) has to give every pawn back the items it had at the checkpoint, but `Observe` shows only the held weapon and
 * its ammo, so the Core keeps the rest itself, from:
 *
 * - its own actions: the setup's and B3's `give`s (a gun replaces its entry; each grenade, c4 or defuser `give` adds
 *   one), and `strip` (everything but the knife goes);
 * - every observe: the held item's clip and reserve (ammo only changes while a gun is held: firing, reloading), a
 *   held item the ledger lacks (added), the c4 from `round.bomb` (the carrier has it; dropped, planted, defused or
 *   exploded: nobody), and grenade pops (`sound` kind `grenade`, the only trace of a throw in Observe): one grenade
 *   of the thrower goes. Which kind: a pawn that stops holding a grenade has maybe thrown it (a "release"); a pop
 *   takes the oldest release of the last `releaseWindowTicks` whose kind the pawn still has, else the grenade it was
 *   last seen holding, else its first. A grenade in flight is still in the ledger until it pops (a resync gives it
 *   back), and a human who draws and puts away grenades just before a throw can fool the release rule.
 *
 * `helmet` comes from the round's kit: nobody buys mid-round, and CS2 keeps a helmet until death.
 *
 * Plain data in the Core snapshot; pure functions, ids in PLAYER_IDS order, items sorted ordinally (duplicates in
 * the order they were added), like Sim2DHost's inventory.
 */
import { GRENADE_IDS, PLAYER_IDS, compareOrdinal, type Action, type GrenadeId, type GrenadeTuning, type ItemId, type Observe, type PlayerId } from '../contracts/index';
import { TICK_RATE } from './clock';
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
  /** The item held at the last observe (release detection). */
  held: string;
  /** Grenades it stopped holding (maybe thrown) and the observe tick, oldest first. */
  released: { item: GrenadeId; tick: number }[];
}

/** One per player, PLAYER_IDS order. */
export type LoadoutState = PawnLoadout[];

/** Before the setup: knives only. */
export function initialLoadouts(model: RoundModel): LoadoutState {
  return PLAYER_IDS.map((id) => ({ id, items: [], helmet: model.player(id).helmet, lastGrenade: null, held: 'knife', released: [] }));
}

export function copyLoadouts(s: readonly PawnLoadout[]): LoadoutState {
  return s.map((p) => ({
    id: p.id,
    items: p.items.map((q) => ({ item: q.item, clip: q.clip, reserve: q.reserve })),
    helmet: p.helmet,
    lastGrenade: p.lastGrenade,
    held: p.held,
    released: p.released.map((r) => ({ item: r.item, tick: r.tick })),
  }));
}

/**
 * How long after a release its grenade can still pop: the longest fuse, or the longest flight (`throwRange` at
 * `throwSpeed`), plus a second. 2D tuning: max(1.5, 2, 2.22) + 1 s = 206 ticks.
 */
export function releaseWindowTicks(g: GrenadeTuning): number {
  const flight = g.throwSpeed > 0 ? g.throwRange / g.throwSpeed : 0;
  const sec = Math.max(g.fuseSec, g.molotovFuseSec, flight) + 1;
  return Math.ceil(sec * TICK_RATE - 1e-9);
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
export function noteObserve(s: LoadoutState, o: Observe, window: number): void {
  for (const pawn of o.pawns) {
    const p = find(s, pawn.id);
    if (!pawn.alive) continue;
    const held: string = pawn.weapon;
    if (held !== p.held) {
      if (isGrenadeItem(p.held)) p.released.push({ item: p.held, tick: o.tick });
      p.held = held;
    }
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
    p.released = p.released.filter((r) => o.tick - r.tick <= window);
    const r = p.released.findIndex((x) => p.items.some((q) => q.item === x.item));
    if (r >= 0) {
      removeOne(p, (p.released[r] as { item: GrenadeId }).item);
      p.released = [...p.released.slice(0, r), ...p.released.slice(r + 1)];
      continue;
    }
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
