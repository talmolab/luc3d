/**
 * _diag-instance-groups-memory.mjs — what does `session.instanceGroups` cost
 * after Track All (+ Triangulate All) on a real lazy project, and of what?
 *
 * Investigation tool, not a test. Loads a per-camera session folder the way
 * `_bench-playback.mjs` does (disk-backed Files through
 * `handleLoadSessionFolderPerCamera`), runs Track All and then the toolbar's
 * Triangulate All route, and after each step records — following two forced
 * full GCs — both `performance.memory.usedJSHeapSize` and CDP
 * `Runtime.getHeapUsage`, which splits the V8 heap (`usedSize`) from
 * ArrayBuffer backing stores (`backingStorageSize`).
 *
 * Then a CENSUS of every group and member (counts, buffer sizes, which fields
 * are set, how many distinct ArrayBuffers), and an ATTRIBUTION BY DELETION:
 * strip one component at a time, GC, measure what came back. The session is
 * destroyed by the end, so nothing after the attribution means anything.
 *
 * Headless real Chrome (no display needed, so no browser lock).
 *   DATASET=<dir> NANIMALS=5 node tests/e2e/_diag-instance-groups-memory.mjs
 *   SKIP_TRI=1   stop after Track All (no Triangulate All)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DATASET = process.env.DATASET ||
    '/Users/soline/Documents/luc3d/LabMeetingPrep/Oline/20260713_174659-194366_05mice_flippers';
const PORT = Number(process.env.PORT || 8241);
const NANIMALS = process.env.NANIMALS || '5';
const EXCLUDE = new RegExp(process.env.EXCLUDE || '(^|/)\\.|/troubleshooting/');
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MB = (b) => Math.round(b / 1048576);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await sleep(1200);
let browser;
try {
    browser = await chromium.launch({
        channel: 'chrome', headless: true,
        args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    page.on('pageerror', e => log('[pageerror] ' + String(e).slice(0, 300)));
    page.on('crash', () => log('*** RENDERER CRASHED ***'));
    page.on('dialog', d => d.accept(NANIMALS));

    const measure = async (label) => {
        await page.evaluate(() => { gc(); gc(); });
        await cdp.send('HeapProfiler.collectGarbage');
        await sleep(300);
        const u = await cdp.send('Runtime.getHeapUsage');
        const pm = await page.evaluate(() => performance.memory.usedJSHeapSize);
        const r = { label, usedJSHeapMB: MB(pm), v8HeapMB: MB(u.usedSize), v8TotalMB: MB(u.totalSize),
                    backingStoreMB: MB(u.backingStorageSize || 0), embedderMB: MB(u.embedderHeapUsedSize || 0) };
        log(`  MEM ${label.padEnd(44)} usedJSHeap ${String(r.usedJSHeapMB).padStart(5)} MB | V8 heap ${String(r.v8HeapMB).padStart(5)} MB | ArrayBuffer backing ${String(r.backingStoreMB).padStart(5)} MB`);
        return r;
    };

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 60000 });
    const boot = await measure('booted, nothing loaded');

    // ---- load (same path as _bench-playback.mjs) ----
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__diagDir';
        document.body.appendChild(inp);
        setInterval(() => {
            for (const b of document.querySelectorAll('button')) {
                const t = b.textContent.trim();
                if ((t === 'Continue' || t === 'OK') && b.offsetParent !== null) b.click();
            }
        }, 300);
    });
    await page.setInputFiles('#__diagDir', DATASET);
    await page.evaluate((EX) => {
        window.__diagLoad = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('/loading/session-loader.js');
                const ex = new RegExp(EX);
                const files = Array.from(document.getElementById('__diagDir').files).filter(f => !ex.test(f.webkitRelativePath || f.name));
                await sl.handleLoadSessionFolderPerCamera(files, false);
                window.__diagLoad.done = true;
            } catch (e) { window.__diagLoad.err = String(e && e.stack || e).slice(0, 500); }
        })();
    }, EXCLUDE.source);
    for (;;) {
        const s = await page.evaluate(() => window.__diagLoad);
        if (s.err) throw new Error('load failed: ' + s.err);
        if (s.done) break;
        await sleep(1000);
    }
    const info = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        return { cams: s.cameras.length, nodes: s.skeleton.nodes.length, frames: s.lazyLoader ? s.lazyLoader.nFrames : s.frameGroups.size,
                 lazy: !!s.lazyLoader, tracks: s.tracks.length, resident: s.frameGroups.size };
    });
    log('loaded: ' + JSON.stringify(info));
    const loaded = await measure('loaded (predictions only)');

    // ---- Track All ----
    const tr = await page.evaluate(async () => {
        const t = performance.now();
        try { const m = await import('/pose/tracker.js'); await m.trackAll(); }
        catch (e) { return { err: String(e && e.stack || e).slice(0, 400) }; }
        return { ms: Math.round(performance.now() - t) };
    });
    log('Track All: ' + JSON.stringify(tr));
    const tracked = await measure('after Track All');

    // ---- census helper (in page) ----
    await page.evaluate(() => {
        window.__census = () => {
            const s = window.__lucid.state.session;
            const c = { frames: 0, groups: 0, members: 0, membersLazy2d: 0, memberTypes: {},
                        xyBytes: 0, xyBuffers: 0, xyViewsOfBigger: 0, xyLenHist: {},
                        occArrays: 0, occBytes: 0, backups: 0, nulled: 0, modified: 0, identityOnInst: 0, rawIdx: 0,
                        p3d: 0, p3dBytes: 0, p3dBuffers: 0, usedCameras: 0, reproj: 0, reprojInst: 0,
                        groupKeys: null, memberKeys: null, distinctMemberObjects: 0, sharedWithResident: 0 };
            const bufs = new Set(), p3dBufs = new Set(), seen = new Set();
            const resident = new Set();
            for (const [, fg] of s.frameGroups) for (const [, l] of fg.instances) for (const i of l) resident.add(i);
            for (const [, gs] of s.instanceGroups) {
                c.frames++;
                for (const g of gs) {
                    c.groups++;
                    if (!c.groupKeys) c.groupKeys = Object.keys(g).map(k => k + ':' + (g[k] == null ? 'null' : g[k].constructor ? g[k].constructor.name : typeof g[k]));
                    const p = g.points3d;
                    if (p && p.length) { c.p3d++; c.p3dBytes += p.byteLength || p.length * 8; if (p.buffer) p3dBufs.add(p.buffer); }
                    if (g.usedCameras) c.usedCameras++;
                    if (g.reprojections) c.reproj++;
                    if (g.reprojectedInstances && g.reprojectedInstances.size) c.reprojInst++;
                    for (const [, m] of g.instances) {
                        c.members++;
                        if (seen.has(m)) continue;
                        seen.add(m);
                        if (!c.memberKeys) c.memberKeys = Object.keys(m).map(k => k + ':' + (m[k] == null ? 'null' : m[k].constructor ? m[k].constructor.name : typeof m[k]));
                        if (resident.has(m)) c.sharedWithResident++;
                        if (m._lazy2d) c.membersLazy2d++;
                        c.memberTypes[m.type] = (c.memberTypes[m.type] || 0) + 1;
                        const xy = m._xy;
                        c.xyBytes += xy.byteLength;
                        c.xyLenHist[xy.length] = (c.xyLenHist[xy.length] || 0) + 1;
                        if (xy.buffer.byteLength !== xy.byteLength) c.xyViewsOfBigger++;
                        bufs.add(xy.buffer);
                        if (typeof m._occ !== 'number') { c.occArrays++; c.occBytes += m._occ.byteLength; }
                        if (m._originalXY) c.backups++;
                        if (m.nulledNodes && m.nulledNodes.size) c.nulled++;
                        if (m.modified) c.modified++;
                        if (m.identityId != null) c.identityOnInst++;
                        if (m._rawInstIndex != null) c.rawIdx++;
                    }
                }
            }
            c.distinctMemberObjects = seen.size;
            c.xyBuffers = bufs.size; c.p3dBuffers = p3dBufs.size;
            c.xyMB = Math.round(c.xyBytes / 1048576); c.p3dMB = Math.round(c.p3dBytes / 1048576);
            c.fim = s.frameIdentityMap ? s.frameIdentityMap.size : null;
            c.triResults = window.__lucid.state.triangulationResults ? window.__lucid.state.triangulationResults.size : null;
            c.resident = s.frameGroups.size;
            // Any other big per-session containers?
            c.sessionContainers = Object.keys(s).map(k => {
                const v = s[k];
                if (v instanceof Map || v instanceof Set) return k + ':' + v.constructor.name + '(' + v.size + ')';
                if (Array.isArray(v) && v.length > 1000) return k + ':Array(' + v.length + ')';
                return null;
            }).filter(Boolean);
            return c;
        };
    });
    log('census after Track All: ' + JSON.stringify(await page.evaluate(() => window.__census())));

    let tri = tracked;
    if (process.env.SKIP_TRI !== '1') {
        const t2 = await page.evaluate(async () => {
            const t = performance.now();
            try { const em = await import('/ui/export-modals.js'); await em.groupByIdentityAndTriangulateAll('dlt'); }
            catch (e) { return { err: String(e && e.stack || e).slice(0, 400) }; }
            return { ms: Math.round(performance.now() - t) };
        });
        log('Triangulate All (groupByIdentityAndTriangulateAll dlt): ' + JSON.stringify(t2));
        tri = await measure('after Triangulate All');
        log('census after Triangulate All: ' + JSON.stringify(await page.evaluate(() => window.__census())));
    }

    // ---- attribution by deletion ----
    log('\nattribution by deletion (each step strips one more component):');
    const steps = [
        ['members: _xy -> one shared NaN buffer', () => {
            const s = window.__lucid.state.session; const shared = new Map();
            for (const [, gs] of s.instanceGroups) for (const g of gs) for (const [, m] of g.instances) {
                const n = m._xy.length;
                if (!shared.has(n)) shared.set(n, new Float64Array(n).fill(NaN));
                m._xy = shared.get(n);
            }
        }],
        ['members: _occ arrays -> 0', () => {
            const s = window.__lucid.state.session;
            for (const [, gs] of s.instanceGroups) for (const g of gs) for (const [, m] of g.instances) m._occ = 0;
        }],
        ['groups: points3d -> null', () => {
            const s = window.__lucid.state.session;
            for (const [, gs] of s.instanceGroups) for (const g of gs) g.points3d = null;
        }],
        ['groups: usedCameras/reprojections -> null', () => {
            const s = window.__lucid.state.session;
            for (const [, gs] of s.instanceGroups) for (const g of gs) { g.usedCameras = null; g.reprojections = null; if (g.reprojectedInstances) g.reprojectedInstances.clear(); }
            window.__lucid.state.triangulationResults.clear();
        }],
        ['frameIdentityMap.clear()', () => { window.__lucid.state.session.frameIdentityMap.clear(); }],
        ['instanceGroups.clear() (group + member objects)', () => { window.__lucid.state.session.instanceGroups.clear(); }],
        ['frameGroups.clear()', () => { window.__lucid.state.session.frameGroups.clear(); }],
    ];
    let prev = tri;
    const attrib = [];
    for (const [label, fn] of steps) {
        await page.evaluate(`(${fn.toString()})()`);
        const m = await measure(label);
        const d = { label, freedV8MB: prev.v8HeapMB - m.v8HeapMB, freedBackingMB: prev.backingStoreMB - m.backingStoreMB,
                    freedUsedJSHeapMB: prev.usedJSHeapMB - m.usedJSHeapMB };
        attrib.push(d);
        log(`    -> freed V8 heap ${d.freedV8MB} MB, ArrayBuffer backing ${d.freedBackingMB} MB (usedJSHeap ${d.freedUsedJSHeapMB} MB)`);
        prev = m;
    }
    console.log('\nSUMMARY ' + JSON.stringify({ info, boot, loaded, tracked, tri, attrib }));
} catch (e) {
    log('FATAL ' + String(e && e.stack || e).slice(0, 800));
} finally {
    if (browser) await browser.close();
    server.kill();
}
