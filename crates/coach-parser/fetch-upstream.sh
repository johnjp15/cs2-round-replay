#!/usr/bin/env bash
# Fetch the pinned demoparser source into crates/coach-parser/upstream (gitignored).
# Upstream's build.rs files regenerate protobuf.rs/maps.rs by cloning the latest GameTracking-CS2 and
# need protoc; the generated files are committed upstream, so we delete the build scripts to keep the
# build pinned and offline-reproducible.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/upstream.env"
dest="$here/upstream"
if [ -d "$dest/.git" ] && [ "$(git -C "$dest" rev-parse HEAD 2>/dev/null)" = "$UPSTREAM_COMMIT" ]; then
  echo "upstream already at $UPSTREAM_COMMIT"; exit 0
fi
rm -rf "$dest"
git init -q "$dest"
git -C "$dest" remote add origin "$UPSTREAM_REPO"
git -C "$dest" fetch -q --depth 1 origin "$UPSTREAM_COMMIT"
git -C "$dest" checkout -q FETCH_HEAD
rm -f "$dest/src/parser/build.rs" "$dest/src/csgoproto/build.rs"
# Our own patches (kept minimal; each one documented in docs/coach/parser.md).
for p in "$here"/patches/*.patch; do
  [ -e "$p" ] || continue
  git -C "$dest" apply "$p"
  echo "applied $(basename "$p")"
done
rm -f "$dest/src/parser/test_demo.dem"
echo "upstream at $(git -C "$dest" rev-parse HEAD)"
