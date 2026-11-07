/**
 * S1: smoke grenades on H5's CS2 grenade engine (`src/engine/grenades`, docs/grenades.md) for both hosts
 * (`SmokeEngine`, src/sim2d/grenades.ts): the CS2 throw law, the projectile with bounces on the world mesh (no player
 * clips: they don't stop grenades), the rest check, the flood-filled volumetric cloud with its growth and fade, and
 * the eye-to-eye smoke test. Flashes, HE and molotovs stay on the hosts' 2D model for now.
 *
 * Determinism across snapshots: a host snapshot rounds numbers to 6 decimals (`toJsonValue`), so the projectile's
 * position and velocity are rounded the same way after every throw and step, and a restored run continues exactly
 * like the live one. Only the last flight point is kept (`path`), so snapshots stay small.
 */
import { roundNumber, stableStringify, type GrenadeCs2Tuning, type PlayerId, type Team, type Vec3 } from '../contracts/index';
import {
  createGrenadeState,
  smokeBlocks,
  smokeDensityAt,
  smokeVoxels,
  stepGrenades,
  throwGrenade,
  type GrenadePawn,
  type GrenadeState,
  type GrenadeWorld,
  type HullTrace,
} from '../engine/grenades/index';
import type { GrenadeEffect, MapGeometry, SmokeEngine, SmokePawn, SmokePop } from '../sim2d/index';

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
  /** engine seq → host seq, thrower. */
  readonly seqs: { readonly engine: number; readonly host: number; readonly thrower: PlayerId }[];
}

const STANDING = 72;
const CROUCHED = 54;

function rv(v: Vec3): Vec3 {
  return { x: roundNumber(v.x), y: roundNumber(v.y), z: roundNumber(v.z) };
}

export class Cs2Smokes implements SmokeEngine {
  private st: State | null = null;
  private readonly world: GrenadeWorld;

  /** `eyeHeight` / `crouchEyeHeight`: the host's (tuning.damage), for the pawns' eyes. */
  constructor(world: MapGeometry, private readonly t: GrenadeCs2Tuning, private readonly eyeHeight: number, private readonly crouchEyeHeight: number) {
    this.world = new MeshGrenadeWorld(world);
  }

  throwSmoke(tick: number, seq: number, thrower: PlayerId, team: Team, eye: Vec3, pitch: number, yaw: number, velocity: Vec3): void {
    if (this.st === null || this.st.engine.tick !== tick) this.st = { engine: createGrenadeState(1, tick), seqs: [] };
    const st = this.st;
    const r = throwGrenade(st.engine, { type: 'smoke', thrower, team, eye, pitch, yaw, strength: 1, velocity }, this.world, { tuning: this.t });
    st.seqs.push({ engine: r.seq, host: seq, thrower });
    this.normalize();
  }

  step(tick: number, pawns: readonly SmokePawn[]): SmokePop[] {
    const st = this.st;
    if (st === null) return [];
    if (st.engine.tick !== tick) {
      // A host never skips a tick with a smoke up (set_round clears); be safe: realign the clock.
      st.engine.tick = tick;
    }
    const gp: GrenadePawn[] = pawns.map((p) => {
      const h = p.crouching ? CROUCHED : STANDING;
      return { id: p.id, team: p.team, alive: p.alive, pos: p.pos, height: h, eye: { x: p.pos.x, y: p.pos.y, z: p.pos.z + (p.crouching ? this.crouchEyeHeight : this.eyeHeight) }, yaw: p.yaw, pitch: p.pitch };
    });
    const events = stepGrenades(st.engine, this.world, { pawns: gp, friendlyFire: false }, { tuning: this.t });
    const pops: SmokePop[] = [];
    for (const e of events) {
      if (e.type !== 'smoke_start') continue;
      // A new cloud: round it as a snapshot would (its centre and grid come from the unrounded impact point).
      st.engine.smokes = JSON.parse(stableStringify(st.engine.smokes)) as GrenadeState['smokes'];
      const m = st.seqs.find((s) => s.engine === e.seq);
      if (m !== undefined) pops.push({ seq: m.host, thrower: m.thrower, pos: rv(e.pos) });
    }
    this.normalize();
    if (st.engine.projectiles.length === 0 && st.engine.smokes.length === 0) this.st = null;
    return pops;
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
      if (m === undefined) continue;
      out.push({ seq: m.host, kind: 'smoke', phase: 'flying', thrower: m.thrower, pos: rv(p.pos), radius: 0, untilTick: p.nextCheckTick });
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
    return out.sort((a, b) => a.seq - b.seq);
  }

  active(): boolean {
    return this.st !== null;
  }

  snapshot(): unknown {
    return this.st;
  }

  restore(s: unknown): void {
    this.st = s === null || s === undefined ? null : (JSON.parse(JSON.stringify(s)) as State);
  }

  clear(): void {
    this.st = null;
  }

  /** Round the projectiles like a snapshot would and keep only their last flight point. */
  private normalize(): void {
    const st = this.st;
    if (st === null) return;
    for (const p of st.engine.projectiles) {
      p.pos = rv(p.pos);
      p.vel = rv(p.vel);
      p.path = [p.pos];
    }
  }
}
