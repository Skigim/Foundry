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

`origin/master` at `a253b2dd`. Working tree clean.

Stage 0, artifact 1 of 4 complete:

- `test/rng.determinism.test.js` — 7 tests, `node:test` + `node:assert`, zero new dependencies. Covers
  same-seed equality, different-seed inequality, numeric/string seed equivalence, `reseed`/`setSeed`, and
  `export`/`importState`.
- Includes **committed reference values for seed 42** as a float-drift canary. Do not regenerate them to
  make CI pass — a change there means determinism broke, and that is the finding, not an obstacle.

```bash
node --test "test/**/*.test.js"
```

Remaining Stage 0 artifacts: golden-save simulation hash, draw-call recording, boot smoke test.

## Next step

Add a `test` script to `package.json` and wire `node --test` into `.github/workflows/ci.yml` (currently
lint + tslint + yamllint only).

This matters beyond convenience: everything verified so far is Windows-only, so the seed-42 reference
values are not yet evidence of cross-platform determinism. CI running on Linux is what converts them from a
future drift guard into an actual measurement. It is a coherent two-commit unit and the first real use of
the `--no-ff` convention.

## Open questions

- **Cross-platform determinism is unproven.** Verified on Windows/Node 22 only, within and across
  processes. Resolved by the next step.
- **The browser-globals shim decision is unmade**, and it gates any test touching code that calls `assert`
  — including `RandomNumberGenerator.nextIntRange`/`nextRange`.
- **The golden-save hash is blocked** on the `require.context` constraint above. Options: shim it, pick a
  Stage 1 bundler that retains webpack compatibility, or drop the assert.
- Local branch `phase-1/stage-0-harness` is merged but not deleted.
