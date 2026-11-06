/**
 * The two in-process interfaces. The engine (2D sim now, CS2 plugin later)
 * implements IHost; the decision logic implements ICore. Per tick the driver does:
 *
 *   const o = host.observe();   // numbers already canonical (see docs/contracts.md "Types")
 *   const a = core.step(o);
 *   log.append(o, a, controlsSinceLastTick);
 *   host.apply(a);
 */
import type { JsonValue } from './json';
import type { Act, Control, Observe } from './types';

/** Opaque, JSON-serializable engine state. Only the host that produced it reads `data`. */
export interface HostSnapshot {
  readonly kind: 'host';
  readonly data: JsonValue;
}

/** Opaque, JSON-serializable Core state. Only the core that produced it reads `data`. */
export interface CoreSnapshot {
  readonly kind: 'core';
  readonly data: JsonValue;
}

/**
 * What an engine can do beyond observe / apply (B5, contract finding F6). The driver (the app's Session, the CS2
 * plugin) asks once and degrades: without `snapshot` a rewind restores the Core and resyncs the engine through
 * actions (`ReplayCore` "resync"), without `seek` it can't run ticks faster than real time (seek forward is refused;
 * seek back is a rewind), without `speed` the `speed` control is refused. Sim2DHost: all true. CS2 adapter: all false.
 */
export interface HostCapabilities {
  /** snapshot() / restore() put the engine back exactly (velocities, grenades in flight, bomb progress, timers). */
  readonly snapshot: boolean;
  /** The driver may step ticks back to back without waiting for real time (seek forward, as fast as possible). */
  readonly seek: boolean;
  /** The engine can run at another rate than real time (the `speed` control). */
  readonly speed: boolean;
}

/** Sim2DHost's capabilities (everything). */
export const ALL_CAPABILITIES: HostCapabilities = { snapshot: true, seek: true, speed: true };

/** What the CS2 adapter returns (docs/cs2-adapter.md F6): a live server can't snapshot, fast-forward or change rate. */
export const CS2_CAPABILITIES: HostCapabilities = { snapshot: false, seek: false, speed: false };

export interface IHost {
  /** B5: what this engine can do (constant for its lifetime). */
  capabilities(): HostCapabilities;
  observe(): Observe;
  apply(act: Act): void;
  control(c: Control): void;
  snapshot(): HostSnapshot;
  restore(s: HostSnapshot): void;
}

export interface ICore {
  /** Pure function of (internal state, observe); must not read clocks or Math.random. */
  step(o: Observe): Act;
  control(c: Control): void;
  snapshot(): CoreSnapshot;
  restore(s: CoreSnapshot): void;
}
