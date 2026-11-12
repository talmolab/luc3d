/**
 * Port of sleap-app src/lib/jobStream.ts and the non-React core of src/hooks/useJobStream.ts
 * @ 683a159.
 *
 * Pure replay/live reducer for one worker job's event stream (the per-job viewer's state) and
 * `createJobStream`, the controller `useJobStream` wraps. Unlike a THIS-WINDOW-submitted job
 * (live, with wall-clock runtime metrics), this reducer only sees whatever the worker replays
 * from its history plus what arrives live afterward, so `ModelProgress`'s `metrics` /
 * `epochStartedAt` stay at their empty defaults. `reduceJobEvents` is a plain fold: no
 * `Date.now()`, no module state; events are applied in order and deduped by `seq`.
 *
 * LUCID changes:
 *  - sleap-app imports `emptyModelProgress` / `mergeLogLines` (+ `normalizeLogLine`'s
 *    progress regex) from `trainingStore`. LUCID has no training store, so `emptyMetrics`,
 *    `emptyModelProgress` and `mergeLogLines` are copied here verbatim (the log bound is
 *    `MAX_LOG_LINES` from `./process-log.js`, the same 1000).
 *  - `createJobStream(client, jobId, opts)` is `useJobStream` minus React: it subscribes
 *    through `client.jobsSubscribe(jobId, sinceSeq, onEvent)`, buffers events, and folds the
 *    buffer into the state on an interval (plus once right after the subscribe resolves, when
 *    the replay backlog has already landed in the buffer). `client` may be a WorkerClient, a
 *    promise of one or a `() => Promise<client>` (the store's `clientFor`); a connect /
 *    subscribe failure lands in `status: "unknown"` with the error as `detail`.
 *    `resume()` re-subscribes from the last applied `seq`, for a reconnect.
 *  - Each buffered batch is folded in seq order (live events can arrive during the replay).
 *  - Race-free resume/stop (review B2): latest wins. A `resume()` or `stop()` while an earlier
 *    subscribe is still awaiting invalidates it; that subscribe unsubscribes what it got and
 *    installs nothing, so no second subscription or interval leaks.
 *
 * @typedef {import("./client.js?v=82449baaa3c2").WorkerEvent} WorkerEvent
 * @typedef {"unknown" | "queued" | "running" | "completed" | "failed" | "canceled"} JobStreamStatus
 * @typedef {{ epoch: number, trainLoss: number | null, valLoss: number | null }} EpochSample
 * @typedef {{ globalBatch: number, loss: number }} BatchSample
 * @typedef {{ meanEpochTimeSec: number | null, etaNext10Min: number | null, epochsInPlateau: number, inPlateau: boolean, bestValEpoch: number | null }} RuntimeMetrics
 * @typedef {object} ModelProgress
 * @property {string} label
 * @property {number} epoch
 * @property {number} maxEpochs
 * @property {number | null} loss
 * @property {number | null} valLoss
 * @property {number | null} bestValLoss
 * @property {"pending" | "running" | "completed" | "failed"} status
 * @property {EpochSample[]} epochSamples
 * @property {BatchSample[]} batchSamples
 * @property {number} epochSize
 * @property {number} lastBatchNumber
 * @property {RuntimeMetrics} metrics
 * @property {number | null} epochStartedAt
 * @property {number | null} plateauPatience
 * @property {number | null} plateauMinDelta
 * @property {string | null} runDir
 * @typedef {object} JobStreamState
 * @property {JobStreamStatus} status
 * @property {string | null} detail The worker's failure/cancel detail, if any; cleared on "completed".
 * @property {string[]} log
 * @property {string | null} progressTail
 * @property {ModelProgress} model
 * @property {Record<string, any> | null} result
 * @property {number} lastSeq Highest event `seq` applied so far.
 */
import { parseJobTelemetry } from "./job-telemetry.js?v=82449baaa3c2";
import { MAX_LOG_LINES } from "./process-log.js?v=82449baaa3c2";

// ── trainingStore.ts pieces (verbatim) ──────────────────────────────

// A tqdm/Lightning progress-bar line contains a "<pct>%|" segment.
const PROGRESS_LINE_RE = /\d+%\|/;

/**
 * Appends raw lines to a log, coalescing in-place progress-bar redraws; bounded to MAX_LOG_LINES.
 * @param {string[]} prev
 * @param {Array<string | { line: string, progress: boolean }>} rawLines
 * @param {string | null} [progressTail]
 * @returns {{ log: string[], progressTail: string | null }}
 */
export function mergeLogLines(prev, rawLines, progressTail = null) {
  const next = prev.slice();
  let tail = progressTail;
  for (const raw of rawLines) {
    const { line, progress } = typeof raw === "string" ? { line: raw, progress: false } : raw;
    const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!clean) continue;
    const isProgress = progress || PROGRESS_LINE_RE.test(clean);
    const last = next[next.length - 1];
    const lastIsProgress =
      last !== undefined && ((tail !== null && last === tail) || PROGRESS_LINE_RE.test(last));
    if (isProgress && lastIsProgress) {
      next[next.length - 1] = clean; // coalesce in place (carriage-return behavior)
    } else {
      next.push(clean);
    }
    tail = progress ? clean : null;
  }
  return {
    log: next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next,
    progressTail: tail,
  };
}

/** @returns {RuntimeMetrics} */
export function emptyMetrics() {
  return { meanEpochTimeSec: null, etaNext10Min: null, epochsInPlateau: 0, inPlateau: false, bestValEpoch: null };
}

/**
 * A freshly-started model's progress state, before any epoch/batch has been recorded.
 * @param {string} label
 * @param {number} [maxEpochs]
 * @returns {ModelProgress}
 */
export function emptyModelProgress(label, maxEpochs = 100) {
  return {
    label,
    epoch: 0,
    maxEpochs,
    loss: null,
    valLoss: null,
    bestValLoss: null,
    status: "pending",
    epochSamples: [],
    batchSamples: [],
    epochSize: 1,
    lastBatchNumber: 0,
    metrics: emptyMetrics(),
    epochStartedAt: null,
    plateauPatience: null,
    plateauMinDelta: null,
    runDir: null,
  };
}

// ── jobStream.ts ────────────────────────────────────────────────────

const KNOWN_STATUSES = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
]);

/** @param {string} label @returns {JobStreamState} */
export function initialJobStream(label) {
  return {
    status: "unknown",
    detail: null,
    log: [],
    progressTail: null,
    model: emptyModelProgress(label),
    result: null,
    lastSeq: 0,
  };
}

/** @returns {JobStreamStatus | null} */
function parseStatus(raw) {
  return typeof raw === "string" && KNOWN_STATUSES.has(/** @type {JobStreamStatus} */ (raw))
    ? /** @type {JobStreamStatus} */ (raw)
    : null;
}

/** @param {ModelProgress} model @param {NonNullable<ReturnType<typeof parseJobTelemetry>>} telemetry @returns {ModelProgress} */
function applyTelemetry(model, telemetry) {
  switch (telemetry.kind) {
    case "epoch": {
      const sample = {
        epoch: telemetry.epoch,
        trainLoss: telemetry.trainLoss,
        valLoss: telemetry.valLoss,
      };
      return {
        ...model,
        epochSamples: [...model.epochSamples, sample],
        epoch: telemetry.epoch + 1,
        loss: telemetry.trainLoss ?? model.loss,
        valLoss: telemetry.valLoss ?? model.valLoss,
        bestValLoss:
          telemetry.valLoss != null &&
          (model.bestValLoss === null || telemetry.valLoss < model.bestValLoss)
            ? telemetry.valLoss
            : model.bestValLoss,
      };
    }
    case "curve": {
      // The whole curve every time, same as trainingStore's applyRemoteTelemetry: replace, never append.
      const batchSamples = telemetry.points.map((p) => ({
        globalBatch: p.x,
        loss: p.y,
      }));
      return { ...model, batchSamples };
    }
    case "metric":
      return {
        ...model,
        maxEpochs:
          telemetry.totalEpochs != null && telemetry.totalEpochs > 0
            ? telemetry.totalEpochs
            : model.maxEpochs,
        loss: telemetry.latestTrainLoss ?? model.loss,
      };
  }
}

/**
 * Batches per epoch, inferred from the curve: `LossPlot` places epoch points
 * at `epoch * epochSize` on the batch axis, and remote telemetry carries no
 * batch index (same inference as `trainingStore.applyRemoteTelemetry`).
 * `exact` (the job finished, so the curve ends at the last epoch's end)
 * replaces the running estimate instead of only ever growing it.
 */
/** @param {ModelProgress} model @param {boolean} [exact] @returns {ModelProgress} */
function withEpochSize(model, exact = false) {
  const lastX = model.batchSamples[model.batchSamples.length - 1]?.globalBatch;
  const lastEpoch = model.epochSamples[model.epochSamples.length - 1]?.epoch;
  if (lastX === undefined || lastEpoch === undefined) return model;
  const estimate = Math.max(1, Math.round((lastX + 1) / (lastEpoch + 1)));
  if (exact) return estimate === model.epochSize ? model : { ...model, epochSize: estimate };
  return estimate > model.epochSize ? { ...model, epochSize: estimate } : model;
}

/** @param {JobStreamState} state @param {WorkerEvent} event @returns {JobStreamState} */
function reduceOne(state, event) {
  if (event.seq <= state.lastSeq) return state; // reconnect backlog overlap / out-of-order
  const lastSeq = event.seq;

  switch (event.topic) {
    case "job.log": {
      const { log, progressTail } = mergeLogLines(
        state.log,
        [{ line: event.data.line ?? "", progress: event.data.progress === true }],
        state.progressTail,
      );
      return { ...state, log, progressTail, lastSeq };
    }
    case "job.status": {
      const status = parseStatus(event.data.state) ?? state.status;
      const detail = event.data.detail ?? null;
      const model = status === "completed" ? withEpochSize(state.model, true) : state.model;
      return { ...state, status, model, detail: status === "completed" ? null : detail, lastSeq };
    }
    case "job.result":
      return { ...state, result: event.data, lastSeq };
    default: {
      const telemetry = parseJobTelemetry(event);
      if (!telemetry) return { ...state, lastSeq };
      const model = applyTelemetry(state.model, telemetry);
      return { ...state, model: telemetry.kind === "epoch" ? withEpochSize(model) : model, lastSeq };
    }
  }
}

/**
 * @param {JobStreamState} state
 * @param {WorkerEvent[]} events
 * @returns {JobStreamState}
 *
 * Folds `events` (in order) into `state` — pure, batch-safe, dedupes by `seq`. */
export function reduceJobEvents(state, events) {
  return events.reduce(reduceOne, state);
}


// ── useJobStream.ts (non-React core) ────────────────────────────────

const DEFAULT_FLUSH_INTERVAL_MS = 250;

/**
 * Subscribes to one worker job's event stream (replay from `sinceSeq`, then live) and folds it
 * through `reduceJobEvents`. Starts at once; call `stop()` to unsubscribe and clear the timer.
 *
 * @param {any} client A WorkerClient, a promise of one, or `() => Promise<WorkerClient>`.
 * @param {string} jobId
 * @param {object} [opts]
 * @param {number} [opts.sinceSeq] Replay everything after this seq (default 0 = the whole history).
 * @param {string} [opts.label] Label of the initial model progress (default "").
 * @param {(state: JobStreamState) => void} [opts.onUpdate] Called after every fold that changed the state, and on a failure.
 * @param {number} [opts.flushIntervalMs] How often buffered events are folded in (default 250).
 * @param {(cb: () => void, ms: number) => unknown} [opts.setIntervalImpl]
 * @param {(handle: unknown) => void} [opts.clearIntervalImpl]
 * @returns {{ getState: () => JobStreamState, ready: Promise<void>, resume: () => Promise<void>, stop: () => void }}
 */
export function createJobStream(client, jobId, opts = {}) {
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const setIntervalImpl = opts.setIntervalImpl ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalImpl = opts.clearIntervalImpl ?? ((h) => clearInterval(/** @type {any} */ (h)));
  const onUpdate = opts.onUpdate ?? (() => {});

  let state = initialJobStream(opts.label ?? "");
  state = { ...state, lastSeq: opts.sinceSeq ?? 0 };
  let stopped = false;
  /** @type {WorkerEvent[]} */
  let buffer = [];
  /** @type {null | (() => void)} */
  let unsubscribe = null;
  /** @type {unknown} */
  let intervalHandle = null;

  const flush = () => {
    if (buffer.length === 0) return;
    // Sorted by seq: the worker starts live delivery BEFORE it replays the backlog, so a live
    // event can land mid-replay; folded in arrival order its seq would drop the rest of the
    // backlog (`seq <= lastSeq`), losing the job's status and epochs.
    const events = buffer.slice().sort((x, y) => x.seq - y.seq);
    buffer = [];
    state = reduceJobEvents(state, events);
    onUpdate(state);
  };

  const teardownSubscription = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (intervalHandle !== null) clearIntervalImpl(intervalHandle);
    intervalHandle = null;
  };

  // Latest wins: every subscribe takes a generation; a stale one (superseded by resume() or
  // stop() while it was awaiting) drops its own subscription instead of installing it.
  let generation = 0;

  const subscribe = async () => {
    const mine = ++generation;
    try {
      const resolved = typeof client === "function" ? await client() : await client;
      if (stopped || mine !== generation) return;
      const unsub = await resolved.jobsSubscribe(jobId, state.lastSeq, (/** @type {WorkerEvent} */ event) => {
        if (mine === generation) buffer.push(event);
      });
      if (stopped || mine !== generation) {
        unsub();
        return;
      }
      unsubscribe = unsub;
      flush(); // the initial backlog is already in the buffer by now
      intervalHandle = setIntervalImpl(flush, flushIntervalMs);
    } catch (err) {
      if (stopped || mine !== generation) return;
      const message = err instanceof Error ? err.message : String(err);
      state = { ...state, status: "unknown", detail: message };
      onUpdate(state);
    }
  };

  const ready = subscribe();

  return {
    getState: () => state,
    ready,
    /** Re-subscribe from the last applied seq (after a reconnect); buffered events are folded first. */
    async resume() {
      if (stopped) return;
      generation++; // invalidate any subscribe still in flight
      teardownSubscription();
      flush();
      await subscribe();
    },
    stop() {
      stopped = true;
      generation++;
      teardownSubscription();
    },
  };
}
