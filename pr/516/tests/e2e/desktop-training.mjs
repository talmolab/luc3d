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
 *
 * Usage: node tests/e2e/desktop-training.mjs   (PORT= to move its server)
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
    const deny = (p) => { throw 'NOT_GRANTED: ' + p; };
    const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const mock = {
        files, dirs, grants, calls,
        runPlan: [],          // per training_run: 'ok' | 'fail' | 'hold' (wait for stop / cancel)
        prepared: [],         // training_prepare args, as sent
        picks: [],
        runsPicks: ['refuse', 'ok'],
        stopped: new Set(), cancelled: new Set(), released: new Set(),
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
    await page.addInitScript(installMock, { events: EVENTS, png: PNG_B64 });
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
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
