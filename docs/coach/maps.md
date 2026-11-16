# Coach map packs and line of sight (KM)

The coach needs, per map, a radar to draw on and a mesh to compute line of sight against: the demo has positions and
view angles but no usable sight (`spotted` is the radar's lagging flag). This card delivers both:

| what | where |
| --- | --- |
| map packs (radar, transform, sight mesh) | `data/coach/maps/<map>/`, built by `tools/coach/build-map-pack.ts` |
| line of sight, field of view, smokes | `src/coach/derive/los.ts` (deterministic, no DOM; Node and worker) |
| tunables | `data/coach/los-tuning.json` (`los`; eye heights and the smoke model from `data/tuning.json`) |
| sight check against real kills | `tools/coach/los-check.ts` |
| benchmark | `tools/coach/bench-los.ts` |
| callout vocabulary | `tools/coach/places-report.ts` → `data/coach/maps/de_mirage/places.json` |
| tests | `tests/coach/los.test.ts` (synthetic meshes), `tests/coach/los-packs.test.ts` (the committed packs, Mirage sight) |

## Pack format (`coach-map@1`)

Each `data/coach/maps/<map>/` holds:

| file | what |
| --- | --- |
| `radar.png` | CS2's radar from awpy-data's `images.zip` (`radars/<map>.png`), byte for byte |
| `radar_lower.png` | two-level maps only (Nuke, Train, Vertigo): `radars/<map>_lower.png` |
| `los.bin.gz` | the sight mesh: G2GM (`src/sim2d/geometry.ts`), gzipped at level 9. raw.githubusercontent.com serves `.bin` files uncompressed, so the gzip is what makes the fetch small; the page inflates it with `DecompressionStream('gzip')`, Node with zlib, then `LosWorld.fromBytes` |
| `pack.json` | below |
| `places.json` | optional, `coach-places@1` (Mirage only so far; "Place names" below). Not listed in `pack.json`'s files |

`pack.json` (`CoachMapPack` in `tools/coach/build-map-pack.ts`):

- `format`, `map`;
- `source`: the awpy-data release (`release`, `client_version`, `patch_version`, `buildid`, `generated_at`), every
  asset used (`asset`, download `url`, the zip's `sha256` from the release manifest, `member`, its `crc32` and `bytes`),
  and the map's whole `map_data.json` entry (`mapData`, keys sorted);
- `radar`: `pos_x`, `pos_y`, `scale` (pixel = ((x − pos_x) / scale, (pos_y − y) / scale)), `width`, `height`,
  `lowerBelowZ` (positions with z below it are drawn on the lower radar: map_data's `verticalsections.lower.AltitudeMax`;
  null on one-level maps) and the two file names;
- `los`: `file`, `quant`, `vertices`, `triangles`, world `bounds`, and the `cull` (below) with the nav hull used;
- `files`: name, bytes and SHA-256 of every file; for the gzip also `rawBytes` / `rawSha256` of the G2GM inside;
- `fetchBytes`: what the page downloads for the map.

### The sight mesh

The source is awpy-data's `<map>.mesh`: CS2's `world_physics`, which awpy-data built for line of sight (it drops
`playerclip`, `grenadeclip`, `sky`, `passbullets`, `glass` and `window` materials; docs/geometry.md "Source"). The
build is the sims' (`readAwmh` → `buildMesh` → `encodeGeometry`, tools/extract-geometry.ts) with two changes so that
every pack fits the budget:

1. **Cull.** Every eye-to-body segment has both ends where players can be: on or near the CS2 nav. So both ends lie
   in the prism over the nav's xy convex hull grown by 64 units (plus 1 for the hull's rounding to whole units),
   between the lowest nav floor − 64 and the highest + 200 (eye 64 + a boost 72 + margin). The prism is convex, so
   the whole segment stays inside it, and a triangle that misses it (its xy projection beyond one hull edge, or wholly
   above or below the slab) can never block such a segment. It removes 12–29 % of the triangles (skyboxes, the
   outside of the map, roofs far above play).
2. **Quantization to 1/2 unit** (`quant` 2, error ≤ 1/4 unit) instead of the sims' 1/8: about 10 % smaller after
   gzip, against hitbox radii of 3–7 units.

On Mirage the result answers the same as the sims' full mesh (`data/geometry/mirage-geometry.bin`, quant 8, not
culled) on 488,747 of 488,754 eye-to-body segments of real player pairs (99.999 %; `bench-los.ts`).

### Sizes (awpy-data `2000943`, CS2 1.41.9.7, 2026-11-12)

Budget 1,500,000 bytes per map as fetched (`PACK_BUDGET`); bytes.

| map | release | `radar.png` | `radar_lower.png` | `los.bin.gz` | G2GM inside | triangles (source → kept) | fetched |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `de_ancient` | 2000943 | 89,550 | – | 1,083,384 | 1,739,945 | 455,880 → 357,005 | 1,172,934 |
| `de_anubis` | 2000943 | 218,922 | – | 783,716 | 1,455,620 | 378,619 → 282,291 | 1,002,638 |
| `de_cache` | 2000943 | 93,413 | – | 760,577 | 1,345,929 | 338,375 → 261,560 | 853,990 |
| `de_dust2` | 2000943 | 175,761 | – | 540,714 | 1,019,894 | 239,917 → 200,945 | 716,475 |
| `de_inferno` | 2000943 | 136,914 | – | 1,287,553 | 2,109,954 | 547,966 → 404,075 | 1,424,467 |
| `de_mirage` | 2000943 | 143,685 | – | 178,302 | 320,411 | 73,290 → 57,767 | 321,987 |
| `de_nuke` | 2000943 | 96,995 | 96,487 | 207,501 | 412,174 | 89,563 → 79,044 | 400,983 |
| `de_overpass` | 2000943 | 290,940 | – | 652,289 | 1,092,537 | 243,902 → 213,403 | 943,229 |
| `de_train` | 2000943 | 146,404 | 135,051 | 1,040,054 | 1,783,074 | 428,865 → 351,501 | 1,321,509 |
| `de_vertigo` | 2000943 | 97,762 | 123,826 | 149,808 | 293,199 | 66,048 → 53,774 | 371,396 |

All ten maps (the seven Active Duty maps, Cache included, and Overpass, Train, Vertigo) are in the newest release,
`2000943`, so every pack comes from it. Its Mirage mesh, nav and radar are byte-identical to the `2000942` files the
sims use. Without the cull and at quant 8, Ancient (1.61 MB), Inferno (2.04 MB) and Train (1.65 MB) were over budget.
Inferno is the tightest (95 % of the budget); a map that grows past it would need a coarser quant or a tighter cull.

## Building or refreshing a pack

```sh
npx tsx tools/coach/build-map-pack.ts                        # all ten maps from COACH_RELEASE (2000943)
npx tsx tools/coach/build-map-pack.ts de_nuke                # one map
npx tsx tools/coach/build-map-pack.ts --check                # rebuild in memory; exit 1 if a committed pack is stale
npx tsx tools/coach/build-map-pack.ts --release 2000944      # a newer release (then bump COACH_RELEASE)
```

It downloads the release's `manifest.json`, `map_data.json`, `geometry.zip`, `navs.zip` and `images.zip` into
`logs/awpy/<release>/` (68 MB, gitignored) with `fetchRelease` from tools/build-map.ts, which checks each zip's size
and SHA-256 against the release manifest; `--offline` uses the cache only. It prints the size table above and fails if
a pack is over budget. Same release, same G2GM and `pack.json`; `--check` compares the gzip by its content, because
another zlib may write other gzip bytes. The sims' packages and their pinned release (`DEFAULT_RELEASE` 2000942) are
not touched. New awpy-data tags: `git ls-remote --tags https://github.com/pnxenopoulos/awpy-data` (the GitHub API is
not reachable for that repo from the workspace; the release download URLs are).

## Line of sight (`src/coach/derive/los.ts`)

| member | meaning |
| --- | --- |
| `LosWorld.fromBytes(g2gm)` | wraps `MapGeometry` (sight triangles only). Refuses gzipped bytes with a message |
| `eyeHeight(duck)`, `eyePosition(feet, duck)` | 64 standing, 46 at duck 1, linear between (`damage.eyeHeight` / `crouchEyeHeight` in data/tuning.json) |
| `visible(eye, target, smoke?, tick?, want?, stopAtFirst?)` | `target` = `{ x, y, z, yaw, duck }` (feet). Tests the eye against seven body points and returns `{ any, head, mask }` |
| `bodyPoint(target, i)`, `BODY_POINTS`, `HEAD_BIT` | the points (below) |
| `segmentClear(a, b)` | one segment against the mesh |
| `inFov(viewYaw, viewPitch, eye, point, hFovDeg?, aspect?)` | inside the view frustum (below) |
| `SmokeField(world, detonations)`, `blocks(a, b, tick)` | smokes (below) |

**Body points**, from the hitbox table (`HITBOXES`, src/engine/hitboxes.ts), posed like `poseHitboxes` (forward along
the yaw, left of it) with the crouch scale continuous in `duck` (z × (1 − duck · (1 − 46/64)), never below the box's
radius): head (0, 0, 63), upper chest (0, 0, 48.5), pelvis (0, 0, 29), shoulders (0, ±11, 52), knees (0, ±4.25,
16.75), standing, in mask bits 0–6. Knees rather than feet: points 4.5 units above the feet are hidden by any curb
or floor lip, which says little about whether the player can be seen. The target's yaw is its view yaw (no animation). A point counts as visible when the eye-to-point segment
crosses no sight triangle and, with a smoke field, no opaque smoke.

**Field of view.** CS2's `fov` is 90° horizontal at 4:3 and Hor+ for wider screens: the vertical field stays at
73.7° and the horizontal widens, tan(h/2) = tan(45°) · aspect / (4/3), so 106.3° at 16:9. Defaults in
`data/coach/los-tuning.json`: `fovDeg` 90, `fovAspect` 4/3, `aspect` 16/9. A player on stretched 4:3 sees the 4:3
frustum (pass `aspect` 4/3). Zoomed scopes are not modelled (pass their fov).

**Smokes: the engine's model.** `SmokeField` drives `createSmoke` (src/engine/grenades/smoke.ts) from the detonation
events alone: a Dijkstra flood of 20-unit voxels from the detonation that flows around walls, through doors and
down stairs (each step traced against the pack's sight mesh), at most 750 voxels, growing over 1.2 s; `smokeBlocks`
then integrates density along the segment (opaque at 40 units of full density). The detonation's own expiry tick
(`smokegrenade_expired`; 22.06 s after the detonation in the test demo) ends the smoke, and the density thins
linearly over the last `smokeFadeSec` (3 s) before it; without an expiry the model's 18 s apply. Chosen because it is
cheap enough driven from events: a full flood costs **3.3 ms** (40 smokes of the test demo in 133 ms), and each smoke is
flooded only the first time a segment passes within `smokeQueryRadius` (340 units) of it while it is up. Not modelled:
bullet holes and HE holes in the smoke (both are events in the demo; not wired).

## Sight check against real kills (`tools/coach/los-check.ts`)

```sh
npx tsx tools/coach/los-check.ts                     # the test demo (Mirage); details in logs/coach/los-check.json
npx tsx tools/coach/los-check.ts some.dem --map de_dust2
```

Every `player_death` by a bullet weapon (not a grenade, fire, knife or the world) that is not `penetrated` and not
`thrusmoke`, with both players' positions, yaw and duck amount from the tick data at the kill tick: does the
attacker's eye see any of the victim's body points? Failures are retried at the tick before.

Public test demo (Valve MM, de_mirage, patch 13984, 73 deaths: 10 not by a bullet, 2 wallbangs, 7 through smoke):

| | kills | visible at the kill tick |
| --- | ---: | ---: |
| bullet kills, not wallbang, not through smoke | 54 | **54 (100 %)** |
| … with the head point visible | | 50 |
| through smoke | 7 | 7 by the mesh |

No failures, so none to list. The check is not loose: on the benchmark's 69,822 enemy pairs only 1.3 % of the
eye-to-body segments are clear.

The smoke model on the same kills: **5 of the 7 through-smoke kills** cross opaque smoke in the `SmokeField`, and
**1 of the 54** clean visible kills would be hidden by it (a false positive). The two misses and the false positive:

| tick | kill | nearest smoke | why |
| ---: | --- | --- | --- |
| 30042 | PalaceInterior → PalaceInterior, 429 units, not through smoke | 183 units from the line's middle, 0.97 s before its expiry | in its last second the model's smoke is still at 32 % density over a long path; CS2's has thinned more by then. Fade timing, not geometry |
| 35196 | Jungle → BombsiteA, 150 units, through smoke | 187 units, 1.56 s before expiry | the line misses the model's cloud entirely; `thrusmoke` is set by any smoke the bullet touched, thin edges included |
| 48807 | BombsiteB → Shop, 922 units, through smoke | 346 units, 8.4 s old | the model's cloud does not reach the line (it stays a dome where CS2's spreads further here) |

## Benchmark (`tools/coach/bench-los.ts`)

Mirage pack, the test demo sampled every 16 ticks of live play: 2,528 ticks, 69,822 enemy pairs (both directions),
488,754 eye-to-body segments, mean length 2,063 units. Node 22, this workspace (2 shared cores), 3-second runs:

| query | per second |
| --- | ---: |
| `sightBlocked` over all those segments | **933,000** (790,000–933,000 over runs) |
| `visible()` (7 points, no early exit) | 900,000 segment tests = 128,700 pair queries |
| clear segments only (6,253, mean 873 units: the trace walks the whole line) | 367,000 |
| decode + broad phase of `los.bin` (after gunzip) | 61–78 ms once |

Target 300,000 segment tests a second: met with no change to `MapGeometry` (its 32-unit grid DDA with per-cell z
ranges is the broad phase). Most real enemy pairs are blocked within a few cells, which is why the average beats the
clear-only case.

## Place names (`tools/coach/places-report.ts`)

awpy-data's navs carry no place names, so the callout vocabulary comes from demos: every living player's
`last_place_name` on every tick of live play, with the player-tick count, centroid and bounding box per name.

```sh
npx tsx tools/coach/places-report.ts demo.dem --out data/coach/maps/<map>/places.json
```

`de_mirage/places.json` is from the public test demo (its SHA-256 is in the file; no player data): 23 names over
287,236 player-ticks, from `Apartments` to `Underpass`. The other maps get theirs from John's demos.

## Known limits

- **Static geometry only.** No doors (open or closed), no breakables (Mirage's Market shutter, vents, windows),
  nothing that moves. Glass, windows and `passbullets` surfaces are holes (awpy-data drops them), so sight through a
  window is clear even where the real glass is frosted.
- **Mesh decimation and quantization.** The awpy-data mesh is decimated (Mirage's on an 8-unit grid); small props can
  be a cell off, and the pack adds ≤ 1/4 unit of quantization. A player pressed against a crate edge can be seen or
  hidden a few units early.
- **No player models as blockers**: a teammate's body never blocks.
- **Hitboxes are a rest pose**: no animation, lean or weapon pose; seven points can miss a sliver of a shoulder that
  CS2 renders (a "visible" that needs a pixel-perfect sliver is reported as hidden).
- **The cull assumes players are near the nav.** A player more than 64 units outside the nav's convex hull, or more
  than 200 above its highest floor, could see through culled walls. None did in the test demo.
- **Smokes**: the model's cloud shape and fade are CS2's documented behaviour, not measured on these maps; no bullet
  or HE holes. See the table above.
- **Two-level radars**: `lowerBelowZ` is awpy's split; it is a drawing aid, not a floor test.

## Provenance

Every pack is derived from awpy-data's public releases (pnxenopoulos/awpy-data, built from a CS2 install), the same
kind of data the repo already holds for Mirage and Dust II. `pack.json` keeps the release, URLs, zip hashes and member
CRCs. (The comment in tools/build-map.ts saying Valve-derived files are for a private repo predates the repo going
public; it was left as is.)
