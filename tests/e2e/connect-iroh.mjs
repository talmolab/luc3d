/**
 * connect-iroh.mjs — the desktop iroh transport end to end in the page, against the fake
 * sleap-connect worker, with the REAL desktop shim (`src-tauri/js/lucid-desktop.js`) over a MOCK
 * Tauri runtime whose `iroh_*` commands are served by a Node-side bridge to the fake worker (frames
 * in / out, a blob store). No network and no Rust: the Rust pipe is tested in `cargo test` and
 * against a real worker with `src-tauri/examples/iroh_real_worker.rs`.
 *
 *  0. Web build (no shim): no iroh transport; a relay-only code asks for an address (unchanged).
 *  1. Desktop: the shim's `lucidDesktop.iroh` exists and `setupConnect` registers the transport.
 *  2. A relay-only code (no address) now PAIRS ("Connects directly when it can, through a relay when
 *     it can't."; no checkbox, no address box): `iroh_connect` dials the worker's node id + relay, the
 *     worker pairs the device, the card says "Connected via internet (direct or relay)".
 *  3. Fetch & Load over iroh (`fetchAndLoadJobs`): the blob comes through `iroh_blob_open` /
 *     `iroh_blob_read_range` (ranges of at most 4 MiB, aligned to the worker's chunks) / `iroh_blob_close`,
 *     NEVER the HTTP blob port; the merged file is byte-identical; a corrupted blob fails with the
 *     hash-mismatch error and stays unfetched.
 *  4. A typed address over a relay code pairs over ws; a ws drop that lasts 10 s falls back to iroh
 *     ("via internet"), then the preferred ws is probed again.
 *  5. Disconnect / forget close the Rust connection (`iroh_disconnect`).
 *
 * Usage: node tests/e2e/connect-iroh.mjs   (PORT= to move its server)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FakeWorker } from '../connect/fake-worker.mjs';
import { RELAY_TABLE } from '../connect/pair-code.mjs';
import { runConnectE2E, check, watchPage, bootApp, repoRoot } from './fixtures/connect-e2e.mjs';

const SHIM = fs.readFileSync(path.join(repoRoot, 'src-tauri', 'js', 'lucid-desktop.js'), 'utf8');
const PRED = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'sleap-nn-predictions', 'two-node.predictions.slp'));
const WS = 'ws://127.0.0.1:9641';
const RELAY = RELAY_TABLE[2];
const CHUNK = 4096; // the real worker's is 256 KiB; small here so the file spans several chunks

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** The mock Tauri runtime (page side): every iroh_* invoke goes through the Node bridge `__irohBridge`. */
function installMock() {
    class Channel { constructor() { this.onmessage = null; } }
    window.__TAURI__ = { core: { Channel }, event: { listen: () => Promise.resolve(() => {}) } };
    window.__irohCalls = [];
    window.__irohChannels = {};
    let nextId = 100;
    window.__TAURI_INTERNALS__ = {
        transformCallback() { return 0; },
        async invoke(cmd, args) {
            const name = cmd.replace(/^plugin:lucid\|/, '');
            if (name === 'ask_dialog') return true; // the shim's native confirm (Forget asks)
            if (!name.startsWith('iroh_')) return null;
            const a = args || {};
            window.__irohCalls.push({ name, connId: a.connId, args: JSON.parse(JSON.stringify(a, (k, v) => (v instanceof Channel ? '[channel]' : v))) });
            if (name === 'iroh_connect') {
                const id = nextId++;
                window.__irohChannels[id] = a.onMessage;
                try { await window.__irohBridge('connect', id, JSON.stringify(a.target)); } catch (e) { delete window.__irohChannels[id]; throw String(e.message || e); }
                return id;
            }
            if (name === 'iroh_send') return window.__irohBridge('send', a.connId, a.msg);
            if (name === 'iroh_disconnect') return window.__irohBridge('disconnect', a.connId);
            if (name === 'iroh_blob_open') {
                const r = await window.__irohBridge('blobOpen', a.connId, a.sha256).catch((e) => { throw String(e.message || e); });
                return JSON.parse(r);
            }
            if (name === 'iroh_blob_read_range') {
                const b64 = await window.__irohBridge('blobRead', a.connId, a.offset, a.length).catch((e) => { throw String(e.message || e); });
                return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer; // like tauri::ipc::Response
            }
            if (name === 'iroh_blob_close') return window.__irohBridge('blobClose', a.connId);
            return null;
        },
    };
}

await runConnectE2E(9397, async ({ browser, BASE }) => {

    // ---------------------------------------------------------------- 0
    console.log('\n--- 0. Web build: no iroh ---');
    {
        const page = await browser.newPage();
        watchPage(page);
        await bootApp(page, BASE);
        const w = await page.evaluate(async () => (await import('./pose/connect/transport.js')).irohTransportAvailable());
        check(w === false, 'irohTransportAvailable() is false without the desktop shim');
        await page.close();
    }

    // ---------------------------------------------------------------- bridge
    const worker = await FakeWorker.create({ workerInfo: { hostname: 'gpu-box' } });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('dialog', (d) => d.accept());
    watchPage(page);

    const conns = new Map();       // connId -> {socket}
    const dialed = [];             // iroh targets
    const blobReads = [];          // {offset, length}
    let blobOpens = 0;
    const openedSha = new Map();   // connId -> sha of its open blob stream
    let wsHits = 0;
    let push = Promise.resolve();
    const toPage = (id, ev) => { push = push.then(() => page.evaluate(([i, e]) => { const c = window.__irohChannels[i]; if (c && c.onmessage) c.onmessage(e); }, [id, ev]).catch(() => {})); };
    await page.exposeFunction('__irohBridge', async (op, id, a, b) => {
        if (op === 'connect') {
            const target = JSON.parse(a);
            dialed.push(target);
            if (target.nodeId !== worker.nodeId) throw new Error('iroh connect failed: unknown node');
            const socket = worker.createSocket({ autoOpen: false });
            socket.onmessage = (ev) => toPage(id, { kind: 'message', data: ev.data });
            socket.onclose = () => toPage(id, { kind: 'closed' });
            socket.simulateOpen();
            conns.set(id, { socket });
            return null;
        }
        const c = conns.get(id);
        if (op === 'send') { if (!c) throw new Error('Not connected to a worker over iroh'); c.socket.send(a); return null; }
        if (op === 'disconnect') { conns.delete(id); c && c.socket.close(); return null; }
        if (op === 'blobOpen') {
            const bytes = worker.blobs.get(a);
            if (!bytes) throw new Error('not_found');
            openedSha.set(id, a);
            blobOpens++;
            // The worker registers hashes of the file as it was; a "corrupted" file keeps the old ones.
            const good = worker.goodBlobs?.get(a) || bytes;
            const hashes = [];
            for (let i = 0; i < good.length; i += CHUNK) hashes.push(sha(good.subarray(i, i + CHUNK)));
            return JSON.stringify({ size: bytes.length, chunkSize: CHUNK, chunkHashes: hashes });
        }
        if (op === 'blobRead') {
            blobReads.push({ offset: a, length: b });
            if (b > 4 * 1024 * 1024) throw new Error(`blob read of ${b} bytes is over the limit`);
            const bytes = worker.blobs.get(openedSha.get(id));
            return Buffer.from(bytes.subarray(a, a + b)).toString('base64');
        }
        if (op === 'blobClose') return null;
        return null;
    });
    // ws route for scenario 4: down = the worker is unreachable over the network.
    let wsDown = false;
    await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9641/, (ws) => { wsHits++; if (wsDown) ws.close(); else worker.attachRoute(ws); });

    await page.addInitScript(installMock);
    await page.addInitScript(SHIM);
    await bootApp(page, BASE);

    console.log('\n--- 1. The shim and the registered transport ---');
    const reg = await page.evaluate(async () => ({
        shim: Object.keys(window.lucidDesktop.iroh || {}).sort(),
        available: (await import('./pose/connect/transport.js')).irohTransportAvailable(),
        fetcher: !!(await import('./pose/connect/transport.js')).getIrohBlobFetcher(),
    }));
    check(JSON.stringify(reg.shim) === JSON.stringify(['blobClose', 'blobOpen', 'blobReadRange', 'connect', 'disconnect', 'send']), 'lucidDesktop.iroh has the six calls', reg.shim);
    check(reg.available && reg.fetcher, 'setupConnect registered the iroh socket factory and blob fetcher', reg);

    await page.click('.panel-rail-btn[data-tab="tabConnect"]');
    const plan = () => page.evaluate(() => { const p = document.querySelector('[data-pf="plan"]'); return p.hidden ? null : { kind: p.dataset.kind, text: p.textContent }; });
    const cards = () => page.evaluate(() => [...document.querySelectorAll('.connect-worker')].map((c) => ({ id: c.dataset.nodeId, on: !!c.querySelector('.connect-dot.on'), text: c.textContent })));
    const calls = () => page.evaluate(() => window.__irohCalls.map((c) => c.name));

    console.log('\n--- 2. A relay-only code pairs on the desktop ---');
    const code = await worker.mintPairCode({ relayUrl: RELAY });
    await page.fill('[data-pf="code"]', code);
    await page.waitForTimeout(150);
    const p2 = await plan();
    check(p2 && p2.kind === 'ready' && p2.text === "Connects directly when it can, through a relay when it can't.", 'plan line: ready, direct-or-relay', p2);
    check(await page.evaluate(() => document.querySelector('[data-pf="address"]').offsetParent === null && document.querySelector('[data-pf="pair"]').disabled === false),
        'nothing to choose: no address box, Pair enabled');
    await page.click('[data-pf="pair"]');
    await page.waitForSelector('.connect-worker .connect-dot.on', { timeout: 15000 });
    let cs = await cards();
    check(cs.length === 1 && /Connected via internet \(direct or relay\)/.test(cs[0].text), 'card: "Connected via internet (direct or relay)"', cs);
    check(dialed.length >= 1 && dialed.every((t) => t.nodeId === worker.nodeId && t.relayUrl === RELAY), 'iroh_connect dialed the worker node id over its relay', dialed);
    const me = await page.evaluate(async () => (await import('./pose/connect/identity.js')).getClientIdentity().then((i) => i.nodeId));
    check(worker.paired.has(me), 'the worker paired this device over the iroh pipe');
    check(wsHits === 0, 'no WebSocket was opened');

    console.log('\n--- 3. Fetch & Load over iroh ---');
    const job = worker.addJob({ state: 'running' }).job_id;
    const result = await worker.completeJob(job, { predictions: PRED });
    const workerId = worker.nodeId;
    const httpBefore = worker.blobRequests.length;
    const r3 = await page.evaluate(async ({ workerId, job }) => {
        const m = await import('./ui/connect/remote-inference.js');
        const merged = [];
        const out = await m.fetchAndLoadJobs([{ workerId, jobId: job, camera: 'cam1' }], {
            mode: 'replace',
            mergeFile: async (file, view, mode) => {
                merged.push({ name: file.name, size: file.size, view, mode, b64: btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer()))) });
                return { instances: 20, frames: 10, deleted: 0 };
            },
        });
        return { out, merged };
    }, { workerId, job });
    check(r3.out.loaded === 1 && r3.out.failures.length === 0, 'Fetch & Load loaded the job', r3.out);
    check(r3.merged.length === 1 && Buffer.from(r3.merged[0].b64, 'base64').equals(PRED), 'the merged file is byte-identical to the worker\'s', { size: r3.merged[0] && r3.merged[0].size });
    const names = await calls();
    const i0 = names.indexOf('iroh_blob_open');
    check(i0 >= 0 && names[names.length - 1] === 'iroh_blob_close' && names.slice(i0).every((n) => n.startsWith('iroh_')), 'iroh_blob_open … iroh_blob_close', names.slice(i0));
    check(blobOpens === 1 && blobReads.length >= 1 && blobReads.every((r) => r.length <= 4 * 1024 * 1024 && r.offset % CHUNK === 0),
        'ranges aligned to the worker\'s chunks and within 4 MiB', blobReads);
    check(worker.blobRequests.length === httpBefore, 'the HTTP blob port was never used');
    // A corrupted blob (bytes changed after the worker hashed them) fails verification and stays unfetched.
    const bad = Buffer.from(PRED); bad[bad.length - 5] ^= 0xff;
    worker.goodBlobs = new Map([[result.blobs.predictions.sha256, new Uint8Array(PRED)]]);
    worker.blobs.set(result.blobs.predictions.sha256, new Uint8Array(bad));
    const r3b = await page.evaluate(async ({ workerId, job }) => {
        const m = await import('./ui/connect/remote-inference.js');
        const log = [];
        const out = await m.fetchAndLoadJobs([{ workerId, jobId: job, camera: 'cam1' }], {
            mode: 'replace', onLog: (l) => log.push(l),
            mergeFile: async () => { throw new Error('must not merge a corrupted file'); },
        });
        return { out, log };
    }, { workerId, job });
    check(r3b.out.loaded === 0 && r3b.out.failures.join() === 'cam1' && /chunk \d+|hash/i.test(r3b.log.join(' ')), 'a corrupted blob is refused (hash mismatch), the job stays pending', r3b);
    worker.blobs.set(result.blobs.predictions.sha256, new Uint8Array(PRED));
    worker.goodBlobs = null;

    console.log('\n--- 5. Disconnect closes the Rust connection ---');
    await page.click('.connect-disconnect');
    await page.waitForSelector('.connect-connect', { timeout: 5000 });
    check((await calls()).filter((n) => n === 'iroh_disconnect').length >= 1, 'iroh_disconnect invoked');

    console.log('\n--- 4. A typed address pairs over ws; a 10 s ws outage falls back to iroh ---');
    await page.click('.connect-forget');
    await page.waitForFunction(() => !document.querySelector('.connect-worker'), null, { timeout: 10000 });
    const code4 = await worker.mintPairCode({ relayUrl: RELAY });
    await page.fill('[data-pf="code"]', code4);
    await page.waitForTimeout(150);
    if (!(await page.evaluate(() => document.querySelector('[data-pf="address"]').offsetParent !== null))) await page.click('[data-pf="advanced"]');
    await page.fill('[data-pf="address"]', WS);
    await page.waitForTimeout(150);
    const p4 = await plan();
    check(p4 && p4.kind === 'ready' && p4.text === `Connects to ${WS}.`, 'a typed address over a relay code plans ws', p4);
    const dialsBefore = dialed.length;
    await page.click('[data-pf="pair"]');
    await page.waitForSelector('.connect-worker .connect-dot.on', { timeout: 15000 });
    cs = await cards();
    check(/Connected via local network/.test(cs[0].text) && dialed.length === dialsBefore, 'paired and connected over ws (iroh not dialed)', cs);
    wsDown = true;
    const t0 = Date.now();
    worker.closeAll();
    await page.waitForFunction(() => /Connected via internet/.test(document.querySelector('.connect-worker')?.textContent || ''), null, { timeout: 60000 });
    const took = (Date.now() - t0) / 1000;
    check(took >= 9, `fell back to iroh only after the outage lasted ~10 s (${took.toFixed(1)} s)`, took);
    check(dialed.length > dialsBefore, 'iroh_connect dialed on the fallback');
    wsDown = false;
});
