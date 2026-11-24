/**
 * test-remote-training-plan.mjs — pose/connect/remote-training-plan.js: the train spec of a group,
 * the payload limits, base64, and the progress rows fed by the job's telemetry.
 */
import assert from 'node:assert/strict';
import {
    bytesToBase64, payloadCheck, buildTrainSpec, initialRows, rowWithTelemetry, finishRow, rowText,
    REMOTE_LABELS_WARN_BYTES, REMOTE_LABELS_MAX_BYTES,
} from '../pose/connect/remote-training-plan.js';

// §1 base64 (chunked) equals Node's.
const big = new Uint8Array(100000).map((_, i) => (i * 31) & 255);
assert.equal(bytesToBase64(big), Buffer.from(big).toString('base64'));
assert.equal(bytesToBase64(new Uint8Array([104, 105])), 'aGk=');

// §2 payload limits (sleap-app: warn 10 MB, refuse 150 MB).
assert.equal(payloadCheck(1000).level, 'ok');
assert.equal(payloadCheck(REMOTE_LABELS_WARN_BYTES + 1).level, 'warn');
assert.equal(payloadCheck(REMOTE_LABELS_MAX_BYTES + 1).level, 'refuse');
assert.match(payloadCheck(REMOTE_LABELS_MAX_BYTES + 1).message, /150 MB/);

// §3 spec.
const spec = buildTrainSpec({ configs: ['a: 1', 'b: 2'], modelTypes: ['centroid', 'centered_instance'], labelsContent: 'AAAA',
    project: { id: 'p1', name: 'x.slp' }, outputDir: '/data/sess' });
assert.deepEqual(spec, { type: 'train', config_contents: ['a: 1', 'b: 2'], model_types: ['centroid', 'centered_instance'],
    labels_content: 'AAAA', project: { id: 'p1', name: 'x.slp' }, output_dir: '/data/sess' });
assert.ok(!('val_labels_path' in spec) && !('labels_path' in spec));
assert.ok(!('output_dir' in buildTrainSpec({ configs: ['a'], modelTypes: ['bottomup'], labelsContent: 'A' })));
assert.throws(() => buildTrainSpec({ configs: [], modelTypes: [], labelsContent: '' }), /No training config/);
assert.throws(() => buildTrainSpec({ configs: ['a'], modelTypes: [], labelsContent: '' }), /One model type per config/);

// §4 rows and telemetry.
const rows = initialRows([
    { group: { id: 'all', name: 'all views' }, models: [{ label: 'Centroid · all views', head: 'centroid', maxEpochs: 40 }, { label: 'Centered Instance · all views', head: 'centered_instance', maxEpochs: 40 }] },
]);
assert.equal(rows.length, 2);
assert.equal(rows[0].status, 'pending');
assert.equal(rowText(rows[1], 1, 2, true), 'Centered Instance · all views (pending)');
assert.equal(rowText(rows[1], 1, 2, false), 'Centered Instance · all views (not started)');
let r = Object.assign({}, rows[0], { status: 'running' });
assert.equal(rowText(r, 0, 2, true), 'Training: Centroid · all views (1/2)');
r = rowWithTelemetry(r, { kind: 'epoch', epoch: 0, trainLoss: 0.02, valLoss: 0.03 });
r = rowWithTelemetry(r, { kind: 'epoch', epoch: 1, trainLoss: 0.01, valLoss: 0.025 });
r = rowWithTelemetry(r, { kind: 'curve', points: [{ x: 0, y: 0.05 }, { x: 107, y: 0.01 }] });
r = rowWithTelemetry(r, { kind: 'metric', epoch: 2, totalEpochs: 50, latestTrainLoss: 0.011, latestValLoss: 0.025, bestLoss: 0.025, wandbUrl: null, etaSeconds: 30 });
assert.equal(r.epoch, 2);
assert.equal(r.maxEpochs, 50);
assert.equal(r.loss, 0.011);
assert.equal(r.bestValLoss, 0.025);
assert.equal(r.batchSamples.length, 2);
assert.equal(r.status, 'running', 'telemetry keeps the status');
const done = finishRow(r, { status: 'completed', modelDir: '/data/sess/models/run1' });
assert.equal(done.status, 'completed');
assert.equal(done.modelDir, '/data/sess/models/run1');
assert.equal(rowText(done, 0, 2, false), 'Centroid · all views — 2 epochs, best val_loss: 0.0250');
assert.equal(rowText(finishRow(r, { status: 'failed' }), 0, 2, false), 'Centroid · all views — failed at epoch 2');
assert.equal(rowText(finishRow(r, { status: 'cancelled' }), 0, 2, false), 'Centroid · all views — cancelled at epoch 2');

console.log('test-remote-training-plan: ok');
