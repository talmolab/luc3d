/**
 * test-triangulation-robust.js — coverage for the two robustness features added to
 * triangulateAndReproject():
 *   1. Excluded views (Camera Views panel) never contribute to the 3D solve, but
 *      ARE still reprojected into.
 *   2. Reprojection-error threshold: drop a 2D node whose reprojection error in a
 *      view exceeds the threshold, then re-triangulate from the reliable views. A
 *      node left with <2 reliable views is dropped from 3D (null).
 *
 * Runs under the Node vm harness (run-node.js) where `isCameraTracked` /
 * `getTrackingThreshold` are absent — the features are driven via the explicit
 * `options.includedCameras` / `options.reprojErrorThreshold` overrides.
 */
(function () {
    const { describe, it, assertNotNull, assertNull, assertTrue, assertLessThan } = TestFramework;

    function makeCam(name, rvec, tvec) {
        return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
    }
    function dist3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

    // Three well-separated cameras + a 3-node ground-truth rig.
    const cams = [
        makeCam('c1', [0, 0, 0], [0, 0, 0]),
        makeCam('c2', [0, 0.3, 0], [20, 0, 0]),
        makeCam('c3', [0.1, 0, 0], [0, 15, 0]),
    ];
    const TRUTH = [[10, 5, 50], [0, 0, 55], [-8, 6, 48]];

    // A fake InstanceGroup: triangulateAndReproject only calls getInstance(name).
    function buildGroup() {
        const byCam = {};
        cams.forEach(function (cam) {
            byCam[cam.name] = { points: TRUTH.map(function (p) { return cam.project(p); }) };
        });
        return { _byCam: byCam, getInstance: function (n) { return byCam[n] || null; } };
    }

    describe('Robust triangulation - excluded views', function () {
        it('excludes a view from the solve but still reprojects into it', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            const g = buildGroup();
            // Corrupt node 0 badly in c3.
            const p = g._byCam['c3'].points[0];
            g._byCam['c3'].points[0] = [p[0] + 120, p[1] + 120];

            const excl = triangulateAndReproject(g, cams, { includedCameras: ['c1', 'c2'] });
            const all = triangulateAndReproject(g, cams, {});   // all views, no threshold

            // Excluding the corrupt view keeps node 0 near truth; including it drags it.
            assertLessThan(dist3(excl.points3d[0], TRUTH[0]), 2.0, 'node0 near truth when c3 excluded');
            assertTrue(dist3(all.points3d[0], TRUTH[0]) > dist3(excl.points3d[0], TRUTH[0]),
                'including corrupt c3 pulls node0 farther than excluding it');
            // Still reprojected INTO the excluded view.
            assertNotNull(excl.reprojections['c3'], 'reprojects into excluded view c3');
            assertNotNull(excl.reprojections['c3'][0], 'excluded view has a reprojected node0');
        });
    });

    describe('Robust triangulation - reprojection-error rejection', function () {
        it('excludes one over-threshold node-in-a-view, keeps the rest of the view', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            const g = buildGroup();
            // Move ONLY node 0's observation in view c3 far past the threshold.
            const p = g._byCam['c3'].points[0];
            g._byCam['c3'].points[0] = [p[0] + 120, p[1] + 120];

            const robust = triangulateAndReproject(g, cams, { reprojErrorThreshold: 5 });
            // node0's c3 observation is excluded; node0 re-triangulated from c1/c2.
            assertLessThan(dist3(robust.points3d[0], TRUTH[0]), 2.0,
                'node0 recovered after excluding its over-threshold c3 observation');
            // The rest of view c3 is untouched — its OTHER nodes still triangulate.
            assertLessThan(dist3(robust.points3d[1], TRUTH[1]), 2.0, 'node1 (present in c3) unaffected');
            assertLessThan(dist3(robust.points3d[2], TRUTH[2]), 2.0, 'node2 (present in c3) unaffected');
        });

        it('nulls a node only when it is left with fewer than 2 reliable views', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            const g = buildGroup();
            const one = triangulateAndReproject(g, cams, { includedCameras: ['c1'] });
            for (let k = 0; k < TRUTH.length; k++) {
                assertNull(one.points3d[k], 'node ' + k + ' null with a single included view');
            }
        });
    });
})();
