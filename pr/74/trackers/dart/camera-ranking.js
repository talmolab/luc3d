/**
 * trackers/dart/camera-ranking.js — Dynamic per-camera quality ranking for DART.
 *
 * Replaces the "most-instances" anchor heuristic with a per-frame, per-camera
 * quality score. Cameras with occluded or low-confidence skeletons are
 * down-ranked and excluded from anchoring; top-2 cameras always anchor;
 * additional cameras participate only if their rank clears a threshold.
 *
 * Rank formula:
 *   rank = w1 * meanConfidence
 *        + w2 * completeness
 *        + w3 * (1 - normalizedReprojectionResidual)
 *        - w4 * recentOcclusionPenalty
 *
 * Exports:
 *   window.LucidDART.CameraRanker          — stateful ranker (one per session)
 *   window.LucidDART.rankCamerasStateless  — pure function variant for tests
 */

(function () {
    'use strict';

    var DEFAULT_CFG = {
        w1: 0.35,                    // meanConfidence (per-instance score)
        w2: 0.25,                    // completeness (cumulative frames-based reliability)
        w3: 0.25,                    // reprojection quality
        w4: 0.15,                    // occlusion penalty
        participationThreshold: 0.45,
        emaAlpha: 0.2,
        occlusionWindow: 10,
        occlusionDropThresh: 0.3,
        maxReprojPx: 50,
        hysteresisFrames: 3
    };

    // ============================================
    // Per-frame scoring primitives (pure)
    // ============================================

    function computeMeanConfidence(camEntry) {
        var instances = camEntry.instances || [];
        if (instances.length === 0) return 0;
        var total = 0, count = 0;
        for (var i = 0; i < instances.length; i++) {
            var s = instances[i] && instances[i].score;
            if (s == null || !isFinite(s)) s = 0;
            total += s;
            count++;
        }
        return count > 0 ? total / count : 0;
    }

    // Completeness is stateful and computed inline in rankCamerasStateless
    // using cumulative totalFramesSeen + per-cam instanceCount. A pure
    // helper doesn't make sense here because the signal is a historical
    // ratio, not a per-frame metric.

    function clamp01(x) {
        if (!isFinite(x)) return 0;
        if (x < 0) return 0;
        if (x > 1) return 1;
        return x;
    }

    // ============================================
    // Stateless single-frame rank (pure function)
    // ============================================

    /**
     * Compute per-camera ranks for one frame without mutating state.
     * Returns ranks + the new state values that a caller should persist.
     *
     * @param {Object} frameData - keyed by camera name:
     *   { [camName]: { instances: Array<{score}>,
     *                  reprojResidualPx?: number } }
     *   `instance.score` is the per-instance confidence (LUCID Instance.score).
     *   An entry with instances.length === 0 is valid and penalizes the
     *   camera's cumulative completeness.
     * @param {number} expectedAnimalCount
     * @param {Object} [priorState]
     * @param {Object} [priorState.emaResidual]        {[cam]: number}
     * @param {Object} [priorState.baselineConfidence] {[cam]: number}
     * @param {Object} [priorState.occlusionQueue]     {[cam]: number[]}
     * @param {Object} [priorState.belowCount]         {[cam]: number}
     * @param {Object} [priorState.aboveCount]         {[cam]: number}
     * @param {Object} [priorState.admitted]           {[cam]: boolean}
     * @param {number} [priorState.totalFramesSeen]    cumulative rankFrame call count
     * @param {Object} [priorState.instanceCount]      {[cam]: number}  cumulative sum of instances.length
     * @param {Object} [cfg]
     */
    function rankCamerasStateless(frameData, expectedAnimalCount, priorState, cfg) {
        cfg = mergeConfig(cfg);
        priorState = priorState || {};
        var prevEma        = priorState.emaResidual        || {};
        var prevBaseline   = priorState.baselineConfidence || {};
        var prevOccQueue   = priorState.occlusionQueue     || {};
        var prevBelow      = priorState.belowCount         || {};
        var prevAbove      = priorState.aboveCount         || {};
        var prevAdmitted   = priorState.admitted           || {};
        var prevTotal      = priorState.totalFramesSeen    || 0;
        var prevInstCount  = priorState.instanceCount      || {};

        var camNames = Object.keys(frameData || {}).sort();  // deterministic order

        // Advance the global frame counter once per rankFrame call.
        var newTotal = prevTotal + 1;
        var expected = Math.max(1, expectedAnimalCount || 1);

        var ranks = {};
        var debug = {};
        var newEma = {};
        var newBaseline = {};
        var newOccQueue = {};
        var newBelow = {};
        var newAbove = {};
        var newAdmitted = {};
        // Carry prior per-cam instance counts forward so cameras absent from
        // current frameData retain their accumulated history.
        var newInstCount = {};
        for (var kcam in prevInstCount) newInstCount[kcam] = prevInstCount[kcam];

        // ---- Phase 1: per-camera metrics + rank ----
        for (var ci = 0; ci < camNames.length; ci++) {
            var cam = camNames[ci];
            var entry = frameData[cam] || { instances: [] };
            var instances = entry.instances || [];

            var meanConf = computeMeanConfidence(entry);

            // Cumulative completeness: total instances observed / (total frames × expected animals).
            // Averaged across animals (not summed) by dividing by expectedAnimalCount.
            var priorInst = prevInstCount[cam] || 0;
            var updatedInst = priorInst + instances.length;
            newInstCount[cam] = updatedInst;
            var completeness = updatedInst / (newTotal * expected);
            if (completeness > 1) completeness = 1;
            if (completeness < 0 || !isFinite(completeness)) completeness = 0;

            // Reprojection EMA — only advance the EMA if this frame provided a residual.
            var priorEma = (cam in prevEma) ? prevEma[cam] : 0.5;
            var residualNorm;
            if (typeof entry.reprojResidualPx === 'number' && isFinite(entry.reprojResidualPx)) {
                var cur = clamp01(entry.reprojResidualPx / cfg.maxReprojPx);
                residualNorm = cfg.emaAlpha * cur + (1 - cfg.emaAlpha) * priorEma;
            } else {
                residualNorm = priorEma;
            }
            newEma[cam] = residualNorm;

            // Occlusion detection: below expected count + confidence dropped
            // from baseline by > occlusionDropThresh.
            var baseline = (cam in prevBaseline) ? prevBaseline[cam] : meanConf;
            var occludedNow = 0;
            if (entry.instances.length < expectedAnimalCount &&
                (baseline - meanConf) > cfg.occlusionDropThresh) {
                occludedNow = 1;
            }
            var q = (prevOccQueue[cam] || []).slice();
            q.push(occludedNow);
            while (q.length > cfg.occlusionWindow) q.shift();
            newOccQueue[cam] = q;
            var occlusionPenalty = q.reduce(function (a, b) { return a + b; }, 0) / cfg.occlusionWindow;

            // Baseline EMA — updated only if we had observations this frame.
            newBaseline[cam] = entry.instances.length > 0
                ? cfg.emaAlpha * meanConf + (1 - cfg.emaAlpha) * baseline
                : baseline;

            var rank = cfg.w1 * meanConf
                     + cfg.w2 * completeness
                     + cfg.w3 * (1 - residualNorm)
                     - cfg.w4 * occlusionPenalty;

            // Cameras with zero instances collapse to rank 0 (still reported).
            if (entry.instances.length === 0) rank = 0;

            ranks[cam] = rank;
            debug[cam] = {
                meanConfidence: meanConf,
                completeness: completeness,
                emaResidual: residualNorm,
                occlusionPenalty: occlusionPenalty,
                baselineConfidence: newBaseline[cam]
            };
        }

        // ---- Phase 2: hysteresis on participation ----
        // "admitted" is a sticky flag. A camera toggles only after hysteresisFrames
        // consecutive frames strictly across the participationThreshold.
        for (var ci2 = 0; ci2 < camNames.length; ci2++) {
            var cam2 = camNames[ci2];
            var r = ranks[cam2];
            var below = (cam2 in prevBelow) ? prevBelow[cam2] : 0;
            var above = (cam2 in prevAbove) ? prevAbove[cam2] : 0;
            var admitted = (cam2 in prevAdmitted) ? !!prevAdmitted[cam2] : (r > cfg.participationThreshold);

            if (r > cfg.participationThreshold) {
                above = above + 1;
                below = 0;
                if (!admitted && above >= cfg.hysteresisFrames) admitted = true;
            } else if (r < cfg.participationThreshold) {
                below = below + 1;
                above = 0;
                if (admitted && below >= cfg.hysteresisFrames) admitted = false;
            }
            // Exact equality: no counter change, keep flags.
            newBelow[cam2] = below;
            newAbove[cam2] = above;
            newAdmitted[cam2] = admitted;
        }

        // ---- Phase 3: select participating cameras ----
        var selected = selectParticipatingCameras(ranks, newAdmitted, cfg.participationThreshold);

        return {
            ranks: ranks,
            selected: selected,
            debug: debug,
            newEmaResiduals: newEma,
            newBaselineConfidences: newBaseline,
            newOcclusionQueue: newOccQueue,
            newBelowCount: newBelow,
            newAboveCount: newAbove,
            newAdmitted: newAdmitted,
            newTotalFramesSeen: newTotal,
            newInstanceCount: newInstCount
        };
    }

    /**
     * Top-2 always anchor. Additional cameras participate only if admitted
     * (hysteresis-gated) AND above the threshold. Deterministic tie-break by
     * camera name when ranks are equal.
     */
    function selectParticipatingCameras(ranks, admittedFlags, participationThreshold) {
        var entries = [];
        var names = Object.keys(ranks);
        for (var i = 0; i < names.length; i++) entries.push([names[i], ranks[names[i]]]);
        entries.sort(function (a, b) {
            if (b[1] !== a[1]) return b[1] - a[1];
            return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
        });

        var anchors = entries.slice(0, 2).map(function (e) { return e[0]; });
        var additional = [];
        for (var j = 2; j < entries.length; j++) {
            var name = entries[j][0];
            var rank = entries[j][1];
            var admitted = admittedFlags ? !!admittedFlags[name] : (rank > participationThreshold);
            if (admitted && rank > participationThreshold) additional.push(name);
        }
        return {
            anchors: anchors,
            additional: additional,
            ordered: anchors.concat(additional)
        };
    }

    function mergeConfig(cfg) {
        var out = {};
        for (var k in DEFAULT_CFG) out[k] = DEFAULT_CFG[k];
        if (cfg) {
            for (var k2 in cfg) if (cfg[k2] != null) out[k2] = cfg[k2];
        }
        return out;
    }

    // ============================================
    // Stateful ranker (one per session)
    // ============================================

    function CameraRanker(cfg) {
        this._cfg = mergeConfig(cfg);
        this._state = freshState();
    }

    function freshState() {
        return {
            emaResidual: {},
            baselineConfidence: {},
            occlusionQueue: {},
            belowCount: {},
            aboveCount: {},
            admitted: {},
            totalFramesSeen: 0,
            instanceCount: {}
        };
    }

    CameraRanker.prototype.rankFrame = function (frameData, expectedAnimalCount) {
        var result = rankCamerasStateless(
            frameData, expectedAnimalCount, this._state, this._cfg
        );
        this._state.emaResidual        = result.newEmaResiduals;
        this._state.baselineConfidence = result.newBaselineConfidences;
        this._state.occlusionQueue     = result.newOcclusionQueue;
        this._state.belowCount         = result.newBelowCount;
        this._state.aboveCount         = result.newAboveCount;
        this._state.admitted           = result.newAdmitted;
        this._state.totalFramesSeen    = result.newTotalFramesSeen;
        this._state.instanceCount      = result.newInstanceCount;
        return {
            ranks: result.ranks,
            selected: result.selected,
            debug: result.debug
        };
    };

    CameraRanker.prototype.reset = function () {
        this._state = freshState();
    };

    CameraRanker.prototype.getConfig = function () {
        var out = {};
        for (var k in this._cfg) out[k] = this._cfg[k];
        return out;
    };

    // ============================================
    // Export
    // ============================================

    var root = (typeof window !== 'undefined') ? window : (typeof global !== 'undefined' ? global : this);
    root.LucidDART = root.LucidDART || {};
    root.LucidDART.CameraRanker = CameraRanker;
    root.LucidDART.rankCamerasStateless = rankCamerasStateless;
    root.LucidDART.selectParticipatingCameras = selectParticipatingCameras;
})();
