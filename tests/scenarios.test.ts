/**
 * B4 acceptance: divergence scenarios (fixtures/scenarios/*.json, played by the human-bot, tools/human-bot.ts) through
 * the headless harness, i.e. the app's Session with the real Core and Sim2DHost. Everything is deterministic (seed 1).
 * Each test prints its timeline (switches to LIVE with their triggers, encounters, deaths, the round end): run with
 * `npx vitest run tests/scenarios.test.ts --reporter=verbose`. Where an outcome depends on the 2D engine's toy AI (who
 * wins a LIVE fight), the tests assert the trigger logic and the invariants and print the winner.
 *
 * The invariant every scenario shares ("small drift doesn't spread"): a puppet nothing touched replays exactly. On
 * every tick a pawn is REPLAY and alive both here and in the no-human golden master, has not been body-blocked and
 * has not been LIVE yet, it is where the golden master has it (within 0.01 units). G1: a pawn that rejoined its
 * recording is REPLAY again but catching up from where its LIVE self left it, so it is measured up to its first switch
 * (tests/rejoin.test.ts checks what it does after).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, SessionLog, canonicalize, replay, stableStringify, type DamageEvent, type LogEntry, type Observe, type PlayerId } from '../src/contracts/index';
import { ReplayCore, tickOf } from '../src/core/index';
import { NavWalkQuery } from '../src/sim2d/index';
import { FOLLOW_SCRIPT, playScript } from '../tools/follow-script';
import { NO_HUMAN, ROOT, coreLogs, deaths, loadHarnessData, runHarness, type HarnessRun } from '../tools/harness';
import { HumanBot, ScenarioError, formatTimeline, liveSwitches, loadScenario, parseScenario, timeline, type TimelineEvent } from '../tools/human-bot';

const data = loadHarnessData();
const tuning = data.tuning;
const golden = runHarness(data, NO_HUMAN);

interface ScenarioRun {
  readonly run: HarnessRun;
  readonly bot: HumanBot;
  readonly tl: readonly TimelineEvent[];
}

function play(name: string): ScenarioRun {
  const s = loadScenario(`${ROOT}/fixtures/scenarios/${name}.json`);
  const bot = HumanBot.fromScenario(data, s);
  const run = runHarness(data, { human: s.human, driver: bot, lastTick: s.until === 'end' ? 'end' : tickOf(s.until), seed: s.seed });
  const tl = timeline(run.entries);
  console.log(`[scenario ${name}] ${s.description}\n${formatTimeline(tl)}\n`);
  return { run, bot, tl };
}

const pawnAt = (e: LogEntry, id: PlayerId): Observe['pawns'][number] => e.observe.pawns.find((p) => p.id === id) as Observe['pawns'][number];
const statusAt = (e: LogEntry, id: PlayerId) => e.act.status.find((s) => s.id === id);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Damage events (with their observe tick). */
function damages(entries: readonly LogEntry[]): (DamageEvent & { tick: number })[] {
  const out: (DamageEvent & { tick: number })[] = [];
  for (const e of entries) for (const ev of e.observe.events) if (ev.type === 'damage') out.push({ ...ev, tick: e.observe.tick });
  return out;
}

/** Per pawn, the largest distance from the golden master's position on ticks it is REPLAY and alive in both runs, not body-blocked yet and not LIVE yet. */
function replayDeviation(run: HarnessRun): Map<PlayerId, number> {
  const out = new Map<PlayerId, number>();
  const firstBlock = new Map<PlayerId, number>();
  for (const b of run.bodyBlocks) if (!firstBlock.has(b.id)) firstBlock.set(b.id, b.tick);
  for (const s of liveSwitches(run.entries)) if ((firstBlock.get(s.id) ?? Infinity) > s.tick) firstBlock.set(s.id, s.tick);
  for (let k = 1; k < run.entries.length && k < golden.entries.length; k++) {
    const e = run.entries[k] as LogEntry;
    const g = golden.entries[k] as LogEntry;
    for (const id of PLAYER_IDS) {
      if ((firstBlock.get(id) ?? Infinity) <= k) continue;
      const p = pawnAt(e, id);
      const q = pawnAt(g, id);
      if (statusAt(e, id)?.mode !== 'REPLAY' || statusAt(g, id)?.mode !== 'REPLAY' || !p.alive || !q.alive) continue;
      out.set(id, Math.max(out.get(id) ?? 0, dist(p.pos, q.pos)));
    }
  }
  return out;
}

function expectUntouchedReplay(run: HarnessRun): void {
  for (const [id, d] of replayDeviation(run)) expect(d, `${id} off the golden master while REPLAY`).toBeLessThan(0.01);
}

/** The single round_end, checked against the game rules (who is alive, the bomb). */
function expectRoundEndByRules(run: HarnessRun): { tick: number; winner: string; reason: string } {
  const ends: { tick: number; winner: string; reason: string }[] = [];
  for (const e of run.entries) for (const ev of e.observe.events) if (ev.type === 'round_end') ends.push({ tick: e.observe.tick, winner: ev.winner, reason: ev.reason });
  expect(ends).toHaveLength(1);
  const end = ends[0] as { tick: number; winner: string; reason: string };
  const o = (run.entries[end.tick] as LogEntry).observe;
  const alive = (team: string): number => o.pawns.filter((p) => p.team === team && p.alive).length;
  if (end.reason === 'elimination') expect(alive(end.winner === 'T' ? 'CT' : 'T')).toBe(0);
  if (end.reason === 'bomb_exploded') expect(o.events.some((ev) => ev.type === 'bomb' && ev.phase === 'exploded')).toBe(true);
  if (end.reason === 'bomb_defused') expect(o.events.some((ev) => ev.type === 'bomb' && ev.phase === 'defused')).toBe(true);
  expect(run.entries.some((e) => e.act.actions.some((a) => a.type === 'end_round'))).toBe(false);
  return end;
}

/** The switches with their log line's reason. */
function switches(run: HarnessRun): { id: PlayerId; tick: number; trigger: string | null; text: string }[] {
  const logs = coreLogs(run.entries).filter((l) => / LIVE: /.test(l.text));
  return liveSwitches(run.entries).map((s) => ({ ...s, text: logs.find((l) => l.tick === s.tick && l.text.startsWith(`${s.id} LIVE`))?.text ?? '' }));
}

const encounterLogs = (run: HarnessRun): { tick: number; text: string }[] => coreLogs(run.entries).filter((l) => l.text.startsWith('encounter '));
const seenTick = (run: HarnessRun): number | null => {
  const l = encounterLogs(run).find((x) => x.text.includes(' in sight at the spot at tick '));
  return l === undefined ? null : l.tick;
};

/** Recorded deaths and damage not involving `skip` before `until`, as [tick, attacker, victim, amount]. */
function recordedHits(entries: readonly LogEntry[], skip: readonly PlayerId[], until: number): (string | number | null)[][] {
  return damages(entries)
    .filter((d) => d.tick < until && !skip.includes(d.victim) && (d.attacker === null || !skip.includes(d.attacker)))
    .map((d) => [d.tick, d.attacker, d.victim, d.amount]);
}

const LOKIER_DEATH = 1203;
const GRACE = Math.round(tuning.replay.outliveGraceSec * 64);

describe('scenario files', () => {
  it('parse, and bad ones are refused with the path', () => {
    for (const n of ['lokier-late', 'never-peeks', 'mid-zwomp', 'flank-sp4rtan', 'cart-dies', 'block-barely', 'block-sp4rtan', 'smoke-window']) {
      expect(loadScenario(`${ROOT}/fixtures/scenarios/${n}.json`).name).toBe(n);
    }
    expect(() => parseScenario({ steps: [{ do: 'dance' }] })).toThrow(ScenarioError);
    expect(() => parseScenario({ steps: [{ do: 'holdStill' }] })).toThrow(/exactly one of sec, until/);
    expect(() => parseScenario({ steps: [{ do: 'aimAt', id: 'bob' }] })).toThrow(/steps\[0\]\.id/);
    expect(() => parseScenario({ steps: [{ do: 'walkTo', pos: [1, 2], speed: 3 }] })).toThrow(/unknown key "speed"/);
    expect(parseScenario({ steps: [{ do: 'fire' }] }).steps[0]).toEqual({ do: 'fire', untilDead: true, maxSec: 3 });
  });
});

describe('1. no-op guard', () => {
  it('the golden no-human round: no pawn goes LIVE, no set_mode, no HUMAN status', () => {
    expect(liveSwitches(golden.entries)).toEqual([]);
    expect(golden.entries.some((e) => e.act.actions.some((a) => a.type === 'set_mode' || a.type === 'unblock_damage'))).toBe(false);
    expect(golden.entries.some((e) => e.act.status.some((s) => s.mode === 'HUMAN' || s.trigger !== null))).toBe(false);
  });

  it('cart follows his recording: nobody goes LIVE, and the round ends CT bomb_defused 12 – 15 like the tape', () => {
    const run = playScript(data, readFileSync(`${ROOT}/${FOLLOW_SCRIPT}`, 'utf8'));
    const sw = switches(run);
    console.log(`[no-op guard, cart-follows-recording] switches:\n${sw.map((s) => `  ${s.tick} (${(s.tick / 64).toFixed(2)} s) ${s.text}`).join('\n')}\n${formatTimeline(timeline(run.entries))}\n`);
    expect(sw).toEqual([]);
    // Cart's recorded spray during the defuse (65.9–66.9 s, 11 shots, no damage on the tape): the follow script looks
    // where his recorded view does (tools/follow-aim.ts), 17–22° off sp4rtan, so it misses as it did; sp4rtan defuses.
    const spray = run.entries.filter((e) => e.observe.tick >= 4210 && e.observe.tick <= 4290 && e.observe.events.some((ev) => ev.type === 'shot' && ev.shooter === 'cart'));
    expect(spray.length).toBeGreaterThanOrEqual(10);
    expect(damages(run.entries).some((d) => d.attacker === 'cart' && d.victim === 'sp4rtan')).toBe(false);
    const end = expectRoundEndByRules(run);
    expect(end).toEqual({ tick: 4275, winner: 'CT', reason: 'bomb_defused' });
    expect((run.entries[run.entries.length - 1] as LogEntry).observe.round.score).toEqual({ ct: 12, t: 15 });
    // Lokier: the encounter starts when he sees cart at the window, but cart's real AK headshot (E1's re-check: with C4's
    // sight mask his bullets do reach Lokier through the Apartments window) kills him before the scripted hit is due.
    const seen = seenTick(run);
    expect(seen).not.toBeNull();
    const lokier = deaths(run.entries).find((d) => d.victim === 'lokier');
    expect(lokier).toMatchObject({ attacker: 'cart', headshot: true });
    expect(lokier?.tick).toBeLessThan(LOKIER_DEATH);
    expect((lokier?.tick ?? 0) < (seen ?? 0) + Math.round(tuning.replay.encounterDelaySec * 64)).toBe(true);
    expect(damages(run.entries).some((d) => d.attacker === 'lokier' && d.victim === 'cart')).toBe(false);
    // Lokier saw cart earlier too (10.9 s, down the corridor from Truck), with cart on course: no divergence.
    expect(run.entries.some((e) => e.observe.tick < 800 && pawnAt(e, 'lokier').sees.includes('cart'))).toBe(true);
    expectUntouchedReplay(run);
  });
});

describe('2. cart kills Lokier about 3 s late', () => {
  const { run } = play('lokier-late');

  it('Lokier takes his scripted shot about 1 s after first seeing cart at the window, and cart kills him for real', () => {
    const seen = seenTick(run) as number;
    const delay = Math.round(tuning.replay.encounterDelaySec * 64);
    expect(seen).toBeGreaterThan(1117 + 2 * 64);
    // The first tick Lokier sees cart within humanSpotToleranceUnits of the recorded spot at the window (he may see him
    // a little earlier further along the corridor: an expected pair then, so no divergence).
    const spot = run.core.divergence.encounters[0]?.spot as { x: number; y: number };
    const atSpot = (e: LogEntry): boolean => pawnAt(e, 'lokier').sees.includes('cart') && dist(pawnAt(e, 'cart').pos, spot) <= tuning.replay.humanSpotToleranceUnits;
    expect(atSpot(run.entries[seen] as LogEntry)).toBe(true);
    expect(run.entries.slice(1, seen).some(atSpot)).toBe(false);
    expect(switches(run).some((s) => s.tick < seen)).toBe(false);
    const hit = damages(run.entries).filter((d) => d.attacker === 'lokier' && d.victim === 'cart');
    expect(hit).toEqual([expect.objectContaining({ tick: seen + delay, amount: 73, armor: 7, scripted: true, weapon: 'ssg08' })]);
    expect(pawnAt(run.entries[seen + delay] as LogEntry, 'cart')).toMatchObject({ hp: 27, armor: 93 });
    // The engine's own SSG bullet was blocked for the scripted shot: one hit, and the shot was fired.
    expect((run.entries[seen + delay] as LogEntry).observe.events.some((e) => e.type === 'shot' && e.shooter === 'lokier')).toBe(true);
    const kill = deaths(run.entries).find((d) => d.victim === 'lokier');
    expect(kill).toMatchObject({ attacker: 'cart' });
    expect(damages(run.entries).find((d) => d.victim === 'lokier')?.scripted).toBe(false);
    const late = ((kill?.tick ?? 0) - LOKIER_DEATH) / 64;
    console.log(`[lokier-late] seen ${seen}, scripted hit ${seen + delay}, kill ${kill?.tick} (${late.toFixed(2)} s after the recorded 18.80 s)`);
    expect(late).toBeGreaterThan(2);
    expect(kill?.tick).toBeLessThan(LOKIER_DEATH + GRACE);
  });

  it('nobody else changes mode before the Ts reach B site, and nobody else’s recorded kill or damage moves', () => {
    const sw = switches(run);
    const first = sw[0];
    expect(first === undefined || first.tick > 1761).toBe(true); // the plant, on B site
    // No switch at all: cart's later spray at the defusing sp4rtan misses as on the tape (he follows his recording
    // again, tools/follow-aim.ts), so everything not involving cart and Lokier lands on the golden master's ticks.
    const until = first === undefined ? Infinity : first.tick;
    expect(sw).toEqual([]);
    expect(recordedHits(run.entries, ['cart', 'lokier'], until)).toEqual(recordedHits(golden.entries, ['cart', 'lokier'], until));
    const bomb = (r: HarnessRun) => r.entries.flatMap((e) => e.observe.events.filter((ev) => ev.type === 'bomb' && e.observe.tick < until).map((ev) => [e.observe.tick, ev.type === 'bomb' ? ev.phase : '']));
    expect(bomb(run)).toEqual(bomb(golden));
    expectUntouchedReplay(run);
  });

  it('replays identically through a fresh Core, and a Core snapshot mid-encounter continues exactly', () => {
    const fresh = (): ReplayCore => new ReplayCore(run.model, run.session.schedule, tuning, 1, new NavWalkQuery(data.nav));
    const log = SessionLog.fromText(run.log.toText());
    expect(replay(log, fresh())).toMatchObject({ identical: true, mismatchCount: 0 });
    const seen = seenTick(run) as number;
    const a = fresh();
    for (let i = 0; i <= seen + 10; i++) {
      const e = log.at(i) as LogEntry;
      for (const c of e.controls) a.control(c);
      a.step(e.observe);
    }
    const b = fresh();
    b.restore(a.snapshot());
    for (let i = seen + 11; i < seen + 300; i++) {
      const e = log.at(i) as LogEntry;
      expect(stableStringify(canonicalize(b.step(e.observe)))).toBe(stableStringify(e.act));
    }
  });
});

describe('3. cart never peeks', () => {
  const { run } = play('never-peeks');

  it('Lokier outlives his recording at 18.8 + 3 s and goes LIVE holding B; the Ts walking onto the site see him and go LIVE', () => {
    const sw = switches(run);
    expect(sw[0]).toMatchObject({ id: 'lokier', tick: LOKIER_DEATH + GRACE, trigger: 'outlived' });
    expect(sw[0]?.text).toBe('lokier LIVE: outlived recording (+3.0 s); goal hold, 0 waypoints');
    const mode = (run.entries[LOKIER_DEATH + GRACE] as LogEntry).act.actions.find((a) => a.type === 'set_mode');
    const last = run.model.track('lokier').at(-1) as { x: number; y: number; z: number };
    expect(mode).toEqual({ type: 'set_mode', id: 'lokier', mode: 'LIVE', goal: { route: [], role: 'hold', hold: { x: last.x, y: last.y, z: last.z } } });
    // Every pawn that goes LIVE while Lokier lives does so because of him: a T that sees him (or hears him fire).
    const lokierDeath = deaths(run.entries).find((d) => d.victim === 'lokier')?.tick as number;
    const during = sw.filter((s) => s.tick > LOKIER_DEATH + GRACE && s.tick <= lokierDeath);
    expect(during.length).toBeGreaterThan(0);
    for (const s of during) {
      expect(['barely', 'donk']).toContain(s.id);
      expect(s.text).toMatch(/LIVE: (sees lokier \(LIVE\)|heard lokier fire)/);
    }
    expect(during[0]).toMatchObject({ id: 'barely', trigger: 'sighting' });
    // The fight is real: Lokier dies to engine damage.
    expect(damages(run.entries).find((d) => d.victim === 'lokier' && d.tick === lokierDeath)?.scripted).toBe(false);
    console.log(`[never-peeks] switches: ${sw.map((s) => `${s.id}@${s.tick} ${s.trigger}`).join(', ')}; Lokier killed by ${deaths(run.entries).find((d) => d.victim === 'lokier')?.attacker} at ${lokierDeath}`);
  });

  it('the round still ends by the game rules', () => {
    const end = expectRoundEndByRules(run);
    console.log(`[never-peeks] round_end at ${end.tick} (${(end.tick / 64).toFixed(2)} s): ${end.winner} ${end.reason}`);
    expectUntouchedReplay(run);
  });
});

describe('4. cart pushes Mid and kills Zwomp around 30 s', () => {
  const { run } = play('mid-zwomp');

  it('Zwomp dies for real; barely’s 44.2 s kill is dropped and barely keeps replaying', () => {
    const z = deaths(run.entries).find((d) => d.victim === 'zwomp');
    expect(z).toMatchObject({ attacker: 'cart' });
    expect(((z?.tick ?? 0) / 64)).toBeGreaterThan(29.5);
    expect(((z?.tick ?? 0) / 64)).toBeLessThan(30.5);
    const texts = coreLogs(run.entries).map((l) => l.text);
    expect(texts).toContain('script: dropped barely ak47 burst at zwomp (7 shots from tick 2789): zwomp is dead');
    expect(texts).toContain('script: dropped damage barely -> zwomp (lethal at tick 2829): zwomp is dead');
    expect(liveSwitches(run.entries).some((s) => s.id === 'barely')).toBe(false);
    expect(deaths(run.entries).find((d) => d.victim === 'barely')).toMatchObject({ tick: 3766, attacker: 'sp4rtan' });
  });

  it('sp4rtan goes LIVE only if he is within hearing range of the shots', () => {
    let min = Infinity;
    for (const e of run.entries) {
      for (const ev of e.observe.events) {
        if (ev.type === 'sound' && ev.kind === 'shot' && ev.source === 'cart') min = Math.min(min, dist(pawnAt(e, 'sp4rtan').pos, ev.pos));
      }
    }
    console.log(`[mid-zwomp] sp4rtan's closest distance to cart's shots: ${min.toFixed(0)} u (hearing range ${tuning.replay.hearingRangeUnits})`);
    const sp = liveSwitches(run.entries).find((s) => s.id === 'sp4rtan');
    if (min > tuning.replay.hearingRangeUnits) expect(sp).toBeUndefined();
    else expect(sp).toMatchObject({ trigger: 'gunfire' });
  });

  it('everything else is unchanged', () => {
    expect(liveSwitches(run.entries).map((s) => s.id)).toEqual(['zwomp']);
    expect(recordedHits(run.entries, ['cart', 'lokier', 'zwomp'], Infinity)).toEqual(recordedHits(golden.entries, ['cart', 'lokier', 'zwomp'], Infinity));
    const ev = (r: HarnessRun) => r.entries.flatMap((e) => e.observe.events.filter((x) => x.type === 'bomb' || x.type === 'round_end').map((x) => [e.observe.tick, JSON.stringify(x)]));
    expect(ev(run)).toEqual(ev(golden));
    expectRoundEndByRules(run);
    expectUntouchedReplay(run);
  });
});

describe('5. cart catches sp4rtan on his flank around 45 s', () => {
  const { run } = play('flank-sp4rtan');

  it('sp4rtan dies; donk and barely outlive their recordings and go LIVE guarding the bomb; T elimination, 11 – 16', () => {
    const sp = deaths(run.entries).find((d) => d.victim === 'sp4rtan');
    expect(sp).toMatchObject({ attacker: 'cart' });
    expect(Math.abs((sp?.tick ?? 0) / 64 - 45)).toBeLessThan(1);
    const sw = switches(run).filter((s) => s.id !== 'sp4rtan');
    expect(sw.map((s) => [s.id, s.tick, s.trigger])).toEqual([
      ['donk', 3222 + GRACE, 'outlived'],
      ['barely', 3766 + GRACE, 'outlived'],
    ]);
    for (const s of sw) {
      const set = (run.entries[s.tick] as LogEntry).act.actions.find((a) => a.type === 'set_mode' && a.id === s.id);
      expect(set?.type === 'set_mode' ? set.goal?.role : null).toBe('guard_bomb');
    }
    const end = expectRoundEndByRules(run);
    expect(end).toEqual({ tick: sp?.tick, winner: 'T', reason: 'elimination' });
    expect((run.entries[run.entries.length - 1] as LogEntry).observe.round.score).toEqual({ ct: 11, t: 16 });
    expectUntouchedReplay(run);
  });

  it('after the round the bomb still ticks: the LIVE guards leave its blast and survive it (they used to die in it)', () => {
    const blast = run.entries.find((e) => e.observe.events.some((ev) => ev.type === 'bomb' && ev.phase === 'exploded')) as LogEntry;
    expect(blast.observe.tick).toBe(4321);
    const bomb = blast.observe.round.bomb.pos as { x: number; y: number; z: number };
    for (const id of ['donk', 'barely'] as const) {
      const p = pawnAt(blast, id);
      const d = Math.hypot(p.pos.x - bomb.x, p.pos.y - bomb.y, p.pos.z - bomb.z);
      console.log(`[flank-sp4rtan] ${id} at the explosion: ${d.toFixed(0)} u from the bomb, ${p.hp} HP`);
      expect(p.alive, id).toBe(true);
    }
    expect(deaths(run.entries).filter((d) => d.victim === 'donk' || d.victim === 'barely')).toEqual([]);
    // donk (LIVE from 53.3 s) is out of the radius; barely (from 61.8 s) runs and takes only the edge of it.
    const donk = pawnAt(blast, 'donk');
    expect(Math.hypot(donk.pos.x - bomb.x, donk.pos.y - bomb.y, donk.pos.z - bomb.z)).toBeGreaterThanOrEqual(tuning.bomb.radius);
  });
});

describe('6. cart dies early', () => {
  const { run } = play('cart-dies');

  it('the encounter comes early, then cart walks into Lokier’s angle and a LIVE Lokier kills him for real', () => {
    const seen = seenTick(run) as number;
    const delay = Math.round(tuning.replay.encounterDelaySec * 64);
    expect(seen).toBeLessThan(1117 - 5 * 64);
    expect(damages(run.entries).filter((d) => d.attacker === 'lokier' && d.victim === 'cart' && d.scripted)).toEqual([expect.objectContaining({ tick: seen + delay, amount: 73 })]);
    const lk = switches(run).find((s) => s.id === 'lokier');
    expect(lk).toMatchObject({ trigger: 'sighting' });
    const death = deaths(run.entries).find((d) => d.victim === 'cart');
    expect(death).toMatchObject({ attacker: 'lokier', weapon: 'ssg08' });
    expect(death?.tick).toBeGreaterThan(lk?.tick ?? Infinity);
    expect(damages(run.entries).find((d) => d.victim === 'cart' && d.tick === death?.tick)?.scripted).toBe(false);
    console.log(`[cart-dies] encounter seen ${seen}, scripted hit ${seen + delay}, lokier LIVE ${lk?.tick} (${lk?.text}), cart killed at ${death?.tick}`);
  });

  it('the round continues and every untouched puppet still replays', () => {
    const death = deaths(run.entries).find((d) => d.victim === 'cart')?.tick as number;
    const end = expectRoundEndByRules(run);
    expect(end.tick).toBeGreaterThan(death);
    // Recorded events between puppets that nothing reached land on the recorded ticks: snarlbot's two kills,
    // sp4rtan's kill of snarlbot, barely's plant.
    const ticks = deaths(run.entries).map((d) => [d.tick, d.attacker, d.victim]);
    for (const k of [[32, 'snarlbot', 'incredibad'], [794, 'snarlbot', 'snakelore'], [1142, 'sp4rtan', 'snarlbot']]) expect(ticks).toContainEqual(k);
    expect(run.entries.some((e) => e.observe.tick === 1761 && e.observe.events.some((ev) => ev.type === 'bomb' && ev.phase === 'planted' && ev.id === 'barely'))).toBe(true);
    expectUntouchedReplay(run);
  });
});

describe('7. body block', () => {
  it('cart in barely’s path in the Apartments corridor: teammates are not solid, so barely is never pushed and keeps replaying', () => {
    const { run } = play('block-barely');
    let closest = Infinity;
    for (const e of run.entries) if (pawnAt(e, 'cart').sees.includes('barely')) closest = Math.min(closest, dist(pawnAt(e, 'cart').pos, pawnAt(e, 'barely').pos));
    expect(closest).toBeLessThan(2 * tuning.collision.pawnRadius);
    expect(tuning.collision.solidTeammates).toBe(false);
    expect(run.bodyBlocks.filter((b) => b.id === 'barely')).toEqual([]);
    // barely goes LIVE only when Lokier, who outlived his recording (cart never peeked), comes into his sight.
    const sw = switches(run);
    expect(sw.some((s) => s.trigger === 'blocked')).toBe(false);
    expect(sw.find((s) => s.id === 'barely')?.tick ?? Infinity).toBeGreaterThan(LOKIER_DEATH + GRACE);
    expectUntouchedReplay(run);
  });

  it('cart in sp4rtan’s way to the bomb (an enemy, solid): held off his track while cart watches, sp4rtan goes LIVE (blocked)', () => {
    const { run } = play('block-sp4rtan');
    const sw = switches(run);
    expect(sw.map((s) => [s.id, s.trigger])).toEqual([['sp4rtan', 'blocked']]);
    const k = (sw[0] as { tick: number }).tick;
    const e = run.entries[k] as LogEntry;
    expect(pawnAt(e, 'cart').sees).toContain('sp4rtan');
    expect(dist(pawnAt(e, 'cart').pos, pawnAt(e, 'sp4rtan').pos)).toBeLessThanOrEqual(2 * tuning.collision.pawnRadius + tuning.replay.contactSlackUnits);
    // The engine's debug hint agrees (the Core doesn't read it): sp4rtan's moves were cut by cart before the switch.
    expect(run.bodyBlocks.some((b) => b.id === 'sp4rtan' && b.by === 'cart' && b.tick < k)).toBe(true);
    // The two were in sight of each other: the recording has them on B together (58.6 s on), so no sighting trigger.
    expect(sw[0]?.text).toMatch(/^sp4rtan LIVE: blocked by cart, (held|pushed) \d+ u off course, seen by cart/);
    expectUntouchedReplay(run);
  });
});

describe('8. smoke on Lokier’s angle', () => {
  const { run } = play('smoke-window');

  it('Lokier’s scheduled shot waits until cart is actually visible', () => {
    const spot = { x: -1764, y: 800 };
    const tol = tuning.replay.humanSpotToleranceUnits;
    // cart throws a smoke, and stands at his recorded spot at the recorded hit (18.50 s), unseen by Lokier.
    expect(run.entries.some((e) => e.observe.events.some((ev) => ev.type === 'sound' && ev.kind === 'grenade' && ev.source === 'cart' && e.observe.tick > 15 * 64))).toBe(true);
    const atSpot = run.entries.filter((e) => e.observe.tick >= 1150 && e.observe.tick <= 1250 && dist(pawnAt(e, 'cart').pos, spot) <= tol);
    expect(atSpot.length).toBeGreaterThan(50);
    for (const e of atSpot) expect(pawnAt(e, 'lokier').sees).not.toContain('cart');
    // The encounter starts on the first tick Lokier sees cart at the spot, the hit lands encounterDelaySec later.
    const seen = seenTick(run) as number;
    const firstSeen = run.entries.find((e) => e.observe.tick > 1100 && pawnAt(e, 'lokier').sees.includes('cart') && dist(pawnAt(e, 'cart').pos, spot) <= tol)?.observe.tick;
    expect(seen).toBe(firstSeen);
    expect(seen).toBeGreaterThan(19.3 * 64);
    const delay = Math.round(tuning.replay.encounterDelaySec * 64);
    expect(damages(run.entries).filter((d) => d.attacker === 'lokier' && d.victim === 'cart')).toEqual([expect.objectContaining({ tick: seen + delay, amount: 73, scripted: true })]);
    expect(deaths(run.entries).find((d) => d.victim === 'lokier')).toMatchObject({ attacker: 'cart' });
    expect(liveSwitches(run.entries)).toEqual([]);
    expectUntouchedReplay(run);
  });
});
