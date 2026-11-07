/**
 * G7: bots act like normal players (docs/core.md "Divergence" → "Normal bots"). John: "if the bots are able to attack
 * the enemy, they can; … they should stick to the script of the round as long as it continues to make sense to do so."
 *
 * - The on-script rule: the human is the recording only within `offCourseUnits` of his recorded track within
 *   `onCourseDriftSec` of now (`humanOnScript`); a puppet that sees him anywhere else goes LIVE and the AI fights.
 * - The scheduled encounter (Lokier's hit at the window) is time-shifted only within `encounterWindowSec` of the
 *   recorded sighting; outside it, it is cancelled and the sighting is a real fight.
 * - A recorded pair (± expectedSightingWindowSec) explains seeing an off-script enemy within `closeRangeUnits` only if
 *   he is about where the tape has him; recorded fire is recorded only from about the shooter's recorded place.
 * - The invariant (tools/react-check.ts): no alive REPLAY bot has an off-script enemy in its `sees` for more than a
 *   reaction time (`ai.reactionSec`) unless the recording covers it. Checked here over the G7 scenarios and
 *   takeover-duel, and over every other scenario in tests/scenarios.test.ts and tests/duels.test.ts.
 *
 * The scenarios print their timelines (`npx vitest run tests/normal-bots.test.ts --reporter=verbose`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, type LogEntry, type Observe, type PawnObs, type PlayerId } from '../src/contracts/index';
import { parseTuning, TuningError } from '../src/contracts/tuning';
import {
  Divergence,
  EventSchedule,
  RoundModel,
  ScriptedEvents,
  distanceToRecording,
  humanOnScript,
  inEncounterWindow,
  recordedPairInSight,
  sightingTrigger,
  summarize,
  tickOf,
  trackPosAt,
  type EncounterState,
  type PawnMode,
} from '../src/core/index';
import { ROOT, coreLogs, deaths, loadHarnessData, runHarness, type HarnessRun } from '../tools/harness';
import { HumanBot, formatTimeline, liveSwitches, loadScenario, rejoins, timeline } from '../tools/human-bot';
import { formatViolations, reactViolations } from '../tools/react-check';
import { liveRound } from './fakes';

const data = loadHarnessData();
const tuning = data.tuning;
const r = tuning.replay;
const sec = (s: number): number => Math.round(s * 64);
/**
 * The G7 scenarios' routes and peek spots are laid out for sight on the CS2 mesh (G6, src/sim2d/mesh-sight.ts). With
 * the 2D sight mask (main before G6: Truck sees through the Apartments, barely sees Lokier through walls) their
 * fights are the mask's; the rule-level checks and the react invariant run either way, the fight details only on the
 * mesh.
 */
const MESH_SIGHT = existsSync(`${ROOT}/src/sim2d/mesh-sight.ts`);

// ---------------------------------------------------------------------------------------------------------------
// The rules as pure functions (the snapped round the harness plays)
// ---------------------------------------------------------------------------------------------------------------

const model = new RoundModel(data.round);
const schedule = new EventSchedule(data.round);
const div = new Divergence(model, schedule, new ScriptedEvents(model, schedule, tuning).plan, tuning);

function pawn(id: PlayerId, p: { x: number; y: number }, extra: Partial<PawnObs> = {}): PawnObs {
  return {
    id,
    team: model.player(id).team,
    pos: { x: p.x, y: p.y, z: -80 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 100,
    armor: 100,
    alive: true,
    weapon: 'ak47',
    ammo: { clip: 30, reserve: 90 },
    crouching: false,
    onGround: true,
    sees: [],
    ...extra,
  };
}

function obs(tick: number, over: readonly PawnObs[]): Observe {
  const pawns = PLAYER_IDS.map((id, i) => over.find((p) => p.id === id) ?? pawn(id, { x: 10000 * (i + 1), y: 0 }));
  return { tick, t: tick / 64, pawns, events: [], human: 'cart', round: liveRound(tick) };
}

const modes = (): PawnMode[] => PLAYER_IDS.map((id) => ({ id, mode: id === 'cart' ? 'HUMAN' : 'REPLAY' }));
const waiting: EncounterState[] = div.encounters.map((e) => ({ key: e.key, phase: 'waiting', seenTick: null, shotTick: null, blocked: false, puppetSightTick: null, puppetSightOnCourse: false }));

describe('G7 rule: the human is the recording only near his recorded track in time (onCourseDriftSec)', () => {
  const drift = sec(r.onCourseDriftSec);

  it('distanceToRecording: 0 at the recorded position of any tick within the drift, the exact tick with drift 0', () => {
    for (const k of [700, 1000, 1150]) {
      const here = trackPosAt(model, 'cart', k);
      expect(distanceToRecording(model, 'cart', here, k, 0)).toBeLessThan(1e-9);
      expect(distanceToRecording(model, 'cart', trackPosAt(model, 'cart', k + drift), k, drift)).toBeLessThan(1e-9);
      expect(distanceToRecording(model, 'cart', trackPosAt(model, 'cart', k - drift), k, drift)).toBeLessThan(1e-9);
    }
  });

  it('cart 1.5 s ahead of his recording in the Apartments is on script; at the corridor spot of peek-before-eradicate at 10.7 s he is not', () => {
    const k = 950;
    const ahead = trackPosAt(model, 'cart', k + sec(1.5));
    expect(distanceToRecording(model, 'cart', ahead, k, 0)).toBeGreaterThan(r.offCourseUnits);
    expect(humanOnScript(model, obs(k, [pawn('cart', ahead)]), tuning)).toBe(true);
    // The corridor spot where Lokier sees him in peek-before-eradicate: his recording is in Back Alley until 11.5 s.
    const corridor = { x: -1127, y: 644 };
    expect(humanOnScript(model, obs(683, [pawn('cart', corridor)]), tuning)).toBe(false);
    expect(distanceToRecording(model, 'cart', { ...corridor, z: -80 }, 683, drift)).toBeGreaterThan(300);
    const o = obs(683, [pawn('lokier', { x: -2325, y: 811 }, { sees: ['cart'] }), pawn('cart', corridor)]);
    expect(sightingTrigger(o, modes(), 'lokier', model, div.index, div.encounters, waiting, tuning)).toEqual({ id: 'lokier', trigger: 'sighting', reason: 'sees cart (the human), not in the recording' });
  });
});

describe('G7 rule: the scheduled encounter only within encounterWindowSec of the recorded sighting', () => {
  it('Lokier’s hit at the window: the window is the recorded sighting (17.45 s) ± encounterWindowSec', () => {
    const p = div.encounters[0];
    expect(p).toBeDefined();
    if (p === undefined) return;
    const w = sec(r.encounterWindowSec);
    expect(p.recordedSightTick).toBe(1117);
    expect([inEncounterWindow(p, 1117 - w, tuning), inEncounterWindow(p, 1117 + w, tuning)]).toEqual([true, true]);
    expect([inEncounterWindow(p, 1117 - w - 1, tuning), inEncounterWindow(p, 1117 + w + 1, tuning)]).toEqual([false, false]);
    // lokier-late's sighting (+2.6 s on the CS2 mesh) is inside it; cart-dies' (−9.4 s) and window-6s-early's are not.
    expect(inEncounterWindow(p, 1117 + sec(2.7), tuning)).toBe(true);
    expect(inEncounterWindow(p, 513, tuning)).toBe(false);
  });
});

describe('G7 rule: a recorded pair at close range needs the enemy about where the tape has him (closeRangeUnits)', () => {
  // sp4rtan ↔ cart: "cart / barely" see sp4rtan on B from 58.6 s (the pair covers 56.6 s on).
  const k = 3700;
  const sp = trackPosAt(model, 'sp4rtan', k);
  it('face to face elsewhere: not the recording; at long range, or at his recorded place: the recording', () => {
    expect(div.index.saw('sp4rtan', 'cart', k)).toBe(true);
    const near = { x: sp.x + 40, y: sp.y };
    expect(distanceToRecording(model, 'cart', { ...near, z: -80 }, k, sec(r.expectedSightingWindowSec))).toBeGreaterThan(r.humanSpotToleranceUnits);
    expect(recordedPairInSight(model, obs(k, [pawn('sp4rtan', sp), pawn('cart', near)]), div.index, 'sp4rtan', 'cart', tuning)).toBe(false);
    const far = { x: sp.x + r.closeRangeUnits + 50, y: sp.y };
    expect(recordedPairInSight(model, obs(k, [pawn('sp4rtan', sp), pawn('cart', far)]), div.index, 'sp4rtan', 'cart', tuning)).toBe(true);
    const rec = trackPosAt(model, 'cart', k);
    expect(recordedPairInSight(model, obs(k, [pawn('sp4rtan', { x: rec.x + 100, y: rec.y }), pawn('cart', rec)]), div.index, 'sp4rtan', 'cart', tuning)).toBe(true);
    // No recorded pair at all (sp4rtan and cart at 30 s): never.
    expect(recordedPairInSight(model, obs(1920, [pawn('sp4rtan', sp), pawn('cart', far)]), div.index, 'sp4rtan', 'cart', tuning)).toBe(false);
  });
});

describe('G7 tunables (data/tuning.json → replay)', () => {
  it('onCourseDriftSec, encounterWindowSec, closeRangeUnits: present, >= 0', () => {
    expect([r.onCourseDriftSec, r.encounterWindowSec, r.closeRangeUnits]).toEqual([2, 3, 512]);
    const raw = JSON.parse(readFileSync(`${ROOT}/data/tuning.json`, 'utf8')) as { replay: Record<string, unknown> };
    for (const k of ['onCourseDriftSec', 'encounterWindowSec', 'closeRangeUnits']) {
      const bad = structuredClone(raw);
      bad.replay[k] = -1;
      expect(() => parseTuning(bad)).toThrow(TuningError);
      const missing = structuredClone(raw);
      missing.replay = Object.fromEntries(Object.entries(missing.replay).filter(([key]) => key !== k));
      expect(() => parseTuning(missing)).toThrow(new RegExp(`replay\\.${k}`));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------------------

function play(name: string): HarnessRun {
  const s = loadScenario(`${ROOT}/fixtures/scenarios/${name}.json`);
  const run = runHarness(data, { human: s.human, driver: HumanBot.fromScenario(data, s), lastTick: s.until === 'end' ? 'end' : tickOf(s.until), seed: s.seed, takeover: s.takeover === null ? null : tickOf(s.takeover) });
  console.log(`[scenario ${name}] ${s.description}\n${formatTimeline(timeline(run.entries))}\n  ${summarize(run.model, run.entries).headline}\n`);
  return run;
}

const pawnAt = (e: LogEntry, id: PlayerId): PawnObs => e.observe.pawns.find((p) => p.id === id) as PawnObs;
const shotsBy = (run: HarnessRun, id: PlayerId, from: number, to: number): number[] =>
  run.entries.filter((e) => e.observe.tick >= from && e.observe.tick <= to && e.observe.events.some((ev) => ev.type === 'shot' && ev.shooter === id)).map((e) => e.observe.tick);
const encounterLogs = (run: HarnessRun): string[] => coreLogs(run.entries).filter((l) => l.text.startsWith('encounter ')).map((l) => `${l.tick} ${l.text}`);
const headline = (run: HarnessRun): string => summarize(run.model, run.entries).headline;
const killTicks = (run: HarnessRun): string[] => deaths(run.entries).map((d) => `${d.tick} ${d.attacker ?? 'world'}>${d.victim}`);
const played: { name: string; run: HarnessRun }[] = [];

describe('peek-before-eradicate (John’s case): cart peeks Lokier’s corridor at 10.7 s, 7 s ahead of his recording', () => {
  const run = play('peek-before-eradicate');
  played.push({ name: 'peek-before-eradicate', run });
  const sw = liveSwitches(run.entries);
  const lk = sw.find((s) => s.id === 'lokier');

  it('Lokier goes LIVE on the first tick he sees cart off script, and the window encounter is over', () => {
    const first = run.entries.find((e) => e.observe.tick > 0 && pawnAt(e, 'lokier').sees.includes('cart') && !humanOnScript(run.model, e.observe, tuning));
    expect(first).toBeDefined();
    expect(lk).toMatchObject({ trigger: 'sighting', tick: first?.observe.tick });
    // On the CS2 mesh that is in the Apartments corridor (x < −1050), his recording still in Back Alley.
    if (MESH_SIGHT) expect(pawnAt(first as LogEntry, 'cart').pos.x).toBeLessThan(-1050);
    expect(encounterLogs(run)).toEqual([`${lk?.tick} encounter lokier -> cart: over at tick ${lk?.tick}, lokier is LIVE`]);
  });

  it.skipIf(!MESH_SIGHT)('Lokier shoots at cart within a human reaction time (the AI’s reaction plus aim settle) and holds his angle meanwhile', () => {
    const t0 = lk?.tick ?? 0;
    const shots = shotsBy(run, 'lokier', t0, t0 + sec(3));
    expect(shots.length).toBeGreaterThan(0);
    const reaction = (shots[0] as number) - t0;
    console.log(`[peek-before-eradicate] Lokier LIVE at tick ${t0} (${(t0 / 64).toFixed(2)} s); first shot at cart ${reaction} ticks later (${(reaction / 64).toFixed(2)} s); shots ${shots.join(', ')}`);
    expect(reaction).toBeGreaterThanOrEqual(Math.floor(tuning.ai.reactionSec * (1 - tuning.ai.reactionJitter) * 64));
    expect(reaction).toBeLessThanOrEqual(sec(1));
    // G7's AI fix: reacting, he stops on Truck and turns to cart instead of walking off toward his hold spot.
    const atShot = run.entries[shots[0] as number] as LogEntry;
    expect(pawnAt(atShot, 'lokier').sees).toContain('cart');
  });

  it('Lokier’s recorded kill of eradicate is dropped while he is LIVE; the round goes on (outcome printed)', () => {
    const logs = coreLogs(run.entries).map((l) => l.text);
    const erad = deaths(run.entries).find((d) => d.victim === 'eradicate');
    console.log(`[peek-before-eradicate] ${headline(run)}; kills: ${killTicks(run).join(', ')}; rejoins: ${rejoins(run.entries).map((x) => `${x.id}@${x.tick}`).join(', ')}`);
    if (erad === undefined || erad.tick !== 816) expect(logs.some((t) => t.startsWith('script: dropped damage lokier -> eradicate'))).toBe(true);
    expect(run.entries.some((e) => e.observe.events.some((ev) => ev.type === 'round_end'))).toBe(true);
    expect(reactViolations(run, tuning)).toEqual([]);
  });
});

describe('window-2s-early: tape-like play up to 2 s ahead of the recording', () => {
  const run = play('window-2s-early');
  played.push({ name: 'window-2s-early', run });

  it.skipIf(!MESH_SIGHT)('is on script all the way (Lokier sees him in the Apartments ahead of his recording: no switch), and gets the scheduled encounter', () => {
    expect(liveSwitches(run.entries)).toEqual([]);
    // The drift is what keeps it on script: on a tick Lokier sees him he is beyond offCourseUnits of the exact tick's position.
    const early = run.entries.filter((e) => e.observe.tick < 1100 && pawnAt(e, 'lokier').sees.includes('cart') && distanceToRecording(run.model, 'cart', pawnAt(e, 'cart').pos, e.observe.tick, 0) > r.offCourseUnits);
    expect(early.length).toBeGreaterThan(0);
    const enc = encounterLogs(run);
    expect(enc.some((t) => / in sight at the spot at tick /.test(t))).toBe(true);
    // D1 (John 13:10): his real headshot kills Lokier at 18.47 s, before the scripted 73 is due (18.50 s): it never lands.
    expect(run.entries.some((e) => e.observe.events.some((ev) => ev.type === 'damage' && ev.attacker === 'lokier' && ev.victim === 'cart'))).toBe(false);
    expect(enc.some((t) => / over at tick \d+, lokier is dead/.test(t))).toBe(true);
  });

  it.skipIf(!MESH_SIGHT)('cart kills Lokier in the recorded duel; then the round is on script: CT defuse (outcome printed)', () => {
    const kill = deaths(run.entries).find((d) => d.victim === 'lokier');
    expect(kill).toMatchObject({ attacker: 'cart', headshot: true });
    console.log(`[window-2s-early] ${headline(run)}; encounter: ${encounterLogs(run).join(' | ')}; kills: ${killTicks(run).join(', ')}`);
    // D1: his real kill comes before Lokier's hit, so cart keeps 100 HP and survives sp4rtan's post-round shot (2 kills
    // changed: Lokier early, no post-round kill); before D1 the duel held the kill to its tick ("Played it like the tape").
    expect(headline(run)).toMatch(/^(Played it like the tape|Same result, different round): CT defuse, 0\.72 s left/);
    expect(liveSwitches(run.entries)).toEqual([]);
  });

  it('the react invariant holds', () => {
    expect(reactViolations(run, tuning)).toEqual([]);
  });
});

describe('window-6s-early: in the Apartments 3–6 s ahead of the recording', () => {
  const run = play('window-6s-early');
  played.push({ name: 'window-6s-early', run });

  it('Lokier sees a T where the tape has none: LIVE (sighting) before the window, no scripted hit; a real fight', () => {
    const lk = liveSwitches(run.entries).find((s) => s.id === 'lokier');
    expect(lk).toMatchObject({ trigger: 'sighting' });
    expect((lk?.tick ?? Infinity) < 1117 - sec(r.encounterWindowSec)).toBe(true);
    expect(run.entries.some((e) => e.observe.events.some((ev) => ev.type === 'damage' && ev.attacker === 'lokier' && ev.victim === 'cart' && ev.scripted))).toBe(false);
    expect(encounterLogs(run).some((t) => / (over at tick \d+, lokier is LIVE|cancelled at tick)/.test(t))).toBe(true);
    console.log(`[window-6s-early] ${headline(run)}; kills: ${killTicks(run).join(', ')}`);
    expect(reactViolations(run, tuning)).toEqual([]);
  });
});

describe('kill-lokier-early: cart fights Lokier from the window 4 s early; the survivors carry on', () => {
  const run = play('kill-lokier-early');
  played.push({ name: 'kill-lokier-early', run });
  const logs = coreLogs(run.entries).map((l) => l.text);

  it.skipIf(!MESH_SIGHT)('a real fight: Lokier LIVE on sight, cart’s real headshot kills him well before the recorded 18.80 s', () => {
    expect(liveSwitches(run.entries).find((s) => s.id === 'lokier')).toMatchObject({ trigger: 'sighting' });
    const kill = deaths(run.entries).find((d) => d.victim === 'lokier');
    expect(kill).toMatchObject({ attacker: 'cart' });
    expect((kill?.tick ?? Infinity) < 1203 - sec(2)).toBe(true);
    expect(run.entries.some((e) => e.observe.events.some((ev) => ev.type === 'damage' && ev.attacker === 'cart' && ev.victim === 'lokier' && !ev.scripted))).toBe(true);
  });

  it.skipIf(!MESH_SIGHT)('Lokier’s recorded kill of eradicate is dropped (eradicate outlives his recording); the Ts LIVE before the plant rejoin; the plant is on the tape', () => {
    expect(logs).toContain('script: dropped damage lokier -> eradicate (lethal at tick 816): lokier is LIVE');
    expect(liveSwitches(run.entries).find((s) => s.id === 'eradicate')?.trigger).toBe('outlived');
    const back = rejoins(run.entries).map((x) => x.id);
    for (const id of liveSwitches(run.entries).filter((s) => s.tick < 1761).map((s) => s.id).filter((id) => id !== 'lokier' && id !== 'eradicate')) expect(back).toContain(id);
    const plant = run.entries.find((e) => e.observe.events.some((ev) => ev.type === 'bomb' && ev.phase === 'planted'));
    expect(plant?.observe.events.find((ev) => ev.type === 'bomb' && ev.phase === 'planted')).toMatchObject({ id: 'barely' });
    expect(plant?.observe.tick).toBe(1761);
    console.log(`[kill-lokier-early] ${headline(run)}; plant at ${plant?.observe.tick}; kills: ${killTicks(run).join(', ')}; rejoins: ${rejoins(run.entries).map((x) => `${x.id}@${x.tick}`).join(', ')}`);
  });

  it('the react invariant holds', () => {
    expect(reactViolations(run, tuning)).toEqual([]);
  });

  it('D1: a kill outside the recorded duel (14.6 s, before Lokier sees him at the window): no duel, G7/G8 decide the rest, and the round ends by the rules', () => {
    expect(logs.filter((t) => t.startsWith('duel cart -> lokier'))).toEqual([]);
    expect(run.entries.some((e) => e.observe.events.some((ev) => ev.type === 'round_end'))).toBe(true);
  });
});

describe('the react invariant: takeover-duel (the other scenario no other test file plays with it)', () => {
  it('no REPLAY bot ignores a visible off-script enemy for more than a reaction time', () => {
    const run = play('takeover-duel');
    const v = reactViolations(run, tuning);
    console.log(`[react takeover-duel] ${v.length} violations${v.length > 0 ? `\n${formatViolations(v)}` : ''}`);
    expect(v).toEqual([]);
    expect(played.length).toBe(4);
  });
});
