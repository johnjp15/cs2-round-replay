# Mirage nav mesh (`data/mirage-nav.json`, `src/sim2d/nav.ts`)

## Source and extraction

The mesh comes from the old single-file replay page `web-apps/cs2/mirage-round-replay/index.html`
(do not open it whole; it is 392 KB). Its `<script id="data" type="application/json">` block holds:

- `nav`: 903 rows `[x1, y1, x2, y2, z1, z2, placeIndex]`, integers, Source units, Mirage world frame.
- `places`: 27 place names indexed by `placeIndex` (index 0 is `""`, used by unnamed areas).
- `tracks`: recorded player positions `[t, x, y, z, flag]` at 10 Hz (used only for patches, below).

```sh
npx tsx tools/extract-nav.ts ../web-apps/cs2/mirage-round-replay/index.html            # -> data/mirage-nav.json
npx tsx tools/extract-nav.ts <index.html> /tmp/raw-nav.json --no-patches                 # source rows only
```

What was verified about the rows (by script, against all 903 rows and the 3,566 track samples):

- `x1 < x2` and `y1 < y2` for every row; every row has 7 integer fields. Edges are on a 25-unit grid
  for all but 12 rows. 23 pairs of rows overlap in plan (stacked levels).
- `z1` is the height at corner `(x1, y1)` and `z2` at corner `(x2, y2)`. Over the 333 track samples
  standing on sloped areas (|z1 − z2| ≥ 24), interpolating linearly along that diagonal gives a median
  error of 0.2 units (mean 3.0); interpolating along x only gives 2.2 / 6.1, along y only 2.6 / 6.6,
  the reversed diagonal 9.8 / 25, the average 5.0 / 13.4. 386 rows are flat; the largest slope is 128 units.
- The export keeps only two of a Source nav area's four corner heights, so on a ramp that rises along
  one axis the diagonal model is off at the other two corners (see adjacency).

## Format

```json
{
  "meta": { "sourceAreas": 903, "patchAreas": 205, "patchCell": 25 },
  "places": ["", "Apartments", "..."],
  "areas": [{ "id": 0, "x1": 550, "y1": -1425, "x2": 725, "y2": -1300, "z1": -264, "z2": -262, "place": 13 }]
}
```

- `areas[i].id === i`. Ids `0 .. sourceAreas−1` are the source rows in source order; patch areas
  follow, ordered by cell row (y) then column (x). Written with `JSON.stringify(doc, null, 2)`, so the
  file is byte-for-byte reproducible.
- `place` indexes `places`. `meta` is informational; `NavMesh.fromJson` ignores it.

### Patch areas (holes filled from recorded positions)

The exported mesh has holes: 1,292 of the 3,566 recorded positions (36 %) lie outside every source
rectangle (median 0, 90th percentile 31, max 90 units away), e.g. Lokier stands at the Truck
(−2387, 815), 62 units from the nearest area. The extractor therefore adds a 25×25 cell (aligned to
the export's grid) for every cell that contains a recorded position, or a point on the straight chord
between two consecutive positions ≤ 60 units apart, not covered by a source area. Patch height is the
lower median of those samples' z (flat); its place is that of the nearest source area (2D distance + |dz|).
This only ever adds space a player actually occupied in the recorded round. Known side effect: a chord
that cuts a corner can mark a cell that is partly wall.

Reference spots that are **not** on the source mesh and are walkable only through patches:
Truck (−2387, 815; 62 units off), Catwalk (−726, 243; 24), Shop (−2364, −674; 14), Back Alley (−391, 909; 9).

## Walkable space

The union of all areas, each grown by `edgeEpsilon / 2` (so areas touching within `edgeEpsilon` have no
gap between them). `areaAt` uses the exact rectangles (inclusive edges); among stacked areas it picks the
one closest in z to `p.z` when given, else the lowest id. `zAt` and `placeName` fall back to
`nearestArea` for off-mesh points.

## Adjacency rule

Areas A and B are neighbours if either

- they share an edge segment: the gap across it is ≤ `edgeEpsilon` and the shared length is > `edgeEpsilon`; or
- they overlap in plan by more than `edgeEpsilon` on both axes (portal = centre of the overlap),

**and** at some sample point of the shared segment (its ends and middle; for overlaps, the corners and
centre) their interpolated heights differ by ≤ `stepHeight`. Using the minimum over the samples rather
than the maximum is deliberate: with only two corner heights per area, sloped stair areas (e.g. the
Side Alley → House stairs, area 853) are mis-modelled at their other corners, and a max rule cuts House
off from Side Alley and turns T Ramp → Palace Alley into a 6,300-unit detour (30 components instead of 15). With the min rule the main component holds
1,079 of 1,108 areas. Adjacency is symmetric, so one-way drops (balcony → B, T Ramp → Palace Alley) are
not links; paths take the walk-around instead.

## Paths

A* over areas, cost = distance between successive portal midpoints (start point → portal → … → goal),
heuristic = straight-line distance to the goal, ties broken by area id (deterministic). Then greedy
string pulling: from each waypoint, jump to the furthest later corridor point reachable by a walkable
straight segment. Every returned segment is walkable. Off-mesh endpoints are snapped onto the nearest area.

`path(B plant (−1982, 311) → top of T ramp (240, −1500))` is ≈ 3,580 units, via Shop (Market) → CT Spawn
→ Jungle → Bombsite A → T Ramp (≈ 4,040 on the unpatched mesh); straight-line distance is 2,867. The
originally expected 5,000–6,500 matches the T-side route (Apartments → Back Alley → House → Side Alley →
T Spawn → Palace Alley → T Ramp ≈ 6,900), not the shortest walkable one, so the test asserts
2,867 < length < 4,200.

## Line of sight

`lineOfSight(a, b)` is true if the segment stays within `losMargin` of walkable space (each area grown by
`losMargin`). Exact: it walks the segment through the rectangles (Liang–Barsky exits), no sampling.
`losMargin` (8) covers slivers the export leaves between areas at ledges and railings (e.g. the 4- and
12-unit gaps between B site and the Balcony on the Truck → Apartments line).

**Approximation:** anything that is not walkable is treated as a full-height wall, and height is ignored.
Known failure modes:

- Boxes, railings, the Truck and other low cover you can see over are holes in the mesh → LOS false.
- Ledges and drops: seeing down from a ledge (e.g. Balcony) across a drop with no area under it → false.
- Walls thinner than 2 × `losMargin` between two areas → LOS true through the wall.
- Stacked levels (the 23 overlapping source pairs) are merged in 2D → LOS true between floors.
- Windows and gaps in walls that nobody walks through are missing → LOS false.
- Smokes, doors and players do not block.

## Movement clamp

`clampMove(from, to)`: if the whole move is walkable, returns `to`. Otherwise it considers the x-only
slide, the y-only slide and the direct move, each cut to its longest walkable prefix (pulled back 0.01
units), and returns the one ending nearest `to` (ties: x, y, direct). If `from` is off-mesh it returns
`from` unchanged. Outputs carry `z = zAt(...)`.

## Spatial index

Three uniform grids (100-unit cells) over the exact, the `edgeEpsilon/2`-grown and the `losMargin`-grown
rectangles. 50 `lineOfSight` calls take ≈ 0.2–0.3 ms in Node; a cross-map `path` ≈ 0.9 ms; building the
mesh ≈ 12 ms.

## Tunables (`data/tuning.json` → `nav`)

| Key | Value | Meaning |
| --- | --- | --- |
| `stepHeight` | 18 | Max height difference at a crossing point for two areas to connect. |
| `edgeEpsilon` | 1 | Max gap that still counts as touching; walkable space grows by half of it. |
| `losMargin` | 8 | LOS tolerance around walkable space. |

`src/contracts/tuning.ts` ignores unknown keys, so it was not changed; `navOptionsFromTuning()` in
`src/sim2d/nav.ts` reads and validates the `nav` section. A4 may move this into the `Tuning` type later.

## Place names

| # | Place | # | Place | # | Place |
| --- | --- | --- | --- | --- | --- |
| 0 | *(unnamed)* | 9 | House | 18 | Snipers Nest |
| 1 | Apartments | 10 | Jungle | 19 | Stairs |
| 2 | Back Alley | 11 | Ladder | 20 | T Ramp |
| 3 | Balcony | 12 | Middle | 21 | T Spawn |
| 4 | Bombsite A | 13 | Palace Alley | 22 | Ticket Booth |
| 5 | Bombsite B | 14 | Palace Interior | 23 | Top of Mid |
| 6 | CT Spawn | 15 | Scaffolding | 24 | Truck |
| 7 | Catwalk | 16 | Shop | 25 | Tunnel |
| 8 | Connector | 17 | Side Alley | 26 | Tunnel Stairs |
