/**
 * S1 / V5: aim the recorded throws for the CS2 grenade engine the hosts throw every grenade with (src/sim3d/grenades.ts,
 * docs/grenades.md "Aiming at a landing"). Called by tools/snap-tracks.ts, which writes the result into
 * data/geometry/mirage-tracks.json (`utility`); `applyTracks3d` puts it into the round as `utility[].aim` and the Core
 * releases the throw with those angles.
 *
 * The target is the measured landing (`utility[].landing`, V0/S1, docs/round-data.md) where the video shows it, with its
 * detonation time when the video shows that too (`landing.t`: the search then weighs the pop time against the spot,
 * V5 #88); otherwise an assumed one (`ASSUMED_TARGETS` below, V5 #91: the flashes, the HE and the molotov, which the
 * hosts used to throw with the 2D model's flat-ground pitch). The 4.8, 5.6 and 29.8 s smokes have neither and keep the
 * default throw (track yaw, `throwPitchDeg`) on the engine, as since S1.
 *
 * The throw is solved from where the puppet is at the release: the snapped track at the release tick (the recorded
 * tick − the input latency, Core `ScriptPlan`) and its velocity there, capped at the grenade's run speed (the puppet
 * holds the grenade while it pulls the pin). Full strength only (the hosts' grenades are released from ATTACK).
 */
import type { GrenadeId, MovementTuning, PlayerId, RoundData, Tuning, Vec3 } from '../src/contracts/index';
import type { Tracks3dUtilityAim } from '../src/contracts/tracks3d';
import { runSpeedOf } from '../src/core/index';
import { aimAtLanding, type AimOptions, type GrenadePawn } from '../src/engine/grenades/index';
import type { MapGeometry } from '../src/sim2d/geometry';
import { MeshGrenadeWorld } from '../src/sim3d/grenades';

/**
 * V5 (#91): where the recorded throws the video never shows land, as assumptions (docs/round-data.md "Grenade landings":
 * none of these is on camera), keyed "<t> <thrower> <kind>". The point is the detonation: a flash's or HE's in the air
 * or on the floor where it is 1.5 s after the release, a molotov's burst on the floor. Each is chosen so the throw does
 * what the frames allow and no more: no T is blinded (the video's eradicate is not, and the other Ts' frames show no
 * flash), and nothing bursts where a POV the video shows would see it.
 */
export const ASSUMED_TARGETS: Readonly<Record<string, { readonly at: Vec3; readonly why: string; readonly opts?: AimOptions }>> = {
  '7.8 snarlbot flash': {
    at: { x: 400, y: -1690, z: 300 },
    why: 'popped high over the Palace roofs south-west of him, toward A (Palace Alley is open to the south, docs/round-data.md); it blinds nobody, and no POV the video shows has it',
  },
  '8.8 donk flash': {
    at: { x: -650, y: 470, z: -220 },
    why: "down the Tunnel Stairs into the underpass (south-west, the clear way from his spot): below the Back Alley floor, out of every T's sight; eradicate's view at 8.8-10 s shows no pop and he is not blinded",
  },
  '17.8 barely he': {
    at: { x: -1920, y: 600, z: -160 },
    why: "out of the Apartments window, over the Balcony railing and down toward B (it is in the air there at 1.5 s): cart's POV 19.17-19.5 s, looking out over the Balcony, shows no explosion; no damage row",
  },
  '19.2 donk molotov': {
    at: { x: -2330, y: 800, z: -125 },
    why: "out of the Apartments window over cart's head and the Balcony railing to the Truck platform by the van (cart's POV 19.25-20.2 s: its line ends at the van); west of cart's way down to B and behind every view of his 19.4-22.5 s, which show no fire",
  },
};

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

function key(u: { readonly t: number; readonly thrower: PlayerId; readonly kind: GrenadeId }): string {
  return `${u.t} ${u.thrower} ${u.kind}`;
}

/** Aims for every throw in `round` (snapped tracks applied) with a measured or an assumed target, in utility order. */
export function utilityAims(round: RoundData, world: MapGeometry, tuning: Tuning): Tracks3dUtilityAim[] {
  for (const k of Object.keys(ASSUMED_TARGETS)) {
    const u = round.utility.find((q) => key(q) === k);
    if (u === undefined) throw new Error(`ASSUMED_TARGETS: no recorded throw "${k}"`);
    if (u.landing !== null) throw new Error(`ASSUMED_TARGETS: "${k}" has a measured landing`);
  }
  const out: Tracks3dUtilityAim[] = [];
  const w = new MeshGrenadeWorld(world);
  const cfg = { tuning: tuning.grenades.cs2 };
  for (const u of round.utility) {
    const assumed = ASSUMED_TARGETS[key(u)];
    const target = u.landing ?? assumed?.at ?? null;
    if (target === null) continue;
    const release = u.tick - tuning.replay.inputLatencyTicks;
    const st = trackStateAt(round, u.thrower, release, tuning.movement, u.kind);
    const eye = { x: st.pos.x, y: st.pos.y, z: st.pos.z + tuning.damage.eyeHeight };
    // V5 (#88): a measured pop time too. simulateThrow counts the release tick, so its seconds are the host's + 1 tick.
    // The rest checks put a smoke's pop on a 0.2 s grid, so the search runs on a fine grid (0.5 deg yaw, 1.25 deg pitch).
    const timed = u.landing?.t === undefined ? {} : { targetSec: u.landing.t - u.t + 1 / 64, restSlackTicks: 4, yawStep: 0.5, pitchStep: 1.25, pitchMin: -30, pitchMax: 25 };
    // V5: the other players where their tracks have them during the flight: a grenade bounces off them and a molotov
    // bursts on them (donk's 19.2 s molotov flies over cart's head in the video, not into it).
    const pawnsAt = (k: number): GrenadePawn[] =>
      round.players
        .filter((p) => p.id !== u.thrower && (p.deathTick === null || p.deathTick > release + k))
        .map((p) => {
          const q = trackStateAt(round, p.id, release + k, tuning.movement, 'knife').pos;
          return { id: p.id, team: p.team, alive: true, pos: q, height: 72, eye: { x: q.x, y: q.y, z: q.z + tuning.damage.eyeHeight }, yaw: 0, pitch: 0 };
        })
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const a = aimAtLanding({ type: u.kind, thrower: u.thrower, team: round.players.find((p) => p.id === u.thrower)?.team ?? 'T', eye, velocity: st.vel }, target, w, cfg, { strengths: [1], pawnsAt, ...assumed?.opts, ...timed });
    const l = a.landing ?? { x: 0, y: 0, z: 0 };
    out.push({
      tick: u.tick,
      thrower: u.thrower,
      pitch: round3(a.pitch),
      yaw: round3(a.yaw),
      landing: [Math.round(l.x), Math.round(l.y), Math.round(l.z)],
      error: Math.round(a.error),
      sec: round3(a.sec - 1 / 64),
      ...(assumed === undefined ? {} : { assumed: true }),
    });
  }
  return out;
}
