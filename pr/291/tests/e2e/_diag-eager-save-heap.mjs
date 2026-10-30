/**
 * _diag-eager-save-heap.mjs — where an EAGER project's Save spends the V8 heap.
 * An investigation tool, not a suite assertion (`_diag-` is excluded from suite
 * runs): it needs a real multi-camera recording on disk.
 *
 * Loads DATASET with Load Session Folder (per-camera), runs Track All and
 * Triangulate All, then measures the eager save in one of three ways:
 *
 *   PHASE=split  (default) build the Labels with `buildSlpLabelsAllViews`, keep
 *                them, GC, report what they RETAIN; then `saveSlpToBytes` on
 *                them. Each step gets its trace peak and a sampling heap
 *                profile (allocations by function, collected garbage
 *                included), so the cost is attributed rather than guessed.
 *   PHASE=save   the real File ▸ Save (`saveProjectSlp`, download path), the
 *                whole thing as one measured action, bytes saved to SLP=.
 *   PHASE=reopen open SLP= through File ▸ Open Project (`handleLoadProject`,
 *                which reopens a large .slp lazily) in a fresh page and report
 *                what came back — the round trip of a PHASE=save file.
 *
 * PREP_FRAMES=N keeps frames [0, N); PRUNE_UNLINKED=1 drops the ungrouped
 * predictions — both only to get a profile out of a build that cannot save the
 * whole recording.
 *
 *   PORT=8571 REPO=<checkout> PHASE=save SLP=/tmp/x.slp node tests/e2e/_diag-eager-save-heap.mjs
 */
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO || path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8571);
const PHASE = process.env.PHASE || 'split';
const DATASET = process.env.DATASET ||
    '/Users/soline/Documents/luc3d/LabMeetingPrep/Oline/MultiCam_18/2024-11-20_20-03-39Mouse_01';
const SLP = process.env.SLP;
const NANIMALS = process.env.NANIMALS || '1';
const METHOD = process.env.METHOD || 'ba';
const PREP_FRAMES = Number(process.env.PREP_FRAMES || 0);
const PRUNE = process.env.PRUNE_UNLINKED === '1';
const TOP = Number(process.env.TOP || 18);
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

const TRACE_CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8'];
function traceHeapPeak(events) {
    let peak = 0;
    for (const e of events) {
        const a = e.args || {}, d = a.data || {};
        if (a.usedHeapSizeBefore != null) peak = Math.max(peak, a.usedHeapSizeBefore, a.usedHeapSizeAfter || 0);
        if (d.usedHeapSizeBefore != null) peak = Math.max(peak, d.usedHeapSizeBefore, d.usedHeapSizeAfter || 0);
        if (d.jsHeapSizeUsed != null) peak = Math.max(peak, d.jsHeapSizeUsed);
    }
    return peak ? MB(peak) : null;
}

// Sampling-profile tree → total sampled bytes by allocating function.
function topAllocators(profile, n) {
    const by = new Map();
    let total = 0;
    (function walk(node) {
        const f = node.callFrame;
        const key = (f.functionName || '(anonymous)') + ' ' + (f.url || '').split('/').slice(-2).join('/') + ':' + (f.lineNumber + 1);
        if (node.selfSize) { by.set(key, (by.get(key) || 0) + node.selfSize); total += node.selfSize; }
        for (const c of node.children || []) walk(c);
    })(profile.head);
    const rows = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
        .map(([k, v]) => ({ fn: k, MB: MB(v), pct: +(100 * v / total).toFixed(1) }));
    return { totalMB: MB(total), rows };
}

let crashed = false;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
await sleep(1200);
if (server.exitCode !== null) {
    console.error(`port ${PORT} is in use (http.server exited ${server.exitCode}); pass PORT= a free port`);
    process.exit(2);
}
process.on('exit', () => { try { server.kill(); } catch (e) { /* gone */ } });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-precise-memory-info'] });
const result = { phase: PHASE, repo: REPO, prepFrames: PREP_FRAMES || null, pruned: PRUNE };
try { result.commit = execSync('git rev-parse --short HEAD', { cwd: REPO, encoding: 'utf8' }).trim(); } catch (e) { /* not a checkout */ }
out(`phase ${PHASE} on ${result.commit || REPO}`);

try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('crash', () => { crashed = true; out('*** RENDERER CRASHED ***'); });
    page.on('pageerror', e => out('[pageerror] ' + String(e).slice(0, 300)));
    page.on('console', m => {
        const t = m.text();
        if (/out of memory|RangeError|Array buffer allocation|\[save-slp\]/i.test(t)) out('[console] ' + t.slice(0, 300));
    });
    page.on('dialog', d => { out('[dialog] ' + d.message().slice(0, 100)); d.accept(NANIMALS).catch(() => {}); });
    const cdp = await ctx.newCDPSession(page);

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    await page.evaluate((n) => {
        setInterval(() => {
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

    const heapNow = async () => {
        await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage');
        return MB((await cdp.send('Runtime.getHeapUsage')).usedSize);
    };

    async function measure(label, fn, { profile = true } = {}) {
        const before = await heapNow();
        const heapEvents = [];
        const onData = ({ value }) => {
            for (const e of value) {
                const a = e.args || {};
                if (a.usedHeapSizeBefore != null || (a.data && (a.data.usedHeapSizeBefore != null || a.data.jsHeapSizeUsed != null))) heapEvents.push(e);
            }
        };
        cdp.on('Tracing.dataCollected', onData);
        const traceDone = new Promise(r => cdp.once('Tracing.tracingComplete', r));
        await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: TRACE_CATEGORIES } });
        if (profile) {
            await cdp.send('HeapProfiler.enable');
            await cdp.send('HeapProfiler.startSampling', { samplingInterval: 1 << 16,
                includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
        }
        const t = Date.now();
        let ret = null, err = null;
        try { ret = await fn(); } catch (e) { err = String((e && e.message) || e).slice(0, 400); }
        const wallS = +((Date.now() - t) / 1000).toFixed(1);
        let alloc = null;
        if (profile && !crashed) alloc = topAllocators((await cdp.send('HeapProfiler.stopSampling')).profile, TOP);
        await Promise.race([cdp.send('Tracing.end').then(() => traceDone), sleep(30000)]).catch(() => {});
        cdp.off('Tracing.dataCollected', onData);
        const m = { label, wallS, crashed, err, heapBeforeMB: before, tracePeakMB: traceHeapPeak(heapEvents), ret };
        if (!crashed) m.heapAfterMB = await heapNow().catch(() => null);
        out(`${label}: ${JSON.stringify(m)}`);
        if (alloc) {
            out(`${label}: sampled allocations ${alloc.totalMB} MB, top:`);
            for (const r of alloc.rows) out(`    ${String(r.MB).padStart(6)} MB ${String(r.pct).padStart(5)}%  ${r.fn}`);
            m.alloc = alloc;
        }
        return m;
    }

    if (PHASE === 'reopen') {
        await page.evaluate(() => {
            const i = document.createElement('input');
            i.type = 'file'; i.id = '__slp'; i.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(i);
        });
        await page.setInputFiles('#__slp', SLP);
        result.reopen = await measure('reopen', async () => {
            await page.evaluate(() => {
                window.__loadDone = false;
                import('/import-export/save-load.js').then(sl => sl.handleLoadProject(document.getElementById('__slp').files[0]))
                    .then(() => { window.__loadDone = true; }, (e) => { window.__loadDone = 'ERR ' + e; });
            });
            for (;;) {
                if (crashed) return null;
                const st = await page.evaluate(() => ({ done: window.__loadDone, prompt: !!document.getElementById('videoSelectOverlay') }));
                if (st.prompt) await page.keyboard.press('Escape');
                if (st.done) break;
                await sleep(250);
            }
            return page.evaluate(() => {
                const st = window.__lucid.state, s = st.session;
                let groups = 0, members = 0, with3d = 0;
                for (const [, gs] of s.instanceGroups) for (const g of gs) {
                    groups++; members += g.instances.size;
                    if (g.points3d && g.points3d.length) with3d++;
                }
                return { loaded: window.__loadDone, lazy: !!s.lazyLoader, nFrames: s.lazyLoader ? s.lazyLoader.nFrames : s.frameGroups.size,
                    cameras: s.cameras.length, groups, members, with3d, identities: s.identities.length,
                    status: document.getElementById('statusText').textContent.slice(0, 140) };
            });
        }, { profile: false });
    } else {

    // ---- load → Track All → Triangulate All ---------------------------------
    await page.evaluate(() => {
        const i = document.createElement('input');
        i.type = 'file'; i.multiple = true; i.webkitdirectory = true; i.id = '__d';
        i.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(i);
    });
    await page.setInputFiles('#__d', DATASET);
    await page.evaluate(async () => {
        const sl = await import('/loading/session-loader.js');
        const files = Array.from(document.getElementById('__d').files)
            .filter(f => !/(^|\/)\./.test(f.webkitRelativePath || f.name));
        await sl.handleLoadSessionFolderPerCamera(files, false);
    });
    await sleep(2000);
    out('loaded: ' + JSON.stringify(await page.evaluate(() => {
        const st = window.__lucid.state, s = st.session;
        return { cameras: s.cameras.length, frames: st.totalFrames, nodes: s.skeleton.nodes.length };
    })));
    out('Track All: ' + JSON.stringify(await page.evaluate(async (N) => {
        const t = performance.now();
        const m = await import('/pose/tracker.js');
        if (m.setTrackerNumAnimals) m.setTrackerNumAnimals(N === 'auto' ? null : +N);
        await m.trackAll();
        return { ms: Math.round(performance.now() - t) };
    }, NANIMALS)));
    await sleep(1500);
    await page.keyboard.press('Escape').catch(() => {});
    out('Triangulate All: ' + JSON.stringify(await page.evaluate(async (METHOD) => {
        const t = performance.now();
        const m = await import('/pose/triangulation.js');
        await m.triangulateAllFrames(METHOD);
        return { ms: Math.round(performance.now() - t) };
    }, METHOD)));
    await sleep(1000);

    result.population2d = await page.evaluate(([prune, keep]) => {
        const s = window.__lucid.state.session;
        if (prune) for (const [, fg] of s.frameGroups) fg.unlinkedInstances.clear();
        if (keep > 0) {
            for (const f of [...s.frameGroups.keys()]) if (f >= keep) s.frameGroups.delete(f);
            for (const f of [...s.instanceGroups.keys()]) if (f >= keep) s.instanceGroups.delete(f);
        }
        let groups = 0, members = 0, unlinked = 0;
        for (const [, gs] of s.instanceGroups) for (const g of gs) { groups++; members += g.instances.size; }
        for (const [, fg] of s.frameGroups) for (const [, ul] of fg.unlinkedInstances) unlinked += ul.length;
        return { frames: s.frameGroups.size, groups, members, unlinked };
    }, [PRUNE, PREP_FRAMES]);
    out('2D population: ' + JSON.stringify(result.population2d));

    if (PHASE === 'split') {
        result.build = await measure('build', () => page.evaluate(async () => {
            const fio = await import('/import-export/file-io.js');
            const st = window.__lucid.state, s = st.session;
            const views = st.views.filter(v => s.cameras.some(c => c.name === v.name));
            const vfs = st.videoFiles.filter(vf => s.cameras.some(c => c.name === vf.assignedCamera));
            const t = performance.now();
            window.__diagLabels = fio.buildSlpLabelsAllViews(s, views, vfs);
            return { ms: Math.round(performance.now() - t), labeledFrames: window.__diagLabels.labeledFrames.length };
        }));
        if (!crashed) {
            result.write = await measure('write', () => page.evaluate(async () => {
                const t = performance.now();
                const bytes = await window.SleapIO.saveSlpToBytes(window.__diagLabels);
                return { ms: Math.round(performance.now() - t), bytes: bytes.length };
            }));
        }
    } else if (PHASE === 'save') {
        result.save = await measure('save', async () => {
            const dl = page.waitForEvent('download', { timeout: 1800000 });
            dl.catch(() => {});
            await page.evaluate(async () => {
                const sl = await import('/import-export/save-load.js');
                await sl.saveProjectSlp();
            });
            const d = await dl;
            if (SLP) await d.saveAs(SLP);
            return { bytes: SLP ? fs.statSync(SLP).size : null,
                status: await page.evaluate(() => document.getElementById('statusText').textContent.slice(0, 140)) };
        }, { profile: process.env.PROFILE === '1' });
    } else {
        throw new Error('unknown PHASE ' + PHASE);
    }
    }
} catch (e) {
    out('ERROR ' + String((e && e.stack) || e).slice(0, 600));
    result.error = String(e).slice(0, 400);
} finally {
    result.crashed = crashed;
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    await browser.close().catch(() => {});
    server.kill();
    out(crashed ? 'RESULT: CRASHED' : 'RESULT: completed');
}
