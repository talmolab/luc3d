/**
 * ui/inference-args.js — the `sleap-nn predict` argument list for one camera
 * view, ported from sleap-app's `src/platform/inferenceArgs.ts`
 * (`buildInferenceArgs`, `pickInferenceSubcommand`) and its panel defaults
 * (`InferencePanel.tsx` `DEFAULTS`).
 *
 * LUCID runs sleap-nn on each view's VIDEO FILE (never on a project .slp: a
 * LUCID project holds many views and its videos are read as browser Files),
 * so `--data_path` is always a video, there is never a `--video_index`, and
 * every frame selection reaches sleap-nn as an explicit `--frames` list
 * (`--only_labeled_frames` and friends only mean something on a .slp input).
 *
 * Training will get its own builder (`ui/training-args.js`); the desktop side
 * checks every argument against a per-subcommand allowlist
 * (`src-tauri/src/sleap_nn_args.rs`), so a flag added here must be added there.
 *
 * Import-free (Node tests: tests/test-inference-args.mjs).
 */

/** sleap-nn's `predict` pipeline is reliable from this version on (sleap-app's gate). */
export const MIN_SLEAP_NN_PREDICT_VERSION = '0.3.2';

/** sleap-app InferencePanel `DEFAULTS` (+ the Data section's own defaults). */
export const INFERENCE_DEFAULTS = Object.freeze({
    pipeline: 'top-down',
    trackOnly: false,
    frameRange: 'video',
    frameStart: 0,
    frameEnd: 1000,
    sampleCount: 20,
    excludeUserLabeled: false,
    existingPredictions: 'replace',
    batchSize: 4,
    device: 'auto',
    runtime: 'auto',
    maxInstances: null,
    peakThreshold: 0.2,
    integralRefinement: true,
    integralPatchSize: 5,
    nPoints: 10,
    maxEdgeLengthRatio: 0.25,
    distPenaltyWeight: 1.0,
    minLineScores: 0.25,
    tracking: false,
    trackerMethod: 'simple',
    similarityMethod: 'oks',
    matchingMethod: 'hungarian',
    trackingWindowSize: 5,
    maxTracks: null,
    connectSingleBreaks: false,
    robust: 0.95,
    minMatchPoints: 0,
    minNewTrackPoints: 0,
    scoringReduction: 'mean',
    trackingTargetInstanceCount: null,
    trackingPreCullToTarget: false,
    trackingPreCullIouThreshold: 0,
    trackingCleanInstanceCount: null,
    trackingCleanIouThreshold: 0,
    flowImgScale: 1.0,
    flowWindowSize: 21,
    flowMaxLevels: 3,
    kfTrackFeatures: 'centroid',
    kfInitFrameCount: 10,
    kfNodeIndices: [],
    kfResetGapSize: 5,
    ensureChannels: 'auto',
    filterOverlapping: false,
    filterMethod: 'iou',
    filterThreshold: 0.8,
    filterMinVisibleNodes: null,
    filterMinVisibleNodeFraction: null,
    filterMinMeanNodeScore: null,
    filterMinInstanceScore: null,
    filterMinCentroidDistance: null,
});

/** A fresh, mutable copy of the defaults. */
export function defaultInferenceConfig() {
    var c = {};
    for (var k in INFERENCE_DEFAULTS) {
        var v = INFERENCE_DEFAULTS[k];
        c[k] = Array.isArray(v) ? v.slice() : v;
    }
    c.modelPaths = [];
    // Future per-view models: camera name -> model folder list. Empty = every
    // view uses `modelPaths` (the only mode the UI offers today).
    c.perViewModels = {};
    return c;
}

/** The models one view runs with: its own slot if set, else the shared list. */
export function modelsForView(config, viewName) {
    var own = config.perViewModels && config.perViewModels[viewName];
    return (own && own.length) ? own.slice() : (config.modelPaths || []).slice();
}

/**
 * Frame indices → sleap-nn's `--frames` value. sleap-nn (0.3.5) accepts ONE
 * range `a-b` or a plain comma list `1,2,3`, never a mix (`0-4,10-11` fails
 * with "invalid literal for int()"), so: one contiguous run → "a-b" (or "a"),
 * anything else → every frame listed. Sorted, de-duplicated. Empty → "".
 */
export function framesToSpec(frames) {
    var f = Array.from(new Set(frames.filter(function (x) {
        return Number.isInteger(x) && x >= 0;
    }))).sort(function (a, b) { return a - b; });
    if (f.length === 0) return '';
    if (f.length === 1) return String(f[0]);
    if (f[f.length - 1] - f[0] === f.length - 1) return f[0] + '-' + f[f.length - 1];
    return f.join(',');
}

/** `n` distinct frames from [0, nFrames), sorted (all of them when n >= nFrames). */
export function sampleFrames(nFrames, n, rand) {
    var r = typeof rand === 'function' ? rand : Math.random;
    if (n >= nFrames) {
        var all = [];
        for (var a = 0; a < nFrames; a++) all.push(a);
        return all;
    }
    var picked = new Set();
    while (picked.size < n) picked.add(Math.floor(r() * nFrames));
    return Array.from(picked).sort(function (x, y) { return x - y; });
}

/**
 * Which frames one view's job runs on, before the user-labeled exclusion.
 * `null` = the whole video (no `--frames`). Throws on an invalid target.
 *
 * @param {Object} config  `frameRange`, `frameStart`, `frameEnd`
 * @param {{currentFrame:number, sampledFrames?:number[], labeledFrames?:number[], predictedFrames?:number[]}} ctx
 * @returns {number[]|null}
 */
export function targetFrames(config, ctx) {
    switch (config.frameRange) {
        case 'video': return null;
        case 'frame': return [ctx.currentFrame];
        case 'custom': {
            var s = Number(config.frameStart), e = Number(config.frameEnd);
            if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < s) {
                throw new Error('Invalid custom range');
            }
            var out = [];
            for (var i = s; i <= e; i++) out.push(i);
            return out;
        }
        case 'random':
            if (!ctx.sampledFrames || ctx.sampledFrames.length === 0) throw new Error('Random sample needs sampled frames');
            return ctx.sampledFrames.slice();
        case 'user_labeled': return (ctx.labeledFrames || []).slice();
        case 'predicted': return (ctx.predictedFrames || []).slice();
        default: throw new Error('Unhandled inference target: ' + config.frameRange);
    }
}

/**
 * Build `sleap-nn <subcommand> …` (without the program) for one view.
 * Same flag order and opt-in rules as sleap-app's `buildInferenceArgs`.
 *
 * @param {Object} config  see `defaultInferenceConfig`
 * @param {{dataPath:string, outputPath:string, modelPaths:string[], frames?:number[]|null, subcommand?:string}} opts
 *   `frames`: explicit frame list (null/undefined = whole video).
 */
export function buildInferenceArgs(config, opts) {
    var subcommand = opts.subcommand || 'predict';
    var args = [subcommand, '--gui'];
    args.push('--data_path', opts.dataPath);
    (opts.modelPaths || []).forEach(function (mp) { args.push('--model_paths', mp); });
    args.push('--output_path', opts.outputPath);

    if (opts.frames != null) {
        var spec = framesToSpec(opts.frames);
        if (!spec) throw new Error('No frames to run inference on');
        args.push('--frames', spec);
    }

    args.push('--batch_size', String(config.batchSize));
    args.push('--device', config.device);
    if (subcommand === 'predict' && config.runtime && config.runtime !== 'auto') {
        args.push('--runtime', config.runtime);
    }
    if (config.maxInstances != null) args.push('--max_instances', String(config.maxInstances));
    args.push('--peak_threshold', String(config.peakThreshold));

    if (config.integralRefinement) {
        args.push('--integral_refinement', 'integral');
        args.push('--integral_patch_size', String(config.integralPatchSize));
    }
    if (config.pipeline === 'bottom-up' || config.pipeline === 'bottom-up-id') {
        args.push('--n_points', String(config.nPoints));
        args.push('--max_edge_length_ratio', String(config.maxEdgeLengthRatio));
        args.push('--dist_penalty_weight', String(config.distPenaltyWeight));
        args.push('--min_line_scores', String(config.minLineScores));
    }

    if (config.ensureChannels === 'rgb') args.push('--ensure_rgb');
    else if (config.ensureChannels === 'grayscale') args.push('--ensure_grayscale');

    if (config.tracking) {
        args.push('--tracking');
        if (config.trackerMethod === 'flow') {
            args.push('--use_flow');
            args.push('--of_img_scale', String(config.flowImgScale));
            args.push('--of_window_size', String(config.flowWindowSize));
            args.push('--of_max_levels', String(config.flowMaxLevels));
        } else if (config.trackerMethod === 'kalman') {
            args.push('--use_kalman');
            args.push('--kf_track_features', config.kfTrackFeatures);
            args.push('--kf_init_frame_count', String(config.kfInitFrameCount));
            args.push('--kf_reset_gap_size', String(config.kfResetGapSize));
            if (config.kfNodeIndices && config.kfNodeIndices.length > 0) {
                args.push('--kf_node_indices', config.kfNodeIndices.join(','));
            }
        }
        if (config.similarityMethod === 'centroids') {
            args.push('--features', 'centroids');
            args.push('--scoring_method', 'euclidean_dist');
        } else {
            args.push('--scoring_method', config.similarityMethod);
        }
        args.push('--track_matching_method', config.matchingMethod);
        args.push('--tracking_window_size', String(config.trackingWindowSize));
        if (config.maxTracks != null) args.push('--max_tracks', String(config.maxTracks));
        args.push('--robust_best_instance', String(config.robust));
        if (config.connectSingleBreaks) args.push('--post_connect_single_breaks');
        args.push('--min_match_points', String(config.minMatchPoints));
        args.push('--min_new_track_points', String(config.minNewTrackPoints));
        args.push('--scoring_reduction', config.scoringReduction);
        if (config.trackingTargetInstanceCount != null) {
            args.push('--tracking_target_instance_count', String(config.trackingTargetInstanceCount));
        }
        if (config.trackingPreCullToTarget) {
            args.push('--tracking_pre_cull_to_target', '1');
            args.push('--tracking_pre_cull_iou_threshold', String(config.trackingPreCullIouThreshold));
        }
        if (config.trackingCleanInstanceCount != null) {
            args.push('--tracking_clean_instance_count', String(config.trackingCleanInstanceCount));
            args.push('--tracking_clean_iou_threshold', String(config.trackingCleanIouThreshold));
        }
    }

    if (config.filterOverlapping) {
        args.push('--filter_overlapping');
        args.push('--filter_overlapping_method', config.filterMethod);
        args.push('--filter_overlapping_threshold', String(config.filterThreshold));
    }
    if (config.filterMinVisibleNodes != null) args.push('--filter_min_visible_nodes', String(config.filterMinVisibleNodes));
    if (config.filterMinVisibleNodeFraction != null) args.push('--filter_min_visible_node_fraction', String(config.filterMinVisibleNodeFraction));
    if (config.filterMinMeanNodeScore != null) args.push('--filter_min_mean_node_score', String(config.filterMinMeanNodeScore));
    if (config.filterMinInstanceScore != null) args.push('--filter_min_instance_score', String(config.filterMinInstanceScore));
    if (config.filterMinCentroidDistance != null) args.push('--filter_min_centroid_distance', String(config.filterMinCentroidDistance));
    return args;
}

/** Compare dotted numeric versions. -1 | 0 | 1; unparseable parts compare equal. */
export function compareVersions(a, b) {
    var pa = String(a).split('.').map(function (n) { return parseInt(n, 10); });
    var pb = String(b).split('.').map(function (n) { return parseInt(n, 10); });
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
        var x = pa[i] == null ? 0 : pa[i];
        var y = pb[i] == null ? 0 : pb[i];
        if (Number.isNaN(x) || Number.isNaN(y)) return 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

/** `predict` from 0.3.2 (or an unknown version), else the legacy `track`. */
export function pickInferenceSubcommand(version) {
    if (!version) return 'predict';
    var core = String(version).trim().split(/[-+ ]/)[0];
    if (!/^\d+(\.\d+)*$/.test(core)) return 'predict';
    return compareVersions(core, MIN_SLEAP_NN_PREDICT_VERSION) >= 0 ? 'predict' : 'track';
}

/**
 * A `--gui` progress line → {nProcessed, nTotal, rate, eta}, else null.
 * sleap-nn prints one JSON object per line on stdout.
 */
export function parseProgressLine(line) {
    var s = String(line || '').trim();
    if (s.charAt(0) !== '{') return null;
    try {
        var d = JSON.parse(s);
        if (d && typeof d === 'object' && 'n_processed' in d && 'n_total' in d) {
            return { nProcessed: Number(d.n_processed) || 0, nTotal: Number(d.n_total) || 0,
                rate: Number(d.rate) || 0, eta: Number(d.eta) || 0 };
        }
    } catch (e) { /* not JSON */ }
    return null;
}

/** sleap-app `formatDuration`. */
export function formatDuration(ms) {
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

/** sleap-app `formatEta`. */
export function formatEta(seconds) {
    if (seconds <= 0) return '0s';
    var m = Math.floor(seconds / 60);
    var s = Math.round(seconds % 60);
    return m > 0 ? m + 'm ' + s + 's' : s + 's';
}
