/**
 * Port of the pure-function tests of sleap-app tests/unit/connectStore.test.ts @ 683a159
 * (trackedJobs migration v1->v2, capTrackedJobs, selection migration v2->v3) against
 * pose/connect/store-helpers.js.
 *
 * Skipped (they drive the live zustand store, a fake WorkerClient and storage events, so they
 * belong with the store port, now `tests/test-connect-store.mjs`): everything in `describe("connectStore")`
 * and "Connect state shared across windows (#453)". sleap-app has no direct unit tests for the rest of this file's
 * exports (`runJobsToEnd`, `withYamlRunName`, `toShared` ... are exercised only through the
 * store), so those are covered here with new tests — the `withYamlRunName` ones mirror
 * connectStore.test.ts's "sends each split job's YAML run name as a Hydra-quoted run_name" and
 * "leaves run_name unset ..." cases, with a stub YAML parser.
 */
import { describe, it, expect, run } from './bun-test-shim.mjs';
import {
  UNPAIRED_MESSAGE,
  MAX_TRACKED_JOBS,
  CONNECT_PERSIST_VERSION,
  capTrackedJobs,
  capShared,
  migrateConnectPersisted,
  runJobsToEnd,
  withYamlRunName,
  isMultiModelTrainSpec,
  trackedJobLabel,
  upsertWorker,
  activeJobsFor,
  latestActiveJobFor,
  mapLinkStatus,
  rememberedTransport,
  fetchAllRemoteEntries,
  withTimeout,
  sharedSlice,
  toShared,
  readStoredShared,
} from '../pose/connect/store-helpers.js';

const PAIRED_WORKER = { nodeId: "worker-node-id", label: "W", addrs: ["ws://w"], pairedAt: "2026-11-05T00:00:00Z" };

function makeTracked(overrides = {}) {
  return {
    workerId: PAIRED_WORKER.nodeId,
    jobId: "job_1",
    lastSeq: 0,
    kind: "track",
    label: "Inference",
    source: "window",
    state: "active",
    seen: false,
    submittedAt: Date.now(),
    ...overrides,
  };
}

describe("trackedJobs persisted migration (v1 -> v2)", () => {
  it("migrates an existing currentJob into a single active TrackedJob", () => {
    const migrated = migrateConnectPersisted(
      {
        pairedWorkers: [],
        selectedWorkerId: "worker-node-id",
        currentJob: { workerId: "worker-node-id", jobId: "job_1" },
      },
      1,
    );

    expect(migrated.currentJob).toBeUndefined();
    expect(migrated.trackedJobs).toEqual([
      expect.objectContaining({
        workerId: "worker-node-id",
        jobId: "job_1",
        lastSeq: 0,
        state: "active",
        seen: false,
        source: "window",
      }),
    ]);
  });

  it("migrates a null currentJob into an empty trackedJobs list", () => {
    const migrated = migrateConnectPersisted({ pairedWorkers: [], selectedWorkerId: null, currentJob: null }, 1);

    expect(migrated.trackedJobs).toEqual([]);
  });

  it("leaves already-v2 persisted state untouched", () => {
    // One job, not two makeTracked() calls: each stamps Date.now(), and two
    // calls a millisecond apart made this flaky.
    const job = makeTracked();
    const existing = { pairedWorkers: [], selectedWorkerId: null, trackedJobs: [job] };
    const migrated = migrateConnectPersisted(existing, 2);
    expect(migrated.trackedJobs).toEqual([job]);
  });
});

describe("capTrackedJobs", () => {
  it("keeps active jobs and drops the oldest non-active ones beyond the cap", () => {
    const active = Array.from({ length: 5 }, (_, i) => makeTracked({ jobId: `active_${i}`, submittedAt: i }));
    const nonActive = Array.from({ length: 50 }, (_, i) =>
      makeTracked({ jobId: `done_${i}`, state: "completed", submittedAt: 1000 + i }),
    );

    const capped = capTrackedJobs([...nonActive, ...active]);

    expect(capped).toHaveLength(50);
    expect(capped.filter((j) => j.state === "active")).toHaveLength(5);
    // The 5 oldest non-active jobs (done_0..done_4) were dropped first.
    expect(capped.some((j) => j.jobId === "done_0")).toBe(false);
    expect(capped.some((j) => j.jobId === "done_49")).toBe(true);
  });

  it("never evicts an active job even if active jobs alone exceed the cap", () => {
    const active = Array.from({ length: 51 }, (_, i) => makeTracked({ jobId: `active_${i}`, submittedAt: i }));

    expect(capTrackedJobs(active)).toHaveLength(51);
  });

  it("returns the same list when under the cap", () => {
    const jobs = [makeTracked()];
    expect(capTrackedJobs(jobs)).toBe(jobs);
    expect(MAX_TRACKED_JOBS).toBe(50);
  });
});

describe("selection persisted migration (v2 -> v3)", () => {
  it("moves the shared selectedWorkerId to lastSelectedWorkerId", () => {
    const migrated = migrateConnectPersisted({ pairedWorkers: [], selectedWorkerId: "w-1", trackedJobs: [] }, 2);

    expect(migrated.lastSelectedWorkerId).toBe("w-1");
    expect("selectedWorkerId" in migrated).toBe(false);
  });

  it("v1 state goes through both steps", () => {
    const migrated = migrateConnectPersisted({ selectedWorkerId: "w-2", currentJob: null }, 1);
    expect(migrated.lastSelectedWorkerId).toBe("w-2");
    expect(migrated.trackedJobs).toEqual([]);
  });
});

describe("UNPAIRED_MESSAGE", () => {
  it("is sleap-app's exact string", () => {
    expect(UNPAIRED_MESSAGE).toBe(
      "This device was unpaired by the worker. Pair again with a new code from 'sleap-connect pair'.",
    );
  });
});

describe("runJobsToEnd", () => {
  const tracked = (jobId) => makeTracked({ jobId });
  const summary = (jobId, state, run) => ({ jobId, state, run });

  it("falls back to the latest job alone with no job list", () => {
    const latest = tracked("b");
    expect(runJobsToEnd(latest, [tracked("a"), latest], [])).toEqual({ all: ["b"], current: "b" });
  });

  it("a split run: all = every unfinished sibling in run.index order, current = the running one", () => {
    const a = tracked("a");
    const b = tracked("b");
    const summaries = [
      summary("a", "running", { id: "R", index: 0 }),
      summary("b", "queued", { id: "R", index: 1 }),
      summary("c", "running", { id: "OTHER", index: 0 }),
    ];
    expect(runJobsToEnd(b, [b, a], summaries)).toEqual({ all: ["a", "b"], current: "a" });
  });

  it("current is the first sibling when none is running yet", () => {
    const a = tracked("a");
    const b = tracked("b");
    const summaries = [summary("b", "queued", { id: "R", index: 1 }), summary("a", "queued", { id: "R", index: 0 })];
    expect(runJobsToEnd(b, [a, b], summaries)).toEqual({ all: ["a", "b"], current: "a" });
  });

  it("an explicit run id wins over the latest job's own run, and finished siblings are left out", () => {
    const a = tracked("a");
    const b = tracked("b");
    const summaries = [
      summary("a", "completed", { id: "R", index: 0 }),
      summary("b", "running", { id: "S", index: 0 }),
    ];
    // R has no unfinished member among the active ones -> latest alone.
    expect(runJobsToEnd(b, [a, b], summaries, "R")).toEqual({ all: ["b"], current: "b" });
    expect(runJobsToEnd(b, [a, b], summaries, "S")).toEqual({ all: ["b"], current: "b" });
  });
});

describe("withYamlRunName (YAML parser injected)", () => {
  // Stand-in for js-yaml: understands only `trainer_config:\n  run_name: X` lines.
  const yamlLoad = (text) => {
    const m = /run_name: (.+)/.exec(text);
    return m ? { trainer_config: { run_name: m[1] } } : { trainer_config: {} };
  };

  it("copies a single-config YAML run name onto the spec, Hydra-quoted (the '=' in n=12)", () => {
    const spec = { type: "train", config_contents: ["trainer_config:\n  run_name: 261020_120000.centroid.n=12\n"] };
    expect(withYamlRunName(spec, yamlLoad).run_name).toBe("'261020_120000.centroid.n=12'");
    expect("run_name" in spec).toBe(false); // input not mutated
  });

  it("leaves run_name unset when the YAML has none, and never overrides an explicit one", () => {
    const noName = withYamlRunName({ type: "train", config_contents: ["trainer_config: {}\n"] }, yamlLoad);
    expect("run_name" in noName).toBe(false);
    const explicit = withYamlRunName(
      { type: "train", config_contents: ["trainer_config:\n  run_name: from_yaml\n"], run_name: "explicit" },
      yamlLoad,
    );
    expect(explicit.run_name).toBe("explicit");
  });

  it("only applies to single-config train specs", () => {
    const track = { type: "track" };
    expect(withYamlRunName(track, yamlLoad)).toBe(track);
    const multi = { type: "train", config_contents: ["a", "b"] };
    expect(withYamlRunName(multi, yamlLoad)).toBe(multi);
  });

  it("a throwing parser leaves the spec unchanged", () => {
    const spec = { type: "train", config_contents: ["x"] };
    expect(
      withYamlRunName(spec, () => {
        throw new Error("bad yaml");
      }),
    ).toBe(spec);
  });
});

describe("small pure helpers", () => {
  it("isMultiModelTrainSpec / trackedJobLabel", () => {
    expect(isMultiModelTrainSpec({ type: "train", config_contents: ["a", "b"] })).toBe(true);
    expect(isMultiModelTrainSpec({ type: "train", config_contents: ["a"] })).toBe(false);
    expect(isMultiModelTrainSpec({ type: "track" })).toBe(false);
    expect(trackedJobLabel({ type: "track" })).toBe("Inference");
    expect(trackedJobLabel({ type: "train", model_types: ["centroid"] })).toBe("Train centroid");
    expect(trackedJobLabel({ type: "train" })).toBe("Train model");
  });

  it("upsertWorker keeps a re-paired worker's name and path rules, and replaces it in place of a duplicate", () => {
    const old = { ...PAIRED_WORKER, label: "My rig", pathRules: [{ local: "/a", worker: "/b" }], unpairedAt: "x" };
    const next = { ...PAIRED_WORKER, label: "fresh", addrs: ["ws://new"] };
    const out = upsertWorker([old, { ...PAIRED_WORKER, nodeId: "other" }], next);
    expect(out.map((w) => w.nodeId)).toEqual(["other", PAIRED_WORKER.nodeId]);
    const merged = out[1];
    expect(merged.label).toBe("My rig");
    expect(merged.pathRules).toEqual([{ local: "/a", worker: "/b" }]);
    expect(merged.addrs).toEqual(["ws://new"]);
    expect(merged.unpairedAt).toBeUndefined();
  });

  it("activeJobsFor / latestActiveJobFor", () => {
    const jobs = [
      makeTracked({ jobId: "a" }),
      makeTracked({ jobId: "b", state: "completed" }),
      makeTracked({ jobId: "c", workerId: "other" }),
      makeTracked({ jobId: "d" }),
    ];
    expect(activeJobsFor(PAIRED_WORKER.nodeId, jobs).map((j) => j.jobId)).toEqual(["a", "d"]);
    expect(latestActiveJobFor(PAIRED_WORKER.nodeId, jobs).jobId).toBe("d");
    expect(latestActiveJobFor("nobody", jobs)).toBeNull();
  });

  it("mapLinkStatus / rememberedTransport", () => {
    expect(["connected", "reconnecting", "offline", "connecting", "stopped", "unpaired"].map(mapLinkStatus)).toEqual([
      "connected",
      "reconnecting",
      "reconnecting",
      "connecting",
      "disconnected",
      "error",
    ]);
    expect(rememberedTransport("iroh")).toBe("iroh");
    expect(rememberedTransport("ws")).toBeUndefined();
  });

  it("withTimeout resolves, rejects and times out", async () => {
    expect(await withTimeout(Promise.resolve(1), 50)).toBe(1);
    let err;
    await withTimeout(Promise.reject(new Error("boom")), 50).catch((e) => (err = e));
    expect(err.message).toBe("boom");
    err = null;
    await withTimeout(new Promise(() => {}), 5).catch((e) => (err = e));
    expect(err.message).toBe("timed out after 5 ms");
  });

  it("fetchAllRemoteEntries walks pages until hasMore is false, mapping entries", async () => {
    const pages = [
      { entries: [{ name: "a", type: "directory" }, { name: "b", type: "file", size: 3 }], hasMore: true },
      { entries: [{ name: "c", type: "file" }], hasMore: false },
    ];
    const offsets = [];
    const out = await fetchAllRemoteEntries(async (offset) => {
      offsets.push(offset);
      return pages[offsets.length - 1];
    });
    expect(offsets).toEqual([0, 2]);
    expect(out.map((e) => [e.name, e.isDir])).toEqual([["a", true], ["b", false], ["c", false]]);
  });

  it("fetchAllRemoteEntries stops at the limit and on an empty page", async () => {
    let calls = 0;
    const out = await fetchAllRemoteEntries(async () => {
      calls++;
      return { entries: [{ name: `n${calls}`, type: "file" }], hasMore: true };
    }, 0, 3);
    expect(out).toHaveLength(3);
    const empty = await fetchAllRemoteEntries(async () => ({ entries: [], hasMore: true }));
    expect(empty).toEqual([]);
  });
});

describe("shared slice readers", () => {
  const job = makeTracked();

  it("toShared rejects non-shaped values and normalizes missing scalars to null", () => {
    expect(toShared(null)).toBeNull();
    expect(toShared({ pairedWorkers: [] })).toBeNull();
    expect(toShared({ pairedWorkers: [], trackedJobs: [], deviceName: 5 })).toEqual({
      pairedWorkers: [],
      trackedJobs: [],
      deviceName: null,
      lastSelectedWorkerId: null,
    });
  });

  it("readStoredShared parses current and older persisted values", () => {
    expect(readStoredShared(null)).toBeNull();
    expect(readStoredShared("not json")).toBeNull();
    const current = {
      version: CONNECT_PERSIST_VERSION,
      state: { pairedWorkers: [PAIRED_WORKER], trackedJobs: [job], deviceName: "Mac", lastSelectedWorkerId: "w" },
    };
    expect(readStoredShared(JSON.stringify(current))).toEqual(current.state);
    const v2 = { version: 2, state: { pairedWorkers: [], trackedJobs: [], selectedWorkerId: "old" } };
    expect(readStoredShared(JSON.stringify(v2)).lastSelectedWorkerId).toBe("old");
  });

  it("sharedSlice picks the four shared fields and capShared caps the jobs", () => {
    const state = { pairedWorkers: [], trackedJobs: [job], deviceName: "d", lastSelectedWorkerId: null, extra: 1 };
    expect(sharedSlice(state)).toEqual({
      pairedWorkers: [],
      trackedJobs: [job],
      deviceName: "d",
      lastSelectedWorkerId: null,
    });
    const many = Array.from({ length: 52 }, (_, i) => makeTracked({ jobId: `d${i}`, state: "completed", submittedAt: i }));
    expect(capShared({ ...sharedSlice(state), trackedJobs: many }).trackedJobs).toHaveLength(50);
  });
});

await run();
