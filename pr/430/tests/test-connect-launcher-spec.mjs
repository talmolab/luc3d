/**
 * Port of sleap-app tests/unit/launcherSpec.test.ts @ 683a159.
 *
 * sleap-app's test drives the real `trainingStore` / `remoteTrackSpec` helpers
 * (js-yaml, sleap-io `Labels`). LUCID has none of them (they are injected as
 * `deps` into pose/connect/launcher-spec.js), so this file supplies small fakes
 * and asserts the same behaviors of the builders themselves: path-mode train
 * spec, pipeline-slot ordering, one shared run timestamp, `labels_content`,
 * `post_inference` stripping, standalone track specs with per-video frame counts,
 * and `seedFromJobSpec` / `inferModelType`. The real-YAML assertions (head
 * configs inside the produced YAML) are the injected helpers' business, not
 * launcher-spec's, and are not ported.
 */
import { describe, it, expect, run } from './bun-test-shim.mjs';
import {
  buildLauncherTrainSpec,
  buildRunInferenceSpecs,
  seedFromJobSpec,
  inferModelType,
  hydraQuote,
} from '../pose/connect/launcher-spec.js';
import { projectTag } from '../pose/connect/project-tag.js';

const SLOTS = {
  top_down: ["centroid", "centered_instance"],
  single_animal: ["config"],
  bottom_up: ["config"],
};

/** Configs are `{ head }` JSON; applyHyperparamsToYaml stamps the run name into it. */
const makeDeps = (extra = {}) => ({
  getConfigSlots: (modelType) => SLOTS[modelType] ?? ["config"],
  applyHyperparamsToYaml: (content, hp, ckpt, maxStride, channels) =>
    JSON.stringify({ ...JSON.parse(content), run_name: hp.runName, maxStride, channels }),
  resolveRemoteRunName: (_hp, modelType, _labels, { runTimestamp }) => `${runTimestamp}.${modelType}.n=3`,
  resolveRemoteMaxStride: () => 16,
  detectVideoChannels: () => 1,
  resolveInputChannels: (mode, detected) => `${mode}:${detected}`,
  buildRemoteTrackSpecs: (config, opts) => {
    extra.calls?.push({ config, opts });
    return opts.videoFrameCounts.map((n, i) => ({
      type: "track",
      data_path: opts.dataPath,
      model_paths: config.modelPaths,
      video_index: i,
      frame_filter: "suggested",
      frame_count: n,
    }));
  },
  parseYamlConfig: (content, filename, slot) => {
    try {
      return { filename, content, slot, modelType: JSON.parse(content).head, hyperparams: {} };
    } catch {
      return null;
    }
  },
  ...extra.deps,
});

const cfg = (head, over = {}) => ({
  filename: "test.yaml",
  content: JSON.stringify({ head }),
  modelType: head,
  slot: head,
  hyperparams: { colorMode: "grayscale" },
  checkpointPath: null,
  ...over,
});

const labels = (counts = [20]) => ({ videos: counts.map((n) => ({ filename: "/mnt/data/a.mp4", shape: [n, 480, 640, 3] })) });
const PROJECT = projectTag("/mnt/data/labels.slp");

describe("buildLauncherTrainSpec", () => {
  it("is always path-mode: labels_path set, labels_content never present", () => {
    const spec = buildLauncherTrainSpec(
      {
        labels: labels(),
        labelsPath: "/mnt/data/labels.slp",
        modelType: "single_animal",
        configs: [cfg("single_instance", { slot: "config" })],
        postInference: null,
        project: PROJECT,
      },
      makeDeps(),
    );
    expect(spec.labels_path).toBe("/mnt/data/labels.slp");
    expect("labels_content" in spec).toBe(false);
    expect(spec.val_labels_path).toBeUndefined();
    expect(spec.type).toBe("train");
    expect(spec.project).toBe(PROJECT);
  });

  it("orders a multi-model pipeline's config_contents by slot, regardless of input order", () => {
    const spec = buildLauncherTrainSpec(
      {
        labels: labels(),
        labelsPath: "/mnt/data/labels.slp",
        modelType: "top_down",
        configs: [cfg("centered_instance"), cfg("centroid")],
        postInference: null,
        project: PROJECT,
      },
      makeDeps(),
    );
    expect(spec.model_types).toEqual(["centroid", "centered_instance"]);
    expect(spec.config_contents).toHaveLength(2);
    const docs = spec.config_contents.map((c) => JSON.parse(c));
    expect(docs.map((d) => d.head)).toEqual(["centroid", "centered_instance"]);
  });

  it("gives every model in one submission the exact same run_name timestamp", () => {
    let ticks = 0;
    const spec = buildLauncherTrainSpec(
      {
        labels: labels(),
        labelsPath: "/mnt/data/labels.slp",
        modelType: "top_down",
        configs: [cfg("centroid"), cfg("centered_instance")],
        postInference: null,
        project: PROJECT,
      },
      // A clock that would differ on every call: the builder must call it once.
      makeDeps({ deps: { formatRunTimestamp: () => `260101_00000${ticks++}` } }),
    );
    const names = spec.config_contents.map((c) => JSON.parse(c).run_name);
    expect(names[0].split(".")[0]).toBe(names[1].split(".")[0]);
    expect(names[0]).toContain(".centroid");
    expect(names[1]).toContain(".centered_instance");
    expect(ticks).toBe(1);
  });

  it("uses ./timestamp.js's YYMMDD_HHMMSS by default", () => {
    const spec = buildLauncherTrainSpec(
      {
        labels: labels(),
        labelsPath: "/p.slp",
        modelType: "single_animal",
        configs: [cfg("single_instance", { slot: "config" })],
        postInference: null,
        project: PROJECT,
      },
      makeDeps(),
    );
    expect(JSON.parse(spec.config_contents[0]).run_name).toMatch(/^\d{6}_\d{6}\.single_instance\.n=3$/);
  });

  it("sets labels_content alongside labels_path when a labelsContent payload is given", () => {
    const spec = buildLauncherTrainSpec(
      {
        labels: labels(),
        labelsPath: "/mnt/data/labels.slp",
        labelsContent: "QkFTRTY0",
        modelType: "single_animal",
        configs: [cfg("single_instance", { slot: "config" })],
        postInference: null,
        project: PROJECT,
      },
      makeDeps(),
    );
    expect(spec.labels_path).toBe("/mnt/data/labels.slp");
    expect(spec.labels_content).toBe("QkFTRTY0");
  });

  it("omits labels_content when given null (no re-pointing was needed)", () => {
    const spec = buildLauncherTrainSpec(
      {
        labels: labels(),
        labelsPath: "/mnt/data/labels.slp",
        labelsContent: null,
        modelType: "single_animal",
        configs: [cfg("single_instance", { slot: "config" })],
        postInference: null,
        project: PROJECT,
      },
      makeDeps(),
    );
    expect("labels_content" in spec).toBe(false);
  });

  it("omits post_inference when none is requested", () => {
    const spec = buildLauncherTrainSpec(
      {
        labels: labels(),
        labelsPath: "/mnt/data/labels.slp",
        modelType: "single_animal",
        configs: [cfg("single_instance", { slot: "config" })],
        postInference: null,
        project: PROJECT,
      },
      makeDeps(),
    );
    expect(spec.post_inference).toBeUndefined();
  });

  it("includes post_inference, stripped of type/data_path/model_paths (the worker fills those in)", () => {
    const calls = [];
    const spec = buildLauncherTrainSpec(
      {
        labels: labels([20, 4]),
        labelsPath: "/mnt/data/labels.slp",
        modelType: "single_animal",
        configs: [cfg("single_instance", { slot: "config" })],
        postInference: { modelPaths: [] },
        project: PROJECT,
      },
      makeDeps({ calls }),
    );
    expect(spec.post_inference).toHaveLength(2);
    const entry = spec.post_inference[0];
    expect(entry.type).toBeUndefined();
    expect(entry.data_path).toBeUndefined();
    expect(entry.model_paths).toBeUndefined();
    expect(entry.frame_filter).toBe("suggested");
    expect(calls[0].opts).toEqual({
      dataPath: "/mnt/data/labels.slp",
      pathMappings: {},
      videoFrameCounts: [20, 4],
      currentFrameIdx: 0,
      activeVideoFrameCount: 0,
    });
  });
});

describe("buildRunInferenceSpecs", () => {
  it("builds a standalone track spec with the given model dirs and the worker labels' frame counts", () => {
    const calls = [];
    const specs = buildRunInferenceSpecs(
      "/mnt/data/labels.slp",
      ["/mnt/models/run1"],
      { target: "all_videos" },
      labels(),
      makeDeps({ calls }),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].data_path).toBe("/mnt/data/labels.slp");
    expect(specs[0].model_paths).toEqual(["/mnt/models/run1"]);
    expect(specs[0].type).toBe("track");
    expect(calls[0].config).toEqual({ target: "all_videos", modelPaths: ["/mnt/models/run1"] });
  });

  it("passes each worker video's own frame count", () => {
    const calls = [];
    const specs = buildRunInferenceSpecs("/p.slp", ["/m"], {}, labels([10, 4]), makeDeps({ calls }));
    expect(specs.map((s) => s.video_index)).toEqual([0, 1]);
    expect(calls[0].opts.videoFrameCounts).toEqual([10, 4]);
  });

  it("a video with no known shape counts as 0 frames", () => {
    const calls = [];
    buildRunInferenceSpecs("/p.slp", ["/m"], {}, { videos: [{ filename: "x.mp4" }] }, makeDeps({ calls }));
    expect(calls[0].opts.videoFrameCounts).toEqual([0]);
  });
});

describe("seedFromJobSpec", () => {
  const deps = makeDeps();
  const head = (h) => JSON.stringify({ head: h });

  it("reconstructs a two-job top-down run's modelType and per-slot configs", () => {
    const result = seedFromJobSpec(
      { config_contents: [head("centroid"), head("centered_instance")], model_types: ["centroid", "centered_instance"] },
      deps,
    );
    expect(result).not.toBeNull();
    expect(result.modelType).toBe("top_down");
    expect(result.configs).toHaveLength(2);
    expect(result.configs[0].slot).toBe("centroid");
    expect(result.configs[1].slot).toBe("centered_instance");
  });

  it("reconstructs a single-job single_animal run", () => {
    const result = seedFromJobSpec(
      { config_contents: [head("single_instance")], model_types: ["single_instance"] },
      deps,
    );
    expect(result).not.toBeNull();
    expect(result.modelType).toBe("single_animal");
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0].slot).toBe("config");
  });

  it("returns null for a head-type set that doesn't match any known pipeline", () => {
    expect(
      seedFromJobSpec({ config_contents: [head("some_future_head_type")], model_types: ["some_future_head_type"] }, deps),
    ).toBeNull();
  });

  it("returns null when none of the YAMLs parse", () => {
    expect(
      seedFromJobSpec({ config_contents: ["not json"], model_types: ["single_instance"] }, deps),
    ).toBeNull();
  });
});

describe("inferModelType", () => {
  it("maps every known head-type set, and resolves the top_down_id ambiguity to top_down", () => {
    expect(inferModelType(["centroid", "centered_instance"])).toBe("top_down");
    expect(inferModelType(["single_instance"])).toBe("single_animal");
    expect(inferModelType(["bottomup"])).toBe("bottom_up");
    expect(inferModelType(["multi_class_bottomup"])).toBe("bottom_up_id");
    expect(inferModelType(["multi_class_topdown"])).toBe("top_down_id");
  });

  it("is order-sensitive and null for unknown sets", () => {
    expect(inferModelType(["centered_instance", "centroid"])).toBeNull();
    expect(inferModelType([])).toBeNull();
  });
});

describe("hydraQuote (sleap-app tests/unit/trainingArgs.test.ts behavior)", () => {
  it("single-quotes a value so '=' survives Hydra's override grammar, escaping embedded quotes", () => {
    expect(hydraQuote("250818_143022.centroid.n=13")).toBe("'250818_143022.centroid.n=13'");
    expect(hydraQuote("it's")).toBe("'it\\'s'");
  });
});

await run();
