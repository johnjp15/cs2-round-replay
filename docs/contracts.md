# Contracts

## IHost / ICore (Core ↔ engine, in-process)

Observe (engine → Core, every tick):
- `tick`, `t`
- per pawn (array sorted by id): `id, team, pos{x,y,z}, vel, yaw, pitch, hp, armor, alive, weapon, ammo{clip,reserve}, crouching, sees: ids[]` (`sees` = line of sight and within FOV, engine-computed)
- events since last tick: `damage {attacker, victim, amount, armor, weapon, hitgroup, scripted}`, `shot {shooter, weapon}`, `death {victim, attacker, weapon, headshot}`, `sound {source, pos, kind}`, `bomb {planted|defuse_start|defuse_stop|defused|exploded}`, `round_end {winner, reason}`
- `human: {id | null}` — which pawn the human controls

Act (Core → engine, same tick):
- `inputs[]`: `{id, forward, side, yaw, pitch, buttons[]}` for every REPLAY pawn (`forward/side` in −1..1 relative to the pawn's yaw; buttons `ATTACK, ATTACK2, USE, DUCK, WALK, JUMP, RELOAD`)
- `actions[]`:
  - `damage {attacker, victim, amount, armor, hitgroup, weapon, lethal}` — scripted damage, engine applies it exactly
  - `block_damage {attacker, victim}` / `unblock_damage` — engine must not apply its own bullet damage for that pair while blocked
  - `set_mode {id, mode: REPLAY|LIVE, goal {route: pos[], role, hold: pos}}`
  - `set_weapon {id, weapon}`, `give {id, item, clip, reserve}`, `set_hp {id, hp, armor}`
  - `teleport {id, pos, yaw}` (setup, rewinds, unseen snaps only)
  - `plant {id, pos}`, `defuse_start {id}`, `defuse_stop {id}`
  - `end_round {winner, reason}`
  - `log {level, text}` — for the trigger/status panel
- `status`: per pawn `{mode, trigger, sinceTick}` for the UI

Control (app → Core/engine): `start`, `restart`, `seek {t}`, `checkpoint`, `rewind {id}`, `pause`, `speed {x}`.

Logging: `SessionLog` writes one JSON line per tick `{observe, act}`. `Replayer` feeds a logged observe stream back into any `ICore` and diffs the act output. These logs are also the fixtures for the C# port.

The TypeScript types for all of this are defined in task A4 (`src/contracts`); this document is the human-readable spec they must match.

## Types

The spec above is implemented in `src/contracts/` (re-exported from `src/contracts/index.ts`):

| File | Contents |
| --- | --- |
| `types.ts` | `PlayerId`, `Team`, `Vec3`, `WeaponId`, `Button`, `Hitgroup`, `Mode`, `PawnObs`, `ObsEvent`, `Observe`, `PawnInput`, `Action`, `PawnStatus`, `Act`, `Control`; const arrays (`PLAYER_IDS`, `BUTTONS`, …); `sortById`, `sortIds`, `sortButtons`, `compareOrdinal` |
| `host.ts` | `IHost`, `ICore`, `HostSnapshot`, `CoreSnapshot` |
| `json.ts` | `JsonValue`, `stableStringify`, `parseJsonLine`, `formatNumber`, `roundNumber`, `canonicalize`, `toJsonValue`, `fnv1a32Hex` |
| `session-log.ts` | `SessionLog` (`append`, `lines`, `toText`, `fromText`, `get`, `at`, `length`, `digest`) |
| `replayer.ts` | `replay(log, core)` → `{identical, firstMismatchTick, diffs (≤ 20), mismatchCount, ticks}` |
| `trace.ts` | `toReplayTrace(log)` → data for the web replay page; `DISPLAY_IDS` |

Node file helpers: `tools/session-log-io.ts`. Test doubles (`ScriptedHost`, `EchoCore`): `tests/fakes.ts`.

Details the spec left open, as decided:

- **No optional fields.** Every field is always present; "absent" is `null` (fits `exactOptionalPropertyTypes` and C# records). All fields and arrays are `readonly`.
- **Unions** are discriminated by a string `type` field whose value is the spec name (`damage`, `block_damage`, `round_end`, …). Damage *event* and damage *action* both use `type: 'damage'`; they live in different unions.
- **Spellings.** Player ids lowercase; teams `T`/`CT`; weapons `ak47 awp ssg08 deagle m4a4 knife c4 smoke flash he molotov`; buttons upper case; hitgroups `head chest stomach arm leg`; modes `REPLAY LIVE DEAD`. New, not in the spec: `SoundKind` = `footstep land shot reload grenade bomb`; `RoundEndReason` = `elimination bomb_exploded bomb_defused time`; `LogLevel` = `debug info warn error`.
- **Observe.** `pawns` holds all ten pawns (dead ones too), sorted by id; `human` is a `PlayerId | null` (not an object). `vel` is a `Vec3` in units/s. A dead pawn reports its last weapon. `sees` is sorted and de-duplicated. `events` keep engine emission order.
- **Event fields.** `damage.attacker`, `damage.weapon`, `death.attacker`, `death.weapon` may be `null` (world damage). `bomb` is `{phase, id, pos}`: `phase` is one of the five spec states, `id` the planter/defuser (null for `exploded`), `pos` the bomb position or null. `damage.amount` = HP removed, `damage.armor` = armor removed.
- **Act.** `inputs` has one entry per REPLAY pawn, sorted by id; `buttons` in `BUTTONS` order (`sortButtons`). `actions` keep Core order and the engine applies them in that order. `status` has all ten pawns sorted by id; `trigger` is a free string or null; `sinceTick` is the tick the mode began.
- **set_mode** takes `REPLAY | LIVE` only (`DEAD` is status-only); `goal` is `{route: Vec3[], role: string, hold: Vec3 | null}` for LIVE and `null` for REPLAY. `role` is a free string until Core defines roles.
- **give.item** is a `WeaponId`.
- **Control.** `checkpoint {id}` carries an app-chosen name and `rewind {id}` returns to it; `pause {paused: boolean}` is explicit (no toggle); `seek {t}` is in video seconds; `speed {x}` is a multiplier.
- **Snapshots** are `{kind: 'host' | 'core', data: JsonValue}`; `data` is private to the implementation that made it. Use `toJsonValue` to build it from typed state.
- **Log line** = `stableStringify({act, controls, observe})`. `controls` (new) lists the Control messages delivered to Core since the previous tick, applied before `step`; the Replayer re-sends them. Ticks may repeat (after a rewind); `get(tick)` returns the first such line, `at(i)` any line.
- **Canonical inputs.** Logged numbers are rounded to 6 decimals, so a driver must pass `canonicalize(host.observe())` to `core.step` (or the host must already emit canonical numbers); otherwise a replay feeds Core slightly different numbers than the live run did.
- **Replayer diffs** carry the expected and actual `Act` objects (actual canonicalized), plus a total `mismatchCount`.
- **digest()** is FNV-1a 32-bit over the UTF-8 bytes of `toText()`, 8 lowercase hex digits. `toText()` ends every line with `\n`.
- **Trace.** 10 Hz samples at log ticks `Math.round(i * 6.4)`; `t` is the sample's `observe.t` (3 decimals), positions rounded to whole units, flag always `0` ("observed"); a track stops after its first dead sample. Also emits `players [{id, team, death}]`, `kills` from death events and `events` from death/bomb/round_end events and Core `log` actions (kinds `kill bomb state info`).
