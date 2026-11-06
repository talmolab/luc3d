/**
 * test-calibration-file-pick.mjs — which `*calib*` file a session folder loads.
 *
 * Both folder loaders used to assign `calibFile = file` as they scanned, so
 * with two matches the winner was whichever the directory enumeration yielded
 * LAST — an order neither the File System Access API nor `webkitdirectory`
 * promises. That was harmless only while a folder could hold one match, which
 * stopped being true when `Set as New Calibration` began writing a NEW file
 * (`calibration-rebased.toml`) instead of overwriting `calibration.toml`.
 *
 * Getting this wrong is the quiet failure the whole re-base flow warns about:
 * the stale calibration parses, every camera loads, every number looks
 * plausible, and every reprojection is wrong.
 *
 * `pickCalibrationFile` is pure and takes plain `{name}` objects, and it lives
 * in `loading/calibration-pick.js` — a module with NO imports — precisely so
 * this test can exist: `session-loader.js` reaches Three.js through a CDN
 * specifier and cannot be loaded by Node at all. ESM, so
 * `tests/run-mjs-tests.mjs` picks it up.
 */
import { pickCalibrationFile, REBASED_CALIBRATION_NAME } from '../loading/calibration-pick.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};

const f = (name) => ({ name });
const names = (arr) => arr.map((x) => x.name);

console.log('\n1. The re-based file wins whenever it is present');
{
    // The case that matters: a folder holding both. The re-base is the newer
    // statement about where the world is, and the project's 3D has already
    // moved to match it.
    const both = [f('calibration.toml'), f('calibration-rebased.toml')];
    const r = pickCalibrationFile(both);
    check(r.file.name === 'calibration-rebased.toml',
        `picked the re-based one (got '${r.file.name}')`);
    // `ambiguous` is NAMES, not files — it exists so the loader can say which
    // file it ignored without holding on to a File it will not read.
    check(r.ambiguous.length === 1 && r.ambiguous[0] === 'calibration.toml',
        `and reports the one it ignored, so the loader can warn (got ${JSON.stringify(r.ambiguous)})`);
    check(REBASED_CALIBRATION_NAME === 'calibration-rebased.toml',
        'the preferred name is the one both origin actions write');

    // ...and it must not depend on enumeration order, which is the actual bug.
    const reversed = pickCalibrationFile(both.slice().reverse());
    check(reversed.file.name === r.file.name,
        'the answer does not depend on the order the folder was scanned in');
}

console.log('\n2. One file, no ambiguity');
{
    const r = pickCalibrationFile([f('calibration.toml')]);
    check(r.file.name === 'calibration.toml', 'a lone calibration.toml is used');
    check(r.ambiguous.length === 0, 'and nothing is reported as ignored');

    const r2 = pickCalibrationFile([f('calibration-rebased.toml')]);
    check(r2.file.name === 'calibration-rebased.toml',
        'a lone calibration-rebased.toml is used too — it is not treated as a special case');
    check(r2.ambiguous.length === 0, 'with nothing ignored');
}

console.log('\n3. Neither name present: deterministic, not arbitrary');
{
    // A rig directory can hold anything matching `*calib*`. Without the
    // re-based name to key on, the choice still has to be the same on every
    // load of the same folder, or a project silently changes frame between
    // sessions.
    const odd = [f('cage5_calib_2024.toml'), f('calib_backup.json'), f('aa_calib.toml')];
    const r = pickCalibrationFile(odd);
    check(r.file.name === 'aa_calib.toml',
        `falls back to the lexicographically first (got '${r.file.name}')`);
    check(r.ambiguous.length === 2, `reporting the other 2 (got ${r.ambiguous.length})`);
    const shuffled = pickCalibrationFile([odd[2], odd[0], odd[1]]);
    check(shuffled.file.name === r.file.name, 'and the same answer whatever the scan order');
}

console.log('\n4. Case and emptiness');
{
    // A folder written on a case-insensitive filesystem can hand back
    // `Calibration-Rebased.toml`; the preference must still fire.
    const r = pickCalibrationFile([f('calibration.toml'), f('Calibration-Rebased.TOML')]);
    check(r.file.name === 'Calibration-Rebased.TOML',
        `the preference is case-insensitive (got '${r.file.name}')`);

    const empty = pickCalibrationFile([]);
    check(empty.file === null && empty.ambiguous.length === 0,
        'no matches gives a null pick rather than throwing');
    const nul = pickCalibrationFile(null);
    check(nul.file === null, 'and so does null');
}

console.log('\n5. The input array is not mutated');
{
    // The loaders keep scanning after calling this; re-ordering their list
    // under them would be a nasty thing to debug.
    const arr = [f('calibration.toml'), f('calibration-rebased.toml')];
    const before = names(arr).join(',');
    pickCalibrationFile(arr);
    check(names(arr).join(',') === before,
        'the caller\'s array comes back in the order it was handed over');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
