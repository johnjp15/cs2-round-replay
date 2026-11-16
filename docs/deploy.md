# Publishing the sims at johnjp15.github.io/cs2/sim/ and /cs2/sim3d/

> **Status (2026-11-16):** this repo is public and deploys its own two pages. CI's `deploy` job
> (`.github/workflows/ci.yml`) runs after `check` passes on every push to main, and on Actions → CI → Run workflow.
> It locks both builds with `tools/pages/deploy.sh` and pushes them to the public **johnjp15/johnjp15.github.io**
> repo (branch `master`), which GitHub Pages serves. It needs two repository secrets that John adds himself,
> `CS2_PASSWORD` and `PAGES_TOKEN`; until both exist the job fails with an error naming the missing one. The old path
> (stage the plaintext pages into the private web-apps repo, whose workflow locked and pushed them) is gone: the
> private repos' Actions minutes ran out, and a public repo's are free.

The sims are two pages of John's password-locked cs2 site. The other cs2 pages (the index and
`mirage-round-replay/`) still come from the private **web-apps** repo (`cs2/`, with its own `cs2/tools/deploy.sh`
and `cs2-deploy.yml`), which leaves `cs2/sim/` and `cs2/sim3d/` alone.

- **One lock for every page.** Each page is AES-256-GCM-encrypted with a key from PBKDF2-SHA256 (600,000
  iterations) and the salt in `lock.json`, inside `lock.html`, which decrypts in the browser and replaces itself
  with the page. `tools/pages/encrypt.cjs`, `lock.html` and `lock.json` are byte-for-byte copies of web-apps'
  `cs2/tools/`, so one password unlocks every cs2 page, and a browser that unlocked one opens the rest without
  asking. `npm run check:locked` checks that they still match.
- **What is public.** `lock.json` holds the salt and a verifier (an HMAC made with the key), never the password.
  Publishing it gives an attacker nothing the locked pages don't: any of them can be tested offline against a
  guessed password. And since this repo is public, anyone can build the plaintext pages from source; the lock keeps
  the published pages from being read casually, nothing more.
- **Self-contained pages.** Only `cs2/<page>/index.html` (and its `.deploy-stamp`) is published, so a page carries
  everything it needs.

| Piece | What it does |
| --- | --- |
| `npm run build:single`, `npm run build:single:3d` | Write `dist-single/index.html` (2D) and `dist-single-3d/index.html` (3D): the whole app in one file that makes no requests. The builds are reproducible: the same commit gives the same bytes. |
| `tools/pages/deploy.sh <pages-checkout>` | Builds both (unless `--no-build`), locks them with `CS2_PASSWORD` and writes `cs2/sim/` and `cs2/sim3d/` into a johnjp15.github.io checkout. Never commits or pushes. |
| CI's `deploy` job | Runs `deploy.sh` on main once `check` passes, commits `cs2: deploy cs2-round-replay@<sha>` as github-actions[bot] and pushes to johnjp15.github.io `master`. |
| `npm run check:locked` | The whole cs2 site (web-apps' pages plus these two) in a temp copy with a throwaway password, opened in headless Chromium. |

## The deploy job

1. Fails at once, naming the secret, if `CS2_PASSWORD` or `PAGES_TOKEN` is empty.
2. Checks out this repo into `repo/` (no stored credentials) and johnjp15.github.io `master` into `pages/` (with
   `PAGES_TOKEN`), then `npm ci`.
3. `repo/tools/pages/deploy.sh pages`:
   - A page whose `.deploy-stamp` matches sha256(its build + `lock.json` + `lock.html` + `encrypt.cjs`) is left as
     it is, so a push that doesn't change the build (tests, fixtures, tools) publishes nothing. Each re-encryption
     adds its whole page (1.7 MB 2D, 2.5 MB 3D) to the Pages repo's history: ciphertext doesn't delta-compress.
   - `encrypt.cjs` refuses a password that doesn't match `lock.json`'s verifier, so a mistyped secret publishes
     nothing. The script also stops if `lock.json` would change (a new salt or verifier) or if
     `grep -rlE 'sk8ers|Sp4rtaN|snarlbot|WMD\.'` matches the locked output.
4. Commits only `cs2/sim` and `cs2/sim3d` and pushes. If web-apps pushed in between, it rebases (the two never
   touch the same files) and tries again, three times in all.

It never runs for pull requests or forks (the `if:` checks the repository, `refs/heads/main` and the event). A newer
push to main cancels the run in progress, so only the newest commit deploys. Docs-only pushes don't run CI at all;
the build doesn't depend on docs.

### Secrets John creates

Both in cs2-round-replay → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
| --- | --- |
| `CS2_PASSWORD` | The cs2 page password, the one `lock.json`'s verifier was made with (the same as web-apps' `CS2_PASSWORD`). |
| `PAGES_TOKEN` | A fine-grained personal access token (github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens): resource owner johnjp15, *Only select repositories* → `johnjp15/johnjp15.github.io`, Repository permissions **Contents: Read and write** (GitHub adds Metadata: Read-only). Nothing else. |

**The password never passes through Claude.** John types it into GitHub's secret form, or into
`gh secret set CS2_PASSWORD --repo johnjp15/cs2-round-replay`, which prompts for it. Secrets can't be read back,
GitHub masks them in logs, only the deploy job's steps get them, and runs for forks' pull requests never see them.
When `PAGES_TOKEN` expires, the push fails with an auth error and nothing is published: make a new token and
replace the secret.

`WEB_APPS_TOKEN`, the old staging workflow's token for web-apps, is no longer used: delete the secret and revoke the
token.

### Changing the password

`lock.json` now exists twice, here and in web-apps, and the two must stay identical:

1. `CS2_NEW_PASSWORD=1 cs2/tools/deploy.sh` in web-apps, on John's machine (it asks for the new password and writes
   a new `cs2/tools/lock.json`); commit that to web-apps.
2. Copy it to `tools/pages/lock.json` here and commit.
3. Change `CS2_PASSWORD` in both repos' secrets, then let both deploys run.

Until all three are done, the deploys refuse rather than publish pages behind two different locks.

### By hand

No `PAGES_TOKEN` needed: John's own git credentials push. With johnjp15.github.io cloned next to this repo:

```sh
npm ci
read -rs CS2_PASSWORD && export CS2_PASSWORD   # typed, so it stays out of shell history
tools/pages/deploy.sh ../johnjp15.github.io; unset CS2_PASSWORD
cd ../johnjp15.github.io && git add cs2/sim cs2/sim3d && git commit -m "cs2: deploy cs2-round-replay@$(git -C ../cs2-round-replay rev-parse --short HEAD)" && git push
```

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

**Sizes** (2026-11-16 builds; KB = 1,024 bytes; "locked" is the file `encrypt.cjs` writes):

| Page | Plaintext | gzip | Locked | Locked, gzip (as Pages serves it) |
| --- | ---: | ---: | ---: | ---: |
| `sim/` (`dist-single/index.html`) | 1,242 KB | 754 KB | 1,663 KB | 1,251 KB |
| `sim3d/` (`dist-single-3d/index.html`) | 1,907 KB | 862 KB | 2,548 KB | — |

Ciphertext can't be compressed, so the GitHub Pages gzip stops helping once a page is locked; the only gain left is
base64 of random bytes gzipping to about ¾. That is why the embedded JSON is gzipped before encryption.

**Browser support.**

- `DecompressionStream` needs Safari 16.4+ (iOS 16.4+), Chrome 80+ or Firefox 113+. On anything older, the page
  says "this browser is too old to open the replay (it needs Safari 16.4 or newer)".
- The lock screen itself needs Web Crypto, so it only works over https or on localhost.

**Plaintext guard.** `tools/pages/deploy.sh` (like web-apps' `deploy.sh`) refuses to publish if `grep -rlE 'sk8ers|Sp4rtaN|snarlbot|WMD\.'` matches its
output. The plaintext sim page does match, because the script carries the player ids `snarlbot` and `Sp4rtaN`. So
the guard would also catch this page if it ever went out unencrypted. `check:locked` verifies both sides.

## End-to-end check with a throwaway password (`npm run check:locked`)

```sh
npm run check:locked -- --web-apps ~/path/to/web-apps   # or WEB_APPS_DIR=…; default: a web-apps clone next to this repo
```

`tools/e2e-locked.ts` only reads the web-apps checkout: at the end it compares a hash of every file under its
`cs2/` with the hash taken at the start. All writes go to a temp copy (`--tmp`, default `<os tmpdir>/cs2-e2e`,
`/tmp/cs2-e2e` on Linux) and to `--out` (default `logs/locked-check/`). The steps:

1. **The site as published.** `tools/pages/{encrypt.cjs,lock.html,lock.json}` must be byte for byte web-apps'
   `cs2/tools/` copies. Copies web-apps' `cs2/` (without any `sim/` or `sim3d/` of its own) to the temp dir and adds
   `dist-single/index.html` and `dist-single-3d/index.html` as `sim/` and `sim3d/` (built first unless `--no-build`).
2. **Encrypt.** Deletes the copy's `tools/lock.json`, so a fresh salt and verifier are made, then runs
   `CS2_PASSWORD=test-only-password CS2_NEW_PASSWORD=1 node <tmp>/cs2/tools/encrypt.cjs <tmp>/cs2 <tmp>/out`. Every
   other child process gets an environment with any `CS2_PASSWORD` removed.
3. **Check the output.**
   - `tools/pages/deploy.sh`'s own plaintext grep (the pattern is read from the script) must find nothing in
     `<tmp>/out`.
   - The same grep must match the plaintext sim page.
   - The output must be exactly the four pages: the index, `mirage-round-replay/`, `sim/` and `sim3d/`.
   - Each page must decrypt in Node to its source, byte for byte.
4. **Browser checks.** Serves `<tmp>/out` at `http://localhost:<port>/` on loopback only and opens it in headless
   Chromium (playwright-core):
   - **Desktop (1280×860).** On `/sim/` the lock screen appears and a wrong password is refused. The throwaway
     password opens the game: the canvas shows the radar, the clock reads 1:39, and Start runs ticks. There must be
     no console or page errors, and the only request, seen both by Playwright and by the server, is `/sim/` itself.
   - **Shared salt.** The same browser opens `/mirage-round-replay/` and the index without asking, using the key
     `/sim/` remembered. The index lists `mirage-round-replay/`, `sim/` and `sim3d/`, and its `sim/` card opens the game. A fresh browser opens
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

On this VM (Chromium 153), every check passed on 2026-11-16. Unlocking takes about 1.3 s, mostly PBKDF2. On a Mac,
install a browser once with `npx playwright-core install chromium` (or set `CHROME_PATH`).

**Not tested: real Safari.** There is no WebKit here. The phone run is Chromium with an iPhone viewport, user agent
and touch. Things only a real iPhone shows:

- the layout under Safari's toolbars (`100dvh`, safe areas);
- `DecompressionStream` (iOS 16.4+);
- the speed of PBKDF2 at 600k iterations;
- the lock screen's `document.write` handoff to a `type="module"` script. The existing replay page already relies
  on that handoff on phones.

After a deploy, open `/cs2/sim/` on an iPhone and check that you can unlock, tap Start, pinch, and switch to 4×.
