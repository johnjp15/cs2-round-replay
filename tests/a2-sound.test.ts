/**
 * A2: the sound fixes, measured (docs/audio.md):
 *  - every placeholder has an envelope (no click at either end), no DC, no clipping, its kind's duration, and no two
 *    CS2 events share one sound (tools/audio-analyze.ts, the same analysis the before / after table comes from);
 *  - levels: a gunshot is louder than a footstep, a footstep than a reload click; CS2's mixer volumes;
 *  - the C4 cadence accelerates from 1 s to 0.15 s and switches to the 10-second sound;
 *  - the director on the recorded round from 15 s to 20 s (no human): one shot cue per shot event, one step cue per
 *    footstep event (the host's step cadence, not every tick), each cue on its event's tick, nothing twice, and a seek
 *    into the window sounds nothing until the next tick.
 */
import { describe, expect, it } from 'vitest';
import type { Observe } from '../src/contracts/index';
import { SoundDirector, c4BeepTicks, type CueOptions, type DirectorInput, type SoundSink } from '../src/app3d/audio/director';
import { SOUNDS, SOUND_IDS } from '../src/app3d/audio/events';
import { mixgroupGain } from '../src/app3d/audio/engine';
import { clipCurve } from '../src/app3d/audio/engine';
import { analyze } from '../tools/audio-analyze';
import { loadHarness3dData, runHarness3d } from '../tools/harness3d';
import { gunOf } from '../src/app3d/audio/events';

describe('placeholders (A2)', () => {
  const { rows } = analyze(32000);
  const by = new Map(rows.map((r) => [r.id, r]));

  it('have no clicks, DC, clipping, odd durations or duplicates', () => {
    expect(rows.length).toBe(SOUND_IDS.length);
    const bad = rows.filter((r) => r.problems.length > 0).map((r) => `${r.id}: ${r.problems.join('; ')}`);
    // Two whooshes may come close (a knife swing and a thrown grenade are both swishes); nothing else may.
    expect(bad.filter((b) => !/^(knife\.swing|throw\.\w+): same as (knife\.swing|throw\.\w+)/.test(b))).toEqual([]);
    for (const r of rows) {
      expect(r.m.peakDb, r.id).toBeLessThanOrEqual(-0.99);
      expect(Math.abs(r.m.dc), r.id).toBeLessThan(0.005);
    }
  });

  it('are as loud as their kind: shots > hits > footsteps > reload clicks', () => {
    const lvl = (id: string): number => (by.get(id) as { m: { shortDb: number } }).m.shortDb;
    expect(lvl('fire.ak47')).toBeGreaterThan(lvl('hit.flesh') + 5);
    expect(lvl('fire.awp')).toBeGreaterThan(lvl('fire.ak47'));
    expect(lvl('fire.ak47')).toBeGreaterThan(lvl('fire.m4a1s') + 6);
    expect(lvl('hit.flesh')).toBeGreaterThan(lvl('step.CT.concrete') + 4);
    expect(lvl('step.CT.concrete')).toBeLessThan(lvl('fire.ak47') - 12);
    // A rifle shot: a sharp transient (peak within 2 ms) and low-end thump.
    const ak = (by.get('fire.ak47') as { m: { attackMs: number; bands: readonly number[]; durSec: number } }).m;
    expect(ak.attackMs).toBeLessThan(2);
    expect(ak.bands[1]).toBeGreaterThan(0.15);
    // Footsteps: 60–160 ms.
    expect((by.get('step.T.concrete') as { m: { durSec: number } }).m.durSec).toBeLessThan(0.16);
  });

  it('render variants that differ', () => {
    expect(SOUNDS['step.CT.concrete']?.variants).toBe(4);
    expect(SOUNDS['fire.ak47']?.variants).toBe(3);
  });
});

describe('the mix (A2)', () => {
  it('uses CS2 Default_Mix volumes (scripts/soundmixers.txt)', () => {
    expect(mixgroupGain('Weapons')).toBeCloseTo(0.6, 9);
    expect(mixgroupGain('WeaponsDistant')).toBeCloseTo(0.6, 9);
    expect(mixgroupGain('Footsteps')).toBeCloseTo(0.8, 9);
    expect(mixgroupGain('BulletImpacts')).toBeCloseTo(0.3, 9);
    expect(mixgroupGain('Explosions')).toBeCloseTo(0.7, 9);
    expect(mixgroupGain('PlayerVictim')).toBeCloseTo(1, 9);
    expect(mixgroupGain('')).toBe(1);
  });

  it('soft-clips into the ceiling and never beyond it', () => {
    const c = clipCurve(4097, 0.85, 0.98);
    expect(Math.max(...c)).toBeLessThanOrEqual(0.98);
    expect(Math.min(...c)).toBeGreaterThanOrEqual(-0.98);
    expect(c[2048]).toBeCloseTo(0, 9);
    // Linear below the knee.
    expect(c[Math.round(2048 + 0.5 * 2048)]).toBeCloseTo(0.5, 3);
  });
});

describe('the C4 beep cadence (A2)', () => {
  const list = c4BeepTicks(1000, 40);
  it('accelerates from 1 s to 0.15 s and switches sound for the last 10 s', () => {
    expect((list[0] as { tick: number }).tick).toBe(1064);
    const gaps = list.slice(1).map((b, i) => b.tick - (list[i] as { tick: number }).tick);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i] as number).toBeLessThanOrEqual((gaps[i - 1] as number) + 1);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(9);
    expect(Math.min(...gaps)).toBeLessThanOrEqual(10);
    expect((list.at(-1) as { tick: number }).tick).toBeLessThan(1000 + 40 * 64);
    expect(list.filter((b) => b.last10).every((b) => b.tick >= 1000 + 30 * 64)).toBe(true);
    expect(list.filter((b) => !b.last10).every((b) => b.tick < 1000 + 30 * 64)).toBe(true);
    // About 80 beeps in 40 s.
    expect(list.length).toBeGreaterThan(60);
    expect(list.length).toBeLessThan(110);
  });
});

class LogSink implements SoundSink {
  readonly played: { id: string; opts: CueOptions }[] = [];
  play(id: string, _pos: unknown, opts: CueOptions): void {
    this.played.push({ id, opts });
  }
  loop(): void {}
  stopLoop(): void {}
  stopAll(): void {}
}

describe('the director on the recorded round, 15–20 s, no human (A2)', () => {
  const run = runHarness3d(loadHarness3dData(), { human: null, driver: null, lastTick: 1300, seed: 1 });
  const from = 15 * 64;
  const to = 20 * 64;
  const entries = run.entries.filter((e) => e.observe.tick >= from && e.observe.tick <= to);
  const input = (o: Observe): DirectorInput => ({ observe: o, bullets: [], effects: [], listener: 'cart', ear: { x: 0, y: 0, z: 64 }, reloadSec: () => 2.5, cycleSec: () => 0.1 });
  const sink = new LogSink();
  const d = new SoundDirector(sink);
  // A seek lands on 15 s (the director starts fresh there), then the round plays.
  for (const e of entries) d.ingest(input(e.observe));
  const inWindow = (t: number): boolean => t >= from && t <= to;
  const shots = entries.flatMap((e) => (inWindow(e.observe.tick) ? e.observe.events.filter((ev) => ev.type === 'shot' && gunOf(ev.weapon) !== null).map(() => e.observe.tick) : []));
  const steps = entries.flatMap((e) => (inWindow(e.observe.tick) ? e.observe.events.filter((ev) => ev.type === 'sound' && ev.kind === 'footstep').map((ev) => ({ tick: e.observe.tick, src: (ev as { source: string | null }).source })) : []));

  it('cues every shot and every footstep once, on its tick', () => {
    const fire = sink.played.filter((p) => p.id.startsWith('fire.'));
    const step = sink.played.filter((p) => p.id.startsWith('step.'));
    expect(shots.length).toBeGreaterThan(0);
    expect(steps.length).toBeGreaterThan(10);
    expect(fire.map((p) => p.opts.tick)).toEqual(shots);
    expect(step.map((p) => p.opts.tick)).toEqual(steps.map((s) => s.tick));
    // Steps per pawn at the host's cadence (sound.footstepIntervalSec 0.3 s = 19.2 ticks), never every tick.
    const byPawn = new Map<string, number[]>();
    for (const p of step) byPawn.set(p.opts.source as string, [...(byPawn.get(p.opts.source as string) ?? []), p.opts.tick as number]);
    for (const [, ticks] of byPawn) for (let i = 1; i < ticks.length; i++) expect((ticks[i] as number) - (ticks[i - 1] as number)).toBeGreaterThanOrEqual(19);
  });

  it('replays nothing a seek skipped, and plays nothing twice', () => {
    // The director started at 15 s (a seek's landing): every cue belongs to an event from 15 s on.
    expect(Math.min(...sink.played.map((p) => p.opts.tick as number))).toBeGreaterThanOrEqual(from);
    const keys = sink.played.map((p) => `${p.opts.tick} ${p.id} ${p.opts.source ?? ''}`);
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i && !k.includes('impact') && !k.includes('ricochet'));
    // The same pawn may only repeat a cue on one tick if it had two such events (none in this window).
    expect(dup).toEqual([]);
    // Rewinding (a smaller tick) resets silently.
    const n = sink.played.length;
    d.ingest(input((entries[5] as { observe: Observe }).observe));
    expect(sink.played.length).toBe(n);
  });
});
