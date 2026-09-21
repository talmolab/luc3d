/**
 * set-new-calibration.mjs — the Danger Zone's "Set as New Calibration", end to end.
 *
 * `Export New Calibration` writes a file and changes nothing. This one commits:
 * it overwrites `calibration.toml` AND rewrites every 3D number in the project
 * so the world becomes the defined origin. The whole safety argument is one
 * invariant — **points and cameras move together, so no pixel moves** — and the
 * whole recoverability argument is one ordering: plan, write, then apply, so
 * that a cancel or a failed write leaves the project byte-identical.
 *
 * This file drives the real dialogs. What it covers that the unit test
 * (`tests/test-origin-rebase.mjs`) cannot:
 *
 *  1. The confirmation modal's inventory — the counts the user is shown are the
 *     counts of what actually gets rewritten, split by provenance.
 *  2. Cancel at the confirmation: nothing runs.
 *  3. Cancel MID-FLIGHT, from the progress modal: no file is written and not one
 *     coordinate moves. Driven deterministically (see the note in section 3)
 *     rather than by racing a real click against the plan's yields.
 *  4. The commit: the file is written through a stand-in `FileSystemFileHandle`
 *     — headless Chromium exposes `showSaveFilePicker` but rejects it instantly
 *     with `AbortError`, the same reason `video-encode-streaming.mjs` supplies
 *     its own handle — the 3D is re-based, every probe point keeps its pixel,
 *     and the defined origin collapses so the readout and Danger Zone go away.
 *
 * Run: node set-new-calibration.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8261);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

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
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // =================================================================
    // Fixture: two cameras, some 3D annotation, one fitted plane
    // =================================================================
    //
    // The cameras are deliberately off-axis and off-origin: an axis-aligned rig
    // lets a dropped or transposed rotation pass by coincidence.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Camera, Session, Skeleton, Instance, InstanceGroup, makePoints3d, setPoint3d } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [
            new Camera('camA', K, [0, 0, 0, 0, 0], [0.05, -0.2, 0.01], [40, -15, 900], [640, 480]),
            new Camera('camB', K, [0, 0, 0, 0, 0], [-0.3, 0.12, 0.4], [-60, 25, 870], [640, 480]),
        ];
        const session = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], 'S1');

        // One USER group and one PREDICTED group, so the modal's provenance
        // split has something to separate.
        const gUser = new InstanceGroup(1, 0);
        gUser.addInstance('camA', new Instance([[10, 20], [30, 40]], 0, 'user', 1));
        gUser.addInstance('camB', new Instance([[11, 21], [31, 41]], 0, 'user', 1));
        gUser.points3d = makePoints3d(2);
        setPoint3d(gUser.points3d, 0, [12.5, -7.25, 210]);
        setPoint3d(gUser.points3d, 1, [-40, 33, 195]);

        const gPred = new InstanceGroup(2, 1);
        gPred.addInstance('camA', new Instance([[50, 60], [70, 80]], 1, 'predicted', 0.8));
        gPred.addInstance('camB', new Instance([[51, 61], [71, 81]], 1, 'predicted', 0.8));
        gPred.reprojectedInstances.set('camA', new Instance([[50, 60], [70, 80]], 1, 'reprojected', 1));
        gPred.points3d = makePoints3d(2);
        setPoint3d(gPred.points3d, 0, [300, -120, 188]);
        setPoint3d(gPred.points3d, 1, [5, 5, 230]);
        // node 1 of neither group is NaN here; the NaN case is pinned in the
        // unit test, which can see the raw buffers.

        session.instanceGroups.set(0, [gUser, gPred]);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 10;
        AS.state.views = cams.map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480, canvas: null }));
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
    });
    await page.waitForFunction(
        () => window.__lucid.state.views.every(v => !!v.overlayCanvas), { timeout: 10000 });

    // A tilted floor, annotated in both views from its exact projections, then
    // triangulated and fitted — the same staging the origin wizard needs.
    const TRUTH = [
        [-40.678, -30.234, 216.588], [40, -30, 220], [40, 30, 225], [-40, 30, 221],
    ];
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

    // Apply an origin at the "origin" corner.
    await page.evaluate(async () => {
        const O = await import('/ui/origin-definition.js');
        O.enterOriginMode();
        O.pickOriginNode(window.__floorId, 0);
        O.pickOriginAxis('negative');
        O.applyOrigin();
    });

    // A page-side snapshot helper, so before/after comparisons are made on the
    // same code both times.
    await page.evaluate(() => {
        window.__snap = async () => {
            const AS = await import('/ui/app-state.js');
            const P = await import('/ui/plane-definition.js');
            const sess = AS.state.session;
            const gs = sess.instanceGroups.get(0);
            return JSON.stringify({
                pts: gs.map(g => Array.from(g.points3d)),
                nodes: P.planeModel().pool.nodes.map(nd => Array.from(nd.xyz)),
                fit: P.planeModel().planes.map(p => p.planeFit
                    ? [p.planeFit.centroid.slice(), p.planeFit.normal.slice()] : null),
                cams: sess.cameras.map(c => [c.rvec.slice(), c.tvec.slice()]),
            });
        };
        // Pixel positions of every finite 3D point, in every camera. This is the
        // quantity that must not change.
        window.__pixels = async () => {
            const AS = await import('/ui/app-state.js');
            const P = await import('/ui/plane-definition.js');
            const sess = AS.state.session;
            const out = [];
            const push = (p) => {
                for (const cam of sess.cameras) out.push(cam.project(p));
            };
            for (const g of sess.instanceGroups.get(0)) {
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
    });

    // =================================================================
    // 1 — The confirmation modal's inventory
    // =================================================================
    console.log('\n1. The warning modal');
    let m = await page.evaluate(async () => {
        document.getElementById('btnSetCalibration').click();
        const dlg = document.getElementById('originRebaseConfirm');
        const rows = Array.from(document.querySelectorAll('#originRebaseCounts tr'))
            .map(tr => [tr.cells[0].textContent.trim(), tr.cells[1].textContent.trim(), tr.className]);
        return {
            opened: !!dlg,
            title: dlg ? dlg.querySelector('h3').textContent : null,
            rows,
            caution: (document.getElementById('originRebaseCaution') || {}).textContent || '',
            hasContinue: !!document.getElementById('btnRebaseContinue'),
            hasCancel: !!document.getElementById('btnRebaseCancel'),
            // One session, so the multi-session note must NOT be there.
            multiNote: !!document.getElementById('originRebaseMultiNote'),
            // The scrim covers the page, so nothing behind it is clickable.
            blocks: (() => {
                const o = document.getElementById('originRebaseConfirm');
                const s = getComputedStyle(o);
                return s.position === 'fixed' && parseInt(s.zIndex, 10) >= 10000;
            })(),
        };
    });
    check(m.opened && m.title === 'Set as New Calibration?',
        `the button opens a warning modal (got '${m.title}')`);
    check(m.hasContinue && m.hasCancel, 'with Cancel and Continue');
    check(m.blocks, 'over a fixed, high-z scrim, so nothing behind it can be clicked');
    const row = (label) => (m.rows.find(r => r[0].replace(/\s+/g, ' ').trim() === label) || [])[1];
    check(row('3D points to update') === '4',
        `it counts the 3D keypoints (got ${JSON.stringify(row('3D points to update'))})`);
    check(row('from User instance groups') === '1' && row('from Predicted instance groups') === '1',
        `split by provenance (got ${row('from User instance groups')} user / ` +
        `${row('from Predicted instance groups')} predicted)`);
    check(row('User 2D instances') === '2' && row('Predicted 2D instances') === '2',
        `the 2D members are listed too (got ${row('User 2D instances')} / ${row('Predicted 2D instances')})`);
    check(/unchanged/.test(row('Reprojection instances') || ''),
        `reprojections are named as UNCHANGED, not as work (got '${row('Reprojection instances')}')`);
    check(row('Plane nodes') === '4' && row('Plane fits') === '1',
        `plane annotation is counted (got ${row('Plane nodes')} nodes / ${row('Plane fits')} fits)`);
    check(/^2 in 1 session$/.test(row('Cameras') || ''),
        `and the cameras (got '${row('Cameras')}')`);
    check(!m.multiNote, 'with no multi-session note for a single session');
    check(/Do not close this tab/.test(m.caution) && /cannot resume/.test(m.caution),
        `the caution says to stay put and why (got '${m.caution.slice(0, 60)}...')`);

    // =================================================================
    // 2 — Cancel at the confirmation runs nothing
    // =================================================================
    console.log('\n2. Cancel at the confirmation');
    m = await page.evaluate(async () => {
        const before = await window.__snap();
        document.getElementById('btnRebaseCancel').click();
        const closed = !document.getElementById('originRebaseConfirm');
        // Esc must do the same.
        document.getElementById('btnSetCalibration').click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const escClosed = !document.getElementById('originRebaseConfirm');
        const O = await import('/ui/origin-definition.js');
        return {
            closed, escClosed,
            unchanged: (await window.__snap()) === before,
            frameKept: !!O.originState.frame,
            noProgress: !document.getElementById('originRebaseProgress'),
        };
    });
    check(m.closed && m.escClosed, 'Cancel and Esc both close it');
    check(m.noProgress, 'no progress modal is opened');
    check(m.unchanged && m.frameKept, 'and nothing in the project moved');

    // =================================================================
    // 3 — Cancel mid-flight
    // =================================================================
    //
    // The plan only yields — and only then asks whether to cancel — every 2,000
    // work units, so the fixture is padded past that threshold. A project small
    // enough to finish inside a single task has nothing to cancel, which is
    // correct rather than a gap.
    //
    // Two things make this deterministic instead of a race. `runSetCalibration`
    // is called directly and its promise awaited, so the assertions cannot run
    // against a flow that is still going; and the Cancel click is driven from a
    // `setTimeout(0)` poll started BEFORE the flow, so its timer is queued ahead
    // of the plan's first yield timer and fires first by FIFO ordering. Clicking
    // from the test process instead would be a genuine race against those
    // yields. The BUTTON path through the same code is covered by sections 1-2
    // and 4.
    console.log('\n3. Cancel from the progress modal');
    m = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const RB = await import('/ui/origin-rebase.js');
        const O = await import('/ui/origin-definition.js');
        const { Instance, InstanceGroup, makePoints3d, setPoint3d } = pd;

        for (let i = 0; i < 2600; i++) {
            const g = new InstanceGroup(100 + i, -1);
            g.addInstance('camA', new Instance([[i % 300, i % 200]], 0, 'predicted', 0.5));
            g.points3d = makePoints3d(1);
            setPoint3d(g.points3d, 0, [i % 97, -(i % 53), 150 + (i % 31)]);
            AS.state.session.instanceGroups.set(1000 + i, [g]);
        }

        const before = await window.__snap();
        let wrote = false, pickerCalls = 0;
        RB.resetCalibrationHandle();
        window.showSaveFilePicker = async () => {
            pickerCalls++;
            return {
                name: 'calibration.toml',
                createWritable: async () => ({
                    write: async () => { wrote = true; },
                    close: async () => {},
                }),
            };
        };

        const flow = RB.runSetCalibration(AS.state.sessions);

        let sawModal = false, clicked = false, hadCancelButton = false;
        for (let i = 0; i < 4000 && !clicked; i++) {
            if (document.getElementById('originRebaseProgress')) sawModal = true;
            const b = document.getElementById('btnRebaseAbort');
            if (b) { hadCancelButton = true; b.click(); clicked = true; break; }
            await new Promise(r => setTimeout(r, 0));
        }
        const result = await flow;

        return {
            sawModal, hadCancelButton,
            returnedNull: result === null,
            pickerCalls,
            progressClosed: !document.getElementById('originRebaseProgress'),
            wrote,
            unchanged: (await window.__snap()) === before,
            frameKept: !!O.originState.frame,
            status: (document.getElementById('statusText') || {}).textContent || '',
        };
    });
    check(m.sawModal && m.hadCancelButton, 'the flow opens a progress modal carrying a Cancel button');
    check(m.pickerCalls === 1, `the file is chosen up front, before the slow part (got ${m.pickerCalls} call(s))`);
    check(m.returnedNull && m.progressClosed, 'cancelling unwinds the flow and tears the modal down');
    check(!m.wrote, 'NOTHING is written to the calibration file — the write comes after the plan');
    check(m.unchanged && m.frameKept,
        'and not one coordinate moved: the plan is built beside the live data and simply dropped');
    check(/[Cc]ancelled/.test(m.status), `the status says so (got '${m.status}')`);

    // =================================================================
    // 4 — The commit
    // =================================================================
    console.log('\n4. Continue writes the calibration and re-bases the project');
    m = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const O = await import('/ui/origin-definition.js');
        const RB = await import('/ui/origin-rebase.js');
        const OF = await import('/pose/origin-frame.js');
        const SL = await import('/import-export/save-load.js');

        const pixelsBefore = await window.__pixels();
        const frame = O.originState.frame;
        const camsBefore = AS.state.session.cameras.map(c => [c.rvec.slice(), c.tvec.slice()]);
        const ptsBefore = Array.from(AS.state.session.instanceGroups.get(0)[0].points3d);

        // Forget any handle section 3 left behind, so the picker is exercised.
        RB.resetCalibrationHandle();
        SL.clearDirty ? SL.clearDirty() : (AS.state.isDirty = false);

        let written = null, pickerCalls = 0;
        window.showSaveFilePicker = async (opts) => {
            pickerCalls++;
            window.__pickerSuggested = opts && opts.suggestedName;
            return {
                name: 'calibration.toml',
                createWritable: async () => ({
                    write: async (txt) => { written = txt; },
                    close: async () => {},
                }),
            };
        };

        document.getElementById('btnSetCalibration').click();
        document.getElementById('btnRebaseContinue').click();
        for (let i = 0; i < 200 && document.getElementById('originRebaseProgress'); i++) {
            await new Promise(r => setTimeout(r, 25));
        }

        const pixelsAfter = await window.__pixels();
        let worstPixel = 0;
        for (let i = 0; i < pixelsBefore.length; i++) {
            for (let a = 0; a < 2; a++) {
                worstPixel = Math.max(worstPixel, Math.abs(pixelsBefore[i][a] - pixelsAfter[i][a]));
            }
        }

        const ptsAfter = Array.from(AS.state.session.instanceGroups.get(0)[0].points3d);
        // The first plane corner WAS the picked origin, so it must now be at 0.
        const P = await import('/ui/plane-definition.js');
        const originNode = Array.from(P.planeModel().pool.nodes[0].xyz);

        return {
            pickerCalls,
            suggested: window.__pickerSuggested,
            wroteSomething: typeof written === 'string' && written.length > 0,
            wroteBothCams: /\[cam_0\]/.test(written || '') && /\[cam_1\]/.test(written || ''),
            // The file must carry the NEW extrinsics, not the ones it replaced.
            fileIsRebased: !(written || '').includes(JSON.stringify(camsBefore[0][1])),
            samePixelCount: pixelsBefore.length === pixelsAfter.length,
            nProbes: pixelsBefore.length,
            worstPixel,
            pointsMoved: ptsBefore.some((v, i) => Math.abs(v - ptsAfter[i]) > 1e-6),
            camsMoved: AS.state.session.cameras.some((c, i) =>
                c.tvec.some((v, k) => Math.abs(v - camsBefore[i][1][k]) > 1e-6)),
            originNodeAtZero: originNode.every(v => Math.abs(v) < 1e-6),
            frameCleared: O.originState.frame === null,
            resultHidden: getComputedStyle(document.getElementById('originResultSection')).display === 'none',
            dangerHidden: getComputedStyle(document.getElementById('originDangerSection')).display === 'none',
            dirty: AS.state.isDirty,
            triCacheCleared: AS.state.triangulationResults.size === 0,
            progressClosed: !document.getElementById('originRebaseProgress'),
            status: (document.getElementById('statusText') || {}).textContent || '',
            // What the frame said it would do, for the report below.
            angleDeg: frame.angleDeg,
        };
    });
    check(m.pickerCalls === 1 && m.suggested === 'calibration.toml',
        `the save picker is asked once, pre-filled (got ${m.pickerCalls} call(s), '${m.suggested}')`);
    check(m.wroteSomething && m.wroteBothCams, 'a TOML with both cameras is written');
    check(m.fileIsRebased, 'carrying the NEW extrinsics, not the ones it replaced');
    check(m.progressClosed, 'the progress modal closes when it is done');
    check(m.pointsMoved && m.camsMoved,
        `the 3D and the cameras both moved (a ${m.angleDeg.toFixed(1)}° re-base)`);
    check(m.originNodeAtZero,
        'the corner that was picked as the origin now sits at exactly (0, 0, 0)');
    check(m.samePixelCount && m.worstPixel < 1e-6,
        `THE INVARIANT: all ${m.nProbes} probes still project to their original pixel ` +
        `(worst ${m.worstPixel.toExponential(2)} px)`);
    check(m.frameCleared && m.resultHidden && m.dangerHidden,
        'the defined origin collapses — the project IS that frame now, so there is no offset left to report');
    check(m.dirty, 'the project is marked dirty');
    check(m.triCacheCleared, 'and the derived triangulation cache is dropped, not left describing the old 3D');
    check(/Set as new calibration/.test(m.status), `the status reports it (got '${m.status}')`);

    console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} failure(s)`);
} catch (e) {
    console.log('\nFAIL — ' + (e && e.stack ? e.stack : e));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
process.exit(fails === 0 ? 0 : 1);
