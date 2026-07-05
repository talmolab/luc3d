/**
 * test-mixed-group-promotion.js — Regression tests for the
 * "mixed group → all-user" promotion semantic.
 *
 * Spec recap:
 *  - When an InstanceGroup contains BOTH user and predicted instances ("mixed"),
 *    detaching any predicted member from that group must promote it to a user
 *    instance (`type='user'`, `modified=true`). The rationale is that the user
 *    explicitly curated the group — the predicted member, by virtue of being
 *    in a user-curated group, is implicitly accepted as user-quality data.
 *  - All-predicted groups stay predicted on detach (no promotion).
 *  - All-user groups stay user (no-op promotion path).
 *  - `Session.unlinkGroup(frameIdx, group, forcePromoteToUser)` accepts an
 *    optional 3rd flag that forces promotion regardless of current
 *    composition. This is used when a previously-mixed group has dropped
 *    to one survivor and is being auto-ungrouped (Issue 3).
 *  - The same promotion rule applies in `onEditGroupRemove` (per-view detach
 *    via the Edit Group toast).
 *
 * Fix locations covered:
 *  - `pose-data.js` Session.unlinkGroup (around line 1057+) — directly tested.
 *  - `index.html` onEditGroupRemove inline handler (around line 3346-3391) —
 *    mirrored as a helper in this file (matches the precedent established by
 *    `tests/test-edit-group-fixes.js`, since the production code lives in an
 *    inline script and isn't directly importable).
 */

(function () {
    var describe   = TestFramework.describe;
    var it         = TestFramework.it;
    var assertEqual       = TestFramework.assertEqual;
    var assertTrue        = TestFramework.assertTrue;
    var assertFalse       = TestFramework.assertFalse;
    var assertNotNull     = TestFramework.assertNotNull;

    // ============================================================
    // Test environment helpers
    // ============================================================

    function makeCamera(name, vw, vh) {
        return new Camera(
            name,
            [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
            [vw, vh]
        );
    }

    function makeSkeleton() {
        return new Skeleton('mouse', ['nose', 'head'], [[0, 1]]);
    }

    /**
     * Build a Session with one InstanceGroup whose members come from a typed
     * spec. `typeSpec` is a plain object mapping camName -> 'user'|'predicted'.
     *
     * Returns:
     *  - session, fg, group
     *  - instances: { camName: Instance }
     */
    function buildTypedGroupEnv(typeSpec, opts) {
        opts = opts || {};
        var vw = 640, vh = 480;
        var trackIdx = opts.trackIdx != null ? opts.trackIdx : 2;

        var camNames = Object.keys(typeSpec);
        var skeleton = makeSkeleton();
        var cameras = camNames.map(function (n) { return makeCamera(n, vw, vh); });
        var session = new Session(
            cameras,
            skeleton,
            ['track_0', 'track_1', 'track_2', 'track_3']
        );

        var fg = new FrameGroup(0);

        var instances = {};
        camNames.forEach(function (camName, idx) {
            var base = 100 + idx * 100;
            var t = typeSpec[camName];
            var score = (t === 'user') ? 1.0 : 0.85;
            var inst = new Instance(
                [[base, base], [base + 50, base + 50]],
                trackIdx,
                t,
                score
            );
            // `modified` is false by default for both user and predicted —
            // keep that as the "original" state so we can detect the
            // promotion mutation cleanly.
            inst.modified = false;
            instances[camName] = inst;
            fg.addInstance(camName, inst);
        });
        session.addFrameGroup(fg);

        var group = new InstanceGroup(42, trackIdx);
        camNames.forEach(function (camName) {
            group.addInstance(camName, instances[camName]);
        });
        if (!session.instanceGroups.has(0)) session.instanceGroups.set(0, []);
        session.instanceGroups.get(0).push(group);

        return {
            session: session,
            fg: fg,
            group: group,
            instances: instances,
            camNames: camNames,
            trackIdx: trackIdx,
        };
    }

    // ============================================================
    // Suite 1 — Session.unlinkGroup mixed-group promotion (auto-detect)
    // ============================================================

    describe('Session.unlinkGroup — mixed-group predicted-to-user promotion', function () {

        it('Mixed (1 user + 2 predicted) → all unlinked have type user; promoted predicteds carry modified=true', function () {
            var env = buildTypedGroupEnv({
                cam1: 'user',
                cam2: 'predicted',
                cam3: 'predicted',
            });
            // Capture the original-type fingerprint by Instance object so we
            // can assert promotion only fires for those that started as
            // predicted. The user instance's `modified` flag should be
            // preserved (was false, stays false) — the spec only mutates
            // predicted-typed members.
            var origType = new Map();
            for (var cn of env.camNames) origType.set(env.instances[cn], env.instances[cn].type);

            var newUnlinked = env.session.unlinkGroup(0, env.group);

            assertEqual(newUnlinked.length, 3, 'three UnlinkedInstance returned');
            for (var i = 0; i < newUnlinked.length; i++) {
                var ul = newUnlinked[i];
                assertEqual(ul.instance.type, 'user',
                    'unlinked[' + i + '].instance.type === user');
                if (origType.get(ul.instance) === 'predicted') {
                    assertTrue(ul.instance.modified === true,
                        'promoted predicted on ' + ul.cameraName + ' has modified=true');
                } else {
                    assertFalse(!!ul.instance.modified,
                        'originally-user ' + ul.cameraName + ' has modified untouched (false)');
                }
            }

            // Group is gone from session.
            var groups = env.session.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 0, 'group removed from session.instanceGroups');

            // Each unlinked landed in fg.unlinkedInstances under its cam name.
            for (var j = 0; j < env.camNames.length; j++) {
                var cn2 = env.camNames[j];
                var pool = env.fg.getUnlinkedInstances(cn2) || [];
                assertEqual(pool.length, 1, cn2 + ' has exactly one unlinked');
                assertTrue(pool[0].instance === env.instances[cn2],
                    cn2 + ' unlinked wraps the same Instance object');
            }
        });

        it('All-predicted (2 predicted) → both stay predicted, modified=false', function () {
            var env = buildTypedGroupEnv({
                cam1: 'predicted',
                cam2: 'predicted',
            });

            var newUnlinked = env.session.unlinkGroup(0, env.group);

            assertEqual(newUnlinked.length, 2, 'two UnlinkedInstance returned');
            for (var i = 0; i < newUnlinked.length; i++) {
                assertEqual(newUnlinked[i].instance.type, 'predicted',
                    'unlinked[' + i + '].instance.type unchanged');
                assertFalse(newUnlinked[i].instance.modified,
                    'unlinked[' + i + '].instance.modified untouched (false)');
            }

            assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0,
                'group removed from session');
        });

        it('All-user (2 user) → both stay user, modified preserved (no-op promotion)', function () {
            var env = buildTypedGroupEnv({
                cam1: 'user',
                cam2: 'user',
            });
            // Set deliberate modified flags to verify they survive the no-op path.
            env.instances.cam1.modified = false;
            env.instances.cam2.modified = true;

            var newUnlinked = env.session.unlinkGroup(0, env.group);

            assertEqual(newUnlinked.length, 2, 'two UnlinkedInstance returned');
            for (var i = 0; i < newUnlinked.length; i++) {
                assertEqual(newUnlinked[i].instance.type, 'user',
                    'unlinked[' + i + '].instance.type === user (unchanged)');
            }
            // `modified` flags on user instances are not touched: predicates in
            // the fix only fire `modified=true` for predicted-type members.
            assertFalse(env.instances.cam1.modified,
                'cam1 modified preserved (was false, stays false)');
            assertTrue(env.instances.cam2.modified,
                'cam2 modified preserved (was true, stays true)');
        });

        it('Reverse-mixed (1 predicted + 2 user) → predicted promoted, user untouched', function () {
            var env = buildTypedGroupEnv({
                cam1: 'predicted',
                cam2: 'user',
                cam3: 'user',
            });
            // Force user.modified to a known starting state so we can confirm
            // it isn't touched by the promotion path.
            env.instances.cam2.modified = false;
            env.instances.cam3.modified = false;

            env.session.unlinkGroup(0, env.group);

            // Predicted promoted to user with modified=true.
            assertEqual(env.instances.cam1.type, 'user',
                'cam1 (was predicted) promoted to user');
            assertTrue(env.instances.cam1.modified === true,
                'cam1 modified=true after promotion');

            // User instances untouched.
            assertEqual(env.instances.cam2.type, 'user', 'cam2 still user');
            assertEqual(env.instances.cam3.type, 'user', 'cam3 still user');
            assertFalse(env.instances.cam2.modified,
                'cam2.modified untouched (still false)');
            assertFalse(env.instances.cam3.modified,
                'cam3.modified untouched (still false)');
        });

        it('Single-user single-predicted (2-instance mixed) → both become user-unlinked', function () {
            var env = buildTypedGroupEnv({
                cam1: 'user',
                cam2: 'predicted',
            });

            var newUnlinked = env.session.unlinkGroup(0, env.group);

            assertEqual(newUnlinked.length, 2, 'two UnlinkedInstance returned');
            assertEqual(env.instances.cam1.type, 'user', 'cam1 still user');
            assertEqual(env.instances.cam2.type, 'user',
                'cam2 promoted to user (mixed path)');
            assertTrue(env.instances.cam2.modified === true,
                'cam2 modified=true after promotion');

            // Both visible in unlinked pool.
            var ul1 = env.fg.getUnlinkedInstances('cam1') || [];
            var ul2 = env.fg.getUnlinkedInstances('cam2') || [];
            assertEqual(ul1.length, 1, 'cam1 unlinked count');
            assertEqual(ul2.length, 1, 'cam2 unlinked count');
        });

        it('Group is correctly removed from session.instanceGroups[frameIdx]', function () {
            // Add a SECOND group at the same frame so we can verify the right
            // entry was spliced out (and the frameIdx entry wasn't blanket-deleted).
            var env = buildTypedGroupEnv({
                cam1: 'user',
                cam2: 'predicted',
            });

            // Add a second, untouched group at frame 0.
            var otherInst = new Instance([[10, 10]], 1, 'predicted', 0.7);
            env.fg.addInstance('cam1', otherInst);
            var otherGroup = new InstanceGroup(43, 1);
            otherGroup.addInstance('cam1', otherInst);
            env.session.instanceGroups.get(0).push(otherGroup);

            assertEqual(env.session.getInstanceGroupsForFrame(0).length, 2,
                'precondition: 2 groups at frame 0');

            env.session.unlinkGroup(0, env.group);

            var groups = env.session.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 1, 'one group remains');
            assertTrue(groups[0] === otherGroup, 'the OTHER group survives');
        });

        it('All members appear in FrameGroup.unlinkedInstances', function () {
            var env = buildTypedGroupEnv({
                cam1: 'user',
                cam2: 'predicted',
                cam3: 'predicted',
            });

            env.session.unlinkGroup(0, env.group);

            for (var i = 0; i < env.camNames.length; i++) {
                var cn = env.camNames[i];
                var pool = env.fg.getUnlinkedInstances(cn) || [];
                assertEqual(pool.length, 1,
                    cn + ' has exactly 1 unlinked instance');
                assertTrue(pool[0].instance === env.instances[cn],
                    cn + ' unlinked wraps original Instance');
                assertEqual(pool[0].cameraName, cn,
                    cn + ' UnlinkedInstance.cameraName matches');
            }

            // Linked side is empty for all cams (group is gone).
            for (var j = 0; j < env.camNames.length; j++) {
                var cn2 = env.camNames[j];
                var linked = env.fg.instances.get(cn2);
                assertTrue(!linked || linked.length === 0,
                    cn2 + ' has no linked instances left');
            }
        });
    });

    // ============================================================
    // Suite 2 — forcePromoteToUser flag
    // ============================================================

    describe('Session.unlinkGroup — forcePromoteToUser flag overrides composition', function () {

        it('All-predicted + forcePromoteToUser=true → all promoted to user', function () {
            var env = buildTypedGroupEnv({
                cam1: 'predicted',
                cam2: 'predicted',
            });

            env.session.unlinkGroup(0, env.group, true);

            assertEqual(env.instances.cam1.type, 'user',
                'cam1 promoted to user (force)');
            assertEqual(env.instances.cam2.type, 'user',
                'cam2 promoted to user (force)');
            assertTrue(env.instances.cam1.modified === true,
                'cam1 modified=true');
            assertTrue(env.instances.cam2.modified === true,
                'cam2 modified=true');
        });

        it('Already-user + forcePromoteToUser=true → no-op (modified untouched)', function () {
            var env = buildTypedGroupEnv({
                cam1: 'user',
                cam2: 'user',
            });
            env.instances.cam1.modified = false;
            env.instances.cam2.modified = true;

            env.session.unlinkGroup(0, env.group, true);

            // Type unchanged.
            assertEqual(env.instances.cam1.type, 'user', 'cam1 still user');
            assertEqual(env.instances.cam2.type, 'user', 'cam2 still user');

            // modified is NOT forced — the fix only mutates predicted-typed
            // members, so user instances keep whatever modified flag they had.
            assertFalse(env.instances.cam1.modified,
                'cam1.modified preserved (was false)');
            assertTrue(env.instances.cam2.modified,
                'cam2.modified preserved (was true)');
        });

        it('Mixed + forcePromoteToUser=true → all promoted to user (same as auto)', function () {
            var env = buildTypedGroupEnv({
                cam1: 'user',
                cam2: 'predicted',
                cam3: 'predicted',
            });

            env.session.unlinkGroup(0, env.group, true);

            assertEqual(env.instances.cam1.type, 'user', 'cam1 still user');
            assertEqual(env.instances.cam2.type, 'user', 'cam2 promoted');
            assertEqual(env.instances.cam3.type, 'user', 'cam3 promoted');
            assertTrue(env.instances.cam2.modified === true, 'cam2 modified=true');
            assertTrue(env.instances.cam3.modified === true, 'cam3 modified=true');
        });

        it('All-predicted + forcePromoteToUser=false → not promoted', function () {
            var env = buildTypedGroupEnv({
                cam1: 'predicted',
                cam2: 'predicted',
            });

            env.session.unlinkGroup(0, env.group, false);

            assertEqual(env.instances.cam1.type, 'predicted',
                'cam1 stays predicted (no force, no mix)');
            assertEqual(env.instances.cam2.type, 'predicted',
                'cam2 stays predicted (no force, no mix)');
            assertFalse(env.instances.cam1.modified, 'cam1.modified untouched');
            assertFalse(env.instances.cam2.modified, 'cam2.modified untouched');
        });

        it('Mixed + forcePromoteToUser=false → still promoted (auto-detect kicks in)', function () {
            // Explicit `false` must NOT suppress auto-detect — the mixed
            // composition itself triggers promotion.
            var env = buildTypedGroupEnv({
                cam1: 'user',
                cam2: 'predicted',
            });

            env.session.unlinkGroup(0, env.group, false);

            assertEqual(env.instances.cam1.type, 'user', 'cam1 still user');
            assertEqual(env.instances.cam2.type, 'user',
                'cam2 promoted via auto-detect (mixed)');
            assertTrue(env.instances.cam2.modified === true,
                'cam2 modified=true via auto-detect');
        });
    });

    // ============================================================
    // Suite 3 — onEditGroupRemove promotion (mirrored helper)
    //
    // Mirrors the production callback body in index.html (~3346-3391). Pure
    // data ops only — no DOM, no markDirty, no overlay redraw. Returns the
    // (possibly promoted) Instance for assertion convenience.
    // ============================================================

    /**
     * Mirror of the `onEditGroupRemove` body that exercises the promotion
     * branch. Returns the removed Instance.
     */
    function editGroupRemoveBranch(group, viewName, fg) {
        var inst = group.getInstance(viewName);
        if (!inst) return null;

        // Pre-removal mixed detection.
        var hasUser = false, hasPred = false;
        for (var entry of group.instances) {
            var _gInst = entry[1];
            if (_gInst.type === 'user') hasUser = true;
            else if (_gInst.type === 'predicted') hasPred = true;
        }
        var srcMixed = hasUser && hasPred;
        if (srcMixed && inst.type === 'predicted') {
            inst.type = 'user';
            inst.modified = true;
        }

        // Remove from group.
        group.instances.delete(viewName);

        // Sync observedPoints (Bug B2 invariant — must stay intact).
        if (group.observedPoints) {
            delete group.observedPoints[viewName];
        }

        // Move from FrameGroup linked → unlinked.
        if (fg) {
            var camInstances = fg.instances.get(viewName);
            if (camInstances) {
                var idx = camInstances.indexOf(inst);
                if (idx >= 0) camInstances.splice(idx, 1);
                if (camInstances.length === 0) fg.instances.delete(viewName);
            }
            var ul = new UnlinkedInstance(inst, viewName);
            fg.addUnlinkedInstance(viewName, ul);
        }

        return inst;
    }

    describe('Edit Group remove — promotes detached predicted from mixed group', function () {

        it('Mixed group, remove a predicted → predicted promoted to user, modified=true; remaining members untouched', function () {
            var env = buildTypedGroupEnv({
                cam1: 'user',
                cam2: 'predicted',
                cam3: 'predicted',
            });

            // Pre-populate observedPoints so we can also verify the B2 invariant.
            env.group.observedPoints = {
                cam1: env.instances.cam1.points,
                cam2: env.instances.cam2.points,
                cam3: env.instances.cam3.points,
            };

            var removed = editGroupRemoveBranch(env.group, 'cam2', env.fg);

            assertNotNull(removed, 'returned the removed Instance');
            assertTrue(removed === env.instances.cam2, 'same Instance object');
            assertEqual(removed.type, 'user', 'removed predicted promoted to user');
            assertTrue(removed.modified === true, 'modified=true after promotion');

            // Removed Instance lives in FrameGroup.unlinkedInstances under its cam.
            var ul = env.fg.getUnlinkedInstances('cam2') || [];
            assertEqual(ul.length, 1, 'cam2 has 1 unlinked');
            assertTrue(ul[0].instance === env.instances.cam2,
                'cam2 unlinked wraps the same (now-promoted) Instance');

            // Group survives, cam2 gone from group.
            assertFalse(env.group.instances.has('cam2'), 'cam2 removed from group');
            assertEqual(env.group.instances.size, 2, 'group has 2 members left');
            assertTrue(env.group.instances.has('cam1'), 'cam1 still in group');
            assertTrue(env.group.instances.has('cam3'), 'cam3 still in group');

            // Remaining members keep their original types — promotion only
            // applies to the *detached* instance, not to surviving group
            // members.
            assertEqual(env.instances.cam1.type, 'user',
                'cam1 stays user (untouched in-group)');
            assertEqual(env.instances.cam3.type, 'predicted',
                'cam3 stays predicted (untouched in-group)');
            assertFalse(env.instances.cam3.modified,
                'cam3.modified not touched');
        });

        it('Mixed group, remove the user → user stays user (no-op promotion)', function () {
            var env = buildTypedGroupEnv({
                cam1: 'user',
                cam2: 'predicted',
                cam3: 'predicted',
            });
            env.instances.cam1.modified = false;

            var removed = editGroupRemoveBranch(env.group, 'cam1', env.fg);

            assertNotNull(removed, 'returned the removed Instance');
            assertEqual(removed.type, 'user',
                'cam1 was already user, stays user');
            // The fix only mutates predicted-typed instances. The removed
            // user instance's `modified` flag should NOT be touched by the
            // promotion path.
            assertFalse(removed.modified,
                'cam1.modified untouched (no promotion mutation for user-typed)');

            // Group is now all-predicted (cam2 + cam3 still predicted).
            assertFalse(env.group.instances.has('cam1'), 'cam1 removed from group');
            assertEqual(env.instances.cam2.type, 'predicted',
                'cam2 stays predicted in-group');
            assertEqual(env.instances.cam3.type, 'predicted',
                'cam3 stays predicted in-group');

            var ul = env.fg.getUnlinkedInstances('cam1') || [];
            assertEqual(ul.length, 1, 'cam1 has 1 unlinked');
            assertTrue(ul[0].instance === env.instances.cam1,
                'cam1 unlinked wraps the same Instance');
        });

        it('All-predicted group, remove a predicted → stays predicted (no promotion)', function () {
            var env = buildTypedGroupEnv({
                cam1: 'predicted',
                cam2: 'predicted',
                cam3: 'predicted',
            });

            var removed = editGroupRemoveBranch(env.group, 'cam2', env.fg);

            assertNotNull(removed, 'returned the removed Instance');
            assertEqual(removed.type, 'predicted',
                'no promotion: group was not mixed');
            assertFalse(removed.modified,
                'modified flag unchanged (no promotion)');

            // Remaining members untouched.
            assertEqual(env.instances.cam1.type, 'predicted', 'cam1 stays predicted');
            assertEqual(env.instances.cam3.type, 'predicted', 'cam3 stays predicted');

            // Removed Instance still landed in unlinked pool.
            var ul = env.fg.getUnlinkedInstances('cam2') || [];
            assertEqual(ul.length, 1, 'cam2 has 1 unlinked');
            assertEqual(ul[0].instance.type, 'predicted',
                'unlinked still predicted-typed');
        });

        it('After remove, group.observedPoints[removedView] is gone (Bug B2 invariant intact)', function () {
            // The Issue 2 fix was added BEFORE the existing observedPoints
            // sync. Both must coexist correctly.
            var env = buildTypedGroupEnv({
                cam1: 'user',
                cam2: 'predicted',
                cam3: 'predicted',
            });
            env.group.observedPoints = {
                cam1: env.instances.cam1.points,
                cam2: env.instances.cam2.points,
                cam3: env.instances.cam3.points,
            };
            var cam1Pts = env.group.observedPoints.cam1;
            var cam3Pts = env.group.observedPoints.cam3;

            editGroupRemoveBranch(env.group, 'cam2', env.fg);

            // Removed view's observedPoints entry is gone.
            assertEqual(env.group.observedPoints.cam2, undefined,
                'observedPoints.cam2 deleted (B2 invariant)');
            // Other views' entries preserved by reference.
            assertTrue(env.group.observedPoints.cam1 === cam1Pts,
                'observedPoints.cam1 untouched (reference)');
            assertTrue(env.group.observedPoints.cam3 === cam3Pts,
                'observedPoints.cam3 untouched (reference)');

            // And the Issue 2 promotion still happened.
            assertEqual(env.instances.cam2.type, 'user',
                'cam2 promoted (Issue 2 fix)');
            assertTrue(env.instances.cam2.modified === true,
                'cam2 modified=true');
        });
    });

    // ============================================================
    // Suite — Session.createGroupFromUnlinked eagerly promotes mixed
    //
    // The "mixed = user-typed" rule is enforced at group-creation, not
    // only at separation. Forming a group from a mix of user + predicted
    // unlinked instances must yield a uniformly-user group regardless of
    // unlinked insertion order — pre-fix, the resulting group's
    // `firstInst.type` (and thus the info-panel badge) flipped between
    // 'User' and 'Pred' depending on which unlinked appeared first.
    // ============================================================

    describe('Session.createGroupFromUnlinked — eager mixed-to-user promotion at creation', function () {

        function buildFreshSession(camNames) {
            var skeleton = makeSkeleton();
            var cameras = camNames.map(function (n) { return makeCamera(n, 640, 480); });
            var session = new Session(cameras, skeleton, ['t0', 't1', 't2']);
            session.addFrameGroup(new FrameGroup(0));
            return session;
        }

        it('mixed [user, predicted] → predicted promoted at creation; group uniformly user', function () {
            var session = buildFreshSession(['cam1', 'cam2']);
            var userInst = new Instance([[100,100],[150,150]], 1, 'user', 1.0);
            userInst.modified = false;
            var predInst = new Instance([[200,200],[250,250]], 1, 'predicted', 0.85);
            predInst.modified = false;

            var userUl = session.addUnlinkedInstance(0, 'cam1', userInst);
            var predUl = session.addUnlinkedInstance(0, 'cam2', predInst);

            var group = session.createGroupFromUnlinked(0, [userUl, predUl], 1);

            assertEqual(group.getInstance('cam1').type, 'user', 'cam1 is user');
            assertEqual(group.getInstance('cam2').type, 'user',
                'cam2 promoted to user at creation');
            assertEqual(predInst.type, 'user', 'predInst object mutated to user');
            assertTrue(predInst.modified === true,
                'promoted predicted carries modified=true');
            assertFalse(userInst.modified,
                'originally-user instance modified untouched');
        });

        it('reverse order [predicted, user] → still uniformly user (no order dependence)', function () {
            // Pre-fix bug: building from [pred, user] left firstInst='predicted'
            // so the badge displayed 'Pred' even though the group was mixed.
            var session = buildFreshSession(['cam1', 'cam2']);
            var predInst = new Instance([[200,200],[250,250]], 2, 'predicted', 0.9);
            predInst.modified = false;
            var userInst = new Instance([[100,100],[150,150]], 2, 'user', 1.0);
            userInst.modified = false;

            // NOTE: predicted gets the FIRST cam slot here so iteration
            // order in `firstInst.type` checks would have hit 'predicted'.
            var predUl = session.addUnlinkedInstance(0, 'cam1', predInst);
            var userUl = session.addUnlinkedInstance(0, 'cam2', userInst);

            var group = session.createGroupFromUnlinked(0, [predUl, userUl], 2);

            // Both members are user post-creation; firstInst.type === 'user'
            // regardless of insertion order.
            var firstInst = group.instances.values().next().value;
            assertEqual(firstInst.type, 'user',
                'firstInst is user (info-panel badge stable across orderings)');
            for (var [, inst] of group.instances) {
                assertEqual(inst.type, 'user',
                    'every group member is user post-creation');
            }
        });

        it('all-predicted input → no promotion (group stays predicted)', function () {
            var session = buildFreshSession(['cam1', 'cam2']);
            var p1 = new Instance([[100,100]], 0, 'predicted', 0.8); p1.modified = false;
            var p2 = new Instance([[200,200]], 0, 'predicted', 0.7); p2.modified = false;
            var u1 = session.addUnlinkedInstance(0, 'cam1', p1);
            var u2 = session.addUnlinkedInstance(0, 'cam2', p2);

            var group = session.createGroupFromUnlinked(0, [u1, u2], 0);

            assertEqual(group.getInstance('cam1').type, 'predicted',
                'cam1 stays predicted (no mixed signal to trigger promotion)');
            assertEqual(group.getInstance('cam2').type, 'predicted', 'cam2 stays predicted');
            assertFalse(p1.modified, 'p1.modified untouched');
            assertFalse(p2.modified, 'p2.modified untouched');
        });

        it('all-user input → no-op (no mutations)', function () {
            var session = buildFreshSession(['cam1', 'cam2']);
            var u1 = new Instance([[100,100]], 0, 'user', 1.0); u1.modified = false;
            var u2 = new Instance([[200,200]], 0, 'user', 1.0); u2.modified = true;
            var ul1 = session.addUnlinkedInstance(0, 'cam1', u1);
            var ul2 = session.addUnlinkedInstance(0, 'cam2', u2);

            var group = session.createGroupFromUnlinked(0, [ul1, ul2], 0);

            assertEqual(group.getInstance('cam1').type, 'user');
            assertEqual(group.getInstance('cam2').type, 'user');
            assertFalse(u1.modified, 'u1.modified preserved (was false)');
            assertTrue(u2.modified, 'u2.modified preserved (was true)');
        });
    });

    // ============================================================
    // Suite — _promoteIfMixed direct
    // ============================================================

    describe('Session._promoteIfMixed — direct invocation', function () {

        it('returns true and mutates predicted → user when group is mixed', function () {
            var session = new Session(
                [makeCamera('cam1', 640, 480), makeCamera('cam2', 640, 480)],
                makeSkeleton(),
                ['t']
            );
            var u = new Instance([[100,100]], 0, 'user', 1.0); u.modified = false;
            var p = new Instance([[200,200]], 0, 'predicted', 0.8); p.modified = false;
            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', u);
            group.addInstance('cam2', p);

            var promoted = session._promoteIfMixed(group);

            assertTrue(promoted === true, 'returns true (promotion fired)');
            assertEqual(p.type, 'user', 'predicted promoted to user');
            assertTrue(p.modified === true, 'modified flag set');
            assertFalse(u.modified, 'user untouched');
        });

        it('returns false and is a no-op for uniform groups', function () {
            var session = new Session(
                [makeCamera('cam1', 640, 480), makeCamera('cam2', 640, 480)],
                makeSkeleton(),
                ['t']
            );
            var p1 = new Instance([[100,100]], 0, 'predicted', 0.8); p1.modified = false;
            var p2 = new Instance([[200,200]], 0, 'predicted', 0.7); p2.modified = false;
            var group = new InstanceGroup(2, 0);
            group.addInstance('cam1', p1);
            group.addInstance('cam2', p2);

            var promoted = session._promoteIfMixed(group);

            assertFalse(promoted, 'returns false (no promotion)');
            assertEqual(p1.type, 'predicted', 'p1 still predicted');
            assertEqual(p2.type, 'predicted', 'p2 still predicted');
        });
    });

})();
