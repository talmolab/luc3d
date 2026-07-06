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
 *      top-N by occupancy and appends a "+N more" indicator row.
 *
 * Uses the test-runner bridges: window.SioLazyLoader, window.Timeline, and the
 * pose-data classes (Session/Camera/Skeleton/Instance).
 */

(function () {
    const { describe, it, assertEqual, assertTrue, assertFalse } = TestFramework;

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
    });

    describe('Timeline sparse occupancy (lazy .slp) — row cap', function () {
        var container, tl;

        it('keeps the top-N tracks by occupancy and adds a "+N more" row', function () {
            container = createContainer(800, 200);
            tl = new Timeline(container, { totalFrames: 300 });
            var session = makeSession(['cam1']);
            var N = 100;
            var segments = new Map(), counts = new Map();
            for (var t = 0; t < N; t++) {
                segments.set(t, [{ start: t, end: t }]);
                counts.set(t, N - t);   // track 0 most-occupied, track 99 least
            }
            session.trackOccupancy = new Map();
            session.trackOccupancy.set('cam1', { sparse: true, nTracks: N, nFrames: 300, segments: segments, counts: counts });
            tl.setData(session);

            var cap = tl.MAX_TRACK_ROWS_PER_CAMERA;
            var rows = tl._trackSegments.filter(function (s) { return s.cameraName === 'cam1' && s._isTrack && s.trackIdx >= 0; });
            assertEqual(rows.length, cap, 'capped to MAX_TRACK_ROWS_PER_CAMERA real rows');

            var present = new Set(rows.map(function (r) { return r.trackIdx; }));
            assertTrue(present.has(0) && present.has(cap - 1), 'kept the most-occupied tracks');
            assertFalse(present.has(cap), 'dropped the least-occupied tracks');

            var more = tl._trackSegments.filter(function (s) { return s.cameraName === 'cam1' && s._isMoreIndicator; });
            assertEqual(more.length, 1, 'one "+N more" indicator row');
            assertEqual(more[0].trackName, '+' + (N - cap) + ' more', 'indicator counts hidden tracks');
            assertEqual(more[0].segments.length, 0, 'indicator draws no bar');

            cleanup(tl, container); tl = null;
        });
    });
})();
