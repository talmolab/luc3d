/**
 * Port of sleap-app tests/unit/protocolV1Client.test.ts @ 683a159.
 * `WorkerClient` against the faithful FakeWorkerSocket port (tests/connect/fake-worker-socket.mjs).
 * Differences: identities come from `createMemoryAdapter()` instead of fake-indexeddb.
 */

// Several tests drive the client into its logged-and-ignored paths on purpose.
console.warn = () => {};
import { describe, it, expect, run } from './connect-test-utils.mjs';
import {
  WorkerClient,
} from '../pose/connect/client.js';
import {
  BLOB_HASH_MISMATCH,
  BLOB_INCOMPLETE,
  BLOB_UNKNOWN,
  CLIENT_CLOSED,
  CLIENT_PROTO_MISMATCH,
  CLIENT_TIMEOUT,
  CLIENT_WORKER_UNVERIFIED,
  FS_FORBIDDEN,
  FS_NOT_FOUND,
  WorkerProtocolError,
} from '../pose/connect/errors.js';
import {
  getClientIdentity,
  setIdentityStorage,
  createMemoryAdapter,
} from '../pose/connect/identity.js';
import { FakeWorkerSocket } from './connect/fake-worker-socket.mjs';

async function freshIdentity() {
  setIdentityStorage(createMemoryAdapter()); // a brand-new key every call; drops the cache
  return getClientIdentity();
}

function makeClient(
  identity,
  socket,
  overrides = {},
) {
  return new WorkerClient({
    url: "ws://fake-worker",
    identity,
    createSocket: () => socket,
    requestTimeoutMs: 1000,
    ...overrides,
  });
}

/** Connects a client against a fake socket and returns once hello completes. */
async function connected(
  identity,
  socket,
  overrides = {},
) {
  const client = makeClient(identity, socket, overrides);
  const connectPromise = client.connect();
  socket.simulateOpen();
  await connectPromise;
  return client;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject");
}

describe("protocolV1 WorkerClient", () => {
  describe("hello handshake", () => {
    it("completes the handshake and becomes 'unauthenticated'", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      expect(client.state).toBe("unauthenticated");
      expect(client.authenticated).toBe(false);
      expect(client.peerNodeId).toBe(socket.workerNodeId);
      expect(socket.sent[0]).toMatchObject({ type: "hello", node_id: identity.nodeId });
    });

    it("rejects with client.proto_mismatch when proto ranges don't overlap", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ protoMin: 5, protoMax: 5 });
      const client = makeClient(identity, socket, { protoMin: 1, protoMax: 1 });

      const connectPromise = client.connect();
      socket.simulateOpen();
      const err = await rejection(connectPromise);

      expect(err).toBeInstanceOf(WorkerProtocolError);
      expect(err.code).toBe(CLIENT_PROTO_MISMATCH);
      expect(client.state).toBe("closed");
    });

    it("connects successfully with a worker's real hello.proof (symmetric auth, happy path)", async () => {
      // No special setup -- FakeWorkerSocket signs a real proof by default,
      // and `connected()` (used throughout this whole file) already relies
      // on that succeeding. This test just makes the assertion explicit.
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);
      expect(client.state).toBe("unauthenticated");
    });

    it("rejects with client.worker_unverified when hello.proof is missing", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ proofOverride: null });
      const client = makeClient(identity, socket);

      const connectPromise = client.connect();
      socket.simulateOpen();
      const err = await rejection(connectPromise);

      expect(err.code).toBe(CLIENT_WORKER_UNVERIFIED);
      expect(client.state).toBe("closed");
    });

    it("rejects with client.worker_unverified when hello.proof is forged/garbage", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ proofOverride: "not-a-real-signature" });
      const client = makeClient(identity, socket);

      const connectPromise = client.connect();
      socket.simulateOpen();
      const err = await rejection(connectPromise);

      expect(err.code).toBe(CLIENT_WORKER_UNVERIFIED);
      expect(client.state).toBe("closed");
    });

    it("rejects with client.worker_unverified when hello.proof signs a different nonce", async () => {
      // A valid signature -- just not over the nonce THIS client actually
      // sent (e.g. a replayed proof from a different handshake).
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: () => ({ result: {} }),
      });
      // Force the socket to sign a nonce we control, independent of
      // whatever the client sends as its own nonce.
      const originalSend = socket.send.bind(socket);
      socket.send = (data) => {
        const frame = JSON.parse(data);
        if (frame.type === "hello") frame.nonce = "a-different-nonce-than-the-real-one";
        originalSend(JSON.stringify(frame));
      };
      const client = makeClient(identity, socket);

      const connectPromise = client.connect();
      socket.simulateOpen();
      const err = await rejection(connectPromise);

      expect(err.code).toBe(CLIENT_WORKER_UNVERIFIED);
    });

    it("throws if connect() is called on an already-open client", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      expect(() => client.connect()).toThrow(WorkerProtocolError);
    });

    it("rejects immediately if a method is called before connecting", async () => {
      const identity = await freshIdentity();
      const client = makeClient(identity, new FakeWorkerSocket());

      const err = await rejection(client.jobsList());
      expect(err.code).toBe(CLIENT_CLOSED);
    });

    it("ignores a duplicate hello frame after the handshake completed", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);
      const priorPeerNodeId = client.peerNodeId;

      socket.onmessage?.({
        data: JSON.stringify({
          v: 1,
          type: "hello",
          proto: { min: 1, max: 1 },
          agent: { name: "x", version: "0", platform: "y" },
          node_id: "different-node",
          nonce: "different-nonce",
        }),
      });

      expect(client.peerNodeId).toBe(priorPeerNodeId);
      expect(client.state).toBe("unauthenticated");
    });

    it("ignores unparseable frames without throwing", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      expect(() => socket.onmessage?.({ data: "not json" })).not.toThrow();
      expect(client.state).toBe("unauthenticated");
    });
  });

  describe("pairing and auth", () => {
    it("pairClaim authenticates using a one-time secret", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      await client.pairClaim("the-secret");

      expect(client.authenticated).toBe(true);
      const pairReq = socket.sent.find((f) => f.method === "pair.claim");
      expect(pairReq?.params).toEqual({ secret: "the-secret", node_id: identity.nodeId });
    });

    it("authProve signs the worker's hello nonce with real Ed25519 and authenticates", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ workerNonce: "specific-nonce-xyz" });
      const client = await connected(identity, socket);

      await client.authProve();

      expect(client.authenticated).toBe(true);
      const proveReq = socket.sent.find((f) => f.method === "auth.prove");
      expect(typeof proveReq?.params).toBe("object");
      expect((proveReq?.params).sig).toBeDefined();
    });

    it("authProve surfaces the worker's error code on a bad signature", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "auth.prove") {
            return { error: { code: "auth.bad_signature", msg: "signature mismatch" } };
          }
          return { result: {} };
        },
      });
      const client = await connected(identity, socket);

      const err = await rejection(client.authProve());
      expect(err.code).toBe("auth.bad_signature");
      expect(client.authenticated).toBe(false);
    });
  });

  describe("requests", () => {
    it("rejects a request that never gets a response after requestTimeoutMs", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ handleRequest: () => new Promise(() => {}) });
      const client = await connected(identity, socket, { requestTimeoutMs: 20 });

      const err = await rejection(client.pairClaim("secret"));
      expect(err.code).toBe(CLIENT_TIMEOUT);
    });

    it("close() rejects any in-flight request", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ handleRequest: () => new Promise(() => {}) });
      const client = await connected(identity, socket);

      const pending = client.pairClaim("secret");
      client.close();

      const err = await rejection(pending);
      expect(err.code).toBe(CLIENT_CLOSED);
    });

    it("a remote close rejects in-flight requests and marks the client closed", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ handleRequest: () => new Promise(() => {}) });
      const client = await connected(identity, socket);

      const pending = client.jobsList();
      socket.close();

      const err = await rejection(pending);
      expect(err.code).toBe(CLIENT_CLOSED);
      expect(client.state).toBe("closed");
    });
  });

  describe("onClose", () => {
    it("a remote close notifies listeners once with {intentional: false} and a client.closed error", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      const notifications = [];
      client.onClose((info) => notifications.push(info));
      socket.close();

      expect(notifications).toHaveLength(1);
      expect(notifications[0].intentional).toBe(false);
      expect(notifications[0].error?.code).toBe(CLIENT_CLOSED);
    });

    it("client.close() notifies listeners once with {intentional: true}", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      const notifications = [];
      client.onClose((info) => notifications.push(info));
      client.close();

      expect(notifications).toEqual([{ intentional: true }]);
    });

    it("closing twice only notifies once", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      const notifications = [];
      client.onClose((info) => notifications.push(info));
      client.close();
      client.close();

      expect(notifications).toHaveLength(1);
    });

    it("unsubscribing stops further notifications", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      const notifications = [];
      const unsubscribe = client.onClose((info) => notifications.push(info));
      unsubscribe();
      client.close();

      expect(notifications).toHaveLength(0);
    });

    it("a throwing listener doesn't stop other listeners from being notified", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      const notifications = [];
      client.onClose(() => {
        throw new Error("listener boom");
      });
      client.onClose((info) => notifications.push(info));
      client.close();

      expect(notifications).toHaveLength(1);
    });
  });

  describe("jobs.* / fs.* methods", () => {
    async function pairedClient(
      identity,
      socket,
    ) {
      const client = await connected(identity, socket);
      await client.pairClaim("secret");
      return client;
    }

    it("jobsSubmit sends spec + client_job_id and returns the worker-assigned job_id", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.submit") return { result: { job_id: "job_abc" } };
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const { jobId } = await client.jobsSubmit(
        { type: "train", labels_path: "x.slp" },
        "cj_1",
      );

      expect(jobId).toBe("job_abc");
      const submitReq = socket.sent.find((f) => f.method === "jobs.submit");
      expect(submitReq?.params).toEqual({
        spec: { type: "train", labels_path: "x.slp" },
        client_job_id: "cj_1",
      });
    });

    it("jobsCancel sends job_id + mode, defaulting to 'cancel'", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          return { result: {} };
        },
      });
      const client = await pairedClient(identity, socket);

      await client.jobsCancel("job_abc");
      await client.jobsCancel("job_def", "stop");

      const cancelReqs = socket.sent.filter((f) => f.method === "jobs.cancel");
      expect(cancelReqs.map((f) => f.params)).toEqual([
        { job_id: "job_abc", mode: "cancel" },
        { job_id: "job_def", mode: "stop" },
      ]);
    });

    it("jobsStatus maps the snake_case result to a typed JobStatus", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.status") {
            return {
              result: {
                job_id: "job_abc",
                state: "completed",
                created_at: "2026-09-27T00:00:00Z",
                updated_at: "2026-09-27T01:00:00Z",
                result: { blobs: {} },
                error: null,
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const status = await client.jobsStatus("job_abc");
      expect(status).toEqual({
        jobId: "job_abc",
        state: "completed",
        createdAt: "2026-09-27T00:00:00Z",
        updatedAt: "2026-09-27T01:00:00Z",
        result: { blobs: {} },
        error: null,
        queuePosition: null,
        modelTypes: [],
      });
    });

    it("jobsList maps the summary array", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.list") {
            return {
              result: {
                jobs: [
                  { job_id: "job_1", state: "running", created_at: "t1" },
                  { job_id: "job_2", state: "completed", created_at: "t2" },
                ],
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const jobs = await client.jobsList();
      expect(jobs).toEqual([
        { jobId: "job_1", state: "running", createdAt: "t1", queuePosition: null, modelTypes: [] },
        { jobId: "job_2", state: "completed", createdAt: "t2", queuePosition: null, modelTypes: [] },
      ]);
    });

    it("clientsList maps devices, converting unix seconds to ISO and keeping nulls", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "clients.list") {
            return {
              result: {
                clients: [
                  {
                    node_id: "me",
                    name: "Lab Mac",
                    platform: "tauri",
                    app_version: "0.1.2",
                    paired_at: 1_700_000_000,
                    last_seen_at: 1_700_000_060,
                    you: true,
                  },
                  { node_id: "old", name: null, platform: null, app_version: null, paired_at: null, last_seen_at: null, you: false },
                ],
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      expect(await client.clientsList()).toEqual([
        {
          nodeId: "me",
          name: "Lab Mac",
          platform: "tauri",
          appVersion: "0.1.2",
          pairedAt: new Date(1_700_000_000_000).toISOString(),
          lastSeenAt: new Date(1_700_000_060_000).toISOString(),
          you: true,
        },
        { nodeId: "old", name: null, platform: null, appVersion: null, pairedAt: null, lastSeenAt: null, you: false },
      ]);
    });

    it("clientsRename sends the new name", async () => {
      const identity = await freshIdentity();
      const sent = [];
      const socket = new FakeWorkerSocket({
        handleRequest: (method, p) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "clients.rename") {
            sent.push(p);
            return { result: {} };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      await client.clientsRename("Bench PC");
      expect(sent).toEqual([{ name: "Bench PC" }]);
    });

    it("sends agent.device_name in the hello", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      await connected(identity, socket, {
        agent: { name: "sleap-app", version: "1", platform: "web", device_name: "Chrome on macOS" },
      });
      const hello = socket.sent.find((f) => f.type === "hello");
      expect((hello?.agent).device_name).toBe("Chrome on macOS");
    });

    it("fsMounts maps the mounts array", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "fs.mounts") {
            return { result: { mounts: [{ path: "/mnt/data", label: "Lab data" }] } };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const mounts = await client.fsMounts();
      expect(mounts).toEqual([{ path: "/mnt/data", label: "Lab data" }]);
    });

    it("fsList sends path + offset and maps entries/total_count/has_more", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "fs.list") {
            return {
              result: {
                entries: [{ name: "a.slp", type: "file", size: 123 }],
                total_count: 1,
                has_more: false,
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const result = await client.fsList("/mnt/data", 10);
      expect(result).toEqual({
        entries: [{ name: "a.slp", type: "file", size: 123 }],
        totalCount: 1,
        hasMore: false,
      });
      const listReq = socket.sent.find((f) => f.method === "fs.list");
      expect(listReq?.params).toEqual({ path: "/mnt/data", offset: 10 });
    });

    it("fsStat maps path/type/size/modified", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "fs.stat") {
            return {
              result: { path: "/mnt/data/a.slp", type: "file", size: 123, modified: 1700000000 },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const result = await client.fsStat("/mnt/data/a.slp");
      expect(result).toEqual({
        path: "/mnt/data/a.slp",
        type: "file",
        size: 123,
        modified: 1700000000,
        shared: true,
      });
    });

    it("fsStat reports a path outside the shared folders as shared: false", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "fs.stat") return { result: { path: "/raw/v.mp4", type: "file", shared: false } };
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);
      const result = await client.fsStat("/raw/v.mp4");
      expect(result.shared).toBe(false);
      expect(result.type).toBe("file");
    });

    it("fsRead sends path/offset/length and base64-decodes the content", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "fs.read") {
            return {
              result: {
                path: "/mnt/data/a.yaml",
                content_base64: btoa("hello"),
                offset: 0,
                size: 5,
                total_size: 5,
                eof: true,
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const result = await client.fsRead("/mnt/data/a.yaml", 0, 10);

      expect(new TextDecoder().decode(result.content)).toBe("hello");
      expect(result).toMatchObject({ path: "/mnt/data/a.yaml", offset: 0, size: 5, totalSize: 5, eof: true });
      const readReq = socket.sent.find((f) => f.method === "fs.read");
      expect(readReq?.params).toEqual({ path: "/mnt/data/a.yaml", offset: 0, length: 10 });
    });

    it("mediaFrame sends path/frame_idx and returns the decoded JPEG with both sizes", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "media.frame") {
            return {
              result: {
                content_base64: btoa("jpegbytes"),
                mime: "image/jpeg",
                width: 4096,
                height: 2048,
                scaled_width: 2048,
                scaled_height: 1024,
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const result = await client.mediaFrame("/data/v.mp4", 42);

      expect(new TextDecoder().decode(result.content)).toBe("jpegbytes");
      expect(result).toMatchObject({ mime: "image/jpeg", width: 4096, height: 2048, scaledWidth: 2048, scaledHeight: 1024 });
      const req = socket.sent.find((f) => f.method === "media.frame");
      expect(req?.params).toEqual({ path: "/data/v.mp4", frame_idx: 42 });
    });

    it("fsRead omits length from params when not given", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "fs.read") {
            return {
              result: { path: "/x", content_base64: "", offset: 0, size: 0, total_size: 0, eof: true },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      await client.fsRead("/x");

      const readReq = socket.sent.find((f) => f.method === "fs.read");
      expect(readReq?.params).toEqual({ path: "/x", offset: 0 });
    });

    it("fsStat throws a WorkerProtocolError when the worker reports a not-found error embedded in the result", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "fs.stat") {
            return { result: { error: "Path does not exist", error_code: "PATH_NOT_FOUND" } };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      await expect(client.fsStat("/missing")).rejects.toMatchObject({
        code: FS_NOT_FOUND,
      });
    });

    it("fsRead throws a WorkerProtocolError when the worker reports access-denied embedded in the result", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "fs.read") {
            return {
              result: { error: "Access denied: path is outside configured mounts", error_code: "ACCESS_DENIED" },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      await expect(client.fsRead("/etc/shadow")).rejects.toMatchObject({
        code: FS_FORBIDDEN,
      });
    });
  });

  describe("worker.info / richer job summaries", () => {
    async function pairedClient(
      identity,
      socket,
    ) {
      const client = await connected(identity, socket);
      await client.pairClaim("secret");
      return client;
    }

    it("workerInfo maps gpu/cuda/sleap_nn_version fields", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "worker.info") {
            return {
              result: {
                gpu_model: "NVIDIA RTX 4090",
                gpu_memory_mb: 24576,
                gpu_count: 2,
                cuda_version: "12.4",
                sleap_nn_version: "0.1.0",
                busy: true,
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const info = await client.workerInfo();
      expect(info).toEqual({
        gpuModel: "NVIDIA RTX 4090",
        gpuMemoryMb: 24576,
        gpuCount: 2,
        cudaVersion: "12.4",
        sleapNnVersion: "0.1.0",
        busy: true,
        features: [],
      });
    });

    it("workerInfo defaults missing numeric/string fields and coerces busy", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "worker.info") return { result: {} };
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const info = await client.workerInfo();
      expect(info).toEqual({
        gpuModel: "unknown",
        gpuMemoryMb: 0,
        gpuCount: 0,
        cudaVersion: "unknown",
        sleapNnVersion: "unknown",
        busy: false,
        features: [],
      });
    });

    it("jobsList converts the worker's Unix-second timestamps to ISO strings", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.list") {
            return {
              result: {
                jobs: [{ job_id: "job_1", state: "running", created_at: 1791158400.5, updated_at: 1791158460 }],
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const [job] = await client.jobsList();
      expect(job.createdAt).toBe(new Date(1791158400500).toISOString());
      expect(job.updatedAt).toBe(new Date(1791158460000).toISOString());
    });

    it("jobsList maps the full #98 shape (queuePosition, kind, modelTypes, labelsPath, project)", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.list") {
            return {
              result: {
                jobs: [
                  {
                    job_id: "job_1",
                    state: "queued",
                    created_at: "t1",
                    updated_at: "t1b",
                    error: null,
                    queue_position: 2,
                    kind: "train",
                    model_types: ["centroid", "centered_instance"],
                    labels_path: "/mnt/data/labels.slp",
                    project: { name: "Flies", id: "proj_1" },
                  },
                ],
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const jobs = await client.jobsList();
      expect(jobs).toEqual([
        {
          jobId: "job_1",
          state: "queued",
          createdAt: "t1",
          updatedAt: "t1b",
          error: null,
          queuePosition: 2,
          kind: "train",
          modelTypes: ["centroid", "centered_instance"],
          labelsPath: "/mnt/data/labels.slp",
          project: { name: "Flies", id: "proj_1" },
        },
      ]);
    });

    it("jobsList maps model_name (sleap-connect #98) to modelName, and omits it when absent", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.list") {
            return {
              result: {
                jobs: [
                  {
                    job_id: "job_1",
                    state: "completed",
                    created_at: "t1",
                    kind: "train",
                    model_name: "260922_015758.centroid.n=1",
                  },
                  { job_id: "job_2", state: "running", created_at: "t2", kind: "train" },
                ],
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const jobs = await client.jobsList();
      expect(jobs[0] .modelName).toBe("260922_015758.centroid.n=1");
      expect(jobs[1] .modelName).toBeUndefined();
    });

    it("jobsList maps a run tag (sleap-connect feat/connect-run-id)", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.list") {
            return {
              result: {
                jobs: [
                  {
                    job_id: "job_1",
                    state: "running",
                    created_at: "t1",
                    run: { id: "run_abc", index: 0, count: 2 },
                  },
                ],
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const jobs = await client.jobsList();
      expect(jobs[0].run).toEqual({ id: "run_abc", index: 0, count: 2 });
    });

    it("jobsList still works against the old minimal shape (queuePosition null, modelTypes empty)", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.list") {
            return {
              result: {
                jobs: [{ job_id: "job_1", state: "running", created_at: "t1" }],
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const jobs = await client.jobsList();
      expect(jobs).toEqual([
        {
          jobId: "job_1",
          state: "running",
          createdAt: "t1",
          queuePosition: null,
          modelTypes: [],
        },
      ]);
    });

    it("jobsStatus includes spec", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.status") {
            return {
              result: {
                job_id: "job_1",
                state: "running",
                created_at: "t1",
                updated_at: "t2",
                result: null,
                error: null,
                queue_position: null,
                kind: "track",
                model_types: ["centroid"],
                spec: { type: "track", labels_path: "/x.slp" },
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const status = await client.jobsStatus("job_1");
      expect(status).toMatchObject({
        jobId: "job_1",
        kind: "track",
        modelTypes: ["centroid"],
        spec: { type: "track", labels_path: "/x.slp" },
      });
    });
  });

  describe("jobsSubscribe / events", () => {
    async function pairedClient(
      identity,
      socket,
    ) {
      const client = await connected(identity, socket);
      await client.pairClaim("secret");
      return client;
    }

    it("registers the listener before sending the request, so backlog events emitted synchronously during the request handler are never missed", async () => {
      const identity = await freshIdentity();
      const received = [];
      const socket = new FakeWorkerSocket({
        handleRequest: (method, params, sock) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.subscribe") {
            const jobId = params.job_id;
            // Mirrors the real worker: backlog events are pushed to the
            // wire BEFORE the subscribe request itself is acked.
            sock.emitEvent("job.status", jobId, 1, { state: "running" });
            sock.emitEvent("job.status", jobId, 2, { state: "completed" });
            return { result: {} };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const unsubscribe = await client.jobsSubscribe("job_abc", 0, (event) =>
        received.push(event),
      );

      expect(received).toEqual([
        { topic: "job.status", seq: 1, jobId: "job_abc", data: { state: "running" } },
        { topic: "job.status", seq: 2, jobId: "job_abc", data: { state: "completed" } },
      ]);

      unsubscribe();
      socket.emitEvent("job.status", "job_abc", 3, { state: "ignored" });
      expect(received.length).toBe(2);
    });

    it("fans out events to multiple subscribers of the same job independently", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ handleRequest: () => ({ result: {} }) });
      const client = await pairedClient(identity, socket);

      const a = [];
      const b = [];
      const unsubA = await client.jobsSubscribe("job_abc", 0, (e) => a.push(e));
      await client.jobsSubscribe("job_abc", 0, (e) => b.push(e));

      socket.emitEvent("job.log", "job_abc", 1, { line: "hello" });
      expect(a.length).toBe(1);
      expect(b.length).toBe(1);

      unsubA();
      socket.emitEvent("job.log", "job_abc", 2, { line: "world" });
      expect(a.length).toBe(1);
      expect(b.length).toBe(2);
    });

    it("ignores events for jobs nothing has subscribed to", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      await pairedClient(identity, socket);

      expect(() => socket.emitEvent("job.log", "some-other-job", 1, {})).not.toThrow();
    });
  });

  describe("peerBlobPort", () => {
    it("is null when the worker doesn't announce a blob port", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      expect(client.peerBlobPort).toBeNull();
    });

    it("is set once the worker announces one in its hello", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const client = await connected(identity, socket);

      expect(client.peerBlobPort).toBe(9632);
    });
  });

  describe("fetchBlob", () => {
    async function sha256Hex(bytes) {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }

    it("throws blob.unknown if the worker never announced a blob port", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket(); // no blobPort
      const client = await connected(identity, socket);

      const err = await rejection(client.fetchBlob("abc123", 3));
      expect(err.code).toBe(BLOB_UNKNOWN);
    });

    it("fetches from http://<dialed host>:<blob_port>/blobs/<sha256>", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const content = new TextEncoder().encode("hello blob");
      const hash = await sha256Hex(content);
      let requestedUrl;
      const fetchImpl = (async (input) => {
        requestedUrl = String(input);
        return new Response(content, { status: 200 });
      });
      const client = await connected(identity, socket, { fetchImpl });

      const bytes = await client.fetchBlob(hash, content.byteLength);

      expect(requestedUrl).toBe(`http://fake-worker:9632/blobs/${hash}`);
      expect(bytes).toEqual(content);
    });

    it("derives https for a wss:// dial URL", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const content = new TextEncoder().encode("secure blob");
      const hash = await sha256Hex(content);
      let requestedUrl;
      const fetchImpl = (async (input) => {
        requestedUrl = String(input);
        return new Response(content, { status: 200 });
      });
      const client = new WorkerClient({
        url: "wss://fake-worker",
        identity,
        createSocket: () => socket,
        fetchImpl,
      });
      const connectPromise = client.connect();
      socket.simulateOpen();
      await connectPromise;

      await client.fetchBlob(hash, content.byteLength);

      expect(requestedUrl).toBe(`https://fake-worker:9632/blobs/${hash}`);
    });

    it("throws blob.unknown on a non-ok HTTP response", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const fetchImpl = (async () => new Response(null, { status: 404 }));
      const client = await connected(identity, socket, { fetchImpl });

      const err = await rejection(client.fetchBlob("abc123"));
      expect(err.code).toBe(BLOB_UNKNOWN);
    });

    it("throws blob.unknown if the fetch itself fails", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const fetchImpl = (async () => {
        throw new Error("network down");
      });
      const client = await connected(identity, socket, { fetchImpl });

      const err = await rejection(client.fetchBlob("abc123"));
      expect(err.code).toBe(BLOB_UNKNOWN);
    });

    it("throws blob.incomplete when the response size doesn't match", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const content = new TextEncoder().encode("short");
      const hash = await sha256Hex(content);
      const fetchImpl = (async () => new Response(content, { status: 200 }));
      const client = await connected(identity, socket, { fetchImpl });

      const err = await rejection(client.fetchBlob(hash, content.byteLength + 100));
      expect(err.code).toBe(BLOB_INCOMPLETE);
    });

    it("throws blob.hash_mismatch when the content doesn't match the claimed hash", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const content = new TextEncoder().encode("tampered content");
      const fetchImpl = (async () => new Response(content, { status: 200 }));
      const client = await connected(identity, socket, { fetchImpl });

      const err = await rejection(client.fetchBlob("not-the-real-hash", content.byteLength));
      expect(err.code).toBe(BLOB_HASH_MISMATCH);
    });

  });
});

await run();
