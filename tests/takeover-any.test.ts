/**
 * U2: take control of any player (docs/core.md "Takeover", docs/app3d.md "Keys"). John: "Allow us to take control of
 * any player that you're spectating. But keep a handy hotkey for always taking control of cart."
 *
 * - The Core plans every player's scheduled encounters and recorded duels (cart's first, keyed as before), so the rules
 *   that applied to cart apply to whoever the human is: nothing scripted for his pawn (no inputs, shots, throws, plant,
 *   defuse, no scripted damage to or from him), his recorded duels resolve like the tape, a pawn the tape kills later
 *   plays on while the human keeps him alive.
 * - Takeovers of eradicate (T) at 5 s and Lokier (CT) at 10 s in both hosts, standing still from the takeover: the
 *   first T lines are the no-human run's, the human gets no Core input and fires nothing, his recorded death doesn't
 *   come from the script, the round still ends.
 * - Checkpoints and rewind / seek with a non-cart human (exact and resync); a human CT defuses, a human T plants.
 * - The Session's rules (any alive pawn; dead refused) and the app's DOM-free parts (buttons, panel hints, the take-cart key).
 * Seed 1, the real Core with Sim2DHost and Sim3DHost.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { replay, type LogEntry, type PawnInput, type PlayerId, type SessionLog } from '../src/contracts/index';
import { ReplayCore, tickOf } from '../src/core/index';
import { Session, defaultCore, walkQueryOf, type SessionConfig } from '../src/app/index';
import { DEFAULT_KEY_BINDS } from '../src/app/input';
import { DEFAULT_PAGE_KEYS, PAGE_KEYS_STORAGE_KEY, PageKeysStore, canBindPageKey, parsePageKeys, type KeyValueStorage } from '../src/app/keybinds';
import { TAKE_CART_KEY, spectatedTakeoverView, takeoverButtonView } from '../src/app/takeover';
import { spectatePanel } from '../src/app3d/spectate';
import { GOLDEN_DIR, gunzipText, readManifest } from '../tools/golden-fixtures';
import { ROOT, coreLogs, deaths, loadHarnessData, runHarness, type HarnessRun } from '../tools/harness';
import { loadHarness3dData, runHarness3d } from '../tools/harness3d';

const data = loadHarnessData();
const GOLDEN = readManifest()?.fixtures.find((f) => f.name === 'round-nohuman');
const goldenLines = gunzipText(readFileSync(resolve(ROOT, GOLDEN_DIR, GOLDEN?.file ?? 'round-nohuman.jsonl.gz')))
  .split('\n')
  .filter((l) => l !== '');

const ERADICATE_AT = tickOf(5);
const LOKIER_AT = tickOf(10);
/** The tape: Lokier kills eradicate at 12.75 s (SSG 08), cart kills Lokier at 18.80 s. */
const ERADICATE_DIES = 816;
const LOKIER_DIES = 1203;

function entries(log: SessionLog): LogEntry[] {
  const out: LogEntry[] = [];
  for (let i = 0; i < log.length; i++) out.push(log.at(i) as LogEntry);
  return out;
}

/** What a takeover run must show for its human `id` from tick `at` on. */
function checkTakeover(r: HarnessRun, id: PlayerId, at: number, recordedDeath: number, noHuman: readonly string[]): void {
  const lines = r.log.lines();
  // Invisible before the takeover: the no-human run's lines.
  expect(lines.slice(0, at)).toEqual(noHuman.slice(0, at));
  expect(r.entries[at - 1]?.observe.human).toBeNull();
  expect(r.entries[at]?.observe.human).toBe(id);
  expect(coreLogs(r.entries).filter((l) => l.text.startsWith('takeover: ')).map((l) => l.text.split(' (')[0])).toEqual([`takeover: ${id} is the human from tick ${at}`]);
  const after = r.entries.filter((e) => e.observe.tick >= at);
  // Nothing scripted for him: no Core input, no scripted damage to or from him, no plant / defuse / weapon for him.
  expect(after.some((e) => e.act.inputs.some((i) => i.id === id))).toBe(false);
  expect(after.some((e) => e.act.actions.some((a) => a.type === 'damage' && (a.attacker === id || a.victim === id)))).toBe(false);
  expect(after.some((e) => e.act.actions.some((a) => (a.type === 'set_weapon' || a.type === 'give') && a.id === id))).toBe(false);
  // His scripted shots are not auto-fired (he stands still with no input: he fires nothing at all).
  expect(after.some((e) => e.observe.events.some((ev) => ev.type === 'shot' && ev.shooter === id))).toBe(false);
  // His recorded death is not the script's (no scripted damage on him, above): whatever kills him is the engine's.
  expect(deaths(r.entries).some((d) => d.victim === id && d.tick === recordedDeath && d.attacker !== null && r.entries.some((e) => e.act.actions.some((a) => a.type === 'damage' && a.victim === id)))).toBe(false);
  // Status HUMAN while he lives.
  expect(r.entries[at]?.act.status.find((s) => s.id === id)?.mode).toBe('HUMAN');
  // The round still ends.
  expect(r.entries.some((e) => e.observe.events.some((ev) => ev.type === 'round_end'))).toBe(true);
}

describe('the Core plans every player’s encounters and duels (U2)', () => {
  it('cart’s come first with the keys they had; the others follow in id order, inactive until that player is the human', () => {
    const golden = runHarness(data, { human: null, driver: null, lastTick: 0, seed: 1 });
    const core = new ReplayCore(golden.model, golden.session.schedule, data.tuning, 1, walkQueryOf(data));
    expect(core.divergence.encounters.map((e) => `${e.key} ${e.shooter}>${e.victim}`)).toEqual(['enc:0 lokier>cart', 'enc:donk:0 sp4rtan>donk', 'enc:donk:1 sp4rtan>donk', 'enc:donk:2 sp4rtan>donk']);
    const duels = core.duels.duels.map((d) => `${d.key} ${d.shooter}>${d.target}`);
    expect(duels.slice(0, 3)).toEqual(['duel:0 cart>lokier', 'duel:1 cart>sp4rtan', 'duel:2 cart>sp4rtan']);
    expect(duels).toContain('duel:lokier:1 lokier>cart');
    expect(duels).toContain('duel:sp4rtan:3 sp4rtan>cart');
    // Snapshots from before U2 (only cart's states) restore: the others start afresh.
    const snap = core.snapshot();
    const d = snap.data as unknown as { divergence: { encounters: { key: string }[] }; duels: { key: string }[] };
    d.divergence.encounters = d.divergence.encounters.filter((e) => e.key === 'enc:0');
    d.duels = d.duels.filter((x) => !x.key.includes(':', 5));
    core.restore(snap);
    expect(core.divergence.state.encounters.map((e) => e.phase)).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
  });
});

describe('takeovers of eradicate (T, 5 s) and Lokier (CT, 10 s): Sim2DHost', () => {
  it('eradicate: invisible before 5 s, nothing scripted for him after, the tape’s 12.75 s kill on him doesn’t happen, the round ends', () => {
    const r = runHarness(data, { human: 'eradicate', driver: null, lastTick: 'end', seed: 1, takeover: ERADICATE_AT });
    checkTakeover(r, 'eradicate', ERADICATE_AT, ERADICATE_DIES, goldenLines);
    expect(deaths(r.entries).some((d) => d.victim === 'eradicate' && d.tick === ERADICATE_DIES)).toBe(false);
    // Lokier's recorded duel on him is not his (his own duels are), so nothing blocks Lokier's real bullets.
    expect(coreLogs(r.entries).some((l) => l.text.startsWith('duel lokier'))).toBe(false);
  }, 300_000);

  it('Lokier: invisible before 10 s, nothing scripted for him after, cart’s scripted 18.80 s kill doesn’t come, the round ends', () => {
    const r = runHarness(data, { human: 'lokier', driver: null, lastTick: 'end', seed: 1, takeover: LOKIER_AT });
    checkTakeover(r, 'lokier', LOKIER_AT, LOKIER_DIES, goldenLines);
    const core = defaultCore({ model: r.session.model, schedule: r.session.schedule, tuning: r.session.tuning, seed: 1, nav: r.session.nav, geometry: r.session.geometry });
    expect(replay(r.log, core)).toMatchObject({ identical: true, mismatchCount: 0 });
  }, 300_000);
});

describe('takeovers of eradicate (T, 5 s) and Lokier (CT, 10 s): Sim3DHost', () => {
  const data3 = loadHarness3dData();
  const noHuman3 = runHarness3d(data3, { human: null, driver: null, lastTick: LOKIER_AT, seed: 1 }).log.lines();

  it('eradicate', () => {
    const r = runHarness3d(data3, { human: 'eradicate', driver: null, lastTick: 'end', seed: 1, takeover: ERADICATE_AT });
    checkTakeover(r, 'eradicate', ERADICATE_AT, ERADICATE_DIES, noHuman3);
    expect(deaths(r.entries).some((d) => d.victim === 'eradicate' && d.tick === ERADICATE_DIES)).toBe(false);
  }, 300_000);

  it('Lokier', () => {
    const r = runHarness3d(data3, { human: 'lokier', driver: null, lastTick: 'end', seed: 1, takeover: LOKIER_AT });
    checkTakeover(r, 'lokier', LOKIER_AT, LOKIER_DIES, noHuman3);
  }, 300_000);
});

describe('checkpoints and rewind with a non-cart human (U2)', () => {
  const session = (extra: Partial<SessionConfig> = {}): Session => new Session({ ...data, seed: 1, human: null, ...extra });
  const inputAt = (k: number): PawnInput => ({ id: 'eradicate', forward: 1, side: k % 128 < 64 ? 0.5 : -0.5, yaw: 90 + (k % 360), pitch: 0, buttons: [] });
  const runTo = (s: Session, last: number): void => {
    while (s.tick <= last) {
      if (s.human !== null && s.tick % 64 === 0) s.setHumanInput(inputAt(s.tick));
      s.step();
    }
  };
  const LAST = tickOf(9);

  it('exact: a rewind before the takeover watches again; a forward seek replays the takeover of eradicate and his inputs byte for byte', () => {
    const s = session();
    runTo(s, ERADICATE_AT - 1);
    s.takeControl('eradicate');
    runTo(s, LAST);
    const first = s.log().lines();
    const cp = s.checkpointFor(ERADICATE_AT - 1);
    expect(cp).not.toBeNull();
    s.rewind(cp?.id ?? '');
    expect(s.human).toBeNull();
    s.seek((LAST + 1) / 64);
    expect([s.human, s.takeoverTick]).toEqual(['eradicate', ERADICATE_AT]);
    expect(s.log().lines()).toEqual(first);
    // A snapshot with eradicate as the human restores into a watching session.
    const snap = s.snapshot();
    const t = session();
    t.restore(snap);
    expect([t.human, t.takeoverTick]).toEqual(['eradicate', ERADICATE_AT]);
    // Restricted to cart, it doesn't.
    expect(() => session({ takeable: ['cart'] }).restore(snap)).toThrow(/takeable: cart/);
  }, 300_000);

  it('resync (no host snapshot, as in CS2): back before the takeover eradicate is a REPLAY puppet again; the seek replays the takeover', () => {
    const s = session({ capabilities: { snapshot: false } });
    runTo(s, ERADICATE_AT - 1);
    s.takeControl('eradicate');
    runTo(s, tickOf(7));
    const cp = s.checkpointFor(ERADICATE_AT - 1);
    const back = s.rewind(cp?.id ?? '');
    expect(s.human).toBeNull();
    s.seek(tickOf(7) / 64);
    expect((s.log().at(back.tick) as LogEntry).act.actions).toContainEqual({ type: 'set_mode', id: 'eradicate', mode: 'REPLAY', goal: null });
    expect([s.human, s.takeoverTick]).toEqual(['eradicate', ERADICATE_AT]);
  }, 300_000);
});

describe('a human CT defuses, a human T plants (U2)', () => {
  const play = (id: PlayerId, at: number, buttons: PawnInput['buttons'], until: number): LogEntry[] => {
    const s = new Session({ ...data, seed: 1, human: null });
    while (s.tick < at) s.step();
    const p = s.observe().pawns.find((q) => q.id === id);
    s.takeControl(id);
    s.setHumanInput({ id, forward: 0, side: 0, yaw: p?.yaw ?? 0, pitch: 0, buttons });
    while (s.tick <= until) s.step();
    return entries(s.log());
  };
  const bombs = (es: readonly LogEntry[]): string[] => es.flatMap((e) => e.observe.events.filter((ev) => ev.type === 'bomb').map((ev) => `${e.observe.tick} ${ev.phase} ${ev.id ?? '-'}`));

  it('sp4rtan taken over at the bomb (61.72 s) holding USE defuses it himself (the Core sends no defuse), and the CTs win', () => {
    const es = play('sp4rtan', 3950, ['USE'], 4300);
    expect(bombs(es)).toEqual(['1761 planted barely', '3951 defuse_start sp4rtan', '4271 defused sp4rtan']);
    expect(es.some((e) => e.act.actions.some((a) => a.type === 'defuse_start'))).toBe(false);
    expect(es.some((e) => e.observe.events.some((ev) => ev.type === 'round_end' && ev.winner === 'CT' && ev.reason === 'bomb_defused'))).toBe(true);
  }, 300_000);

  it('barely taken over mid-plant (27.19 s): holding USE he plants; letting go, the Core doesn’t plant for him', () => {
    expect(bombs(play('barely', 1740, ['USE'], 1800))).toEqual(['1761 planted barely']);
    const idle = play('barely', 1740, [], 2000);
    expect(bombs(idle)).toEqual([]);
    expect(idle.some((e) => e.act.actions.some((a) => a.type === 'plant'))).toBe(false);
  }, 300_000);
});

describe('the Session’s rules for any player (U2)', () => {
  it('any alive pawn of either team; dead refused; cart stays the default', () => {
    const s = new Session({ ...data, seed: 1, human: null });
    expect([s.playable, s.takeable.length]).toEqual(['cart', 10]);
    for (const id of ['eradicate', 'lokier', 'sp4rtan'] as const) expect(s.takeControlBlocked(id)).toBeNull();
    while (s.tick <= 40) s.step();
    // snarlbot killed incredibad at 0.50 s.
    expect(s.takeControlBlocked('incredibad')).toBe('incredibad is dead');
    expect(() => s.takeControl('incredibad')).toThrow(/dead/);
    expect(s.canTakeControlOf('lokier')).toBe(true);
    s.takeControl('lokier');
    expect(s.human).toBe('lokier');
    expect(s.takeControlBlocked('cart')).toBe('lokier is already controlled');
    expect(new Session({ ...data, seed: 1, human: null, playable: null }).takeable).toEqual([]);
  }, 120_000);
});

describe('the app’s takeover UI for any player (U2)', () => {
  it('the cart button shows its key (C); the spectated player’s button follows him and hides on cart or once someone plays', () => {
    expect(TAKE_CART_KEY).toBe('KeyC');
    expect(takeoverButtonView(null, 'cart', null, false, false, 'C')).toMatchObject({ label: 'Take control of cart', title: 'Play cart from this moment on (C).' });
    expect(spectatedTakeoverView(null, 'eradicate', 'cart', null, false, false)).toEqual({ label: 'Take control of eradicate', disabled: false, pressed: false, key: true, title: 'Play eradicate from this moment on (E).', hidden: false });
    expect(spectatedTakeoverView(null, 'incredibad', 'cart', 'incredibad is dead', false, false)).toMatchObject({ label: 'Take control of incredibad', disabled: true, title: 'Not now: incredibad is dead.', hidden: false });
    expect(spectatedTakeoverView(null, 'cart', 'cart', null, false, false).hidden).toBe(true);
    expect(spectatedTakeoverView('lokier', 'lokier', 'cart', 'lokier is already controlled', false, false).hidden).toBe(true);
    expect(takeoverButtonView('lokier', 'cart', 'lokier is already controlled', false, false, 'C')).toMatchObject({ label: 'You: lokier', pressed: true });
  });

  it('the spectator panel hints E on the spectated player and C for cart', () => {
    const p = { id: 'lokier', team: 'CT', alive: true, hp: 100, armor: 100, pos: { x: 0, y: 0, z: 0 }, sees: [] } as never;
    expect(spectatePanel(p, 0, 'pov', 'SSG 08', true, { use: 'E', cart: 'C' })?.hints).toBe('Mouse 1 / 2 switch player · V mode · E take control of lokier · C take cart');
  });

  it('the take-cart key: C by default, rebindable to a free key, never Use, Jump, a fixed or a page key; stored apart from the pawn binds', () => {
    expect(DEFAULT_PAGE_KEYS.takeCart).toBe('KeyC');
    expect(canBindPageKey('KeyC', DEFAULT_KEY_BINDS)).toBe(true);
    expect(canBindPageKey('KeyN', DEFAULT_KEY_BINDS)).toBe(true);
    for (const k of ['KeyE', 'Space', 'KeyW', 'KeyV', 'KeyP', 'Escape', 'ShiftLeft', 'Digit1']) expect(canBindPageKey(k, DEFAULT_KEY_BINDS), k).toBe(false);
    expect(parsePageKeys({ takeCart: 'KeyE' })).toEqual(DEFAULT_PAGE_KEYS);
    expect(parsePageKeys({ takeCart: 'KeyN' })).toEqual({ takeCart: 'KeyN' });
    const m = new Map<string, string>();
    const storage: KeyValueStorage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
    const store = new PageKeysStore(storage);
    expect(store.setTakeCart('KeyE')).toBe(false);
    expect(store.setTakeCart('KeyN')).toBe(true);
    expect(m.get(PAGE_KEYS_STORAGE_KEY)).toBe('{"takeCart":"KeyN"}');
    expect(new PageKeysStore(storage).keys.takeCart).toBe('KeyN');
    store.reset();
    expect(m.has(PAGE_KEYS_STORAGE_KEY)).toBe(false);
  });
});
