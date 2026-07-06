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
    });
})();
