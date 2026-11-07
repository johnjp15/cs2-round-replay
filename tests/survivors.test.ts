/**
 * G8 (John 11:35): "If he does not die to Lokier, he should continue to play out the round as a normal player. This
 * applies to all players." docs/core.md "Fate gone: LIVE for good", docs/ai.md `execute` / "Moving like a player".
 *
 * - The rule (`fateGone`, `survivorGoal`) on the recorded round.
 * - `eradicate-survives` (cart kills Lokier at the window at 10.2 s) in the 2D harness and the 3D host: eradicate goes
 *   LIVE for good one tick after his recorded death, never rejoins, walks into B through the Apartments (one jump onto
 *   the sill), covers the plant from the site, guards the bomb, fights the CT who comes; no idle LIVE stretch, no
 *   jitter, no turn faster than the AI's limit, no run above the weapon's speed, no grounded tick off the nav mesh.
 * - Lokier surviving (`never-peeks`, the human never shoots him) and Ts surviving a later recorded death
 *   (`flank-sp4rtan`: donk and barely, sp4rtan dead) are LIVE for good the same way (tests/scenarios.test.ts asserts
 *   their triggers and roles; here: never back to REPLAY).
 * Run with --reporter=verbose for the printed timelines and motion numbers.
 */
import { describe, expect, it } from 'vitest';
import { type LogEntry, type Observe, type PlayerId } from '../src/contracts/index';
import { RoundModel, fateGone, survivorGoal, tickOf } from '../src/core/index';
import { ROOT, coreLogs, deaths, loadHarnessData } from '../tools/harness';
import { loadHarness3dData } from '../tools/harness3d';
import { formatTimeline, liveSwitches, rejoins, timeline } from '../tools/human-bot';
import { liveMotion, liveTrace, type LiveTraceRun } from '../tools/live-trace';
import { formatViolations, reactViolations } from '../tools/react-check';

const data = loadHarnessData();
const tuning = data.tuning;
const model = new RoundModel(data.round);
const ERADICATE_DEATH = model.deathTick('eradicate') as number;

const pawnAt = (e: LogEntry, id: PlayerId): Observe['pawns'][number] => e.observe.pawns.find((p) => p.id === id) as Observe['pawns'][number];
const modeAt = (e: LogEntry, id: PlayerId): string | undefined => e.act.status.find((s) => s.id === id)?.mode;

/** A minimal observe: everyone alive at the recorded start, `human` playing. */
function obs(tick: number, human: PlayerId | null, dead: readonly PlayerId[] = []): Observe {
  return {
    tick,
    human,
    events: [],
    round: { phase: 'live', score: { ct: 11, t: 15 }, timeLeftSec: 60, bomb: { state: 'carried', carrier: 'barely', pos: null, plantTick: null, defuser: null } },
    pawns: model.players.map((p) => ({ id: p.id, team: p.team, alive: !dead.includes(p.id), hp: 100, armor: 100, pos: p.startPos, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, weapon: 'ak47', ammo: { clip: 30, reserve: 90 }, crouching: false, onGround: true, sees: [] })),
  } as unknown as Observe;
}

describe('G8: fate gone, LIVE for good (fate.ts)', () => {
  it('a pawn killed by a puppet on the tape: gone one tick after the recorded death; killed by the human: outliveGraceSec later; never the human', () => {
    expect(ERADICATE_DEATH).toBe(816);
    expect(fateGone(obs(816, 'cart'), model, 'eradicate', tuning)).toBeNull();
    expect(fateGone(obs(817, 'cart'), model, 'eradicate', tuning)).toEqual({ id: 'eradicate', trigger: 'fate', reason: 'alive after its recorded death (lokier at tick 816): fate gone, LIVE for good' });
    expect(fateGone(obs(817, 'cart', ['eradicate']), model, 'eradicate', tuning)).toBeNull();
    // U2's any pawn: eradicate played by the human is never "gone".
    expect(fateGone(obs(900, 'eradicate'), model, 'eradicate', tuning)).toBeNull();
    // Lokier's recorded killer is cart: with cart the human, his kill is a recorded duel that may land late (G5).
    const lk = model.deathTick('lokier') as number;
    const grace = tickOf(tuning.replay.outliveGraceSec);
    expect(fateGone(obs(lk + grace - 1, 'cart'), model, 'lokier', tuning)).toBeNull();
    expect(fateGone(obs(lk + grace, 'cart'), model, 'lokier', tuning)).toEqual({ id: 'lokier', trigger: 'outlived', reason: 'outlived recording (+3.0 s)' });
    // ... with someone else the human, cart is a puppet and the kill lands on its tick.
    expect(fateGone(obs(lk + 1, 'barely'), model, 'lokier', tuning)?.trigger).toBe('fate');
    // No recorded death: never.
    expect(fateGone(obs(4000, 'cart'), model, 'sp4rtan', tuning)).toBeNull();
  });

  it('survivor goals: a T executes the recorded plant site, a CT retakes from where its track ends', () => {
    expect(survivorGoal(model, 'eradicate')).toEqual({ route: [], role: 'execute', hold: { ...model.bomb.pos } });
    const last = model.track('lokier').at(-1) as { x: number; y: number; z: number };
    expect(survivorGoal(model, 'lokier')).toEqual({ route: [], role: 'retake', hold: { x: last.x, y: last.y, z: last.z } });
  });
});

/** The checks every survivor run shares, for `id` LIVE for good from `from`. */
function expectPlaysOn(t: LiveTraceRun, id: PlayerId, from: number, label: string): void {
  const entries = t.run.entries;
  // LIVE from its switch to its death or the end: never back to REPLAY.
  for (let k = from; k < entries.length; k++) {
    const e = entries[k] as LogEntry;
    if (!pawnAt(e, id).alive) break;
    expect(modeAt(e, id), `${label}: ${id} at ${k}`).toBe('LIVE');
  }
  expect(rejoins(entries).filter((r) => r.id === id && r.tick >= from)).toEqual([]);
  const m = liveMotion(t, id, data.nav, tuning, from);
  console.log(`[${label}] ${id} motion: ${JSON.stringify(m)}`);
  expect(m.idleRun.ticks, `${label}: longest idle LIVE stretch`).toBeLessThanOrEqual(tickOf(1));
  expect(m.jitter, `${label}: jitter`).toBeLessThanOrEqual(2);
  expect(m.maxTurnDeg).toBeLessThanOrEqual(tuning.ai.turnRateDegPerTick + 1e-6);
  expect(m.overSpeedTicks).toBe(0);
  // The 2020 nav misses some of CS2's floor (the Apartments sill, door frames): the hull movement on the CS2 mesh keeps
  // the pawn out of walls; this only bounds how often it walks where the 2020 nav has no area.
  expect(m.offMesh, `${label}: grounded ticks off the nav mesh`).toBeLessThanOrEqual(Math.ceil(m.liveTicks * 0.02));
}

function expectEradicateSurvives(t: LiveTraceRun, label: string, onSiteAtPlant: boolean): void {
  const entries = t.run.entries;
  console.log(`[${label}]\n${formatTimeline(timeline(entries))}`);
  // Lokier doesn't take eradicate's head: in 2D cart's spray kills him first (10.23 s); on the 3D host's hitboxes it
  // misses and Lokier, LIVE (fighting cart), drops his scripted shot at eradicate.
  const lk = deaths(entries).find((d) => d.victim === 'lokier');
  if (onSiteAtPlant) expect(lk).toMatchObject({ attacker: 'cart' });
  expect(deaths(entries).some((d) => d.victim === 'eradicate' && d.tick <= ERADICATE_DEATH)).toBe(false);
  // eradicate: LIVE for good one tick after his recorded death, goal execute.
  const sw = liveSwitches(entries).filter((s) => s.id === 'eradicate');
  expect(sw.map((s) => [s.tick, s.trigger])).toEqual([[ERADICATE_DEATH + 1, 'fate']]);
  const set = (entries[ERADICATE_DEATH + 1] as LogEntry).act.actions.find((a) => a.type === 'set_mode' && a.id === 'eradicate');
  expect(set).toEqual({ type: 'set_mode', id: 'eradicate', mode: 'LIVE', goal: survivorGoal(model, 'eradicate') });
  expect(coreLogs(entries).some((l) => l.text.startsWith('eradicate LIVE: alive after its recorded death (lokier at tick 816): fate gone, LIVE for good; goal execute'))).toBe(true);
  expectPlaysOn(t, 'eradicate', ERADICATE_DEATH + 1, label);
  // He is on B (a Bombsite B nav place) by the plant, and stays on the site or near it until the round is over.
  const plant = entries.findIndex((e) => e.observe.events.some((ev) => ev.type === 'bomb' && ev.phase === 'planted'));
  expect(plant).toBeGreaterThan(0);
  const atPlant = pawnAt(entries[plant] as LogEntry, 'eradicate');
  console.log(`[${label}] eradicate at the plant (${plant}): ${atPlant.alive ? data.nav.placeName(atPlant.pos) : 'dead'}`);
  if (onSiteAtPlant) {
    expect(atPlant.alive).toBe(true);
    expect(data.nav.placeName(atPlant.pos)).toBe('Bombsite B');
  }
  // The round ends by the rules (one round_end), and nobody REPLAY ignores an off-script enemy (G7's invariant).
  const ends = entries.flatMap((e) => e.observe.events.filter((ev) => ev.type === 'round_end').map((ev) => ({ tick: e.observe.tick, ev })));
  expect(ends).toHaveLength(1);
  const v = reactViolations(t.run, tuning);
  expect(v, formatViolations(v)).toEqual([]);
  const er = deaths(entries).find((d) => d.attacker === 'eradicate');
  console.log(`[${label}] round_end ${ends[0]?.tick}: ${JSON.stringify(ends[0]?.ev)}; eradicate's kills: ${deaths(entries).filter((d) => d.attacker === 'eradicate').map((d) => `${d.victim}@${d.tick}`).join(', ') || 'none'}${er === undefined ? '' : ''}`);
}

describe('G8: eradicate survives Lokier (eradicate-survives), 2D harness', () => {
  const t = liveTrace(`${ROOT}/fixtures/scenarios/eradicate-survives.json`, false, data);
  it('he plays on as a T: LIVE for good, into B through the Apartments, covers the plant, guards, fights; moves like a player', () => {
    expectEradicateSurvives(t, 'eradicate-survives 2D', true);
  });
});

describe('G8: eradicate survives Lokier (eradicate-survives), 3D host (harness3d)', () => {
  const t = liveTrace(`${ROOT}/fixtures/scenarios/eradicate-survives.json`, true, loadHarness3dData());
  it('the same on Sim3DHost', () => {
    expectEradicateSurvives(t, 'eradicate-survives 3D', false);
  });
});

describe('G8: Lokier survives (never-peeks) and Ts survive a later death (flank-sp4rtan): LIVE for good, never rejoined', () => {
  for (const [name, ids] of [
    ['never-peeks', ['lokier']],
    ['flank-sp4rtan', ['donk', 'barely']],
  ] as const) {
    it(name, () => {
      const t = liveTrace(`${ROOT}/fixtures/scenarios/${name}.json`, false, data);
      for (const id of ids) {
        const last = liveSwitches(t.run.entries).filter((s) => s.id === id && (s.trigger === 'fate' || s.trigger === 'outlived'));
        expect(last.length, `${name}: ${id} LIVE for good`).toBe(1);
        expectPlaysOn(t, id, (last[0] as { tick: number }).tick, name);
      }
    });
  }
});

describe('G8 (John 15:22): barely does not kill Zwomp (zwomp-survives: the human takes barely at 40 s and stands still)', () => {
  const t = liveTrace(`${ROOT}/fixtures/scenarios/zwomp-survives.json`, false, data);
  it('Zwomp plays on for good as a CT: retake, goes for the planted bomb and defuses it (or dies fighting); the round ends by the rules', () => {
    const entries = t.run.entries;
    console.log(`[zwomp-survives]\n${formatTimeline(timeline(entries))}`);
    const zw = model.deathTick('zwomp') as number;
    const grace = tickOf(tuning.replay.outliveGraceSec);
    // His recorded killer is the human (barely): the human's recorded duel may land late, so fate goes 3 s after.
    const sw = liveSwitches(entries).filter((s) => s.id === 'zwomp' && s.tick >= zw);
    expect(sw[0]).toMatchObject({ tick: zw + grace, trigger: 'outlived' });
    const set = (entries[zw + grace] as LogEntry).act.actions.find((a) => a.type === 'set_mode' && a.id === 'zwomp');
    expect(set).toEqual({ type: 'set_mode', id: 'zwomp', mode: 'LIVE', goal: survivorGoal(model, 'zwomp') });
    expectPlaysOn(t, 'zwomp', zw + grace, 'zwomp-survives');
    const ends = entries.flatMap((e) => e.observe.events.filter((ev) => ev.type === 'round_end').map((ev) => ({ tick: e.observe.tick, ev })));
    expect(ends).toHaveLength(1);
    const defuse = entries.flatMap((e) => e.observe.events.filter((ev) => ev.type === 'bomb' && (ev.phase === 'defuse_start' || ev.phase === 'defused')).map((ev) => ({ tick: e.observe.tick, ev })));
    const zDeath = deaths(entries).find((d) => d.victim === 'zwomp');
    // Either he defuses (CT bomb_defused) or he dies fighting; he never stands and waits for the bomb to blow.
    if (zDeath === undefined) {
      expect(defuse.some((d) => d.ev.type === 'bomb' && d.ev.phase === 'defuse_start' && d.ev.id === 'zwomp')).toBe(true);
      expect(ends[0]?.ev).toMatchObject({ winner: 'CT', reason: 'bomb_defused' });
    }
    console.log(`[zwomp-survives] round_end ${JSON.stringify(ends[0])}; defuse ${JSON.stringify(defuse)}; zwomp ${zDeath === undefined ? 'alive' : `killed by ${zDeath.attacker} at ${zDeath.tick}`}`);
    const v = reactViolations(t.run, tuning);
    expect(v, formatViolations(v)).toEqual([]);
  });
});
