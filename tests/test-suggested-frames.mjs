// tests/test-suggested-frames.mjs — pose/suggested-frames.js: a session's suggested
// frames in the file's order, and where Previous / Next suggested frame lands.
// Run: node tests/test-suggested-frames.mjs

import { suggestedFrameOrder, stepSuggestedFrame } from '../pose/suggested-frames.js';

let failures = 0;
function check(ok, msg, got) {
    console.log((ok ? '  ✓ ' : '  ✗ ') + msg + (!ok && got !== undefined ? ' — got ' + JSON.stringify(got) : ''));
    if (!ok) failures++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('suggestedFrameOrder');
{
    const rows = [
        { camera: 'cam1', frameIdx: 300 }, { camera: 'cam2', frameIdx: 300 },   // rank 1, two cameras
        { camera: 'cam2', frameIdx: 12 }, { camera: 'cam1', frameIdx: 12 },     // rank 2
        { camera: null, frameIdx: 7 },                                         // a video no camera reads
        { camera: 'other', frameIdx: 8 },                                      // another session's camera
        { camera: 'cam1', frameIdx: 90 },
        { camera: 'cam2', frameIdx: 12 },                                      // listed again later
        { camera: 'cam2', frameIdx: 0 },
    ];
    check(eq(suggestedFrameOrder(rows, ['cam1', 'cam2']), [300, 12, 90, 0]),
        "the file's order, each frame once, only the session's cameras", suggestedFrameOrder(rows, ['cam1', 'cam2']));
    check(eq(suggestedFrameOrder(rows, new Set(['cam2'])), [300, 12, 0]), 'one camera: only its frames (any iterable of names)');
    check(eq(suggestedFrameOrder(rows, []), []), 'no cameras: none');
    check(eq(suggestedFrameOrder([], ['cam1']), []), 'no suggestions: none');
    const odd = [{ camera: 'cam1', frameIdx: -1 }, { camera: 'cam1', frameIdx: 2.5 }, { camera: 'cam1', frameIdx: NaN },
        { camera: 'cam1', frameIdx: null }, { camera: 'cam1', frameIdx: 4 }];
    check(eq(suggestedFrameOrder(odd, ['cam1']), [4]), 'a frame that is not a 0-based integer is skipped');
}

console.log('stepSuggestedFrame');
{
    const frames = [300, 12, 90, 0];
    check(stepSuggestedFrame([], 5, 1) === null && stepSuggestedFrame(null, 5, 1) === null, 'no suggested frames: null');

    // Nothing stepped to yet, off a suggestion: both go to the first.
    check(eq(stepSuggestedFrame(frames, 50, 1), { index: 0, frame: 300 }), 'Next from nowhere → the first');
    check(eq(stepSuggestedFrame(frames, 50, -1), { index: 0, frame: 300 }), 'Previous from nowhere → the first');

    // On a suggestion: its neighbours in the file's order, not frame order.
    check(eq(stepSuggestedFrame(frames, 300, 1), { index: 1, frame: 12 }), 'on rank 1, Next → rank 2 (an earlier frame)');
    check(eq(stepSuggestedFrame(frames, 90, -1), { index: 1, frame: 12 }), 'on rank 3, Previous → rank 2');
    check(eq(stepSuggestedFrame(frames, 12, 1, 0), { index: 2, frame: 90 }), 'on a suggestion, the one last stepped to does not matter');

    // The ends.
    check(eq(stepSuggestedFrame(frames, 0, 1), { index: 3, frame: null }), 'Next on the last: no frame, the last index');
    check(eq(stepSuggestedFrame(frames, 300, -1), { index: 0, frame: null }), 'Previous on the first: no frame, index 0');

    // Off a suggestion, after stepping to one: as if just past it.
    check(eq(stepSuggestedFrame(frames, 13, 1, 12), { index: 2, frame: 90 }), 'off rank 2 (last stepped), Next → rank 3');
    check(eq(stepSuggestedFrame(frames, 13, -1, 12), { index: 1, frame: 12 }), 'off rank 2 (last stepped), Previous → back to rank 2');
    check(eq(stepSuggestedFrame(frames, 1, 1, 0), { index: 3, frame: null }), 'off the last (last stepped), Next: the end');
    check(eq(stepSuggestedFrame(frames, 1, -1, 300), { index: 0, frame: 300 }), 'off rank 1 (last stepped), Previous → rank 1');
    check(eq(stepSuggestedFrame(frames, 50, 1, 77), { index: 0, frame: 300 }), 'a last frame no longer suggested counts as none');
    check(eq(stepSuggestedFrame(frames, 50, 2), { index: 0, frame: 300 }) && eq(stepSuggestedFrame(frames, 300, 5), { index: 1, frame: 12 }),
        'any positive direction is one step forward');
}

console.log(failures === 0 ? '\nPASS test-suggested-frames' : `\nFAIL test-suggested-frames: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
