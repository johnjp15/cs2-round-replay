/**
 * Effects layer, pure part: grenade effects, grenade pops and shot tracers as drawing primitives.
 * The renderer only executes primitives, so how an effect looks is unit-tested here without a canvas.
 *
 * `Effect` mirrors Sim2DHost.activeEffects() (docs/combat.md): `{seq, kind, phase, thrower, pos, radius,
 * untilTick}`. The renderer takes any `EffectsSource`, so a CS2-side host can provide the same list.
 */
import type { GrenadeId, PlayerId, Team, Vec3 } from '../contracts/index';
import { worldToScreen, type Point2, type View } from './radar';
import { GRENADE_COLORS, PALETTE } from './style';

/** One active grenade effect (Sim2DHost `GrenadeEffect`). */
export interface Effect {
  readonly seq: number;
  readonly kind: GrenadeId;
  /** flying = in the air; smoke = active cloud; fire = burning molotov. */
  readonly phase: 'flying' | 'smoke' | 'fire';
  readonly thrower: PlayerId;
  readonly pos: Vec3;
  /** Area radius in world units (0 while flying). */
  readonly radius: number;
  /** Tick the effect ends (the pop tick while flying). */
  readonly untilTick: number;
  /** S1: a volumetric smoke's voxels (centres, density 0–1) and their size; absent for a disc smoke. */
  readonly cells?: readonly { readonly x: number; readonly y: number; readonly z: number; readonly d: number }[];
  readonly cellSize?: number;
  /** V5: a CS2-engine fire's burning flames (floor points) and their radius; absent for a disc fire. */
  readonly flames?: readonly { readonly x: number; readonly y: number; readonly z: number }[];
  readonly flameRadius?: number;
}

/** Anything that lists the active effects for the current tick (Sim2DHost does). */
export interface EffectsSource {
  activeEffects(): readonly Effect[];
}

/** Who is flashed (Sim2DHost does): blind while the current tick is below blindUntilTick(id). */
export interface BlindSource {
  blindUntilTick(id: PlayerId): number;
}

/** A flash or HE going off: a short flare at its position. */
export interface Pop {
  readonly seq: number;
  readonly kind: 'flash' | 'he';
  readonly pos: Point2;
  readonly tick: number;
}

/** A bullet's visible path, from the shooter to the victim, a wall or the tracer range. */
export interface Tracer {
  readonly tick: number;
  readonly shooter: PlayerId;
  readonly team: Team;
  readonly from: Point2;
  readonly to: Point2;
  /** True when it ends on a pawn it damaged. */
  readonly hit: boolean;
}

export type Primitive =
  | {
      readonly type: 'circle';
      readonly x: number;
      readonly y: number;
      readonly r: number;
      readonly fill: string | null;
      readonly stroke: string | null;
      readonly lineWidth: number;
      readonly alpha: number;
      readonly dash: readonly number[];
    }
  | {
      readonly type: 'line';
      readonly x0: number;
      readonly y0: number;
      readonly x1: number;
      readonly y1: number;
      readonly stroke: string;
      readonly lineWidth: number;
      readonly alpha: number;
    };

/** Ticks a pop flare lasts. */
export const POP_TICKS: { readonly [K in Pop['kind']]: number } = { flash: 32, he: 40 };
/** Ticks a tracer takes to fade (~150 ms). */
export const TRACER_TICKS = 10;
/** Smoke clouds swell in over this many ticks after they are first seen. */
const SMOKE_GROW_TICKS = 24;
/** Smoke and fire fade out over this many ticks before untilTick. */
const SMOKE_FADE_TICKS = 96;
const FIRE_FADE_TICKS = 32;
/** World radius (units) a flash flare reaches and the HE blast ring reaches. */
const FLASH_FLARE_UNITS = 260;
const HE_RING_UNITS = 350;
const FLYING_DOT_PX = 3.2;

const NO_DASH: readonly number[] = [];

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function easeOut(x: number): number {
  const f = 1 - clamp01(x);
  return 1 - f * f * f;
}

/** World units → CSS px at this view. */
export function unitsToPx(v: View, units: number): number {
  return (units / v.map.scale) * v.scale;
}

function circle(
  x: number,
  y: number,
  r: number,
  o: { fill?: string; stroke?: string; lineWidth?: number; alpha: number; dash?: readonly number[] },
): Primitive {
  return {
    type: 'circle',
    x,
    y,
    r: Math.max(0, r),
    fill: o.fill ?? null,
    stroke: o.stroke ?? null,
    lineWidth: o.lineWidth ?? 1,
    alpha: clamp01(o.alpha),
    dash: o.dash ?? NO_DASH,
  };
}

/**
 * Primitives for one effect at render tick `tick` (fractional). `bornTick` is when the renderer first
 * saw it in its current phase (for the smoke swelling in), or null.
 *
 * - smoke: a grey disc of the effect radius with a light rim, swelling in and fading out over its last 1.5 s
 * - fire: an orange disc with a dashed, flickering rim, fading over its last 0.5 s
 * - flying: a small dot in the grenade's colour
 */
export function effectPrimitives(e: Effect, v: View, tick: number, bornTick: number | null): Primitive[] {
  const s = worldToScreen(v, e.pos);
  const left = e.untilTick - tick;
  switch (e.phase) {
    case 'smoke': {
      const fade = clamp01(left / SMOKE_FADE_TICKS);
      const grow = bornTick === null ? 1 : 0.55 + 0.45 * easeOut((tick - bornTick) / SMOKE_GROW_TICKS);
      const r = unitsToPx(v, e.radius) * grow;
      return [
        circle(s.x, s.y, r, { fill: GRENADE_COLORS.smoke, alpha: 0.58 * fade }),
        circle(s.x, s.y, r * 0.66, { fill: '#e9edf1', alpha: 0.22 * fade }),
        circle(s.x, s.y, r, { stroke: '#f3f6f8', lineWidth: 1.5, alpha: 0.7 * fade }),
      ];
    }
    case 'fire': {
      const fade = clamp01(left / FIRE_FADE_TICKS);
      const flicker = 0.78 + 0.22 * Math.sin(tick * 0.83);
      const r = unitsToPx(v, e.radius);
      return [
        circle(s.x, s.y, r, { fill: '#ff6a1f', alpha: 0.3 * fade }),
        circle(s.x, s.y, r * 0.55, { fill: '#ffb347', alpha: 0.22 * fade * flicker }),
        circle(s.x, s.y, r, { stroke: GRENADE_COLORS.molotov, lineWidth: 1.75, alpha: fade * flicker, dash: [5, 4] }),
      ];
    }
    case 'flying':
      return [circle(s.x, s.y, FLYING_DOT_PX, { fill: GRENADE_COLORS[e.kind], stroke: PALETTE.ink, lineWidth: 1.5, alpha: 1 })];
  }
}

/** Primitives for a flash or HE pop, or none once it has faded. */
export function popPrimitives(p: Pop, v: View, tick: number): Primitive[] {
  const age = (tick - p.tick) / POP_TICKS[p.kind];
  if (age < 0 || age >= 1) return [];
  const s = worldToScreen(v, p.pos);
  const left = 1 - age;
  if (p.kind === 'flash') {
    const r = unitsToPx(v, 40 + FLASH_FLARE_UNITS * easeOut(age * 1.6));
    return [
      circle(s.x, s.y, r, { fill: GRENADE_COLORS.flash, alpha: 0.85 * left * left }),
      circle(s.x, s.y, r, { stroke: '#ffffff', lineWidth: 2, alpha: left }),
    ];
  }
  const r = unitsToPx(v, HE_RING_UNITS * easeOut(age * 1.4));
  return [
    circle(s.x, s.y, r, { fill: GRENADE_COLORS.he, alpha: 0.28 * left }),
    circle(s.x, s.y, r, { stroke: GRENADE_COLORS.he, lineWidth: 1 + 2.5 * left, alpha: left }),
  ];
}

/** A tracer line fading over TRACER_TICKS, or null once gone. */
export function tracerPrimitive(t: Tracer, v: View, tick: number): Primitive | null {
  const age = (tick - t.tick) / TRACER_TICKS;
  if (age < 0 || age >= 1) return null;
  const a = worldToScreen(v, t.from);
  const b = worldToScreen(v, t.to);
  return {
    type: 'line',
    x0: a.x,
    y0: a.y,
    x1: b.x,
    y1: b.y,
    stroke: t.team === 'T' ? '#ffe9a8' : '#d6e8ff',
    lineWidth: t.hit ? 2 : 1.5,
    alpha: 0.95 * (1 - age),
  };
}
