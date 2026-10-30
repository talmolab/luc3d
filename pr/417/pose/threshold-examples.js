// pose/threshold-examples.js — the session's own nodes, for the reprojection
// error threshold card in Settings ▸ Default Triangulation
// (ui/threshold-examples-panel.js). DOM-free; Node-tested
// (tests/test-threshold-examples.mjs).
//
// `scanThresholdExamples` solves a sample of the session's frames with the
// threshold off and lists every node at least 3 cameras see, smallest worst
// camera error first. That one number decides a threshold: a node whose worst
// error is over it has a camera dropped, so `firstOverThreshold` counts them.
// `pickRepresentativeExamples` takes a small set from that list, spread evenly on
// a log scale of error, which stays fixed while a threshold is tried.
//
// `solveExample` then runs the threshold's rule on one node, solve by solve, so a
// view can show what each pass did. It solves through `triangulateAndReproject`
// with the same observation mask the solver's own loop applies
// (`includedCameras`, on a one-node view of the group), so it cannot tell a
// different story from a real Triangulate. Nothing here writes to the session.
//
// Depends on: pose/triangulation-core.js (triangulateAndReproject),
// pose/lazy-residency.js (hydrateFrameMembers2d, releaseFrameMembers2d),
// pose/placeholder-cameras.js (isPlaceholderCamera).

import { invert3x3, triangulateAndReproject } from './triangulation-core.js?v=309b7bef753c';
import { hydrateFrameMembers2d, releaseFrameMembers2d } from './lazy-residency.js?v=309b7bef753c';
import { isPlaceholderCamera } from './placeholder-cameras.js?v=309b7bef753c';

/** Frames solved per scan, at most, spread evenly over the recording. */
export const EXAMPLE_MAX_FRAMES = 240;
/** Examples in a representative set, at most. */
export const EXAMPLE_SET_SIZE = 12;
/** Worst errors under this look alike, so a set does not spread itself below it. */
const SET_MIN_ERROR_PX = 1;
/** Fewer cameras than this can only keep a node or lose it, never drop a camera. */
export const EXAMPLE_MIN_CAMERAS = 3;
/** A scan hands the thread back after this long. */
const SCAN_SLICE_MS = 12;

/** The session's calibrated cameras: only these can solve anything. */
export function calibratedCameras(session) {
    return ((session && session.cameras) || []).filter(function (c) {
        return c && c.projectionMatrix && !isPlaceholderCamera(c);
    });
}

/** Up to `max` frames with groups, in order, spread evenly over those frames. */
export function sampleExampleFrames(session, max) {
    var frames = [];
    if (session && session.instanceGroups) {
        session.instanceGroups.forEach(function (groups, frame) {
            if (groups && groups.length) frames.push(frame);
        });
    }
    frames.sort(function (a, b) { return a - b; });
    var limit = max || EXAMPLE_MAX_FRAMES;
    if (frames.length <= limit) return frames;
    var out = [];
    for (var i = 0; i < limit; i++) out.push(frames[Math.floor(i * frames.length / limit)]);
    return out;
}

/** Index of the first example whose worst error is over `threshold`; `examples.length` if none. */
export function firstOverThreshold(examples, threshold) {
    var a = 0, b = examples.length;
    while (a < b) {
        var m = (a + b) >> 1;
        if (examples[m].worst > threshold) b = m; else a = m + 1;
    }
    return a;
}

/**
 * A fixed set from a scan's list: `count` examples spread evenly on a log scale of
 * worst error, from the smallest to the largest, so every part of the slider has
 * nodes it acts on. An even spread by count would be nearly all small errors. Near each
 * step it prefers a body part and a frame it has not used yet.
 *
 * @param {Object[]} examples  smallest worst error first
 * @param {number} [count]
 * @returns {Object[]} smallest worst error first, none twice
 */
export function pickRepresentativeExamples(examples, count) {
    var n = count || EXAMPLE_SET_SIZE;
    if (examples.length <= n) return examples.slice();
    var lo = Math.log(Math.max(SET_MIN_ERROR_PX, examples[0].worst));
    var hi = Math.log(Math.max(SET_MIN_ERROR_PX, examples[examples.length - 1].worst));
    var used = new Set(), nodes = new Map(), frames = new Map();
    var logOf = function (e) { return Math.log(Math.max(SET_MIN_ERROR_PX, e.worst)); };
    var bump = function (m, k) { m.set(k, (m.get(k) || 0) + 1); };
    var window = Math.max(0.1, (hi - lo) / (n - 1) / 3);
    for (var i = n - 1; i >= 0; i--) {
        var target = lo + (hi - lo) * i / (n - 1);
        var best = -1, bestScore = Infinity;
        for (var j = 0; j < examples.length; j++) {
            if (used.has(j)) continue;
            var off = Math.abs(logOf(examples[j]) - target);
            // Out of the step's window, distance decides; inside it, what has been shown first.
            var score = off > window ? 1000 + off
                : (nodes.get(examples[j].node) || 0) * 2 + (frames.get(examples[j].frame) || 0) * 2 + off / window;
            if (score < bestScore) { bestScore = score; best = j; }
        }
        used.add(best);
        bump(nodes, examples[best].node);
        bump(frames, examples[best].frame);
    }
    return Array.from(used).sort(function (a, b) { return a - b; }).map(function (j) { return examples[j]; });
}

function bracketFrame(session, frame, read) {
    var hydrated = hydrateFrameMembers2d(session, frame) > 0;
    try {
        return read();
    } finally {
        if (hydrated) releaseFrameMembers2d(session, frame);
    }
}

function scanFrame(session, frame, cameras, included, method, out) {
    bracketFrame(session, frame, function () {
        (session.instanceGroups.get(frame) || []).forEach(function (group, groupIdx) {
            var result = triangulateAndReproject(group, cameras,
                { method: method, reprojErrorThreshold: 0, includedCameras: included });
            var worst = [], worstCam = [], seen = [];
            included.forEach(function (name) {
                var errs = result.errors[name];
                if (!errs) return;
                for (var k = 0; k < errs.length; k++) {
                    var e = errs[k];
                    if (e == null || !isFinite(e)) continue;
                    seen[k] = (seen[k] || 0) + 1;
                    if (!(worst[k] >= e)) { worst[k] = e; worstCam[k] = name; }
                }
            });
            for (var k = 0; k < worst.length; k++) {
                if (seen[k] >= EXAMPLE_MIN_CAMERAS) {
                    out.push({ frame: frame, group: groupIdx, node: k, worst: worst[k], worstCamera: worstCam[k] });
                }
            }
        });
    });
}

/**
 * Solve a sample of the session with the threshold off, a slice per task.
 *
 * @param {Object} session
 * @param {Object} opts
 * @param {'dlt'|'ba'} opts.method
 * @param {string[]} [opts.included]  cameras that may contribute (default: all calibrated)
 * @param {number} [opts.maxFrames]
 * @param {function(number, number): void} [opts.onProgress]  (frames done, frames)
 * @param {function(): boolean} [opts.isCancelled]
 * @returns {Promise<?{examples: Object[], frames: number}>} smallest worst error
 *   first; null if cancelled. An example: `{ frame, group, node, worst, worstCamera }`.
 */
export async function scanThresholdExamples(session, opts) {
    var cameras = calibratedCameras(session);
    var included = opts.included || cameras.map(function (c) { return c.name; });
    var frames = sampleExampleFrames(session, opts.maxFrames);
    var examples = [];
    var cancelled = opts.isCancelled || function () { return false; };
    if (cameras.length >= EXAMPLE_MIN_CAMERAS) {
        var sliceStart = Date.now();
        for (var i = 0; i < frames.length; i++) {
            if (cancelled()) return null;
            scanFrame(session, frames[i], cameras, included, opts.method, examples);
            if (Date.now() - sliceStart >= SCAN_SLICE_MS) {
                if (opts.onProgress) opts.onProgress(i + 1, frames.length);
                await new Promise(function (r) { setTimeout(r, 0); });
                sliceStart = Date.now();
            }
        }
    }
    if (cancelled()) return null;
    examples.sort(function (a, b) { return a.worst - b.worst; });
    return { examples: examples, frames: frames.length };
}

// The group as the solver reads it, holding one node: the same 2D, the same
// mask, a solve that costs one node.
function oneNodeView(group, k) {
    var views = new Map();
    group.instances.forEach(function (inst, cam) {
        var on = !!inst && inst.hasPoint(k) && !(inst.nulledNodes && inst.nulledNodes.has(k));
        views.set(cam, {
            numNodes: 1,
            nulledNodes: null,
            hasPoint: function () { return on; },
            getPoint: function () { return inst.getPoint(k); },
        });
    });
    return { getInstance: function (cam) { return views.get(cam) || null; } };
}

function isOver(error, threshold) { return threshold > 0 && error > threshold; }

/**
 * Which cameras an example shows when only `slots` fit: the largest errors of a solve
 * with every camera, so the cameras a threshold acts on first are the ones in view. A
 * camera with no error (no prediction, or not contributing) comes last. Pass the same
 * solve whatever is being tried, so the choice holds still.
 *
 * @param {Object} baseline  `solveExample`'s result with the threshold off
 * @param {string[]} names  every camera, in the session's order
 * @param {number} slots
 * @returns {{shown: string[], first: ?string, others: string[]}} `shown` and `others`
 *   in the session's order, so a camera keeps its place from one example to the
 *   next where it can; `first` is the one that ranks highest.
 */
export function pickShownCameras(baseline, names, slots) {
    var errors = baseline.passes[0] ? baseline.passes[0].errors : {};
    var rank = function (name) {
        return baseline.predictions.get(name) && errors[name] != null ? errors[name] : -1;
    };
    var ranked = names.slice().sort(function (a, b) {
        return rank(b) - rank(a) || names.indexOf(a) - names.indexOf(b);
    });
    var keep = ranked.slice(0, slots);
    return {
        shown: names.filter(function (n) { return keep.indexOf(n) >= 0; }),
        first: keep.length ? keep[0] : null,
        others: names.filter(function (n) { return keep.indexOf(n) < 0; }),
    };
}

/**
 * A prediction's line of sight in the world: the camera's centre, and the unit
 * direction through the prediction (undistorted, as the solver reads it).
 * @param {Object} camera
 * @param {number[]} prediction  [x, y] in the camera's native pixels
 * @returns {?{origin: number[], dir: number[]}} null for a camera with no usable matrix
 */
export function lineOfSight(camera, prediction) {
    var P = camera.projectionMatrix;
    var inv = invert3x3([[P[0][0], P[0][1], P[0][2]], [P[1][0], P[1][1], P[1][2]], [P[2][0], P[2][1], P[2][2]]]);
    if (!inv) return null;
    var uv = camera.undistortPoint ? camera.undistortPoint(prediction) : prediction;
    var apply = function (v) {
        return [0, 1, 2].map(function (r) { return inv[r][0] * v[0] + inv[r][1] * v[1] + inv[r][2] * v[2]; });
    };
    var origin = apply([-P[0][3], -P[1][3], -P[2][3]]);
    var d = apply([uv[0], uv[1], 1]);
    var len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 0)) return null;
    return { origin: origin, dir: [d[0] / len, d[1] / len, d[2] / len] };
}

/**
 * What a 3D view should frame: the middle of a flat [x,y,z,...] list's solved points,
 * and how far the furthest of them is.
 * @param {ArrayLike<number>} flat
 * @returns {?{centre: number[], radius: number}} null with no solved point
 */
export function frameFromPoints(flat) {
    var axes = [[], [], []];
    for (var i = 0; i + 2 < flat.length; i += 3) {
        if (isFinite(flat[i]) && isFinite(flat[i + 1]) && isFinite(flat[i + 2])) {
            for (var a = 0; a < 3; a++) axes[a].push(flat[i + a]);
        }
    }
    if (!axes[0].length) return null;
    var centre = axes.map(function (v) { v.sort(function (p, q) { return p - q; }); return v[v.length >> 1]; });
    var radius = 0;
    for (var j = 0; j + 2 < flat.length; j += 3) {
        if (isFinite(flat[j]) && isFinite(flat[j + 1]) && isFinite(flat[j + 2])) {
            radius = Math.max(radius, Math.hypot(flat[j] - centre[0], flat[j + 1] - centre[1], flat[j + 2] - centre[2]));
        }
    }
    return { centre: centre, radius: Math.max(radius, 1) };
}

/**
 * Every animal in an example's frame, as a real Triangulate would leave it at this
 * threshold: objects a 3D view can draw, with `source` the real group.
 * @param {Object} session
 * @param {number} frame
 * @param {{method: string, threshold: number, included?: string[]}} opts
 * @returns {Array<{points3d: Float64Array, identityId: number, source: Object}>}
 */
export function solveFrame3d(session, frame, opts) {
    var cameras = calibratedCameras(session);
    var included = opts.included || cameras.map(function (c) { return c.name; });
    var method = opts.method;
    return bracketFrame(session, frame, function () {
        return (session.instanceGroups.get(frame) || []).map(function (group) {
            return {
                points3d: triangulateAndReproject(group, cameras, {
                    method: method, reprojErrorThreshold: opts.threshold, includedCameras: included, triangulateOnly: true,
                }).points3d,
                identityId: group.identityId,
                source: group,
            };
        });
    });
}

/**
 * The whole animal's 3D as a real Triangulate would leave it at this threshold.
 * @param {Object} session
 * @param {{frame: number, group: number}} example
 * @param {{method: string, threshold: number, included?: string[]}} opts
 * @returns {?Float64Array} flat [x,y,z] per node, NaN where a node has none
 */
export function solveExample3d(session, example, opts) {
    var cameras = calibratedCameras(session);
    var included = opts.included || cameras.map(function (c) { return c.name; });
    var method = opts.method;
    return bracketFrame(session, example.frame, function () {
        var group = (session.instanceGroups.get(example.frame) || [])[example.group];
        if (!group) return null;
        return triangulateAndReproject(group, cameras, {
            method: method, reprojErrorThreshold: opts.threshold, includedCameras: included, triangulateOnly: true,
        }).points3d;
    });
}

/**
 * Run the threshold's rule on one example: after each solve, while more than two
 * cameras are left, drop only the worst camera over the threshold and solve again;
 * if the last cameras are still over, the node has no 3D.
 *
 * @param {Object} session
 * @param {{frame: number, group: number, node: number}} example
 * @param {Object} opts
 * @param {'dlt'|'ba'} opts.method
 * @param {number} opts.threshold  0 = off
 * @param {string[]} [opts.included]
 * @returns {?{
 *   skeletons: Map<string, Array>, nulled: Map<string, ?Set<number>>, predictions: Map<string, ?number[]>,
 *   passes: Array<{cameras: string[], errors: Object, reprojections: Object, drop: ?string}>,
 *   dropped: string[], lost: boolean, identityId: number
 * }} null if the example's group is gone. `skeletons` holds every node's 2D per
 *   camera, copied, so a lazy frame's members can go back to the store.
 */
export function solveExample(session, example, opts) {
    var cameras = calibratedCameras(session);
    var included = opts.included || cameras.map(function (c) { return c.name; });
    var method = opts.method;
    return bracketFrame(session, example.frame, function () {
        var group = (session.instanceGroups.get(example.frame) || [])[example.group];
        if (!group) return null;
        var k = example.node;
        var view = oneNodeView(group, k);
        var skeletons = new Map(), nulled = new Map(), predictions = new Map();
        group.instances.forEach(function (inst, cam) {
            var pts = [];
            for (var n = 0; inst && n < inst.numNodes; n++) {
                var p = inst.hasPoint(n) ? inst.getPoint(n) : null;
                pts.push(p ? [p[0], p[1]] : null);
            }
            skeletons.set(cam, pts);
            nulled.set(cam, inst && inst.nulledNodes && inst.nulledNodes.size ? new Set(inst.nulledNodes) : null);
            var mine = view.getInstance(cam);
            predictions.set(cam, mine.hasPoint() ? pts[k] : null);
        });
        var kept = included.filter(function (name) { return predictions.get(name); });
        var passes = [], dropped = [], lost = false;
        for (var guard = 0; guard <= cameras.length; guard++) {
            var result = triangulateAndReproject(view, cameras,
                { method: method, reprojErrorThreshold: 0, includedCameras: kept });
            var errors = {}, reprojections = {};
            cameras.forEach(function (c) {
                var err = result.errors[c.name] ? result.errors[c.name][0] : null;
                var rep = result.reprojections[c.name] ? result.reprojections[c.name][0] : null;
                errors[c.name] = err == null ? null : err;
                reprojections[c.name] = rep ? [rep[0], rep[1]] : null;
            });
            var pass = { cameras: kept.slice(), errors: errors, reprojections: reprojections, drop: null };
            passes.push(pass);
            var solved = kept.some(function (name) { return errors[name] != null; });
            if (!solved) { lost = true; break; }
            var worst = null;
            kept.forEach(function (name) {
                if (errors[name] != null && isOver(errors[name], opts.threshold)
                    && (worst === null || errors[name] > errors[worst])) worst = name;
            });
            if (worst === null) break;
            if (kept.length <= 2) { lost = true; break; }
            pass.drop = worst;
            dropped.push(worst);
            kept = kept.filter(function (name) { return name !== worst; });
        }
        return {
            skeletons: skeletons, nulled: nulled, predictions: predictions, passes: passes,
            dropped: dropped, lost: lost, identityId: group.identityId,
        };
    });
}
