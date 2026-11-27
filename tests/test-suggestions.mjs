/**
 * test-suggestions.mjs — the Suggestions panel's logic (`pose/suggestions.js`)
 * and its `.slp` mapping (`import-export/suggestions-io.js`), both import-free.
 *
 *  1. Stride / Random / Frame chunk match sleap-app's `sampleFrames` /
 *     `frameChunkFrames` (frames already suggested are skipped; a range is a
 *     sampling window, 1-based inclusive).
 *  2. Generate over several views gives each view its own frames.
 *  3. The list edits never mutate their input and dedupe by (camera, frame).
 *  4. Groups: the focused view first, then the session's order, then views
 *     the session no longer has; rows keep the list's order.
 *  5. Prev / Next: from the selected row, else the row on screen, else an end;
 *     wraps.
 *  6. suggestions-io: a session's suggestions map to its own videos by camera
 *     name (unknown cameras skipped), and back by video index (other sessions'
 *     videos skipped, duplicates dropped, group kept as a number).
 */
import {
    mulberry32, sampleFrames, frameChunkFrames, generateSuggestions, mergeSuggestions,
    shuffleSuggestions, removeUnlabeledSuggestions, removeSuggestion, suggestionExists,
    labeledSummary, groupSuggestionsByView, stepSuggestion, SUGGESTION_METHODS,
} from '../pose/suggestions.js';
import {
    sioSuggestionsForSession, suggestionEntriesFromLabels, readSuggestions,
} from '../import-export/suggestions-io.js';

let passed = 0, failed = 0;
const check = (cond, msg, extra) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const S = (camera, frameIdx) => ({ camera, frameIdx, group: 0 });

console.log('\n1. Sampling');
{
    check(eq(sampleFrames(1800, 10, 'stride', null, null), [0, 180, 360, 540, 720, 900, 1080, 1260, 1440, 1620]),
        'stride 10 of 1,800 frames');
    check(eq(sampleFrames(10, 20, 'stride', null, null), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
        'stride asks for more than there are: every frame');
    check(eq(sampleFrames(10, 3, 'stride', null, new Set([0, 3])), [1, 4, 6]),
        'stride skips frames already suggested (candidates 1,2,4..9, step 2)');
    check(eq(sampleFrames(1000, 4, 'stride', { from: 101, to: 200 }, null), [100, 125, 150, 175]),
        'a range is a 1-based inclusive sampling window');
    check(eq(sampleFrames(100, 5, 'stride', { from: 50, to: 10 }, null), []), 'an empty range samples nothing');
    check(eq(sampleFrames(100, 0, 'stride', null, null), []), 'Per video 0 samples nothing');
    check(eq(sampleFrames(0, 5, 'stride', null, null), []), 'a view with no frames samples nothing');
    const r1 = sampleFrames(500, 20, 'random', null, null, mulberry32(42));
    const r2 = sampleFrames(500, 20, 'random', null, null, mulberry32(42));
    check(eq(r1, r2), 'random is reproducible with a seeded rng');
    check(r1.length === 20 && new Set(r1).size === 20, 'random picks distinct frames', r1.length);
    check(r1.every((f, i) => i === 0 || f > r1[i - 1]) && r1.every(f => f >= 0 && f < 500), 'random frames are ascending and in range');
    check(eq(sampleFrames(5, 20, 'random', null, null, mulberry32(1)), [0, 1, 2, 3, 4]), 'random with too few frames: every frame');
    check(eq(frameChunkFrames(1800, 11, 15), [10, 11, 12, 13, 14]), 'frame chunk 11..15 → 0-based 10..14');
    check(eq(frameChunkFrames(12, 10, 99), [9, 10, 11]), 'frame chunk clipped to the view');
    check(eq(frameChunkFrames(12, 13, 20), []) && eq(frameChunkFrames(12, 5, 4), []), 'frame chunk past the end, or reversed: nothing');
    check(eq(SUGGESTION_METHODS.map(m => m.label), ['Stride', 'Random', 'Frame chunk']), 'three methods in sleap-app\'s order');
}

console.log('\n2. Generate over views');
{
    const views = [{ camera: 'top', nFrames: 100 }, { camera: 'side', nFrames: 50 }];
    const g = generateSuggestions(views, { method: 'stride', perVideo: 2 });
    check(eq(g, [S('top', 0), S('top', 50), S('side', 0), S('side', 25)]), 'each view sampled on its own frame count', g);
    const again = generateSuggestions(views, { method: 'stride', perVideo: 2 }, g);
    check(!again.some(s => suggestionExists(g, s.camera, s.frameIdx)), 'existing suggestions are not sampled again', again);
    const chunk = generateSuggestions(views, { method: 'frame_chunk', chunk: { from: 49, to: 51 } });
    check(eq(chunk, [S('top', 48), S('top', 49), S('top', 50), S('side', 48), S('side', 49)]), 'frame chunk per view', chunk);
    check(generateSuggestions([], { method: 'stride', perVideo: 5 }).length === 0, 'no views: nothing');
}

console.log('\n3. Edits');
{
    const a = [S('top', 1), S('side', 1)];
    const frozen = JSON.stringify(a);
    const m = mergeSuggestions(a, [S('top', 1), S('top', 2), S('top', 2)]);
    check(eq(m, [S('top', 1), S('side', 1), S('top', 2)]), 'merge appends only new pairs (and dedupes the incoming list)');
    check(eq(removeSuggestion(m, 'top', 1), [S('side', 1), S('top', 2)]), 'remove drops that one pair');
    check(eq(removeUnlabeledSuggestions(m, (c, f) => c === 'side'), [S('side', 1)]), 'remove unlabeled keeps the labeled');
    const sh = shuffleSuggestions(m, mulberry32(3));
    check(sh.length === m.length && m.every(s => suggestionExists(sh, s.camera, s.frameIdx)), 'shuffle keeps every entry');
    check(JSON.stringify(a) === frozen, 'no input was mutated');
    const sum = labeledSummary(m, (c, f) => f === 1);
    check(sum.labeled === 2 && sum.total === 3 && Math.abs(sum.pct - 200 / 3) < 1e-12, 'labeled summary (pct not rounded)', sum);
    check(eq(labeledSummary([], () => true), { labeled: 0, total: 0, pct: 0 }), 'empty summary is 0%');
}

console.log('\n4. Groups');
{
    const list = [S('a', 5), S('c', 1), S('a', 2), S('b', 9), S('gone', 3)];
    const g = groupSuggestionsByView(list, ['a', 'b', 'c'], 'c');
    check(eq(g.map(x => x.camera), ['c', 'a', 'b', 'gone']), 'focused view first, then the session\'s order, then unknown views');
    check(eq(g[1].rows.map(r => r.frameIdx), [5, 2]), 'rows keep the list\'s order');
    check(eq(groupSuggestionsByView(list, ['a', 'b', 'c'], 'zz').map(x => x.camera), ['a', 'b', 'c', 'gone']),
        'a focused view with no suggestions adds no group');
    check(groupSuggestionsByView([], ['a'], 'a').length === 0, 'no suggestions: no groups');
}

console.log('\n5. Prev / Next');
{
    const rows = [S('a', 1), S('a', 2), S('b', 1)];
    check(eq(stepSuggestion(rows, null, null, 1), rows[0]), 'Next with nothing selected: the first row');
    check(eq(stepSuggestion(rows, null, null, -1), rows[2]), 'Prev with nothing selected: the last row');
    check(eq(stepSuggestion(rows, rows[0], null, 1), rows[1]), 'Next from the selected row');
    check(eq(stepSuggestion(rows, rows[2], null, 1), rows[0]), 'Next wraps at the end');
    check(eq(stepSuggestion(rows, rows[0], null, -1), rows[2]), 'Prev wraps at the start');
    check(eq(stepSuggestion(rows, null, { camera: 'a', frameIdx: 2 }, 1), rows[2]), 'from the row on screen when none is selected');
    check(eq(stepSuggestion(rows, { camera: 'x', frameIdx: 0 }, { camera: 'b', frameIdx: 1 }, -1), rows[1]),
        'a stale selection falls back to the row on screen');
    check(stepSuggestion([], null, null, 1) === null, 'no rows: null');
}

console.log('\n6. suggestions-io');
{
    class SuggestionFrame { constructor(o) { this.video = o.video; this.frameIdx = o.frameIdx; this.group = o.group; this.metadata = o.metadata || {}; } }
    const SIO = { SuggestionFrame };
    const vTop = { id: 'vTop' }, vSide = { id: 'vSide' }, vOther = { id: 'vOther' };
    const camTop = { name: 'top' }, camSide = { name: 'side' };
    const sioSession = { cameras: [camTop, camSide], getVideo: (c) => (c === camTop ? vTop : c === camSide ? vSide : null) };
    const session = { suggestions: [S('side', 7), S('top', 3), S('nope', 1)] };
    const out = sioSuggestionsForSession(SIO, session, sioSession);
    check(out.length === 2 && out[0].video === vSide && out[0].frameIdx === 7 && out[1].video === vTop && out[1].group === 0,
        'each suggestion on its own camera\'s video; a camera with no video is skipped');
    check(sioSuggestionsForSession(SIO, { suggestions: [] }, sioSession).length === 0, 'no suggestions: nothing written');
    check(sioSuggestionsForSession(SIO, {}, sioSession).length === 0, 'a session without the field: nothing written');
    const plain = sioSuggestionsForSession({}, session, sioSession);
    check(plain.length === 2 && plain[0].video === vSide && plain[0].frameIdx === 7 && plain[0].group === 0,
        'without the SuggestionFrame class: plain entries, never none');

    const labels = {
        videos: [vOther, vTop, vSide],
        suggestions: [
            { video: vSide, frameIdx: 7, metadata: { group: 2 } },
            { video: vTop, frameIdx: 3, group: 'default', metadata: {} },
            { video: vOther, frameIdx: 9, metadata: { group: 0 } },
            { video: vTop, frameIdx: 3, metadata: { group: 0 } },
            { video: { id: 'unknown' }, frameIdx: 1 },
        ],
    };
    const entries = suggestionEntriesFromLabels(labels);
    check(eq(entries, [
        { videoIdx: 2, frameIdx: 7, group: 2 }, { videoIdx: 1, frameIdx: 3, group: 0 },
        { videoIdx: 0, frameIdx: 9, group: 0 }, { videoIdx: 1, frameIdx: 3, group: 0 },
    ]), 'entries by video index; a video not in the file is dropped; a non-numeric group reads 0', entries);
    const target = { suggestions: [S('old', 1)] };
    const n = readSuggestions(target, entries, (vi) => ({ 1: 'top', 2: 'side' })[vi] || null);
    check(n === 2 && eq(target.suggestions, [{ camera: 'side', frameIdx: 7, group: 2 }, S('top', 3)]),
        'read: only this session\'s videos, duplicates dropped, replaces the old list', target.suggestions);
    check(readSuggestions(target, undefined, () => 'x') === 0 && eq(target.suggestions, []), 'no entries: an empty list');
    check(eq(suggestionEntriesFromLabels({ videos: [] }), []), 'a file without suggestions: no entries');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
