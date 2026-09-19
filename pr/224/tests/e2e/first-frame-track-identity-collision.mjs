/**
 * first-frame-track-identity-collision.mjs — real-browser regression test.
 *
 * Bug (reported): after "Propagate IDs -> Tracks", frame 0 (the first frame)
 * stays wrong/unchanged in both the Timeline's Track-colored AND
 * Identity-colored views, while every later frame updates correctly.
 *
 * Root cause: `commitTrackedFrame` (pose/tracker.js) has a `writtenThisFrame`
 * collision guard that marks a (frame,cam,rawTrackIdx) key -1/ambiguous in
 * `session.frameIdentityMap` when the raw per-camera tracker briefly assigns
 * the SAME trackIdx to two different animals on the same frame — most common
 * on frame 0, before the tracker has history to differentiate them. That
 * guard is correct for its original purpose (stopping the 2D overlay's
 * per-camera-per-frame color lookup from confidently showing the wrong
 * animal's color) — but `propagateIdentitiesToTracks` (pose/pose-data.js)
 * resolved each instance's new track PURELY through that same ambiguous
 * per-camera key, so on a collision frame BOTH colliding instances went
 * trackless (null) instead of falling back to the one signal that stays
 * unambiguous through a collision: each instance's own `group.identityId`.
 * That silently emptied both the Track view AND the Identity view for that
 * frame — matching the report exactly ("same is happening with IDs now").
 *
 * Fix: `propagateIdentitiesToTracks` now builds a per-instance identity
 * fallback (and repairs the equivalent `frameIdentityMap` entries) from
 * `session.instanceGroups` before remapping, so a collision on the raw key
 * no longer loses either animal's track.
 *
 * Run: node first-frame-track-identity-collision.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8096);
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
        const initMod = await import('/pose/initialization.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const camA = new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        const camB = new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.3, 0], [20, 0, 0], [640, 480]);
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session([camA, camB], skel, ['track_0', 'track_1'], 'FirstFrameCollision');

        session.addIdentity('Red');
        session.addIdentity('Blue');
        const redId = session.identities[0].id;
        const blueId = session.identities[1].id;

        const NF = 5;
        for (let f = 0; f < NF; f++) session.addFrameGroup(new FrameGroup(f));

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
        }

        let gid = 1;
        for (let f = 0; f < NF; f++) {
            // Raw per-camera trackIdx collision on camA, frame 0 ONLY (both
            // identities land on camA:trackIdx=0) — mirrors what the real
            // cross-view tracker occasionally does before it has enough
            // history to differentiate two animals. camB never collides.
            const camARed = 0;
            const camABlue = (f === 0) ? 0 : 1;
            makeGroup(f, redId, camARed, 0, gid++);
            makeGroup(f, blueId, camABlue, 1, gid++);
        }

        // Write frameIdentityMap via commitTrackedFrame's own collision guard
        // logic (copied, not imported — mirrors the real per-frame write path
        // exactly, including marking the frame-0/camA collision -1/ambiguous).
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

        const propRes = session.propagateIdentitiesToTracks();

        const afterTrackIdx = { frame0: {}, frame1: {} };
        for (const f of [0, 1]) {
            const fg = session.frameGroups.get(f);
            for (const [camName, insts] of fg.instances) {
                afterTrackIdx['frame' + f][camName] = insts.map(i => i.trackIdx).sort();
            }
        }

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = NF;
        AS.state.currentFrame = 0;
        if (!window.__lucid.timeline) initMod.setupTimeline();
        const timeline = window.__lucid.timeline;
        timeline.setData(session);
        timeline.setTotalFrames(NF);

        function coversFrame(segments, f) {
            return (segments || []).some(s => f >= s.start && f <= s.end);
        }

        timeline.setDisplayMode('tracks');
        const trackCamACoversFrame0 = (timeline._trackSegments || [])
            .filter(row => !row._isIdentity && row.cameraName === 'camA')
            .every(row => coversFrame(row.segments, 0));

        timeline.setDisplayMode('identities');
        const idCamACoversFrame0 = (timeline._trackSegments || [])
            .filter(row => row._isIdentity && !row._isNoId && row.cameraName === 'camA')
            .every(row => coversFrame(row.segments, 0));

        return { propRes, afterTrackIdx, trackCamACoversFrame0, idCamACoversFrame0 };
    });

    console.log('  measured:', JSON.stringify(r, null, 2));
    check(r.propRes.tracks === 2, `propagate created 2 tracks from the 2 identities (got ${r.propRes.tracks})`);
    check(r.afterTrackIdx.frame0.camA.length === 2 && !r.afterTrackIdx.frame0.camA.some(t => t == null),
        `frame 0 camA: both instances kept a real track after propagate (got ${JSON.stringify(r.afterTrackIdx.frame0.camA)})`);
    check(JSON.stringify(r.afterTrackIdx.frame0.camA) === JSON.stringify(r.afterTrackIdx.frame1.camA),
        `frame 0 camA tracks match frame 1's (${JSON.stringify(r.afterTrackIdx.frame0.camA)} vs ${JSON.stringify(r.afterTrackIdx.frame1.camA)}) — no first-frame-only discrepancy`);
    check(r.trackCamACoversFrame0 === true, 'Timeline Track view: camA rows cover frame 0 (not silently empty)');
    check(r.idCamACoversFrame0 === true, 'Timeline Identity view: camA rows cover frame 0 (not silently empty)');

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
