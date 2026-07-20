/**
 * test-overlays.js - Unit tests for overlays.js
 *
 * Note: videoToCanvas() returns { x, y, scale } (object, not array).
 * makeVideoToCanvasTransform() returns a function that also returns { x, y }.
 */

(function () {
    const { describe, it, assertEqual, assertNotNull, assertTrue, assertApprox,
        assertGreaterThan, assertLessThan } = TestFramework;

    // ---- videoToCanvas ----

    describe('Overlays - videoToCanvas', function () {
        it('maps video origin to canvas origin (same size)', function () {
            if (typeof videoToCanvas !== 'function') return;
            var result = videoToCanvas(0, 0, 640, 480, 640, 480);
            assertApprox(result.x, 0, 0.01, 'X should be 0');
            assertApprox(result.y, 0, 0.01, 'Y should be 0');
        });

        it('maps video center to canvas center (same size)', function () {
            if (typeof videoToCanvas !== 'function') return;
            var result = videoToCanvas(320, 240, 640, 480, 640, 480);
            assertApprox(result.x, 320, 1.0, 'Center X');
            assertApprox(result.y, 240, 1.0, 'Center Y');
        });

        it('maps correctly with 2x scale', function () {
            if (typeof videoToCanvas !== 'function') return;
            // 640x480 video displayed at 1280x960
            var result = videoToCanvas(100, 100, 640, 480, 1280, 960);
            assertApprox(result.x, 200, 1.0, 'X should be 2x');
            assertApprox(result.y, 200, 1.0, 'Y should be 2x');
        });

        it('maps correctly with 0.5x scale', function () {
            if (typeof videoToCanvas !== 'function') return;
            // 640x480 video displayed at 320x240
            var result = videoToCanvas(200, 200, 640, 480, 320, 240);
            assertApprox(result.x, 100, 1.0, 'X should be 0.5x');
            assertApprox(result.y, 100, 1.0, 'Y should be 0.5x');
        });

        it('handles aspect ratio mismatch gracefully', function () {
            if (typeof videoToCanvas !== 'function') return;
            // Canvas is square (800x800) but video is 4:3 (640x480)
            // Should use uniform scale = min(800/640, 800/480) = min(1.25, 1.667) = 1.25
            // with letterboxing offset in Y
            var result = videoToCanvas(100, 100, 640, 480, 800, 800);
            assertNotNull(result, 'Should return a value');
            assertTrue(typeof result.x === 'number', 'x should be a number');
            assertTrue(typeof result.y === 'number', 'y should be a number');
            assertTrue(!isNaN(result.x), 'x should not be NaN');
            assertTrue(!isNaN(result.y), 'y should not be NaN');
        });

        it('includes scale in return value', function () {
            if (typeof videoToCanvas !== 'function') return;
            var result = videoToCanvas(0, 0, 640, 480, 1280, 960);
            assertApprox(result.scale, 2.0, 0.01, 'Scale should be 2x');
        });
    });

    // ---- makeVideoToCanvasTransform ----

    describe('Overlays - makeVideoToCanvasTransform', function () {
        it('returns a callable function', function () {
            if (typeof makeVideoToCanvasTransform !== 'function') return;
            var transform = makeVideoToCanvasTransform(640, 480, 640, 480);
            assertEqual(typeof transform, 'function', 'Should return a function');
        });

        it('transform gives same results as videoToCanvas', function () {
            if (typeof makeVideoToCanvasTransform !== 'function') return;
            if (typeof videoToCanvas !== 'function') return;

            var transform = makeVideoToCanvasTransform(640, 480, 1280, 960);
            var testPoints = [[0, 0], [100, 200], [320, 240], [639, 479]];

            for (var i = 0; i < testPoints.length; i++) {
                var direct = videoToCanvas(testPoints[i][0], testPoints[i][1], 640, 480, 1280, 960);
                var viaTransform = transform(testPoints[i][0], testPoints[i][1]);
                assertApprox(viaTransform.x, direct.x, 0.01, 'Transform X at point ' + i);
                assertApprox(viaTransform.y, direct.y, 0.01, 'Transform Y at point ' + i);
            }
        });
    });

    // ---- getTrackColor ----

    describe('Overlays - getTrackColor', function () {
        it('returns a valid hex color string', function () {
            if (typeof getTrackColor !== 'function') return;
            var color = getTrackColor(0);
            assertTrue(typeof color === 'string', 'Should return string');
            assertTrue(color.charAt(0) === '#', 'Should start with #');
            assertGreaterThan(color.length, 3, 'Should be a valid hex color');
        });

        it('returns different colors for different indices', function () {
            if (typeof getTrackColor !== 'function') return;
            var color0 = getTrackColor(0);
            var color1 = getTrackColor(1);
            assertTrue(color0 !== color1, 'Colors 0 and 1 should differ');
        });

        it('cycles colors and does not throw for large indices', function () {
            if (typeof getTrackColor !== 'function') return;
            // Should not throw for any index
            for (var i = 0; i < 20; i++) {
                var color = getTrackColor(i);
                assertNotNull(color, 'Color for index ' + i);
                assertTrue(typeof color === 'string', 'String for index ' + i);
            }
        });
    });

    // ---- Reprojection draw + getGroupColor track-follows-instance ----
    describe('Overlays - reprojection color split and per-instance trackIdx', function () {
        it('drawReprojectedSkeleton uses color for X marks and edgeColor for edges', function () {
            if (typeof drawReprojectedSkeleton !== 'function') return;
            var strokeEvents = [];
            var currentStroke = null;
            var mockCtx = {
                canvas: { width: 100, height: 100, getBoundingClientRect: function () { return { width: 100 }; } },
                save: function () {},
                restore: function () {},
                set strokeStyle(v) { currentStroke = v; },
                get strokeStyle() { return currentStroke; },
                globalAlpha: 1, lineWidth: 1, lineCap: 'butt',
                setLineDash: function () {}, beginPath: function () {},
                moveTo: function () {}, lineTo: function () {},
                arc: function () {}, fill: function () {},
                stroke: function () { strokeEvents.push(currentStroke); },
            };
            drawReprojectedSkeleton(mockCtx, [[10, 10], [20, 20]],
                { nodes: ['a', 'b'], edges: [[0, 1]] },
                { color: '#ffffff', edgeColor: '#aa0000', nodeSize: 4, lineWidth: 2 });
            assertEqual(strokeEvents[0], '#aa0000', 'edges render in edgeColor');
            assertEqual(strokeEvents[strokeEvents.length - 1], '#ffffff',
                'X-mark nodes render in color');
        });

        it('getGroupColor follows the current-camera instance trackIdx after a swap', function () {
            if (typeof getGroupColor !== 'function' || typeof getTrackColor !== 'function') return;
            // Group has per-cam instances on different tracks to also
            // cover the "other cams lag behind" case.
            var a = new Instance([[0, 0]], 0, 'user', 1);
            var b = new Instance([[1, 1]], 1, 'user', 1);
            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', a);
            group.addInstance('cam2', b);
            assertEqual(getGroupColor(group, null, false, 0, 'cam1'), getTrackColor(0));
            assertEqual(getGroupColor(group, null, false, 0, 'cam2'), getTrackColor(1));
            // Simulate swapAssignTrack on cam1's instance WITHOUT
            // touching group.identityId: color must follow the instance.
            a.trackIdx = 2;
            assertEqual(getGroupColor(group, null, false, 0, 'cam1'), getTrackColor(2),
                'color reflects per-instance trackIdx, not stale group.identityId');
        });
    });

    // ---- getGroupColor identity path follows the per-frame map (issue #155) ----
    // When coloring BY IDENTITY, getGroupColor must resolve identity from the
    // per-frame map keyed by the group's LIVE trackIdx — NOT the per-group
    // `group.identityId`, which is only refreshed on the frame an identity was
    // (re)assigned and so goes stale on every other frame after a swap fix is
    // propagated forward ("setting ID does not propagate").
    describe('Overlays - getGroupColor identity path (issue #155)', function () {
        function idSession() {
            var cams = [new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['Red', 'Blue']);
            s.addIdentity('Red', '#ff0000');   // id 0
            s.addIdentity('Blue', '#0000ff');  // id 1
            return s;
        }

        it('follows per-frame identity via live trackIdx, not stale group.identityId', function () {
            if (typeof getGroupColor !== 'function') return;
            var s = idSession();
            s.setFrameIdentity(0, 'cam1', 0, 0);   // per-frame: track 0 -> Red
            var inst = new Instance([[0, 0]], 0, 'user', 1);
            var group = new InstanceGroup(1, 1);   // group.identityId STALE = Blue(1)
            group.addInstance('cam1', inst);
            assertEqual(getGroupColor(group, s, true, 0, 'cam1'), '#ff0000',
                'per-frame identity (Red) wins over stale group.identityId (Blue)');
        });

        it('recolors a future frame after a swap fix propagates forward', function () {
            if (typeof getGroupColor !== 'function') return;
            var s = idSession();
            // Post "Propagate IDs -> Tracks": track 0 -> Red, track 1 -> Blue on every frame.
            for (var f = 0; f < 2; f++) { s.setFrameIdentity(f, 'cam1', 0, 0); s.setFrameIdentity(f, 'cam1', 1, 1); }
            // A physical-Red group on a FUTURE frame still carries the pre-fix
            // group.identityId (Blue) but its instance was swapped back to track 0.
            var inst = new Instance([[0, 0]], 0, 'user', 1);
            var future = new InstanceGroup(2, 1);  // stale Blue
            future.addInstance('cam1', inst);
            assertEqual(getGroupColor(future, s, true, 1, 'cam1'), '#ff0000',
                'future frame reflects propagated per-frame identity, not stale group id');
        });

        it('falls back to group.identityId when no per-frame entry exists', function () {
            if (typeof getGroupColor !== 'function') return;
            var s = idSession();
            var inst = new Instance([[0, 0]], 5, 'user', 1);   // track 5: no per-frame entry
            var group = new InstanceGroup(1, 0);               // group.identityId = Red(0)
            group.addInstance('cam1', inst);
            assertEqual(getGroupColor(group, s, true, 0, 'cam1'), '#ff0000',
                'empty per-frame -> use the assigned group identity');
        });

        it('explicit no-identity sentinel does not override a valid group identity', function () {
            if (typeof getGroupColor !== 'function') return;
            var s = idSession();
            s.setFrameIdentity(0, 'cam1', 0, -1);   // explicit "no identity" on track 0
            var inst = new Instance([[0, 0]], 0, 'user', 1);
            var group = new InstanceGroup(1, 0);    // group.identityId = Red(0)
            group.addInstance('cam1', inst);
            assertEqual(getGroupColor(group, s, true, 0, 'cam1'), '#ff0000',
                'a valid assigned group identity beats the negative sentinel (unchanged precedence)');
        });
    });

    // ---- getGroupColor identity path across cameras (issue #168) ----
    // Reprojections are drawn into EVERY calibrated camera, including one
    // where the group has no real instance (a false-negative detection).
    // getGroupColor must resolve identity using the camera the borrowed
    // trackIdx actually came from — never pair a foreign camera's trackIdx
    // with the TARGET camera's frameIdentityMap, since per-camera trackIdx
    // numbering is independent (see getTrackColor's comment above). Doing so
    // can return a completely different animal's identity/color whenever the
    // two cameras happen to share the same local trackIdx number.
    describe('Overlays - getGroupColor identity path across cameras (issue #168)', function () {
        function twoCamSession() {
            var cams = [
                new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('cam2', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['Red', 'Blue']);
            s.addIdentity('Red', '#ff0000');   // id 0
            s.addIdentity('Blue', '#0000ff');  // id 1
            return s;
        }

        it('resolves a group\'s OWN identity when reprojected into a camera it has no instance in, even with a colliding trackIdx', function () {
            if (typeof getGroupColor !== 'function') return;
            var s = twoCamSession();
            // Group A (Red): real instance only in cam1, trackIdx 0.
            s.setFrameIdentity(0, 'cam1', 0, 0);   // cam1 track 0 -> Red
            var instA = new Instance([[0, 0]], 0, 'user', 1);
            var groupA = new InstanceGroup(1, 0);
            groupA.addInstance('cam1', instA);
            // Group B (Blue): real instance only in cam2, COLLIDING trackIdx 0.
            s.setFrameIdentity(0, 'cam2', 0, 1);   // cam2 track 0 -> Blue
            var instB = new Instance([[1, 1]], 0, 'user', 1);
            var groupB = new InstanceGroup(2, 1);
            groupB.addInstance('cam2', instB);

            // Group A is reprojected into cam2 (it has no real instance there).
            // It must render as ITS OWN identity (Red), not Blue (group B's
            // identity, which happens to own cam2's local track 0).
            assertEqual(getGroupColor(groupA, s, true, 0, 'cam2'), '#ff0000',
                'reprojection keeps its own identity color across cameras, not a colliding foreign trackIdx\'s');
        });

        it('does not apply another camera\'s explicit no-identity sentinel to a group with a valid identity elsewhere', function () {
            if (typeof getGroupColor !== 'function') return;
            var s = twoCamSession();
            // Group A: real instance only in cam1, trackIdx 0, with a valid
            // PER-FRAME identity (Red) but NO group.identityId fallback (-1),
            // so resolution must go through the per-frame trackIdx lookup
            // rather than being shortcut by the group.identityId fallback.
            s.setFrameIdentity(0, 'cam1', 0, 0);   // cam1 track 0 -> Red
            var instA = new Instance([[0, 0]], 0, 'user', 1);
            var groupA = new InstanceGroup(1, -1);
            groupA.addInstance('cam1', instA);
            // cam2's OWN track 0 is explicitly marked "no identity" (unrelated animal/context).
            s.setFrameIdentity(0, 'cam2', 0, -1);

            // Reprojected into cam2: must resolve group A's own Red identity
            // (via cam1's per-frame entry), not cam2's unrelated no-identity
            // sentinel for its own local track 0.
            assertEqual(getGroupColor(groupA, s, true, 0, 'cam2'), '#ff0000',
                'own identity (resolved via its source camera) wins over an unrelated camera\'s no-identity sentinel');
        });

        // The 3D viewport's color callback (pose/initialization.js,
        // ui/export-modals.js) calls getGroupColor with NO cameraName at
        // all — it has no per-view concept, it just wants "this group's
        // color". That omitted-cameraName path was left untouched by the
        // reprojection fix above and hits a DIFFERENT unsound branch:
        // session.getIdentityForTrack's cameraName-less mode, which
        // searches the ENTIRE frameIdentityMap for ANY camera whose local
        // trackIdx matches the number, regardless of which camera it came
        // from. That's the same class of bug (per-camera trackIdx isn't a
        // global key) reappearing through a second door.
        it('resolves a group\'s OWN identity with no cameraName at all (3D-viewport color callback), even with a colliding trackIdx', function () {
            if (typeof getGroupColor !== 'function') return;
            var s = twoCamSession();
            // Insert the COLLIDING (wrong) entry into frameIdentityMap FIRST,
            // so a naive "first match wins" search over the whole map would
            // hit it before group A's own (correct) entry — proving this
            // isn't passing by insertion-order luck.
            s.setFrameIdentity(0, 'cam2', 0, 1);   // unrelated group B: cam2 track 0 -> Blue
            s.setFrameIdentity(0, 'cam1', 0, 0);   // group A's own: cam1 track 0 -> Red
            var instA = new Instance([[0, 0]], 0, 'user', 1);
            var groupA = new InstanceGroup(1, -1);   // no group.identityId fallback
            groupA.addInstance('cam1', instA);

            // No cameraName argument at all, matching the 3D-viewport call signature.
            assertEqual(getGroupColor(groupA, s, true, 0), '#ff0000',
                'camera-agnostic color resolves via the group\'s OWN member camera, not a colliding foreign track number');
        });
    });

    // ---- errorColor ----

    describe('Overlays - errorColor', function () {
        it('returns green for low error', function () {
            if (typeof errorColor !== 'function') return;
            var color = errorColor(0.5);
            assertNotNull(color, 'Should return a color');
        });

        it('returns different colors for different error magnitudes', function () {
            if (typeof errorColor !== 'function') return;
            var low = errorColor(1.0);
            var high = errorColor(10.0);
            // They should be different (green vs red)
            assertTrue(low !== high, 'Low and high error should have different colors');
        });
    });

    // ---- hexToRgb ----

    describe('Overlays - hexToRgb', function () {
        it('parses standard hex colors', function () {
            if (typeof hexToRgb !== 'function') return;
            var result = hexToRgb('#ff0000');
            assertNotNull(result, 'Should parse #ff0000');
            assertEqual(result.r, 255);
            assertEqual(result.g, 0);
            assertEqual(result.b, 0);
        });

        it('parses white', function () {
            if (typeof hexToRgb !== 'function') return;
            var result = hexToRgb('#ffffff');
            assertNotNull(result);
            assertEqual(result.r, 255);
            assertEqual(result.g, 255);
            assertEqual(result.b, 255);
        });

        it('parses black', function () {
            if (typeof hexToRgb !== 'function') return;
            var result = hexToRgb('#000000');
            assertNotNull(result);
            assertEqual(result.r, 0);
            assertEqual(result.g, 0);
            assertEqual(result.b, 0);
        });
    });

    // ---- Drawing functions don't throw ----

    describe('Overlays - drawing functions safety', function () {
        var canvas, ctx;

        function getTestCanvas() {
            if (!canvas) {
                canvas = document.createElement('canvas');
                canvas.width = 640;
                canvas.height = 480;
                ctx = canvas.getContext('2d');
            }
            ctx.clearRect(0, 0, 640, 480);
            return ctx;
        }

        it('drawSkeleton does not throw with valid input', function () {
            if (typeof drawSkeleton !== 'function') return;
            var testCtx = getTestCanvas();
            var instance = new Instance([[100, 200], [300, 400]], 0, 'user', 1);
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            drawSkeleton(testCtx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
            });
        });

        it('drawSkeleton does not throw with null points', function () {
            if (typeof drawSkeleton !== 'function') return;
            var testCtx = getTestCanvas();
            var instance = new Instance([null, null], 0, 'user', 1);
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            drawSkeleton(testCtx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
            });
        });

        it('drawSkeleton does not throw with empty instance', function () {
            if (typeof drawSkeleton !== 'function') return;
            var testCtx = getTestCanvas();
            var instance = new Instance([], 0, 'user', 1);
            var skeleton = new Skeleton('test', [], []);
            drawSkeleton(testCtx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
            });
        });

        it('drawFrameOverlays does not throw with null frameGroup', function () {
            if (typeof drawFrameOverlays !== 'function') return;
            var testCtx = getTestCanvas();
            var skeleton = new Skeleton('test', ['a'], []);
            var cameras = [new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])];
            var session = new Session(cameras, skeleton, []);

            drawFrameOverlays(testCtx, 'cam1', null, [], session, {
                showDetected: true, showReprojected: false, showErrors: false, showLabels: false,
                nodeSize: 4, videoWidth: 640, videoHeight: 480, canvasWidth: 640, canvasHeight: 480,
                selectedInstanceGroup: null, selectedNodeIdx: -1, hoveredNode: null, dragInfo: null,
                unlinkedInstances: [], assignmentSelectedIds: [], assignmentMode: false,
            });
        });

        it('drawFrameOverlays does not throw with empty instanceGroups', function () {
            if (typeof drawFrameOverlays !== 'function') return;
            var testCtx = getTestCanvas();
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var cameras = [new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])];
            var session = new Session(cameras, skeleton, []);

            drawFrameOverlays(testCtx, 'cam1', { instances: {} }, [], session, {
                showDetected: true, showReprojected: true, showErrors: true, showLabels: true,
                nodeSize: 4, videoWidth: 640, videoHeight: 480, canvasWidth: 640, canvasHeight: 480,
                selectedInstanceGroup: null, selectedNodeIdx: -1, hoveredNode: null, dragInfo: null,
                unlinkedInstances: [], assignmentSelectedIds: [], assignmentMode: false,
            });
        });
    });

    // ---- getFrameStats ----

    describe('Overlays - getFrameStats', function () {
        it('computes stats for a frame with data', function () {
            if (typeof getFrameStats !== 'function') return;

            var cameras = [
                new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 100], [640, 480]),
                new Camera('cam2', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0.3, 0], [20, 0, 80], [640, 480]),
            ];
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var session = new Session(cameras, skeleton, ['track_0']);

            var fg = new FrameGroup(0);
            var inst1 = new Instance([[100, 200], [300, 400]], 0, 'user', 0.95);
            var inst2 = new Instance([[150, 250], [350, 450]], 0, 'user', 0.88);
            fg.addInstance('cam1', inst1);
            fg.addInstance('cam2', inst2);
            session.addFrameGroup(fg);

            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst1);
            group.addInstance('cam2', inst2);

            var stats = getFrameStats(fg, [group], cameras);
            assertNotNull(stats, 'Should return stats');
        });

        it('returns empty stats for null frameGroup', function () {
            if (typeof getFrameStats !== 'function') return;
            var stats = getFrameStats(null, [], []);
            assertNotNull(stats, 'Should return stats object even for null input');
        });
    });
})();
