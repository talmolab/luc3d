/**
 * test-timeline-sparse-occupancy.js — phase-5 timeline predicted-track bars for
 * lazy `.slp` sessions.
 *
 * Covers:
 *   1. Producer — SioLazyLoader._computeSparseOccupancy builds per-track
 *      run-segments + occupied-frame counts from a columnar store, in one pass.
 *   2. Consumer — timeline._buildTrackSegments' sparse branch turns those segments
 *      into track bars, and subtracts materialized frames (live fg data wins).
 *   3. Row cap — a camera with more tracks than MAX_TRACK_ROWS_PER_CAMERA keeps the
 *      first-N tracks by appearance (earliest segment start) and appends a
 *      "+N more" indicator row, per camera independently.
 *
 * Uses the test-runner bridges: window.SioLazyLoader, window.Timeline, and the
 * pose-data classes (Session/Camera/Skeleton/Instance).
 */

(function () {
    const { describe, it, assertEqual, assertTrue, assertFalse, assertDeepEqual } = TestFramework;

    function createContainer(width, height) {
        var div = document.createElement('div');
        div.style.width = (width || 800) + 'px';
        div.style.height = (height || 120) + 'px';
        div.style.position = 'fixed';
        div.style.top = '-9999px';
        div.style.left = '0';
        document.body.appendChild(div);
        return div;
    }
    function cleanup(tl, container) {
        if (tl) tl.destroy();
        if (container && container.parentNode) container.remove();
    }
    function makeSession(cameraNames) {
        var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
        var cameras = cameraNames.map(function (name) {
            return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        });
        return new Session(cameras, skeleton, ['track_0']);
    }
    function getSegmentFrames(tl, camName, trackIdx) {
        var frames = new Set();
        for (var i = 0; i < tl._trackSegments.length; i++) {
            var seg = tl._trackSegments[i];
            if (seg.cameraName === camName && seg.trackIdx === trackIdx) {
                for (var s = 0; s < seg.segments.length; s++) {
                    for (var f = seg.segments[s].start; f <= seg.segments[s].end; f++) frames.add(f);
                }
            }
        }
        return frames;
    }
    // Build a columnar lazy store: rows = [{ f: frameIdx, tracks: [trackId, ...] }].
    function makeStore(rows) {
        var frame_idx = [], instance_id_start = [], instance_id_end = [], track = [];
        var cursor = 0;
        for (var i = 0; i < rows.length; i++) {
            frame_idx.push(rows[i].f);
            instance_id_start.push(cursor);
            for (var k = 0; k < rows[i].tracks.length; k++) { track.push(rows[i].tracks[k]); cursor++; }
            instance_id_end.push(cursor);
        }
        return { framesData: { frame_idx: frame_idx, instance_id_start: instance_id_start, instance_id_end: instance_id_end }, instancesData: { track: track } };
    }
    function makeLabels(store, nTracks) {
        var tracks = [];
        for (var i = 0; i < nTracks; i++) tracks.push({ name: 'track_' + i });
        return { _lazyDataStore: store, tracks: tracks };
    }

    describe('Timeline sparse occupancy (lazy .slp) — producer', function () {
        it('builds per-track run-segments and counts in one columnar pass', function () {
            var loader = new window.SioLazyLoader();
            // track 0 at frames 0,1,2 and (gap) 5; track 1 only at frame 1.
            var store = makeStore([
                { f: 0, tracks: [0] },
                { f: 1, tracks: [0, 1] },
                { f: 2, tracks: [0] },
                { f: 5, tracks: [0] },
            ]);
            var occ = loader._computeSparseOccupancy(makeLabels(store, 2), 6);
            assertTrue(!!occ && occ.sparse === true, 'sparse occupancy produced');
            assertEqual(occ.nTracks, 2, 'nTracks from labels.tracks');

            var seg0 = occ.segments.get(0);
            assertEqual(seg0.length, 2, 'track 0 → two runs (gap at 3-4)');
            assertEqual(seg0[0].start, 0, 'run 0 start'); assertEqual(seg0[0].end, 2, 'run 0 end');
            assertEqual(seg0[1].start, 5, 'run 1 start'); assertEqual(seg0[1].end, 5, 'run 1 end');
            assertEqual(occ.counts.get(0), 4, 'track 0 occupied-frame count');

            var seg1 = occ.segments.get(1);
            assertEqual(seg1.length, 1, 'track 1 → one run');
            assertEqual(seg1[0].start, 1, 'track 1 run start'); assertEqual(seg1[0].end, 1, 'track 1 run end');
            assertEqual(occ.counts.get(1), 1, 'track 1 count');
        });

        it('counts a track appearing twice in one frame only once', function () {
            var loader = new window.SioLazyLoader();
            var store = makeStore([{ f: 0, tracks: [0, 0] }, { f: 1, tracks: [0] }]);
            var occ = loader._computeSparseOccupancy(makeLabels(store, 1), 2);
            assertEqual(occ.counts.get(0), 2, 'two frames, not three instances');
            assertEqual(occ.segments.get(0)[0].end, 1, 'run spans frames 0-1');
        });

        it('returns null when there is no store or no track segments', function () {
            var loader = new window.SioLazyLoader();
            assertEqual(loader._computeSparseOccupancy({ tracks: [] }, 10), null, 'no _lazyDataStore → null');
            // A store whose only instances are trackless (track -1) yields no segments.
            var store = makeStore([{ f: 0, tracks: [-1] }, { f: 1, tracks: [-1] }]);
            assertEqual(loader._computeSparseOccupancy(makeLabels(store, 1), 2), null, 'no valid tracks → null');
        });
    });

    describe('Timeline sparse occupancy (lazy .slp) — consumer', function () {
        var container, tl;
        function fresh() {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 140);
            tl = new Timeline(container, { totalFrames: 100 });
        }

        it('draws bars from sparse segments', function () {
            fresh();
            var session = makeSession(['cam1']);
            session.trackOccupancy = new Map();
            session.trackOccupancy.set('cam1', {
                sparse: true, nTracks: 2, nFrames: 100,
                segments: new Map([[0, [{ start: 5, end: 9 }]], [1, [{ start: 20, end: 22 }]]]),
                counts: new Map([[0, 5], [1, 3]]),
            });
            tl.setData(session);

            var f0 = getSegmentFrames(tl, 'cam1', 0);
            assertTrue(f0.has(5) && f0.has(9) && !f0.has(4) && !f0.has(10), 'track 0 bar covers 5-9 only');
            var f1 = getSegmentFrames(tl, 'cam1', 1);
            assertTrue(f1.has(20) && f1.has(22) && !f1.has(19), 'track 1 bar covers 20-22');

            cleanup(tl, container); tl = null;
        });

        it('subtracts materialized frames (live fg data is authoritative)', function () {
            fresh();
            var session = makeSession(['cam1']);
            session.trackOccupancy = new Map();
            session.trackOccupancy.set('cam1', {
                sparse: true, nTracks: 2, nFrames: 100,
                segments: new Map([[0, [{ start: 5, end: 9 }]]]),
                counts: new Map([[0, 5]]),
            });
            // Materialize frame 7 by adding a live instance there on a DIFFERENT
            // track — so frame 7 leaves track 0's occupancy and is NOT re-added.
            session.addUnlinkedInstance(7, 'cam1', new Instance([[1, 2], [3, 4]], 1, 'predicted', 0.9));
            tl.setData(session);

            var f0 = getSegmentFrames(tl, 'cam1', 0);
            assertFalse(f0.has(7), 'materialized frame 7 removed from track 0 occupancy');
            assertTrue(f0.has(5) && f0.has(6) && f0.has(8) && f0.has(9), 'run split around frame 7');

            cleanup(tl, container); tl = null;
        });

        it('a fully-materialized track produces no phantom row (subd empty)', function () {
            fresh();
            var session = makeSession(['cam1']);
            session.trackOccupancy = new Map();
            // Track 0 occupies ONLY frame 7.
            session.trackOccupancy.set('cam1', {
                sparse: true, nTracks: 2, nFrames: 100,
                segments: new Map([[0, [{ start: 7, end: 7 }]]]),
                counts: new Map([[0, 1]]),
            });
            // Materialize frame 7 via a DIFFERENT track — track 0's only frame is now
            // subtracted and not re-added, so track 0 should vanish (no row, no bar).
            session.addUnlinkedInstance(7, 'cam1', new Instance([[1, 2], [3, 4]], 1, 'predicted', 0.9));
            tl.setData(session);

            var t0Rows = tl._trackSegments.filter(function (s) {
                return s.cameraName === 'cam1' && s._isTrack && s.trackIdx === 0;
            });
            assertEqual(t0Rows.length, 0, 'fully-subtracted track 0 produces no row');
            assertEqual(getSegmentFrames(tl, 'cam1', 0).size, 0, 'and no phantom bar');

            cleanup(tl, container); tl = null;
        });
    });

    describe('Timeline sparse occupancy (lazy .slp) — row cap', function () {
        var container, tl;

        it('keeps the first-N tracks by appearance (not occupancy) and adds a "+N more" row', function () {
            container = createContainer(800, 200);
            tl = new Timeline(container, { totalFrames: 300 });
            var session = makeSession(['cam1']);
            var N = 100;
            // Track t first appears at frame t, but its occupancy INCREASES with t —
            // so first-appearance (keep 0..63) and top-occupancy (keep 36..99) select
            // opposite ends. The cap must keep the EARLIEST-appearing tracks.
            var segments = new Map(), counts = new Map();
            for (var t = 0; t < N; t++) {
                segments.set(t, [{ start: t, end: t }]);
                counts.set(t, t);   // occupancy grows with t (would keep high indices)
            }
            session.trackOccupancy = new Map();
            session.trackOccupancy.set('cam1', { sparse: true, nTracks: N, nFrames: 300, segments: segments, counts: counts });
            tl.setData(session);

            var cap = tl.MAX_TRACK_ROWS_PER_CAMERA;
            var rows = tl._trackSegments.filter(function (s) { return s.cameraName === 'cam1' && s._isTrack && s.trackIdx >= 0; });
            assertEqual(rows.length, cap, 'capped to MAX_TRACK_ROWS_PER_CAMERA real rows');

            var present = new Set(rows.map(function (r) { return r.trackIdx; }));
            assertTrue(present.has(0) && present.has(cap - 1), 'kept the earliest-appearing tracks (0..cap-1)');
            assertFalse(present.has(cap), 'dropped the track just past the cap');
            assertFalse(present.has(N - 1), 'dropped the last-appearing track despite its highest occupancy');

            var more = tl._trackSegments.filter(function (s) { return s.cameraName === 'cam1' && s._isMoreIndicator; });
            assertEqual(more.length, 1, 'one "+N more" indicator row');
            assertEqual(more[0].trackName, '+' + (N - cap) + ' more', 'indicator shows the hidden-track count');
            assertEqual(more[0].segments.length, 0, 'indicator draws no bar');

            cleanup(tl, container); tl = null;
        });

        it('caps each camera independently', function () {
            container = createContainer(800, 200);
            tl = new Timeline(container, { totalFrames: 300 });
            var session = makeSession(['cam1', 'cam2']);
            var cap = tl.MAX_TRACK_ROWS_PER_CAMERA;
            var overCap = cap + 20;   // cam1: over the cap
            var underCap = 5;         // cam2: under the cap
            function tracks(n) {
                var segs = new Map();
                for (var t = 0; t < n; t++) segs.set(t, [{ start: t, end: t }]);
                return { sparse: true, nTracks: n, nFrames: 300, segments: segs, counts: new Map() };
            }
            session.trackOccupancy = new Map();
            session.trackOccupancy.set('cam1', tracks(overCap));
            session.trackOccupancy.set('cam2', tracks(underCap));
            tl.setData(session);

            var rows1 = tl._trackSegments.filter(function (s) { return s.cameraName === 'cam1' && s._isTrack && s.trackIdx >= 0; });
            var rows2 = tl._trackSegments.filter(function (s) { return s.cameraName === 'cam2' && s._isTrack && s.trackIdx >= 0; });
            assertEqual(rows1.length, cap, 'cam1 capped to cap rows');
            assertEqual(rows2.length, underCap, 'cam2 (under cap) keeps all its rows');

            var more1 = tl._trackSegments.filter(function (s) { return s.cameraName === 'cam1' && s._isMoreIndicator; });
            var more2 = tl._trackSegments.filter(function (s) { return s.cameraName === 'cam2' && s._isMoreIndicator; });
            assertEqual(more1.length, 1, 'cam1 has a "+N more" row');
            assertEqual(more1[0].trackName, '+' + (overCap - cap) + ' more', 'cam1 hidden count is its own');
            assertEqual(more2.length, 0, 'cam2 (under cap) has NO indicator row');

            cleanup(tl, container); tl = null;
        });

        it('_subtractFramesFromSegments splits at all boundaries', function () {
            container = createContainer(400, 80);
            tl = new Timeline(container, { totalFrames: 100 });
            var sub = function (segs, rm) { return tl._subtractFramesFromSegments(segs, rm); };
            var seg = [{ start: 5, end: 9 }];
            assertDeepEqual(sub(seg, [5]), [{ start: 6, end: 9 }], 'remove at run start');
            assertDeepEqual(sub(seg, [9]), [{ start: 5, end: 8 }], 'remove at run end');
            assertDeepEqual(sub(seg, [6, 7]), [{ start: 5, end: 5 }, { start: 8, end: 9 }], 'two adjacent removals');
            assertDeepEqual(sub(seg, [6, 8]), [{ start: 5, end: 5 }, { start: 7, end: 7 }, { start: 9, end: 9 }], 'carve into 3');
            assertDeepEqual(sub(seg, [20]), [{ start: 5, end: 9 }], 'removal outside the run → unchanged');
            assertDeepEqual(sub(seg, []), [{ start: 5, end: 9 }], 'empty remove list → unchanged');

            cleanup(tl, container); tl = null;
        });
    });
})();
