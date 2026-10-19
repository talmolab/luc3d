/**
 * _real-bounded-derived-state.mjs — real-data memory measurement for the paths
 * that used to keep a frame's derived triangulation state (reprojections,
 * reprojected Instances, `state.triangulationResults`) for EVERY frame they
 * touched: File ▸ Load SLP, Export Video Overlays and moving a view between
 * sessions (#356; Triangulate All was #351). An investigation tool, not a suite
 * assertion (the `_real-` prefix excludes it from suite runs): it needs a real
 * multi-camera recording on disk.
 *
 * One browser per scenario, so each measurement starts from a fresh renderer:
 *
 *   SCENARIO=prepare  load the folder (per-camera .slp) → Track All →
 *                     Triangulate All (Refined) → File ▸ Save (download path,
 *                     the same bytes as Save As) to SLP=.
 *                     On the full 17-camera, 36,000-frame MultiCam_18 recording
 *                     that eager Save itself runs the renderer out of memory
 *                     (measured 2026-10-19, before #356 is even involved: the
 *                     heap goes 350 MB → 3.5 GB in 12 s even with the ungrouped
 *                     predictions dropped). PRUNE_UNLINKED=1 drops the
 *                     ungrouped predictions and PREP_FRAMES=N keeps frames
 *                     [0, N) so a project with 3D can still be written;
 *                     PREP_FRAMES=18000 is what fit (peak 2.9 GB).
 *   SCENARIO=reopen   File ▸ Load SLP (`handleLoadSlpFile`) of SLP= in a fresh
 *                     page — the measured action — then show SPOT= frames and
 *                     dump their reprojections + errors to SPOT_OUT= (compared
 *                     against SPOT_REF= when given).
 *   SCENARIO=export   load → Track All → Triangulate All, then Export Video
 *                     Overlays through the real modal, Reprojections + Errors
 *                     layers on, one 480 px tile, EXPORT_FRAMES frames from
 *                     EXPORT_START (1-based).
 *   SCENARIO=move     load → Track All → Triangulate All, show a few frames,
 *                     add an empty second session and move MOVE_VIEW into it
 *                     (`showMoveVideoModal` → Continue).
 *
 * For the measured action it records: wall time; the V8 heap before and after
 * (CDP `HeapProfiler.collectGarbage` then `Runtime.getHeapUsage`, i.e. what
 * stays); the PEAK heap during it, read from a Chrome trace (every GC event's
 * `usedHeapSizeBefore` and the timeline's `jsHeapSizeUsed` counters, recorded
 * inside the renderer, so a long synchronous loop that stalls a polling
 * sampler cannot hide its peak) plus a polled `Runtime.getHeapUsage` as a
 * cross-check (`polledMaxGapS` says how long the poll was stalled); the
 * renderer's peak RSS; whether the renderer crashed; and how many frames hold
 * derived state afterwards.
 *
 * Run (REPO = the checkout to SERVE, so one copy of this script measures any
 * build; PORT = a free port, other sessions' servers hold the defaults — the
 * script refuses to run if its server cannot bind, since the page would then
 * be served by whatever holds the port, i.e. some other build):
 *   PORT=8461 REPO=/path/to/build SCENARIO=prepare SLP=/tmp/x.slp node tests/e2e/_real-bounded-derived-state.mjs
 *   PORT=8461 REPO=/path/to/build SCENARIO=reopen  SLP=/tmp/x.slp SPOT_OUT=/tmp/spot.json node …
 *   … NANIMALS=1 METHOD=ba DATASET=/abs/session/folder OUT=/tmp/result.json LOG=/tmp/run.log
 */
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO || path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8461);
const SCENARIO = process.env.SCENARIO || 'reopen';
const DATASET = process.env.DATASET ||
    '/Users/soline/Documents/luc3d/LabMeetingPrep/Oline/MultiCam_18/2024-11-20_20-03-39Mouse_01';
const SLP = process.env.SLP;
const NANIMALS = process.env.NANIMALS || '1';
const METHOD = process.env.METHOD || 'ba';
const EXPORT_FRAMES = Number(process.env.EXPORT_FRAMES || 10000);
const EXPORT_START = Number(process.env.EXPORT_START || 1);
const MOVE_VIEW = process.env.MOVE_VIEW || null;          // default: the last camera
const SPOT = (process.env.SPOT || '0,1000,12345,24000,35999').split(',').map(Number);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 250);
const CHANNEL = process.env.CHANNEL ?? 'chrome';
const LOG = process.env.LOG;
const OUT = process.env.OUT;

const T0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const out = (m) => {
    const line = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`;
    console.log(line);
    if (LOG) fs.appendFileSync(LOG, line + '\n');
};
const MB = (b) => Math.round(b / 1048576);

if ((SCENARIO === 'prepare' || SCENARIO === 'reopen') && !SLP) {
    console.error('SCENARIO=' + SCENARIO + ' needs SLP=/abs/path/project.slp');
    process.exit(2);
}

// Peak heap from Chrome's own trace: every GC event carries the heap size it
// started from (`usedHeapSizeBefore`), and `UpdateCounters` samples
// `jsHeapSizeUsed`. Trace events are recorded inside the renderer as they
// happen, so a long synchronous loop that stalls a polling sampler cannot hide
// its peak, and the buffered chunks survive a renderer crash.
const TRACE_CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8'];
function traceHeapPeak(events) {
    let peak = 0, gcs = 0, counters = 0;
    for (const e of events) {
        const a = e.args || {};
        const d = a.data || {};
        if (a.usedHeapSizeBefore != null) { gcs++; peak = Math.max(peak, a.usedHeapSizeBefore, a.usedHeapSizeAfter || 0); }
        if (d.usedHeapSizeBefore != null) { gcs++; peak = Math.max(peak, d.usedHeapSizeBefore, d.usedHeapSizeAfter || 0); }
        if (d.jsHeapSizeUsed != null) { counters++; peak = Math.max(peak, d.jsHeapSizeUsed); }
    }
    return { peakMB: peak ? MB(peak) : null, gcEvents: gcs, counterEvents: counters };
}

let crashed = false;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
await sleep(1200);
// If the port is taken, http.server exits and the page would be served by
// whatever holds it — another build. Every number below would then describe
// the wrong code, so refuse.
if (server.exitCode !== null) {
    console.error(`port ${PORT} is in use (http.server exited ${server.exitCode}); pass PORT= a free port`);
    process.exit(2);
}
process.on('exit', () => { try { server.kill(); } catch (e) { /* gone */ } });
const browser = await chromium.launch({
    channel: CHANNEL || undefined,
    headless: true,
    args: ['--enable-precise-memory-info'],
});
const result = { scenario: SCENARIO, repo: REPO, commit: null, nAnimals: NANIMALS, method: METHOD };
try { result.commit = execSync('git rev-parse --short HEAD', { cwd: REPO, encoding: 'utf8' }).trim(); } catch (e) { /* not a checkout */ }
out(`scenario ${SCENARIO} on ${result.commit || REPO}`);

try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('crash', () => { crashed = true; out('*** RENDERER CRASHED ***'); });
    page.on('pageerror', e => out('[pageerror] ' + String(e).slice(0, 300)));
    page.on('console', m => {
        const t = m.text();
        if (process.env.CONSOLE_ALL === '1' || /out of memory|RangeError|Array buffer allocation|\[load-slp\] Recomputed|\[save-slp\]|\[buildSlpLabelsAllViews\]/i.test(t)) out('[console] ' + t.slice(0, 300));
    });
    page.on('dialog', d => { out('[dialog] ' + d.message().slice(0, 100)); d.accept(NANIMALS).catch(() => {}); });
    const cdp = await ctx.newCDPSession(page);
    const bcdp = await browser.newBrowserCDPSession();

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 60000 });
    // Answer the Track All setup dialog (animal count) and the load's
    // informational modals. `Escape` on the video prompt is sent from Node.
    await page.evaluate((n) => {
        window.__autoClick = true;
        setInterval(() => {
            if (!window.__autoClick) return;
            const ts = document.querySelector('.track-setup-modal');
            if (ts && !ts.dataset.autoAnswered) {
                ts.dataset.autoAnswered = '1';
                const inp = ts.querySelector('#trackSetupAnimals');
                if (inp) { inp.value = n; inp.dispatchEvent(new Event('input', { bubbles: true })); }
                const c = ts.querySelector('#trackSetupContinue'); if (c) c.click();
            }
            for (const b of document.querySelectorAll('button')) {
                const t = b.textContent.trim();
                if ((t === 'OK' || t === 'Close' || t === 'Dismiss') && b.offsetParent !== null) b.click();
            }
        }, 300);
    }, NANIMALS);

    // ---- measurement helpers ------------------------------------------------
    const rendererPids = async () => {
        try {
            const info = await bcdp.send('SystemInfo.getProcessInfo');
            return info.processInfo.filter(p => p.type === 'renderer').map(p => p.id);
        } catch (e) { return []; }
    };
    const rssMB = (pids) => {
        if (!pids.length) return -1;
        try {
            const o = execSync('ps -o pid=,rss= -p ' + pids.join(','), { encoding: 'utf8' });
            let best = 0;
            for (const l of o.trim().split('\n')) { const kb = parseInt(l.trim().split(/\s+/)[1], 10); if (kb > best) best = kb; }
            return Math.round(best / 1024);
        } catch (e) { return -1; }
    };
    const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);
    const heapNow = async (gc) => {
        if (gc) { await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage'); }
        const u = await cdp.send('Runtime.getHeapUsage');
        return { usedMB: MB(u.usedSize), totalMB: MB(u.totalSize) };
    };
    const derivedCounts = () => page.evaluate(() => {
        const st = window.__lucid.state;
        const r = { sessions: st.sessions.length, groups: 0, with3d: 0, framesWithReproj: 0, groupsWithReproj: 0,
            reprojInstances: 0, resultFrames: st.triangulationResults ? st.triangulationResults.size : 0, sessionResultFrames: 0 };
        for (const s of st.sessions) {
            if (s !== st.session && s.triangulationResults) r.sessionResultFrames += s.triangulationResults.size;
            for (const [, gs] of s.instanceGroups) {
                let any = false;
                for (const g of gs) {
                    r.groups++;
                    if (g.points3d && g.points3d.length) r.with3d++;
                    const has = (g.reprojections && Object.keys(g.reprojections).length) ||
                        (g.reprojectedInstances && g.reprojectedInstances.size);
                    if (has) { any = true; r.groupsWithReproj++; }
                    if (g.reprojectedInstances) r.reprojInstances += g.reprojectedInstances.size;
                }
                if (any) r.framesWithReproj++;
            }
        }
        return r;
    });

    // Run `fn` (a Node async function driving the page) as the measured action.
    async function measure(label, fn) {
        const pids = await rendererPids();
        const before = await heapNow(true);
        out(`${label}: heap before (after GC) ${before.usedMB} MB, rss ${rssMB(pids)} MB`);
        // Trace events with heap sizes, filtered as they arrive (the full
        // timeline trace of a minute-long action is large).
        const heapEvents = [];
        const onData = ({ value }) => {
            for (const e of value) {
                const a = e.args || {};
                if (a.usedHeapSizeBefore != null || (a.data && (a.data.usedHeapSizeBefore != null || a.data.jsHeapSizeUsed != null))) heapEvents.push(e);
            }
        };
        cdp.on('Tracing.dataCollected', onData);
        const traceDone = new Promise(r => cdp.once('Tracing.tracingComplete', r));
        await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: TRACE_CATEGORIES } }).catch(e => out('tracing start failed ' + e));
        let polledPeak = before.usedMB, rssPeak = rssMB(pids), maxGap = 0, last = Date.now(), running = true;
        const sampler = (async () => {
            while (running && !crashed) {
                const u = await withTimeout(cdp.send('Runtime.getHeapUsage').catch(() => null), 2000);
                const now = Date.now();
                if (u) { polledPeak = Math.max(polledPeak, MB(u.usedSize)); maxGap = Math.max(maxGap, now - last); last = now; }
                rssPeak = Math.max(rssPeak, rssMB(pids));
                await sleep(SAMPLE_MS);
            }
        })();
        const t = Date.now();
        let ret = null, err = null;
        try { ret = await fn(); } catch (e) { err = String((e && e.message) || e).slice(0, 400); }
        const wallS = +((Date.now() - t) / 1000).toFixed(1);
        running = false; await sampler;
        await withTimeout(cdp.send('Tracing.end').then(() => traceDone), 30000).catch(() => {});
        cdp.off('Tracing.dataCollected', onData);
        const tp = traceHeapPeak(heapEvents);
        const m = { label, wallS, crashed, err, heapBeforeMB: before.usedMB, tracePeakMB: tp.peakMB,
            traceGcEvents: tp.gcEvents, traceCounterEvents: tp.counterEvents, polledPeakMB: polledPeak, polledMaxGapS: +(maxGap / 1000).toFixed(1),
            rendererPeakRssMB: rssPeak, ret };
        if (!crashed) {
            const after = await heapNow(true).catch(() => null);
            m.heapAfterMB = after && after.usedMB;
            m.derived = await derivedCounts().catch(e => ({ err: String(e).slice(0, 100) }));
            m.rendererRssAfterMB = rssMB(pids);
        }
        out(`${label}: ${JSON.stringify(m)}`);
        return m;
    }

    // ---- shared steps -------------------------------------------------------
    async function loadFolder() {
        await page.evaluate(() => {
            const i = document.createElement('input');
            i.type = 'file'; i.multiple = true; i.webkitdirectory = true; i.id = '__d';
            i.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(i);
        });
        await page.setInputFiles('#__d', DATASET);
        const t = Date.now();
        await page.evaluate(async () => {
            const sl = await import('/loading/session-loader.js');
            const files = Array.from(document.getElementById('__d').files)
                .filter(f => !/(^|\/)\./.test(f.webkitRelativePath || f.name));
            await sl.handleLoadSessionFolderPerCamera(files, false);
        });
        await sleep(2000);
        const info = await page.evaluate(() => {
            const st = window.__lucid.state, s = st.session;
            return { cameras: s.cameras.length, calibrated: s.cameras.filter(c => c.projectionMatrix).length,
                totalFrames: st.totalFrames, views: st.views.length, nodes: s.skeleton.nodes.length };
        });
        out(`loaded folder in ${((Date.now() - t) / 1000).toFixed(1)} s: ${JSON.stringify(info)}`);
        result.dataset = info;
    }
    async function trackAndTriangulate() {
        const tr = await page.evaluate(async (N) => {
            const t = performance.now();
            const m = await import('/pose/tracker.js');
            if (m.setTrackerNumAnimals) m.setTrackerNumAnimals(N === 'auto' ? null : +N);
            await m.trackAll();
            const s = window.__lucid.state.session;
            return { ms: Math.round(performance.now() - t), identities: s.identities.length };
        }, NANIMALS);
        out('Track All: ' + JSON.stringify(tr));
        await sleep(1500);
        await page.keyboard.press('Escape').catch(() => {});
        const tri = await page.evaluate(async (METHOD) => {
            const t = performance.now();
            const m = await import('/pose/triangulation.js');
            await m.triangulateAllFrames(METHOD);
            return { ms: Math.round(performance.now() - t), status: document.getElementById('statusText').textContent.slice(0, 140) };
        }, METHOD);
        out('Triangulate All: ' + JSON.stringify(tri));
        await sleep(1000);
        result.afterTriangulateAll = { heap: await heapNow(true), derived: await derivedCounts() };
        out('after Triangulate All: ' + JSON.stringify(result.afterTriangulateAll));
    }

    // ---- scenarios ----------------------------------------------------------
    if (SCENARIO === 'prepare') {
        await loadFolder();
        await trackAndTriangulate();
        result.population2d = await page.evaluate(([prune, keep]) => {
            const s = window.__lucid.state.session;
            let members = 0, unlinked = 0;
            for (const [, gs] of s.instanceGroups) for (const g of gs) members += g.instances.size;
            for (const [, fg] of s.frameGroups) for (const [, ul] of fg.unlinkedInstances) unlinked += ul.length;
            // The eager Save builds a boxed SIO instance for every 2D instance in
            // the project; on the full 17-camera recording that alone runs the
            // renderer out of memory. PRUNE_UNLINKED=1 drops the ungrouped
            // predictions first, which keeps every group and its 3D — the part
            // a reopen derives reprojections from.
            if (prune) for (const [, fg] of s.frameGroups) fg.unlinkedInstances.clear();
            // PREP_FRAMES=N keeps only frames [0, N) — the same reason: the eager
            // Save also crashes on the full recording's grouped 2D alone.
            let dropped = 0;
            if (keep > 0) {
                for (const f of [...s.frameGroups.keys()]) if (f >= keep) { s.frameGroups.delete(f); dropped++; }
                for (const f of [...s.instanceGroups.keys()]) if (f >= keep) s.instanceGroups.delete(f);
            }
            let keptGroups = 0, keptMembers = 0;
            for (const [, gs] of s.instanceGroups) for (const g of gs) { keptGroups++; keptMembers += g.instances.size; }
            return { groupMembers: members, unlinked, pruned: !!prune, keepFrames: keep || null, droppedFrames: dropped, keptGroups, keptMembers };
        }, [process.env.PRUNE_UNLINKED === '1', Number(process.env.PREP_FRAMES || 0)]);
        out('2D population: ' + JSON.stringify(result.population2d));
        result.save = await measure('save', async () => {
            const dl = page.waitForEvent('download', { timeout: 1800000 });
            dl.catch(() => {});
            await page.evaluate(async () => {
                const sl = await import('/import-export/save-load.js');
                await sl.saveProjectSlp();
            });
            const d = await dl;
            await d.saveAs(SLP);
            return { file: SLP, bytes: fs.statSync(SLP).size, status: await page.evaluate(() => document.getElementById('statusText').textContent.slice(0, 140)) };
        });
    } else if (SCENARIO === 'reopen') {
        await page.evaluate(() => {
            const i = document.createElement('input');
            i.type = 'file'; i.id = '__slp'; i.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(i);
        });
        await page.setInputFiles('#__slp', SLP);
        result.reopen = await measure('reopen', async () => {
            await page.evaluate(async () => {
                const imp = await import('/import-export/slp-import.js');
                window.__loadDone = false;
                imp.handleLoadSlpFile(document.getElementById('__slp').files[0])
                    .then(() => { window.__loadDone = true; }, (e) => { window.__loadDone = 'ERR ' + e; });
            });
            for (;;) {
                if (crashed) return { loaded: 'crashed' };
                const st = await withTimeout(page.evaluate(() => ({
                    done: window.__loadDone, prompt: !!document.getElementById('videoSelectOverlay'),
                })), 5000);
                if (st && st.prompt) await page.keyboard.press('Escape');      // no videos: the load goes on
                if (st && st.done) return { loaded: st.done, status: await page.evaluate(() => document.getElementById('statusText').textContent.slice(0, 140)) };
                await sleep(250);
            }
        });
        if (!crashed && process.env.SPOT_OUT) {
            // Show each spot frame the way the app does and record what it shows.
            const spot = await page.evaluate(async (frames) => {
                const AS = await import('/ui/app-state.js');
                const RND = await import('/ui/rendering.js');
                const s = AS.state.session;
                const arr = (a) => a == null ? null : Array.from(a, p => p == null ? null : (Array.isArray(p) || ArrayBuffer.isView(p)) ? Array.from(p) : p);
                const res = {};
                for (const f of frames) {
                    AS.state.currentFrame = f;
                    const t = performance.now();
                    RND.drawAllOverlays(f);
                    const ms = performance.now() - t;
                    const list = AS.state.triangulationResults.get(f) || [];
                    res[f] = { drawMs: +ms.toFixed(1), groups: (s.instanceGroups.get(f) || []).map((g) => {
                        const r = list.find(x => x.group === g) || {};
                        const reproj = {};
                        for (const c of s.cameras) reproj[c.name] = arr(g.reprojections && g.reprojections[c.name]);
                        const errors = {}, errorsU = {};
                        for (const k of Object.keys(r.errors || {}).sort()) errors[k] = arr(r.errors[k]);
                        for (const k of Object.keys(r.errorsUndistorted || {}).sort()) errorsU[k] = arr(r.errorsUndistorted[k]);
                        return { identityId: g.identityId, reproj, errors, errorsU,
                            meanError: r.meanError ?? null, meanErrorUndistorted: r.meanErrorUndistorted ?? null,
                            reprojInstances: g.reprojectedInstances ? g.reprojectedInstances.size : 0 };
                    }) };
                }
                return res;
            }, SPOT);
            fs.writeFileSync(process.env.SPOT_OUT, JSON.stringify(spot));
            result.spot = { frames: SPOT, drawMs: Object.fromEntries(Object.entries(spot).map(([f, v]) => [f, v.drawMs])),
                derivedAfterSpot: await derivedCounts() };
            out('spot-check written: ' + JSON.stringify(result.spot));
            if (process.env.SPOT_REF && fs.existsSync(process.env.SPOT_REF)) {
                result.spotCompare = compareSpots(JSON.parse(fs.readFileSync(process.env.SPOT_REF, 'utf8')), spot);
                out('spot-check vs SPOT_REF: ' + JSON.stringify(result.spotCompare));
            }
        }
    } else if (SCENARIO === 'export') {
        await loadFolder();
        await trackAndTriangulate();
        await page.evaluate(() => {
            for (const id of ['visReprojections', 'visErrors']) {
                const el = document.getElementById(id);
                if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
            }
            try { localStorage.removeItem('overlayExportSettings.v1'); } catch (e) { /* ignore */ }
            window.__autoClick = false;     // the export modal has its own buttons
        });
        await page.evaluate(() => document.getElementById('menuExportOverlayVideo').click());
        await page.waitForSelector('#ovExportOverlay', { timeout: 30000 });
        await sleep(1500);
        const lastFrame = EXPORT_START + EXPORT_FRAMES - 1;
        const setup = await page.evaluate(async ({ start, end }) => {
            let guard = 0;
            while (document.querySelectorAll('#ovDock [data-view-name]').length > 1 && guard++ < 40) {
                const tabs = document.querySelectorAll('#ovDock .dv-default-tab-action');
                tabs[tabs.length - 1].click();
                await new Promise(r => setTimeout(r, 150));
            }
            const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
            set('ovRes', '480');
            set('ovMode', 'stitched');
            set('ovStartField', String(start));
            set('ovEndField', String(end));
            // The modal's layer switches (`data-ov`); both must be on, since
            // the fill runs only for the Reprojections / errors layers.
            const layer = (k) => {
                const el = document.querySelector(`#ovExportOverlay input[data-ov="${k}"]`);
                if (el && !el.checked) el.click();
                return el ? el.checked : null;
            };
            return { tiles: document.querySelectorAll('#ovDock [data-view-name]').length, reprojLayer: layer('reproj'), errorsLayer: layer('errors') };
        }, { start: EXPORT_START, end: lastFrame });
        out('export setup: ' + JSON.stringify(setup));
        result.exportSetup = setup;
        result.export = await measure('export', async () => {
            const dl = page.waitForEvent('download', { timeout: 3600000 });
            dl.catch(() => {});
            await page.evaluate(() => document.getElementById('ovExport').click());
            const d = await Promise.race([dl, (async () => { while (!crashed) await sleep(1000); return null; })()]);
            if (!d) return { download: null };
            await page.waitForFunction(() => !document.getElementById('ovExportOverlay'), { timeout: 120000 }).catch(() => {});
            return { download: d.suggestedFilename() };
        });
    } else if (SCENARIO === 'move') {
        await loadFolder();
        await trackAndTriangulate();
        result.moveSetup = await page.evaluate(async (MOVE_VIEW) => {
            const AS = await import('/ui/app-state.js');
            const RND = await import('/ui/rendering.js');
            for (const f of [100, 200, 0]) { AS.state.currentFrame = f; RND.drawAllOverlays(f); }
            const s = AS.state.session;
            return { view: MOVE_VIEW || s.cameras[s.cameras.length - 1].name };
        }, MOVE_VIEW);
        out('move setup: ' + JSON.stringify(result.moveSetup));
        result.move = await measure('move', async () => {
            return await page.evaluate(async (view) => {
                const AS = await import('/ui/app-state.js');
                const PD = await import('/pose/pose-data.js');
                const SP = await import('/ui/sessions-panes.js');
                const s = AS.state.session;
                const dest = new PD.Session(s.cameras.slice(), s.skeleton, [], 'Destination');
                if (!Array.isArray(dest.videoFileIndices)) dest.videoFileIndices = [];
                AS.state.sessions.push(dest);
                const fromIdx = AS.state.sessions.indexOf(s);
                const t = performance.now();
                const p = SP.showMoveVideoModal([view], fromIdx, AS.state.sessions.length - 1);
                const btn = [...document.querySelectorAll('button')].find(b => b.textContent === 'Continue' && b.offsetParent);
                if (btn) btn.click();
                await p;
                return { clicked: !!btn, ms: Math.round(performance.now() - t),
                    status: document.getElementById('statusText').textContent.slice(0, 140) };
            }, result.moveSetup.view);
        });
    } else {
        throw new Error('unknown SCENARIO ' + SCENARIO);
    }
} catch (e) {
    out('FATAL ' + String((e && e.stack) || e).slice(0, 600));
    result.fatal = String((e && e.message) || e).slice(0, 300);
} finally {
    result.crashed = crashed;
    await browser.close().catch(() => {});
    server.kill();
    out(crashed ? 'RESULT: CRASHED' : 'RESULT: completed');
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
}
// Exit explicitly: after an export the CDP sessions / download kept the event
// loop alive, so the run logged its result and then never exited.
process.exit(crashed || result.fatal ? 1 : 0);

// Largest absolute difference between two spot dumps, per quantity.
function compareSpots(a, b) {
    const r = { frames: 0, groups: 0, missing: [], maxReprojDiff: 0, maxErrDiff: 0, maxErrUDiff: 0, maxMeanDiff: 0, nullMismatch: 0 };
    const walk = (x, y, key) => {
        if (x == null || y == null) { if ((x == null) !== (y == null)) r.nullMismatch++; return; }
        if (Array.isArray(x)) { if (!Array.isArray(y) || x.length !== y.length) { r.nullMismatch++; return; } for (let i = 0; i < x.length; i++) walk(x[i], y[i], key); return; }
        r[key] = Math.max(r[key], Math.abs(x - y));
    };
    for (const f of Object.keys(a)) {
        if (!b[f]) { r.missing.push(f); continue; }
        r.frames++;
        const ga = a[f].groups, gb = b[f].groups;
        if (ga.length !== gb.length) { r.missing.push(f + ' groups ' + ga.length + '/' + gb.length); continue; }
        for (let i = 0; i < ga.length; i++) {
            r.groups++;
            for (const c of Object.keys(ga[i].reproj)) walk(ga[i].reproj[c], gb[i].reproj[c], 'maxReprojDiff');
            const ka = Object.keys(ga[i].errors).join(','), kb = Object.keys(gb[i].errors).join(',');
            if (ka !== kb) r.missing.push(`${f}/${i} error cameras ${ka} vs ${kb}`);
            for (const c of Object.keys(ga[i].errors)) walk(ga[i].errors[c], gb[i].errors[c], 'maxErrDiff');
            for (const c of Object.keys(ga[i].errorsU)) walk(ga[i].errorsU[c], gb[i].errorsU[c], 'maxErrUDiff');
            walk(ga[i].meanError, gb[i].meanError, 'maxMeanDiff');
            walk(ga[i].meanErrorUndistorted, gb[i].meanErrorUndistorted, 'maxMeanDiff');
        }
    }
    return r;
}
