/**
 * origin-rebase-slp-diff.mjs — what "Set as New Calibration" actually changes
 * INSIDE `project.slp`, measured rather than asserted from reading the writers.
 *
 * The re-base is an in-memory edit: it rewrites `InstanceGroup.points3d`, the
 * plane node pool, each plane's stored fit and every camera, then marks the
 * project dirty. Nothing is written to disk until the user saves. So the
 * question a user actually has — *what will be different in my file?* — is a
 * question about the SAVE, not about the re-base, and the only honest way to
 * answer it is to save the same project twice, once on each side of the
 * operation, and diff the two files.
 *
 * That is what this does:
 *
 *   1. Build a calibrated project: two cameras, user + predicted 3D, a fitted
 *      four-node plane, and an origin defined but NOT yet committed.
 *   2. Save it. This is `project.slp` as it stands today (file A).
 *   3. Run Set as New Calibration.
 *   4. Save it again (file B).
 *   5. Walk every HDF5 dataset in both, compare element by element, and print
 *      the inventory. Then assert what has to be true of the difference.
 *
 * The assertions are the point; the printed report is the deliverable. Both
 * halves matter, because the two failure modes are opposite and equally bad:
 * a save that does NOT carry the re-base strands the project in the old frame
 * with a calibration that no longer matches it, and a save that changes 2D
 * would mean the re-base had moved annotation rather than the coordinate
 * system it is expressed in.
 *
 * Run: node origin-rebase-slp-diff.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8269);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

// A tilted floor, annotated in both views from its exact projections. Same
// staging the origin wizard needs: placed, triangulated, fitted.
const TRUTH = [
    [-40.678, -30.234, 216.588], [40, -30, 220], [40, 30, 225], [-40, 30, 221],
];

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(
        () => window.__lucid && window.__lucid.state && window.SleapIO && window.h5wasm,
        { timeout: 120000 });

    // =================================================================
    // Fixture
    // =================================================================
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Camera, Session, Skeleton, Instance, InstanceGroup, FrameGroup,
            makePoints3d, setPoint3d } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        // Off-axis and off-origin: an axis-aligned rig lets a dropped or
        // transposed rotation pass by coincidence.
        const cams = [
            new Camera('camA', K, [0, 0, 0, 0, 0], [0.05, -0.2, 0.01], [40, -15, 900], [640, 480]),
            new Camera('camB', K, [0, 0, 0, 0, 0], [-0.3, 0.12, 0.4], [-60, 25, 870], [640, 480]),
        ];
        const session = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], 'Diff');

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);

        const gUser = new InstanceGroup(1, -1);
        for (const cn of ['camA', 'camB']) {
            const inst = new Instance([[10, 20], [30, 40]], 0, 'user', 1);
            fg.addInstance(cn, inst);
            gUser.addInstance(cn, inst);
        }
        gUser.points3d = makePoints3d(2);
        setPoint3d(gUser.points3d, 0, [12.5, -7.25, 210]);
        setPoint3d(gUser.points3d, 1, [-40, 33, 195]);

        const gPred = new InstanceGroup(2, -1);
        for (const cn of ['camA', 'camB']) {
            const inst = new Instance([[50, 60], [70, 80]], 0, 'predicted', 0.8);
            fg.addInstance(cn, inst);
            gPred.addInstance(cn, inst);
        }
        gPred.points3d = makePoints3d(2);
        setPoint3d(gPred.points3d, 0, [300, -120, 188]);
        setPoint3d(gPred.points3d, 1, [5, 5, 230]);

        session.instanceGroups.set(0, [gUser, gPred]);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 10;
        AS.state.views = cams.map(c => ({
            name: c.name, videoWidth: 640, videoHeight: 480, frameCount: 10, canvas: null,
        }));
        AS.state.videoFiles = cams.map(c => ({
            name: c.name, assignedCamera: c.name, videoPath: c.name + '.mp4',
        }));
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
    });
    await page.waitForFunction(
        () => window.__lucid.state.views.every(v => !!v.overlayCanvas), { timeout: 10000 });

    await page.evaluate(async (TF) => {
        const P = await import('/ui/plane-definition.js');
        const T = await import('/pose/triangulation.js');
        const AS = await import('/ui/app-state.js');
        const model = P.planeModel();
        const cams = AS.state.session.cameras;

        const floor = P.createPlane('Ground');
        ['origin', 'h1', 'f2', 'f3'].forEach(n => model.createNodeInPlane(n, floor));
        for (let k = 0; k < 4; k++) floor.addEdge(floor.nodeIds[k], floor.nodeIds[(k + 1) % 4]);

        for (const cam of cams) {
            P.placePlaneOnView(floor, cam.name, 320, 240);
            const inst = P.getPlaneInstance(cam.name);
            const idx = floor.nodeIds.map(id => model.pool.indexOf(id));
            TF.forEach((q, k) => { const uv = cam.project(q); inst.setPoint(idx[k], uv[0], uv[1]); });
        }
        P.planeState.selectedPlaneId = floor.id;
        P.enterPlaneMode();
        P.refreshPlanePanel();
        document.getElementById('btnPlaneTriangulate').click();
        const fit = T.fitPlaneToPoints3d(P.planePoints3d(floor));
        floor.planeFit = { centroid: fit.centroid, normal: fit.normal, rms: fit.rms, nPoints: fit.nPoints };
        P.refreshPlanePanel();
        P.syncPlanes3D();
        window.__floorId = floor.id;
    }, TRUTH);

    // An origin defined but NOT committed: this is the state a user is in when
    // they are looking at the Danger Zone deciding whether to press the button.
    await page.evaluate(async () => {
        const O = await import('/ui/origin-definition.js');
        O.enterOriginMode();
        O.pickOriginNode(window.__floorId, 0);
        O.pickOriginAxis('negative');
        O.applyOrigin();
    });

    // A page-side saver, so both files are produced by identical code.
    await page.evaluate(() => {
        window.__saveSlp = async () => {
            const fileio = await import('/import-export/file-io.js');
            const AS = await import('/ui/app-state.js');
            const labels = fileio.buildSlpLabelsAllViews(
                AS.state.session, AS.state.views, AS.state.videoFiles);
            const bytes = await window.SleapIO.saveSlpToBytes(labels);
            return Array.from(bytes);
        };
    });

    // =================================================================
    // 1 — Save, re-base, save again
    // =================================================================
    console.log('\n1. Two saves, one on each side of the re-base');
    const run = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const O = await import('/ui/origin-definition.js');
        const RB = await import('/ui/origin-rebase.js');
        const P = await import('/ui/plane-definition.js');

        const before = await window.__saveSlp();

        // What the frame promises to do, kept so the diff can be checked
        // against the transform rather than against itself.
        const frame = O.originState.frame;
        const R = frame.R.map(r => r.slice());
        const t = frame.translation.slice();

        // Pixels of every finite 3D point, in every camera. The quantity that
        // must not change.
        const pixels = () => {
            const out = [];
            const push = (p) => { for (const cam of AS.state.session.cameras) out.push(cam.project(p)); };
            for (const g of AS.state.session.instanceGroups.get(0)) {
                for (let k = 0; k * 3 < g.points3d.length; k++) {
                    const o = k * 3;
                    if (Number.isNaN(g.points3d[o])) continue;
                    push([g.points3d[o], g.points3d[o + 1], g.points3d[o + 2]]);
                }
            }
            for (const nd of P.planeModel().pool.nodes) {
                if (!Number.isNaN(nd.xyz[0])) push([nd.xyz[0], nd.xyz[1], nd.xyz[2]]);
            }
            return out;
        };
        const pixelsBefore = pixels();

        RB.resetCalibrationHandle();
        let wroteName = null;
        window.showSaveFilePicker = async (opts) => ({
            name: opts.suggestedName,
            createWritable: async () => ({
                write: async () => { wroteName = opts.suggestedName; },
                close: async () => {},
            }),
        });

        document.getElementById('btnSetCalibration').click();
        document.getElementById('btnRebaseContinue').click();
        // Wait for the final STATUS LINE. Keying on the progress modal being
        // absent is not enough: `runSetCalibration` awaits the file picker
        // before it opens one, so "no progress modal" is also true for the
        // first few ticks, and the commit now ends with an auto-save await.
        const statusEl = document.getElementById('statusText') || document.getElementById('status');
        for (let i = 0; i < 400; i++) {
            if (/Set as new calibration/.test((statusEl || {}).textContent || '')) break;
            await new Promise(r => setTimeout(r, 25));
        }

        const pixelsAfter = pixels();
        let worstPixel = 0;
        for (let i = 0; i < pixelsBefore.length; i++) {
            for (let a = 0; a < 2; a++) {
                worstPixel = Math.max(worstPixel, Math.abs(pixelsBefore[i][a] - pixelsAfter[i][a]));
            }
        }

        const after = await window.__saveSlp();
        return {
            before, after, R, t, wroteName, worstPixel, nProbes: pixelsBefore.length,
            dirty: AS.state.isDirty,
        };
    });
    check(run.wroteName === 'calibration-rebased.toml',
        `the calibration went to a new file (got '${run.wroteName}')`);
    check(run.dirty, 'and the project is dirty — the .slp on disk is still the OLD frame until a save');
    check(run.worstPixel < 1e-6,
        `THE INVARIANT still holds in memory: all ${run.nProbes} probes keep their pixel ` +
        `(worst ${run.worstPixel.toExponential(2)} px)`);

    // =================================================================
    // 2 — The dataset-level diff
    // =================================================================
    console.log('\n2. Every HDF5 dataset in the file, before vs after');
    const diff = await page.evaluate(async ({ before, after }) => {
        const h5 = window.h5wasm;
        await h5.ready;

        const open = (bytes, name) => {
            h5.FS.writeFile(name, Uint8Array.from(bytes));
            return new h5.File(name, 'r');
        };
        const A = open(before, '/diff-before.slp');
        const B = open(after, '/diff-after.slp');

        // Every dataset path in the file, depth first. h5wasm exposes `keys()`
        // on a Group and `type` on what `get` hands back.
        const walk = (f, node, prefix, out) => {
            let keys = [];
            try { keys = node.keys(); } catch (e) { return out; }
            for (const k of keys) {
                const full = prefix ? prefix + '/' + k : k;
                let child = null;
                try { child = f.get(full); } catch (e) { continue; }
                if (!child) continue;
                if (child.type === 'Group') walk(f, child, full, out);
                else out.push(full);
            }
            return out;
        };
        const pathsA = walk(A, A, '', []);
        const pathsB = walk(B, B, '', []);

        const readVals = (f, p) => {
            try {
                const d = f.get(p);
                if (!d) return null;
                const v = d.value;
                if (v == null) return null;
                if (typeof v === 'string') return [v];
                if (typeof v === 'number' || typeof v === 'bigint') return [String(v)];
                return Array.from(v, x => (typeof x === 'bigint' ? String(x) : x));
            } catch (e) { return null; }
        };
        // How many ELEMENTS differ, not just whether any do. The two numbers a
        // user asking "how much of my file changes?" needs are different: this
        // one is how much of the data is semantically new, and `bytes` below is
        // how much gets written (all of it — a save rewrites the file).
        const diffCount = (a, b) => {
            if (a === null || b === null) return (a === b) ? 0 : -1;
            if (a.length !== b.length) return -1;
            let d = 0;
            for (let i = 0; i < a.length; i++) {
                const x = a[i], y = b[i];
                if (typeof x === 'number' && Number.isNaN(x) && typeof y === 'number' && Number.isNaN(y)) continue;
                if (x !== y) d++;
            }
            return d;
        };

        const rows = [];
        const union = Array.from(new Set(pathsA.concat(pathsB))).sort();
        for (const p of union) {
            const inA = pathsA.indexOf(p) >= 0, inB = pathsB.indexOf(p) >= 0;
            if (!inA || !inB) {
                rows.push({ path: p, state: !inA ? 'added' : 'removed', n: 0 });
                continue;
            }
            const a = readVals(A, p), b = readVals(B, p);
            const d = diffCount(a, b);
            rows.push({
                path: p, state: d === 0 ? 'same' : 'CHANGED',
                n: a ? a.length : 0, nDiff: d < 0 ? (b ? b.length : 0) : d,
            });
        }

        const pts = (f, p) => readVals(f, p);
        const out = {
            rows,
            points3dA: pts(A, 'session_data/points_3d'),
            points3dB: pts(B, 'session_data/points_3d'),
            predA: pts(A, 'session_data/pred_points_3d'),
            predB: pts(B, 'session_data/pred_points_3d'),
            bytesA: before.length, bytesB: after.length,
        };
        A.close(); B.close();
        return out;
    }, { before: run.before, after: run.after });

    const byState = s => diff.rows.filter(r => r.state === s).map(r => r.path);
    const changed = byState('CHANGED');
    const same = byState('same');

    console.log(`\n     project.slp: ${diff.bytesA.toLocaleString()} B before, ` +
        `${diff.bytesB.toLocaleString()} B after`);
    console.log(`     ${diff.rows.length} datasets — ${changed.length} changed, ` +
        `${same.length} identical, ${byState('added').length} added, ` +
        `${byState('removed').length} removed\n`);
    const pad = (v, w) => String(v).padStart(w);
    console.log('     ' + 'dataset'.padEnd(40) + pad('elements', 10) + pad('changed', 10));
    console.log('     ' + '-'.repeat(60));
    for (const r of diff.rows) {
        const mark = r.state === 'CHANGED' ? '   ~ ' : (r.state === 'same' ? '     ' : '   ' + r.state[0].toUpperCase() + ' ');
        console.log(mark + r.path.padEnd(40) +
            pad(r.n.toLocaleString(), 10) + pad(r.nDiff ? r.nDiff.toLocaleString() : '-', 10));
    }
    const totalEl = diff.rows.reduce((a, r) => a + r.n, 0);
    const totalDiff = diff.rows.reduce((a, r) => a + r.nDiff, 0);
    console.log('     ' + '-'.repeat(60));
    console.log('     ' + 'TOTAL'.padEnd(40) + pad(totalEl.toLocaleString(), 10) +
        pad(totalDiff.toLocaleString(), 10));
    console.log(`\n     ${(100 * totalDiff / totalEl).toFixed(2)}% of the file's stored elements are ` +
        `semantically new \u2014 but a save REWRITES THE WHOLE FILE, so ${diff.bytesB.toLocaleString()} B ` +
        `is what actually gets written.\n`);

    // ---- the 3D moved, and moved by exactly the transform ----
    const applyR = (R, t, p) => [0, 1, 2].map(i =>
        R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2] + t[i]);
    const worstOf = (a, b, stride) => {
        if (!a || !b || a.length !== b.length) return Infinity;
        let worst = 0;
        for (let o = 0; o + 2 < a.length; o += stride) {
            if (Number.isNaN(a[o])) continue;
            const want = applyR(run.R, run.t, [a[o], a[o + 1], a[o + 2]]);
            for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(want[k] - b[o + k]));
        }
        return worst;
    };
    check(changed.indexOf('session_data/points_3d') >= 0,
        'session_data/points_3d is rewritten — the user 3D is in the new frame');
    const worstUser = worstOf(diff.points3dA, diff.points3dB, 3);
    check(worstUser < 1e-6,
        `and by exactly R·p + t, not approximately (worst ${worstUser.toExponential(2)} mm)`);

    // There is ONE 3D table, and this fixture has a predicted group in it. LUCID
    // builds `SIO.Instance3D` for every group regardless of what its 2D members
    // are (`buildSlpLabelsAllViews` / `slp-streaming-write.js`), and the writer
    // only routes to `pred_points_3d` for a `PredictedInstance3D` carrying point
    // scores — so a LUCID project never has one. The user/predicted split the
    // confirmation dialog shows is a provenance label on the LUCID side, not a
    // division on disk. Asserted rather than skipped, because "the dataset was
    // absent so we checked nothing" is how a table quietly stops being covered.
    check(diff.predA === null,
        'there is no session_data/pred_points_3d: LUCID writes one Instance3D per group, ' +
        'so all 3D lands in points_3d whatever its members are');
    check(diff.points3dA.length === 4 * 3,
        `and that one table holds BOTH groups' keypoints (got ${diff.points3dA.length / 3} rows)`);

    // ---- the 2D did NOT move ----
    for (const p of ['points', 'pred_points', 'frames', 'instances']) {
        if (diff.rows.findIndex(r => r.path === p) < 0) continue;
        check(same.indexOf(p) >= 0,
            `/${p} is byte-identical — 2D annotation is invariant under a re-base`);
    }

    // =================================================================
    // 3 — What the file MEANS, read back through the real importer
    // =================================================================
    console.log('\n3. Re-read both files through the app\'s own reader');
    const sem = await page.evaluate(async ({ before, after }) => {
        const fileio = await import('/import-export/file-io.js');
        const read = async (bytes, name) => {
            const d = await fileio.parseSlpViaSleapIO(new File([Uint8Array.from(bytes)], name), () => {});
            const sd = (d.sessions || [])[0] || {};
            const lucid = (sd.metadata && sd.metadata.lucid) || {};
            const cal = sd.calibration || {};
            const camKeys = Object.keys(cal).filter(k => k !== 'metadata').sort();
            return {
                cams: camKeys.map(k => ({
                    name: cal[k].name,
                    rotation: cal[k].rotation,
                    translation: cal[k].translation,
                    matrix: cal[k].matrix,
                    distortions: cal[k].distortions,
                })),
                planeNodes: (lucid.planeNodes || []).map(n => n.xyz || null),
                planeFits: (lucid.planes || []).map(p => p.planeFit || null),
                hasOrigin: Object.prototype.hasOwnProperty.call(lucid, 'planeOrigin'),
                placements: lucid.planePlacements || null,
            };
        };
        return { a: await read(before, 'a.slp'), b: await read(after, 'b.slp') };
    }, { before: run.before, after: run.after });

    const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    check(!eq(sem.a.cams.map(c => c.translation), sem.b.cams.map(c => c.translation)),
        'the EMBEDDED calibration moved with the points — a reopened .slp is self-consistent');
    check(eq(sem.a.cams.map(c => c.matrix), sem.b.cams.map(c => c.matrix)) &&
          eq(sem.a.cams.map(c => c.distortions), sem.b.cams.map(c => c.distortions)),
        'while intrinsics and distortion are untouched — an origin change moves the world, not the lens');
    check(eq(sem.a.cams.map(c => c.name), sem.b.cams.map(c => c.name)),
        'and the camera ORDER is preserved, so a downstream index still means the same camera');
    check(!eq(sem.a.planeNodes, sem.b.planeNodes),
        'metadata.lucid.planeNodes moved — the plane pool is 3D like any other');
    check(!eq(sem.a.planeFits, sem.b.planeFits),
        'and each stored planeFit with it (centroid and normal, transformed differently)');
    check(sem.a.hasOrigin && !sem.b.hasOrigin,
        'metadata.lucid.planeOrigin is GONE after the re-base — the project IS that frame now, ' +
        'so an offset from it would describe a transform that already happened');
    check(eq(sem.a.placements, sem.b.placements),
        'metadata.lucid.planePlacements is unchanged — plane 2D is invariant, same as pose 2D');

    // =================================================================
    // 4 — The reopened file reprojects where the original did
    // =================================================================
    console.log('\n4. The end-to-end invariant, across the file boundary');
    const px = await page.evaluate(async ({ a, b }) => {
        const pd = await import('/pose/pose-data.js');
        const mk = (c) => new pd.Camera(c.name, c.matrix, c.distortions,
            c.rotation, c.translation, [640, 480]);
        // Probe with each file's OWN plane nodes through its OWN cameras: the
        // pixel is what has to agree, not the coordinates.
        let worst = 0, n = 0;
        for (let i = 0; i < a.planeNodes.length; i++) {
            const pa = a.planeNodes[i], pb = b.planeNodes[i];
            if (!pa || !pb || !isFinite(pa[0]) || !isFinite(pb[0])) continue;
            for (let c = 0; c < a.cams.length; c++) {
                const ua = mk(a.cams[c]).project(pa);
                const ub = mk(b.cams[c]).project(pb);
                worst = Math.max(worst, Math.abs(ua[0] - ub[0]), Math.abs(ua[1] - ub[1]));
                n++;
            }
        }
        return { worst, n };
    }, sem);
    check(px.n > 0 && px.worst < 1e-6,
        `every plane node in the SAVED file reprojects to the pixel it did in the original ` +
        `(${px.n} probes, worst ${px.worst.toExponential(2)} px)`);

    // The negative control: the OLD calibration against the NEW points is the
    // exact mistake a leftover calibration.toml causes, and it must be visibly
    // wrong — otherwise the test above would pass on a build that changed
    // nothing at all.
    const ctrl = await page.evaluate(async ({ a, b }) => {
        const pd = await import('/pose/pose-data.js');
        const mk = (c) => new pd.Camera(c.name, c.matrix, c.distortions,
            c.rotation, c.translation, [640, 480]);
        let worst = 0;
        for (let i = 0; i < a.planeNodes.length; i++) {
            const pa = a.planeNodes[i], pb = b.planeNodes[i];
            if (!pa || !pb || !isFinite(pa[0]) || !isFinite(pb[0])) continue;
            for (let c = 0; c < a.cams.length; c++) {
                const ua = mk(a.cams[c]).project(pa);
                const bad = mk(a.cams[c]).project(pb);   // OLD camera, NEW point
                worst = Math.max(worst, Math.abs(ua[0] - bad[0]), Math.abs(ua[1] - bad[1]));
            }
        }
        return worst;
    }, sem);
    check(ctrl > 50,
        `NEGATIVE CONTROL: the OLD calibration against the NEW points is off by ` +
        `${ctrl.toFixed(0)} px — which is what a leftover calibration.toml does, silently`);

    console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} failure(s)`);
} catch (e) {
    console.log('\nFAIL — ' + (e && e.stack ? e.stack : e));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
process.exit(fails === 0 ? 0 : 1);
