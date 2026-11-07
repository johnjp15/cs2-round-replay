#!/usr/bin/env bash
# Stage the single-file builds as the cs2/sim (2D) and cs2/sim3d (3D, H1) pages of a web-apps checkout (docs/deploy.md).
#
#   tools/stage-web-apps.sh <path-to-web-apps-checkout> [--no-build]
#
#   1. npm run build:single and npm run build:single:3d (skipped with --no-build; dist-single/index.html and
#      dist-single-3d/index.html must then exist)
#   2. copies them to <web-apps>/cs2/sim/index.html and <web-apps>/cs2/sim3d/index.html
#   3. adds each page, if it isn't there yet, to the list in <web-apps>/cs2/index.html and to the table in
#      <web-apps>/cs2/README.md. Running it again changes nothing but the pages themselves.
#
# It never encrypts, deploys, commits or pushes, and never asks for or reads a password. Next step:
# <web-apps>/cs2/tools/deploy.sh (by hand, or the web-apps workflow in docs/deploy/web-apps-deploy.yml).
# Runs with macOS's bash 3.2 and on Linux CI; needs Node 22 and this repo's `npm ci`.
set -euo pipefail

usage() {
  echo "Usage: $0 <path-to-web-apps-checkout> [--no-build]" >&2
  exit 2
}

WEB_APPS=""
BUILD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *) [ -z "$WEB_APPS" ] || usage; WEB_APPS="$1" ;;
  esac
  shift
done
[ -n "$WEB_APPS" ] || usage

REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$WEB_APPS" ] || { echo "No such directory: $WEB_APPS" >&2; exit 1; }
WEB_APPS="$(cd "$WEB_APPS" && pwd)"
CS2="$WEB_APPS/cs2"
if [ ! -f "$CS2/index.html" ] || [ ! -f "$CS2/README.md" ] || [ ! -f "$CS2/tools/encrypt.cjs" ]; then
  echo "Not a web-apps checkout (expected cs2/index.html, cs2/README.md and cs2/tools/encrypt.cjs): $WEB_APPS" >&2
  exit 1
fi

if [ "$BUILD" = "1" ]; then
  (cd "$REPO" && npm run --silent build:single && npm run --silent build:single:3d)
fi
PAGE="$REPO/dist-single/index.html"
PAGE3D="$REPO/dist-single-3d/index.html"
[ -f "$PAGE" ] || { echo "Missing $PAGE: run npm run build:single first, or drop --no-build." >&2; exit 1; }
[ -f "$PAGE3D" ] || { echo "Missing $PAGE3D: run npm run build:single:3d first, or drop --no-build." >&2; exit 1; }

mkdir -p "$CS2/sim" "$CS2/sim3d"
cp "$PAGE" "$CS2/sim/index.html"
echo "Staged $CS2/sim/index.html ($(wc -c < "$PAGE" | tr -d ' ') bytes)"
cp "$PAGE3D" "$CS2/sim3d/index.html"
echo "Staged $CS2/sim3d/index.html ($(wc -c < "$PAGE3D" | tr -d ' ') bytes)"

# The list card and the README row. Node, not sed: BSD and GNU sed differ, and this must run on both.
node - "$CS2" <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');
const cs2 = process.argv[2];

const PAGES = [
  {
    dir: 'sim',
    card: [
      '<li>',
      '  <a class="page" href="sim/">',
      '    <div class="meta">Mirage · the same round · playable 2D sim</div>',
      "    <h2>Play cart's side of the round</h2>",
      '    <p>The same round as a top-down sim you can play: you are <span class="t">cart</span> (keyboard and mouse) and the other nine follow their recorded paths until you change what happens, then play on with their own AI. On a phone it opens in spectate mode.</p>',
      '    <div class="tags"><span>2D sim</span><span>play as cart</span><span>spectate</span><span>0.25–4× speed</span></div>',
      '    <span class="go">Open sim →</span>',
      '  </a>',
      '</li>',
    ],
    row: '| [`sim/`](sim/) | Mirage, the same round as a playable 2D sim: you play cart (keyboard and mouse) and the other nine follow their recorded paths until you change what happens, then play on with their own AI; spectate, 0.25–4× speed. One self-contained file built by `npm run build:single` in the cs2-round-replay repo and copied here by its `tools/stage-web-apps.sh`: change it there, not here |',
  },
  {
    dir: 'sim3d',
    card: [
      '<li>',
      '  <a class="page" href="sim3d/">',
      '    <div class="meta">Mirage · the same round · first-person 3D sim</div>',
      "    <h2>Play the round in 3D</h2>",
      '    <p>The same round on CS2\'s own Mirage geometry with Source movement and real 3D aim: it plays exactly as recorded while you watch (third person, through a player\'s eyes, or a free camera), and E puts you in <span class="t">cart</span>\'s boots, first person with mouse look. On a phone it spectates.</p>',
      '    <div class="tags"><span>3D sim</span><span>first person</span><span>play as cart</span><span>spectate</span><span>0.25–4× speed</span></div>',
      '    <span class="go">Open 3D sim →</span>',
      '  </a>',
      '</li>',
    ],
    row: '| [`sim3d/`](sim3d/) | Mirage, the same round as a first-person 3D sim on the CS2 collision mesh (Source movement, hitboxes, 3D aim): it plays as recorded while you spectate; E takes control of cart (mouse look, WASD); 0.25–4× speed. One self-contained file built by `npm run build:single:3d` in the cs2-round-replay repo and copied here by its `tools/stage-web-apps.sh`: change it there, not here |',
  },
];

const indexPath = path.join(cs2, 'index.html');
const readmePath = path.join(cs2, 'README.md');
for (const page of PAGES) {
  // cs2/index.html: one more <li> card at the end of <ul class="pages">, in the markup of the existing cards.
  let html = fs.readFileSync(indexPath, 'utf8');
  if (new RegExp(`href="${page.dir}/"`).test(html)) {
    console.log(`cs2/index.html: already lists ${page.dir}/`);
  } else {
    const open = /^([ \t]*)<ul class="pages">[^\n]*\n/m.exec(html);
    if (!open) throw new Error('cs2/index.html: no <ul class="pages"> list');
    const start = open.index + open[0].length;
    const close = /^[ \t]*<\/ul>/m.exec(html.slice(start));
    if (!close) throw new Error('cs2/index.html: <ul class="pages"> is not closed');
    const at = start + close.index;
    const li = /^([ \t]*)<li>/m.exec(html.slice(start, at));
    const indent = li ? li[1] : open[1] + '  ';
    const nl = html.includes('\r\n') ? '\r\n' : '\n';
    html = html.slice(0, at) + page.card.map((l) => indent + l).join(nl) + nl + html.slice(at);
    fs.writeFileSync(indexPath, html);
    console.log(`cs2/index.html: added ${page.dir}/ to the list`);
  }

  // cs2/README.md: one more row at the end of the "| Page | What it is |" table.
  const lines = fs.readFileSync(readmePath, 'utf8').split('\n');
  if (lines.some((l) => l.includes(`](${page.dir}/)`))) {
    console.log(`cs2/README.md: already lists ${page.dir}/`);
  } else {
    const head = lines.findIndex((l) => /^\|\s*Page\s*\|/.test(l));
    if (head < 0) throw new Error('cs2/README.md: no "| Page | ... |" table');
    let last = head;
    while (last + 1 < lines.length && lines[last + 1].startsWith('|')) last++;
    if (last < head + 1) throw new Error('cs2/README.md: the pages table has no separator row');
    const cr = lines[last].endsWith('\r') ? '\r' : '';
    lines.splice(last + 1, 0, page.row + cr);
    fs.writeFileSync(readmePath, lines.join('\n'));
    console.log(`cs2/README.md: added ${page.dir}/ to the table`);
  }
}
NODE
echo "Next: $CS2/tools/deploy.sh (asks for the password), then commit and push the pages repo. See docs/deploy.md."
