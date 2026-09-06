/**
 * ungroup-retains-identity.mjs — real-browser regression test for luc3d #201.
 *
 * Bug (reported by an alpha tester asking "how does one swap IDs in only one
 * view?"): to change the ID of a single view's instance you must first ungroup,
 * but ungrouping reset the ID of EVERY row in the Ungrouped Instances table to
 * "—". The assignment wasn't just hidden, it was gone: `Session.unlinkGroup`
 * discards the InstanceGroup, and `group.identityId` is the only place a
 * group-level identity assignment lives. Every identity reader for an UNLINKED
 * instance goes through `frameIdentityMap` and has no group to fall back on, so
 * the ID was unrecoverable — making the ungroup step destructive.
 *
 * This drives the REAL UI path (`ui/ui-wiring.js` `unlinkGroup` — data model +
 * triangulation purge + panel/overlay/timeline refresh) and then reads the
 * actual `<select>` values rendered into the Ungrouped Instances table, which is
 * exactly what the tester was looking at.
 *
 * The fixture deliberately writes NO `frameIdentityMap` entries: the identity
 * lives only on `group.identityId`, which is the state that grouping paths
 * other than the tracker (`assignIdentityToGroup`, `createGroupFromUnlinked`)
 * leave behind — and the state in which the bug appears.
 *
 * Run: node tests/e2e/ungroup-retains-identity.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8232);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 300)); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- fixture: 3 cameras, 2 animals, both grouped WITH an identity -------
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = ['cam1', 'cam2', 'cam3'].map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [640, 480]));
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session(cams, skel, ['t0', 't1'], 'UngroupIdentity');

        const animalA = session.addIdentity('animal_A');
        const animalB = session.addIdentity('animal_B');

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const groups = [];
        [[animalA.id, 0], [animalB.id, 1]].forEach(([identityId, trackIdx], n) => {
            const g = new InstanceGroup(10 + n, identityId);
            for (const cn of ['cam1', 'cam2', 'cam3']) {
                const inst = new Instance([[1 + n, 2], [3, 4 + n]], trackIdx, 'predicted', 1);
                g.addInstance(cn, inst);
                fg.addInstance(cn, inst);
            }
            g.points3d = new Float64Array([1, 2, 3, 4, 5, 6]);
            groups.push(g);
        });
        session.instanceGroups.set(0, groups);
        // NOTE: deliberately no setFrameIdentity calls — identity lives only on
        // group.identityId, the state in which #201 reproduces.

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = [];
    });

    // Sanity: the GROUPED rows show the identity to begin with, so a later "—"
    // is a loss caused by ungrouping and not an empty fixture.
    const before = await page.evaluate(async () => {
        const ip = await import('/ui/info-panel.js');
        ip.updateInfoPanel();
        const names = (window.__lucid.state.session.instanceGroups.get(0) || [])
            .map(g => {
                const i = window.__lucid.state.session.getIdentity(g.identityId);
                return i ? i.name : null;
            });
        return { groupIdentities: names };
    });
    check(before.groupIdentities.join(',') === 'animal_A,animal_B',
        `precondition: both groups carry an identity (got ${JSON.stringify(before.groupIdentities)})`);

    // ---- the real UI ungroup, on BOTH groups (the tester's step 1) ----------
    const after = await page.evaluate(async () => {
        const wiring = await import('/ui/ui-wiring.js');
        const ip = await import('/ui/info-panel.js');
        const s = window.__lucid.state.session;
        for (const g of [...(s.instanceGroups.get(0) || [])]) wiring.unlinkGroup(g);
        ip.updateInfoPanel();

        // Read the Ungrouped Instances table exactly as the tester sees it.
        // Row layout (ui/info-panel.js): [Track <select>, ID <select>, Type,
        // Points, Score]; camera header rows have a single colSpan cell.
        const rows = [];
        let camera = null;
        for (const tr of document.querySelectorAll('#unlinkedTable tbody tr')) {
            if (tr.classList.contains('unlinked-camera-header')) { camera = tr.textContent.trim(); continue; }
            const sels = tr.querySelectorAll('select');
            const idSel = sels[1];
            const opt = idSel ? idSel.options[idSel.selectedIndex] : null;
            rows.push({ camera, id: opt ? opt.textContent : null });
        }
        return {
            rows,
            groupsLeft: (s.instanceGroups.get(0) || []).length,
            unlinkedTableVisible: document.getElementById('unlinkedTable').style.display !== 'none',
        };
    });

    check(after.groupsLeft === 0, `both groups were ungrouped (got ${after.groupsLeft} left)`);
    check(after.unlinkedTableVisible, 'the Ungrouped Instances table is showing');
    check(after.rows.length === 6, `6 ungrouped rows — 2 animals x 3 cameras (got ${after.rows.length})`);
    console.log('    rows:', JSON.stringify(after.rows));

    const dashes = after.rows.filter(r => r.id === '—' || r.id === null);
    check(dashes.length === 0,
        `no row lost its ID to "—" (got ${dashes.length} of ${after.rows.length})`);

    const names = after.rows.map(r => r.id).sort();
    check(names.filter(n => n === 'animal_A').length === 3,
        `animal_A retained in all 3 views (got ${names.filter(n => n === 'animal_A').length})`);
    check(names.filter(n => n === 'animal_B').length === 3,
        `animal_B retained in all 3 views (got ${names.filter(n => n === 'animal_B').length})`);

    // ---- step 2: switch the ID on ONE view, via the real dropdown ----------
    // This is the tester's actual question ("how does one swap IDs in only one
    // view?"): change cam2's animal_A row to animal_B and leave cam1/cam3 alone.
    const oneView = await page.evaluate(async () => {
        const ip = await import('/ui/info-panel.js');
        const s = window.__lucid.state.session;
        const byName = n => s.identities.find(i => i.name === n);

        // Find cam2's row for animal_A and drive its ID <select> like a user.
        let camera = null, target = null;
        for (const tr of document.querySelectorAll('#unlinkedTable tbody tr')) {
            if (tr.classList.contains('unlinked-camera-header')) { camera = tr.textContent.trim(); continue; }
            const sels = tr.querySelectorAll('select');
            const idSel = sels[1];
            if (camera === 'cam2' && idSel && idSel.options[idSel.selectedIndex].textContent === 'animal_A') {
                target = idSel; break;
            }
        }
        if (!target) return { error: 'no cam2 animal_A row found' };
        target.value = String(byName('animal_B').id);
        target.dispatchEvent(new Event('change', { bubbles: true }));

        ip.updateInfoPanel();
        const rows = [];
        let cam = null;
        for (const tr of document.querySelectorAll('#unlinkedTable tbody tr')) {
            if (tr.classList.contains('unlinked-camera-header')) { cam = tr.textContent.trim(); continue; }
            const sels = tr.querySelectorAll('select');
            const idSel = sels[1];
            rows.push({
                camera: cam,
                track: sels[0] ? sels[0].options[sels[0].selectedIndex].textContent : null,
                id: idSel ? idSel.options[idSel.selectedIndex].textContent : null,
            });
        }
        return { rows, status: (document.getElementById('statusText') || {}).textContent || null };
    });
    check(!oneView.error, `found and drove cam2's animal_A dropdown (${oneView.error || 'ok'})`);
    console.log('    after 1-view switch:', JSON.stringify(oneView.rows));
    console.log('    status:', JSON.stringify(oneView.status));

    const idOf = (cam, track) => (oneView.rows.find(r => r.camera === cam && r.track === track) || {}).id;
    // cam2 is swapped...
    check(idOf('cam2', 't0') === 'animal_B',
        `cam2's t0 row now reads animal_B (got ${JSON.stringify(idOf('cam2', 't0'))})`);
    check(idOf('cam2', 't1') === 'animal_A',
        `cam2's OTHER row took the vacated ID, so the view has no duplicate (got ${JSON.stringify(idOf('cam2', 't1'))})`);
    // ...and the other two views are untouched. This is the assertion that
    // fails if the switch escalates to #172's all-views swap.
    for (const cam of ['cam1', 'cam3']) {
        check(idOf(cam, 't0') === 'animal_A',
            `${cam} was NOT touched — t0 still animal_A (got ${JSON.stringify(idOf(cam, 't0'))})`);
        check(idOf(cam, 't1') === 'animal_B',
            `${cam} was NOT touched — t1 still animal_B (got ${JSON.stringify(idOf(cam, 't1'))})`);
    }
    check(oneView.status == null || /cam2 only/.test(oneView.status),
        `the status line names the real scope, not "all views" (got ${JSON.stringify(oneView.status)})`);

    // ---- step 3: regroup must not rename the animal ------------------------
    const regrouped = await page.evaluate(async () => {
        const s = window.__lucid.state.session;
        const fg = s.getFrameGroup(0);
        // Regroup the three views that now all read animal_A: cam1/cam3 track 0
        // plus cam2's track 1, which took animal_A in the one-view switch.
        const picked = [
            (fg.getUnlinkedInstances('cam1') || []).find(ul => ul.instance.trackIdx === 0),
            (fg.getUnlinkedInstances('cam2') || []).find(ul => ul.instance.trackIdx === 1),
            (fg.getUnlinkedInstances('cam3') || []).find(ul => ul.instance.trackIdx === 0),
        ];
        const g = s.createGroupFromUnlinked(0, picked);
        const ident = s.getIdentity(g.identityId);
        return { name: ident ? ident.name : null, members: g.instances.size };
    });
    check(regrouped.members === 3, `regrouped 3 views (got ${regrouped.members})`);
    check(regrouped.name === 'animal_A',
        `regrouping keeps the animal's ID instead of renaming it (got ${JSON.stringify(regrouped.name)})`);

    // ---- guard: a GROUPED switch is still ALL VIEWS (luc3d #172) -----------
    // `applyIdentitySwitch` is shared, so scoping the unlinked row must not have
    // narrowed the group path.
    const groupedScope = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const ia = await import('/ui/identity-assignment.js');
        const { Instance, InstanceGroup, FrameGroup } = pd;
        const s = window.__lucid.state.session;
        const byName = n => s.identities.find(i => i.name === n);
        const A = byName('animal_A').id, B = byName('animal_B').id;

        // A fresh frame with two identified groups, all three views each.
        const fg = new FrameGroup(1);
        s.addFrameGroup(fg);
        const groups = [];
        [[A, 20], [B, 21]].forEach(([identityId, trackIdx], n) => {
            const g = new InstanceGroup(50 + n, identityId);
            for (const cn of ['cam1', 'cam2', 'cam3']) {
                const inst = new Instance([[1, 2], [3, 4]], trackIdx, 'predicted', 1);
                g.addInstance(cn, inst);
                fg.addInstance(cn, inst);
                s.setFrameIdentity(1, cn, trackIdx, identityId);
            }
            groups.push(g);
        });
        s.instanceGroups.set(1, groups);

        // Switch group A -> animal_B with NO camera scope, as the grouped row does.
        const pairs = [...groups[0].instances].map(([cn, i]) => [cn, i.trackIdx]);
        const res = ia.applyIdentitySwitch(s, 1, pairs, groups[0], B);
        return {
            camera: res.camera,
            perCam: ['cam1', 'cam2', 'cam3'].map(cn => ({
                cam: cn,
                t20: s.getIdentityIdForTrack(cn, 20, 1),
                t21: s.getIdentityIdForTrack(cn, 21, 1),
            })),
            A, B,
        };
    });
    check(groupedScope.camera === null,
        `a grouped switch reports no camera scope (got ${JSON.stringify(groupedScope.camera)})`);
    const allSwapped = groupedScope.perCam.every(
        r => r.t20 === groupedScope.B && r.t21 === groupedScope.A);
    check(allSwapped,
        `a grouped switch still swaps in EVERY view (got ${JSON.stringify(groupedScope.perCam)})`);

    check(errs.length === 0, `no page/console errors (got ${JSON.stringify(errs.slice(0, 3))})`);

    await browser.close();
} finally {
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
