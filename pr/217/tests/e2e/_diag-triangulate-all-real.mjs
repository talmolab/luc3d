/**
 * _diag-triangulate-all-real.mjs — run Triangulate All on the REAL reopened
 * project and report, in aggregate, what it did to the loaded 3D.
 *
 * The synthetic sibling (`_diag-triangulate-all-after-reopen.mjs`) could not
 * reproduce the user's report because an 8-frame project comes back with ALL
 * frames resident, so every group triangulates normally. The real precondition is
 * that almost nothing is resident: `_diag-post-reload-bytes.mjs` measured only
 * **31 of 180,210 frames** hydrated after a reopen (2D materializes on scrub).
 *
 * `triangulateAllFrames` never hydrates lazy 2D, and a reopened group's members
 * are NULL-FILLED PLACEHOLDER `Instance`s, so `hasAnyUsablePoint()` is false,
 * `viewsWithLabels < 2`, and the sweep `continue`s — leaving those groups without
 * `reprojections`/`triangulationResults` while `setReprojErrorVisible(true)`
 * switches the reprojection UI on globally.
 *
 * Aggregate-only output (531,799 groups is far too many to list per frame).
 *
 * Run: RELOAD_FILE=_real-roundtrip-1225929.slp node tests/e2e/_diag-triangulate-all-real.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8201);
const RELOAD_FILE = process.env.RELOAD_FILE || '_real-roundtrip-1225929.slp';
const RELOAD_ABS = path.isAbsolute(RELOAD_FILE) ? RELOAD_FILE : path.join(repoRoot, RELOAD_FILE);
if (!fs.existsSync(RELOAD_ABS)) { console.error('missing: ' + RELOAD_ABS); process.exit(1); }

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
    page.on('console', m => {
        const t = m.text();
        if (/triangulate-all|Triangulated|No frames to triangulate/.test(t)) log('  [page] ' + t.slice(0, 220));
    });

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm, { timeout: 120000 });

    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__p';
        inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
    });
    await page.setInputFiles('#__p', RELOAD_ABS);
    log('reopening ' + path.basename(RELOAD_ABS) + ' ...');
    await page.evaluate(() => {
        window.__r = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('/loading/session-loader.js');
                await sl.handleLoadProjectSlpLazy(document.getElementById('__p').files[0]);
                window.__r.done = true;
            } catch (e) { window.__r.err = String(e && e.stack || e).slice(0, 400); }
        })();
    });
    for (let i = 0; i < 900; i++) {
        const st = await page.evaluate(() => {
            const skip = [...document.querySelectorAll('button')].find(b => /Skip|Later/i.test(b.textContent || ''));
            if (skip) { skip.click(); return 'clicked'; }
            return window.__r.done ? 'done' : (window.__r.err ? 'err' : 'wait');
        });
        if (st === 'done' || st === 'err') break;
        await new Promise(r => setTimeout(r, 500));
    }
    log('reopen complete');

    const res = await page.evaluate(async () => {
        const tri = await import('/pose/triangulation.js');
        const st = window.__lucid.state;
        const s = st.session;
        const MB = 1048576;
        const agg = () => {
            let groups = 0, with3d = 0, nan3d = 0, withReproj = 0, usedSum = 0, realMembers = 0, members = 0;
            for (const [, gs] of s.instanceGroups) {
                for (const g of gs) {
                    groups++;
                    const p = g.points3d;
                    if (p && p.length) {
                        with3d++;
                        for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) { nan3d++; break; }
                    }
                    if (g.reprojections && Object.keys(g.reprojections).length) withReproj++;
                    usedSum += g.usedCameras ? g.usedCameras.size : 0;
                    if (g.instances) {
                        members += g.instances.size;
                        for (const [, inst] of g.instances) {
                            if (inst && inst.hasAnyUsablePoint && inst.hasAnyUsablePoint()) realMembers++;
                        }
                    }
                }
            }
            return { groups, with3d, nan3d, withReproj, usedSum, members, realMembers };
        };
        const out = { err: window.__r.err };
        out.residentBefore = s.frameGroups ? s.frameGroups.size : 0;
        out.triResBefore = st.triangulationResults ? st.triangulationResults.size : 0;
        out.before = agg();
        out.memBefore = +(performance.memory.usedJSHeapSize / MB).toFixed(0);

        const t = performance.now();
        await tri.triangulateAllFrames('dlt');
        out.ms = Math.round(performance.now() - t);

        out.residentAfter = s.frameGroups ? s.frameGroups.size : 0;
        out.triResAfter = st.triangulationResults ? st.triangulationResults.size : 0;
        out.after = agg();
        out.memAfter = +(performance.memory.usedJSHeapSize / MB).toFixed(0);
        out.status = (document.getElementById('statusText') || {}).textContent || '';
        return out;
    });

    // SAVE_AFTER=1: the acceptance case that actually matters — reopen ->
    // Triangulate All -> Save As. Triangulate All leaves the heap higher than the
    // reopen baseline that a save was verified against (luc3d #193), so "the sweep
    // itself did not crash" is NOT sufficient evidence the workflow is safe.
    let saveRes = null;
    if (process.env.SAVE_AFTER) {
        const OUT2 = path.join(repoRoot, '_real-roundtrip-tri-resave.slp');
        let bytes2 = 0, fd2 = null;
        await page.exposeFunction('__appendTri', (b64) => {
            if (fd2 === null) fd2 = fs.openSync(OUT2, 'w');
            const buf = Buffer.from(b64, 'base64');
            fs.writeSync(fd2, buf); bytes2 += buf.length;
        });
        log('');
        log('=== saving after Triangulate All ===');
        saveRes = await page.evaluate(async () => {
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
                        await window.__appendTri(toB64(u8));
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
        saveRes.bytes = bytes2;
        try { fs.unlinkSync(OUT2); } catch (e) {}
    }

    if (res.err) log('reopen error: ' + res.err);
    const b = res.before, a = res.after;
    log('');
    log(`Triangulate All took ${res.ms} ms`);
    log(`status: ${res.status}`);
    log('');
    log(`                          BEFORE        AFTER`);
    log(`  resident frameGroups  ${String(res.residentBefore).padStart(10)}   ${String(res.residentAfter).padStart(10)}`);
    log(`  triangulationResults  ${String(res.triResBefore).padStart(10)}   ${String(res.triResAfter).padStart(10)}`);
    log(`  groups                ${String(b.groups).padStart(10)}   ${String(a.groups).padStart(10)}`);
    log(`  groups WITH 3D        ${String(b.with3d).padStart(10)}   ${String(a.with3d).padStart(10)}`);
    log(`  groups with NaN 3D    ${String(b.nan3d).padStart(10)}   ${String(a.nan3d).padStart(10)}`);
    log(`  groups WITH reproj    ${String(b.withReproj).padStart(10)}   ${String(a.withReproj).padStart(10)}`);
    log(`  sum(usedCameras)      ${String(b.usedSum).padStart(10)}   ${String(a.usedSum).padStart(10)}`);
    log(`  members / real 2D     ${String(b.members + '/' + b.realMembers).padStart(10)}   ${String(a.members + '/' + a.realMembers).padStart(10)}`);
    log(`  usedJSHeapSize (MB)   ${String(res.memBefore).padStart(10)}   ${String(res.memAfter).padStart(10)}`);
    log('');
    const lost3d = b.with3d - a.with3d;
    log(lost3d > 0
        ? `=> LOST 3D on ${lost3d.toLocaleString()} groups`
        : `=> 3D retained on all ${a.with3d.toLocaleString()} groups (in MEMORY)`);
    log(`=> reprojections present on ${a.withReproj.toLocaleString()} / ${a.groups.toLocaleString()} groups ` +
        `(${(100 * a.withReproj / Math.max(1, a.groups)).toFixed(2)}%)`);
    if (saveRes) {
        log('');
        log(saveRes.err
            ? `=> SAVE AFTER TRIANGULATE ALL FAILED: ${saveRes.err}`
            : `=> SAVE AFTER TRIANGULATE ALL OK: ${saveRes.bytes.toLocaleString()} bytes in ${saveRes.ms} ms`);
    }
} catch (err) {
    log('FATAL ' + String(err).slice(0, 500));
} finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    server.kill();
}
process.exit(0);
