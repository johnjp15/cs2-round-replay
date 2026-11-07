/**
 * A1: the viewmodels without WebGL: every model builds into a small mesh, the poses follow the weapon state
 * machine's timings (deploy, fire, reload stages, knife, C4, grenade), and the tracker reads those timings from the
 * host's weapon state.
 */
import { describe, expect, it } from 'vitest';
import type { PawnObs } from '../src/contracts/index';
import { RELOAD_STAGES } from '../src/app3d/audio/events';
import { mergeParts, triangles } from '../src/app3d/viewmodels/parts';
import { WEAPON_MODELS, modelOf } from '../src/app3d/viewmodels/models';
import { freshPose, vmPose, type VmAnim } from '../src/app3d/viewmodels/pose';
import { VmTracker, readTimers } from '../src/app3d/viewmodels/tracker';

const idle = (weapon: string, extra: Partial<VmAnim> = {}): VmAnim => ({ weapon, sinceShot: 1e6, cycle: 0.1, reload: null, deploy: null, swing: null, plant: null, primed: false, thrown: null, speed: 0, time: 0, ...extra });

describe('weapon models', () => {
  it('builds every model in a few hundred triangles, the muzzle ahead of the grip', () => {
    for (const [id, m] of Object.entries(WEAPON_MODELS)) {
      const g = mergeParts([...m.body, ...(m.mag ?? []), ...(m.bolt ?? []), ...(m.pin ?? [])]);
      expect(triangles(g), id).toBeGreaterThan(10);
      expect(triangles(g), id).toBeLessThan(1500);
      expect(m.muzzle[2], id).toBeLessThan(0);
      const pos = g.getAttribute('position').array as Float32Array;
      for (const v of pos) expect(Number.isFinite(v)).toBe(true);
    }
    // Real sizes (Source units): the AK-47 ≈ 35 in, the AWP longer, pistols short.
    const len = (id: string): number => {
      const g = mergeParts(modelOf(id).body);
      g.computeBoundingBox();
      return (g.boundingBox?.max.z ?? 0) - (g.boundingBox?.min.z ?? 0);
    };
    expect(len('ak47')).toBeGreaterThan(33);
    expect(len('ak47')).toBeLessThan(40);
    expect(len('awp')).toBeGreaterThan(len('ak47'));
    expect(len('glock')).toBeLessThan(10);
    expect(modelOf('nonexistent')).toBe(WEAPON_MODELS['knife']);
  });
});

describe('viewmodel poses', () => {
  const ak = modelOf('ak47');
  const pose = freshPose();

  it('deploys from below and settles before the deploy ends', () => {
    vmPose(idle('ak47', { deploy: { t: 0, dur: 1 } }), ak, pose);
    expect(pose.phase).toBe('deploy');
    expect(pose.y).toBeLessThan(-8);
    vmPose(idle('ak47', { deploy: { t: 0.5, dur: 1 } }), ak, pose);
    expect(pose.y).toBeCloseTo(0, 6);
    vmPose(idle('ak47', { deploy: { t: 1, dur: 1 } }), ak, pose);
    expect(pose.phase).toBe('idle');
  });

  it('kicks, flashes for 35 ms and works the bolt on a shot', () => {
    vmPose(idle('ak47', { sinceShot: 0.01 }), ak, pose);
    expect(pose.phase).toBe('fire');
    expect(pose.flash).toBe(true);
    expect(pose.z).toBeGreaterThan(0.5);
    vmPose(idle('ak47', { sinceShot: 0.04 }), ak, pose);
    expect(pose.flash).toBe(false);
    // AWP: the bolt travels back between 38 % and 60 % of its 1.455 s cycle.
    const awp = modelOf('awp');
    vmPose(idle('awp', { sinceShot: 0.49 * 1.455, cycle: 1.455 }), awp, pose);
    expect(pose.bolt).toBeCloseTo(awp.boltTravel, 6);
    vmPose(idle('awp', { sinceShot: 0.2, cycle: 1.455 }), awp, pose);
    expect(pose.bolt).toBe(0);
  });

  it('reloads through mag out, mag in and the bolt at the reload sounds’ fractions', () => {
    const st = RELOAD_STAGES.ak47;
    const at = (p: number): typeof pose => vmPose(idle('ak47', { reload: { t: p * 2.5, dur: 2.5 } }), ak, pose);
    at(0.05);
    expect(pose.phase).toBe('reload');
    expect(pose.magVisible).toBe(true);
    at((st.clipout as number) + 0.12);
    expect(pose.magVisible).toBe(false);
    at(((st.clipout as number) + (st.clipin as number)) / 2 + 0.08);
    expect(pose.magVisible).toBe(true);
    expect(pose.magY).toBeLessThan(0);
    at(st.clipin as number);
    expect(pose.magY).toBeCloseTo(0, 6);
    at((st.bolt as number) + 0.01);
    expect(pose.bolt).toBeGreaterThan(0);
    at(0.97);
    expect(pose.rz).toBeCloseTo(0, 6);
    vmPose(idle('ak47', { reload: { t: 2.5, dur: 2.5 } }), ak, pose);
    expect(pose.phase).toBe('idle');
  });

  it('swings the knife, plants the C4, primes and throws a grenade', () => {
    vmPose(idle('knife', { swing: 0.2 }), modelOf('knife'), pose);
    expect(pose.phase).toBe('swing');
    expect(Math.abs(pose.ry)).toBeGreaterThan(0.5);
    vmPose(idle('c4', { plant: 1 }), modelOf('c4'), pose);
    expect(pose.phase).toBe('plant');
    vmPose(idle('he', { primed: true }), modelOf('he'), pose);
    expect(pose.pinVisible).toBe(false);
    vmPose(idle('he', { thrown: 0.2 }), modelOf('he'), pose);
    expect(pose.visible).toBe(false);
  });
});

describe('the viewmodel tracker', () => {
  const p = (weapon: PawnObs['weapon']): PawnObs => ({ id: 'cart', team: 'T', weapon }) as unknown as PawnObs;

  it('reads deploy and reload from the host weapon state (sim2d and H2 shapes)', () => {
    expect(readTimers({ deployEndTick: 64, reloadEndTick: null, grenadePrimed: false, nextAttackTick: 0 })).toEqual({ deployEndTick: 64, reloadEndTick: null, grenadePrimed: false });
    expect(readTimers({ deployEndTick: 10, reload: { kind: 'magazine', endTick: 170 } })?.reloadEndTick).toBe(170);
    expect(readTimers(null)).toBeNull();
  });

  it('runs the reload from its start to the state machine’s end tick', () => {
    const t = new VmTracker();
    t.ingest(100, p('ak47'), { deployEndTick: 0, reloadEndTick: null, grenadePrimed: false }, false, false);
    // The host started the reload while simulating tick 100: ends at 100 + 160 (2.5 s).
    t.ingest(101, p('ak47'), { deployEndTick: 0, reloadEndTick: 260, grenadePrimed: false }, false, false);
    const a = t.anim(180, 0.1, 0, 0);
    expect(a?.reload).toEqual({ t: 80 / 64, dur: 2.5 });
    expect(t.anim(260, 0.1, 0, 0)?.reload).toBeNull();
    // Switching weapons deploys for the state machine's deploy time.
    t.ingest(102, p('glock'), { deployEndTick: 165, grenadePrimed: false, reloadEndTick: null }, false, false);
    expect(t.anim(120, 0.15, 0, 0)?.deploy).toEqual({ t: 19 / 64, dur: 64 / 64 });
    // A seek (tick jump) resets without a deploy.
    t.ingest(5, p('ak47'), null, false, false);
    expect(t.anim(5, 0.1, 0, 0)?.deploy).toBeNull();
  });
});
