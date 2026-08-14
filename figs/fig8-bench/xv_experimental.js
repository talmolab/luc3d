/**
 * xv_experimental.js — EXPERIMENTAL fork of pose/cross-view-tracker.js for Fig 8's
 * method search. Served in place of the real module by figs/fig8-bench/hooks8.mjs.
 * The shipped file is READ, never written; nothing here can reach the app.
 *
 *      WITH NO FLAGS SET, THIS FILE MUST BEHAVE EXACTLY LIKE THE SHIPPED TRACKER.
 *
 * Every addition is gated behind `globalThis.__BENCH.method`, and the empty-config
 * path is the shipped code verbatim. `figs/fig8_methods.py --verify` asserts that at
 * the level of a SHA-256 over the tracker's entire identities+frames payload on all
 * 8 full sessions, so "the harness is honest" is measured, not asserted.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BEING FIXED
 * ---------------------------------------------------------------------------
 * `figs/fig8_diag_loss.py` decomposes the shipped tracker's cross-view IDF1 loss on
 * the same 8 BMimica sessions. Two facts set the whole agenda:
 *
 *   1. Coverage is NOT the problem. 99.4% of detections with a bbox get an identity,
 *      and the perfect-identity ceiling at today's coverage is 0.937 against an as-is
 *      0.735 — so 98.6% of the recoverable loss is identity error, not missed output.
 *   2. The identity error is a handful of PERMANENT swaps, not many switches. Only
 *      324 switches occur across 7,205,370 camera-frames, yet IDF1 is 0.735: on the
 *      leading 20,000 frames of each session IDF1 is 0.935, and it decays from there.
 *      20250904_131913 loses 0.311 IDF1 to TEN switches. A swap costs every frame
 *      after it because nothing in the tracker can undo one.
 *
 * That splits the problem in two, and the split is not a matter of taste:
 *
 *   PREVENTION. After a swap, both targets are perfectly consistent with their
 *   (swapped) detections, so no geometric term can detect it. Geometry can only act
 *   BEFORE the swap. Methods M1/M2/M2'/M4/M5/M6 are all prevention.
 *
 *   RECOVERY. Conversely, geometry ALONE can never repair a swap that happened, for
 *   the same reason. Recovery requires a feature attached to the ANIMAL rather than
 *   to the trajectory. That is what M3/M3' were for.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE MEASUREMENTS DID TO THE HYPOTHESES — read this before adding a method
 * ---------------------------------------------------------------------------
 * Three of the initial premises turned out to be WRONG, each refuted by a measurement
 * rather than by argument, and the refutations are more useful than the methods:
 *
 *   "The swap is a within-frame cascade." Partly. `_trackView` really does run one
 *   Hungarian PER CAMERA and re-triangulate on each match, so camera 1's assignment
 *   moves the state camera 2 is judged against (Gauss-Seidel where Jacobi was wanted).
 *   M1 `sync` removes that and is worth +0.027 IDF1 and -28 switches — real, but small,
 *   and its pooled gain is carried by ONE session of eight.
 *
 *   "The swap is a cross-view-inconsistent labelling." NO. M2' `xvRefine` offers every
 *   view's detection to a different target and keeps the exchange whenever total
 *   triangulation residual falls; it accepted 0 and 5 exchanges out of ~170,000 tests
 *   on two sessions. The shipped per-view association is ALREADY cross-view consistent:
 *   when a swap happens all five views swap TOGETHER and the triangulation stays tight.
 *   This also explains M2 `bundle`, which grouped detections across views by epipolar
 *   error first: it was 70x WORSE (22,882 switches against 324), because pairwise
 *   epipolar error is a far weaker cue than agreement with a 5-view 3D state, so the
 *   grouping flickered and took the identities with it.
 *
 *   "A skeletal descriptor can re-identify the animals." NO, not on this corpus. With
 *   the prototype frozen — the only version that could survive a swap — P(a target's
 *   prototype is closer to its own animal than to the other) is 0.40-0.57 across 8
 *   full sessions, i.e. chance. An earlier reading of 0.908 was an ARTEFACT of a live
 *   EMA prototype: at reidEma 0.01 the prototype is roughly "this target 100 frames
 *   ago", so it was measuring the descriptor's autocorrelation, not identity. Averaging
 *   does cut the noise (per-frame 5-11 mm, block means 1.5-2.4 mm), but the
 *   between-animal difference is only ~2 mm on most sessions: separable in 2 of 8
 *   pairings, chance in the rest. These are same-strain mice of similar size.
 *
 * Two other candidate signals are ruled out without new code. Per-camera trackIdx
 * continuity is worthless here — Fig 3's tracker comparison puts SLEAP's own per-camera
 * tracker at within-view IDF1 0.115 on BMimica. And there are no PIXELS to embed: the
 * detection pool is `{cam}_predictions.h5` holding a `tracks` dataset of keypoints and
 * nothing else, so a real appearance re-id model has no input on this measurement.
 *
 * ---------------------------------------------------------------------------
 * THE METHODS (all default-off; `method` keys in the --params JSON)
 * ---------------------------------------------------------------------------
 * M1 `sync` (bool) — SYNCHRONOUS (frozen-state) MULTI-VIEW ASSOCIATION.
 *      Snapshot every target's 3D at frame start and score all views against that
 *      snapshot, then re-triangulate once at the end of the frame. Exactly the
 *      Jacobi-vs-Gauss-Seidel distinction: the shipped tracker updates in place
 *      mid-frame (Gauss-Seidel) so errors propagate within a frame; this does not.
 *      One-line-per-view change, no new cost terms, no new parameters.
 *
 * M2 `bundle` (bool) — CROSS-VIEW DETECTION CLUSTERING + ONE GLOBAL 3D ASSIGNMENT.
 *      The stronger form of the same idea, and the standard modern multi-view MOT
 *      shape (cluster detections across views into 3D observations first, associate
 *      tracks to observations second). Per frame: pick the view with the most
 *      detections as reference, epipolar-match every other view's detections to it
 *      (Hungarian per view pair on `epipolarErrorMatrix`, the same machinery the
 *      shipped birth path uses), triangulate each resulting bundle, then run ONE
 *      Hungarian assigning targets to bundles. A target can no longer be assigned
 *      inconsistent animals in different views — cross-view consistency holds by
 *      construction rather than by luck — and the association decision is made once
 *      against 5-view evidence instead of five times against 1-view evidence.
 *      Knobs: `bundleEpiGate` (px, reject an epipolar pairing above this),
 *      `bundleMinViews` (views needed before a bundle is triangulated).
 *
 * M3 `reid` (weight > 0) — SKELETAL RE-IDENTIFICATION WITH A LONG-TERM PROTOTYPE.
 *      The re-id feature bank of BoT-SORT/FairMOT, with a 3D pose descriptor
 *      standing in for a CNN appearance embedding — these are keypoint predictions,
 *      there are no pixels in the detection files to embed, and decoding 8 x 5 x
 *      ~180k frames of video to get them is not on the table. The descriptor is the
 *      vector of all pairwise 3D inter-keypoint distances over matching-weighted
 *      nodes (mm): body size and limb proportions, a property of the ANIMAL, stable
 *      over a session and independent of the trajectory. Each target carries an EMA
 *      prototype (`reidEma`, small = long memory) and `reid` adds a term to the
 *      target-to-bundle cost. Because the prototype is long-term, a swapped target
 *      shows a persistent descriptor mismatch and the assignment flips BACK — the
 *      recovery half. `reidSwapFrames` requires the re-id-driven assignment to
 *      disagree with the geometry-only one for that many consecutive frames before
 *      it is adopted, so descriptor noise cannot flip-flop identities.
 *      Requires `bundle` (the descriptor is only defined for a triangulated bundle).
 *
 * M3' `reidSwap` (bool) — PROTOTYPE-DRIVEN IDENTITY EXCHANGE. The same re-id evidence
 *      applied to the LABELS instead of to the assignment — the better-posed form for a
 *      permanent swap, and it does not need `bundle`. Full argument on `_reidSwap`; the
 *      short version is that undoing a swap through the ASSIGNMENT means paying a
 *      geometric penalty of tens of units to drag a target onto a body far away, while
 *      the re-id term's entire dynamic range is about one unit times its weight —
 *      whereas EXCHANGING the two targets' (trackId, prototype) pairs costs nothing
 *      geometric at all, because geometry was never wrong about which body is which,
 *      only about what to call it. Guarded by `reidSwapFrames` (consecutive frames of
 *      agreement required) and `reidSwapMargin` (mm of descriptor advantage required).
 *
 * Supporting knobs, useful with any of the above:
 *   `reidFreeze` (frames)— stop folding observations into the prototype after this
 *                          many. This matters for recovery specifically: a live EMA
 *                          prototype MIGRATES ONTO THE OTHER ANIMAL after a swap (~100
 *                          frames at reidEma 0.01), so the signal that would undo the
 *                          swap decays and the recovery window closes behind it.
 *   `stale` (frames)     — evict a target's per-view detection older than this many
 *                          frames, so `_retriangulate` cannot fuse a current view
 *                          with a long-stale one and `frameIdxMean` cannot drift.
 *   `motion` (0..1 gain) — constant-velocity 3D prediction (SORT/OC-SORT's motion
 *                          model, absent from the reference tracker) applied to the
 *                          state used for scoring. Implies `sync`; 0 = off.
 *   `gateAdj` (score)    — refuse a match whose adjacency is below this instead of
 *                          letting the forced Hungarian take it; the target coasts.
 *   `descProbe` (bool)   — measure descriptor separability without using it. The
 *                          go/no-go for M3: on a clean session a target's prototype
 *                          sits 3.2 mm from its own animal and 7.7 mm from the other.
 *
 * Everything below the tracker (pose/triangulation.js, pose/pose-data.js) is the
 * real, unmodified production geometry — the relative imports resolve inside pose/.
 */

import {
    triangulatePoints,
    reprojectPoint,
    backProjectToRays,
    pointsToRayDistances,
    hungarianAlgorithm,
    computeFundamentalMatrix,
    epipolarErrorMatrix,
} from './triangulation.js';
import { points3dNodeCount, readPoint3d } from './pose-data.js';

// ---------------------------------------------------------------------------
// Normalized-coordinate helpers  (unchanged from the shipped tracker)
// ---------------------------------------------------------------------------

export function normalizePoint(pt, cam) {
    if (pt == null) return null;
    var u = cam.undistortPoint(pt);   // undistorted pixels
    var K = cam.matrix;
    return [(u[0] - K[0][2]) / K[0][0], (u[1] - K[1][2]) / K[1][1]];
}

function projectNorm(p3, extrinsic) {
    return reprojectPoint(p3, extrinsic);
}

// ---------------------------------------------------------------------------
// Detection  (unchanged)
// ---------------------------------------------------------------------------

export function Detection(instance, cam, frameIdx, slot) {
    this.instance = instance;
    this.cam = cam;
    this.frameIdx = frameIdx;
    this.slot = slot;
    this.pointsPixel = instance.toPointsArray();
    this.pointsNorm = this.pointsPixel.map(function (p) { return normalizePoint(p, cam); });
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

function Target(trackId) {
    this.trackId = trackId;
    this.detsByCam = new Map();
    this.points3d = null;
    this.identityId = null;
    // --- experimental state (unused unless a method flag is on) ---
    this._snap3d = null;        // frozen 3D for synchronous association
    this._snapMean = 0;         // frozen frameIdxMean
    this._touched = false;      // got a detection this frame
    this._deferred = false;     // ... and re-triangulation was postponed to frame end
    this._at3dStart = null;      // this frame's pre-association 3D (velocity history)
    this._anchor = null;        // M5 smoothed 3D anchor (anchorSmooth)
    this._ambigCams = null;     // M4 views whose assignment this frame was a near tie
    this._prev3d = null;        // the 3D `motionBase` frames back (velocity model)
    this._ring = null;          // ring buffer backing that baseline
    this._prevFrame = null;
    this._lastFrame = null;
    this._proto = null;         // re-id prototype: Float64Array of pair distances
    this._protoN = null;        // per-pair observation counts
    this._protoObs = 0;         // frames folded into the prototype (re-id warm-up)
}

Target.prototype.frameIdxMean = function () {
    var s = 0, n = 0;
    this.detsByCam.forEach(function (d) { s += d.frameIdx; n++; });
    return n > 0 ? s / n : 0;
};

Target.prototype.addDetection = function (det, defer, freezeState) {
    this.detsByCam.set(det.cam.name, det);
    // M4: record the detection so it is REPORTED (commitTrackedFrame reads detsByCam),
    // but keep it OUT of the 3D, so an ambiguous decision cannot move the anchor that
    // later frames are judged against.
    //
    // Excluding it by name is the whole point, and the first version of this got it
    // wrong: it merely skipped setting the re-triangulation flag, which does nothing as
    // soon as ANOTHER view in the same frame updates normally — `_retriangulate` reads
    // the entire detsByCam, so the frozen detection went straight back into the 3D. The
    // freeze only bit when every view happened to be ambiguous at once.
    if (freezeState) {
        if (this._ambigCams == null) this._ambigCams = new Set();
        this._ambigCams.add(det.cam.name);
        return;
    }
    if (this._ambigCams) this._ambigCams.delete(det.cam.name);
    this._touched = true;
    if (defer) { this._deferred = true; return; }
    this._retriangulate();
};

/**
 * Re-fuse the target's per-view detections into a 3D pose.
 *
 * `exclude` (a Set of camera names, M4) drops views whose assignment this frame was too
 * close to call. With every view excluded there is nothing left to triangulate and the
 * previous 3D survives untouched — the intended freeze. With only some excluded the
 * update still happens, from the views that were decisive.
 */
Target.prototype._retriangulate = function (exclude) {
    var dets = Array.from(this.detsByCam.values());
    if (exclude && exclude.size) {
        dets = dets.filter(function (d) { return !exclude.has(d.cam.name); });
    }
    if (dets.length < 2) {
        if (dets.length === 1 && this.points3d == null) this.points3d = null;
        return;
    }
    var exts = dets.map(function (d) { return d.cam.extrinsicMatrix; });
    var nNodes = dets[0].pointsNorm.length;
    var allObs = [];
    for (var k = 0; k < nNodes; k++) {
        allObs.push(dets.map(function (d) { return d.pointsNorm[k]; }));
    }
    this.points3d = triangulatePoints(allObs, exts);
};

// ---------------------------------------------------------------------------
// Re-id descriptor: all pairwise 3D inter-keypoint distances (mm) over the
// matching-weighted nodes. A property of the animal's body, not its trajectory.
// ---------------------------------------------------------------------------

function descriptorPairs(nNodes, nodeWeights) {
    var use = [];
    for (var k = 0; k < nNodes; k++) {
        var w = nodeWeights ? nodeWeights[k] : 1;
        if (typeof w !== 'number' || !isFinite(w) || w > 0) use.push(k);
    }
    var pairs = [];
    for (var i = 0; i < use.length; i++) {
        for (var j = i + 1; j < use.length; j++) pairs.push([use[i], use[j]]);
    }
    return pairs;
}

/** Pairwise-distance vector for `points3d`; NaN where either endpoint is missing. */
function describe(points3d, pairs) {
    var out = new Float64Array(pairs.length);
    var a = [0, 0, 0], b = [0, 0, 0];
    for (var p = 0; p < pairs.length; p++) {
        if (!readPoint3d(points3d, pairs[p][0], a) || !readPoint3d(points3d, pairs[p][1], b)) {
            out[p] = NaN;
            continue;
        }
        var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
        out[p] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return out;
}

/** Mean |proto - desc| over pairs observed in both, or null if too few overlap. */
function descDistance(proto, protoN, desc, minPairs) {
    var s = 0, n = 0;
    for (var p = 0; p < desc.length; p++) {
        if (protoN[p] < 1 || Number.isNaN(desc[p]) || Number.isNaN(proto[p])) continue;
        s += Math.abs(proto[p] - desc[p]);
        n++;
    }
    return n >= minPairs ? s / n : null;
}

function protoUpdate(proto, protoN, desc, ema) {
    for (var p = 0; p < desc.length; p++) {
        if (Number.isNaN(desc[p])) continue;
        if (protoN[p] < 1) proto[p] = desc[p];
        else proto[p] += ema * (desc[p] - proto[p]);
        protoN[p]++;
    }
}

// ---------------------------------------------------------------------------
// CrossViewTracker
// ---------------------------------------------------------------------------

export class CrossViewTracker {
    constructor(hp) {
        hp = hp || {};
        this.corr2d = num(hp.corr2dWeight, 1.0);
        this.corr3d = num(hp.corr3dWeight, 1.0);
        this.velThresh = num(hp.velocityThreshold, 1.0);
        this.distThresh = num(hp.distanceThreshold, 1.0);
        this.timePenalty = num(hp.timePenalty, 1.0);
        this.maxTargets = (typeof hp.maxTargets === 'number' && isFinite(hp.maxTargets)
            && hp.maxTargets > 0) ? Math.floor(hp.maxTargets) : null;
        this.nodeWeights = Array.isArray(hp.nodeWeights) ? hp.nodeWeights : null;

        this.targets = [];
        this.unmatchedByCam = new Map();
        this._nextTrackId = 0;
        this._fCache = {};

        // --- experimental configuration ---
        var m = (globalThis.__BENCH && globalThis.__BENCH.method) || {};
        this.M = {
            // `motion` IMPLIES `sync`. The constant-velocity step is a frame-level
            // quantity — it is computed once from the frame-start state — so there is
            // no coherent way to apply it while the state is also being mutated
            // view-by-view. Isolate motion's own effect by comparing sync+motion
            // against sync, not against the shipped default.
            sync: !!m.sync || num(m.motion, 0) > 0 || num(m.xvRefine, 0) > 0
                || (num(m.anchorSmooth, 1) < 1),
            bundle: !!m.bundle,
            bundleEpiGate: num(m.bundleEpiGate, Infinity),
            bundleMinViews: num(m.bundleMinViews, 2),
            reid: num(m.reid, 0),
            reidEma: num(m.reidEma, 0.01),
            reidScale: num(m.reidScale, 10),
            reidMinPairs: num(m.reidMinPairs, 10),
            reidWarm: num(m.reidWarm, 300),
            // Stop folding observations into the prototype after this many frames.
            // This matters more than it looks: an EMA prototype that keeps updating
            // MIGRATES ONTO THE OTHER ANIMAL after a swap (at reidEma 0.01 the time
            // constant is ~100 frames), so the very signal that would undo the swap
            // decays away and the recovery window is only as long as that time
            // constant. A frozen prototype — or an reidEma small enough that the
            // session is short by comparison — keeps the anchor attached to the animal
            // it was learned from. Infinity = keep updating (the plain EMA).
            reidFreeze: num(m.reidFreeze, Infinity),
            reidSwapFrames: num(m.reidSwapFrames, 0),
            reidMaxDesc: num(m.reidMaxDesc, Infinity),
            stale: num(m.stale, 0),
            motion: num(m.motion, 0),
            gateAdj: num(m.gateAdj, -Infinity),
            // Build descriptors and measure prototype distances WITHOUT letting them
            // touch the assignment. This is what says whether re-id is viable at all
            // on this corpus before any weight is tuned: if a target's own prototype
            // is no closer to its own bundle than to the other animal's, the
            // descriptor carries no identity signal and M3 cannot work, whatever the
            // weight. Requires `bundle`.
            descProbe: !!m.descProbe,
            descBlock: num(m.descBlock, 0),
            // M3' PROTOTYPE-DRIVEN IDENTITY EXCHANGE. See the block comment on
            // `_reidSwap` — this is a different lever from `reid` and a strictly
            // better-posed one for the failure mode being fixed.
            reidSwap: !!m.reidSwap,
            reidSwapMargin: num(m.reidSwapMargin, 1.0),
            // M4 AMBIGUITY-AWARE ANCHOR PROTECTION. See `_permGap`. When the best
            // target->bundle permutation beats the runner-up by less than this, the
            // frame is declared ambiguous: the assignment is still REPORTED, but the
            // targets' 3D is left frozen, so a coin-flip frame cannot move the anchor
            // that every later frame is judged against. 0 = off.
            ambigMargin: num(m.ambigMargin, 0),
            // M2' CROSS-VIEW CONSISTENCY REFINEMENT. See `_xvRefine`. Implies `sync`.
            xvRefine: num(m.xvRefine, 0),
            // M5 SMOOTHED ANCHOR. The state a target is scored against becomes an EMA
            // over frames instead of the instantaneous triangulation, so no SINGLE
            // frame can move the anchor much — the gentle, always-on version of
            // `ambigMargin`'s all-or-nothing freeze. 1 = off (instantaneous). Implies
            // `sync`, since the smoothed state is a frame-level quantity.
            anchorSmooth: num(m.anchorSmooth, 1),
            // M6 ROBUST PER-NODE AGGREGATION. The shipped 2D and 3D terms SUM a
            // per-node correspondence over ~11 matching-weighted nodes, so a handful of
            // badly-placed nodes — a mis-detected tail, a left/right confusion, a node
            // triangulated from two views that disagree — can move the total by more
            // than the difference between the right and wrong animal. That only matters
            // on near-degenerate frames, and near-degenerate frames are the entire
            // subject: a bad session loses ~0.35 IDF1 to roughly one of them. Trimming
            // this fraction off BOTH tails before averaging makes the decision rest on
            // the typical node instead of the extreme one. 0 = off (the shipped sum).
            robustTrim: num(m.robustTrim, 0),
            // How many frames back the constant-velocity baseline reaches. 1 = the
            // previous frame, which is what a naive SORT port does and what the first
            // `motion` test used — and a 1-frame difference of a DLT triangulation is
            // mostly triangulation noise, so the "prediction" mostly injects noise into
            // the state being matched against. That is OC-SORT's central observation:
            // estimate the direction over a longer observation-centric baseline instead.
            // Only meaningful with `motion` > 0.
            motionBase: Math.max(1, Math.round(num(m.motionBase, 1))),
            // Measure how OLD the detections are that `_retriangulate` fuses, without
            // changing any decision. This is the direct evidence for why `stale` works:
            // a target keeps one detection per camera and never expires it, so the 3D
            // anchor every association is scored against blends the current pose with
            // wherever each other camera last saw the animal. Behaviour-neutral — it
            // only turns on the frame bookkeeping — and that is verified by digest.
            probeAge: !!m.probeAge,
        };
        this.active = this.M.sync || this.M.bundle || this.M.reid > 0
            || this.M.stale > 0 || this.M.motion > 0 || this.M.gateAdj > -Infinity
            || this.M.reidSwap || this.M.ambigMargin > 0 || this.M.robustTrim > 0
            || this.M.probeAge;
        this._pairs = null;          // lazily built once nNodes is known
        this._swapVote = 0;          // consecutive frames re-id disagreed with geometry
        this._exchangeVote = 0;      // ... and the same counter for M3' (kept separate:
                                     // sharing one would make each path reset the
                                     // other's accumulated evidence)
        this._frame = null;
        this.stats = {
            frames: 0, bundles: 0, reidFlips: 0, gated: 0, coasted: 0,
            // descProbe readout: mean descriptor distance from a target's prototype to
            // the bundle it was matched to (`self`) versus to the other bundle
            // (`other`), and how often self < other. 0.5 == no identity signal.
            descN: 0, descSelf: 0, descOther: 0, descSelfCloser: 0,
            // Mean epipolar error (px) of the cross-view pairings `bundle` accepted.
            // A bundle built from two different animals triangulates to nonsense, and
            // this is the cheapest way to see that happening.
            epiN: 0, epiSum: 0, epiRejected: 0,
            // M3' arbitration audit. `swapN/swapCur/swapAlt` are the mean descriptor
            // cost of keeping the labels versus exchanging them, over every frame the
            // prototypes were settled enough to arbitrate: if those two means are close,
            // the prototypes are not separated and any exchange is a coin flip. The
            // first flip frames are recorded so a flip can be checked against WHERE the
            // shipped tracker actually diverges from ground truth, rather than being
            // counted and assumed useful.
            swapN: 0, swapCur: 0, swapAlt: 0, flipFrames: [],
            // M4: frames declared ambiguous (anchor frozen) and the mean permutation
            // gap over all arbitrated frames, so the chosen margin can be read against
            // the distribution it is thresholding rather than picked blind.
            ambigFrames: 0, gapN: 0, gapSum: 0,
            // Gap CDF at fixed cut points. The MEAN gap (~60-160) says nothing about
            // the tail, and the tail is the entire subject: a bad session loses ~0.35
            // IDF1 to about one frame. This makes `ambigMargin` selectable from a
            // measured quantile instead of guessed.
            gapBelow: { 1: 0, 2: 0, 5: 0, 10: 0, 20: 0, 50: 0, 100: 0 },
            // M2': accepted consistency swaps, and how often the epipolar pairing that
            // `bundle` relies on changes between consecutive frames for a fixed
            // (reference detection, view) — the measurement that explains why `bundle`
            // churns identities.
            xvSwaps: 0, xvTested: 0, epiPairFlips: 0, epiPairChecks: 0,
            // probeAge: age in frames of the per-view detections `_retriangulate` fuses.
            ageN: 0, ageSum: 0, ageOver1: 0, ageOver10: 0, ageOver100: 0, ageMax: 0,
            // `descBlock` readout — see the comment on `_blockAccumulate`. Per target,
            // the MEAN descriptor over each block of `descBlock` frames. The per-frame
            // probe above answers "can one frame tell the animals apart" (it cannot);
            // this answers the different and more favourable question "can a long
            // average tell them apart", since averaging n frames cuts the triangulation
            // noise by sqrt(n) while a genuine body-size difference is constant.
            descBlocks: null,
        };
        // The driver has no handle on the tracker (`runCrossViewTracker` returns only
        // counts), so expose the live instance for its methodStats readout. Diagnostic
        // only — nothing in the tracker reads this back.
        globalThis.__BENCH_LAST_TRACKER = this;
    }

    /**
     * Process one frame. Shipped path when no method flag is set.
     */
    trackFrame(detsByCam, camsOrder) {
        if (!this.active) {
            for (var ci = 0; ci < camsOrder.length; ci++) {
                var cam = camsOrder[ci];
                var dets = detsByCam.get(cam.name) || [];
                this.unmatchedByCam.set(cam.name, []);
                this._trackView(dets, cam);
            }
            return;
        }
        this._beginFrame(detsByCam, camsOrder);
        if (this.M.bundle) this._trackFrameBundled(detsByCam, camsOrder);
        else {
            for (var cj = 0; cj < camsOrder.length; cj++) {
                var c2 = camsOrder[cj];
                var d2 = detsByCam.get(c2.name) || [];
                this.unmatchedByCam.set(c2.name, []);
                this._trackView(d2, c2);
            }
        }
        this._endFrame();
    }

    // ------------------------------------------------------------------
    // Frame bookkeeping for the experimental paths
    // ------------------------------------------------------------------

    _beginFrame(detsByCam, camsOrder) {
        // Current frame index, taken from the detections themselves (trackFrame is
        // not given one, and the shipped signature is not changed).
        var f = null;
        for (var ci = 0; ci < camsOrder.length; ci++) {
            var list = detsByCam.get(camsOrder[ci].name) || [];
            for (var i = 0; i < list.length; i++) {
                if (f == null || list[i].frameIdx > f) f = list[i].frameIdx;
            }
        }
        if (f == null) f = (this._frame == null ? 0 : this._frame + 1);
        this._frame = f;
        this.stats.frames++;

        for (var t = 0; t < this.targets.length; t++) {
            var tg = this.targets[t];
            if (this.M.stale > 0) {
                var cutoff = f - this.M.stale;
                var drop = [];
                tg.detsByCam.forEach(function (d, name) {
                    if (d.frameIdx < cutoff) drop.push(name);
                });
                for (var k = 0; k < drop.length; k++) tg.detsByCam.delete(drop[k]);
            }
            tg._touched = false;
            tg._deferred = false;
            if (tg._ambigCams) tg._ambigCams.clear();
            if (this.M.probeAge) {
                var st = this.stats;
                tg.detsByCam.forEach(function (d) {
                    var age = f - d.frameIdx;
                    st.ageN++; st.ageSum += age;
                    if (age > 1) st.ageOver1++;
                    if (age > 10) st.ageOver10++;
                    if (age > 100) st.ageOver100++;
                    if (age > st.ageMax) st.ageMax = age;
                });
            }
            tg._at3dStart = tg.points3d;   // `_retriangulate` replaces the array, so
                                           // holding the reference is a free snapshot
            tg._snapMean = tg.frameIdxMean();
            tg._snap3d = this._stateFor(tg, f);
        }
    }

    /**
     * The 3D state a target is scored against this frame: its current triangulation,
     * optionally advanced by a damped constant-velocity step (SORT's motion model,
     * which the reference tracker does not have).
     */
    _stateFor(target, frame) {
        var cur = target.points3d;
        // M5: blend the fresh triangulation into a persistent smoothed anchor first, so
        // the state every view is scored against carries many frames of evidence rather
        // than one. Nodes missing from the smoothed anchor are seeded from `cur`.
        if (this.M.anchorSmooth < 1 && cur != null) {
            var s = this.M.anchorSmooth;
            if (target._anchor == null || target._anchor.length !== cur.length) {
                target._anchor = cur.slice();
            } else {
                var an = target._anchor;
                for (var i = 0; i < cur.length; i += 3) {
                    if (Number.isNaN(cur[i])) continue;
                    if (Number.isNaN(an[i])) {
                        an[i] = cur[i]; an[i + 1] = cur[i + 1]; an[i + 2] = cur[i + 2];
                    } else {
                        an[i] += s * (cur[i] - an[i]);
                        an[i + 1] += s * (cur[i + 1] - an[i + 1]);
                        an[i + 2] += s * (cur[i + 2] - an[i + 2]);
                    }
                }
            }
            cur = target._anchor;
        }
        if (cur == null || this.M.motion <= 0) return cur;
        if (target._prev3d == null || target._prevFrame == null
            || target._lastFrame == null) return cur;
        var dtPrev = target._lastFrame - target._prevFrame;
        var dtNow = frame - target._lastFrame;
        if (!(dtPrev > 0) || !(dtNow > 0)) return cur;
        var n = points3dNodeCount(cur);
        var pred = new Float64Array(cur.length);
        pred.fill(NaN);
        var a = [0, 0, 0], b = [0, 0, 0];
        var g = this.M.motion * (dtNow / dtPrev);
        for (var k = 0; k < n; k++) {
            if (!readPoint3d(cur, k, a)) continue;
            var o = k * 3;
            if (!readPoint3d(target._prev3d, k, b)) {
                pred[o] = a[0]; pred[o + 1] = a[1]; pred[o + 2] = a[2];
                continue;
            }
            pred[o] = a[0] + g * (a[0] - b[0]);
            pred[o + 1] = a[1] + g * (a[1] - b[1]);
            pred[o + 2] = a[2] + g * (a[2] - b[2]);
        }
        return pred;
    }

    /** This frame's detections for a target, as [camName, det] pairs. */
    _curDets(target) {
        var out = [], f = this._frame;
        target.detsByCam.forEach(function (d, name) {
            if (d.frameIdx === f) out.push([name, d]);
        });
        return out;
    }

    /**
     * Mean reprojection residual (normalized image units) of a set of detections
     * treated as views of ONE object: triangulate them, reproject the result into every
     * contributing view, and average the distance to the observed keypoints. Low means
     * "these detections really are the same animal"; high means the set mixes animals.
     */
    _residualOf(pairs) {
        if (pairs.length < 2) return null;
        var exts = pairs.map(function (p) { return p[1].cam.extrinsicMatrix; });
        var nNodes = pairs[0][1].pointsNorm.length;
        var allObs = [];
        for (var k = 0; k < nNodes; k++) {
            allObs.push(pairs.map(function (p) { return p[1].pointsNorm[k]; }));
        }
        var p3 = triangulatePoints(allObs, exts);
        var sum = 0, n = 0, tp = [0, 0, 0];
        for (var v = 0; v < pairs.length; v++) {
            var ext = pairs[v][1].cam.extrinsicMatrix;
            var pn = pairs[v][1].pointsNorm;
            for (var j = 0; j < nNodes; j++) {
                if (this._nodeWeight(j) === 0) continue;
                if (pn[j] == null || !readPoint3d(p3, j, tp)) continue;
                var pr = projectNorm(tp, ext);
                var dx = pn[j][0] - pr[0], dy = pn[j][1] - pr[1];
                var e = Math.sqrt(dx * dx + dy * dy);
                if (!isFinite(e)) continue;
                sum += e; n++;
            }
        }
        return n > 0 ? sum / n : null;
    }

    /**
     * M2' — CROSS-VIEW CONSISTENCY REFINEMENT.
     *
     * This is what `bundle` was trying to do, done with the right cue. The failure mode
     * being fixed is a labelling that is locally optimal in every view and jointly
     * wrong: view 1 hands target A the detection that is physically animal 1 while view
     * 2 hands target A the detection that is physically animal 2. Nothing in a per-view
     * association can see that, because each view is individually happy.
     *
     * `bundle` tried to prevent it by first grouping detections ACROSS views by
     * epipolar error and then associating whole groups. Measured, that was 70x WORSE
     * than the shipped tracker (22,882 within-view switches against 324): pairwise
     * epipolar error between two cameras is a far weaker cue than agreement with a
     * 5-view 3D state, so which detection paired with which flickered frame to frame
     * and dragged the identities with it. `epiPairFlips` records that directly.
     *
     * The strong cue is the TRIANGULATION RESIDUAL. A target whose five detections are
     * really one animal triangulates tightly; one that mixes animals does not. So keep
     * the shipped per-view association, then do coordinate descent on top of it: for
     * each view in turn, try handing that view's detection to a different target, keep
     * the exchange only if the TOTAL residual over both targets falls. Views are
     * visited `xvRefine` times. Cross-view consistency is then enforced by the same
     * geometry the tracker already trusts, and the shipped association is the starting
     * point rather than something thrown away.
     */
    _xvRefine() {
        var live = [];
        for (var i = 0; i < this.targets.length; i++) {
            var pairs = this._curDets(this.targets[i]);
            if (pairs.length >= 2) live.push({ t: this.targets[i], pairs: pairs });
        }
        if (live.length < 2) return;

        var self = this;
        var resOf = function (e) {
            var r = self._residualOf(e.pairs);
            return r == null ? Infinity : r;
        };
        var res = live.map(resOf);

        for (var pass = 0; pass < this.M.xvRefine; pass++) {
            var improved = false;
            for (var a = 0; a < live.length; a++) {
                for (var b = a + 1; b < live.length; b++) {
                    // Views this pair of targets both hold a detection in this frame —
                    // the only places an exchange is even defined.
                    var namesA = live[a].pairs.map(function (p) { return p[0]; });
                    for (var ni = 0; ni < namesA.length; ni++) {
                        var name = namesA[ni];
                        var ia = indexOfName(live[a].pairs, name);
                        var ib = indexOfName(live[b].pairs, name);
                        if (ia < 0 || ib < 0) continue;
                        var da = live[a].pairs[ia][1], db = live[b].pairs[ib][1];
                        live[a].pairs[ia] = [name, db];
                        live[b].pairs[ib] = [name, da];
                        var ra = resOf(live[a]), rb = resOf(live[b]);
                        self.stats.xvTested++;
                        if (ra + rb < res[a] + res[b] - 1e-12) {
                            res[a] = ra; res[b] = rb;
                            improved = true;
                            self.stats.xvSwaps++;
                        } else {
                            live[a].pairs[ia] = [name, da];
                            live[b].pairs[ib] = [name, db];
                        }
                    }
                }
            }
            if (!improved) break;
        }

        // Write the refined labelling back. Only this frame's entries are touched;
        // detections from earlier frames keep whichever target already held them.
        for (var q = 0; q < live.length; q++) {
            for (var r = 0; r < live[q].pairs.length; r++) {
                live[q].t.detsByCam.set(live[q].pairs[r][0], live[q].pairs[r][1]);
            }
        }
    }

    _endFrame() {
        if (this.M.xvRefine > 0) this._xvRefine();
        for (var t = 0; t < this.targets.length; t++) {
            var tg = this.targets[t];
            if (tg._deferred) { tg._retriangulate(tg._ambigCams); tg._deferred = false; }
            if (tg._touched && tg._lastFrame !== this._frame) {
                // Roll the constant-velocity history forward. The baseline is a ring
                // buffer `motionBase` frames deep, so `_prev3d` is the state that many
                // frames back rather than one — see the `motionBase` comment.
                //
                // The frame stamped on a ring entry is `_lastFrame`, NOT this frame:
                // `_at3dStart` is the state as it stood at the END of the previous
                // update, so it belongs to `_lastFrame`. Stamping it with `this._frame`
                // (the first version of this) made `_prevFrame === _lastFrame` at
                // motionBase = 1, so `dtPrev` came out 0, `_stateFor`'s `dtPrev > 0`
                // guard bailed out, and the motion model was silently INERT — it turned
                // `sync_motion` into plain `sync` without changing any config. Caught by
                // `fig8_methods.py --recheck`, which is exactly what that mode is for.
                if (tg._ring == null) tg._ring = [];
                tg._ring.push({ f: tg._lastFrame == null ? this._frame - 1 : tg._lastFrame,
                                p: tg._at3dStart });
                while (tg._ring.length > this.M.motionBase) tg._ring.shift();
                var old = tg._ring[0];
                tg._prev3d = old.p;
                tg._prevFrame = old.f;
                tg._lastFrame = this._frame;
            }
            tg._touched = false;
            tg._snap3d = null;
            tg._at3dStart = null;
        }
        if (this.M.reidSwap) this._reidSwap();
    }

    /**
     * M3' — PROTOTYPE-DRIVEN IDENTITY EXCHANGE.
     *
     * The failure mode is a permanent swap: two targets exchange animals and stay
     * exchanged for the rest of the session. `reid` attacks that by adding a re-id term
     * to the target-to-bundle assignment cost, and that formulation is badly posed for
     * this job. To undo a swap through the ASSIGNMENT, a target has to be pulled off
     * the body it is currently sitting on and onto one that may be hundreds of mm away
     * — a geometric penalty of order `corr3d * (1 - d/distThresh)` summed over nodes,
     * which is tens of units. The re-id term's whole dynamic range is about one unit
     * times its weight. So the weight needed to win that argument is large enough to
     * dominate association everywhere else too, which is how you trade a rare permanent
     * swap for constant identity churn.
     *
     * The exchange is the same evidence applied to the right variable. Geometry is
     * RIGHT about which body is which — after a swap each target really is sitting on
     * the body it thinks it is. What is wrong is the LABEL. So leave the assignment
     * completely alone and permute the labels: each target's descriptor is compared to
     * every prototype, and if the best matching is not the current one, the
     * (trackId, prototype) pairs are exchanged between targets. `commitTrackedFrame`
     * maps target.trackId -> Identity, so exchanging trackIds exchanges the reported
     * identities, and the prototype travels with the identity so it stays a description
     * of that animal.
     *
     * Cost: exactly one extra ID-switch per repair (the frame where the labels move),
     * against every subsequent frame being right. That is the trade the diagnostic says
     * to take — 20250904_131913 loses 0.311 IDF1 to 10 switches, so switches are cheap
     * here and mislabelled mass is not.
     *
     * Guards: `reidSwapFrames` requires the disagreement to persist that many
     * consecutive frames, and `reidSwapMargin` requires the exchange to be better by
     * that many mm of mean descriptor distance. Both exist to stop a noisy frame from
     * relabelling a session that was fine.
     */
    _reidSwap() {
        var n = this.targets.length;
        if (n < 2) { this._exchangeVote = 0; return; }
        if (this._pairs == null) {
            for (var s = 0; s < n; s++) {
                if (this.targets[s].points3d != null) {
                    this._pairs = descriptorPairs(
                        points3dNodeCount(this.targets[s].points3d), this.nodeWeights);
                    break;
                }
            }
            if (this._pairs == null) return;
        }

        var desc = [], ok = true;
        for (var i = 0; i < n; i++) {
            var t = this.targets[i];
            if (t.points3d == null) { ok = false; break; }
            desc.push(describe(t.points3d, this._pairs));
        }
        if (!ok) { this._exchangeVote = 0; return; }

        // Learn first. A prototype that has not settled cannot arbitrate anything, and
        // `reidFreeze` stops it drifting onto the other animal after a swap.
        for (var j = 0; j < n; j++) {
            var tj = this.targets[j];
            if (tj._proto == null) {
                tj._proto = new Float64Array(desc[j].length);
                tj._protoN = new Int32Array(desc[j].length);
            }
        }

        var settled = true;
        for (var q = 0; q < n; q++) {
            if (this.targets[q]._protoObs < this.M.reidWarm) settled = false;
        }

        if (settled) {
            // C[i][j] = mean |prototype_i - descriptor_of_body_j| in mm.
            var C = [], usable = true;
            for (var a = 0; a < n; a++) {
                C[a] = [];
                for (var b = 0; b < n; b++) {
                    var d = descDistance(this.targets[a]._proto, this.targets[a]._protoN,
                                         desc[b], this.M.reidMinPairs);
                    if (d == null || !(d <= this.M.reidMaxDesc)) usable = false;
                    C[a][b] = d == null ? Infinity : d;
                }
            }
            if (usable) {
                var assign = hungarianAlgorithm(C);
                var cur = 0, alt = 0, differs = false;
                for (var k = 0; k < n; k++) {
                    var m2 = assign[k];
                    if (m2 == null || m2 < 0 || m2 >= n) { differs = false; break; }
                    if (m2 !== k) differs = true;
                    cur += C[k][k];
                    alt += C[k][m2];
                }
                if (assign[0] != null && assign[0] >= 0) {
                    this.stats.swapN++;
                    this.stats.swapCur += cur;
                    this.stats.swapAlt += alt;
                }
                if (differs && (cur - alt) >= this.M.reidSwapMargin) {
                    this._exchangeVote++;
                    if (this._exchangeVote >= this.M.reidSwapFrames) {
                        var snap = this.targets.map(function (t2) {
                            return { trackId: t2.trackId, proto: t2._proto,
                                     protoN: t2._protoN, protoObs: t2._protoObs };
                        });
                        for (var p = 0; p < n; p++) {
                            var dst = this.targets[assign[p]];
                            dst.trackId = snap[p].trackId;
                            dst._proto = snap[p].proto;
                            dst._protoN = snap[p].protoN;
                            dst._protoObs = snap[p].protoObs;
                        }
                        // desc[] is indexed by target slot, which did not move — only
                        // the labels did — so the prototype update below still folds
                        // each body into the prototype now attached to it.
                        this.stats.reidFlips++;
                        if (this.stats.flipFrames.length < 200) {
                            this.stats.flipFrames.push(this._frame);
                        }
                        this._exchangeVote = 0;
                    }
                } else {
                    this._exchangeVote = 0;
                }
            }
        }

        for (var u = 0; u < n; u++) {
            var tu = this.targets[u];
            if (tu._protoObs < this.M.reidFreeze) {
                protoUpdate(tu._proto, tu._protoN, desc[u], this.M.reidEma);
            }
            tu._protoObs++;
        }
    }

    // ------------------------------------------------------------------
    // Shipped per-view association (also used by `sync`, which only changes
    // WHICH state the adjacency is scored against and when re-triangulation
    // happens).
    // ------------------------------------------------------------------

    _trackView(dets, cam) {
        var N = this.targets.length, M = dets.length;
        var matchedDet = new Array(M).fill(false);

        if (N > 0 && M > 0) {
            var cost = [];
            var adj = [];
            for (var t = 0; t < N; t++) {
                cost[t] = [];
                adj[t] = [];
                for (var d = 0; d < M; d++) {
                    adj[t][d] = this._adjacency(this.targets[t], dets[d], cam);
                    cost[t][d] = -adj[t][d];
                }
            }
            var assign = hungarianAlgorithm(cost);
            // M4: is THIS VIEW's assignment decisive? Per view rather than per frame,
            // because that is the granularity the shipped tracker decides at, so only
            // the view that is actually ambiguous has its contribution held back.
            var ambiguous = false;
            if (this.M.ambigMargin > 0) {
                var g = this._permGap(adj, N, M);
                if (g != null) {
                    this.stats.gapN++;
                    this.stats.gapSum += g.gap;
                    var cuts = this.stats.gapBelow;
                    for (var ck in cuts) if (g.gap < Number(ck)) cuts[ck]++;
                    if (g.gap < this.M.ambigMargin) {
                        ambiguous = true;
                        this.stats.ambigFrames++;
                    }
                }
            }
            for (var ti = 0; ti < N; ti++) {
                var di = assign[ti];
                if (di != null && di >= 0 && di < M) {
                    if (this.active && adj[ti][di] < this.M.gateAdj) {
                        this.stats.gated++;
                        continue;                       // refuse: the target coasts
                    }
                    this.targets[ti].addDetection(dets[di], this.M.sync, ambiguous);
                    matchedDet[di] = true;
                }
            }
        }

        var leftover = [];
        for (var m = 0; m < M; m++) if (!matchedDet[m]) leftover.push(dets[m]);
        this.unmatchedByCam.set(cam.name, leftover);

        this._initializeTargets();
    }

    _adjacency(target, det, cam) {
        var state = this.M.sync ? target._snap3d : target.points3d;
        var mean = this.M.sync ? target._snapMean : target.frameIdxMean();
        var dt = det.frameIdx - mean;
        return this._adjacency2d(state, det, dt) + this._adjacency3d(state, det, cam);
    }

    _nodeWeight(k) {
        if (this.nodeWeights == null) return 1;
        var w = this.nodeWeights[k];
        return (typeof w === 'number' && isFinite(w)) ? w : 1;
    }

    _adjacency2d(state, det, dt) {
        if (state == null) return 0;
        var ext = det.cam.extrinsicMatrix;
        var decay = Math.exp(-this.timePenalty * dt);
        var sum = 0;
        var per = this.M.robustTrim > 0 ? [] : null;   // M6
        var n = Math.min(points3dNodeCount(state), det.pointsNorm.length);
        var tp = [0, 0, 0];
        for (var k = 0; k < n; k++) {
            var w = this._nodeWeight(k);
            if (w === 0) continue;
            var dp = det.pointsNorm[k];
            if (dp == null || !readPoint3d(state, k, tp)) continue;
            var proj = projectNorm(tp, ext);
            var dx = dp[0] - proj[0], dy = dp[1] - proj[1];
            var distance = Math.sqrt(dx * dx + dy * dy);
            if (!isFinite(distance)) continue;
            var velocity = distance / (this.velThresh * (1 + dt));
            var correspondence = this.corr2d * (1 - velocity);
            if (per) per.push(w * correspondence * decay);
            else sum += w * correspondence * decay;
        }
        return per ? trimmedMean(per, this.M.robustTrim) : sum;
    }

    _adjacency3d(state, det, cam) {
        if (state == null) return 0;
        var ext = det.cam.extrinsicMatrix;
        var ray = backProjectToRays(det.pointsNorm, ext);
        var dists = pointsToRayDistances(state, ray.origin, ray.directions);
        var sum = 0;
        var per = this.M.robustTrim > 0 ? [] : null;   // M6
        for (var k = 0; k < dists.length; k++) {
            var w = this._nodeWeight(k);
            if (w === 0) continue;
            if (dists[k] == null || !isFinite(dists[k])) continue;
            var distanceWeight = dists[k] / this.distThresh;
            var correspondence = this.corr3d * (1 - distanceWeight);
            if (per) per.push(w * correspondence);
            else sum += w * correspondence;
        }
        return per ? trimmedMean(per, this.M.robustTrim) : sum;
    }

    // ------------------------------------------------------------------
    // M2 `bundle` — cross-view clustering, then ONE global assignment
    // ------------------------------------------------------------------

    /**
     * Cluster this frame's detections across views into bundles, each a candidate
     * 3D observation of one animal. Reference view = the view with the most
     * detections; every other view's detections are Hungarian-matched to it on
     * epipolar error (the same `epipolarErrorMatrix` the shipped birth path uses).
     * Detections that match nothing in the reference view are returned as orphans.
     */
    _buildBundles(detsByCam, camsOrder) {
        var refCam = null, refDets = null;
        for (var ci = 0; ci < camsOrder.length; ci++) {
            var list = detsByCam.get(camsOrder[ci].name) || [];
            if (refDets == null || list.length > refDets.length) {
                refDets = list; refCam = camsOrder[ci];
            }
        }
        if (!refDets || refDets.length === 0) return { bundles: [], orphans: [] };

        var bundles = refDets.map(function (d) {
            return { dets: [d], points3d: null, desc: null };
        });
        var orphans = [];
        var refPts = refDets.map(function (d) { return d.pointsPixel; });

        for (var cj = 0; cj < camsOrder.length; cj++) {
            var cam = camsOrder[cj];
            if (cam.name === refCam.name) continue;
            var dets = detsByCam.get(cam.name) || [];
            if (dets.length === 0) continue;
            var F = this._fundamental(refCam, cam);
            var err = epipolarErrorMatrix(refPts, dets.map(function (d) {
                return d.pointsPixel;
            }), F);
            var assign = hungarianAlgorithm(err);
            var used = new Set();
            for (var i = 0; i < refDets.length; i++) {
                var j = assign[i];
                if (j == null || j < 0 || j >= dets.length) continue;
                if (!(err[i][j] <= this.M.bundleEpiGate)) { this.stats.epiRejected++; continue; }
                if (isFinite(err[i][j])) { this.stats.epiN++; this.stats.epiSum += err[i][j]; }
                bundles[i].dets.push(dets[j]);
                used.add(j);
            }
            for (var k = 0; k < dets.length; k++) if (!used.has(k)) orphans.push(dets[k]);
        }

        for (var b = 0; b < bundles.length; b++) {
            var bd = bundles[b].dets;
            if (bd.length < this.M.bundleMinViews) continue;
            var exts = bd.map(function (d) { return d.cam.extrinsicMatrix; });
            var nNodes = bd[0].pointsNorm.length;
            var allObs = [];
            for (var n = 0; n < nNodes; n++) {
                allObs.push(bd.map(function (d) { return d.pointsNorm[n]; }));
            }
            bundles[b].points3d = triangulatePoints(allObs, exts);
            this.stats.bundles++;
        }
        return { bundles: bundles, orphans: orphans };
    }

    /**
     * Geometry score for (target, bundle): mean over nodes of the shipped 3D
     * correspondence `corr3d * (1 - d/distThresh)` between the target's (optionally
     * motion-predicted) 3D and the bundle's triangulated 3D. Falls back to the
     * shipped per-view 2D+3D adjacency, summed over the bundle's views, when the
     * bundle could not be triangulated.
     */
    _bundleGeom(target, bundle) {
        var state = target._snap3d;
        if (state == null) return 0;
        if (bundle.points3d == null) {
            var s = 0;
            for (var i = 0; i < bundle.dets.length; i++) {
                var det = bundle.dets[i];
                var dt = det.frameIdx - target._snapMean;
                s += this._adjacency2d(state, det, dt)
                    + this._adjacency3d(state, det, det.cam);
            }
            return s / Math.max(1, bundle.dets.length);
        }
        var n = Math.min(points3dNodeCount(state), points3dNodeCount(bundle.points3d));
        var a = [0, 0, 0], b = [0, 0, 0];
        var sum = 0, wsum = 0;
        for (var k = 0; k < n; k++) {
            var w = this._nodeWeight(k);
            if (w === 0) continue;
            if (!readPoint3d(state, k, a) || !readPoint3d(bundle.points3d, k, b)) continue;
            var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
            var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (!isFinite(d)) continue;
            sum += w * this.corr3d * (1 - d / this.distThresh);
            wsum += w;
        }
        return wsum > 0 ? sum / wsum : 0;
    }

    /**
     * Accumulate per-target, per-block mean descriptors (diagnostic only).
     *
     * The per-frame probe (`descProbe`) shows the skeletal descriptor is at chance on
     * full sessions once the prototype is frozen: per-frame triangulation noise on a
     * pairwise distance is 5-11 mm, and whatever body-size difference exists between
     * two same-strain mice is smaller than that. But noise averages down and a real size
     * difference does not, so the fair question is whether a LONG average separates
     * them. This records the mean descriptor over each block of `descBlock` frames, so
     * that can be answered offline: compare the spread BETWEEN the two targets' block
     * means against the spread WITHIN one target's block means across time. If between
     * is not clearly larger than within, no amount of averaging will re-identify these
     * animals from their skeletons and M3 is dead on this corpus rather than
     * under-tuned.
     *
     * Blocks are keyed by target SLOT, not identity, so a block spanning a swap mixes
     * both animals — which is why the offline read uses the early blocks, where the
     * loss decomposition says identity is still ~correct (IDF1 0.935 over the leading
     * 20,000 frames).
     */
    _blockAccumulate(slot, desc) {
        if (this.stats.descBlocks == null) this.stats.descBlocks = {};
        var b = Math.floor(this._frame / this.M.descBlock);
        var key = slot + ':' + b;
        var e = this.stats.descBlocks[key];
        if (!e) {
            e = this.stats.descBlocks[key] = {
                slot: slot, block: b, n: 0, sum: new Array(desc.length).fill(0),
                cnt: new Array(desc.length).fill(0),
            };
        }
        e.n++;
        for (var p = 0; p < desc.length; p++) {
            if (Number.isNaN(desc[p])) continue;
            e.sum[p] += desc[p];
            e.cnt[p]++;
        }
    }

    /** Raw descriptor distance (mm) from a target's prototype to a bundle, or null. */
    _descDist(target, bundle) {
        if (bundle.desc == null || target._proto == null) return null;
        if (target._protoObs < this.M.reidWarm) return null;   // prototype not settled
        return descDistance(target._proto, target._protoN, bundle.desc,
                            this.M.reidMinPairs);
    }

    /** M3: re-id similarity in [-inf, 1] between a target's prototype and a bundle. */
    _bundleReid(target, bundle) {
        if (this.M.reid <= 0) return null;
        var d = this._descDist(target, bundle);
        if (d == null || !(d <= this.M.reidMaxDesc)) return null;
        return 1 - d / this.M.reidScale;
    }

    /**
     * M4 — how decisive was this frame's assignment?
     *
     * Returns (score of the best target->bundle matching) minus (score of the best
     * matching that is not it), i.e. how much better the winner is than the runner-up.
     * A large gap means the geometry is unambiguous; a small gap means the frame is a
     * near coin flip between two labellings.
     *
     * This is the quantity that matters for PERMANENCE. The loss decomposition says a
     * bad session loses ~0.3-0.4 IDF1 to roughly ONE swap — the whole result across
     * 7.2M camera-frames turns on a handful of frames. What makes such a frame
     * permanent is not the frame itself but that its decision is written into the
     * targets' 3D state: once a target's anchor sits on the other animal, every later
     * frame agrees with the mistake, which is why a swap cannot be detected afterwards.
     * Freezing the anchor on low-gap frames keeps the pre-interaction anchor intact so
     * geometry can still resolve the animals once they separate.
     *
     * Enumerates permutations, which is exact and fine at this size (2 animals; capped
     * at 6 targets = 720 orderings) and avoids a second Hungarian solve with a
     * forbidden edge. Returns null when the gap is not defined (fewer than 2 targets or
     * bundles, or too many to enumerate).
     */
    _permGap(score, N, B) {
        if (N < 2 || B < 2 || N > 6) return null;
        var best = -Infinity, second = -Infinity, bestPerm = null;
        var idx = [];
        for (var i = 0; i < B; i++) idx.push(i);

        var self = this;
        // Every injective map of the N targets onto the B bundles.
        (function walk(row, used, total, perm) {
            if (row === N) {
                if (total > best) { second = best; best = total; bestPerm = perm.slice(); }
                else if (total > second) { second = total; }
                return;
            }
            for (var c = 0; c < B; c++) {
                if (used[c]) continue;
                used[c] = true;
                perm.push(c);
                walk(row + 1, used, total + score[row][c], perm);
                perm.pop();
                used[c] = false;
            }
        })(0, new Array(B).fill(false), 0, []);

        if (!isFinite(best) || !isFinite(second)) return null;
        return { gap: best - second, perm: bestPerm };
    }

    _trackFrameBundled(detsByCam, camsOrder) {
        var built = this._buildBundles(detsByCam, camsOrder);
        var bundles = built.bundles;
        var N = this.targets.length, B = bundles.length;

        var wantDesc = this.M.reid > 0 || this.M.descProbe || this.M.descBlock > 0;
        if (wantDesc) {
            if (this._pairs == null && B > 0 && bundles[0].points3d != null) {
                this._pairs = descriptorPairs(points3dNodeCount(bundles[0].points3d),
                                              this.nodeWeights);
            }
            for (var b = 0; b < B; b++) {
                if (bundles[b].points3d != null && this._pairs != null) {
                    bundles[b].desc = describe(bundles[b].points3d, this._pairs);
                }
            }
        }

        var matchedBundle = new Array(B).fill(false);
        var ambiguous = false;
        if (N > 0 && B > 0) {
            var geom = [], full = [];
            for (var t = 0; t < N; t++) {
                geom[t] = []; full[t] = [];
                for (var d = 0; d < B; d++) {
                    var g = this._bundleGeom(this.targets[t], bundles[d]);
                    var r = this._bundleReid(this.targets[t], bundles[d]);
                    geom[t][d] = g;
                    full[t][d] = g + (r == null ? 0 : this.M.reid * r);
                }
            }
            var aFull = hungarianAlgorithm(neg(full));
            var assign = aFull;
            // M4: how decisive was this frame? Measured on the FULL score (whatever
            // terms are enabled), because that is what actually made the decision.
            if (this.M.ambigMargin > 0) {
                var g = this._permGap(full, N, B);
                if (g != null) {
                    this.stats.gapN++;
                    this.stats.gapSum += g.gap;
                    var cuts = this.stats.gapBelow;
                    for (var ck in cuts) if (g.gap < Number(ck)) cuts[ck]++;
                    if (g.gap < this.M.ambigMargin) {
                        ambiguous = true;
                        this.stats.ambigFrames++;
                    }
                }
            }
            // `reidSwapFrames`: adopt a re-id-driven disagreement only once it has
            // persisted, so descriptor noise cannot flip identities frame to frame.
            if (this.M.reid > 0 && this.M.reidSwapFrames > 0) {
                var aGeom = hungarianAlgorithm(neg(geom));
                var differs = false;
                for (var q = 0; q < N; q++) if (aGeom[q] !== aFull[q]) differs = true;
                if (differs) {
                    this._swapVote++;
                    if (this._swapVote < this.M.reidSwapFrames) assign = aGeom;
                    else { this.stats.reidFlips++; this._swapVote = 0; }
                } else {
                    this._swapVote = 0;
                    assign = aFull;
                }
            }
            for (var ti = 0; ti < N; ti++) {
                var bi = assign[ti];
                if (bi == null || bi < 0 || bi >= B) continue;
                if (full[ti][bi] < this.M.gateAdj) { this.stats.gated++; continue; }
                var bun = bundles[bi];
                for (var m = 0; m < bun.dets.length; m++) {
                    this.targets[ti].addDetection(bun.dets[m], true, ambiguous);
                }
                matchedBundle[bi] = true;
                if (wantDesc && bun.desc != null) {
                    var tgt = this.targets[ti];
                    if (this.M.descBlock > 0) this._blockAccumulate(ti, bun.desc);
                    // Measure BEFORE folding this bundle in, so `self` is a distance to
                    // the prototype as it stood, not to a prototype that already
                    // contains the thing being measured.
                    if (this.M.descProbe && B > 1) {
                        var dSelf = this._descDist(tgt, bun);
                        var dOther = null;
                        for (var ob = 0; ob < B; ob++) {
                            if (ob === bi) continue;
                            var dd = this._descDist(tgt, bundles[ob]);
                            if (dd != null && (dOther == null || dd < dOther)) dOther = dd;
                        }
                        if (dSelf != null && dOther != null) {
                            this.stats.descN++;
                            this.stats.descSelf += dSelf;
                            this.stats.descOther += dOther;
                            if (dSelf < dOther) this.stats.descSelfCloser++;
                        }
                    }
                    if (tgt._proto == null) {
                        tgt._proto = new Float64Array(bun.desc.length);
                        tgt._protoN = new Int32Array(bun.desc.length);
                    }
                    if (tgt._protoObs < this.M.reidFreeze) {
                        protoUpdate(tgt._proto, tgt._protoN, bun.desc, this.M.reidEma);
                    }
                    tgt._protoObs++;
                }
            }
        }

        // Unmatched bundles and orphan detections feed the shipped birth path.
        var byCam = new Map();
        for (var ci = 0; ci < camsOrder.length; ci++) byCam.set(camsOrder[ci].name, []);
        for (var bj = 0; bj < B; bj++) {
            if (matchedBundle[bj]) continue;
            for (var dj = 0; dj < bundles[bj].dets.length; dj++) {
                var dd = bundles[bj].dets[dj];
                byCam.get(dd.cam.name).push(dd);
            }
        }
        for (var oi = 0; oi < built.orphans.length; oi++) {
            var od = built.orphans[oi];
            byCam.get(od.cam.name).push(od);
        }
        this.unmatchedByCam = byCam;
        this._initializeTargets();
    }

    // ------------------------------------------------------------------
    // Birth  (unchanged from the shipped tracker)
    // ------------------------------------------------------------------

    _initializeTargets() {
        if (this.maxTargets != null && this.targets.length >= this.maxTargets) return;

        var viewsWithLeftovers = [];
        this.unmatchedByCam.forEach(function (list, camName) {
            if (list && list.length > 0) viewsWithLeftovers.push(camName);
        });
        if (viewsWithLeftovers.length < 2) return;

        var camNameA = viewsWithLeftovers[viewsWithLeftovers.length - 2];
        var camNameB = viewsWithLeftovers[viewsWithLeftovers.length - 1];
        var listA = this.unmatchedByCam.get(camNameA);
        var listB = this.unmatchedByCam.get(camNameB);
        var camA = listA[0].cam, camB = listB[0].cam;

        var F = this._fundamental(camA, camB);
        var ptsA = listA.map(function (d) { return d.pointsPixel; });
        var ptsB = listB.map(function (d) { return d.pointsPixel; });
        var cost = epipolarErrorMatrix(ptsA, ptsB, F);
        var assign = hungarianAlgorithm(cost);

        var usedA = new Set(), usedB = new Set();
        for (var i = 0; i < listA.length; i++) {
            if (this.maxTargets != null && this.targets.length >= this.maxTargets) break;
            var j = assign[i];
            if (j == null || j < 0 || j >= listB.length) continue;
            var target = new Target(this._nextTrackId++);
            target.addDetection(listA[i]);
            target.addDetection(listB[j]);
            if (this.active) {
                // A target born mid-frame must be scoreable by the remaining views.
                target._snapMean = target.frameIdxMean();
                target._snap3d = target.points3d;
                target._lastFrame = this._frame;
            }
            this.targets.push(target);
            usedA.add(i); usedB.add(j);
        }
        this.unmatchedByCam.set(camNameA, listA.filter(function (_, i) { return !usedA.has(i); }));
        this.unmatchedByCam.set(camNameB, listB.filter(function (_, j) { return !usedB.has(j); }));
    }

    _fundamental(camA, camB) {
        var key = camA.name + ':' + camB.name;
        if (!this._fCache[key]) this._fCache[key] = computeFundamentalMatrix(camA, camB);
        return this._fCache[key];
    }
}

/**
 * Mean of `vals` after discarding `frac` of the values from EACH tail (M6).
 *
 * Both tails, not just the low one. Trimming only the worst nodes would help the WRONG
 * animal more than the right one — the wrong match is the one with more bad nodes to
 * discard — which is backwards. Symmetric trimming is a robust location estimate: it
 * asks what the TYPICAL node says, so a match that is right about most nodes beats one
 * that is right about a few extreme ones. `frac` is clamped so at least one value
 * survives.
 */
function trimmedMean(vals, frac) {
    var n = vals.length;
    if (n === 0) return 0;
    var s = vals.slice().sort(function (a, b) { return a - b; });
    var k = Math.floor(n * Math.min(0.45, frac));
    var lo = k, hi = n - k;
    if (hi - lo < 1) { lo = (n - 1) >> 1; hi = lo + 1; }
    var sum = 0;
    for (var i = lo; i < hi; i++) sum += s[i];
    return sum / (hi - lo);
}

function indexOfName(pairs, name) {
    for (var i = 0; i < pairs.length; i++) if (pairs[i][0] === name) return i;
    return -1;
}

function neg(m) {
    var out = [];
    for (var i = 0; i < m.length; i++) {
        out[i] = [];
        for (var j = 0; j < m[i].length; j++) out[i][j] = -m[i][j];
    }
    return out;
}

function num(v, dflt) {
    return (typeof v === 'number' && isFinite(v)) ? v : dflt;
}
