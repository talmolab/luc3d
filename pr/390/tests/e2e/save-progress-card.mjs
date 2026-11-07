/**
 * save-progress-card.mjs — File ▸ Save shows the shared progress card.
 *
 * A Save used to say only "Saving..." / "Building SLP..." in the status bar
 * while it held the main thread for up to minutes on a large project. In
 * Brave (no save-file picker) the browser's save dialog cannot open until the
 * whole file is built, so after File ▸ Save the app simply looked idle. Save
 * now shows the loading overlay's card (ui/loading-overlay.js — the one Track
 * All and Triangulate All use), titled "Save", one step per stage of the
 * write (import-export/save-load.js `createSaveProgress`).
 *
 * Drives the real save functions on a synthetic lazy session (two cameras,
 * 6,000 grouped frames, so the counted step reports more than once) and
 * records every state the card shows, plus whether a frame was PAINTED while
 * each step was up — the uncounted steps hold the main thread inside the
 * vendored writer, so a step that is not painted before that is never seen:
 *
 *   1. Brave path (`saveProjectSlp`, no `showSaveFilePicker`): steps 1-5 in
 *      order — Collecting 3D groups (counted, "x/6,000 frames"), Writing 3D
 *      groups and points, Writing 2D poses (counted, "x/12,000 camera
 *      frames", through the vendored writer's `appendStoreAsync`), Finishing
 *      the file, Opening the save dialog — each painted; the card is still up, on step 5, when the
 *      download is started; it is the shared card style; it is gone after.
 *   2. A second Save while one runs is refused, not started (two builds would
 *      hold two copies of the file in memory).
 *   3. Chrome path (`saveAs` with a picker): the card is NOT up while the
 *      picker is open (it comes after, so it cannot cost the click its user
 *      activation), then steps 1-4; gone after; the file is written.
 *      Step 4 then shows the write to the file as a bar in MB ("Writing to
 *      disk: x/y MB…", y = the finished file's size) that only rises and ends
 *      at 100%, then "Closing the file…" as a spinner (the browser's close()
 *      reports no progress), painted before close() runs.
 *   4. An eager (non-lazy) project: "Writing the file", step 1 of 2; through
 *      a picker, the same MB bar (no steps line: one step) and close spinner.
 *   5. A failing save takes the card down and clears `isSaving`.
 *   6. File ▸ Export ▸ Labels (JSON) (`exportLabels`, ui/export-modals.js):
 *      "Exporting labels: x/6,000 frames…" bar that only rises to 6,000/6,000,
 *      then "Closing the file…" before the picked file's close().
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8139);
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 600)));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });

    // ---- fixture + recorder ----
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const fileio = await import('/import-export/file-io.js');
        const lazyMod = await import('/loading/sio-lazy-loader.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;
        const NODES = 4, FRAMES = 6000, CAMS = ['camA', 'camB'];
        const skel = () => new Skeleton('skeleton', Array.from({ length: NODES }, (_, i) => 'n' + i),
            Array.from({ length: NODES - 1 }, (_, i) => [i, i + 1]));
        const camera = (name, i) => new Camera(name, [[1000, 0, 128], [0, 1000, 128], [0, 0, 1]],
            [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [256, 256]);
        const pts = (f, k) => [50 + k + (f % 100), 60 + k];

        // One per-camera prediction .slp per camera, opened lazily.
        async function lazySession(name) {
            const cams = CAMS.map(camera);
            const session = new Session(cams, skel(), ['t0'], name);
            const loader = new SioLazyLoader();
            for (let ci = 0; ci < CAMS.length; ci++) {
                const s = new Session([camera(CAMS[ci], ci)], skel(), ['t0'], name);
                for (let f = 0; f < FRAMES; f++) {
                    const fg = new FrameGroup(f); s.addFrameGroup(fg);
                    fg.addInstance(CAMS[ci], new Instance(Array.from({ length: NODES }, (_, k) => pts(f, k)), 0, 'predicted', 0.9));
                }
                const labels = fileio.buildSlpLabels(s, CAMS[ci], false,
                    { videoWidth: 256, videoHeight: 256, frameCount: FRAMES, videoPath: CAMS[ci] + '.mp4' });
                await loader.open(CAMS[ci], new File([await window.SleapIO.saveSlpToBytes(labels)], CAMS[ci] + '.slp'));
            }
            session.lazyLoader = loader;
            const id = session.addIdentity('Red').id;
            for (let f = 0; f < FRAMES; f++) {
                const g = new InstanceGroup(f + 1, id);
                for (const cn of CAMS) g.addInstance(cn, new Instance(Array.from({ length: NODES }, (_, k) => pts(f, k)), 0, 'predicted', 0.9));
                g.points3d = new Float64Array(NODES * 3).fill(1);
                session.instanceGroups.set(f, [g]);
            }
            return session;
        }
        function eagerSession() {
            const session = new Session(CAMS.map(camera), skel(), ['t0'], 'eager');
            for (let f = 0; f < 50; f++) {
                const fg = new FrameGroup(f); session.addFrameGroup(fg);
                for (const cn of CAMS) fg.addInstance(cn, new Instance(Array.from({ length: NODES }, (_, k) => pts(f, k)), 0, 'user', 1));
            }
            return session;
        }
        window.__fx = {
            async use(kind) {
                const session = kind === 'eager' ? eagerSession() : await lazySession('lazy');
                AS.state.sessions = [session];
                AS.state.session = session;
                AS.state.activeSessionIdx = 0;
                AS.state.views = CAMS.map(cn => ({ name: cn, videoWidth: 256, videoHeight: 256, frameCount: FRAMES }));
                AS.state.videoFiles = CAMS.map(cn => ({ name: cn, assignedCamera: cn, videoPath: cn + '.mp4' }));
                AS.state.slpFileHandle = null;
                AS.state.isSaving = false;
            },
        };

        // Every state the card shows, and whether a frame was painted with it up.
        const rec = window.__rec = { states: [], reset() { this.states = []; } };
        const g = (id) => { const e = document.getElementById(id); return e && !e.classList.contains('hidden') ? e.textContent : ''; };
        const snap = () => {
            const ov = document.getElementById('loadingOverlay');
            return {
                visible: !!ov && !ov.classList.contains('hidden'),
                title: g('loadingTitle'), status: g('loadingStatus'), sub: g('loadingSubstatus'),
                pct: g('loadingPct'), spinner: !!g('loadingSpinner') || !document.getElementById('loadingSpinner').classList.contains('hidden'),
                painted: false,
            };
        };
        rec.snap = snap;
        new MutationObserver(() => {
            const s = snap();
            const last = rec.states[rec.states.length - 1];
            if (!last || last.visible !== s.visible || last.status !== s.status || last.sub !== s.sub) rec.states.push(s);
        }).observe(document.getElementById('loadingOverlay'), { subtree: true, childList: true, characterData: true, attributes: true });
        (function tick() {
            const last = rec.states[rec.states.length - 1];
            if (last) last.painted = true;
            requestAnimationFrame(tick);
        })();

        // The download: record the card at the moment it starts; do not download.
        window.__clicks = [];
        HTMLAnchorElement.prototype.click = function () {
            if (this.download) { window.__clicks.push({ name: this.download, card: snap() }); return; }
        };
    });

    const steps = (states) => states.filter(s => s.visible && /Step \d+ of \d+/.test(s.sub))
        .map(s => ({ step: s.sub.match(/Step (\d+) of (\d+)/).slice(1).join('/'), status: s.status, painted: s.painted }));
    const firstOfEach = (st) => {
        const out = [];
        for (const s of st) if (!out.length || out[out.length - 1].step !== s.step) out.push(s);
        return out;
    };

    // The write to the picked file: an MB bar that only rises to 100%, on the
    // save's last step, then the close() spinner, painted before close() ran.
    const mbOf = (t) => t.match(/: ([\d.,]+)\/([\d.,]+) [KM]B…$/).slice(1).map(x => Number(x.replace(/,/g, '')));
    // The unit is KB for a file under 1 MB (the eager fixture), else MB.
    function checkDiskBar(name, r, step) {
        const unit = r.bytes < 1048576 ? 'KB' : 'MB';
        const onStep = (st) => step ? st.sub.startsWith('Step ' + step.replace('/', ' of ')) : !/Step \d/.test(st.sub);
        const disk = r.states.filter(st => st.visible && /^Writing to disk/.test(st.status));
        check(disk.length >= 3 && disk.every(st => new RegExp('^Writing to disk: [\\d.,]+/[\\d.,]+ ' + unit + '…$').test(st.status) && onStep(st)),
            name + ': the write to disk is a bar in ' + unit + ' (' + disk.length + ' states, ' + r.writes + ' writes)' + (step ? ', on step ' + step : ''),
            disk.map(st => st.status + ' | ' + st.sub));
        const totals = new Set(disk.map(st => mbOf(st.status)[1]));
        const done = disk.map(st => mbOf(st.status)[0]);
        const pcts = disk.map(st => parseInt(st.pct, 10));
        check(totals.size === 1 && done.every((d, i) => i === 0 || d >= done[i - 1]) && pcts.every((p, i) => i === 0 || p >= pcts[i - 1]),
            name + ': the disk bar has one total and only rises', { done, pcts, totals: [...totals] });
        const size = r.bytes / (unit === 'KB' ? 1024 : 1048576);
        check(disk.length > 0 && done[done.length - 1] === [...totals][0] && pcts[pcts.length - 1] === 100 &&
            Math.abs([...totals][0] - size) <= (unit === 'KB' ? 0.5 : 0.1),
            name + ': it ends at 100%, and its total is the file\'s size (' + size.toFixed(2) + ' ' + unit + ')', { last: disk[disk.length - 1], size });
        const c = r.cardAtClose;
        check(!!c && c.visible && c.status === 'Closing the file…' && c.spinner && c.painted && onStep(c) && /no progress/.test(c.sub),
            name + ': close() runs under a painted "Closing the file…" spinner that says it has no progress', c);
    }

    // ---- 1 + 2. Brave path ----
    await page.evaluate(() => window.__fx.use('lazy'));
    const brave = await page.evaluate(async () => {
        const saveLoad = await import('/import-export/save-load.js');
        const AS = await import('/ui/app-state.js');
        window.__rec.reset(); window.__clicks = [];
        const keep = window.showSaveFilePicker;
        window.showSaveFilePicker = undefined;
        let err = null, secondStatus = null, savingDuring = null, style = null;
        const p = saveLoad.saveProjectSlp().catch(e => { err = String(e); });
        // a second Save while the first runs
        await new Promise(r => setTimeout(r, 0));
        savingDuring = AS.state.isSaving;
        await saveLoad.saveProjectSlp();
        secondStatus = (document.getElementById('statusText') || {}).textContent || '';
        // the card's style, mid-save
        const { progressCardStyle } = await import('/tests/e2e/fixtures/progress-card.js');
        style = progressCardStyle(document.querySelector('.loading-card'), document.getElementById('loadingOverlay'));
        await p;
        window.showSaveFilePicker = keep;
        return {
            err, savingDuring, secondStatus, style, clicks: window.__clicks, states: window.__rec.states,
            after: window.__rec.snap(), savingAfter: AS.state.isSaving,
            status: (document.getElementById('statusText') || {}).textContent || '',
        };
    });
    check(!brave.err, 'Brave path: the save completed', brave.err);
    const bSteps = firstOfEach(steps(brave.states));
    check(JSON.stringify(bSteps.map(s => s.step)) === JSON.stringify(['1/5', '2/5', '3/5', '4/5', '5/5']),
        'Brave path: the card shows steps 1-5 in order', bSteps);
    const wantB = [/^Collecting 3D groups: [\d,]+\/6,000 frames…$/, /^Writing 3D groups and points…$/,
        /^Writing 2D poses: [\d,]+\/12,000 camera frames…$/, /^Finishing the file…$/, /^Opening the save dialog…$/];
    check(bSteps.length === 5 && bSteps.every((s, i) => wantB[i].test(s.status)),
        'Brave path: each step says what it is doing', bSteps.map(s => s.status));
    check(bSteps.length === 5 && bSteps.every(s => s.painted), 'Brave path: every step was painted before its work ran', bSteps);
    const counted = brave.states.filter(s => /^Collecting 3D groups: /.test(s.status)).map(s => s.status);
    check(counted.some(t => /: 0\/6,000/.test(t)) && counted.some(t => /: 6,000\/6,000/.test(t)),
        'Brave path: step 1 counts from 0/6,000 to 6,000/6,000 frames (thousands commas)', counted);
    const poses = brave.states.filter(s => /^Writing 2D poses: /.test(s.status)).map(s => s.status);
    check(poses.some(t => /: 0\/12,000/.test(t)) && poses.some(t => /: 12,000\/12,000/.test(t)),
        'Brave path: step 3 counts the 2D poses from 0/12,000 to 12,000/12,000 camera frames', poses);
    check(brave.states.filter(s => s.visible).every(s => s.title === 'Save'), 'Brave path: the card is titled "Save" throughout');
    check(brave.style && brave.style.ok, 'Brave path: the shared progress-card style (opaque card, clear click-blocking layer)', brave.style);
    check(brave.clicks.length === 1 && brave.clicks[0].card.visible && /Opening the save dialog/.test(brave.clicks[0].card.status),
        'Brave path: the card is up, on its last step, when the download starts', brave.clicks);
    check(!brave.after.visible && brave.savingAfter === false, 'Brave path: the card is gone and isSaving cleared afterwards', brave.after);
    check(/Project saved as SLP/.test(brave.status), 'Brave path: the status bar still reports the save', brave.status);
    check(brave.savingDuring === true && /Save already in progress/.test(brave.secondStatus) && brave.clicks.length === 1,
        'a second Save while one runs is refused, not started', { savingDuring: brave.savingDuring, secondStatus: brave.secondStatus });

    // ---- 3. Chrome path ----
    await page.evaluate(() => window.__fx.use('lazy'));
    const chrome = await page.evaluate(async () => {
        const saveLoad = await import('/import-export/save-load.js');
        const AS = await import('/ui/app-state.js');
        window.__rec.reset();
        let cardAtPicker = null, bytes = 0, closed = false, writes = 0, cardAtClose = null;
        const keep = window.showSaveFilePicker;
        window.showSaveFilePicker = async () => {
            cardAtPicker = window.__rec.snap().visible;
            return { createWritable: async () => ({
                // slow enough that the paced disk bar repaints several times
                write: async (c) => { bytes += c.byteLength; writes++; await new Promise(r => setTimeout(r, 40)); },
                close: async () => { cardAtClose = window.__rec.states[window.__rec.states.length - 1]; closed = true; },
                abort: async () => {},
            }) };
        };
        globalThis.__lucidSaveChunkBytes = 32 * 1024;
        try { await saveLoad.saveAs(); }
        finally { delete globalThis.__lucidSaveChunkBytes; window.showSaveFilePicker = keep; }
        return { cardAtPicker, bytes, writes, cardAtClose, closed, states: window.__rec.states, after: window.__rec.snap(),
            savingAfter: AS.state.isSaving, dirty: AS.state.isDirty,
            status: (document.getElementById('statusText') || {}).textContent || '' };
    });
    check(chrome.cardAtPicker === false, 'Chrome path: the card is not up while the save-file picker is open');
    const cSteps = firstOfEach(steps(chrome.states));
    check(JSON.stringify(cSteps.map(s => s.step)) === JSON.stringify(['1/4', '2/4', '3/4', '4/4']) && cSteps.every(s => s.painted),
        'Chrome path: steps 1-4 in order, each painted', cSteps);
    check(chrome.bytes > 1000 && chrome.closed && /^Saved \(/.test(chrome.status), 'Chrome path: the file was written and the save reported',
        { bytes: chrome.bytes, closed: chrome.closed, status: chrome.status });
    check(!chrome.after.visible && chrome.savingAfter === false, 'Chrome path: the card is gone and isSaving cleared afterwards', chrome.after);
    checkDiskBar('Chrome path', chrome, '4/4');

    // ---- 4. eager project ----
    await page.evaluate(() => window.__fx.use('eager'));
    const eager = await page.evaluate(async () => {
        const saveLoad = await import('/import-export/save-load.js');
        window.__rec.reset(); window.__clicks = [];
        const keep = window.showSaveFilePicker;
        window.showSaveFilePicker = undefined;
        await saveLoad.saveProjectSlp();
        window.showSaveFilePicker = keep;
        return { states: window.__rec.states, clicks: window.__clicks, after: window.__rec.snap() };
    });
    const eSteps = firstOfEach(steps(eager.states));
    check(JSON.stringify(eSteps.map(s => s.step + ' ' + s.status)) === JSON.stringify(['1/2 Writing the file…', '2/2 Opening the save dialog…']),
        'eager project: "Writing the file" (1 of 2), then the dialog step', eSteps);
    check(eager.clicks.length === 1 && !eager.after.visible, 'eager project: downloaded, card gone afterwards', eager.after);

    const eagerPick = await page.evaluate(async () => {
        const saveLoad = await import('/import-export/save-load.js');
        window.__rec.reset();
        let bytes = 0, writes = 0, cardAtClose = null;
        const keep = window.showSaveFilePicker;
        window.showSaveFilePicker = async () => ({ createWritable: async () => ({
            write: async (c) => { bytes += c.byteLength; writes++; await new Promise(r => setTimeout(r, 120)); },
            close: async () => { cardAtClose = window.__rec.states[window.__rec.states.length - 1]; },
            abort: async () => {},
        }) });
        globalThis.__lucidSaveChunkBytes = 2048;
        try { await saveLoad.saveAs(); }
        finally { delete globalThis.__lucidSaveChunkBytes; window.showSaveFilePicker = keep; }
        return { bytes, writes, cardAtClose, states: window.__rec.states };
    });
    checkDiskBar('eager project through a picker', eagerPick, null);

    // ---- 5. a failing save ----
    await page.evaluate(() => window.__fx.use('lazy'));
    const failed = await page.evaluate(async () => {
        const saveLoad = await import('/import-export/save-load.js');
        const AS = await import('/ui/app-state.js');
        window.__clicks = [];
        const keepPicker = window.showSaveFilePicker, keepOpen = window.SleapIO.openSlpWriter;
        window.showSaveFilePicker = undefined;
        // Still a function (so the streaming path is chosen), but it fails.
        window.SleapIO.openSlpWriter = async () => { throw new Error('disk on fire'); };
        try { await saveLoad.saveProjectSlp(); }
        finally { window.SleapIO.openSlpWriter = keepOpen; window.showSaveFilePicker = keepPicker; }
        return { after: window.__rec.snap(), savingAfter: AS.state.isSaving, clicks: window.__clicks.length,
            status: (document.getElementById('statusText') || {}).textContent || '' };
    });
    check(/Save failed: disk on fire/.test(failed.status) && !failed.after.visible && failed.savingAfter === false && failed.clicks === 0,
        'a failing save reports the error, takes the card down and clears isSaving', failed);

    // ---- 6. JSON labels export ----
    await page.evaluate(() => window.__fx.use('lazy'));
    const json = await page.evaluate(async () => {
        const ex = await import('/ui/export-modals.js');
        window.__rec.reset();
        let writes = 0, cardAtClose = null, closed = false;
        const keep = window.showSaveFilePicker;
        window.showSaveFilePicker = async () => ({ createWritable: async () => ({
            // a pause every 200 frames, so the paced bar repaints several times
            write: async () => { if (++writes % 200 === 0) await new Promise(r => setTimeout(r, 25)); },
            close: async () => { cardAtClose = window.__rec.states[window.__rec.states.length - 1]; closed = true; },
        }) });
        try { await ex.exportLabels(); } finally { window.showSaveFilePicker = keep; }
        return { writes, closed, cardAtClose, states: window.__rec.states, after: window.__rec.snap(),
            status: (document.getElementById('statusText') || {}).textContent || '' };
    });
    const jBars = json.states.filter(st => st.visible && /^Exporting labels: /.test(st.status));
    const jDone = jBars.map(st => Number(st.status.match(/: ([\d,]+)\//)[1].replace(/,/g, '')));
    const jPct = jBars.map(st => parseInt(st.pct, 10));
    check(jBars.length >= 3 && jBars.every(st => /^Exporting labels: [\d,]+\/6,000 frames…$/.test(st.status) && st.pct),
        'JSON export: a bar "Exporting labels: x/6,000 frames…" (' + jBars.length + ' states)', jBars.map(st => st.status));
    check(jDone.every((d, i) => i === 0 || d >= jDone[i - 1]) && jPct.every((p, i) => i === 0 || p >= jPct[i - 1]) &&
        jDone[jDone.length - 1] === 6000 && jPct[jPct.length - 1] === 100,
        'JSON export: the bar only rises and ends at 6,000/6,000 (100%)', { jDone, jPct });
    check(json.closed && json.cardAtClose && json.cardAtClose.status === 'Closing the file…' && json.cardAtClose.painted,
        'JSON export: close() runs under a painted "Closing the file…" spinner', json.cardAtClose);
    check(!json.after.visible, 'JSON export: the card is gone afterwards', { after: json.after, status: json.status });
} catch (e) {
    console.error('FATAL', e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
