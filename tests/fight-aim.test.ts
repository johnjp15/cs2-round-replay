import { describe, expect, it } from 'vitest';
import { EventSchedule, RoundModel, ScriptPlan } from '../src/core/index';
import { buildLeads, easeStep } from '../src/core/fight-aim';
import { loadRound, loadTuning } from './round-fixture';

const tuning = loadTuning();

/** Steps of an ease from rest toward a fixed error `e` (degrees) with smooth time `sec`. */
function profile(e: number, sec: number): number[] {
  let done = 0;
  let vel = 0;
  const steps: number[] = [];
  for (let k = 0; k < 200 && Math.abs(e - done) > 0.05; k++) {
    const s = easeStep(e - done, vel, sec * 64, tuning.replay.aimTurnRateDegPerTick);
    done += s.step;
    vel = s.vel;
    steps.push(s.step);
  }
  return steps;
}

describe('F1 eased aim (src/core/fight-aim.ts)', () => {
  it('a flick eases in and out, never overshoots and never exceeds the peak rate', () => {
    for (const e of [5, 30, 90, 180]) {
      const steps = profile(e, tuning.replay.aimFlickSec);
      const peak = Math.max(...steps);
      expect(steps[0] as number, `${e}°`).toBeLessThan(peak * 0.6);
      expect(steps.at(-1) as number, `${e}°`).toBeLessThan(peak / 4);
      for (const s of steps) expect(s).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(tuning.replay.aimTurnRateDegPerTick);
      expect(steps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(e + 1e-9);
    }
    // A small correction takes 0.1–0.25 s; a 90° flick under 0.3 s (to within 0.5°).
    const within = (e: number): number => {
      let done = 0;
      return profile(e, tuning.replay.aimFlickSec).findIndex((s) => Math.abs(e - (done += s)) <= 0.5) + 1;
    };
    expect(within(10) / 64).toBeGreaterThanOrEqual(0.08);
    expect(within(10) / 64).toBeLessThanOrEqual(0.25);
    expect(within(90) / 64).toBeLessThanOrEqual(0.3);
  });

  it('pre-aims every recorded engagement at its target head-high, where the tape first has them in sight', () => {
    const round = loadRound();
    const model = new RoundModel(round);
    const plan = new ScriptPlan(model, new EventSchedule(round), tuning);
    const leads = buildLeads(model, plan.engagements, tuning.replay, tuning.damage);
    expect(leads).toHaveLength(plan.engagements.length);
    const lead = Math.round(tuning.replay.aimLeadSec * 64);
    for (const l of leads) {
      expect(l.sightTick).toBeLessThanOrEqual(l.windowFrom);
      expect(l.sightTick).toBeGreaterThanOrEqual(l.windowFrom - lead);
      expect(l.fromTick).toBe(l.sightTick - lead);
    }
    // cart ↔ Lokier: the tape's sighting at 17.45 s (cart saw Lokier on B) is the anticipated sight for both.
    const lk = leads.find((l) => l.shooter === 'lokier' && l.target === 'cart');
    expect(lk?.sightTick).toBe(Math.max(1117, (lk?.windowFrom ?? 0) - lead));
    const feet = model.trackAtTick('cart', lk?.sightTick ?? 0)?.pos;
    expect(lk?.point.z).toBeCloseTo((feet?.z ?? NaN) + (tuning.damage.bandHeights['head'] ?? NaN), 6);
  });
});
