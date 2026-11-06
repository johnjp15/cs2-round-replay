/** Fixtures for the bomb, round-rule and collision tests: Mirage hosts set up like the recorded round. */
import { readFileSync } from 'node:fs';
import { parseRound, toTick, type Act, type Action, type Button, type Observe, type PawnInput, type PlayerId, type Vec3 } from '../src/contracts/index';
import { RoundModel, startActions } from '../src/core/index';
import { Sim2DHost } from '../src/sim2d/host';
import { act } from './combat-fixtures';
import { nav, roster, tuning } from './sim2d-fixtures';

export { nav, roster, tuning };

export const roundData = parseRound(JSON.parse(readFileSync(new URL('../data/round.json', import.meta.url), 'utf8')) as unknown);
export const model = new RoundModel(roundData);

/** The recorded bomb spot on B (round.json `bomb.pos`). */
export const BOMB_POS: Vec3 = { x: -1982, y: 311, z: -160 };
/** Recorded ticks: plant 27.517 s, defuse start 61.8 s, defuse 66.8 s, explosion 67.517 s, cart's death 69.4 s. */
export const PLANT_TICK = toTick(27.517);
export const DEFUSE_START_TICK = toTick(61.8);
export const DEFUSE_TICK = toTick(66.8);
export const EXPLODE_TICK = toTick(67.517);
export const CART_DEATH_TICK = toTick(69.4);

/**
 * A Mirage host with the round's score and clock, every pawn at its recorded start with its kit (Core's
 * startActions: barely has the c4, sp4rtan the defuser), applied before the first tick.
 */
export function mirageHost(): Sim2DHost {
  const host = new Sim2DHost(nav, tuning, roster, { score: roundData.meta.score, roundTimeSec: roundData.meta.clock0 });
  host.apply(act(startActions(model, tuning)));
  return host;
}

/** Teleport a pawn and draw `weapon` at once (same act: state placement, no deploy time). */
export function place(id: PlayerId, pos: Vec3, weapon: string | null = null, yaw = 0): Action[] {
  const out: Action[] = [{ type: 'teleport', id, pos, yaw }];
  if (weapon !== null) out.push({ type: 'set_weapon', id, weapon: weapon as Extract<Action, { type: 'set_weapon' }>['weapon'] });
  return out;
}

export function hold(id: PlayerId, buttons: readonly Button[], forward = 0, yaw = 0): PawnInput {
  return { id, forward, side: 0, yaw, pitch: 0, buttons };
}

export function inputs(...xs: PawnInput[]): Act {
  return { inputs: xs, actions: [], status: [] };
}

/** Run ticks until the host's tick is `tick` (the next tick processed is `tick`); returns the observes after each tick. */
export function runTo(host: Sim2DHost, tick: number): Observe[] {
  const out: Observe[] = [];
  while (host.observe().tick < tick) {
    host.tick();
    out.push(host.observe());
  }
  return out;
}

/** Ticks (processed) at which a bomb event of `phase` was emitted. */
export function bombTicks(obs: readonly Observe[], phase: string): number[] {
  return obs.filter((o) => o.events.some((e) => e.type === 'bomb' && e.phase === phase)).map((o) => o.tick - 1);
}
