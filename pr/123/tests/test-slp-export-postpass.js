/**
 * test-slp-export-postpass.js — Browser regression guard for the SLP export
 * byte-path that LUCID owns on top of sleap-io.js:
 *
 *   build SIO Labels  ->  SleapIO.saveSlpToBytes(labels)  ->  rawBytes
 *   convertSlpToV06Compatible(rawBytes, calibSessions)     ->  outBytes  (what LUCID writes)
 *
 * Why this test exists (the sleap-io.js catch-up, 2026-07):
 *   `convertSlpToV06Compatible` (import-export/file-io.js) reopens the bytes
 *   sleap-io.js's writer produces and rewrites `instances`/`frames`/`points`/
 *   `pred_points` from sleap-io.js's FLAT 2-D matrix layout into real HDF5
 *   compound datasets, mapping columns by the hard-coded `_SLP_*_FIELDS`
 *   (10 / 5 / 4 / 5 columns) and asserting `flat.length === nrows*ncols`.
 *   If a sleap-io.js bump ever changed the WRITER's column count or order, that
 *   assert throws and export silently breaks. This test locks the invariant:
 *   run it green under the CURRENT vendored bundle, then again after any
 *   re-vendor (v0.4.1 / main) — it must stay green.
 *
 * Requires the export runtime the test-runner sets up: the importmap
 * (h5wasm/yaml/mediabunny), `window.SleapIO` (the vendored bundle), and the
 * bridged `convertSlpToV06Compatible` from file-io.js.
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

    // Build a minimal 1-camera Labels with one USER instance (-> `points`) on
    // frame 0 and one PREDICTED instance (-> `pred_points`) on frame 1, so both
    // compound writers in the post-pass are exercised. Two nodes, one edge.
    function buildTinyLabels() {
        const SIO = window.SleapIO;
        assert(SIO && SIO.Labels, 'window.SleapIO not available — test-runner export runtime missing');

        const nA = new SIO.Node('a');
        const nB = new SIO.Node('b');
        const skeleton = new SIO.Skeleton({ nodes: [nA, nB], edges: [new SIO.Edge(nA, nB)], name: 'sk' });
        const track = new SIO.Track('t0');
        const video = new SIO.Video({
            filename: 'cam.mp4',
            backendMetadata: { type: 'MediaVideo', shape: [10, 64, 48, 1], filename: 'cam.mp4' },
            openBackend: false,
        });
        video.shape = [10, 64, 48, 1];

        const userInst = new SIO.Instance({
            points: [
                { xy: [1, 2], visible: true, complete: true },
                { xy: [3, 4], visible: true, complete: true },
            ],
            skeleton: skeleton, track: track,
        });
        const predInst = new SIO.PredictedInstance({
            points: [
                { xy: [5, 6], visible: true, complete: true, score: 0.9 },
                { xy: [7, 8], visible: false, complete: false, score: 0.1 },
            ],
            skeleton: skeleton, track: track, score: 0.8,
        });

        const lf0 = new SIO.LabeledFrame({ video: video, frameIdx: 0, instances: [userInst] });
        const lf1 = new SIO.LabeledFrame({ video: video, frameIdx: 1, instances: [predInst] });

        return new SIO.Labels({
            labeledFrames: [lf0, lf1],
            videos: [video],
            skeletons: [skeleton],
            tracks: [track],
            provenance: { source: 'lucid-test' },
        });
    }

    // Minimal sessions_json payload in the v0.6.5 make_session shape LUCID emits.
    function tinyCalibSessions() {
        return [{
            calibration: { '0': { name: 'cam', matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], distortions: [0, 0, 0, 0, 0], rotation: [0, 0, 0], translation: [0, 0, 0], size: [48, 64] } },
            camcorder_to_video_idx_map: { '0': 0 },
            frame_group_dicts: [],
            metadata: { lucid: { sessionName: 'test' } },
        }];
    }

    describe('SLP export post-pass (convertSlpToV06Compatible)', function () {
        it('SleapIO.saveSlpToBytes produces a valid HDF5 buffer', async function () {
            const labels = buildTinyLabels();
            const raw = await window.SleapIO.saveSlpToBytes(labels);
            assertGreaterThan(raw.length, 100, 'raw SLP bytes too small');
            assertTrue(isHdf5(raw), 'raw SLP bytes are not HDF5');
        });

        // THE column-layout guard: a change in the writer's flat-matrix column
        // count/order makes _writeCompoundFromMatrix throw. Completing = layout intact.
        it('convertSlpToV06Compatible runs without throwing (locks flat-matrix column layout)', async function () {
            const raw = await window.SleapIO.saveSlpToBytes(buildTinyLabels());
            const out = await window.convertSlpToV06Compatible(raw, tinyCalibSessions());
            assertGreaterThan(out.length, 100, 'post-pass output too small');
            assertTrue(isHdf5(out), 'post-pass output is not HDF5');
        });

        it('output has the expected compound pose datasets with correct row counts', async function () {
            const raw = await window.SleapIO.saveSlpToBytes(buildTinyLabels());
            const out = await window.convertSlpToV06Compatible(raw, tinyCalibSessions());

            const h5 = await import('h5wasm');
            await h5.ready;
            const p = '/lucid-postpass-test-' + Math.floor(performance.now()) + '.h5';
            h5.FS.writeFile(p, out);
            const f = new h5.File(p, 'r');
            try {
                const keys = f.keys();
                ['metadata', 'frames', 'instances', 'points', 'pred_points', 'sessions_json'].forEach(function (k) {
                    assertTrue(keys.indexOf(k) >= 0, 'missing dataset/group: ' + k);
                });
                // Compound datasets report [nrows] as shape.
                assertEqual(Number(f.get('frames').shape[0]), 2, 'frames rows');
                assertEqual(Number(f.get('instances').shape[0]), 2, 'instances rows');
                assertEqual(Number(f.get('points').shape[0]), 2, 'points rows (1 user instance x 2 nodes)');
                assertEqual(Number(f.get('pred_points').shape[0]), 2, 'pred_points rows (1 predicted instance x 2 nodes)');

                const sess = f.get('sessions_json').value;
                assertEqual(sess.length, 1, 'sessions_json length');
                const parsed = JSON.parse(sess[0]);
                assertTrue(!!parsed.calibration, 'sessions_json missing calibration');
                assertTrue(!!parsed.camcorder_to_video_idx_map, 'sessions_json missing camcorder_to_video_idx_map');
            } finally {
                try { f.close(); } catch (e) {}
                try { h5.FS.unlink(p); } catch (e) {}
            }
        });

        it('metadata format_id is downgraded to 1.4 and skeleton nodes survive', async function () {
            const raw = await window.SleapIO.saveSlpToBytes(buildTinyLabels());
            const out = await window.convertSlpToV06Compatible(raw, tinyCalibSessions());

            const h5 = await import('h5wasm');
            await h5.ready;
            const p = '/lucid-postpass-meta-' + Math.floor(performance.now()) + '.h5';
            h5.FS.writeFile(p, out);
            const f = new h5.File(p, 'r');
            try {
                const meta = f.get('metadata');
                let fmt = meta.get_attribute ? meta.get_attribute('format_id') : (meta.attrs && meta.attrs.format_id && meta.attrs.format_id.value);
                if (fmt && fmt.length !== undefined) fmt = fmt[0];
                assert(Math.abs(Number(fmt) - 1.4) < 1e-4, 'format_id not pinned to 1.4 (got ' + fmt + ')');

                let json = meta.get_attribute ? meta.get_attribute('json') : (meta.attrs && meta.attrs.json && meta.attrs.json.value);
                if (json && json.length !== undefined && typeof json !== 'string') json = json[0];
                const metaObj = JSON.parse(json);
                const nodeNames = (metaObj.nodes || []).map(function (n) { return n.name; });
                assertTrue(nodeNames.indexOf('a') >= 0 && nodeNames.indexOf('b') >= 0,
                    'skeleton node names not preserved: ' + JSON.stringify(nodeNames));
            } finally {
                try { f.close(); } catch (e) {}
                try { h5.FS.unlink(p); } catch (e) {}
            }
        });
    });
})();
