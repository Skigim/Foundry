const { rspack } = require("@rspack/core");
const { BUILD_VARIANTS } = require("./build_variants");

function requireUncached(module) {
    delete require.cache[require.resolve(module)];
    return require(module);
}

const STATS_OPTIONS = {
    preset: "errors-warnings",
    colors: true,
    timings: true,
};

/**
 * Runs a single Rspack build to completion.
 * @param {object} config
 * @returns {Promise<void>}
 */
function runRspack(config) {
    return new Promise((resolve, reject) => {
        rspack(config, (err, stats) => {
            if (err) {
                reject(err);
                return;
            }
            console.log(stats.toString(STATS_OPTIONS));
            if (stats.hasErrors()) {
                reject(new Error("Bundle failed to build"));
                return;
            }
            resolve();
        });
    });
}

/**
 * Starts a watching Rspack build. Resolves after the FIRST successful build and
 * keeps rebuilding after that - gulpfile.js's serveHTML fires this task and
 * discards its callback, so resolving early lets the serve task finish while
 * the watcher keeps running.
 * @param {object} config
 * @param {object} browserSync
 * @returns {Promise<void>}
 */
function watchRspack(config, browserSync) {
    return new Promise(resolveFirstBuild => {
        let resolved = false;
        const compiler = rspack(config);

        compiler.watch({}, (err, stats) => {
            if (err) {
                console.error(err);
            } else {
                console.log(stats.toString(STATS_OPTIONS));
                if (!stats.hasErrors()) {
                    browserSync.reload();
                }
            }
            if (!resolved) {
                resolved = true;
                resolveFirstBuild();
            }
        });
    });
}

/**
 * PROVIDES (per <variant>)
 *
 * js.<variant>.dev.watch
 * js.<variant>.dev
 * js.<variant>.prod
 *
 */

function gulptasksJS($, gulp, buildFolder, browserSync) {
    for (const variant in BUILD_VARIANTS) {
        const data = BUILD_VARIANTS[variant];

        gulp.task("js." + variant + ".dev.watch", () =>
            watchRspack(
                requireUncached("./rspack.config.js")({
                    ...data.buildArgs,
                    standalone: data.standalone,
                }),
                browserSync
            )
        );

        gulp.task("js." + variant + ".dev", () =>
            runRspack(
                requireUncached("./rspack.config.js")({
                    ...data.buildArgs,
                    standalone: data.standalone,
                })
            )
        );

        if (!data.standalone) {
            // WEB
            gulp.task("js." + variant + ".prod.es6", () =>
                runRspack(
                    requireUncached("./rspack.production.config.js")({
                        es6: true,
                        environment: data.environment,
                        ...data.buildArgs,
                    })
                )
            );
            gulp.task("js." + variant + ".prod", gulp.parallel("js." + variant + ".prod.es6"));
        } else {
            // STANDALONE
            gulp.task("js." + variant + ".prod", () =>
                runRspack(
                    requireUncached("./rspack.production.config.js")({
                        ...data.buildArgs,
                        environment: "prod",
                        es6: true,
                        standalone: true,
                    })
                )
            );
        }
    }
}

module.exports = {
    gulptasksJS,
};
