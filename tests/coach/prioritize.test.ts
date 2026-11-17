/** K5: the prioritizer on synthetic findings: spread across scopes, root families, the bar, the precision gate, ties. */
import { describe, expect, it } from 'vitest';
import { loadReportTuning, REPORT_TUNING } from '../../src/coach/analyze/report-tuning';
import type { Finding, FindingScope, Polarity } from '../../src/coach/model/report';
import { lobbyExcess, prioritize, rootFamily } from '../../src/coach/report/prioritize';
import json from '../../data/coach/tuning/report.json';

interface Spec { id: string; scope?: FindingScope; polarity?: Polarity; impact?: number; confidence?: number; instances?: number; value?: number; lobby?: number[]; evidence?: number }

function finding(s: Spec): Finding {
  return {
    id: s.id, area: 'aim', scope: s.scope ?? 'mechanics', polarity: s.polarity ?? 'fix', title: s.id, summary: '', why: '', advice: [],
    metrics: [{ id: `${s.id}.m`, value: s.value ?? 0.5, unit: '%', n: 10, lobbyRank: 5, lobby: s.lobby ?? [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] }],
    evidence: Array.from({ length: s.evidence ?? 1 }, () => ({ kind: 'replay' as const, round: 1, tick0: 0, tick1: 10, focus: 5, players: [0], annotations: [], caption: '' })),
    stats: { instances: s.instances ?? 10, opportunities: 20, rounds: [1], roundsLost: 0, winProbLost: null },
    confidence: s.confidence ?? 0.9, impact: s.impact ?? 3, priority: 0,
  };
}

describe('prioritize', () => {
  it('picks one fix per scope before a second of the same scope, and orders them by priority', () => {
    const fs = [
      finding({ id: 'aim.counter_strafe.early', scope: 'mechanics', impact: 6 }),
      finding({ id: 'aim.spray.drift', scope: 'mechanics', impact: 5 }),
      finding({ id: 'trade.missed.no_damage', scope: 'micro', impact: 2 }),
      finding({ id: 'eco.sync.off', scope: 'macro', impact: 1.5 }),
    ];
    const r = prioritize(fs);
    expect(r.topFixes).toEqual(['aim.counter_strafe.early', 'trade.missed.no_damage', 'eco.sync.off']);
  });

  it('fills the rest by priority when a scope has no candidate above the bar', () => {
    const fs = [
      finding({ id: 'aim.counter_strafe.early', impact: 6 }),
      finding({ id: 'aim.spray.drift', impact: 5 }),
      finding({ id: 'eco.sync.off', scope: 'macro', impact: 0.2 }), // below the bar
    ];
    expect(prioritize(fs).topFixes).toEqual(['aim.counter_strafe.early', 'aim.spray.drift']);
  });

  it('never picks two findings of one root family', () => {
    expect(rootFamily('aim.first_bullet.low')).toBe(rootFamily('aim.counter_strafe.early'));
    expect(rootFamily('move.caught_out.deaths')).toBe('gun-ready');
    expect(rootFamily('util.flash.no_enemy')).toBe('util.flash');
    const fs = [
      finding({ id: 'aim.counter_strafe.early', impact: 6 }),
      finding({ id: 'aim.first_bullet.low', impact: 5 }),
      finding({ id: 'util.flash.no_enemy', scope: 'micro', impact: 1 }),
      finding({ id: 'util.flash.team', scope: 'micro', impact: 1 }),
    ];
    expect(prioritize(fs).topFixes).toEqual(['aim.counter_strafe.early', 'util.flash.no_enemy']);
  });

  it('needs evidence, confidence and impact above the bar', () => {
    const fs = [
      finding({ id: 'aim.counter_strafe.early', evidence: 0 }),
      finding({ id: 'aim.spray.drift', confidence: 0.1 }),
      finding({ id: 'trade.missed.no_damage', scope: 'micro', impact: 0.5 }),
    ];
    const r = prioritize(fs);
    expect(r.topFixes).toEqual([]);
    expect(fs.map((f) => f.scoring?.bar)).toEqual([false, false, false]);
  });

  it('scales count-based detectors by the lobby excess: a habit the lobby shares cannot lead', () => {
    // move.reload is lobby-baselined: 75 % against a lobby median of 70 % keeps a fifteenth of its impact.
    const common = finding({ id: 'move.reload.exposed', scope: 'micro', impact: 3, value: 0.75, lobby: [0.75, 0.7, 0.7, 0.7, 0.8, 0.6, NaN, 0.7, 0.7, 0.7] });
    const rare = finding({ id: 'trade.missed.no_damage', scope: 'micro', impact: 2, value: 0.8, lobby: [0.8, 0.2, 0.2, 0.3, 0.1, NaN, NaN, NaN, NaN, NaN] });
    const r = prioritize([common, rare], { user: 0, better: () => 'lower' });
    expect(common.scoring?.excess).toBeCloseTo(0.0667, 3);
    expect(common.impact).toBeCloseTo(0.2, 3);
    expect(r.topFixes).toEqual(['trade.missed.no_damage']);
    // The aim detectors measure against the lobby already: not scaled.
    const aim = finding({ id: 'aim.counter_strafe.early', impact: 3, value: 0.2, lobby: [0.2, 0.5, 0.5, 0.5] });
    prioritize([aim], { user: 0, better: () => 'lower' });
    expect(aim.scoring?.excess).toBe(1);
  });

  it('lobby excess: direction, the median of the others, too small a lobby', () => {
    expect(lobbyExcess(0.8, [0.8, 0.4, 0.4, 0.4], 0, 'lower', 3)).toBeCloseTo(0.5);
    expect(lobbyExcess(0.2, [0.2, 0.4, 0.4, 0.4], 0, 'higher', 3)).toBeCloseTo(0.5);
    expect(lobbyExcess(0.3, [0.3, 0.4, 0.4, 0.4], 0, 'lower', 3)).toBe(0);
    expect(lobbyExcess(0.8, [0.8, 0.4, NaN, NaN], 0, 'lower', 3)).toBe(1);
    expect(lobbyExcess(0.8, [0.8, 0.4, 0.4, 0.4], 0, null, 3)).toBe(1);
  });

  it('a pattern seen twice weighs less than one seen eight times (instance factor)', () => {
    const two = finding({ id: 'eco.sync.off', scope: 'macro', instances: 2 });
    const eight = finding({ id: 'eco.kit_armor.holes', scope: 'macro', instances: 8 });
    prioritize([two, eight]);
    expect((two.scoring?.confidence ?? 0) / 0.9).toBeCloseTo(1 - Math.exp(-2 / REPORT_TUNING.prioritizer.instanceScale), 4);
    expect(eight.priority).toBeGreaterThan(two.priority);
  });

  it('turns findings of a detector measured below the precision gate into observations', () => {
    const t = loadReportTuning({ ...json, gate: { ...json.gate, measured: { 'aim.spray': 0.7, 'aim.counter_strafe': 0.95 } } });
    const fs = [
      finding({ id: 'aim.spray.drift', impact: 9 }),
      finding({ id: 'aim.counter_strafe.early', impact: 2 }),
      finding({ id: 'aim.spray.controlled', polarity: 'strength', impact: 2 }),
    ];
    const r = prioritize(fs, { tuning: t });
    expect(fs.map((f) => f.polarity)).toEqual(['observation', 'fix', 'observation']);
    expect(fs[0]?.scoring?.gated).toBe(true);
    expect(r.topFixes).toEqual(['aim.counter_strafe.early']);
    expect(r.strengths).toEqual([]);
  });

  it('breaks priority ties by id and is idempotent', () => {
    const fs = [finding({ id: 'b.two.x', scope: 'micro' }), finding({ id: 'a.one.x', scope: 'micro' }), finding({ id: 'c.three.x', scope: 'micro' }), finding({ id: 'd.four.x', scope: 'micro' })];
    const first = prioritize(fs);
    expect(first.topFixes).toEqual(['a.one.x', 'b.two.x', 'c.three.x']);
    const again = prioritize(fs);
    expect(again).toEqual(first);
    expect(fs.map((f) => f.impact)).toEqual([3, 3, 3, 3]);
  });

  it('recurrence raises the priority of a family seen in earlier matches', () => {
    const a = finding({ id: 'util.flash.no_enemy', scope: 'micro', impact: 2 });
    const b = finding({ id: 'trade.missed.no_damage', scope: 'micro', impact: 2.2 });
    expect(prioritize([a, b]).topFixes[0]).toBe('trade.missed.no_damage');
    expect(prioritize([a, b], { recurrence: { 'util.flash': 2 } }).topFixes[0]).toBe('util.flash.no_enemy');
    expect(a.scoring?.recurrence).toBe(1.5);
  });

  it('picks up to two strengths, one per family', () => {
    const fs = [
      finding({ id: 'aim.first_bullet.sharp', polarity: 'strength', impact: 3 }),
      finding({ id: 'aim.counter_strafe.clean', polarity: 'strength', impact: 2 }),
      finding({ id: 'util.damage.strength', polarity: 'strength', impact: 0 }),
      finding({ id: 'pos.opening.strength', polarity: 'strength', impact: 0, confidence: 0.95 }),
    ];
    expect(prioritize(fs).strengths).toEqual(['aim.first_bullet.sharp', 'pos.opening.strength']);
  });
});
