/**
 * occupancy-sort-skip-optimization.mjs — real-browser regression test.
 *
 * `_computeSparseOccupancy` (loading/sio-lazy-loader.js) used to
 * unconditionally sort a shared store's per-camera row list on every call —
 * an O(n log n) cost with a lookup-heavy comparator, real at 180k+
 * rows/camera on a large project. A single camera's own rows are already in
 * on-disk frame order (openProjectSlp scans the shared store's native row
 * order and appends to each camera's map in that same order — the same
 * frame-ordering invariant `appendStore` relies on elsewhere), so the sort
 * is normally a no-op. Fixed to verify with one cheap linear pass and only
 * pay for the actual sort when a row is genuinely out of order.
 *
 * This test proves two things via a real openProjectSlp round trip and a
 * direct `_computeSparseOccupancy` call:
 *  1. For realistically-ordered data (the common/guaranteed case), zero
 *     Array.prototype.sort() calls happen, and occupancy is still correct.
 *  2. For deliberately out-of-order rows (a synthetic edge case), the
 *     fallback sort still runs and produces the SAME correct result — the
 *     optimization never trades correctness for speed.
 *
 * Run: node occupancy-sort-skip-optimization.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8092);
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
        const { Skeleton, Camera, Instance, FrameGroup, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [
            new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.2, 0], [-8, 0, 42], [640, 480]),
        ];
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session(cams, skel, ['track_0', 'track_1'], 'SortSkipVerify');
        const NF = 500;
        for (let f = 0; f < NF; f++) session.addFrameGroup(new FrameGroup(f));
        for (let f = 0; f < NF; f++) {
            const fg = session.frameGroups.get(f);
            for (const cam of cams) {
                fg.addInstance(cam.name, new Instance([[10, 10], [20, 20]], 0, 'predicted', 1));
                fg.addInstance(cam.name, new Instance([[50, 50], [60, 60]], 1, 'predicted', 1));
            }
        }
        const views = cams.map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480, frameCount: NF }));
        const vf = cams.map(c => ({ name: c.name, assignedCamera: c.name, videoPath: c.name + '.mp4' }));
        const labels = fileio.buildSlpLabelsAllViews(session, views, vf);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        const file = new File([bytes], 'sort-verify.slp');

        // --- Case 1: real, on-disk-ordered data via the real openProjectSlp path. ---
        let sortCallCount = 0;
        const origSort = Array.prototype.sort;
        Array.prototype.sort = function (...args) { sortCallCount++; return origSort.apply(this, args); };

        const loader = new SioLazyLoader();
        const opened = await loader.openProjectSlp(file, () => {});

        Array.prototype.sort = origSort;

        const occOrdered = loader.trackOccupancy.get('camA');

        // --- Case 2: deliberately SHUFFLE camA's rowMap (simulating an
        // out-of-order store) and confirm the fallback sort still produces
        // the identical, correct result. ---
        const camALabels = loader.labelsByCam.get('camA');
        const origRowMap = loader.frameRowByCam.get('camA');
        const shuffledEntries = Array.from(origRowMap.entries());
        // Reverse order (guaranteed out-of-order unless NF <= 1).
        const shuffledRowMap = new Map(shuffledEntries.slice().reverse());

        let sortCallCountShuffled = 0;
        Array.prototype.sort = function (...args) { sortCallCountShuffled++; return origSort.apply(this, args); };
        const occShuffled = loader._computeSparseOccupancy(camALabels, opened.nFrames, shuffledRowMap);
        Array.prototype.sort = origSort;

        function segmentsSummary(occ) {
            if (!occ) return null;
            var out = {};
            for (var [trk, segs] of occ.segments) out[trk] = segs.map(s => [s.start, s.end]);
            return out;
        }

        return {
            nFrames: opened.nFrames,
            sortCallCount,
            sortCallCountShuffled,
            occOrderedSegments: segmentsSummary(occOrdered),
            occShuffledSegments: segmentsSummary(occShuffled),
        };
    });

    console.log('  measured:', JSON.stringify(r, null, 2));
    check(r.sortCallCount === 0, `real openProjectSlp (on-disk-ordered data) triggers ZERO Array.sort() calls (got ${r.sortCallCount})`);
    check(r.sortCallCountShuffled >= 1, `deliberately shuffled rowMap DOES trigger the fallback sort (got ${r.sortCallCountShuffled} calls)`);
    check(JSON.stringify(r.occOrderedSegments) === JSON.stringify(r.occShuffledSegments),
        `ordered (sort-skipped) and shuffled (sort-fallback) paths produce the IDENTICAL correct segments (${JSON.stringify(r.occOrderedSegments)} vs ${JSON.stringify(r.occShuffledSegments)})`);
    check(r.occOrderedSegments && r.occOrderedSegments['0'] && r.occOrderedSegments['0'].length === 1 &&
        r.occOrderedSegments['0'][0][0] === 0 && r.occOrderedSegments['0'][0][1] === 499,
        `track 0 correctly shows ONE contiguous run covering all 500 frames (got ${JSON.stringify(r.occOrderedSegments && r.occOrderedSegments['0'])})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
