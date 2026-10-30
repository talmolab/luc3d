/**
 * test-data-file-plan.mjs — which data file a camera folder loads, when the
 * loader must ask instead (#413 / #414), and how the answer is remembered.
 *
 * A camera folder can hold SLEAP predictions, a proofread copy, analysis `.h5`
 * exports, reprojections and LUC3D's own exports. Guessing among them loaded
 * `*.reprojections.slp` into every view of a real SLAP-2M session (#413), and a
 * mix of `.slp` and `.h5` sank the whole load (#414). `planCameraDataFile`
 * (`loading/percam-slp-choice.js`) now loads a file on its own only when there
 * is nothing to decide:
 *   - one data file (an `.h5` exported FROM an `.slp` beside it does not count);
 *   - only `.slp` files, and the newest LUC3D export is the newest file.
 * Everything else goes to the chooser with a default. What the user picks there
 * is kept per session folder and camera directory in this browser
 * (`loading/data-file-choices.js`), and a saved file that disappeared brings the
 * chooser back.
 *
 * Both modules import nothing, so Node loads them directly. ESM, so
 * `tests/run-mjs-tests.mjs` picks it up.
 */
import {
    planCameraDataFile, derivedFromSlp, dataFileKind, DATA_FILE_KIND_RANK,
} from '../loading/percam-slp-choice.js';
import {
    DATA_FILE_CHOICES_KEY, savedDataFileChoices, saveDataFileChoices, applySavedChoice,
} from '../loading/data-file-choices.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};

const OLD = 1000, MID = 2000, NEW = 3000;
const f = (name, lastModified) => ({ name, lastModified: lastModified === undefined ? OLD : lastModified });
const JUN = Date.parse('2026-06-26T09:15:32.783Z');
const OCT = Date.parse('2026-10-28T18:14:19.067Z');
const stamps = (byName) => ({ exportedAt: (file) => (file.name in byName ? byName[file.name] : NaN) });
const names = (plan) => plan.options.map((o) => o.file.name);

console.log('\n1. Nothing to decide: load without asking');
{
    const none = planCameraDataFile([]);
    check(none.auto === null && !none.needsChoice && none.reason === 'none', 'an empty folder loads nothing and asks nothing');

    const one = planCameraDataFile([f('cam1.predictions.slp')]);
    check(one.auto && one.auto.name === 'cam1.predictions.slp' && !one.needsChoice && one.reason === 'single',
        'a lone .slp loads');

    const h5 = planCameraDataFile([f('cam1.analysis.h5')]);
    check(h5.auto && h5.auto.name === 'cam1.analysis.h5' && h5.reason === 'single', 'a lone .h5 loads');

    const pair = planCameraDataFile([f('cam1.predictions.slp'), f('cam1.predictions.slp.analysis.h5', NEW)]);
    check(pair.auto && pair.auto.name === 'cam1.predictions.slp' && !pair.needsChoice,
        'an .h5 SLEAP exported from the .slp beside it is not a competitor (the same poses again)');
    check(names(pair).join() === 'cam1.predictions.slp,cam1.predictions.slp.analysis.h5',
        'but it is still listed, after the file it came from');

    const exp = planCameraDataFile([f('cam1_v1.slp', OLD), f('cam1.slp', NEW)],
        stamps({ 'cam1_v1.slp': JUN, 'cam1.slp': OCT }));
    check(exp.auto && exp.auto.name === 'cam1.slp' && exp.reason === 'newest-export',
        'only LUC3D exports: the newest by export time (#214)');

    const copied = planCameraDataFile([f('cam1_v1.slp', MID), f('cam1.slp', MID)],
        stamps({ 'cam1_v1.slp': JUN, 'cam1.slp': OCT }));
    check(copied.auto && copied.auto.name === 'cam1.slp' && !copied.needsChoice,
        'a folder copied in one go (equal mtimes) does not ask: the stamp decides');

    const older = planCameraDataFile([f('cam1.predictions.slp', OLD), f('cam1.slp', NEW)],
        stamps({ 'cam1.slp': OCT }));
    check(older.auto && older.auto.name === 'cam1.slp' && older.reason === 'newest-export',
        'a SLEAP file OLDER than the export (the predictions it was proofread from) does not ask');

    const corrupt = planCameraDataFile([f('cam1.slp', OLD), f('cam1_v2.slp', OLD)], stamps({ 'cam1.slp': OCT }));
    check(corrupt.auto && corrupt.auto.name === 'cam1.slp',
        'an unreadable file (no stamp) the same age as the export does not ask, and does not win');
}

console.log('\n2. The user decides');
{
    const newer = planCameraDataFile([f('cam5_v1.slp', OLD), f('cam5.predictions.slp', NEW)],
        stamps({ 'cam5_v1.slp': JUN }));
    check(newer.needsChoice && newer.auto === null && newer.reason === 'newer-than-export',
        'a SLEAP .slp written AFTER the newest export asks');
    check(newer.defaultFile && newer.defaultFile.name === 'cam5_v1.slp',
        'with the export pre-selected (it holds the corrections)');

    // The SLAP-2M folder of #413: no LUC3D file, four SLEAP files.
    // Disk order disagrees with export order: a sync touched the older export,
    // or SLEAP re-saved (proofread) a file from an older export — re-saves keep
    // the provenance, stamp and all. Only the user knows which.
    const resaved = planCameraDataFile([f('cam1.slp', MID), f('cam1.proofread.slp', NEW)],
        stamps({ 'cam1.slp': OCT, 'cam1.proofread.slp': JUN }));
    check(resaved.needsChoice && resaved.reason === 'newer-than-export',
        'a stamped file NEWER on disk than the newest export asks (a SLEAP re-save keeps the old stamp)');
    check(resaved.defaultFile && resaved.defaultFile.name === 'cam1.slp', 'with the newest export pre-selected');
    const inverted = planCameraDataFile([f('cam1_v1.slp', NEW), f('cam1.slp', OLD)],
        stamps({ 'cam1_v1.slp': JUN, 'cam1.slp': OCT }));
    check(inverted.needsChoice && inverted.defaultFile.name === 'cam1.slp',
        'so does a sync that touched the older export — the later export is the default');

    const slap = planCameraDataFile([
        f('back.predictions.slp', OLD),
        f('back.predictions.proofread.slp', MID),
        f('back.reprojections.slp', NEW),
        f('back.predictions.proofread.slp.analysis.h5', NEW),
    ]);
    check(slap.needsChoice && slap.reason === 'several-slp',
        'several SLEAP .slp files ask, whatever is newest on disk (#413); the derived .h5 changes nothing');
    check(slap.defaultFile.name === 'back.predictions.proofread.slp',
        `the default is the proofread file, never the reprojections (got ${slap.defaultFile.name})`);
    check(names(slap).join() === 'back.predictions.proofread.slp,back.predictions.slp,back.reprojections.slp,back.predictions.proofread.slp.analysis.h5',
        `options rank proofread, predictions, reprojections, copies (got ${names(slap).join()})`);

    const slpOnly = planCameraDataFile([f('a.predictions.slp', NEW), f('a.reprojections.slp', NEW)]);
    check(slpOnly.needsChoice && slpOnly.reason === 'several-slp', 'several unstamped .slp files ask');
    check(slpOnly.defaultFile.name === 'a.predictions.slp', 'predictions before reprojections');

    const mixed = planCameraDataFile([f('cam1.analysis.h5', NEW), f('cam1.slp', OLD)], stamps({ 'cam1.slp': OCT }));
    check(mixed.needsChoice && mixed.reason === 'several-files', 'a LUC3D export beside an unrelated .h5 asks (#414)');
    check(mixed.defaultFile.name === 'cam1.slp', 'with the export first');

    const versions = planCameraDataFile([f('a.slp', NEW), f('a_v2.slp', OLD), f('a_v1.slp', MID)]);
    check(names(versions).join() === 'a_v2.slp,a_v1.slp,a.slp', 'among plain .slp files: higher version first');

    const exports = planCameraDataFile([f('x.slp', OLD), f('y.slp', OLD), f('z.h5', OLD)], stamps({ 'x.slp': JUN, 'y.slp': OCT }));
    check(names(exports).slice(0, 2).join() === 'y.slp,x.slp', 'among LUC3D exports: the later export first');
    check(exports.options[0].kind === 'lucid-export' && exports.options[0].exportedAt === OCT,
        'and the option carries its kind and export time for the label');
}

console.log('\n3. Kinds and SLEAP\'s derived names');
{
    check(derivedFromSlp('a.slp.analysis.h5', ['a.slp']) === 'a.slp', 'X.slp.analysis.h5 comes from X.slp');
    check(derivedFromSlp('a.slp.h5', ['a.slp']) === 'a.slp', 'X.slp.h5 too');
    check(derivedFromSlp('A.SLP.analysis.h5', ['a.slp']) === 'a.slp', 'case does not matter');
    check(derivedFromSlp('a.slp.analysis.h5', ['b.slp']) === null, 'only when that .slp is in the folder');
    check(derivedFromSlp('a.slpx.h5', ['a.slp']) === null, 'the .slp name must end at a dot');
    check(derivedFromSlp('a.slp', ['a.slp']) === null, 'an .slp is never derived');

    check(dataFileKind('cam.slp', true, null) === 'lucid-export', 'a stamped file is a LUC3D export');
    check(dataFileKind('cam.reprojections.slp', false, null) === 'reprojections', 'reprojections');
    check(dataFileKind('cam.predictions.proofread.slp', false, null) === 'proofread', 'proofread beats predictions');
    check(dataFileKind('cam.predictions.slp', false, null) === 'predictions', 'predictions');
    check(dataFileKind('cam.h5', false, null) === 'analysis-h5', 'an .h5');
    check(dataFileKind('cam.slp.h5', false, 'cam.slp') === 'derived', 'a copy of an .slp');
    check(DATA_FILE_KIND_RANK.reprojections > DATA_FILE_KIND_RANK['analysis-h5'],
        'reprojections are never the default over real poses');
}

console.log('\n4. Saved choices');
{
    const mem = () => {
        const m = new Map();
        return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
    };
    const st = mem();
    check(savedDataFileChoices('sess', st) === null, 'nothing saved yet');
    check(saveDataFileChoices('sess', { back: 'back.predictions.proofread.slp', side: null }, st), 'saved');
    check(JSON.stringify(savedDataFileChoices('sess', st)) === '{"back":"back.predictions.proofread.slp","side":null}',
        'read back, "None" kept as null');
    saveDataFileChoices('sess', { top: 'top.slp' }, st);
    saveDataFileChoices('other', { back: 'x.slp' }, st);
    check(JSON.stringify(savedDataFileChoices('sess', st)) === '{"back":"back.predictions.proofread.slp","side":null,"top":"top.slp"}',
        'a later save merges into the folder\'s entry');
    check(JSON.parse(st.getItem(DATA_FILE_CHOICES_KEY)).other.back === 'x.slp', 'folders are kept apart');

    const saved = savedDataFileChoices('sess', st);
    const files = [f('back.predictions.slp'), f('back.predictions.proofread.slp'), f('back.new.slp', NEW)];
    const use = applySavedChoice(saved, 'back', files);
    check(use.state === 'use' && use.file === files[1], 'a saved file still there is used — a file added since is ignored');
    check(JSON.stringify(applySavedChoice(saved, 'side', files)) === '{"state":"use","file":null}', 'a saved "None" loads nothing');
    check(JSON.stringify(applySavedChoice(saved, 'top', files)) === '{"state":"missing","name":"top.slp"}',
        'a saved file that is gone is reported missing, by name');
    check(applySavedChoice(saved, 'front', files).state === 'none', 'a camera with nothing saved');
    check(applySavedChoice(null, 'back', files).state === 'none', 'no saved entry at all');

    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    check(savedDataFileChoices('sess', broken) === null, 'unreadable storage reads as nothing saved');
    check(saveDataFileChoices('sess', { a: 'a.slp' }, broken) === false, 'and a failed write reports false, never throws');
    const junk = mem();
    junk.setItem(DATA_FILE_CHOICES_KEY, '{not json');
    check(savedDataFileChoices('sess', junk) === null, 'corrupt storage reads as nothing saved');
    junk.setItem(DATA_FILE_CHOICES_KEY, JSON.stringify({ sess: { a: 5, b: 'b.slp' } }));
    check(JSON.stringify(savedDataFileChoices('sess', junk)) === '{"b":"b.slp"}', 'values that are not names are dropped');
    check(savedDataFileChoices('', st) === null && saveDataFileChoices('', { a: 'a' }, st) === false,
        'no folder name, nothing read or written');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
