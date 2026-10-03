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

        // ================================================================
        // TRIANGULATE ALL on the reopened REAL project, then ask what the
        // UI would actually draw on frames other than the one on screen.
        // ================================================================
        // Reported: after Triangulate All the 3D/reprojections are gone from the
        // instance panel and the IDs are gone from the 2D views, except on the
        // first frame and (in one report) except for camera 21241563 — the FIRST
        // camera in this project. The windowed sweep deliberately does not retain
        // `group.reprojections` and relies on `drawAllOverlays` recomputing them
        // per frame; the 6,000-frame synthetic fixture shows that recompute
        // working for every camera on every probe frame, so whatever breaks here
        // is specific to this project.
        // ---- BEFORE state: what did the FILE give us? ----
        // The gap in the earlier run: it only ever measured AFTER the sweep, so it
        // could not see that the project arrives from disk with reprojections
        // already populated project-wide (`ui/overlays.js`: "SLP-loaded groups
        // populate `group.reprojections` without ever materializing
        // `reprojectedInstances`"). If that is true here, then Triangulate All's
        // up-front project-wide wipe DELETES data the user could already see, and
        // the windowed sweep never rebuilds it — which is the reported symptom
        // exactly, and makes the "reprojections are cheap to recompute on demand"
        // assumption the load-bearing one.
        const before = await page2.evaluate(() => {
            const s = window.__lucid.state.session;
            let groups = 0, withReproj = 0, reprojCamTotal = 0, withReprojInst = 0;
            for (const [, gs] of s.instanceGroups) {
                for (const g of gs) {
                    groups++;
                    const n = g.reprojections ? Object.keys(g.reprojections).length : 0;
                    if (n) { withReproj++; reprojCamTotal += n; }
                    if (g.reprojectedInstances && g.reprojectedInstances.size) withReprojInst++;
                }
            }
            return {
                groups, withReproj, withReprojInst,
                avgCams: withReproj ? +(reprojCamTotal / withReproj).toFixed(2) : 0,
                usedMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(0),
            };
        });
        log(`[${el()}] BEFORE Triangulate All: ${before.withReproj.toLocaleString()}/${before.groups.toLocaleString()} ` +
            `groups already carry reprojections (avg ${before.avgCams} cameras each), ` +
            `${before.withReprojInst.toLocaleString()} carry reprojectedInstances, heap=${before.usedMB} MB`);

        log(`\n[${el()}] === TRIANGULATE ALL (real project) ===`);
        const triStart = Date.now();
        await page2.evaluate(() => {
            window.__tri = { done: false, err: null };
            (async () => {
                try {
                    const tri = await import('/pose/triangulation.js');
                    await tri.triangulateAllFrames('dlt');
                    window.__tri.done = true;
                } catch (e) { window.__tri.err = String(e && e.stack || e).slice(0, 500); }
            })();
        });
        const TRI_TIMEOUT_MS = 45 * 60 * 1000;
        let triState = { done: false, err: null };
        while (Date.now() - triStart < TRI_TIMEOUT_MS) {
            await new Promise(r => setTimeout(r, 10000));
            triState = await page2.evaluate(() => ({
                done: window.__tri.done, err: window.__tri.err,
                usedMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(0),
            }));
            if (triState.done || triState.err) break;
            log(`  [${el()}] triangulating... heap=${triState.usedMB} MB`);
        }
        check(!triState.err, `Triangulate All completed${triState.err ? ' — ' + triState.err : ''}`);
        log(`[${el()}] Triangulate All finished in ${((Date.now() - triStart) / 1000).toFixed(1)}s`);

        const post = await page2.evaluate(() => {
            const s = window.__lucid.state.session;
            let groups = 0, with3d = 0, withReproj = 0;
            for (const [, gs] of s.instanceGroups) {
                for (const g of gs) {
                    groups++;
                    if (g.points3d && g.points3d.length) {
                        let any = false;
                        for (let i = 0; i < g.points3d.length; i++) {
                            if (Number.isFinite(g.points3d[i])) { any = true; break; }
                        }
                        if (any) with3d++;
                    }
                    if (g.reprojections && Object.keys(g.reprojections).length) withReproj++;
                }
            }
            return {
                groups, with3d, withReproj,
                resident: s.frameGroups.size,
                triResults: window.__lucid.state.triangulationResults.size,
                nFrames: s.lazyLoader ? s.lazyLoader.nFrames : 0,
                cams: s.cameras.map(c => c.name),
            };
        });
        log(`[${el()}] after sweep: ${post.groups.toLocaleString()} groups, ` +
            `${post.with3d.toLocaleString()} with finite 3D, ${post.withReproj.toLocaleString()} carrying reprojections, ` +
            `resident=${post.resident}, triResults=${post.triResults}`);
        check(post.with3d > post.groups * 0.95,
            `3D present on ~every group after the sweep (${post.with3d.toLocaleString()}/${post.groups.toLocaleString()})`);

        // ---- navigate like a user and read what the overlay/panel would draw ----
        log(`\n[${el()}] === navigating to probe frames ===`);
        const N = post.nFrames || 0;
        const probeFrames = [0, 1, 2, Math.floor(N * 0.25), Math.floor(N * 0.5),
                             Math.floor(N * 0.75), Math.max(0, N - 2)];
        const rows = [];
        for (const f of probeFrames) {
            const row = await page2.evaluate(async (frameIdx) => {
                const st = window.__lucid.state;
                const init = await import('/pose/initialization.js');
                await init.navigateToFrame(frameIdx);
                for (let i = 0; i < 200; i++) {
                    await new Promise(r => setTimeout(r, 50));
                    if (st.session.frameGroups.has(frameIdx)) break;
                }
                await new Promise(r => setTimeout(r, 300));
                const groups = st.session.instanceGroups.get(frameIdx) || [];
                const reprojCams = new Set();
                let withReproj = 0, with3d = 0, members = 0, membersWith2d = 0;
                for (const g of groups) {
                    if (g.points3d && g.points3d.length) {
                        for (let i = 0; i < g.points3d.length; i++) {
                            if (Number.isFinite(g.points3d[i])) { with3d++; break; }
                        }
                    }
                    const rp = g.reprojections ? Object.keys(g.reprojections) : [];
                    if (rp.length) { withReproj++; rp.forEach(c => reprojCams.add(c)); }
                    for (const [cn, inst] of g.instances) {
                        members++;
                        if (inst && inst.hasAnyUsablePoint && inst.hasAnyUsablePoint()) membersWith2d++;
                    }
                }
                return {
                    f: frameIdx, resident: st.session.frameGroups.has(frameIdx),
                    groups: groups.length, with3d, withReproj,
                    reprojCams: Array.from(reprojCams).sort(),
                    members, membersWith2d,
                    triRes: (st.triangulationResults.get(frameIdx) || []).length,
                };
            }, f);
            rows.push(row);
            log(`  frame ${String(row.f).padStart(7)}: groups=${row.groups} 3D=${row.with3d} ` +
                `reprojGroups=${row.withReproj} reprojCams=${row.reprojCams.length}/${post.cams.length} ` +
                `members=${row.members}(2D:${row.membersWith2d}) triRes=${row.triRes}` +
                (row.reprojCams.length && row.reprojCams.length < post.cams.length
                    ? `  <-- ONLY [${row.reprojCams.join(', ')}]` : ''));
        }

        const noReproj = rows.filter(r => r.groups > 0 && r.withReproj === 0);
        const partial = rows.filter(r => r.withReproj > 0 && r.reprojCams.length < post.cams.length);
        const no2d = rows.filter(r => r.members > 0 && r.membersWith2d === 0);
        log('');
        log(`SUMMARY over ${rows.length} probe frames:`);
        log(`  frames with NO reprojections at all : ${noReproj.length}  [${noReproj.map(r => r.f).join(', ')}]`);
        log(`  frames with only SOME cameras       : ${partial.length}  [${partial.map(r => r.f).join(', ')}]`);
        log(`  frames whose members have NO 2D     : ${no2d.length}  [${no2d.map(r => r.f).join(', ')}]`);
        check(noReproj.length === 0, 'every probe frame recomputed its reprojections after navigation');
        check(partial.length === 0, 'every probe frame recomputed reprojections for ALL cameras');

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
