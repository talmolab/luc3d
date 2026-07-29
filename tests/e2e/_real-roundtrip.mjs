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
    log(`\n[${el()}] === STAGE load ===`);
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
    check(loadRes.hasSession, 'session loaded');
    check(loadRes.nFrames >= 180000, `lazy loader sees all frames (${loadRes.nFrames})`);
    check((loadRes.cameras || []).length === CAMS.length, `${CAMS.length} cameras (${(loadRes.cameras || []).length})`);
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

    // ---------------- STAGE 5: reload the saved file ----------------
    if (upto >= 5 && bytesWritten > 0) {
        log(`\n[${el()}] === STAGE reload ===`);
        const servedName = path.basename(OUT_SLP);
        const page2 = await browser.newPage();
        page2.on('pageerror', e => log(`  [${el()}] [p2 pageerror] ` + String(e).slice(0, 300)));
        page2.on('crash', () => { log(`  [${el()}] *** p2 RENDERER CRASHED ***`); fails++; });
        page2.on('console', m => { const t = m.text(); if (/MEM:|phase:/.test(t)) log(`  [${el()}] ${t.slice(0, 220)}`); });
        await page2.goto(`http://localhost:${PORT}/index.html`);
        await page2.waitForFunction(() => window.__lucid && window.SleapIO, { timeout: 30000 });
        const r2 = await page2.evaluate(async (name) => {
            const sl = await import('/loading/session-loader.js');
            const resp = await fetch('/' + name);
            const buf = await resp.arrayBuffer();
            const f = new File([buf], name);
            const t = performance.now();
            let err = null;
            try { await sl.handleLoadProjectSlpLazy(f); }
            catch (e) { err = String(e && e.stack || e).slice(0, 400); }
            const s = window.__lucid.state.session;
            let groups = 0, with3d = 0;
            if (s && s.instanceGroups) {
                for (const [, gs] of s.instanceGroups) {
                    for (const g of gs) { groups++; if (g.points3d) with3d++; }
                }
            }
            return {
                ms: Math.round(performance.now() - t), err,
                groups, with3d,
                fim: s && s.frameIdentityMap ? s.frameIdentityMap.size : 0,
                usedMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(0),
            };
        }, servedName);
        log(`[${el()}] reload: ${r2.ms} ms ` + JSON.stringify(r2).slice(0, 260));
        check(!r2.err, `reload completed${r2.err ? ' — ' + r2.err : ''}`);
        check(r2.groups > 100000, `grouping round-tripped (${r2.groups.toLocaleString()} groups)`);
        check(r2.with3d > 100000, `3D round-tripped (${r2.with3d.toLocaleString()})`);
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
