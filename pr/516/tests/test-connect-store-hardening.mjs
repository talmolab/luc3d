/**
 * Stress/bug-hunt regressions for pose/connect/store.js (P2 review): shared-storage robustness
 * (storage that throws, corrupt entries), the cross-window merge applying under same-tick
 * changes, and connection-lifecycle races (selection switched / worker forgotten mid-dial).
 * Each test failed before its fix.
 */
console.warn = () => {};
import { describe, it, expect, beforeEach, run, MemoryStorage, makeToast, FAKE_IDENTITY } from './connect/store-test-env.mjs';

let instN = 0;
/** A fresh store module instance (own singleton state) configured with `ls`. */
async function freshStore(ls, extra = {}) {
  const mod = await import(`../pose/connect/store.js?inst=${++instN}`);
  mod.configureConnect({ localStorage: ls, sessionStorage: new MemoryStorage(), notify: makeToast(), getClientIdentity: FAKE_IDENTITY, ...extra });
  mod.useConnectStore.persist.rehydrate();
  return mod;
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const W = (id, extra = {}) => ({ nodeId: id, label: `Worker ${id}`, addrs: [`ws://${id}:1`], pairedAt: '2026-01-01T00:00:00Z', ...extra });
const raw = (state) => JSON.stringify({ state, version: 3 });
const shared = (o = {}) => ({ pairedWorkers: [], trackedJobs: [], deviceName: null, lastSelectedWorkerId: null, ...o });

class SlowClient {
  static byNode = {};
  static delay = {};
  static instances = [];
  constructor(opts) { this.opts = opts; this.url = opts.url; this.closed = false; this.authenticated = false; this._cl = new Set(); SlowClient.instances.push(this); }
  async connect() {
    const d = SlowClient.delay[this.url];
    if (d) await d;
    this.peerNodeId = SlowClient.byNode[this.url];
  }
  async authProve() { this.authenticated = true; }
  async pairClaim() { this.authenticated = true; }
  async fsMounts() { return [{ name: this.url }]; }
  async jobsStatus() { throw new Error('nope'); }
  async clientsLeave() { return { removed: true }; }
  onClose(cb) { this._cl.add(cb); }
  close() { if (this.closed) return; this.closed = true; for (const cb of this._cl) cb({ intentional: true }); }
}

describe('store: storage robustness', () => {
  it('a storage whose setItem throws (quota / Safari private mode) never breaks an action', async () => {
    const ls = new MemoryStorage();
    ls.setItem('lucid-connect', raw(shared({ pairedWorkers: [W('a')] })));
    const mod = await freshStore(ls);
    ls.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    const s = mod.useConnectStore.getState();
    s.addPathRule('a', { local: '/x', worker: '/y' });
    expect(mod.useConnectStore.getState().pairedWorkers[0].pathRules.length).toBe(1);
    await s.setDeviceName('laptop');
    expect(mod.useConnectStore.getState().deviceName).toBe('laptop');
  });

  it('a storage whose getItem throws does not break importing the store', async () => {
    const ls = new MemoryStorage();
    ls.getItem = () => { throw new Error('SecurityError'); };
    const mod = await freshStore(ls);
    expect(mod.useConnectStore.getState().pairedWorkers.length).toBe(0);
    mod.useConnectStore.getState().addPathRule('x', { local: '/a', worker: '/b' }); // no throw
  });

  it('corrupt stored entries (null / non-object records) do not brick every later save', async () => {
    const ls = new MemoryStorage();
    ls.setItem('lucid-connect', raw(shared({ pairedWorkers: [null, 7, W('a')], trackedJobs: [3, null, { jobId: 'j', workerId: 'a', state: 'active', lastSeq: 1, seen: false }] })));
    const mod = await freshStore(ls);
    const st = mod.useConnectStore.getState();
    expect(st.pairedWorkers.map((w) => w.nodeId).join()).toBe('a');
    expect(st.trackedJobs.map((j) => j.jobId).join()).toBe('j');
    await st.setDeviceName('ok'); // would throw inside set() if the merge hit a null record
    expect(JSON.parse(ls.getItem('lucid-connect')).state.deviceName).toBe('ok');
    // a storage event carrying garbage is ignored, not thrown
    mod.syncConnectFromStorage(raw(shared({ pairedWorkers: [null], trackedJobs: [undefined] })));
    mod.syncConnectFromStorage('{"state":5,"version":3}');
    mod.syncConnectFromStorage('null');
  });
});

describe('store: cross-window merge', () => {
  it('a change made in the same tick as a merge that brought in another window\'s change is not lost', async () => {
    const ls = new MemoryStorage();
    ls.setItem('lucid-connect', raw(shared({ pairedWorkers: [W('a')] })));
    const mod = await freshStore(ls);
    // Another window pairs "b" (no storage event delivered yet).
    ls.setItem('lucid-connect', raw(shared({ pairedWorkers: [W('a'), W('b')] })));
    const st = mod.useConnectStore.getState();
    void st.setDeviceName('laptop'); // merge pulls "b" in (applied on a microtask)
    st.addPathRule('a', { local: '/x', worker: '/y' }); // same tick, before it is applied
    await settle();
    const now = mod.useConnectStore.getState();
    expect(now.pairedWorkers.map((w) => w.nodeId).join()).toBe('a,b');
    expect(now.pairedWorkers[0].pathRules?.length).toBe(1);
    expect(now.deviceName).toBe('laptop');
    const stored = JSON.parse(ls.getItem('lucid-connect')).state;
    expect(stored.pairedWorkers.map((w) => w.nodeId).join()).toBe('a,b');
    expect(stored.pairedWorkers[0].pathRules?.length).toBe(1);
  });
});

describe('store: connection lifecycle races', () => {
  beforeEach(() => { SlowClient.instances.length = 0; SlowClient.delay = {}; SlowClient.byNode = { 'ws://a:1': 'a', 'ws://b:1': 'b' }; });

  it('switching the selected worker mid-dial: the abandoned dial never overwrites the new selection', async () => {
    const ls = new MemoryStorage();
    ls.setItem('lucid-connect', raw(shared({ pairedWorkers: [W('a'), W('b')] })));
    const mod = await freshStore(ls, { WorkerClient: SlowClient });
    let release; SlowClient.delay['ws://a:1'] = new Promise((r) => { release = r; });
    const st = mod.useConnectStore.getState();
    const pa = st.connectToWorker('a').catch((e) => e);
    await settle();
    const statuses = [];
    mod.useConnectStore.subscribe((s) => statuses.push(`${s.selectedWorkerId}:${s.connectionStatus}`));
    await st.connectToWorker('b');
    release();
    await pa;
    await settle();
    const s = mod.useConnectStore.getState();
    expect(s.selectedWorkerId).toBe('b');
    expect(s.connectionStatus).toBe('connected');
    expect(s._client.url).toBe('ws://b:1');
    expect(statuses.filter((x) => x.startsWith('b:error')).length).toBe(0);
    mod.__resetConnectState();
  });

  it('forgetting a worker while it is connecting leaves no connected state for it', async () => {
    const ls = new MemoryStorage();
    ls.setItem('lucid-connect', raw(shared({ pairedWorkers: [W('a')] })));
    const mod = await freshStore(ls, { WorkerClient: SlowClient });
    let release; SlowClient.delay['ws://a:1'] = new Promise((r) => { release = r; });
    const st = mod.useConnectStore.getState();
    const pa = st.connectToWorker('a').catch((e) => e);
    await settle();
    const pf = st.forgetWorker('a');
    release();
    await pa; await pf; await settle();
    const s = mod.useConnectStore.getState();
    expect(s.pairedWorkers.length).toBe(0);
    expect(s.selectedWorkerId).toBe(null);
    expect(s.connectionStatus === 'connected').toBe(false);
    expect(s._client).toBe(null);
    expect(Object.keys(s.connections).length).toBe(0);
    mod.__resetConnectState();
  });
});


class JobClient extends SlowClient {
  constructor(o) { super(o); this.subs = new Map(); this.subscribeCalls = []; this.unsubscribed = 0; this.subscribeError = null; this.n = 0; }
  async jobsSubmit() { return { jobId: `${this.url}#j${++JobClient.seq}` }; }
  async jobsSubscribe(jobId, since, cb) {
    this.subscribeCalls.push([jobId, since]);
    if (this.subscribeError) throw this.subscribeError;
    this.subs.set(jobId, cb);
    if (this.onSubscribe) this.onSubscribe(jobId, cb);
    return () => { this.unsubscribed++; if (this.subs.get(jobId) === cb) this.subs.delete(jobId); };
  }
  emit(jobId, seq, topic, data) { this.subs.get(jobId)?.({ topic, jobId, seq, data }); }
}
JobClient.seq = 0;
const SPEC = { type: 'track', label: 'x' };
const jobStore = async (extra = {}) => {
  const ls = new MemoryStorage();
  ls.setItem('lucid-connect', raw(shared({ pairedWorkers: [W('a')] })));
  const mod = await freshStore(ls, { WorkerClient: JobClient, ...extra });
  SlowClient.byNode = { 'ws://a:1': 'a' };
  return { mod, ls };
};
const last = () => SlowClient.instances[SlowClient.instances.length - 1];

describe('store: job subscriptions', () => {
  beforeEach(() => { SlowClient.instances.length = 0; SlowClient.delay = {}; });

  it('Forget drops the worker\'s live subscriptions and rejects a waiting submitJob', async () => {
    const { mod } = await jobStore();
    const st = mod.useConnectStore.getState();
    await st.connectToWorker('a');
    const c1 = last();
    const waiting = st.submitJob(SPEC, () => {}).catch((e) => e);
    await settle();
    const [watched] = await st.submitJobsOn('a', SPEC, { source: 'window' });
    expect(c1.subs.size).toBe(2);
    await st.forgetWorker('a');
    expect(c1.subs.size).toBe(0);
    const r = await waiting;
    expect(r instanceof Error).toBe(true);
    // Re-pairing the same worker must not re-attach the forgotten jobs.
    mod.useConnectStore.setState({ pairedWorkers: [W('a')] });
    await mod.useConnectStore.getState().connectToWorker('a');
    expect(last().subscribeCalls.length).toBe(0);
    mod.__resetConnectState();
  });

  it('a resubscribe that fails is handled, not an unhandled rejection', async () => {
    const { mod } = await jobStore();
    const st = mod.useConnectStore.getState();
    await st.connectToWorker('a');
    await st.submitJobsOn('a', SPEC, { source: 'window' });
    const unhandled = [];
    const h = (e) => unhandled.push(e);
    process.on('unhandledRejection', h);
    const fresh = new JobClient({ url: 'ws://a:1' });
    fresh.subscribeError = new Error('socket closed');
    mod.resubscribeWorker('a', fresh);
    await settle(); await settle();
    process.off('unhandledRejection', h);
    expect(unhandled.length).toBe(0);
    mod.__resetConnectState();
  });

  it('a first subscribe that fails on a dropped connection is retried when the worker reconnects', async () => {
    const { mod } = await jobStore();
    const st = mod.useConnectStore.getState();
    await st.connectToWorker('a');
    const c = last();
    c.subscribeError = new (await import('../pose/connect/errors.js')).WorkerProtocolError('client.closed', 'Not connected');
    const [jobId] = await st.submitJobsOn('a', SPEC, { source: 'window' });
    await settle();
    const fresh = new JobClient({ url: 'ws://a:1' });
    mod.resubscribeWorker('a', fresh);
    await settle();
    expect(fresh.subscribeCalls.length).toBe(1);
    expect(fresh.subscribeCalls[0][0]).toBe(jobId);
    mod.__resetConnectState();
  });

  it('a terminal event replayed while subscribing leaves no live listener behind', async () => {
    const { mod } = await jobStore();
    const st = mod.useConnectStore.getState();
    await st.connectToWorker('a');
    const c = last();
    c.onSubscribe = (jobId, cb) => cb({ topic: 'job.status', jobId, seq: 1, data: { state: 'completed' } });
    const [jobId] = await st.submitJobsOn('a', SPEC, { source: 'window' });
    await settle();
    expect(mod.useConnectStore.getState().trackedJobs.find((j) => j.jobId === jobId).state).toBe('completed');
    expect(c.subs.size).toBe(0);
    mod.__resetConnectState();
  });
});

describe('mini-store persist: hydration failures', () => {
  it('a migrate that throws leaves the initial state (as zustand), and the store still works', async () => {
    const { createStore, persist } = await import('../pose/connect/mini-store.js');
    const prev = console.error; console.error = () => {};
    const mem = new Map([['k', { state: { n: 5 }, version: 1 }]]);
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
    const store = createStore(persist(() => ({ n: 0 }), { name: 'k', version: 2, storage, migrate: () => { throw new Error('bad'); } }));
    console.error = prev;
    expect(store.getState().n).toBe(0);
    expect(store.persist.hasHydrated()).toBe(true);
    store.setState({ n: 1 });
    expect(mem.get('k').state.n).toBe(1);
  });
});

await run();
