/**
 * _real-roundtrip.mjs — the ACCEPTANCE harness, run against the real bug-report
 * project at _bugdata/20260709171244_labMeetingPrep (5 cameras x 180,210 frames,
 * 2,630,632 instances, 39,459,480 2D points).
 *
 * Drives the real app end to end:
 *     load (lazy, videos deferred)
 *  -> Track All
 *  -> Triangulate All
 *  -> Save As (merged .slp, streamed to disk)
 *  -> reload the saved file
 *  -> verify grouping/3D survived
 *
 * Reports wall time and heap after every phase, and fails loudly if the renderer
 * dies. `usedJSHeapSize` counts typed-array backing stores, which do NOT count
 * against the ~4 GB pointer-compressed cap, so the cage figure is estimated
 * separately from the live object graph.
 *
 * Not a test (needs the 3.4 GB dataset). Usage:
 *     node _real-roundtrip.mjs [stage] [port]
 *       stage: load | track | tri | save | reload | all   (default: load)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const STAGE = process.argv[2] || 'load';
const PORT = Number(process.argv[3] || 8110);
const PROJ = '_bugdata/20260709171244_labMeetingPrep';
const ALL_CAMS = ['21241563', '21369048', '21372315', '21372316', '22085397'];
const NCAM = Number(process.env.NCAM || process.argv[4] || ALL_CAMS.length);
const CAMS = ALL_CAMS.slice(0, NCAM);
const OUT_SLP = path.join(repoRoot, `_real-roundtrip-${process.pid}.slp`);

const RELOAD_FILE = process.env.RELOAD_FILE || null;   // skip straight to the reload stage
const STAGE_ORDER = ['load', 'track', 'tri', 'save', 'reload'];
const upto = STAGE === 'all' ? STAGE_ORDER.length : (STAGE_ORDER.indexOf(STAGE) + 1);
if (upto < 1) { console.error('unknown stage', STAGE); process.exit(2); }

let fails = 0;
const log = (m) => { process.stdout.write(m + '\n'); };
const check = (c, m) => { log((c ? '  \u2713 ' : '  \u2717 ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));

let browser;
const t00 = Date.now();
const el = () => ((Date.now() - t00) / 1000).toFixed(1) + 's';

try {
    browser = await chromium.launch({
        args: ['--js-flags=--expose-gc', '--enable-precise-memory-info',
               '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    page.on('pageerror', e => log(`  [${el()}] [pageerror] ` + String(e).slice(0, 300)));
    page.on('crash', () => { log(`  [${el()}] *** RENDERER CRASHED ***`); fails++; });
    // Track All asks for the animal count via window.prompt(); Playwright
    // auto-DISMISSES dialogs, which makes promptNumAnimals() return false and
    // trackAll() bail in 2 ms. Answer it. 3 matches the real run's identity count.
    page.on('dialog', async d => { await d.accept(process.env.NANIMALS || '3'); });
    page.on('console', m => {
        const t = m.text();
        if (/phase:|\[slp-streaming-write\]|\[save-slp\]|MEM:|FETCH|\[session-folder\]/.test(t)) log(`  [${el()}] ${t.slice(0, 220)}`);
    });

    // Stream the saved .slp straight to disk (the app uses showSaveFilePicker).
    let bytesWritten = 0;
    let fd = null;
    await page.exposeFunction('__appendChunkBase64', (b64) => {
        if (fd === null) fd = fs.openSync(OUT_SLP, 'w');
        const buf = Buffer.from(b64, 'base64');
        fs.writeSync(fd, buf);
        bytesWritten += buf.length;
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 30000 });
    log(`[${el()}] app booted`);

    // ---------------- helpers injected into the page ----------------
    await page.evaluate(() => {
        window.__mem = async function (label) {
            if (window.gc) { window.gc(); window.gc(); }
            await new Promise(r => setTimeout(r, 120));
            const m = performance.memory;
            // Estimated CAGE pressure from the live object graph (typed-array
            // backing stores are outside the cap, so usedJSHeapSize overstates).
            let inst = 0, grp = 0, with3d = 0, fim = 0;
            const s = window.__lucid.state.session;
            if (s) {
                if (s.instanceGroups) {
                    for (const [, gs] of s.instanceGroups) {
                        for (const g of gs) {
                            grp++;
                            inst += (g.instances && g.instances.size) || 0;
                            if (g.points3d) with3d++;
                        }
                    }
                }
                fim = (s.frameIdentityMap && s.frameIdentityMap.size) || 0;
            }
            const rec = {
                label,
                usedMB: +(m.usedJSHeapSize / 1048576).toFixed(0),
                limitMB: +(m.jsHeapSizeLimit / 1048576).toFixed(0),
                groups: grp, members: inst, with3d, fim,
            };
            console.log('MEM: ' + JSON.stringify(rec));
            return rec;
        };
    });

    const mem = (label) => page.evaluate(l => window.__mem(l), label);

    // ---------------- STAGE 1: load ----------------
    if (!RELOAD_FILE) {
    log(`\n[${el()}] === STAGE load ===`);
    // The folder loader opens a blocking "Missing Camera Directories / Missing
    // Video Files" popup whenever calibration lists a camera we did not supply,
    // or a camera has annotations but no video — and we deliberately defer the
    // 1.9 GB of mp4s. Headlessly nothing ever clicks Continue, so auto-dismiss it.
    await page.evaluate(() => {
        window.__dismissed = 0;
        window.__autoDismiss = setInterval(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            for (const b of btns) {
                if (b.textContent.trim() === 'Continue' && b.offsetParent !== null) {
                    b.click(); window.__dismissed++;
                }
            }
        }, 250);
    });

    const loadRes = await page.evaluate(async ({ PROJ, CAMS }) => {
        const sl = await import('/loading/session-loader.js');
        const files = [];
        const root = 'labMeetingPrep';
        async function grab(url, relPath) {
            console.log('FETCH start ' + url);
            const t = performance.now();
            const r = await fetch(url);
            if (!r.ok) throw new Error('fetch failed ' + url + ' ' + r.status);
            const buf = await r.arrayBuffer();
            console.log('FETCH done ' + url + ' ' + (buf.byteLength / 1e6).toFixed(0) + ' MB in ' + Math.round(performance.now() - t) + ' ms');
            const f = new File([buf], relPath.split('/').pop());
            Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
            return f;
        }
        files.push(await grab(`/${PROJ}/20260709162616_calibration.toml`,
            `${root}/20260709162616_calibration.toml`));
        for (const cam of CAMS) {
            files.push(await grab(`/${PROJ}/${cam}/${cam}-20260709171244.slp`,
                `${root}/${cam}/${cam}-20260709171244.slp`));
        }
        const t = performance.now();
        // deferVideos = true: no mp4s fetched, pose data only.
        await sl.handleLoadSessionFolderPerCamera(files, true);
        const ms = Math.round(performance.now() - t);
        const s = window.__lucid.state.session;
        return {
            ms,
            hasSession: !!s,
            cameras: s ? s.cameras.map(c => c.name) : null,
            nFrames: s && s.lazyLoader ? s.lazyLoader.nFrames : null,
            tracks: s ? s.tracks.length : null,
            totalFrames: window.__lucid.state.totalFrames,
        };
    }, { PROJ, CAMS });
    log(`[${el()}] load: ${loadRes.ms} ms ` + JSON.stringify(loadRes).slice(0, 240));
    log(`[${el()}] auto-dismissed ${await page.evaluate(() => window.__dismissed)} modal(s)`);
    check(loadRes.hasSession, 'session loaded');
    check(loadRes.nFrames >= 180000, `lazy loader sees all frames (${loadRes.nFrames})`);
    // Cameras come from the calibration TOML (always 5), independent of how
    // many camera directories were supplied.
    check((loadRes.cameras || []).length === 5, `5 cameras from calibration (${(loadRes.cameras || []).length})`);
    await mem('after load');

    // ---------------- STAGE 2: Track All ----------------
    if (upto >= 2) {
        log(`\n[${el()}] === STAGE track ===`);
        const r = await page.evaluate(async () => {
            const tr = await import('/pose/tracker.js');
            const t = performance.now();
            await tr.trackAll();
            return { ms: Math.round(performance.now() - t) };
        });
        log(`[${el()}] Track All: ${r.ms} ms`);
        const m = await mem('after Track All');
        check(m.fim > 1000000, `frameIdentityMap populated (${m.fim.toLocaleString()})`);
    }

    // ---------------- STAGE 3: Triangulate All ----------------
    if (upto >= 3) {
        log(`\n[${el()}] === STAGE tri ===`);
        const r = await page.evaluate(async () => {
            const em = await import('/ui/export-modals.js');
            const t = performance.now();
            await em.groupByIdentityAndTriangulateAll();
            return { ms: Math.round(performance.now() - t) };
        });
        log(`[${el()}] Triangulate All: ${r.ms} ms`);
        const m = await mem('after Triangulate All (pre-save baseline)');
        check(m.groups > 100000, `instance groups built (${m.groups.toLocaleString()})`);
        check(m.with3d > 100000, `groups carry 3D (${m.with3d.toLocaleString()})`);
    }

    // ---------------- STAGE 4: Save ----------------
    if (upto >= 4) {
        log(`\n[${el()}] === STAGE save ===`);
        const r = await page.evaluate(async () => {
            const saveLoad = await import('/import-export/save-load.js');
            function toB64(bytes) {
                let s = '';
                const C = 0x8000;
                for (let o = 0; o < bytes.length; o += C) s += String.fromCharCode.apply(null, bytes.subarray(o, o + C));
                return btoa(s);
            }
            window.showSaveFilePicker = async () => ({
                createWritable: async () => ({
                    write: async (chunk) => {
                        const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                        await window.__appendChunkBase64(toB64(u8));
                    },
                    close: async () => {},
                }),
            });
            const t = performance.now();
            let err = null;
            try { await saveLoad.saveAs({ skipSizeWarning: true }); }
            catch (e) { err = String(e && e.stack || e).slice(0, 500); }
            return { ms: Math.round(performance.now() - t), err };
        });
        log(`[${el()}] Save As: ${r.ms} ms  err=${r.err || 'none'}`);
        if (fd !== null) { fs.closeSync(fd); fd = null; }
        check(!r.err, `save completed without throwing${r.err ? ' — ' + r.err : ''}`);
        check(bytesWritten > 100e6, `wrote a real file (${(bytesWritten / 1e6).toFixed(1)} MB)`);
        await mem('after save');
    }

    } // end of the load->save prefix (skipped when RELOAD_FILE is set)

    // ---------------- STAGE 5: reload the saved file ----------------
    if (upto >= 5 && (bytesWritten > 0 || RELOAD_FILE)) {
        log(`\n[${el()}] === STAGE reload ===`);
        const servedName = RELOAD_FILE ? path.basename(RELOAD_FILE) : path.basename(OUT_SLP);
        const RELOAD_ABS = path.isAbsolute(RELOAD_FILE || '')
            ? RELOAD_FILE : path.join(repoRoot, servedName);
        // CLOSE PAGE 1 FIRST. It still holds the entire post-Track-All +
        // post-Triangulate-All + post-save heap (~2.9 GB on the real project), and
        // it is same-origin with page 2, so Chrome puts both in ONE renderer
        // process sharing ONE ~3.76 GB JS-heap cap. Leaving it open made every
        // reload-stage heap number double-count, and made a save-after-reload look
        // like it crashed on its own footprint when really it was competing with a
        // page a user would never still have open. A user REFRESHES: one document
        // at a time, same process — which is what closing page 1 here models.
        await page.close();
        const page2 = await browser.newPage();
        page2.on('pageerror', e => log(`  [${el()}] [p2 pageerror] ` + String(e).slice(0, 300)));
        page2.on('crash', () => { log(`  [${el()}] *** p2 RENDERER CRASHED ***`); fails++; });
        page2.on('console', m => { const t = m.text(); if (/MEM:|phase:/.test(t)) log(`  [${el()}] ${t.slice(0, 220)}`); });
        await page2.goto(`http://localhost:${PORT}/index.html`);
        await page2.waitForFunction(() => window.__lucid && window.SleapIO, { timeout: 30000 });
        // Auto-dismiss the missing-files popup and the "attach videos" modal
        // that handleLoadProjectSlpLazy awaits near its end.
        await page2.evaluate(() => {
            setInterval(() => {
                for (const b of Array.from(document.querySelectorAll('button'))) {
                    const t = b.textContent.trim();
                    // "Skip \u2014 Load Videos Later" is the one that lets
                    // handleLoadProjectSlpLazy actually RETURN. Until it does, the
                    // suspended async frame pins every local it holds (~2.5 GB).
                    if ((t === 'Continue' || t.startsWith('Skip') ||
                         t === 'Cancel' || t === 'Close') && b.offsetParent !== null) b.click();
                }
            }, 250);
        });

        // Fire the loader WITHOUT awaiting it: it ends in an interactive
        // attach-videos modal that never resolves headlessly. Everything under
        // test (grouping + 3D reconstruction) completes before that await, so
        // poll the resulting state instead of blocking on the whole chain.
        // Hand the loader a DISK-BACKED File via a real <input type=file>, the
        // way the user's file picker does. Fetching the 1.4 GB into an
        // ArrayBuffer and wrapping it in `new File([buf])` would pin the whole
        // file in renderer memory for the entire run — ~1.4 GB of pressure the
        // real app never carries, and enough on its own to decide whether a
        // subsequent save survives.
        await page2.evaluate(() => {
            const inp = document.createElement('input');
            inp.type = 'file';
            inp.id = '__reloadPicker';
            inp.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(inp);
        });
        await page2.setInputFiles('#__reloadPicker', RELOAD_ABS);
        await page2.evaluate(() => {
            window.__reload = { done: false, err: null, t0: performance.now() };
            (async () => {
                try {
                    const sl = await import('/loading/session-loader.js');
                    const f = document.getElementById('__reloadPicker').files[0];
                    sl.handleLoadProjectSlpLazy(f)
                        .then(() => { window.__reload.done = true; })
                        .catch(e => { window.__reload.err = String(e && e.stack || e).slice(0, 400); });
                } catch (e) { window.__reload.err = String(e && e.stack || e).slice(0, 400); }
            })();
        });

        const probe = () => page2.evaluate(() => {
            const s = window.__lucid.state.session;
            let groups = 0, with3d = 0;
            if (s && s.instanceGroups) {
                for (const [, gs] of s.instanceGroups) {
                    for (const g of gs) { groups++; if (g.points3d) with3d++; }
                }
            }
            return {
                groups, with3d,
                fim: s && s.frameIdentityMap ? s.frameIdentityMap.size : 0,
                err: window.__reload.err, done: window.__reload.done,
                ms: Math.round(performance.now() - window.__reload.t0),
                usedMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(0),
            };
        });

        const RELOAD_TIMEOUT_MS = 40 * 60 * 1000;
        const pollStart = Date.now();
        let r2 = await probe();
        while (Date.now() - pollStart < RELOAD_TIMEOUT_MS && !r2.err && r2.groups === 0 && !r2.done) {
            await new Promise(r => setTimeout(r, 5000));
            r2 = await probe();
        }
        // Wait for the loader to RETURN, not just to have produced groups —
        // a suspended async frame retains all of its locals.
        const doneDeadline = Date.now() + 5 * 60 * 1000;
        while (!r2.err && !r2.done && Date.now() < doneDeadline) {
            await new Promise(r => setTimeout(r, 3000));
            r2 = await probe();
        }
        log(`[${el()}] loader returned: ${r2.done}`);

        // Groups appear incrementally — wait for the count to stop moving.
        let prev = -1;
        while (!r2.err && r2.groups !== prev && Date.now() - pollStart < RELOAD_TIMEOUT_MS) {
            prev = r2.groups;
            await new Promise(r => setTimeout(r, 10000));
            r2 = await probe();
        }
        log(`[${el()}] reload: ${r2.ms} ms ` + JSON.stringify(r2).slice(0, 260));
        check(!r2.err, `reload completed${r2.err ? ' — ' + r2.err : ''}`);
        check(r2.groups > 100000, `grouping round-tripped (${r2.groups.toLocaleString()} groups)`);
        check(r2.with3d > 100000, `3D round-tripped (${r2.with3d.toLocaleString()})`);

        // =================================================================
        // ATTACH THE VIDEOS, then measure what is actually PAINTED.
        // =================================================================
        // Every other harness in this repo defers the mp4s ("Skip — Load Videos
        // Later"), which is why none of them can see this bug: the overlay-clear
        // in loading/video.js (1287/1468/1602) only runs on the video path. With
        // videos attached, every seek/playback repaint CLEARS each view's overlay
        // canvas and then calls drawAllOverlays — which, on a lazy project, early-
        // returns when the frame isn't resident (ui/rendering.js:104), leaving the
        // canvas blank and deferring the repaint behind a
        // `state.currentFrame === frameIdx` guard that playback invalidates.
        //
        // So this measures PIXELS, not data structures: a view whose overlay
        // canvas has zero non-transparent pixels is a view the user sees empty.
        const VIDEO_DIR = `${repoRoot}/_bugdata/20260709171244_labMeetingPrep`;
        const videoPaths = CAMS.map(c => `${VIDEO_DIR}/${c}/${c}-20260709171244.mp4`);
        for (const p of videoPaths) {
            if (!fs.existsSync(p)) { log(`  MISSING VIDEO ${p}`); }
        }
        log(`\n[${el()}] === attaching ${videoPaths.length} videos (disk-backed, not fetched) ===`);
        await page2.evaluate(() => {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.id = '__vidPicker'; inp.multiple = true;
            inp.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(inp);
        });
        await page2.setInputFiles('#__vidPicker', videoPaths);
        const attachRes = await page2.evaluate(async () => {
            try {
                const sl = await import('/loading/session-loader.js');
                const st = window.__lucid.state;
                const files = Array.from(document.getElementById('__vidPicker').files);
                await sl.attachVideosForLazyReopen(st.session, st.session.lazyLoader, files);
                return {
                    ok: true,
                    views: st.views.map(v => ({
                        name: v.name, hasDecoder: !!v.decoder,
                        hasOverlay: !!(v.overlayCanvas && v.overlayCtx),
                        w: v.overlayCanvas ? v.overlayCanvas.width : 0,
                        h: v.overlayCanvas ? v.overlayCanvas.height : 0,
                    })),
                    hasController: !!window.__lucid.videoController,
                };
            } catch (e) { return { ok: false, err: String(e && e.stack || e).slice(0, 500) }; }
        });
        log(`[${el()}] attach: ` + JSON.stringify(attachRes).slice(0, 500));
        check(attachRes.ok, `videos attached${attachRes.err ? ' — ' + attachRes.err : ''}`);

        // Count painted overlay pixels per view, per frame, driving the SAME
        // transport the user drives.
        const paintProbe = async (frameIdx, how) => page2.evaluate(async ({ frameIdx, how }) => {
            const st = window.__lucid.state;
            const init = await import('/pose/initialization.js');
            if (how === 'seek' && window.__lucid.videoController) {
                await window.__lucid.videoController.seekToFrame(frameIdx);
            } else {
                await init.navigateToFrame(frameIdx);
            }
            await new Promise(r => setTimeout(r, 700));   // let hydration + repaint settle
            const per = [];
            for (const v of st.views) {
                if (!v.overlayCanvas || !v.overlayCtx) { per.push({ name: v.name, painted: -1 }); continue; }
                const w = v.overlayCanvas.width, h = v.overlayCanvas.height;
                let painted = 0;
                try {
                    const d = v.overlayCtx.getImageData(0, 0, w, h).data;
                    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) painted++;
                } catch (e) { painted = -2; }
                per.push({ name: v.name, painted });
            }
            const groups = st.session.instanceGroups.get(frameIdx) || [];
            let withReproj = 0;
            for (const g of groups) if (g.reprojections && Object.keys(g.reprojections).length) withReproj++;
            return {
                f: frameIdx, per, groups: groups.length, withReproj,
                resident: st.session.frameGroups.has(frameIdx),
            };
        }, { frameIdx, how });

        const fmt = (r) => `frame ${String(r.f).padStart(6)} [${r.resident ? 'res' : '   '}] ` +
            `groups=${r.groups} reprojGroups=${r.withReproj} painted=` +
            r.per.map(p => `${p.name}:${p.painted}`).join(' ');

        const START = 1000;
        log(`\n[${el()}] === BEFORE Triangulate All: warm the cache by stepping ===`);
        const beforeRows = [];
        for (const f of [START, START + 1, START + 2, START + 3]) {
            const r = await paintProbe(f, 'seek');
            beforeRows.push(r); log('  ' + fmt(r));
        }
        // Revisit the same frames — this is the "warm cache" case the user had.
        log(`  -- revisiting the same frames (warm) --`);
        const warmRows = [];
        for (const f of [START, START + 1, START + 2, START + 3]) {
            const r = await paintProbe(f, 'seek');
            warmRows.push(r); log('  ' + fmt(r));
        }

        // PROJECT-WIDE totals. The per-frame probes below only cover 4 frames; a
        // regression that empties frames elsewhere would sail past them. This is
        // the number that actually answers "did Triangulate All delete my 3D".
        const totals = () => page2.evaluate(() => {
            const s = window.__lucid.state.session;
            let frames = 0, groups = 0, with3d = 0;
            for (const [, gs] of s.instanceGroups) {
                frames++;
                for (const g of gs) {
                    groups++;
                    if (g.points3d && g.points3d.length) {
                        for (let i = 0; i < g.points3d.length; i++) {
                            if (Number.isFinite(g.points3d[i])) { with3d++; break; }
                        }
                    }
                }
            }
            return { frames, groups, with3d };
        });
        const totBefore = await totals();
        log(`[${el()}] PROJECT-WIDE before: ${totBefore.frames.toLocaleString()} frames, ` +
            `${totBefore.groups.toLocaleString()} groups, ${totBefore.with3d.toLocaleString()} with 3D`);

        log(`\n[${el()}] === TRIANGULATE ALL ===`);
        const triStart = Date.now();
        await page2.evaluate(() => {
            window.__tri = { done: false, err: null };
            (async () => {
                try {
                    // THE FUNCTION THE TOOLBAR ACTUALLY CALLS. ui-wiring.js:2146
                    // routes "Triangulate All" (default DLT) to
                    // groupByIdentityAndTriangulateAll whenever the session has
                    // identities — which the real project does. Every earlier
                    // diagnostic called triangulateAllFrames('dlt') directly and
                    // therefore never exercised this path at all.
                    const em = await import('/ui/export-modals.js');
                    await em.groupByIdentityAndTriangulateAll();
                    window.__tri.done = true;
                } catch (e) { window.__tri.err = String(e && e.stack || e).slice(0, 500); }
            })();
        });
        while (Date.now() - triStart < 45 * 60 * 1000) {
            await new Promise(r => setTimeout(r, 10000));
            const s = await page2.evaluate(() => ({ done: window.__tri.done, err: window.__tri.err,
                usedMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) }));
            if (s.done || s.err) { check(!s.err, `Triangulate All completed${s.err ? ' — ' + s.err : ''}`); break; }
            log(`  [${el()}] triangulating... heap=${s.usedMB} MB`);
        }
        log(`[${el()}] Triangulate All finished in ${((Date.now() - triStart) / 1000).toFixed(1)}s`);

        const totAfter = await totals();
        log(`[${el()}] PROJECT-WIDE after : ${totAfter.frames.toLocaleString()} frames, ` +
            `${totAfter.groups.toLocaleString()} groups, ${totAfter.with3d.toLocaleString()} with 3D`);
        check(totAfter.groups >= totBefore.groups * 0.99,
            `project-wide group count preserved (${totBefore.groups.toLocaleString()} -> ${totAfter.groups.toLocaleString()})`);
        check(totAfter.with3d >= totBefore.with3d * 0.99,
            `project-wide 3D preserved (${totBefore.with3d.toLocaleString()} -> ${totAfter.with3d.toLocaleString()})`);

        log(`\n[${el()}] === AFTER Triangulate All: same frames, same transport ===`);
        const afterRows = [];
        for (const f of [START, START + 1, START + 2, START + 3]) {
            const r = await paintProbe(f, 'seek');
            afterRows.push(r); log('  ' + fmt(r));
        }

        log(`\n[${el()}] === AFTER: press PLAY and sample ===`);
        await page2.evaluate(async () => {
            const st = window.__lucid.state;
            if (window.__lucid.videoController) {
                await window.__lucid.videoController.seekToFrame(2000);
                if (window.__lucid.videoController.startPlayback) window.__lucid.videoController.startPlayback();
                else if (window.__lucid.videoController.play) window.__lucid.videoController.play();
            }
        });
        const playSamples = [];
        for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 1200));
            const s = await page2.evaluate(() => {
                const st = window.__lucid.state;
                const per = [];
                for (const v of st.views) {
                    if (!v.overlayCanvas || !v.overlayCtx) { per.push({ name: v.name, painted: -1 }); continue; }
                    let painted = 0;
                    try {
                        const d = v.overlayCtx.getImageData(0, 0, v.overlayCanvas.width, v.overlayCanvas.height).data;
                        for (let k = 3; k < d.length; k += 4) if (d[k] !== 0) painted++;
                    } catch (e) { painted = -2; }
                    per.push({ name: v.name, painted });
                }
                return { f: st.currentFrame, per };
            });
            playSamples.push(s);
            log(`  play sample ${i}: frame ${s.f} painted=` + s.per.map(p => `${p.name}:${p.painted}`).join(' '));
        }
        await page2.evaluate(() => {
            const vc = window.__lucid.videoController;
            if (vc && vc.stopPlayback) vc.stopPlayback();
        });

        const anyPainted = (rows) => rows.filter(r => r.per.some(p => p.painted > 0)).length;
        log('');
        log(`SUMMARY (frames with ANY painted overlay pixels):`);
        log(`  before triangulate, cold : ${anyPainted(beforeRows)}/${beforeRows.length}`);
        log(`  before triangulate, warm : ${anyPainted(warmRows)}/${warmRows.length}`);
        log(`  after  triangulate       : ${anyPainted(afterRows)}/${afterRows.length}`);
        log(`  during playback after    : ${anyPainted(playSamples)}/${playSamples.length}`);
        // PIXELS ARE NOT ENOUGH. The raw 2D skeletons keep drawing even when every
        // group (and its 3D + reprojections) has been destroyed, so a
        // "some pixels are painted" assertion passes straight through the bug this
        // harness exists to catch — it did, on the run that first reproduced it.
        // Assert on the GROUP COUNT, which is what actually vanished: 3 -> 0.
        log('');
        log('GROUP COUNTS per probe frame (before -> after):');
        let lost = 0;
        for (let i = 0; i < beforeRows.length; i++) {
            const b = beforeRows[i], a = afterRows[i];
            const bad = b.groups > 0 && a.groups < b.groups;
            if (bad) lost++;
            log(`  frame ${b.f}: groups ${b.groups} -> ${a.groups}, ` +
                `reprojGroups ${b.withReproj} -> ${a.withReproj}${bad ? '   <-- LOST' : ''}`);
        }
        check(lost === 0, `no probe frame lost instance groups to Triangulate All (${lost} did)`);
        check(afterRows.every(r => r.withReproj >= 1 || r.groups === 0),
            'frames that still have groups also still resolve reprojections');
        check(anyPainted(afterRows) === afterRows.length,
            'every stepped frame still paints overlays AFTER Triangulate All');
        check(anyPainted(playSamples) > 0,
            'playback paints overlays AFTER Triangulate All');

        await page2.close();
    }

} catch (err) {
    console.error(`[${el()}] FATAL`, String(err).slice(0, 600));
    fails++;
} finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    server.kill();
}

log(fails === 0 ? `\nPASS (${el()})` : `\nFAIL (${fails}) (${el()})`);
process.exit(fails === 0 ? 0 : 1);
