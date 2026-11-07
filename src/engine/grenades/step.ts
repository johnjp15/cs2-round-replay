/**
 * The per-tick driver (docs/grenades.md, Host API). `stepGrenades` simulates tick `state.tick` (64 Hz, dt = 1/64):
 * projectiles fly and bounce, due grenades detonate (in throw order), fires spread and burn, smokes and decoys run
 * out. It mutates `state` and returns the events in order; the host applies damage (armor, deaths) and blinds.
 */
import { createDecoy } from './decoy';
import { createInferno, stepInferno } from './fire';
import { blindFromExposure, flashExposure } from './flash';
import { blast } from './he';
import { secToTicks } from './math';
import { stepProjectile, type Impact } from './projectile';
import { addHeHole, createSmoke } from './smoke';
import { releaseGrenade } from './throw';
import type { GrenadeConfig, GrenadeEvent, GrenadeState, GrenadeWorld, Projectile, StepInput, ThrowRequest } from './types';

export function createGrenadeState(seed: number, tick = 0): GrenadeState {
  return { seed: seed >>> 0, tick, nextSeq: 1, projectiles: [], smokes: [], infernos: [], decoys: [], heHoles: [] };
}

/** Release a grenade now (at `state.tick`, before that tick's step). Returns its seq and the 'thrown' event. */
export function throwGrenade(state: GrenadeState, req: ThrowRequest, world: GrenadeWorld, cfg: GrenadeConfig): { seq: number; event: GrenadeEvent } {
  const t = cfg.tuning;
  const r = releaseGrenade(req.eye, req.pitch, req.yaw, req.strength, req.velocity, world, t);
  const seq = state.nextSeq++;
  const fuse = req.type === 'smoke' ? t.smokeFuseSec : t.decoyFuseSec;
  const p: Projectile = {
    seq,
    type: req.type,
    thrower: req.thrower,
    team: req.team,
    throwTick: state.tick,
    pos: r.pos,
    vel: r.vel,
    atRest: false,
    bounces: 0,
    nextCheckTick: state.tick + secToTicks(fuse),
    decoyShotIntervalSec: req.decoyShotIntervalSec ?? 0,
    path: [r.pos],
  };
  state.projectiles.push(p);
  return { seq, event: { type: 'thrown', tick: state.tick, seq, grenade: req.type, thrower: req.thrower, pos: r.pos, vel: r.vel } };
}

interface Due {
  readonly p: Projectile;
  readonly impact: Impact | null;
  /** Velocity just before the burst (fire spread bias). */
  readonly vel: { x: number; y: number; z: number };
}

/** Simulate one tick. */
export function stepGrenades(state: GrenadeState, world: GrenadeWorld, input: StepInput, cfg: GrenadeConfig): GrenadeEvent[] {
  const t = cfg.tuning;
  const tick = state.tick;
  const events: GrenadeEvent[] = [];
  const pawns = [...input.pawns].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  state.projectiles.sort((a, b) => a.seq - b.seq);

  const due: Due[] = [];
  const keep: Projectile[] = [];
  for (const p of state.projectiles) {
    const vel = p.vel;
    const impact = stepProjectile(p, world, pawns, t, tick, events);
    const age = tick - p.throwTick;
    let go = false;
    if (p.type === 'he') go = age >= secToTicks(t.heFuseSec);
    else if (p.type === 'flash') go = age >= secToTicks(t.flashFuseSec);
    else if (p.type === 'molotov' || p.type === 'incendiary') go = impact !== null || age >= secToTicks(t.molotovFuseSec);
    else if (tick >= p.nextCheckTick) {
      if (p.atRest) go = true;
      else p.nextCheckTick = tick + Math.max(1, secToTicks(t.restCheckSec));
    }
    if (go) due.push({ p, impact, vel });
    else keep.push(p);
  }
  state.projectiles = keep;

  for (const { p, impact, vel } of due) {
    const pos = impact !== null ? impact.pos : p.pos;
    events.push({ type: 'detonate', tick, seq: p.seq, grenade: p.type, thrower: p.thrower, pos });
    if (p.type === 'he') {
      events.push(
        ...blast(
          { seq: p.seq, grenade: 'he', thrower: p.thrower, team: p.team, pos, damage: t.heDamage, radius: t.heRadius, armorRatio: t.heArmorRatio, flinchSmall: t.heFlinchSmall, flinchLarge: t.heFlinchLarge },
          pawns,
          world,
          input.friendlyFire,
          tick,
          t,
        ),
      );
      addHeHole(state, pos, tick);
    } else if (p.type === 'flash') {
      for (const pw of pawns) {
        if (!pw.alive) continue;
        const b = blindFromExposure(flashExposure(pos, pw, world, state, tick, t), tick, t);
        if (b !== null) events.push({ type: 'blind', tick, seq: p.seq, thrower: p.thrower, victim: pw.id, blind: b });
      }
    } else if (p.type === 'smoke') {
      const s = createSmoke(p.seq, p.thrower, p.team, pos, tick, world, t);
      state.smokes.push(s);
      events.push({ type: 'smoke_start', tick, seq: p.seq, pos, voxels: s.cells.length });
    } else if (p.type === 'decoy') {
      state.decoys.push(createDecoy(state.seed, p.seq, p.thrower, p.team, pos, tick, p.decoyShotIntervalSec, t));
    } else {
      const r = createInferno(p.seq, p.type, p.thrower, p.team, pos, vel, tick, world, state, t);
      if (r.inferno === null) events.push({ type: 'no_fire', tick, seq: p.seq, reason: r.reason });
      else {
        state.infernos.push(r.inferno);
        events.push({ type: 'fire_start', tick, seq: p.seq, pos: r.inferno.center });
      }
    }
  }

  state.infernos = state.infernos.filter((inf) => stepInferno(inf, world, state, pawns, input.friendlyFire, tick, t, events));

  state.smokes = state.smokes.filter((s) => {
    if (tick + 1 < s.endTick) return true;
    events.push({ type: 'smoke_end', tick, seq: s.seq });
    return false;
  });

  state.decoys = state.decoys.filter((d) => {
    while (d.shots.length > 0 && (d.shots[0] as number) <= tick) {
      d.shots.shift();
      events.push({ type: 'decoy_shot', tick, seq: d.seq, thrower: d.thrower, pos: d.pos });
    }
    if (tick < d.endTick) return true;
    events.push({ type: 'decoy_explode', tick, seq: d.seq, thrower: d.thrower, pos: d.pos });
    events.push(
      ...blast(
        { seq: d.seq, grenade: 'decoy', thrower: d.thrower, team: d.team, pos: d.pos, damage: t.decoyDamage, radius: t.decoyRadius, armorRatio: 1, flinchSmall: 1, flinchLarge: 1 },
        pawns,
        world,
        input.friendlyFire,
        tick,
        t,
      ),
    );
    return false;
  });

  state.tick = tick + 1;
  return events;
}

/** Run a lone grenade until it detonates (for lineups and tools): returns the detonation event and the flight path. */
export function simulateThrow(
  req: ThrowRequest,
  world: GrenadeWorld,
  cfg: GrenadeConfig,
  opts: { seed?: number; maxSec?: number; pawns?: StepInput['pawns'] } = {},
): { detonation: Extract<GrenadeEvent, { type: 'detonate' }> | null; path: { x: number; y: number; z: number }[]; events: GrenadeEvent[]; ticks: number } {
  const state = createGrenadeState(opts.seed ?? 1);
  const { seq, event } = throwGrenade(state, req, world, cfg);
  const proj = state.projectiles[0] as Projectile;
  const events: GrenadeEvent[] = [event];
  const limit = secToTicks(opts.maxSec ?? 30);
  for (let k = 0; k < limit; k++) {
    const ev = stepGrenades(state, world, { pawns: opts.pawns ?? [], friendlyFire: false }, cfg);
    events.push(...ev);
    const det = ev.find((e): e is Extract<GrenadeEvent, { type: 'detonate' }> => e.type === 'detonate' && e.seq === seq);
    if (det !== undefined) return { detonation: det, path: proj.path, events, ticks: k + 1 };
  }
  return { detonation: null, path: proj.path, events, ticks: limit };
}
