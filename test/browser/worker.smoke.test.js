// Web-worker smoke test.
//
// src/js/core/async_compression.js runs savegame compression on a worker. How
// that worker is loaded is bundler-specific, and Stage 1 changes it: from
// worker-loader's inlined blob to a separate chunk resolved through
// output.publicPath. Neither the boot smoke test nor the golden-save hash would
// notice it breaking - the boot path never posts a compression job, and
// AnimationFrame swallows its own worker's errors (animation_frame.js:23-25).
//
// Requires a dev build in build/ (window.shapez is dev-only).

import { test } from "node:test";
import assert from "node:assert/strict";

import { launchGame, waitForMainMenu } from "./harness.js";

test("the compression worker round-trips a job", async t => {
    const session = await launchGame();
    t.after(() => session.close());

    await waitForMainMenu(session.page);

    const result = await session.page.evaluate(async () => {
        const compressed = await window.shapez.asyncCompressor.compressObjectAsync({
            hello: "world",
            nested: [1, 2, 3],
        });
        return { type: typeof compressed, length: compressed ? compressed.length : 0 };
    });

    assert.equal(result.type, "string", "compressObjectAsync did not resolve to a string");
    assert.ok(result.length > 0, "compressObjectAsync resolved to an empty string");

    assert.deepEqual(session.pageErrors, [], "uncaught exception(s) during the worker round-trip");
});
