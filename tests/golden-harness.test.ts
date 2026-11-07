/**
 * The headless harness (C5, tools/harness.ts) and its input scripts: script parsing and playback ("track" yaw, held
 * entries, weapon switches through the app's slot keys), the CLI options, the summary, the fast digest, and the two
 * example scripts in fixtures/scripts (cart idle in Back Alley; cart following his own recording, which must be the
 * generator's output). The golden master itself is tests/golden-round.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionLog, fnv1a32Hex, stableStringify, type Act, type Observe } from '../src/contracts/index';
import { startYaw } from '../src/core/index';
import { Session } from '../src/app/index';
import {
  DEFAULT_SEED,
  ROOT,
  ScriptDriver,
  ScriptError,
  TrackYaw,
  formatHumanScript,
  loadHarnessData,
  logDigest,
  optionsFromArgs,
  parseCliArgs,
  parseHumanScript,
  runHarness,
  slotPresses,
  summarize,
  type ScriptEntry,
} from '../tools/harness';
import { FOLLOW_SCRIPT, generateFollowScript, playScript } from '../tools/follow-script';

const data = loadHarnessData();
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const entry = (t: number, more: Partial<ScriptEntry> = {}): Record<string, unknown> => ({ t, forward: 0, side: 0, yaw: 0, pitch: 0, buttons: [], ...more });

describe('input scripts', () => {
  it('parses entries, sorting buttons and defaulting weapon to null', () => {
    const s = parseHumanScript(JSON.stringify([entry(0, { yaw: 'track', buttons: ['WALK', 'ATTACK'] }), { ...entry(0.5, { forward: 1, side: -0.5, pitch: 'track' }), weapon: 'knife' }]));
    expect(s.entries).toEqual([
      { t: 0, forward: 0, side: 0, yaw: 'track', pitch: 0, buttons: ['ATTACK', 'WALK'], weapon: null },
      { t: 0.5, forward: 1, side: -0.5, yaw: 0, pitch: 'track', buttons: [], weapon: 'knife' },
    ]);
  });

  it('rejects bad scripts with the path of the problem', () => {
    const bad: [unknown, RegExp][] = [
      [{}, /expected a JSON array/],
      [[entry(0), entry(0.001)], /script\[1\]\.t: tick 0 is not after/],
      [[entry(0, { forward: 1.5 })], /script\[0\]\.forward/],
      [[entry(0, { yaw: 'north' as never })], /script\[0\]\.yaw/],
      [[{ ...entry(0), buttons: ['FIRE'] }], /unknown button FIRE/],
      [[{ ...entry(0), weapon: 'm249' }], /unknown weapon m249/],
      [[{ ...entry(0), extra: 1 }], /unknown key "extra"/],
      [[{ t: -1, forward: 0, side: 0, yaw: 0, pitch: 0, buttons: [] }], /\.t: expected seconds >= 0/],
    ];
    for (const [json, msg] of bad) expect(() => parseHumanScript(json), String(msg)).toThrow(msg);
    expect(() => parseHumanScript('[{')).toThrow();
    expect(() => parseHumanScript([{ ...entry(0), buttons: 'ATTACK' }])).toThrow(ScriptError);
  });

  it('formats one entry per line with the documented key order, and reads back the same', () => {
    const entries: ScriptEntry[] = [
      { t: 0, forward: 0, side: 0, yaw: 175.601, pitch: 0, buttons: [], weapon: null },
      { t: 1 / 64, forward: 0.165019, side: -0.000001, yaw: 'track', pitch: -10, buttons: ['ATTACK', 'DUCK'], weapon: 'smoke' },
    ];
    const text = formatHumanScript(entries);
    expect(text).toBe(
      '[\n{"t":0,"forward":0,"side":0,"yaw":175.601,"pitch":0,"buttons":[]},\n' +
        '{"t":0.015625,"forward":0.165019,"side":-0.000001,"yaw":"track","pitch":-10,"buttons":["ATTACK","DUCK"],"weapon":"smoke"}\n]\n',
    );
    expect(parseHumanScript(text).entries).toEqual(entries);
  });

  it('plays entries held until the next; "track" is the recorded yaw, else the last yaw; weapons switch on the entry’s first tick', () => {
    const session = new Session({ ...data, seed: DEFAULT_SEED, human: 'cart' });
    const track = new TrackYaw(session, 'cart');
    // cart's recorded (POV) yaw starts at 13.6 s; before that "track" holds the setup yaw.
    const k = [...Array(4442).keys()].find((t) => track.at(t) !== null) as number;
    expect(k).toBeGreaterThan(800);
    expect(track.startYaw).toBe(startYaw(session.model, 'cart').yaw);
    const d = new ScriptDriver(parseHumanScript([entry(0.5, { yaw: 'track', forward: 1 }), { ...entry((k + 2) / 64, { yaw: 'track' }), weapon: 'knife' }, entry((k + 4) / 64, { yaw: 33 })]), 'cart');
    const at = (tick: number): ReturnType<ScriptDriver['command']> => d.command(tick, session);
    expect(at(0)).toEqual({ input: null, weapon: null });
    expect(at(31)).toEqual({ input: null, weapon: null });
    expect(at(32)).toEqual({ input: { id: 'cart', forward: 1, side: 0, yaw: track.startYaw, pitch: 0, buttons: [] }, weapon: null });
    expect(at(k)?.input?.yaw).toBe(track.at(k));
    expect(at(k + 1)?.input).toMatchObject({ forward: 1, yaw: track.at(k + 1) });
    expect(at(k + 2)).toMatchObject({ input: { forward: 0, yaw: track.at(k + 2) }, weapon: 'knife' });
    expect(at(k + 3)).toMatchObject({ input: { forward: 0 }, weapon: null });
    expect(at(k + 4)).toMatchObject({ input: { yaw: 33 }, weapon: null });
    expect(at(k + 400)).toMatchObject({ input: { yaw: 33 }, weapon: null });
  });

  it('switches weapons with the app’s slot keys (slot 4 cycles grenades)', () => {
    const carried = ['ak47', 'flash', 'knife', 'smoke', 'smoke'];
    expect(slotPresses('smoke', carried, 'ak47')).toEqual({ slot: 4, presses: 2 });
    expect(slotPresses('flash', carried, 'smoke')).toEqual({ slot: 4, presses: 1 });
    expect(slotPresses('knife', carried, 'ak47')).toEqual({ slot: 3, presses: 1 });
    expect(slotPresses('ak47', carried, 'ak47')).toEqual({ slot: 1, presses: 0 });
    expect(slotPresses('deagle', carried, 'ak47')).toBeNull();
    expect(slotPresses('he', carried, 'ak47')).toBeNull();
  });
});

describe('harness', () => {
  it('parses the CLI options', () => {
    expect(parseCliArgs([])).toEqual({ human: null, takeover: null, script: null, until: 'end', seed: 1, out: null, scenario: null, untilGiven: false });
    expect(parseCliArgs(['--human', 'cart', '--script', 'x.json', '--until', '20', '--seed', '7', '--out', 'o'])).toEqual({
      human: 'cart',
      takeover: null,
      script: 'x.json',
      until: 20,
      seed: 7,
      out: 'o',
      scenario: null,
      untilGiven: true,
    });
    expect(parseCliArgs(['--scenario', 's.json'])).toMatchObject({ scenario: 's.json', human: null, untilGiven: false });
    expect(() => parseCliArgs(['--scenario', 's.json', '--human', 'cart', '--script', 'x.json'])).toThrow(/exclude/);
    expect(() => parseCliArgs(['--script', 'x.json'])).toThrow(/needs --human/);
    expect(() => parseCliArgs(['--human', 'bob'])).toThrow(/--human/);
    expect(() => parseCliArgs(['--until', 'soon'])).toThrow(/--until/);
    expect(() => parseCliArgs(['--fast'])).toThrow(/unknown option/);
    // G4: --takeover is of cart unless --human names another pawn; not with --human none.
    expect(parseCliArgs(['--takeover', '18.6'])).toMatchObject({ human: 'cart', takeover: 18.6 });
    expect(parseCliArgs(['--human', 'donk', '--takeover', '5'])).toMatchObject({ human: 'donk', takeover: 5 });
    expect(optionsFromArgs(parseCliArgs(['--takeover', '18.6']))).toMatchObject({ human: 'cart', driver: null, takeover: 1190 });
    expect(optionsFromArgs(parseCliArgs(['--human', 'cart']))).toMatchObject({ human: 'cart', takeover: null });
    expect(() => parseCliArgs(['--human', 'none', '--takeover', '5'])).toThrow(/needs a human/);
    expect(() => parseCliArgs(['--takeover', '-1'])).toThrow(/--takeover/);
  });

  it('logDigest is SessionLog.digest (FNV-1a over UTF-8), also for non-ASCII text', () => {
    const log = new SessionLog();
    const o = { tick: 0, t: 0, pawns: [], events: [], human: null } as unknown as Observe;
    const act: Act = { inputs: [], actions: [{ type: 'log', level: 'info', text: 'Sp4rtaN défuse ✓ 🎯 \ud800' }], status: [] };
    log.append(o, act);
    log.append({ ...o, tick: 1 }, { ...act, actions: [] });
    expect(logDigest(log)).toBe(log.digest());
    expect(logDigest(log)).toBe(fnv1a32Hex(log.toText()));
  });

  it('runs through tick round(until × 64) inclusive and summarizes deterministically', () => {
    const a = runHarness(data, { human: null, driver: null, lastTick: 64, seed: DEFAULT_SEED });
    expect(a.ticks).toBe(65);
    expect(a.entries.map((e) => e.observe.tick)).toEqual([...Array(65).keys()]);
    const s = summarize(a);
    expect(s).toMatchObject({ ticks: 65, firstTick: 0, lastTick: 64, deaths: [{ tick: 32, victim: 'incredibad', attacker: 'snarlbot' }], snaps: [], bodyBlocks: [] });
    const b = runHarness(data, { human: null, driver: null, lastTick: 64, seed: DEFAULT_SEED });
    expect(stableStringify(summarize(b))).toBe(stableStringify(s));
    // The harness's Session is the app's: its log is what a bare Session logs.
    const plain = new Session({ ...data, seed: DEFAULT_SEED, human: null });
    for (let i = 0; i <= 64; i++) plain.step();
    expect(plain.log().digest()).toBe(a.log.digest());
  });
});

describe('fixtures/scripts', () => {
  it('cart-idle.json: cart stands still in Back Alley, facing his setup yaw; the Core skips his scripted damage', () => {
    const script = parseHumanScript(read('fixtures/scripts/cart-idle.json'));
    expect(script.entries).toHaveLength(1);
    const run = runHarness(data, { human: 'cart', driver: new ScriptDriver(script, 'cart'), lastTick: 20 * 64, seed: DEFAULT_SEED });
    const start = data.round.players.find((p) => p.id === 'cart')?.start.pos;
    const idx = run.entries[0]?.observe.pawns.findIndex((p) => p.id === 'cart') ?? -1;
    for (let k = 1; k < run.positions.length; k++) {
      const p = run.positions[k]?.[idx];
      expect(Math.hypot((p?.x ?? NaN) - (start?.x ?? NaN), (p?.y ?? NaN) - (start?.y ?? NaN)), `tick ${k}`).toBe(0);
    }
    expect(run.entries[1]?.observe.pawns[idx]?.yaw).toBe(startYaw(run.model, 'cart').yaw);
    // No input for the human pawn from the Core, and his scripted damage is skipped (lokier's 73 HP, his kill of Lokier).
    expect(run.entries.some((e) => e.act.inputs.some((q) => q.id === 'cart'))).toBe(false);
    const s = summarize(run, 'fixtures/scripts/cart-idle.json');
    expect(s.coreLogs.filter((l) => l.level === 'debug').map((l) => l.text)).toEqual([
      'script: no scripted damage lokier -> cart (73 hp at tick 1184): cart is the human',
      'script: no scripted damage cart -> lokier (lethal at tick 1203): cart is the human',
    ]);
    expect(s.deaths.map((d) => d.victim)).toEqual(['incredibad', 'snakelore', 'eradicate', 'snarlbot']);
    expect(s.modes.some((m) => m.everLive)).toBe(false);
  });

  it(`${FOLLOW_SCRIPT}: is the generator's output (first 20 s) and plays back byte for byte`, () => {
    const until = 20 * 64;
    const gen = generateFollowScript(data, until);
    const committed = parseHumanScript(read(FOLLOW_SCRIPT)).entries;
    const upTo = committed.filter((e) => Math.round(e.t * 64) <= until);
    expect(stableStringify(upTo), 'regenerate with npm run fixtures:update').toBe(stableStringify(gen.entries));
    expect(gen.entries.some((e) => e.yaw === 'track')).toBe(true);
    // cart's first smoke (B3's utility timing: smoke out at tick 226, thrown, the AK again at 307).
    expect(gen.entries.filter((e) => e.weapon !== null).map((e) => [Math.round(e.t * 64), e.weapon])).toEqual([
      [226, 'smoke'],
      [307, 'ak47'],
    ]);
    const played = playScript(data, read(FOLLOW_SCRIPT), until);
    expect(logDigest(played.log)).toBe(gen.digest);
    expect(played.warnings).toEqual([]);
    // He follows his recording without snapping: within 30 units RMS of his observed samples to 20 s (the 14.2 s jump
    // of 217 units in 0.3 s is the worst of it), and no teleport of cart.
    const cart = summarize(played).drift.find((r) => r.id === 'cart');
    expect(cart?.observedN).toBeGreaterThan(150);
    expect(cart?.observedRms).toBeLessThan(30);
    expect(played.snaps.filter((x) => x.id === 'cart')).toEqual([]);
  });
});
