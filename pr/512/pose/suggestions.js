/**
 * pose/suggestions.js — the DOM-free half of the Suggestions panel
 * (`ui/suggestions-panel.js`): generating, editing and ordering a session's
 * suggested frames.
 *
 * A suggestion is one (camera view, frame) pair, `{camera, frameIdx, group}`,
 * the shape of `Session.suggestions`. SLEAP stores the same thing per VIDEO
 * (`suggestions_json`, one `SuggestionFrame` per video + frame); in LUCID each
 * camera view of a session is one video, so a camera name stands for it here
 * and `import-export/suggestions-io.js` maps it to the `.slp`'s video.
 *
 * Ported from sleap-app (`src/lib/suggestionStrategies.ts` `sampleFrames` /
 * `frameChunkFrames`, `src/lib/suggestionEdits.ts`, `src/lib/seededRng.ts`),
 * which port SLEAP's `sleap/gui/suggestions.py`. Methods: Stride, Random and
 * Frame chunk. Every list function returns a NEW array and never mutates its
 * input.
 *
 * The panel lists suggestions grouped by view, the focused view first
 * (`groupSuggestionsByView`); Prev / Next walk that order (`stepSuggestion`).
 *
 * Imports nothing.
 */

/** The generation methods, in the dropdown's order (`value` → label). */
export const SUGGESTION_METHODS = [
    { value: 'stride', label: 'Stride' },
    { value: 'random', label: 'Random' },
    { value: 'frame_chunk', label: 'Frame chunk' },
];

/** sleap-app's default "Per video". */
export const DEFAULT_PER_VIDEO = 20;

/**
 * Tiny deterministic PRNG (mulberry32), floats in [0, 1) like `Math.random`.
 * @param {number} seed
 * @returns {function(): number}
 */
export function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** The key that makes a suggestion unique: one per (camera, frame). */
export function suggestionKey(camera, frameIdx) {
    return camera + '\u0000' + frameIdx;
}

/**
 * Stride / Random sampling of one view (sleap-app `sampleFrames`). Frames
 * already suggested for this view are not candidates. With a range, only
 * frames in it are (1-based, inclusive, like the From / To fields).
 *
 * @param {number} nFrames - the view's frame count
 * @param {number} perVideo
 * @param {'stride'|'random'} sampling
 * @param {{from: number, to: number}|null} range - 1-based inclusive
 * @param {Set<number>|null} existing - frames already suggested in this view
 * @param {function(): number} [rng]
 * @returns {number[]} 0-based frames, ascending
 */
export function sampleFrames(nFrames, perVideo, sampling, range, existing, rng) {
    if (!(nFrames > 0) || !(perVideo > 0)) return [];
    var lo = 0, hi = nFrames - 1;
    if (range) {
        lo = Math.max(0, range.from - 1);
        hi = Math.min(nFrames - 1, range.to - 1);
    }
    if (!(lo <= hi)) return [];
    var candidates = [];
    for (var f = lo; f <= hi; f++) {
        if (!existing || !existing.has(f)) candidates.push(f);
    }
    var n = candidates.length;
    if (n === 0) return [];
    if (sampling === 'stride') {
        var inc = Math.max(1, Math.floor(n / perVideo));
        var out = [];
        for (var i = 0; i * inc < n && out.length < perVideo; i++) out.push(candidates[i * inc]);
        return out;
    }
    if (n <= perVideo) return candidates;
    var r = rng || Math.random;
    var pool = candidates.slice();
    var picked = [];
    for (var k = 0; k < perVideo; k++) {
        var j = Math.min(k + Math.floor(r() * (pool.length - k)), pool.length - 1);
        var tmp = pool[k]; pool[k] = pool[j]; pool[j] = tmp;
        picked.push(pool[k]);
    }
    picked.sort(function (a, b) { return a - b; });
    return picked;
}

/**
 * Frame chunk (sleap-app `frameChunkFrames`): every frame from `from` to `to`
 * (1-based, inclusive), clipped to the view.
 * @returns {number[]} 0-based frames, ascending
 */
export function frameChunkFrames(nFrames, from, to) {
    if (!(from <= to) || !(from <= nFrames)) return [];
    var out = [];
    var end = Math.min(to, nFrames);
    for (var f = Math.max(1, from) - 1; f < end; f++) out.push(f);
    return out;
}

/**
 * Generate suggestions for `views` (the Target: every view of the session, or
 * the focused one).
 *
 * @param {Array<{camera: string, nFrames: number}>} views
 * @param {{method: string, perVideo?: number, range?: {from:number,to:number}|null,
 *   chunk?: {from:number,to:number}, rng?: function(): number}} params
 * @param {Array<{camera: string, frameIdx: number}>} [existing] - for Stride /
 *   Random, frames already suggested in a view are skipped (as in sleap-app)
 * @returns {Array<{camera: string, frameIdx: number, group: number}>}
 */
export function generateSuggestions(views, params, existing) {
    var byCam = new Map();
    (existing || []).forEach(function (s) {
        if (!byCam.has(s.camera)) byCam.set(s.camera, new Set());
        byCam.get(s.camera).add(s.frameIdx);
    });
    var per = params.perVideo != null ? params.perVideo : DEFAULT_PER_VIDEO;
    var out = [];
    views.forEach(function (v) {
        var frames;
        if (params.method === 'frame_chunk') {
            var c = params.chunk || { from: 1, to: v.nFrames };
            frames = frameChunkFrames(v.nFrames, c.from, c.to);
        } else {
            frames = sampleFrames(v.nFrames, per, params.method === 'random' ? 'random' : 'stride',
                params.range || null, byCam.get(v.camera) || null, params.rng);
        }
        frames.forEach(function (f) { out.push({ camera: v.camera, frameIdx: f, group: 0 }); });
    });
    return out;
}

/** True if `list` has a suggestion for (camera, frameIdx). */
export function suggestionExists(list, camera, frameIdx) {
    for (var i = 0; i < list.length; i++) {
        if (list[i].camera === camera && list[i].frameIdx === frameIdx) return true;
    }
    return false;
}

/**
 * `existing` followed by the entries of `incoming` it does not have yet (also
 * deduping `incoming` itself). The "Add" generation mode and "Add labeled frames".
 */
export function mergeSuggestions(existing, incoming) {
    var seen = new Set(existing.map(function (s) { return suggestionKey(s.camera, s.frameIdx); }));
    var out = existing.slice();
    incoming.forEach(function (s) {
        var k = suggestionKey(s.camera, s.frameIdx);
        if (seen.has(k)) return;
        seen.add(k);
        out.push(s);
    });
    return out;
}

/** `list` in random order (Fisher–Yates). */
export function shuffleSuggestions(list, rng) {
    var r = rng || Math.random;
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i--) {
        var j = Math.floor(r() * (i + 1));
        var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
}

/** Keep only the suggestions `isLabeled(camera, frameIdx)` says are labeled. */
export function removeUnlabeledSuggestions(list, isLabeled) {
    return list.filter(function (s) { return isLabeled(s.camera, s.frameIdx); });
}

/** `list` without the entry for (camera, frameIdx). */
export function removeSuggestion(list, camera, frameIdx) {
    return list.filter(function (s) { return !(s.camera === camera && s.frameIdx === frameIdx); });
}

/**
 * `{labeled, total, pct}` over `list` (pct NOT rounded), sleap-app's
 * `labeledSummary`.
 */
export function labeledSummary(list, isLabeled) {
    var labeled = 0;
    for (var i = 0; i < list.length; i++) if (isLabeled(list[i].camera, list[i].frameIdx)) labeled++;
    return { labeled: labeled, total: list.length, pct: list.length ? (labeled / list.length) * 100 : 0 };
}

/**
 * The panel's groups: one per view that has suggestions, the focused view
 * (`current`) first, then the session's views in `cameraOrder`, then any view
 * the session no longer has. Rows keep the list's order (so Shuffle shows).
 *
 * @param {Array<{camera: string, frameIdx: number}>} list
 * @param {string[]} cameraOrder
 * @param {string|null} current
 * @returns {Array<{camera: string, rows: Array<{camera: string, frameIdx: number}>}>}
 */
export function groupSuggestionsByView(list, cameraOrder, current) {
    var byCam = new Map();
    list.forEach(function (s) {
        if (!byCam.has(s.camera)) byCam.set(s.camera, []);
        byCam.get(s.camera).push(s);
    });
    var order = [];
    if (current != null && byCam.has(current)) order.push(current);
    (cameraOrder || []).forEach(function (c) { if (byCam.has(c) && order.indexOf(c) === -1) order.push(c); });
    byCam.forEach(function (_, c) { if (order.indexOf(c) === -1) order.push(c); });
    return order.map(function (c) { return { camera: c, rows: byCam.get(c) }; });
}

/**
 * Prev / Next (sleap-app `goToSuggestionOffset`): the row `delta` away from
 * the selected row in `rows` (display order), else from the row on screen
 * (`here`), else the first (Next) or last (Prev) row. Wraps at the ends.
 *
 * @param {Array<{camera: string, frameIdx: number}>} rows
 * @param {{camera: string, frameIdx: number}|null} selected
 * @param {{camera: string, frameIdx: number}|null} here
 * @param {1|-1} delta
 * @returns {{camera: string, frameIdx: number}|null}
 */
export function stepSuggestion(rows, selected, here, delta) {
    var n = rows.length;
    if (n === 0) return null;
    var find = function (t) {
        if (!t) return -1;
        for (var i = 0; i < n; i++) if (rows[i].camera === t.camera && rows[i].frameIdx === t.frameIdx) return i;
        return -1;
    };
    var pos = find(selected);
    if (pos === -1) pos = find(here);
    var next = pos === -1 ? (delta > 0 ? 0 : n - 1) : (pos + delta + n) % n;
    return rows[next];
}
