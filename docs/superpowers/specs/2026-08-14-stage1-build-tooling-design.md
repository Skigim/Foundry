# Stage 1 build tooling — design

Written 2026-08-14, before any code. Implements Stage 1 of [phase-1.md](../../roadmap/phase-1.md). This is
the first stage that *uses* Stage 0's safety net rather than building it: artifacts 1 (golden-save hash) and
4 (boot smoke test) are landed, green in CI, and exist specifically to catch what this stage can break.

## Goal

Replace webpack 4 as the JS bundler. Everything else follows from that: sub-second incremental rebuilds, and
the disappearance of `NODE_OPTIONS=--openssl-legacy-provider`, which exists only because webpack 4 hashes
with MD4 through OpenSSL and OpenSSL 3 disabled it. That flag currently has to be threaded through
`.claude/dev-server.cmd` and CI's build steps, and it silently breaks new checkouts.

Target is **Rspack**, following CE's
[PR #119](https://github.com/tobspr-games/shapez-community-edition/pull/119) — reported ~10s → ~1s release
builds and ~5s → ~250ms dev rebuilds. Read their config; reimplement, do not merge. Rspack also retains
webpack's loader API and `require.context`, which matters here (see below).

## What the build actually is today

Surveyed rather than assumed, because phase-1.md's warning that "`gulp/` does far more than bundling" turns
out to understate it.

**Two webpack configs, very different in weight.**
[`webpack.config.js`](../../../gulp/webpack.config.js) (dev, 127 lines) is close to minimal: `DefinePlugin`,
`CircularDependencyPlugin`, and seven module rules.
[`webpack.production.config.js`](../../../gulp/webpack.production.config.js) is substantially heavier —
Terser, `UnusedFilesPlugin`, `StringReplacePlugin`, and *three* separate `webpack-strip-block` passes
(`typehints`, `dev`, `wires`) rather than the dev config's one.

**Two local loaders**, which are ours and port with the loader API:
[`loader.compressjson.js`](../../../gulp/loader.compressjson.js) and [`mod.js`](../../../gulp/mod.js).
[`loader.strip_block.js`](../../../gulp/loader.strip_block.js) also exists but **neither config references
it** — both use the npm `webpack-strip-block`. Confirm it is dead and delete it rather than porting it.

**Webpack-4-specific syntax that must change regardless of target:**

| today | why it breaks |
|---|---|
| `node: { fs: "empty" }` (both configs) | webpack 4 syntax; v5/Rspack use `resolve.fallback: { fs: false }` |
| `type: "json"` on the yaml rule | the config's own comment says "Required by Webpack v4" |
| `worker-loader` with `inline: true` | deprecated in v5/Rspack in favour of `new Worker(new URL(...))` |

**Declared but unreferenced** — `webpack-deep-scope-plugin` and `webpack-plugin-replace` appear in
`gulp/package.json` but in neither config. Free deletions; confirm before removing.

## Sequencing: dev config first, production second, yarn trees last

Three sub-steps, each independently verifiable, per the standing decision to work in small verifiable
commits. Not one migration.

1. **Dev config → Rspack.** Small surface, and it carries the entire daily-experience win: fast rebuilds and
   the OpenSSL flag deleted from `.claude/dev-server.cmd` and CI. Guarded end-to-end by the boot smoke test,
   which already boots a real dev bundle. This step alone justifies the stage.
2. **Production config → Rspack.** Where the risk actually lives (see below). Guarded by nothing today —
   which is why step 2 also owns extending the smoke test to boot a **prod** bundle. That extension is
   already recorded as Stage 1's job in [handoff.md](../../handoff.md), because `window.shapez` does not
   exist in web prod builds and the current smoke test depends on it.
3. **Collapse the two yarn trees.** Independent of the bundler swap and the largest blast radius, since it
   touches every documented command in CLAUDE.md and every CI step. Genuinely separable; may reasonably slip
   to its own stage.

## Risk register

**Mechanical, low risk.** `DefinePlugin` (Rspack ships its own), the `G_*` constants, `require.context` at
[component_registry.js:56](../../../src/js/game/component_registry.js:56) and
[modloader.js:114](../../../src/js/mods/modloader.js:114), our two local loaders, and the common third-party
loaders (`ignore-loader`, `html-loader`, `markdown-loader`, `yaml-loader`, `webpack-strip-block`). All ride
on the loader API Rspack implements. Verify, don't agonise.

**Requires a source change — the one place this stage touches `src/`.** `worker-loader`'s idiom is
`new CompressionWorker()` ([async_compression.js:40](../../../src/js/core/async_compression.js:40)), which
only works because the loader rewrites the import. The modern form is `new Worker(new URL(...))`. Two workers
are affected: `compression.worker.js` and `background_animation_frame_emittter.worker.js`. Worth flagging
because phase-1.md calls Stage 1 "self-contained (touches no game logic)" — true for *logic*, but not true
for `src/` as a whole, and the golden-save hash covers the compression worker's output path.

**No clean replacement — decide before starting step 2.** `string-replace-webpack-plugin` (at `^0.1.3`) and
`unused-files-webpack-plugin` are both webpack-specific and long unmaintained. Neither has an obvious Rspack
equivalent. Options per plugin: find a maintained equivalent, reimplement as a small local plugin/loader, or
establish that the build no longer needs it. `UnusedFilesPlugin` in particular is a build-hygiene check
rather than a correctness requirement — dropping it may be entirely fine. `terser-webpack-plugin` is the easy
one: Rspack has a built-in SWC-based minifier.

**Watch for output drift, not just build success.** A prod bundle that builds is not a prod bundle that
behaves. Minifier differences are the likeliest source of a silent change.

## Verification

This is what Stage 0 was for.

- **Boot smoke test** (artifact 4) — catches bundle-level breakage, which is the failure mode here. Runs
  against the dev bundle today; step 2 extends it to prod.
- **Golden-save hash** (artifact 1) — catches behaviour drift through the bundler swap. If a minifier or a
  changed strip-block pass alters simulation output, the hash moves. Per standing decision, a moved hash is
  the finding and is never regenerated to make CI green.
- **All build variants still produce working artifacts.** `gulp/build_variants.js` defines nine. The web and
  standalone-steam paths get exercised routinely; the China/WeGame/GOG/demo variants do not, and "it builds"
  is the realistic bar for those.
- **Measure the rebuild time before and after** and record it. The stage's whole justification is a number.

## Explicitly out of scope

- **Replacing gulp.** Only the JS bundling step moves. Image atlas generation, sound sprites, translation
  builds, electron packaging, and steampipe upload all stay. phase-1.md is explicit that treating "replace
  the bundler" as "replace gulp" stalls this stage.
- **TypeScript.** Stage 2. Rspack handling `.ts` natively is a *reason* for this ordering, not work to do now.
- **Rendering, engine boundaries, mod API.** Later stages.

## Open items to resolve during implementation

- Whether the yarn-tree collapse (step 3) belongs in this stage or its own. Decide before starting step 1, so
  the stage has a defined end.
- What happens to `string-replace-webpack-plugin` and `unused-files-webpack-plugin` — replace, reimplement,
  or drop. Needed before step 2, not before step 1.
- Whether `gulp/loader.strip_block.js`, `webpack-deep-scope-plugin`, and `webpack-plugin-replace` are truly
  unreferenced. Expected yes; confirm and delete.
- Whether `webpack-stream` has an Rspack analogue, or whether the gulp task shells out to Rspack directly.
  This decides how invasive `gulp/js.js` gets.
- Whether the three prod strip-block passes (`typehints`, `dev`, `wires`) survive as-is. The `wires` pass in
  particular strips a whole gameplay layer and deserves a look during Stage 4's engine-boundary work, but
  should be carried over unchanged here — this stage changes the bundler, not what gets bundled.
