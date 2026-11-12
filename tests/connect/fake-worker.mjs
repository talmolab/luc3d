/**
 * Scriptable fake protocol-v1 WORKER (a state machine, not a socket), for the
 * Connect port's Node tests and Playwright e2e.
 *
 * Wire truth: sleap-connect @ 0610a6b, `sleap_connect/protocol_v1/`:
 * `server.py` (hello, auth gating, dispatch), `auth.py` (pair.claim, auth.prove,
 * clients.*), `envelope.py` (frame shapes), `errors.py` (codes),
 * `job_methods.py` (jobs.*, fs.*), `worker_info.py` (worker.info),
 * `blob_http.py` (GET /blobs/<sha256> with Range), `pairing.py`,
 * and `sleap_connect/worker/file_manager.py` (fs.* payloads).
 * Real Ed25519 signatures throughout (`globalThis.crypto.subtle`, Node >= 22);
 * dependency-free (node built-ins only).
 *
 * Attach it to a transport:
 *   const worker = await FakeWorker.create({ files: { '/data/a.slp': bytes } });
 *   // (a) in-memory WebSocketLike (Node tests): hand it to the client's socket factory
 *   const socket = worker.createSocket();               // opens itself on a microtask
 *   // (b) Playwright: page.routeWebSocket(url, ws => worker.attachRoute(ws))
 *   await worker.serveOnPage(page, /ws:\/\/127\.0\.0\.1:9631/);
 *   // (c) anything with { send(str), close(code, reason) }:
 *   const conn = worker.connect(transport);  conn.receive(rawString)
 *
 * Differences from the real worker (kept deliberately small, listed so a test
 * does not mistake them for real behaviour):
 *  - Persistence: the trust store, pending pairings, job store are in memory.
 *  - Jobs do not execute. A submitted job stays `queued` until the test drives
 *    it (`setJobState`, `completeJob`, `failJob`, `pushEvent` ...), or
 *    `autoRun: true` is given (then it goes `running` right after submit).
 *  - `jobs.status.spec` is the spec as submitted minus `labels_content`; the real
 *    one is the Python dataclass `to_dict()` with every default filled in.
 *  - `jobs.cancel` of a RUNNING job: real = signal the process, it exits later and
 *    `_finish` emits canceled. Here `cancelRunning` ('immediate' default | 'manual')
 *    decides: immediate emits `job.status canceled` ("canceled by request" /
 *    "stopped early by request"), manual only records `job.cancelRequested`.
 *  - `fs.*` reads an in-memory map, no symlinks / permission errors; directories
 *    are implied by file paths (plus `addDir`). `fs.list` pages 20 entries.
 *  - `media.frame`: params validated like the real one, but nothing is decoded (see `mediaFrame`);
 *    `blobs.*`, training metrics ZMQ, iroh: not implemented (`proto.unknown_method`).
 *  - `hello.agent.version/platform` default to "0.0.0" / "test".
 */

import http from 'node:http';
import { b64urlDecode, b64urlEncode, encodePairCode } from './pair-code.mjs';

export const PROTOCOL_VERSION = 1;
export const AGENT_NAME = 'sleap-connect-worker';
export const MAX_READ_BYTES = 4 * 1024 * 1024; // FileManager.MAX_READ_BYTES
export const MAX_LIST_RESULTS = 20; // FileManager.MAX_RESULTS
export const FEATURES = ['shared_folders', 'path_checks', 'sleap_outputs', 'output_dir', 'media_frame'];
const MAX_NAME_LEN = 120; // trust_store._MAX_NAME_LEN
const TERMINAL_STATES = ['completed', 'failed', 'canceled'];
const UNAUTHENTICATED_METHODS = new Set(['pair.claim', 'auth.prove']);
/** envelope.py `from_dict`: keys that must be present (KeyError -> EnvelopeError), in the order it reads them. */
const REQUIRED_FIELDS = {
    hello: ['proto', 'agent', 'node_id', 'nonce'],
    req: ['id', 'method'],
    res: ['id'],
    event: ['topic', 'seq'],
};

/** Error codes (errors.py). */
export const ERR = {
    AUTH_REQUIRED: 'auth.required',
    AUTH_UNTRUSTED: 'auth.untrusted',
    AUTH_BAD_SIGNATURE: 'auth.bad_signature',
    AUTH_PAIRING_EXPIRED: 'auth.pairing_expired',
    PROTO_MISMATCH: 'proto.mismatch',
    PROTO_UNKNOWN_METHOD: 'proto.unknown_method',
    FS_NOT_FOUND: 'fs.not_found',
    FS_FORBIDDEN: 'fs.forbidden',
    FS_IO_ERROR: 'fs.io_error',
    JOB_NOT_FOUND: 'job.not_found',
    JOB_ALREADY_TERMINAL: 'job.already_terminal',
    JOB_SPEC_INVALID: 'job.spec_invalid',
    JOB_ACTIVE: 'job.active',
    JOB_PATH_NOT_SHARED: 'job.path_not_shared',
    MEDIA_UNREADABLE: 'media.unreadable',
    CLIENTS_BAD_NAME: 'clients.bad_name',
    INTERNAL: 'internal',
};

/** Throw from a request handler to produce `res.error` `{code, msg, data?}` (errors.ProtocolError). */
export class ProtocolError extends Error {
    constructor(code, msg, data) {
        super(msg);
        this.name = 'ProtocolError';
        this.code = code;
        this.data = data;
    }
}

const nowSecs = () => Date.now() / 1000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function randomToken(nBytes) {
    return b64urlEncode(crypto.getRandomValues(new Uint8Array(nBytes)));
}

function bytesToHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hex of bytes. */
export async function sha256Hex(bytes) {
    return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function bytesToBase64(bytes) {
    // Standard padded base64 (Python base64.b64encode), chunked to stay under argument limits.
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

function toBytes(v) {
    if (v instanceof Uint8Array) return v;
    if (typeof v === 'string') return enc.encode(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    throw new TypeError('file content must be a Uint8Array, ArrayBuffer or string');
}

/** posix path normalisation: absolute, `.`/`..` resolved, no trailing slash (except root). */
export function normPath(p) {
    const out = [];
    for (const seg of String(p).split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') out.pop();
        else out.push(seg);
    }
    return '/' + out.join('/');
}

/** Python's `type(v).__name__` for a decoded JSON value (error messages only). */
function pyType(v) {
    if (v === null || v === undefined) return 'NoneType';
    if (Array.isArray(v)) return 'list';
    if (typeof v === 'string') return 'str';
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
    return 'dict';
}
/** Python `str(v)` of a decoded JSON scalar (what the real worker puts in "No such job: ..."). */
function pyStr(v) {
    if (v === null || v === undefined) return 'None';
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    return String(v);
}
/** Python `repr(v)` of a decoded JSON scalar (envelope errors). */
function pyRepr(v) {
    if (typeof v === 'string') return `'${v}'`;
    return pyStr(v);
}
const internal = (msg) => new ProtocolError(ERR.INTERNAL, msg);

const underPath = (path, root) => path === root || root === '/' || path.startsWith(root + '/');
const textField = (v, limit) => (typeof v === 'string' ? v.trim().slice(0, limit) || null : null);

// ---------------------------------------------------------------- connection

/**
 * One client connection's state (server.Connection) plus the frame loop. Frames are
 * processed strictly in arrival order (like the real recv loop), so a `jobs.subscribe`
 * backlog is always on the wire before its `res`.
 */
export class WorkerConnection {
    constructor(worker, transport) {
        this.worker = worker;
        this.transport = transport;
        this.subscribed = new Set();
        this.ownNonce = null; // the nonce WE sent
        this.clientNonce = null; // the nonce the client sent in its hello
        this.peerNodeId = null;
        this.peerAgent = null;
        this.authenticated = false;
        this.closeAfterReply = false;
        this.helloDone = false;
        this.closed = false;
        /** Every frame received from the client, in order (parsed). */
        this.received = [];
        this._queue = Promise.resolve();
    }

    /** Feed one raw text frame from the client. Resolves when it has been fully handled. */
    receive(raw) {
        const run = this._queue.then(() => this._handle(raw));
        this._queue = run.catch(() => {});
        return run;
    }

    /** Resolves once every frame fed so far has been handled (and its reply sent). */
    idle() {
        return this._queue;
    }

    sendFrame(obj) {
        if (this.closed) return;
        this.transport.send(JSON.stringify(obj));
    }

    sendEvent(topic, jobId, seq, data) {
        const frame = { v: PROTOCOL_VERSION, type: 'event', topic, seq, data };
        if (jobId != null) frame.job_id = jobId;
        this.sendFrame(frame);
    }

    close(code = 1000, reason = '') {
        if (this.closed) return;
        this.closed = true;
        try {
            this.transport.close(code, reason);
        } catch {
            /* transport already gone */
        }
        this.handleClose();
    }

    /** The transport went away (or we closed it): run disconnect hooks once. */
    handleClose() {
        this.closed = true;
        if (this._disconnected) return;
        this._disconnected = true;
        this.subscribed.clear();
        if (this.authenticated && this.peerNodeId != null) this.worker._recordSeen(this.peerNodeId);
        this.worker.connections.delete(this);
    }

    async _handle(raw) {
        if (this.closed) return;
        // envelope.parse_envelope: a bad frame is EnvelopeError. Before hello that closes the
        // socket (1002, the error text as reason); after it, the frame is dropped silently.
        let frame;
        let envelopeError = null;
        try {
            frame = JSON.parse(raw);
        } catch {
            envelopeError = 'Invalid JSON: Expecting value: line 1 column 1 (char 0)';
        }
        if (envelopeError === null) {
            if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
                envelopeError = 'Envelope frame must be a JSON object';
            } else if (!REQUIRED_FIELDS[frame.type]) {
                envelopeError = `Unknown or missing envelope type: ${pyRepr(frame.type)}`;
            } else {
                const missing = REQUIRED_FIELDS[frame.type].find((k) => !(k in frame));
                if (missing) envelopeError = `Missing required field '${missing}' for type '${frame.type}'`;
            }
        }
        if (envelopeError !== null) {
            if (!this.helloDone) return this.close(1002, envelopeError);
            return; // real server logs "Dropping unparsable frame"
        }
        this.received.push(frame);

        if (!this.helloDone) {
            if (frame.type !== 'hello') return this.close(1002, 'expected hello as the first frame');
            return this._doHello(frame);
        }
        if (frame.type !== 'req') return; // real server ignores unexpected frame types
        const res = await this._dispatch(frame);
        this.sendFrame(res);
        if (this.closeAfterReply) this._closeUnpaired();
    }

    async _doHello(frame) {
        const { proto } = frame;
        const min = proto?.min;
        const max = proto?.max;
        const w = this.worker;
        if (min == null || max == null || max < w.protoMin || min > w.protoMax) {
            return this.close(1002, ERR.PROTO_MISMATCH);
        }
        this.peerNodeId = frame.node_id;
        this.peerAgent = frame.agent;
        this.clientNonce = frame.nonce;
        this.ownNonce = w.fixedNonce ?? randomToken(16);

        let proof = w.proofOverride;
        if (proof === undefined) proof = await w.sign(frame.nonce);
        const hello = {
            v: PROTOCOL_VERSION,
            type: 'hello',
            proto: { min: w.protoMin, max: w.protoMax },
            agent: { name: AGENT_NAME, version: w.agentVersion, platform: w.agentPlatform },
            node_id: w.nodeId,
            nonce: this.ownNonce,
        };
        if (w.blobPort != null) hello.blob_port = w.blobPort;
        if (proof != null) hello.proof = proof;
        Object.assign(hello, w.helloExtra);
        this.helloDone = true;
        this.sendFrame(hello);
    }

    _isAllowed() {
        return this.peerNodeId === this.worker.nodeId || this.worker.paired.has(this.peerNodeId);
    }

    _closeUnpaired() {
        this.authenticated = false;
        this.subscribed.clear();
        this.close(4001, ERR.AUTH_UNTRUSTED);
    }

    async _dispatch(req) {
        const id = req.id;
        const err = (code, msg, data) => {
            const error = { code, msg };
            if (data != null) error.data = data;
            return { v: PROTOCOL_VERSION, type: 'res', id, error };
        };
        const w = this.worker;
        const method = req.method;
        // Req.from_dict: `params` defaults to {} only when the key is absent (an explicit null stays None).
        const params = 'params' in req ? req.params : {};
        w.calls.push({ method, params, connection: this });

        if (w.enforceAuth && !UNAUTHENTICATED_METHODS.has(method) && !this.authenticated) {
            return err(ERR.AUTH_REQUIRED, 'Connection is not authenticated');
        }
        if (w.enforceAuth && this.authenticated && !this._isAllowed()) {
            this.authenticated = false;
            this.closeAfterReply = true;
            return err(ERR.AUTH_UNTRUSTED, 'This device is no longer paired with this worker');
        }
        const handler = typeof method === 'string' ? w.handlers.get(method) : undefined;
        if (!handler) return err(ERR.PROTO_UNKNOWN_METHOD, `Unknown method: ${method}`);
        try {
            const result = await handler(params, { worker: w, conn: this, method, id });
            return { v: PROTOCOL_VERSION, type: 'res', id, result: result ?? {} };
        } catch (e) {
            if (e instanceof ProtocolError) return err(e.code, e.message, e.data);
            return err(ERR.INTERNAL, String(e?.message ?? e));
        }
    }
}

// ---------------------------------------------------------------- in-memory socket

/** WebSocketLike (`send/close/readyState/onopen/onmessage/onclose/onerror`) wired to a FakeWorker. */
export class FakeWorkerConnectionSocket {
    constructor(worker, { autoOpen = true } = {}) {
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        this.readyState = 0;
        /** Every frame the client sent (parsed), for assertions. */
        this.sent = [];
        this.connection = worker.connect({
            send: (data) => queueMicrotask(() => {
                if (this.readyState === 1) this.onmessage?.({ data });
            }),
            // Queued behind any frame already sent (a real socket delivers the reply, then the close).
            close: (code, reason) => queueMicrotask(() => {
                if (this.readyState === 3) return;
                this.readyState = 3;
                this.onclose?.({ code, reason, wasClean: true });
            }),
        });
        if (autoOpen) queueMicrotask(() => this.simulateOpen());
    }

    simulateOpen() {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.(undefined);
    }

    send(data) {
        try {
            this.sent.push(JSON.parse(data));
        } catch {
            this.sent.push(data);
        }
        void this.connection.receive(data);
    }

    close(code = 1000, reason = '') {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.connection.handleClose();
        queueMicrotask(() => this.onclose?.({ code, reason, wasClean: true }));
    }
}

// ---------------------------------------------------------------- the worker

/**
 * @typedef {object} FakeWorkerOptions
 * @property {{publicKey:CryptoKey, privateKey:CryptoKey}} [keyPair]  default: freshly generated Ed25519.
 * @property {Record<string, Uint8Array|string>} [files]  path -> bytes (paths normalised).
 * @property {{path:string,label:string}[]} [mounts]  shared folders; default [{path:'/data',label:'Data'}].
 * @property {string|null} [serveFolder]
 * @property {Record<string,(params:object, ctx:object)=>any>} [requests]  handler overrides by method name
 *   (a `null` value removes a default, giving `proto.unknown_method`). Handler returns the `result`
 *   object or throws `ProtocolError`; `ctx = {worker, conn, method, id}`.
 * @property {number} [protoMin] @property {number} [protoMax]
 * @property {string} [nonce]  fixed worker nonce for every connection (default: random per connection).
 * @property {string|null} [proofOverride]  undefined = real proof; null = omit; string = literal.
 * @property {number} [blobPort]  announced as hello.blob_port (a started blob server overrides it).
 * @property {object} [helloExtra]  extra fields merged into the hello.
 * @property {boolean} [enforceAuth=true]  gate everything but pair.claim/auth.prove (server.py).
 * @property {string[]} [pairedNodeIds]  pre-paired client node ids.
 * @property {boolean} [fs=true]  register fs.* (the real worker only does with a FileManager).
 * @property {boolean} [enforceSharedFolders=true]  jobs.submit path policy for track jobs.
 * @property {boolean} [autoRun=false]  a submitted job goes `running` immediately.
 * @property {'immediate'|'manual'} [cancelRunning='immediate']
 * @property {object} [workerInfo]  fields merged into the worker.info result.
 * @property {string} [agentVersion] @property {string} [agentPlatform]
 * @property {number} [mtime=1700000000]  mtime reported for every file/dir.
 * @property {string} [cwd]  what a relative `fs.*` path resolves against (the real worker's working
 *   directory); default `serveFolder`, else `/`.
 * @property {string} [dataDir]  the worker's own data dir: never shared, even inside a mount (`fs.*` refuse it).
 * @property {(path:string, frameIdx:number, maxSide:number)=>object} [mediaFrame]  answers `media.frame` (no decoding here).
 * @property {boolean} [checkInputs=false]  like the real worker, a submitted job whose data/model/labels/config
 *   path does not exist on the worker fails at once (`job.status running`, then `failed` + `missing`).
 */

export class FakeWorker {
    /** @param {FakeWorkerOptions} [opts] */
    static async create(opts = {}) {
        const keyPair = opts.keyPair ?? (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']));
        const nodeId = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)));
        return new FakeWorker(keyPair, nodeId, opts);
    }

    constructor(keyPair, nodeId, opts = {}) {
        this.keyPair = keyPair;
        /** The worker's identity: URL-safe base64 of the raw 32-byte Ed25519 public key. */
        this.nodeId = nodeId;
        this.protoMin = opts.protoMin ?? 1;
        this.protoMax = opts.protoMax ?? 1;
        this.fixedNonce = opts.nonce;
        this.proofOverride = opts.proofOverride;
        this.blobPort = opts.blobPort;
        this.helloExtra = opts.helloExtra ?? {};
        this.enforceAuth = opts.enforceAuth ?? true;
        this.enforceSharedFolders = opts.enforceSharedFolders ?? true;
        this.autoRun = opts.autoRun ?? false;
        this.cancelRunning = opts.cancelRunning ?? 'immediate';
        this.agentVersion = opts.agentVersion ?? '0.0.0';
        this.agentPlatform = opts.agentPlatform ?? 'test';
        this.mtime = opts.mtime ?? 1700000000;
        this.workerInfo = opts.workerInfo ?? {};
        this.mounts = opts.mounts ?? [{ path: '/data', label: 'Data' }];
        this.serveFolder = opts.serveFolder ?? null;
        this.cwd = opts.cwd ?? opts.serveFolder ?? '/';
        this.dataDir = opts.dataDir ? normPath(opts.dataDir) : null;
        this.checkInputs = opts.checkInputs ?? false;
        this.mediaFrame = opts.mediaFrame ?? null;

        /** path -> Uint8Array */
        this.files = new Map();
        this.dirs = new Set();
        for (const [p, v] of Object.entries(opts.files ?? {})) this.addFile(p, v);

        /** node_id -> {node_id,name,platform,app_version,paired_at,last_seen_at} */
        this.paired = new Map();
        for (const id of opts.pairedNodeIds ?? []) this._addTrusted(id, null);
        /** one-time secret -> expires_at (unix secs) */
        this.pendingSecrets = new Map();
        /** job_id -> job record */
        this.jobs = new Map();
        /** sha256 hex -> Uint8Array */
        this.blobs = new Map();
        /** live connections */
        this.connections = new Set();
        /** every request received, in order: {method, params, connection} */
        this.calls = [];

        this.handlers = new Map();
        this._installDefaultHandlers(opts.fs ?? true);
        for (const [m, h] of Object.entries(opts.requests ?? {})) this.setHandler(m, h);

        this._blobServer = null;
        this.blobRequests = [];
    }

    // ---- identity / signing

    /** Sign a nonce (utf-8) with the worker's key: `hello.proof`. */
    async sign(nonce) {
        const sig = await crypto.subtle.sign('Ed25519', this.keyPair.privateKey, enc.encode(nonce));
        return b64urlEncode(new Uint8Array(sig));
    }

    // ---- attaching

    /** Attach to any `{send(str), close(code, reason)}`; feed it frames with `conn.receive(str)`. */
    connect(transport) {
        const conn = new WorkerConnection(this, transport);
        this.connections.add(conn);
        return conn;
    }

    /** An in-memory WebSocketLike connected to this worker. */
    createSocket(opts) {
        return new FakeWorkerConnectionSocket(this, opts);
    }

    /** Attach a Playwright `WebSocketRoute` (the page's WebSocket then talks to this worker). */
    attachRoute(ws) {
        const conn = this.connect({
            send: (data) => ws.send(data),
            close: (code, reason) => {
                try {
                    ws.close({ code, reason });
                } catch {
                    ws.close();
                }
            },
        });
        ws.onMessage((msg) => {
            const raw = typeof msg === 'string' ? msg : dec.decode(msg);
            void conn.receive(raw);
        });
        ws.onClose?.(() => conn.handleClose());
        return conn;
    }

    /** `page.routeWebSocket(urlPattern, ws => worker.attachRoute(ws))`. */
    async serveOnPage(page, urlPattern) {
        await page.routeWebSocket(urlPattern, (ws) => this.attachRoute(ws));
    }

    /** Close every live connection (worker going away). */
    closeAll(code = 1001, reason = 'going away') {
        for (const c of [...this.connections]) c.close(code, reason);
    }

    // ---- handlers

    /** Replace/add a request handler (`null` removes it). */
    setHandler(method, handler) {
        if (handler == null) this.handlers.delete(method);
        else this.handlers.set(method, handler);
        return this;
    }

    // ---- pairing

    /**
     * Mint a one-time pairing ticket (`PendingPairings.create`) and register its secret.
     * `ticket.node_id`/`secret` are URL-safe base64 of 32/16 raw bytes. `relay_url` rides
     * in the pairing CODE only; `iroh` is added to the ticket like the real JSON ticket.
     */
    mintTicket({ addrs = [], relayUrl = null, ttlSecs = 300, expiresAt, secret } = {}) {
        const s = secret ?? randomToken(16);
        const exp = expiresAt ?? Math.floor(nowSecs() + ttlSecs);
        this.pendingSecrets.set(s, exp);
        const ticket = { node_id: this.nodeId, addrs, secret: s, expires_at: exp, relay_url: relayUrl };
        if (relayUrl) ticket.iroh = { node_id: this.nodeId, relay_url: relayUrl, direct_addrs: [] };
        return ticket;
    }

    /** Mint a ticket and encode it as a `sleap1...` code (`sleap-connect pair`). */
    async mintPairCode(opts = {}) {
        const ticket = this.mintTicket(opts);
        return encodePairCode(ticket);
    }

    /** Remove a paired device (as `sleap-connect clients remove`); its connections get refused on next request. */
    unpair(nodeId) {
        return this.paired.delete(nodeId);
    }

    _addTrusted(nodeId, agent) {
        const now = nowSecs();
        if (!this.paired.has(nodeId)) {
            this.paired.set(nodeId, {
                node_id: nodeId,
                name: null,
                platform: null,
                app_version: null,
                paired_at: now,
                last_seen_at: now,
            });
        }
        this._recordSeen(nodeId, agent);
    }

    _recordSeen(nodeId, agent) {
        const d = this.paired.get(nodeId);
        if (!d) return;
        d.last_seen_at = nowSecs();
        const name = textField(agent?.device_name, MAX_NAME_LEN);
        const platform = textField(agent?.platform, 32);
        const version = textField(agent?.version, 64);
        if (name != null) d.name = name;
        if (platform != null) d.platform = platform;
        if (version != null) d.app_version = version;
    }

    // ---- files

    addFile(path, content) {
        this.files.set(normPath(path), toBytes(content));
        return this;
    }

    addDir(path) {
        this.dirs.add(normPath(path));
        return this;
    }

    _allowed(p) {
        if (this.dataDir && underPath(p, this.dataDir)) return false;
        return this.mounts.some((m) => underPath(p, normPath(m.path)));
    }

    /** `Path(path).resolve()`: relative paths are against the worker's cwd; a non-string is `internal`. */
    _resolvePath(path) {
        if (typeof path !== 'string') {
            throw internal(`expected str, bytes or os.PathLike object, not ${pyType(path)}`);
        }
        return normPath(path.startsWith('/') ? path : `${this.cwd}/${path}`);
    }

    _exists(p) {
        return this.files.has(p) || this._isDir(p);
    }

    _isDir(p) {
        if (this.dirs.has(p) || this.mounts.some((m) => normPath(m.path) === p)) return true;
        const prefix = p === '/' ? '/' : p + '/';
        for (const f of this.files.keys()) if (f.startsWith(prefix)) return true;
        for (const d of this.dirs) if (d.startsWith(prefix)) return true;
        return false;
    }

    // ---- jobs

    /** Create a job record directly (seed a worker with history). Does not emit. */
    addJob({ spec = { type: 'track', data_path: '/data/a.slp', model_paths: ['/data/model'] }, state = 'queued', jobId, submittedBy = null, project, error = null, result = null } = {}) {
        const id = jobId ?? 'job_' + randomToken(9);
        const t = Math.max(nowSecs(), (this._lastCreated ?? 0) + 1e-6); // strictly increasing: stable newest-first order
        this._lastCreated = t;
        const job = {
            job_id: id,
            spec: project !== undefined ? { ...spec, project } : spec,
            state,
            created_at: t,
            updated_at: t,
            started_at: state === 'queued' ? null : t,
            submitted_by: submittedBy,
            error,
            result,
            events: [],
            seq: 0,
            cancelRequested: null,
        };
        this.jobs.set(id, job);
        return job;
    }

    _job(jobId) {
        const j = this.jobs.get(jobId);
        if (!j) throw new ProtocolError(ERR.JOB_NOT_FOUND, `No such job: ${pyStr(jobId)}`);
        return j;
    }

    /** Append an event to a job's log and push it to subscribed connections. Returns its `seq`. */
    pushEvent(jobId, topic, data = {}) {
        const job = this._job(jobId);
        const seq = ++job.seq;
        job.events.push({ topic, seq, data });
        job.updated_at = nowSecs();
        for (const conn of this.connections) {
            if (!conn.subscribed.has(jobId) || conn.closed) continue;
            if (this.enforceAuth && !(conn.authenticated && conn._isAllowed())) {
                conn.subscribed.delete(jobId);
                if (conn.authenticated) conn._closeUnpaired();
                continue;
            }
            conn.sendEvent(topic, jobId, seq, data);
        }
        return seq;
    }

    /** Update the stored state and emit `job.status` `{state, detail?, missing?}`. */
    setJobState(jobId, state, { detail, missing, result } = {}) {
        const job = this._job(jobId);
        job.state = state;
        if (state === 'running' && job.started_at == null) job.started_at = nowSecs();
        if (detail !== undefined && (state === 'failed' || state === 'canceled')) job.error = detail;
        if (result !== undefined) job.result = result;
        const data = { state };
        if (detail !== undefined) data.detail = detail;
        if (missing !== undefined) data.missing = missing;
        return this.pushEvent(jobId, 'job.status', data);
    }

    /** `job.log`; `progress: true` marks a redrawn progress line (clients replace the previous one). */
    log(jobId, line, { progress = false } = {}) {
        return this.pushEvent(jobId, 'job.log', progress ? { line, progress: true } : { line });
    }

    /** `job.epoch` `{epoch, train_loss, val_loss}` (metrics.epoch_event; null for non-finite). */
    epoch(jobId, epoch, trainLoss = null, valLoss = null) {
        return this.pushEvent(jobId, 'job.epoch', { epoch, train_loss: trainLoss, val_loss: valLoss });
    }

    /** `job.metric` (metrics.py) with sensible nulls. */
    metric(jobId, fields = {}) {
        return this.pushEvent(jobId, 'job.metric', {
            epoch: null,
            total_epochs: null,
            latest_train_loss: null,
            latest_val_loss: null,
            best_loss: null,
            wandb_url: null,
            eta_seconds: null,
            ...fields,
        });
    }

    /** `job.curve` `{points:[{x,y}]}`. */
    curve(jobId, points) {
        return this.pushEvent(jobId, 'job.curve', { points: points.map(([x, y]) => ({ x, y })) });
    }

    /**
     * `job.result` `{blobs:{predictions:{sha256,size}}, ...}`. Pass `predictions` as bytes (registered
     * as a blob, hashed here) or as an existing `{sha256,size}`; `extra` is merged into the result.
     */
    async emitResult(jobId, { predictions, extra = {} } = {}) {
        const result = { blobs: {}, ...extra };
        if (predictions !== undefined) {
            result.blobs.predictions = predictions instanceof Uint8Array || typeof predictions === 'string'
                ? await this.registerBlob(predictions)
                : predictions;
        }
        this._job(jobId).result = result;
        this.pushEvent(jobId, 'job.result', result);
        return result;
    }

    /** Real `_finish` order for a clean exit: store `completed`, `job.result` THEN `job.status: completed`. */
    async completeJob(jobId, opts = {}) {
        const result = await this.emitResult(jobId, opts);
        this.setJobState(jobId, 'completed', { result });
        return result;
    }

    failJob(jobId, detail = 'exit code 1', extra) {
        return this.setJobState(jobId, 'failed', { detail, ...extra });
    }

    // ---- blobs

    /** Register blob bytes under their sha256; returns `{sha256, size}` (the `job.result` blob ref). */
    async registerBlob(bytes) {
        const b = toBytes(bytes);
        const sha256 = await sha256Hex(b);
        this.blobs.set(sha256, b);
        return { sha256, size: b.length };
    }

    /**
     * Start the side-channel blob HTTP server (blob_http.py): `GET /blobs/<64-hex>` with `Range`.
     * Sends NO CORS headers and answers non-GET (e.g. an `OPTIONS` preflight) with 501, exactly
     * like the real `BaseHTTPRequestHandler`. Sets `hello.blob_port` for later connections.
     * @returns {Promise<{port:number, url:string, close():Promise<void>}>}
     */
    async startBlobServer({ host = '127.0.0.1', port = 0 } = {}) {
        if (this._blobServer) return this._blobServer.handle;
        const server = http.createServer((req, res) => this._serveBlob(req, res));
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, resolve);
        });
        const actual = server.address().port;
        this.blobPort = actual;
        const handle = {
            port: actual,
            url: `http://${host}:${actual}`,
            close: () => this.stopBlobServer(),
        };
        this._blobServer = { server, handle };
        return handle;
    }

    async stopBlobServer() {
        const s = this._blobServer;
        if (!s) return;
        this._blobServer = null;
        s.server.closeAllConnections?.();
        await new Promise((resolve) => s.server.close(resolve));
    }

    _serveBlob(req, res) {
        this.blobRequests.push({ method: req.method, url: req.url, range: req.headers.range ?? null });
        const sendErr = (status, msg) => {
            const body = `<html><body><h1>Error ${status}</h1><p>${msg}</p></body></html>`;
            res.writeHead(status, {
                'Content-Type': 'text/html;charset=utf-8',
                'Connection': 'close',
                'Content-Length': Buffer.byteLength(body),
            });
            res.end(req.method === 'HEAD' ? undefined : body);
        };
        // BaseHTTPRequestHandler has only do_GET: any other verb (incl. OPTIONS) is 501.
        if (req.method !== 'GET') return sendErr(501, `Unsupported method ('${req.method}')`);
        const m = /^\/blobs\/([0-9a-f]{64})$/.exec(req.url ?? '');
        if (!m) return sendErr(404, 'no such route');
        const blob = this.blobs.get(m[1]);
        if (!blob) return sendErr(404, 'unknown blob');

        const size = blob.length;
        let start = 0;
        let end = size - 1;
        let status = 200;
        const rangeHeader = req.headers.range;
        if (rangeHeader !== undefined) {
            const rm = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
            if (!rm) return sendErr(416, 'malformed Range header');
            const [, s, e] = rm;
            if (s) {
                start = Number(s);
                end = e ? Number(e) : size - 1;
            } else if (e) {
                start = Math.max(0, size - Number(e));
                end = size - 1;
            } else {
                return sendErr(416, 'malformed Range header');
            }
            status = 206;
        }
        if (size === 0) {
            start = 0;
            end = -1;
            status = 200;
        } else if (start > end || start >= size || end >= size) {
            return sendErr(416, `valid range is bytes 0-${size - 1}`);
        }
        const length = Math.max(0, end - start + 1);
        const headers = {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(length),
            'Accept-Ranges': 'bytes',
        };
        if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        res.writeHead(status, headers);
        res.end(length ? Buffer.from(blob.subarray(start, end + 1)) : undefined);
    }

    // ---- default request table

    _installDefaultHandlers(withFs) {
        const w = this;
        const set = (m, h) => this.handlers.set(m, h);

        // auth.py -----------------------------------------------------------
        set('pair.claim', (params, { conn }) => {
            const secret = need(params, 'secret');
            const nodeId = need(params, 'node_id');
            const exp = w.pendingSecrets.get(secret);
            w.pendingSecrets.delete(secret); // single use, even when expired
            if (exp === undefined || nowSecs() > exp) {
                throw new ProtocolError(ERR.AUTH_PAIRING_EXPIRED, 'Pairing secret is invalid or already used');
            }
            w._addTrusted(nodeId, conn.peerAgent);
            conn.peerNodeId = nodeId;
            conn.authenticated = true;
            return {};
        });

        set('auth.prove', async (params, { conn }) => {
            if (conn.peerNodeId == null || conn.ownNonce == null) {
                throw new ProtocolError(ERR.AUTH_REQUIRED, 'auth.prove requires a completed hello handshake first');
            }
            const sig = need(params, 'sig');
            if (typeof sig !== 'string') throw internal(`object of type '${pyType(sig)}' has no len()`);
            const ok = await verifyEd25519(conn.peerNodeId, conn.ownNonce, sig);
            if (!ok) throw new ProtocolError(ERR.AUTH_BAD_SIGNATURE, "Signature does not match this connection's nonce");
            if (conn.peerNodeId !== w.nodeId && !w.paired.has(conn.peerNodeId)) {
                throw new ProtocolError(ERR.AUTH_UNTRUSTED, `Node '${conn.peerNodeId}' is not paired with this worker`);
            }
            conn.authenticated = true;
            w._recordSeen(conn.peerNodeId, conn.peerAgent);
            return {};
        });

        set('clients.list', (params, { conn }) => ({
            clients: [...w.paired.values()]
                .sort((a, b) => (b.last_seen_at ?? -1) - (a.last_seen_at ?? -1))
                .map((d) => ({ ...d, you: d.node_id === conn.peerNodeId })),
        }));

        set('clients.rename', (params, { conn }) => {
            const name = params.name;
            if (typeof name !== 'string' || !name.trim()) {
                throw new ProtocolError(ERR.CLIENTS_BAD_NAME, 'name must be a non-empty string');
            }
            w._recordSeen(conn.peerNodeId, { device_name: name });
            return {};
        });

        set('clients.leave', (params, { conn }) => {
            const removed = w.paired.delete(conn.peerNodeId);
            conn.authenticated = false;
            conn.closeAfterReply = true;
            return { removed };
        });

        // worker_info.py ------------------------------------------------------
        set('worker.info', () => ({
            gpu_model: 'NVIDIA Fake GPU',
            gpu_memory_mb: 24576,
            gpu_count: 1,
            cuda_version: '12.4',
            sleap_nn_version: '0.0.0-fake',
            busy: [...w.jobs.values()].some((j) => j.state === 'running'),
            features: [...FEATURES],
            ...w.workerInfo,
        }));

        // media.py: one frame as a small JPEG. Not scoped to the shared folders (the real one reads any
        // path). Decoding is not implemented: pass `mediaFrame(path, frameIdx, maxSide)` -> result to
        // answer one; otherwise a path that exists is `media.unreadable`.
        set('media.frame', async (params) => {
            const intParam = (name, dflt) => {
                const v = params?.[name] === undefined ? dflt : params[name];
                if (typeof v !== 'number' || !Number.isInteger(v)) throw new ProtocolError(ERR.MEDIA_UNREADABLE, `'${name}' must be an integer`);
                return v;
            };
            const path = params?.path;
            if (typeof path !== 'string' || !path) throw new ProtocolError(ERR.MEDIA_UNREADABLE, "media.frame needs a 'path'");
            const frameIdx = intParam('frame_idx', 0);
            const maxSide = Math.min(intParam('max_side', 2048), 4096);
            if (frameIdx < 0 || maxSide < 1) {
                throw new ProtocolError(ERR.MEDIA_UNREADABLE, 'frame_idx must be >= 0 and max_side >= 1');
            }
            if (!w.files.has(w._resolvePath(path))) throw new ProtocolError(ERR.FS_NOT_FOUND, `No such file: ${path}`);
            if (w.mediaFrame) return await w.mediaFrame(path, frameIdx, maxSide);
            throw new ProtocolError(ERR.MEDIA_UNREADABLE, `Couldn't decode frame ${frameIdx} of ${path}`);
        });

        // job_methods.py: jobs.* ---------------------------------------------
        set('jobs.submit', (params, { conn }) => {
            const spec = parseJobSpec(params);
            if (w.enforceSharedFolders) w._checkJobPaths(spec);
            const job = w.addJob({ spec, submittedBy: conn.peerNodeId });
            if (w.checkInputs) {
                const missing = w._missingInputs(spec);
                if (missing.length) {
                    // _run_job: `running` is announced, then the job fails before spawning (started_at stays null).
                    w.pushEvent(job.job_id, 'job.status', { state: 'running' });
                    job.state = 'failed';
                    job.error = `not found on worker: ${missing[0]}`;
                    w.pushEvent(job.job_id, 'job.status', { state: 'failed', detail: job.error, missing });
                    return { job_id: job.job_id };
                }
            }
            if (w.autoRun) w.setJobState(job.job_id, 'running');
            return { job_id: job.job_id };
        });

        set('jobs.status', (params) => {
            const job = w._job(need(params, 'job_id'));
            return { ...jobBase(job), result: job.result, ...specSummary(job.spec, true), queue_position: w._queuePosition(job) };
        });

        set('jobs.list', () => ({
            jobs: [...w.jobs.values()]
                .sort((a, b) => b.created_at - a.created_at || 0)
                .map((job) => {
                    const { spec: _spec, ...summary } = specSummary(job.spec, true);
                    const b = jobBase(job);
                    return {
                        job_id: b.job_id,
                        state: b.state,
                        created_at: b.created_at,
                        updated_at: b.updated_at,
                        started_at: b.started_at,
                        submitted_by: job.submitted_by,
                        error: b.error,
                        queue_position: w._queuePosition(job),
                        model_name: modelName(job.result),
                        ...summary,
                    };
                }),
        }));

        set('jobs.subscribe', (params, { conn }) => {
            const job = w._job(need(params, 'job_id'));
            const since = params.since_seq ?? 0;
            conn.subscribed.add(job.job_id);
            // Backlog (seq > since_seq, ascending) goes out BEFORE the res.
            for (const ev of job.events) if (ev.seq > since) conn.sendEvent(ev.topic, job.job_id, ev.seq, ev.data);
            return {};
        });

        set('jobs.cancel', (params) => {
            const job = w._job(need(params, 'job_id'));
            const mode = params.mode ?? 'cancel';
            if (TERMINAL_STATES.includes(job.state)) return {};
            if (job.state === 'queued') {
                w.setJobState(job.job_id, 'canceled', { detail: 'canceled before it started' });
            } else {
                job.cancelRequested = mode;
                if (w.cancelRunning === 'immediate') {
                    w.setJobState(job.job_id, 'canceled', {
                        detail: mode === 'stop' ? 'stopped early by request' : 'canceled by request',
                    });
                }
            }
            return {};
        });

        set('jobs.delete', (params) => {
            let ids = need(params, 'job_ids');
            if (typeof ids === 'string') ids = [...ids]; // Python iterates a str by character
            else if (!Array.isArray(ids)) throw internal(`'${pyType(ids)}' object is not iterable`);
            const records = ids.map((id) => w._job(id));
            for (const r of records) {
                if (r.state === 'queued' || r.state === 'running') {
                    throw new ProtocolError(ERR.JOB_ACTIVE, `Job ${r.job_id} is active and can't be deleted`);
                }
            }
            for (const id of ids) {
                w.jobs.delete(id);
                for (const c of w.connections) c.subscribed.delete(id);
            }
            return { deleted: ids };
        });

        // job_methods.py: fs.* (file_manager.py payloads) ----------------------
        if (!withFs) return;
        set('fs.mounts', () => ({
            mounts: w.mounts.map((m) => ({ path: m.path, label: m.label })),
            serve_folder: w.serveFolder,
        }));

        // NOTE: fs.list/stat/read report failures INSIDE `result` as {error, error_code}
        // (PATH_NOT_FOUND | ACCESS_DENIED | INVALID_RANGE), not as `res.error`; the `path` of an
        // error is the one asked for, of a success the resolved one. A missing/ill-typed param is
        // `internal` (Python KeyError/TypeError), like everywhere else.
        set('fs.list', (params) => {
            const path = need(params, 'path');
            const offset = 'offset' in params ? params.offset : 0;
            const p = w._resolvePath(path);
            const empty = (error, code) => ({ path, entries: [], total_count: 0, has_more: false, error, error_code: code });
            if (!w._allowed(p)) return empty('Access denied: path is outside configured mounts', 'ACCESS_DENIED');
            if (!w._exists(p)) return empty('Path does not exist', 'PATH_NOT_FOUND');
            if (w.files.has(p)) return empty('Path is not a directory', 'PATH_NOT_FOUND');
            const children = new Map(); // name -> 'directory' | 'file'
            const prefix = p === '/' ? '/' : p + '/';
            for (const f of w.files.keys()) {
                if (!f.startsWith(prefix)) continue;
                const rest = f.slice(prefix.length);
                const slash = rest.indexOf('/');
                if (slash === -1) children.set(rest, 'file');
                else children.set(rest.slice(0, slash), 'directory');
            }
            for (const d of w.dirs) {
                if (!d.startsWith(prefix) || d === p) continue;
                children.set(d.slice(prefix.length).split('/')[0], 'directory');
            }
            const all = [...children.entries()].sort(
                ([an, at], [bn, bt]) => (at === 'directory' ? 0 : 1) - (bt === 'directory' ? 0 : 1) || an.toLowerCase().localeCompare(bn.toLowerCase()),
            );
            if (!Number.isInteger(offset)) {
                throw internal('slice indices must be integers or None or have an __index__ method');
            }
            const page = all.slice(offset, offset + MAX_LIST_RESULTS).map(([name, type]) => ({
                name,
                type,
                size: type === 'file' ? w.files.get(prefix + name).length : 0,
                modified: w.mtime,
            }));
            return {
                path: p,
                entries: page,
                total_count: all.length,
                has_more: offset + page.length < all.length,
            };
        });

        // SharedFolderFileManager.stat_path: full metadata inside a share; OUTSIDE one, existence
        // only (`{path, type, shared: false}`, or not found) so a client can check a video an .slp
        // points at. The worker's data dir is refused outright.
        set('fs.stat', (params) => {
            const path = need(params, 'path');
            const p = w._resolvePath(path);
            const denied = () => ({ path, error: 'Access denied: path is outside configured mounts', error_code: 'ACCESS_DENIED' });
            const notFound = () => ({ path, error: 'Path does not exist', error_code: 'PATH_NOT_FOUND' });
            if (!w._allowed(p)) {
                if (w.dataDir && underPath(p, w.dataDir)) return denied();
                if (!w._exists(p)) return notFound();
                return { path: p, type: w.files.has(p) ? 'file' : 'directory', shared: false };
            }
            if (w.files.has(p)) return { path: p, type: 'file', size: w.files.get(p).length, modified: w.mtime };
            if (w._isDir(p)) return { path: p, type: 'directory', size: 0, modified: w.mtime };
            return notFound();
        });

        set('fs.read', (params) => {
            const path = need(params, 'path');
            const offset = 'offset' in params ? params.offset : 0;
            const length = params.length ?? null;
            const p = w._resolvePath(path);
            if (!w._allowed(p)) {
                return { path, error: 'Access denied: path is outside configured mounts', error_code: 'ACCESS_DENIED' };
            }
            if (!w._exists(p)) return { path, error: 'Path does not exist', error_code: 'PATH_NOT_FOUND' };
            if (!w.files.has(p)) return { path, error: 'Path is not a file', error_code: 'PATH_NOT_FOUND' };
            // The Python arithmetic, in its order: `offset < 0`, min(length, cap), seek(offset), read(n).
            if (typeof offset !== 'number') {
                throw internal(`'<' not supported between instances of '${pyType(offset)}' and 'int'`);
            }
            if (offset < 0) return { path, error: 'offset must be non-negative', error_code: 'INVALID_RANGE' };
            if (length !== null && typeof length !== 'number') {
                throw internal(`'<' not supported between instances of 'int' and '${pyType(length)}'`);
            }
            const readLen = length === null ? MAX_READ_BYTES : Math.min(length, MAX_READ_BYTES);
            if (!Number.isInteger(offset)) throw internal("'float' object cannot be interpreted as an integer");
            if (!Number.isInteger(readLen)) throw internal("argument should be integer or None, not 'float'");
            if (readLen < -1) throw internal('read length must be non-negative or -1');
            const file = w.files.get(p);
            // read(-1) reads to EOF, and is NOT capped at MAX_READ_BYTES.
            const data = readLen === -1 ? file.subarray(offset) : file.subarray(offset, offset + readLen);
            return {
                path: p,
                content_base64: bytesToBase64(data),
                offset,
                size: data.length,
                total_size: file.length,
                eof: offset + data.length >= file.length,
            };
        });
    }

    /** job_methods._missing_inputs: named input paths that do not exist on the worker. */
    _missingInputs(spec) {
        const paths = spec.type === 'train'
            ? [spec.labels_path, spec.val_labels_path, ...(spec.config_paths ?? (spec.config_path ? [spec.config_path] : []))]
            : [spec.data_path, ...(spec.model_paths ?? [])];
        return paths.filter((p) => p && !this._exists(normPath(p)));
    }

    _queuePosition(job) {
        if (job.state !== 'queued') return null;
        const waiting = [...this.jobs.values()].filter((j) => j.state === 'queued').sort((a, b) => a.created_at - b.created_at);
        return waiting.indexOf(job) + 1;
    }

    /** job_paths.JobPathPolicy._check_track (+ train labels_path): paths must be under a mount. */
    _checkJobPaths(spec) {
        const roots = this.mounts.map((m) => normPath(m.path));
        const require = (field, path, write = false) => {
            if (!path) return;
            if (roots.some((r) => underPath(normPath(path), r))) return;
            const folder = /\.[^/]+$/.test(path) ? normPath(path).split('/').slice(0, -1).join('/') || '/' : normPath(path);
            throw new ProtocolError(
                ERR.JOB_PATH_NOT_SHARED,
                `This job would ${write ? 'write to' : 'read'} ${path} (${field}), which is outside the worker's ` +
                    `shared folders (${roots.join(', ') || 'none'}). To allow it, run on the worker: ` +
                    `sleap-connect add-folder "${folder}"`,
                { field, path, shared_folders: roots },
            );
        };
        if (spec.type === 'track') {
            require('data_path', spec.data_path);
            for (const p of spec.model_paths ?? []) require('model_paths', p);
            require('output_path', spec.output_path, true);
            require('output_dir', spec.output_dir, true);
        } else {
            require('labels_path', spec.labels_path);
            require('val_labels_path', spec.val_labels_path);
            for (const p of spec.config_paths ?? []) require('config_path', p);
            if (spec.labels_content) require('output_dir', spec.output_dir, true);
        }
    }
}

// ---------------------------------------------------------------- helpers

function need(params, key) {
    // Python `params["secret"]`: a missing key is KeyError -> `internal` with str(KeyError) = "'secret'";
    // an explicit `"params": null` is a TypeError.
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        throw internal(`'${pyType(params)}' object is not subscriptable`);
    }
    if (!(key in params)) throw internal(`'${key}'`);
    return params[key];
}

/** `parse_job_spec` + the dataclass constructors, as far as a client sees their ValueError/TypeError text. */
function parseJobSpec(params) {
    const bad = (msg) => new ProtocolError(ERR.JOB_SPEC_INVALID, `Invalid job spec: ${msg}`);
    if (params === null || typeof params !== 'object') throw bad(`'${pyType(params)}' object is not subscriptable`);
    if (!('spec' in params)) throw bad("'spec'");
    const spec = params.spec;
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
        throw bad(`'${pyType(spec)}' object has no attribute 'get'`);
    }
    if (spec.type === 'track') {
        if (!('data_path' in spec)) throw bad("TrackJobSpec.__init__() missing 1 required positional argument: 'data_path'");
    } else if (spec.type === 'train') {
        const has = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
        if (!has(spec.config_paths) && !has(spec.config_path) && !has(spec.config_content) && !has(spec.config_contents)) {
            throw bad('Must provide either config_path, config_paths, config_content, or config_contents');
        }
    } else {
        throw bad(`Unknown job type: ${pyStr(spec.type)}`);
    }
    return normalizeSpec(spec);
}

// jobs/spec.py dataclass fields with their defaults (None = no default / None).
const TRACK_FIELDS = {
    data_path: null, model_paths: [], output_path: null, batch_size: null, peak_threshold: null,
    only_suggested_frames: false, exclude_user_labeled: false, frames: null, frame_filter: null,
    video_index: null, path_mappings: {}, tracker: null, similarity: null, match: null,
    track_window: null, robust: null, max_tracks: null, connect_single_breaks: false,
    ensure_channels: null, project: null, output_dir: null, run: null,
};
const TRAIN_FIELDS = {
    config_path: null, config_paths: [], config_content: null, config_contents: [], model_types: [],
    labels_path: null, labels_content: null, val_labels_path: null, max_epochs: null, batch_size: null,
    learning_rate: null, run_name: null, resume_ckpt_path: null, path_mappings: {}, ckpt_dir: null,
    project: null, output_dir: null, cache_img_path: null, run: null, post_inference: null,
};

/**
 * `Spec.from_dict(...).to_dict()`: unknown keys dropped, dataclass defaults filled, then the empty ones
 * removed (track: None/False/[]; train: None/[]/{}), so `jobs.status.spec` reads like the real one.
 */
function normalizeSpec(spec) {
    const isTrack = spec.type === 'track';
    const fields = isTrack ? TRACK_FIELDS : TRAIN_FIELDS;
    const data = {};
    for (const [k, dflt] of Object.entries(fields)) {
        data[k] = k in spec ? spec[k] : structuredClone(dflt);
    }
    if (!isTrack) {
        if (data.config_path && !(data.config_paths?.length)) data.config_paths = [data.config_path];
        if (data.config_content && !(data.config_contents?.length)) data.config_contents = [data.config_content];
    }
    const out = { type: spec.type };
    for (const [k, v] of Object.entries(data)) {
        const empty = v === null || (Array.isArray(v) && v.length === 0)
            || (isTrack ? v === false : (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0));
        if (!empty) out[k] = v;
    }
    return out;
}

function jobBase(job) {
    return {
        job_id: job.job_id,
        state: job.state,
        created_at: job.created_at,
        updated_at: job.updated_at,
        started_at: job.started_at,
        error: job.error,
    };
}

function modelName(result) {
    const dir = result?.model_dir;
    return dir ? String(dir).split('/').filter(Boolean).pop() : null;
}

/** job_methods._spec_summary: what a client needs, minus bulky inline labels. */
function specSummary(spec, withSpec) {
    const data = { ...spec };
    delete data.labels_content;
    const kind = data.type ?? null;
    const summary = {
        kind,
        model_types: data.model_types || [],
        labels_path: kind === 'train' ? data.labels_path ?? null : data.data_path ?? null,
        project: data.project ?? null,
        run: data.run ?? null,
        post_inference: !!data.post_inference,
    };
    if (withSpec) summary.spec = data;
    return summary;
}

async function verifyEd25519(nodeIdB64, nonce, sigB64) {
    try {
        const publicKey = await crypto.subtle.importKey('raw', b64urlDecode(nodeIdB64), 'Ed25519', false, ['verify']);
        return await crypto.subtle.verify('Ed25519', publicKey, b64urlDecode(sigB64), enc.encode(nonce));
    } catch {
        return false;
    }
}

export { encodePairCode, decodePairCode, mistypeCode } from './pair-code.mjs';
