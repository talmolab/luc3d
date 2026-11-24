import { describe, it, expect, run } from './bun-test-shim.mjs';
import { mergeShared, } from '../pose/connect/connect-sync.js';

function worker(nodeId, extra = {}) {
  return { nodeId, label: nodeId, addrs: [], pairedAt: "2026-11-05T00:00:00Z", ...extra };
}

function job(jobId, extra = {}) {
  return {
    workerId: "W1",
    jobId,
    lastSeq: 0,
    kind: "train",
    label: "Train",
    source: "window",
    state: "active",
    seen: false,
    submittedAt: 1,
    ...extra,
  };
}

function shared(extra = {}) {
  return { pairedWorkers: [], trackedJobs: [], deviceName: null, lastSelectedWorkerId: null, ...extra };
}

const ids = (s) => ({
  workers: s.pairedWorkers.map((w) => w.nodeId),
  jobs: s.trackedJobs.map((j) => j.jobId),
});

describe("mergeShared", () => {
  it("keeps another window's new worker when this window only bumped a job (the W1/W2 example)", () => {
    const base = shared({ pairedWorkers: [worker("W1")], trackedJobs: [job("job-1", { lastSeq: 10 })] });
    const mine = shared({ pairedWorkers: [worker("W1")], trackedJobs: [job("job-1", { lastSeq: 12 })] });
    const theirs = shared({ pairedWorkers: [worker("W1"), worker("W2")], trackedJobs: [job("job-1", { lastSeq: 10 })] });

    const merged = mergeShared(base, mine, theirs);

    expect(ids(merged).workers).toEqual(["W1", "W2"]);
    expect(merged.trackedJobs[0].lastSeq).toBe(12);
  });

  it("keeps a worker another window forgot forgotten, even though this window still holds it", () => {
    const base = shared({ pairedWorkers: [worker("W1"), worker("W2")] });
    const mine = shared({ pairedWorkers: [worker("W1"), worker("W2")], trackedJobs: [job("job-1")] });
    const theirs = shared({ pairedWorkers: [worker("W2")] });

    expect(ids(mergeShared(base, mine, theirs))).toEqual({ workers: ["W2"], jobs: ["job-1"] });
  });

  it("applies this window's own delete when the stored copy didn't change that record", () => {
    const base = shared({ pairedWorkers: [worker("W1"), worker("W2")] });
    const mine = shared({ pairedWorkers: [worker("W2")] });
    const theirs = shared({ pairedWorkers: [worker("W1"), worker("W2")] });

    expect(ids(mergeShared(base, mine, theirs)).workers).toEqual(["W2"]);
  });

  it("takes the stored version of a record this window didn't change", () => {
    const base = shared({ pairedWorkers: [worker("W1")] });
    const theirs = shared({ pairedWorkers: [worker("W1", { outputDirs: { p: "/out" } })] });

    expect(mergeShared(base, base, theirs).pairedWorkers[0].outputDirs).toEqual({ p: "/out" });
  });

  it("takes this window's version of a record only it changed", () => {
    const base = shared({ pairedWorkers: [worker("W1")] });
    const mine = shared({ pairedWorkers: [worker("W1", { pathRules: [] })] });

    expect(mergeShared(base, mine, base).pairedWorkers[0].pathRules).toEqual([]);
  });

  it("prefers this window's version when both changed the same worker", () => {
    const base = shared({ pairedWorkers: [worker("W1")] });
    const mine = shared({ pairedWorkers: [worker("W1", { label: "mine" })] });
    const theirs = shared({ pairedWorkers: [worker("W1", { label: "theirs" })] });

    expect(mergeShared(base, mine, theirs).pairedWorkers[0].label).toBe("mine");
  });

  it("lets a delete win over a concurrent edit, either way round", () => {
    const base = shared({ pairedWorkers: [worker("W1")] });
    const edited = shared({ pairedWorkers: [worker("W1", { label: "edited" })] });
    const deleted = shared();

    expect(mergeShared(base, edited, deleted).pairedWorkers).toEqual([]);
    expect(mergeShared(base, deleted, edited).pairedWorkers).toEqual([]);
  });

  it("adds records new on either side, stored order first", () => {
    const base = shared({ trackedJobs: [job("a")] });
    const mine = shared({ trackedJobs: [job("a"), job("mine")] });
    const theirs = shared({ trackedJobs: [job("a"), job("theirs")] });

    expect(ids(mergeShared(base, mine, theirs)).jobs).toEqual(["a", "theirs", "mine"]);
  });

  describe("a job both windows changed", () => {
    const base = shared({ trackedJobs: [job("j", { lastSeq: 5 })] });

    it("never lets lastSeq go backwards", () => {
      const mine = shared({ trackedJobs: [job("j", { lastSeq: 7 })] });
      const theirs = shared({ trackedJobs: [job("j", { lastSeq: 9, seen: true })] });

      const merged = mergeShared(base, mine, theirs).trackedJobs[0];

      expect(merged.lastSeq).toBe(9);
      expect(merged.seen).toBe(true);
    });

    it("keeps a terminal state over active, with its error", () => {
      const mine = shared({ trackedJobs: [job("j", { lastSeq: 7 })] });
      const theirs = shared({ trackedJobs: [job("j", { lastSeq: 6, state: "failed", error: "OOM" })] });

      const merged = mergeShared(base, mine, theirs).trackedJobs[0];

      expect(merged.state).toBe("failed");
      expect(merged.error).toBe("OOM");
      expect(merged.lastSeq).toBe(7);
    });
  });

  it("keeps a job's furthest progress even when only the stored copy changed it (backwards)", () => {
    const base = shared({ trackedJobs: [job("j", { lastSeq: 20, state: "completed" })] });
    const theirs = shared({ trackedJobs: [job("j", { lastSeq: 15 })] });

    const merged = mergeShared(base, base, theirs).trackedJobs[0];

    expect(merged.lastSeq).toBe(20);
    expect(merged.state).toBe("completed");
  });

  it("merges scalars: this window's change, else the stored value", () => {
    const base = shared({ deviceName: "old", lastSelectedWorkerId: "W1" });
    const mine = shared({ deviceName: "old", lastSelectedWorkerId: "W2" });
    const theirs = shared({ deviceName: "new", lastSelectedWorkerId: "W1" });

    expect(mergeShared(base, mine, theirs)).toMatchObject({ deviceName: "new", lastSelectedWorkerId: "W2" });
  });

  it("with no base, unions both sides and deletes nothing", () => {
    const mine = shared({ pairedWorkers: [worker("W1")], trackedJobs: [job("j", { lastSeq: 3 })] });
    const theirs = shared({ pairedWorkers: [worker("W2")], trackedJobs: [job("j", { lastSeq: 4 })] });

    const merged = mergeShared(null, mine, theirs);

    expect(ids(merged).workers).toEqual(["W2", "W1"]);
    expect(merged.trackedJobs[0].lastSeq).toBe(4);
  });

  it("returns the stored copy unchanged when this window changed nothing", () => {
    const base = shared({ pairedWorkers: [worker("W1")] });
    const theirs = shared({ pairedWorkers: [worker("W1"), worker("W2")], deviceName: "x" });

    expect(mergeShared(base, base, theirs)).toEqual(theirs);
  });
});

await run();
