/**
 * skeleton-edit-warning.mjs — editing the skeleton confirms against what it
 * will re-shape, and applies to every session when it does.
 *
 * The Skeleton tab's node/edge controls look like settings and are not. The
 * skeleton is the shape every annotation in the project is stored against
 * (`Instance` keeps one flat `Float64Array(2N)` keyed by node INDEX), and LUCID
 * is one skeleton per project, so a node typed into that box re-shapes every
 * instance in every loaded session at once. Before this dialog the only signal
 * was a `console.warn`.
 *
 * What this pins, in the REAL app:
 *
 *  1. All five edits — add node, remove node, rename node, add edge, remove
 *     edge — raise the dialog, with copy naming the one being made.
 *  2. The counts are the WHOLE project: both sessions, grouped and ungrouped
 *     instances alike, with a per-session block that says WHICH session each
 *     number is in and prints no Total row of its own (the whole-project block
 *     above it IS the total). A dialog quoting only the open session would
 *     understate the edit by however many sessions are loaded.
 *  3. Esc and Cancel leave the project BYTE-IDENTICAL — the skeleton, every
 *     instance's node count, and the 3D. This is the control that keeps the
 *     dialog from being a cosmetic wrapper around an edit that already
 *     happened.
 *  4. Confirming applies to ALL sessions, and a new node lands HIDDEN on a
 *     hand-labelled instance: positioned, so it draws a clickable marker, and
 *     in `nulledNodes`, so it draws grey and feeds no triangulation. An empty
 *     slot draws nothing, and a node that draws nothing can never be clicked —
 *     which would make the node the user just added permanently unplaceable.
 *  5. A LAZY project gets the red "strongly not recommended" warning, naming
 *     the frames that would keep the OLD skeleton. NEGATIVE CONTROL: a
 *     fully-resident project does not, because a warning that fires when
 *     nothing is wrong is a warning nobody reads.
 *  6. A project with nothing annotated raises NO dialog. Building the first
 *     skeleton is N node names typed into a box, and a modal per node would
 *     make the feature unusable.
 *  7. "Do not show again" is cached in `localStorage` and recorded only when
 *     the edit is APPLIED — ticked and then cancelled it does nothing — and the
 *     Skeleton tab's `#skeletonWarnOffNote` turns it back on. A preference you
 *     can set and never unset is a trap, and this one hides a warning about
 *     silent data loss.
 *
 * Run: node skeleton-edit-warning.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8247);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
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
    // §9 writes `skeletonEditWarningOff`. A fresh context starts clean, but
    // clear it anyway so a re-run against a persisted profile cannot start with
    // the dialog already suppressed and pass every "no modal" check for free.
    await page.evaluate(() => { try { localStorage.removeItem('skeletonEditWarningOff'); } catch (e) {} });

    // ---- a two-session project on ONE shared skeleton -------------------
    //
    // Session A: one triangulated group (a USER instance in cam1, a predicted
    // one in cam2) plus one ungrouped prediction. Session B: one ungrouped
    // user instance. That is 3 user + 2 predicted across the project, and
    // exactly the mix that catches a tally built from group members alone.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const IP = await import('/ui/info-panel.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, UnlinkedInstance, Session } = pd;
        const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
        const cams = () => ['cam1', 'cam2'].map((n, i) =>
            new Camera(n, mtx, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [512, 512]));
        const skel = new Skeleton('mouse', ['nose', 'tail'], [[0, 1]]);

        const A = new Session(cams(), skel, ['t0'], 'sessionA');
        const fgA = new FrameGroup(0); A.addFrameGroup(fgA);
        const u1 = new Instance([[100, 100], [100, 140]], 0, 'user', 1);
        const p1 = new Instance([[120, 100], [120, 140]], 0, 'predicted', 0.9);
        const gA = new InstanceGroup(1, -1);
        gA.addInstance('cam1', u1); gA.addInstance('cam2', p1);
        fgA.addInstance('cam1', u1); fgA.addInstance('cam2', p1);
        gA.points3d = new Float64Array([1, 1, 1, 2, 2, 2]);
        gA.addReprojectedInstance('cam1', new Instance([[0, 0], [0, 0]], 0, 'reprojected', 1));
        A.instanceGroups.set(0, [gA]);
        fgA.addUnlinkedInstance('cam1', new UnlinkedInstance(
            new Instance([[9, 9], [9, 9]], 0, 'predicted', 0.5), 'cam1'));

        const B = new Session(cams(), skel, ['t0'], 'sessionB');
        const fgB = new FrameGroup(0); B.addFrameGroup(fgB);
        const u2 = new Instance([[200, 200], [200, 240]], 0, 'user', 1);
        fgB.addUnlinkedInstance('cam1', new UnlinkedInstance(u2, 'cam1'));

        AS.state.sessions = [A, B];
        AS.state.session = A;
        AS.state.activeSessionIdx = 0;
        AS.state.currentFrame = 0;
        AS.setProjectSkeleton(skel);
        IP.populateSkeletonTable();
        window.__t = { A, B, skel, u1, p1, u2, gA };
    });

    // The Skeleton tab, since the edit controls live in it and Playwright will
    // not type into a hidden input.
    await page.click('.panel-tab[data-tab="tabSkeleton"]');
    await page.waitForTimeout(120);

    const modalOpen = () => page.evaluate(() => !!document.getElementById('skeletonEditConfirm'));
    const modalText = () => page.evaluate(() => {
        const el = document.getElementById('skeletonEditConfirm');
        return el ? el.innerText : '';
    });
    const rowValue = (tableId, label) => page.evaluate(([tid, lbl]) => {
        const t = document.getElementById(tid);
        if (!t) return null;
        for (const tr of t.querySelectorAll('tr')) {
            const td = tr.querySelectorAll('td');
            if (td.length === 2 && td[0].textContent.trim() === lbl) return td[1].textContent.trim();
        }
        return null;
    }, [tableId, label]);
    const shape = () => page.evaluate(() => {
        const t = window.__t;
        return {
            nodes: t.skel.nodes.join(','),
            edges: JSON.stringify(t.skel.edges),
            u1: t.u1.numNodes, p1: t.p1.numNodes, u2: t.u2.numNodes,
            pts3d: Array.from(t.gA.points3d).join(','),
            sameObject: t.A.skeleton === t.skel && t.B.skeleton === t.skel,
        };
    });
    const openAddNode = async (name) => {
        await page.fill('#nodeNameInput', name);
        await page.click('#btnAddNode');
        await page.waitForTimeout(80);
    };

    console.log('\n--- 1. Adding a node raises the dialog, naming the edit ---');
    const before = await shape();
    check(before.sameObject === true, 'both sessions start on the one shared skeleton object');
    await openAddNode('ear');
    check(await modalOpen() === true, 'the dialog opened instead of applying straight away');
    let txt = await modalText();
    check(/Add node .?ear.? to the skeleton\?/.test(txt),
        'its title names the node being added');
    check(/switched off/i.test(txt),
        'and its one-sentence lead says the node arrives switched off on hand-labelled instances');
    // The dialog is a title, one sentence and the COUNTS. A bulleted "What
    // changes" list and an always-on "there is no undo" caution both used to
    // sit between the lead and the numbers; copy like that creeps back one
    // paragraph at a time, so their ABSENCE is asserted rather than assumed.
    check(/What changes/i.test(txt) === false, 'no bulleted "What changes" block');
    check(/no undo/i.test(txt) === false, 'and no always-on caution box');

    console.log('\n--- 2. The counts are the WHOLE project, not the open session ---');
    check(await rowValue('skeletonEditTotals', 'Sessions on this skeleton') === '2',
        'both sessions are in scope');
    check(await rowValue('skeletonEditTotals', 'User 2D instances') === '2',
        'two user instances — one in each session (the second is UNGROUPED)');
    check(await rowValue('skeletonEditTotals', 'Predicted 2D instances') === '2',
        'two predicted — one grouped, one ungrouped; counting group members alone would say 1');
    check(await rowValue('skeletonEditTotals', 'Instance groups (3D)') === '1',
        'one instance group');
    check(await rowValue('skeletonEditTotals', 'Cached reprojections') === '1',
        'one cached reprojection, which the edit will invalidate');

    console.log('\n--- 2b. The by-session block says WHICH session, and nothing else ---');
    const perA = await rowValue('skeletonEditBySession', 'sessionA');
    const perB = await rowValue('skeletonEditBySession', 'sessionB');
    check(perA === '1 user · 2 pred · 1 3D', `sessionA's own row (got ${perA})`);
    check(perB === '1 user · 0 pred · 0 3D', `sessionB's own row (got ${perB})`);
    // The rows still sum to the whole-project block — that is the invariant —
    // but the block does NOT print the sum itself. A Total row here is the
    // table above restated a few rows down, which invites the reader to check
    // one against the other instead of reading either.
    check(await rowValue('skeletonEditBySession', 'Total') === null,
        'and carries no Total row: the whole-project block above IS the total');
    check(await page.evaluate(() =>
        document.querySelector('#btnSkeletonEditConfirm').textContent) === 'Apply to all 2 sessions',
        'the confirm button says how far the edit reaches');

    console.log('\n--- 2c. NEGATIVE CONTROL: no lazy warning on a resident project ---');
    check(await page.evaluate(() => !!document.getElementById('skeletonEditLazyWarning')) === false,
        'nothing here is lazy, so the red warning is absent');

    console.log('\n--- 3. Esc leaves the project byte-identical ---');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    check(await modalOpen() === false, 'Esc closes it');
    check(JSON.stringify(await shape()) === JSON.stringify(before),
        'and nothing moved: the skeleton, every instance node count and the 3D are unchanged');

    console.log('\n--- 3b. Cancel is the same control ---');
    await openAddNode('ear');
    await page.click('#btnSkeletonEditCancel');
    await page.waitForTimeout(80);
    check(await modalOpen() === false, 'Cancel closes it');
    check(JSON.stringify(await shape()) === JSON.stringify(before), 'and changes nothing either');

    console.log('\n--- 4. Confirming applies to EVERY session, with the node hidden ---');
    await openAddNode('ear');
    await page.click('#btnSkeletonEditConfirm');
    await page.waitForTimeout(120);
    const after = await page.evaluate(() => {
        const t = window.__t;
        const hiddenOn = (i) => ({
            n: i.numNodes,
            placed: i.hasPoint(2),
            nulled: !!(i.nulledNodes && i.nulledNodes.has(2)),
            xy: i.hasPoint(2) ? [i.getX(2), i.getY(2)] : null,
        });
        return {
            nodes: t.skel.nodes.join(','),
            sameObject: t.A.skeleton === t.skel && t.B.skeleton === t.skel,
            u1: hiddenOn(t.u1), p1: hiddenOn(t.p1), u2: hiddenOn(t.u2),
            pts3dLen: t.gA.points3d.length,
            pts3dKept: Array.from(t.gA.points3d.slice(0, 6)).join(','),
            newKeypointAbsent: Number.isNaN(t.gA.points3d[6]),
            // Whatever is in the cache NOW must be at the new node count. The
            // edit clears it; the renderer's lazy fill may already have
            // refilled it from the re-shaped 3D by the time this reads, and
            // that is the correct outcome — what must never survive is an
            // instance still carrying the OLD node count, which would draw the
            // previous skeleton over the new one.
            reprojNodeCounts: Array.from(t.gA.reprojectedInstances.values())
                .map((i) => i.numNodes).join(','),
            dirty: t.gA.dirty,
            rows: document.querySelectorAll('#skeletonNodesTable tbody tr').length,
        };
    });
    check(after.nodes === 'nose,tail,ear', 'the node is on the skeleton');
    check(after.sameObject === true, 'and both sessions still point at that one object');
    check(after.u1.n === 3 && after.p1.n === 3 && after.u2.n === 3,
        'every instance in BOTH sessions was re-shaped — including the ungrouped ones');
    check(after.u1.placed === true && after.u1.nulled === true,
        'the hand-labelled instance in session A got the node PLACED and switched off');
    check(after.u2.placed === true && after.u2.nulled === true,
        'and so did the one in session B, which is in no instance group at all');
    check(after.p1.placed === false && after.p1.nulled === false,
        'the PREDICTED instance got an empty slot — nothing is invented for a model output');
    const d = Math.hypot(after.u1.xy[0] - 100, after.u1.xy[1] - 120);
    check(Math.abs(d - 20) < 1.5,
        `the hidden node sits beside the animal, not at the origin (got ${d.toFixed(1)}px from the centroid)`);
    check(after.pts3dLen === 9 && after.pts3dKept === '1,1,1,2,2,2' && after.newKeypointAbsent,
        'the 3D grew by one absent keypoint and kept every solved one');
    check(/^(3(,3)*)?$/.test(after.reprojNodeCounts),
        'no cached reprojection survives at the OLD node count ' +
        `(got [${after.reprojNodeCounts}], skeleton is 3 nodes)`);
    check(after.dirty === true, 'and the group is marked for re-triangulation');
    check(after.rows === 3, 'and the Nodes table repainted with the new row');

    console.log('\n--- 5. The other four edits raise it too, with their own copy ---');
    // Rename: the field's `change` event is what the user produces by typing
    // and leaving, so drive it that way rather than calling the handler.
    await page.fill('#skeletonNodesTable tbody tr:first-child input', 'snout');
    await page.click('#nodeNameInput');
    await page.waitForTimeout(80);
    check(await modalOpen() === true, 'renaming a node raises it');
    txt = await modalText();
    check(/Rename node to .?snout.?\?/.test(txt), 'with the rename title');
    check(/No coordinates move/.test(txt),
        'and it says plainly that a rename moves nothing — the hazard is the NAME');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
    check(await page.evaluate(() => window.__t.skel.nodes[0]) === 'nose',
        'Esc leaves the old name');
    check(await page.evaluate(() =>
        document.querySelector('#skeletonNodesTable tbody tr:first-child input').value) === 'nose',
        'and puts the typed text back in the field, so it cannot show a name the skeleton lacks');

    await page.selectOption('#edgeSrcSelect', '0');
    await page.selectOption('#edgeDstSelect', '2');
    await page.click('#btnAddEdge');
    await page.waitForTimeout(80);
    check(await modalOpen() === true, 'adding an edge raises it');
    check(/Add edge .?nose . ear.?\?/.test(await modalText()), 'naming both endpoints');
    await page.click('#btnSkeletonEditConfirm');
    await page.waitForTimeout(80);
    check(await page.evaluate(() => JSON.stringify(window.__t.skel.edges)) === '[[0,1],[0,2]]',
        'and confirming adds it');

    await page.click('#skeletonEdgesTable tbody tr:last-child button');
    await page.waitForTimeout(80);
    check(await modalOpen() === true, 'removing an edge raises it');
    check(/Remove edge .?nose . ear.?\?/.test(await modalText()), 'naming the edge');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
    check(await page.evaluate(() => JSON.stringify(window.__t.skel.edges)) === '[[0,1],[0,2]]',
        'and Esc keeps it');

    console.log('\n--- 6. Removing a node: the destructive one ---');
    await page.click('#skeletonNodesTable tbody tr:last-child button');
    await page.waitForTimeout(80);
    check(await modalOpen() === true, 'removing a node raises it');
    txt = await modalText();
    check(/Remove node .?ear.? from the skeleton\?/.test(txt), 'naming the node');
    check(/deletes that node.s 2D and 3D coordinates/.test(txt),
        'and saying what is deleted — the destructive edit is the one whose lead names losses');
    await page.click('#btnSkeletonEditConfirm');
    await page.waitForTimeout(120);
    const removed = await page.evaluate(() => {
        const t = window.__t;
        return {
            nodes: t.skel.nodes.join(','),
            edges: JSON.stringify(t.skel.edges),
            u1: t.u1.numNodes, u2: t.u2.numNodes,
            nulled: t.u1.nulledNodes ? Array.from(t.u1.nulledNodes).join(',') : '',
            pts3d: Array.from(t.gA.points3d).join(','),
        };
    });
    check(removed.nodes === 'nose,tail', 'the node is gone from the skeleton');
    check(removed.edges === '[[0,1]]', 'with the edge that referenced it');
    check(removed.u1 === 2 && removed.u2 === 2, 'and from every instance in both sessions');
    check(removed.nulled === '', 'the hidden flag went with it rather than re-seating onto a neighbour');
    check(removed.pts3d === '1,1,1,2,2,2',
        'the 3D kept both solved keypoints — one deleted node must not cost the project its triangulation');

    console.log('\n--- 7. A LAZY project gets the loud warning ---');
    await page.evaluate(() => {
        // Stand-in for `SioLazyLoader` with the two members the tally reads.
        // 2 resident frame groups across the project, 180,210 frames in the file.
        window.__t.A.lazyLoader = {
            nFrames: 180210,
            forEachInstanceRow(fn) { for (let i = 0; i < 400; i++) fn('cam1', i, 0, { type: 'predicted' }); },
        };
    });
    await openAddNode('whisker');
    check(await modalOpen() === true, 'the dialog opens');
    const lazyTxt = await page.evaluate(() => {
        const el = document.getElementById('skeletonEditLazyWarning');
        return el ? el.textContent : null;
    });
    check(lazyTxt !== null, 'and carries the red lazy warning');
    check(/Strongly not recommended/.test(lazyTxt || ''),
        'which advises against the edit outright');
    check(/180,209 frames/.test(lazyTxt || ''),
        `naming the frames that would keep the OLD skeleton (got: ${(lazyTxt || '').slice(0, 160)})`);
    check(await rowValue('skeletonEditTotals', 'Predicted 2D instances') === '400',
        'and the 2D count now comes from the STORE, not the resident window');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
    await page.evaluate(() => { delete window.__t.A.lazyLoader; });

    console.log('\n--- 8. Nothing annotated means no dialog at all ---');
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const IP = await import('/ui/info-panel.js');
        const { Skeleton, Camera, Session } = pd;
        const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
        const empty = new Session([new Camera('cam1', mtx, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [512, 512])],
            new Skeleton('fresh', [], []), ['t0'], 'fresh');
        AS.state.sessions = [empty];
        AS.state.session = empty;
        AS.state.activeSessionIdx = 0;
        AS.setProjectSkeleton(empty.skeleton);
        IP.populateSkeletonTable();
        window.__t = { skel: empty.skeleton };
    });
    await openAddNode('nose');
    check(await modalOpen() === false,
        'building the first skeleton raises no modal — a dialog per node typed would be unusable');
    check(await page.evaluate(() => window.__t.skel.nodes.join(',')) === 'nose',
        'and the node was added straight through');

    console.log('\n--- 9. "Do not show again" ---');
    // Back to a project with annotation in it, so the dialog is in play again.
    const reAnnotate = () => page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const IP = await import('/ui/info-panel.js');
        const { Skeleton, Camera, Instance, FrameGroup, UnlinkedInstance, Session } = pd;
        const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
        const skel = new Skeleton('mouse', ['nose', 'tail'], [[0, 1]]);
        const S = new Session([new Camera('cam1', mtx, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [512, 512])],
            skel, ['t0'], 'solo');
        const fg = new FrameGroup(0); S.addFrameGroup(fg);
        fg.addUnlinkedInstance('cam1', new UnlinkedInstance(
            new Instance([[10, 10], [10, 50]], 0, 'user', 1), 'cam1'));
        AS.state.sessions = [S];
        AS.state.session = S;
        AS.state.activeSessionIdx = 0;
        AS.setProjectSkeleton(skel);
        IP.populateSkeletonTable();
        window.__t = { skel };
    });
    const noteShown = () => page.evaluate(() => {
        const el = document.getElementById('skeletonWarnOffNote');
        return !!el && el.style.display !== 'none';
    });

    await reAnnotate();
    check(await noteShown() === false,
        'with warnings on, the Skeleton tab carries no "warnings are off" note');

    // CONTROL: ticked and then CANCELLED records nothing. "Do not show this
    // again" alongside "do not do this" is two different intentions, and
    // guessing which one won would silence a warning about silent data loss on
    // the strength of a dialog the user rejected.
    await openAddNode('ear');
    check(await modalOpen() === true, 'the dialog opens');
    await page.check('#skeletonEditDontAsk');
    await page.click('#btnSkeletonEditCancel');
    await page.waitForTimeout(80);
    await openAddNode('ear');
    check(await modalOpen() === true,
        'ticking the box and then CANCELLING suppresses nothing — the dialog is back');

    // Ticked and APPLIED: recorded.
    await page.check('#skeletonEditDontAsk');
    await page.click('#btnSkeletonEditConfirm');
    await page.waitForTimeout(120);
    check(await page.evaluate(() => window.__t.skel.nodes.join(',')) === 'nose,tail,ear',
        'the edit still went through');
    check(await page.evaluate(() => {
        try { return localStorage.getItem('skeletonEditWarningOff'); } catch (e) { return 'threw'; }
    }) === '1', 'and the preference is cached in localStorage, not in the project');

    await openAddNode('whisker');
    check(await modalOpen() === false, 'the next edit raises no dialog');
    check(await page.evaluate(() => window.__t.skel.nodes.join(',')) === 'nose,tail,ear,whisker',
        'and applies straight through');

    // The way back on, where the thing it governs happens.
    check(await noteShown() === true,
        'the Skeleton tab now says warnings are off');
    await page.click('#btnSkeletonWarnOn');
    await page.waitForTimeout(80);
    check(await noteShown() === false, 'turning them back on hides the note');
    await openAddNode('tip');
    check(await modalOpen() === true, 'and the dialog is back');
    await page.keyboard.press('Escape');

    console.log(fails === 0 ? '\nPASS — 0 failure(s)' : `\nFAIL — ${fails} failure(s)`);
} catch (err) {
    console.log('  ✗ threw: ' + (err && err.message ? err.message : String(err)));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
process.exit(fails === 0 ? 0 : 1);
