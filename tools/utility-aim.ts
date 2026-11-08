/**
 * S1: aim the recorded throws that have a measured landing (`utility[].landing`, V0/S1, docs/round-data.md) for the
 * CS2 grenade engine the hosts throw smokes with (src/sim3d/smokes.ts, docs/grenades.md "Aiming at a landing"). Called
 * by tools/snap-tracks.ts, which writes the result into data/geometry/mirage-tracks.json (`utility`); `applyTracks3d`
 * puts it into the round as `utility[].aim` and the Core releases the throw with those angles.
 *
 * The throw is solved from where the puppet is at the release: the snapped track at the release tick (the recorded
 * tick − the input latency, Core `ScriptPlan`) and its velocity there, capped at the grenade's run speed (the puppet
 * holds the grenade while it pulls the pin). Full strength only (the hosts' grenades are released from ATTACK).
 * Only smokes: flashes, HE and molotovs are still the hosts' 2D model.
 */
import type { MovementTuning, PlayerId, RoundData, Tuning } from '../src/contracts/index';
import type { Tracks3dUtilityAim } from '../src/contracts/tracks3d';
import { runSpeedOf } from '../src/core/index';
import { aimAtLanding } from '../src/engine/grenades/index';
import type { MapGeometry } from '../src/sim2d/geometry';
import { MeshGrenadeWorld } from '../src/sim3d/smokes';

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** The snapped track's position (linear between samples) and velocity at `tick` (central difference over ±2 samples). */
export function trackStateAt(round: RoundData, id: PlayerId, tick: number, m: MovementTuning, weapon: string): { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } } {
  const s = round.tracks[id]?.samples ?? [];
  let i = s.findIndex((q) => q.tick >= tick);
  if (i < 0) i = s.length - 1;
  const b = s[i] as (typeof s)[number];
  const a = s[Math.max(0, i - 1)] as (typeof s)[number];
  const f = b.tick === a.tick ? 0 : (tick - a.tick) / (b.tick - a.tick);
  const pos = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
  const p = s[Math.max(0, i - 2)] as (typeof s)[number];
  const n = s[Math.min(s.length - 1, i + 1)] as (typeof s)[number];
  const dt = (n.tick - p.tick) / 64;
  let vx = dt > 0 ? (n.x - p.x) / dt : 0;
  let vy = dt > 0 ? (n.y - p.y) / dt : 0;
  const sp = Math.hypot(vx, vy);
  const cap = runSpeedOf(weapon, m);
  if (sp > cap) {
    vx *= cap / sp;
    vy *= cap / sp;
  }
  return { pos, vel: { x: vx, y: vy, z: 0 } };
}

/** Aims for every smoke in `round` (snapped tracks applied) with a landing, in utility order. */
export function utilityAims(round: RoundData, world: MapGeometry, tuning: Tuning): Tracks3dUtilityAim[] {
  const out: Tracks3dUtilityAim[] = [];
  const w = new MeshGrenadeWorld(world);
  const cfg = { tuning: tuning.grenades.cs2 };
  for (const u of round.utility) {
    if (u.landing === null || u.kind !== 'smoke') continue;
    const release = u.tick - tuning.replay.inputLatencyTicks;
    const st = trackStateAt(round, u.thrower, release, tuning.movement, u.kind);
    const eye = { x: st.pos.x, y: st.pos.y, z: st.pos.z + tuning.damage.eyeHeight };
    const a = aimAtLanding({ type: 'smoke', thrower: u.thrower, team: round.players.find((p) => p.id === u.thrower)?.team ?? 'T', eye, velocity: st.vel }, u.landing, w, cfg, { strengths: [1] });
    const l = a.landing ?? { x: 0, y: 0, z: 0 };
    out.push({ tick: u.tick, thrower: u.thrower, pitch: round3(a.pitch), yaw: round3(a.yaw), landing: [Math.round(l.x), Math.round(l.y), Math.round(l.z)], error: Math.round(a.error) });
  }
  return out;
}
