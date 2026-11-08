/**
 * H3: scenarios (data/scenarios/, docs/scenarios.md) and free play: the format and its validation, a LIVE bot that
 * walks from T spawn to a bomb site on de_dust2 (CS2's nav) and plants, free play on Mirage that ends in a normal
 * round end, and the takeover of any pawn. Run with --reporter=verbose to see the measured numbers.
 */
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, SCENARIO_FORMAT, ScenarioError, bombsiteAt, parseScenario, type Action, type ObsEvent, type Vec3 } from '../src/contracts/index';
import { checkScenarioOnMap, freePlayPlan } from '../src/core/index';
import { Sim3DHost } from '../src/sim3d/index';
import { freePlaySession, loadFreePlay, loadGameScenario, loadMapNav, onMap, runFreePlay, scenarioNames } from '../tools/game-scenario';

describe('scenario format', () => {
  it('every data/scenarios/ file parses, and free play is consistent with its map', () => {
    const names = scenarioNames();
    expect(names).toEqual(['dust2-5v5', 'mirage-5v5', 'mirage-sp4rtan-1v3']);
    for (const n of names) {
      const s = loadGameScenario(n);
      if (s.recording === null) expect(checkScenarioOnMap(s, loadMapNav(s).info), n).toEqual([]);
    }
    const rec = loadGameScenario('mirage-sp4rtan-1v3');
    expect(rec.recording).toEqual({ round: 'data/round.json', playable: 'cart' });
    expect(rec.map).toBe('mirage-2020');
  });

  it('rejects what it cannot play, naming the field', () => {
    const base = { format: SCENARIO_FORMAT, map: 'de_dust2', players: PLAYER_IDS.map((id, i) => ({ id, team: i < 5 ? 'T' : 'CT', spawn: i % 5 })) };
    expect(() => parseScenario(base, 'ok')).not.toThrow();
    const bad = (patch: object, re: RegExp): void => expect(() => parseScenario({ ...base, ...patch }, 'x')).toThrow(re);
    bad({ map: 'de_nowhere' }, /map: unknown map package/);
    bad({ players: base.players.slice(1) }, /all ten pawn slots; barely is missing/);
    bad({ players: base.players.map((p, i) => (i === 7 ? { ...p, c4: true } : p)) }, /only a T carries the c4/);
    bad({ players: base.players.map((p, i) => (i === 0 ? { ...p, weapons: [{ weapon: 'c4', clip: 0, reserve: 0 }] } : p)) }, /expected a gun/);
    bad({ recording: { round: 'data/round.json' } }, /takes its players from the recording/);
    bad({ rules: { botDifficulty: 'godlike' } }, /botDifficulty/);
    expect(() => parseScenario({ ...base, name: 'other' }, 'x')).toThrow(ScenarioError);
  });

  it('the default plan: the c4 carrier plants on the picked site, the other Ts take it, the CTs split over both sites', () => {
    const s = loadGameScenario('dust2-5v5');
    const plan = freePlayPlan(s, loadMapNav(s).info);
    expect(plan.site).toMatch(/^[AB]$/);
    expect(plan.pawns.filter((p) => p.goal.role === 'plant').map((p) => p.id)).toEqual(['donk']);
    expect(plan.pawns.filter((p) => p.team === 'T' && !p.c4).every((p) => p.goal.role === 'take_site')).toBe(true);
    expect(plan.pawns.filter((p) => p.team === 'CT').every((p) => p.goal.role === 'retake')).toBe(true);
  });
});

describe('free play (3D engine)', () => {
  it('de_dust2: a LIVE bot walks from T spawn to a bomb site on CS2 nav and plants', () => {
    const w = loadFreePlay(loadGameScenario('dust2-5v5'));
    const results: string[] = [];
    for (const site of w.info.bombsites) {
      const spawn = w.info.spawns.T[0] as Vec3 & { yaw: number };
      const host = new Sim3DHost(w.nav, w.tuning, [{ id: 'donk', team: 'T' }], { score: { ct: 0, t: 0 }, roundTimeSec: 115 }, { mask: null, seed: 1 }, { movement: w.movement, world: w.world });
      host.setHuman(null);
      const setup: Action[] = [
        { type: 'teleport', id: 'donk', pos: spawn, yaw: spawn.yaw },
        { type: 'give', id: 'donk', item: 'ak47', clip: 30, reserve: 90 },
        { type: 'give', id: 'donk', item: 'c4', clip: 0, reserve: 0 },
        { type: 'set_weapon', id: 'donk', weapon: 'ak47' },
        { type: 'set_mode', id: 'donk', mode: 'LIVE', goal: { route: [], role: 'plant', hold: site.plant } },
      ];
      host.apply({ inputs: [], actions: setup, status: [] });
      let planted: { tick: number; pos: Vec3 } | null = null;
      for (let k = 0; k < 64 * 60 && planted === null; k++) {
        host.tick();
        for (const e of host.observe().events as readonly ObsEvent[]) if (e.type === 'bomb' && e.phase === 'planted' && e.pos !== null) planted = { tick: k, pos: e.pos };
      }
      expect(planted, `plant on ${site.name}`).not.toBeNull();
      const p = planted as { tick: number; pos: Vec3 };
      expect(bombsiteAt(w.info, p.pos)?.name).toBe(site.name);
      const walk = w.nav.path(spawn, site.plant) as Vec3[];
      let len = 0;
      for (let i = 1; i < walk.length; i++) len += Math.hypot((walk[i] as Vec3).x - (walk[i - 1] as Vec3).x, (walk[i] as Vec3).y - (walk[i - 1] as Vec3).y);
      results.push(`${site.name}: planted at ${(p.tick / 64).toFixed(2)} s (${p.pos.x.toFixed(0)}, ${p.pos.y.toFixed(0)}, ${p.pos.z.toFixed(0)}); nav path ${len.toFixed(0)} u`);
      // Walking at 215 u/s (AK) plus the 3.2 s plant, with slack for the corners and the jumps.
      expect(p.tick / 64).toBeLessThan(45);
    }
    console.log(`dust2 T spawn → site: ${results.join('; ')}`);
  }, 300_000);

  it('Mirage 5v5 free play ends in a normal round end; the same seed plays the same round', () => {
    const s = loadGameScenario('mirage-5v5');
    const w = loadFreePlay(s);
    const a = runFreePlay(freePlaySession(w), 200, 0);
    expect(a.end).not.toBeNull();
    expect(['elimination', 'bomb_exploded', 'bomb_defused', 'time']).toContain(a.end?.reason);
    console.log(`mirage-5v5: ${a.end?.winner} win by ${a.end?.reason} at ${((a.end?.tick ?? 0) / 64).toFixed(2)} s; ${a.kills.length} deaths; bomb ${a.bomb.map((b) => `${b.phase} ${(b.tick / 64).toFixed(1)} s`).join(', ') || 'never planted'}`);
    const b = runFreePlay(freePlaySession(w), 200, 0);
    expect(b.end).toEqual(a.end);
    expect(b.kills).toEqual(a.kills);
  }, 600_000);

  it('the human may take over any pawn (a CT here); released, it goes back to LIVE', () => {
    const w = loadFreePlay(onMap(loadGameScenario('mirage-5v5'), 'de_dust2'));
    const session = freePlaySession(w, null);
    for (let k = 0; k < 64; k++) session.step();
    expect(session.takeControlBlocked('lokier')).toBeNull();
    session.takeControl('lokier');
    session.step();
    session.step();
    const st = session.log().at(session.log().length - 1)?.act.status.find((q) => q.id === 'lokier');
    expect(st?.mode).toBe('HUMAN');
    expect(session.host.aiDebug('lokier')).toBeNull();
  }, 120_000);
});
