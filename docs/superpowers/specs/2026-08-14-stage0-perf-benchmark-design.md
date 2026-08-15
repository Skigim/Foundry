# Stage 0 perf benchmark — design

Written 2026-08-14. Implements the third of Stage 0's four artifacts (see
[phase-1.md](../../roadmap/phase-1.md)); artifacts 1 (golden-save hash) and 4 (boot smoke test) are done and
enforced in CI, artifact 2 (draw-call recording) is outstanding and this spec has a hard dependency on it.

## Goal

Produce a tracked number — not a pass/fail assertion — that shows whether the engine's rendering cost per
frame has moved. It proves Stage 3 (the centralized draw loop) did something, and catches Stages 1–2
silently regressing rendering on the way there.

The target profile is fixed by phase-1.md: [shapez.io#1471](https://github.com/tobspr-games/shapez.io/issues/1471)'s
regression save, ~77k belts / ~43k buildings, which dropped 30fps → 4fps while update-loop time stayed flat
at ~14ms/60UPS. tobspr's diagnosis on [#1021](https://github.com/tobspr-games/shapez.io/issues/1021) names
the cause: every `GameSystem` redraws by iterating all on-screen entities and re-checking component matches,
instead of one consolidated pass. That is what the metric below has to be sensitive to.

## Blocking finding: the existing harness deliberately does not render

Artifacts 1 and 4 reuse `prepareDeterministicRun` + `runTicks`. **Artifact 3 cannot**, and the reason is
structural rather than incidental:

- `prepareDeterministicRun` detaches the frame loop outright —
  [harness.js:413-414](../../../test/browser/harness.js:413) calls `app.ticker.frameEmitted.removeAll()` and
  `bgFrameEmitted.removeAll()`. Nothing drives rendering afterward.
- `runTicks` steps `core.updateLogic()` only ([harness.js:466](../../../test/browser/harness.js:466)). It
  never reaches `GameCore.draw()` ([core.js:371](../../../src/js/game/core.js:371)).

Both choices are correct for a simulation-determinism hash and exactly wrong for a rendering benchmark. So
this artifact needs its own driver — `renderFrames(page, n)` — parallel to `runTicks`, sharing
`launchGame` / `waitForMainMenu` / `loadFixtureGame` and nothing else from the stepping path.

Two further mechanics the driver has to handle, both verified in source:

- **`shouldRender()` can skip the draw entirely.** [core.js:304](../../../src/js/game/core.js:304) returns
  early unless `root.queue.requireRedraw` or one of its other conditions holds. A fixture that reaches
  steady state could measure a no-op. The driver must force a redraw per frame and assert it actually drew.
- **Zoom decides which renderer runs.** `getIsMapOverlayActive()` is `zoomLevel < 0.9`
  ([camera.js:298](../../../src/js/game/camera.js:298),
  [config.js:75](../../../src/js/core/config.js:75)). Below the threshold the map draws cheap chunk-overview
  sprites instead of per-entity draws — a different code path, not a cheaper version of the same one. Camera
  zoom and position are therefore fixture parameters, pinned and recorded with every number.

## What gets measured: two classes, only one of them assertable

CI runs on shared `ubuntu-latest` runners with headless Chromium and software rasterization. Wall-clock frame
time there carries enough run-to-run noise that a "tracked number" would not be trackable. Splitting the
metric resolves this:

**1. Deterministic counters — the real artifact.** Draw calls issued per frame, entities visited per draw
pass, belt paths iterated. Functions of the code and the fixture rather than the hardware, so they can be
committed and compared like the golden hash — and they move on exactly the change Stage 3 makes, where frame
time on a fast GPU might barely budge.

This is the hard dependency on artifact 2, which is the instrumentation that produces these counts. Artifact
2 lands first, or the two share one recorder; a second parallel render-context stub would be the same
test/reality drift the golden-save spec rejected.

**2. Wall-clock timings — recorded, never asserted.** Median / p95 / worst frame time, plus the
`updateLogic` vs `draw` split. Written to a run artifact with the build configuration attached, per
phase-1.md's constraint that Stage 1 changes optimization characteristics and numbers across it are not
comparable. Meaningful on a real GPU; advisory in CI.

Note that `dynamicTickrate.averageFps` is a rolling one-second mean
([dynamic_tickrate.js:7](../../../src/js/game/dynamic_tickrate.js:7)) and will smooth away exactly the
hitches worth catching. Sample raw frame deltas; do not read `averageFps`.

## Fixture: generated at scale, not captured from play

**Generated, following [generate_fixture.js](../../../test/browser/generate_fixture.js)'s established
pattern** — place buildings through the real `root.logic.tryPlaceBuilding` API in a headless browser, warm
up, then serialize via `SavegameSerializer.generateDumpFromGameRoot`. That path yields a current-version dump
by construction and sidesteps the save file's checksum/compression layer entirely. Fixtures are committed in
the same `{ savegameVersion, dump }` shape `loadFixtureGame` expects, with its version guard at
[harness.js:279](../../../test/browser/harness.js:279).

Generated rather than hand-built because the target is ~120k entities — not something anyone builds by hand
and can then reproduce.

**Empirical note on scale.** A hand-built save measured 2026-08-14 came to 3,496 entities, two-thirds of them
belt: **~3% of the target profile on both axes**. It ran 78fps / 1.19ms tick zoomed in, and 135fps / 0.96ms
zoomed out past the overview threshold — comfortably healthy, and confirmation that a factory that size
cannot exhibit what this artifact tracks. Useful as a shape reference, not as the perf fixture.

Two sizes, both generated by one script:

- **`perf_save_small`** — a few thousand entities, sized so a CI run stays inside the existing browser-test
  job's budget. This is what runs on every push.
- **`perf_save_full`** — #1471's profile, ~77k belts / ~43k buildings. Too slow for per-push CI. Run on
  demand and on a schedule; this is the one that proves Stage 3.

## File layout

- `test/browser/generate_perf_fixture.js` — one-shot generator, parameterized by target entity count, in the
  style of the existing `generate_fixture.js` (including its refuse-to-write sanity guards).
- `test/fixtures/perf_save_small.json`, `test/fixtures/perf_save_full.json`
- `test/browser/harness.js` — gains `renderFrames(page, n)` alongside `runTicks`, plus camera pinning.
- `test/browser/perf_benchmark.test.js` — loads a fixture, pins camera, renders N frames, asserts the
  committed counters, writes timings to a run artifact.

## Explicitly out of scope

- **Asserting wall-clock numbers.** Recorded and reported only. A timing assertion on a shared CI runner
  becomes a flaky test, and phase-1.md's anti-bloat policy is explicit that a falsely brittle test gets
  disabled within a month.
- **Fixing anything.** This artifact measures. The centralized draw loop is Stage 3.
- **GPU/WebGL rendering paths.** Canvas2D as it exists today. A renderer swap is a later stage and will need
  its own baseline anyway.
- **The other three Stage 0 artifacts.**

## Open items to resolve during implementation

- Frame count per run — large enough to be stable, small enough for CI. Needs measuring, not guessing.
- Exact counter set, which artifact 2's recorder shape determines.
- Entity count for `perf_save_small`, set by the observed CI job budget.
- Whether the generator can reach ~120k entities in reasonable wall time via `tryPlaceBuilding`, or whether
  the full fixture needs a batched construction path. Unknown until tried; if `tryPlaceBuilding` proves too
  slow at that scale, the fallback is direct entity construction plus a validation pass that the result
  deserializes and ticks identically.
- Whether the full-size fixture is committed to the repo or generated on demand in the job that uses it. A
  ~120k-entity JSON dump may be large enough that committing it is its own problem; measure before deciding.
