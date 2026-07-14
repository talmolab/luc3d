/**
 * test-slp-export-canonical.js — Browser regression guard for LUCID's SLP export
 * byte-path after PR 5.2.
 *
 *   build typed graph (buildSlpLabelsAllViews) -> SleapIO.saveSlpToBytes(labels) -> bytes
 *
 * PR 5.2 deleted `convertSlpToV06Compatible` (the old v0.6-compat post-pass that
 * rewrote flat matrices -> HDF5 compound datasets, pinned format_id 1.4, and
 * hand-rolled `sessions_json`). LUCID now writes sleap-io.js's RAW output
 * directly: SLEAP >= 1.6 (sleap-io >= 0.7) reads the flat-matrix `field_names`
 * layout natively (#378), and #198's session model serializes a canonical
 * `sessions_json` from the typed graph LUCID already builds.
 *
 * This guard locks the RAW export shape:
 *   - saveSlpToBytes produces valid HDF5 with the pose datasets + a `field_names`
 *     attribute (the SLEAP-0.7 flat->structured interop path), and
 *   - a multi-view session round-trips a canonical `sessions_json` carrying
 *     calibration + camcorder map + per-group metadata.lucid (instanceMeta,
 *     identityId) + instance3d.
 *
 * Requires the test-runner bridge: window.SleapIO (vendored bundle),
 * window.buildSlpLabelsAllViews (from file-io.js), and the pose-data classes on
 * window (Skeleton/Camera/Instance/FrameGroup/InstanceGroup/Session/Identity).
 *
 * NB: full LUCID<->LUCID round-trip parity is covered by the headless import
 * verification; SLEAP-Python interop (sleap_io 0.7.1) is gated by
 * scripts/validate_slp_sleap_compat.py on a machine with the SLEAP env.
 */

(function () {
    const { describe, it, assert, assertEqual, assertGreaterThan, assertTrue } = TestFramework;

    const HDF5_MAGIC = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]; // \x89HDF\r\n\x1a\n

    function isHdf5(bytes) {
        for (let i = 0; i < HDF5_MAGIC.length; i++) {
            if (bytes[i] !== HDF5_MAGIC[i]) return false;
        }
        return true;
    }

    // Minimal 1-camera Labels: one USER instance (-> `points`) on frame 0 and one
    // PREDICTED instance (-> `pred_points`) on frame 1. Two nodes, one edge.
    function buildTinyLabels() {
        const SIO = window.SleapIO;
        assert(SIO && SIO.Labels, 'window.SleapIO not available — test-runner export runtime missing');
        const nA = new SIO.Node('a');
        const nB = new SIO.Node('b');
        const skeleton = new SIO.Skeleton({ nodes: [nA, nB], edges: [new SIO.Edge(nA, nB)], name: 'sk' });
        const track = new SIO.Track('t0');
        const video = new SIO.Video({ filename: 'cam.mp4', backendMetadata: { type: 'MediaVideo', shape: [10, 64, 48, 1], filename: 'cam.mp4' }, openBackend: false });
        video.shape = [10, 64, 48, 1];
        const userInst = new SIO.Instance({ points: [{ xy: [1, 2], visible: true, complete: true }, { xy: [3, 4], visible: true, complete: true }], skeleton, track });
        const predInst = new SIO.PredictedInstance({ points: [{ xy: [5, 6], visible: true, complete: true, score: 0.9 }, { xy: [7, 8], visible: false, complete: false, score: 0.1 }], skeleton, track, score: 0.8 });
        const lf0 = new SIO.LabeledFrame({ video, frameIdx: 0, instances: [userInst] });
        const lf1 = new SIO.LabeledFrame({ video, frameIdx: 1, instances: [predInst] });
        return new SIO.Labels({ labeledFrames: [lf0, lf1], videos: [video], skeletons: [skeleton], tracks: [track], provenance: { source: 'lucid-test' } });
    }

    // A 2-camera LUCID Session with one grouped, triangulated frame — exercises the
    // canonical sessions_json path via the real buildSlpLabelsAllViews export builder.
    function buildMultiViewLabels() {
        const { Camera, Skeleton, Instance, FrameGroup, InstanceGroup, Session, Identity } = window;
        assert(Session && window.buildSlpLabelsAllViews, 'pose-data / buildSlpLabelsAllViews not bridged');
        const skeleton = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
        const cam0 = new Camera('cam0', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        const cam1 = new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0.1, 0, 0, 0, 0], [0.1, 0.2, 0.3], [1, 2, 3], [640, 480]);
        const session = new Session([cam0, cam1], skeleton, ['t0', 't1'], 'S1');
        session.trustTracks = true;
        session.identities = [new Identity(0, 'idA', '#ff0000'), new Identity(1, 'idB', '#00ff00')];
        const instA = new Instance([[10, 11], [12, 13]], 0, 'user', 0.9);
        instA.occluded = [false, true];
        const instB = new Instance([[20, 21], [22, 23]], null, 'predicted', 0.5);
        const fg = new FrameGroup(0);
        fg.addInstance('cam0', instA);
        fg.addInstance('cam1', instB);
        session.addFrameGroup(fg);
        const grp = new InstanceGroup(1, 1); // identityId 1 -> idB
        grp.addInstance('cam0', instA);
        grp.addInstance('cam1', instB);
        grp.points3d = [[100, 200, 300], [110, 210, 310]];
        session.instanceGroups.set(0, [grp]);
        return window.buildSlpLabelsAllViews(session, [], []);
    }

    async function openH5(bytes, tag) {
        const h5 = await import('h5wasm');
        await h5.ready;
        const p = '/lucid-canon-' + tag + '-' + Math.floor(performance.now()) + '.h5';
        h5.FS.writeFile(p, bytes);
        return { h5, file: new h5.File(p, 'r'), path: p };
    }

    describe('SLP canonical export (raw saveSlpToBytes, post-5.2)', function () {
        it('saveSlpToBytes produces a valid HDF5 buffer', async function () {
            const raw = await window.SleapIO.saveSlpToBytes(buildTinyLabels());
            assertGreaterThan(raw.length, 100, 'raw SLP bytes too small');
            assertTrue(isHdf5(raw), 'raw SLP bytes are not HDF5');
        });

        it('pose datasets exist and carry field_names attrs (SLEAP 0.7 flat->structured interop)', async function () {
            const raw = await window.SleapIO.saveSlpToBytes(buildTinyLabels());
            const { h5, file, path } = await openH5(raw, 'tiny');
            try {
                const keys = file.keys();
                ['metadata', 'frames', 'instances', 'points', 'pred_points'].forEach(function (k) {
                    assertTrue(keys.indexOf(k) >= 0, 'missing dataset/group: ' + k);
                });
                // Each flat record dataset advertises its columns via a field_names
                // attribute — this is what sleap_io >= 0.7 reads to rebuild the
                // structured array. Losing it would break SLEAP interop silently.
                ['frames', 'instances', 'points', 'pred_points'].forEach(function (name) {
                    const ds = file.get(name);
                    let fn = ds.get_attribute ? ds.get_attribute('field_names') : null;
                    assertTrue(fn != null, name + ' missing field_names attribute');
                });
            } finally {
                try { file.close(); } catch (e) {}
                try { h5.FS.unlink(path); } catch (e) {}
            }
        });

        it('multi-view export emits a canonical sessions_json with lucid metadata', async function () {
            const raw = await window.SleapIO.saveSlpToBytes(buildMultiViewLabels());
            const { h5, file, path } = await openH5(raw, 'mv');
            try {
                const keys = file.keys();
                assertTrue(keys.indexOf('sessions_json') >= 0, 'missing sessions_json');
                const sess = file.get('sessions_json').value;
                assertEqual(sess.length, 1, 'sessions_json length');
                const s = JSON.parse(sess[0]);
                assertTrue(!!s.calibration, 'sessions_json missing calibration');
                assertTrue(!!s.camcorder_to_video_idx_map, 'missing camcorder_to_video_idx_map');
                assertTrue(Array.isArray(s.frame_group_dicts) && s.frame_group_dicts.length === 1, 'expected 1 frame_group_dict');
                const ig = s.frame_group_dicts[0].instance_groups[0];
                const lucid = ig.metadata && ig.metadata.lucid;
                assertTrue(!!lucid, 'instance_group missing metadata.lucid');
                assertEqual(lucid.identityId, 1, 'per-session identityId not persisted');
                // Slim metadata (#134): instanceMeta is a container, but
                // trackIdx/type/score/occluded are NOT written per instance —
                // they are reconstructed from the standard SLP instance on load.
                // Per-camera entries appear only for modified/occluded instances
                // (these fixtures have none), so instanceMeta is empty here.
                assertTrue(!!lucid.instanceMeta && typeof lucid.instanceMeta === 'object', 'instanceMeta container present');
                assertEqual(Object.keys(lucid.instanceMeta).length, 0, 'unmodified instances emit no per-camera metadata');
                assertTrue(Array.isArray(ig.points) && ig.points.length === 2, 'instance_group 3D points not persisted');
            } finally {
                try { file.close(); } catch (e) {}
                try { h5.FS.unlink(path); } catch (e) {}
            }
        });
    });
})();
