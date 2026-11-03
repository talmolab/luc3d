/**
 * test-identity-none-label.js — Reprojection sub-row track-name fallback.
 *
 * Tests the label expression for the reprojected sub-row in the Linked
 * Instances table at `index.html:9125`:
 *
 *   reprojTrackName = (group.identityId >= 0
 *                      && state.session.tracks[group.identityId])
 *                     || ('Group ' + i);
 *
 * Two things matter here:
 *   (1) The right-hand fallback only fires when the left-hand track-name
 *       lookup is falsy. A previous bug had the fallback reference an
 *       undeclared `gi` instead of the loop variable `i`, so any group
 *       whose identity was "none" (`identityId === -1`) crashed
 *       `updateFrameInfo` with `ReferenceError: gi is not defined`.
 *   (2) The fallback must be a positional label tied to the enclosing
 *       `for (let i = 0; ...)` loop, not anything else.
 *
 * The production code is in `index.html`'s inline script (not directly
 * importable), so we mirror the line as a small helper and exercise
 * every branch — same pattern used by other regression tests in this
 * repo.
 */

(function () {
    var describe   = TestFramework.describe;
    var it         = TestFramework.it;
    var assertEqual    = TestFramework.assertEqual;
    var assertTrue     = TestFramework.assertTrue;
    var assertFalse    = TestFramework.assertFalse;
    var assertNotNull  = TestFramework.assertNotNull;

    /**
     * Mirror of the fixed line at index.html:9125.
     * `i` is the enclosing for-loop index in the production code.
     */
    function reprojTrackNameFor(group, session, i) {
        return (group.identityId >= 0 && session.tracks[group.identityId]) || ('Group ' + i);
    }

    function buildSession(tracks) {
        var skeleton = new Skeleton('mouse', ['nose', 'head'], [[0, 1]]);
        var cameras = [
            new Camera('cam1', [[600,0,320],[0,600,240],[0,0,1]],
                [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            new Camera('cam2', [[600,0,320],[0,600,240],[0,0,1]],
                [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
        ];
        return new Session(cameras, skeleton, tracks);
    }

    // The InstanceGroup constructor is `(id, identityId)`. Each group
    // gets a fresh unique `id`; `identityId` is the value under test.
    var _gid = 0;
    function buildGroupWithIdentity(identityId) {
        var group = new InstanceGroup(_gid++, identityId);
        var inst1 = new Instance([[100,100],[150,150]], 0, 'user', 1.0);
        var inst2 = new Instance([[200,200],[250,250]], 0, 'user', 1.0);
        group.addInstance('cam1', inst1);
        group.addInstance('cam2', inst2);
        return group;
    }

    // ================================================================
    // Suite 1 — Identity-less group must not crash
    // ================================================================

    describe('Reprojection sub-row label — identity-less group fallback', function () {

        it('does not throw ReferenceError when identityId is -1', function () {
            var session = buildSession(['track_0', 'track_1']);
            var group = buildGroupWithIdentity(-1);

            // Pre-fix this would throw: gi is not defined.
            var label;
            var threw = false;
            try {
                label = reprojTrackNameFor(group, session, 0);
            } catch (e) {
                threw = true;
            }
            assertFalse(threw, 'must not throw — fixed line uses lexical loop index');
            assertEqual(label, 'Group 0', 'falls back to positional label');
        });

        it('uses the loop index as the positional label', function () {
            var session = buildSession(['track_0']);
            var group = buildGroupWithIdentity(-1);

            assertEqual(reprojTrackNameFor(group, session, 0), 'Group 0');
            assertEqual(reprojTrackNameFor(group, session, 1), 'Group 1');
            assertEqual(reprojTrackNameFor(group, session, 7), 'Group 7');
        });
    });

    // ================================================================
    // Suite 2 — Track-name resolution and short-circuit branches
    // ================================================================

    describe('Reprojection sub-row label — track-name resolution', function () {

        it('returns the track name when identityId resolves to a real track', function () {
            var session = buildSession(['mouse_a', 'mouse_b', 'mouse_c']);

            assertEqual(reprojTrackNameFor(buildGroupWithIdentity(0), session, 99), 'mouse_a');
            assertEqual(reprojTrackNameFor(buildGroupWithIdentity(1), session, 99), 'mouse_b');
            assertEqual(reprojTrackNameFor(buildGroupWithIdentity(2), session, 99), 'mouse_c');
        });

        it('handles identityId === 0 (boundary: falsy index but >= 0)', function () {
            // `0 && tracks[0]` must proceed to the lookup, not short-circuit
            // on the falsy index value itself.
            var session = buildSession(['first_identity']);
            var group = buildGroupWithIdentity(0);

            assertEqual(reprojTrackNameFor(group, session, 5), 'first_identity',
                'identityId=0 must produce the track name, not "Group 5"');
        });

        it('falls back when the track name at that index is empty string', function () {
            var session = buildSession(['', 'has_name']);

            assertEqual(reprojTrackNameFor(buildGroupWithIdentity(0), session, 3),
                'Group 3', 'empty track name falls through');
            assertEqual(reprojTrackNameFor(buildGroupWithIdentity(1), session, 3),
                'has_name', 'non-empty track name wins');
        });

        it('falls back when identityId points past the end of tracks', function () {
            var session = buildSession(['only_one']);
            var group = buildGroupWithIdentity(7); // out of range

            // tracks[7] is undefined → second conjunct is falsy → fall through
            assertEqual(reprojTrackNameFor(group, session, 2), 'Group 2');
        });

        it('falls back for any negative identityId, not just -1', function () {
            var session = buildSession(['track_0']);

            assertEqual(reprojTrackNameFor(buildGroupWithIdentity(-1), session, 4), 'Group 4');
            assertEqual(reprojTrackNameFor(buildGroupWithIdentity(-2), session, 4), 'Group 4');
        });
    });

    // ================================================================
    // Suite 3 — Loop-index visibility from inside the conditional body
    // ================================================================

    describe('Reprojection sub-row label — loop index in scope', function () {

        it('lexical `i` is reachable inside the nested `if` body', function () {
            // Mirror of the production loop structure. `let i` block-scopes
            // to the entire `for` body, so it must resolve correctly inside
            // the nested `if (group.reprojectedInstances && ...)` block
            // where line 9125 lives.
            var labels = [];
            var groups = [
                buildGroupWithIdentity(-1),
                buildGroupWithIdentity(-1),
                buildGroupWithIdentity(-1),
            ];
            var session = buildSession(['t']);

            for (let i = 0; i < groups.length; i++) {
                var group = groups[i];
                if (true /* group.reprojectedInstances && size > 0 */) {
                    labels.push(reprojTrackNameFor(group, session, i));
                }
            }

            assertEqual(labels.length, 3);
            assertEqual(labels[0], 'Group 0');
            assertEqual(labels[1], 'Group 1');
            assertEqual(labels[2], 'Group 2');
        });
    });

})();
