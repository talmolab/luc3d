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
        // ---- post-reload heap attribution (strip one structure at a time) ----
        if (process.env.ATTRIBUTE) {
            const attr = await page2.evaluate(async () => {
                const gc = async () => {
                    for (let i = 0; i < 5; i++) window.gc && window.gc();
                    await new Promise(r => setTimeout(r, 200));
                };
                const mb = () => +(performance.memory.usedJSHeapSize / 1048576).toFixed(0);
                const st = window.__lucid.state, s = st.session;
                const out = [];
                await gc(); out.push(['baseline', mb()]);
                s.instanceGroups = new Map();
                await gc(); out.push(['- instanceGroups', mb()]);
                s.frameIdentityMap = new Map();
                await gc(); out.push(['- frameIdentityMap', mb()]);
                s.frameGroups = new Map();
                await gc(); out.push(['- frameGroups', mb()]);
                const loader = s.lazyLoader;
                let storeInfo = null;
                if (loader) {
                    storeInfo = { cams: loader.labelsByCam ? loader.labelsByCam.size : 0 };
                    s.lazyLoader = null;
                    if (loader.close) { try { loader.close(); } catch (e) {} }
                }
                await gc(); out.push(['- lazyLoader', mb()]);
                st.triangulationResults = new Map();
                await gc(); out.push(['- triangulationResults', mb()]);

                // Widen the sweep: anything else the page still holds.
                const sess0 = st.sessions && st.sessions[0];
                out.push(['(sessions[0] === session)', (sess0 === s) ? 1 : 0]);
                if (st.sessions) for (const ss of st.sessions) {
                    ss.instanceGroups = new Map(); ss.frameGroups = new Map();
                    ss.frameIdentityMap = new Map();
                    if (ss.lazyLoader) { try { ss.lazyLoader.close(); } catch (e) {} ss.lazyLoader = null; }
                    ss.triangulationResults = new Map();
                    ss._views = null; ss._videoController = null;
                }
                await gc(); out.push(['- all sessions[] state', mb()]);

                st.views = []; st.videoFiles = []; st.slpFileHandle = null;
                await gc(); out.push(['- views/videoFiles/handle', mb()]);

                st.sessions = []; st.session = null;
                await gc(); out.push(['- sessions[] itself', mb()]);
                // Where is the rest? h5wasm keeps the opened file in its WASM
                // heap (hard-capped at 2 GiB by getHeapMax), and that ArrayBuffer
                // is counted by usedJSHeapSize.
                let wasmMB = null, wasmWho = null;
                try {
                    let m = window.h5wasm;
                    if (m && m.ready && typeof m.ready.then === 'function') m = await m.ready;
                    if (m && m.HEAPU8) { wasmMB = +(m.HEAPU8.length / 1048576).toFixed(0); wasmWho = 'global-iife'; }
                } catch (e) {}
                out.push(['h5wasm WASM heap (global IIFE)', wasmMB]);
                // There are TWO h5wasm instances in the page: the IIFE global from
                // index.html, and the ESM one the importmap resolves for
                // readSlpStreaming / SioLazyLoader. They have SEPARATE WASM heaps.
                let esmMB = null;
                try {
                    const em = await import('/lib/h5wasm/hdf5_hl.js');
                    const mod = await em.ready;
                    if (mod && mod.HEAPU8) esmMB = +(mod.HEAPU8.length / 1048576).toFixed(0);
                } catch (e) { esmMB = 'err:' + String(e).slice(0, 80); }
                out.push(['h5wasm WASM heap (ESM)', esmMB]);
                return { steps: out, storeInfo, wasmMB, wasmWho, limitMB: +(performance.memory.jsHeapSizeLimit/1048576).toFixed(0) };
            });
            log(`\n[${el()}] === post-reload heap attribution ===`);
            let prev = null;
            for (const [label, v] of attr.steps) {
                log(`     ${String(v).padStart(5)} MB  ${label}` + (prev !== null ? `   (freed ${prev - v} MB)` : ''));
                prev = v;
            }
            log(`     limit ${attr.limitMB} MB; stores: ${JSON.stringify(attr.storeInfo)}`);
        }

        // ---------------- STAGE 6: modify the reloaded project, save again ----
        // The round trip the user actually needs is not just save->load, it is
        // load -> track -> triangulate -> save -> RELOAD -> EDIT -> SAVE AGAIN.
        if (!r2.err && r2.groups > 0 && process.env.MODIFY_RESAVE) {
            log(`\n[${el()}] === STAGE modify + resave ===`);
            const edited = await page2.evaluate(() => {
                const st = window.__lucid.state;
                const s = st.session;
                // Find a resident group with a member carrying real coordinates.
                for (const [frameIdx, gs] of s.instanceGroups) {
                    for (const g of gs) {
                        for (const [camName, inst] of g.instances) {
                            if (!inst.hasPoint(0)) continue;
                            const before = inst.getPoint(0);
                            inst.setPoint(0, before[0] + 7.5, before[1] - 3.25);
                            inst.type = 'user';
                            inst.modified = true;
                            g.markDirty();
                            return { frameIdx, camName, before, after: inst.getPoint(0) };
                        }
                    }
                }
                return null;
            });
            check(!!edited, `edited a keypoint on the reloaded project (${JSON.stringify(edited)})`);

            let bytes2 = 0;
            let fd2 = null;
            const OUT2 = OUT_SLP.replace(/\.slp$/, '-resave.slp');
            await page2.exposeFunction('__appendChunk2', (b64) => {
                if (fd2 === null) fd2 = fs.openSync(OUT2, 'w');
                const buf = Buffer.from(b64, 'base64');
                fs.writeSync(fd2, buf); bytes2 += buf.length;
            });
            const r3 = await page2.evaluate(async () => {
                const saveLoad = await import('/import-export/save-load.js');
                function toB64(u8) {
                    let s = ''; const C = 0x8000;
                    for (let o = 0; o < u8.length; o += C) s += String.fromCharCode.apply(null, u8.subarray(o, o + C));
                    return btoa(s);
                }
                window.showSaveFilePicker = async () => ({
                    createWritable: async () => ({
                        write: async (chunk) => {
                            const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                            await window.__appendChunk2(toB64(u8));
                        },
                        close: async () => {},
                    }),
                });
                const t = performance.now();
                let err = null;
                try { await saveLoad.saveAs({ skipSizeWarning: true }); }
                catch (e) { err = String(e && e.stack || e).slice(0, 600); }
                return { ms: Math.round(performance.now() - t), err };
            });
            if (fd2 !== null) fs.closeSync(fd2);
            log(`[${el()}] resave: ${r3.ms} ms  err=${r3.err || 'none'}`);
            check(!r3.err, `resave completed${r3.err ? ' — ' + r3.err : ''}`);
            check(bytes2 > 100e6, `resave wrote a real file (${(bytes2 / 1e6).toFixed(1)} MB)`);
            try { fs.unlinkSync(OUT2); } catch (e) {}
        }
        await page2.close();
    }

} catch (err) {
    console.error(`[${el()}] FATAL`, String(err).slice(0, 600));
    fails++;
} finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    server.kill();
    try { if (fs.existsSync(OUT_SLP)) log('saved file: ' + OUT_SLP + ' ' + fs.statSync(OUT_SLP).size + ' bytes'); } catch (e) {}
}

log(fails === 0 ? `\nPASS (${el()})` : `\nFAIL (${fails}) (${el()})`);
process.exit(fails === 0 ? 0 : 1);
