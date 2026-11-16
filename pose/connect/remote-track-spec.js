/**
 * Port of sleap-app src/lib/remoteTrackSpec.ts @ 683a159.
 *
 * Builds the protocol-v1 `track` job spec(s) for an `InferenceConfig`. Pure: everything it
 * needs from the live app (current frame/video, per-video frame counts) is passed in via
 * the `RemoteTrackSpecContext`.
 *
 * LUCID changes: types are JSDoc (the TypeScript imports are gone); the logic is verbatim.
 * LUCID runs one job per (session, camera), so its caller passes that camera's video as the
 * only entry of `videoFrameCounts`.
 *
 * @typedef {Record<string, any>} InferenceConfig
 * @typedef {Record<string, any>} TrackJobSpec
 * @typedef {object} RemoteTrackSpecContext
 * @property {string} dataPath Worker-side labels/data path.
 * @property {Record<string, string>} pathMappings
 * @property {number[]} videoFrameCounts Frame count of each project video, in `labels.videos` order.
 * @property {number} currentFrameIdx Current frame index (for the "frame" target).
 * @property {number} activeVideoFrameCount Frame count of the active video (for "random_video").
 * @property {() => number} [random] Injectable RNG for tests; defaults to Math.random.
 * @property {number[]} [allowedVideoIndices] Restrict specs to these video indices (post-training
 *   inference when the worker can't see every video). Omitted = unrestricted. An implicit
 *   every-video target then emits one spec PER allowed video pinned via `video_index`; a target
 *   naming one video is dropped (`[]`) when that video isn't allowed.
 */
// frame_filter: only for filter-based targets (worker-side filtering).
// Matches the PyQt GUI's _track_target_to_spec_fields mapper in dialog.py.
/** @type {Record<string, string>} */
const FILTER_MAP = {
  suggestions: "suggested",
  user_labeled: "user",
  predicted: "predicted",
};

/** Sample `count` distinct sorted indices from [0, totalFrames). */
function sampleRandom(totalFrames, count, random) {
  const n = Math.min(count, totalFrames);
  const indices = Array.from({ length: totalFrames }, (_, i) => i);
  // Fisher-Yates shuffle, take first n
  for (let i = indices.length - 1; i > 0 && i >= indices.length - n; i--) {
    const j = Math.floor(random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(indices.length - n).sort((a, b) => a - b);
}

/**
 * Model/tracking/filter fields common to every track spec of a run.
 * @param {InferenceConfig} config
 */
function trackOptionFields(config) {
  return {
    model_paths: config.modelPaths,
    batch_size: config.batchSize,
    peak_threshold: config.peakThreshold,
    exclude_user_labeled: config.excludeUserLabeled || undefined,
    robust: config.tracking ? config.robust : undefined,
    ensure_channels: config.ensureChannels !== "auto" ? config.ensureChannels : undefined,
    tracker: config.tracking ? config.trackerMethod : undefined,
    similarity: config.tracking ? config.similarityMethod : undefined,
    match: config.tracking ? config.matchingMethod : undefined,
    track_window: config.tracking ? config.trackingWindowSize : undefined,
    max_tracks: config.tracking && config.maxTracks != null ? config.maxTracks : undefined,
    connect_single_breaks: config.tracking && config.connectSingleBreaks ? true : undefined,
    min_match_points: config.tracking ? config.minMatchPoints : undefined,
    min_new_track_points: config.tracking ? config.minNewTrackPoints : undefined,
    scoring_reduction: config.tracking ? config.scoringReduction : undefined,
    tracking_target_instance_count:
      config.tracking && config.trackingTargetInstanceCount != null
        ? config.trackingTargetInstanceCount
        : undefined,
    tracking_pre_cull_to_target:
      config.tracking && config.trackingPreCullToTarget ? true : undefined,
    tracking_pre_cull_iou_threshold:
      config.tracking && config.trackingPreCullToTarget
        ? config.trackingPreCullIouThreshold
        : undefined,
    tracking_clean_instance_count:
      config.tracking && config.trackingCleanInstanceCount != null
        ? config.trackingCleanInstanceCount
        : undefined,
    tracking_clean_iou_threshold:
      config.tracking && config.trackingCleanInstanceCount != null
        ? config.trackingCleanIouThreshold
        : undefined,
    of_img_scale: config.tracking && config.trackerMethod === "flow" ? config.flowImgScale : undefined,
    of_window_size:
      config.tracking && config.trackerMethod === "flow" ? config.flowWindowSize : undefined,
    of_max_levels:
      config.tracking && config.trackerMethod === "flow" ? config.flowMaxLevels : undefined,
    use_kalman: config.tracking && config.trackerMethod === "kalman" ? true : undefined,
    kf_track_features:
      config.tracking && config.trackerMethod === "kalman" ? config.kfTrackFeatures : undefined,
    kf_init_frame_count:
      config.tracking && config.trackerMethod === "kalman" ? config.kfInitFrameCount : undefined,
    kf_node_indices:
      config.tracking && config.trackerMethod === "kalman" && config.kfNodeIndices.length > 0
        ? config.kfNodeIndices.join(",")
        : undefined,
    kf_reset_gap_size:
      config.tracking && config.trackerMethod === "kalman" ? config.kfResetGapSize : undefined,
    filter_overlapping: config.filterOverlapping || undefined,
    filter_overlapping_method: config.filterOverlapping ? config.filterMethod : undefined,
    filter_overlapping_threshold: config.filterOverlapping ? config.filterThreshold : undefined,
    filter_min_visible_nodes: config.filterMinVisibleNodes ?? undefined,
    filter_min_visible_node_fraction: config.filterMinVisibleNodeFraction ?? undefined,
    filter_min_mean_node_score: config.filterMinMeanNodeScore ?? undefined,
    filter_min_instance_score: config.filterMinInstanceScore ?? undefined,
    filter_min_centroid_distance: config.filterMinCentroidDistance ?? undefined,
  };
}

/**
 * @param {InferenceConfig} config
 * @param {RemoteTrackSpecContext} ctx
 * @returns {TrackJobSpec[]}
 *
 * One spec for every target except "random" (random sample across all
 * videos), which a single track job can't express — that returns one spec
 * per non-empty video, each with its own sampled `frames`.
 */
export function buildRemoteTrackSpecs(config, ctx) {
  const random = ctx.random ?? Math.random;
  const pathMappings = Object.keys(ctx.pathMappings).length > 0 ? ctx.pathMappings : undefined;
  const target = typeof config.frameRange === "string" ? config.frameRange : null;
  const currentVideoIdx = config.videoIndex !== "all" ? config.videoIndex : undefined;
  const isAllowed = (i) => !ctx.allowedVideoIndices || ctx.allowedVideoIndices.includes(i);

  if (target === "random") {
    /** @type {TrackJobSpec[]} */
    const specs = [];
    ctx.videoFrameCounts.forEach((nFrames, i) => {
      if (nFrames === 0 || !isAllowed(i)) return;
      specs.push({
        type: "track",
        data_path: ctx.dataPath,
        ...trackOptionFields(config),
        video_index: i,
        frames: sampleRandom(nFrames, config.sampleCount, random).join(","),
        path_mappings: pathMappings,
      });
    });
    return specs;
  }

  // frames + video_index: depends on target type. all_videos, suggestions,
  // user_labeled, predicted need neither.
  /** @type {string | undefined} */
  let frames;
  /** @type {number | undefined} */
  let videoIndex;
  if (typeof config.frameRange === "object") {
    frames = `${config.frameRange.start}-${config.frameRange.end}`;
    videoIndex = currentVideoIdx;
  } else if (target === "frame") {
    frames = String(ctx.currentFrameIdx);
    videoIndex = currentVideoIdx;
  } else if (target === "video") {
    videoIndex = currentVideoIdx;
  } else if (target === "random_video") {
    // Client-side random sampling: pick N frames from the current video.
    if (ctx.activeVideoFrameCount > 0) {
      frames = sampleRandom(ctx.activeVideoFrameCount, config.sampleCount, random).join(",");
    }
    videoIndex = currentVideoIdx;
  }

  const buildSpec = (vi) => ({
    type: "track",
    data_path: ctx.dataPath,
    ...trackOptionFields(config),
    frame_filter: target && target in FILTER_MAP ? FILTER_MAP[target] : undefined,
    video_index: vi,
    frames,
    path_mappings: pathMappings,
  });

  // A target that already names one specific video: unchanged if it's
  // allowed, dropped entirely otherwise (never widened to other videos).
  if (videoIndex !== undefined) {
    return isAllowed(videoIndex) ? [buildSpec(videoIndex)] : [];
  }

  // An implicit "every video" target (all_videos/suggestions/user_labeled/
  // predicted): one spec covering every video server-side when
  // unrestricted, else one spec per allowed video (see the doc comment on
  // `allowedVideoIndices` — there's no "all except these" to ask the worker
  // for instead).
  return ctx.allowedVideoIndices ? ctx.allowedVideoIndices.map(buildSpec) : [buildSpec(undefined)];
}
