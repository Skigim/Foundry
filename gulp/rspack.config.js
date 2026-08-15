// @ts-nocheck

const path = require("path");
const rspack = require("@rspack/core");
const { getRevision, getVersion, getAllResourceImages } = require("./buildutils");

module.exports = ({
    standalone = false,
    chineseVersion = false,
    wegameVersion = false,
    steamDemo = false,
    gogVersion = false,
}) => {
    return {
        mode: "development",
        devtool: "cheap-source-map",
        entry: {
            "bundle.js": [path.resolve(__dirname, "../src/js/main.js")],
        },
        resolve: {
            alias: {
                "global-compression": path.resolve(__dirname, "..", "src", "js", "core", "lzstring.js"),
            },
            // webpack 4's node: { fs: "empty" }.
            fallback: {
                fs: false,
                crypto: false,
            },
        },
        context: path.resolve(__dirname, ".."),
        plugins: [
            new rspack.DefinePlugin({
                assert: "window.assert",
                assertAlways: "window.assert",
                abstract:
                    "window.assert(false, 'abstract method called of: ' + (this.name || (this.constructor && this.constructor.name)));",
                G_HAVE_ASSERT: "true",
                G_APP_ENVIRONMENT: JSON.stringify("dev"),
                G_CHINA_VERSION: JSON.stringify(chineseVersion),
                G_WEGAME_VERSION: JSON.stringify(wegameVersion),
                G_GOG_VERSION: JSON.stringify(gogVersion),
                G_IS_DEV: "true",
                G_IS_RELEASE: "false",
                G_IS_BROWSER: "true",
                G_IS_STANDALONE: JSON.stringify(standalone),
                G_IS_STEAM_DEMO: JSON.stringify(steamDemo),
                G_BUILD_TIME: "" + new Date().getTime(),
                G_BUILD_COMMIT_HASH: JSON.stringify(getRevision()),
                G_BUILD_VERSION: JSON.stringify(getVersion()),
                G_ALL_UI_IMAGES: JSON.stringify(getAllResourceImages()),
            }),
        ],
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
                    test: /\.md$/,
                    use: [{ loader: "html-loader" }, "markdown-loader"],
                },
                {
                    test: /\.js$/,
                    enforce: "pre",
                    exclude: /node_modules/,
                    use: [
                        {
                            loader: "webpack-strip-block",
                            options: {
                                start: "typehints:start",
                                end: "typehints:end",
                            },
                        },
                        {
                            loader: path.resolve(__dirname, "mod.js"),
                        },
                    ],
                },
                {
                    test: /\.ya?ml$/,
                    type: "json",
                    use: "yaml-loader",
                },
            ],
        },
        output: {
            filename: "bundle.js",
            path: path.resolve(__dirname, "..", "build"),
            // Must be explicit. gulp/preloader/preloader.js XHRs bundle.js into a
            // Blob and loads it from a blob: URL, so automatic public-path
            // detection (document.currentScript.src) resolves to blob:... and the
            // emitted worker chunk would be fetched from a nonexistent origin.
            // Standalone/electron includes bundle.js with a plain <script src>
            // from a file:// document, where a relative path is correct.
            publicPath: standalone ? "" : "/",
        },
    };
};
