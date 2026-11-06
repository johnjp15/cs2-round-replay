/**
 * App: the browser shell wiring Core, Sim2D, input and UI together; may import anything.
 * This barrel exports the DOM-free parts (usable from Node, e.g. the C5 headless harness).
 * The page entry is main.ts; the DOM layers are renderer.ts, hud.ts, input-dom.ts and camera-dom.ts.
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
export { MIN_ZOOM, MAX_ZOOM, FOLLOW_ZOOM, fullCamera, isFullView, cameraView, clampCamera, radarAt, zoomAt, panBy, followTarget, wheelFactor } from './camera';
export type { Camera, Viewport } from './camera';
export { effectPrimitives, popPrimitives, tracerPrimitive, unitsToPx, POP_TICKS, TRACER_TICKS } from './effects';
export type { Effect, EffectsSource, BlindSource, Pop, Tracer, Primitive } from './effects';
export {
  Scene,
  KillFeed,
  NO_BOMB,
  SNAP_UNITS_PER_TICK,
  KILL_FEED_MAX,
  KILL_FEED_TICKS,
  LOG_MAX,
  TRACER_RANGE_UNITS,
  interpolationAlpha,
  interpolatePose,
  lerpAngle,
  normalizeDeg,
  nextBombState,
  rayEnd,
} from './scene';
export type { Pose, KillEntry, BombState, BombPhaseView, LogLine, RoundEnd, SightQuery } from './scene';
export {
  statusBadge,
  weaponName,
  hasAmmo,
  hpBand,
  overlayForKey,
  toggleOverlay,
  roundStateOf,
  clockView,
  scoreView,
  bombCarrier,
  youView,
} from './hud-model';
export type { Badge, BadgeTone, Overlays, OverlayKey, RoundStateLike, ClockMode, ClockView, YouView } from './hud-model';
