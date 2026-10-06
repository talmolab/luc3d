/**
 * _diag-image-keyframe-snap.mjs — does moving the image ID-switch check's samples
 * onto keyframes (ui/image-embedder.js + pose/id-switch-check.js
 * `planKeyframeSamples`, up to ±0.25 s at 2 samples/s with a keyframe every
 * 0.5 s) change what the check finds? Real data, real model, real check.
 *
 * Loads a per-camera session folder in real Google Chrome (HEVC + WebGPU, headed),
 * runs Track All (match gate on or off) and Triangulate All, then the image check
 * once per VARIANT on the same tracking:
 *   inplace — samples decoded where they are (today's behaviour)
 *   snap30  — samples moved to "keyframes" every 30 frames (0.5 s at 60 fps),
 *             via the embedder's `keyframes` hook. On the original recordings
 *             (keyframe every 250) the decoder still streams every frame, so this
 *             measures ACCURACY only; the speed-up needs re-encoded video.
 * and writes every encounter's score per variant. Planted swaps need no re-run:
 * with blocked CV a tracklet's rows are never in its own fold's training set, so
 * swapping two animals' labels on the tracklets after an encounter turns its score
 * S into exactly -S (see `finish` in pose/id-switch-check.js) — the planted-swap
 * AUC is P(-S_e < S_e') over encounters. Summarise with
 * scratch analysis (see the session notes) or read summary.json.
 *
 * Not a test (needs the dataset, a display and WebGPU). Usage:
 *     DATASET=<dir> NANIMALS=5 GATE=1 node tests/e2e/_diag-image-keyframe-snap.mjs
 *             shiftN  — control: samples moved by a constant (to frame N mod 32): the
 *             noise floor of "which frames were sampled", with no keyframe logic.
 *   env: VARIANTS=inplace,snap30,shift16  TRI=dlt  PORT=8131  LABEL=<name>
 * Output: verify/keyframe-snap/<LABEL>-<timestamp>/summary.json
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DATASET = process.env.DATASET ||
    '/Users/soline/Documents/luc3d/LabMeetingPrep/Oline/20260713_174659-194366_05mice_flippers';
const NANIMALS = String(process.env.NANIMALS || 5);
const GATE = Number(process.env.GATE ?? 1);
const TRI = process.env.TRI || 'dlt';
const VARIANTS = (process.env.VARIANTS || 'inplace,snap30').split(',').map(s => s.trim()).filter(Boolean);
const PORT = Number(process.env.PORT || 8131);
const LABEL = process.env.LABEL || ('gate' + GATE);
const EXCLUDE = /(^|\/)\.|\/troubleshooting\//;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = path.join(repoRoot, 'verify', 'keyframe-snap', `${LABEL}-${stamp}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
const log = (m) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await sleep(1200);
const summary = { dataset: DATASET, gate: GATE, tri: TRI, variants: {} };
const save = () => fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 1));
// a visible browser window: one such run at a time across sessions (scripts/browser-lock.mjs)
const releaseBrowserLock = await acquireBrowserLock({ label: '_diag-image-keyframe-snap' });
let browser;
try {
    browser = await chromium.launch({ headless: false, channel: 'chrome',
        args: ['--window-size=1500,950', '--enable-unsafe-webgpu'] });
    const page = await browser.newPage({ viewport: { width: 1480, height: 860 } });
    page.on('pageerror', e => log('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { const t = m.text(); if (/\[ID switches|\[image-embedder|\[diag\]/.test(t)) log('console: ' + t.slice(0, 400)); });
    page.on('dialog', d => d.accept(NANIMALS));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.evaluate(async (gate) => {
        const st = await import('./ui/settings.js');
        st.setTrackingThresholds({ matchGate: gate });
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__dir';
        inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
        // Continue/OK confirmations (Track All's animal count is a window.prompt: page.on('dialog'))
        setInterval(() => {
            for (const b of document.querySelectorAll('button')) {
                const t = b.textContent.trim();
                if ((t === 'Continue' || t === 'OK') && b.offsetParent !== null) b.click();
            }
        }, 300);
    }, GATE);
    await page.setInputFiles('#__dir', DATASET);
    const t0 = Date.now();
    await page.evaluate((src) => {
        window.__load = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('./loading/session-loader.js');
                const ex = new RegExp(src);
                const files = Array.from(document.getElementById('__dir').files).filter(f => !ex.test(f.webkitRelativePath || f.name));
                await sl.handleLoadSessionFolderPerCamera(files, false);
                window.__load.done = true;
            } catch (e) { window.__load.err = String(e && e.stack || e).slice(0, 600); }
        })();
    }, EXCLUDE.source);
    await page.waitForFunction(() => window.__load.done || window.__load.err, null, { timeout: 30 * 60000, polling: 1000 });
    const lerr = await page.evaluate(() => window.__load.err);
    if (lerr) throw new Error('load failed: ' + lerr);
    log(`loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    await sleep(2000);

    const waitStatus = async (re, what) => {
        const prev = await page.evaluate(() => document.getElementById('statusText').textContent);
        return async () => {
            const t = Date.now();
            for (;;) {
                const s = await page.evaluate(() => ({ status: document.getElementById('statusText').textContent,
                    hidden: document.getElementById('loadingOverlay').classList.contains('hidden') })).catch(() => null);
                if (s && s.hidden && s.status !== prev && re.test(s.status)) { log(`${what}: ${s.status} (${((Date.now() - t) / 1000).toFixed(0)} s)`); return; }
                if (Date.now() - t > 90 * 60000) throw new Error(what + ' timed out');
                await sleep(1000);
            }
        };
    };
    let done = await waitStatus(/Assigned \d+ identities/, 'Track All');
    await page.evaluate(() => document.getElementById('tbTrackAll').click());
    await done();
    await page.evaluate(async (m) => { (await import('./ui/settings.js')).setDefaultTriangulationMethod(m); }, TRI);
    done = await waitStatus(/^(Triangulated|Grouped) /, 'Triangulate All');
    await page.evaluate(() => document.getElementById('tbTriangulateAll').click());
    await done();
    summary.tracking = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        let groups = 0, with3d = 0;
        for (const [, gs] of s.instanceGroups) for (const g of gs) { groups++; if (g.points3d && g.points3d.length) with3d++; }
        return { identities: s.identities.map(i => i.name || i.id), frames: s.instanceGroups.size, groups, with3d, fps: window.__lucid.state.fps };
    });
    log('tracking: ' + JSON.stringify(summary.tracking));
    save();

    for (const variant of VARIANTS) {
        log(`== image check, ${variant}`);
        const r = await page.evaluate(async ({ variant }) => {
            const AS = await import('./ui/app-state.js');
            const E = await import('./ui/image-embedder.js');
            const SC = await import('./pose/id-switch-check.js');
            const ST = await import('./ui/settings.js');
            const session = AS.state.session;
            // snapG: "keyframes" every G frames from 0; shiftN: every 32 frames from N (= the samples moved by
            // a constant N - 32 frames: the noise floor — same density, different frames, no keyframe logic)
            const m = /^(snap|shift)(\d+)$/.exec(variant);
            const synth = (dec) => { const n = (dec && dec._mbBackend && dec._mbBackend.frameCount) || AS.state.totalFrames, k = [];
                const g = m[1] === 'snap' ? +m[2] : 32; for (let f = m[1] === 'snap' ? 0 : +m[2]; f < n; f += g) k.push(f); return k; };
            const emb = await E.createImageEmbedder(session, { maxViewsPerAnimal: ST.getTrackingThreshold('imageCheckMaxViews'),
                keyframes: variant === 'inplace' ? false : m ? synth : undefined });
            const t0 = performance.now();
            let last = 0;
            const res = await SC.checkImageSwitches(session, {
                fps: AS.state.fps, imageHz: ST.getTrackingThreshold('imageCheckHz') || 2, threshold: ST.getTrackingThreshold('imageCheckThreshold'),
                getEmbeddings: emb.getEmbeddings, prepareFrames: emb.prepareFrames, inFlight: emb.inFlight, releaseFrames: emb.releaseFrames,
                onProgress: async (stage, d, t) => { if (performance.now() - last > 60000) { last = performance.now(); console.log(`[diag] ${stage} ${d}/${t} after ${Math.round((performance.now() - t0) / 1000)} s`); } },
            });
            const timing = emb.stats();
            return { ok: res.ok, reason: res.reason, seconds: (performance.now() - t0) / 1000, timing, timingLine: E.formatEmbedTiming(timing),
                crops: res.crops, imageHz: res.imageHz, cameras: res.cameras, threshold: res.threshold,
                encounters: (res.encounters || []).map(e => ({ frame: e.frame, startFrame: e.startFrame, a: e.nameA, b: e.nameB, score: e.score, flagged: !!e.flagged, kind: e.kind || null })),
                changes: (res.changes || []).map(c => ({ frame: c.frame, a: c.nameA, b: c.nameB, score: c.score })) };
        }, { variant });
        log(`${variant}: ok=${r.ok} ${r.reason || ''} ${r.seconds.toFixed(0)} s, ${r.crops} crops, ${r.encounters.length} encounters, ${r.changes.length} change points`);
        log('  ' + r.timingLine);
        summary.variants[variant] = r;
        save();
    }
} finally {
    save();
    log('wrote ' + path.relative(repoRoot, OUT_DIR));
    if (browser) await browser.close().catch(() => {});
    await releaseBrowserLock();
    server.kill();
}
