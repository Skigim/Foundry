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

`origin/master` at `b8198360`. Working tree clean.

Stage 0, artifact 1 of 4 complete, **and now confirmed cross-platform**:

- `test/rng.determinism.test.js` — 7 tests, `node:test` + `node:assert`, zero new dependencies. Covers
  same-seed equality, different-seed inequality, numeric/string seed equivalence, `reseed`/`setSeed`, and
  `export`/`importState`.
- Includes **committed reference values for seed 42** as a float-drift canary. Do not regenerate them to
  make CI pass — a change there means determinism broke, and that is the finding, not an obstacle.

```bash
yarn test    # equivalent to: node --test "test/**/*.test.js"
```

`yarn test` runs in CI on a dedicated `test` job (`.github/workflows/ci.yml`) pinned to Node 22.x — the
version the seed-42 references were generated on — on `ubuntu-latest`. **CI run
[31230191451](https://github.com/Skigim/Foundry/actions/runs/31230191451) confirms it: `test` job passed in
13s on Linux.** The seed-42 values are now genuine cross-platform evidence, not just a same-machine check.
The job skips `yarn install` — the test script has no dependencies of its own.

**The pre-existing `CI` job (lint + tslint) failed on that same run, at the `TSLint` step** — this is
unrelated to the work above (confirmed by reproducing the identical `tsc` errors locally on this same
commit: `mods/mod_interface.js:53,58` rest-element-in-tuple, `platform/browser/game_analytics.js:121`
missing `setAbt` on `Window`, `states/main_menu.js:562` and `states/preload.js:330` missing `innerText` on
`Element`, `states/preload.js:97` wrong arg count, `states/preload.js:331` missing `style` on `Element`).
The fork Actions gate (see below) meant nobody had actually seen this fail in CI until now — it may have
been broken for a while. Not caused by, and not fixed by, this session's work.

Remaining Stage 0 artifacts: golden-save simulation hash, draw-call recording, boot smoke test.

## Next step

Decide whether to fix the pre-existing `TSLint` failures before continuing Stage 0, or track them
separately and proceed. They block a fully green CI, but they predate this session and touch files
(`mod_interface.js`, `game_analytics.js`, `main_menu.js`, `preload.js`) unrelated to Stage 0's remaining
artifacts.

Once decided, move on to the next Stage 0 artifact — golden-save simulation hash is next in the doc's
order, but it's blocked on the `require.context` question below.

**Aside, resolved:** GitHub's fork Actions gate (disables `push`/`pull_request` triggers on forks until the
owner clicks through once on the Actions tab) was blocking every run on `Skigim/Foundry` — confirmed via the
Actions API showing 0 total runs despite the workflow being registered and `active`. Cleared as of this
session; no further action needed.

## Open questions

- ~~Cross-platform determinism unproven~~ — **resolved.** `test` job passed on Linux/Node 22.x in CI run
  31230191451.
- **The pre-existing `TSLint` failure needs a decision** (see Next step) — fix now, or track and defer.
  Unknown how long it's been broken, since the fork Actions gate meant no CI run had surfaced it before.
- **The browser-globals shim decision is unmade**, and it gates any test touching code that calls `assert`
  — including `RandomNumberGenerator.nextIntRange`/`nextRange`.
- **The golden-save hash is blocked** on the `require.context` constraint above. Options: shim it, pick a
  Stage 1 bundler that retains webpack compatibility, or drop the assert.
- Local branch `phase-1/stage-0-harness` is merged but not deleted.
