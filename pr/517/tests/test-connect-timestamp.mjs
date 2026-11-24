import { describe, it, expect, run } from './bun-test-shim.mjs';
import { formatRunTimestamp, formatDuration, modelRunTimestamp, timeAgo } from '../pose/connect/timestamp.js';

describe("formatRunTimestamp", () => {
  it("matches legacy SLEAP's YYMMDD_HHMMSS format with no trailing punctuation", () => {
    const ts = formatRunTimestamp();
    expect(ts).toMatch(/^\d{6}_\d{6}$/);
  });
});

// sleap-app covers these only indirectly (via WorkerJobs); pinned here directly.
describe("formatDuration", () => {
  it("12s / 3m 4s / 1h 2m", () => {
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(184_000)).toBe("3m 4s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });
});

describe("modelRunTimestamp", () => {
  it("extracts the leading YYMMDD_HHMMSS from a model name, else null", () => {
    expect(modelRunTimestamp("260922_015758.centroid.n=1")).toBe("260922_015758");
    expect(modelRunTimestamp("my_model")).toBeNull();
    expect(modelRunTimestamp(null)).toBeNull();
    expect(modelRunTimestamp(undefined)).toBeNull();
  });
});

describe("timeAgo", () => {
  it("compacts an ISO timestamp", () => {
    const ago = (ms) => timeAgo(new Date(Date.now() - ms).toISOString());
    expect(ago(0)).toBe("just now");
    expect(ago(5 * 60_000)).toBe("5 min ago");
    expect(ago(3 * 3_600_000)).toBe("3 hr ago");
    expect(ago(86_400_000)).toBe("1 day ago");
    expect(ago(3 * 86_400_000)).toBe("3 days ago");
  });
});

await run();
