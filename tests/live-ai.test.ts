/**
 * The 2D engine's LIVE AI (C4, src/sim2d/ai.ts; docs/ai.md): a pawn the Core switched to LIVE follows its goal,
 * fights, plants and defuses on its own, deterministically from the host's seed. Run with --reporter=verbose to
 * see the measured numbers.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, fnv1a32Hex, parseRound, stableStringify, type Act, type Action, type Goal, type Observe, type PawnInput, type PlayerId, type Vec3 } from '../src/contracts/index';
import { RoundModel, startActions } from '../src/core/index';
import { escapeSpot, nearestBombsitePoint } from '../src/sim2d/ai';
import { Sim2DHost } from '../src/sim2d/host';
import { NavMesh } from '../src/sim2d/nav';
import { VisMask, visOptionsFromTuning } from '../src/sim2d/vision';
import { nav, tuning } from './sim2d-fixtures';

const round = parseRound(JSON.parse(readFileSync(new URL('../data/round.json', import.meta.url), 'utf8')) as unknown);
const model = new RoundModel(round);
const mask = VisMask.fromJson(JSON.parse(readFileSync(new URL('../data/mirage-vismask.json', import.meta.url), 'utf8')) as unknown, visOptionsFromTuning(tuning.ai));
const roster = round.players.map((p) => ({ id: p.id, team: p.team }));

function act(actions: readonly Action[], inputs: readonly PawnInput[] = []): Act {
  return { inputs, actions, status: [] };
}
const at = (x: number, y: number): Vec3 => ({ x, y, z: nav.zAt({ x, y }) });

/** A Mirage host with the sight mask and `seed`, everyone set up with the recorded kits; all but `keep` dead. */
function scenario(seed: number, keep: readonly PlayerId[]): Sim2DHost {
  const h = new Sim2DHost(nav, tuning, roster, { score: round.meta.score, roundTimeSec: round.meta.clock0 }, { mask, seed });
  h.setHuman(null);
  const dead = PLAYER_IDS.filter((id) => !keep.includes(id)).map((id): Action => ({ type: 'set_hp', id, hp: 0, armor: 0, helmet: false }));
  h.apply(act([...startActions(model, tuning), ...dead]));
  return h;
}

function live(id: PlayerId, goal: Goal): Action {
  return { type: 'set_mode', id, mode: 'LIVE', goal };
}

/** Run until `stop` (checked on each observe) or `max` ticks; `inputs` gives the Core inputs per tick. Returns the observes. */
function run(h: Sim2DHost, max: number, stop: (o: Observe) => boolean, inputs: (o: Observe) => PawnInput[] = () => []): Observe[] {
  const out: Observe[] = [];
  for (let k = 0; k < max; k++) {
    const o = h.observe();
    out.push(o);
    if (stop(o)) break;
    h.apply(act([], inputs(o)));
    h.tick();
  }
  return out;
}

const pawnOf = (o: Observe, id: PlayerId) => o.pawns.find((p) => p.id === id) as Observe['pawns'][number];
const bearing = (a: Vec3, b: Vec3): number => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
const angDiff = (a: number, b: number): number => {
  let d = (b - a) % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return Math.abs(d);
};

describe('LIVE AI: combat', () => {
  const LOKIER: Vec3 = { x: -2139, y: 439, z: -161 };
  /** Lokier (LIVE, holding B with his SSG 08) and cart walking (silent) west along the Apartments, past the window. */
  function windowDuel(seed: number): { firstSeen: number | null; death: number | null; shots: number } {
    const h = scenario(seed, ['lokier', 'cart']);
    h.apply(
      act([
        { type: 'teleport', id: 'lokier', pos: LOKIER, yaw: 0 },
        { type: 'set_weapon', id: 'lokier', weapon: 'ssg08' },
        { type: 'teleport', id: 'cart', pos: at(-1050, 790), yaw: 180 },
        { type: 'set_weapon', id: 'cart', weapon: 'ak47' },
        live('lokier', { route: [], role: 'hold', hold: LOKIER }),
      ]),
    );
    let firstSeen: number | null = null;
    let shots = 0;
    const obs = run(
      h,
      64 * 12,
      (o) => {
        if (firstSeen === null && pawnOf(o, 'lokier').sees.includes('cart')) firstSeen = o.tick;
        shots += o.events.filter((e) => e.type === 'shot' && e.shooter === 'lokier').length;
        return !pawnOf(o, 'cart').alive;
      },
      () => [{ id: 'cart', forward: 1, side: 0, yaw: 180, pitch: 0, buttons: ['WALK'] }],
    );
    const death = obs.find((o) => o.events.some((e) => e.type === 'death' && e.victim === 'cart'))?.tick ?? null;
    return { firstSeen, death, shots };
  }

  it('a LIVE lokier holding B kills a pawn walking past the Apartments window within 2 s on average (20 seeds)', () => {
    const ttk: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const r = windowDuel(seed);
      expect(r.firstSeen, `seed ${seed}: cart seen`).not.toBeNull();
      expect(r.death, `seed ${seed}: cart killed`).not.toBeNull();
      ttk.push(((r.death as number) - (r.firstSeen as number)) / 64);
    }
    const mean = ttk.reduce((a, b) => a + b, 0) / ttk.length;
    console.log(`[live-ai] window duel: time from first sight to kill, 20 seeds: mean ${mean.toFixed(2)} s, min ${Math.min(...ttk).toFixed(2)}, max ${Math.max(...ttk).toFixed(2)} [${ttk.map((x) => x.toFixed(2)).join(' ')}]`);
    expect(mean).toBeLessThan(2);
  });

  it('reacts no faster than reactionSec − 30 %, and the kill comes from its own bullets', () => {
    const r = windowDuel(3);
    expect(r.shots).toBeGreaterThan(0);
    expect((r.death as number) - (r.firstSeen as number)).toBeGreaterThanOrEqual(Math.floor(tuning.ai.reactionSec * 0.7 * 64));
  });

  it('hearing turns a pawn toward a shot it cannot see', () => {
    const h = scenario(7, ['zwomp', 'barely']);
    const Z: Vec3 = { x: -2139, y: 439, z: -161 };
    const B = at(-1100, 790); // in the Apartments, behind their wall as seen from Z, 1,097 units away
    expect(mask.lineOfSight(Z, B)).toBe(false);
    h.apply(
      act([
        { type: 'teleport', id: 'zwomp', pos: Z, yaw: 180 },
        { type: 'teleport', id: 'barely', pos: B, yaw: 0 },
        { type: 'set_weapon', id: 'barely', weapon: 'ak47' },
        live('zwomp', { route: [], role: 'hold', hold: Z }),
      ]),
    );
    // Let him settle on his hold, then face him west (away from barely), and barely fires once.
    run(h, 64, () => false);
    h.apply(act([{ type: 'teleport', id: 'zwomp', pos: Z, yaw: 180 }]));
    h.tick();
    expect(h.aiDebug('zwomp')).toMatchObject({ behaviour: 'holding', target: null, lastKnown: null });
    h.apply(act([], [{ id: 'barely', forward: 0, side: 0, yaw: 0, pitch: 0, buttons: ['ATTACK'] }]));
    h.tick();
    expect(h.observe().events.some((e) => e.type === 'sound' && e.kind === 'shot' && e.source === 'barely')).toBe(true);
    const obs = run(h, 32, () => false, () => [{ id: 'barely', forward: 0, side: 0, yaw: 0, pitch: 0, buttons: [] }]);
    const z = pawnOf(obs[obs.length - 1] as Observe, 'zwomp');
    expect(z.sees).not.toContain('barely');
    expect(angDiff(z.yaw, bearing(z.pos, B)), `zwomp yaw ${z.yaw}`).toBeLessThan(20);
    expect(h.aiDebug('zwomp')?.lastKnown).toMatchObject({ id: 'barely' });
  });
});

describe('LIVE AI: bomb', () => {
  it('a LIVE sp4rtan alone with the planted bomb walks to it and defuses with his kit', () => {
    const h = scenario(1, ['sp4rtan', 'barely']);
    h.apply(act([{ type: 'teleport', id: 'sp4rtan', pos: at(-1700, -1800), yaw: 90 }, { type: 'plant', id: 'barely', pos: { x: -1982, y: 311, z: -160 } }]));
    h.tick();
    h.apply(act([{ type: 'set_hp', id: 'barely', hp: 0, armor: 0, helmet: false }, live('sp4rtan', { route: [], role: 'defuse', hold: null })]));
    const obs = run(h, 64 * 40, (o) => o.events.some((e) => e.type === 'bomb' && (e.phase === 'defused' || e.phase === 'exploded')));
    const start = obs.find((o) => o.events.some((e) => e.type === 'bomb' && e.phase === 'defuse_start'));
    const end = obs[obs.length - 1] as Observe;
    expect(start, 'defuse started').toBeDefined();
    expect(end.events).toContainEqual({ type: 'bomb', phase: 'defused', id: 'sp4rtan', pos: { x: -1982, y: 311, z: -160 } });
    expect(end.tick - (start as Observe).tick).toBe(tuning.bomb.defuseKitSec * 64); // with the kit
    expect(end.round).toMatchObject({ winner: 'CT', reason: 'bomb_defused' });
    console.log(`[live-ai] defuse: walked from CT spawn and started at ${((start as Observe).tick / 64).toFixed(2)} s, defused at ${(end.tick / 64).toFixed(2)} s`);
  });

  it('a LIVE T with the c4 goes into B and plants by holding USE', () => {
    const h = scenario(1, ['barely', 'sp4rtan']);
    h.apply(
      act([
        { type: 'teleport', id: 'barely', pos: at(-1400, 790), yaw: 180 },
        { type: 'teleport', id: 'sp4rtan', pos: at(-1700, -1800), yaw: 0 },
        live('barely', { route: [], role: 'plant', hold: null }),
      ]),
    );
    const obs = run(h, 64 * 30, (o) => o.events.some((e) => e.type === 'bomb' && e.phase === 'planted'));
    const end = obs[obs.length - 1] as Observe;
    const planted = end.events.find((e) => e.type === 'bomb' && e.phase === 'planted');
    expect(planted).toMatchObject({ type: 'bomb', phase: 'planted', id: 'barely' });
    const pos = end.round.bomb.pos as Vec3;
    expect(nav.placeName(pos)).toBe('Bombsite B');
    const spot = nearestBombsitePoint(nav, at(-1400, 790)) as Vec3;
    expect(Math.hypot(pos.x - spot.x, pos.y - spot.y)).toBeLessThanOrEqual(tuning.ai.plantSpotUnits);
    // The c4 was drawn and the pawn stood still while planting (the engine's USE plant; no plant action was sent).
    const before = obs[obs.length - 2] as Observe;
    expect(pawnOf(before, 'barely').weapon).toBe('c4');
    expect(h.aiDebug('barely')?.behaviour).toBe('planting');
    console.log(`[live-ai] plant: from the Apartments, planted at ${(end.tick / 64).toFixed(2)} s at (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})`);
  });
});

describe('LIVE AI: the bomb after the round, and a defuse too late', () => {
  const BOMB: Vec3 = { x: -1982, y: 311, z: -160 };
  const clear = tuning.bomb.radius + tuning.ai.blastMarginUnits;
  const d3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const exploded = (o: Observe): boolean => o.events.some((e) => e.type === 'bomb' && e.phase === 'exploded');

  /** barely plants on B (plant action); returns the host on the tick after the plant, and the explode tick. */
  function planted(seed: number, keep: readonly PlayerId[]): { h: Sim2DHost; explodeTick: number } {
    const h = scenario(seed, ['barely', ...keep]);
    h.apply(act([{ type: 'teleport', id: 'barely', pos: at(-1990, 330), yaw: 0 }, { type: 'plant', id: 'barely', pos: BOMB }]));
    h.tick();
    const explodeTick = h.bombState().explodeTick as number;
    expect(h.observe().round.phase).toBe('planted');
    return { h, explodeTick };
  }

  it('escapeSpot: the nearest way out by the nav mesh, at least radius + margin from the bomb (3D)', () => {
    const from = at(-1990, 330);
    const spot = escapeSpot(nav, from, BOMB, clear) as Vec3;
    expect(d3(spot, BOMB)).toBeGreaterThanOrEqual(clear);
    expect(nav.isWalkable(spot)).toBe(true);
    const path = nav.path(from, spot) as Vec3[];
    console.log(`[live-ai] escape from the B plant: (${spot.x.toFixed(0)}, ${spot.y.toFixed(0)}, ${spot.z.toFixed(0)}), ${d3(spot, BOMB).toFixed(0)} u from the bomb, ${NavMesh.pathLength(path).toFixed(0)} u to walk`);
    // Already clear: stay.
    const far = at(1245, -342);
    expect(escapeSpot(nav, far, BOMB, clear)).toEqual(far);
  });

  it('after a T elimination win with the bomb ticking, a LIVE guard leaves the blast radius, holds, and survives', () => {
    const { h, explodeTick } = planted(3, ['sp4rtan']);
    // The last CT dies: T win by elimination, the bomb still ticks.
    h.apply(act([{ type: 'set_hp', id: 'sp4rtan', hp: 0, armor: 0, helmet: false }, live('barely', { route: [], role: 'guard_bomb', hold: at(-1556, 781) })]));
    h.tick();
    expect(h.observe().round).toMatchObject({ phase: 'over', winner: 'T', reason: 'elimination' });
    const behaviours = new Set<string>();
    const obs = run(h, explodeTick + 64, (o) => {
      behaviours.add(h.aiDebug('barely')?.behaviour ?? '');
      return exploded(o);
    });
    const end = obs[obs.length - 1] as Observe;
    expect(exploded(end)).toBe(true);
    const b = pawnOf(end, 'barely');
    expect(b).toMatchObject({ alive: true, hp: 100 });
    expect(d3(b.pos, BOMB)).toBeGreaterThanOrEqual(tuning.bomb.radius);
    expect([...behaviours]).toEqual(expect.arrayContaining(['escaping', 'holding']));
    expect(behaviours.has('guarding')).toBe(false);
    // Holds there: no movement over the last second before the blast, and none after it.
    const before = obs[obs.length - 65] as Observe;
    expect(Math.hypot(pawnOf(before, 'barely').pos.x - b.pos.x, pawnOf(before, 'barely').pos.y - b.pos.y)).toBeLessThan(1);
    const after = run(h, 128, () => false);
    expect(pawnOf(after[after.length - 1] as Observe, 'barely').pos).toEqual(b.pos);
    expect(h.aiDebug('barely')?.behaviour).toBe('holding');
    console.log(`[live-ai] post-round escape: barely holds ${d3(b.pos, BOMB).toFixed(0)} u from the bomb when it explodes at ${(explodeTick / 64).toFixed(2)} s`);
  });

  it('a CT the round is over for (forced end_round) leaves too instead of defusing', () => {
    const { h, explodeTick } = planted(4, ['sp4rtan']);
    h.apply(act([{ type: 'teleport', id: 'sp4rtan', pos: at(-1939, 150), yaw: 90 }, { type: 'set_hp', id: 'barely', hp: 0, armor: 0, helmet: false }, { type: 'end_round', winner: 'T', reason: 'elimination' }, live('sp4rtan', { route: [], role: 'defuse', hold: null })]));
    h.tick();
    expect(h.observe().round.phase).toBe('over');
    const obs = run(h, explodeTick + 64, exploded);
    const end = obs[obs.length - 1] as Observe;
    expect(obs.some((o) => o.events.some((e) => e.type === 'bomb' && e.phase === 'defuse_start'))).toBe(false);
    expect(pawnOf(end, 'sp4rtan')).toMatchObject({ alive: true, hp: 100 });
    expect(d3(pawnOf(end, 'sp4rtan').pos, BOMB)).toBeGreaterThanOrEqual(tuning.bomb.radius);
  });

  /** sp4rtan (kit) goes LIVE `dist` units from the bomb with `leftSec` on the timer; all Ts dead (the round goes on). */
  function lateRetake(leftSec: number): { h: Sim2DHost; explodeTick: number; obs: Observe[] } {
    const { h, explodeTick } = planted(5, ['sp4rtan']);
    h.apply(act([{ type: 'teleport', id: 'sp4rtan', pos: at(-1700, -400), yaw: 90 }, { type: 'set_hp', id: 'barely', hp: 0, armor: 0, helmet: false }]));
    run(h, explodeTick - Math.round(leftSec * 64) - h.observe().tick, () => false);
    expect(h.observe().round.phase).toBe('planted');
    h.apply(act([live('sp4rtan', { route: [], role: 'defuse', hold: null })]));
    const obs = run(h, explodeTick + 64, (o) => o.events.some((e) => e.type === 'bomb' && (e.phase === 'defused' || e.phase === 'exploded')));
    return { h, explodeTick, obs };
  }

  it('a LIVE CT with a kit who cannot walk there and defuse in time gives it up and saves himself', () => {
    // 6 s left; the walk is ~700 units (3.1 s at 225 u/s with the AK) + 5 s with the kit > 6 s.
    const { h, obs } = lateRetake(6);
    const end = obs[obs.length - 1] as Observe;
    expect(exploded(end)).toBe(true);
    expect(obs.some((o) => o.events.some((e) => e.type === 'bomb' && e.phase === 'defuse_start'))).toBe(false);
    const sp = pawnOf(end, 'sp4rtan');
    expect(sp.alive).toBe(true);
    expect(d3(sp.pos, BOMB)).toBeGreaterThanOrEqual(tuning.bomb.radius);
    expect(end.round).toMatchObject({ winner: 'T', reason: 'bomb_exploded' });
    expect(h.aiDebug('sp4rtan')?.behaviour).toBe('holding');
  });

  it('with enough time (12 s) the same CT walks there and defuses', () => {
    const { obs } = lateRetake(12);
    const end = obs[obs.length - 1] as Observe;
    expect(end.events).toContainEqual({ type: 'bomb', phase: 'defused', id: 'sp4rtan', pos: BOMB });
  });

  it('a defuse in progress that cannot finish before the explosion is dropped (USE released), and he runs', () => {
    // zwomp has no kit (10 s); he starts defusing as a REPLAY pawn with 9.5 s left, then goes LIVE.
    const { h, explodeTick } = planted(6, ['zwomp']);
    h.apply(act([{ type: 'teleport', id: 'zwomp', pos: at(-1990, 300), yaw: 90 }, { type: 'set_hp', id: 'barely', hp: 0, armor: 0, helmet: false }]));
    const use: PawnInput = { id: 'zwomp', forward: 0, side: 0, yaw: 90, pitch: 60, buttons: ['USE'] };
    run(h, explodeTick - Math.round(9.5 * 64) - h.observe().tick, () => false);
    run(h, 4, () => false, () => [use]);
    expect(h.bombState().defuse).toMatchObject({ id: 'zwomp' });
    h.apply(act([live('zwomp', { route: [], role: 'defuse', hold: null })], [use]));
    const obs = run(h, explodeTick + 64, exploded);
    expect(obs.slice(0, 3).some((o) => o.events.some((e) => e.type === 'bomb' && e.phase === 'defuse_stop' && e.id === 'zwomp'))).toBe(true);
    expect(obs.some((o) => o.events.some((e) => e.type === 'bomb' && e.phase === 'defused'))).toBe(false);
    const z = pawnOf(obs[obs.length - 1] as Observe, 'zwomp');
    expect(z.alive).toBe(true);
    console.log(`[live-ai] dropped defuse: zwomp is ${d3(z.pos, BOMB).toFixed(0)} u from the bomb at the explosion, ${z.hp} HP`);
  });
});

describe('LIVE AI: navigation and control', () => {
  it('a LIVE pawn sent around several corners reaches its goal without getting stuck', () => {
    const cases: { from: [number, number]; to: [number, number] }[] = [
      { from: [-667, -1065], to: [-700, -225] }, // Connector -> Mid -> Catwalk
      { from: [-1075, -1396], to: [-1939, 250] }, // Jungle -> CT spawn -> Market -> B
    ];
    for (const c of cases) {
      const h = scenario(5, ['zwomp', 'barely']);
      const goal = at(c.to[0], c.to[1]);
      h.apply(act([{ type: 'teleport', id: 'zwomp', pos: at(c.from[0], c.from[1]), yaw: 0 }, { type: 'teleport', id: 'barely', pos: at(1245, -342), yaw: 0 }, live('zwomp', { route: [], role: 'rotate', hold: goal })]));
      const path = nav.path(at(c.from[0], c.from[1]), goal) as Vec3[];
      let corners = 0;
      for (let i = 1; i < path.length - 1; i++) {
        const a = path[i - 1] as Vec3;
        const b = path[i] as Vec3;
        const d = path[i + 1] as Vec3;
        if (angDiff(bearing(a, b), bearing(b, d)) > 30) corners++;
      }
      expect(corners, `${c.from} -> ${c.to}`).toBeGreaterThanOrEqual(3);
      const len = NavMesh.pathLength(path);
      const budget = Math.ceil((len / (tuning.movement.runSpeedByWeapon['m4a4'] as number) + 2) * 64);
      const obs = run(h, budget + 64, (o) => {
        const p = pawnOf(o, 'zwomp').pos;
        return Math.hypot(p.x - goal.x, p.y - goal.y) <= tuning.ai.arriveUnits;
      });
      const end = obs[obs.length - 1] as Observe;
      const p = pawnOf(end, 'zwomp').pos;
      const dbg = h.aiDebug('zwomp');
      console.log(`[live-ai] corners ${c.from} -> ${c.to}: ${corners} corners, path ${len.toFixed(0)} u, reached in ${(end.tick / 64).toFixed(2)} s (budget ${(budget / 64).toFixed(2)} s), repaths ${dbg?.repaths}`);
      expect(Math.hypot(p.x - goal.x, p.y - goal.y), `${c.from} -> ${c.to}`).toBeLessThanOrEqual(tuning.ai.arriveUnits);
      expect(end.tick).toBeLessThanOrEqual(budget);
      expect(dbg?.repaths).toBe(0);
    }
  });

  it('walks the goal route waypoint by waypoint, then holds', () => {
    const h = scenario(2, ['zwomp', 'barely']);
    const route = [at(-650, -363), at(-700, -225)];
    const hold = at(-726, 243);
    h.apply(act([{ type: 'teleport', id: 'zwomp', pos: at(-667, -1065), yaw: 0 }, { type: 'teleport', id: 'barely', pos: at(1245, -342), yaw: 0 }, live('zwomp', { route, role: 'rotate', hold })]));
    const seen: number[] = [];
    run(h, 64 * 12, () => {
      const d = h.aiDebug('zwomp');
      if (d !== null && !seen.includes(d.routeIndex)) seen.push(d.routeIndex);
      return d?.behaviour === 'holding';
    });
    expect(seen).toEqual([0, 1, 2]);
    const p = pawnOf(h.observe(), 'zwomp').pos;
    expect(Math.hypot(p.x - hold.x, p.y - hold.y)).toBeLessThanOrEqual(tuning.ai.arriveUnits + 8);
  });

  it('a route point off the nav mesh counts at its projection onto the mesh', () => {
    // A point 40+ units into the wall next to a walkable route point.
    const base = at(-650, -363);
    let off: Vec3 | null = null;
    for (let d = 40; d < 200 && off === null; d += 10) {
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
        const q = { x: base.x + dx * d, y: base.y + dy * d, z: base.z };
        if (!nav.isWalkable(q)) {
          off = q;
          break;
        }
      }
    }
    expect(off).not.toBeNull();
    const h = scenario(2, ['zwomp', 'barely']);
    const hold = at(-726, 243);
    h.apply(act([{ type: 'teleport', id: 'zwomp', pos: at(-667, -1065), yaw: 0 }, { type: 'teleport', id: 'barely', pos: at(1245, -342), yaw: 0 }, live('zwomp', { route: [off as Vec3], role: 'rotate', hold })]));
    run(h, 64 * 15, () => h.aiDebug('zwomp')?.behaviour === 'holding');
    expect(h.aiDebug('zwomp')).toMatchObject({ behaviour: 'holding', routeIndex: 1 });
  });

  it('LIVE pawns ignore Core inputs', () => {
    const make = (): Sim2DHost => {
      const h = scenario(4, ['zwomp', 'barely']);
      h.apply(act([{ type: 'teleport', id: 'zwomp', pos: at(-667, -1065), yaw: 0 }, live('zwomp', { route: [], role: 'rotate', hold: at(-700, -225) })]));
      return h;
    };
    const a = make();
    const b = make();
    const junk: PawnInput = { id: 'zwomp', forward: 1, side: -1, yaw: 123, pitch: 40, buttons: ['ATTACK', 'DUCK', 'RELOAD'] };
    for (let k = 0; k < 200; k++) {
      a.apply(act([], [junk]));
      b.apply(act([]));
      a.tick();
      b.tick();
      expect(stableStringify(a.observe()), `tick ${k}`).toBe(stableStringify(b.observe()));
    }
    // Back to REPLAY: Core inputs drive it again.
    a.apply(act([{ type: 'set_mode', id: 'zwomp', mode: 'REPLAY', goal: null }], [junk]));
    a.tick();
    expect(pawnOf(a.observe(), 'zwomp').yaw).toBe(123);
    expect(a.aiDebug('zwomp')).toBeNull();
  });

  it('aiDebug reports role, behaviour, target and path', () => {
    const h = scenario(1, ['zwomp', 'barely']);
    h.apply(act([{ type: 'teleport', id: 'zwomp', pos: at(-667, -1065), yaw: 0 }, live('zwomp', { route: [], role: 'something new', hold: at(-700, -225) })]));
    h.tick();
    const d = h.aiDebug('zwomp');
    expect(d).toMatchObject({ id: 'zwomp', role: 'hold', behaviour: 'moving', target: null, targetVisible: false, routeIndex: 0, repaths: 0 });
    expect(d?.path.length).toBeGreaterThan(0);
    expect(h.aiDebug('barely')).toBeNull();
  });
});

describe('LIVE AI: determinism', () => {
  const LOKIER: Vec3 = { x: -2139, y: 439, z: -161 };
  function duelHost(seed: number): Sim2DHost {
    const h = scenario(seed, ['lokier', 'cart', 'sp4rtan', 'barely']);
    h.apply(
      act([
        { type: 'teleport', id: 'lokier', pos: LOKIER, yaw: 0 },
        { type: 'set_weapon', id: 'lokier', weapon: 'ssg08' },
        { type: 'teleport', id: 'cart', pos: at(-1300, 790), yaw: 180 },
        { type: 'teleport', id: 'barely', pos: at(-1400, 300), yaw: 180 },
        { type: 'teleport', id: 'sp4rtan', pos: at(-1939, 150), yaw: 0 },
        live('lokier', { route: [], role: 'hold', hold: LOKIER }),
        live('cart', { route: [], role: 'hunt', hold: at(-1900, 300) }),
        live('barely', { route: [], role: 'plant', hold: null }),
        live('sp4rtan', { route: [], role: 'retake', hold: at(-1939, 150) }),
      ]),
    );
    return h;
  }
  const digest = (obs: readonly Observe[]): string => fnv1a32Hex(obs.map((o) => stableStringify(o)).join('\n'));

  it('two runs give identical digests; another seed gives another fight', () => {
    const a = run(duelHost(11), 640, () => false);
    const b = run(duelHost(11), 640, () => false);
    const c = run(duelHost(12), 640, () => false);
    expect(digest(a)).toBe(digest(b));
    expect(digest(c)).not.toBe(digest(a));
    expect(a.some((o) => o.events.some((e) => e.type === 'shot'))).toBe(true);
  });

  it('snapshot / restore mid-fight gives an identical continuation, also in a fresh host', () => {
    const h = duelHost(21);
    // Mid-fight: the first tick a LIVE pawn is fighting a target it sees.
    const fighting = (): boolean => (['barely', 'cart', 'lokier', 'sp4rtan'] as const).some((id) => h.aiDebug(id)?.behaviour === 'fighting' && h.aiDebug(id)?.targetVisible === true);
    run(h, 640, () => fighting());
    expect(fighting()).toBe(true);
    const snap = h.snapshot();
    expect((snap.data as { version: number }).version).toBe(5);
    const rest = run(h, 400, () => false);
    const again = new Sim2DHost(nav, tuning, roster, { score: round.meta.score, roundTimeSec: round.meta.clock0 }, { mask, seed: 999 });
    again.restore(snap);
    expect(digest(run(again, 400, () => false))).toBe(digest(rest));
    h.restore(snap);
    expect(digest(run(h, 400, () => false))).toBe(digest(rest));
  });
});
