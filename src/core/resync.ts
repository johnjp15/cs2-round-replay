/**
 * Resync rewind (B5): put an engine that can't restore a snapshot (CS2, finding F6) back to a checkpoint through
 * contract actions. The driver restores the Core's own snapshot, sends `rewind {id}`, and feeds the checkpoint's
 * observe to the next step; that step's Act starts with `resyncActions(...)` and then carries on exactly as the
 * checkpoint's step did. See docs/core.md "Checkpoints, rewind, summary".
 *
 * Restored: the clock and round state (`set_round`: score, end, the bomb's state, carrier, position and plant tick),
 * every living pawn's HP / armor / helmet, position and yaw, inventory with clip and reserve (`strip` then `give`s),
 * held weapon, mode (`set_mode` REPLAY, or LIVE with a fresh goal) and the damage blocks of every enemy and self
 * pair (`block_damage` / `unblock_damage`, the full set). Not restored (no contract action; CS2 can't): velocities
 * (teleports stop the pawn), grenades in flight and active smokes and fires (the engine drops them; an in-flight one
 * is given back to its thrower), a plant or defuse in progress (it starts again), weapon timers (reload, deploy,
 * fire cadence), flashes, the LIVE AI's memory.
 *
 * Pure function of the checkpoint's observe and the Core's state at the checkpoint, so a log with a resync replays.
 */
import { PLAYER_IDS, type Action, type Goal, type Observe, type PlayerId, type Tuning } from '../contracts/index';
import { liveGoal } from './divergence';
import { loadoutOf, type PawnLoadout } from './loadout';
import type { RoundModel } from './round-model';
import type { PlantItem } from './scripted';

/**
 * A pawn's Core mode at the checkpoint, whether it was ever LIVE this run, and (G1) whether its damage blocks are
 * lifted: it went LIVE and hasn't rejoined since (absent: `everLive`, as before G1).
 */
export interface ResyncPawn {
  readonly id: PlayerId;
  readonly mode: string;
  readonly everLive: boolean;
  readonly blocksLifted?: boolean;
}

/** An attacker → victim block a scheduled encounter holds at the checkpoint (B4). */
export interface StandingBlock {
  readonly attacker: PlayerId;
  readonly victim: PlayerId;
}

function enemies(model: RoundModel, a: PlayerId, b: PlayerId): boolean {
  return model.player(a).team !== model.player(b).team;
}

/**
 * The damage blocks the engine had at the checkpoint: every self pair and ordered enemy pair whose pawns are both on
 * script (neither the human nor with its blocks lifted: B3 blocked them at the setup, B4 lifted a LIVE pawn's, G1 put
 * a rejoined pawn's back), plus the standing encounter blocks. In attacker, then victim order (PLAYER_IDS), self pairs
 * included.
 */
export function blockedPairs(model: RoundModel, human: PlayerId | null, pawns: readonly ResyncPawn[], standing: readonly StandingBlock[]): { attacker: PlayerId; victim: PlayerId; blocked: boolean }[] {
  const lifted = (id: PlayerId): boolean => {
    const p = pawns.find((q) => q.id === id);
    return p === undefined ? false : (p.blocksLifted ?? p.everLive);
  };
  const onScript = (id: PlayerId): boolean => id !== human && !lifted(id);
  const out: { attacker: PlayerId; victim: PlayerId; blocked: boolean }[] = [];
  for (const a of PLAYER_IDS) {
    for (const b of PLAYER_IDS) {
      if (a !== b && !enemies(model, a, b)) continue;
      const blocked = (onScript(a) && onScript(b)) || standing.some((s) => s.attacker === a && s.victim === b);
      out.push({ attacker: a, victim: b, blocked });
    }
  }
  return out;
}

/**
 * The resync prefix for checkpoint observe `o`:
 * 1. `set_round {tick, round}`;
 * 2. per living pawn in id order: `set_hp` (a dead one comes back), `teleport`, `strip`, one `give` per ledger item,
 *    `set_weapon` (the observed weapon), and for every pawn but the human `set_mode` REPLAY, or LIVE with
 *    `liveGoal` from here (G1: or with its rejoin goal, `rejoinGoals`, when it was heading back to its track). A pawn
 *    dead at the checkpoint is dead now too (nobody comes back to life in a run), so it gets nothing;
 * 3. `block_damage` / `unblock_damage` for every self and enemy pair (`blockedPairs`);
 * 4. one `log` line.
 */
export function resyncActions(
  model: RoundModel,
  tuning: Tuning,
  o: Observe,
  pawns: readonly ResyncPawn[],
  loadouts: readonly PawnLoadout[],
  standing: readonly StandingBlock[],
  id: string,
  rejoinGoals: readonly { readonly id: PlayerId; readonly goal: Goal }[] = [],
): Action[] {
  const out: Action[] = [{ type: 'set_round', tick: o.tick, round: o.round }];
  let placed = 0;
  let live = 0;
  for (const p of o.pawns) {
    if (!p.alive) continue;
    placed++;
    const l = loadoutOf(loadouts, p.id);
    out.push({ type: 'set_hp', id: p.id, hp: p.hp, armor: p.armor, helmet: l.helmet });
    out.push({ type: 'teleport', id: p.id, pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z }, yaw: p.yaw });
    out.push({ type: 'strip', id: p.id });
    for (const q of l.items) out.push({ type: 'give', id: p.id, item: q.item, clip: q.clip, reserve: q.reserve });
    out.push({ type: 'set_weapon', id: p.id, weapon: p.weapon });
    if (p.id === o.human) continue;
    const mode = pawns.find((q) => q.id === p.id)?.mode ?? 'REPLAY';
    if (mode === 'LIVE') {
      live++;
      const rejoin = rejoinGoals.find((g) => g.id === p.id);
      out.push({ type: 'set_mode', id: p.id, mode: 'LIVE', goal: rejoin === undefined ? liveGoal(model, p.id, o, tuning) : rejoin.goal });
    } else {
      out.push({ type: 'set_mode', id: p.id, mode: 'REPLAY', goal: null });
    }
  }
  let blocked = 0;
  for (const b of blockedPairs(model, o.human, pawns, standing)) {
    if (b.blocked) blocked++;
    out.push({ type: b.blocked ? 'block_damage' : 'unblock_damage', attacker: b.attacker, victim: b.victim });
  }
  out.push({
    type: 'log',
    level: 'info',
    text: `rewind ${id}: resync to tick ${o.tick}, ${placed} pawn${placed === 1 ? '' : 's'} placed, ${live} LIVE, ${blocked} blocked pair${blocked === 1 ? '' : 's'}`,
  });
  return out;
}

/**
 * Why a resync to observe `o` would not reproduce the round from there (empty = none), for a driver without engine
 * snapshots picking a checkpoint: a defuse in progress (`round.bomb.defuser` while planted), or the scripted plant's
 * USE window open with the bomb not yet planted (a plant by the human or a LIVE pawn is not visible to the Core).
 */
export function resyncHazards(o: Observe, plant: PlantItem | null, planterOnScript: boolean): string[] {
  const out: string[] = [];
  const b = o.round.bomb;
  if (b.state === 'planted' && b.defuser !== null) out.push(`defuse in progress (${b.defuser})`);
  if (plant !== null && planterOnScript && (b.state === 'carried' || b.state === 'dropped') && o.tick > plant.useFrom && o.tick <= plant.useTo) {
    out.push(`plant in progress (${plant.id})`);
  }
  return out;
}
