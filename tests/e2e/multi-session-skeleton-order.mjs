/**
 * multi-session-skeleton-order.mjs — replacing the PROJECT skeleton must
 * re-order each session's keypoints by node NAME, never rename their columns.
 *
 * A project has ONE skeleton shared by every session (`setProjectSkeleton`),
 * and every keypoint is stored by column. Every path that replaced it with a
 * skeleton from elsewhere swapped the NAMES and left each session's COLUMNS
 * alone, so a session stored in another node order was silently mis-named —
 * geometry by column fine, everything by name (labels, node weights, the
 * ID-switch checks) wrong:
 *
 *   - Load Multiple Sessions (`handleLoadMultiSession`): each session's load
 *     ended in `setProjectSkeleton(<its first camera's>)`, so on the EAGER
 *     path the LAST session named every session's columns; on the LAZY path
 *     each session kept a skeleton of its own;
 *   - the "Import skeleton for all sessions" prompt that follows it;
 *   - a parent-folder `skeleton.json`, and a session folder's own;
 *   - Load Skeleton (Skeleton tab).
 *
 * Now the first session's skeleton is the project's and later sessions are
 * re-ordered into it as they load; a skeleton applied later re-orders every
 * session that has the same names in another order and WARNS, naming the
 * session, where the names differ. A lazy session's store is re-ordered and
 * the order recorded, so the multi-session save's pass-2 re-open repeats it.
 *
 * Fixtures: tests/fixtures/slp-nested-skeleton/ (see its make_fixture.py) —
 * `back`/`mid` in the canonical mouse order, `side` the same names REVERSED,
 * `top` with `Nose` renamed `Snout`. Each keypoint's coordinates encode its
 * node NAME (x = 100*(canon+1) + 1000*track, y = 10*frame + canon), so every
 * point is checked against the name it is read under.
 *
 *   1. Load Multiple Sessions, eager: s1 [back, mid], s2 [top], s3 [side].
 *      One shared skeleton, s1's; s3 re-ordered into it; s2 warned about;
 *      then Load Skeleton (the real button) with the REVERSED skeleton
 *      re-orders all three sessions into it.
 *   2. Load Multiple Sessions + the prompt (the real "Choose Skeleton File…").
 *   3. A parent-folder skeleton.json, reversed; and a MIDDLE session
 *      folder's own, which the sessions after it must load into.
 *   4. Load Multiple Sessions, lazy: shared skeleton, s2's store re-ordered.
 *   5. A session folder's own skeleton.json, eager and lazy.
 *   6. The multi-session streaming save of a lazy session re-ordered by
 *      adoption, read back raw — and a negative control with the recorded
 *      order dropped before pass 2, which must come back mis-named.
 *
 * §1–§5 fail on the pre-fix build (it mis-names s1 and s2 in §1, each lazy
 * session keeps its own skeleton in §4, and nothing is re-ordered or warned
 * about in §1–§3, §5). Run: node tests/e2e/multi-session-skeleton-order.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8296);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const CANON = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0',
    'Tail_1', 'Tail_2', 'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
const REV = CANON.slice().reverse();
const N_POINTS = 4 * 2 * 15 + 15 - 1;   // per camera: 4 frames x 2 predictions + 1 user instance, 1 NaN

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

// Installed on every fresh page: fixtures, a stubbed directory picker, and a
// by-name checker over a session's eager frames or its lazy store.
async function installHelpers(page) {
    await page.evaluate(async ({ CANON }) => {
        const FILE = { back: 'back-nested', mid: 'mid-flat', side: 'side-reordered', top: 'top-renamed' };
        const bytes = {};
        for (const cam of Object.keys(FILE)) {
            const res = await fetch('tests/fixtures/slp-nested-skeleton/' + FILE[cam] + '.slp');
            bytes[cam] = new Uint8Array(await res.arrayBuffer());
        }
        const video = new Uint8Array(await (await fetch('tests/fixtures/barcode-60/barcode-60.mp4')).arrayBuffer());
        const tri = await import('./pose/triangulation.js');
        const pad = new Uint8Array(tri.LAZY_SLP_THRESHOLD + (1 << 20));
        const canon = n => CANON.indexOf(n === 'Snout' ? 'Nose' : n);
        const toml = cams => cams.map((cn, i) => '[cam_' + i + ']\nname = "' + cn + '"\nsize = [64, 64]\n'
            + 'matrix = [[600.0, 0.0, 32.0], [0.0, 600.0, 32.0], [0.0, 0.0, 1.0]]\n'
            + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\n'
            + 'rotation = [0.0, ' + (0.2 * i) + ', 0.0]\ntranslation = [' + (15 * i) + ', 0.0, 0.0]\n\n').join('');
        const fileH = (name, data, type) => ({ kind: 'file', name,
            getFile: async () => new File(Array.isArray(data) ? data : [data], name, { type: type || 'application/octet-stream' }) });
        const dirH = (name, entries) => ({ kind: 'directory', name,
            [Symbol.asyncIterator]: async function* () { for (const e of entries) yield [e.name, e]; } });
        const sessionDir = (name, cams, opts) => dirH(name, [
            fileH('calibration.toml', toml(cams), 'text/plain'),
            ...(opts && opts.skeletonJson ? [fileH('skeleton.json', opts.skeletonJson, 'application/json')] : []),
            ...cams.map(cam => dirH(cam, [fileH(cam + '.mp4', video, 'video/mp4'),
                fileH(cam + '.predictions.slp', opts && opts.lazy ? [bytes[cam], pad] : bytes[cam])])),
        ]);
        // The same as plain File objects, for handleLoadSessionFolderPerCamera.
        const folderFiles = (name, cams, opts) => {
            const mk = (data, rel, type) => {
                const f = new File(Array.isArray(data) ? data : [data], rel.split('/').pop(), { type: type || 'application/octet-stream' });
                Object.defineProperty(f, 'webkitRelativePath', { value: rel });
                return f;
            };
            const files = [mk(toml(cams), name + '/calibration.toml', 'text/plain')];
            if (opts && opts.skeletonJson) files.push(mk(opts.skeletonJson, name + '/skeleton.json', 'application/json'));
            for (const cam of cams) {
                files.push(mk(new Uint8Array(16), name + '/' + cam + '/' + cam + '.mp4', 'video/mp4'));
                files.push(mk(opts && opts.lazy ? [bytes[cam], pad] : bytes[cam], name + '/' + cam + '/' + cam + '.predictions.slp'));
            }
            return files;
        };
        const skJson = async (nodes) => {
            const { buildSkeletonJSON } = await import('./import-export/skeleton-json.js');
            const { Skeleton } = await import('./pose/pose-data.js');
            const edges = [['TTI', 'Head'], ['Head', 'Nose'], ['Head', 'Neck']].map(([a, b]) =>
                [nodes.indexOf(a) >= 0 ? nodes.indexOf(a) : nodes.indexOf('Snout'), nodes.indexOf(b) >= 0 ? nodes.indexOf(b) : nodes.indexOf('Snout')]);
            return JSON.stringify(buildSkeletonJSON(new Skeleton('Skeleton-0', nodes, edges)));
        };

        // Every point of `cams` in session `s`, read under `nodes`, must sit
        // at its node name's coordinates. Eager: frameGroups. Lazy: the store
        // as the loader materializes it.
        function checkPoint(name, x, y, track, frame, out, where) {
            out.points++;
            const c = canon(name);
            if (x !== 100 * (c + 1) + 1000 * track || y !== 10 * frame + c) {
                if (out.bad.length < 4) out.bad.push(where + ' ' + name + ' at (' + x + ',' + y + ')');
            }
        }
        function sessionPoints(s, cams, nodes) {
            nodes = nodes || s.skeleton.nodes;
            const out = { points: 0, bad: [] };
            const trackOf = idx => Number(String(s.tracks[idx]).slice(-1));
            if (s.lazyLoader) {
                for (let f = 0; f < 4; f++) {
                    const fm = s.lazyLoader.getFrameSync(f);
                    for (const cam of cams) for (const inst of (fm && fm.get(cam)) || []) {
                        inst.points.forEach((p, k) => { if (p) checkPoint(nodes[k], p[0], p[1], trackOf(inst.trackIdx), f, out, s.name + '/' + cam + '@' + f); });
                    }
                }
                return out;
            }
            for (const [f, fg] of s.frameGroups) {
                for (const cam of cams) {
                    const list = (fg.instances.get(cam) || []).slice();
                    for (const u of (fg.getUnlinkedInstances(cam) || [])) if (u && u.instance) list.push(u.instance);
                    for (const inst of list) for (let k = 0; k < nodes.length; k++) {
                        if (inst.hasPoint(k)) checkPoint(nodes[k], inst.getX(k), inst.getY(k), trackOf(inst.trackIdx), f, out, s.name + '/' + cam + '@' + f);
                    }
                }
            }
            return out;
        }
        const status = () => ({ text: document.getElementById('statusText').textContent,
            kind: document.getElementById('statusDot').className });
        window.__T = { bytes, dirH, fileH, sessionDir, folderFiles, skJson, sessionPoints, status };
    }, { CANON });
}

async function freshPage(browser, errs) {
    const page = await browser.newPage();
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 30000 });
    await installHelpers(page);
    return page;
}

/** Start Load Multiple Sessions over `tree` (built in the page by `build`). */
async function startMultiLoad(page, build, arg) {
    await page.evaluate(async ({ build, arg }) => {
        const loader = await import('./loading/session-loader.js');
        const tree = await (new Function('T', 'arg', 'return (async () => ' + build + ')()'))(window.__T, arg);
        window.showDirectoryPicker = async () => tree;
        window.__multiDone = loader.handleLoadMultiSession();
    }, { build, arg });
}

/** Per session: name, skeleton identity, nodes, and every point checked by name. */
async function inspect(page, camsBySession, nodesOverride) {
    return page.evaluate(({ camsBySession, nodesOverride }) => {
        const AS = window.__lucid.state;
        const ss = AS.sessions;
        return {
            names: ss.map(s => s.name),
            shared: ss.every(s => s.skeleton === ss[0].skeleton),
            nodes: ss.map(s => s.skeleton.nodes.slice()),
            lazy: ss.map(s => !!s.lazyLoader),
            target: ss.map(s => s.lazyLoader ? s.lazyLoader.targetNodeOrder : null),
            points: ss.map(s => window.__T.sessionPoints(s, camsBySession[s.name] || [], nodesOverride)),
            status: window.__T.status(),
        };
    }, { camsBySession, nodesOverride: nodesOverride || null });
}

function checkAllPoints(x, label, perCam) {
    x.points.forEach((p, i) => {
        if (!(x.names[i] in perCam)) return;
        const want = perCam[x.names[i]] * N_POINTS;
        check(p.points === want && p.bad.length === 0,
            `${label}: ${x.names[i]} — all ${p.points}/${want} points under their own names` + (p.bad.length ? ` — e.g. ${p.bad.join('; ')}` : ''));
    });
}

try {
    const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const errs = [];

    // =================================================================
    console.log('\n1. Load Multiple Sessions (eager): s1 [back, mid], s2 [top], s3 [side]');
    // =================================================================
    {
        const page = await freshPage(browser, errs);
        await startMultiLoad(page, `T.dirH('parent', [T.sessionDir('s1', ['back', 'mid']),
            T.sessionDir('s2', ['top']), T.sessionDir('s3', ['side'])])`);
        await page.waitForSelector('#msSkelSkip', { timeout: 60000 });
        const x = await inspect(page, { s1: ['back', 'mid'], s2: ['top'], s3: ['side'] });
        check(eq(x.names, ['s1', 's2', 's3']) && x.lazy.every(l => !l), 'three eager sessions');
        check(x.shared, 'every session shares ONE skeleton object');
        check(eq(x.nodes[0], CANON), `the project skeleton is the FIRST session's (got ${x.nodes[0].slice(0, 3).join(',')}...)`);
        checkAllPoints(x, 'after load', { s1: 2, s2: 1, s3: 1 });
        check(/skeleton nodes differ from session s1's in s2\/top/.test(x.status.text) && /warning/.test(x.status.kind),
            `s2/top (renamed node) is warned about, naming session and camera (${x.status.text})`);
        check(!/s3/.test(x.status.text), 's3 (same names, reversed) is re-ordered, not warned about');
        await page.click('#msSkelSkip');
        // Its sessions have different camera sets, so their calibrations
        // differ and the multi-session calibration note follows the prompt.
        await page.waitForSelector('#btnCalibNoticeOk', { timeout: 10000 });
        await page.click('#btnCalibNoticeOk');
        await page.evaluate(() => window.__multiDone);

        // Load Skeleton (Skeleton tab) with the same names REVERSED: every
        // session is re-ordered into it, s2 included (its columns are the
        // project's, by column), and nothing is renamed in place.
        const json = await page.evaluate(n => window.__T.skJson(n), REV);
        await page.click('.panel-tab[data-tab="tabSkeleton"]');
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btnLoadSkeleton')]);
        await chooser.setFiles({ name: 'reversed.json', mimeType: 'application/json', buffer: Buffer.from(json) });
        await page.waitForSelector('#oneSkelConfirm', { timeout: 10000 });
        await page.click('#oneSkelConfirm');
        await page.waitForFunction(() => /Loaded skeleton for all sessions/.test(document.getElementById('statusText').textContent));
        const y = await inspect(page, { s1: ['back', 'mid'], s2: ['top'], s3: ['side'] });
        check(y.shared && eq(y.nodes[0], REV), 'Load Skeleton: the reversed skeleton is the project\'s');
        checkAllPoints(y, 'Load Skeleton', { s1: 2, s2: 1, s3: 1 });
        check(/re-ordered s1, s2, s3 into its node order by name/.test(y.status.text) && /success/.test(y.status.kind),
            `Load Skeleton: the status names the re-ordered sessions (${y.status.text})`);
        await page.close();
    }

    // =================================================================
    console.log('\n2. Load Multiple Sessions, then "Choose Skeleton File…" in the prompt');
    // =================================================================
    {
        const page = await freshPage(browser, errs);
        await startMultiLoad(page, `T.dirH('parent', [T.sessionDir('s1', ['back', 'mid']), T.sessionDir('s2', ['side'])])`);
        await page.waitForSelector('#msSkelChoose', { timeout: 60000 });
        const json = await page.evaluate(n => window.__T.skJson(n), REV);
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#msSkelChoose')]);
        await chooser.setFiles({ name: 'reversed.json', mimeType: 'application/json', buffer: Buffer.from(json) });
        await page.waitForFunction(() => /Applied skeleton to all/.test(document.getElementById('statusText').textContent));
        await page.evaluate(() => window.__multiDone);
        const x = await inspect(page, { s1: ['back', 'mid'], s2: ['side'] });
        check(x.shared && eq(x.nodes[0], REV), 'the chosen (reversed) skeleton is every session\'s');
        checkAllPoints(x, 'prompt', { s1: 2, s2: 1 });
        check(/re-ordered s1, s2 into its node order by name/.test(x.status.text) && /success/.test(x.status.kind),
            `the status names the re-ordered sessions (${x.status.text})`);

        // The same prompt with a skeleton whose names DIFFER warns and applies
        // by column — never guesses a correspondence.
        await page.evaluate(async () => {
            const { promptImportSkeletonForAllSessions } = await import('./ui/info-panel.js');
            promptImportSkeletonForAllSessions();
        });
        const renamed = await page.evaluate(n => window.__T.skJson(n), REV.map(n => n === 'Nose' ? 'Snout' : n));
        const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#msSkelChoose')]);
        await chooser2.setFiles({ name: 'renamed.json', mimeType: 'application/json', buffer: Buffer.from(renamed) });
        await page.waitForSelector('#msSkelChoose', { state: 'detached', timeout: 10000 });
        const y = await inspect(page, { s1: ['back', 'mid'], s2: ['side'] });
        check(/node names differ in s1, s2 — applied by column there/.test(y.status.text) && /warning/.test(y.status.kind),
            `different names warn, naming every session (${y.status.text})`);
        checkAllPoints(y, 'renamed, by column', { s1: 2, s2: 1 });
        await page.close();
    }

    // =================================================================
    console.log('\n3. A parent-folder skeleton.json (reversed)');
    // =================================================================
    {
        const page = await freshPage(browser, errs);
        const json = await page.evaluate(n => window.__T.skJson(n), REV);
        await startMultiLoad(page, `T.dirH('parent', [T.fileH('skeleton.json', arg, 'application/json'),
            T.sessionDir('s1', ['back', 'mid']), T.sessionDir('s2', ['side'])])`, json);
        await page.evaluate(() => window.__multiDone);
        const x = await inspect(page, { s1: ['back', 'mid'], s2: ['side'] });
        check(x.shared && eq(x.nodes[0], REV), 'the parent skeleton.json is every session\'s');
        checkAllPoints(x, 'parent skeleton.json', { s1: 2, s2: 1 });
        check(/Loaded skeleton from skeleton\.json for all 2 sessions — re-ordered s1, s2 into its node order by name/.test(x.status.text),
            `the status names the re-ordered sessions (${x.status.text})`);
        await page.close();
    }

    // =================================================================
    console.log('\n3b. A MIDDLE session folder\'s own skeleton.json (reversed): s1, s2 + json, s3');
    // =================================================================
    // s2's skeleton.json replaces the project skeleton mid-load; s3 must then
    // load into THAT one, not the skeleton s1 started the project with.
    {
        const page = await freshPage(browser, errs);
        const json = await page.evaluate(n => window.__T.skJson(n), REV);
        await startMultiLoad(page, `T.dirH('parent', [T.sessionDir('s1', ['back', 'mid']),
            T.sessionDir('s2', ['side'], { skeletonJson: arg }), T.sessionDir('s3', ['mid'])])`, json);
        await page.waitForSelector('#msSkelSkip', { timeout: 60000 });
        await page.click('#msSkelSkip');
        await page.evaluate(() => window.__multiDone);
        const x = await inspect(page, { s1: ['back', 'mid'], s2: ['side'], s3: ['mid'] });
        check(x.shared && eq(x.nodes[0], REV), `s2's skeleton.json is the project's at the end (got ${x.nodes[0].slice(0, 3).join(',')}...)`);
        checkAllPoints(x, 'middle skeleton.json', { s1: 2, s2: 1, s3: 1 });
        await page.close();
    }

    // =================================================================
    console.log('\n4. Load Multiple Sessions (lazy): s1 [back, mid], s2 [side], s3 [back]');
    // =================================================================
    {
        const page = await freshPage(browser, errs);
        await startMultiLoad(page, `T.dirH('parent', [T.sessionDir('s1', ['back', 'mid'], { lazy: true }),
            T.sessionDir('s2', ['side'], { lazy: true }), T.sessionDir('s3', ['back'], { lazy: true })])`);
        await page.waitForSelector('#msSkelSkip', { timeout: 60000 });
        await page.click('#msSkelSkip');
        await page.evaluate(() => window.__multiDone);
        // Switching back to s1 at the end of the load evicts the session it
        // left (s3), so s2 — re-ordered, and still holding its loader — is the
        // one under test.
        const x = await inspect(page, { s1: ['back', 'mid'], s2: ['side'] });
        check(x.lazy[0] && x.lazy[1], 's1 and s2 loaded lazily');
        check(x.shared, `every session shares ONE skeleton object (pre-fix each lazy session kept its own)`);
        check(eq(x.nodes[0], CANON), 'the project skeleton is the first session\'s');
        check(eq(x.target[1], CANON), 's2\'s loader records the project order (what the save re-open repeats)');
        checkAllPoints(x, 'lazy load', { s1: 2, s2: 1 });
        await page.close();
    }

    // =================================================================
    console.log('\n5. A session folder\'s own skeleton.json (reversed), eager and lazy');
    // =================================================================
    {
        const page = await freshPage(browser, errs);
        const r = await page.evaluate(async (REV) => {
            const loader = await import('./loading/session-loader.js');
            const AS = await import('./ui/app-state.js');
            const json = await window.__T.skJson(REV);
            const out = {};
            for (const lazy of [false, true]) {
                AS.state.sessions = []; AS.state.activeSessionIdx = 0;
                AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
                await loader.handleLoadSessionFolderPerCamera(
                    window.__T.folderFiles('sess', ['back', 'mid', 'side'], { lazy, skeletonJson: json }), true);
                const s = AS.state.session;
                out[lazy ? 'lazy' : 'eager'] = { lazy: !!s.lazyLoader, nodes: s.skeleton.nodes.slice(),
                    target: s.lazyLoader ? s.lazyLoader.targetNodeOrder : null,
                    ...window.__T.sessionPoints(s, ['back', 'mid', 'side']), status: window.__T.status() };
            }
            return out;
        }, REV);
        for (const k of ['eager', 'lazy']) {
            const x = r[k];
            check(x.lazy === (k === 'lazy') && eq(x.nodes, REV), `${k}: the folder's skeleton.json is the session's`);
            check(x.points === 3 * N_POINTS && x.bad.length === 0,
                `${k}: all ${x.points} points under their own names` + (x.bad.length ? ` — e.g. ${x.bad.join('; ')}` : ''));
            check(/skeleton from skeleton\.json: re-ordered sess into its node order by name/.test(x.status.text),
                `${k}: the final status says so (${x.status.text})`);
        }
        check(eq(r.lazy.target, REV), 'lazy: the loader records the new order');
        await page.close();
    }

    // =================================================================
    console.log('\n6. Multi-session streaming save of a re-ordered lazy session');
    // =================================================================
    {
        const page = await freshPage(browser, errs);
        const r = await page.evaluate(async ({ CANON }) => {
            const pd = await import('./pose/pose-data.js');
            const { SioLazyLoader } = await import('./loading/sio-lazy-loader.js');
            const AS = await import('./ui/app-state.js');
            const saveLoad = await import('./import-export/save-load.js');
            const { adoptProjectSkeleton } = await import('./ui/info-panel.js');
            if (typeof adoptProjectSkeleton !== 'function') return { missing: true };   // the pre-fix build
            const { Skeleton, Camera, Session } = pd;
            const SIO = window.SleapIO;
            const canon = n => CANON.indexOf(n === 'Snout' ? 'Nose' : n);

            async function build() {
                const sessions = [], views = [], videoFiles = [];
                for (const [name, cam] of [['sA', 'back'], ['sB', 'side']]) {
                    const L = new SioLazyLoader();
                    await L.open(cam, new File([window.__T.bytes[cam]], cam + '.slp'));
                    const mtx = [[600, 0, 32], [0, 600, 32], [0, 0, 1]];
                    const s = new Session([new Camera(cam, mtx, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [64, 64])],
                        new Skeleton(L.skeleton.name, L.skeleton.nodes.slice(), L.skeleton.edges), L.trackNames.slice(), name);
                    s.lazyLoader = L;
                    sessions.push(s);
                    views.push({ name: cam, videoWidth: 64, videoHeight: 64, frameCount: 4 });
                    videoFiles.push({ name: cam, assignedCamera: cam, videoPath: cam + '.mp4' });
                }
                AS.state.sessions = sessions; AS.state.session = sessions[0]; AS.state.activeSessionIdx = 0;
                AS.state.views = views; AS.state.videoFiles = videoFiles;
                return sessions;
            }
            async function saveAndRead(dropOrder) {
                const sessions = await build();
                const before = sessions[1].skeleton.nodes.slice();
                const adopted = adoptProjectSkeleton(new Skeleton('Skeleton-0', CANON.slice(), [[3, 5]]));
                const handle = saveLoad.beginMultiSessionSave();
                for (const s of sessions) await saveLoad.commitSessionForMultiSessionSave(handle, s);
                const recorded = handle.pending.map(p => p.nodeOrder);
                if (dropOrder) handle.pending.forEach(p => { p.nodeOrder = null; });
                const bytes = await saveLoad.finalizeMultiSessionSave(handle);
                const raw = await SIO.readSlpStreaming(new File([bytes], 'multi.slp'), {
                    openVideos: false, h5wasmUrl: new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href,
                });
                const nodes = raw.skeletons[0].nodeNames;
                const out = { before, adopted: adopted.text, recorded, nodes, points: 0, bad: [] };
                for (const lf of raw.labeledFrames) {
                    const cam = String(lf.video.filename).replace(/\.mp4$/, '');
                    for (const inst of lf.instances) {
                        const t = Number(String(inst.track ? inst.track.name : '').slice(-1));
                        inst.points.forEach((p, k) => {
                            const x = p.xy[0], y = p.xy[1];
                            if (!Number.isFinite(x)) return;
                            out.points++;
                            const c = canon(nodes[k]);
                            if (x !== 100 * (c + 1) + 1000 * t || y !== 10 * lf.frameIdx + c) {
                                if (out.bad.length < 4) out.bad.push(cam + '@' + lf.frameIdx + ' ' + nodes[k] + ' at (' + x + ',' + y + ')');
                            }
                        });
                    }
                }
                return out;
            }
            return { good: await saveAndRead(false), control: await saveAndRead(true) };
        }, { CANON });
        check(!r.missing, 'adoptProjectSkeleton exists');
        const g = r.good || { recorded: [], bad: [] }, control = r.control || { bad: [] };
        check(eq(g.before, REV) && /re-ordered sB into its node order by name/.test(g.adopted),
            `sB (stored reversed) is re-ordered by adoption (${g.adopted})`);
        check(g.recorded[0] === null && eq(g.recorded[1], CANON), 'pass 1 records sB\'s node order for the re-open (sA has none)');
        check(eq(g.nodes, CANON), 'the saved file\'s skeleton is the project\'s');
        check(g.points === 2 * N_POINTS && g.bad.length === 0,
            `every saved point is under its own name — both sessions (${g.points} points)` + (g.bad.length ? ` — e.g. ${g.bad.join('; ')}` : ''));
        check(control.bad.length > 0,
            `negative control: dropping the recorded order before pass 2 writes sB mis-named (${control.bad[0] || 'no error found'})`);
        await page.close();
    }

    check(errs.length === 0, `no page/console errors (got ${JSON.stringify(errs.slice(0, 3))})`);
    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
