/**
 * Port of the pure (non-React) helpers of sleap-app's Connect UI @ 683a159:
 *   WorkerList.tsx (`classifyWorkerStatus`, `workerSpecsLine`), WorkerDevices.tsx (`sortDevices`,
 *   `describeError`), RemoteDataSummary.tsx (`describeVisibilityOutcome`), MergePredictionsDialog.tsx
 *   (`shouldAutoMerge`), forgetWorker.ts (`forgetWorkerConfirm`), SidebarQueue.tsx (`FAILED_SHOWN_MS`,
 *   dismissed-failed-runs storage), NewJobWizard.tsx (`WORKER_FILE_INFERENCE_TARGETS`,
 *   `summarizeVideoCheck`, `groupCompletedRuns`, `labelPastRuns`, `formatMB`, `readWholeWorkerFile`),
 *   PairWorkerForm.tsx (`readCodeInfo`), JobViewerDialog.tsx (`toTrainingStatus`), RemoteRunCard.tsx
 *   (`connectionDotClass`), RemoteOutputFolder.tsx (`dirname`), RemoteFileBrowser.tsx (its module-level
 *   constants). Ported elsewhere: WorkerJobs/WorkerQueue helpers + `endJobConfirm` (job-groups.js),
 *   timestamp.js, remote-browser.js. User-facing strings verbatim.
 *
 * LUCID changes:
 *  - `forgetWorkerWithConfirm` not ported: the UI shows `forgetWorkerConfirm` via `ui/ask.js` and calls the store's `forgetWorker`.
 *  - Dismissed-failed-runs storage is an argument (missing/throwing = empty/unsaved); key `lucid-connect-dismissed-failed-runs`.
 *  - `failedRunShown` is SidebarQueue's inline `showFailed` rule, pulled out for tests.
 *  - `readCodeInfo` imports `decodePairCode`/`isPairCode`/`parseTicketIroh` from the pose/connect ports.
 *  - `clientDisplayName`/`clientAgentLabel` name a device's client by its hello agent (sleap-app hardcodes `sleap-app <version>`).
 *  - Tailwind class strings kept verbatim; LUCID's CSS keys off `bucket` / the status.
 *
 * @typedef {import("./job-groups.js").JobSummary} JobSummary
 * @typedef {import("./remote-visibility.js").VideoVisibility} VideoVisibility
 * @typedef {{ title: string, message: string, confirmLabel: string, cancelLabel?: string, destructive?: boolean }} ConfirmRequest
 * @typedef {"idle" | "busy" | "offline"} WorkerStatusBucket
 * @typedef {{ bucket: WorkerStatusBucket, dotClass: string, label: string, identityMismatch: boolean, unpaired?: boolean }} WorkerStatusInfo
 */
import { WorkerProtocolError, PROTO_UNKNOWN_METHOD } from "./errors.js";
import { DEVICE_NAME_MAX } from "./device-name.js";
import { classifyVisibility } from "./remote-visibility.js";
import { modelRunTimestamp, timeAgo } from "./timestamp.js";
import { decodePairCode, isPairCode } from "./pair-code.js";
import { parseTicketIroh } from "./transport.js";

export { DEVICE_NAME_MAX };

// ── WorkerList.tsx ──────────────────────────────────────────────────

const IDENTITY_MISMATCH_MARKER = "identified itself as a different node";

/** One worker card's status; `unpaired` = the worker refused this device. @returns {WorkerStatusInfo} */
export function classifyWorkerStatus(connection, error, busy, unpaired = false) {
  if (unpaired || connection?.status === "unpaired") {
    return { bucket: "offline", dotClass: "bg-red-500", label: "Unpaired", identityMismatch: false, unpaired: true };
  }
  if (error?.includes(IDENTITY_MISMATCH_MARKER)) {
    return { bucket: "offline", dotClass: "bg-red-500", label: "has a new identity", identityMismatch: true };
  }
  switch (connection?.status) {
    case "connected":
      return busy
        ? { bucket: "busy", dotClass: "bg-orange-500", label: "Busy", identityMismatch: false }
        : { bucket: "idle", dotClass: "bg-green-500", label: "Idle", identityMismatch: false };
    case "reconnecting":
      return { bucket: "offline", dotClass: "bg-amber-500", label: "Reconnecting…", identityMismatch: false };
    case "connecting":
      return { bucket: "offline", dotClass: "bg-yellow-500", label: "Connecting…", identityMismatch: false };
    default:
      return { bucket: "offline", dotClass: "bg-zinc-500", label: "Offline", identityMismatch: false };
  }
}

/** `gpuModel · N GB ×count · CUDA x · sleap-nn y`, or null while unknown. */
export function workerSpecsLine(info) {
  if (!info) return null;
  const gb = info.gpuMemoryMb / 1024;
  const gbText = Number.isInteger(gb) ? gb.toFixed(0) : gb.toFixed(1);
  return `${info.gpuModel} · ${gbText} GB ×${info.gpuCount} · CUDA ${info.cudaVersion} · sleap-nn ${info.sleapNnVersion}`;
}

/** The worker list's filter chips, in order. @type {Array<{ key: "all" | WorkerStatusBucket, label: string }>} */
export const WORKER_FILTERS = [
  { key: "all", label: "All" },
  { key: "idle", label: "Idle" },
  { key: "busy", label: "Busy" },
  { key: "offline", label: "Offline" },
];

// ── WorkerDevices.tsx ───────────────────────────────────────────────

/** This device first, then most recently seen. */
export function sortDevices(devices) {
  return [...devices].sort((a, b) => {
    if (a.you !== b.you) return a.you ? -1 : 1;
    return (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "");
  });
}

export function describeError(err) {
  if (err instanceof WorkerProtocolError && err.code === PROTO_UNKNOWN_METHOD) {
    return "This worker's SLEAP Connect is too old to list devices — update it to see who has access.";
  }
  return `Couldn't load devices: ${err instanceof Error ? err.message : String(err)}`;
}

// ── RemoteDataSummary.tsx ───────────────────────────────────────────

/** Last path segment, `/` or `\`. */
export function basename(path) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Lowercased extension with dot, or undefined (scopes the Locate browser to the hidden video's kind). */
export function extOf(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : undefined;
}

/** Shared by the hidden-videos dialog and the data summary. @param {VideoVisibility[]} visibility */
export function describeVisibilityOutcome(visibility) {
  const kase = classifyVisibility(visibility);
  if (kase === "all") return "Training + inference on worker";
  if (kase === "none") return "Training only — videos not visible";
  const visibleCount = visibility.filter((v) => v.visible).length;
  return `Training on worker · inference on ${visibleCount} of ${visibility.length} videos`;
}

// ── MergePredictionsDialog.tsx ──────────────────────────────────────

/** A "mine" job whose predictions fully match the open project needs no dialog (design §6). */
export function shouldAutoMerge(mine, compat) {
  return mine && compat.skeletonOk && compat.total > 0 && compat.matchedCount === compat.total;
}

// ── forgetWorker.ts ─────────────────────────────────────────────────

/** Forget's confirm (it also unpairs this device on the worker). @returns {ConfirmRequest} */
export function forgetWorkerConfirm(worker) {
  if (worker.unpairedAt) {
    return {
      title: "Forget worker?",
      message: `Remove ${worker.label} from this app? It already unpaired this device.`,
      confirmLabel: "Forget",
      destructive: true,
    };
  }
  return {
    title: "Forget worker?",
    message:
      `${worker.label} is removed from this app, and this device is unpaired on the worker: ` +
      "to use it again you'll need a new code from 'sleap-connect pair'.\n\n" +
      "Jobs already on the worker keep running.",
    confirmLabel: "Forget worker",
    destructive: true,
  };
}

// ── SidebarQueue.tsx ────────────────────────────────────────────────

/** Where the dismissed failed runs are remembered (sleap-app: `sleap-app:connect-dismissed-failed-runs`). */
export const DISMISSED_FAILED_RUNS_KEY = "lucid-connect-dismissed-failed-runs";
/** How long a failed run of yours stays in the queue if you don't click it. */
export const FAILED_SHOWN_MS = 24 * 60 * 60 * 1000;
/** Poll interval of the queue and the Jobs tab. */
export const DEFAULT_POLL_MS = 10000;

export function loadDismissedFailedRuns(storage) {
  try {
    return new Set(JSON.parse(storage?.getItem(DISMISSED_FAILED_RUNS_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

export function saveDismissedFailedRuns(storage, keys) {
  try {
    storage?.setItem(DISMISSED_FAILED_RUNS_KEY, JSON.stringify([...keys]));
  } catch {
    // Not saved (e.g. private mode): it's still cleared until the window closes.
  }
}

/** SidebarQueue's `showFailed`: a run this project manages with a job failed less than a day ago. */
export function failedRunShown(group, manages, now = Date.now()) {
  return (
    manages &&
    group.jobs.some((j) => j.state === "failed" && now - new Date(j.updatedAt ?? j.createdAt).getTime() < FAILED_SHOWN_MS)
  );
}

// ── NewJobWizard.tsx ────────────────────────────────────────────────

/** Inference targets for a worker-file launch (no open project, so no current frame/video). */
export const WORKER_FILE_INFERENCE_TARGETS = [
  { value: "suggestions", label: "Suggested frames" },
  { value: "user_labeled", label: "User labeled frames" },
  { value: "predicted", label: "Frames with predictions" },
  { value: "all_videos", label: "All videos" },
  { value: "random", label: "Random sample (all videos)" },
];

/** A whole small worker text file via repeated `fs.read` calls (past the per-call cap). */
export async function readWholeWorkerFile(client, path) {
  const chunks = [];
  let offset = 0;
  for (;;) {
    const { content, eof } = await client.fsRead(path, offset);
    chunks.push(content);
    offset += content.length;
    if (eof || content.length === 0) break;
  }
  const total = new Uint8Array(offset);
  let pos = 0;
  for (const c of chunks) {
    total.set(c, pos);
    pos += c.length;
  }
  return new TextDecoder().decode(total);
}

/** Summary lines for videos found somewhere other than their recorded path. */
export function summarizeVideoCheck(check) {
  const countVia = (via) => check.filter((v) => v.via === via).length;
  const lines = [];
  const ruleCount = countVia("rule");
  if (ruleCount > 0) {
    lines.push(`${ruleCount} video${ruleCount === 1 ? "" : "s"} found via a remembered location`);
  }
  const nextToCount = countVia("next-to-labels");
  if (nextToCount > 0) {
    lines.push(`${nextToCount} video${nextToCount === 1 ? "" : "s"} found next to the labels file`);
  }
  return lines;
}

/**
 * @typedef {object} CompletedRun A training run on this worker whose EVERY sibling job has finished.
 * @property {string} runId
 * @property {string[]} jobIds
 * @property {string[]} modelTypes Each sibling's own head type, in `run.index` order.
 * @property {string} labelsPath
 * @property {string} createdAt
 * @property {string | null} timestamp Leading `YYMMDD_HHMMSS` of this run's model names, or null.
 */

/** A worker's train jobs as CompletedRuns: only runs whose every expected sibling is present and completed. */
export function groupCompletedRuns(jobs) {
  const byRun = new Map();
  for (const j of jobs) {
    if (j.kind !== "train") continue;
    const key = j.run?.id ?? j.jobId;
    byRun.set(key, [...(byRun.get(key) ?? []), j]);
  }
  const runs = [];
  for (const [runId, runJobs] of byRun.entries()) {
    const expectedCount = runJobs[0]?.run?.count ?? 1;
    if (runJobs.length < expectedCount) continue;
    if (!runJobs.every((j) => j.state === "completed")) continue;
    const sorted = [...runJobs].sort((a, b) => (a.run?.index ?? 0) - (b.run?.index ?? 0));
    const last = sorted[sorted.length - 1];
    runs.push({
      runId,
      jobIds: sorted.map((j) => j.jobId),
      modelTypes: sorted.map((j) => j.modelTypes[0] ?? "model"),
      labelsPath: sorted[0]?.labelsPath ?? "",
      createdAt: last.createdAt,
      timestamp: sorted.map((j) => modelRunTimestamp(j.modelName)).find((t) => t != null) ?? null,
    });
  }
  return runs;
}

/** Dropdown text per run: "(types) · timestamp" / "labels · age"; short run id appended to duplicates. */
export function labelPastRuns(runs) {
  const base = runs.map((run) => ({
    run,
    primary: `(${run.modelTypes.join(" + ")}) · ${run.timestamp ?? run.runId.slice(0, 8)}`,
    secondary: `${basename(run.labelsPath) || "—"} · ${timeAgo(run.createdAt)}`,
  }));
  const primaryCounts = new Map();
  for (const b of base) primaryCounts.set(b.primary, (primaryCounts.get(b.primary) ?? 0) + 1);
  return base.map((b) =>
    (primaryCounts.get(b.primary) ?? 0) > 1 ? { ...b, primary: `${b.primary} · ${b.run.runId.slice(0, 8)}` } : b,
  );
}

/** Bytes as megabytes, one decimal under 10 MB. */
export function formatMB(bytes) {
  const mb = bytes / 1e6;
  return mb < 10 ? mb.toFixed(1) : Math.round(mb).toString();
}

// ── PairWorkerForm.tsx ──────────────────────────────────────────────

/** What a pasted pairing code / legacy JSON ticket says about reaching the worker, or null. Never throws. */
export async function readCodeInfo(text) {
  const trimmed = text.trim();
  if (isPairCode(trimmed)) {
    try {
      const t = await decodePairCode(trimmed);
      return { expiresAt: t.expires_at, addrs: t.addrs, hasRelay: !!t.iroh };
    } catch {
      return null;
    }
  }
  try {
    const t = JSON.parse(trimmed);
    return {
      expiresAt: t.expires_at,
      addrs: t.addrs ?? [],
      hasRelay: !!parseTicketIroh(t.iroh)?.relayUrl,
    };
  } catch {
    return null;
  }
}

// ── JobViewerDialog.tsx / RemoteRunCard.tsx / RemoteOutputFolder.tsx ─

/** Job stream status -> the loss plot's training-status vocabulary. */
export function toTrainingStatus(status) {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "canceled":
      return "stopped";
    default:
      return "idle";
  }
}

export function connectionDotClass(status) {
  if (status === "connected") return "bg-green-500";
  if (status === "reconnecting") return "bg-amber-500";
  if (status === "connecting") return "bg-yellow-500";
  return "bg-zinc-500";
}

/** Parent folder of a worker path, `/` at the top. */
export function dirname(path) {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

// ── RemoteFileBrowser.tsx (module-level constants) ──────────────────

/** Remembered settings' key for the no-`workerId` (selected-worker) case. */
export const SELECTED_WORKER_KEY = "";

// ── Client naming (WorkerDevices.tsx, LUCID) ─────────────────────

/** A client's display name from its hello `agent.name`. */
export function clientDisplayName(name) {
  if (name === "lucid") return "LUC3D";
  if (name === "sleap-app") return "SLEAP";
  return name || "client";
}

/** `"<client> <version>"` for a device's reported agent. */
export function clientAgentLabel(agent) {
  const name = clientDisplayName(agent?.name);
  return agent?.version ? `${name} ${agent.version}` : name;
}
