/**
 * Port of sleap-app src/lib/protocolV1/envelope.ts @ 683a159.
 *
 * Wire envelope for the sleap-connect protocol v1.
 *
 * Mirrors `sleap_rtc/protocol_v1/envelope.py` (sleap-connect worker repo) and
 * docs/plans/2026-09-26-sleap-connect-protocol-v1-spec.md §2: every message
 * on the wire is one JSON object shaped `{ v, type: "hello" | "req" | "res"
 * | "event", ... }`. This module only handles frame (de)serialization;
 * dispatch and transport live in `client.js`.
 *
 * LUCID changes: none (TypeScript interfaces became JSDoc typedefs).
 */

export const PROTOCOL_VERSION = 1;

/**
 * @typedef {object} AgentInfo
 * @property {string} name
 * @property {string} version
 * @property {string} platform
 * @property {string} [device_name] This device's name, shown in the worker's paired-devices list (`clients.list`).
 */

/**
 * @typedef {object} HelloFrame
 * @property {number} v
 * @property {"hello"} type
 * @property {{min: number, max: number}} proto
 * @property {AgentInfo} agent
 * @property {string} node_id
 * @property {string} nonce
 * @property {number} [blob_port] The worker's blob-serving HTTP port (spec §6.3), on the same host the client dialed for this WS connection. Additive per §2.4; only ever present on a worker's own hello.
 * @property {string} [proof] Symmetric auth: the WORKER's signature over the CLIENT's own `nonce`, proving the worker holds the private key for the `node_id` it claimed in this same frame. Verified in `WorkerClient._handleHello`. Only ever present on a worker's own hello.
 */

/**
 * @typedef {object} ReqFrame
 * @property {number} v
 * @property {"req"} type
 * @property {number} id
 * @property {string} method
 * @property {Record<string, unknown>} params
 */

/**
 * @typedef {object} ResError
 * @property {string} code
 * @property {string} msg
 * @property {unknown} [data]
 */

/**
 * @typedef {object} ResFrame
 * @property {number} v
 * @property {"res"} type
 * @property {number} id
 * @property {Record<string, unknown>} [result]
 * @property {ResError} [error]
 */

/**
 * @typedef {object} EventFrame
 * @property {number} v
 * @property {"event"} type
 * @property {string} topic
 * @property {number} seq
 * @property {Record<string, unknown>} data
 * @property {string} [job_id]
 */

/** @typedef {HelloFrame | ReqFrame | ResFrame | EventFrame} Envelope */

/** Raised when a raw wire message doesn't parse as a valid envelope frame. */
export class EnvelopeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/**
 * @param {{nodeId: string, nonce: string, agent: AgentInfo, protoMin?: number, protoMax?: number}} params
 * @returns {HelloFrame}
 */
export function buildHello(params) {
  return {
    v: PROTOCOL_VERSION,
    type: "hello",
    proto: {
      min: params.protoMin ?? PROTOCOL_VERSION,
      max: params.protoMax ?? PROTOCOL_VERSION,
    },
    agent: params.agent,
    node_id: params.nodeId,
    nonce: params.nonce,
  };
}

/**
 * @param {number} id
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 * @returns {ReqFrame}
 */
export function buildReq(id, method, params = {}) {
  return { v: PROTOCOL_VERSION, type: "req", id, method, params };
}

/**
 * Parse a raw wire message into the appropriate frame type.
 *
 * Throws `EnvelopeError` if `raw` isn't valid JSON, has an unrecognized or
 * missing `type`, or is missing a field required for its type — matching
 * the Python `parse_envelope`'s error behavior exactly.
 *
 * @param {string} raw
 * @returns {Envelope}
 */
export function parseEnvelope(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new EnvelopeError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EnvelopeError("Envelope frame must be a JSON object");
  }

  const frame = parsed;
  const v = typeof frame.v === "number" ? frame.v : PROTOCOL_VERSION;

  switch (frame.type) {
    case "hello":
      requireFields(frame, ["proto", "agent", "node_id", "nonce"]);
      return {
        v,
        type: "hello",
        proto: frame.proto,
        agent: frame.agent,
        node_id: frame.node_id,
        nonce: frame.nonce,
        blob_port: frame.blob_port,
        proof: frame.proof,
      };

    case "req":
      requireFields(frame, ["id", "method"]);
      return {
        v,
        type: "req",
        id: frame.id,
        method: frame.method,
        params: frame.params ?? {},
      };

    case "res":
      requireFields(frame, ["id"]);
      return {
        v,
        type: "res",
        id: frame.id,
        result: frame.result,
        error: frame.error,
      };

    case "event":
      requireFields(frame, ["topic", "seq"]);
      return {
        v,
        type: "event",
        topic: frame.topic,
        seq: frame.seq,
        data: frame.data ?? {},
        job_id: frame.job_id,
      };

    default:
      throw new EnvelopeError(`Unknown or missing envelope type: ${JSON.stringify(frame.type)}`);
  }
}

/**
 * @param {Record<string, unknown>} frame
 * @param {string[]} fields
 */
function requireFields(frame, fields) {
  for (const field of fields) {
    if (frame[field] === undefined) {
      throw new EnvelopeError(
        `Missing required field '${field}' for type ${JSON.stringify(frame.type)}`,
      );
    }
  }
}
