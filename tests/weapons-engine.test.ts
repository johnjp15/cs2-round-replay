/**
 * H2: src/engine/weapons (docs/weapons.md). The table, recoil and spray patterns, the inaccuracy model's statistical
 * envelope, the damage generalization against sim2d and the recorded hits, the state machine, determinism.
 * Penetration on the Mirage mesh: tests/weapons-penetration.test.ts.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Rng, parseRound, parseTuning, type Hitgroup, type Tuning, type WeaponModelTuning } from '../src/contracts/index';
import {
  airScale,
  applyHit,
  armorPen,
  armsContext,
  bulletDamage,
  decayPenalty,
  deploy,
  drawSpread,
  fireShot,
  freshArms,
  inaccuracy,
  maxSpeedOf,
  modeOf,
  movementScale,
  parseWeaponTable,
  recoilKick,
  recoilTable,
  recoveryTime,
  shotDirection,
  sprayPattern,
  stepArms,
  ValveUniformRandom,
  weaponDef,
  WeaponTableError,
  type ArmsContext,
  type ArmsInput,
  type ArmsState,
  type Motion,
  type WeaponDef,
} from '../src/engine/weapons/index';
import { bulletDamage as bulletDamage2d } from '../src/sim2d/weapons';
import { buildWeaponsJson, PISTOL_SPRAY, SPRAYS } from '../tools/extract-weapons';

const readText = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const weaponsJson = JSON.parse(readText('../data/weapons.json')) as unknown;
const table = parseWeaponTable(weaponsJson);
const tuning: Tuning = parseTuning(readText('../data/tuning.json'));
const model = tuning.weaponModel as WeaponModelTuning;
const ctx: ArmsContext = armsContext(table, tuning, 64);
const W = (id: string): WeaponDef => weaponDef(table, id);

const still: Motion = { velocity: { x: 0, y: 0, z: 0 }, onGround: true, crouched: false, onLadder: false };
const view = { pitch: 0, yaw: 0 };

/** Hold `attack` for `ticks` ticks from `from`, returning the shots' ticks and the final state. */
function hold(s0: ArmsState, ticks: number, from: number, inp: Partial<ArmsInput> = {}, rng = new Rng(1)): { s: ArmsState; shots: number[]; dirs: string[] } {
  let s = s0;
  const shots: number[] = [];
  const dirs: string[] = [];
  for (let t = from; t < from + ticks; t++) {
    const r = stepArms(ctx, s, { tick: t, attack: true, attack2: false, reload: false, view, motion: still, ...inp }, rng);
    s = r.state;
    if (r.shot !== null) {
      shots.push(t);
      dirs.push(r.shot.pellets.map((p) => `${p.x},${p.y},${p.z}`).join(';'));
    }
  }
  return { s, shots, dirs };
}

describe('weapon table (data/weapons.json from CS2 weapons.vdata)', () => {
  it('every row loads and validates; 48 items with the CS2 class names', () => {
    expect(table.ids.length).toBe(48);
    for (const id of table.ids) {
      const w = W(id);
      expect(w.id).toBe(id);
      expect(w.className).toMatch(/^(weapon|item)_/);
    }
    expect(W('m4a4').className).toBe('weapon_m4a1');
    expect(W('m4a1s').className).toBe('weapon_m4a1_silencer');
    expect(table.source.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is exactly what tools/extract-weapons.ts builds from the pinned vdata (sha256 matches the copy in data/source)', () => {
    const bytes = new Uint8Array(readFileSync(new URL('../data/source/cs2/weapons.vdata', import.meta.url)));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(table.source.sha256);
    expect(buildWeaponsJson(bytes, readText('../data/tuning.json'))).toBe(readText('../data/weapons.json'));
  });

  it('rejects bad rows with the field named', () => {
    const j = JSON.parse(JSON.stringify(weaponsJson)) as { weapons: Record<string, Record<string, unknown>> };
    (j.weapons['ak47'] as Record<string, unknown>)['rangeModifier'] = 1.5;
    expect(() => parseWeaponTable(j)).toThrow(/weapons\.ak47\.rangeModifier: 1\.5 is outside/);
    const k = JSON.parse(JSON.stringify(weaponsJson)) as { weapons: Record<string, Record<string, unknown>> };
    (k.weapons['awp'] as Record<string, unknown>)['reserve'] = 30;
    expect(() => parseWeaponTable(k)).toThrow(WeaponTableError);
  });

  it('AK-47: 36 damage, 0.1 s cycle (600 rpm), 30 + 3 magazines (90), 77.5 % armor penetration, range modifier 0.98, 215 u/s', () => {
    const ak = W('ak47');
    expect(ak.damage).toBe(36);
    expect(ak.cycleTime).toEqual([0.1, 0.1]);
    expect(ak.clip).toBe(30);
    expect(ak.reserveAsClips).toBe(true);
    expect(ak.reserve).toBe(90);
    expect(armorPen(ak)).toBeCloseTo(0.775, 12);
    expect(ak.rangeModifier).toBe(0.98);
    expect(ak.maxSpeed).toEqual([215, 215]);
    expect(ak.headshotMultiplier).toBe(4);
    expect(ak.penetration).toBe(2);
    expect(ak.price).toBe(2700);
    expect(ak.killAward).toBe(300);
    expect(ak.inaccuracy.stand[0]).toBe(0.00641);
    expect(ak.inaccuracy.move[0]).toBe(0.17506);
    expect(ak.recoil.seed).toBe(223);
  });

  it("agrees with the 2D table's damage numbers (tuning.weapons) for its six guns; AWP magazine 5 in CS2 (the recording's 10 stays in the 2D table)", () => {
    for (const id of ['ak47', 'awp', 'ssg08', 'deagle', 'm4a4', 'glock']) {
      const g = tuning.weapons[id];
      const w = W(id);
      if (g === undefined) throw new Error(id);
      expect(w.damage, id).toBe(g.damage);
      expect(armorPen(w), id).toBeCloseTo(g.armorPen, 9);
      expect(w.rangeModifier, id).toBe(g.rangeModifier);
      expect(w.headshotMultiplier, id).toBe(g.headshotMult);
      expect(60 / w.cycleTime[0], id).toBeCloseTo(g.rpm, 0);
      expect(w.fullAuto, id).toBe(g.automatic);
    }
    expect(W('awp').clip).toBe(5);
  });
});

describe('damage, generalized (same math as sim2d, numbers from the table)', () => {
  const d = tuning.damage;
  it('range falloff: AK-47 chest, no armor: 35 at 500 u, 34 at 1000 u, 33 at 2000 u', () => {
    expect(bulletDamage(W('ak47'), 500, 'chest', 0, false, d).health).toBe(35); // 36 × 0.98 = 35.28
    expect(bulletDamage(W('ak47'), 1000, 'chest', 0, false, d).health).toBe(34); // 36 × 0.98² = 34.57
    expect(bulletDamage(W('ak47'), 2000, 'chest', 0, false, d).health).toBe(33); // 36 × 0.98⁴ = 33.21
  });

  it('reproduces the recorded hits: SSG 08 73 HP / 7 armor on cart (100 + helmet); AK-47 27 / 34 / 26 on donk', () => {
    const hits = parseRound(readText('../data/round.json')).damage;
    const dist = (i: number): number => {
      const h = hits[i];
      if (h === undefined || h.apos === null || h.vpos === null) throw new Error('missing positions');
      return Math.hypot(h.apos.x - h.vpos.x, h.apos.y - h.vpos.y, h.apos.z - h.vpos.z);
    };
    expect(bulletDamage(W('ssg08'), dist(0), 'chest', 100, true, d)).toEqual({ health: 73, armor: 7 });
    expect(bulletDamage(W('ak47'), dist(1), 'chest', 100, true, d).health).toBe(27);
    expect(bulletDamage(W('ak47'), dist(2), 'stomach', 95, true, d).health).toBe(34);
    expect(bulletDamage(W('ak47'), dist(3), 'leg', 89, true, d).health).toBe(26);
  });

  it('is identical to sim2d bulletDamage for the six 2D guns on a grid of distances, hitgroups and armor', () => {
    const groups: Hitgroup[] = ['head', 'chest', 'stomach', 'arm', 'leg'];
    for (const id of ['ak47', 'awp', 'ssg08', 'deagle', 'm4a4', 'glock']) {
      const g = tuning.weapons[id];
      if (g === undefined) throw new Error(id);
      for (const dist of [0, 10, 257.3, 500, 1234.5, 3000]) {
        for (const hg of groups) {
          for (const [armor, helmet] of [[0, false], [100, true], [100, false], [3, true]] as const) {
            expect(bulletDamage(W(id), dist, hg, armor, helmet, d), `${id} ${dist} ${hg} ${armor}`).toEqual(bulletDamage2d(g, dist, hg, armor, helmet, d));
          }
        }
      }
    }
  });
});

describe('recoil tables and spray patterns', () => {
  it("ValveUniformRandom is Numerical Recipes ran1 (the first draws for seed 1 match ran1's published sequence start)", () => {
    // ran1 with idum = −1: 16807-based minimal standard, shuffled; first outputs are deterministic integers.
    const r = new ValveUniformRandom(1);
    const a = [r.next(), r.next(), r.next()];
    const r2 = new ValveUniformRandom(1);
    expect([r2.next(), r2.next(), r2.next()]).toEqual(a);
    for (const x of a) expect(Number.isInteger(x) && x > 0 && x < 2147483647).toBe(true);
    const f = new ValveUniformRandom(223).randomFloat(-70, 70);
    expect(f).toBeGreaterThanOrEqual(-70);
    expect(f).toBeLessThan(70);
    expect(Math.fround(f)).toBe(f);
  });

  it('data/weapons.json sprays are the engine output for every spray weapon (16 + 10 pistols)', () => {
    expect(Object.keys(table.sprays).sort()).toEqual([...SPRAYS, ...PISTOL_SPRAY].sort());
    for (const id of Object.keys(table.sprays)) {
      const w = W(id);
      const t = [recoilTable(w, 0, model), recoilTable(w, 1, model)] as const;
      expect(table.sprays[id], id).toEqual(sprayPattern(w, t, model, 64, (table.sprays[id] ?? []).length));
    }
  });

  // CS:GO's WeaponRecoilData::GenerateRecoilTable (cs_weapon_parse.cpp, 2020 source, SwagSoftware/Kisak-Strike) for
  // weapon_ak47 (CS2 weapons.vdata: angle 0, variance 70, magnitude 30, variance 0, seed 223; full auto) with
  // weapon_recoil_variance 0.55, suppression 4 shots from 0.75: the first ten (angle °, magnitude) entries. The
  // magnitudes follow from the cvars alone (magnitude variance 0): 22.5, lerp(22.5, 30) × 0.8125, … — the damping
  // multiplies the running value, so bullets 5–10 are below 30 too.
  const AK_TABLE_10: [number, number][] = [
    [27.330322, 22.5],
    [-17.830391, 21.632813],
    [5.800777, 22.95542],
    [1.6354, 25.153069],
    [-15.538623, 27.81888],
    [-9.262066, 29.018496],
    [-18.047684, 29.558323],
    [12.5035, 29.801245],
    [43.999619, 29.910561],
    [22.431967, 29.959753],
  ];

  it('AK-47 recoil table: the first 10 entries are Valve GenerateRecoilTable output (angle, magnitude)', () => {
    const t = recoilTable(W('ak47'), 0, model);
    AK_TABLE_10.forEach(([a, m], i) => {
      expect(t[i]?.angle, `angle ${i}`).toBeCloseTo(a, 5);
      expect(t[i]?.magnitude, `magnitude ${i}`).toBeCloseTo(m, 5);
    });
    // The magnitudes by hand from the cvars (float32 like the game).
    let r = 0;
    for (let j = 0; j < 10; j++) {
      r = j === 0 ? 30 : Math.fround(r + Math.fround((30 - r) * 0.55));
      if (j < 4) r = Math.fround(r * Math.fround(0.75 + 0.25 * (j / 4)));
      expect(t[j]?.magnitude).toBeCloseTo(r, 5);
    }
  });

  it('a kick turns a positive recoil angle to the right (−yaw), as CCSPlayer::KickBack (yaw velocity −sin a × m)', () => {
    const t = [recoilTable(W('ak47'), 0, model), recoilTable(W('ak47'), 1, model)] as const;
    const k = recoilKick(t, 0, 8, model); // entry 8: angle +44°
    expect(k.yaw).toBeCloseTo(-Math.sin((44 * Math.PI) / 180) * 29.910561, 3);
    expect(k.pitch).toBeLessThan(0); // up
    // the index wraps at 64 (GetRecoilOffsets: iIndex % 64), it doesn't stick on the last entry
    expect(recoilKick(t, 0, 64 + 8, model)).toEqual(k);
  });

  it('AK-47 spray as the player sees it: up, a slight lean left (6–9), then right (10–17), left (19–27), right (28–30)', () => {
    const p = table.sprays['ak47'] ?? [];
    expect(p.length).toBe(30);
    expect(p[0]).toEqual([0, 0]);
    const yaw = p.map((b) => b[1]); // + = the player's left
    const pitch = p.map((b) => b[0]); // − = up
    for (let i = 1; i <= 4; i++) expect(Math.abs(yaw[i] as number)).toBeLessThan(0.25);
    for (let i = 1; i <= 8; i++) expect(pitch[i] as number).toBeLessThan(pitch[i - 1] as number);
    for (let i = 5; i <= 8; i++) expect(yaw[i] as number, `bullet ${i + 1} leans left`).toBeGreaterThan(0.4);
    for (let i = 9; i <= 16; i++) expect(yaw[i] as number, `bullet ${i + 1} right`).toBeLessThan(-1);
    expect(yaw[9] as number).toBeLessThan((yaw[0] as number) - 1); // shot 10 is right of shot 1 on screen
    expect(Math.min(...yaw.slice(9, 17))).toBeLessThan(-4); // the right swing peaks past 4° (bullets 14–15)
    for (let i = 18; i <= 26; i++) expect(yaw[i] as number, `bullet ${i + 1} left`).toBeGreaterThan(0.9);
    for (let i = 28; i <= 29; i++) expect(yaw[i] as number, `bullet ${i + 1} right`).toBeLessThan(-2.5);
    // 30-shot height at a wall 500 u away vs csstats.gg's CS2 AK-47 height (11.06°): within 5 % (it is 0.3 %).
    const h = 500 * Math.tan((-Math.min(...pitch) * Math.PI) / 180);
    const ref = 500 * Math.tan((11.06 * Math.PI) / 180);
    expect(Math.abs(h / ref - 1)).toBeLessThan(0.05);
  });

  // csstats.gg/spray-patterns (updated 22 Aug 2023): CS2 height / width in degrees, and the CS:GO values (CS2 + delta).
  const CSSTATS: Record<string, [number, number, number, number]> = {
    ak47: [11.06, 7.14, 0.69, 0.24],
    m4a4: [9.06, 6.29, 0.38, 0.27],
    sg553: [8.59, 9.7, 0.6, 0.42],
    aug: [7.84, 5.67, 0.41, 0.26],
    galil: [7.31, 7.06, 0.5, 0.32],
    famas: [6.96, 4.89, 0.47, 0.17],
    ump45: [8.95, 3.56, 0.68, 0.07],
    mp7: [6.27, 3.39, 0.3, 0.17],
    p90: [7.47, 6.15, 0.41, 0.16],
    mp5sd: [6.27, 3.39, 0.3, 0.17],
  };
  const envelope = (id: string, m: WeaponModelTuning): [number, number] => {
    const w = W(id);
    const sp = sprayPattern(w, [recoilTable(w, 0, m), recoilTable(w, 1, m)], m, 64);
    const ps = sp.map((b) => b[0]);
    const ys = sp.map((b) => b[1]);
    return [Math.max(...ps) - Math.min(...ps), Math.max(...ys) - Math.min(...ys)];
  };

  it('spray envelopes match csstats.gg CS2 heights within 2.5 % and widths within 5 % for 10 spray weapons (recoilScale 1.884)', () => {
    for (const [id, [h, w]] of Object.entries(CSSTATS)) {
      const [H, Wd] = envelope(id, model);
      expect(Math.abs(H / h - 1), `${id} height ${H} vs ${h}`).toBeLessThan(0.025);
      expect(Math.abs(Wd / w - 1), `${id} width ${Wd} vs ${w}`).toBeLessThan(0.05);
    }
  });

  it("with CS:GO's weapon_recoil_scale 2 the same generator gives csstats.gg's CS:GO heights within 1 %", () => {
    const m = { ...model, recoilScale: 2 };
    for (const [id, [h, , dh]] of Object.entries(CSSTATS)) {
      const [H] = envelope(id, m);
      expect(Math.abs(H / (h + dh) - 1), `${id} ${H} vs ${h + dh}`).toBeLessThan(0.01);
    }
  });

  it('semi-automatic tables are not smoothed or suppressed; full-auto tables are', () => {
    const glock = recoilTable(W('glock'), 0, model);
    const raw = new ValveUniformRandom(W('glock').recoil.seed);
    const g = W('glock').recoil;
    const a0 = Math.fround(g.angle[0] + raw.randomFloat(-g.angleVariance[0], g.angleVariance[0]));
    const m0 = Math.fround(g.magnitude[0] + raw.randomFloat(-g.magnitudeVariance[0], g.magnitudeVariance[0]));
    expect(glock[0]).toEqual({ angle: a0, magnitude: m0 });
    const ak = recoilTable(W('ak47'), 0, model);
    expect(ak[0]?.magnitude).toBeCloseTo(30 * 0.75, 4); // magnitude variance 0: 30 × suppression 0.75
    expect(ak[4]?.magnitude).toBeCloseTo(27.81888, 4); // the damping carries through the smoothing
    expect(ak[20]?.magnitude).toBeCloseTo(30, 4);
  });
});

describe('inaccuracy model: 10,000 seeded shots per stance at 1,024 units', () => {
  /**
   * For r uniform in [0, 1) and θ uniform: E|r1·I·e^{iθ1} + r2·S·e^{iθ2}| and P(radius ≤ (I + S) / 2), by the midpoint
   * rule on (r1, r2, Δθ).
   */
  function expected(I: number, S: number): { mean: number; inner: number } {
    const n = 120;
    let sum = 0;
    let inner = 0;
    const half = (I + S) / 2;
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) / n) * I;
      for (let j = 0; j < n; j++) {
        const b = ((j + 0.5) / n) * S;
        for (let k = 0; k < n; k++) {
          const r = Math.sqrt(a * a + b * b + 2 * a * b * Math.cos(((k + 0.5) / n) * 2 * Math.PI));
          sum += r;
          if (r <= half) inner++;
        }
      }
    }
    return { mean: sum / (n * n * n), inner: inner / (n * n * n) };
  }

  function sample(w: WeaponDef, I: number, seed: number): { max: number; mean: number; meanX: number; meanY: number; inner: number } {
    const rng = new Rng(seed);
    let max = 0;
    let sum = 0;
    let sx = 0;
    let sy = 0;
    let inner = 0;
    const N = 10000;
    const S = w.spread[0];
    for (let i = 0; i < N; i++) {
      const off = drawSpread(w, 0, I, 5, rng).pellets[0] as { x: number; y: number };
      const dir = shotDirection(view, off);
      // view (0, 0): forward +x, right −y, up +z; the wall plane x = 1024.
      const hy = (-dir.y / dir.x) * 1024;
      const hz = (dir.z / dir.x) * 1024;
      const r = Math.hypot(hy, hz);
      max = Math.max(max, r);
      sum += r;
      sx += hy;
      sy += hz;
      if (r <= 0.5 * (I + S) * 1024) inner++;
    }
    return { max, mean: sum / N, meanX: sx / N, meanY: sy / N, inner: inner / N };
  }

  const ak = W('ak47');
  const m = model;
  const stances: [string, Motion, number][] = [
    ['standing', still, ak.inaccuracy.stand[0]],
    ['crouched', { ...still, crouched: true }, ak.inaccuracy.crouch[0]],
    ['running 215 u/s', { ...still, velocity: { x: 215, y: 0, z: 0 } }, ak.inaccuracy.stand[0]],
    ['walking 111.8 u/s', { ...still, velocity: { x: 111.8, y: 0, z: 0 }, walking: true }, ak.inaccuracy.stand[0]],
    // W3: the same speed without WALK (e.g. slowing down from a run): CS's run curve, ^0.25.
    ['slowing 111.8 u/s (no walk)', { ...still, velocity: { x: 111.8, y: 0, z: 0 } }, ak.inaccuracy.stand[0]],
    ['jumping (take-off, vz 302)', { velocity: { x: 0, y: 0, z: 301.99338 }, onGround: false, crouched: false, onLadder: false }, ak.inaccuracy.stand[0] + ak.inaccuracy.jumpInitial],
  ];
  const expectedI: Record<string, number> = {
    standing: 0.00641,
    crouched: 0.00481,
    'running 215 u/s': 0.00641 + 0.17506,
    'walking 111.8 u/s': 0.00641 + 0.17506 * ((111.8 - 215 * 0.34) / (215 * 0.95 - 215 * 0.34)),
    'slowing 111.8 u/s (no walk)': 0.00641 + 0.17506 * Math.pow((111.8 - 215 * 0.34) / (215 * 0.95 - 215 * 0.34), 0.25),
    'jumping (take-off, vz 302)': 0.00641 + 0.10094 + 0.14076,
  };

  for (const [name, motion, penalty] of stances) {
    it(`AK-47 ${name}: inaccuracy as cited, max radius = 1024 × (I + S), mean radius as integrated, centred`, () => {
      const I = inaccuracy(ak, 0, penalty, motion, m);
      expect(I).toBeCloseTo(expectedI[name] as number, 9);
      const S = ak.spread[0];
      const st = sample(ak, I, 1234);
      const R = 1024 * (I + S);
      expect(st.max).toBeLessThanOrEqual(R * (1 + 1e-4) + 0.002);
      expect(st.max).toBeGreaterThan(R * 0.97);
      const e = expected(I, S);
      expect(Math.abs(st.mean / (1024 * e.mean) - 1)).toBeLessThan(0.015);
      expect(Math.abs(st.meanX)).toBeLessThan(R * 0.02);
      expect(Math.abs(st.meanY)).toBeLessThan(R * 0.02);
      // Uniform radius, not area-uniform: shots bunch toward the centre (about half land inside half the cone).
      expect(Math.abs(st.inner - e.inner)).toBeLessThan(0.015);
      expect(e.inner).toBeGreaterThan(0.45);
    });
  }

  it('the stepArms jump shot uses take-off penalty (one tick of decay) + the air term', () => {
    let s = freshArms(ctx, 'ak47', 0);
    s = { ...s, deployEndTick: 0, nextAttackTick: 0, nextAltTick: 0 };
    const air: Motion = { velocity: { x: 0, y: 0, z: 301.99338 }, onGround: false, crouched: false, onLadder: false };
    const r = stepArms(ctx, s, { tick: 10, attack: true, attack2: false, reload: false, view, motion: air }, new Rng(5));
    const k = Math.exp(-Math.log(10) / 64 / recoveryTime(ak, false, 0));
    expect(r.shot?.inaccuracy).toBeCloseTo(0.00641 + 0.10094 * k + 0.14076, 5);
    expect(airScale(0, m)).toBe(0);
    expect(airScale(301.99338, m)).toBeCloseTo(1, 12);
  });

  it('movement scale: 0 up to 34 % of max speed, 1 from 95 %', () => {
    expect(movementScale(73.1, 215, m)).toBe(0);
    expect(movementScale(204.25, 215, m)).toBeCloseTo(1, 9);
    expect(movementScale(250, 215, m)).toBe(1);
  });

  it('W3: movement scale curve: ^0.25 running (CS MOVEMENT_CURVE01_EXPONENT), linear walking', () => {
    expect(m.moveCurveExponent).toBe(0.25);
    expect(m.moveWalkCurveExponent).toBe(1);
    const mid = 215 * 0.34 + 0.5 * (215 * 0.95 - 215 * 0.34);
    expect(movementScale(mid, 215, m)).toBeCloseTo(Math.pow(0.5, 0.25), 12);
    expect(movementScale(mid, 215, m, true)).toBeCloseTo(0.5, 12);
    // Just above the 34 % threshold the run curve is already steep: 1 % of the range is ~32 % of the penalty.
    expect(movementScale(215 * 0.34 + 0.01 * 215 * 0.61, 215, m)).toBeCloseTo(Math.pow(0.01, 0.25), 9);
  });

  it('scoped AWP is pinpoint, unscoped it is not; scoped max speed 100', () => {
    const awp = W('awp');
    expect(inaccuracy(awp, 1, awp.inaccuracy.stand[1], still, m)).toBeLessThan(0.01);
    expect(inaccuracy(awp, 0, awp.inaccuracy.stand[0], still, m)).toBeGreaterThan(0.05);
    let s = freshArms(ctx, 'awp', 0);
    expect(modeOf(awp, s)).toBe(0);
    s = stepArms(ctx, s, { tick: 200, attack: false, attack2: true, reload: false, view, motion: still }, new Rng(1)).state;
    expect(s.zoom).toBe(1);
    expect(maxSpeedOf(ctx, s, false)).toBe(100);
  });
});

describe('arms state machine', () => {
  const ready = (id: string): ArmsState => {
    const s = freshArms(ctx, id, -1000);
    return s;
  };

  it('AK-47 held for 1.0 s fires 10 rounds on the 6.4-tick cadence (ticks 0, 7, 13, 20, 26, 32, 39, 45, 52, 58)', () => {
    const { shots, s } = hold(ready('ak47'), 64, 0);
    expect(shots).toEqual([0, 7, 13, 20, 26, 32, 39, 45, 52, 58]);
    expect(s.clip).toBe(20);
    expect(s.recoilIndex).toBe(10);
  });

  it('deploy: the AK-47 can fire 1.0 s after the switch, the AWP 1.266667 s', () => {
    let s = deploy(ctx, ready('ak47'), 'awp', 5, 10, 0);
    expect(hold(s, 82, 0).shots).toEqual([]); // 1.266667 × 64 = 81.07
    expect(hold(s, 83, 0).shots).toEqual([82]);
    s = deploy(ctx, ready('awp'), 'ak47', 30, 90, 0);
    expect(hold(s, 65, 0).shots).toEqual([64]);
  });

  it('magazine reload: 2.466667 s attack lockout, refills from reserve; with discardMagazine the rest of the magazine is lost', () => {
    let s = { ...ready('ak47'), clip: 10 };
    const r = stepArms(ctx, s, { tick: 0, attack: false, attack2: false, reload: true, view, motion: still }, new Rng(1));
    expect(r.reloadStarted).toBe(true);
    s = r.state;
    expect(s.reload).toEqual({ kind: 'magazine', endTick: 157.866688 });
    expect(hold(s, 157, 1).shots).toEqual([]);
    const after = hold(s, 2, 157);
    expect(after.shots).toEqual([158]);
    expect(after.s.clip).toBe(29);
    expect(after.s.reserve).toBe(70);
    const discard = { ...ctx, discardMagazine: true };
    const d = stepArms(discard, s, { tick: 158, attack: false, attack2: false, reload: false, view, motion: still }, new Rng(1)).state;
    expect([d.clip, d.reserve]).toEqual([30, 60]);
  });

  it('Nova reloads shell by shell (0.466667 s, then one shell per shellReloadSec); firing interrupts', () => {
    let s = { ...ready('nova'), clip: 5 };
    s = stepArms(ctx, s, { tick: 0, attack: false, attack2: false, reload: true, view, motion: still }, new Rng(1)).state;
    let clip: number[] = [];
    for (let t = 1; t < 130; t++) {
      s = stepArms(ctx, s, { tick: t, attack: false, attack2: false, reload: false, view, motion: still }, new Rng(1)).state;
      clip.push(s.clip);
    }
    expect(clip[28]).toBe(5);
    expect(clip[29]).toBe(6); // tick 30 ≥ 29.87
    expect(s.clip).toBe(8);
    expect(s.reload).toBeNull();
    s = { ...ready('nova'), clip: 5 };
    s = stepArms(ctx, s, { tick: 0, attack: false, attack2: false, reload: true, view, motion: still }, new Rng(1)).state;
    const r = stepArms(ctx, s, { tick: 40, attack: true, attack2: false, reload: false, view, motion: still }, new Rng(1));
    expect(r.shot?.pellets.length).toBe(9);
    expect(r.state.reload).toBeNull();
    clip = [];
    expect(clip).toEqual([]);
  });

  it('semi-automatic: one shot per press; the Glock in burst mode fires 3 rounds 0.05 s apart per press', () => {
    let s = ready('deagle');
    const held = hold(s, 100, 0);
    expect(held.shots).toEqual([0]);
    s = ready('glock');
    s = stepArms(ctx, s, { tick: 0, attack: false, attack2: true, reload: false, view, motion: still }, new Rng(1)).state;
    expect(s.altMode).toBe(true);
    const b = hold(s, 60, 1);
    expect(b.shots).toEqual([1, 5, 8]);
    expect(b.s.clip).toBe(17);
  });

  it('AWP: zoom 0 → 1 → 2 → 0; a scoped shot unzooms and re-zooms once the bolt has cycled (1.455 s)', () => {
    let s = ready('awp');
    const press = (t: number): void => {
      s = stepArms(ctx, s, { tick: t, attack: false, attack2: true, reload: false, view, motion: still }, new Rng(1)).state;
      s = stepArms(ctx, s, { tick: t + 1, attack: false, attack2: false, reload: false, view, motion: still }, new Rng(1)).state;
    };
    press(0);
    expect(s.zoom).toBe(1);
    press(20);
    expect(s.zoom).toBe(2);
    press(40);
    expect(s.zoom).toBe(0);
    press(60);
    const r = stepArms(ctx, s, { tick: 80, attack: true, attack2: false, reload: false, view, motion: still }, new Rng(1));
    expect(r.shot).not.toBeNull();
    expect(r.state.zoom).toBe(0);
    s = r.state;
    for (let t = 81; t <= 174; t++) s = stepArms(ctx, s, { tick: t, attack: false, attack2: false, reload: false, view, motion: still }, new Rng(1)).state;
    expect(s.zoom).toBe(1); // 80 + 93.12 = 173.12
  });

  it('accuracy penalty: + fire inaccuracy per shot, decays by ×1/10 per recovery time toward the stance floor', () => {
    const ak = W('ak47');
    const s0 = ready('ak47');
    const { state } = fireShot(ctx, s0, new Rng(1), view, still, 0);
    expect(state.penalty).toBeCloseTo(0.00641 + 0.0078, 9);
    const rec = recoveryTime(ak, false, 1);
    expect(rec).toBe(0.368);
    let p = state.penalty;
    const n = Math.round(rec * 64);
    for (let i = 0; i < n; i++) p = decayPenalty(p, 0.00641, rec, 1 / 64, model);
    expect((p - 0.00641) / 0.0078).toBeCloseTo(Math.pow(0.1, n / 64 / rec), 3);
    // "final" recovery from bullet 5 on.
    expect(recoveryTime(ak, false, 5)).toBe(0.506);
    // GetRecoveryTime remaps the integer index (int nRecoilIndex = m_flRecoilIndex): 3.5 → 3, a third of the way 2 → 5.
    expect(recoveryTime(ak, true, 3.5)).toBeCloseTo(0.305257 + (0.419728 - 0.305257) / 3, 9);
    expect(recoveryTime(ak, true, 3.99)).toBe(recoveryTime(ak, true, 3));
    // on a ladder: the standing time, no transition
    expect(recoveryTime(ak, false, 9, 'ladder')).toBe(0.368);
  });

  it('the recoil index decays after a pause; a fresh spray starts at bullet 0 again', () => {
    const { s } = hold(ready('ak47'), 60, 0);
    let st = s;
    for (let t = 60; t < 60 + 192; t++) st = stepArms(ctx, st, { tick: t, attack: false, attack2: false, reload: false, view, motion: still }, new Rng(1)).state;
    expect(st.recoilIndex).toBeLessThan(1);
    expect(Math.hypot(st.punch.aim.pitch, st.punch.aim.yaw)).toBeLessThan(1e-5);
  });

  it('tagging: an AK-47 hit slows the victim to 40 %, later hits to at most 55 %; recovers at 0.4 / s; unarmored hits punch the aim', () => {
    let v = ready('ak47');
    v = applyHit(ctx, v, 'ak47', true);
    expect(v.velocityModifier).toBe(0.4);
    expect(v.punch.aim.pitch).toBe(0);
    expect(v.punch.view.pitch).toBe(-3);
    expect(maxSpeedOf(ctx, v, false)).toBeCloseTo(86, 9);
    v = applyHit(ctx, v, 'ak47', false);
    expect(v.velocityModifier).toBe(0.4);
    expect(v.punch.aim.pitch).toBe(-2);
    for (let t = 0; t < 32; t++) v = stepArms(ctx, v, { tick: t, attack: false, attack2: false, reload: false, view, motion: still }, new Rng(1)).state;
    expect(v.velocityModifier).toBeCloseTo(0.6, 6);
    const w = applyHit(ctx, { ...v, velocityModifier: 0.9 }, 'ak47', true);
    expect(w.velocityModifier).toBe(0.55);
  });

  it('Negev attacking speed factor 0.5', () => {
    expect(maxSpeedOf(ctx, ready('negev'), true)).toBe(75);
  });
});

describe('determinism', () => {
  it('same seed → same 30-bullet spray (directions to the last digit); another seed → a different one', () => {
    const run = (seed: number): string[] => hold(freshArms(ctx, 'ak47', -1000), 200, 0, { motion: { ...still, velocity: { x: 100, y: 0, z: 0 } } }, new Rng(seed)).dirs;
    const a = run(42);
    expect(a.length).toBe(30);
    expect(run(42)).toEqual(a);
    expect(run(43)).not.toEqual(a);
  });

  it('stepArms is pure: the input state is not modified', () => {
    const s = freshArms(ctx, 'ak47', -1000);
    const copy = JSON.stringify(s);
    stepArms(ctx, s, { tick: 0, attack: true, attack2: false, reload: false, view, motion: still }, new Rng(1));
    expect(JSON.stringify(s)).toBe(copy);
  });
});

describe('tuning: weapons._engine', () => {
  it('parses into tuning.weaponModel and leaves the gun table alone', () => {
    expect(Object.keys(tuning.weapons)).toEqual(['ak47', 'awp', 'deagle', 'glock', 'm4a4', 'ssg08', 'usps']); // W2: CTs carry a USP-S
    expect(model.recoilScale).toBe(1.884);
    expect(model.jumpImpulse).toBe(tuning.movement.jumpImpulse);
  });

  it('rejects out-of-range constants', () => {
    const j = JSON.parse(readText('../data/tuning.json')) as { weapons: { _engine: Record<string, unknown> } };
    j.weapons._engine['recoilYawSign'] = 0;
    expect(() => parseTuning(j)).toThrow(/recoilYawSign/);
    const k = JSON.parse(readText('../data/tuning.json')) as { weapons: { _engine: Record<string, unknown> } };
    delete k.weapons._engine['penMinDamage'];
    expect(() => parseTuning(k)).toThrow(/weapons\._engine\.penMinDamage/);
  });

  it('armsContext needs the block', () => {
    const { weaponModel: _unused, ...rest } = tuning;
    void _unused;
    expect(() => armsContext(table, rest, 64)).toThrow(/weapons\._engine/);
  });
});

/**
 * R1 / #55: the gunplay conformance checklist (docs/weapons.md "Gunplay conformance"). Each test names its line (G1…);
 * the rules are CS:GO's 2020 source (S9) on CS2's weapon fields (S1) unless the checklist says otherwise.
 */
describe('gunplay conformance checklist', () => {
  const fresh = (id: string): ArmsState => freshArms(ctx, id, -1000);
  const idle = (s0: ArmsState, from: number, ticks: number, inp: Partial<ArmsInput> = {}): ArmsState => {
    let s = s0;
    for (let t = from; t < from + ticks; t++) s = stepArms(ctx, s, { tick: t, attack: false, attack2: false, reload: false, view, motion: still, ...inp }, new Rng(1)).state;
    return s;
  };
  /** The recoil index after `n` held shots then `pause` idle ticks, by CS:GO's rule (UpdateAccuracyPenalty). */
  const expectedIndex = (n: number, lastShotTick: number, firstIdleTick: number, pause: number, cycleTicks: number): number => {
    let i = n;
    for (let t = firstIdleTick; t < firstIdleTick + pause; t++) if (t > lastShotTick + 1.1 * cycleTicks + 1e-6) i = i * Math.exp((-Math.log(10) * 2) / 64);
    return i;
  };

  it('G1: the recoil index advances by one per round fired, not on dry fire or during a reload', () => {
    const { s, shots } = hold(fresh('ak47'), 39, 0);
    expect(shots.length).toBe(6);
    expect(s.recoilIndex).toBe(6);
    // empty magazine: holding fire dry-fires (and then reloads), the index only decays
    const empty = { ...s, clip: 0, reserve: 0 };
    const r = hold(empty, 20, 39);
    expect(r.shots.length).toBe(0);
    expect(r.s.recoilIndex).toBeLessThanOrEqual(6);
    const started = idle({ ...s, clip: 5 }, 39, 1, { reload: true }); // R on tick 39: the magazine reload starts
    expect(started.reload).not.toBeNull();
    const reloading = hold(started, 64, 40);
    expect(reloading.shots.length).toBe(0); // fire is blocked while the magazine reload runs
    expect(reloading.s.recoilIndex).toBeLessThan(6);
  });

  it('G2: after the last shot the index holds for 1.1 cycles, then × e^(−ln 10 × 2 × dt) per tick (a tenth every 0.5 s)', () => {
    const { s, shots } = hold(fresh('ak47'), 59, 0); // 10 shots, last on tick 58
    expect(shots.length).toBe(10);
    const last = shots[shots.length - 1] as number;
    for (const pause of [5, 8, 16, 32, 64]) {
      const st = idle(s, 59, pause);
      expect(st.recoilIndex, `pause ${pause}`).toBeCloseTo(expectedIndex(10, last, 59, pause, 6.4), 4);
    }
    expect(idle(s, 59, 7 - (59 - last)).recoilIndex).toBe(10); // still 10 within 1.1 cycles (7.04 ticks)
  });

  it('G3: a full 30-round spray restarts at bullet 1 after a ≥ 0.86 s pause; after 0.5 s it resumes mid-pattern (entry 5)', () => {
    let s = { ...fresh('ak47'), reserve: 0 };
    const r = hold(s, 187, 0);
    expect(r.shots.length).toBe(30);
    expect(r.shots[29]).toBe(186);
    s = { ...r.s, clip: 30 };
    const after = (ticks: number): number => Math.floor(idle(s, 187, ticks).recoilIndex);
    expect(after(31)).toBe(5); // 0.5 s after the last shot: bullet 6's kick next
    expect(after(55)).toBe(0); // 0.875 s: back at bullet 1
    expect(after(50)).toBeGreaterThanOrEqual(1); // 0.8 s: still mid-pattern
  });

  it('G4: 2–3 round bursts stay near the first bullet: a 3-round burst, 0.25 s pause, the next burst starts at entry 1', () => {
    const b1 = hold(fresh('ak47'), 14, 0); // ticks 0, 7, 13
    expect(b1.shots).toEqual([0, 7, 13]);
    const s = idle(b1.s, 14, 16);
    expect(Math.floor(s.recoilIndex)).toBe(1);
    // bullet 1 of the next burst kicks with entry 1 (Valve's second entry), its aim is the decayed punch only
    const shot = fireShot(ctx, s, new Rng(3), view, still, 30).shot;
    expect(shot.recoilIndex).toBeCloseTo(s.recoilIndex, 9);
  });

  it('G5: a tap after a 5-round burst: the penalty falls back with the stand → final recovery of the integer index', () => {
    const ak = W('ak47');
    const b = hold(fresh('ak47'), 27, 0); // ticks 0, 7, 13, 20, 26
    expect(b.shots.length).toBe(5);
    // penalty after the burst: stand + 5 × fire, decayed in between; then idle and compare with CS:GO's loop
    let p = b.s.penalty;
    let i = b.s.recoilIndex;
    for (let t = 27; t < 27 + 32; t++) {
      const decayIndex = t > 26 + 1.1 * 6.4 + 1e-6;
      p = Math.max(0.00641, 0.00641 + (p - 0.00641) * Math.exp((-1 / 64) * (Math.log(10) / recoveryTime(ak, false, i))));
      if (decayIndex) i *= Math.exp((-Math.log(10) * 2) / 64);
    }
    const s = idle(b.s, 27, 32);
    expect(s.penalty).toBeCloseTo(p, 5);
    expect(s.recoilIndex).toBeCloseTo(i, 4);
  });

  it('G6: semi-automatic weapons kick with a random table entry (CWeaponCSBase::Recoil: GetPredictionRandomSeed), full-auto with the index', () => {
    const g = fresh('glock');
    const kicks = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const r = fireShot(ctx, g, new Rng(seed), view, still, 0);
      kicks.add(`${r.state.punch.aimVel.pitch},${r.state.punch.aimVel.yaw}`);
      expect(fireShot(ctx, g, new Rng(seed), view, still, 0).state.punch).toEqual(r.state.punch); // deterministic
    }
    expect(kicks.size).toBeGreaterThan(10);
    const a = fireShot(ctx, fresh('ak47'), new Rng(1), view, still, 0).state.punch;
    expect(fireShot(ctx, fresh('ak47'), new Rng(2), view, still, 0).state.punch).toEqual(a);
  });

  it('G7: two independent cones (inaccuracy then spread), the spread cone is the vdata m_flSpread, nospread off', () => {
    const ak = W('ak47');
    const rng = new Rng(5);
    const d = drawSpread(ak, 0, 0.01, 0, rng);
    const r2 = new Rng(5);
    const r1 = r2.next();
    const t1 = r2.next() * 2 * Math.PI;
    const q = r2.next();
    const t2 = r2.next() * 2 * Math.PI;
    expect(d.pellets[0]?.x).toBeCloseTo(Math.cos(t1) * r1 * 0.01 + Math.cos(t2) * q * ak.spread[0], 12);
    expect(ak.spread[0]).toBe(0.0006);
  });
});
