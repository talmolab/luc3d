/**
 * Port of sleap-app tests/unit/protocolV1Envelope.test.ts @ 683a159.
 * Wire envelope build/parse (pose/connect/envelope.js).
 */
import { describe, it, expect, run } from './connect-test-utils.mjs';
import {
  PROTOCOL_VERSION,
  buildHello,
  buildReq,
  parseEnvelope,
  EnvelopeError,
} from '../pose/connect/envelope.js';

const AGENT = { name: "sleap-app", version: "0.1.0", platform: "darwin-arm64" };

describe("protocolV1 envelope", () => {
  describe("buildHello", () => {
    it("builds a hello frame with the given identity and nonce", () => {
      const hello = buildHello({ nodeId: "node-abc", nonce: "nonce-123", agent: AGENT });
      expect(hello).toEqual({
        v: PROTOCOL_VERSION,
        type: "hello",
        proto: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
        agent: AGENT,
        node_id: "node-abc",
        nonce: "nonce-123",
      });
    });

    it("respects an explicit proto range", () => {
      const hello = buildHello({
        nodeId: "node-abc",
        nonce: "nonce-123",
        agent: AGENT,
        protoMin: 1,
        protoMax: 2,
      });
      expect(hello.proto).toEqual({ min: 1, max: 2 });
    });
  });

  describe("buildReq", () => {
    it("builds a req frame with id/method/params", () => {
      const req = buildReq(7, "jobs.submit", { spec: { type: "train" } });
      expect(req).toEqual({
        v: PROTOCOL_VERSION,
        type: "req",
        id: 7,
        method: "jobs.submit",
        params: { spec: { type: "train" } },
      });
    });

    it("defaults params to an empty object", () => {
      const req = buildReq(1, "fs.mounts");
      expect(req.params).toEqual({});
    });
  });

  describe("parseEnvelope", () => {
    it("parses a hello frame", () => {
      const raw = JSON.stringify({
        v: 1,
        type: "hello",
        proto: { min: 1, max: 1 },
        agent: AGENT,
        node_id: "worker-node-id",
        nonce: "worker-nonce",
      });
      const frame = parseEnvelope(raw);
      expect(frame.type).toBe("hello");
      if (frame.type === "hello") {
        expect(frame.node_id).toBe("worker-node-id");
        expect(frame.nonce).toBe("worker-nonce");
        expect(frame.proto).toEqual({ min: 1, max: 1 });
        expect(frame.blob_port).toBeUndefined();
      }
    });

    it("parses blob_port when present on a hello frame", () => {
      const raw = JSON.stringify({
        v: 1,
        type: "hello",
        proto: { min: 1, max: 1 },
        agent: AGENT,
        node_id: "worker-node-id",
        nonce: "worker-nonce",
        blob_port: 9632,
      });
      const frame = parseEnvelope(raw);
      expect(frame.type).toBe("hello");
      if (frame.type === "hello") {
        expect(frame.blob_port).toBe(9632);
      }
    });

    it("parses a req frame, defaulting missing params to {}", () => {
      const raw = JSON.stringify({ v: 1, type: "req", id: 3, method: "fs.mounts" });
      const frame = parseEnvelope(raw);
      expect(frame.type).toBe("req");
      if (frame.type === "req") {
        expect(frame.id).toBe(3);
        expect(frame.method).toBe("fs.mounts");
        expect(frame.params).toEqual({});
      }
    });

    it("parses a successful res frame", () => {
      const raw = JSON.stringify({ v: 1, type: "res", id: 7, result: { job_id: "j_1" } });
      const frame = parseEnvelope(raw);
      expect(frame.type).toBe("res");
      if (frame.type === "res") {
        expect(frame.result).toEqual({ job_id: "j_1" });
        expect(frame.error).toBeUndefined();
      }
    });

    it("parses an error res frame", () => {
      const raw = JSON.stringify({
        v: 1,
        type: "res",
        id: 7,
        error: { code: "job.not_found", msg: "no such job" },
      });
      const frame = parseEnvelope(raw);
      expect(frame.type).toBe("res");
      if (frame.type === "res") {
        expect(frame.error).toEqual({ code: "job.not_found", msg: "no such job" });
      }
    });

    it("parses an event frame, defaulting missing data to {}", () => {
      const raw = JSON.stringify({
        v: 1,
        type: "event",
        topic: "job.status",
        seq: 3,
        job_id: "j_1",
      });
      const frame = parseEnvelope(raw);
      expect(frame.type).toBe("event");
      if (frame.type === "event") {
        expect(frame.topic).toBe("job.status");
        expect(frame.seq).toBe(3);
        expect(frame.job_id).toBe("j_1");
        expect(frame.data).toEqual({});
      }
    });

    it("defaults a missing v to PROTOCOL_VERSION", () => {
      const raw = JSON.stringify({ type: "req", id: 1, method: "fs.mounts" });
      const frame = parseEnvelope(raw);
      expect(frame.v).toBe(PROTOCOL_VERSION);
    });

    it("throws EnvelopeError on invalid JSON", () => {
      expect(() => parseEnvelope("not json")).toThrow(EnvelopeError);
    });

    it("throws EnvelopeError on a non-object JSON value", () => {
      expect(() => parseEnvelope("42")).toThrow(EnvelopeError);
      expect(() => parseEnvelope("[1,2,3]")).toThrow(EnvelopeError);
    });

    it("throws EnvelopeError on an unknown type", () => {
      expect(() => parseEnvelope(JSON.stringify({ type: "bogus" }))).toThrow(EnvelopeError);
    });

    it("throws EnvelopeError on a missing type", () => {
      expect(() => parseEnvelope(JSON.stringify({ id: 1 }))).toThrow(EnvelopeError);
    });

    it("throws EnvelopeError when a required field is missing", () => {
      expect(() => parseEnvelope(JSON.stringify({ type: "req", id: 1 }))).toThrow(EnvelopeError);
      expect(() => parseEnvelope(JSON.stringify({ type: "res" }))).toThrow(EnvelopeError);
      expect(() =>
        parseEnvelope(JSON.stringify({ type: "event", seq: 1 })),
      ).toThrow(EnvelopeError);
      expect(() =>
        parseEnvelope(
          JSON.stringify({ type: "hello", proto: { min: 1, max: 1 }, agent: AGENT }),
        ),
      ).toThrow(EnvelopeError);
    });
  });
});

await run();
