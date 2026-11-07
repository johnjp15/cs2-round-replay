/**
 * V1 · AK-47 time-to-kill through the 3D host (John 11:02: "the AK damage seems too slow").
 *
 *   npx tsx tools/e2e/ak-ttk.ts [--seeds 500]        (npm run test:e2e:ttk)
 *
 * The human (cart) stands still and holds ATTACK at sp4rtan (100 HP, 100 armor + helmet, standing, facing him) 500 u
 * away, aiming at the chest or the head, with (a) no recoil control and (b) a perfect pull-down (the view moves by
 * −pattern before each bullet). Per seed: bullets until the kill, the time from the first shot to the death event, and
 * the damage of each hit. Also the fire cadence (ticks between shots, held) and the per-shot damage from the CS2
 * formula (data/weapons.json from CS2's weapons.vdata).
 */
import { parseWeaponTable, bulletDamage, weaponDef } from '../../src/engine/weapons/index';
import { DEG, HUMAN, TARGET, f, input, mean, quantile, rangeHost, table, tuning, weaponsJson } from './common';

const args = process.argv.slice(2);
const SEEDS = Number(args[args.indexOf('--seeds') + 1] ?? 500) || 500;
const wt = parseWeaponTable(weaponsJson);
const ak = weaponDef(wt, 'ak47');
const pattern = wt.sprays['ak47'] ?? [];
const DIST = 500;

interface Ttk {
  readonly killed: boolean;
  readonly bullets: number;
  readonly ms: number;
  readonly hits: string[];
  readonly shotTicks: number[];
}

function ttk(seed: number, aimZ: number, control: boolean): Ttk {
  const h = rangeHost(seed, { weapon: 'ak47', wall: null, target: { x: DIST, y: 0, yaw: 180, armor: 100, helmet: true, hp: 100 } });
  for (let t = 0; t < 80; t++) {
    h.setHumanInput(input({}));
    h.tick();
  }
  const pitch0 = -Math.atan2(aimZ - 64, DIST) * DEG;
  let bullets = 0;
  let first = -1;
  const hits: string[] = [];
  const shotTicks: number[] = [];
  for (let t = 0; t < 64 * 4; t++) {
    const p = pattern[bullets] as readonly [number, number] | undefined;
    const pitch = control && p !== undefined ? pitch0 - p[0] : pitch0;
    const yaw = control && p !== undefined ? -p[1] : 0;
    h.setHumanInput(input({ pitch, yaw, buttons: ['ATTACK'] }));
    h.tick();
    const shot = h.shots().find((s) => s.shooter === HUMAN);
    if (shot !== undefined) {
      bullets++;
      shotTicks.push(t);
      if (first < 0) first = t;
    }
    const o = h.observe();
    for (const e of o.events) if (e.type === 'damage' && e.victim === TARGET) hits.push(`${e.hitgroup} ${e.amount}`);
    if (o.events.some((e) => e.type === 'death' && e.victim === TARGET)) return { killed: true, bullets, ms: ((t - first) / 64) * 1000, hits, shotTicks };
  }
  return { killed: false, bullets, ms: NaN, hits, shotTicks };
}

function main(): void {
  const rows: (string | number)[][] = [];
  let cadence: number[] = [];
  for (const [label, z] of [
    ['chest (z 48.5)', 48.5],
    ['head (z 63)', 63],
  ] as [string, number][]) {
    for (const control of [false, true]) {
      const rs = Array.from({ length: SEEDS }, (_, k) => ttk(60_000 + k, z, control));
      const k = rs.filter((r) => r.killed);
      if (cadence.length === 0) cadence = rs[0]?.shotTicks ?? [];
      const b = k.map((r) => r.bullets);
      const ms = k.map((r) => r.ms);
      const example = rs[0]?.hits.join(', ') ?? '';
      rows.push([label, control ? 'perfect pull-down' : 'none', `${k.length}/${rs.length}`, f(mean(b), 2), `${quantile(b, 0.5)} / ${quantile(b, 0.9)}`, f(quantile(ms, 0.5), 0), f(quantile(ms, 0.9), 0), example]);
    }
  }
  const gaps = cadence.slice(1).map((t, i) => t - (cadence[i] as number));
  const per = (hg: 'head' | 'chest' | 'stomach' | 'arm' | 'leg', armor: number, helmet: boolean): number => bulletDamage(ak, DIST, hg, armor, helmet, tuning.damage).health;
  console.log(`### AK-47 per-shot damage at ${DIST} u (CS2 formula, data/weapons.json from weapons.vdata: damage ${ak.damage}, armor ratio ${ak.armorRatio} → ${(ak.armorRatio * 50).toFixed(1)} % through armor, HS ×${ak.headshotMultiplier}, range modifier ${ak.rangeModifier} per 500 u, stomach ×1.25, chest/arm ×1, legs ×0.75)\n`);
  console.log(
    table(
      ['target', 'head', 'chest', 'stomach', 'arm', 'legs'],
      [
        ['no armor', per('head', 0, false), per('chest', 0, false), per('stomach', 0, false), per('arm', 0, false), per('leg', 0, false)],
        ['100 armor + helmet', per('head', 100, true), per('chest', 100, true), per('stomach', 100, true), per('arm', 100, true), per('leg', 100, true)],
      ],
    ),
  );
  console.log(`\nShots to kill a 100 HP armored target by the formula: chest ${Math.ceil(100 / per('chest', 100, true))}, stomach ${Math.ceil(100 / per('stomach', 100, true))}, head 1. ` +
    `At 600 RPM (cycle ${ak.cycleTime[0]} s) 4 chest bullets leave on ticks 0, 7, 13, 19–20 → ideal TTK ≈ ${f((3 * ak.cycleTime[0]) * 1000, 0)} ms (first to fourth shot).`);
  console.log(`\nHeld-fire cadence in the host (ticks between shots, first 10): ${gaps.slice(0, 10).join(', ')} → mean ${f(mean(gaps) / 64, 4)} s (CS2 ${ak.cycleTime[0]} s).\n`);
  console.log(`### Time to kill through Sim3DHost, ${SEEDS} seeds each, standing still at ${DIST} u (time = first shot → death)\n`);
  console.log(table(['aim', 'recoil control', 'kills', 'mean bullets', 'bullets p50 / p90', 'TTK p50 ms', 'TTK p90 ms', 'hits of seed 0'], rows));
}

main();
