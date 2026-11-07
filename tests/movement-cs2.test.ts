/**
 * M1: the movement model (src/sim2d/movement.ts `stepMove3d`) pinned to CS2 / Source 2 behaviour, number by number.
 * Every expected value comes from a cited formula and a cited constant (docs/movement.md "CS2 verification (M1)"
 * has the source of each): the CS2 convar dump (SteamDatabase/GameTracking-CS2 `DumpSource2/convars.txt`), the
 * CS2 weapon data (`weapons.vdata`, same repo), Source SDK 2013 `src/game/shared/gamemovement.cpp` (the algorithms
 * CS2's movement descends from) and Valve's release notes. The reference functions below (`ref*`) are line-by-line
 * transcriptions of the Source functions, written independently of the model, so a test compares the model against
 * the formula, and the pinned numbers show what the formula gives.
 *
 * Tests the current model fails are `it.skip` / `it.todo` with the reason (the findings table in docs/movement.md).
 */
import { describe, expect, it } from 'vitest';
import type { Button } from '../src/contracts/index';
import { MapGeometry } from '../src/sim2d/geometry';
import { TICK_DT, fallDamageFor, restingState, stepMove3d, type MoveInput, type MoveState } from '../src/sim2d/movement';
import { tuning } from './sim2d-fixtures';

const m = tuning.movement;
const DT = TICK_DT;

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic worlds (as tests/movement3d.test.ts)
// ---------------------------------------------------------------------------------------------------------------------

function meshOf(tris: number[][]): MapGeometry {
  const verts: number[] = [];
  const idx: number[] = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      idx.push(verts.length / 3);
      verts.push(Math.round((t[k * 3] as number) * 8), Math.round((t[k * 3 + 1] as number) * 8), Math.round((t[k * 3 + 2] as number) * 8));
    }
  }
  return new MapGeometry({ quant: 8, verts: Int32Array.from(verts), tris: Int32Array.from(idx) });
}
const floorQuad = (x0: number, y0: number, x1: number, y1: number, z: number): number[][] => [
  [x0, y0, z, x1, y0, z, x1, y1, z],
  [x0, y0, z, x1, y1, z, x0, y1, z],
];
const wallX = (x: number, y0: number, y1: number, z0: number, z1: number): number[][] => [
  [x, y0, z0, x, y1, z0, x, y1, z1],
  [x, y0, z0, x, y1, z1, x, y0, z1],
];

const FLAT = meshOf(floorQuad(-8000, -8000, 8000, 8000, 0));
/** Flat floor with a step of height h starting at x = 100 (a box top at z = h for x ≥ 100). */
const stepWorld = (h: number): MapGeometry => meshOf([...floorQuad(-2000, -2000, 100, 2000, 0), ...wallX(100, -2000, 2000, 0, h), ...floorQuad(100, -2000, 2000, 2000, h)]);

const inp = (forward: number, side: number, yaw: number, buttons: Button[] = []): MoveInput => ({ forward, side, yaw, pitch: 0, buttons });
const hspeed = (s: MoveState): number => Math.hypot(s.vel.x, s.vel.y);
const at = (vx: number, vy = 0): MoveState => ({ ...restingState({ x: 0, y: 0, z: 0 }), vel: { x: vx, y: vy, z: 0 } });

/** Speeds (signed along +x) after each tick of `ticks` ticks with input plan(k). */
function runX(start: MoveState, ticks: number, plan: (k: number) => MoveInput | null, weapon: string, g: MapGeometry = FLAT): { v: number[]; x: number[]; states: MoveState[] } {
  let s = start;
  const v: number[] = [];
  const x: number[] = [];
  const states: MoveState[] = [];
  for (let k = 0; k < ticks; k++) {
    s = stepMove3d(s, plan(k), weapon, g, m).state;
    v.push(s.vel.x);
    x.push(s.pos.x);
    states.push(s);
  }
  return { v, x, states };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reference: Source SDK 2013 gamemovement.cpp, one axis (x), CS2 convars
// ---------------------------------------------------------------------------------------------------------------------

/** CGameMovement::Friction (gamemovement.cpp:1610-1676): no change below 0.1 u/s; control = max(speed, sv_stopspeed). */
function refFriction(v: number): number {
  const speed = Math.abs(v);
  if (speed < 0.1) return v;
  const control = speed < m.svStopSpeed ? m.svStopSpeed : speed;
  const newspeed = Math.max(speed - control * m.svFriction * DT, 0);
  return (v * newspeed) / speed;
}
/**
 * CGameMovement::Accelerate (gamemovement.cpp:1820-1851): accelspeed = accel × frametime × scale × surfaceFriction, capped
 * by addspeed = wishspeed − v·wishdir. `scale` = wishspeed in Source; CS2 with sv_accelerate_use_weapon_speed scales by
 * the weapon's speed (docs/movement.md, "accelScaleFloor"), so walking and crouching accelerate at the weapon's rate.
 */
function refAccelerate(v: number, dir: number, wishspeed: number, scale: number): number {
  if (dir === 0 || wishspeed === 0) return v;
  const addspeed = wishspeed - v * dir;
  if (addspeed <= 0) return v;
  return v + Math.min(m.svAccelerate * DT * scale, addspeed) * dir;
}
/** One ground tick: FullWalkMove's Friction, then WalkMove's Accelerate and its `spd < 1 → 0` (gamemovement.cpp:1966-1973). */
function refGroundTick(v: number, dir: number, wishspeed: number, scale: number): number {
  const a = refAccelerate(refFriction(v), dir, wishspeed, scale);
  return Math.abs(a) < 1 ? 0 : a;
}
function refRun(v0: number, ticks: number, plan: (k: number, v: number) => [dir: number, wish: number, scale: number]): number[] {
  const out: number[] = [];
  let v = v0;
  for (let k = 0; k < ticks; k++) {
    const [d, w, sc] = plan(k, v);
    v = refGroundTick(v, d, w, sc);
    out.push(v);
  }
  return out;
}
const firstIndex = (xs: readonly number[], pred: (x: number) => boolean): number => xs.findIndex(pred) + 1;

// ---------------------------------------------------------------------------------------------------------------------

describe('CS2 convar defaults (GameTracking-CS2 DumpSource2/convars.txt @ cce7bf1f, 2026-11-05)', () => {
  it('the movement tunables equal the CS2 defaults', () => {
    expect(m.svAccelerate).toBe(5.5); // sv_accelerate 5.5
    expect(m.svFriction).toBe(5.2); // sv_friction 5.2
    expect(m.svStopSpeed).toBe(80); // sv_stopspeed 80
    expect(m.airAccelerate).toBe(12); // sv_airaccelerate 12
    expect(m.airMaxWishSpeed).toBe(30); // sv_air_max_wishspeed 30
    expect(m.gravity).toBe(800); // sv_gravity 800
    expect(m.jumpImpulse).toBe(301.99338); // sv_jump_impulse 301.99338 ("sqrt(2*gravity*height)": √(2·800·57) = 301.993377)
    expect(Math.sqrt(2 * 800 * 57)).toBeCloseTo(301.99338, 5);
    expect(m.maxVelocity).toBe(3500); // sv_maxvelocity 3500
    expect(m.stepSize).toBe(18); // sv_stepsize 18
    expect(m.standableNormal).toBe(0.7); // sv_standable_normal 0.7 (= sv_walkable_normal 0.7)
    expect(m.staminaMax).toBe(80); // sv_staminamax 80 "Maximum stamina penalty"
    expect(m.staminaRecoveryRate).toBe(60); // sv_staminarecoveryrate 60
    expect(m.fallDamageScale).toBe(1); // sv_falldamage_scale 1
    expect(m.landSoundSpeed).toBe(260); // sv_min_jump_landing_sound 260
  });

  it('item run speeds equal CS2 weapons.vdata m_flMaxSpeed (primary mode)', () => {
    const vdata: Record<string, number> = { knife: 250, ak47: 215, awp: 200, ssg08: 230, deagle: 230, m4a1: 225, m4a4: 225, famas: 220, galil: 215, glock: 240, c4: 250, smoke: 245, flash: 245, he: 245, molotov: 245 };
    for (const [w, v] of Object.entries(vdata)) expect(m.runSpeedByWeapon[w], w).toBe(v);
  });
});

describe('ground acceleration from rest (Friction + Accelerate, sv_accelerate_use_weapon_speed 1)', () => {
  for (const [weapon, cap, ticksToCap, first] of [
    ['ak47', 215, 36, 18.4765625],
    ['knife', 250, 35, 21.484375],
  ] as const) {
    it(`${weapon}: +${first} u/s on the first tick (5.5 × ${cap} / 64), the cap ${cap} on tick ${ticksToCap}, 95 % on tick 28`, () => {
      const model = runX(restingState({ x: 0, y: 0, z: 0 }), 40, () => inp(1, 0, 0), weapon);
      const ref = refRun(0, 40, () => [1, cap, cap]);
      for (let k = 0; k < 40; k++) expect(model.v[k], `tick ${k + 1}`).toBeCloseTo(ref[k] as number, 9);
      expect(ref[0]).toBe(first);
      expect(firstIndex(ref, (v) => v >= cap)).toBe(ticksToCap);
      expect(firstIndex(ref, (v) => v >= 0.95 * cap)).toBe(28);
      // CS2 measurement: "Going from 0 to 250 u/s takes 35 ticks with desubticked binds" (docs/movement.md, M1 sources).
    });
  }

  it('speed never exceeds the cap with straight input, and holds exactly at it', () => {
    const r = runX(restingState({ x: 0, y: 0, z: 0 }), 64, () => inp(1, 0, 0), 'ak47');
    for (const v of r.v) expect(v).toBeLessThanOrEqual(215 + 1e-9);
    expect(r.v[63]).toBeCloseTo(215, 9);
  });
});

describe('counter-strafing (AK-47 at 215 u/s, accurate at ≤ 0.34 × 215 = 73.1 u/s)', () => {
  // Pressing the opposite key: per tick v ← v − v·5.2/64 − 5.5·215/64 (friction at v > 80, then 18.477 u/s of
  // acceleration against the motion); releasing: friction alone, v·(1 − 5.2/64) above 80, then −6.5 u/s per tick.
  const counter = [179.0546875, 146.029931640625, 115.68843719482422, 87.81218917274475, 62.20088630245924, 37.22432380245924, 12.247761302459235, -12.728801197540765];

  it('opposite key: 179.05, 146.03, 115.69, 87.81, 62.20 (accurate on tick 5 = 78 ms), 37.22, 12.25, then −12.73 (moving back) on tick 8', () => {
    const model = runX(at(215), 8, () => inp(-1, 0, 0), 'ak47');
    const ref = refRun(215, 8, () => [-1, 215, 215]);
    for (let k = 0; k < 8; k++) {
      expect(ref[k], `ref tick ${k + 1}`).toBeCloseTo(counter[k] as number, 6);
      expect(model.v[k], `model tick ${k + 1}`).toBeCloseTo(ref[k] as number, 9);
    }
    expect(firstIndex(ref, (v) => Math.abs(v) <= 0.34 * 215)).toBe(5);
  });

  it('the classic counter-strafe: opposite key for 7 ticks (109 ms), then release: stopped on tick 9, 10.09 units travelled', () => {
    const plan = (k: number): MoveInput | null => (k < 7 ? inp(-1, 0, 0) : null);
    const model = runX(at(215), 12, plan, 'ak47');
    const ref = refRun(215, 12, (k) => (k < 7 ? [-1, 215, 215] : [0, 0, 0]));
    for (let k = 0; k < 12; k++) expect(model.v[k], `tick ${k + 1}`).toBeCloseTo(ref[k] as number, 9);
    expect(ref[7]).toBeCloseTo(12.247761302459235 - 6.5, 9); // friction floor: 80 × 5.2 / 64 = 6.5 u/s per tick
    expect(ref[8]).toBe(0);
    const dist = ref.reduce((d, v) => d + v * DT, 0);
    expect(dist).toBeCloseTo(10.0938, 3);
    expect(model.x[11]).toBeCloseTo(dist, 6);
  });

  it('release only (friction alone): accurate on tick 13 (203 ms), stopped on tick 24 (375 ms) after 30.9 units', () => {
    const model = runX(at(215), 30, () => null, 'ak47');
    const ref = refRun(215, 30, () => [0, 0, 0]);
    for (let k = 0; k < 30; k++) expect(model.v[k], `tick ${k + 1}`).toBeCloseTo(ref[k] as number, 9);
    expect(firstIndex(ref, (v) => v <= 73.1)).toBe(13);
    expect(firstIndex(ref, (v) => v === 0)).toBe(24);
    expect(ref.reduce((d, v) => d + v * DT, 0)).toBeCloseTo(30.91, 2);
  });

  it('knife at 250: opposite key reaches ≤ 85 u/s (0.34 × 250) on tick 5 too', () => {
    const ref = refRun(250, 10, () => [-1, 250, 250]);
    const model = runX(at(250), 10, () => inp(-1, 0, 0), 'knife');
    for (let k = 0; k < 10; k++) expect(model.v[k]).toBeCloseTo(ref[k] as number, 9);
    expect(firstIndex(ref, (v) => Math.abs(v) <= 85)).toBe(5);
  });
});

describe('walking (×0.52) and crouching (×0.34), accelerating at the weapon rate', () => {
  for (const [label, buttons, cap] of [
    ['walk', ['WALK'], 215 * 0.52],
    ['crouch', ['DUCK'], 215 * 0.34],
  ] as const) {
    it(`AK-47 ${label}: cap ${cap.toFixed(1)} u/s, +18.48 u/s per tick (5.5 × 215 / 64), the reference curve tick by tick`, () => {
      const model = runX(restingState({ x: 0, y: 0, z: 0 }), 20, () => inp(1, 0, 0, [...buttons]), 'ak47');
      const ref = refRun(0, 20, () => [1, cap, 215]);
      for (let k = 0; k < 20; k++) expect(model.v[k], `tick ${k + 1}`).toBeCloseTo(ref[k] as number, 9);
      expect(Math.max(...model.v)).toBeCloseTo(cap, 9);
    });
  }
  it('pins: walk reaches its cap 111.8 on tick 10 (95 % on tick 9), crouch 73.1 on tick 6', () => {
    expect(firstIndex(refRun(0, 20, () => [1, 111.8, 215]), (v) => v >= 111.8 - 1e-9)).toBe(10);
    expect(firstIndex(refRun(0, 20, () => [1, 73.1, 215]), (v) => v >= 73.1 - 1e-9)).toBe(6);
  });
});

describe('small speeds (Source zeroes a ground speed below 1 u/s)', () => {
  it.skip('FINDING M1-1: a tick ending below 1 u/s on the ground stops dead (WalkMove `spd < 1.0f` → Init, gamemovement.cpp:1966-1973); the model keeps 0.5 u/s', () => {
    // 7 u/s, no input: friction drop 6.5 → 0.5 u/s, which Source zeroes.
    expect(refGroundTick(7, 0, 0, 0)).toBe(0);
    const s = stepMove3d(at(7), null, 'ak47', FLAT, m).state;
    expect(hspeed(s)).toBe(0);
  });
});

describe('jumping (sv_jump_impulse 301.99338, sv_gravity 800, sv_jump_precision_enable 1)', () => {
  it('apex 56.9975 (≈ impulse² / 2g = 57.0), lands on tick 48 (0.75 s), one jump per press (sv_autobunnyhopping 0)', () => {
    let s = restingState({ x: 0, y: 0, z: 0 });
    let apex = 0;
    let landed = 0;
    let jumps = 0;
    for (let k = 1; k <= 80; k++) {
      const r = stepMove3d(s, inp(0, 0, 0, ['JUMP']), 'knife', FLAT, m);
      if (r.jumped) jumps++;
      s = r.state;
      apex = Math.max(apex, s.pos.z);
      if (landed === 0 && k > 1 && s.onGround) landed = k;
    }
    expect((301.99338 * 301.99338) / 1600).toBeCloseTo(57.0, 3);
    expect(apex).toBeCloseTo(56.9975, 3);
    expect(landed).toBe(48);
    expect(jumps).toBe(1);
  });

  it.skip('FINDING M1-2: sv_enablebunnyhopping 0 clamps the take-off speed to 1.1 × max speed ("Allow jump speed to exceed 1.1x max speed"); the model keeps 300', () => {
    // On the ground at 300 u/s with a knife (max 250), JUMP, no move keys: CheckJumpButton crops the velocity to
    // 1.1 × 250 = 275 before the air move (as PreventBunnyJumping, tf_gamemovement.cpp:1092-1112, with CS2's factor 1.1).
    const s = stepMove3d(at(300), inp(0, 0, 0, ['JUMP']), 'knife', FLAT, m).state;
    expect(hspeed(s)).toBeCloseTo(275, 6);
  });

  it('a take-off at or under 1.1 × max speed keeps its speed (250 → 250 on the jump tick, no friction in the air)', () => {
    const s = stepMove3d(at(250), inp(0, 0, 0, ['JUMP']), 'knife', FLAT, m).state;
    expect(s.onGround).toBe(false);
    expect(hspeed(s)).toBeCloseTo(250, 9);
  });
});

describe('air movement (AirAccelerate, sv_airaccelerate 12, sv_air_max_wishspeed 30)', () => {
  /**
   * AirAccelerate (gamemovement.cpp:1705-1745): wishspd = min(wishspeed, 30); addspeed = wishspd − v·wishdir;
   * accelspeed = min(12 × wishspeed × dt × surfaceFriction, addspeed). surfaceFriction is 0.25 after a
   * CategorizePosition that found no ground while moving up at ≤ 140 u/s (gamemovement.cpp:3866-3877), else 1.
   */
  function refAir(v: number, thetaDeg: number, wishspeed: number, sf: number): number {
    const c = Math.cos((thetaDeg * Math.PI) / 180);
    const sn = Math.sin((thetaDeg * Math.PI) / 180);
    const add = Math.min(wishspeed, 30) - v * c;
    if (add <= 0) return v;
    const a = Math.min(12 * wishspeed * DT * sf, add);
    return Math.hypot(v + a * c, a * sn);
  }
  /** Airborne at 250 u/s along +x, high above the floor, falling (vz −100) unless `vz` says otherwise. */
  const airborne = (vz = -100): MoveState => ({ ...restingState({ x: 0, y: 0, z: 1000 }), vel: { x: 250, y: 0, z: vz }, onGround: false });

  for (const theta of [90, 60, 120, 45, 0, 180]) {
    it(`falling, wish ${theta}° from the velocity: one tick of air acceleration (knife wishspeed 250)`, () => {
      const s = stepMove3d(airborne(), inp(1, 0, theta), 'knife', FLAT, m).state;
      expect(hspeed(s)).toBeCloseTo(refAir(250, theta, 250, 1), 9);
    });
  }

  it('pins: the best angle is 90° (+30 u/s sideways, 250 → 251.794), 0° adds nothing (already past the 30 cap)', () => {
    expect(refAir(250, 90, 250, 1)).toBeCloseTo(Math.sqrt(250 * 250 + 900), 9);
    expect(refAir(250, 90, 250, 1) - 250).toBeCloseTo(1.794, 3);
    expect(refAir(250, 0, 250, 1)).toBe(250);
    expect(refAir(250, 180, 250, 1)).toBeCloseTo(250 - 46.875, 9); // 12 × 250 / 64 = 46.875 u/s against the motion
  });

  it.skip('FINDING M1-3: while rising at ≤ 140 u/s, air acceleration is a quarter (surfaceFriction 0.25); the model uses full air acceleration', () => {
    // vz +100 at the end of the last tick = +106.25 at its CategorizePosition (before FinishGravity's half step).
    const s = stepMove3d(airborne(100), inp(1, 0, 90), 'knife', FLAT, m).state;
    expect(hspeed(s)).toBeCloseTo(refAir(250, 90, 250, 0.25), 9); // 250 → 250.2746 (11.72 u/s sideways)
  });

  it('rising faster than 140 u/s (just after take-off) the air acceleration is full', () => {
    const s = stepMove3d(airborne(200), inp(1, 0, 90), 'knife', FLAT, m).state;
    expect(hspeed(s)).toBeCloseTo(refAir(250, 90, 250, 1), 9);
  });
});

describe('falling (FinishGravity half steps, fall damage per Source shareddefs.h:415-421)', () => {
  it('gravity integrates in two half steps: from rest in the air, vz −12.5 and z −0.0977 after one tick', () => {
    const s = stepMove3d({ ...restingState({ x: 0, y: 0, z: 1000 }), onGround: false }, null, 'knife', FLAT, m).state;
    expect(s.vel.z).toBeCloseTo(-12.5, 9);
    expect(s.pos.z).toBeCloseTo(1000 - 6.25 * DT, 9);
  });
  it('damage = (v − 580) × 100 / (1024 − 580) × sv_falldamage_scale: 0 at 580, 50 at 802, 100 at 1024', () => {
    expect(fallDamageFor(580, m)).toBe(0);
    expect(fallDamageFor(802, m)).toBe(50);
    expect(fallDamageFor(1024, m)).toBe(100);
  });
});

describe('steps and slopes (sv_stepsize 18, sv_standable_normal 0.7)', () => {
  for (const [h, climbs] of [
    [18, true],
    [19, false],
  ] as const) {
    it(`walking into a ${h}-unit step ${climbs ? 'climbs it' : 'is stopped'}`, () => {
      const r = runX({ ...restingState({ x: 60, y: 0, z: 0 }) }, 40, () => inp(1, 0, 0), 'knife', stepWorld(h));
      const end = r.states[39] as MoveState;
      if (climbs) {
        expect(end.pos.x).toBeGreaterThan(150);
        expect(end.pos.z).toBeCloseTo(h, 1);
      } else {
        expect(end.pos.x).toBeLessThan(100);
        expect(end.pos.z).toBeLessThan(1);
      }
    });
  }
  it('the standable limit 0.7 is a 45.57° slope (CS:GO Mapper’s Reference: "walkable if at most 45.573°")', () => {
    expect((Math.acos(m.standableNormal) * 180) / Math.PI).toBeCloseTo(45.573, 3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// KZ (Kreedz climbing) mechanics in vanilla CS2. Jump-stat definitions from CS2KZ (KZGlobalTeam/cs2kz-metamod @ 317449df):
// distance = 32 + the 2D distance from take-off to landing origin (src/kz/jumpstats/kz_jumpstats.cpp:676-697); the
// vanilla-mode (VNL) LJ tiers are 215 / 230 / 235 / 240 / 245 / 248 (src/kz/mode/kz_mode_vnl.h:9).
// ---------------------------------------------------------------------------------------------------------------------

const heading = (s: MoveState): number => (Math.atan2(s.vel.y, s.vel.x) * 180) / Math.PI;

/** The best ground wish angle from the velocity (Friction then Accelerate, scanned at 0.05°) and the speed it gives. */
function refPrestrafe(v: number, wish: number): { v: number; theta: number } {
  const vf = refFriction(v);
  let best = vf;
  let bt = 0;
  for (let i = 0; i <= 3600; i++) {
    const th = (i / 3600) * Math.PI;
    const u = vf * Math.cos(th);
    const add = wish - u;
    if (add <= 0) continue;
    const a = Math.min(m.svAccelerate * DT * wish, add);
    const n = Math.hypot(vf + a * Math.cos(th), a * Math.sin(th));
    if (n > best) {
      best = n;
      bt = (th * 180) / Math.PI;
    }
  }
  return { v: best, theta: bt };
}

interface Jump {
  readonly ticks: number;
  readonly distance: number;
  readonly landSpeed: number;
  readonly final: MoveState;
}
/** A long jump from (0, 0, 0) at `v0` along +x: JUMP on tick 1 (held), then `strafe` picks the air input each tick. */
function longJump(v0: number, weapon: string, strafe: (s: MoveState) => MoveInput | null): Jump {
  let s: MoveState = at(v0);
  let k = 0;
  for (;;) {
    k++;
    const i = k === 1 ? inp(0, 0, 0, ['JUMP']) : strafe(s);
    s = stepMove3d(s, i === null ? inp(0, 0, 0, ['JUMP']) : { ...i, buttons: ['JUMP'] }, weapon, FLAT, m).state;
    if ((k > 1 && s.onGround) || k > 200) break;
  }
  return { ticks: k, distance: 32 + Math.hypot(s.pos.x, s.pos.y), landSpeed: hspeed(s), final: s };
}
/** Tool-assisted strafes: every tick the wish is perpendicular to the velocity, turning back towards +x (W + mouse). */
const tasStrafe = (s: MoveState): MoveInput => inp(1, 0, heading(s) + (heading(s) > 0 ? -90 : 90));

describe('KZ: ground pre-strafe (turning while running, Source Friction + Accelerate)', () => {
  it('knife: the best wish angle is 14.40° off the velocity and the speed settles at 256.79 u/s (2.7 % over 250); AK-47 220.84', () => {
    for (const [weapon, cap, pre] of [
      ['knife', 250, 256.7928],
      ['ak47', 215, 220.8418],
    ] as const) {
      let v: number = cap;
      for (let k = 0; k < 400; k++) v = refPrestrafe(v, cap).v;
      expect(v).toBeCloseTo(pre, 3);
      expect(refPrestrafe(v, cap).theta).toBeCloseTo(14.4, 1);
      // The model, driven at that angle (W held, the view turned 14.4° ahead of the velocity every tick):
      let s = at(cap);
      for (let k = 0; k < 400; k++) s = stepMove3d(s, inp(1, 0, heading(s) + 14.4), weapon, FLAT, m).state;
      expect(hspeed(s)).toBeCloseTo(pre, 2);
    }
  });
});

describe('KZ: long jump (LJ) from 250 u/s with a knife', () => {
  it('no strafes: 48 ticks in the air, 250 × 48 / 64 + 32 = 219.5 units (VNL tier 1 "215")', () => {
    const j = longJump(250, 'knife', () => null);
    expect(j.ticks).toBe(48);
    expect(j.distance).toBeCloseTo(219.5, 6);
    expect(j.landSpeed).toBeCloseTo(250, 9);
  });
  it('tool-assisted strafes (wish ⊥ velocity every tick, full air acceleration): 247.72 units, landing at 323.7 u/s (model before M1-3)', () => {
    const j = longJump(250, 'knife', tasStrafe);
    expect(j.ticks).toBe(48);
    expect(j.distance).toBeCloseTo(247.722, 2);
    expect(j.landSpeed).toBeCloseTo(323.728, 2);
  });
  it('air acceleration per tick for the held item: 12 × wishspeed / 64 = 46.875 (knife), 40.3125 (AK-47); the 30 u/s wish cap limits what it adds', () => {
    const fall = (w: string): number => hspeed(stepMove3d({ ...restingState({ x: 0, y: 0, z: 1000 }), vel: { x: 0, y: 0, z: -100 }, onGround: false }, inp(1, 0, 0), w, FLAT, m).state);
    expect(fall('knife')).toBeCloseTo(30, 9); // from rest the add is capped at 30, not 46.875
    expect(fall('ak47')).toBeCloseTo(30, 9);
    const back = (w: string, v: number): number => stepMove3d({ ...restingState({ x: 0, y: 0, z: 1000 }), vel: { x: v, y: 0, z: -100 }, onGround: false }, inp(-1, 0, 0), w, FLAT, m).state.vel.x;
    expect(back('knife', 250)).toBeCloseTo(250 - 46.875, 9);
    expect(back('ak47', 215)).toBeCloseTo(215 - 40.3125, 9);
  });
});

describe('KZ: bunnyhops (sv_autobunnyhopping 0, sv_enablebunnyhopping 0, sv_bhop_time_window 0.0078 s)', () => {
  /** Airborne just above the floor, falling at 300 u/s, moving `v` along +x: lands on the next tick. */
  const landing = (v: number): MoveState => ({ ...restingState({ x: 0, y: 0, z: 1 }), vel: { x: v, y: 0, z: -300 }, onGround: false });

  it('holding JUMP through a landing does not jump again (a fresh press is needed)', () => {
    let s = landing(250);
    const jumped: boolean[] = [];
    for (let k = 0; k < 4; k++) {
      const r = stepMove3d({ ...s, jumpHeld: true }, inp(0, 0, 0, ['JUMP']), 'knife', FLAT, m);
      jumped.push(r.jumped);
      s = r.state;
    }
    expect(jumped).toEqual([false, false, false, false]);
  });
  it('a perfect hop (fresh press on the first tick on the ground) keeps the speed: no friction, no landing slowdown (CheckJumpButton before Friction)', () => {
    const l = stepMove3d(landing(250), null, 'knife', FLAT, m).state;
    expect(l.onGround).toBe(true);
    const r = stepMove3d(l, inp(0, 0, 0, ['JUMP']), 'knife', FLAT, m);
    expect(r.jumped).toBe(true);
    expect(hspeed(r.state)).toBeCloseTo(hspeed(l), 9);
  });
  it('one tick late: a tick of friction (× (1 − 5.2/64)) and the landing slowdown (model: × (100 − 0.05 × land speed) / 100) are lost first', () => {
    const l = stepMove3d(landing(250), null, 'knife', FLAT, m);
    const penalty = l.state.stamina;
    expect(penalty).toBeCloseTo(0.05 * l.landSpeed, 9);
    const late = stepMove3d(l.state, null, 'knife', FLAT, m).state;
    const after = Math.max(0, penalty - 60 * DT);
    expect(hspeed(late)).toBeCloseTo(hspeed(l.state) * (1 - 5.2 / 64) * ((100 - after) / 100), 6);
  });
  it.skip('FINDING M1-2: a hop landing at 300 u/s with a knife takes off at 275 (1.1 × 250); the model keeps 300', () => {
    const l = stepMove3d(landing(300), null, 'knife', FLAT, m).state;
    const r = stepMove3d(l, inp(0, 0, 0, ['JUMP']), 'knife', FLAT, m);
    expect(hspeed(r.state)).toBeCloseTo(275, 6);
  });
});

describe('KZ: crouch jump, edges, surf', () => {
  it('crouch jump: the feet reach 56.9975 + 9 (in-air duck) = 66.0, so 66-unit boxes are just reachable (CS2 de_ancient A box)', () => {
    let s = restingState({ x: 0, y: 0, z: 0 });
    let top = 0;
    for (let k = 0; k < 60; k++) {
      s = stepMove3d(s, inp(0, 0, 0, k === 0 ? ['JUMP'] : ['JUMP', 'DUCK']), 'knife', FLAT, m).state;
      top = Math.max(top, s.pos.z);
    }
    expect(top).toBeCloseTo(56.9975 + m.airDuckLift, 2);
  });
  it('standing on an edge: a hull with 1 unit of its 32 over the ledge stays on the ground (box hull, 2-unit ground check); 1 unit past the edge it falls', () => {
    const ledge = meshOf([...floorQuad(-2000, -2000, 0, 2000, 100), ...wallX(0, -2000, 2000, 0, 100), ...floorQuad(-2000, -2000, 2000, 2000, 0)]);
    const on = stepMove3d({ ...restingState({ x: 15, y: 0, z: 100 }) }, null, 'knife', ledge, m).state;
    expect(on.onGround).toBe(true);
    expect(on.pos.z).toBeCloseTo(100, 6);
    const off = stepMove3d({ ...restingState({ x: 17, y: 0, z: 100 }) }, null, 'knife', ledge, m).state;
    expect(off.onGround).toBe(false);
  });
  it('surf: on a 60° ramp (normal z 0.5 < 0.7) the pawn is never on the ground and slides down at g · sin 60° = 692.8 u/s²', () => {
    const t = Math.tan(Math.PI / 3);
    // A ramp rising towards +x: z = x · tan 60°.
    const ramp = meshOf([
      [-2000, -2000, -2000 * t, 2000, -2000, 2000 * t, 2000, 2000, 2000 * t],
      [-2000, -2000, -2000 * t, 2000, 2000, 2000 * t, -2000, 2000, -2000 * t],
    ]);
    let s: MoveState = { ...restingState({ x: 0, y: 0, z: 16 * t + 0.5 }), onGround: false };
    for (let k = 0; k < 32; k++) {
      s = stepMove3d(s, null, 'knife', ramp, m).state;
      expect(s.onGround).toBe(false);
    }
    const speed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    expect(speed / (800 * Math.sin(Math.PI / 3) * 0.5)).toBeGreaterThan(0.95);
    expect(speed / (800 * Math.sin(Math.PI / 3) * 0.5)).toBeLessThan(1.05);
    expect(s.vel.x).toBeLessThan(0); // down the ramp
  });
});

describe('not modelled yet (findings without a fix in M1)', () => {
  it.todo('FINDING M1-4 (tagging): a hit lowers the victim’s speed cap to flinch × mp_tagging_scale (m_flVelocityModifier); movement needs a velocity-modifier input');
  it.todo('FINDING M1-5 (scoped speeds): AWP 100, SCAR-20 / G3SG1 120, AUG / SG 553 150 scoped (weapons.vdata m_flMaxSpeed[1]); movement needs a run-speed override from the weapon state');
  it.todo('FINDING M1-6 (duck transition): CS2 ducks over time (m_flDuckAmount at m_flDuckSpeed, 8 when rested; sv_timebetweenducks 0.4); the model crouches instantly. Rate not verifiable from public sources.');
  it.todo('FINDING M1-7 (sub-tick input): CS2 splits a tick at each key change; the model applies input per tick');
  it.todo('FINDING M1-15 (ladders): CS2 ladders (sv_ladder_scale_speed 0.78, ladder jumps "LAJ") need ladder volumes the Mirage geometry does not have; Mirage ladders are walls');
});
