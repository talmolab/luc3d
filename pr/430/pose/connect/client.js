/**
 * Port of sleap-app src/lib/protocolV1/client.ts @ 683a159.
 *
 * Client for sleap-connect protocol v1: one WebSocket to a worker; `hello`, pairing / re-auth (§3),
 * `req`/`res` correlated by a per-connection monotonic id, `event` frames (§5) fanned out per job.
 * Mirrors the worker's `sleap_rtc/protocol_v1/{envelope,server,job_methods,auth}.py`.
 *
 * LUCID changes:
 *  - Plain JS + JSDoc; wire strings, error codes, the 15 s request timeout and option names unchanged.
 *  - Default agent `{name: "lucid", ...}`.
 *  - `createSocket` / `fetchImpl` resolve at call time, so the module loads in Node.
 *  - `fetchBlob(sha256, size, {fsFallback: {path, pageSize?, onProgress?}})`: the blob port sends no CORS
 *    headers, so on a fetch/URL `TypeError` (never an HTTP status or size/hash mismatch) the bytes are paged
 *    over `fs.read` from the job's output path (inside a shared folder) and verified the same way.
 *    The paging is public as `fetchFileViaFsRead`.
 *  - Hardening (no wire/happy-path change): `connect()` times out on a silent hello and resets if
 *    `createSocket` throws; handlers act only for the current socket (a late close failed a later
 *    `connect()`); a malformed `hello.proto` -> `client.proto_mismatch`; a throwing `send` rejects its
 *    request; a throwing job listener doesn't starve the rest; unsubscribe prunes emptied sets.
 */

import { buildHello, buildReq, parseEnvelope, PROTOCOL_VERSION } from "./envelope.js?v=82449baaa3c2";
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
} from "./errors.js?v=82449baaa3c2";

/**
 * The `WebSocket` subset this client needs (tests inject a fake).
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
 * Links sibling jobs of one submission (opaque to the worker). `stage` "inference" = chained after training.
 * @typedef {{id: string, index: number, count: number, stage?: "train" | "inference"}} JobRun
 */

/**
 * @typedef {object} JobSummary
 * @property {string} jobId
 * @property {string} state
 * @property {string} createdAt
 * @property {string} [updatedAt]
 * @property {string} [startedAt] Absent while queued or on older workers.
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
 * @property {boolean} shared False outside the shared folders (existence only, no size/mtime).
 */

/**
 * A `media.frame` JPEG; width/height = original frame, scaled* = the JPEG's.
 * @typedef {{ content: Uint8Array, mime: string, width: number, height: number, scaledWidth: number, scaledHeight: number }} MediaFrameResult
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
 * Once per close: `intentional` only for a caller's `close()`; otherwise `error` is the cause.
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
 * @property {import("./identity.js?v=82449baaa3c2").ClientIdentity} identity
 * @property {import("./envelope.js?v=82449baaa3c2").AgentInfo} [agent]
 * @property {number} [protoMin]
 * @property {number} [protoMax]
 * @property {number} [requestTimeoutMs]
 * @property {(url: string) => WebSocketLike} [createSocket] Overridable for tests / iroh; defaults to `(url) => new WebSocket(url)`.
 * @property {typeof fetch} [fetchImpl] Overridable for tests; defaults to the global `fetch`.
 */

/**
 * `fetchBlob`'s paged-`fs.read` fallback: `path` = the job's output path; `pageSize` default/cap 4 MiB.
 * @typedef {{ path: string, pageSize?: number, onProgress?: (done: number, total: number) => void }} FsFallbackOptions
 */

const WS_OPEN = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
/** The worker's per-call `fs.read` cap (`file_manager.py`'s `MAX_READ_BYTES`). */
export const FS_READ_PAGE_BYTES = 4 * 1024 * 1024;

/** The worker's `file_manager.py` `error_code` -> this client's `fs.*` codes. */
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

/** `fs.stat`/`fs.read` report failure as `{error, error_code}` inside a normal `res`: throw it. */
function _throwIfFsError(result, context) {
  if (typeof result.error === "string") {
    throw new WorkerProtocolError(_fsErrorCode(result.error_code), `${context}: ${result.error}`);
  }
}

/** Worker Unix-seconds timestamp -> ISO string (a string passes through). */
function _isoTimestamp(v) {
  if (typeof v === "number") return new Date(v * 1000).toISOString();
  return typeof v === "string" ? v : undefined;
}

/** A raw `jobs.list` entry / `jobs.status` result -> JobSummary (older workers omit keys: left undefined). */
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

    this._peerNodeId = null;
    // The worker's hello nonce: what auth.prove signs (§3.3: each side signs the other's).
    this._peerNonce = null;
    // Our hello nonce: the worker's hello.proof is verified against it.
    this._ownNonce = null;
    // The worker's blob HTTP port, if announced.
    this._peerBlobPort = null;

    this._connectWaiter = null;
    this._connectTimer = null;
  }

  /** @returns {ConnectionState} */
  get state() {
    return this._state;
  }

  get authenticated() {
    return this._state === "authenticated";
  }

  /** The desktop iroh connection's Rust-side id; null over a WebSocket. */
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

  /** Opens and exchanges `hello` (§3.3 1-2); then only `pairClaim`/`authProve` until one succeeds. */
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
      // A worker that never answers hello must not leave this pending forever.
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

  /** Called once when this client closes, for any reason (see `CloseInfo`); returns the unsubscribe. */
  onClose(cb) {
    this._closeListeners.add(cb);
    return () => this._closeListeners.delete(cb);
  }

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

  /** `_fail` + `onClose` for a failure this client detected (incl. inside `connect()`), for reconnect logic. */
  _failNonIntentional(err) {
    this._fail(err);
    this._notifyClose({
      intentional: false,
      error: err instanceof WorkerProtocolError ? err : undefined,
    });
  }

  /** First-contact trust via a pairing ticket's one-time secret (§3.2). */
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

  /** @returns {Promise<{jobId: string}>} */
  async jobsSubmit(spec, clientJobId) {
    const params = { spec };
    if (clientJobId !== undefined) params.client_job_id = clientJobId;
    const result = await this._request("jobs.submit", params);
    return { jobId: result.job_id };
  }

  /** @param {string} jobId @param {"cancel" | "stop"} [mode] */
  async jobsCancel(jobId, mode = "cancel") {
    await this._request("jobs.cancel", { job_id: jobId, mode });
  }

  /**
   * Deletes job records only (files stay). All-or-nothing: unknown id -> `job.not_found`, running -> `job.active`.
   * @returns {Promise<{deleted: string[]}>}
   */
  async jobsDelete(jobIds) {
    const result = await this._request("jobs.delete", { job_ids: jobIds });
    return { deleted: result.deleted ?? [] };
  }

  /** @returns {Promise<JobStatus>} */
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

  /** Every device paired with this worker; `you` marks this one. @returns {Promise<PairedDevice[]>} */
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

  /** Unpairs this device (Forget); the worker closes the connection after replying. */
  async clientsLeave() {
    const result = await this._request("clients.leave", {});
    return { removed: !!result.removed };
  }

  /** Sets this device's name on the worker now (also sent with every hello). */
  async clientsRename(name) {
    await this._request("clients.rename", { name });
  }

  /** @returns {Promise<WorkerInfo>} */
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
   * Replays events after `sinceSeq` (0 = all), then live (§5.2); the listener is registered BEFORE the
   * request so no backlog event is missed. Resolves to the unsubscribe.
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

  /** `fs.mounts` + the shared folder `sleap-rtc serve` started in (else null). */
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

  /** One page of a listing; an embedded fs error throws (else a missing folder reads as empty). @returns {Promise<FsListResult>} */
  async fsList(path, offset = 0) {
    const result = await this._request("fs.list", { path, offset });
    _throwIfFsError(result, `fs.list('${path}')`);
    return {
      entries: result.entries ?? [],
      totalCount: result.total_count ?? 0,
      hasMore: !!result.has_more,
    };
  }

  /** Metadata for one path; an embedded fs error throws with an `fs.*` code. @returns {Promise<FsStatResult>} */
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

  /** A small byte-range read (worker caps 4 MiB per call; page larger files). @returns {Promise<FsReadResult>} */
  async fsRead(path, offset = 0, length) {
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

  /** A worker-decoded frame as JPEG, longest side <= `maxSide` (feature `media_frame`). @returns {Promise<MediaFrameResult>} */
  async mediaFrame(path, frameIdx, maxSide) {
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
   * A result blob from the worker's blob HTTP port (§6.3, same host as the WS), size- and sha256-verified.
   * With `options.fsFallback`, a fetch `TypeError` falls back to `fetchFileViaFsRead`.
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
   * A whole shared-folder file via paged `fs.read` (4 MiB) into Blob parts, verified like `fetchBlob`.
   * @param {{pageSize?: number, onProgress?: (done: number, total: number) => void}} [options]
   * @returns {Promise<Uint8Array>}
   */
  async fetchFileViaFsRead(path, sha256, expectedSize, options = {}) {
    const pageSize = options.pageSize ?? FS_READ_PAGE_BYTES;
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

  /** Size then hash check shared by both blob routes. */
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
    // "ws://host:port" -> "http://host:<blob_port>"; "wss://" -> "https://".
    const dialUrl = new URL(this._url.replace(/^ws/, "http"));
    return `${dialUrl.protocol}//${dialUrl.hostname}:${this._peerBlobPort}`;
  }

  // ── internals ──────────────────────────────────────────────────────

  /** @returns {Promise<Record<string, any>>} */
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
        // The worker never sends requests (its identity proof is hello.proof).
        console.warn("[protocolV1] Unexpected 'req' frame from worker, ignoring");
        break;
    }
  }

  /** @param {import("./envelope.js?v=82449baaa3c2").HelloFrame} hello */
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

    // Verify the worker's proof BEFORE trusting anything else it says (async; connect waits).
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
   * `hello.proof` = the worker's signature over OUR nonce, checked against the key in its `node_id`.
   * A missing or malformed proof is false (an unproven peer is unverified).
   * @param {import("./envelope.js?v=82449baaa3c2").HelloFrame} hello
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

  /** @param {import("./envelope.js?v=82449baaa3c2").ResFrame} res */
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

  /** @param {import("./envelope.js?v=82449baaa3c2").EventFrame} event */
  _handleEvent(event) {
    if (!event.job_id) return; // connection-level events: none defined yet
    const listeners = this._jobListeners.get(event.job_id);
    if (!listeners || listeners.size === 0) return;
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

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** URL-safe unpadded base64 (node ids, signatures) -> bytes. */
function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
