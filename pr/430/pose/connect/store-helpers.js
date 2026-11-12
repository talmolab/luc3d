/**
 * Port of the pure (non-zustand, non-socket) helpers of sleap-app
 * src/stores/connectStore.ts @ 683a159.
 *
 * Everything the Connect store computes without touching state, the network or
 * storage: the unpaired message, tracked-job caps and run-ending selection,
 * persisted-state migration and the shared-slice readers, `withYamlRunName`,
 * link-status mapping and the paginated remote-directory walk. The store itself
 * (`store.js`) imports these.
 *
 * LUCID changes:
 *  - `capTrackedJobs` keeps completed, unfetched (`fetchedAt` unset), LUCID-tagged (`sessionId`/`camera`) jobs past
 *    the 50 cap (hard ceiling `MAX_HELD_TAGGED_JOBS` = 500, oldest evicted); untagged jobs behave as in sleap-app.
 *  - `toShared` drops corrupt records (a non-object, or one with no `nodeId` / `jobId`), where sleap-app keeps them:
 *    one in the store would make every later merge throw, and so every action that saves.
 *  - localStorage/sessionStorage keys are `lucid-connect` / `lucid-connect-selected`
 *    (sleap-app: `sleap-app-connect` / `sleap-app-connect-selected`).
 *  - Types are JSDoc. `withYamlRunName(spec, yamlLoad)` takes the YAML parser as a parameter
 *    (sleap-app imports `js-yaml`); pose/connect must not import `yaml` (Node tests, no CDN
 *    imports). The page passes `(s) => YAML.parse(s)`; `yamlLoad` may throw (the spec is then
 *    returned unchanged, as with a malformed config in sleap-app).
 *  - `hydraQuote` is imported from ./launcher-spec.js (sleap-app: platform/trainingArgs.ts).
 *  - Exported beyond sleap-app's own exports (they were module-private there, but the store
 *    port needs them): TERMINAL_JOB_STATES, MAX_TRACKED_JOBS, CONNECT_STORAGE_KEY,
 *    CONNECT_PERSIST_VERSION, SELECTED_WORKER_SESSION_KEY, FORGET_LEAVE_TIMEOUT_MS, upsertWorker,
 *    withTimeout, activeJobsFor, latestActiveJobFor, trackedJobLabel, isMultiModelTrainSpec,
 *    rememberedTransport, sharedSlice, toShared, readStoredShared, capShared, mapLinkStatus,
 *    fetchAllRemoteEntries. Bodies are verbatim.
 *  - NOT ported here (they close over the live store / transports / `irohTransportAvailable`):
 *    `pathRulesFor`, `resolvePreferredTransport`, `endCurrentRun`, `leaveWorker`, `applyShared`,
 *    `dropWorkerLocally`, `localStore`, `readSessionSelection`, `writeSessionSelection`.
 *
 * @typedef {import("./connect-sync.js?v=82449baaa3c2").SharedConnectState} SharedConnectState
 * @typedef {{ jobId: string, state: string, run?: { id: string, index?: number } } & Record<string, any>} JobSummary
 * @typedef {{ workerId: string, jobId: string, lastSeq: number, kind: "train" | "track", label: string,
 *   source: "window" | "worker-file", state: "active" | "completed" | "failed" | "canceled",
 *   error?: string, seen: boolean, submittedAt: number }} TrackedJob
 * @typedef {"disconnected" | "connecting" | "connected" | "reconnecting" | "error"} ConnectionStatus
 * @typedef {"ws" | "iroh"} TransportKind
 */
import { hydraQuote } from "./launcher-spec.js?v=82449baaa3c2";

// ── Constants ─────────────────────────────────────────────────────

export const TERMINAL_JOB_STATES = new Set(["completed", "failed", "canceled"]);

/** localStorage key the connect store persists under. */
export const CONNECT_STORAGE_KEY = "lucid-connect";
export const CONNECT_PERSIST_VERSION = 3;
/** sessionStorage key for this window's selected worker (`""` = none chosen). */
export const SELECTED_WORKER_SESSION_KEY = "lucid-connect-selected";

/** How long Forget waits to unpair this device on the worker before giving up. */
export const FORGET_LEAVE_TIMEOUT_MS = 5000;

export const MAX_TRACKED_JOBS = 50;
/** LUCID: hard ceiling on completed, unfetched, LUCID-tagged jobs `capTrackedJobs` keeps past the cap. */
export const MAX_HELD_TAGGED_JOBS = 500;

/** Shown wherever a worker refused this device as no longer paired. */
export const UNPAIRED_MESSAGE =
  "This device was unpaired by the worker. Pair again with a new code from 'sleap-connect pair'.";

// ── Workers ───────────────────────────────────────────────────────

/**
 * Adds or replaces a paired worker. Re-pairing a worker this device already
 * knows (e.g. after it was unpaired there) keeps its name and path rules,
 * and clears `unpairedAt` (`next` never carries one).
 *
 * @param {Array<Record<string, any>>} existing
 * @param {Record<string, any>} next
 */
export function upsertWorker(existing, next) {
  const old = existing.find((w) => w.nodeId === next.nodeId);
  const merged = old
    ? { ...next, label: old.label, pathRules: old.pathRules ?? next.pathRules }
    : next;
  return [...existing.filter((w) => w.nodeId !== next.nodeId), merged];
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * ws is the implicit default, so only a non-default choice is persisted on the worker.
 * @param {TransportKind} t
 * @returns {TransportKind | undefined}
 */
export function rememberedTransport(t) {
  return t === "iroh" ? "iroh" : undefined;
}

/**
 * @param {string} status a `LinkStatus` from the managed connection
 * @returns {ConnectionStatus}
 */
export function mapLinkStatus(status) {
  switch (status) {
    case "connected":
      return "connected";
    case "reconnecting":
    case "offline":
      return "reconnecting";
    case "connecting":
      return "connecting";
    case "stopped":
      return "disconnected";
    case "unpaired":
      return "error";
  }
}

// ── Remote directory listing ──────────────────────────────────────

/**
 * Fetches every entry in a directory, paginating via `fetchPage` (one
 * `fs.list(path, offset)` call) until `hasMore` is false (or a safety cap of
 * ~5000 entries is hit). Shared by `browseRemoteDir` (selected worker —
 * `fetchPage` re-checks `_client` on every page, exactly as it always did,
 * so a disconnect mid-pagination still fails the same way) and
 * `browseRemoteDirOn` (any paired worker, one `client` dialed via
 * `clientFor` up front) — the two differ only in how a page is fetched,
 * never in how the pages are walked.
 *
 * @param {(offset: number) => Promise<{ entries: Array<{ name: string, type: string, size?: number, modified?: any }>, hasMore: boolean }>} fetchPage
 * @param {number} [offset]
 * @param {number} [limit]
 * @returns {Promise<Array<{ name: string, isDir: boolean, size?: number, modified?: any }>>}
 */
export async function fetchAllRemoteEntries(fetchPage, offset = 0, limit = Infinity) {
  const allEntries = [];
  let currentOffset = offset;
  const MAX_PAGES = 200; // safety cap (200 pages * ~25 = ~5000 entries)

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(currentOffset);
    const entries = result.entries.map((e) => ({
      name: e.name,
      isDir: e.type === "directory",
      size: e.size,
      modified: e.modified,
    }));
    allEntries.push(...entries);
    if (!result.hasMore || entries.length === 0 || allEntries.length >= limit) break;
    currentOffset += entries.length;
  }

  return allEntries;
}

// ── Tracked jobs ──────────────────────────────────────────────────

/** @param {string} workerId @param {TrackedJob[]} jobs @returns {TrackedJob[]} */
export function activeJobsFor(workerId, jobs) {
  return jobs.filter((j) => j.workerId === workerId && j.state === "active");
}

/**
 * The most recently submitted still-active job on a worker, or `null`.
 * @param {string} workerId @param {TrackedJob[]} jobs @returns {TrackedJob | null}
 */
export function latestActiveJobFor(workerId, jobs) {
  const active = activeJobsFor(workerId, jobs);
  return active.length > 0 ? active[active.length - 1] : null;
}

/**
 * What the training panel's Stop Early / Cancel act on: run `runId` if
 * given (the panel's own run), else the run of the latest active tracked job.
 * A split multi-model run is N sequential jobs sharing
 * `run.id`, so `all` is every unfinished job in it (Cancel ends them all) and
 * `current` is the one in progress (Stop Early ends only that model, and the
 * next one still trains, like local training and SLEAP). Without the worker's
 * job list (`summaries` empty) both fall back to the latest job. Exported for
 * direct unit testing.
 *
 * @param {TrackedJob} latest
 * @param {TrackedJob[]} active
 * @param {JobSummary[]} summaries
 * @param {string} [wantedRunId]
 * @returns {{ all: string[], current: string }}
 */
export function runJobsToEnd(latest, active, summaries, wantedRunId) {
  const byId = new Map(summaries.map((s) => [s.jobId, s]));
  const runId = wantedRunId ?? byId.get(latest.jobId)?.run?.id;
  if (!runId) return { all: [latest.jobId], current: latest.jobId };
  const siblings = active
    .map((j) => byId.get(j.jobId))
    .filter(
      (s) =>
        s !== undefined &&
        s.run?.id === runId &&
        (s.state === "queued" || s.state === "running"),
    )
    .sort((a, b) => (a.run?.index ?? 0) - (b.run?.index ?? 0));
  if (siblings.length === 0) return { all: [latest.jobId], current: latest.jobId };
  const current = siblings.find((s) => s.state === "running") ?? siblings[0];
  return { all: siblings.map((s) => s.jobId), current: current.jobId };
}

/**
 * Caps the list at `MAX_TRACKED_JOBS`, oldest-first among non-active jobs
 * only — an active job is never evicted just to make room (if active jobs
 * alone exceed the cap, the list is left over-length rather than dropping
 * something still running). Exported for direct unit testing.
 *
 * @param {TrackedJob[]} jobs
 * @returns {TrackedJob[]}
 */
export function capTrackedJobs(jobs) {
  // LUCID: a LUCID-tagged job that completed and has not been fetched (`fetchedAt` unset) holds a
  // result nobody has loaded yet; it is never evicted by the 50 cap, only by the hard ceiling.
  const isHeld = (j) => (j.sessionId || j.camera) && j.state === "completed" && !j.fetchedAt;
  const dropIdx = new Set();
  const byAge = (list) => list.sort((a, b) => a.j.submittedAt - b.j.submittedAt);
  const held = byAge(jobs.map((j, i) => ({ j, i })).filter(({ j }) => isHeld(j)));
  for (let k = 0; k < held.length - MAX_HELD_TAGGED_JOBS; k++) dropIdx.add(held[k].i);

  let excess = jobs.length - dropIdx.size - MAX_TRACKED_JOBS;
  if (excess > 0) {
    for (const { i } of byAge(jobs.map((j, i) => ({ j, i })).filter(({ j, i }) => j.state !== "active" && !isHeld(j) && !dropIdx.has(i)))) {
      if (excess <= 0) break;
      dropIdx.add(i);
      excess--;
    }
  }
  return dropIdx.size === 0 ? jobs : jobs.filter((_, i) => !dropIdx.has(i));
}

/**
 * A tracked job's display label, derived from the spec that submitted it.
 * @param {{ type: string, model_types?: string[] }} spec
 */
export function trackedJobLabel(spec) {
  return spec.type === "track" ? "Inference" : `Train ${spec.model_types?.[0] ?? "model"}`;
}

// ── Persistence ───────────────────────────────────────────────────

/**
 * Migrates persisted state from before `trackedJobs` existed (v1, a single
 * `currentJob: {workerId, jobId} | null`) to v2's `TrackedJob[]`. Exported
 * for direct unit testing — the real `migrate` persist option below just
 * calls this.
 *
 * @param {unknown} persisted
 * @param {number} version
 * @returns {unknown}
 */
export function migrateConnectPersisted(persisted, version) {
  const p = { ...persisted };
  if (version < 2) {
    const cj = p.currentJob;
    p.trackedJobs = cj
      ? [
          {
            ...cj,
            lastSeq: 0,
            kind: "train",
            label: "Remote job",
            source: "window",
            state: "active",
            seen: false,
            submittedAt: Date.now(),
          },
        ]
      : [];
    delete p.currentJob;
  }
  if (version < 3) {
    // The selection became per window; the shared copy only remembers the last one.
    p.lastSelectedWorkerId = p.selectedWorkerId ?? null;
    delete p.selectedWorkerId;
  }
  return p;
}

/**
 * The shared slice of a store state.
 * @param {SharedConnectState} state any object carrying the four shared fields
 * @returns {SharedConnectState}
 */
export function sharedSlice(state) {
  return {
    pairedWorkers: state.pairedWorkers,
    trackedJobs: state.trackedJobs,
    deviceName: state.deviceName,
    lastSelectedWorkerId: state.lastSelectedWorkerId,
  };
}

/**
 * A persisted state's shared fields, or `null` if it isn't shaped like one.
 * @param {unknown} state
 * @returns {SharedConnectState | null}
 */
export function toShared(state) {
  const p = state;
  if (!p || !Array.isArray(p.pairedWorkers) || !Array.isArray(p.trackedJobs)) return null;
  // LUCID: a corrupt entry (null, a number, no id) is dropped here — one in the store would make
  // every later merge throw, and so every action that saves.
  const isRec = (r, key) => !!r && typeof r === "object" && typeof r[key] === "string" && r[key] !== "";
  return {
    pairedWorkers: p.pairedWorkers.filter((w) => isRec(w, "nodeId")),
    trackedJobs: p.trackedJobs.filter((j) => isRec(j, "jobId")),
    deviceName: typeof p.deviceName === "string" ? p.deviceName : null,
    lastSelectedWorkerId: typeof p.lastSelectedWorkerId === "string" ? p.lastSelectedWorkerId : null,
  };
}

/**
 * Parses a raw stored value (any version) into the current shared shape.
 * @param {string | null} raw
 * @returns {SharedConnectState | null}
 */
export function readStoredShared(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const version = parsed.version ?? 0;
    const state =
      version < CONNECT_PERSIST_VERSION ? migrateConnectPersisted(parsed.state, version) : parsed.state;
    return toShared(state);
  } catch {
    return null;
  }
}

/** @param {SharedConnectState} s @returns {SharedConnectState} */
export function capShared(s) {
  return { ...s, trackedJobs: capTrackedJobs(s.trackedJobs) };
}

// ── Job specs ─────────────────────────────────────────────────────

/**
 * Whether a spec is a train spec with more than one config (split into one job per model on submit).
 * @param {{ type: string, config_contents?: string[] }} spec
 */
export function isMultiModelTrainSpec(spec) {
  return (
    spec.type === "train" &&
    Array.isArray(spec.config_contents) &&
    spec.config_contents.length > 1
  );
}

/**
 * Copies a single-config train job's YAML `trainer_config.run_name` onto the
 * spec's `run_name`. Without it the worker falls back to the model type and
 * passes `trainer_config.run_name=<model_type>` on the sleap-nn command line,
 * which overrides the YAML and drops the `<ts>.<model>.n=<N>` name this app
 * resolved (sleap-connect `jobs/builder.py`'s `build_train_command`). The
 * worker interpolates the value unquoted, so it's sent Hydra-quoted — the `=`
 * in `n=<N>` is otherwise an override parse error — the same quoting local
 * training applies (`trainingArgs.ts`). Applied to each job as it's sent, so
 * it holds after a multi-model spec is split. An explicit `run_name` is never
 * overridden.
 *
 * LUCID: `yamlLoad` is the YAML parser (injected; see the header).
 *
 * @template {Record<string, any>} S
 * @param {S} spec
 * @param {(text: string) => any} yamlLoad
 * @returns {S}
 */
export function withYamlRunName(spec, yamlLoad) {
  if (spec.type !== "train" || spec.run_name || spec.config_contents?.length !== 1) return spec;
  try {
    const parsed = yamlLoad(spec.config_contents[0]);
    const runName = parsed?.trainer_config?.run_name;
    return typeof runName === "string" && runName ? { ...spec, run_name: hydraQuote(runName) } : spec;
  } catch {
    return spec;
  }
}
