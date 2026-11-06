/**
 * B3's aimed fire items as a check of the sight mask (C4): for each scripted fire item with a target, at each of
 * its shot ticks in the scripted round, is there line of sight from the shooter to the target (as the engine had
 * them at that tick)? Compares the host's Sight (radar mask + level check) with the nav mesh's line of sight, and
 * lists the engine's own hits (blocked by the Core's block_damage, so logged in combatLog).
 *
 *   npx tsx tools/vision-shots.ts
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PlayerId, Vec3 } from '../src/contracts/index';
import { runScriptedRound, type ScriptedRun } from './scripted-round';

export interface FireCheck {
  readonly key: string;
  readonly shooter: PlayerId;
  readonly target: PlayerId;
  readonly kind: string;
  /** Observe ticks of the item's shot events. */
  readonly shots: readonly number[];
  /** Shots with sight (mask + levels) / nav line of sight from shooter to target at that tick. */
  readonly sight: number;
  readonly nav: number;
  /** Engine hits on the target by this shooter during the item (combatLog "blocked" lines). */
  readonly hits: number;
}

function posAt(run: ScriptedRun, tick: number, id: PlayerId): Vec3 | null {
  const line = run.log.get(tick);
  return line?.observe.pawns.find((p) => p.id === id)?.pos ?? null;
}

export function checkFireItems(run: ScriptedRun): FireCheck[] {
  const sight = run.host.sightQuery();
  const nav = run.inputs.nav;
  const out: FireCheck[] = [];
  const plan = run.core.script.plan;
  const combat = run.host.combatLog();
  for (const item of plan.fire) {
    if (item.target === null) continue;
    const target = item.target;
    // Shot events by this shooter that land in the item's window (act ticks fromTick..toTick + latency).
    const shots: number[] = [];
    for (let k = item.fromTick; k <= item.toTick + 2; k++) {
      const next = run.log.get(k + 1);
      if (next === null || next === undefined) continue;
      if (next.observe.events.some((e) => e.type === 'shot' && e.shooter === item.shooter)) shots.push(k);
    }
    let s = 0;
    let n = 0;
    for (const k of shots) {
      // The shot is fired in tick k after movement: positions as the next observe reports them.
      const a = posAt(run, k + 1, item.shooter);
      const b = posAt(run, k + 1, target);
      if (a === null || b === null) continue;
      if (sight.lineOfSight(a, b)) s++;
      if (nav.lineOfSight(a, b)) n++;
    }
    const hits = combat.filter((c) => c.tick >= item.fromTick && c.tick <= item.toTick + 2 && c.text.startsWith(`blocked ${item.shooter} -> ${target} `)).length;
    out.push({ key: item.key, shooter: item.shooter, target, kind: item.kind, shots, sight: s, nav: n, hits });
  }
  return out;
}

export function fireTable(rows: readonly FireCheck[]): string {
  const lines = ['| item | shooter → target | kind | shots (t) | sight (mask + levels) | nav LOS | engine hits |', '| --- | --- | --- | --- | ---: | ---: | ---: |'];
  for (const r of rows) {
    const t = r.shots.length === 0 ? '–' : `${r.shots.length} (${(r.shots[0] as number / 64).toFixed(2)} s)`;
    lines.push(`| ${r.key} | ${r.shooter} → ${r.target} | ${r.kind} | ${t} | ${r.sight} / ${r.shots.length} | ${r.nav} / ${r.shots.length} | ${r.hits} |`);
  }
  const reached = (f: (r: FireCheck) => number): number => rows.filter((r) => f(r) > 0).length;
  lines.push('');
  lines.push(`items with a target: ${rows.length}; with sight at a shot: ${reached((r) => r.sight)} (nav LOS: ${reached((r) => r.nav)}); with sight at every shot: ${rows.filter((r) => r.shots.length > 0 && r.sight === r.shots.length).length}; with an engine hit: ${reached((r) => r.hits)}`);
  return lines.join('\n');
}

function main(): void {
  console.log(fireTable(checkFireItems(runScriptedRound())));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
