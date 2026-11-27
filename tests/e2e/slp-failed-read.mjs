/**
 * slp-failed-read.mjs — a read of a `.slp` that fails is an error, never a project
 * with data missing.
 *
 * The vendored reader (`readSlpStreaming`) took a failed read of something a file has
 * for something it doesn't, so a project opened with that part gone, and the next save
 * made the loss permanent. Measured on the unpatched bundle, real Chromium, a real file
 * on disk: File ▸ Open said "SLP loaded" with 0 of 80 groups and no 3D, and the saved
 * file held the same; a failed /frames read saved no 2D at all; a failed /instances read
 * saved every instance twice with no points. Failing the reader alone is not enough:
 * `parseSlpForImport` then fell back to the raw worker, which opens a saved project with
 * every group and all the 3D gone, and which swallowed failed reads the same way.
 *
 * The failures here are real. Each test file is a real file on disk, picked through a
 * real <input>, read by the real workers through WORKERFS and FileReaderSync. The test
 * puts a few lines in front of each worker's script (WORKER_PREFIX), which make a
 * blocking call to this test's server at the right moment, and the server moves the file
 * away. So the read that follows fails the way a removed file or a dropped network share
 * does, at a known point, with no race. Moving it back keeps its modification time, so
 * Chromium reads it again: that is the "hiccup", where a retry would work, and where a
 * reader that swallows the error goes on to read everything else.
 *
 *  1. Every kind of read, one at a time, on the reader: LUC3D's layout, Python's
 *     compound layout, per-detection identity, categories, video crops, embedded video
 *     groups, /session_data. Each has to reject, and say the file could not be read.
 *  2. Every read in turn (a sweep) of a project and of a plain prediction file: each
 *     must end in an error or in exactly the healthy result. None may differ.
 *  3. The app: File ▸ Open (eager and lazy), the per-camera loader. Nothing opens, an
 *     open project stays as it was, and opening again gets everything.
 *  4. When the raw worker may stand in for the typed reader (`parseSlpWithRawFallback`).
 *  5. The raw worker: every kind of read, the analysis .h5 paths.
 *  6. After a failed read nothing more comes out of that worker (HDF5 is stopped
 *     mid-call: the same read tried again would succeed with wrong data).
 *  7. How this meets the h5wasm `cold-read` patch: a hole it repairs is no failure, a
 *     re-read of its that fails is.
 *  8. A range source (needs a cross-origin isolated page).
 *  9. A lazily opened embedded video.
 * 10. A multi-session save, whose second pass reads the source files again: one that has
 *     gone away stops it before anything is released, and a Save after a failed one
 *     refuses instead of writing an empty project.
 *
 * Run: node tests/e2e/slp-failed-read.mjs   (starts its own server, on a free port)
 */
import { launchBrowser } from './lib/harness.mjs';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(repoRoot, 'tests', 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-failed-read-'));

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 500)));
    if (!c) fails++;
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
// A page with no CDN scripts, cross-origin isolated, for the range source (SharedArrayBuffer).
const ISOLATED = `<!doctype html><script type="importmap">{"imports":{
    "h5wasm":"./lib/h5wasm/hdf5_hl.js","yaml":"https://cdn.jsdelivr.net/npm/yaml@2.8.0/+esm",
    "mediabunny":"./lib/mediabunny/mediabunny.min.mjs","pako":"./lib/pako/pako.esm.mjs"}}</script>
    <script type="module">import * as SIO from './lib/sleap-io/index.browser.js'; window.SIO = SIO;</script>`;

const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/__hide' || u.pathname === '/__show') {
        const f = u.searchParams.get('f');
        if (!f || !f.startsWith(tmp)) { res.writeHead(403); return res.end(); }
        const [from, to] = u.pathname === '/__hide' ? [f, f + '.away'] : [f + '.away', f];
        if (fs.existsSync(from)) fs.renameSync(from, to);
        res.writeHead(200); return res.end('ok');
    }
    if (u.pathname === '/__isolated.html') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
        return res.end(ISOLATED);
    }
    const p = path.join(repoRoot, decodeURIComponent(u.pathname));
    if (!p.startsWith(repoRoot) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store',
        'Cross-Origin-Resource-Policy': 'same-origin' });
    fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// In front of every worker's script. `plan` says when the file goes away:
//   request: {type, path}  just before the worker handles that request
//   stage: regex           at that progress message (the raw worker has one big request)
//   nth: k                 for the k-th read of the file (and back right after it)
//   fake: {type, path}     no failure, an error answer to that request: a read that needs
//                          no disk, because HDF5 has it cached, can't really fail here
//   zero: {type, path}     the first read after that request comes back as all zeros, as
//                          a cloud file's can (the cold-read patch re-reads it)
//   zeroAndHide: same, and the file goes away, so the re-read fails
//   hiccup: true           back after that request's answer, or at the next progress
// Notes go up the worker's own channel (`__probe`), so they arrive before its answer.
const WORKER_PREFIX = `
var plan = __PLAN__;
var post = self.postMessage;
function probe(p) { post.call(self, { __probe: p }); }
function call(op) { var x = new XMLHttpRequest(); x.open('POST', self.location.origin + '/__' + op + '?f=' + encodeURIComponent(plan.file), false); x.send(); }
var hidden = false, answering = null, stageDone = false, zeroArmed = false;
function hide(why) { if (hidden) return; hidden = true; probe({ hidden: why }); call('hide'); }
function show() { if (!hidden) return; hidden = false; call('show'); }
function matches(want, d) { return want && d.type === want.type && d.payload && d.payload.path === want.path; }
self.addEventListener('message', function (e) {
    var d = e.data || {};
    if (matches(plan.request, d) && answering === null) { answering = d.id; hide(d.type + ':' + d.payload.path); }
    if (matches(plan.zero, d) || matches(plan.zeroAndHide, d)) zeroArmed = true;
    if (matches(plan.fake, d)) {
        e.stopImmediatePropagation();
        probe({ hidden: 'fake ' + d.type + ':' + d.payload.path });
        post.call(self, { id: d.id, success: false, error: 'fake failure of ' + d.type + ' ' + d.payload.path });
    }
});
self.postMessage = function (m, t) {
    post.call(self, m, t);
    if (!m) return;
    if (answering !== null && m.id === answering && plan.hiccup) show();
    if (m.type === 'progress') {
        if (plan.hiccup) show();
        if (plan.stage && !stageDone && new RegExp(plan.stage).test(m.message)) { stageDone = true; hide('stage ' + m.message); }
    }
};
var read = FileReaderSync.prototype.readAsArrayBuffer, nth = 0;
FileReaderSync.prototype.readAsArrayBuffer = function (blob) {
    nth++;
    if (plan.nth === nth) hide('read ' + nth);
    var out;
    try { out = read.call(this, blob); }
    catch (e) {
        probe({ failed: String(e && e.message).slice(0, 120) });
        if (plan.nth === nth) show();
        throw e;
    }
    if (zeroArmed) {
        zeroArmed = false;
        new Uint8Array(out).fill(0);
        probe({ zeroed: out.byteLength });
        if (plan.zeroAndHide) hide('re-read of zeros');
    }
    return out;
};
`;

let browser;
try {
    browser = await launchBrowser();
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e).slice(0, 300)));
    page.on('dialog', d => d.accept());
    await page.addInitScript((prefix) => {
        const Real = window.Worker;
        window.__plan = null;
        window.__probes = [];
        window.__rawWorkers = 0;
        window.Worker = class extends Real {
            constructor(url, opts) {
                const isModule = !!(opts && opts.type === 'module');
                if (isModule && /slp-import-worker/.test(String(url))) window.__rawWorkers++;
                const plan = window.__plan;
                if (!plan) { super(url, opts); return; }
                const inner = new URL(String(url), document.baseURI).href;
                const code = prefix.replace('__PLAN__', () => JSON.stringify(plan));
                // A module worker's imports run before its body, so the worker comes in
                // by dynamic import, and what arrives until it has set onmessage is kept.
                const src = isModule
                    ? code + `
var early = [], ready = false;
self.addEventListener('message', function (e) { if (!ready) early.push(e); });
await import(${JSON.stringify(inner)});
ready = true;
for (var i = 0; i < early.length; i++) self.onmessage(early[i]);`
                    : code + `\nimportScripts(${JSON.stringify(inner)});`;
                super(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), opts);
                this.addEventListener('message', (e) => {
                    if (e.data && e.data.__probe) window.__probes.push(e.data.__probe);
                });
            }
        };
    }, WORKER_PREFIX);
    await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm && window.__lucid, null, { timeout: 120000 });

    await page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'file'; input.id = '__picked'; input.multiple = true; input.style.display = 'none';
        document.body.appendChild(input);
        window.__h5wasmUrl = new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href;
        const b64 = (bytes) => {
            let s = ''; const C = 0x8000;
            for (let o = 0; o < bytes.length; o += C) s += String.fromCharCode.apply(null, bytes.subarray(o, o + C));
            return btoa(s);
        };
        window.__b64 = b64;
        // A real project, by the app's own writer: 3 cameras, 40 frames, 2 animals, user and
        // predicted instances, identities, tracks, suggestions, 3D with a smoothing source.
        window.__buildProject = async () => {
            const pd = await import('/pose/pose-data.js');
            const fileio = await import('/import-export/file-io.js');
            const AS = await import('/ui/app-state.js');
            const SIOAll = await import('/lib/sleap-io/index.browser.js');
            const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
            const CAMS = 3, FRAMES = 40, NODES = 3;
            const camNames = Array.from({ length: CAMS }, (_, i) => 'cam' + i);
            const nodeNames = Array.from({ length: NODES }, (_, i) => 'n' + i);
            const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
            const cameras = camNames.map((n, i) => {
                const a = (i / CAMS) * 1.2 - 0.6;
                return new Camera(n, M, [0, 0, 0, 0, 0], [0, a, 0], [-40 * Math.sin(a), 0, 40 * (1 - Math.cos(a))], [512, 512]);
            });
            const skeleton = new Skeleton('skeleton', nodeNames, nodeNames.slice(1).map((_, i) => [i, i + 1]));
            const session = new Session(cameras, skeleton, ['track_0', 'track_1'], 'FailedRead');
            session.identities = [new pd.Identity(0, 'id_0'), new pd.Identity(1, 'id_1')];
            const xy = (f, c, k, a) => [150 + f + c * 11 + k * 3 + a * 120, 200 + f + c * 7 + k * 2 + a * 60];
            for (let f = 0; f < FRAMES; f++) {
                const fg = new FrameGroup(f);
                session.addFrameGroup(fg);
                const gs = [];
                for (let a = 0; a < 2; a++) {
                    const g = new InstanceGroup(f * 2 + a + 1, a);
                    camNames.forEach((cn, ci) => {
                        const inst = new Instance(nodeNames.map((_, k) => xy(f, ci, k, a)), a, f % 2 ? 'predicted' : 'user', 0.9);
                        fg.addInstance(cn, inst);
                        g.addInstance(cn, inst);
                    });
                    g.points3d = new Float64Array(NODES * 3).map((_, i) => f + i * 0.5 + a * 40);
                    gs.push(g);
                }
                session.instanceGroups.set(f, gs);
            }
            const views = camNames.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES }));
            const videoFiles = camNames.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
            AS.state.sessions = [session]; AS.state.session = session; AS.state.activeSessionIdx = 0;
            AS.state.views = views; AS.state.videoFiles = videoFiles;
            const labels = fileio.buildSlpLabelsAllViews(session, views, videoFiles);
            labels.suggestions = [new SIOAll.SuggestionFrame({ video: labels.videos[0], frameIdx: 3 })];
            for (const s of labels.sessions) for (const fg of s.frameGroups.values()) for (const g of fg.instanceGroups) {
                const n = g.instance3d && g.instance3d.points && g.instance3d.points.length;
                if (n) g.instance3d.lucidUnsmoothed = new Float64Array(n).fill(1.5);
            }
            AS.state.sessions = []; AS.state.session = null; AS.state.views = []; AS.state.videoFiles = [];
            return b64(await window.SleapIO.saveSlpToBytes(labels));
        };
        // Add datasets to a file, in h5wasm's own read-write mode. `add` is
        // [{group} | {name, data, shape, dtype}], applied in order.
        window.__withAdded = async (base64, add) => {
            const h5 = window.h5wasm;
            await h5.ready;
            const p = '/added-' + Math.random().toString(16).slice(2) + '.slp';
            h5.FS.writeFile(p, Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
            const f = new h5.File(p, 'a');
            for (const a of add) {
                if (a.group) f.create_group(a.group);
                else f.create_dataset(a.dtype ? { name: a.name, data: new Int32Array(a.data), shape: a.shape, dtype: a.dtype } : { name: a.name, data: a.data });
            }
            f.close();
            const out = h5.FS.readFile(p);
            h5.FS.unlink(p);
            return b64(out);
        };
        // What a reader got: every count that goes missing when a read fails.
        window.__digest = (labels) => {
            const store = labels._lazyDataStore;
            const lf = store ? null : labels.labeledFrames || [];
            let finite = 0, instances = 0;
            if (lf) {
                for (const f of lf) for (const i of f.instances) {
                    instances++;
                    for (let k = 0; k < i._xy.length; k += 2) if (isFinite(i._xy[k])) finite++;
                }
            } else {
                instances = (store.instancesData.frame_id || store.instancesData.instance_id || []).length;
                for (const t of [store.pointsData, store.predPointsData]) {
                    if (t && t.x) for (let k = 0; k < t.x.length; k++) if (isFinite(t.x[k])) finite++;
                }
            }
            let groups = 0, with3d = 0, members = 0;
            for (const s of labels.sessions) for (const fg of s.frameGroups.values()) for (const g of fg.instanceGroups) {
                groups++;
                if (g.instance3d && g.instance3d.points && g.instance3d.points.length) with3d++;
                members += g.instanceByCamera ? g.instanceByCamera.size : 0;
            }
            const eachInstance = (test) => (lf ? lf.reduce((n, f) => n + f.instances.filter(test).length, 0) : 0);
            return JSON.stringify({ frames: store ? (store.framesData.frame_id || []).length : lf.length, instances, finite,
                videos: labels.videos.length, tracks: labels.tracks.length, suggestions: labels.suggestions.length,
                sessions: labels.sessions.length, identities: labels.identities.length, groups, with3d, members,
                crops: labels.videos.filter(v => v.backendMetadata && v.backendMetadata.crop).length,
                sourceVideos: labels.videos.filter(v => v.sourceVideo).length,
                metaKeys: labels.identities.reduce((n, id) => n + Object.keys(id.metadata || {}).length, 0),
                links: eachInstance(i => i.identity), embeddings: eachInstance(i => i.identityEmbedding),
                categories: eachInstance(i => i.category), categoryEmbeddings: eachInstance(i => i.categoryEmbedding) });
        };
    });

    // ---- the test files ----
    const fromBase64 = (b) => Buffer.from(b, 'base64');
    const toBase64 = (buf) => buf.toString('base64');
    const pythonFile = (name) => fs.readFileSync(path.join(FIXTURES, 'slp-failed-read', name));
    const add = async (buf, items) => fromBase64(await page.evaluate(([b, a]) => window.__withAdded(b, a), [toBase64(buf), items]));

    const files = {};
    files.project = fromBase64(await page.evaluate(() => window.__buildProject()));
    files.compound = fs.readFileSync(path.join(FIXTURES, 'slp-compound', 'sleap-compound-small.slp'));
    files.identity = await add(pythonFile('py_written_25_identity.slp'), [
        { name: 'identity/meta_owner', data: [0, 0], shape: [2], dtype: '<i' },
        { name: 'identity/meta_key', data: ['color', 'note'] },
        { name: 'identity/meta_val', data: ['#ff0000', 'kept'] },
    ]);
    files.category = pythonFile('py_written_27_category.slp');
    files.multiview = pythonFile('py_written_28_multiview3d.slp');
    files.embedded = await add(pythonFile('cropped_format_2_3.pkg.slp'), [
        { name: 'video0/frame_sizes', data: [1, 1, 1], shape: [3], dtype: '<i' },
        { name: 'video0/source_video/json', data: [JSON.stringify({ filename: 'spilled.mp4', backend: { type: 'MediaVideo', filename: 'spilled.mp4', shape: [10, 4, 4, 1] } })] },
    ]);
    // A Labels whose videos_json doesn't name the dataset: the reader has to find it.
    files.unnamed = await add(fromBase64(await page.evaluate(async () => {
        const SIO = await import('/lib/sleap-io/index.browser.js');
        const skeleton = new SIO.Skeleton({ nodes: [new SIO.Node('a')] });
        const video = new SIO.Video({ filename: '.', backendMetadata: { filename: '.', type: 'HDF5Video', shape: [1, 4, 4, 1] }, embedded: true });
        const labels = new SIO.Labels({ labeledFrames: [new SIO.LabeledFrame({ video, frameIdx: 0, instances: [new SIO.Instance({ points: [[1, 2]], skeleton })] })], videos: [video], skeletons: [skeleton] });
        return window.__b64(await SIO.saveSlpToBytes(labels));
    })), [
        { group: 'video0' },
        { name: 'video0/video', data: [1, 2, 3, 4], shape: [4], dtype: '<i' },
    ]);
    const analysisH5 = fromBase64(await page.evaluate(async () => {
        const h5 = window.h5wasm; await h5.ready;
        const p = '/analysis-' + Math.random().toString(16).slice(2) + '.h5';
        const f = new h5.File(p, 'w');
        f.create_dataset({ name: 'node_names', data: ['a', 'b'] });
        f.create_dataset({ name: 'track_names', data: ['t0'] });
        f.create_dataset({ name: 'edge_inds', data: new Int32Array([0, 1]), shape: [1, 2], dtype: '<i' });
        // [n_tracks, 2, n_nodes, n_frames] = [1, 2, 2, 5]
        f.create_dataset({ name: 'tracks', data: new Float64Array(20).map((_, i) => i + 1), shape: [1, 2, 2, 5], dtype: '<d' });
        f.create_dataset({ name: 'track_occupancy', data: new Int32Array([1, 1, 1, 1, 0]), shape: [5, 1], dtype: '<i' });
        f.close();
        const out = h5.FS.readFile(p); h5.FS.unlink(p);
        return window.__b64(out);
    }));

    /** Put `buf` on disk at a path of its own and pick it. Returns the picked file's path. */
    async function pick(buf, name = 'picked.slp') {
        const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
        const p = path.join(dir, name);
        fs.writeFileSync(p, buf);
        await page.setInputFiles('#__picked', p);
        return p;
    }
    const unhide = (p) => { if (fs.existsSync(p + '.away')) fs.renameSync(p + '.away', p); };

    /** readSlpStreaming on the picked file, under `plan`. */
    async function readWith(buf, plan, options = {}) {
        const file = await pick(buf);
        const r = await page.evaluate(async ({ plan, options }) => {
            window.__plan = plan; window.__probes = [];
            const f = document.getElementById('__picked').files[0];
            const out = {};
            try {
                const labels = await window.SleapIO.readSlpStreaming(f, { openVideos: false, rawSessions: true, h5wasmUrl: window.__h5wasmUrl, ...options });
                out.digest = window.__digest(labels);
            } catch (e) {
                out.threw = String(e && e.message || e).slice(0, 200);
                out.failedRead = !!(e && e.failedRead);
            }
            window.__plan = null;
            out.probes = window.__probes.slice();
            return out;
        }, { plan: plan && { ...plan, file }, options });
        unhide(file);
        return r;
    }
    const fired = (r) => r.probes.some(p => p.hidden);
    const reallyFailed = (r) => r.probes.some(p => p.failed);

    // ================================================================= 0
    console.log('\n-- 0. the files, read healthy --');
    const healthy = {};
    for (const [name, buf] of Object.entries(files)) {
        const r = await readWith(buf, {});
        healthy[name] = r.digest;
        check(!!r.digest && !fired(r), `${name}: opens`, r);
    }
    const counts = (name) => JSON.parse(healthy[name]);
    check(counts('project').groups === 80 && counts('project').with3d === 80 && counts('project').suggestions === 1,
        'project: 80 groups with 3D, a suggestion', counts('project'));
    check(counts('identity').identities > 0 && counts('identity').metaKeys === 1 && counts('identity').links > 0 && counts('identity').embeddings > 0,
        'identity: a catalog with metadata, links, embeddings', counts('identity'));
    check(counts('category').categories > 0 && counts('category').categoryEmbeddings > 0, 'category: links, embeddings', counts('category'));
    check(counts('multiview').groups > 0, 'multiview: Python-written /session_data', counts('multiview'));
    check(counts('embedded').crops > 0 && counts('embedded').sourceVideos > 0, 'embedded: a crop, a source video', counts('embedded'));

    // ================================================================= 1
    console.log('\n-- 1. each kind of read fails, on the reader --');
    const V = 'getDatasetValue', M = 'getDatasetMeta', A = 'getAttrs', K = 'getKeys';
    const KINDS = [
        // LUC3D's layout (flat tables named by a field_names attribute).
        ['project', A, 'metadata'],
        ['project', V, 'tracks_json'], ['project', V, 'videos_json'], ['project', V, 'suggestions_json'],
        ['project', M, 'frames'], ['project', V, 'frames'], ['project', V, 'instances'], ['project', V, 'points'], ['project', V, 'pred_points'],
        ['project', V, 'identities_json'],
        ['project', V, 'sessions_json'], ['project', K, 'session_data'],
        ['project', M, 'session_data/frame_groups'], ['project', V, 'session_data/frame_groups'],
        ['project', V, 'session_data/instance_groups'], ['project', V, 'session_data/instance_group_members'],
        ['project', V, 'session_data/points_3d'], ['project', V, 'session_data/unsmoothed_points_3d'],
        // Python's layout (compound tables).
        ['compound', V, 'tracks_json'], ['compound', V, 'videos_json'],
        ['compound', V, 'frames'], ['compound', V, 'instances'], ['compound', V, 'pred_points'],
        // The file-level identity catalog, its metadata, the per-detection identity tables.
        ['identity', K, 'identity'], ['identity', V, 'identity/name'],
        ['identity', V, 'identity/meta_owner'], ['identity', V, 'identity/meta_key'], ['identity', V, 'identity/meta_val'],
        ['identity', V, 'identity/links'],
        ['identity', V, 'embeddings/vectors'], ['identity', V, 'embeddings/owner_type'], ['identity', V, 'embeddings/owner_id'],
        ['category', V, 'categories/name'], ['category', V, 'categories/links'],
        ['category', V, 'embeddings/category_vectors'], ['category', V, 'embeddings/category_owner_type'], ['category', V, 'embeddings/category_owner_id'],
        // Python's /session_data, with what LUC3D's writer leaves out.
        ['multiview', V, 'session_data/frame_groups'], ['multiview', V, 'session_data/instance_groups'], ['multiview', V, 'session_data/instance_group_members'],
        ['multiview', V, 'session_data/pred_points_3d'], ['multiview', V, 'session_data/frame_group_meta'], ['multiview', V, 'session_data/instance_group_meta'],
        // Crops and embedded videos.
        ['embedded', V, 'video_crops'], ['embedded', A, 'video0/video'],
        ['embedded', K, 'video0/source_video'], ['embedded', V, 'video0/source_video/json'],
        ['unnamed', K, 'video0'],
    ];
    const OPEN_VIDEO_KINDS = [
        ['embedded', V, 'video0/frame_numbers'], ['embedded', V, 'video0/frame_sizes'],
    ];
    for (const hiccup of [true, false]) {
        console.log(hiccup ? '  (the file comes back right after the read: the case the reader used to hide best)' : '  (the file stays gone)');
        for (const [name, type, p, opts] of [...KINDS, ...OPEN_VIDEO_KINDS.map(k => [...k, { openVideos: true }])]) {
            const r = await readWith(files[name], { request: { type, path: p }, hiccup }, opts);
            const hit = fired(r) && reallyFailed(r);
            check(hit && r.threw && r.failedRead, `${name}: failed ${type} of ${p} is an error`,
                hit ? (r.digest ? { opened: r.digest, healthy: healthy[name] } : r.threw) : { never: 'the read did not fail: fix the test', r });
        }
    }
    // HDF5 has a dataset's attributes in memory once it has read the dataset, so a real
    // read can't fail here: the failure of the request is what's being tested.
    const fake = await readWith(files.project, { fake: { type: A, path: 'frames' } });
    check(fired(fake) && !!fake.threw, 'project: failed read of a flat table\'s field_names is an error, not an empty table', fake);

    // ================================================================= 2
    console.log('\n-- 2. every read of a file fails in turn --');
    for (const [name, opts] of [['project', {}], ['project', { lazy: true }], ['compound', {}], ['identity', {}]]) {
        const base = (await readWith(files[name], {}, opts)).digest;
        const silent = [];
        let total = 0, identical = 0;
        for (let nth = 1; nth < 400; nth++) {
            const r = await readWith(files[name], { nth }, opts);
            if (!fired(r)) break;
            total++;
            if (r.digest === base) identical++;
            else if (r.digest || !r.failedRead) silent.push({ nth, digest: r.digest, threw: r.threw });
        }
        check(total > 5 && silent.length === 0,
            `${name}${opts.lazy ? ' (lazy)' : ''}: ${total} reads failed one at a time, ${total - identical} errors, ${identical} after the data was in (the same result), none different`,
            silent.slice(0, 4));
    }

    // ================================================================= 3
    console.log('\n-- 3. the app --');
    /** Run a real loader on the picked file, dismissing what it asks; report state + status. */
    async function openInApp(fn, buf, plan, name) {
        const file = await pick(buf, name);
        await page.evaluate(([fn, plan]) => {
            window.__plan = plan; window.__probes = []; window.__rawWorkers = 0;
            window.__loadDone = false;
            (async () => {
                const f = document.getElementById('__picked').files[0];
                if (fn === 'eager') await (await import('/import-export/slp-import.js')).handleLoadSlpFile(f);
                else await (await import('/loading/session-loader.js')).handleLoadProjectSlpLazy(f);
            })().then(() => { window.__loadDone = true; }, e => { window.__loadDone = 'ERR ' + (e && e.stack || e); });
        }, [fn, plan && { ...plan, file }]);
        let done = 'timeout';
        for (let i = 0; i < 600; i++) {
            const st = await page.evaluate(() => {
                const b = [...document.querySelectorAll('button')].find(x => x.offsetParent && /^(Skip|Later|Cancel|Not now)$/i.test((x.textContent || '').trim()));
                if (b) { b.click(); return { clicked: true }; }
                return { done: window.__loadDone, prompt: !!document.getElementById('videoSelectOverlay') };
            });
            if (st.prompt) await page.keyboard.press('Escape');
            if (st.done) { done = st.done; break; }
            await page.waitForTimeout(50);
        }
        const state = await page.evaluate(() => {
            window.__plan = null;
            const S = window.__lucid.state, s = S.session;
            const status = (document.getElementById('statusText') || {}).textContent || '';
            const probes = window.__probes.slice(), rawWorkers = window.__rawWorkers;
            if (!s) return { status, session: null, probes, rawWorkers };
            let groups = 0, with3d = 0;
            for (const gs of s.instanceGroups.values()) for (const g of gs) { groups++; if (g.points3d && g.points3d.length) with3d++; }
            return { status, session: s.name, lazy: !!s.lazyLoader, groups, with3d, tracks: s.tracks.length, identities: s.identities.length, probes, rawWorkers };
        });
        unhide(file);
        return { done, ...state };
    }
    const saveThroughApp = () => page.evaluate(async () => {
        const sl = await import('/import-export/save-load.js');
        const AS = await import('/ui/app-state.js');
        const cams = (AS.state.session.cameras || []).map(c => c.name);
        if (!AS.state.views.length) AS.state.views = cams.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: 40 }));
        if (!AS.state.videoFiles.length) AS.state.videoFiles = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const orig = URL.createObjectURL;
        let blob = null;
        URL.createObjectURL = (b) => { if (b.type === 'application/x-hdf5') blob = b; return orig.call(URL, b); };
        try { await sl.saveProjectSlp(); } finally { URL.createObjectURL = orig; }
        const status = (document.getElementById('statusText') || {}).textContent;
        if (!blob) return { status, wrote: false };
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const labels = await window.SleapIO.readSlpStreaming(new File([bytes], 'saved.slp'), { openVideos: false, rawSessions: true, h5wasmUrl: window.__h5wasmUrl });
        return { status, wrote: true, digest: JSON.parse(window.__digest(labels)) };
    });
    const looksLikeAFailedRead = (s) => /could not (be )?(found|read)|not be read/i.test(s || '');

    // Eager: an open project is left as it was, and nothing is read a second way.
    const fine = await openInApp('eager', files.project, null);
    check(fine.groups === 80 && fine.with3d === 80 && fine.session === 'FailedRead', 'File ▸ Open: the healthy project opens', fine);
    const reads = [[V, 'frames'], [V, 'instances'], [V, 'points'], [V, 'pred_points'], [V, 'tracks_json'], [V, 'videos_json'],
        [V, 'session_data/frame_groups'], [V, 'session_data/instance_groups'], [V, 'session_data/instance_group_members'],
        [V, 'session_data/points_3d'], [V, 'sessions_json']];
    for (const [type, p] of reads) {
        const r = await openInApp('eager', files.project, { request: { type, path: p }, hiccup: true }, 'another.slp');
        check(r.done === true && /^SLP parse error/.test(r.status) && looksLikeAFailedRead(r.status) && r.rawWorkers === 0 && r.groups === 80,
            `File ▸ Open, failed read of ${p}: says so, no second reader, the open project untouched`,
            { status: r.status, rawWorkers: r.rawWorkers, groups: r.groups, with3d: r.with3d });
    }
    const stillSaved = await saveThroughApp();
    check(stillSaved.wrote && stillSaved.digest.groups === 80 && stillSaved.digest.finite === 720,
        'and a Save afterwards holds the whole project', stillSaved);
    const again = await openInApp('eager', files.project, null);
    check(again.groups === 80 && again.with3d === 80 && !/error/i.test(again.status), 'opening the file again gets everything', again);

    // Lazy: the previous project is released before the read (as it always was), so nothing
    // is left open, but nothing half-read opens either.
    // A reopen reads /session_data on the read pool (`lucidReadSessionDataPooled`, the
    // column reads patch): a group table there is read in row blocks the worker splits
    // into columns (`lucidReadRowColumns`), not by `getDatasetValue`.
    for (const [type, p] of [[M, 'frames'], [V, 'frames'], [V, 'points'], [V, 'videos_json'], ['lucidReadRowColumns', 'session_data/frame_groups'], [V, 'session_data/points_3d'], [V, 'sessions_json']]) {
        const r = await openInApp('lazy', files.project, { request: { type, path: p }, hiccup: true }, 'lazy.slp');
        check(r.done === true && /^Lazy reopen error/.test(r.status) && looksLikeAFailedRead(r.status) && r.session === null,
            `File ▸ Open (large project), failed read of ${p}: says so, nothing half-read opens`, { status: r.status, session: r.session, groups: r.groups });
    }
    const lazyAgain = await openInApp('lazy', files.project, null, 'lazy.slp');
    check(lazyAgain.lazy && lazyAgain.groups === 80 && lazyAgain.with3d === 80, 'opening it again gets everything', lazyAgain);

    // The per-camera folder loader's lazy reader.
    const camFile = await pick(files.compound, 'cam.slp');
    const camOpen = await page.evaluate(async (file) => {
        const { SioLazyLoader } = await import('/loading/sio-lazy-loader.js');
        const f = document.getElementById('__picked').files[0];
        window.__plan = { request: { type: 'getDatasetValue', path: 'pred_points' }, hiccup: true, file };
        try { await new SioLazyLoader().open('cam', f); return 'opened'; }
        catch (e) { return e.failedRead ? 'failed read' : 'other: ' + e.message; }
        finally { window.__plan = null; }
    }, camFile);
    check(camOpen === 'failed read', 'per-camera loader: a failed read of a camera\'s pred_points stops the load', camOpen);
    unhide(camFile);

    // ================================================================= 4
    console.log('\n-- 4. when the raw worker may stand in for the typed reader --');
    async function viaFallback(buf, { plan, typedThrows, noOpen }) {
        const file = await pick(buf);
        const r = await page.evaluate(async ({ plan, typedThrows, noOpen }) => {
            const fileio = await import('/import-export/file-io.js');
            const SIO = window.SleapIO;
            if (typedThrows || noOpen) {
                window.SleapIO = { ...SIO };
                if (typedThrows) window.SleapIO.readSlpStreaming = async () => { throw new Error('this layout is not readable'); };
                if (noOpen) window.SleapIO.openH5Worker = async () => { throw new Error('cannot tell'); };
            }
            window.__plan = plan; window.__rawWorkers = 0;
            const out = {};
            try {
                const d = await fileio.parseSlpWithRawFallback(document.getElementById('__picked').files[0], () => {});
                out.opened = { frames: d.frames.length, typed: !!(d.sessions[0] && d.sessions[0]._typedSession) };
            } catch (e) { out.threw = String(e.message).slice(0, 120); }
            window.__plan = null; window.SleapIO = SIO;
            out.rawWorkers = window.__rawWorkers;
            return out;
        }, { plan: plan && { ...plan, file }, typedThrows, noOpen });
        unhide(file);
        return r;
    }
    let f4 = await viaFallback(files.project, { plan: { request: { type: V, path: 'frames' }, hiccup: true } });
    check(looksLikeAFailedRead(f4.threw) && f4.rawWorkers === 0, 'a failed read: the error stands', f4);
    f4 = await viaFallback(files.compound, { plan: { request: { type: V, path: 'frames' }, hiccup: true } });
    check(looksLikeAFailedRead(f4.threw) && f4.rawWorkers === 0, 'a failed read of a plain file: the error stands too', f4);
    f4 = await viaFallback(files.project, { typedThrows: true });
    check(f4.threw === 'this layout is not readable' && f4.rawWorkers === 0,
        'the typed reader can\'t read a file with /session_data: no fallback, its error stands (the raw worker would drop every group and all the 3D)', f4);
    for (const name of ['identity', 'category', 'multiview']) {
        f4 = await viaFallback(files[name], { typedThrows: true });
        check(f4.threw === 'this layout is not readable' && f4.rawWorkers === 0,
            `same for ${name}: its labels on detections or its groups are out of the raw worker's reach`, f4);
    }
    f4 = await viaFallback(files.compound, { typedThrows: true });
    check(f4.opened && f4.opened.frames === 60 && f4.rawWorkers === 1, 'the typed reader can\'t read a plain file: the raw worker reads it', f4);
    f4 = await viaFallback(files.compound, { typedThrows: true, noOpen: true });
    check(f4.threw === 'this layout is not readable' && f4.rawWorkers === 0, 'can\'t tell what the file holds: no fallback', f4);

    // ================================================================= 5
    console.log('\n-- 5. the raw worker --');
    async function rawParse(buf, plan, name, opts) {
        const file = await pick(buf, name);
        const r = await page.evaluate(async ({ plan, opts }) => {
            const fileio = await import('/import-export/file-io.js');
            window.__plan = plan; window.__probes = [];
            const out = {};
            try {
                const d = await fileio.parseSlpH5(document.getElementById('__picked').files[0], null, opts);
                out.parsed = { frames: d.frames.length, tracks: d.tracks.length, videos: d.videos.length, sessions: d.sessions.length,
                    identities: (d.identities || []).length, nodes: d.skeleton.nodes.length, columnar: d.columnar ? d.columnar.nFrames : undefined };
            } catch (e) { out.threw = String(e.message).slice(0, 160); }
            window.__plan = null;
            out.probes = window.__probes.slice();
            return out;
        }, { plan: plan && { ...plan, file }, opts });
        unhide(file);
        return r;
    }
    const rawHealthy = await rawParse(files.compound, {});
    check(rawHealthy.parsed && rawHealthy.parsed.frames === 60 && rawHealthy.parsed.tracks > 0, 'a healthy parse', rawHealthy.parsed);
    const rawProject = await rawParse(files.project, {});
    check(rawProject.parsed && rawProject.parsed.frames === 40 * 3 && rawProject.parsed.sessions === 1 && rawProject.parsed.identities > 0, 'a healthy parse of a project', rawProject.parsed);
    for (const [stage, what, buf] of [['^Skeleton:', 'tracks_json', files.project], ['^Tracks:', 'videos_json', files.project],
        ['^Reading frames', 'frames + instances', files.project], ['^instancesData:', 'points + pred_points', files.project],
        ['^Built ', 'sessions_json + identities_json', files.project],
        ['^Skeleton:', 'tracks_json, compound', files.compound], ['^Tracks:', 'videos_json, compound', files.compound],
        ['^Reading frames', 'frames + instances, compound', files.compound], ['^instancesData:', 'points + pred_points, compound', files.compound]]) {
        const r = await rawParse(buf, { stage, hiccup: true });
        const hit = fired(r) && reallyFailed(r);
        check(hit && !!r.threw && !r.parsed, `failed read of ${what}: an error, not a parse with it missing`,
            hit ? r.parsed : { never: 'the read did not fail: fix the test', r });
    }
    const colRaw = await rawParse(files.compound, { stage: '^Tracks:', hiccup: true }, undefined, { columnar: true });
    check(fired(colRaw) && !!colRaw.threw, 'the per-camera parse (columnar) too', colRaw);
    const rawSilent = [];
    let rawTotal = 0;
    for (let nth = 1; nth < 400; nth++) {
        const r = await rawParse(files.compound, { nth });
        if (!fired(r)) break;
        rawTotal++;
        if (r.parsed && JSON.stringify(r.parsed) !== JSON.stringify(rawHealthy.parsed)) rawSilent.push({ nth, parsed: r.parsed });
    }
    check(rawTotal > 5 && rawSilent.length === 0, `every read of a plain file in turn (${rawTotal}): an error or the same parse`, rawSilent.slice(0, 3));

    // Analysis .h5, both paths: optional tables were try/caught.
    const a = await rawParse(analysisH5, {}, 'cam.analysis.h5');
    check(a.parsed && a.parsed.nodes === 2 && a.parsed.frames === 4, 'analysis .h5: healthy (track_occupancy drops a frame)', a.parsed);
    const aFail = await rawParse(analysisH5, { stage: '^nTracks:', hiccup: true }, 'cam.analysis.h5');
    check(fired(aFail) && reallyFailed(aFail) && !!aFail.threw, 'analysis .h5: failed read of the optional tables is an error', aFail);
    async function rawLazy(plan) {
        const file = await pick(analysisH5, 'cam.analysis.h5');
        const r = await page.evaluate(async ({ plan }) => {
            window.__plan = plan; window.__probes = [];
            const worker = new Worker(new URL('loading/slp-import-worker.js?v=' + Date.now(), document.baseURI), { type: 'module' });
            const out = await new Promise((res) => {
                worker.onmessage = (e) => {
                    if (e.data.type === 'metadata') res({ nFrames: e.data.data.nFrames, occupancy: !!e.data.data.trackOccupancy });
                    else if (e.data.type === 'error') res({ threw: String(e.data.message).slice(0, 120) });
                };
                worker.postMessage({ type: 'open', file: document.getElementById('__picked').files[0] });
            });
            worker.terminate();
            window.__plan = null;
            out.probes = window.__probes.slice();
            return out;
        }, { plan: plan && { ...plan, file } });
        unhide(file);
        return r;
    }
    const la = await rawLazy({});
    check(la.nFrames === 5 && la.occupancy, 'analysis .h5, lazy: healthy', la);
    const lazySilent = [];
    let lazyTotal = 0;
    for (let nth = 1; nth < 200; nth++) {
        const r = await rawLazy({ nth });
        if (!fired(r)) break;
        lazyTotal++;
        if (!r.threw && !(r.nFrames === 5 && r.occupancy)) lazySilent.push({ nth, r });
    }
    check(lazyTotal > 3 && lazySilent.length === 0, `analysis .h5, lazy: every read in turn (${lazyTotal}): an error or the same result`, lazySilent.slice(0, 3));

    // ================================================================= 6
    console.log('\n-- 6. after a failed read, nothing more comes out of that worker --');
    const f6 = await pick(files.project);
    const after = await page.evaluate(async (file) => {
        const f = document.getElementById('__picked').files[0];
        window.__plan = { request: { type: 'getDatasetValue', path: 'frames' }, hiccup: true, file };
        window.__probes = [];
        const { openH5Worker } = await import('/lib/sleap-io/index.browser.js');
        const h5 = await openH5Worker(f, { h5wasmUrl: window.__h5wasmUrl });
        window.__plan = null;
        const out = {};
        const attempt = async (fn) => { try { await fn(); return 'answered'; } catch (e) { return (e.failedRead ? 'failed read: ' : 'other: ') + String(e.message).slice(0, 60); } };
        out.before = await attempt(() => h5.getDatasetValue('tracks_json'));
        out.frames = await attempt(() => h5.getDatasetValue('frames'));
        out.framesAgain = await attempt(() => h5.getDatasetValue('frames'));
        out.other = await attempt(() => h5.getDatasetValue('points'));
        out.keys = await attempt(() => h5.getKeys('session_data'));
        out.close = await attempt(() => h5.close());
        return out;
    }, f6);
    check(after.before === 'answered', 'a read before it is answered', after);
    check(/^failed read/.test(after.frames) && after.framesAgain === after.frames && after.other === after.frames && after.keys === after.frames,
        'the failed read, the same read again with the file back, another table, a listing: all that same error', after);
    check(after.close === 'answered', 'closing still answers, so the worker can be ended', after);
    unhide(f6);

    // ================================================================= 7
    console.log('\n-- 7. with the h5wasm cold-read patch --');
    const hole = await readWith(files.project, { zero: { type: V, path: 'frames' } });
    check(hole.probes.some(p => p.zeroed) && hole.digest === healthy.project,
        'a read that comes back as zeros (a cloud file still downloading) is repaired: no failure, the same project', hole);
    const holeStrings = await readWith(files.project, { zero: { type: V, path: 'sessions_json' } });
    check(holeStrings.probes.some(p => p.zeroed) && holeStrings.digest === healthy.project, 'same on a string table', holeStrings);
    const noReread = await readWith(files.project, { zeroAndHide: { type: V, path: 'frames' }, hiccup: true });
    check(noReread.probes.some(p => p.zeroed) && reallyFailed(noReread) && noReread.failedRead,
        'its re-read fails (the zeros can\'t be checked): that is a failed read', noReread);

    // ================================================================= 8
    console.log('\n-- 8. a range source --');
    const iso = await context.newPage();
    await iso.goto(`${ORIGIN}/__isolated.html`);
    await iso.waitForFunction(() => window.SIO, null, { timeout: 60000 });
    check(await iso.evaluate(() => self.crossOriginIsolated), 'the page is cross-origin isolated');
    await iso.evaluate(() => {
        const h5wasmUrl = new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href;
        const digest = (labels) => JSON.stringify({ frames: labels.labeledFrames.length, videos: labels.videos.length, tracks: labels.tracks.length,
            finite: labels.labeledFrames.reduce((n, f) => n + f.instances.reduce((m, i) => { let c = 0; for (let k = 0; k < i._xy.length; k += 2) if (isFinite(i._xy[k])) c++; return m + c; }, 0), 0),
            groups: labels.sessions.reduce((n, s) => n + [...s.frameGroups.values()].reduce((m, fg) => m + fg.instanceGroups.length, 0), 0) });
        window.__range = async (b64, opts) => {
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const cut = opts.cut ? Math.floor(bytes.length * opts.cut) : bytes.length;
            let n = 0, hit = false;
            const source = { size: bytes.length, readRange: async (o, l) => {
                n++;
                if (n === opts.nth) { hit = true; throw new Error('the drive was unplugged'); }
                return bytes.slice(o, Math.min(o + l, cut));
            } };
            const out = {};
            const quiet = console.error; console.error = () => {};
            try { out.digest = digest(await window.SIO.readSlpStreaming(source, { filenameHint: 'range.slp', openVideos: false, rawSessions: true, h5wasmUrl })); }
            catch (e) { out.threw = String(e && e.message || e).slice(0, 120); out.failedRead = !!(e && e.failedRead); }
            console.error = quiet;
            out.hit = hit;
            return out;
        };
    });
    const rangeProject = toBase64(files.project);
    const rangeHealthy = await iso.evaluate((b) => window.__range(b, {}), rangeProject);
    check(!!rangeHealthy.digest && JSON.parse(rangeHealthy.digest).groups === 80, 'healthy: opens', rangeHealthy);
    const rangeSilent = [];
    let rangeTotal = 0;
    for (let nth = 1; nth < 300; nth++) {
        const r = await iso.evaluate(([b, nth]) => window.__range(b, { nth }), [rangeProject, nth]);
        if (!r.hit) break;
        rangeTotal++;
        if (r.digest && r.digest !== rangeHealthy.digest) rangeSilent.push({ nth, digest: r.digest });
        else if (!r.digest && !r.failedRead) rangeSilent.push({ nth, threw: r.threw });
    }
    check(rangeTotal > 5 && rangeSilent.length === 0, `every read in turn throws (${rangeTotal}): an error or the same project, never zeros`, rangeSilent.slice(0, 3));
    const cutOff = await iso.evaluate((b) => window.__range(b, { cut: 0.5 }), rangeProject);
    check(cutOff.failedRead === true, 'a source that returns nothing for bytes inside its size: an error, not zeros', cutOff);
    await iso.close();

    // ================================================================= 9
    console.log('\n-- 9. a lazily opened embedded video --');
    const f9 = await pick(files.embedded);
    const lazyVideo = await page.evaluate(async (file) => {
        const f = document.getElementById('__picked').files[0];
        const open = (plan) => { window.__plan = plan; return window.SleapIO.readSlpStreaming(f, { openVideos: false, lazyVideoMetadata: true, h5wasmUrl: window.__h5wasmUrl }); };
        const out = {};
        const good = await open(null);
        window.__plan = null;
        const gb = good.videos[0].backend;
        await gb.ensureLoaded();
        const first = gb.frameNumbers[0];
        out.healthyFrameNumbers = gb.frameNumbers.length;
        out.healthyFrame = !!(await gb.getFrameBuffer(first));
        const labels = await open({ request: { type: 'getDatasetValue', path: 'video0/frame_numbers' }, hiccup: true, file });
        window.__plan = null;
        const be = labels.videos[0].backend;
        try { await be.ensureLoaded(); out.ensure = 'resolved'; } catch (e) { out.ensure = e.failedRead ? 'failed read' : 'other: ' + e.message; }
        out.frameNumbers = be.frameNumbers.length;
        out.frame = await be.getFrame(first);
        out.frameBuffer = await be.getFrameBuffer(first);
        try { await be.ensureLoaded(); out.ensure2 = 'resolved'; } catch (e) { out.ensure2 = e.failedRead ? 'failed read' : 'other: ' + e.message; }
        return out;
    }, f9);
    check(lazyVideo.healthyFrameNumbers > 0 && lazyVideo.healthyFrame, 'healthy: frame numbers and a stored frame', lazyVideo);
    check(lazyVideo.ensure === 'failed read', 'failed read of frame_numbers: ensureLoaded rejects, it does not go on with a direct index', lazyVideo);
    check(lazyVideo.frame === null && lazyVideo.frameBuffer === null, 'and frames read as no frame, never the wrong one', lazyVideo);
    check(lazyVideo.ensure2 === 'failed read', 'the next call tries again, and gets the same answer from that worker', lazyVideo);
    unhide(f9);

    // ================================================================= 10
    console.log('\n-- 10. a multi-session save --');
    async function twoLazySessions() {
        const made = await page.evaluate(async () => {
            const pd = await import('/pose/pose-data.js');
            const fileio = await import('/import-export/file-io.js');
            const { Skeleton, Camera, Instance, FrameGroup, Session } = pd;
            const out = {};
            for (const [name, F] of [['camA', 30], ['camB', 20]]) {
                const cam = new Camera(name, [[900, 0, 128], [0, 900, 128], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [256, 256]);
                const s = new Session([cam], new Skeleton('skeleton', ['n0', 'n1'], [[0, 1]]), ['t0'], name);
                for (let f = 0; f < F; f++) {
                    const fg = new FrameGroup(f); s.addFrameGroup(fg);
                    fg.addInstance(name, new Instance([[50 + f, 60], [70 + f, 80]], 0, 'predicted', 0.9));
                }
                out[name] = window.__b64(await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabels(s, name, false, { videoWidth: 256, videoHeight: 256, frameCount: F, videoPath: name + '.mp4' })));
            }
            return out;
        });
        const dir = fs.mkdtempSync(path.join(tmp, 'multi-'));
        const paths = {};
        for (const [name, b] of Object.entries(made)) {
            paths[name] = path.join(dir, name + '.slp');
            fs.writeFileSync(paths[name], fromBase64(b));
        }
        await page.setInputFiles('#__picked', [paths.camA, paths.camB]);
        await page.evaluate(async () => {
            const pd = await import('/pose/pose-data.js');
            const AS = await import('/ui/app-state.js');
            const { SioLazyLoader } = await import('/loading/sio-lazy-loader.js');
            const { Skeleton, Camera, Session } = pd;
            const picked = [...document.getElementById('__picked').files];
            const sessions = [];
            for (const name of ['camA', 'camB']) {
                const cam = new Camera(name, [[900, 0, 128], [0, 900, 128], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [256, 256]);
                const s = new Session([cam], new Skeleton('skeleton', ['n0', 'n1'], [[0, 1]]), ['t0'], name);
                const loader = new SioLazyLoader();
                await loader.open(name, picked.find(f => f.name === name + '.slp'));
                s.lazyLoader = loader;
                sessions.push(s);
            }
            AS.state.sessions = sessions; AS.state.session = sessions[0]; AS.state.activeSessionIdx = 0;
            AS.state.views = ['camA', 'camB'].map(n => ({ name: n, videoWidth: 256, videoHeight: 256, frameCount: 30 }));
            AS.state.videoFiles = ['camA', 'camB'].map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        });
        return paths;
    }
    const sessionsHeld = () => page.evaluate(async () => (await import('/ui/app-state.js')).state.sessions.map(s => !!s.lazyLoader));
    const multiSave = (plan) => page.evaluate(async (plan) => {
        const sl = await import('/import-export/save-load.js');
        const orig = URL.createObjectURL;
        let blob = null;
        URL.createObjectURL = (b) => { if (b.type === 'application/x-hdf5') blob = b; return orig.call(URL, b); };
        window.__plan = plan; window.__probes = [];
        try { await sl.saveProjectSlp(); } finally { URL.createObjectURL = orig; window.__plan = null; }
        const out = { status: (document.getElementById('statusText') || {}).textContent, wrote: !!blob, probes: window.__probes.slice() };
        if (blob) {
            const labels = await window.SleapIO.readSlpStreaming(new File([new Uint8Array(await blob.arrayBuffer())], 'saved.slp'), { openVideos: false, rawSessions: true, h5wasmUrl: window.__h5wasmUrl });
            out.frames = labels.labeledFrames.length;
            out.sessions = labels.sessions.length;
        }
        return out;
    }, plan);

    let p10 = await twoLazySessions();
    fs.renameSync(p10.camA, p10.camA + '.away');
    let s10 = await multiSave(null);
    check(!s10.wrote && /^Save failed/.test(s10.status) && looksLikeAFailedRead(s10.status), 'a source file gone: Save says so and writes nothing', s10);
    let held = await sessionsHeld();
    check(held.every(Boolean), 'nothing was released: the project is still there', held);
    fs.renameSync(p10.camA + '.away', p10.camA);
    s10 = await multiSave(null);
    check(s10.wrote && s10.frames === 50 && s10.sessions === 2, 'the file back, the same Save works, with every frame', s10);
    held = await sessionsHeld();
    check(held.every(h => !h), 'precondition: a multi-session save leaves every session released', held);
    s10 = await multiSave(null);
    check(!s10.wrote && /Cannot save/.test(s10.status), 'a second Save refuses, instead of writing an empty project over the first', s10);

    p10 = await twoLazySessions();
    s10 = await multiSave({ request: { type: V, path: 'frames' }, hiccup: true, file: p10.camA });
    check(!s10.wrote && /^Save failed/.test(s10.status) && s10.probes.some(p => p.failed), 'a read that fails in the second pass, after the check: Save fails and writes nothing', s10);
    s10 = await multiSave(null);
    check(!s10.wrote && /Cannot save/.test(s10.status), 'and the next Save refuses, instead of writing an empty project', s10);

    check(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 3));
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
