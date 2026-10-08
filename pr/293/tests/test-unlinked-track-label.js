/**
 * test-unlinked-track-label.js — the track/identity NAME label on an
 * UNGROUPED (unlinked) instance.
 *
 * Reported workflow (the user ungroups precisely so they can correct one
 * view's ID): select a grouped animal, press Ungroup, then pick the right ID
 * for the row that's wrong. The report is that the moment the group is broken,
 * the "track_1" pill vanishes from the animal in the video, so there is no way
 * to tell which detached detection is which — and therefore no way to know
 * which Ungrouped Instances row to assign.
 *
 * The skeleton itself keeps rendering (dashed edges, "?" badge), so this is
 * specifically about the NAME.
 *
 * `drawFrameOverlays` labels its LINKED user instances in section 4a
 * (`drawInstanceLabels`, which draws a track/identity pill) but hands its
 * unlinked pool to `drawUnlinkedInstances` (section 4b), which draws the "?"
 * badge and per-NODE names and no track pill at all. This test pins the
 * asymmetry by capturing every `fillText` string on both sides of one
 * ungroup, in both color modes.
 */

(function () {
    const { describe, it, assertTrue } = TestFramework;

    const W = 400, H = 300;

    // Real 2D context with fillText/strokeText taped so the drawn STRINGS can
    // be asserted on. Pixel counting can't distinguish "track_1" from "nose".
    function recordingCtx() {
        var c = document.createElement('canvas');
        c.width = W; c.height = H;
        var ctx = c.getContext('2d');
        var texts = [];
        var origFill = ctx.fillText.bind(ctx);
        var origStroke = ctx.strokeText.bind(ctx);
        ctx.fillText = function (s, x, y) { texts.push(String(s)); return origFill(s, x, y); };
        ctx.strokeText = function (s, x, y) { texts.push(String(s)); return origStroke(s, x, y); };
        ctx.__texts = texts;
        return ctx;
    }

    function cam(name) {
        return new Camera(name, [[600, 0, 200], [0, 600, 150], [0, 0, 1]],
            [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [W, H]);
    }

    // One animal on two cameras, raw track 1 ("track_1"), grouped — the state
    // the user is looking at just before they press Ungroup.
    function buildGrouped() {
        var skeleton = new Skeleton('mouse', ['nose', 'tail'], [[0, 1]]);
        var session = new Session([cam('cam1'), cam('cam2')], skeleton,
            ['track_0', 'track_1']);
        session.addFrameGroup(new FrameGroup(0));
        var ul1 = session.addUnlinkedInstance(0, 'cam1',
            new Instance([[120, 120], [180, 180]], 1, 'user', 1.0));
        var ul2 = session.addUnlinkedInstance(0, 'cam2',
            new Instance([[130, 110], [190, 170]], 1, 'user', 1.0));
        var group = session.createGroupFromUnlinked(0, [ul1, ul2]);
        return { session: session, group: group };
    }

    function drawCam1(session, colorByIdentity) {
        var ctx = recordingCtx();
        var fg = session.getFrameGroup(0);
        var overlayFg = { frameIdx: 0, instances: {} };
        for (var e of fg.instances) overlayFg.instances[e[0]] = e[1];
        drawFrameOverlays(ctx, 'cam1', overlayFg,
            session.getInstanceGroupsForFrame(0), session, {
                colorByIdentity: colorByIdentity,
                showUser: true, showPredicted: true,
                showReprojected: false, showErrors: false,
                userOpts: { nodeSize: 4, lineWidth: 2, labelSize: 11, showLabels: true },
                predictedOpts: { nodeSize: 4, lineWidth: 2, labelSize: 11, showLabels: false },
                videoWidth: W, videoHeight: H, canvasWidth: W, canvasHeight: H,
                unlinkedInstances: fg.getUnlinkedInstances('cam1') || [],
            });
        return ctx.__texts;
    }

    describe('Ungrouped instance keeps its track/identity name on canvas', function () {

        it('a GROUPED instance draws its track name', function () {
            var b = buildGrouped();
            var texts = drawCam1(b.session, false);
            assertTrue(texts.indexOf('track_1') >= 0,
                'baseline: grouped instance is labeled track_1 — got ' + JSON.stringify(texts));
        });

        it('the same instance still draws its track name after Ungroup', function () {
            var b = buildGrouped();
            b.session.unlinkGroup(0, b.group);
            var fg = b.session.getFrameGroup(0);
            assertTrue((fg.getUnlinkedInstances('cam1') || []).length === 1,
                'precondition: the cam1 detection is now in the unlinked pool');
            assertTrue((fg.instances.get('cam1') || []).length === 0,
                'precondition: and no longer a linked instance');

            var texts = drawCam1(b.session, false);
            assertTrue(texts.indexOf('track_1') >= 0,
                'ungrouped instance must still be labeled track_1 — got ' + JSON.stringify(texts));
        });

        it('the same instance still draws its IDENTITY name after Ungroup (ID mode)', function () {
            var b = buildGrouped();
            var ident = b.session.getIdentity(b.group.identityId);
            assertTrue(!!ident, 'precondition: the group has an identity');
            var before = drawCam1(b.session, true);
            assertTrue(before.indexOf(ident.name) >= 0,
                'baseline: grouped instance is labeled ' + ident.name + ' — got ' + JSON.stringify(before));

            b.session.unlinkGroup(0, b.group);
            var after = drawCam1(b.session, true);
            assertTrue(after.indexOf(ident.name) >= 0,
                'ungrouped instance must still be labeled ' + ident.name + ' — got ' + JSON.stringify(after));
        });

        // A TRACKLESS ungrouped instance keeps its identity on the INSTANCE
        // (`Instance.identityId`), not in frameIdentityMap — a null track keys
        // one shared slot per camera, so the map cannot hold it (luc3d #201).
        // `getInstanceColor` already reads that field, so the name has to as
        // well or the pill is an identity color over a wrong/absent name.
        it('a TRACKLESS ungrouped instance is labeled from its retained identity', function () {
            var skeleton = new Skeleton('mouse', ['nose', 'tail'], [[0, 1]]);
            var session = new Session([cam('cam1'), cam('cam2')], skeleton, ['track_0']);
            session.addFrameGroup(new FrameGroup(0));
            var u1 = session.addUnlinkedInstance(0, 'cam1',
                new Instance([[120, 120], [180, 180]], null, 'user', 1.0));
            var u2 = session.addUnlinkedInstance(0, 'cam2',
                new Instance([[130, 110], [190, 170]], null, 'user', 1.0));
            var g = session.createGroupFromUnlinked(0, [u1, u2]);
            var ident = session.addIdentity ? session.addIdentity('mouseA') : null;
            assertTrue(!!ident, 'precondition: an identity can be created');
            session.assignIdentityToGroup(g, ident.id);
            session.unlinkGroup(0, g);

            var inst = session.getFrameGroup(0).getUnlinkedInstances('cam1')[0].instance;
            assertTrue(inst.trackIdx == null, 'precondition: still trackless');
            assertTrue(inst.identityId === ident.id,
                'precondition: identity retained on the instance, got ' + inst.identityId);

            var texts = drawCam1(session, true);
            assertTrue(texts.indexOf(ident.name) >= 0,
                'trackless ungrouped instance must be labeled ' + ident.name +
                ' — got ' + JSON.stringify(texts));
        });

        // Nothing to name: no track, no identity. Drawing a positional
        // "Track 0" here would assert a track the instance does not have — the
        // "?" badge already says "unassigned".
        it('an ungrouped instance with no track and no identity gets NO pill', function () {
            var skeleton = new Skeleton('mouse', ['nose', 'tail'], [[0, 1]]);
            var session = new Session([cam('cam1'), cam('cam2')], skeleton, ['track_0']);
            session.addFrameGroup(new FrameGroup(0));
            session.addUnlinkedInstance(0, 'cam1',
                new Instance([[120, 120], [180, 180]], null, 'user', 1.0));

            var texts = drawCam1(session, false);
            assertTrue(texts.indexOf('Track 0') < 0,
                'must not fabricate a track name — got ' + JSON.stringify(texts));
            assertTrue(texts.indexOf('?') >= 0,
                'the "?" badge still marks it unassigned — got ' + JSON.stringify(texts));
        });

        // Two GROUPED instances in one view can share a raw trackIdx — the
        // per-camera tracker produces this (it's why `getGroupColor` has a
        // writtenThisFrame guard and why `drawUnlinkedInstances` carries
        // dup-index shading). The label maps were keyed by trackIdx, so the
        // second animal's name overwrote the first's and BOTH pills read as
        // the same animal while the skeletons were colored differently.
        it('two grouped instances sharing a trackIdx get their OWN identity names', function () {
            var skeleton = new Skeleton('mouse', ['nose', 'tail'], [[0, 1]]);
            var session = new Session([cam('cam1'), cam('cam2')], skeleton, ['track_0']);
            session.addFrameGroup(new FrameGroup(0));
            var idA = session.addIdentity('animal_A');
            var idB = session.addIdentity('animal_B');

            function groupAt(x, identityId) {
                var a = session.addUnlinkedInstance(0, 'cam1',
                    new Instance([[x, 120], [x + 40, 180]], 0, 'user', 1.0));
                var b = session.addUnlinkedInstance(0, 'cam2',
                    new Instance([[x, 110], [x + 40, 170]], 0, 'user', 1.0));
                var g = session.createGroupFromUnlinked(0, [a, b], identityId);
                g.identityId = identityId;
                return g;
            }
            groupAt(60, idA.id);
            groupAt(240, idB.id);

            var cam1Insts = session.getFrameGroup(0).instances.get('cam1');
            assertTrue(cam1Insts.length === 2, 'precondition: two linked instances on cam1');
            assertTrue(cam1Insts[0].trackIdx === 0 && cam1Insts[1].trackIdx === 0,
                'precondition: they share raw trackIdx 0');

            var texts = drawCam1(session, true);
            assertTrue(texts.indexOf('animal_A') >= 0 && texts.indexOf('animal_B') >= 0,
                'each instance is labeled with its OWN identity — got ' + JSON.stringify(texts));
        });
    });
})();
