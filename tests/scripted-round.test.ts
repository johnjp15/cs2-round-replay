/**
 * The scripted round (golden master): ReplayCore with B3's scripted events drives all ten puppets in the
 * real Sim2DHost for the whole recording, with no human. The recorded kills, HP and shot ticks must come
 * out (each event within a tick of its recorded tick), and nobody else may die. Run with
 * `--reporter=verbose` to see the tables (also `npm run scripted`).
 */
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, SessionLog, replay, type PlayerId } from '../src/contracts/index';
import { EventSchedule, ReplayCore, RoundModel } from '../src/core/index';
import { NavWalkQuery } from '../src/sim2d/walk-query';
import { GHOST_SEED, loadGhostInputs } from '../tools/ghost-round';
import { buttonSpans, coreLogs, deaths, hpChanges, hpTable, killTable, matchShots, measureLatency, runScriptedRound, shotTable, shots } from '../tools/scripted-round';

const inputs = loadGhostInputs();
const run = runScriptedRound(inputs);
const plan = run.core.script.plan;
const schedule = new EventSchedule(inputs.round);

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

describe('latency (Sim2DHost: apply -> tick -> observe)', () => {
  it('an input shows its shot, and an action its damage / weapon, one tick later, as tuning.replay says', () => {
    const lat = measureLatency(inputs);
    expect(lat).toEqual({ input: 1, action: 1, setWeapon: 1 });
    expect(lat.input).toBe(inputs.tuning.replay.inputLatencyTicks);
    expect(lat.action).toBe(inputs.tuning.replay.actionLatencyTicks);
  });
});

describe('scripted round (no human, all ten pawns puppets, the whole recording)', () => {
  it('prints the tables (run with --reporter=verbose)', () => {
    console.log(`[scripted] ${run.ticks} ticks, digest ${run.log.digest()}\n${killTable(run)}\n\n${hpTable(run)}\n\n${shotTable(run)}`);
    expect(run.ticks).toBeGreaterThan(4442);
  });

  it('every recorded kill produces a death event with the right attacker, weapon and headshot, within a tick', () => {
    const seen = deaths(run.log);
    for (const [t, killer, victim, weapon, hs] of KILLS) {
      const d = seen.find((x) => x.victim === victim);
      expect(d, `${victim}`).toBeDefined();
      expect(d).toMatchObject({ attacker: killer, weapon, headshot: hs });
      expect(Math.abs((d?.tick ?? NaN) - Math.round(t * 64)), `${killer} -> ${victim}`).toBeLessThanOrEqual(1);
    }
  });

  it('nobody dies who shouldn’t: nine deaths, each once, and sp4rtan survives', () => {
    const seen = deaths(run.log);
    expect(seen.map((d) => d.victim).sort()).toEqual(KILLS.map((k) => k[2]).sort());
    const last = run.log.at(run.log.length - 1)?.observe.pawns.find((p) => p.id === 'sp4rtan');
    expect(last?.alive).toBe(true);
    expect(last?.hp).toBe(100);
  });

  it('every pawn’s HP follows the recorded damage, within a tick', () => {
    // From the schedule: start HP / armor (tick 1, after the setup), then each damage entry.
    for (const id of PLAYER_IDS) {
      const p = inputs.round.players.find((q) => q.id === id);
      if (p === undefined) throw new Error(id);
      const expected: { tick: number; hp: number; armor: number }[] = [{ tick: 1, hp: p.startHp, armor: p.startArmor }];
      for (const d of schedule.ofType('damage')) {
        if (d.victim !== id) continue;
        const prev = expected[expected.length - 1] as { hp: number; armor: number };
        expected.push({ tick: d.tick, hp: d.lethal ? 0 : prev.hp - d.amount, armor: prev.armor - (d.lethal ? 0 : (d.armor ?? 0)) });
      }
      const seen = hpChanges(run.log, id).filter((c) => c.tick >= 1);
      expect(seen.map((c) => [c.hp, c.armor]), id).toEqual(expected.map((c) => [c.hp, c.armor]));
      seen.forEach((c, k) => expect(Math.abs(c.tick - (expected[k] as { tick: number }).tick), `${id} change ${k}`).toBeLessThanOrEqual(1));
    }
    const hp = (id: PlayerId): number[] => hpChanges(run.log, id).filter((c) => c.tick >= 1).map((c) => c.hp);
    expect(hp('donk')).toEqual([100, 73, 39, 13, 0]);
    expect(hpChanges(run.log, 'cart').filter((c) => c.tick >= 1)).toEqual([
      { tick: 1, hp: 100, armor: 100 },
      { tick: 1184, hp: 27, armor: 93 },
      { tick: 4442, hp: 0, armor: 93 },
    ]);
    expect(hp('snarlbot')).toEqual([44, 0]);
  });

  it('every recorded exact-time shot has a shot event within a tick', () => {
    const m = matchShots(plan, shots(run.log));
    expect(m).toHaveLength(schedule.ofType('shot').length);
    for (const s of m) expect(Math.abs((s.seen ?? NaN) - s.recorded), `${s.shooter} ${s.recorded}`).toBeLessThanOrEqual(1);
  });

  it('fires exactly the rounds the recorded ammo counts show', () => {
    const n = (id: PlayerId): number => shots(run.log).filter((s) => s.shooter === id).length;
    expect(n('cart')).toBe(24); // HUD 30 -> 6
    expect(n('barely')).toBe(7 + 11); // HUD 30 -> 23 -> 12
    expect(n('donk')).toBe(2); // HUD 10 -> 9 -> 8
    expect(n('lokier')).toBe(2);
  });

  it('holds USE for the plant and the defuse in the planned windows; fallbacks are logged once', () => {
    const pl = plan.plant;
    const df = plan.defuse;
    if (pl === null || df === null) throw new Error('no plant / defuse');
    expect(buttonSpans(run.log, 'barely', 'USE')).toEqual([{ from: pl.useFrom, to: pl.useTo }]);
    expect(buttonSpans(run.log, 'sp4rtan', 'USE')).toEqual([{ from: df.useFrom, to: df.useTo }]);
    const fallbacks = coreLogs(run.log).filter((l) => l.text.startsWith('script: no '));
    expect(fallbacks.map((l) => l.tick)).toEqual([pl.fallbackTick, df.fallbackTick]);
    // The engine applies every other scripted action (weapons, gives, damage, blocks).
    expect(run.host.unhandled().filter((n) => n.kind === 'action').map((n) => n.type)).toEqual(['plant', 'defuse_start']);
  });

  it.todo('plant completes: a `planted` bomb event lands on tick 1761 ± 1 and no fallback is sent (needs C3, integration in E1)');
  it.todo('defuse completes: `defuse_start` on 3955 ± 1 and `defused` on 4275 ± 1, no fallback (needs C3, integration in E1)');

  it('two runs give identical digests, and the log replays identically through a fresh Core', () => {
    const again = runScriptedRound(inputs);
    expect(again.log.digest()).toBe(run.log.digest());
    const core = new ReplayCore(new RoundModel(inputs.round), new EventSchedule(inputs.round), inputs.tuning, GHOST_SEED, new NavWalkQuery(inputs.nav));
    expect(replay(SessionLog.fromText(run.log.toText()), core)).toMatchObject({ identical: true, mismatchCount: 0 });
  });
});
