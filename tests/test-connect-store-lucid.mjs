/**
 * Tests for what pose/connect/store.js adds or injects relative to sleap-app's connectStore:
 * default deps (agent, no-op notify, storage looked up at call time), `pairWithCode` (readCodeInfo ->
 * planPairing -> pairWithTicket, as PairWorkerForm.tsx does), the iroh route through the registered
 * socket factory, LUCID's `{sessionId, camera, projectTag}` job tags (incl. on chained jobs),
 * `fetchResultBlob` options, `installConnectStorageSync`, the injected device-name adapter.
 */
console.warn = () => {};
import { describe, it, expect, beforeEach, run, MemoryStorage, makeToast, spy } from './connect/store-test-env.mjs';
import { FakeWorker } from './connect/fake-worker.mjs';
import { WorkerClient } from '../pose/connect/client.js';
import { setIdentityStorage, createMemoryAdapter, _resetClientIdentityCache } from '../pose/connect/identity.js';
import { registerIrohSocketFactory, decodeIrohDialUrl } from '../pose/connect/transport.js';
import { NOT_A_CODE } from '../pose/connect/pairing-plan.js';
import {
  useConnectStore, connectStore, configureConnect, agentInfo, readCodeInfo, pathRulesFor, resolveDeviceName,
  installConnectStorageSync, syncConnectFromStorage, __resetConnectState, __setManagedDeps,
  CONNECT_STORAGE_KEY, SELECTED_WORKER_SESSION_KEY,
} from '../pose/connect/store.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 4000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await tick(2);
  }
}
const WS = 'ws://127.0.0.1:9631';
const TRACK = { type: 'track', data_path: '/data/a.slp', model_paths: ['/data/m'] };

let worker, local, session, toast, urls;
function backed(w) {
  return class extends WorkerClient {
    constructor(opts) {
      super({ ...opts, createSocket: opts.createSocket ? (u) => { urls.push(u); opts.createSocket(u); return w.createSocket(); } : () => w.createSocket() });
    }
  };
}

describe('Connect store: defaults and injection', () => {
  beforeEach(async () => {
    __resetConnectState();
    registerIrohSocketFactory(null);
    setIdentityStorage(createMemoryAdapter());
    _resetClientIdentityCache();
    urls = [];
    worker = await FakeWorker.create({ files: { '/data/a.slp': 'x' } });
    local = new MemoryStorage(); session = new MemoryStorage(); toast = makeToast();
    configureConnect({ WorkerClient: backed(worker), localStorage: local, sessionStorage: session, notify: toast });
    __setManagedDeps({ sleep: () => tick(1) });
    useConnectStore.setState({
      pairedWorkers: [], selectedWorkerId: null, lastSelectedWorkerId: null, trackedJobs: [], deviceName: null,
      connectionStatus: 'disconnected', connectionError: null, workerMounts: [], reattachableJob: null,
      activeTransport: null, connections: {}, workerErrors: {}, workerInfo: {}, _client: null,
    });
  });

  it('exports the singleton under both names and the keys the helpers define', () => {
    expect(connectStore).toBe(useConnectStore);
    expect(CONNECT_STORAGE_KEY).toBe('lucid-connect');
    expect(SELECTED_WORKER_SESSION_KEY).toBe('lucid-connect-selected');
  });

  it('agentInfo is lucid / dev / web by default and follows appVersion and platform', () => {
    configureConnect(null);
    expect(agentInfo()).toEqual({ name: 'lucid', version: 'dev', platform: 'web' });
    configureConnect({ appVersion: '1.2.3', platform: 'tauri' });
    expect(agentInfo()).toEqual({ name: 'lucid', version: '1.2.3', platform: 'tauri' });
  });

  it('with no storage anywhere (Node has no localStorage) state changes persist nothing and throw nothing', () => {
    const before = local.getItem('lucid-connect');
    configureConnect({ localStorage: null, sessionStorage: null });
    useConnectStore.setState({ pairedWorkers: [{ nodeId: 'w', label: 'W', addrs: [], pairedAt: 'x' }] });
    useConnectStore.setState({ selectedWorkerId: 'w' });
    expect(local.getItem('lucid-connect')).toBe(before);
    expect(session.getItem('lucid-connect-selected')).toBeNull();
  });

  it('storage is read through the injected object: a save lands in localStorage, the selection in sessionStorage', async () => {
    useConnectStore.setState({ pairedWorkers: [{ nodeId: 'w', label: 'W', addrs: [], pairedAt: 'x' }] });
    expect(JSON.parse(local.getItem('lucid-connect')).state.pairedWorkers[0].nodeId).toBe('w');
    useConnectStore.setState({ selectedWorkerId: 'w' });
    expect(session.getItem('lucid-connect-selected')).toBe('w');
    expect(useConnectStore.getState().lastSelectedWorkerId).toBe('w');
  });

  it('rehydrate() restores the shared slice and this window\'s selection after the storages are injected', () => {
    const w = { nodeId: 'w9', label: 'W9', addrs: [WS], pairedAt: 'x' };
    local.setItem('lucid-connect', JSON.stringify({ state: { pairedWorkers: [w], trackedJobs: [], deviceName: 'Bench', lastSelectedWorkerId: 'w9' }, version: 3 }));
    session.setItem('lucid-connect-selected', 'w9');
    useConnectStore.persist.rehydrate();
    expect(useConnectStore.getState()).toMatchObject({ deviceName: 'Bench', selectedWorkerId: 'w9' });
    session.setItem('lucid-connect-selected', '');
    useConnectStore.persist.rehydrate();
    expect(useConnectStore.getState().selectedWorkerId).toBeNull(); // "" = deliberately none, beats lastSelectedWorkerId
  });

  it('the default device name follows the injected computerName adapter, else the browser name; a chosen name wins', async () => {
    configureConnect({ computerName: async () => 'Lab PC' });
    expect(await resolveDeviceName()).toBe('Lab PC');
    useConnectStore.setState({ deviceName: 'Mine' });
    expect(await resolveDeviceName()).toBe('Mine');
  });

  it('default notify is a no-op: a finished job updates state without a notifier', async () => {
    configureConnect({ notify: undefined });
    configureConnect(null);
    configureConnect({ WorkerClient: backed(worker), localStorage: local, sessionStorage: session });
    await useConnectStore.getState().pairWithCode(await worker.mintPairCode({ addrs: [WS] }));
    const [id] = await useConnectStore.getState().submitJobsOn(worker.nodeId, TRACK, { source: 'window' });
    await waitFor(() => worker.calls.some((c) => c.method === 'jobs.subscribe'), 'subscribe');
    await worker.completeJob(id, { predictions: new Uint8Array([1]) });
    await waitFor(() => useConnectStore.getState().trackedJobs[0].state === 'completed', 'completed');
  });

  it('the toast action calls the injected openConnectWindow', async () => {
    const open = spy();
    configureConnect({ openConnectWindow: open });
    await useConnectStore.getState().pairWithCode(await worker.mintPairCode({ addrs: [WS] }));
    const [id] = await useConnectStore.getState().submitJobsOn(worker.nodeId, TRACK, { source: 'window' });
    await waitFor(() => worker.calls.some((c) => c.method === 'jobs.subscribe'), 'subscribe');
    worker.failJob(id, 'boom');
    await waitFor(() => toast.error.mock.calls.length === 1, 'failure notification');
    const [msg, opts] = toast.error.mock.calls[0];
    expect(msg).toBe(`Inference on Worker ${worker.nodeId.slice(0, 8)} failed`);
    expect(opts.description).toBe('boom');
    expect(opts.action.label).toBe('Open');
    opts.action.onClick();
    expect(open.mock.calls).toHaveLength(1);
    expect(useConnectStore.getState().trackedJobs[0]).toMatchObject({ state: 'failed', error: 'boom' });
  });
});

describe('pairWithCode / readCodeInfo', () => {
  beforeEach(async () => {
    __resetConnectState();
    registerIrohSocketFactory(null);
    setIdentityStorage(createMemoryAdapter());
    _resetClientIdentityCache();
    urls = [];
    worker = await FakeWorker.create({ files: { '/data/a.slp': 'x' } });
    local = new MemoryStorage(); session = new MemoryStorage(); toast = makeToast();
    configureConnect({ WorkerClient: backed(worker), localStorage: local, sessionStorage: session, notify: toast });
    __setManagedDeps({ sleep: () => tick(1) });
    useConnectStore.setState({ pairedWorkers: [], selectedWorkerId: null, trackedJobs: [], connections: {}, _client: null, connectionStatus: 'disconnected' });
  });

  it('readCodeInfo maps a decoded code to {expiresAt, addrs, hasRelay} and a JSON ticket likewise; junk is null', async () => {
    const code = await worker.mintPairCode({ addrs: [WS], relayUrl: 'https://use1-1.relay.n0.iroh.link./', ttlSecs: 600 });
    const info = await readCodeInfo(code);
    expect(info.addrs).toEqual([WS]);
    expect(info.hasRelay).toBe(true);
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);
    const noRelay = await readCodeInfo(await worker.mintPairCode({ addrs: [WS] }));
    expect(noRelay.hasRelay).toBe(false);
    expect(await readCodeInfo(JSON.stringify({ addrs: ['ws://x:1'], expires_at: 5, iroh: { relay_url: 'https://r' } })))
      .toEqual({ expiresAt: 5, addrs: ['ws://x:1'], hasRelay: true });
    expect(await readCodeInfo(JSON.stringify({ addrs: ['ws://x:1'] }))).toEqual({ expiresAt: undefined, addrs: ['ws://x:1'], hasRelay: false });
    expect(await readCodeInfo('not a code')).toBeNull();
    expect(await readCodeInfo('sleap1garbage')).toBeNull();
  });

  it('refuses non-codes, expired codes and a relay-only code in a runtime with no iroh, without dialing', async () => {
    const st = useConnectStore.getState();
    await expect(st.pairWithCode('nope')).rejects.toThrow(NOT_A_CODE.slice(0, 20));
    const expired = await worker.mintPairCode({ addrs: [WS], expiresAt: 1700000000 });
    await expect(st.pairWithCode(expired)).rejects.toThrow(/This code expired .* min ago/);
    const relayOnly = await worker.mintPairCode({ relayUrl: 'https://use1-1.relay.n0.iroh.link./' });
    await expect(st.pairWithCode(relayOnly)).rejects.toThrow(/web version can only reach workers on your network/);
    expect(worker.calls.length).toBe(0);
    expect(useConnectStore.getState().connectionStatus).toBe('disconnected');
  });

  it('pairs over ws for an address-only code; an address typed under Advanced wins', async () => {
    await useConnectStore.getState().pairWithCode(await worker.mintPairCode({ addrs: ['ws://10.0.0.5:9631'] }), WS);
    const w = useConnectStore.getState().pairedWorkers[0];
    expect(w.addrs[0]).toBe(WS);
    expect(w.transport).toBeUndefined();
    expect(useConnectStore.getState().activeTransport).toBe('ws');
  });

  it('with an iroh factory registered a code that has a relay is dialed over iroh through that factory', async () => {
    const made = [];
    registerIrohSocketFactory((u) => { made.push(u); return worker.createSocket(); });
    configureConnect({ WorkerClient: WorkerClient });
    class IrohBacked extends WorkerClient {
      constructor(opts) { super({ ...opts, createSocket: opts.createSocket ? (u) => opts.createSocket(u) : () => worker.createSocket() }); }
    }
    configureConnect({ WorkerClient: IrohBacked });
    await useConnectStore.getState().pairWithCode(await worker.mintPairCode({ addrs: [WS], relayUrl: 'https://use1-1.relay.n0.iroh.link./' }));
    const s = useConnectStore.getState();
    expect(s.activeTransport).toBe('iroh');
    expect(s.pairedWorkers[0].transport).toBe('iroh');
    expect(made.length).toBeGreaterThan(0);
    expect(decodeIrohDialUrl(made[0]).nodeId).toBe(worker.nodeId);
    registerIrohSocketFactory(null);
  });
});

describe('LUCID job tags', () => {
  beforeEach(async () => {
    __resetConnectState();
    registerIrohSocketFactory(null);
    setIdentityStorage(createMemoryAdapter());
    _resetClientIdentityCache();
    urls = [];
    worker = await FakeWorker.create({ files: { '/data/a.slp': 'x' } });
    local = new MemoryStorage(); session = new MemoryStorage(); toast = makeToast();
    configureConnect({ WorkerClient: backed(worker), localStorage: local, sessionStorage: session, notify: toast });
    __setManagedDeps({ sleep: () => tick(1) });
    useConnectStore.setState({ pairedWorkers: [], selectedWorkerId: null, trackedJobs: [], connections: {}, _client: null, connectionStatus: 'disconnected' });
    await useConnectStore.getState().pairWithCode(await worker.mintPairCode({ addrs: [WS] }));
  });

  it('one job per (session, camera): each tracked entry carries its own tag; untagged entries have no tag keys', async () => {
    const st = useConnectStore.getState();
    const [a] = await st.submitJobsOn(worker.nodeId, TRACK, { source: 'window', sessionId: 'S1', camera: 'front', projectTag: 'p1' });
    const [b] = await st.submitJobsOn(worker.nodeId, TRACK, { source: 'window', sessionId: 'S1', camera: 'back', projectTag: 'p1' });
    const [c] = await st.submitJobsOn(worker.nodeId, TRACK, { source: 'worker-file' });
    const jobs = useConnectStore.getState().trackedJobs;
    expect(jobs.find((j) => j.jobId === a)).toMatchObject({ sessionId: 'S1', camera: 'front', projectTag: 'p1' });
    expect(jobs.find((j) => j.jobId === b)).toMatchObject({ sessionId: 'S1', camera: 'back', projectTag: 'p1' });
    const untagged = jobs.find((j) => j.jobId === c);
    expect('sessionId' in untagged || 'camera' in untagged || 'projectTag' in untagged).toBe(false);
    // Tags survive the persisted copy.
    const saved = JSON.parse(local.getItem('lucid-connect')).state.trackedJobs;
    expect(saved.find((j) => j.jobId === a).camera).toBe('front');
  });

  it('submitJob (the awaited path) tags its entry too', async () => {
    const p = useConnectStore.getState().submitJob(TRACK, () => {}, { sessionId: 'S9', camera: 'top', projectTag: 'p9' });
    await waitFor(() => useConnectStore.getState().trackedJobs.length === 1, 'tracked');
    const job = useConnectStore.getState().trackedJobs[0];
    expect(job).toMatchObject({ sessionId: 'S9', camera: 'top', projectTag: 'p9' });
    await waitFor(() => worker.calls.some((c) => c.method === 'jobs.subscribe'), 'subscribe');
    await worker.completeJob(job.jobId, { predictions: new Uint8Array([1]) });
    expect((await p).success).toBe(true);
    expect(useConnectStore.getState().trackedJobs[0]).toMatchObject({ state: 'completed', seen: true, camera: 'top' });
  });

  it('a job the worker chains from a tagged job inherits the tag', async () => {
    const [id] = await useConnectStore.getState().submitJobsOn(worker.nodeId, TRACK, { source: 'window', sessionId: 'S4', camera: 'side', projectTag: 'p4' });
    worker.addJob({ jobId: 'chained-1', state: 'queued', spec: TRACK });
    await waitFor(() => worker.calls.some((c) => c.method === 'jobs.subscribe'), 'subscribe');
    await worker.emitResult(id, { extra: { chained_job_ids: ['chained-1'] } });
    await waitFor(() => useConnectStore.getState().trackedJobs.some((j) => j.jobId === 'chained-1'), 'chained tracked');
    expect(useConnectStore.getState().trackedJobs.find((j) => j.jobId === 'chained-1')).toMatchObject({
      kind: 'track', label: 'Inference', source: 'window', sessionId: 'S4', camera: 'side', projectTag: 'p4', state: 'active',
    });
  });

  it('pathRulesFor reads a worker\'s rules and is [] for an unknown or null worker', () => {
    expect(pathRulesFor(null)).toEqual([]);
    expect(pathRulesFor('nobody')).toEqual([]);
    useConnectStore.getState().addPathRule(worker.nodeId, { local: '/Users/me', worker: '/data' });
    expect(pathRulesFor(worker.nodeId)).toEqual([{ local: '/Users/me', worker: '/data' }]);
  });

  it('fetchResultBlob forwards options (fsFallback) to the client, and not at all when none are given', async () => {
    const calls = [];
    useConnectStore.setState({ _client: { authenticated: true, fetchBlob: async (...a) => { calls.push(a); return new Uint8Array(1); } }, activeTransport: 'ws' });
    await useConnectStore.getState().fetchResultBlob({ sha256: 'h', size: 3 });
    await useConnectStore.getState().fetchResultBlob({ sha256: 'h', size: 3 }, { fsFallback: { path: '/data/p.slp' } });
    expect(calls).toEqual([['h', 3], ['h', 3, { fsFallback: { path: '/data/p.slp' } }]]);
    useConnectStore.setState({ _client: null });
  });
});

describe('installConnectStorageSync', () => {
  beforeEach(() => {
    __resetConnectState();
    local = new MemoryStorage(); session = new MemoryStorage();
    configureConnect({ localStorage: local, sessionStorage: session });
    useConnectStore.setState({ pairedWorkers: [{ nodeId: 'A', label: 'A', addrs: [], pairedAt: 'x' }], trackedJobs: [], selectedWorkerId: null, lastSelectedWorkerId: null, deviceName: null });
  });

  const stored = (workers) => JSON.stringify({ state: { pairedWorkers: workers, trackedJobs: [], deviceName: null, lastSelectedWorkerId: null }, version: 3 });

  it('applies another window\'s save from a `storage` event for our key, ignores other keys, and can be removed', () => {
    const listeners = new Map();
    const target = {
      addEventListener: (t, f) => listeners.set(t, f),
      removeEventListener: (t) => listeners.delete(t),
    };
    const off = installConnectStorageSync(target);
    const B = { nodeId: 'B', label: 'B', addrs: [], pairedAt: 'x' };
    const A = { nodeId: 'A', label: 'A', addrs: [], pairedAt: 'x' };
    listeners.get('storage')({ key: 'something-else', newValue: stored([A, B]) });
    expect(useConnectStore.getState().pairedWorkers.map((w) => w.nodeId)).toEqual(['A']);
    listeners.get('storage')({ key: 'lucid-connect', newValue: stored([A, B]) });
    expect(useConnectStore.getState().pairedWorkers.map((w) => w.nodeId)).toEqual(['A', 'B']);
    off();
    expect(listeners.has('storage')).toBe(false);
  });

  it('is a no-op without a window, and syncConnectFromStorage ignores unparseable values', () => {
    expect(typeof installConnectStorageSync(undefined)).toBe('function');
    installConnectStorageSync(undefined)();
    syncConnectFromStorage('{nope');
    syncConnectFromStorage(null);
    expect(useConnectStore.getState().pairedWorkers.map((w) => w.nodeId)).toEqual(['A']);
  });
});

await run();
