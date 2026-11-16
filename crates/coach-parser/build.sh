#!/usr/bin/env bash
# Builds the coach parser WebAssembly into src/coach-parser/pkg/ and writes PROVENANCE.json.
#   crates/coach-parser/build.sh            # release build
# Needs: cargo/rustc (any recent stable), wasm-bindgen-cli at the exact version pinned in Cargo.toml
# (`cargo install wasm-bindgen-cli --version 0.2.130 --locked`). If the wasm32-unknown-unknown target
# is not installed (rustup target add fails where static.rust-lang.org is blocked), the standard
# library is built from source with -Z build-std (rust-src fetched from GitHub by setup-rust-src.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/src/coach-parser/pkg"
cd "$here"
source upstream.env
./fetch-upstream.sh
WB_VERSION="$(grep -E '^wasm-bindgen = "=' Cargo.toml | sed -E 's/.*"=([0-9.]+)".*/\1/')"
have_wb="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')"
if [ "$have_wb" != "$WB_VERSION" ]; then
  echo "wasm-bindgen-cli $WB_VERSION needed (have: ${have_wb:-none}): cargo install wasm-bindgen-cli --version $WB_VERSION --locked" >&2
  exit 1
fi
if rustup target list --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown$'; then
  mode="prebuilt-std"
  cargo build --release --lib --target wasm32-unknown-unknown
else
  mode="build-std"
  ./setup-rust-src.sh
  RUSTC_BOOTSTRAP=1 cargo build --release --lib --target wasm32-unknown-unknown -Z build-std=std,panic_abort
fi
mkdir -p "$out"
wasm-bindgen --target web --remove-name-section --remove-producers-section --out-dir "$out" --out-name coach_parser target/wasm32-unknown-unknown/release/coach_parser.wasm
rm -f "$out/coach_parser_bg.wasm.d.ts"
wasm="$out/coach_parser_bg.wasm"
raw=$(stat -c %s "$wasm")
gz=$(gzip -9 -c "$wasm" | wc -c)
sha=$(sha256sum "$wasm" | awk '{print $1}')
patches=$(ls patches/*.patch 2>/dev/null | xargs -n1 basename | sed 's/.*/"&"/' | paste -sd, -)
cat > "$out/PROVENANCE.json" <<JSON
{
  "artifact": "coach_parser_bg.wasm",
  "crate": "crates/coach-parser $(grep -m1 '^version' Cargo.toml | sed -E 's/.*"(.*)"/\1/')",
  "upstream": { "repo": "$UPSTREAM_REPO", "commit": "$UPSTREAM_COMMIT", "license": "MIT", "patches": [${patches}] },
  "toolchain": { "rustc": "$(rustc --version)", "cargo": "$(cargo --version)", "wasmBindgen": "$WB_VERSION", "std": "$mode", "wasmOpt": "not run" },
  "build": "crates/coach-parser/build.sh",
  "sha256": "$sha",
  "bytes": $raw,
  "gzipBytes": $gz
}
JSON
echo "built $wasm: $raw bytes, $gz gzipped, sha256 $sha ($mode)"
