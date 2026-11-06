/**
 * App: the browser shell wiring Core, Sim2D, input and UI together; may import anything.
 * This barrel exports the DOM-free parts (usable from Node, e.g. the C5 headless harness).
 * The page entry is main.ts; the DOM layers are debug-render.ts and input-dom.ts.
 */
export { Session, DEFAULT_HUMAN, defaultCore, parseSessionData } from './session';
export type { SessionConfig, SessionData, SessionSnapshot, CoreParts, CoreFactory } from './session';
export { FixedLoop, RateMeter, TICK_HZ, TICK_MS, MIN_SPEED, MAX_SPEED, SPEEDS, DEFAULT_MAX_TICKS_PER_FRAME } from './loop';
export type { LoopOptions } from './loop';
export {
  NO_CONTROLS,
  SLOT_WEAPONS,
  bindingForKey,
  bindingForMouseButton,
  buttonsFor,
  humanInput,
  moveDirection,
  toPawnFrame,
  weaponForSlot,
  yawToward,
} from './input';
export type { HeldControls, HeldControl, WeaponSlot, Binding } from './input';
export { worldToRadar, radarToWorld, fitView, worldToScreen, screenToWorld, yawToScreenDir } from './radar';
export type { Point2, View } from './radar';
