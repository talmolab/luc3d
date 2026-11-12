/**
 * Port of sleap-app src/lib/launcherSpec.ts @ 683a159 (+ `hydraQuote` from
 * src/platform/trainingArgs.ts @ 683a159).
 *
 * Pure spec builders for the launcher wizard (PR5b) — starting a job on
 * data that already lives on a worker (design §4.3), seeding the wizard
 * from a past run ("Run again"), and the "Run inference" row action on an
 * already-finished training run. Nothing here touches a store or a
 * connection; every input (the worker-side `Labels`, its path, the configs)
 * is handed in by the caller.
 *
 * LUCID changes:
 *  - sleap-app imports `trainingStore`, `modelStats` and `remoteTrackSpec`; LUCID has none of
 *    them. Instead of importing, `buildLauncherTrainSpec`, `buildRunInferenceSpecs` and
 *    `seedFromJobSpec` take those functions as a trailing `deps` object
 *    (`LauncherSpecDeps`, below). Logic and key names in the produced specs are unchanged,
 *    so a caller that supplies sleap-app-identical helpers gets sleap-app-identical specs.
 *    `deps.formatRunTimestamp` defaults to `./timestamp.js`; `buildRunInferenceSpecs`'s
 *    `deps.buildRemoteTrackSpecs` defaults to `./remote-track-spec.js` (now ported).
 *  - `labels` is only read as `labels.videos[i].shape?.[0]` (frame counts) and passed to the
 *    deps; any object with that shape (not just a sleap-io `Labels`) works.
 *  - YAML is never parsed here: `seedFromJobSpec` delegates to `deps.parseYamlConfig`, so
 *    pose/connect needs no `yaml` import.
 *  - `inferModelType` and `hydraQuote` are verbatim. Training stays out of LUCID's UI, but
 *    `buildLauncherTrainSpec` is kept so train specs stay identical.
 *
 * @typedef {string} ModelType
 * @typedef {{ filename?: string, content: string, modelType: string, slot: string,
 *   hyperparams: Record<string, any>, checkpointPath?: string | null } & Record<string, any>} ConfigFile
 * @typedef {import("./project-tag.js?v=82449baaa3c2").JobProject} JobProject
 * @typedef {Record<string, any>} TrackJobSpec
 * @typedef {Record<string, any>} TrainJobSpec
 * @typedef {Record<string, any>} InferenceConfig
 *
 * @typedef {object} LauncherSpecDeps
 * @property {(modelType: ModelType) => string[]} getConfigSlots Pipeline slots for a model type, in order.
 * @property {(content: string, hyperparams: Record<string, any>, checkpointPath: string | null | undefined, maxStride: any, inputChannels: any) => string} applyHyperparamsToYaml
 * @property {(hyperparams: Record<string, any>, modelType: string, labels: any, opts: { runTimestamp: string }) => string} resolveRemoteRunName
 * @property {(hyperparams: Record<string, any>, labels: any) => any} resolveRemoteMaxStride
 * @property {(labels: any) => any} detectVideoChannels
 * @property {(colorMode: any, detected: any) => any} resolveInputChannels
 * @property {(config: InferenceConfig, opts: Record<string, any>) => TrackJobSpec[]} buildRemoteTrackSpecs
 * @property {(content: string, filename: string, slot: string) => ConfigFile | null} [parseYamlConfig] Only `seedFromJobSpec`.
 * @property {() => string} [formatRunTimestamp]
 */
import { formatRunTimestamp as defaultFormatRunTimestamp } from "./timestamp.js?v=82449baaa3c2";
import { buildRemoteTrackSpecs as defaultBuildRemoteTrackSpecs } from "./remote-track-spec.js?v=82449baaa3c2";

/**
 * Quote a value for use inside a Hydra CLI override so that `=`, spaces, commas,
 * brackets, etc. are treated as literal characters rather than grammar tokens.
 * The surrounding single quotes are literal argv characters (no shell is
 * involved — args are passed directly to the process), which Hydra strips when
 * it parses the quoted string. Embedded single quotes are backslash-escaped,
 * which Hydra's quoted-string grammar accepts.
 *
 * @param {string} value
 * @returns {string}
 */
export function hydraQuote(value) {
  return `'${value.replace(/'/g, "\\'")}'`;
}

/**
 * A `TrackJobSpec` with the fields the worker fills in itself stripped — see `TrainJobSpec.post_inference`'s doc.
 * @param {TrackJobSpec} trackSpec
 */
function toPostInferenceEntry(trackSpec) {
  const entry = { ...trackSpec };
  delete entry.type;
  delete entry.data_path;
  delete entry.model_paths;
  return entry;
}

/**
 * Builds a worker-file train job's spec — always path-mode (`labels_path`,
 * never `labels_content`: the file already lives on the worker, so there's
 * nothing to embed). `configs` is sorted into pipeline order via
 * `getConfigSlots(modelType)`, matching `submitJobsOn`'s expectation for a
 * split multi-model run (`config_contents[i]` trains `model_types[i]`).
 *
 * `postInference`, when given, becomes `post_inference` — stripped of the
 * fields the worker fills in once training finishes (PR5w) — so the worker
 * chains it itself even if this app closes before training completes.
 *
 * `input.labelsContent`: base64 `.slp` bytes to send as `labels_content`,
 * alongside `labelsPath` (see sleap-app's doc: set when a video is only
 * reachable via a path rule). `labelsPath` is still sent so the worker's job
 * list shows the original file's name while queued. Omitted (no
 * `labels_content` key at all) when falsy.
 *
 * @param {{
 *   labels: any,
 *   labelsPath: string,
 *   labelsContent?: string | null,
 *   modelType: ModelType,
 *   configs: ConfigFile[],
 *   postInference: InferenceConfig | null,
 *   project: JobProject,
 * }} input
 * @param {LauncherSpecDeps} deps
 * @returns {TrainJobSpec}
 */
export function buildLauncherTrainSpec(input, deps) {
  const { labels, labelsPath, labelsContent, modelType, configs, postInference, project } = input;
  const slots = deps.getConfigSlots(modelType);
  const orderedConfigs = slots
    .map((slot) => configs.find((c) => c.slot === slot))
    .filter((c) => !!c);

  // Shared across every model below so a split multi-model pipeline's run
  // names all carry the exact same timestamp — see resolveRemoteRunName's
  // own doc for why that matters.
  const runTimestamp = (deps.formatRunTimestamp ?? defaultFormatRunTimestamp)();
  const detectedChannels = deps.detectVideoChannels(labels);

  const spec = {
    type: "train",
    config_contents: orderedConfigs.map((c) =>
      deps.applyHyperparamsToYaml(
        c.content,
        {
          ...c.hyperparams,
          runName: deps.resolveRemoteRunName(c.hyperparams, c.modelType, labels, { runTimestamp }),
        },
        c.checkpointPath,
        deps.resolveRemoteMaxStride(c.hyperparams, labels),
        deps.resolveInputChannels(c.hyperparams.colorMode, detectedChannels),
      ),
    ),
    model_types: orderedConfigs.map((c) => c.modelType),
    labels_path: labelsPath,
    project,
  };

  if (labelsContent) spec.labels_content = labelsContent;

  if (postInference) {
    const trackSpecs = deps.buildRemoteTrackSpecs(postInference, {
      dataPath: labelsPath,
      pathMappings: {},
      videoFrameCounts: labels.videos.map((v) => v.shape?.[0] ?? 0),
      // Neither a "current frame" nor a "current video" exists for a
      // worker-file launch (design §4.3's target list drops those options
      // for exactly this reason) — 0 is never actually read by any target
      // the wizard exposes.
      currentFrameIdx: 0,
      activeVideoFrameCount: 0,
    });
    spec.post_inference = trackSpecs.map(toPostInferenceEntry);
  }

  return spec;
}

/**
 * Builds the track job spec(s) for the "Run inference" row action on an
 * already-finished training run — `modelDirs` are the run's own sibling
 * jobs' `result.model_dir`, already known (unlike `buildLauncherTrainSpec`'s
 * `post_inference`, which the worker fills in later because training hasn't
 * happened yet), so this submits a plain, standalone track job via
 * `submitJobsOn` rather than chaining.
 *
 * @param {string} labelsPath
 * @param {string[]} modelDirs
 * @param {InferenceConfig} config
 * @param {any} labels
 * @param {Partial<Pick<LauncherSpecDeps, "buildRemoteTrackSpecs">>} [deps] `buildRemoteTrackSpecs` defaults to `./remote-track-spec.js` (LUCID).
 * @returns {TrackJobSpec[]}
 */
export function buildRunInferenceSpecs(labelsPath, modelDirs, config, labels, deps = {}) {
  return (deps.buildRemoteTrackSpecs ?? defaultBuildRemoteTrackSpecs)(
    { ...config, modelPaths: modelDirs },
    {
      dataPath: labelsPath,
      pathMappings: {},
      videoFrameCounts: labels.videos.map((v) => v.shape?.[0] ?? 0),
      currentFrameIdx: 0,
      activeVideoFrameCount: 0,
    },
  );
}

/** Reverses `slotToHeadType`'s forward mapping (trainingProfiles.ts) for the head-type sets `getConfigSlots` can actually produce. A `top_down_id` run's two configs carry the exact same head types a `top_down` run's do (slotToHeadType special-cases "centroid"/"centered_instance" before ever consulting `modelType`), so that pair is irreducibly ambiguous — it resolves to the more common `top_down`. */
const HEAD_TYPES_TO_MODEL_TYPE = [
  { headTypes: ["centroid", "centered_instance"], modelType: "top_down" },
  { headTypes: ["single_instance"], modelType: "single_animal" },
  { headTypes: ["bottomup"], modelType: "bottom_up" },
  { headTypes: ["multi_class_bottomup"], modelType: "bottom_up_id" },
  { headTypes: ["multi_class_topdown"], modelType: "top_down_id" },
];

/**
 * Reverses `slotToHeadType` from a run's ordered head-type list (one per
 * sibling job, `run.index` order) to the pipeline `ModelType` — shared by
 * `seedFromJobSpec` (below) and the launcher wizard's Inference flow, which
 * uses it only to satisfy `buildPostTrainingInferenceConfig`'s `modelType`
 * param for its (unread by `buildRemoteTrackSpecs`) `pipeline` field, so a
 * `null`/fallback guess there is harmless.
 *
 * @param {string[]} headTypes
 * @returns {ModelType | null}
 */
export function inferModelType(headTypes) {
  const match = HEAD_TYPES_TO_MODEL_TYPE.find(
    (m) => m.headTypes.length === headTypes.length && m.headTypes.every((h, i) => h === headTypes[i]),
  );
  return match?.modelType ?? null;
}

/**
 * Reconstructs `{modelType, configs}` from a train run's sibling job specs
 * for "Run again" (NewJobWizard row action, PR5b) — the caller gathers the
 * siblings (`listJobs` + `jobDetail`, grouped by `run.id`, ordered by
 * `run.index`) and passes one aggregate spec whose `config_contents[i]`/
 * `model_types[i]` is sibling i's own single-model YAML/head type (each job
 * in a split multi-model run carries only its own model — see
 * `isMultiModelTrainSpec`'s splitting in the store).
 *
 * `null` when `model_types` doesn't match any pipeline shape this app
 * recognizes (see {@link HEAD_TYPES_TO_MODEL_TYPE}'s doc on `top_down_id`'s
 * ambiguity), or when none of the YAMLs parse.
 *
 * @param {{ config_contents: string[], model_types: string[] }} spec
 * @param {Pick<LauncherSpecDeps, "getConfigSlots" | "parseYamlConfig">} deps
 * @returns {{ modelType: ModelType, configs: ConfigFile[] } | null}
 */
export function seedFromJobSpec(spec, deps) {
  const modelType = inferModelType(spec.model_types);
  if (!modelType) return null;

  const slots = deps.getConfigSlots(modelType);
  const configs = [];
  for (let i = 0; i < spec.config_contents.length; i++) {
    const slot = slots[i] ?? slots[slots.length - 1] ?? "config";
    const parsed = deps.parseYamlConfig(spec.config_contents[i], `${slot}.yaml`, slot);
    if (parsed) configs.push(parsed);
  }
  if (configs.length === 0) return null;
  return { modelType, configs };
}
