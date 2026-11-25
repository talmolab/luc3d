/**
 * pose/training-local-progress.js — fold a LOCAL training run's progress messages (sleap-nn's
 * ZMQ events, cleaned by Rust: `src-tauri/src/training.rs` `TrainEvent::Progress`) into a
 * progress row (`emptyModelProgress` shape, as the remote rows and the Training Monitor use).
 *
 * Port of sleap-app `src/stores/trainingStore.ts` (the ZMQ handler at :2655-2700, `recordEpoch`,
 * `recordBatches`, `markEpochBegin`) @ c97c6a5:
 *   - `epoch_begin` → the epoch's start time;
 *   - `epoch_end` → an epoch sample `{epoch, trainLoss: logs["train/loss"] ?? logs.loss,
 *     valLoss: logs["val/loss"]}`, the best validation loss, `epoch` = epochs done;
 *   - `batch_end` → a batch sample at `epoch * epochSize + batch` (`epochSize` = the largest
 *     batch index seen + 1), the newest `MAX_BATCH_SAMPLES` kept;
 *   - a non-finite loss (Rust sends null and `nan: true`) is skipped and flagged `lossNaN`.
 *
 * DOM-free (Node tests: tests/test-training-local-progress.mjs).
 */

export const MAX_BATCH_SAMPLES = 20000;

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

/**
 * @param {Object} row - a progress row (mutated copy returned)
 * @param {{name: string, epoch: number|null, batch: number|null, logs: Object, nan: boolean}} msg
 * @param {number} [now] - ms clock (tests)
 */
export function rowWithLocalProgress(row, msg, now) {
    const t = now != null ? now : Date.now();
    const r = Object.assign({}, row);
    const logs = msg.logs || {};
    if (msg.nan) r.lossNaN = true;
    switch (msg.name) {
        case 'epoch_begin':
            r.epochStartedAt = t;
            break;
        case 'epoch_end': {
            const epoch = msg.epoch != null ? msg.epoch : r.epochSamples.length;
            const trainLoss = num(logs['train/loss']) != null ? num(logs['train/loss']) : num(logs.loss);
            const valLoss = num(logs['val/loss']);
            r.epochSamples = r.epochSamples.filter(function (s) { return s.epoch !== epoch; }).concat([{ epoch: epoch, trainLoss: trainLoss, valLoss: valLoss }]);
            r.epoch = epoch + 1;
            if (trainLoss != null) r.loss = trainLoss;
            if (valLoss != null) {
                r.valLoss = valLoss;
                if (r.bestValLoss == null || valLoss < r.bestValLoss) r.bestValLoss = valLoss;
            }
            r.epochStartedAt = t;
            break;
        }
        case 'batch_end': {
            const loss = num(logs.loss) != null ? num(logs.loss) : num(logs['train/loss']) != null ? num(logs['train/loss']) : num(logs.train_loss);
            if (msg.batch != null && msg.batch + 1 > (r.epochSize || 1)) r.epochSize = msg.batch + 1;
            if (msg.batch != null) r.lastBatchNumber = msg.batch;
            if (loss == null || msg.batch == null) break;
            const g = (msg.epoch || 0) * (r.epochSize || 1) + msg.batch;
            const bs = r.batchSamples.concat([{ globalBatch: g, loss: loss }]);
            r.batchSamples = bs.length > MAX_BATCH_SAMPLES ? bs.slice(bs.length - MAX_BATCH_SAMPLES) : bs;
            if (r.loss == null) r.loss = loss;
            break;
        }
        default:
            break;
    }
    return r;
}
