# Coach page (K3)

The page around the analysis: drop a demo, pick which player you are, get the match page with the round strip, the
place for the fixes and the 2D replay that every finding links into. Everything runs in the tab; nothing is uploaded.

```sh
npm run dev:coach          # dev server (serves the map packs too)
npm run build:coach        # dist-coach/
CHROME_PATH=/usr/bin/google-chrome npm run check:browser:coach   # the browser check (below)
```

## Structure

| File | What |
| --- | --- |
| `coach/index.html`, `src/coach-app/main.tsx` | the app: home (drop zone, progress, picker, library), routing, the match route |
| `src/coach-app/client.ts` | the page's side of the pipeline: one worker per dropped demo; `.dem*` through K1's parser when the build has it |
| `src/coach-app/worker.ts`, `protocol.ts` | the pipeline worker and its messages |
| `src/coach-app/stub-report.ts` | the report without analysis (match facts, round summaries, replay) |
| `src/coach-app/library.ts`, `pack.ts` | IndexedDB library and its storage codec |
| `src/coach-app/prefs.ts` | the remembered player (Steam ID, localStorage) |
| `src/coach-app/MatchPage.tsx` | header, round strip, fixes, strengths, evidence viewer, the replay, skill areas (K5: docs/coach/report.md) |
| `src/coach-app/report/`, `viewers/`, `charts/`, `display.ts`, `feedback.ts` | K5: cards and rank strips, duel view and spray plot, chart renderers, Hide names, feedback (docs/coach/report.md) |
| `src/coach-app/replay/engine.ts`, `Replay.tsx` | the canvas replay and its HUD and controls |
| `src/coach-app/maps.ts`, `config.ts` | map packs (`MAP_PACK_BASE`), clock constants |
| `src/coach/report/replay.ts` | replay tracks from `RawDemo` + `Match` (pure, tested in Node: `tests/coach/replay.test.ts`) |
| `tools/coach/browser-check.ts` | headless Chrome check |

## Routes

| Hash | Page |
| --- | --- |
| `#/` | drop zone and library |
| `#/m/<id>` | a match (the first played round in the replay) |
| `#/m/<id>/r/<round>?t=<tick>` | that round, at that demo tick |
| `#/m/<id>/r/<round>?t=<tick>&ev=<f>.<e>` | evidence `e` of finding `f` (indices into `report.findings` and its `evidence`) |

`<id>` is the first 16 hex digits of the demo's SHA-256. A finding's "Watch" link is the last form with `t` five
seconds (`WATCH_LEAD_SEC`) before the evidence's `focus`: the replay opens the round there, plays at 1×, draws the
evidence's annotations during their tick ranges, rings the evidence's players, shows the caption over the map and
pauses at `tick1`. Finding markers (the `focus` of every evidence in the round) sit on the timeline.

## Pipeline and worker protocol

```
page (client.ts)                                   worker (worker.ts)
 .craw/.craw.gz ── { type: 'load', file, fileName, mapBase } ──►  read (gunzip) → decodeRawDemo → ingestMatch
 .dem*  → K1 parseDemo (its own worker) → RawDemo
        ── { type: 'raw', raw, … } (typed arrays transferred) ──►  ingestMatch
        ◄── { type: 'progress', stage, fraction }   stages: reading, parsing, rounds, analysis, replay
        ◄── { type: 'parsed', info }                 map, score, first sides, the ten players with K/D/A/ADR
 picker ── { type: 'analyze', user } ──────────────────────────►  los (map pack) → analyze() or stub → buildReplay
        ◄── { type: 'report', report, source, note, replayBytes, timings }   replay typed arrays transferred
```

The worker keeps the `RawDemo` and the `Match`, so choosing another player ("Change player" on the match page)
re-runs only the analysis. Seams that keep the build working while other cards land:

- **Parser (K1).** `client.ts` finds `src/coach-parser/index.ts` with `import.meta.glob`; without it a demo gets
  "Demo parsing isn't built into this build yet. Drop a .craw or .craw.gz instead". A `.craw.gz` is told from a
  `.dem.gz` by its name (the gzip hides the `CRAW` magic).
- **Analysis (K2).** `worker.ts` finds `src/coach/analyze/index.ts` the same way and calls
  `analyze(raw, match, { user, los })`, with `los` from the map pack's `los.bin.gz` when it loads. If the module is
  absent or throws, the report is the stub (`coachVersion` `coach-page-stub@1`) and the page says why. Either way the
  worker sets `report.replay` from `buildReplay`.

## Library (IndexedDB)

Database `cs2-coach`, version 1:

| Store | Key | Value |
| --- | --- | --- |
| `entries` | `id` | `LibraryEntry`: added (ms), file name, map, demo SHA-256, the user (slot, name, Steam ID, team), score (user's team first), the user's team's rounds won/played per side, finding count, coach version, stored bytes |
| `reports` | `id` | `{ id, bytes }`: the `MatchReport` (replay included) through `packGzip` (JSON + typed arrays, gzipped) |

Never the demo or the `RawDemo`. Dropping the same demo again replaces its entry. The list reads only `entries`;
opening reads one report (19 ms for the test demo in headless Chrome). The remembered player is
`localStorage['cs2-coach.user.steamId']`; when he is in the next demo, the analysis starts without the picker.

## Replay data (`src/coach/report/replay.ts`, `ReplayTrack`)

Per round, from 3 s before the freeze end (`replay.freezeLeadSec`) to the official end: every player at 16 Hz
(`replay.hz`; sample k = tick `tick0 + 4k`, nearest grid row): `xy`, `z`, `yaw` (Int16), `health`, `weapon`,
`place`, `flags` (Uint8: alive, kit, bomb carrier, defusing, scoped, flashed, airborne, reloading), the side of
each slot, the phases (start, freeze end, plant, end, official end), and the events: kills with both positions,
shots (position, yaw, the victim hit on that tick), hurts (health removed), blinds, grenade paths, effects (smokes
and fires until their expiry event of the same entity, HE and flash bursts; fallbacks in `data/coach/tuning.json`
`replay`) and bomb events with positions. The bomb carrier comes from the bomb pickup / drop / plant events.

Test demo (10 rounds, 9 played): **1.73 MB** in memory (12 bytes per player-sample, 116 KB of events per round
on average), built in 40–115 ms; stored gzipped with the report: **0.41 MB**. A 24-round match is about 4 MB in
memory and 1 MB stored.

## The 2D replay

- The radar from the map pack (`MAP_PACK_BASE` + `<map>/pack.json`, `radar.png`, `radar_lower.png`), cropped to
  its drawn area; world → radar with the pack's transform. On two-level maps (`lowerBelowZ`) the level shown follows
  the user (Auto) or is fixed (Upper / Lower); players and grenades on the other level are drawn faded with a dashed
  outline.
- Players: side colour, name, health ring, weapon, view cone, the user in the accent colour with an outer ring,
  bomb carrier (red square) and kit (blue plus), white body while flashed, a defuse progress ring, dead players as
  crosses that fade to a faint mark. Linear interpolation between samples (yaw the short way round).
- Events: shot tracers (to the victim on a hit), hit rings, kill lines in the killer's colour (dashed through a wall
  or smoke) with the kill feed beside the map, grenade trails until they land, smokes, fires, flash and HE bursts,
  the dropped or planted bomb with its countdown, defused and exploded.
- Annotations (`Annotation` in `report.ts`): `line` (dashed optional), `circle`, `cone`, `path` (revealed by its
  `ticks`), `zone`, `label`; colour roles map to the theme (`user`/`accent` → accent, `teammate`/`enemy` → the user's
  and the other side's colour this round, `ct`, `t`, `good`, `bad`, `neutral` → dim).
- Controls: play/pause, 0.25×–4×, previous/next kill, round picker, the round strip; the timeline shows freeze, live
  and planted phases, kills (the user's in the accent, his death as a cross), plant and defuse, finding markers and
  the evidence range; drag to scrub. Keys: space, ←/→ 5 s (Shift 1 s), ↑/↓ speed, `[`/`]` kills, `,`/`.` rounds.
- One requestAnimationFrame loop draws only while playing or after a change; the HUD around the canvas updates at
  most four times a second. Headless Chrome on this workspace: 60 fps, 0.3 ms mean draw, 3–6 ms worst frame.

## Browser check

`tools/coach/browser-check.ts` builds the page, serves it with `vite preview` (which serves the map packs) and, in a
fresh profile: drops the test demo's `.craw` (`--craw`; default the shared cache, else the committed anonymized
fixture, which has a full grid for round 4 only), picks a player (`--user`), checks positions in every played round
(every living player on the radar's drawn area within 30 units and inside his place name's box from `places.json`),
checks every kill line of round 4 (`--round`) appears on its tick, plays 4 s and measures frames, tries the keys,
adds a synthetic finding with every annotation kind to the stored report, follows its Watch link, and reopens the
match from the library after a reload. It fails on console or page errors. K5 extended it to the report (fix cards,
rank strips, areas, duel view, spray plot, synthetic charts, feedback and its export) with names hidden throughout:
docs/coach/report.md "Browser check". Screenshots go to `logs/coach/`
(gitignored: with the real demo they show player names; run with the fixture for shareable ones).

Last run (full test demo `.craw`, 43 MB): drop → picker 0.23 s, drop → interactive 0.6 s including the pick;
454 positions on the radar and in their places, 0 off; 3 of 3 kill lines; 63.7 ticks/s at 1×, 60 fps.
