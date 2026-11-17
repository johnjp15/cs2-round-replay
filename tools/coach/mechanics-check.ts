/**
 * K2: the physics check behind the aim detectors (docs/coach/mechanics.md, "Physics check"). Reads a RawDemo
 * (`.craw`, `.craw.gz`) and prints Markdown tables:
 *
 *   1. does `fire_bullets.inaccuracy` equal the engine's model (src/engine/weapons/accuracy.ts `inaccuracy`) for the
 *      shooter's penalty, speed and footing, per weapon and mode; and with which rows of the tick grid;
 *   2. do the bullet's angles include the aim punch: least-squares fit of bullet − view against the punch;
 *   3. how `recoilIndex` follows the bullet number in a spray;
 *   4. the patterns of data/weapons.json against the measured punch offset per bullet;
 *   5. how many bullets get an intended target (`TARGETS`), with and without the map pack's sight mesh.
 *
 *   npx tsx tools/coach/mechanics-check.ts <file.craw[.gz]>
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createContext } from '../../src/coach/analyze/context';
import { SHOTS, TARGETS } from '../../src/coach/derive/aim/index';
import { LosWorld } from '../../src/coach/derive/los';
import { ingestMatch } from '../../src/coach/ingest/index';
import { FLAG, rowAtOrAfter } from '../../src/coach/model/raw';
import { decodeRawDemo } from '../../src/coach/model/raw-codec';
import { inaccuracy, type Motion } from '../../src/engine/weapons/accuracy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const file = process.argv[2];
if (file === undefined) {
  console.error('usage: mechanics-check <file.craw[.gz]>');
  process.exit(2);
}
const buf = readFileSync(file);
const raw = decodeRawDemo(file.endsWith('.gz') ? gunzipSync(buf) : buf);
const match = ingestMatch(raw);
const ctx = createContext(raw, match);
const T = raw.ticks;
const P = raw.players.length;
const m = ctx.weaponModel;
const wrap = (a: number): number => ((((a + 180) % 360) + 360) % 360) - 180;
const med = (xs: number[]): number => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length === 0 ? NaN : (s[s.length >> 1] as number);
};
const q = (xs: number[], f: number): number => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length === 0 ? NaN : (s[Math.min(s.length - 1, Math.floor(s.length * f))] as number);
};
const pc = (k: number, n: number): string => (n === 0 ? '–' : `${((100 * k) / n).toFixed(0)} %`);

// ---- 1. inaccuracy
interface Fit { key: string; n: number; relA: number[]; relB: number[]; moving: number; movingOkA: number; movingOkB: number; air: number }
const fits = new Map<string, Fit>();
const velRow = (t: number): number => (t + 1 < T.count && (T.tick[t + 1] ?? 0) === (T.tick[t] ?? 0) + 1 ? t + 1 : t);
for (const b of raw.events.bullets) {
  const w = ctx.weapon(b.weapon);
  if (w === null) continue;
  const mode: 0 | 1 = b.mode === 1 ? 1 : 0;
  const t = Math.min(rowAtOrAfter(T, b.tick), T.count - 1);
  if (t < 1) continue;
  const ic = t * P + b.p;
  const ip = (t - 1) * P + b.p;
  const iv = velRow(t) * P + b.p;
  const air = ((T.flags[ic] ?? 0) & FLAG.airborne) !== 0;
  const walking = ((T.flags[ic] ?? 0) & FLAG.walking) !== 0;
  const motion = (i: number): Motion => ({ velocity: { x: T.vx[i] ?? 0, y: T.vy[i] ?? 0, z: T.vz[i] ?? 0 }, onGround: !air, crouched: (T.duck[ic] ?? 0) > 127, onLadder: false, walking });
  if (!Number.isFinite(T.vx[iv] ?? NaN) || !Number.isFinite(T.vx[ip] ?? NaN)) continue;
  // A: the coach's reading (penalty of the shot's row minus the fire penalty, velocity one row later).
  const a = inaccuracy(w, mode, (T.penalty[ic] ?? 0) - w.inaccuracy.fire[mode], motion(iv), m);
  // B: the naive reading (the row before the shot for both).
  const bb = inaccuracy(w, mode, T.penalty[ip] ?? 0, motion(ip), m);
  const key = `${w.id}${w.zoom.levels > 0 || w.silencer !== 'none' ? ` (mode ${mode})` : ''}`;
  let f = fits.get(key);
  if (f === undefined) {
    f = { key, n: 0, relA: [], relB: [], moving: 0, movingOkA: 0, movingOkB: 0, air: 0 };
    fits.set(key, f);
  }
  f.n++;
  const ra = Math.abs(a - b.inaccuracy) / b.inaccuracy;
  const rb = Math.abs(bb - b.inaccuracy) / b.inaccuracy;
  f.relA.push(ra);
  f.relB.push(rb);
  if (air) f.air++;
  const speed = Math.hypot(T.vx[iv] ?? 0, T.vy[iv] ?? 0);
  if (!air && speed > w.maxSpeed[mode] * m.moveStartFraction) {
    f.moving++;
    if (ra < 0.1) f.movingOkA++;
    if (rb < 0.1) f.movingOkB++;
  }
}
const allFit: Fit = { key: '**all**', n: 0, relA: [], relB: [], moving: 0, movingOkA: 0, movingOkB: 0, air: 0 };
for (const f of fits.values()) {
  allFit.n += f.n;
  allFit.relA.push(...f.relA);
  allFit.relB.push(...f.relB);
  allFit.moving += f.moving;
  allFit.movingOkA += f.movingOkA;
  allFit.movingOkB += f.movingOkB;
  allFit.air += f.air;
}
console.log('## 1. fire_bullets.inaccuracy against the engine model\n');
console.log('A = penalty(shot row) − fire penalty, velocity one row later (the coach). B = penalty and velocity of the row before.\n');
console.log('| weapon | bullets | A: median rel. error | A: within 1 % | A: within 5 % | moving: A within 10 % | moving: B within 10 % | B: within 5 % | airborne |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const f of [...[...fits.values()].sort((x, y) => y.n - x.n), allFit]) {
  const w1 = f.relA.filter((x) => x < 0.01).length;
  const w5 = f.relA.filter((x) => x < 0.05).length;
  console.log(`| ${f.key} | ${f.n} | ${(100 * med(f.relA)).toFixed(2)} % | ${pc(w1, f.n)} | ${pc(w5, f.n)} | ${pc(f.movingOkA, f.moving)} of ${f.moving} | ${pc(f.movingOkB, f.moving)} | ${pc(f.relB.filter((x) => x < 0.05).length, f.n)} | ${f.air} |`);
}

// ---- 2. angles
console.log('\n## 2. Bullet angles against view angles and aim punch\n');
console.log('| view row | punch row | pitch scale | yaw scale | |residual| median | p90 | bullets |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const [o, pq] of [[-1, 0], [0, 0], [-1, -1]] as const) {
  let sxy = 0, sxx = 0, syy = 0, syx = 0;
  const pts: [number, number, number, number][] = [];
  for (const b of raw.events.bullets) {
    const t = Math.min(rowAtOrAfter(T, b.tick), T.count - 1);
    if (t < 1) continue;
    const iv = (t + o) * P + b.p;
    const ip = (t + pq) * P + b.p;
    const pp = T.punchPitch[ip] ?? 0;
    const py = T.punchYaw[ip] ?? 0;
    if (Math.hypot(pp, py) < 0.3) continue;
    const dp = b.pitch - (T.pitch[iv] ?? 0);
    const dy = wrap(b.yaw - (T.yaw[iv] ?? 0));
    sxy += dp * pp; sxx += pp * pp; syx += dy * py; syy += py * py;
    pts.push([dp, pp, dy, py]);
  }
  const kp = sxy / sxx;
  const ky = syx / syy;
  const res = pts.map(([dp, pp, dy, py]) => Math.hypot(dp - 2 * pp, dy - 2 * py));
  console.log(`| t${o === 0 ? '' : o} | t${pq === 0 ? '' : pq} | ${kp.toFixed(3)} | ${ky.toFixed(3)} | ${med(res).toFixed(3)}° | ${q(res, 0.9).toFixed(3)}° | ${pts.length} |`);
}
{
  const d: number[] = [];
  for (const b of raw.events.bullets) {
    const t = rowAtOrAfter(T, b.tick);
    if (t < 1 || t >= T.count) continue;
    const ip = t * P + b.p;
    if (Math.hypot(T.punchPitch[ip] ?? 0, T.punchYaw[ip] ?? 0) > 1e-3) continue;
    const iv = (t - 1) * P + b.p;
    d.push(Math.hypot(b.pitch - (T.pitch[iv] ?? 0), wrap(b.yaw - (T.yaw[iv] ?? 0))));
  }
  console.log(`\nBullets with zero punch (${d.length}): |bullet − view of the row before| median ${med(d).toFixed(4)}°, equal to 0.001° for ${pc(d.filter((x) => x < 1e-3).length, d.length)}. Residuals use the scale 2.`);
}

// ---- 3 + 4. recoil index and patterns
const { shots, bursts } = ctx.table(SHOTS);
console.log('\n## 3. recoilIndex and the bullet number\n');
{
  let inSpray = 0, exact = 0, exactFromFirst = 0;
  const firstIdx: number[] = [];
  for (const s of shots) {
    if (s.n === 1) firstIdx.push(s.recoilIndex);
    const w = ctx.weapon(s.weapon);
    if (w === null || !w.fullAuto || s.burstLen < 3) continue;
    const b = bursts[s.burst];
    const prev = b && s.n > 1 ? shots[b.shots[s.n - 2] as number] : undefined;
    const back = prev === undefined ? Infinity : s.tick - prev.tick;
    if (s.n > 1 && back > 1.1 * w.cycleTime[s.mode] * 64 + 1) continue;
    inSpray++;
    if (Math.abs(s.recoilIndex - (s.n - 1)) < 1e-6) exact++;
    const first = b ? shots[b.shots[0] as number] : undefined;
    if (first !== undefined && Math.abs(s.recoilIndex - (first.recoilIndex + s.n - 1)) < 1e-3) exactFromFirst++;
  }
  const zero = firstIdx.filter((x) => x === 0).length;
  console.log(`Full-auto spray bullets fired at the cycle time: ${inSpray}; recoilIndex = bullet number − 1 exactly for ${pc(exact, inSpray)}; = the first bullet's index + bullet number − 1 for ${pc(exactFromFirst, inSpray)}.`);
  console.log(`First bullets of bursts: ${firstIdx.length}; recoilIndex 0 for ${pc(zero, firstIdx.length)}, otherwise fractional (decaying from the last burst): median ${med(firstIdx.filter((x) => x > 0)).toFixed(2)}, p90 ${q(firstIdx.filter((x) => x > 0), 0.9).toFixed(2)}.`);
}
console.log('\n## 4. Patterns (data/weapons.json `sprays`) against the measured offset 2 × punch\n');
console.log('| weapon | bullets | fitted scale measured / pattern | RMS residual after the fit, bullets 2–10 | RMS of the per-bullet kick difference |');
console.log('| --- | ---: | ---: | ---: | ---: |');
for (const wid of ['ak47', 'm4a1s', 'm4a4', 'mac10', 'famas', 'mp9']) {
  const pat = ctx.weapons.sprays[wid];
  if (pat === undefined) continue;
  let sxy = 0, sxx = 0;
  const pairs: [number, number, number, number][] = [];
  const kicks: number[] = [];
  for (const b of bursts) {
    const s0 = shots[b.shots[0] as number];
    if (s0 === undefined || s0.wid !== wid || b.shots.length < 3 || s0.recoilIndex !== 0) continue;
    const w = ctx.weapon(s0.weapon);
    if (w === null) continue;
    let prevM: [number, number] | null = null;
    for (let k = 0; k < Math.min(b.shots.length, 10); k++) {
      const s = shots[b.shots[k] as number];
      if (s === undefined || Math.abs(s.recoilIndex - k) > 1e-6) break;
      const p = pat[k];
      if (p === undefined) break;
      const meas: [number, number] = [2 * s.punchPitch, 2 * s.punchYaw];
      if (k > 0) {
        sxy += meas[0] * p[0] + meas[1] * p[1];
        sxx += p[0] * p[0] + p[1] * p[1];
        pairs.push([meas[0], meas[1], p[0], p[1]]);
      }
      const pp = pat[k - 1];
      if (prevM !== null && pp !== undefined) kicks.push(Math.hypot(meas[0] - prevM[0] - (p[0] - pp[0]), meas[1] - prevM[1] - (p[1] - pp[1])));
      prevM = meas;
    }
  }
  if (pairs.length === 0) continue;
  const k = sxy / sxx;
  const rms = Math.sqrt(pairs.reduce((a, [mp, my, pp, py]) => a + (mp - k * pp) ** 2 + (my - k * py) ** 2, 0) / pairs.length);
  const rmsK = Math.sqrt(kicks.reduce((a, x) => a + x * x, 0) / Math.max(1, kicks.length));
  console.log(`| ${wid} | ${pairs.length} | ${k.toFixed(3)} | ${rms.toFixed(3)}° | ${rmsK.toFixed(3)}° |`);
}

// ---- 5. targets
console.log('\n## 5. Intended targets\n');
console.log('| sight mesh | bullets | hurt an enemy | aimed at one (clear) | ambiguous | none | assigned | assigned in sprays | assigned in taps/bursts |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
const pack = resolve(ROOT, `data/coach/maps/${raw.header.map}/los.bin.gz`);
for (const useLos of [false, true]) {
  if (useLos && !existsSync(pack)) continue;
  const c = createContext(raw, match, { los: useLos ? LosWorld.fromBytes(new Uint8Array(gunzipSync(readFileSync(pack)))) : null });
  const tg = c.table(TARGETS);
  const sh = c.table(SHOTS).shots;
  const n = tg.rows.length;
  const assigned = (r: { target: number }): boolean => r.target >= 0;
  const spray = tg.rows.filter((r) => (sh[r.i]?.burstLen ?? 0) >= 3);
  const tap = tg.rows.filter((r) => (sh[r.i]?.burstLen ?? 0) < 3);
  console.log(`| ${useLos ? 'yes' : 'no'} | ${n} | ${tg.counts.hit} | ${tg.counts.aim} | ${tg.counts.ambiguous} | ${tg.counts.none} | ${pc(tg.counts.hit + tg.counts.aim, n)} | ${pc(spray.filter(assigned).length, spray.length)} | ${pc(tap.filter(assigned).length, tap.length)} |`);
}
