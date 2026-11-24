/**
 * desktop-training.mjs — the Training panel's LOCAL backend (`ui/training-panel.js` → the shim's
 * `lucidDesktop.sleapNn.training` → `src-tauri/src/training.rs`) against a MOCK Tauri runtime, with
 * the real desktop shim injected before any page script, as the Rust shell does. `training_run`
 * replays a REAL sleap-nn run recorded through the Rust path
 * (tests/fixtures/sleap-nn-training/run-3epoch.events.json: 3 epochs, 600 batch losses over ZMQ,
 * the stdout/stderr lines, the finished event) and serves a real validation image.
 *
 *  1. Desktop with sleap-nn: Backend defaults to Local; Start reads "Start Training"; Dry run is
 *     offered; Start waits for a runs folder.
 *  2. A runs folder holding the project is refused with Rust's reason; a models folder is taken
 *     ("1 trained run already there"); each view's video is found on disk from the opened files.
 *  3. Dry run: this sleap-nn has no --dry-run → "This sleap-nn can't do a dry run"; the token is
 *     released.
 *  4. Start: training_prepare gets the runs folder, one config OBJECT per model (W&B off, the run
 *     name), the training and validation files (split by moment: different frames, same 2-video
 *     table) and the disk paths in table order; models run one after another; the rows fill from the
 *     real progress (3 / 200 epochs, losses); the monitor shows the runtime lines, the plot and the
 *     validation image read from the run folder; Complete lists both run folders.
 *  5. Stop Early sends training_stop for the running token; Cancel sends training_cancel and ends
 *     "Training cancelled" with nothing else run.
 *  6. A failing model: the error names it and the exit code; Error output shows the traceback
 *     line, not the macOS objc noise.
 *  7. Post-training inference (default Random sample; 1-6 ran with Nothing): once both models
 *     trained, the Inference panel runs them (`runTrainedModels`): its Top-Down pipeline, the two run
 *     folders (centroid, then centered instance) as each view's model, one sleap-nn job per view on
 *     the same sampled frames, Skip user labeled honoured; REAL sleap-nn predictions merged (20 per
 *     view), your labels kept; the status box says "Predictions merged into the project".
 *  8. The skeleton changed while the models trained: skipped, naming the node; nothing runs.
 *  9. Trained runs, Fine-tune / Resume, View Metrics: the runs folder's trained runs are [Trained] entries of
 *     their head's slot (a REAL metrics JSON in each); picking one loads its config and offers its checkpoint;
 *     Full Configuration's training mode: Fine-tune locks Model, Resume every section; a model folder picked
 *     with Choose… gives its checkpoint (a legacy .h5 for Fine-tune), with a head-mismatch warning from its
 *     training_config.yaml; Resume refuses an .h5 and Start waits; training_prepare gets each model's
 *     `init`; View Metrics lists the runs with the real numbers, a row opens the detail (boxplot + list).
 *
 * Usage: node tests/e2e/desktop-training.mjs   (PORT= to move its server; SHOT=file.png screenshots 7, SHOT9=file.png 9)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTrainingSession } from './fixtures/training-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const SHIM = fs.readFileSync(path.join(repoRoot, 'src-tauri', 'js', 'lucid-desktop.js'), 'utf8');
const EVENTS = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'sleap-nn-training', 'run-3epoch.events.json'), 'utf8'));
const PNG_B64 = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'sleap-nn-training', 'validation-sample.png')).toString('base64');
// A REAL run's metrics (tests/fixtures/sleap-nn-training/run.full), put into every mock run folder.
const METRICS_JSON = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'sleap-nn-training', 'run.full', 'metrics.val.0.json'), 'utf8');
// REAL sleap-nn predictions (nodes A,B; 20 predicted instances on frames 0-9), as desktop-inference uses.
const PRED_B64 = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'sleap-nn-predictions', 'two-node.predictions.slp')).toString('base64');
const PORT = Number(process.env.PORT || 9399);
const BASE = `http://localhost:${PORT}`;

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 900)));
    if (!c) fails++;
};

/** Mock Tauri runtime, installed before the shim. */
function installMock(cfg) {
    const files = new Map();
    const dirs = new Set(['/']);
    const grants = [];
    const calls = [];
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
        runPlan: [],          // per training_run: 'ok' | 'fail' | 'hold' (wait for stop / cancel)
        mtimes: {},           // run folder -> mtime (newest last trained)
        prepared: [],         // training_prepare args, as sent
        picks: [],
        runsPicks: ['refuse', 'ok'],
        stopped: new Set(), cancelled: new Set(), released: new Set(),
        inference: [],        // run_python_command argv (post-training inference)
        modelPicks: [],       // what pick_model_directory returns, in order
        inputPick(p, directories) { grants.push({ path: p, kind: 'dir' }); mock.picks.push({ paths: [p], directories, seq: mock.picks.length + 1 }); },
        put(p, bytes) { files.set(p, bytes); mkdirp(parent(p)); },
    };
    window.__mock = mock;
    class Channel { constructor() { this.onmessage = null; } }
    window.__TAURI__ = { core: { Channel }, event: { listen: () => Promise.resolve(() => {}) } };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const handlers = {
        sleap_nn_status: () => ({ available: true, reason: '' }),
        detect_sleap_nn: () => ({ available: true, version: '0.3.5', path: '/home/u/.local/bin/sleap-nn' }),
        detect_gpu: () => 'mps',
        input_picks: () => ({ supported: true, picks: mock.picks.slice() }),
        path_stat: ({ path: p }) => {
            if (!readable(p)) deny(p);
            const f = files.get(p);
            return { exists: !!f || dirs.has(p), isFile: !!f, isDir: dirs.has(p), size: f ? f.length : 0, mtimeMs: 0 };
        },
        read_range: ({ path: p, offset, length }) => {
            if (!readable(p)) deny(p);
            const f = files.get(p);
            if (!f) throw 'no such file: ' + p;
            return f.slice(offset, offset + length).buffer;
        },
        pick_runs_directory: () => {
            const how = mock.runsPicks.shift() || 'ok';
            if (how === 'refuse') throw 'TRAINING_NOT_ALLOWED: /rec holds /rec/cam1, which the app saves to. Pick (or make) a folder for the models only, such as a models folder next to the project.';
            grants.push({ path: '/rec/models', kind: 'model' });
            mkdirp('/rec/models');
            return { path: '/rec/models', existingRuns: 1 };
        },
        training_prepare: ({ args }) => {
            mock.prepared.push(args);
            if (args.runsRoot !== '/rec/models') throw 'TRAINING_NOT_ALLOWED: runs folder';
            return 'tok' + mock.prepared.length;
        },
        training_run: async ({ token, modelIndex, dryRun, onEvent }) => {
            const send = (m) => { if (onEvent && onEvent.onmessage) onEvent.onmessage(m); };
            const args = mock.prepared[Number(String(token).slice(3)) - 1];
            const runName = args.models[modelIndex].runName;
            const runDir = '/rec/models/' + runName;
            if (dryRun) {
                send({ event: 'stderr', data: { line: 'Usage: sleap-nn train [OPTIONS] [OVERRIDES]...\n' } });
                send({ event: 'stderr', data: { line: "Error: No such option: --dry-run\n" } });
                send({ event: 'finished', data: { success: false, code: 2, stopped: false, cancelled: false, modelDir: null, error: null } });
                return false;
            }
            const plan = mock.runPlan.shift() || 'ok';
            mock.stopped.delete(token);   // Rust's stop flag belongs to the running model, not the token
            if (plan === 'fail') {
                send({ event: 'stderr', data: { line: 'objc[123]: Class AVFFrameReceiver is implemented in both a and b.\n' } });
                send({ event: 'stderr', data: { line: 'Traceback (most recent call last):\n' } });
                send({ event: 'stderr', data: { line: 'RuntimeError: MPS backend out of memory\n' } });
                send({ event: 'finished', data: { success: false, code: 1, stopped: false, cancelled: false, modelDir: null, error: null } });
                return false;
            }
            for (const n of ['0000', '0001', '0002']) mock.put(runDir + '/viz/validation.' + n + '.png', b64(cfg.png));
            // sleap-nn's run folder: its config (JSON is YAML) and the evaluation metrics JSON.
            const enc = new TextEncoder();
            mock.put(runDir + '/training_config.yaml', enc.encode(JSON.stringify(Object.assign({}, args.models[modelIndex].config))));
            mock.put(runDir + '/metrics.val.0.json', enc.encode(cfg.metrics));
            mock.mtimes[runDir] = Date.now();
            const evs = cfg.events.filter((e) => e.event !== 'finished');
            const half = plan === 'hold' ? evs.findIndex((e) => e.event === 'progress' && e.data.name === 'epoch_end') + 1 : evs.length;
            for (let i = 0; i < half; i += 60) { evs.slice(i, Math.min(half, i + 60)).forEach(send); await sleep(5); }
            if (plan === 'hold') {
                while (!mock.stopped.has(token) && !mock.cancelled.has(token)) await sleep(20);
                const cancelled = mock.cancelled.has(token);
                send({ event: 'finished', data: { success: !cancelled, code: cancelled ? -15 : 0, stopped: !cancelled, cancelled, modelDir: cancelled ? null : runDir, error: null } });
                return !cancelled;
            }
            mock.put(runDir + '/best.ckpt', new Uint8Array(4));
            send({ event: 'finished', data: { success: true, code: 0, stopped: false, cancelled: false, modelDir: runDir, error: null } });
            return true;
        },
        make_dir: ({ path: p }) => { if (!writable(p)) deny(p); mkdirp(p); return null; },
        list_dir: ({ path: p }) => {
            if (!readable(p)) deny(p);
            const out = [];
            const pre = p.replace(/\/$/, '') + '/';
            for (const d of dirs) if (d.startsWith(pre) && !d.slice(pre.length).includes('/')) out.push({ name: d.slice(pre.length), kind: 'directory', size: 0, mtimeMs: mock.mtimes[d] || 0 });
            for (const [f, b] of files) if (f.startsWith(pre) && !f.slice(pre.length).includes('/')) out.push({ name: f.slice(pre.length), kind: 'file', size: b.length, mtimeMs: 0 });
            return out.sort((a, b) => (a.name < b.name ? -1 : 1));
        },
        pick_model_directory: () => {
            const p = mock.modelPicks.shift();
            if (!p) return null;
            grants.push({ path: p, kind: 'model' });
            return p;
        },
        run_python_command: async ({ program, args, onEvent }) => {
            const send = (m) => { if (onEvent && onEvent.onmessage) onEvent.onmessage(m); };
            mock.inference.push({ program, args: args.slice() });
            const out = args[args.indexOf('--output_path') + 1];
            if (!writable(out)) deny(out);
            send({ event: 'stdout', data: { line: '{"n_processed": 10, "n_total": 10, "rate": 3.9, "eta": 0.0}\n' } });
            mock.put(out, b64(cfg.pred));
            send({ event: 'finished', data: { success: true, code: 0 } });
            return true;
        },
        training_stop: ({ token }) => { mock.stopped.add(token); return true; },
        training_cancel: ({ token }) => { mock.cancelled.add(token); return true; },
        training_release: ({ token }) => { mock.released.add(token); return null; },
    };
    window.__TAURI_INTERNALS__ = {
        invoke(cmd, args) {
            const name = cmd.replace(/^plugin:lucid\|/, '');
            calls.push({ name });
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
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    page.setDefaultTimeout(60000);
    page.on('pageerror', (e) => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.addInitScript(installMock, { events: EVENTS, png: PNG_B64, pred: PRED_B64, metrics: METRICS_JSON });
    await page.addInitScript(SHIM);
    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    await page.waitForSelector('.panel-rail-btn[data-tab="tabTraining"]', { state: 'attached' });
    await page.evaluate(async () => { (await import('./ui/training-panel.js')).showTrainingPanel(); });
    const T = () => page.evaluate(async () => (await import('./ui/training-panel.js'))._trainingState());

    console.log('\n1. Desktop with sleap-nn');
    await page.waitForFunction(() => /sleap-nn 0\.3\.5/.test(document.getElementById('trnEnvLine').textContent), null, { timeout: 20000 });
    await loadTrainingSession(page);
    await page.selectOption('#trnModelType', 'top_down');
    const s1 = await page.evaluate(() => ({
        backend: document.getElementById('trnBackend').value, start: document.getElementById('trnStart').textContent.trim(),
        dry: !document.getElementById('trnDryRun').hidden, why: document.getElementById('trnWhy').textContent,
        runs: !document.getElementById('trnRunsFolder').hidden,
    }));
    check(s1.backend === '__local__' && s1.start === 'Start Training' && s1.dry && s1.runs, 'Local by default: Start Training, Dry run, a Runs folder row', s1);
    check(/Choose a runs folder/.test(s1.why), 'Start waits for a runs folder', s1.why);
    const p1 = await page.evaluate(() => ({ target: document.getElementById('trnPostTarget').value,
        options: Array.from(document.querySelectorAll('#trnPostTarget option')).map((o) => o.value),
        samples: document.getElementById('trnPostSamples').value, existing: document.getElementById('trnPostExisting').value }));
    check(p1.target === 'random' && p1.options[0] === 'nothing' && p1.samples === '20' && p1.existing === 'replace',
        'Post-Training Inference Target: Nothing first, Random sample (20) by default, Existing predictions Replace', p1);
    await page.selectOption('#trnPostTarget', 'nothing');   // 2-6 train only; 7 runs the hand-off

    console.log('\n2. Runs folder; videos on disk');
    await page.click('#trnRunsChoose');
    await page.waitForFunction(() => /holds \/rec\/cam1/.test(document.querySelector('#tabTraining .inf-error-text:not([hidden])') ? document.querySelector('#tabTraining .inf-error-text:not([hidden])').textContent : ''));
    check(true, 'a folder holding the project is refused with Rust\'s reason');
    await page.click('#trnRunsChoose');
    await page.waitForFunction(() => document.querySelector('#trnRunsFolder .trn-path').textContent === '/rec/models');
    check(await page.evaluate(() => /1 trained run already there/.test(document.getElementById('trnRunsFolder').textContent)), 'the models folder is taken; its existing run is mentioned');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#trnViews .trn-vworker-text')).map((e) => e.textContent).join() === '/rec/cam1/cam1.mp4,/rec/cam2/cam2.mp4', null, { timeout: 20000 });
    check(true, 'each view\'s video is found on disk from the opened files');
    await page.waitForFunction(() => !document.getElementById('trnStart').disabled, null, { timeout: 20000 });

    console.log('\n3. Dry run');
    await page.click('#trnDryRun');
    await page.waitForFunction(() => /can.t do a dry run/.test(document.getElementById('trnDryResult').textContent), null, { timeout: 20000 });
    const d3 = await page.evaluate(() => ({ released: [...window.__mock.released], prepared: window.__mock.prepared.length }));
    check(d3.prepared === 1 && d3.released.includes('tok1'), 'This sleap-nn can\'t do a dry run; its token is released', d3);

    console.log('\n4. Start: two models, one after another');
    await page.fill('#trnMaxEpochs', '200');
    await page.click('#trnStart');
    await page.waitForFunction(() => /Complete/.test((document.querySelector('#trnProgress .inf-status-text') || {}).textContent || ''), null, { timeout: 60000 });
    const p4 = await page.evaluate(async () => {
        const a = window.__mock.prepared[1];
        const h5 = await import('h5wasm');
        await h5.ready;
        const read = (b64) => {
            const bin = atob(b64), bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const p = '/__dt_' + Math.random().toString(36).slice(2) + '.slp';
            h5.FS.writeFile(p, bytes);
            const f = new h5.File(p, 'r');
            const fr = f.get('frames');
            const cols = JSON.parse(fr.attrs.field_names.value);
            const v = Array.from(fr.value, Number), nc = cols.length, fi = cols.indexOf('frame_idx');
            const frames = [];
            for (let r = 0; r < v.length / nc; r++) frames.push(v[r * nc + fi]);
            const out = { frames, videos: Array.from(f.get('videos_json').value, (x) => JSON.parse(x).backend.filename) };
            f.close(); h5.FS.unlink(p);
            return out;
        };
        return {
            runsRoot: a.runsRoot, names: a.models.map((m) => m.runName),
            configs: a.models.map((m) => ({ obj: typeof m.config === 'object', wandb: m.config.trainer_config.use_wandb, run: m.config.trainer_config.run_name,
                head: Object.keys(m.config.model_config.head_configs).find((k) => m.config.model_config.head_configs[k] != null) })),
            videos: a.videoPaths, train: read(a.trainSlp), val: a.valSlp ? read(a.valSlp) : null,
        };
    });
    check(p4.runsRoot === '/rec/models' && p4.configs.every((c) => c.obj && c.wandb === false) && p4.configs.map((c) => c.head).join() === 'centroid,centered_instance' &&
        p4.configs.every((c, i) => c.run === p4.names[i]) && /^\d{6}_\d{6}\.centroid\.n=12$/.test(p4.names[0]),
        'training_prepare: the runs folder, one config OBJECT per model (W&B off, its run name)', p4);
    check(p4.videos.join() === '/rec/cam1/cam1.mp4,/rec/cam2/cam2.mp4' && p4.train.videos.join() === p4.videos.join() && p4.val && p4.val.videos.join() === p4.videos.join(),
        'disk paths in table order; train and validation share the video table', { videos: p4.videos, t: p4.train.videos });
    check(p4.val && p4.val.frames.every((f) => !p4.train.frames.includes(f)) && p4.train.frames.length + p4.val.frames.length === 12,
        'split by moment: validation frames are never training frames', { train: p4.train.frames, val: p4.val && p4.val.frames });
    const rows4 = await page.evaluate(() => Array.from(document.querySelectorAll('#trnRows .trn-row')).map((r) => r.textContent));
    check(rows4.length === 2 && rows4.every((t) => /3 epochs, best val_loss: \d\.\d{4}/.test(t) && /3 \/ 200 epochs/.test(t)),
        'both rows filled from the real progress: 3 epochs, best val_loss', rows4);
    const models4 = await page.evaluate(() => Array.from(document.querySelectorAll('#trnModels .trn-path-ok')).map((e) => e.textContent));
    check(models4.length === 2 && models4.every((m) => m.startsWith('/rec/models/')), 'Complete lists both run folders', models4);
    check(await page.evaluate(() => document.getElementById('trnDryResult').hidden), 'Start cleared the dry run\'s result (sleap-app)');
    await page.click('#trnRows .trn-row .trn-row-open');
    await page.waitForSelector('#trnMonitor');
    await page.waitForFunction(() => { const i = document.querySelector('#trnMonitor .trn-mon-vizimg'); return i && !i.hidden && i.naturalWidth > 0; }, null, { timeout: 20000 });
    const m4 = await page.evaluate(() => ({
        lines: Array.from(document.querySelectorAll('#trnMonRuntime > div')).map((d) => d.textContent),
        label: document.querySelector('#trnMonitor .trn-mon-vizlabel').textContent,
        dots: (() => { const c = document.querySelector('#trnMonitor canvas'); return !!c && c.width > 0; })(),
    }));
    check(m4.lines.some((l) => /^Best Epoch Validation Loss: \d\.\d{3}e-?\d+ \(epoch \d\)$/.test(l)) && m4.dots && m4.label === 'validation.0002.png',
        'the monitor: runtime lines, the plot and the run folder\'s validation image', m4);
    await page.keyboard.press('Escape');

    console.log('\n5. Stop Early, then Cancel');
    await page.click('#trnTrainAgain');
    await page.evaluate(() => { window.__mock.runPlan.push('hold', 'hold'); });
    await page.click('#trnStart');
    await page.waitForFunction(() => /1 \/ 200 epochs/.test((document.querySelector('#trnRows .trn-row') || {}).textContent || ''), null, { timeout: 30000 });
    await page.click('#trnStopEarly');
    await page.waitForFunction(() => window.__mock.stopped.size === 1, null, { timeout: 10000 });
    check(await page.evaluate(() => [...window.__mock.stopped][0] === 'tok3'), 'Stop Early → training_stop for the running token');
    await page.waitForFunction(() => /1 \/ 200 epochs/.test((document.querySelectorAll('#trnRows .trn-row')[1] || {}).textContent || ''), null, { timeout: 30000 });
    check(true, 'the run goes on with the next model');
    await page.click('#trnCancel');
    await page.waitForFunction(() => /Failed/.test((document.querySelector('#trnProgress .inf-status-text') || {}).textContent || ''), null, { timeout: 20000 });
    const c5 = await page.evaluate(() => ({ err: document.getElementById('trnError').textContent, cancelled: [...window.__mock.cancelled], rows: Array.from(document.querySelectorAll('#trnRows .trn-row')).map((r) => r.textContent) }));
    check(c5.err === 'Training cancelled' && c5.cancelled.join() === 'tok3' && /cancelled at epoch 1/.test(c5.rows[1]) && /1 epochs/.test(c5.rows[0]),
        'Cancel → training_cancel; "Training cancelled"; the stopped model kept, the cancelled one marked', c5);

    console.log('\n6. A failing model');
    await page.click('#trnRetry');
    await page.evaluate(() => { window.__mock.runPlan.push('fail'); });
    const nPrep = await page.evaluate(() => window.__mock.prepared.length);
    await page.click('#trnStart');
    await page.waitForFunction(() => /Failed/.test((document.querySelector('#trnProgress .inf-status-text') || {}).textContent || ''), null, { timeout: 20000 });
    const f6 = await page.evaluate(() => ({ err: document.getElementById('trnError').textContent, out: document.querySelector('.trn-errout pre').textContent,
        shown: !document.querySelector('.trn-errout').hidden, released: [...window.__mock.released] }));
    check(/^Training Centroid · all views failed \(exit code 1\)/.test(f6.err), 'the error names the model and the exit code', f6.err);
    check(f6.shown && /MPS backend out of memory/.test(f6.out) && !/objc/.test(f6.out), 'Error output: the traceback line, not the objc noise', f6.out);
    check(f6.released.includes('tok' + (nPrep + 1)), 'the failed run\'s token is released');
    check(await page.evaluate(() => document.getElementById('trnPostInference').hidden && window.__mock.inference.length === 0),
        'with Nothing (or a failed run) no inference runs and no status box shows');

    console.log('\n7. Post-training inference: the trained models run in the Inference panel');
    await page.click('#trnRetry');
    await page.selectOption('#trnPostTarget', 'random');
    await page.check('#trnPostSkipUser input');
    await page.click('#trnStart');
    await page.waitForFunction(() => { const b = document.getElementById('trnPostInference'); return b && !b.hidden && /merged into the project|failed|skipped/.test(b.textContent); }, null, { timeout: 60000 });
    const h7 = await page.evaluate(async () => {
        const I = (await import('./ui/inference-panel.js'))._inferenceState();
        const T = (await import('./ui/training-panel.js'))._trainingState();
        const AS = (await import('./ui/app-state.js')).state;
        const counts = {};
        for (const cam of ['cam1', 'cam2']) {
            let pred = 0, user = 0;
            for (const [, fg] of AS.session.frameGroups) {
                for (const i of (fg.instances.get(cam) || [])) { if (i && i.type === 'predicted') pred++; else if (i && i.type === 'user') user++; }
                for (const u of (fg.unlinkedInstances.get(cam) || [])) { if (u.instance.type === 'predicted') pred++; else user++; }
            }
            counts[cam] = { pred, user };
        }
        return {
            box: document.getElementById('trnPostInference').textContent,
            status: T.postRun.status, dirs: T.run.modelDirs.slice(),
            inference: window.__mock.inference.map((c) => c.args),
            pipeline: I.cfg.pipeline, frameRange: I.cfg.frameRange, skip: I.cfg.excludeUserLabeled,
            models: I.assignment.models.map((m) => m.paths), byView: Object.assign({}, I.assignment.byView),
            runStatus: I.run.status, counts,
        };
    });
    check(h7.status === 'completed' && /Predictions merged into the project/.test(h7.box), 'the status box: Predictions merged into the project', h7.box);
    check(h7.pipeline === 'top-down' && h7.frameRange === 'random' && h7.skip === true && h7.runStatus === 'completed',
        'the Inference panel ran Top-Down on a random sample, skipping user labeled frames', h7);
    check(h7.models.length === 1 && h7.models[0].join() === h7.dirs.join() && /centroid/.test(h7.dirs[0]) && /centered_instance/.test(h7.dirs[1]) &&
        h7.byView.cam1 === h7.byView.cam2, 'both views run the shared model: the two run folders, centroid first', { models: h7.models, byView: h7.byView });
    const mp = (a) => { const out = []; a.forEach((x, i) => { if (x === '--model_paths') out.push(a[i + 1]); }); return out.join(); };
    const fr = (a) => a[a.indexOf('--frames') + 1];
    check(h7.inference.length === 2 && h7.inference.every((a) => mp(a) === h7.dirs.join()) &&
        h7.inference.map((a) => a[a.indexOf('--data_path') + 1]).join() === '/rec/cam1/cam1.mp4,/rec/cam2/cam2.mp4',
        'one sleap-nn job per view, each with the two run folders', h7.inference);
    check(h7.inference.every((a) => a.indexOf('--frames') !== -1 && fr(a) === fr(h7.inference[0]) && fr(a).split(/[-,]/).every((f) => Number(f) >= 6)),
        'the same sampled frames on every view, user labeled frames (0-5) skipped', h7.inference.map(fr));
    check(h7.counts.cam1.pred >= 20 && h7.counts.cam2.pred >= 20 && h7.counts.cam1.user === 6 && h7.counts.cam2.user === 6,
        'REAL predictions merged into both views; the user labels kept', h7.counts);
    if (process.env.SHOT) {
        await page.evaluate(() => document.getElementById('trnPostInference').scrollIntoView({ block: 'center' }));
        await page.screenshot({ path: process.env.SHOT });
    }

    console.log('\n8. The skeleton changed while training');
    await page.click('#trnTrainAgain');
    await page.evaluate(() => { window.__mock.runPlan.push('hold', 'ok'); window.__mock.inference.length = 0; window.__mock.stopped.clear(); });
    await page.click('#trnStart');
    await page.waitForFunction(() => /1 \/ 200 epochs/.test((document.querySelector('#trnRows .trn-row') || {}).textContent || ''), null, { timeout: 30000 });
    // The skeleton the run started with (recorded at Start) no longer matches the project's: as after a
    // node edit during training (a real edit re-shapes every instance; the check only compares names).
    await page.evaluate(async () => { (await import('./ui/training-panel.js'))._trainingState().run.trainedNodes.push('Z'); });
    await page.click('#trnStopEarly');
    await page.waitForFunction(() => { const b = document.getElementById('trnPostInference'); return b && !b.hidden && /skipped/.test(b.textContent); }, null, { timeout: 60000 });
    const h8 = await page.evaluate(() => ({ box: document.getElementById('trnPostInference').textContent, n: window.__mock.inference.length }));
    check(/skeleton changed while the models trained \(removed Z\)/.test(h8.box) && h8.n === 0, 'skipped, naming the node; no inference ran', h8);

    console.log('\n9. Trained runs, Fine-tune / Resume, View Metrics');
    await page.selectOption('#trnPostTarget', 'nothing');
    await page.click('#trnTrainAgain');
    await page.evaluate(async () => (await import('./ui/training-panel.js'))._scanTrainedRuns());
    const t9 = await page.evaluate(async () => {
        const T = (await import('./ui/training-panel.js'))._trainingState();
        return { trained: T.local.trained.map((r) => ({ path: r.path, head: r.head, ck: r.checkpoint, runName: r.runName })),
            opts: Array.from(document.querySelectorAll('#trnSlot-centroid option')).map((o) => [o.value, o.textContent]) };
    });
    const cRuns = t9.trained.filter((r) => r.head === 'centroid');
    check(cRuns.length >= 1 && t9.trained.some((r) => r.head === 'centered_instance') && t9.trained.every((r) => /\/best\.ckpt$/.test(r.ck)),
        'the runs folder\'s trained runs (training_config.yaml + checkpoint) are found', t9.trained);
    const tOpts = t9.opts.filter((o) => o[0].startsWith('trained:'));
    check(tOpts.length === cRuns.length && tOpts.every((o) => /^\[Trained\] .*centroid.* \(training_config\.yaml\)$/.test(o[1])) && tOpts[0][0] === 'trained:' + cRuns[0].path,
        'the Centroid slot lists its head\'s trained runs, newest first', tOpts);
    const cRun = cRuns[0];
    await page.selectOption('#trnSlot-centroid', 'trained:' + cRun.path);
    await page.waitForFunction((p) => document.getElementById('trnSlot-centroid').value === 'trained:' + p, cRun.path);
    const s9 = await page.evaluate(async () => { const c = (await import('./ui/training-panel.js'))._trainingState().cfg.slots.centroid; return { tp: c.trainedPath, ck: c.checkpoint, mode: c.mode }; });
    check(s9.tp === cRun.path && s9.ck === cRun.ck && s9.mode === 'scratch', 'picking it loads its config and offers its checkpoint (Train from scratch)', s9);

    await page.click('#trnFullConfig');
    await page.waitForSelector('#trnConfigDialog');
    await page.click('#trnConfigDialog .tcd-tabs .trn-seg-btn[data-tab="centroid"]');
    await page.check('#tcdMode input[value="finetune"]');
    const dis = (id) => page.evaluate((i) => { const r = document.querySelector(`#trnConfigDialog .tcd-field[data-field="${i}"]`); const c = r && r.querySelector('input,select'); return c ? c.disabled : null; }, id);
    const l1 = { stride: await dis('maxStride'), epochs: await dis('maxEpochs'), path: await page.textContent('#tcdMode .tcd-ckpt-path') };
    await page.check('#tcdMode input[value="resume"]');
    const l2 = { stride: await dis('maxStride'), epochs: await dis('maxEpochs') };
    check(l1.stride === true && l1.epochs === false && l1.path === cRun.ck && l2.stride === true && l2.epochs === true,
        'Fine-tune locks Model; Resume locks every section; the run\'s checkpoint is shown', { l1, l2 });
    await page.check('#tcdMode input[value="finetune"]');
    await page.click('#trnConfigDialog .tcd-tabs .trn-seg-btn[data-tab="centered_instance"]');
    await page.check('#tcdMode input[value="finetune"]');
    check(/^Centered Instance: Choose the checkpoint to fine-tune from/.test(await page.textContent('#trnWhy')), 'Fine-tune without a checkpoint: Start waits for one');
    await page.evaluate((p) => { window.__mock.put('/models/legacy/best_model.h5', new Uint8Array(4)); window.__mock.modelPicks.push(p, '/models/legacy'); }, cRun.path);
    await page.click('#tcdChooseCheckpoint');
    await page.waitForFunction(() => /head mismatch/.test(document.querySelector('#tcdMode .tcd-ckpt-msg').textContent));
    const w9 = await page.evaluate(() => ({ path: document.querySelector('#tcdMode .tcd-ckpt-path').textContent, warn: document.querySelector('#tcdMode .tcd-ckpt-msg').className }));
    check(w9.path === cRun.ck && /tcd-ckpt-warn/.test(w9.warn), 'Choose… a centroid run for the centered-instance model: its checkpoint, with a head-mismatch warning', w9);
    await page.click('#tcdChooseCheckpoint');
    await page.waitForFunction(() => document.querySelector('#tcdMode .tcd-ckpt-path').textContent === '/models/legacy/best_model.h5');
    check(await page.isHidden('#tcdMode .tcd-ckpt-msg'), 'a legacy SLEAP folder: its best_model.h5 (Fine-tune takes .h5), no warning');
    await page.check('#tcdMode input[value="resume"]');
    const r9 = await page.evaluate(() => ({ msg: document.querySelector('#tcdMode .tcd-ckpt-msg').textContent, bad: /tcd-ckpt-bad/.test(document.querySelector('#tcdMode .tcd-ckpt-msg').className),
        why: document.getElementById('trnWhy').textContent, start: document.getElementById('trnStart').disabled }));
    check(r9.bad && /Resume training requires a \.ckpt file/.test(r9.msg) && r9.start && /Resume training requires/.test(r9.why), 'Resume refuses the .h5; Start waits', r9);
    await page.check('#tcdMode input[value="finetune"]');
    if (process.env.SHOT9) await page.screenshot({ path: process.env.SHOT9.replace(/\.png$/, '-mode.png') });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('trnConfigDialog'));
    check(/fine-tune from best\.ckpt/.test(await page.textContent('.trn-slots .trn-slot[data-slot="centroid"] .trn-slot-meta')), 'the slot says it fine-tunes from best.ckpt');

    const nPrep9 = await page.evaluate(() => window.__mock.prepared.length);
    await page.waitForFunction(() => !document.getElementById('trnStart').disabled, null, { timeout: 20000 });
    await page.click('#trnStart');
    await page.waitForFunction(() => /Complete/.test((document.querySelector('#trnProgress .inf-status-text') || {}).textContent || ''), null, { timeout: 60000 });
    const init9 = await page.evaluate((n) => window.__mock.prepared[n].models.map((m) => m.init || null), nPrep9);
    check(JSON.stringify(init9) === JSON.stringify([{ mode: 'finetune', checkpoint: cRun.ck }, { mode: 'finetune', checkpoint: '/models/legacy/best_model.h5' }]),
        'training_prepare: each model\'s init (Rust checks the checkpoint is in a model grant)', init9);

    await page.click('#trnViewMetrics');
    await page.waitForFunction(() => document.querySelectorAll('#trnMetrics .tmd-row').length >= 2 && !/Loading/.test(document.getElementById('trnMetrics').textContent), null, { timeout: 20000 });
    const oks = JSON.parse(METRICS_JSON).voc_metrics['oks_voc.mAP'].toFixed(4);
    const m9 = await page.evaluate(() => ({
        rows: Array.from(document.querySelectorAll('#trnMetrics .tmd-row')).map((r) => Array.from(r.cells).map((c) => c.textContent)),
        dirs: [...document.querySelectorAll('#trnMetrics .tmd-row')].map((r) => r.dataset.path),
        add: !document.getElementById('tmdAdd').hidden,
    }));
    const done9 = await page.evaluate(async () => (await import('./ui/training-panel.js'))._trainingState().run.modelDirs);
    check(m9.dirs.slice(0, 2).join() === done9.join() && m9.dirs.length > 2 && m9.rows.every((r) => r[4] === oks) && m9.rows[0][2] === 'Centroid' && /^UNet, max stride/.test(m9.rows[0][3]) && m9.add,
        'View Metrics: this run\'s models first, then the trained runs, with the real OKS mAP; Add Trained Model(s)… offered', { rows: m9.rows.slice(0, 3), oks });
    if (process.env.SHOT9) await page.screenshot({ path: process.env.SHOT9.replace(/\.png$/, '-table.png') });
    await page.click('#trnMetrics .tmd-row');
    await page.waitForSelector('#trnMetricsDetail .tmd-box');
    const d9 = await page.evaluate(() => ({ nodes: Array.from(document.querySelectorAll('#trnMetricsDetail .tmd-node')).map((t) => t.textContent),
        list: document.querySelectorAll('#trnMetricsDetail .tmd-list dt').length, title: document.getElementById('trnMetricsDetailTitle').textContent }));
    check(d9.nodes.length >= 1 && d9.list >= 10, 'a row opens the detail: per-node distance boxplots and the metrics list', d9);
    if (process.env.SHOT9) await page.screenshot({ path: process.env.SHOT9.replace(/\.png$/, '-detail.png') });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('trnMetricsDetail') && !!document.getElementById('trnMetrics'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('trnMetrics'));
    check(true, 'Esc closes the detail, then the table');
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
