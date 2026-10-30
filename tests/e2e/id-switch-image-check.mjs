/**
 * id-switch-image-check.mjs — the image ID-switch check's UI in the real app
 * (ui/id-switch-modal.js `runIdSwitchChecks({image: true})`).
 *
 * The real path needs the videos, WebGPU and a 44 MB model, so the embedder and
 * the WebGPU probe are INJECTED (`opts.inject`, documented as test-only): a
 * synthetic embedder returns a fixed random "appearance" vector per animal plus
 * noise, from 4 cameras. The scoring underneath is the real pose/id-switch-check.js.
 * Fixtures are tracked sessions (InstanceGroups only) where two identities swap
 * after one encounter, as in tests/e2e/size-switch-check.mjs. Asserted:
 *  1. Animals of different size: both checks find the swap; the ID Switches tab
 *     lists it ONCE, as "Both", and the timeline carries size (amber) and image (cyan) markers.
 *  2. Animals of IDENTICAL size: only the image check finds it ("Images" row); the
 *     size check runs but cannot flag the switch.
 *  3. A cancellable progress dialog, with a playhead line, a percentage, the CPU
 *     line over the GPU running the model, each with its live load, a graph of
 *     both loads to their right (legend keys, labelled axes, its newest points
 *     equal to the lines, a hover readout), and a sample of the crops above Cancel
 *     (the model input as given, captioned with its animal's label and camera, a
 *     new one every 0.4 s while the embedder's list sits still, as it does between
 *     the CPU's bursts): Esc mid-run stops it, reports "cancelled" and adds no
 *     image markers.
 *  4. Without a GPU the after-tracking image check (Tracking Wizard) still RUNS,
 *     on the CPU, says so in the dialog (and graphs the CPU alone), and finds the
 *     switch — it used to be "skipped — needs WebGPU". (The real CPU embedder:
 *     tests/e2e/image-check-cpu.mjs.)
 *  5. The menu item exists, and the after-tracking image check defaults to OFF.
 *
 * Run: node tests/e2e/id-switch-image-check.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8275);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    await page.evaluate(async () => {
        // Tracked fixture: 3 animals, 24 scheduled encounters, labels of one pair swapped after #16.
        window.__buildSwap = async (scales) => {
            const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
            const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
                'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
            const TEMPLATE = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
                Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
                Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0],
                Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
            const STEP = 4, SWAP = 16;
            let seed = 7; const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
            const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
            const pose = (sc, cx, cy, h) => { const out = new Float64Array(45), c = Math.cos(h), s = Math.sin(h);
                NODES.forEach((n, i) => { const [x, y, z] = TEMPLATE[n]; out[i * 3] = cx + sc * (c * x - s * y) + 1.5 * gauss();
                    out[i * 3 + 1] = cy + sc * (s * x + c * y) + 1.5 * gauss(); out[i * 3 + 2] = sc * z + 1.5 * gauss(); }); return out; };
            const home = [[0, 0], [400, 0], [200, 350]], PAIRS = [[0, 1], [1, 2], [0, 2]];
            const events = []; for (let e = 0; e < 24; e++) events.push({ pair: PAIRS[e % 3], t0: 300 + e * 260 });
            const T = 300 + 24 * 260 + 300;
            const session = new pd.Session([], new pd.Skeleton('m', NODES, []), [], 'ImageFixture');
            for (let i = 0; i < 3; i++) session.addIdentity('id_' + i);
            let gid = 1; const label = [0, 1, 2]; let swapFrame = null;
            for (let t = 0; t < T; t++) {
                const pos = home.map(h => [h[0] + 15 * Math.sin(t / 37 + h[0]), h[1] + 15 * Math.cos(t / 41 + h[1])]);
                for (const ev of events) { const d = t - ev.t0; if (d < 0 || d > 100) continue;
                    const [a, b] = ev.pair, mid = [(home[a][0] + home[b][0]) / 2, (home[a][1] + home[b][1]) / 2];
                    const f = d < 40 ? d / 40 : d <= 60 ? 1 : 1 - (d - 60) / 40;
                    for (const [k, side] of [[a, -1], [b, 1]]) pos[k] = [home[k][0] + f * (mid[0] + side * 10 - home[k][0]), home[k][1] + f * (mid[1] - home[k][1])]; }
                session.instanceGroups.set(t * STEP, [0, 1, 2].map(k => { const g = new pd.InstanceGroup(gid++, session.identities[label[k]].id);
                    g.points3d = pose(scales[k], pos[k][0], pos[k][1], (t / 50 + k) % (2 * Math.PI)); g._animal = k; return g; }));
                if (t === events[SWAP].t0 + 60) { const [a, b] = events[SWAP].pair; [label[a], label[b]] = [label[b], label[a]]; swapFrame = t * STEP; }
            }
            AS.state.sessions = [session]; AS.state.activeSessionIdx = 0; AS.state.session = session;
            AS.state.totalFrames = T * STEP; AS.state.currentFrame = 0; AS.state.fps = 60; AS.state.views = [];
            if (AS.timeline) { AS.timeline.setTotalFrames(T * STEP); AS.timeline.setData(session); } (await import('/ui/seekbar-markers.js')).setSeekbarSwitchMarkers([]);
            return { swapFrame, pair: events[SWAP].pair.map(k => 'id_' + k) };
        };
        // Synthetic embedder: per-animal appearance vector + noise, 4 cameras; optional per-frame delay, and
        // optionally a `device` to report (with busyMs = the time any request was in its delay, cpuBusyMs = two
        // threads busy for that time, and sampleCrops = one uniform-grey crop per frame, 60 + 60 x the animal).
        // Sample k is animal k mod 3 from camera c<k mod 4>, so the first SAMPLE_CROPS (12) carry 12 different
        // captions — and only those are kept: the list then sits still, as it does between the CPU's bursts, so
        // the dialog's crop changes only because the dialog cycles through it. A list that kept rolling made the
        // crop each 400 ms tick landed on depend on the embedding rate: at ~20 frames a tick the list moved 20
        // while the dialog's index moved 1, and 21 is a multiple of 3 — the same animal on every tick. (Not
        // c<frame mod 4>: every frame here is a multiple of 4, so that was always c0.)
        const E = await import('/ui/image-embedder.js');
        const greyCrop = (g) => { const t = new Float32Array(3 * E.INPUT * E.INPUT); E.writeInputTensor(new Uint8ClampedArray(E.CROP * E.CROP).fill(g), t, 0); return t; };
        const CROPS = [0, 1, 2].map(k => greyCrop(60 + 60 * k));
        window.__fakeEmbedder = (delayMs, device) => async () => {
            let seed = 11; const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
            const g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
            const proto = [0, 1, 2].map(() => Float32Array.from({ length: 64 }, g));
            const cams = ['c0', 'c1', 'c2', 'c3'];
            let busy = 0, since = 0, active = 0, n = 0; const samples = [];
            const e = { views: cams, getEmbeddings: async (frame, items) => {
                const k = n++, it = items[k % items.length];
                // a cross of keypoints around the centre, so the overlay has something to draw (the fixture skeleton has no edges)
                if (samples.length < E.SAMPLE_CROPS)
                    samples.push({ tensor: CROPS[it.group._animal], frame, camera: cams[k % cams.length], identityId: it.group.identityId,
                                   points: Float32Array.from([112, 112, 150, 112, 74, 112, 112, 150, 112, 74]) });
                if (active++ === 0) since = performance.now();
                if (delayMs) await new Promise(res => setTimeout(res, delayMs));
                if (--active === 0) busy += performance.now() - since;
                return items.map(it => cams.map(cam => ({ camera: cam, vector: Float32Array.from(proto[it.group._animal], v => v + 1.2 * g()) })));
            } };
            if (device) { e.device = () => device; e.busyMs = () => busy + (active ? performance.now() - since : 0); e.sampleCrops = () => samples;
                          e.cpuBusyMs = () => 2 * e.busyMs(); }
            return e;
        };
    });
    const rows = () => page.evaluate(() => Array.from(document.querySelectorAll('#idSwitchPanel .id-switch-row')).map(r => ({ frame: +r.dataset.frame, text: r.textContent, cls: r.className })));

    // ---- 1. different sizes: both checks agree -> one "Both" row
    let fx = await page.evaluate(async () => {
        const fx = await window.__buildSwap([1.0, 1.15, 0.85]);
        const M = await import('/ui/id-switch-modal.js');
        window.__res = await M.runIdSwitchChecks({ size: true, image: true, inject: { createEmbedder: window.__fakeEmbedder(0) } });
        return fx;
    });
    let R = await rows();
    const both = R.find(r => Math.abs(r.frame - fx.swapFrame) <= 60 && /Both/.test(r.text));
    check(!!both && fx.pair.every(n => both.text.includes(n)), `different sizes: the switch is ONE "Both" row at ${both && both.frame} (switch ${fx.swapFrame}): "${both && both.text}"`);
    check(!R.some(r => r !== both && Math.abs(r.frame - fx.swapFrame) <= 60 && /· images/.test(r.text)), '…and not a second "Images" row for the same change point');
    const cues = await page.evaluate(async () => { return [...new Set((await import('/ui/seekbar-markers.js')).getSeekbarSwitchMarkers().map(m => m.cue))].sort(); });
    check(cues.join() === 'image,size', `the seekbar carries both checks' markers (${cues})`);
    check(!(await page.$('.id-switch-progress')), 'the progress dialog is gone when done');
    {   // the overlay's keypoints land where cutCrop puts them: a dot in the image, cropped, vs cropPointsToInput
        const off = await page.evaluate(async () => {
            const E = await import('/ui/image-embedder.js'), out = [];
            for (const [px, py, angle] of [[300, 200, 0], [330, 180, 0.7], [280, 230, -2.4], [310, 205, Math.PI / 2]]) {
                const cv = new OffscreenCanvas(640, 480), cx = cv.getContext('2d');
                cx.fillStyle = '#000'; cx.fillRect(0, 0, 640, 480); cx.fillStyle = '#fff'; cx.beginPath(); cx.arc(px, py, 2, 0, 7); cx.fill();
                const g = { cx: 300, cy: 200, angle, scale: E.CROP / (1.3 * 80), L: 80, hull: [[200, 100], [400, 100], [400, 300], [200, 300]], pts: [px, py] };
                const crop = E.cutCrop(await createImageBitmap(cv), g, []), t = new Float32Array(3 * E.INPUT * E.INPUT);
                E.writeInputTensor(crop, t, 0);
                const rgba = E.inputTensorToPixels(t, new Uint8ClampedArray(E.INPUT * E.INPUT * 4));
                let sw = 0, sx = 0, sy = 0;   // brightness-weighted centre of the dot, at pixel centres
                for (let y = 0; y < E.INPUT; y++) for (let x = 0; x < E.INPUT; x++) { const v = rgba[4 * (y * E.INPUT + x)]; if (v > 40) { sw += v; sx += v * (x + 0.5); sy += v * (y + 0.5); } }
                const q = E.cropPointsToInput(g);
                out.push(Math.hypot(sx / sw - q[0], sy / sw - q[1]));
            }
            return out;
        });
        check(off.every(d => d < 1), `the skeleton's keypoints land on the crop's pixels, at any rotation (off by ${off.map(d => d.toFixed(2)).join(', ')} px of 224)`);
    }
    {   // an embedder without sampleCrops (as injected here): no empty square
        await page.evaluate(async () => { await window.__buildSwap([1, 1, 1]); const M = await import('/ui/id-switch-modal.js');
            window.__done = M.runIdSwitchChecks({ image: true, inject: { createEmbedder: window.__fakeEmbedder(20) } }); });
        await page.waitForFunction(() => /frame \d/.test(document.querySelector('.id-switch-progress-text')?.textContent || ''), null, { timeout: 10000 });
        const hidden = await page.evaluate(() => document.querySelector('.id-switch-progress-crop').hidden);
        await page.keyboard.press('Escape'); await page.evaluate(() => window.__done);
        check(hidden, 'an embedder that offers no sample crops shows no square');
    }

    // ---- 2. identical sizes: only the image check finds it
    fx = await page.evaluate(async () => {
        const fx = await window.__buildSwap([1, 1, 1]);
        const M = await import('/ui/id-switch-modal.js');
        window.__res = await M.runIdSwitchChecks({ size: true, image: true, inject: { createEmbedder: window.__fakeEmbedder(0) } });
        return fx;
    });
    R = await rows();
    const imgRow = R.find(r => Math.abs(r.frame - fx.swapFrame) <= 60);
    check(!!imgRow && /· images/.test(imgRow.text) && !/Both/.test(imgRow.text), `identical sizes: found by images only ("${imgRow && imgRow.text}")`);
    const st2 = await page.evaluate(() => document.getElementById('statusText').textContent);
    // With every animal the same size the bone lengths carry no identity, so the size check cannot see the
    // switch; the cosine of noise-only window means can still dip just past its threshold elsewhere (two
    // contacts at -1.0 and -1.15 in this fixture), so its count is not asserted — only that it ran.
    check(/Check ID Switches: (nothing flagged|\d+ possible switch).*; Check ID Switches \(images\): 1 possible switch/.test(st2), `status reports each check ("${st2}")`);
    const sizeAtSwitch = await page.evaluate((f) => { const r = window.__res.size; return r.flags.filter(x => x.startFrame <= f + 60 && x.frame >= f - 60).length; }, fx.swapFrame);
    check(sizeAtSwitch === 0, `the size check does not flag the switch itself (${sizeAtSwitch})`);

    // ---- 3. cancel mid-run with Esc
    await page.evaluate(async () => {
        await window.__buildSwap([1, 1, 1]);
        const M = await import('/ui/id-switch-modal.js');
        window.__done = M.runIdSwitchChecks({ image: true, inject: { createEmbedder: window.__fakeEmbedder(40,
            { backend: 'webgpu', comparing: false, dtype: 'fp16', adapter: 'Test GPU', fallback: false }) } });
    });
    await page.waitForSelector('.id-switch-progress', { timeout: 10000 });
    const gpuLine = () => page.evaluate(() => { const el = document.querySelector('.id-switch-progress-gpu');
        return { text: el.textContent, warn: el.classList.contains('is-warn'), title: el.title }; });
    const g0 = await gpuLine();
    check(g0.text.startsWith('GPU: Test GPU (WebGPU, fp16)') && !g0.warn, `the dialog names the GPU running the model ("${g0.text}")`);
    // the load appears once embedding has run for a moment, and refreshes every second
    await page.waitForFunction(() => /· load \d+%$/.test(document.querySelector('.id-switch-progress-gpu').textContent), null, { timeout: 10000 });
    const g1 = await gpuLine(), load = +g1.text.match(/load (\d+)%/)[1];
    check(load > 0 && load <= 100 && /other apps/.test(g1.title), `…and its load while embedding, with a tooltip saying what that measures ("${g1.text}")`);
    // the CPU line, ABOVE the GPU line, and the load graph to the right of both
    const hw = await page.evaluate(() => {
        const WIDEST_GPU_LINE = 'GPU: WebGPU, fp16 · load 100%';
        const q = (c) => document.querySelector('.id-switch-progress ' + c), box = (el) => el.getBoundingClientRect();
        const cpu = q('.id-switch-progress-cpu'), gpu = q('.id-switch-progress-gpu'), graph = q('.id-switch-progress-graph'), svg = graph.querySelector('svg');
        const key = (el) => getComputedStyle(el, '::before').backgroundColor;
        const stroke = (k) => getComputedStyle(svg.querySelector('path.is-' + k)).stroke;
        // the newest point of each series: the path's last coordinates, in the plot (the <g>'s translate is the inset)
        const g = svg.querySelector('g'), pad = +g.getAttribute('transform').match(/translate\(0 ([\d.]+)\)/)[1];
        const plotH = svg.viewBox.baseVal.height - 2 * pad;
        const newest = (k) => { const m = svg.querySelector('path.is-' + k).getAttribute('d').match(/([\d.]+) ([\d.]+)$/);
            return m ? { x: +m[1], pct: 100 * (plotH - m[2]) / plotH } : null; };
        return { cpuText: cpu.textContent, cpuTitle: cpu.title, gpuText: gpu.textContent, cpuHidden: cpu.hidden,
                 cpuAbove: box(cpu).bottom <= box(gpu).top + 0.5, keys: [cpu.classList.contains('has-series'), gpu.classList.contains('has-series')],
                 keyColours: [key(cpu), key(gpu)], strokes: [stroke('cpu'), stroke('gpu')],
                 shown: getComputedStyle(graph).visibility, right: box(svg).left >= Math.max(box(cpu).right, box(gpu).right),
                 topAligned: Math.abs(box(svg).top - box(cpu).top) <= 3, leftOfCrop: box(svg).right <= box(q('.id-switch-progress-crop')).left,
                 width: svg.viewBox.baseVal.width, newest: { cpu: newest('cpu'), gpu: newest('gpu') },
                 gpuOneLine: (() => {   // the widest common line (no adapter name — a named one wraps after its key by design)
                     const saved = gpu.textContent; gpu.textContent = WIDEST_GPU_LINE;
                     const one = box(gpu).height < 1.5 * parseFloat(getComputedStyle(gpu).lineHeight);
                     gpu.textContent = saved; return one; })() };
    });
    const cores = await page.evaluate(() => navigator.hardwareConcurrency);
    const cpuLoad = +((hw.cpuText.match(/load (\d+)%$/) || [])[1]);
    check(!hw.cpuHidden && hw.cpuAbove && new RegExp('^CPU: ' + cores + ' cores? · load \\d+%$').test(hw.cpuText) && cpuLoad >= 0 && cpuLoad <= 100,
          `a CPU line ABOVE the GPU line, with the core count and its load ("${hw.cpuText}" over "${hw.gpuText}")`);
    check(/cores kept busy over the last 5 s by this check/.test(hw.cpuTitle) && /video decoding/.test(hw.cpuTitle), `…with a tooltip saying what it counts ("${hw.cpuTitle}")`);
    check(hw.shown === 'visible' && hw.right && hw.topAligned && hw.leftOfCrop, 'the load graph sits to the right of both lines, level with them, left of the sample crop');
    check(hw.gpuOneLine, '…and "GPU: WebGPU, fp16 · load 100%" still fits on one line beside it');
    {   // the card every progress popup now shares: opaque, the app not greyed out, the CPU line left-justified
        const st = await page.evaluate(async () => {
            const { progressCardStyle } = await import('/tests/e2e/fixtures/progress-card.js');
            const card = document.querySelector('.id-switch-progress');
            return progressCardStyle(card, card.parentElement, card.querySelector('.id-switch-progress-cpu'));
        });
        check(st.ok, 'the dialog is opaque, its backdrop does not grey the app out (but still blocks it), the CPU line is left-justified' +
              (st.ok ? '' : ' — ' + st.why));
    }
    {   // its axes: "100%" / "50%" / "0%" level with what they label, "60 s ago" … "now" under it, each with a tick
        // pointing out of the plot (fixtures/load-graph-axes.js)
        const ax = await page.evaluate(async (sel) => (await import('/tests/e2e/fixtures/load-graph-axes.js')).loadGraphAxes(document.querySelector(sel)), '.id-switch-progress-graph');
        check(ax.ok, `labelled axes with out ticks: ${ax.y.map(l => l.t + ' ' + l.off.toFixed(2) + ' px off').join(', ')}; ${ax.x.map(l => '"' + l.t + '"').join(' … ')} under the plot; ${ax.ticks.length} ticks` + (ax.ok ? '' : ' — ' + ax.why));
    }
    check(hw.keys.every(Boolean) && hw.keyColours[0] === hw.strokes[0] && hw.keyColours[1] === hw.strokes[1] && hw.strokes[0] !== hw.strokes[1],
          `each line wears its series colour as a legend key (CPU ${hw.keyColours[0]}, GPU ${hw.keyColours[1]})`);
    {   // the graph's newest points are the loads the lines show (same tick), at the right edge
        const n = hw.newest, gl = +hw.gpuText.match(/load (\d+)%/)[1];
        check(n.cpu && n.gpu && Math.abs(n.cpu.x - hw.width) < 0.05 && Math.abs(n.gpu.x - hw.width) < 0.05 &&
              Math.abs(n.cpu.pct - cpuLoad) <= 1 && Math.abs(n.gpu.pct - gl) <= 1,
              `the graph's newest points, at its right edge, are the lines' loads (CPU ${n.cpu && n.cpu.pct.toFixed(1)}% vs ${cpuLoad}%, GPU ${n.gpu && n.gpu.pct.toFixed(1)}% vs ${gl}%)`);
    }
    {   // hovering: a readout of the sample under the pointer; leaving hides it
        const r = await page.evaluate(() => { const b = document.querySelector('.id-switch-progress-graph svg').getBoundingClientRect(); return { x: b.right - 2, y: b.top + b.height / 2 }; });
        await page.mouse.move(r.x, r.y);
        const tip = await page.evaluate(() => { const t = document.querySelector('.load-graph-tip');
            return { hidden: t.hidden, text: t.textContent, cursor: document.querySelector('.load-graph-cursor').classList.contains('is-on'),
                     dots: document.querySelectorAll('.load-graph-dot.is-on').length }; });
        check(!tip.hidden && /^(now|\d+ s ago) · CPU \d+% · GPU \d+%$/.test(tip.text) && tip.cursor && tip.dots === 2,
              `hovering the graph reads out the sample under the pointer ("${tip.text}"), with a cursor and a dot per series`);
        await page.mouse.move(5, 5);
        check(await page.evaluate(() => document.querySelector('.load-graph-tip').hidden && !document.querySelector('.load-graph-cursor.is-on')),
              '…and leaving it hides the readout and the cursor');
    }
    // the sample crop: what the embedder was given, drawn and captioned with the animal's CURRENT label and camera.
    // Every draw rewrites the caption (assigning textContent replaces its text node even with the same text), so
    // an observer on it times each new crop.
    const crop = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js'), el = document.querySelector('.id-switch-progress-crop');
        const draws = [], mo = new MutationObserver(() => draws.push(performance.now()));
        mo.observe(el.querySelector('figcaption'), { childList: true });
        const seen = new Set(), ok = [];
        for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 420));
            const cap = el.querySelector('figcaption').textContent, px = el.querySelector('canvas').getContext('2d').getImageData(40, 40, 1, 1).data;
            const [name, cam] = cap.split(' · '), id = (AS.state.session.identities.find(x => x.name === name) || {}).id;
            // which animal carries that label at this point is not fixed (one pair swaps), so check the grey is one of the three
            ok.push(!!id || id === 0 ? [60, 120, 180].includes(px[0]) && px[0] === px[1] && px[1] === px[2] && /^c[0-3]$/.test(cam) : false);
            seen.add(cap);
        }
        mo.disconnect();
        const gaps = draws.slice(1).map((t, i) => t - draws[i]).sort((a, b) => a - b);
        // the skeleton is drawn in the animal's identity colour: the node at (150, 112) is coloured, not grey
        const [name] = el.querySelector('figcaption').textContent.split(' · ');
        const colour = (AS.state.session.identities.find(x => x.name === name) || {}).color;
        const node = el.querySelector('canvas').getContext('2d').getImageData(150, 112, 1, 1).data;
        const hex = '#' + [0, 1, 2].map(i => node[i].toString(16).padStart(2, '0')).join('');
        return { hidden: el.hidden, has: el.classList.contains('has-crop'), ok, seen: [...seen], aria: el.querySelector('canvas').getAttribute('aria-label'), colour, hex,
                 draws: draws.length, gap: gaps.length ? gaps[gaps.length >> 1] : NaN };
    });
    check(crop.hex === crop.colour, `the skeleton is drawn over the crop in the animal's identity colour (${crop.hex} vs ${crop.colour})`);
    // 6 looks 420 ms apart at a list of 12 different captions: each look is a new one, unless a late tick repeats one
    const seenCams = new Set(crop.seen.map(c => c.split(' · ')[1]));
    check(!crop.hidden && crop.has && crop.ok.every(Boolean) && crop.seen.length >= 4 && seenCams.size >= 2 && /^Sample crop: id_\d · c\d$/.test(crop.aria),
          `a sample crop above Cancel, drawn as given, captioned with its label and camera (${crop.seen.join(' | ')})`);
    check(crop.draws >= 5 && crop.gap >= 300 && crop.gap <= 600,
          `…changing every 0.4 s (${crop.draws} crops in 2.5 s, median ${Math.round(crop.gap)} ms apart)`);
    await page.waitForFunction(() => /frame \d/.test(document.querySelector('.id-switch-progress-text').textContent), null, { timeout: 10000 });
    // Embedding is the first 90% of the bar, so frame i of n reads round(90 i / n)%.
    await page.waitForFunction(() => parseInt(document.querySelector('.id-switch-progress-pct').textContent, 10) > 0, null, { timeout: 10000 });
    const pct = await page.evaluate(() => {
        const q = (c) => document.querySelector('.id-switch-progress ' + c);
        const t = q('.id-switch-progress-pct').textContent, w = q('.id-switch-progress-fill').style.width, h = q('.id-switch-phead').style.left;
        const m = document.querySelector('.id-switch-progress-text').textContent.replace(/,/g, '').match(/frame (\d+) of (\d+)/);
        return { t, n: parseInt(t, 10), w: parseFloat(w), h: parseFloat(h), want: m ? Math.round(90 * m[1] / m[2]) : NaN };
    });
    check(/^\d+%$/.test(pct.t) && pct.n === pct.want && pct.n === pct.w,
          `a percentage under the bar matches the frame count and the fill ("${pct.t}", expected ${pct.want}%, width ${pct.w}%)`);
    check(pct.h === pct.w, `the playhead line sits at the fill's leading edge (${pct.h}% vs ${pct.w}%)`);
    await page.keyboard.press('Escape');
    const cancelled = await page.evaluate(async () => { const r = await window.__done;
        return { reason: r && r.image && r.image.reason, status: document.getElementById('statusText').textContent,
                 progress: !!document.querySelector('.id-switch-progress'), rows: document.querySelectorAll('#idSwitchPanel .id-switch-row').length,
                 markers: (await import('/ui/seekbar-markers.js')).getSeekbarSwitchMarkers().filter(m => m.cue === 'image').length }; });
    check(cancelled.reason === 'cancelled' && /cancelled/.test(cancelled.status), `Esc cancels the image check ("${cancelled.status}")`);
    check(!cancelled.progress && !cancelled.rows && cancelled.markers === 0, 'nothing left behind: no progress dialog, no listed results, no image markers');

    // ---- 4. no GPU: the check still runs, on the CPU, to the end — as the Tracking Wizard's after-tracking
    //         image check (`auto`, the way pose/tracker.js calls it), which used to report "skipped — needs WebGPU"
    fx = await page.evaluate(async () => {
        const fx = await window.__buildSwap([1, 1, 1]);
        const M = await import('/ui/id-switch-modal.js');
        window.__done = M.runIdSwitchChecks({ image: true, auto: true, statusPrefix: 'Assigned 3 identities', inject: { createEmbedder: window.__fakeEmbedder(10,
            { backend: 'cpu', dtype: 'fp32', workers: 4, why: 'this browser has no WebGPU', adapter: '', fallback: false }) } });
        return fx;
    });
    await page.waitForFunction(() => /frame \d/.test(document.querySelector('.id-switch-progress-text')?.textContent || ''), null, { timeout: 10000 });
    await page.waitForTimeout(1500);   // past the first load refresh: the CPU never shows a GPU load
    const cpuLine = await gpuLine();
    check(cpuLine.warn && cpuLine.text === 'No GPU: running on the CPU (4 workers) — slow' && /no WebGPU/.test(cpuLine.title),
          `without a GPU the dialog says it runs on the CPU, in the warning colour ("${cpuLine.text}")`);
    const noGpuGraph = await page.evaluate(() => ({ cpu: document.querySelector('.id-switch-progress-cpu').textContent,
        cpuKey: document.querySelector('.id-switch-progress-cpu').classList.contains('has-series'),
        gpuKey: document.querySelector('.id-switch-progress-gpu').classList.contains('has-series'),
        cpuPath: document.querySelector('.id-switch-progress-graph path.is-cpu').getAttribute('d') || '',
        gpuPath: document.querySelector('.id-switch-progress-graph path.is-gpu').getAttribute('d') || '' }));
    check(/· load \d+%$/.test(noGpuGraph.cpu) && noGpuGraph.cpuKey && !noGpuGraph.gpuKey && noGpuGraph.cpuPath && !noGpuGraph.gpuPath,
          `…and graphs the CPU alone: no GPU series, no key on the warning line ("${noGpuGraph.cpu}")`);
    const noGpu = await page.evaluate(async () => { const r = await window.__done;
        return { ok: r && r.image && r.image.ok, status: document.getElementById('statusText').textContent }; });
    R = await rows();
    const cpuRow = R.find(r => Math.abs(r.frame - fx.swapFrame) <= 60);
    check(noGpu.ok && /^Assigned 3 identities · ID-switch check \(images\): 1 possible switch/.test(noGpu.status) && !!cpuRow,
          `…and runs to the end and finds the switch at ${cpuRow && cpuRow.frame} (switch ${fx.swapFrame}) — "${noGpu.status}"`);

    // ---- 5. menu + default
    const ui = await page.evaluate(async () => ({ menu: !!document.getElementById('menuCheckImageSwitches'),
        auto: (await import('/ui/settings.js')).getTrackingThreshold('autoImageSwitchCheck'),
        hz: (await import('/ui/settings.js')).getTrackingThreshold('imageCheckHz') }));
    check(ui.menu && ui.auto === 0 && ui.hz === 2, `menu item present; after-tracking image check defaults OFF (${ui.auto}), 2 crops/s (${ui.hz})`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
