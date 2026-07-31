# Foundry: An Automation Engine

### A modern, open-source engine for building automation and factory games.

Foundry began as a fork of **Shapez Classic**, but it is no longer intended to be "Shapez 1.5."

Instead, the goal is to evolve Shapez's elegant, deterministic simulation into a reusable engine for creating entirely new automation games.

The original Shapez implementation serves as the engine's **reference game**—a complete example of what can be built with the framework—but it is only the beginning.

---

## Vision

Most game engines understand rendering, physics, audio, and input.

Foundry understands:

* Resources
* Recipes
* Production chains
* Logistics
* Grid-based construction
* Simulation
* Progression
* Blueprints

These are the common building blocks shared by automation games.

Instead of reinventing them for every project, Foundry provides them as reusable systems.

---

## Goals

### Preserve what made Shapez great

Shapez Classic remains one of the cleanest factory games ever created.

The deterministic simulation, elegant logistics, and approachable gameplay provide an excellent foundation that deserves continued evolution.

This project aims to preserve that philosophy while modernizing the underlying architecture.

---

### Build an engine—not just another game

Foundry separates reusable engine systems from game-specific content.

Core engine systems include:

* Entity/component architecture
* Simulation loop
* Tile/grid management
* Rendering
* Save/load
* Blueprint framework
* UI framework
* Modding support

Game-specific concepts become data:

* Resources
* Buildings
* Recipes
* Progression
* Technologies
* Objectives
* Content packs

---

### Make automation games easier to build

Rather than hardcoding mechanics into the engine, Automation Engine strives to be data-driven wherever practical.

Creating a new processor, resource, recipe, or building should require configuration—not engine modifications.

---

## Architecture

```text
Automation Engine
│
├── Core
│   ├── Simulation
│   ├── ECS
│   ├── Rendering
│   ├── Save System
│   └── Networking (future)
│
├── Automation SDK
│   ├── Belts
│   ├── Machines
│   ├── Resources
│   ├── Recipes
│   ├── Blueprints
│   └── Progression
│
├── UI Framework
│
├── Content Packs
│   ├── Shapez Classic
│   └── Future Games
│
└── Mods
```

---

## Design Principles

### Deterministic

The simulation should always produce identical results from identical inputs.

### Data-driven

Gameplay should be defined by content wherever possible.

### Extensible

Adding content should not require modifying engine code.

### Mod-friendly

Mods are first-class citizens, not afterthoughts.

### Performant

The engine should comfortably support massive factories while remaining responsive.

---

## Roadmap

### Phase 1 — Modernize Shapez Classic

* Improve architecture
* Expand blueprint functionality
* Improve UI/UX
* Continue performance optimizations
* Clean engine boundaries

---

### Phase 2 — Engine Extraction

* Separate engine and content
* Generalize resources
* Generalize recipes
* Modular progression
* Content pack support

---

### Phase 3 — Automation SDK

* Stable engine API
* Plugin system
* Documentation
* Sample content packs
* Improved tooling

---

### Phase 4 — Beyond Shapez

Support entirely new automation experiences built on the same engine.

Examples include:

* Industrial manufacturing
* Chemical processing
* Electronics production
* Logistics simulations
* Community-created automation games

---

## Why?

Automation games continue to grow in popularity, but every project begins by rebuilding the same core systems.

Foundry aims to become the shared foundation those games can build upon—allowing developers to focus on creating unique mechanics instead of rewriting conveyor belts, recipe systems, simulation loops, blueprint serialization, and factory tooling.

---

## Current Status

Foundry is currently evolving from the Shapez Classic codebase.

The initial focus is preserving full compatibility with the original gameplay while steadily separating reusable engine functionality from Shapez-specific content.

The long-term objective is not to replace Shapez.

It is to make Shapez the first great game built on a reusable automation engine.

---

## Contributing

The architecture is intentionally being designed for long-term evolution.

Contributions are welcome in all areas, including:

* Engine architecture
* Performance
* Rendering
* UI/UX
* Tooling
* Documentation
* Content packs
* Sample games
* Testing

Whether your goal is improving Shapez Classic or building an entirely new automation game, we'd love to have you involved.
