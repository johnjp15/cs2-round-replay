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

export interface IHost {
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
