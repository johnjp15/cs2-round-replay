/**
 * The golden master (CI gate, docs/golden.md): the headless harness (tools/harness.ts, the browser app's Session)
 * plays the whole recorded round with no human: ReplayCore (B1 round model, B2 puppets, B3 scripted events) drives
 * all ten pawns in Sim2DHost (C2 combat, C3 bomb, round rules and collision). The recording must come out: kills,
 * HP, shots, plant, defuse, round end and score, each within a tick; the paths within the drift bounds; snaps only
 * at B2's teleport points; no LIVE pawn, fallback or body block; and the log must replay through a fresh Core and
 * equal the committed fixture (fixtures/golden/round-nohuman.jsonl.gz) byte for byte.
 *
 * This file merges B2's tests/ghost-round.test.ts and B3's tests/scripted-round.test.ts (one run instead of three).
 * Run with `--reporter=verbose` to see the tables (also `npm run scripted`, `npm run ghost`, `npm run harness`).
 */
import { describe, expect, it } from 'vitest';
import { DISPLAY_IDS, PLAYER_IDS, replay, toReplayTrace, type PlayerId } from '../src/contracts/index';
import { EventSchedule } from '../src/core/index';
import { defaultCore } from '../src/app/index';
import { DEFAULT_SEED, NO_HUMAN, loadHarnessData, logDigest, measureDrift, modeChanges, runHarness, summarize } from '../tools/harness';
import { trackEventsReport, ghostTable } from '../tools/ghost-round';
import {
  actionsOfType,
  buttonSpans,
  coreLogs,
  deaths,
  hpChanges,
  hpTable,
  killTable,
  matchShots,
  measureLatency,
  roundEvents,
  shotTable,
  shots,
} from '../tools/scripted-round';
import { readManifest } from '../tools/golden-fixtures';

const data = loadHarnessData();
const run = runHarness(data, NO_HUMAN);
const entries = run.entries;
const plan = run.core.script.plan;
const schedule = new EventSchedule(data.round);
const rows = measureDrift(run);

// The kill table of the round (t, killer -> victim, weapon, headshot), copied here on purpose.
const KILLS: [number, PlayerId, PlayerId, string, boolean][] = [
  [0.5, 'snarlbot', 'incredibad', 'ak47', false],
  [12.4, 'snarlbot', 'snakelore', 'ak47', false],
  [12.75, 'lokier', 'eradicate', 'ssg08', true],
  [17.85, 'sp4rtan', 'snarlbot', 'deagle', false],
  [18.8, 'cart', 'lokier', 'ak47', true],
  [44.2, 'barely', 'zwomp', 'ak47', false],
  [50.35, 'sp4rtan', 'donk', 'ak47', false],
  [58.85, 'sp4rtan', 'barely', 'ak47', true],
  [69.4, 'sp4rtan', 'cart', 'ak47', false], // post-round
];

// B2's snaps (docs/core.md "Puppets", Snaps table): pawn and tick, copied here on purpose. G3 (3D on CS2 Mirage, the
// snapped tracks of data/geometry/mirage-tracks.json): 9 instead of main's 6 (cart 922, donk 923, sp4rtan 1165 and
// 1248, cart 1350, barely 2879). docs/core.md "Snaps on CS2 Mirage" has each one's cause. T1: barely's 2299 and 2880
// are gone (his 35.1–44.7 s level flip onto the underpass is put back on Catwalk: snap-tracks' `levelFlips`).
// X1d: on the default package (mirage-2020, the BSP the round was played on) 8; the mirage-cs2 list was snarlbot 633,
// cart 920, sp4rtan 1171 / 1229 / 1245, donk 1344, cart 1392 (docs/maps.md "The round on it").
const SNAPS: [PlayerId, number][] = [
  ['snarlbot', 333], // new on 2020: his 5.1 s recording gap at T spawn ends at a player-clip edge (CS2's 633, the T-ramp floor, is gone: the 2020 floor is there)
  ['cart', 920], // main's cart 922: the recording's own discontinuity (909–922)
  ['donk', 921], // new on 2020: donk lags his 13.4–14.4 s samples on the 2020 mesh (docs/maps.md)
  ['sp4rtan', 1169], // main's sp4rtan 1165 (CS2 1171): the recording's spike (inferred CT positions, 1146–1165)
  ['sp4rtan', 1229], // main's sp4rtan 1248: the same inferred 700 u/s stretch, split in two by the snapping
  ['sp4rtan', 1245],
  ['donk', 1344], // Apartments: the track climbs the floor step in one go (a jump would do), as on CS2
  ['cart', 1395], // main's cart 1350 (CS2 1392): the recording's discontinuity (1344–1350), off the window duel's track
  // T2 (backlog 46, #61): main's cart 1880 and 4114 (the way into and out of Shop through a 2020 doorway CS2 hasn't,
  // one-tick jumps along the Market window line) are gone: snap-tracks' WAYS_ROUND climbs him in through the window at
  // 28.4 s (a jump onto the sill) and walks him out by the Shop door at 64.5 s.
];

describe('golden master: the run', () => {
  it('prints the tables (run with --reporter=verbose)', () => {
    console.log(`[golden] ${run.ticks} ticks, ${run.snaps.length} snap(s), digest ${run.log.digest()}, ${run.ms.ticks.toFixed(0)} ms for the ticks`);
    console.log(`${ghostTable(rows)}\n\n${trackEventsReport(run.core)}`);
    console.log(`${killTable(run)}\n\n${hpTable(run)}\n\n${shotTable(run)}`);
    expect(rows.map((r) => r.id)).toEqual([...PLAYER_IDS]);
    expect(run.ticks).toBeGreaterThan(4442);
    expect(run.ticks).toBe(4517);
  });

  it('equals the committed fixture byte for byte (else: npm run fixtures:update, and explain the diff)', () => {
    const f = readManifest()?.fixtures.find((x) => x.name === 'round-nohuman');
    expect(f, 'fixtures/golden/manifest.json has round-nohuman').toBeDefined();
    expect({ digest: logDigest(run.log), ticks: run.ticks }).toEqual({ digest: f?.digest, ticks: f?.ticks });
    expect(logDigest(run.log)).toBe(run.log.digest());
  });

  it('replays identically through a fresh Core (the app’s defaultCore, same seed)', () => {
    const core = defaultCore({ model: run.model, schedule: run.session.schedule, tuning: data.tuning, seed: DEFAULT_SEED, nav: data.nav, geometry: data.geometry ?? null });
    expect(replay(run.log, core)).toMatchObject({ identical: true, mismatchCount: 0, ticks: run.ticks });
  });

  it('converts to a replay-page trace with all ten tracks', () => {
    const trace = toReplayTrace(run.log);
    // A trace track ends at the pawn's death (B3 kills everyone but sp4rtan on the recorded tick).
    for (const id of PLAYER_IDS) {
      const p = data.round.players.find((q) => q.id === id);
      const end = Math.min(p?.deathT ?? Infinity, data.round.tracks[id]?.endT ?? 0);
      expect(trace.tracks[DISPLAY_IDS[id]]?.length, id).toBeGreaterThanOrEqual(Math.floor(end * 10));
    }
    expect(trace.events.filter((e) => e.kind === 'info' && e.text.startsWith('puppet '))).toHaveLength(run.snaps.length);
  });
});

describe('golden master: movement (B2)', () => {
  it('every T stays within 24 units RMS of its observed samples', () => {
    for (const r of rows.filter((q) => q.team === 'T')) {
      expect(r.observed.samples, r.id).toBeGreaterThan(0);
      expect(r.observed.rms, r.id).toBeLessThan(24);
    }
  });

  it("every CT's inferred samples are within that player's (smallest) uncertainty radius, RMS", () => {
    for (const r of rows.filter((q) => q.team === 'CT')) {
      expect(r.inferred.samples, r.id).toBeGreaterThan(0);
      expect(r.radiusMin, r.id).not.toBeNull();
      expect(r.inferred.rms, r.id).toBeLessThan(r.radiusMin as number);
    }
  });

  it('teleports only at B2’s documented teleport points: the eight snaps (G3, T1, T2, X1d), each inside a teleport window and logged once', () => {
    expect(run.snaps.map((s) => [s.id, s.tick])).toEqual(SNAPS);
    expect(run.snaps.length).toBe(run.core.snapCount);
    for (const s of run.snaps) {
      const c = run.core.puppet(s.id);
      expect(c?.track.isTeleportPoint(s.tick), `${s.id} @ ${s.tick}`).toBe(true);
      const logs = entries[s.tick]?.act.actions.filter((a) => a.type === 'log' && a.level === 'info' && a.text.startsWith(`puppet ${s.id}: snap`));
      expect(logs, `${s.id} @ ${s.tick}`).toHaveLength(1);
    }
    // Every teleport after the setup tick is one of those snaps.
    expect(actionsOfType(entries, 'teleport').filter((x) => x.tick > 0)).toHaveLength(SNAPS.length);
  });

  it('no pawn ever goes LIVE: every status is REPLAY until DEAD, and the Core sends no set_mode', () => {
    for (const id of PLAYER_IDS) {
      const ch = modeChanges(entries, id).map((c) => c.mode);
      expect(ch, id).toEqual(id === 'sp4rtan' ? ['REPLAY'] : ['REPLAY', 'DEAD']);
    }
    expect(entries.some((e) => e.act.status.some((s) => s.mode === 'LIVE'))).toBe(false);
    expect(actionsOfType(entries, 'set_mode')).toEqual([]);
    expect(summarize(run).modes.every((m) => !m.everLive)).toBe(true);
  });

  it('no puppet is body-blocked by an enemy (C3 collision) at any tick', () => {
    expect(run.bodyBlocks).toEqual([]);
  });
});

describe('golden master: scripted events (B3) on the engine (C2, C3)', () => {
  it('latency: an input shows its shot, and an action its damage / weapon, one tick later, as tuning.replay says', () => {
    const lat = measureLatency(data);
    expect(lat).toEqual({ input: 1, action: 1, setWeapon: 1 });
    expect(lat.input).toBe(data.tuning.replay.inputLatencyTicks);
    expect(lat.action).toBe(data.tuning.replay.actionLatencyTicks);
  });

  it('every recorded kill produces a death event with the right attacker, weapon and headshot, within a tick', () => {
    const seen = deaths(entries);
    for (const [t, killer, victim, weapon, hs] of KILLS) {
      const d = seen.find((x) => x.victim === victim);
      expect(d, `${victim}`).toBeDefined();
      expect(d).toMatchObject({ attacker: killer, weapon, headshot: hs });
      expect(Math.abs((d?.tick ?? NaN) - Math.round(t * 64)), `${killer} -> ${victim}`).toBeLessThanOrEqual(1);
    }
  });

  it('nobody dies who shouldn’t: nine deaths, each once, and sp4rtan survives on 100 HP', () => {
    const seen = deaths(entries);
    expect(seen.map((d) => d.victim).sort()).toEqual(KILLS.map((k) => k[2]).sort());
    const last = entries[entries.length - 1]?.observe.pawns.find((p) => p.id === 'sp4rtan');
    expect(last?.alive).toBe(true);
    expect(last?.hp).toBe(100);
  });

  it('every pawn’s HP follows every recorded HP change, within a tick', () => {
    // From the schedule: start HP / armor (tick 1, after the setup), then each damage entry.
    for (const id of PLAYER_IDS) {
      const p = data.round.players.find((q) => q.id === id);
      if (p === undefined) throw new Error(id);
      const expected: { tick: number; hp: number; armor: number }[] = [{ tick: 1, hp: p.startHp, armor: p.startArmor }];
      for (const d of schedule.ofType('damage')) {
        if (d.victim !== id) continue;
        const prev = expected[expected.length - 1] as { hp: number; armor: number };
        expected.push({ tick: d.tick, hp: d.lethal ? 0 : prev.hp - d.amount, armor: prev.armor - (d.lethal ? 0 : (d.armor ?? 0)) });
      }
      const seen = hpChanges(entries, id).filter((c) => c.tick >= 1);
      expect(seen.map((c) => [c.hp, c.armor]), id).toEqual(expected.map((c) => [c.hp, c.armor]));
      seen.forEach((c, k) => expect(Math.abs(c.tick - (expected[k] as { tick: number }).tick), `${id} change ${k}`).toBeLessThanOrEqual(1));
    }
    const hp = (id: PlayerId): number[] =>
      hpChanges(entries, id)
        .filter((c) => c.tick >= 1)
        .map((c) => c.hp);
    expect(hp('donk')).toEqual([100, 73, 39, 13, 0]);
    expect(hpChanges(entries, 'cart').filter((c) => c.tick >= 1)).toEqual([
      { tick: 1, hp: 100, armor: 100 },
      { tick: 1184, hp: 27, armor: 93 },
      { tick: 4442, hp: 0, armor: 93 },
    ]);
    expect(hp('snarlbot')).toEqual([44, 0]);
  });

  it('every recorded exact-time shot has a shot event within a tick', () => {
    const m = matchShots(plan, shots(entries));
    expect(m).toHaveLength(schedule.ofType('shot').length);
    for (const s of m) expect(Math.abs((s.seen ?? NaN) - s.recorded), `${s.shooter} ${s.recorded}`).toBeLessThanOrEqual(1);
  });

  it('fires exactly the rounds the recorded ammo counts show', () => {
    const n = (id: PlayerId): number => shots(entries).filter((s) => s.shooter === id).length;
    expect(n('cart')).toBe(24); // HUD 30 -> 6
    expect(n('barely')).toBe(7 + 11); // HUD 30 -> 23 -> 12
    expect(n('donk')).toBe(2); // HUD 10 -> 9 -> 8
    expect(n('lokier')).toBe(2);
  });

  it('plants by USE: barely holds it from the planned tick until the planted event, which lands on 1761 ± 1', () => {
    const pl = plan.plant;
    if (pl === null) throw new Error('no plant');
    const planted = roundEvents(entries).filter((e) => e.kind === 'bomb planted');
    expect(planted).toHaveLength(1);
    expect(planted[0]?.text).toBe('planted by barely');
    expect(Math.abs((planted[0]?.tick ?? NaN) - 1761)).toBeLessThanOrEqual(1);
    // USE from the planned start (1761 − 205 − latency) until the step that sees the event.
    expect(buttonSpans(entries, 'barely', 'USE')).toEqual([{ from: pl.useFrom, to: (planted[0]?.tick ?? NaN) - 1 }]);
    // The engine draws barely's AK after the plant, so the Core sends no set_weapon for it.
    const at = planted[0]?.tick ?? NaN;
    expect(entries[at]?.observe.pawns.find((p) => p.id === 'barely')?.weapon).toBe('ak47');
    expect(actionsOfType(entries, 'set_weapon').filter((x) => x.tick >= at && x.tick <= pl.fallbackTick && x.action.type === 'set_weapon' && x.action.id === 'barely')).toEqual([]);
  });

  it('defuses by USE: defuse_start on 3955 ± 1 and defused on 4275 ± 1; never interrupted, never exploded', () => {
    const df = plan.defuse;
    if (df === null) throw new Error('no defuse');
    const ev = roundEvents(entries).filter((e) => e.kind.startsWith('bomb defuse') || e.kind === 'bomb defused');
    expect(ev.map((e) => [e.kind, e.text])).toEqual([
      ['bomb defuse_start', 'defuse_start by sp4rtan'],
      ['bomb defused', 'defused by sp4rtan'],
    ]);
    expect(Math.abs((ev[0]?.tick ?? NaN) - 3955)).toBeLessThanOrEqual(1);
    expect(Math.abs((ev[1]?.tick ?? NaN) - 4275)).toBeLessThanOrEqual(1);
    expect(buttonSpans(entries, 'sp4rtan', 'USE')).toEqual([{ from: df.useFrom, to: (ev[1]?.tick ?? NaN) - 1 }]);
    expect(roundEvents(entries).some((e) => e.kind === 'bomb exploded' || e.kind === 'bomb defuse_stop')).toBe(false);
  });

  it('the round ends once, CT by bomb_defused, 12 – 15; the post-round kill on cart still happens', () => {
    const ends = roundEvents(entries).filter((e) => e.kind === 'round_end');
    expect(ends.map((e) => e.text)).toEqual(['CT bomb_defused']);
    expect(Math.abs((ends[0]?.tick ?? NaN) - 4275)).toBeLessThanOrEqual(1);
    const end = entries[entries.length - 1]?.observe.round;
    expect(end).toMatchObject({ phase: 'over', winner: 'CT', reason: 'bomb_defused', score: { ct: 12, t: 15 } });
    expect(actionsOfType(entries, 'end_round')).toEqual([]);
    const cart = deaths(entries).find((d) => d.victim === 'cart');
    expect(cart).toMatchObject({ tick: 4442, attacker: 'sp4rtan', weapon: 'ak47', headshot: false });
    expect(cart?.tick ?? 0).toBeGreaterThan(ends[0]?.tick ?? Infinity);
  });

  it('no fallback action, no script log, no action the host leaves unhandled', () => {
    expect(actionsOfType(entries, 'plant')).toEqual([]);
    expect(actionsOfType(entries, 'defuse_start')).toEqual([]);
    expect(coreLogs(entries).filter((l) => l.text.startsWith('script: '))).toEqual([]);
    expect(run.host.unhandled().filter((n) => n.kind === 'action')).toEqual([]);
    const s = summarize(run);
    expect({ fallbacks: s.fallbacks, hostNotes: s.hostNotes, warnings: s.warnings }).toEqual({ fallbacks: [], hostNotes: [], warnings: [] });
  });
});
