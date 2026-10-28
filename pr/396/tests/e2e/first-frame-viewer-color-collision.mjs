/**
 * first-frame-viewer-color-collision.mjs — real-browser regression test.
 *
 * Bug (reported): the 2D viewer shows two different animals with the SAME
 * color on frame 0 (self-correcting on later frames) — in both Color by
 * Track and Color by Identity display modes. Intermittent across runs
 * because the trigger is data-dependent (see below).
 *
 * Root cause: `commitTrackedFrame` (pose/tracker.js) marks a
 * (frame,cam,rawTrackIdx) key -1/ambiguous in `session.frameIdentityMap`
 * when the raw per-camera tracker briefly assigns the SAME trackIdx to two
 * DIFFERENT animals on one frame — most common on frame 0, before it has
 * history to differentiate them. `getGroupColor`'s Track-color path
 * (ui/overlays.js) colored purely by that raw (collided) trackIdx, with no
 * awareness of the ambiguity — so on a collision frame, both groups
 * resolved to the exact same `getTrackColor(sharedTrackIdx)` result. This
 * reproduces even WITHOUT ever running Propagate IDs -> Tracks — it's
 * visible immediately after Track All.
 *
 * Fix: when the group's own resolved trackIdx is flagged
 * `isExplicitNoIdentity` for this exact frame, fall back to the group's own
 * `identityId` (unambiguous, never shared between two colliding groups) —
 * mirroring the existing "no trackIdx at all" fallback a few lines below it.
 *
 * Run: node first-frame-viewer-color-collision.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8095);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', msg => { if (msg.type() === 'error') console.log('  [console.error]', msg.text().slice(0, 300)); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const r = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const overlays = await import('/ui/overlays.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const camA = new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        const camB = new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.3, 0], [20, 0, 0], [640, 480]);
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session([camA, camB], skel, ['track_0', 'track_1'], 'ReproViewerColor');

        session.addIdentity('Red');
        session.addIdentity('Blue');
        const redId = session.identities[0].id;
        const blueId = session.identities[1].id;

        const NF = 5;
        for (let f = 0; f < NF; f++) session.addFrameGroup(new FrameGroup(f));

        const groupsByFrame = {};
        function makeGroup(f, identityId, camAtrack, camBtrack, groupId) {
            const group = new InstanceGroup(groupId, identityId);
            const instA = new Instance([[10, 10], [20, 20]], camAtrack, 'predicted', 1);
            const instB = new Instance([[11, 11], [21, 21]], camBtrack, 'predicted', 1);
            const fg = session.frameGroups.get(f);
            fg.addInstance('camA', instA);
            fg.addInstance('camB', instB);
            group.addInstance('camA', instA);
            group.addInstance('camB', instB);
            if (!session.instanceGroups.has(f)) session.instanceGroups.set(f, []);
            session.instanceGroups.get(f).push(group);
            if (!groupsByFrame[f]) groupsByFrame[f] = {};
            groupsByFrame[f][identityId] = group;
        }

        let gid = 1;
        for (let f = 0; f < NF; f++) {
            // Raw per-camera trackIdx collision on camA, frame 0 ONLY — mirrors
            // what the real cross-view tracker occasionally does before it has
            // enough history to differentiate two animals. camB never collides.
            const camARed = 0;
            const camABlue = (f === 0) ? 0 : 1;
            makeGroup(f, redId, camARed, 0, gid++);
            makeGroup(f, blueId, camABlue, 1, gid++);
        }

        // Write frameIdentityMap via commitTrackedFrame's own collision-guard
        // logic (copied, not imported) — this is the state right after Track
        // All, BEFORE Propagate IDs -> Tracks ever runs.
        for (let f = 0; f < NF; f++) {
            const writtenThisFrame = new Map();
            for (const group of session.instanceGroups.get(f)) {
                for (const [camName, inst] of group.instances) {
                    const key = camName + ':' + inst.trackIdx;
                    const prior = writtenThisFrame.get(key);
                    if (prior != null && prior !== group.identityId) {
                        session.setFrameIdentity(f, camName, inst.trackIdx, -1);
                    } else {
                        writtenThisFrame.set(key, group.identityId);
                        session.setFrameIdentity(f, camName, inst.trackIdx, group.identityId);
                    }
                }
            }
        }

        function colorsFor(f) {
            const red = groupsByFrame[f][redId];
            const blue = groupsByFrame[f][blueId];
            return {
                trackRed: overlays.getGroupColor(red, session, false, f, 'camA'),
                trackBlue: overlays.getGroupColor(blue, session, false, f, 'camA'),
                idRed: overlays.getGroupColor(red, session, true, f, 'camA'),
                idBlue: overlays.getGroupColor(blue, session, true, f, 'camA'),
            };
        }

        return { frame0: colorsFor(0), frame1: colorsFor(1) };
    });

    console.log('  measured:', JSON.stringify(r, null, 2));
    check(r.frame0.trackRed !== r.frame0.trackBlue,
        `frame 0 (collision frame): Track-color mode gives Red and Blue DISTINCT colors (got ${r.frame0.trackRed} vs ${r.frame0.trackBlue})`);
    check(r.frame0.idRed !== r.frame0.idBlue,
        `frame 0 (collision frame): Identity-color mode gives Red and Blue DISTINCT colors (got ${r.frame0.idRed} vs ${r.frame0.idBlue})`);
    check(r.frame0.trackRed === r.frame1.trackRed,
        `Red's Track-color is the SAME on frame 0 and frame 1 (got ${r.frame0.trackRed} vs ${r.frame1.trackRed})`);
    check(r.frame0.trackBlue === r.frame1.trackBlue,
        `Blue's Track-color is the SAME on frame 0 and frame 1 (got ${r.frame0.trackBlue} vs ${r.frame1.trackBlue})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
