/**
 * test-timeline-visibility-state.js — Block 2 (Prompt 4)
 *
 * State-persistence concerns for the Timeline visibility toggles.
 *
 * Block 2 spec:
 *   - Hidden state lives on the SESSION (per-session, NOT cross-session) so
 *     switching the timeline display mode (Tracks ↔ IDs ↔ Both) MUST NOT
 *     reset the toggles.
 *   - Each session carries its own `_hiddenCameras`, `_hiddenTracks`,
 *     `_hiddenIdentities` Sets.
 *   - Loading a different session uses that session's own (possibly empty)
 *     hidden sets — toggles do not leak between sessions.
 *
 * Tests in this file:
 *
 *   (V7)  Mode-switch persistence — toggle off track A in `Tracks` mode;
 *         switch to `IDs` then back to `Tracks`; track A is still toggled
 *         off and still hidden.
 *
 *   (V7b) Session-switch isolation — set up two sessions with different
 *         `_hiddenTracks` Sets; setData(session2) then refreshTracks must
 *         honour session2's set, not session1's.
 *
 * Pre-implementation expectation: the hidden-set fields aren't read by
 * the timeline yet, so the row-count assertions fail.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;
    var assertNotNull = TF.assertNotNull;
    var assertGreaterThan = TF.assertGreaterThan;

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

    function countRowsForTrack(tl, camName, trackName) {
        var n = 0;
        var segs = tl._trackSegments || [];
        for (var i = 0; i < segs.length; i++) {
            var s = segs[i];
            if (s.cameraName === camName && s.trackName === trackName &&
                s.treeRole !== 'empty') n++;
        }
        return n;
    }

    // ============================================================
    //  (V7) Persistence across Tracks ↔ IDs ↔ Tracks
    // ============================================================
    describe('Timeline visibility toggles (Prompt 4 / Block 2) — mode-switch persistence', function () {

        it('(V7) hidden tracks remain hidden after a Tracks → IDs → Tracks display-mode round-trip', function () {
            var container = createContainer(900, 360);
            var tl = new Timeline(container, { totalFrames: 80 });
            // Need at least one identity so `identities` mode is non-trivial.
            var session = buildSession(['camA'], { camA: 3 }, ['camA']);
            session.addIdentity('id_alpha');
            session.assignTrackToIdentity(0, session.identities[0].id, 'camA');
            session.assignTrackToIdentity(1, session.identities[0].id, 'camA');
            session.assignTrackToIdentity(2, session.identities[0].id, 'camA');

            tl.setData(session);
            assertEqual(tl._displayMode, 'tracks',
                'sanity: timeline must start in `tracks` mode');

            // Hide track_1 in tracks mode.
            session._hiddenTracks = new Set();
            session._hiddenTracks.add('track_1');
            tl.refreshTracks(session);

            assertEqual(countRowsForTrack(tl, 'camA', 'track_1'), 0,
                'sanity: track_1 must be hidden after toggling it off');

            // Switch to identities mode — the hidden-tracks set is for
            // tracks specifically, so identity rows are unaffected. The
            // important property: switching modes MUST NOT clear
            // `session._hiddenTracks`.
            tl.setDisplayMode('identities');
            assertTrue(session._hiddenTracks && session._hiddenTracks.has('track_1'),
                'switching to identities mode must NOT clear session._hiddenTracks');

            // Switch back to tracks mode — track_1 must still be hidden.
            tl.setDisplayMode('tracks');
            assertEqual(countRowsForTrack(tl, 'camA', 'track_1'), 0,
                'after Tracks → IDs → Tracks, track_1 must still be hidden ' +
                '(state persists per-session across mode switches). got ' +
                countRowsForTrack(tl, 'camA', 'track_1') + ' track_1 rows');

            // Sanity: untouched tracks must come back.
            assertEqual(countRowsForTrack(tl, 'camA', 'track_0'), 1,
                'track_0 (never toggled) must still appear');
            assertEqual(countRowsForTrack(tl, 'camA', 'track_2'), 1,
                'track_2 (never toggled) must still appear');

            cleanup(tl, container);
        });
    });

    // ============================================================
    //  (V7b) Per-session isolation — switching sessions
    // ============================================================
    describe('Timeline visibility toggles (Prompt 4 / Block 2) — per-session isolation', function () {

        it('(V7b) two sessions with different _hiddenTracks must not bleed across setData()', function () {
            var container = createContainer(900, 360);
            var tl = new Timeline(container, { totalFrames: 80 });

            var sessionA = buildSession(['camA'], { camA: 2 }, ['camA']);
            sessionA._hiddenTracks = new Set();
            sessionA._hiddenTracks.add('track_0');

            var sessionB = buildSession(['camA'], { camA: 2 }, ['camA']);
            sessionB._hiddenTracks = new Set();
            sessionB._hiddenTracks.add('track_1');

            // Load sessionA: track_0 hidden, track_1 visible.
            tl.setData(sessionA);
            assertEqual(countRowsForTrack(tl, 'camA', 'track_0'), 0,
                'sessionA: track_0 must be hidden per sessionA._hiddenTracks');
            assertEqual(countRowsForTrack(tl, 'camA', 'track_1'), 1,
                'sessionA: track_1 must be visible (not in sessionA._hiddenTracks)');

            // Load sessionB: track_1 hidden, track_0 visible.
            tl.setData(sessionB);
            assertEqual(countRowsForTrack(tl, 'camA', 'track_1'), 0,
                'sessionB: track_1 must be hidden per sessionB._hiddenTracks; got ' +
                countRowsForTrack(tl, 'camA', 'track_1'));
            assertEqual(countRowsForTrack(tl, 'camA', 'track_0'), 1,
                'sessionB: track_0 must be visible (not in sessionB._hiddenTracks); got ' +
                countRowsForTrack(tl, 'camA', 'track_0'));

            cleanup(tl, container);
        });
    });
})();
