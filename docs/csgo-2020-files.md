# The March 2020 CS:GO Mirage files (X1, backlog #14)

The round was played on CS:GO's Mirage as it was on **12 March 2020**. This is how to get exactly that map's files:
the compiled map (`de_mirage.bsp`: brushes with their player clips, displacements, static props, lightmaps,
entities), its nav mesh, and the materials and models it uses. **Valve owns these files.** They go into this private
repo (`data/source/csgo-2020/`) and the encrypted pages only, never a public repo.

Everything below runs on John's Mac. The cloud sessions can't log in to Steam.

## The build: depot 731, manifest `7867263815789485437`

| | |
| --- | --- |
| App | **730** (Counter-Strike: Global Offensive then; Counter-Strike 2 now) |
| Depot | **731** "Counter-Strike Global Offensive Beta Common": the platform-independent content (`csgo/maps/`, `csgo/pak01_*.vpk`). 732/733/734 are the Windows/Mac/Linux binaries, which aren't needed. |
| Manifest | **`7867263815789485437`** |
| Build | 4743948, patch **1.37.4.4**, released 5 March 2020 (SteamDB edit time 00:10 UTC) |
| Live until | the next update, 1.37.4.5 (build 4806682), on **22 March 2020** |

### Evidence

- **SteamDB's patch page for build 4743948** (<https://steamdb.info/patchnotes/4743948/>, read 2026-11-07):
  "1.37.4.4 (version 1081) · update for 5 March 2020". Its changed depots are 731, 732, 733 and 734, and the
  depot-history link for 731 carries `M:7867263815789485437`: the manifest that the update made current. The page
  links the previous update (4 March 2020, 1.37.4.3, build 4740140) and the next one (**22 March 2020**, 1.37.4.5,
  build 4806682). So from 5 March to 22 March, 12 March included, depot 731 was at that manifest. That update's
  notes are about the operation coin, co-op and a Mac-10 skin. Mirage isn't mentioned.
- **SteamDB's GameTracking-CSGO history** (`github.com/SteamDatabase/GameTracking-CSGO`, the game files as committed
  at each update) agrees. Commit `c30e818` on 2020-03-05 00:09 UTC is "1081 | 1.37.4.4". The commits before and after
  it are `f772c22` (2020-03-04, 1.37.4.3) and `dfd1a2b` (2020-03-22 23:11 UTC, 1.37.4.5). Nothing landed between
  5 and 22 March.
- **The last Mirage change before the match** was in 1.37.3.8 (30 January 2020, build 4621799). Its notes on SteamDB
  list "Added AWP wallbang spot from palace to scaffolding close corner, A site", "Added bench in mid allowing jump
  up to window boost spot/peek towards cat", "Widened T entrance to mid", "Lowered trim around B site balcony" and
  "Blocked a jump-peek from middle of B site towards cat". So a pre-2020 or a later build would **not** be the same
  map. The `csgo_legacy` branch, which is CS:GO's final 2023 build, isn't the same map either.

SteamDB shows full manifest lists only to signed-in users. To double-check, sign in to steamdb.info with Steam (any
account), open <https://steamdb.info/depot/731/manifests/> and find `7867263815789485437` dated 5 March 2020.

## What to download

Only four kinds of file from depot 731 are needed:

| depot path | what | size |
| --- | --- | --- |
| `csgo/maps/de_mirage.bsp` | the compiled map | from the listing (step 1) |
| `csgo/maps/de_mirage.nav` | the 2020 bot nav mesh | from the listing |
| `csgo/pak01_dir.vpk` | pak01's directory: which `pak01_NNN.vpk` chunk holds each material and model | from the listing |
| `csgo/pak01_NNN.vpk` (only some) | the chunks that hold Mirage's materials and models | the tool prints them |

The depot holds the whole game. The tool works out which pak01 chunks Mirage's files are in and
downloads only those, so expect a small part of it. Before downloading, step 1 writes the depot's own file list
(`manifest_731_7867263815789485437.txt`: every file with its exact size and SHA-1). The tool then prints the exact
size of every chunk it needs. I couldn't read those sizes from here, because Steam needs a login.

## Steam account

**Any Steam account works.** CS:GO has been free to play since December 2018, and app 730 (now CS2) is free, so an
account that has Counter-Strike 2 in its library owns app 730's depots, 731 included. Old manifests need a login:
DepotDownloader's anonymous account gets no manifest request code for them (DepotDownloader FAQ, "error 401 or no
manifest code returned for old manifest ids"). If Steam ever refuses the code even when logged in (developers can
block old manifests), use "From an old install" below.

DepotDownloader asks for the password interactively and approves the login through the Steam mobile app, or takes a
code with `-no-mobile`. `-remember-password` keeps the session, so the tool's repeated runs don't ask again. If the
Steam client on the Mac gets logged out during a run, they share a LoginID: add `-loginid 7302020` to the commands (`fetch --loginid 7302020`).

## The recipe (Mac)

```sh
# 0. Tools: DepotDownloader (SteamRE, .NET 8, self-contained build), Node 22 and this repo.
brew tap steamre/tools && brew install depotdownloader
cd ~/path/to/cs2-round-replay && git pull && npm ci

# 1-3 in one command: the depot listing, then the BSP + nav + pak01_dir.vpk, then the pak01 chunks Mirage needs
#      (in rounds: materials reference textures, models reference materials), then the extraction.
npx tsx tools/csgo2020-files.ts fetch --username YOUR_STEAM_LOGIN
#   raw download:  ~/csgo-2020-raw/        (DepotDownloader's -dir; keep it until the PR that uses it is merged)
#   result:        ~/mirage-2020/          (what to send)
```

What `fetch` runs, if you'd rather do it by hand:

```sh
M="-app 730 -depot 731 -manifest 7867263815789485437 -username YOUR_STEAM_LOGIN -remember-password -dir ~/csgo-2020-raw"

# 1. The listing only (no game files): ~/csgo-2020-raw/manifest_731_7867263815789485437.txt
DepotDownloader $M -manifest-only

# 2. The map, its nav and the pak01 directory
printf 'csgo/maps/de_mirage.bsp\ncsgo/maps/de_mirage.nav\ncsgo/pak01_dir.vpk\n' > ~/csgo-2020-raw/filelist.txt
DepotDownloader $M -filelist ~/csgo-2020-raw/filelist.txt

# 3. Which chunks hold what Mirage references (prints each chunk with its size, marks the ones still to download)
npx tsx tools/csgo2020-files.ts plan ~/csgo-2020-raw
#    put the "(to download)" lines into a filelist (csgo/pak01_NNN.vpk, one per line) and download them:
DepotDownloader $M -filelist ~/csgo-2020-raw/filelist.txt
#    repeat 3 until plan shows nothing left to download (usually two or three rounds)

# 4. Copy only the referenced files out
npx tsx tools/csgo2020-files.ts extract ~/csgo-2020-raw ~/mirage-2020
```

`-filelist` paths use forward slashes and match case-insensitively (DepotDownloader `Program.cs`). A line that
starts with `regex:` is a regular expression, so `regex:^csgo/pak01_\d+\.vpk$` would fetch every chunk, if that's
simpler than the rounds.

Without DepotDownloader, the Steam client's console (`steam://open/console`) does the same download:
`download_depot 730 731 7867263815789485437`. But it fetches the **whole** depot into
`~/Library/Application Support/Steam/steamapps/content/app_730/depot_731/`. Then run step 3's `plan` and step 4 on
that folder.

## From an old install

A CS:GO install that was last updated between 5 and 22 March 2020 has exactly these files. That could be a backup or
Time Machine copy of `~/Library/Application Support/Steam/steamapps/common/Counter-Strike Global Offensive/`, or a
Windows `…\steamapps\common\Counter-Strike Global Offensive\`. Check `csgo/steam.inf`: it should say
`PatchVersion=1.37.4.4`. Then:

```sh
npx tsx tools/csgo2020-files.ts extract "/path/to/Counter-Strike Global Offensive" ~/mirage-2020
```

If the step-1 listing is in the folder, `extract` also checks the BSP's SHA-1 against the depot manifest. If it
isn't, the install's `steam.inf` is the evidence. An install updated to any other patch has a different Mirage (see
Evidence), so don't use it.

## What the extraction keeps

`extract` follows every reference that `de_mirage.bsp` makes:

- **materials**: every texdata name (world faces, displacements, overlays, decals), the cubemap patch materials in
  the BSP's own pak file and the materials they `include`, the sky's six faces (`skyname`), and the materials of
  every model. For each VMT it keeps the VTFs of `$basetexture`, `$basetexture2…4`, `$blendmodulatetexture`,
  `$detail` and the bump maps, plus `$bottommaterial` and `$fallbackmaterial`.
- **models**: every static prop (`sprp` dictionary) and every entity `model` under `models/`, each as `.mdl`, `.vvd`,
  `.phy` (the collision hulls the engine uses for solid props) and `.dx90.vtx` (the triangles).

It writes them under their game paths, plus `MANIFEST.json`:

```
mirage-2020/
  maps/de_mirage.bsp
  maps/de_mirage.nav
  materials/…/*.vmt, *.vtf
  models/…/*.mdl, *.vvd, *.phy, *.dx90.vtx
  MANIFEST.json      # source (app, depot, manifest, build, BSP SHA-1 vs the depot's), every file's SHA-256 and origin, missing references
```

## Sending it

Zip the folder and attach it to the session (or put it at `~/mirage-2020/` on a linked Mac), or commit it yourself
to `data/source/csgo-2020/` on a branch of this private repo. Either way, the files the pipeline expects are
`maps/de_mirage.bsp`, `maps/de_mirage.nav` and `MANIFEST.json` at the top of the folder, with `materials/` and
`models/` beside them. The BSP and nav alone are enough for collision and an untextured render. The materials add
real colours, and the models' `.phy` files add exact prop collision instead of bounding boxes.

Next, `tools/extract-bsp.ts` builds `data/maps/mirage-2020/` from the folder (`docs/maps.md`).
