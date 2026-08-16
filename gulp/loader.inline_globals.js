"use strict";

// Replaces string-replace-webpack-plugin, which is webpack-specific, at ^0.1.3,
// and long unmaintained. These four substitutions inline hot constants that are
// otherwise property lookups on globalConfig in every belt/item hot path.
//
// globalConfig.debug -> '' is deliberate and looks wrong: it turns every
// globalConfig.debug.someFlag read into ''.someFlag, which is undefined and
// therefore falsy, so the debug branches fold away under the minifier. Keep the
// semantics exactly - this is a prod-only transform and the golden-save hash is
// what proves it changed nothing.
const REPLACEMENTS = [
    { pattern: /globalConfig\.tileSize/g, replacement: "32" },
    { pattern: /globalConfig\.halfTileSize/g, replacement: "16" },
    { pattern: /globalConfig\.beltSpeedItemsPerSecond/g, replacement: "2.0" },
    { pattern: /globalConfig\.debug/g, replacement: "''" },
];

/**
 * @param {string} source
 * @returns {string}
 */
module.exports = function (source) {
    let result = source;
    for (const { pattern, replacement } of REPLACEMENTS) {
        result = result.replace(pattern, replacement);
    }
    return result;
};
