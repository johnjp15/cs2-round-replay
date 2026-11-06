# Contracts

## IHost / ICore (Core ↔ engine, in-process)

Observe (engine → Core, every tick):
- `tick`, `t`
- per pawn (array sorted by id): `id, team, pos{x,y,z}, vel, yaw, pitch, hp, armor, alive, weapon, ammo{clip,reserve}, crouching, sees: ids[]` (`sees` = line of sight and within FOV, engine-computed)
- events since last tick: `damage {attacker, victim, amount, armor, weapon, hitgroup, scripted}`, `shot {shooter, weapon}`, `death {victim, attacker, weapon, headshot}`, `sound {source, pos, kind}`, `bomb {planted|defuse_start|defuse_stop|defused|exploded}`, `round_end {winner, reason}`
- `human: {id | null}` — which pawn the human controls
- `round` (C3): `{phase: live|planted|over, score {ct, t}, winner, reason, endTick, timeLeftSec, bomb {state: carried|dropped|planted|defused|exploded, carrier, pos, plantTick, defuser, defuseEndTick}}` — round state and the C4 (CS2: game rules and the `planted_c4` entity)

Act (Core → engine, same tick):
- `inputs[]`: `{id, forward, side, yaw, pitch, buttons[]}` for every REPLAY pawn (`forward/side` in −1..1 relative to the pawn's yaw; buttons `ATTACK, ATTACK2, USE, DUCK, WALK, JUMP, RELOAD`)
- `actions[]`:
  - `damage {attacker, victim, amount, armor, hitgroup, weapon, lethal}` — scripted damage, engine applies it exactly
  - `block_damage {attacker, victim}` / `unblock_damage` — engine must not apply its own bullet damage for that pair while blocked
  - `set_mode {id, mode: REPLAY|LIVE, goal {route: pos[], role, hold: pos}}`
  - `set_weapon {id, weapon}`, `give {id, item, clip, reserve}`, `set_hp {id, hp, armor, helmet}`
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
| `types.ts` | `PlayerId`, `Team`, `Vec3`, `WeaponId`, `ItemId`, `Button`, `Hitgroup`, `Mode`, `PawnObs`, `ObsEvent`, `Observe`, `RoundObs`, `BombObs`, `Score`, `RoundPhase`, `BombState`, `PawnInput`, `Action`, `PawnStatus`, `Act`, `Control`; const arrays (`PLAYER_IDS`, `BUTTONS`, `ROUND_PHASES`, `BOMB_STATES`, …); `sortById`, `sortIds`, `sortButtons`, `compareOrdinal` |
| `host.ts` | `IHost`, `ICore`, `HostSnapshot`, `CoreSnapshot` |
| `walk.ts` | `WalkQuery` (B2): the engine's walkable-line query, passed to `ReplayCore` |
| `round.ts` | The shape of `data/round.json` (`RoundData`, `Player`, `Kit`, `Track`, `TrackSample`, `Shot`, `Kill`, `Damage`, `Utility`, `Radio`, `Chat`, `Bomb`, …; `Confidence`, `GrenadeId`, `ShotKind`), `parseRound`, `RoundDataError`, `TICKS_PER_SEC`, `toTick`. No file I/O. Field reference: `docs/round-data.md`. |
| `json.ts` | `JsonValue`, `stableStringify`, `parseJsonLine`, `formatNumber`, `roundNumber`, `canonicalize`, `toJsonValue`, `fnv1a32Hex` |
| `session-log.ts` | `SessionLog` (`append`, `lines`, `toText`, `fromText`, `get`, `at`, `length`, `digest`) |
| `replayer.ts` | `replay(log, core)` → `{identical, firstMismatchTick, diffs (≤ 20), mismatchCount, ticks}` |
| `trace.ts` | `toReplayTrace(log)` → data for the web replay page; `DISPLAY_IDS` |

Node file helpers: `tools/session-log-io.ts`. Test doubles (`ScriptedHost`, `EchoCore`): `tests/fakes.ts`.

Details the spec left open, as decided:

- **No optional fields.** Every field is always present; "absent" is `null` (fits `exactOptionalPropertyTypes` and C# records). All fields and arrays are `readonly`.
- **Unions** are discriminated by a string `type` field whose value is the spec name (`damage`, `block_damage`, `round_end`, …). Damage *event* and damage *action* both use `type: 'damage'`; they live in different unions.
- **Spellings.** Player ids lowercase; teams `T`/`CT`; weapons `ak47 awp ssg08 deagle m4a4 glock knife c4 smoke flash he molotov` (`glock` added in B1: donk's secondary); items (`ItemId`) are the weapons plus `defuser`; buttons upper case; hitgroups `head chest stomach arm leg neck generic` (`neck` and `generic` added in C2: CS2 hitgroups 8 and 0; `generic` = no body part, used for grenade, fire and bomb damage; the 2D engine never produces `arm` or `neck`); modes `REPLAY LIVE DEAD`. New, not in the spec: `SoundKind` = `footstep land shot reload grenade bomb`; `RoundEndReason` = `elimination bomb_exploded bomb_defused time`; `LogLevel` = `debug info warn error`.
- **Observe.** `pawns` holds all ten pawns (dead ones too), sorted by id; `human` is a `PlayerId | null` (not an object). `vel` is a `Vec3` in units/s. A dead pawn reports its last weapon. `sees` is sorted and de-duplicated. `events` keep engine emission order.
- **Event fields.** `damage.attacker`, `damage.weapon`, `death.attacker`, `death.weapon` may be `null` (world damage; the bomb's explosion is `attacker: null, weapon: null, hitgroup: generic`). `sound.source` may be `null` (C3, adapter finding F4): bomb beeps have no player (CS2 `bomb_beep` carries only the entity). `bomb` is `{phase, id, pos}`: `phase` is one of the five spec states, `id` the planter/defuser (null for `exploded`), `pos` the bomb position or null. `damage.amount` = HP removed, `damage.armor` = armor removed, both capped at what the victim had (a 111-damage headshot on 100 HP reports 100). A `death` follows the `damage` event that caused it. A blocked hit (`block_damage`) emits no `damage` event, but its `shot` and `sound` are still emitted. Combat rules: `docs/combat.md`.
- **Round (C3).** `Observe.round: RoundObs`, always present:
  - `phase`: `live` until the plant, `planted` while the bomb ticks, `over` from the `round_end` tick on (even if the bomb still ticks).
  - `score: Score {ct, t}`: the current score; the round's win is counted from its end tick on. The engine gets the score before the round from its setup (2D: the Session passes `round.meta.score`, CT 11 – T 15).
  - `winner: Team | null`, `reason: RoundEndReason | null`, `endTick: number | null`: null until the round ends; then they repeat the `round_end` event and its tick.
  - `timeLeftSec`: the round clock while live (2D: `round.meta.clock0` − t), the bomb timer while it ticks (also after a round end); after a defuse the bomb timer at the defuse, after an explosion 0, otherwise frozen at the end tick. Never negative.
  - `bomb: BombObs`: `state` (`carried | dropped | planted | defused | exploded`); `carrier` (the pawn carrying it while `carried`; null otherwise and before anyone has it); `pos` (the carrier's position, where it lies, or the bomb; null when nobody carries it); `plantTick` (null before the plant); `defuser` and `defuseEndTick` (the defuse in progress; after `defused` who defused it and on which tick; else null).
  - A plant in progress is not in the contract. Rules (2D): `docs/combat.md`, "Bomb and round rules".
- **Angles.** `pitch` is Source's: degrees, positive = looking down, 0 = level (C2; the 2D hitscan picks the hitgroup from it, `docs/combat.md`). `yaw` is degrees counter-clockwise from +x (0 = east, 90 = north); its range is not normalized.
- **Act.** `inputs` has one entry per REPLAY pawn, sorted by id; `buttons` in `BUTTONS` order (`sortButtons`). `actions` keep Core order and the engine applies them in that order. `status` has all ten pawns sorted by id; `trigger` is a free string or null; `sinceTick` is the tick the mode began.
- **set_mode** takes `REPLAY | LIVE` only (`DEAD` is status-only); `goal` is `{route: Vec3[], role: string, hold: Vec3 | null}` for LIVE and `null` for REPLAY. `role` is a free string until Core defines roles.
- **give.item** is an `ItemId` (a `WeaponId` or `defuser`, the defuse kit; B1). `clip/reserve` are the gun's magazine and reserve; for grenades, `c4` and `defuser` they are 0, and each `give` adds one item (two smoke gives = two smokes). Every pawn has a `knife` without a give.
- **set_hp** carries `helmet: boolean` (B1) next to `hp` and `armor`.
- **Control.** `checkpoint {id}` carries an app-chosen name and `rewind {id}` returns to it; `pause {paused: boolean}` is explicit (no toggle); `seek {t}` is in video seconds; `speed {x}` is a multiplier.
- **Round data.** `parseRound(json | text)` validates `data/round.json` and returns it typed as `RoundData` (readonly). It checks in depth the fields the Core uses (meta clock/bomb timer, players, tracks, shots, kills, damage, utility, radio, chat, bomb, `timelines.weapon`, `events`), including `tick === toTick(t)` for every pair, and only the container shape of the rest; it throws `RoundDataError` naming the first bad path. `TrackSample.uncertainty` and `.resampled` are the only optional fields (absent in the file); read them as nullable. `tools/*` import these types from `src/contracts` (B1 moved them from `tools/round-types.ts`).
- **Snapshots** are `{kind: 'host' | 'core', data: JsonValue}`; `data` is private to the implementation that made it. Use `toJsonValue` to build it from typed state.
- **Log line** = `stableStringify({act, controls, observe})`. `controls` (new) lists the Control messages delivered to Core since the previous tick, applied before `step`; the Replayer re-sends them. Ticks may repeat (after a rewind); `get(tick)` returns the first such line, `at(i)` any line.
- **Canonical inputs.** Logged numbers are rounded to 6 decimals, so a driver must pass `canonicalize(host.observe())` to `core.step` (or the host must already emit canonical numbers); otherwise a replay feeds Core slightly different numbers than the live run did.
- **Replayer diffs** carry the expected and actual `Act` objects (actual canonicalized), plus a total `mismatchCount`.
- **digest()** is FNV-1a 32-bit over the UTF-8 bytes of `toText()`, 8 lowercase hex digits. `toText()` ends every line with `\n`.
- **Trace.** 10 Hz samples at log ticks `Math.round(i * 6.4)`; `t` is the sample's `observe.t` (3 decimals), positions rounded to whole units, flag always `0` ("observed"); a track stops after its first dead sample. Also emits `players [{id, team, death}]`, `kills` from death events and `events` from death/bomb/round_end events and Core `log` actions (kinds `kill bomb state info`).
- **WalkQuery** (B2). `isWalkableLine(a: Vec3, b: Vec3): boolean` is true if a pawn at `a` can walk straight to `b` (every point of the segment walkable). It must be a pure function of its arguments, because the Core branches on it and a replay must take the same branches. The engine passes it to `new ReplayCore(model, schedule, tuning, seed, walk)`; `null` (the default) turns the puppets off. 2D sim: `NavWalkQuery` (`src/sim2d/walk-query.ts`, `NavMesh.segmentWalkable`, height ignored). CS2: see `docs/port-notes.md` ("Puppets").
- **Tuning** (B2). `ReplayTuning` gained `spikeSpeedFactor`, `spikeMaxSec`, `teleportWindowSec`, `holdLastPositionSec`, `standSpeedThreshold`, `buttonMinSec` and `steerFallbackSec` (all required by `parseTuning`; values and meaning in `docs/core.md` "Puppets").
