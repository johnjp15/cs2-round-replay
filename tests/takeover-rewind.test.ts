/**
 * G4: the takeover in the Session's run: rewind (exact and resync), seek through it, a second takeover at another
 * tick, the Session's rules (who, when, what is logged), a release without a rewind, and the human-bot scenario
 * `takeover-duel`. docs/core.md "Takeover", docs/app.md. Seed 1, the real Core and Sim2DHost.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { replay, type LogEntry, type PawnInput, type SessionLog } from '../src/contracts/index';
import { summarize, tickOf } from '../src/core/index';
import { Session, defaultCore, type SessionConfig } from '../src/app/session';
import { GOLDEN_DIR, gunzipText, readManifest } from '../tools/golden-fixtures';
import { ROOT, coreLogs, deaths, loadHarnessData, logDigest, runHarness } from '../tools/harness';
import { HumanBot, formatTimeline, loadScenario, timeline } from '../tools/human-bot';

const data = loadHarnessData();
/** The no-human golden master: the committed fixture (tests/fixtures.test.ts and the golden round keep it current). */
const GOLDEN = readManifest()?.fixtures.find((f) => f.name === 'round-nohuman');
const goldenLines = gunzipText(readFileSync(resolve(ROOT, GOLDEN_DIR, GOLDEN?.file ?? 'round-nohuman.jsonl.gz')))
  .split('\n')
  .filter((l) => l !== '');
const goldenEntries = goldenLines.map((l) => JSON.parse(l) as LogEntry);
const END = goldenLines.length - 1;
const TAKEOVER = tickOf(25);

function session(extra: Partial<SessionConfig> = {}): Session {
  return new Session({ ...data, seed: 1, human: null, ...extra });
}

/** The human's input on tick k (a pure function of k): runs and turns, so every replay can give the same. */
function inputAt(k: number): PawnInput {
  return { id: 'cart', forward: 1, side: k % 128 < 64 ? 0.5 : -0.5, yaw: 90 + (k % 360), pitch: 0, buttons: [] };
}

/** Step until the next step would be past `last`; while cart is controlled, new input every 64 ticks. */
function runTo(s: Session, last: number, play = true): void {
  while (s.tick <= last) {
    if (play && s.human !== null && s.tick % 64 === 0) s.setHumanInput(inputAt(s.tick));
    s.step();
  }
}

function entries(log: SessionLog): LogEntry[] {
  const out: LogEntry[] = [];
  for (let i = 0; i < log.length; i++) out.push(log.at(i) as LogEntry);
  return out;
}

function firstDiff(a: readonly string[], b: readonly string[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return -1;
}

const cartPairs = (s: Session): string[] =>
  s.host
    .blockedPairs()
    .filter((p) => p.attacker === 'cart' || p.victim === 'cart')
    .map((p) => `${p.attacker}>${p.victim}`);

describe('rewind across the takeover (exact: the host snapshots)', () => {
  it('back before T is watching again, byte for byte; a seek replays the takeover; a second takeover at another tick works', () => {
    const s = session();
    runTo(s, TAKEOVER - 1);
    expect(cartPairs(s)).toHaveLength(11);
    s.takeControl();
    expect([s.human, s.takeoverTick, s.canTakeControl]).toEqual(['cart', TAKEOVER, false]);
    expect(s.takeControlBlocked()).toBe('cart is already controlled');
    runTo(s, tickOf(30));
    expect(cartPairs(s)).toEqual([]);
    const straight = s.log().lines().slice();

    // The checkpoint at 25 s was taken after the takeover (before that tick's step): rewinding to it keeps him.
    expect(s.checkpoints.get('auto:1600')?.observe.human).toBe('cart');
    s.rewind('auto:1600');
    expect([s.human, s.takeoverTick]).toEqual(['cart', TAKEOVER]);
    s.seek(30 + 1 / 64);
    expect(firstDiff(s.log().lines(), straight)).toBe(-1);

    // Back to 20 s: watching again, cart a blocked puppet; the tape keeps the takeover and a seek replays it.
    s.rewind('auto:1280');
    expect([s.human, s.takeoverTick, s.tapeEnd]).toEqual([null, null, tickOf(30) + 1]);
    expect(cartPairs(s)).toHaveLength(11);
    expect(s.pawnState('cart')?.mode).toBe('REPLAY');
    expect(() => s.setHumanInput(inputAt(1280))).toThrow(/spectating/);
    s.seek(30 + 1 / 64);
    expect([s.human, s.takeoverTick]).toEqual(['cart', TAKEOVER]);
    expect(firstDiff(s.log().lines(), straight)).toBe(-1);

    // Back to 20 s again and play on live without taking control: the tape is dropped and the round is golden.
    s.rewind('auto:1280');
    runTo(s, END, false);
    expect(s.tapeEnd).toBeNull();
    expect(firstDiff(s.log().lines(), goldenLines)).toBe(-1);
    expect(logDigest(s.log())).toBe(GOLDEN?.digest);
    expect(summarize(s.model, s.log()).headline).toBe('Played it like the tape: CT defuse, 0.72 s left');

    // A second takeover at another tick (40 s): the log up to it is still the golden master's.
    s.rewind('auto:2560');
    expect(s.human).toBeNull();
    s.takeControl();
    runTo(s, tickOf(42));
    const second = s.log().lines();
    expect(firstDiff(second, goldenLines)).toBe(2560);
    expect((s.log().at(2560) as LogEntry).observe.human).toBe('cart');
    expect(coreLogs(entries(s.log())).filter((l) => l.text.startsWith('takeover: ')).map((l) => l.tick)).toEqual([2560]);
  }, 120_000);

  it('restart returns to watching; take_control through control() is not logged and not sent to the Core', () => {
    const s = session();
    runTo(s, 99);
    s.control({ type: 'take_control', id: 'cart' });
    expect(s.human).toBe('cart');
    s.step();
    expect((s.log().at(100) as LogEntry).controls).toEqual([]);
    expect((s.log().at(100) as LogEntry).observe.human).toBe('cart');
    s.restart();
    expect([s.human, s.takeoverTick, s.log().length]).toEqual([null, null, 0]);
    runTo(s, 99);
    expect(firstDiff(s.log().lines(), goldenLines.slice(0, 100))).toBe(-1);
    // Only the playable pawn, only while watching.
    expect(s.takeControlBlocked('donk')).toBe('donk is not the playable pawn (cart)');
    expect(() => s.takeControl('donk')).toThrow(/playable/);
    expect(session({ playable: null }).takeControlBlocked()).toMatch(/not the playable pawn/);
    // A session with a human from the start has nobody to take over.
    expect(new Session({ ...data, seed: 1 }).takeControlBlocked()).toBe('cart is already controlled');
  }, 120_000);
});

describe('rewind across the takeover (resync: no host snapshot, as in CS2)', () => {
  it('cart is a REPLAY puppet again with all 60 pairs blocked; the round plays on as recorded and the log replays; a second takeover works', () => {
    const s = session({ capabilities: { snapshot: false } });
    runTo(s, TAKEOVER - 1);
    s.takeControl();
    runTo(s, tickOf(30));
    s.rewind('auto:1280');
    expect(s.human).toBeNull();
    expect(s.takeControlBlocked()).toBe('a resync is pending; step first');
    s.step();
    const resync = s.log().at(1280) as LogEntry;
    expect(resync.observe.human).toBeNull();
    expect(resync.controls).toEqual([{ type: 'rewind', id: 'auto:1280' }]);
    expect(resync.act.actions).toContainEqual({ type: 'set_mode', id: 'cart', mode: 'REPLAY', goal: null });
    expect(resync.act.actions.filter((a) => a.type === 'block_damage')).toHaveLength(60);
    expect(resync.act.actions.some((a) => a.type === 'log' && a.text === 'rewind auto:1280: resync to tick 1280, 5 pawns placed, 0 LIVE, 60 blocked pairs')).toBe(true);
    runTo(s, END, false);
    const es = entries(s.log());
    // Nobody went LIVE, and every death, the plant, the defuse and the round end are within 2 ticks of the golden master's.
    expect(es.some((e) => e.act.status.some((q) => q.mode === 'LIVE' || q.mode === 'HUMAN') && e.observe.tick > 1280)).toBe(false);
    const key = (r: readonly LogEntry[]): { key: string; tick: number }[] =>
      deaths(r)
        .map((d) => ({ key: `${d.attacker ?? 'world'}>${d.victim}`, tick: d.tick }))
        .concat(r.flatMap((e) => e.observe.events.filter((ev) => ev.type === 'bomb' || ev.type === 'round_end').map((ev) => ({ key: ev.type === 'bomb' ? `bomb ${ev.phase}` : 'round_end', tick: e.observe.tick }))));
    const got = key(es);
    const want = key(goldenEntries);
    expect(got.map((x) => x.key)).toEqual(want.map((x) => x.key));
    for (let i = 0; i < want.length; i++) expect(Math.abs((got[i]?.tick ?? 0) - (want[i]?.tick ?? 0)), want[i]?.key).toBeLessThanOrEqual(2);
    const core = defaultCore({ model: s.model, schedule: s.schedule, tuning: s.tuning, seed: 1, nav: s.nav, geometry: s.geometry });
    expect(replay(s.log(), core)).toMatchObject({ identical: true, mismatchCount: 0 });

    // Second takeover at 40 s (after the resync step).
    s.rewind('auto:2560');
    s.step();
    s.takeControl();
    runTo(s, tickOf(41));
    const k = 2561;
    expect((s.log().at(k) as LogEntry).observe.human).toBe('cart');
    expect(coreLogs(entries(s.log())).filter((l) => l.text.startsWith('takeover: ')).map((l) => l.tick)).toEqual([k]);
    expect(replay(s.log(), defaultCore({ model: s.model, schedule: s.schedule, tuning: s.tuning, seed: 1, nav: s.nav, geometry: s.geometry }))).toMatchObject({ identical: true });
  }, 120_000);
});

describe('release without a rewind (CS2: the player leaves; not offered by the app)', () => {
  it('the pawn goes LIVE (trigger released) with its blocks still lifted', () => {
    const s = session();
    runTo(s, tickOf(30) - 1);
    s.takeControl();
    runTo(s, tickOf(31));
    // What a CS2 server does when the player leaves: the bot takes its pawn back.
    s.host.setHuman(null);
    const k = s.tick;
    s.step();
    const e = s.log().at(k) as LogEntry;
    expect(e.observe.human).toBeNull();
    expect(e.act.status.find((q) => q.id === 'cart')).toEqual({ id: 'cart', mode: 'LIVE', trigger: 'released', sinceTick: k });
    const mode = e.act.actions.find((a) => a.type === 'set_mode');
    expect(mode).toMatchObject({ type: 'set_mode', id: 'cart', mode: 'LIVE', goal: { role: 'guard_bomb' } });
    expect(coreLogs([e]).map((l) => l.text)).toContainEqual(expect.stringMatching(/^cart LIVE: released by the human at tick \d+; goal guard_bomb/));
    expect(e.act.actions.some((a) => a.type === 'block_damage' || a.type === 'unblock_damage')).toBe(false);
    expect(cartPairs(s)).toEqual([]);
  }, 120_000);
});

describe('scenario takeover-duel (G4)', () => {
  it('watch to 18.0 s, take control at the window, take the hit, kill Lokier, play the recording: Lokier dies to his real headshot, the rest is the tape (D1)', () => {
    const sc = loadScenario(`${ROOT}/fixtures/scenarios/takeover-duel.json`);
    expect(sc.takeover).toBe(18);
    const run = runHarness(data, { human: sc.human, driver: HumanBot.fromScenario(data, sc), lastTick: 'end', seed: sc.seed, takeover: tickOf(sc.takeover ?? 0) });
    const tl = timeline(run.entries);
    console.log(`[scenario takeover-duel]\n${formatTimeline(tl)}\n`);
    expect(firstDiff(run.log.lines().slice(0, 1152), goldenLines.slice(0, 1152))).toBe(-1);
    expect(tl.filter((x) => x.kind === 'takeover').map((x) => x.tick)).toEqual([1152]);
    const ds = deaths(run.entries).map((d) => `${d.tick} ${d.attacker ?? 'world'}>${d.victim}${d.headshot ? ' HS' : ''}`);
    const gd = deaths(goldenEntries).map((d) => `${d.tick} ${d.attacker ?? 'world'}>${d.victim}${d.headshot ? ' HS' : ''}`);
    // The hit lands on its recorded tick (Lokier saw the puppet on course): cart can still die to Lokier's tape shot if he
    // stands in it (27 HP, so sp4rtan's post-round shot still kills him). D1 (John 13:10): his first shot (18.72 s) is a
    // real headshot and kills Lokier then, 0.08 s before the tape (G5 held it to the recorded 18.80 s); every other death
    // is the golden master's, on its tick, and nobody goes LIVE (inside the drift window the tape's kill was coming).
    expect(ds.filter((d) => !d.includes('>lokier'))).toEqual(gd.filter((d) => !d.includes('>lokier')));
    expect(ds.find((d) => d.includes('>lokier'))).toBe('1198 cart>lokier HS');
    expect(tl.some((x) => x.kind === 'live')).toBe(false);
    expect(summarize(run.model, run.entries).headline).toBe('Same result, different round: CT defuse, 0.72 s left; 1 kill changed');
  }, 120_000);
});
