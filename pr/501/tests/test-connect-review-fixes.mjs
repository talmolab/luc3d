/**
 * P2 review fixes for pose/connect: job-stream resume/stop races (B2), mini-store `subscribeSelector` /
 * `shallowEqual`, `planPairingForText`, `readCodeInfo` single definition, LUCID batch inference
 * (`submitJobsOn` run/label, unfetched-job retention in `capTrackedJobs`, `markJobFetched`, `mergeJob`
 * `fetchedAt`, `fetchResultBlobOn`), the `watchTrackedJob` lastSeq throttle and the client naming helpers.
 */
console.warn = () => {};
import { describe, it, expect, beforeEach, run, MemoryStorage, makeToast } from './connect/store-test-env.mjs';
import { FakeWorker } from './connect/fake-worker.mjs';
import { WorkerClient } from '../pose/connect/client.js';
import { setIdentityStorage, createMemoryAdapter, _resetClientIdentityCache } from '../pose/connect/identity.js';
import { registerIrohSocketFactory } from '../pose/connect/transport.js';
import { NOT_A_CODE } from '../pose/connect/pairing-plan.js';
import { createJobStream } from '../pose/connect/job-stream.js';
import { createStore, shallowEqual } from '../pose/connect/mini-store.js';
import { capTrackedJobs, MAX_HELD_TAGGED_JOBS } from '../pose/connect/store-helpers.js';
import { mergeShared } from '../pose/connect/connect-sync.js';
import { clientDisplayName, clientAgentLabel, readCodeInfo as helperReadCodeInfo } from '../pose/connect/worker-ui-helpers.js';
import {
  useConnectStore, configureConnect, planPairingForText, readCodeInfo, __resetConnectState, __setManagedDeps,
} from '../pose/connect/store.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 4000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await tick(2);
  }
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

describe('job-stream: resume/stop are race-free (B2)', () => {
  function gatedClient() {
    const gates = [];
    return {
      gates, subs: 0, unsubs: 0,
      async jobsSubscribe() {
        const g = deferred();
        gates.push(g);
        await g.promise;
        this.subs++;
        return () => { this.unsubs++; };
      },
    };
  }
  function timers() {
    const live = new Set();
    let n = 0;
    return { live, setIntervalImpl: () => { const h = ++n; live.add(h); return h; }, clearIntervalImpl: (h) => live.delete(h) };
  }

  it('resume() while the first subscribe is in flight leaves exactly one subscription and one interval', async () => {
    const c = gatedClient(); const t = timers();
    const stream = createJobStream(c, 'j', { setIntervalImpl: t.setIntervalImpl, clearIntervalImpl: t.clearIntervalImpl });
    await tick();
    const resumed = stream.resume();
    await tick();
    expect(c.gates).toHaveLength(2);
    c.gates[1].resolve(); await tick();
    c.gates[0].resolve(); // the superseded one lands last
    await resumed; await stream.ready;
    expect(c.subs - c.unsubs).toBe(1); // the stale one unsubscribed itself
    expect(t.live.size).toBe(1);
    stream.stop();
    expect(c.subs - c.unsubs).toBe(0);
    expect(t.live.size).toBe(0);
  });

  it('stop() while a subscribe is in flight tears it down when it lands', async () => {
    const c = gatedClient(); const t = timers();
    const stream = createJobStream(c, 'j', { setIntervalImpl: t.setIntervalImpl, clearIntervalImpl: t.clearIntervalImpl });
    await tick();
    stream.stop();
    c.gates[0].resolve();
    await stream.ready;
    expect(c.subs - c.unsubs).toBe(0);
    expect(t.live.size).toBe(0);
  });

  it('a superseded subscribe delivers no events into the buffer', async () => {
    let handlers = [];
    const client = { async jobsSubscribe(_j, _s, on) { handlers.push(on); return () => {}; } };
    const stream = createJobStream(client, 'j', { setIntervalImpl: () => 1, clearIntervalImpl: () => {} });
    await stream.ready;
    await stream.resume();
    handlers[0]({ topic: 'job.log', seq: 1, jobId: 'j', data: { line: 'stale' } });
    handlers[1]({ topic: 'job.log', seq: 2, jobId: 'j', data: { line: 'fresh' } });
    await stream.resume();
    expect(stream.getState().log).toEqual(['fresh']);
    stream.stop();
  });
});

describe('mini-store: subscribeSelector and shallowEqual', () => {
  it('fires only when the selection changes, with (selected, prevSelected)', () => {
    const s = createStore(() => ({ a: 1, b: 1 }));
    const seen = [];
    const off = s.subscribeSelector((st) => st.a, (v, p) => seen.push([v, p]));
    s.setState({ b: 2 });
    expect(seen).toEqual([]);
    s.setState({ a: 5 });
    expect(seen).toEqual([[5, 1]]);
    off();
    s.setState({ a: 6 });
    expect(seen).toHaveLength(1);
  });

  it('uses the equality function (shallowEqual ignores a fresh array of the same items)', () => {
    const s = createStore(() => ({ xs: [1, 2], n: 0 }));
    const seen = [];
    s.subscribeSelector((st) => st.xs, (v) => seen.push(v), shallowEqual);
    s.setState({ xs: [1, 2] });
    expect(seen).toHaveLength(0);
    s.setState({ xs: [1, 3] });
    expect(seen).toHaveLength(1);
    const plain = [];
    s.subscribeSelector((st) => st.xs, (v) => plain.push(v));
    s.setState({ xs: [1, 3] });
    expect(plain).toHaveLength(1); // Object.is: a new array counts
  });

  it('shallowEqual compares keys and values one level deep', () => {
    expect(shallowEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallowEqual({ a: {} }, { a: {} })).toBe(false);
    expect(shallowEqual([1], { 0: 1 })).toBe(false);
    expect(shallowEqual(null, null)).toBe(true);
    expect(shallowEqual(1, 2)).toBe(false);
  });
});

const job = (id, extra = {}) => ({
  workerId: 'w', jobId: id, lastSeq: 0, kind: 'track', label: 'Inference', source: 'window', state: 'completed',
  seen: true, submittedAt: 0, ...extra,
});

describe('capTrackedJobs: unfetched tagged results are kept', () => {
  it('keeps completed, unfetched, tagged jobs past 50; evicts the oldest of the rest', () => {
    const tagged = Array.from({ length: 56 }, (_, i) => job(`t${i}`, { sessionId: 's', camera: `c${i}`, fetchedAt: null, submittedAt: 100 + i }));
    const plain = Array.from({ length: 10 }, (_, i) => job(`p${i}`, { submittedAt: i }));
    const out = capTrackedJobs([...plain, ...tagged]);
    expect(out.filter((j) => j.jobId.startsWith('t'))).toHaveLength(56);
    expect(out.filter((j) => j.jobId.startsWith('p'))).toHaveLength(0);
  });

  it('a fetched tagged job is evictable again, oldest first; active jobs stay', () => {
    const jobs = [
      job('fetched-old', { sessionId: 's', fetchedAt: 5, submittedAt: 1 }),
      ...Array.from({ length: 50 }, (_, i) => job(`u${i}`, { sessionId: 's', camera: 'c', fetchedAt: null, submittedAt: 10 + i })),
      job('act', { state: 'active', sessionId: 's', submittedAt: 0 }),
    ];
    const out = capTrackedJobs(jobs);
    expect(out.some((j) => j.jobId === 'fetched-old')).toBe(false);
    expect(out.some((j) => j.jobId === 'act')).toBe(true);
    expect(out).toHaveLength(51);
  });

  it('untagged jobs behave exactly as in sleap-app (fetchedAt on an untagged job is irrelevant)', () => {
    const jobs = Array.from({ length: 55 }, (_, i) => job(`d${i}`, { submittedAt: i }));
    const out = capTrackedJobs(jobs);
    expect(out).toHaveLength(50);
    expect(out[0].jobId).toBe('d5');
  });

  it('the hard ceiling evicts the oldest tagged unfetched job', () => {
    const jobs = Array.from({ length: MAX_HELD_TAGGED_JOBS + 3 }, (_, i) => job(`t${i}`, { camera: 'c', fetchedAt: null, submittedAt: i }));
    const out = capTrackedJobs(jobs);
    expect(out).toHaveLength(MAX_HELD_TAGGED_JOBS);
    expect(out[0].jobId).toBe('t3');
  });
});

describe('connect-sync mergeJob carries fetchedAt', () => {
  const base = { pairedWorkers: [], trackedJobs: [job('j', { sessionId: 's', fetchedAt: null })], deviceName: null, lastSelectedWorkerId: null };
  const mk = (jobs) => ({ ...base, trackedJobs: jobs });
  it('a fetchedAt set in the other window survives when both changed the job', () => {
    const mine = mk([job('j', { sessionId: 's', fetchedAt: null, lastSeq: 9 })]);
    const theirs = mk([job('j', { sessionId: 's', fetchedAt: 500, lastSeq: 3 })]);
    const merged = mergeShared(base, mine, theirs).trackedJobs[0];
    expect(merged.fetchedAt).toBe(500);
    expect(merged.lastSeq).toBe(9);
  });
  it('the latest non-null wins; jobs without one gain no key', () => {
    const a = mk([job('j', { sessionId: 's', fetchedAt: 100, lastSeq: 1 })]);
    const b = mk([job('j', { sessionId: 's', fetchedAt: 700, lastSeq: 2 })]);
    expect(mergeShared(base, a, b).trackedJobs[0].fetchedAt).toBe(700);
    const x = mk([job('j', { lastSeq: 1 })]); const y = mk([job('j', { lastSeq: 2 })]);
    expect('fetchedAt' in mergeShared(mk([job('j')]), x, y).trackedJobs[0]).toBe(false);
  });
});

describe('connect-sync mergeJob carries mergeMode', () => {
  const base = { pairedWorkers: [], trackedJobs: [job('j', { sessionId: 's' })], deviceName: null, lastSelectedWorkerId: null };
  const mk = (jobs) => ({ ...base, trackedJobs: jobs });
  it('the mode recorded at submit survives a merge of two windows', () => {
    const mine = mk([job('j', { sessionId: 's', mergeMode: 'keep', lastSeq: 9 })]);
    const theirs = mk([job('j', { sessionId: 's', lastSeq: 3 })]);
    expect(mergeShared(base, mine, theirs).trackedJobs[0].mergeMode).toBe('keep');
    expect(mergeShared(base, theirs, mine).trackedJobs[0].mergeMode).toBe('keep');
  });
  it('jobs without one gain no key', () => {
    const x = mk([job('j', { lastSeq: 1 })]); const y = mk([job('j', { lastSeq: 2 })]);
    expect('mergeMode' in mergeShared(mk([job('j')]), x, y).trackedJobs[0]).toBe(false);
  });
});

describe('client naming', () => {
  it('names the client by its reported agent', () => {
    expect(clientDisplayName('lucid')).toBe('LUC3D');
    expect(clientDisplayName('sleap-app')).toBe('SLEAP');
    expect(clientDisplayName('other')).toBe('other');
    expect(clientAgentLabel({ name: 'lucid', version: '1.2.3' })).toBe('LUC3D 1.2.3');
    expect(clientAgentLabel({ name: 'sleap-app' })).toBe('SLEAP');
  });
});

describe('readCodeInfo: one definition', () => {
  it('store.js re-exports the worker-ui-helpers function', () => {
    expect(readCodeInfo).toBe(helperReadCodeInfo);
  });
});

const WS = 'ws://127.0.0.1:9631';
const TRACK = { type: 'track', data_path: '/data/a.slp', model_paths: ['/data/m'] };
let worker, local, toast;
function backed(w) {
  return class extends WorkerClient {
    constructor(opts) { super({ ...opts, createSocket: opts.createSocket ? (u) => { opts.createSocket(u); return w.createSocket(); } : () => w.createSocket() }); }
  };
}

describe('store: planPairingForText, batch inference, throttle', () => {
  beforeEach(async () => {
    __resetConnectState();
    registerIrohSocketFactory(null);
    setIdentityStorage(createMemoryAdapter());
    _resetClientIdentityCache();
    worker = await FakeWorker.create({ files: { '/data/a.slp': 'x' } });
    local = new MemoryStorage(); toast = makeToast();
    configureConnect({ WorkerClient: backed(worker), localStorage: local, sessionStorage: new MemoryStorage(), notify: toast });
    __setManagedDeps({ sleep: () => tick(1) });
    useConnectStore.setState({
      pairedWorkers: [], selectedWorkerId: null, lastSelectedWorkerId: null, trackedJobs: [], deviceName: null,
      connectionStatus: 'disconnected', connectionError: null, workerMounts: [], reattachableJob: null,
      activeTransport: null, connections: {}, workerErrors: {}, workerInfo: {}, _client: null,
    });
  });

  it('planPairingForText never throws and returns the plan shape', async () => {
    expect(await planPairingForText('')).toEqual({ kind: 'error', message: NOT_A_CODE });
    expect(await planPairingForText('garbage')).toEqual({ kind: 'error', message: NOT_A_CODE });
    const code = await worker.mintPairCode({ addrs: [WS] });
    const plan = await planPairingForText(code);
    expect(plan).toMatchObject({ kind: 'ready', transport: 'ws' });
    const over = await planPairingForText(code, 'ws://10.0.0.2:9631');
    expect(over.detail).toBe('Connects to ws://10.0.0.2:9631.');
  });

  it('submitJobsOn uses opts.run and opts.label; defaults are unchanged', async () => {
    await useConnectStore.getState().pairWithCode(await worker.mintPairCode({ addrs: [WS] }));
    const st = useConnectStore.getState();
    const run = { id: 'run-1', index: 1, count: 3 };
    const [a] = await st.submitJobsOn(worker.nodeId, TRACK, { source: 'window', sessionId: 'S', camera: 'front', run, label: 'Inference · S · front' });
    const [b] = await st.submitJobsOn(worker.nodeId, TRACK, { source: 'window' });
    const submits = worker.calls.filter((c) => c.method === 'jobs.submit');
    expect(submits[0].params.spec.run).toMatchObject({ id: 'run-1', index: 1, count: 3 });
    expect(submits[1].params.spec.run.id).not.toBe('run-1');
    expect(submits[1].params.spec.run).toMatchObject({ index: 0, count: 1 });
    const jobs = useConnectStore.getState().trackedJobs;
    expect(jobs.find((j) => j.jobId === a)).toMatchObject({ label: 'Inference · S · front', fetchedAt: null });
    expect(jobs.find((j) => j.jobId === b).label).toBe('Inference');
    expect('fetchedAt' in jobs.find((j) => j.jobId === b)).toBe(false);
  });

  it('markJobFetched stamps fetchedAt (unknown job is a no-op)', () => {
    useConnectStore.setState({ trackedJobs: [job('j', { sessionId: 's', fetchedAt: null })] });
    useConnectStore.getState().markJobFetched('nope');
    expect(useConnectStore.getState().trackedJobs[0].fetchedAt).toBeNull();
    useConnectStore.getState().markJobFetched('j');
    expect(typeof useConnectStore.getState().trackedJobs[0].fetchedAt).toBe('number');
  });

  it('fetchResultBlobOn uses that worker\'s connection, not the selected _client', async () => {
    const calls = [];
    const client = { authenticated: true, fetchBlob: async (...a) => { calls.push(a); return new Uint8Array(1); } };
    const asked = [];
    const realClientFor = useConnectStore.getState().clientFor;
    useConnectStore.setState({ _client: null, clientFor: async (id) => { asked.push(id); return client; } });
    await useConnectStore.getState().fetchResultBlobOn('wX', { sha256: 'h', size: 3 });
    await useConnectStore.getState().fetchResultBlobOn('wX', { sha256: 'h', size: 3 }, { fsFallback: { path: '/p' } });
    expect(asked).toEqual(['wX', 'wX']);
    expect(calls).toEqual([['h', 3], ['h', 3, { fsFallback: { path: '/p' } }]]);
    useConnectStore.setState({ clientFor: realClientFor });
    await expect(useConnectStore.getState().fetchResultBlob({ sha256: 'h' })).rejects.toThrow('Not connected to a worker');
  });

  it('a burst of 100 log events writes the lastSeq at most twice; the terminal write has the latest seq', async () => {
    await useConnectStore.getState().pairWithCode(await worker.mintPairCode({ addrs: [WS] }));
    const [id] = await useConnectStore.getState().submitJobsOn(worker.nodeId, TRACK, { source: 'window' });
    await waitFor(() => worker.calls.some((c) => c.method === 'jobs.subscribe'), 'subscribe');
    let writes = 0;
    const orig = local.setItem.bind(local);
    local.setItem = (k, v) => { if (k === 'lucid-connect') writes++; return orig(k, v); };
    for (let i = 0; i < 100; i++) worker.log(id, `l${i}`);
    await waitFor(() => useConnectStore.getState().trackedJobs[0].lastSeq >= 1, 'first seq');
    await tick(100);
    expect(writes).toBeLessThanOrEqual(2);
    await worker.completeJob(id, { predictions: new Uint8Array([1]) });
    await waitFor(() => useConnectStore.getState().trackedJobs[0].state === 'completed', 'completed');
    expect(useConnectStore.getState().trackedJobs[0].lastSeq).toBeGreaterThan(100);
  });
});

await run();
