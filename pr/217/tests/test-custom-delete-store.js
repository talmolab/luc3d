/**
 * test-custom-delete-store.js — unit tests for `SioLazyLoader.deleteInstanceRows`,
 * the durability primitive behind Custom Instance Delete.
 *
 * This is the piece that makes a bulk delete real rather than cosmetic. Deleting
 * from `session.frameGroups`/`instanceGroups` alone fails twice over on a lazy
 * project: `finalizeLazyFrameGroup` resurrects any store row with no matching
 * `_rawInstIndex` member into the UNLINKED pool on the next hydration (no save
 * needed at all), and the streaming writer's `appendStore` copies the columns
 * verbatim with no per-instance filter. Only mutating the store fixes both.
 *
 * These tests hand-build a columnar store and drive the compaction directly, so
 * the index math is pinned exactly. They were written as the design spikes for
 * the feature and each one answers a question that could have changed it:
 *
 *   S2  a frame whose every instance is deleted must collapse to
 *       `start === end` (a legitimate empty frame) WITHOUT disturbing any other
 *       frame's range — `appendStore` writes such a row as an empty
 *       `LabeledFrame`, which is LUCID's answer to SLEAP's "empty LabeledFrames
 *       are removed".
 *   S3  `from_predicted` must be remapped into the new numbering, and a link
 *       whose target was deleted must degrade to -1 (mirroring `appendStore`'s
 *       own `outIdxOf`), never dangle at a stale index.
 *   S4  a SHARED store (one project .slp interleaving every camera, where
 *       several camera names point at ONE `labels`) must be compacted exactly
 *       ONCE — compacting per camera would renumber already-renumbered rows.
 *
 * Plus: order-independence (frame rows are NOT assumed sorted by
 * `instance_id_start`), typed-array preservation, column-length coherence, and
 * per-row error isolation.
 *
 * Requires the test-runner bridge: window.SioLazyLoader.
 */

(function () {
    const { describe, it, assertEqual, assertTrue, assertDeepEqual } = TestFramework;

    /**
     * Build a minimal columnar store + a loader wired to it.
     *
     * @param {Array<{cam: string, frameIdx: number, insts: Array<{type?: number, track?: number, fromPred?: number, pts?: number}>}>} frameSpecs
     *   Frame rows in the order given (deliberately allowed to be out of
     *   instance-range order, to prove order-independence).
     * @param {boolean} shared  true => every camera maps to ONE labels object.
     */
    function buildLoader(frameSpecs, shared) {
        const nFrames = frameSpecs.length;
        const fd = {
            frame_id: new Float64Array(nFrames),
            video: new Float64Array(nFrames),
            frame_idx: new Float64Array(nFrames),
            instance_id_start: new Float64Array(nFrames),
            instance_id_end: new Float64Array(nFrames),
        };
        // Lay instance rows out frame by frame in the order the specs are given.
        const flat = [];
        for (let r = 0; r < nFrames; r++) {
            const spec = frameSpecs[r];
            fd.frame_id[r] = r;
            fd.video[r] = 0;
            fd.frame_idx[r] = spec.frameIdx;
            fd.instance_id_start[r] = flat.length;
            for (const inst of spec.insts) flat.push({ ...inst, frameRow: r });
            fd.instance_id_end[r] = flat.length;
        }
        const n = flat.length;
        const idn = {
            instance_id: new Float64Array(n),
            instance_type: new Float64Array(n),
            frame_id: new Float64Array(n),
            skeleton: new Float64Array(n),
            track: new Int32Array(n),           // int column — kind must survive
            from_predicted: new Float64Array(n),
            score: new Float64Array(n),         // float column
            point_id_start: new Float64Array(n),
            point_id_end: new Float64Array(n),
            tracking_score: new Float64Array(n),
        };
        let ptCursor = 0;
        for (let j = 0; j < n; j++) {
            const inst = flat[j];
            const nPts = inst.pts != null ? inst.pts : 2;
            idn.instance_id[j] = j;
            idn.instance_type[j] = inst.type != null ? inst.type : 1;   // 1 = predicted
            idn.frame_id[j] = inst.frameRow;
            idn.skeleton[j] = 0;
            idn.track[j] = inst.track != null ? inst.track : -1;
            idn.from_predicted[j] = inst.fromPred != null ? inst.fromPred : -1;
            idn.score[j] = 0.5;
            idn.point_id_start[j] = ptCursor;
            idn.point_id_end[j] = ptCursor + nPts;
            idn.tracking_score[j] = 0.25;
            ptCursor += nPts;
        }
        const store = {
            framesData: fd,
            instancesData: idn,
            pointsData: { x: new Float64Array(ptCursor), y: new Float64Array(ptCursor), visible: new Float64Array(ptCursor), complete: new Float64Array(ptCursor) },
            predPointsData: { x: new Float64Array(ptCursor), y: new Float64Array(ptCursor), visible: new Float64Array(ptCursor), complete: new Float64Array(ptCursor), score: new Float64Array(ptCursor) },
            tracks: [], skeletons: [], videos: [], negativeFrames: new Set(),
        };

        const loader = new SioLazyLoader();
        const cams = Array.from(new Set(frameSpecs.map(s => s.cam)));
        const sharedLabels = { _lazyDataStore: store, tracks: store.tracks };
        for (const cam of cams) {
            const labels = shared ? sharedLabels : { _lazyDataStore: store, tracks: store.tracks };
            loader.labelsByCam.set(cam, labels);
            const rowMap = new Map();
            for (let r = 0; r < nFrames; r++) {
                if (frameSpecs[r].cam === cam) rowMap.set(frameSpecs[r].frameIdx, r);
            }
            loader.frameRowByCam.set(cam, rowMap);
        }
        loader.nFrames = Math.max(...frameSpecs.map(s => s.frameIdx)) + 1;
        loader._sharedStore = !!shared;
        return { loader, store, nInstBefore: n };
    }

    const rowCount = (store) => store.instancesData.instance_type.length;
    const rangeOf = (store, r) => [
        Number(store.framesData.instance_id_start[r]),
        Number(store.framesData.instance_id_end[r]),
    ];

    describe('deleteInstanceRows — compaction and renumbering', function () {

        it('removes exactly the marked rows and renumbers the survivors', function () {
            // One camera, 2 frames x 3 instances. Delete track 1 everywhere.
            const { loader, store } = buildLoader([
                { cam: 'camA', frameIdx: 0, insts: [{ track: 0 }, { track: 1 }, { track: 2 }] },
                { cam: 'camA', frameIdx: 1, insts: [{ track: 0 }, { track: 1 }, { track: 2 }] },
            ], false);
            assertEqual(rowCount(store), 6, 'precondition: 6 instance rows');

            const res = loader.deleteInstanceRows(function (cam, frameIdx, offset, row) {
                return Number(store.instancesData.track[row]) === 1;
            });

            assertEqual(res.deleted, 2, 'reported 2 rows deleted');
            assertEqual(res.errorRows, 0, 'no row errors');
            assertEqual(rowCount(store), 4, 'store compacted to 4 rows');
            assertDeepEqual(Array.from(store.instancesData.track), [0, 2, 0, 2],
                'surviving track column compacted in order');
            assertDeepEqual(rangeOf(store, 0), [0, 2], 'frame 0 re-ranged to [0,2)');
            assertDeepEqual(rangeOf(store, 1), [2, 4], 'frame 1 re-ranged to [2,4)');
            assertEqual(res.byCamera.camA, 2, 'per-camera count reported');
        });

        it('keeps every column the same length after compaction', function () {
            const { loader, store } = buildLoader([
                { cam: 'camA', frameIdx: 0, insts: [{ track: 0 }, { track: 1 }, { track: 2 }, { track: 3 }] },
            ], false);
            loader.deleteInstanceRows((c, f, off) => off === 1 || off === 2);
            const lens = Object.keys(store.instancesData).map(k => store.instancesData[k].length);
            assertTrue(lens.every(l => l === 2), 'all instancesData columns are length 2 (got ' + lens.join(',') + ')');
        });

        it('preserves each column\'s array kind (typed int vs typed float)', function () {
            const { loader, store } = buildLoader([
                { cam: 'camA', frameIdx: 0, insts: [{ track: 5 }, { track: 6 }] },
            ], false);
            loader.deleteInstanceRows((c, f, off) => off === 0);
            assertTrue(store.instancesData.track instanceof Int32Array,
                'int track column stayed Int32Array');
            assertTrue(store.instancesData.score instanceof Float64Array,
                'float score column stayed Float64Array');
            assertEqual(Number(store.instancesData.track[0]), 6, 'survivor value intact');
        });

        it('is order-independent — frame rows need not be sorted by instance range', function () {
            // Frame rows deliberately given so frameIdx order != range order.
            const { loader, store } = buildLoader([
                { cam: 'camA', frameIdx: 7, insts: [{ track: 0 }, { track: 1 }] },   // rows 0-1
                { cam: 'camA', frameIdx: 2, insts: [{ track: 2 }, { track: 3 }] },   // rows 2-3
            ], false);
            loader.deleteInstanceRows((c, f, off) => f === 7 && off === 0);   // drop row 0
            assertEqual(rowCount(store), 3, '3 rows survive');
            assertDeepEqual(rangeOf(store, 0), [0, 1], 'frame 7 (row 0) now [0,1)');
            assertDeepEqual(rangeOf(store, 1), [1, 3], 'frame 2 (row 1) shifted to [1,3)');
            assertDeepEqual(Array.from(store.instancesData.track), [1, 2, 3], 'survivors in order');
        });

        // ---- S2 ------------------------------------------------------------
        it('S2: a fully-emptied frame collapses to start === end without disturbing others', function () {
            const { loader, store } = buildLoader([
                { cam: 'camA', frameIdx: 0, insts: [{ track: 0 }, { track: 1 }] },
                { cam: 'camA', frameIdx: 1, insts: [{ track: 0 }, { track: 1 }] },   // delete ALL of this frame
                { cam: 'camA', frameIdx: 2, insts: [{ track: 0 }] },
            ], false);

            const res = loader.deleteInstanceRows((c, frameIdx) => frameIdx === 1);

            assertEqual(res.deleted, 2, 'both instances on frame 1 deleted');
            assertEqual(rowCount(store), 3, '3 rows survive');
            const r1 = rangeOf(store, 1);
            assertEqual(r1[0], r1[1], 'frame 1 collapsed to an EMPTY range (start === end, got ' + r1.join(',') + ')');
            assertDeepEqual(rangeOf(store, 0), [0, 2], 'frame 0 untouched');
            assertDeepEqual(rangeOf(store, 2), [2, 3], 'frame 2 shifted down correctly');
            assertEqual(store.framesData.frame_idx.length, 3,
                'the frame ROW is kept, not removed (frameRowByCam indexing depends on it)');
        });

        // ---- S3 ------------------------------------------------------------
        it('S3: from_predicted is remapped, and a link to a deleted target degrades to -1', function () {
            // row0 predicted, row1 predicted, row2 user linked to row1, row3 user linked to row0.
            const { loader, store } = buildLoader([
                {
                    cam: 'camA', frameIdx: 0, insts: [
                        { type: 1 },
                        { type: 1 },
                        { type: 0, fromPred: 1 },
                        { type: 0, fromPred: 0 },
                    ]
                },
            ], false);

            // Delete predicted row 0 only. row1 -> new index 0; row2/row3 shift down.
            loader.deleteInstanceRows((c, f, off) => off === 0);

            assertEqual(rowCount(store), 3, '3 rows survive');
            const fp = Array.from(store.instancesData.from_predicted).map(Number);
            // survivors are old rows [1,2,3] -> new [0,1,2]
            assertEqual(fp[0], -1, 'old row1 (predicted) still has no from_predicted');
            assertEqual(fp[1], 0, 'old row2\'s link to old row1 remapped to new index 0');
            assertEqual(fp[2], -1, 'old row3\'s link to the DELETED old row0 degraded to -1, not left dangling');
        });

        it('S3b: an out-of-range from_predicted is normalized to -1 rather than corrupting', function () {
            const { loader, store } = buildLoader([
                { cam: 'camA', frameIdx: 0, insts: [{ type: 1 }, { type: 0, fromPred: 999 }] },
            ], false);
            loader.deleteInstanceRows(() => false);   // nothing deleted
            assertEqual(rowCount(store), 2, 'no rows removed when nothing matches');
            // Nothing matched => the store is left completely alone (early continue),
            // so the bogus value is still there; that is intentional (no mutation
            // on a no-op delete). Now delete something and confirm normalization.
            const b = buildLoader([
                { cam: 'camA', frameIdx: 0, insts: [{ type: 1 }, { type: 0, fromPred: 999 }] },
            ], false);
            b.loader.deleteInstanceRows((c, f, off) => off === 0);
            assertEqual(Number(b.store.instancesData.from_predicted[0]), -1,
                'out-of-range from_predicted normalized to -1');
        });

        // ---- S4 ------------------------------------------------------------
        it('S4: a SHARED store is compacted exactly once, not once per camera', function () {
            // Two cameras interleaved in ONE store, 2 instances each.
            const { loader, store } = buildLoader([
                { cam: 'camA', frameIdx: 0, insts: [{ track: 0 }, { track: 1 }] },
                { cam: 'camB', frameIdx: 0, insts: [{ track: 0 }, { track: 1 }] },
            ], true);
            assertTrue(loader.labelsByCam.get('camA') === loader.labelsByCam.get('camB'),
                'precondition: both cameras share ONE labels object');
            assertEqual(rowCount(store), 4, 'precondition: 4 rows');

            // Delete track 1 in BOTH cameras -> exactly 2 rows, not 4.
            const res = loader.deleteInstanceRows(function (cam, f, off, row) {
                return Number(store.instancesData.track[row]) === 1;
            });

            assertEqual(res.deleted, 2, 'counted 2 deletions, not 2-per-camera');
            assertEqual(rowCount(store), 2, 'store compacted ONCE (2 rows survive)');
            assertDeepEqual(Array.from(store.instancesData.track), [0, 0], 'the two track-0 rows survive');
            assertDeepEqual(rangeOf(store, 0), [0, 1], 'camA frame re-ranged');
            assertDeepEqual(rangeOf(store, 1), [1, 2], 'camB frame re-ranged');
        });

        it('S4b: shared store — deleting via one camera only affects that camera\'s rows', function () {
            const { loader, store } = buildLoader([
                { cam: 'camA', frameIdx: 0, insts: [{ track: 0 }, { track: 1 }] },
                { cam: 'camB', frameIdx: 0, insts: [{ track: 0 }, { track: 1 }] },
            ], true);
            const res = loader.deleteInstanceRows((cam) => cam === 'camA');
            assertEqual(res.deleted, 2, 'only camA\'s 2 rows deleted');
            assertEqual(rowCount(store), 2, 'camB\'s 2 rows survive');
            assertDeepEqual(rangeOf(store, 0), [0, 0], 'camA frame is now empty');
            assertDeepEqual(rangeOf(store, 1), [0, 2], 'camB frame holds both survivors');
            assertEqual(res.byCamera.camA, 2, 'camA credited with 2');
            assertTrue(!res.byCamera.camB, 'camB credited with 0');
        });

        // ---- diagnostics ---------------------------------------------------
        it('isolates a throwing predicate per row and surfaces it instead of aborting', function () {
            const { loader, store } = buildLoader([
                { cam: 'camA', frameIdx: 0, insts: [{ track: 0 }, { track: 1 }, { track: 2 }] },
            ], false);
            const res = loader.deleteInstanceRows(function (c, f, off) {
                if (off === 1) throw new Error('boom');
                return off === 2;
            });
            assertEqual(res.errorRows, 1, 'the throwing row was counted, not swallowed');
            assertTrue(!!res.firstError, 'firstError surfaced');
            assertEqual(res.deleted, 1, 'the other matching row was still deleted');
            assertEqual(rowCount(store), 2, 'the throwing row was LEFT IN PLACE (safe default)');
        });

        it('is a no-op when nothing matches', function () {
            const { loader, store } = buildLoader([
                { cam: 'camA', frameIdx: 0, insts: [{ track: 0 }, { track: 1 }] },
            ], false);
            const before = Array.from(store.instancesData.track);
            const res = loader.deleteInstanceRows(() => false);
            assertEqual(res.deleted, 0, 'nothing deleted');
            assertEqual(rowCount(store), 2, 'row count unchanged');
            assertDeepEqual(Array.from(store.instancesData.track), before, 'columns untouched');
            assertDeepEqual(rangeOf(store, 0), [0, 2], 'ranges untouched');
        });
    });
})();
