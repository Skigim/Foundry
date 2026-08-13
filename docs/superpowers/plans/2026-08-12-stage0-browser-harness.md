# Stage 0 browser harness — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Land Stage 0's execution substrate — a Playwright harness driving a real built dev bundle — plus the
two artifacts that ride on it: the boot smoke test (artifact 4) and the golden-save simulation hash
(artifact 1).

**Architecture:** `node:test` stays the runner. A test-side harness module builds nothing itself: it asserts a
dev build is present, serves `build/` over a throwaway localhost HTTP server, opens it in headless Chromium,
and reaches into the game through `window.shapez` (which `ModLoader.exposeExports()` populates in dev builds).
No hooks are added to `src/js`. CI builds the bundle in a dedicated job before running the tests.

**Tech Stack:** Node 22 · `node:test` + `node:assert/strict` · Playwright (Chromium) · existing gulp/webpack 4
dev pipeline · GitHub Actions (`ubuntu-latest`).

**Spec:** [2026-08-12-stage0-browser-harness-design.md](../specs/2026-08-12-stage0-browser-harness-design.md).
Read it before starting. This plan implements it; where they disagree, the spec wins and the plan is wrong.

---

## Global Constraints

These apply to every task. They are not repeated per-task.

- **Prettier is enforced as an eslint error.** 4-space indent, double quotes, semicolons, 110 print width,
  `es5` trailing commas, `arrowParens: avoid`. Run `yarn lint` before every commit.
- **`yarn tslint` must stay clean.** `src/js/tsconfig.json` only covers `src/js`, so `test/` is not
  typechecked — but do not break `src/js`. **No production source under `src/js` is modified by this plan
  at all.**
- **Tests must not live under `src/js`.** `component_registry.js:56` counts `.js` files in
  `game/components` via `require.context` and asserts the count matches the registry.
- **Do not add `"type": "module"` to `package.json`.** `sync-translations.js` and the gulp tooling are
  CommonJS. Test files use ESM via the `.js` + `import` combination that `test/rng.determinism.test.js`
  already relies on under Node 22.
- **Webpack 4 cannot run on Node 17+** without `NODE_OPTIONS=--openssl-legacy-provider`. Every gulp build
  step in this plan sets it. It disappears at Stage 1.
- **Every commit must be green on its own** (`yarn lint` + `yarn tslint` + `yarn test`), so `git bisect`
  landing inside a branch still means something.
- **Committed reference values are never regenerated to make CI pass.** This covers `SEED_42_FIRST_5` in
  `test/rng.determinism.test.js`, the new `GOLDEN_SAVE_HASH`, and `test/fixtures/golden_save.json`. A change
  there means determinism broke, and that is the finding, not an obstacle.
- **Two branches, merged with `--no-ff`:** `phase-1/stage-0-boot-smoke` (Tasks 1–4) then
  `phase-1/stage-0-golden-hash` (Tasks 5–7). Branch B starts from master *after* Branch A merges.

---

## File structure

| File | Responsibility |
| --- | --- |
| `.github/workflows/ci.yml` (modify) | New `browser-test` job: build dev bundle → prove atlas → run browser tests. Existing `setup`/`test`/`yaml-lint` jobs untouched. |
| `package.json` (modify) | Narrow `test` glob to `test/*.test.js`; add `test:browser`; add `playwright` devDependency. |
| `test/browser/harness.js` (create) | Everything test-side and reusable: build verification, static server, browser launch, error capture, main-menu wait, determinism controls, tick stepping, state hashing. Artifacts 2 and 3 are expected to import from here. |
| `test/browser/boot.smoke.test.js` (create) | Stage 0 artifact 4. |
| `test/browser/golden_save.test.js` (create) | Stage 0 artifact 1. |
| `test/browser/generate_fixture.js` (create) | One-shot developer tool that writes the fixture. Not a `.test.js`, so the runner ignores it. |
| `test/browser/dump_state.js` (create) | Developer tool: prints the hash and dumps the hashed subset for diffing. The answer to "what changed?" when the golden hash moves. Not a `.test.js`. |
| `test/fixtures/golden_save.json` (create) | Committed fixture savegame. |
| `docs/handoff.md` (modify) | Updated at the end of each branch. |
| `docs/roadmap/phase-1.md` (modify) | A **Status** paragraph under Stage 0's deliverables, naming which artifacts have landed. |

Rationale for one harness file rather than several: the four Stage 0 artifacts all need the same
launch-and-reach-into-the-game plumbing, and splitting it before artifacts 2 and 3 are specced would be
guessing at the seams. It is expected to be split when artifact 2 lands and the real seams are visible.

---

# Branch A — boot smoke test

```bash
git checkout master && git pull && git checkout -b phase-1/stage-0-boot-smoke
```

---

### Task 1: Prove `imgres.buildAtlas` runs on `ubuntu-latest`

**This task must complete before any test code is written.** `gulp/image-resources.js:111` wraps the whole
atlas task in `catch { console.warn(...) }` and then calls `cb()` — a *successful* callback. A missing Java
or a failed 22MB jar download yields a "successful" build with no sprites. It has never run in this repo's
CI. It is the single biggest schedule risk in the plan, and if it bites, it bites here, cheaply.

**Files:**
- Modify: `.github/workflows/ci.yml` (append a `browser-test` job after `test:`)

**Interfaces:**
- Consumes: nothing.
- Produces: a `browser-test` CI job that leaves a built dev bundle in `build/` and a populated
  `res_built/atlas/`. Task 3 appends Playwright steps to this same job.

- [ ] **Step 1: Add the job**

Append to `.github/workflows/ci.yml`, at the same indentation as the existing `test:` job (4 spaces),
placed between `test:` and `yaml-lint:`:

```yaml
    browser-test:
        name: browser-test
        runs-on: ubuntu-latest
        steps:
            - name: Checkout repo
              uses: actions/checkout@v2

            - name: Setup Node
              uses: actions/setup-node@v2-beta
              with:
                  node-version: 22.x

            - name: Install ffmpeg
              run: |
                  sudo apt-get update
                  sudo apt-get install -y ffmpeg

            # imgres.buildAtlas shells out to `java -jar`. Fail here, legibly,
            # rather than inside a task that swallows its own exceptions.
            - name: Verify Java is available
              run: java -version

            - name: Cache texture-packer jar
              uses: actions/cache@v4
              with:
                  path: gulp/runnable-texturepacker.jar
                  key: runnable-texturepacker-jar-v1

            - name: Install Yarn Dependencies
              run: |
                  yarn
                  cd gulp/
                  yarn
                  cd ..

            # Webpack 4 dies on Node 17+ without the legacy OpenSSL provider.
            # Scoped to the build steps so the tests still run on plain Node 22.
            - name: Build dev bundle
              working-directory: gulp
              env:
                  NODE_OPTIONS: --openssl-legacy-provider
              run: |
                  yarn gulp build.prepare.dev
                  yarn gulp js.web-localhost.dev
                  yarn gulp html.web-localhost.dev

            # gulp/image-resources.js:111 catches its own failures and still calls
            # cb(), so a broken atlas build reports success. Without sprites the
            # game hangs forever on "Downloading resources" (states/preload.js:211
            # returns a promise that never resolves), which is a confusing way to
            # find out. Assert it here instead.
            - name: Verify the atlas actually built
              run: |
                  ls -la res_built/atlas/ || true
                  if [ -z "$(ls res_built/atlas/*.png 2>/dev/null)" ]; then
                      echo "::error::imgres.buildAtlas produced no sprites (it fails silently - see gulp/image-resources.js:111)"
                      exit 1
                  fi

            - name: Verify the bundle actually built
              run: |
                  test -f build/index.html
                  test -f build/bundle.js
                  test -f build/main.css
```

Note the deliberate action-version mix: `actions/checkout@v2` and `actions/setup-node@v2-beta` match what the
other jobs already use and are known green here; `actions/cache@v4` is used because the v2-era cache action is
retired. Do not "tidy" the other jobs' versions in this task.

- [ ] **Step 2: Run it and read the log**

The workflow triggers on `pull_request` to `master`, so a branch push alone does nothing.

```bash
git add .github/workflows/ci.yml && git commit -m "Prove the atlas build works on ubuntu-latest in CI" && git push -u origin phase-1/stage-0-boot-smoke
```

```bash
gh pr create --draft --base master --title "Stage 0: boot smoke test" --body "Draft while Stage 0's browser harness lands. Task 1 proves imgres.buildAtlas runs on ubuntu-latest."
```

```bash
gh run watch
```

Expected: the `browser-test` job is green, and the "Verify the atlas actually built" step's `ls -la` output
lists `atlas0.png` (and possibly further `atlas<N>.png` / `.atlas` / `.json` files).

- [ ] **Step 3: If the atlas step fails, stop and diagnose — do not work around it**

This is the measurement the whole plan is gated on. Read the "Build dev bundle" log for
`Building atlas failed. Java not found / unsupported version?`. Likely causes, in order:

1. **Jar download failed.** `image-resources.js:88-95` tries `wget`, then `curl`, then two Windows-only
   fallbacks. `ubuntu-latest` has curl; wget is usually present. Check whether the cache step restored a
   zero-byte `gulp/runnable-texturepacker.jar` — if so, bump the cache key to `runnable-texturepacker-jar-v2`.
2. **Java missing or wrong major version.** The "Verify Java is available" step should have caught missing
   Java. If Java exists but the jar refuses to run, add
   `- uses: actions/setup-java@v4` with `distribution: temurin`, `java-version: "17"` before the build.
3. **`res_raw/atlas.json` unreadable.** Check it is committed and non-empty.

Record whichever it was in `docs/handoff.md`'s Empirical constraints in Task 4 — this is exactly the kind of
finding that section exists for.

- [ ] **Step 4: Record the result**

Leave the draft PR open; Tasks 2–4 push to the same branch and re-use its runs.

---

### Task 2: Harness + boot smoke test, green locally

**Files:**
- Create: `test/browser/harness.js`
- Create: `test/browser/boot.smoke.test.js`
- Modify: `package.json` (scripts + `playwright` devDependency)

**Interfaces:**
- Consumes: the dev build produced by Task 1's gulp sequence.
- Produces, from `test/browser/harness.js`:
  - `REPO_ROOT: string`, `BUILD_DIR: string`, `ATLAS_DIR: string`
  - `assertBuildPresent(): void` — throws with an actionable message
  - `startStaticServer(rootDir?: string): Promise<{url: string, close(): Promise<void>}>`
  - `launchGame(options?: {allowExternalRequests?: boolean, headless?: boolean}): Promise<GameSession>`
    where `GameSession = {page: import("playwright").Page, pageErrors: string[], consoleErrors: string[],
    close(): Promise<void>}`
  - `waitForMainMenu(page, timeoutMs?: number): Promise<void>`

  Task 5 adds `prepareDeterministicRun`, `loadFixtureGame`, `runTicks` and `hashSimulationState` to the same
  module.

- [ ] **Step 1: Split the test globs and add Playwright**

`test/browser/**` would otherwise be swept into the existing `yarn test` glob, and that job deliberately runs
in seconds with no `yarn install`.

In `package.json`, replace the `test` script line and add `test:browser` beneath it:

```json
        "test": "node --test \"test/*.test.js\"",
        "test:browser": "node --test \"test/browser/**/*.test.js\"",
```

Add to `devDependencies`, keeping alphabetical order (between `postcss-unprefix` and `prettier`):

```json
        "playwright": "^1.49.0",
```

Then install:

```bash
yarn install
```

- [ ] **Step 2: Keep the Node-16 CI job from downloading browsers**

The `playwright` package's postinstall downloads browsers. The existing `setup` job runs `yarn` on **Node 16**,
which Playwright 1.49 does not support. Suppress the download workflow-wide and install the browser explicitly
in the one job that needs it (Task 3).

In `.github/workflows/ci.yml`, insert between the `on:` block and `jobs:`:

```yaml
# The playwright package downloads browsers on install. Only browser-test needs
# them, and the `setup` job runs yarn on Node 16, which playwright does not
# support. browser-test installs Chromium explicitly instead.
env:
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: 1
```

If the `setup` job still fails on `yarn` after this — Playwright's install script itself refusing to parse or
run under Node 16 — pin `"playwright": "1.40.1"` instead, the last line that supports Node 16, and note it in
the handoff.

- [ ] **Step 3: Write the failing test**

Create `test/browser/boot.smoke.test.js`:

```js
// Stage 0 artifact 4: boot smoke test.
//
// Proves the built dev bundle launches in a real browser and reaches the main
// menu with no uncaught exception. This is the guard Stage 1's build rewrite is
// measured against: a bundler swap that produces something which no longer boots
// fails here, loudly, instead of being discovered by hand later.
//
// Requires a dev build in build/. See harness.js for the exact command.

import { test } from "node:test";
import assert from "node:assert/strict";

import { launchGame, waitForMainMenu } from "./harness.js";

test("the dev bundle boots to the main menu with no uncaught errors", async t => {
    const session = await launchGame();
    t.after(() => session.close());

    await waitForMainMenu(session.page);

    // MainMenuState.renderMainMenu() sets data-savegames on .mainContainer as its
    // last act, so this waits for the menu to have finished rendering rather than
    // racing the state switch that put us here.
    await session.page.waitForSelector(".mainContainer[data-savegames]", { timeout: 10000 });

    // Reported, not asserted on: blocked third-party requests log here by design,
    // and so does anything the game considers survivable.
    if (session.consoleErrors.length > 0) {
        t.diagnostic("console.error during boot:\n" + session.consoleErrors.join("\n"));
    }

    assert.deepEqual(session.pageErrors, [], "uncaught exception(s) during boot");
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `yarn test:browser`

Expected: FAIL with `Cannot find module ... test/browser/harness.js`.

- [ ] **Step 5: Write the harness**

Create `test/browser/harness.js`:

```js
// Stage 0 browser harness.
//
// Serves a real built dev bundle over localhost and opens it in headless
// Chromium. Everything here is test-side; no hooks are added to src/js.
//
// Why a real build and a real browser rather than plain Node: any bundle
// containing game/core.js contains every .js file under src/js, because
// savegame.js imports modloader.js, which calls require.context("../", true,
// /\.js$/) — resolved statically at build time regardless of the G_IS_DEV gate
// around exposeExports(). So there is no small bundle to load under Node, and
// once a full build is required anyway a real browser costs little more. The
// same require.context is what puts every export on window.shapez, which is how
// the tests reach into the game.
//
// Full reasoning: docs/superpowers/specs/2026-08-12-stage0-browser-harness-design.md

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUILD_DIR = join(REPO_ROOT, "build");
export const ATLAS_DIR = join(REPO_ROOT, "res_built", "atlas");

const BUILD_COMMAND = [
    "cd gulp",
    "NODE_OPTIONS=--openssl-legacy-provider yarn gulp build.prepare.dev",
    "NODE_OPTIONS=--openssl-legacy-provider yarn gulp js.web-localhost.dev",
    "NODE_OPTIONS=--openssl-legacy-provider yarn gulp html.web-localhost.dev",
].join(" && ");

const MIME_TYPES = {
    ".css": "text/css",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".mp3": "audio/mpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webm": "video/webm",
    ".woff2": "font/woff2",
};

/**
 * Fails loudly if there is no usable dev build to test against.
 * @returns {void}
 */
export function assertBuildPresent() {
    for (const file of ["index.html", "bundle.js", "main.css"]) {
        if (!existsSync(join(BUILD_DIR, file))) {
            throw new Error(`Missing build/${file}. Build the dev bundle first:\n  ${BUILD_COMMAND}`);
        }
    }

    // gulp/image-resources.js:111 catches its own failures and still calls cb(),
    // so a broken atlas build reports success. The game then hangs forever on
    // "Downloading resources" — states/preload.js:211 returns a promise that
    // never resolves when resource loading fails. Catch it here, where the
    // message can say what actually happened.
    const sprites = existsSync(ATLAS_DIR) ? readdirSync(ATLAS_DIR).filter(f => f.endsWith(".png")) : [];
    if (sprites.length === 0) {
        throw new Error(
            "res_built/atlas contains no .png sprites: imgres.buildAtlas failed silently. " +
                "Check that `java -version` works and that gulp/runnable-texturepacker.jar downloaded."
        );
    }
}

/**
 * Serves a directory over an ephemeral localhost port. The game needs a real
 * http origin — IndexedDB, which mods/modloader.js opens during boot, is
 * unavailable on file://.
 * @param {string} rootDir
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export function startStaticServer(rootDir = BUILD_DIR) {
    const server = createServer((req, res) => {
        const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
        const filePath = join(rootDir, pathname === "/" ? "index.html" : pathname);

        if (!filePath.startsWith(rootDir)) {
            res.writeHead(403).end();
            return;
        }

        let body;
        try {
            if (!statSync(filePath).isFile()) {
                throw new Error("not a file");
            }
            body = readFileSync(filePath);
        } catch {
            res.writeHead(404).end();
            return;
        }

        res.writeHead(200, {
            "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
        });
        res.end(body);
    });

    return new Promise(ready => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = /** @type {{ port: number }} */ (server.address());
            ready({
                url: `http://127.0.0.1:${port}/`,
                close: () => new Promise(done => server.close(() => done())),
            });
        });
    });
}

/**
 * @typedef {object} GameSession
 * @property {import("playwright").Page} page
 * @property {string[]} pageErrors Uncaught exceptions, newest last.
 * @property {string[]} consoleErrors console.error output. Reported, not asserted on.
 * @property {() => Promise<void>} close
 */

/**
 * Serves and opens the dev bundle. Returns as soon as navigation starts; use
 * waitForMainMenu to wait for boot.
 * @param {{ allowExternalRequests?: boolean, headless?: boolean }} [options]
 * @returns {Promise<GameSession>}
 */
export async function launchGame(options = {}) {
    const { allowExternalRequests = false, headless = true } = options;

    assertBuildPresent();

    const server = await startStaticServer();
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

    if (!allowExternalRequests) {
        // The game pings analytics and api endpoints during preload. Those calls
        // are already failure-tolerant (preload.js:147 wraps fetchDiscounts in
        // timeoutPromise), so refusing them is faster than waiting for a real
        // timeout and stops CI depending on third-party uptime. Flip
        // allowExternalRequests if a boot failure ever looks network-shaped.
        await context.route("**/*", route => {
            const { hostname } = new URL(route.request().url());
            return hostname === "127.0.0.1" || hostname === "localhost"
                ? route.continue()
                : route.abort();
        });
    }

    const page = await context.newPage();

    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", err => pageErrors.push(err.stack || String(err)));
    page.on("console", msg => {
        if (msg.type() === "error") {
            consoleErrors.push(msg.text());
        }
    });

    await page.goto(server.url);

    return {
        page,
        pageErrors,
        consoleErrors,
        async close() {
            await browser.close();
            await server.close();
        },
    };
}

/**
 * Waits for the state manager to have entered MainMenuState. It sets
 * document.body.id = "state_" + key (core/state_manager.js:88), which is a
 * state-machine fact rather than a rendering timing guess.
 * @param {import("playwright").Page} page
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export async function waitForMainMenu(page, timeoutMs = 90000) {
    try {
        await page.waitForFunction(() => document.body.id === "state_MainMenuState", null, {
            timeout: timeoutMs,
        });
    } catch (err) {
        // PreloadState hangs rather than throwing when resource loading fails, so
        // its own status line is the only thing that says how far boot got.
        const status = await page.textContent("#ll_preload_status").catch(() => "(unavailable)");
        throw new Error(`Never reached the main menu. Preloader status: "${status}"`, { cause: err });
    }
}
```

- [ ] **Step 6: Build and run the test**

```bash
cd gulp && NODE_OPTIONS=--openssl-legacy-provider yarn gulp build.prepare.dev && NODE_OPTIONS=--openssl-legacy-provider yarn gulp js.web-localhost.dev && NODE_OPTIONS=--openssl-legacy-provider yarn gulp html.web-localhost.dev
```

Then, from the repo root:

```bash
yarn test:browser
```

Expected: PASS, 1 test.

If it hangs and then reports `Never reached the main menu. Preloader status: "Downloading resources"`, the
local atlas is stale or empty. Note that `utils.cleanImageBuildFolder` cleans `gulp/res_built`, not the
repo-root `res_built` the atlas is actually written to (`gulp/gulpfile.js:88` vs
`gulp/image-resources.js:78`) — so a local atlas is never cleaned and can go stale. Delete `res_built/`
by hand and rebuild.

- [ ] **Step 7: Verify the fast test job is unaffected**

Run: `yarn test`
Expected: PASS, 7 tests, in under a second — the narrowed glob must still pick up
`test/rng.determinism.test.js` and must **not** pick up `test/browser/`.

- [ ] **Step 8: Lint and typecheck**

```bash
yarn lint && yarn tslint
```

Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add package.json yarn.lock .github/workflows/ci.yml test/browser/harness.js test/browser/boot.smoke.test.js && git commit -m "Add a Playwright harness and Stage 0's boot smoke test"
```

---

### Task 3: Run the smoke test in CI

**Files:**
- Modify: `.github/workflows/ci.yml` (extend the `browser-test` job)

**Interfaces:**
- Consumes: the `browser-test` job from Task 1, `yarn test:browser` from Task 2.
- Produces: CI enforcement of artifact 4.

- [ ] **Step 1: Append the Playwright steps**

Add to the end of the `browser-test` job's `steps:`, after "Verify the bundle actually built":

```yaml
            - name: Cache Playwright browsers
              uses: actions/cache@v4
              with:
                  path: ~/.cache/ms-playwright
                  key: playwright-${{ runner.os }}-${{ hashFiles('yarn.lock') }}

            - name: Install Playwright Chromium
              run: npx playwright install --with-deps chromium

            - name: Run browser tests
              run: yarn test:browser
```

Chromium is the pinned browser: it is Playwright's bundled default, the smallest install of the three, and
the engine the game is developed against. Nothing here depends on cross-browser behaviour.

- [ ] **Step 2: Push and watch**

```bash
git add .github/workflows/ci.yml && git commit -m "Run the boot smoke test in CI" && git push
```

```bash
gh run watch
```

Expected: `browser-test` green. Note the job's wall-clock time — the design predicts 5–10 minutes; record the
real figure in Task 4.

- [ ] **Step 3: Confirm the other jobs are still green**

Expected: `CI` (lint + tslint, Node 16), `test` (Node 22, seconds), and `yaml-lint` all still pass. The
`CI` job is the one at risk from the Playwright devDependency — if it fails at `yarn`, apply the
`playwright@1.40.1` fallback from Task 2 Step 2.

---

### Task 4: Record what Branch A established

**Files:**
- Modify: `docs/handoff.md`
- Modify: `docs/roadmap/phase-1.md`

- [ ] **Step 1: Update the roadmap**

`docs/roadmap/phase-1.md`'s Stage 0 lists the four deliverables as a plain numbered list with no status
markers, so add one **Status** paragraph rather than annotating the list. Insert it immediately after the
numbered list (after the "4. **Boot smoke test.** …" item, before the "**Anti-bloat policy**" heading):

```markdown
**Status.** Artifact 4 landed 2026-08-12: `test/browser/boot.smoke.test.js`, running against a real dev
bundle in a real browser via `test/browser/harness.js`, enforced by CI's `browser-test` job. The substrate
is specified in
[docs/superpowers/specs/2026-08-12-stage0-browser-harness-design.md](../superpowers/specs/2026-08-12-stage0-browser-harness-design.md).
Artifacts 1, 2 and 3 remain outstanding.
```

Do not restructure anything else in the document. Task 7 amends this same paragraph.

- [ ] **Step 2: Update the handoff**

In `docs/handoff.md`:

- **Empirical constraints** — append what running it actually taught, one bullet each, only for things
  proven by a run:
  - whether `imgres.buildAtlas` works on `ubuntu-latest` and what it needed (Task 1's finding)
  - the measured `browser-test` job duration
  - that `utils.cleanImageBuildFolder` cleans `gulp/res_built` while the atlas is written to the repo-root
    `res_built`, so the local atlas is never cleaned and can go stale
  - anything that surprised you during Task 2 Step 6
- **Current state** — artifact 4 exists and runs in CI; the harness module is at `test/browser/harness.js`;
  `yarn test` and `yarn test:browser` are now separate.
- **Next step** — replace with Branch B (Tasks 5–7 of this plan).
- **Open questions** — resolve the two this branch answered ("which Playwright browser to pin" → Chromium,
  cached with the jar; "is the main-menu assertion stable against the preloader" → yes, via
  `document.body.id`), and leave the hash-run ones.
- Update `Last updated:`.

- [ ] **Step 3: Commit and merge the branch**

```bash
git add docs/handoff.md docs/roadmap/phase-1.md && git commit -m "Record the boot smoke test landing in the handoff"
```

```bash
git push && gh pr ready
```

Wait for CI green on the PR, then:

```bash
git checkout master && git merge --no-ff phase-1/stage-0-boot-smoke && git push
```

`--no-ff` because this is a coherent multi-commit unit that Stage 0 may need to revert wholesale.

---

# Branch B — golden-save hash

```bash
git checkout master && git pull && git checkout -b phase-1/stage-0-golden-hash
```

---

### Task 5: Determinism controls and the committed fixture

**Files:**
- Modify: `test/browser/harness.js`
- Create: `test/browser/generate_fixture.js`
- Create: `test/fixtures/golden_save.json`

**Interfaces:**
- Consumes: `launchGame`, `waitForMainMenu` from Task 2.
- Produces, added to `test/browser/harness.js`:
  - `HASHED_KEYS: string[]`
  - `startNewGame(page): Promise<void>`
  - `loadFixtureGame(page, fixture: {savegameVersion: number, dump: object}): Promise<void>`
  - `prepareDeterministicRun(page, options?: {tickRate?: number}): Promise<{tickRate: number}>`
  - `runTicks(page, tickCount: number): Promise<{ticksRun: number, timeSeconds: number}>`
  - `dumpSimulationSubset(page): Promise<object>`
  - `hashSimulationState(page): Promise<string>`
  - `stableStringify(value: unknown): string`

- [ ] **Step 1: Add the determinism controls to the harness**

Append to `test/browser/harness.js`. Note the new `node:crypto` import — add `import { createHash } from
"node:crypto";` to the import block at the top, before the `playwright` import.

```js
/** The subset phase-1.md specifies, minus time.realtimeSeconds (removed below). */
export const HASHED_KEYS = ["map", "entityMgr", "entities", "beltPaths", "hubGoals", "time", "gameMode"];

/** Debug flags from the gitignored config.local.js that change simulation output outright. */
const SIMULATION_ALTERING_DEBUG_FLAGS = [
    "instantBelts",
    "instantProcessors",
    "instantMiners",
    "disableEjectorProcessing",
    "disableLogicTicks",
    "framePausesBetweenTicks",
];

/**
 * Starts a brand new game and waits for it to be running. Used by the fixture
 * generator, not by the hash test.
 * @param {import("playwright").Page} page
 * @returns {Promise<void>}
 */
export async function startNewGame(page) {
    await page.evaluate(() => {
        const app = window.shapez.GLOBAL_APP;
        app.stateMgr.moveToState("InGameState", { savegame: app.savegameMgr.createNewSavegame() });
    });
    await waitForGameRunning(page);
}

/**
 * Loads a committed fixture through the real deserialize path.
 * @param {import("playwright").Page} page
 * @param {{ savegameVersion: number, dump: object }} fixture
 * @returns {Promise<void>}
 */
export async function loadFixtureGame(page, fixture) {
    const versionError = await page.evaluate(f => {
        const app = window.shapez.GLOBAL_APP;
        const current = window.shapez.Savegame.getCurrentVersion();
        if (f.savegameVersion !== current) {
            return `Fixture is savegame version ${f.savegameVersion} but the game is at ${current}. Migrating the fixture is a deliberate, reviewed step — do not silently regenerate it.`;
        }

        const savegame = app.savegameMgr.createNewSavegame();
        savegame.currentData = {
            version: current,
            dump: f.dump,
            stats: { failedMam: false, trashedCount: 0, usedInverseRotater: false },
            lastUpdate: 0,
            mods: [],
        };
        // hasGameDump() is what routes InGameState to stage4bResumeGame rather
        // than stage4aInitEmptyGame (states/ingame.js:261).
        app.stateMgr.moveToState("InGameState", { savegame });
        return null;
    }, fixture);

    if (versionError) {
        throw new Error(versionError);
    }

    await waitForGameRunning(page);
}

/**
 * @param {import("playwright").Page} page
 * @returns {Promise<void>}
 */
async function waitForGameRunning(page) {
    await page.waitForFunction(
        () => {
            const state = window.shapez.GLOBAL_APP.stateMgr.currentState;
            return state && state.stage === "s10_gameRunning";
        },
        null,
        { timeout: 60000 }
    );
}

/**
 * Removes every source of nondeterminism from the measured window, then proves
 * the removal took. Call once, after the game is running and before ticking.
 * @param {import("playwright").Page} page
 * @param {{ tickRate?: number }} [options]
 * @returns {Promise<{ tickRate: number }>}
 */
export async function prepareDeterministicRun(page, options = {}) {
    const { tickRate = 60 } = options;

    const result = await page.evaluate(
        ({ rate, flags }) => {
            const app = window.shapez.GLOBAL_APP;
            const root = app.stateMgr.currentState.core.root;

            // 1. Stop the ambient frame loop. The game drives itself off
            //    requestAnimationFrame (application.js:168); letting the browser
            //    decide how many ticks elapsed is nondeterministic by
            //    construction. rAF keeps spinning harmlessly, the game just stops
            //    advancing on its own.
            app.ticker.frameEmitted.removeAll();
            app.ticker.bgFrameEmitted.removeAll();

            // 2. Pin the tick rate. DynamicTickrate reads
            //    app.settings.getDesiredFps() at construction
            //    (dynamic_tickrate.js:31); deltaSeconds feeds time.timeSeconds,
            //    which is hashed. A fresh browser profile yields the default, but
            //    depending on the default never changing is not a control.
            root.dynamicTickrate.setTickRate(rate);

            // 3. globalConfig.debug comes from the gitignored config.local.js, so
            //    it differs per checkout. A developer who left instantBelts on
            //    while debugging would otherwise get a different hash from CI
            //    with no indication why.
            const offenders = flags.filter(flag => window.shapez.globalConfig.debug[flag]);
            if (offenders.length > 0) {
                return { error: "Simulation-altering debug flags are enabled in src/js/core/config.local.js: " + offenders.join(", ") };
            }

            return { tickRate: root.dynamicTickrate.currentTickRate };
        },
        { rate: tickRate, flags: SIMULATION_ALTERING_DEBUG_FLAGS }
    );

    if (result.error) {
        throw new Error(result.error);
    }
    return result;
}

/**
 * Steps the simulation a fixed number of ticks and reports how many actually ran.
 * @param {import("playwright").Page} page
 * @param {number} tickCount
 * @returns {Promise<{ ticksRun: number, timeSeconds: number }>}
 */
export async function runTicks(page, tickCount) {
    return page.evaluate(count => {
        const core = window.shapez.GLOBAL_APP.stateMgr.currentState.core;
        const root = core.root;
        const before = root.time.timeSeconds;

        for (let i = 0; i < count; ++i) {
            // performTicks, not core.tick: core.tick calls updateRealtimeNow()
            // (game/core.js:282), which reads performance.now() into the
            // serialized realtimeSeconds. performTicks is the real stepping code
            // the game itself uses, and timeSeconds still advances by the correct
            // fixed deltaSeconds per tick, so the simulation sees a
            // normally-advancing clock rather than a frozen one.
            root.time.performTicks(root.dynamicTickrate.deltaMs, () => core.updateLogic());
        }

        const elapsed = root.time.timeSeconds - before;
        return {
            ticksRun: Math.round(elapsed * root.dynamicTickrate.currentTickRate),
            timeSeconds: root.time.timeSeconds,
        };
    }, tickCount);
}

/**
 * The hashed subset of the serializer's dump.
 * @param {import("playwright").Page} page
 * @returns {Promise<object>}
 */
export async function dumpSimulationSubset(page) {
    const result = await page.evaluate(keys => {
        const root = window.shapez.GLOBAL_APP.stateMgr.currentState.core.root;
        const dump = new window.shapez.SavegameSerializer().generateDumpFromGameRoot(root);
        if (!dump) {
            // generateDumpFromGameRoot returns null when its own sanity check
            // fails in a dev build (savegame_serializer.js:56).
            return { error: "generateDumpFromGameRoot returned null: the serialized state failed its own sanity check. See the browser console for the reason." };
        }

        const subset = {};
        for (const key of keys) {
            subset[key] = dump[key];
        }
        // realtimeSeconds is performance.now()-derived (game_time.js:55).
        // Excluded regardless of the performTicks control above, so the hash
        // survives someone later reintroducing a frame into the measured window.
        delete subset.time.realtimeSeconds;
        return { subset };
    }, HASHED_KEYS);

    if (result.error) {
        throw new Error(result.error);
    }
    return result.subset;
}

/**
 * JSON with keys sorted at every level, so the hash does not move on harmless
 * key reordering in the serializers.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
    if (Array.isArray(value)) {
        return "[" + value.map(stableStringify).join(",") + "]";
    }
    if (value && typeof value === "object") {
        const entries = Object.keys(value)
            .sort()
            .map(key => JSON.stringify(key) + ":" + stableStringify(value[key]));
        return "{" + entries.join(",") + "}";
    }
    const primitive = JSON.stringify(value);
    return primitive === undefined ? "null" : primitive;
}

/**
 * @param {import("playwright").Page} page
 * @returns {Promise<string>} sha256 hex digest of the hashed subset
 */
export async function hashSimulationState(page) {
    const subset = await dumpSimulationSubset(page);
    return createHash("sha256").update(stableStringify(subset)).digest("hex");
}
```

- [ ] **Step 2: Write the fixture generator**

Create `test/browser/generate_fixture.js`. It is not a `.test.js`, so `yarn test:browser` ignores it.

```js
// One-shot developer tool: writes test/fixtures/golden_save.json.
//
// The fixture is built in code through the real building/entity APIs rather than
// captured from live play, so it is reproducible and depends on nothing random at
// test time. It is a miner on a resource patch feeding a straight run of belts
// with no consumer at the far end — enough to exercise miner ejection, belt path
// item movement and belt-to-belt handoff, small enough to stay fast in CI, and
// short enough of steady state that items are still mid-belt when the hash is
// taken.
//
// Run with a dev build present:
//   node test/browser/generate_fixture.js
//
// Regenerating the fixture changes the golden hash and is a deliberate, reviewed
// step. It is not a way to make CI green.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchGame, waitForMainMenu, startNewGame, prepareDeterministicRun, runTicks, REPO_ROOT } from "./harness.js";

const BELT_COUNT = 20;
const WARMUP_TICKS = 120;

const session = await launchGame();

try {
    await waitForMainMenu(session.page);
    await startNewGame(session.page);
    await prepareDeterministicRun(session.page);

    const built = await session.page.evaluate(beltCount => {
        const s = window.shapez;
        const root = s.GLOBAL_APP.stateMgr.currentState.core.root;

        // Find a resource tile well clear of the hub at the origin, with room to
        // run belts further north (decreasing y) without meeting anything.
        let patch = null;
        for (let y = -15; y >= -40 && !patch; --y) {
            for (let x = -40; x <= 40; ++x) {
                if (root.map.getLowerLayerContentXY(x, y)) {
                    patch = { x, y };
                    break;
                }
            }
        }
        if (!patch) {
            return { error: "Found no resource tile in the search band; widen the search." };
        }

        const place = (building, x, y) =>
            root.logic.tryPlaceBuilding({
                origin: new s.Vector(x, y),
                rotation: 0, // 0 degrees = "top" = decreasing y, so everything faces north
                originalRotation: 0,
                rotationVariant: 0,
                variant: s.defaultBuildingVariant,
                building,
            });

        const miner = place(s.gMetaBuildingRegistry.findByClass(s.MetaMinerBuilding), patch.x, patch.y);
        if (!miner) {
            return { error: `Could not place the miner at ${patch.x},${patch.y}` };
        }

        const belt = s.gMetaBuildingRegistry.findByClass(s.MetaBeltBuilding);
        for (let i = 1; i <= beltCount; ++i) {
            if (!place(belt, patch.x, patch.y - i)) {
                return { error: `Could not place belt ${i} at ${patch.x},${patch.y - i}` };
            }
        }

        return { patch, entityCount: root.entityMgr.entities.length };
    }, BELT_COUNT);

    if (built.error) {
        throw new Error(built.error);
    }
    console.log(`Placed a miner at ${built.patch.x},${built.patch.y} and ${BELT_COUNT} belts north of it.`);

    // Warm up so the fixture ships with items already in flight.
    const warmup = await runTicks(session.page, WARMUP_TICKS);
    if (warmup.ticksRun !== WARMUP_TICKS) {
        throw new Error(`Warmup ran ${warmup.ticksRun} of ${WARMUP_TICKS} ticks.`);
    }

    const fixture = await session.page.evaluate(() => {
        const s = window.shapez;
        const root = s.GLOBAL_APP.stateMgr.currentState.core.root;
        const dump = new s.SavegameSerializer().generateDumpFromGameRoot(root);
        if (!dump) {
            return { error: "generateDumpFromGameRoot returned null; the state failed its sanity check." };
        }
        // A fixture with no items in flight would hash the same whether the
        // simulation ran or not, which is the whole thing this artifact exists to
        // detect. Refuse to write one.
        const itemsOnBelts = dump.beltPaths.reduce((total, path) => total + path.items.length, 0);
        if (itemsOnBelts === 0) {
            return { error: "No items on any belt path after warmup; the fixture would not exercise the simulation." };
        }
        return { dump, itemsOnBelts, savegameVersion: s.Savegame.getCurrentVersion() };
    });

    if (fixture.error) {
        throw new Error(fixture.error);
    }

    const target = join(REPO_ROOT, "test", "fixtures", "golden_save.json");
    writeFileSync(
        target,
        JSON.stringify({ savegameVersion: fixture.savegameVersion, dump: fixture.dump }, null, 4) + "\n"
    );
    console.log(`Wrote ${target} (${fixture.itemsOnBelts} items in flight).`);
} finally {
    await session.close();
}
```

- [ ] **Step 3: Create the fixtures directory and generate the fixture**

```bash
mkdir -p test/fixtures
```

With a dev build present (rebuild via the Task 2 Step 6 command if `build/` is stale):

```bash
node test/browser/generate_fixture.js
```

Expected: two log lines, ending with `Wrote .../test/fixtures/golden_save.json (N items in flight)` where N
is at least 1.

If it reports `Found no resource tile in the search band`, widen the `y` loop bound from `-40` to `-80` and
re-run. If it reports `Could not place belt i at ...`, the chosen patch overlaps something — narrow the `x`
search band to `[-20, 20]` and re-run.

- [ ] **Step 4: Sanity-check the fixture by eye**

```bash
node -e "const f=require('./test/fixtures/golden_save.json'); console.log({version:f.savegameVersion, entities:f.dump.entities.length, beltPaths:f.dump.beltPaths.length, items:f.dump.beltPaths.reduce((t,p)=>t+p.items.length,0), mapSeed:f.dump.map.seed, timeSeconds:f.dump.time.timeSeconds});"
```

Expected: `version: 1010`, `entities: 22` (hub + miner + 20 belts), at least one belt path, `items` ≥ 1, a
`mapSeed` integer, and a `timeSeconds` of 2 (120 ticks at 60/s).

- [ ] **Step 5: Lint and commit**

```bash
yarn lint && yarn tslint && yarn test
```

Expected: all clean.

```bash
git add test/browser/harness.js test/browser/generate_fixture.js test/fixtures/golden_save.json && git commit -m "Add determinism controls and the golden-save fixture"
```

---

### Task 6: The golden-save hash test

Two assertions, deliberately. Self-consistency catches the four determinism hazards inside one run and can be
written before any reference value exists; the pinned reference is the cross-platform, cross-time canary, in
the same spirit as `SEED_42_FIRST_5`.

**Files:**
- Create: `test/browser/golden_save.test.js`
- Create: `test/browser/dump_state.js`

**Interfaces:**
- Consumes: everything Task 5 added to the harness, plus `test/fixtures/golden_save.json`.
- Produces: `GOLDEN_SAVE_HASH` — a committed sha256 hex string; and `dump_state.js`, the tool that answers
  "what changed?" when the hash moves.

- [ ] **Step 1: Write the diagnostic tool**

A hash test that can only say "the number changed" is close to useless the day it fires. This is the tool
that says what changed. Create `test/browser/dump_state.js`:

```js
// Developer tool: run the golden-save fixture and print its hash, optionally
// writing the hashed subset out as JSON for diffing.
//
// This is the companion to the "never regenerate the reference to make CI green"
// rule. When the hash moves, this is how you find out whether the move is a real
// simulation change or a harness problem:
//
//   node test/browser/dump_state.js                  # print the hash
//   node test/browser/dump_state.js run-a.json       # print it and write the subset
//
// Two writes to different files, then `diff run-a.json run-b.json`, localises a
// nondeterminism to the exact serialized field.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    launchGame,
    waitForMainMenu,
    loadFixtureGame,
    prepareDeterministicRun,
    runTicks,
    dumpSimulationSubset,
    stableStringify,
    REPO_ROOT,
} from "./harness.js";

const TICK_COUNT = 600;
const outFile = process.argv[2];

const fixture = JSON.parse(readFileSync(join(REPO_ROOT, "test", "fixtures", "golden_save.json"), "utf8"));

const session = await launchGame();

try {
    await waitForMainMenu(session.page);
    await loadFixtureGame(session.page, fixture);
    await prepareDeterministicRun(session.page);

    const { ticksRun } = await runTicks(session.page, TICK_COUNT);
    if (ticksRun !== TICK_COUNT) {
        throw new Error(`Ran ${ticksRun} of ${TICK_COUNT} ticks; the simulation did not advance.`);
    }

    const subset = await dumpSimulationSubset(session.page);
    console.log(createHash("sha256").update(stableStringify(subset)).digest("hex"));

    if (outFile) {
        // Pretty-printed with sorted keys, so a diff of two of these lines up.
        writeFileSync(outFile, JSON.stringify(JSON.parse(stableStringify(subset)), null, 4) + "\n");
        console.error(`Wrote subset to ${outFile}`);
    }
} finally {
    await session.close();
}
```

- [ ] **Step 2: Verify the substrate is deterministic before pinning anything**

```bash
node test/browser/dump_state.js run-a.json && node test/browser/dump_state.js run-b.json
```

Expected: the two printed hashes are identical.

If they differ, **do not proceed** — a pinned reference over a nondeterministic run is worse than no test.

```bash
diff run-a.json run-b.json | head -40
```

The four known hazards, in the order worth checking against that diff:

1. **A wall-clock field is still in the subset.** Look at `time` first. `realtimeSeconds` should be absent
   entirely; if it is present, `dumpSimulationSubset`'s `delete` is not reaching it.
2. **The frame loop is not actually detached.** `time.timeSeconds` differing between runs means extra ticks
   ran outside `runTicks` — check that `app.ticker.frameEmitted.removeAll()` ran *after* the game reached
   `s10_gameRunning`, not before.
3. **The tick rate is not pinned.** `timeSeconds` differing by a non-multiple of `1/60` points here.
4. **A debug flag in `config.local.js`.** `prepareDeterministicRun` throws by name on the six that matter,
   so this shows up as an exception rather than a diff — but check `src/js/core/config.local.js` anyway if
   the diff is in entity or belt-path state.

Clean up the scratch files once resolved:

```bash
rm -f run-a.json run-b.json
```

- [ ] **Step 3: Write the self-consistency test**

Create `test/browser/golden_save.test.js`:

```js
// Stage 0 artifact 1: golden-save simulation hash.
//
// Loads a committed fixture savegame, runs a fixed number of simulation ticks,
// and hashes a defined subset of the resulting serialized state. This is what
// makes a simulation regression detectable before Stage 1 rewrites the build.
//
// The two tests do different jobs. The self-consistency test catches
// nondeterminism inside a single run — an unpinned clock, a stray frame, a
// wall-clock field leaking into the hash. The reference test catches drift
// across machines, runtimes and commits.
//
// Requires a dev build in build/. See harness.js for the exact command.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    launchGame,
    waitForMainMenu,
    loadFixtureGame,
    prepareDeterministicRun,
    runTicks,
    hashSimulationState,
    REPO_ROOT,
} from "./harness.js";

const FIXTURE = JSON.parse(readFileSync(join(REPO_ROOT, "test", "fixtures", "golden_save.json"), "utf8"));

/** 10 seconds of simulation at the pinned 60 ticks/second. */
const TICK_COUNT = 600;

/**
 * Loads the fixture in a fresh browser, ticks it, and returns the hash.
 * @param {import("node:test").TestContext} t
 * @returns {Promise<string>}
 */
async function hashAfterFixedRun(t) {
    const session = await launchGame();
    t.after(() => session.close());

    await waitForMainMenu(session.page);
    await loadFixtureGame(session.page, FIXTURE);

    const { tickRate } = await prepareDeterministicRun(session.page);
    assert.equal(tickRate, 60, "tick rate was not pinned");

    const { ticksRun } = await runTicks(session.page, TICK_COUNT);
    // game_time.js:87 zeroes the logic budget when root.hud.shouldPauseGame() is
    // true, in which case performTicks runs nothing and the test would happily
    // hash an un-ticked save. Prove the ticks happened.
    assert.equal(ticksRun, TICK_COUNT, "the simulation did not actually advance");

    assert.deepEqual(session.pageErrors, [], "uncaught exception(s) during the hash run");

    return hashSimulationState(session.page);
}

test("two identical runs produce an identical hash", async t => {
    const first = await hashAfterFixedRun(t);
    const second = await hashAfterFixedRun(t);
    assert.equal(second, first);
});
```

- [ ] **Step 4: Run it**

```bash
yarn test:browser
```

Expected: PASS, 2 tests (the smoke test plus this one). This proves the test file agrees with Step 2's
finding — the same determinism, reached through the test's own code path rather than the tool's.

- [ ] **Step 5: Capture the reference hash**

```bash
node test/browser/dump_state.js
```

Expected: a single 64-character hex string, identical to both hashes from Step 2.

- [ ] **Step 6: Pin it**

Add the constant below the `TICK_COUNT` declaration in `test/browser/golden_save.test.js`, substituting the
hash from Step 5:

```js
// Committed reference value, the same kind of canary as SEED_42_FIRST_5 in
// test/rng.determinism.test.js. Do not regenerate this to make CI pass — a change
// here means the simulation's output changed, and that is the finding.
//
// It legitimately moves when the fixture is regenerated, TICK_COUNT changes, the
// hashed subset changes, or a savegame schema bump changes serialized shape. All
// four are deliberate, reviewed edits that arrive in the same commit as the new
// value.
const GOLDEN_SAVE_HASH = "PASTE_THE_HASH_FROM_STEP_5_HERE";
```

And append the second test:

```js
test("the hash matches the committed reference", async t => {
    assert.equal(await hashAfterFixedRun(t), GOLDEN_SAVE_HASH);
});
```

- [ ] **Step 7: Run the full suite**

```bash
yarn test:browser
```

Expected: PASS, 3 tests.

```bash
yarn test && yarn lint && yarn tslint
```

Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add test/browser/golden_save.test.js test/browser/dump_state.js && git commit -m "Add Stage 0's golden-save simulation hash"
```

---

### Task 7: CI, and record what Branch B established

**Files:**
- Modify: `docs/handoff.md`
- Modify: `docs/roadmap/phase-1.md`

No `ci.yml` change is needed — `yarn test:browser` already globs `test/browser/**/*.test.js`, so the
`browser-test` job picks the new test up on its own. Confirming that is this task's first step.

- [ ] **Step 1: Push and confirm CI picks up all three tests**

```bash
git push -u origin phase-1/stage-0-golden-hash
```

```bash
gh pr create --base master --title "Stage 0: golden-save simulation hash" --body "Adds Stage 0 artifact 1 on the harness landed by the boot smoke test branch." && gh run watch
```

Expected: `browser-test` green, and its "Run browser tests" log shows `# pass 3`.

A failure of the reference assertion **here specifically, with the self-consistency test passing**, is the
interesting case: it means the hash is stable per-machine but differs between this machine and
`ubuntu-latest`. That is a genuine cross-platform determinism finding about the simulation. Record it in the
handoff rather than papering over it by adopting the CI value.

- [ ] **Step 2: Update the roadmap**

Replace the **Status** paragraph Task 4 added to `docs/roadmap/phase-1.md` with:

```markdown
**Status.** Artifacts 4 (boot smoke test) and 1 (golden-save simulation hash) landed 2026-08-12 as
`test/browser/boot.smoke.test.js` and `test/browser/golden_save.test.js`, both running against a real dev
bundle in a real browser via `test/browser/harness.js` and enforced by CI's `browser-test` job. The
substrate is specified in
[docs/superpowers/specs/2026-08-12-stage0-browser-harness-design.md](../superpowers/specs/2026-08-12-stage0-browser-harness-design.md);
artifacts 2 and 3 are expected to reuse the same harness but each needs its own spec. **Done when** is not
yet met: artifacts 2 (draw-call recording) and 3 (perf benchmark) remain outstanding.
```

Also settle the "Note — this stage validates the project's premise" paragraph one way or the other: after
Task 7 Step 1 you know whether the hash held across Windows and `ubuntu-latest`, which is exactly the
determinism claim that paragraph says needs confirming or documenting. State what was observed — it is a
finding either way, and it is only true for the fixture and tick count actually measured, so say so.

- [ ] **Step 3: Update the handoff**

In `docs/handoff.md`:

- **Empirical constraints** — append anything a run taught, especially: whether the hash matched across
  Windows and `ubuntu-latest`, the measured `browser-test` duration with all three tests, and any
  determinism hazard found in Task 6 Step 2 that the spec had not anticipated.
- **Current state** — artifacts 1 and 4 exist and run in CI; artifacts 2 and 3 remain, and both are expected
  to reuse `test/browser/harness.js` but each needs its own spec. Note the settled implementation choices the
  spec left open: 600 ticks at 60 UPS, and a fixture of a miner plus 20 belts.
- **Next step** — spec artifact 2 (draw-call recording) or 3 (perf benchmark), per the roadmap.
- **Open questions** — remove the two the spec left for implementation ("exact tick count and fixture
  composition"), now settled.
- **Also** — delete the merged local branches listed there (`phase-1/stage-0-harness`, `phase-1/stage-0-ci`,
  `phase-1/stage-0-tslint-fix`) and drop that bullet, adding the two branches from this plan once merged.
- Update `Last updated:`.

- [ ] **Step 4: Commit and merge**

```bash
git add docs/handoff.md docs/roadmap/phase-1.md && git commit -m "Record the golden-save hash landing in the handoff" && git push
```

Wait for CI green, then:

```bash
git checkout master && git merge --no-ff phase-1/stage-0-golden-hash && git push
```

---

## Notes for the implementer

**If the boot smoke test hangs, read the preloader status first.** `waitForMainMenu` surfaces it in the
failure message on purpose. `"Downloading resources"` means the atlas or sounds are missing;
`"Connecting to api"` means the request-blocking route is interfering and `launchGame({allowExternalRequests:
true})` is the diagnostic; anything else points at the step after it in `states/preload.js:98-282`.

**`window.shapez` is a flattened export map, not a namespace.** `ModLoader.exposeExports()` walks every module
under `src/js` and dumps every *named* export onto it as getter/setter pairs. So `window.shapez.Vector`,
`window.shapez.GLOBAL_APP`, `window.shapez.globalConfig`, `window.shapez.defaultBuildingVariant` and
`window.shapez.gMetaBuildingRegistry` all resolve — but nothing is namespaced, and a name collision between
two modules throws at boot. If a `window.shapez.X` lookup comes back `undefined`, check that `X` is a named
export rather than a default one.

**Everything in a `page.evaluate` callback runs in the browser, not in Node.** It cannot close over Node-side
variables; arguments must be structured-cloneable, and the return value must be too. That is why the
error-reporting pattern throughout is "return `{error}` and throw on the Node side" rather than throwing
in-page — an in-page throw surfaces as an opaque `Error: Evaluation failed`.

**Do not add test hooks to `src/js`.** The whole reason this harness targets the dev bundle is that it can
reach everything it needs through the export map that already exists. If something seems to need a hook,
that is a finding worth writing down, not a licence to add one.
