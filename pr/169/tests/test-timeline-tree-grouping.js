/**
 * test-timeline-tree-grouping.js — Block 1, subfeature 1.1 (Prompt 4)
 *
 * Tree-grouped camera/track labels for the Timeline.
 *
 * Per Block 1 of Prompt 4, the Timeline label gutter must replace the flat
 * `camA / track_0`, `camA / track_1`, … rows with a per-camera tree:
 *
 *        ┌─ track_0
 *   camA ├─ track_1
 *        │   ...
 *        └─ track_n
 *
 * Requirements covered by this file:
 *
 *   (T1) Tree rendering — cameras with 0, 1, and 5+ tracks render correctly
 *        using the tree connector characters `┌─`, `├─`, `│`, `└─`.
 *
 *   (T2) Tree rendering — 1, 2, and 5+ cameras stack correctly, with a
 *        distinct tree block per camera.
 *
 *   (T3) Filter to uploaded videos — a camera that exists in calibration
 *        (`session.cameras`) but has no uploaded video must NOT appear.
 *
 *   (T4) Empty camera row — a camera with 0 tracks occupies the same
 *        height as a single track row (a placeholder row is reserved).
 *
 *   (T5) Dynamic add / remove — adding a track to a previously-empty
 *        camera collapses the empty placeholder; removing the last track
 *        restores it.
 *
 *   (T6) Mode consistency — tree grouping is identical across `tracks`,
 *        `identities`, and `both` modes.
 *
 * Pre-implementation expectation: every assertion below FAILS because the
 * tree-grouping API (`getCameraGroups()`/equivalent) and tree-connector
 * label rendering do not yet exist. The current implementation produces
 * flat `cam / track_N` labels via `this._trackNames.push(camName + ' / ' + trackName)`
 * (timeline.js line ~750), and there is no per-camera row data structure.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var beforeEach = TF.beforeEach;
    var assert = TF.assert;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;
    var assertFalse = TF.assertFalse;
    var assertNotNull = TF.assertNotNull;
    var assertGreaterThan = TF.assertGreaterThan;

    // ----- Test helpers ----------------------------------------------------

    function createContainer(width, height) {
        var div = document.createElement('div');
        div.style.width = (width || 800) + 'px';
        div.style.height = (height || 240) + 'px';
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
     * Build a session with `cameraNames` cameras and an explicit per-camera
     * track list. `cameraTracks[camName]` = number of tracks for that camera
     * that should appear in `session.frameGroups` (and hence in the timeline).
     * Cameras with 0 entries have NO instances in any frame.
     *
     * `uploadedCameras` (optional) — array of camera names that should be
     * present in `state.videoFiles`-style mapping. Stored on session as
     * `session._uploadedCameras` so Block 1 implementation can filter on it
     * without depending on the global app state object.
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
        // Track names = union across cameras.
        var maxT = 0;
        for (var k in cameraTracks) {
            if (cameraTracks[k] > maxT) maxT = cameraTracks[k];
        }
        var trackNames = [];
        for (var t = 0; t < maxT; t++) trackNames.push('track_' + t);
        var session = new Session(cams, skel, trackNames);

        // Populate frameGroups: each camera gets `cameraTracks[name]` distinct
        // track indices, one frame per track to register a segment.
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
        // Block-1 expectation: caller annotates the session (or the global
        // state) with the set of uploaded videos so the timeline can filter
        // out calibration-only cameras. We stash it on the session itself so
        // the test does not need to mutate global state.
        session._uploadedCameras = uploadedCameras
            ? uploadedCameras.slice()
            : cameraNames.slice();

        return session;
    }

    /**
     * Extract the label-gutter text from the timeline. Block 1 may render
     * tree labels via either:
     *   (a) `timeline._trackNames` strings containing tree connectors, or
     *   (b) a `timeline.getLabelLines()` / `timeline.getCameraGroups()` API.
     * We accept either: collect everything plausible into a single array of
     * strings (one per row) and let assertions match against the contents.
     */
    function getLabelLines(tl) {
        if (typeof tl.getLabelLines === 'function') {
            return tl.getLabelLines();
        }
        // Fall back to the existing private array used by the canvas
        // drawing path. Block 1 must populate this with tree-decorated
        // strings (or expose an alternative).
        if (Array.isArray(tl._trackNames)) return tl._trackNames.slice();
        return [];
    }

    /**
     * Block 1 must expose a camera-grouped row structure. Accept either an
     * explicit getter (preferred) or derive it from the existing
     * `_trackSegments` field combined with a per-row placeholder marker. If
     * neither is present, return `null` so the assertion can report a
     * useful failure.
     */
    function getCameraGroups(tl) {
        if (typeof tl.getCameraGroups === 'function') return tl.getCameraGroups();
        if (Array.isArray(tl._cameraGroups)) return tl._cameraGroups.slice();
        return null;
    }

    /**
     * Count the number of rendered rows (camera + tracks) the timeline
     * reserves vertical space for. Block 1 must include 1 placeholder row
     * for cameras with 0 tracks.
     */
    function countRows(tl) {
        // Prefer an explicit `getRowCount()` if Block 1 exposes one.
        if (typeof tl.getRowCount === 'function') return tl.getRowCount();
        // Otherwise count entries in either of the plausible row arrays.
        var groups = getCameraGroups(tl);
        if (groups) {
            var total = 0;
            for (var i = 0; i < groups.length; i++) {
                var trackCount = (groups[i].tracks || []).length;
                total += Math.max(1, trackCount); // empty camera = 1 placeholder row
            }
            return total;
        }
        return (tl._trackSegments || []).length;
    }

    // ----- (T1) Tree connector characters ---------------------------------

    describe('Timeline tree grouping (Prompt 4 / Block 1) — connector characters', function () {

        it('renders tree connectors `┌─`, `├─`, `└─`, `│` for a camera with 5 tracks', function () {
            var container = createContainer(900, 320);
            var tl = new Timeline(container, { totalFrames: 50 });
            tl.setData(buildSession(
                ['camA'],
                { camA: 5 },
                ['camA']
            ));

            var labels = getLabelLines(tl).join('\n');

            assertTrue(labels.indexOf('camA') >= 0,
                'expected the camera name "camA" to appear in label gutter; got:\n' + labels);
            assertTrue(labels.indexOf('┌─') >= 0,
                'expected top connector "┌─" for first track of camA; got:\n' + labels);
            assertTrue(labels.indexOf('├─') >= 0,
                'expected mid connector "├─" for interior tracks of camA; got:\n' + labels);
            assertTrue(labels.indexOf('└─') >= 0,
                'expected bottom connector "└─" for last track of camA; got:\n' + labels);

            cleanup(tl, container);
        });

        it('renders a single `└─` (or single-row inline tree) for a camera with exactly 1 track', function () {
            var container = createContainer(900, 200);
            var tl = new Timeline(container, { totalFrames: 50 });
            tl.setData(buildSession(
                ['camA'],
                { camA: 1 },
                ['camA']
            ));

            var labels = getLabelLines(tl).join('\n');
            assertTrue(labels.indexOf('camA') >= 0,
                'expected "camA" in label gutter; got:\n' + labels);
            // Single-track camera should either render a single bottom
            // connector or an inline `camA -- track_0` style row. Either
            // way, it must NOT contain a `├─` (mid) connector because
            // there is no second track. And it should still differ from
            // the legacy flat `camA / track_0` format.
            assertFalse(/├─/.test(labels),
                'a single-track camera must not show a mid connector (├─); got:\n' + labels);
            assertFalse(/camA\s*\/\s*track_0/.test(labels),
                'single-track row must not use the legacy flat "camA / track_0" format; got:\n' + labels);

            cleanup(tl, container);
        });

        it('reserves a placeholder row for a camera with 0 tracks (camera name only)', function () {
            var container = createContainer(900, 200);
            var tl = new Timeline(container, { totalFrames: 50 });
            // camA has 0 tracks. We still expect a row showing just "camA".
            tl.setData(buildSession(
                ['camA', 'camB'],
                { camA: 0, camB: 2 },
                ['camA', 'camB']
            ));

            var labels = getLabelLines(tl);
            var joined = labels.join('\n');
            assertTrue(joined.indexOf('camA') >= 0,
                'empty camera "camA" must still appear in label gutter; got:\n' + joined);
            assertTrue(joined.indexOf('camB') >= 0,
                'populated camera "camB" must appear in label gutter; got:\n' + joined);

            // Block 1 must reserve a row for the empty camera, distinct
            // from camB's two rows.
            var rows = countRows(tl);
            assertGreaterThan(rows, 2,
                'empty-camera placeholder must add a row beyond camB tracks; got rows=' + rows);

            cleanup(tl, container);
        });
    });

    // ----- (T2) Multi-camera stacking -------------------------------------

    describe('Timeline tree grouping (Prompt 4 / Block 1) — camera stacking', function () {

        it('renders a single tree block for 1 camera', function () {
            var container = createContainer(900, 320);
            var tl = new Timeline(container, { totalFrames: 50 });
            tl.setData(buildSession(['camA'], { camA: 3 }, ['camA']));

            var groups = getCameraGroups(tl);
            assertNotNull(groups,
                'Block 1 must expose a camera-grouped structure via ' +
                'getCameraGroups() or _cameraGroups');
            assertEqual(groups.length, 1, 'one tree block for one camera');
            assertEqual(groups[0].name || groups[0].cameraName, 'camA',
                'group name must match camera');

            cleanup(tl, container);
        });

        it('renders two distinct tree blocks for 2 cameras', function () {
            var container = createContainer(900, 320);
            var tl = new Timeline(container, { totalFrames: 50 });
            tl.setData(buildSession(
                ['camA', 'camB'],
                { camA: 2, camB: 3 },
                ['camA', 'camB']
            ));

            var groups = getCameraGroups(tl);
            assertNotNull(groups, 'must expose camera groups');
            assertEqual(groups.length, 2, 'two cameras → two tree blocks');

            // Both cameras must appear in order in the label gutter.
            var labels = getLabelLines(tl).join('\n');
            var posA = labels.indexOf('camA');
            var posB = labels.indexOf('camB');
            assertTrue(posA >= 0 && posB >= 0,
                'both camera names must appear; got:\n' + labels);
            assertTrue(posA < posB,
                'cameras stack in declaration order: camA above camB');

            cleanup(tl, container);
        });

        it('renders 5 distinct tree blocks for 5 cameras', function () {
            var container = createContainer(900, 600);
            var tl = new Timeline(container, { totalFrames: 100 });
            var names = ['cam0', 'cam1', 'cam2', 'cam3', 'cam4'];
            var tracksByCam = { cam0: 1, cam1: 2, cam2: 3, cam3: 4, cam4: 5 };
            tl.setData(buildSession(names, tracksByCam, names));

            var groups = getCameraGroups(tl);
            assertNotNull(groups, 'must expose camera groups');
            assertEqual(groups.length, 5, '5 cameras → 5 tree blocks');

            // Track count per camera must match the input.
            for (var i = 0; i < names.length; i++) {
                var g = groups[i];
                var nameOk = (g.name === names[i] || g.cameraName === names[i]);
                assertTrue(nameOk,
                    'group[' + i + '] must be camera "' + names[i] +
                    '"; got ' + (g.name || g.cameraName));
                var nTracks = (g.tracks || []).length;
                assertEqual(nTracks, tracksByCam[names[i]],
                    'camera "' + names[i] + '" should have ' +
                    tracksByCam[names[i]] + ' tracks; got ' + nTracks);
            }

            cleanup(tl, container);
        });
    });

    // ----- (T3) Filter to uploaded videos ---------------------------------

    describe('Timeline tree grouping (Prompt 4 / Block 1) — uploaded-video filter', function () {

        it('cameras in calibration without an uploaded video do NOT appear in the timeline', function () {
            var container = createContainer(900, 320);
            var tl = new Timeline(container, { totalFrames: 50 });
            // camA AND camB are in session.cameras (calibration), but only
            // camA has an uploaded video.
            var session = buildSession(
                ['camA', 'camB'],
                { camA: 2, camB: 2 }, // both have instance data
                ['camA']              // only camA is "uploaded"
            );
            tl.setData(session);

            var groups = getCameraGroups(tl);
            assertNotNull(groups,
                'Block 1 must expose camera groups (got null — getCameraGroups missing)');
            assertEqual(groups.length, 1,
                'only the uploaded camera should be a tree block; got ' +
                groups.length);

            var name = groups[0].name || groups[0].cameraName;
            assertEqual(name, 'camA',
                'the only tree block should be camA (camB lacks an uploaded video); got ' + name);

            var labels = getLabelLines(tl).join('\n');
            assertFalse(labels.indexOf('camB') >= 0,
                'camB must NOT appear in the label gutter (no uploaded video); got:\n' + labels);

            cleanup(tl, container);
        });
    });

    // ----- (T4) Empty camera placeholder row height -----------------------

    describe('Timeline tree grouping (Prompt 4 / Block 1) — empty-camera row height', function () {

        it('a camera with 0 tracks reserves a single track-row of vertical space', function () {
            var container = createContainer(900, 320);
            var tl = new Timeline(container, { totalFrames: 50 });
            // Pure empty-camera session: one camera, no tracks.
            tl.setData(buildSession(['camA'], { camA: 0 }, ['camA']));

            // Compare preferred height vs a known-good baseline:
            // a 1-camera, 1-track session.
            var baseTl = new Timeline(createContainer(900, 320), { totalFrames: 50 });
            baseTl.setData(buildSession(['camA'], { camA: 1 }, ['camA']));

            var emptyPref = tl.getPreferredHeight();
            var basePref = baseTl.getPreferredHeight();

            assertEqual(emptyPref, basePref,
                'empty camera must reserve the same preferred height as a ' +
                '1-track camera (placeholder row). empty=' + emptyPref +
                ' base=' + basePref);

            // Cleanup: baseTl's container was created inline.
            var baseContainer = baseTl._container;
            baseTl.destroy();
            if (baseContainer && baseContainer.parentNode) baseContainer.remove();
            cleanup(tl, container);
        });
    });

    // ----- (T5) Dynamic add / remove --------------------------------------

    describe('Timeline tree grouping (Prompt 4 / Block 1) — dynamic add/remove', function () {

        it('adding a track to an empty camera collapses the placeholder; removing the last track restores it', function () {
            var container = createContainer(900, 320);
            var tl = new Timeline(container, { totalFrames: 50 });

            // Start with empty camA + populated camB.
            var session = buildSession(
                ['camA', 'camB'],
                { camA: 0, camB: 2 },
                ['camA', 'camB']
            );
            tl.setData(session);

            var rowsEmpty = countRows(tl);
            assertGreaterThan(rowsEmpty, 2,
                'empty camera should add a placeholder row beyond camB tracks');

            // Add a track to camA: a single instance at a new frame.
            var inst = new Instance([[10, 10], [20, 20]], 99, 'user', 1);
            inst.trackIdx = 0;
            var fg = session.getFrameGroup(99) || new FrameGroup(99);
            fg.addInstance('camA', inst);
            if (!session.getFrameGroup(99)) session.addFrameGroup(fg);

            // Refresh — Block 1 must collapse the placeholder.
            tl.refreshTracks(session);
            var rowsAfterAdd = countRows(tl);
            assertEqual(rowsAfterAdd, rowsEmpty,
                'adding the first track to camA must replace the placeholder ' +
                'row with a real track row — net row count is unchanged. before=' +
                rowsEmpty + ' after=' + rowsAfterAdd);

            // Remove that track (clear camA from all frames).
            for (var f = 0; f < session.frameGroups.size + 10; f++) {
                var fgf = session.getFrameGroup(f);
                if (!fgf) continue;
                // Remove all camA instances by replacing the per-camera list.
                if (fgf.instances && fgf.instances.has && fgf.instances.has('camA')) {
                    fgf.instances.set('camA', []);
                }
            }

            tl.refreshTracks(session);
            var rowsAfterRemove = countRows(tl);
            assertEqual(rowsAfterRemove, rowsEmpty,
                'removing the last track from camA must restore the placeholder ' +
                'row — net row count returns to the empty-camera count. ' +
                'expected=' + rowsEmpty + ' got=' + rowsAfterRemove);

            cleanup(tl, container);
        });
    });

    // ----- (T6) Mode consistency ------------------------------------------

    describe('Timeline tree grouping (Prompt 4 / Block 1) — mode consistency', function () {

        it('camera-tree grouping is identical across `tracks`, `identities`, and `both` modes', function () {
            var container = createContainer(900, 320);
            var tl = new Timeline(container, { totalFrames: 50 });
            var session = buildSession(
                ['camA', 'camB'],
                { camA: 2, camB: 3 },
                ['camA', 'camB']
            );
            // Block 1 keeps cameras grouped even when "color by identity" is on,
            // so we must add at least one identity so 'identities' mode renders.
            session.addIdentity('id_0');
            session.addIdentity('id_1');
            session.assignTrackToIdentity(0, session.identities[0].id, 'camA');
            session.assignTrackToIdentity(1, session.identities[1].id, 'camA');
            session.assignTrackToIdentity(0, session.identities[0].id, 'camB');
            session.assignTrackToIdentity(1, session.identities[1].id, 'camB');
            session.assignTrackToIdentity(2, session.identities[0].id, 'camB');

            tl.setData(session);

            function snapshotCameras(timeline) {
                var groups = getCameraGroups(timeline);
                if (!groups) return null;
                return groups.map(function (g) {
                    return g.name || g.cameraName;
                });
            }

            tl.setDisplayMode('tracks');
            var tracksOrder = snapshotCameras(tl);
            assertNotNull(tracksOrder,
                'tree groups must be exposed in `tracks` mode');

            tl.setDisplayMode('identities');
            var idsOrder = snapshotCameras(tl);
            assertNotNull(idsOrder,
                'tree groups must be exposed in `identities` mode');

            tl.setDisplayMode('both');
            var bothOrder = snapshotCameras(tl);
            assertNotNull(bothOrder,
                'tree groups must be exposed in `both` mode');

            assertEqual(JSON.stringify(idsOrder), JSON.stringify(tracksOrder),
                'camera grouping must match between `tracks` and `identities` ' +
                'modes; tracks=' + JSON.stringify(tracksOrder) +
                ' identities=' + JSON.stringify(idsOrder));
            assertEqual(JSON.stringify(bothOrder), JSON.stringify(tracksOrder),
                'camera grouping must match between `tracks` and `both` modes; ' +
                'tracks=' + JSON.stringify(tracksOrder) +
                ' both=' + JSON.stringify(bothOrder));

            cleanup(tl, container);
        });
    });
})();
