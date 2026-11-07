/**
 * B5: the end-of-round summary (src/core/summary.ts), a pure function of the round data and a SessionLog. The golden
 * round (no human, the committed fixture) is "the tape": every kill the same, CT defuse with 0.72 s left. B4's
 * flank-sp4rtan scenario changes history: cart kills sp4rtan at 44.6 s, Ts win by elimination, and sp4rtan's recorded
 * kills don't happen.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionLog, type LogEntry, type ObsEvent } from '../src/contracts/index';
import { RoundModel, deltaText, fixed2, recordedBomb, recordedResult, resultLong, resultShort, secText, summarize } from '../src/core/index';
import { GOLDEN_DIR, gunzipText } from '../tools/golden-fixtures';
import { ROOT, loadHarnessData, runHarness } from '../tools/harness';
import { FOLLOW_SCRIPT, playScript } from '../tools/follow-script';
import { HumanBot, loadScenario } from '../tools/human-bot';

const data = loadHarnessData();
const model = new RoundModel(data.round);
const golden = SessionLog.fromText(gunzipText(readFileSync(resolve(ROOT, GOLDEN_DIR, 'round-nohuman.jsonl.gz'))));
const goldenEntries: LogEntry[] = [];
for (let i = 0; i < golden.length; i++) goldenEntries.push(golden.at(i) as LogEntry);

describe('summary helpers', () => {
  it('formats times from integer arithmetic', () => {
    expect([fixed2(0.71875), fixed2(0.005), fixed2(-0.296875), fixed2(44.625), fixed2(0), fixed2(-0.001), fixed2(12)]).toEqual(['0.72', '0.01', '-0.30', '44.63', '0.00', '0.00', '12.00']);
    expect([secText(2856), deltaText(-19), deltaText(11), deltaText(0)]).toEqual(['44.63', '-0.30 s', '+0.17 s', '+0.00 s']);
  });

  it('names results', () => {
    expect([resultShort('CT', 'bomb_defused'), resultShort('T', 'elimination'), resultShort('T', 'bomb_exploded'), resultShort('CT', 'time')]).toEqual(['CT defuse', 'T elimination', 'T bomb', 'CT on time']);
    expect([resultLong('T', 'elimination'), resultLong('CT', 'bomb_defused'), resultLong('T', 'bomb_exploded')]).toEqual(['Ts win by elimination', 'CTs win by defusing the bomb', 'Ts win: the bomb explodes']);
  });

  it('reads the recorded result from the round: CT bomb_defused at 66.8 s, 12 – 15, 0.72 s left', () => {
    expect(recordedResult(model)).toEqual({ winner: 'CT', reason: 'bomb_defused', endTick: 4275, score: { ct: 12, t: 15 } });
    expect(recordedBomb(model)).toEqual({ plantTick: 1761, defuseTick: 4275, explodeTick: null, marginSec: 0.71875 });
  });
});

describe('summary of the golden round (no human)', () => {
  const s = summarize(model, golden);

  it('played it like the tape', () => {
    expect(s.headline).toBe('Played it like the tape: CT defuse, 0.72 s left');
    expect(s.verdict).toBe('tape');
    expect(s.result).toEqual(s.recorded);
    expect(s.bomb).toEqual({ plantTick: 1761, defuseTick: 4275, explodeTick: null, marginSec: 0.71875 });
    expect(s.switches).toEqual([]);
    expect([s.ticks, s.lastTick]).toEqual([4517, 4516]);
  });

  it('has every recorded kill the same, on its recorded tick', () => {
    expect(s.kills).toHaveLength(9);
    for (const k of s.kills) {
      expect(k).toMatchObject({ status: 'same', deltaTicks: 0, text: 'same' });
      expect(k.runTick).toBe(k.recordedTick);
    }
    expect(s.kills.map((k) => `${k.killer} ${k.victim}`)).toEqual(model.kills.map((k) => `${k.killer} ${k.victim}`));
    expect(s.kills.at(-1)).toMatchObject({ killer: 'sp4rtan', victim: 'cart', postRound: true, runTick: 4442 });
  });

  it("reports cart's stats (watched, not played)", () => {
    expect(s.player).toMatchObject({ id: 'cart', human: false, kills: 1, damageDealt: 100, damageTaken: 100, deathTick: 4442 });
    expect(s.player.aliveSec).toBeCloseTo(4441 / 64, 9);
    // Per tick against the interpolated track (the golden table's 13.5 is per 10 Hz sample). G3: 27 on CS2 Mirage:
    // cart's puppet drifts up to the 96 u snap distance before each of his four snaps (tests/golden-round.test.ts).
    expect(s.player.rmsFromRecording).toBeGreaterThan(10);
    expect(s.player.rmsFromRecording).toBeLessThan(30);
  });

  it('is a pure function: the same lines give the same summary; a partial log is unfinished', () => {
    expect(summarize(model, goldenEntries)).toEqual(s);
    const partial = summarize(model, goldenEntries.slice(0, 3000));
    expect(partial.verdict).toBe('unfinished');
    expect(partial.headline).toBe('Round still on (recorded: CT defuse)');
    expect(partial.kills.filter((k) => k.status === 'pending').map((k) => k.text)).toEqual(['not yet (recorded 50.34 s)', 'not yet (recorded 58.84 s)', 'not yet (recorded 69.41 s)']);
    // The overlay's moment: 2 s after the round end, before the post-round kill (69.4 s) — still the tape.
    const due = summarize(model, goldenEntries.slice(0, 4275 + 128 + 1));
    expect(due.headline).toBe('Played it like the tape: CT defuse, 0.72 s left');
    expect(due.kills.at(-1)).toMatchObject({ status: 'pending', victim: 'cart', postRound: true });
    // Cut after it, with cart never killed: it didn't happen.
    const noKill = goldenEntries.map((e) => (e.observe.tick === 4442 ? { ...e, observe: { ...e.observe, events: e.observe.events.filter((ev) => ev.type !== 'death') } } : e));
    const nk = summarize(model, noKill);
    expect(nk.kills.at(-1)).toMatchObject({ status: 'missed', text: "didn't happen: cart survived" });
    expect(nk.verdict).toBe('same_result');
  });

  it('a kill moved by 11 ticks is shifted: same result, different round', () => {
    const moved = goldenEntries.map((e) => {
      const strip = (ev: ObsEvent): boolean => !(ev.type === 'death' && ev.victim === 'zwomp');
      if (e.observe.tick === 2829) return { ...e, observe: { ...e.observe, events: e.observe.events.filter(strip) } };
      if (e.observe.tick === 2840) return { ...e, observe: { ...e.observe, events: [...e.observe.events, { type: 'death' as const, victim: 'zwomp' as const, attacker: 'barely' as const, weapon: 'ak47' as const, headshot: false }] } };
      return e;
    });
    const m = summarize(model, moved);
    expect(m.verdict).toBe('same_result');
    expect(m.headline).toBe('Same result, different round: CT defuse, 0.72 s left; 1 kill changed');
    expect(m.kills.find((k) => k.victim === 'zwomp')).toMatchObject({ status: 'shifted', deltaTicks: 11, text: '+0.17 s' });
  });
});

describe('summary of the follow run (cart plays his recording, F)', () => {
  const run = playScript(data, readFileSync(resolve(ROOT, FOLLOW_SCRIPT), 'utf8'));
  const s = summarize(model, run.log);

  it('played it like the tape (G5): every kill the same, on its recorded tick, nobody LIVE', () => {
    // Before G5: "Same result, different round: …; 2 kills changed" (cart's real AK headshot killed Lokier 0.30 s early,
    // before Lokier's hit, so cart survived the post-round shot). Now his recorded duels resolve like the tape.
    expect(s.headline).toBe('Played it like the tape: CT defuse, 0.72 s left');
    expect(s.verdict).toBe('tape');
    expect(s.result).toEqual({ winner: 'CT', reason: 'bomb_defused', endTick: 4275, score: { ct: 12, t: 15 } });
    expect(s.switches).toEqual([]);
    for (const k of s.kills) expect(k).toMatchObject({ status: 'same', deltaTicks: 0, text: 'same' });
    expect(s.player).toMatchObject({ id: 'cart', human: true, kills: 1, damageDealt: 100, damageTaken: 100, deathTick: 4442 });
  });
});

describe('summary of flank-sp4rtan (B4 scenario 5)', () => {
  const sc = loadScenario(`${ROOT}/fixtures/scenarios/flank-sp4rtan.json`);
  const run = runHarness(data, { human: sc.human, driver: HumanBot.fromScenario(data, sc), lastTick: 'end', seed: sc.seed });
  const s = summarize(model, run.log);

  it('changed history: Ts win by elimination at 44.63 s, 11 – 16', () => {
    expect(s.headline).toBe('You changed history: Ts win by elimination (recorded: CT defuse)');
    expect(s.verdict).toBe('changed');
    expect(s.result).toEqual({ winner: 'T', reason: 'elimination', endTick: 2856, score: { ct: 11, t: 16 } });
    // Nobody defused: the bomb exploded at 67.52 s. The two LIVE guards had left its blast (F); it killed cart (G5, below).
    expect(s.bomb).toEqual({ plantTick: 1761, defuseTick: null, explodeTick: 4321, marginSec: null });
  });

  it("compares the kills: a new kill cart → sp4rtan at 44.6 s, sp4rtan's recorded kills didn't happen", () => {
    const row = (killer: string | null, victim: string) => s.kills.find((k) => k.killer === killer && k.victim === victim);
    expect(row('cart', 'sp4rtan')).toMatchObject({ status: 'new', runTick: 2856, recordedTick: null, headshot: true });
    expect(secText(row('cart', 'sp4rtan')?.runTick ?? 0)).toBe('44.63');
    for (const victim of ['donk', 'barely']) {
      expect(row('sp4rtan', victim)).toMatchObject({ status: 'missed', runTick: null, text: "didn't happen: sp4rtan was dead (44.63 s)" });
    }
    // G5: cart plays his recording up to 44.6 s, so Lokier's hit lands (27 HP) and the duel lands the kill on its tick
    // (before: shifted −0.30 s, cart on 100 HP). On 27 HP the explosion's 43 HP through armor in Back Alley kills him.
    expect(row('cart', 'lokier')).toMatchObject({ status: 'same', deltaTicks: 0, text: 'same' });
    expect(row(null, 'cart')).toMatchObject({ status: 'new', runTick: 4321 });
    expect(row('sp4rtan', 'cart')).toMatchObject({ status: 'missed', runTick: null, text: "didn't happen: cart died to the bomb at 67.52 s" });
    // F: the LIVE guards leave the bomb's blast after the round, so the explosion kills neither (it killed both before).
    for (const victim of ['donk', 'barely']) expect(row(null, victim)).toBeUndefined();
    for (const [killer, victim] of [['snarlbot', 'incredibad'], ['snarlbot', 'snakelore'], ['lokier', 'eradicate'], ['sp4rtan', 'snarlbot'], ['barely', 'zwomp']] as const) {
      expect(row(killer, victim)?.status).toBe('same');
    }
    expect(s.kills.map((k) => k.recordedTick ?? k.runTick)).toEqual([...s.kills.map((k) => k.recordedTick ?? k.runTick)].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  it('lists the LIVE switches with trigger, time and reason', () => {
    expect(s.switches).toEqual([
      { id: 'sp4rtan', tick: 2855, trigger: 'sighting', reason: 'sees cart (the human), not in the recording' },
      { id: 'donk', tick: 3414, trigger: 'outlived', reason: 'outlived recording (+3.0 s)' },
      { id: 'barely', tick: 3958, trigger: 'outlived', reason: 'outlived recording (+3.0 s)' },
    ]);
  });

  it("reports cart's stats (the human)", () => {
    // G5: killed by the bomb at 67.52 s (27 HP after Lokier's recorded hit; before G5 he survived it on 100).
    expect(s.player).toMatchObject({ id: 'cart', human: true, kills: 2, deathTick: 4321 });
    expect(s.player.damageDealt).toBe(200);
    expect(s.player.aliveSec).toBeCloseTo(4320 / 64, 9);
    console.log(`[summary flank-sp4rtan] ${s.headline}; cart ${s.player.kills} kills, ${s.player.damageDealt} dealt, ${s.player.damageTaken} taken, RMS ${s.player.rmsFromRecording?.toFixed(1)} u from his recording (teleported to Back Alley at 44.6 s)`);
  });
});
