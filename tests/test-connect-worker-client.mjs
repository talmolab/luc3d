/**
 * test-connect-worker-client.mjs: LUCID tests of `WorkerClient` + `ManagedConnection`
 * against the SERVER-FAITHFUL fake worker (tests/connect/fake-worker.mjs `FakeWorker`,
 * a state machine implementing sleap-connect @ 0610a6b's behaviour: auth gating, one-time
 * pairing secrets, hello proof over the client's nonce, per-job event store with
 * `since_seq` replay, fs.* error codes inside `result`, blob HTTP without CORS).
 *
 * sleap-app's own client tests (test-connect-client.mjs) use the permissive
 * FakeWorkerSocket port; these exercise the whole conversation: pair -> auth.prove
 * reconnect -> fs.list -> jobs.submit -> subscribe with backlog -> completeJob ->
 * blob download (real HTTP through `startBlobServer`, and the LUCID `fs.read`
 * fallback used when a page cannot read the blob port).
 */
import assert from 'node:assert/strict';
import { FakeWorker } from './connect/fake-worker.mjs';
import { WorkerClient } from '../pose/connect/client.js';
import { ManagedConnection } from '../pose/connect/managed-connection.js';
import { getClientIdentity, setIdentityStorage, createMemoryAdapter } from '../pose/connect/identity.js';
import {
  AUTH_PAIRING_EXPIRED,
  AUTH_REQUIRED,
  AUTH_UNTRUSTED,
  BLOB_HASH_MISMATCH,
  BLOB_INCOMPLETE,
  BLOB_UNKNOWN,
  CLIENT_WORKER_UNVERIFIED,
  FS_FORBIDDEN,
  FS_NOT_FOUND,
  JOB_NOT_FOUND,
  WorkerProtocolError,
} from '../pose/connect/errors.js';

console.warn = () => {};

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack : e));
  }
}

async function newIdentity() {
  setIdentityStorage(createMemoryAdapter());
  return getClientIdentity();
}

const URL_ = 'ws://127.0.0.1:9631';
const TRACK_SPEC = { type: 'track', data_path: '/data/x.slp', model_paths: ['/data/model'] };

function clientFor(worker, identity, extra = {}) {
  return new WorkerClient({
    url: URL_,
    identity,
    requestTimeoutMs: 2000,
    createSocket: () => worker.createSocket(),
    ...extra,
  });
}

/** connect + pair.claim with a fresh ticket's secret. */
async function paired(worker, identity, extra) {
  const client = clientFor(worker, identity, extra);
  await client.connect();
  await client.pairClaim(worker.mintTicket().secret);
  return client;
}

/** connect + auth.prove (the device is already paired). */
async function reconnected(worker, identity, extra) {
  const client = clientFor(worker, identity, extra);
  await client.connect();
  await client.authProve();
  return client;
}

async function rejects(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof WorkerProtocolError, `expected WorkerProtocolError, got ${err}`);
    if (code) assert.equal(err.code, code, err.message);
    return err;
  }
  assert.fail('expected the promise to reject');
}

const bytesOf = (n, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ── handshake and auth ─────────────────────────────────────────────

await test('hello: worker proof over the client nonce verifies; blob_port and peer id are recorded', async () => {
  const worker = await FakeWorker.create({ blobPort: 4242 });
  const client = clientFor(worker, await newIdentity());
  await client.connect();
  assert.equal(client.state, 'unauthenticated');
  assert.equal(client.peerNodeId, worker.nodeId);
  assert.equal(client.peerBlobPort, 4242);
  client.close();
});

await test('a bad hello proof is rejected (client.worker_unverified), garbage and missing alike', async () => {
  for (const proofOverride of ['not-a-real-signature', null]) {
    const worker = await FakeWorker.create({ proofOverride });
    const client = clientFor(worker, await newIdentity());
    await rejects(client.connect(), CLIENT_WORKER_UNVERIFIED);
    assert.equal(client.state, 'closed');
  }
});

await test('a tampered hello.proof (a signature that no longer matches the claimed node_id) is rejected', async () => {
  const worker = await FakeWorker.create();
  const client = new WorkerClient({
    url: URL_,
    identity: await newIdentity(),
    createSocket: () => {
      const socket = worker.createSocket();
      let handler = null;
      Object.defineProperty(socket, 'onmessage', {
        get: () => handler,
        set: (h) => {
          handler = (ev) => {
            const frame = JSON.parse(ev.data);
            if (frame.type === 'hello') frame.proof = (frame.proof[0] === 'A' ? 'B' : 'A') + frame.proof.slice(1);
            h({ data: JSON.stringify(frame) });
          };
        },
        configurable: true,
      });
      return socket;
    },
  });
  await rejects(client.connect(), CLIENT_WORKER_UNVERIFIED);
});

await test('protocol range that does not overlap: client.proto_mismatch', async () => {
  const worker = await FakeWorker.create({ protoMin: 5, protoMax: 5 });
  const client = clientFor(worker, await newIdentity());
  await rejects(client.connect());
  assert.equal(client.state, 'closed');
});

await test('before authentication the worker answers auth.required (no job or fs access)', async () => {
  const worker = await FakeWorker.create({ files: { '/data/a.txt': 'x' } });
  const client = clientFor(worker, await newIdentity());
  await client.connect();
  await rejects(client.fsList('/data'), AUTH_REQUIRED);
  await rejects(client.jobsList(), AUTH_REQUIRED);
  client.close();
});

await test('pairing with a one-time secret: succeeds once, the same secret is then auth.pairing_expired', async () => {
  const worker = await FakeWorker.create();
  const identity = await newIdentity();
  const ticket = worker.mintTicket();
  const a = clientFor(worker, identity);
  await a.connect();
  await a.pairClaim(ticket.secret);
  assert.equal(a.authenticated, true);
  assert.ok(worker.paired.has(identity.nodeId));

  const b = clientFor(worker, identity);
  await b.connect();
  await rejects(b.pairClaim(ticket.secret), AUTH_PAIRING_EXPIRED);
  assert.equal(b.authenticated, false);
  await rejects(b.pairClaim('never-minted'), AUTH_PAIRING_EXPIRED);
});

await test('an expired ticket secret is auth.pairing_expired', async () => {
  const worker = await FakeWorker.create();
  const ticket = worker.mintTicket({ expiresAt: Math.floor(Date.now() / 1000) - 5 });
  const client = clientFor(worker, await newIdentity());
  await client.connect();
  await rejects(client.pairClaim(ticket.secret), AUTH_PAIRING_EXPIRED);
});

await test('reconnect: a paired device proves itself with auth.prove over the worker nonce', async () => {
  const worker = await FakeWorker.create();
  const identity = await newIdentity();
  (await paired(worker, identity)).close();

  const again = clientFor(worker, identity);
  await again.connect();
  assert.equal(again.authenticated, false);
  await again.authProve();
  assert.equal(again.authenticated, true);
  const reqs = worker.calls.filter((c) => c.method === 'auth.prove');
  assert.equal(reqs.length, 1);
  again.close();
});

await test('auth.untrusted surfaces as a WorkerProtocolError with that code when an unpaired device proves', async () => {
  const worker = await FakeWorker.create();
  const stranger = await newIdentity();
  const client = clientFor(worker, stranger);
  await client.connect();
  const err = await rejects(client.authProve(), AUTH_UNTRUSTED);
  assert.match(err.message, /is not paired with this worker/);
  assert.equal(client.authenticated, false);
});

await test('a device removed on the worker is refused on its next request (auth.untrusted)', async () => {
  const worker = await FakeWorker.create({ files: { '/data/a.txt': 'x' } });
  const identity = await newIdentity();
  const client = await paired(worker, identity);
  await client.fsList('/data');
  worker.unpair(identity.nodeId);
  await rejects(client.fsList('/data'), AUTH_UNTRUSTED);
});

await test('clients.list / rename / leave over a real pairing', async () => {
  const worker = await FakeWorker.create();
  const identity = await newIdentity();
  const client = await paired(worker, identity, { agent: { name: 'lucid', version: '1', platform: 'web', device_name: 'Lab laptop' } });
  const list = await client.clientsList();
  assert.equal(list.length, 1);
  assert.equal(list[0].nodeId, identity.nodeId);
  assert.equal(list[0].you, true);
  await client.clientsRename('Renamed');
  assert.equal((await client.clientsList())[0].name, 'Renamed');
  assert.deepEqual(await client.clientsLeave(), { removed: true });
  assert.equal(worker.paired.has(identity.nodeId), false);
});

// ── fs.* ───────────────────────────────────────────────────────────

await test('fs.mounts / fs.list / fs.stat / fs.read happy path and error_code-inside-ok handling', async () => {
  const worker = await FakeWorker.create({
    files: { '/data/a.txt': 'hello world', '/data/sub/b.bin': bytesOf(100) },
    serveFolder: '/data',
  });
  const client = await paired(worker, await newIdentity());

  const mounts = await client.fsMountsAndServeFolder();
  assert.deepEqual(mounts.mounts, [{ path: '/data', label: 'Data' }]);
  assert.equal(mounts.serveFolder, '/data');
  assert.deepEqual(await client.fsMounts(), [{ path: '/data', label: 'Data' }]);

  const list = await client.fsList('/data');
  assert.deepEqual(list.entries.map((e) => `${e.type}:${e.name}`), ['directory:sub', 'file:a.txt']); // dirs first
  assert.equal(list.hasMore, false);

  const st = await client.fsStat('/data/a.txt');
  assert.equal(st.type, 'file');
  assert.equal(st.size, 11);

  const rd = await client.fsRead('/data/a.txt', 6, 5);
  assert.equal(new TextDecoder().decode(rd.content), 'world');
  assert.equal(rd.eof, true);
  assert.equal(rd.totalSize, 11);

  // The failure is INSIDE a successful res (`{error, error_code}`), never res.error.
  await rejects(client.fsStat('/data/missing'), FS_NOT_FOUND);
  await rejects(client.fsList('/data/missing'), FS_NOT_FOUND);
  await rejects(client.fsRead('/etc/shadow'), FS_FORBIDDEN);
});

await test('fs.list pages 20 entries at a time (hasMore + offset)', async () => {
  const files = {};
  for (let i = 0; i < 45; i++) files[`/data/f${String(i).padStart(2, '0')}.txt`] = 'x';
  const worker = await FakeWorker.create({ files });
  const client = await paired(worker, await newIdentity());
  const p1 = await client.fsList('/data', 0);
  assert.equal(p1.entries.length, 20);
  assert.equal(p1.totalCount, 45);
  assert.equal(p1.hasMore, true);
  const p3 = await client.fsList('/data', 40);
  assert.equal(p3.entries.length, 5);
  assert.equal(p3.hasMore, false);
});

// ── jobs, events, last_seq ─────────────────────────────────────────

await test('jobs.submit -> subscribe replays the backlog BEFORE the res, then streams live events', async () => {
  const worker = await FakeWorker.create();
  const client = await paired(worker, await newIdentity());
  const { jobId } = await client.jobsSubmit(TRACK_SPEC, 'cj_1');
  assert.ok(worker.jobs.has(jobId));

  worker.setJobState(jobId, 'running');
  worker.log(jobId, 'starting');
  worker.log(jobId, 'Predicting: 40%', { progress: true });

  const events = [];
  const unsubscribe = await client.jobsSubscribe(jobId, 0, (e) => events.push(e));
  const afterSubscribe = events.length;
  assert.ok(afterSubscribe >= 3, `backlog (queued/running/log/log) delivered before subscribe resolved, got ${afterSubscribe}`);
  assert.deepEqual(events.map((e) => e.seq), events.map((e, i) => events[0].seq + i)); // contiguous
  assert.ok(events.every((e) => e.jobId === jobId));
  assert.ok(events.some((e) => e.topic === 'job.log' && e.data.line === 'starting'));

  worker.log(jobId, 'live line');
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(events.at(-1).data.line, 'live line');

  unsubscribe();
  worker.log(jobId, 'after unsubscribe');
  await new Promise((r) => setTimeout(r, 0));
  assert.notEqual(events.at(-1).data.line, 'after unsubscribe');
});

await test('last_seq dedupe: resubscribing since the last seq replays only newer events, in order, once', async () => {
  const worker = await FakeWorker.create();
  const identity = await newIdentity();
  const first = await paired(worker, identity);
  const { jobId } = await first.jobsSubmit(TRACK_SPEC);
  worker.setJobState(jobId, 'running');
  for (let i = 0; i < 5; i++) worker.log(jobId, `line ${i}`);

  const seen = [];
  await first.jobsSubscribe(jobId, 0, (e) => seen.push(e));
  const lastSeq = seen.at(-1).seq;
  assert.equal(seen.length, lastSeq - seen[0].seq + 1);

  // The connection drops; more happens on the worker meanwhile.
  worker.closeAll();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(first.state, 'closed');
  worker.log(jobId, 'while away 1');
  worker.log(jobId, 'while away 2');

  const second = await reconnected(worker, identity);
  const replay = [];
  await second.jobsSubscribe(jobId, lastSeq, (e) => replay.push(e));
  assert.deepEqual(replay.map((e) => e.data.line), ['while away 1', 'while away 2']);
  assert.ok(replay.every((e) => e.seq > lastSeq));

  // A subscriber that applies events by "seq > lastSeq" (sleap-app's reducer rule) ends up with every event once.
  let applied = lastSeq;
  const all = [...seen];
  for (const e of [...seen.slice(-2), ...replay]) {
    if (e.seq <= applied) continue; // the dedupe
    applied = e.seq;
    all.push(e);
  }
  assert.deepEqual(all.map((e) => e.seq), [...new Set(all.map((e) => e.seq))]);
  assert.equal(all.at(-1).data.line, 'while away 2');
});

await test('jobs.list omits spec; jobs.status has it; unknown id is job.not_found; cancel and delete', async () => {
  const worker = await FakeWorker.create();
  const client = await paired(worker, await newIdentity());
  const { jobId } = await client.jobsSubmit(TRACK_SPEC);
  const list = await client.jobsList();
  assert.equal(list.length, 1);
  assert.equal(list[0].jobId, jobId);
  assert.equal(list[0].state, 'queued');
  const status = await client.jobsStatus(jobId);
  assert.equal(status.spec?.data_path, '/data/x.slp');
  assert.equal(status.labelsPath, '/data/x.slp');
  await rejects(client.jobsSubmit({ type: 'track' }), 'job.spec_invalid');
  await rejects(client.jobsSubmit({ type: 'track', data_path: '/elsewhere/x.slp' }), 'job.path_not_shared');
  await rejects(client.jobsStatus('nope'), JOB_NOT_FOUND);
  await client.jobsCancel(jobId);
  assert.equal((await client.jobsStatus(jobId)).state, 'canceled');
  assert.deepEqual(await client.jobsDelete([jobId]), { deleted: [jobId] });
  assert.equal((await client.jobsList()).length, 0);
});

// ── blobs ──────────────────────────────────────────────────────────

/** A worker whose finished job has `predictions` as a blob AND as a file at `/data/out/preds.slp`. */
async function workerWithResult(bytes, { serveBlobs = true } = {}) {
  const worker = await FakeWorker.create({ files: { '/data/out/preds.slp': bytes } });
  let server = null;
  if (serveBlobs) server = await worker.startBlobServer();
  const identity = await newIdentity();
  return { worker, server, identity };
}

async function finishedJob(worker, client, bytes) {
  const { jobId } = await client.jobsSubmit(TRACK_SPEC);
  worker.setJobState(jobId, 'running');
  await worker.completeJob(jobId, { predictions: bytes });
  const events = [];
  await client.jobsSubscribe(jobId, 0, (e) => events.push(e));
  const result = events.find((e) => e.topic === 'job.result');
  assert.ok(result, 'job.result in the backlog');
  const status = events.filter((e) => e.topic === 'job.status').at(-1);
  assert.equal(status.data.state, 'completed');
  assert.ok(events.indexOf(result) < events.indexOf(status), 'job.result precedes job.status: completed');
  return result.data.blobs.predictions; // {sha256, size}
}

await test('blob download: real HTTP through startBlobServer (page-side fetch), size + sha256 verified', async () => {
  const bytes = bytesOf(70_000);
  const { worker, server, identity } = await workerWithResult(bytes);
  try {
    const client = await paired(worker, identity);
    assert.equal(client.peerBlobPort, server.port);
    const ref = await finishedJob(worker, client, bytes);
    const got = await client.fetchBlob(ref.sha256, ref.size); // global fetch (default)
    assert.ok(equalBytes(got, bytes));
    assert.equal(worker.blobRequests.at(-1).url, `/blobs/${ref.sha256}`);
    await rejects(client.fetchBlob(ref.sha256, ref.size + 1), BLOB_INCOMPLETE);
    await rejects(client.fetchBlob('0'.repeat(64)), BLOB_UNKNOWN); // HTTP 404
  } finally {
    await server.close();
  }
});

await test('blob fetch failing with a network/CORS TypeError falls back to paged fs.read when asked', async () => {
  const bytes = bytesOf(10_500);
  const { worker, server, identity } = await workerWithResult(bytes);
  try {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches++;
      throw new TypeError('Failed to fetch'); // what a browser raises for a response without CORS headers
    };
    const client = await paired(worker, identity, { fetchImpl });
    const ref = await finishedJob(worker, client, bytes);

    const progress = [];
    const before = worker.calls.filter((c) => c.method === 'fs.read').length;
    const got = await client.fetchBlob(ref.sha256, ref.size, {
      fsFallback: { path: '/data/out/preds.slp', pageSize: 4096, onProgress: (d, t) => progress.push([d, t]) },
    });
    assert.equal(fetches, 1);
    assert.ok(equalBytes(got, bytes));
    const reads = worker.calls.filter((c) => c.method === 'fs.read').slice(before);
    assert.equal(reads.length, 3); // 4096 + 4096 + 2308
    assert.deepEqual(reads.map((r) => r.params.offset), [0, 4096, 8192]);
    assert.ok(reads.every((r) => r.params.length === 4096));
    assert.deepEqual(progress, [[4096, 10500], [8192, 10500], [10500, 10500]]);
    assert.equal(worker.blobRequests.length, 0); // the blob port was never reached
  } finally {
    await server.close();
  }
});

await test('without the option the same TypeError is blob.unknown, exactly as in sleap-app', async () => {
  const bytes = bytesOf(100);
  const { worker, server, identity } = await workerWithResult(bytes);
  try {
    const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    const client = await paired(worker, identity, { fetchImpl });
    const err = await rejects(client.fetchBlob('a'.repeat(64), 100), BLOB_UNKNOWN);
    assert.match(err.message, /^Failed to reach the blob server at http:\/\/127\.0\.0\.1:\d+\/blobs\/a{64}: Failed to fetch$/);
    assert.equal(worker.calls.filter((c) => c.method === 'fs.read').length, 0);
  } finally {
    await server.close();
  }
});

await test('the fallback is only for a network TypeError: HTTP 404, other errors and a hash mismatch do not trigger it', async () => {
  const bytes = bytesOf(2000);
  const { worker, server, identity } = await workerWithResult(bytes);
  try {
    const fsFallback = { path: '/data/out/preds.slp' };
    const sha = await (await import('./connect/fake-worker.mjs')).sha256Hex(bytes);
    const cases = [
      ['404', async () => new Response(null, { status: 404 }), BLOB_UNKNOWN],
      ['non-TypeError', async () => { throw new Error('socket hang up'); }, BLOB_UNKNOWN],
      ['hash mismatch', async () => new Response(bytesOf(2000, 99), { status: 200 }), BLOB_HASH_MISMATCH],
    ];
    for (const [name, fetchImpl, code] of cases) {
      const client = await paired(worker, identity, { fetchImpl });
      await rejects(client.fetchBlob(sha, 2000, { fsFallback }), code);
      assert.equal(worker.calls.filter((c) => c.method === 'fs.read').length, 0, name);
      client.close();
    }
  } finally {
    await server.close();
  }
});

await test('the fallback verifies too: wrong size is blob.incomplete, wrong content is blob.hash_mismatch', async () => {
  const bytes = bytesOf(3000);
  const { worker, server, identity } = await workerWithResult(bytes);
  try {
    const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    const client = await paired(worker, identity, { fetchImpl });
    const ref = await finishedJob(worker, client, bytes);
    const fsFallback = { path: '/data/out/preds.slp' };
    await rejects(client.fetchBlob(ref.sha256, ref.size + 1, { fsFallback }), BLOB_INCOMPLETE);
    // A different file at the output path than the blob the job reported.
    worker.addFile('/data/out/other.slp', bytesOf(3000, 1));
    await rejects(client.fetchBlob(ref.sha256, ref.size, { fsFallback: { path: '/data/out/other.slp' } }), BLOB_HASH_MISMATCH);
    // A path the worker does not have / does not share is an fs.* error, never a silent empty blob.
    await rejects(client.fetchBlob(ref.sha256, ref.size, { fsFallback: { path: '/data/out/gone.slp' } }), FS_NOT_FOUND);
    await rejects(client.fetchBlob(ref.sha256, ref.size, { fsFallback: { path: '/etc/shadow' } }), FS_FORBIDDEN);
  } finally {
    await server.close();
  }
});

await test('fs.read fallback pages the worker default (4 MiB) cap: a 9 MiB file is three reads', async () => {
  const bytes = bytesOf(9 * 1024 * 1024);
  const { worker, server, identity } = await workerWithResult(bytes);
  try {
    const client = await paired(worker, identity, { fetchImpl: async () => { throw new TypeError('x'); }, requestTimeoutMs: 20_000 });
    const ref = await worker.registerBlob(bytes);
    const before = worker.calls.filter((c) => c.method === 'fs.read').length;
    const got = await client.fetchBlob(ref.sha256, ref.size, { fsFallback: { path: '/data/out/preds.slp' } });
    assert.ok(equalBytes(got, bytes));
    assert.equal(worker.calls.filter((c) => c.method === 'fs.read').length - before, 3);
  } finally {
    await server.close();
  }
});

await test('a non-ws dial URL (iroh target) has no HTTP origin: TypeError -> fallback, else the raw TypeError as in sleap-app', async () => {
  const bytes = bytesOf(500);
  const worker = await FakeWorker.create({ files: { '/data/out/p.slp': bytes }, blobPort: 1234 });
  const identity = await newIdentity();
  const iroh = JSON.stringify({ nodeId: worker.nodeId });
  const mk = () => new WorkerClient({
    url: iroh, identity, requestTimeoutMs: 2000, createSocket: () => worker.createSocket(),
    fetchImpl: async () => { throw new Error('fetch must not be called without an origin'); },
  });
  const a = mk();
  await a.connect();
  await a.pairClaim(worker.mintTicket().secret);
  const ref = await worker.registerBlob(bytes);
  assert.ok(equalBytes(await a.fetchBlob(ref.sha256, ref.size, { fsFallback: { path: '/data/out/p.slp' } }), bytes));
  await assert.rejects(a.fetchBlob(ref.sha256, ref.size), (e) => e instanceof TypeError);
});

await test('a worker that announced no blob port is blob.unknown (no fallback is attempted)', async () => {
  const worker = await FakeWorker.create();
  const client = await paired(worker, await newIdentity());
  await rejects(client.fetchBlob('a'.repeat(64), 1, { fsFallback: { path: '/data/x' } }), BLOB_UNKNOWN);
});

// ── ManagedConnection over the real conversation ────────────────────

await test('ManagedConnection: drop -> reconnect via auth.prove on the same worker, status and backoff observable', async () => {
  const worker = await FakeWorker.create();
  const identity = await newIdentity();
  (await paired(worker, identity)).close();

  const statuses = [];
  const sleeps = [];
  const connected = [];
  const mc = new ManagedConnection({
    dial: async () => reconnected(worker, identity),
    preferredRoute: 'ws',
    canFallBackToIroh: false,
    onStatus: (s) => statuses.push(s),
    onConnected: (c) => connected.push(c),
    sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, 0)); },
  });
  const first = await mc.start();
  assert.deepEqual(statuses, ['connected']);
  worker.closeAll();
  for (let i = 0; i < 200 && connected.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(connected.length, 2);
  assert.notEqual(mc.client, first);
  assert.deepEqual(statuses, ['connected', 'reconnecting', 'connected']);
  assert.equal(await mc.client.jobsList().then((l) => l.length), 0);
  mc.stop();
});

await test('ManagedConnection: a device removed on the worker ends as unpaired (auth.untrusted), no retry loop', async () => {
  const worker = await FakeWorker.create();
  const identity = await newIdentity();
  (await paired(worker, identity)).close();
  worker.unpair(identity.nodeId);
  const statuses = [];
  const mc = new ManagedConnection({
    dial: async () => reconnected(worker, identity),
    preferredRoute: 'ws',
    canFallBackToIroh: false,
    onStatus: (s) => statuses.push(s),
    onConnected: () => {},
    sleep: async () => {},
  });
  await assert.rejects(mc.start(), (e) => e instanceof WorkerProtocolError && e.code === AUTH_UNTRUSTED);
  assert.deepEqual(statuses, ['unpaired']);
});

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
if (failed) process.exitCode = 1;
