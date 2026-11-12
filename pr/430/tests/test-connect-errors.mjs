/**
 * Port of sleap-app tests/unit/protocolV1Errors.test.ts @ 683a159.
 * Error code strings and WorkerProtocolError (pose/connect/errors.js).
 */
import { describe, it, expect, run } from './bun-test-shim.mjs';
import {
  AUTH_BAD_SIGNATURE,
  AUTH_PAIRING_EXPIRED,
  AUTH_REQUIRED,
  AUTH_UNTRUSTED,
  BLOB_HASH_MISMATCH,
  BLOB_INCOMPLETE,
  BLOB_UNKNOWN,
  CLIENT_CLOSED,
  CLIENT_PROTO_MISMATCH,
  CLIENT_TIMEOUT,
  FS_FORBIDDEN,
  FS_IO_ERROR,
  FS_NOT_FOUND,
  INTERNAL,
  JOB_ALREADY_TERMINAL,
  JOB_NOT_FOUND,
  JOB_SPEC_INVALID,
  PROTO_MISMATCH,
  PROTO_UNKNOWN_METHOD,
  WorkerProtocolError,
} from '../pose/connect/errors.js';

describe("protocolV1 errors", () => {
  it("matches the worker's namespaced error code strings exactly", () => {
    expect(AUTH_REQUIRED).toBe("auth.required");
    expect(AUTH_UNTRUSTED).toBe("auth.untrusted");
    expect(AUTH_BAD_SIGNATURE).toBe("auth.bad_signature");
    expect(AUTH_PAIRING_EXPIRED).toBe("auth.pairing_expired");
    expect(PROTO_MISMATCH).toBe("proto.mismatch");
    expect(PROTO_UNKNOWN_METHOD).toBe("proto.unknown_method");
    expect(FS_NOT_FOUND).toBe("fs.not_found");
    expect(FS_FORBIDDEN).toBe("fs.forbidden");
    expect(FS_IO_ERROR).toBe("fs.io_error");
    expect(BLOB_UNKNOWN).toBe("blob.unknown");
    expect(BLOB_INCOMPLETE).toBe("blob.incomplete");
    expect(BLOB_HASH_MISMATCH).toBe("blob.hash_mismatch");
    expect(JOB_NOT_FOUND).toBe("job.not_found");
    expect(JOB_ALREADY_TERMINAL).toBe("job.already_terminal");
    expect(JOB_SPEC_INVALID).toBe("job.spec_invalid");
    expect(INTERNAL).toBe("internal");
  });

  it("namespaces client-detected codes under client.*", () => {
    expect(CLIENT_TIMEOUT).toBe("client.timeout");
    expect(CLIENT_CLOSED).toBe("client.closed");
    expect(CLIENT_PROTO_MISMATCH).toBe("client.proto_mismatch");
  });

  describe("WorkerProtocolError", () => {
    it("carries code, message, and optional data", () => {
      const err = new WorkerProtocolError(JOB_NOT_FOUND, "no such job", { job_id: "j_1" });
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("WorkerProtocolError");
      expect(err.code).toBe(JOB_NOT_FOUND);
      expect(err.message).toBe("no such job");
      expect(err.data).toEqual({ job_id: "j_1" });
    });

    it("leaves data undefined when not provided", () => {
      const err = new WorkerProtocolError(INTERNAL, "boom");
      expect(err.data).toBeUndefined();
    });
  });
});

await run();
