/**
 * test-triangulation-robust.js — coverage for the two robustness features added to
 * triangulateAndReproject():
 *   1. Excluded views (Camera Views panel) never contribute to the 3D solve, but
 *      ARE still reprojected into.
 *   2. Reprojection-error threshold: drop a 2D node whose reprojection error in a
 *      view exceeds the threshold, then re-triangulate from the reliable views. A
 *      node left with <2 reliable views is dropped from 3D (null).
 *
 * Every call passes BOTH `options.includedCameras` and
 * `options.reprojErrorThreshold`, so the live Camera Views / Tracking Wizard
 * settings (read from localStorage through ui/settings.js) cannot change what
 * is being tested.
 *
 * The fixtures are built inside each `it`, not at load time: this file is a
 * classic script, and `Camera` / `InstanceGroup` only reach `window` when the
 * runner's module bridge runs, after every test file has loaded.
 */
(function () {
    const { describe, it, assertEqual, assertTrue, assertFalse, assertLessThan } = TestFramework;

    const ALL = ['c1', 'c2', 'c3'];
    const TRUTH = [[10, 5, 50], [0, 0, 55], [-8, 6, 48]];

    function makeCam(name, rvec, tvec) {
        return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
    }
    // Three well-separated cameras.
    function makeCams() {
        return [
            makeCam('c1', [0, 0, 0], [0, 0, 0]),
            makeCam('c2', [0, 0.3, 0], [20, 0, 0]),
            makeCam('c3', [0.1, 0, 0], [0, 15, 0]),
        ];
    }
    // A real InstanceGroup holding the noiseless projection of TRUTH in every view.
    function buildGroup(cams) {
        const g = new InstanceGroup(1, 0);
        cams.forEach(function (cam) {
            g.addInstance(cam.name, new Instance(TRUTH.map(function (p) { return cam.project(p); }), 0, 'user', 1));
        });
        return g;
    }
    // Move node 0's observation in view c3 120 px off in x and y.
    function corruptNode0InC3(g) {
        const inst = g.getInstance('c3');
        const p = inst.getPoint(0);
        inst.setPoint(0, p[0] + 120, p[1] + 120);
    }
    // Distance of solved node k from its truth; Infinity when the node is missing.
    function err3(points3d, k) {
        const p = getPoint3d(points3d, k);
        if (!p) return Infinity;
        return Math.hypot(p[0] - TRUTH[k][0], p[1] - TRUTH[k][1], p[2] - TRUTH[k][2]);
    }

    describe('Robust triangulation - excluded views', function () {
        it('excludes a view from the solve but still reprojects into it', function () {
            const cams = makeCams();
            const g = buildGroup(cams);
            corruptNode0InC3(g);

            const excl = triangulateAndReproject(g, cams, { includedCameras: ['c1', 'c2'], reprojErrorThreshold: 0 });
            const all = triangulateAndReproject(g, cams, { includedCameras: ALL, reprojErrorThreshold: 0 });

            // Excluding the corrupt view keeps node 0 near truth; including it drags it.
            assertLessThan(err3(excl.points3d, 0), 2.0, 'node0 near truth when c3 excluded');
            assertTrue(err3(all.points3d, 0) > 2.0, 'including corrupt c3 pulls node0 off truth');
            // Still reprojected INTO the excluded view.
            assertTrue(Array.isArray(excl.reprojections['c3']), 'reprojects into excluded view c3');
            assertTrue(Array.isArray(excl.reprojections['c3'][0]), 'excluded view has a reprojected node0');
        });
    });

    describe('Robust triangulation - reprojection-error rejection', function () {
        it('excludes one over-threshold node-in-a-view, keeps the rest of the view', function () {
            const cams = makeCams();
            const g = buildGroup(cams);
            corruptNode0InC3(g);

            // Control: with no threshold the corrupt observation drags node 0.
            const plain = triangulateAndReproject(g, cams, { includedCameras: ALL, reprojErrorThreshold: 0 });
            assertTrue(err3(plain.points3d, 0) > 2.0, 'without a threshold node0 is dragged off truth');

            const robust = triangulateAndReproject(g, cams, { includedCameras: ALL, reprojErrorThreshold: 5 });
            // node0's c3 observation is excluded; node0 re-triangulated from c1/c2.
            assertLessThan(err3(robust.points3d, 0), 2.0,
                'node0 recovered after excluding its over-threshold c3 observation');
            // The rest of view c3 is untouched — its OTHER nodes still triangulate.
            assertLessThan(err3(robust.points3d, 1), 2.0, 'node1 (present in c3) unaffected');
            assertLessThan(err3(robust.points3d, 2), 2.0, 'node2 (present in c3) unaffected');
        });

        it('nulls a node only when it is left with fewer than 2 reliable views', function () {
            const cams = makeCams();
            const g = buildGroup(cams);
            const two = triangulateAndReproject(g, cams, { includedCameras: ['c1', 'c2'], reprojErrorThreshold: 0 });
            const one = triangulateAndReproject(g, cams, { includedCameras: ['c1'], reprojErrorThreshold: 0 });
            assertEqual(points3dNodeCount(one.points3d), TRUTH.length, 'one result slot per node');
            for (let k = 0; k < TRUTH.length; k++) {
                assertTrue(hasPoint3d(two.points3d, k), 'node ' + k + ' solved from two included views');
                assertFalse(hasPoint3d(one.points3d, k), 'node ' + k + ' null with a single included view');
            }
        });
    });
})();
