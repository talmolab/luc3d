import { describe, it, expect, run } from './bun-test-shim.mjs';
import { parseJobTelemetry } from '../pose/connect/job-telemetry.js';

describe("parseJobTelemetry", () => {
  it("parses job.epoch, keeping null losses", () => {
    expect(
      parseJobTelemetry({ topic: "job.epoch", data: { epoch: 3, train_loss: 0.5, val_loss: null } }),
    ).toEqual({ kind: "epoch", epoch: 3, trainLoss: 0.5, valLoss: null });
  });

  it("drops a job.epoch without a numeric epoch", () => {
    expect(parseJobTelemetry({ topic: "job.epoch", data: { epoch: "3" } })).toBeNull();
  });

  it("parses job.curve, skipping non-numeric points", () => {
    expect(
      parseJobTelemetry({
        topic: "job.curve",
        data: { points: [{ x: 0, y: 1 }, { x: 1 }, null, { x: 2, y: Number.NaN }, { x: 3, y: 0.5 }] },
      }),
    ).toEqual({ kind: "curve", points: [{ x: 0, y: 1 }, { x: 3, y: 0.5 }] });
  });

  it("parses job.metric", () => {
    expect(
      parseJobTelemetry({
        topic: "job.metric",
        data: {
          epoch: 2,
          total_epochs: 100,
          latest_train_loss: 0.3,
          latest_val_loss: 0.4,
          best_loss: 0.35,
          wandb_url: "https://wandb.ai/x",
          eta_seconds: 60,
        },
      }),
    ).toEqual({
      kind: "metric",
      epoch: 2,
      totalEpochs: 100,
      latestTrainLoss: 0.3,
      latestValLoss: 0.4,
      bestLoss: 0.35,
      wandbUrl: "https://wandb.ai/x",
      etaSeconds: 60,
    });
  });

  it("ignores non-telemetry topics", () => {
    expect(parseJobTelemetry({ topic: "job.log", data: { line: "x" } })).toBeNull();
  });
});

await run();
