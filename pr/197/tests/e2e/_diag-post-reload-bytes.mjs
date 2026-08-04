/**
 * _diag-post-reload-bytes.mjs — STRUCTURAL accounting of the post-reload heap.
 *
 * WHY NOT HEAP DELTAS. Commit 7cf3dc0 established that `usedJSHeapSize` tracks
 * allocation faithfully on the way UP but does NOT fall back to a true baseline —
 * V8 keeps committed pages. So "free X, see how much the heap drops" is not a
 * reliable way to size X, and the earlier attribution run's "- lazyLoader (freed
 * 18 MB)" cannot be trusted to mean the loader only held 18 MB.
 *
 * This measures the other way: WALK the post-reload structures and add up what
 * they actually own — every typed array's `byteLength`, plus object/entry counts
 * multiplied by a stated per-object estimate. Those numbers do not depend on GC
 * behaviour at all.
 *
 * THE QUESTION. A reload of the real project leaves 4,100 MB resident. The SAME
 * logical state built by Track All + Triangulate All leaves 2,891 MB — and a save
 * from that state SUCCEEDS, while a save after reload dies with the heap climbing
 * past ~4,700 MB. So reload leaves ~1,200 MB more than the freshly-computed
 * equivalent. This is meant to find where that surplus lives; the prime suspect
 * is the reopened project's ONE shared columnar store (`_sharedStore`), which
 * holds every camera's frames/instances/points for 180,210 x 5 frames, versus the
 * per-camera prediction stores of a fresh load.
 *
 * Run: RELOAD_FILE=_real-roundtrip-1225929.slp node tests/e2e/_diag-post-reload-bytes.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8197);
const RELOAD_FILE = process.env.RELOAD_FILE || '_real-roundtrip-1225929.slp';
const RELOAD_ABS = path.isAbsolute(RELOAD_FILE) ? RELOAD_FILE : path.join(repoRoot, RELOAD_FILE);

if (!fs.existsSync(RELOAD_ABS)) {
    console.error('missing input .slp: ' + RELOAD_ABS);
    process.exit(1);
}

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const log = (m) => console.log(`[${el()}] ${m}`);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] });
    const page = await browser.newPage();
    page.on('pageerror', e => log('[pageerror] ' + String(e).slice(0, 300)));
    page.on('crash', () => log('*** RENDERER CRASHED ***'));

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm, { timeout: 120000 });
    log('app booted');

    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__picker';
        inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
    });
    await page.setInputFiles('#__picker', RELOAD_ABS);
    log('reloading ' + path.basename(RELOAD_ABS) + ' ...');

    await page.evaluate(() => {
        window.__r = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('/loading/session-loader.js');
                await sl.handleLoadProjectSlpLazy(document.getElementById('__picker').files[0]);
                window.__r.done = true;
            } catch (e) { window.__r.err = String(e && e.stack || e).slice(0, 400); }
        })();
    });
    for (let i = 0; i < 600; i++) {
        const st = await page.evaluate(() => {
            const skip = [...document.querySelectorAll('button')].find(b => /Skip|Later/i.test(b.textContent || ''));
            if (skip) { skip.click(); return 'clicked'; }
            return window.__r.done ? 'done' : (window.__r.err ? 'err' : 'wait');
        });
        if (st === 'done' || st === 'err') break;
        await new Promise(r => setTimeout(r, 500));
    }

    const res = await page.evaluate(() => {
        const MB = 1048576;
        const st = window.__lucid.state;
        const s = st.session;
        const out = { err: window.__r.err, usedMB: +(performance.memory.usedJSHeapSize / MB).toFixed(0), buckets: [] };
        if (!s) { out.err = out.err || 'no session'; return out; }

        // Sum every distinct typed array reachable from a value, deduped by
        // BUFFER identity so shared views (subarrays) are not counted twice.
        const seenBuf = new WeakSet();
        const addTyped = (v, acc) => {
            if (!v) return;
            if (ArrayBuffer.isView(v) && v.buffer) {
                if (seenBuf.has(v.buffer)) return;
                seenBuf.add(v.buffer);
                acc.bytes += v.buffer.byteLength;
                acc.count++;
            }
        };
        const bucket = (name, bytes, count, note) => out.buckets.push({
            name, mb: +(bytes / MB).toFixed(1), count, note: note || '',
        });

        // ---- 1. the lazy loader's columnar store(s) ----
        const loader = s.lazyLoader;
        if (loader) {
            out.sharedStore = !!loader._sharedStore;
            out.nCams = loader.labelsByCam ? loader.labelsByCam.size : 0;
            const acc = { bytes: 0, count: 0 };
            const storesSeen = new Set();
            let arrColumns = 0, arrColumnEntries = 0;
            if (loader.labelsByCam) {
                for (const [, labels] of loader.labelsByCam) {
                    const store = labels && labels._lazyDataStore;
                    if (!store || storesSeen.has(store)) continue;
                    storesSeen.add(store);
                    for (const key of ['framesData', 'instancesData', 'pointsData', 'predPointsData']) {
                        const tbl = store[key];
                        if (!tbl) continue;
                        for (const col of Object.keys(tbl)) {
                            const v = tbl[col];
                            addTyped(v, acc);
                            // A plain JS Array column is the expensive shape —
                            // flag it rather than guessing its cost.
                            if (Array.isArray(v)) { arrColumns++; arrColumnEntries += v.length; }
                        }
                    }
                }
            }
            out.nStores = storesSeen.size;
            bucket('lazy store typed columns', acc.bytes, acc.count,
                `${storesSeen.size} store(s)` + (arrColumns ? `; ${arrColumns} PLAIN-ARRAY columns totalling ${arrColumnEntries.toLocaleString()} entries` : '; no plain-array columns'));
            out.arrColumns = arrColumns;
            out.arrColumnEntries = arrColumnEntries;
        }

        // ---- 2. instanceGroups: 3D points + scores + object counts ----
        {
            const acc = { bytes: 0, count: 0 };
            let nGroups = 0, nMembers = 0, nWith3d = 0;
            for (const [, groups] of s.instanceGroups) {
                for (const g of groups) {
                    nGroups++;
                    addTyped(g.points3d, acc);
                    if (g.points3d && g.points3d.length) nWith3d++;
                    if (g.instances) nMembers += g.instances.size || 0;
                }
            }
            out.nGroups = nGroups; out.nMembers = nMembers; out.nWith3d = nWith3d;
            bucket('instanceGroups 3D typed arrays', acc.bytes, acc.count,
                `${nGroups.toLocaleString()} groups, ${nWith3d.toLocaleString()} with 3D`);
            // Object overhead estimate, stated explicitly so it is auditable:
            // per group ~ InstanceGroup object (~80 B) + its instances Map
            // (~150 B + ~50 B/entry) + array slot.
            const est = nGroups * 230 + nMembers * 50;
            bucket('instanceGroups object overhead (ESTIMATE)', est, nGroups,
                `${nGroups.toLocaleString()} x ~230 B + ${nMembers.toLocaleString()} members x ~50 B`);
        }

        // ---- 3. resident 2D instances in frameGroups ----
        {
            const acc = { bytes: 0, count: 0 };
            let nFrames = 0, nInst = 0;
            for (const [, fg] of s.frameGroups) {
                nFrames++;
                if (!fg.instances) continue;
                for (const [, list] of fg.instances) {
                    for (const inst of list) {
                        if (!inst) continue;
                        nInst++;
                        // Instance stores 2D flat (luc3d #185 follow-up #1):
                        // `_xy` is Float64Array(2n); `_occ` is a bare number for
                        // <=32 nodes and a Uint32Array above that; `_originalXY`/
                        // `_originalOcc` exist only on edited instances.
                        addTyped(inst._xy, acc);
                        addTyped(inst._occ, acc);
                        addTyped(inst._originalXY, acc);
                        addTyped(inst._originalOcc, acc);
                    }
                }
            }
            out.nResidentFrames = nFrames; out.nResidentInstances = nInst;
            bucket('resident 2D instance typed arrays', acc.bytes, acc.count,
                `${nFrames.toLocaleString()} frames, ${nInst.toLocaleString()} instances`);
        }

        // ---- 4. frameIdentityMap ----
        {
            const n = s.frameIdentityMap ? s.frameIdentityMap.size : 0;
            out.fim = n;
            // Packed numeric key -> number value in a Map: ~50 B/entry.
            bucket('frameIdentityMap (ESTIMATE)', n * 50, n, `${n.toLocaleString()} entries x ~50 B`);
        }

        // ---- 5. triangulationResults ----
        {
            const acc = { bytes: 0, count: 0 };
            let n = 0;
            if (st.triangulationResults) {
                for (const [, v] of st.triangulationResults) { n++; addTyped(v && v.points3d, acc); }
            }
            bucket('triangulationResults typed arrays', acc.bytes, acc.count, `${n.toLocaleString()} entries`);
        }

        out.totalMB = +out.buckets.reduce((a, b) => a + b.mb, 0).toFixed(1);
        return out;
    });

    log('');
    if (res.err) log('reload error: ' + res.err);
    log(`usedJSHeapSize after reload: ${res.usedMB} MB`);
    log(`sharedStore=${res.sharedStore}  cams=${res.nCams}  distinct stores=${res.nStores}`);
    log('');
    for (const b of res.buckets) {
        log(`  ${String(b.mb).padStart(8)} MB  ${b.name.padEnd(42)} ${b.note}`);
    }
    log('');
    log(`  ${String(res.totalMB).padStart(8)} MB  ACCOUNTED FOR (of ${res.usedMB} MB used)`);
    log(`  ${String(+(res.usedMB - res.totalMB).toFixed(1)).padStart(8)} MB  unaccounted (garbage V8 has not returned, + JS object graph)`);
    if (res.arrColumns) {
        log('');
        log(`  !! ${res.arrColumns} store columns are PLAIN JS ARRAYS (${res.arrColumnEntries.toLocaleString()} entries) —`);
        log('     boxed numbers in the pointer-compressed cage, the shape #185/#189/#190 exist to remove.');
    }
} catch (err) {
    log('FATAL ' + String(err).slice(0, 500));
} finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    server.kill();
}
process.exit(0);
