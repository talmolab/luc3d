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
 *  2. Animals of IDENTICAL size: only the image check finds it ("Images" row).
 *  3. A cancellable progress dialog: Esc mid-run stops it, reports "cancelled"
 *     and adds no image markers.
 *  4. Without WebGPU the image check explains why it cannot run.
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
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    await page.evaluate(() => {
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
        // Synthetic embedder: per-animal appearance vector + noise, 4 cameras; optional per-frame delay.
        window.__fakeEmbedder = (delayMs) => async () => {
            let seed = 11; const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
            const g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
            const proto = [0, 1, 2].map(() => Float32Array.from({ length: 64 }, g));
            const cams = ['c0', 'c1', 'c2', 'c3'];
            return { views: cams, getEmbeddings: async (frame, items) => {
                if (delayMs) await new Promise(res => setTimeout(res, delayMs));
                return items.map(it => cams.map(cam => ({ camera: cam, vector: Float32Array.from(proto[it.group._animal], v => v + 1.2 * g()) })));
            } };
        };
    });
    const rows = () => page.evaluate(() => Array.from(document.querySelectorAll('#idSwitchPanel .id-switch-row')).map(r => ({ frame: +r.dataset.frame, text: r.textContent, cls: r.className })));

    // ---- 1. different sizes: both checks agree -> one "Both" row
    let fx = await page.evaluate(async () => {
        const fx = await window.__buildSwap([1.0, 1.15, 0.85]);
        const M = await import('/ui/id-switch-modal.js');
        window.__res = await M.runIdSwitchChecks({ size: true, image: true, inject: { createEmbedder: window.__fakeEmbedder(0), hasWebGPU: async () => true } });
        return fx;
    });
    let R = await rows();
    const both = R.find(r => Math.abs(r.frame - fx.swapFrame) <= 60 && /Both/.test(r.text));
    check(!!both && fx.pair.every(n => both.text.includes(n)), `different sizes: the switch is ONE "Both" row at ${both && both.frame} (switch ${fx.swapFrame}): "${both && both.text}"`);
    check(!R.some(r => r !== both && Math.abs(r.frame - fx.swapFrame) <= 60 && /· images/.test(r.text)), '…and not a second "Images" row for the same change point');
    const cues = await page.evaluate(async () => { return [...new Set((await import('/ui/seekbar-markers.js')).getSeekbarSwitchMarkers().map(m => m.cue))].sort(); });
    check(cues.join() === 'image,size', `the seekbar carries both checks' markers (${cues})`);
    const cb = await page.evaluate(() => [window.__res.image.continueBelow, window.__res.image.skipEmpty, window.__res.size.skipEmpty,
        window.__res.image.clearestEndLeads, window.__res.size.clearestEndLeads]);
    check(cb[0] === 0, `on several cameras a run still ends at any encounter scoring above 0 (continueBelow ${cb[0]}; the +|threshold| rule is single-camera only)`);
    check(cb[1] === false && cb[2] === false, `…and an encounter with no samples still counts (skipEmpty: image ${cb[1]}, size ${cb[2]}; single-camera only)`);
    check(cb[3] === false && cb[4] === false, `…and 'end' rows keep time order (clearestEndLeads: image ${cb[3]}, size ${cb[4]}; single-camera only)`);
    check(!(await page.$('.id-switch-progress')), 'the progress dialog is gone when done');

    // ---- 2. identical sizes: only the image check finds it
    fx = await page.evaluate(async () => {
        const fx = await window.__buildSwap([1, 1, 1]);
        const M = await import('/ui/id-switch-modal.js');
        window.__res = await M.runIdSwitchChecks({ size: true, image: true, inject: { createEmbedder: window.__fakeEmbedder(0), hasWebGPU: async () => true } });
        return fx;
    });
    R = await rows();
    const imgRow = R.find(r => Math.abs(r.frame - fx.swapFrame) <= 60);
    check(!!imgRow && /· images/.test(imgRow.text) && !/Both/.test(imgRow.text), `identical sizes: found by images only ("${imgRow && imgRow.text}")`);
    const st2 = await page.evaluate(() => document.getElementById('statusText').textContent);
    check(/Check ID Switches: no possible switches.*; Check ID Switches \(images\): 1 possible switch/.test(st2), `status reports each check ("${st2}")`);

    // ---- 3. cancel mid-run with Esc
    await page.evaluate(async () => {
        await window.__buildSwap([1, 1, 1]);
        const M = await import('/ui/id-switch-modal.js');
        window.__done = M.runIdSwitchChecks({ image: true, inject: { createEmbedder: window.__fakeEmbedder(40), hasWebGPU: async () => true } });
    });
    await page.waitForSelector('.id-switch-progress', { timeout: 10000 });
    await page.waitForFunction(() => /frame \d/.test(document.querySelector('.id-switch-progress-text').textContent), null, { timeout: 10000 });
    await page.keyboard.press('Escape');
    const cancelled = await page.evaluate(async () => { const r = await window.__done;
        return { reason: r && r.image && r.image.reason, status: document.getElementById('statusText').textContent,
                 progress: !!document.querySelector('.id-switch-progress'), rows: document.querySelectorAll('#idSwitchPanel .id-switch-row').length,
                 markers: (await import('/ui/seekbar-markers.js')).getSeekbarSwitchMarkers().filter(m => m.cue === 'image').length }; });
    check(cancelled.reason === 'cancelled' && /cancelled/.test(cancelled.status), `Esc cancels the image check ("${cancelled.status}")`);
    check(!cancelled.progress && !cancelled.rows && cancelled.markers === 0, 'nothing left behind: no progress dialog, no listed results, no image markers');

    // ---- 4. no WebGPU
    const noGpu = await page.evaluate(async () => {
        const M = await import('/ui/id-switch-modal.js');
        await M.runIdSwitchChecks({ image: true, inject: { createEmbedder: window.__fakeEmbedder(0), hasWebGPU: async () => false } });
        return { status: document.getElementById('statusText').textContent, rows: document.querySelectorAll('#idSwitchPanel .id-switch-row').length };
    });
    check(/needs WebGPU/.test(noGpu.status) && !noGpu.rows, `without WebGPU it explains why ("${noGpu.status}")`);

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
