# P8: taking over cart's bot mid-round (G4)

## Goal

The player watches the round and takes control of cart at any moment, the way CS2 already lets a dead player take
over a teammate bot (spectate it, press E). This card checks that the takeover works on a **locked, input-driven**
bot, that the plugin can allow it for cart only, that the pawn keeps its state through it, and that it can be undone
(a rewind to before it) and done again. `docs/core.md` "Takeover", `docs/port-notes.md` "Takeover",
`docs/cs2-adapter.md` (`human`, `take_control`).

Depends on: P1 (a locked puppet following a track). Needs a CS2 client on the server (a human player).

## Background (why this can fail)

- CS2's takeover is native: a dead player observing a teammate bot presses `+use`; the game fires `bot_takeover`
  (`Userid`, `Botid`, view angles) and the player's controller drives the bot's pawn
  ([EventBotTakeover](https://docs.cssharp.dev/api/CounterStrikeSharp.API.Core.EventBotTakeover.html)). The
  controller schema has `ControllingBot`, `HasControlledBotThisRound`, `BotsControlledThisRound`,
  `CanControlObservedBot` and `OriginalControllerOfCurrentPawn`
  ([CCSPlayerController](https://docs.cssharp.dev/api/CounterStrikeSharp.API.Core.CCSPlayerController.html)), none
  documented. `bot_controllable 1` (default) enables it.
- Bot-Controller's All lock supersedes the bot's `Update` and the injector writes its usercmds: whether a locked bot
  can be taken over at all, and whether the lock or a movement token then fights the player's own usercmds, is not
  documented.
- No CSS API releases a taken-over bot. CS:GO did it on round restart, death or team change of the player.

## Setup

- `exec cs2probe`, `mp_restartgame 1`, `bot_controllable 1`.
- Puppet: `probe_spawn cart T <cart's t = 15 s sample> <yaw> weapon_ak47`, `probe_lock cart all`, following
  `cart-15-25.csv` (cart's recorded track from 15 to 25 s, written like P1's) with `probe_track`.
- A second T bot (`probe_spawn donk T …`, locked, standing) to test the restriction.
- The human joins T and is killed at once (`kill`), so he spectates his team.
- `probe_log on p8-<variant>`; the events CSV must include `bot_takeover` and `player_spawn`.

## Steps

1. **Takeover.** Spectate cart's bot and press E at probe tick 320 (t = 5 s of the track). Log, from 64 ticks before
   to 192 after: cart's pawn position, velocity, eye angles, weapon, clip, HP; the human's `ControllingBot`; the pawn's
   `OriginalControllerOfCurrentPawn`; Bot-Controller's lock state and the movement token.
2. **Stop the puppet.** On the first `OnTick` after `bot_takeover`, cancel cart's movement token and button presses and
   `Unlock(slot, All)`. Variant **a**: do nothing else. Variant **b**: keep the lock (to see whether it fights the
   player's usercmds). The player then walks a square with WASD and fires a few shots.
3. **Restriction.** Spectate donk's bot and press E. Try: (i) write `CanControlObservedBot = false` each tick while the
   observer target isn't cart; (ii) return `Handled` from a `bot_takeover` Pre hook; (iii) `bot_controllable 0` plus
   (i) inverted for cart. Record which one prevents donk's takeover and keeps cart's possible.
4. **Release.** Undo the takeover the way a resync rewind needs it: (i) `ChangeTeam(Spectator)` then back to T, still
   dead; (ii) `CommitSuicide` of the human controller is **not** an option (it would kill cart's pawn): note what it
   does only if (i) fails and nothing else works; (iii) any other route found (a native `ReleaseControlOfBot` signature).
   After the release, re-lock cart (`probe_lock cart all`) and resume `probe_track` from the current tick.
5. **Second takeover** in the same round after the release (step 1 again at tick 960). If refused, clear
   `HasControlledBotThisRound` (and `BotsControlledThisRound`) with `SetStateChanged` and retry.

## Measurements

| Quantity | Unit |
| --- | --- |
| cart's position / velocity / eye-angle jump between the tick before and after the takeover | units, units/s, deg |
| ticks from the E press to `bot_takeover`, and to the first tick the pawn moves by the player's input | ticks |
| variant b: does the locked bot still move by the injector (count ticks where the pawn moves against the player's keys) | ticks |
| restriction: which route blocks donk and keeps cart | route |
| release: the route that works; ticks until the bot drives the pawn again; does the pawn move, die or respawn | route, ticks |
| second takeover: allowed as is / after clearing the flags / impossible | — |

## Pass / fail

- **PASS**: the takeover keeps cart's state (no position jump > 1 unit, velocity and view continuous), the pawn obeys
  the player from at most 2 ticks after `bot_takeover` (variant a), only cart can be taken over, a release returns the
  pawn to its bot alive and in place, and a second takeover works.
- **PARTIAL**: the takeover and the restriction work but release or the second takeover doesn't. Then a rewind to
  before a takeover can't be offered on CS2 (the app hides it once the player has taken over), and the run keeps the
  takeover.
- **FAIL**: a locked bot can't be taken over, or the player's input and the injector fight.

## Fallback

- **Locked bot not taken over:** unlock cart for one tick when the observer target is cart and `+use` is pressed
  (watch `Buttons` of the observing controller), then let the takeover happen.
- **No native release:** replace the pawn: kill cart's bot pawn silently and respawn a fresh bot at the same spot with
  the same loadout (a `teleport` + `give`s, as a resync does); the kill feed line must be suppressed (`player_death`
  Pre hook returning `Handled`).
- **No takeover at all:** the player joins as cart from the round start (the 2D `?human=cart` mode).

## Record

Fill in a P8 section of `results.md`.
