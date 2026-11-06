/**
 * _bench-image-cache.mjs — what the image ID-switch check's embedding cache
 * (ui/image-embedder.js over pose/embedding-cache.js) buys on a real recording,
 * and that it changes nothing. Real data, real model, real check.
 *
 * Loads a per-camera session folder in real Google Chrome (HEVC + WebGPU,
 * headed, under the browser lock), then:
 *   1. Track All with SETTING_A, Triangulate All;
 *   2. image check, cache OFF            — today's run (the reference time);
 *   3. image check, cache ON, cold       — the first run: must take the same time;
 *   4. image check, cache ON, warm       — same tracking: every crop from the cache;
 *   5. Track All again with SETTING_B, Triangulate All;
 *   6. image check, cache ON             — what a re-run after re-tracking reuses;
 *   7. image check, cache OFF            — on that same tracking: 6 must equal it.
 * Every run's vectors (frame|identity|camera) are kept in the page so runs can be
 * compared bit for bit; 2 vs 3 measures how deterministic the model itself is.
 * It also measures (`masks`) whether identity-free masks — every 2D detection in
 * the view, as an embedding done before/while Track All runs would have to use —
 * would match the identity-based masks the check uses.
 *
 * Not a test (needs the dataset, a display and WebGPU). Usage:
 *     DATASET=<dir> NANIMALS=5 node tests/e2e/_bench-image-cache.mjs
 *   env: SETTING_A='{"matchGate":1}' SETTING_B='{"matchGate":0}' TRI=dlt PORT=8131 LABEL=<name>
 * Output: verify/image-cache/<LABEL>-<timestamp>/summary.json
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerTrackSetup } from './fixtures/track-setup.js';
import fs from 'node:fs';
import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DATASET = process.env.DATASET ||
    '/Users/soline/Documents/luc3d/LabMeetingPrep/Oline/20260713_174659-194366_05mice_flippers';
const NANIMALS = String(process.env.NANIMALS || 5);
const SETTING_A = JSON.parse(process.env.SETTING_A || '{"matchGate":1}');
const SETTING_B = JSON.parse(process.env.SETTING_B || '{"matchGate":0}');
const TRI = process.env.TRI || 'dlt';
const PORT = Number(process.env.PORT || 8131);
const LABEL = process.env.LABEL || path.basename(DATASET);
const EXCLUDE = new RegExp(process.env.EXCLUDE || '(^|/)\\.|/troubleshooting/|static\\.externals|\\.proofread\\.slp$');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = path.join(repoRoot, 'verify', 'image-cache', `${LABEL}-${stamp}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
const log = (m) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await sleep(1200);
const summary = { dataset: DATASET, settingA: SETTING_A, settingB: SETTING_B, tri: TRI, runs: {}, compare: {} };
const save = () => fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 1));
const releaseBrowserLock = await acquireBrowserLock({ label: '_bench-image-cache' });
let browser;
try {
    browser = await chromium.launch({ headless: false, channel: 'chrome',
        args: ['--window-size=1500,950', '--enable-unsafe-webgpu', '--js-flags=--expose-gc'] });
    const page = await browser.newPage({ viewport: { width: 1480, height: 860 } });
    page.on('pageerror', e => log('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { const t = m.text(); if (/\[ID switches|\[image-embedder|\[bench\]/.test(t)) log('console: ' + t.slice(0, 400)); });
    page.on('dialog', d => d.accept(NANIMALS));
    await answerTrackSetup(page, NANIMALS);
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.evaluate(async () => {
        const st = await import('./ui/settings.js');
        st.setTrackingThresholds({ autoImageSwitchCheck: 0 });   // the bench runs the image check itself
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__dir';
        inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
        setInterval(() => {
            for (const b of document.querySelectorAll('button')) {
                const t = b.textContent.trim();
                if ((t === 'Continue' || t === 'OK') && b.offsetParent !== null) b.click();
            }
        }, 300);
    });
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
    summary.loadSeconds = (Date.now() - t0) / 1000;
    log(`loaded in ${summary.loadSeconds.toFixed(0)} s`);
    await sleep(2000);

    const waitStatus = async (re, what) => {
        const prev = await page.evaluate(() => document.getElementById('statusText').textContent);
        return async () => {
            const t = Date.now();
            for (;;) {
                const s = await page.evaluate(() => ({ status: document.getElementById('statusText').textContent,
                    hidden: document.getElementById('loadingOverlay').classList.contains('hidden') })).catch(() => null);
                if (s && s.hidden && s.status !== prev && re.test(s.status)) { log(`${what}: ${s.status} (${((Date.now() - t) / 1000).toFixed(0)} s)`); return (Date.now() - t) / 1000; }
                if (Date.now() - t > 90 * 60000) throw new Error(what + ' timed out');
                await sleep(1000);
            }
        };
    };
    const track = async (setting, tag) => {
        await page.evaluate(async (s) => { (await import('./ui/settings.js')).setTrackingThresholds(s); }, setting);
        let done = await waitStatus(/Assigned \d+ identities/, 'Track All ' + tag);
        await page.evaluate(() => document.getElementById('tbTrackAll').click());
        const trackS = await done();
        await page.evaluate(async (m) => { (await import('./ui/settings.js')).setDefaultTriangulationMethod(m); }, TRI);
        done = await waitStatus(/^(Triangulated|Grouped) /, 'Triangulate All ' + tag);
        await page.evaluate(() => document.getElementById('tbTriangulateAll').click());
        const triS = await done();
        await sleep(1500);
        const info = await page.evaluate(() => {
            const s = window.__lucid.state.session;
            let groups = 0; for (const [, gs] of s.instanceGroups) groups += gs.length;
            return { identities: s.identities.length, frames: s.instanceGroups.size, groups, fps: window.__lucid.state.fps, lazy: !!s.lazyLoader };
        });
        return Object.assign({ trackSeconds: trackS, triangulateSeconds: triS }, info);
    };

    // one image check; vectors kept in window.__vecs[name]
    const imageCheck = async (name, cache) => {
        log(`== image check: ${name} (cache ${cache ? 'on' : 'off'})`);
        await page.evaluate(() => { if (window.gc) window.gc(); });
        const r = await page.evaluate(async ({ name, cache }) => {
            const AS = await import('./ui/app-state.js'), E = await import('./ui/image-embedder.js');
            const SC = await import('./pose/id-switch-check.js'), ST = await import('./ui/settings.js');
            const session = AS.state.session;
            const t0 = performance.now();
            const emb = await E.createImageEmbedder(session, { maxViewsPerAnimal: ST.getTrackingThreshold('imageCheckMaxViews'), cache });
            const tModel = performance.now();
            const vecs = new Map(); let last = 0;
            const res = await SC.checkImageSwitches(session, {
                fps: AS.state.fps, imageHz: ST.getTrackingThreshold('imageCheckHz') || 2, threshold: ST.getTrackingThreshold('imageChangeThreshold'),
                prepareFrames: emb.prepareFrames, croppable: emb.croppable, keyframes: emb.keyframes, inFlight: emb.inFlight, releaseFrames: emb.releaseFrames,
                getEmbeddings: async (frame, items) => { const out = await emb.getEmbeddings(frame, items);
                    out.forEach((l, ii) => l.forEach(e => vecs.set(frame + '|' + items[ii].group.identityId + '|' + e.camera, e.vector)));
                    return out; },
                onProgress: async (stage, d, t) => { if (performance.now() - last > 60000) { last = performance.now(); console.log(`[bench] ${stage} ${d}/${t} after ${Math.round((performance.now() - t0) / 1000)} s`); } },
            });
            const seconds = (performance.now() - t0) / 1000;
            (window.__vecs = window.__vecs || {})[name] = vecs;
            (window.__res = window.__res || {})[name] = res;
            const timing = emb.stats();
            return { ok: res.ok, reason: res.reason, seconds, modelLoadSeconds: (tModel - t0) / 1000, timing, timingLine: E.formatEmbedTiming(timing),
                crops: res.crops, flags: (res.flags || []).length, encounters: (res.encounters || []).length, cache: E.embeddingCacheInfo() };
        }, { name, cache });
        log(`${name}: ${r.seconds.toFixed(1)} s (model load ${r.modelLoadSeconds.toFixed(1)} s), ${r.crops} crops, ${r.encounters} contacts, ${r.flags} flagged; cache ${r.cache.entries} entries`);
        log('  ' + r.timingLine);
        summary.runs[name] = r;
        save();
        return r;
    };
    const compare = async (a, b) => {
        const c = await page.evaluate(({ a, b }) => {
            const A = window.__vecs[a], B = window.__vecs[b], ra = window.__res[a], rb = window.__res[b];
            let same = 0, differ = 0, onlyA = 0, maxAbs = 0, minCos = 1;
            A.forEach((v, k) => { const u = B.get(k); if (!u) { onlyA++; return; }
                let eq = true, ab = 0, aa = 0, bb = 0;
                for (let i = 0; i < v.length; i++) { if (!Object.is(v[i], u[i])) eq = false; maxAbs = Math.max(maxAbs, Math.abs(v[i] - u[i])); ab += v[i] * u[i]; aa += v[i] * v[i]; bb += u[i] * u[i]; }
                eq ? same++ : differ++; minCos = Math.min(minCos, ab / Math.sqrt(aa * bb)); });
            const strip = (r) => JSON.stringify({ flags: (r.flags || []).map(f => [f.frame, f.nameA, f.nameB, f.score]), enc: (r.encounters || []).map(e => [e.frame, e.nameA, e.nameB, e.score]) });
            const maxScoreDiff = (ra.encounters || []).reduce((m, e, i) => Math.max(m, Math.abs(e.score - ((rb.encounters || [])[i] || {}).score)), 0);
            return { vectorsSame: same, vectorsDiffer: differ, onlyInFirst: onlyA, onlyInSecond: [...B.keys()].filter(k => !A.has(k)).length,
                     maxAbs, minCos, resultIdentical: strip(ra) === strip(rb), maxScoreDiff,
                     flags: [(ra.flags || []).length, (rb.flags || []).length] };
        }, { a, b });
        log(`compare ${a} vs ${b}: ${JSON.stringify(c)}`);
        summary.compare[a + ' vs ' + b] = c;
        save();
        return c;
    };
    const drop = (names) => page.evaluate((n) => { n.forEach(k => { delete window.__vecs[k]; }); if (window.gc) window.gc(); }, names);

    // identity-free masks (every 2D detection in the view, as an embedding made before/while Track All runs would
    // have to mask) vs the check's (the other identity groups' members in that view): per sampled view, does the
    // view hold detections that are in no identity group? A crop shares a cache entry only if its masked hulls are
    // exactly the same set. Detections counted from the store on a lazy project (describeStoreFrame), else the
    // frame group; members counted whether croppable or not, so a mismatch is an upper bound.
    const masks = async () => page.evaluate(async () => {
        const AS = await import('./ui/app-state.js');
        const session = AS.state.session, loader = session.lazyLoader;
        const cams = AS.state.views.map(v => v.cameraName || v.name);
        const step = Math.max(1, Math.round(AS.state.fps / 2));
        let views = 0, match = 0, extra = 0, fewer = 0, frames = 0, extraDetections = 0;
        for (const [f, groups] of session.instanceGroups) {
            if (f % step) continue;
            frames++;
            for (const cam of cams) {
                let members = 0; groups.forEach(g => { if (g.identityId != null && g.instances.has(cam)) members++; });
                if (!members) continue;
                let det;
                if (loader && typeof loader.describeStoreFrame === 'function') { const d = loader.describeStoreFrame(cam, f); det = d ? d.count : 0; }
                else { const fg = session.frameGroups && session.frameGroups.get(f); det = fg ? fg.getInstances(cam).length + ((fg.unlinkedInstances && fg.unlinkedInstances.get(cam)) || []).length : 0; }
                views++;
                if (det === members) match++; else if (det > members) { extra++; extraDetections += det - members; } else fewer++;
            }
        }
        return { framesChecked: frames, views, viewsSameDetections: match, sharePct: views ? 100 * match / views : null,
                 viewsWithUngroupedDetections: extra, ungroupedDetections: extraDetections, viewsWithFewerDetectionsThanMembers: fewer };
    });

    if (process.env.MASKS_ONLY) {
        summary.trackingA = await track(SETTING_A, 'A');
        summary.masks = await masks();
        log('masks: ' + JSON.stringify(summary.masks));
        save();
        throw Object.assign(new Error('masks only'), { done: true });
    }
    if (process.env.TIMING) {   // first-run cost: off, cold, cold, off, … so drift over the session (GPU heat) cancels
        summary.trackingA = await track(SETTING_A, 'A');
        for (let i = 0; i < Number(process.env.TIMING); i++) {
            for (const cache of (i % 2 ? [true, false] : [false, true])) {
                const name = (cache ? 'cold' : 'off') + i;
                if (cache) await page.evaluate(async () => (await import('./ui/image-embedder.js')).clearEmbeddingCache());
                await imageCheck(name, cache); await drop([name]);
            }
        }
        throw Object.assign(new Error('timing only'), { done: true });
    }

    summary.trackingA = await track(SETTING_A, 'A');
    log('tracking A: ' + JSON.stringify(summary.trackingA));
    await imageCheck('off', false);
    await page.evaluate(async () => (await import('./ui/image-embedder.js')).clearEmbeddingCache());
    await imageCheck('cold', true);
    await compare('off', 'cold');
    await drop(['off']);
    await imageCheck('warmA', true);
    await compare('cold', 'warmA');
    summary.masks = await masks();
    log('masks: ' + JSON.stringify(summary.masks));
    save();
    await drop(['cold']);

    summary.trackingB = await track(SETTING_B, 'B');
    log('tracking B: ' + JSON.stringify(summary.trackingB));
    await imageCheck('afterRetrack', true);
    await imageCheck('afterRetrackOff', false);
    await compare('afterRetrackOff', 'afterRetrack');
    // how many of the re-run's crops are the same crops as before re-tracking (same frame, identity, camera, vector)
    summary.compare['warmA vs afterRetrack'] = await compare('warmA', 'afterRetrack');
} catch (e) {
    if (!e.done) throw e;
} finally {
    save();
    log('wrote ' + path.relative(repoRoot, OUT_DIR));
    if (browser) await browser.close().catch(() => {});
    await releaseBrowserLock();
    server.kill();
}
