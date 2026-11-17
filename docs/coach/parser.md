# Browser parser (K1)

`parseDemo(file, onProgress) → RawDemo` (`src/coach-parser/index.ts`) parses a CS2 demo in a Web Worker with
demoparser2's Rust core compiled to WebAssembly. `.dem`, `.dem.bz2`, `.dem.zst` and `.dem.gz` are detected by magic
bytes and decompressed inside the module. Nothing is uploaded. The same WebAssembly runs in Node
(`tools/coach/parse-wasm.ts`) for tests and tools.

## Decision: path A, Rust on demoparser2's core, built here with `-Z build-std`

| Path | Built here? | Test demo (60.6 MB, 10 rounds) in headless Chrome | Peak memory | Binary | Fields | Following upstream |
| --- | --- | --- | --- | --- | --- | --- |
| **A: our crate on `parser` @ 8035c3d** | yes: `-Z build-std` with rust-src from GitHub. A GitHub Actions workflow builds it with the official target too | **5.3 s** (.dem), 5.4 s (.zst), 5.8 s (.gz), 10.6 s (.bz2) | wasm memory 187–240 MB; Chrome RSS +213 to +293 MB | **2.96 MB raw, 0.89 MB gzip** | everything in `RawDemo`, identical to the native adapter | bump one commit in `upstream.env`; one 15-line patch |
| B: demoinfocs-golang (Go → wasm) | **no**: v5.3.0 fetched from GitHub with `GOPROXY=direct`, but its dependencies sit behind `gopkg.in`, `golang.org` and `google.golang.org`, which the proxy refuses (and `proxy.golang.org` was unreachable today) | not measured | not measured | not measured (Go wasm binaries are typically 5–10 MB+) | a different event/field model; every `RawDemo` field would need its own mapping and its own conformance work | active (v6.0.0-rc.2, commits on 11-13), but a second codebase to track |
| baseline: npm `demoparser2` 0.15.0 | not needed | not run: April 2026, before the July format change, row objects | | | | |

Path A wins on every measured axis and needs no second parser: it is the same Rust code as the native oracle
(`@laihoe/demoparser2` 0.42.3 wraps it too), so a CS2 update is fixed upstream once for both. Path B was not pursued
further once A met every budget.

A clean rebuild (fresh upstream checkout) reproduced the committed binary byte for byte (same SHA-256).

GitHub Actions runs on this public repo again (CI on `main` and `k0-coach-contracts` green on 11-16).
`.github/workflows/coach-parser.yml` builds the module with the official `wasm32-unknown-unknown` target and runs the
conformance check on the public test demo; its artifact is a cross-check, the committed binary is the local build.

## Measurements (this workspace: 2 shared cores, ~7 GB, two other agents running)

| | Wall time | Memory | Notes |
| --- | --- | --- | --- |
| native Node adapter (K0, oracle) | 10–24 s | 605 MB peak RSS | multi-threaded upstream, 4000-tick chunks of JS arrays |
| our crate, native x86-64 | 1.8 s | 182 MB peak RSS | `cargo run --release --bin coach-parser-native -- <demo>` |
| WebAssembly in Node | 5.0–5.5 s | 191 MB wasm memory | `npx tsx tools/coach/parse-wasm.ts <demo>` |
| **WebAssembly in a Chrome worker, .dem** | **5.3 s** | **187 MB wasm, Chrome RSS +241 MB** | stages: read 0.66, events 1.01, ticks 2.40, columns 0.13, inventories 0.43, projectiles 0.47, convert 0.07 s |
| same, .dem.zst (42 MB) | 5.4 s | 189 MB wasm, +213 MB | zstd decode 0.64 s |
| same, .dem.gz (49 MB) | 5.8 s | 193 MB wasm, +247 MB | gzip decode 0.39 s |
| same, .dem.bz2 (47 MB) | 10.6 s | 240 MB wasm, +293 MB | bzip2 decode 5.0 s (pure Rust, ~9 MB/s here) |

`tools/coach/bench-parser.ts` produces the Chrome rows (it builds a page with Vite, gives the demo to an
`<input type=file>` as a real `File`, samples the RSS of the Chrome process tree every 100 ms). The page receives
42.4 MB of typed arrays (transferred, not copied) and 31–33 progress updates per parse.

**Budgets.** Extrapolated linearly from the .dem run (time and memory scale with ticks × players):

| Demo | Time here | wasm memory | Chrome RSS growth | Budget |
| --- | --- | --- | --- | --- |
| 150 MB | ~13 s (+~12 s if .bz2) | ~460 MB | ~600 MB | ≤ 45 s, ≤ 1.5 GB: met |
| 250 MB | ~22 s (+~20 s if .bz2) | ~770 MB | ~1.0 GB | met |

The linear memory figure is pessimistic: the module (~10 MB) and the per-segment table do not grow with the demo.
On Apple silicon a single core is at least as fast as one of this box's shared cores, so expect the 150 MB parse in
well under 15 s. Binary 0.89 MB gzipped (budget 3 MB).

**What the peak is made of** (test demo, 187 MB of wasm memory): the demo bytes (60.6 MB, read into WebAssembly memory
in 8 MB chunks, so JS never holds the file); the compact row table kept across segments (~80 bytes per row, about
50 MB with growth slack); the dense output columns (42 MB, built column by column while the row columns are freed);
one full-packet segment's upstream table (~20 MB); the module and the event list (~15 MB). For compressed input the
compressed bytes are freed as soon as the decompressed buffer is complete (gzip inflates into a buffer of the exact
ISIZE, zstd uses the frame's content size, bzip2 reserves 1.35× and grows by quarters), so compressed + decompressed
coexist only during decompression and the parse itself never sees the compressed copy. After the parse the columns are
copied out of WebAssembly memory into transferable typed arrays (+42 MB in the worker) and transferred to the page;
WebAssembly memory never shrinks, so `parseDemo` terminates the worker, which frees it.

## Correctness: identical to the native adapter

`tools/coach/parser-conformance.ts` (and `tests/coach/parser-conformance.test.ts`, skipped without the demo) compares
the WebAssembly `RawDemo` with `tools/coach/parse-node.ts` column by column and event by event
(`tools/coach/raw-compare.ts`): 15,571,875 cells, 8,493 events, projectiles, inventories, scoreboard, header (except
the `parser` tag). Integers and strings must be equal; floats within 1e-4, and in practice the maximum difference is
**0** in every float column (both decode the same 32-bit values). `--containers` checks the .bz2/.zst/.gz copies give
the same `RawDemo` (identical).

One accepted difference, counted and capped in the test: **velocity** (`vx vy vz`) is NaN on one side only in 379 of
566,250 cells (0.07 %). demoparser2 derives velocity from the previous ticks' positions; the native adapter reads the
tick grid in 4000-tick chunks, so the first tick of each chunk has no history (NaN there, a value here). Both parse the
demo in the same full-packet segments.

Inside one tick, events of different types may come in a different order (the native output is grouped by type and
then sorted by tick; ours keeps the demo's order), so the comparison treats records of one tick as a set.

## How it works

- `crates/coach-parser/src/extract.rs` drives upstream's public API. Pass 1: all events (with `total_rounds_played`
  and `is_warmup_period`) and the header. Pass 2, the tick grid: upstream's first pass gives the full-packet offsets
  (every 3840 ticks); each segment is parsed by its own `SecondPassParser` (exactly what upstream's multi-threaded
  mode does, run one after another) and its rows are appended to compact columns, then dropped; afterwards the player
  set, slots and tick list are known and the rows are scattered into the dense `[T × P]` columns. Pass 3: inventories
  and scoreboard totals with upstream's `wanted_ticks` (freeze ends, round ends, the tick before each death, the last
  round end). Pass 4: projectiles. Event tables are generic columns (numbers, strings, player slots).
- `crates/coach-parser/src/wasm.rs`: `Session` (`new(size)`, `push(chunk)` which also feeds SHA-256, `parse(progress)`).
- `src/coach-parser/convert.ts`: event records, canonical item names (`items.ts`), header, projectile types; the rules
  mirror `tools/coach/parse-node.ts` line for line.
- `src/coach-parser/session.ts` (shared by worker and Node), `worker.ts`, `index.ts` (`parseDemo`,
  `parseDemoWithStats`; a `Uint8Array` input is transferred to the worker and detached).

## Rebuild

```
cargo install wasm-bindgen-cli --version 0.2.130 --locked   # once; must match Cargo.toml
crates/coach-parser/build.sh
```

`build.sh` fetches upstream at the pinned commit into `crates/coach-parser/upstream/` (gitignored), deletes upstream's
`build.rs` files (they clone the latest GameTracking-CS2 and need `protoc`; the generated sources they would write are
committed upstream, so deleting them keeps the build pinned), applies `patches/`, builds with the installed wasm32
target or, without it, with `-Z build-std` (`setup-rust-src.sh` installs the standard-library source for the active
toolchain from GitHub), runs `wasm-bindgen --target web`, and writes `src/coach-parser/pkg/` with `PROVENANCE.json`
(upstream commit, patches, toolchain, SHA-256, sizes). `wasm-opt` is not run (binaryen is not installed here; the
size is well inside the budget). Rebuild after any change under `crates/`, then run the conformance tool and commit
the new `pkg/`.

## Bump upstream after a CS2 update

1. Set `UPSTREAM_COMMIT` in `crates/coach-parser/upstream.env`; `rm -rf crates/coach-parser/upstream`.
2. `crates/coach-parser/build.sh`. If `patches/0001-wasm-no-instant.patch` no longer applies, check whether upstream
   still calls `std::time::Instant::now()` unconditionally in `parse_demo.rs` (it panics on wasm32); drop the patch if
   not. If the build fails on API changes, they will be in `extract.rs` (settings, `FirstPassParser`,
   `SecondPassParser`, prop ids).
3. Bump the native oracle `@laihoe/demoparser2` to the release built from the same commit if there is one, re-parse
   (`npx tsx tools/coach/parser-conformance.ts --fresh --containers`) and run `npm test`.
4. Update `PARSER_TAG` in `convert.ts` and the table above.

## Known gaps

- Progress is per pass and per full-packet segment (about 30 updates for a 10-round demo); there is none inside the
  events pass (~1 s here) or inside bzip2 decompression (5 s for 47 MB here).
- bzip2 decompression is pure Rust and single-threaded: the slowest container by far.
- Only the test demo (patch 13984, before the July 2026 format change) has been checked. Upstream's head of 11-16 is
  what reads current demos; confirm on John's demos.
- No `wasm-opt` pass; no WebAssembly SIMD or threads.
- Players beyond 16 slots are rejected (the `spottedBy` mask is 16 bits).

## Checking a current-format demo from John

Run `npx tsx tools/coach/parser-conformance.ts <demo> --containers` on each (keep them in `local/`). Look for: the
parse succeeds and the result is identical to the native adapter; `header.patch` is a post-July patch;
`events.bullets` has `inaccuracy`, `spread`, `recoilIndex` filled; `ticks.penalty`, `punchPitch/Yaw`, `buttons`,
`spottedBy` and `place` are populated on present rows; 10 players and the expected number of rounds; the scoreboard
reconciles (`npm run coach -- inspect <demo>`); and the timing of a full-length `.dem.bz2` / FACEIT `.dem.zst` in
`tools/coach/bench-parser.ts`.
