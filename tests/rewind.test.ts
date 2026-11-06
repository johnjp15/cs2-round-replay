/**
 * B5 acceptance: checkpoints, rewind (exact and resync) and seek, through the app's Session with the real Core and
 * Sim2DHost (seed 1). Measured numbers are printed: `npx vitest run tests/rewind.test.ts --reporter=verbose`.
 *
 * - Exact (the host snapshots): run to 40 s, checkpoint, run to 60 s, rewind, run to 60 s again: the log from the
 *   checkpoint is byte-identical, with no human and with a scripted human (B4's human-bot) whose inputs after the
 *   rewind are the same; the whole round after it still has the golden digest.
 * - Resync (`capabilities.snapshot` forced off, as on a CS2 server): every recorded kill, the plant, the defuse and
 *   the round end land within ±2 ticks, nobody goes LIVE, the log replays; position drift is reported.
 * - Rewinding across a LIVE switch puts the pawn back in REPLAY (both paths).
 * - Seek forward and back equal straight runs.
 */
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, canonicalize, replay, type LogEntry, type PlayerId, type SessionLog, type Vec3 } from '../src/contracts/index';
import { autoCheckpointId, noteObserve, releaseWindowTicks, tickOf } from '../src/core/index';
import { Session, defaultCore, type SessionConfig } from '../src/app/session';
import { ROOT, loadHarnessData, logDigest, slotPresses, type HumanCommand, type HumanDriver } from '../tools/harness';
import { HumanBot, loadScenario } from '../tools/human-bot';

const data = loadHarnessData();
const GOLDEN_DIGEST = 'e6c2be70';
const END = 4516;

function session(extra: Partial<SessionConfig> = {}): Session {
  return new Session({ ...data, seed: 1, human: null, ...extra });
}

/**
 * Human commands by tick, recorded from a driver so a second pass can give exactly the same inputs; `teleport` is the
 * human-bot's engine-side scenario teleport (it moves the pawn through the host, outside HumanCommand).
 */
type Commands = Map<number, { readonly cmd: HumanCommand; readonly teleport: { readonly pos: Vec3; readonly yaw: number } | null }>;

/**
 * Step until the next step would be past `last` (inclusive). With a driver (or recorded commands), each tick first
 * applies the human's command the way the harness does (setHumanInput, weapon-slot presses), recording it.
 */
function runTo(s: Session, last: number, driver: HumanDriver | null = null, rec: Commands | null = null, play: Commands | null = null): void {
  while (s.tick <= last) {
    const k = s.tick;
    let cmd: HumanCommand | null = null;
    if (play !== null) {
      const e = play.get(k) ?? null;
      if (e !== null && e.teleport !== null && s.human !== null) s.host.apply({ inputs: [], actions: [{ type: 'teleport', id: s.human, pos: e.teleport.pos, yaw: e.teleport.yaw }], status: [] });
      cmd = e === null ? null : e.cmd;
    } else if (driver !== null && s.human !== null) {
      const before = s.pawnState(s.human)?.move;
      cmd = driver.command(k, s);
      const after = s.pawnState(s.human)?.move;
      const moved = before !== undefined && after !== undefined && (before.pos.x !== after.pos.x || before.pos.y !== after.pos.y || before.yaw !== after.yaw);
      rec?.set(k, { cmd, teleport: moved && after !== undefined ? { pos: after.pos, yaw: after.yaw } : null });
    }
    if (cmd !== null && s.human !== null) {
      if (cmd.input !== null) s.setHumanInput(cmd.input);
      if (cmd.weapon !== null) {
        const p = s.pawnState(s.human);
        const how = p === null || !p.alive ? null : slotPresses(cmd.weapon, p.inventory.map((q) => q.item), p.weapon);
        if (how !== null) for (let n = 0; n < how.presses; n++) s.requestWeaponSlot(how.slot);
      }
    }
    s.step();
  }
}

function entries(log: SessionLog, from = 0): LogEntry[] {
  const out: LogEntry[] = [];
  for (let i = from; i < log.length; i++) out.push(log.at(i) as LogEntry);
  return out;
}

/** Deaths, bomb events and round ends with their observe ticks. */
function outcomes(es: readonly LogEntry[]): { key: string; tick: number }[] {
  const out: { key: string; tick: number }[] = [];
  for (const e of es) {
    for (const ev of e.observe.events) {
      if (ev.type === 'death') out.push({ key: `death ${ev.attacker ?? 'world'} -> ${ev.victim}`, tick: e.observe.tick });
      if (ev.type === 'bomb') out.push({ key: `bomb ${ev.phase} ${ev.id ?? ''}`, tick: e.observe.tick });
      if (ev.type === 'round_end') out.push({ key: `round_end ${ev.winner} ${ev.reason}`, tick: e.observe.tick });
    }
  }
  return out;
}

function liveTicks(es: readonly LogEntry[]): { id: PlayerId; tick: number }[] {
  const out: { id: PlayerId; tick: number }[] = [];
  for (const e of es) for (const st of e.act.status) if (st.mode === 'LIVE' && st.sinceTick === e.observe.tick) out.push({ id: st.id, tick: e.observe.tick });
  return out;
}

/** Per pawn, RMS and max 2D distance between two runs over the lines from `from` where both have it alive. */
function drift(a: readonly LogEntry[], b: readonly LogEntry[]): Map<PlayerId, { rms: number; max: number; at: number }> {
  const acc = new Map<PlayerId, { sq: number; n: number; max: number; at: number }>();
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as LogEntry;
    const y = b[i] as LogEntry;
    expect(y.observe.tick).toBe(x.observe.tick);
    for (let j = 0; j < x.observe.pawns.length; j++) {
      const p = x.observe.pawns[j];
      const q = y.observe.pawns[j];
      if (p === undefined || q === undefined || !p.alive || !q.alive) continue;
      const d = Math.hypot(p.pos.x - q.pos.x, p.pos.y - q.pos.y);
      const m = acc.get(p.id) ?? { sq: 0, n: 0, max: 0, at: 0 };
      m.sq += d * d;
      m.n++;
      if (d > m.max) {
        m.max = d;
        m.at = x.observe.tick;
      }
      acc.set(p.id, m);
    }
  }
  const out = new Map<PlayerId, { rms: number; max: number; at: number }>();
  for (const id of PLAYER_IDS) {
    const m = acc.get(id);
    if (m !== undefined && m.n > 0) out.set(id, { rms: Math.sqrt(m.sq / m.n), max: m.max, at: m.at });
  }
  return out;
}

function driftText(d: Map<PlayerId, { rms: number; max: number; at: number }>): string {
  return [...d].map(([id, v]) => `${id} rms ${v.rms.toFixed(2)} max ${v.max.toFixed(2)} (t ${(v.at / 64).toFixed(2)})`).join('; ');
}

// The straight no-human round, tick by tick, checking the loadout ledger against the engine's inventories.
const straight = session();
let ledgerChecks = 0;
let ledgerInFlight = 0;
const ledgerProblems: string[] = [];
const window = releaseWindowTicks(data.tuning.grenades);
while (straight.tick <= END) {
  if (straight.tick >= 1) {
    const led = straight.core.loadouts();
    noteObserve(led, canonicalize(straight.observe()), window);
    const flying = straight.host.activeEffects().filter((e) => e.phase === 'flying');
    for (const id of PLAYER_IDS) {
      const h = straight.pawnState(id);
      if (h === null || !h.alive) continue;
      ledgerChecks++;
      const engine = h.inventory.filter((q) => q.item !== 'knife').map((q) => `${q.item}:${q.clip}/${q.reserve}`);
      const inFlight = flying.filter((e) => e.thrower === id).map((e) => `${e.kind}:0/0`);
      const ledger = (led.find((l) => l.id === id)?.items ?? []).map((q) => `${q.item}:${q.clip}/${q.reserve}`);
      if (inFlight.length > 0) ledgerInFlight++;
      const want = [...engine, ...inFlight].sort();
      if (want.join(' ') !== [...ledger].sort().join(' ')) ledgerProblems.push(`tick ${straight.tick} ${id}: engine [${engine.join(' ')}] + flying [${inFlight.join(' ')}] vs ledger [${ledger.join(' ')}]`);
    }
  }
  straight.step();
}
const straightEntries = entries(straight.log());

describe('loadout ledger (B5)', () => {
  it('equals every pawn’s engine inventory with ammo at every tick of the golden round, a grenade in flight included', () => {
    console.log(`[ledger] ${ledgerChecks} pawn-ticks checked, ${ledgerInFlight} with the pawn’s own grenade in flight (still in the ledger)`);
    expect(ledgerProblems.slice(0, 5)).toEqual([]);
    expect(ledgerChecks).toBeGreaterThan(20_000);
  });

  it('the straight run with automatic checkpoints is the golden master (checkpointing changes nothing)', () => {
    expect(logDigest(straight.log())).toBe(GOLDEN_DIGEST);
    // 0, 5, …, 70 s: 15 marks in the 4,517 ticks, under replay.checkpointMax (16).
    expect(straight.checkpoints.list().map((c) => c.tick)).toEqual(Array.from({ length: 15 }, (_, i) => i * 320));
    expect(straight.checkpoints.list().every((c) => c.auto && c.host !== null)).toBe(true);
  });
});

describe('checkpoints (B5)', () => {
  it('are taken every replay.checkpointSec, keep the last replay.checkpointMax, and stay small', () => {
    const s = straight.checkpoints;
    const size = s.jsonSize();
    const per = size.total / s.size;
    console.log(
      `[checkpoints] ${s.size} kept (max ${s.max}), JSON ${(size.total / 1024).toFixed(1)} K chars: core ${(size.core / 1024).toFixed(1)} K, host ${(size.host / 1024).toFixed(1)} K, observe ${(size.observe / 1024).toFixed(1)} K; ${(per / 1024).toFixed(1)} K per checkpoint`,
    );
    expect(s.max).toBe(data.tuning.replay.checkpointMax);
    expect(per).toBeLessThan(24 * 1024);
    expect(s.list()[0]?.id).toBe(autoCheckpointId(0));
    expect(s.get(autoCheckpointId(4480))?.logLength).toBe(4480);
  });

  it('flags a plant or defuse in progress as a resync hazard', () => {
    const at = (tick: number) => straight.checkpoints.get(autoCheckpointId(tick))?.hazards;
    expect(at(1600)).toEqual(['plant in progress (barely)']);
    expect(at(4160)).toEqual(['defuse in progress (sp4rtan)']);
    expect(at(1280)).toEqual([]);
    expect(at(3840)).toEqual([]);
  });
});

describe('exact rewind (host snapshot)', () => {
  it('no human: 40 s → 60 s → rewind to 40 s → 60 s gives the same log from the checkpoint, byte for byte; the round stays golden', () => {
    const s = session();
    runTo(s, 2559);
    const cp = s.checkpoint('cp40');
    expect([cp.tick, cp.logLength, cp.host !== null]).toEqual([2560, 2560, true]);
    runTo(s, 3840);
    const first = s.log().lines().slice(cp.logLength);
    s.rewind('cp40');
    expect([s.tick, s.log().length]).toEqual([2560, 2560]);
    expect(s.checkpoints.list().every((c) => c.tick <= 2560)).toBe(true);
    runTo(s, 3840);
    const second = s.log().lines().slice(cp.logLength);
    expect(second.length).toBe(first.length);
    expect(second.join('\n') === first.join('\n')).toBe(true);
    runTo(s, END);
    expect(logDigest(s.log())).toBe(GOLDEN_DIGEST);
  });

  it('scripted human (flank-sp4rtan), same inputs after the rewind: byte-identical; the LIVE sp4rtan and donk are REPLAY again', () => {
    const sc = loadScenario(`${ROOT}/fixtures/scenarios/flank-sp4rtan.json`);
    const s = session({ human: sc.human });
    const bot = HumanBot.fromScenario(data, sc);
    const rec: Commands = new Map();
    runTo(s, 2559, bot, rec);
    const cp = s.checkpoint('cp40');
    runTo(s, 3840, bot, rec);
    const first = s.log().lines().slice(cp.logLength);
    // By 60 s sp4rtan went LIVE (44.61 s) and died, donk went LIVE (53.34 s).
    expect([s.core.modeOf('sp4rtan'), s.core.modeOf('donk'), s.pawnState('donk')?.mode]).toEqual(['DEAD', 'LIVE', 'LIVE']);
    s.rewind('cp40');
    for (const id of ['sp4rtan', 'donk'] as const) {
      expect(s.core.modeOf(id)).toBe('REPLAY');
      expect(s.pawnState(id)).toMatchObject({ mode: 'REPLAY', alive: true, ai: null });
    }
    expect(s.host.blockedPairs()).toContainEqual({ attacker: 'sp4rtan', victim: 'donk' });
    runTo(s, 3840, null, null, rec);
    const second = s.log().lines().slice(cp.logLength);
    expect(second.length).toBe(first.length);
    expect(second.join('\n') === first.join('\n')).toBe(true);
  });
});

describe('resync rewind (no host snapshot, as in CS2)', () => {
  /** Run with snapshots off to `to`, rewind to the checkpoint for `cpTick`, run to the end; compare with the straight run. */
  function resyncRun(cpTick: number, to: number) {
    const s = session({ capabilities: { snapshot: false } });
    expect(s.capabilities).toEqual({ snapshot: false, seek: true, speed: true });
    runTo(s, to);
    const cp = s.checkpointFor(cpTick);
    if (cp === null) throw new Error('no checkpoint');
    expect(cp.host).toBeNull();
    s.rewind(cp.id);
    // The engine is still at `to`; the session already reports the checkpoint, and the next step resyncs.
    expect(s.host.observe().tick).toBe(to + 1);
    expect([s.tick, s.observe().tick, s.log().length]).toEqual([cp.tick, cp.tick, cp.logLength]);
    runTo(s, END);
    const es = entries(s.log());
    return { s, cp, es, line: es[cp.logLength] as LogEntry };
  }

  function expectOnTape(es: readonly LogEntry[], from: number, label: string): void {
    const want = outcomes(straightEntries).filter((x) => x.tick >= from);
    const got = outcomes(es).filter((x) => x.tick >= from);
    expect(got.map((x) => x.key)).toEqual(want.map((x) => x.key));
    const worst = Math.max(0, ...got.map((x, i) => Math.abs(x.tick - (want[i]?.tick ?? 0))));
    console.log(`[resync ${label}] ${got.length} kills / bomb events / round end after the checkpoint, worst |Δ| ${worst} ticks`);
    expect(worst).toBeLessThanOrEqual(2);
    expect(liveTicks(es)).toEqual([]);
    expect(es.every((e) => e.act.status.every((st) => st.mode !== 'LIVE'))).toBe(true);
  }

  it('60 s → back to 40 s: kills, defuse and round end on the recorded ticks (±2), nobody LIVE, the log replays; drift reported', () => {
    const { s, cp, es, line } = resyncRun(2560, 3840);
    expect(cp.id).toBe(autoCheckpointId(2560));
    // The resync line: the checkpoint's observe again, `rewind` logged, the Act starting with the resync.
    expect(line.observe).toEqual(cp.observe);
    expect(line.controls).toEqual([{ type: 'rewind', id: cp.id }]);
    expect(line.act.actions[0]).toEqual({ type: 'set_round', tick: 2560, round: cp.observe.round });
    const types = new Set(line.act.actions.map((a) => a.type));
    for (const t of ['set_hp', 'teleport', 'strip', 'give', 'set_weapon', 'set_mode', 'block_damage', 'log']) expect(types.has(t as never)).toBe(true);
    // donk and barely died after 40 s and are alive again with their checkpoint HP.
    const after = es[cp.logLength + 1] as LogEntry;
    for (const id of ['donk', 'barely', 'sp4rtan'] as const) {
      const p = after.observe.pawns.find((q) => q.id === id);
      const c = cp.observe.pawns.find((q) => q.id === id);
      expect([p?.alive, p?.hp, p?.weapon]).toEqual([true, c?.hp, c?.weapon]);
    }
    expectOnTape(es, 2560, '40 s');
    const d = drift(straightEntries.slice(cp.logLength), es.slice(cp.logLength));
    console.log(`[resync 40 s] drift against the straight run: ${driftText(d)}`);
    for (const v of d.values()) expect(v.max).toBeLessThan(48);
    const r = replay(s.log(), defaultCore({ model: s.model, schedule: s.schedule, tuning: s.tuning, seed: 1, nav: s.nav }));
    expect([r.identical, r.mismatchCount]).toEqual([true, 0]);
    expect(s.hostNotes()).toEqual([]);
  });

  it('across the plant (30 s → 20 s; the 25 s checkpoint is mid-plant and skipped) and across the defuse and round end (70 s → 60 s)', () => {
    const a = resyncRun(1700, 1920);
    expect(a.cp.id).toBe(autoCheckpointId(1280));
    expectOnTape(a.es, 1280, '20 s');
    console.log(`[resync 20 s] drift: ${driftText(drift(straightEntries.slice(a.cp.logLength), a.es.slice(a.cp.logLength)))}`);
    const b = resyncRun(4400, 4480);
    expect(b.cp.id).toBe(autoCheckpointId(3840));
    expectOnTape(b.es, 3840, '60 s');
    console.log(`[resync 60 s] drift: ${driftText(drift(straightEntries.slice(b.cp.logLength), b.es.slice(b.cp.logLength)))}`);
    // The round had ended (CT defuse) and the score counted it; the resync took both back, and they came again.
    expect(b.line.act.actions[0]).toMatchObject({ type: 'set_round', tick: 3840, round: { phase: 'planted', winner: null, score: { ct: 11, t: 15 } } });
    expect(b.es.at(-1)?.observe.round).toMatchObject({ winner: 'CT', reason: 'bomb_defused', score: { ct: 12, t: 15 } });
  });

  it('across a LIVE switch (never-peeks): Lokier and barely are REPLAY again, blocked again, and switch again on time', () => {
    const sc = loadScenario(`${ROOT}/fixtures/scenarios/never-peeks.json`);
    const s = session({ human: sc.human, capabilities: { snapshot: false } });
    const rec: Commands = new Map();
    runTo(s, 1472, HumanBot.fromScenario(data, sc), rec);
    const firstSwitches = liveTicks(entries(s.log(), 1280));
    expect(firstSwitches.map((x) => x.id)).toEqual(['lokier', 'barely']);
    expect([s.core.modeOf('lokier'), s.core.modeOf('barely'), s.pawnState('barely')?.mode]).toEqual(['DEAD', 'LIVE', 'LIVE']);
    const cp = s.rewind(autoCheckpointId(1280));
    runTo(s, cp.tick, null, null, rec);
    for (const id of ['lokier', 'barely'] as const) {
      expect(s.core.modeOf(id)).toBe('REPLAY');
      expect(s.pawnState(id)).toMatchObject({ mode: 'REPLAY', alive: true, ai: null });
    }
    expect(s.pawnState('lokier')?.hp).toBe(100);
    const blocked = s.host.blockedPairs();
    for (const pair of [
      { attacker: 'lokier', victim: 'barely' },
      { attacker: 'barely', victim: 'lokier' },
      { attacker: 'barely', victim: 'barely' },
      { attacker: 'lokier', victim: 'lokier' },
    ]) {
      expect(blocked).toContainEqual(pair);
    }
    expect(blocked.some((b) => b.attacker === 'cart' || b.victim === 'cart')).toBe(false);
    runTo(s, 1472, null, null, rec);
    // The same two switches on the same ticks (±2). What follows is a fight of the LIVE AI, whose memory and random
    // draws a resync can't put back (CS2 can't either): it may go another way.
    const again = liveTicks(entries(s.log(), 1280));
    expect(again.slice(0, 2).map((x) => x.id)).toEqual(['lokier', 'barely']);
    again.slice(0, 2).forEach((x, i) => expect(Math.abs(x.tick - (firstSwitches[i]?.tick ?? 0))).toBeLessThanOrEqual(2));
    console.log(`[resync switch] LIVE again: ${again.map((x) => `${x.id} ${x.tick}`).join(', ')} (first run: ${firstSwitches.map((x) => `${x.id} ${x.tick}`).join(', ')})`);
  });
});

describe('seek (B5)', () => {
  it('forward from the start equals a straight run (no human)', () => {
    const s = session();
    const p = s.seek(30);
    expect(p).toMatchObject({ from: 0, start: 0, target: 1920, tick: 1920, done: true, rewound: null });
    expect(s.log().lines().join('\n') === straight.log().lines().slice(0, 1920).join('\n')).toBe(true);
  });

  it('back then forward replays the human’s own inputs: both land on the straight run, byte for byte (lokier-late)', () => {
    const sc = loadScenario(`${ROOT}/fixtures/scenarios/lokier-late.json`);
    const s = session({ human: sc.human });
    runTo(s, 3199, HumanBot.fromScenario(data, sc));
    const ref = s.log().lines();
    const back = s.seek(33);
    expect(back).toMatchObject({ from: 3200, start: 1920, target: tickOf(33), rewound: autoCheckpointId(1920), done: true });
    expect(s.log().lines().join('\n') === ref.slice(0, tickOf(33)).join('\n')).toBe(true);
    const fwd = s.seek(45);
    expect(fwd).toMatchObject({ target: 2880, done: true, rewound: null });
    expect(s.log().lines().join('\n') === ref.slice(0, 2880).join('\n')).toBe(true);
    // Chunked as the app does it (a few ticks per frame): the same.
    s.beginSeek(20.5);
    let frames = 0;
    while (s.seeking !== null) {
      s.advanceSeek(8);
      frames++;
    }
    expect(frames).toBeGreaterThan(1);
    expect(s.log().lines().join('\n') === ref.slice(0, tickOf(20.5)).join('\n')).toBe(true);
    expect(() => s.advanceSeek(1)).toThrow(/no seek/);
  });

  it('without the seek capability: no seeking ahead, and a seek back stops at the checkpoint', () => {
    const s = session({ capabilities: { snapshot: false, seek: false, speed: false } });
    expect(() => s.seek(5)).toThrow(/real time/);
    expect(() => s.control({ type: 'speed', x: 2 })).toThrow(/real time/);
    runTo(s, 800);
    const p = s.seek(7);
    expect(p).toMatchObject({ rewound: autoCheckpointId(320), tick: 320, target: 320, done: true });
  });
});
