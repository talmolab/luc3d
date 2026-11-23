// loading/calibration-pick.js — which calibration file a session folder loads,
// and what the re-based one is called.
//
// Two tiny things that several modules need and that must not disagree, in a
// file with NO imports: `loading/session-loader.js` reaches Three.js through a
// CDN specifier and `import-export/file-io.js` pulls in the browser world, so
// neither can be loaded by a Node test. This one can, which is the whole point
// — the selection rule below is exactly the kind of thing that wants a unit
// test and exactly the kind of thing that never gets one if testing it needs a
// headless browser.
//
// It also sidesteps a cycle: `ui/origin-rebase.js` and `ui/origin-definition.js`
// are circular by design, so a `const` exported from either and imported by the
// other is in TDZ for whichever side initializes second.

/**
 * The file name BOTH origin actions write.
 *
 * `Export New Calibration` and `Set as New Calibration` produce byte-identical
 * TOML for a given origin — same cameras, same `rebaseExtrinsics`, same writer.
 * The only difference is whether the project moved to match, which is a
 * property of the PROJECT and not of the file, so giving the two outputs
 * different names implied a distinction the bytes do not carry.
 *
 * Deliberately NOT `calibration.toml`: the calibration a project was annotated
 * against is usually shared with tools outside LUCID, and silently rewriting it
 * is not either action's business.
 */
export const REBASED_CALIBRATION_NAME = 'calibration-rebased.toml';

/**
 * Choose ONE calibration file out of everything in a folder matching
 * `*calib*.toml` / `*calib*.json`.
 *
 * Both folder loaders used to do `calibFile = file` as they scanned, so with
 * two matches the winner was whichever the enumeration happened to yield LAST
 * — an order neither the File System Access API nor `webkitdirectory` promises.
 * That was harmless only as long as a folder could hold one match, which
 * stopped being true when `Set as New Calibration` began writing a NEW file
 * instead of overwriting `calibration.toml`. A project can now sit beside both,
 * and picking the wrong one is the quiet failure the whole re-base flow warns
 * about: the stale file parses, every camera loads, every number looks
 * plausible, and every reprojection is wrong.
 *
 * The rule, in order:
 *  1. `REBASED_CALIBRATION_NAME` (case-insensitive — a folder handed back by a
 *     case-insensitive filesystem can spell it differently). It was written by
 *     an origin re-base, so it is the newer statement about where the world is,
 *     and it is the one matching a project whose 3D has already moved.
 *  2. Otherwise the lexicographically first match, so that the choice is at
 *     least DETERMINISTIC across loads of the same folder. An arbitrary pick
 *     that changes between sessions would move a project's frame with nothing
 *     said about it.
 *
 * A campy cage (`*.cage.json`, campy's `campy-cage`: the box's floor and walls,
 * saved beside the calibration it was made with) matches `*calib*.json` too,
 * and sorts before `calibration.toml`: it is never a calibration. The cage of
 * the picked file (`<its name without extension>.cage.json`) comes back as
 * `cage`; a cage made with another calibration (the original beside a
 * re-based one) is in another frame, and none comes back.
 *
 * Does not mutate its argument: the loaders keep scanning afterwards, and
 * re-ordering their list under them would be a nasty thing to debug.
 *
 * @param {Array<{name: string}>} matches - every candidate found at the folder root
 * @returns {{file: Object|null, ambiguous: string[], cage: Object|null}} the
 *   pick, plus the names of the also-present candidates when there was more
 *   than one, so the caller can say which file it used and which it ignored,
 *   and the pick's campy cage when the folder has it.
 */
export function pickCalibrationFile(matches) {
    if (!matches || !matches.length) return { file: null, ambiguous: [], cage: null };
    var isCage = function (f) { return /\.cage\.json$/i.test(String(f && f.name || '')); };
    var cages = matches.filter(isCage);
    matches = matches.filter(function (f) { return !isCage(f); });
    if (!matches.length) return { file: null, ambiguous: [], cage: null };
    var sorted = matches.slice().sort(function (a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    var pick = null;
    for (var i = 0; i < sorted.length; i++) {
        if (sorted[i].name.toLowerCase() === REBASED_CALIBRATION_NAME) {
            pick = sorted[i];
            break;
        }
    }
    if (!pick) pick = sorted[0];
    var others = [];
    for (var j = 0; j < sorted.length; j++) {
        if (sorted[j] !== pick) others.push(sorted[j].name);
    }
    var stem = pick.name.replace(/\.[^.]*$/, '').toLowerCase();
    var cage = null;
    for (var k = 0; k < cages.length; k++) if (cages[k].name.toLowerCase() === stem + '.cage.json') { cage = cages[k]; break; }
    return { file: pick, ambiguous: others, cage: cage };
}
