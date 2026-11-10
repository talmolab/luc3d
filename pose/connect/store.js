/**
 * Port of sleap-app src/stores/connectStore.ts @ 683a159.
 *
 * Connection to sleap-connect workers (protocol v1, pairing model): the app persists a small
 * list of workers it has paired with (keyed by `node_id`, Syncthing/Plex-style), holds one
 * `ManagedConnection` per worker that is selected or has an active tracked job, tracks the jobs
 * it submitted (so a reload resumes them), and shares the pairing/tracking state across windows
 * through localStorage with a three-way merge (`connect-sync.js`, #453).
 *
 * The state, every action, and every module-level helper of connectStore are here with the same
 * names, error strings, timeouts and control flow. The pure helpers (`capTrackedJobs`,
 * `migrateConnectPersisted`, `runJobsToEnd`, ...) live in `store-helpers.js` (P1) and are
 * re-exported from here so a caller needs one import.
 *
 * Known interim gap carried over from sleap-app (worker side, not new): the worker's
 * `CommandBuilder.build_command` only runs `config_contents[0]`, so a multi-model train spec is
 * submitted as one job per model (`submitJob` sequentially, `submitJobsOn` all up front). This is
 * inert in LUCID (training UI is out of scope) but kept so the persisted shape and `run` grouping
 * match sleap-app's.
 *
 * LUCID changes:
 *  - zustand -> `./mini-store.js` (`createStore` + `persist`, same semantics). The store is a
 *    module singleton `useConnectStore` (name kept; it is NOT a React hook here — use
 *    `getState / setState / subscribe`). `connectStore` is an alias.
 *  - Everything that differed per runtime is an INJECTED dep, set with `configureConnect(patch)`
 *    (defaults in `DEFAULT_DEPS`, resolved when used, never at import time):
 *      `WorkerClient` (default `./client.js`), `getClientIdentity` (default `./identity.js`),
 *      `localStorage` / `sessionStorage` (default: the globals, looked up at call time; absent =
 *      nothing persisted, as in sleap-app's `localStore()`), `notify` (see below),
 *      `openConnectWindow` (what the toast's "Open" button does; sleap-app: `useAppStore.setConnectWindowOpen(true)`;
 *      default none), `appVersion` (default `"dev"`) and `platform` (`"tauri" | "web"`, default `"web"`) for the
 *      hello `agent`, `computerName` (sleap-app: the Tauri `computer_name` command; default none, so the
 *      default device name is "<Browser> on <OS>") and `userAgent`, `pathMappingsStorage` (the
 *      `~/.sleap-connect/config.toml` adapter for the one-time legacy path-rule import; default none = no
 *      import), `yamlLoad` (the YAML parser `withYamlRunName` needs; default none = specs unchanged),
 *      `randomUUID`.
 *    The iroh socket is the transport's registered factory (`registerIrohSocketFactory`, `transport.js`);
 *    iroh is "available" exactly when one is registered. sleap-app's `isTauri` / `tauriIrohSocket` /
 *    `sleapCmd` bits have no other counterpart here.
 *  - Notifications: sleap-app imports `toast` from `@/lib/notify`. Here `deps.notify` is
 *    `{ success(message, opts), error(message, opts), info(message, opts) }` with `opts = { description?,
 *    action?: { label, onClick } }` — the same call shapes and message strings (default: no-ops). The UI
 *    supplies toasts later.
 *  - The `window` `storage` listener and the selection-persisting subscription are not installed by
 *    importing the module: the selection subscription is installed at creation (sessionStorage is
 *    injected / looked up at call time and failures are swallowed), and the UI wires the cross-window
 *    listener with `installConnectStorageSync(window)` (or calls `syncConnectFromStorage(e.newValue)` itself).
 *  - `persist` hydrates at creation from `deps.localStorage ?? globalThis.localStorage` when one exists;
 *    after `configureConnect({localStorage})` call `useConnectStore.persist.rehydrate()` to re-read.
 *  - Storage keys are `lucid-connect` / `lucid-connect-selected` (`store-helpers.js`), and the hello agent
 *    name is `"lucid"` (sleap-app: `"sleap-app"`).
 *  - LUCID multi-view: a tracked job may carry `{sessionId, camera, projectTag}` (one job per
 *    (session, camera)). Pass them in `submitJob`'s `options` / `submitJobsOn`'s `opts`; they are copied onto
 *    the `TrackedJob` (and onto jobs the worker chains from it). Absent when not given, so sleap-app-shaped
 *    entries are unchanged. `fetchResultBlob(ref, options)` forwards an optional `{fsFallback}` to
 *    `WorkerClient.fetchBlob` (a ws:// worker whose blob port is unreachable from a browser page).
 *  - `submitJobsOn(workerId, spec, {run?, label?})`: `run` (`{id, index, count}`) replaces the minted run id so one
 *    batch over (session, camera) is one run; `label` is the tracked job's label. `fetchResultBlobOn(workerId,
 *    ref, options)` is `fetchResultBlob` over that worker's managed connection. `markJobFetched(jobId)` sets the
 *    job's `fetchedAt` (null until then): `capTrackedJobs` keeps an unfetched, completed, LUCID-tagged job.
 *  - `watchTrackedJob` persists `lastSeq` at most every 2 s (as `submitSingleJob` does); a state change persists
 *    at once with the latest seq.
 *  - `planPairingForText(text, addrOverride)` is a non-throwing `readCodeInfo` + `planPairing` for the pairing
 *    form's live status line. `readCodeInfo` has one definition (`worker-ui-helpers.js`), re-exported here.
 *  - The selection-persisting `subscribe` is installed when the module is created (after the import-time
 *    hydrate), so a later `persist.rehydrate()` (after `configureConnect({localStorage})`) fires it: the fresh
 *    window's `lastSelectedWorkerId` is written to sessionStorage at once (sleap-app installs it after its single
 *    hydrate, so it never sees a second one).
 *  - Added: `pairWithCode(text, addrOverride)` (the pairing form's `readCodeInfo` -> `planPairing` -> `pairWithTicket`
 *    sequence from `PairWorkerForm.tsx`, mapping a decoded code `{expires_at, addrs, iroh}` to
 *    `{expiresAt, addrs, hasRelay: !!iroh}`), plus exported `readCodeInfo`, `agentInfo`, `configureConnect`,
 *    `installConnectStorageSync`, `__resetConnectState`.
 *
 * Training-only pieces (`TrainJobSpec` splitting, `withYamlRunName`, `onModelComplete` / `onTelemetry`,
 * `run.stage`) are ported and inert until something submits a train spec.
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

/**
 * A `job.log` line; `isProgress` = replace the previous progress line.
 * @typedef {(line: string, isProgress?: boolean) => void} JobLogHandler
 */

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

/**
 * @typedef {object} ConnectDeps
 * @property {typeof DefaultWorkerClient | (new (opts: any) => any)} WorkerClient
 * @property {() => Promise<any>} getClientIdentity
 * @property {Storage | null | undefined} localStorage undefined = the global, looked up at call time.
 * @property {Storage | null | undefined} sessionStorage undefined = the global, looked up at call time.
 * @property {Notifier} notify
 * @property {(() => void) | null} openConnectWindow
 * @property {string} appVersion
 * @property {"tauri" | "web"} platform
 * @property {(() => Promise<string | null | undefined>) | null} computerName
 * @property {string | undefined} userAgent
 * @property {import("./path-mappings.js").PathMappingsStorage | null} pathMappingsStorage
 * @property {((text: string) => any) | null} yamlLoad
 * @property {() => string} randomUUID
 */

/** @returns {ConnectDeps} */
function defaultDeps() {
  return {
    WorkerClient: DefaultWorkerClient,
    getClientIdentity: defaultGetClientIdentity,
    localStorage: undefined,
    sessionStorage: undefined,
    notify: NOOP_NOTIFY,
    openConnectWindow: null,
    appVersion: "dev",
    platform: "web",
    computerName: null,
    userAgent: undefined,
    pathMappingsStorage: null,
    yamlLoad: null,
    randomUUID: () => globalThis.crypto.randomUUID(),
  };
}

/** @type {ConnectDeps} */
let deps = defaultDeps();

/**
 * Sets injected dependencies (see the header). Merges into the current ones; call
 * `configureConnect(null)` to restore every default.
 * @param {Partial<ConnectDeps> | null} patch
 */
export function configureConnect(patch) {
  deps = patch === null ? defaultDeps() : { ...deps, ...patch };
}

/** The hello `agent` this app reports (the device name is added per connection). */
export function agentInfo() {
  return { name: "lucid", version: deps.appVersion, platform: deps.platform };
}

// ── Helpers that close over the store / transports / storage ──────

/** @type {Map<string, import("./managed-connection.js").ManagedConnection>} One `ManagedConnection` per worker that's selected or has an active tracked job. */
const managed = new Map();

/** `clientFor`'s in-flight initial dials, so concurrent calls for one worker share a single `start()`. */
const clientForStarts = new Map();

/** @type {{ now?: () => number, sleep?: (ms: number) => Promise<void> }} */
let managedDeps = {};

/** Test-only hook: inject a fake clock into every `ManagedConnection` this store creates from here on. */
export function __setManagedDeps(next) {
  managedDeps = next;
}

/**
 * Test-only: stops and drops every managed connection (module-level state outlives a test).
 */
export function __resetManagedConnections() {
  for (const mc of managed.values()) mc.stop();
  managed.clear();
  clientForStarts.clear();
}

/**
 * Test-only (LUCID): also forgets the other module-level state — live job subscriptions, the
 * "already notified" set, the cached default device name and the cross-window merge base — and
 * restores the default deps and the real clock.
 */
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

/**
 * This window's saved selection: a worker id, `null` = deliberately none, `undefined` = never chosen here.
 * @returns {string | null | undefined}
 */
function readSessionSelection() {
  try {
    const v = sessionStore()?.getItem(SELECTED_WORKER_SESSION_KEY);
    return v === null || v === undefined ? undefined : v || null;
  } catch {
    return undefined;
  }
}

/** @param {string | null} id */
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

/**
 * LUCID: the tag fields a job entry carries, taken from submit options (only those given).
 * @param {{ sessionId?: string, camera?: string, projectTag?: string, mergeMode?: string } | undefined} o
 */
function jobTag(o) {
  /** @type {{ sessionId?: string, camera?: string, projectTag?: string, mergeMode?: string, fetchedAt?: number | null }} */
  const tag = {};
  if (o?.sessionId !== undefined) tag.sessionId = o.sessionId;
  if (o?.camera !== undefined) tag.camera = o.camera;
  if (o?.projectTag !== undefined) tag.projectTag = o.projectTag;
  // The panel's "Existing predictions" mode at Run, used at Fetch & Load (sleap-app `pendingRemoteMerge.mode`).
  if (o?.mergeMode !== undefined) tag.mergeMode = o.mergeMode;
  // Null until `markJobFetched` records that the result was loaded (see `capTrackedJobs`).
  if (tag.sessionId !== undefined || tag.camera !== undefined) tag.fetchedAt = null;
  return tag;
}

/**
 * Explicit if given, else the worker's own remembered preference (never a route arrived at only via an automatic fallback).
 * @param {PairedWorker} worker
 * @param {ConnectOptions} [options]
 * @returns {TransportKind}
 */
function resolvePreferredTransport(worker, options) {
  return (
    options?.transport ??
    (worker.transport === "iroh" && worker.iroh && irohTransportAvailable() ? "iroh" : "ws")
  );
}

const IROH_DESKTOP_ONLY =
  "Connecting over the internet needs the desktop app — in the browser, use the worker's network address.";

/**
 * What to dial: `url` is a ws address, or the encoded iroh target for `"iroh"`.
 * @typedef {{ transport: TransportKind, url: string, display: string }} DialSpec
 */

/**
 * LUCID (P8): a result blob over the iroh blob stream (`iroh-blob.js`, registered by the desktop app
 * through `registerIrohBlobFetcher`). Without a fetcher, or a connection id, it says so as sleap-app's
 * refusal did. `options.onProgress` (or `options.fsFallback.onProgress`, which Fetch & Load passes)
 * receives `(done, total)`; there is no `fs.read` fallback here — the iroh stream IS the fallback.
 *
 * @param {any} client @param {{ sha256: string, size?: number }} ref @param {any} [options]
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

/** @returns {Promise<DialSpec>} */
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

/** @type {Promise<string> | null} */
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

/**
 * Dials, verifies, and authenticates against an already-paired worker over
 * `route` — the `ManagedConnectionDeps.dial` this store hands every
 * `ManagedConnection` it creates, and what `connectToWorker`'s initial connect
 * also goes through. Closes the client and re-throws on any failure after the
 * socket opened, so a caller never has to.
 *
 * @param {PairedWorker} worker
 * @param {TransportKind} route
 * @returns {Promise<WorkerClient>}
 */
async function dialWorker(worker, route) {
  /** @type {DialSpec} */
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
    // Same code (so `isUnpairedError` still matches), friendlier words than
    // the worker's "Node '<id>' is not paired with this worker".
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

/**
 * Stop Early / Cancel for the selected worker's current run (see `runJobsToEnd`).
 * A failure gets a toast: the panel already logged "Stop Early requested", so a
 * silent failure would leave it waiting.
 * @param {"cancel" | "stop"} mode
 * @param {string} [runId]
 */
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

/**
 * The shared copy this window last read or wrote — the `base` of every
 * three-way merge (`mergeShared`). `null` until this window has read a
 * current-version copy, so its first save unions instead of deleting.
 * @type {SharedConnectState | null}
 */
let sharedBase = null;

/**
 * Puts a merged shared state into this window's store, and undoes locally
 * whatever another window's change implies: a worker it forgot is
 * disconnected here too (without `clients.leave` — the forgetting window
 * already told the worker), and a new device name is pushed to this window's
 * connected workers.
 * @param {SharedConnectState} merged
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
 * The `persist` storage: every save is a three-way merge into the stored
 * copy (`mergeShared`) instead of an overwrite, so a stale window can't undo
 * another window's pairings, forgets, path rules or tracked jobs (#453). If
 * the merge brought in another window's changes, they're applied to this
 * window's store too.
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
    // LUCID: a storage that throws (quota, Safari private mode) must never break the action that
    // changed the state: the in-memory store stays right, the save is just lost.
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
        // LUCID: `sharedBase` stays at the copy this window has APPLIED until `merged` really is in
        // the store (a save made in between would otherwise read the other window's records as
        // this window's reverts), and what changed here in the meantime is merged over it.
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

/**
 * Applies a save made in ANOTHER tab/window (same origin = same identity,
 * same shared Connect state). Every tab keeps its own in-memory store, so
 * the stored copy is merged in (`mergeShared`, against the copy this tab
 * last saw) rather than ignored — otherwise this tab would show a stale
 * worker list and its next save would undo the other tab's changes. Takes
 * the raw persisted value (`storage` event `newValue`); a no-op if it's
 * unparseable or changes nothing here.
 *
 * @param {string | null} newValue
 */
export function syncConnectFromStorage(newValue) {
  const theirs = readStoredShared(newValue);
  if (!theirs) return;
  const mine = sharedSlice(useConnectStore.getState());
  const merged = capShared(mergeShared(sharedBase, mine, theirs));
  sharedBase = theirs;
  if (!sameShared(merged, mine)) applyShared(merged);
}

/**
 * Wires `syncConnectFromStorage` to a window's `storage` events (sleap-app does this at import when
 * `window` exists; here the UI calls it). Returns a function that removes the listener.
 * @param {{ addEventListener: Function, removeEventListener: Function } | undefined} [target] default `globalThis.window`
 */
export function installConnectStorageSync(target = globalThis.window) {
  if (!target || typeof target.addEventListener !== "function") return () => {};
  const listener = (e) => {
    if (e.key === CONNECT_STORAGE_KEY) syncConnectFromStorage(e.newValue);
  };
  target.addEventListener("storage", listener);
  return () => target.removeEventListener("storage", listener);
}

// ── Managed connections ───────────────────────────────────────────

/**
 * Gets (or lazily creates) the `ManagedConnection` for `nodeId`, wiring its
 * status/connected callbacks into the store. Creating one does NOT dial —
 * the caller still calls `.start()` (or, per `ManagedConnection`'s own
 * contract, reuses `.client` if already connected).
 *
 * @param {string} nodeId
 * @param {ConnectOptions} [options]
 */
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
      // A forgotten worker's connection can still report in while Forget
      // tells the worker (`clients.leave`) — it's no longer ours to track.
      if (!useConnectStore.getState().pairedWorkers.some((w) => w.nodeId === nodeId)) return;
      useConnectStore.setState((state) => {
        /** @type {Record<string, any>} */
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
        // Best-effort: keeps `workerMounts` current across an automatic
        // reconnect the selected-worker UI didn't otherwise ask for. The
        // EXPLICIT connectToWorker flow below does its own awaited fetch for
        // deterministic UI state right when "connected" first appears.
        void client
          .fsMounts()
          .then((mounts) => useConnectStore.setState({ workerMounts: mounts }))
          .catch(() => {});
      }
      // Always — even for a worker that isn't selected, a background job
      // still needs its subscription re-attached to the new client.
      resubscribeWorker(nodeId, client);
    },
    now: managedDeps.now,
    sleep: managedDeps.sleep,
  });
  managed.set(nodeId, mc);
  return mc;
}

/**
 * If `trackedJob` belongs to `workerId` (the worker we just connected to)
 * and is still active there, returns it as a `ReattachableJob`; otherwise
 * `null` (nothing to reattach to — wrong worker, already finished, or the
 * worker no longer recognizes the job at all).
 *
 * @param {WorkerClient} client
 * @param {string} workerId
 * @param {TrackedJob | null} trackedJob
 * @returns {Promise<ReattachableJob | null>}
 */
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
 * One job's live event subscription, tracked at module level (NOT persisted
 * — it's rebuilt fresh every session) so a reconnect can re-attach it to a
 * new `WorkerClient` without the submitting `submitJob` promise ever
 * knowing its connection was replaced underneath it. Keyed by `jobId`.
 * @typedef {{ workerId: string, jobId: string, handle: (event: WorkerEvent) => void, unsubscribe: (() => void) | null, abort?: (err: Error) => void, attempt?: number }} ActiveSubscription
 */
/** @type {Map<string, ActiveSubscription>} */
const activeSubscriptions = new Map();

/**
 * (Re)subscribes `sub` on `client` starting from `sinceSeq`, dropping any prior subscription first.
 * @param {WorkerClient} client @param {ActiveSubscription} sub @param {number} sinceSeq
 */
async function attachSubscription(client, sub, sinceSeq) {
  sub.unsubscribe?.();
  sub.unsubscribe = null;
  // LUCID: a later attach (a reconnect) or the job finishing / being dropped while this one is in
  // flight must not leave this client's listener behind (or overwrite the newer `unsubscribe`).
  const attempt = (sub.attempt = (sub.attempt ?? 0) + 1);
  const unsubscribe = await client.jobsSubscribe(sub.jobId, sinceSeq, sub.handle);
  if (sub.attempt !== attempt || activeSubscriptions.get(sub.jobId) !== sub) {
    unsubscribe();
    return;
  }
  sub.unsubscribe = unsubscribe;
}

/**
 * LUCID: stops watching every job of `workerId` (the worker was forgotten here or in another
 * window). A `submitJob` still waiting on one is rejected rather than left hanging.
 * @param {string} workerId
 */
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

/**
 * Re-attaches every active subscription belonging to `workerId` onto a newly
 * (re)connected `client`, resuming each from its last-applied seq. Called by
 * `ManagedConnection`'s `onConnected` for every reconnect/route switch, not
 * just the selected worker's — a background job on an unselected-but-tracked
 * worker still needs to keep receiving events.
 *
 * @param {string} workerId @param {WorkerClient} client
 */
export function resubscribeWorker(workerId, client) {
  for (const sub of activeSubscriptions.values()) {
    if (sub.workerId !== workerId) continue;
    // LUCID: a failed re-attach (the new connection dropped again, the job is gone) is retried by
    // the next reconnect; it must not surface as an unhandled rejection.
    attachSubscription(client, sub, trackedLastSeq(sub.jobId)).then(() => reconcileTerminalJob(client, sub)).catch((err) => {
      console.warn(`[connect] couldn't re-attach job ${sub.jobId}:`, err);
    });
  }
}

/**
 * LUCID: after a re-attach, asks the worker for the job's own state. A worker that was restarted
 * (crash, reboot) marks the jobs it lost `failed` WITHOUT sending a `job.status` event, so the
 * backlog replay never ends the job and it would read "Running" for ever. A terminal state found
 * here is fed to the watcher as the events it missed (`job.result`, then `job.status`) with a
 * seq past anything real, so it is applied once and the replay can't re-apply it.
 *
 * @param {WorkerClient} client @param {ActiveSubscription} sub
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

/**
 * Merges `patch` into one tracked job by `jobId`, leaving every other job untouched.
 * @param {ConnectSet} set @param {string} jobId @param {Partial<TrackedJob>} patch
 */
function updateTrackedJob(set, jobId, patch) {
  set((state) => ({
    trackedJobs: state.trackedJobs.map((j) => (j.jobId === jobId ? { ...j, ...patch } : j)),
  }));
}

/**
 * Jobs already toasted this session — `resumeTrackedJobs` can run more than
 * once and must never show the same "finished"/"failed" toast twice for one job.
 */
const notifiedJobIds = new Set();

/**
 * Toasts that `job` reached a terminal state, once per job ever, through the
 * injected `notify`. A canceled job is the user's own action, not a failure —
 * it gets the neutral `info` toast, never `error`.
 *
 * @param {TrackedJob} job @param {string} workerLabel @param {string | null} [errorDetail]
 */
async function notifyJobFinished(job, workerLabel, errorDetail) {
  if (notifiedJobIds.has(job.jobId)) return;
  notifiedJobIds.add(job.jobId);
  // A one-click path to the Connect window (sleap-app PR4b §4b.2).
  const action = {
    label: "Open",
    onClick: () => deps.openConnectWindow?.(),
  };
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
 * Watches one tracked job to a terminal state without ever resolving a
 * caller's own promise — unlike `submitSingleJob`, nothing here awaits the
 * job finishing. Updates `trackedJobs.lastSeq` as events arrive, and once a
 * terminal `job.status` lands, records the final state and fires
 * `notifyJobFinished` (deduped there). Shared by `resumeTrackedJobs` and
 * `submitJobsOn`.
 *
 * `onChainedJobIds` fires when a `job.result` event carries `chained_job_ids`
 * (a train job's post-train chaining), letting `submitJobsOn` start tracking
 * those track jobs too.
 *
 * @param {ConnectSet} set @param {WorkerClient} client @param {TrackedJob} job
 * @param {string} workerLabel @param {(ids: string[]) => void} [onChainedJobIds]
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
    // LUCID: a dropped connection (not the worker refusing the subscribe) keeps the watcher
    // registered, so the reconnect's `resubscribeWorker` picks the job up again.
    if (!(err instanceof WorkerProtocolError) || err.code !== CLIENT_CLOSED) activeSubscriptions.delete(job.jobId);
    console.warn(`[connect] watchTrackedJob: failed to watch job ${job.jobId}:`, err);
  }
}

/**
 * Starts tracking and watching one job the WORKER produced on its own — a
 * chained post-train inference job this window never called `jobsSubmit` for —
 * so it shows up and its own finish toast still fires. A no-op if `jobId` is
 * already tracked. LUCID: `tag` (sessionId/camera/projectTag) is inherited from
 * the job that chained it.
 *
 * @param {ConnectSet} set @param {WorkerClient} client @param {string} workerId @param {string} jobId
 * @param {TrackedJob["source"]} source @param {string} workerLabel @param {object} [tag]
 */
function trackChainedJob(set, client, workerId, jobId, source, workerLabel, tag) {
  if (useConnectStore.getState().trackedJobs.some((j) => j.jobId === jobId)) return;
  /** @type {TrackedJob} */
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
 * Submits one job and resolves once it reaches a terminal state, forwarding
 * `job.log` lines to `onProgress` as they arrive. The subscription survives a
 * reconnect (registered in `activeSubscriptions`, re-attached by
 * `resubscribeWorker`): `since_seq: 0` is safe for the very first subscribe
 * since there's no backlog yet, and every event is deduped by seq so a
 * reconnect's backlog replay can never double-apply one already seen live.
 *
 * @param {WorkerClient} client @param {string} workerId @param {Record<string, any>} spec
 * @param {JobLogHandler} onProgress @param {ConnectSet} set
 * @param {((telemetry: any) => void) | undefined} [onTelemetry] @param {object} [tag] LUCID
 * @returns {Promise<Record<string, any>>}
 */
async function submitSingleJob(client, workerId, spec, onProgress, set, onTelemetry, tag) {
  const { jobId } = await client.jobsSubmit(withYamlRunName(spec, yamlLoad));
  /** @type {TrackedJob} */
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
    // job.result arrives before job.status: completed (the worker emits
    // them in that order specifically so this is never missed) — captured
    // here so it's already in hand by the time `finish` resolves.
    let resultBlobs;
    let modelDir;
    let labelsPath;
    let lastSeq = 0;
    let lastPersistedAt = 0;

    // Throttled so a fast stream of job.log/telemetry events doesn't write
    // to the store on every single one; always caught up on terminal below.
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
      // Keep the tracked entry (it's the Connect window's job history) and
      // just record its terminal state. `seen: true` here because this
      // window is live and watching it finish; resume-on-launch's toast
      // only fires for a job that reaches terminal while unwatched.
      updateTrackedJob(set, jobId, {
        state: trackedState,
        seen: true,
        lastSeq,
        ...(trackedState !== "completed" ? { error: result.error } : {}),
      });
      resolve(result);
    };

    /** @type {ActiveSubscription} */
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
        // The worker's `since_seq` is exclusive, but a live event can still
        // arrive both live (before a drop) and again in a reconnect's
        // backlog replay — drop anything already applied.
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        persistLastSeq();

        if (event.topic === "job.log") {
          onProgress(event.data.line ?? "", event.data.progress === true);
        } else if (event.topic === "job.result") {
          const blobs = event.data.blobs;
          if (blobs && Object.keys(blobs).length > 0) resultBlobs = blobs;
          // Train jobs only: the trained model folder + the labels file it
          // trained on, both worker-side paths (inputs to a follow-up track job).
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

// `readCodeInfo` lives in `worker-ui-helpers.js` (one definition); re-exported from here.
export { readCodeInfo };

/**
 * Non-throwing plan for the pairing form's live status line (PairWorkerForm.tsx's effect):
 * `readCodeInfo` + `planPairing`, with the same `{expiresAt, addrs, hasRelay}` mapping. Empty or
 * unreadable text gives `{kind: "error", message: NOT_A_CODE}`; it never throws.
 *
 * @param {string} text
 * @param {string} [addrOverride]
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

/**
 * The Connect store (singleton). State: `pairedWorkers, selectedWorkerId, lastSelectedWorkerId, trackedJobs,
 * deviceName` (persisted, shared across windows except `selectedWorkerId`, which is per window) and
 * `connectionStatus, connectionError, workerMounts, reattachableJob, activeTransport, connections, workerErrors,
 * workerInfo, _client` (runtime). Actions: see each entry below (same names and docs as connectStore.ts).
 */
export const useConnectStore = createStore(
  persist(
    (set, get) => ({
      // ── Persisted ──
      /** @type {PairedWorker[]} */
      pairedWorkers: [],
      /** The worker this window works with (per window: sessionStorage, not shared). @type {string | null} */
      selectedWorkerId: null,
      /** The worker some window most recently selected — shared; a new window's starting selection. @type {string | null} */
      lastSelectedWorkerId: null,
      /** @type {TrackedJob[]} */
      trackedJobs: [],
      /** The name this device reports to every worker; null = the OS computer name or "<Browser> on <OS>". @type {string | null} */
      deviceName: null,

      // ── Runtime (not persisted) ──
      /** @type {ConnectionStatus} */
      connectionStatus: "disconnected",
      /** @type {string | null} */
      connectionError: null,
      workerMounts: [],
      /** Set once per connect if the worker just connected to has an active tracked job. @type {ReattachableJob | null} */
      reattachableJob: null,
      /** @type {TransportKind | null} */
      activeTransport: null,
      /** Live link status per managed worker (keyed by `nodeId`). @type {Record<string, { status: string, route: TransportKind }>} */
      connections: {},
      /** Most recent `clientFor`/`refreshWorkerInfo` failure per worker. @type {Record<string, string | null>} */
      workerErrors: {},
      /** Last-fetched `worker.info` snapshot per worker. @type {Record<string, any>} */
      workerInfo: {},
      /** @type {WorkerClient | null} */
      _client: null,

      /**
       * A connected, authenticated client for ANY paired worker — not just the
       * selected one. Reuses that worker's managed connection if one already
       * exists; otherwise creates one and dials it. Records the failure in
       * `workerErrors` and drops the managed connection on a failed dial.
       * @param {string} workerId @returns {Promise<WorkerClient>}
       */
      clientFor: async (workerId) => {
        const existing = managed.get(workerId);
        if (existing?.client) return existing.client;
        // Automatic callers (the Connect window's refresh, etc.) don't keep
        // dialing a worker that has refused this device.
        if (get().pairedWorkers.find((w) => w.nodeId === workerId)?.unpairedAt) {
          throw new Error(UNPAIRED_MESSAGE);
        }
        // Concurrent callers (the Connect window fires info + jobs at once)
        // share one dial — `start()` isn't idempotent and a second call would
        // adopt a second client, leaking the first.
        const pending = clientForStarts.get(workerId);
        if (pending) return pending;
        // A managed connection with no client and no start of ours in flight
        // is either mid-reconnect (its own retry loop owns the redial) or
        // mid-`connectToWorker`/`resumeTrackedJobs` start — dialing here too
        // would race it. `connections[workerId]` already shows the status.
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

      /**
       * Stops and drops every managed connection that isn't the selected worker
       * and has no active tracked job.
       */
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

      /** Cancel/stop a job on ANY paired worker. @param {string} workerId @param {string} jobId @param {"cancel" | "stop"} mode */
      cancelJobOn: async (workerId, jobId, mode) => {
        const client = await get().clientFor(workerId);
        await client.jobsCancel(jobId, mode);
      },

      /**
       * Removes `jobIds`' records from `workerId` — job records only, nothing on
       * disk. All-or-nothing: throws `job.active` (and deletes nothing) if any of
       * `jobIds` is running or about to be. On success, prunes those ids from
       * `trackedJobs`, drops their live event subscriptions, and forgets their
       * `notifiedJobIds` entry.
       */
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

      /**
       * Claim a fresh pairing ticket (a one-line `sleap1…` code, or the legacy JSON ticket) and
       * connect. `options.transport` picks the dial explicitly (default `"ws"`); `"iroh"` needs a
       * registered iroh socket factory and an `iroh` section in the ticket.
       * @param {string} ticketJson @param {string} [addrOverride] @param {ConnectOptions} [options]
       */
      pairWithTicket: async (ticketJson, addrOverride, options) => {
        const trimmed = ticketJson.trim();
        /** @type {PairingTicket} */
        let ticket;
        if (isPairCode(trimmed)) {
          try {
            ticket = await decodePairCode(trimmed);
          } catch (err) {
            // Re-thrown as a plain Error (not PairCodeError) so callers that
            // branch on `instanceof Error` for the message don't need to
            // know about this module's error type.
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
        /** @type {DialSpec} */
        let dial;
        /** @type {string | undefined} */
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

        // LUCID: `_client` is the SELECTED worker's live client. Closing it while pairing a DIFFERENT
        // worker left that worker's managed connection holding a dead client (clientFor then answered
        // "Not connected" until the next unload). Back the other worker off like connectToWorker does
        // (kept alive when it has an active job, else stopped); only a same-node leftover is closed.
        {
          const { selectedWorkerId: sel } = get();
          if (sel && sel !== ticket.node_id) get().disconnect();
          else get()._client?.close();
        }
        set({ connectionStatus: "connecting", connectionError: null, activeTransport: transport });

        /** @type {WorkerClient | null} */
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

          /** @type {PairedWorker} */
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
          // client.connect() may have already opened a real socket even
          // though a later step (pairClaim/fsMounts) failed — close it so
          // it isn't leaked, unreachable from store state but still live.
          client?.close();
          set({
            connectionStatus: "error",
            connectionError: err instanceof Error ? err.message : String(err),
            _client: null,
          });
          throw err;
        }

        // Paired. Hand the worker to a managed connection (now via
        // auth.prove, since this client is trusted) so a drop right after
        // pairing reconnects like any other. connectToWorker closes the
        // pairing client. If this re-dial fails, the pairing itself still
        // stands; connectToWorker has already put the error in
        // connectionStatus/connectionError.
        try {
          await get().connectToWorker(ticket.node_id, { transport });
        } catch {
          // Surfaced via connectionError; the worker stays paired.
        }
      },

      /**
       * LUCID: the pairing form's whole flow for pasted text — read it (`readCodeInfo`), plan the
       * route (`planPairing`: iroh when a factory is registered and the code has a relay, else ws),
       * then `pairWithTicket` over that route. Throws the plan's message when it can't be reached.
       * @param {string} text @param {string} [addrOverride]
       */
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

      /**
       * Reconnect to an already-paired worker by node_id. Without an explicit
       * `options.transport`, reuses the transport last connected over (`"ws"`
       * if none, or if iroh is remembered but unavailable here).
       * @param {string} nodeId @param {ConnectOptions} [options]
       */
      connectToWorker: async (nodeId, options) => {
        const worker = get().pairedWorkers.find((w) => w.nodeId === nodeId);
        if (!worker) {
          throw new Error("Unknown worker — pair with it first.");
        }

        const previousSelected = get().selectedWorkerId;
        if (previousSelected && previousSelected !== nodeId) {
          // Switching the selected worker: back the old one off the same way
          // an explicit disconnect() would (kept alive in the background if
          // it still has an active job, otherwise fully stopped).
          get().disconnect();
        }

        // An explicit connect to THIS worker always gets a fresh, verified
        // connection: tear down any existing managed connection for it, and
        // close any client left over from `pairWithTicket` (which doesn't
        // itself register a managed connection). Closing an already-closed
        // client is a harmless no-op.
        managed.get(nodeId)?.stop();
        managed.delete(nodeId);
        if (get().selectedWorkerId === nodeId) get()._client?.close();

        set({
          selectedWorkerId: nodeId,
          connectionStatus: "connecting",
          connectionError: null,
        });

        const mc = ensureConnection(nodeId, options);
        /** @type {WorkerClient} */
        let client;
        // Shared with `clientFor`, so a pane asking for this worker while we
        // connect waits for this dial instead of failing "reconnecting".
        const start = mc.start();
        clientForStarts.set(nodeId, start);
        // LUCID: this connect is superseded once its connection was stopped or replaced (the user
        // selected another worker or disconnected, another window or Forget dropped the worker,
        // a second connect to it started). A superseded connect reports to its caller only; it
        // never writes status/client over whatever replaced it.
        const superseded = () => managed.get(nodeId) !== mc;
        const stoppedError = () =>
          new WorkerProtocolError(CLIENT_CLOSED, "Connection stopped before it finished connecting");
        try {
          client = await start;
        } catch (err) {
          if (clientForStarts.get(nodeId) === start) clientForStarts.delete(nodeId);
          if (superseded()) throw err;
          // start() never adopted a client on failure — nothing to stop() —
          // just drop the dead instance so the next attempt builds a fresh one.
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
          // Remembered here (not in `ensureConnection`'s `onConnected`, which
          // also fires for every automatic reconnect/fallback) so a route
          // ManagedConnection falls back to on its own is never persisted as
          // the user's preference — only an explicit choice (or the worker's
          // own already-remembered one) is.
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
          // Same leak risk as in pairWithTicket: fsMounts/checkReattach
          // failing after a successful dial still needs the client closed,
          // so route it through the managed connection's own stop().
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

        // One-time import of this worker's legacy global path mappings
        // (`~/.sleap-connect/config.toml`, pre-dating per-worker `pathRules`) —
        // only on a worker that's never had `pathRules` set at all (`[]`
        // counts as "already handled"). Outside the try/catch above on
        // purpose: `loadSavedMappings` swallows its own errors (returns `[]`),
        // so nothing here turns a successful connect into a connection error.
        // LUCID: the config-file adapter is the injected `pathMappingsStorage`
        // (none = nothing to import, `pathRules` becomes `[]`).
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
            // Keep the managed connection running in the background — an
            // active job still needs it — and only clear the selected-UI
            // fields below. `selectedWorkerId` itself is left alone too.
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

      /**
       * Removes the worker from this app, and — if it can be reached within a
       * few seconds — unpairs this device there too (`clients.leave`), so it
       * drops off the worker's device list. Resolves once that attempt is done;
       * the local removal is immediate.
       */
      forgetWorker: async (nodeId) => {
        // Always fully torn down, regardless of any active job — forgetting
        // means the user doesn't want this worker tracked at all anymore,
        // unlike a plain disconnect() (which keeps a background job alive).
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

        // Then tell the worker, best effort: over the live connection if
        // there is one, else a short dial. A worker that's offline (or
        // already removed this device) just keeps or drops its entry on its
        // own — `sleap-connect clients remove` there clears it.
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

      /**
       * Lists `path` on the selected worker, paging through `fs.list` from
       * `offset` (default 0). With `limit`, stops once at least that many
       * entries are in.
       */
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

      /**
       * Renames this device everywhere: saved for future hellos, and pushed now
       * (`clients.rename`) to every worker it's currently connected to.
       */
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
       * Submits `spec` to the selected worker and resolves when it (or, for a multi-model train
       * spec, its last model's job) reaches a terminal state. @param {Record<string, any>} spec
       * @param {JobLogHandler} onProgress @param {SubmitJobOptions} [options]
       */
      submitJob: async (spec, onProgress, options) => {
        const { _client, selectedWorkerId } = get();
        if (!_client || !_client.authenticated || !selectedWorkerId) {
          throw new Error("Not connected to a worker");
        }

        // One id per call, links every job this submission produces — a
        // single-job submission still gets one (index 0, count 1) so a job's
        // `run` field is never a special case to check for.
        // `options.run` overrides this with an EXISTING run id (and tags
        // `stage`) instead — see `SubmitJobOptions.run`.
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
            // Only intermediate models fire onModelComplete — matching the
            // old JOB_COMPLETE-per-model semantics, the LAST model's
            // completion is just the resolved return value.
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
       * Submits `spec` to `workerId` WITHOUT waiting for any job to finish — fire into a worker's
       * queue and move on. A multi-model train spec is split the same way `submitJob` splits one, but
       * every resulting job is submitted up front, sharing one `run` id. Each job is tracked
       * (`opts.source`, plus LUCID's `sessionId`/`camera`/`projectTag`) and watched in the background
       * (`watchTrackedJob`), so its own finish notification still fires; a chained post-train
       * inference job the worker reports via `chained_job_ids` is tracked and watched the same way.
       * Returns every job id this submission produced, in run order.
       *
       * @param {string} workerId @param {Record<string, any>} spec
       * LUCID: `opts.run` (`{id, index, count}`) is used instead of a new run id, so a caller can group
       * the jobs of several calls (one per (session, camera)) as one run; `opts.label` is the tracked
       * job's label (default `trackedJobLabel(spec)`).
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
          /** @type {TrackedJob} */
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

      /**
       * Fetch a result blob's bytes (e.g. `JobResult.resultBlobs.predictions`).
       * LUCID: `options` (e.g. `{fsFallback}`) is forwarded to `WorkerClient.fetchBlob`.
       * @param {{ sha256: string, size?: number }} ref @param {object} [options]
       */
      fetchResultBlob: async (ref, options) => {
        const { _client, activeTransport } = get();
        if (!_client || !_client.authenticated) {
          throw new Error("Not connected to a worker");
        }
        if (activeTransport === "iroh") {
          // The HTTP blob port is derived from a ws:// URL, which a direct
          // iroh connection doesn't have: use the iroh blob stream.
          return fetchOverIroh(_client, ref, options);
        }
        return options
          ? _client.fetchBlob(ref.sha256, ref.size, options)
          : _client.fetchBlob(ref.sha256, ref.size);
      },

      /**
       * LUCID: `fetchResultBlob` for ANY paired worker (its managed connection, dialed through
       * `clientFor` if needed), not only the selected `_client`. Over iroh it reads the blob stream (`fetchOverIroh`); same `options`.
       * @param {string} workerId @param {{ sha256: string, size?: number }} ref @param {object} [options]
       */
      fetchResultBlobOn: async (workerId, ref, options) => {
        const client = await get().clientFor(workerId);
        if (!client.authenticated) throw new Error("Not connected to a worker");
        if (managed.get(workerId)?.route === "iroh") return fetchOverIroh(client, ref, options);
        return options
          ? client.fetchBlob(ref.sha256, ref.size, options)
          : client.fetchBlob(ref.sha256, ref.size);
      },

      /**
       * LUCID: records that a tracked job's result was fetched (`fetchedAt = now`), which lets
       * `capTrackedJobs` evict it. A no-op for an unknown job.
       * @param {string} jobId
       */
      markJobFetched: (jobId) => {
        if (!get().trackedJobs.some((j) => j.jobId === jobId)) return;
        updateTrackedJob(set, jobId, { fetchedAt: Date.now() });
      },

      /**
       * Called once on launch: reconnects to every worker with an `active` tracked job, catches up
       * on jobs that finished while unwatched (notifying + marking terminal), and re-watches ones
       * still running.
       */
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

          /** @type {WorkerClient} */
          let client;
          try {
            client = await ensureConnection(workerId).start();
          } catch (err) {
            // No retry here: per ManagedConnection's own contract, a failed
            // start() never starts a retry loop on its own. The jobs stay
            // "active" — a later explicit connect, or the next launch's
            // resumeTrackedJobs, tries again.
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
              // A train job that finished (and chained its post-train
              // inference) while this app was closed never replays its
              // job.result event to a watcher — pick the chained jobs up from
              // the stored result instead, so they're tracked and notify too.
              const chainedIds = status.result?.chained_job_ids;
              if (Array.isArray(chainedIds)) {
                for (const chainedId of chainedIds) {
                  if (typeof chainedId !== "string") continue;
                  trackChainedJob(set, client, workerId, chainedId, job.source, worker.label, job);
                }
              }
              continue;
            }

            // A chained post-train inference job can complete while this app
            // wasn't running to watch for it live — tracking it here too means
            // it still shows up and still notifies.
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

// Keep this window's selection across its own reloads, and offer it to the
// next window opened. (sleap-app installs this only when `window` exists; the
// storage access is injected / call-time and failure-tolerant here, so it is
// installed unconditionally.)
useConnectStore.subscribe((state, prev) => {
  if (state.selectedWorkerId === prev.selectedWorkerId) return;
  writeSessionSelection(state.selectedWorkerId);
  if (state.selectedWorkerId && state.selectedWorkerId !== state.lastSelectedWorkerId) {
    useConnectStore.setState({ lastSelectedWorkerId: state.selectedWorkerId });
  }
});
