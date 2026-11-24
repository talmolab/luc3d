/**
 * pose/connect/remote-training-plan.js — the DOM-free planning behind a REMOTE training run (the
 * Training panel on a SLEAP Connect worker).
 *
 * Port of the remote branch of sleap-app `src/stores/trainingStore.ts` `startTraining`
 * (`buildRemoteLabelsPayload`'s size limits, `src/lib/remoteLabelsPayload.ts`; the spec at
 * `trainingStore.ts:2323-2345`; `applyRemoteTelemetry`) @ c97c6a5.
 *
 * What it decides:
 *  - one `train` spec per training GROUP (`pose/training-groups.js`): the group's configs (one
 *    per model, centroid first), `model_types`, the group's training `.slp` inline
 *    (`labels_content`, base64), the project tag and the output folder. The store's
 *    `submitJob` splits a multi-model spec into one job per model (the worker runs
 *    `config_contents[0]` only) and hoists each config's `trainer_config.run_name` into the
 *    job's `run_name`;
 *  - the payload limits: warn above 10 MB, refuse above 150 MB (the worker's WebSocket takes
 *    256 MiB after base64);
 *  - progress rows: one per model of each group, fed by the job's telemetry
 *    (`applyTelemetry` / `withEpochSize` from `./job-stream.js`, the job viewer's reducer).
 *
 * LUCID changes from sleap-app:
 *  - one spec per group (sleap-app has one labels file, so one spec);
 *  - every video must already be visible to the worker: the file names its worker path (as
 *    remote inference does). sleap-app also embeds hidden videos' labelled frames; LUCID will
 *    later;
 *  - no `val_labels_path`: the protocol takes a validation file only as a WORKER path, so
 *    LUCID's split by moment cannot be sent inline yet. sleap-nn splits the training file at
 *    random on the worker (`validation_fraction`), and the panel says so.
 *
 * Imports only inside `pose/connect/` (Node tests: tests/test-remote-training-plan.mjs).
 */
import { emptyModelProgress, applyTelemetry, withEpochSize } from './job-stream.js';

export const REMOTE_LABELS_WARN_BYTES = 10 * 1024 * 1024;
export const REMOTE_LABELS_MAX_BYTES = 150 * 1024 * 1024;

/** Base64 of bytes, in 0x8000-byte chunks (sleap-app `buildRemoteLabelsPayload`). */
export function bytesToBase64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + 0x8000)));
    }
    if (typeof btoa === 'function') return btoa(bin);
    return Buffer.from(u8).toString('base64');
}

/**
 * Too big to send, worth a warning, or fine.
 * @returns {{level: 'ok'|'warn'|'refuse', message: string|null}}
 */
export function payloadCheck(byteLength) {
    const mb = (byteLength / (1024 * 1024)).toFixed(1);
    if (byteLength > REMOTE_LABELS_MAX_BYTES) {
        return { level: 'refuse', message: 'The training data is ' + mb + ' MB, more than the 150 MB a worker accepts in one job.' };
    }
    if (byteLength > REMOTE_LABELS_WARN_BYTES) {
        return { level: 'warn', message: 'The training data is ' + mb + ' MB; sending it to the worker takes a while.' };
    }
    return { level: 'ok', message: null };
}

/**
 * The `train` spec of one group.
 * @param {{configs: string[], modelTypes: string[], labelsContent: string, project?: Object,
 *          outputDir?: string|null}} o - `configs` are finished YAML texts (run name inside), in
 *   training order (centroid first)
 * @returns {Object}
 */
export function buildTrainSpec(o) {
    if (!o.configs || o.configs.length === 0) throw new Error('No training config.');
    if (o.configs.length !== (o.modelTypes || []).length) throw new Error('One model type per config.');
    const spec = {
        type: 'train',
        config_contents: o.configs.slice(),
        model_types: o.modelTypes.slice(),
        labels_content: o.labelsContent,
    };
    if (o.project) spec.project = o.project;
    if (o.outputDir) spec.output_dir = o.outputDir;
    return spec;
}

/**
 * The progress rows of a run: one per model of each group, in run order.
 * @param {Array<{group: {id: string, name: string}, models: Array<{label: string, head: string, maxEpochs: number}>}>} plan
 */
export function initialRows(plan) {
    const rows = [];
    for (const g of plan) {
        for (const m of g.models) {
            const p = emptyModelProgress(m.label, m.maxEpochs);
            p.groupId = g.group.id;
            p.head = m.head;
            p.modelDir = null;
            rows.push(p);
        }
    }
    return rows;
}

/** Fold one parsed telemetry event (`parseJobTelemetry`) into a row. */
export function rowWithTelemetry(row, t) {
    const next = applyTelemetry(row, t);
    return t.kind === 'epoch' ? withEpochSize(next) : next;
}

/** A row's last state when its job ends. */
export function finishRow(row, outcome) {
    const r = Object.assign({}, row);
    if (outcome.status === 'completed') {
        Object.assign(r, withEpochSize(r, true));
        r.status = 'completed';
        if (outcome.modelDir) r.modelDir = outcome.modelDir;
    } else if (outcome.status === 'cancelled') {
        r.status = 'cancelled';
    } else {
        r.status = 'failed';
    }
    return r;
}

/**
 * The text of a progress row's label (sleap-app's rows: "Training: Centroid (1/2)", "Centroid —
 * 12 epochs, best val_loss: 0.0031", "… — failed at epoch 3", "… — cancelled at epoch 3",
 * "… (pending)" / "(not started)").
 */
export function rowText(row, index, count, running) {
    if (row.status === 'running') return 'Training: ' + row.label + ' (' + (index + 1) + '/' + count + ')';
    if (row.status === 'completed') {
        return row.label + ' — ' + row.epochSamples.length + ' epochs' +
            (row.bestValLoss != null ? ', best val_loss: ' + row.bestValLoss.toFixed(4) : '');
    }
    if (row.status === 'failed') return row.label + ' — failed at epoch ' + row.epoch;
    if (row.status === 'cancelled') return row.label + ' — cancelled at epoch ' + row.epoch;
    return row.label + (running ? ' (pending)' : ' (not started)');
}
