/**
 * test-pose-data.js - Unit tests for pose-data.js
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertDeepEqual, assertNotNull,
        assertNull, assertTrue, assertFalse, assertGreaterThan } = TestFramework;

    // ---- Skeleton ----

    describe('Skeleton', function () {
        it('constructor sets name, nodes, edges', function () {
            const sk = new Skeleton('test', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            assertEqual(sk.name, 'test');
            assertEqual(sk.nodes.length, 3);
            assertEqual(sk.edges.length, 2);
        });

        it('defaultMouse creates 6 nodes and 5 edges', function () {
            const sk = Skeleton.defaultMouse();
            assertEqual(sk.nodes.length, 6);
            assertEqual(sk.edges.length, 5);
            assertEqual(sk.name, 'mouse');
        });

        it('addNode appends and returns index', function () {
            const sk = new Skeleton('t', ['a', 'b'], []);
            const idx = sk.addNode('c');
            assertEqual(idx, 2);
            assertEqual(sk.nodes.length, 3);
            assertEqual(sk.nodes[2], 'c');
        });

        it('removeNode splices node and adjusts edges', function () {
            const sk = new Skeleton('t', ['a', 'b', 'c'], [[0, 1], [1, 2], [0, 2]]);
            const removed = sk.removeNode(1); // remove 'b'
            assertEqual(removed, 'b');
            assertEqual(sk.nodes.length, 2);
            assertDeepEqual(sk.nodes, ['a', 'c']);
            // Edge [0,1] and [1,2] referenced node 1 -> removed
            // Edge [0,2] -> [0,1] (index 2 shifted to 1)
            assertEqual(sk.edges.length, 1);
            assertDeepEqual(sk.edges[0], [0, 1]);
        });

        it('removeNode returns null for invalid index', function () {
            const sk = new Skeleton('t', ['a'], []);
            assertNull(sk.removeNode(-1));
            assertNull(sk.removeNode(5));
        });

        it('addEdge adds and returns true', function () {
            const sk = new Skeleton('t', ['a', 'b', 'c'], []);
            assertTrue(sk.addEdge(0, 1));
            assertEqual(sk.edges.length, 1);
            assertDeepEqual(sk.edges[0], [0, 1]);
        });

        it('addEdge rejects duplicate edges', function () {
            const sk = new Skeleton('t', ['a', 'b'], [[0, 1]]);
            assertFalse(sk.addEdge(0, 1));
            assertFalse(sk.addEdge(1, 0)); // reversed duplicate
            assertEqual(sk.edges.length, 1);
        });

        it('addEdge rejects self-loops', function () {
            const sk = new Skeleton('t', ['a', 'b'], []);
            assertFalse(sk.addEdge(0, 0));
        });

        it('addEdge rejects out of range indices', function () {
            const sk = new Skeleton('t', ['a', 'b'], []);
            assertFalse(sk.addEdge(-1, 0));
            assertFalse(sk.addEdge(0, 5));
        });

        it('removeEdge removes by index', function () {
            const sk = new Skeleton('t', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            assertTrue(sk.removeEdge(0));
            assertEqual(sk.edges.length, 1);
            assertDeepEqual(sk.edges[0], [1, 2]);
        });

        it('removeEdge returns false for invalid index', function () {
            const sk = new Skeleton('t', ['a'], []);
            assertFalse(sk.removeEdge(0));
            assertFalse(sk.removeEdge(-1));
        });
    });

    // ---- Camera ----

    describe('Camera', function () {
        it('constructor stores all parameters', function () {
            const cam = new Camera('test', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            assertEqual(cam.name, 'test');
            assertEqual(cam.size[0], 640);
            assertEqual(cam.size[1], 480);
        });

        it('rotationMatrix returns identity for zero rvec', function () {
            const cam = new Camera('t', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            const R = cam.rotationMatrix;
            assertEqual(R[0][0], 1);
            assertEqual(R[1][1], 1);
            assertEqual(R[2][2], 1);
            assertEqual(R[0][1], 0);
        });

        it('projectionMatrix is 3x4', function () {
            const cam = new Camera('t', [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0.1, 0.2, 0.3], [10, 20, 30], [640, 480]);
            const P = cam.projectionMatrix;
            assertEqual(P.length, 3);
            assertEqual(P[0].length, 4);
        });

        it('project returns 2D point', function () {
            const cam = new Camera('t', [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 100], [640, 480]);
            const pt = cam.project([0, 0, 0]);
            // Point at origin, camera at z=100 looking at origin
            assertEqual(pt.length, 2);
            // Should be finite numbers
            assertTrue(!isNaN(pt[0]));
            assertTrue(!isNaN(pt[1]));
        });
    });

    // ---- Instance ----

    describe('Instance', function () {
        it('constructor sets properties', function () {
            const inst = new Instance([[10, 20], null, [30, 40]], 0, 'predicted', 0.95);
            assertEqual(inst.points.length, 3);
            assertEqual(inst.trackIdx, 0);
            assertEqual(inst.type, 'predicted');
            assertEqual(inst.score, 0.95);
            assertFalse(inst.modified);
        });

        it('setPointVisible hides and restores', function () {
            const inst = new Instance([[10, 20], [30, 40]], 0, 'user', 1);
            inst.backupPoints();
            inst.setPointVisible(0, false);
            assertNull(inst.points[0]);
            inst.setPointVisible(0, true);
            assertDeepEqual(inst.points[0], [10, 20]);
        });

        it('backupPoints creates deep copy', function () {
            const inst = new Instance([[10, 20]], 0, 'user', 1);
            inst.backupPoints();
            inst.points[0][0] = 999;
            assertEqual(inst._originalPoints[0][0], 10);
        });
    });

    // ---- FrameGroup ----

    describe('FrameGroup', function () {
        it('addInstance and getInstances work', function () {
            const fg = new FrameGroup(0);
            const inst = new Instance([[1, 2]], 0, 'user', 1);
            fg.addInstance('cam1', inst);
            assertEqual(fg.getInstances('cam1').length, 1);
            assertEqual(fg.getInstances('cam2').length, 0);
        });

        it('addUnlinkedInstance and getUnlinkedInstances work', function () {
            const fg = new FrameGroup(0);
            const inst = new Instance([[1, 2]], 0, 'predicted', 0.9);
            const ul = new UnlinkedInstance(inst, 'cam1');
            fg.addUnlinkedInstance('cam1', ul);
            assertEqual(fg.getUnlinkedInstances('cam1').length, 1);
        });

        it('removeUnlinkedById removes correct instance', function () {
            const fg = new FrameGroup(0);
            const i1 = new Instance([[1, 2]], 0, 'predicted', 0.9);
            const i2 = new Instance([[3, 4]], 0, 'predicted', 0.8);
            const u1 = new UnlinkedInstance(i1, 'cam1');
            const u2 = new UnlinkedInstance(i2, 'cam1');
            fg.addUnlinkedInstance('cam1', u1);
            fg.addUnlinkedInstance('cam1', u2);

            const removed = fg.removeUnlinkedById(u1.id);
            assertEqual(removed.id, u1.id);
            assertEqual(fg.getUnlinkedInstances('cam1').length, 1);
            assertEqual(fg.getUnlinkedInstances('cam1')[0].id, u2.id);
        });
    });

    // ---- InstanceGroup ----

    describe('InstanceGroup', function () {
        it('addInstance and getInstance work', function () {
            const group = new InstanceGroup(1, 0);
            const inst = new Instance([[10, 20]], 0, 'user', 1);
            group.addInstance('cam1', inst);
            assertEqual(group.getInstance('cam1'), inst);
            assertEqual(group.getInstance('cam2'), undefined);
        });

        it('cameraNames returns correct list', function () {
            const group = new InstanceGroup(1, 0);
            group.addInstance('cam1', new Instance([], 0, 'user', 1));
            group.addInstance('cam2', new Instance([], 0, 'user', 1));
            const names = group.cameraNames;
            assertEqual(names.length, 2);
            assertTrue(names.indexOf('cam1') >= 0);
            assertTrue(names.indexOf('cam2') >= 0);
        });

        it('dirty flag management', function () {
            const group = new InstanceGroup(1, 0);
            assertFalse(group.dirty);
            group.markDirty();
            assertTrue(group.dirty);
            group.markClean();
            assertFalse(group.dirty);
        });
    });

    // ---- Session ----

    describe('Session', function () {
        let session;

        beforeEach(function () {
            const cameras = [
                new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('cam2', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            const skeleton = new Skeleton('test', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            session = new Session(cameras, skeleton, ['track_0', 'track_1']);
        });

        it('constructor sets properties', function () {
            assertEqual(session.cameras.length, 2);
            assertEqual(session.skeleton.name, 'test');
            assertEqual(session.tracks.length, 2);
        });

        it('addFrameGroup and getFrameGroup work', function () {
            const fg = new FrameGroup(5);
            session.addFrameGroup(fg);
            assertEqual(session.getFrameGroup(5), fg);
            assertEqual(session.getFrameGroup(99), undefined);
        });

        it('frameIndices returns sorted list', function () {
            session.addFrameGroup(new FrameGroup(10));
            session.addFrameGroup(new FrameGroup(3));
            session.addFrameGroup(new FrameGroup(7));
            assertDeepEqual(session.frameIndices, [3, 7, 10]);
        });

        it('addNewInstance creates and stores instance', function () {
            const inst = session.addNewInstance(0, 'cam1', session.skeleton, 0);
            assertNotNull(inst);
            assertEqual(inst.points.length, 3); // 3 nodes
            assertEqual(inst.type, 'user');
            assertTrue(inst.modified);
            assertEqual(session.getFrameGroup(0).getInstances('cam1').length, 1);
        });

        it('removeInstanceGroup removes group and its instances', function () {
            // Create a group with instances
            const fg = new FrameGroup(0);
            session.addFrameGroup(fg);

            const inst1 = new Instance([[1, 2], [3, 4], null], 0, 'user', 1);
            const inst2 = new Instance([[5, 6], null, [7, 8]], 0, 'user', 1);
            const group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst1);
            group.addInstance('cam2', inst2);
            fg.addInstance('cam1', inst1);
            fg.addInstance('cam2', inst2);

            // Store in instanceGroups
            session.instanceGroups.set(0, new Map([[0, [group]]]));

            // Verify setup
            assertEqual(session.getInstanceGroupsForFrame(0).length, 1);
            assertEqual(fg.getInstances('cam1').length, 1);
            assertEqual(fg.getInstances('cam2').length, 1);

            // Delete
            const removed = session.removeInstanceGroup(0, group);
            assertTrue(removed);
            assertEqual(session.getInstanceGroupsForFrame(0).length, 0);
            assertEqual(fg.getInstances('cam1').length, 0);
            assertEqual(fg.getInstances('cam2').length, 0);
        });

        it('removeInstanceGroup cleans up empty structures', function () {
            const fg = new FrameGroup(0);
            session.addFrameGroup(fg);
            const inst = new Instance([[1, 2], null, null], 0, 'user', 1);
            const group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst);
            fg.addInstance('cam1', inst);
            session.instanceGroups.set(0, new Map([[0, [group]]]));

            session.removeInstanceGroup(0, group);
            // Empty frame group should be cleaned up
            assertFalse(session.instanceGroups.has(0));
        });

        it('propagateNodeAdded extends all instance points', function () {
            const inst = session.addNewInstance(0, 'cam1', session.skeleton, 0);
            assertEqual(inst.points.length, 3);
            session.skeleton.addNode('new_node');
            session.propagateNodeAdded();
            assertEqual(inst.points.length, 4);
            assertNull(inst.points[3]);
        });

        it('propagateNodeRemoved splices all instance points', function () {
            const inst = session.addNewInstance(0, 'cam1', session.skeleton, 0);
            inst.points[0] = [10, 20];
            inst.points[1] = [30, 40];
            inst.points[2] = [50, 60];
            session.skeleton.removeNode(1); // removes 'b'
            session.propagateNodeRemoved(1);
            assertEqual(inst.points.length, 2);
            assertDeepEqual(inst.points[0], [10, 20]);
            assertDeepEqual(inst.points[1], [50, 60]);
        });

        it('createGroupFromUnlinked creates a group', function () {
            const fg = new FrameGroup(0);
            session.addFrameGroup(fg);

            const inst1 = new Instance([[1, 2], null, null], 0, 'predicted', 0.9);
            const ul1 = new UnlinkedInstance(inst1, 'cam1');
            fg.addUnlinkedInstance('cam1', ul1);

            const inst2 = new Instance([[3, 4], null, null], 0, 'predicted', 0.8);
            const ul2 = new UnlinkedInstance(inst2, 'cam2');
            fg.addUnlinkedInstance('cam2', ul2);

            const group = session.createGroupFromUnlinked(0, [ul1, ul2]);
            assertNotNull(group);
            assertEqual(group.cameraNames.length, 2);
            assertEqual(fg.getUnlinkedInstances('cam1').length, 0);
            assertEqual(fg.getUnlinkedInstances('cam2').length, 0);
        });
    });

    // ---- clonePoints ----

    describe('clonePoints', function () {
        it('deep clones point arrays', function () {
            const original = [[10, 20], null, [30, 40]];
            const cloned = clonePoints(original);
            assertEqual(cloned.length, 3);
            assertDeepEqual(cloned[0], [10, 20]);
            assertNull(cloned[1]);
            // Verify deep copy
            cloned[0][0] = 999;
            assertEqual(original[0][0], 10);
        });

        it('returns null for null input', function () {
            assertNull(clonePoints(null));
        });
    });
})();
