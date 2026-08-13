// Determinism guard for the ALEA generator backing the simulation.
//
// The README's core principle is that identical inputs always produce identical
// results. That claim bottoms out here: every seeded system in the game draws
// from RandomNumberGenerator. If this drifts, savegames and replays diverge.
//
// Scope note: only next()/reseed()/setSeed() are covered. nextIntRange() and
// nextRange() call a bare `assert`, which core/assert.js installs as
// `window.assert` at import time — unavailable outside a browser. Covering them
// requires deciding how the harness shims browser globals, which is its own change.

import { test } from "node:test";
import assert from "node:assert/strict";

import { RandomNumberGenerator } from "../src/js/core/rng.js";

/** Draws `count` values from a generator seeded with `seed`. */
function sequence(seed, count = 5) {
    const rng = new RandomNumberGenerator(seed);
    return Array.from({ length: count }, () => rng.next());
}

// Committed reference values. These are a cross-platform / cross-runtime canary:
// if float behaviour ever shifts, this is the assertion that catches it. Do not
// regenerate these to make CI pass — a change here means determinism broke.
const SEED_42_FIRST_5 = [
    0.6848634963389486,
    0.5463244677521288,
    0.8455933185759932,
    0.19908552314154804,
    0.5637381218839437,
];

test("same seed produces an identical sequence", () => {
    assert.deepEqual(sequence(42), sequence(42));
});

test("different seeds produce different sequences", () => {
    assert.notDeepEqual(sequence(42), sequence(43));
});

test("numeric and string seeds are equivalent", () => {
    // Mash() stringifies its input, so 42 and "42" seed identically.
    assert.deepEqual(sequence(42), sequence("42"));
});

test("seed 42 matches committed reference values", () => {
    assert.deepEqual(sequence(42), SEED_42_FIRST_5);
});

test("reseed restores the original sequence", () => {
    const rng = new RandomNumberGenerator(42);
    const first = rng.next();
    rng.next();
    rng.reseed(42);
    assert.equal(rng.next(), first);
});

test("setSeed restores the original sequence", () => {
    const rng = new RandomNumberGenerator(42);
    const first = rng.next();
    rng.next();
    rng.setSeed(42);
    assert.equal(rng.next(), first);
});

test("generator state can be exported and reimported", () => {
    const rng = new RandomNumberGenerator(42);
    rng.next();
    const state = rng.internalRng.exportState();
    const expected = [rng.next(), rng.next()];

    rng.internalRng.importState(state);
    assert.deepEqual([rng.next(), rng.next()], expected);
});
