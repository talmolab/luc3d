/**
 * Port of the pure-logic tests of sleap-app tests/unit/workerJobs.test.tsx and
 * workerQueue.test.tsx @ 683a159, against pose/connect/job-groups.js.
 *
 * Ported: isMineJob / sortWorkerJobs, jobTitle / jobStatusChip, canDeleteRun /
 * deleteRunMessage, groupJobs, jobMatches, isManagedJob / siblingJobIds, job and run
 * time labels (workerJobs); queueRunEntries / queueRows (workerQueue). Skipped: every
 * React rendering test (WorkerJobs, QueueRunList, SidebarQueue). Added: cancelRunConfirm /
 * unfinishedJobs / isActiveGroup / endJobConfirm.
 */
import { describe, it, expect, run as runAll } from './bun-test-shim.mjs';
import {
  isMineJob,
  sortWorkerJobs,
  jobTitle,
  jobStatusChip,
  isManagedJob,
  siblingJobIds,
  groupJobs,
  jobMatches,
  canDeleteRun,
  deleteRunMessage,
  jobTimeLabel,
  groupTimeLabel,
  statusChipFor,
  queueRunEntries,
  queueRows,
  isActiveGroup,
  unfinishedJobs,
  cancelRunConfirm,
  endJobConfirm,
} from '../pose/connect/job-groups.js';
import { projectTag } from '../pose/connect/project-tag.js';

const MY_PROJECT_PATH = "/Users/x/labels.v003.slp";
const myProject = projectTag(MY_PROJECT_PATH);

function job(overrides = {}) {
  return {
    jobId: "job_1",
    state: "running",
    createdAt: "2026-10-01T00:00:00.000Z",
    queuePosition: null,
    kind: "train",
    modelTypes: ["centroid"],
    labelsPath: "/root/vast/exp1/flies.slp",
    project: myProject,
    ...overrides,
  };
}

describe("isMineJob / sortWorkerJobs (pure logic)", () => {
  it("matches a job whose project id equals the open project's", () => {
    expect(isMineJob(job(), myProject.id)).toBe(true);
    expect(isMineJob(job({ project: { id: "other", name: "x" } }), myProject.id)).toBe(false);
  });

  it("pins this project's jobs first, newest first within each group", () => {
    const mineOld = job({ jobId: "mine-old", createdAt: "2026-10-01T00:00:00.000Z" });
    const mineNew = job({ jobId: "mine-new", createdAt: "2026-10-03T00:00:00.000Z" });
    const otherNew = job({
      jobId: "other-new",
      createdAt: "2026-10-04T00:00:00.000Z",
      project: { id: "other", name: "x" },
    });
    const sorted = sortWorkerJobs([mineOld, otherNew, mineNew], myProject.id);
    expect(sorted.map((j) => j.jobId)).toEqual(["mine-new", "mine-old", "other-new"]);
  });
});

describe("jobTitle / jobStatusChip (pure logic)", () => {
  it("titles a track job 'Inference' and a train job by its model type", () => {
    expect(jobTitle(job({ kind: "track" }))).toBe("Inference");
    expect(jobTitle(job({ kind: "train", modelTypes: ["centered_instance"] }))).toBe(
      "Train centered_instance",
    );
  });

  it("shows 'Queued · #N' for a queued job with a known position", () => {
    expect(jobStatusChip(job({ state: "queued", queuePosition: 2 })).text).toBe("Queued · #2");
  });

  it("falls back to the capitalized state otherwise", () => {
    expect(jobStatusChip(job({ state: "completed" })).text).toBe("Completed");
  });
});

describe("canDeleteRun / deleteRunMessage (PR6a §a.3, pure logic)", () => {
  it("is deletable when every job is terminal", () => {
    expect(canDeleteRun([job({ state: "completed" }), job({ jobId: "b", state: "failed" })])).toBe(
      true,
    );
  });

  it("is not deletable if any job is queued or running", () => {
    expect(canDeleteRun([job({ state: "completed" }), job({ jobId: "b", state: "queued" })])).toBe(
      false,
    );
    expect(canDeleteRun([job({ state: "running" })])).toBe(false);
  });

  it("lists each job's title, with its model name once known, then the disk-safety note", () => {
    const message = deleteRunMessage([
      job({ kind: "train", modelTypes: ["centroid"], modelName: "260922_015758.centroid.n=1" }),
      job({ jobId: "b", kind: "track", modelName: null }),
    ]);
    expect(message).toContain("Train centroid (260922_015758.centroid.n=1)");
    expect(message).toContain("Inference");
    expect(message).not.toContain("Inference (");
    expect(message).toContain("Nothing is deleted from disk");
    expect(message).toContain("your labels and videos aren't touched");
  });
});

describe("groupJobs (pure logic)", () => {
  it("groups a split training run's siblings under one key, ordered by run.index", () => {
    const centeredInstance = job({
      jobId: "b",
      modelTypes: ["centered_instance"],
      run: { id: "r1", index: 1, count: 2 },
    });
    const centroid = job({ jobId: "a", run: { id: "r1", index: 0, count: 2 } });
    const groups = groupJobs([centeredInstance, centroid], myProject.id);
    expect(groups).toHaveLength(1);
    expect(groups[0] .key).toBe("r1");
    expect(groups[0] .jobs.map((j) => j.jobId)).toEqual(["a", "b"]);
    expect(groups[0] .title).toBe("Top-down training run");
  });

  it("groups a chained inference job (same run.id, run.stage: 'inference') after its training job", () => {
    const train = job({ jobId: "train1", run: { id: "r1", index: 0, count: 1 } });
    const infer = job({
      jobId: "infer1",
      kind: "track",
      run: { id: "r1", index: 0, count: 1, stage: "inference" },
      createdAt: "2026-10-02T00:00:00.000Z",
    });
    const groups = groupJobs([infer, train], myProject.id);
    expect(groups).toHaveLength(1);
    expect(groups[0] .jobs.map((j) => j.jobId)).toEqual(["train1", "infer1"]);
    expect(groups[0] .title).toBe("Training run (centroid)");
  });

  it("groups a job with no run at all alone, keyed by its own jobId", () => {
    const a = job({ jobId: "a" });
    const b = job({ jobId: "b", createdAt: "2026-10-02T00:00:00.000Z" });
    const groups = groupJobs([a, b], myProject.id);
    expect(groups.map((g) => g.key)).toEqual(["b", "a"]);
  });

  it("an inference-only group (no train job) titles 'Inference'", () => {
    const groups = groupJobs([job({ kind: "track" })], myProject.id);
    expect(groups[0] .title).toBe("Inference");
  });

  it("rolls up status: running beats failed beats queued beats completed", () => {
    const run = (id, index, count, state) =>
      job({ jobId: `${id}-${index}`, run: { id, index, count }, state });

    expect(groupJobs([run("r1", 0, 2, "running"), run("r1", 1, 2, "failed")], myProject.id)[0] .status).toBe(
      "running",
    );
    expect(groupJobs([run("r2", 0, 2, "queued"), run("r2", 1, 2, "failed")], myProject.id)[0] .status).toBe(
      "failed",
    );
    expect(groupJobs([run("r3", 0, 2, "completed"), run("r3", 1, 2, "queued")], myProject.id)[0] .status).toBe(
      "queued",
    );
    expect(groupJobs([run("r4", 0, 1, "completed")], myProject.id)[0] .status).toBe("completed");
  });

  it("sorts groups this project first, then newest first — same rule as sortWorkerJobs", () => {
    const mineOld = job({ jobId: "mine-old", createdAt: "2026-10-01T00:00:00.000Z" });
    const otherNew = job({
      jobId: "other-new",
      createdAt: "2026-10-03T00:00:00.000Z",
      project: { id: "other", name: "x" },
    });
    const mineNew = job({ jobId: "mine-new", createdAt: "2026-10-02T00:00:00.000Z" });
    const groups = groupJobs([mineOld, otherNew, mineNew], myProject.id);
    expect(groups.map((g) => g.key)).toEqual(["mine-new", "mine-old", "other-new"]);
  });

  it("titles a split run '<types joined> · <timestamp>' once a model_name is known (sleap-connect #98)", () => {
    const centroid = job({
      jobId: "a",
      run: { id: "r1", index: 0, count: 2 },
      modelName: "260922_015758.centroid.n=1",
    });
    const centeredInstance = job({
      jobId: "b",
      modelTypes: ["centered_instance"],
      run: { id: "r1", index: 1, count: 2 },
      modelName: "260922_015758.centered_instance.n=1",
    });
    const groups = groupJobs([centroid, centeredInstance], myProject.id);
    expect(groups[0] .title).toBe("centroid + centered_instance · 260922_015758");
  });

  it("falls back to the pre-#98 title when no job in the group has a model name yet", () => {
    const centroid = job({ jobId: "a", run: { id: "r1", index: 0, count: 2 } });
    const centeredInstance = job({
      jobId: "b",
      modelTypes: ["centered_instance"],
      run: { id: "r1", index: 1, count: 2 },
    });
    const groups = groupJobs([centroid, centeredInstance], myProject.id);
    expect(groups[0] .title).toBe("Top-down training run");
  });
});

describe("jobMatches (pure logic)", () => {
  it("matches the labels path, its basename, job id, run id, model type, and project name — case-insensitively", () => {
    const j = job({
      jobId: "job_abc123",
      labelsPath: "/root/vast/exp1/flies.v002.slp",
      run: { id: "run-xyz", index: 0, count: 1 },
      modelTypes: ["centered_instance"],
      project: { id: "p1", name: "FliesProject" },
    });
    expect(jobMatches(j, "FLIES.V002")).toBe(true);
    expect(jobMatches(j, "/root/vast")).toBe(true);
    expect(jobMatches(j, "job_abc")).toBe(true);
    expect(jobMatches(j, "run-xyz")).toBe(true);
    expect(jobMatches(j, "centered_instance")).toBe(true);
    expect(jobMatches(j, "fliesproject")).toBe(true);
    expect(jobMatches(j, "nope")).toBe(false);
  });

  it("an empty or blank query matches everything", () => {
    expect(jobMatches(job(), "")).toBe(true);
    expect(jobMatches(job(), " ")).toBe(true);
  });

  it("matches a job's model name (sleap-connect #98) — case-insensitively", () => {
    const j = job({ modelName: "260922_015758.centroid.n=1" });
    expect(jobMatches(j, "260922_015758")).toBe(true);
    expect(jobMatches(j, "CENTROID.N=1")).toBe(true);
  });
});

describe("isManagedJob / siblingJobIds (pure logic)", () => {
  it("is managed when the project id matches, even with no tracked jobs", () => {
    expect(isManagedJob(job(), myProject.id, new Set())).toBe(true);
  });

  it("is managed when the job id is tracked, even from a different project", () => {
    const other = job({ project: { id: "other", name: "x" } });
    expect(isManagedJob(other, myProject.id, new Set())).toBe(false);
    expect(isManagedJob(other, myProject.id, new Set(["job_1"]))).toBe(true);
  });

  it("returns just the job itself when it has no run", () => {
    expect(siblingJobIds([job()], job())).toEqual(["job_1"]);
  });

  it("returns every sibling sharing run.id, ordered by run.index", () => {
    const a = job({ jobId: "a", run: { id: "r1", index: 1, count: 2 } });
    const b = job({ jobId: "b", run: { id: "r1", index: 0, count: 2 } });
    const c = job({ jobId: "c", run: { id: "r2", index: 0, count: 1 } });
    expect(siblingJobIds([a, b, c], a)).toEqual(["b", "a"]);
  });
});

describe("job and run times", () => {
  it("nothing while queued, 'started' while running, 'finished' once done", () => {
    expect(jobTimeLabel(job({ state: "queued" }))).toBeNull();
    expect(jobTimeLabel(job({ state: "running", updatedAt: new Date().toISOString() }))).toBe("started just now");
    expect(
      jobTimeLabel(job({ state: "running", startedAt: new Date(Date.now() - 5 * 60_000).toISOString() })),
    ).toBe("started 5 min ago");
    expect(jobTimeLabel(job({ state: "completed", updatedAt: new Date().toISOString() }))).toBe("finished just now");
  });

  it("a queued run shows no time", () => {
    const [g] = groupJobs([job({ state: "queued" })], myProject.id);
    expect(groupTimeLabel(g )).toBeNull();
  });
});

// ── workerQueue.test.tsx ──

const PROJECT_PATH = "/data/mine.slp";
const mine = projectTag(PROJECT_PATH);
const other = { id: "other", name: "lab.slp" };
const recent = new Date().toISOString();

function qjob(jobId, state, o = {}) {
  return {
    jobId,
    state,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: recent,
    queuePosition: null,
    kind: "train",
    modelTypes: ["centroid"],
    labelsPath: "/data/mine.slp",
    project: mine,
    ...o,
  };
}

const run = (id, index = 0, count = 1) => ({ id, index, count });

// A worker with: my top-down run training its 2nd model (inference chained),
// a collaborator's run queued behind it, my run queued after that, and a
// failed run of mine.
const JOBS = [
  qjob("a1", "completed", { run: run("A", 0, 2) }),
  qjob("a2", "running", { run: run("A", 1, 2), modelTypes: ["centered_instance"], postInference: true }),
  qjob("b1", "queued", { run: run("B"), project: other, queuePosition: 1 }),
  qjob("c1", "queued", { run: run("C"), modelTypes: ["bottomup"], queuePosition: 2 }),
  qjob("f1", "failed", { run: run("F", 0, 2), error: "CUDA out of memory\nTraceback" }),
  qjob("f2", "canceled", { run: run("F", 1, 2), modelTypes: ["centered_instance"] }),
  qjob("old", "completed", { run: run("OLD") }),
];

const groups = () => groupJobs(JOBS, mine.id);

describe("queueRunEntries / queueRows", () => {
  it("orders failed (kept), then running, then queued by position; finished runs are left out", () => {
    const entries = queueRunEntries(groups(), { showFailed: () => true, dismissed: new Set() });
    expect(entries.map((e) => [e.group.key, e.status, e.place])).toEqual([
      ["F", "failed", null],
      ["A", "running", null],
      ["B", "queued", 1],
      ["C", "queued", 2],
    ]);
  });

  it("leaves out a failed run once dismissed, or when showFailed says no", () => {
    const keys = (dismissed, show) =>
      queueRunEntries(groups(), { showFailed: () => show, dismissed }).map((e) => e.group.key);
    expect(keys(new Set(["F"]), true)).not.toContain("F");
    expect(keys(new Set(), false)).not.toContain("F");
  });

  it("rows: a row per model with its badge, the running one active, plus inference still to come", () => {
    const a = groups().find((g) => g.key === "A") ;
    expect(queueRows(a).map((r) => [r.title, r.chip.text, r.active])).toEqual([
      ["centroid", "Completed", false],
      ["centered_instance", "Running", true],
      ["Inference", "After training", false],
    ]);
  });

  it("no inference row for a run that already ended in failure", () => {
    const f = groups().find((g) => g.key === "F") ;
    expect(queueRows(f).map((r) => r.title)).toEqual(["centroid", "centered_instance"]);
  });
});

describe("cancelRunConfirm / unfinishedJobs / isActiveGroup", () => {
  const [g] = groupJobs(
    [
      job({ jobId: "a", state: "completed", run: { id: "r", index: 0, count: 2 } }),
      job({ jobId: "b", state: "running", modelTypes: ["centered_instance"], run: { id: "r", index: 1, count: 2 } }),
    ],
    myProject.id,
  );

  it("an active run has running/queued jobs; a finished one doesn't", () => {
    expect(isActiveGroup(g)).toBe(true);
    expect(unfinishedJobs(g).map((j) => j.jobId)).toEqual(["b"]);
    const [done] = groupJobs([job({ state: "completed" })], myProject.id);
    expect(isActiveGroup(done)).toBe(false);
  });

  it("Cancel run lists only the unfinished jobs, destructive", () => {
    expect(cancelRunConfirm(g)).toEqual({
      title: "Cancel this run?",
      message:
        "Train centered_instance\n\n" +
        "Every unfinished job of this run ends now; queued ones won't run. Jobs behind it in the queue start next.",
      confirmLabel: "Cancel run",
      cancelLabel: "Keep running",
      destructive: true,
    });
  });
});

describe("endJobConfirm / statusChipFor", () => {
  it("Stop Early keeps the model; Cancel is destructive and words queued vs running differently", () => {
    expect(endJobConfirm("Train centroid", "stop", false)).toEqual({
      title: "Stop training early?",
      message: '"Train centroid" finishes its current batch and keeps the model trained so far.',
      confirmLabel: "Stop Early",
      cancelLabel: "Keep training",
    });
    const running = endJobConfirm("Inference", "cancel", false);
    expect(running.message).toBe('"Inference" ends now without a result.');
    expect(running.cancelLabel).toBe("Keep running");
    expect(running.destructive).toBe(true);
    const queued = endJobConfirm("Inference", "cancel", true);
    expect(queued.message).toBe("\"Inference\" is removed from the worker's queue and won't run.");
    expect(queued.cancelLabel).toBe("Keep queued");
  });

  it("statusChipFor: queued with a position, plain capitalized states, unknown state styled as queued", () => {
    expect(statusChipFor("queued", 3).text).toBe("Queued · #3");
    expect(statusChipFor("queued").text).toBe("Queued");
    expect(statusChipFor("failed").text).toBe("Failed");
    expect(statusChipFor("weird").className).toBe(statusChipFor("queued").className);
  });
});

await runAll();
