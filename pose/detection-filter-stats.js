// pose/detection-filter-stats.js — what the tracker's detection filters would
// remove, counted BEFORE anyone runs tracking.
//
// The Tracking Wizard's two detection filters (`filterMinVisibleNodes`,
// `filterMinInstanceScore`) drop detections before cross-view matching, and the
// tracker never says how many. They also do not hit every camera alike: on a
// real 3-camera rig a low side camera's detections scored far below the other
// two (median mean point score 0.64 vs well above 0.75), so a threshold that
// is harmless for two cameras silently empties the third. This module counts,
// per camera and in total, how many detections each filter removes at a given
// value, so the wizard can show it while the value is being chosen.
//
// Two halves, so a keystroke costs a pass over typed arrays and nothing else:
//
// - `collectDetectionStats(session)` walks the session ONCE and records, per
//   detection, its camera, its present-keypoint count, its instance score and
//   its mean per-point confidence (sleap-nn's "mean node score"), in flat
//   typed arrays.
// - `countDetectionFilters(stats, values)` counts failures at given values.
//   O(detections), allocation-free apart from the result.
//
// **The predicate is the tracker's, not a copy of it.** `passesDetectionFilter`
// lives here and `pose/tracker.js` imports it, and the counter applies the
// same two primitives (`failsMinVisibleNodes`, `failsMinInstanceScore`) to the
// recorded values, so the readout and a run cannot disagree about what a
// threshold does.
//
// **The population is the WHOLE session**, never `frameGroups` alone on a lazy
// project (a resident window — see `pose/skeleton-edit-impact.js`). A lazy
// session's resident frames are read from memory (they may carry edits); every
// other frame straight from the columnar store, with the values hydration would
// give it (`adaptTypedInstance` + `new Instance(.., d.score || 0)`): a store
// prediction's score is `score || 0`, a store user instance's is 0, and a
// keypoint is present when its x and y are finite.
//
// **Missing scores are reported, not counted as 0%.** Every eager loader turns
// an absent instance score into 0, and the tracker then drops that detection at
// any minimum above 0. So "no instance scores" is a property the readout must
// state — `predictedWithScore === 0` — rather than a column of numbers that
// look like a verdict. Per-point confidence has no filter in LUCID; it is
// recorded so the wizard can show its distribution and preview a threshold.

/** Does a detection with `visible` present keypoints fail a minimum of `min`? */
export function failsMinVisibleNodes(visible, min) {
    return min > 0 && visible < min;
}

/**
 * Does a detection scoring `score` fail a minimum instance score of `min`?
 * A detection with no score (null, undefined or NaN) is never filtered — the
 * tracker's rule since the filter was added.
 */
export function failsMinInstanceScore(score, min) {
    return min > 0 && score != null && score < min;
}

/**
 * The tracker's detection-pool gate (pose/tracker.js `buildTrackerDetections`
 * and friends). Both minima default to 0, which is a no-op.
 * @param {Object} inst - an `Instance`
 * @param {number} minVis
 * @param {number} minScore
 * @returns {boolean}
 */
export function passesDetectionFilter(inst, minVis, minScore) {
    if (minVis > 0 && failsMinVisibleNodes(inst.countPoints(), minVis)) return false;
    if (failsMinInstanceScore(inst.score, minScore)) return false;
    return true;
}

// Growable column set; `finish` trims every column to `n`.
function makeSink(cameraNames) {
    var cap = 1024;
    var s = {
        n: 0,
        cam: new Uint16Array(cap),
        visible: new Uint16Array(cap),
        score: new Float64Array(cap),   // f64: a stored 0.9 must still pass a minimum of 0.9
        meanPointScore: new Float64Array(cap),
        predicted: new Uint8Array(cap),
    };
    s.push = function (camIdx, visible, score, mps, predicted) {
        if (s.n === cap) {
            cap *= 2;
            var grow = function (a) { var b = new a.constructor(cap); b.set(a); return b; };
            s.cam = grow(s.cam); s.visible = grow(s.visible); s.score = grow(s.score);
            s.meanPointScore = grow(s.meanPointScore); s.predicted = grow(s.predicted);
        }
        var i = s.n++;
        s.cam[i] = camIdx;
        s.visible[i] = visible > 65535 ? 65535 : visible;
        s.score[i] = score == null ? NaN : score;
        s.meanPointScore[i] = mps;
        s.predicted[i] = predicted ? 1 : 0;
    };
    s.cameras = cameraNames.slice();
    return s;
}

function finishSink(s) {
    var n = s.n;
    var perCam = s.cameras.map(function (name) {
        return { name: name, detections: 0, predicted: 0, predictedWithScore: 0, withPointScores: 0 };
    });
    for (var i = 0; i < n; i++) {
        var pc = perCam[s.cam[i]];
        pc.detections++;
        if (s.predicted[i]) {
            pc.predicted++;
            // A score of exactly 0 is what every loader writes for an ABSENT
            // score, so only a positive one proves the file carries them.
            if (s.score[i] > 0) pc.predictedWithScore++;
            if (s.meanPointScore[i] === s.meanPointScore[i]) pc.withPointScores++;
        }
    }
    var tot = { detections: 0, predicted: 0, predictedWithScore: 0, withPointScores: 0 };
    perCam.forEach(function (pc) {
        tot.detections += pc.detections; tot.predicted += pc.predicted;
        tot.predictedWithScore += pc.predictedWithScore; tot.withPointScores += pc.withPointScores;
    });
    return {
        n: n,
        cameras: s.cameras,
        cam: s.cam.subarray(0, n),
        visible: s.visible.subarray(0, n),
        score: s.score.subarray(0, n),
        meanPointScore: s.meanPointScore.subarray(0, n),
        predicted: s.predicted.subarray(0, n),
        perCamera: perCam,
        totals: tot,
        hasInstanceScores: tot.predictedWithScore > 0,
        hasPointScores: tot.withPointScores > 0,
    };
}

// Mean model confidence of an in-memory instance, as sleap-nn computes it for
// `filter_min_mean_node_score`: over ALL the skeleton's nodes, a missing node
// counting as 0 (averaging the present nodes only put 36.7% of the real
// stressTest sideC rerun below 0.75 instead of sleap-nn's 43.8%). That is
// sleap-nn 0.3 (0.3.3 measured, the live rig's version); 0.2.0 averaged the
// present nodes only — its filtered files bottom out at exactly 0.75 on that
// definition — so on a 0.2 file this reads lower than what it filtered on. NaN when it
// carries no scores at all. Only a prediction's scores mean anything
// (`Session.predictedNodeScore` says the same).
function instanceMeanPointScore(session, camName, frameIdx, inst) {
    if (!inst || inst.type !== 'predicted') return NaN;
    var n = inst.numNodes, sum = 0, cnt = 0;
    var eager = typeof inst.hasPointScores === 'function' && inst.hasPointScores();
    if (!eager && !(session && session.lazyLoader && Number.isInteger(inst._rawInstIndex))) return NaN;
    for (var k = 0; k < n; k++) {
        if (!inst.hasPoint(k)) continue;
        var v = eager ? inst.pointScore(k) : session.predictedNodeScore(camName, frameIdx, inst, k);
        if (v === v) { sum += v; cnt++; }
    }
    return cnt && n ? sum / n : NaN;
}

function pushInstance(sink, ci, session, camName, frameIdx, inst) {
    if (!inst) return;
    sink.push(ci, inst.countPoints(), inst.score,
        instanceMeanPointScore(session, camName, frameIdx, inst), inst.type === 'predicted');
}

// Every in-memory detection of one camera: what `buildTrackerDetections` sees
// for each resident frame (group members + the unlinked pool, disjoint).
function collectResident(sink, ci, session, camName) {
    if (!session.frameGroups) return;
    for (var entry of session.frameGroups) {
        var frameIdx = entry[0], fg = entry[1];
        if (!fg) continue;
        var linked = fg.getInstances(camName);
        for (var i = 0; i < linked.length; i++) pushInstance(sink, ci, session, camName, frameIdx, linked[i]);
        var unlinked = fg.getUnlinkedInstances(camName);
        for (var j = 0; j < unlinked.length; j++) {
            pushInstance(sink, ci, session, camName, frameIdx, unlinked[j] && unlinked[j].instance);
        }
    }
}

// One camera's NON-resident frames, read from the lazy store's columns with the
// values hydration would produce (see the header). A camera the loader does
// not back has no store rows.
function collectStore(sink, ci, session, camName) {
    var loader = session.lazyLoader;
    var labels = loader.labelsByCam && loader.labelsByCam.get(camName);
    var store = labels && labels._lazyDataStore;
    if (!store) return;
    var idn = store.instancesData || {};
    var pts = store.pointsData || {};
    var pred = store.predPointsData || {};
    var numNodes = (loader.numNodesByCam && loader.numNodesByCam.get(camName)) ||
        (session.skeleton && session.skeleton.nodes ? session.skeleton.nodes.length : 0);
    var resident = session.frameGroups;
    loader.forEachInstanceRow(function (cn, frameIdx, trk, info) {
        if (resident && resident.has(frameIdx)) return;
        var j = info.instanceRow;
        var isPred = Number(idn.instance_type ? idn.instance_type[j] : 0) !== 0;
        var cols = isPred ? pred : pts;
        var xs = cols.x, ys = cols.y, sc = isPred ? cols.score : null;
        var p0 = Number(idn.point_id_start ? idn.point_id_start[j] : 0) || 0;
        var p1 = Number(idn.point_id_end ? idn.point_id_end[j] : 0) || 0;
        var m = Math.min(p1 - p0, numNodes);
        var vis = 0, sum = 0, cnt = 0;
        for (var k = 0; k < m; k++) {
            var x = xs ? Number(xs[p0 + k]) : NaN, y = ys ? Number(ys[p0 + k]) : NaN;
            if (!isFinite(x) || !isFinite(y)) continue;
            vis++;
            if (sc) { var v = Number(sc[p0 + k]); if (isFinite(v)) { sum += v; cnt++; } }
        }
        var score = isPred ? (Number(idn.score ? idn.score[j] : 0) || 0) : 0;
        // Mean over ALL nodes, a missing one counting as 0 — see instanceMeanPointScore.
        sink.push(ci, vis, score, cnt && numNodes ? sum / numNodes : NaN, isPred);
    }, { camera: camName });
}

function sessionCameraNames(session) {
    return (session && Array.isArray(session.cameras)) ? session.cameras.map(function (c) { return c.name; }) : [];
}

function collectCamera(sink, ci, session) {
    var camName = sink.cameras[ci];
    var loader = session.lazyLoader;
    // A lazy camera's store rows first (they skip resident frames), then the
    // resident frames from memory — which is every frame on an eager session.
    if (loader && typeof loader.forEachInstanceRow === 'function') collectStore(sink, ci, session, camName);
    collectResident(sink, ci, session, camName);
}

/**
 * Record every detection of `session` once (synchronous).
 * @param {Object} session
 * @returns {Object} stats — see `countDetectionFilters`
 */
export function collectDetectionStats(session) {
    var sink = makeSink(sessionCameraNames(session));
    if (session) for (var ci = 0; ci < sink.cameras.length; ci++) collectCamera(sink, ci, session);
    return finishSink(sink);
}

/**
 * The same, one camera per task, so a large project never blocks the page for
 * longer than one camera's walk. `isCancelled()` stops it early (returns null).
 * @param {Object} session
 * @param {{isCancelled?: () => boolean}} [opts]
 * @returns {Promise<Object|null>}
 */
export async function collectDetectionStatsAsync(session, opts) {
    var cancelled = (opts && opts.isCancelled) || function () { return false; };
    var sink = makeSink(sessionCameraNames(session));
    for (var ci = 0; ci < sink.cameras.length; ci++) {
        await new Promise(function (r) { setTimeout(r, 0); });
        if (cancelled()) return null;
        collectCamera(sink, ci, session);
    }
    if (cancelled()) return null;
    return finishSink(sink);
}

/**
 * Count, per camera and over the cameras `included` (default: all), how many
 * detections fail each filter at the given values.
 *
 * `minVisibleNodes` and `minInstanceScore` are the tracker's filters: `removed`
 * is the detections failing either, `failsBoth` those failing both.
 * `minMeanPointScore` is a PREVIEW only — LUCID has no such filter — and is
 * counted on its own (`failMeanPointScore`), over the detections that carry
 * point scores; it never enters `removed`.
 *
 * @param {Object} stats - from `collectDetectionStats`
 * @param {{minVisibleNodes?: number, minInstanceScore?: number, minMeanPointScore?: number}} values
 * @param {(cameraName: string) => boolean} [included]
 * @returns {{perCamera: Array, total: Object}}
 */
export function countDetectionFilters(stats, values, included) {
    var v = values || {};
    var minVis = Number(v.minVisibleNodes) || 0;
    var minScore = Number(v.minInstanceScore) || 0;
    var minMps = Number(v.minMeanPointScore) || 0;
    var cams = stats ? stats.cameras : [];
    var rows = cams.map(function (name, i) {
        var pc = stats.perCamera[i];
        return {
            name: name,
            included: !included || !!included(name),
            detections: pc.detections, predicted: pc.predicted,
            predictedWithScore: pc.predictedWithScore, withPointScores: pc.withPointScores,
            failVisible: 0, failScore: 0, removed: 0, failsBoth: 0, failMeanPointScore: 0,
        };
    });
    if (stats) {
        var cam = stats.cam, vis = stats.visible, sc = stats.score, mps = stats.meanPointScore;
        for (var i = 0; i < stats.n; i++) {
            var r = rows[cam[i]];
            var a = failsMinVisibleNodes(vis[i], minVis);
            var b = failsMinInstanceScore(sc[i] === sc[i] ? sc[i] : null, minScore);
            if (a) r.failVisible++;
            if (b) r.failScore++;
            if (a || b) r.removed++;
            if (a && b) r.failsBoth++;
            if (minMps > 0 && mps[i] < minMps) r.failMeanPointScore++;   // NaN < x is false
        }
    }
    var total = {
        name: 'All', detections: 0, predicted: 0, predictedWithScore: 0, withPointScores: 0,
        failVisible: 0, failScore: 0, removed: 0, failsBoth: 0, failMeanPointScore: 0,
    };
    rows.forEach(function (r) {
        if (!r.included) return;
        for (var key in total) if (key !== 'name') total[key] += r[key];
    });
    return { perCamera: rows, total: total };
}

/** A camera is flagged when it loses at least this much more than the others… */
export const OUTLIER_MIN_EXCESS = 0.05;
/** …and at least this many times their median share. */
export const OUTLIER_MIN_RATIO = 2;

/**
 * The cameras that lose MUCH more than the rest — what the total row hides.
 *
 * On the real HardFight session (sideC unfiltered), the filters at the values
 * used at inference removed 13.7% of sideC's detections and 0% of each of the
 * other seven, and the total read 0.6%. So a camera is compared with the
 * MEDIAN share of the other tracked cameras, never with the total (which it
 * is part of), and flagged when it is both at least `OUTLIER_MIN_EXCESS`
 * (5 percentage points) above that median — so 0.4% against 0.1% is not news
 * — and at least `OUTLIER_MIN_RATIO` times it — so when every camera loses a
 * lot, none is singled out. Needs two tracked cameras with detections;
 * excluded cameras are neither flagged nor part of anyone's comparison.
 *
 * @param {Array} rows - `countDetectionFilters(...).perCamera`
 * @param {string} partKey - e.g. 'removed' or 'failMeanPointScore'
 * @param {string} [wholeKey='detections'] - the share's denominator
 * @returns {Array<{name: string, share: number, othersMedian: number}>}
 */
export function flagOutlierCameras(rows, partKey, wholeKey) {
    var wk = wholeKey || 'detections';
    var live = (rows || []).filter(function (r) { return r.included !== false && r[wk] > 0; });
    if (live.length < 2) return [];
    var shares = live.map(function (r) { return r[partKey] / r[wk]; });
    var out = [];
    for (var i = 0; i < live.length; i++) {
        var others = shares.filter(function (_, j) { return j !== i; }).sort(function (a, b) { return a - b; });
        var mid = others.length >> 1;
        var med = others.length % 2 ? others[mid] : (others[mid - 1] + others[mid]) / 2;
        if (shares[i] - med >= OUTLIER_MIN_EXCESS - 1e-12 && shares[i] >= OUTLIER_MIN_RATIO * med) {
            out.push({ name: live[i].name, share: shares[i], othersMedian: med });
        }
    }
    return out;
}

/**
 * Distribution of mean per-point confidence, per camera: `bins` equal-width
 * bins over [0, 1] (a value above 1 lands in the last), plus the median.
 * Detections without point scores are left out.
 * @param {Object} stats
 * @param {number} [bins=10]
 * @returns {Array<{name: string, count: number, median: number, bins: Uint32Array}>}
 */
export function meanPointScoreHistograms(stats, bins) {
    var nb = bins > 0 ? bins | 0 : 10;
    if (!stats) return [];
    var vals = stats.cameras.map(function () { return []; });
    for (var i = 0; i < stats.n; i++) {
        var m = stats.meanPointScore[i];
        if (m === m) vals[stats.cam[i]].push(m);
    }
    return stats.cameras.map(function (name, ci) {
        var list = vals[ci], h = new Uint32Array(nb);
        for (var j = 0; j < list.length; j++) {
            var b = Math.floor(list[j] * nb);
            h[b < 0 ? 0 : (b >= nb ? nb - 1 : b)]++;
        }
        var median = NaN;
        if (list.length) {
            var sorted = Float64Array.from(list).sort();
            var mid = sorted.length >> 1;
            median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        }
        return { name: name, count: list.length, median: median, bins: h };
    });
}
