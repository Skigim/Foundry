# Session handoff

Living context for picking up work on Foundry in a fresh session. To use it, point a new session here —
"read `docs/handoff.md` and continue" — rather than re-explaining the project.

**Keep it current.** The sections are ordered by how often they change:

| Section | Update when |
| --- | --- |
| Read first / Standing decisions | A decision is made or reversed. Rare. |
| Empirical constraints | Something is learned by running code. Append-only; never delete a constraint without proving it no longer holds. |
| Current state / Next step / Open questions | Every session. |

Last updated: 2026-08-16

---

## Read first

These are authoritative. Do not re-derive their contents.

- [CLAUDE.md](../CLAUDE.md) — architecture, build commands, engine footguns, git convention, and Phase 1
  research findings (Community Edition precedents; why Godot was ruled out)
- [docs/roadmap/phase-1.md](roadmap/phase-1.md) — the sequenced Phase 1 plan, six stages

## Standing decisions

Settled. Do not re-litigate without new evidence.

- **Dependency-first stage ordering**, accepting no user-visible change until Stage 3.
- **Foundry is a hard fork of Shapez Community Edition.** CE is reference material to read and
  reimplement, never code to merge. Restructuring and renaming are permitted.
- **Phase 1 includes** the TypeScript migration, build tooling replacement, and the rendering overhaul.
  **Mod API v2 is deferred to Phase 2.**
- **Godot is ruled out** as a migration target.
- **Testing is deliberately minimal** — four artifacts, and no unit tests for game logic. The reasoning is
  in [Stage 0](roadmap/phase-1.md); read it before adding any test.
- **Feature branches merge with `--no-ff`** for the atomic-revert hatch. Single-commit branches
  fast-forward. Every commit on a branch must be green on its own.
- **Work in very small, individually verifiable commits.**
- **~~Artifact 3 is specced and built before artifact 2.~~ REVISED 2026-08-14 — artifact 2 comes first, and
  both are deferred into Stage 3.** The original reasoning was baseline expiry: artifact 3's pre-Stage-1
  number can only be taken on the current webpack build, and Stage 1 destroys the "before" half of Phase 1's
  performance claim. That reasoning assumed a **wall-clock** benchmark. Artifact 3's spec instead makes the
  committed metric a set of **draw-call counters**, which are functions of the code and fixture rather than
  the hardware or the bundler — so they have no Stage 1 expiry, and they cannot be built before artifact 2,
  which is the instrumentation that produces them. What *does* still expire is the wall-clock number; see
  "Pre-Stage-1 wall-clock baseline" under Current state, where a crude one is recorded so it is not lost.
  Note also that Stage 3's own claim compares before/after the draw-loop rewrite, both post-Stage-1 and
  therefore on the same bundler — that comparison was never at risk.
- **~~Artifact 3's fixture is a real, hand-played savegame, not a generated one.~~ CONTESTED 2026-08-14 —
  needs the repo owner's decision before artifact 3 is built.** The original argument stands on its merits:
  the bottleneck scales with entity *variety* on screen, not raw count, and a save file is inert where a
  generator is code to maintain across Stages 1–4. The new evidence against it is empirical. The hand-played
  save was produced and measured (see Current state): **3,496 entities, ~3% of #1471's target profile on both
  axes**, running 78fps at 1.19ms tick — far too quiet to read. Reaching ~120k entities by hand is not
  realistic. Artifact 3's spec therefore assumes a *generated* fixture, and a generator can be given a
  realistic building mix rather than a uniform belt grid, which answers the variety objection but not the
  maintenance one. **Do not treat the spec as having settled this** — it is the first thing to resolve when
  Stage 3 opens.
- **The automated perf number is measured in the browser only; the desktop build is hand-checked.** The two
  differ (Electron 16 bundles Chromium 96, and its launch flags change GPU behavior — see
  `electron/package.json`), but the cost being optimized is JS, not GPU, so a win carries to both. Doubling
  the harness to measure both is not worth it; record desktop numbers by hand around Stage 3 instead.

## Empirical constraints

Learned by running code, not by assuming. Each one has already cost time once.

- **Node 22 imports `src/js` typeless ESM directly — but this was only ever demonstrated for one
  zero-import leaf file (`core/rng.js`), and does not generalize.** The original phrasing here was
  misleading; see the next four bullets for what actually happens when a real module is imported. The
  `node:test` choice (vs. a transforming runner) is still right, just not for the reason originally given —
  see "Current state" below.
- **`src/js` cannot be imported under plain Node at all, for reasons far bigger than `require.context`.**
  Confirmed by direct test: `node --input-type=module -e "import('./src/js/game/core.js')"` fails
  immediately with `Cannot find module '.../src/js/application'`. Cause: `src/js` uses **1,942 extensionless
  relative import specifiers** (`"../application"`, not `"../application.js"`) — a webpack resolver
  behavior, not standard Node ESM, which requires the extension. This is the real blocker for any test that
  needs more than a leaf module; the `require.context` constraint below is a real but much smaller piece of
  the same underlying fact.
- **`/* typehints:start/end */` blocks are stripped by the bundler only** (via the `webpack-strip-block` loader); under
  plain Node they are live, real imports. E.g. `game/core.js`'s typehints block imports `Application`,
  dragging in the entire app/platform graph the moment `core.js` is imported outside a webpack build.
- **Several modules do real, module-scope `require()` calls for generated files that don't exist in a fresh
  checkout.** `core/config.js` requires `./config.local` (gitignored, generated by the `localConfig`
  gulp task); `translations.js` requires `./built-temp/base-en.json` (gitignored, generated by
  `gulp translations.fullBuild`). Both are on the import path of almost everything. The CI `test` job
  currently skips `yarn install` and both gulp steps — it would need both before any test touching these
  modules could run.
- **The Stage 0 hash subset (`map, entityMgr, entities, beltPaths, hubGoals, time, gameMode`, per
  phase-1.md) is nondeterministic by construction as specified.** `GameTime`'s serialized schema includes
  `realtimeSeconds`, sourced from `performance.now()` — two runs will never hash the same with `time`
  included verbatim. Must exclude `realtimeSeconds` specifically or pin the clock in the harness; this
  wasn't caught until an independent review of a draft spec, and should have been catchable by inspection.
- **Any webpack bundle containing `game/core.js` contains every `.js` file under `src/js`.** Chain:
  `game/core.js:20` → `savegame/savegame.js:17` → `mods/modloader.js:114`, which calls
  `require.context("../", true, /\.js$/)`. Webpack resolves `require.context` **statically at build time**,
  regardless of the `G_IS_DEV` runtime gate around `exposeExports()`. Measured with a probe build against the
  real `gulp/webpack.config.js`. Consequence: there is no "small bundle" of the simulation — bundling it
  requires the full asset pipeline (`res_built/atlas/`, `built-temp/sfx.json`). Cutting that edge is a
  Stage 4 target.
- **~~Webpack 4 cannot run on Node 17+~~ RESOLVED 2026-08-14 by Stage 1.** ~~without `NODE_OPTIONS=--openssl-legacy-provider`; it dies with
  `error:0308010C:digital envelope routines::unsupported`. The `CI` job works only because it pins Node 16.
  Local Node here is 22.~~ The Rspack bundler swap removed webpack 4, eliminating the OpenSSL legacy provider requirement.
- **`imgres.buildAtlas` fails silently.** `gulp/image-resources.js:75-113` wraps the task in
  `try { ... } catch { console.warn(...) }` and then calls `cb()` — a *successful* callback. Missing Java or a
  failed 22MB jar download yields a "successful" build with no sprites. Still true, and still worth guarding
  against; but see the next bullet — it is no longer unproven on ubuntu.
- **The atlas does build on `ubuntu-latest`.** Measured 2026-08-12 in run
  [31660769430](https://github.com/Skigim/Foundry/actions/runs/31660769430), the first time `imgres.buildAtlas`
  has ever executed in this repo's CI. Produced three real variants (`atlas0_hq/mq/lq` × `.atlas`/`.json`/`.png`,
  1.9MB/951KB/389KB), and `Building atlas failed` appears zero times in the log, so the silent-failure path was
  not taken. Specifics worth not re-deriving: the runner ships **OpenJDK 17.0.19** preinstalled, so no
  `setup-java` step is needed; the jar downloads via the first fallback (`wget`); and `actions/cache` on
  `gulp/runnable-texturepacker.jar` works, so only the first run pays the 22MB download. **Whole job: 2m20s
  cold**, against the 5–10 min the design budgeted — and that is with the download, before any Playwright step.
- **A silently-empty atlas does not surface as a build error later either.** `states/preload.js:211` returns a
  promise that *never resolves* when resource loading fails, so the game hangs at "Downloading resources"
  rather than throwing. Any browser test must assert the atlas is non-empty before launching, or its failure
  mode is an unexplained timeout.
- **`utils.cleanImageBuildFolder` cleans the wrong directory.** It targets `gulp/res_built`
  (`gulpfile.js:88`, via `__dirname`), but the atlas is written to the repo-root `res_built`
  (`image-resources.js:78`, via a cwd-relative `../res_built/atlas`). So the atlas is never actually cleaned
  and a stale local one can mask a broken build. CI is unaffected — fresh checkout every run.
- **`gh` defaults to `tobspr-games/shapez.io` until told otherwise.** Both `origin` (Skigim/Foundry) and
  `upstream` (tobspr-games/shapez.io) are configured, and with no default set, bare `gh` commands target
  *upstream* — a `gh pr create` here aimed a PR at tobspr's repo and was rejected only because there were no
  commits between the two. Fixed on this clone with `gh repo set-default Skigim/Foundry` (2026-08-12), which
  writes `remote.origin.gh-resolved` to `.git/config`. **That is per-clone and not committed**, so a fresh
  clone, another machine, or a git worktree with its own config will hit it again. Run it once after cloning,
  or pass `--repo Skigim/Foundry` explicitly.
- **CI's pinned actions are living on borrowed time.** Every job now annotates: `actions/checkout@v2`,
  `actions/setup-node@v2-beta` and `actions/cache@v4` target Node 20, which is deprecated and is being *forced*
  onto Node 24 by the runner. Nothing is broken yet. Bumping them is its own small change, deliberately not
  bundled into Stage 0 work.
- **`window.shapez` does not exist in web prod builds.** `exposeExports()` is gated on
  `G_IS_DEV || G_IS_STANDALONE` (`modloader.js:111`) and `gulp/webpack.production.config.js:27` hardcodes
  `G_IS_DEV: "false"`. Anything driving the game from outside must target a dev bundle.
- **`node --test test/` fails** — a directory argument is treated as a module entry point. Use
  `node --test "test/**/*.test.js"`.
- **Tests must not live under `src/js`.** `component_registry.js:56` asserts via `require.context` that the
  `.js` file count in `game/components` equals the registered component count; a colocated test file breaks
  the game's own sanity check.
- **Do not add `"type": "module"` to `package.json`.** `sync-translations.js` and the gulp tooling are
  CommonJS and would break. The resulting `MODULE_TYPELESS_PACKAGE_JSON` notice is cosmetic and resolves at
  Stage 2.
- **`assert` is `window.assert`**, installed as an import side effect of `core/assert.js`. Any module
  calling it cannot be exercised outside a browser until the harness decides how to shim browser globals.
- **`require.context` (webpack-only) is called at registration time** in `component_registry.js:56` and
  `modloader.js:114`, so the component registry cannot load outside a webpack-compatible bundler. The
  golden-save hash artifact landed anyway — not by resolving this constraint, but by building and serving a
  real webpack bundle (`test/browser/harness.js`'s whole design) rather than trying to load the component
  registry directly under Node. The constraint remains true and unresolved for any *other* use case that
  would want a small bundle without the full asset pipeline, and is still a point in Rspack's favor for
  Stage 1.
- **`browser-test`'s full duration, including the actual Playwright boot test, is 2m24s.** Measured in CI run
  [31664495889](https://github.com/Skigim/Foundry/actions/runs/31664495889) — the first run where the job
  runs `yarn test:browser` rather than stopping after the atlas/bundle build. All four jobs green in that
  run: `CI` 1m55s, `test` 12s, `browser-test` 2m24s, `yaml-lint` 31s — comfortably under the design's 5–10
  minute budget.
- **Local `gulp build.prepare.dev` needs a system `ffmpeg` on PATH.** The `sounds.dev` gulp task shells out to
  it via `fluent-ffmpeg`; this Windows dev machine had none installed. CI is unaffected — both `browser-test`
  and the `CI`/`setup` job already `apt-get install ffmpeg` explicitly.
- **FFmpeg 9.0 breaks `node_modules/fluent-ffmpeg/lib/capabilities.js`'s output parser.** Its
  `formatRegexp` hardcodes a single space between capability flags and the format name; ffmpeg 9.x's
  `-formats` output uses two, so every mux/demux capability check silently reports "not available" even when
  the codec is present — this breaks `sounds.sfxOptimize` with a misleading `Output format mp3 is not
  available` error. FFmpeg ~6.x (what Ubuntu 24.04's `apt-get install ffmpeg` provides, i.e. what CI already
  runs) does not trigger this. A real version-skew bug in a pinned npm dependency, not this plan's code —
  worth knowing before re-diagnosing it from scratch on a machine with a newer local ffmpeg.
  **The exact fix, applied on this dev machine 2026-08-14:** `capabilities.js:18` reads
  `/^\s*([D ])([E ]) ([^ ]+) +(.*)$/`; changing the literal space before `([^ ]+)` to ` +` makes it accept
  either spacing and works against both ffmpeg 6.x and 9.x. Verified: ffmpeg 9 prints ` DE  mp3` (two
  spaces) for `-formats`, while `-codecs` and `-encoders` still use one space, so only `formatRegexp` needs
  it. **Following the single-tree migration in Stage 1, this lives in `node_modules/fluent-ffmpeg/lib/capabilities.js:18` and is destroyed by any root `yarn install`** — expect to
  reapply it, and treat a returning `Output format mp3 is not available` as exactly this and nothing more.
- **The plan's documented Node-16 CI fallback (pin `playwright` to `1.40.1`) is unsafe and was not used.** It
  does fix the Node-16 `yarn install` engines-check failure, but that old a Playwright version predates
  Ubuntu 24.04 "noble"'s `libasound2` → `libasound2t64` apt package rename, so it then breaks `browser-test`'s
  `--with-deps` Chromium install on `ubuntu-latest` (which runs noble) with `Package 'libasound2' has no
  installation candidate`. No single Playwright version satisfies both Node 16 support and noble-aware
  `--with-deps` — per npm registry `engines` metadata, the `engines.node` requirement jumps to `>=18`
  starting at Playwright 1.45.0. **Fix actually used:** keep `playwright` at `^1.49.0` (unchanged), and scope
  `yarn --ignore-engines` to only the `setup`/`CI` job's root `yarn` install step — the `cd gulp/ && yarn`
  call is untouched and doesn't need it, since the gulp tree never references playwright. This is the current
  state of `.github/workflows/ci.yml`. Caveat: that `--ignore-engines` is job-wide, not package-scoped, so it
  would also silently permit a *different* future Node-16-incompatible root devDependency to install rather
  than failing loudly — bounded risk since that job only lints/typechecks, but a known blind spot.
- **`states/ingame.js`'s `onRender` falls through, in the same synchronous callback that flips the game
  stage from `s7_warmup` to `s10_gameRunning`, into a real wall-clock-timed `core.tick(dt)`** — before test
  code watching for that transition can react. This is a plan-inherited nondeterminism bug, not one
  introduced by the harness: confirmed empirically by running the unfixed harness three times and getting
  300 vs. 301 ticks' worth of state. `waitForGameRunning` (`test/browser/harness.js`) now forces the
  transition inside one synchronous `page.evaluate()` that also freezes the frame loop, closing the race.
  The kind of subtle harness bug that would otherwise flake CI intermittently with no indication of the
  cause — worth remembering before touching the warmup→running transition again.
- **A debug-flag guard list is not self-evidently complete just because it exists.** An adversarial
  verification pass on `SIMULATION_ALTERING_DEBUG_FLAGS` (`test/browser/harness.js`), run between Tasks 5
  and 6 specifically because the list had never been checked against the source, found two Critical and two
  Important gaps before any hash was pinned: `rewardsInstant` and `disableUnlockDialog` could each silently
  corrupt the hash if set in a local `config.local.js` — the latter more severely, since it can make
  `runTicks` silently stop simulating entirely mid-run (via `shouldPauseGame()` zeroing `logicTimeBudget`)
  while still reporting a normal-looking tick count; `externalModUrl` and `manualTickOnly` were also
  missing. All four are now guarded. Lesson for the next flag or the next guard list generally: it has to be
  checked against every `globalConfig.debug.*` branch reachable from the tick path, not populated by
  intuition.
- **`round4Digits` (`src/js/core/utils.js:338-340`) is floor-based, not symmetric around zero.** Not
  currently triggerable — every value feeding the golden-save hash is IEEE-754-exact across platforms for
  what the fixture exercises — but if a future cross-platform hash mismatch ever looks like a clean
  zero-crossing (a value landing at exactly `0` on one platform, `-0.0001` on another), check this function
  before assuming a real simulation divergence. Found, and ruled out for now, by the same adversarial pass
  that independently verified the rest of the hashing/serialization pipeline (`stableStringify`,
  `dumpSimulationSubset`'s atomicity, array-ordering determinism, wall-clock field isolation) sound, with no
  fixes needed there.
- **The golden-save fixture's `WARMUP_TICKS` is 300, not the plan's originally-specified 120.** At 120 ticks
  nothing has reached the belt yet — the miner's `mineDuration` is 150 ticks plus ~24 ticks of ejector
  handoff, so 174 > 120 — confirmed by literally hitting the fixture generator's own zero-items guard at
  120. The committed fixture's `timeSeconds` is therefore ~4.9999, not the plan's expected 2.
- **The golden-save hash held, both same-machine and cross-platform, for the one fixture/tick-count actually
  measured.** Task 6 Step 2's self-consistency check (two independent `launchGame()` runs — two separate
  Chromium processes/contexts — on this Windows dev machine) passed on the first attempt: not just matching
  hashes but byte-identical dumped subset JSON, and the stop-rule was never triggered. Task 7's PR #2 CI run
  ([31727768465](https://github.com/Skigim/Foundry/actions/runs/31727768465)) then reproduced the reference
  hash exactly on `ubuntu-latest` — `GOLDEN_SAVE_HASH`, pinned from this Windows machine's run, matched
  without regenerating anything. This is the actual evidence for the README's determinism claim (see the
  "Note" in [phase-1.md](roadmap/phase-1.md)'s Stage 0 section), scoped to exactly what was measured: a
  22-entity miner+20-belt fixture, 600 ticks at a pinned 60 UPS, Windows vs. `ubuntu-latest`. It does not
  generalize to larger saves, different tick counts, or other platform pairs without separately measuring
  those.
- **`browser-test`'s duration with all three tests (boot smoke + both golden-save tests) is 2m55s**,
  measured in the same CI run. Up from the 2m24s/2m47s recorded above for the boot-smoke-only job. The three
  `node:test` cases themselves run in ~5.3s combined; the rest is the atlas/bundle build and
  Playwright/Chromium setup already shared with artifact 4. Still comfortably under the design's 5–10 minute
  budget.
- **~~`NODE_OPTIONS=--openssl-legacy-provider` must be exported before gulp starts, and cannot be reliably
  threaded through a one-line `cmd /c "set X=... && ..."` invocation~~ RESOLVED 2026-08-14 by Stage 1.** ~~from this environment — the quoting is
  mangled between the bash layer and `cmd`, the flag silently never arrives, and webpack then dies mid-watch
  with `error:0308010C:digital envelope routines::unsupported`. The failure is easy to misread: gulp's
  earlier tasks all succeed and browser-sync starts serving, so `http://localhost:3005` answers normally and
  only `bundle.js` 404s. **Fix in place:** `.claude/dev-server.cmd` sets the variable in a real script file
  and runs `yarn gulp`; `.claude/launch.json` points at it. Both are committed, **force-added past
  `.gitignore:60`'s `.claude/` rule** — so `git add .` will never pick up changes to them, and editing them
  needs `git add -f`. `.claude/settings.local.json` is personal machine config and stays ignored. All of
  this becomes moot at Stage 1: swapping webpack 4 removes the openssl flag's reason to exist.~~ Swapping webpack 4 for Rspack in Stage 1 completely removed the need for this flag.
- **The dev web build is not demo-limited, despite saying "DEMO" everywhere.** Measured at runtime against
  the running game, not inferred: `isLimitedVersion()` is `false`, and `getHasExtendedLevelsAndFreeplay`,
  `getHasExtendedUpgrades`, `getHasUnlimitedSavegames`, and `getHasExtendedSettings` are all `true`.
  `restriction_manager.js:72` makes any `G_IS_DEV` build unrestricted unless the URL contains `demo`. The
  branding is cosmetic and checks something else entirely: `utils.js:772` returns `logo_demo.png` for any
  browser build not signed in via Steam SSO, `src/html/index.html:4` hardcodes the page title, and
  `main_menu.js:148`'s Steam sign-in panel is gated on SSO state, never on `isLimitedVersion()`. Do not spend
  time "unlocking" this again.
- **...but the *level table* was a real, separate limiter, and this entry used to miss it.** The bullet above
  is accurate about `RestrictionManager` and stops there — which reads as "nothing gates the dev build," and
  that was wrong. `generateLevelsForVariant` (`modes/levels.js`) branched independently of
  `isLimitedVersion()`: browser builds got `WEB_DEMO_LEVELS`, 9 levels ending in `reward_demo_end`, while the
  full 26-level progression sat behind `G_IS_STANDALONE || WEB_STEAM_SSO_AUTHENTICATED`. Past level 9 you
  fell into `computeNextGoal`'s freeplay branch (`hub_goals.js:255`), whose reward is `no_reward_freeplay` and
  whose required amount is `Math.floor(4 + (level - 27) * 0.25)` — **≤ 0 until roughly level 27**, so every
  delivered shape instantly completed a level. Presents as "the game fast-forwards me to level 15 and nothing
  unlocks." Fixed 2026-08-14: all non-Steam-demo builds now get `STANDALONE_LEVELS`. The SSO path was never
  usable locally anyway — it needs a live token from tobspr's API proving Steam ownership
  (`core/steam_sso.js:56`).
- **The in-game fullscreen toggle is standalone-only by design, not a demo restriction.**
  `application_settings.js:192` enables it on `G_IS_STANDALONE`, and `platform/wrapper.js:101` returns
  `false` for `getSupportsFullscreen()` in the browser — only the Electron wrapper implements it. Browser
  play uses F11. Wiring the real browser Fullscreen API is a plausible small Stage 5 UI/UX item.
- **The standalone build writes to the same directory as a Steam-installed shapez.io.**
  `electron/index.js:26-27` hardcodes the literal string `"shapez.io"`: `%APPDATA%\shapez.io\saves` and
  `%APPDATA%\shapez.io\mods`. It is not derived from the electron app name. Two consequences: a Foundry
  standalone build would load any mods installed for Steam shapez (silently defeating a "no mods"
  requirement), and it writes into the same savegame directory. Whether it can actually corrupt a Steam
  save index was **not** investigated. Authoring work that must be mod-free should use the web dev build,
  whose storage is IndexedDB `app_storage` (`storage_indexed_db.js:28`) scoped to the localhost origin.
- **Rendering cost has a base-size term independent of the camera, but it is smaller than #1471's belt count
  suggests.** `systems/belt.js:331` (`drawBeltItems`) iterates *every* belt path each frame regardless of
  viewport; each `BeltPath.draw` (`belt_path.js:1402`) then early-outs on
  `parameters.visibleRect.containsRect(this.worldBounds)`. `containsRect` (`core/rectangle.js:233`) is
  misnamed — it is an *intersects* test, not containment, so the cull is correct and there is no
  vanishing-items bug there. But contiguous belts merge into one path, so 77k belts is likely only a few
  thousand paths, i.e. a few thousand cheap rect checks — not a 250ms frame. **Hypothesis, not measured:**
  the dominant cost is per-system, per-visible-chunk drawing, which makes on-screen *density* matter more
  than total base size. Artifact 3 is what settles this; do not encode it as fact until it does.
- **Per-entity drawing stops below zoom 0.9.** `config.js:75` sets `mapChunkOverviewMinZoom: 0.9`, and the
  zoom range is 0.1–3 (`config.js:117-118`). Below 0.9 the renderer switches to cheap chunk-overview
  drawing, so zooming out does *not* monotonically increase drawn entities. The worst case for the diagnosed
  bottleneck sits just above 0.9. Any pinned benchmark camera must account for this.
- **`CircularDependencyPlugin` cannot run under Rspack.** `CircularDependencyPlugin` hooks `compilation.hooks.optimizeModules`, a webpack-internal hook Rspack does not implement. The circular import guard was dropped in the swap; replacing it is Stage 2's first task (see [phase-1.md](roadmap/phase-1.md)).
- **Minifier evaluation: `SwcJsMinimizerRspackPlugin` vs `TerserPlugin`.** Rspack's built-in SWC minimizer dropped production cold bundle time from 29.41s to 15.89s (a 1.85x speedup; 3.98x total speedup vs webpack 4's 63.26s) with only +0.47% (+9.15 KB) size difference, and passed the prod boot smoke test cleanly. `keep_fargs` has no SWC equivalent and was dropped without issue.
- **Worker loading under Rspack requires `new Worker(new URL(...))` and explicit `output.publicPath`.** Web prod uses `/v/<commitHash>/` for cachebusting, and standalone uses `""`. `output.publicPath` alone was sufficient; `output.workerPublicPath` was not needed.
- **Collapse to single dependency tree required `resolutions` for `through2` and `@types/minimatch`.** `gulp-audiosprite` declared `through2: "*"` which resolved to v5.x breaking `.obj()`; pinned to `^3.0.1`. `@types/glob` pulled in `@types/minimatch: "*"` (v6 stub with no declarations) breaking TypeScript 3.9.3 `tsc`; pinned to `^3.0.5`. `src/js/tsconfig.json` explicitly scoped types to `["cordova", "filesystem", "node"]` to prevent unwanted types like `@types/ws` from polluting compilation.

## Current state

**Stage 1 (Build Tooling: Webpack 4 to Rspack swap) has landed end-to-end on `phase-1/stage-1-build-tooling`.**
All 13 tasks of the Stage 1 plan are complete:

- **Bundler replacement:** Webpack 4 and `webpack-stream` were replaced by `@rspack/core` across both dev and production configs (`gulp/rspack.config.js` and `gulp/rspack.production.config.js`). Unmaintained webpack plugins (`string-replace-webpack-plugin`, `unused-files-webpack-plugin`, `worker-loader`, `CircularDependencyPlugin`) were retired, and a local loader `gulp/loader.inline_globals.js` was introduced for hot globalConfig constant inlining.
- **Minifier upgrade:** `terser-webpack-plugin` was swapped for Rspack's native `SwcJsMinimizerRspackPlugin`, dropping prod build time to 15.89s with negligible size delta (+0.47%).
- **Worker migration:** Web workers in `src/js/core/async_compression.js` and `src/js/core/animation_frame.js` were migrated to standard `new Worker(new URL(..., import.meta.url))` syntax.
- **Dependency collapse:** The two separate yarn trees (`package.json` and `gulp/package.json`) were collapsed into a single root tree. Gulp runs via `yarn gulp <task>` from the repo root with `--gulpfile gulp/gulpfile.js --cwd gulp`.
- **OpenSSL legacy flag deleted:** The `NODE_OPTIONS=--openssl-legacy-provider` workaround was completely removed from CI, `.claude/dev-server.cmd`, and test harness documentation.
- **New tests in CI:** A production bundle boot smoke test (`test/browser/prod/boot.prod.smoke.test.js`) and a web worker compression round-trip smoke test (`test/browser/worker.smoke.test.js`) were added and pass in CI.
- **Verification:** All 9 build variants (`gulp/build_variants.js`) build cleanly. The full test matrix (`yarn lint`, `yarn tslint`, `yarn test`, `yarn test:browser`, `yarn test:browser:prod`) is 100% green, and `GOLDEN_SAVE_HASH` is preserved unchanged.

Measured build timings (`docs/build-timings.md`):
- Cold dev bundle: **4.88s** (vs 8.76s webpack 4, **1.80x speedup**)
- Incremental watch rebuild: **67ms** (vs 980ms webpack 4, **14.6x speedup** — sub-second target decisively achieved)
- Cold prod bundle: **15.89s** (vs 63.26s webpack 4, **3.98x speedup**)

## Next step

**Stage 1 is complete.**

**Next: Stage 2 (TypeScript migration).** Specced in roadmap (`docs/roadmap/phase-1.md`).
Modernizing `src/js` to TypeScript is now unlocked by Rspack natively supporting `.ts` without separate loaders.

Things carried forward from Stage 1 into Stage 2:
- **Stage 2's first task is restoring the circular-import guard Stage 1 dropped** — specced in
  [phase-1.md](roadmap/phase-1.md)'s Stage 2 section. It is deliberately scheduled before the first
  conversion commit, because the migration's module moves are what would introduce a cycle, and sized to
  include validating that the replacement actually parses this codebase rather than silently finding
  nothing.
- The prod boot smoke test (`yarn test:browser:prod`) now exists and guards the prod bundle across transformations.
- `/* typehints:start/end */` blocks and the `webpack-strip-block` loader dependency are Stage 2's to retire into real TypeScript imports.
- Worker chunks are separate emitted files whose URLs depend on `output.publicPath`.
- TypeScript is pinned at 3.9.3 with JSDoc typechecking; Stage 2 will migrate `.js` to `.ts` files incrementally (leaf modules -> core -> game -> states/UI).

## Open questions

- **Should the hardcoded `"shapez.io"` appdata path be renamed?** `electron/index.js:26-27` (see Empirical
  constraints). A fork with its own identity writing into a shipping game's save and mod directories is a
  real hazard, but renaming orphans any existing standalone saves, so it is a decision rather than a fix.
  Arguably Stage 4 territory — product identity is content, not engine. Not folded into any current spec.
- **Should the demo branding be replaced with Foundry branding?** `utils.js:772`, `src/html/index.html:4`.
  Purely cosmetic and currently misleading (the dev build is not restricted). Small, but it is branding
  work with no dependency on any stage, so it can happen whenever it stops being ignorable.
- **Should the fluent-ffmpeg patch be made permanent rather than reapplied?**
  Options include pinning an older local ffmpeg or a postinstall patch step. The `NODE_OPTIONS` half of this question was resolved in Stage 1 by removing webpack 4.
- **Should `browser-test` skip docs-only pushes?** It has no path filter, so every push to a PR branch runs
  the full atlas + webpack build — measured at 2m46s and 2m55s on this branch for two commits that touched
  nothing but `docs/**`. Harmless for one-off doc commits; it compounds badly for a session making many small
  commits, which is exactly the shape of the work left. The fix is a `paths-ignore` on the job, and the
  reason it is a question rather than a change is that the safe filter is narrower than it looks: `docs/**`
  alone is fine, but anything broader risks skipping the build on a push that genuinely needs it, and a
  required-check configuration will treat a skipped job differently from a passing one. Decide deliberately;
  do not bundle it into a task.
- **~~The circular-import guard was dropped in the Rspack swap and has no replacement.~~ RESOLVED
  2026-08-16 — assigned to Stage 2 as its first task.** `gulp/webpack.config.js` ran
  `circular-dependency-plugin` with `failOnError: true`, so a new import cycle in `src/js` failed the dev
  build. The plugin hooks `compilation.hooks.optimizeModules`, which Rspack does not implement, so it did
  not survive Stage 1, and nothing currently detects a new cycle. The gap was accepted for the Stage 1
  merge on the grounds that Stage 1 moved no imports — three `.js` files touched under `src/js`, all
  worker-URL changes — so there was nothing for a guard to catch, while Stage 2's wholesale module moves
  are where the risk actually lives. See [phase-1.md](roadmap/phase-1.md)'s Stage 2 section for the task,
  including why `madge` needs validating against the 1,942 extensionless specifiers before it is trusted.
- Whether to bump the deprecated action versions (see Empirical constraints) as a standalone change.
- Local branches `phase-1/stage-0-harness`, `phase-1/stage-0-ci`, and `phase-1/stage-0-tslint-fix` were
  deleted (confirmed merged) in Task 7. `phase-1/stage-0-boot-smoke` and `phase-1/stage-0-golden-hash` — the
  two branches from this plan — are now merged too, and remain undeleted.

Settled since the last session, and recorded here so they are not reopened: tick count (600 at a pinned
60 UPS), fixture composition (a miner plus 20 belts, deliberately short of back-pressure), Playwright browser
(Chromium, cached alongside the texture-packer jar), and the main-menu assertion
(`document.body.id === "state_MainMenuState"`, set by `state_manager.js:88` — a state-machine fact rather than
a rendering-timing guess). All four are argued in the plan.
