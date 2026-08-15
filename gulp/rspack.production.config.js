// @ts-nocheck

const path = require("path");
const rspack = require("@rspack/core");
const { getRevision, getVersion, getAllResourceImages } = require("./buildutils");

const TerserPlugin = require("terser-webpack-plugin");

module.exports = ({
    environment,
    es6 = false,

    standalone = false,
    isBrowser = true,

    chineseVersion = false,
    wegameVersion = false,
    steamDemo = false,
    gogVersion = false,
}) => {
    const globalDefs = {
        assert: "false && window.assert",
        assertAlways: "window.assert",
        abstract: "window.assert(false, 'abstract method called');",
        G_IS_DEV: "false",

        G_CHINA_VERSION: JSON.stringify(chineseVersion),
        G_WEGAME_VERSION: JSON.stringify(wegameVersion),
        G_GOG_VERSION: JSON.stringify(gogVersion),
        G_IS_RELEASE: environment === "prod" ? "true" : "false",
        G_IS_STANDALONE: standalone ? "true" : "false",
        G_IS_STEAM_DEMO: JSON.stringify(steamDemo),
        G_IS_BROWSER: isBrowser ? "true" : "false",
        G_APP_ENVIRONMENT: JSON.stringify(environment),
        G_HAVE_ASSERT: "false",
        G_BUILD_TIME: "" + new Date().getTime(),
        G_BUILD_COMMIT_HASH: JSON.stringify(getRevision()),
        G_BUILD_VERSION: JSON.stringify(getVersion()),
        G_ALL_UI_IMAGES: JSON.stringify(getAllResourceImages()),
    };

    const minifyNames = false;

    return {
        mode: "production",
        entry: {
            "bundle.js": [path.resolve(__dirname, "..", "src", "js", "main.js")],
        },
        output: {
            filename: "bundle.js",
            path: path.resolve(__dirname, "..", "build"),
            // See the dev config: the preloader loads bundle.js from a blob: URL,
            // so worker chunk URLs cannot be auto-detected. Web prod additionally
            // cachebusts every asset to /v/<commitHash>/ (gulp/html.js via
            // buildutils.cachebust), so the worker chunk must be requested from
            // the same prefix.
            publicPath: standalone ? "" : "/v/" + getRevision() + "/",
        },
        context: path.resolve(__dirname, ".."),
        devtool: false,
        resolve: {
            alias: {
                "global-compression": path.resolve(__dirname, "..", "src", "js", "core", "lzstring.js"),
            },
            fallback: {
                fs: false,
                crypto: false,
            },
        },
        optimization: {
            minimize: true,
            emitOnErrors: false,
            removeAvailableModules: true,
            removeEmptyChunks: true,
            mergeDuplicateChunks: true,
            providedExports: true,
            usedExports: true,
            concatenateModules: true,
            sideEffects: true,

            minimizer: [
                new TerserPlugin({
                    parallel: true,
                    terserOptions: {
                        ecma: es6 ? 6 : 5,
                        parse: {},
                        module: true,
                        toplevel: true,
                        keep_classnames: !minifyNames,
                        keep_fnames: !minifyNames,
                        safari10: true,
                        compress: {
                            arguments: false, // breaks
                            drop_console: false,
                            global_defs: globalDefs,
                            keep_fargs: !minifyNames,
                            keep_infinity: true,
                            passes: 2,
                            module: true,
                            pure_funcs: [
                                "Math.radians",
                                "Math.degrees",
                                "Math.round",
                                "Math.ceil",
                                "Math.floor",
                                "Math.sqrt",
                                "Math.hypot",
                                "Math.abs",
                                "Math.max",
                                "Math.min",
                                "Math.sin",
                                "Math.cos",
                                "Math.tan",
                                "Math.sign",
                                "Math.pow",
                                "Math.atan2",
                            ],
                            toplevel: true,
                            unsafe_math: true,
                            unsafe_arrows: false,
                        },
                        mangle: {
                            reserved: ["__$S__"],
                            eval: true,
                            keep_classnames: !minifyNames,
                            keep_fnames: !minifyNames,
                            module: true,
                            toplevel: true,
                            safari10: true,
                        },
                        format: {
                            comments: false,
                            ascii_only: true,
                            beautify: false,
                            braces: false,
                            ecma: es6 ? 6 : 5,
                            preamble:
                                "/* Foundry (shapez.io fork) - " +
                                getVersion() +
                                " @ " +
                                getRevision() +
                                " */",
                        },
                    },
                }),
            ],
        },
        plugins: [new rspack.DefinePlugin(globalDefs)],
        module: {
            rules: [
                {
                    test: /\.json$/,
                    enforce: "pre",
                    use: [path.resolve(__dirname, "loader.compressjson.js")],
                    type: "javascript/auto",
                },
                { test: /\.(png|jpe?g|svg)$/, loader: "ignore-loader" },
                { test: /\.nobuild/, loader: "ignore-loader" },
                {
                    test: /\.js$/,
                    enforce: "pre",
                    exclude: /node_modules/,
                    use: [
                        {
                            loader: "webpack-strip-block",
                            options: { start: "typehints:start", end: "typehints:end" },
                        },
                        {
                            loader: "webpack-strip-block",
                            options: { start: "dev:start", end: "dev:end" },
                        },
                        {
                            loader: "webpack-strip-block",
                            options: { start: "wires:start", end: "wires:end" },
                        },
                    ],
                },
                {
                    test: /\.js$/,
                    use: [
                        {
                            loader: path.resolve(__dirname, "mod.js"),
                        },
                        {
                            loader: "babel-loader?cacheDirectory",
                            options: {
                                configFile: require.resolve(
                                    es6 ? "./babel-es6.config.js" : "./babel.config.js"
                                ),
                            },
                        },
                        "uglify-template-string-loader",
                        path.resolve(__dirname, "loader.inline_globals.js"),
                    ],
                },
                {
                    test: /\.md$/,
                    use: ["html-loader", "markdown-loader"],
                },
                {
                    test: /\.ya?ml$/,
                    type: "json",
                    use: "yaml-loader",
                },
            ],
        },
    };
};
