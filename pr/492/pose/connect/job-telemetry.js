/**
 * Port of sleap-app src/lib/protocolV1/jobTelemetry.ts @ 683a159.
 *
 * Typed parsers for a training job's structured telemetry events
 * (`job.epoch`, `job.curve`, `job.metric`) — the worker → app contract from
 * talmolab/sleap-connect's feat/remote-training-telemetry. Each returns
 * `null` for a payload that doesn't match, so a malformed or future-shaped
 * event is dropped instead of corrupting the training monitor.
 *
 * LUCID changes: none in behavior. Types become JSDoc typedefs; training is
 * out of scope for LUCID's UI, but the parser is kept so the protocol layer
 * stays identical.
 *
 * @typedef {{ kind: "epoch", epoch: number, trainLoss: number | null, valLoss: number | null }} JobEpochTelemetry
 *   One completed epoch — maps 1:1 to local training's ZMQ `epoch_end` (`epoch` is 0-based).
 * @typedef {{ kind: "curve", points: Array<{ x: number, y: number }> }} JobCurveTelemetry
 *   The WHOLE batch-loss curve so far (downsampled) — replaces, never appends.
 * @typedef {{ kind: "metric", epoch: number | null, totalEpochs: number | null,
 *   latestTrainLoss: number | null, latestValLoss: number | null, bestLoss: number | null,
 *   wandbUrl: string | null, etaSeconds: number | null }} JobMetricTelemetry
 *   Throttled summary — header numbers / ETA / W&B link, not for plotting.
 * @typedef {JobEpochTelemetry | JobCurveTelemetry | JobMetricTelemetry} JobTelemetry
 */

/** @param {unknown} v @returns {number | null} */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * @param {{ topic: string, data?: Record<string, any> | null }} event a worker event (`topic` + `data`)
 * @returns {JobTelemetry | null}
 */
export function parseJobTelemetry(event) {
  const d = event.data ?? {};
  switch (event.topic) {
    case "job.epoch": {
      const epoch = num(d.epoch);
      if (epoch === null) return null;
      return { kind: "epoch", epoch, trainLoss: num(d.train_loss), valLoss: num(d.val_loss) };
    }
    case "job.curve": {
      if (!Array.isArray(d.points)) return null;
      const points = [];
      for (const p of d.points) {
        const x = num(p?.x);
        const y = num(p?.y);
        if (x !== null && y !== null) points.push({ x, y });
      }
      return { kind: "curve", points };
    }
    case "job.metric":
      return {
        kind: "metric",
        epoch: num(d.epoch),
        totalEpochs: num(d.total_epochs),
        latestTrainLoss: num(d.latest_train_loss),
        latestValLoss: num(d.latest_val_loss),
        bestLoss: num(d.best_loss),
        wandbUrl: typeof d.wandb_url === "string" && d.wandb_url ? d.wandb_url : null,
        etaSeconds: num(d.eta_seconds),
      };
    default:
      return null;
  }
}
