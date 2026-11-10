/**
 * Port of sleap-app src/lib/protocolV1/client.ts @ 683a159.
 *
 * Typed client for the sleap-connect protocol v1
 * (docs/plans/2026-09-26-sleap-connect-protocol-v1-spec.md).
 *
 * Owns one WebSocket connection to a worker: exchanges `hello`, pairs or
 * re-authenticates (§3), correlates `req`/`res` frames by a per-connection
 * monotonic ID, and fans out `event` frames (§5) to per-job subscribers.
 * Mirrors the worker's own implementation
 * (`sleap_rtc/protocol_v1/{envelope,server,job_methods,auth}.py` in
 * `talmolab/sleap-connect`) closely enough that reading one explains the
 * other. It dials the worker directly and exposes a typed method surface
 * instead of raw string send/onMessage.
 *
 * LUCID changes:
 *  - Plain JS; the TypeScript interfaces became JSDoc typedefs. Behaviour,
 *    wire strings, error codes, the 15 s default request timeout and every
 *    option name (`url`, `identity`, `agent`, `protoMin`, `protoMax`,
 *    `requestTimeoutMs`, `createSocket`, `fetchImpl`) are unchanged.
 *  - The default agent is `{name: "lucid", ...}` (sleap-app: `"sleap-app"`);
 *    callers normally pass their own.
 *  - `createSocket` / `fetchImpl` are resolved when `connect()` / `fetchBlob()`
 *    run, not at import time, so this module loads in Node without a
 *    `WebSocket` or `fetch` global.
 *  - BLOB FALLBACK THROUGH `fs.read` (new). A browser page cannot read the
 *    worker's blob port: the blob HTTP server sends no CORS headers and
 *    answers no preflight, so `fetch` from the page's origin fails with a
 *    network `TypeError`. `fetchBlob(sha256, expectedSize, options)` takes an
 *    optional `options.fsFallback = {path, pageSize?, onProgress?}`; when the
 *    HTTP `fetch` (or the derivation of its URL, which a non-`ws://` dial URL
 *    such as an iroh target fails with a `TypeError` too) throws a
 *    `TypeError` -- NOT for an HTTP error status, a size mismatch or a hash
 *    mismatch -- the bytes are paged in over `fs.read` from `fsFallback.path`
 *    (the file the blob was registered from, i.e. the job's output path),
 *    collected as Blob parts, and size/sha256-verified exactly like the HTTP
 *    path. Without `fsFallback` behaviour is identical to sleap-app. The
 *    paging is also public as `fetchFileViaFsRead`. `fs.read` is limited to
 *    the worker's shared folders, so the output path must be inside one.
 *  - HARDENING (review of the port; none changes the wire or a happy path):
 *    `connect()` gives up after `requestTimeoutMs` if the worker never
 *    completes the hello (rejects `client.timeout`, notifies `onClose`) and
 *    resets to "closed" if `createSocket` throws; a socket's handlers act only
 *    while that socket is still the client's current one (a real WebSocket
 *    closes a task late, which used to fail a later `connect()`); a malformed
 *    worker `hello.proto` fails with `client.proto_mismatch` instead of
 *    throwing out of the message handler; a `send` that throws rejects its
 *    request and drops the pending entry; one throwing job listener no longer
 *    starves the rest; `jobsSubscribe`'s unsubscribe prunes an emptied set.
 */

import { buildHello, buildReq, parseEnvelope, PROTOCOL_VERSION } from "./envelope.js";
import {
  BLOB_HASH_MISMATCH,
  BLOB_INCOMPLETE,
  BLOB_UNKNOWN,
  CLIENT_CLOSED,
  CLIENT_PROTO_MISMATCH,
  CLIENT_TIMEOUT,
  CLIENT_WORKER_UNVERIFIED,
  FS_FORBIDDEN,
  FS_IO_ERROR,
  FS_NOT_FOUND,
  INTERNAL,
  WorkerProtocolError,
} from "./errors.js";

/**
 * The subset of the `WebSocket` interface this client needs. Lets tests
 * inject an in-memory fake instead of opening a real socket; defaults to
 * the global `WebSocket` in the app.
 *
 * @typedef {object} WebSocketLike
 * @property {(data: string) => void} send
 * @property {(code?: number, reason?: string) => void} close
 * @property {number} readyState
 * @property {((ev: unknown) => void) | null} onopen
 * @property {((ev: {data: string}) => void) | null} onmessage
 * @property {((ev: unknown) => void) | null} onclose
 * @property {((ev: unknown) => void) | null} onerror
 * @property {number | null} [irohConnectionId] The desktop iroh socket's Rust-side connection id, once open; absent on a real `WebSocket`.
 */

/** @typedef {"connecting" | "unauthenticated" | "authenticated" | "closed"} ConnectionState */

/**
 * A worker's snapshot of its own hardware/software (`worker.info`, sleap-connect #98).
 * @typedef {object} WorkerInfo
 * @property {string} gpuModel
 * @property {number} gpuMemoryMb
 * @property {number} gpuCount
 * @property {string} cudaVersion
 * @property {string} sleapNnVersion
 * @property {boolean} busy
 * @property {string[]} features What the worker supports beyond the base protocol (e.g. "output_dir"); [] on older workers.
 */

/** @typedef {{name: string, id: string}} JobProject */

/**
 * Links a job to its siblings in one top-down-style submission that's split
 * into several worker jobs — opaque to the worker, round-tripped as-is.
 * `index`/`count` are 0-based/total. `stage` is absent for a training job and
 * `"inference"` for one chained onto the run after training.
 * @typedef {{id: string, index: number, count: number, stage?: "train" | "inference"}} JobRun
 */

/**
 * @typedef {object} JobSummary
 * @property {string} jobId
 * @property {string} state
 * @property {string} createdAt
 * @property {string} [updatedAt]
 * @property {string} [startedAt] When the job's process started (wire: `started_at`); absent while queued, or from a worker that doesn't report it.
 * @property {string | null} [error]
 * @property {number | null} queuePosition
 * @property {"train" | "track"} [kind]
 * @property {string[]} modelTypes
 * @property {string} [labelsPath]
 * @property {JobProject | null} [project]
 * @property {JobRun | null} [run]
 * @property {boolean} [postInference]
 * @property {string | null} [modelName]
 */

/**
 * @typedef {object} JobStatusExtra
 * @property {Record<string, unknown> | null} result
 * @property {string | null} error
 * @property {Record<string, unknown>} [spec]
 * @typedef {Omit<JobSummary, "error" | "updatedAt"> & {updatedAt: string} & JobStatusExtra} JobStatus
 */

/** @typedef {{path: string, label?: string}} Mount */

/**
 * @typedef {object} FsEntry
 * @property {string} name
 * @property {"file" | "directory"} type
 * @property {number} [size]
 * @property {number} [modified] Last-modified time, Unix seconds (the worker's `st_mtime`).
 */

/** @typedef {{entries: FsEntry[], totalCount: number, hasMore: boolean}} FsListResult */

/**
 * @typedef {object} FsStatResult
 * @property {string} path
 * @property {"file" | "directory"} type
 * @property {number} size
 * @property {number} modified
 * @property {boolean} shared False for a path outside the worker's shared folders: the worker only confirms it exists (no size/mtime). Jobs can still read media there.
 */

/**
 * One video frame from `media.frame`, decoded and re-encoded as a JPEG by the worker.
 * @typedef {object} MediaFrameResult
 * @property {Uint8Array} content The JPEG's bytes, already base64-decoded.
 * @property {string} mime
 * @property {number} width The frame's original size, before the worker scaled it down to fit `maxSide`.
 * @property {number} height
 * @property {number} scaledWidth The JPEG's own size.
 * @property {number} scaledHeight
 */

/**
 * @typedef {object} FsReadResult
 * @property {string} path
 * @property {Uint8Array} content Raw bytes, already base64-decoded.
 * @property {number} offset
 * @property {number} size
 * @property {number} totalSize
 * @property {boolean} eof True if this read reached the end of the file.
 */

/**
 * @typedef {object} WorkerEvent
 * @property {string} topic
 * @property {number} seq
 * @property {string} [jobId]
 * @property {Record<string, unknown>} data
 */

/**
 * Reported to `onClose` listeners once per close: `intentional: true` for a
 * caller-initiated `close()`, `false` for anything else (a dropped socket, a
 * failed handshake, a protocol error) — `error` carries the cause in that
 * case.
 * @typedef {{intentional: boolean, error?: WorkerProtocolError}} CloseInfo
 */

/**
 * A device paired with a worker, from `clients.list`.
 * @typedef {object} PairedDevice
 * @property {string} nodeId
 * @property {string | null} name The name it reports; null if it paired before devices were named.
 * @property {string | null} platform "tauri" (desktop app) or "web" (browser), if reported.
 * @property {string | null} appVersion
 * @property {string | null} pairedAt
 * @property {string | null} lastSeenAt When it last connected or disconnected.
 * @property {boolean} you This device's own entry.
 */

/**
 * @typedef {object} WorkerClientOptions
 * @property {string} url
 * @property {import("./identity.js").ClientIdentity} identity
 * @property {import("./envelope.js").AgentInfo} [agent]
 * @property {number} [protoMin]
 * @property {number} [protoMax]
 * @property {number} [requestTimeoutMs]
 * @property {(url: string) => WebSocketLike} [createSocket] Overridable for tests / iroh; defaults to `(url) => new WebSocket(url)`.
 * @property {typeof fetch} [fetchImpl] Overridable for tests; defaults to the global `fetch`.
 */

/**
 * Optional paged-`fs.read` fallback for `fetchBlob` (see "LUCID changes").
 * @typedef {object} FsFallbackOptions
 * @property {string} path The worker-side path of the file the blob was registered from (the job's output path).
 * @property {number} [pageSize] Bytes asked per `fs.read` (default and worker cap: 4 MiB).
 * @property {(done: number, total: number) => void} [onProgress] Bytes received so far / total file size.
 */

const WS_OPEN = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
/** The worker's per-call `fs.read` cap (`file_manager.py`'s `MAX_READ_BYTES`). */
export const FS_READ_PAGE_BYTES = 4 * 1024 * 1024;

/**
 * Maps the worker's `file_manager.py` `error_code` strings to this client's `fs.*` codes.
 * @param {unknown} workerCode
 */
function _fsErrorCode(workerCode) {
  switch (workerCode) {
    case "PATH_NOT_FOUND":
      return FS_NOT_FOUND;
    case "ACCESS_DENIED":
      return FS_FORBIDDEN;
    default:
      return FS_IO_ERROR;
  }
}

/**
 * `fs.stat`/`fs.read` report failure as an `{error, error_code}` pair
 * embedded in an otherwise-normal `res` (not an envelope-level `res.error`)
 * — see `file_manager.py`'s `stat_path`/`read_file`. Left unchecked, every
 * caller silently gets a bogus zero-valued "success" instead of a thrown
 * error.
 *
 * @param {Record<string, unknown>} result
 * @param {string} context
 */
function _throwIfFsError(result, context) {
  if (typeof result.error === "string") {
    throw new WorkerProtocolError(_fsErrorCode(result.error_code), `${context}: ${result.error}`);
  }
}

/**
 * The worker stores job timestamps as Unix seconds (a SQLite REAL); the app
 * works in ISO strings. A string passes through unchanged.
 * @param {unknown} v
 * @returns {string | undefined}
 */
function _isoTimestamp(v) {
  if (typeof v === "number") return new Date(v * 1000).toISOString();
  return typeof v === "string" ? v : undefined;
}

/**
 * Maps one raw `jobs.list` entry or `jobs.status` result to the fields they
 * share (sleap-connect #98). Shared by `jobsList`/`jobsStatus` so the two
 * methods can't drift. An older worker that predates #98 simply omits these
 * keys: `queuePosition`/`modelTypes` get a safe empty default since callers
 * already branch on them (`null`/`[]`), everything else is left `undefined`
 * rather than guessing a value that isn't knowable.
 *
 * @param {Record<string, any>} j
 * @returns {JobSummary}
 */
function _mapJobSummary(j) {
  return {
    jobId: j.job_id,
    state: j.state,
    createdAt: _isoTimestamp(j.created_at) ?? "",
    updatedAt: _isoTimestamp(j.updated_at),
    startedAt: _isoTimestamp(j.started_at),
    error: j.error,
    queuePosition: j.queue_position ?? null,
    kind: j.kind,
    modelTypes: j.model_types ?? [],
    labelsPath: j.labels_path,
    project: j.project,
    run: j.run,
    postInference: j.post_inference,
    modelName: j.model_name,
  };
}

export class WorkerClient {
  /** @param {WorkerClientOptions} options */
  constructor(options) {
    this._url = options.url;
    this._identity = options.identity;
    this._agent = options.agent ?? { name: "lucid", version: "0.0.0", platform: "unknown" };
    this._protoMin = options.protoMin ?? PROTOCOL_VERSION;
    this._protoMax = options.protoMax ?? PROTOCOL_VERSION;
    this._requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this._createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this._fetch = options.fetchImpl ?? null;

    /** @type {WebSocketLike | null} */
    this._socket = null;
    /** @type {ConnectionState} */
    this._state = "closed";
    this._nextRequestId = 1;
    /** @type {Map<number, {resolve: (r: Record<string, unknown>) => void, reject: (e: Error) => void, timeout: ReturnType<typeof setTimeout>}>} */
    this._pending = new Map();
    /** @type {Map<string, Set<(event: WorkerEvent) => void>>} */
    this._jobListeners = new Map();
    /** @type {Set<(info: CloseInfo) => void>} */
    this._closeListeners = new Set();
    this._closeNotified = false;

    /** @type {string | null} */
    this._peerNodeId = null;
    // The nonce the WORKER sent us in its hello — what auth.prove signs
    // (spec §3.3: each side signs the *other* side's nonce).
    /** @type {string | null} */
    this._peerNonce = null;
    // The nonce WE sent in our own hello — symmetric auth verifies the
    // worker's hello.proof against this value (the worker signs it right
    // back in the SAME hello exchange, no extra round-trip).
    /** @type {string | null} */
    this._ownNonce = null;
    // The worker's blob-serving HTTP port, if it announced one — see
    // fetchBlob(). null on a worker not running the blob HTTP server.
    /** @type {number | null} */
    this._peerBlobPort = null;

    /** @type {{resolve: () => void, reject: (e: Error) => void} | null} */
    this._connectWaiter = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._connectTimer = null;
  }

  /** @returns {ConnectionState} */
  get state() {
    return this._state;
  }

  get authenticated() {
    return this._state === "authenticated";
  }

  /** The Rust-side id of this client's iroh connection (desktop only), for the Tauri iroh blob path; `null` over a WebSocket or before it opens. */
  get irohConnectionId() {
    return this._socket?.irohConnectionId ?? null;
  }

  /** The worker's node_id, known once the `hello` handshake completes. */
  get peerNodeId() {
    return this._peerNodeId;
  }

  /** The worker's blob-serving HTTP port, if it announced one (spec §6.3). */
  get peerBlobPort() {
    return this._peerBlobPort;
  }

  /**
   * Open the connection and complete the `hello` handshake (spec §3.3
   * steps 1-2). Resolves once both sides have exchanged `hello` — the
   * connection is then "unauthenticated": only `pairClaim`/`authProve`
   * should be called until one of them succeeds.
   *
   * @returns {Promise<void>}
   */
  connect() {
    if (this._state !== "closed") {
      throw new WorkerProtocolError(CLIENT_CLOSED, "connect() called on an already-open client");
    }
    this._state = "connecting";

    return new Promise((resolve, reject) => {
      this._connectWaiter = { resolve, reject };
      let socket;
      try {
        socket = this._createSocket(this._url);
      } catch (err) {
        this._state = "closed";
        this._connectWaiter = null;
        reject(err);
        return;
      }
      this._socket = socket;
      // A worker that accepts the socket but never answers hello would
      // otherwise leave this promise (and a reconnect loop awaiting it) pending forever.
      this._connectTimer = setTimeout(() => {
        if (this._socket === socket && this._state === "connecting") {
          this._failNonIntentional(
            new WorkerProtocolError(CLIENT_TIMEOUT, "Timed out waiting for the worker's hello"),
          );
        }
      }, this._requestTimeoutMs);

      socket.onopen = () => {
        if (this._socket !== socket) return;
        this._ownNonce = randomNonce();
        const hello = buildHello({
          nodeId: this._identity.nodeId,
          nonce: this._ownNonce,
          agent: this._agent,
          protoMin: this._protoMin,
          protoMax: this._protoMax,
        });
        socket.send(JSON.stringify(hello));
      };

      socket.onmessage = (ev) => {
        if (this._socket === socket) this._handleMessage(ev.data);
      };

      socket.onerror = () => {
        console.warn("[protocolV1] WebSocket error");
      };

      socket.onclose = () => {
        if (this._socket === socket && this._state !== "closed") {
          this._failNonIntentional(new WorkerProtocolError(CLIENT_CLOSED, "Connection closed"));
        }
      };
    });
  }

  /** Close the connection. Any in-flight requests reject with `client.closed`. */
  close() {
    if (this._state === "closed") return;
    this._fail(new WorkerProtocolError(CLIENT_CLOSED, "Client closed"));
    this._jobListeners.clear();
    this._notifyClose({ intentional: true });
  }

  /**
   * Subscribe to this client closing, exactly once — a dropped socket, a
   * failed handshake/protocol error, or a caller-initiated `close()` (see
   * `CloseInfo`). Returns an unsubscribe function.
   *
   * @param {(info: CloseInfo) => void} cb
   * @returns {() => void}
   */
  onClose(cb) {
    this._closeListeners.add(cb);
    return () => this._closeListeners.delete(cb);
  }

  /** @param {CloseInfo} info */
  _notifyClose(info) {
    if (this._closeNotified) return;
    this._closeNotified = true;
    for (const cb of [...this._closeListeners]) {
      try {
        cb(info);
      } catch (e) {
        console.warn("[protocolV1] onClose listener threw", e);
      }
    }
  }

  /**
   * `_fail` plus an `onClose` notification for a condition this client
   * detected itself (dropped socket, protocol mismatch, failed peer
   * verification) rather than a caller-initiated `close()` — including one
   * raised while still inside `connect()` (a failed dial), so a caller
   * managing reconnection (e.g. `ManagedConnection`) can learn about that
   * failure the same way it learns about a later drop.
   *
   * @param {Error} err
   */
  _failNonIntentional(err) {
    this._fail(err);
    this._notifyClose({
      intentional: false,
      error: err instanceof WorkerProtocolError ? err : undefined,
    });
  }

  /**
   * First-contact trust via a pairing ticket's one-time secret (spec §3.2).
   * @param {string} secret
   */
  async pairClaim(secret) {
    await this._request("pair.claim", { secret, node_id: this._identity.nodeId });
    this._state = "authenticated";
  }

  /** Re-prove identity on an already-paired connection (spec §3.3 step 3). */
  async authProve() {
    if (this._peerNonce === null) {
      throw new WorkerProtocolError(
        INTERNAL,
        "authProve() called before the hello handshake completed",
      );
    }
    const sig = await this._identity.sign(this._peerNonce);
    await this._request("auth.prove", { sig });
    this._state = "authenticated";
  }

  /**
   * @param {Record<string, unknown>} spec
   * @param {string} [clientJobId]
   * @returns {Promise<{jobId: string}>}
   */
  async jobsSubmit(spec, clientJobId) {
    /** @type {Record<string, unknown>} */
    const params = { spec };
    if (clientJobId !== undefined) params.client_job_id = clientJobId;
    const result = await this._request("jobs.submit", params);
    return { jobId: result.job_id };
  }

  /**
   * @param {string} jobId
   * @param {"cancel" | "stop"} [mode]
   */
  async jobsCancel(jobId, mode = "cancel") {
    await this._request("jobs.cancel", { job_id: jobId, mode });
  }

  /**
   * Removes `jobIds`' records from the worker (`jobs`/`job_events` rows
   * only — nothing under `job-runs/<id>` or the job's log file is touched,
   * so a trained model, logs, and predictions all stay on disk). All-or-
   * nothing: an unknown id throws `job.not_found`; any id the worker is
   * currently running (or about to) throws `job.active` and nothing is
   * deleted.
   *
   * @param {string[]} jobIds
   * @returns {Promise<{deleted: string[]}>}
   */
  async jobsDelete(jobIds) {
    const result = await this._request("jobs.delete", { job_ids: jobIds });
    return { deleted: result.deleted ?? [] };
  }

  /**
   * @param {string} jobId
   * @returns {Promise<JobStatus>}
   */
  async jobsStatus(jobId) {
    const result = await this._request("jobs.status", { job_id: jobId });
    return {
      ..._mapJobSummary(result),
      updatedAt: _isoTimestamp(result.updated_at) ?? "",
      result: result.result ?? null,
      error: result.error ?? null,
      spec: result.spec,
    };
  }

  /** @returns {Promise<JobSummary[]>} */
  async jobsList() {
    const result = await this._request("jobs.list", {});
    const jobs = result.jobs ?? [];
    return jobs.map((j) => _mapJobSummary(j));
  }

  /**
   * `clients.list` — every device paired with this worker (who can use it),
   * with `you` on this device's own entry.
   *
   * @returns {Promise<PairedDevice[]>}
   */
  async clientsList() {
    const result = await this._request("clients.list", {});
    const clients = result.clients ?? [];
    return clients.map((c) => ({
      nodeId: c.node_id,
      name: c.name ?? null,
      platform: c.platform ?? null,
      appVersion: c.app_version ?? null,
      pairedAt: _isoTimestamp(c.paired_at) ?? null,
      lastSeenAt: _isoTimestamp(c.last_seen_at) ?? null,
      you: !!c.you,
    }));
  }

  /**
   * `clients.leave` — unpairs this device from the worker (the app's
   * Forget). The worker closes this connection right after replying.
   *
   * @returns {Promise<{removed: boolean}>}
   */
  async clientsLeave() {
    const result = await this._request("clients.leave", {});
    return { removed: !!result.removed };
  }

  /**
   * `clients.rename` — sets this device's own name on the worker now (it's also sent with every hello).
   * @param {string} name
   */
  async clientsRename(name) {
    await this._request("clients.rename", { name });
  }

  /**
   * A snapshot of the worker's own hardware/software (spec/sleap-connect #98).
   * @returns {Promise<WorkerInfo>}
   */
  async workerInfo() {
    const result = await this._request("worker.info", {});
    return {
      gpuModel: result.gpu_model ?? "unknown",
      gpuMemoryMb: result.gpu_memory_mb ?? 0,
      gpuCount: result.gpu_count ?? 0,
      cudaVersion: result.cuda_version ?? "unknown",
      sleapNnVersion: result.sleap_nn_version ?? "unknown",
      busy: !!result.busy,
      features: Array.isArray(result.features) ? result.features : [],
    };
  }

  /**
   * Subscribe to a job's events, replaying everything since `sinceSeq`
   * (0 = full history) before switching to live events (spec §5.2). The
   * local listener is registered *before* the `jobs.subscribe` request is
   * sent, so a backlog event the worker pushes while handling that request
   * can never arrive before anything is listening for it.
   *
   * Returns an unsubscribe function.
   *
   * @param {string} jobId
   * @param {number} sinceSeq
   * @param {(event: WorkerEvent) => void} onEvent
   * @returns {Promise<() => void>}
   */
  async jobsSubscribe(jobId, sinceSeq, onEvent) {
    let listeners = this._jobListeners.get(jobId);
    if (!listeners) {
      listeners = new Set();
      this._jobListeners.set(jobId, listeners);
    }
    listeners.add(onEvent);

    try {
      await this._request("jobs.subscribe", { job_id: jobId, since_seq: sinceSeq });
    } catch (err) {
      listeners.delete(onEvent);
      throw err;
    }

    return () => {
      listeners.delete(onEvent);
      if (listeners.size === 0 && this._jobListeners.get(jobId) === listeners) {
        this._jobListeners.delete(jobId);
      }
    };
  }

  /**
   * `fs.mounts` plus the folder `sleap-rtc serve` started in (when it's
   * shared; null otherwise or on older workers).
   *
   * @returns {Promise<{mounts: Mount[], serveFolder: string | null}>}
   */
  async fsMountsAndServeFolder() {
    const result = await this._request("fs.mounts", {});
    const mounts = result.mounts ?? [];
    return {
      mounts: mounts.map((m) => ({ path: m.path, label: m.label })),
      serveFolder: typeof result.serve_folder === "string" ? result.serve_folder : null,
    };
  }

  /** @returns {Promise<Mount[]>} */
  async fsMounts() {
    const result = await this._request("fs.mounts", {});
    const mounts = result.mounts ?? [];
    return mounts.map((m) => ({
      path: m.path,
      label: m.label,
    }));
  }

  /**
   * One page of a directory listing within the worker's configured mounts.
   *
   * @throws {WorkerProtocolError} with an `fs.*` code if the worker reports
   * failure (missing folder, outside the mounts, permission denied) — an
   * embedded `{error, error_code}` pair, same as `fsStat`; without this check
   * a missing folder would read as an empty one.
   *
   * @param {string} path
   * @param {number} [offset]
   * @returns {Promise<FsListResult>}
   */
  async fsList(path, offset = 0) {
    const result = await this._request("fs.list", { path, offset });
    _throwIfFsError(result, `fs.list('${path}')`);
    return {
      entries: result.entries ?? [],
      totalCount: result.total_count ?? 0,
      hasMore: !!result.has_more,
    };
  }

  /**
   * Metadata for one path within the worker's configured mounts.
   *
   * @throws {WorkerProtocolError} with an `fs.*` code if the worker's
   * `fs.stat` handler reports failure (path missing, outside configured
   * mounts, etc.) — these arrive as an `{error, error_code}` pair embedded
   * in an otherwise-successful `res`, not as an envelope-level `res.error`
   * (see `file_manager.py`'s `stat_path`/`read_file` docstrings), so they
   * must be checked explicitly rather than assumed absent.
   *
   * @param {string} path
   * @returns {Promise<FsStatResult>}
   */
  async fsStat(path) {
    const result = await this._request("fs.stat", { path });
    _throwIfFsError(result, `fs.stat('${path}')`);
    return {
      path: result.path,
      type: result.type,
      size: result.size ?? 0,
      modified: result.modified ?? 0,
      shared: result.shared !== false,
    };
  }

  /**
   * A small direct byte-range read within the worker's configured mounts —
   * for inspecting a config/log/text file, NOT bulk transfer (see
   * `fetchBlob`/the blob API for that). The worker caps `length` server-side
   * (4 MiB per call as of `file_manager.py`'s `MAX_READ_BYTES`); page through
   * a larger file with repeated, offset-advancing calls.
   *
   * @param {string} path
   * @param {number} [offset]
   * @param {number} [length]
   * @returns {Promise<FsReadResult>}
   */
  async fsRead(path, offset = 0, length) {
    /** @type {Record<string, unknown>} */
    const params = { path, offset };
    if (length !== undefined) params.length = length;
    const result = await this._request("fs.read", params);
    _throwIfFsError(result, `fs.read('${path}')`);
    return {
      path: result.path,
      content: base64ToBytes(result.content_base64 ?? ""),
      offset: result.offset ?? offset,
      size: result.size ?? 0,
      totalSize: result.total_size ?? 0,
      eof: !!result.eof,
    };
  }

  /**
   * One frame of a worker-side video (or a single image), decoded by the
   * worker and re-encoded as a JPEG with its longest side capped at
   * `maxSide` — for previews of videos the app can't decode itself
   * (sleap-connect `media.frame`; check for the `media_frame` feature).
   *
   * @param {string} path
   * @param {number} frameIdx
   * @param {number} [maxSide]
   * @returns {Promise<MediaFrameResult>}
   */
  async mediaFrame(path, frameIdx, maxSide) {
    /** @type {Record<string, unknown>} */
    const params = { path, frame_idx: frameIdx };
    if (maxSide !== undefined) params.max_side = maxSide;
    const result = await this._request("media.frame", params);
    return {
      content: base64ToBytes(result.content_base64 ?? ""),
      mime: result.mime ?? "image/jpeg",
      width: result.width ?? 0,
      height: result.height ?? 0,
      scaledWidth: result.scaled_width ?? 0,
      scaledHeight: result.scaled_height ?? 0,
    };
  }

  /**
   * Fetch a result blob's bytes from the worker's blob HTTP endpoint (spec
   * §6.3), on the same host this client dialed for the WS connection.
   * Verifies both size and content hash before returning — this is bulk
   * data crossing a network boundary, worth checking rather than trusting
   * blindly. Only meaningful once `hello` has completed and the worker
   * announced a `blob_port` (a worker not running the blob HTTP server has
   * nothing to serve).
   *
   * With `options.fsFallback`, a network/CORS `TypeError` from the HTTP
   * request falls back to `fetchFileViaFsRead` (see the module header).
   *
   * @param {string} sha256
   * @param {number} [expectedSize]
   * @param {{fsFallback?: FsFallbackOptions}} [options]
   * @returns {Promise<Uint8Array>}
   */
  async fetchBlob(sha256, expectedSize, options) {
    if (this._peerBlobPort === null) {
      throw new WorkerProtocolError(
        BLOB_UNKNOWN,
        "Worker did not announce a blob port — it isn't running the blob HTTP server",
      );
    }

    let url = "";
    /** @type {Response} */
    let response;
    try {
      url = `${this._blobHttpOrigin()}/blobs/${sha256}`;
      response = await this._fetchImpl()(url);
    } catch (err) {
      // A browser page can't read the blob port (no CORS headers), and a
      // non-ws dial URL (iroh) has no HTTP origin: both are a TypeError.
      if (options?.fsFallback && err instanceof TypeError) {
        return this.fetchFileViaFsRead(options.fsFallback.path, sha256, expectedSize, options.fsFallback);
      }
      if (url === "") throw err; // no origin to name: same raw error as sleap-app
      throw new WorkerProtocolError(
        BLOB_UNKNOWN,
        `Failed to reach the blob server at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      throw new WorkerProtocolError(
        BLOB_UNKNOWN,
        `Blob ${sha256} not found (HTTP ${response.status})`,
      );
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    return this._verifiedBlob(sha256, expectedSize, buffer);
  }

  /**
   * Reads a whole worker-side file through paged `fs.read` calls (4 MiB each
   * by default) into Blob parts, then checks its size and sha256 like
   * `fetchBlob`. The route for a page that cannot reach the blob port. The
   * file must be inside one of the worker's shared folders.
   *
   * @param {string} path Worker-side path.
   * @param {string} sha256 Expected content hash (lowercase hex).
   * @param {number} [expectedSize]
   * @param {{pageSize?: number, onProgress?: (done: number, total: number) => void}} [options]
   * @returns {Promise<Uint8Array>}
   */
  async fetchFileViaFsRead(path, sha256, expectedSize, options = {}) {
    const pageSize = options.pageSize ?? FS_READ_PAGE_BYTES;
    /** @type {Uint8Array[]} */
    const parts = [];
    let offset = 0;
    for (;;) {
      const page = await this.fsRead(path, offset, pageSize);
      if (page.content.byteLength > 0) {
        parts.push(page.content);
        offset += page.content.byteLength;
        options.onProgress?.(offset, page.totalSize);
      }
      if (page.eof) break;
      if (page.content.byteLength === 0) {
        throw new WorkerProtocolError(
          BLOB_INCOMPLETE,
          `Blob ${sha256}: fs.read('${path}') returned no data at offset ${offset} before the end of the file`,
        );
      }
    }
    // Blob parts keep the pages out of one growing array; WebCrypto's digest
    // is one-shot, so the verified bytes are materialised once at the end.
    const buffer = new Uint8Array(await new Blob(parts).arrayBuffer());
    return this._verifiedBlob(sha256, expectedSize, buffer);
  }

  /**
   * Size then hash check shared by both blob routes.
   * @param {string} sha256
   * @param {number | undefined} expectedSize
   * @param {Uint8Array} buffer
   */
  async _verifiedBlob(sha256, expectedSize, buffer) {
    if (expectedSize !== undefined && buffer.byteLength !== expectedSize) {
      throw new WorkerProtocolError(
        BLOB_INCOMPLETE,
        `Blob ${sha256}: expected ${expectedSize} bytes, got ${buffer.byteLength}`,
      );
    }

    const actualHash = await sha256Hex(buffer);
    if (actualHash !== sha256) {
      throw new WorkerProtocolError(
        BLOB_HASH_MISMATCH,
        `Blob content does not match its hash (expected ${sha256}, got ${actualHash})`,
      );
    }

    return buffer;
  }

  /** @returns {typeof fetch} */
  _fetchImpl() {
    return this._fetch ?? ((...args) => fetch(...args));
  }

  _blobHttpOrigin() {
    // "ws://host:port" -> "http://host:<blob_port>"; "wss://" -> "https://"
    // (the regex only replaces the leading "ws", so wss's trailing "s"
    // combines with "http" to form "https" on its own).
    const dialUrl = new URL(this._url.replace(/^ws/, "http"));
    return `${dialUrl.protocol}//${dialUrl.hostname}:${this._peerBlobPort}`;
  }

  // ── internals ──────────────────────────────────────────────────────

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @returns {Promise<Record<string, any>>}
   */
  _request(method, params) {
    if (!this._socket || this._socket.readyState !== WS_OPEN) {
      return Promise.reject(new WorkerProtocolError(CLIENT_CLOSED, "Not connected"));
    }
    const socket = this._socket;
    const id = this._nextRequestId++;
    const frame = buildReq(id, method, params);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new WorkerProtocolError(CLIENT_TIMEOUT, `Request '${method}' timed out`));
      }, this._requestTimeoutMs);

      this._pending.set(id, { resolve, reject, timeout });
      try {
        socket.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timeout);
        this._pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** @param {string} raw */
  _handleMessage(raw) {
    let envelope;
    try {
      envelope = parseEnvelope(raw);
    } catch (err) {
      console.warn("[protocolV1] Dropping unparseable frame:", err);
      return;
    }

    switch (envelope.type) {
      case "hello":
        this._handleHello(envelope);
        break;
      case "res":
        this._handleRes(envelope);
        break;
      case "event":
        this._handleEvent(envelope);
        break;
      case "req":
        // The worker never issues its own outgoing requests — symmetric
        // auth (worker proves identity to client) is implemented via
        // hello.proof instead (see _verifyWorkerProof), not a
        // worker-initiated req/res round-trip.
        console.warn("[protocolV1] Unexpected 'req' frame from worker, ignoring");
        break;
    }
  }

  /** @param {import("./envelope.js").HelloFrame} hello */
  _handleHello(hello) {
    if (this._state !== "connecting") {
      console.warn("[protocolV1] Unexpected 'hello' frame after handshake, ignoring");
      return;
    }
    const proto = hello.proto;
    if (
      !proto ||
      typeof proto.min !== "number" ||
      typeof proto.max !== "number" ||
      proto.max < this._protoMin ||
      proto.min > this._protoMax
    ) {
      this._failNonIntentional(
        new WorkerProtocolError(
          CLIENT_PROTO_MISMATCH,
          `Worker's protocol range [${proto?.min},${proto?.max}] does not overlap ` +
            `ours [${this._protoMin},${this._protoMax}]`,
        ),
      );
      return;
    }

    // Symmetric auth: verify the worker's proof BEFORE trusting anything
    // else this connection says. Web Crypto is async, so the rest of hello
    // processing (and resolving _connectWaiter) waits for it — nothing a
    // caller does with this client can run before that resolves anyway.
    void this._verifyWorkerProof(hello).then(
      (verified) => {
        if (this._state !== "connecting") return; // closed/failed while this was pending
        if (!verified) {
          this._failNonIntentional(
            new WorkerProtocolError(
              CLIENT_WORKER_UNVERIFIED,
              "Worker's hello.proof did not verify against the public key it claimed as its node_id",
            ),
          );
          return;
        }
        this._peerNodeId = hello.node_id;
        this._peerNonce = hello.nonce;
        this._peerBlobPort = hello.blob_port ?? null;
        this._state = "unauthenticated";
        if (this._connectTimer !== null) clearTimeout(this._connectTimer);
        this._connectTimer = null;
        this._connectWaiter?.resolve();
        this._connectWaiter = null;
      },
      (err) => this._failNonIntentional(err instanceof Error ? err : new Error(String(err))),
    );
  }

  /**
   * Checks `hello.proof` — the worker's signature over OUR OWN nonce
   * (`_ownNonce`, sent in our hello) — against the public key encoded in
   * `hello.node_id` from that SAME frame. `false` for a missing proof
   * (never silently treated as "not applicable" — an unproven peer is an
   * unverified peer), a malformed node_id/proof, or a genuinely bad
   * signature; these aren't distinguished further since the caller's only
   * next move is the same either way (fail the connection).
   *
   * @param {import("./envelope.js").HelloFrame} hello
   * @returns {Promise<boolean>}
   */
  async _verifyWorkerProof(hello) {
    if (!hello.proof || this._ownNonce === null) return false;
    try {
      const publicKey = await crypto.subtle.importKey(
        "raw",
        base64UrlToBytes(hello.node_id),
        "Ed25519",
        false,
        ["verify"],
      );
      return await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        base64UrlToBytes(hello.proof),
        new TextEncoder().encode(this._ownNonce),
      );
    } catch {
      return false;
    }
  }

  /** @param {import("./envelope.js").ResFrame} res */
  _handleRes(res) {
    const pending = this._pending.get(res.id);
    if (!pending) return;
    this._pending.delete(res.id);
    clearTimeout(pending.timeout);
    if (res.error) {
      pending.reject(new WorkerProtocolError(res.error.code, res.error.msg, res.error.data));
    } else {
      pending.resolve(res.result ?? {});
    }
  }

  /** @param {import("./envelope.js").EventFrame} event */
  _handleEvent(event) {
    if (!event.job_id) return; // connection-level events: none defined yet
    const listeners = this._jobListeners.get(event.job_id);
    if (!listeners || listeners.size === 0) return;
    /** @type {WorkerEvent} */
    const workerEvent = {
      topic: event.topic,
      seq: event.seq,
      jobId: event.job_id,
      data: event.data,
    };
    for (const listener of [...listeners]) {
      try {
        listener(workerEvent);
      } catch (e) {
        console.warn("[protocolV1] job event listener threw", e);
      }
    }
  }

  /** @param {Error} err */
  _fail(err) {
    if (this._connectTimer !== null) clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this._state = "closed";
    this._socket?.close();
    this._socket = null;
    this._connectWaiter?.reject(err);
    this._connectWaiter = null;
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this._pending.clear();
  }
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} b64 */
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decodes URL-safe, unpadded base64 (the encoding `sleap_rtc.auth.keypair`
 * and `identity.js` both use for node IDs and signatures) to raw bytes.
 * @param {string} b64url
 */
function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @param {Uint8Array} bytes */
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
