/**
 * Port of sleap-app src/lib/protocolV1/errors.ts @ 683a159.
 *
 * Error code taxonomy for the sleap-connect protocol v1 (spec §8).
 *
 * Mirrors `sleap_rtc/protocol_v1/errors.py`'s worker-side codes exactly, plus
 * a `client.*` namespace for conditions this client detects locally (never
 * sent by the worker) — a request timeout, the socket closing, or a
 * protocol-version mismatch found during the `hello` handshake.
 *
 * LUCID changes: none (TypeScript types dropped).
 */

// auth.*
export const AUTH_REQUIRED = "auth.required";
export const AUTH_UNTRUSTED = "auth.untrusted";
export const AUTH_BAD_SIGNATURE = "auth.bad_signature";
export const AUTH_PAIRING_EXPIRED = "auth.pairing_expired";

// proto.*
export const PROTO_MISMATCH = "proto.mismatch";
export const PROTO_UNKNOWN_METHOD = "proto.unknown_method";

// fs.*
export const FS_NOT_FOUND = "fs.not_found";
export const FS_FORBIDDEN = "fs.forbidden";
export const FS_IO_ERROR = "fs.io_error";

// blob.*
export const BLOB_UNKNOWN = "blob.unknown";
export const BLOB_INCOMPLETE = "blob.incomplete";
export const BLOB_HASH_MISMATCH = "blob.hash_mismatch";

// job.*
export const JOB_NOT_FOUND = "job.not_found";
export const JOB_ALREADY_TERMINAL = "job.already_terminal";
export const JOB_SPEC_INVALID = "job.spec_invalid";
/** `jobs.delete`: the worker is currently running (or about to run) one of the requested job ids — see `sleap_rtc.protocol_v1.job_methods.JobMethods.delete`. */
export const JOB_ACTIVE = "job.active";
/** A job names a path outside the worker's shared folders; the message says how to share it. */
export const JOB_PATH_NOT_SHARED = "job.path_not_shared";

// media.*
/** A `media.frame` source exists but can't be decoded (or has no such frame). */
export const MEDIA_UNREADABLE = "media.unreadable";

// Catch-all for an unexpected worker-side fault.
export const INTERNAL = "internal";

// client.* — detected locally, never sent by the worker.
export const CLIENT_TIMEOUT = "client.timeout";
export const CLIENT_CLOSED = "client.closed";
export const CLIENT_PROTO_MISMATCH = "client.proto_mismatch";
// Symmetric auth: the worker's hello.proof was missing or didn't verify
// against the public key it claimed as its own node_id — the peer on the
// other end of this connection hasn't proven it holds that key, so it may
// not actually be the worker it claims to be.
export const CLIENT_WORKER_UNVERIFIED = "client.worker_unverified";

/**
 * An error from (or about) a protocol v1 connection.
 *
 * Constructed either from a worker's `res.error` frame (code/msg/data
 * carried over verbatim) or locally, for a `client.*` condition. Callers
 * branch on `.code`, matching the namespaced-string convention above
 * instead of pattern-matching `.message` text.
 */
export class WorkerProtocolError extends Error {
  /**
   * @param {string} code
   * @param {string} msg
   * @param {unknown} [data]
   */
  constructor(code, msg, data) {
    super(msg);
    this.name = "WorkerProtocolError";
    /** @type {string} */
    this.code = code;
    /** @type {unknown} */
    this.data = data;
  }
}
