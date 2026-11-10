/**
 * Port of the pure (non-React) helpers of sleap-app's Connect UI @ 683a159:
 *   WorkerList.tsx (`classifyWorkerStatus`, `workerSpecsLine`), WorkerDevices.tsx (`sortDevices`,
 *   `describeError`), RemoteDataSummary.tsx (`describeVisibilityOutcome`), MergePredictionsDialog.tsx
 *   (`shouldAutoMerge`), forgetWorker.ts (`forgetWorkerConfirm`), SidebarQueue.tsx (`FAILED_SHOWN_MS`,
 *   dismissed-failed-runs storage), NewJobWizard.tsx (`WORKER_FILE_INFERENCE_TARGETS`,
 *   `summarizeVideoCheck`, `groupCompletedRuns`, `labelPastRuns`, `formatMB`, `readWholeWorkerFile`),
 *   PairWorkerForm.tsx (`readCodeInfo`), JobViewerDialog.tsx (`toTrainingStatus`), RemoteRunCard.tsx
 *   (`connectionDotClass`), RemoteOutputFolder.tsx (`dirname`), RemoteFileBrowser.tsx (its module-level
 *   constants). Already ported elsewhere and not repeated here: the WorkerJobs / WorkerQueue helpers and
 *   `endJobConfirm` (`./job-groups.js`), `timeAgo` / `modelRunTimestamp` (`./timestamp.js`), the browser's
 *   path/sort/filter helpers (`./remote-browser.js`). `ConnectPanel.tsx`, `ConnectDialog.tsx`,
 *   `WorkerDataAccess.tsx`, `HiddenVideosDialog.tsx` and `RemoteRunCard.tsx` have no other pure logic.
 *
 * Every user-facing string is verbatim.
 *
 * LUCID changes:
 *  - `forgetWorkerConfirm` returns the same `ConfirmRequest` object; `forgetWorkerWithConfirm` (it reads
 *    the zustand store and `confirmStore`) is not ported: the UI feeds the request to `ui/ask.js` and
 *    calls the Connect store's `forgetWorker` itself.
 *  - The dismissed-failed-runs list takes its storage as an argument (`loadDismissedFailedRuns(storage)` /
 *    `saveDismissedFailedRuns(storage, keys)`; a missing or throwing storage is treated as empty / unsaved,
 *    as sleap-app's try/catch did). The key is `lucid-connect-dismissed-failed-runs` (sleap-app:
 *    `sleap-app:connect-dismissed-failed-runs`), a separate namespace so the two apps never read each
 *    other's list on the same origin.
 *  - `failedRunShown(group, manages, now)` is SidebarQueue's inline `showFailed` rule pulled out so it can
 *    be tested: a failed job of a run this project manages, updated less than `FAILED_SHOWN_MS` ago.
 *  - `readCodeInfo` takes `decodePairCode`/`isPairCode`/`parseTicketIroh` from the pose/connect ports
 *    (same behavior; `parseTicketIroh` and `decodePairCode` are imported, not injected).
 *  - `clientDisplayName(agentName)` / `clientAgentLabel(agent)` name a device's client by its reported hello agent
 *    (`lucid` -> "LUC3D", `sleap-app` -> "SLEAP"); sleap-app's devices list hardcodes `sleap-app <version>`.
 *  - Tailwind class strings (`connectionDotClass`, `classifyWorkerStatus.dotClass`) are kept verbatim;
 *    the LUCID UI keys its own CSS off `bucket` / the status instead.
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

/**
 * Pure classification of one worker's card status.
 * @param {{ status: string, route: string } | undefined} connection
 * @param {string | null | undefined} error
 * @param {boolean | undefined} busy
 * @param {boolean} [unpaired] The worker refused this device as no longer paired.
 * @returns {WorkerStatusInfo}
 */
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

/**
 * `gpuModel · N GB ×count · CUDA x · sleap-nn y`, or `null` while unknown (not yet refreshed).
 * @param {{ gpuModel: string, gpuMemoryMb: number, gpuCount: number, cudaVersion: string, sleapNnVersion: string } | undefined} info
 * @returns {string | null}
 */
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

/**
 * This device first, then most recently seen.
 * @param {Array<{ you?: boolean, lastSeenAt?: string } & Record<string, any>>} devices
 */
export function sortDevices(devices) {
  return [...devices].sort((a, b) => {
    if (a.you !== b.you) return a.you ? -1 : 1;
    return (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "");
  });
}

/** @param {unknown} err */
export function describeError(err) {
  if (err instanceof WorkerProtocolError && err.code === PROTO_UNKNOWN_METHOD) {
    return "This worker's SLEAP Connect is too old to list devices — update it to see who has access.";
  }
  return `Couldn't load devices: ${err instanceof Error ? err.message : String(err)}`;
}

// ── RemoteDataSummary.tsx ───────────────────────────────────────────

/** Last path segment, `/` or `\`. @param {string} path */
export function basename(path) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * File extension (with dot), lowercased, or `undefined` if none — scopes the Locate file browser to the
 * same kind of file as the hidden video.
 * @param {string} path
 */
export function extOf(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : undefined;
}

/** Debounce of the data summary's visibility check, and how many hidden videos it names. */
export const DEFAULT_DEBOUNCE_MS = 300;
export const MAX_HIDDEN_SHOWN = 3;

/**
 * Shared by the hidden-videos dialog and the data summary so both describe coverage identically.
 * @param {VideoVisibility[]} visibility
 */
export function describeVisibilityOutcome(visibility) {
  const kase = classifyVisibility(visibility);
  if (kase === "all") return "Training + inference on worker";
  if (kase === "none") return "Training only — videos not visible";
  const visibleCount = visibility.filter((v) => v.visible).length;
  return `Training on worker · inference on ${visibleCount} of ${visibility.length} videos`;
}

// ── MergePredictionsDialog.tsx ──────────────────────────────────────

/**
 * A "mine" job whose predictions fully match the open project needs no dialog at all (design §6).
 * @param {boolean} mine
 * @param {{ skeletonOk: boolean, total: number, matchedCount: number }} compat
 */
export function shouldAutoMerge(mine, compat) {
  return mine && compat.skeletonOk && compat.total > 0 && compat.matchedCount === compat.total;
}

// ── forgetWorker.ts ─────────────────────────────────────────────────

/**
 * The confirm dialog for Forget. Forgetting also unpairs this device on the worker, so getting back in
 * takes a new pairing code. A worker that already unpaired this device only needs removing locally.
 * @param {{ label: string, unpairedAt?: string }} worker
 * @returns {ConfirmRequest}
 */
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

/**
 * @param {{ getItem(k: string): string | null } | null | undefined} storage
 * @returns {Set<string>}
 */
export function loadDismissedFailedRuns(storage) {
  try {
    return new Set(JSON.parse(storage?.getItem(DISMISSED_FAILED_RUNS_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/**
 * @param {{ setItem(k: string, v: string): void } | null | undefined} storage
 * @param {Set<string>} keys
 */
export function saveDismissedFailedRuns(storage, keys) {
  try {
    storage?.setItem(DISMISSED_FAILED_RUNS_KEY, JSON.stringify([...keys]));
  } catch {
    // Not saved (e.g. private mode): it's still cleared until the window closes.
  }
}

/**
 * SidebarQueue's `showFailed` rule: a run this project manages that has a job failed less than a day ago.
 * @param {{ jobs: JobSummary[] }} group
 * @param {boolean} manages Whether this project manages the group (`isManagedJob` on any job).
 * @param {number} [now]
 */
export function failedRunShown(group, manages, now = Date.now()) {
  return (
    manages &&
    group.jobs.some((j) => j.state === "failed" && now - new Date(j.updatedAt ?? j.createdAt).getTime() < FAILED_SHOWN_MS)
  );
}

// ── NewJobWizard.tsx ────────────────────────────────────────────────

/**
 * Post-training inference targets valid for a worker-file launch — there's no open project, so no
 * "current frame"/"current video".
 * @type {{ value: string, label: string }[]}
 */
export const WORKER_FILE_INFERENCE_TARGETS = [
  { value: "suggestions", label: "Suggested frames" },
  { value: "user_labeled", label: "User labeled frames" },
  { value: "predicted", label: "Frames with predictions" },
  { value: "all_videos", label: "All videos" },
  { value: "random", label: "Random sample (all videos)" },
];

/**
 * Reads a whole small worker-side text file (a YAML config) via repeated `fs.read` calls — unbounded by
 * the worker's per-call cap, unlike a single `fsRead`.
 * @param {{ fsRead(path: string, offset: number): Promise<{ content: Uint8Array, eof: boolean }> }} client
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function readWholeWorkerFile(client, path) {
  /** @type {Uint8Array[]} */
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

/**
 * Per-video resolution summary lines for videos that needed something other than their recorded path.
 * A video found at its exact recorded path, or embedded, says nothing.
 * @param {Array<{ via?: string }>} check
 * @returns {string[]}
 */
export function summarizeVideoCheck(check) {
  const countVia = (/** @type {string} */ via) => check.filter((v) => v.via === via).length;
  /** @type {string[]} */
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

/**
 * Groups `jobs` (a worker's full `listJobs` result) into {@link CompletedRun}s. A job without `run` is its
 * own one-job run (`run.count` defaults to 1). A run is included only once EVERY sibling `run.count`
 * expects is present in `jobs` AND `completed`.
 * @param {JobSummary[]} jobs
 * @returns {CompletedRun[]}
 */
export function groupCompletedRuns(jobs) {
  /** @type {Map<string, JobSummary[]>} */
  const byRun = new Map();
  for (const j of jobs) {
    if (j.kind !== "train") continue;
    const key = j.run?.id ?? j.jobId;
    byRun.set(key, [...(byRun.get(key) ?? []), j]);
  }
  /** @type {CompletedRun[]} */
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

/**
 * Dropdown entry text for each {@link CompletedRun}: primary "(<types joined with ' + '>) · <timestamp>"
 * (falling back to the run's short id), secondary "<labels basename> · <age>". Appends the short run id to
 * the primary line when two entries would otherwise read identically.
 * @param {CompletedRun[]} runs
 * @returns {Array<{ run: CompletedRun, primary: string, secondary: string }>}
 */
export function labelPastRuns(runs) {
  const base = runs.map((run) => ({
    run,
    primary: `(${run.modelTypes.join(" + ")}) · ${run.timestamp ?? run.runId.slice(0, 8)}`,
    secondary: `${basename(run.labelsPath) || "—"} · ${timeAgo(run.createdAt)}`,
  }));
  /** @type {Map<string, number>} */
  const primaryCounts = new Map();
  for (const b of base) primaryCounts.set(b.primary, (primaryCounts.get(b.primary) ?? 0) + 1);
  return base.map((b) =>
    (primaryCounts.get(b.primary) ?? 0) > 1 ? { ...b, primary: `${b.primary} · ${b.run.runId.slice(0, 8)}` } : b,
  );
}

/**
 * Bytes as megabytes, one decimal under 10 MB.
 * @param {number} bytes
 */
export function formatMB(bytes) {
  const mb = bytes / 1e6;
  return mb < 10 ? mb.toFixed(1) : Math.round(mb).toString();
}

// ── PairWorkerForm.tsx ──────────────────────────────────────────────

/**
 * What pasted text says about reaching the worker — a one-line pairing code or a legacy JSON ticket — or
 * null if it's neither. Never throws on partial input; validating the ticket for real is the pairing
 * call's job once Pair is clicked.
 * @param {string} text
 * @returns {Promise<{ expiresAt?: number, addrs: string[], hasRelay: boolean } | null>}
 */
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

/**
 * Maps the job stream's worker-facing status onto the loss plot's training-status vocabulary.
 * @param {import("./job-stream.js").JobStreamStatus} status
 * @returns {"running" | "completed" | "error" | "stopped" | "idle"}
 */
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

/** @param {string} status A link status ("connected" | "reconnecting" | "connecting" | ...). */
export function connectionDotClass(status) {
  if (status === "connected") return "bg-green-500";
  if (status === "reconnecting") return "bg-amber-500";
  if (status === "connecting") return "bg-yellow-500";
  return "bg-zinc-500";
}

/**
 * Parent folder of a worker path, `/` at the top.
 * @param {string} path
 */
export function dirname(path) {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

// ── RemoteFileBrowser.tsx (module-level constants) ──────────────────

/** Remembered settings' key for the no-`workerId` (selected-worker) case. */
export const SELECTED_WORKER_KEY = "";
export const DEFAULT_BROWSER_SIZE = { width: 900, height: 600 };
/** Entries fetched per batch; big folders load more on scroll. */
export const BROWSER_BATCH = 100;
export const DEFAULT_COLUMN_WIDTH = 224;

// ── Client naming (WorkerDevices.tsx, LUCID) ─────────────────────

/**
 * The display name of a client from its hello `agent.name`.
 * @param {string | undefined | null} name
 */
export function clientDisplayName(name) {
  if (name === "lucid") return "LUC3D";
  if (name === "sleap-app") return "SLEAP";
  return name || "client";
}

/**
 * `"<client> <version>"` for a device's reported agent (sleap-app wrote `sleap-app ${appVersion}`).
 * @param {{ name?: string, version?: string } | undefined | null} agent
 */
export function clientAgentLabel(agent) {
  const name = clientDisplayName(agent?.name);
  return agent?.version ? `${name} ${agent.version}` : name;
}
