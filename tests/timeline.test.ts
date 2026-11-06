/**
 * B5: the timeline scrubber's pure mapping (src/app/timeline.ts) and the summary overlay's view model and timing
 * (src/app/summary-overlay.ts).
 */
import { describe, expect, it } from 'vitest';
import type { RoundObs, RoundSummary } from '../src/contracts/index';
import { RoundModel } from '../src/core/index';
import { SUMMARY_DELAY_TICKS, summaryDue, summaryView } from '../src/app/summary-overlay';
import { formatVideoTime, fractionToTick, percentOf, pointerToTick, seekFraction, seekStepForKey, stepTarget, tickToFraction, timelineSpanTicks } from '../src/app/timeline';
import { loadRound, loadTuning } from './round-fixture';

const model = new RoundModel(loadRound());
const tuning = loadTuning();
const SPAN = timelineSpanTicks(
  model.players.map((p) => model.track(p.id).at(-1)?.tick ?? 0),
  tuning.replay.holdLastPositionSec,
);

describe('timeline mapping', () => {
  it('spans the golden round: the last track sample plus the hold (4,517 ticks, 70.6 s)', () => {
    expect(SPAN).toBe(4517);
    expect(formatVideoTime(SPAN)).toBe('1:10.5');
  });

  it('maps ticks to the bar and back, clamped', () => {
    expect([tickToFraction(0, SPAN), tickToFraction(SPAN, SPAN), tickToFraction(-5, SPAN), tickToFraction(9999, SPAN), tickToFraction(10, 0)]).toEqual([0, 1, 0, 1, 0]);
    expect([fractionToTick(0, SPAN), fractionToTick(1, SPAN), fractionToTick(0.5, SPAN), fractionToTick(-1, SPAN), fractionToTick(2, SPAN)]).toEqual([0, 4517, 2259, 0, 4517]);
    for (const tick of [0, 1, 320, 2560, 4275, 4517]) expect(fractionToTick(tickToFraction(tick, SPAN), SPAN)).toBe(tick);
    expect([percentOf(0, SPAN), percentOf(SPAN, SPAN), percentOf(2560, 5120)]).toEqual(['0%', '100%', '50%']);
  });

  it('maps a pointer over the bar to a tick (drag to seek)', () => {
    // A 1000 px bar starting at x = 100.
    expect(pointerToTick(100, 100, 1000, SPAN)).toBe(0);
    expect(pointerToTick(1100, 100, 1000, SPAN)).toBe(SPAN);
    expect(pointerToTick(600, 100, 1000, SPAN)).toBe(2259);
    expect(pointerToTick(50, 100, 1000, SPAN)).toBe(0);
    expect(pointerToTick(5000, 100, 1000, SPAN)).toBe(SPAN);
    expect(pointerToTick(600, 100, 0, SPAN)).toBe(0);
  });

  it('formats video time and seeks by key', () => {
    expect([formatVideoTime(0), formatVideoTime(2856), formatVideoTime(4275), formatVideoTime(63), formatVideoTime(-3)]).toEqual(['0:00.0', '0:44.6', '1:06.7', '0:00.9', '0:00.0']);
    expect([seekStepForKey('BracketLeft'), seekStepForKey('BracketRight'), seekStepForKey('KeyW')]).toEqual([-5, 5, null]);
    expect([stepTarget(3840, -5), stepTarget(100, -10), stepTarget(3840, 5)]).toEqual([55, 0, 65]);
  });

  it('reports seek progress', () => {
    // A seek back from 60 s to 40 s that rewound to the 35 s checkpoint steps 2240 → 2560.
    expect([seekFraction(2240, 2560, 2240), seekFraction(2240, 2560, 2400), seekFraction(2240, 2560, 2560), seekFraction(10, 10, 10), seekFraction(0, 1920, 960)]).toEqual([0, 0.5, 1, 1, 0.5]);
  });
});

describe('summary overlay', () => {
  const round = (phase: RoundObs['phase'], endTick: number | null): RoundObs => ({
    phase,
    score: { ct: 12, t: 15 },
    winner: endTick === null ? null : 'CT',
    reason: endTick === null ? null : 'bomb_defused',
    endTick,
    timeLeftSec: 0.71875,
    bomb: { state: 'defused', carrier: null, pos: null, plantTick: 1760, defuser: 'sp4rtan', defuseEndTick: 4274 },
  });

  it('is due 2 s of round time after the round end (round_end in observe 4275, endTick 4274)', () => {
    expect(SUMMARY_DELAY_TICKS).toBe(128);
    expect(summaryDue(round('planted', null), 9999, 128)).toBe(false);
    expect(summaryDue(round('over', 4274), 4275 + 127, 128)).toBe(false);
    expect(summaryDue(round('over', 4274), 4275 + 128, 128)).toBe(true);
    // Before the post-round kill at 69.4 s (tick 4442), which still happens behind it.
    expect(4275 + 128).toBeLessThan(4442);
  });

  it('turns a summary into display strings', () => {
    const s: RoundSummary = {
      headline: 'You changed history: Ts win by elimination (recorded: CT defuse)',
      verdict: 'changed',
      result: { winner: 'T', reason: 'elimination', endTick: 2856, score: { ct: 11, t: 16 } },
      recorded: { winner: 'CT', reason: 'bomb_defused', endTick: 4275, score: { ct: 12, t: 15 } },
      bomb: { plantTick: 1761, defuseTick: null, explodeTick: 4321, marginSec: null },
      recordedBomb: { plantTick: 1761, defuseTick: 4275, explodeTick: null, marginSec: 0.71875 },
      kills: [
        { status: 'same', killer: 'snarlbot', victim: 'incredibad', weapon: 'ak47', headshot: false, recordedTick: 32, runTick: 32, deltaTicks: 0, postRound: false, text: 'same' },
        { status: 'shifted', killer: 'cart', victim: 'lokier', weapon: 'ak47', headshot: true, recordedTick: 1203, runTick: 1184, deltaTicks: -19, postRound: false, text: '-0.30 s' },
        { status: 'new', killer: 'cart', victim: 'sp4rtan', weapon: 'ak47', headshot: true, recordedTick: null, runTick: 2856, deltaTicks: null, postRound: false, text: 'new' },
        { status: 'missed', killer: 'sp4rtan', victim: 'donk', weapon: 'ak47', headshot: false, recordedTick: 3222, runTick: null, deltaTicks: null, postRound: false, text: "didn't happen: sp4rtan was dead (44.63 s)" },
        { status: 'new', killer: null, victim: 'donk', weapon: null, headshot: false, recordedTick: null, runTick: 4321, deltaTicks: null, postRound: false, text: 'new' },
      ],
      switches: [{ id: 'sp4rtan', tick: 2855, trigger: 'sighting', reason: 'sees cart (the human), not in the recording' }],
      player: { id: 'cart', human: true, kills: 2, damageDealt: 200, damageTaken: 41, aliveSec: 70.5625, deathTick: null, rmsFromRecording: 1145.27, rmsTicks: 4441 },
      ticks: 4517,
      lastTick: 4516,
    };
    const v = summaryView(s, (id) => model.player(id).team);
    expect(v.result).toBe('T elimination · 11–16 at 44.63 s');
    expect(v.recorded).toBe('CT defuse · 12–15 at 66.80 s');
    expect(v.bomb).toBe('planted 27.52 s · exploded 67.52 s');
    expect(v.recordedBomb).toBe('planted 27.52 s · defused 66.80 s, 0.72 s left');
    expect(v.kills.map((k) => [k.label, k.killer, k.victim, k.recorded, k.run, k.note])).toEqual([
      ['same', 'snarlbot', 'incredibad', '0.50', '0.50', ''],
      ['Δt', 'cart', 'lokier', '18.80', '18.50', '-0.30 s'],
      ['new', 'cart', 'sp4rtan', '–', '44.63', ''],
      ['✗', 'sp4rtan', 'donk', '50.34', '–', 'sp4rtan was dead (44.63 s)'],
      ['new', 'bomb', 'donk', '–', '67.52', 'the bomb'],
    ]);
    expect(v.kills.map((k) => [k.killerTeam, k.victimTeam])).toEqual([
      ['T', 'CT'],
      ['T', 'CT'],
      ['T', 'CT'],
      ['CT', 'T'],
      [null, 'T'],
    ]);
    expect(v.switches).toEqual([{ id: 'sp4rtan', time: '44.61 s', trigger: 'sighting', reason: 'sees cart (the human), not in the recording' }]);
    expect(v.player).toBe('cart (you)');
    expect(v.stats).toEqual([
      { label: 'Kills', value: '2' },
      { label: 'Damage', value: '200 dealt · 41 taken' },
      { label: 'Alive', value: '70.56 s' },
      { label: 'Off the recording', value: '29.09 m RMS' },
    ]);
  });
});
