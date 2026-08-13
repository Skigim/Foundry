# Stage 0 golden-save simulation hash — design

**Status: SUPERSEDED.** Approved in-session, then sent to an independent review before implementation, which
found the core premise doesn't hold — `src/js` cannot be imported under plain Node at all (webpack-only
module resolution and build-time code stripping, unrelated to browser globals), and two correctness bugs
besides. Confirmed empirically, not just asserted. Kept here for its reasoning, not as something to
implement as written — see [docs/handoff.md](../../handoff.md)'s "Next step" and "Open questions" sections
for what actually happened and the three alternative strategies now under consideration. The one part of
this doc still believed correct: reuse the real `initializeRoot()` construction path rather than hand-write
a parallel one, to avoid test/reality drift — the failure was underestimating what "reuse it" costs, not the
principle itself.

Brainstormed 2026-08-12. Implements the second of Stage 0's four artifacts (see
[phase-1.md](../../roadmap/phase-1.md)); the first (`test/rng.determinism.test.js`) is already done.

## Goal

Load a fixed savegame, run a fixed number of simulation ticks, hash a defined subset of the resulting
serialized state, and compare against a committed reference hash — in CI, on plain Node, with the same
`node:test` runner the RNG determinism test already uses. This is the artifact that (transitively) protects
Stages 1, 2, and 4 against silent simulation-behavior regressions, and empirically tests the README's
determinism claim ("identical results from identical inputs").

## Problem: the code assumes it's running in a browser

The natural way to build a running game (`GameCore.initializeRoot()`, [core.js](../../../src/js/game/core.js))
pulls in several things that only exist in a browser, discovered by tracing the actual construction path
rather than assuming:

- **`window.assert`** — [assert.js](../../../src/js/core/assert.js) installs `assert` onto `window` as an
  import side effect. Used pervasively through game/systems code, not just RNG (which is why the existing
  RNG test explicitly scoped around it — see its header comment).
- **Webpack `DefinePlugin` globals** (`G_IS_DEV`, `G_IS_STANDALONE`, `G_IS_STEAM_DEMO`, etc.) — bare
  identifiers that only exist because webpack textually substitutes them at bundle time. `core.js` alone
  references `G_IS_DEV` 8 times.
- **`require.context`** (webpack-only) at two call sites with very different weight:
  - [component_registry.js:56](../../../src/js/game/component_registry.js:56) — only inside a *sanity-check
    assertion* (does the file count under `./components` match the registered count). The actual
    registration is a plain hardcoded array of ES imports two lines above. Trivial to drop or guard; zero
    functional impact. **This is in scope for this work** — `initComponentRegistry()` has to run for
    `entityMgr`/`systemMgr` to work at all, and `require.context(...)` throws in Node regardless of the
    assert's outcome (JS evaluates arguments eagerly, so the crash happens before the condition is even
    checked). Fix: guard the assertion (e.g. skip it when `typeof require.context !== "function"`), same as
    Stage 0's "known obstacle" text already proposed. This is a small, real change to production source
    (`component_registry.js`), not purely test-only harness code — calling that out explicitly since it's a
    different category of change than everything else in this spec.
  - [modloader.js:114](../../../src/js/mods/modloader.js:114) — real functionality (flattens exports onto
    `window.shapez` for mod access), gated behind `G_IS_DEV`/`G_IS_STANDALONE`. `GameCore.initializeRoot()`
    does not call into `ModLoader` itself — that happens in `Application.boot()`, which this harness never
    calls (see Approach A below). Expected to be moot for this test; confirm during implementation that no
    code path under test reaches it.
- **Real DOM** — `internalInitCanvas()` ([core.js:220-262](../../../src/js/game/core.js:220)) calls
  `document.createElement("canvas")` directly. `GameHUD.initialize()`
  ([hud.js:95-101](../../../src/js/game/hud/hud.js:95)) builds a real DOM fragment and appends it to
  `document.body`. Both run unconditionally as part of `initializeRoot()`, even though neither is needed by
  the logic tick itself (`updateLogic()` only touches `entityMgr.update()` and `systemMgr.update()`).

## Decision: call the real construction path, shim only the browser-only pieces

Considered and rejected: hand-writing a parallel, simplified root-construction function that skips
`GameMode`/`HUD`/`camera` entirely. Rejected because it becomes a second copy of "how to build a
`GameRoot`" that can silently drift from the real one as the real one changes over time — defeating the
point of a determinism check.

Also considered and rejected: using `jsdom` as the DOM stand-in. Initially discarded over a concern about
interaction with the planned Stage 2 TypeScript migration; on inspection that concern doesn't hold — `jsdom`
would be test-only, ships its own types, and is orthogonal to whether `src/js` is `.js` or `.ts` (the thing
Stage 0's notes actually warn about staying stable across Stage 1/2 is the *test runner*, not test-only
libraries). Set aside anyway in favor of a hand-rolled shim for its own, independent reasons: zero new
dependencies (matching the existing test's precedent and the project's anti-bloat test philosophy), and a
hand-rolled fake can be made to fail loudly the instant something touches a DOM feature it doesn't cover —
where `jsdom`'s fuller implementation might quietly let an unexpected touch through.

**Chosen approach:** call `GameCore.initializeRoot(parentState, savegame, gameModeId)` completely
unmodified. Supply three hand-rolled, purpose-built fakes for the objects it reads from:

1. **Fake `document`/canvas.** Supports `createElement`, `createDocumentFragment`, `appendChild`,
   `classList.toggle`, `setAttribute`. The returned canvas's 2D context stub throws immediately on any real
   drawing call (`fillRect`, `drawImage`, etc.) — a logic-only tick should never legitimately reach one, so
   if it does, that's a hidden dependency worth surfacing loudly rather than silently absorbing.
2. **Fake `parentState`** (stand-in for `InGameState`). Only the fields `initializeRoot()` /
   `internalInitCanvas()` actually read: `keyActionMapper`, `inputReciever`, `getDivElement()` (returns the
   fake DOM node), `creationPayload` (carries `gameModeParameters`).
3. **Fake `Application`.** Thin. `settings.getAllSettings()` returns `{}` — safe because every call site
   found (including `GameHUD.initialize()` reading `.vignette` / `.enableColorBlindHelper` at
   [hud.js:76-80](../../../src/js/game/hud/hud.js:76), which is during init, not just draw, correcting an
   earlier assumption made mid-brainstorm) treats a missing setting as falsy/disabled rather than crashing.
   Any other `app.*` field the init path turns out to read gets stubbed the same way; exact list finalized
   during implementation.

This means there is only ever one code path for "how to build a `GameRoot`," in both the browser and the
test — eliminating "does the test's version match the real one" as an open question by construction, rather
than by inspection.

## Fixture savegame

No fixture exists yet (`test/` currently only has the RNG test). Built in code, not captured from real play:
a small setup step constructs a minimal game state through the real building/entity APIs (a hub, a handful
of belts, a producer or two — kept small deliberately for CI speed), then serializes it once via
`SavegameSerializer` and commits the resulting JSON (e.g. `test/fixtures/golden_save.json`). Loaded through
`initExistingGame()`'s deserialize path (not `initNewGame()`), so map seed and all entity state come from
the committed fixture — nothing depends on `Math.random()` at test time.

## What gets hashed

The subset phase-1.md already specifies from the serializer's dump: `map`, `entityMgr`, `entities`,
`beltPaths`, `hubGoals`, `time`, `gameMode`. Explicitly excludes `camera`, `pinnedShapes`, `waypoints`,
`modExtraData` (UI/render state that would make the hash falsely brittle).

Run a fixed, small number of ticks via the real `updateLogic()` (exact count finalized during
implementation; small enough to keep CI fast, large enough to exercise belt/item movement across several
cycles — a few hundred is a reasonable starting point). JSON-serialize the hashed subset with **stable key
ordering** before hashing, so the committed hash doesn't false-positive on harmless key-order differences
rather than an actual behavior change. Compare against a committed reference hash constant in the test file,
following the same pattern the RNG test already established (`SEED_42_FIRST_5`-style — never regenerated
just to make CI pass; a change there means determinism broke, and that's the finding).

## File layout

- `test/helpers/headless_root.js` — the three shims and the `initializeRoot()`-calling construction helper,
  shared/reusable by later Stage 0 artifacts if useful (e.g. draw-call recording will need its own render
  context but may reuse the same root-construction helper).
- `test/fixtures/golden_save.json` — the committed fixture savegame.
- `test/golden_save.hash.test.js` — the test itself: load fixture, tick, hash, compare.

## Explicitly out of scope for this work

- **Real-browser parity cross-check.** Discussed as a way to prove the Node harness genuinely matches real
  browser behavior (run the same save through both, compare hashes) — deferred to piggyback on the
  boot-smoke-test artifact, which already needs a headless browser, rather than standing up separate browser
  automation just for this.
- The other three Stage 0 artifacts (draw-call recording, perf benchmark, boot smoke test) — this spec is
  scoped to the golden-save hash only.

## Open items to resolve during implementation

- Exact tick count for the fixture run.
- Exact `Application` field surface beyond `settings.getAllSettings()`, discovered by running the harness
  and extending the fake as needed (by design — see "fail loudly" above).
- Confirm `modloader.js`'s `require.context` call site is genuinely unreached from this test's code path.
