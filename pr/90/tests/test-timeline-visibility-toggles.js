/**
 * test-timeline-visibility-toggles.js — Block 2 (Prompt 4)
 *
 * Per-session Timeline visibility toggles for Views / Tracks / Identities.
 *
 * Block 2 of Prompt 4 adds a new "Timeline" subsection to the Info Panel →
 * Visibility tab containing three dynamic toggle lists:
 *   - Views        — one toggle per camera
 *   - Tracks       — one toggle per track
 *   - Identities   — one toggle per identity
 *
 * Toggling an entity OFF hides its rows in the timeline. State persists
 * per-session (NOT cross-session). Toggle precedence:
 *   Views > Tracks/Identities
 * That is — if a camera view is OFF, all of its tracks and identities are
 * hidden regardless of their individual toggle state.
 *
 * Camera header rows still survive when ALL tracks under that camera are
 * toggled off (Block 1's empty-camera placeholder behaviour); the camera
 * name is rendered in gray (a marker on the camera-group entry).
 *
 * --- Behaviour-level tests in this file --------------------------------
 *
 *   (V1) Toggle hides a track   — toggle off → track row disappears from
 *        the timeline; toggle on → row restored.
 *
 *   (V2) Toggle hides a view    — toggle off → entire camera tree
 *        (header row + all track rows) disappears from the timeline.
 *
 *   (V3) Toggle hides an ID     — toggle off → identity row disappears
 *        from the timeline in `identities` and `both` modes.
 *
 *   (V6) All-off camera group   — toggle off every track for camA; the
 *        camera header row remains, the group is marked isEmpty, AND
 *        carries a gray-font marker (`isAllHidden` / `isGray` / similar).
 *
 *   (V8) Precedence             — track A is toggled ON but its parent
 *        camera is toggled OFF; track A must still be hidden.
 *
 * Pre-implementation expectation: every assertion below FAILS because
 *   - `_hiddenCameras` / `_hiddenTracks` / `_hiddenIdentities` are not
 *     consulted by `_buildTrackSegments` / `_buildIdentitySegments`
 *   - There is no all-hidden / gray marker on `_cameraGroups[i]`
 *
 * These tests deliberately mutate the proposed `session._hidden*` sets
 * directly and then call `refreshTracks` — exercising the *rendering
 * filter contract* without depending on any specific API-module shape.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assert = TF.assert;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;
    var assertFalse = TF.assertFalse;
    var assertNotNull = TF.assertNotNull;
    var assertGreaterThan = TF.assertGreaterThan;

    // ----- Test helpers (mirror test-timeline-tree-grouping.js patterns) -----

    function createContainer(width, height) {
        var div = document.createElement('div');
        div.style.width = (width || 900) + 'px';
        div.style.height = (height || 320) + 'px';
        div.style.position = 'fixed';
        div.style.top = '-9999px';
        div.style.left = '0';
        document.body.appendChild(div);
        return div;
    }

    function cleanup(timeline, container) {
        if (timeline) timeline.destroy();
        if (container && container.parentNode) container.remove();
    }

    /**
     * Build a Session with `cameraNames` cameras and an explicit per-camera
     * track list. `cameraTracks[camName]` = number of tracks for that camera.
     * Mirrors the helper in test-timeline-tree-grouping.js so the fixture
     * shape is identical.
     */
    function buildSession(cameraNames, cameraTracks, uploadedCameras) {
        var skel = new Skeleton('s', ['a', 'b'], [[0, 1]]);
        var cams = [];
        for (var i = 0; i < cameraNames.length; i++) {
            cams.push(new Camera(cameraNames[i],
                [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0],
                [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0],
                [640, 480]));
        }
        var maxT = 0;
        for (var k in cameraTracks) {
            if (cameraTracks[k] > maxT) maxT = cameraTracks[k];
        }
        var trackNames = [];
        for (var t = 0; t < maxT; t++) trackNames.push('track_' + t);
        var session = new Session(cams, skel, trackNames);

        var frameSlot = 0;
        for (var ci = 0; ci < cameraNames.length; ci++) {
            var cName = cameraNames[ci];
            var nTracks = cameraTracks[cName] || 0;
            for (var ti = 0; ti < nTracks; ti++) {
                var inst = new Instance([[100, 100], [200, 200]], frameSlot, 'user', 1);
                inst.trackIdx = ti;
                var fg = session.getFrameGroup(frameSlot) || new FrameGroup(frameSlot);
                fg.addInstance(cName, inst);
                if (!session.getFrameGroup(frameSlot)) session.addFrameGroup(fg);
                frameSlot++;
            }
        }
        session._uploadedCameras = uploadedCameras
            ? uploadedCameras.slice()
            : cameraNames.slice();
        return session;
    }

    /**
     * Look up the row indices that correspond to a given (camName, trackName)
     * pair in the timeline. Empty-placeholder rows have `trackIdx === -1` and
     * are excluded.
     */
    function findRowsForTrack(tl, camName, trackName) {
        var rows = [];
        var segs = tl._trackSegments || [];
        for (var i = 0; i < segs.length; i++) {
            var s = segs[i];
            if (s.cameraName === camName && s.trackName === trackName &&
                s.treeRole !== 'empty') {
                rows.push(i);
            }
        }
        return rows;
    }

    function findRowsForCamera(tl, camName) {
        var rows = [];
        var segs = tl._trackSegments || [];
        for (var i = 0; i < segs.length; i++) {
            if (segs[i].cameraName === camName) rows.push(i);
        }
        return rows;
    }

    function findGroupForCamera(tl, camName) {
        var groups = tl.getCameraGroups ? tl.getCameraGroups() : (tl._cameraGroups || []);
        for (var i = 0; i < groups.length; i++) {
            var name = groups[i].name || groups[i].cameraName;
            if (name === camName) return groups[i];
        }
        return null;
    }

    // ============================================================
    //  (V1) Toggle hides a track
    // ============================================================
    describe('Timeline visibility toggles (Prompt 4 / Block 2) — track toggle', function () {

        it('(V1) toggling a track OFF removes its row; toggling ON restores it', function () {
            var container = createContainer(900, 320);
            var tl = new Timeline(container, { totalFrames: 50 });
            // 1 camera × 3 tracks → 3 track rows.
            var session = buildSession(['camA'], { camA: 3 }, ['camA']);
            tl.setData(session);

            // Sanity: track_1 starts visible.
            var preRows = findRowsForTrack(tl, 'camA', 'track_1');
            assertEqual(preRows.length, 1,
                'sanity: track_1 row should be present before any toggling; got ' +
                preRows.length + ' rows for camA / track_1');
            var preTotal = tl.getRowCount();

            // Toggle OFF — Block 2 reads from `session._hiddenTracks`.
            // Either a Set or an Array-with-includes is acceptable; we use Set.
            if (!session._hiddenTracks) session._hiddenTracks = new Set();
            session._hiddenTracks.add('track_1');

            tl.refreshTracks(session);

            var hiddenRows = findRowsForTrack(tl, 'camA', 'track_1');
            assertEqual(hiddenRows.length, 0,
                'after adding "track_1" to session._hiddenTracks, the track_1 ' +
                'row must NOT appear in _trackSegments; got ' + hiddenRows.length +
                ' rows still present');

            var hiddenTotal = tl.getRowCount();
            assertEqual(hiddenTotal, preTotal - 1,
                'total row count must drop by exactly 1 when one track is hidden; ' +
                'before=' + preTotal + ' after=' + hiddenTotal);

            // Toggle ON — remove from the set.
            session._hiddenTracks.delete('track_1');
            tl.refreshTracks(session);

            var restoredRows = findRowsForTrack(tl, 'camA', 'track_1');
            assertEqual(restoredRows.length, 1,
                'toggling track_1 back on must restore the row; got ' +
                restoredRows.length);
            assertEqual(tl.getRowCount(), preTotal,
                'row count must return to its pre-toggle value');

            cleanup(tl, container);
        });
    });

    // ============================================================
    //  (V2) Toggle hides a view (entire camera tree)
    // ============================================================
    describe('Timeline visibility toggles (Prompt 4 / Block 2) — view (camera) toggle', function () {

        it('(V2) toggling a camera view OFF removes the camera header AND all its track rows', function () {
            var container = createContainer(900, 360);
            var tl = new Timeline(container, { totalFrames: 80 });
            var session = buildSession(
                ['camA', 'camB'],
                { camA: 2, camB: 3 },
                ['camA', 'camB']
            );
            tl.setData(session);

            // Sanity: both cameras render rows before toggle.
            assertGreaterThan(findRowsForCamera(tl, 'camA').length, 0,
                'sanity: camA should have rows before hiding');
            assertGreaterThan(findRowsForCamera(tl, 'camB').length, 0,
                'sanity: camB should have rows before hiding');
            var groupsBefore = tl.getCameraGroups ? tl.getCameraGroups() : (tl._cameraGroups || []);
            assertEqual(groupsBefore.length, 2,
                'sanity: two camera groups before hiding');

            // Hide camB entirely.
            if (!session._hiddenCameras) session._hiddenCameras = new Set();
            session._hiddenCameras.add('camB');

            tl.refreshTracks(session);

            // camB must disappear COMPLETELY — header included. The
            // empty-camera placeholder is only for `_uploadedCameras` that
            // happen to have zero tracks; a fully hidden view leaves no
            // trace.
            var camBRowsAfter = findRowsForCamera(tl, 'camB');
            assertEqual(camBRowsAfter.length, 0,
                'after hiding camB, NO rows for camB may remain (header or ' +
                'tracks); got ' + camBRowsAfter.length);

            var groupsAfter = tl.getCameraGroups ? tl.getCameraGroups() : (tl._cameraGroups || []);
            assertEqual(groupsAfter.length, 1,
                'hidden camera must be removed from getCameraGroups(); got ' +
                groupsAfter.length + ' groups');

            var remainingName = groupsAfter[0] ? (groupsAfter[0].name || groupsAfter[0].cameraName) : null;
            assertEqual(remainingName, 'camA',
                'only camA should remain after hiding camB; got "' + remainingName + '"');

            // camA's rows must be untouched.
            assertEqual(findRowsForCamera(tl, 'camA').length, 2,
                'camA must still have its 2 track rows; got ' +
                findRowsForCamera(tl, 'camA').length);

            cleanup(tl, container);
        });
    });

    // ============================================================
    //  (V3) Toggle hides an identity
    // ============================================================
    describe('Timeline visibility toggles (Prompt 4 / Block 2) — identity toggle', function () {

        it('(V3) toggling an identity OFF removes its rows from `identities` mode', function () {
            var container = createContainer(900, 360);
            var tl = new Timeline(container, { totalFrames: 80 });
            // 2 cameras, 2 tracks each, mapped to 2 identities.
            var session = buildSession(
                ['camA', 'camB'],
                { camA: 2, camB: 2 },
                ['camA', 'camB']
            );
            session.addIdentity('id_alpha');
            session.addIdentity('id_beta');
            // Map both cameras' tracks to the same identity pair.
            session.trackIdentityMap.set('camA:0', session.identities[0].id);
            session.trackIdentityMap.set('camA:1', session.identities[1].id);
            session.trackIdentityMap.set('camB:0', session.identities[0].id);
            session.trackIdentityMap.set('camB:1', session.identities[1].id);

            tl.setData(session);
            tl.setDisplayMode('identities');

            // Count rows whose trackName matches the identity name (the
            // identity-build path stores `ident.name` into `trackName`).
            function countIdentityRows(name) {
                var n = 0;
                var segs = tl._trackSegments || [];
                for (var i = 0; i < segs.length; i++) {
                    if (segs[i].trackName === name && segs[i].treeRole !== 'empty') n++;
                }
                return n;
            }

            assertGreaterThan(countIdentityRows('id_beta'), 0,
                'sanity: id_beta should have at least one row in identities mode');
            var betaRowsBefore = countIdentityRows('id_beta');

            // Hide id_beta.
            if (!session._hiddenIdentities) session._hiddenIdentities = new Set();
            session._hiddenIdentities.add('id_beta');

            tl.refreshTracks(session);

            assertEqual(countIdentityRows('id_beta'), 0,
                'after hiding id_beta, NO id_beta rows should appear in ' +
                'identities mode; got ' + countIdentityRows('id_beta'));

            // id_alpha rows must be untouched.
            assertGreaterThan(countIdentityRows('id_alpha'), 0,
                'id_alpha rows must remain after hiding only id_beta');

            // `both` mode: still hides id_beta rows but keeps tracks.
            tl.setDisplayMode('both');
            assertEqual(countIdentityRows('id_beta'), 0,
                'identity-toggle hiding must also apply in `both` mode; got ' +
                countIdentityRows('id_beta') + ' id_beta rows in both mode');

            cleanup(tl, container);
        });
    });

    // ============================================================
    //  (V6) All-off camera group — header survives, marked gray
    // ============================================================
    describe('Timeline visibility toggles (Prompt 4 / Block 2) — all-off camera group', function () {

        it('(V6) when every track in a camera is hidden, the camera header row remains as a placeholder marked gray/all-hidden', function () {
            var container = createContainer(900, 320);
            var tl = new Timeline(container, { totalFrames: 60 });
            var session = buildSession(['camA'], { camA: 3 }, ['camA']);
            tl.setData(session);

            // Hide every track in camA.
            if (!session._hiddenTracks) session._hiddenTracks = new Set();
            session._hiddenTracks.add('track_0');
            session._hiddenTracks.add('track_1');
            session._hiddenTracks.add('track_2');

            tl.refreshTracks(session);

            // The camera group must still exist (Block 1's empty-camera
            // placeholder behaviour is preserved when ALL the camera's
            // tracks are hidden — the user can still see which view they
            // have toggled tracks off for).
            var group = findGroupForCamera(tl, 'camA');
            assertNotNull(group,
                'camA group must still be present in getCameraGroups() ' +
                'after all its tracks are hidden — Block 2 must keep the ' +
                'header as an empty-camera placeholder');

            // The group must register as empty (zero real tracks).
            var trackCount = (group.tracks || []).length;
            assertEqual(trackCount, 0,
                'all-hidden camera group must have zero real tracks; got ' + trackCount);
            assertTrue(!!group.isEmpty,
                'group.isEmpty must be true when all the camera\'s tracks are hidden');

            // Block 2 spec: render the camera name in GRAY when all its
            // tracks are hidden. Accept any of the plausible marker names
            // — the implementation may pick whichever fits its draw path.
            var isGrayFromGroup = !!(group.isAllHidden || group.isGray ||
                                     group.allTracksHidden || group.grayed);
            // Allow the marker to live on the segment row instead.
            var placeholderRow = null;
            var segs = tl._trackSegments || [];
            for (var i = 0; i < segs.length; i++) {
                if (segs[i].cameraName === 'camA' && segs[i].treeRole === 'empty') {
                    placeholderRow = segs[i];
                    break;
                }
            }
            var isGrayFromRow = !!(placeholderRow && (placeholderRow.isAllHidden ||
                placeholderRow.isGray || placeholderRow.grayed));

            assertTrue(isGrayFromGroup || isGrayFromRow,
                'Block 2 must set a gray-font / all-hidden marker on either ' +
                'the camera group or its empty placeholder row when every ' +
                'track is toggled off. Searched for: group.isAllHidden, ' +
                'group.isGray, group.allTracksHidden, group.grayed (and same ' +
                'on the placeholder row). group=' + JSON.stringify({
                    name: group.name, isEmpty: group.isEmpty,
                    isAllHidden: group.isAllHidden, isGray: group.isGray,
                }) + ' placeholderRow.treeRole=' +
                (placeholderRow ? placeholderRow.treeRole : 'NONE'));

            // And the gutter must still show "camA".
            var labels = (tl.getLabelLines ? tl.getLabelLines() : (tl._trackNames || [])).join('\n');
            assertTrue(labels.indexOf('camA') >= 0,
                'camA must still appear in the label gutter after all-hidden; got:\n' + labels);

            cleanup(tl, container);
        });
    });

    // ============================================================
    //  (V8) Precedence — view OFF beats track ON
    // ============================================================
    describe('Timeline visibility toggles (Prompt 4 / Block 2) — precedence', function () {

        it('(V8) track A toggled ON but its parent camera toggled OFF → track A is still hidden', function () {
            var container = createContainer(900, 320);
            var tl = new Timeline(container, { totalFrames: 60 });
            var session = buildSession(['camA', 'camB'], { camA: 2, camB: 2 }, ['camA', 'camB']);
            tl.setData(session);

            // Sanity: track_0 appears under both camA and camB.
            assertEqual(findRowsForTrack(tl, 'camA', 'track_0').length, 1,
                'sanity: camA/track_0 row should be present before any toggle');
            assertEqual(findRowsForTrack(tl, 'camB', 'track_0').length, 1,
                'sanity: camB/track_0 row should be present before any toggle');

            // Hide camB (the parent view) — track_0 is NOT in _hiddenTracks
            // (i.e., the track-level toggle says "on"). Precedence rule:
            // view-off beats track-on, so camB/track_0 must still vanish.
            if (!session._hiddenCameras) session._hiddenCameras = new Set();
            session._hiddenCameras.add('camB');
            // Track-level set is empty: track_0 is explicitly "on".
            session._hiddenTracks = new Set();

            tl.refreshTracks(session);

            assertEqual(findRowsForTrack(tl, 'camB', 'track_0').length, 0,
                'precedence: camB hidden at view-level must hide camB/track_0 ' +
                'even though track_0 is NOT in _hiddenTracks. got ' +
                findRowsForTrack(tl, 'camB', 'track_0').length + ' camB/track_0 rows');

            // camA/track_0 must still be visible — only camB is hidden.
            assertEqual(findRowsForTrack(tl, 'camA', 'track_0').length, 1,
                'precedence rule must not affect camA/track_0; got ' +
                findRowsForTrack(tl, 'camA', 'track_0').length);

            cleanup(tl, container);
        });
    });
})();
