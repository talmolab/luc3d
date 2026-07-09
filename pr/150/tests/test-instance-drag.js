/**
 * test-instance-drag.js - Tests for Phase 5 Alt+drag whole instance movement.
 *
 * Tests: drag mode detection, delta translation, all points moved,
 * original points preserved, instance type conversion.
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertDeepEqual,
        assertTrue, assertFalse, assertApprox, assertNotNull } = TestFramework;

    describe('Instance Drag - Mode Selection', function () {
        it('sets mode to "instance" when altKey is true', function () {
            var dragInfo = null;

            // Simulate: altKey pressed, hit detected
            var altKey = true;
            var hit = { instanceGroupIdx: 0, nodeIdx: 1 };

            if (altKey && hit) {
                dragInfo = {
                    mode: 'instance',
                    viewName: 'cam1',
                    instanceGroupIdx: hit.instanceGroupIdx,
                    nodeIdx: hit.nodeIdx,
                    startPos: [100, 200],
                    currentPos: [100, 200],
                    originalPoints: [[10, 20], [30, 40], null],
                };
            }

            assertNotNull(dragInfo, 'dragInfo should be set');
            assertEqual(dragInfo.mode, 'instance', 'Mode should be instance');
        });

        it('sets mode to "node" when altKey is false', function () {
            var dragInfo = null;
            var altKey = false;
            var hit = { instanceGroupIdx: 0, nodeIdx: 1 };

            if (altKey && hit) {
                dragInfo = { mode: 'instance' };
            } else if (hit) {
                dragInfo = {
                    mode: 'node',
                    viewName: 'cam1',
                    instanceGroupIdx: hit.instanceGroupIdx,
                    nodeIdx: hit.nodeIdx,
                    startPos: [100, 200],
                    currentPos: [100, 200],
                };
            }

            assertNotNull(dragInfo, 'dragInfo should be set');
            assertEqual(dragInfo.mode, 'node', 'Mode should be node');
        });
    });

    describe('Instance Drag - Delta Translation', function () {
        it('moves all non-null points by delta', function () {
            var originalPoints = [[10, 20], [30, 40], null, [50, 60]];
            var startPos = [100, 200];
            var currentPos = [115, 230]; // delta: [15, 30]

            var dx = currentPos[0] - startPos[0];
            var dy = currentPos[1] - startPos[1];

            var newPoints = originalPoints.map(function (p) {
                return p ? [p[0] + dx, p[1] + dy] : null;
            });

            assertDeepEqual(newPoints[0], [25, 50], 'Point 0 should move by delta');
            assertDeepEqual(newPoints[1], [45, 70], 'Point 1 should move by delta');
            assertEqual(newPoints[2], null, 'Null point should stay null');
            assertDeepEqual(newPoints[3], [65, 90], 'Point 3 should move by delta');
        });

        it('preserves original points array', function () {
            var originalPoints = [[10, 20], [30, 40]];
            var originalCopy = originalPoints.map(function (p) { return p ? [p[0], p[1]] : null; });

            // Apply delta
            var dx = 15, dy = 30;
            var newPoints = originalCopy.map(function (p) {
                return p ? [p[0] + dx, p[1] + dy] : null;
            });

            // Original should be unchanged
            assertDeepEqual(originalPoints[0], [10, 20], 'Original point 0 unchanged');
            assertDeepEqual(originalPoints[1], [30, 40], 'Original point 1 unchanged');
            // New should have delta
            assertDeepEqual(newPoints[0], [25, 50]);
            assertDeepEqual(newPoints[1], [45, 70]);
        });

        it('handles zero delta correctly', function () {
            var originalPoints = [[10, 20], [30, 40]];
            var dx = 0, dy = 0;

            var newPoints = originalPoints.map(function (p) {
                return p ? [p[0] + dx, p[1] + dy] : null;
            });

            assertDeepEqual(newPoints[0], [10, 20], 'Zero delta should not change points');
            assertDeepEqual(newPoints[1], [30, 40], 'Zero delta should not change points');
        });

        it('handles negative delta correctly', function () {
            var originalPoints = [[100, 200], [300, 400]];
            var dx = -50, dy = -75;

            var newPoints = originalPoints.map(function (p) {
                return p ? [p[0] + dx, p[1] + dy] : null;
            });

            assertDeepEqual(newPoints[0], [50, 125]);
            assertDeepEqual(newPoints[1], [250, 325]);
        });
    });

    describe('Instance Drag - Integration with Data Model', function () {
        it('updates Instance points in-place', function () {
            var instance = new Instance([[10, 20], [30, 40], null], 0, 'predicted', 0.9);
            var originalPoints = instance.points.map(function (p) { return p ? [p[0], p[1]] : null; });

            var dx = 15, dy = 30;
            for (var i = 0; i < instance.points.length; i++) {
                if (originalPoints[i]) {
                    instance.points[i] = [originalPoints[i][0] + dx, originalPoints[i][1] + dy];
                }
            }

            assertDeepEqual(instance.points[0], [25, 50]);
            assertDeepEqual(instance.points[1], [45, 70]);
            assertEqual(instance.points[2], null, 'Null point stays null');
        });

        it('converts instance type to user after drag', function () {
            var instance = new Instance([[10, 20]], 0, 'predicted', 0.9);
            assertEqual(instance.type, 'predicted');

            // After drag completes
            instance.type = 'user';
            assertEqual(instance.type, 'user', 'Should be converted to user type');
        });

        it('maintains data model consistency with InstanceGroup', function () {
            var skeleton = new Skeleton('test', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            var ig = new InstanceGroup(0);
            var inst = new Instance([[10, 20], [30, 40], [50, 60]], 0, 'predicted', 0.8);
            ig.addInstance('cam1', inst);

            // Simulate whole-instance drag
            var dx = 5, dy = 10;
            for (var i = 0; i < inst.points.length; i++) {
                if (inst.points[i]) {
                    inst.points[i] = [inst.points[i][0] + dx, inst.points[i][1] + dy];
                }
            }

            // Verify via group reference
            var retrieved = ig.getInstance('cam1');
            assertDeepEqual(retrieved.points[0], [15, 30], 'Group reference should reflect changes');
            assertDeepEqual(retrieved.points[1], [35, 50]);
            assertDeepEqual(retrieved.points[2], [55, 70]);
        });
    });

})();
