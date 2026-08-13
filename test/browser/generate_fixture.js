// One-shot developer tool: writes test/fixtures/golden_save.json.
//
// The fixture is built in code through the real building/entity APIs rather than
// captured from live play, so it is reproducible and depends on nothing random at
// test time. It is a miner on a resource patch feeding a straight run of belts
// with no consumer at the far end — enough to exercise miner ejection, belt path
// item movement and belt-to-belt handoff, small enough to stay fast in CI, and
// short enough of steady state that items are still mid-belt when the hash is
// taken.
//
// Run with a dev build present:
//   node test/browser/generate_fixture.js
//
// Regenerating the fixture changes the golden hash and is a deliberate, reviewed
// step. It is not a way to make CI green.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    launchGame,
    waitForMainMenu,
    startNewGame,
    prepareDeterministicRun,
    runTicks,
    REPO_ROOT,
} from "./harness.js";

const BELT_COUNT = 20;
// Deviation from the literal brief (which used 120): globalConfig.minerSpeedItemsPerSecond
// defaults to beltSpeedItemsPerSecond / 5 = 0.4 items/s (src/js/core/config.js:82,152), so
// MinerSystem's mineDuration = 1 / 0.4 = 2.5s = 150 ticks at 60/s
// (src/js/game/systems/miner.js:70-71) before the very first item is even ejected, plus
// ~24 more ticks for the ejector slot's progress to reach 1.0 and hand off to the belt path
// (src/js/game/systems/item_ejector.js:161-166: progressGrowth = 2 * deltaSeconds *
// beltBaseSpeed * itemSpacingOnBelts ≈ 0.042/tick). 120 ticks (2s) is short of both; the
// generator's own zero-items guard below correctly refused to write a fixture at that
// value. 300 ticks (5s) clears both with margin and still lands with only 1 item in
// flight, i.e. still short of steady state as intended.
const WARMUP_TICKS = 300;

const session = await launchGame();

try {
    await waitForMainMenu(session.page);
    await startNewGame(session.page);
    await prepareDeterministicRun(session.page);

    const built = await session.page.evaluate(beltCount => {
        const s = window.shapez;
        const root = s.GLOBAL_APP.stateMgr.currentState.core.root;

        // Find a resource tile well clear of the hub at the origin, with room to
        // run belts further north (decreasing y) without meeting anything.
        let patch = null;
        for (let y = -15; y >= -40 && !patch; --y) {
            for (let x = -40; x <= 40; ++x) {
                if (root.map.getLowerLayerContentXY(x, y)) {
                    patch = { x, y };
                    break;
                }
            }
        }
        if (!patch) {
            return { error: "Found no resource tile in the search band; widen the search." };
        }

        const place = (building, x, y) =>
            root.logic.tryPlaceBuilding({
                origin: new s.Vector(x, y),
                rotation: 0, // 0 degrees = "top" = decreasing y, so everything faces north
                originalRotation: 0,
                rotationVariant: 0,
                variant: s.defaultBuildingVariant,
                building,
            });

        const miner = place(s.gMetaBuildingRegistry.findByClass(s.MetaMinerBuilding), patch.x, patch.y);
        if (!miner) {
            return { error: `Could not place the miner at ${patch.x},${patch.y}` };
        }

        const belt = s.gMetaBuildingRegistry.findByClass(s.MetaBeltBuilding);
        for (let i = 1; i <= beltCount; ++i) {
            if (!place(belt, patch.x, patch.y - i)) {
                return { error: `Could not place belt ${i} at ${patch.x},${patch.y - i}` };
            }
        }

        return { patch, entityCount: root.entityMgr.entities.length };
    }, BELT_COUNT);

    if (built.error) {
        throw new Error(built.error);
    }
    console.log(`Placed a miner at ${built.patch.x},${built.patch.y} and ${BELT_COUNT} belts north of it.`);

    // Warm up so the fixture ships with items already in flight.
    const warmup = await runTicks(session.page, WARMUP_TICKS);
    if (warmup.ticksRun !== WARMUP_TICKS) {
        throw new Error(`Warmup ran ${warmup.ticksRun} of ${WARMUP_TICKS} ticks.`);
    }

    const fixture = await session.page.evaluate(() => {
        const s = window.shapez;
        const root = s.GLOBAL_APP.stateMgr.currentState.core.root;
        const dump = new s.SavegameSerializer().generateDumpFromGameRoot(root);
        if (!dump) {
            return { error: "generateDumpFromGameRoot returned null; the state failed its sanity check." };
        }
        // A fixture with no items in flight would hash the same whether the
        // simulation ran or not, which is the whole thing this artifact exists to
        // detect. Refuse to write one.
        const itemsOnBelts = dump.beltPaths.reduce((total, path) => total + path.items.length, 0);
        if (itemsOnBelts === 0) {
            return {
                error:
                    "No items on any belt path after warmup; the fixture would not exercise the simulation.",
            };
        }
        return { dump, itemsOnBelts, savegameVersion: s.Savegame.getCurrentVersion() };
    });

    if (fixture.error) {
        throw new Error(fixture.error);
    }

    const target = join(REPO_ROOT, "test", "fixtures", "golden_save.json");
    writeFileSync(
        target,
        JSON.stringify({ savegameVersion: fixture.savegameVersion, dump: fixture.dump }, null, 4) + "\n"
    );
    console.log(`Wrote ${target} (${fixture.itemsOnBelts} items in flight).`);
} finally {
    await session.close();
}
