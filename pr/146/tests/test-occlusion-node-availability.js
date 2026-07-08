/**
 * test-occlusion-node-availability.js — occluded nodes must stay placeable
 * (branch eric/occlusion-skeleton-issue)
 *
 * Bug: after triangulating a frame where a node is visible in only ONE of two
 * views, that node can't be triangulated → it ends up `null` (no coordinate) in
 * the user instance. That null becomes the "smart add" template
 * (recordUserPoints → addNewInstanceSmart), and `_addNewInstance` copies a
 * length-matched template verbatim (ui/interaction.js:1971), so every NEW
 * instance also gets a `null` there. A `null` node draws no marker, so the
 * un-occlude click affordance (ui/interaction.js:702-735, which needs a node
 * hit) can never reach it — the user can't build a full-keypoint instance.
 *
 * Desired invariant: an added instance must have a POSITION for every skeleton
 * node (occluded ones flagged via `nulledNodes`, but positioned and therefore
 * clickable) — never an unreachable `null`. `_convertToUserInstance`
 * (ui/interaction.js:1718) already does this fill; the smart-add /
 * `_addNewInstance` path does not.
 *
 * These assert the DESIRED behavior, so they FAIL against current code (that is
 * the point — they pin the bug). The fix should make them pass.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;

    function createMockCanvas(w, h) {
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.style.cssText = 'width:' + w + 'px;height:' + h + 'px;position:fixed;top:0;left:0;margin:0;padding:0;border:none;';
        document.body.appendChild(canvas);
        return canvas;
    }
    function cleanupCanvases() {
        document.querySelectorAll('canvas[style*="position: fixed"]').forEach(function (c) { c.remove(); });
    }

    function buildManager() {
        var vw = 640, vh = 480;
        // 3 nodes so a middle node can be the occluded/null one.
        var skeleton = new Skeleton('mouse', ['nose', 'spine', 'tail'], [[0, 1], [1, 2]]);
        var cameras = [
            new Camera('cam1',
                [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh]),
        ];
        var session = new Session(cameras, skeleton, ['track_0']);
        session.addFrameGroup(new FrameGroup(0));
        var canvas = createMockCanvas(vw, vh);
        var views = [{ name: 'cam1', overlayCanvas: canvas, videoWidth: vw, videoHeight: vh }];
        var mgr = new InteractionManager({
            getState: function () { return { currentFrame: 0, session: session, views: views }; },
            getInstanceGroups: function (f) { return session.getInstanceGroupsForFrame(f || 0); },
            onSelectionChanged: function () {},
            onNodeMoved: function () {},
            requestRedraw: function () {},
        });
        mgr.attach(views);
        mgr.lastInteractedView = 'cam1';
        return { mgr: mgr, session: session };
    }

    function addedInstance(session) {
        var ul = session.getFrameGroup(0).getUnlinkedInstances('cam1');
        return (ul && ul.length) ? ul[ul.length - 1].instance : null;
    }

    describe('Occlusion: added instances keep every node placeable (issue: occlusion-skeleton)', function () {
        it('a null template node must NOT become an unreachable null in the new instance', function () {
            if (typeof InteractionManager === 'undefined') return;
            var env = buildManager();
            try {
                // Template mimics a post-triangulation user instance whose middle
                // node was occluded in the only view → null (length === numNodes).
                var template = [[100, 100], null, [200, 200]];
                env.mgr._addNewInstance(template, [150, 150]);

                var inst = addedInstance(env.session);
                assertTrue(!!inst, 'an instance was created');
                assertEqual(inst.points.length, 3, 'instance has one slot per skeleton node');

                // DESIRED: node 1 is positioned (so it draws a marker and can be
                // clicked to un-occlude), not an unreachable null.
                assertTrue(inst.points[1] != null,
                    'occluded template node must be given a position (placeable), not left null');

                // The other nodes keep the template positions.
                assertEqual(inst.points[0][0], 100, 'node 0 keeps template x');
                assertEqual(inst.points[2][0], 200, 'node 2 keeps template x');

                // Occluded node should be FLAGGED (occluded style) rather than dropped.
                assertTrue(inst.nulledNodes && inst.nulledNodes.has(1),
                    'the filled-in occluded node is flagged in nulledNodes');
            } finally {
                cleanupCanvases();
            }
        });

        it('a full template round-trips with all nodes present (no regression)', function () {
            if (typeof InteractionManager === 'undefined') return;
            var env = buildManager();
            try {
                var template = [[100, 100], [150, 150], [200, 200]];
                env.mgr._addNewInstance(template, [150, 150]);
                var inst = addedInstance(env.session);
                assertTrue(!!inst, 'an instance was created');
                for (var i = 0; i < 3; i++) {
                    assertTrue(inst.points[i] != null, 'node ' + i + ' present');
                }
            } finally {
                cleanupCanvases();
            }
        });

        it('with NO template every node is placed (the save+reload workaround path)', function () {
            if (typeof InteractionManager === 'undefined') return;
            var env = buildManager();
            try {
                // No template → topology layout must place every node.
                env.mgr._addNewInstance(null, [320, 240]);
                var inst = addedInstance(env.session);
                assertTrue(!!inst, 'an instance was created');
                for (var i = 0; i < 3; i++) {
                    assertTrue(inst.points[i] != null,
                        'topology layout places node ' + i + ' (why save+reload restores full instances)');
                }
            } finally {
                cleanupCanvases();
            }
        });

        it('the created instance has NO null points (the null poison does not cascade)', function () {
            if (typeof InteractionManager === 'undefined') return;
            var env = buildManager();
            try {
                env.mgr._addNewInstance([[100, 100], null, [200, 200]], [150, 150]);
                var inst = addedInstance(env.session);
                assertTrue(!!inst, 'created');
                // Because every slot is now filled, when this instance seeds the
                // NEXT smart-add template (recordUserPoints), it carries no null —
                // so the missing-node no longer propagates frame to frame.
                for (var i = 0; i < inst.points.length; i++) {
                    assertTrue(inst.points[i] != null, 'node ' + i + ' is placed (no null to re-inherit)');
                }
                // occluded array stays sized to the node count (Instance invariant).
                assertEqual(inst.occluded.length, inst.points.length, 'occluded array matches node count');
            } finally {
                cleanupCanvases();
            }
        });

        it('multiple null slots each get a distinct position and are all flagged', function () {
            if (typeof InteractionManager === 'undefined') return;
            var env = buildManager();
            try {
                // nodes 0 and 2 null, node 1 placed
                env.mgr._addNewInstance([null, [300, 240], null], [300, 240]);
                var inst = addedInstance(env.session);
                assertTrue(!!inst, 'created');
                assertTrue(inst.points[0] != null && inst.points[2] != null, 'both null slots placed');
                assertTrue(inst.nulledNodes && inst.nulledNodes.has(0) && inst.nulledNodes.has(2),
                    'both filled nodes flagged occluded');
                // Fanned out from the centroid → the two placeholders are not identical.
                assertTrue(inst.points[0][0] !== inst.points[2][0] || inst.points[0][1] !== inst.points[2][1],
                    'the two placeholders do not overlap');
            } finally {
                cleanupCanvases();
            }
        });

        it('an all-null template falls back to full topology (no crash, all placed)', function () {
            if (typeof InteractionManager === 'undefined') return;
            var env = buildManager();
            try {
                env.mgr._addNewInstance([null, null, null], [320, 240]);
                var inst = addedInstance(env.session);
                assertTrue(!!inst, 'created');
                for (var i = 0; i < 3; i++) assertTrue(inst.points[i] != null, 'node ' + i + ' placed by topology');
            } finally {
                cleanupCanvases();
            }
        });
    });

    // The key "doesn't break triangulation" check: a filled-occluded node (flagged
    // in nulledNodes) MUST be excluded from the 3D solve, so the fanned-out
    // placeholder position can never pollute triangulation.
    describe('Occlusion: a filled-occluded node is excluded from triangulation', function () {
        function cam(n) {
            return new Camera(n, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [1, 2, 3], [640, 480]);
        }
        it('nulledNodes node → points3d null; the real node still triangulates', function () {
            if (typeof triangulateAndReproject !== 'function' || typeof InstanceGroup === 'undefined') return;
            var cams = [cam('CamA'), cam('CamB')];
            var group = new InstanceGroup(0, 0);
            // node 0 = real 2-view observation; node 1 = occluded placeholder,
            // flagged in nulledNodes exactly as _addNewInstance now produces.
            var instA = new Instance([[300, 240], [123, 111]], 0, 'user', 1); instA.nulledNodes = new Set([1]);
            var instB = new Instance([[345, 250], [130, 120]], 0, 'user', 1); instB.nulledNodes = new Set([1]);
            group.addInstance('CamA', instA);
            group.addInstance('CamB', instB);

            var res = triangulateAndReproject(group, cams, { includedCameras: ['CamA', 'CamB'] });
            assertTrue(!!res && Array.isArray(res.points3d), 'triangulation ran');
            assertTrue(res.points3d[1] == null,
                'the occluded (nulledNodes) node is NOT triangulated from its placeholder');
            assertTrue(res.points3d[0] != null,
                'the real node still triangulates from its two observations');
        });
    });
})();
