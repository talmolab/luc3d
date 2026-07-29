/**
 * test-slp-streaming-write.js — integration test for the memory-bounded streaming
 * SLP *save* of a lazy session (import-export/slp-streaming-write.js).
 *
 * Builds two per-camera predicted stores, wires a SioLazyLoader + a LUCID Session
 * with triangulated grouping over them, runs `buildSessionSlpBytesStreaming`, and
 * asserts at the HDF5 level that:
 *   - EVERY frame from both cameras survives (the silent-drop the eager builder had
 *     on a lazy session is fixed), and
 *   - the ref-based `sessions_json` grouping resolves to the correct output indices
 *     (labeled_frame_by_camera / camcorder_to_lf_and_inst_idx_map) with 3D + identity.
 *
 * Requires the test-runner bridge: window.SleapIO (writer API), window.SioLazyLoader,
 * and the pose-data classes (Session/Camera/Skeleton/Instance/InstanceGroup/Identity).
 */

(function () {
    const { describe, it, assertEqual, assertTrue, assertGreaterThan, assertDeepEqual } = TestFramework;

    // Resolve against the test page (tests/test-runner.html), so `../lib/...` →
    // <app base>/lib/... — correct on localhost (root) AND on the GitHub Pages
    // sub-path preview (/luc3d/pr/<n>/). `location.origin + '/lib/...'` was
    // origin-root-relative and 404'd the h5wasm worker script on the sub-path.
    const h5wasmUrl = new URL('../lib/h5wasm/h5wasm.iife.js', document.baseURI).href;

    function mkVideo(S, fn, n) {
        const v = new S.Video({ filename: fn, backendMetadata: { type: 'MediaVideo', shape: [n, 64, 48, 1], filename: fn }, openBackend: false });
        v.shape = [n, 64, 48, 1];
        return v;
    }
    async function storeBytes(S, fn, n) {
        const sk = new S.Skeleton({ nodes: [new S.Node('nose'), new S.Node('tail')], edges: [new S.Edge(new S.Node('nose'), new S.Node('tail'))], name: 'sk' });
        const tr = [new S.Track('t0'), new S.Track('t1')];
        const v = mkVideo(S, fn, n);
        const lfs = [];
        for (let f = 0; f < n; f++) {
            const insts = [];
            for (let k = 0; k < 2; k++) {
                insts.push(new S.PredictedInstance({ points: [{ xy: [f * 10 + k, f * 10 + k + 1], visible: true, complete: true, score: 1 }, { xy: [f * 10 + k + 2, f * 10 + k + 3], visible: true, complete: true, score: 1 }], skeleton: sk, track: tr[k], score: 0.9 }));
            }
            lfs.push(new S.LabeledFrame({ video: v, frameIdx: f, instances: insts }));
        }
        return await S.saveSlpToBytes(new S.Labels({ labeledFrames: lfs, videos: [v], skeletons: [sk], tracks: tr, provenance: {} }));
    }
    async function openLazy(S, bytes, fn) {
        return await S.readSlpStreaming(new File([bytes], fn), { lazy: true, openVideos: false, h5wasmUrl });
    }

    // SLP 2.8 (#546/#224): 3D grouping moved OUT of the inline `sessions_json`
    // `frame_group_dicts` into the columnar `/session_data` group. The refs
    // (camcorder→(lf,inst)) are now `instance_group_members` rows that the reader
    // resolves back into concrete instances. Rather than assert the columnar
    // bytes directly (a brittle multi-table join), read the file back through the
    // real `readSlpStreaming` and check the resolved typed grouping — this proves
    // the write emitted refs that resolve to the CORRECT instances (the same
    // correctness `camcorder_to_lf_and_inst_idx_map` used to lock, and what #159's
    // regression guard checks). Returns `Map<frameIdx, [{cams, points3d, identityId}]>`.
    async function readBackGroups(S, bytes, fn) {
        const lab = await S.readSlpStreaming(new File([bytes], fn || ('rb-' + Math.floor(performance.now()) + '.slp')),
            { openVideos: false, rawSessions: true, h5wasmUrl });
        const sess = (lab.sessions || [])[0];
        const out = new Map();
        if (sess && sess.frameGroups) {
            for (const [fidx, fg] of sess.frameGroups) {
                const groups = [];
                for (const ig of (fg.instanceGroups || [])) {
                    const cams = {};
                    for (const [cam, inst] of ig.instanceByCamera) {
                        const xy = inst._xy || [];
                        const pts = [];
                        for (let k = 0; 2 * k + 1 < xy.length; k++) pts.push([xy[2 * k], xy[2 * k + 1]]);
                        cams[(cam && cam.name) || '?'] = {
                            points: pts,
                            isPred: !!(S.PredictedInstance && inst instanceof S.PredictedInstance),
                        };
                    }
                    const lucid = (ig.metadata && ig.metadata.lucid) || {};
                    groups.push({
                        cams: cams,
                        points3d: ig.instance3d ? ig.instance3d.points : null,
                        identityId: lucid.identityId,
                    });
                }
                out.set(Number(fidx), groups);
            }
        }
        return { lab: lab, groups: out };
    }

    // Structural check: SLP 2.8 writes the columnar `/session_data` group and a
    // SLIM `sessions_json` (no inline `frame_group_dicts`).
    function assertColumnarSessionData(file, expectPts3dRows) {
        const keys = file.keys();
        assertTrue(keys.indexOf('session_data') >= 0, 'missing /session_data group (SLP 2.8)');
        const sdKeys = file.get('session_data').keys();
        ['frame_groups', 'instance_groups', 'instance_group_members', 'points_3d'].forEach(function (k) {
            assertTrue(sdKeys.indexOf(k) >= 0, '/session_data missing ' + k);
        });
        const sj = JSON.parse(file.get('sessions_json').value[0]);
        assertTrue(!sj.frame_group_dicts || sj.frame_group_dicts.length === 0,
            'sessions_json must NOT carry inline frame_group_dicts under SLP 2.8 (moved to /session_data)');
        if (expectPts3dRows != null) {
            const p3 = file.get('session_data/points_3d').shape;
            assertEqual(p3[0], expectPts3dRows, 'points_3d row count');
            assertEqual(p3[1], 3, 'points_3d must be (N,3)');
        }
        return sj;
    }

    describe('SLP streaming save (lazy session)', function () {
        it('preserves every frame and the ref-based 3D grouping', async function () {
            const S = window.SleapIO;
            assertTrue(S && typeof S.openSlpWriter === 'function', 'streaming writer API not bridged');
            assertTrue(!!window.SioLazyLoader && !!window.Session, 'SioLazyLoader / pose-data not bridged');
            const { buildSessionSlpBytesStreaming } = await import('../import-export/slp-streaming-write.js');

            // Two per-camera predicted stores (4 frames each, 2 tracks).
            const labA = await openLazy(S, await storeBytes(S, 'cam0.mp4', 4), 'a.slp');
            const labB = await openLazy(S, await storeBytes(S, 'cam1.mp4', 4), 'b.slp');

            // Wire a SioLazyLoader by hand (bypass open() so we control h5wasmUrl).
            const loader = new window.SioLazyLoader();
            [['cam0', labA], ['cam1', labB]].forEach(function (pair) {
                const cn = pair[0], lab = pair[1];
                loader.labelsByCam.set(cn, lab);
                const st = lab._lazyDataStore;
                const rm = new Map();
                const fc = st.framesData.frame_idx;
                for (let r = 0; r < fc.length; r++) rm.set(Number(fc[r]), r);
                loader.frameRowByCam.set(cn, rm);
            });
            loader.nFrames = 4;

            const { Camera, Skeleton, Session, Instance, InstanceGroup, Identity } = window;
            const sk = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
            const c0 = new Camera('cam0', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            const c1 = new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0.1, 0, 0, 0, 0], [0.1, 0.2, 0.3], [1, 2, 3], [640, 480]);
            const session = new Session([c0, c1], sk, ['t0', 't1'], 'S1');
            session.identities = [new Identity(0, 'idA', '#ff0000'), new Identity(1, 'idB', '#00ff00')];
            session.lazyLoader = loader;
            // Group track 0 across both cameras on frames 0 and 2, with 3D + identity 1.
            [0, 2].forEach(function (f) {
                const iA = new Instance([[1, 2], [3, 4]], 0, 'predicted', 0.9);
                const iB = new Instance([[5, 6], [7, 8]], 0, 'predicted', 0.9);
                const g = new InstanceGroup(f + 1, 1);
                g.addInstance('cam0', iA); g.addInstance('cam1', iB);
                g.points3d = fromBoxedPoints3d([[100 + f, 200, 300], [110, 210, 310]]);
                session.instanceGroups.set(f, [g]);
            });

            const bytes = await buildSessionSlpBytesStreaming(session, [], []);
            assertGreaterThan(bytes.length, 1000, 'streaming save produced too few bytes');

            const h5 = await import('h5wasm');
            await h5.ready;
            const p = '/lucid-ss-' + Math.floor(performance.now()) + '.h5';
            h5.FS.writeFile(p, bytes);
            const file = new h5.File(p, 'r');
            try {
                // Every frame survives: 4 (cam0) + 4 (cam1) = 8, no silent drop.
                assertEqual(file.get('frames').shape[0], 8, 'all frames from both cameras preserved');

                // SLP 2.8: slim sessions_json + columnar /session_data. Two groups
                // (frames 0, 2), each with 2 nodes → 4 3D-point rows.
                const sj = assertColumnarSessionData(file, 4);
                assertTrue(!!sj.calibration, 'sessions_json missing calibration');
            } finally {
                try { file.close(); } catch (e) { /* ignore */ }
                try { h5.FS.unlink(p); } catch (e) { /* ignore */ }
            }

            // Round-trip the refs: the reader must resolve each group member back to
            // the CORRECT instance (cam0 = iA, cam1 = iB) with its 3D + identity.
            const { groups } = await readBackGroups(S, bytes);
            assertEqual(groups.size, 2, 'expected grouped frames 0 and 2');
            // The group members are REFS resolved by track into each camera's store
            // row (the group's own placeholder Instance points are not what persists;
            // the ref → store instance is). Track 0 on frame f = the store's k=0 row:
            // [[f*10, f*10+1], [f*10+2, f*10+3]].
            [0, 2].forEach(function (f) {
                const g = groups.get(f);
                assertTrue(!!g && g.length === 1, 'frame ' + f + ' has exactly 1 instance group');
                const grp = g[0];
                assertEqual(grp.identityId, 1, 'frame ' + f + ' identityId');
                assertTrue(points3dNodeCount(grp.points3d) === 2, 'frame ' + f + ' 3D points');
                assertDeepEqual(getPoint3d(grp.points3d, 0), [100 + f, 200, 300], 'frame ' + f + ' 3D[0]');
                const t0 = [[f * 10, f * 10 + 1], [f * 10 + 2, f * 10 + 3]];
                assertDeepEqual(Object.keys(grp.cams).sort(), ['cam0', 'cam1'], 'frame ' + f + ' has both camera members');
                assertDeepEqual(grp.cams.cam0.points, t0, 'frame ' + f + ' cam0 member resolves to store track0 row');
                assertDeepEqual(grp.cams.cam1.points, t0, 'frame ' + f + ' cam1 member resolves to store track0 row');
            });
        });

        it('propagateIdentitiesToTracks then export: EVERY frame from BOTH (non-shared-store) cameras carries correct tracks, not just the first', async function () {
            // Regression for "export only has tracks on the first frame, the rest
            // are empty": two SEPARATE per-camera prediction files (session-folder
            // load — NOT SioLazyLoader.openProjectSlp's single shared store) each
            // have their OWN `labels.tracks` array. After
            // Session.propagateIdentitiesToTracks rewrites every camera's tracks
            // to the SAME identity-derived list (loading/sio-lazy-loader.js
            // remapTracksFromIdentity), buildSessionRefGraph's non-shared-store
            // branch (import-export/slp-streaming-write.js) used to blindly
            // re-append each camera's now-identical track list as a FRESH
            // duplicate copy under an increasing trackOffset instead of
            // recognizing they're the same list and reusing one shared base —
            // this test would have caught that (asserted via `rb.tracks.length`
            // below), and separately proves every frame from every camera
            // resolves to a valid, correctly-named track after a real
            // propagate + real streaming export + real readback — not a mock.
            const S = window.SleapIO;
            const { buildSessionSlpBytesStreaming } = await import('../import-export/slp-streaming-write.js');

            const N = 5; // >1 frame is the whole point — must catch "only frame 0 survives"
            const labA = await openLazy(S, await storeBytes(S, 'cam0.mp4', N), 'pa.slp');
            const labB = await openLazy(S, await storeBytes(S, 'cam1.mp4', N), 'pb.slp');

            const loader = new window.SioLazyLoader();
            [['cam0', labA], ['cam1', labB]].forEach(function (pair) {
                const cn = pair[0], lab = pair[1];
                loader.labelsByCam.set(cn, lab);
                const st = lab._lazyDataStore;
                const rm = new Map();
                const fc = st.framesData.frame_idx;
                for (let r = 0; r < fc.length; r++) rm.set(Number(fc[r]), r);
                loader.frameRowByCam.set(cn, rm);
            });
            loader.nFrames = N;

            const { Camera, Skeleton, Session } = window;
            const sk = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
            const c0 = new Camera('cam0', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            const c1 = new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0.1, 0, 0, 0, 0], [0.1, 0.2, 0.3], [1, 2, 3], [640, 480]);
            const session = new Session([c0, c1], sk, ['t0', 't1'], 'S2');
            session.lazyLoader = loader;

            // Simulate Track All's cross-view identity assignment: the fixture's
            // raw per-camera track 0 -> Alice, track 1 -> Bob, consistently
            // across BOTH cameras and EVERY frame (exactly what
            // commitTrackedFrame's per-frame setFrameIdentity calls do for a
            // real cross-view match).
            const idA = session.addIdentity('Alice');
            const idB = session.addIdentity('Bob');
            for (let f = 0; f < N; f++) {
                ['cam0', 'cam1'].forEach(function (cam) {
                    session.setFrameIdentity(f, cam, 0, idA.id);
                    session.setFrameIdentity(f, cam, 1, idB.id);
                });
            }

            const res = session.propagateIdentitiesToTracks();
            assertEqual(res.tracks, 2, 'two tracks from the two used identities');
            assertEqual(res.lazyErrorRows || 0, 0, 'no row-remap errors during propagate');

            const bytes = await buildSessionSlpBytesStreaming(session, [], []);
            const rb = await S.readSlpStreaming(new File([bytes], 'prb.slp'), { lazy: true, openVideos: false, h5wasmUrl: h5wasmUrl });

            assertEqual(rb.tracks.length, 2,
                'exactly 2 tracks in the exported file — NOT 4 (one duplicate pair per camera, the exact bug: ' +
                'each non-shared-store camera re-appending its own copy of the now-identical post-propagate list)');
            assertDeepEqual(rb.tracks.map(function (t) { return t.name; }).sort(), ['Alice', 'Bob'],
                'track names are the identity names, unduplicated');

            const store = rb._lazyDataStore;
            const fd = store.framesData;
            const idn = store.instancesData;
            let checkedRows = 0;
            for (let r = 0; r < fd.frame_idx.length; r++) {
                const frameIdx = Number(fd.frame_idx[r]);
                const iStart = Number(fd.instance_id_start[r]);
                const iEnd = Number(fd.instance_id_end[r]);
                assertEqual(iEnd - iStart, 2, 'row ' + r + ' (frame ' + frameIdx + ') has both instances');
                const namesHere = [];
                for (let j = iStart; j < iEnd; j++) {
                    const trk = Number(idn.track[j]);
                    assertTrue(trk >= 0 && trk < rb.tracks.length,
                        'row ' + r + ' frame ' + frameIdx + ' instance ' + j + ' has a VALID track index — ' +
                        'this is the exact "only the first frame has tracks, the rest are empty" regression');
                    namesHere.push(rb.tracks[trk].name);
                }
                assertDeepEqual(namesHere.sort(), ['Alice', 'Bob'], 'frame ' + frameIdx + ' resolves both identity tracks');
                checkedRows++;
            }
            assertEqual(checkedRows, N * 2, 'checked every frame row from BOTH cameras (' + N + ' frames x 2 cameras), not just the first');
        });

        it('tolerates calibration-only cameras with no loaded store (video-id offset)', async function () {
            // Real sessions calibrate N cameras but load videos for a subset. The
            // builder must still emit a header camera+video for the unloaded ones
            // (calibration round-trip) and offset the loaded cameras' video ids past
            // them — NOT throw "lazy store missing".
            const S = window.SleapIO;
            const { buildSessionSlpBytesStreaming } = await import('../import-export/slp-streaming-write.js');
            const labA = await openLazy(S, await storeBytes(S, 'cam0.mp4', 4), 'ca.slp');
            const labB = await openLazy(S, await storeBytes(S, 'cam1.mp4', 4), 'cb.slp');

            const loader = new window.SioLazyLoader();
            [['cam0', labA], ['cam1', labB]].forEach(function (pair) {
                loader.labelsByCam.set(pair[0], pair[1]);
                const st = pair[1]._lazyDataStore, rm = new Map(), fc = st.framesData.frame_idx;
                for (let r = 0; r < fc.length; r++) rm.set(Number(fc[r]), r);
                loader.frameRowByCam.set(pair[0], rm);
            });
            loader.nFrames = 4;

            const { Camera, Skeleton, Session, Instance, InstanceGroup } = window;
            const sk = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
            const mk = function (n, d) { return new Camera(n, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], d, [0, 0, 0], [0, 0, 0], [640, 480]); };
            // Camera order: cam0 (loaded), camCalib (NOT loaded), cam1 (loaded).
            const session = new Session([mk('cam0', [0, 0, 0, 0, 0]), mk('camCalib', [0, 0, 0, 0, 0]), mk('cam1', [0.1, 0, 0, 0, 0])], sk, ['t0', 't1'], 'S1');
            session.lazyLoader = loader;
            // Group track 0 across the two LOADED cameras on frame 0.
            const g = new InstanceGroup(1, -1);
            g.addInstance('cam0', new Instance([[1, 2], [3, 4]], 0, 'predicted', 0.9));
            g.addInstance('cam1', new Instance([[5, 6], [7, 8]], 0, 'predicted', 0.9));
            g.points3d = fromBoxedPoints3d([[100, 200, 300], [110, 210, 310]]);
            session.instanceGroups.set(0, [g]);

            const bytes = await buildSessionSlpBytesStreaming(session, [], []);
            const h5 = await import('h5wasm');
            await h5.ready;
            const p = '/lucid-ss-calib-' + Math.floor(performance.now()) + '.h5';
            h5.FS.writeFile(p, bytes);
            const file = new h5.File(p, 'r');
            try {
                // Only the two loaded cameras contribute frames (4 + 4).
                assertEqual(file.get('frames').shape[0], 8, 'loaded cameras preserved; calibration-only contributes none');
                // Loaded cameras map to video ids 0 and 2 (camCalib occupies index 1).
                const fv = file.get('frames').value;
                const vids = {};
                for (let i = 1; i < fv.length; i += 5) { const v = Number(fv[i]); vids[v] = (vids[v] || 0) + 1; }
                assertDeepEqual(vids, { 0: 4, 2: 4 }, 'loaded cameras land at video ids 0 and 2 (skip calib camera 1)');
                assertEqual(file.get('videos_json').value.length, 3, 'all 3 cameras get a header video (calibration round-trip)');

                // SLP 2.8: slim sessions_json + columnar /session_data (1 group, 2 nodes → 2 rows).
                const sj = assertColumnarSessionData(file, 2);
                assertEqual(Object.keys(sj.calibration).filter(function (k) { return k.startsWith('cam_'); }).length, 3, 'cameraGroup keeps all 3 cameras');
            } finally {
                try { file.close(); } catch (e) { /* ignore */ }
                try { h5.FS.unlink(p); } catch (e) { /* ignore */ }
            }

            // Round-trip: the single group on frame 0 resolves ONLY to the two
            // LOADED cameras (cam0, cam1); the calibration-only camCalib is not a
            // member. This is the ref-resolution the old lf-by-camera assertion locked.
            const { groups } = await readBackGroups(S, bytes);
            const g0 = groups.get(0);
            assertTrue(!!g0 && g0.length === 1, 'frame 0 has exactly 1 instance group');
            assertDeepEqual(Object.keys(g0[0].cams).sort(), ['cam0', 'cam1'], 'group resolves to the two loaded cameras only (not camCalib)');
            // Refs resolve by track into each loaded store's frame-0 track-0 row.
            assertDeepEqual(g0[0].cams.cam0.points, [[0, 1], [2, 3]], 'cam0 member resolves to store track0 row');
            assertDeepEqual(g0[0].cams.cam1.points, [[0, 1], [2, 3]], 'cam1 member resolves to store track0 row');
            assertTrue(points3dNodeCount(g0[0].points3d) === 2, 'group 3D points round-trip');
        });

        it('overlays 2D user corrections and reshifts store refs (edited frame)', async function () {
            const S = window.SleapIO;
            assertTrue(S && typeof S.openSlpWriter === 'function', 'streaming writer API not bridged');
            assertTrue(!!window.SioLazyLoader && !!window.Session, 'SioLazyLoader / pose-data not bridged');
            const { buildSessionSlpBytesStreaming } = await import('../import-export/slp-streaming-write.js');

            // Two per-camera predicted stores (4 frames each, 2 tracks).
            const labA = await openLazy(S, await storeBytes(S, 'cam0.mp4', 4), 'ea.slp');
            const labB = await openLazy(S, await storeBytes(S, 'cam1.mp4', 4), 'eb.slp');

            const loader = new window.SioLazyLoader();
            [['cam0', labA], ['cam1', labB]].forEach(function (pair) {
                const cn = pair[0], lab = pair[1];
                loader.labelsByCam.set(cn, lab);
                const st = lab._lazyDataStore;
                const rm = new Map();
                const fc = st.framesData.frame_idx;
                for (let r = 0; r < fc.length; r++) rm.set(Number(fc[r]), r);
                loader.frameRowByCam.set(cn, rm);
            });
            loader.nFrames = 4;

            const { Camera, Skeleton, Session, Instance, InstanceGroup } = window;
            const sk = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
            const c0 = new Camera('cam0', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            const c1 = new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0.1, 0, 0, 0, 0], [0.1, 0.2, 0.3], [1, 2, 3], [640, 480]);
            const session = new Session([c0, c1], sk, ['t0', 't1'], 'S1');
            session.lazyLoader = loader;

            // Edit: correct cam1 / frame 1, track 0 (a user instance); keep track 1
            // predicted+unlinked so the overlay carries the full camera-frame.
            const userInst = session.addNewInstance(1, 'cam1', sk, 0);   // track 0, user
            userInst.points = [[999, 888], [777, 666]];
            userInst.occluded = [false, false];
            const predSibling = new Instance([[11, 12], [13, 14]], 1, 'predicted', 0.9);   // track 1
            session.addUnlinkedInstance(1, 'cam1', predSibling);

            // Groups: track 0 across both cameras on frames 0,1,2. Frame 1's cam1
            // uses the corrected user instance object (so it resolves to the overlay).
            function grp(f, camInstB) {
                const iA = new Instance([[1, 2], [3, 4]], 0, 'predicted', 0.9);
                const g = new InstanceGroup(f + 1, -1);
                g.addInstance('cam0', iA);
                g.addInstance('cam1', camInstB);
                g.points3d = fromBoxedPoints3d([[100 + f, 200, 300], [110, 210, 310]]);
                session.instanceGroups.set(f, [g]);
            }
            grp(0, new Instance([[5, 6], [7, 8]], 0, 'predicted', 0.9));
            grp(1, userInst);   // cam1 / frame 1 = corrected user instance (overlay)
            grp(2, new Instance([[5, 6], [7, 8]], 0, 'predicted', 0.9));

            const bytes = await buildSessionSlpBytesStreaming(session, [], []);
            assertGreaterThan(bytes.length, 1000, 'streaming save produced too few bytes');

            const h5 = await import('h5wasm');
            await h5.ready;
            const p = '/lucid-ss-edit-' + Math.floor(performance.now()) + '.h5';
            h5.FS.writeFile(p, bytes);
            const file = new h5.File(p, 'r');
            try {
                // 1 overlay (cam1/f1) shadows cam1 store row 1 → 1 + 4 (cam0) + 3 (cam1) = 8.
                assertEqual(file.get('frames').shape[0], 8, 'overlay shadows the store row (no duplicate frame)');

                // The corrected 2D goes to the USER `points` dataset (store instances are
                // all predicted → pred_points), so it holds exactly the 2 corrected keypoints.
                const pts = file.get('points');
                assertEqual(pts.shape[0], 2, 'exactly the overlay user keypoints in points');
                const pv = Array.from(pts.value);   // flat [x,y,vis,complete] × 2 rows
                assertDeepEqual([pv[0], pv[1], pv[4], pv[5]], [999, 888, 777, 666], 'corrected xy written');

                // The predicted SIBLING re-materialized on the edited frame keeps a
                // per-point score (appendFrames writes overlays first, so it is the
                // first pred_points row) — else SLEAP's GUI hides it.
                const pp = file.get('pred_points');
                const ppv = Array.from(pp.value);   // flat [x,y,vis,complete,score]
                // ≈0.9 (the instance-level score), stored at float32 precision — the
                // point is NOT 0 (which SLEAP would hide) and NOT the store's 1.0.
                assertTrue(Math.abs(ppv[4] - 0.9) < 1e-3, 'overlaid predicted sibling carries its per-point score (~0.9, not 0)');

                // SLP 2.8: slim sessions_json + columnar /session_data (3 groups, 2 nodes → 6 rows).
                assertColumnarSessionData(file, 6);
            } finally {
                try { file.close(); } catch (e) { /* ignore */ }
                try { h5.FS.unlink(p); } catch (e) { /* ignore */ }
            }

            // Round-trip: the overlay reshift must make frame 1's cam1 member resolve
            // to the CORRECTED USER instance ([[999,888],[777,666]], not a store row),
            // while the other cameras/frames resolve to their predicted store rows.
            // This is the ref-reshift correctness the old lf-by-camera indices locked.
            const { groups } = await readBackGroups(S, bytes);
            assertEqual(groups.size, 3, 'grouped frames 0, 1, 2');
            const gf1 = groups.get(1);
            assertTrue(!!gf1 && gf1.length === 1, 'frame 1 has exactly 1 instance group');
            // cam1/frame1 resolves to the corrected USER overlay (unique points),
            // NOT a predicted store row — the whole point of the overlay reshift.
            assertDeepEqual(gf1[0].cams.cam1.points, [[999, 888], [777, 666]], 'frame 1 cam1 = corrected user overlay');
            assertTrue(gf1[0].cams.cam1.isPred === false, 'frame 1 cam1 member is the USER correction (not predicted store row)');
            // cam0/frame1 has no overlay → resolves to its store frame-1 track-0 row.
            assertDeepEqual(gf1[0].cams.cam0.points, [[10, 11], [12, 13]], 'frame 1 cam0 = store frame1 track0 row');
            const gf0 = groups.get(0);
            // frame 0 has no overlay on either camera → both resolve to store frame-0 track-0.
            assertDeepEqual(gf0[0].cams.cam1.points, [[0, 1], [2, 3]], 'frame 0 cam1 = store frame0 track0 row (not the overlay)');
            assertTrue(gf0[0].cams.cam1.isPred === true, 'frame 0 cam1 member is a predicted store row');
        });

        it('per-camera export of a lazy session writes all frames (Download-All path)', async function () {
            const S = window.SleapIO;
            assertTrue(typeof window.exportSlpClientSide === 'function', 'exportSlpClientSide not bridged');
            const lab = await openLazy(S, await storeBytes(S, 'cam0.mp4', 5), 'c.slp');
            const loader = new window.SioLazyLoader();
            loader.labelsByCam.set('cam0', lab);
            const st = lab._lazyDataStore;
            const rm = new Map();
            const fc = st.framesData.frame_idx;
            for (let r = 0; r < fc.length; r++) rm.set(Number(fc[r]), r);
            loader.frameRowByCam.set('cam0', rm);
            loader.nFrames = 5;

            const { Camera, Skeleton, Session } = window;
            const sk = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
            const c0 = new Camera('cam0', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            const session = new Session([c0], sk, ['t0', 't1'], 'S1');
            session.lazyLoader = loader;

            // Plain export (no reproj / no filter) → lazy fast-path, all frames.
            const blob = await window.exportSlpClientSide(session, 'cam0', null, null, null, undefined);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const rb = await openLazy(S, bytes, 'rb.slp');
            assertEqual(rb._lazyDataStore.framesData.frame_idx.length, 5, 'per-camera export preserved all 5 frames');
            assertEqual(rb._lazyDataStore.instancesData.track.length, 10, 'per-camera export preserved all instances');
        });
    });
})();
