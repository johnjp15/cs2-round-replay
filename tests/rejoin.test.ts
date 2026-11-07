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
 * this runs there (no path query, digest NOHUMAN since G6's sight and aim on the CS2 mesh; 63bd3d86 after M1's movement fixes, 72b58704 at G3, e9a228d9 before G3's 3D movement).
 */
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, SessionLog, canonicalize, parseTuning, replay, stableStringify, type LogEntry, type Observe, type PlayerId } from '../src/contracts/index';
import { ReplayCore, lagTicks, runSpeedOf, tickOf, trackLength, unrestReason, type RejoinState } from '../src/core/index';
import { walkQueryOf } from '../src/app/index';
import { NO_HUMAN, ROOT, coreLogs, deaths, loadHarnessData, logDigest, runHarness, type HarnessRun } from '../tools/harness';
import { HumanBot, formatTimeline, liveSwitches, loadScenario, rejoins, timeline } from '../tools/human-bot';
import { readFileSync } from 'node:fs';

const data = loadHarnessData();
const tuning = data.tuning;
const r = tuning.replay;
const sec = (s: number): number => Math.floor(s * 64 + 0.5);

function play(name: string, rejoin = true): HarnessRun {
  const s = loadScenario(`${ROOT}/fixtures/scenarios/${name}.json`);
  const core = rejoin ? undefined : (p: Parameters<NonNullable<Parameters<typeof runHarness>[1]['core']>>[0]) => new ReplayCore(p.model, p.schedule, p.tuning, p.seed, walkQueryOf(p), { divergence: true, rejoin: false });
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
    // G3: 0.83 s on the bomb, not the tape's 0.72: the plant is 7 ticks late (below), the defuse on the tape's tick.
    expect((run.entries[run.entries.length - 1] as LogEntry).observe.round.timeLeftSec).toBeCloseTo(0.828125, 6);
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
    // Measured: all of them on the golden master's (= the recording's) observe ticks but the plant. G3: on CS2 Mirage
    // barely, LIVE after Lokier, leaves the Balcony by its west end (the 2020 drop under the Apartments window is a
    // wall in CS2) and goes round the B-site box the recording walks through: G1's plant shift starts his USE 7 ticks
    // after the recorded 1555, so the bomb is planted at 1768 (27.63 s, recorded 27.52 s).
    expect([bombTick(run, 'planted'), kill(run, 'barely', 'zwomp'), kill(run, 'sp4rtan', 'donk'), kill(run, 'sp4rtan', 'barely'), bombTick(run, 'defuse_start'), bombTick(run, 'defused')]).toEqual([
      1768, 2829, 3222, 3766, 3955, 4275,
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
    // G6: 2564 again (G3: 2566): the same positions and yaw, but on the CS2 mesh the line to cart is clear from 2563 and
    // cart is in his FOV from 2564; G3's radar mask and level check opened it two ticks later.
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
    const fresh = (): ReplayCore => new ReplayCore(run.model, run.session.schedule, tuning, 1, walkQueryOf(data));
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

  it('with rejoin off ({rejoin: false}) the run is B4 byte for byte (main: b424522f; G3, 3D on CS2 Mirage: 7ca637e5; M1: 4dc88459; G6: REJOINOFF)', () => {
    expect(logDigest(before.log)).toBe('REJOINOFF');
    expect(rejoins(before.entries)).toEqual([]);
  });
});

describe('nobody leaves the tape: rejoin never runs', () => {
  it('golden no-human round: no rejoin line, no path query, digest NOHUMAN (G6; M1: 63bd3d86; G3: 72b58704; main: e9a228d9)', () => {
    const g = runHarness(data, { ...NO_HUMAN, recordWalk: true });
    expect(logDigest(g.log)).toBe('NOHUMAN');
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

describe('the planter heading back into his plant window (Rejoin.step on golden observes, barely moved off his track)', () => {
  const golden = runHarness(data, NO_HUMAN);
  const plantPlan = (core: ReplayCore) => core.script.plan.plant as NonNullable<ReplayCore['script']['plan']['plant']>;
  /** The golden observe of `tick` with barely at `pos` holding `weapon`; the modes with barely LIVE. */
  const frame = (tick: number, pos: { x: number; y: number }, weapon: 'ak47' | 'c4') => {
    const e = golden.entries[tick] as LogEntry;
    const o: Observe = {
      ...e.observe,
      pawns: e.observe.pawns.map((p) => (p.id === 'barely' ? { ...p, pos: { x: pos.x, y: pos.y, z: data.nav.zAt(pos) }, vel: { x: 0, y: 0, z: 0 }, weapon, sees: [] } : p)),
    };
    const modes = e.act.status.map((s) => ({ id: s.id, mode: s.id === 'barely' ? ('LIVE' as const) : s.mode, blocksLifted: s.id === 'barely' }));
    return { o, modes };
  };
  const tracks = (core: ReplayCore) => PLAYER_IDS.map((id) => core.puppet(id)?.track ?? (() => { throw new Error(id); })());

  function approach(): { core: ReplayCore; logs: { tick: number; actions: unknown[] }[]; spot: { x: number; y: number } } {
    const core = new ReplayCore(run0.model, run0.session.schedule, tuning, 1, walkQueryOf(data));
    const rj = core.rejoin as NonNullable<ReplayCore['rejoin']>;
    rj.noteLive('barely', 1400, 'sighting');
    const spot = { x: -1700, y: 300 }; // east of B site, off his track
    const logs: { tick: number; actions: unknown[] }[] = [];
    const draw = plantPlan(core).selectTick;
    for (let k = 1401; k <= 1500; k++) {
      // As the engine shows it: the c4 in hand one tick (actionLatencyTicks) after the Core's set_weapon.
      const { o, modes } = frame(k, spot, k > draw + r.actionLatencyTicks - 1 ? 'c4' : 'ak47');
      const out: Parameters<typeof rj.step>[4] = [];
      expect(rj.step(o, modes, tracks(core), core.loadouts(), out)).toEqual([]);
      if (out.length > 0) logs.push({ tick: k, actions: out });
    }
    return { core, logs, spot };
  }
  const run0 = golden;

  it('plans an approach into the window once calm, and draws the c4 on the recorded draw tick', () => {
    const { core, logs } = approach();
    const pl = plantPlan(core);
    const plan = logs[0] as { tick: number; actions: { type: string; goal?: { role: string; hold: unknown }; text?: string }[] };
    expect(plan.tick).toBe(1400 + sec(r.rejoinCalmSec) + 1); // calm from 1401, min LIVE from 1400
    expect(plan.actions[0]).toMatchObject({ type: 'set_mode', id: 'barely', mode: 'LIVE', goal: { route: [], role: 'rejoin' } });
    const target = Number(/at tick (\d+)/.exec(plan.actions[1]?.text ?? '')?.[1]);
    expect(target).toBeGreaterThan(pl.selectTick);
    expect(target).toBeLessThanOrEqual(pl.useTo);
    expect(logs.find((l) => l.actions.some((a) => (a as { type: string; weapon?: string }).weapon === 'c4'))?.tick).toBe(pl.selectTick);
  });

  it('back with the c4 drawn on the way: the plant is on the tape (no shift)', () => {
    const { core } = approach();
    const rj = core.rejoin as NonNullable<ReplayCore['rejoin']>;
    const t = tracks(core)[PLAYER_IDS.indexOf('barely')] as ReturnType<typeof tracks>[number];
    for (let k = 1501; k <= 1530; k++) {
      const at = k === 1530 ? t.targetAt(k) : { x: -1700, y: 300 };
      const { o, modes } = frame(k, at, 'c4');
      const out: Parameters<typeof rj.step>[4] = [];
      const hits = rj.step(o, modes, tracks(core), core.loadouts(), out);
      if (k < 1530) expect(hits).toEqual([]);
      else {
        expect(hits.map((h) => h.id)).toEqual(['barely']);
        expect(out).toContainEqual({ type: 'set_mode', id: 'barely', mode: 'REPLAY', goal: null });
        expect(out.some((a) => a.type === 'set_weapon')).toBe(false); // the c4 is out already
      }
    }
    expect(core.script.state.plantShift).toBe(0);
  });

  it('back without the c4: drawn at the switch, and the plant runs late by the rest of its deploy (logged)', () => {
    const { core } = approach();
    const rj = core.rejoin as NonNullable<ReplayCore['rejoin']>;
    const t = tracks(core)[PLAYER_IDS.indexOf('barely')] as ReturnType<typeof tracks>[number];
    const k = 1530;
    const { o, modes } = frame(k, t.targetAt(k), 'ak47');
    const st = rj.state.find((x) => x.id === 'barely') as RejoinState;
    st.drawTick = null; // as if a fight had made him put it away and he never drew it again
    const out: Parameters<typeof rj.step>[4] = [];
    expect(rj.step(o, modes, tracks(core), core.loadouts(), out).map((h) => h.id)).toEqual(['barely']);
    expect(out).toContainEqual({ type: 'set_weapon', id: 'barely', weapon: 'c4' });
    const pl = plantPlan(core);
    const shift = k + Math.ceil(tuning.damage.defaultDeploySec * 64) - pl.useFrom;
    expect(core.script.state.plantShift).toBe(shift);
    expect(core.script.plantItem()).toMatchObject({ useFrom: pl.useFrom + shift, useTo: pl.useTo + shift, fallbackTick: pl.fallbackTick + shift });
    expect(out.some((a) => a.type === 'log' && a.text.startsWith(`script: plant by barely runs 0.6 s late (rejoined at tick ${k})`))).toBe(true);
  });

  it('a planter whose window has passed with the bomb unplanted does not rejoin: his AI keeps the plant', () => {
    const core = new ReplayCore(run0.model, run0.session.schedule, tuning, 1, walkQueryOf(data));
    const rj = core.rejoin as NonNullable<ReplayCore['rejoin']>;
    const e = golden.entries[1700] as LogEntry;
    const o: Observe = { ...e.observe, round: { ...e.observe.round, bomb: { ...e.observe.round.bomb, state: 'carried', carrier: 'barely', plantTick: null, pos: null } } };
    expect(rj.fitsAt(o, 'barely', 1761, tracks(core)[0] as ReturnType<typeof tracks>[number])).toBe(true);
    expect(rj.fitsAt(o, 'barely', 1762, tracks(core)[0] as ReturnType<typeof tracks>[number])).toBe(false);
    expect(rj.objective(o, 'barely')).toBe(true);
  });
});
