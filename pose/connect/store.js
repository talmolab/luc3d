/**
 * Port of sleap-app src/stores/connectStore.ts @ 683a159.
 *
 * Paired workers (persisted, keyed by `node_id`), one `ManagedConnection` per worker that is selected
 * or has an active tracked job, tracked jobs (a reload resumes them), shared across windows through
 * localStorage with a three-way merge (`connect-sync.js`, #453). Same names, error strings, timeouts
 * and control flow as connectStore; pure helpers live in `store-helpers.js` and are re-exported.
 * Training pieces (multi-model split — the worker runs only `config_contents[0]` —, `withYamlRunName`,
 * `onModelComplete`/`onTelemetry`, `run.stage`) are ported and inert.
 *
 * LUCID changes:
 *  - zustand -> `./mini-store.js`; `useConnectStore` is a module singleton (not a hook), `connectStore` an alias.
 *  - Per-runtime pieces are injected deps (`configureConnect(patch)`, defaults in `defaultDeps`, resolved at use).
 *  - A multi-view run (`opts.run.count > 1`, one job per view) toasts once, when its last job ends (`runSummary`).
 *  - iroh is "available" exactly when `transport.js` has a registered socket factory.
 *  - `deps.notify` = `{success, error, info}(message, {description?, action?})`, same strings as sleap-app's toast; default no-op.
 *  - The cross-window `storage` listener is wired by the UI (`installConnectStorageSync(window)`).
 *  - `persist` hydrates at creation; after `configureConnect({localStorage})` call `persist.rehydrate()`.
 *  - Storage keys `lucid-connect` / `lucid-connect-selected`; hello agent name `"lucid"`.
 *  - Jobs may carry `{sessionId, camera, projectTag, mergeMode}` (one job per (session, camera)); absent when not given.
 *  - `fetchResultBlob(ref, options)` forwards `{fsFallback}` to `WorkerClient.fetchBlob`.
 *  - `submitJobsOn(workerId, spec, {run?, label?})`, `fetchResultBlobOn`, `markJobFetched` (unfetched tagged jobs survive `capTrackedJobs`).
 *  - `watchTrackedJob` persists `lastSeq` at most every 2 s; a state change persists at once.
 *  - `planPairingForText` (non-throwing, for the form's status line); `readCodeInfo` re-exported from worker-ui-helpers.
 *  - The selection subscription is installed at creation, so a later `rehydrate()` writes the selection to sessionStorage.
 *  - Added `pairWithCode`, `agentInfo`, `configureConnect`, `installConnectStorageSync`, `__resetConnectState`.
 */
import { createStore, persist } from "./mini-store.js";
import { mergeShared, sameShared } from "./connect-sync.js";
import { WorkerClient as DefaultWorkerClient } from "./client.js";
import { getClientIdentity as defaultGetClientIdentity } from "./identity.js";
import { defaultDeviceName, normalizeDeviceName } from "./device-name.js";
import { parseJobTelemetry } from "./job-telemetry.js";
import { ManagedConnection, isUnpairedError } from "./managed-connection.js";
import { WorkerProtocolError, FS_NOT_FOUND, FS_FORBIDDEN, AUTH_UNTRUSTED, CLIENT_CLOSED } from "./errors.js";
import { decodePairCode, isPairCode, PairCodeError } from "./pair-code.js";
import { readCodeInfo } from "./worker-ui-helpers.js";
import { NOT_A_CODE, planPairing } from "./pairing-plan.js";
import { loadSavedMappings } from "./path-mappings.js";
import {
  getIrohSocketFactory,
  irohTransportAvailable,
  getIrohBlobFetcher,
  parseTicketIroh,
  toIrohDialTarget,
  encodeIrohDialUrl,
  transportLabel,
} from "./transport.js";
import {
  TERMINAL_JOB_STATES,
  CONNECT_STORAGE_KEY,
  CONNECT_PERSIST_VERSION,
  SELECTED_WORKER_SESSION_KEY,
  FORGET_LEAVE_TIMEOUT_MS,
  UNPAIRED_MESSAGE,
  upsertWorker,
  withTimeout,
  fetchAllRemoteEntries,
  activeJobsFor,
  latestActiveJobFor,
  runJobsToEnd,
  capTrackedJobs,
  trackedJobLabel,
  migrateConnectPersisted,
  isMultiModelTrainSpec,
  withYamlRunName,
  rememberedTransport,
  mapLinkStatus,
  sharedSlice,
  toShared,
  readStoredShared,
  capShared,
} from "./store-helpers.js";

export {
  TERMINAL_JOB_STATES,
  CONNECT_STORAGE_KEY,
  CONNECT_PERSIST_VERSION,
  SELECTED_WORKER_SESSION_KEY,
  UNPAIRED_MESSAGE,
  capTrackedJobs,
  migrateConnectPersisted,
  runJobsToEnd,
  withYamlRunName,
};

/** @typedef {import("./client.js").WorkerClient} WorkerClient */
/** @typedef {import("./client.js").WorkerEvent} WorkerEvent */
/** @typedef {import("./transport.js").TransportKind} TransportKind */
/** @typedef {import("./transport.js").IrohEndpointInfo} IrohEndpointInfo */
/** @typedef {import("./path-mappings.js").PathMapping} PathMapping */
/** @typedef {import("./connect-sync.js").SharedConnectState} SharedConnectState */
/** @typedef {import("./store-helpers.js").ConnectionStatus} ConnectionStatus */

/**
 * A worker this device has paired with — persisted, Syncthing/Plex-style.
 * @typedef {object} PairedWorker
 * @property {string} nodeId
 * @property {string} label
 * @property {string[]} addrs
 * @property {string} pairedAt
 * @property {IrohEndpointInfo} [iroh] Direct-connect (iroh) reachability from the pairing ticket, if it had any.
 * @property {TransportKind} [transport] The transport last connected over, reused by one-click reconnects. Absent = "ws".
 * @property {PathMapping[]} [pathRules] Per-worker local<->worker path rules. `undefined` = never imported yet; once set (even `[]`) never re-imported.
 * @property {string} [unpairedAt] When the worker refused this device as no longer paired; set = nothing dials it automatically. Cleared by re-pairing.
 * @property {Record<string, string>} [outputDirs] Folders picked for runs' outputs on this worker, keyed by project (`projectTag(...).id`).
 */

/**
 * A worker's pairing ticket (spec §3.2).
 * @typedef {object} PairingTicket
 * @property {string} node_id
 * @property {string[]} addrs
 * @property {string} secret
 * @property {number} [expires_at] Unix seconds — only checked for expiry on the pairing-code path.
 * @property {unknown} [iroh]
 */

/**
 * A remote job this device is tracking against a specific paired worker.
 * LUCID adds the optional `sessionId` / `camera` / `projectTag`.
 * @typedef {object} TrackedJob
 * @property {string} workerId
 * @property {string} jobId
 * @property {number} lastSeq Highest event `seq` already applied.
 * @property {"train" | "track"} kind
 * @property {string} label
 * @property {"window" | "worker-file"} source
 * @property {"active" | "completed" | "failed" | "canceled"} state
 * @property {string} [error]
 * @property {boolean} seen
 * @property {number} submittedAt
 * @property {string} [sessionId] LUCID: the session the job's video belongs to.
 * @property {string} [camera] LUCID: the camera/view the job ran on.
 * @property {string} [projectTag] LUCID: `projectTag(...).id` of the project that submitted it.
 * @property {string} [mergeMode] LUCID: the Inference panel's "Existing predictions" mode at submit, used at Fetch & Load.
 * @property {number | null} [fetchedAt] LUCID: when the result was fetched (`markJobFetched`); null on a tagged job until then.
 */

/** @typedef {{ jobId: string, state: string }} ReattachableJob */

/** `isProgress` = replace the previous progress line. @typedef {(line: string, isProgress?: boolean) => void} JobLogHandler */

/**
 * @typedef {object} SubmitJobOptions
 * @property {(result: any) => void} [onModelComplete]
 * @property {(telemetry: any, jobIndex: number) => void} [onTelemetry]
 * @property {{ id: string, stage?: "inference" }} [run]
 * @property {string} [sessionId] LUCID
 * @property {string} [camera] LUCID
 * @property {string} [projectTag] LUCID
 */

/** @typedef {{ transport?: TransportKind }} ConnectOptions */

/** `statWorkerPath`'s answer. @typedef {{ exists: boolean, type?: "file" | "directory", shared?: boolean, forbidden?: boolean }} WorkerPathStat */

// ── Injected dependencies ─────────────────────────────────────────

/** @typedef {{ description?: string, action?: { label: string, onClick: () => void } }} NotifyOptions */
/** @typedef {{ success: (m: string, o?: NotifyOptions) => void, error: (m: string, o?: NotifyOptions) => void, info: (m: string, o?: NotifyOptions) => void }} Notifier */

const NOOP_NOTIFY = Object.freeze({ success() {}, error() {}, info() {} });

function defaultDeps() {
  return {
    WorkerClient: DefaultWorkerClient,
    getClientIdentity: defaultGetClientIdentity,
    localStorage: undefined, // undefined = the global, looked up at call time; null = none
    sessionStorage: undefined,
    notify: NOOP_NOTIFY,
    openConnectWindow: null, // the toast's "Open" (sleap-app: setConnectWindowOpen(true))
    appVersion: "dev",
    platform: "web", // "tauri" | "web", for the hello agent
    computerName: null, // () => Promise<string|null>; none = "<Browser> on <OS>"
    userAgent: undefined,
    pathMappingsStorage: null, // config.toml adapter for the one-time legacy path-rule import
    yamlLoad: null, // parser for withYamlRunName; none = specs unchanged
    randomUUID: () => globalThis.crypto.randomUUID(),
  };
}

let deps = defaultDeps();

/** Merges into the injected deps; `configureConnect(null)` restores every default. */
export function configureConnect(patch) {
  deps = patch === null ? defaultDeps() : { ...deps, ...patch };
}

/** The hello `agent` this app reports (the device name is added per connection). */
export function agentInfo() {
  return { name: "lucid", version: deps.appVersion, platform: deps.platform };
}

// ── Helpers that close over the store / transports / storage ──────

/** One `ManagedConnection` per worker that's selected or has an active tracked job. */
const managed = new Map();

/** `clientFor`'s in-flight initial dials, so concurrent calls for one worker share a single `start()`. */
const clientForStarts = new Map();

let managedDeps = {};

/** Test-only: a fake clock for every `ManagedConnection` created from here on. */
export function __setManagedDeps(next) {
  managedDeps = next;
}

/** Test-only: stops and drops every managed connection. */
export function __resetManagedConnections() {
  for (const mc of managed.values()) mc.stop();
  managed.clear();
  clientForStarts.clear();
}

/** Test-only (LUCID): also resets subscriptions, notified ids, device name cache, merge base, deps, clock. */
export function __resetConnectState() {
  __resetManagedConnections();
  activeSubscriptions.clear();
  notifiedJobIds.clear();
  _defaultDeviceName = null;
  sharedBase = null;
  managedDeps = {};
  deps = defaultDeps();
}

function localStore() {
  try {
    if (deps.localStorage !== undefined) return deps.localStorage;
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function sessionStore() {
  try {
    if (deps.sessionStorage !== undefined) return deps.sessionStorage;
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** This window's saved selection: an id, null = deliberately none, undefined = never chosen here. */
function readSessionSelection() {
  try {
    const v = sessionStore()?.getItem(SELECTED_WORKER_SESSION_KEY);
    return v === null || v === undefined ? undefined : v || null;
  } catch {
    return undefined;
  }
}

function writeSessionSelection(id) {
  try {
    sessionStore()?.setItem(SELECTED_WORKER_SESSION_KEY, id ?? "");
  } catch {
    // No sessionStorage: the selection just won't survive a reload.
  }
}

/** A paired worker's path rules (Locate-on-worker overrides + the one-time legacy import), or `[]` if unknown/unset. */
export function pathRulesFor(workerId) {
  if (!workerId) return [];
  return useConnectStore.getState().pairedWorkers.find((w) => w.nodeId === workerId)?.pathRules ?? [];
}

/** LUCID: the tag fields a job entry carries, taken from submit options (only those given). */
function jobTag(o) {
  const tag = {};
  if (o?.sessionId !== undefined) tag.sessionId = o.sessionId;
  if (o?.camera !== undefined) tag.camera = o.camera;
  if (o?.projectTag !== undefined) tag.projectTag = o.projectTag;
  // The panel's "Existing predictions" mode at Run, used at Fetch & Load (sleap-app `pendingRemoteMerge.mode`).
  if (o?.mergeMode !== undefined) tag.mergeMode = o.mergeMode;
  // LUCID: a multi-view run (one job per view) toasts once, when its last job ends (`notifyJobFinished`).
  if (o?.run && o.run.count > 1) { tag.runId = o.run.id; tag.runCount = o.run.count; }
  // Null until `markJobFetched` records that the result was loaded (see `capTrackedJobs`).
  if (tag.sessionId !== undefined || tag.camera !== undefined) tag.fetchedAt = null;
  return tag;
}

/** Explicit if given, else the worker's remembered preference (never a route reached only by fallback). */
function resolvePreferredTransport(worker, options) {
  return (
    options?.transport ??
    (worker.transport === "iroh" && worker.iroh && irohTransportAvailable() ? "iroh" : "ws")
  );
}

const IROH_DESKTOP_ONLY =
  "Connecting over the internet needs the desktop app — in the browser, use the worker's network address.";

/** `url` is a ws address, or the encoded iroh target. @typedef {{ transport: TransportKind, url: string, display: string }} DialSpec */

/**
 * LUCID (P8): a result blob over the registered iroh blob fetcher; without one, sleap-app's refusal.
 * Progress from `options.onProgress ?? options.fsFallback.onProgress`; no `fs.read` fallback here.
 */
async function fetchOverIroh(client, ref, options) {
  const fetcher = getIrohBlobFetcher();
  const connId = client?.irohConnectionId;
  if (connId === null || connId === undefined) throw new Error("Not connected to a worker");
  if (!fetcher) {
    throw new Error(
      `Result files can't be downloaded over an ${transportLabel("iroh")} connection here — ` +
        "reconnect over the worker's network address to fetch them.",
    );
  }
  return fetcher(connId, ref, { onProgress: options?.onProgress ?? options?.fsFallback?.onProgress });
}

async function irohDial(info, nodeId) {
  if (!irohTransportAvailable()) throw new Error(IROH_DESKTOP_ONLY);
  if (!info) {
    throw new Error(
      "This worker's code has no internet connection info — run sleap-connect pair again while it's running, or use its network address.",
    );
  }
  const target = toIrohDialTarget(info, nodeId);
  return {
    transport: "iroh",
    url: encodeIrohDialUrl(target),
    display: `iroh endpoint ${target.nodeId.slice(0, 8)}…`,
  };
}

let _defaultDeviceName = null;

/** This device's name for workers: the user's choice, else the OS/browser default (looked up once). */
export async function resolveDeviceName() {
  const chosen = useConnectStore.getState().deviceName;
  if (chosen) return chosen;
  _defaultDeviceName ??= defaultDeviceName({ computerName: deps.computerName, userAgent: deps.userAgent });
  return _defaultDeviceName;
}

/** `clients.rename` on every worker this tab/window is connected to (best effort). */
async function pushDeviceNameToConnected(name) {
  await Promise.all(
    [...managed.values()].map(async (mc) => {
      const client = mc.client;
      if (!client?.authenticated) return;
      try {
        await client.clientsRename(name);
      } catch (err) {
        // An older worker without clients.rename still learns it on the next hello.
        console.warn("[connect] clients.rename failed:", err);
      }
    }),
  );
}

/** @param {DialSpec} dial @returns {Promise<WorkerClient>} */
async function makeClient(dial) {
  const identity = await deps.getClientIdentity();
  const ClientCtor = deps.WorkerClient;
  // Sent in every hello, so a reconnect always carries the current name.
  const agent = { ...agentInfo(), device_name: await resolveDeviceName() };
  if (dial.transport === "iroh") {
    return new ClientCtor({
      url: dial.url,
      identity,
      agent,
      createSocket: getIrohSocketFactory(),
    });
  }
  return new ClientCtor({ url: dial.url, identity, agent });
}

/** Dials, verifies and authenticates a paired worker over `route` (every ManagedConnection's `dial`); closes on failure. */
async function dialWorker(worker, route) {
  const dial =
    route === "iroh"
      ? await irohDial(worker.iroh, worker.nodeId)
      : (() => {
          const addr = worker.addrs[0];
          if (!addr) throw new Error(`No known address for ${worker.label}.`);
          return { transport: /** @type {const} */ ("ws"), url: addr, display: addr };
        })();

  const client = await makeClient(dial);
  try {
    await client.connect();
    if (client.peerNodeId !== worker.nodeId) {
      throw new Error(
        `Worker at ${dial.display} identified itself as a different node than expected ` +
          `(expected ${worker.nodeId}, got ${client.peerNodeId}) — the address may now point ` +
          "at a different worker. Forget and re-pair if this persists.",
      );
    }
    await client.authProve();
    return client;
  } catch (err) {
    client.close();
    // Same code (so `isUnpairedError` still matches), friendlier words.
    if (isUnpairedError(err)) throw new WorkerProtocolError(AUTH_UNTRUSTED, UNPAIRED_MESSAGE);
    throw err;
  }
}

/** `clients.leave` on `worker`: over `live` if given, else a one-off dial (closed after). */
async function leaveWorker(worker, live) {
  if (live) {
    await live.clientsLeave();
    return;
  }
  const client = await dialWorker(worker, resolvePreferredTransport(worker));
  try {
    await client.clientsLeave();
  } finally {
    client.close();
  }
}

/** Stop Early / Cancel for the selected worker's current run; a failure toasts (the panel would wait otherwise). */
async function endCurrentRun(mode, runId) {
  const store = useConnectStore.getState();
  const { _client, selectedWorkerId, trackedJobs } = store;
  if (!_client || !selectedWorkerId) return;
  const active = activeJobsFor(selectedWorkerId, trackedJobs);
  const latest = active[active.length - 1];
  if (!latest) return;
  let summaries = [];
  try {
    summaries = await store.listJobs(selectedWorkerId);
  } catch {
    // Unknown run membership: act on the latest job alone.
  }
  const { all, current } = runJobsToEnd(latest, active, summaries, runId);
  for (const jobId of mode === "stop" ? [current] : all) {
    try {
      await store.cancelJobOn(selectedWorkerId, jobId, mode);
    } catch (err) {
      deps.notify.error(mode === "stop" ? "Couldn't stop training" : "Couldn't cancel training", {
        description: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }
}

// ── Cross-window sharing ──────────────────────────────────────────

/** The base of every three-way merge; null until a current-version copy is read (first save unions). */
let sharedBase = null;

/**
 * Applies a merged shared state here: a worker another window forgot is disconnected (no
 * `clients.leave`, that window told the worker), a new device name is pushed to connected workers.
 */
function applyShared(merged) {
  const before = useConnectStore.getState();
  const kept = new Set(merged.pairedWorkers.map((w) => w.nodeId));
  const removed = before.pairedWorkers.filter((w) => !kept.has(w.nodeId)).map((w) => w.nodeId);
  useConnectStore.setState(merged);
  for (const nodeId of removed) dropWorkerLocally(nodeId);
  if (merged.deviceName && merged.deviceName !== before.deviceName) {
    void pushDeviceNameToConnected(merged.deviceName);
  }
}

/** Stops this window's connection to a worker another window forgot, and deselects it. */
function dropWorkerLocally(nodeId) {
  const mc = managed.get(nodeId);
  managed.delete(nodeId);
  dropSubscriptionsFor(nodeId);
  mc?.stop();
  const state = useConnectStore.getState();
  const wasSelected = state.selectedWorkerId === nodeId;
  if (wasSelected && state._client && state._client !== mc?.client) state._client.close();
  useConnectStore.setState((s) => ({
    connections: Object.fromEntries(Object.entries(s.connections).filter(([id]) => id !== nodeId)),
    ...(wasSelected
      ? {
          selectedWorkerId: null,
          connectionStatus: "disconnected",
          connectionError: null,
          workerMounts: [],
          reattachableJob: null,
          activeTransport: null,
          _client: null,
        }
      : {}),
  }));
}

/**
 * `persist` storage: each save three-way merges into the stored copy, so a stale window can't undo
 * another's changes (#453); merged-in changes are applied here too.
 * @type {import("./mini-store.js").PersistStorage<SharedConnectState>}
 */
const sharedConnectStorage = {
  getItem: (name) => {
    try {
      const raw = localStore()?.getItem(name) ?? null;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed.version === CONNECT_PERSIST_VERSION) sharedBase = toShared(parsed.state);
      return parsed;
    } catch {
      // LUCID: storage that throws (blocked, sandboxed) or holds corrupt JSON = nothing stored.
      return null;
    }
  },
  setItem: (name, value) => {
    // LUCID: a throwing storage (quota, private mode) must never break the action; the save is just lost.
    try {
      const storage = localStore();
      if (!storage) return;
      const mine = toShared(value.state);
      if (!mine) return;
      const stored = storage.getItem(name);
      const theirs = readStoredShared(stored);
      const merged = theirs ? capShared(mergeShared(sharedBase, mine, theirs)) : mine;
      const raw = JSON.stringify({ state: merged, version: value.version });
      // Skipping an unchanged write also spares the other windows a storage event.
      if (raw !== stored) storage.setItem(name, raw);
      if (sameShared(merged, mine)) {
        sharedBase = merged;
      } else {
        // LUCID: `sharedBase` stays at the APPLIED copy until `merged` is in the store (else a save in
        // between reads the other window's records as reverts); local changes since are merged over it.
        queueMicrotask(() => {
          sharedBase = merged;
          const cur = sharedSlice(useConnectStore.getState());
          applyShared(sameShared(cur, mine) ? merged : capShared(mergeShared(mine, cur, merged)));
        });
      }
    } catch (err) {
      console.warn("[connect] couldn't save the shared Connect state:", err);
    }
  },
  removeItem: (name) => {
    try {
      localStore()?.removeItem(name);
    } catch {
      // Nothing to remove from an unusable storage.
    }
    sharedBase = null;
  },
};

/** Merges in a save made by ANOTHER tab (`storage` event `newValue`); no-op if unparseable or unchanged. */
export function syncConnectFromStorage(newValue) {
  const theirs = readStoredShared(newValue);
  if (!theirs) return;
  const mine = sharedSlice(useConnectStore.getState());
  const merged = capShared(mergeShared(sharedBase, mine, theirs));
  sharedBase = theirs;
  if (!sameShared(merged, mine)) applyShared(merged);
}

/** Wires `syncConnectFromStorage` to `target`'s `storage` events; returns the remover. */
export function installConnectStorageSync(target = globalThis.window) {
  if (!target || typeof target.addEventListener !== "function") return () => {};
  const listener = (e) => {
    if (e.key === CONNECT_STORAGE_KEY) syncConnectFromStorage(e.newValue);
  };
  target.addEventListener("storage", listener);
  return () => target.removeEventListener("storage", listener);
}

// ── Managed connections ───────────────────────────────────────────

/** Gets or creates `nodeId`'s ManagedConnection wired into the store. Does NOT dial (caller `.start()`s). */
function ensureConnection(nodeId, options) {
  const existing = managed.get(nodeId);
  if (existing) return existing;

  const worker = useConnectStore.getState().pairedWorkers.find((w) => w.nodeId === nodeId);
  if (!worker) {
    throw new Error("Unknown worker — pair with it first.");
  }

  const mc = new ManagedConnection({
    dial: (route) => dialWorker(worker, route),
    preferredRoute: resolvePreferredTransport(worker, options),
    canFallBackToIroh: !!worker.iroh && irohTransportAvailable(),
    onStatus: (status, route) => {
      // A forgotten worker can still report in during Forget's `clients.leave`: not ours to track.
      if (!useConnectStore.getState().pairedWorkers.some((w) => w.nodeId === nodeId)) return;
      useConnectStore.setState((state) => {
        const patch = {
          connections: { ...state.connections, [nodeId]: { status, route } },
        };
        if (status === "unpaired") {
          patch.pairedWorkers = state.pairedWorkers.map((w) =>
            w.nodeId === nodeId && !w.unpairedAt ? { ...w, unpairedAt: new Date().toISOString() } : w,
          );
        }
        if (nodeId === state.selectedWorkerId) {
          patch.connectionStatus = mapLinkStatus(status);
          patch.connectionError =
            status === "offline"
              ? "Worker unreachable — retrying"
              : status === "unpaired"
                ? UNPAIRED_MESSAGE
                : null;
          patch.activeTransport = route;
          if (status === "unpaired") patch._client = null;
        }
        return patch;
      });
      // Stopped for good: drop it so a later explicit connect builds a fresh one.
      if (status === "unpaired" && managed.get(nodeId) === mc) managed.delete(nodeId);
    },
    onConnected: (client, route) => {
      if (nodeId === useConnectStore.getState().selectedWorkerId) {
        useConnectStore.setState({ _client: client, activeTransport: route });
        // Best-effort: keeps `workerMounts` current across an automatic reconnect
        // (the explicit connectToWorker does its own awaited fetch).
        void client
          .fsMounts()
          .then((mounts) => useConnectStore.setState({ workerMounts: mounts }))
          .catch(() => {});
      }
      // Always: a background job on an unselected worker needs re-attaching too.
      resubscribeWorker(nodeId, client);
    },
    now: managedDeps.now,
    sleep: managedDeps.sleep,
  });
  managed.set(nodeId, mc);
  return mc;
}

/** `trackedJob` as a ReattachableJob if it's on `workerId` and still active there, else null. */
async function checkReattach(client, workerId, trackedJob) {
  if (!trackedJob || trackedJob.workerId !== workerId) return null;
  try {
    const status = await client.jobsStatus(trackedJob.jobId);
    if (TERMINAL_JOB_STATES.has(status.state)) return null;
    return { jobId: trackedJob.jobId, state: status.state };
  } catch {
    return null;
  }
}

// ── Job subscriptions ─────────────────────────────────────────────

/**
 * Live job subscriptions by jobId (not persisted), so a reconnect re-attaches them to the new client.
 * @typedef {{ workerId: string, jobId: string, handle: (event: WorkerEvent) => void, unsubscribe: (() => void) | null, abort?: (err: Error) => void, attempt?: number }} ActiveSubscription
 */
const activeSubscriptions = new Map();

/** (Re)subscribes `sub` on `client` from `sinceSeq`, dropping any prior subscription first. */
async function attachSubscription(client, sub, sinceSeq) {
  sub.unsubscribe?.();
  sub.unsubscribe = null;
  // LUCID: a newer attach, or the job ending/dropped mid-flight, must not leave this listener behind.
  const attempt = (sub.attempt = (sub.attempt ?? 0) + 1);
  const unsubscribe = await client.jobsSubscribe(sub.jobId, sinceSeq, sub.handle);
  if (sub.attempt !== attempt || activeSubscriptions.get(sub.jobId) !== sub) {
    unsubscribe();
    return;
  }
  sub.unsubscribe = unsubscribe;
}

/** LUCID: stops watching a forgotten worker's jobs; a waiting `submitJob` is rejected, not left hanging. */
function dropSubscriptionsFor(workerId) {
  for (const [jobId, sub] of [...activeSubscriptions]) {
    if (sub.workerId !== workerId) continue;
    activeSubscriptions.delete(jobId);
    sub.unsubscribe?.();
    sub.unsubscribe = null;
    sub.abort?.(new Error("This worker was forgotten before the job finished."));
  }
}

/** The persisted `lastSeq` for one tracked job — the catch-up point after a reconnect. */
function trackedLastSeq(jobId) {
  return useConnectStore.getState().trackedJobs.find((j) => j.jobId === jobId)?.lastSeq ?? 0;
}

/** Re-attaches `workerId`'s subscriptions to a (re)connected client from each one's last-applied seq. */
export function resubscribeWorker(workerId, client) {
  for (const sub of activeSubscriptions.values()) {
    if (sub.workerId !== workerId) continue;
    // LUCID: a failed re-attach is retried by the next reconnect; never an unhandled rejection.
    attachSubscription(client, sub, trackedLastSeq(sub.jobId)).then(() => reconcileTerminalJob(client, sub)).catch((err) => {
      console.warn(`[connect] couldn't re-attach job ${sub.jobId}:`, err);
    });
  }
}

/**
 * LUCID: a restarted worker marks lost jobs `failed` WITHOUT a `job.status` event, so after a
 * re-attach ask for the state; a terminal one is fed as the missed events with a seq past any real one.
 */
async function reconcileTerminalJob(client, sub) {
  if (activeSubscriptions.get(sub.jobId) !== sub) return; // the replay already ended it
  // Only a job still tracked as active (one dropped from the list, or already ended, is not ours to end).
  if (useConnectStore.getState().trackedJobs.find((j) => j.jobId === sub.jobId)?.state !== "active") return;
  let status;
  try { status = await client.jobsStatus(sub.jobId); } catch { return; } // unknown job / dropped again: leave it
  if (activeSubscriptions.get(sub.jobId) !== sub || !TERMINAL_JOB_STATES.has(status.state)) return;
  if (status.result) sub.handle({ seq: Number.MAX_SAFE_INTEGER - 1, topic: "job.result", data: status.result });
  sub.handle({
    seq: Number.MAX_SAFE_INTEGER, topic: "job.status",
    data: { state: status.state, ...(status.error ? { detail: status.error } : {}) },
  });
}

/** @typedef {(partial: Record<string, any> | ((state: any) => Record<string, any>)) => void} ConnectSet */

/** Merges `patch` into one tracked job by `jobId`. */
function updateTrackedJob(set, jobId, patch) {
  set((state) => ({
    trackedJobs: state.trackedJobs.map((j) => (j.jobId === jobId ? { ...j, ...patch } : j)),
  }));
}

/**
 * LUCID: the run of `job` once every one of its tracked jobs has ended, else null. Its label is the jobs'
 * shared prefix ("Inference · back" -> "Inference · 6 views").
 */
function runSummary(job) {
  const jobs = useConnectStore.getState().trackedJobs.filter((j) => j.runId === job.runId);
  if (jobs.length < job.runCount || jobs.some((j) => j.state === "active")) return null;
  const base = String(job.label).split(" · ")[0];
  const unit = jobs.every((j) => j.camera !== undefined) ? "views" : "jobs";
  return {
    label: `${base} · ${jobs.length} ${unit}`,
    count: jobs.length,
    failed: jobs.filter((j) => j.state === "failed").length,
    canceled: jobs.filter((j) => j.state === "canceled").length,
  };
}

/** Jobs already toasted this session (`resumeTrackedJobs` can run more than once). */
const notifiedJobIds = new Set();

/** Toasts a job's terminal state once; canceled is the user's own action, so `info`, never `error`. */
async function notifyJobFinished(job, workerLabel, errorDetail) {
  if (notifiedJobIds.has(job.jobId)) return;
  notifiedJobIds.add(job.jobId);
  // A one-click path to the Connect window (sleap-app PR4b §4b.2).
  const action = {
    label: "Open",
    onClick: () => deps.openConnectWindow?.(),
  };
  if (job.runId && job.runCount > 1) {
    const run = runSummary(job);
    if (!run) return; // other jobs of the run are still going: the last one to end toasts
    if (run.failed > 0) {
      deps.notify.error(`${run.label} on ${workerLabel}: ${run.failed} of ${run.count} failed`, {
        description: errorDetail ?? undefined,
        action,
      });
    } else if (run.canceled > 0) {
      deps.notify.info(`${run.label} on ${workerLabel} was canceled`, { action });
    } else {
      deps.notify.success(`${run.label} on ${workerLabel} finished`, { action });
    }
    return;
  }
  if (job.state === "completed") {
    deps.notify.success(`${job.label} on ${workerLabel} finished`, { action });
  } else if (job.state === "canceled") {
    deps.notify.info(`${job.label} on ${workerLabel} was canceled`, { action });
  } else {
    deps.notify.error(`${job.label} on ${workerLabel} failed`, {
      description: errorDetail ?? undefined,
      action,
    });
  }
}

/**
 * Watches a tracked job to its terminal state (nothing awaits it, unlike `submitSingleJob`): updates
 * `lastSeq`, records the final state and notifies. `onChainedJobIds` gets a result's `chained_job_ids`.
 */
async function watchTrackedJob(set, client, job, workerLabel, onChainedJobIds) {
  if (activeSubscriptions.has(job.jobId)) return; // already being watched

  let watcherLastSeq = job.lastSeq;
  let watcherPersistedAt = 0;
  /** @type {ActiveSubscription} */
  const watcher = {
    workerId: job.workerId,
    jobId: job.jobId,
    unsubscribe: null,
    handle: (event) => {
      if (event.seq <= watcherLastSeq) return;
      watcherLastSeq = event.seq;
      // LUCID: throttled like `submitSingleJob`'s (a burst of log events is one write per 2 s);
      // state changes below persist immediately and carry the latest seq.
      const nowMs = Date.now();
      if (nowMs - watcherPersistedAt >= LAST_SEQ_PERSIST_THROTTLE_MS) {
        watcherPersistedAt = nowMs;
        updateTrackedJob(set, job.jobId, { lastSeq: watcherLastSeq });
      }

      if (event.topic === "job.result") {
        const chainedIds = event.data.chained_job_ids;
        if (chainedIds && chainedIds.length > 0) onChainedJobIds?.(chainedIds);
        return;
      }
      if (event.topic !== "job.status") return;
      const state = event.data.state;
      if (!TERMINAL_JOB_STATES.has(state)) return;
      watcher.unsubscribe?.();
      activeSubscriptions.delete(job.jobId);
      const trackedState = state;
      const detail = event.data.detail ?? null;
      updateTrackedJob(set, job.jobId, {
        state: trackedState,
        lastSeq: watcherLastSeq,
        ...(trackedState !== "completed" ? { error: detail ?? undefined } : {}),
      });
      void notifyJobFinished({ ...job, state: trackedState }, workerLabel, detail);
    },
  };
  activeSubscriptions.set(job.jobId, watcher);
  try {
    await attachSubscription(client, watcher, job.lastSeq);
  } catch (err) {
    // LUCID: a dropped connection keeps the watcher registered for the reconnect's `resubscribeWorker`.
    if (!(err instanceof WorkerProtocolError) || err.code !== CLIENT_CLOSED) activeSubscriptions.delete(job.jobId);
    console.warn(`[connect] watchTrackedJob: failed to watch job ${job.jobId}:`, err);
  }
}

/** Tracks and watches a job the worker chained on its own (no-op if tracked). LUCID: inherits `tag`. */
function trackChainedJob(set, client, workerId, jobId, source, workerLabel, tag) {
  if (useConnectStore.getState().trackedJobs.some((j) => j.jobId === jobId)) return;
  const job = {
    workerId,
    jobId,
    lastSeq: 0,
    kind: "track",
    label: "Inference",
    source,
    state: "active",
    seen: false,
    submittedAt: Date.now(),
    ...jobTag(tag),
  };
  set((state) => ({ trackedJobs: capTrackedJobs([...state.trackedJobs, job]) }));
  void watchTrackedJob(set, client, job, workerLabel);
}

const LAST_SEQ_PERSIST_THROTTLE_MS = 2000;

/**
 * Submits one job and resolves at its terminal state, forwarding `job.log` to `onProgress`. The
 * subscription survives a reconnect; events are deduped by seq so a backlog replay can't double-apply.
 */
async function submitSingleJob(client, workerId, spec, onProgress, set, onTelemetry, tag) {
  const { jobId } = await client.jobsSubmit(withYamlRunName(spec, yamlLoad));
  const tracked = {
    workerId,
    jobId,
    lastSeq: 0,
    kind: spec.type,
    label: trackedJobLabel(spec),
    source: "window",
    state: "active",
    seen: false,
    submittedAt: Date.now(),
    ...jobTag(tag),
  };
  set((state) => ({ trackedJobs: capTrackedJobs([...state.trackedJobs, tracked]) }));

  return new Promise((resolve, reject) => {
    let settled = false;
    // The worker emits job.result before job.status: completed.
    let resultBlobs;
    let modelDir;
    let labelsPath;
    let lastSeq = 0;
    let lastPersistedAt = 0;

    // Throttled; always caught up on terminal.
    const persistLastSeq = () => {
      const now = Date.now();
      if (now - lastPersistedAt < LAST_SEQ_PERSIST_THROTTLE_MS) return;
      lastPersistedAt = now;
      updateTrackedJob(set, jobId, { lastSeq });
    };

    const finish = (result, trackedState) => {
      if (settled) return;
      settled = true;
      sub.unsubscribe?.();
      activeSubscriptions.delete(jobId);
      // Keep the entry (job history). `seen: true`: this window watched it finish.
      updateTrackedJob(set, jobId, {
        state: trackedState,
        seen: true,
        lastSeq,
        ...(trackedState !== "completed" ? { error: result.error } : {}),
      });
      resolve(result);
    };

    const sub = {
      workerId,
      jobId,
      unsubscribe: null,
      abort: (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      },
      handle: (event) => {
        // An event can arrive live and again in a reconnect's replay.
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        persistLastSeq();

        if (event.topic === "job.log") {
          onProgress(event.data.line ?? "", event.data.progress === true);
        } else if (event.topic === "job.result") {
          const blobs = event.data.blobs;
          if (blobs && Object.keys(blobs).length > 0) resultBlobs = blobs;
          // Train jobs only: worker-side model folder + labels file.
          if (typeof event.data.model_dir === "string") modelDir = event.data.model_dir;
          if (typeof event.data.labels_path === "string") labelsPath = event.data.labels_path;
        } else if (event.topic === "job.status") {
          const state = event.data.state;
          if (state === "completed") {
            const result = { jobId, success: true, resultBlobs, runId: spec.run?.id };
            if (modelDir !== undefined) result.modelDir = modelDir;
            if (labelsPath !== undefined) result.labelsPath = labelsPath;
            finish(result, "completed");
          } else if (state === "failed" || state === "canceled") {
            finish(
              {
                jobId,
                success: false,
                error: event.data.detail ?? `Job ${state}`,
                runId: spec.run?.id,
              },
              state,
            );
          }
        } else if (onTelemetry) {
          const telemetry = parseJobTelemetry(event);
          if (telemetry) onTelemetry(telemetry);
        }
      },
    };

    activeSubscriptions.set(jobId, sub);
    attachSubscription(client, sub, 0).catch((err) => {
      activeSubscriptions.delete(jobId);
      if (!settled) {
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/** `withYamlRunName`'s parser: the injected one, or one that always fails (the spec then goes out unchanged). */
function yamlLoad(text) {
  if (!deps.yamlLoad) throw new Error("no YAML parser configured");
  return deps.yamlLoad(text);
}

// ── Pairing-code reading (PairWorkerForm.tsx) ─────────────────────

export { readCodeInfo };

/**
 * The pairing form's live status line: `readCodeInfo` + `planPairing`; never throws (NOT_A_CODE).
 * @returns {Promise<import("./pairing-plan.js").PairingPlan>}
 */
export async function planPairingForText(text, addrOverride) {
  try {
    const info = await readCodeInfo(text);
    if (info === null) return { kind: "error", message: NOT_A_CODE };
    return planPairing(info, { irohAvailable: irohTransportAvailable(), addrOverride });
  } catch {
    return { kind: "error", message: NOT_A_CODE };
  }
}

// ── Store ─────────────────────────────────────────────────────────

/** The Connect store singleton (same state and action names as connectStore.ts). */
export const useConnectStore = createStore(
  persist(
    (set, get) => ({
      // ── Persisted ──
      /** @type {PairedWorker[]} */
      pairedWorkers: [],
      /** Per window (sessionStorage), not shared. */
      selectedWorkerId: null,
      /** Shared: a new window's starting selection. */
      lastSelectedWorkerId: null,
      /** @type {TrackedJob[]} */
      trackedJobs: [],
      /** null = the OS computer name or "<Browser> on <OS>". */
      deviceName: null,

      // ── Runtime (not persisted) ──
      /** @type {ConnectionStatus} */
      connectionStatus: "disconnected",
      connectionError: null,
      workerMounts: [],
      /** Set once per connect if the worker has an active tracked job. @type {ReattachableJob | null} */
      reattachableJob: null,
      activeTransport: null,
      /** Live link status per managed worker: `{ status, route }`. */
      connections: {},
      /** Latest `clientFor`/`refreshWorkerInfo` failure per worker. */
      workerErrors: {},
      workerInfo: {},
      /** @type {WorkerClient | null} */
      _client: null,

      /** A connected, authenticated client for ANY paired worker; a failed dial lands in `workerErrors`. */
      clientFor: async (workerId) => {
        const existing = managed.get(workerId);
        if (existing?.client) return existing.client;
        // Automatic callers don't keep dialing a worker that refused this device.
        if (get().pairedWorkers.find((w) => w.nodeId === workerId)?.unpairedAt) {
          throw new Error(UNPAIRED_MESSAGE);
        }
        // Concurrent callers share one dial (`start()` isn't idempotent: a second would leak a client).
        const pending = clientForStarts.get(workerId);
        if (pending) return pending;
        // No client and no start of ours: mid-reconnect or another start owns the redial.
        if (existing) throw new Error("Worker is reconnecting — try again shortly.");

        const mc = ensureConnection(workerId);
        const start = (async () => {
          try {
            const client = await mc.start();
            set((state) => ({ workerErrors: { ...state.workerErrors, [workerId]: null } }));
            return client;
          } catch (err) {
            if (managed.get(workerId) === mc) managed.delete(workerId);
            set((state) => ({
              workerErrors: {
                ...state.workerErrors,
                [workerId]: err instanceof Error ? err.message : String(err),
              },
            }));
            throw err;
          } finally {
            clientForStarts.delete(workerId);
          }
        })();
        clientForStarts.set(workerId, start);
        return start;
      },

      /** Stops every managed connection that isn't selected and has no active tracked job. */
      releaseIdleConnections: () => {
        const { selectedWorkerId, trackedJobs } = get();
        for (const [workerId, mc] of [...managed]) {
          if (workerId === selectedWorkerId) continue;
          if (activeJobsFor(workerId, trackedJobs).length > 0) continue;
          mc.stop();
          managed.delete(workerId);
        }
      },

      /** Fetches `worker.info` for `workerId` into `workerInfo`; a failure lands in `workerErrors` instead of throwing. */
      refreshWorkerInfo: async (workerId) => {
        try {
          const client = await get().clientFor(workerId);
          const info = await client.workerInfo();
          set((state) => ({
            workerInfo: { ...state.workerInfo, [workerId]: info },
            workerErrors: { ...state.workerErrors, [workerId]: null },
          }));
        } catch (err) {
          set((state) => ({
            workerErrors: {
              ...state.workerErrors,
              [workerId]: err instanceof Error ? err.message : String(err),
            },
          }));
        }
      },

      /** Every job on `workerId` (not just ones this window tracks). */
      listJobs: async (workerId) => {
        const client = await get().clientFor(workerId);
        return client.jobsList();
      },

      jobDetail: async (workerId, jobId) => {
        const client = await get().clientFor(workerId);
        return client.jobsStatus(jobId);
      },

      /** Cancel/stop (`mode`) a job on ANY paired worker. */
      cancelJobOn: async (workerId, jobId, mode) => {
        const client = await get().clientFor(workerId);
        await client.jobsCancel(jobId, mode);
      },

      /** Deletes job records (not files) on the worker, all-or-nothing (`job.active`), then forgets them here. */
      deleteJobsOn: async (workerId, jobIds) => {
        const client = await get().clientFor(workerId);
        await client.jobsDelete(jobIds);

        const idSet = new Set(jobIds);
        for (const jobId of jobIds) {
          activeSubscriptions.get(jobId)?.unsubscribe?.();
          activeSubscriptions.delete(jobId);
          notifiedJobIds.delete(jobId);
        }
        set((state) => ({
          trackedJobs: state.trackedJobs.filter((j) => !idSet.has(j.jobId)),
        }));
      },

      /** Claims a pairing ticket (`sleap1…` code or legacy JSON) and connects; `options.transport` default "ws". */
      pairWithTicket: async (ticketJson, addrOverride, options) => {
        const trimmed = ticketJson.trim();
        /** @type {PairingTicket} */
        let ticket;
        if (isPairCode(trimmed)) {
          try {
            ticket = await decodePairCode(trimmed);
          } catch (err) {
            throw new Error(err instanceof PairCodeError ? err.message : String(err));
          }
          if (ticket.expires_at !== undefined && ticket.expires_at * 1000 < Date.now()) {
            throw new Error(
              `This pairing code expired at ${new Date(ticket.expires_at * 1000).toLocaleString()}; ` +
                "run `sleap-connect pair` again.",
            );
          }
        } else {
          try {
            ticket = JSON.parse(trimmed);
          } catch {
            throw new Error("That doesn't look like a valid pairing ticket (invalid JSON).");
          }
        }
        if (!ticket.node_id || !ticket.secret) {
          throw new Error("Pairing ticket is missing node_id or secret.");
        }
        const irohInfo = parseTicketIroh(ticket.iroh);
        const transport = options?.transport ?? "ws";
        let dial;
        let addr;
        if (transport === "iroh") {
          dial = await irohDial(irohInfo, ticket.node_id);
        } else {
          addr = addrOverride || ticket.addrs?.[0];
          if (!addr) {
            throw new Error(
              "This ticket has no worker address — enter one (e.g. ws://192.168.1.42:9631).",
            );
          }
          dial = { transport: "ws", url: addr, display: addr };
        }

        // LUCID: closing the SELECTED worker's `_client` while pairing another left its managed
        // connection holding a dead client; back it off like connectToWorker, close only same-node.
        {
          const { selectedWorkerId: sel } = get();
          if (sel && sel !== ticket.node_id) get().disconnect();
          else get()._client?.close();
        }
        set({ connectionStatus: "connecting", connectionError: null, activeTransport: transport });

        let client = null;
        try {
          client = await makeClient(dial);
          await client.connect();
          if (client.peerNodeId !== ticket.node_id) {
            throw new Error(
              `Worker at ${dial.display} identified itself as a different node than this ticket ` +
                `claims (expected ${ticket.node_id}, got ${client.peerNodeId}) — check the ` +
                "address, or get a fresh ticket from the worker you meant to pair with.",
            );
          }
          await client.pairClaim(ticket.secret);
          const mounts = await client.fsMounts();
          const reattachableJob = await checkReattach(
            client,
            ticket.node_id,
            latestActiveJobFor(ticket.node_id, get().trackedJobs),
          );

          const paired = {
            nodeId: ticket.node_id,
            label: `Worker ${ticket.node_id.slice(0, 8)}`,
            addrs: addr
              ? [addr, ...(ticket.addrs ?? []).filter((a) => a !== addr)]
              : [...(ticket.addrs ?? [])],
            pairedAt: new Date().toISOString(),
            iroh: irohInfo,
            transport: rememberedTransport(transport),
          };

          set((state) => ({
            pairedWorkers: upsertWorker(state.pairedWorkers, paired),
            // A stale "unpaired" status from before this re-pair.
            connections: Object.fromEntries(
              Object.entries(state.connections).filter(([id]) => id !== paired.nodeId),
            ),
            workerErrors: { ...state.workerErrors, [paired.nodeId]: null },
            selectedWorkerId: paired.nodeId,
            connectionStatus: "connected",
            connectionError: null,
            workerMounts: mounts,
            reattachableJob,
            activeTransport: transport,
            _client: client,
          }));
        } catch (err) {
          // A socket may be open though a later step failed: don't leak it.
          client?.close();
          set({
            connectionStatus: "error",
            connectionError: err instanceof Error ? err.message : String(err),
            _client: null,
          });
          throw err;
        }

        // Paired: hand over to a managed connection (auth.prove) so a drop reconnects. A failed
        // re-dial leaves the pairing standing, with the error in connectionError.
        try {
          await get().connectToWorker(ticket.node_id, { transport });
        } catch {
          // Surfaced via connectionError; the worker stays paired.
        }
      },

      /** LUCID: the pairing form's flow: `readCodeInfo` -> `planPairing` -> `pairWithTicket`; throws the plan's message. */
      pairWithCode: async (text, addrOverride) => {
        const info = await readCodeInfo(text);
        const plan = info === null
          ? { kind: "error", message: NOT_A_CODE }
          : planPairing(info, { irohAvailable: irohTransportAvailable(), addrOverride });
        if (plan.kind === "error") throw new Error(plan.message);
        if (plan.kind === "needs-address") throw new Error(plan.reason);
        await get().pairWithTicket(text.trim(), addrOverride?.trim() || undefined, {
          transport: plan.transport,
        });
      },

      /** Reconnects a paired worker; default transport = the remembered one ("ws" if none or iroh unavailable). */
      connectToWorker: async (nodeId, options) => {
        const worker = get().pairedWorkers.find((w) => w.nodeId === nodeId);
        if (!worker) {
          throw new Error("Unknown worker — pair with it first.");
        }

        const previousSelected = get().selectedWorkerId;
        if (previousSelected && previousSelected !== nodeId) {
          // Back the old selection off as disconnect() would (kept alive if it has an active job).
          get().disconnect();
        }

        // An explicit connect always gets a fresh connection (also closes pairWithTicket's client).
        managed.get(nodeId)?.stop();
        managed.delete(nodeId);
        if (get().selectedWorkerId === nodeId) get()._client?.close();

        set({
          selectedWorkerId: nodeId,
          connectionStatus: "connecting",
          connectionError: null,
        });

        const mc = ensureConnection(nodeId, options);
        let client;
        // Shared with `clientFor`, so a concurrent caller waits for this dial.
        const start = mc.start();
        clientForStarts.set(nodeId, start);
        // LUCID: once its connection was stopped or replaced, a connect reports to its caller only
        // and never writes status/client over what replaced it.
        const superseded = () => managed.get(nodeId) !== mc;
        const stoppedError = () =>
          new WorkerProtocolError(CLIENT_CLOSED, "Connection stopped before it finished connecting");
        try {
          client = await start;
        } catch (err) {
          if (clientForStarts.get(nodeId) === start) clientForStarts.delete(nodeId);
          if (superseded()) throw err;
          // Nothing adopted: just drop the dead instance.
          managed.delete(nodeId);
          set({
            connectionStatus: "error",
            connectionError: err instanceof Error ? err.message : String(err),
            _client: null,
          });
          throw err;
        }
        if (clientForStarts.get(nodeId) === start) clientForStarts.delete(nodeId);
        if (superseded()) {
          mc.stop();
          throw stoppedError();
        }

        try {
          const mounts = await client.fsMounts();
          const reattachableJob = await checkReattach(
            client,
            nodeId,
            latestActiveJobFor(nodeId, get().trackedJobs),
          );
          // Remembered here, not in onConnected, so an automatic fallback route is never persisted.
          const transport = resolvePreferredTransport(worker, options);
          if (superseded()) throw stoppedError();

          set((state) => ({
            pairedWorkers: state.pairedWorkers.map((w) =>
              w.nodeId === nodeId ? { ...w, transport: rememberedTransport(transport) } : w,
            ),
            connectionStatus: "connected",
            connectionError: null,
            workerMounts: mounts,
            reattachableJob,
            activeTransport: mc.route,
            _client: client,
          }));
        } catch (err) {
          // Close the dialed client via the managed connection.
          mc.stop();
          if (superseded()) throw err;
          managed.delete(nodeId);
          set({
            connectionStatus: "error",
            connectionError: err instanceof Error ? err.message : String(err),
            _client: null,
          });
          throw err;
        }

        // One-time import of the legacy global path mappings when `pathRules` was never set
        // (`loadSavedMappings` never throws). LUCID: adapter = injected `pathMappingsStorage`.
        if (worker.pathRules === undefined) {
          const pathRules = await loadSavedMappings(deps.pathMappingsStorage);
          set((state) => ({
            pairedWorkers: state.pairedWorkers.map((w) =>
              w.nodeId === nodeId ? { ...w, pathRules } : w,
            ),
          }));
        }
      },

      /** Select (and connect to) a paired worker, or `null` to disconnect. */
      selectWorker: async (nodeId, options) => {
        if (nodeId === null) {
          get().disconnect();
          return;
        }
        await get().connectToWorker(nodeId, options);
      },

      disconnect: () => {
        const { selectedWorkerId, trackedJobs } = get();
        if (selectedWorkerId) {
          if (activeJobsFor(selectedWorkerId, trackedJobs).length > 0) {
            // Kept running for the active job; only the selected-UI fields are cleared.
          } else {
            managed.get(selectedWorkerId)?.stop();
            managed.delete(selectedWorkerId);
          }
        }
        set({
          connectionStatus: "disconnected",
          connectionError: null,
          workerMounts: [],
          reattachableJob: null,
          activeTransport: null,
          _client: null,
        });
      },

      /** Removes the worker here at once (even with active jobs), then best-effort `clients.leave` there. */
      forgetWorker: async (nodeId) => {
        const worker = get().pairedWorkers.find((w) => w.nodeId === nodeId);
        const mc = managed.get(nodeId);
        const liveClient = mc?.client?.authenticated
          ? mc.client
          : get().selectedWorkerId === nodeId && get()._client?.authenticated
            ? get()._client
            : null;
        managed.delete(nodeId);
        dropSubscriptionsFor(nodeId);
        const wasSelected = get().selectedWorkerId === nodeId;
        set((state) => {
          const connections = Object.fromEntries(
            Object.entries(state.connections).filter(([id]) => id !== nodeId),
          );
          return {
            pairedWorkers: state.pairedWorkers.filter((w) => w.nodeId !== nodeId),
            selectedWorkerId: wasSelected ? null : state.selectedWorkerId,
            trackedJobs: state.trackedJobs.filter((j) => j.workerId !== nodeId),
            connections,
            ...(wasSelected
              ? {
                  connectionStatus: "disconnected",
                  connectionError: null,
                  workerMounts: [],
                  reattachableJob: null,
                  activeTransport: null,
                  _client: null,
                }
              : {}),
          };
        });

        // Live connection if any, else a short dial; an offline worker keeps its entry.
        try {
          if (worker && !worker.unpairedAt) {
            await withTimeout(leaveWorker(worker, liveClient), FORGET_LEAVE_TIMEOUT_MS);
          }
        } catch (err) {
          console.warn("[connect] couldn't unpair from the worker on Forget:", err);
        } finally {
          mc?.stop();
          if (liveClient && liveClient !== mc?.client) liveClient.close();
        }
      },

      /** Lists `path` on the selected worker, paging `fs.list` from `offset`; stops past `limit`. */
      browseRemoteDir: async (path, offset, limit) => {
        return fetchAllRemoteEntries(
          (o) => {
            const { _client } = get();
            if (!_client || !_client.authenticated) {
              throw new Error("Not connected to worker");
            }
            return _client.fsList(path, o);
          },
          offset,
          limit,
        );
      },

      /** `browseRemoteDir` for ANY paired worker (dials via `clientFor`). */
      browseRemoteDirOn: async (workerId, path, offset, limit) => {
        const client = await get().clientFor(workerId);
        return fetchAllRemoteEntries((o) => client.fsList(path, o), offset, limit);
      },

      /** `fs.mounts` for ANY paired worker — dials via `clientFor`. */
      mountsFor: async (workerId) => {
        const client = await get().clientFor(workerId);
        return client.fsMounts();
      },

      /** `clients.list` — the devices paired with `workerId`. Dials via `clientFor`. */
      devicesFor: async (workerId) => {
        const client = await get().clientFor(workerId);
        return client.clientsList();
      },

      /** Renames this device: saved for future hellos and pushed now (`clients.rename`). */
      setDeviceName: async (name) => {
        const clean = normalizeDeviceName(name);
        if (!clean) return;
        set({ deviceName: clean });
        await pushDeviceNameToConnected(clean);
      },

      /** Statted via the worker's `fs.stat` — requires an authenticated connection. @returns {Promise<WorkerPathStat>} */
      statWorkerPath: async (path) => {
        const { _client } = get();
        if (!_client || !_client.authenticated) {
          throw new Error("Not connected to worker");
        }
        try {
          const result = await _client.fsStat(path);
          return { exists: true, type: result.type, shared: result.shared };
        } catch (err) {
          if (err instanceof WorkerProtocolError && err.code === FS_NOT_FOUND) {
            return { exists: false };
          }
          if (err instanceof WorkerProtocolError && err.code === FS_FORBIDDEN) {
            // An older worker refuses anything outside its shared folders.
            return { exists: false, forbidden: true };
          }
          throw err;
        }
      },

      /** Add (or replace, by `rule.local`) one path rule for `workerId`. */
      addPathRule: (workerId, rule) => {
        set((state) => ({
          pairedWorkers: state.pairedWorkers.map((w) =>
            w.nodeId === workerId
              ? { ...w, pathRules: [...(w.pathRules ?? []).filter((r) => r.local !== rule.local), rule] }
              : w,
          ),
        }));
      },

      /** Remember (or with `null`, forget) the output folder picked for a project on `workerId`. */
      setOutputDir: (workerId, projectKey, dir) => {
        set((state) => ({
          pairedWorkers: state.pairedWorkers.map((w) => {
            if (w.nodeId !== workerId) return w;
            const outputDirs = { ...(w.outputDirs ?? {}) };
            if (dir) outputDirs[projectKey] = dir;
            else delete outputDirs[projectKey];
            return { ...w, outputDirs };
          }),
        }));
      },

      /** Remove the rule (if any) whose `local` matches, for `workerId`. */
      clearPathRule: (workerId, local) => {
        set((state) => ({
          pairedWorkers: state.pairedWorkers.map((w) =>
            w.nodeId === workerId
              ? { ...w, pathRules: (w.pathRules ?? []).filter((r) => r.local !== local) }
              : w,
          ),
        }));
      },

      /**
       * Submits to the selected worker; resolves when it (or a multi-model spec's last job) ends.
       * @param {Record<string, any>} spec @param {JobLogHandler} onProgress @param {SubmitJobOptions} [options]
       */
      submitJob: async (spec, onProgress, options) => {
        const { _client, selectedWorkerId } = get();
        if (!_client || !_client.authenticated || !selectedWorkerId) {
          throw new Error("Not connected to a worker");
        }

        // One run id per call (even one job); `options.run` reuses an existing id (+ `stage`).
        const runId = options?.run?.id ?? deps.randomUUID();
        const runStage = options?.run?.stage;
        const makeRun = (index, count) => ({
          id: runId,
          index,
          count,
          ...(runStage ? { stage: runStage } : {}),
        });
        const tag = jobTag(options);

        if (isMultiModelTrainSpec(spec)) {
          const modelTypes = spec.model_types ?? [];
          const n = spec.config_contents.length;
          let finalResult = { jobId: "", success: true };
          for (let i = 0; i < n; i++) {
            const perModelSpec = {
              ...spec,
              config_contents: [spec.config_contents[i]],
              model_types: modelTypes[i] ? [modelTypes[i]] : [],
              run: makeRun(i, n),
            };
            finalResult = await submitSingleJob(
              _client,
              selectedWorkerId,
              perModelSpec,
              onProgress,
              set,
              options?.onTelemetry && ((t) => options.onTelemetry(t, i)),
              tag,
            );
            if (!finalResult.success) return finalResult;
            // Intermediate models only; the last one is the return value.
            if (i < n - 1) options?.onModelComplete?.(finalResult);
          }
          return finalResult;
        }

        return submitSingleJob(
          _client,
          selectedWorkerId,
          { ...spec, run: makeRun(0, 1) },
          onProgress,
          set,
          options?.onTelemetry && ((t) => options.onTelemetry(t, 0)),
          tag,
        );
      },

      /**
       * Submits to `workerId` without waiting: every job (multi-model split up front) is tracked and
       * watched in the background, chained jobs too. Returns the job ids in run order.
       * LUCID: `opts.run` groups several calls as one run; `opts.label` overrides the label.
       * @param {{ source: TrackedJob["source"], sessionId?: string, camera?: string, projectTag?: string, mergeMode?: string, run?: { id: string, index: number, count: number }, label?: string }} opts
       * @returns {Promise<string[]>}
       */
      submitJobsOn: async (workerId, spec, opts) => {
        const client = await get().clientFor(workerId);
        const workerLabel = get().pairedWorkers.find((w) => w.nodeId === workerId)?.label ?? workerId;
        const runId = opts.run?.id ?? deps.randomUUID();
        const tag = jobTag(opts);

        const onChainedJobIds = (chainedIds) => {
          for (const chainedId of chainedIds) {
            trackChainedJob(set, client, workerId, chainedId, opts.source, workerLabel, tag);
          }
        };

        const submitTracked = async (oneSpec) => {
          const { jobId } = await client.jobsSubmit(withYamlRunName(oneSpec, yamlLoad));
          const tracked = {
            workerId,
            jobId,
            lastSeq: 0,
            kind: oneSpec.type,
            label: opts.label ?? trackedJobLabel(oneSpec),
            source: opts.source,
            state: "active",
            seen: false,
            submittedAt: Date.now(),
            ...tag,
          };
          set((state) => ({ trackedJobs: capTrackedJobs([...state.trackedJobs, tracked]) }));
          void watchTrackedJob(set, client, tracked, workerLabel, onChainedJobIds);
          return jobId;
        };

        if (isMultiModelTrainSpec(spec)) {
          const modelTypes = spec.model_types ?? [];
          const n = spec.config_contents.length;
          const jobIds = [];
          // Every model's job is submitted up front — unlike `submitJob`,
          // nothing here awaits a prior model finishing before queuing the next.
          for (let i = 0; i < n; i++) {
            const perModelSpec = {
              ...spec,
              config_contents: [spec.config_contents[i]],
              model_types: modelTypes[i] ? [modelTypes[i]] : [],
              run: { id: runId, index: i, count: n },
            };
            jobIds.push(await submitTracked(perModelSpec));
          }
          return jobIds;
        }

        const run = opts.run ?? { id: runId, index: 0, count: 1 };
        return [await submitTracked({ ...spec, run: { id: runId, index: run.index, count: run.count } })];
      },

      /** Hard-cancel every unfinished job of run `runId` (default: the latest active tracked job's run). */
      cancelJob: (runId) => {
        void endCurrentRun("cancel", runId);
        set({ reattachableJob: null });
      },

      /** Gracefully early-stop the model in progress of run `runId` (default: the latest active tracked job's run). */
      stopJob: (runId) => {
        void endCurrentRun("stop", runId);
        set({ reattachableJob: null });
      },

      /** A result blob's bytes. LUCID: `options` (`{fsFallback}`) goes to `WorkerClient.fetchBlob`. */
      fetchResultBlob: async (ref, options) => {
        const { _client, activeTransport } = get();
        if (!_client || !_client.authenticated) {
          throw new Error("Not connected to a worker");
        }
        if (activeTransport === "iroh") {
          // No ws:// URL to derive the blob port from: use the iroh blob stream.
          return fetchOverIroh(_client, ref, options);
        }
        return options
          ? _client.fetchBlob(ref.sha256, ref.size, options)
          : _client.fetchBlob(ref.sha256, ref.size);
      },

      /** LUCID: `fetchResultBlob` for ANY paired worker (via `clientFor`). */
      fetchResultBlobOn: async (workerId, ref, options) => {
        const client = await get().clientFor(workerId);
        if (!client.authenticated) throw new Error("Not connected to a worker");
        if (managed.get(workerId)?.route === "iroh") return fetchOverIroh(client, ref, options);
        return options
          ? client.fetchBlob(ref.sha256, ref.size, options)
          : client.fetchBlob(ref.sha256, ref.size);
      },

      /** LUCID: `fetchedAt = now`, letting `capTrackedJobs` evict the job; no-op if unknown. */
      markJobFetched: (jobId) => {
        if (!get().trackedJobs.some((j) => j.jobId === jobId)) return;
        updateTrackedJob(set, jobId, { fetchedAt: Date.now() });
      },

      /** On launch: reconnects workers with active jobs, catches up finished ones, re-watches the rest. */
      resumeTrackedJobs: async () => {
        const jobsByWorker = new Map();
        for (const job of get().trackedJobs) {
          if (job.state !== "active") continue;
          const list = jobsByWorker.get(job.workerId);
          if (list) list.push(job);
          else jobsByWorker.set(job.workerId, [job]);
        }

        for (const [workerId, jobs] of jobsByWorker) {
          const worker = get().pairedWorkers.find((w) => w.nodeId === workerId);
          if (!worker) continue; // forgotten since the job was tracked — nothing to resume
          if (worker.unpairedAt) continue; // refused this device; re-pair to resume

          let client;
          try {
            client = await ensureConnection(workerId).start();
          } catch (err) {
            // A failed start() never retries; jobs stay "active" for a later connect or launch.
            console.warn(`[connect] resumeTrackedJobs: couldn't reconnect to ${worker.label}:`, err);
            managed.delete(workerId);
            continue;
          }

          for (const job of jobs) {
            let status;
            try {
              status = await client.jobsStatus(job.jobId);
            } catch {
              continue; // worker no longer recognizes the job — leave as-is
            }

            if (TERMINAL_JOB_STATES.has(status.state)) {
              const trackedState = status.state;
              updateTrackedJob(set, job.jobId, {
                state: trackedState,
                ...(trackedState !== "completed" ? { error: status.error ?? undefined } : {}),
              });
              await notifyJobFinished({ ...job, state: trackedState }, worker.label, status.error);
              // Finished while closed: no job.result replay, so take chained ids from the stored result.
              const chainedIds = status.result?.chained_job_ids;
              if (Array.isArray(chainedIds)) {
                for (const chainedId of chainedIds) {
                  if (typeof chainedId !== "string") continue;
                  trackChainedJob(set, client, workerId, chainedId, job.source, worker.label, job);
                }
              }
              continue;
            }

            await watchTrackedJob(set, client, job, worker.label, (chainedIds) => {
              for (const chainedId of chainedIds) {
                trackChainedJob(set, client, workerId, chainedId, job.source, worker.label, job);
              }
            });
          }
        }
      },
    }),
    {
      name: CONNECT_STORAGE_KEY,
      version: CONNECT_PERSIST_VERSION,
      storage: sharedConnectStorage,
      partialize: sharedSlice,
      merge: (persisted, current) => {
        const shared = toShared(persisted);
        if (!shared) return current;
        const session = readSessionSelection();
        const wanted = session !== undefined ? session : shared.lastSelectedWorkerId;
        const paired = shared.pairedWorkers.some((w) => w.nodeId === wanted);
        return { ...current, ...shared, selectedWorkerId: paired ? wanted : null };
      },
      migrate: migrateConnectPersisted,
    },
  ),
);

/** Alias of `useConnectStore` (it is not a React hook in LUCID). */
export const connectStore = useConnectStore;

// Keep this window's selection across reloads and offer it to the next window (installed unconditionally).
useConnectStore.subscribe((state, prev) => {
  if (state.selectedWorkerId === prev.selectedWorkerId) return;
  writeSessionSelection(state.selectedWorkerId);
  if (state.selectedWorkerId && state.selectedWorkerId !== state.lastSelectedWorkerId) {
    useConnectStore.setState({ lastSelectedWorkerId: state.selectedWorkerId });
  }
});
