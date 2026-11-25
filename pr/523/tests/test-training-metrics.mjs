/**
 * test-training-metrics.mjs — pose/training-metrics.js: the Training Monitor's runtime lines
 * (sleap-app `trainingMetrics.ts` / PyQt monitor.py parity).
 */
import assert from 'node:assert/strict';
import { computeRuntimeMetrics, formatRuntimeTitle, mmss, rowRuntimeLines, plateauSettings } from '../pose/training-metrics.js';

assert.equal(mmss(0), '00:00');
assert.equal(mmss(252.9), '04:12');
assert.equal(mmss(3725), '62:05');

// §1 plateau: an improvement must beat the best by more than min_delta.
const samples = [
    { epoch: 0, trainLoss: 0.1, valLoss: 0.05 },
    { epoch: 1, trainLoss: 0.05, valLoss: 0.03 },
    { epoch: 2, trainLoss: 0.04, valLoss: 0.031 },
    { epoch: 3, trainLoss: 0.035, valLoss: 0.0299999 },
];
const m = computeRuntimeMetrics(samples, 0, 80000, 0.001);
assert.equal(m.bestValEpoch, 1);
assert.equal(m.epochsInPlateau, 2);
assert.equal(m.inPlateau, true);
assert.equal(m.meanEpochTimeSec, 20);
assert.equal(m.etaNext10Min, 3);
const m0 = computeRuntimeMetrics(samples, 0, 80000, null);
assert.equal(m0.bestValEpoch, 3, 'no delta: a tiny improvement counts');
assert.equal(computeRuntimeMetrics([], 0, 1000, null).meanEpochTimeSec, null);

// §2 the title lines.
const lines = formatRuntimeTitle({ epoch: 3, maxEpochs: 40, totalRuntimeMs: 80000, epochRuntimeMs: 7000, metrics: m, plateauPatience: 5,
    lastValLoss: 0.0299999, bestValLoss: 0.03, bestValEpoch: 1 });
assert.deepEqual(lines, [
    'Training Epoch 4 / Total Runtime: 01:20 / Epoch Runtime: 00:07',
    'Mean Time per Epoch: 00:20 / ETA Next 10 Epochs: 3 min',
    'Epochs in Plateau: 2 / 5',
    'Last Epoch Validation Loss: 3.000e-2',
    'Best Epoch Validation Loss: 3.000e-2 (epoch 2)',
]);
assert.deepEqual(formatRuntimeTitle({ epoch: 0, maxEpochs: 40, totalRuntimeMs: 3000, epochRuntimeMs: null, metrics: computeRuntimeMetrics([], 0, 0, null),
    plateauPatience: null, lastValLoss: null, bestValLoss: null, bestValEpoch: null }), ['Training Epoch 1 / Total Runtime: 00:03']);

// §3 a row's lines (the panel's rows).
const row = { status: 'running', epoch: 4, maxEpochs: 40, epochSamples: samples, bestValLoss: 0.03, startedAt: 1000, epochStartedAt: 79000,
    plateauPatience: 5, plateauMinDelta: 0.001 };
const rl = rowRuntimeLines(row, 81000);
assert.equal(rl[0], 'Training Epoch 5 / Total Runtime: 01:20 / Epoch Runtime: 00:02');
assert.equal(rl[2], 'Epochs in Plateau: 2 / 5');
const doneRow = Object.assign({}, row, { status: 'completed', endedAt: 81000 });
assert.ok(!/Epoch Runtime/.test(rowRuntimeLines(doneRow, 999999)[0]), 'a finished row shows no epoch runtime');

// §4 plateau settings from a config.
assert.deepEqual(plateauSettings({ trainer_config: { early_stopping: { min_delta: 1e-8, patience: 10, stop_training_on_plateau: true } } }), { patience: 10, minDelta: 1e-8 });
assert.deepEqual(plateauSettings({ trainer_config: { early_stopping: { patience: 10, stop_training_on_plateau: false } } }), { patience: null, minDelta: 1e-8 });
assert.deepEqual(plateauSettings({}), { patience: null, minDelta: 1e-8 });

console.log('test-training-metrics: ok');
