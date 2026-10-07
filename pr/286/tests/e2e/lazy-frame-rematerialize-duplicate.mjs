/**
 * lazy-frame-rematerialize-duplicate.mjs — real-browser regression test.
 *
 * Bug (reported): after Track All on a fresh (non-reopened) lazy session,
 * every frame except the current one showed each tracked animal TWICE — once
 * as its correctly-grouped/colored instance, once again as an unlinked
 * duplicate — while the current frame (never evicted) was correct.
 *
 * Root cause: a fresh Track-All sweep evicts every non-current frame from
 * `session.frameGroups` (`sweepTrackAllFrames`'s windowed release), but
 * `session.instanceGroups` is never evicted. When the user later scrubbed to
 * any evicted frame, it re-materialized via `buildLazyFrameGroupSync`/
 * `ensureLazyFrameData`, which both call `finalizeLazyFrameGroup`
 * (pose/triangulation.js) to split the freshly-rebuilt raw instances into
 * "already grouped" vs "unlinked". That split was gated on
 * `session._lazyReopened` — true ONLY when reopening a saved project, never
 * for a session tracked fresh in the current session — so a fresh Track-All
 * session always took the "no pre-existing groups" branch and dumped EVERY
 * instance into the unlinked pool, even though `session.instanceGroups`
 * already had real groups for that exact frame. Result: each tracked animal
 * rendered twice.
 *
 * Fix: check `session.instanceGroups` directly instead of gating on
 * `_lazyReopened` — the existing `_rawInstIndex`-keyed hydration logic
 * already works for both a reopened project's lightweight members AND a
 * fresh Track-All group's real members (both get `_rawInstIndex` tagged by
 * whichever materialization created them).
 *
 * This test also confirms the REVERSE direction still works: ungrouping an
 * instance makes it correctly reappear in the unlinked pool (not missing,
 * not still shown as linked) on the next re-materialization.
 *
 * Run: node lazy-frame-rematerialize-duplicate.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8093);
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
        const triMod = await import('/pose/triangulation.js');
        const AS = await import('/ui/app-state.js');
        const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session, UnlinkedInstance } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const camA = new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session([camA], skel, ['track_0', 'track_1'], 'DupRegression');

        const NF = 6;
        for (let f = 0; f < NF; f++) session.addFrameGroup(new FrameGroup(f));
        for (let f = 0; f < NF; f++) {
            const fg = session.frameGroups.get(f);
            fg.addInstance('camA', new Instance([[10 + f, 10], [20 + f, 20]], 0, 'predicted', 1));
            fg.addInstance('camA', new Instance([[50 + f, 50], [60 + f, 60]], 1, 'predicted', 1));
        }
        const views = [{ name: 'camA', videoWidth: 640, videoHeight: 480, frameCount: NF }];
        const vf = [{ name: 'camA', assignedCamera: 'camA', videoPath: 'camA.mp4' }];
        const labels = fileio.buildSlpLabelsAllViews(session, views, vf);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        const file = new File([bytes], 'dup-regression.slp');

        const loader = new SioLazyLoader();
        await loader.open('camA', file);

        const reSession = new Session([camA], skel, ['track_0', 'track_1'], 'DupRegression');
        reSession.lazyLoader = loader;
        // _lazyReopened intentionally NOT set — this is the fresh
        // (non-reopened) Track-All scenario that triggered the bug.

        AS.state.sessions = [reSession];
        AS.state.activeSessionIdx = 0;
        AS.state.session = reSession;
        AS.state.totalFrames = loader.nFrames;
        AS.state.currentFrame = 0;

        for (let f = 0; f < NF; f++) triMod.buildLazyFrameGroupSync(f);

        const identity0 = reSession.addIdentity('Red');
        const identity1 = reSession.addIdentity('Blue');
        function groupFrame(f) {
            const fg = reSession.frameGroups.get(f);
            const gRed = new InstanceGroup(f * 10 + 1, identity0.id);
            const gBlue = new InstanceGroup(f * 10 + 2, identity1.id);
            const ul = fg.getUnlinkedInstances('camA').slice();
            const red = ul.find(u => u.instance.trackIdx === 0);
            const blue = ul.find(u => u.instance.trackIdx === 1);
            fg.addInstance('camA', red.instance);
            fg.removeUnlinkedById(red.id);
            fg.addInstance('camA', blue.instance);
            fg.removeUnlinkedById(blue.id);
            gRed.addInstance('camA', red.instance);
            gBlue.addInstance('camA', blue.instance);
            reSession.instanceGroups.set(f, [gRed, gBlue]);
        }
        // Mirror commitTrackedFrame's real output for every frame (matching
        // what a real Track All run does across the whole project).
        for (let f = 0; f < NF; f++) groupFrame(f);

        // Windowed sweep releases every frame except the current one —
        // exactly what sweepTrackAllFrames does after Track All finishes.
        for (let f = 1; f < NF; f++) reSession.frameGroups.delete(f);

        // Scrub to frame 3: re-materialize it.
        triMod.buildLazyFrameGroupSync(3);
        const fg3 = reSession.frameGroups.get(3);
        const linkedAfterTrack = (fg3.instances.get('camA') || []).length;
        const unlinkedAfterTrack = (fg3.getUnlinkedInstances('camA') || []).length;

        // Reverse direction: ungroup Blue on frame 3, evict + re-materialize
        // again, confirm Blue reappears as unlinked (not missing, not still
        // linked) while Red stays linked with no duplicate.
        const groups3 = reSession.instanceGroups.get(3);
        const blueGroup = groups3.find(g => g.identityId === identity1.id);
        const blueInst = blueGroup.instances.get('camA');
        const linkedList = fg3.instances.get('camA');
        const idx = linkedList.indexOf(blueInst);
        linkedList.splice(idx, 1);
        fg3.addUnlinkedInstance('camA', new UnlinkedInstance(blueInst, 'camA'));
        reSession.instanceGroups.set(3, groups3.filter(g => g !== blueGroup));

        reSession.frameGroups.delete(3);
        triMod.buildLazyFrameGroupSync(3);
        const fg3b = reSession.frameGroups.get(3);
        const linkedAfterUngroup = (fg3b.instances.get('camA') || []).map(i => i.trackIdx);
        const unlinkedAfterUngroup = (fg3b.getUnlinkedInstances('camA') || []).map(u => u.instance.trackIdx);

        return { linkedAfterTrack, unlinkedAfterTrack, linkedAfterUngroup, unlinkedAfterUngroup };
    });

    console.log('  measured:', JSON.stringify(r, null, 2));
    check(r.linkedAfterTrack === 2, `after Track-All-style grouping + evict + re-materialize, frame 3 has 2 LINKED instances (got ${r.linkedAfterTrack})`);
    check(r.unlinkedAfterTrack === 0, `and ZERO unlinked duplicates (got ${r.unlinkedAfterTrack})`);
    check(JSON.stringify(r.linkedAfterUngroup) === JSON.stringify([0]),
        `after ungrouping Blue + evict + re-materialize, only Red (trackIdx 0) stays linked (got ${JSON.stringify(r.linkedAfterUngroup)})`);
    check(JSON.stringify(r.unlinkedAfterUngroup) === JSON.stringify([1]),
        `Blue (trackIdx 1) correctly reappears in the unlinked pool (got ${JSON.stringify(r.unlinkedAfterUngroup)})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
