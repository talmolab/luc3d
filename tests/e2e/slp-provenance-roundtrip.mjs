/**
 * slp-provenance-roundtrip.mjs — a loaded .slp's provenance survives LUC3D's
 * real load → Save → reopen, on every project save path.
 *
 * Every save used to write a fresh `{ source: 'lucid', exported_at }`, so
 * opening campy-live-export's campy-live.slp and saving it dropped what campy
 * keeps in the provenance: its copies of the recording's session.json and
 * campy-live-session.json, `animalIds` and `calibrationDiffers`. The rule is
 * `import-export/slp-provenance.js` (unit test: `tests/test-slp-provenance.mjs`).
 *
 *  1. Eager: `handleLoadSlpFile` → File ▸ Save (`saveProjectSlp`, eager
 *     `buildSlpBytes`) keeps every campy key and adds LUC3D's pair; a second
 *     load → save keeps it again, nothing doubled. The campy dict here is
 *     ~130 KB (an HDF5 attribute over 64 KB is the size to worry about).
 *  2. Lazy: `handleLoadProjectSlpLazy` → Save (single-session streaming writer)
 *     and `saveAllSessionsStreaming` (the multi-session streaming writer).
 *  3. Two sessions with different provenances: both kept (`lucid_sessions`),
 *     each back on its own session after reopening.
 *  4. A file with no provenance saves exactly `{ source, exported_at }`.
 *  5. A per-camera 2D export still writes only `{ source, exported_at }`.
 *  6. The single-SLP folder loader ("Add session folder"), with a project open:
 *     the added recording keeps campy's provenance, the open session its none.
 *
 * Run: node tests/e2e/slp-provenance-roundtrip.mjs   (spawns its own http.server; PORT=…)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8197);
const VIDEO = path.join(repoRoot, 'tests', 'fixtures', 'barcode-60', 'barcode-60.mp4');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-provenance-'));

let fails = 0;
const check = (c, m, extra) => { console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : ' — ' + extra)); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

// campy-live-export's provenance (olinesn/campy campy/liveexport.py Provenance()).
const notes = 'x'.repeat(120000);   // session.json fields can be long; push the attribute past 64 KB
const CAMPY = {
    'campy-live-export': 'D:/rec/20261020_mice/campy-live.log',
    session: {
        schema: 'campy-session/1', status: 'complete',
        experiment: { name: 'None', animalIds: ['m1', 'm2'], notes },
        cameras: [{ index: 0, name: 'cam0', video: 'cam0/0.mp4', serial: '24153710' },
                  { index: 1, name: 'cam1', video: 'cam1/0.mp4', serial: '24153711' }],
        config: { effective: { frameRate: { value: 40 } } },
    },
    'campy-live-session': { schema: 'campy-live-session/1', log: 'D:/rec/20261020_mice/campy-live.log',
                            calibration: { path: 'calibration.toml', sha256: 'ab12cd', cameraNames: ['cam0', 'cam1'] } },
    animalIds: ['m1', 'm2'],
    calibrationDiffers: { given: 'ef34', campyLive: 'ab12cd' },
};
const OTHER = { 'campy-live-export': 'E:/rec2/campy-live.log', animalIds: ['m7'], session: { schema: 'campy-session/1' } };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });
    page.on('dialog', d => d.accept());

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm && window.__lucid && window.__lucid.state, { timeout: 120000 });

    // ---- page helpers: fixtures, the provenance in a file's bytes, the real Save ----
    await page.evaluate(() => {
        window.__makeSession = async (name, cams) => {
            const pd = await import('/pose/pose-data.js');
            const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
            const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
            const cameras = cams.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [-12 * i, 0, 2 * i], [512, 512]));
            const skeleton = new Skeleton('skeleton', ['a', 'b'], [[0, 1]]);
            const s = new Session(cameras, skeleton, ['track_0'], name);
            for (let f = 0; f < 3; f++) {
                const fg = new FrameGroup(f);
                s.addFrameGroup(fg);
                const g = new InstanceGroup(f + 1, 0);
                cams.forEach((cn, ci) => {
                    const inst = new Instance([[100 + f + ci, 120], [140 + f, 160 + ci]], 0, 'user', 1);
                    fg.addInstance(cn, inst);
                    g.addInstance(cn, inst);
                });
                s.instanceGroups.set(f, [g]);
            }
            return s;
        };
        // A project .slp the way LUC3D writes one, with `provenance` as given.
        window.__projectBytes = async (session, provenance) => {
            const fileio = await import('/import-export/file-io.js');
            const views = session.cameras.map(c => ({ name: c.name, videoWidth: 512, videoHeight: 512, frameCount: 3 }));
            const vfs = session.cameras.map(c => ({ name: c.name, assignedCamera: c.name, videoPath: c.name + '.mp4' }));
            const labels = fileio.buildSlpLabelsAllViews(session, views, vfs);
            labels.provenance = provenance == null ? {} : JSON.parse(JSON.stringify(provenance));
            return await window.SleapIO.saveSlpToBytes(labels);
        };
        let n = 0;
        window.__provenanceOf = async (bytes) => {
            const h5 = window.h5wasm;
            await h5.ready;
            const p = '/prov-' + (n++) + '.slp';
            h5.FS.writeFile(p, bytes);
            const f = new h5.File(p, 'r');
            try { return JSON.parse(f.get('metadata').attrs.json.value).provenance; }
            finally { f.close(); h5.FS.unlink(p); }
        };
        // One view per camera (no panes), so the savers have views to write.
        window.__setViews = async () => {
            const AS = await import('/ui/app-state.js');
            const cams = [];
            for (const s of AS.state.sessions) for (const c of s.cameras) if (!cams.includes(c.name)) cams.push(c.name);
            AS.state.views = cams.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: 3 }));
            AS.state.videoFiles = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        };
        // File ▸ Save as the app does it without a file handle: build, download.
        window.__saveThroughApp = async () => {
            const sl = await import('/import-export/save-load.js');
            const orig = URL.createObjectURL;
            let blob = null;
            URL.createObjectURL = (b) => { blob = b; return orig.call(URL, b); };
            try { await sl.saveProjectSlp(); } finally { URL.createObjectURL = orig; }
            if (!blob) throw new Error('saveProjectSlp produced no file: ' + (document.getElementById('statusText') || {}).textContent);
            return new Uint8Array(await blob.arrayBuffer());
        };
    });

    /** Load page-global bytes through a real loader, dismissing the prompts it raises. */
    async function load(fn, globalName, fileName) {
        await page.evaluate(([fn, g, name]) => {
            window.__loadDone = false;
            (async () => {
                const file = new File([window[g]], name);
                if (fn === 'eager') await (await import('/import-export/slp-import.js')).handleLoadSlpFile(file);
                else await (await import('/loading/session-loader.js')).handleLoadProjectSlpLazy(file);
            })().then(() => { window.__loadDone = true; }, e => { window.__loadDone = 'ERR ' + (e && e.stack || e); });
        }, [fn, globalName, fileName]);
        for (let i = 0; i < 240; i++) {
            const s = await page.evaluate(() => {
                const b = [...document.querySelectorAll('button')].find(x => x.offsetParent && /^(Skip|Later|Cancel|Not now)$/i.test((x.textContent || '').trim()));
                if (b) { b.click(); return 'clicked'; }
                return { done: window.__loadDone, prompt: !!document.getElementById('videoSelectOverlay') };
            });
            if (s.prompt) await page.keyboard.press('Escape');
            if (s.done) return s.done;
            await page.waitForTimeout(250);
        }
        return 'timeout';
    }

    const sessionProvs = () => page.evaluate(() => window.__lucid.state.sessions.map(s => ({ name: s.name, prov: s.fileProvenance })));
    const saveAndRead = () => page.evaluate(async () => {
        await window.__setViews();
        window.__saved = await window.__saveThroughApp();
        return await window.__provenanceOf(window.__saved);
    });
    const campyPlus = (p) => {
        const rest = Object.assign({}, p); delete rest.source; delete rest.exported_at;
        return eq(rest, CAMPY) && p.source === 'lucid' && ISO.test(p.exported_at);
    };

    // ---- fixtures ----
    const sizes = await page.evaluate(async ([CAMPY, OTHER]) => {
        const a = await window.__makeSession('rec', ['cam0', 'cam1']);
        window.__campyBytes = await window.__projectBytes(a, CAMPY);
        window.__plainBytes = await window.__projectBytes(await window.__makeSession('plain', ['cam0', 'cam1']), null);
        const prov = await window.__provenanceOf(window.__campyBytes);
        return { attr: JSON.stringify(prov).length, readBack: JSON.stringify(prov) === JSON.stringify(CAMPY) };
    }, [CAMPY, OTHER]);
    check(sizes.readBack, `fixture: campy's provenance (${sizes.attr.toLocaleString('en-US')} chars) written and read back by sleap-io`);

    // =================================================================
    console.log('\n-- 1. eager: load campy-live.slp → Save keeps campy\'s provenance --');
    check(await load('eager', '__campyBytes', 'campy-live.slp') === true, 'handleLoadSlpFile loaded it');
    let sp = await sessionProvs();
    check(sp.length === 1 && eq(sp[0].prov, CAMPY), 'the session holds the file\'s provenance');
    let prov = await saveAndRead();
    check(campyPlus(prov), 'saved file: campy\'s five keys unchanged + source "lucid" + exported_at',
        JSON.stringify(Object.keys(prov || {})));
    check(Object.keys(prov).slice(0, 5).join() === Object.keys(CAMPY).join(), 'in campy\'s key order');

    // Reopen the saved file and save again.
    await page.evaluate(() => { window.__resaved1 = window.__saved; });
    check(await load('eager', '__resaved1', 'campy-live.slp') === true, 'the saved file reopens');
    sp = await sessionProvs();
    check(eq(sp[0].prov, CAMPY), 'reopened: the session holds campy\'s keys only (LUC3D\'s pair is not carried)');
    const firstAt = prov.exported_at;
    await page.waitForTimeout(5);
    prov = await saveAndRead();
    check(campyPlus(prov) && !('lucid' in prov) && !('lucid_sessions' in prov), 'saved again: same keys, nothing doubled');
    check(prov.exported_at >= firstAt, 'exported_at refreshed');

    // =================================================================
    console.log('\n-- 5. a per-camera 2D export still writes only LUC3D\'s pair --');
    const exportProv = await page.evaluate(async () => {
        const fileio = await import('/import-export/file-io.js');
        const s = window.__lucid.state.session;
        return fileio.buildSlpLabels(s, s.cameras[0].name, false, null).provenance;
    });
    check(eq(Object.keys(exportProv), ['source', 'exported_at']) && exportProv.source === 'lucid',
        'buildSlpLabels: { source, exported_at }', JSON.stringify(exportProv));

    // =================================================================
    console.log('\n-- 2. lazy: Load Project → Save, and the multi-session streaming writer --');
    await page.evaluate(() => { window.__lazyIn = window.__saved; });
    check(await load('lazy', '__lazyIn', 'campy-live.slp') === true, 'handleLoadProjectSlpLazy loaded it');
    sp = await sessionProvs();
    check(sp.length === 1 && eq(sp[0].prov, CAMPY), 'the lazy session holds campy\'s provenance');
    const lazyOk = await page.evaluate(() => !!window.__lucid.state.session.lazyLoader);
    check(lazyOk, 'the session is lazy (the streaming writer path)');
    prov = await saveAndRead();
    check(campyPlus(prov), 'single-session streaming save: campy\'s keys kept', JSON.stringify(Object.keys(prov || {})));
    const multiProv = await page.evaluate(async () => {
        const sl = await import('/import-export/save-load.js');
        const bytes = await sl.saveAllSessionsStreaming(window.__lucid.state.sessions);
        return await window.__provenanceOf(bytes);
    });
    check(campyPlus(multiProv), 'saveAllSessionsStreaming: campy\'s keys kept', JSON.stringify(Object.keys(multiProv || {})));

    // =================================================================
    console.log('\n-- 3. two sessions from different files: both kept --');
    const two = await page.evaluate(async ([CAMPY, OTHER]) => {
        const AS = await import('/ui/app-state.js');
        const a = await window.__makeSession('recA', ['cam0', 'cam1']);
        const b = await window.__makeSession('recB', ['cam0', 'cam1']);
        const c = await window.__makeSession('handMade', ['cam0', 'cam1']);
        a.fileProvenance = JSON.parse(JSON.stringify(CAMPY));
        b.fileProvenance = JSON.parse(JSON.stringify(OTHER));
        AS.state.sessions = [a, b, c];
        AS.state.session = a;
        AS.state.activeSessionIdx = 0;
        await window.__setViews();
        window.__saved = await window.__saveThroughApp();
        window.__twoBytes = window.__saved;
        return await window.__provenanceOf(window.__saved);
    }, [CAMPY, OTHER]);
    const top = Object.assign({}, two); delete top.lucid_sessions;
    check(campyPlus(top), 'top level: the first session\'s (campy) provenance + LUC3D\'s pair');
    check(eq(two.lucid_sessions, { recB: OTHER, handMade: {} }), 'lucid_sessions: recB\'s dict, handMade as {}',
        JSON.stringify(two.lucid_sessions));
    check(await load('eager', '__twoBytes', 'project.slp') === true, 'the project reopens');
    sp = await sessionProvs();
    check(eq(sp.map(s => s.name), ['recA', 'recB', 'handMade']), 'three sessions, in order');
    check(eq(sp.map(s => s.prov), [CAMPY, OTHER, null]), 'each session has its own provenance back');
    const resaved = await saveAndRead();
    const strip = (p) => { const o = Object.assign({}, p); delete o.exported_at; return o; };
    check(eq(strip(resaved), strip(two)), 'saved again: the same provenance');

    // =================================================================
    console.log('\n-- 4. a file with no provenance saves exactly { source, exported_at } --');
    check(await load('eager', '__plainBytes', 'plain.slp') === true, 'loaded a file with no provenance');
    sp = await sessionProvs();
    check(sp[0].prov === null, 'its session has none');
    prov = await saveAndRead();
    check(eq(Object.keys(prov), ['source', 'exported_at']) && prov.source === 'lucid' && ISO.test(prov.exported_at),
        'saved: { source: "lucid", exported_at }', JSON.stringify(prov));

    // =================================================================
    console.log('\n-- 6. "Add session folder" (single-SLP folder loader) with a project open --');
    // A campy recording folder as campy-live-export leaves it: campy-live.slp + videos.
    const recDir = path.join(tmpRoot, 'rec');
    fs.mkdirSync(path.join(recDir, 'videos'), { recursive: true });
    const b64 = await page.evaluate(() => {
        const b = window.__campyBytes; let s = '';
        for (let o = 0; o < b.length; o += 0x8000) s += String.fromCharCode.apply(null, b.subarray(o, o + 0x8000));
        return btoa(s);
    });
    fs.writeFileSync(path.join(recDir, 'campy-live.slp'), Buffer.from(b64, 'base64'));
    for (const cam of ['cam0', 'cam1']) fs.copyFileSync(VIDEO, path.join(recDir, 'videos', cam + '.mp4'));
    page.once('filechooser', fc => fc.setFiles(recDir));
    await page.evaluate(async () => {
        const m = await import('/loading/session-loader.js');
        await m.handleLoadSessionFolderSingleSlp();
    });
    sp = await sessionProvs();
    check(eq(sp.map(s => s.name), ['plain', 'rec']), 'the folder was added as a second session', JSON.stringify(sp.map(s => s.name)));
    check(sp.length === 2 && sp[0].prov === null && eq(sp[1].prov, CAMPY), 'the added session holds campy\'s provenance, the open one none');
    prov = await saveAndRead();
    const added = Object.assign({}, prov); delete added.lucid_sessions;
    check(campyPlus(added) && eq(prov.lucid_sessions, { plain: {} }),
        'saved: campy\'s provenance on top, the session without one listed as {}', JSON.stringify(prov.lucid_sessions));
} catch (e) {
    console.log('  ✗ threw:', e && e.stack || e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
