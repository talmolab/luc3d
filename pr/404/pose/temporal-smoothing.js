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
    NO_REPROJECTED_INSTANCES,
    pooledPoints3d,
    markPoints3dSmoothed,
    isPoints3dSmoothed,
    unsmoothedPoints3d,
    clearPoints3dSmoothed,
} from './pose-data.js?v=7a9a2de1fb85';

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
 * `opts.from` / `opts.to` (default the whole signal) limit the samples
 * COMPUTED to `[from, to)`; the rest are copied through. A segment may then
 * reach past either end of the signal (`smoothFrame` passes the true segment
 * of a short slice): its length still decides `minSegment` and its edges the
 * shrink, and no read leaves the signal as long as every computed sample's
 * window fits in it.
 *
 * @param {Float64Array} src
 * @param {Float64Array} dst
 * @param {Array<{start:number,end:number}>} segments
 * @param {{kernel: 'median'|'gaussian', window: number, minSegment: number,
 *   from?: number, to?: number}} opts
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
    var from = Math.max(0, opts.from || 0);
    var to = Math.min(src.length, opts.to == null ? src.length : opts.to);

    for (var s = 0; s < segments.length; s++) {
        var segStart = segments[s].start;
        var segEnd = segments[s].end;
        if (segEnd - segStart < minSeg) continue;

        var tEnd = Math.min(segEnd, to);
        for (var t = Math.max(segStart, from); t < tEnd; t++) {
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
 * `reprojectedInstances` goes back to the shared read-only empty map (as
 * pose-data.js's `clearGroupReprojections` does): `clear()` on it throws.
 * @param {InstanceGroup} group
 */
function invalidateReprojections(group) {
    group.reprojections = null;
    if (group.reprojectedInstances !== NO_REPROJECTED_INSTANCES) {
        group.reprojectedInstances = NO_REPROJECTED_INSTANCES;
    }
}

/**
 * Copy one group's 3D — as it was before ANY smoothing, so a second run
 * replaces the first rather than smoothing its output again — into
 * `data[base..]`, leaving absent nodes NaN.
 * @returns {number} nodes present; 0 = the frame is absent (skeleton-level)
 */
function gatherGroupInto(group, data, base) {
    var pts = unsmoothedPoints3d(group.points3d) || group.points3d;
    var have = 0;
    var count = points3dNodeCount(pts);
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
    return have;
}

/** Node count of a group's pre-smoothing 3D (what `gatherGroupInto` reads). */
function sourceNodeCount(group) {
    return points3dNodeCount(unsmoothedPoints3d(group.points3d) || group.points3d);
}

/**
 * Write filtered values `data[base..]` into a group's `points3d` in place,
 * keeping its pre-smoothing copy and invalidating derived reprojections.
 * @returns {number} nodes written (0 = untouched)
 */
function writeGroupFrom(g, data, base) {
    var pts2 = g.points3d;
    var source = unsmoothedPoints3d(pts2);
    var count2 = points3dNodeCount(pts2);
    var touched = 0;
    for (var k2 = 0; k2 < count2; k2++) {
        var o2 = k2 * POINT3D_STRIDE;
        var nx = data[base + o2];
        // Never resurrect a node that was missing: gaps are not filled.
        if (Number.isNaN(nx)) continue;
        // First smoothing of this array: keep what it held (in the slab
        // pool, not one ArrayBuffer per group) before overwriting it. The
        // slice matters: `pooledPoints3d` hands an already-pooled array
        // back as-is, which would make the copy the array being written.
        if (!source) source = pooledPoints3d(pts2.slice());
        pts2[o2] = nx;
        pts2[o2 + 1] = data[base + o2 + 1];
        pts2[o2 + 2] = data[base + o2 + 2];
        touched++;
    }
    if (touched > 0) {
        invalidateReprojections(g);
        markPoints3dSmoothed(pts2, source);
        g.smoothed = true;
    }
    return touched;
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
    var steps = smoothTrajectorySteps(byFrame, cfg, writeFrames);
    var r;
    while (!(r = steps.next()).done) { /* run straight through */ }
    return r.value;
}

/**
 * `smoothTrajectory` as a generator: yields the fraction of the filtering done
 * (0..1) after each node coordinate, so `smoothSessionAsync` can show progress
 * and let the page paint. Nothing is written until the last yield has passed —
 * the write-back runs after the filter — so stopping early writes nothing.
 * Returns the same `{frames, nodes}`.
 */
function* smoothTrajectorySteps(byFrame, cfg, writeFrames) {
    var frameIdxs = Array.from(byFrame.keys()).sort(function (a, b) { return a - b; });
    if (frameIdxs.length === 0) return { frames: 0, nodes: 0 };

    var minFrame = frameIdxs[0];
    var maxFrame = frameIdxs[frameIdxs.length - 1];
    var T = maxFrame - minFrame + 1;

    // Widest node count in the trajectory. A group with fewer nodes simply
    // leaves the tail signals NaN, which the segmentation already tolerates.
    var nNodes = 0;
    for (var fi = 0; fi < frameIdxs.length; fi++) {
        var nc = sourceNodeCount(byFrame.get(frameIdxs[fi]));
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
        // Skeleton-level presence: the frame counts as present when the group
        // has ANY triangulated node. Decided once here, applied to all signals.
        if (gatherGroupInto(group, data, t * stride) > 0) present[t] = 1;
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
        yield (s + 1) / stride;
    }

    // --- Scatter: write back, invalidating derived reprojections -----------
    var framesWritten = 0;
    var nodesWritten = 0;
    for (var t2 = 0; t2 < T; t2++) {
        var g = groupAt[t2];
        if (!g || !present[t2]) continue;
        if (writeFrames && !writeFrames.has(t2 + minFrame)) continue;
        var touched = writeGroupFrom(g, data, t2 * stride);
        if (touched > 0) {
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
 * @param {{writeFrames?: Set<number>|null}} [opts]
 * @returns {{tracks:number, frames:number, nodes:number, skipped:number,
 *   config:Object, ran:boolean}}
 */
export function smoothSession(session, params, opts) {
    var steps = smoothSessionSteps(session, params, opts);
    var r;
    while (!(r = steps.next()).done) { /* run straight through */ }
    return r.value;
}

/**
 * `smoothSession` with progress: awaits `opts.onProgress(done, total)` between
 * steps (one per node coordinate of each track), counted in POSES — one per
 * animal per frame — so a caller can paint a progress card and yield. Same
 * result, same writes.
 *
 * @param {Session} session
 * @param {Object} params
 * @param {{writeFrames?: Set<number>|null,
 *   onProgress?: function(number, number): (Promise|void)}} [opts]
 * @returns {Promise<Object>} as `smoothSession`
 */
export async function smoothSessionAsync(session, params, opts) {
    var onProgress = opts && opts.onProgress;
    var steps = smoothSessionSteps(session, params, opts);
    var r;
    while (!(r = steps.next()).done) {
        if (onProgress) await onProgress(r.value.done, r.value.total);
    }
    return r.value;
}

/** The shared body: yields `{done, total}` in poses, returns the result. */
function* smoothSessionSteps(session, params, opts) {
    opts = opts || {};
    var cfg = resolveSmoothingParams(params);
    var result = {
        tracks: 0, frames: 0, nodes: 0, skipped: 0, config: cfg, ran: false,
    };
    if (!session || !session.instanceGroups || !cfg.enabled) return result;
    // A new run supersedes any removed smoothing kept for Restore.
    _removedSmoothing.delete(session);

    var collected = collectTrajectories(session);
    result.skipped = collected.skipped;
    var writeFrames = opts.writeFrames || null;

    var total = 0;
    for (var [, bf] of collected.tracks) total += bf.size;
    var done = 0;
    var smoothedFrames = smoothedFramesOf(session);
    for (var [, byFrame] of collected.tracks) {
        var steps = smoothTrajectorySteps(byFrame, cfg, writeFrames);
        var r;
        while (!(r = steps.next()).done) {
            yield { done: done + byFrame.size * r.value, total: total };
        }
        var stats = r.value;
        if (stats.frames > 0) {
            for (var [fi, g] of byFrame) {
                if (isPoints3dSmoothed(g.points3d)) smoothedFrames.add(fi);
            }
        }
        if (stats.frames > 0) result.tracks++;
        result.frames += stats.frames;
        result.nodes += stats.nodes;
        done += byFrame.size;
        yield { done: done, total: total };
    }
    result.ran = true;
    return result;
}

/**
 * The group `collectTrajectories` would put in identity `id`'s trajectory on
 * `frameIdx`: the first one with 3D. null when there is none.
 */
function trajectoryGroupAt(session, frameIdx, id) {
    var groups = session.instanceGroups.get(frameIdx);
    if (!groups) return null;
    for (var gi = 0; gi < groups.length; gi++) {
        var g = groups[gi];
        if (!g || !g.points3d) continue;
        if (((g.identityId == null) ? NO_IDENTITY : g.identityId) === id) return g;
    }
    return null;
}

/** Is the frame present in identity `id`'s trajectory (any node triangulated)? */
function trajectoryPresentAt(session, frameIdx, id) {
    var g = trajectoryGroupAt(session, frameIdx, id);
    if (!g) return false;
    var pts = unsmoothedPoints3d(g.points3d) || g.points3d;
    var count = points3dNodeCount(pts);
    for (var k = 0; k < count; k++) {
        var o = k * POINT3D_STRIDE;
        if (!Number.isNaN(pts[o]) && !Number.isNaN(pts[o + 1]) && !Number.isNaN(pts[o + 2])) return true;
    }
    return false;
}

/** Does any frame hold two unidentified groups? (`collectTrajectories`' rule) */
function hasAmbiguousNoIdentity(session) {
    for (var [, groups] of session.instanceGroups) {
        if (!groups || groups.length < 2) continue;
        var seen = 0;
        for (var gi = 0; gi < groups.length; gi++) {
            var g = groups[gi];
            if (!g || !g.points3d) continue;
            if (g.identityId == null || g.identityId === NO_IDENTITY) {
                if (++seen > 1) return true;
            }
        }
    }
    return false;
}

/**
 * Smooth ONE frame — Temporal Smoothing ▸ "This frame" — reading only the
 * frames its value depends on, so the cost follows the windows, not the
 * recording length.
 *
 * Writes exactly what `smoothSession` (all frames, same params) writes on
 * `frameIdx`, bit for bit, and nothing else. What that value depends on, per
 * identity on the frame:
 *   - the samples within median radius + Gaussian radius of the frame (the
 *     Gaussian reads the median's output within its radius, and each of those
 *     read the input within theirs);
 *   - the frame's SEGMENT edges (the symmetric shrink) and length
 *     (`minSegment`). They are found by walking out from the frame until an
 *     absent run longer than `maxGap` ends the segment, or until a present
 *     frame lies far enough out (past both radii and `minSegment`) that the
 *     true edge can no longer change the result — that frame then stands in
 *     for the edge, so the walk is bounded too.
 * The slice is filtered by the same `smoothSignalInto`, with the true segment
 * passed in slice coordinates (it may reach past the slice) and only the
 * samples the frame reads computed (`from`/`to`), so every sum runs in the same
 * order as the full pass.
 *
 * Identity bucketing follows `collectTrajectories` (first group per identity
 * per frame; unidentified groups only when no frame anywhere holds two of them
 * — the one whole-session walk here, and only when the frame has an
 * unidentified group). `skipped` counts this frame's groups only.
 *
 * @param {Session} session
 * @param {Object} params as `smoothSession`
 * @param {number} frameIdx
 * @returns {{tracks:number, frames:number, nodes:number, skipped:number,
 *   config:Object, ran:boolean}} as `smoothSession`
 */
export function smoothFrame(session, params, frameIdx) {
    var cfg = resolveSmoothingParams(params);
    var result = {
        tracks: 0, frames: 0, nodes: 0, skipped: 0, config: cfg, ran: false,
    };
    if (!session || !session.instanceGroups || !cfg.enabled) return result;
    // A new run supersedes any removed smoothing kept for Restore.
    _removedSmoothing.delete(session);
    result.ran = true;
    var groups = session.instanceGroups.get(frameIdx);
    if (!groups || !groups.length) return result;

    var ids = [];
    var seenIds = new Set();
    var noIdHere = 0;
    for (var gi = 0; gi < groups.length; gi++) {
        var g0 = groups[gi];
        if (!g0 || !g0.points3d) continue;
        var id0 = (g0.identityId == null) ? NO_IDENTITY : g0.identityId;
        if (id0 === NO_IDENTITY) noIdHere++;
        if (seenIds.has(id0)) { result.skipped++; continue; }
        seenIds.add(id0);
        ids.push(id0);
    }
    if (seenIds.has(NO_IDENTITY) && (noIdHere > 1 || hasAmbiguousNoIdentity(session))) {
        ids.splice(ids.indexOf(NO_IDENTITY), 1);
        result.skipped++;
    }

    var rm = cfg.medianWindow ? (cfg.medianWindow - 1) >> 1 : 0;
    var rg = cfg.gaussianWindow ? (cfg.gaussianWindow - 1) >> 1 : 0;
    var reach = rm + rg;
    // A present frame this far out stands in for the segment edge: every
    // sample computed is then at least its own radius from it (no shrink), and
    // the segment is longer than `minSegment` either way.
    var far = Math.max(reach, cfg.minSegment);
    var maxWindow = Math.max(cfg.medianWindow, cfg.gaussianWindow);
    var scratchV = new Float64Array(maxWindow);
    var scratchW = new Float64Array(maxWindow);

    for (var ii = 0; ii < ids.length; ii++) {
        var id = ids[ii];
        if (!trajectoryPresentAt(session, frameIdx, id)) continue;

        // --- Segment edges (or stand-ins), as `buildSegments` would cut ----
        var first = frameIdx, run = 0;
        for (var f = frameIdx - 1; frameIdx - first < far; f--) {
            if (trajectoryPresentAt(session, f, id)) { first = f; run = 0; }
            else if (++run > cfg.maxGap) break;
        }
        var last = frameIdx;
        run = 0;
        for (var f2 = frameIdx + 1; last - frameIdx < far; f2++) {
            if (trajectoryPresentAt(session, f2, id)) { last = f2; run = 0; }
            else if (++run > cfg.maxGap) break;
        }

        // --- Gather the slice [lo, hi] the frame's value reads ---------------
        var lo = Math.max(first, frameIdx - reach);
        var hi = Math.min(last, frameIdx + reach);
        var T = hi - lo + 1;
        var nNodes = 0;
        var at = new Array(T);
        for (var t = 0; t < T; t++) {
            at[t] = trajectoryGroupAt(session, lo + t, id);
            if (at[t]) {
                var nc = sourceNodeCount(at[t]);
                if (nc > nNodes) nNodes = nc;
            }
        }
        if (nNodes === 0) continue;
        var stride = nNodes * POINT3D_STRIDE;
        var data = new Float64Array(T * stride).fill(NaN);
        for (var t1 = 0; t1 < T; t1++) {
            if (at[t1]) gatherGroupInto(at[t1], data, t1 * stride);
        }

        // --- Filter: only the samples the frame's value reads ----------------
        var segments = [{ start: first - lo, end: last + 1 - lo }];
        var c = frameIdx - lo;
        var src = new Float64Array(T);
        var dst = new Float64Array(T);
        var out = new Float64Array(stride);
        for (var s = 0; s < stride; s++) {
            for (var i = 0; i < T; i++) src[i] = data[i * stride + s];
            if (cfg.medianWindow > 0) {
                smoothSignalInto(src, dst, segments, {
                    kernel: 'median', window: cfg.medianWindow, minSegment: cfg.minSegment,
                    from: c - rg, to: c + rg + 1,
                }, scratchV, scratchW);
                src.set(dst);
            }
            if (cfg.gaussianWindow > 0) {
                smoothSignalInto(src, dst, segments, {
                    kernel: 'gaussian', window: cfg.gaussianWindow, minSegment: cfg.minSegment,
                    from: c, to: c + 1,
                }, scratchV, scratchW);
                src.set(dst);
            }
            out[s] = src[c];
        }

        // --- Write back the frame only -----------------------------------------
        var touched = writeGroupFrom(at[c], out, 0);
        if (touched > 0) {
            smoothedFramesOf(session).add(frameIdx);
            result.tracks++;
            result.frames++;
            result.nodes += touched;
        }
    }
    return result;
}

/** Session -> frames a pass smoothed something on (a superset; see `hasSmoothed3d`). */
var _smoothedFrames = new WeakMap();

function smoothedFramesOf(session) {
    var set = _smoothedFrames.get(session);
    if (!set) { set = new Set(); _smoothedFrames.set(session, set); }
    return set;
}

/** Add frames a file read back as smoothed (import-export/smoothing-metadata.js). */
export function noteSmoothedFrames(session, frames) {
    if (!session) return;
    var set = smoothedFramesOf(session);
    for (var fi of frames) set.add(fi);
}

/** Does any group on `frameIdx` hold smoothed 3D (`isPoints3dSmoothed`)? */
function frameHasSmoothed3d(session, frameIdx) {
    var groups = session.instanceGroups.get(frameIdx);
    if (!groups) return false;
    for (var gi = 0; gi < groups.length; gi++) {
        if (groups[gi] && isPoints3dSmoothed(groups[gi].points3d)) return true;
    }
    return false;
}

/**
 * Does any group hold smoothed 3D — on `frameIdx`, or anywhere in the session
 * when it is omitted? Drives the toolbar button's blue state on every redraw,
 * so the session-wide answer walks only the frames a pass wrote, dropping each
 * one found no longer smoothed (re-triangulated, restored, deleted): cheap
 * whether everything is still smoothed (the first frame answers) or nothing is
 * (each stale frame is visited once).
 * @param {Session} session
 * @param {number} [frameIdx]
 * @returns {boolean}
 */
export function hasSmoothed3d(session, frameIdx) {
    if (!session || !session.instanceGroups) return false;
    if (frameIdx != null) return frameHasSmoothed3d(session, frameIdx);
    var set = _smoothedFrames.get(session);
    if (!set) return false;
    for (var fi of set) {
        if (frameHasSmoothed3d(session, fi)) return true;
        set.delete(fi);
    }
    return false;
}

/**
 * Undo the pass: copy each smoothed group's pre-smoothing 3D back in place
 * (`unsmoothedPoints3d`) and drop the mark, so the group is exactly what it was
 * before its first smoothing (and a mark from a file read still applies).
 *
 * @param {Session} session
 * @param {{writeFrames?: Set<number>|null}} [opts] frames to restore; null = all
 * @returns {{frames: number}} groups restored
 */
export function unsmoothSession(session, opts) {
    var writeFrames = (opts && opts.writeFrames) || null;
    var frames = 0;
    if (!session || !session.instanceGroups) return { frames: 0 };
    _removedSmoothing.delete(session);
    // A frame list walks just those frames ("This frame"), not the session.
    var frameIdxs = writeFrames ? writeFrames : session.instanceGroups.keys();
    for (var frameIdx of frameIdxs) {
        var groups = session.instanceGroups.get(frameIdx);
        if (!groups) continue;
        for (var gi = 0; gi < groups.length; gi++) {
            var g = groups[gi];
            var source = g && unsmoothedPoints3d(g.points3d);
            if (!source) continue;
            g.points3d.set(source);
            clearPoints3dSmoothed(g.points3d);
            invalidateReprojections(g);
            g.smoothed = false;
            frames++;
        }
    }
    return { frames: frames };
}

// --------------------------------------------------------------------------
// Remove smoothing / Restore smoothing (the Smooth menu's toggle)
// --------------------------------------------------------------------------

/**
 * Session -> the smoothing Remove smoothing took off, kept so Restore smoothing
 * can put it back without recomputing (`removeSmoothing`). In memory only.
 */
var _removedSmoothing = new WeakMap();

// Scratch for `points3dHash`: one double viewed as two 32-bit words.
var _hashF64 = new Float64Array(1);
var _hashU32 = new Uint32Array(_hashF64.buffer);

/** FNV-1a over the bits of a group's 3D (NaN payloads included). */
function points3dHash(pts) {
    var h = 0x811c9dc5;
    for (var i = 0; i < pts.length; i++) {
        _hashF64[0] = pts[i];
        h = Math.imul(h ^ _hashU32[0], 0x01000193);
        h = Math.imul(h ^ _hashU32[1], 0x01000193);
    }
    return h >>> 0;
}

/** Same values, NaN equal to NaN. */
function sameValues(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
        var x = a[i], y = b[i];
        if (x !== y && (x === x || y === y)) return false;
    }
    return true;
}

/**
 * The smoothing filter's whole input, recorded by Remove smoothing: every
 * group with 3D, in `instanceGroups` order, with its frame, identity and
 * `points3d` array (flat arrays, nothing per group). A smoothed group also
 * keeps its pre-smoothing copy (`sources`), which Remove restores it from and
 * Restore checks it against; any other group keeps a hash of its values.
 * Restore compares this with the session as it then stands: any difference
 * (an edit, a re-solve, a relabel, an added or removed group) means the kept
 * values may no longer be what smoothing would give, because each smoothed
 * value reads its neighbours' frames too.
 */
function smoothingInputPrint(session) {
    var groups = [], pts = [], frames = [], ids = [], sources = [], hashes = [];
    for (var [frameIdx, list] of session.instanceGroups) {
        if (!list) continue;
        for (var gi = 0; gi < list.length; gi++) {
            var g = list[gi];
            if (!g || !g.points3d) continue;
            var src = unsmoothedPoints3d(g.points3d);
            groups.push(g);
            pts.push(g.points3d);
            frames.push(frameIdx);
            ids.push(g.identityId == null ? NO_IDENTITY : g.identityId);
            sources.push(src);
            // Removing smoothing does not change an unsmoothed group.
            hashes.push(src ? 0 : points3dHash(g.points3d));
        }
    }
    return {
        groups: groups, pts: pts, sources: sources,
        frames: Int32Array.from(frames), ids: Int32Array.from(ids), hashes: Uint32Array.from(hashes),
    };
}

/** Is the session's smoothing input still what `print` recorded? */
function inputUnchanged(session, print) {
    var i = 0, n = print.groups.length;
    for (var [frameIdx, list] of session.instanceGroups) {
        if (!list) continue;
        for (var gi = 0; gi < list.length; gi++) {
            var g = list[gi];
            if (!g || !g.points3d) continue;
            if (i >= n || print.groups[i] !== g || print.pts[i] !== g.points3d ||
                print.frames[i] !== frameIdx ||
                print.ids[i] !== (g.identityId == null ? NO_IDENTITY : g.identityId)) return false;
            var src = print.sources[i];
            if (src ? !sameValues(g.points3d, src) : points3dHash(g.points3d) !== print.hashes[i]) return false;
            i++;
        }
    }
    return i === n;
}

function sameSmoothingConfig(a, b) {
    return a.medianWindow === b.medianWindow && a.gaussianWindow === b.gaussianWindow &&
        a.maxGap === b.maxGap && a.minSegment === b.minSegment;
}

/**
 * Remove smoothing, keeping it for `restoreSmoothing`: record the input
 * (`smoothingInputPrint`, which keeps each smoothed group's pre-smoothing
 * copy), copy the smoothed values into ONE buffer (no array per group), then
 * put the pre-smoothing 3D back (`unsmoothSession`).
 *
 * @param {Session} session
 * @param {{config: Object, scope: 'all'|'frame'}} run the run being removed:
 *   its scope (`smoothingRunOf`) and the settings as they are now
 *   (`resolveSmoothingParams`), which Restore compares with its own
 * @returns {{frames: number}} groups restored to their pre-smoothing 3D
 */
export function removeSmoothing(session, run) {
    if (!session || !session.instanceGroups) return { frames: 0 };
    var print = smoothingInputPrint(session);
    var total = 0, i;
    for (i = 0; i < print.groups.length; i++) if (print.sources[i]) total += print.pts[i].length;
    var values = new Float64Array(total);
    var offset = 0;
    for (i = 0; i < print.groups.length; i++) {
        if (!print.sources[i]) continue;
        values.set(print.pts[i], offset);
        offset += print.pts[i].length;
    }
    var stats = unsmoothSession(session);
    if (total > 0 && run && run.config) {
        _removedSmoothing.set(session, { print: print, values: values, run: run });
    }
    return stats;
}

/** Is there removed smoothing that `restoreSmoothing` could put back? */
export function hasRemovedSmoothing(session) {
    return !!session && _removedSmoothing.has(session);
}

/**
 * Put back the smoothing `removeSmoothing` took off, without recomputing it,
 * when nothing it depends on has changed: the settings resolve the same
 * (`params`) and every group's 3D, identity and place is as Remove left it.
 * Otherwise writes nothing and reports `stale`, with the removed run's scope
 * and frames, so the caller can smooth again with the current settings.
 * Either way the kept copy is dropped.
 *
 * @param {Session} session
 * @param {Object} params current smoothing settings
 * @returns {{restored: boolean, stale: boolean, frames: number,
 *   scope?: 'all'|'frame', smoothedFrames?: number[]}}
 */
export function restoreSmoothing(session, params) {
    var kept = session && _removedSmoothing.get(session);
    if (!kept) return { restored: false, stale: false, frames: 0 };
    _removedSmoothing.delete(session);
    var print = kept.print;
    var frameSet = new Set();
    for (var i = 0; i < print.groups.length; i++) if (print.sources[i]) frameSet.add(print.frames[i]);
    var smoothedFrames = Array.from(frameSet).sort(function (a, b) { return a - b; });
    if (!sameSmoothingConfig(resolveSmoothingParams(params), kept.run.config) ||
        !inputUnchanged(session, print)) {
        return { restored: false, stale: true, frames: 0, scope: kept.run.scope, smoothedFrames: smoothedFrames };
    }
    var set = smoothedFramesOf(session);
    var offset = 0, frames = 0;
    for (var k = 0; k < print.groups.length; k++) {
        var source = print.sources[k];
        if (!source) continue;
        var g = print.groups[k], pts = print.pts[k];
        // The kept source still holds exactly what `pts` does (checked above),
        // so it is the pre-smoothing copy again, as before the removal.
        pts.set(kept.values.subarray(offset, offset + pts.length));
        offset += pts.length;
        markPoints3dSmoothed(pts, source);
        invalidateReprojections(g);
        g.smoothed = true;
        set.add(print.frames[k]);
        frames++;
    }
    return { restored: true, stale: false, frames: frames, scope: kept.run.scope, smoothedFrames: smoothedFrames };
}
