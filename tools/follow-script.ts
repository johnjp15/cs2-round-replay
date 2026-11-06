/**
 * Generates `fixtures/scripts/cart-follows-recording.json`: an input script in which the human cart plays his own
 * recorded round, the closest thing to "a human who plays it perfectly" (docs/golden.md).
 *
 *   npx tsx tools/follow-script.ts [--check]    # also part of npm run fixtures:update
 *
 * How: the harness runs the round with cart as the human, and each tick a *shadow* ReplayCore decides cart's input
 * as if he were a puppet (B2's track following, B3's aim, shots, grenades and weapon switches), from the live observe
 * with `human` set to null; in the engagements the recording shows him missing he looks where the recording has him
 * looking (his recorded view yaw, tools/follow-aim.ts) instead of at the target. The shadow never snaps (a human can't teleport: `driftSnapUnits` = 1e9), so where the
 * recording jumps (cart at 14.2–14.5 s and the Balcony drop at 21.0 s) the human catches up physically. Its
 * `set_weapon` actions become the entries' `weapon` (the app's weapon-slot keys). Everything else the shadow sends
 * is dropped. The per-tick inputs are then written as script entries, a new entry only where the held one would
 * give a different input (`"track"` yaw where the input's yaw is the recorded one), and the script is checked: the
 * harness playing the file must give the generation run's log byte for byte.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalize, stableStringify, type PawnInput, type PlayerId, type Tuning, type WeaponId } from '../src/contracts/index';
import { EventSchedule, ReplayCore, RoundModel } from '../src/core/index';
import { NavWalkQuery } from '../src/sim2d/index';
import type { Session } from '../src/app/index';
import { FollowAim } from './follow-aim';
import {
  DEFAULT_SEED,
  ROOT,
  ScriptDriver,
  TrackYaw,
  formatHumanScript,
  loadHarnessData,
  logDigest,
  parseHumanScript,
  resolveEntry,
  runHarness,
  type HarnessData,
  type HarnessRun,
  type HumanCommand,
  type HumanDriver,
  type ScriptEntry,
} from './harness';

export const FOLLOW_SCRIPT = 'fixtures/scripts/cart-follows-recording.json';
export const FOLLOW_HUMAN: PlayerId = 'cart';
/** Drift beyond which a snap would happen: never (a human can't teleport). */
const NO_SNAP_UNITS = 1e9;

/** The shadow puppet: a second ReplayCore that sees cart as a puppet and never snaps. */
export class FollowDriver implements HumanDriver {
  private readonly id: PlayerId;
  private readonly shadow: ReplayCore;
  /** Where the recording shows him missing, he looks where it has him looking (tools/follow-aim.ts). */
  private readonly aim: FollowAim;
  /** Every tick's command, in order (what the script must reproduce). */
  readonly commands: { tick: number; input: PawnInput | null; weapon: WeaponId | null }[] = [];

  constructor(data: HarnessData, seed: number, id: PlayerId) {
    this.id = id;
    const tuning: Tuning = { ...data.tuning, replay: { ...data.tuning.replay, driftSnapUnits: NO_SNAP_UNITS } };
    // B2/B3 only: the shadow decides cart's input as a puppet; B4's triggers would only act on its own (unused) pawns.
    const model = new RoundModel(data.round);
    const schedule = new EventSchedule(data.round);
    this.shadow = new ReplayCore(model, schedule, tuning, seed, new NavWalkQuery(data.nav), { divergence: false });
    this.shadow.control({ type: 'start' });
    this.aim = new FollowAim(data.round, model, schedule, data.tuning, this.shadow.script.plan, id);
  }

  command(tick: number, session: Session): HumanCommand {
    const o = canonicalize(session.observe());
    if (o.tick !== tick) throw new Error(`FollowDriver: observe tick ${o.tick}, expected ${tick}`);
    const act = canonicalize(this.shadow.step({ ...o, human: null }));
    const shadowInput = act.inputs.find((q) => q.id === this.id) ?? null;
    const input = shadowInput === null ? null : this.aim.adjust(tick, shadowInput);
    let weapon: WeaponId | null = null;
    // The setup step's give / set_weapon are the round setup, which the real Core sends the human pawn too.
    const setup = this.commands.length === 0;
    for (const a of setup ? [] : act.actions) {
      if (a.type === 'set_weapon' && a.id === this.id) weapon = a.weapon;
      if (a.type === 'give' && a.id === this.id) throw new Error(`FollowDriver: ${this.id} would pick up ${a.item} at tick ${tick}; scripts can't`);
    }
    this.commands.push({ tick, input, weapon });
    return { input, weapon };
  }
}

/**
 * Script entries for per-tick commands: a new entry only where the held entry would resolve to a different input on
 * that tick, or a weapon switch starts there. Ticks without an input (the pawn is dead) keep the held entry.
 */
export function compressCommands(commands: readonly { tick: number; input: PawnInput | null; weapon: WeaponId | null }[], id: PlayerId, track: TrackYaw): ScriptEntry[] {
  const entries: ScriptEntry[] = [];
  let held: ScriptEntry | null = null;
  let lastYaw = track.startYaw;
  for (const c of commands) {
    if (c.input === null) continue;
    const want = stableStringify(c.input);
    if (held === null || c.weapon !== null || stableStringify(resolveEntry(held, id, c.tick, track, lastYaw)) !== want) {
      const rec = track.at(c.tick);
      held = {
        t: c.tick / 64,
        forward: c.input.forward,
        side: c.input.side,
        yaw: rec !== null && rec === c.input.yaw ? 'track' : c.input.yaw,
        pitch: c.input.pitch,
        buttons: c.input.buttons,
        weapon: c.weapon,
      };
      entries.push(held);
    }
    lastYaw = c.input.yaw;
  }
  return entries;
}

export interface FollowResult {
  readonly text: string;
  readonly entries: readonly ScriptEntry[];
  readonly run: HarnessRun;
  readonly digest: string;
}

/** Generate the script (one harness run with the shadow driver), up to `lastTick`. */
export function generateFollowScript(data: HarnessData, lastTick: number | 'end' = 'end', seed = DEFAULT_SEED): FollowResult {
  const driver = new FollowDriver(data, seed, FOLLOW_HUMAN);
  const run = runHarness(data, { human: FOLLOW_HUMAN, driver, lastTick, seed });
  const entries = compressCommands(driver.commands, FOLLOW_HUMAN, new TrackYaw(run.session, FOLLOW_HUMAN));
  return { text: formatHumanScript(entries), entries, run, digest: logDigest(run.log) };
}

/** Play a script text in the harness (cart as the human). */
export function playScript(data: HarnessData, text: string, lastTick: number | 'end' = 'end', seed = DEFAULT_SEED): HarnessRun {
  return runHarness(data, { human: FOLLOW_HUMAN, driver: new ScriptDriver(parseHumanScript(text), FOLLOW_HUMAN), lastTick, seed });
}

/**
 * Regenerate the follow script and check it: playing the written text must reproduce the generation run byte for
 * byte. Writes the file only when its content changes (and `write`). Returns whether it changed.
 */
export function updateFollowScript(data: HarnessData, write = true, root = ROOT): { changed: boolean; entries: number; digest: string } {
  const gen = generateFollowScript(data);
  const replayed = playScript(data, gen.text);
  const again = logDigest(replayed.log);
  if (again !== gen.digest) throw new Error(`follow script does not reproduce its generation run: ${again} != ${gen.digest}`);
  const path = resolve(root, FOLLOW_SCRIPT);
  const old = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const changed = old !== gen.text;
  if (changed && write) writeFileSync(path, gen.text, 'utf8');
  return { changed, entries: gen.entries.length, digest: gen.digest };
}

function main(): void {
  const data = loadHarnessData();
  if (process.argv.includes('--check')) {
    const gen = generateFollowScript(data);
    const committed = readFileSync(resolve(ROOT, FOLLOW_SCRIPT), 'utf8');
    console.log(`${FOLLOW_SCRIPT}: ${committed === gen.text ? 'up to date' : 'OUT OF DATE (npm run fixtures:update)'}; ${gen.entries.length} entries, run digest ${gen.digest}`);
    if (committed !== gen.text) process.exitCode = 1;
    return;
  }
  const r = updateFollowScript(data);
  console.log(`${FOLLOW_SCRIPT}: ${r.changed ? 'written' : 'unchanged'}, ${r.entries} entries, run digest ${r.digest} (replays byte for byte)`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
