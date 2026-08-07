# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Starting a session?** Read [docs/handoff.md](docs/handoff.md) first — it carries the current state,
settled decisions, the next step, and constraints already learned the hard way. Keep it updated as work
progresses.

## Project

Foundry is a fork of shapez.io (Shapez Classic) being evolved from a single game into a reusable engine
for building automation/factory games (belts, recipes, production chains, logistics, blueprints). Shapez
Classic is kept as the engine's "reference game" while reusable systems (ECS, simulation, rendering, save
system, mod framework) are gradually separated from Shapez-specific content (buildings, items, recipes,
progression). See [README.md](README.md) for the full vision/roadmap.

## Repository layout

This repo has **two separate yarn dependency trees** that must both be installed:

- root (`package.json` / `yarn.lock`) — the game source itself (`src/`)
- `gulp/` (`gulp/package.json` / `gulp/yarn.lock`) — the build tooling (gulpfile, webpack, image/sound/
  translation pipelines, electron packaging). All gulp/webpack commands must be run from inside `gulp/`.

```bash
yarn install
cd gulp && yarn install && cd ..
```

## Common commands

```bash
yarn dev              # cd gulp && yarn gulp -> runs the default gulp task (serve.web-localhost), dev webserver
yarn devStandalone    # serves the electron/standalone variant instead of web
yarn lint             # eslint src/js
yarn tslint           # cd src/js && tsc — typechecks the JSDoc-annotated JS against src/js/tsconfig.json
yarn prettier-all     # formats src/**/*.* and gulp/**/*.*
yarn syncTranslations # node sync-translations.js — syncs placeholder keys from translations/base-en.yaml into other locale files
yarn buildTypes       # emits a declaration file from src/js/application.js
```

Inside `gulp/`, `yarn gulp --tasks` lists all tasks (image atlas building, css, sounds, translations,
per-variant `<variant>.code` / `serve.<variant>` / `<variant>` build tasks, electron packaging, etc.).
`gulp/build_variants.js` defines the variants (`web-localhost`, `web-shapezio-beta`, `web-shapezio`,
`standalone-steam`, `standalone-wegame`, `standalone-gog`, and China variants) — each controls the
webpack environment (`dev`/`staging`/`prod`) and whether it's a standalone (electron) or web build.

On first run, the `localConfig.findOrCreate` gulp task copies
`src/js/core/config.local.template.js` → `src/js/core/config.local.js` (gitignored); this happens
automatically as part of `serve.*`/build tasks.

**There is no automated test suite in this repo.** CI (`.github/workflows/ci.yml`) runs: install deps in
both trees → `yarn lint` → `gulp translations.fullBuild` + `gulp localConfig.findOrCreate` → `yarn tslint`,
plus a separate yamllint job over `translations/*.yaml`. Treat lint + tslint passing as the correctness bar.

## Code style

Enforced by Prettier (`.prettierrc.yaml`) via `prettier/prettier: error` in eslint: 4-space indent, double
quotes, semicolons, 110 print width, `es5` trailing commas, `arrowParens: avoid`. ESLint config
(`.eslintrc.yml`) extends `eslint:recommended` + `@typescript-eslint` + `prettier`; `no-unused-vars`,
`no-undef`, and `no-unreachable` are turned off (relied on instead by the JSDoc/tsc typecheck).

## Git workflow

Feature work happens on a branch and merges with `--no-ff`, deliberately. The Phase 1 roadmap
([docs/roadmap/phase-1.md](docs/roadmap/phase-1.md)) has stages that may need backing out wholesale, and a
merge commit makes that `git revert -m 1 <merge>` instead of hand-picking which commits belonged to the
stage. `git log --first-parent` gives the flat one-line-per-unit view when that's what you want.

- Only `--no-ff` a branch that is a coherent multi-commit unit. A single-commit branch should fast-forward
  — a merge commit wrapping one commit is noise.
- Every commit on a branch should be green on its own, so `git bisect` landing inside a branch still means
  something. This matters more than usual here: Stage 0's determinism harness exists to catch regressions
  that bisect then has to localize.

## Architecture

**Plain JS + JSDoc, typechecked like TypeScript.** There are no `.ts` files in `src/`; types come from
JSDoc comments and are checked via `tsc --checkJs` against `src/js/tsconfig.json`. Files frequently have
`/* typehints:start */ ... /* typehints:end */` blocks holding type-only imports — these are stripped from
the actual webpack bundle by a custom loader (`gulp/loader.strip_block.js`) so they cost nothing at runtime.

**`GameRoot` (`src/js/game/root.js`) is the central object** for a running game — it's constructed once per
session and passed into almost every game class instead of using globals. It owns the entity manager, game
system manager, camera, map, hub goals, savegame, sound proxy, etc.

**Entity/Component/System (ECS)**: `src/js/game/entity.js` holds `Component` instances
(`src/js/game/components/`); `src/js/game/systems/` holds `GameSystem`/`GameSystemWithFilter` subclasses that
operate each tick over entities with matching components. `EntityManager` and `GameSystemManager`
(`src/js/game/`) drive creation/update.

**Data-driven buildings via a registry/factory pattern** (`src/js/core/global_registries.js`,
`src/js/core/factory.js`, `src/js/core/singleton_factory.js`): buildings extend `MetaBuilding`
(`src/js/game/meta_building.js`), live in `src/js/game/buildings/`, and are registered into
`gMetaBuildingRegistry` by `src/js/game/meta_building_registry.js`. Building *variants* (e.g. different belt
tiers) are handled by `src/js/game/building_codes.js`. The same `Factory` pattern registers components,
items, game modes, and game speeds — this is the main extension point both for adding new Shapez content and
for the engine-generalization work described in the README.

**Platform abstraction** (`src/js/platform/`): `browser/` and `electron/` subfolders implement common
interfaces (`wrapper.js`, `sound.js`, `analytics.js`, `achievement_provider.js`, `storage.js`) so
`src/js/application.js` (the app-level singleton wiring everything together) can run against either target
without game/UI code branching on platform.

**Mod system** (`src/js/mods/`: `modloader.js`, `mod.js`, `mod_interface.js`, `mod_signals.js`): mods hook
into the same registries/classes used by built-in content (can register new buildings, items, systems,
themes, translations, keybindings, etc.). `mod_examples/` has annotated example mods demonstrating each
extension point — useful reference when adding new registrable content types.

**State machine**: `src/js/core/state_manager.js` drives `GameState` subclasses in `src/js/states/`
(`main_menu.js`, `ingame.js`, `settings.js`, `preload.js`, etc.) — these are the top-level app screens, one
level above the in-game `GameRoot`/ECS layer.

**Savegames** (`src/js/savegame/`): `savegame_serializer.js` / `savegame_compressor.js` handle
(de)serialization and versioned migration of save data; `schemas/` holds the versioned save-format schemas.

**Translations**: source of truth is `translations/base-en.yaml`; other locale YAML files are kept in sync
via `sync-translations.js` (adds missing placeholder keys) and built into the game via gulp's
`translations.*` tasks; `translations/*.yaml` is yaml-linted in CI.

**Standalone/electron packaging**: `electron/`, `electron_gog/`, `electron_wegame/` at the repo root hold the
per-distribution electron wrapper apps; `gulp/steampipe/` and related gulp tasks handle Steam-specific
packaging/upload.

## Known engine footguns

These were discovered the hard way while extending this codebase from outside (third-party mods) and are
verified against this repo's actual source — worth knowing before touching the same subsystems from the
inside (engine work, not just mods):

- **`extendClass`/`replaceMethod`-style prototype patching is a footgun.** There's no registration array
  for arbitrary HUD items — `ModInterface.extendClass` (and raw prototype patches on core classes) is the
  fallback when no purpose-built registration hook exists. A stack trace through a patched method points at
  the original native method, not your patch, which makes debugging harder. Prefer an existing registration
  hook (buildings/components/items/game modes all go through the `Factory`/`gMetaBuildingRegistry` pattern
  above) before reaching for a raw patch; when you do patch, keep it minimal.

- **`window.shapez` is a flattened export map, not a namespace.** `ModLoader.exposeExports()`
  (`src/js/mods/modloader.js`) walks every module under `src/js/` via `require.context` and dumps every
  named export onto `window.shapez` as getter/setter pairs — so anything exported from anywhere becomes
  globally reachable this way, including things like `BUILD_OPTIONS` from `core/globals.js` that aren't
  otherwise obviously "public API."

- **`G_IS_STANDALONE` is a webpack `DefinePlugin` constant baked in at *this* bundle's build time only.**
  It's fine to check directly inside engine code (`src/js/mods/modloader.js` does exactly that), but if code
  ever needs to be shared with or read from a mod's separately-bundled code, `G_IS_STANDALONE` won't exist
  there — use the exposed `BUILD_OPTIONS.IS_STANDALONE` (`src/js/core/globals.js:27`) for anything crossing
  that boundary.

- **Mod/plugin init cannot assume the real storage backend is ready.** `Application.boot()` calls
  `await MODS.initMods()` (`src/js/application.js:81`), and inside `initMods()` the storage instance is a
  **local `const`**, not attached to `this.app` — `this.app.storage` isn't actually assigned until
  `platformWrapper.initialize()` runs later, inside `PreloadState.startLoading()`. Anything that needs the
  real app-level storage (or does one-time migration work) run during a mod's synchronous `init()` will run
  too early; the pattern used elsewhere is to defer that work to a later lifecycle hook (e.g. a HUD part's
  `initialize()`), not init-time.

- **`Dialog.contentHTML` is a string, rendered via `innerHTML`, not a live DOM node.**
  `src/js/core/modal_dialog_elements.js` does `content.innerHTML = this.contentHTML` — passing a
  pre-built DOM element there silently does nothing useful, and any element/listener you built *before*
  calling `internalShowDialog` is destroyed the moment it renders. Bind dynamic event listeners by querying
  `dialog.element` *after* the dialog is shown, not before.

- **`DialogWithForm` needs exactly `desc` and `formElements`** (confirmed in
  `src/js/core/modal_dialog_elements.js`) — not `description`/`elements`. Wrong keys fail silently (the
  text/inputs just don't appear) rather than throwing.

- **Dialog button ids need a matching translation key or they render literally as `"UNDEFINED"`** — button
  labels are looked up via `T.dialogs.buttons[buttonKey]`; a custom button id needs its translation
  registered before the dialog is instantiated.

- **HUD element stacking order is a single flat list, not a convention to eyeball.** `src/css/main.scss`'s
  `$elements` list assigns z-index in list order (100, 110, 120, ...) — do not hardcode a z-index number
  for a new overlay; find where it needs to sit relative to the existing `$elements` entries (e.g. above
  regular dialogs, below `ingame_HUD_ModalDialogs`) and add it to that list at the right position instead.
  (The list has grown over Foundry's history, so any specific index numbers cited elsewhere may already be
  stale — always check the current list.)

- **Never call `e.stopPropagation()` in custom input handlers layered on top of the engine's own input
  handling** — it desyncs `InputDistributor`'s and `ClickDetector`'s internal pressed-state tracking, which
  are relied on elsewhere. Similarly, don't call `.focus()` on a text input from inside a HUD part's
  `show()` — the keypress that triggered `show()` will land inside the freshly focused field.

## Phase 1 research: Community Edition & engine options

Two research passes done in preparation for README's "Phase 1 — Modernize Shapez Classic" roadmap
(improve architecture, expand blueprints, improve UI/UX, continue performance work, clean engine
boundaries) and for evaluating whether to move off the current custom JS engine. Findings below so future
sessions don't have to re-derive them; treat anything not explicitly sourced here as unverified.

### A) Shapez Community Edition — lessons for Phase 1

**What it is:** tobspr Games stopped developing the original `shapez.io` to focus on the closed-source
commercial sequel *Shapez 2*, and now points contributors at the community-maintained continuation,
**https://github.com/tobspr-games/shapez-community-edition** ("CE"). CE lives inside the official
tobspr-games org (not a random fork), is GPL-3.0-or-later, and is modestly but genuinely active (~5–10
commits/month, small stable collaborator set, PR review requiring 2 approvals). Other same-named repos
found (turtlegarden/, wsj1102/) are personal forks, not competing projects. Big changes are coordinated on
the shapez Discord (`#contributing`), not in public design docs — there is no roadmap doc, CONTRIBUTING.md,
or wiki to cite.

**Mapped against each Phase 1 sub-goal:**

- *Architecture:* CE's own README admits the game code on top of the engine is still "hacky" — this is an
  open TODO for them too, not solved prior art to copy. Their one clear architecture win is isolating the
  Electron wrapper into its own TS module (PR #47).
- *Blueprints:* thin — incremental fixes only (PR #104 paste-cut-blueprints-once, issue #85 preview glitch,
  PR #137), no evidence of a deeper blueprint system rearchitecture (versioning, cross-save libraries,
  undo/redo).
- *UI/UX:* CE is migrating UI code to TypeScript + a custom JSX/TSX runtime (`src/js/jsx-runtime.ts`, not
  React), but this looks early/infra-stage — their root `tsconfig.json` still only type-checks
  `gulp/**/*` the same JSDoc-checked-by-tsc way Foundry already does. Don't treat it as a finished
  migration. Concrete UX fixes: PR #123 (better error handler), PR #110 (build-preview I/O arrows vs
  wires), PR #132 (Windows crash/white-screen fix).
- *Performance:* only one confirmed CE-side runtime-perf change, issue #66 "Savegame storage refactor"
  (technique not retrievable). Separately, PR #119 swapped Webpack for **Rspack**, cutting release builds
  ~10s→~1s and dev/HMR ~5s→~250ms — a build-tooling win worth considering for Foundry's own gulp/webpack 4
  pipeline regardless of any engine decision. No CE-side rendering/simulation runtime-perf work was found
  (see load-bearing finding below).
- *Engine boundaries:* CE's biggest engine/content-boundary effort is "Mod V2" (issue #52): ASAR-based mod
  packaging, static metadata instead of runtime eval, a `mod://self/...` asset protocol, ESM imports for
  game APIs, declared mod dependencies — merged in pieces (PR #61 basic ASAR modding, PR #87 mod-protocol
  directory handling, PR #98/#100 mod dependency support). This maps directly onto Foundry's
  `src/js/mods/` and is CE's most substantial, most directly reusable initiative for this goal.

**Load-bearing finding — tobspr's own performance diagnosis:** on the original repo's
[issue #1021](https://github.com/tobspr-games/shapez.io/issues/1021), tobspr himself identifies the root
cause of the engine's rendering slowness: each `GameSystem` redraws by iterating *all* on-screen entities
and re-checking component matches per system, instead of one consolidated draw pass — and proposes a
**centralized draw loop with layer-based draw calls** as the fix.
[Issue #1471](https://github.com/tobspr-games/shapez.io/issues/1471) confirms this empirically: a save
with 77,270 belts / 42,820 buildings dropped from 30fps to 4fps while update-loop time stayed flat
(~14ms/60UPS) — the bottleneck is rendering, not simulation. No matching fix has been merged in CE. This
is a specific, actionable, unclaimed target sitting in code Foundry inherited directly, independent of any
CE or engine-migration work.

**Gaps (unverified, don't treat as settled):** real scope of CE's TS/JSX migration in gameplay (not just
build) code; any belt/chunk-system perf work beyond savegame storage; no Reddit/blog pass was done.

Source URLs: repo — https://github.com/tobspr-games/shapez-community-edition · perf diagnosis (load-bearing) —
https://github.com/tobspr-games/shapez.io/issues/1021 · large-save regression —
https://github.com/tobspr-games/shapez.io/issues/1471 · Rspack migration —
https://github.com/tobspr-games/shapez-community-edition/pull/119 · Mod V2 —
https://github.com/tobspr-games/shapez-community-edition/issues/52

### B) Engine/language migration options

Godot was evaluated as one option and **ruled out** — its Node/scene-tree model doesn't scale to this
game's entity counts without abandoning it entirely for a hand-rolled data-oriented layer, its built-in
physics is non-deterministic, and it has no first-class modding API, which would regress Foundry's current
mod ecosystem (`src/js/mods/`). Decision made; don't re-litigate without redoing the research.

**Remaining alternatives, ranked lowest migration cost/risk first:**

1. **Stay web-based, modernize incrementally** — JS→TypeScript (Foundry's existing JSDoc+tsc setup is
   already most of the way there), Canvas2D→WebGL2/WebGPU for rendering (WebGPU cited at 15–30x on
   compute-shader-style workloads). Nothing is thrown away: ECS, mod loader, simulation logic, Electron
   packaging, and mod-ecosystem compatibility are all kept. The only option that avoids re-deriving years
   of simulation/balance logic.
2. **Rust simulation core via WASM**, JS shell kept for page/canvas/input/audio/UI — move only the hot
   simulation path into Rust (Bevy ECS is the natural fit, but determinism requires explicitly enabling
   `enhanced-determinism`, single-threaded execution, and explicit query-order sorting; not deterministic
   by default). No Factorio/shapez-style game found built in Rust/Bevy either — a prior-art gap. Medium
   cost, adds a Rust/WASM toolchain requirement.
3. **C#/C++ with a lighter framework (MonoGame/FNA/raylib)** — unopinionated scaffolding closer in spirit
   to Foundry's hand-rolled-engine approach than a full game engine; no built-in modding or determinism
   (own both exactly as much as today, different language). Full simulation-code rewrite; only the
   architecture (custom ECS, custom mod system, deterministic tick loop) transfers conceptually.
4. **Harden the engine/content boundary first** (structural, can pair with option 1 or 2). README already
   states engine/content separation and "identical results from identical inputs" as goals — verifying and
   firming up that boundary now is lower-regret than committing to any engine swap first.

**Gaps (unverified):** no comparable Rust/Bevy title found for this genre — treat option 2's prior-art gap
as unproven, not disproven.
