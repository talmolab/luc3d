/**
 * test-timeline-visibility-list.js — Block 2 (Prompt 4)
 *
 * Data-model concerns for the Timeline visibility toggle LISTS (Views /
 * Tracks / Identities). Block 2 adds three dynamic toggle lists to the
 * Info Panel → Visibility tab, populated from the current session.
 *
 * The Info Panel itself is tightly coupled to the live `document` (HTML
 * tables, modal lifecycles, …) and cannot be mounted from the node test
 * runner without dragging in the entire app. Per the agent prompt, the
 * tests in this file therefore observe the DATA MODEL — the list of
 * entities the panel would render, plus the hidden-set membership for
 * default-on / removed-on-delete behaviour. DOM rendering for these
 * scenarios is covered by Phase 7 manual repro.
 *
 *   (V4)  New entity defaults ON — a freshly added track is NOT present
 *         in `session._hiddenTracks` (so renders as toggle-on), and its
 *         row appears in the timeline.
 *
 *   (V5)  Deleted entity removed from the source list — after a track is
 *         deleted (all its instances removed AND its name dropped from
 *         `session.tracks`), the timeline no longer enumerates a row for
 *         it; the proposed `getVisibleTrackNames(session)` / list source
 *         must also stop reporting it.
 *
 *   (VAPI) Proposed `ui/timeline-visibility.js` module shape — the API
 *         that the Info Panel wiring will consume. Importing the module
 *         and exercising its toggle helpers must succeed; this is a
 *         module-shape test that fails cleanly when the module is
 *         missing (Block 2 hasn't built it yet).
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;
    var assertFalse = TF.assertFalse;
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

    /**
     * Block 2 list helper. Block 2 must expose a function that enumerates
     * the track names the Visibility tab will render — sourced from the
     * current session, NOT from the timeline's filtered _trackSegments
     * (the toggle list must show hidden entries too, so the user can
     * un-hide them). Accept any of the plausible names. Returns null
     * when no candidate is wired up so the test assertion fails cleanly.
     */
    function getProposedTrackListFn() {
        var candidates = [
            'listTracksForVisibility',
            'getVisibleTrackNames',
            'getTrackList',
            'listTrackToggles',
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (typeof window[candidates[i]] === 'function') {
                return window[candidates[i]];
            }
            if (typeof TimelineVisibility !== 'undefined' &&
                typeof TimelineVisibility[candidates[i]] === 'function') {
                return TimelineVisibility[candidates[i]];
            }
        }
        return null;
    }

    // ============================================================
    //  (V4) New entity defaults ON
    // ============================================================
    describe('Timeline visibility toggles (Prompt 4 / Block 2) — new-entity default', function () {

        it('(V4) a newly added track defaults to visible (not in _hiddenTracks) and renders in the timeline', function () {
            var container = createContainer(900, 320);
            var tl = new Timeline(container, { totalFrames: 80 });
            var session = buildSession(['camA'], { camA: 2 }, ['camA']);
            tl.setData(session);

            // Resolve Block 2's track-list helper. The Visibility tab's
            // "Tracks" list is sourced from this function — it must
            // enumerate ALL tracks in the session (visible OR hidden)
            // so the user can un-toggle hidden ones.
            var listFn = getProposedTrackListFn();
            assertNotNull(listFn,
                'Block 2 must expose a track-list source for the Visibility ' +
                'tab (searched listTracksForVisibility / getVisibleTrackNames / ' +
                'getTrackList / listTrackToggles on window and TimelineVisibility).');

            // Snapshot the initial track list.
            var preTracks = listFn(session);
            assertEqual(preTracks.length, 2,
                'sanity: initial track list has 2 entries; got ' + preTracks.length +
                ' (' + preTracks.join(',') + ')');

            // Initialize the hidden-set the way Block 2 will (empty by default).
            if (!session._hiddenTracks) session._hiddenTracks = new Set();

            // Simulate the user adding a new track via the regular pose-data API:
            // append a new track name and a single instance under that index.
            var newIdx = session.tracks.length;
            var newName = 'track_' + newIdx;
            session.tracks.push(newName);

            var inst = new Instance([[300, 300], [400, 400]], 50, 'user', 1);
            inst.trackIdx = newIdx;
            var fg = session.getFrameGroup(50) || new FrameGroup(50);
            fg.addInstance('camA', inst);
            if (!session.getFrameGroup(50)) session.addFrameGroup(fg);

            // Refresh — the new track must surface in the rendered list AND
            // must NOT have been auto-added to _hiddenTracks.
            tl.refreshTracks(session);

            var postTracks = listFn(session);
            assertGreaterThan(postTracks.length, preTracks.length,
                'rendered track list must grow after adding a new track. ' +
                'before=' + preTracks.length + ' after=' + postTracks.length);
            assertTrue(postTracks.indexOf(newName) >= 0,
                'new track "' + newName + '" must appear in the proposed ' +
                'track-list source; got [' + postTracks.join(',') + ']');

            assertFalse(session._hiddenTracks.has(newName),
                'newly created track must NOT be in session._hiddenTracks ' +
                '(default-on). got _hiddenTracks=[' +
                Array.from(session._hiddenTracks).join(',') + ']');

            // And the row must be rendering.
            var found = false;
            var segs = tl._trackSegments || [];
            for (var i = 0; i < segs.length; i++) {
                if (segs[i].cameraName === 'camA' && segs[i].trackName === newName &&
                    segs[i].treeRole !== 'empty') {
                    found = true; break;
                }
            }
            assertTrue(found,
                'new-track row for camA/' + newName + ' must be present in ' +
                '_trackSegments; got ' + segs.length + ' rows total');

            cleanup(tl, container);
        });
    });

    // ============================================================
    //  (V5) Deleted entity removed from list
    // ============================================================
    describe('Timeline visibility toggles (Prompt 4 / Block 2) — deleted-entity removal', function () {

        it('(V5) deleting a track removes it from the proposed track-list source and from the timeline', function () {
            var container = createContainer(900, 320);
            var tl = new Timeline(container, { totalFrames: 80 });
            var session = buildSession(['camA'], { camA: 3 }, ['camA']);
            tl.setData(session);

            // Resolve Block 2's track-list helper — same lookup as V4.
            var listFn = getProposedTrackListFn();
            assertNotNull(listFn,
                'Block 2 must expose a track-list source for the Visibility ' +
                'tab (searched listTracksForVisibility / getVisibleTrackNames / ' +
                'getTrackList / listTrackToggles on window and TimelineVisibility).');

            var preTracks = listFn(session);
            assertEqual(preTracks.length, 3,
                'sanity: initial track list has 3 entries; got [' +
                preTracks.join(',') + ']');
            assertTrue(preTracks.indexOf('track_1') >= 0,
                'sanity: track_1 must be in the list before deletion');

            // Simulate deletion: remove every instance whose trackIdx === 1,
            // and drop the name from session.tracks.
            for (var [, fg] of session.frameGroups) {
                for (var [cam, insts] of fg.instances) {
                    var kept = [];
                    for (var i = 0; i < insts.length; i++) {
                        if (insts[i].trackIdx !== 1) kept.push(insts[i]);
                    }
                    fg.instances.set(cam, kept);
                }
            }
            // Drop track_1 from the name table.
            session.tracks.splice(1, 1);

            tl.refreshTracks(session);

            var postTracks = listFn(session);
            assertFalse(postTracks.indexOf('track_1') >= 0,
                'deleted track_1 must be absent from the proposed list ' +
                'source. got [' + postTracks.join(',') + ']');

            // And no row for it in the timeline.
            var segs = tl._trackSegments || [];
            var stillRendered = 0;
            for (var s = 0; s < segs.length; s++) {
                if (segs[s].trackName === 'track_1' && segs[s].treeRole !== 'empty') {
                    stillRendered++;
                }
            }
            assertEqual(stillRendered, 0,
                'deleted track_1 must not render any rows; got ' + stillRendered);

            cleanup(tl, container);
        });
    });

    // ============================================================
    //  (VAPI) Proposed module shape
    // ============================================================
    describe('Timeline visibility toggles (Prompt 4 / Block 2) — proposed API surface', function () {

        it('(VAPI) ui/timeline-visibility.js (or equivalent) exposes toggle / is-visible helpers', function () {
            // Block 2 is expected to add a thin module that owns toggle
            // semantics so the Info Panel wiring and the timeline render
            // path agree on shape. The exact module name is permissive —
            // accept any of the plausible options, exported either onto
            // `window` (vm sandbox) or onto a global `TimelineVisibility`
            // namespace.
            var candidates = [
                'toggleCameraVisibility',
                'toggleTrackVisibility',
                'toggleIdentityVisibility',
                'isCameraVisible',
                'isTrackVisible',
                'isIdentityVisible',
            ];

            // Resolve from sandbox global OR a namespace object.
            function resolve(name) {
                if (typeof window[name] === 'function') return window[name];
                if (typeof globalThis !== 'undefined' &&
                    typeof globalThis.TimelineVisibility === 'object' &&
                    globalThis.TimelineVisibility &&
                    typeof globalThis.TimelineVisibility[name] === 'function') {
                    return globalThis.TimelineVisibility[name];
                }
                if (typeof TimelineVisibility !== 'undefined' &&
                    typeof TimelineVisibility[name] === 'function') {
                    return TimelineVisibility[name];
                }
                return null;
            }

            var resolved = {};
            for (var i = 0; i < candidates.length; i++) {
                resolved[candidates[i]] = resolve(candidates[i]);
            }

            // The three toggle helpers MUST exist. (The is-visible queries
            // are nice-to-have but not strictly required — the Info Panel
            // can just check Set membership directly. So we assert only
            // the togglers.)
            assertNotNull(resolved.toggleCameraVisibility,
                'Block 2 must expose toggleCameraVisibility(session, camName) ' +
                'on window or via a `TimelineVisibility` namespace ' +
                '(likely from ui/timeline-visibility.js).');
            assertNotNull(resolved.toggleTrackVisibility,
                'Block 2 must expose toggleTrackVisibility(session, trackName).');
            assertNotNull(resolved.toggleIdentityVisibility,
                'Block 2 must expose toggleIdentityVisibility(session, idName).');

            // Exercise toggle semantics on a small fixture.
            var container = createContainer(900, 320);
            var tl = new Timeline(container, { totalFrames: 50 });
            var session = buildSession(['camA', 'camB'], { camA: 1, camB: 1 }, ['camA', 'camB']);
            tl.setData(session);

            // Initial state — no hidden cams.
            assertTrue(!session._hiddenCameras || !session._hiddenCameras.has('camB'),
                'sanity: camB not yet hidden');

            resolved.toggleCameraVisibility(session, 'camB');
            assertTrue(!!(session._hiddenCameras && session._hiddenCameras.has('camB')),
                'after toggleCameraVisibility(session, "camB"), camB must be ' +
                'in session._hiddenCameras');

            resolved.toggleCameraVisibility(session, 'camB');
            assertFalse(!!(session._hiddenCameras && session._hiddenCameras.has('camB')),
                'a second toggleCameraVisibility(session, "camB") must REMOVE ' +
                'camB from session._hiddenCameras (toggle = flip)');

            cleanup(tl, container);
        });
    });
})();
