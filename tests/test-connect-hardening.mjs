/**
 * Hardening tests for pose/connect/client.js and managed-connection.js: races and
 * error paths found by the review that the sleap-app ports do not cover (a real
 * WebSocket closes asynchronously, a listener can throw, a worker can stall or
 * send a malformed hello, stop() can land while the first dial is in flight).
 */
console.warn = () => {};
import { describe, it, expect, run } from './connect-test-utils.mjs';
import { WorkerClient } from '../pose/connect/client.js';
import { ManagedConnection } from '../pose/connect/managed-connection.js';
import { CLIENT_CLOSED, CLIENT_PROTO_MISMATCH, CLIENT_TIMEOUT, WorkerProtocolError } from '../pose/connect/errors.js';
import { getClientIdentity, setIdentityStorage, createMemoryAdapter } from '../pose/connect/identity.js';
import { FakeWorkerSocket } from './connect/fake-worker-socket.mjs';

async function freshIdentity() {
  setIdentityStorage(createMemoryAdapter());
  return getClientIdentity();
}
const mk = (identity, createSocket, o = {}) =>
  new WorkerClient({ url: 'ws://fake-worker', identity, createSocket, requestTimeoutMs: 200, ...o });
async function connected(identity, socket, o) {
  const c = mk(identity, () => socket, o);
  const p = c.connect();
  socket.simulateOpen();
  await p;
  return c;
}
async function rejection(promise) {
  try { await promise; } catch (e) { return e; }
  throw new Error('expected promise to reject');
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Closes the way a real WebSocket does: onclose arrives a task later. */
class AsyncCloseSocket extends FakeWorkerSocket {
  close() { this.readyState = 3; setTimeout(() => this.onclose?.(undefined), 5); }
}

describe('WorkerClient hardening', () => {
  it('one throwing job listener does not starve the others or break the socket handler', async () => {
    const id = await freshIdentity();
    const socket = new FakeWorkerSocket();
    const c = await connected(id, socket);
    const got = [];
    await c.jobsSubscribe('j1', 0, () => { throw new Error('boom'); }).catch(() => {});
    // The fake answers jobs.subscribe with an error; register the listeners directly instead.
    c._jobListeners.set('j1', new Set([() => { throw new Error('boom'); }, (e) => got.push(e.seq)]));
    socket.emitEvent('job.log', 'j1', 1, { line: 'x' }); // must not throw
    expect(got).toEqual([1]);
  });

  it('a synchronous createSocket failure rejects connect() and leaves the client closed', async () => {
    const id = await freshIdentity();
    const c = mk(id, () => { throw new SyntaxError('bad url'); });
    const err = await rejection(c.connect());
    expect(err).toBeInstanceOf(SyntaxError);
    expect(c.state).toBe('closed');
  });

  it('a stale socket closing late does not fail a later connect() on the same client', async () => {
    const id = await freshIdentity();
    const s1 = new AsyncCloseSocket();
    const s2 = new FakeWorkerSocket();
    const sockets = [s1, s2];
    const c = mk(id, () => sockets.shift());
    const p1 = c.connect(); s1.simulateOpen(); await p1;
    c.close();
    const p2 = c.connect();
    s2.simulateOpen();
    await tick(20); // s1's onclose lands here
    await p2;
    expect(c.state).toBe('unauthenticated');
  });

  it('a send that throws rejects the request and leaves nothing pending', async () => {
    const id = await freshIdentity();
    const socket = new FakeWorkerSocket();
    const c = await connected(id, socket);
    socket.send = () => { throw new Error('InvalidStateError'); };
    const err = await rejection(c.jobsList());
    expect(err.message).toContain('InvalidStateError');
    expect(c._pending.size).toBe(0);
  });

  it('connect() times out when the worker never answers hello', async () => {
    const id = await freshIdentity();
    const socket = new FakeWorkerSocket();
    socket.send = () => {}; // swallow the hello
    const c = mk(id, () => socket, { requestTimeoutMs: 50 });
    const closes = [];
    c.onClose((i) => closes.push(i));
    const p = c.connect();
    socket.simulateOpen();
    const err = await rejection(p);
    expect(err.code).toBe(CLIENT_TIMEOUT);
    expect(c.state).toBe('closed');
    expect(closes.length).toBe(1);
    expect(closes[0].intentional).toBe(false);
  });

  it('a hello with a malformed proto rejects with client.proto_mismatch instead of hanging', async () => {
    const id = await freshIdentity();
    const socket = new FakeWorkerSocket();
    socket.send = () => {};
    const c = mk(id, () => socket);
    const p = c.connect();
    socket.simulateOpen();
    socket.onmessage({ data: JSON.stringify({ v: 1, type: 'hello', proto: null, agent: {}, node_id: 'x', nonce: 'n' }) });
    const err = await rejection(p);
    expect(err.code).toBe(CLIENT_PROTO_MISMATCH);
  });

  it('unsubscribing the last listener of a job drops its entry', async () => {
    const id = await freshIdentity();
    const socket = new FakeWorkerSocket({ handleRequest: async () => ({ result: {} }) });
    const c = await connected(id, socket);
    const off = await c.jobsSubscribe('j9', 0, () => {});
    expect(c._jobListeners.has('j9')).toBe(true);
    off();
    expect(c._jobListeners.has('j9')).toBe(false);
  });
});

describe('ManagedConnection hardening', () => {
  it('stop() during the first dial closes the late client and never reports connected', async () => {
    const statuses = [];
    let release;
    const closed = [];
    const fakeClient = { onClose() {}, close() { closed.push(1); } };
    const mc = new ManagedConnection({
      preferredRoute: 'ws',
      canFallBackToIroh: false,
      dial: () => new Promise((r) => { release = () => r(fakeClient); }),
      onStatus: (s) => statuses.push(s),
      onConnected: () => statuses.push('onConnected'),
      sleep: async () => {},
    });
    const started = mc.start();
    mc.stop();
    release();
    const err = await rejection(started);
    expect(err).toBeInstanceOf(WorkerProtocolError);
    expect(err.code).toBe(CLIENT_CLOSED);
    expect(closed.length).toBe(1);
    expect(statuses).toEqual(['stopped']);
    expect(mc.client).toBe(null);
  });
});

await run();
