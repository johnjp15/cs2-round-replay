/**
 * Can the movement model follow the recorded tracks? Each T pawn is driven along its 10 Hz track
 * from data/round.json by a test-only pure-pursuit controller (no physics changes, no snapping),
 * and its position is compared with the recording at every sample of its alive window.
 * The table this prints is copied into docs/movement.md; see there for the analysis.
 *
 * Two controllers:
 * - `literal`: exactly as specified for C1. Target = track at t + lookahead; input = direction to the
 *   target in the pawn's yaw frame (yaw = bearing of recorded travel), scaled by
 *   distance / (max speed × lookahead), clamped to 1; WALK while the recorded speed < 120.
 * - `wall-aware`: the same, plus two rules a replay controller needs anyway: when the straight line
 *   to the target is not walkable, steer at the latest track point that is (same speed demand); and
 *   don't hold WALK while more than driftNudgeUnits behind the recorded position.
 */
import { describe, expect, it } from 'vitest';
import type { Button } from '../src/contracts/index';
import { TICKS_PER_SEC, maxSpeed, runSpeed, stepMove, type MoveState } from '../src/sim2d/movement';
import { nav, round, tuning, type RoundSample } from './sim2d-fixtures';

const m = tuning.movement;
const LOOKAHEAD = tuning.replay.lookaheadSec; // 0.15 s
const WALK_BELOW = tuning.replay.walkSpeedThreshold; // 120 units/s
const NUDGE = tuning.replay.driftNudgeUnits; // 24 units
const T_IDS = round.players.filter((p) => p.team === 'T').map((p) => p.id);
const DEG = 180 / Math.PI;
/** How far back along the track the wall-aware controller looks for a reachable point. */
const FALLBACK_WINDOW_SEC = 2;

type Controller = 'literal' | 'wall-aware';

interface XY {
  x: number;
  y: number;
}

interface FollowResult {
  id: string;
  mode: Controller;
  samples: number;
  rms: number;
  max: number;
  maxT: number;
  /** % of samples whose recorded speed (vs. the previous sample) exceeds the held weapon's run speed. */
  overSpeedPct: number;
  /** Samples whose recorded speed exceeds twice the run speed (tracking jumps). */
  spikes: number;
  /** % of ticks the nav mesh clipped the move. */
  wallTickPct: number;
  /** Consecutive-sample chords that cross non-walkable space. */
  chordsOffMesh: number;
  errors: { t: number; err: number; recSpeed: number }[];
}

/** Track position at time t (linear between 10 Hz samples, clamped to the ends). */
function trackAt(s: readonly RoundSample[], t: number): XY {
  const first = s[0] as RoundSample;
  const last = s[s.length - 1] as RoundSample;
  if (t <= first.t) return { x: first.x, y: first.y };
  if (t >= last.t) return { x: last.x, y: last.y };
  const i = Math.min(s.length - 2, Math.floor(t * 10 + 1e-9));
  const a = s[i] as RoundSample;
  const b = s[i + 1] as RoundSample;
  const f = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Weapon drawn at time t, from timelines.weapon (falls back to the kit's primary, then the knife). */
function weaponAt(id: string, t: number): string {
  const kit = round.players.find((p) => p.id === id)?.kit;
  let w: string = kit?.primary ?? kit?.secondary ?? 'knife';
  for (const e of round.timelines.weapon[id] ?? []) if (e.t <= t + 1e-9 && e.weapon !== null) w = e.weapon;
  return w;
}

/** Point to steer at. Literal: the track at t + lookahead. Wall-aware: that point, or the latest reachable one. */
function steerPoint(samples: readonly RoundSample[], t: number, pos: XY, mode: Controller): XY {
  const ahead = trackAt(samples, t + LOOKAHEAD);
  if (mode === 'literal' || nav.segmentWalkable(pos, ahead)) return ahead;
  for (let tt = t + LOOKAHEAD - 1 / TICKS_PER_SEC; tt >= Math.max(0, t - FALLBACK_WINDOW_SEC); tt -= 1 / TICKS_PER_SEC) {
    const p = trackAt(samples, tt);
    if (nav.segmentWalkable(pos, p)) return p;
  }
  return ahead;
}

function follow(id: string, mode: Controller): FollowResult {
  const track = round.tracks[id];
  if (track === undefined) throw new Error(`no track for ${id}`);
  const all = track.samples;
  const player = round.players.find((p) => p.id === id);
  const endT = Math.min(player?.deathT ?? track.endT, (all[all.length - 1] as RoundSample).t);
  const samples = all.filter((q) => q.t <= endT + 1e-9);
  const s0 = samples[0] as RoundSample;

  // Start at rest on the first sample, as after a Core teleport.
  let state: MoveState = {
    pos: { x: s0.x, y: s0.y, z: nav.zAt({ x: s0.x, y: s0.y, z: s0.z }) },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    crouching: false,
      onGround: true,
      jumpHeld: false,
      stamina: 0,
  };
  let yaw = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] as RoundSample;
    const b = samples[i] as RoundSample;
    if (Math.hypot(b.x - a.x, b.y - a.y) > 0.5) {
      yaw = Math.atan2(b.y - a.y, b.x - a.x) * DEG;
      break;
    }
  }

  const lastTick = Math.ceil(endT * TICKS_PER_SEC);
  const states: MoveState[] = [state];
  let wallTicks = 0;
  for (let k = 0; k < lastTick; k++) {
    const t = k / TICKS_PER_SEC;
    const now = trackAt(samples, t);
    const ahead = trackAt(samples, t + LOOKAHEAD);
    const steer = steerPoint(samples, t, state.pos, mode);
    // Yaw = bearing of recorded travel (the 10 Hz segment containing t); kept while standing still.
    const i = Math.min(samples.length - 2, Math.floor(t * 10 + 1e-9));
    const a = samples[i] as RoundSample;
    const b = samples[i + 1] ?? a;
    if (Math.hypot(b.x - a.x, b.y - a.y) > 0.5) yaw = Math.atan2(b.y - a.y, b.x - a.x) * DEG;
    // Recorded speed over the pursuit window.
    const recSpeed = Math.hypot(ahead.x - now.x, ahead.y - now.y) / LOOKAHEAD;
    const lagging = mode === 'wall-aware' && Math.hypot(now.x - state.pos.x, now.y - state.pos.y) > NUDGE;
    const buttons: Button[] = recSpeed < WALK_BELOW && !lagging ? ['WALK'] : [];
    const weapon = weaponAt(id, t);
    const dx = steer.x - state.pos.x;
    const dy = steer.y - state.pos.y;
    // Speed demand from the distance to the scheduled point (the steer point itself for `literal`).
    const behind = Math.hypot(ahead.x - state.pos.x, ahead.y - state.pos.y);
    const scale = Math.min(1, behind / (maxSpeed(weapon, buttons, m) * LOOKAHEAD));
    const rel = Math.atan2(dy, dx) - yaw / DEG;
    const moving = dx !== 0 || dy !== 0;
    const forward = moving ? Math.cos(rel) * scale : 0;
    const side = moving ? -Math.sin(rel) * scale : 0;
    const r = stepMove(state, { forward, side, yaw, pitch: 0, buttons }, weapon, nav, m);
    if (r.clipped) wallTicks++;
    state = r.state;
    states.push(state);
  }

  const errors: FollowResult['errors'] = [];
  let sumSq = 0;
  let max = 0;
  let maxT = 0;
  let over = 0;
  let spikes = 0;
  let chordsOffMesh = 0;
  samples.forEach((q, i) => {
    // Model position at the sample's exact time (between two ticks).
    const f = q.t * TICKS_PER_SEC;
    const k0 = Math.min(states.length - 1, Math.floor(f));
    const k1 = Math.min(states.length - 1, k0 + 1);
    const p0 = (states[k0] as MoveState).pos;
    const p1 = (states[k1] as MoveState).pos;
    const u = f - k0;
    const err = Math.hypot(p0.x + (p1.x - p0.x) * u - q.x, p0.y + (p1.y - p0.y) * u - q.y);
    let recSpeed = 0;
    if (i > 0) {
      const prev = samples[i - 1] as RoundSample;
      recSpeed = Math.hypot(q.x - prev.x, q.y - prev.y) / (q.t - prev.t);
      const cap = runSpeed(weaponAt(id, q.t), m);
      if (recSpeed > cap) over++;
      if (recSpeed > 2 * cap) spikes++;
      if (!nav.segmentWalkable(prev, q)) chordsOffMesh++;
    }
    errors.push({ t: q.t, err, recSpeed });
    sumSq += err * err;
    if (err > max) {
      max = err;
      maxT = q.t;
    }
  });
  return {
    id,
    mode,
    samples: samples.length,
    rms: Math.sqrt(sumSq / samples.length),
    max,
    maxT,
    overSpeedPct: (100 * over) / Math.max(1, samples.length - 1),
    spikes,
    wallTickPct: (100 * wallTicks) / Math.max(1, lastTick),
    chordsOffMesh,
    errors,
  };
}

function table(rows: readonly FollowResult[]): string {
  const lines = [
    '| player | controller | samples | RMS | max (at t) | rec. speed > model max | > 2× (spikes) | ticks on a wall | chords off-mesh |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.mode} | ${r.samples} | ${r.rms.toFixed(1)} | ${r.max.toFixed(0)} (${r.maxT.toFixed(1)} s) | ` +
        `${r.overSpeedPct.toFixed(1)} % | ${r.spikes} | ${r.wallTickPct.toFixed(1)} % | ${r.chordsOffMesh} |`,
    );
  }
  return lines.join('\n');
}

describe('follow the recorded T tracks with the movement model', () => {
  const literal = T_IDS.map((id) => follow(id, 'literal'));
  const wallAware = T_IDS.map((id) => follow(id, 'wall-aware'));
  const rows = T_IDS.flatMap((_id, i) => [literal[i] as FollowResult, wallAware[i] as FollowResult]);

  it('prints the per-player tracking table (units; run with --reporter=verbose to see it)', () => {
    console.log(`[follow-track] lookahead ${LOOKAHEAD} s, WALK below ${WALK_BELOW} u/s\n${table(rows)}`);
    for (const r of wallAware) {
      const worst = [...r.errors].sort((a, b) => b.err - a.err).slice(0, 3);
      console.log(`[follow-track] ${r.id} worst: ${worst.map((e) => `t=${e.t.toFixed(1)} err=${e.err.toFixed(0)} rec=${e.recSpeed.toFixed(0)}u/s`).join(', ')}`);
    }
    expect(T_IDS).toEqual(['barely', 'cart', 'donk', 'eradicate', 'snarlbot']);
    for (const r of rows) expect(Number.isFinite(r.rms)).toBe(true);
  });

  it("cart's recorded track is followable: RMS < 24 units (wall-aware pursuit)", () => {
    const cart = wallAware.find((r) => r.id === 'cart');
    expect(cart?.rms).toBeLessThan(24);
  });

  it('the literal controller gets stuck on walls where the wall-aware one does not (documents the gap)', () => {
    const lit = literal.find((r) => r.id === 'cart') as FollowResult;
    const aware = wallAware.find((r) => r.id === 'cart') as FollowResult;
    expect(lit.wallTickPct).toBeGreaterThan(aware.wallTickPct);
  });
});
