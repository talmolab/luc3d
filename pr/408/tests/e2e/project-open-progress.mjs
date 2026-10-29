/**
 * project-open-progress.mjs — opening a saved project shows the progress card.
 *
 * Opening a large project (`handleLoadProjectSlpLazy`, File ▸ Load Project on a
 * big `.slp`) used to show one changing line — "Reading frames", "Reading
 * points", … — with nothing saying how far along it was; over a network share
 * "Reading points" sat for minutes. It now shows the shared card, titled
 * "Open project", one step per stage (loading/session-loader.js
 * `createOpenProgress`):
 *   1. Reading the project file — counted in MB: the vendored reader reads the
 *      four big tables in row slices and counts each (LUCID local patch, open
 *      progress, `onReadBytes`);
 *   2. Reading 3D groups and points — spinner;
 *   3. Restoring 3D groups — counted in frames;
 *   4. Drawing the first frame — spinner.
 *
 * Builds a real project file with the app's own streaming writer (a lazy
 * session: 2 cameras, 3,000 frames, 3D on every group), shrinks the reader's
 * slice size so the read takes many slices, opens it through the real
 * function, and checks:
 *   - the steps appear in order, each PAINTED before its work ran;
 *   - the MB count climbs from 0 to the whole size, over several updates;
 *   - the frame count of step 3 reaches 3,000/3,000;
 *   - the card is gone afterwards and the project is open (3,000 grouped frames);
 *   - the sliced read gives EXACTLY the same store columns as a whole read
 *     (every value of frames / instances / points / pred_points).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8143);
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
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    // ---- a real project file, written by the app's streaming writer ----
    const fileInfo = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const fileio = await import('/import-export/file-io.js');
        const lazyMod = await import('/loading/sio-lazy-loader.js');
        const sw = await import('/import-export/slp-streaming-write.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;
        const NODES = 4, FRAMES = 3000, CAMS = ['camA', 'camB'];
        const skel = () => new Skeleton('skeleton', Array.from({ length: NODES }, (_, i) => 'n' + i),
            Array.from({ length: NODES - 1 }, (_, i) => [i, i + 1]));
        const camera = (name, i) => new Camera(name, [[1000, 0, 128], [0, 1000, 128], [0, 0, 1]],
            [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [256, 256]);
        const pts = (f, k, c) => [50 + k + (f % 97) + 0.25 * c, 60 + k + (f % 13)];
        const session = new Session(CAMS.map(camera), skel(), ['t0'], 'proj');
        const loader = new SioLazyLoader();
        for (let ci = 0; ci < CAMS.length; ci++) {
            const s = new Session([camera(CAMS[ci], ci)], skel(), ['t0'], 'proj');
            for (let f = 0; f < FRAMES; f++) {
                const fg = new FrameGroup(f); s.addFrameGroup(fg);
                fg.addInstance(CAMS[ci], new Instance(Array.from({ length: NODES }, (_, k) => pts(f, k, ci)), 0, 'predicted', 0.9));
            }
            const labels = fileio.buildSlpLabels(s, CAMS[ci], false,
                { videoWidth: 256, videoHeight: 256, frameCount: FRAMES, videoPath: CAMS[ci] + '.mp4' });
            await loader.open(CAMS[ci], new File([await window.SleapIO.saveSlpToBytes(labels)], CAMS[ci] + '.slp'));
        }
        session.lazyLoader = loader;
        const id = session.addIdentity('Red').id;
        for (let f = 0; f < FRAMES; f++) {
            const g = new InstanceGroup(f + 1, id);
            for (let ci = 0; ci < CAMS.length; ci++) {
                g.addInstance(CAMS[ci], new Instance(Array.from({ length: NODES }, (_, k) => pts(f, k, ci)), 0, 'predicted', 0.9));
            }
            g.points3d = new Float64Array(NODES * 3).fill(1 + f);
            session.instanceGroups.set(f, [g]);
        }
        const views = CAMS.map(cn => ({ name: cn, videoWidth: 256, videoHeight: 256, frameCount: FRAMES }));
        const vfs = CAMS.map(cn => ({ name: cn, assignedCamera: cn, videoPath: cn + '.mp4' }));
        const bytes = await sw.buildSessionSlpBytesStreaming(session, views, vfs);
        window.__projFile = new File([bytes], 'proj.slp');
        return { bytes: bytes.length };
    });
    console.log(`  fixture: ${fileInfo.bytes.toLocaleString()} bytes`);

    // ---- the sliced read gives exactly what a whole read gives ----
    const same = await page.evaluate(async () => {
        const lazyMod = await import('/loading/sio-lazy-loader.js');
        const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;
        const storeOf = async (sliced) => {
            globalThis.__lucidReadSliceElems = sliced ? 500 : undefined;
            const l = new SioLazyLoader();
            const counts = [];
            const o = await l.openProjectSlp(window.__projFile, null, sliced ? (d, t) => { counts.push([d, t]); } : undefined);
            globalThis.__lucidReadSliceElems = undefined;
            const st = o.labels._lazyDataStore;
            return { st, counts };
        };
        const a = await storeOf(false), b = await storeOf(true);
        let cols = 0, values = 0, diffs = [];
        for (const t of ['framesData', 'instancesData', 'pointsData', 'predPointsData']) {
            const A = a.st[t] || {}, B = b.st[t] || {};
            const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
            for (const k of keys) {
                cols++;
                const x = A[k], y = B[k];
                if (!x || !y || x.length !== y.length || x.constructor !== y.constructor) { diffs.push(t + '.' + k + ' shape/type'); continue; }
                for (let i = 0; i < x.length; i++) { values++; if (!Object.is(x[i], y[i])) { diffs.push(t + '.' + k + '[' + i + ']'); break; } }
            }
        }
        return { cols, values, diffs: diffs.slice(0, 5), counts: b.counts.length, last: b.counts[b.counts.length - 1], first: b.counts[0] };
    });
    check(same.cols >= 15 && same.values > 30000 && same.diffs.length === 0,
        `a sliced read gives the same store as a whole read (${same.cols} columns, ${same.values.toLocaleString()} values)`, same);
    check(same.counts > 10 && same.first[0] === 0 && same.last[0] === same.last[1] && same.last[1] > 0,
        `the byte count goes from 0 to the tables' whole size, over ${same.counts} slices`, same);

    // ---- the card, through the real open ----
    const run = await page.evaluate(async () => {
        const rec = { states: [] };
        const g = (id) => { const e = document.getElementById(id); return e && !e.classList.contains('hidden') ? e.textContent : ''; };
        const snap = () => {
            const ov = document.getElementById('loadingOverlay');
            return { visible: !!ov && !ov.classList.contains('hidden'), title: g('loadingTitle'),
                status: g('loadingStatus'), sub: g('loadingSubstatus'), painted: false };
        };
        const mo = new MutationObserver(() => {
            const s = snap(), last = rec.states[rec.states.length - 1];
            if (!last || last.visible !== s.visible || last.status !== s.status || last.sub !== s.sub) rec.states.push(s);
        });
        mo.observe(document.getElementById('loadingOverlay'), { subtree: true, childList: true, characterData: true, attributes: true });
        let ticking = true;
        (function tick() { const l = rec.states[rec.states.length - 1]; if (l) l.painted = true; if (ticking) requestAnimationFrame(tick); })();
        // the video prompt that follows the open: skip it
        const skipper = setInterval(() => {
            const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || '') && x.offsetParent);
            if (b) b.click();
        }, 100);
        globalThis.__lucidReadSliceElems = 500;
        const sl = await import('/loading/session-loader.js');
        let err = null;
        try { await sl.handleLoadProjectSlpLazy(window.__projFile); } catch (e) { err = String(e); }
        globalThis.__lucidReadSliceElems = undefined;
        clearInterval(skipper); mo.disconnect(); ticking = false;
        const s = window.__lucid.state.session;
        return { err, states: rec.states, after: snap(), groups: s ? s.instanceGroups.size : -1,
            status: (document.getElementById('statusText') || {}).textContent || '' };
    });
    check(!run.err && /Reopened proj\.slp/.test(run.status) && run.groups === 3000,
        'the project opened (3,000 grouped frames)', { err: run.err, status: run.status, groups: run.groups });
    const steps = run.states.filter(s => s.visible && /Step \d of \d/.test(s.sub))
        .map(s => ({ step: s.sub.match(/Step (\d) of (\d)/).slice(1).join('/'), status: s.status, painted: s.painted }));
    const first = [];
    for (const s of steps) if (!first.length || first[first.length - 1].step !== s.step) first.push(s);
    check(JSON.stringify(first.map(s => s.step)) === JSON.stringify(['1/4', '2/4', '3/4', '4/4']),
        'the card shows steps 1-4 in order', first);
    check(first.length === 4 && first.every(s => s.painted), 'every step was painted before its work ran', first);
    const mb = run.states.map(s => s.status).filter(t => /^Reading the project file: /.test(t));
    const nums = mb.map(t => t.match(/: ([\d.,]+)\/([\d.,]+) MB…$/)).filter(Boolean)
        .map(m => [parseFloat(m[1].replace(/,/g, '')), parseFloat(m[2].replace(/,/g, ''))]);
    check(nums.length >= 2 && nums[0][0] === 0 && nums[nums.length - 1][0] === nums[nums.length - 1][1] &&
          nums.every((n, i) => i === 0 || n[0] >= nums[i - 1][0]),
        `step 1 counts megabytes read, from 0 to the whole size (${mb.length} updates: ${mb[0]} … ${mb[mb.length - 1]})`, mb);
    const fr = run.states.map(s => s.status).filter(t => /^Restoring 3D groups: /.test(t));
    check(fr.some(t => /: 3,000\/3,000 frames…$/.test(t)), 'step 3 counts frames, to 3,000/3,000', fr);
    check(run.states.filter(s => s.visible).every(s => s.title === 'Open project'), 'the card is titled "Open project" throughout');
    check(run.states.filter(s => s.visible && /Step/.test(s.sub)).every(s => /proj\.slp/.test(s.sub)), 'the detail line names the file');
    check(!run.after.visible, 'the card is gone once the project is open', run.after);
} catch (e) {
    console.error('FATAL', e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
