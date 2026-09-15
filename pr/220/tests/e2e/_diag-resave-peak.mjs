/**
 * _diag-resave-peak.mjs — where does the save-after-reload peak come from?
 *
 * The crash (luc3d #191 follow-up): reload the real 1.4 GB project, edit one
 * keypoint, Save As -> the renderer dies inside save phase 2/4,
 * `openProjectWriter`. #191 made the `/session_data` writer's own temporaries
 * constant in project size, and it STILL dies there — so the peak is something
 * else, and the candidate is that after phase 1 there are TWO full copies of the
 * grouping live at once:
 *
 *   - LUCID's `session.instanceGroups` / `frameGroups` (measured 1,478 MB)
 *   - the SIO ref graph `buildSessionRefGraph` builds as its mirror
 *     (531,799 SIO InstanceGroups + 180,210 SIO FrameGroups)
 *
 * `buildSessionRefGraph`'s own docstring says the caller may drop the LUCID side
 * as soon as it returns. The single-session path (`buildSessionSlpBytesStreaming`)
 * does NOT — only the multi-session path does.
 *
 * This measures each step separately, so the fix is chosen on numbers:
 *   heap after reload -> after refGraph -> after freeing the LUCID grouping
 *   -> after openProjectWriter
 *
 * A 500 ms sampler streams every reading OUT to node as it is taken (via
 * exposeFunction, not console), so a renderer crash still leaves the full
 * trajectory rather than losing the buffered tail.
 *
 * Run: RELOAD_FILE=_real-roundtrip-1225929.slp node tests/e2e/_diag-resave-peak.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8196);
const RELOAD_FILE = process.env.RELOAD_FILE || '_real-roundtrip-1225929.slp';
const RELOAD_ABS = path.isAbsolute(RELOAD_FILE) ? RELOAD_FILE : path.join(repoRoot, RELOAD_FILE);
// Free the LUCID-side grouping between refGraph and openProjectWriter?
const EVICT = process.env.EVICT === '1';

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
    browser = await chromium.launch({
        headless: true,
        args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
    });
    const page = await browser.newPage();
    page.on('pageerror', e => log('[pageerror] ' + String(e).slice(0, 300)));
    page.on('crash', () => log('*** RENDERER CRASHED ***'));
    page.on('console', m => {
        const t = m.text();
        if (/phase:|writeSessions|OOM|Aborted/.test(t)) log('  [page] ' + t.slice(0, 200));
    });

    // Stream samples/marks out immediately — a crash must not lose them.
    await page.exposeFunction('__sample', (label, usedMB, wasmMB) => {
        log(`    ${String(usedMB).padStart(5)} MB js  ${String(wasmMB ?? '-').padStart(5)} MB wasm   ${label}`);
    });

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm, { timeout: 120000 });
    log('app booted');

    // ---- reload the real project through the real picker path ----
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__picker';
        inp.style.position = 'fixed'; inp.style.left = '-9999px';
        document.body.appendChild(inp);
    });
    await page.setInputFiles('#__picker', RELOAD_ABS);
    log('reloading ' + path.basename(RELOAD_ABS) + ' ...');

    await page.evaluate(() => {
        window.__r = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('/loading/session-loader.js');
                const f = document.getElementById('__picker').files[0];
                await sl.handleLoadProjectSlpLazy(f);
                window.__r.done = true;
            } catch (e) { window.__r.err = String(e && e.stack || e).slice(0, 400); }
        })();
    });
    // Dismiss the "load videos later" prompt if it appears.
    for (let i = 0; i < 600; i++) {
        const st = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const skip = btns.find(b => /Skip|Later/i.test(b.textContent || ''));
            if (skip) { skip.click(); return 'clicked'; }
            return window.__r.done ? 'done' : (window.__r.err ? 'err' : 'wait');
        });
        if (st === 'done' || st === 'err') break;
        await new Promise(r => setTimeout(r, 500));
    }
    const r = await page.evaluate(() => ({
        err: window.__r.err,
        groups: window.__lucid?.state?.session?.instanceGroups?.size ?? 0,
    }));
    if (r.err) throw new Error('reload failed: ' + r.err);
    log(`reload done — ${r.groups.toLocaleString()} groups`);

    // ---- the measurement ----
    const res = await page.evaluate(async (EVICT) => {
        const MB = 1048576;
        const gc = async () => {
            for (let i = 0; i < 6; i++) window.gc && window.gc();
            await new Promise(r => setTimeout(r, 250));
        };
        const jsMB = () => +(performance.memory.usedJSHeapSize / MB).toFixed(0);
        const wasmMB = () => {
            try {
                const m = window.h5wasm;
                if (m && m.HEAPU8) return +(m.HEAPU8.length / MB).toFixed(0);
            } catch (e) {}
            return null;
        };
        const mark = async (label) => {
            await gc();
            await window.__sample(label, jsMB(), wasmMB());
        };
        // Sampler: catches the trajectory INTO a crash, where marks never land.
        // Only reports a MOVE (>=64 MB since the last report) so the marks stay
        // legible instead of drowning in a flat idle trace.
        let lastReported = -1e9;
        const timer = setInterval(() => {
            try {
                const v = jsMB();
                if (Math.abs(v - lastReported) < 64) return;
                lastReported = v;
                window.__sample('  ...', v, wasmMB());
            } catch (e) {}
        }, 500);

        const out = { limitMB: +(performance.memory.jsHeapSizeLimit / MB).toFixed(0) };
        try {
            const sw = await import('/import-export/slp-streaming-write.js');
            const st = window.__lucid.state;
            const session = st.session;
            const views = st.views.filter(v => session.cameras.some(c => c.name === v.name));
            const videoFiles = st.videoFiles.filter(vf => session.cameras.some(c => c.name === vf.assignedCamera));

            await mark('baseline (post-reload)');

            const ctx = sw.createProjectWriterContext();
            const refGraph = await sw.buildSessionRefGraph(session, views, videoFiles, ctx);
            await mark('after buildSessionRefGraph  <-- SIO mirror now live too');

            // How big is the LUCID side that the ref graph has made redundant?
            out.groupsBefore = session.instanceGroups.size;
            if (EVICT) {
                session.frameGroups = new Map();
                session.instanceGroups = new Map();
                await mark('after freeing LUCID frameGroups/instanceGroups');
            }

            const writer = await sw.openProjectWriter(ctx, [refGraph.sioSession]);
            await mark('after openProjectWriter (phase 2/4 — the crash site)');
            out.survivedPhase2 = true;

            try { writer.dispose && writer.dispose(); } catch (e) {}
            await mark('after writer.dispose');
        } catch (e) {
            out.err = String(e && e.stack || e).slice(0, 500);
        } finally {
            clearInterval(timer);
        }
        return out;
    }, EVICT);

    log('');
    log(`limit ${res.limitMB} MB;  EVICT=${EVICT ? '1' : '0'};  groups=${(res.groupsBefore || 0).toLocaleString()}`);
    log(res.survivedPhase2
        ? '=> SURVIVED openProjectWriter'
        : '=> did NOT survive openProjectWriter' + (res.err ? ': ' + res.err : ' (renderer died)'));
} catch (err) {
    log('FATAL ' + String(err).slice(0, 500));
} finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    server.kill();
}
process.exit(0);
