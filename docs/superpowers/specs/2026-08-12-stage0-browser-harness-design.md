# Stage 0 browser harness — design

**Status: approved, not yet implemented.** Brainstormed 2026-08-12.

Supersedes [2026-08-12-stage0-golden-save-hash-design.md](2026-08-12-stage0-golden-save-hash-design.md), whose
premise — that `src/js` can be exercised under plain Node given a few hand-rolled shims — was disproven. This
spec covers **two** of Stage 0's four artifacts (see [phase-1.md](../../roadmap/phase-1.md)): the boot smoke
test (artifact 4) and the golden-save simulation hash (artifact 1). Artifact 1 alone was the previous spec's
scope; widening it is the central change here, and the reasoning is below.

## Goal

Establish Stage 0's execution substrate, then land the two artifacts that ride on it:

- **Boot smoke test** — the built artifact launches, reaches the main menu, and logs no uncaught errors.
- **Golden-save hash** — load a fixed savegame, run a fixed number of simulation ticks, hash a defined subset
  of the resulting serialized state, compare against a committed reference.

Together these make simulation regressions detectable before Stage 1 rewrites the build, which is the entire
reason Stage 0 exists.

## Why a browser and a real build, not Node

The previous spec assumed a small, cheap Node harness was reachable. It is not, and the reason is stronger
than the one the earlier review found. Measured, not assumed:

**There is no small bundle.** `game/core.js:20` imports `savegame/savegame.js`, which at line 17 imports
`mods/modloader.js`, which at line 114 calls `require.context("../", true, /\.js$/)`. Webpack resolves
`require.context` **statically at build time**, regardless of the `G_IS_DEV` runtime gate around
`exposeExports()`. So any bundle containing `game/core.js` contains **every `.js` file under `src/js`**.
Confirmed by building a minimal probe entry against the real
[webpack.config.js](../../../gulp/webpack.config.js) — webpack's own dependency trace:

```
ERROR in ./src/js/core/atlas_definitions.js
Can't resolve '../../../res_built/atlas/'
 @ ./src/js sync \.js$          <- require.context over all of src/js
 @ ./src/js/mods/modloader.js
 @ ./src/js/savegame/savegame.js
 @ ./src/js/game/core.js
```

Consequences that follow directly:

- Bundling the simulation *is* building the game, so it drags in the full asset pipeline —
  `res_built/atlas/` and `built-temp/sfx.json`, i.e. the atlas and sound builds.
- The "small dedicated bundled entry point" strategy therefore has no cost advantage over building the real
  thing. It was chosen for being cheap; it is not cheap.
- Once a full build is required regardless, running it in a real browser costs a Playwright dependency and
  little else — and removes the "does the harness match reality" question that sank the previous spec.

[phase-1.md](../../roadmap/phase-1.md) anticipated this outcome: *"If it turns out the simulation cannot be
loaded at all without the full app bundle, that is not merely an obstacle: it is an early, cheap measurement
of how entangled the engine/content boundary really is."* That is now measured. A build-time edge runs from
the savegame layer to every file in the project. Recorded here as a **Stage 4 target**: cutting the
`savegame.js -> modloader.js` edge would make a small bundle possible. Doing it now would mean performing
engine-boundary surgery before the guard that surgery needs exists, so it is deliberately deferred.

### Why not the other two strategies

- **Defer past Stage 1 (build the bundler swap first).** Rejected. It runs the roadmap's
  highest-risk-of-silent-breakage change with zero guard, and the guard it waits for is the artifact that
  would have caught the breakage. It also requires revisiting the dependency-first stage-ordering standing
  decision; the approach chosen here does not, because phase-1.md lists four deliverables and never fixes
  their order — its "Done when" is *all four run in CI*.
- **A dedicated minimal bundle.** Rejected on the measurement above.

## Architecture

One harness, driven by Playwright, running against a real built bundle produced by the existing gulp
pipeline. `node:test` remains the runner, preserving Stage 0's stated constraint that the *test runner*
survive Stages 1 and 2.

```
test/browser/harness.js           # launch, build verification, page setup, error capture
test/browser/boot.smoke.test.js   # artifact 4
test/browser/golden_save.test.js  # artifact 1
test/fixtures/golden_save.json    # committed fixture savegame
```

`test/rng.determinism.test.js` and its fast, no-install CI job are untouched.

### How the test reaches into the game

`ModLoader.exposeExports()` ([modloader.js:138](../../../src/js/mods/modloader.js:138)) assigns every export
under `src/js` onto `window.shapez`. From Playwright, `window.shapez.GameCore`,
`window.shapez.SavegameSerializer`, `window.shapez.globalConfig` and everything else are directly reachable.
No test hooks are added to production source. The same `require.context` that makes a small bundle impossible
is what gives the browser harness its API surface.

### Dev bundle, not prod bundle

`exposeExports()` is gated on `G_IS_DEV || G_IS_STANDALONE`
([modloader.js:111](../../../src/js/mods/modloader.js:111)), and
[webpack.production.config.js:27](../../../gulp/webpack.production.config.js:27) hardcodes
`G_IS_DEV: "false"`. So `window.shapez` exists in the dev bundle and not in the web prod bundle. This splits
the two artifacts:

- **Golden-save hash — dev bundle**, because it needs `window.shapez`. Also preferable on its own merits:
  `assert` calls are live in dev builds, so a violated invariant fails loudly rather than passing quietly.
- **Boot smoke test — either bundle**, because it only makes DOM-level assertions (did the main menu render,
  were there uncaught errors).

Both run against the dev bundle for now. **Stage 1 should extend the smoke test to also boot a prod bundle** —
that is the variant Stage 1 is most likely to break, and by then the job already exists.

Rejected alternative: adding a test-only export hook so the prod bundle exposes what the hash test needs. It
puts test scaffolding into shipped code, and the thing under measurement is simulation logic, which is
identical in both bundles.

## Determinism controls

Every wall-clock and randomness source reaching the hashed state was traced. Two are non-issues:

- **`DynamicTickrate` does not actually adapt.** It reads `performance.now()` in `beginTick`/`endTick`, but
  the adaptive adjustment is commented out
  ([dynamic_tickrate.js:108-114](../../../src/js/game/dynamic_tickrate.js:108)) and
  `increaseTickRate`/`decreaseTickRate` have no live callers anywhere in `src/js`. `currentTickRate` is set
  once at construction and never changes. The clock readings feed only `capturedTicks` and
  `averageTickDuration`, neither serialized nor feeding anything serialized.
- **`Math.random()` is not on the logic path.** Four occurrences in all of `src/js/game/`: two in
  `camera.js` (screen shake; camera is excluded from the hash), one in
  [core.js:515](../../../src/js/game/core.js:515) inside a `simulateSlowRendering` debug block on the *draw*
  path, one in a puzzle-mode HUD part.

Four hazards are real, each with a named lever:

**1. The ambient frame loop.** The game drives itself through `app.ticker`
([application.js:168](../../../src/js/application.js:168)); letting the browser decide how many ticks elapsed
is nondeterministic by construction. Lever: `app.ticker.frameEmitted.removeAll()` (and `bgFrameEmitted`)
after boot — `Signal.removeAll()` exists at [signal.js:73](../../../src/js/core/signal.js:73).
`requestAnimationFrame` keeps spinning harmlessly; the game stops advancing on its own.

**2. `GameTime.realtimeSeconds`** — a `types.float` in the serialized schema
([game_time.js:47](../../../src/js/game/time/game_time.js:47)) sourced from `performance.now()`. This is the
field that made the previous spec's hash subset nondeterministic by construction. Two independent controls,
deliberately both:

- The harness ticks via `root.time.performTicks(deltaMs, () => core.updateLogic())`, not `core.tick()`.
  `updateRealtimeNow()` is called only from `core.tick` ([core.js:282](../../../src/js/game/core.js:282)), so
  `realtimeSeconds` holds its fixture value. `performTicks` is the real stepping code the game itself uses,
  and `timeSeconds` still advances by the correct fixed `deltaSeconds` per tick — the simulation sees a
  normally-advancing clock, not a frozen one.
- `realtimeSeconds` is excluded from the hashed subset regardless, so the hash survives someone later
  reintroducing a frame into the measured window.

**3. Tick rate derives from a user setting.** `DynamicTickrate`'s constructor reads
`app.settings.getDesiredFps()` ([dynamic_tickrate.js:31](../../../src/js/game/dynamic_tickrate.js:31)),
feeding `deltaSeconds`, feeding `timeSeconds`, which is hashed. A fresh browser profile yields the default,
but the harness pins it explicitly rather than depending on the default never changing.

**4. `globalConfig.debug` is per-developer and gitignored.** `config.local.js` is generated from
`config.local.template.js` and never committed, so flags differ per checkout. Several change simulation
output outright: `instantBelts`, `instantProcessors`, `instantMiners`, `disableEjectorProcessing`,
`disableLogicTicks`, `framePausesBetweenTicks`. A developer who left `instantBelts` enabled while debugging
gets a different hash from CI with no indication why. Lever: before hashing, assert those flags are falsy via
`window.shapez.globalConfig.debug` and fail naming the offending flag.

**Ticks must be proven to have happened.** `internalAddDeltaToBudget` zeroes the logic budget when
`root.hud.shouldPauseGame()` is true ([game_time.js:87](../../../src/js/game/time/game_time.js:87)). If the
harness lands in a paused state, `performTicks` runs zero ticks and the test would hash an un-ticked save and
pass. The harness asserts the tick count actually advanced before hashing. This is the same class of
silent-success bug the previous review caught in the old spec's fake `Application`.

## What gets hashed

The subset [phase-1.md](../../roadmap/phase-1.md) specifies from
`SavegameSerializer.generateDumpFromGameRoot()`: `map`, `entityMgr`, `entities`, `beltPaths`, `hubGoals`,
`time`, `gameMode` — **minus `time.realtimeSeconds`**. Explicitly excluded, per the same policy: `camera`,
`pinnedShapes`, `waypoints`, `modExtraData`.

Serialize with stable key ordering before hashing so the value does not move on harmless key reordering.
Compare against a committed reference constant, following the `SEED_42_FIRST_5` precedent already set by
`test/rng.determinism.test.js`: **never regenerated to make CI green.** A change there means determinism
broke, and that is the finding.

## Fixture savegame

Generated once by a harness mode that constructs a small state through the real building/entity APIs and dumps
the serializer's JSON, then committed to `test/fixtures/golden_save.json`. Built in code rather than captured
from live play so it is reproducible, and loaded through the deserialize path so nothing depends on
`Math.random()` at test time. Kept small deliberately, for CI speed.

`Savegame.getCurrentVersion()` is currently `1010`
([savegame.js:58](../../../src/js/savegame/savegame.js:58)). When the save format version next bumps,
migrating the fixture is a deliberate, reviewed step — the same rule that governs regenerating the hash.

## Build and CI

`res_built/` is gitignored and absent from a fresh checkout, so the atlas must genuinely be built. The dev
bundle requires: `build.prepare.dev` (cleanup, localConfig, atlas, sounds, translations, css) →
`js.web-localhost.dev` → `html.web-localhost.dev`.

Test scripts split so the fast job stays fast — `test/browser/**` would otherwise be swept into the existing
`yarn test` glob:

```
yarn test          # node --test "test/*.test.js"           — seconds, no install
yarn test:browser  # node --test "test/browser/**/*.test.js" — build + Playwright
```

A new CI job runs `yarn test:browser` on `ubuntu-latest`, expected in the 5–10 minute range. The existing
`test` and `yaml-lint` jobs are untouched.

### Risks, in priority order

**1. The atlas build fails silently.** [image-resources.js:75-113](../../../gulp/image-resources.js:75) wraps
the whole task in `try { ... } catch { console.warn("Building atlas failed...") }` and then calls `cb()` — a
*successful* task callback. If Java is missing or the 22MB texture-packer jar fails to download, the build
reports success and produces a bundle with no sprites, and the smoke test fails somewhere confusing.
Mitigation: assert `res_built/atlas/` is non-empty immediately after the build step, before launching a
browser.

**2. The atlas build has never run in this repo's CI.** The current `CI` job runs only
`translations.fullBuild` and `localConfig.findOrCreate`; `imgres.buildAtlas` has never executed there. It
shells out to `java -jar` and downloads the jar, attempting `wget` then `curl` before the Windows-only
fallbacks, so ubuntu should work and GitHub's runner ships Java — but "should work" is the class of claim
that has already cost this project one spec. **Verify this in CI first, before any test code is written.**
Cache the jar so it is not re-downloaded per run.

**3. Node version.** Webpack 4 cannot run on Node 17+ without `NODE_OPTIONS=--openssl-legacy-provider`;
without it the build dies with `error:0308010C:digital envelope routines::unsupported`. The existing `CI` job
avoids this only by pinning Node 16. Run the new job on Node 22 — which `node:test` and Playwright want — and
set the flag on the build step alone rather than juggling two Node versions in one job. The flag disappears
at Stage 1.

## Implementation order

Two branches, each green on its own, per the repo's git convention:

1. **Smoke test first.** Build in CI, launch a browser, assert the main menu renders with no uncaught errors.
   This proves the entire pipeline — atlas, sounds, bundle, browser, CI — and delivers Stage 0's artifact 4.
   If risk 2 bites, it bites here, cheaply, before any hash work exists.
2. **Hash test second**, on a substrate already proven to work.

This inverts phase-1.md's artifact numbering. That is intentional and costs no standing-decision change: the
roadmap lists four deliverables without fixing their order.

## Out of scope

- **Draw-call recording and the perf benchmark** (artifacts 2 and 3). Both are expected to reuse this
  harness — artifact 2 needs a running game plus a stubbed render context, artifact 3 needs real frame rates
  and therefore real rendering — but each gets its own spec.
- **Cutting the `savegame.js -> modloader.js` edge.** Recorded above as a Stage 4 target.
- **A prod-bundle hash test.** Simulation logic is identical across bundles; only the smoke test benefits from
  prod coverage, and that is Stage 1's extension.

## Open items for implementation

- Exact tick count for the fixture run — small enough for CI speed, large enough to exercise belt and item
  movement across several cycles.
- Exact composition of the fixture's starting state.
- Which Playwright browser to pin, and whether to cache the browser download in CI.
- Confirm the smoke test's "reached main menu" assertion is stable against the preloader's timing rather than
  racing it.
