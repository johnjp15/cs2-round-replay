/**
 * A1: the sound pipeline without Web Audio: the event table vs the CS2 manifest, the CS2 distance curves and
 * occlusion, the placeholder synth, and the director on hand-made ticks and on the whole recorded round (Sim3DHost,
 * nobody playing: every recorded kill, the plant, the beeps and the defuse sound).
 */
import { describe, expect, it } from 'vitest';
import manifest from '../data/audio/cs2-sound-events.json';
import type { ObsEvent, Observe, PawnObs } from '../src/contracts/index';
import type { Effect } from '../src/app/effects';
import { GUNS, SOUNDS, SOUND_IDS, cs2EventNames, type SoundDef } from '../src/app3d/audio/events';
import { SoundDirector, type CueOptions, type DirectorInput, type SoundSink } from '../src/app3d/audio/director';
import { closestApproach, distanceGain, evalCurve, occlusion, occlusionTargets } from '../src/app3d/audio/spatial';
import { renderSynth, wavBytes } from '../src/app3d/audio/synth';
import { AUDIO_TUNING } from '../src/app3d/audio/tuning';
import { loadHarness3dData, runHarness3d } from '../tools/harness3d';

type Ev = { files: string[]; curve: number[][]; volume: number; occlusion: number; children: string[] };
const events = (manifest as unknown as { events: Record<string, Ev>; missing: string[]; files: Record<string, number> }).events;

describe('the sound table and the CS2 manifest', () => {
  it('names only CS2 events that exist, each with files', () => {
    expect((manifest as { missing: string[] }).missing).toEqual([]);
    for (const name of cs2EventNames()) {
      expect(events[name], name).toBeDefined();
      expect((events[name] as Ev).files.length, name).toBeGreaterThan(0);
    }
    // Every file the events name is in pak01's file list.
    for (const [f, size] of Object.entries((manifest as { files: Record<string, number> }).files)) expect(size, f).toBeGreaterThan(0);
  });

  it('has fire, draw and reload sounds for every gun, and the AK-47 is CS2s', () => {
    for (const g of GUNS) {
      expect(SOUNDS[`fire.${g}`]).toBeDefined();
      expect(SOUNDS[`draw.${g}`]).toBeDefined();
      expect(SOUNDS[`reload.${g}.clipout`]).toBeDefined();
      expect(SOUNDS[`reload.${g}.clipin`]).toBeDefined();
    }
    expect(SOUNDS['fire.ak47']?.cs2).toEqual(['Weapon_AK47.Single']);
    expect(events['Weapon_AK47.Single']?.files).toEqual(['sounds/weapons/ak47/ak47_02.vsnd', 'sounds/weapons/ak47/ak47_01.vsnd', 'sounds/weapons/ak47/ak47_04.vsnd']);
    expect(events['Weapon_AK47.Single']?.children).toEqual(['Weapon_AK47.SingleDistant']);
    expect(SOUNDS['fire.m4a1s']?.cs2).toEqual(['Weapon_M4A1.Silenced']);
    expect(SOUNDS['fire.usps']?.cs2).toEqual(['Weapon_USP.SilencedShot']);
  });
});

describe('CS2 distance curves and occlusion', () => {
  const ak = (events['Weapon_AK47.Single'] as Ev).curve;
  const far = (events['Weapon_AK47.SingleDistant'] as Ev).curve;
  const step = (events['T_Concrete.StepLeft'] as Ev).curve;

  it('passes through every point and is flat outside them', () => {
    for (const c of [ak, far, step]) for (const p of c) expect(evalCurve(c, p[0] as number)).toBeCloseTo(Math.max(0, p[1] as number), 9);
    expect(evalCurve(ak, 0)).toBeCloseTo(0.8, 9);
    expect(evalCurve(ak, 10000)).toBeCloseTo(0.014706, 6);
    expect(evalCurve([], 123)).toBe(1);
  });

  it('fades the AK-47 with distance while its distant layer takes over', () => {
    let prev = Infinity;
    for (let d = 200; d <= 2500; d += 100) {
      const g = evalCurve(ak, d);
      expect(g).toBeLessThanOrEqual(prev + 1e-9);
      prev = g;
    }
    expect(evalCurve(far, 500)).toBe(0);
    expect(evalCurve(far, 2335.836914)).toBeCloseTo(0.540441, 6);
    expect(distanceGain(1.1, ak, 440)).toBeCloseTo(1.1 * 0.735294, 6);
  });

  it('makes running footsteps inaudible past 1,100 units, as CS2', () => {
    expect(evalCurve(step, 116.563492)).toBeCloseTo(1, 9);
    expect(evalCurve(step, 1100)).toBe(0);
    expect(evalCurve(step, 1500)).toBe(0);
    expect(evalCurve(step, 700)).toBeGreaterThan(0);
  });

  it('occludes by the share of blocked rays × the event intensity', () => {
    expect(occlusion(0.6, 0)).toEqual({ gain: 1, lowpassHz: AUDIO_TUNING.occlusion.openLowpassHz });
    const full = occlusion(0.6, 1);
    expect(full.gain).toBeCloseTo(1 - 0.6 * AUDIO_TUNING.occlusion.depth, 9);
    expect(full.lowpassHz).toBeLessThan(AUDIO_TUNING.occlusion.openLowpassHz);
    expect(occlusion(1, 1).lowpassHz).toBeCloseTo(AUDIO_TUNING.occlusion.occludedLowpassHz, 6);
    const out = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, z: 0 }));
    occlusionTargets({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, 16, out);
    expect(out).toEqual([
      { x: 100, y: 0, z: 0 },
      { x: 100, y: 16, z: 0 },
      { x: 100, y: -16, z: 0 },
      { x: 100, y: 0, z: 16 },
    ]);
  });

  it('finds where a bullet passes the ear', () => {
    const c = closestApproach({ x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: 500, y: 30, z: 0 });
    expect(c?.distance).toBeCloseTo(30, 9);
    expect(c?.t).toBeCloseTo(0.5, 9);
    expect(closestApproach({ x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: -50, y: 0, z: 0 })).toBeNull();
  });
});

describe('placeholder sounds', () => {
  it('renders every sound, deterministically, at its peak gain', () => {
    for (const id of SOUND_IDS) {
      const s = (SOUNDS[id] as { synth: { dur: number; gain?: number } }).synth;
      const a = renderSynth((SOUNDS[id] as SoundDef).synth, id, 8000);
      expect(a.length).toBe(Math.max(1, Math.round(s.dur * 8000)));
      let peak = 0;
      for (const v of a) {
        expect(Number.isFinite(v)).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
      expect(peak, id).toBeCloseTo(s.gain ?? 0.8, 6);
    }
    const ak = (SOUNDS['fire.ak47'] as SoundDef).synth;
    expect(renderSynth(ak, 'fire.ak47', 8000)).toEqual(renderSynth(ak, 'fire.ak47', 8000));
    const wav = wavBytes(new Float32Array([0, 1, -1]), 8000);
    expect(wav.length).toBe(44 + 6);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
  });
});

class FakeSink implements SoundSink {
  readonly played: { id: string; pos: unknown; opts: CueOptions }[] = [];
  readonly loops = new Map<string, string>();
  stops = 0;
  play(id: string, pos: unknown, opts: CueOptions): void {
    this.played.push({ id, pos, opts });
  }
  loop(key: string, id: string): void {
    this.loops.set(key, id);
  }
  stopLoop(key: string): void {
    this.loops.delete(key);
  }
  stopAll(): void {
    this.stops++;
  }
  ids(): string[] {
    return this.played.map((p) => p.id);
  }
}

function pawn(id: PawnObs['id'], team: PawnObs['team'], weapon: PawnObs['weapon'], x = 0): PawnObs {
  return { id, team, weapon, pos: { x, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, hp: 100, armor: 100, alive: true, ammo: { clip: 30, reserve: 90 }, crouching: false, onGround: true, sees: [] } as unknown as PawnObs;
}

function obs(tick: number, pawns: PawnObs[], events: ObsEvent[] = []): Observe {
  return { tick, t: tick / 64, pawns, events, round: { phase: 'live', bomb: { state: 'carried' } } } as unknown as Observe;
}

function input(o: Observe, extra: Partial<DirectorInput> = {}): DirectorInput {
  return { observe: o, bullets: [], effects: [], listener: 'cart', ear: { x: 0, y: 0, z: 64 }, reloadSec: () => 2.5, cycleSec: () => 0.1, ...extra };
}

describe('the director', () => {
  const cart = pawn('cart', 'T', 'ak47');
  const lokier = pawn('lokier', 'CT', 'ssg08', 800);

  it('fires, reloads in stages at their fractions of the reload time, and resets on a seek', () => {
    const sink = new FakeSink();
    const d = new SoundDirector(sink);
    d.ingest(input(obs(100, [cart, lokier])));
    d.ingest(input(obs(101, [cart, lokier], [{ type: 'shot', shooter: 'lokier', weapon: 'ssg08' }])));
    expect(sink.played[0]).toMatchObject({ id: 'fire.ssg08', opts: { origin: true, self: false } });
    d.ingest(input(obs(102, [cart, lokier], [{ type: 'sound', source: 'cart', pos: cart.pos, kind: 'reload' }])));
    for (let t = 103; t <= 270; t++) d.ingest(input(obs(t, [cart, lokier])));
    const at = d.recent.filter((c) => c.id.startsWith('reload.')).map((c) => `${c.tick} ${c.id}`);
    // Reload started while the host simulated tick 101: clipout 0.17 × 160, clipin 0.52 × 160, bolt 0.78 × 160.
    expect(at).toEqual(['128 reload.ak47.clipout', '184 reload.ak47.clipin', '226 reload.ak47.bolt']);
    expect(sink.played.find((p) => p.id === 'reload.ak47.clipout')?.opts.self).toBe(true);
    // The SSG 08's bolt after its shot.
    expect(sink.ids()).toContain('cycle.ssg08.back');
    const n = sink.played.length;
    d.ingest(input(obs(10, [cart, lokier])));
    expect(sink.played.length).toBe(n);
    expect(sink.stops).toBe(1);
  });

  it('plays hits, the helmet dink, feedback and kill confirm for the right ears', () => {
    const sink = new FakeSink();
    const d = new SoundDirector(sink);
    d.ingest(input(obs(2000, [cart, lokier])));
    d.ingest(
      input(
        obs(2001, [cart, lokier], [
          { type: 'damage', attacker: 'cart', victim: 'lokier', amount: 100, armor: 5, weapon: 'ak47', hitgroup: 'head', scripted: false },
          { type: 'death', victim: 'lokier', attacker: 'cart', weapon: 'ak47', headshot: true },
        ]),
      ),
    );
    expect(sink.ids()).toEqual(['hit.head.helmet', 'feedback.head.helmet', 'death.head', 'kill.feedback.head']);
    d.ingest(input(obs(2002, [cart, lokier], [{ type: 'damage', attacker: 'lokier', victim: 'cart', amount: 73, armor: 7, weapon: 'ssg08', hitgroup: 'chest', scripted: true }])));
    expect(sink.ids().at(-1)).toBe('victim.body');
  });

  it('steps by team and surface, beeps the bomb, ends the round by side', () => {
    const sink = new FakeSink();
    const d = new SoundDirector(sink, () => 'wood');
    d.ingest(input(obs(2000, [cart, lokier])));
    d.ingest(
      input(
        obs(2001, [cart, lokier], [
          { type: 'sound', source: 'lokier', pos: lokier.pos, kind: 'footstep' },
          { type: 'sound', source: null, pos: { x: 5, y: 5, z: 0 }, kind: 'bomb' },
          { type: 'round_end', winner: 'CT', reason: 'bomb_defused' },
        ]),
      ),
    );
    expect(sink.ids()).toEqual(['step.CT.wood', 'c4.beep', 'round.lost', 'announce.ctwin']);
    expect(sink.played[2]?.opts.gain).toBe(AUDIO_TUNING.music.roundEnd);
  });

  it('throws, bounces, pops and burns grenades from the effects', () => {
    const sink = new FakeSink();
    const d = new SoundDirector(sink);
    const fx = (z: number, phase: Effect['phase'], kind: Effect['kind'] = 'molotov'): Effect => ({ seq: 7, kind, phase, thrower: 'cart', pos: { x: 100, y: 0, z }, radius: phase === 'fire' ? 120 : 0, untilTick: 999 });
    d.ingest(input(obs(2000, [cart, lokier])));
    d.ingest(input(obs(2001, [cart, lokier]), { effects: [fx(70, 'flying')] }));
    d.ingest(input(obs(2002, [cart, lokier]), { effects: [fx(40, 'flying')] }));
    d.ingest(input(obs(2003, [cart, lokier]), { effects: [fx(10, 'flying')] }));
    d.ingest(input(obs(2004, [cart, lokier]), { effects: [fx(30, 'flying')] }));
    d.ingest(input(obs(2005, [cart, lokier], [{ type: 'sound', source: 'cart', pos: { x: 100, y: 0, z: 0 }, kind: 'grenade' }]), { effects: [fx(0, 'fire')] }));
    expect(sink.ids()).toEqual(['throw.molotov', 'bounce.molotov', 'pop.molotov']);
    expect(sink.loops.get('burn.7')).toBe('burn.molotov');
    d.ingest(input(obs(2006, [cart, lokier])));
    expect(sink.loops.size).toBe(0);
    expect(sink.ids().at(-1)).toBe('out.molotov');
  });

  it('whizzes when someone else’s bullet passes the ear, and hits the wall where it stopped', () => {
    const sink = new FakeSink();
    const d = new SoundDirector(sink);
    d.ingest(input(obs(2000, [cart, lokier])));
    d.ingest(input(obs(2001, [cart, lokier]), { bullets: [{ shooter: 'lokier', from: { x: 800, y: 0, z: 64 }, to: { x: -500, y: 20, z: 64 }, victim: null, wall: true }] }));
    expect(sink.ids()).toEqual(['impact.concrete', 'whiz']);
  });
});

describe('the director on the recorded round (Sim3DHost, nobody plays)', () => {
  const run = runHarness3d(loadHarness3dData(), { human: null, driver: null, lastTick: 'end', seed: 1 });
  const sink = new FakeSink();
  const d = new SoundDirector(sink);
  for (const e of run.entries) d.ingest(input(e.observe, { listener: 'cart', reloadSec: () => 2.5 }));
  const ids = sink.ids();
  const count = (p: string): number => ids.filter((i) => i === p || i.startsWith(p + '.')).length;

  it('sounds every kill, the plant, every beep, the defuse and the round end', () => {
    expect(count('death') + count('death.head') + count('death.self')).toBeGreaterThanOrEqual(9);
    expect(count('c4.plant')).toBe(1);
    expect(count('c4.defuse.start')).toBe(1);
    expect(count('c4.defused')).toBe(1);
    const beeps = run.entries.flatMap((e) => e.observe.events.filter((ev) => ev.type === 'sound' && ev.kind === 'bomb')).length;
    expect(beeps).toBeGreaterThan(20);
    expect(count('c4.beep')).toBe(beeps);
    expect(ids.filter((i) => i === 'round.won').length).toBe(0);
    expect(ids.filter((i) => i === 'round.lost').length).toBe(1);
    expect(ids.filter((i) => i.startsWith('step.')).length).toBeGreaterThan(50);
  });
});
