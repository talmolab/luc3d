/**
 * test-trackall-duplicates.js — Regression for the "duplicate identities
 * after Track All" bug.
 *
 * The bug: `reorderGroupsByPrevTargets` (pose/tracker.js) builds an n×n
 * cost matrix where n = max(nTargets, nGroups). When nGroups > nTargets,
 * padded rows (cost=1000) claim real group columns via the Hungarian
 * solution. Those columns land in `usedGroups`, so the leftover-append
 * loop skips them — the affected real groups are silently removed from
 * `reordered`. matchFrameInstances then iterates only the surviving
 * groups, so dropped groups' (cam, track) pairs never receive per-frame
 * overrides. The viewer's getIdentityForTrack falls back to the global
 * trackIdentityMap and returns a stale identity from an earlier frame.
 * Two distinct visible tracks at the same (frame, camera) can then
 * resolve to the same identity → visual color duplicate.
 *
 * These tests construct a minimal in-memory fixture (2 cams × 3 tracks ×
 * 4 frames) engineered so that a frame's reorder drops the group for a
 * track that already has a stale entry in `trackIdentityMap` from an
 * earlier frame. The duplicate invariant fails today; tests are expected
 * to FAIL until the sentinel fix from prompts/tracking-fixes/dup_id_fix.md
 * (or an equivalent) is applied.
 */
(function () {
    const { describe, it, assertEqual, assertTrue } = TestFramework;

    function makeCam(name, rvec, tvec) {
        return new Camera(
            name,
            [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            rvec, tvec, [640, 480]
        );
    }

    // Build a session whose tracker run hits the dropped-group condition.
    // 2 cameras, 3 logical animals (track indices 0, 1, 2).
    //   frame 0: tracks {0, 1}                — establish identities 0, 1
    //                                            and seed global track→id
    //   frame 1: tracks {0, 1, 2}             — first reorder, padded row
    //                                            drops track2 group
    //   frame 2: tracks {0, 2}                — track2 gets identity id_1
    //                                            via fallback
    //   frame 3: tracks {0, 1, 2}             — reorder drops track1
    //                                            group; track1 falls back
    //                                            to its frame-0 stale
    //                                            global id_1, colliding
    //                                            with track2's per-frame
    //                                            id_1.
    function buildFixture() {
        var cam1 = makeCam('c1', [0, 0, 0], [0, 0, 0]);
        var cam2 = makeCam('c2', [0, 0.3, 0], [20, 0, 0]);
        var posA = [10, 5, 50];   // track 0
        var posB = [-10, -5, 60]; // track 1
        var posC = [0, 15, 40];   // track 2
        var session = new Session([cam1, cam2], Skeleton.defaultMouse(), ['t0', 't1', 't2']);

        function addInst(fg, camName, cam, pos3d, trackIdx) {
            fg.addInstance(camName, new Instance([cam.project(pos3d)], trackIdx, 'predicted', 1));
        }

        var fg0 = new FrameGroup(0);
        addInst(fg0, 'c1', cam1, posA, 0);
        addInst(fg0, 'c1', cam1, posB, 1);
        addInst(fg0, 'c2', cam2, posA, 0);
        addInst(fg0, 'c2', cam2, posB, 1);
        session.addFrameGroup(fg0);

        var fg1 = new FrameGroup(1);
        addInst(fg1, 'c1', cam1, posA, 0);
        addInst(fg1, 'c1', cam1, posB, 1);
        addInst(fg1, 'c1', cam1, posC, 2);
        addInst(fg1, 'c2', cam2, posA, 0);
        addInst(fg1, 'c2', cam2, posB, 1);
        addInst(fg1, 'c2', cam2, posC, 2);
        session.addFrameGroup(fg1);

        var fg2 = new FrameGroup(2);
        addInst(fg2, 'c1', cam1, posA, 0);
        addInst(fg2, 'c1', cam1, posC, 2);
        addInst(fg2, 'c2', cam2, posA, 0);
        addInst(fg2, 'c2', cam2, posC, 2);
        session.addFrameGroup(fg2);

        var fg3 = new FrameGroup(3);
        addInst(fg3, 'c1', cam1, posA, 0);
        addInst(fg3, 'c1', cam1, posB, 1);
        addInst(fg3, 'c1', cam1, posC, 2);
        addInst(fg3, 'c2', cam2, posA, 0);
        addInst(fg3, 'c2', cam2, posB, 1);
        addInst(fg3, 'c2', cam2, posC, 2);
        session.addFrameGroup(fg3);

        return session;
    }

    // Mimic the body of pose/tracker.js#trackAll without the UI side-effects:
    // clears identity state, then runs matchFrameInstances frame-by-frame
    // with prevAssignments / prevTargets3d threaded through.
    function runTrackAllLike(session, numAnimals) {
        session.identities = [];
        session.trackIdentityMap = new Map();
        session.frameIdentityMap = new Map();
        var prevAssignments = null;
        var prevTargets3d = null;
        var frames = session.frameIndices;
        for (var i = 0; i < frames.length; i++) {
            var fi = frames[i];
            var fg = session.getFrameGroup(fi);
            if (!fg) continue;
            var result = matchFrameInstances(fg, session.cameras, session, {
                numAnimals: numAnimals,
                perFrame: true,
                prevAssignments: prevAssignments,
                prevTargets3d: prevTargets3d
            });
            if (result.assignments && result.assignments.size > 0) {
                prevAssignments = result.assignments;
            }
            if (result.targets3d && result.targets3d.length > 0) {
                prevTargets3d = result.targets3d;
            }
        }
    }

    // For each (frame, camera), bucket visible track indices by the
    // identity returned by session.getIdentityForTrack. A bucket with more
    // than one track is the duplicate.
    function findDuplicates(session) {
        var dups = [];
        var frames = session.frameIndices;
        for (var i = 0; i < frames.length; i++) {
            var fi = frames[i];
            var fg = session.getFrameGroup(fi);
            if (!fg) continue;
            for (var ci = 0; ci < session.cameras.length; ci++) {
                var camName = session.cameras[ci].name;
                var insts = fg.getInstances(camName) || [];
                var byId = new Map();
                for (var k = 0; k < insts.length; k++) {
                    var trackIdx = insts[k].trackIdx;
                    if (trackIdx == null) continue;
                    var ident = session.getIdentityForTrack(trackIdx, camName, fi);
                    if (!ident) continue;
                    var arr = byId.get(ident.id);
                    if (!arr) { arr = []; byId.set(ident.id, arr); }
                    arr.push(trackIdx);
                }
                var entries = Array.from(byId.entries());
                for (var e = 0; e < entries.length; e++) {
                    if (entries[e][1].length > 1) {
                        dups.push({ frame: fi, cam: camName, identityId: entries[e][0], tracks: entries[e][1] });
                    }
                }
            }
        }
        return dups;
    }

    describe('trackAll duplicate identities (regression)', function () {

        it('single trackAll run produces no duplicate identity colors', function () {
            if (typeof matchFrameInstances !== 'function') return;
            if (typeof Session === 'undefined') return;
            var session = buildFixture();
            runTrackAllLike(session, 2);

            // Identity count must equal the number of distinct animals.
            // Scout-agent's analysis confirms the bug doesn't grow this
            // count, but asserting it guards against a regression that
            // would (e.g., a project-scoped identity store writing
            // duplicates without dedup).
            assertEqual(session.identities.length, 2, 'identity count');

            // The user-visible invariant: at any (frame, camera), no two
            // distinct visible tracks may resolve to the same identity.
            var dups = findDuplicates(session);
            assertEqual(dups.length, 0,
                'duplicate identity colors at: ' + JSON.stringify(dups));
        });

        it('trackAll run twice in a row produces no duplicate identity colors', function () {
            if (typeof matchFrameInstances !== 'function') return;
            if (typeof Session === 'undefined') return;
            var session = buildFixture();
            runTrackAllLike(session, 2);
            // Run again. Production trackAll resets identity state on
            // each invocation, so the second run should produce the same
            // (correct) end state — neither duplicates nor extra
            // identities.
            runTrackAllLike(session, 2);

            assertEqual(session.identities.length, 2,
                'identity count must not grow across repeated trackAll runs');

            var dups = findDuplicates(session);
            assertEqual(dups.length, 0,
                'duplicate identity colors after repeated trackAll: ' + JSON.stringify(dups));
        });

    });
})();
