// Stage 0 artifact 4: boot smoke test.
//
// Proves the built dev bundle launches in a real browser and reaches the main
// menu with no uncaught exception. This is the guard Stage 1's build rewrite is
// measured against: a bundler swap that produces something which no longer boots
// fails here, loudly, instead of being discovered by hand later.
//
// Requires a dev build in build/. See harness.js for the exact command.

import { test } from "node:test";
import assert from "node:assert/strict";

import { launchGame, waitForMainMenu } from "./harness.js";

test("the dev bundle boots to the main menu with no uncaught errors", async t => {
    const session = await launchGame();
    t.after(() => session.close());

    await waitForMainMenu(session.page);

    // MainMenuState.renderMainMenu() sets data-savegames on .mainContainer as its
    // last act, so this waits for the menu to have finished rendering rather than
    // racing the state switch that put us here.
    await session.page.waitForSelector(".mainContainer[data-savegames]", { timeout: 10000 });

    // Reported, not asserted on: blocked third-party requests log here by design,
    // and so does anything the game considers survivable.
    if (session.consoleErrors.length > 0) {
        t.diagnostic("console.error during boot:\n" + session.consoleErrors.join("\n"));
    }

    assert.deepEqual(session.pageErrors, [], "uncaught exception(s) during boot");
});
