/**
 * slp-nested-skeleton.mjs — a `.slp` whose skeleton entry is NESTED under
 * `nx_graph` must load with its keypoint columns named after the right nodes
 * and with its edges, through every reader and through the per-camera folder
 * loader; and a camera whose file orders the same nodes differently must be
 * re-ordered onto the session skeleton, not loaded by column under another
 * file's names.
 *
 * Found on real data (`2022-10-07/10072022142111`, the `back` camera, a SLEAP
 * 1.2.9 file): both readers — the raw worker (`parseSlpH5`,
 * loading/slp-import-worker.js) and sleap-io.js (`parseSkeletons`, behind
 * `parseSlpViaSleapIO` and `SioLazyLoader`) — read `skeletons[0].nodes` /
 * `.links` only. A nested entry has neither, so they fell back to the GLOBAL
 * node order and no edges. `back` is the first camera parsed, so the whole
 * session took that skeleton: every node name wrong, no edges, while geometry
 * by column stayed consistent — tracking and triangulation looked fine.
 *
 * Fixtures (`tests/fixtures/slp-nested-skeleton/`, see its make_fixture.py):
 *   back-nested     NESTED, the real file's global order — the bug
 *   mid-flat        FLAT, another global order, same columns
 *   side-reordered  FLAT, the columns REVERSED (same names)
 *   top-renamed     FLAT, `Nose` renamed `Snout` (no by-name remap exists)
 * Each keypoint's coordinates encode its node NAME (x = 100*(canon+1) +
 * 1000*track, y = 10*frame + canon), so "is column i named right?" is checked
 * directly on every point, not inferred from the skeleton alone. Every file
 * also has two symmetric pairs, the later ones spelled `{"py/id": 2}`.
 *
 * Asserted:
 *   1. both readers, on every fixture: node names in COLUMN order, the 14 BODY
 *      edges (symmetries excluded), and every point under its own name;
 *   2. `SioLazyLoader` alone, and over all four cameras in several open
 *      orders: the session skeleton is the first camera BY NAME's (`back`),
 *      `side`'s store is re-ordered (every materialized point under its own
 *      name), `top` is reported in `nodeOrderMismatches`, whatever the order;
 *   3. the per-camera folder loader, EAGER: a folder whose first camera is the
 *      nested one gets the right skeleton and edges, `side` re-ordered, a
 *      clean status; a folder whose first camera is `side` gets `side`'s order
 *      and the others are re-ordered into it; adding `top` warns, naming it;
 *   4. the same folder LAZY (zero-padded past the threshold): same skeleton,
 *      every hydrated point under its own name, the same warning.
 *
 * Confirmed to fail on the pre-fix build. Run: node tests/e2e/slp-nested-skeleton.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8291);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 30000 });

    const r = await page.evaluate(async () => {
        const fio = await import('/import-export/file-io.js');
        const loader = await import('/loading/session-loader.js');
        const AS = await import('/ui/app-state.js');
        const tri = await import('/pose/triangulation.js');
        const { SioLazyLoader } = await import('/loading/sio-lazy-loader.js');

        const CANON = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0',
            'Tail_1', 'Tail_2', 'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
        const BODY = [['TTI', 'Head'], ['TTI', 'Tail_0'], ['TTI', 'Tail_1'], ['TTI', 'Tail_2'],
            ['TTI', 'Haunch_left'], ['TTI', 'Haunch_right'], ['TTI', 'Trunk'], ['TTI', 'TailTip'],
            ['Head', 'Nose'], ['Head', 'Neck'], ['Head', 'Shoulder_left'], ['Head', 'Shoulder_right'],
            ['Head', 'Ear_R'], ['Head', 'Ear_L']];
        const canon = n => CANON.indexOf(n === 'Snout' ? 'Nose' : n);
        const COLUMNS = {
            back: CANON, mid: CANON, side: CANON.slice().reverse(),
            top: CANON.map(n => n === 'Nose' ? 'Snout' : n),
        };
        const FILE = { back: 'back-nested', mid: 'mid-flat', side: 'side-reordered', top: 'top-renamed' };
        const N_POINTS = 4 * 2 * 15 + 15 - 1;   // 4 frames x 2 predictions + 1 user instance, 1 NaN

        const bytes = {};
        for (const cam of Object.keys(FILE)) {
            const res = await fetch('/tests/fixtures/slp-nested-skeleton/' + FILE[cam] + '.slp');
            bytes[cam] = new Uint8Array(await res.arrayBuffer());
        }
        function mkFile(bits, relPath, type) {
            const f = new File(bits, relPath.split('/').pop(), { type: type || 'application/octet-stream' });
            Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
            return f;
        }
        const edgeKey = (nodes, edges) => edges.map(([a, b]) => nodes[a] + '-' + nodes[b]).sort().join(',');
        const bodyKey = (cam) => BODY.map(([a, b]) => (cam === 'top' && a === 'Nose' ? 'Snout' : a) + '-'
            + (cam === 'top' && b === 'Nose' ? 'Snout' : b)).sort().join(',');

        // Every finite point must sit at its node NAME's coordinates.
        function checkPoint(name, x, y, track, frame, bad, where) {
            const c = canon(name);
            if (x !== 100 * (c + 1) + 1000 * track || y !== 10 * frame + c) {
                if (bad.length < 4) bad.push(where + ' ' + name + ' at (' + x + ',' + y + ')');
                return false;
            }
            return true;
        }
        function checkSlpData(data, cam) {
            const nodes = data.skeleton.nodes;
            const out = { nodes, edgesOk: edgeKey(nodes, data.skeleton.edges) === bodyKey(cam),
                nEdges: data.skeleton.edges.length, points: 0, bad: [] };
            for (const fr of data.frames || []) {
                const f = fr.frameIdx !== undefined ? fr.frameIdx : fr.frame_idx;
                for (const inst of fr.instances || []) {
                    const t = inst.trackIdx !== undefined ? inst.trackIdx : inst.track_idx;
                    (inst.points || []).forEach((p, k) => {
                        if (!p) return;
                        out.points++;
                        checkPoint(nodes[k], p[0], p[1], t, f, out.bad, cam + '@' + f);
                    });
                }
            }
            return out;
        }

        // ---- 1. Both readers, on every fixture ---------------------------
        const readers = {};
        for (const cam of Object.keys(FILE)) {
            const f = new File([bytes[cam]], FILE[cam] + '.slp');
            readers[cam] = {
                worker: checkSlpData(await fio.parseSlpH5(f), cam),
                sleapio: checkSlpData(await fio.parseSlpViaSleapIO(f), cam),
                want: COLUMNS[cam],
            };
        }

        // ---- 2. SioLazyLoader, alone and over four cameras ---------------
        function lazyPoints(L, sessionNodes, cams) {
            const out = { points: 0, bad: [] };
            for (let f = 0; f < 4; f++) {
                const fm = L.getFrameSync(f);
                for (const cam of cams) {
                    if (cam === 'top') continue;   // mismatch: loaded by column, not checked
                    for (const inst of (fm && fm.get(cam)) || []) {
                        inst.points.forEach((p, k) => {
                            if (!p) return;
                            out.points++;
                            checkPoint(sessionNodes[k], p[0], p[1], inst.trackIdx, f, out.bad, cam + '@' + f);
                        });
                    }
                }
            }
            return out;
        }
        const lazyAlone = {};
        for (const cam of Object.keys(FILE)) {
            const L = new SioLazyLoader();
            await L.open(cam, new File([bytes[cam]], FILE[cam] + '.slp'));
            lazyAlone[cam] = { nodes: L.skeleton.nodes, edgesOk: edgeKey(L.skeleton.nodes, L.skeleton.edges) === bodyKey(cam),
                ...lazyPoints(L, L.skeleton.nodes, cam === 'top' ? [] : [cam]) };
        }
        const ORDERS = [['back', 'mid', 'side', 'top'], ['side', 'back', 'mid', 'top'],
            ['top', 'side', 'mid', 'back'], ['mid', 'top', 'back', 'side']];
        const lazyMulti = [];
        for (const order of ORDERS) {
            const L = new SioLazyLoader();
            for (const cam of order) await L.open(cam, new File([bytes[cam]], FILE[cam] + '.slp'));
            lazyMulti.push({ order, nodes: L.skeleton.nodes, skeletonCam: L.skeletonCam,
                mismatches: Array.from((L.nodeOrderMismatches || new Map()).keys()),   // absent pre-fix
                ...lazyPoints(L, L.skeleton.nodes, order) });
        }

        // ---- 3/4. The per-camera folder loader, eager and lazy -----------
        const pad = new Uint8Array(tri.LAZY_SLP_THRESHOLD + (1 << 20));
        function folder(calibOrder, cams, lazy) {
            let toml = '';
            calibOrder.forEach((cn, i) => {
                toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [64, 64]\n'
                    + 'matrix = [[600.0, 0.0, 32.0], [0.0, 600.0, 32.0], [0.0, 0.0, 1.0]]\n'
                    + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\n'
                    + 'rotation = [0.0, ' + (0.2 * i) + ', 0.0]\ntranslation = [' + (15 * i) + ', 0.0, 0.0]\n\n';
            });
            const files = [mkFile([toml], 'sess/calibration.toml', 'text/plain')];
            for (const cam of cams) {
                // Videos are deferred (never decoded); a camera dir only has to HAVE one.
                files.push(mkFile([new Uint8Array(16)], 'sess/' + cam + '/' + cam + '.mp4', 'video/mp4'));
                files.push(mkFile(lazy ? [bytes[cam], pad] : [bytes[cam]],
                    'sess/' + cam + '/' + cam + '.predictions.slp', 'application/x-hdf5'));
            }
            return files;
        }
        async function loadFolder(calibOrder, cams, lazy) {
            AS.state.sessions = []; AS.state.activeSessionIdx = 0;
            AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
            await loader.handleLoadSessionFolderPerCamera(folder(calibOrder, cams, lazy), true);
            const s = AS.state.session;
            if (lazy) for (let f = 0; f < 4; f++) await tri.ensureLazyFrameData(f);
            const nodes = s.skeleton.nodes.slice();
            const out = { lazy: !!s.lazyLoader, nodes, edgesOk: edgeKey(nodes, s.skeleton.edges) === bodyKey('back'),
                points: 0, bad: [], status: document.getElementById('statusText').textContent,
                statusKind: document.getElementById('statusDot').className };
            for (const [f, fg] of s.frameGroups) {
                for (const cam of cams) {
                    if (cam === 'top') continue;
                    const list = (fg.instances.get(cam) || []).slice();
                    for (const u of (fg.getUnlinkedInstances(cam) || [])) if (u && u.instance) list.push(u.instance);
                    for (const inst of list) {
                        const t = Number(String(s.tracks[inst.trackIdx]).slice(-1));
                        for (let k = 0; k < nodes.length; k++) {
                            if (!inst.hasPoint(k)) continue;
                            out.points++;
                            checkPoint(nodes[k], inst.getX(k), inst.getY(k), t, f, out.bad, cam + '@' + f);
                        }
                    }
                }
            }
            return out;
        }
        const eagerBackFirst = await loadFolder(['back', 'mid', 'side'], ['back', 'mid', 'side'], false);
        const eagerSideFirst = await loadFolder(['side', 'back', 'mid'], ['back', 'mid', 'side'], false);
        const eagerWithTop = await loadFolder(['back', 'top'], ['back', 'top'], false);
        const lazyFolder = await loadFolder(['back', 'mid', 'side', 'top'], ['back', 'mid', 'side', 'top'], true);

        return { CANON, COLUMNS, N_POINTS, readers, lazyAlone, lazyMulti,
            eagerBackFirst, eagerSideFirst, eagerWithTop, lazyFolder };
    });

    const { CANON, COLUMNS, N_POINTS } = r;
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    console.log('\n1. Both readers, every fixture');
    for (const [cam, x] of Object.entries(r.readers)) {
        for (const reader of ['worker', 'sleapio']) {
            const y = x[reader];
            const label = `${cam} (${reader === 'worker' ? 'raw worker' : 'sleap-io.js'})`;
            check(eq(y.nodes, x.want), `${label}: node names in column order` + (eq(y.nodes, x.want) ? '' : ` — got ${y.nodes.slice(0, 4).join(',')}...`));
            check(y.edgesOk, `${label}: the 14 body edges, no symmetries (got ${y.nEdges})`);
            check(y.points === N_POINTS && y.bad.length === 0,
                `${label}: all ${y.points} points under their own names` + (y.bad.length ? ` — e.g. ${y.bad.join('; ')}` : ''));
        }
    }

    console.log('\n2. SioLazyLoader');
    for (const [cam, x] of Object.entries(r.lazyAlone)) {
        check(eq(x.nodes, COLUMNS[cam]) && x.edgesOk, `${cam} alone: column-order names and body edges`);
        if (cam !== 'top') check(x.points === N_POINTS && x.bad.length === 0,
            `${cam} alone: all ${x.points} materialized points under their own names` + (x.bad.length ? ` — e.g. ${x.bad.join('; ')}` : ''));
    }
    for (const x of r.lazyMulti) {
        const label = 'opened ' + x.order.join('>');
        check(eq(x.nodes, CANON) && x.skeletonCam === 'back', `${label}: session skeleton is back's (the first camera by name)`);
        check(x.points === 3 * N_POINTS && x.bad.length === 0,
            `${label}: back/mid/side — all ${x.points} points under their own names (side re-ordered)` + (x.bad.length ? ` — e.g. ${x.bad.join('; ')}` : ''));
        check(eq(x.mismatches, ['top']), `${label}: top reported as a node mismatch (got ${JSON.stringify(x.mismatches)})`);
    }

    console.log('\n3. Per-camera folder loader, eager');
    const eb = r.eagerBackFirst;
    check(!eb.lazy, 'took the eager path');
    check(eq(eb.nodes, CANON), `nested first camera: session.skeleton.nodes in column order (got ${eb.nodes.slice(0, 4).join(',')}...)`);
    check(eb.edgesOk, 'nested first camera: the session has the 14 body edges');
    check(eb.points === 3 * N_POINTS && eb.bad.length === 0,
        `all ${eb.points} points under their own names, side re-ordered` + (eb.bad.length ? ` — e.g. ${eb.bad.join('; ')}` : ''));
    check(/success/.test(eb.statusKind) && !/skeleton/.test(eb.status), `clean status (${eb.status})`);
    const es = r.eagerSideFirst;
    check(eq(es.nodes, COLUMNS.side), 'side first: the session takes side\'s order');
    check(es.points === 3 * N_POINTS && es.bad.length === 0,
        `side first: back and mid re-ordered into it, all ${es.points} points under their own names` + (es.bad.length ? ` — e.g. ${es.bad.join('; ')}` : ''));
    const et = r.eagerWithTop;
    check(eq(et.nodes, CANON) && /skeleton nodes differ from back's in top/.test(et.status) && /warning/.test(et.statusKind),
        `a renamed node warns, naming the camera (${et.status})`);

    console.log('\n4. Per-camera folder loader, lazy');
    const lf = r.lazyFolder;
    check(lf.lazy, 'took the lazy path');
    check(eq(lf.nodes, CANON) && lf.edgesOk, 'session skeleton in column order, with the body edges');
    check(lf.points === 3 * N_POINTS && lf.bad.length === 0,
        `all ${lf.points} hydrated points under their own names, side re-ordered` + (lf.bad.length ? ` — e.g. ${lf.bad.join('; ')}` : ''));
    check(/skeleton nodes differ from back's in top/.test(lf.status) && /warning/.test(lf.statusKind),
        `top warned about (${lf.status})`);

    check(errs.length === 0, `no page/console errors (got ${JSON.stringify(errs.slice(0, 3))})`);
    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
