/**
 * V5 (backlog #88, #90, #91): every recorded grenade on H5's CS2 engine in the hosts (src/sim3d/grenades.ts
 * `Cs2Grenades`), the Shop smoke's pop time and CS2 fade, and donk's recorded scope (data/round.json
 * `tracks.donk.scope`, the Core's ATTACK2 presses, src/sim2d/scope.ts for `sees` and the walk in both hosts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRound, parseTuning, type PlayerId } from '../src/contracts/index';
import { parseTracks3d } from '../src/contracts/tracks3d';
import { EventSchedule, RoundModel, ScriptPlan } from '../src/core/index';
import { isBlind, type Blind } from '../src/engine/grenades/index';
import { parseWeaponTable } from '../src/engine/weapons/index';
import type { EnginePawn, GrenadeEffect, GrenadeOutcome } from '../src/sim2d/index';
import { SCOPED_GUNS, freshScope, scopeShot, scopedFovDeg, stepScope } from '../src/sim2d/scope';
import { computeSees } from '../src/sim2d/vision';
import { Cs2Grenades, blindUntil } from '../src/sim3d/grenades';
import { Sim3DHost as Sim3DHostClass, type Sim3DHost } from '../src/sim3d/index';
import { ASSUMED_TARGETS } from '../tools/utility-aim';
import { loadHarness3dData, runHarness3d } from '../tools/harness3d';
import { LINEUPS } from './grenades/lineups';
import { mirageGeometry } from './grenades/mirage-world';

const ROOT = new URL('..', import.meta.url);
const tuning = parseTuning(readFileSync(new URL('data/tuning.json', ROOT), 'utf8'));
const t = tuning.grenades.cs2;

function lineup(name: string): (typeof LINEUPS)[number] {
  const l = LINEUPS.find((q) => q.name === name);
  if (l === undefined) throw new Error(`no lineup ${name}`);
  return l;
}

function engine(): Cs2Grenades {
  return new Cs2Grenades(mirageGeometry(), t, tuning.damage.eyeHeight, tuning.damage.crouchEyeHeight);
}

const pawn = (id: PlayerId, team: 'T' | 'CT', x: number, y: number, z: number, yaw: number): EnginePawn => ({ id, team, alive: true, pos: { x, y, z }, crouching: false, yaw, pitch: 0 });

describe('Cs2Grenades: flashes, HE and molotovs on the CS2 engine (V5 #91)', () => {
  it("the B flash from the Apartments window blinds a CT on B looking at it, by the engine's exposure (blindUntil = isBlind)", () => {
    const l = lineup('B flash from B Apartments window');
    const e = engine();
    const [x, y, z] = l.setpos;
    e.throwGrenade('flash', 100, 7, 'barely', 'T', { x, y, z }, l.setang[0], l.setang[1], { x: 0, y: 0, z: 0 });
    const ct = pawn('lokier', 'CT', -2000, 450, -166, 30);
    const out: GrenadeOutcome[] = [];
    for (let k = 100; k < 300 && e.active(); k++) out.push(...e.step(k, [ct]));
    const pop = out.find((o) => o.type === 'pop');
    expect(pop).toMatchObject({ type: 'pop', seq: 7, kind: 'flash', thrower: 'barely' });
    const blind = out.find((o) => o.type === 'blind');
    expect(blind).toMatchObject({ type: 'blind', seq: 7, victim: 'lokier' });
    if (blind?.type !== 'blind') throw new Error('no blind');
    expect(blind.untilTick - 197).toBeGreaterThan(64);
    // blindUntil is the first tick the engine's isBlind is false.
    const b: Blind = { startTick: 0, holdSec: 1.2, fadeSec: 3, maxAlpha: 1 };
    const u = blindUntil(b, t);
    expect(u).not.toBeNull();
    expect(isBlind(b, (u as number) - 1, t)).toBe(true);
    expect(isBlind(b, u as number, t)).toBe(false);
    expect(blindUntil({ ...b, maxAlpha: 0.5 }, t)).toBeNull();
  });

  it('the bench molotov bursts on the B box stack, spreads into flames (effects carry them), burns an enemy in it and burns out by ~7 s', () => {
    const l = lineup('Bench molotov from B Apartments');
    const e = engine();
    const [x, y, z] = l.setpos;
    e.throwGrenade('molotov', 0, 3, 'donk', 'T', { x, y, z }, l.setang[0], l.setang[1], { x: 0, y: 0, z: 0 });
    let burst: GrenadeOutcome | null = null;
    let k = 0;
    for (; k < 200 && burst === null; k++) burst = e.step(k, []).find((o) => o.type === 'pop') ?? null;
    if (burst?.type !== 'pop') throw new Error('no burst');
    expect(burst.kind).toBe('molotov');
    const at = burst.pos;
    const burstTick = k - 1;
    const ct = pawn('sp4rtan', 'CT', at.x, at.y, at.z, 0);
    const hurt: GrenadeOutcome[] = [];
    let fire: GrenadeEffect | undefined;
    for (; k < 700; k++) {
      hurt.push(...e.step(k, [ct]).filter((o) => o.type === 'hurt'));
      if (k === burstTick + 128) fire = e.effects(k).find((q) => q.phase === 'fire');
    }
    expect(fire?.flames?.length).toBeGreaterThanOrEqual(8);
    expect(fire?.flameRadius).toBe(t.flameRadius);
    expect(hurt.length).toBeGreaterThan(10);
    expect(hurt.every((o) => o.type === 'hurt' && o.kind === 'molotov' && o.victim === 'sp4rtan' && o.damage === 8)).toBe(true);
    expect(e.active()).toBe(false);
  });

  it('a snapshot taken while the fire burns restores into a fresh engine that goes on exactly like the live one', () => {
    const l = lineup('Bench molotov from B Apartments');
    const [x, y, z] = l.setpos;
    const pawns = [pawn('sp4rtan', 'CT', -2140, 350, -36, 0)];
    const live = engine();
    live.throwGrenade('molotov', 10, 1, 'donk', 'T', { x, y, z }, l.setang[0], l.setang[1], { x: 0, y: 0, z: 0 });
    const rows: string[] = [];
    let snap: unknown = null;
    for (let k = 10; k < 400; k++) {
      rows.push(JSON.stringify([e2s(live.step(k, pawns)), live.effects(k)]));
      if (k === 160) snap = JSON.parse(JSON.stringify(live.snapshot()));
    }
    const back = engine();
    back.restore(snap);
    for (let k = 161; k < 400; k++) expect(JSON.stringify([e2s(back.step(k, pawns)), back.effects(k)])).toBe(rows[k - 10]);
  });
});

function e2s(o: readonly GrenadeOutcome[]): string {
  return JSON.stringify(o);
}

describe("the recorded round's grenades and donk's scope in the 3D host (golden no-human run)", () => {
  const data = loadHarness3dData();
  const rows: { tick: number; outcome: GrenadeOutcome }[] = [];
  const zooms: { tick: number; arms: number; scope: number }[] = [];
  const shop: { tick: number; cells: number; maxD: number }[] = [];
  const fires: { tick: number; flames: readonly { x: number; y: number }[] }[] = [];
  type Probe = Pick<Sim3DHost, 'pawnState' | 'armsOf' | 'activeEffects'> & { readonly tickNo: number };
  const proto = Sim3DHostClass.prototype as unknown as Record<string, unknown>;
  const origApply = proto['applyGrenadeOutcome'] as (this: unknown, o: GrenadeOutcome) => void;
  const origTick = proto['tick'] as (this: unknown, ...a: unknown[]) => unknown;
  proto['applyGrenadeOutcome'] = function (this: unknown, o: GrenadeOutcome): void {
    rows.push({ tick: (this as Probe).tickNo, outcome: o });
    origApply.call(this, o);
  };
  proto['tick'] = function (this: unknown, ...a: unknown[]): unknown {
    const r = origTick.apply(this, a);
    const h = this as Probe;
    const s = h.pawnState('donk');
    zooms.push({ tick: h.tickNo, arms: h.armsOf('donk')?.zoom ?? -1, scope: s?.scope?.zoom ?? 0 });
    for (const e of h.activeEffects()) {
      const cells = e.cells ?? [];
      if (e.kind === 'smoke' && e.thrower === 'cart' && e.phase === 'smoke' && e.pos.y < -300) shop.push({ tick: h.tickNo, cells: cells.filter((c) => c.d > 0).length, maxD: Math.max(0, ...cells.map((c) => c.d)) });
      if (e.phase === 'fire' && e.flames !== undefined) fires.push({ tick: h.tickNo, flames: e.flames });
    }
    return r;
  };
  const run = runHarness3d(data, { human: null, driver: null, lastTick: 3300, seed: 1 });
  proto['applyGrenadeOutcome'] = origApply;
  proto['tick'] = origTick;
  const round = parseRound(readFileSync(new URL('data/round.json', ROOT), 'utf8'));

  it("cart's 25.8 s smoke pops at 28.09 s (the video's first puff 28.1 s; was 29.13 s) within 60 u of the measured spot, thins from 15 s and is gone 18 s after the pop (V5 #88)", () => {
    const pops = rows.filter((r) => r.outcome.type === 'pop' && r.outcome.thrower === 'cart' && r.outcome.kind === 'smoke' && r.tick > 1651);
    expect(pops.map((r) => r.tick)).toEqual([1798]);
    const p = pops[0]?.outcome;
    const l = round.utility.find((u) => u.thrower === 'cart' && u.t === 25.8)?.landing;
    if (p?.type !== 'pop' || l === null || l === undefined) throw new Error('no pop');
    expect(l.t).toBe(28.1);
    expect(Math.abs(1798 / 64 - (l.t ?? 0))).toBeLessThan(0.1);
    expect(Math.hypot(p.pos.x - l.x, p.pos.y - l.y)).toBeLessThan(60);
    const at = (tick: number) => shop.find((s) => s.tick === tick);
    expect(at(1799 + 64 * 15 - 2)?.maxD).toBe(1);
    expect(at(1799 + 64 * 16)?.maxD).toBeLessThan(0.75);
    expect(at(1799 + 64 * 17)?.maxD).toBeLessThan(0.4);
    expect(shop.some((s) => s.tick >= 1798 + 64 * 18)).toBe(false);
  });

  it("donk's molotov bursts on the Truck platform by the van, west of cart's way down from the Balcony, and burns nobody; no flash blinds a T but donk's own for < 0.5 s (V5 #91)", () => {
    const mol = rows.find((r) => r.outcome.type === 'pop' && r.outcome.kind === 'molotov');
    if (mol?.outcome.type !== 'pop') throw new Error('no molotov');
    expect(mol.outcome.pos.x).toBeLessThan(-2250);
    expect(mol.outcome.pos.y).toBeGreaterThan(650);
    expect(fires.length).toBeGreaterThan(64 * 5);
    const cart = run.model;
    for (const f of fires) {
      const c = cart.trackAtTick('cart', f.tick);
      if (c === null) continue;
      for (const q of f.flames) expect(Math.hypot(q.x - c.pos.x, q.y - c.pos.y)).toBeGreaterThan(120);
    }
    expect(rows.filter((r) => r.outcome.type === 'hurt')).toEqual([]);
    const blinds = rows.filter((r) => r.outcome.type === 'blind');
    for (const b of blinds) {
      const o = b.outcome;
      if (o.type !== 'blind') continue;
      const team = round.players.find((q) => q.id === o.victim)?.team;
      if (team === 'T') {
        expect(o.victim).toBe(o.thrower);
        expect(o.untilTick - b.tick).toBeLessThan(32);
      }
    }
  });

  it("donk scopes in at 33.35 s and walks scoped; his shot at 49.85 s drops it (the video's frames); the arms and scope.ts agree on every tick (V5 #90)", () => {
    expect(zooms.every((z) => z.arms === z.scope)).toBe(true);
    const zoomAt = (tick: number) => zooms.find((z) => z.tick === tick)?.scope;
    expect(zoomAt(2133)).toBe(0);
    for (const tick of [2134, 2200, 2300, 2383]) expect(zoomAt(tick)).toBe(1);
    expect(zoomAt(3100)).toBe(0);
    expect(zoomAt(3165)).toBe(1);
    expect(zoomAt(3191)).toBe(0);
    expect(scopedFovDeg({ ...freshScope('awp'), zoom: 1 })).toBeCloseTo(51.8, 1);
  });
});

describe('scope data, presses and sees (V5 #90)', () => {
  it("round.json: donk's scope timeline from the video's frames; the Core presses ATTACK2 for it (1 → 0 through zoom 2; no press at the shot's unzoom)", () => {
    const round = parseRound(readFileSync(new URL('data/round.json', ROOT), 'utf8'));
    expect(round.tracks.donk?.scope?.map((s) => `${s.t} ${s.zoom} ${s.confidence}`)).toEqual(['33.35 1 observed', '47.6 0 inferred', '49.4 1 observed', '49.833 0 observed']);
    const li = tuning.replay.inputLatencyTicks;
    const plan = new ScriptPlan(new RoundModel(round), new EventSchedule(round), tuning);
    expect(plan.scope.map((p) => `${p.id} ${p.tick}`)).toEqual([`donk ${2134 - li}`, `donk ${3046 - li - 5}`, `donk ${3046 - li}`, `donk ${3162 - li}`]);
  });

  it('a scope zoom of 3, or scope samples out of order, are rejected', () => {
    const raw = JSON.parse(readFileSync(new URL('data/round.json', ROOT), 'utf8')) as { tracks: Record<string, { scope?: unknown[] }> };
    const bad = (scope: unknown[]) => () => parseRound({ ...raw, tracks: { ...raw.tracks, donk: { ...raw.tracks['donk'], scope } } });
    expect(bad([{ t: 30, tick: 1920, zoom: 3, confidence: 'observed' }])).toThrow(/zoom/);
    expect(bad([{ t: 30, tick: 1920, zoom: 1, confidence: 'observed' }, { t: 29, tick: 1856, zoom: 0, confidence: 'observed' }])).toThrow(/increasing/);
  });

  it("scope.ts is the weapon table's zoom (data/weapons.json): levels, zoom time, FOVs, scoped speed, unzoom on the shot", () => {
    const table = parseWeaponTable(JSON.parse(readFileSync(new URL('data/weapons.json', ROOT), 'utf8')));
    for (const [id, d] of Object.entries(SCOPED_GUNS)) {
      const w = table.weapons[id];
      if (w === undefined) throw new Error(id);
      expect([d.levels, d.zoomTimeSec, d.unzoomsAfterShot, ...d.fov4x3, d.scopedSpeed]).toEqual([w.zoom.levels, w.zoom.times[1], w.zoom.unzoomsAfterShot, ...w.zoom.fov, w.maxSpeed[1]]);
    }
    let s = freshScope('awp');
    const step = (tick: number, attack2: boolean, extra: Partial<{ reloading: boolean; weapon: string; nextAttackTick: number }> = {}) =>
      (s = stepScope(s, { tick, weapon: extra.weapon ?? 'awp', attack2, reloading: extra.reloading ?? false, nextAttackTick: extra.nextAttackTick ?? 0 }));
    step(10, true);
    expect(s.zoom).toBe(1);
    step(11, true);
    expect(s.zoom).toBe(1); // held: no new press
    step(12, false);
    step(13, true);
    expect(s.zoom).toBe(1); // m_flZoomTime1 0.05 s: not before tick 13.2
    step(14, false);
    step(15, true);
    expect(s.zoom).toBe(2);
    s = scopeShot(s);
    expect([s.zoom, s.resumeZoom]).toEqual([0, 2]);
    step(20, false, { nextAttackTick: 100 });
    expect(s.zoom).toBe(0);
    step(100, false, { nextAttackTick: 100 });
    expect(s.zoom).toBe(2);
    step(101, false, { weapon: 'glock' });
    expect(s.zoom).toBe(0);
  });

  it('sees: a scoped pawn sees only inside its scope (AWP zoom 1: 51.8 deg), an unscoped one its 106 deg', () => {
    const a = { id: 'donk' as PlayerId, pos: { x: 0, y: 0, z: 0 }, yaw: 0, crouching: false, alive: true, blind: false };
    const b = { id: 'sp4rtan' as PlayerId, pos: { x: 500, y: 300, z: 0 }, yaw: 180, crouching: false, alive: true, blind: true }; // 31 deg off donk's view
    const sight = { pairSight: (_x: unknown, _y: unknown, ab: boolean, ba: boolean) => (ab ? 1 : 0) | (ba ? 2 : 0) };
    const smoke = { smokeBlocks: () => false };
    const o = { fovDeg: tuning.ai.fovDeg, eyeHeight: 64, crouchEyeHeight: 46 };
    expect(computeSees([a, b], sight as never, smoke, o)[0]).toEqual(['sp4rtan']);
    expect(computeSees([{ ...a, fovDeg: 51.8 }, b], sight as never, smoke, o)[0]).toEqual([]);
  });
});

describe('mirage-tracks.json: the aims of the recorded throws (V5)', () => {
  it("every assumed target is a recorded throw without a measured landing; cart's smoke is solved for the video's 28.1 s pop too", () => {
    const tracks = parseTracks3d(JSON.parse(readFileSync(new URL('data/geometry/mirage-tracks.json', ROOT), 'utf8')));
    const u = tracks.utility ?? [];
    expect(u.map((a) => `${a.thrower} ${a.tick}${a.assumed === true ? ' assumed' : ''}`)).toEqual(['snarlbot 499 assumed', 'donk 563 assumed', 'barely 1139 assumed', 'donk 1229 assumed', 'cart 1651']);
    expect(Object.keys(ASSUMED_TARGETS)).toEqual(['7.8 snarlbot flash', '8.8 donk flash', '17.8 barely he', '19.2 donk molotov']);
    const cart = u.find((a) => a.thrower === 'cart');
    expect(cart?.sec).toBeCloseTo(2.3, 1);
    expect(cart?.error).toBeLessThan(60);
  });
});
