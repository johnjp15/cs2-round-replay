# Scenarios and free play (H3)

A **scenario** is everything a round needs besides the engine: a map package, the round rules, the players' start
state, and optionally a recording to play. The recorded Mirage round is one scenario; a scenario without a recording
is **free play**: every bot is LIVE from the first tick, the human may take over any pawn, and the round ends by the
normal rules (elimination, bomb, defuse, time).

Not to be confused with the human-bot scripts in `fixtures/scenarios/` (`tools/human-bot.ts`): those script a human
through the recorded round and keep their `--scenario` flag. This kind lives in `data/scenarios/` and is chosen with
`--game` in the harnesses and `?scenario=` in the pages.

| scenario | map | what |
| --- | --- | --- |
| `mirage-sp4rtan-1v3` (default) | `mirage-cs2` | the recorded round (`data/round.json`): watch it, or take control of cart with E |
| `mirage-5v5` | `mirage-cs2` | a full-buy 5v5 from the spawns, all bots live; the Ts go for a seeded site |
| `dust2-5v5` | `de_dust2` | the same on CS2's Dust II, on CS2's own nav (`docs/maps.md`) |

## Format (`data/scenarios/<name>.json`, `src/contracts/scenario.ts`)

```jsonc
{
  "format": "cs2-round-replay/scenario@1",
  "name": "dust2-5v5",                // optional; must equal the file name
  "title": "Dust II: 5v5 free play",
  "description": "…",
  "map": "de_dust2",                  // a map package id (src/contracts/maps.ts MAP_IDS)
  "seed": 3,                          // the session seed (AI draws, the site pick); default 1
  "rules": {
    "c4TimerSec": 40,                 // mp_c4timer (default 40)
    "freezeTimeSec": 0,               // mp_freezetime (default 0 here; CS2 uses 15)
    "roundTimeSec": 115,              // mp_roundtime_defuse in seconds (default 115 = 1:55)
    "score": { "ct": 0, "t": 0 },
    "botDifficulty": "normal",        // easy | normal | hard | expert
    "site": null                      // free play: "A", "B" or null (seeded pick)
  },
  "players": [                        // free play: the ten pawn slots, each once
    {
      "id": "donk",                   // the pawn slot: one of the contract's ten ids
      "name": "donk",                 // display name (default: the id)
      "team": "T",
      "spawn": 2,                     // the team's spawn number in the map's map.json …
      "pos": null,                    // … or a fixed start [x, y, z] (then the scenario stays on its map)
      "yaw": null,                    // default: the spawn's
      "hp": 100, "armor": 100, "helmet": true,
      "kit": false,                   // CTs only
      "c4": true,                     // Ts only, at most one
      "weapons": [{ "weapon": "ak47", "clip": 30, "reserve": 90 }, { "weapon": "glock", "clip": 20, "reserve": 120 }],
      "grenades": ["smoke", "flash"], // at most 4
      "money": 800,                   // kept for the HUD; there is no buying
      "role": null,                   // a LIVE role (docs/ai.md) or null for the default plan
      "hold": null                    // where the role holds, or null (from the map's sites)
    }
  ],
  "recording": null,                  // or { "round": "data/round.json", "playable": "cart" }
  "human": null                       // the pawn the human plays from the start, or null to watch
}
```

`parseScenario` validates everything and names the first bad field (`scenario: players[7].c4: only a T carries the
c4`). `npx tsx tools/game-scenario.ts --check` (part of `npm run map:check`) also checks free play against its map:
starts on the radar, the human a pawn.

**With a recording**, `players` is left out (the recording has them) and the recording's own meta (clock, bomb timer,
score) wins over `rules`. Only `data/round.json` plays for now.

**Limits.** Free play needs all ten pawn slots: the Session's RoundModel and the contracts' `PlayerId` are the ten ids
of the recorded round (a smaller roster would mean dead fillers or a contract change). Weapons are the engine's
(`WEAPON_IDS`: AK-47, AWP, SSG 08, Desert Eagle, M4A4, Glock, grenades, c4).

## Free play (`src/core/free-play.ts`)

The Session (src/app/session.ts) is built around a recording, so free play gives it:

- **a synthetic round** (`freePlayRound`): the ten pawns' start states as one-sample tracks, their loadouts as kits,
  no events, the round clock = round time + freeze time; the radar transform from `map.json`. The pages' HUD,
  radar and renderer read it as they read `round.json`.
- **`FreePlayCore`**: a ReplayCore (so the Session's driver logic, checkpoints, rewind and takeover stay as they are)
  with its script off. Its first step teleports and equips everyone (`teleport`, `set_hp`, `give`, `set_weapon`);
  then every living bot gets `set_mode LIVE` with its goal once the freeze time is over (during the freeze the
  human can look around but is held at the start). When the human takes a pawn its AI is released (`set_mode
  REPLAY`); when he leaves it, it goes LIVE again. When the bomb is planted, every LIVE CT is sent to that site
  (`retake` holding at its plant spot: CS2 announces the plant), and the beeps lead him to the bomb from there.
- **the default plan** (`freePlayPlan`), unless a player has a `role`: the Ts go for one site (`rules.site`, else a
  seeded pick); the c4 carrier `plant`s there; the other Ts `take_site` (hold on a 160-unit ring round the plant
  spot, then guard the bomb); the CTs split over the sites (`retake`: hold on a ring there).
- **bot difficulty** (`scenarioTuning`): `easy` reaction × 1.6, aim error × 1.6, 20 % head aim; `normal` the tuning as
  it is; `hard` × 0.8, × 0.7, 45 %; `expert` × 0.6, × 0.5, 55 %. `rules.c4TimerSec` sets `tuning.bomb.timerSec`.

The LIVE AI paths on the map's **CS2 nav** (`src/engine/nav/cs2-nav.ts`, docs/nav.md "CS2 nav") in both engines;
the recorded round keeps the 2020 nav grid (its scenarios, rejoin and duel tests and golden digests depend on it).

## Where scenarios play

| where | how |
| --- | --- |
| 3D page | `?scenario=<name>` (default `mirage-sp4rtan-1v3`), `?map=<package>`; the bar's **Scenario** and **Map** pickers reload the page with them. Free play: spectate any pawn and press E to take it over. |
| 2D page | `?scenario=<name>`: the recording, or free play on Mirage (Sim2DHost with 3D movement; the AI on CS2's nav, the engine's 2D sight and grenade throws on the 2020 grid). Other maps are the 3D page's. |
| `npm run harness3d -- --game <name>` | a recording plays as with no flag (map and playable pawn from the scenario); free play runs to the round end (+1 s) and prints the kills, the bomb and the result. `--map` moves a spawn-based scenario to another map, `--until <s>`, `--seed`, `--human <pawn>`. |
| `npm run harness -- --game <name>` | the same in the 2D engine (free play on Mirage only) |
| `npx tsx tools/game-scenario.ts <name> [--map <id>] [--until <s>]` | free play in the 3D engine; `--check` validates every scenario |

**The locked (single-file) pages embed the default scenario only**: their pickers list just it, and free play needs
the normal build (`npm run build:3d`, which fetches the map packages next to the page). Embedding `mirage-5v5` would
cost the Mirage nav and facts (≈ 60 KB gzipped) and is a size-budgeted later step.

## Results (seed as in the files; this workspace)

| run | result |
| --- | --- |
| `harness3d --game mirage-sp4rtan-1v3`, `harness --game mirage-sp4rtan-1v3` | Played it like the tape: CT defuse, 0.72 s left (both; golden digests unchanged) |
| `harness3d --game mirage-5v5` | T win by bomb_exploded at 74.02 s (plant 34.0 s on A), 9 deaths; the same seed plays the same round |
| `harness --game mirage-5v5` (2D engine) | T win by elimination at 33.92 s (plant 16.6 s) |
| `harness3d --game dust2-5v5` | T win by bomb_exploded at 72.70 s (plant on B 32.7 s) |
| one LIVE T with the c4 from dust2's T spawn (`tests/scenarios-h3.test.ts`) | plants on A at 27.83 s (nav path 4,437 u), on B at 22.13 s (4,085 u) |

Tests: `tests/scenarios-h3.test.ts` (format, validation, the plan, dust2 T spawn → plant on both sites, Mirage free play
to a normal round end and its determinism, takeover of any pawn) and `tests/maps-h3.test.ts` (docs/maps.md).
