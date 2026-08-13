// Developer tool: run the golden-save fixture and print its hash, optionally
// writing the hashed subset out as JSON for diffing.
//
// This is the companion to the "never regenerate the reference to make CI green"
// rule. When the hash moves, this is how you find out whether the move is a real
// simulation change or a harness problem:
//
//   node test/browser/dump_state.js                  # print the hash
//   node test/browser/dump_state.js run-a.json       # print it and write the subset
//
// Two writes to different files, then `diff run-a.json run-b.json`, localises a
// nondeterminism to the exact serialized field.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    launchGame,
    waitForMainMenu,
    loadFixtureGame,
    prepareDeterministicRun,
    runTicks,
    dumpSimulationSubset,
    stableStringify,
    REPO_ROOT,
} from "./harness.js";

const TICK_COUNT = 600;
const outFile = process.argv[2];

const fixture = JSON.parse(readFileSync(join(REPO_ROOT, "test", "fixtures", "golden_save.json"), "utf8"));

const session = await launchGame();

try {
    await waitForMainMenu(session.page);
    await loadFixtureGame(session.page, fixture);
    await prepareDeterministicRun(session.page);

    const { ticksRun } = await runTicks(session.page, TICK_COUNT);
    if (ticksRun !== TICK_COUNT) {
        throw new Error(`Ran ${ticksRun} of ${TICK_COUNT} ticks; the simulation did not advance.`);
    }

    const subset = await dumpSimulationSubset(session.page);
    console.log(createHash("sha256").update(stableStringify(subset)).digest("hex"));

    if (outFile) {
        // Pretty-printed with sorted keys, so a diff of two of these lines up.
        writeFileSync(outFile, JSON.stringify(JSON.parse(stableStringify(subset)), null, 4) + "\n");
        console.error(`Wrote subset to ${outFile}`);
    }
} finally {
    await session.close();
}
