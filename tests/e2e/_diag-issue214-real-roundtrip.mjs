/**
 * _diag-issue214-real-roundtrip.mjs — issue #214 on a REAL session folder.
 *
 * "Exporting SLP files works fine, but when these files are placed back into
 * the session (replacing the old .slp files) and one does a fresh load, only
 * some of the views load."
 *
 * Drives the shipping app end to end against a real per-camera session folder:
 *   1. Load Session Folder (per camera) — videos + one .slp per camera dir
 *   2. annotate (user instances on a few frames, some cameras only)
 *   3. File ▸ Export SLEAP File By Cam  (Download All, real modal)
 *      File ▸ Export SLEAP File Per Session (real modal)
 *      — showDirectoryPicker is stubbed so the bytes land in OUT
 *   4. put the exported files back into the camera dirs, in several ways
 *   5. fresh page, load the folder again, count every camera
 *
 * Not a test. Usage:
 *   DATA=_bugdata/arm node tests/e2e/_diag-issue214-real-roundtrip.mjs [phase]
 *     phase: export | reload | all (default all)
 * DATA is a session folder under the repo root:
 *   <DATA>/calibration.toml, <DATA>/<cam>/<video>, <DATA>/<cam>/<pred>.slp
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PHASE = process.argv[2] || 'all';
const PORT = Number(process.env.PORT || 8314);
const DATA = process.env.DATA || '_bugdata/arm';
const OUT = process.env.OUT || '_bugdata/out214';
const DEFER_VIDEOS = process.env.DEFER_VIDEOS === '1';
const ANNOTATE = JSON.parse(process.env.ANNOTATE || '{"10":"*","2000":"*","50000":["CamA"],"100000":["CamA"]}');

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const log = (m) => process.stdout.write(`[${el()}] ${m}\n`);

// ---- folder listing (node side) ------------------------------------------
function listFolder(dirRel) {
    const abs = path.join(repoRoot, dirRel);
    const root = path.basename(dirRel);
    const out = [];
    const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith('.')) continue;
            const p = path.join(d, e.name);
            const st = fs.statSync(p);            // follows symlinks
            const r = rel ? rel + '/' + e.name : e.name;
            if (st.isDirectory()) walk(p, r);
            else out.push({ url: '/' + dirRel + '/' + r, rel: root + '/' + r, size: st.size, mtime: Math.floor(st.mtimeMs) });
        }
    };
    walk(abs, '');
    return out;
}

// ---- page helpers ----------------------------------------------------------
async function boot(browser, label) {
    const page = await browser.newPage();
    const logs = [];
    page.on('pageerror', e => logs.push('[pageerror] ' + String(e).slice(0, 300)));
    page.on('crash', () => logs.push('*** RENDERER CRASHED ***'));
    page.on('console', m => {
        const t = m.text();
        if (m.type() === 'error' || m.type() === 'warning' || /\[session-folder\]|\[slp-export|\[export|HDF5/.test(t)) {
            if (/All files in folder|^\s{2}\S|Matching cam/.test(t)) return;   // noisy listing
            logs.push(`[${m.type()}] ` + t.slice(0, 400));
        }
    });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 60000 });
    // Click through any blocking "Continue" popup (missing-files etc.).
    await page.evaluate(() => {
        window.__autoContinue = setInterval(() => {
            for (const b of document.querySelectorAll('button')) {
                if (/^(Continue|OK|Skip)$/.test(b.textContent.trim()) && b.offsetParent !== null) b.click();
            }
        }, 300);
    });
    log(`${label}: app booted`);
    return { page, logs };
}

async function loadFolder(page, entries, deferVideos) {
    return page.evaluate(async ({ entries, deferVideos }) => {
        const sl = await import('/loading/session-loader.js');
        const files = [];
        for (const e of entries) {
            const r = await fetch(e.url);
            if (!r.ok) throw new Error('fetch ' + e.url + ' ' + r.status);
            const f = new File([await r.blob()], e.rel.split('/').pop(), { lastModified: e.mtime });
            Object.defineProperty(f, 'webkitRelativePath', { value: e.rel });
            files.push(f);
        }
        const t = performance.now();
        await sl.handleLoadSessionFolderPerCamera(files, deferVideos);
        return { ms: Math.round(performance.now() - t) };
    }, { entries, deferVideos });
}

// Per-camera census: resident frame groups + (for a lazy session) the store.
async function census(page) {
    return page.evaluate(async () => {
        const st = window.__lucid.state;
        const s = st.session;
        const statusEl = document.getElementById('statusText') || document.querySelector('.status-text, #status');
        const out = {
            views: (st.views || []).map(v => v.name),
            videoFiles: (st.videoFiles || []).map(v => ({ name: v.name, cam: v.assignedCamera, slp: v.slpFilename, frames: v.frameCount })),
            status: statusEl ? statusEl.textContent : null,
            skeleton: s ? s.skeleton.nodes.map(n => (typeof n === 'string' ? n : n.name)) : null,
            tracks: s ? s.tracks.slice(0, 10) : null,
            lazy: !!(s && s.lazyLoader),
            totalFrames: st.totalFrames,
            resident: {},
            store: null,
        };
        if (!s) return out;
        for (const c of s.cameras) out.resident[c.name] = { frames: 0, user: 0, predicted: 0 };
        for (const [, fg] of s.frameGroups) {
            const seen = new Set();
            const bump = (cn, inst) => {
                if (!out.resident[cn]) out.resident[cn] = { frames: 0, user: 0, predicted: 0 };
                out.resident[cn][inst.type === 'user' ? 'user' : 'predicted']++;
                if (!seen.has(cn)) { seen.add(cn); out.resident[cn].frames++; }
            };
            for (const [cn, xs] of fg.instances) for (const x of xs) bump(cn, x);
            for (const [cn, xs] of fg.unlinkedInstances) for (const u of xs) bump(cn, u.instance);
        }
        if (s.lazyLoader && typeof s.lazyLoader.forEachInstanceRow === 'function') {
            out.store = {};
            s.lazyLoader.forEachInstanceRow(function (cn, f, trk, info) {
                const o = out.store[cn] || (out.store[cn] = { rows: 0, user: 0, predicted: 0 });
                o.rows++; o[info && info.type === 'user' ? 'user' : 'predicted']++;
            });
        } else if (s.lazyLoader) {
            out.store = { loader: s.lazyLoader.constructor.name, cams: Array.from((s.lazyLoader.workers || new Map()).keys()) };
        }
        return out;
    });
}

// What each camera shows ON SCREEN at a few frames: hydrate (lazy) exactly as a
// seek does, then count that frame's instances per camera.
async function probeFrames(page, frames) {
    return page.evaluate(async (frames) => {
        const tri = await import('/pose/triangulation.js');
        const st = window.__lucid.state, s = st.session;
        const out = {};
        for (const f of frames) {
            st.currentFrame = f;
            try { await tri.ensureLazyFrameData(f); } catch (e) { out[f] = 'ERR ' + e.message; continue; }
            const fg = s.frameGroups.get(f);
            const row = {};
            for (const c of s.cameras) {
                let u = 0, p = 0;
                if (fg) {
                    for (const x of (fg.instances.get(c.name) || [])) (x.type === 'user' ? u++ : p++);
                    for (const x of fg.getUnlinkedInstances(c.name)) (x.instance.type === 'user' ? u++ : p++);
                }
                row[c.name] = u + 'u/' + p + 'p';
            }
            out[f] = row;
        }
        return out;
    }, frames);
}

async function annotate(page, spec) {
    return page.evaluate(async (spec) => {
        const pd = await import('/pose/pose-data.js');
        const tri = await import('/pose/triangulation.js');
        const s = window.__lucid.state.session;
        const cams = s.cameras.map(c => c.name);
        const done = [];
        for (const [fStr, which] of Object.entries(spec)) {
            const f = Number(fStr);
            // Navigate there first, as a user would (hydrates a lazy frame).
            window.__lucid.state.currentFrame = f;
            await tri.ensureLazyFrameData(f);
            const camsHere = which === '*' ? cams : which;
            for (const cn of camsHere) {
                const fg = s.frameGroups.get(f);
                const pred = fg ? fg.getUnlinkedInstances(cn).map(u => u.instance).find(i => i.type === 'predicted') : null;
                const nn = s.skeleton.nodes.length;
                const pts = [];
                for (let n = 0; n < nn; n++) {
                    pts.push(pred && pred.hasPoint(n) ? [pred.getX(n) + 3, pred.getY(n) + 3] : [100 + 20 * n, 100]);
                }
                s.addUnlinkedInstance(f, cn, new pd.Instance(pts, pred ? pred.trackIdx : 0, 'user', 1));
                done.push(cn + '@' + f);
            }
        }
        return done;
    }, spec);
}

// Stub the File System Access picker so an export lands in window.__written.
async function stubPicker(page) {
    await page.evaluate(() => {
        window.__written = [];
        const mkDir = (prefix) => ({
            kind: 'directory', name: prefix || 'export',
            async getDirectoryHandle(name) { return mkDir((prefix ? prefix + '/' : '') + name); },
            async getFileHandle(name) {
                const p = (prefix ? prefix + '/' : '') + name;
                return {
                    kind: 'file', name,
                    async createWritable() {
                        const parts = [];
                        return {
                            async write(b) { parts.push(b); },
                            async close() { window.__written.push({ path: p, blob: new Blob(parts) }); },
                        };
                    },
                };
            },
        });
        window.showDirectoryPicker = async () => mkDir('');
    });
}

async function drainWritten(page, destDir) {
    const n = await page.evaluate(() => window.__written.length);
    const got = [];
    for (let i = 0; i < n; i++) {
        const meta = await page.evaluate(i => ({ path: window.__written[i].path, size: window.__written[i].blob.size }), i);
        const dest = path.join(repoRoot, destDir, meta.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const fd = fs.openSync(dest, 'w');
        const CH = 4 << 20;
        for (let off = 0; off < meta.size; off += CH) {
            const b64 = await page.evaluate(async ({ i, off, CH }) => {
                const buf = new Uint8Array(await window.__written[i].blob.slice(off, off + CH).arrayBuffer());
                let s = '';
                for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(k, k + 0x8000));
                return btoa(s);
            }, { i, off, CH });
            fs.writeSync(fd, Buffer.from(b64, 'base64'));
        }
        fs.closeSync(fd);
        got.push({ path: meta.path, size: meta.size });
    }
    await page.evaluate(() => { window.__written = []; });
    return got;
}

async function runModalExport(page, which) {
    await stubPicker(page);
    const r = await page.evaluate(async (which) => {
        const em = await import('/ui/export-modals.js');
        if (which === 'bycam') em.showSlpExportByCamModal(); else em.showSlpExportPerSessionModal();
        const btn = document.getElementById(which === 'bycam' ? 'slpByCamDownloadAll' : 'slpPsExport');
        const names = which === 'bycam'
            ? Array.from(document.querySelectorAll('.slp-bycam-cam-head')).map(h => h.textContent)
            : Array.from(document.querySelectorAll('.slp-ps-filename')).map(i => i.value);
        btn.click();
        const t = performance.now();
        while (performance.now() - t < 600000) {
            await new Promise(r => setTimeout(r, 250));
            const err = document.getElementById(which === 'bycam' ? 'slpByCamError' : 'slpPsError');
            if (err && err.textContent) return { names, error: err.textContent };
            if (!document.getElementById(which === 'bycam' ? 'slpByCamDownloadAll' : 'slpPsExport')) break;
        }
        const statusEl = document.getElementById('statusText');
        return { names, status: statusEl ? statusEl.textContent : null, written: window.__written.map(w => w.path) };
    }, which);
    // Dismiss the result popup.
    await page.evaluate(() => {
        for (const b of document.querySelectorAll('button')) if (/^(OK|Close)$/.test(b.textContent.trim()) && b.offsetParent) b.click();
    });
    return r;
}

// ---- main ----------------------------------------------------------------
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
let browser;
const report = { data: DATA };
try {
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--js-flags=--max-old-space-size=4096'] });

    if (PHASE === 'export' || PHASE === 'all') {
        const { page, logs } = await boot(browser, 'export');
        const entries = listFolder(DATA);
        log('loading ' + DATA + ': ' + entries.map(e => e.rel + ' (' + e.size + ')').join(', '));
        const lr = await loadFolder(page, entries, DEFER_VIDEOS);
        const c0 = await census(page);
        log(`original load: ${lr.ms} ms`);
        log('  ' + JSON.stringify(c0));
        report.originalLoad = c0;

        if (process.env.TRACK) {
            const { answerTrackSetup } = await import('./fixtures/track-setup.js');
            await answerTrackSetup(page, process.env.TRACK);
            const tr = await page.evaluate(async () => {
                const t = performance.now();
                const m = await import('/pose/tracker.js');
                await m.trackAll();
                const s = window.__lucid.state.session;
                let groups = 0;
                for (const [, gs] of s.instanceGroups) groups += gs.length;
                return { ms: Math.round(performance.now() - t), groups, identities: (s.identities || []).length,
                         status: document.getElementById('statusText').textContent };
            });
            log('Track All: ' + JSON.stringify(tr));
            report.trackAll = tr;
            report.afterTrack = await census(page);
            log('  ' + JSON.stringify(report.afterTrack.resident));
        }

        const ann = await annotate(page, ANNOTATE);
        log('annotated: ' + ann.join(', '));
        report.afterAnnotate = await census(page);
        report.afterAnnotateProbe = await probeFrames(page, Object.keys(ANNOTATE).map(Number));
        log('  on-screen at annotated frames: ' + JSON.stringify(report.afterAnnotateProbe));

        fs.rmSync(path.join(repoRoot, OUT), { recursive: true, force: true });
        for (const which of ['bycam', 'persession']) {
            const r = await runModalExport(page, which);
            const files = await drainWritten(page, OUT + '/' + which);
            log(`export ${which}: ` + JSON.stringify(r) + ' -> ' + JSON.stringify(files));
            report['export_' + which] = { modal: r, files };
        }
        report.exportLogs = logs.slice();
        logs.forEach(l => log('  ' + l));
        await page.close();
    }

    if (PHASE === 'reload' || PHASE === 'all') {
        // Scenarios are folders prepared under OUT/scenarios by the shell (see
        // the issue write-up); each one is loaded on a FRESH page.
        const scenRoot = path.join(repoRoot, OUT, 'scenarios');
        const scens = fs.existsSync(scenRoot) ? fs.readdirSync(scenRoot).filter(d => !d.startsWith('.')).sort() : [];
        report.reload = {};
        for (const sc of scens) {
            const { page, logs } = await boot(browser, 'reload ' + sc);
            const entries = listFolder(OUT + '/scenarios/' + sc);
            log(`[${sc}] files: ` + entries.filter(e => /\.(slp|h5)$/.test(e.rel)).map(e => e.rel + ' (' + e.size + ')').join(', '));
            const lr = await loadFolder(page, entries, DEFER_VIDEOS);
            const c = await census(page);
            const probe = c.status && /Failed/.test(c.status) ? null : await probeFrames(page, Object.keys(ANNOTATE).map(Number));
            log(`[${sc}] load ${lr.ms} ms: ` + JSON.stringify(c));
            log(`[${sc}] on-screen at annotated frames: ` + JSON.stringify(probe));
            logs.forEach(l => log(`  [${sc}] ` + l));
            report.reload[sc] = { census: c, probe, logs: logs.slice() };
            await page.close();
        }
    }
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    fs.mkdirSync(path.join(repoRoot, OUT), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, OUT, 'report-' + PHASE + '.json'), JSON.stringify(report, null, 1));
    log('report written to ' + OUT + '/report-' + PHASE + '.json');
}
