/**
 * test-viewport3d-autofit.js — Viewport3D re-fits once when a skeleton first
 * appears after a fit that framed none.
 *
 * `fitToScene` frames the camera rig, the origin and the CURRENT frame's
 * skeleton markers. When it ran on a frame with no 3D (a lazy project whose
 * current frame isn't triangulated, a session opened before triangulation),
 * it framed the rig alone and skeletons standing off it were out of view
 * until View ▸ Fit 3D to Scene. These assert:
 *
 *   - after an empty-scene fit, the first frame with node markers re-fits so
 *     they are in view — and only that first one;
 *   - anything that moved the view (user orbit/pan/zoom, a camera view, Reset
 *     Camera) cancels the re-fit;
 *   - a fit that already included a skeleton never re-fits.
 *
 * Browser-only: needs real Three.js + WebGL.
 */
(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertTrue = TF.assertTrue;
    var assertEqual = TF.assertEqual;

    var NODES = ['nose', 'head', 'neck', 'tail'];
    var EDGES = [[0, 1], [1, 2], [2, 3]];

    function makeViewer() {
        var container = document.createElement('div');
        container.style.width = '320px';
        container.style.height = '240px';
        container.style.position = 'fixed';
        container.style.left = '-9999px';
        document.body.appendChild(container);
        var vp = new Viewport3D(container, {
            cameras: [],
            skeleton: new Skeleton('t', NODES, EDGES),
            getTrackColor: function () { return '#ff0000'; },
        });
        return { vp: vp, container: container };
    }

    function destroy(o) {
        try { o.vp.dispose(); } catch (e) { /* ignore */ }
        if (o.container.parentNode) o.container.remove();
    }

    // One instance group whose keypoints sit around (cx, cy, cz).
    function frameAt(cx, cy, cz) {
        var g = new InstanceGroup(0, 0);
        g.identityId = 0;
        g.points3d = fromBoxedPoints3d(NODES.map(function (_, n) {
            return [cx + n * 10, cy - n * 5, cz + n * 7];
        }));
        return [g];
    }

    // An instance group with no 3D — `updateSkeleton` adds no markers for it.
    function emptyFrame() {
        var g = new InstanceGroup(0, 0);
        g.points3d = null;
        return [g];
    }

    function target(vp) {
        var t = vp.controls.target;
        return [t.x, t.y, t.z];
    }

    function same(a, b) {
        return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9;
    }

    // Every skeleton marker lies inside the camera's view frustum.
    function skeletonInView(vp) {
        var cam = vp.threeCamera;
        cam.updateMatrixWorld(true);
        cam.updateProjectionMatrix();
        var frustum = new THREE.Frustum();
        frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(
            cam.projectionMatrix, cam.matrixWorldInverse));
        var n = 0, inside = 0;
        vp._skeletonGroup.updateMatrixWorld(true);
        vp._skeletonGroup.traverse(function (o) {
            if (o.name && o.name.indexOf('node_') === 0) {
                n++;
                var p = new THREE.Vector3();
                o.getWorldPosition(p);
                if (frustum.containsPoint(p)) inside++;
            }
        });
        return n > 0 && inside === n;
    }

    var FAR = [3000, -2500, 1800];

    describe('Viewport3D: re-fit when a skeleton first appears', function () {
        it('an empty-scene fit re-fits on the first frame with a skeleton', function () {
            if (typeof Viewport3D === 'undefined' || typeof THREE === 'undefined') return;
            var o = makeViewer();
            try {
                var vp = o.vp;
                vp.updateSkeleton(emptyFrame());
                vp.fitToScene();
                assertTrue(vp._refitWhenSkeletonAppears, 'empty fit is provisional');
                var before = target(vp);
                vp.updateSkeleton(frameAt(FAR[0], FAR[1], FAR[2]));
                assertTrue(!same(before, target(vp)), 'target moved');
                assertTrue(skeletonInView(vp), 'skeleton in view after re-fit');
                assertEqual(vp._refitWhenSkeletonAppears, false, 'flag cleared');
            } finally { destroy(o); }
        });

        it('re-fits only once — later frames leave the view alone', function () {
            if (typeof Viewport3D === 'undefined' || typeof THREE === 'undefined') return;
            var o = makeViewer();
            try {
                var vp = o.vp;
                vp.fitToScene();
                vp.updateSkeleton(frameAt(FAR[0], FAR[1], FAR[2]));
                var fitted = target(vp);
                vp.updateSkeleton(emptyFrame());
                vp.updateSkeleton(frameAt(FAR[0] + 400, FAR[1], FAR[2]));
                assertTrue(same(fitted, target(vp)), 'no second re-fit');
            } finally { destroy(o); }
        });

        it('empty frames do not trigger a re-fit', function () {
            if (typeof Viewport3D === 'undefined' || typeof THREE === 'undefined') return;
            var o = makeViewer();
            try {
                var vp = o.vp;
                vp.fitToScene();
                var before = target(vp);
                vp.updateSkeleton(emptyFrame());
                vp.updateSkeleton([]);
                assertTrue(same(before, target(vp)), 'unchanged');
                assertTrue(vp._refitWhenSkeletonAppears, 'still waiting for a skeleton');
            } finally { destroy(o); }
        });

        it('a user orbit / pan / zoom cancels the re-fit', function () {
            if (typeof Viewport3D === 'undefined' || typeof THREE === 'undefined') return;
            var o = makeViewer();
            try {
                var vp = o.vp;
                vp.fitToScene();
                vp.controls.dispatchEvent({ type: 'start' });
                var before = target(vp);
                vp.updateSkeleton(frameAt(FAR[0], FAR[1], FAR[2]));
                assertTrue(same(before, target(vp)), 'view kept');
            } finally { destroy(o); }
        });

        it('the cancel survives a controls rebuild (origin re-base)', function () {
            if (typeof Viewport3D === 'undefined' || typeof THREE === 'undefined') return;
            var o = makeViewer();
            try {
                var vp = o.vp;
                if (typeof vp._rebaseControls !== 'function') return;
                vp.fitToScene();
                vp.threeCamera.up.set(0, 1, 0);   // force a rebuild
                vp._rebaseControls();
                vp.controls.dispatchEvent({ type: 'start' });
                assertEqual(vp._refitWhenSkeletonAppears, false, 'rebuilt controls still cancel');
            } finally { destroy(o); }
        });

        it('Reset Camera cancels the re-fit', function () {
            if (typeof Viewport3D === 'undefined' || typeof THREE === 'undefined') return;
            var o = makeViewer();
            try {
                var vp = o.vp;
                vp.fitToScene();
                vp.resetCamera();
                var before = target(vp);
                vp.updateSkeleton(frameAt(FAR[0], FAR[1], FAR[2]));
                assertTrue(same(before, target(vp)), 'view kept');
            } finally { destroy(o); }
        });

        it('a fit that already framed a skeleton never re-fits', function () {
            if (typeof Viewport3D === 'undefined' || typeof THREE === 'undefined') return;
            var o = makeViewer();
            try {
                var vp = o.vp;
                vp.updateSkeleton(frameAt(0, 0, 100));
                vp.fitToScene();
                assertEqual(vp._refitWhenSkeletonAppears, false, 'not provisional');
                var before = target(vp);
                vp.updateSkeleton(emptyFrame());
                vp.updateSkeleton(frameAt(FAR[0], FAR[1], FAR[2]));
                assertTrue(same(before, target(vp)), 'view kept');
            } finally { destroy(o); }
        });

        it('no re-fit while looking through a calibrated camera', function () {
            if (typeof Viewport3D === 'undefined' || typeof THREE === 'undefined') return;
            var o = makeViewer();
            try {
                var vp = o.vp;
                vp.fitToScene();
                vp._viewingCamera = 'cam1';
                var before = target(vp);
                vp.updateSkeleton(frameAt(FAR[0], FAR[1], FAR[2]));
                assertTrue(same(before, target(vp)), 'view kept');
            } finally { destroy(o); }
        });
    });
})();
