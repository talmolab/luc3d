/**
 * set-new-calibration.mjs — the Danger Zone's "Set as New Calibration", end to end.
 *
 * `Export New Calibration` writes a file and changes nothing. This one commits:
 * it rewrites every 3D number in the project so the world becomes the defined
 * origin, and writes the calibration that matches to a NEW file. The whole safety argument is one
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
        const { Camera, Session, Skeleton, Instance, InstanceGroup, FrameGroup,
            UnlinkedInstance, makePoints3d, setPoint3d } = pd;

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

        // The UNLINKED pool: 2D predictions no InstanceGroup references, which
        // is what an imported `.slp` is mostly made of. Disjoint from the group
        // members above, and the half the inventory used to be blind to.
        const fg = new FrameGroup(0);
        for (let i = 0; i < 5; i++) {
            fg.addUnlinkedInstance('camA', new UnlinkedInstance(
                new Instance([[90 + i, 100 + i], [110 + i, 120 + i]], 1, 'predicted', 0.6), 'camA'));
        }
        fg.addUnlinkedInstance('camB', new UnlinkedInstance(
            new Instance([[95, 105], [115, 125]], 0, 'user', 1), 'camB'));
        session.frameGroups.set(0, fg);

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
        const scrape = (id) => Array.from(document.querySelectorAll('#' + id + ' tr'))
            .map(tr => [tr.cells[0].textContent.trim(), tr.cells[1].textContent.trim(), tr.className]);
        const rows = scrape('originRebaseCounts');
        const keeps = scrape('originRebaseKeeps');
        return {
            opened: !!dlg,
            title: dlg ? dlg.querySelector('h3').textContent : null,
            rows,
            keeps,
            titles: Array.from(document.querySelectorAll('#originRebaseConfirm .origin-rebase-block-title'))
                .map(e => e.textContent.trim()),
            hasBySession: !!document.getElementById('originRebaseBySession'),
            caution: (document.getElementById('originRebaseCaution') || {}).textContent || '',
            stale: (document.getElementById('originRebaseStaleWarning') || {}).textContent || '',
            intro: (document.querySelector('#originRebaseConfirm .plane-confirm-message') || {}).textContent || '',
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
    const keep = (label) => (m.keeps.find(r => r[0].replace(/\s+/g, ' ').trim() === label) || [])[1];
    // TWO tables, and WHICH table a row is in is the claim being made about it.
    check(m.titles.length === 2 &&
          /Origin-dependent/i.test(m.titles[0]) && /Not origin-dependent/i.test(m.titles[1]),
        `the inventory is split into origin-dependent and not-origin-dependent ` +
        `(got ${JSON.stringify(m.titles)})`);
    // "updated", not "rewritten": the numbers are re-expressed in a new frame,
    // and this dialog's other half is about what is NOT overwritten.
    check(/^Origin-dependent . updated$/.test(m.titles[0]) &&
          !/rewritten/i.test(m.titles.join(' ')),
        `the first block says "updated" and no longer says "rewritten" ` +
        `(got '${m.titles[0]}')`);
    check(!m.hasBySession, 'with no per-session block for a single session');
    // 4 pose keypoints (2 groups x 2 nodes) + 4 plane nodes. The headline is
    // the SUM: a plane node is a 3D point this action moves, and quoting only
    // the pose half told a planes-only project that nothing would be updated
    // directly above the row listing the nodes about to move.
    check(row('3D points to update') === '8',
        `the headline counts EVERY 3D point, pose and plane (got ${JSON.stringify(row('3D points to update'))})`);
    check(row('pose keypoints') === '4' && row('plane nodes') === '4',
        `pose keypoints and plane nodes are peers under the headline ` +
        `(got ${row('pose keypoints')} / ${row('plane nodes')})`);
    check(row('from 1 User instance group') === '2' &&
          row('from 1 Predicted instance group') === '2' &&
          row('from 0 ungrouped / untyped groups') === '0',
        `split by provenance, in POINTS, with the group count in the label ` +
        `(got ${row('from 1 User instance group')} / ${row('from 1 Predicted instance group')} / ` +
        `${row('from 0 ungrouped / untyped groups')})`);
    {
        // BOTH levels have to add up, or the indentation is decoration.
        const prov = ['from 1 User instance group', 'from 1 Predicted instance group',
            'from 0 ungrouped / untyped groups'].reduce((a, k) => a + parseInt(row(k), 10), 0);
        check(prov === parseInt(row('pose keypoints'), 10),
            `the provenance rows sum to pose keypoints (${prov} vs ${row('pose keypoints')})`);
        const sub = parseInt(row('pose keypoints'), 10) + parseInt(row('plane nodes'), 10);
        check(sub === parseInt(row('3D points to update'), 10),
            `and those sum to the headline (${sub} vs ${row('3D points to update')})`);
    }
    check(/^1 . centroid and normal$/.test(row('Plane fits') || ''),
        `a fit keeps its own row and says why it is not a point (got '${row('Plane fits')}')`);
    check(/^2 . rvec and tvec$/.test(row('Camera extrinsics') || ''),
        `camera EXTRINSICS are origin-dependent (got '${row('Camera extrinsics')}')`);
    check(row('User 2D instances') === undefined &&
          row('Camera intrinsics + distortion') === undefined,
        'and nothing that stays put is in the origin-dependent table');

    // ---- table 2: the reassurance ----
    // 2 grouped + 1 unlinked user; 2 grouped + 5 unlinked predicted. The
    // unlinked pool is where an imported `.slp`'s predictions live, and
    // counting only group members reported 0 of them on a real project.
    check(/^3 . 2 in instance groups$/.test(keep('User 2D instances') || ''),
        `the 2D total includes the UNLINKED pool (got '${keep('User 2D instances')}')`);
    check(/^7 . 2 in instance groups$/.test(keep('Predicted 2D instances') || ''),
        `and so does the predicted one, with the grouped subtotal beside it ` +
        `(got '${keep('Predicted 2D instances')}')`);
    check(keep('Reprojection instances') === '3',
        `reprojections live in the unchanged table, where "unchanged" needs no caveat ` +
        `(got '${keep('Reprojection instances')}')`);
    check(keep('Camera intrinsics + distortion') === '2' &&
          keep('Image size, camera order') === '2',
        `the lens model is listed as NOT origin-dependent, which is the most common fear ` +
        `about this button (got ${keep('Camera intrinsics + distortion')} / ` +
        `${keep('Image size, camera order')})`);
    check(parseInt(keep('Plane placements (2D)'), 10) === 8,
        `the planes' own 2D is there too, counted in points (got ${keep('Plane placements (2D)')})`);
    check(keep('Camera extrinsics') === undefined && keep('pose keypoints') === undefined,
        'and nothing that moves is in the unchanged table');
    check(!m.multiNote, 'with no multi-session note for a single session');
    check(/Do not close this tab/.test(m.caution) && /cannot resume/.test(m.caution),
        `the caution says to stay put and why (got '${m.caution.slice(0, 60)}...')`);
    // This warning is the ONLY place the calibration consequence is stated —
    // there is no completion modal repeating it — so its content is pinned.
    check(/NOT overwritten/.test(m.stale) && /calibration-rebased\.toml/.test(m.stale),
        `the confirmation says calibration.toml is not overwritten, and names the new file ` +
        `(got '${m.stale.slice(0, 70)}...')`);
    check(/precedence over/i.test(m.stale) && /calibration\.toml/.test(m.stale),
        'and says the new file takes precedence over calibration.toml — what pickCalibrationFile '
        + 'actually does');
    // The old copy also claimed a folder .toml beats the calibration embedded
    // in the .slp. That holds for a SESSION-FOLDER load and not for reopening
    // the project, so stating it unconditionally overstated the hazard.
    check(!/saved inside the project|embedded/i.test(m.stale),
        'without claiming anything about the calibration saved inside the project');
    check(!/rewrites the calibration on disk/.test(m.intro),
        'the intro no longer claims it overwrites the calibration on disk');
    check(/save the project/i.test(m.intro),
        `and says a save is what keeps the new 3D (got '${m.intro.slice(-70)}')`);

    // =================================================================
    // 1b — The two headline blocks FOLD, and never remember that they did
    // =================================================================
    //
    // A read inventory is a tall wall of numbers between the user and
    // Continue, so each headline block is a `<details open>` whose `<summary>`
    // is its title. Two claims are under test, and the second is the one that
    // matters: the fold genuinely removes the body from the layout, and the
    // state does NOT survive the dialog closing. This is a confirmation, not a
    // panel — the two-table split is the claim being made about the operation,
    // so a fold made once must never be how the next re-base is confirmed.
    console.log('\n1b. The headline blocks fold, and do not remember it');
    const readFold = () => page.evaluate(() => {
        const one = (id) => {
            const t = document.getElementById(id);
            const d = t ? t.closest('details') : null;
            const s = d ? d.querySelector(':scope > summary.origin-rebase-block-title') : null;
            const w = t ? t.closest('.origin-rebase-block') : null;
            const noteEl = w ? w.querySelector('.origin-rebase-block-note') : null;
            return {
                isDetails: !!d,
                blockIsDetails: !!(w && w.tagName === 'DETAILS'),
                hasSummary: !!s,
                open: !!(d && d.open),
                rows: t ? t.rows.length : -1,
                // NOT RENDERED, not merely attribute-present — asserting `open`
                // alone would pass on a build that set the attribute and styled
                // nothing. Two independent signals, because neither alone is
                // enough in current Chromium: a closed `<details>` hides its
                // body via `::details-content { content-visibility: hidden }`,
                // which leaves the skipped subtree's cached client rects and
                // `offsetParent` in place (so `getBoundingClientRect()` on the
                // table still reports its open height), while
                // `checkVisibility()` reports it correctly and the DETAILS' own
                // box genuinely collapses to just the summary.
                bodyVisible: !!(t && t.checkVisibility()),
                blockH: d ? Math.round(d.getBoundingClientRect().height) : -1,
                summaryH: s ? Math.round(s.getBoundingClientRect().height) : -1,
                // The note rides INSIDE the fold with the table, so a folded
                // section leaves no orphaned sentence behind.
                noteVisible: !!(noteEl && noteEl.checkVisibility()),
                summaryVisible: !!(s && s.checkVisibility()),
                // The disclosure affordance is OURS: the browser's own marker
                // is suppressed and a caret is drawn in both states.
                listStyle: s ? getComputedStyle(s).listStyleType : '',
                caret: s ? getComputedStyle(s, '::before').content : '',
                caretXform: s ? getComputedStyle(s, '::before').transform : '',
            };
        };
        return {
            counts: one('originRebaseCounts'),
            keeps: one('originRebaseKeeps'),
            // Nothing about this dialog may reach localStorage.
            storage: Object.keys(localStorage).filter(k =>
                /originrebase|origin-rebase/i.test(k + ' ' + (localStorage.getItem(k) || ''))),
        };
    });
    let fold = await readFold();
    check(fold.counts.blockIsDetails && fold.counts.hasSummary &&
          fold.keeps.blockIsDetails && fold.keeps.hasSummary,
        'both headline blocks are real <details> with the title as their <summary>');
    check(fold.counts.open && fold.keeps.open &&
          fold.counts.bodyVisible && fold.keeps.bodyVisible &&
          fold.counts.blockH > fold.counts.summaryH &&
          fold.keeps.blockH > fold.keeps.summaryH,
        `and both are EXPANDED when the dialog opens ` +
        `(${fold.counts.blockH}px / ${fold.keeps.blockH}px, summaries ` +
        `${fold.counts.summaryH}px / ${fold.keeps.summaryH}px)`);
    check(fold.counts.listStyle === 'none' && /25b8|▸/i.test(fold.counts.caret),
        `with our own caret and the browser's marker suppressed ` +
        `(list-style '${fold.counts.listStyle}', content ${fold.counts.caret})`);
    check(fold.counts.caretXform !== 'none',
        `and the caret is rotated open rather than swapped for a second glyph ` +
        `(got '${fold.counts.caretXform}')`);

    // Fold the first one the way a user does: a real click on its summary.
    const openH = fold.counts.blockH;
    await page.evaluate(() => document.getElementById('originRebaseCounts')
        .closest('details').querySelector('summary').click());
    // The caret's rotation is transitioned (120ms), so let it land before
    // reading it — mid-transition the computed transform is an intermediate
    // matrix, which is neither state and would make the check a coin flip.
    await page.waitForTimeout(250);
    fold = await readFold();
    check(!fold.counts.open && !fold.counts.bodyVisible &&
          fold.counts.blockH === fold.counts.summaryH,
        `clicking the summary collapses it — the table is genuinely not rendered and the ` +
        `block is down to its title (${openH}px -> ${fold.counts.blockH}px, summary ` +
        `${fold.counts.summaryH}px, table visible ${fold.counts.bodyVisible})`);
    check(!fold.counts.noteVisible && fold.counts.summaryVisible,
        'the note folds away with the table, and the title stays, so the section still says '
        + 'what it is');
    check(fold.counts.rows > 0,
        `the rows are still in the DOM, so nothing was destroyed by folding ` +
        `(${fold.counts.rows} rows)`);
    // NEGATIVE CONTROL: folding one block must not fold the other, or "the
    // table is not visible" would be true for the boring reason that the whole
    // dialog collapsed.
    check(fold.keeps.open && fold.keeps.bodyVisible &&
          fold.keeps.blockH > fold.keeps.summaryH,
        `NEGATIVE CONTROL: the second block is untouched and still expanded ` +
        `(${fold.keeps.blockH}px vs summary ${fold.keeps.summaryH}px)`);
    check(fold.counts.caretXform === 'none',
        `and the caret is back to its un-rotated, folded state ` +
        `(got '${fold.counts.caretXform}')`);
    check(fold.storage.length === 0,
        `nothing was written to localStorage (got ${JSON.stringify(fold.storage)})`);

    // Space and Enter on a focused summary toggle the SECTION. Driven through
    // real keystrokes, because the app's global dispatcher sees the keydown
    // first and `targetOwnsKey` is what hands SUMMARY its own Space/Enter.
    await page.evaluate(() => document.getElementById('originRebaseKeeps')
        .closest('details').querySelector('summary').focus());
    await page.keyboard.press('Space');
    fold = await readFold();
    let stillOpen = await page.evaluate(() => !!document.getElementById('originRebaseConfirm'));
    check(!fold.keeps.open && !fold.keeps.bodyVisible && stillOpen,
        'Space on a focused summary folds that section and leaves the dialog open');
    await page.keyboard.press('Enter');
    fold = await readFold();
    stillOpen = await page.evaluate(() => !!document.getElementById('originRebaseConfirm'));
    check(fold.keeps.open && fold.keeps.bodyVisible && stillOpen,
        'and Enter unfolds it, again without closing the dialog');

    // Esc still closes the MODAL with a summary focused — the listener is on
    // `document` in the capture phase, and a summary has no Esc behaviour of
    // its own to swallow it with.
    await page.evaluate(() => document.getElementById('originRebaseCounts')
        .closest('details').querySelector('summary').focus());
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => !document.getElementById('originRebaseConfirm')),
        'Esc closes the dialog even with a summary focused');

    // ...and the whole point: reopening rebuilds them EXPANDED. The block that
    // was folded a moment ago is open again.
    await page.evaluate(() => document.getElementById('btnSetCalibration').click());
    fold = await readFold();
    check(fold.counts.open && fold.counts.bodyVisible &&
          fold.keeps.open && fold.keeps.bodyVisible,
        `the fold does NOT survive closing and reopening the dialog — both blocks come back ` +
        `expanded (${fold.counts.blockH}px / ${fold.keeps.blockH}px)`);
    check(fold.storage.length === 0,
        'and still nothing in localStorage: this state is deliberately not persisted');

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
                // A real picker names the handle after what the user accepted,
                // which is the suggestion here. Hard-coding 'calibration.toml'
                // would have this stub assert the very overwrite the app no
                // longer does, and print it back in the status line.
                name: (opts && opts.suggestedName) || 'calibration.toml',
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

        // There is no completion modal any more: it listed two obligations, one
        // of which now happens automatically (the save) and the other of which
        // the confirmation had already stated. Its absence is asserted, because
        // a modal after a long operation is exactly the kind of thing that gets
        // reintroduced.
        const anyDoneModal = !!document.getElementById('originRebaseDone');

        return {
            anyDoneModal,
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
    check(m.pickerCalls === 1 && m.suggested === 'calibration-rebased.toml',
        `the save picker is asked once, pre-filled with a NEW name so the original ` +
        `calibration.toml is never the target (got ${m.pickerCalls} call(s), '${m.suggested}')`);
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
    check(m.triCacheCleared, 'and the derived triangulation cache is dropped, not left describing the old 3D');
    check(/Set as new calibration/.test(m.status), `the status reports it (got '${m.status}')`);
    check(/calibration-rebased\.toml/.test(m.status) && !/wrote calibration\.toml/.test(m.status),
        'naming the file it actually wrote, which is not the original');
    check(!m.anyDoneModal,
        'and NO completion modal is raised — the save is automatic and the calibration '
        + 'warning was already given up front');
    // This project has no `slpFileHandle` (nothing opened it from disk), so the
    // auto-save cannot run: a picker needs a user gesture this flow no longer
    // has. It has to SAY so rather than fail quietly or claim a save happened.
    check(m.dirty, 'the project is still dirty, because there was no file to save it to');
    check(/Save As/i.test(m.status) && /no file yet/i.test(m.status),
        `and the status says why, and what to do instead (got '...${m.status.slice(-90)}')`);

    // =================================================================
    // 5 - Planes, and NO pose annotation at all
    // =================================================================
    //
    // The shape the bug was reported in: a cage whose planes are annotated on a
    // project that was never grouped or triangulated. Every pose count is
    // honestly zero, and the headline used to quote only those - so the dialog
    // announced "0 3D points to update" one row above the plane nodes it was
    // about to move. The headline is the SUM, so here it is the plane nodes.
    console.log('\n5. Planes but no pose annotation');
    m = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const O = await import('/ui/origin-definition.js');
        AS.state.session.instanceGroups.clear();
        O.enterOriginMode();
        O.pickOriginNode(window.__floorId, 1);
        O.pickOriginAxis('negative');
        O.applyOrigin();
        document.getElementById('btnSetCalibration').click();
        const scrape = (id) => Array.from(document.querySelectorAll('#' + id + ' tr'))
            .map(tr => [tr.cells[0].textContent.trim(), tr.cells[1].textContent.trim(), tr.className]);
        const rows = scrape('originRebaseCounts');
        const keeps = scrape('originRebaseKeeps');
        const opened = !!document.getElementById('originRebaseConfirm');
        const cancel = document.getElementById('btnRebaseCancel');
        if (cancel) cancel.click();
        return { rows, keeps, opened };
    });
    check(m.opened, 'the modal still opens on a project with no pose annotation');
    check(row('3D points to update') === '4',
        `the headline is the plane nodes, not 0 (got ${JSON.stringify(row('3D points to update'))})`);
    check(row('plane nodes') === '4',
        `and they are named as the source of it (got ${row('plane nodes')})`);
    check(row('pose keypoints') === '0' &&
          row('from 0 User instance groups') === '0' &&
          row('from 0 Predicted instance groups') === '0' &&
          row('from 0 ungrouped / untyped groups') === '0',
        'with every pose bucket honestly zero, groups and points alike');
    // The modal's SHAPE must not depend on the load path. A per-camera session
    // with no project.slp has no instance groups and no 3D, and that has to
    // read as a stated zero rather than as a missing row.
    check(m.rows.length === 8 && m.keeps.length === 6,
        `and every row is still present — zeros are shown, not hidden ` +
        `(got ${m.rows.length} origin-dependent + ${m.keeps.length} unchanged)`);

    // =================================================================
    // 6 - Multi-session, with a DIFFERENT calibration per session
    // =================================================================
    //
    // A multi-session project loads each session folder independently, so each
    // carries its own `calibration.toml` and its own cameras. The re-base
    // moves ALL of them by the one frame derived from the project-wide plane
    // pool, but only the ACTIVE session's calibration is written out - so
    // "8 cameras in 3 sessions" is not enough to check the operation against.
    // The per-session block is what makes the split visible.
    console.log('\n6. Multi-session');
    m = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Camera, Session, Skeleton, Instance, InstanceGroup, FrameGroup,
            UnlinkedInstance, makePoints3d, setPoint3d } = pd;

        // A second session with a DIFFERENT calibration (three cameras, other
        // extrinsics) and its own 3D, 2D and plane placements.
        const K2 = [[700, 0, 300], [0, 700, 260], [0, 0, 1]];
        const cams2 = [
            new Camera('bA', K2, [0, 0, 0, 0, 0], [0.4, 0.1, -0.05], [10, 20, 800], [600, 500]),
            new Camera('bB', K2, [0, 0, 0, 0, 0], [-0.1, 0.5, 0.2], [-30, 5, 820], [600, 500]),
            new Camera('bC', K2, [0, 0, 0, 0, 0], [0.2, -0.4, 0.3], [55, -40, 790], [600, 500]),
        ];
        const s2 = new Session(cams2, AS.state.session.skeleton, ['track_0'], 'SessionTwo');
        const g2 = new InstanceGroup(91, -1);
        for (const c of ['bA', 'bB']) g2.addInstance(c, new Instance([[5, 6], [7, 8]], 0, 'user', 1));
        g2.points3d = makePoints3d(2);
        setPoint3d(g2.points3d, 0, [77, -12, 300]);
        setPoint3d(g2.points3d, 1, [-5, 40, 275]);
        s2.instanceGroups.set(4, [g2]);
        const fg2 = new FrameGroup(4);
        for (let i = 0; i < 9; i++) {
            fg2.addUnlinkedInstance('bC', new UnlinkedInstance(
                new Instance([[1, 2], [3, 4]], 0, 'predicted', 0.5), 'bC'));
        }
        s2.frameGroups.set(4, fg2);

        AS.state.sessions = [AS.state.session, s2];

        document.getElementById('btnSetCalibration').click();
        const scrape = (id) => Array.from(document.querySelectorAll('#' + id + ' tr'))
            .map(tr => [tr.cells[0].textContent.trim(), tr.cells[1].textContent.trim(), tr.className]);
        const out = {
            rows: scrape('originRebaseCounts'),
            keeps: scrape('originRebaseKeeps'),
            per: scrape('originRebaseBySession'),
            titles: Array.from(document.querySelectorAll('#originRebaseConfirm .origin-rebase-block-title'))
                .map(e => e.textContent.trim()),
            multiNote: (document.getElementById('originRebaseMultiNote') || {}).textContent || '',
            perNote: (() => {
                const b = document.getElementById('originRebaseBySession');
                const w = b && b.closest('.origin-rebase-block');
                const nd = w && w.querySelector('.origin-rebase-block-note');
                return nd ? nd.textContent : '';
            })(),
            // The per-session block is deliberately NOT collapsible: it holds
            // the checkboxes that decide which sessions move, and folding away
            // the control the user came to use is worse than an uneven stack.
            perIsDetails: (() => {
                const b = document.getElementById('originRebaseBySession');
                return !!(b && b.closest('details'));
            })(),
            headlinesAreDetails: ['originRebaseCounts', 'originRebaseKeeps'].every((id) => {
                const b = document.getElementById(id);
                const d = b && b.closest('details');
                return !!d && d.open;
            }),
        };
        const cancel = document.getElementById('btnRebaseCancel');
        if (cancel) cancel.click();
        AS.state.sessions = [AS.state.session];
        return out;
    });
    check(m.titles.length === 3 && /By session/i.test(m.titles[2]),
        `a third block appears for the per-session split (got ${JSON.stringify(m.titles)})`);
    // NEGATIVE CONTROL for the folding: only the two headline blocks fold. The
    // per-session one holds the checkboxes, so it stays a plain block — a
    // build that turned every block into a <details> fails here.
    check(m.headlinesAreDetails && !m.perIsDetails,
        'the two headline blocks fold; the per-session block, which holds the checkboxes, '
        + 'does not');
    check(m.per.length === 2, `one row per session (got ${m.per.length})`);
    check(m.per[0][0] === 'S1' && m.per[1][0] === 'SessionTwo',
        `each named (got ${JSON.stringify(m.per.map(r => r[0]))})`);
    // Section 5 cleared this session's instanceGroups, so it contributes no
    // 3D and no grouped members — only its 6 unlinked 2D instances.
    check(/^0 3D . 2 cam . 6 2D$/.test(m.per[0][1] || ''),
        `the first session's own numbers (got '${m.per[0][1]}')`);
    check(/^2 3D . 3 cam . 11 2D$/.test(m.per[1][1] || ''),
        `and the second's, with its own 3 cameras (got '${m.per[1][1]}')`);
    {
        // The totals have to be the sum, or the two views of the same project
        // disagree - which is exactly the confusion the block exists to fix.
        const camTotal = parseInt((row('Camera extrinsics') || '0').replace(/[^0-9]/g, ''), 10);
        check(camTotal === 5, `camera extrinsics total 2 + 3 = 5 (got ${camTotal})`);
        const twoD = (lbl) => parseInt((keep(lbl) || '0').split(' ')[0].replace(/,/g, ''), 10);
        // 1 + 2 user, 5 + 9 predicted.
        check(twoD('User 2D instances') + twoD('Predicted 2D instances') === 17,
            `and the 2D totals sum across sessions (got ${twoD('User 2D instances')} + ` +
            `${twoD('Predicted 2D instances')})`);
    }
    check(/project-wide/i.test(m.perNote) && /not split/i.test(m.perNote),
        `the block says plane nodes and fits are NOT split per session, because the ` +
        `PlaneModel is project-scoped (got '${m.perNote.slice(0, 70)}...')`);
    check(/only the current session’s cameras are written to a new calibration file/
        .test(m.multiNote),
        `and the existing note still warns that only the current session's calibration is ` +
        `written (got '${m.multiNote.slice(0, 60)}...')`);
    // Naming the limitation is not the same as saying what to DO about it, and
    // the instruction is the whole reason the user cares: the folders that were
    // not written keep a calibration that no longer matches their 3D, so each
    // one needs an updated file of its own.
    check(/old calibration\.toml/i.test(m.multiNote)
        && /Ensure other re-based sessions have an updated calibration file in their folders/
            .test(m.multiNote),
        `and says what to DO - the other folders need an updated calibration file ` +
        `(got '...${m.multiNote.slice(60, 200)}')`);
    check(row('plane nodes') === '4',
        `while the project-wide plane rows are unchanged by the extra session ` +
        `(got ${row('plane nodes')})`);

    // Three tables plus two cautions is a tall modal. It must stay REACHABLE:
    // one scroller on the modal itself, and Continue inside the viewport.
    const fit = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const pd = await import('/pose/pose-data.js');
        const s2 = new pd.Session(
            [new pd.Camera('zA', [[700, 0, 300], [0, 700, 260], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0.4, 0.1, -0.05], [10, 20, 800], [600, 500])],
            AS.state.session.skeleton, ['track_0'], 'SessionTwo');
        AS.state.sessions = [AS.state.session, s2];
        document.getElementById('btnSetCalibration').click();
        const modal = document.querySelector('#originRebaseConfirm .plane-confirm-modal');
        const btn = document.getElementById('btnRebaseContinue');
        const r = btn.getBoundingClientRect();
        const cs = getComputedStyle(modal);
        const out = {
            scrolls: cs.overflowY === 'auto' || cs.overflowY === 'scroll',
            withinViewport: r.bottom <= window.innerHeight + 1 && r.top >= -1,
            modalFits: modal.getBoundingClientRect().height <= window.innerHeight + 1,
            innerScrollers: Array.from(modal.querySelectorAll('*')).filter((el) => {
                const s = getComputedStyle(el);
                return (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
                    el.scrollHeight > el.clientHeight + 1;
            }).length,
            // What the folding is FOR: on the tallest shape this dialog takes,
            // collapsing the two inventories has to actually shorten the
            // scrollport's contents — not just hide a border.
            scrollBefore: modal.scrollHeight,
        };
        for (const id of ['originRebaseCounts', 'originRebaseKeeps']) {
            document.getElementById(id).closest('details').open = false;
        }
        out.scrollAfter = modal.scrollHeight;
        // The action row is sticky, so Continue stays reachable in both states.
        const r2 = btn.getBoundingClientRect();
        out.withinViewportFolded = r2.bottom <= window.innerHeight + 1 && r2.top >= -1;
        out.innerScrollersFolded = Array.from(modal.querySelectorAll('*')).filter((el) => {
            const s = getComputedStyle(el);
            return (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
                el.scrollHeight > el.clientHeight + 1;
        }).length;
        document.getElementById('btnRebaseCancel').click();
        AS.state.sessions = [AS.state.session];
        return out;
    });
    check(fit.scrolls && fit.modalFits,
        'the modal caps its own height and scrolls, so Continue is never below the fold');
    check(fit.withinViewport, 'and Continue is inside the viewport when it opens');
    check(fit.innerScrollers === 0,
        'with ONE scroller — no table gets its own, per the no-scroll-within-scroll rule');
    check(fit.scrollAfter < fit.scrollBefore - 50,
        `folding both inventories genuinely shortens the modal's contents ` +
        `(${fit.scrollBefore}px -> ${fit.scrollAfter}px)`);
    check(fit.withinViewportFolded && fit.innerScrollersFolded === 0,
        'and Continue is still reachable, still with one scroller, when they are folded');

    // =================================================================
    // 7 - Committing in a MULTI-SESSION project leaves a third obligation
    // =================================================================
    //
    // One calibration file per session folder, and this action writes exactly
    // one of them. So the two obligations section 4 checks are not enough here:
    // the folders that were NOT written still hold a calibration in the old
    // frame, and the next folder load then splits the project across two
    // frames. Saying so at commit time is what makes
    // `ui/calibration-notice.js`'s note predictable rather than alarming.
    console.log('\n7. Multi-session commit');
    const multiDone = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const pd = await import('/pose/pose-data.js');
        // Section 5 applied an origin and section 6 only ever CANCELLED, so the
        // frame is still standing. Re-applying here would mean re-entering
        // origin mode on a project that already has a frame, which is a
        // different thing to test.
        const s2 = new pd.Session(
            [new pd.Camera('zA', [[700, 0, 300], [0, 700, 260], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0.4, 0.1, -0.05], [10, 20, 800], [600, 500])],
            AS.state.session.skeleton, ['track_0'], 'SessionTwo');
        AS.state.sessions = [AS.state.session, s2];

        const hadFrame = !!(await import('/ui/origin-definition.js')).originState.frame;
        document.getElementById('btnSetCalibration').click();
        const sawConfirm = !!document.getElementById('originRebaseConfirm');
        const multiNote = (document.getElementById('originRebaseMultiNote') || {}).textContent || '';
        document.getElementById('btnRebaseContinue').click();
        // Wait for the final STATUS LINE, not for a modal: there is no
        // completion modal any more, and a loop keyed on the progress modal
        // being absent falls straight through — `runSetCalibration` awaits the
        // file picker before it ever opens one.
        const statusEl = document.getElementById('statusText') || document.getElementById('status');
        for (let i = 0; i < 400; i++) {
            if (/Set as new calibration/.test((statusEl || {}).textContent || '')) break;
            await new Promise(r => setTimeout(r, 25));
        }
        const status = (statusEl || {}).textContent || '';
        const sawDone = !!document.getElementById('originRebaseDone');
        AS.state.sessions = [AS.state.session];
        return { sawDone, sawConfirm, hadFrame, status, multiNote };
    });
    check(multiDone.hadFrame && multiDone.sawConfirm,
        'section 6 only cancelled, so the origin is still standing and the dialog reopens');
    check(/wrote calibration-rebased\.toml/.test(multiDone.status) &&
          /and 3 cameras/.test(multiDone.status),
        `the commit moved BOTH sessions' cameras — 2 + 1 = 3 — while writing one file ` +
        `(got '${multiDone.status.slice(0, 110)}...')`);
    check(!multiDone.sawDone, 'no completion modal on a multi-session commit either');
    // The third obligation now lives ONLY in the confirmation's multi-session
    // note, stated BEFORE the commit rather than after it — which is also when
    // the user can still decide not to.
    check(/All 2 loaded sessions are re-based/.test(multiDone.multiNote),
        `the confirmation says every session moves (got '${multiDone.multiNote.slice(0, 70)}...')`);
    check(/only the current session’s cameras are written to a new calibration file/
            .test(multiDone.multiNote)
        && /1 session folder\(s\) keep their old calibration\.toml/.test(multiDone.multiNote),
        'and counts the folders that keep their old calibration.toml');
    check(/Ensure other re-based sessions have an updated calibration file in their folders/
        .test(multiDone.multiNote),
        'and says what to do about them, which is the one action left with the user');

    // =================================================================
    // 8 - The user CHOOSES which sessions move
    // =================================================================
    //
    // There is one calibration file per session FOLDER and this action writes
    // exactly one of them, so re-basing all of them unconditionally was a
    // decision the dialog was making on the user's behalf. Four things have to
    // hold and each is a different way of getting it wrong:
    //
    //   1. The ACTIVE session cannot be deselected - its cameras are what the
    //      new file describes, and the project-wide PlaneModel moves with it.
    //      Found by identity, not assumed to be index 0.
    //   2. The headline counts FOLLOW the selection, or the dialog is lying
    //      about what Continue is going to do.
    //   3. Deselecting is a hazard, and the dialog says so - but only then.
    //   4. A deselected session's 3D and cameras are both left alone, so that
    //      session stays internally consistent while the project as a whole
    //      ends up holding 3D in two frames.
    console.log('\n8. Choosing which sessions move');

    // Rebuild a two-session fixture with 3D in BOTH, so a count that ignores
    // the selection is visibly wrong rather than coincidentally right.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Camera, Session, Instance, InstanceGroup, FrameGroup,
            UnlinkedInstance, makePoints3d, setPoint3d } = pd;

        // Section 5 cleared the active session's groups; give it 3D again.
        const g1 = new InstanceGroup(11, 0);
        g1.addInstance('camA', new Instance([[10, 20], [30, 40]], 0, 'user', 1));
        g1.addInstance('camB', new Instance([[11, 21], [31, 41]], 0, 'user', 1));
        g1.points3d = makePoints3d(2);
        setPoint3d(g1.points3d, 0, [12.5, -7.25, 30]);
        setPoint3d(g1.points3d, 1, [-40, 33, 15]);
        AS.state.session.instanceGroups.clear();
        AS.state.session.instanceGroups.set(0, [g1]);

        const K2 = [[700, 0, 300], [0, 700, 260], [0, 0, 1]];
        const cams2 = [
            new Camera('cA', K2, [0, 0, 0, 0, 0], [0.4, 0.1, -0.05], [10, 20, 800], [600, 500]),
            new Camera('cB', K2, [0, 0, 0, 0, 0], [-0.1, 0.5, 0.2], [-30, 5, 820], [600, 500]),
            new Camera('cC', K2, [0, 0, 0, 0, 0], [0.2, -0.4, 0.3], [55, -40, 790], [600, 500]),
        ];
        const s2 = new Session(cams2, AS.state.session.skeleton, ['track_0'], 'Leftover');
        const g2 = new InstanceGroup(92, -1);
        for (const c of ['cA', 'cB']) g2.addInstance(c, new Instance([[5, 6], [7, 8]], 0, 'user', 1));
        g2.points3d = makePoints3d(2);
        setPoint3d(g2.points3d, 0, [77, -12, 300]);
        setPoint3d(g2.points3d, 1, [-5, 40, 275]);
        s2.instanceGroups.set(4, [g2]);
        const fg2 = new FrameGroup(4);
        for (let i = 0; i < 4; i++) {
            fg2.addUnlinkedInstance('cC', new UnlinkedInstance(
                new Instance([[1, 2], [3, 4]], 0, 'predicted', 0.5), 'cC'));
        }
        s2.frameGroups.set(4, fg2);

        AS.state.sessions = [AS.state.session, s2];
        AS.state.activeSessionIdx = 0;
        window.__s2 = s2;
    });

    // ---- 1: the active session is the one `state.session` names ----
    //
    // Not index 0. The active index is whatever the user last clicked in the
    // session strip, so this makes session TWO active and asserts the pin moves
    // with it. A build that hard-coded row 0 passes every other check here.
    const pinned = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const O = await import('/ui/origin-definition.js');
        O.enterOriginMode();
        O.pickOriginNode(window.__floorId, 2);
        O.pickOriginAxis('negative');
        O.applyOrigin();

        const read = () => Array.from(
            document.querySelectorAll('#originRebaseBySession .origin-rebase-session-toggle'))
            .map(cb => ({ idx: Number(cb.dataset.sessionIndex),
                checked: cb.checked, disabled: cb.disabled }));

        // "Leftover" is active now. `state.session` is a plain property, not a
        // getter over `activeSessionIdx`, and `state.session` is what
        // `runSetCalibration` reads to decide whose cameras go in the file — so
        // that is the one the pin has to follow, or the pinned row and the
        // written calibration could name different sessions.
        const s1 = AS.state.session;
        AS.state.session = window.__s2;
        AS.state.activeSessionIdx = 1;
        document.getElementById('btnSetCalibration').click();
        const whenSecondActive = read();
        const noteSecond = (document.querySelector(
            '#originRebaseBySession') || {}).parentNode.querySelector(
            '.origin-rebase-block-note').textContent;
        document.getElementById('btnRebaseCancel').click();

        AS.state.session = s1;              // …and back
        AS.state.activeSessionIdx = 0;
        document.getElementById('btnSetCalibration').click();
        const whenFirstActive = read();
        const noteFirst = (document.querySelector(
            '#originRebaseBySession') || {}).parentNode.querySelector(
            '.origin-rebase-block-note').textContent;
        document.getElementById('btnRebaseCancel').click();
        return { whenSecondActive, whenFirstActive, noteSecond, noteFirst };
    });
    check(pinned.whenFirstActive.length === 2 && pinned.whenSecondActive.length === 2,
        `every session row carries a toggle (got ${pinned.whenFirstActive.length})`);
    check(pinned.whenFirstActive.every(c => c.checked) &&
          pinned.whenSecondActive.every(c => c.checked),
        'all of them on by default — re-basing everything stays the default answer');
    check(pinned.whenFirstActive[0].disabled && !pinned.whenFirstActive[1].disabled,
        `the ACTIVE session's toggle is disabled and the other is not ` +
        `(got ${JSON.stringify(pinned.whenFirstActive.map(c => c.disabled))})`);
    check(pinned.whenSecondActive[1].disabled && !pinned.whenSecondActive[0].disabled,
        `NEGATIVE CONTROL: with session 2 active the pin is on ROW 1, not row 0 ` +
        `(got ${JSON.stringify(pinned.whenSecondActive.map(c => c.disabled))})`);
    check(/"S1" is the active session/.test(pinned.noteFirst) &&
          /"Leftover" is the active session/.test(pinned.noteSecond),
        'and the block note names whichever session that is, so the disabled control ' +
        'is explained somewhere a disabled control can be');
    check(/always moves/.test(pinned.noteFirst) && /calibration file describes/.test(pinned.noteFirst),
        `saying why it cannot be turned off (got '${pinned.noteFirst.slice(0, 90)}...')`);
    // Rule 2 from CLAUDE.md, still true and still stated: the PlaneModel is
    // project-scoped, so plane nodes and fits are not a per-session row.
    check(/project-wide/i.test(pinned.noteFirst) && /not split/i.test(pinned.noteFirst),
        'while plane nodes and plane fits are still called out as project-wide');

    // ---- 2 + 3: the counts follow the selection, and so does the warning ----
    const toggled = await page.evaluate(async () => {
        const scrape = (id) => Array.from(document.querySelectorAll('#' + id + ' tr'))
            .map(tr => [tr.cells[0].textContent.replace(/\s+/g, ' ').trim(),
                tr.cells[1].textContent.trim()]);
        const cell = (id, label) => (scrape(id).find(r => r[0] === label) || [])[1];
        const warnState = () => {
            const w = document.getElementById('originRebaseSubsetWarning');
            if (!w) return { present: false };
            return { present: true, shown: w.style.display !== 'none',
                text: w.textContent };
        };
        const snapshot = () => ({
            points3d: cell('originRebaseCounts', '3D points to update'),
            keypoints: cell('originRebaseCounts', 'pose keypoints'),
            planeNodes: cell('originRebaseCounts', 'plane nodes'),
            extrinsics: cell('originRebaseCounts', 'Camera extrinsics'),
            intrinsics: cell('originRebaseKeeps', 'Camera intrinsics + distortion'),
            user2d: cell('originRebaseKeeps', 'User 2D instances'),
            pred2d: cell('originRebaseKeeps', 'Predicted 2D instances'),
            warn: warnState(),
            multi: (document.getElementById('originRebaseMultiNote') || {}).textContent || '',
        });

        document.getElementById('btnSetCalibration').click();
        const all = snapshot();

        const boxes = Array.from(document.querySelectorAll(
            '#originRebaseBySession .origin-rebase-session-toggle'));
        // A real click, not a property poke: the change listener is what has to
        // fire, and `.click()` on a DISABLED input is a no-op in the browser —
        // which is exactly what the active-session check below relies on.
        boxes[1].click();
        const partial = snapshot();

        boxes[0].click();                    // the ACTIVE one — must not budge
        const afterPokingActive = snapshot();
        const activeStillChecked = boxes[0].checked;

        boxes[1].click();                    // put it back
        const restored = snapshot();
        document.getElementById('btnRebaseCancel').click();
        return { all, partial, afterPokingActive, activeStillChecked, restored };
    });
    // 2 keypoints in S1 + 2 in Leftover + 4 plane nodes = 8; 2 + 3 = 5 cameras.
    check(toggled.all.points3d === '8' && toggled.all.extrinsics === '5 — rvec and tvec',
        `with everything selected the headline covers both sessions ` +
        `(got ${toggled.all.points3d} points, '${toggled.all.extrinsics}')`);
    check(toggled.partial.points3d === '6' && toggled.partial.keypoints === '2',
        `deselecting a session drops its 3D out of the headline (got ` +
        `${toggled.partial.points3d} points, ${toggled.partial.keypoints} keypoints)`);
    check(toggled.partial.extrinsics === '2 — rvec and tvec' &&
          toggled.partial.intrinsics === '2',
        `and its cameras out of BOTH tables — a camera that does not move is not ` +
        `listed as unchanged either (got '${toggled.partial.extrinsics}' / ` +
        `'${toggled.partial.intrinsics}')`);
    // The 2D inventory follows too. Both numbers include the UNLINKED pool —
    // section 1's 1 user + 5 predicted are still on the active session, and
    // "Leftover" brings 2 grouped user + 4 unlinked predicted — so 5/9 becomes
    // 3/5. 2D does not move; a wrong inventory just sends the user looking for
    // data the dialog says they do not have.
    check(toggled.all.user2d === '5 — 4 in instance groups' &&
          toggled.partial.user2d === '3 — 2 in instance groups',
        `the user 2D inventory follows the selection, unlinked pool included ` +
        `(got '${toggled.all.user2d}' -> '${toggled.partial.user2d}')`);
    check(toggled.all.pred2d === '9 — 0 in instance groups' &&
          toggled.partial.pred2d === '5 — 0 in instance groups',
        `and so does the predicted one (got '${toggled.all.pred2d}' -> ` +
        `'${toggled.partial.pred2d}')`);
    // The PROJECT-scoped half does NOT follow: one PlaneModel, moving once,
    // with the active session.
    check(toggled.all.planeNodes === '4' && toggled.partial.planeNodes === '4',
        `while the project-wide plane nodes are unchanged by the selection ` +
        `(got ${toggled.all.planeNodes} -> ${toggled.partial.planeNodes})`);
    check(parseInt(toggled.partial.keypoints, 10) + parseInt(toggled.partial.planeNodes, 10)
          === parseInt(toggled.partial.points3d, 10),
        'and the sub-rows still add up to the headline after a toggle');
    check(toggled.restored.points3d === '8' &&
          toggled.restored.extrinsics === '5 — rvec and tvec',
        `re-checking it puts the numbers back (got ${toggled.restored.points3d} points)`);

    check(toggled.all.warn.present && !toggled.all.warn.shown,
        'the hazard warning is SILENT while every session is selected');
    check(toggled.partial.warn.shown && /two different coordinate frames/i.test(toggled.partial.warn.text),
        `and appears the moment one is not, naming the consequence ` +
        `(got '${(toggled.partial.warn.text || '').slice(0, 80)}...')`);
    check(/^1 session will keep its current 3D/.test(toggled.partial.warn.text),
        `counting the sessions left behind (got '${(toggled.partial.warn.text || '').slice(0, 40)}...')`);
    check(/next time it loads/i.test(toggled.partial.warn.text),
        'and promising the note the loader will raise — the same divergence ' +
        'pose/calibration-compare.js detects');
    // SHORT, per the modal-verbosity rule: two sentences, no numbered list.
    check((toggled.partial.warn.text.match(/\./g) || []).length <= 2 &&
          !/originRebaseSubsetTodo/.test(toggled.partial.warn.text),
        `kept to two sentences (got ${(toggled.partial.warn.text.match(/\./g) || []).length})`);
    check(!toggled.restored.warn.shown, 'and it goes away again when nothing is deselected');

    check(/^All 2 loaded sessions are re-based/.test(toggled.all.multi),
        `the multi-session note says "all" when it is all (got '${toggled.all.multi.slice(0, 45)}...')`);
    check(/^1 of 2 loaded sessions are re-based/.test(toggled.partial.multi),
        `and counts them when it is not (got '${toggled.partial.multi.slice(0, 45)}...')`);
    check(/only the current session’s cameras are written to a new calibration file/
        .test(toggled.partial.multi),
        'while still saying only the current session\'s calibration is written');
    // The count in the trailing clauses is `picked - 1`, not `total - 1`: the
    // folders it names are the RE-BASED sessions other than the current one.
    // Here "Leftover" is deselected, so it keeps its old 3D AND its old
    // calibration.toml — which still agree — and the current session is the
    // only one that moved. NEGATIVE CONTROL for `total - 1`, which would print
    // "The other 1 session folder(s)" and send the user to update a folder that
    // is already consistent.
    check(!/session folder\(s\)/.test(toggled.partial.multi) &&
          !/Ensure other re-based sessions/.test(toggled.partial.multi),
        `and says nothing about other folders when the current session is the only one ` +
        `moving (got '${toggled.partial.multi}')`);
    check(/The other 1 session folder\(s\) keep their old calibration\.toml/
            .test(toggled.all.multi) &&
          /Ensure other re-based sessions have an updated calibration file in their folders/
            .test(toggled.all.multi),
        `while with both selected it counts the one other re-based folder and says to ` +
        `update it (got '...${toggled.all.multi.slice(45)}')`);

    // ---- 1 again: the active toggle is inert, and inert in the numbers too ----
    check(toggled.activeStillChecked,
        'clicking the ACTIVE session\'s toggle does not turn it off');
    check(toggled.afterPokingActive.points3d === toggled.partial.points3d &&
          toggled.afterPokingActive.extrinsics === toggled.partial.extrinsics,
        'and changes no count — it is disabled, not merely re-checked afterwards');

    // ---- 4: the commit leaves the deselected session alone ----
    const partialCommit = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const P = await import('/ui/plane-definition.js');
        const RB = await import('/ui/origin-rebase.js');

        RB.resetCalibrationHandle();
        let written = null;
        window.showSaveFilePicker = async (opts) => ({
            name: (opts && opts.suggestedName) || 'calibration.toml',
            createWritable: async () => ({
                write: async (txt) => { written = txt; },
                close: async () => {},
            }),
        });

        const s2 = window.__s2;
        const g2 = s2.instanceGroups.get(4)[0];
        const before = {
            s2pts: Array.from(g2.points3d),
            s2cams: s2.cameras.map(c => [c.rvec.slice(), c.tvec.slice()]),
            s2pix: s2.cameras.map(c => c.project([g2.points3d[0], g2.points3d[1], g2.points3d[2]])),
            s1pts: Array.from(AS.state.session.instanceGroups.get(0)[0].points3d),
            node: Array.from(P.planeModel().pool.nodes[0].xyz),
        };

        document.getElementById('btnSetCalibration').click();
        const boxes = Array.from(document.querySelectorAll(
            '#originRebaseBySession .origin-rebase-session-toggle'));
        boxes[1].click();                    // leave "Leftover" behind
        document.getElementById('btnRebaseContinue').click();

        const statusEl = document.getElementById('statusText') || document.getElementById('status');
        for (let i = 0; i < 400; i++) {
            if (/Set as new calibration/.test((statusEl || {}).textContent || '')) break;
            await new Promise(r => setTimeout(r, 25));
        }
        const after = {
            s2pts: Array.from(g2.points3d),
            s2cams: s2.cameras.map(c => [c.rvec.slice(), c.tvec.slice()]),
            s2pix: s2.cameras.map(c => c.project([g2.points3d[0], g2.points3d[1], g2.points3d[2]])),
            s1pts: Array.from(AS.state.session.instanceGroups.get(0)[0].points3d),
            node: Array.from(P.planeModel().pool.nodes[0].xyz),
        };
        AS.state.sessions = [AS.state.session];
        AS.state.activeSessionIdx = 0;
        return {
            before, after,
            status: (statusEl || {}).textContent || '',
            // Only the active session's three... two cameras belong in the file.
            camsInToml: (written || '').match(/^\[cam_/gm) ? (written || '').match(/^\[cam_/gm).length : 0,
            tomlNames: ((written || '').match(/name = "[^"]+"/g) || []),
        };
    });
    const same = (a, b) => a.length === b.length && a.every((v, i) =>
        (Number.isNaN(v) && Number.isNaN(b[i])) || v === b[i]);
    check(same(partialCommit.after.s2pts, partialCommit.before.s2pts),
        `the deselected session's 3D is BIT-IDENTICAL after the commit ` +
        `(${partialCommit.before.s2pts.slice(0, 3).map(v => v.toFixed(2)).join(',')})`);
    check(JSON.stringify(partialCommit.after.s2cams) === JSON.stringify(partialCommit.before.s2cams),
        'and so are its cameras — points and cameras stayed together by both staying put');
    check(JSON.stringify(partialCommit.after.s2pix) === JSON.stringify(partialCommit.before.s2pix),
        'so every pixel in it is exactly where it was, which is what keeps that session usable');
    // NEGATIVE CONTROL: the re-base has to have actually happened, or "nothing
    // moved in session 2" is true for the boring reason.
    check(!same(partialCommit.after.s1pts, partialCommit.before.s1pts),
        `while the CHOSEN session's 3D moved (z ${partialCommit.before.s1pts[2]} -> ` +
        `${partialCommit.after.s1pts[2].toFixed(3)})`);
    check(Math.hypot(...partialCommit.after.node.map((v, i) => v - partialCommit.before.node[i])) > 1,
        'and so did the project-wide plane pool, which moves with the active session');
    check(/and 2 cameras/.test(partialCommit.status),
        `the status reports the 2 cameras it moved, not all 5 ` +
        `(got '${partialCommit.status.slice(0, 110)}...')`);
    check(partialCommit.camsInToml === 2 &&
          !/"cA"|"cB"|"cC"/.test(partialCommit.tomlNames.join(' ')),
        `and the written TOML holds only the active session's cameras ` +
        `(got ${partialCommit.camsInToml}: ${partialCommit.tomlNames.join(' ')})`);

    console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} failure(s)`);
} catch (e) {
    console.log('\nFAIL — ' + (e && e.stack ? e.stack : e));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
process.exit(fails === 0 ? 0 : 1);
