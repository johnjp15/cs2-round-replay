# Map packages (X1)

A **map package** is everything a session's 3D world needs: the collision the movement and bullets use, the snapped
tracks, and (optionally) a render mesh. The round, the 2020 nav mesh, the sight mask and the radar are shared by every
package, because they all use Mirage's one coordinate frame (`docs/conventions.md`).

| id | what | files |
| --- | --- | --- |
| `mirage-cs2` (default) | CS2's collision mesh (awpy-data, decimated to 8 units, no clips) with player clips rebuilt from the CS2 nav; rendered from the collision mesh and the radar | `data/geometry/mirage-{geometry,clips}.bin`, `mirage-tracks.json` (`docs/geometry.md`) |
| `mirage-2020` | the March 2020 CS:GO `de_mirage.bsp` the round was played on: its brushes, displacements, props and **its own player clips**, rendered with its materials and lightmaps | `data/maps/mirage-2020/` (below). Built once John's files are in `data/source/csgo-2020/` (`docs/csgo-2020-files.md`) |
| `de_dust2` (H3) | CS2's Dust II from awpy-data, built by `tools/build-map.ts` like any awpy-data map: collision mesh, clips from its CS2 nav, its nav and facts. Free play only (no recording) | `data/maps/de_dust2/` (below) |

H3: every package also has the map's **CS2 nav** (`nav.json`, the LIVE AI's in free play) and **facts** (`map.json`:
radar transform, bomb sites, spawns). Mirage's two packages share `data/maps/mirage-cs2/{nav,map}.json` (one frame).

## Choosing one

| where | how |
| --- | --- |
| 2D app, 3D app | `?map=mirage-2020` (unknown ids fail with the list of known ones; a package that isn't built fails naming the missing file) |
| `npm run harness` / `harness3d` | `--map mirage-2020` |
| a scenario (`fixtures/scenarios/*.json`) | `"map": "mirage-2020"`; `--map` overrides it |
| track snapping | `npx tsx tools/snap-tracks.ts --map mirage-2020 [--check]` → `data/maps/mirage-2020/tracks.json` |
| code | `src/contracts/maps.ts`: `MAP_IDS`, `DEFAULT_MAP`, `parseMapId`, `mapPackagePaths` |

The normal builds find the other packages' files at build time (`src/app/map-packages.ts`, a Vite glob over
`data/maps/*/`). The **single-file (locked) builds embed only the default package**, and `?map=` with another id says
so. Embedding the 2020 package there is a later, size-budgeted step. The 2D app's height layer stays CS2's
(`mirage-height.png`) on every package.

## Building a map package from awpy-data (H3, `tools/build-map.ts`)

```sh
npx tsx tools/build-map.ts de_dust2            # download (cached in logs/awpy/<release>/), verify, extract, build data/maps/de_dust2/
npx tsx tools/build-map.ts de_mirage           # Mirage through the same path: fails if mesh, clips or height image would change
npm run map:check                              # (CI) Mirage rebuilt byte for byte, dust2's nav + facts, every scenario valid
npx tsx tools/build-map.ts <map> --release 2000942 --offline --skip-geometry --skip-clips
```

1. **Download** `manifest.json`, `map_data.json`, `geometry.zip`, `navs.zip`, `images.zip` of the awpy-data release
   (default `2000942`, `https://github.com/pnxenopoulos/awpy-data/releases/download/<release>/…`) into
   `logs/awpy/<release>/` with curl, and check every zip's size and SHA-256 against the release's `manifest.json`.
2. **Extract** `<map>.mesh`, `<map>.nav`, `radars/<map>.png` and the map's `map_data.json` entry into
   `data/source/cs2/<map>/` with a `PROVENANCE.json` (URLs, zip SHA-256s, member CRC-32s, file SHA-256s, the release's
   version fields). Mirage's three files have lived in `data/source/cs2/` since G2: for `de_mirage` the extracted
   bytes must equal them, and nothing is written.
3. **Facts** (`data/source/maps/<map>.json`, below): bomb sites and spawn zones, since the CS2 files carry neither.
4. **Build**: the G2GM mesh, manifest and height image (`buildGeometry` in tools/extract-geometry.ts, with the map's
   radar grid: `pos_x`, `pos_y`, `scale` of map_data, the height ramp over the nav's 2nd–98th percentile heights), the
   player clips from the CS2 nav flood (`buildClipsFor` in tools/extract-clips.ts, plus **nav relief**: a prism that
   walls a standing hull off where CS2's nav has floor, at an area's centroid, corners pulled 12 units in or edge
   midpoints, is dropped; de_dust2: 343 of 5,964 prisms), `nav.json`, `map.json` and `radar.png`. The floods start at
   the spawns (Mirage: the ten recorded start positions, as always).

Mirage stays byte-identical: `mirage-geometry.bin` / `.json`, `mirage-clips.bin` / `.json` and the height image's
pixels are rebuilt through `build-map` and compared (`npm run map:check`; `tests/maps-h3.test.ts` checks the mesh,
`nav.json` and `map.json` quickly). Mirage's clips predate nav relief and keep it off.

| `de_dust2` file | bytes | what |
| --- | ---: | --- |
| `geometry.bin` | 1,313,283 | G2GM, 121,021 vertices / 239,685 triangles (gzip 683,561) |
| `geometry.json` | 2,142 | the manifest (as `mirage-geometry.json`) |
| `clips.bin` / `clips.json` | 278 KB / 4 KB | 5,621 prisms after nav relief |
| `height.png` | 281,704 | 1024², radar-aligned (4.4 units per pixel) |
| `nav.json` | 153,970 | the CS2 nav (format below) |
| `map.json` | 1,466 | facts (format below) |
| `radar.png` | 175,761 | CS2's radar |
| `data/source/cs2/de_dust2/` | 5.0 MB | the awpy-data mesh, nav, radar and `PROVENANCE.json` |

**Any other map** (`de_inferno`, `de_nuke`, … all 24 in release 2000942 parse) needs a facts file and an id in
`MAP_IDS` (src/contracts/maps.ts); then `build-map` makes its package. Ladders are parsed but unused (no ladder
movement yet).

### Map facts (`data/source/maps/<map>.json`)

The awpy-data navs have **no place names** (all 24 maps: 0 places) and `map_data.json` no entities, so where the
sites and spawns are comes from a small hand-made file, cited:

| map | bomb sites | spawns |
| --- | --- | --- |
| `de_dust2` | the CS2 radar's own outlines (orange; colour components in `radars/de_dust2.png`, converted with map_data's transform), unioned with the `CanBePlanter` spots of B3none/cs2-retakes `map_config/de_dust2.json` (commit `2fde4a9`, coordinates only) and grown 64 units | the radar's green spawn zones |
| `de_mirage` | the 2020 nav's "Bombsite A/B" areas (one rect each: what the plant rule always used), planter spots from cs2-retakes | the 2020 nav's "T Spawn" / "CT Spawn" areas |

With `"bspPackage": "mirage-2020"` and that package built, its `func_bomb_target` boxes and `info_player_*` spawns win.
From the zones, `build-map` takes five spawn spots per team: CS2 nav area centroids in the zone, nearest its centre
first, at least 56 units apart, facing the sites; a site's z band is its nav floors −32 / +96; its plant spot is the
planter spots' mean (else the rects' centre), moved into the rects and onto the nav.

### `map.json` (`src/contracts/map-info.ts`, `cs2-round-replay/map-info@1`)

`{ format, map, package, name, radar: {posX, posY, scale, size}, bombsites: [{name, rects: [{x1, y1, x2, y2}], z1, z2,
plant: {x, y, z}}], spawns: {CT: [{x, y, z, yaw}], T: [...]} }`. `bombsiteAt(info, p)` is the plant rule on a CS2 nav.

### `nav.json` (`src/engine/nav/cs2-nav.ts`, `cs2-round-replay/cs2-nav@1`)

`{ format, map, source: {file, sha256, version}, corners: [x, y, z, …] (shared, 1/1000 unit), areas: [[id, flags,
[corner indices], [[area ids] per edge]]], ladders: [{id, top, bottom, width}] }`: the `.nav` as
`tools/cs2-nav-file.ts` reads it (ValveResourceFormat's layout, versions 35 and 36), without KV3, so the browser
parses plain JSON. docs/nav.md "CS2 nav" has the pathfinder.

## `data/maps/<id>/` (built by `tools/extract-bsp.ts`)

```sh
npx tsx tools/extract-bsp.ts                      # data/source/csgo-2020/ → data/maps/mirage-2020/
npx tsx tools/extract-bsp.ts --src ~/mirage-2020  # straight from John's extraction folder
npx tsx tools/extract-bsp.ts --check              # exit 1 if a committed file is stale
npx tsx tools/extract-bsp.ts --bsp tests/fixtures/bsp/test2.bsp --map-name test2 --out logs/test2   # any BSP
npx tsx tools/snap-tracks.ts --map mirage-2020    # then the tracks
```

| file | format | what |
| --- | --- | --- |
| `geometry.bin` | G2GM (`src/sim2d/geometry.ts`) | the player-solid world: brushes, displacements, solid props |
| `clips.bin` | G2GM | player clips (merged into movement by `combineMeshes`, ignored by sight, as with CS2) |
| `grenade-clips.bin` | G2GM | grenade clips, for the grenade physics (not wired in yet) |
| `render.bin` | G2RM (`src/app3d/render-package.ts`) | drawn triangles, a material each, a baked sRGB colour per vertex |
| `tracks.json` | `cs2-round-replay/tracks3d` | the recording snapped onto this package (`tools/snap-tracks.ts --map`) |
| `manifest.json` | `cs2-round-replay/map-package@1` | provenance (BSP/nav SHA-256s, the extraction's `MANIFEST.json` with the depot manifest ID), parameters, counts, bounds, entities, the material palette |

Everything is deterministic: the same inputs give the same bytes (sorted brushes, canonical triangles, sorted lists).
**These are built from Valve's files: private repo and encrypted pages only.**

## What goes where (`tools/bsp/package.ts`)

Collision follows the engine's player mask, `MASK_PLAYERSOLID`:

| source | goes to |
| --- | --- |
| brushes of the world model (walked from its BSP tree) and of solid brush entities (`func_brush` unless `Solidity` 1, `func_wall`, `func_breakable(_surf)`, doors, …) with SOLID, WINDOW, GRATE or MOVEABLE | `geometry.bin`, as each brush's planes clipped to polygons (bevels skipped) and fanned to triangles |
| PLAYERCLIP brushes (without SOLID) | `clips.bin` |
| GRENADECLIP brushes | `grenade-clips.bin` |
| LADDER brushes | `entities.ladders` (boxes) |
| WATER / SLIME brushes | `entities.water` |
| displacements | `geometry.bin` (the engine's triangulation: alternating diagonals) |
| static props (`sprp`) and `prop_dynamic` / `prop_physics*` with a solid type | `geometry.bin`: the `.phy` convex hulls (IVP metres and axes converted) when the model files are there, else the `.mdl` hull box, else nothing (counted in `stats.propsWithoutModel`) |
| `info_player_terrorist/counterterrorist`, `func_bomb_target`, `func_buyzone` (`TeamNum`), `sky_camera`, `skyname` | `entities` |

All triangles are quantized to 1/8 unit (`quant` 8, as the CS2 package). Unlike the CS2 mesh, nothing is decimated,
so walls, doorways, box stacks and stairs are where vbsp put them, give or take 1/16.

Render (`render.bin`):

- Faces of the world model and the drawn brush entities, skipping nodraw, sky, trigger, hint and skip faces, and the
  **3D skybox** (every face in the area of the leaf that holds `sky_camera`). Displacements use their own mesh.
  Props are drawn from the same hulls or boxes as their collision.
- **Material colour**: the VTF's reflectivity (its mean linear colour, from the header) via the VMT's `$basetexture`.
  The BSP's pak file goes first (cubemap patch materials follow `include`), then the extracted folder. Without
  material files, the BSP's texdata reflectivity (vbsp copied the same value into the map) is used, and the name
  palette (`NAME_PALETTE`) only when both are missing.
- **Light**: each vertex samples its face's lightmap (style 0, bilinear; HDR lightmaps when the map is HDR-only),
  scaled by an exposure that maps the 90th-percentile face to the material's own colour, with a floor of 6 %. Props
  get ambient 0.55 + 0.45 × |n · sun|, with the sun taken from `light_environment`.
- Colour = sRGB(material linear × light), per vertex. The 3D app draws it as is (`buildRenderTiles` in
  `src/app3d/world-mesh.ts`), with no radar art.

## Source BSP (`tools/bsp/`)

| module | reads |
| --- | --- |
| `bsp.ts` | VBSP 19–21 (CS:GO is 21): the lump table, Valve-LZMA lumps and game lumps, planes, vertices, edges, surfedges, faces (and `FACES_HDR`), texinfo, texdata and its strings, brushes and sides (CS:GO's bevel byte), models, nodes, leaves (area, leaf faces, leaf brushes, point-in-leaf), displacements (info, verts, tris), static props (`sprp` v4–v11, CS:GO's uniform scale), lighting (LDR or HDR), the pak file, entities |
| `lzma.ts` | the LZMA decoder for Valve's lump header and ZIP method 14 |
| `geometry.ts` | brush polygons, a model's brushes from its tree, face polygons, displacement meshes, lightmap sampling, prop transforms |
| `phy.ts` | `.phy` files and the PHYSCOLLIDE lump (IVP compact surfaces → convex hull triangles) |
| `assets.ts` | VPK directories (v1/v2), the pak file's ZIP, MDL headers (hull boxes, materials, skins), VTF headers, KeyValues / VMT (`patch` includes) |
| `package.ts` | the package above |

**Tests** (`tests/bsp.test.ts`) run on three public test maps in `tests/fixtures/bsp/`: `test2.bsp` (brushes,
player clips, displacements, static props, overlays, entities), `test_physcollide.bsp` (PHYSCOLLIDE) and
`mp_lobby.bsp`. They are handmade TF2 maps (BSP v20) from snake-biscuits' bsp_tool (`tests/maps/Team Fortress 2/`,
GPL-3.0, upstream commit `655627e`), and every count is checked against the `vbspinfo` output that ships with them.
Synthetic v21 files (`tests/bsp-fixtures.ts`) cover what those maps lack: CS:GO contents (player, grenade clips,
ladders), buy zones and bomb sites, v11 props with `.mdl` / `.phy` / VMT / VTF assets, pak-file patch materials, the
VPK chunk planning and the extraction. The LZMA sample was made with liblzma.

## Known limits

- **Displacement flags.** "No physics / no hull collision" displacements would still collide. Mirage's are all solid
  as far as we know. This gets checked against the real file in step 4.
- **Props without `.phy`** fall back to their model's hull box, which is coarser than the engine's own hulls.
- **Detail props and overlays** (grass sprites, decals) aren't drawn. Overlays change no collision.
- **Water** is a box list only (Mirage has none in play).
- `func_door`-style movers are placed in their closed position (Mirage has none that move in a round).
