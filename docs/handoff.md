# Session handoff

Living context for picking up work on Foundry in a fresh session. To use it, point a new session here —
"read `docs/handoff.md` and continue" — rather than re-explaining the project.

**Keep it current.** The sections are ordered by how often they change:

| Section | Update when |
| --- | --- |
| Read first / Standing decisions | A decision is made or reversed. Rare. |
| Empirical constraints | Something is learned by running code. Append-only; never delete a constraint without proving it no longer holds. |
| Current state / Next step / Open questions | Every session. |

Last updated: 2026-08-07

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

## Empirical constraints

Learned by running code, not by assuming. Each one has already cost time once.

- **Node 22 imports `src/js` typeless ESM directly.** No transform or loader is needed, which is why the
  harness uses `node:test` rather than a transforming runner.
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
  `modloader.js:114`, so the component registry cannot load outside a webpack-compatible bundler. This
  blocks the golden-save hash artifact and is a point in Rspack's favor for Stage 1.

## Current state

`origin/master` at `01a766fe`. Working tree clean. CI run
[31230953714](https://github.com/Skigim/Foundry/actions/runs/31230953714) is **fully green** — `test`,
`yaml-lint`, and `CI` (lint + tslint) all passed. First clean run this repo has ever had, as far as the
Actions API history goes back.

Stage 0, artifact 1 of 4 complete, **and confirmed cross-platform**:

- `test/rng.determinism.test.js` — 7 tests, `node:test` + `node:assert`, zero new dependencies. Covers
  same-seed equality, different-seed inequality, numeric/string seed equivalence, `reseed`/`setSeed`, and
  `export`/`importState`.
- Includes **committed reference values for seed 42** as a float-drift canary. Do not regenerate them to
  make CI pass — a change there means determinism broke, and that is the finding, not an obstacle.

```bash
yarn test    # equivalent to: node --test "test/**/*.test.js"
```

`yarn test` runs in CI on a dedicated `test` job (`.github/workflows/ci.yml`) pinned to Node 22.x — the
version the seed-42 references were generated on — on `ubuntu-latest`. Passing there means the seed-42
values are genuine cross-platform evidence, not just a same-machine check. The job skips `yarn install` —
the test script has no dependencies of its own.

**The pre-existing `TSLint` failures are fixed** (`phase-1/stage-0-tslint-fix`, fast-forwarded into master
at `01a766fe` — single commit, so no `--no-ff`). All 7 were type-only JSDoc/tsc issues, unrelated to the
CI-wiring work: `mod_interface.js`'s `afterPrams`/`extendsPrams` typedefs used an invalid spread-tuple
(fixed to match the sibling `beforePrams` typedef's non-spread shape), `game_analytics.js` assigned
`window.setAbt` without declaring it (added to `globals.d.ts`'s ambient `Window` interface), and
`main_menu.js`/`preload.js` treated `querySelector` results as `HTMLElement` without saying so (added
`@type` annotations at the declarations). One real behavior change included: `preload.js`'s first
`setStatus("Booting")` call now passes `0` for `progress` explicitly, like every other call site already
did — previously this set `NaN%` as the boot progress bar's width. Everything else is compile-time only;
JSDoc types are stripped before the real bundle ships.

Remaining Stage 0 artifacts: golden-save simulation hash, draw-call recording, boot smoke test.

## Next step

Start the golden-save simulation hash artifact. It's blocked on the `require.context` question below —
resolving that (shim it, pick a Stage 1 bundler that retains webpack compatibility, or drop the assert) is
the actual next decision, not busywork before it.

## Open questions

- **Reverse Factory game mode idea is parked**, not started —
  [docs/superpowers/specs/2026-08-12-reverse-factory-poc-design.md](superpowers/specs/2026-08-12-reverse-factory-poc-design.md)
  has the concept, prior-art check, and an engine-feasibility mapping (most of the core loop already exists
  as buildings: constant producer, cutters, goal acceptor with per-instance target shape). Deliberately not
  picked up while Phase 1 Stage 0 is in flight; resume the brainstorming-skill flow from that doc's
  checkpoint when there's room for it, don't restart from scratch.
- **The golden-save hash is blocked** on the `require.context` constraint above. Options: shim it, pick a
  Stage 1 bundler that retains webpack compatibility, or drop the assert.
- **The browser-globals shim decision is unmade**, and it gates any test touching code that calls `assert`
  — including `RandomNumberGenerator.nextIntRange`/`nextRange`.
- Local branches `phase-1/stage-0-harness` and `phase-1/stage-0-ci` are merged but not deleted; add
  `phase-1/stage-0-tslint-fix` to that list.
