# P0: coordinate check (CS:GO 2020 data against CS2 Mirage)

## Goal

Confirm that world coordinates from the recorded round (`data/round.json`, `data/mirage-nav.json`, Source units in
the Mirage frame) put a pawn on the same spot in CS2 Mirage: same height, not inside geometry, not pushed out.

Depends on: S0.

## Setup

- `exec cs2probe`, then `mp_restartgame 1`.
- `probe_spawn probe T 0 0 0 0 weapon_knife`: one T bot used as the surveyor (the real position is set per spot).
- `probe_lock probe all`, so the bot doesn't walk away.
- Optional: a connected client, for `setpos`/`getpos` and screenshots.

Reference spots (x, y, z from the movement doc and the round data; z is the pawn origin, i.e. the feet):

| # | Spot | x | y | z expected |
| --- | --- | --- | --- | --- |
| 1 | B plant | −1982 | 311 | −160 |
| 2 | Top of T Ramp | 240 | −1500 | −176 |
| 3 | Apartments window | −1764 | 794 | −48 |
| 4 | Truck | −2387 | 815 | −127 |
| 5 | Shop | −2364 | −674 | −168 |
| 6 | Catwalk | −726 | 243 | −172 |
| 7 | Tunnel stairs | −786 | 391 | −318 |
| 8 | Palace Alley | 785 | −1144 | −264 |

## Steps

For each spot:

1. `probe_spawn probe T <x> <y> <z+16> 0`: teleport 16 units above the expected height, with zero velocity.
2. Wait 64 ticks (the pawn falls and settles).
3. Record the pawn's origin (`probe_log` for one tick, or a one-off print) and whether `FL_ONGROUND` (bit 0 of
   `Flags`) is set.
4. **Hull test:** `Trace.TraceHullShape(origin, origin, mins (−16, −16, 0), maxs (16, 16, 72), ignore = pawn)`.
   Record `IsAllSolid`/`DidHit()`.
5. **Ground test:** `Trace.TraceEndShape((x, y, z+64), (x, y, z−512), ignore = pawn)`. Record `EndPos.Z`.
6. If a client is connected: `setpos <x> <y> <z+16>`, wait 1 s, `getpos`, and take a screenshot. Name it
   `P0-<#>.jpg`.

Finally, spot-check two moving tracks: teleport to five evenly spaced samples of `tracks.eradicate` (t = 0, 2.5, 5,
7.5, 10) and `tracks.snarlbot` (the ramp), and repeat steps 2–5.

## Measurements

| Quantity | Unit | Feeds |
| --- | --- | --- |
| `dx, dy` = settled origin − requested (x, y) | units | adapter world transform |
| `dz` = settled origin z − expected z | units | adapter world transform |
| on ground (yes/no), hull start-solid (yes/no) | — | — |
| ground z under the spot | units | — |

## Pass / fail

- **PASS**: all 8 spots and all 10 track samples have |dz| ≤ 16, horizontal settle √(dx² + dy²) ≤ 8, are on
  ground, and the hull is not start-solid.
- **PARTIAL**: one or two spots fail but the rest pass. Name them; they may be props or boxes changed in the CS2 port.
- **FAIL**: three or more spots fail, or any spot is inside geometry.

## Fallback

1. If every failing spot shows about the same (dx, dy, dz), store that vector as a global world offset in the
   adapter's config (proposed `data/cs2-transform.json`) and re-run P0 with it applied.
2. If the failures are local, the adapter snaps each recorded position to the nearest walkable CS2 point at load time:
   `CCSNavArea.GetClosestPoint` on the engine nav mesh, or a ground trace for z. Then log the snap distance per
   sample.
3. If CS2 Mirage differs broadly, stop. The REPLAY tracks need re-surveying (a human walks the key routes while
   `probe_log` records), and the 2D sim's nav data should follow.

## Record

Fill in the P0 table in `results.md`: one row per spot and per track sample.
