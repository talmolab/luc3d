/**
 * test-proofread-export-name.mjs — what File ▸ Export SLEAP File By Cam names a
 * camera's file when it writes it next to the camera's source `.slp`
 * (`loading/percam-slp-choice.js`: `proofreadSlpName`, `chooseProofreadSource`).
 *
 * The proofread file goes next to the 2D file the project was built from, as
 * `<source stem>_proofread.slp`. Its own earlier outputs must never be taken
 * for the source (or a second export would write `…_proofread_proofread.slp`),
 * and with several candidates the loader's own rule decides, so an unchanged
 * folder names the file the project was loaded from. Pure, import-free module,
 * so Node runs it (`tests/run-mjs-tests.mjs`).
 */
import {
    proofreadSlpName, chooseProofreadSource, isProofreadSlp, PROOFREAD_SUFFIX,
} from '../loading/percam-slp-choice.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const f = (name, lastModified) => ({ name, lastModified });

console.log('proofreadSlpName');
check(proofreadSlpName('21241563-20260921105806_nn.slp') === '21241563-20260921105806_nn_proofread.slp',
    'the user\'s example: …_nn.slp → …_nn_proofread.slp');
check(proofreadSlpName('[20260713_174659]_OKS_0.25.slp') === '[20260713_174659]_OKS_0.25_proofread.slp',
    'dots and brackets in the stem are kept; only the extension goes');
check(proofreadSlpName('0.mp4') === '0_proofread.slp', 'a video name (camera folder without a .slp) gives <video stem>_proofread.slp');
check(PROOFREAD_SUFFIX === '_proofread', 'suffix is "_proofread"');

console.log('isProofreadSlp');
check(isProofreadSlp('a_nn_proofread.slp') && isProofreadSlp('A_PROOFREAD.SLP'), 'our outputs are recognised, any case');
check(!isProofreadSlp('a_nn.slp') && !isProofreadSlp('proofread_notes.slp'), 'other names are not');

console.log('chooseProofreadSource');
const nn = f('21241563-20260921105806_nn.slp', 100);
const pr = f('21241563-20260921105806_nn_proofread.slp', 999);
check(chooseProofreadSource([nn, pr]) === nn, 'an earlier _proofread output is never the source, even when newer');
check(chooseProofreadSource([pr]) === null, 'only our own output → no source');
check(chooseProofreadSource([]) === null && chooseProofreadSource(null) === null, 'no .slp → no source');
const v1 = f('cam_v1.slp', 50), v0 = f('cam.slp', 80);
check(chooseProofreadSource([v0, v1]) === v1, 'without a recorded name, the loader\'s rule (highest _vN)');
check(chooseProofreadSource([v0, v1], 'cam.slp') === v0, 'the file the folder load recorded wins while it is there');
check(chooseProofreadSource([v0, v1], 'gone.slp') === v1, 'a recorded name no longer in the folder falls back to the rule');
check(chooseProofreadSource([nn, pr], pr.name) === nn, 'a recorded name that is a _proofread output is ignored');

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
