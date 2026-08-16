// Boot smoke test, production bundle.
//
// The dev-bundle sibling (../boot.smoke.test.js) is Stage 0 artifact 4. This is
// the same assertion against a prod bundle, and it exists because the prod build
// is where Stage 1's real risk lives: three strip-block passes instead of one,
// a minifier, babel, and a bundle the preloader loads from a blob: URL rather
// than a plain <script src>.
//
// Requires a PROD build in build/. See harness.js's BUILD_COMMAND_PROD.

import { test } from "node:test";
import assert from "node:assert/strict";

import { launchGame, waitForMainMenu } from "../harness.js";

test("the prod bundle boots to the main menu with no uncaught errors", async t => {
    const session = await launchGame({ flavor: "prod" });
    t.after(() => session.close());

    await waitForMainMenu(session.page, { expectDevGlobals: false });

    await session.page.waitForSelector(".mainContainer[data-savegames]", { timeout: 10000 });

    // Prove this actually tested a prod bundle rather than a stale dev one left
    // in build/. exposeExports() is gated on G_IS_DEV || G_IS_STANDALONE
    // (mods/modloader.js:111) and webpack.production.config.js hardcodes
    // G_IS_DEV: "false", so window.shapez is the cleanest available tell.
    const hasDevGlobals = await session.page.evaluate(() => typeof window.shapez !== "undefined");
    assert.equal(hasDevGlobals, false, "window.shapez exists - build/ holds a dev bundle, not a prod one");

    if (session.consoleErrors.length > 0) {
        t.diagnostic("console.error during boot:\n" + session.consoleErrors.join("\n"));
    }

    assert.deepEqual(session.pageErrors, [], "uncaught exception(s) during boot");
});
