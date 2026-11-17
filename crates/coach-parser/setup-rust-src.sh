#!/usr/bin/env bash
# Installs the Rust standard library source for the active toolchain (what `rustup component add rust-src`
# would do) from GitHub, for machines where static.rust-lang.org is unreachable. Needed for -Z build-std.
set -euo pipefail
sysroot="$(rustc --print sysroot)"
dest="$sysroot/lib/rustlib/src/rust"
if [ -f "$dest/library/std/Cargo.toml" ]; then echo "rust-src present: $dest"; exit 0; fi
ver="$(rustc --version | awk '{print $2}')"
tmp="$(mktemp -d)"
git clone -q --depth 1 --branch "$ver" --filter=blob:none --sparse https://github.com/rust-lang/rust.git "$tmp/rust"
git -C "$tmp/rust" sparse-checkout set library
bt="$(git -C "$tmp/rust" ls-tree HEAD library/backtrace | awk '{print $3}')"
rmdir "$tmp/rust/library/backtrace" 2>/dev/null || true
git clone -q https://github.com/rust-lang/backtrace-rs.git "$tmp/rust/library/backtrace"
git -C "$tmp/rust/library/backtrace" checkout -q "$bt"
mkdir -p "$dest"
cp -r "$tmp/rust/library" "$dest/"
rm -rf "$tmp"
echo "rust-src $ver installed: $dest"
