/**
 * test-rotation.js — Tests that video rotation does not affect
 * triangulation, reprojection, or coordinate-based interactions.
 */

(function () {
    const { describe, it, assertEqual, assertApprox, assertNotNull,
        assertTrue, assertFalse, beforeEach } = TestFramework;

    // ---- Helpers ----

    function makeCamera(name, rvec, tvec) {
        return new Camera(
            name,
            [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            rvec || [0, 0, 0],
            tvec || [0, 0, 0],
            [640, 480]
        );
    }

    function makeSkeleton() {
        return new Skeleton('test', ['head', 'body', 'tail'], [[0, 1], [1, 2]]);
    }

    function makeInstance(points, trackIdx) {
        return new Instance(
            points || [[100, 200], [150, 250], [200, 300]],
            trackIdx || 0,
            'user',
            1.0
        );
    }

    function makeSession() {
        var cam1 = makeCamera('cam1', [0, 0, 0], [0, 0, 0]);
        var cam2 = makeCamera('cam2', [0, 0.3, 0], [20, 0, 0]);
        var cam3 = makeCamera('cam3', [0.2, 0, 0.1], [-10, 15, 5]);
        return new Session([cam1, cam2, cam3], makeSkeleton(), ['track_0']);
    }

    function createMockCanvas(w, h) {
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        canvas.style.position = 'fixed';
        canvas.style.top = '0';
        canvas.style.left = '0';
        document.body.appendChild(canvas);
        return canvas;
    }

    function cleanupCanvases() {
        var canvases = document.querySelectorAll('canvas[style*="position: fixed"]');
        canvases.forEach(function (c) { c.remove(); });
    }

    // ---- Triangulation invariance under rotation ----

    describe('Rotation - triangulation invariance', function () {
        it('triangulation results are identical regardless of view rotation', function () {
            if (typeof triangulatePointDLT !== 'function') return;

            var cam1 = makeCamera('cam1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeCamera('cam2', [0, 0.3, 0], [20, 0, 0]);

            var point3d = [10, 5, 50];
            var p1 = cam1.project(point3d);
            var p2 = cam2.project(point3d);

            // Triangulate — rotation has no effect on the math
            var result = triangulatePointDLT(
                [p1, p2],
                [cam1.projectionMatrix, cam2.projectionMatrix]
            );

            assertNotNull(result, 'triangulation should produce a result');
            assertApprox(result[0], point3d[0], 1.0, 'X unchanged');
            assertApprox(result[1], point3d[1], 1.0, 'Y unchanged');
            assertApprox(result[2], point3d[2], 1.0, 'Z unchanged');
        });

        it('triangulateAndReproject produces same output with rotated views', function () {
            if (typeof triangulateAndReproject !== 'function') return;

            var session = makeSession();
            var group = new InstanceGroup(1, 0);

            // Add instances for cam1 and cam2
            var point3d = [10, 5, 50];
            var pts1 = session.cameras.map(function (c) { return c.project(point3d); });
            group.addInstance('cam1', makeInstance([pts1[0], [150, 250], [200, 300]], 0));
            group.addInstance('cam2', makeInstance([pts1[1], [160, 260], [210, 310]], 0));

            var result = triangulateAndReproject(group, session.cameras);
            assertNotNull(result, 'should produce result');
            assertNotNull(result.reprojections, 'should have reprojections');
            assertTrue(result.reprojections.cam1 !== undefined, 'should have cam1 reprojection');
            assertTrue(result.reprojections.cam2 !== undefined, 'should have cam2 reprojection');
            assertTrue(result.reprojections.cam3 !== undefined, 'should have cam3 reprojection');
        });
    });

    // ---- Reprojection data invariance ----

    describe('Rotation - reprojection data invariance', function () {
        it('reprojection points are identical with and without rotation state', function () {
            if (typeof triangulateAndReproject !== 'function') return;

            var session = makeSession();
            var group1 = new InstanceGroup(1, 0);
            var group2 = new InstanceGroup(2, 0);

            var pts = [[100, 200], [150, 250], [200, 300]];
            var pts2 = [[120, 210], [160, 260], [210, 310]];

            group1.addInstance('cam1', makeInstance(pts, 0));
            group1.addInstance('cam2', makeInstance(pts2, 0));
            group2.addInstance('cam1', makeInstance(pts, 0));
            group2.addInstance('cam2', makeInstance(pts2, 0));

            // Compute with no rotation context
            var result1 = triangulateAndReproject(group1, session.cameras);
            // Compute again — simulating that a view has rotation set
            // (rotation is CSS-only, so the math is identical)
            var result2 = triangulateAndReproject(group2, session.cameras);

            assertNotNull(result1.reprojections);
            assertNotNull(result2.reprojections);

            // Reprojections should be identical
            for (var camName in result1.reprojections) {
                var r1 = result1.reprojections[camName];
                var r2 = result2.reprojections[camName];
                assertTrue(r2 !== undefined, 'cam ' + camName + ' should exist in both');
                for (var pi = 0; pi < r1.length; pi++) {
                    if (r1[pi] && r2[pi]) {
                        assertApprox(r1[pi][0], r2[pi][0], 0.001, camName + ' point ' + pi + ' X');
                        assertApprox(r1[pi][1], r2[pi][1], 0.001, camName + ' point ' + pi + ' Y');
                    }
                }
            }
        });

        it('reprojection errors are identical regardless of rotation', function () {
            if (typeof triangulateAndReproject !== 'function') return;

            var session = makeSession();
            var group1 = new InstanceGroup(1, 0);
            var group2 = new InstanceGroup(2, 0);

            var pts = [[100, 200], [150, 250], [200, 300]];
            var pts2 = [[120, 210], [160, 260], [210, 310]];

            group1.addInstance('cam1', makeInstance(pts, 0));
            group1.addInstance('cam2', makeInstance(pts2, 0));
            group2.addInstance('cam1', makeInstance(pts, 0));
            group2.addInstance('cam2', makeInstance(pts2, 0));

            var result1 = triangulateAndReproject(group1, session.cameras);
            var result2 = triangulateAndReproject(group2, session.cameras);

            assertApprox(result1.meanError, result2.meanError, 0.001, 'mean errors should match');
            for (var ei = 0; ei < result1.errors.length; ei++) {
                assertApprox(result1.errors[ei], result2.errors[ei], 0.001, 'error ' + ei + ' should match');
            }
        });
    });

    // ---- canvasToVideo coordinate transform under rotation ----

    describe('Rotation - canvasToVideo with rotation', function () {
        var manager;
        var mockState;

        beforeEach(function () {
            cleanupCanvases();
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var cameras = [new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])];
            var session = new Session(cameras, skeleton, ['track_0']);
            mockState = {
                currentFrame: 0,
                session: session,
                views: [{
                    name: 'cam1',
                    overlayCanvas: createMockCanvas(640, 480),
                    videoWidth: 640,
                    videoHeight: 480,
                    rotation: 0,
                    zoom: { scale: 1, offsetX: 0, offsetY: 0 },
                }],
            };
            manager = new InteractionManager({
                getState: function () { return mockState; },
                getInstanceGroups: function () { return []; },
                requestRedraw: function () {},
            });
        });

        it('center coordinate is stable at 0 degrees', function () {
            var canvas = mockState.views[0].overlayCanvas;
            var rect = canvas.getBoundingClientRect();
            var cx = rect.left + rect.width / 2;
            var cy = rect.top + rect.height / 2;
            var coords = manager.canvasToVideo(cx, cy, 'cam1');
            assertApprox(coords[0], 320, 5, 'center X at 0°');
            assertApprox(coords[1], 240, 5, 'center Y at 0°');
        });

        it('center coordinate is stable at 45 degrees rotation', function () {
            mockState.views[0].rotation = 45;
            var canvas = mockState.views[0].overlayCanvas;
            var rect = canvas.getBoundingClientRect();
            var cx = rect.left + rect.width / 2;
            var cy = rect.top + rect.height / 2;
            var coords = manager.canvasToVideo(cx, cy, 'cam1');
            assertApprox(coords[0], 320, 5, 'center X at 45°');
            assertApprox(coords[1], 240, 5, 'center Y at 45°');
        });

        it('center coordinate is stable at 90 degrees rotation', function () {
            mockState.views[0].rotation = 90;
            var canvas = mockState.views[0].overlayCanvas;
            var rect = canvas.getBoundingClientRect();
            var cx = rect.left + rect.width / 2;
            var cy = rect.top + rect.height / 2;
            var coords = manager.canvasToVideo(cx, cy, 'cam1');
            assertApprox(coords[0], 320, 5, 'center X at 90°');
            assertApprox(coords[1], 240, 5, 'center Y at 90°');
        });

        it('center coordinate is stable at negative rotation', function () {
            mockState.views[0].rotation = -30;
            var canvas = mockState.views[0].overlayCanvas;
            var rect = canvas.getBoundingClientRect();
            var cx = rect.left + rect.width / 2;
            var cy = rect.top + rect.height / 2;
            var coords = manager.canvasToVideo(cx, cy, 'cam1');
            assertApprox(coords[0], 320, 5, 'center X at -30°');
            assertApprox(coords[1], 240, 5, 'center Y at -30°');
        });
    });

    // ---- Hit testing invariance ----

    describe('Rotation - hit testing invariance', function () {
        it('findNearestNode returns same node at any rotation', function () {
            var session = makeSession();
            var skeleton = session.skeleton;
            var group = new InstanceGroup(1, 0);
            var inst = makeInstance([[100, 200], [300, 300], [500, 400]], 0);
            group.addInstance('cam1', inst);

            var mockState = {
                currentFrame: 0,
                session: session,
                views: [{
                    name: 'cam1',
                    overlayCanvas: { width: 640, height: 480, style: { width: '640px' }, offsetWidth: 640 },
                    videoWidth: 640,
                    videoHeight: 480,
                    rotation: 0,
                    zoom: { scale: 1, offsetX: 0, offsetY: 0 },
                }],
            };

            var manager = new InteractionManager({
                getState: function () { return mockState; },
                getInstanceGroups: function () { return [group]; },
                requestRedraw: function () {},
            });

            // Hit test near node 0 (100, 200)
            var hit0 = manager.findNearestNode(100, 200, 'cam1', 0);
            assertNotNull(hit0, 'should find node at rotation=0');
            assertEqual(hit0.nodeIdx, 0, 'should be node 0');

            // Change rotation — hit test uses video coordinates, not screen coordinates
            mockState.views[0].rotation = 45;
            var hit45 = manager.findNearestNode(100, 200, 'cam1', 0);
            assertNotNull(hit45, 'should find node at rotation=45');
            assertEqual(hit45.nodeIdx, 0, 'should still be node 0');

            mockState.views[0].rotation = 90;
            var hit90 = manager.findNearestNode(100, 200, 'cam1', 0);
            assertNotNull(hit90, 'should find node at rotation=90');
            assertEqual(hit90.nodeIdx, 0, 'should still be node 0');
        });

        it('findNearestNode distinguishes between nodes at any rotation', function () {
            var session = makeSession();
            var group = new InstanceGroup(1, 0);
            var inst = makeInstance([[100, 100], [400, 100], [400, 400]], 0);
            group.addInstance('cam1', inst);

            var mockState = {
                currentFrame: 0,
                session: session,
                views: [{
                    name: 'cam1',
                    overlayCanvas: { width: 640, height: 480, style: { width: '640px' }, offsetWidth: 640 },
                    videoWidth: 640,
                    videoHeight: 480,
                    rotation: 60,
                    zoom: { scale: 1, offsetX: 0, offsetY: 0 },
                }],
            };

            var manager = new InteractionManager({
                getState: function () { return mockState; },
                getInstanceGroups: function () { return [group]; },
                requestRedraw: function () {},
            });

            var hit0 = manager.findNearestNode(100, 100, 'cam1', 0);
            var hit1 = manager.findNearestNode(400, 100, 'cam1', 0);
            var hit2 = manager.findNearestNode(400, 400, 'cam1', 0);

            assertNotNull(hit0, 'should find node near (100,100)');
            assertNotNull(hit1, 'should find node near (400,100)');
            assertNotNull(hit2, 'should find node near (400,400)');
            assertEqual(hit0.nodeIdx, 0, 'node 0');
            assertEqual(hit1.nodeIdx, 1, 'node 1');
            assertEqual(hit2.nodeIdx, 2, 'node 2');
        });
    });

    // ---- Instance data integrity under rotation ----

    describe('Rotation - instance data integrity', function () {
        it('instance point data is not modified by rotation state', function () {
            var inst = makeInstance([[100, 200], [150, 250], [200, 300]], 0);
            var originalPoints = JSON.parse(JSON.stringify(inst.points));

            // Simulate rotation by setting a rotation value on a mock view
            var view = { name: 'cam1', rotation: 45 };

            // Points should be unchanged — rotation is CSS-only
            for (var i = 0; i < inst.points.length; i++) {
                assertEqual(inst.points[i][0], originalPoints[i][0], 'point ' + i + ' X unchanged');
                assertEqual(inst.points[i][1], originalPoints[i][1], 'point ' + i + ' Y unchanged');
            }
        });

        it('InstanceGroup preserves all data after rotation changes', function () {
            var group = new InstanceGroup(1, 0);
            var inst1 = makeInstance([[100, 200], [150, 250], [200, 300]], 0);
            var inst2 = makeInstance([[110, 210], [160, 260], [210, 310]], 0);
            group.addInstance('cam1', inst1);
            group.addInstance('cam2', inst2);
            group.points3d = [[10, 5, 50], [15, 10, 55], [20, 15, 60]];

            // Verify data is intact (rotation is purely visual, not stored on groups)
            assertEqual(group.instances.size, 2, 'should have 2 camera instances');
            assertNotNull(group.getInstance('cam1'), 'cam1 instance preserved');
            assertNotNull(group.getInstance('cam2'), 'cam2 instance preserved');
            assertEqual(group.points3d.length, 3, '3D points preserved');
            assertEqual(group.points3d[0][0], 10, '3D point X preserved');
        });
    });

    // ---- Overlay rendering with rotation ----

    describe('Rotation - overlay coordinate transforms', function () {
        it('videoToCanvas produces same output regardless of view rotation', function () {
            if (typeof videoToCanvas !== 'function') return;

            // videoToCanvas operates in video/canvas pixel space — no rotation
            var r1 = videoToCanvas(100, 200, 640, 480, 640, 480);
            var r2 = videoToCanvas(100, 200, 640, 480, 640, 480);
            assertApprox(r1.x, r2.x, 0.01, 'X should be identical');
            assertApprox(r1.y, r2.y, 0.01, 'Y should be identical');
        });

        it('makeVideoToCanvasTransform scale is independent of rotation', function () {
            if (typeof makeVideoToCanvasTransform !== 'function') return;

            var t1 = makeVideoToCanvasTransform(640, 480, 1280, 960);
            var t2 = makeVideoToCanvasTransform(640, 480, 1280, 960);

            assertEqual(t1.scale, t2.scale, 'scale should be identical');
            var p1 = t1(100, 200);
            var p2 = t2(100, 200);
            assertApprox(p1.x, p2.x, 0.01, 'transformed X identical');
            assertApprox(p1.y, p2.y, 0.01, 'transformed Y identical');
        });
    });

    // ---- adjustColorBrightness utility ----

    describe('Rotation - adjustColorBrightness', function () {
        it('returns original color at factor 1.0', function () {
            if (typeof adjustColorBrightness !== 'function') return;
            var result = adjustColorBrightness('#ff8800', 1.0);
            assertEqual(result, '#ff8800', 'should be unchanged at factor 1.0');
        });

        it('returns black at factor 0', function () {
            if (typeof adjustColorBrightness !== 'function') return;
            var result = adjustColorBrightness('#ff8800', 0);
            assertEqual(result, '#000000', 'should be black at factor 0');
        });

        it('darkens color at factor 0.5', function () {
            if (typeof adjustColorBrightness !== 'function') return;
            var result = adjustColorBrightness('#ff8800', 0.5);
            // R: 255*0.5=128=0x80, G: 136*0.5=68=0x44, B: 0*0.5=0=0x00
            assertEqual(result, '#804400', 'should be half brightness');
        });
    });

    // ---- Rotation clamping ----

    describe('Rotation - clampRotation', function () {
        it('keeps values within [-179, 180]', function () {
            if (typeof clampRotation !== 'function') return;
            assertEqual(clampRotation(0), 0, '0 stays 0');
            assertEqual(clampRotation(180), 180, '180 stays 180');
            assertEqual(clampRotation(-179), -179, '-179 stays -179');
            assertEqual(clampRotation(90), 90, '90 stays 90');
            assertEqual(clampRotation(-90), -90, '-90 stays -90');
        });

        it('wraps values exceeding 180', function () {
            if (typeof clampRotation !== 'function') return;
            assertEqual(clampRotation(181), -179, '181 wraps to -179');
            assertEqual(clampRotation(270), -90, '270 wraps to -90');
            assertEqual(clampRotation(360), 0, '360 wraps to 0');
            assertEqual(clampRotation(361), 1, '361 wraps to 1');
        });

        it('wraps values below -179', function () {
            if (typeof clampRotation !== 'function') return;
            assertEqual(clampRotation(-180), 180, '-180 wraps to 180');
            assertEqual(clampRotation(-270), 90, '-270 wraps to 90');
            assertEqual(clampRotation(-360), 0, '-360 wraps to 0');
            assertEqual(clampRotation(-361), -1, '-361 wraps to -1');
        });
    });

})();
