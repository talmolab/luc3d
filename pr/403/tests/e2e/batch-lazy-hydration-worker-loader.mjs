/**
 * batch-lazy-hydration-worker-loader.mjs — real-browser regression test for
 * luc3d#209 ("after ~5,500 frames they become predictions").
 *
 * `batchLoadLazyFrames` (pose/triangulation.js) has two loader-shaped
 * branches: `loader.isSync` (SioLazyLoader, in-memory `.slp` projects) calls
 * `buildLazyFrameGroupSync` per frame, which calls `finalizeLazyFrameGroup` to
 * re-link freshly-decoded raw instances back into this frame's PRE-EXISTING
 * `session.instanceGroups` (hydrating a lightweight/placeholder member's 2D
 * in place, preserving its own `type`/`trackIdx`). The other branch — a
 * worker-backed `LazyFrameLoader`, used for SLEAP analysis `.h5` prediction
 * files (`loading/session-loader.js`: `!lazyAreSlp ? new LazyFrameLoader()`)
 * — built its FrameGroup and then unconditionally dumped EVERY instance into
 * the unlinked pool, never calling `finalizeLazyFrameGroup`. A frame
 * (re)built this way looked completely unlinked/untracked even when
 * `session.instanceGroups` already had real (possibly hand-labeled, `'user'`)
 * groups for it — e.g. from a reopened project whose groups were rebuilt but
 * whose 2D still needs on-scrub hydration (`_rawInstIndex`/`_lazy2d`, see
 * `import-export/slp-import.js`).
 *
 * `loadAllLazyFrames` batches in windows of 5000 frames (`BATCH = 5000` at
 * `pose/triangulation.js`), and playback preloads 5000-frame windows
 * (`ui/ui-wiring.js`) — closely matching the reported "~5,500 frames" cutoff:
 * any frame outside what's already resident goes through this path once a
 * bulk/preload batch touches it.
 *
 * Fix: call `finalizeLazyFrameGroup(session, fg, frameIdx)` (mirroring the
 * `isSync` branch) instead of the unconditional unlinked-dump.
 *
 * Run: node batch-lazy-hydration-worker-loader.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8099);
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
        const triMod = await import('/pose/triangulation.js');
        const { Skeleton, Camera, Instance, InstanceGroup, Session } = pd;
        const { LazyFrameLoader } = triMod;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const camA = new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session([camA], skel, ['track_0', 'track_1'], 'BatchHydration');

        const FRAME = 5500;
        const NF = FRAME + 1;

        // A lightweight, pre-existing HAND-LABELED ('user') group for this
        // frame — exactly the shape a reopened project's members carry before
        // on-scrub 2D hydration (import-export/slp-import.js:544-568):
        // NaN-placeholder points, `_rawInstIndex` tagging which raw row is
        // theirs, `_lazy2d` awaiting hydration.
        const identity0 = session.addIdentity('Red');
        const group = new InstanceGroup(1, identity0.id);
        const member = new Instance(new Array(2).fill(null), 0, 'user', 0);
        member._rawInstIndex = 0;
        member._lazy2d = true;
        group.addInstance('camA', member);
        session.instanceGroups.set(FRAME, [group]);

        // A second, unrelated raw row (trackIdx 1) that has NO pre-existing
        // group — it must still end up unlinked.
        const RAW_ROWS = [
            { trackIdx: 0, score: 1, type: 'predicted', points: [[111, 111], [222, 222]] },
            { trackIdx: 1, score: 1, type: 'predicted', points: [[333, 333], [444, 444]] },
        ];

        // Fake worker-backed LazyFrameLoader: skip the real Worker/file I/O in
        // `.open()` and wire a stand-in `postMessage` that resolves
        // `loader._pending` directly, mirroring what the real worker's
        // `onmessage` handler does for a 'getFrames' request.
        const loader = new LazyFrameLoader();
        loader.nFrames = NF;
        loader.workers.set('camA', {
            postMessage(msg) {
                if (msg.type !== 'getFrames') return;
                const frames = [];
                for (let f = msg.startIdx; f < msg.endIdx; f++) {
                    frames.push({ frameIdx: f, instances: f === FRAME ? RAW_ROWS : [] });
                }
                Promise.resolve().then(() => {
                    const cb = loader._pending.get(msg.requestId);
                    if (cb) { loader._pending.delete(msg.requestId); cb.resolve(frames); }
                });
            },
        });
        session.lazyLoader = loader;

        const AS = await import('/ui/app-state.js');
        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = NF;
        AS.state.currentFrame = 0;

        // Preload the batch that contains frame 5500 (mirrors both
        // `loadAllLazyFrames`'s BATCH=5000 sweep and the playback preload's
        // `batchLoadLazyFrames(cur, 5000)` calls).
        await triMod.batchLoadLazyFrames(FRAME, 1);

        const fg = session.frameGroups.get(FRAME);
        const linked = (fg.instances.get('camA') || []);
        const unlinked = (fg.getUnlinkedInstances('camA') || []).map(u => u.instance.trackIdx);

        return {
            linkedCount: linked.length,
            linkedTypes: linked.map(i => i.type),
            linkedTrackIdx: linked.map(i => i.trackIdx),
            memberIsHydrated: member._lazy2d === false,
            memberStillUser: member.type === 'user',
            unlinked,
        };
    });

    console.log('  measured:', JSON.stringify(r));
    check(r.linkedCount === 1, `frame ${5500} keeps its pre-existing group's member LINKED, not dumped to unlinked (got linkedCount=${r.linkedCount})`);
    check(JSON.stringify(r.linkedTypes) === '["user"]', `the linked member's type stays 'user' — it is NOT overwritten by the raw worker row's 'predicted' (got ${JSON.stringify(r.linkedTypes)})`);
    check(r.memberIsHydrated, `the pre-existing member's placeholder 2D was hydrated from the raw store row (_lazy2d flipped false)`);
    check(r.memberStillUser, `the member Instance object itself is still type 'user' after hydration`);
    check(JSON.stringify(r.unlinked) === '[1]', `only the OTHER raw row (trackIdx 1, no pre-existing group) lands in the unlinked pool (got ${JSON.stringify(r.unlinked)})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
