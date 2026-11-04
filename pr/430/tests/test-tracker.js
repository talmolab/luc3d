/**
 * test-tracker.js - Tests for cross-view tracker geometry and algorithm
 */
(function () {
    const { describe, it, assertApprox, assertNotNull, assertTrue,
        assertLessThan, assertGreaterThan } = TestFramework;

    function makeTestCamera(name, rvec, tvec) {
        return new Camera(
            name,
            [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            rvec, tvec, [640, 480]
        );
    }

    describe('Tracker Geometry - backProjectToRay', function () {
        it('ray origin is camera center', function () {
            if (typeof backProjectToRay !== 'function') return;
            var cam = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var result = backProjectToRay([320, 240], cam.projectionMatrix);
            assertApprox(result.origin[0], 0, 1.0, 'cx');
            assertApprox(result.origin[1], 0, 1.0, 'cy');
            assertApprox(result.origin[2], 0, 1.0, 'cz');
        });

        it('ray direction points toward 3D point', function () {
            if (typeof backProjectToRay !== 'function') return;
            var cam = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var point3d = [10, 5, 50];
            var proj = cam.project(point3d);
            var result = backProjectToRay(proj, cam.projectionMatrix);
            var len = Math.sqrt(10*10 + 5*5 + 50*50);
            assertApprox(result.direction[0], 10/len, 0.1, 'dx');
            assertApprox(result.direction[1], 5/len, 0.1, 'dy');
            assertApprox(result.direction[2], 50/len, 0.1, 'dz');
        });

        it('ray from translated camera has correct origin', function () {
            if (typeof backProjectToRay !== 'function') return;
            var cam = makeTestCamera('c2', [0, 0, 0], [20, 0, 0]);
            var result = backProjectToRay([320, 240], cam.projectionMatrix);
            assertApprox(result.origin[0], -20, 1.0, 'cx');
            assertApprox(result.origin[1], 0, 1.0, 'cy');
            assertApprox(result.origin[2], 0, 1.0, 'cz');
        });
    });

    describe('Tracker Geometry - pointToRayDistance', function () {
        it('point on ray has zero distance', function () {
            if (typeof pointToRayDistance !== 'function') return;
            assertApprox(pointToRayDistance([0, 0, 10], [0, 0, 0], [0, 0, 1]), 0, 1e-6);
        });

        it('point off ray has correct perpendicular distance', function () {
            if (typeof pointToRayDistance !== 'function') return;
            assertApprox(pointToRayDistance([3, 4, 10], [0, 0, 0], [0, 0, 1]), 5.0, 1e-6);
        });
    });

    describe('Tracker Geometry - epipolar', function () {
        it('epipolar error is low for correct correspondences', function () {
            if (typeof computeFundamentalMatrix !== 'function') return;
            if (typeof epipolarErrorMatrix !== 'function') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var p1 = [10, 5, 50];
            var p2 = [-5, 8, 40];
            // Each detection is an array of keypoints (1 keypoint each here)
            var det1 = [[cam1.project(p1)], [cam1.project(p2)]];
            var det2 = [[cam2.project(p1)], [cam2.project(p2)]];
            var F = computeFundamentalMatrix(cam1, cam2);
            var costMatrix = epipolarErrorMatrix(det1, det2, F);
            assertLessThan(costMatrix[0][0], costMatrix[0][1], 'correct < wrong for det1[0]');
            assertLessThan(costMatrix[1][1], costMatrix[1][0], 'correct < wrong for det1[1]');
        });
    });
})();

(function () {
    const { describe, it, assertEqual, assertApprox, assertNotNull, assertTrue } = TestFramework;

    function makeTestCamera(name, rvec, tvec) {
        return new Camera(
            name,
            [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            rvec, tvec, [640, 480]
        );
    }

    describe('Detection2D', function () {
        it('fromInstance undistorts points and stores camera info', function () {
            if (typeof Detection2D === 'undefined') return;
            var cam = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var inst = new Instance([[100, 200], [300, 400]], 0, 'predicted', 0.9);
            var det = Detection2D.fromInstance(inst, cam, 5);
            assertEqual(det.cameraName, 'c1');
            assertEqual(det.frameIdx, 5);
            assertEqual(det.trackIdx, 0);
            assertEqual(det.points.length, 2);
            assertNotNull(det.points[0]);
            assertNotNull(det.points[1]);
        });

        it('handles null points', function () {
            if (typeof Detection2D === 'undefined') return;
            var cam = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var inst = new Instance([[100, 200], null], 0, 'predicted', 0.9);
            var det = Detection2D.fromInstance(inst, cam, 0);
            assertNotNull(det.points[0]);
            assertEqual(det.points[1], null);
        });
    });

    describe('Target3D', function () {
        it('can be created from 2 detections and triangulated', function () {
            if (typeof Target3D === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var point3d = [10, 5, 50];
            var inst1 = new Instance([cam1.project(point3d)], 0, 'predicted', 1);
            var inst2 = new Instance([cam2.project(point3d)], 0, 'predicted', 1);
            var det1 = Detection2D.fromInstance(inst1, cam1, 0);
            var det2 = Detection2D.fromInstance(inst2, cam2, 0);
            var target = Target3D.fromDetections([det1, det2], 0);
            assertNotNull(target.points);
            assertApprox(target.points[0][0], 10, 2.0, 'X');
            assertApprox(target.points[0][1], 5, 2.0, 'Y');
            assertApprox(target.points[0][2], 50, 2.0, 'Z');
            assertEqual(target.detectionsByCamera.size, 2);
        });

        it('addDetection replaces existing camera and updates frameIdx', function () {
            if (typeof Target3D === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var p3d = [10, 5, 50];
            var det1 = Detection2D.fromInstance(new Instance([cam1.project(p3d)], 0, 'predicted', 1), cam1, 0);
            var det2 = Detection2D.fromInstance(new Instance([cam2.project(p3d)], 0, 'predicted', 1), cam2, 0);
            var target = Target3D.fromDetections([det1, det2], 0);
            // Add new detection from cam1 at frame 1
            var det1b = Detection2D.fromInstance(new Instance([cam1.project(p3d)], 0, 'predicted', 1), cam1, 1);
            target.addDetection(det1b);
            assertEqual(target.detectionsByCamera.size, 2, 'still 2 cameras');
            assertApprox(target.frameIdx, 0.5, 0.01, 'mean frame idx');
        });

        it('stores trackIdx in detectionsByCamera', function () {
            if (typeof Target3D === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var p3d = [10, 5, 50];
            var inst1 = new Instance([cam1.project(p3d)], 5, 'predicted', 1);
            var inst2 = new Instance([cam2.project(p3d)], 3, 'predicted', 1);
            var det1 = Detection2D.fromInstance(inst1, cam1, 0);
            var det2 = Detection2D.fromInstance(inst2, cam2, 0);
            var target = Target3D.fromDetections([det1, det2], 0);
            assertEqual(target.detectionsByCamera.get('c1').trackIdx, 5);
            assertEqual(target.detectionsByCamera.get('c2').trackIdx, 3);
        });
    });
})();

(function () {
    const { describe, it, assertEqual, assertApprox, assertNotNull, assertTrue,
        assertGreaterThan } = TestFramework;

    function makeTestCamera(name, rvec, tvec) {
        return new Camera(
            name,
            [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            rvec, tvec, [640, 480]
        );
    }

    describe('CrossViewTracker - adjacency scoring', function () {
        it('2D score is higher for closer projected match', function () {
            if (typeof CrossViewTracker === 'undefined') return;
            var tracker = new CrossViewTracker();
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var p3d = [10, 5, 50];
            var det1 = Detection2D.fromInstance(new Instance([cam1.project(p3d)], 0, 'predicted', 1), cam1, 0);
            var det2 = Detection2D.fromInstance(new Instance([cam2.project(p3d)], 0, 'predicted', 1), cam2, 0);
            var target = Target3D.fromDetections([det1, det2], 0);
            var goodDet = Detection2D.fromInstance(new Instance([cam1.project(p3d)], 1, 'predicted', 1), cam1, 1);
            var badDet = Detection2D.fromInstance(new Instance([[0, 0]], 1, 'predicted', 1), cam1, 1);
            var projected = reprojectPoints(target.points, cam1.projectionMatrix);
            var goodScore = tracker.calculateAdjacencyValue2d(projected, goodDet, 1);
            var badScore = tracker.calculateAdjacencyValue2d(projected, badDet, 1);
            assertGreaterThan(goodScore, badScore, 'good match > bad match');
        });
    });

    describe('CrossViewTracker - trackFrame', function () {
        it('creates targets from first frame detections', function () {
            if (typeof CrossViewTracker === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var animal1 = [10, 5, 50];
            var session = new Session([cam1, cam2], Skeleton.defaultMouse(), ['t0']);
            var fg = new FrameGroup(0);
            fg.addInstance('c1', new Instance([cam1.project(animal1)], 0, 'predicted', 1));
            fg.addInstance('c2', new Instance([cam2.project(animal1)], 0, 'predicted', 1));
            session.addFrameGroup(fg);
            var tracker = new CrossViewTracker();
            var result = tracker.trackFrame(fg, [cam1, cam2], session);
            assertTrue(result.targets.length >= 1, 'at least 1 target created');
        });

        it('maintains targets across 2 frames', function () {
            if (typeof CrossViewTracker === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var animal = [[10, 5, 50], [11, 5, 50]];
            var session = new Session([cam1, cam2], Skeleton.defaultMouse(), ['t0']);
            var tracker = new CrossViewTracker();
            for (var f = 0; f < 2; f++) {
                var fg = new FrameGroup(f);
                fg.addInstance('c1', new Instance([cam1.project(animal[f])], 0, 'predicted', 1));
                fg.addInstance('c2', new Instance([cam2.project(animal[f])], 0, 'predicted', 1));
                session.addFrameGroup(fg);
                tracker.trackFrame(fg, [cam1, cam2], session);
            }
            assertEqual(tracker.prevTargets.length, 1, 'still 1 target after 2 frames');
        });
    });

    describe('CrossViewTracker - applyResults', function () {
        it('creates identities and maps track indices', function () {
            if (typeof CrossViewTracker === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var session = new Session([cam1, cam2], Skeleton.defaultMouse(), ['t0']);
            var fg = new FrameGroup(0);
            fg.addInstance('c1', new Instance([cam1.project([10, 5, 50])], 0, 'predicted', 1));
            fg.addInstance('c2', new Instance([cam2.project([10, 5, 50])], 0, 'predicted', 1));
            session.addFrameGroup(fg);
            var tracker = new CrossViewTracker();
            tracker.trackFrame(fg, [cam1, cam2], session);
            tracker.applyResults(session);
            assertTrue(session.identities.length >= 1, 'identity created');
            assertTrue(session.frameIdentityMap.size >= 1, 'track mapped per-frame');
        });
    });
})();

(function () {
    const { describe, it, assertEqual, assertApprox, assertNotNull, assertTrue,
        assertGreaterThan, assertLessThan } = TestFramework;

    function makeTestCamera(name, rvec, tvec) {
        return new Camera(
            name,
            [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            rvec, tvec, [640, 480]
        );
    }

    describe('CrossViewTracker - multi-frame integration', function () {
        it('maintains 2 identities across 3 frames with 2 animals', function () {
            if (typeof CrossViewTracker === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var session = new Session([cam1, cam2], Skeleton.defaultMouse(), ['t0', 't1']);

            // Two animals with slight movement over 3 frames
            var animals = [
                [[10, 5, 50], [11, 5, 50], [12, 5, 50]],
                [[-10, -5, 60], [-9, -5, 60], [-8, -5, 60]]
            ];

            var tracker = new CrossViewTracker();

            for (var f = 0; f < 3; f++) {
                var fg = new FrameGroup(f);
                for (var a = 0; a < 2; a++) {
                    fg.addInstance('c1', new Instance([cam1.project(animals[a][f])], a, 'predicted', 1));
                    fg.addInstance('c2', new Instance([cam2.project(animals[a][f])], a, 'predicted', 1));
                }
                session.addFrameGroup(fg);
                tracker.trackFrame(fg, [cam1, cam2], session);
            }

            assertEqual(tracker.prevTargets.length, 2, '2 targets maintained');
            // Each target should have unique trackId
            var ids = tracker.prevTargets.map(function (t) { return t.trackId; });
            assertTrue(ids[0] !== ids[1], 'unique track IDs');
        });

        it('handles track ID swaps across views correctly', function () {
            if (typeof CrossViewTracker === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var session = new Session([cam1, cam2], Skeleton.defaultMouse(), ['t0', 't1']);

            var animal1 = [10, 5, 50];
            var animal2 = [-10, -5, 60];

            // Frame 0: cam1 has track 0,1 and cam2 has track 0,1
            var fg0 = new FrameGroup(0);
            fg0.addInstance('c1', new Instance([cam1.project(animal1)], 0, 'predicted', 1));
            fg0.addInstance('c1', new Instance([cam1.project(animal2)], 1, 'predicted', 1));
            fg0.addInstance('c2', new Instance([cam2.project(animal1)], 0, 'predicted', 1));
            fg0.addInstance('c2', new Instance([cam2.project(animal2)], 1, 'predicted', 1));
            session.addFrameGroup(fg0);

            var tracker = new CrossViewTracker();
            tracker.trackFrame(fg0, [cam1, cam2], session);

            // Frame 1: cam2 has SWAPPED track IDs (track 1 is animal1, track 0 is animal2)
            var fg1 = new FrameGroup(1);
            fg1.addInstance('c1', new Instance([cam1.project(animal1)], 0, 'predicted', 1));
            fg1.addInstance('c1', new Instance([cam1.project(animal2)], 1, 'predicted', 1));
            fg1.addInstance('c2', new Instance([cam2.project(animal1)], 1, 'predicted', 1)); // swapped!
            fg1.addInstance('c2', new Instance([cam2.project(animal2)], 0, 'predicted', 1)); // swapped!
            session.addFrameGroup(fg1);

            tracker.trackFrame(fg1, [cam1, cam2], session);

            // Should still have 2 targets (not 4)
            assertEqual(tracker.prevTargets.length, 2, '2 targets despite track swap');
        });

        it('applyResults creates correct identity mappings', function () {
            if (typeof CrossViewTracker === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var session = new Session([cam1, cam2], Skeleton.defaultMouse(), ['t0']);

            var fg = new FrameGroup(0);
            fg.addInstance('c1', new Instance([cam1.project([10, 5, 50])], 0, 'predicted', 1));
            fg.addInstance('c2', new Instance([cam2.project([10, 5, 50])], 3, 'predicted', 1));
            session.addFrameGroup(fg);

            var tracker = new CrossViewTracker();
            tracker.trackFrame(fg, [cam1, cam2], session);
            tracker.applyResults(session);

            // Both track indices should map to the same identity (per-frame)
            var id1 = session.getIdentityIdForTrack('c1', 0, 0);
            var id2 = session.getIdentityIdForTrack('c2', 3, 0);
            assertNotNull(id1, 'c1:0 mapped');
            assertNotNull(id2, 'c2:3 mapped');
            assertEqual(id1, id2, 'same identity for both views');
        });

        it('findMatchesForInstance finds correct match', function () {
            if (typeof CrossViewTracker === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);

            var animal1 = [10, 5, 50];
            var animal2 = [-10, -5, 60];

            var fg = new FrameGroup(0);
            var inst1_c1 = new Instance([cam1.project(animal1)], 0, 'predicted', 1);
            var inst2_c1 = new Instance([cam1.project(animal2)], 1, 'predicted', 1);
            var inst1_c2 = new Instance([cam2.project(animal1)], 0, 'predicted', 1);
            var inst2_c2 = new Instance([cam2.project(animal2)], 1, 'predicted', 1);
            fg.addInstance('c1', inst1_c1);
            fg.addInstance('c1', inst2_c1);
            fg.addInstance('c2', inst1_c2);
            fg.addInstance('c2', inst2_c2);

            var tracker = new CrossViewTracker();
            var matches = tracker.findMatchesForInstance(inst1_c1, 'c1', fg, [cam1, cam2]);

            assertTrue(matches.has('c2'), 'found match in c2');
            // The best match for animal1 in cam1 should be the animal1 projection in cam2
            var matchedInst = matches.get('c2').instance;
            assertEqual(matchedInst, inst1_c2, 'matched correct instance');
        });
    });

    describe('CrossViewTracker - 3 camera views', function () {
        it('tracks with 3 cameras', function () {
            if (typeof CrossViewTracker === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var cam3 = makeTestCamera('c3', [0.2, 0, 0], [0, 15, 0]);
            var session = new Session([cam1, cam2, cam3], Skeleton.defaultMouse(), ['t0']);

            var animal = [10, 5, 50];

            var fg = new FrameGroup(0);
            fg.addInstance('c1', new Instance([cam1.project(animal)], 0, 'predicted', 1));
            fg.addInstance('c2', new Instance([cam2.project(animal)], 0, 'predicted', 1));
            fg.addInstance('c3', new Instance([cam3.project(animal)], 0, 'predicted', 1));
            session.addFrameGroup(fg);

            var tracker = new CrossViewTracker();
            tracker.trackFrame(fg, [cam1, cam2, cam3], session);

            assertTrue(tracker.prevTargets.length >= 1, 'at least 1 target with 3 views');
        });
    });
})();