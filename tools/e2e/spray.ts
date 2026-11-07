/**
 * V1 · AK-47 sprays and first-shot accuracy through the 3D host (Sim3DHost), as a player gets them.
 *
 *   npx tsx tools/e2e/spray.ts [--n 1000] [--json out.json]        (npm run test:e2e:spray)
 *
 * (a) 30-round wall sprays standing still, no recoil control; (b) scripted perfect recoil control (the view moves the
 * inverse of data/weapons.json's mean pattern before each bullet); (c) the camera vs the bullet with the Recoil
 * tracking setting at 0.45 and 1.0. Then the first-shot cone standing / crouched / walking / running / counter-strafed /
 * jumping, the spray's cone growth, and the recovery after 1 / 5 / 10 / 30 bullets. Degrees, and units at 500 u.
 */
import { writeFileSync } from 'node:fs';
import { parseWeaponTable } from '../../src/engine/weapons/index';
import type { Button } from '../../src/contracts/index';
import { DEG, HUMAN, f, input, mean, quantile, rangeHost, shotAngles, table, unitsAt, weaponsJson } from './common';

const args = process.argv.slice(2);
const argOf = (k: string, d: string): string => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] !== undefined ? (args[i + 1] as string) : d;
};
const N = Number(argOf('--n', '1000'));
const D = 500;
const WALL = 1024;
const pattern = parseWeaponTable(weaponsJson).sprays['ak47'] ?? [];

interface Hit {
  pitch: number;
  yaw: number;
  /** Camera angles (what the screen centre shows) on the tick of the shot, at tracking 0.45 and 1.0. */
  cam45: { pitch: number; yaw: number };
  cam100: { pitch: number; yaw: number };
}

function spray(seed: number, control: boolean, bullets = 30): Hit[] {
  const h = rangeHost(seed, { wall: WALL });
  const hits: Hit[] = [];
  for (let t = 0; hits.length < bullets && t < 600; t++) {
    const p = pattern[hits.length] as readonly [number, number];
    const view = control ? { pitch: -p[0], yaw: -p[1] } : { pitch: 0, yaw: 0 };
    // What the screen shows on the frame the trigger is pulled (before the tick that fires): the camera at 0.45 / 1.0.
    const cam45 = h.aimView(HUMAN, view, 0.45).camera;
    const cam100 = h.aimView(HUMAN, view, 1).camera;
    h.setHumanInput(input({ ...view, buttons: ['ATTACK'] }));
    h.tick();
    for (const s of h.shots()) {
      if (s.shooter !== HUMAN) continue;
      const a = shotAngles(s.from, s.to);
      hits.push({ ...a, cam45, cam100 });
    }
  }
  return hits;
}

const radiusU = (dp: number, dy: number, d = D): number => unitsAt(Math.hypot(dp, dy), d);

function sprayReport(): string {
  const free: Hit[][] = [];
  const ctl: Hit[][] = [];
  for (let k = 0; k < N; k++) {
    free.push(spray(10_000 + k, false));
    ctl.push(spray(10_000 + k, true));
  }
  const rows: (string | number)[][] = [];
  for (let i = 0; i < 30; i++) {
    const ps = free.map((r) => (r[i] as Hit).pitch);
    const ys = free.map((r) => (r[i] as Hit).yaw);
    const mp = mean(ps);
    const my = mean(ys);
    const scat = free.map((r) => radiusU((r[i] as Hit).pitch - mp, (r[i] as Hit).yaw - my));
    const p = pattern[i] as readonly [number, number];
    const c = ctl.map((r) => radiusU((r[i] as Hit).pitch, (r[i] as Hit).yaw));
    // Camera vs bullet: the angle from the screen centre to the impact, at tracking 0.45 / 1.0.
    const off45 = mean(free.map((r) => Math.hypot((r[i] as Hit).pitch - (r[i] as Hit).cam45.pitch, (r[i] as Hit).yaw - (r[i] as Hit).cam45.yaw)));
    const off100 = mean(free.map((r) => Math.hypot((r[i] as Hit).pitch - (r[i] as Hit).cam100.pitch, (r[i] as Hit).yaw - (r[i] as Hit).cam100.yaw)));
    rows.push([
      i + 1,
      f(p[0], 3),
      f(p[1], 3),
      `${f(mp, 3)}, ${f(my, 3)}`,
      `${f(unitsAt(-mp, D), 1)}, ${f(unitsAt(my, D), 1)}`,
      f(mean(scat), 1),
      f(quantile(scat, 0.95), 1),
      f(quantile(c, 0.5), 1),
      f(quantile(c, 0.95), 1),
      f(off45, 2),
      f(off100, 2),
    ]);
  }
  const all = (runs: Hit[][], n: number): number[] => runs.flatMap((r) => r.slice(0, n).map((x) => radiusU(x.pitch, x.yaw)));
  const ps = free.flatMap((r) => r.map((x) => x.pitch));
  const ys = free.flatMap((r) => r.map((x) => x.yaw));
  const meanPs = pattern.slice(0, 30).map((p) => p[0]);
  const meanYs = pattern.slice(0, 30).map((p) => p[1]);
  const lines = [
    `### AK-47, ${N} seeded 30-round sprays at a wall ${WALL} u away, standing still (through Sim3DHost)`,
    '',
    'Pitch − = up, yaw + = left (degrees). "units at 500 u": up, left. Scatter = distance of each impact from that bullet\'s mean, at 500 u.',
    '"controlled": the view pulled by −pattern before each bullet (a perfect human). "cam→bullet": the angle from the screen centre to the impact with Recoil tracking 0.45 / 1.0.',
    '',
    table(['bullet', 'pattern pitch °', 'pattern yaw °', 'mean of N (pitch, yaw) °', 'mean at 500 u (up, left)', 'scatter mean u', 'scatter p95 u', 'controlled median u', 'controlled p95 u', 'cam→bullet 0.45 °', 'cam→bullet 1.0 °'], rows),
    '',
    `Mean pattern envelope: height ${f(Math.max(...meanPs) - Math.min(...meanPs), 2)}°, width ${f(Math.max(...meanYs) - Math.min(...meanYs), 2)}° (csstats.gg CS2: 11.06° × 7.14°). ` +
      `All impacts: height ${f(Math.max(...ps) - Math.min(...ps), 2)}°, width ${f(Math.max(...ys) - Math.min(...ys), 2)}°.`,
    `Controlled, distance from the aim point at 500 u: bullets 1–10 median ${f(quantile(all(ctl, 10), 0.5), 1)} u, p95 ${f(quantile(all(ctl, 10), 0.95), 1)} u, max ${f(Math.max(...all(ctl, 10)), 1)} u; ` +
      `bullets 1–30 median ${f(quantile(all(ctl, 30), 0.5), 1)} u, p95 ${f(quantile(all(ctl, 30), 0.95), 1)} u. Uncontrolled 1–10 median ${f(quantile(all(free, 10), 0.5), 1)} u, 1–30 median ${f(quantile(all(free, 30), 0.5), 1)} u.`,
    '',
  ];
  return lines.join('\n');
}

/** First-shot cone in a situation: `prep` ticks of an input, then one ATTACK tick. */
interface Situation {
  readonly name: string;
  readonly prep: { ticks: number; forward: number; side?: number; buttons: Button[] }[];
  readonly fire: Button[];
}

function firstShot(sit: Situation, seeds: number): { mean: number; p95: number; max: number; speed: number; air: boolean } {
  const r: number[] = [];
  let speed = 0;
  let air = false;
  for (let k = 0; k < seeds; k++) {
    const h = rangeHost(20_000 + k, { wall: 4000 });
    for (let t = 0; t < 70; t++) {
      h.setHumanInput(input({}));
      h.tick();
    }
    for (const seg of sit.prep) {
      for (let t = 0; t < seg.ticks; t++) {
        h.setHumanInput(input({ forward: 0, side: seg.side ?? 0, buttons: seg.buttons, yaw: 0 }));
        // Run along +y (side −1 = left = +y when facing +x), the shot goes along +x across the motion.
        h.tick();
      }
    }
    const p = h.observe().pawns.find((q) => q.id === HUMAN);
    speed = p === undefined ? 0 : Math.hypot(p.vel.x, p.vel.y);
    air = p !== undefined && !p.onGround;
    h.setHumanInput(input({ side: sit.prep.at(-1)?.side ?? 0, buttons: sit.fire }));
    h.tick();
    const s = h.shots().find((x) => x.shooter === HUMAN);
    if (s === undefined) continue;
    const a = shotAngles(s.from, s.to);
    r.push(Math.hypot(a.pitch, a.yaw));
  }
  return { mean: mean(r), p95: quantile(r, 0.95), max: Math.max(...r), speed, air };
}

function firstShotReport(seeds: number): string {
  const sits: Situation[] = [
    { name: 'standing', prep: [], fire: ['ATTACK'] },
    { name: 'crouched', prep: [{ ticks: 10, forward: 0, buttons: ['DUCK'] }], fire: ['ATTACK', 'DUCK'] },
    { name: 'walking (shift) full speed', prep: [{ ticks: 40, forward: 0, side: -1, buttons: ['WALK'] }], fire: ['ATTACK', 'WALK'] },
    { name: 'running at 215 u/s', prep: [{ ticks: 64, forward: 0, side: -1, buttons: [] }], fire: ['ATTACK'] },
    { name: 'counter-strafed (5 ticks of the opposite key)', prep: [{ ticks: 64, forward: 0, side: -1, buttons: [] }, { ticks: 5, forward: 0, side: 1, buttons: [] }], fire: ['ATTACK'] },
    { name: 'released only, 5 ticks', prep: [{ ticks: 64, forward: 0, side: -1, buttons: [] }, { ticks: 5, forward: 0, side: 0, buttons: [] }], fire: ['ATTACK'] },
    { name: 'jump: 1 tick after take-off (standing jump)', prep: [{ ticks: 1, forward: 0, buttons: ['JUMP'] }], fire: ['ATTACK'] },
    { name: 'jump: at the apex (tick 24)', prep: [{ ticks: 1, forward: 0, buttons: ['JUMP'] }, { ticks: 23, forward: 0, buttons: [] }], fire: ['ATTACK'] },
    { name: 'jump: just before landing (tick 46)', prep: [{ ticks: 1, forward: 0, buttons: ['JUMP'] }, { ticks: 45, forward: 0, buttons: [] }], fire: ['ATTACK'] },
    { name: 'landed 0.1 s ago', prep: [{ ticks: 1, forward: 0, buttons: ['JUMP'] }, { ticks: 54, forward: 0, buttons: [] }], fire: ['ATTACK'] },
  ];
  const rows = sits.map((s) => {
    const r = firstShot(s, seeds);
    return [s.name, f(r.speed, 1), r.air ? 'yes' : 'no', f(r.mean, 3), f(r.p95, 3), f(r.max, 3), f(unitsAt(r.mean, D), 1), f(unitsAt(r.max, D), 1)];
  });
  return [
    `### AK-47 first shot, ${seeds} seeds per situation (angle from the aim point)`,
    '',
    table(['situation', 'speed u/s', 'airborne', 'mean °', 'p95 °', 'max °', 'mean u @500', 'max u @500'], rows),
    '',
  ].join('\n');
}

/** Fire n bullets, wait `waitMs`, fire one more: its distance from the aim point (recoil offset + cone). */
function recoveryReport(seeds: number): string {
  const rows: (string | number)[][] = [];
  for (const n of [1, 3, 5, 10, 20]) {
    for (const waitMs of [100, 200, 300, 400, 500, 700, 1000]) {
      const r: number[] = [];
      const offs: number[] = [];
      for (let k = 0; k < seeds; k++) {
        const h = rangeHost(30_000 + k, { wall: 4000 });
        let fired = 0;
        for (let t = 0; fired < n && t < 600; t++) {
          h.setHumanInput(input({ buttons: ['ATTACK'] }));
          h.tick();
          fired += h.shots().filter((s) => s.shooter === HUMAN).length;
        }
        const waitTicks = Math.round((waitMs / 1000) * 64);
        for (let t = 0; t < waitTicks; t++) {
          h.setHumanInput(input({}));
          h.tick();
        }
        for (let t = 0; t < 30; t++) {
          h.setHumanInput(input({ buttons: ['ATTACK'] }));
          h.tick();
          const s = h.shots().find((x) => x.shooter === HUMAN);
          if (s !== undefined) {
            const a = shotAngles(s.from, s.to);
            r.push(Math.hypot(a.pitch, a.yaw));
            offs.push(a.pitch);
            break;
          }
        }
      }
      rows.push([n, waitMs, f(mean(offs), 3), f(mean(r), 3), f(quantile(r, 0.95), 3), f(unitsAt(quantile(r, 0.95), D), 1)]);
    }
  }
  return [
    `### AK-47 recovery: n bullets, a pause, then one shot (${seeds} seeds each)`,
    '',
    'Standing-still first shot for reference: see the table above (mean ≈ 0.18°, max ≈ 0.37°).',
    '',
    table(['bullets before', 'pause ms', 'mean pitch offset °', 'mean radius °', 'p95 radius °', 'p95 u @500'], rows),
    '',
  ].join('\n');
}

const t0 = Date.now();
const out = [sprayReport(), firstShotReport(Math.max(200, Math.round(N / 2))), recoveryReport(Math.max(100, Math.round(N / 5)))].join('\n');
console.log(out);
console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s; DEG ${DEG.toFixed(4)})`);
const json = argOf('--json', '');
if (json !== '') writeFileSync(json, out);
