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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUILD_DIR = join(REPO_ROOT, "build");
export const ATLAS_DIR = join(REPO_ROOT, "res_built", "atlas");

const BUILD_COMMAND = [
    "cd gulp",
    "NODE_OPTIONS=--openssl-legacy-provider yarn gulp build.prepare.dev",
    "NODE_OPTIONS=--openssl-legacy-provider yarn gulp js.web-localhost.dev",
    "NODE_OPTIONS=--openssl-legacy-provider yarn gulp html.web-localhost.dev",
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
 * Fails loudly if there is no usable dev build to test against.
 * @returns {void}
 */
export function assertBuildPresent() {
    for (const file of ["index.html", "bundle.js", "main.css"]) {
        if (!existsSync(join(BUILD_DIR, file))) {
            throw new Error(`Missing build/${file}. Build the dev bundle first:\n  ${BUILD_COMMAND}`);
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
        const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
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
 * @param {{ allowExternalRequests?: boolean, headless?: boolean }} [options]
 * @returns {Promise<GameSession>}
 */
export async function launchGame(options = {}) {
    const { allowExternalRequests = false, headless = true } = options;

    assertBuildPresent();

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
 * state-machine fact rather than a rendering timing guess.
 * @param {import("playwright").Page} page
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export async function waitForMainMenu(page, timeoutMs = 90000) {
    try {
        await page.waitForFunction(() => document.body.id === "state_MainMenuState", null, {
            timeout: timeoutMs,
        });
    } catch (err) {
        // PreloadState hangs rather than throwing when resource loading fails, so
        // its own status line is the only thing that says how far boot got.
        const status = await page.textContent("#ll_preload_status").catch(() => "(unavailable)");
        throw new Error(`Never reached the main menu. Preloader status: "${status}"`, { cause: err });
    }
}
