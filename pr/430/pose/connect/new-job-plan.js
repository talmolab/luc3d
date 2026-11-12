/**
 * pose/connect/new-job-plan.js — the DOM-free decisions of the New job wizard's
 * Inference path (`ui/connect/new-job-wizard.js`).
 *
 * Port of the Inference half of sleap-app `src/components/connect/NewJobWizard.tsx`
 * @ 683a159 (`handleSubmitInference`, `canSubmitInference`, the target list, the
 * model-dir bookkeeping) plus the LUCID data sources the wizard adds:
 *
 *  - "A file on the worker" that is a `.slp` -> sleap-app's own spec
 *    (`buildRunInferenceSpecs`, `launcher-spec.js`);
 *  - "A file on the worker" that is a VIDEO -> a plain `track` job on that video
 *    (`buildRemoteTrackSpecs` with the video as `data_path`, the same spec shape
 *    the Inference panel submits per view), with no LUCID view tag: the results
 *    are saved or merged later from the Jobs tab.
 *
 * LUCID changes from sleap-app:
 *  - A worker `.slp`'s structure is NOT read (sleap-app's `workerLabels.ts` needs
 *    sleap-io's `readSlpStreaming` over a `RangeSource`, which needs
 *    SharedArrayBuffer; LUCID's page is not cross-origin isolated). So there are no
 *    frame counts: "Random sample" (it samples frames client-side) is not offered
 *    for a `.slp`, the other targets filter on the worker (`frame_filter`).
 *  - every spec carries the `project` tag of `projectTag(<worker path>)` (sleap-app
 *    adds it only to train specs), so the worker's job list names the file.
 *  - the pipeline guess (`inferModelType`) only fills the cosmetic `pipeline` field,
 *    which `buildRemoteTrackSpecs` never reads.
 *
 * Imports only inside `pose/connect/` (Node tests: tests/test-connect-new-job-plan.mjs).
 */
import { buildRunInferenceSpecs, inferModelType } from "./launcher-spec.js?v=82449baaa3c2";
import { buildRemoteTrackSpecs } from "./remote-track-spec.js?v=82449baaa3c2";
import { projectTag } from "./project-tag.js?v=82449baaa3c2";
import { WORKER_FILE_INFERENCE_TARGETS } from "./worker-ui-helpers.js?v=82449baaa3c2";

export const VIDEO_EXTENSIONS = [".mp4", ".avi", ".mov", ".mkv", ".m4v"];

/** `buildPostTrainingInferenceConfig`'s pipeline names (trainingStore.ts). */
const PIPELINE_OF_MODEL_TYPE = {
  single_animal: "single-animal",
  top_down: "top-down",
  bottom_up: "bottom-up",
  top_down_id: "top-down-id",
  bottom_up_id: "bottom-up-id",
};

/**
 * What a picked worker file is: `"slp"` (labels), `"video"`, or `"other"`.
 * @param {string | null | undefined} path
 * @returns {"slp" | "video" | "other"}
 */
export function workerFileKind(path) {
  const name = String(path || "").toLowerCase();
  if (name.endsWith(".slp")) return "slp";
  if (VIDEO_EXTENSIONS.some((e) => name.endsWith(e))) return "video";
  return "other";
}

/**
 * The "Inference on" choices for a file kind. A `.slp` keeps sleap-app's list minus "Random sample"
 * (no frame counts without reading the file); a video offers the whole video or a frame range.
 * @param {"slp" | "video" | "other"} kind
 * @returns {{ value: string, label: string }[]}
 */
export function inferenceTargetsFor(kind) {
  if (kind === "video") {
    return [
      { value: "video", label: "Entire video" },
      { value: "range", label: "Frame range" },
    ];
  }
  return WORKER_FILE_INFERENCE_TARGETS.filter((t) => t.value !== "random");
}

/**
 * The refusal for a frame range (`start` / `end` inclusive, as `frames: "a-b"`), or null when it is usable.
 * @param {number} start @param {number} end
 */
export function frameRangeError(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0) return "Enter whole frame numbers, 0 or more.";
  if (end < start) return "The last frame must be at least the first.";
  return null;
}

/**
 * sleap-app's `buildPostTrainingInferenceConfig` for a standalone run (`defaults` = the panel's
 * `INFERENCE_DEFAULTS`, handed in so this stays import-free of `ui/`).
 *
 * @param {Record<string, any>} defaults
 * @param {{ modelType: string, modelPaths: string[], target: string, start?: number, end?: number }} o
 * @returns {Record<string, any>}
 */
export function buildWorkerInferenceConfig(defaults, o) {
  const config = { ...defaults };
  config.pipeline = PIPELINE_OF_MODEL_TYPE[o.modelType] || "top-down";
  config.modelPaths = o.modelPaths.slice();
  config.videoIndex = "all";
  config.frameRange = o.target === "range" ? { start: o.start ?? 0, end: o.end ?? 0 } : o.target;
  config.ensureChannels = config.ensureChannels ?? "auto";
  return config;
}

/**
 * The track spec(s) of "a file on the worker": one, except nothing here samples randomly. `null` for
 * a file that is neither `.slp` nor video.
 *
 * @param {{
 *   path: string,
 *   modelDirs: string[],
 *   headTypes?: string[],
 *   target: string,
 *   start?: number,
 *   end?: number,
 *   defaults: Record<string, any>,
 * }} o
 * @returns {Array<Record<string, any>> | null}
 */
export function buildWorkerFileSpecs(o) {
  const kind = workerFileKind(o.path);
  if (kind === "other") return null;
  const config = buildWorkerInferenceConfig(o.defaults, {
    modelType: inferModelType(o.headTypes ?? []) ?? "top_down",
    modelPaths: o.modelDirs,
    target: o.target,
    start: o.start,
    end: o.end,
  });
  const project = projectTag(o.path);
  /** @type {Array<Record<string, any>>} */
  let specs;
  if (kind === "slp") {
    // No labels summary: `videos: []` (frame counts are read only by "random", not offered here).
    specs = buildRunInferenceSpecs(o.path, o.modelDirs, config, { videos: [] });
  } else {
    specs = buildRemoteTrackSpecs(config, {
      dataPath: o.path,
      pathMappings: {},
      videoFrameCounts: [0],
      currentFrameIdx: 0,
      activeVideoFrameCount: 0,
    });
  }
  return specs.map((s) => {
    const out = { ...s, project };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  });
}

/**
 * Why Add to queue is disabled for the "file on worker" source, or "" when it can run.
 * (sleap-app's `canSubmitInference` needs labels + every video found + a model dir; LUCID has no summary.)
 *
 * @param {{ path: string | null, modelDirs: string[], target: string, start?: number, end?: number, submitting?: boolean }} o
 */
export function fileSourceBlocker(o) {
  if (o.submitting) return "Adding…";
  if (!o.path) return "Pick a file on the worker.";
  if (workerFileKind(o.path) === "other") return "Pick a .slp or a video file.";
  if (o.modelDirs.length === 0) return "Add a model folder.";
  if (o.target === "range") return frameRangeError(o.start ?? NaN, o.end ?? NaN) ?? "";
  return "";
}

/**
 * Rebuilds sleap-app's `seedWizardFromRun` for the Inference-only wizard: the labels path and model type
 * of a past run (its `config_contents` are not parsed, training is not offered).
 * @param {(workerId: string, jobId: string) => Promise<any>} jobDetail
 * @param {string} workerId
 * @param {string[]} jobIds
 * @returns {Promise<{ labelsPath: string, modelType: string, configs: any[] } | null>}
 */
export async function seedWizardFromRun(jobDetail, workerId, jobIds) {
  const details = await Promise.all(jobIds.map((id) => jobDetail(workerId, id)));
  const modelTypes = [];
  for (const d of details) modelTypes.push(...((d.spec && d.spec.model_types) || []));
  const modelType = inferModelType(modelTypes);
  const labelsPath = details[0] && details[0].labelsPath;
  if (!modelType || !labelsPath) return null;
  return { labelsPath, modelType, configs: [] };
}
