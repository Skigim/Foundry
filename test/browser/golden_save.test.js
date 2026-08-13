// Stage 0 artifact 1: golden-save simulation hash.
//
// Loads a committed fixture savegame, runs a fixed number of simulation ticks,
// and hashes a defined subset of the resulting serialized state. This is what
// makes a simulation regression detectable before Stage 1 rewrites the build.
//
// The two tests do different jobs. The self-consistency test catches
// nondeterminism inside a single run — an unpinned clock, a stray frame, a
// wall-clock field leaking into the hash. The reference test catches drift
// across machines, runtimes and commits.
//
// Requires a dev build in build/. See harness.js for the exact command.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    launchGame,
    waitForMainMenu,
    loadFixtureGame,
    prepareDeterministicRun,
    runTicks,
    hashSimulationState,
    REPO_ROOT,
} from "./harness.js";

const FIXTURE = JSON.parse(readFileSync(join(REPO_ROOT, "test", "fixtures", "golden_save.json"), "utf8"));

/** 10 seconds of simulation at the pinned 60 ticks/second. */
const TICK_COUNT = 600;

// Committed reference value, the same kind of canary as SEED_42_FIRST_5 in
// test/rng.determinism.test.js. Do not regenerate this to make CI pass — a change
// here means the simulation's output changed, and that is the finding.
//
// It legitimately moves when the fixture is regenerated, TICK_COUNT changes, the
// hashed subset changes, or a savegame schema bump changes serialized shape. All
// four are deliberate, reviewed edits that arrive in the same commit as the new
// value.
const GOLDEN_SAVE_HASH = "0416cc3d1585253c697d0456ac88ec3f2d73f5d23730f5215bb1281c93f1fea2";

/**
 * Loads the fixture in a fresh browser, ticks it, and returns the hash.
 * @param {import("node:test").TestContext} t
 * @returns {Promise<string>}
 */
async function hashAfterFixedRun(t) {
    const session = await launchGame();
    t.after(() => session.close());

    await waitForMainMenu(session.page);
    await loadFixtureGame(session.page, FIXTURE);

    const { tickRate } = await prepareDeterministicRun(session.page);
    assert.equal(tickRate, 60, "tick rate was not pinned");

    const { ticksRun } = await runTicks(session.page, TICK_COUNT);
    // game_time.js:87 zeroes the logic budget when root.hud.shouldPauseGame() is
    // true, in which case performTicks runs nothing and the test would happily
    // hash an un-ticked save. Prove the ticks happened.
    assert.equal(ticksRun, TICK_COUNT, "the simulation did not actually advance");

    assert.deepEqual(session.pageErrors, [], "uncaught exception(s) during the hash run");

    return hashSimulationState(session.page);
}

test("two identical runs produce an identical hash", async t => {
    const first = await hashAfterFixedRun(t);
    const second = await hashAfterFixedRun(t);
    assert.equal(second, first);
});

test("the hash matches the committed reference", async t => {
    assert.equal(await hashAfterFixedRun(t), GOLDEN_SAVE_HASH);
});
