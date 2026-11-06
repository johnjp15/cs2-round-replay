/** Fixtures for the combat and grenade tests: synthetic nav meshes, a 4-pawn roster and act helpers. */
import type { Act, Action, Button, Observe, ObsEvent, PawnInput, PawnObs, PlayerId, Tuning } from '../src/contracts/index';
import { Sim2DHost, type RosterEntry } from '../src/sim2d/host';
import { NavMesh, navOptionsFromTuning } from '../src/sim2d/nav';
import { tuning } from './sim2d-fixtures';

export { tuning };

/** One flat 10,000 × 10,000 area at z 0: line of sight everywhere. */
export const openNav = new NavMesh(
  { places: ['Open'], areas: [{ id: 0, x1: -5000, y1: -5000, x2: 5000, y2: 5000, z1: 0, z2: 0, place: 0 }] },
  navOptionsFromTuning(tuning),
);

/** Two flat halves with a 100-unit wall at −50 < x < 50 (wider than 2 × losMargin, so it blocks sight). */
export const wallNav = new NavMesh(
  {
    places: ['West', 'East'],
    areas: [
      { id: 0, x1: -5000, y1: -5000, x2: -50, y2: 5000, z1: 0, z2: 0, place: 0 },
      { id: 1, x1: 50, y1: -5000, x2: 5000, y2: 5000, z1: 0, z2: 0, place: 1 },
    ],
  },
  navOptionsFromTuning(tuning),
);

/** cart and barely (T), sp4rtan and zwomp (CT). */
export const roster4: RosterEntry[] = [
  { id: 'barely', team: 'T' },
  { id: 'cart', team: 'T' },
  { id: 'sp4rtan', team: 'CT' },
  { id: 'zwomp', team: 'CT' },
];

/** A host with every pawn parked far from the origin (x 4000, y 4000 + 200 × i), out of the tests' lines of fire. */
export function newHost(nav: NavMesh = openNav, t: Tuning = tuning): Sim2DHost {
  const host = new Sim2DHost(nav, t, roster4);
  host.apply(act(roster4.map((r, i): Action => ({ type: 'teleport', id: r.id, pos: { x: 4000, y: 4000 + 200 * i, z: 0 }, yaw: 0 }))));
  return host;
}

export function act(actions: readonly Action[], inputs: readonly PawnInput[] = []): Act {
  return { inputs, actions, status: [] };
}

export function input(id: PlayerId, yaw: number, pitch: number, buttons: readonly Button[] = [], forward = 0): PawnInput {
  return { id, forward, side: 0, yaw, pitch, buttons };
}

export function pawn(o: Observe, id: PlayerId): PawnObs {
  const p = o.pawns.find((q) => q.id === id);
  if (p === undefined) throw new Error(`no pawn ${id}`);
  return p;
}

/** Place a pawn with 100 HP, armor and a gun drawn and ready (teleport + set_weapon in one act). */
export function setupActions(
  id: PlayerId,
  pos: { x: number; y: number; z?: number },
  yaw: number,
  weapon: string,
  opts: { hp?: number; armor?: number; helmet?: boolean; clip?: number; reserve?: number } = {},
): Action[] {
  const w = tuning.weapons[weapon];
  return [
    { type: 'teleport', id, pos: { x: pos.x, y: pos.y, z: pos.z ?? 0 }, yaw },
    { type: 'set_hp', id, hp: opts.hp ?? 100, armor: opts.armor ?? 100, helmet: opts.helmet ?? true },
    { type: 'give', id, item: weapon as Extract<Action, { type: 'give' }>['item'], clip: opts.clip ?? w?.clip ?? 0, reserve: opts.reserve ?? w?.reserve ?? 0 },
    { type: 'set_weapon', id, weapon: weapon as Extract<Action, { type: 'set_weapon' }>['weapon'] },
  ];
}

/** Events of one type from an observe. */
export function eventsOf<T extends ObsEvent['type']>(o: Observe, type: T): Extract<ObsEvent, { type: T }>[] {
  return o.events.filter((e): e is Extract<ObsEvent, { type: T }> => e.type === type);
}

/** Run `ticks` ticks with the stored inputs; returns each tick's observe (after the tick). */
export function run(host: Sim2DHost, ticks: number): Observe[] {
  const out: Observe[] = [];
  for (let i = 0; i < ticks; i++) {
    host.tick();
    out.push(host.observe());
  }
  return out;
}

/** Ticks (the tick that was processed, i.e. observe.tick − 1) at which `pred` matched an event. */
export function ticksWhere(obs: readonly Observe[], pred: (e: ObsEvent) => boolean): number[] {
  const out: number[] = [];
  for (const o of obs) if (o.events.some(pred)) out.push(o.tick - 1);
  return out;
}
