/**
 * temporal-smoothing.js — post-triangulation temporal filtering of 3D tracks.
 *
 * Answers luc3d #134 ("3d projection would benefit from anipose's temporal
 * smoothing and RPE flags"). The RPE half of that issue already shipped as
 * Tracking Wizard ▸ "Reprojection error threshold (px)"
 * (`triangulateAndReproject`, pose/triangulation.js); this module is the
 * smoothing half.
 *
 * ## Where this sits
 *
 * AFTER triangulation, never during tracking, and never on 2D. The pipeline is
 * track → proofread identities → triangulate → smooth. Three reasons this is
 * not folded into the tracker:
 *   - Smoothing before identities are proofread smooths ACROSS an ID swap,
 *     which physically welds two animals' trajectories into one.
 *   - `CrossViewTracker` is an online, frame-by-frame associator; a smoother is
 *     non-causal and needs frames on both sides.
 *   - The tracker's hyperparameters are measured against benchmark corpora
 *     (see pose/cross-view-tracker.js); changing the 3D state its association
 *     cost reads against invalidates those numbers.
 *
 * ## What it reads and writes
 *
 * Reads and writes `InstanceGroup.points3d` ONLY. Never touches
 * `Instance._xy` for any camera — hand-placed (`'user'`) labels and model
 * (`'predicted'`) output are the annotation record and stay byte-identical.
 * That is the whole reason the smoother lives in 3D rather than filtering the
 * per-view 2D: the prior ("low acceleration") is physically true of an animal
 * in the world and only approximately true under perspective projection, and
 * a 2D filter that interpolates a missing view fabricates an observation which
 * then votes in triangulation as if it were real data.
 *
 * Reprojections are DERIVED from `points3d`, so smoothing invalidates both
 * caches (`group.reprojections` raw points and `group.reprojectedInstances`).
 * They are cleared here and refilled lazily by `ui/rendering.js` /
 * `getOrComputeReprojectedInstance`. Users get smoother 2D overlays as a
 * by-product without a single label being rewritten.
 *
 * `triangulationMethod` is deliberately NOT touched. Smoothing is orthogonal to
 * which solver produced the points — a group can be BA-solved AND smoothed —
 * and `resolveTriangulationMethod` exists precisely to stop a re-solve from
 * silently downgrading a BA group to DLT. A third value there would erase the
 * solver identity. The smoothed state is its own flag, `InstanceGroup.smoothed`.
 *
 * ## No lazy sweep needed
 *
 * `session.instanceGroups` is fully resident: `sweepLazyFrameWindows` releases
 * `frameGroups` (2D) but never `instanceGroups`, and the SLP 2.8 columnar
 * `/session_data` reader materializes every group's 3D on load (see the luc3d
 * #189 notes in CLAUDE.md). So this walks `session.instanceGroups` directly and
 * does NOT hydrate 2D — which also means it cannot fall into the resident-only
 * bug class of luc3d #194/#195, because there is no non-resident 3D to miss.
 *
 * ## The algorithm
 *
 * Two stages, applied in this order and independently switchable:
 *
 *   1. MEDIAN (despike). Nonlinear, rank-based; removes impulses.
 *   2. GAUSSIAN (smooth). Linear, weighted mean; removes broadband noise.
 *
 * The order is fixed and deliberate: run the Gaussian first and it smears an
 * isolated outlier across its whole window, after which the median can no
 * longer remove it because it has stopped being an isolated outlier.
 *
 * Both stages are the same gather over a window on ONE node's ONE coordinate
 * through time, differing only in the reducer. For a 15-node skeleton that is
 * 45 independent 1D signals per identity. Nodes never enter each other's
 * windows — averaging a nose against an ear is meaningless, and spatial
 * coupling between nodes belongs in limb-length constraints, not a filter.
 *
 * ## Missing data
 *
 * Two regimes, and conflating them is the main way this goes wrong:
 *
 *   - ISOLATED HOLES (a node missing for a frame or two inside good data).
 *     Skip the missing samples and renormalize the Gaussian weights over what
 *     is present. Bias is small. Note what is NOT done: anipose's `filter_3d.py`
 *     `np.interp`s across gaps of ANY length before filtering, so fabricated
 *     points get median-filtered as if measured and the output contains no NaN
 *     at all. That is not copied.
 *
 *   - SEGMENT BOUNDARIES (the animal was gone; gap >= `maxGap`). Every sample
 *     on one side is absent and no bookkeeping recovers it. A one-sided window
 *     is not a smoother, it is an extrapolation: at the first frame after a
 *     gap a 7-wide window sees only `t..t+3`, whose centroid is `t+1.5`, so at
 *     10 mm/frame the "smoothed" value is off by ~15 mm — systematic, and
 *     plausibly larger than the jitter being removed. So the window SHRINKS
 *     SYMMETRICALLY at a boundary (radius = distance to the nearer edge),
 *     trading smoothing strength for unbiasedness.
 *
 * Whether a frame is missing is decided ONCE at the SKELETON level and applied
 * identically to all 45 signals. A single 1D signal cannot tell you why it has
 * a hole — "occluded in 4 of 5 cameras" and "the animal left" look the same
 * from inside node 7's x-coordinate — and letting each node segment itself
 * means node 7 and node 8 get smoothed under different regimes and the
 * skeleton visibly deforms.
 *
 * Gaps are never FILLED: a frame whose node was NaN on input is NaN on output.
 * That keeps the gap structure invariant across the two stages (so segments are
 * computed once and reused) and preserves the invariant that a 3D point exists
 * only where it was triangulable.
 *
 * ## Interaction with the other dial
 *
 * Turning `reprojErrorThreshold` up CREATES NaN — it nulls any node that cannot
 * find two sub-threshold views. More nulls means more segment boundaries, which
 * is exactly where this filter is weakest. Aggressive RPE plus aggressive
 * smoothing is a worse combination than either alone.
 *
 * Depends on: pose/pose-data.js
 */

import {
    POINT3D_STRIDE,
    points3dNodeCount,
} from './pose-data.js';

// Identity id meaning "no identity" (matches `InstanceGroup`'s default).
const NO_IDENTITY = -1;

/**
 * Coerce a requested window to a usable ODD sample count, or 0 for "off".
 *
 * Odd so the window is symmetric about the frame being written. An even count
 * has no center frame, so the output lands halfway between two frames — a
 * half-frame phase shift that slides the whole trajectory in time relative to
 * the video. For the median it also matters that an odd count makes the result
 * one of the actual observed values rather than the mean of the two middle
 * ones.
 *
 * @param {number} w
 * @returns {number} an odd integer >= 3, or 0
 */
export function normalizeWindow(w) {
    var n = Math.floor(Number(w));
    if (!isFinite(n) || n < 3) return 0;
    if (n % 2 === 0) n += 1;
    return n;
}

/**
 * Gaussian sigma for a window of `w` samples: the window spans +/- 3 sigma, the
 * conventional truncation point. w=7 -> 1, w=13 -> 2.
 * @param {number} w odd window size
 */
export function sigmaForWindow(w) {
    return Math.max((w - 1) / 6, 1e-6);
}

/**
 * Split a presence mask into maximal segments, cutting only at runs of absent
 * frames LONGER than `maxGap`.
 *
 * Shorter runs stay inside a segment as holes — the benign case the reducers
 * handle by skipping. `maxGap = 0` cuts at every absent frame.
 *
 * @param {Uint8Array} present 1 = the identity has a usable group on this frame
 * @param {number} maxGap longest absent run that does NOT split a segment
 * @returns {Array<{start: number, end: number}>} half-open [start, end)
 */
export function buildSegments(present, maxGap) {
    var segments = [];
    var n = present.length;
    var gap = Math.max(0, Math.floor(maxGap) || 0);
    var i = 0;
    while (i < n) {
        while (i < n && !present[i]) i++;
        if (i >= n) break;
        var start = i;
        var lastPresent = i;
        i++;
        while (i < n) {
            if (present[i]) { lastPresent = i; i++; continue; }
            // Measure the absent run; it only ends the segment if it is long.
            var runStart = i;
            while (i < n && !present[i]) i++;
            if (i >= n || (i - runStart) > gap) { i = runStart; break; }
        }
        segments.push({ start: start, end: lastPresent + 1 });
        // Skip the absent run that terminated this segment.
        while (i < n && !present[i]) i++;
    }
    return segments;
}

/**
 * Median of the first `n` entries of `buf`, which is sorted in place.
 *
 * Insertion sort: `n` is the window size (single digits in practice), where
 * insertion sort beats anything asymptotically better.
 *
 * @param {Float64Array} buf
 * @param {number} n
 */
export function medianOf(buf, n) {
    for (var i = 1; i < n; i++) {
        var v = buf[i];
        var j = i - 1;
        while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
        buf[j + 1] = v;
    }
    var mid = n >> 1;
    // n is odd whenever the window was not truncated to an even count of
    // available samples; average the two middles when it was.
    return (n & 1) ? buf[mid] : 0.5 * (buf[mid - 1] + buf[mid]);
}

/**
 * Filter one 1D signal into `dst`.
 *
 * `src` and `dst` must not alias. NaN in `src` is NaN in `dst` — gaps are never
 * filled. Frames outside every segment (and segments shorter than
 * `minSegment`) are copied through unchanged.
 *
 * @param {Float64Array} src
 * @param {Float64Array} dst
 * @param {Array<{start:number,end:number}>} segments
 * @param {{kernel: 'median'|'gaussian', window: number, minSegment: number}} opts
 * @param {Float64Array} scratchV window values, length >= opts.window
 * @param {Float64Array} scratchW window weights, length >= opts.window
 */
export function smoothSignalInto(src, dst, segments, opts, scratchV, scratchW) {
    dst.set(src);
    var w = opts.window;
    if (!w) return;
    var radius = (w - 1) >> 1;
    var isMedian = opts.kernel === 'median';
    var sigma = isMedian ? 0 : sigmaForWindow(w);
    var twoSigmaSq = 2 * sigma * sigma;
    var minSeg = Math.max(1, Math.floor(opts.minSegment) || 1);

    for (var s = 0; s < segments.length; s++) {
        var segStart = segments[s].start;
        var segEnd = segments[s].end;
        if (segEnd - segStart < minSeg) continue;

        for (var t = segStart; t < segEnd; t++) {
            if (Number.isNaN(src[t])) continue;

            // Symmetric shrink at the SEGMENT edges (not at holes): a one-sided
            // window biases the result toward whichever side still has data.
            var r = radius;
            var leftRoom = t - segStart;
            var rightRoom = segEnd - 1 - t;
            if (leftRoom < r) r = leftRoom;
            if (rightRoom < r) r = rightRoom;
            if (r < 1) continue;

            var n = 0;
            var wsum = 0;
            for (var d = -r; d <= r; d++) {
                var v = src[t + d];
                if (Number.isNaN(v)) continue;   // isolated hole: skip
                scratchV[n] = v;
                if (!isMedian) {
                    var g = Math.exp(-(d * d) / twoSigmaSq);
                    scratchW[n] = g;
                    wsum += g;
                }
                n++;
            }
            if (n < 2) continue;

            if (isMedian) {
                // A median over fewer than 3 samples cannot reject anything.
                if (n < 3) continue;
                dst[t] = medianOf(scratchV, n);
            } else {
                // Renormalize over the samples actually present. Without this,
                // every point within half a window of a hole is dragged toward
                // the world origin.
                if (!(wsum > 0)) continue;
                var acc = 0;
                for (var k = 0; k < n; k++) acc += scratchV[k] * scratchW[k];
                dst[t] = acc / wsum;
            }
        }
    }
}

/**
 * Resolve the effective smoothing configuration from a loose params object.
 * @param {Object} params
 * @returns {{medianWindow:number, gaussianWindow:number, maxGap:number,
 *   minSegment:number, enabled:boolean}}
 */
export function resolveSmoothingParams(params) {
    params = params || {};
    var medianWindow = normalizeWindow(params.smoothMedianWindow);
    var gaussianWindow = normalizeWindow(params.smoothGaussianWindow);
    var maxGap = Math.max(0, Math.floor(params.smoothMaxGap) || 0);
    var minSegment = Math.max(1, Math.floor(params.smoothMinSegment) || 1);
    return {
        medianWindow: medianWindow,
        gaussianWindow: gaussianWindow,
        maxGap: maxGap,
        minSegment: minSegment,
        enabled: medianWindow > 0 || gaussianWindow > 0,
    };
}

/**
 * Bucket a session's instance groups into per-identity trajectories.
 *
 * Groups with no identity (`identityId === -1`) form their own bucket, but only
 * when no frame contributes more than one of them: without an identity there is
 * nothing to tell two animals' groups apart across frames, so smoothing them as
 * one trajectory would interleave two animals. A single unidentified group per
 * frame is the ordinary single-animal / untracked case and is safe.
 *
 * @param {Session} session
 * @returns {{tracks: Map<number, Map<number, InstanceGroup>>, skipped: number}}
 */
export function collectTrajectories(session) {
    var tracks = new Map();
    var noIdAmbiguous = false;
    var skipped = 0;

    for (var [frameIdx, groups] of session.instanceGroups) {
        if (!groups || !groups.length) continue;
        var seenNoId = 0;
        for (var gi = 0; gi < groups.length; gi++) {
            var group = groups[gi];
            if (!group || !group.points3d) continue;
            var id = (group.identityId == null) ? NO_IDENTITY : group.identityId;
            if (id === NO_IDENTITY) {
                seenNoId++;
                if (seenNoId > 1) noIdAmbiguous = true;
            }
            var byFrame = tracks.get(id);
            if (!byFrame) { byFrame = new Map(); tracks.set(id, byFrame); }
            // Two groups sharing one identity on one frame is a proofreading
            // defect, not a trajectory; keep the first and count the rest.
            if (byFrame.has(frameIdx)) { skipped++; continue; }
            byFrame.set(frameIdx, group);
        }
    }

    if (noIdAmbiguous && tracks.has(NO_IDENTITY)) {
        skipped += tracks.get(NO_IDENTITY).size;
        tracks.delete(NO_IDENTITY);
    }
    return { tracks: tracks, skipped: skipped };
}

/**
 * Invalidate a group's reprojection caches after its 3D moved.
 * @param {InstanceGroup} group
 */
function invalidateReprojections(group) {
    group.reprojections = null;
    if (group.reprojectedInstances && typeof group.reprojectedInstances.clear === 'function') {
        group.reprojectedInstances.clear();
    }
}

/**
 * Smooth one identity's trajectory in place.
 *
 * @param {Map<number, InstanceGroup>} byFrame frameIdx -> group
 * @param {ReturnType<typeof resolveSmoothingParams>} cfg
 * @param {Set<number>|null} writeFrames frames allowed to be WRITTEN; every
 *   frame is still READ as context. null = write everywhere.
 * @returns {{frames: number, nodes: number}} counts actually written
 */
export function smoothTrajectory(byFrame, cfg, writeFrames) {
    var frameIdxs = Array.from(byFrame.keys()).sort(function (a, b) { return a - b; });
    if (frameIdxs.length === 0) return { frames: 0, nodes: 0 };

    var minFrame = frameIdxs[0];
    var maxFrame = frameIdxs[frameIdxs.length - 1];
    var T = maxFrame - minFrame + 1;

    // Widest node count in the trajectory. A group with fewer nodes simply
    // leaves the tail signals NaN, which the segmentation already tolerates.
    var nNodes = 0;
    for (var fi = 0; fi < frameIdxs.length; fi++) {
        var nc = points3dNodeCount(byFrame.get(frameIdxs[fi]).points3d);
        if (nc > nNodes) nNodes = nc;
    }
    if (nNodes === 0) return { frames: 0, nodes: 0 };

    var stride = nNodes * POINT3D_STRIDE;
    var data = new Float64Array(T * stride).fill(NaN);
    var groupAt = new Array(T).fill(null);
    var present = new Uint8Array(T);

    // --- Gather: dense over [minFrame, maxFrame], NaN where absent ---------
    for (var f = 0; f < frameIdxs.length; f++) {
        var frameIdx = frameIdxs[f];
        var t = frameIdx - minFrame;
        var group = byFrame.get(frameIdx);
        groupAt[t] = group;
        var pts = group.points3d;
        var have = 0;
        var count = points3dNodeCount(pts);
        var base = t * stride;
        for (var k = 0; k < count; k++) {
            var o = k * POINT3D_STRIDE;
            var x = pts[o], y = pts[o + 1], z = pts[o + 2];
            // A partially-NaN triple is meaningless in 3D — treat it as absent,
            // matching `hasPoint3d`.
            if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue;
            data[base + o] = x;
            data[base + o + 1] = y;
            data[base + o + 2] = z;
            have++;
        }
        // Skeleton-level presence: the frame counts as present when the group
        // has ANY triangulated node. Decided once here, applied to all signals.
        if (have > 0) present[t] = 1;
    }

    var segments = buildSegments(present, cfg.maxGap);
    if (segments.length === 0) return { frames: 0, nodes: 0 };

    // --- Filter: one signal at a time, both stages, segments reused --------
    var maxWindow = Math.max(cfg.medianWindow, cfg.gaussianWindow);
    var src = new Float64Array(T);
    var dst = new Float64Array(T);
    var scratchV = new Float64Array(maxWindow);
    var scratchW = new Float64Array(maxWindow);

    for (var s = 0; s < stride; s++) {
        for (var i = 0; i < T; i++) src[i] = data[i * stride + s];

        if (cfg.medianWindow > 0) {
            smoothSignalInto(src, dst, segments, {
                kernel: 'median', window: cfg.medianWindow, minSegment: cfg.minSegment,
            }, scratchV, scratchW);
            src.set(dst);
        }
        if (cfg.gaussianWindow > 0) {
            smoothSignalInto(src, dst, segments, {
                kernel: 'gaussian', window: cfg.gaussianWindow, minSegment: cfg.minSegment,
            }, scratchV, scratchW);
            src.set(dst);
        }

        for (var i2 = 0; i2 < T; i2++) data[i2 * stride + s] = src[i2];
    }

    // --- Scatter: write back, invalidating derived reprojections -----------
    var framesWritten = 0;
    var nodesWritten = 0;
    for (var t2 = 0; t2 < T; t2++) {
        var g = groupAt[t2];
        if (!g || !present[t2]) continue;
        if (writeFrames && !writeFrames.has(t2 + minFrame)) continue;
        var pts2 = g.points3d;
        var count2 = points3dNodeCount(pts2);
        var base2 = t2 * stride;
        var touched = 0;
        for (var k2 = 0; k2 < count2; k2++) {
            var o2 = k2 * POINT3D_STRIDE;
            var nx = data[base2 + o2];
            // Never resurrect a node that was missing: gaps are not filled.
            if (Number.isNaN(nx)) continue;
            pts2[o2] = nx;
            pts2[o2 + 1] = data[base2 + o2 + 1];
            pts2[o2 + 2] = data[base2 + o2 + 2];
            touched++;
        }
        if (touched > 0) {
            invalidateReprojections(g);
            g.smoothed = true;
            framesWritten++;
            nodesWritten += touched;
        }
    }

    return { frames: framesWritten, nodes: nodesWritten };
}

/**
 * Smooth a whole session's 3D tracks in place.
 *
 * @param {Session} session
 * @param {Object} params raw `{ smoothMedianWindow, smoothGaussianWindow,
 *   smoothMaxGap, smoothMinSegment }`
 * @param {{writeFrames?: Set<number>|null, onProgress?: function}} [opts]
 * @returns {{tracks:number, frames:number, nodes:number, skipped:number,
 *   config:Object, ran:boolean}}
 */
export function smoothSession(session, params, opts) {
    opts = opts || {};
    var cfg = resolveSmoothingParams(params);
    var result = {
        tracks: 0, frames: 0, nodes: 0, skipped: 0, config: cfg, ran: false,
    };
    if (!session || !session.instanceGroups || !cfg.enabled) return result;

    var collected = collectTrajectories(session);
    result.skipped = collected.skipped;
    var writeFrames = opts.writeFrames || null;

    var total = collected.tracks.size;
    var done = 0;
    for (var [, byFrame] of collected.tracks) {
        var stats = smoothTrajectory(byFrame, cfg, writeFrames);
        if (stats.frames > 0) result.tracks++;
        result.frames += stats.frames;
        result.nodes += stats.nodes;
        done++;
        if (opts.onProgress) opts.onProgress(done, total);
    }
    result.ran = true;
    return result;
}
