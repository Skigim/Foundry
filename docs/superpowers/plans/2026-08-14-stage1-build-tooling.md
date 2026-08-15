# Stage 1 build tooling implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Replace webpack 4 with Rspack as Foundry's JS bundler, delete the
`NODE_OPTIONS=--openssl-legacy-provider` workaround it forces, and collapse the two yarn dependency trees —
without changing what the game does.

**Architecture:** Two webpack configs (`gulp/webpack.config.js` dev, `gulp/webpack.production.config.js`
prod) are replaced by two Rspack configs of the same shape, and `gulp/js.js` stops piping through
`webpack-stream` in favour of calling `@rspack/core`'s Node API directly. Everything else in `gulp/` — the
image atlas, sound sprites, translations, CSS, HTML, electron packaging, steampipe — is untouched. The two
webpack-only plugins with no Rspack equivalent are retired *before* the swap, while webpack 4 is still there
to prove the replacement behaves identically. The one unavoidable `src/` change is the two web-worker call
sites, which today depend on `worker-loader` rewriting their imports.

**Tech Stack:** Node 22, Rspack (`@rspack/core` v1.x), gulp 4, Playwright + `node:test`, yarn 1.

## Source documents

Read these before starting. This plan does not restate their reasoning.

- [docs/superpowers/specs/2026-08-14-stage1-build-tooling-design.md](../specs/2026-08-14-stage1-build-tooling-design.md) — the design this implements
- [docs/roadmap/phase-1.md](../../roadmap/phase-1.md) — Stage 1's place in the roadmap and its "Done when"
- [docs/handoff.md](../../handoff.md) — standing decisions and empirical constraints
- [CLAUDE.md](../../../CLAUDE.md) — architecture, build commands, engine footguns

## Global Constraints

Every task's requirements implicitly include this section.

- **Work in very small, individually verifiable commits.** Every commit on the branch must be green on its
  own — `git bisect` landing inside the branch has to mean something.
- **Feature branches merge with `--no-ff`.** A single-commit branch fast-forwards instead.
- **A committed reference value is never regenerated to make CI green.** If `GOLDEN_SAVE_HASH`
  (`test/browser/golden_save.test.js:42`) moves during this stage, that is the finding — stop and report it.
  A bundler swap must not change simulation output.
- **This stage replaces the bundler, not gulp.** Image atlas generation, sound sprites, translation builds,
  electron packaging, and steampipe upload all stay exactly where they are. phase-1.md names "replace gulp
  wholesale" as the most likely way this roadmap stalls.
- **This stage does not change what gets bundled.** The three prod strip-block passes (`typehints`, `dev`,
  `wires`) carry over as-is even where one is provably inert; deciding whether a gameplay layer should still
  be strippable is Stage 4's work.
- **No TypeScript.** Rspack handling `.ts` natively is a *reason* for this ordering, not work to do now.
- **Prettier/ESLint are enforced** (`prettier/prettier: error`): 4-space indent, double quotes, semicolons,
  110 print width, `es5` trailing commas, `arrowParens: avoid`.
- **The correctness bar is `yarn lint` + `yarn tslint` + `yarn test` + `yarn test:browser` (+ from Task 5,
  `yarn test:browser:prod`).** There is no other test suite.
- **`gh` needs `--repo Skigim/Foundry`** or a one-time `gh repo set-default Skigim/Foundry`; bare `gh`
  commands target `tobspr-games/shapez.io`.
- **If a `yarn install` runs inside `gulp/`, the fluent-ffmpeg patch is destroyed.** A returning
  `Output format mp3 is not available` from `sounds.sfxOptimize` is exactly that and nothing more — reapply
  the one-character fix at `gulp/node_modules/fluent-ffmpeg/lib/capabilities.js:18` documented in
  handoff.md's Empirical constraints. Several tasks here run `yarn` in `gulp/`; expect it.

## Branch

```bash
git checkout -b phase-1/stage-1-build-tooling
```

All thirteen tasks land on this one branch, merged with `--no-ff`.

## Facts established while writing this plan

Verified against the source, not assumed. They change the design's sequencing, so read them before Task 1.

1. **`gulp/loader.strip_block.js` is dead.** Neither config references it; both use the npm
   `webpack-strip-block`. CLAUDE.md:81, docs/handoff.md:82 and docs/roadmap/phase-1.md:137 all credit the
   local file for behaviour the npm package provides. Task 1 deletes it and corrects all three.

2. **`webpack-deep-scope-plugin` and `webpack-plugin-replace` are unreferenced** — they appear in
   `gulp/package.json:64-65` *and* the root `package.json:72-73`, and in neither config. Free deletions.

3. **The `wires` strip-block pass is inert.** `wires:start` appears **zero** times under `src/`
   (`dev:start` appears 11 times across 8 files, `typehints:start` is everywhere). It is carried over
   anyway per the Global Constraints — noted so nobody spends an afternoon hunting for what it removes.

4. **The worker migration is atomic across both configs, and this is the plan's sharpest constraint.**
   `worker-loader@2` is a webpack-4-only loader, so Rspack cannot build today's
   `import CompressionWorker from "../webworkers/compression.worker"` idiom
   ([async_compression.js:2](../../../src/js/core/async_compression.js:2),
   [animation_frame.js:4](../../../src/js/core/animation_frame.js:4)). And webpack 4 cannot build the
   modern `new Worker(new URL(...))` form that replaces it. There is therefore **no commit in which one
   config is on Rspack and the other still works** — the design spec's "dev config first, production
   second" cannot be two separate commits. Task 7 moves both at once, which is why Tasks 4–6 exist: they
   strip that commit down to only what is genuinely atomic, and they build the guards it will be judged by.

5. **Both web builds load `bundle.js` from a `blob:` URL**, dev included.
   [gulp/preloader/preloader.js:148-151](../../../gulp/preloader/preloader.js) XHRs the bundle into a Blob
   and sets `script.src` to `URL.createObjectURL(blob)`. Consequence: Rspack's automatic public-path
   detection (`document.currentScript.src`) resolves to the blob URL, so a worker emitted as a separate
   chunk would be fetched from `blob:http://host/<uuid>/...` and fail. `output.publicPath` must be set
   explicitly per variant. The boot smoke test catches this immediately, which is a large part of why it
   exists.

6. **Web prod HTML cachebusts every asset to `/v/<commitHash>/…`** — `buildutils.js:44-46`, applied by
   `gulp/html.js` when `enableCachebust` is true. A test server serving `build/` verbatim 404s on those.
   Task 5 strips the prefix, which is also what the real deploy does.

7. **`waitForMainMenu` already works against a prod bundle.** It asserts `document.body.id ===
   "state_MainMenuState"` (`test/browser/harness.js:190`), a state-machine fact; only its *failure
   diagnosis* path touches `window.shapez`. Both existing callers pass no second argument, so its signature
   is free to change.

8. **`js.<variant>.prod.transpiled` is dead code.** `gulp/js.js:86-92` builds `js.<variant>.prod` from
   `gulp.parallel("js." + variant + ".prod.es6")` with the transpiled task commented out. Nothing else
   references it, and it is the only user of `es6: false` and therefore of `gulp/babel.config.js`. Task 7
   deletes the task; the `es6` parameter stays for now.

9. **CI's `setup` job can move to Node 22 today.** It pins Node 16 (`ci.yml:36`) purely so webpack 4's
   OpenSSL problem stays out of reach — but that job never builds a bundle, it runs lint, two gulp tasks,
   and tsc. `browser-test` already runs `yarn gulp build.prepare.dev` on Node 22.x successfully, which is
   direct evidence gulp 4 is fine there. Bumping it also deletes the `yarn --ignore-engines` blind spot
   handoff.md records, and is a prerequisite for installing Rspack (v1.x wants Node ≥ 16 and in practice
   ≥ 18).

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `gulp/loader.inline_globals.js` | Local loader replacing `StringReplacePlugin`'s four inline-constant substitutions |
| `gulp/rspack.config.js` | Dev bundler config (replaces `gulp/webpack.config.js`) |
| `gulp/rspack.production.config.js` | Prod bundler config (replaces `gulp/webpack.production.config.js`) |
| `test/browser/prod/boot.prod.smoke.test.js` | Boot smoke test against a **prod** bundle |
| `test/browser/worker.smoke.test.js` | Proves the compression web worker still round-trips |
| `docs/build-timings.md` | Tracked before/after build numbers — a record, not an assertion |

**Modified**

| File | Change |
| --- | --- |
| `gulp/js.js` | Drops `webpack-stream`; calls `@rspack/core`'s Node API |
| `gulp/package.json` | Bundler dependency churn |
| `package.json` | Test script split; dead root bundler deps removed; (Task 12) absorbs `gulp/`'s tree |
| `src/js/core/async_compression.js:2,40` | `new Worker(new URL(...))` |
| `src/js/core/animation_frame.js:4,22` | `new Worker(new URL(...))` |
| `src/js/globals.d.ts:212-218` | The `worker-loader?…!*` ambient module declaration goes |
| `test/browser/harness.js` | Cachebust-prefix stripping; `flavor` plumbing; prod-aware diagnostics |
| `.github/workflows/ci.yml` | Node bump, prod smoke steps, OpenSSL flag removal, (Task 12) single install |
| `.claude/dev-server.cmd` | OpenSSL flag removed (needs `git add -f`) |
| `CLAUDE.md`, `docs/handoff.md`, `docs/roadmap/phase-1.md` | Corrections and stage closure |

**Deleted**

`gulp/loader.strip_block.js`, `gulp/webpack.config.js`, `gulp/webpack.production.config.js`.

---

# Phase A — Preparation (webpack 4 still in place)

Nothing in this phase changes the bundler. Its purpose is to shrink Task 7 to only what is genuinely
atomic, and to have every guard Task 7 will be judged by already green.

---

### Task 1: Delete the dead build dependencies and the dead loader

**Files:**
- Delete: `gulp/loader.strip_block.js`
- Modify: `gulp/package.json:64-65`
- Modify: `package.json:72-73`
- Modify: `CLAUDE.md:81`
- Modify: `docs/handoff.md:82`
- Modify: `docs/roadmap/phase-1.md:137`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Pure deletion.

- [ ] **Step 1: Prove all three are unreferenced**

Run from the repo root:

```bash
grep -rn --exclude-dir=node_modules --exclude=yarn.lock -e "loader\.strip_block" -e "webpack-deep-scope-plugin" -e "webpack-plugin-replace" -e "DeepScopePlugin" .
```

Expected: hits **only** in `CLAUDE.md`, `docs/handoff.md`, `docs/roadmap/phase-1.md`,
`docs/superpowers/specs/2026-08-14-stage1-build-tooling-design.md`, this plan, `gulp/package.json`, and
`package.json`. **If any `gulp/*.js` or `src/**` file matches, stop** — the premise is wrong; report it
rather than deleting.

- [ ] **Step 2: Delete the loader file**

```bash
git rm gulp/loader.strip_block.js
```

- [ ] **Step 3: Remove the two dependencies from both trees**

In `gulp/package.json`, delete these two lines from `dependencies`:

```json
        "webpack-deep-scope-plugin": "^1.6.0",
        "webpack-plugin-replace": "^1.1.1",
```

Delete the identical two lines from the root `package.json`'s `dependencies`.

- [ ] **Step 4: Correct the three docs that credit the deleted file**

In `CLAUDE.md:81`, replace:

```
the actual webpack bundle by a custom loader (`gulp/loader.strip_block.js`) so they cost nothing at runtime.
```

with:

```
the actual bundle by the `webpack-strip-block` loader so they cost nothing at runtime.
```

In `docs/handoff.md:82`, replace `**`/* typehints:start/end */` blocks are stripped by webpack only**
(`gulp/loader.strip_block.js`); under` with `**`/* typehints:start/end */` blocks are stripped by the
bundler only** (via the `webpack-strip-block` loader); under`.

In `docs/roadmap/phase-1.md:137`, replace `the `typehints` strip-block
loader (`gulp/loader.strip_block.js`), worker loading` with `the `typehints` strip-block
loader (npm `webpack-strip-block`), worker loading`.

- [ ] **Step 5: Reinstall and confirm the build still works**

```bash
cd gulp && yarn install && cd ..
```

Reapply the fluent-ffmpeg patch if `yarn install` changed `gulp/node_modules` (Global Constraints).

- [ ] **Step 6: Full verification**

```bash
yarn lint && yarn tslint && yarn test
```

Expected: all pass. Then rebuild and run the browser tests:

```bash
cd gulp && NODE_OPTIONS=--openssl-legacy-provider yarn gulp build.prepare.dev && NODE_OPTIONS=--openssl-legacy-provider yarn gulp js.web-localhost.dev && NODE_OPTIONS=--openssl-legacy-provider yarn gulp html.web-localhost.dev && cd .. && yarn test:browser
```

On Windows PowerShell, set the variable first — it cannot be threaded through a one-liner (handoff.md):

```bash
$env:NODE_OPTIONS="--openssl-legacy-provider"; cd gulp; yarn gulp build.prepare.dev; yarn gulp js.web-localhost.dev; yarn gulp html.web-localhost.dev; cd ..; yarn test:browser
```

Expected: `# tests 3` / `# pass 3` / `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Delete unreferenced build deps and the dead strip-block loader

gulp/loader.strip_block.js was never referenced by either webpack config -
both use the npm webpack-strip-block package. Three docs credited the local
file for that behaviour; corrected. webpack-deep-scope-plugin and
webpack-plugin-replace were declared in both dependency trees and used in
neither.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Move CI's `setup` job to Node 22

**Files:**
- Modify: `.github/workflows/ci.yml:12-18` (the `env` comment block), `:32-36`, `:40-45`

**Interfaces:**
- Consumes: nothing.
- Produces: a CI lane that can install a dependency requiring Node ≥ 18 — which Rspack does.

- [ ] **Step 1: Bump the Node version and drop the engines escape hatch**

In `.github/workflows/ci.yml`, in the `setup` job, change:

```yaml
            - name: Setup Node
              uses: actions/setup-node@v2-beta
              with:
                  node-version: 16.x
```

to:

```yaml
            - name: Setup Node
              uses: actions/setup-node@v2-beta
              with:
                  node-version: 22.x
```

and change:

```yaml
            - name: Install Yarn Dependencies
              run: |
                  yarn --ignore-engines
                  cd gulp/
                  yarn
                  cd ..
```

to:

```yaml
            - name: Install Yarn Dependencies
              run: |
                  yarn
                  cd gulp/
                  yarn
                  cd ..
```

- [ ] **Step 2: Replace the now-obsolete top-level comment**

Replace the whole `env` comment block at `ci.yml:12-16` with:

```yaml
# The playwright package downloads browsers on install, and only browser-test
# needs them. Every job runs Node 22, so playwright's engines field (>=18) is
# satisfied everywhere and no --ignore-engines escape hatch is needed.
```

Leave `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: 1` in place.

- [ ] **Step 3: Push and confirm CI is green**

```bash
git add .github/workflows/ci.yml
git commit -m "Run CI's setup job on Node 22

That job pinned Node 16 only to keep webpack 4's OpenSSL problem out of
reach; it never builds a bundle - it lints, runs two gulp tasks and tsc.
browser-test already runs gulp on Node 22 successfully. Bumping it also
retires the job-wide --ignore-engines, which existed solely because
playwright requires Node >=18, and which would have silently permitted any
other Node-16-incompatible root dependency to install.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin phase-1/stage-1-build-tooling
gh run watch --repo Skigim/Foundry
```

Expected: all four jobs green. **If `yarn gulp translations.fullBuild` or `localConfig.findOrCreate` fails
on Node 22, revert this task's commit and record the failure in handoff.md's Empirical constraints** — that
would be a real, previously-unknown constraint and it changes Task 7's install strategy.

---

### Task 3: Record the pre-swap build-time baseline

**Files:**
- Create: `docs/build-timings.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/build-timings.md`, extended by Task 10 with the post-swap numbers.

The stage's entire justification is a number. Take it before it becomes unavailable.

- [ ] **Step 1: Measure the cold dev bundle build**

With `build.prepare.dev` already done (Task 1 Step 6), time the bundle step alone, three times:

```bash
cd gulp && time NODE_OPTIONS=--openssl-legacy-provider yarn gulp js.web-localhost.dev
```

PowerShell equivalent:

```bash
$env:NODE_OPTIONS="--openssl-legacy-provider"; cd gulp; Measure-Command { yarn gulp js.web-localhost.dev }
```

Record all three; report the median.

- [ ] **Step 2: Measure the incremental watch rebuild**

Start the watcher and leave it running:

```bash
cd gulp && NODE_OPTIONS=--openssl-legacy-provider yarn gulp js.web-localhost.dev.watch
```

Wait for the first build to print. Then, from a second shell, touch one mid-graph source file three times,
reading the `Time: …ms` webpack prints after each:

```bash
touch src/js/game/belt_path.js
```

PowerShell equivalent:

```bash
(Get-Item src/js/game/belt_path.js).LastWriteTime = Get-Date
```

Record all three; report the median. Stop the watcher.

- [ ] **Step 3: Measure the cold prod bundle build**

```bash
cd gulp && time NODE_OPTIONS=--openssl-legacy-provider yarn gulp js.web-shapezio.prod
```

Once is enough — this one is minutes-scale and only needs an order of magnitude.

- [ ] **Step 4: Write the record**

Create `docs/build-timings.md`:

```markdown
# Build timings

A tracked record, not a pass/fail assertion. Stage 1 (build tooling) claims a rebuild-speed win; this is
the evidence for or against it.

Numbers are machine-specific and are not comparable across rows unless the machine column matches.
Record the bundler, the machine, and the date every time.

## Method

- **Cold bundle**: `yarn gulp js.web-localhost.dev` with `build.prepare.dev` already done, median of 3.
- **Incremental**: `yarn gulp js.web-localhost.dev.watch`, then touch `src/js/game/belt_path.js` and read
  the rebuild time the bundler prints. Median of 3, first build excluded.
- **Cold prod bundle**: `yarn gulp js.web-shapezio.prod`, single run.

## Results

| date | bundler | machine | cold dev | incremental dev | cold prod |
|---|---|---|---|---|---|
| 2026-08-14 | webpack 4.43 | <fill in: OS, CPU, Node version> | <fill in>s | <fill in>ms | <fill in>s |
```

Replace every `<fill in>` with the measured value and this machine's real identity (`node -v`, OS, CPU).
**Leaving a placeholder here defeats the point of the task.**

- [ ] **Step 5: Commit**

```bash
git add docs/build-timings.md
git commit -m "Record the pre-swap build timings

Stage 1's justification is a number, and the 'before' half stops being
measurable the moment webpack 4 leaves.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Retire the two unmaintained webpack-only plugins

**Files:**
- Create: `gulp/loader.inline_globals.js`
- Modify: `gulp/webpack.production.config.js:8-9`, `:161-169`, `:208-236`
- Modify: `gulp/package.json` (remove `string-replace-webpack-plugin`, `unused-files-webpack-plugin`)
- Modify: `package.json` (remove the same two)

**Interfaces:**
- Consumes: nothing.
- Produces: `gulp/loader.inline_globals.js` exporting `module.exports = function (source) => string`, a
  standard loader used by both `gulp/webpack.production.config.js` (this task) and
  `gulp/rspack.production.config.js` (Task 7).

The design spec calls these out as having no clean Rspack replacement. Doing them here means Task 7 ports a
config that already has no unmaintained plugins in it, and any output change they cause is attributable to
*this* commit rather than lost inside the bundler swap.

- [ ] **Step 1: Write the replacement loader**

`string-replace-webpack-plugin` is used in loader position (`webpack.production.config.js:224-234`), not as
a plugin, so a plain loader is a like-for-like replacement.

Create `gulp/loader.inline_globals.js`:

```js
"use strict";

// Replaces string-replace-webpack-plugin, which is webpack-specific, at ^0.1.3,
// and long unmaintained. These four substitutions inline hot constants that are
// otherwise property lookups on globalConfig in every belt/item hot path.
//
// globalConfig.debug -> '' is deliberate and looks wrong: it turns every
// globalConfig.debug.someFlag read into ''.someFlag, which is undefined and
// therefore falsy, so the debug branches fold away under the minifier. Keep the
// semantics exactly - this is a prod-only transform and the golden-save hash is
// what proves it changed nothing.
const REPLACEMENTS = [
    { pattern: /globalConfig\.tileSize/g, replacement: "32" },
    { pattern: /globalConfig\.halfTileSize/g, replacement: "16" },
    { pattern: /globalConfig\.beltSpeedItemsPerSecond/g, replacement: "2.0" },
    { pattern: /globalConfig\.debug/g, replacement: "''" },
];

/**
 * @param {string} source
 * @returns {string}
 */
module.exports = function (source) {
    let result = source;
    for (const { pattern, replacement } of REPLACEMENTS) {
        result = result.replace(pattern, replacement);
    }
    return result;
};
```

Order matters: `globalConfig.tileSize` and `globalConfig.halfTileSize` must both be replaced before
`globalConfig.debug`'s pattern runs, and `halfTileSize` must not be shadowed by `tileSize` — it is not,
because `globalConfig.halfTileSize` does not contain the literal `globalConfig.tileSize`. The array
preserves the original plugin's ordering.

- [ ] **Step 2: Wire it into the production config and drop both plugins**

In `gulp/webpack.production.config.js`, delete these two requires (lines 8-9):

```js
const StringReplacePlugin = require("string-replace-webpack-plugin");
const UnusedFilesPlugin = require("unused-files-webpack-plugin").UnusedFilesWebpackPlugin;
```

Replace the `plugins` array (lines 161-169) with:

```js
        plugins: [new webpack.DefinePlugin(globalDefs)],
```

`UnusedFilesPlugin` is configured `failOnUnused: false`, so it cannot fail a build — it is a build-hygiene
warning, not a correctness requirement, and it is the only thing the dependency provides.

In the second `\.js$` rule, replace the `StringReplacePlugin.replace({...})` entry (lines 224-234) with:

```js
                        path.resolve(__dirname, "loader.inline_globals.js"),
```

so the rule's `use` array reads `mod.js` loader, `babel-loader`, `uglify-template-string-loader`,
`loader.inline_globals.js` — same order as before.

- [ ] **Step 3: Remove both dependencies from both trees**

Delete `"string-replace-webpack-plugin": "^0.1.3",` and `"unused-files-webpack-plugin": "^3.4.0",` from
`gulp/package.json`'s `dependencies` and from the root `package.json`'s `dependencies`.

```bash
cd gulp && yarn install && cd ..
```

Reapply the fluent-ffmpeg patch if needed.

- [ ] **Step 4: Prove the prod bundle still builds, and diff its size**

```bash
cd gulp && NODE_OPTIONS=--openssl-legacy-provider yarn gulp js.web-shapezio.prod && cd ..
ls -l build/bundle.js
```

Expected: a bundle is produced. Record its byte size — a size within a few hundred bytes of the pre-change
bundle is the expected outcome (the two removed plugins produced warnings and, for the replaced one,
identical text). **A size change of more than ~1% means the loader is not doing what the plugin did** —
stop and diff the two bundles before continuing.

- [ ] **Step 5: Re-run the dev-side guards**

The prod path has no test yet (Task 5 fixes that), so confirm nothing else regressed:

```bash
yarn lint && yarn tslint && yarn test
cd gulp && NODE_OPTIONS=--openssl-legacy-provider yarn gulp js.web-localhost.dev && NODE_OPTIONS=--openssl-legacy-provider yarn gulp html.web-localhost.dev && cd ..
yarn test:browser
```

Expected: `# pass 3` / `# fail 0`, including the golden-save hash.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Replace string-replace-webpack-plugin with a local loader; drop UnusedFilesPlugin

Both are webpack-specific and long unmaintained, with no Rspack equivalent.
Doing this under webpack 4 keeps any output change attributable to this
commit rather than hidden inside the bundler swap.

string-replace-webpack-plugin was only ever used in loader position, so
gulp/loader.inline_globals.js is a like-for-like replacement preserving the
four substitutions and their order. UnusedFilesPlugin ran with
failOnUnused: false - a hygiene warning that cannot fail a build.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Boot smoke test against a production bundle

**Files:**
- Modify: `test/browser/harness.js:29-34`, `:55-74`, `:83-119`, `:135-138`, `:188-236`
- Create: `test/browser/prod/boot.prod.smoke.test.js`
- Modify: `package.json:15` (and add `:16`)
- Modify: `.github/workflows/ci.yml` (`browser-test` job)

**Interfaces:**
- Consumes: `launchGame`, `waitForMainMenu`, `startStaticServer`, `assertBuildPresent` from
  `test/browser/harness.js`.
- Produces, from `test/browser/harness.js`:
  - `assertBuildPresent(options?: { flavor?: "dev" | "prod" }): void`
  - `launchGame(options?: { allowExternalRequests?: boolean, headless?: boolean, flavor?: "dev" | "prod" }): Promise<GameSession>`
  - `waitForMainMenu(page, options?: { timeoutMs?: number, expectDevGlobals?: boolean }): Promise<void>`

  All three keep working when called with no arguments; the two existing callers
  (`boot.smoke.test.js:19`, `golden_save.test.js:53`) pass none.

The design spec puts this inside the production migration. Pulling it forward is the same discipline
handoff.md records from Branch B — *self-consistency before pinning a reference*. A prod smoke test written
against the new bundler proves only that the new bundler agrees with itself. Written against webpack 4
first, it is a real "before" baseline, and Task 7 has to keep it green.

- [ ] **Step 1: Write the failing test**

Create `test/browser/prod/boot.prod.smoke.test.js`:

```js
// Boot smoke test, production bundle.
//
// The dev-bundle sibling (../boot.smoke.test.js) is Stage 0 artifact 4. This is
// the same assertion against a prod bundle, and it exists because the prod build
// is where Stage 1's real risk lives: three strip-block passes instead of one,
// a minifier, babel, and a bundle the preloader loads from a blob: URL rather
// than a plain <script src>.
//
// Requires a PROD build in build/. See harness.js's BUILD_COMMAND_PROD.

import { test } from "node:test";
import assert from "node:assert/strict";

import { launchGame, waitForMainMenu } from "../harness.js";

test("the prod bundle boots to the main menu with no uncaught errors", async t => {
    const session = await launchGame({ flavor: "prod" });
    t.after(() => session.close());

    await waitForMainMenu(session.page, { expectDevGlobals: false });

    await session.page.waitForSelector(".mainContainer[data-savegames]", { timeout: 10000 });

    // Prove this actually tested a prod bundle rather than a stale dev one left
    // in build/. exposeExports() is gated on G_IS_DEV || G_IS_STANDALONE
    // (mods/modloader.js:111) and webpack.production.config.js hardcodes
    // G_IS_DEV: "false", so window.shapez is the cleanest available tell.
    const hasDevGlobals = await session.page.evaluate(() => typeof window.shapez !== "undefined");
    assert.equal(hasDevGlobals, false, "window.shapez exists - build/ holds a dev bundle, not a prod one");

    if (session.consoleErrors.length > 0) {
        t.diagnostic("console.error during boot:\n" + session.consoleErrors.join("\n"));
    }

    assert.deepEqual(session.pageErrors, [], "uncaught exception(s) during boot");
});
```

- [ ] **Step 2: Run it and watch it fail for the right reason**

```bash
node --test "test/browser/prod/*.test.js"
```

Expected: FAIL. With a dev bundle still in `build/`, the failure is the `window.shapez exists` assertion —
`launchGame` does not yet accept `flavor`, and JS ignores unknown options, so it runs against whatever is
there. That is the correct pre-implementation failure.

- [ ] **Step 3: Teach the harness about prod builds**

Three edits to `test/browser/harness.js`.

(a) Replace the single `BUILD_COMMAND` constant (lines 29-34) with two:

```js
const BUILD_COMMAND_DEV = [
    "cd gulp",
    "yarn gulp build.prepare.dev",
    "yarn gulp js.web-localhost.dev",
    "yarn gulp html.web-localhost.dev",
].join(" && ");

// Reuses build.prepare.dev's assets deliberately: this stage replaces the JS
// bundler, so the prod smoke test covers the prod JS bundle, not the prod CSS
// or image pipelines. Run build.prepare.dev once, then this - it does not
// re-clean build/.
const BUILD_COMMAND_PROD = [
    "cd gulp",
    "yarn gulp build.prepare.dev",
    "yarn gulp js.web-shapezio.prod",
    "yarn gulp html.web-shapezio.prod",
].join(" && ");
```

> While webpack 4 is still in place these commands need `NODE_OPTIONS=--openssl-legacy-provider` in front
> of each `yarn gulp`. Task 8 deletes that need; leave the constants flag-free and note it in the comment,
> or prefix them now and strip the prefix in Task 8 — either is fine as long as Task 8 leaves them clean.

(b) Give `assertBuildPresent` a flavor (line 55):

```js
/**
 * Fails loudly if there is no usable build to test against.
 * @param {{ flavor?: "dev" | "prod" }} [options]
 * @returns {void}
 */
export function assertBuildPresent(options = {}) {
    const { flavor = "dev" } = options;
    const command = flavor === "prod" ? BUILD_COMMAND_PROD : BUILD_COMMAND_DEV;

    for (const file of ["index.html", "bundle.js", "main.css"]) {
        if (!existsSync(join(BUILD_DIR, file))) {
            throw new Error(`Missing build/${file}. Build the ${flavor} bundle first:\n  ${command}`);
        }
    }
```

Leave the atlas check below it untouched, and add `flavor` to `launchGame`'s options (line 135):

```js
export async function launchGame(options = {}) {
    const { allowExternalRequests = false, headless = true, flavor = "dev" } = options;

    assertBuildPresent({ flavor });
```

(c) Strip the cachebust prefix in `startStaticServer` (line 85). Web prod HTML rewrites every asset URL to
`/v/<commitHash>/…` (`gulp/buildutils.js:44-46`), which this flat file server would 404 on. Replace:

```js
        const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
```

with:

```js
        // gulp/html.js cachebusts prod asset URLs to /v/<commitHash>/<path>
        // (buildutils.js:44-46); the real deploy strips that prefix at the
        // server. Dev builds never emit it, so stripping unconditionally is
        // safe and keeps one server serving both flavors.
        const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(
            /^\/v\/[^/]+\//,
            "/"
        );
```

- [ ] **Step 4: Make `waitForMainMenu`'s diagnosis prod-aware**

Its failure path reports "this looks like a prod build, not a dev build" whenever `window.shapez` is
missing — correct advice for a dev test, actively misleading for a prod one. Change the signature (line
188) and gate that branch:

```js
/**
 * Waits for the state manager to have entered MainMenuState. It sets
 * document.body.id = "state_" + key (core/state_manager.js:88), which is a
 * state-machine fact rather than a rendering timing guess - and which holds on
 * a prod bundle too, where window.shapez does not exist.
 * @param {import("playwright").Page} page
 * @param {{ timeoutMs?: number, expectDevGlobals?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function waitForMainMenu(page, options = {}) {
    const { timeoutMs = 90000, expectDevGlobals = true } = options;
    try {
        await page.waitForFunction(() => document.body.id === "state_MainMenuState", null, {
            timeout: timeoutMs,
        });
    } catch (err) {
        const diagnosis = await page
            .evaluate(expectDev => {
                if (!window.shapez) {
                    // On a prod bundle this is expected, not a diagnosis:
                    // exposeExports() is gated on G_IS_DEV || G_IS_STANDALONE
                    // (modloader.js:111).
                    return expectDev
                        ? "window.shapez is undefined - this looks like a prod build, not a dev build."
                        : null;
                }
                const debug = window.shapez.globalConfig.debug;
                const offenders = ["fastGameEnter", "noArtificialDelays"].filter(flag => debug[flag]);
                if (offenders.length > 0) {
                    const flagList = offenders.join(", ");
                    return (
                        `globalConfig.debug has ${flagList} set (see src/js/core/config.local.js) - that ` +
                        "is why the main menu was never reached, not a preloader/atlas problem."
                    );
                }
                return null;
            }, expectDevGlobals)
            .catch(() => "(could not inspect window.shapez to diagnose further)");
```

The rest of the `catch` block (the `#ll_preload_status` read and the thrown error) is unchanged.

- [ ] **Step 5: Split the test scripts**

`test:browser`'s glob is `test/browser/**/*.test.js`, which would sweep up the new `prod/` directory and
run it against whichever bundle happens to be in `build/`. In `package.json`, replace line 15 with:

```json
        "test:browser": "node --test \"test/browser/*.test.js\"",
        "test:browser:prod": "node --test \"test/browser/prod/*.test.js\"",
```

Note `node --test` cannot take a directory argument (handoff.md); the globs are required.

- [ ] **Step 6: Build a real prod bundle and run the test**

```bash
cd gulp && NODE_OPTIONS=--openssl-legacy-provider yarn gulp js.web-shapezio.prod && NODE_OPTIONS=--openssl-legacy-provider yarn gulp html.web-shapezio.prod && cd ..
yarn test:browser:prod
```

Expected: PASS, `# tests 1` / `# pass 1`.

**If it fails on a 404 for `/v/<hash>/bundle.js`**, Step 3(c) did not take. **If it fails with an integrity
error**, `build/bundle.js` changed after `html.web-shapezio.prod` computed its hash — rebuild the HTML
after the JS, in that order.

- [ ] **Step 7: Confirm the dev tests still pass against a dev bundle**

```bash
cd gulp && NODE_OPTIONS=--openssl-legacy-provider yarn gulp js.web-localhost.dev && NODE_OPTIONS=--openssl-legacy-provider yarn gulp html.web-localhost.dev && cd ..
yarn test:browser
```

Expected: `# pass 3` / `# fail 0`, and the `prod/` test is *not* among them.

- [ ] **Step 8: Wire it into CI**

In `.github/workflows/ci.yml`'s `browser-test` job, after the existing `Run browser tests` step, append:

```yaml
            # The prod bundle is where Stage 1's risk lives: three strip-block
            # passes, a minifier, babel, and a blob:-URL script load. Built after
            # the dev tests so both flavors get exercised from one asset build -
            # this overwrites build/bundle.js and build/index.html on purpose.
            - name: Build prod bundle
              working-directory: gulp
              env:
                  NODE_OPTIONS: --openssl-legacy-provider
              run: |
                  yarn gulp js.web-shapezio.prod
                  yarn gulp html.web-shapezio.prod

            - name: Verify the prod bundle actually built
              run: |
                  test -f build/index.html
                  test -f build/bundle.js
                  grep -q "/v/" build/index.html

            - name: Run prod browser tests
              run: yarn test:browser:prod
```

Also extend the existing `Verify the browser tests exist` step with:

```yaml
                  test -f test/browser/prod/boot.prod.smoke.test.js
```

- [ ] **Step 9: Commit and confirm CI**

```bash
git add -A
git commit -m "Add a boot smoke test for the production bundle

Written against webpack 4 deliberately, before the bundler swap, so it is a
real before/after guard rather than the new bundler agreeing with itself.

The harness needed three changes: a build flavor so the 'missing build'
message names the right command, cachebust-prefix stripping in the static
server (prod HTML rewrites every asset to /v/<commitHash>/...), and an
expectDevGlobals flag so waitForMainMenu stops reporting a missing
window.shapez as a diagnosis on a build where its absence is expected.

test:browser's glob narrowed to test/browser/*.test.js so the prod test does
not run against whichever bundle happens to be in build/.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
gh run watch --repo Skigim/Foundry
```

Expected: all four jobs green, `browser-test` now reporting three dev tests and one prod test. Record the
job's new duration — the previous figure is 2m55s.

---

### Task 6: Smoke test the compression web worker

**Files:**
- Create: `test/browser/worker.smoke.test.js`
- Modify: `.github/workflows/ci.yml` (`Verify the browser tests exist` step)

**Interfaces:**
- Consumes: `launchGame`, `waitForMainMenu` from `test/browser/harness.js`.
- Produces: nothing other tasks import.

Task 7 rewrites how workers are loaded and hands their URL resolution to `output.publicPath` on a bundle
served from a `blob:` URL. A boot smoke test will not catch a broken worker: `AnimationFrame`'s background
worker failure is caught and logged (`animation_frame.js:23-25`), and the compression worker is not touched
until a save happens. This test makes that failure loud, and it is written now so it is green *before* the
thing it guards changes.

- [ ] **Step 1: Write the failing test**

Create `test/browser/worker.smoke.test.js`:

```js
// Web-worker smoke test.
//
// src/js/core/async_compression.js runs savegame compression on a worker. How
// that worker is loaded is bundler-specific, and Stage 1 changes it: from
// worker-loader's inlined blob to a separate chunk resolved through
// output.publicPath. Neither the boot smoke test nor the golden-save hash would
// notice it breaking - the boot path never posts a compression job, and
// AnimationFrame swallows its own worker's errors (animation_frame.js:23-25).
//
// Requires a dev build in build/ (window.shapez is dev-only).

import { test } from "node:test";
import assert from "node:assert/strict";

import { launchGame, waitForMainMenu } from "./harness.js";

test("the compression worker round-trips a job", async t => {
    const session = await launchGame();
    t.after(() => session.close());

    await waitForMainMenu(session.page);

    const result = await session.page.evaluate(async () => {
        const compressed = await window.shapez.asyncCompressor.compressObjectAsync({
            hello: "world",
            nested: [1, 2, 3],
        });
        return { type: typeof compressed, length: compressed ? compressed.length : 0 };
    });

    assert.equal(result.type, "string", "compressObjectAsync did not resolve to a string");
    assert.ok(result.length > 0, "compressObjectAsync resolved to an empty string");

    assert.deepEqual(session.pageErrors, [], "uncaught exception(s) during the worker round-trip");
});
```

The assertion is deliberately shape-only, not a fixed compressed string: the compressed output embeds a CRC
over a salt derived from `globalConfig` (`compression.worker.js:14`), and pinning it would make this test
move on unrelated config edits. Resolving at all is what proves the worker loaded, received a message, and
posted back.

- [ ] **Step 2: Run it against the current dev bundle**

Ensure `build/` holds a dev bundle (Task 5 Step 7 leaves one there), then:

```bash
node --test "test/browser/worker.smoke.test.js"
```

Expected: PASS. **If it hangs and times out, the worker never replied** — under webpack 4 with
`worker-loader inline: true` it should reply immediately, so a hang here means something else is wrong and
must be understood before Task 7 changes the loading mechanism.

- [ ] **Step 3: Confirm it runs as part of the dev suite**

```bash
yarn test:browser
```

Expected: `# tests 4` / `# pass 4` / `# fail 0`.

- [ ] **Step 4: Add it to CI's existence check**

In `.github/workflows/ci.yml`, extend `Verify the browser tests exist`:

```yaml
                  test -f test/browser/worker.smoke.test.js
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Smoke test the compression web worker

Stage 1 changes how workers are loaded - from worker-loader's inlined blob
to a separate chunk resolved through output.publicPath, on a bundle the
preloader itself loads from a blob: URL. Nothing existing would catch that
breaking: the boot path never posts a compression job, and AnimationFrame
catches its own worker's errors. Landed green under webpack 4 first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

---

# Phase B — The swap

---

### Task 7: Replace webpack with Rspack across both configs

**Files:**
- Create: `gulp/rspack.config.js`
- Create: `gulp/rspack.production.config.js`
- Delete: `gulp/webpack.config.js`, `gulp/webpack.production.config.js`
- Modify: `gulp/js.js` (entire file)
- Modify: `gulp/package.json`
- Modify: `src/js/core/async_compression.js:1-2`, `:40`
- Modify: `src/js/core/animation_frame.js:3-4`, `:22`
- Modify: `src/js/globals.d.ts:212-218`

**Interfaces:**
- Consumes: `gulp/loader.inline_globals.js` (Task 4), `gulp/loader.compressjson.js`, `gulp/mod.js`,
  `gulp/buildutils.js`'s `getRevision` / `getVersion` / `getAllResourceImages`, `gulp/build_variants.js`'s
  `BUILD_VARIANTS`.
- Produces:
  - `gulp/rspack.config.js`: `module.exports = ({ standalone?, chineseVersion?, wegameVersion?, steamDemo?, gogVersion? }) => RspackConfig` — note the `watch` parameter is **gone**; watching is the caller's job now.
  - `gulp/rspack.production.config.js`: `module.exports = ({ environment, es6?, standalone?, isBrowser?, chineseVersion?, wegameVersion?, steamDemo?, gogVersion? }) => RspackConfig`
  - `gulp/js.js`: unchanged public surface — the same `js.<variant>.dev`, `js.<variant>.dev.watch`, and
    `js.<variant>.prod` task names gulpfile.js already depends on.

**This is the plan's one large commit, and it is large by necessity.** See "Facts established" #4: there is
no intermediate state in which one config is on Rspack and the other still builds. Do not try to split it
into "dev first, prod second" — that produces a knowingly-broken prod build, and Task 5 just made that a
red test.

- [ ] **Step 1: Read CE's Rspack config first**

The design spec calls CE's migration "the single most directly useful thing to read from CE." Read
[shapez-community-edition PR #119](https://github.com/tobspr-games/shapez-community-edition/pull/119)
before writing either config, specifically for: how they handled `worker-loader`, whether they kept
`circular-dependency-plugin`, what they did with the minifier, and whether they set `output.publicPath`.

**Reimplement, do not merge** — Foundry is a hard fork and CE's tree has diverged. Where CE solved a
problem differently from the configs below, note the difference and say in Task 7's commit message which
approach you took and why. Where the configs below already match CE, that is corroboration worth recording.

- [ ] **Step 2: Install Rspack and pin the resolved version**

```bash
cd gulp && yarn add @rspack/core && cd ..
```

Record the exact resolved version from `gulp/package.json` — the plan says v1.x, the commit message should
say which v1.x. Reapply the fluent-ffmpeg patch afterwards.

- [ ] **Step 3: Migrate the two worker call sites**

In `src/js/core/async_compression.js`, replace lines 1-2:

```js
// @ts-ignore
import CompressionWorker from "../webworkers/compression.worker";
```

with nothing (delete both lines), and replace line 40:

```js
        this.worker = new CompressionWorker();
```

with:

```js
        // Rspack/webpack 5 recognise this exact literal form and emit the worker
        // as its own chunk. The URL must be a literal - a variable defeats the
        // static analysis and the worker silently does not get bundled.
        this.worker = new Worker(new URL("../webworkers/compression.worker.js", import.meta.url));
```

In `src/js/core/animation_frame.js`, delete lines 3-4:

```js
// @ts-ignore
import BackgroundAnimationFrameEmitterWorker from "../webworkers/background_animation_frame_emittter.worker";
```

and replace line 22:

```js
        this.backgroundWorker = new BackgroundAnimationFrameEmitterWorker();
```

with:

```js
        this.backgroundWorker = new Worker(
            new URL("../webworkers/background_animation_frame_emittter.worker.js", import.meta.url)
        );
```

(Note the filename's doubled `tt` — `background_animation_frame_emittter.worker.js` — is the real spelling.)

In `src/js/globals.d.ts`, delete the whole ambient declaration at lines 212-218:

```ts
declare module "worker-loader?inline=true&fallback=false!*" {
    class WebpackWorker extends Worker {
        constructor();
    }

    export default WebpackWorker;
}
```

It described worker-loader's default export, which no longer exists. `new Worker(...)` is in lib.dom.

- [ ] **Step 4: Write the dev Rspack config**

Create `gulp/rspack.config.js`:

```js
// @ts-nocheck

const path = require("path");
const rspack = require("@rspack/core");
const { getRevision, getVersion, getAllResourceImages } = require("./buildutils");

module.exports = ({
    standalone = false,
    chineseVersion = false,
    wegameVersion = false,
    steamDemo = false,
    gogVersion = false,
}) => {
    return {
        mode: "development",
        devtool: "cheap-source-map",
        entry: {
            "bundle.js": [path.resolve(__dirname, "../src/js/main.js")],
        },
        resolve: {
            alias: {
                "global-compression": path.resolve(__dirname, "..", "src", "js", "core", "lzstring.js"),
            },
            // webpack 4's node: { fs: "empty" }.
            fallback: {
                fs: false,
            },
        },
        context: path.resolve(__dirname, ".."),
        plugins: [
            new rspack.DefinePlugin({
                assert: "window.assert",
                assertAlways: "window.assert",
                abstract:
                    "window.assert(false, 'abstract method called of: ' + (this.name || (this.constructor && this.constructor.name)));",
                G_HAVE_ASSERT: "true",
                G_APP_ENVIRONMENT: JSON.stringify("dev"),
                G_CHINA_VERSION: JSON.stringify(chineseVersion),
                G_WEGAME_VERSION: JSON.stringify(wegameVersion),
                G_GOG_VERSION: JSON.stringify(gogVersion),
                G_IS_DEV: "true",
                G_IS_RELEASE: "false",
                G_IS_BROWSER: "true",
                G_IS_STANDALONE: JSON.stringify(standalone),
                G_IS_STEAM_DEMO: JSON.stringify(steamDemo),
                G_BUILD_TIME: "" + new Date().getTime(),
                G_BUILD_COMMIT_HASH: JSON.stringify(getRevision()),
                G_BUILD_VERSION: JSON.stringify(getVersion()),
                G_ALL_UI_IMAGES: JSON.stringify(getAllResourceImages()),
            }),
        ],
        module: {
            rules: [
                {
                    test: /\.json$/,
                    enforce: "pre",
                    use: [path.resolve(__dirname, "loader.compressjson.js")],
                    type: "javascript/auto",
                },
                { test: /\.(png|jpe?g|svg)$/, loader: "ignore-loader" },
                { test: /\.nobuild/, loader: "ignore-loader" },
                {
                    test: /\.md$/,
                    use: [{ loader: "html-loader" }, "markdown-loader"],
                },
                {
                    test: /\.js$/,
                    enforce: "pre",
                    exclude: /node_modules/,
                    use: [
                        {
                            loader: "webpack-strip-block",
                            options: {
                                start: "typehints:start",
                                end: "typehints:end",
                            },
                        },
                        {
                            loader: path.resolve(__dirname, "mod.js"),
                        },
                    ],
                },
                {
                    test: /\.ya?ml$/,
                    type: "json",
                    use: "yaml-loader",
                },
            ],
        },
        output: {
            filename: "bundle.js",
            path: path.resolve(__dirname, "..", "build"),
            // Must be explicit. gulp/preloader/preloader.js XHRs bundle.js into a
            // Blob and loads it from a blob: URL, so automatic public-path
            // detection (document.currentScript.src) resolves to blob:... and the
            // emitted worker chunk would be fetched from a nonexistent origin.
            // Standalone/electron includes bundle.js with a plain <script src>
            // from a file:// document, where a relative path is correct.
            publicPath: standalone ? "" : "/",
        },
    };
};
```

Three deliberate differences from the webpack config, each with a reason:

- **The `worker-loader` rule is gone.** Rspack recognises `new Worker(new URL(...))` natively.
- **`CircularDependencyPlugin` is gone.** It hooks `compilation.hooks.optimizeModules`, a webpack-internal
  hook Rspack does not implement. Step 5 decides whether it comes back.
- **`node: { fs: "empty" }` became `resolve.fallback: { fs: false }`** — the webpack-4 form the design spec
  flagged.

Two rules carried over verbatim that deserve a second look while the build is in front of you:

- **The yaml rule keeps `type: "json"`.** The design spec flags the config's own comment ("Required by
  Webpack v4") as webpack-4-specific syntax. It is not: `type: "json"` paired with `yaml-loader` is also
  the correct webpack-5/Rspack form, so the rule is unchanged and only the misleading comment is dropped.
  Nothing under `src/js` imports a `.yaml` file directly — translations arrive as generated JSON via
  `src/js/built-temp/` — so this rule is very likely inert either way. Carried over rather than deleted
  because proving a rule inert costs more than keeping it.
- **`.md`, `.nobuild`, and the image `ignore-loader` rules** likewise have no importers findable under
  `src/js`. Same reasoning: carried over, not deleted. Deleting build rules is not this stage's job.

- [ ] **Step 5: Decide the circular-dependency check, explicitly**

`CircularDependencyPlugin` ran with `failOnError: true`, so it was a real guard, not a warning. Try the
existing plugin first:

```bash
cd gulp && node -e "const P=require('circular-dependency-plugin'); console.log(typeof P)" && cd ..
```

Then add it back to `gulp/rspack.config.js`'s `plugins` array exactly as it appears in
`gulp/webpack.config.js:54-67` and run Step 10's dev build.

- **If the build succeeds**, keep it and say so in the commit message.
- **If it throws** (expected — `compilation.hooks.optimizeModules` is not part of Rspack's plugin API),
  remove it and add this to `docs/handoff.md`'s **Open questions** section:

  ```markdown
  - **The circular-import guard was dropped in the Rspack swap and has no replacement.**
    `gulp/webpack.config.js` ran `circular-dependency-plugin` with `failOnError: true`, so a new import
    cycle in `src/js` failed the dev build. The plugin hooks `compilation.hooks.optimizeModules`, which
    Rspack does not implement, so it did not survive Stage 1. Nothing currently detects a new cycle.
    Options: an Rspack-native equivalent if one exists, `madge --circular src/js` as a CI step, or accept
    the gap. Deliberately not bundled into the bundler swap.
  ```

  Do not silently drop it.

- [ ] **Step 6: Write the production Rspack config**

Create `gulp/rspack.production.config.js`. It is `gulp/webpack.production.config.js` with the same
`globalDefs`, `optimization` intent, and rule order — with these changes:

```js
// @ts-nocheck

const path = require("path");
const rspack = require("@rspack/core");
const { getRevision, getVersion, getAllResourceImages } = require("./buildutils");

const TerserPlugin = require("terser-webpack-plugin");

module.exports = ({
    environment,
    es6 = false,

    standalone = false,
    isBrowser = true,

    chineseVersion = false,
    wegameVersion = false,
    steamDemo = false,
    gogVersion = false,
}) => {
    const globalDefs = {
        assert: "false && window.assert",
        assertAlways: "window.assert",
        abstract: "window.assert(false, 'abstract method called');",
        G_IS_DEV: "false",

        G_CHINA_VERSION: JSON.stringify(chineseVersion),
        G_WEGAME_VERSION: JSON.stringify(wegameVersion),
        G_GOG_VERSION: JSON.stringify(gogVersion),
        G_IS_RELEASE: environment === "prod" ? "true" : "false",
        G_IS_STANDALONE: standalone ? "true" : "false",
        G_IS_STEAM_DEMO: JSON.stringify(steamDemo),
        G_IS_BROWSER: isBrowser ? "true" : "false",
        G_APP_ENVIRONMENT: JSON.stringify(environment),
        G_HAVE_ASSERT: "false",
        G_BUILD_TIME: "" + new Date().getTime(),
        G_BUILD_COMMIT_HASH: JSON.stringify(getRevision()),
        G_BUILD_VERSION: JSON.stringify(getVersion()),
        G_ALL_UI_IMAGES: JSON.stringify(getAllResourceImages()),
    };

    const minifyNames = false;

    return {
        mode: "production",
        entry: {
            "bundle.js": [path.resolve(__dirname, "..", "src", "js", "main.js")],
        },
        output: {
            filename: "bundle.js",
            path: path.resolve(__dirname, "..", "build"),
            // See the dev config: the preloader loads bundle.js from a blob: URL,
            // so worker chunk URLs cannot be auto-detected. Web prod additionally
            // cachebusts every asset to /v/<commitHash>/ (gulp/html.js via
            // buildutils.cachebust), so the worker chunk must be requested from
            // the same prefix.
            publicPath: standalone ? "" : "/v/" + getRevision() + "/",
        },
        context: path.resolve(__dirname, ".."),
        devtool: false,
        resolve: {
            alias: {
                "global-compression": path.resolve(__dirname, "..", "src", "js", "core", "lzstring.js"),
            },
            fallback: {
                fs: false,
            },
        },
        optimization: {
            minimize: true,
            emitOnErrors: false,
            removeAvailableModules: true,
            removeEmptyChunks: true,
            mergeDuplicateChunks: true,
            providedExports: true,
            usedExports: true,
            concatenateModules: true,
            sideEffects: true,

            minimizer: [
                new TerserPlugin({
                    parallel: true,
                    terserOptions: {
                        ecma: es6 ? 6 : 5,
                        parse: {},
                        module: true,
                        toplevel: true,
                        keep_classnames: !minifyNames,
                        keep_fnames: !minifyNames,
                        safari10: true,
                        compress: {
                            arguments: false, // breaks
                            drop_console: false,
                            global_defs: globalDefs,
                            keep_fargs: !minifyNames,
                            keep_infinity: true,
                            passes: 2,
                            module: true,
                            pure_funcs: [
                                "Math.radians",
                                "Math.degrees",
                                "Math.round",
                                "Math.ceil",
                                "Math.floor",
                                "Math.sqrt",
                                "Math.hypot",
                                "Math.abs",
                                "Math.max",
                                "Math.min",
                                "Math.sin",
                                "Math.cos",
                                "Math.tan",
                                "Math.sign",
                                "Math.pow",
                                "Math.atan2",
                            ],
                            toplevel: true,
                            unsafe_math: true,
                            unsafe_arrows: false,
                        },
                        mangle: {
                            reserved: ["__$S__"],
                            eval: true,
                            keep_classnames: !minifyNames,
                            keep_fnames: !minifyNames,
                            module: true,
                            toplevel: true,
                            safari10: true,
                        },
                        format: {
                            comments: false,
                            ascii_only: true,
                            beautify: false,
                            braces: false,
                            ecma: es6 ? 6 : 5,
                            preamble:
                                "/* Foundry (shapez.io fork) - " +
                                getVersion() +
                                " @ " +
                                getRevision() +
                                " */",
                        },
                    },
                }),
            ],
        },
        plugins: [new rspack.DefinePlugin(globalDefs)],
        module: {
            rules: [
                {
                    test: /\.json$/,
                    enforce: "pre",
                    use: [path.resolve(__dirname, "loader.compressjson.js")],
                    type: "javascript/auto",
                },
                { test: /\.(png|jpe?g|svg)$/, loader: "ignore-loader" },
                { test: /\.nobuild/, loader: "ignore-loader" },
                {
                    test: /\.js$/,
                    enforce: "pre",
                    exclude: /node_modules/,
                    use: [
                        {
                            loader: "webpack-strip-block",
                            options: { start: "typehints:start", end: "typehints:end" },
                        },
                        {
                            loader: "webpack-strip-block",
                            options: { start: "dev:start", end: "dev:end" },
                        },
                        {
                            loader: "webpack-strip-block",
                            options: { start: "wires:start", end: "wires:end" },
                        },
                    ],
                },
                {
                    test: /\.js$/,
                    use: [
                        {
                            loader: path.resolve(__dirname, "mod.js"),
                        },
                        {
                            loader: "babel-loader?cacheDirectory",
                            options: {
                                configFile: require.resolve(
                                    es6 ? "./babel-es6.config.js" : "./babel.config.js"
                                ),
                            },
                        },
                        "uglify-template-string-loader",
                        path.resolve(__dirname, "loader.inline_globals.js"),
                    ],
                },
                {
                    test: /\.md$/,
                    use: ["html-loader", "markdown-loader"],
                },
                {
                    test: /\.ya?ml$/,
                    type: "json",
                    use: "yaml-loader",
                },
            ],
        },
    };
};
```

What changed and why, so a reviewer can check each line:

| dropped / changed | reason |
| --- | --- |
| `node: { fs: "empty" }` → `resolve.fallback: { fs: false }` | webpack-4 syntax |
| `optimization.noEmitOnErrors` → `emitOnErrors: false` | renamed in webpack 5 / Rspack |
| `optimization.occurrenceOrder` | removed in webpack 5; split into `chunkIds`/`moduleIds` defaults |
| `stats: { maxModules, optimizationBailout }` | `maxModules` is a webpack-4 stats option; `gulp/js.js` prints its own stats now |
| `performance: { maxEntrypointSize, maxAssetSize }` | only ever suppressed a size warning |
| `terserOptions.output` → `terserOptions.format` | `output` is the deprecated alias |
| `TerserPlugin`'s `sourceMap: false` / `cache: false` | removed in terser-webpack-plugin 5 (`devtool: false` already disables maps; caching is the bundler's) |
| `compress.warnings` | removed in terser 5 |
| the `worker-loader` rule | replaced by `new Worker(new URL(...))` |
| the `\.worker\.js$` babel rule | the worker chunk goes through the general `\.js$` rule now |
| Terser preamble text | it claimed "shapez.io Codebase - Copyright 2022 tobspr Games"; Foundry is a hard fork with its own identity. Cosmetic, and the only place in this task where behaviour intentionally differs |

`terser-webpack-plugin` is kept at its current major deliberately — see Step 7. Keeping Terser with
byte-identical options means any prod output difference is attributable to Rspack's module graph, not to a
different minifier. Task 11 swaps it, measured, afterwards.

- [ ] **Step 7: Resolve the minifier, explicitly**

```bash
cd gulp && yarn add terser-webpack-plugin@^5 && cd ..
```

(v1 is webpack-4-era; v5 is the webpack-5-API release.) Then run Step 11's prod build.

- **If it builds**, keep the config above.
- **If Rspack rejects `terser-webpack-plugin`**, replace the whole `minimizer` array with Rspack's built-in
  SWC minimizer, mapping the same options:

  ```js
            minimizer: [
                new rspack.SwcJsMinimizerRspackPlugin({
                    minimizerOptions: {
                        compress: {
                            arguments: false,
                            drop_console: false,
                            global_defs: globalDefs,
                            keep_infinity: true,
                            passes: 2,
                            pure_funcs: [
                                "Math.radians",
                                "Math.degrees",
                                "Math.round",
                                "Math.ceil",
                                "Math.floor",
                                "Math.sqrt",
                                "Math.hypot",
                                "Math.abs",
                                "Math.max",
                                "Math.min",
                                "Math.sin",
                                "Math.cos",
                                "Math.tan",
                                "Math.sign",
                                "Math.pow",
                                "Math.atan2",
                            ],
                            toplevel: true,
                            unsafe_math: true,
                            unsafe_arrows: false,
                            keep_classnames: !minifyNames,
                            keep_fnames: !minifyNames,
                        },
                        mangle: {
                            reserved: ["__$S__"],
                            eval: true,
                            keep_classnames: !minifyNames,
                            keep_fnames: !minifyNames,
                            toplevel: true,
                            safari10: true,
                        },
                        format: {
                            comments: false,
                            ascii_only: true,
                            preamble:
                                "/* Foundry (shapez.io fork) - " +
                                getVersion() +
                                " @ " +
                                getRevision() +
                                " */",
                        },
                    },
                }),
            ],
  ```

  and remove the `terser-webpack-plugin` require and dependency. `keep_fargs` has no SWC equivalent; note
  its loss in the commit message and treat any prod behaviour change as a suspect for it. If this branch is
  taken, **skip Task 11** — it is already done.

- [ ] **Step 8: Rewrite `gulp/js.js` against Rspack's Node API**

`webpack-stream` wraps webpack specifically. Rspack writes to `output.path` itself, so the
`gulp.src(...).pipe(...).pipe(gulp.dest(...))` shape has nothing left to do. Replace the whole file:

```js
const { rspack } = require("@rspack/core");
const { BUILD_VARIANTS } = require("./build_variants");

function requireUncached(module) {
    delete require.cache[require.resolve(module)];
    return require(module);
}

const STATS_OPTIONS = {
    preset: "errors-warnings",
    colors: true,
    timings: true,
};

/**
 * Runs a single Rspack build to completion.
 * @param {object} config
 * @returns {Promise<void>}
 */
function runRspack(config) {
    return new Promise((resolve, reject) => {
        rspack(config, (err, stats) => {
            if (err) {
                reject(err);
                return;
            }
            console.log(stats.toString(STATS_OPTIONS));
            if (stats.hasErrors()) {
                reject(new Error("Bundle failed to build"));
                return;
            }
            resolve();
        });
    });
}

/**
 * Starts a watching Rspack build. Resolves after the FIRST successful build and
 * keeps rebuilding after that - gulpfile.js's serveHTML fires this task and
 * discards its callback, so resolving early lets the serve task finish while
 * the watcher keeps running.
 * @param {object} config
 * @param {object} browserSync
 * @returns {Promise<void>}
 */
function watchRspack(config, browserSync) {
    return new Promise(resolveFirstBuild => {
        let resolved = false;
        const compiler = rspack(config);

        compiler.watch({}, (err, stats) => {
            if (err) {
                console.error(err);
            } else {
                console.log(stats.toString(STATS_OPTIONS));
                if (!stats.hasErrors()) {
                    browserSync.reload();
                }
            }
            if (!resolved) {
                resolved = true;
                resolveFirstBuild();
            }
        });
    });
}

/**
 * PROVIDES (per <variant>)
 *
 * js.<variant>.dev.watch
 * js.<variant>.dev
 * js.<variant>.prod
 *
 */

function gulptasksJS($, gulp, buildFolder, browserSync) {
    for (const variant in BUILD_VARIANTS) {
        const data = BUILD_VARIANTS[variant];

        gulp.task("js." + variant + ".dev.watch", () =>
            watchRspack(
                requireUncached("./rspack.config.js")({
                    ...data.buildArgs,
                    standalone: data.standalone,
                }),
                browserSync
            )
        );

        gulp.task("js." + variant + ".dev", () =>
            runRspack(
                requireUncached("./rspack.config.js")({
                    ...data.buildArgs,
                    standalone: data.standalone,
                })
            )
        );

        if (!data.standalone) {
            // WEB
            gulp.task("js." + variant + ".prod.es6", () =>
                runRspack(
                    requireUncached("./rspack.production.config.js")({
                        es6: true,
                        environment: data.environment,
                        ...data.buildArgs,
                    })
                )
            );
            gulp.task("js." + variant + ".prod", gulp.parallel("js." + variant + ".prod.es6"));
        } else {
            // STANDALONE
            gulp.task("js." + variant + ".prod", () =>
                runRspack(
                    requireUncached("./rspack.production.config.js")({
                        ...data.buildArgs,
                        environment: "prod",
                        es6: true,
                        standalone: true,
                    })
                )
            );
        }
    }
}

module.exports = {
    gulptasksJS,
};
```

Two behaviour notes for the reviewer:

- The old file had two near-identical `js.<variant>.dev` task bodies, differing only in whether
  `standalone` came from `data.standalone` or a hardcoded `true`. Those are the same value. Merged.
- `js.<variant>.prod.transpiled` is deleted: `gulp/js.js:86-92` already excluded it from
  `js.<variant>.prod` with the comment "transpiled currently not used", and nothing else referenced it. It
  was the only caller passing `es6: false`. The parameter stays so `babel.config.js` and the `ecma` mapping
  keep working, but note in the commit that no build path now sets it.

- [ ] **Step 9: Remove the dead bundler dependencies from `gulp/package.json`**

Delete from `dependencies`: `"webpack": "^4.43.0"`, `"webpack-cli": "^3.1.0"`, `"worker-loader": "^2.0.0"`.
Delete from `devDependencies`: `"webpack-stream": "^5.2.1"`.

Keep `webpack-strip-block`, `babel-loader`, `html-loader`, `ignore-loader`, `markdown-loader`,
`yaml-loader`, `uglify-template-string-loader` — all are loaders Rspack still runs.

```bash
cd gulp && yarn install && cd ..
```

Reapply the fluent-ffmpeg patch. Then delete the old configs:

```bash
git rm gulp/webpack.config.js gulp/webpack.production.config.js
```

- [ ] **Step 10: Build the dev bundle and run every dev guard**

The OpenSSL flag is no longer needed, which is the point — but leave it in the CI file and
`dev-server.cmd` until Task 8, so this commit changes one thing.

```bash
cd gulp && yarn gulp build.prepare.dev && yarn gulp js.web-localhost.dev && yarn gulp html.web-localhost.dev && cd ..
yarn lint && yarn tslint && yarn test && yarn test:browser
```

Expected: `# tests 4` / `# pass 4` / `# fail 0` from `test:browser`.

The four failures worth recognising on sight:

| symptom | cause |
| --- | --- |
| Boot smoke test times out at "Downloading resources" | atlas missing — `build.prepare.dev` did not run, or `imgres.buildAtlas` failed silently |
| Worker smoke test hangs | `output.publicPath` wrong; check the Network panel for a `blob:` worker URL |
| `GOLDEN_SAVE_HASH` mismatch | **stop.** A bundler swap must not change simulation output. Do not regenerate the hash. Use `test/browser/dump_state.js` to find *what* moved and report it |
| `Cannot find module './webpack.config.js'` | a leftover `requireUncached` path in `gulp/js.js` |

Passing `test:browser` at all is also the check on `require.context`, which the design spec lists under
"mechanical, low risk" but which nothing else in this plan asserts directly. Every one of these tests
reaches the game through `window.shapez`, which exists only because `mods/modloader.js:114` calls
`require.context("../", true, /\.js$/)` and the bundler resolves it statically — and
`game/component_registry.js:56` uses the same API for its count assertion, which a dev build runs. If
Rspack did not implement `require.context`, the boot smoke test would fail outright rather than subtly.

- [ ] **Step 11: Build the prod bundle and run the prod guard**

```bash
cd gulp && yarn gulp js.web-shapezio.prod && yarn gulp html.web-shapezio.prod && cd ..
yarn test:browser:prod
ls -l build/*.js
```

Expected: `# pass 1`. `ls` should now show `bundle.js` **plus** one or two emitted worker chunks — that is
the expected consequence of dropping `worker-loader`'s inlining, and those files ship.

Record `bundle.js`'s byte size against Task 4 Step 4's figure. A difference of a few percent is normal
across bundlers; a difference of tens of percent means something is being included or dropped that should
not be, and needs explaining before this lands.

- [ ] **Step 12: Prove the worker chunks are actually reachable in prod**

The prod smoke test boots the game but does not compress anything, and `worker.smoke.test.js` needs
`window.shapez`, so neither covers the prod worker URL. Check it directly:

```bash
grep -o "/v/[a-f0-9]*/" build/bundle.js | head -5
```

Expected: the public path appears in the bundle, matching `git rev-parse HEAD`'s short form as
`buildutils.getRevision()` produces it. **If instead you see a bare chunk name with no prefix, the
`publicPath` is not being applied to worker URLs** — set `output.workerPublicPath` to the same value as
`output.publicPath` and rebuild.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "Replace webpack 4 with Rspack for both bundler configs

One commit by necessity, not by preference. worker-loader@2 is a webpack-4
loader, so Rspack cannot build the current 'import X from ./y.worker' idiom;
webpack 4 cannot build the 'new Worker(new URL(...))' form that replaces it.
There is no intermediate commit where one config is on Rspack and the other
still works, so dev and prod move together. Tasks 4-6 exist to keep this
commit down to only what is genuinely atomic.

Both configs are faithful ports: same DefinePlugin constants, same loader
order, same three prod strip-block passes, same Terser options. The
webpack-4-only syntax is updated (node.fs -> resolve.fallback,
noEmitOnErrors -> emitOnErrors, terserOptions.output -> .format), the dead
occurrenceOrder/stats/performance keys are dropped, and output.publicPath is
now explicit - the preloader loads bundle.js from a blob: URL, so automatic
public-path detection would resolve worker chunks against blob: and fail.

gulp/js.js calls @rspack/core's Node API directly instead of piping through
webpack-stream; the dead js.<variant>.prod.transpiled task is deleted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
gh run watch --repo Skigim/Foundry
```

Expected: all four jobs green. The `browser-test` job still passes `NODE_OPTIONS` — harmless on Rspack;
Task 8 removes it.

---

### Task 8: Delete the OpenSSL workaround

**Files:**
- Modify: `.github/workflows/ci.yml` (`browser-test` job — both build steps and their comments)
- Modify: `.claude/dev-server.cmd`
- Modify: `test/browser/harness.js` (the two `BUILD_COMMAND_*` constants, if Task 5 left the flag in them)
- Modify: `package.json` (remove now-dead root bundler dependencies)
- Modify: `docs/handoff.md` (Empirical constraints, Open questions)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

This is the stage's most visible daily-experience win and it deserves its own commit.

- [ ] **Step 1: Strip the flag from CI**

In `.github/workflows/ci.yml`'s `browser-test` job, remove both `env:` blocks setting
`NODE_OPTIONS: --openssl-legacy-provider` and their explanatory comments, leaving:

```yaml
            - name: Build dev bundle
              working-directory: gulp
              run: |
                  yarn gulp build.prepare.dev
                  yarn gulp js.web-localhost.dev
                  yarn gulp html.web-localhost.dev
```

and the equivalent for the prod build step (keeping its own comment about why prod is built second).

- [ ] **Step 2: Strip it from the dev server script**

Replace `.claude/dev-server.cmd` entirely:

```
@echo off
REM Starts the Foundry web dev server on http://localhost:3005

cd /d "%~dp0.."
cd gulp
yarn gulp
```

`.claude/` is gitignored (`.gitignore:60`) and this file is force-added, so:

```bash
git add -f .claude/dev-server.cmd
```

- [ ] **Step 3: Strip it from the harness build commands**

If Task 5 Step 3 left `NODE_OPTIONS=--openssl-legacy-provider` in `BUILD_COMMAND_DEV` /
`BUILD_COMMAND_PROD`, remove it now so the message the harness prints on a missing build is a command that
actually works.

- [ ] **Step 4: Remove the dead bundler dependencies from the root tree**

The root `package.json` carries a full set of bundler dependencies that build nothing — the actual build
lives in `gulp/`. Delete from `dependencies`: `webpack`, `webpack-cli`, `webpack-bundle-analyzer`,
`webpack-strip-block`, `worker-loader`, `terser-webpack-plugin`, `babel-loader`, `html-loader`,
`ignore-loader`, `markdown-loader`, `uglify-template-string-loader`.

**Keep** `eslint`, `typescript`, `prettier`, `@typescript-eslint/*`, `eslint-config-prettier`,
`eslint-plugin-prettier`, `playwright`, `js-yaml`, `yawn-yaml` — `yarn lint`, `yarn tslint`,
`yarn test:browser`, and `sync-translations.js` need them.

```bash
yarn install
yarn lint && yarn tslint && yarn test
```

Expected: all pass. **If `yarn lint` or `yarn tslint` breaks, one of the removed packages was load-bearing
after all** — put it back and note which.

- [ ] **Step 5: Update the two handoff entries this obsoletes**

In `docs/handoff.md`'s **Empirical constraints**, the bullets beginning "**Webpack 4 cannot run on Node
17+**" and "**`NODE_OPTIONS=--openssl-legacy-provider` must be exported before gulp starts…**" describe a
problem that no longer exists. Per the section's own append-only rule — never delete a constraint without
proving it no longer holds — mark them rather than deleting:

Prefix each with `**~~…~~ RESOLVED 2026-08-14 by Stage 1.**` and append one sentence saying the bundler
swap removed the cause, keeping the original text struck through so the history stays readable.

In **Open questions**, the entry "**Should the `NODE_OPTIONS` flag and the fluent-ffmpeg patch be made
permanent rather than reapplied?**" is now half-answered. Rewrite it to cover only the fluent-ffmpeg patch,
and note that the `NODE_OPTIONS` half was resolved by removing webpack 4.

- [ ] **Step 6: Verify end to end from a clean build**

```bash
cd gulp && yarn gulp build.prepare.dev && yarn gulp js.web-localhost.dev && yarn gulp html.web-localhost.dev && cd ..
yarn test:browser
cd gulp && yarn gulp js.web-shapezio.prod && yarn gulp html.web-shapezio.prod && cd ..
yarn test:browser:prod
```

Expected: 4 dev tests pass, 1 prod test passes, with no `NODE_OPTIONS` anywhere.

- [ ] **Step 7: Commit**

```bash
git add -A
git add -f .claude/dev-server.cmd
git commit -m "Delete the NODE_OPTIONS=--openssl-legacy-provider workaround

It existed only because webpack 4 hashes with MD4 through OpenSSL, which
OpenSSL 3 disables. Removed from CI, from .claude/dev-server.cmd, and from
the harness's documented build commands. The root package.json's webpack-era
dependencies go too - they built nothing; the real build lives in gulp/.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
gh run watch --repo Skigim/Foundry
```

---

### Task 9: Verify every build variant still produces an artifact

**Files:**
- Modify: `docs/build-timings.md` (append a variants section)

**Interfaces:**
- Consumes: `gulp/build_variants.js`'s nine variants.
- Produces: a recorded result per variant.

phase-1.md's "Done when" requires all build variants still produce working artifacts. The design spec is
realistic about the bar: web and standalone-steam get exercised properly; for the China/WeGame/GOG/demo
variants, "it builds" is the bar.

- [ ] **Step 1: Build all nine JS bundles**

```bash
cd gulp
for v in web-localhost web-shapezio-beta web-shapezio standalone-steam standalone-steam-china standalone-steam-demo standalone-steam-china-demo standalone-wegame standalone-gog; do
  echo "=== $v ==="
  yarn gulp "js.$v.prod" || echo "FAILED: $v"
done
cd ..
```

PowerShell equivalent:

```bash
cd gulp; foreach ($v in @("web-localhost","web-shapezio-beta","web-shapezio","standalone-steam","standalone-steam-china","standalone-steam-demo","standalone-steam-china-demo","standalone-wegame","standalone-gog")) { Write-Host "=== $v ==="; yarn gulp "js.$v.prod"; if (-not $?) { Write-Host "FAILED: $v" } }; cd ..
```

Note `js.web-localhost.prod` exists because `web-localhost` is a non-standalone variant with
`environment: "dev"` — it is a legitimate config combination and should build.

- [ ] **Step 2: Boot-check the two that matter**

For `web-shapezio` — already covered by `yarn test:browser:prod`; re-run it to be sure the loop above left
a working bundle:

```bash
cd gulp && yarn gulp js.web-shapezio.prod && yarn gulp html.web-shapezio.prod && cd .. && yarn test:browser:prod
```

For `standalone-steam`, build and launch it by hand — there is no automated standalone test, by design:

```bash
cd gulp && yarn gulp build.standalone-steam && cd ..
```

Then run the packaged output and confirm the main menu appears and a new game starts. **Watch for two
things specifically**: the background-animation worker (a broken one shows up as the game freezing when the
window loses focus) and saving a game (which exercises the compression worker). `output.publicPath` is `""`
for standalone, and `file://` URL resolution is the case least like the ones the tests cover.

Per handoff.md, a standalone build writes to `%APPDATA%\shapez.io\saves` — the same directory a
Steam-installed shapez.io uses. If you have Steam shapez installed, back that directory up first.

- [ ] **Step 3: Record the results**

Append to `docs/build-timings.md`:

```markdown
## Build variant sweep

Recorded after the Rspack swap. "builds" is the bar for the variants that are never exercised; the two
marked "booted" were launched and played briefly.

| variant | result | notes |
|---|---|---|
| web-localhost | | |
| web-shapezio-beta | | |
| web-shapezio | | |
| standalone-steam | | |
| standalone-steam-china | | |
| standalone-steam-demo | | |
| standalone-steam-china-demo | | |
| standalone-wegame | | |
| standalone-gog | | |
```

Fill every row. **A failing variant is a finding to report, not a row to leave blank** — if one fails and
the failure is genuinely out of scope (e.g. a missing China-specific asset that predates this stage),
confirm it fails identically on `master` before calling it pre-existing, and say so in the notes column.

- [ ] **Step 4: Commit**

```bash
git add docs/build-timings.md
git commit -m "Verify all nine build variants under Rspack

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Measure and record the post-swap numbers

**Files:**
- Modify: `docs/build-timings.md`

**Interfaces:**
- Consumes: `docs/build-timings.md`'s method section and the webpack 4 row from Task 3.
- Produces: the row that decides whether this stage met its goal.

- [ ] **Step 1: Repeat Task 3's three measurements exactly**

Same machine, same method, same file touched. Cold dev bundle (median of 3), incremental watch rebuild
(median of 3, first build excluded), cold prod bundle (once).

- [ ] **Step 2: Add the row**

Append to the results table in `docs/build-timings.md`:

```markdown
| 2026-08-14 | rspack <exact version> | <same machine string as the webpack row> | <fill in>s | <fill in>ms | <fill in>s |
```

- [ ] **Step 3: State the verdict in prose, honestly**

Below the table, add a short paragraph naming the speedup for each column and comparing it against
phase-1.md's "Done when" bar of **sub-second incremental dev rebuilds**. If the incremental number is not
sub-second, say so plainly and say what the remaining cost is — CE reported ~250ms, and a large gap from
that is worth understanding rather than glossing.

- [ ] **Step 4: Commit**

```bash
git add docs/build-timings.md
git commit -m "Record the post-swap build timings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Phase C — Minifier follow-up

---

### Task 11: Swap Terser for Rspack's SWC minimizer

> **Skip this task entirely if Task 7 Step 7 took the fallback branch** — you already ship the SWC
> minimizer, and there is nothing left to do here.

**Files:**
- Modify: `gulp/rspack.production.config.js` (the `minimizer` array, the `terser-webpack-plugin` require)
- Modify: `gulp/package.json` (remove `terser-webpack-plugin`)
- Modify: `docs/build-timings.md`

**Interfaces:**
- Consumes: `gulp/rspack.production.config.js`'s `globalDefs` and `minifyNames` locals.
- Produces: nothing other tasks import.

Task 7 kept Terser so that any prod-output difference was attributable to Rspack's module graph alone. With
that established, the minifier can move — and it is most of what the prod build spends its time on.

- [ ] **Step 1: Record the Terser baseline**

```bash
cd gulp && time yarn gulp js.web-shapezio.prod && cd ..
ls -l build/bundle.js
```

Record the wall time and the exact byte size.

- [ ] **Step 2: Replace the minimizer**

Remove `const TerserPlugin = require("terser-webpack-plugin");` and replace the `minimizer` array with the
`rspack.SwcJsMinimizerRspackPlugin` block written out verbatim in Task 7 Step 7's fallback branch.

`keep_fargs` has no SWC equivalent and is dropped. It only affected whether unused trailing parameters were
removed from function signatures — nothing in `src/js` reads `Function.prototype.length`, so this should be
inert, but it is the first thing to suspect if prod behaviour differs.

- [ ] **Step 3: Remove the dependency**

Delete `"terser-webpack-plugin"` from `gulp/package.json`'s `dependencies`, then:

```bash
cd gulp && yarn install && cd ..
```

Reapply the fluent-ffmpeg patch if needed.

- [ ] **Step 4: Rebuild, compare, and test**

```bash
cd gulp && time yarn gulp js.web-shapezio.prod && yarn gulp html.web-shapezio.prod && cd ..
ls -l build/bundle.js
yarn test:browser:prod
```

Expected: PASS, a faster build, and a bundle within ~10% of Terser's size.

**Accept the swap only if all three hold**: the prod smoke test passes, the build is faster, and the size
is within ~10%. A substantially *larger* bundle means the compress options did not map cleanly — revert
and keep Terser rather than shipping a regression for build speed the dev loop never sees.

- [ ] **Step 5: Re-run the dev guards**

The dev config has no minifier, so this should be untouched — confirm rather than assume:

```bash
cd gulp && yarn gulp js.web-localhost.dev && yarn gulp html.web-localhost.dev && cd ..
yarn test:browser
```

Expected: `# pass 4`, including the golden-save hash unchanged.

- [ ] **Step 6: Record the size and time change, then commit**

Add a line under `docs/build-timings.md`'s verdict paragraph giving the Terser → SWC prod build time and
bundle size, both before and after.

```bash
git add -A
git commit -m "Minify the prod bundle with Rspack's SWC minimizer

Terser was kept through the bundler swap so any output difference was
attributable to Rspack's module graph rather than a different minifier. With
that established, this is the remaining prod build-time win. keep_fargs has
no SWC equivalent and is dropped - inert unless something reads
Function.prototype.length, which nothing in src/js does.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
gh run watch --repo Skigim/Foundry
```

---

# Phase D — One dependency tree, and closing the stage

---

### Task 12: Collapse the two yarn trees

**Files:**
- Modify: `package.json` (absorb `gulp/package.json`'s dependencies and the `gulp` script)
- Delete: `gulp/package.json`, `gulp/yarn.lock`
- Modify: `.github/workflows/ci.yml` (all three install steps, all `working-directory: gulp` steps)
- Modify: `.claude/dev-server.cmd`
- Modify: `CLAUDE.md` (Repository layout, Common commands)
- Modify: `test/browser/harness.js` (`BUILD_COMMAND_DEV`, `BUILD_COMMAND_PROD`)

**Interfaces:**
- Consumes: everything above.
- Produces: a repo where a single `yarn install` at the root is enough, and gulp runs as
  `yarn gulp <task>` from the root.

phase-1.md's "Done when" for Stage 1 names "one dependency tree" explicitly, so this belongs to the stage.
It is sequenced last because it has the largest blast radius and no dependency on the bundler work — if it
has to be dropped, everything before it still stands on its own.

- [ ] **Step 1: Merge the dependency lists**

Copy every entry from `gulp/package.json`'s `dependencies`, `devDependencies`, and `optionalDependencies`
into the root `package.json`'s corresponding sections. Where the same package appears in both at different
versions, **take the `gulp/` version** — that is the tree that actually builds today — and list every such
conflict in the commit message. Expect conflicts on at least `@babel/*`, `eslint`, `html-loader`,
`markdown-loader`, `@types/node`, and `postcss`.

`eslint` is the one to be careful with: root pins `7.1.0` (used by `yarn lint`, with
`@typescript-eslint@3.0.1` and the prettier plugins), `gulp/` pins `^5.9.0`. **Keep the root's `7.1.0`
here** — it is the version `yarn lint` is configured against, and nothing in `gulp/` invokes eslint.

- [ ] **Step 2: Move the gulp script and set the working directory**

Add to the root `package.json`'s `scripts`:

```json
        "gulp": "gulp --gulpfile gulp/gulpfile.js --cwd gulp",
```

`--cwd gulp` matters: `gulp/gulpfile.js` and its task files use cwd-relative paths throughout (for example
`gulp.src("../src/js/main.js")` in `js.js`, and `image-resources.js`'s `../res_built/atlas`), so gulp must
still run as though it were inside `gulp/`.

Update `dev` and `devStandalone`:

```json
        "dev": "yarn gulp",
        "devStandalone": "yarn gulp serve.standalone-steam",
```

and `publishWeb`:

```json
        "publishWeb": "yarn gulp main.deploy.prod",
```

- [ ] **Step 3: Install once, from the root, and prove the whole pipeline still runs**

```bash
rm -rf node_modules gulp/node_modules
git rm gulp/package.json gulp/yarn.lock
yarn install
```

Reapply the fluent-ffmpeg patch — it now lives at `node_modules/fluent-ffmpeg/lib/capabilities.js:18`,
**not** under `gulp/`. This path change must be recorded in handoff.md (Step 7).

```bash
yarn gulp build.prepare.dev
yarn gulp js.web-localhost.dev
yarn gulp html.web-localhost.dev
yarn lint && yarn tslint && yarn test && yarn test:browser
yarn gulp js.web-shapezio.prod && yarn gulp html.web-shapezio.prod
yarn test:browser:prod
```

Expected: everything green. **The likeliest failure is a task that resolves a path via `__dirname` versus
cwd** — `gulpfile.js:88`'s `utils.cleanImageBuildFolder` already targets the wrong directory for exactly
this reason (handoff.md). If a task now writes somewhere new, fix the path rather than the working
directory.

- [ ] **Step 4: Update the harness build commands**

In `test/browser/harness.js`, both constants lose their `cd gulp` line:

```js
const BUILD_COMMAND_DEV = [
    "yarn gulp build.prepare.dev",
    "yarn gulp js.web-localhost.dev",
    "yarn gulp html.web-localhost.dev",
].join(" && ");
```

and the same shape for `BUILD_COMMAND_PROD`.

- [ ] **Step 5: Update CI**

In `.github/workflows/ci.yml`:

- `setup` job's install becomes just `yarn`.
- `browser-test` job's install becomes just `yarn`; both build steps lose `working-directory: gulp` and
  call `yarn gulp …` from the root.
- The `test` job is unchanged — it deliberately skips `yarn install`.

- [ ] **Step 6: Update `.claude/dev-server.cmd`**

```
@echo off
REM Starts the Foundry web dev server on http://localhost:3005

cd /d "%~dp0.."
yarn gulp
```

Remember `git add -f`.

- [ ] **Step 7: Update CLAUDE.md and handoff.md**

In `CLAUDE.md`, replace the **Repository layout** section's two-trees description and its install block
with a single-tree one:

```markdown
## Repository layout

This repo has **one yarn dependency tree** at the root (`package.json` / `yarn.lock`), covering both the
game source (`src/`) and the build tooling (`gulp/`: gulpfile, Rspack configs, image/sound/translation
pipelines, electron packaging). The two-tree layout was collapsed in Phase 1 Stage 1.

```bash
yarn install
```
```

In the **Common commands** section, remove every `cd gulp &&` and note that `yarn gulp --tasks` lists all
tasks. Replace mentions of webpack with Rspack throughout that section and the Architecture section.

In `docs/handoff.md`'s **Empirical constraints**, amend the fluent-ffmpeg bullet: the patch path is now
`node_modules/fluent-ffmpeg/lib/capabilities.js:18`, and it is destroyed by any root `yarn install`.

- [ ] **Step 8: Commit and confirm CI**

```bash
git add -A
git add -f .claude/dev-server.cmd
git commit -m "Collapse the two yarn dependency trees into one

gulp/package.json and gulp/yarn.lock are gone; every dependency lives at the
root and gulp runs as 'yarn gulp <task>' with --cwd gulp, which the gulpfile's
cwd-relative paths still require. On version conflicts the gulp/ pin won,
since that is the tree that actually built - except eslint, where the root's
7.1.0 is what yarn lint is configured against and nothing in gulp/ uses it.

This is phase-1.md's 'one dependency tree' exit criterion for Stage 1.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
gh run watch --repo Skigim/Foundry
```

Expected: all four jobs green. Record `browser-test`'s duration against the 2m55s baseline — one install
instead of two, and Rspack instead of webpack, should both help.

---

### Task 13: Close out the stage in the docs

**Files:**
- Modify: `docs/roadmap/phase-1.md` (Stage 1 section)
- Modify: `docs/handoff.md` (Current state, Next step, Open questions, Last updated)
- Modify: `CLAUDE.md` (any remaining webpack references)

**Interfaces:**
- Consumes: the results of Tasks 1–12.
- Produces: a handoff a fresh session can start Stage 2 from.

- [ ] **Step 1: Sweep for stale webpack references**

```bash
grep -rn --exclude-dir=node_modules --exclude=yarn.lock -i "webpack" . | grep -v "docs/superpowers/specs" | grep -v "docs/superpowers/plans"
```

Every remaining hit outside the specs and plans directories (which are historical records and stay as
written) must be either correct — `webpack-strip-block` is still a real dependency, and
`test/browser/harness.js`'s header comment about `require.context` still describes real behaviour Rspack
also implements — or updated. Check each. In particular, CLAUDE.md's **Known engine footguns** section
mentions `G_IS_STANDALONE` as "a webpack `DefinePlugin` constant"; that is now Rspack's `DefinePlugin` and
the sentence needs one word changed, not deleting — the footgun itself is unchanged.

- [ ] **Step 2: Mark Stage 1 done in phase-1.md**

Under `## Stage 1 — Build tooling`, add a **Status** paragraph after the "CE note" and before "Done when",
in the same shape Stage 0's uses. State: the bundler is Rspack as of this branch's merge; the measured
before/after numbers with a pointer to `docs/build-timings.md`; that all nine variants were swept; that the
`NODE_OPTIONS` workaround is gone; and that the two yarn trees are one. Then append **Met 2026-08-14** to
the "Done when" line, as Stage 0's does.

If Task 7 Step 5 dropped `CircularDependencyPlugin` with no replacement, say so here too — an exit
criterion met with a known gap should say what the gap is.

- [ ] **Step 3: Rewrite handoff.md's Current state and Next step**

**Current state** should say what landed (Rspack, both configs, worker migration, the two new tests, one
dependency tree), what the measured numbers were, and what is now unguarded or newly true. **Next step**
becomes Stage 2 (TypeScript migration) — noting it has no design spec yet, and that Rspack handling `.ts`
natively is what makes it the next thing.

Carry forward, explicitly, the things Stage 2 will want:

- The prod boot smoke test now exists and covers the prod bundle; Stage 2 gets a guard Stage 1 had to build.
- `/* typehints:start/end */` blocks and the `webpack-strip-block` dependency are Stage 2's to retire, per
  phase-1.md's Stage 2 "Done when".
- Worker chunks are now separate emitted files whose URLs depend on `output.publicPath`. Anything that
  changes how the bundle is served has to keep that in mind.

Update **Last updated** at the top of the file.

- [ ] **Step 4: Add the new empirical constraints**

Anything learned by running code during this stage goes into handoff.md's **Empirical constraints**,
append-only. Candidates, only if actually observed:

- Whether `circular-dependency-plugin` works under Rspack (Task 7 Step 5).
- Whether `terser-webpack-plugin@5` works under Rspack (Task 7 Step 7).
- Whether `output.publicPath` alone was enough for worker URLs, or `output.workerPublicPath` was needed
  (Task 7 Step 12).
- Whether CE's PR #119 solved anything differently from this plan's configs (Task 7 Step 1).
- The measured prod bundle size before and after (Task 4 Step 4, Task 7 Step 11, Task 11 Step 4).
- Any gulp task whose path resolution broke on the cwd change (Task 12 Step 3).

Do not write these from the plan — write them from what happened.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Close out Stage 1 in the roadmap and handoff

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

- [ ] **Step 6: Merge the branch**

Thirteen commits, one coherent unit, so `--no-ff` per the standing convention — Stage 1 is exactly the kind
of stage phase-1.md wants revertable as a whole with `git revert -m 1`.

```bash
git checkout master
git pull
git merge --no-ff phase-1/stage-1-build-tooling
git push
```

Before merging, confirm the final CI run is green on all four jobs. Leave the branch undeleted, as the
Stage 0 branches were.

---

## Deferred, deliberately

Recorded so they are decisions rather than oversights.

- **Replacing `babel-loader` with Rspack's `builtin:swc-loader`.** Rspack ships an SWC-based transpiler that
  would remove babel from the prod build entirely. Not done here: babel's `@babel/preset-env` output against
  the `> 0.01%` browserslist is what ships today, and swapping the *transpiler* as well as the bundler and
  the minifier in one stage is more simultaneous output drift than the golden-save hash and one prod smoke
  test can localise. Worth doing once Stage 2's types are in place.
- **Rspack's dev server / HMR.** The dev loop stays on browser-sync driving a watching compiler, as today.
  Real HMR is a larger change to how `gulpfile.js`'s `serveHTML` works and is not needed for the sub-second
  rebuild goal.
- **The `wires` strip-block pass.** Provably inert (zero `wires:start` markers in `src/`) and carried over
  unchanged, per the Global Constraints. Whether a gameplay layer should be strippable at all is a Stage 4
  engine-boundary question.
- **`gulpfile.js:88`'s `utils.cleanImageBuildFolder` targeting the wrong directory.** A real bug
  (handoff.md), untouched here because it is not a bundler concern and fixing it inside a bundler swap would
  muddy the blame for any atlas problem that follows.
