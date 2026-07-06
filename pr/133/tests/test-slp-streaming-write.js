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

    const h5wasmUrl = location.origin + '/lib/h5wasm/h5wasm.iife.js';

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
                g.points3d = [[100 + f, 200, 300], [110, 210, 310]];
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

                const sj = JSON.parse(file.get('sessions_json').value[0]);
                assertTrue(!!sj.calibration, 'sessions_json missing calibration');
                assertEqual((sj.frame_group_dicts || []).length, 2, 'expected 2 frame groups');

                // Frame 0: cam0 → lf 0 (base 0 + row 0); cam1 → lf 4 (base 4 + row 0).
                const fg0 = sj.frame_group_dicts.find(function (d) { return d.frame_idx === 0; });
                assertDeepEqual(fg0.labeled_frame_by_camera, { '0': 0, '1': 4 }, 'frame 0 lf-by-camera');
                assertDeepEqual(fg0.instance_groups[0].camcorder_to_lf_and_inst_idx_map, { '0': [0, 0], '1': [4, 0] }, 'frame 0 instance refs');
                assertEqual((fg0.instance_groups[0].points || []).length, 2, 'frame 0 3D points');
                assertEqual(fg0.instance_groups[0].metadata.lucid.identityId, 1, 'frame 0 identityId');

                // Frame 2: cam0 → lf 2; cam1 → lf 6.
                const fg2 = sj.frame_group_dicts.find(function (d) { return d.frame_idx === 2; });
                assertDeepEqual(fg2.labeled_frame_by_camera, { '0': 2, '1': 6 }, 'frame 2 lf-by-camera');
                assertDeepEqual(fg2.instance_groups[0].camcorder_to_lf_and_inst_idx_map, { '0': [2, 0], '1': [6, 0] }, 'frame 2 instance refs');
            } finally {
                try { file.close(); } catch (e) { /* ignore */ }
                try { h5.FS.unlink(p); } catch (e) { /* ignore */ }
            }
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
            g.points3d = [[100, 200, 300], [110, 210, 310]];
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

                const sj = JSON.parse(file.get('sessions_json').value[0]);
                assertEqual(Object.keys(sj.calibration).filter(function (k) { return k.startsWith('cam_'); }).length, 3, 'cameraGroup keeps all 3 cameras');
                const fg0 = sj.frame_group_dicts.find(function (d) { return d.frame_idx === 0; });
                // Camera keys: cam0 → '0', cam1 → '2' (session index). lf-indices are
                // output frame positions: cam0 frame0 → 0, cam1 frame0 → 4.
                assertDeepEqual(fg0.labeled_frame_by_camera, { '0': 0, '2': 4 }, 'refs use session camera keys 0 and 2');
                assertDeepEqual(fg0.instance_groups[0].camcorder_to_lf_and_inst_idx_map, { '0': [0, 0], '2': [4, 0] }, 'instance refs resolve for both loaded cameras');
            } finally {
                try { file.close(); } catch (e) { /* ignore */ }
                try { h5.FS.unlink(p); } catch (e) { /* ignore */ }
            }
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
                g.points3d = [[100 + f, 200, 300], [110, 210, 310]];
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

                const sj = JSON.parse(file.get('sessions_json').value[0]);
                const byIdx = {};
                (sj.frame_group_dicts || []).forEach(function (d) { byIdx[d.frame_idx] = d; });

                // Overlay occupies lf 0. cam0 (no overlay) shifts up by E=1 → rows 0..3
                // become lf 1..4. cam1 rows 0,2,3 (row 1 skipped) → lf 5,6,7.
                assertDeepEqual(byIdx[0].labeled_frame_by_camera, { '0': 1, '1': 5 }, 'frame 0 lf-by-camera (shifted)');
                assertDeepEqual(byIdx[1].labeled_frame_by_camera, { '0': 2, '1': 0 }, 'frame 1 lf-by-camera (cam1 = overlay lf 0)');
                assertDeepEqual(byIdx[2].labeled_frame_by_camera, { '0': 3, '1': 6 }, 'frame 2 lf-by-camera (shifted)');

                assertDeepEqual(byIdx[1].instance_groups[0].camcorder_to_lf_and_inst_idx_map, { '0': [2, 0], '1': [0, 0] }, 'frame 1 refs: cam0 store lf2, cam1 overlay lf0/inst0');
                assertDeepEqual(byIdx[0].instance_groups[0].camcorder_to_lf_and_inst_idx_map, { '0': [1, 0], '1': [5, 0] }, 'frame 0 refs shifted');
            } finally {
                try { file.close(); } catch (e) { /* ignore */ }
                try { h5.FS.unlink(p); } catch (e) { /* ignore */ }
            }
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
