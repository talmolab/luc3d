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
    });
})();
