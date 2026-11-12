/**
 * Tests for the shared subprocess-log helpers (training + inference monitors).
 *
 * Covers the bounded-log append (prevents unbounded growth on long runs) and the
 * failure-message builder that lifts the last stderr line into the error banner
 * instead of a bare "exit code N".
 */
import { describe, it, expect, run } from './bun-test-shim.mjs';
import {
  MAX_LOG_LINES,
  appendLogLine,
  lastErrorLine,
  subprocessFailureMessage,
  logLineClassName,
  isErrorLine,
} from '../pose/connect/process-log.js';

describe("appendLogLine", () => {
  it("appends under the cap", () => {
    expect(appendLogLine(["a", "b"], "c", 5)).toEqual(["a", "b", "c"]);
  });

  it("drops the oldest lines when over the cap", () => {
    expect(appendLogLine(["a", "b"], "c", 2)).toEqual(["b", "c"]);
    expect(appendLogLine(["a", "b", "c"], "d", 2)).toEqual(["c", "d"]);
  });

  it("defaults to MAX_LOG_LINES", () => {
    const full = Array.from({ length: MAX_LOG_LINES }, (_, i) => String(i));
    const out = appendLogLine(full, "new");
    expect(out.length).toBe(MAX_LOG_LINES);
    expect(out[out.length - 1]).toBe("new");
    expect(out[0]).toBe("1"); // "0" dropped
  });
});

describe("lastErrorLine", () => {
  it("returns the last non-empty trimmed line", () => {
    expect(lastErrorLine(["a", "b"])).toBe("b");
    expect(lastErrorLine(["a", "", " "])).toBe("a");
  });

  it("returns null for empty / all-blank input", () => {
    expect(lastErrorLine([])).toBeNull();
    expect(lastErrorLine(["", " "])).toBeNull();
  });
});

describe("subprocessFailureMessage", () => {
  it("appends the last stderr line as the likely cause", () => {
    expect(
      subprocessFailureMessage("Inference", 1, ["Traceback (most recent call last):", "ValueError: bad config"]),
    ).toBe("Inference failed (exit code 1): ValueError: bad config");
  });

  it("omits the cause when there is no stderr", () => {
    expect(subprocessFailureMessage("Training", 2, [])).toBe("Training failed (exit code 2)");
  });

  it("handles a null exit code", () => {
    expect(subprocessFailureMessage("Inference", null, [])).toBe("Inference failed (exit code unknown)");
  });
});

describe("logLineClassName", () => {
  it("colors best / error / section lines and leaves plain lines unstyled", () => {
    expect(logLineClassName("*** best *** val_loss=0.1")).toBe("text-green-400");
    expect(logLineClassName("RuntimeError: boom")).toBe("text-destructive");
    expect(logLineClassName("— Starting Centroid...")).toBe("text-yellow-400");
    expect(logLineClassName("Epoch 3: 71% loss=0.1")).toBe("");
  });
});

describe("isErrorLine", () => {
  it("flags error / traceback / exception / failed lines", () => {
    expect(isErrorLine("Traceback (most recent call last):")).toBe(true);
    expect(isErrorLine("ValueError: bad config")).toBe(true);
    expect(isErrorLine("Training failed for centroid")).toBe(true);
    expect(isErrorLine("Epoch 3: 71% loss=0.1")).toBe(false);
  });
});

await run();
