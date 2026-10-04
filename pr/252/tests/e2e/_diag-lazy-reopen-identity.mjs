/**
 * diag-lazy-reopen-identity.mjs — real-browser diagnostic (no UI clicking).
 *
 * Builds a small multi-frame tracked project (frameIdentityMap populated for
 * every frame), saves it via the real SLP writer, then reopens it via the
 * REAL SioLazyLoader.openProjectSlp() project-reopen path and checks whether
 * `sessions_json`'s embedded `metadata.lucid.frameIdentityMap` survives the
 * round trip intact — mirroring exactly what `handleLoadProjectSlpLazy`
 * (loading/session-loader.js:2151) reads at line 2223-2232.
 *
 * Run: node diag-lazy-reopen-identity.mjs   (with the app served on :8080)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = '/root/vast/eric/sleap-3d-gui/scratch/repos/lucid';
const PORT = Number(process.env.PORT || 8083);
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
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    const r = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const fileio = await import('/import-export/file-io.js');
        const lazyMod = await import('/loading/sio-lazy-loader.js');
        const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [
            new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 40], [640, 480]),
            new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.2, 0], [-8, 0, 42], [640, 480]),
        ];
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session(cams, skel, ['track_0'], 'LazyIdReopen');

        // Build 30 frames, each with the SAME (camA:0, camB:0) track pair grouped
        // + a per-frame identity assignment for every frame (mirrors what
        // commitTrackedFrame writes during a real Track All run).
        const NF = 30;
        session.addIdentity('Red');
        const redId = session.identities[0].id;
        for (let f = 0; f < NF; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const group = new InstanceGroup(f + 1, redId);
            for (const c of cams) {
                const inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1);
                fg.addInstance(c.name, inst);
                group.addInstance(c.name, inst);
            }
            group.points3d = [[0, 0, 40], [1, 1, 41]];
            session.instanceGroups.set(f, [group]);
        }
        // Real write path: assignTrackToIdentity iterates session.frameGroups
        // (all 30 frames currently present) and writes frameIdentityMap for each.
        session.assignTrackToIdentity(0, redId, 'camA');
        session.assignTrackToIdentity(0, redId, 'camB');

        const preSaveMapSize = session.frameIdentityMap.size;

        const views = cams.map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480, frameCount: NF }));
        const vf = cams.map(c => ({ name: c.name, assignedCamera: c.name, videoPath: c.name + '.mp4' }));
        const labels = fileio.buildSlpLabelsAllViews(session, views, vf);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        const file = new File([bytes], 'proj.slp');

        // Reopen via the REAL project-reopen lazy loader (same call
        // handleLoadProjectSlpLazy makes at loading/session-loader.js:2197).
        const loader = new SioLazyLoader();
        const opened = await loader.openProjectSlp(file, () => {});
        const rawSessions = opened.labels.rawSessionsJson || [];
        const lucidMeta = ((rawSessions[0] || {}).metadata || {}).lucid || null;

        // Replicate the REST of handleLoadProjectSlpLazy
        // (loading/session-loader.js:2201-2277) manually, skipping ONLY the
        // interactive attachVideosForLazyReopen() video-picker modal (which
        // needs a real user click and isn't relevant to identity/timeline
        // data) — everything that builds the reopened `session` and wires it
        // into the REAL live `Timeline` widget runs exactly as production does.
        const slpImport = await import('/import-export/slp-import.js');
        const initMod = await import('/pose/initialization.js');
        const AS = await import('/ui/app-state.js');

        const cameras2 = cams.map(c => new Camera(c.name, c.matrix, c.dist, c.rvec, c.tvec, c.size));
        const skeleton2 = new Skeleton(loader.skeleton.name, loader.skeleton.nodes, loader.skeleton.edges);
        const tracks2 = loader.trackNames.length ? loader.trackNames.slice() : ['track_0'];
        const lucid2 = lucidMeta || {};
        const reSession = new Session(cameras2, skeleton2, tracks2, lucid2.sessionName || 'proj');
        if (lucid2.identities && lucid2.identities.length) {
            reSession.identities = lucid2.identities.map((id, i) => new (pd.Identity)(i, id.name || ('id_' + i), id.color || null));
        }
        if (lucid2.frameIdentityMap) reSession.frameIdentityMap = new Map(lucid2.frameIdentityMap);
        reSession.lazyLoader = loader;
        reSession._lazyReopened = true;

        const nodeNames = skeleton2.nodes.map(n => typeof n === 'string' ? n : (n.name || ''));
        await slpImport.reconstructInstanceGroupsFromSessionLazy(reSession, opened.typedSession, loader, nodeNames, {});

        AS.state.sessions = [reSession];
        AS.state.activeSessionIdx = 0;
        AS.state.session = reSession;
        AS.state.totalFrames = loader.nFrames;

        if (!window.__lucid.timeline) initMod.setupTimeline();
        const timeline = window.__lucid.timeline;
        let identitySegmentsAfterSetData = null;
        let identitySegmentsAfterModeSwitch = null;
        if (timeline) {
            timeline.setData(reSession);
            timeline.setTotalFrames(loader.nFrames);
            identitySegmentsAfterSetData = (timeline._trackSegments || [])
                .filter(row => row._isIdentity && !row._isNoId)
                .map(row => ({ cam: row.cameraName, name: row.trackName, segCount: (row.segments || []).length, segments: row.segments }));

            timeline.setDisplayMode('identities');
            identitySegmentsAfterModeSwitch = (timeline._trackSegments || [])
                .filter(row => row._isIdentity && !row._isNoId)
                .map(row => ({ cam: row.cameraName, name: row.trackName, segCount: (row.segments || []).length, segments: row.segments }));
        }

        return {
            preSaveMapSize,
            nFramesWritten: NF,
            rawSessionsCount: rawSessions.length,
            lucidMetaPresent: !!lucidMeta,
            restoredMapLength: lucidMeta && lucidMeta.frameIdentityMap ? lucidMeta.frameIdentityMap.length : null,
            restoredIdentitiesLength: lucidMeta && lucidMeta.identities ? lucidMeta.identities.length : null,
            reSessionFrameIdentityMapSize: reSession.frameIdentityMap.size,
            reSessionFrameGroupsSize: reSession.frameGroups.size,
            timelinePresent: !!timeline,
            timelineDisplayMode: timeline ? timeline._displayMode : null,
            identitySegmentsAfterSetData,
            identitySegmentsAfterModeSwitch,
        };
    });

    console.log('  measured:', JSON.stringify(r, null, 2));
    check(r.preSaveMapSize === r.nFramesWritten * 2, `pre-save frameIdentityMap has all frames (${r.preSaveMapSize} / expected ${r.nFramesWritten * 2})`);
    check(r.rawSessionsCount >= 1, 'saved file has at least one rawSessionsJson entry');
    check(r.lucidMetaPresent === true, 'reopened labels expose metadata.lucid');
    check(r.restoredMapLength === r.nFramesWritten * 2, `reopened frameIdentityMap has ALL ${r.nFramesWritten * 2} entries (got ${r.restoredMapLength})`);
    check(r.restoredIdentitiesLength === 1, `reopened identities array has 1 entry (got ${r.restoredIdentitiesLength})`);
    check(r.reSessionFrameIdentityMapSize === r.nFramesWritten * 2, `live reSession.frameIdentityMap fully populated (got ${r.reSessionFrameIdentityMapSize})`);
    check(r.reSessionFrameGroupsSize < r.nFramesWritten, `live reSession.frameGroups is SPARSE (lazy, not all ${r.nFramesWritten} materialized) — got ${r.reSessionFrameGroupsSize}`);
    check(r.timelinePresent === true, 'live Timeline widget was created');
    console.log('  timeline._displayMode:', r.timelineDisplayMode);
    console.log('  identity segments right after setData():', JSON.stringify(r.identitySegmentsAfterSetData));
    console.log('  identity segments after setDisplayMode("identities"):', JSON.stringify(r.identitySegmentsAfterModeSwitch));
    if (r.identitySegmentsAfterModeSwitch) {
        for (const row of r.identitySegmentsAfterModeSwitch) {
            const covered = new Set();
            for (const seg of (row.segments || [])) for (let f = seg.start; f <= seg.end; f++) covered.add(f);
            check(covered.size === r.nFramesWritten, `identity row '${row.name}'/${row.cam} covers ALL ${r.nFramesWritten} frames (got ${covered.size})`);
        }
    } else {
        check(false, 'no identity rows found in the live Timeline after setDisplayMode("identities")');
    }

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
