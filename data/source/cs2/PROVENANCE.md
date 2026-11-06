# CS2 Mirage source files (G2)

**These files are derived from Valve's Counter-Strike 2 game files.** Valve owns them. They stay in this private
repository, and in the password-locked (encrypted) pages built from it. Never commit them, or anything that contains
them unencrypted, to a public repository. That includes `data/geometry/*`, which is built from them, and the
plaintext single-file page.

| File | Bytes | SHA-256 | What it is |
| --- | ---: | --- | --- |
| `de_mirage.mesh` | 1,409,404 | `d5e3aabe17583f07ca899236d015ecc46f7e542fa093ada4782944941b41e679` | collision mesh (awpy `AWMH` v1) |
| `de_mirage.nav` | 469,296 | `2ba8608994c178dc5ff2553fefdd2a8473aadd0e0b09b8004201e1fa578bb0bd` | CS2 nav mesh, raw bytes from the game (version 36) |
| `de_mirage.png` | 143,685 | `c8032f6c83ffca63c0a20ebdcc598a0e1aa618efd746e381e2db26f33a4a964f` | CS2 radar, 1024 × 1024 RGBA (alpha 255 on the playable area, 0 elsewhere) |

## Where they came from

The **awpy-data** release `2000942` (GitHub `pnxenopoulos/awpy-data`). It was built by that repository's CI from a
CS2 install (anonymous steamcmd) and generated at 2026-11-05T08:04:06Z. From its `manifest.json`:

| Field | Value |
| --- | --- |
| `client_version` / `server_version` / `release_key` | 2000942 |
| `patch_version` | 1.41.9.6 |
| `source_revision` | 11206718 |
| `version_date` / `version_time` | Nov 04 2026 / 16:01:59 |
| Steam `buildid` | 26445667 |

The release assets, downloaded 2026-11-06 and checked against `manifest.json`:

| Asset (`https://github.com/pnxenopoulos/awpy-data/releases/download/2000942/<asset>`) | SHA-256 | Member used |
| --- | --- | --- |
| `geometry.zip` (56,674,290 bytes) | `de756f94cc27270cbed5c8c6aa3b9ab04abbc0f0b5107135c4aa69ca21baf605` | `de_mirage.mesh` (CRC-32 `112f9209`) |
| `navs.zip` (8,432,990 bytes) | `a9ea330843d13960fe487907f8e4660543e04a84122b2e247fe189a26517c175` | `de_mirage.nav` (CRC-32 `d93ad855`) |
| `images.zip` (2,876,805 bytes) | `eefb39d6519b9dabca82100fc0958e8762550d85ad1aa344836d92ff363f531c` | `radars/de_mirage.png` (CRC-32 `739fde88`) |
| `map_data.json` | `b0c8e7e95839b283f311e01c7d7022e5fe701bcfbb44134e7cedccec0f916e67` | `de_mirage`: `pos_x −3230`, `pos_y 1713`, `scale 5`, `rotate 0` |
| `manifest.json` | `5861318bc2ba288ce7683b7371f3a0d9e378fc412fafaca89ee5ef72d09c6af0` | |

`map_data.json` gives the same radar transform as the 2020 data (`docs/conventions.md`), so the CS2 files and
`data/round.json` share one coordinate frame. To fetch the same files again, use the URLs above with the release tag
`2000942`. The awpy Python package (`pip download awpy`, v3.1.1) reads them: `awpy/data.py` and the
`VisibilityChecker` / `NavMesh` stubs in `awpy/_awpy.pyi`.

## How awpy-data made them (what is and isn't in the mesh)

From awpy-data's `README.md` and `scripts/process_geometry.py` (read 2026-11-06):

- **`.mesh`**: Source2Viewer-CLI exports `maps/de_mirage/world_physics.vmdl_c` (the map's physics, the collision the
  engine moves players against) to glTF with material names. `process_geometry.py` then:
  1. **drops every primitive whose material name contains** `playerclip`, `grenadeclip`, `sky`, `passbullets`,
     `glass` or `window` (case-insensitive). The mesh is meant for line of sight, so **player clips, glass and
     bullet-pass railings are not in it**. For movement, that means invisible walls, clip ramps and the clips that
     keep players off roofs and wall tops are missing.
  2. keeps positions only and welds identical vertices;
  3. **decimates by vertex clustering on an 8-unit grid**: each 8 × 8 × 8 cell keeps the first vertex seen in it,
     every vertex in the cell moves there, and triangles that collapse are dropped. Surfaces can move by up to about
     one cell and small gaps can open.
- **`.nav`**: `maps/de_mirage.nav`, copied byte for byte from the map's VPK.
- **`.png`**: `de_mirage_radar_psd.vtex_c` from `pak01_dir.vpk`, decompiled to PNG.

## Formats

**`de_mirage.mesh` (AWMH v1)**, little-endian. A 16-byte header: `u32` magic `0x484D5741` (`"AWMH"`), `u32`
version (1), `u32` vertex count (44,159), `u32` triangle count (73,290). Then the vertices as `float32 x, y, z` and the
triangles as three `uint32` vertex indices each (largest index 44,158). 16 + 44,159 × 12 + 73,290 × 12 bytes is
exactly the file size. Hammer units, z up, the same frame as the demos and our tracks. Bounds: x −4096 … 1824,
y −3864 … 2048, z −448 … 771. Triangle winding is not consistent: about 6 % of vertical lines through the map
cross faces in an order that no closed solid could produce. So the data has to be treated as a two-sided surface
soup, not as closed solids (`docs/geometry.md`).

**`de_mirage.nav` (CS2 nav, version 36, sub-version 1)**. Layout as in ValveResourceFormat's
`NavMesh/NavMeshFile.cs`: magic `0xFEEDFACE`, version, sub-version, analyzed flag, places (none in this file),
a binary KV3 block (movable-mesh settings), the shared polygon corners (3,613) and polygons (2,544, triangles and
quads), movable meshes (none), a KV3 block, the areas (2,544, all hull 0: id, attribute flags, polygon index,
connections per edge), then ladders, bounds, generation parameters and CS2's bot-analysis KV3.
`tools/extract-geometry.ts` reads it as far as the areas.

**`de_mirage.png`**: 1024 × 1024 RGBA PNG. Pixel (px, py) is world (x, y) with px = (x + 3230) / 5 and
py = (1713 − y) / 5.

Built from these files: `data/geometry/` (`tools/extract-geometry.ts`, `docs/geometry.md`).
