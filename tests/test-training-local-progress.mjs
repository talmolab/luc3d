/**
 * test-training-local-progress.mjs — pose/training-local-progress.js: a local run's ZMQ progress
 * messages folded into a progress row (sleap-app parity).
 */
import assert from 'node:assert/strict';
import { rowWithLocalProgress, MAX_BATCH_SAMPLES } from '../pose/training-local-progress.js';
import { emptyModelProgress } from '../pose/connect/job-stream.js';

let r = emptyModelProgress('Centroid · all views', 10);
r = rowWithLocalProgress(r, { name: 'train_begin', epoch: null, batch: null, logs: {}, nan: false }, 1000);
r = rowWithLocalProgress(r, { name: 'epoch_begin', epoch: 0, batch: null, logs: {}, nan: false }, 2000);
assert.equal(r.epochStartedAt, 2000);
for (let b = 0; b < 5; b++) r = rowWithLocalProgress(r, { name: 'batch_end', epoch: 0, batch: b, logs: { loss: 0.5 - b * 0.05 }, nan: false });
assert.equal(r.epochSize, 5);
assert.deepEqual(r.batchSamples.map((s) => s.globalBatch), [0, 1, 2, 3, 4]);
r = rowWithLocalProgress(r, { name: 'epoch_end', epoch: 0, batch: null, logs: { 'train/loss': 0.4, 'val/loss': 0.45 }, nan: false }, 3000);
assert.equal(r.epoch, 1);
assert.equal(r.loss, 0.4);
assert.equal(r.bestValLoss, 0.45);
assert.deepEqual(r.epochSamples, [{ epoch: 0, trainLoss: 0.4, valLoss: 0.45 }]);
// Epoch 1: batches continue on the global axis; a better val loss becomes best.
r = rowWithLocalProgress(r, { name: 'batch_end', epoch: 1, batch: 2, logs: { loss: 0.3 }, nan: false });
assert.equal(r.batchSamples[r.batchSamples.length - 1].globalBatch, 7);
r = rowWithLocalProgress(r, { name: 'epoch_end', epoch: 1, batch: null, logs: { loss: 0.3, 'val/loss': 0.35 }, nan: false });
assert.equal(r.loss, 0.3, 'falls back to logs.loss');
assert.equal(r.bestValLoss, 0.35);
// A worse one does not.
r = rowWithLocalProgress(r, { name: 'epoch_end', epoch: 2, batch: null, logs: { 'train/loss': 0.31, 'val/loss': 0.5 }, nan: false });
assert.equal(r.bestValLoss, 0.35);
assert.equal(r.epoch, 3);
// The same epoch reported twice replaces, never duplicates.
r = rowWithLocalProgress(r, { name: 'epoch_end', epoch: 2, batch: null, logs: { 'train/loss': 0.29, 'val/loss': 0.5 }, nan: false });
assert.equal(r.epochSamples.length, 3);
// NaN: Rust sends null + nan: the sample is skipped, the row flagged.
r = rowWithLocalProgress(r, { name: 'batch_end', epoch: 3, batch: 0, logs: { loss: null }, nan: true });
assert.equal(r.lossNaN, true);
assert.equal(r.batchSamples.filter((s) => s.globalBatch === 15).length, 0);
// The batch buffer is capped.
let big = emptyModelProgress('x', 1);
for (let i = 0; i < MAX_BATCH_SAMPLES + 50; i++) big = rowWithLocalProgress(big, { name: 'batch_end', epoch: 0, batch: i, logs: { loss: 1 }, nan: false });
assert.equal(big.batchSamples.length, MAX_BATCH_SAMPLES);
assert.equal(big.batchSamples[0].globalBatch, 50);

console.log('test-training-local-progress: ok');
