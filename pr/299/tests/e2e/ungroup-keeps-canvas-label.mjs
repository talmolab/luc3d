/**
 * ungroup-keeps-canvas-label.mjs — real-browser regression test for the
 * reported "the label disappeared from the mouse altogether" bug.
 *
 * Reported workflow: to give one view's detection the right ID you must ungroup
 * first (luc3d #201 — ungroup, fix the view that's wrong, regroup). The moment
 * the group broke, the "track_1" pill vanished from the animal in the video, so
 * with several detached detections on screen there was no way to tell which one
 * matched which Ungrouped Instances row — and therefore no way to know which
 * row to assign.
 *
 * The skeleton kept rendering (dashed edges, "?" badge), and the DATA was
 * intact the whole time — `unlinkGroup` keeps `trackIdx` and retains the
 * identity. What was missing was purely the drawing: `drawFrameOverlays`
 * labelled its LINKED user instances (section 4a, `drawInstanceLabels`) but
 * handed the unlinked pool to `drawUnlinkedInstances` (4b), which drew the "?"
 * badge and per-NODE names and no track pill at all.
 *
 * This drives the REAL render path — `ui/rendering.js` `drawAllOverlays` over
 * real view canvases, and `ui/ui-wiring.js` `unlinkGroup` for the ungroup — and
 * records what actually reached `fillText`. Both display modes are checked,
 * because the two states resolve their name differently (track name vs
 * identity) and the whole point is that an ungroup changes neither.
 *
 * Run: node tests/e2e/ungroup-keeps-canvas-label.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8241);
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

    // ---- fixture: 2 cameras, one animal on raw track 1, grouped with an ID --
    //
    // Deliberately NO setFrameIdentity: the identity lives only on
    // `group.identityId`, which is what every non-tracker grouping path
    // (`createGroupFromUnlinked`, the Group button) leaves behind.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = ['cam1', 'cam2'].map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [640, 480]));
        const skel = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
        const session = new Session(cams, skel, ['track_0', 'track_1'], 'UngroupLabel');
        const animalA = session.addIdentity('animal_A');

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const g = new InstanceGroup(10, animalA.id);
        for (const cn of ['cam1', 'cam2']) {
            const inst = new Instance([[160, 160], [260, 260]], 1, 'user', 1);
            g.addInstance(cn, inst);
            fg.addInstance(cn, inst);
        }
        session.instanceGroups.set(0, [g]);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();

        // Real view canvases, the shape `drawAllOverlays` expects.
        AS.state.views = cams.map(c => {
            const canvas = document.createElement('canvas');
            canvas.width = 640; canvas.height = 480;
            canvas.style.width = '640px'; canvas.style.height = '480px';
            canvas.style.position = 'fixed'; canvas.style.left = '-9999px';
            document.body.appendChild(canvas);
            return {
                name: c.name, overlayCanvas: canvas, overlayCtx: canvas.getContext('2d'),
                videoWidth: 640, videoHeight: 480, zoom: { scale: 1 },
            };
        });

        // Record every string that reaches the canvas, across ALL contexts.
        const proto = CanvasRenderingContext2D.prototype;
        const origFill = proto.fillText;
        window.__texts = [];
        proto.fillText = function (t, x, y) { window.__texts.push(String(t)); return origFill.call(this, t, x, y); };
    });

    const draw = async (colorByIdentity) => page.evaluate(async (byId) => {
        const AS = await import('/ui/app-state.js');
        const rendering = await import('/ui/rendering.js');
        AS.state.colorByIdentity = byId;
        window.__texts = [];
        rendering.drawAllOverlays(0);
        return window.__texts.slice();
    }, colorByIdentity);

    // ---- Tracks mode: grouped baseline, then the ungroup --------------------
    const tracksBefore = await draw(false);
    check(tracksBefore.includes('track_1'),
        `baseline: the grouped animal is labeled track_1 (got ${JSON.stringify(tracksBefore)})`);

    const ungrouped = await page.evaluate(async () => {
        const wiring = await import('/ui/ui-wiring.js');
        const s = window.__lucid.state.session;
        for (const g of [...(s.instanceGroups.get(0) || [])]) wiring.unlinkGroup(g);
        const fg = s.getFrameGroup(0);
        return {
            groupsLeft: (s.instanceGroups.get(0) || []).length,
            unlinkedCam1: (fg.getUnlinkedInstances('cam1') || []).length,
            linkedCam1: (fg.instances.get('cam1') || []).length,
        };
    });
    check(ungrouped.groupsLeft === 0, `the group is gone (got ${ungrouped.groupsLeft} left)`);
    check(ungrouped.unlinkedCam1 === 1 && ungrouped.linkedCam1 === 0,
        `cam1's detection moved to the ungrouped pool (unlinked=${ungrouped.unlinkedCam1}, linked=${ungrouped.linkedCam1})`);

    const tracksAfter = await draw(false);
    check(tracksAfter.includes('track_1'),
        `AFTER UNGROUP the animal is still labeled track_1 (got ${JSON.stringify(tracksAfter)})`);
    check(tracksAfter.includes('?'),
        'and it still carries the "?" unassigned badge');

    // ---- ID mode: the name the ID workflow actually needs -------------------
    const idAfter = await draw(true);
    check(idAfter.includes('animal_A'),
        `AFTER UNGROUP, in ID mode, it is labeled animal_A (got ${JSON.stringify(idAfter)})`);

    // ---- and the grouped state names the identity too, not the track --------
    // Regrouping restores the LINKED label path, which resolved its name from
    // the per-frame map alone and fell back to "track_1" whenever that map had
    // no entry — while COLORING by `group.identityId`, so the text and the
    // color named different animals. The per-frame entries are cleared first
    // precisely to reach that state: `unlinkGroup` stamps them on the way out,
    // so without this the map would answer and the fallback would go untested.
    // The state left here is what the Group button produces on a fresh
    // project — `createGroupFromUnlinked` sets `identityId` and writes no map.
    const regrouped = await page.evaluate(async () => {
        const s = window.__lucid.state.session;
        const fg = s.getFrameGroup(0);
        const uls = ['cam1', 'cam2'].map(cn => fg.getUnlinkedInstances(cn)[0]);
        const g = s.createGroupFromUnlinked(0, uls);
        for (const cn of ['cam1', 'cam2']) s.clearTrackIdentity(1, cn);
        return {
            groups: (s.instanceGroups.get(0) || []).length,
            groupIdentity: g.identityId,
            mapAnswers: ['cam1', 'cam2'].map(cn => s.getIdentityIdForTrack(cn, 1, 0)),
        };
    });
    check(regrouped.groups === 1, `regrouped into one group (got ${regrouped.groups})`);
    check(regrouped.mapAnswers.every(v => v == null),
        `precondition: the per-frame map now answers nothing, so only group.identityId is left (got ${JSON.stringify(regrouped.mapAnswers)})`);
    check(regrouped.groupIdentity >= 0,
        `precondition: the group still carries its identity (got ${regrouped.groupIdentity})`);

    const idGrouped = await draw(true);
    check(idGrouped.includes('animal_A'),
        `the REGROUPED animal is labeled animal_A, not its raw track (got ${JSON.stringify(idGrouped)})`);

    check(errs.length === 0, `no page/console errors (got ${JSON.stringify(errs)})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
