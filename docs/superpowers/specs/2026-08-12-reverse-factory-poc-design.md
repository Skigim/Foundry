# Reverse Factory game mode — parked idea

**Status: PARKED.** Not started, not approved, not scheduled. Brainstormed 2026-08-12 alongside Phase 1
Stage 0 CI work; deliberately set aside because that work takes priority. This document exists so the idea
and the scoping already done aren't lost, not as an implementation-ready spec. Read
[docs/handoff.md](../../handoff.md) first for what's actually in flight.

## The concept

A factory/automation game that inverts shapez.io's core loop: instead of building toward complex shapes,
players **deconstruct** them.

- **Producers** continuously output intricate, multi-layered, asymmetrical shapes.
- **Consumers** spawn across the map requesting simple primitives — a quadrant, a raw color, a single
  isolated layer.
- Core loop: decompose producer shapes via cutters/filters/unstackers, route the exact required pieces to
  matching consumers before demand drops.
- **Byproduct-as-obligation** is the central hook: every cut/filter that extracts a target piece generates
  leftovers, and an unhandled output belt freezes the upstream machine — every fragment must go somewhere
  (secondary consumers, buffers, recombination, or disposal). Comparable to Opus Magnum's waste-heat
  tension, but spatialized.
- Spatial constraint: limited belts/crossovers force compact, adaptive routing over dedicated per-item
  lines.
- Progression (not scoped for the POC): map expansion revealing higher-entropy producers and more distant
  consumer demands.

## Design crux (from the original brainstorm, still open)

1. **Disposal cost/capacity model** — should disposal be a genuine costly last resort, or a cheap
   pressure-release valve? Too cheap and byproduct stops mattering; absent, one bad cut deadlocks a run.
2. **Canonical shape decomposition grammar** — need a system that guarantees multiple valid decomposition
   paths to a given consumer request, or players find "the" optimal cut sequence and stop exploring.
3. **Cascading gridlock as the loss state** is elegant but risky — needs visible early-warning signals
   (belt saturation, buffer fill meters) so collapse reads as a lost puzzle, not unfair RNG.
4. Real-time vs. pausable planning — pure reflex, or does the player get to stop and think?
5. How to avoid the staying-power problem seen in comparable titles (below) — what's the long-run systemic
   depth?

## Prior art assessment

No shipped or well-tested title fuses "one complex producer → many distributed simple consumers →
mandatory byproduct routing" into one central loop — this is a genuine gap. Individual pieces are each
independently proven:

- **ShapeHero Factory** (Asobism, Steam, ~984 reviews "Very Positive") validates shapez-style shape
  mechanics + roguelite run structure + spatial scarcity + timer pressure has a paying audience — but runs
  the forward direction (combine, not decompose), and reviewers flag that its timed-roguelite structure
  fights how automation-game players normally like to engage (controlled, persistent progression). Direct
  risk to flag for this concept too.
- **Reverse Factory** (Factorio mod, ~2015–2017) proves the uncrafting mechanic works standalone, but it's
  a mod, not a full game loop.
- Other recent "factory roguelike" storefront titles found in the initial search pass were unvalidated
  (jam-tier, single-digit review counts) and were explicitly discounted rather than treated as market
  signal.

## Engine feasibility (findings from this session)

Checked against the actual current Foundry source. This is closer to "assemble existing primitives into a
new GameMode" than "build new engine systems" — most of the core loop already exists:

| Reverse-factory role | Existing engine primitive |
| --- | --- |
| Bounded/constrained map | `GameMode.getBuildableZones()` / `getCameraBounds()` — see `PuzzleGameMode` ([puzzle.js](../../../src/js/game/modes/puzzle.js)) for the pattern (fixed-size zone, no hub, no resources) |
| Complex-shape producer | `MetaConstantProducerBuilding` ([constant_producer.js](../../../src/js/game/buildings/constant_producer.js)) — configurable via `ConstantSignalComponent`, ejects a fixed shape continuously |
| Decomposition tools | `MetaCutterBuilding` (half-cut + quad-cut variants, [cutter.js](../../../src/js/game/buildings/cutter.js)), `MetaPainterBuilding`, `MetaRotaterBuilding`, `MetaStackerBuilding` |
| Byproduct routing / filtering | `MetaFilterBuilding` ([filter.js](../../../src/js/game/buildings/filter.js)) — currently wire-gated pass/reject, not a shape-property filter; would need checking/extending for a non-wired "sort by color/shape" use case |
| Disposal (pressure-release valve) | `MetaTrashBuilding` ([trash.js](../../../src/js/game/buildings/trash.js)) — existing free/instant disposal; open design question #1 above is whether this needs a cost model layered on for this mode |
| Consumers with distinct demands | `MetaGoalAcceptorBuilding` + `GoalAcceptorComponent` ([goal_acceptor.js](../../../src/js/game/components/goal_acceptor.js)) — **`item` is a per-instance field**, so multiple placed consumers can each target a different shape simultaneously. This is the key finding that makes "many distributed simple consumers" cheap to build. |
| "Unhandled output freezes upstream machine" | Very likely already emergent from existing ejector/belt backpressure (a full output slot blocks the producer), same as base shapez behavior — **not verified empirically yet**, should be confirmed early rather than assumed before relying on it as the core tension mechanic |

## Scoping decisions made this session

- **This is not a throwaway spike** — it's meant to become the first new game built on Foundry's engine, so
  whenever work resumes it should be built as a real `GameMode`, not a hacky prototype to be rewritten.
- **POC scope: minimal playable core loop only.** One producer, a handful of cutters/filters, one or two
  consumers, mandatory byproduct routing. No timers, no roguelite structure, no map expansion — those layer
  on only once the core loop is proven to be fun moment-to-moment.
- **Reachable via a real main-menu entry**, not a dev-only debug flag.
- **Saveable from the start** (not opted out like Puzzle mode's `getIsSaveable() { return false; }`).
- **Entry-point approach (leaning, not fully confirmed):** the shared savegame-slot system has no
  per-slot game-mode field — regular slots are implicitly always `RegularGameMode`. Puzzle mode sidesteps
  this with one fixed, dedicated, non-slot savegame (`internalId: "puzzle"`) reached via its own menu
  button rather than the generic multi-slot "New Game" flow. The recommendation going into next time was to
  mirror that: a dedicated menu button → dedicated state flow → one persistent savegame dedicated to this
  mode, reusing `GameMode.create()`'s existing `gameModeId` payload mechanism
  ([game_mode.js:42](../../../src/js/game/game_mode.js:42), see `InGameState`/`core.js` wiring). This avoids
  a schema/migration change to `SavegameMetadata` that a "real" multi-slot, mode-selectable New Game flow
  would require. **This was not confirmed before the session was paused** — revisit before locking it in.

## Not yet decided / next steps when resumed

- Confirm or revise the entry-point approach above.
- Concrete POC content: what shape does the producer emit, and what specific pieces (quadrant / layer /
  color) do the 1-2 consumers request? Not yet designed.
- Empirically verify the backpressure-freezes-upstream assumption before treating it as free.
- Continue the brainstorming-skill flow (clarifying questions → present design sections → approval) from
  where this was paused, rather than restarting from scratch — this document is the checkpoint.
