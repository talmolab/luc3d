/**
 * ui/training-args.js — the Training panel's model types, config slots and the mapping between a
 * sleap-nn training config and the panel's fields. DOM-free; it works on PARSED configs (plain
 * objects), the panel parses and writes the YAML (`yaml` from the importmap), so Node tests need
 * no YAML library (tests/test-training-args.mjs).
 *
 * Port of sleap-app `src/stores/trainingStore.ts` (`getConfigSlots`, `getSlotLabel`,
 * `parseYamlConfig`, the panel fields of `applyHyperparamsToYaml`) and
 * `src/lib/trainingProfiles.ts` (`slotToHeadType`) @ c97c6a5: same slots, labels, defaults and
 * YAML keys.
 *
 * LUCID changes: the panel edits only the fields it shows (Max Epochs, Batch Size, Rotation /
 * Scale Augmentation, Anchor Part); every other value of the chosen config is kept as it is,
 * which is what sleap-app writes back for an untouched field. `finalizeConfig` pins what LUC3D
 * owns (run name, W&B off, no baked-in skeleton or data paths): the worker (remote) and Rust
 * (local) then set the paths and ports.
 */
import { BASELINE_PROFILES } from '../lib/sleap-app-profiles/profiles.js?v=d8c111d6b6c2';

/** sleap-app `MODEL_TYPE_OPTIONS`; LUCID disables the box types (no box labels). */
export const MODEL_TYPE_OPTIONS = Object.freeze([
    { value: 'single_animal', label: 'Single Animal' },
    { value: 'top_down', label: 'Top-Down' },
    { value: 'bottom_up', label: 'Bottom-Up' },
    { value: 'top_down_id', label: 'Top-Down + ID' },
    { value: 'bottom_up_id', label: 'Bottom-Up + ID' },
    { value: 'bbox', label: 'Box Detector' },
    { value: 'top_down_bbox', label: 'Top-Down (Box Crops)' },
]);

export const MODEL_TYPE_HINT = 'The pose-estimation pipeline to train. Single Animal predicts node locations for one animal per frame. ' +
    'Top-Down uses a centroid model to locate and crop each animal, then a centered-instance model for its pose. ' +
    'Bottom-Up predicts all keypoints and groups them into animals via part affinity fields. ' +
    'The “+ ID” variants also learn each animal’s identity. Box Detector types need box labels, which LUCID does not have.';

export const DEFAULT_MODEL_TYPE = 'top_down';

/** The config slots of a pipeline: top-down trains two models, the others one. */
export function getConfigSlots(modelType) {
    switch (modelType) {
        case 'top_down':
        case 'top_down_id':
            return ['centroid', 'centered_instance'];
        case 'top_down_bbox':
            return ['bbox', 'centered_instance'];
        case 'bbox':
            return ['bbox'];
        default:
            return ['config'];
    }
}

export function getSlotLabel(slot) {
    switch (slot) {
        case 'centroid': return 'Centroid Config';
        case 'centered_instance': return 'Centered Instance Config';
        case 'bbox': return 'Box Detector Config';
        default: return 'Config';
    }
}

/** sleap-app `slotToHeadType`: the head a slot trains, for preset lookup. */
export function slotToHeadType(modelType, slot) {
    if (slot === 'centroid') return 'centroid';
    if (slot === 'bbox') return 'bbox';
    if (slot === 'centered_instance') return modelType === 'top_down_bbox' ? 'centered_instance_bbox'
        : modelType === 'top_down_id' ? 'multi_class_topdown' : 'centered_instance';
    switch (modelType) {
        case 'single_animal': return 'single_instance';
        case 'bottom_up': return 'bottomup';
        case 'bottom_up_id': return 'multi_class_bottomup';
        default: return slot;
    }
}

/** A progress row's model name for a head type. */
export function headLabel(head) {
    switch (head) {
        case 'centroid': return 'Centroid';
        case 'centered_instance': return 'Centered Instance';
        case 'multi_class_topdown': return 'Centered Instance + ID';
        case 'bottomup': return 'Bottom-Up';
        case 'multi_class_bottomup': return 'Bottom-Up + ID';
        case 'single_instance': return 'Single Instance';
        default: return String(head || 'Model');
    }
}

export function profilesForHead(headType) {
    return BASELINE_PROFILES.filter(function (p) { return p.headType === headType; });
}

/** The default preset of a slot: the Medium RF one (first listed), as sleap-app picks. */
export function defaultProfile(modelType, slot) {
    return profilesForHead(slotToHeadType(modelType, slot))[0] || null;
}

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function clone(v) { return JSON.parse(JSON.stringify(v)); }

/** The trained head of a config: its first non-null `model_config.head_configs` key. */
export function detectHeadType(doc) {
    const hc = obj(obj(obj(doc) && doc.model_config) && doc.model_config.head_configs);
    if (!hc) return 'unknown';
    for (const k of Object.keys(hc)) if (hc[k] != null) return k;
    return 'unknown';
}

function activeHead(doc) {
    const hc = obj(obj(doc.model_config) && doc.model_config.head_configs);
    if (!hc) return null;
    for (const k of Object.keys(hc)) if (obj(hc[k])) return hc[k];
    return null;
}

/** The anchor part of a config's head (`confmaps.anchor_part` or `anchor_part`), or null. */
function anchorOf(doc) {
    const h = activeHead(doc);
    if (!h) return null;
    const c = obj(h.confmaps);
    const v = c && 'anchor_part' in c ? c.anchor_part : h.anchor_part;
    return v == null ? null : String(v);
}

/**
 * The panel's fields read from a parsed config (sleap-app `parseYamlConfig` for these fields).
 * @returns {{maxEpochs: number, batchSize: number, rotationPreset: string, rotationCustomAngle: number,
 *            scaleEnabled: boolean, scaleMin: number, scaleMax: number, anchorPart: string|null,
 *            validationFraction: number, seed: number|null}}
 */
export function hyperparamsFromConfig(doc) {
    const d = obj(doc) || {};
    const t = obj(d.trainer_config) || {};
    const data = obj(d.data_config) || {};
    const geo = obj(obj(data.augmentation_config) && data.augmentation_config.geometric) || {};
    const rmin = Number(geo.rotation_min), rmax = Number(geo.rotation_max), affine = Number(geo.affine_p);
    let rotationPreset = 'custom', rotationCustomAngle = 180;
    const span = Number.isFinite(rmax) ? Math.abs(rmax) : 0;
    if (affine === 0 || (rmin === 0 && rmax === 0) || !Number.isFinite(rmax)) rotationPreset = 'off';
    else if (span === 15 && rmin === -15) rotationPreset = '15';
    else if (span === 180 && rmin === -180) rotationPreset = '180';
    else rotationCustomAngle = span;
    const smin = Number(geo.scale_min), smax = Number(geo.scale_max);
    const scaleEnabled = Number.isFinite(smin) && Number.isFinite(smax) && !(smin === 1 && smax === 1);
    const tl = obj(t.train_data_loader) || {};
    const vf = Number(data.validation_fraction);
    return {
        maxEpochs: Number.isFinite(Number(t.max_epochs)) && Number(t.max_epochs) > 0 ? Math.round(Number(t.max_epochs)) : 200,
        batchSize: Number.isFinite(Number(tl.batch_size)) && Number(tl.batch_size) > 0 ? Math.round(Number(tl.batch_size)) : 4,
        rotationPreset: rotationPreset,
        rotationCustomAngle: rotationCustomAngle,
        scaleEnabled: scaleEnabled,
        scaleMin: scaleEnabled ? smin : 0.9,
        scaleMax: scaleEnabled ? smax : 1.1,
        anchorPart: anchorOf(d),
        validationFraction: Number.isFinite(vf) && vf > 0 && vf < 1 ? vf : 0.1,
        seed: Number.isFinite(Number(t.seed)) ? Number(t.seed) : null,
    };
}

/**
 * Write the panel's fields into a copy of `doc` (sleap-app `applyHyperparamsToYaml`, these
 * fields only; same YAML keys and values).
 */
export function applyPanelSettings(doc, hp) {
    const d = clone(obj(doc) || {});
    if (!obj(d.trainer_config)) d.trainer_config = {};
    if (!obj(d.data_config)) d.data_config = {};
    const t = d.trainer_config, data = d.data_config;
    t.max_epochs = hp.maxEpochs;
    if (!obj(t.train_data_loader)) t.train_data_loader = {};
    t.train_data_loader.batch_size = hp.batchSize;
    if (!obj(data.augmentation_config)) data.augmentation_config = {};
    if (!obj(data.augmentation_config.geometric)) data.augmentation_config.geometric = {};
    const geo = data.augmentation_config.geometric;
    if (hp.rotationPreset === 'off') { geo.rotation_min = 0; geo.rotation_max = 0; geo.affine_p = 0; }
    else if (hp.rotationPreset === '15') { geo.rotation_min = -15; geo.rotation_max = 15; geo.affine_p = 1.0; }
    else if (hp.rotationPreset === '180') { geo.rotation_min = -180; geo.rotation_max = 180; geo.affine_p = 1.0; }
    else if (hp.rotationPreset === 'custom') {
        const a = Math.max(0, Math.min(180, Number(hp.rotationCustomAngle) || 0));
        geo.rotation_min = -a; geo.rotation_max = a; geo.affine_p = 1.0;
    }
    if (hp.scaleEnabled) { geo.scale_min = hp.scaleMin; geo.scale_max = hp.scaleMax; }
    else { geo.scale_min = 1.0; geo.scale_max = 1.0; }
    // sleap-app writes the panel's Validation Fraction too: a worker's sleap-nn splits by it (locally LUC3D
    // splits by moment into a separate file, which sleap-nn then uses instead).
    if (Number.isFinite(Number(hp.validationFraction)) && hp.validationFraction > 0 && hp.validationFraction < 1) data.validation_fraction = hp.validationFraction;
    // anchor_part: a null anchor clears a key the head already has, never adds one to a head
    // whose schema lacks it (sleap-app).
    const h = activeHead(d);
    if (h) {
        const c = obj(h.confmaps);
        if (c) { if (hp.anchorPart !== null || 'anchor_part' in c) c.anchor_part = hp.anchorPart; }
        else if (hp.anchorPart !== null || 'anchor_part' in h) h.anchor_part = hp.anchorPart;
    }
    return d;
}

/**
 * The config LUC3D sends: a copy with the run name set, W&B off, and nothing project-specific
 * baked in (sleap-nn re-derives the skeleton and node names from the training file; the worker
 * or Rust sets the labels paths, `ckpt_dir` and ZMQ ports).
 */
export function finalizeConfig(doc, o) {
    const d = clone(obj(doc) || {});
    if (!obj(d.trainer_config)) d.trainer_config = {};
    if (!obj(d.data_config)) d.data_config = {};
    const t = d.trainer_config, data = d.data_config;
    if (o && o.runName) t.run_name = o.runName;
    t.use_wandb = false;
    if (obj(t.wandb)) { t.wandb.api_key = ''; }
    data.skeletons = [];
    data.cache_img_path = null;
    data.train_labels_path = null;
    data.val_labels_path = null;
    data.test_file_path = null;
    t.resume_ckpt_path = null;
    // A preset's part_names / classes belong to another project; sleap-nn fills them in.
    const hc = obj(obj(d.model_config) && d.model_config.head_configs);
    if (hc) {
        for (const k of Object.keys(hc)) {
            const h = obj(hc[k]);
            if (!h) continue;
            for (const sub of Object.keys(h)) {
                const s = obj(h[sub]);
                if (s && 'part_names' in s) s.part_names = null;
                if (s && 'classes' in s) s.classes = null;
            }
        }
    }
    if (o && o.validationFraction != null) data.validation_fraction = o.validationFraction;
    if (o && o.overfit != null) data.use_same_data_for_val = !!o.overfit;
    return d;
}

/** sleap-app's training modes (TrainingConfigDialog's radios). */
export const TRAINING_MODES = Object.freeze([
    ['scratch', 'Train from scratch'],
    ['finetune', 'Fine-tune (start from prior weights)'],
    ['resume', 'Resume training (continue from checkpoint)'],
]);

/** sleap-app `parseYamlConfig`: a config that names a checkpoint is a Resume / Fine-tune of it. */
export function detectTrainingMode(doc) {
    const d = obj(doc) || {};
    const t = obj(d.trainer_config) || {}, m = obj(d.model_config) || {};
    if (typeof t.resume_ckpt_path === 'string' && t.resume_ckpt_path) return { mode: 'resume', checkpoint: t.resume_ckpt_path };
    if (typeof m.pretrained_backbone_weights === 'string' && m.pretrained_backbone_weights) return { mode: 'finetune', checkpoint: m.pretrained_backbone_weights };
    return { mode: 'scratch', checkpoint: null };
}

/**
 * sleap-app `applyHyperparamsToYaml`'s resume / fine-tune block on a copy: all three keys are always
 * written, so a stale checkpoint baked into a trained config never rides along. Resume =
 * `trainer_config.resume_ckpt_path`; Fine-tune = `model_config.pretrained_backbone_weights` and
 * `pretrained_head_weights`. (Local runs: Rust writes these itself from the checked checkpoint.)
 */
export function applyTrainingMode(doc, mode, checkpoint) {
    const d = clone(obj(doc) || {});
    if (!obj(d.trainer_config)) d.trainer_config = {};
    if (!obj(d.model_config)) d.model_config = {};
    const ck = checkpoint || null;
    d.trainer_config.resume_ckpt_path = mode === 'resume' && ck ? ck : null;
    d.model_config.pretrained_backbone_weights = mode === 'finetune' && ck ? ck : null;
    d.model_config.pretrained_head_weights = mode === 'finetune' && ck ? ck : null;
    return d;
}

/** Why a slot's training mode cannot start, or null (sleap-app: Resume needs a .ckpt; Fine-tune .ckpt or .h5). */
export function checkpointProblem(mode, checkpoint) {
    if (mode !== 'resume' && mode !== 'finetune') return null;
    if (!checkpoint) return mode === 'resume' ? 'Choose the checkpoint to resume from' : 'Choose the checkpoint to fine-tune from';
    const lower = String(checkpoint).toLowerCase();
    if (mode === 'resume' && !lower.endsWith('.ckpt')) return 'Resume training requires a .ckpt file (.h5 is only supported for Fine-tune).';
    if (mode === 'finetune' && !lower.endsWith('.ckpt') && !lower.endsWith('.h5')) return 'Fine-tune needs a .ckpt or .h5 file';
    return null;
}

/**
 * sleap-app `pickCheckpointFile`: the checkpoint of a run folder: `last.ckpt` (the newest epoch), else
 * `best.ckpt`, else another `.ckpt`; for Fine-tune, a legacy SLEAP `.h5` (`best_model.h5` first) last.
 */
export function pickCheckpointFile(names, mode) {
    const list = (names || []).map(String);
    const ckpts = list.filter(function (n) { return /\.ckpt$/i.test(n); });
    const pick = ckpts.find(function (n) { return n === 'last.ckpt'; }) || ckpts.find(function (n) { return n === 'best.ckpt'; }) || ckpts[0];
    if (pick) return pick;
    if (mode !== 'finetune') return null;
    const h5 = list.filter(function (n) { return /\.h5$/i.test(n); });
    return h5.find(function (n) { return n === 'best_model.h5'; }) || h5[0] || null;
}

/**
 * Anchor Part choices: Auto (none) then the skeleton's nodes, each with how often it is visible across the labelled
 * instances when `visibility` (whole percentages, node order) is given (sleap-app AnchorPartField).
 */
export function anchorChoices(nodeNames, visibility) {
    return [['', 'Auto']].concat((nodeNames || []).map(function (n, k) {
        const pct = visibility ? visibility[k] : null;
        return [n, pct == null ? n : n + ' (' + pct + '%)'];
    }));
}

export const ROTATION_OPTIONS = Object.freeze([['off', 'Off'], ['15', '±15°'], ['180', '±180°'], ['custom', 'Custom']]);
export const MAX_EPOCHS_HINT = 'Maximum number of epochs to train for. Training can be stopped manually or automatically if early stopping is enabled and a plateau is detected.';
export const BATCH_SIZE_HINT = 'Number of examples per minibatch. Higher numbers can increase generalization by averaging gradient updates over more examples, at the cost of more GPU memory.';
export const ROTATION_HINT = 'Rotation augmentation range. Off: disabled. ±15°: side-view cameras where upside-down would be unnatural. ±180°: top-view cameras where all orientations are valid.';
export const SCALE_HINT = 'Random scaling augmentation, applied to every example when on.';
export const ANCHOR_HINT = 'The body part each animal’s crop is centred on: pick a central one that is almost always visible (the % beside each node); Auto uses each animal’s centre of mass.';
export const CROP_HINT = 'The square cut around each animal for the centered-instance model: set it in Full Configuration, or Auto for the size sleap-nn computes from your labels.';
