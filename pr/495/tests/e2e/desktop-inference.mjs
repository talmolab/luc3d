/**
 * desktop-inference.mjs — the desktop app's Inference panel
 * (`ui/inference-panel.js` + `ui/inference-merge.js`) against a MOCK Tauri
 * runtime, with the real desktop shim (`src-tauri/js/lucid-desktop.js`)
 * injected before any page script, as the Rust shell does.
 *
 * The mock implements the `lucid` commands the panel uses over an in-memory
 * filesystem with grants: sleap_nn_status, detect_sleap_nn, detect_gpu,
 * pick_directory (grants /rec), pick_model_directory (READ-ONLY model grant),
 * list_dir / path_stat / read_range / make_dir (grant-checked; make_dir refuses
 * a model folder), run_python_command (streams --gui progress JSON + stderr
 * noise over the Channel, then writes REAL sleap-nn output — the fixture
 * tests/fixtures/sleap-nn-predictions/two-node.predictions.slp, 20 predicted
 * instances on frames 0-9, nodes A,B — at --output_path) and cancel_command.
 *
 *  1. Web build (no Tauri): no Inference panel, inference-panel.js never fetched.
 *  2. Desktop build WITHOUT sleap-nn (status.available false): no panel.
 *  3. Desktop with sleap-nn: an Inference rail button + section; sections in
 *     sleap-app's order; Run disabled until a model and the video folder.
 *  4. A session of 2 views (cam1, cam2; skeleton A,B; cam1 has a USER label on
 *     frame 0 and an old PREDICTION on frame 1), opened from a folder the user
 *     picked in the page's file dialog (input_picks reports /rec, as the macOS
 *     capture does): each view's video path is found WITHOUT asking again
 *     (`lucidDesktop.fs.pathOfFile`), predictions go to /rec/predictions.
 *     Choose folder… (the fallback) gives the same paths; unchecking a view
 *     disables Run when it was the only one.
 *  5. Run Inference: one job per view, in order, distinct job ids; argv is a
 *     video --data_path, the model, --output_path under <folder>/predictions,
 *     no --video_index; the predictions come back as ungrouped predicted
 *     instances per view (20 each); the user label is untouched; the old
 *     prediction on a re-inferred frame is replaced; progress "10 / 10
 *     frames"; Complete; the project is dirty.
 *  6. A failing job: Failed, the error names the view and sleap-nn's last
 *     stderr line (not the macOS objc noise), and the next view is NOT run.
 *  7. REAL tracked sleap-nn output merged
 *     with "keep": its tracks arrive named `<view>: track_N`, so two views'
 *     `track_0` never become one LUCID track; instances carry them.
 *  8. A lazy project: its views are listed as blocked (TEMPORARY) and Run is
 *     disabled with the reason; the merge itself (for when that is lifted): the same merge removes the old prediction's STORE row,
 *     keeps the user label, adds 20 predictions, and pins the new frames
 *     (frameEvictionBlocker) so nothing is lost before a save.
 *
 * Usage: node tests/e2e/desktop-inference.mjs   (PORT= to move its server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const SHIM = fs.readFileSync(path.join(repoRoot, 'src-tauri', 'js', 'lucid-desktop.js'), 'utf8');
const PRED_B64 = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'sleap-nn-predictions',
    'two-node.predictions.slp')).toString('base64');
const TRACKED_B64 = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'sleap-nn-predictions',
    'two-node-tracked.predictions.slp')).toString('base64');
const PORT = Number(process.env.PORT || 9381);
const BASE = `http://localhost:${PORT}`;

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 800)));
    if (!c) fails++;
};

/** Mock Tauri runtime, installed before the shim. */
function installMock(cfg) {
    const files = new Map();             // path -> Uint8Array
    const dirs = new Set(['/']);
    const grants = [];                   // {path, kind:'dir'|'model'}
    const calls = [];
    const channels = [];
    const parent = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
    const mkdirp = (p) => { while (p && p !== '/') { dirs.add(p); p = parent(p); } };
    const under = (p, root) => p === root || p.startsWith(root.replace(/\/$/, '') + '/');
    const readable = (p) => grants.some((g) => under(p, g.path));
    const writable = (p) => grants.some((g) => g.kind === 'dir' && under(p, g.path)) &&
        !grants.some((g) => g.kind === 'model' && under(p, g.path));
    const deny = (p) => { throw 'NOT_GRANTED: ' + p; };
    const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const mock = {
        files, dirs, grants, calls,
        runPlan: [],                     // per run: 'ok' | {fail: stderrLine}
        picks: [],                       // what input_picks reports (the macOS capture)
        pickSupported: true,
        /** Pretend the user picked `path` in a page file-input dialog (input_paths.rs). */
        inputPick(path, directories) {
            grants.push({ path, kind: 'dir' });
            mock.picks.push({ paths: [path], directories, seq: mock.picks.length + 1 });
        },
        put(p, bytes) { files.set(p, bytes); mkdirp(parent(p)); },
        pred: b64(cfg.predB64),
    };
    window.__mock = mock;
    class Channel { constructor() { this.onmessage = null; channels.push(this); } }
    window.__TAURI__ = { core: { Channel }, event: { listen: () => Promise.resolve(() => {}) } };
    const handlers = {
        sleap_nn_status: () => ({ available: cfg.sleapNn, reason: cfg.sleapNn ? '' : 'not included in this build' }),
        detect_sleap_nn: () => ({ available: true, version: '0.3.5', path: '/home/u/.local/bin/sleap-nn' }),
        detect_gpu: () => 'mps',
        pick_directory: () => { grants.push({ path: '/rec', kind: 'dir' }); return '/rec'; },
        pick_model_directory: () => {
            grants.push({ path: '/models/topdown', kind: 'model' });
            mkdirp('/models/topdown');
            return '/models/topdown';
        },
        list_dir: ({ path: p }) => {
            if (!readable(p)) deny(p);
            const out = [];
            const pre = p.replace(/\/$/, '') + '/';
            for (const d of dirs) if (d.startsWith(pre) && !d.slice(pre.length).includes('/')) out.push({ name: d.slice(pre.length), kind: 'directory', size: 0, mtimeMs: 0 });
            for (const [f, b] of files) if (f.startsWith(pre) && !f.slice(pre.length).includes('/')) out.push({ name: f.slice(pre.length), kind: 'file', size: b.length, mtimeMs: 0 });
            return out.sort((a, b) => (a.name < b.name ? -1 : 1));
        },
        path_stat: ({ path: p }) => {
            if (!readable(p)) deny(p);
            const f = files.get(p);
            return { exists: !!f || dirs.has(p), isFile: !!f, isDir: dirs.has(p), size: f ? f.length : 0, mtimeMs: 0 };
        },
        make_dir: ({ path: p }) => { if (!writable(p)) deny(p); mkdirp(p); return null; },
        read_range: ({ path: p, offset, length }) => {
            if (!readable(p)) deny(p);
            const f = files.get(p);
            if (!f) throw 'no such file: ' + p;
            return f.slice(offset, offset + length).buffer;
        },
        run_python_command: async ({ program, args, onEvent, jobId }) => {
            const plan = mock.runPlan.shift() || 'ok';
            const send = (m) => { if (onEvent && onEvent.onmessage) onEvent.onmessage(m); };
            const val = (f) => args[args.indexOf(f) + 1];
            send({ event: 'stderr', data: { line: 'objc[123]: Class AVFFrameReceiver is implemented in both a and b.\n' } });
            send({ event: 'stdout', data: { line: '{"n_processed": 4, "n_total": 10, "rate": 2.5, "eta": 2.4}\n' } });
            await new Promise((r) => setTimeout(r, 30));
            if (plan !== 'ok') {
                send({ event: 'stderr', data: { line: plan.fail + '\n' } });
                send({ event: 'stderr', data: { line: 'objc[123]: Class AVFAudioReceiver is implemented in both a and b.\n' } });
                send({ event: 'finished', data: { success: false, code: 1 } });
                return false;
            }
            send({ event: 'stdout', data: { line: '{"n_processed": 10, "n_total": 10, "rate": 3.9, "eta": 0.0}\n' } });
            const out = val('--output_path');
            if (!writable(out)) deny(out);
            mock.put(out, mock.pred);
            send({ event: 'finished', data: { success: true, code: 0 } });
            return true;
        },
        cancel_command: () => null,
        input_picks: () => ({ supported: mock.pickSupported, picks: mock.picks.slice() }),
    };
    window.__TAURI_INTERNALS__ = {
        invoke(cmd, args) {
            const name = cmd.replace(/^plugin:lucid\|/, '');
            calls.push({ name, args: args ? JSON.parse(JSON.stringify(args, (k, v) => (v instanceof Channel ? '[channel]' : v))) : null });
            const h = handlers[name];
            if (!h) return Promise.resolve(null);
            try { return Promise.resolve(h(args || {})); } catch (e) { return Promise.reject(e); }
        },
        transformCallback() { return 0; },
    };
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();

    // ---------------------------------------------------------------- 1, 2
    console.log('\n1. Web build: the panel is there, remote only (no local sleap-nn)');
    {
        const page = await browser.newPage();
        page.on('pageerror', (e) => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
        await page.goto(`${BASE}/index.html`);
        await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 60000 });
        await page.waitForSelector('.panel-rail-btn[data-tab="tabInference"]', { timeout: 20000 });
        const w = await page.evaluate(() => ({
            backend: Array.from(document.querySelectorAll('#infBackend option')).map((o) => o.textContent),
            warn: !!document.querySelector('#tabInference .inf-warn:not([hidden])'),
            run: document.getElementById('infRun').textContent.trim(),
            desktop: !!window.lucidDesktop,
        }));
        check(!w.desktop && !w.backend.some((t) => /Local/.test(t)), 'no Local backend on the web', w);
        check(!w.warn, 'no "sleap-nn not detected" box on the web', w);
        check(/Remote/.test(w.run), 'Run says Remote', w);
        await page.close();
    }
    console.log('\n2. Desktop build without sleap-nn: remote-only panel');
    {
        const page = await browser.newPage();
        await page.addInitScript(installMock, { sleapNn: false, predB64: '' });
        await page.addInitScript(SHIM);
        await page.goto(`${BASE}/index.html`);
        await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.lucidDesktop, null, { timeout: 60000 });
        await page.waitForTimeout(800);
        check(await page.$('#tabInference') !== null, 'the panel is there (remote only) when sleap_nn_status says unavailable');
        check(await page.evaluate(() => Array.from(document.querySelectorAll('#infBackend option')).some((o) => /Local/.test(o.textContent) && o.disabled)), 'Local is listed but disabled');
        await page.close();
    }

    // ---------------------------------------------------------------- 3
    console.log('\n3. Desktop with sleap-nn: the panel');
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    page.setDefaultTimeout(120000);
    page.on('pageerror', (e) => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.addInitScript(installMock, { sleapNn: true, predB64: PRED_B64 });
    await page.addInitScript(SHIM);
    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    await page.waitForSelector('.panel-rail-btn[data-tab="tabInference"]', { timeout: 20000 });
    const p3 = await page.evaluate(async () => {
        const m = await import('/ui/inference-panel.js');
        m.showInferencePanel();
        await new Promise((r) => setTimeout(r, 300));
        const sec = document.querySelector('.panel-section[data-tab="tabInference"]');
        return {
            title: sec && sec.querySelector('.panel-section-title').textContent,
            sections: Array.from(document.querySelectorAll('#tabInference .inf-section > summary')).map((s) => s.textContent),
            runDisabled: document.getElementById('infRun').disabled,
            env: document.getElementById('infEnvLine').textContent,
            label: document.querySelector('.panel-rail-btn[data-tab="tabInference"] .panel-rail-label').textContent,
            expanded: sec.classList.contains('open') && !sec.classList.contains('folded'),
        };
    });
    check(p3.title === 'Inference' && p3.label === 'Inference', 'rail button and section named Inference', p3);
    check(p3.expanded, 'showInferencePanel opens it');
    check(JSON.stringify(p3.sections) === JSON.stringify(['Pipeline', 'Models', 'Data', 'Inference', 'Tracking', 'Advanced', 'Post-processing', 'Remote']),
        'sections in sleap-app\'s order', p3.sections);
    check(p3.runDisabled, 'Run disabled with no session/model/folder');
    check(/sleap-nn 0\.3\.5/.test(p3.env) && /MPS/.test(p3.env), 'detected sleap-nn and the GPU shown under Remote', p3.env);

    // ---------------------------------------------------------------- 4
    console.log('\n4. A two-view session; model; video folder');
    const sizes = await page.evaluate(async () => {
        const enc = await import('/ui/video-encode.js');
        const fio = await import('/import-export/file-io.js');
        const pd = await import('/pose/pose-data.js');
        const loader = await import('/loading/session-loader.js');
        const AS = await import('/ui/app-state.js');
        const CAMS = ['cam1', 'cam2'], W = 320, H = 240, N = 12, ROOT = 'rec';
        async function mp4(shade) {
            const canvas = document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            const c = canvas.getContext('2d');
            const wr = await enc.createMp4Writer({ canvas, width: W, height: H, fps: 10, bitrate: 300000, frameCount: N, keyFrameEveryFrames: 4 });
            for (let i = 0; i < N; i++) { c.fillStyle = 'rgb(' + shade + ',' + (10 * i) + ',80)'; c.fillRect(0, 0, W, H); await wr.addFrame(i); }
            return (await wr.finish()).blob;
        }
        let toml = '';
        CAMS.forEach((cn, i) => {
            toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [' + W + ', ' + H + ']\n'
                + 'matrix = [[600.0, 0.0, 160.0], [0.0, 600.0, 120.0], [0.0, 0.0, 1.0]]\n'
                + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\nrotation = [0.0, ' + (0.2 * i) + ', 0.0]\n'
                + 'translation = [' + (15 * i) + ', 0.0, 0.0]\n\n';
        });
        function mkFile(bits, rel, type) {
            const f = new File(bits, rel.split('/').pop(), { type: type || 'application/octet-stream' });
            Object.defineProperty(f, 'webkitRelativePath', { value: rel });
            return f;
        }
        // cam1: a USER label on frame 0, an old PREDICTION on frame 1. cam2: nothing.
        async function slp(cam) {
            const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
            const cams = CAMS.map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [W, H]));
            const s = new pd.Session(cams, new pd.Skeleton('sk', ['A', 'B'], [[0, 1]]), ['t0'], 'gen');
            if (cam === 'cam1') {
                const f0 = new pd.FrameGroup(0); s.addFrameGroup(f0);
                f0.addInstance(cam, new pd.Instance([[11, 22], [33, 44]], 0, 'user', 1));
                const f1 = new pd.FrameGroup(1); s.addFrameGroup(f1);
                f1.addInstance(cam, new pd.Instance([[1, 2], [3, 4]], 0, 'predicted', 0.5));
            } else {
                const f5 = new pd.FrameGroup(11); s.addFrameGroup(f5);
                f5.addInstance(cam, new pd.Instance([[5, 5], [6, 6]], 0, 'user', 1));
            }
            return fio.exportSlpClientSide(s, cam, false, { videoPath: ROOT + '/' + cam + '/' + cam + '.mp4', file: null,
                videoWidth: W, videoHeight: H, frameCount: N }, cam + '.slp', null);
        }
        const v1 = await mp4(10), v2 = await mp4(200);
        const files = [mkFile([toml], ROOT + '/calibration.toml', 'text/plain'),
            mkFile([v1], ROOT + '/cam1/cam1.mp4', 'video/mp4'), mkFile([v2], ROOT + '/cam2/cam2.mp4', 'video/mp4'),
            mkFile([await slp('cam1')], ROOT + '/cam1/cam1.slp'), mkFile([await slp('cam2')], ROOT + '/cam2/cam2.slp')];
        AS.state.sessions = []; AS.state.activeSessionIdx = 0; AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
        window.__mock.inputPick('/rec', true);   // the session folder, picked in the page's own dialog
        await loader.handleLoadSessionFolderPerCamera(files, false);
        // The same videos on "disk", plus a decoy of another size with cam1's name.
        const bytes = async (b) => new Uint8Array(await b.arrayBuffer());
        window.__mock.put('/rec/cam1/cam1.mp4', await bytes(v1));
        window.__mock.put('/rec/cam2/cam2.mp4', await bytes(v2));
        window.__mock.put('/rec/old/cam1.mp4', new Uint8Array(10));
        window.__mock.put('/rec/calibration.toml', new TextEncoder().encode(toml));
        return { v1: v1.size, v2: v2.size, views: AS.state.views.map((v) => v.name), skel: AS.state.session.skeleton.nodes };
    });
    check(sizes.views.join() === 'cam1,cam2' && sizes.skel.join() === 'A,B', 'session loaded', sizes);

    await page.click('#infAddModel');
    await page.dispatchEvent('#tabInference', 'pointerenter');
    await page.waitForFunction(() => document.querySelectorAll('#infViewVideos .inf-view .inf-ok').length === 2, null, { timeout: 15000 });
    const auto = await page.evaluate(() => ({
        views: Array.from(document.querySelectorAll('#infViewVideos .inf-view')).map((r) => r.textContent),
        root: document.getElementById('infVideoRoot').textContent,
        listed: window.__mock.calls.filter((c) => c.name === 'list_dir').length,
        chose: window.__mock.calls.filter((c) => c.name === 'pick_directory').length,
    }));
    check(auto.views[0] === 'cam1cam1/cam1.mp4' && auto.views[1] === 'cam2cam2/cam2.mp4',
        'video paths found from the folder the user OPENED, without asking again', auto);
    check(auto.chose === 0 && auto.listed === 0, 'no folder dialog, no folder scan', auto);
    check(auto.root === 'Predictions go to /rec/predictions', 'predictions go next to the session', auto.root);
    // Unchecking both views disables Run; re-checking enables it.
    await page.click('#infViewVideos .inf-view[data-view="cam1"] input');
    await page.click('#infViewVideos .inf-view[data-view="cam2"] input');
    const unchecked = await page.evaluate(() => document.getElementById('infRun').disabled);
    await page.click('#infViewVideos .inf-view[data-view="cam1"] input');
    await page.click('#infViewVideos .inf-view[data-view="cam2"] input');
    check(unchecked === true, 'no checked view → Run disabled');
    // The fallback: Choose folder… scans the picked folder and matches by path + size.
    await page.click('#infChooseVideos');
    await page.waitForFunction(() => window.__mock.calls.some((c) => c.name === 'list_dir'));
    await page.waitForFunction(() => document.querySelectorAll('#infViewVideos .inf-view .inf-ok').length === 2);
    const p4 = await page.evaluate(() => ({
        models: Array.from(document.querySelectorAll('#tabInference .inf-model-name')).map((e) => e.textContent),
        views: Array.from(document.querySelectorAll('#infViewVideos .inf-view')).map((r) => r.textContent),
        runDisabled: document.getElementById('infRun').disabled,
        modelCall: window.__mock.calls.filter((c) => c.name === 'pick_model_directory').length,
        modelGrant: window.__mock.grants.find((g) => g.path === '/models/topdown'),
    }));
    check(p4.modelCall === 1 && p4.modelGrant && p4.modelGrant.kind === 'model', 'Add opens the READ-ONLY model picker');
    check(p4.models.join() === 'topdown', 'the model chip shows the folder name', p4.models);
    check(p4.views[0] === 'cam1cam1/cam1.mp4' && p4.views[1] === 'cam2cam2/cam2.mp4',
        'Choose folder… matches each view to its own video by path + size (not the decoy)', p4.views);
    check(!p4.runDisabled, 'Run enabled');

    // ---------------------------------------------------------------- 5
    console.log('\n5. Run Inference');
    await page.click('#infRun');
    await page.waitForFunction(() => /Complete|Failed/.test(document.querySelector('#infProgress .inf-status-text').textContent), null, { timeout: 60000 });
    const p5 = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        const per = {};
        for (const [f, fg] of s.frameGroups) {
            for (const [cam, xs] of fg.instances) for (const i of xs) { const k = cam + ':' + i.type; per[k] = (per[k] || 0) + 1; }
            for (const [cam, xs] of fg.unlinkedInstances) for (const u of xs) { const k = cam + ':' + u.instance.type + ':ul'; per[k] = (per[k] || 0) + 1; }
        }
        const f0 = s.frameGroups.get(0);
        const userAt0 = [...(f0.instances.get('cam1') || []), ...(f0.unlinkedInstances.get('cam1') || []).map((u) => u.instance)]
            .filter((i) => i.type === 'user').map((i) => [i.getPoint(0), i.getPoint(1)]);
        const f1 = s.frameGroups.get(1);
        const oldPredAt1 = [...(f1.instances.get('cam1') || []), ...(f1.unlinkedInstances.get('cam1') || []).map((u) => u.instance)]
            .filter((i) => i.type === 'predicted' && i.getPoint(0) && i.getPoint(0)[0] === 1 && i.getPoint(0)[1] === 2).length;
        const runs = window.__mock.calls.filter((c) => c.name === 'run_python_command');
        return {
            status: document.querySelector('#infProgress .inf-status-text').textContent,
            counts: document.querySelector('#infProgress .inf-counts').textContent,
            jobLine: document.querySelector('#infProgress .inf-muted').textContent,
            error: document.querySelector('#infProgress .inf-errbox').textContent,
            per, userAt0, oldPredAt1,
            runs: runs.map((r) => ({ program: r.args.program, jobId: r.args.jobId, args: r.args.args })),
            outputs: [...window.__mock.files.keys()].filter((k) => /predictions\//.test(k)),
            dirty: window.__lucid.state.isDirty,
            log: Array.from(window.__mock.calls).length,
            logText: document.getElementById('infLog').textContent,
        };
    });
    check(p5.status === 'Complete', 'status Complete', p5);
    check(p5.runs.length === 2 && p5.runs[0].program === 'sleap-nn', 'one sleap-nn job per view', p5.runs.length);
    check(p5.runs[0].jobId && p5.runs[1].jobId && p5.runs[0].jobId !== p5.runs[1].jobId, 'distinct job ids');
    const a0 = p5.runs[0].args, val = (a, f) => a[a.indexOf(f) + 1];
    check(a0[0] === 'predict' && a0[1] === '--gui', 'predict --gui (sleap-nn 0.3.5)');
    check(val(a0, '--data_path') === '/rec/cam1/cam1.mp4' && val(p5.runs[1].args, '--data_path') === '/rec/cam2/cam2.mp4',
        'each job reads its own view\'s video file');
    check(val(a0, '--model_paths') === '/models/topdown', 'same model for every view');
    check(/^\/rec\/predictions\/cam1\.\d{8}_\d{6}\.predictions\.slp$/.test(val(a0, '--output_path')), 'output under <folder>/predictions', val(a0, '--output_path'));
    check(!a0.includes('--video_index') && !a0.includes('--frames'), 'no --video_index; whole video → no --frames');
    check(p5.outputs.length === 2, 'two predictions files written');
    check(p5.per['cam1:predicted:ul'] === 20 && p5.per['cam2:predicted:ul'] === 20,
        '20 ungrouped predicted instances per view', p5.per);
    check(p5.userAt0.length === 1 && JSON.stringify(p5.userAt0[0]) === '[[11,22],[33,44]]', 'the user label is untouched', p5.userAt0);
    check(p5.per['cam1:user'] + (p5.per['cam1:user:ul'] || 0) === 1 || (p5.per['cam1:user:ul'] || 0) + (p5.per['cam1:user'] || 0) === 1,
        'cam1 still has exactly one user instance', p5.per);
    check(p5.oldPredAt1 === 0, 'the old prediction on re-inferred frame 1 was replaced');
    check(/10 \/ 10 frames/.test(p5.counts), 'progress reached 10 / 10 frames', p5.counts);
    check(/View 2 of 2: cam2/.test(p5.jobLine), 'the job line names the view', p5.jobLine);
    check(p5.dirty === true, 'the project is dirty');
    check(/✓ cam2: 20 predicted instances on 10 frames/.test(p5.logText), 'the log reports the merge', p5.logText);

    // ---------------------------------------------------------------- 6
    console.log('\n6. A failing job stops the queue');
    await page.click('#infDismiss');
    await page.evaluate(() => { window.__mock.runPlan = [{ fail: 'FileNotFoundError: best.ckpt not found' }, 'ok']; });
    const before = await page.evaluate(() => window.__mock.calls.filter((c) => c.name === 'run_python_command').length);
    await page.click('#infRun');
    await page.waitForFunction(() => /Complete|Failed/.test(document.querySelector('#infProgress .inf-status-text').textContent), null, { timeout: 60000 });
    const p6 = await page.evaluate(() => ({
        status: document.querySelector('#infProgress .inf-status-text').textContent,
        error: document.querySelector('#infProgress .inf-errbox').textContent,
        runs: window.__mock.calls.filter((c) => c.name === 'run_python_command').length,
        cancelHidden: document.getElementById('infCancel').hidden,
        dismissShown: !document.getElementById('infDismiss').closest('.inf-actions').hidden,
    }));
    check(p6.status === 'Failed', 'Failed', p6);
    check(p6.error === 'Inference failed on cam1 (exit code 1): FileNotFoundError: best.ckpt not found',
        'the error names the view and sleap-nn\'s last real stderr line', p6.error);
    check(p6.runs - before === 1, 'cam2 was not run after cam1 failed');
    check(p6.cancelHidden && p6.dismissShown, 'Cancel hidden, Copy Log / Dismiss shown');

    // ---------------------------------------------------------------- 7
    console.log('\n7. Real tracked output: tracks named per view');
    const p8 = await page.evaluate(async (b64) => {
        const merge = await import('/ui/inference-merge.js');
        const s = window.__lucid.state.session;
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const r = await merge.mergeViewPredictions(new File([bytes], 'cam2.predictions.slp'), 'cam2', 'keep');
        const named = new Set();
        let onTrack = 0;
        for (const f of [0, 1, 2, 3, 4, 10, 11]) {
            for (const u of s.frameGroups.get(f).unlinkedInstances.get('cam2') || []) {
                const t = u.instance.trackIdx;
                if (t != null && /^cam2: track_\d$/.test(s.tracks[t])) { onTrack++; named.add(s.tracks[t]); }
            }
        }
        return { r, tracks: s.tracks.slice(), onTrack, named: [...named].sort() };
    }, TRACKED_B64);
    check(p8.r.instances === 14 && p8.r.frames === 7, '14 instances on 7 frames', p8.r);
    check(p8.named.join() === 'cam2: track_0,cam2: track_1' && p8.onTrack === 14,
        'sleap-nn tracks arrive as "cam2: track_N" and every instance carries one', p8);
    check(!p8.tracks.includes('track_0'), 'no bare track_0 that another view could share', p8.tracks);

    // ---------------------------------------------------------------- 8
    console.log('\n8. A lazy project: the same merge, store-backed');
    await page.click('#infDismiss');   // the failed run from 6 would otherwise hold the panel
    const p7 = await page.evaluate(async (predB64) => {
        const fio = await import('/import-export/file-io.js');
        const pd = await import('/pose/pose-data.js');
        const lr = await import('/pose/lazy-residency.js');
        const merge = await import('/ui/inference-merge.js');
        const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
        const cams = ['cam1', 'cam2'].map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [320, 240]));
        const s = new pd.Session(cams, new pd.Skeleton('sk', ['A', 'B'], [[0, 1]]), ['t0'], 'lazy');
        const f0 = new pd.FrameGroup(0); s.addFrameGroup(f0);
        f0.addUnlinkedInstance('cam1', new pd.UnlinkedInstance(new pd.Instance([[11, 22], [33, 44]], 0, 'user', 1), 'cam1'));
        const f1 = new pd.FrameGroup(1); s.addFrameGroup(f1);
        f1.addUnlinkedInstance('cam1', new pd.UnlinkedInstance(new pd.Instance([[1, 2], [3, 4]], 0, 'predicted', 0.5), 'cam1'));
        for (let f = 2; f < 40; f++) {
            const fg = new pd.FrameGroup(f); s.addFrameGroup(fg);
            fg.addUnlinkedInstance('cam2', new pd.UnlinkedInstance(new pd.Instance([[f, f], [f + 1, f]], 0, 'user', 1), 'cam2'));
        }
        const views = ['cam1', 'cam2'].map((n) => ({ name: n, videoWidth: 320, videoHeight: 240, frameCount: 40 }));
        const vfs = ['cam1', 'cam2'].map((n) => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const bytes = await window.SleapIO.saveSlpToBytes(fio.buildSlpLabelsAllViews(s, views, vfs));
        let err = null, done = false;
        (async () => {
            try { await (await import('/loading/session-loader.js')).handleLoadProjectSlpLazy(new File([bytes], 'lazy.slp')); done = true; }
            catch (e) { err = String(e && e.stack || e).slice(0, 400); }
        })();
        for (let i = 0; i < 600 && !done && !err; i++) {
            const b = [...document.querySelectorAll('button')].find((x) => /Skip|Later/i.test(x.textContent || '') && x.offsetParent);
            if (b) b.click();
            await new Promise((r) => setTimeout(r, 100));
        }
        const L = window.__lucid.state.session;
        if (err || !L || !L.lazyLoader) return { err: err || 'not lazy' };
        document.getElementById('tabInference').dispatchEvent(new Event('pointerenter'));
        await new Promise((r) => setTimeout(r, 300));
        const panel = {
            rows: Array.from(document.querySelectorAll('#infViewVideos .inf-view')).map((r) => ({
                view: r.dataset.view, why: r.querySelector('.inf-view-why').textContent,
                disabled: r.querySelector('input').disabled })),
            runDisabled: document.getElementById('infRun').disabled,
            runWhy: document.querySelector('#tabInference .inf-run + .inf-muted').textContent,
        };
        const before1 = L.lazyLoader.describeStoreFrame('cam1', 1).count;
        // Evict what is resident so the merge has to hydrate.
        const pred = Uint8Array.from(atob(predB64), (c) => c.charCodeAt(0));
        const r = await merge.mergeViewPredictions(new File([pred], 'cam1.predictions.slp'), 'cam1', 'replace');
        const after1 = L.lazyLoader.describeStoreFrame('cam1', 1).count;
        const after0 = L.lazyLoader.describeStoreFrame('cam1', 0).count;
        let preds = 0, users0 = 0;
        for (let f = 0; f < 10; f++) {
            const fg = L.frameGroups.get(f);
            if (!fg) continue;
            for (const u of fg.unlinkedInstances.get('cam1') || []) {
                if (u.instance.type === 'predicted') preds++;
                if (f === 0 && u.instance.type === 'user') users0++;
            }
            for (const i of fg.instances.get('cam1') || []) if (f === 0 && i.type === 'user') users0++;
        }
        const pinned = [];
        for (let f = 0; f < 10; f++) pinned.push(lr.frameEvictionBlocker(L, f, L.frameGroups.get(f), null));
        return { r, before1, after1, after0, preds, users0, pinned, panel };
    }, PRED_B64);
    check(!p7.err, 'lazy project opened', p7.err);
    if (!p7.err) {
        check(p7.panel.rows.length === 2 && p7.panel.rows.every((r) => r.disabled && /lazy-loaded/.test(r.why)),
            'lazy-loaded views are listed as blocked (TEMPORARY)', p7.panel);
        check(p7.panel.runDisabled && /lazy-loaded views is not supported yet/.test(p7.panel.runWhy),
            'Run is disabled and says why', p7.panel);
        check(p7.before1 === 1 && p7.after1 === 0, 'the old prediction\'s STORE row is deleted (replace)', p7);
        check(p7.after0 === 1 && p7.users0 === 1, 'the user label (store row + instance) is kept', p7);
        check(p7.r.instances === 20 && p7.preds === 20, '20 predictions added on frames 0-9', p7);
        check(p7.pinned.every((b) => b !== null), 'every frame with new predictions is pinned until saved', p7.pinned);
    }
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
