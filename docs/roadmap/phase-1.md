# Phase 1 — Modernize Shapez Classic (sequenced)

This breaks [README.md](../../README.md)'s "Phase 1" into an ordered set of stages. The README lists five
sub-goals (improve architecture, expand blueprints, improve UI/UX, continue performance optimizations,
clean engine boundaries); those are outcomes, not a work order. This document is the work order.

Each stage is a separate sub-project and will get its own design spec and implementation plan when it
starts. This document only fixes **what order they happen in and why** — do not treat the per-stage task
lists here as complete specs.

## Ordering principle

**Dependency-first.** Stages are ordered by what unblocks what, not by visibility or effort. The explicit
trade-off: Stages 0–2 produce no user-visible change. This is accepted to avoid building blueprint and
UI/UX work on abstractions that Stage 4 would then invalidate.

**Foundry is a hard fork of Shapez Community Edition.** There is no intent to stay rebaseable on CE, so
restructuring, renaming, and breaking the current mod API are all permitted. CE remains useful as
*reference material to read and reimplement*, never as code to merge. Per-stage CE notes below flag what's
worth reading.

## Stage 0 — Baseline & safety net

**Why first:** the repo has no automated test suite (CI runs lint + `tsc` + yamllint only). Every stage
after this rewrites code that can silently change simulation behavior, and Stage 3 makes a performance
claim that needs before/after numbers. Nothing downstream is safe to start until regressions are
detectable.

**Deliverables — four artifacts, not a test suite:**

1. **Golden-save simulation hash.** Load a fixed savegame, run N ticks, hash the resulting *simulation*
   state, compare against a committed hash. One test; transitively protects Stages 1, 2, and 4.
2. **Draw-call recording.** Stub the render context and record the *sequence of draw operations* for a
   fixed save + camera position. Catches missing or reordered draws without pixel diffing (which is
   expensive and flaky). Exists specifically for Stage 3.
3. **Perf benchmark.** A tracked number, not a pass/fail assertion. Target profile comes from the
   real-world regression in [shapez.io#1471](https://github.com/tobspr-games/shapez.io/issues/1471):
   ~77k belts / ~43k buildings, which dropped 30fps → 4fps while update-loop time stayed flat
   (~14ms/60UPS). Proves Stage 3; guards Stages 1–2 against silent regressions.
4. **Boot smoke test.** The *built* artifact launches, loads a save, ticks, and does not crash. Exists
   specifically for Stage 1, where failures are bundle-level rather than logic-level.

**Status.** Artifacts 4 (boot smoke test) and 1 (golden-save simulation hash) landed 2026-08-12 as
`test/browser/boot.smoke.test.js` and `test/browser/golden_save.test.js`, both running against a real dev
bundle in a real browser via `test/browser/harness.js` and enforced by CI's `browser-test` job. The
substrate is specified in
[docs/superpowers/specs/2026-08-12-stage0-browser-harness-design.md](../superpowers/specs/2026-08-12-stage0-browser-harness-design.md);
artifacts 2 and 3 are expected to reuse the same harness but each needs its own spec. The current fixture (a
miner feeding a belt run) exercises mining, belt item movement, and belt-to-belt handoff; it does not yet
cover item processors, splitters/mergers, storage, wires, or hub delivery/goal progression — a broader
fixture remains a future addition, not yet required by the anti-bloat policy's premise below. **Done when**
is not yet met: artifacts 2 (draw-call recording) and 3 (perf benchmark) remain outstanding.

**Anti-bloat policy (binding for all of Phase 1):**

- **No unit tests for game logic.** Per-building or per-system unit tests would need updating on every
  balance change while protecting against risks that are not in this roadmap. The simulation hash covers
  that behavior transitively at one assertion. Stage 5 feature work gets targeted tests for its own new
  logic; that is the only exception.
- **The hash covers simulation state only.** Including rendering, UI, or camera state makes it falsely
  brittle, and a falsely brittle test gets disabled within a month.
- **The golden saves are the maintenance burden, not the test code.** Keep a small fixed set — one small
  save for CI speed, one large save for the perf benchmark, one wires/logic-heavy save (the most
  determinism-sensitive area). Version them.
- **Regenerating a committed hash is a deliberate, reviewed act.** If a change legitimately alters
  simulation output, the new hash is part of that change's review. Never regenerate as a reflex to make
  CI green.

**Future-proofing constraints.** This stage is written before the build swap and the TypeScript migration,
so it must be built so neither invalidates it:

- **Hash the serializer's output, not in-memory state.** `SavegameSerializer.generateDumpFromGameRoot()`
  (`src/js/savegame/savegame_serializer.js`) is a stable, versioned contract; live entity/component objects
  are not. A hash that walks object internals moves on Stage 2 renames and Stage 4 code moves for
  non-semantic reasons — it cries wolf, then gets disabled. Hash a **subset** of the dump: `map`,
  `entityMgr`, `entities`, `beltPaths`, `hubGoals`, `time`, `gameMode`. Explicitly exclude `camera`,
  `pinnedShapes`, `waypoints`, and `modExtraData`, which the same dump carries but which are UI/render
  state per the policy above.
- **Record draw calls at the render-context boundary, not the system boundary.** Stage 3 deletes the
  per-system draw structure, so a recording keyed on "which `GameSystem` drew this" is worthless
  afterward. Record operations against `DrawParameters` / the 2D context instead. Expect Stage 3 to
  *legitimately* reorder draws — the assertion is "nothing vanished or moved," not "identical sequence."
- **Pick a TypeScript-native, bundler-independent test runner.** Routing tests through the current webpack
  pipeline means Stage 1 invalidates them; a JS-only setup means Stage 2 does. One choice avoids both.
- **Record the build configuration alongside each benchmark number.** Stage 1 changes optimization
  characteristics, so numbers taken before and after it are not directly comparable.

**Known obstacle:** `require.context` (a webpack-only API) is called at registration time in
`src/js/game/component_registry.js:56` and `src/js/mods/modloader.js:114`, so the component registry cannot
be loaded outside a webpack-compatible bundler as-is. Options: shim it, pick a Stage 1 bundler that retains
webpack compatibility (Rspack does — a point in its favor), or drop the assert. If it turns out the
simulation cannot be loaded at all without the full app bundle, that is not merely an obstacle: it is an
early, cheap measurement of how entangled the engine/content boundary really is — Stage 4's problem
surfacing at the best possible time.

**Note — this stage validates the project's premise, and so far it holds.** The README states "the
simulation should always produce identical results from identical inputs." Two separate checks confirm
this for the one fixture and tick count measured so far (a miner + 20 belts, 600 ticks at a pinned 60 UPS):
same-machine self-consistency (two independent `launchGame()` runs on Windows produced byte-identical
dumped state, not just matching hashes) and cross-platform reproduction (the reference hash, pinned from
that Windows run, matched exactly on `ubuntu-latest` in CI — see
[docs/handoff.md](../handoff.md#empirical-constraints)). Neither result generalizes beyond what was
measured: a larger save, a different tick count, or a different platform pair could still diverge, and this
note should be revisited if one ever does.

**Done when:** all four artifacts run in CI, and the determinism claim is either confirmed or documented
as not-yet-true with known causes.

## Stage 1 — Build tooling

**Why here:** self-contained (touches no game logic) and everything downstream benefits. Must precede
Stage 2 because modern bundlers handle `.ts` natively, removing a step from the TypeScript migration — and
because a large migration at ~10s rebuilds is untenable.

**Work:** replace webpack 4 for JS bundling; collapse the two-yarn-tree layout (root + `gulp/`) documented
in [CLAUDE.md](../../CLAUDE.md).

**Critical scoping constraint:** `gulp/` does far more than bundling — image atlas generation, sound
sprites, translation builds, electron packaging, and steampipe upload all live there. Replace the JS
bundling step, keep the asset pipelines running, and retire gulp incrementally. Treating "replace the
bundler" as "replace gulp" will stall this stage.

**Highest-risk items** (all bundle-level, which is why Stage 0's smoke test exists): `DefinePlugin`
constants (`G_IS_STANDALONE` and friends — see CLAUDE.md's footgun note), the `typehints` strip-block
loader (`gulp/loader.strip_block.js`), worker loading (`src/js/webworkers/`), and asset/atlas resolution.

**CE note:** CE replaced Webpack with Rspack in
[PR #119](https://github.com/tobspr-games/shapez-community-edition/pull/119) — release builds ~10s → ~1s,
dev/HMR ~5s → ~250ms. Their config is the single most directly useful thing to read from CE. Reimplement,
do not merge.

**Done when:** one dependency tree, sub-second incremental dev rebuilds, all build variants
(`gulp/build_variants.js`) still produce working artifacts, smoke test green.

## Stage 2 — TypeScript migration

**Why here:** after fast builds, before structural work. Types are the safety net for Stages 3 and 4;
doing the structural work first means doing the dangerous part blind.

**Starting position is better than it looks:** `src/js` is already JSDoc-annotated and checked by
`tsc --checkJs` with `strictFunctionTypes`, `noImplicitThis`, and `alwaysStrict` (see
`src/js/tsconfig.json`). This is a conversion, not an introduction of types.

**Order within the stage:** config and leaf modules → `src/js/core/` → `src/js/game/` systems and
components → `src/js/states/` and UI. Keep `allowJs: true` throughout so the tree stays buildable at every
commit.

**Cleanup this unlocks:** the `/* typehints:start */ ... /* typehints:end */` blocks collapse into real
imports, and the strip-block loader can be retired.

**Primary risk:** mechanical conversion silently changing runtime semantics (`this` binding, default/named
import interop, property initialization order). The compiler catches most of it; Stage 0's simulation hash
catches the rest.

**CE note:** CE is also migrating to TypeScript plus a custom JSX/TSX runtime (`src/js/jsx-runtime.ts`, not
React). Verified as early/infrastructure-stage — their root `tsconfig.json` still only type-checks build
scripts. Read their approach for ideas; do not assume it is proven.

**Done when:** `src/` is `.ts`, the strip-block loader is gone, and the typecheck passes at equal or
stricter settings than today.

## Stage 3 — Rendering overhaul

**Why here:** it touches every system's draw path, so it wants Stage 2's types; and it makes a performance
claim, so it wants Stage 0's benchmark. This is Phase 1's first user-visible payoff.

**The change:** replace per-system entity iteration in the draw path with a centralized, layer-based draw
loop. This is not a novel idea — it is the original author's own diagnosis in
[shapez.io#1021](https://github.com/tobspr-games/shapez.io/issues/1021): each `GameSystem` redraws by
iterating all on-screen entities and re-checking component matches, instead of one consolidated pass.
tobspr proposed the centralized layer-based draw loop as the fix.

**Why it matters beyond performance:** #1471 confirms the bottleneck is rendering, not simulation — update
time stayed flat while framerate collapsed. Centralizing the draw path also pulls rendering out of the
per-system code where it is currently smeared, which is what makes Stage 4 tractable.

**Correctness is checked by draw-call recording, not the simulation hash** — this stage does not change
simulation state, so the hash will (correctly) not move.

**CE note:** as far as research found, CE has *not* implemented this. No matching merged PR exists. This
is an unclaimed, well-specified, high-value target and is Foundry's clearest differentiator in Phase 1.

**Done when:** centralized draw loop is in place, draw-call recording shows no unintended changes, and the
benchmark shows a measured improvement on the large-save profile.

## Stage 4 — Engine boundary definition

**Why here — deliberately after Stage 3.** Drawing the engine/content seam is far easier once rendering is
centralized rather than distributed across every `GameSystem`. Doing this stage first would mean drawing
the boundary through code that Stage 3 then moves.

**Work:** formalize what is engine (simulation, rendering, ECS, save/load, state management) versus what is
content (buildings, items, recipes, levels, progression). Make the registry/factory pattern
(`src/js/core/global_registries.js`, `factory.js`, `singleton_factory.js`) the *sole* content-registration
path, and document the boundary as an enforced contract rather than a convention.

**Scope limit:** this stage *defines and enforces* the boundary. Physically extracting the engine into a
separate package is Phase 2 — do not start it here.

**Risk:** moving code shifts registration order and building IDs. Stage 0's golden-save hash is the check —
building codes (`src/js/game/building_codes.js`) are serialized into savegames, so ID drift surfaces there
rather than needing a separate assertion.

**CE note:** CE's "Mod V2" work ([issue #52](https://github.com/tobspr-games/shapez-community-edition/issues/52))
— ASAR packaging, static metadata instead of runtime eval, a `mod://self/...` asset protocol, declared mod
dependencies — is the most relevant prior art for where the boundary should sit. Read it as design input.
A Foundry mod API redesign is explicitly **out of scope for Phase 1** (see below).

**Done when:** the engine/content split is documented, registries are the only content-registration path,
and no content module reaches into engine internals.

## Stage 5 — Blueprints & UI/UX

**Why last:** both are content-layer work that would need rework if built on pre-Stage-4 abstractions. By
this point the codebase is also materially easier to contribute to (fast builds, real types, documented
boundaries), which matters if the goal includes attracting contributors.

**Work:** the README's "expand blueprint functionality" and "improve UI/UX" goals, designed properly rather
than patched. Specifics get their own spec when this stage starts.

**CE note:** CE's blueprint work is thin — incremental fixes only
([PR #104](https://github.com/tobspr-games/shapez-community-edition/pull/104) paste-cut-once, issue #85
preview glitch), with no deeper rearchitecture (no versioning, cross-save libraries, or undo/redo). There
is no prior art to lean on here; this is genuine new design work. CE's UI/UX fixes worth reading: PR #123
(error handling), PR #110 (build-preview I/O arrows vs. wires), PR #132 (Windows crash).

**Done when:** scoped per its own spec.

## Exit criteria — Phase 1 → Phase 2

Phase 2 (engine extraction) may start when:

- Determinism and perf harness run in CI; the determinism claim is confirmed or its gaps documented
- Single dependency tree; sub-second incremental dev rebuilds
- `src/` is TypeScript; strip-block loader retired; typecheck at least as strict as today
- Centralized draw loop shipped with a measured improvement on the large-save profile
- Engine/content boundary documented and enforced, registries the sole content-registration path

## Out of scope for Phase 1

- **Mod API v2.** It encodes the engine/content split, so it belongs after that split is real — Phase 2.
  Stage 4 should leave notes for it, not build it.
- **Physical engine extraction** into a separate package (Phase 2).
- **Engine or language migration.** Godot was evaluated and ruled out; remaining options (incremental web
  modernization, a Rust/WASM simulation core) are recorded in [CLAUDE.md](../../CLAUDE.md). Phase 1 assumes
  the current JS/TS + web/Electron stack.

## Known risks

- **No visible progress until Stage 3.** Stages 0–2 are invisible to players. This is the accepted cost of
  dependency-first ordering, but it is a real momentum risk for an open-source project. Treat Stage 3 as
  the "roadmap pays off" milestone and communicate it that way.
- **Stage 1 scope creep.** Replacing gulp wholesale instead of just the bundler is the most likely way this
  roadmap stalls.
- **Determinism may not hold today.** If Stage 0 finds the simulation is not actually deterministic, that
  reorders everything — fixing it becomes the priority, since Phase 2's engine is premised on it.
