/**
 * slp-format-check.js — refuse a `.slp` file newer than LUC3D can read.
 *
 * Python sleap-io 0.10 writes SLP format 3.0 by default, where every table is a
 * group of columns. LUC3D's two readers (the vendored sleap-io.js and the raw
 * `loading/slp-import-worker.js`) know the 2.x layout only: with no check they
 * read such a file as 0 frames with no error, under a success message. The rule
 * is Python's `_check_format_id`: refuse at or above the limit, and let a file
 * with no `format_id` through, as before.
 *
 * No imports, deliberately: the raw worker and Node tests load this. The vendored
 * reader cannot (`lib/` stays self-contained), so it carries its own copy of the
 * rule and the wording (`LUCID local patch (luc3d newer-format)`), and
 * `tests/e2e/slp-newer-format.mjs` fails if the two messages ever differ.
 */

/** A `/metadata` `format_id` at or above this uses a layout LUC3D can't read. */
export const SLP_FORMAT_ID_LIMIT = 3.0;

// The vendored reader's error class has this name too, so one test covers both.
const ERROR_NAME = 'UnsupportedSlpFormatError';

/**
 * What a refused file tells the user.
 *
 * @param {number} formatId The file's `format_id`.
 * @param {string} [fileName] Its name, if known.
 * @returns {string}
 */
export function newerSlpFormatMessage(formatId, fileName) {
    var version = Number.isInteger(formatId) ? formatId.toFixed(1) : String(formatId);
    return (fileName || 'This file') + ' uses SLP format ' + version
        + ', which is newer than this version of LUC3D supports (max '
        + (SLP_FORMAT_ID_LIMIT - 1) + '.x). Update LUC3D to read it, or re-save the file'
        + ' from Python sleap-io with `legacy_format=True`.';
}

/**
 * Throw if a file's `/metadata` attributes say it is too new to read. Call this
 * before reading anything else from the file: a newer layout may not hold what
 * the other reads look for, and most of them turn a miss into an empty result.
 *
 * @param {?Object} metadataAttrs The attributes of `/metadata`, as h5wasm gives
 *   them (`{value}` wrappers) or bare; nothing at all passes.
 * @param {string} [fileName] The file's name, for the message.
 * @throws {Error} Named `UnsupportedSlpFormatError`, with `formatId`.
 */
export function checkSlpFormatAttrs(metadataAttrs, fileName) {
    var attr = metadataAttrs ? metadataAttrs.format_id : null;
    if (attr === null || attr === undefined) return;
    var formatId = Number(attr.value !== undefined ? attr.value : attr);
    if (formatId >= SLP_FORMAT_ID_LIMIT) {
        var err = new Error(newerSlpFormatMessage(formatId, fileName));
        err.name = ERROR_NAME;
        err.formatId = formatId;
        throw err;
    }
}

/** Whether a failed read was the refusal above, from either reader. */
export function isNewerSlpFormatError(err) {
    return !!err && err.name === ERROR_NAME;
}

/**
 * Status-bar text for a failed `.slp` read. A refusal is left as it is: nothing
 * failed to parse, and the status line has no room to spare.
 *
 * @param {string} prefix What to call any other failure, e.g. `'SLP parse error'`.
 * @param {*} err What the read threw.
 * @returns {string}
 */
export function slpReadErrorStatus(prefix, err) {
    var message = (err && err.message) || String(err);
    return isNewerSlpFormatError(err) ? message : prefix + ': ' + message;
}
