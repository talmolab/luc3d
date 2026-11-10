/**
 * Port of sleap-app tests/unit/jobStream.test.ts and tests/unit/useJobStream.test.ts @ 683a159.
 *
 * The reducer tests are verbatim (types stripped). The useJobStream tests drove a React hook; here
 * the same behaviors run against `createJobStream` (the hook's non-React core): replay backlog
 * flushed once jobsSubscribe resolves, buffering until the injected interval tick, unsubscribe +
 * clearInterval on stop, a failed connect/subscribe landing in status "unknown" with the error as
 * detail. "Resubscribes when jobId changes" is the hook's effect lifecycle (stop() + a new
 * controller); added: resume from the last applied seq, `sinceSeq`, and a client given as a
 * promise / async getter.
 */
import { describe, it, expect, run } from './bun-test-shim.mjs';
import { initialJobStream, reduceJobEvents, createJobStream, mergeLogLines } from '../pose/connect/job-stream.js';

function ev(seq, topic, data) {
  return { topic, seq, jobId: "job_1", data };
}

describe("jobStream", () => {
  describe("initialJobStream", () => {
    it("starts unknown, empty, with a pending model labeled as given", () => {
      const state = initialJobStream("Train centroid");
      expect(state.status).toBe("unknown");
      expect(state.detail).toBeNull();
      expect(state.log).toEqual([]);
      expect(state.result).toBeNull();
      expect(state.lastSeq).toBe(0);
      expect(state.model.label).toBe("Train centroid");
      expect(state.model.status).toBe("pending");
      expect(state.model.epoch).toBe(0);
    });
  });

  describe("reduceJobEvents", () => {
    it("infers batches-per-epoch from the curve so epoch points line up with batches", () => {
      const curveTo = (last) =>
        Array.from({ length: last + 1 }, (_, x) => ({ x, y: 1 / (x + 1) }));
      const events = [];
      let seq = 0;
      // 5 epochs of 100 batches; the curve is sampled a bit before each epoch ends.
      for (let epoch = 0; epoch < 5; epoch++) {
        events.push(ev(++seq, "job.curve", { points: curveTo(epoch * 100 + 95) }));
        events.push(ev(++seq, "job.epoch", { epoch, train_loss: 0.1, val_loss: 0.1 }));
      }
      const mid = reduceJobEvents(initialJobStream("Train"), events);
      expect(mid.model.epochSize).toBeGreaterThan(90); // live estimate, not the default 1

      const done = reduceJobEvents(mid, [
        ev(++seq, "job.curve", { points: curveTo(499) }),
        ev(++seq, "job.status", { state: "completed" }),
      ]);
      expect(done.model.epochSize).toBe(100); // exact once the curve is complete
    });

    it("replays a full recorded sequence into the expected final state", () => {
      const events = [
        ev(1, "job.status", { state: "queued" }),
        ev(2, "job.status", { state: "running" }),
        ev(3, "job.log", { line: "Epoch 0:  40%|####", progress: true }),
        ev(4, "job.log", { line: "Epoch 0: 100%|####", progress: true }),
        ev(5, "job.epoch", { epoch: 0, train_loss: 0.5, val_loss: 0.4 }),
        ev(6, "job.curve", { points: [{ x: 0, y: 1 }, { x: 1, y: 0.8 }] }),
        ev(7, "job.metric", { epoch: 1, total_epochs: 50, latest_train_loss: 0.45 }),
        ev(8, "job.curve", { points: [{ x: 0, y: 1 }, { x: 1, y: 0.8 }, { x: 2, y: 0.6 }] }),
        ev(9, "job.result", { blobs: { predictions: { sha256: "abc", size: 1 } }, model_dir: "/m" }),
        ev(10, "job.status", { state: "completed" }),
      ];

      const state = reduceJobEvents(initialJobStream("Train centroid"), events);

      expect(state.status).toBe("completed");
      expect(state.detail).toBeNull();
      expect(state.lastSeq).toBe(10);
      // Both job.log lines are in-place progress-bar redraws — one line, not two.
      expect(state.log).toEqual(["Epoch 0: 100%|####"]);
      expect(state.model.epoch).toBe(1);
      expect(state.model.epochSamples).toEqual([{ epoch: 0, trainLoss: 0.5, valLoss: 0.4 }]);
      // job.metric's latest_train_loss (0.45) is the last word on `loss`.
      expect(state.model.loss).toBe(0.45);
      expect(state.model.valLoss).toBe(0.4);
      expect(state.model.bestValLoss).toBe(0.4);
      expect(state.model.maxEpochs).toBe(50);
      // The whole curve replaces each time — only the LAST job.curve's points remain.
      expect(state.model.batchSamples).toEqual([
        { globalBatch: 0, loss: 1 },
        { globalBatch: 1, loss: 0.8 },
        { globalBatch: 2, loss: 0.6 },
      ]);
      expect(state.result).toEqual({
        blobs: { predictions: { sha256: "abc", size: 1 } },
        model_dir: "/m",
      });
    });

    it("dedupes a reconnect backlog overlap by seq", () => {
      const first = reduceJobEvents(initialJobStream("Inference"), [
        ev(1, "job.epoch", { epoch: 0, train_loss: 0.5, val_loss: null }),
      ]);
      // A reconnect replays everything since lastSeq (exclusive) — a backlog
      // that repeats an already-applied seq (or an older one) must be a no-op.
      const replayed = reduceJobEvents(first, [
        ev(1, "job.epoch", { epoch: 0, train_loss: 0.5, val_loss: null }),
        ev(0, "job.status", { state: "running" }),
      ]);
      expect(replayed).toEqual(first);
      expect(replayed.model.epochSamples).toHaveLength(1);
    });

    it("ignores unparseable telemetry but still advances lastSeq", () => {
      const state = reduceJobEvents(initialJobStream("Inference"), [
        ev(1, "job.epoch", { train_loss: 1 }), // no epoch: parseJobTelemetry drops it
      ]);
      expect(state.lastSeq).toBe(1);
      expect(state.model.epochSamples).toEqual([]);
    });

    it("clears detail once the job reaches completed, keeps it for failed/canceled", () => {
      const failed = reduceJobEvents(initialJobStream("Inference"), [
        ev(1, "job.status", { state: "failed", detail: "exit code 1" }),
      ]);
      expect(failed.status).toBe("failed");
      expect(failed.detail).toBe("exit code 1");

      const completed = reduceJobEvents(failed, [
        ev(2, "job.status", { state: "completed", detail: "stale" }),
      ]);
      expect(completed.status).toBe("completed");
      expect(completed.detail).toBeNull();
    });

    it("forwards job.log's progress flag through mergeLogLines (plain lines append, don't collapse)", () => {
      const state = reduceJobEvents(initialJobStream("Inference"), [
        ev(1, "job.log", { line: "starting" }),
        ev(2, "job.log", { line: "still going" }),
      ]);
      expect(state.log).toEqual(["starting", "still going"]);
    });

    it("an event batch applied incrementally (as useJobStream would) matches one applied all at once", () => {
      const events = [
        ev(1, "job.status", { state: "running" }),
        ev(2, "job.epoch", { epoch: 0, train_loss: 0.9, val_loss: null }),
        ev(3, "job.epoch", { epoch: 1, train_loss: 0.7, val_loss: 0.6 }),
      ];
      const allAtOnce = reduceJobEvents(initialJobStream("Inference"), events);
      let incremental = initialJobStream("Inference");
      for (const event of events) {
        incremental = reduceJobEvents(incremental, [event]);
      }
      expect(incremental).toEqual(allAtOnce);
    });
  });
});

// ── useJobStream.test.ts, against createJobStream ───────────────────

class FakeJobClient {
  constructor() {
    this.jobsSubscribeCalls = [];
    this.unsubscribeCalls = 0;
    /** Delivered synchronously inside jobsSubscribe, before it resolves (the real replay-then-respond order). */
    this.backlog = [];
    this.handler = null;
  }
  async jobsSubscribe(jobId, sinceSeq, onEvent) {
    this.jobsSubscribeCalls.push([jobId, sinceSeq]);
    this.handler = onEvent;
    for (const event of this.backlog) onEvent(event);
    return () => {
      this.unsubscribeCalls++;
      this.handler = null;
    };
  }
  emit(event) {
    this.handler?.(event);
  }
}

describe("createJobStream (useJobStream's core)", () => {
  it("flushes the replay backlog once jobsSubscribe resolves, without waiting for an interval tick", async () => {
    const client = new FakeJobClient();
    client.backlog = [
      ev(1, "job.status", { state: "running" }),
      ev(2, "job.epoch", { epoch: 0, train_loss: 0.5, val_loss: null }),
    ];
    const updates = [];
    const stream = createJobStream(async () => client, "job_1", {
      label: "Train centroid",
      setIntervalImpl: () => "h",
      clearIntervalImpl: () => {},
      onUpdate: (s) => updates.push(s),
    });
    await stream.ready;
    expect(client.jobsSubscribeCalls).toEqual([["job_1", 0]]);
    expect(stream.getState().status).toBe("running");
    expect(stream.getState().model.label).toBe("Train centroid");
    expect(stream.getState().model.epochSamples).toEqual([{ epoch: 0, trainLoss: 0.5, valLoss: null }]);
    expect(updates).toHaveLength(1);
  });

  it("buffers live events and only applies them on the injected interval tick", async () => {
    const client = new FakeJobClient();
    let flushTick = null;
    const stream = createJobStream(client, "job_1", {
      label: "Inference",
      setIntervalImpl: (cb) => {
        flushTick = cb;
        return "handle";
      },
      clearIntervalImpl: () => {},
    });
    await stream.ready;
    expect(flushTick).not.toBeNull();
    client.emit(ev(1, "job.status", { state: "running" }));
    expect(stream.getState().status).toBe("unknown");
    flushTick();
    expect(stream.getState().status).toBe("running");
  });

  it("unsubscribes and clears the interval on stop", async () => {
    const client = new FakeJobClient();
    const cleared = [];
    const stream = createJobStream(client, "job_1", {
      setIntervalImpl: () => "the-handle",
      clearIntervalImpl: (h) => cleared.push(h),
    });
    await stream.ready;
    expect(client.jobsSubscribeCalls).toHaveLength(1);
    stream.stop();
    expect(client.unsubscribeCalls).toBe(1);
    expect(cleared).toEqual(["the-handle"]);
  });

  it("a stop before the client resolves never subscribes (the hook's `cancelled` check)", async () => {
    const client = new FakeJobClient();
    const stream = createJobStream(client, "job_1", { setIntervalImpl: () => "h", clearIntervalImpl: () => {} });
    stream.stop();
    await stream.ready;
    expect(client.jobsSubscribeCalls).toEqual([]);
  });

  it("a stop while jobsSubscribe is pending unsubscribes as soon as it resolves", async () => {
    let release;
    const client = new FakeJobClient();
    const slow = { jobsSubscribe: async (...a) => (await new Promise((r) => (release = r)), client.jobsSubscribe(...a)) };
    const stream = createJobStream(slow, "job_1", { setIntervalImpl: () => "h", clearIntervalImpl: () => {} });
    await new Promise((r) => setTimeout(r, 0));
    stream.stop();
    release();
    await stream.ready;
    expect(client.unsubscribeCalls).toBe(1);
  });

  it("a controller per job: stopping the old one unsubscribes it before the new job subscribes", async () => {
    const clientA = new FakeJobClient();
    const clientB = new FakeJobClient();
    const opts = { setIntervalImpl: () => "h", clearIntervalImpl: () => {} };
    const a = createJobStream(clientA, "job_1", opts);
    await a.ready;
    a.stop();
    const b = createJobStream(clientB, "job_2", opts);
    await b.ready;
    expect(clientA.unsubscribeCalls).toBe(1);
    expect(clientB.jobsSubscribeCalls).toEqual([["job_2", 0]]);
  });

  it("a failed connect/subscribe lands in status unknown with the error as detail", async () => {
    const updates = [];
    const stream = createJobStream(async () => {
      throw new Error("worker unreachable");
    }, "job_1", { onUpdate: (s) => updates.push(s) });
    await stream.ready;
    expect(stream.getState().detail).toBe("worker unreachable");
    expect(stream.getState().status).toBe("unknown");
    expect(updates).toHaveLength(1);
  });

  it("starts after sinceSeq, ignoring replayed events at or below it", async () => {
    const client = new FakeJobClient();
    client.backlog = [ev(3, "job.status", { state: "running" }), ev(5, "job.status", { state: "completed" })];
    const stream = createJobStream(Promise.resolve(client), "job_1", {
      sinceSeq: 4,
      setIntervalImpl: () => "h",
      clearIntervalImpl: () => {},
    });
    await stream.ready;
    expect(client.jobsSubscribeCalls).toEqual([["job_1", 4]]);
    expect(stream.getState().status).toBe("completed");
    expect(stream.getState().lastSeq).toBe(5);
  });

  it("resume() re-subscribes from the last applied seq and drops the old subscription", async () => {
    const client = new FakeJobClient();
    client.backlog = [ev(1, "job.status", { state: "running" }), ev(2, "job.log", { line: "hello" })];
    let tick = null;
    const stream = createJobStream(client, "job_1", {
      setIntervalImpl: (cb) => ((tick = cb), "h"),
      clearIntervalImpl: () => {},
    });
    await stream.ready;
    client.emit(ev(3, "job.log", { line: "buffered" })); // still buffered: folded by resume()
    client.backlog = [ev(3, "job.log", { line: "buffered" }), ev(4, "job.log", { line: "after" })];
    await stream.resume();
    expect(client.unsubscribeCalls).toBe(1);
    expect(client.jobsSubscribeCalls).toEqual([["job_1", 0], ["job_1", 3]]);
    expect(stream.getState().log).toEqual(["hello", "buffered", "after"]);
    expect(stream.getState().lastSeq).toBe(4);
    expect(tick).not.toBeNull();
  });
});

describe("mergeLogLines (trainingStore, verbatim)", () => {
  it("coalesces progress redraws, strips ANSI, skips blanks, and bounds the log", () => {
    const a = mergeLogLines([], [{ line: "\u001b[32mEpoch 0:  10%|#\u001b[0m", progress: true }, "  ", { line: "Epoch 0:  20%|##", progress: true }]);
    expect(a.log).toEqual(["Epoch 0:  20%|##"]);
    expect(a.progressTail).toBe("Epoch 0:  20%|##");
    const big = mergeLogLines(Array.from({ length: 1000 }, (_, i) => `l${i}`), ["new"]);
    expect(big.log).toHaveLength(1000);
    expect(big.log[999]).toBe("new");
  });
});

await run();
