#!/usr/bin/env bash
# Encrypt the two sim pages and write them into a johnjp15.github.io checkout as cs2/sim/ and cs2/sim3d/.
#
#   CS2_PASSWORD=... tools/pages/deploy.sh <path-to-johnjp15.github.io> [--no-build]
#
# CI's `deploy` job runs this after the checks pass on main, then commits and pushes (docs/deploy.md). encrypt.cjs,
# lock.html and lock.json are byte-for-byte copies of web-apps cs2/tools/, so the one cs2 password (and the key a
# browser remembers) unlocks every cs2 page. Only cs2/sim and cs2/sim3d are touched: web-apps deploys the other cs2
# pages and leaves these two alone. A page whose build and lock files haven't changed since it was last written is
# left as it is (its .deploy-stamp records what it was made from), so a push that doesn't change the build publishes
# nothing; every re-encryption adds its whole page (1.7 MB 2D, 2.5 MB 3D) of fresh ciphertext to the Pages history.
# Runs on Linux CI and with macOS's bash 3.2; needs Node 22 and this repo's `npm ci`.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK="$REPO/tools/pages"
PAGES="$(cd "${1:?usage: CS2_PASSWORD=... tools/pages/deploy.sh <path-to-johnjp15.github.io> [--no-build]}" && pwd)"
[ -d "$PAGES/.git" ] || { echo "Not a git repo: $PAGES" >&2; exit 1; }
[ -n "${CS2_PASSWORD:-}" ] || { echo "Set CS2_PASSWORD to the cs2 password." >&2; exit 2; }
if [ "${2:-}" != "--no-build" ]; then
  (cd "$REPO" && npm run --silent build:single && npm run --silent build:single:3d)
fi

build_of() {
  case "$1" in
    sim) echo "$REPO/dist-single/index.html" ;;
    sim3d) echo "$REPO/dist-single-3d/index.html" ;;
  esac
}
# What a published page was made from: its plaintext build and the three lock files.
stamp() {
  node -e 'const h = require("crypto").createHash("sha256");
    for (const f of process.argv.slice(1)) h.update(require("fs").readFileSync(f));
    console.log(h.digest("hex"));' "$1" "$LOCK/lock.json" "$LOCK/lock.html" "$LOCK/encrypt.cjs"
}

SRC="$(mktemp -d)"
OUT="$(mktemp -d)"
trap 'rm -rf "$SRC" "$OUT"' EXIT
mkdir -p "$SRC/tools"
cp "$LOCK/lock.json" "$LOCK/lock.html" "$SRC/tools/"
CHANGED=""
for page in sim sim3d; do
  build="$(build_of "$page")"
  [ -f "$build" ] || { echo "Missing $build (build first, or drop --no-build)." >&2; exit 1; }
  if [ -f "$PAGES/cs2/$page/index.html" ] && [ "$(cat "$PAGES/cs2/$page/.deploy-stamp" 2>/dev/null)" = "$(stamp "$build")" ]; then
    echo "cs2/$page is already this build: left as it is"
    continue
  fi
  mkdir -p "$SRC/$page"
  cp "$build" "$SRC/$page/index.html"
  CHANGED="$CHANGED $page"
done
[ -n "$CHANGED" ] || { echo "Nothing to deploy."; exit 0; }

# encrypt.cjs refuses a password that doesn't match lock.json's verifier, so a typo can't lock everyone out.
CS2_PASSWORD="$CS2_PASSWORD" node "$LOCK/encrypt.cjs" "$SRC" "$OUT"
# It also rewrites lock.json; with the current password the file comes out byte for byte the same.
cmp -s "$SRC/tools/lock.json" "$LOCK/lock.json" || {
  echo "lock.json would change (a new salt or verifier): nothing deployed." >&2; exit 1; }
# Nothing readable may reach the public site.
if grep -rlE 'sk8ers|Sp4rtaN|snarlbot|WMD\.' "$OUT" >/dev/null; then
  echo "Plaintext found in the encrypted output: nothing deployed." >&2; exit 1
fi
for page in $CHANGED; do
  [ -f "$OUT/$page/index.html" ] || { echo "encrypt.cjs wrote no $page/index.html: nothing deployed." >&2; exit 1; }
done
for page in $CHANGED; do
  rm -rf "${PAGES:?}/cs2/$page"
  mkdir -p "$PAGES/cs2/$page"
  cp "$OUT/$page/index.html" "$PAGES/cs2/$page/index.html"
  stamp "$(build_of "$page")" > "$PAGES/cs2/$page/.deploy-stamp"
  echo "Wrote cs2/$page/index.html (locked)"
done
