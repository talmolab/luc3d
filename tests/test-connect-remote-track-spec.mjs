/**
 * Port of sleap-app tests/unit/remoteTrackSpec.test.ts @ 683a159.
 *
 * sleap-app builds its config with trainingStore's `buildPostTrainingInferenceConfig`
 * (LUCID has no training store); `BASE_CONFIG` is a minimal config with the same defaults
 * for the fields these tests touch. Added: option-field mapping, sampleCount, pathMappings,
 * and `buildRunInferenceSpecs`'s new default dependency.
 */
import { describe, it, expect, run } from './bun-test-shim.mjs';
import { buildRemoteTrackSpecs } from '../pose/connect/remote-track-spec.js';
import { buildRunInferenceSpecs } from '../pose/connect/launcher-spec.js';

const BASE_CONFIG = {
  modelPaths: ["/worker/model"],
  batchSize: 4,
  peakThreshold: 0.2,
  excludeUserLabeled: false,
  tracking: false,
  ensureChannels: "auto",
  sampleCount: 10,
  filterOverlapping: false,
  kfNodeIndices: [],
};

function makeConfig(frameRange, videoIndex = "all") {
  return { ...BASE_CONFIG, videoIndex, frameRange };
}

function makeCtx(overrides = {}) {
  return {
    dataPath: "/worker/labels.slp",
    pathMappings: {},
    videoFrameCounts: [100, 100, 100],
    currentFrameIdx: 5,
    activeVideoFrameCount: 100,
    ...overrides,
  };
}

describe("buildRemoteTrackSpecs — unrestricted (allowedVideoIndices omitted, existing behavior)", () => {
  it("'all_videos' (an implicit all-scope target): one spec, no video_index", () => {
    const specs = buildRemoteTrackSpecs(makeConfig("all_videos"), makeCtx());
    expect(specs).toHaveLength(1);
    expect(specs[0].video_index).toBeUndefined();
  });

  it("'suggestions': one spec, frame_filter 'suggested', no video_index", () => {
    const specs = buildRemoteTrackSpecs(makeConfig("suggestions"), makeCtx());
    expect(specs).toHaveLength(1);
    expect(specs[0].frame_filter).toBe("suggested");
    expect(specs[0].video_index).toBeUndefined();
  });

  it("'video': one spec pinned to the current video index", () => {
    const specs = buildRemoteTrackSpecs(makeConfig("video", 1), makeCtx());
    expect(specs).toEqual([expect.objectContaining({ video_index: 1 })]);
  });

  it("'frame': one spec with the current frame and video index", () => {
    const specs = buildRemoteTrackSpecs(makeConfig("frame", 2), makeCtx({ currentFrameIdx: 42 }));
    expect(specs).toEqual([expect.objectContaining({ video_index: 2, frames: "42" })]);
  });

  it("'random': one spec per non-empty video, each with sampled frames", () => {
    const specs = buildRemoteTrackSpecs(
      makeConfig("random"),
      makeCtx({ videoFrameCounts: [10, 0, 10], random: () => 0.5 }),
    );
    expect(specs.map((s) => s.video_index)).toEqual([0, 2]); // video 1 skipped (empty)
  });

  it("a frame-range object target: one spec with 'start-end' frames pinned to the current video", () => {
    const specs = buildRemoteTrackSpecs(makeConfig({ start: 10, end: 20 }, 0), makeCtx());
    expect(specs).toEqual([expect.objectContaining({ video_index: 0, frames: "10-20" })]);
  });
});

describe("buildRemoteTrackSpecs — allowedVideoIndices (PR3a restricted-coverage post-training inference)", () => {
  it("an all-scope target emits one spec per allowed video, each pinned via video_index", () => {
    const specs = buildRemoteTrackSpecs(
      makeConfig("suggestions"),
      makeCtx({ allowedVideoIndices: [0, 2] }),
    );
    expect(specs.map((s) => s.video_index)).toEqual([0, 2]);
    expect(specs.every((s) => s.frame_filter === "suggested")).toBe(true);
  });

  it("an all-scope target with no allowed videos returns no specs", () => {
    const specs = buildRemoteTrackSpecs(makeConfig("all_videos"), makeCtx({ allowedVideoIndices: [] }));
    expect(specs).toEqual([]);
  });

  it("'random' additionally filters out disallowed videos (on top of the existing empty-video filter)", () => {
    const specs = buildRemoteTrackSpecs(
      makeConfig("random"),
      makeCtx({ videoFrameCounts: [10, 10, 10], allowedVideoIndices: [1], random: () => 0.5 }),
    );
    expect(specs.map((s) => s.video_index)).toEqual([1]);
  });

  it("a single-video target whose video is allowed is unchanged", () => {
    const specs = buildRemoteTrackSpecs(
      makeConfig("video", 1),
      makeCtx({ allowedVideoIndices: [0, 1] }),
    );
    expect(specs).toEqual([expect.objectContaining({ video_index: 1 })]);
  });

  it("a single-video target whose video is NOT allowed is dropped entirely", () => {
    const specs = buildRemoteTrackSpecs(
      makeConfig("video", 1),
      makeCtx({ allowedVideoIndices: [0, 2] }),
    );
    expect(specs).toEqual([]);
  });

  it("a frame-range object target on a disallowed video is dropped", () => {
    const specs = buildRemoteTrackSpecs(
      makeConfig({ start: 10, end: 20 }, 1),
      makeCtx({ allowedVideoIndices: [0] }),
    );
    expect(specs).toEqual([]);
  });
});

describe("buildRemoteTrackSpecs — option fields and extras", () => {
  it("copies model options and drops tracking fields when tracking is off", () => {
    const [spec] = buildRemoteTrackSpecs(makeConfig("all_videos"), makeCtx());
    expect(spec.type).toBe("track");
    expect(spec.data_path).toBe("/worker/labels.slp");
    expect(spec.model_paths).toEqual(["/worker/model"]);
    expect(spec.batch_size).toBe(4);
    expect(spec.peak_threshold).toBe(0.2);
    expect(spec.tracker).toBeUndefined();
    expect(spec.exclude_user_labeled).toBeUndefined();
    expect(spec.path_mappings).toBeUndefined();
  });

  it("adds tracker fields (and Kalman-only ones) when tracking is on", () => {
    const cfg = { ...makeConfig("all_videos"), tracking: true, trackerMethod: "kalman", kfNodeIndices: [1, 2], kfTrackFeatures: "xy", maxTracks: 3, flowImgScale: 1 };
    const [spec] = buildRemoteTrackSpecs(cfg, makeCtx());
    expect(spec.tracker).toBe("kalman");
    expect(spec.use_kalman).toBe(true);
    expect(spec.kf_node_indices).toBe("1,2");
    expect(spec.max_tracks).toBe(3);
    expect(spec.of_img_scale).toBeUndefined();
  });

  it("passes non-empty path mappings through", () => {
    const [spec] = buildRemoteTrackSpecs(makeConfig("all_videos"), makeCtx({ pathMappings: { "/a": "/b" } }));
    expect(spec.path_mappings).toEqual({ "/a": "/b" });
  });

  it("'random' samples sampleCount distinct sorted frames per video; 'random_video' samples the active video", () => {
    const specs = buildRemoteTrackSpecs({ ...makeConfig("random"), sampleCount: 3 }, makeCtx({ videoFrameCounts: [10, 10], random: () => 0.5 }));
    for (const s of specs) {
      const fr = s.frames.split(",").map(Number);
      expect(fr).toHaveLength(3);
      expect(fr).toEqual([...fr].sort((a, b) => a - b));
      expect(new Set(fr).size).toBe(3);
    }
    const [one] = buildRemoteTrackSpecs({ ...makeConfig("random_video", 1), sampleCount: 2 }, makeCtx({ activeVideoFrameCount: 5, random: () => 0.1 }));
    expect(one.video_index).toBe(1);
    expect(one.frames.split(",")).toHaveLength(2);
  });

  it("'user_labeled' and 'predicted' map to frame_filter", () => {
    expect(buildRemoteTrackSpecs(makeConfig("user_labeled"), makeCtx())[0].frame_filter).toBe("user");
    expect(buildRemoteTrackSpecs(makeConfig("predicted"), makeCtx())[0].frame_filter).toBe("predicted");
  });
});

describe("buildRunInferenceSpecs default dependency (LUCID)", () => {
  it("falls back to buildRemoteTrackSpecs when no deps are given", () => {
    const labels = { videos: [{ shape: [50, 1, 1, 1] }, { shape: [70, 1, 1, 1] }] };
    const specs = buildRunInferenceSpecs("/w/p.slp", ["/m/a"], makeConfig("random"), labels);
    expect(specs.map((s) => s.video_index)).toEqual([0, 1]);
    expect(specs[0].model_paths).toEqual(["/m/a"]);
    expect(specs[0].data_path).toBe("/w/p.slp");
  });
});

await run();
