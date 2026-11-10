/**
 * Port of the pure helpers of sleap-app src/components/connect/WorkerJobs.tsx,
 * WorkerQueue.tsx and endJobConfirm.ts @ 683a159 — everything the Jobs tab and the
 * sidebar queue compute from the worker's job list, with no React.
 *
 * Groups a worker's `JobSummary` list into runs (`groupJobs`), pins this project's
 * jobs first, rolls up a run's status, builds titles / status chips / time labels, search
 * matching, the Cancel-run and Delete-run confirm text, and the queue's ordered
 * run entries (`queueRunEntries`, `queueRows`).
 *
 * LUCID changes:
 *  - The React components (`WorkerJobs`, `QueueRunList`, ...) are not here; they live in ui/connect.
 *  - `JobStatusChip.className` is sleap-app's Tailwind string, kept verbatim (CHIP_STYLES /
 *    AFTER_TRAINING_CHIP). The LUCID UI keys its own CSS off `chip.text` / the job state and
 *    ignores `className`.
 *  - `cancelRunConfirm` / `endJobConfirm` return the same `ConfirmRequest` objects
 *    ({ title, message, confirmLabel, cancelLabel, destructive? }); the UI feeds them to `ui/ask.js`.
 *  - `endJobConfirm` and the two button class constants come from endJobConfirm.ts (also verbatim).
 *  - `myProjectId` is `lucidProjectTag(...).id` (project-tag.js) in LUCID.
 *
 * @typedef {{ jobId: string, state: string, createdAt: string, updatedAt?: string, startedAt?: string,
 *   queuePosition: number | null, kind: string, modelTypes: string[], labelsPath?: string,
 *   project?: { id: string, name: string }, run?: { id: string, index: number, count: number, stage?: string },
 *   modelName?: string | null, postInference?: boolean, error?: string } & Record<string, any>} JobSummary
 *   The worker's job-list row (see the worker's `JobSummary`).
 * @typedef {{ text: string, className: string }} JobStatusChip
 * @typedef {{ title: string, message: string, confirmLabel: string, cancelLabel: string, destructive?: boolean }} ConfirmRequest
 */
import { timeAgo, modelRunTimestamp } from "./timestamp.js";

// ── WorkerJobs.tsx ──────────────────────────────────────────────────


/** Last path segment of a worker path (handles both `/` and `\`), or `null` if absent. */
function basename(p) {
  if (!p) return null;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** `jobTitle`+labels-basename sort key doesn't matter here — pinning + recency do. */
export function isMineJob(job, myProjectId) {
  return job.project?.id === myProjectId;
}

/**
 * This project's jobs first (★), newest first within each group — pure and
 * directly unit-testable, matching the design's "this project first, then
 * createdAt desc; others dimmed/view-only" (§4.2).
 */
export function sortWorkerJobs(jobs, myProjectId) {
  return [...jobs].sort((a, b) => {
    const mineA = isMineJob(a, myProjectId);
    const mineB = isMineJob(b, myProjectId);
    if (mineA !== mineB) return mineA ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

/**
 * Whether Cancel/Run again are offered for `job` (PR5b §5b.3) — this
 * project's own job BY ID (`isMineJob`), OR one this window is actively
 * tracking (`trackedJobIds`, e.g. a launcher-wizard submission from earlier
 * this session whose project tag happens to differ, or a job this window
 * resumed watching after a restart).
 */
export function isManagedJob(job, myProjectId, trackedJobIds) {
  return isMineJob(job, myProjectId) || trackedJobIds.has(job.jobId);
}

/**
 * This job's siblings in its training run (`run.id`, in `run.index` order),
 * or just itself if it was never split (`run` absent/`count === 1`) — "Run
 * again" (`seedWizardFromRun`) needs every model of a split multi-model run,
 * not just the row the user clicked. (The Inference flow's own "Models" step,
 * `NewJobWizard`'s `groupCompletedRuns`, does its own equivalent grouping —
 * it also needs to exclude a run with a still-running sibling, which this
 * helper doesn't care about for "Run again".)
 */
export function siblingJobIds(jobs, job) {
  if (!job.run) return [job.jobId];
  return jobs
    .filter((j) => j.run?.id === job.run.id)
    .sort((a, b) => (a.run?.index ?? 0) - (b.run?.index ?? 0))
    .map((j) => j.jobId);
}

export function jobTitle(job) {
  return job.kind === "track" ? "Inference" : `Train ${job.modelTypes[0] ?? "model"}`;
}

/**
 * Whether a run's trash icon is shown (PR6a §a.3) — mirrors the worker's own
 * `jobs.delete` "active" rule (queued or running, not just non-terminal) so
 * the icon never offers something the worker would refuse with `job.active`.
 */
export function canDeleteRun(jobs) {
  return jobs.every((j) => j.state !== "queued" && j.state !== "running");
}

/** One line per job for the delete-run confirmation — title, plus its model name once known. */
function deleteRunJobLine(job) {
  return job.modelName ? `${jobTitle(job)} (${job.modelName})` : jobTitle(job);
}

/**
 * The delete-run confirmation's body (PR6a §a.3): every job in the run,
 * then the reassurance that this only drops the worker's job-list rows —
 * nothing on disk, worker or local, is touched.
 */
export function deleteRunMessage(jobs) {
  return (
    `${jobs.map(deleteRunJobLine).join("\n")}\n\n` +
    "This only removes these jobs from the worker's job list. Nothing is deleted from disk: " +
    "trained models, logs and predictions stay on the worker, and your labels and videos aren't touched."
  );
}

const CHIP_STYLES = {
  queued: "bg-zinc-800 text-zinc-300 border-zinc-600",
  running: "bg-orange-950/60 text-orange-300 border-orange-800",
  completed: "bg-green-950/60 text-green-300 border-green-800",
  failed: "bg-red-950/60 text-red-300 border-red-800",
  canceled: "bg-zinc-800 text-zinc-400 border-zinc-600",
};

/** "Queued · #N" when a queue position is known, else the state capitalized. Shared by `jobStatusChip` (a job) and a group's rolled-up status. */
export function statusChipFor(state, queuePosition = null) {
  const className = CHIP_STYLES[state] ?? CHIP_STYLES.queued;
  if (state === "queued" && queuePosition != null) {
    return { text: `Queued · #${queuePosition}`, className };
  }
  return { text: state.charAt(0).toUpperCase() + state.slice(1), className };
}

/**
 * When to say a job happened: nothing while queued (it hasn't started, and a
 * submission time there reads like a start time), "started …" while running,
 * "finished …" once done. The start time is the worker's `started_at`, or
 * when it left the queue (`updatedAt` of a running job) from a worker that
 * doesn't report it.
 */
export function jobTimeLabel(job) {
  if (job.state === "queued") return null;
  if (job.state === "running") {
    const started = job.startedAt ?? job.updatedAt;
    return started ? `started ${timeAgo(started)}` : null;
  }
  return `${job.state === "completed" ? "finished" : "ended"} ${timeAgo(job.updatedAt ?? job.createdAt)}`;
}

/** A run's time, by the same rules: none while it waits, its first job's start while running, its last job's end once done. */
export function groupTimeLabel(group) {
  if (group.status === "queued") return null;
  const times = (pick) =>
    group.jobs.map(pick).filter((t) => !!t).map((t) => new Date(t).getTime());
  if (group.status === "running") {
    const starts = times((j) => j.startedAt ?? (j.state === "running" ? j.updatedAt : undefined));
    return starts.length ? `started ${timeAgo(new Date(Math.min(...starts)).toISOString())}` : null;
  }
  const ends = times((j) => j.updatedAt ?? j.createdAt);
  return ends.length
    ? `${group.status === "completed" ? "finished" : "ended"} ${timeAgo(new Date(Math.max(...ends)).toISOString())}`
    : null;
}

export function jobStatusChip(job) {
  return statusChipFor(job.state, job.queuePosition);
}

/**
 * One submission's jobs, grouped: a top-down/split train's sibling model
 * jobs (`run.id`, ordered by `run.index`), plus any job chained onto that
 * run as inference — the worker's own `post_inference` chaining (sleap-connect
 * PR5w) and `trainingStore`'s own post-training flow (`connectStore.submitJob`'s
 * `options.run` override) both tag their inference job with the SAME `run.id`
 * as the training jobs it followed, and `run.stage === "inference"` marks it
 * as such. A job with no `run` at all (an older worker, or a legacy job from
 * before run ids existed) groups alone, keyed by its own `jobId` — "+ New
 * job"/"Run again" submissions each mint a fresh run id, so they never
 * collide with an unrelated run.
 *
 * @typedef {{
 *   key: string,
 *   jobs: JobSummary[],
 *   title: string,
 *   labelsName: string | null,
 *   mine: boolean,
 *   createdAt: string,
 *   status: string,
 *   project: JobSummary["project"],
 * }} JobGroup
 *   `key`: `run?.id ?? jobId` of the group's jobs. `jobs`: training jobs first (by `run.index`),
 *   then inference jobs (earliest first). `mine`: this project owns (any job in) the run — same
 *   rule as `isMineJob`, since a chained inference job always shares its train siblings' project.
 *   `createdAt`: earliest job's `createdAt`. `status`: rolled up across every job in the group —
 *   see `rollupGroupStatus`.
 */

/** running > failed > queued > completed (all of them); otherwise a mix with no running/failed/queued member (e.g. one canceled job alongside a completed sibling) reads as "canceled" — the closest existing chip to "didn't fully succeed". */
function rollupGroupStatus(jobs) {
  if (jobs.some((j) => j.state === "running")) return "running";
  if (jobs.some((j) => j.state === "failed")) return "failed";
  if (jobs.some((j) => j.state === "queued")) return "queued";
  if (jobs.every((j) => j.state === "completed")) return "completed";
  return "canceled";
}

/** The group's shared model-name run timestamp (`modelRunTimestamp`, sleap-connect #98's `model_name`) — the first one found among its jobs, since every sibling of one submission shares the same sleap-nn run timestamp. `null` when none of the group's jobs have a known model name yet (unfinished jobs, track jobs, or an older worker). */
function groupModelTimestamp(jobs) {
  for (const j of jobs) {
    const ts = modelRunTimestamp(j.modelName);
    if (ts) return ts;
  }
  return null;
}

/**
 * "<model types joined with ' + '> · <timestamp>" once a `model_name` is
 * known (e.g. "centroid + centered_instance · 260922_015758") — falls back
 * to the pre-#98 title ("Top-down training run" / "Training run (<type>)" /
 * "Inference") when no job in the group carries a model name yet.
 */
function groupTitle(jobs) {
  const trainJobs = jobs.filter((j) => j.kind !== "track");
  if (trainJobs.length === 0) return "Inference";
  const timestamp = groupModelTimestamp(jobs);
  if (timestamp) {
    return `${trainJobs.map((j) => j.modelTypes[0] ?? "model").join(" + ")} · ${timestamp}`;
  }
  if (trainJobs.length > 1) return "Top-down training run";
  return `Training run (${trainJobs[0].modelTypes[0] ?? "model"})`;
}

/**
 * Groups `jobs` by submission (see `JobGroup`'s doc), sorted the same way
 * `sortWorkerJobs` sorts individual jobs: this project's runs first, then
 * newest (earliest job in the run) first.
 */
export function groupJobs(jobs, myProjectId) {
  const order = [];
  const byKey = new Map();
  for (const job of jobs) {
    const key = job.run?.id ?? job.jobId;
    const existing = byKey.get(key);
    if (existing) existing.push(job);
    else {
      byKey.set(key, [job]);
      order.push(key);
    }
  }

  const groups = order.map((key) => {
    // Training jobs by run.index, then inference/track jobs oldest first.
    const groupedJobs = [...byKey.get(key) ].sort((a, b) => {
      const aTrain = a.kind !== "track";
      const bTrain = b.kind !== "track";
      if (aTrain !== bTrain) return aTrain ? -1 : 1;
      if (aTrain) return (a.run?.index ?? 0) - (b.run?.index ?? 0);
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
    const earliest = groupedJobs.reduce((min, j) =>
      new Date(j.createdAt).getTime() < new Date(min.createdAt).getTime() ? j : min,
    );
    return {
      key,
      jobs: groupedJobs,
      title: groupTitle(groupedJobs),
      labelsName: basename(groupedJobs.find((j) => j.labelsPath)?.labelsPath),
      mine: groupedJobs.some((j) => isMineJob(j, myProjectId)),
      createdAt: earliest.createdAt,
      status: rollupGroupStatus(groupedJobs),
      project: groupedJobs.find((j) => j.project)?.project,
    };
  });

  return groups.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

/**
 * Case-insensitive substring match against everything a job is findable by
 * in the Jobs tab's search bar: its labels file (full worker path and just
 * the basename, so a bare filename hits even when the full path doesn't),
 * job id, run id, every model type, and the submitting project's name.
 */
export function jobMatches(job, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystacks = [
    job.labelsPath,
    basename(job.labelsPath) ?? undefined,
    job.jobId,
    job.run?.id,
    job.project?.name,
    job.modelName ?? undefined,
    ...job.modelTypes,
  ];
  return haystacks.some((h) => h?.toLowerCase().includes(q));
}

// ── WorkerQueue.tsx ─────────────────────────────────────────────────

/** A run still on the worker's queue: one of its jobs is running or queued. */
export function isActiveGroup(group) {
  return group.jobs.some((j) => j.state === "running" || j.state === "queued");
}

/** A run's jobs that are still running or queued — what "Cancel run" ends. */
export function unfinishedJobs(group) {
  return group.jobs.filter((j) => j.state === "running" || j.state === "queued");
}

/** The confirm dialog for "Cancel run". */
export function cancelRunConfirm(group) {
  return {
    title: "Cancel this run?",
    message:
      `${unfinishedJobs(group).map(jobTitle).join("\n")}\n\n` +
      "Every unfinished job of this run ends now; queued ones won't run. Jobs behind it in the queue start next.",
    confirmLabel: "Cancel run",
    cancelLabel: "Keep running",
    destructive: true,
  };
}

/** The earliest queue position among a run's queued jobs, or null if none is queued. */
function groupQueuePosition(group) {
  const positions = group.jobs
    .filter((j) => j.state === "queued" && j.queuePosition != null)
    .map((j) => j.queuePosition);
  return positions.length > 0 ? Math.min(...positions) : null;
}

/**
 * One model/inference line inside a run's queue card. `job` is null for inference the run will
 * chain after training (not a worker job yet); `active` marks the row the worker is on right now.
 * @typedef {{ key: string, title: string, job: JobSummary | null, chip: JobStatusChip, active: boolean }} QueueRow
 *
 * A run in the queue: running, waiting, or failed (kept until you click it). `place` is the
 * 1-based place among the queued runs.
 * @typedef {{ group: JobGroup, status: "running" | "queued" | "failed", place: number | null, rows: QueueRow[] }} QueueRunEntry
 */

/** @type {JobStatusChip} */
const AFTER_TRAINING_CHIP = {
  text: "After training",
  className: "bg-zinc-800 text-zinc-400 border-zinc-600",
};

/**
 * A row per job of the run (training models in order, then inference), plus
 * an "After training" inference row when the worker will chain inference
 * (`postInference` on the last model) but hasn't created that job yet.
 */
export function queueRows(group) {
  const rows = group.jobs.map((job) => ({
    key: job.jobId,
    title: job.kind === "track" ? "Inference" : (job.modelTypes[0] ?? "model"),
    job,
    chip: jobStatusChip(job),
    active: job.state === "running",
  }));
  const trainJobs = group.jobs.filter((j) => j.kind !== "track");
  const lastTrain = trainJobs[trainJobs.length - 1];
  const ended = group.jobs.some((j) => j.state === "failed" || j.state === "canceled");
  if (lastTrain?.postInference && !group.jobs.some((j) => j.kind === "track") && !ended) {
    rows.push({ key: `${group.key}:inference`, title: "Inference", job: null, chip: AFTER_TRAINING_CHIP, active: false });
  }
  return rows;
}

/**
 * The queue's runs: failed runs `showFailed` keeps and you haven't dismissed
 * (first, so a failure isn't missed), then the running run(s), then queued
 * runs by their earliest queue position (the worker runs jobs first come,
 * first served).
 */
export function queueRunEntries(
  groups,
  opts,
) {
  const failed = groups.filter(
    (g) =>
      !isActiveGroup(g) &&
      g.jobs.some((j) => j.state === "failed") &&
      !opts.dismissed.has(g.key) &&
      opts.showFailed(g),
  );
  const active = groups.filter(isActiveGroup);
  const running = active.filter((g) => g.jobs.some((j) => j.state === "running"));
  const waiting = active
    .filter((g) => !g.jobs.some((j) => j.state === "running"))
    .sort((a, b) => (groupQueuePosition(a) ?? Infinity) - (groupQueuePosition(b) ?? Infinity));
  return [
    ...failed.map((group) => ({ group, status: "failed", place: null, rows: queueRows(group) })),
    ...running.map((group) => ({ group, status: "running", place: null, rows: queueRows(group) })),
    ...waiting.map((group, i) => ({ group, status: "queued", place: i + 1, rows: queueRows(group) })),
  ];
}

// ── endJobConfirm.ts ────────────────────────────────────────────────


/** Stop Early is yellow and Cancel red, as in the Training panel. */
export const STOP_EARLY_BUTTON_CLASS =
  "h-6 text-[10px] border-yellow-500/50 text-yellow-500 hover:bg-yellow-500/10 hover:text-yellow-400";
export const CANCEL_BUTTON_CLASS =
  "h-6 text-[10px] border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-300";

/**
 * The confirm dialog for ending a worker job, shared by the Jobs tab and the
 * job viewer. Like SLEAP's training monitor: Stop Early finishes training and
 * keeps the model trained so far; Cancel ends the job without one.
 */
export function endJobConfirm(
  title,
  mode,
  queued,
) {
  if (mode === "stop") {
    return {
      title: "Stop training early?",
      message: `"${title}" finishes its current batch and keeps the model trained so far.`,
      confirmLabel: "Stop Early",
      cancelLabel: "Keep training",
    };
  }
  return {
    title: "Cancel job?",
    message: queued
      ? `"${title}" is removed from the worker's queue and won't run.`
      : `"${title}" ends now without a result.`,
    confirmLabel: "Cancel job",
    cancelLabel: queued ? "Keep queued" : "Keep running",
    destructive: true,
  };
}
