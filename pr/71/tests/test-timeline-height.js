/**
 * test-timeline-prompt95.js
 *
 * Regression tests for the Timeline changes introduced across Prompts
 * 95–97 and the SLP-load fixes:
 *   - `getPreferredHeight()` grows to fit loaded tracks (with view gaps).
 *   - `_computeLayout()` applies collapse priority: tracks hide first,
 *     markers next, labels last. White bars never reach the label area.
 *   - `refreshTracks()` grows the container in-place so a new track
 *     assignment doesn't "clear" the timeline.
 *   - `_buildTrackSegments` sources bars from per-instance `trackIdx`
 *     (not `group.identityId`), so past-frame instances keep their
 *     own track bar after a forward-only swap.
 *   - `trackOccupancy` entries are suppressed for frames that have
 *     been materialized into `session.frameGroups`, so SLP-loaded
 *     occupancy doesn't reassert the old track after reassignment.
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertTrue, assertFalse,
        assertGreaterThan, assertLessThan } = TestFramework;

    function createContainer(width, height) {
        var div = document.createElement('div');
        div.style.width = (width || 800) + 'px';
        div.style.height = (height || 100) + 'px';
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

    function buildSessionWithTracks(numTracks, cameraNames) {
        var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
        var cameras = [];
        for (var i = 0; i < cameraNames.length; i++) {
            cameras.push(new Camera(cameraNames[i],
                [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]));
        }
        var trackNames = [];
        for (var t = 0; t < numTracks; t++) trackNames.push('track_' + t);
        var session = new Session(cameras, skeleton, trackNames);
        for (var c = 0; c < cameraNames.length; c++) {
            for (var t2 = 0; t2 < numTracks; t2++) {
                var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1);
                inst.trackIdx = t2;
                var frameIdx = c * numTracks + t2;
                var fg = session.getFrameGroup(frameIdx) || new FrameGroup(frameIdx);
                fg.addInstance(cameraNames[c], inst);
                if (!session.getFrameGroup(frameIdx)) session.addFrameGroup(fg);
            }
        }
        return session;
    }

    describe('Timeline Prompt 95 - height + layout', function () {
        var container, tl;

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 200);
            tl = new Timeline(container, { totalFrames: 50 });
        });

        it('getPreferredHeight: compact when empty, sums rows + view gaps when populated', function () {
            // Empty state: TOP_PADDING + MARKER + 4 + LABEL + 8.
            var emptyExpected = tl.TOP_PADDING + tl.MARKER_AREA_HEIGHT + 4
                + tl.LABEL_AREA_HEIGHT + 8;
            assertEqual(tl.getPreferredHeight(), emptyExpected);

            // Populated with two cameras so a view gap appears.
            tl.setData(buildSessionWithTracks(2, ['cam1', 'cam2']));
            var numRows = tl._trackSegments.length;
            assertGreaterThan(numRows, 0);
            var numViewGaps = 0, prev = null;
            for (var i = 0; i < numRows; i++) {
                var cam = tl._trackSegments[i].cameraName;
                if (prev != null && cam !== prev) numViewGaps++;
                prev = cam;
            }
            assertGreaterThan(numViewGaps, 0);
            var expected = tl.TOP_PADDING
                + numRows * tl.TRACK_ROW_HEIGHT
                + (numRows - 1) * tl.TRACK_ROW_GAP
                + numViewGaps * tl.VIEW_GROUP_GAP
                + 6
                + tl.MARKER_AREA_HEIGHT
                + tl.LABEL_AREA_HEIGHT
                + 8;
            assertEqual(tl.getPreferredHeight(), expected);
            cleanup(tl, container); tl = null;
        });

        it('_computeLayout enforces collapse priority: tracks → markers → labels', function () {
            tl.setData(buildSessionWithTracks(3, ['cam1']));

            // Preferred height shows everything; trackAreaBottom sits
            // above the marker area (white bars never reach labels).
            var full = tl._computeLayout(tl.getPreferredHeight());
            assertTrue(full.showTracks && full.showMarkers && full.showLabels);
            var numTracks = tl._trackSegments.length;
            var naturalH = numTracks * tl.TRACK_ROW_HEIGHT + (numTracks - 1) * tl.TRACK_ROW_GAP;
            assertEqual(full.trackAreaBottom - full.trackAreaTop, naturalH);
            assertLessThan(full.trackAreaBottom, full.markerAreaTop);

            // Tight: markers + labels only, tracks hidden first.
            var markersOnly = tl._computeLayout(tl.LABEL_AREA_HEIGHT + tl.MARKER_AREA_HEIGHT + 4);
            assertFalse(markersOnly.showTracks);
            assertTrue(markersOnly.showMarkers && markersOnly.showLabels);

            // Tighter: only labels remain.
            var labelsOnly = tl._computeLayout(tl.LABEL_AREA_HEIGHT);
            assertFalse(labelsOnly.showTracks);
            assertFalse(labelsOnly.showMarkers);
            assertTrue(labelsOnly.showLabels);

            // Nothing fits.
            var none = tl._computeLayout(0);
            assertFalse(none.showLabels || none.showMarkers || none.showTracks);
            cleanup(tl, container); tl = null;
        });
    });

    describe('Timeline - refreshTracks grows container but never shrinks', function () {
        function sized(h) {
            var div = document.createElement('div');
            div.style.width = '800px';
            div.style.height = h + 'px';
            div.getBoundingClientRect = function () {
                var hh = parseFloat(div.style.height) || 0;
                return { left: 0, top: 0, width: 800, height: hh, right: 800, bottom: hh };
            };
            document.body.appendChild(div);
            return div;
        }

        it('grows when preferred > current; leaves taller containers untouched', function () {
            // Too short → grow to preferred.
            var small = sized(40);
            var tl = new Timeline(small, { totalFrames: 50 });
            tl.refreshTracks(buildSessionWithTracks(6, ['cam1']));
            assertEqual(parseFloat(small.style.height), tl.getPreferredHeight(),
                'grows to the preferred height after refreshTracks');
            tl.destroy();

            // Already larger → no shrink.
            var big = sized(400);
            var tl2 = new Timeline(big, { totalFrames: 50 });
            tl2.refreshTracks(buildSessionWithTracks(2, ['cam1']));
            assertEqual(parseFloat(big.style.height), 400,
                'container stays at its user-set height when already tall enough');
            tl2.destroy();
        });
    });

    describe('Timeline - track bars after a track swap', function () {
        // Covers two regressions that manifest together:
        //   - `_buildTrackSegments` keys off per-instance trackIdx, not
        //     group.identityId, so past-frame instances keep their own
        //     track bar after a forward-only swap.
        //   - `trackOccupancy` entries are suppressed for materialized
        //     frames, so SLP-loaded data doesn't reassert the old track.
        it('past-frame instances keep their own bar; SLP occupancy is overridden', function () {
            var cams = [new Camera('cam1',
                [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0],
                [0,0,0], [0,0,0], [640,480])];
            var skel = new Skeleton('s', ['a'], []);
            var session = new Session(cams, skel, ['t0', 't1', 't2']);

            // Four frames with one group that spans all of them on track 0.
            var group = new InstanceGroup(1, 0);
            for (var f = 0; f < 4; f++) {
                var inst = new Instance([[10, 10]], 0, 'user', 1);
                var fg = new FrameGroup(f);
                fg.addInstance('cam1', inst);
                session.addFrameGroup(fg);
                if (f === 0) group.addInstance('cam1', inst);
            }
            session.instanceGroups.set(0, [group]);

            // Simulate a forward swap from frame 2: frames 2–3 move to
            // track 2, group.identityId is set to the new track.
            session.getFrameGroup(2).getInstances('cam1')[0].trackIdx = 2;
            session.getFrameGroup(3).getInstances('cam1')[0].trackIdx = 2;
            group.identityId = 2;

            // Plant SLP occupancy saying track 0 is on every frame — the
            // live `fg.instances` for materialized frames must override
            // this so only unmaterialized frames (there are none here)
            // would draw from occupancy.
            session.trackOccupancy = new Map();
            var data = new Array(4 * 3).fill(false);
            for (var g = 0; g < 4; g++) data[g * 3 + 0] = true;
            session.trackOccupancy.set('cam1', { data: data, nFrames: 4, nTracks: 3 });

            var container = createContainer(800, 120);
            var tl = new Timeline(container, { totalFrames: 4 });
            tl.setData(session);

            var ranges = {};
            for (var i = 0; i < tl._trackSegments.length; i++) {
                var seg = tl._trackSegments[i];
                ranges[seg.trackIdx] = seg.segments.map(function (s) {
                    return s.start + '-' + s.end;
                }).join(',');
            }
            assertEqual(ranges[0], '0-1',
                'track 0 bar only covers past frames with instances still on track 0');
            assertEqual(ranges[2], '2-3',
                'track 2 bar only covers the reassigned frames');
            tl.destroy();
        });
    });
})();
