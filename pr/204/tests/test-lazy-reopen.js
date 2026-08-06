/**
 * test-lazy-reopen.js — unit tests for the lazy project reopen path
 * (branch lazy-project-load / PR #167): reopening a single multi-camera
 * PROJECT `.slp` with a SHARED interleaved store.
 *
 * Covers the four pillars of the feature:
 *   1. `SioLazyLoader.openProjectSlp` splits the one shared store into
 *      per-camera maps (labelsByCam / frameRowByCam / videoIdByCam / nFrames).
 *   2. `reconstructInstanceGroupsFromSessionLazy` builds LIGHTWEIGHT group
 *      members (no 2D, tagged `_rawInstIndex`/`_lazy2d`) + 3D, and the
 *      on-scrub hydration (`buildLazyFrameGroupSync` → `finalizeLazyFrameGroup`)
 *      fills each member's 2D from the store row its `_rawInstIndex` names.
 *   3. Re-save (`buildSessionSlpBytesStreaming`) appends the shared store ONCE
 *      (no per-camera frame/track duplication) and round-trips the original
 *      video filenames/shapes via the `loader.videos` fallback.
 *   4. Re-save REMAPS native store video ids onto the output header order when
 *      they differ (a project `.slp` whose videos array is permuted vs the
 *      camera order) — without the remap every frame's 2D would be attributed
 *      to the wrong camera.
 *
 * Requires the test-runner bridge: window.SleapIO (typed model classes +
 * saveSlpToBytes/readSlpStreaming), window.SioLazyLoader, and the pose-data
 * classes (Session/Camera/Skeleton).
 *
 * NOTE: this file dynamic-imports `import-export/slp-import.js`, whose module
 * graph transitively evaluates `pose/initialization.js` (the app entry's
 * `init()` runs at module load, fails gracefully in the DOM-less test page —
 * its body is fully try/caught). Keep this test file registered LAST in
 * test-runner.html so any init side effects cannot leak into other suites.
 */

(function () {
    const { describe, it, assertEqual, assertTrue, assertDeepEqual, assertGreaterThan } = TestFramework;

    // Resolve against the test page (tests/test-runner.html) so this stays
    // correct on localhost AND the GitHub Pages sub-path preview — see the
    // identical constant in test-slp-streaming-write.js.
    const h5wasmUrl = new URL('../lib/h5wasm/h5wasm.iife.js', document.baseURI).href;

    const CAMS = ['Camera_A', 'Camera_B'];
    // Camera provenance is detectable from x alone: A's x-coords sit near 100,
    // B's near 500 (used by test 4 to prove the video-id remap fixed attribution).
    const CAM_X_BASE = { Camera_A: 100, Camera_B: 500 };
    const NODES = ['head', 'mid', 'tail'];
    const VIDEO_SHAPE = [100, 256, 320, 1];
    const N_FIXTURE_FRAMES = 3;   // labeled frames per camera (frameIdx 0..2)
    const N_INSTANCES = 2;        // PredictedInstances per camera-frame (tracks t0/t1)

    /** Deterministic fixture 2D: camera `camName`, frame f, instance k, node j. */
    function expectedXY(camName, f, k, j) {
        const v = f * 10 + k * 5 + j;
        return [CAM_X_BASE[camName] + v, v + 1];
    }

    function vidIdxByFilename(videos, filename) {
        for (let i = 0; i < videos.length; i++) {
            if (videos[i] && videos[i].filename === filename) return i;
        }
        return -1;
    }

    /**
     * Build ONE multi-camera PROJECT `.slp` (bytes) with the sleap-io.js typed
     * API — the same graph LUCID's own save emits (SLP 2.8 columnar
     * `/session_data`): 2 cameras, one MediaVideo-backed Video each, 3 labeled
     * frames per camera with 2 PredictedInstances (tracks t0/t1) on a 3-node
     * skeleton, and a RecordingSession (CameraGroup + addVideo per camera) with
     * 2 typed FrameGroups (frameIdx 0 and 1). Each FrameGroup holds 1
     * InstanceGroup whose `instanceRefsByCamera` refs [labeledFrameIdx,
     * instanceIdx] point INTO the labeled frames — frame group f references
     * instance index f (fg1 refs the SECOND instance, so `_rawInstIndex`
     * round-trip is non-trivial) — plus an Instance3D with 3 xyz points.
     *
     * `opts.permuteVideos` flips `labels.videos` to [videoB, videoA] so
     * Camera_A's frames carry NATIVE store video id 1 (and B's id 0) — the
     * permuted-header scenario test 4 exercises.
     */
    async function buildProjectFixtureBytes(S, opts) {
        opts = opts || {};
        const sioNodes = NODES.map(function (n) { return new S.Node(n); });
        const skeleton = new S.Skeleton({
            nodes: sioNodes,
            edges: [new S.Edge(sioNodes[0], sioNodes[1]), new S.Edge(sioNodes[1], sioNodes[2])],
            name: 'sk3',
        });
        const tracks = [new S.Track('t0'), new S.Track('t1')];

        const videoByCam = {};
        const lfsByCam = {};
        CAMS.forEach(function (camName) {
            const fn = 'vids/' + camName + '.mp4';
            const video = new S.Video({
                filename: fn,
                backendMetadata: { type: 'MediaVideo', shape: VIDEO_SHAPE.slice(), filename: fn },
                openBackend: false,
            });
            video.shape = VIDEO_SHAPE.slice();
            videoByCam[camName] = video;
            lfsByCam[camName] = [];
            for (let f = 0; f < N_FIXTURE_FRAMES; f++) {
                const insts = [];
                for (let k = 0; k < N_INSTANCES; k++) {
                    const pts = [];
                    for (let j = 0; j < NODES.length; j++) {
                        pts.push({ xy: expectedXY(camName, f, k, j), visible: true, complete: true, score: 1 });
                    }
                    insts.push(new S.PredictedInstance({ points: pts, skeleton: skeleton, track: tracks[k], score: 0.9 }));
                }
                lfsByCam[camName].push(new S.LabeledFrame({ video: video, frameIdx: f, instances: insts }));
            }
        });
        // Labeled-frame order (= file frame-table order): [A0, A1, A2, B0, B1, B2].
        const labeledFrames = lfsByCam.Camera_A.concat(lfsByCam.Camera_B);

        // Real (non-identity) calibration so the embedded calibration path is
        // representative (openProjectSlp reads names from it as a fallback).
        const MAT = [[900, 0, 160], [0, 900, 128], [0, 0, 1]];
        const sioCameras = CAMS.map(function (name, i) {
            return new S.Camera({
                name: name, matrix: MAT,
                rvec: [0.1 + 0.1 * i, 0.2, 0.3], tvec: [i, 2, 3],
                distortions: [-0.1, 0.01, 0, 0, 0], size: [320, 256],
            });
        });
        const session = new S.RecordingSession({ cameraGroup: new S.CameraGroup({ cameras: sioCameras }) });
        CAMS.forEach(function (name, i) { session.addVideo(videoByCam[name], sioCameras[i]); });

        for (let f = 0; f < 2; f++) {
            const refs = new Map();
            const lfRefs = new Map();
            CAMS.forEach(function (name, i) {
                const lfIdx = i * N_FIXTURE_FRAMES + f;   // index into labeledFrames above
                refs.set(sioCameras[i], [lfIdx, f]);      // instance idx f: fg0→inst0, fg1→inst1
                lfRefs.set(sioCameras[i], lfIdx);
            });
            const instance3d = new S.Instance3D({
                points: [[f + 1, f + 2, f + 3], [f + 4, f + 5, f + 6], [f + 7, f + 8, f + 9]],
                skeleton: skeleton,
            });
            session.frameGroups.set(f, new S.FrameGroup({
                frameIdx: f,
                instanceGroups: [new S.InstanceGroup({ instanceRefsByCamera: refs, instance3d: instance3d })],
                labeledFrameRefsByCamera: lfRefs,
            }));
        }

        const videos = opts.permuteVideos
            ? [videoByCam.Camera_B, videoByCam.Camera_A]
            : [videoByCam.Camera_A, videoByCam.Camera_B];
        const labels = new S.Labels({
            labeledFrames: labeledFrames, videos: videos, skeletons: [skeleton],
            tracks: tracks, sessions: [session], provenance: {},
        });
        return await S.saveSlpToBytes(labels);
    }

    /**
     * `openProjectSlp` resolves its internal h5wasm worker script as
     * `new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI)` — correct on the
     * app page, but the test page lives under /tests/, so that resolves to the
     * nonexistent /tests/lib/... . Temporarily shadow window.SleapIO with a
     * pass-through whose readSlpStreaming forces the correct h5wasmUrl; the
     * loader reads window.SleapIO at call time, so the REAL openProjectSlp code
     * stays fully under test. Returns a restore function (call in finally).
     */
    function patchSleapIOForTestPage() {
        const real = window.SleapIO;
        const shim = Object.assign({}, real);
        shim.readSlpStreaming = function (src, o) {
            return real.readSlpStreaming(src, Object.assign({}, o, { h5wasmUrl: h5wasmUrl }));
        };
        window.SleapIO = shim;
        return function restore() { window.SleapIO = real; };
    }

    /** Open fixture bytes through the REAL openProjectSlp. */
    async function openProjectFixture(bytes, name) {
        const loader = new window.SioLazyLoader();
        const restore = patchSleapIOForTestPage();
        try {
            const opened = await loader.openProjectSlp(new File([bytes], name));
            return { loader: loader, opened: opened };
        } finally {
            restore();
        }
    }

    /** LUCID Session wired for a lazily-reopened project (cameras in A,B order). */
    function buildLucidSession(loader) {
        const { Camera, Skeleton, Session } = window;
        const sk = new Skeleton('sk3', NODES.slice(), [[0, 1], [1, 2]]);
        const MAT = [[900, 0, 160], [0, 900, 128], [0, 0, 1]];
        const cameras = CAMS.map(function (name, i) {
            return new Camera(name, MAT, [-0.1, 0.01, 0, 0, 0], [0.1 + 0.1 * i, 0.2, 0.3], [i, 2, 3], [320, 256]);
        });
        const session = new Session(cameras, sk, ['t0', 't1'], 'LazyReopen');
        session.lazyLoader = loader;
        session._lazyReopened = true;
        return session;
    }

    async function reconstructLazy(session, opened, loader) {
        const slpImport = await import('../import-export/slp-import.js');
        assertTrue(typeof slpImport.reconstructInstanceGroupsFromSessionLazy === 'function',
            'reconstructInstanceGroupsFromSessionLazy not exported from slp-import.js');
        // Signature: (session, typedSession, loader, nodeNames, opts).
        // yieldMs 1e9 → never yields → pure-sync single pass.
        return await slpImport.reconstructInstanceGroupsFromSessionLazy(
            session, opened.typedSession, loader, NODES.slice(), { yieldMs: 1e9 });
    }

    describe('Lazy project reopen (shared-store .slp)', function () {

        it('openProjectSlp splits the shared store per camera', async function () {
            const S = window.SleapIO;
            assertTrue(!!S && typeof S.readSlpStreaming === 'function', 'SleapIO not bridged');
            assertTrue(typeof window.SioLazyLoader === 'function', 'SioLazyLoader not bridged');

            const bytes = await buildProjectFixtureBytes(S);
            assertGreaterThan(bytes.length, 1000, 'fixture .slp produced too few bytes');
            const { loader, opened } = await openProjectFixture(bytes, 'lazy-reopen-a.slp');

            assertTrue(loader._sharedStore === true, 'openProjectSlp must mark the loader _sharedStore');
            assertEqual(loader.labelsByCam.size, 2, 'both cameras split out of the one project file');
            const labA = loader.labelsByCam.get('Camera_A');
            const labB = loader.labelsByCam.get('Camera_B');
            assertTrue(!!labA && labA === labB, 'all cameras must share the SAME lazy labels object');
            assertTrue(labA === opened.labels, 'labelsByCam entries are the returned project labels');

            assertEqual(loader.frameRowByCam.get('Camera_A').size, 3, 'Camera_A store rows split per camera');
            assertEqual(loader.frameRowByCam.get('Camera_B').size, 3, 'Camera_B store rows split per camera');

            // videoIdByCam = camera name → NATIVE store video id, i.e. the
            // video's index in the read-back labels.videos.
            assertTrue(!!loader.videoIdByCam, 'videoIdByCam populated by openProjectSlp');
            const vids = opened.labels.videos;
            assertEqual(loader.videoIdByCam.get('Camera_A'),
                vidIdxByFilename(vids, 'vids/Camera_A.mp4'), 'Camera_A native video id');
            assertEqual(loader.videoIdByCam.get('Camera_B'),
                vidIdxByFilename(vids, 'vids/Camera_B.mp4'), 'Camera_B native video id');
            assertEqual(loader.videoIdByCam.get('Camera_A'), 0, 'fixture A keeps natural video order');
            assertEqual(loader.videoIdByCam.get('Camera_B'), 1, 'fixture A keeps natural video order');

            assertEqual(loader.nFrames, 3, 'nFrames = max labeled frameIdx + 1');
            assertDeepEqual(opened.cameraNames.slice().sort(), CAMS.slice().sort(),
                'openProjectSlp reports both camera names');
            assertTrue(!!opened.typedSession, 'typed RecordingSession returned for the reconstructor');
        });

        it('lightweight reconstruct + on-scrub hydration', async function () {
            const S = window.SleapIO;
            assertTrue(!!window.Session && !!window.Camera && !!window.Skeleton, 'pose-data not bridged');
            const tri = await import('../pose/triangulation.js');
            const appState = await import('../ui/app-state.js');
            const state = appState.state;

            const bytes = await buildProjectFixtureBytes(S);
            const { loader, opened } = await openProjectFixture(bytes, 'lazy-reopen-a2.slp');
            const session = buildLucidSession(loader);

            const res = await reconstructLazy(session, opened, loader);
            assertEqual(res.restoredGroups, 2, 'both frame groups restored');
            assertEqual(res.restoredWith3d, 2, 'both groups restored WITH 3D');
            assertEqual(session.instanceGroups.size, 2, 'instanceGroups keyed by frameIdx 0 and 1');

            for (let f = 0; f < 2; f++) {
                const groups = session.instanceGroups.get(f);
                assertTrue(!!groups && groups.length === 1, 'frame ' + f + ' has exactly 1 group');
                const g = groups[0];
                assertTrue(g.points3d instanceof Float64Array,
                    'frame ' + f + ' 3D points are the flat representation');
                assertDeepEqual(toBoxedPoints3d(g.points3d),
                    [[f + 1, f + 2, f + 3], [f + 4, f + 5, f + 6], [f + 7, f + 8, f + 9]],
                    'frame ' + f + ' 3D points restored');
                CAMS.forEach(function (camName) {
                    const m = g.instances.get(camName);
                    assertTrue(!!m, 'frame ' + f + ' has a ' + camName + ' member');
                    // Lightweight member: ref-derived store row offset, 2D deferred.
                    assertTrue(m._rawInstIndex != null, 'member carries _rawInstIndex');
                    assertEqual(m._rawInstIndex, f, 'ref [lf, inst] → _rawInstIndex = inst (' + camName + ')');
                    assertTrue(m._lazy2d === true, 'member awaits on-scrub hydration (_lazy2d)');
                    assertTrue(m.numNodes === NODES.length && !m.hasAnyPoint(),
                        'lightweight member has NO 2D yet (null placeholders)');
                    assertEqual(m.trackIdx, f, 'trackIdx derived from the typed track ref');
                    assertEqual(m.type, 'predicted', 'type derived from PredictedInstance');
                });
            }

            // On-scrub hydration reads state.session (pose/triangulation.js).
            const prevSession = state.session;
            try {
                state.session = session;

                assertTrue(tri.buildLazyFrameGroupSync(0) === true, 'buildLazyFrameGroupSync(0) built the frame');
                const g0 = session.instanceGroups.get(0)[0];
                CAMS.forEach(function (camName) {
                    const m = g0.instances.get(camName);
                    assertTrue(m._lazy2d === false, camName + ' member hydrated (_lazy2d cleared)');
                    assertDeepEqual(m.toPointsArray(), [
                        expectedXY(camName, 0, 0, 0),
                        expectedXY(camName, 0, 0, 1),
                        expectedXY(camName, 0, 0, 2),
                    ], camName + ' member 2D hydrated from store instance 0');
                });

                // Frame 1's group refs the SECOND raw instance (k=1): hydration
                // must follow _rawInstIndex, not default to instance 0.
                assertTrue(tri.buildLazyFrameGroupSync(1) === true, 'buildLazyFrameGroupSync(1) built the frame');
                const mB1 = session.instanceGroups.get(1)[0].instances.get('Camera_B');
                assertTrue(mB1._lazy2d === false, 'frame 1 Camera_B member hydrated');
                assertDeepEqual(mB1.toPointsArray(), [
                    expectedXY('Camera_B', 1, 1, 0),
                    expectedXY('Camera_B', 1, 1, 1),
                    expectedXY('Camera_B', 1, 1, 2),
                ], 'frame 1 member hydrated from store instance 1 (via _rawInstIndex)');

                // The grouped member landed in fg.instances; its non-member
                // sibling went to the unlinked pool (finalizeLazyFrameGroup).
                const fg0 = session.frameGroups.get(0);
                assertEqual(fg0.instances.get('Camera_A').length, 1, 'grouped member placed in the frame group');
                assertEqual(fg0.getUnlinkedInstances('Camera_A').length, 1, 'non-member raw instance went unlinked');
            } finally {
                state.session = prevSession;
            }
        });

        it('re-save appends the shared store once + video fallback', async function () {
            const S = window.SleapIO;
            const { buildSessionSlpBytesStreaming } = await import('../import-export/slp-streaming-write.js');

            const bytes = await buildProjectFixtureBytes(S);
            const { loader, opened } = await openProjectFixture(bytes, 'lazy-reopen-a3.slp');
            const session = buildLucidSession(loader);
            await reconstructLazy(session, opened, loader);

            // Re-save with EMPTY views/videoFiles — the lazily reopened session
            // before File → Load Videos. Video filename/shape must come from
            // the loader.videos fallback (the reopened file's own records).
            const out = await buildSessionSlpBytesStreaming(session, [], []);
            assertTrue(out instanceof Uint8Array, 'streaming save returned bytes');
            assertGreaterThan(out.length, 1000, 'streaming save produced too few bytes');

            const rb = await S.readSlpStreaming(new File([out], 'lazy-reopen-resave-a.slp'),
                { lazy: true, openVideos: false, rawSessions: true, h5wasmUrl: h5wasmUrl });
            const fd = rb._lazyDataStore.framesData;
            // The shared store must be appended ONCE: 3 frames × 2 cameras = 6
            // labeled frames (12 instances) — NOT 12 frames (per-camera dup).
            assertEqual(fd.frame_idx.length, 6, 'no per-camera duplication of the shared store frames');
            assertEqual(rb._lazyDataStore.instancesData.track.length, 12, 'no duplication of instances');
            assertEqual(rb.tracks.length, 2, 'shared tracks added once (not once per camera)');

            // Original video identity round-trips from the loader.videos fallback.
            assertEqual(rb.videos.length, 2, 'one output video per camera');
            assertDeepEqual(rb.videos.map(function (v) { return v.filename; }).sort(),
                ['vids/Camera_A.mp4', 'vids/Camera_B.mp4'],
                'original fixture filenames preserved (loader.videos fallback)');
            rb.videos.forEach(function (v) {
                assertDeepEqual(Array.from(v.shape || []), VIDEO_SHAPE,
                    'original video shape preserved (loader.videos fallback): ' + v.filename);
            });

            // Grouping survived the ref-based re-save.
            assertTrue(!!rb.sessions && rb.sessions.length === 1, 'session round-trips');
            assertEqual(rb.sessions[0].frameGroups.size, 2, 'both frame groups round-trip');
        });

        it('re-save remaps permuted native video ids', async function () {
            const S = window.SleapIO;
            const { buildSessionSlpBytesStreaming } = await import('../import-export/slp-streaming-write.js');

            // Fixture B: labels.videos = [videoB, videoA] — Camera_A's frames
            // reference NATIVE store video id 1, Camera_B's id 0.
            const bytes = await buildProjectFixtureBytes(S, { permuteVideos: true });
            const { loader, opened } = await openProjectFixture(bytes, 'lazy-reopen-b.slp');
            assertEqual(loader.videoIdByCam.get('Camera_A'), 1, 'permuted fixture: Camera_A native video id 1');
            assertEqual(loader.videoIdByCam.get('Camera_B'), 0, 'permuted fixture: Camera_B native video id 0');
            assertEqual(loader.frameRowByCam.get('Camera_A').size, 3, 'Camera_A rows found under native id 1');
            assertEqual(loader.frameRowByCam.get('Camera_B').size, 3, 'Camera_B rows found under native id 0');

            // LUCID camera order [Camera_A, Camera_B] → the OUTPUT header puts
            // Camera_A's video at index 0 — the opposite of the native ids, so
            // streamSessionIntoWriter must remap (native 1→header 0, 0→1).
            const session = buildLucidSession(loader);
            await reconstructLazy(session, opened, loader);
            const out = await buildSessionSlpBytesStreaming(session, [], []);

            const rb = await S.readSlpStreaming(new File([out], 'lazy-reopen-resave-b.slp'),
                { lazy: true, openVideos: false, rawSessions: true, h5wasmUrl: h5wasmUrl });
            const fd = rb._lazyDataStore.framesData;
            assertEqual(fd.frame_idx.length, 6, 'remap wrapper store appended once (no duplication)');
            assertEqual(rb.videos[0].filename, 'vids/Camera_A.mp4', 'header video order follows camera order');

            // Attribution: identify each output video's camera BY FILENAME,
            // then require the 2D under it to be THAT camera's fixture coords
            // (A ≈ x100, B ≈ x500). Pre-fix (no remap) these were swapped.
            const rowsSeen = { Camera_A: 0, Camera_B: 0 };
            for (let r = 0; r < 6; r++) {
                const f = Number(fd.frame_idx[r]);
                const vid = Number(fd.video[r]);
                const fn = (rb.videos[vid] && rb.videos[vid].filename) || '';
                const camName = fn.indexOf('Camera_A') >= 0 ? 'Camera_A'
                    : (fn.indexOf('Camera_B') >= 0 ? 'Camera_B' : null);
                assertTrue(camName !== null, 'row ' + r + ' video resolves to a camera (got "' + fn + '")');
                rowsSeen[camName]++;
                const lf = rb.frameAt(r);
                assertEqual(lf.instances.length, 2, 'row ' + r + ' keeps both instances');
                for (let k = 0; k < 2; k++) {
                    const xy = lf.instances[k].points[0].xy;
                    assertDeepEqual([xy[0], xy[1]], expectedXY(camName, f, k, 0),
                        'row ' + r + ' (' + camName + ' f' + f + ' inst' + k +
                        ') carries its OWN camera\'s 2D — video-id remap fixed attribution');
                }
            }
            assertEqual(rowsSeen.Camera_A, 3, 'Camera_A contributes 3 output frames');
            assertEqual(rowsSeen.Camera_B, 3, 'Camera_B contributes 3 output frames');
        });

        it('writes the instances table as float64 (2^24 point-id ceiling guard)', async function () {
            // sleap-io.js#231: h5wasm parses "<f8" as FLOAT32, so an unpatched
            // bundle writes /instances as f32 and point_id_start/end quantize
            // to even integers beyond 2^24 point rows — silently corrupting
            // every instance's node assignment on files with >16.7M points
            // (~1M instances). The vendored bundle carries a LUCID local patch
            // ("<d" = h5wasm float64) at all three writer sites; this guards it
            // across re-vendors for the eager AND streaming writers.
            const S = window.SleapIO;
            const { buildSessionSlpBytesStreaming } = await import('../import-export/slp-streaming-write.js');

            const eagerBytes = await buildProjectFixtureBytes(S); // saveSlpToBytes output
            const { loader, opened } = await openProjectFixture(eagerBytes, 'lazy-reopen-dtype.slp');
            const session = buildLucidSession(loader);
            await reconstructLazy(session, opened, loader);
            const streamBytes = await buildSessionSlpBytesStreaming(session, [], []); // openSlpWriter output

            const h5 = await import('h5wasm');
            await h5.ready;
            for (const [tag, bytes] of [['eager saveSlpToBytes', eagerBytes], ['streaming openSlpWriter', streamBytes]]) {
                const p = '/dtype-' + tag.split(' ')[0] + '.slp';
                h5.FS.writeFile(p, bytes);
                const file = new h5.File(p, 'r');
                try {
                    // h5wasm formats dtypes on read as '<f' (float32) / '<d' (float64).
                    const dt = String(file.get('instances').dtype);
                    assertEqual(dt, '<d',
                        tag + ': /instances must be float64 — as float32 ("<f") point ids '
                        + 'corrupt beyond 2^24 rows (sleap-io.js#231)');
                } finally {
                    file.close();
                    h5.FS.unlink(p);
                }
            }
        });

        it('propagateIdentitiesToTracks rewrites the columnar store and survives export, with ZERO frames materialized', async function () {
            // Regression for the "Propagate IDs -> Tracks only affects a
            // handful of frames near the cursor" bug: the fix must not depend
            // on session.frameGroups residency at all for a lazy session. This
            // test never calls reconstructLazy/buildLazyFrameGroupSync — no
            // FrameGroup is ever built — proving the store-level remap alone
            // (SioLazyLoader.remapTracksFromIdentity) carries the whole
            // project, independent of what's been visited/scrubbed.
            const S = window.SleapIO;
            const { buildSessionSlpBytesStreaming } = await import('../import-export/slp-streaming-write.js');

            const bytes = await buildProjectFixtureBytes(S);
            const { loader, opened } = await openProjectFixture(bytes, 'lazy-reopen-propagate.slp');
            const session = buildLucidSession(loader);
            assertEqual(session.frameGroups.size, 0, 'precondition: nothing materialized whatsoever');

            // Simulate a completed Track All: identity stamped per (frame,cam,
            // track) across the whole project, straight into frameIdentityMap
            // — exactly what Track All itself does, without ever touching
            // frameGroups for frames the tracker's window already released.
            const idA = session.addIdentity('Alice');
            const idB = session.addIdentity('Bob');
            for (let f = 0; f < N_FIXTURE_FRAMES; f++) {
                CAMS.forEach(function (camName) {
                    session.setFrameIdentity(f, camName, 0, idA.id);  // fixture track t0 -> Alice
                    session.setFrameIdentity(f, camName, 1, idB.id);  // fixture track t1 -> Bob
                });
            }

            const res = session.propagateIdentitiesToTracks();
            assertEqual(res.tracks, 2, 'two tracks created from the two used identities');
            assertDeepEqual(session.tracks.slice().sort(), ['Alice', 'Bob'], 'session.tracks renamed to identity names');
            assertEqual(session.frameIdentityMap.size, N_FIXTURE_FRAMES * CAMS.length * 2,
                'frameIdentityMap still covers every frame/camera/track in the project');

            // The underlying columnar store (shared by BOTH cameras here, per
            // openProjectSlp) must be rewritten — this is what export and any
            // future re-materialization actually read for a lazy session.
            const storeA = loader.labelsByCam.get('Camera_A')._lazyDataStore;
            assertTrue(storeA === loader.labelsByCam.get('Camera_B')._lazyDataStore, 'shared store, rebuilt once');
            assertDeepEqual(storeA.tracks.map(function (t) { return t.name; }).sort(), ['Alice', 'Bob'],
                'labels.tracks (== store.tracks) rebuilt to the identity names');
            for (let j = 0; j < storeA.instancesData.track.length; j++) {
                assertTrue(Number(storeA.instancesData.track[j]) >= 0,
                    'store row ' + j + ' got a real identity-derived track (not left at the old t0/t1 id)');
            }

            // Re-materializing (as scrubbing to a frame would, post-eviction)
            // must reflect the NEW assignment — proves this survives
            // eviction/revisit without keeping anything resident.
            const frameMap = loader.getFrameSync(0);
            const camAInsts = frameMap.get('Camera_A');
            assertEqual(camAInsts.length, 2, 'both instances still present after the remap');
            const gotNames = camAInsts.map(function (inst) { return session.tracks[inst.trackIdx]; }).sort();
            assertDeepEqual(gotNames, ['Alice', 'Bob'], 'materialized instances carry the identity-derived track');

            // Export (streaming writer, what a lazy session actually uses to
            // save) must carry it too — the whole point of the fix.
            const out = await buildSessionSlpBytesStreaming(session, [], []);
            const rb = await S.readSlpStreaming(new File([out], 'lazy-reopen-propagate-resave.slp'),
                { lazy: true, openVideos: false, rawSessions: true, h5wasmUrl: h5wasmUrl });
            assertDeepEqual(rb.tracks.map(function (t) { return t.name; }).sort(), ['Alice', 'Bob'],
                'exported file carries the new, identity-derived track names');
            for (let j = 0; j < rb._lazyDataStore.instancesData.track.length; j++) {
                assertTrue(Number(rb._lazyDataStore.instancesData.track[j]) >= 0,
                    'exported row ' + j + ' has a real track (not the untouched original t0/t1 ids)');
            }
        });

        it('propagateIdentitiesToTracks rebuilds the lazy loader\'s trackOccupancy (Tracks Timeline bug)', async function () {
            // Regression for "the 2D viewer shows the propagated tracks
            // correctly but the Tracks Timeline never updates": the Timeline's
            // _buildTrackSegments (ui/timeline.js) trusts session.trackOccupancy
            // (== loader.trackOccupancy, same Map by reference) for every frame
            // outside frameGroups — which is almost the whole project on a
            // large lazy session. That occupancy is a one-time snapshot from
            // SioLazyLoader.open()/_computeSparseOccupancy; if propagate doesn't
            // refresh it, the timeline keeps showing PRE-propagate track bars
            // forever for anything unvisited.
            //
            // Collapsing both fixture tracks (t0, t1) onto the SAME identity
            // changes the track count from 2 -> 1, which a stale occupancy
            // snapshot cannot coincidentally match — a strong signal the
            // rebuild actually ran (a same-count remap could pass even with
            // no rebuild, by accident).
            const S = window.SleapIO;
            const bytes = await buildProjectFixtureBytes(S);
            const { loader, opened } = await openProjectFixture(bytes, 'lazy-reopen-propagate-occupancy.slp');
            const session = buildLucidSession(loader);
            assertEqual(session.frameGroups.size, 0, 'precondition: nothing materialized whatsoever');

            const preOcc = loader.trackOccupancy.get('Camera_A');
            assertTrue(!!preOcc, 'precondition: occupancy was computed at open()');
            assertEqual(preOcc.nTracks, 2, 'precondition: pre-propagate occupancy still reflects the raw t0/t1 tracks');

            const idA = session.addIdentity('Alice');
            for (let f = 0; f < N_FIXTURE_FRAMES; f++) {
                CAMS.forEach(function (camName) {
                    session.setFrameIdentity(f, camName, 0, idA.id);   // t0 -> Alice
                    session.setFrameIdentity(f, camName, 1, idA.id);   // t1 -> Alice too (collapse)
                });
            }

            const res = session.propagateIdentitiesToTracks();
            assertEqual(res.tracks, 1, 'both old tracks collapse onto the single used identity');

            const postOcc = loader.trackOccupancy.get('Camera_A');
            assertTrue(!!postOcc, 'occupancy entry still present after remap');
            assertTrue(postOcc !== preOcc, 'occupancy object was rebuilt, not left as the same stale reference');
            assertEqual(postOcc.nTracks, 1, 'occupancy nTracks now matches the collapsed 1-track project, not the stale 2');
            assertTrue(postOcc.segments.has(0), 'rebuilt occupancy has a segment entry for the single new track');
            const segs0 = postOcc.segments.get(0);
            assertEqual(segs0.length, 1, 'both cameras present every fixture frame -> one contiguous run');
            assertEqual(segs0[0].start, 0, 'run starts at frame 0');
            assertEqual(segs0[0].end, N_FIXTURE_FRAMES - 1, 'run covers every fixture frame');

            // Same Map object as session.trackOccupancy would be after the real
            // session-loader.js wiring (state.session.trackOccupancy =
            // lazyLoader.trackOccupancy) — asserting identity here proves the
            // Timeline picks this up with zero extra plumbing.
            session.trackOccupancy = loader.trackOccupancy;
            assertTrue(session.trackOccupancy.get('Camera_A') === postOcc,
                'session.trackOccupancy (aliased to the loader\'s Map) sees the rebuilt entry');
        });

        // ------------------------------------------------------------------
        // luc3d #203 — running Propagate IDs -> Tracks TWICE
        // ------------------------------------------------------------------
        //
        // Reported: "run Propagate IDs -> Tracks a second time [and] sometimes
        // only in a handful of frames in the beginning you get multiple tracks
        // created that overlap with original ones."
        //
        // The Tracks Timeline does not render `session.tracks`. It renders
        // `maxTrackIdx + 1` (ui/timeline.js), where `maxTrackIdx` is the MAXIMUM
        // over four independent sources: `session.tracks`, every camera's
        // `trackOccupancy.nTracks`, `instanceGroups` members' `trackIdx`, and
        // resident `frameGroups` members' `trackIdx`. Because it is a max, any
        // ONE source still describing the pre-propagate world silently ADDS
        // track rows rather than being reconciled away — which is exactly what
        // "extra tracks overlapping the originals" looks like.
        //
        // So the invariant, asserted after EVERY run: all four sources agree,
        // i.e. `maxTrackIdx + 1 === session.tracks.length`. Existing coverage
        // ran propagate exactly ONCE, which is why a second-run divergence was
        // invisible.
        describe('propagateIdentitiesToTracks run twice (luc3d #203)', function () {

            /** The Timeline's own `maxTrackIdx` computation, mirrored. */
            function timelineMaxTrackIdx(session) {
                let maxTrackIdx = session.tracks ? session.tracks.length - 1 : -1;
                const sources = { tracks: maxTrackIdx, occupancy: -1, instanceGroups: -1, frameGroups: -1 };
                if (session.trackOccupancy) {
                    for (const [, occ] of session.trackOccupancy) {
                        if (occ.nTracks - 1 > sources.occupancy) sources.occupancy = occ.nTracks - 1;
                    }
                }
                if (session.instanceGroups) {
                    for (const [, grps] of session.instanceGroups) {
                        for (const g of grps) {
                            for (const [, inst] of g.instances) {
                                if (inst.trackIdx != null && inst.trackIdx > sources.instanceGroups) {
                                    sources.instanceGroups = inst.trackIdx;
                                }
                            }
                        }
                    }
                }
                for (const [, fg] of session.frameGroups) {
                    for (const [, insts] of fg.instances) {
                        for (const inst of insts) {
                            if (inst.trackIdx != null && inst.trackIdx > sources.frameGroups) {
                                sources.frameGroups = inst.trackIdx;
                            }
                        }
                    }
                    for (const [, ulList] of fg.unlinkedInstances) {
                        for (const ul of ulList) {
                            if (ul.instance.trackIdx != null && ul.instance.trackIdx > sources.frameGroups) {
                                sources.frameGroups = ul.instance.trackIdx;
                            }
                        }
                    }
                }
                for (const k of ['occupancy', 'instanceGroups', 'frameGroups']) {
                    if (sources[k] > maxTrackIdx) maxTrackIdx = sources[k];
                }
                return { maxTrackIdx: maxTrackIdx, sources: sources };
            }

            function describeState(session, res) {
                const m = timelineMaxTrackIdx(session);
                const occ = [];
                if (session.trackOccupancy) {
                    for (const [cn, o] of session.trackOccupancy) occ.push(cn + ':' + o.nTracks);
                }
                return 'tracks=' + JSON.stringify(session.tracks) +
                    ' timelineRows=' + (m.maxTrackIdx + 1) +
                    ' sources=' + JSON.stringify(m.sources) +
                    ' occNTracks=[' + occ.join(',') + ']' +
                    ' storeTracks=' + JSON.stringify(
                        (session.lazyLoader.labelsByCam.get('Camera_A')._lazyDataStore.tracks || [])
                            .map(function (t) { return t.name; })) +
                    (res ? ' res=' + JSON.stringify(res) : '');
            }

            /**
             * @param {Object} opts
             * @param {boolean} opts.collapse map BOTH raw fixture tracks onto ONE
             *   identity, so the track count shrinks (2 -> 1). This is what makes
             *   a stale source VISIBLE: a leftover index 1 then exceeds
             *   `session.tracks.length - 1 === 0` and the Timeline renders an extra
             *   row overlapping the real one. A same-count remap (2 -> 2) cannot
             *   distinguish a correctly-updated source from an untouched one, which
             *   is exactly why the pre-existing single-run coverage missed this.
             * @param {boolean} opts.ambiguous seed the `-1` marker
             *   `commitTrackedFrame` writes on a raw-trackIdx collision, on frame 0
             *   only — "a handful of frames in the beginning" per the report.
             */
            async function runTwice(name, opts) {
                const S = window.SleapIO;
                const bytes = await buildProjectFixtureBytes(S);
                const { loader, opened } = await openProjectFixture(bytes, name);
                const session = buildLucidSession(loader);
                session.trackOccupancy = loader.trackOccupancy;

                // Whole-project grouping in memory, as a lazy reopen builds it —
                // needed so `instanceGroups` is a real source here (and so steps
                // 2b/3b have something to read).
                await reconstructLazy(session, opened, loader);

                const idA = session.addIdentity('Alice');
                const idB = opts.collapse ? idA : session.addIdentity('Bob');
                for (let f = 0; f < N_FIXTURE_FRAMES; f++) {
                    CAMS.forEach(function (camName) {
                        session.setFrameIdentity(f, camName, 0, idA.id);
                        session.setFrameIdentity(f, camName, 1, idB.id);
                    });
                }
                if (opts.ambiguous) session.setFrameIdentity(0, 'Camera_A', 1, -1);

                // Materialize frame 0 so `frameGroups` is a live source too — the
                // reporter is looking at the beginning of the video, which is
                // precisely the part that IS resident. On-scrub hydration reads
                // `state.session` (pose/triangulation.js), so wire it.
                const tri = await import('../pose/triangulation.js');
                const { state } = await import('../ui/app-state.js');
                const prevSession = state.session;
                try {
                    state.session = session;
                    assertTrue(tri.buildLazyFrameGroupSync(0) === true,
                        'precondition: frame 0 materialized, so frameGroups is a live source');
                } finally {
                    state.session = prevSession;
                }
                assertTrue(session.frameGroups.size > 0,
                    'precondition: at least one frame is resident');

                const res1 = session.propagateIdentitiesToTracks();
                const after1 = describeState(session, res1);
                assertEqual(res1.lazyErrorRows || 0, 0, 'run 1: no columnar rows failed to remap — ' + after1);
                const m1 = timelineMaxTrackIdx(session);
                assertEqual(m1.maxTrackIdx + 1, session.tracks.length,
                    'run 1: timeline would render exactly session.tracks.length rows — ' + after1);

                const tracksAfter1 = session.tracks.slice();
                const res2 = session.propagateIdentitiesToTracks();
                const after2 = describeState(session, res2);

                assertDeepEqual(session.tracks, tracksAfter1,
                    'run 2: session.tracks is unchanged — ' + after2);
                assertEqual(res2.lazyErrorRows || 0, 0,
                    'run 2: no columnar rows failed to remap — ' + after2);
                // `res.instances` is in-memory + columnar changes combined, so 0
                // is the whole idempotency claim in one number.
                assertEqual(res2.instances, 0,
                    'run 2: nothing changed track at all — the operation is idempotent — ' + after2);

                const m2 = timelineMaxTrackIdx(session);
                assertEqual(m2.maxTrackIdx + 1, session.tracks.length,
                    'run 2: timeline would render exactly session.tracks.length rows, not extra ' +
                    'overlapping ones — ' + after2);

                // Each source individually, so a failure names the culprit rather
                // than just reporting a bad max.
                for (const [cn, occ] of session.trackOccupancy) {
                    assertEqual(occ.nTracks, session.tracks.length,
                        'run 2: ' + cn + ' occupancy nTracks matches session.tracks — ' + after2);
                }
                assertTrue(m2.sources.instanceGroups < session.tracks.length,
                    'run 2: no instanceGroups member points past the track list — ' + after2);
                assertTrue(m2.sources.frameGroups < session.tracks.length,
                    'run 2: no resident frameGroups member points past the track list — ' + after2);
                return session;
            }

            // The confirmed root cause. `commitTrackedFrame` marks a
            // (frame, camera, rawTrackIdx) key ambiguous with an explicit -1 when
            // one camera's raw tracker briefly gives two animals the same
            // trackIdx — "most common on the first frame or two of a video".
            //
            // Step 2 of propagateIdentitiesToTracks builds `oldKeyToNewTrackIdx`
            // from `frameIdentityMap` and (correctly) skips negative entries — but
            // that map is ALSO what step 4 uses to remap the columnar store, and an
            // absent key there means "no track" (the remap callback returns -1). So
            // the instance on the marked frame silently lost its track IN THE
            // STORE, while step 3/3b gave the in-memory copy the correct one via
            // the `instanceToIdentity` fallback. Step 2b repairs `newFrameMap` for
            // this exact case but never `oldKeyToNewTrackIdx`, so the store was
            // left behind.
            //
            // Measured before the fix, one animal marked on frame 0 of one camera:
            // that camera's store track column came back [0, -1, 0, 1, 0, 1] — the
            // -1 being the marked instance, which every other frame has as track 1.
            // Consequences: the instance exports trackless, the Tracks Timeline has
            // a hole at the start, and occupancy (rebuilt from the store) disagrees
            // with resident `frameGroups` for exactly the first frames.
            it('an ambiguous (-1) raw-trackIdx marker must not cost the instance its track in the store',
                async function () {
                    const S = window.SleapIO;
                    const bytes = await buildProjectFixtureBytes(S);
                    const { loader, opened } = await openProjectFixture(bytes, 'lazy-propagate-ambiguous.slp');
                    const session = buildLucidSession(loader);
                    session.trackOccupancy = loader.trackOccupancy;
                    await reconstructLazy(session, opened, loader);

                    const idA = session.addIdentity('Alice');
                    const idB = session.addIdentity('Bob');
                    for (let f = 0; f < N_FIXTURE_FRAMES; f++) {
                        CAMS.forEach(function (cn) {
                            session.setFrameIdentity(f, cn, 0, idA.id);
                            session.setFrameIdentity(f, cn, 1, idB.id);
                        });
                    }
                    // Frame 0 / Camera_A marked ambiguous on the raw track of the
                    // instance that frame's group actually holds (the fixture's
                    // frame-0 group references raw instance 0, i.e. track 0). This
                    // is faithful: `commitTrackedFrame` only writes the marker for
                    // instances it is grouping, so the marked instance is always a
                    // group member.
                    const g0 = session.instanceGroups.get(0)[0];
                    // The reconstructed fixture group carries no identity of its
                    // own — give it one, as Track All would.
                    g0.identityId = idA.id;
                    const markedRawTrack = g0.instances.get('Camera_A').trackIdx;
                    const markedIdentity = g0.identityId;
                    session.setFrameIdentity(0, 'Camera_A', markedRawTrack, -1);

                    const res = session.propagateIdentitiesToTracks();

                    const store = loader.labelsByCam.get('Camera_A')._lazyDataStore;
                    const trk = Array.from(store.instancesData.track).map(Number);
                    const fd = store.framesData;
                    const row0 = loader.frameRowByCam.get('Camera_A').get(0);
                    const start0 = Number(fd.instance_id_start[row0]);
                    const end0 = Number(fd.instance_id_end[row0]);
                    const ctx = ' (col=' + JSON.stringify(trk) + ', tracks=' +
                        JSON.stringify(session.tracks) + ', markedRawTrack=' + markedRawTrack +
                        ', span=[' + start0 + ',' + end0 + '), res=' + JSON.stringify(res) + ')';

                    // The marked instance keeps ITS OWN identity's track — resolved
                    // per row, not per track.
                    const wantIdx = session.tracks.indexOf(session.getIdentity(markedIdentity).name);
                    assertTrue(wantIdx >= 0, 'precondition: the marked instance\'s identity got a track' + ctx);
                    assertEqual(trk[start0], wantIdx,
                        'the marked row kept its own identity\'s track instead of going trackless' + ctx);

                    // Nothing else in the project lost its track either.
                    const negs = [];
                    for (let j = 0; j < trk.length; j++) if (trk[j] < 0) negs.push(j);
                    assertDeepEqual(negs, [], 'no store row was left trackless' + ctx);

                    assertEqual(res.ambiguousRawKeys, 0,
                        'the marker was one-sided, so nothing is reported as genuinely contested' + ctx);
                });

            // The genuine two-animal collision: two DIFFERENT groups holding the
            // same raw trackIdx on the same camera-frame. A track-keyed remap has
            // no right answer here, so before the per-row resolution both rows went
            // trackless. Each row belongs to exactly one group, so both are
            // recoverable.
            it('two animals sharing one raw trackIdx on a frame each keep their own track',
                async function () {
                    const S = window.SleapIO;
                    const bytes = await buildProjectFixtureBytes(S);
                    const { loader, opened } = await openProjectFixture(bytes, 'lazy-propagate-collision.slp');
                    const session = buildLucidSession(loader);
                    session.trackOccupancy = loader.trackOccupancy;
                    await reconstructLazy(session, opened, loader);

                    const idA = session.addIdentity('Alice');
                    const idB = session.addIdentity('Bob');
                    for (let f = 0; f < N_FIXTURE_FRAMES; f++) {
                        CAMS.forEach(function (cn) {
                            session.setFrameIdentity(f, cn, 0, idA.id);
                            session.setFrameIdentity(f, cn, 1, idB.id);
                        });
                    }

                    // Frame 0 has one fixture group (raw instance 0). Add a second
                    // group for raw instance 1 and force BOTH onto raw track 0, the
                    // state a briefly-undifferentiated per-camera tracker produces.
                    const groups0 = session.instanceGroups.get(0);
                    const gA = groups0[0];
                    gA.identityId = idA.id;
                    const gB = new window.InstanceGroup(9901, idB.id);
                    CAMS.forEach(function (cn) {
                        const memberA = gA.instances.get(cn);
                        const memberB = Object.create(Object.getPrototypeOf(memberA));
                        Object.assign(memberB, memberA);
                        memberB._rawInstIndex = 1;      // the OTHER store row of this camera-frame
                        memberB.trackIdx = memberA.trackIdx;   // ...on the SAME raw track
                        gB.addInstance(cn, memberB);
                    });
                    groups0.push(gB);
                    CAMS.forEach(function (cn) {
                        session.setFrameIdentity(0, cn, gA.instances.get(cn).trackIdx, -1);   // ambiguous
                    });

                    const res = session.propagateIdentitiesToTracks();
                    const aliceIdx = session.tracks.indexOf('Alice');
                    const bobIdx = session.tracks.indexOf('Bob');

                    CAMS.forEach(function (cn) {
                        const store = loader.labelsByCam.get(cn)._lazyDataStore;
                        const trk = Array.from(store.instancesData.track).map(Number);
                        const fd = store.framesData;
                        const row0 = loader.frameRowByCam.get(cn).get(0);
                        const start0 = Number(fd.instance_id_start[row0]);
                        const ctx = ' (' + cn + ' col=' + JSON.stringify(trk) + ', tracks=' +
                            JSON.stringify(session.tracks) + ', res=' + JSON.stringify(res) + ')';
                        assertEqual(trk[start0], aliceIdx,
                            'colliding row 0 resolved to Alice, not trackless' + ctx);
                        assertEqual(trk[start0 + 1], bobIdx,
                            'colliding row 1 resolved to Bob, not trackless' + ctx);
                    });
                });

            it('same-count remap (2 identities): a second run changes nothing and all four sources agree',
                async function () {
                    await runTwice('lazy-propagate-twice.slp', { collapse: false, ambiguous: true });
                });

            it('COLLAPSING remap (2 tracks -> 1 identity): a second run leaves no extra overlapping track row',
                async function () {
                    const session = await runTwice('lazy-propagate-twice-collapse.slp',
                        { collapse: true, ambiguous: true });
                    assertEqual(session.tracks.length, 1,
                        'precondition: both raw tracks really did collapse onto one identity');
                });
        });
    });
})();
