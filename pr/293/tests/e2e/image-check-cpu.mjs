/**
 * image-check-cpu.mjs — the image ID-switch check with NO GPU: the real model on
 * the CPU, in module workers (ui/image-embedder.js `createCpuModelPool`,
 * ui/image-model-worker.js). It used to refuse to run ("needs WebGPU").
 *
 * Headless Chromium has no GPU adapter — or, with --enable-unsafe-webgpu, only
 * SwiftShader, a SOFTWARE one: the two situations of a machine or VM with no GPU —
 * so this runs the real CPU path, with the real model fetched from the CDN (skips
 * cleanly when offline). Asserted:
 *  1. `pickImageDevice` sends both to the CPU (SwiftShader ran the model 10x slower
 *     than one CPU worker).
 *  2. The CPU embedder's vectors equal the same crops run through the model on the
 *     main thread, per animal AND camera (so the split across workers keeps order).
 *  3. The page stays responsive while the workers compute (on the main thread one
 *     run blocks it: 2.6 s for 8 crops).
 *  4. `releaseFrames` terminates the workers (~600 MB each).
 *  5. The real dialog, with nothing injected — the path the Tracking Wizard's
 *     after-tracking check takes — runs instead of refusing, says it is on the CPU,
 *     embeds frames, and cancels.
 *
 * Run: node tests/e2e/image-check-cpu.mjs   (downloads the ~88 MB fp32 model)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8277);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const url = fs.readFileSync(path.join(repoRoot, 'ui', 'image-embedder.js'), 'utf8').match(/TRANSFORMERS_URL = '([^']+)'/)[1];
try { const r = await fetch(url, { method: 'HEAD' }); if (!r.ok) throw new Error('HTTP ' + r.status); }
catch (e) { console.log('SKIP — the model runtime is not reachable (' + e.message + ')'); process.exit(0); }

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // A tracked session whose groups also carry 2D instances, and camera "videos" that return one textured
    // frame: 3 animals, 3 cameras, labels of one pair swapped after an encounter (as id-switch-image-check.mjs).
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'), AS = await import('/ui/app-state.js');
        const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
            'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
        const TEMPLATE = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
            Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
            Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0],
            Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
        const CAMS = ['camA', 'camB', 'camC'], STEP = 4, SWAP = 16;
        const pose = (cx, cy, h) => { const out = new Float64Array(45), c = Math.cos(h), s = Math.sin(h);
            NODES.forEach((n, i) => { const [x, y, z] = TEMPLATE[n]; out[i * 3] = cx + c * x - s * y; out[i * 3 + 1] = cy + s * x + c * y; out[i * 3 + 2] = z; }); return out; };
        // each camera sees the arena (x -150..550, y -150..500 mm) at 0.8 px/mm, shifted a little per camera
        const inst = (P, ci) => ({ getPoint: (i) => [130 + 12 * ci + 0.8 * P[i * 3], 130 + 8 * ci + 0.8 * P[i * 3 + 1]] });
        const home = [[0, 0], [400, 0], [200, 350]], PAIRS = [[0, 1], [1, 2], [0, 2]];
        const events = []; for (let e = 0; e < 24; e++) events.push({ pair: PAIRS[e % 3], t0: 300 + e * 260 });
        const T = 300 + 24 * 260 + 300;
        const session = new pd.Session([], new pd.Skeleton('m', NODES, []), [], 'CpuFixture');
        for (let i = 0; i < 3; i++) session.addIdentity('id_' + i);
        let gid = 1; const label = [0, 1, 2];
        for (let t = 0; t < T; t++) {
            const pos = home.map(h => [h[0] + 15 * Math.sin(t / 37 + h[0]), h[1] + 15 * Math.cos(t / 41 + h[1])]);
            for (const ev of events) { const d = t - ev.t0; if (d < 0 || d > 100) continue;
                const [a, b] = ev.pair, mid = [(home[a][0] + home[b][0]) / 2, (home[a][1] + home[b][1]) / 2];
                const f = d < 40 ? d / 40 : d <= 60 ? 1 : 1 - (d - 60) / 40;
                for (const [k, side] of [[a, -1], [b, 1]]) pos[k] = [home[k][0] + f * (mid[0] + side * 10 - home[k][0]), home[k][1] + f * (mid[1] - home[k][1])]; }
            session.instanceGroups.set(t * STEP, [0, 1, 2].map(k => { const g = new pd.InstanceGroup(gid++, session.identities[label[k]].id);
                g.points3d = pose(pos[k][0], pos[k][1], (t / 50 + k) % (2 * Math.PI)); CAMS.forEach((c, ci) => g.instances.set(c, inst(g.points3d, ci))); return g; }));
            if (t === events[SWAP].t0 + 60) { const [a, b] = events[SWAP].pair; [label[a], label[b]] = [label[b], label[a]]; }
        }
        // one textured frame for every camera and frame index
        const cv = new OffscreenCanvas(640, 480), cx = cv.getContext('2d');
        for (let i = 0; i < 500; i++) { cx.fillStyle = `hsl(${(i * 37) % 360},45%,${15 + (i * 13) % 70}%)`; cx.beginPath(); cx.arc((i * 97) % 640, (i * 53) % 480, 4 + (i % 25), 0, 7); cx.fill(); }
        const bmp = await createImageBitmap(cv);
        AS.state.sessions = [session]; AS.state.activeSessionIdx = 0; AS.state.session = session;
        AS.state.totalFrames = T * STEP; AS.state.currentFrame = 0; AS.state.fps = 60;
        AS.state.views = CAMS.map(c => ({ cameraName: c, decoder: { getFrame: async () => bmp } }));
        window.__cams = CAMS; window.__bmp = bmp;
    });

    // ---- 1. no adapter, and a software adapter, are both sent to the CPU
    const pick = (p) => p.evaluate(async () => {
        const E = await import('/ui/image-embedder.js'), a = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
        return { picked: await E.pickImageDevice(), fallback: !!(a && a.info && a.info.isFallbackAdapter), hasAdapter: !!a };
    });
    const describe = (d) => d.hasAdapter ? (d.fallback ? 'a software adapter' : 'a HARDWARE adapter?') : 'no adapter';
    const dev = await pick(page);
    check(dev.picked.kind === 'cpu' && (!dev.hasAdapter || dev.fallback), `headless Chromium (${describe(dev)}) runs the model on the CPU — "${dev.picked.why}"`);
    {
        const b2 = await chromium.launch({ args: ['--enable-unsafe-webgpu'] });
        try {
            const p2 = await b2.newPage();
            await p2.goto(`http://localhost:${PORT}/tests/test-runner.html`).catch(() => {});
            const sw = await pick(p2);
            check(sw.hasAdapter && sw.fallback && sw.picked.kind === 'cpu' && /software adapter/.test(sw.picked.why) && /swiftshader/i.test(sw.picked.adapter.name),
                  `with WebGPU on (${describe(sw)}: ${sw.picked.adapter && sw.picked.adapter.name}) it still runs on the CPU — "${sw.picked.why}"`);
        } finally { await b2.close(); }
    }

    // ---- 2-4. the CPU embedder: correct vectors in the right places, a responsive page, workers released
    const emb = await page.evaluate(async () => {
        const E = await import('/ui/image-embedder.js'), AS = await import('/ui/app-state.js');
        const session = AS.state.session, cams = window.__cams;
        const statuses = [];
        const e = await E.createImageEmbedder(session, { cpuWorkers: 2, maxViewsPerAnimal: 0, onStatus: t => statuses.push(t) });
        const device = e.device(), line = E.formatEmbedDevice(device, null);
        const frames = [0, 4, 8, 12], itemsAt = (f) => session.instanceGroups.get(f).map((g, k) => ({ k, group: g }));
        let last = performance.now(), worst = 0;
        const tick = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 50);
        const t0 = performance.now();
        const out = await Promise.all(frames.map(f => e.getEmbeddings(f, itemsAt(f))));
        const seconds = (performance.now() - t0) / 1000;
        clearInterval(tick);
        const busy = e.busyMs(), stats = e.stats();
        // the reference: frame 0's crops, cut the way the embedder cuts them, through the model on the main thread
        const sk = E.skeletonIndex(session.skeleton.nodes), items = itemsAt(0);
        const geo = E.frameCropGeometry(session, 0, items, cams, cams.map(() => 0), sk);
        const canvas = new OffscreenCanvas(E.CROP, E.CROP), SZ = 3 * E.INPUT * E.INPUT, keys = [], data = new Float32Array(items.length * cams.length * SZ);
        cams.forEach((cam, vi) => items.forEach((it, ii) => { const g = geo[vi][ii]; if (!g) return;
            const others = geo[vi].filter((g2, j) => j !== ii && g2).map(g2 => g2.hull);
            E.writeInputTensor(E.cutCrop(window.__bmp, g, others, canvas), data.subarray(keys.length * SZ, (keys.length + 1) * SZ), 0);
            keys.push([ii, cam]); }));
        const T = await import(E.TRANSFORMERS_URL);
        const ref = await T.AutoModel.from_pretrained(E.IMAGE_MODEL_ID, { device: 'wasm', dtype: 'fp32' });
        const res = await ref({ pixel_values: new T.Tensor('float32', data.slice(0, keys.length * SZ), [keys.length, 3, E.INPUT, E.INPUT]) });
        const hs = res.last_hidden_state, tok = hs.dims[1], dim = hs.dims[2];
        let minCos = 1, maxAbs = 0, matched = 0;
        keys.forEach(([ii, cam], r) => {
            const v = (out[0][ii] || []).find(x => x.camera === cam); if (!v) return;
            const w = hs.data.subarray(r * tok * dim, r * tok * dim + dim);
            let ab = 0, aa = 0, bb = 0; for (let d = 0; d < dim; d++) { ab += v.vector[d] * w[d]; aa += v.vector[d] ** 2; bb += w[d] ** 2; maxAbs = Math.max(maxAbs, Math.abs(v.vector[d] - w[d])); }
            minCos = Math.min(minCos, ab / Math.sqrt(aa * bb)); matched++;
        });
        // a wrong ORDER would still be a valid vector — so also check it is not equally close to another camera's
        const a0 = out[0][0].find(x => x.camera === cams[0]).vector, a1 = out[0][0].find(x => x.camera === cams[1]).vector;
        let diff = 0; for (let d = 0; d < dim; d++) diff = Math.max(diff, Math.abs(a0[d] - a1[d]));
        e.releaseFrames();
        let after = null; try { await e.getEmbeddings(16, itemsAt(16)); after = 'ran'; } catch (err) { after = err.message; }
        return { device, line, statuses, crops: out.reduce((n, o) => n + o.reduce((m, l) => m + l.length, 0), 0), seconds, worst, busy,
                 timing: E.formatEmbedTiming(stats), keys: keys.length, matched, minCos, maxAbs, diff, after };
    });
    check(emb.device.backend === 'cpu' && emb.device.workers === 2 && emb.device.dtype === 'fp32', `the embedder runs on the CPU: ${JSON.stringify(emb.device)}`);
    check(emb.line.text === 'No GPU: running on the CPU (2 workers) — slow' && emb.line.warn, `dialog line: "${emb.line.text}"`);
    check(emb.statuses.some(s => /^No GPU \(/.test(s)), `the dialog is told why it loads a CPU model ("${emb.statuses.find(s => /^No GPU/.test(s))}")`);
    check(emb.crops === 4 * 3 * 3, `4 frames x 3 animals x 3 cameras = ${emb.crops} crops, in ${emb.seconds.toFixed(1)} s`);
    check(emb.matched === emb.keys && emb.keys === 9 && emb.minCos > 0.99999 && emb.maxAbs < 1e-3,
          `vectors equal the main-thread model's, per animal and camera (${emb.matched}/${emb.keys}, min cosine ${emb.minCos.toFixed(7)}, max |diff| ${emb.maxAbs.toExponential(1)})`);
    check(emb.diff > 1e-2, `…and the cameras' vectors differ, so a mix-up would show (${emb.diff.toFixed(3)})`);
    check(emb.worst < 300, `the page stays responsive while the workers compute (longest main-thread gap ${Math.round(emb.worst)} ms)`);
    check(emb.busy > 0 && / · CPU \(2 workers\) fp32/.test(emb.timing) && /model busy/.test(emb.timing), `run summary: "${emb.timing}"`);
    check(/no CPU model worker is running/.test(emb.after), `releaseFrames terminates the workers ("${emb.after}")`);

    // ---- 5. the real dialog, nothing injected: runs on the CPU instead of refusing
    await page.evaluate(async () => {
        const M = await import('/ui/id-switch-modal.js');
        window.__done = M.runIdSwitchChecks({ image: true, auto: true, statusPrefix: 'Assigned 3 identities' });
    });
    await page.waitForSelector('.id-switch-progress', { timeout: 10000 });
    await page.waitForFunction(() => /frame \d/.test(document.querySelector('.id-switch-progress-text')?.textContent || ''), null, { timeout: 120000 });
    await page.waitForTimeout(1500);
    const dlg = await page.evaluate(() => ({ text: document.querySelector('.id-switch-progress-text').textContent,
        gpu: document.querySelector('.id-switch-progress-gpu').textContent, warn: document.querySelector('.id-switch-progress-gpu').classList.contains('is-warn') }));
    check(/^No GPU: running on the CPU \(\d workers?\) — slow$/.test(dlg.gpu) && dlg.warn && /frame \d/.test(dlg.text),
          `the after-tracking check runs on the CPU: "${dlg.text}" / "${dlg.gpu}"`);
    await page.keyboard.press('Escape');
    const done = await page.evaluate(async () => { const r = await window.__done;
        return { reason: r && r.image && r.image.reason, status: document.getElementById('statusText').textContent, dialog: !!document.querySelector('.id-switch-progress') }; });
    check(done.reason === 'cancelled' && !done.dialog && !/needs WebGPU/.test(done.status), `…and Esc cancels it ("${done.status}")`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `FAIL (${fails})` : 'PASS');
process.exit(fails ? 1 : 0);
