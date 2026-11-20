/**
 * test-connect-fake-worker.mjs: self-test of the Connect test harness
 * (tests/connect/fake-worker.mjs, fake-worker-socket.mjs, pair-code.mjs).
 *
 * Not a test of the client: it checks the fake behaves like the real worker
 * (sleap-connect @ 0610a6b protocol_v1) so later suites can rely on it:
 * hello proof over the client nonce, pair.claim / auth.prove, fs.read paging,
 * jobs.subscribe backlog order, blob HTTP (Range, no CORS), and the
 * vector-checked pairing-code codec.
 *
 * ESM, picked up by tests/run-mjs-tests.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FakeWorker, ProtocolError, ERR, sha256Hex } from './connect/fake-worker.mjs';
import { FakeWorkerSocket } from './connect/fake-worker-socket.mjs';
import { encodePairCode, decodePairCode, mistypeCode, PairCodeError, b64urlEncode, b64urlDecode, isPairCode } from './connect/pair-code.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log('  ok   ' + name);
    } catch (e) {
        failed++;
        console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e));
    }
}

// ---------------------------------------------------------------- a tiny client

const enc = new TextEncoder();

async function newClientIdentity() {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const nodeId = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
    return { kp, nodeId };
}

async function signWith(kp, text) {
    return b64urlEncode(new Uint8Array(await crypto.subtle.sign('Ed25519', kp.privateKey, enc.encode(text))));
}

/** Frame-level client over a WebSocketLike. Collects every frame; `req` awaits the matching res. */
function wsClient(socket) {
    const frames = [];
    const waiters = [];
    let nextId = 1;
    socket.onmessage = (ev) => {
        const f = JSON.parse(ev.data);
        frames.push(f);
        for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
    };
    const waitFor = (pred) => {
        const hit = frames.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((resolve) => waiters.push({ pred, resolve }));
    };
    return {
        frames,
        send: (obj) => socket.send(JSON.stringify(obj)),
        waitFor,
        async hello(identity, nonce = 'client-nonce-1', agent = { name: 'luc3d', version: '1.0.0', platform: 'web', device_name: 'Test Laptop' }, proto = { min: 1, max: 1 }) {
            this.send({ v: 1, type: 'hello', proto, agent, node_id: identity.nodeId, nonce });
            return waitFor((f) => f.type === 'hello');
        },
        async req(method, params = {}) {
            const id = nextId++;
            this.send({ v: 1, type: 'req', id, method, params });
            return waitFor((f) => f.type === 'res' && f.id === id);
        },
    };
}

async function openClient(worker, identity, hello = {}) {
    const socket = worker.createSocket();
    const client = wsClient(socket);
    await new Promise((r) => { socket.onopen = r; if (socket.readyState === 1) r(); });
    const h = await client.hello(identity, hello.nonce, hello.agent, hello.proto);
    return { socket, client, hello: h };
}

async function pairedClient(worker, opts = {}) {
    const identity = opts.identity ?? (await newClientIdentity());
    const c = await openClient(worker, identity);
    const ticket = worker.mintTicket();
    const res = await c.client.req('pair.claim', { secret: ticket.secret, node_id: identity.nodeId });
    assert.deepEqual(res.result, {});
    return { identity, ...c };
}

async function verifyEd25519(nodeIdB64, text, sigB64) {
    const pub = await crypto.subtle.importKey('raw', b64urlDecode(nodeIdB64), 'Ed25519', false, ['verify']);
    return crypto.subtle.verify('Ed25519', pub, b64urlDecode(sigB64), enc.encode(text));
}

// ---------------------------------------------------------------- hello

await test('hello: worker hello carries a proof that verifies over the CLIENT nonce', async () => {
    const worker = await FakeWorker.create({ blobPort: 4321 });
    const id = await newClientIdentity();
    const { hello } = await openClient(worker, id, { nonce: 'my-client-nonce' });
    assert.equal(hello.v, 1);
    assert.deepEqual(hello.proto, { min: 1, max: 1 });
    assert.equal(hello.agent.name, 'sleap-connect-worker');
    assert.equal(hello.node_id, worker.nodeId);
    assert.equal(hello.blob_port, 4321);
    assert.equal(typeof hello.nonce, 'string');
    assert.notEqual(hello.nonce, 'my-client-nonce');
    assert.ok(await verifyEd25519(hello.node_id, 'my-client-nonce', hello.proof), 'proof verifies against node_id');
    assert.ok(!(await verifyEd25519(hello.node_id, 'another-nonce', hello.proof)), 'proof is bound to the nonce');
});

await test('hello: proofOverride null omits the proof; a string is sent verbatim; nonce is fresh per connection', async () => {
    const w1 = await FakeWorker.create({ proofOverride: null });
    const w2 = await FakeWorker.create({ proofOverride: 'forged' });
    const id = await newClientIdentity();
    assert.ok(!('proof' in (await openClient(w1, id)).hello));
    assert.equal((await openClient(w2, id)).hello.proof, 'forged');
    const w3 = await FakeWorker.create();
    const a = (await openClient(w3, id)).hello.nonce;
    const b = (await openClient(w3, id)).hello.nonce;
    assert.notEqual(a, b);
});

await test('hello: no blob_port until the blob server is up; proto mismatch closes 1002', async () => {
    const worker = await FakeWorker.create();
    const id = await newClientIdentity();
    assert.ok(!('blob_port' in (await openClient(worker, id)).hello));
    const socket = worker.createSocket();
    const closed = new Promise((r) => { socket.onclose = r; });
    socket.simulateOpen();
    wsClient(socket).send({ v: 1, type: 'hello', proto: { min: 2, max: 3 }, agent: {}, node_id: id.nodeId, nonce: 'n' });
    const ev = await closed;
    assert.equal(ev.code, 1002);
    assert.equal(ev.reason, 'proto.mismatch');
});

await test('auth gating: methods other than pair.claim/auth.prove need auth (auth.required)', async () => {
    const worker = await FakeWorker.create();
    const { client } = await openClient(worker, await newClientIdentity());
    const res = await client.req('worker.info');
    assert.equal(res.error.code, ERR.AUTH_REQUIRED);
    assert.equal(res.error.msg, 'Connection is not authenticated');
});

// ---------------------------------------------------------------- pair.claim

await test('pair.claim: right secret pairs + authenticates; secret is single-use', async () => {
    const worker = await FakeWorker.create();
    const id = await newClientIdentity();
    const { client } = await openClient(worker, id);
    const ticket = worker.mintTicket();
    const ok = await client.req('pair.claim', { secret: ticket.secret, node_id: id.nodeId });
    assert.deepEqual(ok.result, {});
    assert.ok(worker.paired.has(id.nodeId));
    assert.equal(worker.paired.get(id.nodeId).name, 'Test Laptop');
    assert.ok((await client.req('worker.info')).result.gpu_model, 'authenticated on the same connection');
    const again = await openClient(worker, await newClientIdentity());
    const replay = await again.client.req('pair.claim', { secret: ticket.secret, node_id: 'x' });
    assert.equal(replay.error.code, ERR.AUTH_PAIRING_EXPIRED);
});

await test('pair.claim: wrong secret and an expired secret are refused (auth.pairing_expired)', async () => {
    const worker = await FakeWorker.create();
    const id = await newClientIdentity();
    const { client } = await openClient(worker, id);
    worker.mintTicket();
    const bad = await client.req('pair.claim', { secret: 'nope', node_id: id.nodeId });
    assert.equal(bad.error.code, ERR.AUTH_PAIRING_EXPIRED);
    assert.equal(bad.error.msg, 'Pairing secret is invalid or already used');
    const expired = worker.mintTicket({ expiresAt: Math.floor(Date.now() / 1000) - 10 });
    const e = await client.req('pair.claim', { secret: expired.secret, node_id: id.nodeId });
    assert.equal(e.error.code, ERR.AUTH_PAIRING_EXPIRED);
    assert.ok(!worker.paired.has(id.nodeId));
});

// ---------------------------------------------------------------- auth.prove

await test('auth.prove: valid signature over the worker nonce for a paired node succeeds', async () => {
    const worker = await FakeWorker.create();
    const { identity } = await pairedClient(worker);
    const c2 = await openClient(worker, identity);
    const sig = await signWith(identity.kp, c2.hello.nonce);
    assert.deepEqual((await c2.client.req('auth.prove', { sig })).result, {});
    assert.ok((await c2.client.req('worker.info')).result.features.includes('media_frame'));
});

await test('auth.prove: signature over the wrong text -> auth.bad_signature', async () => {
    const worker = await FakeWorker.create();
    const { identity } = await pairedClient(worker);
    const c2 = await openClient(worker, identity);
    const res = await c2.client.req('auth.prove', { sig: await signWith(identity.kp, 'not-the-nonce') });
    assert.equal(res.error.code, ERR.AUTH_BAD_SIGNATURE);
    const garbage = await c2.client.req('auth.prove', { sig: 'AAAA' });
    assert.equal(garbage.error.code, ERR.AUTH_BAD_SIGNATURE);
});

await test('auth.prove: valid signature but unpaired node -> auth.untrusted', async () => {
    const worker = await FakeWorker.create();
    const stranger = await newClientIdentity();
    const c = await openClient(worker, stranger);
    const res = await c.client.req('auth.prove', { sig: await signWith(stranger.kp, c.hello.nonce) });
    assert.equal(res.error.code, ERR.AUTH_UNTRUSTED);
    assert.ok(res.error.msg.includes(stranger.nodeId));
    assert.equal((await c.client.req('worker.info')).error.code, ERR.AUTH_REQUIRED);
});

await test('unpairing a connected device: next request -> auth.untrusted and the socket closes 4001', async () => {
    const worker = await FakeWorker.create();
    const { identity, client, socket } = await pairedClient(worker);
    const closed = new Promise((r) => { socket.onclose = r; });
    worker.unpair(identity.nodeId);
    assert.equal((await client.req('worker.info')).error.code, ERR.AUTH_UNTRUSTED);
    const ev = await closed;
    assert.equal(ev.code, 4001);
});

await test('clients.list / rename / leave', async () => {
    const worker = await FakeWorker.create();
    const { identity, client, socket } = await pairedClient(worker);
    const list = (await client.req('clients.list')).result.clients;
    assert.equal(list.length, 1);
    assert.equal(list[0].you, true);
    assert.equal(list[0].node_id, identity.nodeId);
    assert.deepEqual((await client.req('clients.rename', { name: '  Bench PC  ' })).result, {});
    assert.equal((await client.req('clients.list')).result.clients[0].name, 'Bench PC');
    assert.equal((await client.req('clients.rename', { name: '   ' })).error.code, ERR.CLIENTS_BAD_NAME);
    const closed = new Promise((r) => { socket.onclose = r; });
    assert.deepEqual((await client.req('clients.leave')).result, { removed: true });
    assert.equal((await closed).code, 4001);
    assert.equal(worker.paired.size, 0);
});

await test('unknown method -> proto.unknown_method; handler override + ProtocolError + removal', async () => {
    const worker = await FakeWorker.create({
        pairedNodeIds: [],
        requests: {
            'worker.info': () => ({ gpu_model: 'Custom' }),
            'jobs.list': () => { throw new ProtocolError('fs.forbidden', 'nope', { why: 1 }); },
            'jobs.status': null,
        },
    });
    const { client } = await pairedClient(worker);
    assert.deepEqual((await client.req('worker.info')).result, { gpu_model: 'Custom' });
    const err = (await client.req('jobs.list')).error;
    assert.deepEqual(err, { code: 'fs.forbidden', msg: 'nope', data: { why: 1 } });
    assert.equal((await client.req('jobs.status', { job_id: 'x' })).error.code, ERR.PROTO_UNKNOWN_METHOD);
    assert.equal((await client.req('blobs.get', {})).error.msg, 'Unknown method: blobs.get');
});

// ---------------------------------------------------------------- fs

await test('fs.mounts / stat / list (dirs first, offset paging of 20)', async () => {
    const files = { '/data/sub/inner.txt': 'x', '/data/b.txt': 'bb', '/data/A.slp': 'a' };
    for (let i = 0; i < 25; i++) files[`/data/many/f${String(i).padStart(2, '0')}.bin`] = new Uint8Array(i);
    const worker = await FakeWorker.create({ files, serveFolder: '/data' });
    const { client } = await pairedClient(worker);
    assert.deepEqual((await client.req('fs.mounts')).result, { mounts: [{ path: '/data', label: 'Data' }], serve_folder: '/data' });

    const root = (await client.req('fs.list', { path: '/data' })).result;
    assert.deepEqual(root.entries.map((e) => `${e.type}:${e.name}`), ['directory:many', 'directory:sub', 'file:A.slp', 'file:b.txt']);
    assert.equal(root.total_count, 4);
    assert.equal(root.has_more, false);
    assert.equal(root.entries[3].size, 2);

    const p1 = (await client.req('fs.list', { path: '/data/many' })).result;
    assert.equal(p1.entries.length, 20);
    assert.equal(p1.total_count, 25);
    assert.equal(p1.has_more, true);
    const p2 = (await client.req('fs.list', { path: '/data/many', offset: 20 })).result;
    assert.equal(p2.entries.length, 5);
    assert.equal(p2.has_more, false);

    assert.deepEqual((await client.req('fs.stat', { path: '/data/b.txt' })).result, { path: '/data/b.txt', type: 'file', size: 2, modified: 1700000000 });
    assert.equal((await client.req('fs.stat', { path: '/data/sub' })).result.type, 'directory');
    // Errors live inside `result` for fs.* (file_manager.py), not in res.error.
    const denied = await client.req('fs.list', { path: '/etc' });
    assert.equal(denied.error, undefined);
    assert.equal(denied.result.error_code, 'ACCESS_DENIED');
    assert.equal((await client.req('fs.stat', { path: '/data/none' })).result.error_code, 'PATH_NOT_FOUND');
    assert.equal((await client.req('fs.list', { path: '/data/b.txt' })).result.error, 'Path is not a directory');
    assert.equal((await client.req('fs.list', { path: '/data/../etc' })).result.error_code, 'ACCESS_DENIED');
});

await test('fs.read: base64 + offset/size/total_size/eof, paging, 4 MiB cap, error shapes', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const worker = await FakeWorker.create({ files: { '/data/big.bin': big, '/data/hi.txt': 'hello world' } });
    const { client } = await pairedClient(worker);

    const hi = (await client.req('fs.read', { path: '/data/hi.txt', offset: 6, length: 3 })).result;
    assert.deepEqual(hi, { path: '/data/hi.txt', content_base64: btoa('wor'), offset: 6, size: 3, total_size: 11, eof: false });
    const tail = (await client.req('fs.read', { path: '/data/hi.txt', offset: 6 })).result;
    assert.equal(atob(tail.content_base64), 'world');
    assert.equal(tail.eof, true);

    // Paging through a file bigger than the cap reassembles it exactly.
    const out = new Uint8Array(big.length);
    let offset = 0;
    let pages = 0;
    for (;;) {
        const r = (await client.req('fs.read', { path: '/data/big.bin', offset, length: 100 * 1024 * 1024 })).result;
        assert.equal(r.offset, offset);
        assert.equal(r.total_size, big.length);
        assert.ok(r.size <= 4 * 1024 * 1024, 'cap');
        out.set(Uint8Array.from(atob(r.content_base64), (c) => c.charCodeAt(0)), offset);
        offset += r.size;
        pages++;
        if (r.eof) break;
    }
    assert.equal(pages, 2);
    assert.equal(offset, big.length);
    assert.deepEqual(out, big);

    assert.equal((await client.req('fs.read', { path: '/data/hi.txt', offset: -1 })).result.error_code, 'INVALID_RANGE');
    assert.equal((await client.req('fs.read', { path: '/data' })).result.error, 'Path is not a file');
    assert.equal((await client.req('fs.read', { path: '/elsewhere/x' })).result.error_code, 'ACCESS_DENIED');
    const eofRead = (await client.req('fs.read', { path: '/data/hi.txt', offset: 11 })).result;
    assert.deepEqual([eofRead.size, eofRead.eof, eofRead.content_base64], [0, true, '']);
});

// ---------------------------------------------------------------- jobs

await test('jobs.submit / status / list / delete, with path policy and queue position', async () => {
    const worker = await FakeWorker.create({ files: { '/data/a.slp': 'x' } });
    const { client, identity } = await pairedClient(worker);
    const spec = { type: 'track', data_path: '/data/a.slp', model_paths: ['/data/m'], project: { name: 'p', id: '1' } };
    const { job_id } = (await client.req('jobs.submit', { spec })).result;
    assert.match(job_id, /^job_[A-Za-z0-9_-]{12}$/);
    const { job_id: j2 } = (await client.req('jobs.submit', { spec: { ...spec, data_path: '/data/b.slp' } })).result;

    const st = (await client.req('jobs.status', { job_id })).result;
    assert.equal(st.state, 'queued');
    assert.equal(st.kind, 'track');
    assert.equal(st.labels_path, '/data/a.slp');
    assert.equal(st.queue_position, 1);
    assert.deepEqual(st.project, { name: 'p', id: '1' });
    assert.equal(st.result, null);

    const list = (await client.req('jobs.list')).result.jobs;
    assert.deepEqual(list.map((j) => j.job_id), [j2, job_id], 'newest first');
    assert.equal(list[1].submitted_by, identity.nodeId);
    assert.ok(!('spec' in list[0]));
    assert.equal(list[0].queue_position, 2);

    const bad = (await client.req('jobs.submit', { spec: { ...spec, data_path: '/secret/a.slp' } })).error;
    assert.equal(bad.code, ERR.JOB_PATH_NOT_SHARED);
    assert.deepEqual(bad.data.field, 'data_path');
    assert.equal((await client.req('jobs.submit', { spec: { type: 'nope' } })).error.code, ERR.JOB_SPEC_INVALID);
    assert.equal((await client.req('jobs.status', { job_id: 'missing' })).error.code, ERR.JOB_NOT_FOUND);

    // delete is all-or-nothing and refuses active jobs
    const act = (await client.req('jobs.delete', { job_ids: [job_id] })).error;
    assert.equal(act.code, ERR.JOB_ACTIVE);
    worker.setJobState(job_id, 'canceled');
    worker.setJobState(j2, 'failed', { detail: 'boom' });
    assert.equal((await client.req('jobs.delete', { job_ids: [job_id, 'ghost'] })).error.code, ERR.JOB_NOT_FOUND);
    assert.equal(worker.jobs.size, 2);
    assert.deepEqual((await client.req('jobs.delete', { job_ids: [job_id, j2] })).result, { deleted: [job_id, j2] });
    assert.equal(worker.jobs.size, 0);
});

await test('jobs.subscribe: backlog (seq > since_seq) arrives in order BEFORE the res, then live events', async () => {
    const worker = await FakeWorker.create();
    const { client } = await pairedClient(worker);
    const { job_id } = (await client.req('jobs.submit', { spec: { type: 'track', data_path: '/data/a.slp' } })).result;
    worker.setJobState(job_id, 'running');
    worker.log(job_id, 'step 1');
    worker.log(job_id, 'step 2');
    worker.epoch(job_id, 1, 0.5, null);

    const start = client.frames.length;
    const sub = await client.req('jobs.subscribe', { job_id, since_seq: 1 });
    assert.deepEqual(sub.result, {});
    const got = client.frames.slice(start);
    assert.deepEqual(got.map((f) => (f.type === 'event' ? `${f.topic}#${f.seq}` : f.type)), ['job.log#2', 'job.log#3', 'job.epoch#4', 'res']);
    assert.equal(got[0].job_id, job_id);
    assert.deepEqual(got[0].data, { line: 'step 1' });
    assert.deepEqual(got[2].data, { epoch: 1, train_loss: 0.5, val_loss: null });

    // live
    worker.log(job_id, '50%', { progress: true });
    worker.metric(job_id, { epoch: 1, total_epochs: 10 });
    worker.curve(job_id, [[0, 1], [1, 0.5]]);
    const result = await worker.completeJob(job_id, { predictions: 'PRED-BYTES' });
    await client.waitFor((f) => f.topic === 'job.status' && f.data.state === 'completed');
    const live = client.frames.slice(start + 4).filter((f) => f.type === 'event');
    assert.deepEqual(live.map((f) => f.topic), ['job.log', 'job.metric', 'job.curve', 'job.result', 'job.status']);
    assert.deepEqual(live[0].data, { line: '50%', progress: true });
    assert.deepEqual(live[2].data, { points: [{ x: 0, y: 1 }, { x: 1, y: 0.5 }] });
    assert.deepEqual(live[3].data.blobs.predictions, { sha256: await sha256Hex(enc.encode('PRED-BYTES')), size: 10 });
    assert.deepEqual(live[3].data, result);
    assert.deepEqual(live.map((f) => f.seq), [5, 6, 7, 8, 9], 'seq is per-job monotonic');

    // unknown job
    assert.equal((await client.req('jobs.subscribe', { job_id: 'ghost' })).error.code, ERR.JOB_NOT_FOUND);
    // a fresh subscriber with since_seq 0 replays everything, and nothing is pushed unsubscribed
    const c2 = await pairedClient(worker);
    await c2.client.req('jobs.subscribe', { job_id });
    assert.equal(c2.client.frames.filter((f) => f.type === 'event').length, 9);
});

await test('jobs.cancel: queued -> canceled before start; running (immediate) -> canceled by request; terminal no-op', async () => {
    const worker = await FakeWorker.create();
    const { client } = await pairedClient(worker);
    const a = (await client.req('jobs.submit', { spec: { type: 'track', data_path: '/data/a' } })).result.job_id;
    const b = (await client.req('jobs.submit', { spec: { type: 'track', data_path: '/data/b' } })).result.job_id;
    await client.req('jobs.subscribe', { job_id: a });
    assert.deepEqual((await client.req('jobs.cancel', { job_id: a })).result, {});
    const ev = await client.waitFor((f) => f.topic === 'job.status' && f.data.state === 'canceled');
    assert.equal(ev.data.detail, 'canceled before it started');
    assert.equal(worker.jobs.get(a).error, 'canceled before it started');
    worker.setJobState(b, 'running');
    await client.req('jobs.cancel', { job_id: b, mode: 'stop' });
    assert.equal(worker.jobs.get(b).state, 'canceled');
    assert.equal(worker.jobs.get(b).error, 'stopped early by request');
    const before = worker.jobs.get(b).seq;
    await client.req('jobs.cancel', { job_id: b });
    assert.equal(worker.jobs.get(b).seq, before);
    assert.equal((await client.req('jobs.cancel', { job_id: 'ghost' })).error.code, ERR.JOB_NOT_FOUND);
    // manual mode keeps it running
    const m = await FakeWorker.create({ cancelRunning: 'manual', autoRun: true });
    const mc = await pairedClient(m);
    const j = (await mc.client.req('jobs.submit', { spec: { type: 'track', data_path: '/data/a' } })).result.job_id;
    assert.equal(m.jobs.get(j).state, 'running');
    assert.equal((await mc.client.req('worker.info')).result.busy, true);
    await mc.client.req('jobs.cancel', { job_id: j });
    assert.equal(m.jobs.get(j).state, 'running');
    assert.equal(m.jobs.get(j).cancelRequested, 'cancel');
});

// ---------------------------------------------------------------- pair code

await test('pair code: encoder + decoder reproduce every shared vector (sleap-app == sleap-connect)', async () => {
    const vectors = JSON.parse(readFileSync(path.join(here, 'fixtures/connect/pair_code_vectors.json'), 'utf8'));
    assert.ok(vectors.length >= 4);
    for (const v of vectors) {
        const code = await encodePairCode(v.ticket);
        assert.equal(code, v.code, `encode: ${v.description}`);
        const dec = await decodePairCode(v.code);
        assert.equal(dec.node_id, v.ticket.node_id, v.description);
        assert.equal(dec.secret, v.ticket.secret, v.description);
        assert.equal(dec.expires_at, v.ticket.expires_at, v.description);
        assert.deepEqual(dec.addrs, v.ticket.addrs, v.description);
        assert.equal(dec.iroh?.relay_url ?? null, v.ticket.relay_url, v.description);
    }
});

await test('pair code: checksum, prefix, version and trailing-data errors', async () => {
    const vectors = JSON.parse(readFileSync(path.join(here, 'fixtures/connect/pair_code_vectors.json'), 'utf8'));
    const good = vectors[0].code;
    assert.ok(isPairCode(`  ${good.toUpperCase()}  `));
    assert.equal((await decodePairCode(`  ${good.toUpperCase()}\n`)).expires_at, 1700000000, 'trimmed, case-insensitive');
    await assert.rejects(decodePairCode(mistypeCode(good)), PairCodeError);
    await assert.rejects(decodePairCode('hello'), /Not a sleap-connect pairing code/);
    await assert.rejects(decodePairCode(good.slice(0, 30)), PairCodeError);
    await assert.rejects(decodePairCode(await encodePairCode(vectors[0].ticket, { version: 2 })), /Unsupported pairing code version: 2/);
});

await test('pair code: FakeWorker.mintPairCode round-trips and its secret is claimable exactly once', async () => {
    const worker = await FakeWorker.create();
    const code = await worker.mintPairCode({ addrs: ['ws://127.0.0.1:9631', 'ws://[::1]:9632'], relayUrl: 'https://relay.example.org/' });
    assert.ok(code.startsWith('sleap1'));
    const t = await decodePairCode(code);
    assert.equal(t.node_id, worker.nodeId);
    assert.deepEqual(t.addrs, ['ws://127.0.0.1:9631', 'ws://[::1]:9632']);
    assert.equal(t.iroh.relay_url, 'https://relay.example.org/');
    assert.ok(t.expires_at > Date.now() / 1000);
    const id = await newClientIdentity();
    const { client } = await openClient(worker, id);
    assert.deepEqual((await client.req('pair.claim', { secret: t.secret, node_id: id.nodeId })).result, {});
    const c2 = await openClient(worker, await newClientIdentity());
    assert.equal((await c2.client.req('pair.claim', { secret: t.secret, node_id: 'z' })).error.code, ERR.AUTH_PAIRING_EXPIRED);
});

// ---------------------------------------------------------------- blob http

await test('blob http: GET + Range, 416, 404, 501 for OPTIONS, and NO CORS headers', async () => {
    const worker = await FakeWorker.create();
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);
    const { sha256, size } = await worker.registerBlob(bytes);
    assert.equal(size, 1000);
    const srv = await worker.startBlobServer();
    try {
        assert.equal(worker.blobPort, srv.port);
        const url = `${srv.url}/blobs/${sha256}`;

        const full = await fetch(url);
        assert.equal(full.status, 200);
        assert.equal(full.headers.get('accept-ranges'), 'bytes');
        assert.equal(full.headers.get('content-type'), 'application/octet-stream');
        assert.equal(full.headers.get('content-length'), '1000');
        assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
        for (const h of full.headers.keys()) assert.ok(!h.toLowerCase().startsWith('access-control-'), `no ${h}`);

        const part = await fetch(url, { headers: { Range: 'bytes=10-19' } });
        assert.equal(part.status, 206);
        assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
        assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes.subarray(10, 20));
        assert.equal(part.headers.get('access-control-allow-origin'), null);

        const open = await fetch(url, { headers: { Range: 'bytes=990-' } });
        assert.equal(open.status, 206);
        assert.equal(open.headers.get('content-range'), 'bytes 990-999/1000');
        const suffix = await fetch(url, { headers: { Range: 'bytes=-5' } });
        assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), bytes.subarray(995));

        assert.equal((await fetch(url, { headers: { Range: 'bytes=2000-3000' } })).status, 416);
        assert.equal((await fetch(url, { headers: { Range: 'bytes=5-2' } })).status, 416);
        assert.equal((await fetch(url, { headers: { Range: 'lines=1-2' } })).status, 416);
        assert.equal((await fetch(`${srv.url}/blobs/${'0'.repeat(64)}`)).status, 404);
        assert.equal((await fetch(`${srv.url}/nope`)).status, 404);

        // A cross-origin preflight is refused: the real worker has no do_OPTIONS.
        const pre = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8080', 'Access-Control-Request-Method': 'GET' } });
        assert.equal(pre.status, 501);
        assert.equal(pre.headers.get('access-control-allow-origin'), null);
    } finally {
        await srv.close();
    }
    // the hello announces the port while the server is up
    const w2 = await FakeWorker.create();
    const s2 = await w2.startBlobServer();
    try {
        assert.equal((await openClient(w2, await newClientIdentity())).hello.blob_port, s2.port);
    } finally {
        await s2.close();
    }
});

// ---------------------------------------------------------------- the ported socket

await test('FakeWorkerSocket (sleap-app port): default hello proof verifies; pair.claim ok; bad auth.prove', async () => {
    const id = await newClientIdentity();
    const socket = new FakeWorkerSocket({ blobPort: 9 });
    const client = wsClient(socket);
    socket.simulateOpen();
    const hello = await client.hello(id, 'abc');
    assert.equal(hello.blob_port, 9);
    assert.equal(socket.clientNodeId, id.nodeId);
    assert.ok(await verifyEd25519(hello.node_id, 'abc', hello.proof));
    assert.deepEqual((await client.req('pair.claim', { secret: 's', node_id: id.nodeId })).result, {});
    const ok = await client.req('auth.prove', { sig: await signWith(id.kp, 'worker-nonce') });
    assert.deepEqual(ok.result, {});
    const bad = await client.req('auth.prove', { sig: await signWith(id.kp, 'other') });
    assert.equal(bad.error.code, 'auth.bad_signature');
    assert.equal((await client.req('worker.info')).error.code, 'proto.unknown_method');
    socket.emitEvent('job.log', 'j1', 3, { line: 'hi' });
    const ev = await client.waitFor((f) => f.type === 'event');
    assert.deepEqual(ev, { v: 1, type: 'event', topic: 'job.log', seq: 3, job_id: 'j1', data: { line: 'hi' } });
    assert.equal(socket.sent.length, 5); // hello + 4 reqs
});

await test('FakeWorkerSocket: custom handleRequest, proofOverride null/forged, custom workerNodeId', async () => {
    const id = await newClientIdentity();
    const s = new FakeWorkerSocket({ proofOverride: null, workerNodeId: 'custom', handleRequest: (m) => ({ result: { echoed: m } }) });
    const c = wsClient(s);
    s.simulateOpen();
    const h = await c.hello(id);
    assert.ok(!('proof' in h));
    assert.equal(h.node_id, 'custom');
    assert.deepEqual((await c.req('x.y')).result, { echoed: 'x.y' });
    const s2 = new FakeWorkerSocket({ proofOverride: 'forged' });
    const c2 = wsClient(s2);
    s2.simulateOpen();
    assert.equal((await c2.hello(id)).proof, 'forged');
    let closed = false;
    s2.onclose = () => { closed = true; };
    s2.close();
    assert.ok(closed && s2.readyState === 3);
});

// ---------------------------------------------------------------- route adapter (duck-typed Playwright WebSocketRoute)

await test('attachRoute: drives a Playwright-style WebSocketRoute (onMessage/send/close)', async () => {
    const worker = await FakeWorker.create();
    const sent = [];
    let onMsg;
    let onClose;
    let closedWith = null;
    const ws = {
        onMessage: (h) => { onMsg = h; },
        onClose: (h) => { onClose = h; },
        send: (d) => sent.push(JSON.parse(d)),
        close: (opts) => { closedWith = opts; },
    };
    const conn = worker.attachRoute(ws);
    const id = await newClientIdentity();
    onMsg(JSON.stringify({ v: 1, type: 'hello', proto: { min: 1, max: 1 }, agent: {}, node_id: id.nodeId, nonce: 'rn' }));
    await conn.idle();
    assert.equal(sent[0].type, 'hello');
    assert.ok(await verifyEd25519(sent[0].node_id, 'rn', sent[0].proof));
    onMsg(Buffer.from(JSON.stringify({ v: 1, type: 'req', id: 1, method: 'worker.info', params: {} })));
    await conn.idle();
    assert.equal(sent[1].error.code, ERR.AUTH_REQUIRED);
    worker.closeAll(4000, 'bye');
    assert.deepEqual(closedWith, { code: 4000, reason: 'bye' });
    assert.equal(worker.connections.size, 0);
    onClose?.();
});

// ---------------------------------------------------------------- differential regressions
// Each case below was a deviation found by replaying one scripted conversation against the real worker
// (sleap-connect 0.0.8 @ 0610a6b, `serve --foreground`) and the fake, then diffing every frame.

/** Open a raw socket, send raw frames, return what came back + the close. */
async function rawProbe(worker, frames) {
    const socket = worker.createSocket();
    const got = [];
    let closed = null;
    socket.onmessage = (e) => got.push(JSON.parse(e.data));
    socket.onclose = (e) => { closed = { code: e.code, reason: e.reason }; };
    await new Promise((r) => { socket.onopen = r; if (socket.readyState === 1) r(); });
    for (const f of frames) {
        socket.send(typeof f === 'string' ? f : JSON.stringify(f));
        await socket.connection.idle();
    }
    await new Promise((r) => setTimeout(r, 5));
    return { got, closed };
}
const HELLO = (extra = {}) => ({ v: 1, type: 'hello', proto: { min: 1, max: 1 }, agent: {}, node_id: 'n', nonce: 'x', ...extra });

await test('envelope: a bad FIRST frame closes 1002 with the real parse_envelope text', async () => {
    const w = await FakeWorker.create();
    const reason = async (frame) => (await rawProbe(w, [frame])).closed;
    assert.deepEqual(await reason('not json'), { code: 1002, reason: 'Invalid JSON: Expecting value: line 1 column 1 (char 0)' });
    assert.deepEqual(await reason('[1]'), { code: 1002, reason: 'Envelope frame must be a JSON object' });
    assert.deepEqual(await reason({ v: 1, type: 'zzz' }), { code: 1002, reason: "Unknown or missing envelope type: 'zzz'" });
    assert.deepEqual(await reason({ v: 1 }), { code: 1002, reason: 'Unknown or missing envelope type: None' });
    assert.deepEqual(await reason({ v: 1, type: 'req', id: 1, method: 'fs.mounts' }), { code: 1002, reason: 'expected hello as the first frame' });
    assert.deepEqual(await reason({ v: 1, type: 'req', method: 'fs.mounts' }), { code: 1002, reason: "Missing required field 'id' for type 'req'" });
    for (const key of ['proto', 'agent', 'node_id', 'nonce']) {
        const h = HELLO();
        delete h[key];
        assert.deepEqual(await reason(h), { code: 1002, reason: `Missing required field '${key}' for type 'hello'` });
    }
    assert.deepEqual(await reason(HELLO({ proto: { min: 2, max: 3 } })), { code: 1002, reason: 'proto.mismatch' });
    assert.deepEqual(await reason(HELLO({ proto: {} })), { code: 1002, reason: 'proto.mismatch' });
    // a range that includes 1, a missing `v` and a different `v` are all accepted
    assert.equal((await rawProbe(w, [HELLO({ proto: { min: 0, max: 5 } })])).got[0].type, 'hello');
    assert.equal((await rawProbe(w, [HELLO({ v: undefined })])).got[0].type, 'hello');
    assert.equal((await rawProbe(w, [HELLO({ v: 9 })])).got[0].type, 'hello');
});

await test('envelope: after hello, unparsable / id-less / method-less / non-req frames are dropped silently', async () => {
    const w = await FakeWorker.create();
    const { got, closed } = await rawProbe(w, [
        HELLO(), 'garbage', HELLO(), { v: 1, type: 'req', method: 'fs.mounts' }, { v: 1, type: 'req', id: 77 },
        { v: 1, type: 'event', topic: 'x', seq: 1, data: {} }, { v: 1, type: 'res', id: 1, result: {} },
        { v: 1, type: 'req', id: 1, method: 'fs.mounts', params: {} },
    ]);
    assert.equal(closed, null);
    assert.equal(got.length, 2, 'only the hello and the one valid req are answered');
    assert.equal(got[1].id, 1);
    assert.equal(got[1].error.code, ERR.AUTH_REQUIRED);
});

await test('params: absent -> {} (KeyError text); explicit null -> TypeError text; a non-string method is unknown', async () => {
    const w = await FakeWorker.create();
    const { got } = await rawProbe(w, [
        HELLO(), { v: 1, type: 'req', id: 1, method: 'pair.claim' }, { v: 1, type: 'req', id: 2, method: 'pair.claim', params: null },
        { v: 1, type: 'req', id: 3, method: 12, params: {} },
    ]);
    assert.deepEqual(got[1].error, { code: 'internal', msg: "'secret'" });
    assert.deepEqual(got[2].error, { code: 'internal', msg: "'NoneType' object is not subscriptable" });
    assert.equal(got[3].error.code, ERR.AUTH_REQUIRED);
});

await test('auth.prove: a missing or non-string sig is `internal`, never a quiet bad_signature', async () => {
    const w = await FakeWorker.create();
    const id = await newClientIdentity();
    const { client } = await openClient(w, id);
    assert.deepEqual((await client.req('auth.prove', {})).error, { code: 'internal', msg: "'sig'" });
    assert.equal((await client.req('auth.prove', { sig: 5 })).error.code, 'internal');
    for (const sig of ['!!!notb64', 'AAAA', '']) assert.equal((await client.req('auth.prove', { sig })).error.code, ERR.AUTH_BAD_SIGNATURE);
});

await test('fs.stat: outside the shares is existence-only {path,type,shared:false}; the data dir is refused', async () => {
    const w = await FakeWorker.create({
        mounts: [{ path: '/data', label: 'Data' }],
        files: { '/data/a.txt': 'hello', '/media/v.mp4': 'vid', '/home/me/.lucid/identity.json': '{}' },
        dataDir: '/home/me/.lucid',
    });
    const { client } = await pairedClient(w);
    const stat = async (path) => (await client.req('fs.stat', { path })).result;
    assert.deepEqual(await stat('/media/v.mp4'), { path: '/media/v.mp4', type: 'file', shared: false });
    assert.deepEqual(await stat('/media'), { path: '/media', type: 'directory', shared: false });
    assert.deepEqual(await stat('/'), { path: '/', type: 'directory', shared: false });
    assert.deepEqual(await stat('/media/nope.mp4'), { path: '/media/nope.mp4', error: 'Path does not exist', error_code: 'PATH_NOT_FOUND' });
    assert.equal((await stat('/home/me/.lucid/identity.json')).error_code, 'ACCESS_DENIED');
    assert.equal((await stat('/home/me/.lucid')).error_code, 'ACCESS_DENIED');
    assert.equal((await stat('/data/a.txt')).size, 5, 'inside a share: full metadata');
    // list/read stay share-only, existing or not
    for (const m of ['fs.list', 'fs.read']) {
        assert.equal((await client.req(m, { path: '/media/v.mp4' })).result.error_code, 'ACCESS_DENIED');
        assert.equal((await client.req(m, { path: '/media/nope' })).result.error_code, 'ACCESS_DENIED');
    }
});

await test('fs.*: relative paths resolve against the worker cwd; a missing / non-string path is `internal`', async () => {
    const w = await FakeWorker.create({ mounts: [{ path: '/data', label: 'Data' }], files: { '/data/a.txt': 'hello', '/data/sub/b.txt': 'x' }, serveFolder: '/data' });
    const { client } = await pairedClient(w);
    assert.equal((await client.req('fs.stat', { path: 'a.txt' })).result.path, '/data/a.txt');
    assert.equal((await client.req('fs.list', { path: '' })).result.path, '/data');
    assert.equal((await client.req('fs.list', { path: 'sub' })).result.entries[0].name, 'b.txt');
    assert.equal((await client.req('fs.read', { path: 'a.txt', length: 2 })).result.size, 2);
    for (const m of ['fs.list', 'fs.stat', 'fs.read']) {
        assert.deepEqual((await client.req(m, {})).error, { code: 'internal', msg: "'path'" });
        assert.equal((await client.req(m, { path: 5 })).error.code, 'internal');
        assert.equal((await client.req(m, { path: null })).error.code, 'internal');
    }
});

await test('fs.read: Python offset/length arithmetic (length -1 = to EOF uncapped, other negatives and non-integers = internal)', async () => {
    const big = new Uint8Array(5 * 1024 * 1024).fill(7);
    const w = await FakeWorker.create({ files: { '/data/a.txt': 'hello-world\n', '/data/big.bin': big } });
    const { client } = await pairedClient(w);
    const read = (params) => client.req('fs.read', { path: '/data/a.txt', ...params });
    assert.equal((await read({ length: -1 })).result.size, 12);
    assert.equal((await read({ length: -1 })).result.eof, true);
    assert.equal((await client.req('fs.read', { path: '/data/big.bin', length: -1 })).result.size, big.length, 'read(-1) is not capped at 4 MiB');
    assert.equal((await client.req('fs.read', { path: '/data/big.bin' })).result.size, 4 * 1024 * 1024);
    assert.equal((await read({ length: 0 })).result.eof, false);
    assert.equal((await read({ offset: 5000 })).result.eof, true);
    assert.equal((await read({ offset: -1 })).result.error_code, 'INVALID_RANGE');
    assert.equal((await read({ length: null })).result.size, 12);
    for (const bad of [{ offset: null }, { offset: '2' }, { offset: 1.5 }, { length: 2.5 }, { length: -4 }, { length: 'x' }]) {
        assert.equal((await read(bad)).error?.code, 'internal', JSON.stringify(bad));
    }
    assert.equal((await client.req('fs.list', { path: '/data', offset: 1.5 })).error.code, 'internal');
});

await test('jobs.*: a missing id/ids param is `internal`; ids print Python-style; delete of a string iterates characters', async () => {
    const w = await FakeWorker.create();
    const { client } = await pairedClient(w);
    for (const m of ['jobs.status', 'jobs.subscribe', 'jobs.cancel']) {
        assert.deepEqual((await client.req(m, {})).error, { code: 'internal', msg: "'job_id'" });
        assert.deepEqual((await client.req(m, { job_id: null })).error, { code: ERR.JOB_NOT_FOUND, msg: 'No such job: None' });
    }
    assert.deepEqual((await client.req('jobs.delete', {})).error, { code: 'internal', msg: "'job_ids'" });
    assert.deepEqual((await client.req('jobs.delete', { job_ids: 'nope' })).error, { code: ERR.JOB_NOT_FOUND, msg: 'No such job: n' });
    assert.deepEqual((await client.req('jobs.delete', { job_ids: [] })).result, { deleted: [] });
});

await test('jobs.submit: spec validation text, and the stored spec is the dataclass dump (defaults filled, empties dropped)', async () => {
    const w = await FakeWorker.create({ enforceSharedFolders: false });
    const { client } = await pairedClient(w);
    const msg = async (params) => (await client.req('jobs.submit', params)).error;
    assert.deepEqual(await msg({}), { code: ERR.JOB_SPEC_INVALID, msg: "Invalid job spec: 'spec'" });
    assert.equal((await msg({ spec: {} })).msg, 'Invalid job spec: Unknown job type: None');
    assert.equal((await msg({ spec: { type: 'bogus' } })).msg, 'Invalid job spec: Unknown job type: bogus');
    assert.equal((await msg({ spec: { type: 'track' } })).msg, "Invalid job spec: TrackJobSpec.__init__() missing 1 required positional argument: 'data_path'");
    assert.equal((await msg({ spec: { type: 'train' } })).msg, 'Invalid job spec: Must provide either config_path, config_paths, config_content, or config_contents');
    const ok = await client.req('jobs.submit', { spec: { type: 'track', data_path: '/data/a.slp', model_paths: ['/data/m'], project: 'p', junk: 1, run: null, batch_size: 4 } });
    const st = (await client.req('jobs.status', { job_id: ok.result.job_id })).result;
    assert.deepEqual(st.spec, { type: 'track', data_path: '/data/a.slp', model_paths: ['/data/m'], path_mappings: {}, project: 'p', batch_size: 4 });
    const tr = await client.req('jobs.submit', { spec: { type: 'train', config_path: '/data/c.yaml' } });
    assert.deepEqual((await client.req('jobs.status', { job_id: tr.result.job_id })).result.spec, { type: 'train', config_path: '/data/c.yaml', config_paths: ['/data/c.yaml'] });
});

await test('checkInputs: a job naming a missing path fails at once (running, then failed + missing; started_at null)', async () => {
    const w = await FakeWorker.create({ checkInputs: true, files: { '/data/a.slp': 'x' } });
    const { client } = await pairedClient(w);
    const good = await client.req('jobs.submit', { spec: { type: 'track', data_path: '/data/a.slp', model_paths: [] } });
    assert.equal((await client.req('jobs.status', { job_id: good.result.job_id })).result.state, 'queued');
    const bad = await client.req('jobs.submit', { spec: { type: 'track', data_path: '/data/missing.slp', model_paths: ['/data/m'] } });
    const id = bad.result.job_id;
    const st = (await client.req('jobs.status', { job_id: id })).result;
    assert.equal(st.state, 'failed');
    assert.equal(st.started_at, null);
    assert.equal(st.error, 'not found on worker: /data/missing.slp');
    await client.req('jobs.subscribe', { job_id: id });
    const events = client.frames.filter((f) => f.type === 'event');
    assert.deepEqual(events.map((e) => [e.seq, e.data]), [
        [1, { state: 'running' }],
        [2, { state: 'failed', detail: 'not found on worker: /data/missing.slp', missing: ['/data/missing.slp', '/data/m'] }],
    ]);
    assert.deepEqual((await client.req('jobs.cancel', { job_id: id })).result, {}, 'cancel of a terminal job is a no-op');
});

await test('media.frame: params validated like the real worker (not scoped to shares); decoding via the mediaFrame hook', async () => {
    const w = await FakeWorker.create({ files: { '/elsewhere/v.mp4': 'v' }, mediaFrame: (path, i, side) => ({ mime: 'image/jpeg', content_base64: '', width: 8, height: 8, scaled_width: 8, scaled_height: 8, path, i, side }) });
    const { client } = await pairedClient(w);
    const err = async (params) => (await client.req('media.frame', params)).error;
    assert.deepEqual(await err({}), { code: ERR.MEDIA_UNREADABLE, msg: "media.frame needs a 'path'" });
    assert.equal((await err({ path: 5 })).msg, "media.frame needs a 'path'");
    assert.deepEqual(await err({ path: '/elsewhere/nope.mp4' }), { code: ERR.FS_NOT_FOUND, msg: 'No such file: /elsewhere/nope.mp4' });
    assert.equal((await err({ path: '/elsewhere/v.mp4', frame_idx: -1 })).msg, 'frame_idx must be >= 0 and max_side >= 1');
    assert.equal((await err({ path: '/elsewhere/v.mp4', frame_idx: 1.5 })).msg, "'frame_idx' must be an integer");
    assert.equal((await err({ path: '/elsewhere/v.mp4', max_side: true })).msg, "'max_side' must be an integer");
    const ok = (await client.req('media.frame', { path: '/elsewhere/v.mp4', frame_idx: 3, max_side: 99999 })).result;
    assert.deepEqual([ok.i, ok.side], [3, 4096]);
    assert.equal((await client.req('media.frame', { path: '/elsewhere/v.mp4' })).result.side, 2048);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
