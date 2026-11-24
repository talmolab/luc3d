/**
 * pose/training-metrics.js — the Training Monitor's runtime lines: mean time per epoch, ETA of the
 * next 10 epochs, epochs in plateau, last / best validation loss.
 *
 * Port of sleap-app `src/lib/trainingMetrics.ts` (`computeRuntimeMetrics`, `formatRuntimeTitle`,
 * `mmss`) @ c97c6a5, itself parity with SLEAP's PyQt `monitor.py` LossViewer. Same rules, same
 * strings. DOM-free (Node tests: tests/test-training-metrics.mjs).
 *
 * LUCID changes: none in behaviour. For a remote run the times are the app's clock (when this
 * window saw the run start and each epoch end), as in sleap-app's Training panel.
 */

/**
 * Mean epoch time / ETA / plateau (monitor.py:1017-1047): an epoch improves when its validation
 * loss is below the best so far minus `plateauMinDelta`; epochs in plateau count the epochs since.
 * @param {{epoch: number, valLoss: number|null}[]} epochSamples
 * @param {number} startedAtMs
 * @param {number} nowMs
 * @param {number|null} plateauMinDelta
 */
export function computeRuntimeMetrics(epochSamples, startedAtMs, nowMs, plateauMinDelta) {
    const valSamples = (epochSamples || []).filter(function (s) { return s.valLoss != null && Number.isFinite(s.valLoss); });
    let bestVal = Infinity;
    let bestValEpoch = null;
    let epochsInPlateau = 0;
    let inPlateau = false;
    const delta = plateauMinDelta != null ? plateauMinDelta : 0;
    for (const s of valSamples) {
        const v = s.valLoss;
        const isBetter = bestValEpoch === null ? true : v < bestVal - delta;
        if (isBetter) { bestVal = v; bestValEpoch = s.epoch; epochsInPlateau = 0; inPlateau = false; }
        else { epochsInPlateau += 1; inPlateau = true; }
    }
    let meanEpochTimeSec = null;
    let etaNext10Min = null;
    const nCompleted = (epochSamples || []).length;
    if (nCompleted >= 1 && startedAtMs != null) {
        meanEpochTimeSec = ((nowMs - startedAtMs) / 1000) / nCompleted;
        etaNext10Min = Math.floor((meanEpochTimeSec * 10) / 60);
    }
    return { meanEpochTimeSec: meanEpochTimeSec, etaNext10Min: etaNext10Min, epochsInPlateau: epochsInPlateau, inPlateau: inPlateau, bestValEpoch: bestValEpoch };
}

/** `mm:ss`. */
export function mmss(totalSec) {
    const t = Math.max(0, Number(totalSec) || 0);
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/**
 * The monitor's title, one string per line (monitor.py `update_runtime_title`): losses as
 * `toExponential(3)`, times as mm:ss.
 * @param {{epoch: number, maxEpochs: number, totalRuntimeMs: number, epochRuntimeMs: number|null,
 *          metrics: ReturnType<typeof computeRuntimeMetrics>, plateauPatience: number|null,
 *          lastValLoss: number|null, bestValLoss: number|null, bestValEpoch: number|null}} a
 * @returns {string[]}
 */
export function formatRuntimeTitle(a) {
    const lines = [];
    let head = 'Training Epoch ' + (a.epoch + 1) + ' / Total Runtime: ' + mmss(a.totalRuntimeMs / 1000);
    if (a.epochRuntimeMs != null) head += ' / Epoch Runtime: ' + mmss(a.epochRuntimeMs / 1000);
    lines.push(head);
    const m = a.metrics;
    if (a.lastValLoss != null) {
        if (m.meanEpochTimeSec != null && m.etaNext10Min != null) {
            lines.push('Mean Time per Epoch: ' + mmss(m.meanEpochTimeSec) + ' / ETA Next 10 Epochs: ' + m.etaNext10Min + ' min');
            if (m.inPlateau && a.plateauPatience != null) lines.push('Epochs in Plateau: ' + m.epochsInPlateau + ' / ' + a.plateauPatience);
        }
        lines.push('Last Epoch Validation Loss: ' + a.lastValLoss.toExponential(3));
        if (a.bestValLoss != null && a.bestValEpoch != null) {
            lines.push('Best Epoch Validation Loss: ' + a.bestValLoss.toExponential(3) + ' (epoch ' + (a.bestValEpoch + 1) + ')');
        }
    }
    return lines;
}

/**
 * The runtime lines of one progress row (`emptyModelProgress` shape plus `startedAt`,
 * `epochStartedAt`, `endedAt`, `plateauPatience`, `plateauMinDelta`).
 */
export function rowRuntimeLines(row, nowMs) {
    const end = row.endedAt || nowMs;
    const metrics = computeRuntimeMetrics(row.epochSamples, row.startedAt, end, row.plateauMinDelta);
    const last = row.epochSamples.length ? row.epochSamples[row.epochSamples.length - 1] : null;
    return formatRuntimeTitle({
        epoch: Math.max(0, Math.min(row.maxEpochs - 1, row.epoch)),
        maxEpochs: row.maxEpochs,
        totalRuntimeMs: row.startedAt ? end - row.startedAt : 0,
        epochRuntimeMs: row.status === 'running' && row.epochStartedAt ? nowMs - row.epochStartedAt : null,
        metrics: metrics,
        plateauPatience: row.plateauPatience != null ? row.plateauPatience : null,
        lastValLoss: last && last.valLoss != null ? last.valLoss : null,
        bestValLoss: row.bestValLoss,
        bestValEpoch: metrics.bestValEpoch,
    });
}

/** The early-stopping settings of a parsed config: `{patience, minDelta}` (patience null when off). */
export function plateauSettings(doc) {
    const es = doc && doc.trainer_config && doc.trainer_config.early_stopping;
    if (!es || typeof es !== 'object') return { patience: null, minDelta: 1e-8 };
    const on = es.stop_training_on_plateau !== false;
    return {
        patience: on && Number.isFinite(Number(es.patience)) ? Number(es.patience) : null,
        minDelta: Number.isFinite(Number(es.min_delta)) ? Number(es.min_delta) : 1e-8,
    };
}
