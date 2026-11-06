/**
 * G1 rejoin (LIVE → REPLAY, src/core/rejoin.ts, docs/core.md "Rejoin").
 *
 * John's case first: cart (the human) stands in Back Alley all round (fixtures/scenarios/never-peeks.json). Lokier
 * outlives his recording, barely meets him on B and kills him, sp4rtan meets cart on his flank and kills him; each of
 * them goes back to his recording afterwards, so every event that doesn't involve cart lands on the tape and the
 * round ends as recorded: CT defuse with 0.72 s on the bomb. Before G1 a LIVE pawn never came back and the Ts won.
 *
 * Then the rules: the blocks B3 set are back exactly when nobody involved is LIVE; nothing teleports and nothing runs
 * faster than its weapon allows around a rejoin; the minimum LIVE time and the calm window hold; a pawn without tape
 * (outlived) stays LIVE; a rejoined pawn's scripted events after the rejoin run; cycles; snapshots mid-approach;
 * determinism; the switch off reproduces B4 byte for byte; nobody leaves the tape in the golden round, so nothing of
 * this runs there (no path query, digest e9a228d9).
 */
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, SessionLog, canonicalize, parseTuning, replay, stableStringify, type LogEntry, type Observe, type PlayerId } from '../src/contracts/index';
import { ReplayCore, lagTicks, runSpeedOf, tickOf, trackLength, unrestReason, type RejoinState } from '../src/core/index';
import { NavWalkQuery } from '../src/sim2d/index';
import { NO_HUMAN, ROOT, coreLogs, deaths, loadHarnessData, logDigest, runHarness, type HarnessRun } from '../tools/harness';
import { HumanBot, formatTimeline, liveSwitches, loadScenario, rejoins, timeline } from '../tools/human-bot';
import { readFileSync } from 'node:fs';

const data = loadHarnessData();
const tuning = data.tuning;
const r = tuning.replay;
const sec = (s: number): number => Math.floor(s * 64 + 0.5);

function play(name: string, rejoin = true): HarnessRun {
  const s = loadScenario(`${ROOT}/fixtures/scenarios/${name}.json`);
  const core = rejoin ? undefined : (p: Parameters<NonNullable<Parameters<typeof runHarness>[1]['core']>>[0]) => new ReplayCore(p.model, p.schedule, p.tuning, p.seed, new NavWalkQuery(p.nav), { divergence: true, rejoin: false });
  return runHarness(data, { human: s.human, driver: HumanBot.fromScenario(data, s), lastTick: s.until === 'end' ? 'end' : tickOf(s.until), seed: s.seed, ...(core === undefined ? {} : { core }) });
}

const kill = (run: HarnessRun, killer: PlayerId, victim: PlayerId): number | null => deaths(run.entries).find((d) => d.attacker === killer && d.victim === victim)?.tick ?? null;
const bombTick = (run: HarnessRun, phase: string): number | null => {
  for (const e of run.entries) for (const ev of e.observe.events) if (ev.type === 'bomb' && ev.phase === phase) return e.observe.tick;
  return null;
};
const roundEnd = (run: HarnessRun): { tick: number; winner: string; reason: string } | null => {
  for (const e of run.entries) for (const ev of e.observe.events) if (ev.type === 'round_end') return { tick: e.observe.tick, winner: ev.winner, reason: ev.reason };
  return null;
};
const statusAt = (e: LogEntry, id: PlayerId) => e.act.status.find((s) => s.id === id);
const pawnAt = (e: LogEntry, id: PlayerId): Observe['pawns'][number] => e.observe.pawns.find((p) => p.id === id) as Observe['pawns'][number];

/**
 * The damage-block invariant over a whole run: after every tick's actions, an ordered enemy pair (or a self pair) is
 * blocked exactly when neither pawn is the human and neither has its blocks lifted (LIVE now, or LIVE when it died).
 * Pairs with the human are left out (a scheduled encounter blocks its scripted shot on him for a moment).
 */
function blockProblems(run: HarnessRun): string[] {
  const human = run.options.human;
  const blocked = new Set<string>();
  const lifted = new Map<PlayerId, boolean>();
  const out: string[] = [];
  for (const e of run.entries) {
    for (const a of e.act.actions) {
      if (a.type === 'block_damage') blocked.add(`${a.attacker}>${a.victim}`);
      if (a.type === 'unblock_damage') blocked.delete(`${a.attacker}>${a.victim}`);
    }
    for (const s of e.act.status) if (s.mode !== 'DEAD') lifted.set(s.id, s.mode === 'LIVE');
    for (const a of PLAYER_IDS) {
      for (const b of PLAYER_IDS) {
        if (a === human || b === human) continue;
        if (a !== b && run.model.player(a).team === run.model.player(b).team) continue;
        const want = !(lifted.get(a) ?? false) && !(lifted.get(b) ?? false);
        if (want !== blocked.has(`${a}>${b}`) && out.length < 5) out.push(`tick ${e.observe.tick}: ${a} -> ${b} ${want ? 'should be' : 'should not be'} blocked`);
      }
    }
  }
  return out;
}

/**
 * Every tick from a pawn's LIVE switch to 2 s after its rejoin: no teleport of it, and never faster than its weapon
 * runs, give or take the engine's own acceleration transients (turning at full stick, or after a switch to a slower
 * weapon: up to 4.7 % over in the golden master's puppets), so 5 %.
 */
function motionProblems(run: HarnessRun): string[] {
  const out: string[] = [];
  const lives = liveSwitches(run.entries);
  for (const back of rejoins(run.entries)) {
    const from = Math.max(...lives.filter((l) => l.id === back.id && l.tick < back.tick).map((l) => l.tick));
    for (let k = from; k <= back.tick + 128 && k < run.entries.length; k++) {
      const e = run.entries[k] as LogEntry;
      if (e.act.actions.some((a) => a.type === 'teleport' && a.id === back.id)) out.push(`${back.id} teleported at tick ${k}`);
      const p = pawnAt(e, back.id);
      const prev = pawnAt(run.entries[k - 1] as LogEntry, back.id);
      const cap = Math.max(runSpeedOf(p.weapon, tuning.movement), runSpeedOf(prev.weapon, tuning.movement));
      const v = Math.hypot(p.vel.x, p.vel.y);
      if (p.alive && v > cap * 1.05) out.push(`${back.id} at ${v.toFixed(1)} u/s (cap ${cap}) at tick ${k}`);
    }
  }
  return out.slice(0, 5);
}

describe("John's case: cart never peeks (never-peeks), the rest of the round plays out as recorded", () => {
  const run = play('never-peeks');
  const before = play('never-peeks', false);
  console.log(`[rejoin never-peeks]\n${formatTimeline(timeline(run.entries).filter((t) => t.kind !== 'dropped'))}\n`);

  it('ends CT bomb_defused with 0.72 s on the bomb, like the tape (B4 alone: Ts won by elimination)', () => {
    expect(roundEnd(run)).toEqual({ tick: 4275, winner: 'CT', reason: 'bomb_defused' });
    expect((run.entries[run.entries.length - 1] as LogEntry).observe.round.timeLeftSec).toBeCloseTo(0.71875, 6);
    expect(roundEnd(before)).toMatchObject({ winner: 'T', reason: 'elimination' });
  });

  it('the events that do not involve cart land on (or near) the recorded ticks', () => {
    const near = (got: number | null, recordedSec: number, tolSec: number): void => {
      expect(got, `${recordedSec} s`).not.toBeNull();
      expect(Math.abs((got as number) / 64 - recordedSec), `${recordedSec} s`).toBeLessThanOrEqual(tolSec);
    };
    near(bombTick(run, 'planted'), 27.52, 1.0);
    near(kill(run, 'barely', 'zwomp'), 44.2, 0.5);
    near(kill(run, 'sp4rtan', 'donk'), 50.35, 0.3);
    near(kill(run, 'sp4rtan', 'barely'), 58.85, 0.3);
    near(bombTick(run, 'defused'), 66.8, 0.5);
    // Measured: all of them on the golden master's (= the recording's) observe ticks.
    expect([bombTick(run, 'planted'), kill(run, 'barely', 'zwomp'), kill(run, 'sp4rtan', 'donk'), kill(run, 'sp4rtan', 'barely'), bombTick(run, 'defuse_start'), bombTick(run, 'defused')]).toEqual([
      1761, 2829, 3222, 3766, 3955, 4275,
    ]);
    // ... and they are the scripted ones (B3), not LIVE fights.
    for (const [a, v, k] of [['barely', 'zwomp', 2829], ['sp4rtan', 'donk', 3222], ['sp4rtan', 'barely', 3766]] as const) {
      const d = (run.entries[k] as LogEntry).observe.events.find((ev) => ev.type === 'damage' && ev.attacker === a && ev.victim === v);
      expect(d?.type === 'damage' ? d.scripted : null, `${a} -> ${v}`).toBe(true);
    }
  });

  it('Lokier lives past 18.8 s (cart never shot him), goes LIVE and stays LIVE (no tape left); barely, who kills him, rejoins', () => {
    const lk = liveSwitches(run.entries).filter((s) => s.id === 'lokier');
    expect(lk).toEqual([{ id: 'lokier', tick: 1203 + sec(r.outliveGraceSec), trigger: 'outlived' }]);
    expect(rejoins(run.entries).some((b) => b.id === 'lokier')).toBe(false);
    const lokierDeath = deaths(run.entries).find((d) => d.victim === 'lokier');
    expect(lokierDeath?.attacker).toBe('barely');
    expect((lokierDeath?.tick ?? 0) / 64).toBeGreaterThan(18.8);
    const back = rejoins(run.entries).filter((b) => b.id === 'barely');
    expect(back.length).toBeGreaterThanOrEqual(1);
    expect((back[0] as { tick: number }).tick).toBeGreaterThan(lokierDeath?.tick ?? Infinity);
    expect((back[0] as { tick: number }).tick).toBeLessThan(1555); // before his scripted plant's USE window
  });

  it('sp4rtan, who kills cart on his flank, rejoins and does the recorded donk spray, barely headshot and kit defuse', () => {
    const sw = liveSwitches(run.entries).filter((s) => s.id === 'sp4rtan');
    expect(sw).toEqual([{ id: 'sp4rtan', tick: 2564, trigger: 'sighting' }]);
    expect(kill(run, 'sp4rtan', 'cart')).not.toBeNull();
    const back = rejoins(run.entries).filter((b) => b.id === 'sp4rtan');
    expect(back).toHaveLength(1);
    const k = (back[0] as { tick: number }).tick;
    expect(k).toBeGreaterThan(kill(run, 'sp4rtan', 'cart') as number);
    // Nothing of his is dropped as LIVE after it; before G1 his spray, his kills and the defuse were.
    const dropped = coreLogs(run.entries).filter((l) => l.tick > k && / sp4rtan is LIVE$/.test(l.text));
    expect(dropped).toEqual([]);
    expect(coreLogs(before.entries).filter((l) => / sp4rtan is LIVE$/.test(l.text)).length).toBeGreaterThan(5);
  });

  it('cycles: barely goes LIVE again when he hears sp4rtan fight cart, and rejoins again', () => {
    const lives = liveSwitches(run.entries).filter((s) => s.id === 'barely');
    const backs = rejoins(run.entries).filter((b) => b.id === 'barely');
    expect(lives.map((s) => s.trigger)).toEqual(['sighting', 'gunfire']);
    expect(backs).toHaveLength(2);
    expect((lives[0] as { tick: number }).tick).toBeLessThan((backs[0] as { tick: number }).tick);
    expect((backs[0] as { tick: number }).tick).toBeLessThan((lives[1] as { tick: number }).tick);
    expect((lives[1] as { tick: number }).tick).toBeLessThan((backs[1] as { tick: number }).tick);
  });

  it('the switch: blocks back exactly when nobody involved is LIVE, set_mode REPLAY, a log line, status REPLAY / rejoin', () => {
    expect(blockProblems(run)).toEqual([]);
    for (const b of rejoins(run.entries)) {
      const e = run.entries[b.tick] as LogEntry;
      const self = e.act.actions.findIndex((a) => a.type === 'block_damage' && a.attacker === b.id && a.victim === b.id);
      const mode = e.act.actions.findIndex((a) => a.type === 'set_mode' && a.id === b.id && a.mode === 'REPLAY' && a.goal === null);
      expect(self).toBeGreaterThanOrEqual(0);
      expect(mode).toBeGreaterThan(self);
      expect(e.act.actions.some((a) => a.type === 'log' && a.text.startsWith(`${b.id} REPLAY: rejoined at tick ${b.tick}, `))).toBe(true);
      expect(statusAt(e, b.id)).toEqual({ id: b.id, mode: 'REPLAY', trigger: 'rejoin', sinceTick: b.tick });
      // It gets the puppet's input again from that tick on.
      expect(e.act.inputs.some((q) => q.id === b.id)).toBe(true);
    }
  });

  it('physically plausible: no teleport around a rejoin, never faster than the weapon runs', () => {
    expect(motionProblems(run)).toEqual([]);
  });

  it('hysteresis: every rejoin comes at least rejoinMinLiveSec after its LIVE switch and rejoinCalmSec after the last unrest', () => {
    const lives = liveSwitches(run.entries);
    for (const b of rejoins(run.entries)) {
      const from = Math.max(...lives.filter((l) => l.id === b.id && l.tick < b.tick).map((l) => l.tick));
      expect(b.tick - from, b.id).toBeGreaterThanOrEqual(sec(r.rejoinMinLiveSec));
      // Recompute unrest from the logged observes with the run's Core (its index and encounters): none in the calm window.
      for (let k = b.tick - sec(r.rejoinCalmSec); k <= b.tick; k++) {
        const e = run.entries[k] as LogEntry;
        const modes = e.act.status.map((s) => ({ id: s.id, mode: s.mode }));
        expect(unrestReason(e.observe, modes, b.id, run.model, run.core.divergence, tuning), `${b.id} at ${k}`).toBeNull();
      }
    }
  });

  it('the human never goes LIVE or REPLAY', () => {
    for (const e of run.entries.slice(1)) expect(['HUMAN', 'DEAD']).toContain(statusAt(e, 'cart')?.mode);
    expect(run.entries.some((e) => e.act.actions.some((a) => a.type === 'set_mode' && a.id === 'cart'))).toBe(false);
  });

  it('replays identically through a fresh Core; a Core snapshot in the middle of an approach continues exactly', () => {
    const fresh = (): ReplayCore => new ReplayCore(run.model, run.session.schedule, tuning, 1, new NavWalkQuery(data.nav));
    const log = SessionLog.fromText(run.log.toText());
    expect(replay(log, fresh())).toMatchObject({ identical: true, mismatchCount: 0 });
    // barely's second approach: planned on 2662, back on 2709.
    const plan = coreLogs(run.entries).find((l) => l.text.startsWith('barely rejoin: heading for its track'));
    const mid = (plan?.tick ?? 0) + 20;
    const a = fresh();
    for (let i = 0; i <= mid; i++) {
      const e = log.at(i) as LogEntry;
      for (const c of e.controls) a.control(c);
      a.step(e.observe);
    }
    const st = (a.snapshot().data as unknown as { rejoin: RejoinState[] }).rejoin;
    expect(st.find((x) => x.id === 'barely')?.target).not.toBeNull();
    const b = fresh();
    b.restore(a.snapshot());
    for (let i = mid + 1; i < mid + 400; i++) {
      const e = log.at(i) as LogEntry;
      expect(stableStringify(canonicalize(b.step(e.observe)))).toBe(stableStringify(e.act));
    }
  });

  it('with rejoin off ({rejoin: false}) the run is B4 byte for byte (main: b424522f)', () => {
    expect(logDigest(before.log)).toBe('b424522f');
    expect(rejoins(before.entries)).toEqual([]);
  });
});

describe('nobody leaves the tape: rejoin never runs', () => {
  it('golden no-human round: no rejoin line, no path query, digest e9a228d9', () => {
    const g = runHarness(data, { ...NO_HUMAN, recordWalk: true });
    expect(logDigest(g.log)).toBe('e9a228d9');
    expect(g.paths).toEqual([]);
    expect(coreLogs(g.entries).some((l) => / (rejoin|REPLAY): /.test(l.text))).toBe(false);
  });
});

describe('the rules, one by one', () => {
  const run = play('never-peeks');
  const track = (id: PlayerId) => run.core.puppet(id)?.track ?? (() => { throw new Error(id); })();

  it('lagTicks: on its track now = 0; where the tape was 1 s ago = 64; nowhere near = null', () => {
    const t = track('sp4rtan');
    expect(lagTicks(t, t.targetAt(3000), 3000, r.offCourseUnits, sec(r.steerFallbackSec))).toBe(0);
    expect(lagTicks(t, t.targetAt(3000 - 64), 3000, 1, sec(r.steerFallbackSec))).toBe(64);
    expect(lagTicks(t, { x: 5000, y: 5000, z: 0 }, 3000, r.offCourseUnits, sec(r.steerFallbackSec))).toBeNull();
  });

  it('trackLength: additive, and at least the straight line', () => {
    const t = track('sp4rtan');
    const ab = trackLength(t, 2600, 2700);
    expect(ab + trackLength(t, 2700, 2900)).toBeCloseTo(trackLength(t, 2600, 2900), 6);
    const a = t.targetAt(2600);
    const b = t.targetAt(2900);
    expect(trackLength(t, 2600, 2900)).toBeGreaterThanOrEqual(Math.hypot(b.x - a.x, b.y - a.y) - 1e-9);
  });

  it('fitsAt: no tape after an outlived death; the planter only up to the recorded plant; the defuser only before his USE', () => {
    const rj = run.core.rejoin;
    expect(rj).not.toBeNull();
    if (rj === null) return;
    const e = run.entries[1400] as LogEntry; // bomb carried by barely, not planted
    expect(rj.fitsAt(e.observe, 'lokier', 1400, track('lokier'))).toBe(false); // recorded death 1203
    expect(rj.fitsAt(e.observe, 'barely', 1555, track('barely'))).toBe(true);
    expect(rj.fitsAt(e.observe, 'barely', 1761, track('barely'))).toBe(true);
    expect(rj.fitsAt(e.observe, 'barely', 1762, track('barely'))).toBe(false);
    expect(rj.fitsAt(e.observe, 'barely', 3766 - sec(r.rejoinMinTapeSec), track('barely'))).toBe(false);
    const planted = run.entries[3000] as LogEntry;
    expect(rj.fitsAt(planted.observe, 'sp4rtan', 3954, track('sp4rtan'))).toBe(true);
    expect(rj.fitsAt(planted.observe, 'sp4rtan', 3955, track('sp4rtan'))).toBe(false);
  });

  it('tuning: the rejoin keys are required and range-checked', () => {
    const j = JSON.parse(readFileSync(`${ROOT}/data/tuning.json`, 'utf8')) as { replay: Record<string, unknown> };
    const bad = (k: string, v: unknown): (() => unknown) => () => parseTuning({ ...j, replay: { ...j.replay, [k]: v } });
    expect(bad('rejoinCalmSec', -1)).toThrow(/replay\.rejoinCalmSec/);
    expect(bad('rejoinSpeedFactor', 1.2)).toThrow(/replay\.rejoinSpeedFactor/);
    expect(bad('rejoinHorizonSec', 0)).toThrow(/replay\.rejoinHorizonSec/);
    const missing = { ...j.replay };
    delete missing['rejoinRetrySec'];
    expect(() => parseTuning({ ...j, replay: missing })).toThrow(/replay\.rejoinRetrySec/);
  });
});

describe('the other scenarios with a rejoin: blocks and motion rules hold', () => {
  for (const name of ['cart-goes-a', 'miss-lokier-shop', 'block-sp4rtan', 'cart-dies']) {
    it(name, () => {
      const run = play(name);
      expect(rejoins(run.entries).length, 'at least one rejoin').toBeGreaterThan(0);
      expect(blockProblems(run)).toEqual([]);
      expect(motionProblems(run)).toEqual([]);
      expect(run.entries.some((e) => e.act.actions.some((a) => a.type === 'plant' || a.type === 'defuse_start')), 'no plant / defuse fallback').toBe(false);
    });
  }
});
