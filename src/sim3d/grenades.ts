/**
 * S1 / V5: every grenade of a host with the CS2 world mesh on H5's CS2 grenade engine (`src/engine/grenades`,
 * docs/grenades.md), for both hosts (`GrenadeEngine`, src/sim2d/grenades.ts): the CS2 throw law, the projectile with
 * bounces on the world mesh (no player clips: they don't stop grenades), the detonation rules (smoke at rest, flash and
 * HE on the 1.5 s fuse, molotov on a floor contact or its 2 s air fuse), and the effects: the flood-filled volumetric
 * smoke with its growth and fade, the eye-to-eye smoke test, flash blindness by angle, distance and exposure, the HE
 * blast, the molotov's spreading fire (and its damage), smoke putting fire out. S1 ran only smokes here; V5 (#91)
 * moved flashes, HE and molotovs over from the hosts' 2D model (still the fallback of a host without a mesh).
 *
 * Determinism across snapshots: a host snapshot rounds numbers to 6 decimals (`toJsonValue`), so the engine state
 * (projectiles, fires, decoys, HE holes) is rounded the same way after every throw and step, and a restored run
 * continues exactly like the live one. Only the last flight point is kept (`path`), so snapshots stay small; a smoke
 * cloud is kept as its inputs and rebuilt (memoised) on restore.
 */
import { roundNumber, stableStringify, toJsonValue, type GrenadeCs2Tuning, type PlayerId, type Team, type Vec3 } from '../contracts/index';
import {
  createGrenadeState,
  createSmoke,
  isBlind,
  smokeBlocks,
  smokeDensityAt,
  smokeVoxels,
  stepGrenades,
  throwGrenade,
  type Blind,
  type GrenadePawn,
  type GrenadeState,
  type GrenadeWorld,
  type HullTrace,
} from '../engine/grenades/index';
import type { EnginePawn, GrenadeEffect, GrenadeEngine, GrenadeKind, GrenadeOutcome, GrenadeStepOptions, MapGeometry } from '../sim2d/index';

/** H5's GrenadeWorld on a host's world mesh (traceAabb for the 2-unit grenade box, traceLine for sight and floods). */
export class MeshGrenadeWorld implements GrenadeWorld {
  constructor(private readonly geo: MapGeometry) {}
  traceHull(cx: number, cy: number, cz: number, half: number, dx: number, dy: number, dz: number): HullTrace {
    const r = this.geo.traceAabb(cx, cy, cz, half, half, half, dx, dy, dz);
    return { fraction: r.fraction, hit: r.hit, nx: r.normalX, ny: r.normalY, nz: r.normalZ, startSolid: r.startSolid, allSolid: r.allSolid };
  }
  traceLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    return this.geo.traceLine(ax, ay, az, bx, by, bz);
  }
}

interface State {
  readonly engine: GrenadeState;
  /** engine seq → host seq, thrower, kind. */
  readonly seqs: { readonly engine: number; readonly host: number; readonly thrower: PlayerId; readonly kind?: GrenadeKind }[];
}

const STANDING = 72;
const CROUCHED = 54;
/**
 * docs/grenades.md "Known gaps": the mesh has no skybox clip, so a throw out over the map edge would fall forever; a
 * projectile this far below the lowest floor (Mirage's is about −400) or this old is dropped without detonating.
 */
const LOST_Z = -3000;
const LOST_SEC = 30;

function rv(v: Vec3): Vec3 {
  return { x: roundNumber(v.x), y: roundNumber(v.y), z: roundNumber(v.z) };
}

/** The tick a flash's whiteness drops below the blind threshold (the host's `blindUntilTick`), or null: never blind. */
export function blindUntil(b: Blind, t: Pick<GrenadeCs2Tuning, 'flashBlindAlpha'>): number | null {
  if (!isBlind(b, b.startTick, t)) return null;
  let k = 0;
  const limit = Math.ceil(b.fadeSec * 64) + 2;
  while (k < limit && isBlind(b, b.startTick + k, t)) k++;
  return b.startTick + k;
}

export class Cs2Grenades implements GrenadeEngine {
  private st: State | null = null;
  private readonly world: GrenadeWorld;

  /** `eyeHeight` / `crouchEyeHeight`: the host's (tuning.damage), for the pawns' eyes. */
  constructor(world: MapGeometry, private readonly t: GrenadeCs2Tuning, private readonly eyeHeight: number, private readonly crouchEyeHeight: number) {
    this.world = new MeshGrenadeWorld(world);
  }

  throwGrenade(kind: GrenadeKind, tick: number, seq: number, thrower: PlayerId, team: Team, eye: Vec3, pitch: number, yaw: number, velocity: Vec3): void {
    if (this.st === null || this.st.engine.tick !== tick) this.st = this.st === null ? { engine: createGrenadeState(1, tick), seqs: [] } : this.realign(this.st, tick);
    const st = this.st;
    const r = throwGrenade(st.engine, { type: kind, thrower, team, eye, pitch, yaw, strength: 1, velocity }, this.world, { tuning: this.t });
    st.seqs.push({ engine: r.seq, host: seq, thrower, kind });
    this.normalize();
  }

  step(tick: number, pawns: readonly EnginePawn[], opts: GrenadeStepOptions = {}): GrenadeOutcome[] {
    const st0 = this.st;
    if (st0 === null) return [];
    // A host never skips a tick with a grenade up (set_round clears); be safe: realign the clock.
    const st = st0.engine.tick === tick ? st0 : (this.st = this.realign(st0, tick));
    const gp: GrenadePawn[] = pawns.map((p) => {
      const h = p.crouching ? CROUCHED : STANDING;
      return { id: p.id, team: p.team, alive: p.alive, pos: p.pos, height: h, eye: { x: p.pos.x, y: p.pos.y, z: p.pos.z + (p.crouching ? this.crouchEyeHeight : this.eyeHeight) }, yaw: p.yaw, pitch: p.pitch };
    });
    // `rawTeamDamage`: the host applies its own team-damage ratios (3D, W3), so the engine reports full damage.
    const tuning = opts.rawTeamDamage === true ? { ...this.t, teamDamageScale: 1, selfDamageScale: 1 } : this.t;
    const events = stepGrenades(st.engine, this.world, { pawns: gp, friendlyFire: opts.friendlyFire === true }, { tuning });
    const out: GrenadeOutcome[] = [];
    const host = (seq: number) => st.seqs.find((s) => s.engine === seq);
    for (const e of events) {
      if (e.type === 'detonate') {
        const m = host(e.seq);
        if (m === undefined || e.grenade === 'decoy' || e.grenade === 'incendiary') continue;
        if (e.grenade === 'smoke') {
          // A new cloud: rebuilt from the rounded pop point (as a restore rebuilds it: snapshots keep only the inputs).
          const k = st.engine.smokes.findIndex((q) => q.seq === e.seq);
          const s0 = st.engine.smokes[k];
          if (s0 !== undefined) st.engine.smokes[k] = this.flood(s0.seq, s0.thrower, s0.team, rv(s0.center), s0.popTick);
        }
        out.push({ type: 'pop', seq: m.host, kind: e.grenade, thrower: m.thrower, pos: rv(e.pos) });
      } else if (e.type === 'hurt') {
        const m = host(e.seq);
        if (m === undefined || (e.grenade !== 'he' && e.grenade !== 'molotov')) continue;
        out.push({ type: 'hurt', seq: m.host, kind: e.grenade, thrower: m.thrower, victim: e.victim as PlayerId, damage: roundNumber(e.damage), armorPen: roundNumber(e.armorPen) });
      } else if (e.type === 'blind') {
        const m = host(e.seq);
        const until = blindUntil(e.blind, this.t);
        if (m === undefined || until === null) continue;
        out.push({ type: 'blind', seq: m.host, thrower: m.thrower, victim: e.victim as PlayerId, untilTick: until });
      }
    }
    // Lost projectiles (over the map edge): dropped without a detonation.
    st.engine.projectiles = st.engine.projectiles.filter((p) => p.pos.z > LOST_Z && tick - p.throwTick < LOST_SEC * 64);
    this.normalize();
    const e = st.engine;
    if (e.projectiles.length === 0 && e.smokes.length === 0 && e.infernos.length === 0 && e.decoys.length === 0) this.st = null;
    return out;
  }

  blocks(a: Vec3, b: Vec3, tick: number): boolean {
    return this.st !== null && this.st.engine.smokes.length > 0 && smokeBlocks(this.st.engine, a, b, tick, this.t);
  }

  densityAt(p: Vec3, tick: number): number {
    return this.st === null || this.st.engine.smokes.length === 0 ? 0 : smokeDensityAt(this.st.engine, p, tick, this.t);
  }

  effects(tick: number): GrenadeEffect[] {
    const st = this.st;
    if (st === null) return [];
    const out: GrenadeEffect[] = [];
    const host = (seq: number) => st.seqs.find((s) => s.engine === seq);
    for (const p of st.engine.projectiles) {
      const m = host(p.seq);
      if (m === undefined || p.type === 'decoy' || p.type === 'incendiary') continue;
      const until = p.type === 'smoke' ? p.nextCheckTick : p.throwTick + Math.round((p.type === 'molotov' ? this.t.molotovFuseSec : p.type === 'he' ? this.t.heFuseSec : this.t.flashFuseSec) * 64);
      out.push({ seq: m.host, kind: p.type, phase: 'flying', thrower: m.thrower, pos: rv(p.pos), radius: 0, untilTick: until });
    }
    const v = this.t.smokeVoxel;
    for (const s of st.engine.smokes) {
      const m = host(s.seq);
      if (m === undefined) continue;
      const cells = smokeVoxels(st.engine, s.seq, tick, this.t).map((c) => ({ x: roundNumber(c.pos.x), y: roundNumber(c.pos.y), z: roundNumber(c.pos.z), d: roundNumber(c.density) }));
      // The 2D disc: the footprint's area (distinct voxel columns) as a circle, centred on the columns' mean.
      const cols = new Map<string, { x: number; y: number }>();
      for (const c of cells) cols.set(`${c.x}|${c.y}`, { x: c.x, y: c.y });
      let cx = s.center.x;
      let cy = s.center.y;
      if (cols.size > 0) {
        cx = 0;
        cy = 0;
        for (const c of cols.values()) {
          cx += c.x;
          cy += c.y;
        }
        cx /= cols.size;
        cy /= cols.size;
      }
      const radius = roundNumber(Math.sqrt((cols.size * v * v) / Math.PI));
      out.push({ seq: m.host, kind: 'smoke', phase: 'smoke', thrower: m.thrower, pos: rv({ x: cx, y: cy, z: s.center.z }), radius, untilTick: s.endTick, cells, cellSize: v });
    }
    for (const inf of st.engine.infernos) {
      const m = host(inf.seq);
      if (m === undefined) continue;
      // V5: the burning flames (CS2's inferno: up to 16 fire cells ~42 apart); the 2D disc covers them all.
      const flames = inf.flames.filter((f) => f.bornTick <= tick && tick < f.dieTick).map((f) => rv(f.pos));
      let r = 0;
      for (const f of flames) r = Math.max(r, Math.hypot(f.x - inf.center.x, f.y - inf.center.y));
      const until = inf.flames.reduce((a, f) => Math.max(a, f.dieTick), inf.popTick);
      out.push({ seq: m.host, kind: 'molotov', phase: 'fire', thrower: m.thrower, pos: rv(inf.center), radius: roundNumber(r + this.t.flameRadius), untilTick: until, flames, flameRadius: this.t.flameRadius });
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  active(): boolean {
    return this.st !== null;
  }

  /**
   * The state with each cloud reduced to what makes it (seq, thrower, team, centre, pop tick): a cloud is ~750
   * voxels, too big for every checkpoint, and the hosts make no bullet holes in it (HE holes are kept apart, in
   * `heHoles`), so it is a pure function of those (rebuilt on restore, memoised).
   */
  snapshot(): unknown {
    const st = this.st;
    if (st === null) return null;
    return { ...st, engine: { ...st.engine, smokes: st.engine.smokes.map((q) => ({ seq: q.seq, thrower: q.thrower, team: q.team, center: q.center, popTick: q.popTick })) } };
  }

  restore(s: unknown): void {
    if (s === null || s === undefined) {
      this.st = null;
      return;
    }
    const c = JSON.parse(JSON.stringify(s)) as { engine: Omit<GrenadeState, 'smokes'> & { smokes: { seq: number; thrower: string; team: Team; center: Vec3; popTick: number }[] }; seqs: State['seqs'] };
    const smokes = c.engine.smokes.map((q) => this.flood(q.seq, q.thrower, q.team, q.center, q.popTick));
    const e = c.engine;
    // Older snapshots (S1) had only smokes and projectiles.
    this.st = { engine: { ...e, smokes, infernos: e.infernos ?? [], decoys: e.decoys ?? [], heHoles: e.heHoles ?? [] }, seqs: c.seqs };
  }

  private readonly floods = new Map<string, string>();

  /** createSmoke, rounded like a snapshot, memoised by its inputs (a fresh copy each time: cells are mutable). */
  private flood(seq: number, thrower: string, team: Team, center: Vec3, popTick: number): GrenadeState['smokes'][number] {
    const key = `${seq}|${thrower}|${team}|${center.x}|${center.y}|${center.z}|${popTick}`;
    let text = this.floods.get(key);
    if (text === undefined) {
      text = stableStringify(createSmoke(seq, thrower, team, center, popTick, this.world, this.t));
      if (this.floods.size > 32) this.floods.clear();
      this.floods.set(key, text);
    }
    return JSON.parse(text) as GrenadeState['smokes'][number];
  }

  clear(): void {
    this.st = null;
  }

  /** A state whose clock is behind or ahead of the host's: moved to `tick` (nothing is simulated in between). */
  private realign(st: State, tick: number): State {
    st.engine.tick = tick;
    return st;
  }

  /** Round the engine state like a snapshot would (projectiles keep only their last flight point). */
  private normalize(): void {
    const st = this.st;
    if (st === null) return;
    const e = st.engine;
    for (const p of e.projectiles) {
      p.pos = rv(p.pos);
      p.vel = rv(p.vel);
      p.path = [p.pos];
    }
    if (e.infernos.length > 0) e.infernos = toJsonValue(e.infernos) as unknown as GrenadeState['infernos'];
    if (e.decoys.length > 0) e.decoys = toJsonValue(e.decoys) as unknown as GrenadeState['decoys'];
    if (e.heHoles.length > 0) e.heHoles = toJsonValue(e.heHoles) as unknown as GrenadeState['heHoles'];
  }
}
