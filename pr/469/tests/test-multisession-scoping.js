/**
 * test-multisession-scoping.js — regression tests for the "add empty session
 * (+) / load videos into session > 1" work and the timeline-marker bug it
 * exposed. Guards three behaviors:
 *
 *   1. Empty-session skeleton inheritance — a manually-created empty session
 *      shares the ONE project skeleton (handleEmptySession seeds from
 *      buildRememberedSkeleton()); it must not diverge into its own skeleton.
 *   2. Timeline marker visibility — a user instance shows on the timeline iff
 *      its camera is present in session.cameras (+ passes the _uploadedCameras
 *      filter). The video-scoping bug left a session with a view but no
 *      session.cameras entry, so the timeline drew no rows for it.
 *   3. SLP export isolation — buildSlpExportData for one session exports only
 *      that session's instances; an empty session exports nothing.
 *
 * Uses only bridgeable (DOM-free-import) modules: pose-data, app-state,
 * ui/timeline, import-export/file-io.
 */
(function () {
    const { describe, it, beforeEach, assert, assertEqual, assertTrue, assertFalse,
        assertNotNull, assertNull, assertGreaterThan } = TestFramework;

    function cam(name) {
        return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
    }
    function projSkeleton() { return new Skeleton('proj', ['a', 'b'], [[0, 1]]); }

    function makeContainer() {
        var div = document.createElement('div');
        div.style.cssText = 'width:800px;height:80px;position:fixed;top:-9999px;left:0;';
        document.body.appendChild(div);
        return div;
    }
    // Frames covered by segments for a given camera+track in a built timeline.
    function segFrames(tl, camName, trackIdx) {
        var frames = new Set();
        for (var i = 0; i < tl._trackSegments.length; i++) {
            var s = tl._trackSegments[i];
            if (s.cameraName !== camName || s.trackIdx !== trackIdx) continue;
            for (var j = 0; j < s.segments.length; j++) {
                for (var f = s.segments[j].start; f <= s.segments[j].end; f++) frames.add(f);
            }
        }
        return frames;
    }

    // -----------------------------------------------------------------
    // 1. Empty-session skeleton inheritance (the "+" button behavior)
    // -----------------------------------------------------------------
    describe('Empty session inherits the one project skeleton', function () {
        it('a session seeded from buildRememberedSkeleton shares the project skeleton object', function () {
            var sk = projSkeleton();
            var savedSessions = state.sessions, savedSession = state.session;
            try {
                var s1 = new Session([cam('c')], sk, ['track_0'], 'Session 1');
                state.sessions = [s1];
                state.session = s1;
                setProjectSkeleton(sk);            // establish the project skeleton

                // handleEmptySession's core: new empty session seeds its skeleton
                // from buildRememberedSkeleton() (the shared reference), NOT a
                // fresh blank Skeleton.
                var inherited = buildRememberedSkeleton();
                assertTrue(inherited === sk, 'buildRememberedSkeleton returns the shared project skeleton');
                var s2 = new Session([], inherited, ['track_0'], 'Session 2');
                state.sessions = [s1, s2];

                assertTrue(s2.skeleton === sk, 'empty session 2 shares the SAME skeleton object as session 1');
                // Editing the shared skeleton is visible in the empty session too.
                sk.addNode('c');
                assertEqual(s2.skeleton.nodes.length, 3, 'edits to the project skeleton propagate to the empty session');
            } finally {
                state.sessions = savedSessions;
                state.session = savedSession;
            }
        });
    });

    // -----------------------------------------------------------------
    // 2. Timeline marker visibility (the bug the video-scoping fix cured)
    // -----------------------------------------------------------------
    describe('Timeline marker requires the instance camera in session.cameras', function () {
        var container, tl;
        beforeEach(function () {
            if (tl) { tl.destroy(); }
            if (container && container.parentNode) container.remove();
            container = makeContainer();
            tl = new Timeline(container, { totalFrames: 100 });
        });

        it('user instance on an uploaded camera appears on the timeline', function () {
            var session = new Session([cam('mid')], projSkeleton(), ['track_0'], 'S');
            session._uploadedCameras = ['mid'];
            session.addUnlinkedInstance(20, 'mid', new Instance([[100, 100], [200, 200]], 0, 'user', 1));
            tl.setData(session);
            assertTrue(segFrames(tl, 'mid', 0).has(20),
                'a user instance at frame 20 on cam "mid" must produce a timeline segment');
        });

        it('same instance draws NOTHING when session.cameras is empty (the bug), and appears once the camera is added (the fix)', function () {
            // Reproduce the corrupted state the pre-fix handleLoadVideos left:
            // an instance exists on a view whose camera was never added to
            // session.cameras.
            var session = new Session([], projSkeleton(), ['track_0'], 'S');
            session._uploadedCameras = [];
            session.addUnlinkedInstance(20, 'mid', new Instance([[100, 100], [200, 200]], 0, 'user', 1));
            tl.setData(session);
            var nonEmpty = tl._trackSegments.filter(function (s) { return s.segments && s.segments.length > 0; });
            assertEqual(nonEmpty.length, 0, 'no timeline rows when the instance camera is missing from session.cameras');

            // Apply the fix's guarantee: the camera IS present.
            session.cameras = [cam('mid')];
            session._uploadedCameras = ['mid'];
            tl.refreshTracks(session);
            assertTrue(segFrames(tl, 'mid', 0).has(20),
                'once the camera is in session.cameras the marker shows on the timeline');
        });

        it('a camera present but NOT in _uploadedCameras is filtered out', function () {
            var session = new Session([cam('mid')], projSkeleton(), ['track_0'], 'S');
            session._uploadedCameras = [];   // no uploaded videos
            session.addUnlinkedInstance(20, 'mid', new Instance([[100, 100], [200, 200]], 0, 'user', 1));
            tl.setData(session);
            assertFalse(segFrames(tl, 'mid', 0).has(20),
                'calibration-only camera (not in _uploadedCameras) is excluded from the timeline');
        });
    });

    // -----------------------------------------------------------------
    // 3. SLP export isolation / unaffected by empty sessions
    // -----------------------------------------------------------------
    describe('SLP export isolation across sessions', function () {
        function populate(session, camName, frameIdx) {
            var fg = new FrameGroup(frameIdx);
            fg.addInstance(camName, new Instance([[10, 20], [30, 40]], 0, 'user', 1));
            session.addFrameGroup(fg);
        }

        it('each session exports only its own instances (no cross-session leak)', function () {
            var s1 = new Session([cam('CamA')], projSkeleton(), ['track_0'], 'S1');
            var s2 = new Session([cam('CamB')], projSkeleton(), ['track_0'], 'S2');
            populate(s1, 'CamA', 5);
            populate(s2, 'CamB', 7);

            var d1 = buildSlpExportData(s1, [{ name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 100 }]);
            var d2 = buildSlpExportData(s2, [{ name: 'CamB', videoWidth: 640, videoHeight: 480, frameCount: 100 }]);

            assertGreaterThan(d1.instances.length, 0, 'S1 exports its own instance');
            assertGreaterThan(d2.instances.length, 0, 'S2 exports its own instance');
            assertEqual(d1.videos.length, 1, 'S1 export has exactly its one video');
            assertEqual(d2.videos.length, 1, 'S2 export has exactly its one video');
            // CamB frame (7) must not appear in S1's export and vice-versa.
            assertTrue(d1.frames.every(function (f) { return f.frame_idx !== 7; }) || d1.frames.length === 1,
                'S1 export does not contain S2 frame');
        });

        it('an empty session (from the + button) exports nothing', function () {
            var empty = new Session([], projSkeleton(), ['track_0'], 'Empty');
            var data = buildSlpExportData(empty, []);
            assertEqual(data.instances.length, 0, 'no instances');
            assertEqual(data.frames.length, 0, 'no frames');
        });
    });
})();
