# Publishing the sim at johnjp15.github.io/cs2/sim/

> **Status (2026-11-06):** John chose the automatic option. `cs2-deploy.yml` is installed in web-apps (web-apps PR #1) and `stage-web-apps.yml` is installed here. What's left is three secrets, which John adds himself: `CS2_PASSWORD` and `PAGES_TOKEN` in web-apps, and `WEB_APPS_TOKEN` here. Until `WEB_APPS_TOKEN` exists, the stage workflow skips with a warning.

The sim is published as one more page of John's password-locked cs2 pages. Their source is in the private
**web-apps** repo, under `cs2/`. Its `cs2/tools/deploy.sh` encrypts every page and writes the result to the public
**johnjp15/johnjp15.github.io** repo (branch `master`), which GitHub Pages serves.

- **Encryption.** Each page is encrypted with AES-256-GCM. The key comes from PBKDF2-SHA256 with 600,000 iterations
  and the salt shared in `cs2/tools/lock.json`. The ciphertext is wrapped in `cs2/tools/lock.html`, which decrypts
  in the browser and replaces itself with the page.
- **Self-contained pages.** Only `cs2/index.html` and `cs2/<page>/index.html` are copied, so a page has to carry
  everything it needs.

This repo provides three pieces:

| Piece | What it does |
| --- | --- |
| `npm run build:single` | Writes `dist-single/index.html`: the whole app in one file that makes no requests. |
| `tools/stage-web-apps.sh <web-apps>` | Builds that file, copies it to `<web-apps>/cs2/sim/index.html` and lists the page. It never touches a password. |
| `npm run check:locked` | Runs the whole chain in a temp copy with a throwaway password, then opens the locked page in headless Chromium. |

Publishing itself is John's call: either by hand (option A) or by two GitHub Actions workflows drafted in
`docs/deploy/` (option B, recommended). Nothing here is installed or pushed for him.

## The single-file page (`npm run build:single`)

`vite.single.config.ts` (the normal `vite.config.ts` and `npm run build` are unchanged):

- **`embedAssets()`** provides `virtual:cs2-embedded-assets`. It contains the round, the nav mesh and the sight
  mask, gzipped (level 9) and base64-encoded, and the radar as a `data:image/jpeg;base64,…` URI. It also redirects
  `main.ts`'s import of `./assets` to `./assets-embedded`.
- **vite-plugin-singlefile** (a devDependency) inlines the one script chunk into `index.html`.
- **`checkSingleFile()`** fails the build in two cases: anything besides `index.html` is written, or the markup
  still has a `src`/`href` that isn't a `data:` URI. It also prints the sizes.

**The switch in `src/app`.** `main.ts` calls `loadAssets()` from `./assets`. The two loaders return the same
`PageAssets`:

- `assets.ts` fetches the JSON and the radar. This is the code that used to sit in `main.ts`.
- `assets-embedded.ts` inflates the embedded JSON with `DecompressionStream('gzip')` and decodes the radar from
  its data URI. It makes no network requests.

`tuning.json` stays a JSON import in both builds, so it is inlined either way. `embedded-assets.d.ts` types the
virtual module.

**Sizes** (KB = 1,024 bytes; "locked" is the file `encrypt.cjs` writes):

| Embedded JSON | `dist-single/index.html` | gzip | Locked page | Locked, gzip (as Pages serves it) |
| --- | ---: | ---: | ---: | ---: |
| **gzip + base64** (default) | **446.6 KB** | 250.3 KB | **601.6 KB** | 451.8 KB |
| as text (`CS2_SINGLE_RAW=1 npx vite build --config vite.single.config.ts`) | 1,360.8 KB | 252.3 KB | ≈ 1,820 KB | ≈ 1,370 KB |

Compressing first clearly pays off. Ciphertext can't be compressed, so the GitHub Pages gzip that keeps the normal
build at about 260 KB over the wire stops helping once a page is locked. The only gain left is base64 of random
bytes gzipping to about ¾. Compressing the JSON before encryption makes the published page three times smaller.
The rest of the page is the script (about 160 KB) and the radar (182 KB as base64).

**Browser support.**

- `DecompressionStream` needs Safari 16.4+ (iOS 16.4+), Chrome 80+ or Firefox 113+. On anything older, the page
  says "this browser is too old to open the replay (it needs Safari 16.4 or newer)".
- The lock screen itself needs Web Crypto, so it only works over https or on localhost.

**Plaintext guard.** `deploy.sh` refuses to publish if `grep -rlE 'sk8ers|Sp4rtaN|snarlbot|WMD\.'` matches its
output. The plaintext sim page does match, because the script carries the player ids `snarlbot` and `Sp4rtaN`. So
the guard would also catch this page if it ever went out unencrypted. `check:locked` verifies both sides.

## Staging into web-apps (`tools/stage-web-apps.sh`)

```sh
tools/stage-web-apps.sh ~/path/to/web-apps          # builds, then stages
tools/stage-web-apps.sh ~/path/to/web-apps --no-build   # stages an existing dist-single/index.html
```

The script:

1. runs `npm run build:single`;
2. copies `dist-single/index.html` to `<web-apps>/cs2/sim/index.html`;
3. adds `sim/` to the list in `<web-apps>/cs2/index.html` (one more `<li><a class="page">` card in the markup of the
   existing one) and to the table in `<web-apps>/cs2/README.md`.

Step 3 happens only if the page isn't listed yet. Running the script again changes only `sim/index.html`, and only
if the build changed. It refuses a folder that has no `cs2/index.html`, `cs2/README.md` and `cs2/tools/encrypt.cjs`.

It never encrypts, deploys, commits or pushes, and it never reads a password. It runs on macOS (bash 3.2, edits made
with Node rather than `sed`) and on Linux CI. It needs Node 22 and this repo's `npm ci`.

What it adds the first time:

```diff
--- a/cs2/index.html
+++ b/cs2/index.html
@@ -64,6 +64,15 @@
         <span class="go">Open replay →</span>
       </a>
     </li>
+    <li>
+      <a class="page" href="sim/">
+        <div class="meta">Mirage · the same round · playable 2D sim</div>
+        <h2>Play cart's side of the round</h2>
+        <p>The same round as a top-down sim you can play: you are <span class="t">cart</span> (keyboard and mouse) and the other nine follow their recorded paths until you change what happens, then play on with their own AI. On a phone it opens in spectate mode.</p>
+        <div class="tags"><span>2D sim</span><span>play as cart</span><span>spectate</span><span>0.25–4× speed</span></div>
+        <span class="go">Open sim →</span>
+      </a>
+    </li>
   </ul>
--- a/cs2/README.md
+++ b/cs2/README.md
@@ -6,6 +6,7 @@
 | [`mirage-round-replay/`](mirage-round-replay/) | Mirage, ESEA, March 2020: … |
+| [`sim/`](sim/) | Mirage, the same round as a playable 2D sim: you play cart (keyboard and mouse) and the other nine follow their recorded paths until you change what happens, then play on with their own AI; spectate, 0.25–4× speed. One self-contained file built by `npm run build:single` in the cs2-round-replay repo and copied here by its `tools/stage-web-apps.sh`: change it there, not here |
```

The card copy is a first draft for John to reword in web-apps. Once `href="sim/"` is in the list, the script leaves
the card alone.

## End-to-end check with a throwaway password (`npm run check:locked`)

```sh
npm run check:locked -- --web-apps ~/path/to/web-apps   # or WEB_APPS_DIR=…; default: a web-apps clone next to this repo
```

`tools/e2e-locked.ts` only reads the web-apps checkout: at the end it compares a hash of every file under its
`cs2/` with the hash taken at the start. All writes go to a temp copy (`--tmp`, default `<os tmpdir>/cs2-e2e`,
`/tmp/cs2-e2e` on Linux) and to `--out` (default `logs/locked-check/`). The steps:

1. **Copy and stage.** Copies `cs2/` to the temp dir and runs `stage-web-apps.sh` against it twice. The second
   run must change nothing. The diff goes to `logs/locked-check/stage.diff`.
2. **Encrypt.** Deletes the copy's `tools/lock.json`, so a fresh salt and verifier are made, then runs
   `CS2_PASSWORD=test-only-password CS2_NEW_PASSWORD=1 node <tmp>/cs2/tools/encrypt.cjs <tmp>/cs2 <tmp>/out`. Every
   other child process gets an environment with any `CS2_PASSWORD` removed.
3. **Check the output.**
   - `deploy.sh`'s own plaintext grep (the pattern is read from `deploy.sh`) must find nothing in `<tmp>/out`.
   - The same grep must match the plaintext sim page.
   - The output must be exactly the three pages.
   - Each page must decrypt in Node to its source, byte for byte.
4. **Browser checks.** Serves `<tmp>/out` at `http://localhost:<port>/` on loopback only and opens it in headless
   Chromium (playwright-core):
   - **Desktop (1280×860).** On `/sim/` the lock screen appears and a wrong password is refused. The throwaway
     password opens the game: the canvas shows the radar, the clock reads 1:39, and Start runs ticks. There must be
     no console or page errors, and the only request, seen both by Playwright and by the server, is `/sim/` itself.
   - **Shared salt.** The same browser opens `/mirage-round-replay/` and the index without asking, using the key
     `/sim/` remembered. The index lists `sim/`, and its card opens the game. A fresh browser opens
     `/mirage-round-replay/` with the throwaway password. The replay page's Google Fonts request is stubbed and CDN
     requests are blocked, so the run stays offline.
   - **Phone (390×844, DPR 3, touch, iPhone UA).** The page is unlocked by tapping and typing and starts in
     spectate mode with the panel collapsed. There's no sideways scrolling. Start works by tap. Pinching zooms,
     one-finger drag pans and double-tap shows the whole map again. Pause, Resume, 4× and Follow all work by tap. No
     errors and no requests beyond `/sim/`.
   - **Embedded data.** The phone's spectate log has the same digest as a Node `Session` run of the same length on
     `data/*.json`, which shows the embedded, inflated data is the same round.
   - **Screenshots:** `lock-desktop.png`, `sim-desktop.png`, `lock-phone.png`, `sim-phone-ready.png`,
     `sim-phone-zoomed.png`, `sim-phone.png`, `index-desktop.png` and `mirage-desktop.png`, plus `summary.json`.

On this VM (Chromium 153), every check passes in about 20 s. Unlocking takes about 0.7 s, mostly PBKDF2. On a Mac,
install a browser once with `npx playwright-core install chromium` (or set `CHROME_PATH`).

**Not tested: real Safari.** There is no WebKit here. The phone run is Chromium with an iPhone viewport, user agent
and touch. Things only a real iPhone shows:

- the layout under Safari's toolbars (`100dvh`, safe areas);
- `DecompressionStream` (iOS 16.4+);
- the speed of PBKDF2 at 600k iterations;
- the lock screen's `document.write` handoff to a `type="module"` script. The existing replay page already relies
  on that handoff on phones.

After the first deploy, open `/cs2/sim/` on an iPhone and check that you can unlock, tap Start, pinch, and switch
to 4×.

## Option A: by hand

No secrets needed. The password is typed into `deploy.sh`'s hidden prompt on John's Mac, and every push uses John's
own git credentials. With web-apps and johnjp15.github.io cloned side by side:

```sh
cd ~/path/to/cs2-round-replay && git pull && npm ci
tools/stage-web-apps.sh ~/path/to/web-apps
cd ~/path/to/web-apps && git add cs2 && git commit -m "cs2/sim: build of cs2-round-replay@$(git -C ~/path/to/cs2-round-replay rev-parse --short HEAD)" && git push
cs2/tools/deploy.sh                       # asks for the password; writes ../johnjp15.github.io/cs2/
cd ../johnjp15.github.io && git add cs2 && git commit -m "Update cs2" && git push
```

Optional checks before the last push:

- `npm run check:locked -- --web-apps ~/path/to/web-apps` in this repo (throwaway password);
- web-apps' own `cs2/tools/smoke.cjs` against a local server, with the real password.

## Option B: automatic (recommended)

```
cs2-round-replay: push to main
  └─ stage-web-apps.yml (this repo; WEB_APPS_TOKEN)
       builds, runs tools/stage-web-apps.sh, opens or updates a PR on johnjp15/web-apps (branch cs2-round-replay/sim)
John reviews and merges the PR  ← the publish decision
web-apps: push to main touching cs2/**  (or run by hand)
  └─ cs2-deploy.yml (web-apps; CS2_PASSWORD, PAGES_TOKEN)
       cs2/tools/deploy.sh → plaintext guard → commit → push to johnjp15/johnjp15.github.io master → GitHub Pages
```

Drafts: [`docs/deploy/web-apps-deploy.yml`](deploy/web-apps-deploy.yml) and
[`docs/deploy/stage-web-apps-pr.yml`](deploy/stage-web-apps-pr.yml). The local runs below used throwaway git repos,
a local bare remote and the throwaway password; neither workflow has run on GitHub yet.

- **Deploy workflow.** Writes the three locked pages, leaves `lock.json` byte for byte the same, commits and
  pushes. A wrong password stops it before anything is written.
- **Staging workflow.** Commits the card, the README row and `sim/index.html` on the bot branch. Staging again on
  that branch leaves nothing to commit.

### Secrets John creates

| Secret | Create it in | Value | Scope |
| --- | --- | --- | --- |
| `CS2_PASSWORD` | **web-apps** → Settings → Secrets and variables → Actions → New repository secret | The current cs2 password: the one `cs2/tools/lock.json`'s verifier was made with. | Readable only by web-apps' workflows. Only the deploy workflow's encrypt step gets it. |
| `PAGES_TOKEN` | Created at github.com → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**; stored as a **web-apps** repository secret | The token | Resource owner johnjp15. Repository access: *Only select repositories* → `johnjp15/johnjp15.github.io`. Repository permissions: **Contents: Read and write** (GitHub adds Metadata: Read-only). Nothing else. |
| `WEB_APPS_TOKEN` | Created the same way; stored as a **cs2-round-replay** repository secret | The token | Resource owner johnjp15. Only `johnjp15/web-apps`. **Contents: Read and write**, **Pull requests: Read and write** (plus Metadata: Read-only). Nothing else. |

Give both tokens an expiry and set a reminder to rotate them. When a token expires, its workflow fails with an auth
error and publishes nothing. A write-access deploy key (SSH) on johnjp15.github.io would work in place of
`PAGES_TOKEN` (one repo, no expiry), but the draft uses the token.

**The password never passes through Claude.** John types it into GitHub's secret form, or into
`gh secret set CS2_PASSWORD --repo johnjp15/web-apps`, which prompts for it, so it stays out of argv and shell
history.

- Actions secrets can't be read back, and GitHub masks them in logs.
- Only the deploy workflow's encrypt step gets it.
- No file in either repo holds it: `lock.json` has only the salt and a verifier.
- This session never had it. Everything here used `test-only-password` on a temp copy with its own salt.

### Installing it

1. Create `PAGES_TOKEN` and add it, with `CS2_PASSWORD`, to the web-apps repository secrets.
2. Copy `docs/deploy/web-apps-deploy.yml` to `web-apps/.github/workflows/cs2-deploy.yml` and push it. Then run it
   once by hand (Actions → Deploy cs2 pages → Run workflow) and check `https://johnjp15.github.io/cs2/`.
3. Create `WEB_APPS_TOKEN` and add it to this repo's secrets. Copy `docs/deploy/stage-web-apps-pr.yml` to
   `.github/workflows/stage-web-apps.yml` here.

   **Manual equivalent of step 3:** skip the token and the workflow. Run `tools/stage-web-apps.sh ~/path/to/web-apps`
   and commit and push web-apps yourself; the push to `cs2/**` runs the deploy.

### Behaviour worth knowing

- **Nothing is published until John merges the PR.** The PR moves the plaintext page into the private web-apps
  repo, just as staging by hand does. The deploy runs on the merge.
- **The bot branch is force-pushed.** `cs2-round-replay/sim` belongs to the bot and is always web-apps `main` plus
  one commit. One PR stays open and is updated for each push to main. A push that doesn't change the built page
  opens nothing.
- **Every deploy rewrites every page.** Each page is re-encrypted with a fresh IV, so all of
  `johnjp15.github.io/cs2/` changes, about 1.1 MB per deploy commit.
- **Password changes stay local.** Run `CS2_NEW_PASSWORD=1 cs2/tools/deploy.sh` on the Mac, commit
  `cs2/tools/lock.json` to web-apps, then update the `CS2_PASSWORD` secret. The workflow fails rather than publish
  under a new salt or verifier. A mistyped secret is refused by `encrypt.cjs`.
- **Favicon request.** `lock.html` has no icon link, so a browser may ask for `/favicon.ico` before unlocking. The
  app never does: its own icon is `data:,`.
