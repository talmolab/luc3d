/**
 * Tests for pose/connect/worker-ui-helpers.js.
 *
 * Ported from sleap-app @ 683a159: tests/unit/workerList.test.tsx ("classifyWorkerStatus" and
 * "workerSpecsLine" pure-logic blocks, verbatim), tests/unit/forgetWorker.test.ts
 * (`forgetWorkerConfirm`; the `forgetWorkerWithConfirm` half drives the zustand/confirm stores and is
 * not ported), tests/unit/workerQueue.test.tsx's SidebarQueue "another project's failed run, or one
 * older than a day" rule (as `failedRunShown`) and the dismissed-runs key. The rest of those files
 * (and workerDataAccess / connectPanel / connectDialog / jobViewerDialog / newJobWizard /
 * pairWorkerForm) assert rendered DOM and belong to the ui/connect e2e phase; sleap-app has no unit
 * tests for the helpers below, so they are new here: sortDevices, describeError,
 * describeVisibilityOutcome, shouldAutoMerge, summarizeVideoCheck, groupCompletedRuns, labelPastRuns,
 * readWholeWorkerFile, readCodeInfo, toTrainingStatus and the small path helpers.
 * (The WorkerJobs / WorkerQueue pure helpers are covered by test-connect-job-groups.mjs.)
 */
import { describe, it, expect, run } from './bun-test-shim.mjs';
import {
  classifyWorkerStatus, workerSpecsLine, WORKER_FILTERS, sortDevices, describeError,
  describeVisibilityOutcome, shouldAutoMerge, forgetWorkerConfirm, DISMISSED_FAILED_RUNS_KEY,
  FAILED_SHOWN_MS, loadDismissedFailedRuns, saveDismissedFailedRuns, failedRunShown,
  WORKER_FILE_INFERENCE_TARGETS, readWholeWorkerFile, summarizeVideoCheck, groupCompletedRuns,
  labelPastRuns, formatMB, readCodeInfo, toTrainingStatus, connectionDotClass, dirname, basename,
  extOf, SELECTED_WORKER_KEY,
} from '../pose/connect/worker-ui-helpers.js';
import { WorkerProtocolError, PROTO_UNKNOWN_METHOD } from '../pose/connect/errors.js';
import { encodePairCode } from './connect/pair-code.mjs';

const GPU_INFO = { gpuModel: "RTX 4090", gpuMemoryMb: 24576, gpuCount: 1, cudaVersion: "12.4", sleapNnVersion: "0.3.1" };

describe("classifyWorkerStatus (pure logic)", () => {
  it("an unpaired worker is 'Unpaired' (red), whatever its link says", () => {
    const s = classifyWorkerStatus({ status: "connected", route: "ws" }, null, false, true);
    expect(s).toMatchObject({ bucket: "offline", label: "Unpaired", unpaired: true, dotClass: "bg-red-500" });
    expect(classifyWorkerStatus({ status: "unpaired", route: "ws" }, null, false).unpaired).toBe(true);
  });
  it("connected + not busy -> idle", () => {
    expect(classifyWorkerStatus({ status: "connected", route: "ws" }, null, false).bucket).toBe("idle");
  });
  it("connected + busy -> busy", () => {
    expect(classifyWorkerStatus({ status: "connected", route: "ws" }, null, true).bucket).toBe("busy");
  });
  it("no connection entry -> offline", () => {
    expect(classifyWorkerStatus(undefined, null, undefined).bucket).toBe("offline");
  });
  it("reconnecting -> offline bucket with a 'Reconnecting…' label", () => {
    const s = classifyWorkerStatus({ status: "reconnecting", route: "ws" }, null, undefined);
    expect(s.bucket).toBe("offline");
    expect(s.label).toBe("Reconnecting…");
  });
  it("connecting -> offline bucket with a 'Connecting…' label", () => {
    expect(classifyWorkerStatus({ status: "connecting", route: "ws" }, null, undefined).label).toBe("Connecting…");
  });
  it("an identity-mismatch error flags identityMismatch regardless of connection state", () => {
    const s = classifyWorkerStatus(
      { status: "connected", route: "ws" },
      "Worker at ws://x identified itself as a different node than expected",
      false,
    );
    expect(s.identityMismatch).toBe(true);
    expect(s.bucket).toBe("offline");
    expect(s.label).toBe("has a new identity");
  });
  it("a non-identity error still classifies as offline, not a mismatch", () => {
    const s = classifyWorkerStatus(undefined, "Not connected", undefined);
    expect(s.identityMismatch).toBe(false);
    expect(s.bucket).toBe("offline");
  });
  it("filter chips are All / Idle / Busy / Offline", () => {
    expect(WORKER_FILTERS.map((f) => f.label)).toEqual(["All", "Idle", "Busy", "Offline"]);
  });
});

describe("workerSpecsLine (pure logic)", () => {
  it("formats GPU model, memory, count, CUDA, and sleap-nn version", () => {
    expect(workerSpecsLine(GPU_INFO)).toBe("RTX 4090 · 24 GB ×1 · CUDA 12.4 · sleap-nn 0.3.1");
  });
  it("one decimal for a non-integer GB figure", () => {
    expect(workerSpecsLine({ ...GPU_INFO, gpuMemoryMb: 11264 + 512 })).toContain("11.5 GB");
  });
  it("returns null when info is unknown", () => {
    expect(workerSpecsLine(undefined)).toBeNull();
  });
});

describe("sortDevices / describeError", () => {
  it("puts this device first, then most recently seen (missing last-seen last)", () => {
    const d = [
      { id: "old", lastSeenAt: "2026-10-01T00:00:00Z" },
      { id: "you", you: true, lastSeenAt: "2026-01-01T00:00:00Z" },
      { id: "new", lastSeenAt: "2026-10-05T00:00:00Z" },
      { id: "never" },
    ];
    expect(sortDevices(d).map((x) => x.id)).toEqual(["you", "new", "old", "never"]);
    expect(d[0].id).toBe("old"); // input untouched
  });
  it("explains an old worker, else shows the message", () => {
    expect(describeError(new WorkerProtocolError(PROTO_UNKNOWN_METHOD, "x"))).toBe(
      "This worker's SLEAP Connect is too old to list devices — update it to see who has access.",
    );
    expect(describeError(new Error("boom"))).toBe("Couldn't load devices: boom");
    expect(describeError("plain")).toBe("Couldn't load devices: plain");
  });
});

describe("describeVisibilityOutcome / shouldAutoMerge", () => {
  const v = (...vis) => vis.map((visible, index) => ({ index, local: `/v${index}.mp4`, worker: null, visible }));
  it("describes all / none / some coverage", () => {
    expect(describeVisibilityOutcome(v(true, true))).toBe("Training + inference on worker");
    expect(describeVisibilityOutcome([])).toBe("Training + inference on worker");
    expect(describeVisibilityOutcome(v(false, false))).toBe("Training only — videos not visible");
    expect(describeVisibilityOutcome(v(true, false, true))).toBe("Training on worker · inference on 2 of 3 videos");
  });
  it("auto-merges only a 'mine' job whose predictions fully match", () => {
    const ok = { skeletonOk: true, total: 3, matchedCount: 3 };
    expect(shouldAutoMerge(true, ok)).toBe(true);
    expect(shouldAutoMerge(false, ok)).toBe(false);
    expect(shouldAutoMerge(true, { ...ok, skeletonOk: false })).toBe(false);
    expect(shouldAutoMerge(true, { ...ok, matchedCount: 2 })).toBe(false);
    expect(shouldAutoMerge(true, { skeletonOk: true, total: 0, matchedCount: 0 })).toBe(false);
  });
});

const WORKER = { nodeId: "w1", label: "GPU box", addrs: [], pairedAt: "2026-10-23T00:00:00Z" };

describe("forgetWorkerConfirm", () => {
  it("warns that forgetting unpairs this device on the worker", () => {
    const req = forgetWorkerConfirm(WORKER);
    expect(req.destructive).toBe(true);
    expect(req.message).toContain("GPU box");
    expect(req.message).toContain("sleap-connect pair");
    expect(req.confirmLabel).toBe("Forget worker");
  });
  it("for an already-unpaired worker, only mentions removing it locally", () => {
    const req = forgetWorkerConfirm({ ...WORKER, unpairedAt: "2026-10-23T01:00:00Z" });
    expect(req.message).not.toContain("sleap-connect pair");
    expect(req.message).toContain("already unpaired");
    expect(req.confirmLabel).toBe("Forget");
  });
});

describe("dismissed failed runs + failedRunShown", () => {
  const mem = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v), m };
  };
  it("uses the LUCID key and a one-day window", () => {
    expect(DISMISSED_FAILED_RUNS_KEY).toBe("lucid-connect-dismissed-failed-runs");
    expect(FAILED_SHOWN_MS).toBe(86_400_000);
  });
  it("round-trips a set, and tolerates missing / corrupt / throwing storage", () => {
    const s = mem();
    expect([...loadDismissedFailedRuns(s)]).toEqual([]);
    saveDismissedFailedRuns(s, new Set(["F", "G"]));
    expect(JSON.parse(s.m.get(DISMISSED_FAILED_RUNS_KEY))).toEqual(["F", "G"]);
    expect([...loadDismissedFailedRuns(s)]).toEqual(["F", "G"]);
    s.m.set(DISMISSED_FAILED_RUNS_KEY, "not json");
    expect(loadDismissedFailedRuns(s).size).toBe(0);
    const bad = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(loadDismissedFailedRuns(bad).size).toBe(0);
    saveDismissedFailedRuns(bad, new Set(["a"]));
    expect(loadDismissedFailedRuns(null).size).toBe(0);
    saveDismissedFailedRuns(undefined, new Set(["a"]));
  });
  it("doesn't keep another project's failed run, or one older than a day", () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    const recent = new Date(now - 60_000).toISOString();
    const dayAgo = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    const g = (state, updatedAt) => ({ jobs: [{ state, createdAt: dayAgo, updatedAt }] });
    expect(failedRunShown(g("failed", recent), true, now)).toBe(true);
    expect(failedRunShown(g("failed", recent), false, now)).toBe(false);
    expect(failedRunShown(g("failed", dayAgo), true, now)).toBe(false);
    expect(failedRunShown(g("completed", recent), true, now)).toBe(false);
    expect(failedRunShown({ jobs: [{ state: "failed", createdAt: recent }] }, true, now)).toBe(true);
  });
});

const job = (o = {}) => ({
  jobId: "j", state: "completed", createdAt: "2026-10-01T00:00:00.000Z", queuePosition: null,
  kind: "train", modelTypes: ["centroid"], labelsPath: "/vast/exp/flies.slp", ...o,
});

describe("new-job wizard helpers", () => {
  it("summarizeVideoCheck is silent for exact paths and pluralizes the rest", () => {
    expect(summarizeVideoCheck([{ via: "exact" }, { via: "embedded" }])).toEqual([]);
    expect(summarizeVideoCheck([{ via: "rule" }, { via: "next-to-labels" }, { via: "next-to-labels" }])).toEqual([
      "1 video found via a remembered location",
      "2 videos found next to the labels file",
    ]);
  });

  it("groupCompletedRuns lists only runs whose every sibling completed, in run.index order", () => {
    const jobs = [
      job({ jobId: "c2", modelTypes: ["centered_instance"], run: { id: "R", index: 1, count: 2 }, createdAt: "2026-10-02T00:00:00.000Z", modelName: "260922_015758.centered_instance.n=1" }),
      job({ jobId: "c1", modelTypes: ["centroid"], run: { id: "R", index: 0, count: 2 }, modelName: "260922_015758.centroid.n=1" }),
      job({ jobId: "i1", run: { id: "I", index: 0, count: 2 } }), // sibling missing
      job({ jobId: "r1", run: { id: "P", index: 0, count: 2 } }),
      job({ jobId: "r2", run: { id: "P", index: 1, count: 2 }, state: "running" }), // sibling still running
      job({ jobId: "t1", kind: "track" }), // not a training run
      job({ jobId: "solo", modelTypes: ["single_instance"] }), // no run: its own one-job run
    ];
    const runs = groupCompletedRuns(jobs);
    expect(runs.map((r) => r.runId)).toEqual(["R", "solo"]);
    expect(runs[0]).toEqual({
      runId: "R", jobIds: ["c1", "c2"], modelTypes: ["centroid", "centered_instance"],
      labelsPath: "/vast/exp/flies.slp", createdAt: "2026-10-02T00:00:00.000Z", timestamp: "260922_015758",
    });
    expect(runs[1].timestamp).toBeNull();
  });

  it("labelPastRuns formats the dropdown lines and disambiguates identical ones", () => {
    const run = (runId, timestamp) => ({ runId, jobIds: [], modelTypes: ["centroid", "centered_instance"], labelsPath: "/v/flies.slp", createdAt: new Date().toISOString(), timestamp });
    const [a] = labelPastRuns([run("abcdef123456", "260922_015758")]);
    expect(a.primary).toBe("(centroid + centered_instance) · 260922_015758");
    expect(a.secondary).toMatch(/^flies\.slp · .+$/);
    expect(labelPastRuns([run("abcdef123456", null)])[0].primary).toBe("(centroid + centered_instance) · abcdef12");
    const dup = labelPastRuns([run("aaaaaaaa1", "260922_015758"), run("bbbbbbbb2", "260922_015758")]);
    expect(dup.map((d) => d.primary.endsWith("· aaaaaaaa") || d.primary.endsWith("· bbbbbbbb"))).toEqual([true, true]);
    expect(labelPastRuns([{ ...run("x", null), labelsPath: "" }])[0].secondary).toMatch(/^— · /);
  });

  it("offers the five worker-file inference targets and formats megabytes", () => {
    expect(WORKER_FILE_INFERENCE_TARGETS.map((t) => t.value)).toEqual(["suggestions", "user_labeled", "predicted", "all_videos", "random"]);
    expect(formatMB(1_500_000)).toBe("1.5");
    expect(formatMB(25_400_000)).toBe("25");
  });

  it("readWholeWorkerFile concatenates fs.read chunks until eof", async () => {
    const enc = new TextEncoder();
    const parts = [enc.encode("model: "), enc.encode("héllo"), enc.encode("\n")];
    const offsets = [];
    const client = { fsRead: async (_p, off) => { offsets.push(off); const i = offsets.length - 1; return { content: parts[i], eof: i === 2 }; } };
    expect(await readWholeWorkerFile(client, "/w/a.yaml")).toBe("model: héllo\n");
    expect(offsets).toEqual([0, 7, 13]);
    const empty = { fsRead: async () => ({ content: new Uint8Array(), eof: false }) };
    expect(await readWholeWorkerFile(empty, "/w/b")).toBe("");
  });
});

describe("readCodeInfo", () => {
  it("reads a legacy JSON ticket and returns null for non-codes / partial input", async () => {
    expect(await readCodeInfo(JSON.stringify({ addrs: ["ws://h:1"], expires_at: 123 }))).toEqual({ expiresAt: 123, addrs: ["ws://h:1"], hasRelay: false });
    expect(await readCodeInfo('{"iroh": {"node_id": "x", "relay_url": "https://r"}}')).toMatchObject({ addrs: [] });
    expect(await readCodeInfo("   ")).toBeNull();
    expect(await readCodeInfo("hello world")).toBeNull();
    expect(await readCodeInfo("sleap1zzzz")).toBeNull();
  });
  it("decodes a one-line pairing code", async () => {
    const b64 = (n, fill) => Buffer.from(new Uint8Array(n).fill(fill)).toString("base64url");
    const code = await encodePairCode({ node_id: b64(32, 1), secret: b64(16, 2), expires_at: 2_000_000_000, addrs: ["10.0.0.5:8765"] });
    const info = await readCodeInfo(`  ${code}\n`);
    expect(info.expiresAt).toBe(2_000_000_000);
    expect(info.addrs.length).toBe(1);
    expect(info.hasRelay).toBe(false);
  });
});

describe("small mappings", () => {
  it("toTrainingStatus maps the stream status onto the loss plot vocabulary", () => {
    expect(["running", "completed", "failed", "canceled", "queued", "unknown"].map(toTrainingStatus)).toEqual(
      ["running", "completed", "error", "stopped", "idle", "idle"],
    );
  });
  it("connectionDotClass, dirname, basename, extOf", () => {
    expect(["connected", "reconnecting", "connecting", "x"].map(connectionDotClass)).toEqual(["bg-green-500", "bg-amber-500", "bg-yellow-500", "bg-zinc-500"]);
    expect(dirname("/a/b/")).toBe("/a");
    expect(dirname("/a")).toBe("/");
    expect(basename("C:\\v\\x.mp4")).toBe("x.mp4");
    expect(extOf("/a/Clip.MP4")).toBe(".mp4");
    expect(extOf("/a/noext")).toBeUndefined();
    expect(SELECTED_WORKER_KEY).toBe("");
  });
});

await run();
