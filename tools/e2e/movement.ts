/**
 * V1 · movement jump-stats at CS2 competitive defaults (sv_airaccelerate 12, sv_air_max_wishspeed 30, no auto-bhop).
 *
 *   npx tsx tools/e2e/movement.ts        (npm run test:e2e:movement)
 *
 * Counter-strafe stop time / distance, walk and crouch speeds, crouch timing, jump height and air time, crouch-jump,
 * single long jumps (standing and run-up; no strafe, a constant-rate "good player" strafe, a TAS ceiling), a 10-hop
 * bunny-hop chain with perfect and one-tick-late timing, air strafe gain per second, fall damage. Everything is
 * `stepMove3d` (the movement both hosts run) on a flat CS2-style mesh; one sequence is replayed through Sim3DHost to show
 * the host moves the human identically. Jump distance = 32 + the 2D distance take-off → landing origin (KZ convention).
 */
import type { Button } from '../../src/contracts/index';
import { TICK_DT, restingState, stepMove3d, type MoveInput, type MoveState } from '../../src/sim2d/movement';
import { HUMAN, f, floorQuad, input as hostInput, meshOf, range, rangeHost, table, tuning, wallX } from './common';

const m = tuning.movement;
const FLAT = range(null);
const DEG = 180 / Math.PI;
const hs = (s: MoveState): number => Math.hypot(s.vel.x, s.vel.y);

function step(s: MoveState, inp: MoveInput | null, weapon: string, g = FLAT): ReturnType<typeof stepMove3d> {
  return stepMove3d(s, inp, weapon, g, m);
}
const inp = (forward: number, side: number, yaw: number, buttons: Button[] = []): MoveInput => ({ forward, side, yaw, pitch: 0, buttons });

/** Run along +x at full speed from rest for 2 s. */
function atSpeed(weapon: string, buttons: Button[] = []): MoveState {
  let s = restingState({ x: 0, y: 0, z: 0 });
  for (let k = 0; k < 128; k++) s = step(s, inp(1, 0, 0, buttons), weapon).state;
  return s;
}

function accelReport(): string {
  const rows: (string | number)[][] = [];
  for (const [w, b, label] of [
    ['ak47', [], 'AK run'],
    ['knife', [], 'knife run'],
    ['ak47', ['WALK'], 'AK walk (shift)'],
    ['knife', ['WALK'], 'knife walk'],
    ['ak47', ['DUCK'], 'AK crouch'],
    ['ak47', ['DUCK', 'WALK'], 'AK crouch + walk'],
  ] as [string, Button[], string][]) {
    let s = restingState({ x: 0, y: 0, z: 0 });
    let t95 = -1;
    let tCap = -1;
    const cap = hs(atSpeed(w, b));
    for (let k = 1; k <= 128; k++) {
      s = step(s, inp(1, 0, 0, b), w).state;
      if (t95 < 0 && hs(s) >= 0.95 * cap) t95 = k;
      if (tCap < 0 && hs(s) >= cap - 1e-6) tCap = k;
    }
    rows.push([label, f(cap, 2), `${t95} (${f(t95 * TICK_DT * 1000, 0)} ms)`, `${tCap} (${f(tCap * TICK_DT * 1000, 0)} ms)`]);
  }
  return table(['case', 'max speed u/s', 'ticks to 95 %', 'ticks to max'], rows);
}

function stopReport(): string {
  const rows: (string | number)[][] = [];
  for (const w of ['ak47', 'knife', 'awp', 'deagle']) {
    const run = m.runSpeedByWeapon[w] ?? 250;
    for (const mode of ['counter-strafe (opposite key until stopped)', 'counter-strafe 7 ticks then release', 'release only'] as const) {
      let s = atSpeed(w);
      const x0 = s.pos.x;
      let accurate = -1;
      let stopped = -1;
      for (let k = 1; k <= 64; k++) {
        const opposite = mode === 'counter-strafe (opposite key until stopped)' ? s.vel.x > 0 : mode === 'counter-strafe 7 ticks then release' && k <= 7;
        s = step(s, inp(opposite ? -1 : 0, 0, 0), w).state;
        if (accurate < 0 && hs(s) <= 0.34 * run) accurate = k;
        if (stopped < 0 && (hs(s) < 1e-6 || s.vel.x <= 0)) {
          stopped = k;
          break;
        }
      }
      rows.push([w, run, mode, `${accurate} (${f(accurate * 15.625, 0)} ms)`, `${stopped} (${f(stopped * 15.625, 0)} ms)`, f(s.pos.x - x0, 1)]);
    }
  }
  return table(['weapon', 'run u/s', 'stop', 'accurate (≤ 34 %) after', 'stopped after', 'distance u'], rows);
}

/** One jump from rest; feet height per tick until landing. Optional DUCK from tick `duckAt`. */
function jump(duckAt: number | null): { apex: number; ticks: number; apexTick: number } {
  let s = restingState({ x: 0, y: 0, z: 0 });
  let apex = 0;
  let apexTick = 0;
  for (let k = 0; k < 200; k++) {
    const b: Button[] = k === 0 ? ['JUMP'] : [];
    if (duckAt !== null && k >= duckAt) b.push('DUCK');
    s = step(s, inp(0, 0, 0, b), 'knife').state;
    if (s.pos.z > apex) {
      apex = s.pos.z;
      apexTick = k + 1;
    }
    if (k > 0 && s.onGround) return { apex, ticks: k + 1, apexTick };
  }
  return { apex, ticks: -1, apexTick };
}

/** Strafe controller: the side key and the yaw that puts the wish direction at angle `off` (deg) from the velocity. */
function strafeInput(s: MoveState, dirSign: 1 | -1, off: number, buttons: Button[] = []): MoveInput {
  const vAng = Math.atan2(s.vel.y, s.vel.x) * DEG;
  const phi = vAng + dirSign * off; // wish direction
  // side −1 (left) → wish = yaw + 90; side +1 (right) → wish = yaw − 90
  return dirSign > 0 ? inp(0, -1, phi - 90, buttons) : inp(0, 1, phi + 90, buttons);
}

/** Best wish offset for one tick on one side (max speed after the tick). */
function bestOff(s: MoveState, sign: 1 | -1, weapon: string, g = FLAT): number {
  let best = 90;
  let bv = -1;
  for (let off = 30; off <= 120; off += 0.25) {
    const v = hs(step(s, strafeInput(s, sign, off), weapon, g).state);
    if (v > bv) {
      bv = v;
      best = off;
    }
  }
  return best;
}

interface Lj {
  readonly dist: number;
  readonly takeoff: number;
  readonly land: number;
  readonly ticks: number;
}

/**
 * One long jump. `runup`: ticks of W before the jump (0 = standing). Air: 'none' | 'tas' (greedy best angle, `strafes`
 * alternating) | 'human' (constant mouse turn rate per strafe, `rate` deg/tick, the key switched each strafe).
 */
function longJump(weapon: string, runup: number, air: 'none' | 'tas' | 'human', strafes: number, rate = 0, duckFrom = Infinity): Lj {
  let s = restingState({ x: 0, y: 0, z: 0 });
  for (let k = 0; k < runup; k++) s = step(s, inp(1, 0, 0), weapon).state;
  const take = { x: s.pos.x, y: s.pos.y };
  const takeoff = hs(s);
  s = step(s, inp(runup > 0 ? 1 : 0, 0, 0, ['JUMP']), weapon).state;
  const airTicks = 47;
  const per = Math.max(1, Math.round(airTicks / Math.max(1, strafes)));
  let yaw = 0;
  for (let k = 1; k < 200; k++) {
    const strafe = Math.floor((k - 1) / per);
    const sign: 1 | -1 = strafe % 2 === 0 ? 1 : -1;
    let i: MoveInput;
    const b: Button[] = k >= duckFrom ? ['DUCK'] : [];
    if (air === 'none') i = inp(0, 0, 0, b);
    else if (air === 'tas') i = strafeInput(s, sign, bestOff(s, sign, weapon), b);
    else {
      // a player: the view turns at `rate` deg/tick toward the strafe side, holding A (left turn) or D (right turn)
      yaw += sign * rate;
      i = sign > 0 ? inp(0, -1, yaw, b) : inp(0, 1, yaw, b);
    }
    s = step(s, i, weapon).state;
    if (s.onGround) return { dist: 32 + Math.hypot(s.pos.x - take.x, s.pos.y - take.y), takeoff, land: hs(s), ticks: k + 1 };
  }
  return { dist: NaN, takeoff, land: hs(s), ticks: -1 };
}

function ljReport(): string {
  const rows: (string | number)[][] = [];
  for (const [weapon, runup, duckFrom] of [
    ['knife', 0, Infinity],
    ['knife', 128, Infinity],
    ['knife', 128, 30],
    ['ak47', 0, Infinity],
    ['ak47', 128, Infinity],
  ] as [string, number, number][]) {
    {
      const none = longJump(weapon, runup, 'none', 0, 0, duckFrom);
      let tas: Lj = none;
      let tasN = 0;
      for (const n of [1, 2, 3, 4, 5, 6, 8]) {
        const r = longJump(weapon, runup, 'tas', n, 0, duckFrom);
        if (r.dist > tas.dist) {
          tas = r;
          tasN = n;
        }
      }
      let hum: Lj = none;
      let humN = 0;
      let humRate = 0;
      for (const n of [2, 3, 4, 5, 6]) {
        for (let rate = 0.5; rate <= 6; rate += 0.25) {
          const r = longJump(weapon, runup, 'human', n, rate, duckFrom);
          if (r.dist > hum.dist) {
            hum = r;
            humN = n;
            humRate = rate;
          }
        }
      }
      const label = `${weapon}, ${runup === 0 ? 'standing (from rest)' : 'run-up (2 s of W)'}${Number.isFinite(duckFrom) ? `, DUCK from air tick ${duckFrom}` : ''}`;
      rows.push([label, f(none.takeoff, 1), f(none.dist, 1), `${f(hum.dist, 1)} (${humN} strafes, ${f(humRate * 64, 0)}°/s; lands ${f(hum.land, 0)} u/s)`, `${f(tas.dist, 1)} (${tasN} strafes; lands ${f(tas.land, 0)} u/s)`]);
    }
  }
  return table(['jump', 'take-off u/s', 'no strafe u', 'best constant-rate strafes ("good player") u', 'TAS ceiling u'], rows);
}

/** Bunny-hop chain: run up, then 10 hops; TAS strafe in the air; press JUMP `late` ticks after landing. */
function bhopReport(): string {
  const rows: (string | number)[][] = [];
  for (const weapon of ['knife', 'ak47']) {
    for (const late of [0, 1, 2]) {
      let s = atSpeed(weapon);
      let path = 0;
      let k: number;
      const takeoffs: number[] = [];
      const lands: number[] = [];
      let sign: 1 | -1 = 1;
      let groundTicks = 0;
      let hops = 0;
      let jumpHeldPrev = false;
      for (k = 0; k < 64 * 12 && hops < 10; k++) {
        const prev: MoveState['pos'] = s.pos;
        if (s.onGround) {
          const press: boolean = groundTicks >= late && !jumpHeldPrev;
          const r = step(s, inp(press ? 0 : 1, 0, Math.atan2(s.vel.y, s.vel.x) * DEG, press ? ['JUMP'] : []), weapon);
          jumpHeldPrev = press;
          groundTicks++;
          if (r.jumped) {
            takeoffs.push(hs(r.state));
            hops++;
            groundTicks = 0;
          }
          s = r.state;
          path += 0;
        } else {
          jumpHeldPrev = false;
          // strafe toward alternating sides every 12 ticks of air
          const r = step(s, strafeInput(s, sign, bestOff(s, sign, weapon)), weapon);
          if ((k % 12) === 11) sign = sign > 0 ? -1 : 1;
          if (r.state.onGround) {
            lands.push(hs(r.state));
            groundTicks = 0;
          }
          s = r.state;
        }
        path += Math.hypot(s.pos.x - prev.x, s.pos.y - prev.y);
      }
      const cap = 1.1 * (m.runSpeedByWeapon[weapon] ?? 250);
      rows.push([
        weapon,
        late === 0 ? 'perfect (first ground tick)' : `${late} tick${late > 1 ? 's' : ''} late`,
        takeoffs.map((v) => f(v, 0)).join(', '),
        lands.map((v) => f(v, 0)).join(', '),
        f(Math.max(...takeoffs), 1),
        f(cap, 1),
        f(path / (k * TICK_DT), 0),
      ]);
    }
  }
  return table(['weapon', 'timing', 'take-off speeds u/s (hops 1–10)', 'landing speeds u/s', 'max take-off', '1.1 × run', 'mean path speed u/s'], rows);
}

/** Air strafe gain per second while falling (no rise friction), from 250 / 215, TAS and a 90° fixed angle. */
function airGainReport(): string {
  const tall = meshOf(floorQuad(-20000, -20000, 20000, 20000, -100000));
  const rows: (string | number)[][] = [];
  for (const weapon of ['knife', 'ak47']) {
    const v0 = m.runSpeedByWeapon[weapon] ?? 250;
    let s: MoveState = { ...restingState({ x: 0, y: 0, z: 0 }), onGround: false, vel: { x: v0, y: 0, z: -1 } };
    let s90 = s;
    for (let k = 0; k < 64; k++) {
      s = step(s, strafeInput(s, 1, bestOff(s, 1, weapon, tall)), weapon, tall).state;
      s90 = step(s90, strafeInput(s90, 1, 90), weapon, tall).state;
    }
    rows.push([weapon, v0, f(hs(s) - v0, 1), f(hs(s90) - v0, 1)]);
  }
  return table(['weapon', 'start u/s', 'TAS gain in 1 s of falling u/s', 'wish 90° to velocity, gain in 1 s u/s'], rows);
}

function fallReport(): string {
  const rows: (string | number)[][] = [];
  for (const h of [64, 128, 200, 220, 222, 223, 230, 250, 300, 400, 500, 600]) {
    const g = meshOf([...floorQuad(-2000, -2000, 0, 2000, h), ...wallX(0, -2000, 2000, 0, h), ...floorQuad(0, -2000, 2000, 2000, 0)]);
    let s = restingState({ x: -40, y: 0, z: h });
    let dmg = 0;
    let land = 0;
    for (let k = 0; k < 400; k++) {
      const r = step(s, inp(1, 0, 0, ['WALK']), 'knife', g);
      s = r.state;
      if (r.landSpeed > 0) {
        dmg = r.fallDamage;
        land = r.landSpeed;
        break;
      }
    }
    rows.push([h, f(land, 1), dmg]);
  }
  return table(['drop height u (walk off)', 'landing speed u/s', 'fall damage HP'], rows);
}

/** The same counter-strafe + jump sequence through Sim3DHost (the human): positions equal stepMove3d's? */
function hostCheck(): string {
  const h = rangeHost(1, { weapon: 'ak47', wall: null });
  let s: MoveState | null = null;
  let worst = 0;
  const plan = (k: number): { side: number; buttons: Button[] } => (k < 80 ? { side: -1, buttons: [] } : k < 87 ? { side: 1, buttons: [] } : k === 100 ? { side: 0, buttons: ['JUMP'] } : { side: 0, buttons: [] });
  for (let k = 0; k < 160; k++) {
    const p0 = h.observe().pawns.find((q) => q.id === HUMAN);
    if (p0 === undefined) break;
    if (s === null) s = { ...restingState(p0.pos), vel: p0.vel, onGround: p0.onGround };
    const pl = plan(k);
    h.setHumanInput(hostInput({ side: pl.side, buttons: pl.buttons }));
    h.tick();
    s = step(s, inp(0, pl.side, 0, pl.buttons), 'ak47').state;
    const p = h.observe().pawns.find((q) => q.id === HUMAN);
    if (p === undefined) break;
    worst = Math.max(worst, Math.hypot(p.pos.x - s.pos.x, p.pos.y - s.pos.y, p.pos.z - s.pos.z));
  }
  return `Sim3DHost (human cart) vs stepMove3d over a 160-tick strafe / counter-strafe / jump plan: worst position difference ${worst.toExponential(2)} u.`;
}

function main(): void {
  const j = jump(null);
  const cj = jump(10);
  console.log(`### Acceleration and speeds\n\n${accelReport()}\n`);
  console.log(`### Stopping from full speed\n\n${stopReport()}\n`);
  console.log(
    `### Jump\n\nStanding jump: apex ${f(j.apex, 4)} u at tick ${j.apexTick}, lands on tick ${j.ticks} (${f(j.ticks * TICK_DT, 3)} s). ` +
      `Jump then crouch (DUCK from tick 10): feet apex ${f(cj.apex, 2)} u. Crouch (DUCK) is instant: the hull and eye switch on the press tick (CS2: gradual).\n`,
  );
  console.log(`### Long jumps (distance = 32 + horizontal take-off → landing)\n\n${ljReport()}\n`);
  console.log(`### Bunny-hop chain (10 hops, TAS air strafes)\n\n${bhopReport()}\n`);
  console.log(`### Air strafing\n\n${airGainReport()}\n`);
  console.log(`### Fall damage\n\n${fallReport()}\n`);
  console.log(hostCheck());
}

main();
