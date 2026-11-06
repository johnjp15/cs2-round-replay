/** Sim2D: the 2D top-down engine/host (IHost) for Mirage; may import only src/contracts. */
export { NavMesh, NavError, navOptionsFromTuning, areaZ } from './nav';
export type { NavArea, NavData, NavOptions, NavPoint, NavPortal, NavPos } from './nav';
export {
  TICKS_PER_SEC,
  TICK_DT,
  MovementError,
  runSpeed,
  maxSpeed,
  wishFromInput,
  applyFriction,
  accelerate,
  stepMove,
} from './movement';
export type { MoveState, MoveInput, MoveStep, Wish } from './movement';
export { Sim2DHost, UNSUPPORTED_V0 } from './host';
export type { RosterEntry, InventoryItem, PawnState, HostNote } from './host';
