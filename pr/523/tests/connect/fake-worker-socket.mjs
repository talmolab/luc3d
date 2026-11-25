/**
 * Port of sleap-app tests/unit/protocolV1FakeWorkerSocket.ts @ 683a159.
 *
 * A minimal, scriptable fake of a protocol v1 worker's WebSocket endpoint,
 * NOT a mock of `WorkerClient` itself. It implements just enough of the real
 * wire behaviour (`sleap_connect/protocol_v1/server.py`, auth.py, envelope.py
 * @ 0610a6b) for the client tests to drive `WorkerClient` against real
 * request/response/event framing, including real Ed25519 signature checks for
 * `auth.prove` AND `hello.proof` (symmetric auth): no crypto is faked away.
 *
 * Plain-JS port; the API is identical (`FakeWorkerSocket` with
 * `send/close/readyState/onopen/onmessage/onclose/onerror`, `simulateOpen`,
 * `emitEvent`, `sent`, `clientNodeId`, options `workerNodeId, workerNonce,
 * protoMin, protoMax, blobPort, handleRequest, proofOverride`). Dependency-free:
 * only `globalThis.crypto.subtle` (Ed25519, Node >= 22).
 *
 * DIFFERENCES from the real server (sleap-app's behaviour is kept; see also
 * `fake-worker.mjs`, whose state machine does implement the real behaviour):
 *  1. No auth gating. The real server answers any method other than
 *     `pair.claim`/`auth.prove` on an unauthenticated connection with
 *     `auth.required` ("Connection is not authenticated"); this fake hands
 *     every request to `handleRequest`.
 *  2. `pair.claim` (default handler) always succeeds and ignores the secret;
 *     the real one consumes a one-time secret and answers `auth.pairing_expired`
 *     ("Pairing secret is invalid or already used") for an unknown/used one.
 *  3. `auth.prove` (default handler) only checks the signature; the real one
 *     additionally requires the node to be paired (`auth.untrusted`,
 *     "Node '<id>' is not paired with this worker") and marks the connection
 *     authenticated.
 *  4. The worker nonce is a fixed string ("worker-nonce" by default); the real
 *     one is a fresh `secrets.token_urlsafe(16)` per connection.
 *  5. The client's `hello.proto` range is not checked; the real server closes
 *     with code 1002 / reason "proto.mismatch" when the ranges do not overlap.
 *  6. `close()` fires `onclose(undefined)` (no CloseEvent code/reason), and the
 *     real server's 4001 "auth.untrusted" close is not modelled.
 *  7. `emitEvent` does not keep a backlog or allocate `seq`; the real server
 *     stores events per job and replays `seq > since_seq` on `jobs.subscribe`.
 *  8. A handler outcome of `{}` produces a `res` with neither `result` nor
 *     `error`; the real `Res.to_dict` emits `result: {}` in that case. (Handlers
 *     in the client tests always return `{result: ...}` or `{error: ...}`.)
 * 10. The default `auth.prove` error msg is "bad signature"; the real one is
 *     "Signature does not match this connection's nonce" (code identical).
 *  9. Unparsable / non-req / non-hello frames are silently ignored, as the real
 *     server does (it logs a warning); a `req` before `hello` is answered here
 *     whereas the real server closes with 1002 "expected hello as the first frame".
 */

// A real Ed25519 keypair every `FakeWorkerSocket` signs `hello.proof` with by
// default, so `workerNodeId` is a real public key `WorkerClient` can verify
// against. Generated lazily (first use, memoized); `workerNodeId` is set once
// this resolves (see `_respond`'s hello branch), always before anything reads
// it in practice (only after a real `connect()` round-trip completes).
let _defaultWorkerKeyPairPromise = null;
function getDefaultWorkerKeyPair() {
    if (!_defaultWorkerKeyPairPromise) {
        _defaultWorkerKeyPairPromise = (async () => {
            const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
            const nodeId = bytesToB64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
            return { privateKey: pair.privateKey, nodeId };
        })();
    }
    return _defaultWorkerKeyPairPromise;
}

function bytesToB64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64ToBytes(b64) {
    let std = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (std.length % 4) std += '=';
    return Uint8Array.from(atob(std), (c) => c.charCodeAt(0));
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/**
 * @typedef {{result?: Record<string, unknown>, error?: {code: string, msg: string, data?: unknown}}} FakeResponse
 * @typedef {(method: string, params: Record<string, unknown>, socket: FakeWorkerSocket) => FakeResponse | Promise<FakeResponse>} FakeRequestHandler
 * @typedef {object} FakeWorkerOptions
 * @property {string} [workerNodeId]
 * @property {string} [workerNonce]
 * @property {number} [protoMin]
 * @property {number} [protoMax]
 * @property {number} [blobPort] Announced as `hello.blob_port`; omit to leave it unset.
 * @property {FakeRequestHandler} [handleRequest]
 * @property {string|null} [proofOverride] Overrides `hello.proof`. Omit: a real
 *   signature over the client's nonce with the shared default keypair. `null`:
 *   omit `proof` from the hello (an old/misconfigured worker). A string: send
 *   that literal value (forged proof, for negative-verification tests).
 */

export class FakeWorkerSocket {
    /** @param {FakeWorkerOptions} [opts] */
    constructor(opts = {}) {
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        this.readyState = CONNECTING;
        /** Every frame the client sent, in order, for assertions. */
        this.sent = [];
        /** Captured from the client's `hello.node_id` once it arrives. */
        this.clientNodeId = null;

        this._usingDefaultKeyPair = opts.workerNodeId === undefined;
        // A custom workerNodeId is known synchronously; the default (real,
        // signable) one resolves lazily before the hello reply.
        this.workerNodeId = opts.workerNodeId ?? '';
        this._proofOverride = opts.proofOverride;
        this.workerNonce = opts.workerNonce ?? 'worker-nonce';
        this.protoMin = opts.protoMin ?? 1;
        this.protoMax = opts.protoMax ?? 1;
        this.blobPort = opts.blobPort;
        this._handleRequest = opts.handleRequest ?? defaultHandleRequest;
    }

    /** Simulates the transport finishing its connect handshake. */
    simulateOpen() {
        this.readyState = OPEN;
        this.onopen?.(undefined);
    }

    send(data) {
        const frame = JSON.parse(data);
        this.sent.push(frame);
        void this._respond(frame);
    }

    close() {
        this.readyState = CLOSED;
        this.onclose?.(undefined);
    }

    /** Push an `event` frame to the client, as if the worker emitted it. */
    emitEvent(topic, jobId, seq, data) {
        this.onmessage?.({
            data: JSON.stringify({ v: 1, type: 'event', topic, seq, job_id: jobId, data }),
        });
    }

    async _respond(frame) {
        if (frame.type === 'hello') {
            this.clientNodeId = frame.node_id;
            let proof = this._proofOverride;
            if (proof === undefined && this._usingDefaultKeyPair) {
                const { privateKey, nodeId } = await getDefaultWorkerKeyPair();
                this.workerNodeId = nodeId;
                proof = await signWithWorkerKey(privateKey, frame.nonce);
            }
            // proof stays undefined for a custom workerNodeId with no matching
            // private key to sign with, unless proofOverride set one.
            this.onmessage?.({
                data: JSON.stringify({
                    v: 1,
                    type: 'hello',
                    proto: { min: this.protoMin, max: this.protoMax },
                    agent: { name: 'sleap-connect-worker', version: '0.0.0', platform: 'test' },
                    node_id: this.workerNodeId,
                    nonce: this.workerNonce,
                    ...(this.blobPort !== undefined ? { blob_port: this.blobPort } : {}),
                    ...(proof !== undefined && proof !== null ? { proof } : {}),
                }),
            });
            return;
        }

        if (frame.type === 'req') {
            const outcome = await this._handleRequest(frame.method, frame.params ?? {}, this);
            this.onmessage?.({
                data: JSON.stringify({ v: 1, type: 'res', id: frame.id, ...outcome }),
            });
        }
    }
}

/** Signs `nonce` with `privateKey`: the fake-socket counterpart of `WorkerIdentity.sign`. */
async function signWithWorkerKey(privateKey, nonce) {
    const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(nonce));
    return bytesToB64(new Uint8Array(signature));
}

async function defaultHandleRequest(method, params, socket) {
    if (method === 'pair.claim') return { result: {} };

    if (method === 'auth.prove') {
        if (!socket.clientNodeId) {
            return { error: { code: 'internal', msg: 'no client node_id captured' } };
        }
        const ok = await verifyEd25519(socket.clientNodeId, socket.workerNonce, params.sig);
        return ok ? { result: {} } : { error: { code: 'auth.bad_signature', msg: 'bad signature' } };
    }

    return { error: { code: 'proto.unknown_method', msg: `no handler for ${method}` } };
}

async function verifyEd25519(nodeIdB64, nonce, sigB64) {
    try {
        const publicKey = await crypto.subtle.importKey('raw', b64ToBytes(nodeIdB64), 'Ed25519', false, ['verify']);
        return await crypto.subtle.verify(
            'Ed25519',
            publicKey,
            b64ToBytes(sigB64),
            new TextEncoder().encode(nonce),
        );
    } catch {
        return false;
    }
}
