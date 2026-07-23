/**
 * test-timeline-3dpoints.js
 *
 * A camera-less project whose only data is imported 3D points (skeleton +
 * `handleLoadPoints3dH5`) must still populate the timeline track panel. The
 * normal per-camera track/identity builders enumerate `session.cameras` and so
 * produce zero rows when there are no cameras; the 3D points instead live on
 * `session.instanceGroups` as `group.points3d` + `group.identityId`.
 *
 * `Timeline._build3DPointsSegments` builds one row per track/identity from that
 * data under a synthetic "3D" camera group. These tests cover:
 *   - detection (`_is3DPointsProject`) of the camera-less + points3d shape,
 *   - one row per identity with frame-accurate segments,
 *   - the synthetic "3D" camera group,
 *   - that an all-null group contributes no row.
 */
(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var beforeEach = TF.beforeEach;
    var assertTrue = TF.assertTrue;
    var assertFalse = TF.assertFalse;
    var assertEqual = TF.assertEqual;
    var assertNotNull = TF.assertNotNull;

    function createContainer() {
        var div = document.createElement('div');
        div.style.cssText = 'width:800px;height:240px;position:fixed;top:-9999px;left:0;';
        document.body.appendChild(div);
        return div;
    }
    function cleanup(tl, container) {
        if (tl) tl.destroy();
        if (container && container.parentNode) container.remove();
    }

    // Camera-less session: two identities with 3D points across a few frames.
    //   id_0 (track 0): frames 0,1,2  (contiguous)
    //   id_1 (track 1): frames 0,3    (two segments)
    function build3DPointsSession() {
        var skel = new Skeleton('s', ['a', 'b'], [[0, 1]]);
        var session = new Session([], skel, ['id_0', 'id_1']);
        function addGroup(frameIdx, trackIdx, pts) {
            if (!session.instanceGroups.has(frameIdx)) session.instanceGroups.set(frameIdx, []);
            var g = new InstanceGroup(1000 + frameIdx * 10 + trackIdx, trackIdx);
            g.points3d = pts;
            session.instanceGroups.get(frameIdx).push(g);
        }
        var P = [[1, 2, 3], [4, 5, 6]];
        addGroup(0, 0, P); addGroup(1, 0, P); addGroup(2, 0, P);   // id_0: 0,1,2
        addGroup(0, 1, P); addGroup(3, 1, P);                       // id_1: 0,3
        return session;
    }

    describe('Timeline — 3D-points-only project populates track panel', function () {
        var container, tl;
        beforeEach(function () { container = createContainer(); tl = null; });

        it('_is3DPointsProject detects camera-less project with 3D points', function () {
            tl = new Timeline(container, { totalFrames: 4 });
            var session = build3DPointsSession();
            assertTrue(tl._is3DPointsProject(session), 'should detect 3D-points project');
            cleanup(tl, container);
        });

        it('_is3DPointsProject is false when cameras exist', function () {
            tl = new Timeline(container, { totalFrames: 4 });
            var session = build3DPointsSession();
            session.cameras = [new Camera('camA',
                [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0],
                [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0], [640, 480])];
            assertFalse(tl._is3DPointsProject(session), 'cameras present → not a 3D-points-only project');
            cleanup(tl, container);
        });

        it('builds one row per identity with frame-accurate segments', function () {
            tl = new Timeline(container, { totalFrames: 4 });
            tl.setData(build3DPointsSession());

            // Two real track rows (id_0, id_1), no empty placeholder.
            var rows = tl._trackSegments.filter(function (s) { return s.treeRole !== 'empty'; });
            assertEqual(rows.length, 2, 'two identity rows');

            var byTrack = {};
            rows.forEach(function (r) { byTrack[r.trackIdx] = r; });

            assertNotNull(byTrack[0], 'id_0 row present');
            assertNotNull(byTrack[1], 'id_1 row present');
            assertEqual(byTrack[0].trackName, 'id_0', 'id_0 name');
            assertEqual(byTrack[1].trackName, 'id_1', 'id_1 name');

            // id_0 occupies frames 0-2 as a single contiguous segment.
            assertEqual(byTrack[0].segments.length, 1, 'id_0 one segment');
            assertEqual(byTrack[0].segments[0].start, 0, 'id_0 start');
            assertEqual(byTrack[0].segments[0].end, 2, 'id_0 end');

            // id_1 occupies frames 0 and 3 as two separate segments.
            assertEqual(byTrack[1].segments.length, 2, 'id_1 two segments');
            cleanup(tl, container);
        });

        it('groups rows under a synthetic "3D" camera', function () {
            tl = new Timeline(container, { totalFrames: 4 });
            tl.setData(build3DPointsSession());
            assertTrue(tl._trackSegments.every(function (s) { return s.cameraName === '3D'; }),
                'all rows under the "3D" camera');
            var groups = tl._cameraGroups || [];
            assertEqual(groups.length, 1, 'single camera group');
            assertEqual(groups[0].name, '3D', 'group name is 3D');
            cleanup(tl, container);
        });

        it('an all-null group contributes no row', function () {
            tl = new Timeline(container, { totalFrames: 4 });
            var session = build3DPointsSession();
            // Add a third track whose points are all null — should be ignored.
            session.tracks.push('id_2');
            session.instanceGroups.get(0).push((function () {
                var g = new InstanceGroup(9999, 2);
                g.points3d = [null, null];
                return g;
            })());
            tl.setData(session);
            var rows = tl._trackSegments.filter(function (s) { return s.treeRole !== 'empty'; });
            assertEqual(rows.length, 2, 'all-null track produces no row');
            cleanup(tl, container);
        });
    });
})();
