/**
 * test-lazy-track-union.js — `LazyFrameLoader` (the worker-backed lazy reader
 * for SLEAP analysis `.h5`, `pose/triangulation.js`) must give ONE track list
 * whichever camera's worker answers first, and must hand every frame back with
 * SESSION track indices.
 *
 * It had the same bug as `SioLazyLoader`: `trackNames` came from the first
 * camera whose `metadata` message arrived, while every camera's frames kept the
 * indices of their own file. Now each metadata message re-derives the union of
 * every camera's names (cameras in name order, `loading/track-union.js`), and
 * frames are re-indexed in the worker's `onmessage` — the one place `getFrame`,
 * `prefetch` and `batchLoadLazyFrames` all pass through.
 *
 * Drives the REAL `open()` against a stand-in `Worker` (installed on window for
 * the duration of each test), so the onmessage wiring is under test, not just
 * the helper methods. The real loader is covered end to end for `.slp` by
 * `tests/e2e/percam-track-union.mjs`.
 */

(function () {
    const { describe, it, assertEqual, assertDeepEqual, assertTrue } = TestFramework;

    // Own track lists. camC's worker reports 3 columns but only 2 names: an
    // unnamed column is still a track, named by the worker's own convention.
    const META = {
        camA: { trackNames: ['track_0', 'track_1', 'track_2'], nTracks: 3, skel: 'skA' },
        camB: { trackNames: ['track_0', 'track_1', 'track_2', 'track_3', 'track_4'], nTracks: 5, skel: 'skB' },
        camC: { trackNames: ['track_7', 'track_0'], nTracks: 3, skel: 'skC' },
    };
    const EXPECTED = ['track_0', 'track_1', 'track_2', 'track_3', 'track_4', 'track_7'];
    const NF = 6;
    const ORDERS = [
        ['camA', 'camB', 'camC'], ['camA', 'camC', 'camB'], ['camB', 'camA', 'camC'],
        ['camB', 'camC', 'camA'], ['camC', 'camA', 'camB'], ['camC', 'camB', 'camA'],
    ];

    /** Dense occupancy, own-track major within a frame: track t present on frames f with (f + t) % 2 == 0. */
    function occupancy(nTracks) {
        const g = new Uint8Array(NF * nTracks);
        for (let f = 0; f < NF; f++) for (let t = 0; t < nTracks; t++) g[f * nTracks + t] = (f + t) % 2 === 0 ? 1 : 0;
        return g;
    }
    /** A camera's own name for column t: its file's name, else the worker's `track_<t>`. */
    function ownName(cam, t) { return META[cam].trackNames[t] || ('track_' + t); }
    function metadata(cam) {
        const m = META[cam];
        return {
            skeleton: { name: m.skel, nodes: ['a'], edges: [] },
            trackNames: m.trackNames.slice(), nTracks: m.nTracks, nFrames: NF, nNodes: 1,
            videos: [{ filename: cam + '.mp4' }], trackOccupancy: occupancy(m.nTracks),
        };
    }

    /** Swap in a Worker stand-in; returns { workers, restore }. */
    function fakeWorkers() {
        const real = window.Worker;
        const workers = [];
        function FakeWorker() { this.posted = []; workers.push(this); }
        FakeWorker.prototype.postMessage = function (m) { this.posted.push(m); };
        FakeWorker.prototype.terminate = function () {};
        window.Worker = FakeWorker;
        return { workers, restore: function () { window.Worker = real; } };
    }

    /** Open all three cameras, delivering their metadata in `order`. */
    async function openInOrder(order) {
        const fw = fakeWorkers();
        try {
            const loader = new LazyFrameLoader();
            const cams = Object.keys(META);
            const opens = cams.map(function (cam) { return loader.open(cam, { name: cam + '.h5' }); });
            const workerOf = {};
            cams.forEach(function (cam, i) { workerOf[cam] = fw.workers[i]; });
            for (const cam of order) workerOf[cam].onmessage({ data: { type: 'metadata', data: metadata(cam) } });
            await Promise.all(opens);
            return { loader, workerOf, restore: fw.restore };
        } catch (e) {
            fw.restore();
            throw e;
        }
    }

    describe('LazyFrameLoader: one track list, whichever worker answers first', function () {

        it('gives the same trackNames and skeleton for all six metadata orders', async function () {
            const seen = [];
            for (const order of ORDERS) {
                const o = await openInOrder(order);
                o.restore();
                seen.push({ order: order.join('>'), tracks: o.loader.trackNames.slice(), skel: o.loader.skeleton.name });
            }
            for (const s of seen) {
                assertDeepEqual(s.tracks, EXPECTED, 'metadata order ' + s.order + ': union in camera-name order');
                assertEqual(s.skel, 'skA', 'metadata order ' + s.order + ': skeleton of the first camera BY NAME');
            }
        });

        it('re-indexes every frame a worker sends back into the session list', async function () {
            for (const order of ORDERS) {
                const o = await openInOrder(order);
                try {
                    // getFrame posts one request per camera; answer each with
                    // one instance per OWN track (+ a trackless one).
                    const pending = o.loader.getFrame(0);
                    for (const cam of Object.keys(META)) {
                        const w = o.workerOf[cam];
                        const req = w.posted.filter(function (m) { return m.type === 'getFrame'; }).pop();
                        const insts = [];
                        for (let t = 0; t < META[cam].nTracks; t++) insts.push({ trackIdx: t, ownName: ownName(cam, t) });
                        insts.push({ trackIdx: -1, ownName: null });
                        w.onmessage({ data: { type: 'frameData', requestId: req.requestId, frameIdx: 0, instances: insts } });
                    }
                    const frame = await pending;
                    for (const cam of Object.keys(META)) {
                        for (const inst of frame.get(cam)) {
                            if (inst.ownName === null) {
                                assertEqual(inst.trackIdx, -1, order.join('>') + ' ' + cam + ': trackless stays trackless');
                            } else {
                                assertTrue(inst.trackIdx >= 0 && inst.trackIdx < o.loader.trackNames.length,
                                    order.join('>') + ' ' + cam + ': trackIdx ' + inst.trackIdx + ' in range');
                                assertEqual(o.loader.trackNames[inst.trackIdx], inst.ownName,
                                    order.join('>') + ' ' + cam + ': trackIdx names the track its own file gave it');
                            }
                        }
                    }

                    // The batch endpoint (`batchLoadLazyFrames`, `prefetch`)
                    // goes through the same handler.
                    const w = o.workerOf.camC;
                    let got = null;
                    o.loader._pending.set(9001, { resolve: function (frames) { got = frames; }, reject: function () {} });
                    w.onmessage({ data: { type: 'framesData', requestId: 9001, frames: [
                        { frameIdx: 1, instances: [{ trackIdx: 0 }, { trackIdx: 1 }, { trackIdx: 2 }] },
                    ] } });
                    assertDeepEqual(got[0].instances.map(function (i) { return o.loader.trackNames[i.trackIdx]; }),
                        ['track_7', 'track_0', 'track_2'], order.join('>') + ': framesData re-indexed too');
                } finally {
                    o.restore();
                }
            }
        });

        it('keeps the dense occupancy grid where indices did not move, and re-keys it where they did', async function () {
            const o = await openInOrder(['camC', 'camB', 'camA']);
            o.restore();
            const occA = o.loader.trackOccupancy.get('camA');
            assertTrue(!occA.sparse && occA.nTracks === 3, 'camA (identity map): its own dense grid, untouched');
            const occC = o.loader.trackOccupancy.get('camC');
            assertTrue(occC.sparse === true, 'camC (moved): converted to the sparse, session-keyed form');
            const keys = Array.from(occC.segments.keys()).map(function (k) { return o.loader.trackNames[k]; }).sort();
            assertDeepEqual(keys, ['track_0', 'track_2', 'track_7'], 'camC occupancy names exactly its own tracks');
            // Own track 0 (track_7) is present on even frames: 0, 2, 4 -> three 1-frame runs.
            const segs = occC.segments.get(EXPECTED.indexOf('track_7'));
            assertDeepEqual(segs, [{ start: 0, end: 0 }, { start: 2, end: 2 }, { start: 4, end: 4 }],
                'segments follow the dense grid of the camera\'s OWN column');
            assertEqual(occC.counts.get(EXPECTED.indexOf('track_7')), 3, 'and so does the frame count');
        });
    });
})();
