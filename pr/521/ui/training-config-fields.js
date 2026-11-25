/**
 * ui/training-config-fields.js — the fields of the Training panel's Full Configuration dialog
 * (`ui/training-config-dialog.js`): sleap-app's `TrainingConfigDialog.tsx` field set (same
 * sections, labels and hints @ c97c6a5), each mapped straight to sleap-nn config keys.
 *
 * DOM-free (Node tests: tests/test-training-config-fields.mjs). A field is
 *   `{id, tab: 'pipeline'|'head', section, label, hint?, kind, get(doc), set(doc, v), options?,
 *     min?, max?, step?, nullable?, when?(doc, ctx), note?}`
 * with kind `int | float | bool | select | text`. Pipeline fields are written to EVERY model's config
 * (sleap-app: pipeline-wide); head fields to the shown model's.
 *
 * LUCID changes: no W&B (forced off: an API key would sit in the config), Number of Devices fixed at
 * 1 and no Multi-GPU Strategy (Rust forces both), no Export Model; the Runs Folder is the panel's;
 * the run name is LUCID's; the backbone can be read but only UNet's settings edited (load a config
 * that uses ConvNeXt / Swin Transformer to train one). Post-training inference settings live in the
 * panel's Data section (the dialog shows the same values).
 */

import { hyperparamsFromConfig, ROTATION_OPTIONS, MAX_EPOCHS_HINT, BATCH_SIZE_HINT, ROTATION_HINT, SCALE_HINT } from './training-args.js?v=d8c111d6b6c2';

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }

/** The value at a dotted path, or undefined. */
export function getPath(doc, path) {
    let cur = doc;
    for (const k of path.split('.')) { if (!obj(cur)) return undefined; cur = cur[k]; }
    return cur;
}

/** Set a dotted path, creating sections on the way. */
export function setPath(doc, path, v) {
    const ks = path.split('.');
    let cur = doc;
    for (let i = 0; i < ks.length - 1; i++) {
        if (!obj(cur[ks[i]])) cur[ks[i]] = {};
        cur = cur[ks[i]];
    }
    cur[ks[ks.length - 1]] = v;
}

const at = (path) => ({ get: (d) => getPath(d, path), set: (d, v) => setPath(d, path, v) });
const G = 'data_config.augmentation_config.geometric.';
const I = 'data_config.augmentation_config.intensity.';
const LR = 'trainer_config.lr_scheduler.';

/** The trained head's config block (`model_config.head_configs.<head>`). */
function head(d) {
    const hc = obj(getPath(d, 'model_config.head_configs'));
    if (!hc) return null;
    for (const k of Object.keys(hc)) if (obj(hc[k])) return { name: k, block: hc[k] };
    return null;
}
function headConfmaps(d) { const h = head(d); return h ? (obj(h.block.confmaps) || h.block) : null; }
function headPart(d, part) { const h = head(d); return h ? obj(h.block[part]) : null; }

/** Rotation as the panel writes it (`applyPanelSettings`): off / ±15 / ±180 / ±custom, affine_p 1 when on. */
function setRotation(d, preset, angle) {
    const a = preset === '15' ? 15 : preset === '180' ? 180 : Math.max(0, Math.min(180, Number(angle) || 0));
    if (preset === 'off') { setPath(d, G + 'rotation_min', 0); setPath(d, G + 'rotation_max', 0); setPath(d, G + 'affine_p', 0); return; }
    setPath(d, G + 'rotation_min', -a); setPath(d, G + 'rotation_max', a); setPath(d, G + 'affine_p', 1.0);
}

/** An "on/off + range" augmentation: on = p 1.0 (sleap-app's toggles). */
function toggleP(prefix) {
    return { get: (d) => Number(getPath(d, prefix + '_p')) > 0, set: (d, v) => setPath(d, prefix + '_p', v ? 1.0 : 0) };
}

export const LR_SCHEDULERS = Object.freeze([
    ['none', 'None'], ['reduce_lr_on_plateau', 'Reduce on Plateau'], ['step_lr', 'Step'],
    ['cosine_annealing_warmup', 'Cosine Annealing (warmup)'], ['linear_warmup_linear_decay', 'Linear Warmup, Linear Decay'],
]);
const LR_DEFAULTS = {
    reduce_lr_on_plateau: { threshold: 1e-6, threshold_mode: 'abs', cooldown: 3, patience: 5, factor: 0.5, min_lr: 1e-8 },
    step_lr: { step_size: 10, gamma: 0.1 },
    cosine_annealing_warmup: { warmup_epochs: 5, max_epochs: null, warmup_start_lr: 0.0, eta_min: 0.0 },
    linear_warmup_linear_decay: { warmup_epochs: 5, max_epochs: null, warmup_start_lr: 0.0, end_lr: 0.0 },
};
function activeScheduler(d) {
    const s = obj(getPath(d, 'trainer_config.lr_scheduler'));
    if (!s) return 'none';
    for (const [k] of LR_SCHEDULERS) if (k !== 'none' && obj(s[k])) return k;
    return 'none';
}

/** The fields, in the dialog's order. */
export const CONFIG_FIELDS = Object.freeze([
    // ---------------------------------------------------------------- Pipeline tab
    { id: 'sigmaNodes', tab: 'pipeline', section: 'Pipeline Type', label: 'Sigma for Nodes', kind: 'float', min: 0.1, max: 50, step: 0.1,
        hint: 'Gaussian spread for node confidence maps. Controls how wide the target peak is around each keypoint location.',
        get: (d) => { const c = headConfmaps(d); return c ? c.sigma : undefined; }, set: (d, v) => { const c = headConfmaps(d); if (c) c.sigma = v; } },
    { id: 'convertColors', tab: 'pipeline', section: 'Pre-processing / Post-processing', label: 'Convert Colors', kind: 'select',
        options: [['auto', 'Auto'], ['rgb', 'RGB'], ['grayscale', 'Grayscale']],
        hint: 'Convert input images to a specific channel format. Use RGB for pretrained backbones or Grayscale for single-channel videos.',
        get: (d) => getPath(d, 'data_config.preprocessing.ensure_rgb') ? 'rgb' : getPath(d, 'data_config.preprocessing.ensure_grayscale') ? 'grayscale' : 'auto',
        set: (d, v) => { setPath(d, 'data_config.preprocessing.ensure_rgb', v === 'rgb'); setPath(d, 'data_config.preprocessing.ensure_grayscale', v === 'grayscale'); } },
    { id: 'dataPipeline', tab: 'pipeline', section: 'Performance', label: 'Data Pipeline', kind: 'select',
        options: [['torch_dataset', 'Stream (no caching)'], ['torch_dataset_cache_img_memory', 'Cache in Memory'], ['torch_dataset_cache_img_disk', 'Cache to Disk']],
        hint: 'How training data is loaded. ‘Cache in Memory’ is fastest but uses more RAM. ‘Stream’ reads from disk each epoch. ‘Cache to Disk’ saves processed data to disk.',
        get: (d) => getPath(d, 'data_config.data_pipeline_fw') || 'torch_dataset',
        set: (d, v) => {
            setPath(d, 'data_config.data_pipeline_fw', v);
            // sleap-nn's streaming pipeline needs num_workers 0.
            if (v === 'torch_dataset') { setPath(d, 'trainer_config.train_data_loader.num_workers', 0); setPath(d, 'trainer_config.val_data_loader.num_workers', 0); }
        } },
    { id: 'dataloaderWorkers', tab: 'pipeline', section: 'Performance', label: 'Dataloader Workers', kind: 'int', min: 0, max: 64,
        hint: 'Parallel workers for loading training data. More workers = faster loading but more CPU / memory. 0 = main thread only. Only takes effect with a caching pipeline.',
        when: (d) => (getPath(d, 'data_config.data_pipeline_fw') || 'torch_dataset') !== 'torch_dataset',
        get: (d) => getPath(d, 'trainer_config.train_data_loader.num_workers'),
        set: (d, v) => { setPath(d, 'trainer_config.train_data_loader.num_workers', v); setPath(d, 'trainer_config.val_data_loader.num_workers', v); } },
    { id: 'accelerator', tab: 'pipeline', section: 'Performance', label: 'Accelerator', kind: 'select',
        options: [['auto', 'Auto'], ['gpu', 'CUDA (GPU)'], ['mps', 'MPS (Apple Silicon)'], ['cpu', 'CPU']],
        hint: 'Hardware to use for training. ‘Auto’ detects available hardware. Use CUDA for NVIDIA GPUs, MPS for Apple Silicon, or CPU (slow).',
        get: (d) => getPath(d, 'trainer_config.trainer_accelerator') || 'auto', set: (d, v) => setPath(d, 'trainer_config.trainer_accelerator', v) },
    { id: 'numDevices', tab: 'pipeline', section: 'Performance', label: 'Number of Devices', kind: 'int', min: 1, max: 1, readOnly: true,
        note: 'LUCID trains on one device.', get: () => 1, set: () => {} },
    { id: 'evalEnable', tab: 'pipeline', section: 'Evaluation', label: 'Run evaluation during training', kind: 'bool',
        hint: 'Run inference on validation frames at epoch intervals and compute pose metrics (mOKS, mAP, PCK). Useful for monitoring training quality beyond loss.',
        ...at('trainer_config.eval.enabled') },
    { id: 'evalFrequency', tab: 'pipeline', section: 'Evaluation', label: 'Frequency (epochs)', kind: 'int', min: 1, max: 1000,
        when: (d) => !!getPath(d, 'trainer_config.eval.enabled'), ...at('trainer_config.eval.frequency') },
    { id: 'evalOksStddev', tab: 'pipeline', section: 'Evaluation', label: 'OKS Std. Dev.', kind: 'float', min: 0.001, max: 1, step: 0.005,
        hint: 'Object Keypoint Similarity standard deviation used when scoring evaluation predictions.',
        when: (d) => !!getPath(d, 'trainer_config.eval.enabled'), ...at('trainer_config.eval.oks_stddev') },
    { id: 'evalOksScale', tab: 'pipeline', section: 'Evaluation', label: 'OKS Scale', kind: 'float', nullable: true, min: 0, step: 0.1,
        hint: 'Override the OKS scale used during evaluation. Leave empty to use the model’s own scale.',
        when: (d) => !!getPath(d, 'trainer_config.eval.enabled'), ...at('trainer_config.eval.oks_scale') },
    { id: 'checkpointTopK', tab: 'pipeline', section: 'Output', label: 'Keep Top N', kind: 'int', min: -1, max: 100,
        hint: 'How many of the best checkpoints to keep. -1 keeps all of them.', ...at('trainer_config.model_ckpt.save_top_k') },
    { id: 'checkpointLast', tab: 'pipeline', section: 'Output', label: 'Save the latest checkpoint (last.ckpt)', kind: 'bool',
        hint: 'Also save a last.ckpt after every checkpoint, useful for resuming training.', ...at('trainer_config.model_ckpt.save_last') },
    { id: 'visualization', tab: 'pipeline', section: 'Output', label: 'Visualize Predictions', kind: 'bool',
        hint: 'Save sample prediction images each epoch (the Training Monitor shows them while a local run goes).',
        ...at('trainer_config.visualize_preds_during_training') },
    { id: 'keepViz', tab: 'pipeline', section: 'Output', label: 'Keep Viz Images', kind: 'bool',
        hint: 'Keep the prediction images after training instead of deleting them.',
        when: (d) => !!getPath(d, 'trainer_config.visualize_preds_during_training'), ...at('trainer_config.keep_viz') },

    // ---------------------------------------------------------------- per-model tabs
    { id: 'validationFraction', tab: 'head', section: 'Data', label: 'Validation Fraction', kind: 'float', min: 0.01, max: 0.5, step: 0.01,
        hint: 'Fraction of labeled frames to use as a validation set. Ignored if “Overfit Mode” is enabled. Locally, LUCID keeps all views of one moment on the same side.',
        ...at('data_config.validation_fraction') },
    { id: 'overfitMode', tab: 'head', section: 'Data', label: 'Overfit Mode (train=val)', kind: 'bool',
        hint: 'If enabled, the same data will be used for both training and validation. Useful for intentional overfitting on small datasets (fewer than 10 labeled frames) to test model capacity.',
        ...at('data_config.use_same_data_for_val') },
    { id: 'randomSeed', tab: 'head', section: 'Data', label: 'Random Seed', kind: 'int', nullable: true, min: 0, max: 2147483647, ...at('trainer_config.seed') },
    { id: 'inputScaling', tab: 'head', section: 'Data', label: 'Input Scaling', kind: 'float', min: 0.05, max: 2, step: 0.05,
        hint: 'Rescaling factor applied to input images before training. Values below 1.0 downsample the image, which reduces memory and speeds up training at the cost of precision.',
        ...at('data_config.preprocessing.scale') },
    { id: 'cropSize', tab: 'head', section: 'Data', label: 'Crop Size', kind: 'int', nullable: true, min: 16, max: 4096,
        hint: 'Bounding box crop size around each instance in pixels. Leave empty (Auto) to compute it from the data.',
        when: (d) => { const h = head(d); return !!h && (h.name === 'centered_instance' || h.name === 'multi_class_topdown'); },
        ...at('data_config.preprocessing.crop_size') },

    { id: 'rotation', tab: 'head', section: 'Augmentation', label: 'Rotation', kind: 'select', options: ROTATION_OPTIONS, hint: ROTATION_HINT,
        get: (d) => hyperparamsFromConfig(d).rotationPreset,
        set: (d, v) => setRotation(d, v, v === 'custom' ? hyperparamsFromConfig(d).rotationCustomAngle : 0) },
    { id: 'rotationAngle', tab: 'head', section: 'Augmentation', label: 'Rotation (\u00b1 degrees)', kind: 'float', min: 0, max: 180, step: 1,
        when: (d) => hyperparamsFromConfig(d).rotationPreset === 'custom',
        get: (d) => hyperparamsFromConfig(d).rotationCustomAngle, set: (d, v) => setRotation(d, 'custom', v) },
    { id: 'scaleAug', tab: 'head', section: 'Augmentation', label: 'Scale', kind: 'bool', hint: SCALE_HINT,
        get: (d) => !(Number(getPath(d, G + 'scale_min')) === 1 && Number(getPath(d, G + 'scale_max')) === 1),
        set: (d, v) => { setPath(d, G + 'scale_min', v ? 0.9 : 1.0); setPath(d, G + 'scale_max', v ? 1.1 : 1.0); } },
    { id: 'scaleMin', tab: 'head', section: 'Augmentation', label: 'Scale Min', kind: 'float', min: 0.1, max: 1, step: 0.05,
        when: (d) => !(Number(getPath(d, G + 'scale_min')) === 1 && Number(getPath(d, G + 'scale_max')) === 1), ...at(G + 'scale_min') },
    { id: 'scaleMax', tab: 'head', section: 'Augmentation', label: 'Scale Max', kind: 'float', min: 1, max: 4, step: 0.05,
        when: (d) => !(Number(getPath(d, G + 'scale_min')) === 1 && Number(getPath(d, G + 'scale_max')) === 1), ...at(G + 'scale_max') },
    { id: 'uniformNoise', tab: 'head', section: 'Augmentation', label: 'Uniform Noise', kind: 'bool', ...toggleP(I + 'uniform_noise') },
    { id: 'gaussianNoise', tab: 'head', section: 'Augmentation', label: 'Gaussian Noise', kind: 'bool', ...toggleP(I + 'gaussian_noise') },
    { id: 'contrast', tab: 'head', section: 'Augmentation', label: 'Contrast', kind: 'bool', ...toggleP(I + 'contrast') },
    { id: 'brightness', tab: 'head', section: 'Augmentation', label: 'Brightness', kind: 'bool', ...toggleP(I + 'brightness') },

    { id: 'maxEpochs', tab: 'head', section: 'Optimization', label: 'Max Epochs', kind: 'int', min: 1, max: 10000, hint: MAX_EPOCHS_HINT,
        ...at('trainer_config.max_epochs') },
    { id: 'batchSize', tab: 'head', section: 'Optimization', label: 'Batch Size', kind: 'int', min: 1, max: 512, hint: BATCH_SIZE_HINT,
        get: (d) => getPath(d, 'trainer_config.train_data_loader.batch_size'),
        set: (d, v) => { setPath(d, 'trainer_config.train_data_loader.batch_size', v); setPath(d, 'trainer_config.val_data_loader.batch_size', v); } },
    { id: 'learningRate', tab: 'head', section: 'Optimization', label: 'Initial Learning Rate', kind: 'float', min: 1e-7, max: 1, step: 0.00001,
        hint: 'The initial learning rate for the optimizer. Typically 1e-3 or 1e-4. If too high or too low, training may fail to find good initial local minima.',
        ...at('trainer_config.optimizer.lr') },
    { id: 'lrSchedulerType', tab: 'head', section: 'Optimization', label: 'LR Scheduler', kind: 'select', options: LR_SCHEDULERS,
        hint: 'How the learning rate changes over training. Reduce on Plateau lowers it when validation loss stalls; Step decays it on a fixed schedule; the warmup schedulers ramp up then decay it.',
        get: activeScheduler,
        set: (d, v) => {
            const cur = activeScheduler(d);
            if (v === cur) return;
            for (const [k] of LR_SCHEDULERS) if (k !== 'none') setPath(d, LR + k, null);
            if (v !== 'none') setPath(d, LR + v, Object.assign({}, LR_DEFAULTS[v]));
        } },
    { id: 'lrPatience', tab: 'head', section: 'Optimization', label: 'LR Patience', kind: 'int', min: 0, max: 1000,
        when: (d) => activeScheduler(d) === 'reduce_lr_on_plateau', ...at(LR + 'reduce_lr_on_plateau.patience') },
    { id: 'lrFactor', tab: 'head', section: 'Optimization', label: 'Factor', kind: 'float', min: 0.01, max: 0.99, step: 0.05,
        when: (d) => activeScheduler(d) === 'reduce_lr_on_plateau', ...at(LR + 'reduce_lr_on_plateau.factor') },
    { id: 'lrMinLR', tab: 'head', section: 'Optimization', label: 'Min LR', kind: 'float', min: 0, step: 1e-8,
        when: (d) => activeScheduler(d) === 'reduce_lr_on_plateau', ...at(LR + 'reduce_lr_on_plateau.min_lr') },
    { id: 'lrStepSize', tab: 'head', section: 'Optimization', label: 'Step Size', kind: 'int', min: 1, max: 1000,
        when: (d) => activeScheduler(d) === 'step_lr', ...at(LR + 'step_lr.step_size') },
    { id: 'lrGamma', tab: 'head', section: 'Optimization', label: 'Gamma', kind: 'float', min: 0.001, max: 1, step: 0.05,
        when: (d) => activeScheduler(d) === 'step_lr', ...at(LR + 'step_lr.gamma') },
    { id: 'lrWarmupEpochs', tab: 'head', section: 'Optimization', label: 'Warmup Epochs', kind: 'int', min: 0, max: 1000,
        when: (d) => /warmup/.test(activeScheduler(d)), get: (d) => getPath(d, LR + activeScheduler(d) + '.warmup_epochs'),
        set: (d, v) => setPath(d, LR + activeScheduler(d) + '.warmup_epochs', v) },
    { id: 'stopOnPlateau', tab: 'head', section: 'Optimization', label: 'Stop Training on Plateau', kind: 'bool',
        hint: 'If enabled, training will terminate automatically when the validation loss plateaus. This saves time and compute, and prevents training into the overfitting regime.',
        ...at('trainer_config.early_stopping.stop_training_on_plateau') },
    { id: 'plateauMinDelta', tab: 'head', section: 'Optimization', label: 'Plateau Min. Delta', kind: 'float', min: 0, step: 1e-8,
        hint: 'Minimum absolute decrease in the loss in order to consider an epoch as not in a plateau.',
        when: (d) => getPath(d, 'trainer_config.early_stopping.stop_training_on_plateau') !== false, ...at('trainer_config.early_stopping.min_delta') },
    { id: 'plateauPatience', tab: 'head', section: 'Optimization', label: 'Plateau Patience', kind: 'int', min: 1, max: 1000,
        hint: 'Number of epochs without an improvement of at least min_delta in order for a plateau to be detected.',
        when: (d) => getPath(d, 'trainer_config.early_stopping.stop_training_on_plateau') !== false, ...at('trainer_config.early_stopping.patience') },
    { id: 'onlineMining', tab: 'head', section: 'Optimization', label: 'Online Mining', kind: 'bool',
        hint: 'If enabled, online hard keypoint mining (OHKM) weighs the hardest keypoints more, so training focuses on tricky body parts.',
        ...at('trainer_config.online_hard_keypoint_mining.online_mining') },
    { id: 'hardToEasyRatio', tab: 'head', section: 'Optimization', label: 'Hard/Easy Ratio', kind: 'float', min: 1, max: 100, step: 0.5,
        when: (d) => !!getPath(d, 'trainer_config.online_hard_keypoint_mining.online_mining'), ...at('trainer_config.online_hard_keypoint_mining.hard_to_easy_ratio') },

    { id: 'backbone', tab: 'head', section: 'Model', label: 'Backbone', kind: 'text', readOnly: true,
        hint: 'The backbone architecture. UNet is the default and works well for most cases; to train ConvNeXt or Swin Transformer, load a config that uses one.',
        get: (d) => { const b = obj(getPath(d, 'model_config.backbone_config')); if (!b) return ''; for (const k of Object.keys(b)) if (obj(b[k])) return k === 'unet' ? 'UNet' : k === 'convnext' ? 'ConvNeXt' : k === 'swint' ? 'Swin Transformer' : k; return ''; },
        set: () => {} },
    { id: 'maxStride', tab: 'head', section: 'Model', label: 'Max Stride', kind: 'select', options: [['8', '8'], ['16', '16'], ['32', '32'], ['64', '64']],
        when: (d) => !!obj(getPath(d, 'model_config.backbone_config.unet')),
        get: (d) => String(getPath(d, 'model_config.backbone_config.unet.max_stride')), set: (d, v) => setPath(d, 'model_config.backbone_config.unet.max_stride', Number(v)) },
    { id: 'filters', tab: 'head', section: 'Model', label: 'Filters', kind: 'int', min: 4, max: 256,
        when: (d) => !!obj(getPath(d, 'model_config.backbone_config.unet')), ...at('model_config.backbone_config.unet.filters') },
    { id: 'filtersRate', tab: 'head', section: 'Model', label: 'Filters Rate', kind: 'float', min: 1, max: 4, step: 0.25,
        when: (d) => !!obj(getPath(d, 'model_config.backbone_config.unet')), ...at('model_config.backbone_config.unet.filters_rate') },
    { id: 'middleBlock', tab: 'head', section: 'Model', label: 'Middle Block', kind: 'bool',
        when: (d) => !!obj(getPath(d, 'model_config.backbone_config.unet')), ...at('model_config.backbone_config.unet.middle_block') },
    { id: 'upInterpolate', tab: 'head', section: 'Model', label: 'Up Interpolate', kind: 'bool',
        when: (d) => !!obj(getPath(d, 'model_config.backbone_config.unet')), ...at('model_config.backbone_config.unet.up_interpolate') },
    { id: 'sigma', tab: 'head', section: 'Model', label: 'Sigma', kind: 'float', min: 0.1, max: 50, step: 0.1,
        hint: 'Spread of the Gaussian distribution of the confidence maps. Smaller values are more precise but harder to learn; larger values are easier to learn but less precise. In pixels of the model input image.',
        get: (d) => { const c = headConfmaps(d); return c ? c.sigma : undefined; }, set: (d, v) => { const c = headConfmaps(d); if (c) c.sigma = v; } },
    { id: 'outputStride', tab: 'head', section: 'Model', label: 'Output Stride', kind: 'select', options: [['1', '1'], ['2', '2'], ['4', '4'], ['8', '8']],
        get: (d) => { const c = headConfmaps(d); return c && c.output_stride != null ? String(c.output_stride) : ''; },
        set: (d, v) => { const c = headConfmaps(d); if (c) c.output_stride = Number(v); } },
    { id: 'pafsLossWeight', tab: 'head', section: 'Model', label: 'PAFs Loss Weight', kind: 'float', min: 0.01, max: 100, step: 0.1,
        when: (d) => !!headPart(d, 'pafs'), get: (d) => { const p = headPart(d, 'pafs'); return p ? p.loss_weight : undefined; },
        set: (d, v) => { const p = headPart(d, 'pafs'); if (p) p.loss_weight = v; } },
]);

/** The section order of each tab (the dialog's left nav). */
export const SECTIONS = Object.freeze({
    pipeline: ['Pipeline Type', 'Pre-processing / Post-processing', 'Performance', 'Evaluation', 'Output'],
    head: ['Data', 'Augmentation', 'Optimization', 'Model'],
});

/** sleap-app's field search: every word of the query must appear in the label, hint or section. */
export function searchFields(query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return CONFIG_FIELDS.filter(function (f) {
        const text = (f.label + ' ' + (f.hint || '') + ' ' + f.section).toLowerCase();
        return words.every(function (w) { return text.indexOf(w) !== -1; });
    });
}

/** Clamp and type a value for a field (null when the field is nullable and the value empty). */
export function coerce(field, raw) {
    if (field.kind === 'bool') return !!raw;
    if (field.kind === 'select' || field.kind === 'text') return String(raw);
    if (raw === '' || raw == null) return field.nullable ? null : undefined;
    let n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    if (field.kind === 'int') n = Math.round(n);
    if (field.min != null) n = Math.max(field.min, n);
    if (field.max != null) n = Math.min(field.max, n);
    return n;
}
