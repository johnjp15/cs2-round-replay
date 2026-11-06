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
