// Stage 0 browser harness.
//
// Serves a real built dev bundle over localhost and opens it in headless
// Chromium. Everything here is test-side; no hooks are added to src/js.
//
// Why a real build and a real browser rather than plain Node: any bundle
// containing game/core.js contains every .js file under src/js, because
// savegame.js imports modloader.js, which calls require.context("../", true,
// /\.js$/) — resolved statically at build time regardless of the G_IS_DEV gate
// around exposeExports(). So there is no small bundle to load under Node, and
// once a full build is required anyway a real browser costs little more. The
// same require.context is what puts every export on window.shapez, which is how
// the tests reach into the game.
//
// Full reasoning: docs/superpowers/specs/2026-08-12-stage0-browser-harness-design.md

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUILD_DIR = join(REPO_ROOT, "build");
export const ATLAS_DIR = join(REPO_ROOT, "res_built", "atlas");

const BUILD_COMMAND_DEV = [
    "cd gulp",
    "yarn gulp build.prepare.dev",
    "yarn gulp js.web-localhost.dev",
    "yarn gulp html.web-localhost.dev",
].join(" && ");

// Reuses build.prepare.dev's assets deliberately: this stage replaces the JS
// bundler, so the prod smoke test covers the prod JS bundle, not the prod CSS
// or image pipelines. Run build.prepare.dev once, then this - it does not
// re-clean build/.
const BUILD_COMMAND_PROD = [
    "cd gulp",
    "yarn gulp build.prepare.dev",
    "yarn gulp js.web-shapezio.prod",
    "yarn gulp html.web-shapezio.prod",
].join(" && ");

const MIME_TYPES = {
    ".css": "text/css",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".mp3": "audio/mpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webm": "video/webm",
    ".woff2": "font/woff2",
};

/**
 * Fails loudly if there is no usable build to test against.
 * @param {{ flavor?: "dev" | "prod" }} [options]
 * @returns {void}
 */
export function assertBuildPresent(options = {}) {
    const { flavor = "dev" } = options;
    const command = flavor === "prod" ? BUILD_COMMAND_PROD : BUILD_COMMAND_DEV;

    for (const file of ["index.html", "bundle.js", "main.css"]) {
        if (!existsSync(join(BUILD_DIR, file))) {
            throw new Error(`Missing build/${file}. Build the ${flavor} bundle first:\n  ${command}`);
        }
    }

    // gulp/image-resources.js:111 catches its own failures and still calls cb(),
    // so a broken atlas build reports success. The game then hangs forever on
    // "Downloading resources" — states/preload.js:211 returns a promise that
    // never resolves when resource loading fails. Catch it here, where the
    // message can say what actually happened.
    const sprites = existsSync(ATLAS_DIR) ? readdirSync(ATLAS_DIR).filter(f => f.endsWith(".png")) : [];
    if (sprites.length === 0) {
        throw new Error(
            "res_built/atlas contains no .png sprites: imgres.buildAtlas failed silently. " +
                "Check that `java -version` works and that gulp/runnable-texturepacker.jar downloaded."
        );
    }
}

/**
 * Serves a directory over an ephemeral localhost port. The game needs a real
 * http origin — IndexedDB, which mods/modloader.js opens during boot, is
 * unavailable on file://.
 * @param {string} rootDir
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export function startStaticServer(rootDir = BUILD_DIR) {
    const server = createServer((req, res) => {
        // gulp/html.js cachebusts prod asset URLs to /v/<commitHash>/<path>
        // (buildutils.js:44-46); the real deploy strips that prefix at the
        // server. Dev builds never emit it, so stripping unconditionally is
        // safe and keeps one server serving both flavors.
        const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(
            /^\/v\/[^/]+\//,
            "/"
        );
        const filePath = join(rootDir, pathname === "/" ? "index.html" : pathname);

        if (!filePath.startsWith(rootDir)) {
            res.writeHead(403).end();
            return;
        }

        let body;
        try {
            if (!statSync(filePath).isFile()) {
                throw new Error("not a file");
            }
            body = readFileSync(filePath);
        } catch {
            res.writeHead(404).end();
            return;
        }

        res.writeHead(200, {
            "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
        });
        res.end(body);
    });

    return new Promise(ready => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = /** @type {{ port: number }} */ (server.address());
            ready({
                url: `http://127.0.0.1:${port}/`,
                close: () => new Promise(done => server.close(() => done())),
            });
        });
    });
}

/**
 * @typedef {object} GameSession
 * @property {import("playwright").Page} page
 * @property {string[]} pageErrors Uncaught exceptions, newest last.
 * @property {string[]} consoleErrors console.error output. Reported, not asserted on.
 * @property {() => Promise<void>} close
 */

/**
 * Serves and opens the dev bundle. Returns as soon as navigation starts; use
 * waitForMainMenu to wait for boot.
 * @param {{ allowExternalRequests?: boolean, headless?: boolean, flavor?: "dev" | "prod" }} [options]
 * @returns {Promise<GameSession>}
 */
export async function launchGame(options = {}) {
    const { allowExternalRequests = false, headless = true, flavor = "dev" } = options;

    assertBuildPresent({ flavor });

    const server = await startStaticServer();
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

    if (!allowExternalRequests) {
        // The game pings analytics and api endpoints during preload. Those calls
        // are already failure-tolerant (preload.js:147 wraps fetchDiscounts in
        // timeoutPromise), so refusing them is faster than waiting for a real
        // timeout and stops CI depending on third-party uptime. Flip
        // allowExternalRequests if a boot failure ever looks network-shaped.
        await context.route("**/*", route => {
            const { hostname } = new URL(route.request().url());
            return hostname === "127.0.0.1" || hostname === "localhost" ? route.continue() : route.abort();
        });
    }

    const page = await context.newPage();

    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", err => pageErrors.push(err.stack || String(err)));
    page.on("console", msg => {
        if (msg.type() === "error") {
            consoleErrors.push(msg.text());
        }
    });

    await page.goto(server.url);

    return {
        page,
        pageErrors,
        consoleErrors,
        async close() {
            await browser.close();
            await server.close();
        },
    };
}

/**
 * Waits for the state manager to have entered MainMenuState. It sets
 * document.body.id = "state_" + key (core/state_manager.js:88), which is a
 * state-machine fact rather than a rendering timing guess - and which holds on
 * a prod bundle too, where window.shapez does not exist.
 * @param {import("playwright").Page} page
 * @param {{ timeoutMs?: number, expectDevGlobals?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function waitForMainMenu(page, options = {}) {
    const { timeoutMs = 90000, expectDevGlobals = true } = options;
    try {
        await page.waitForFunction(() => document.body.id === "state_MainMenuState", null, {
            timeout: timeoutMs,
        });
    } catch (err) {
        // Two known causes produce this same symptom (timeout, never reaching
        // the main menu) with a misleading preloader-status message, so check
        // for them before falling back to that message alone.
        const diagnosis = await page
            .evaluate(expectDev => {
                if (!window.shapez) {
                    // On a prod bundle this is expected, not a diagnosis:
                    // exposeExports() is gated on G_IS_DEV || G_IS_STANDALONE
                    // (modloader.js:111).
                    return expectDev
                        ? "window.shapez is undefined - this looks like a prod build, not a dev build."
                        : null;
                }
                const debug = window.shapez.globalConfig.debug;
                const offenders = ["fastGameEnter", "noArtificialDelays"].filter(flag => debug[flag]);
                if (offenders.length > 0) {
                    const flagList = offenders.join(", ");
                    return (
                        `globalConfig.debug has ${flagList} set (see src/js/core/config.local.js) - that ` +
                        "is why the main menu was never reached, not a preloader/atlas problem."
                    );
                }
                return null;
            }, expectDevGlobals)
            .catch(() => "(could not inspect window.shapez to diagnose further)");

        // PreloadState hangs rather than throwing when resource loading fails, so
        // its own status line is the only thing that says how far boot got.
        const status = await page.textContent("#ll_preload_status").catch(() => "(unavailable)");
        const suffix = diagnosis ? ` ${diagnosis}` : "";
        throw new Error(`Never reached the main menu. Preloader status: "${status}".${suffix}`, {
            cause: err,
        });
    }
}

/** The subset phase-1.md specifies, minus time.realtimeSeconds (removed below). */
export const HASHED_KEYS = ["map", "entityMgr", "entities", "beltPaths", "hubGoals", "time", "gameMode"];

/** Debug flags from the gitignored config.local.js that change simulation output outright. */
const SIMULATION_ALTERING_DEBUG_FLAGS = [
    "instantBelts",
    "instantProcessors",
    "instantMiners",
    "disableEjectorProcessing",
    "disableLogicTicks",
    "framePausesBetweenTicks",
    "rewardsInstant",
    "disableUnlockDialog",
    "externalModUrl",
    "manualTickOnly",
];

/**
 * Starts a brand new game and waits for it to be running. Used by the fixture
 * generator, not by the hash test.
 * @param {import("playwright").Page} page
 * @returns {Promise<void>}
 */
export async function startNewGame(page) {
    await page.evaluate(() => {
        const app = window.shapez.GLOBAL_APP;
        app.stateMgr.moveToState("InGameState", { savegame: app.savegameMgr.createNewSavegame() });
    });
    await waitForGameRunning(page);
}

/**
 * Loads a committed fixture through the real deserialize path.
 * @param {import("playwright").Page} page
 * @param {{ savegameVersion: number, dump: object }} fixture
 * @returns {Promise<void>}
 */
export async function loadFixtureGame(page, fixture) {
    const versionError = await page.evaluate(f => {
        const app = window.shapez.GLOBAL_APP;
        const current = window.shapez.Savegame.getCurrentVersion();
        if (f.savegameVersion !== current) {
            return `Fixture is savegame version ${f.savegameVersion} but the game is at ${current}. Migrating the fixture is a deliberate, reviewed step — do not silently regenerate it.`;
        }

        const savegame = app.savegameMgr.createNewSavegame();
        savegame.currentData = {
            version: current,
            dump: f.dump,
            stats: { failedMam: false, trashedCount: 0, usedInverseRotater: false },
            lastUpdate: 0,
            mods: [],
        };
        // hasGameDump() is what routes InGameState to stage4bResumeGame rather
        // than stage4aInitEmptyGame (states/ingame.js:261).
        app.stateMgr.moveToState("InGameState", { savegame });
        return null;
    }, fixture);

    if (versionError) {
        throw new Error(versionError);
    }

    await waitForGameRunning(page);
}

/**
 * Waits for the game to be running, without ever letting the natural
 * warmup-to-running transition execute.
 *
 * Deviation from the literal brief: the brief's waitForGameRunning polled for
 * `stage === "s10_gameRunning"` and left the frame loop alone until the
 * caller separately invoked prepareDeterministicRun. That is too late.
 * ingame.js's onRender (states/ingame.js:436-447) decrements
 * warmupTimeSeconds each real animation frame and, the moment it crosses
 * zero, calls stage10GameRunning() *and then falls through in the same
 * synchronous callback* to `this.core.tick(dt)` using that frame's real,
 * wall-clock-derived dt — a genuine, non-deterministic logic step (mining
 * progress, ejector progress, belt item positions all actually advance)
 * that runs before any Playwright-side code can react, let alone before
 * prepareDeterministicRun gets to freeze the ticker or pin the tick rate.
 *
 * Confirmed empirically: three back-to-back runs of the fixture generator
 * (300 controlled ticks each, identical inputs) produced
 * dump.time.timeSeconds of 4.9999, 5.0166, 5.0166 — i.e. 300 vs 301 ticks'
 * worth of simulation, depending on whether that spurious real-timed tick
 * fired before control returned to us. A "determinism controls" harness
 * cannot leave that race in place.
 *
 * Fix: intercept one stage earlier, at "s7_warmup" (draw-only, no ticking
 * happens there), and in the same synchronous evaluate() call both freeze
 * the frame loop *and* force the s7->s10 transition ourselves by calling
 * the state's own stage10GameRunning() directly. That method only flips the
 * stage, dispatches signals, and resizes — it does not tick — so forcing it
 * ourselves reproduces the natural transition's visible effects without its
 * real-timed side tick. Because both actions happen inside that one
 * synchronous page.evaluate(), the primary race — the spurious tick that
 * would otherwise fall through in the same onRender callback that flips the
 * stage — is fully closed: there is no window for a real animation frame to
 * land between "flip the stage" and "freeze the loop" once we're the one
 * doing the flipping.
 *
 * That does not cover every window, though. Between the moment
 * waitForFunction's poll first *observes* `stage === "s7_warmup"` in the
 * page and the moment the follow-up evaluate() call above actually executes
 * there, there's an unavoidable IPC round-trip back to Node and out again.
 * On a slow or loaded runner, a real animation frame could in principle
 * land in that gap and let the natural transition (and its spurious tick)
 * fire first, before this function's evaluate() ever runs. This narrower
 * window is not closed by timing — it's closed by the `alreadyRunning`
 * check below: if the natural transition wins that race, this function
 * throws instead of silently proceeding on a state that already contains an
 * uncontrolled tick. So the guarantee this function actually provides is
 * "either no spurious tick occurred, or you get a loud failure" — not "a
 * spurious tick is provably impossible."
 * @param {import("playwright").Page} page
 * @returns {Promise<void>}
 */
async function waitForGameRunning(page) {
    await page.waitForFunction(
        () => {
            const state = window.shapez.GLOBAL_APP.stateMgr.currentState;
            return state && (state.stage === "s7_warmup" || state.stage === "s10_gameRunning");
        },
        null,
        { timeout: 60000 }
    );

    const alreadyRunning = await page.evaluate(() => {
        const app = window.shapez.GLOBAL_APP;
        const state = app.stateMgr.currentState;
        if (state.stage === "s10_gameRunning") {
            // The natural transition beat us here (e.g. a local
            // config.local.js with debug.noArtificialDelays set, which zeroes
            // globalConfig.warmupTimeSecondsRegular/Fast). The spurious tick
            // has already happened by this point and cannot be undone.
            return true;
        }
        // Freeze the frame loop *before* forcing the transition, so the
        // transition itself cannot be followed by a real-timed tick either.
        app.ticker.frameEmitted.removeAll();
        app.ticker.bgFrameEmitted.removeAll();
        state.stage10GameRunning();
        return false;
    });

    if (alreadyRunning) {
        throw new Error(
            "Game reached s10_gameRunning before the harness could freeze the frame loop " +
                "(check config.local.js for globalConfig.debug.noArtificialDelays or similar). " +
                "A non-deterministic real-timed tick may already have run; refusing to proceed."
        );
    }
}

/**
 * Removes every source of nondeterminism from the measured window, then proves
 * the removal took. Call once, after the game is running and before ticking.
 * @param {import("playwright").Page} page
 * @param {{ tickRate?: number }} [options]
 * @returns {Promise<{ tickRate: number }>}
 */
export async function prepareDeterministicRun(page, options = {}) {
    const { tickRate = 60 } = options;

    const result = await page.evaluate(
        ({ rate, flags }) => {
            const app = window.shapez.GLOBAL_APP;
            const root = app.stateMgr.currentState.core.root;

            // 1. Stop the ambient frame loop. The game drives itself off
            //    requestAnimationFrame (application.js:168); letting the browser
            //    decide how many ticks elapsed is nondeterministic by
            //    construction. rAF keeps spinning harmlessly, the game just stops
            //    advancing on its own.
            app.ticker.frameEmitted.removeAll();
            app.ticker.bgFrameEmitted.removeAll();

            // 2. Pin the tick rate. DynamicTickrate reads
            //    app.settings.getDesiredFps() at construction
            //    (dynamic_tickrate.js:31); deltaSeconds feeds time.timeSeconds,
            //    which is hashed. A fresh browser profile yields the default, but
            //    depending on the default never changing is not a control.
            root.dynamicTickrate.setTickRate(rate);

            // 3. globalConfig.debug comes from the gitignored config.local.js, so
            //    it differs per checkout. A developer who left instantBelts on
            //    while debugging would otherwise get a different hash from CI
            //    with no indication why.
            const offenders = flags.filter(flag => window.shapez.globalConfig.debug[flag]);
            if (offenders.length > 0) {
                return {
                    error:
                        "Simulation-altering debug flags are enabled in src/js/core/config.local.js: " +
                        offenders.join(", "),
                };
            }

            return { tickRate: root.dynamicTickrate.currentTickRate };
        },
        { rate: tickRate, flags: SIMULATION_ALTERING_DEBUG_FLAGS }
    );

    if (result.error) {
        throw new Error(result.error);
    }
    return result;
}

/**
 * Steps the simulation a fixed number of ticks and reports how many actually ran.
 * @param {import("playwright").Page} page
 * @param {number} tickCount
 * @returns {Promise<{ ticksRun: number, timeSeconds: number }>}
 */
export async function runTicks(page, tickCount) {
    return page.evaluate(count => {
        const core = window.shapez.GLOBAL_APP.stateMgr.currentState.core;
        const root = core.root;
        const before = root.time.timeSeconds;

        for (let i = 0; i < count; ++i) {
            // performTicks, not core.tick: core.tick calls updateRealtimeNow()
            // (game/core.js:282), which reads performance.now() into the
            // serialized realtimeSeconds. performTicks is the real stepping code
            // the game itself uses, and timeSeconds still advances by the correct
            // fixed deltaSeconds per tick, so the simulation sees a
            // normally-advancing clock rather than a frozen one.
            root.time.performTicks(root.dynamicTickrate.deltaMs, () => core.updateLogic());
        }

        const elapsed = root.time.timeSeconds - before;
        return {
            ticksRun: Math.round(elapsed * root.dynamicTickrate.currentTickRate),
            timeSeconds: root.time.timeSeconds,
        };
    }, tickCount);
}

/**
 * The hashed subset of the serializer's dump.
 * @param {import("playwright").Page} page
 * @returns {Promise<object>}
 */
export async function dumpSimulationSubset(page) {
    const result = await page.evaluate(keys => {
        const root = window.shapez.GLOBAL_APP.stateMgr.currentState.core.root;
        const dump = new window.shapez.SavegameSerializer().generateDumpFromGameRoot(root);
        if (!dump) {
            // generateDumpFromGameRoot returns null when its own sanity check
            // fails in a dev build (savegame_serializer.js:56).
            return {
                error:
                    "generateDumpFromGameRoot returned null: the serialized state failed its own sanity check. See the browser console for the reason.",
            };
        }

        const subset = {};
        for (const key of keys) {
            subset[key] = dump[key];
        }
        // realtimeSeconds is performance.now()-derived (game_time.js:55).
        // Excluded regardless of the performTicks control above, so the hash
        // survives someone later reintroducing a frame into the measured window.
        // Guarded rather than assumed present: if a future edit to HASHED_KEYS
        // ever drops "time", this would otherwise throw inside the page and
        // surface as an opaque "Evaluation failed: TypeError".
        if (subset.time) {
            delete subset.time.realtimeSeconds;
        }
        return { subset };
    }, HASHED_KEYS);

    if (result.error) {
        throw new Error(result.error);
    }
    return result.subset;
}

/**
 * JSON with keys sorted at every level, so the hash does not move on harmless
 * key reordering in the serializers.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
    if (Array.isArray(value)) {
        return "[" + value.map(stableStringify).join(",") + "]";
    }
    if (value && typeof value === "object") {
        const entries = Object.keys(value)
            .sort()
            .map(key => JSON.stringify(key) + ":" + stableStringify(value[key]));
        return "{" + entries.join(",") + "}";
    }
    const primitive = JSON.stringify(value);
    return primitive === undefined ? "null" : primitive;
}

/**
 * @param {import("playwright").Page} page
 * @returns {Promise<string>} sha256 hex digest of the hashed subset
 */
export async function hashSimulationState(page) {
    const subset = await dumpSimulationSubset(page);
    return createHash("sha256").update(stableStringify(subset)).digest("hex");
}
