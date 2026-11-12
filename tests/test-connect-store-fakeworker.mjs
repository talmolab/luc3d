/**
 * End-to-end test of pose/connect/store.js against the server-faithful FakeWorker
 * (tests/connect/fake-worker.mjs): the real WorkerClient (real Ed25519 hello/auth), the real
 * ManagedConnection, an in-memory localStorage — only the socket is the fake worker's.
 *
 * Flow: mint a `sleap1…` code -> pairWithCode -> connected + paired + persisted -> submit a track job
 * tagged {sessionId, camera, projectTag} -> job.log / job.result / job.status events -> tracked job
 * completed (+ "finished" notification) -> a second job: the connection drops mid-run, the managed
 * connection redials, the subscription resumes from the persisted last seq and the events the worker
 * produced while the page was away (backlog replay) still land.
 */
console.warn = () => {};
import { describe, it, expect, beforeEach, run, MemoryStorage, makeToast } from './connect/store-test-env.mjs';
import { FakeWorker } from './connect/fake-worker.mjs';
import { WorkerClient } from '../pose/connect/client.js';
import { setIdentityStorage, createMemoryAdapter, getClientIdentity, _resetClientIdentityCache } from '../pose/connect/identity.js';
import { useConnectStore, configureConnect, __resetConnectState, __setManagedDeps } from '../pose/connect/store.js';

const WS_ADDR = 'ws://127.0.0.1:9631';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 4000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await tick(2);
  }
}

let worker, localStorage, toast;

/** A WorkerClient whose socket is the fake worker's. */
function clientClassFor(w) {
  return class FakeWorkerBackedClient extends WorkerClient {
    constructor(opts) {
      super({ ...opts, createSocket: () => w.createSocket() });
    }
  };
}

async function freshStore() {
  __resetConnectState();
  setIdentityStorage(createMemoryAdapter());
  _resetClientIdentityCache();
  worker = await FakeWorker.create({ files: { '/data/a.slp': 'x' } });
  localStorage = new MemoryStorage();
  toast = makeToast();
  configureConnect({
    WorkerClient: clientClassFor(worker),
    localStorage,
    sessionStorage: new MemoryStorage(),
    notify: toast,
    appVersion: '9.9.9',
  });
  // Reconnect backoff without the real waits.
  __setManagedDeps({ sleep: () => tick(1) });
  useConnectStore.setState({
    pairedWorkers: [], selectedWorkerId: null, lastSelectedWorkerId: null, trackedJobs: [], deviceName: null,
    connectionStatus: 'disconnected', connectionError: null, workerMounts: [], reattachableJob: null,
    activeTransport: null, connections: {}, workerErrors: {}, workerInfo: {}, _client: null,
  });
}

describe('Connect store against FakeWorker', () => {
  beforeEach(async () => {
    await freshStore();
  });

  it('pairs from a minted sleap1 code, submits a tagged track job and tracks it to completion', async () => {
    const code = await worker.mintPairCode({ addrs: [WS_ADDR] });
    expect(code.startsWith('sleap1')).toBe(true);

    await useConnectStore.getState().pairWithCode(code);
    let s = useConnectStore.getState();
    expect(s.connectionStatus).toBe('connected');
    expect(s.selectedWorkerId).toBe(worker.nodeId);
    expect(s.pairedWorkers).toHaveLength(1);
    expect(s.pairedWorkers[0].nodeId).toBe(worker.nodeId);
    expect(s.pairedWorkers[0].addrs).toEqual([WS_ADDR]);
    expect(s.workerMounts.length).toBeGreaterThan(0);
    expect(worker.paired.size).toBe(1); // pair.claim registered this device...
    expect(worker.calls.some((c) => c.method === 'auth.prove')).toBe(true); // ...and the managed connection re-authenticated
    // The hello carried LUCID's agent (the worker lists this device with it).
    const me = (await useConnectStore.getState().devicesFor(worker.nodeId)).find((d) => d.you);
    expect(me).toMatchObject({ platform: 'web', appVersion: '9.9.9' });
    // Persisted under the lucid key, shared slice only.
    const saved = JSON.parse(localStorage.getItem('lucid-connect'));
    expect(saved.version).toBe(3);
    expect(saved.state.pairedWorkers[0].nodeId).toBe(worker.nodeId);
    expect('_client' in saved.state).toBe(false);

    const spec = { type: 'track', data_path: '/data/a.slp', model_paths: ['/data/m'] };
    const [jobId] = await useConnectStore.getState().submitJobsOn(worker.nodeId, spec, {
      source: 'window', sessionId: 'S1', camera: 'cam0', projectTag: 'proj-abc',
    });
    s = useConnectStore.getState();
    expect(s.trackedJobs).toHaveLength(1);
    expect(s.trackedJobs[0]).toMatchObject({
      jobId, workerId: worker.nodeId, kind: 'track', label: 'Inference', state: 'active', source: 'window',
      sessionId: 'S1', camera: 'cam0', projectTag: 'proj-abc',
    });
    expect(worker.calls.find((c) => c.method === 'jobs.submit').params.spec.run).toMatchObject({ index: 0, count: 1 });

    await waitFor(() => worker.calls.some((c) => c.method === 'jobs.subscribe'), 'subscribe');
    worker.log(jobId, 'Predicting…');
    worker.setJobState(jobId, 'running');
    await waitFor(() => useConnectStore.getState().trackedJobs[0].lastSeq >= 1, 'lastSeq to advance');
    await worker.completeJob(jobId, { predictions: new Uint8Array([1, 2, 3]) });
    await waitFor(() => useConnectStore.getState().trackedJobs[0].state === 'completed', 'job completed');

    expect(useConnectStore.getState().trackedJobs[0]).toMatchObject({ state: 'completed', sessionId: 'S1', camera: 'cam0' });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Inference on Worker'), expect.anything());
    expect(localStorage.getItem('lucid-connect')).toContain('"state":"completed"');
  });

  it('after a drop the managed connection redials, resubscribes from the last seq and replays the backlog', async () => {
    await useConnectStore.getState().pairWithCode(await worker.mintPairCode({ addrs: [WS_ADDR] }));
    const spec = { type: 'track', data_path: '/data/a.slp', model_paths: ['/data/m'] };
    const [jobId] = await useConnectStore.getState().submitJobsOn(worker.nodeId, spec, {
      source: 'window', sessionId: 'S2', camera: 'cam1',
    });
    await waitFor(() => worker.calls.some((c) => c.method === 'jobs.subscribe'), 'first subscribe');
    worker.log(jobId, 'one');
    worker.log(jobId, 'two');
    // lastSeq persistence is throttled (2 s): the first event lands at once, the second may lag.
    await waitFor(() => useConnectStore.getState().trackedJobs[0].lastSeq >= 1, 'lastSeq persisted');
    await tick(20);
    const subscribesBefore = worker.calls.filter((c) => c.method === 'jobs.subscribe').length;
    const firstClient = useConnectStore.getState()._client;

    // The connection drops; while the page is away the job finishes.
    worker.closeAll(1006, 'boom');
    await worker.completeJob(jobId, { predictions: new Uint8Array([9]) });

    await waitFor(() => worker.calls.filter((c) => c.method === 'jobs.subscribe').length > subscribesBefore, 'resubscribe');
    const resub = worker.calls.filter((c) => c.method === 'jobs.subscribe').pop();
    expect(resub.params.job_id).toBe(jobId);
    expect(resub.params.since_seq).toBeGreaterThan(0); // the persisted lastSeq (may lag the stream), not 0
    expect(resub.params.since_seq).toBeLessThanOrEqual(2);
    await waitFor(() => useConnectStore.getState().trackedJobs[0].state === 'completed', 'completed via backlog replay');
    expect(useConnectStore.getState()._client).not.toBe(firstClient); // a new client adopted
    expect(useConnectStore.getState().connectionStatus).toBe('connected');
    expect(useConnectStore.getState().trackedJobs[0].lastSeq).toBeGreaterThan(2); // terminal write carries the latest seq
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('a worker that was restarted and marked the job failed without an event: the reconnect still ends it', async () => {
    await useConnectStore.getState().pairWithCode(await worker.mintPairCode({ addrs: [WS_ADDR] }));
    const [jobId] = await useConnectStore.getState().submitJobsOn(
      worker.nodeId, { type: 'track', data_path: '/data/a.slp', model_paths: ['/data/m'] }, { source: 'window', sessionId: 'S4', camera: 'cam3' });
    await waitFor(() => worker.calls.some((c) => c.method === 'jobs.subscribe'), 'subscribe');
    worker.setJobState(jobId, 'running');
    await waitFor(() => useConnectStore.getState().trackedJobs[0].lastSeq >= 1, 'lastSeq');
    const before = worker.calls.filter((c) => c.method === 'jobs.subscribe').length;
    worker.closeAll(1006, 'worker killed');
    // What a restarted real worker does: the lost job becomes `failed` in its store, with no event.
    const job = worker._job(jobId);
    job.state = 'failed';
    job.error = 'worker restarted and this job\'s subprocess was no longer running';
    await waitFor(() => worker.calls.filter((c) => c.method === 'jobs.subscribe').length > before, 'resubscribe');
    await waitFor(() => useConnectStore.getState().trackedJobs[0].state === 'failed', 'failed found by the reconnect');
    expect(useConnectStore.getState().trackedJobs[0].error).toContain('worker restarted');
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('a reload resumes an active tracked job: resumeTrackedJobs redials and re-watches from its lastSeq', async () => {
    await useConnectStore.getState().pairWithCode(await worker.mintPairCode({ addrs: [WS_ADDR] }));
    const [jobId] = await useConnectStore.getState().submitJobsOn(
      worker.nodeId, { type: 'track', data_path: '/data/a.slp', model_paths: ['/data/m'] }, { source: 'window', sessionId: 'S3', camera: 'cam2' });
    await waitFor(() => worker.calls.some((c) => c.method === 'jobs.subscribe'), 'subscribe');
    worker.log(jobId, 'x');
    await waitFor(() => useConnectStore.getState().trackedJobs[0].lastSeq === 1, 'lastSeq 1');

    // "Reload": the page's connections and subscriptions are gone, the persisted copy stays.
    const raw = localStorage.getItem('lucid-connect');
    worker.closeAll(1001, 'page closed');
    __resetConnectState();
    configureConnect({ WorkerClient: clientClassFor(worker), localStorage, sessionStorage: new MemoryStorage(), notify: toast });
    __setManagedDeps({ sleep: () => tick(1) });
    useConnectStore.setState({ _client: null, connections: {}, connectionStatus: 'disconnected', selectedWorkerId: null });
    localStorage.setItem('lucid-connect', raw);
    useConnectStore.persist.rehydrate();
    expect(useConnectStore.getState().trackedJobs[0]).toMatchObject({ jobId, state: 'active', lastSeq: 1, sessionId: 'S3', camera: 'cam2' });

    const before = worker.calls.filter((c) => c.method === 'jobs.subscribe').length;
    await useConnectStore.getState().resumeTrackedJobs();
    const resub = worker.calls.filter((c) => c.method === 'jobs.subscribe').slice(before).pop();
    expect(resub.params).toMatchObject({ job_id: jobId, since_seq: 1 });

    await worker.completeJob(jobId, { predictions: new Uint8Array([7]) });
    await waitFor(() => useConnectStore.getState().trackedJobs[0].state === 'completed', 'completed after resume');
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});

await run();
