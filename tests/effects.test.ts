import { describe, expect, it } from 'vitest';
import { POP_TICKS, TRACER_TICKS, effectPrimitives, popPrimitives, tracerPrimitive, unitsToPx, type Effect, type EffectsSource, type Primitive } from '../src/app/effects';
import { cameraView, type Camera } from '../src/app/camera';
import { worldToScreen } from '../src/app/radar';
import { GRENADE_COLORS } from '../src/app/style';
import { Sim2DHost } from '../src/sim2d/index';
import { nav, roster, tuning } from './sim2d-fixtures';

const MIRAGE = { posx: -3230, posy: 1713, scale: 5, size: 1024 };
const VP = { width: 1280, height: 780, margin: 4 };
const CAM: Camera = { zoom: 2, cx: 500, cy: 400 };
const V = cameraView(MIRAGE, CAM, VP);

const SMOKE: Effect = { seq: 1, kind: 'smoke', phase: 'smoke', thrower: 'cart', pos: { x: -470, y: 842, z: -75 }, radius: 144, untilTick: 1327 };
const FIRE: Effect = { seq: 2, kind: 'molotov', phase: 'fire', thrower: 'donk', pos: { x: -1297, y: 776, z: -80 }, radius: 120, untilTick: 700 };
const FLYING: Effect = { seq: 3, kind: 'flash', phase: 'flying', thrower: 'donk', pos: { x: -180, y: 623, z: 10 }, radius: 0, untilTick: 600 };

function circles(ps: Primitive[]): Extract<Primitive, { type: 'circle' }>[] {
  return ps.filter((p): p is Extract<Primitive, { type: 'circle' }> => p.type === 'circle');
}

describe('effect → drawing primitives', () => {
  it('a smoke is a grey disc of its radius at its position, with a rim', () => {
    const ps = circles(effectPrimitives(SMOKE, V, 400, null));
    const s = worldToScreen(V, SMOKE.pos);
    const r = unitsToPx(V, 144);
    expect(r).toBeCloseTo((144 / 5) * V.scale, 9);
    expect(ps[0]).toMatchObject({ x: s.x, y: s.y, r, fill: GRENADE_COLORS.smoke, stroke: null });
    expect(ps.some((p) => p.stroke !== null && p.fill === null && p.r === r)).toBe(true);
    for (const p of ps) expect(p.alpha).toBeGreaterThan(0);
  });

  it('a smoke swells in after it pops and fades out at the end', () => {
    const young = circles(effectPrimitives(SMOKE, V, 400, 400))[0];
    const grown = circles(effectPrimitives(SMOKE, V, 460, 400))[0];
    expect(young?.r).toBeLessThan(grown?.r ?? 0);
    expect(grown?.r).toBeCloseTo(unitsToPx(V, 144), 9);
    const mid = circles(effectPrimitives(SMOKE, V, 800, null))[0]?.alpha ?? 0;
    const late = circles(effectPrimitives(SMOKE, V, 1327 - 20, null))[0]?.alpha ?? 0;
    const gone = circles(effectPrimitives(SMOKE, V, 1327, null))[0]?.alpha ?? 1;
    expect(late).toBeLessThan(mid);
    expect(gone).toBe(0);
  });

  it('a fire is an orange disc with a dashed rim, its full radius', () => {
    const ps = circles(effectPrimitives(FIRE, V, 500, null));
    const rim = ps.find((p) => p.stroke !== null);
    expect(rim?.stroke).toBe(GRENADE_COLORS.molotov);
    expect(rim?.dash.length).toBeGreaterThan(0);
    expect(rim?.r).toBeCloseTo(unitsToPx(V, 120), 9);
    expect(ps[0]?.fill).not.toBeNull();
  });

  it('a flying grenade is a small dot in its colour, independent of zoom', () => {
    const [dot] = circles(effectPrimitives(FLYING, V, 590, null));
    expect(dot?.fill).toBe(GRENADE_COLORS.flash);
    const far = cameraView(MIRAGE, { zoom: 1, cx: 512, cy: 512 }, VP);
    expect(circles(effectPrimitives(FLYING, far, 590, null))[0]?.r).toBe(dot?.r);
  });

  it('pops flare and fade over their lifetime, then draw nothing', () => {
    const flash = { seq: 3, kind: 'flash' as const, pos: { x: -180, y: 623 }, tick: 100 };
    const early = circles(popPrimitives(flash, V, 101));
    const late = circles(popPrimitives(flash, V, 100 + POP_TICKS.flash - 2));
    expect(early[0]?.alpha).toBeGreaterThan(late[0]?.alpha ?? 1);
    expect(popPrimitives(flash, V, 100 + POP_TICKS.flash)).toEqual([]);
    expect(popPrimitives(flash, V, 99)).toEqual([]);
    const he = { seq: 4, kind: 'he' as const, pos: { x: 0, y: 0 }, tick: 100 };
    const ring = circles(popPrimitives(he, V, 120)).find((p) => p.stroke !== null);
    expect(ring?.stroke).toBe(GRENADE_COLORS.he);
  });

  it('a tracer is a line from shooter to end, fading over ~150 ms', () => {
    const t = { tick: 50, shooter: 'cart' as const, team: 'T' as const, from: { x: 0, y: 0 }, to: { x: 400, y: 0 }, hit: true };
    const p = tracerPrimitive(t, V, 50);
    const a = worldToScreen(V, t.from);
    const b = worldToScreen(V, t.to);
    expect(p).toMatchObject({ type: 'line', x0: a.x, y0: a.y, x1: b.x, y1: b.y });
    expect(TRACER_TICKS * (1000 / 64)).toBeCloseTo(156.25, 9);
    const half = tracerPrimitive(t, V, 50 + TRACER_TICKS / 2);
    expect(half?.alpha).toBeCloseTo((p?.alpha ?? 0) / 2, 9);
    expect(tracerPrimitive(t, V, 50 + TRACER_TICKS)).toBeNull();
  });
});

describe('effects source', () => {
  it('Sim2DHost is an EffectsSource', () => {
    const host: EffectsSource = new Sim2DHost(nav, tuning, roster);
    expect(host.activeEffects()).toEqual([]);
  });
});
