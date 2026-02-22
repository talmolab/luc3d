/**
 * test-slp-merge.js — Tests for multi-SLP additive loading helpers.
 * Covers: validateSkeletonCompatibility, mergeTracksIntoSession,
 *         mergeSlpFramesIntoSession, rebuildInstanceGroupsForFrames
 */

describe('SLP Merge Helpers', function () {

    // --- validateSkeletonCompatibility ---

    describe('validateSkeletonCompatibility', function () {

        it('should accept identical skeletons (exact match)', function () {
            var existing = new Skeleton('test', ['A', 'B', 'C'], [[0, 1], [1, 2]]);
            var incoming = new Skeleton('test', ['A', 'B', 'C'], [[0, 1], [1, 2]]);
            var result = validateSkeletonCompatibility(existing, incoming);
            assertNull(result.error, 'Should have no error');
            assertNull(result.reorderMap, 'Should have no reorder map for exact match');
        });

        it('should reject different node counts', function () {
            var existing = new Skeleton('test', ['A', 'B', 'C'], []);
            var incoming = new Skeleton('test', ['A', 'B'], []);
            var result = validateSkeletonCompatibility(existing, incoming);
            assertNotNull(result.error, 'Should have an error');
            assert(result.error.indexOf('Node count mismatch') >= 0, 'Error should mention count mismatch');
        });

        it('should accept same nodes in different order and return reorderMap', function () {
            var existing = new Skeleton('test', ['Nose', 'Ear', 'Tail'], []);
            var incoming = new Skeleton('test', ['Tail', 'Nose', 'Ear'], []);
            var result = validateSkeletonCompatibility(existing, incoming);
            assertNull(result.error, 'Should have no error for same set');
            assertNotNull(result.reorderMap, 'Should have a reorder map');
            // incoming[0]='Tail' -> existing idx 2
            // incoming[1]='Nose' -> existing idx 0
            // incoming[2]='Ear'  -> existing idx 1
            assertDeepEqual(result.reorderMap, [2, 0, 1], 'Reorder map should map incoming to existing');
        });

        it('should reject if node names differ (not just order)', function () {
            var existing = new Skeleton('test', ['A', 'B', 'C'], []);
            var incoming = new Skeleton('test', ['A', 'B', 'D'], []);
            var result = validateSkeletonCompatibility(existing, incoming);
            assertNotNull(result.error, 'Should have error for different node names');
            assert(result.error.indexOf('not found') >= 0, 'Error should mention node not found');
        });

        it('should reject incoming skeleton with duplicate node names', function () {
            var existing = new Skeleton('test', ['A', 'B', 'C'], []);
            var incoming = new Skeleton('test', ['A', 'B', 'A'], []);
            var result = validateSkeletonCompatibility(existing, incoming);
            assertNotNull(result.error, 'Should have error for duplicate names');
        });

        it('should handle real-world SLEAP node ordering (back vs side)', function () {
            // These are the actual reordered node lists from minimal_session SLP files
            var backNodes = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk',
                'Tail_0', 'Tail_1', 'Tail_2', 'Shoulder_left', 'Shoulder_right',
                'Haunch_left', 'Haunch_right', 'Neck'];
            var sideNodes = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk',
                'Tail_0', 'Tail_1', 'Tail_2', 'Shoulder_left', 'Shoulder_right',
                'Haunch_left', 'Haunch_right', 'Neck'];
            var existing = new Skeleton('mouse', backNodes, []);
            var incoming = new Skeleton('mouse', sideNodes, []);
            var result = validateSkeletonCompatibility(existing, incoming);
            assertNull(result.error, 'Should accept identical node lists from same project');
            assertNull(result.reorderMap, 'No reorder needed for identical lists');
        });

        it('should handle case where old worker produces different global ordering', function () {
            // If old worker code is used, global node order (not skeleton order) would be used
            var backGlobal = ['TailTip', 'Ear_L', 'Haunch_left', 'Tail_1', 'Head', 'Trunk', 'Neck', 'Nose'];
            var sideGlobal = ['Ear_R', 'Ear_L', 'Haunch_left', 'Neck', 'Tail_2', 'Nose', 'TTI', 'Trunk'];
            var existing = new Skeleton('mouse', backGlobal, []);
            var incoming = new Skeleton('mouse', sideGlobal, []);
            var result = validateSkeletonCompatibility(existing, incoming);
            // These have DIFFERENT node sets (different names), should fail
            assertNotNull(result.error, 'Should reject when node sets genuinely differ');
        });
    });

    // --- mergeTracksIntoSession ---

    describe('mergeTracksIntoSession', function () {

        it('should remap matching tracks to existing indices', function () {
            var session = new Session([], new Skeleton('test', ['A'], []), ['animal_0', 'animal_1']);
            var incoming = ['animal_0', 'animal_1'];
            var remap = mergeTracksIntoSession(session, incoming);
            assertEqual(remap.get(0), 0, 'Track 0 maps to 0');
            assertEqual(remap.get(1), 1, 'Track 1 maps to 1');
            assertEqual(session.tracks.length, 2, 'No new tracks added');
        });

        it('should add new tracks and remap correctly', function () {
            var session = new Session([], new Skeleton('test', ['A'], []), ['animal_0']);
            var incoming = ['animal_0', 'animal_1'];
            var remap = mergeTracksIntoSession(session, incoming);
            assertEqual(remap.get(0), 0, 'Existing track maps to 0');
            assertEqual(remap.get(1), 1, 'New track gets index 1');
            assertEqual(session.tracks.length, 2, 'Session now has 2 tracks');
            assertEqual(session.tracks[1], 'animal_1', 'New track name is correct');
        });

        it('should handle empty incoming tracks', function () {
            var session = new Session([], new Skeleton('test', ['A'], []), ['track_0']);
            var remap = mergeTracksIntoSession(session, []);
            assertEqual(remap.size, 0, 'Empty remap for empty incoming');
        });
    });

    // --- mergeSlpFramesIntoSession ---

    describe('mergeSlpFramesIntoSession', function () {

        it('should merge frames from incoming SLP into session', function () {
            var skeleton = new Skeleton('test', ['nose', 'tail'], [[0, 1]]);
            var cam1 = new Camera('back', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            var cam2 = new Camera('side', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            var session = new Session([cam1], skeleton, ['track_0']);

            // Add a frame from cam1
            var fg0 = new FrameGroup(0);
            fg0.addInstance('back', new Instance([[100, 200], [300, 400]], 0, 'predicted', 0.9));
            session.addFrameGroup(fg0);

            // Mock SLP data for cam2
            var slpData = {
                frames: [
                    {
                        frameIdx: 0, videoIdx: 0,
                        instances: [{ points: [[150, 250], [350, 450]], trackIdx: 0, type: 'predicted', score: 0.85 }]
                    },
                    {
                        frameIdx: 5, videoIdx: 0,
                        instances: [{ points: [[110, 210], [310, 410]], trackIdx: 0, type: 'predicted', score: 0.88 }]
                    }
                ]
            };
            var videoIdxToCameraName = { 0: 'side' };
            var trackRemap = new Map([[0, 0]]);

            var affected = mergeSlpFramesIntoSession(session, slpData, videoIdxToCameraName, [cam2], trackRemap, null);

            assertEqual(affected.length, 2, 'Two frames affected');
            assert(affected.indexOf(0) >= 0, 'Frame 0 is affected');
            assert(affected.indexOf(5) >= 0, 'Frame 5 is affected');

            // Check frame 0 has both cameras
            var fg = session.frameGroups.get(0);
            assertNotNull(fg, 'Frame 0 should exist');
            var backInsts = fg.getInstances('back');
            var sideInsts = fg.getInstances('side');
            assertEqual(backInsts.length, 1, 'Frame 0 should have 1 back instance');
            assertEqual(sideInsts.length, 1, 'Frame 0 should have 1 side instance');
            assertDeepEqual(sideInsts[0].points[0], [150, 250], 'Side instance point 0 should be correct');

            // Check frame 5 was created
            var fg5 = session.frameGroups.get(5);
            assertNotNull(fg5, 'Frame 5 should exist');
            var sideInsts5 = fg5.getInstances('side');
            assertEqual(sideInsts5.length, 1, 'Frame 5 should have 1 side instance');
        });

        it('should reorder points when nodeReorderMap is provided', function () {
            // Existing skeleton: ['A', 'B', 'C']
            // Incoming skeleton: ['C', 'A', 'B'] -> reorderMap = [2, 0, 1]
            // incoming point[0] (for node C) -> existing position 2
            // incoming point[1] (for node A) -> existing position 0
            // incoming point[2] (for node B) -> existing position 1
            var skeleton = new Skeleton('test', ['A', 'B', 'C'], []);
            var cam = new Camera('cam', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            var session = new Session([cam], skeleton, ['track_0']);

            var slpData = {
                frames: [{
                    frameIdx: 0, videoIdx: 0,
                    instances: [{
                        points: [[10, 11], [20, 21], [30, 31]], // C=10,11  A=20,21  B=30,31
                        trackIdx: 0, type: 'predicted', score: 1.0
                    }]
                }]
            };
            var trackRemap = new Map([[0, 0]]);
            var reorderMap = [2, 0, 1]; // incoming[0]->existing[2], incoming[1]->existing[0], incoming[2]->existing[1]

            mergeSlpFramesIntoSession(session, slpData, { 0: 'cam' }, [cam], trackRemap, reorderMap);

            var fg = session.frameGroups.get(0);
            var insts = fg.getInstances('cam');
            assertEqual(insts.length, 1, 'Should have 1 instance');
            // After reorder: position 0 (A) = incoming[1] = [20,21]
            //                position 1 (B) = incoming[2] = [30,31]
            //                position 2 (C) = incoming[0] = [10,11]
            assertDeepEqual(insts[0].points[0], [20, 21], 'Node A should be at position 0');
            assertDeepEqual(insts[0].points[1], [30, 31], 'Node B should be at position 1');
            assertDeepEqual(insts[0].points[2], [10, 11], 'Node C should be at position 2');
        });
    });

    // --- rebuildInstanceGroupsForFrames ---

    describe('rebuildInstanceGroupsForFrames', function () {

        it('should group instances by trackIdx across cameras', function () {
            var skeleton = new Skeleton('test', ['A', 'B'], [[0, 1]]);
            var session = new Session([], skeleton, ['track_0', 'track_1']);

            var fg = new FrameGroup(0);
            fg.addInstance('back', new Instance([[1, 2], [3, 4]], 0, 'predicted', 1.0));
            fg.addInstance('back', new Instance([[5, 6], [7, 8]], 1, 'predicted', 1.0));
            fg.addInstance('side', new Instance([[11, 12], [13, 14]], 0, 'predicted', 1.0));
            fg.addInstance('side', new Instance([[15, 16], [17, 18]], 1, 'predicted', 1.0));
            session.addFrameGroup(fg);

            rebuildInstanceGroupsForFrames(session, [0]);

            var igMap = session.instanceGroups.get(0);
            assertNotNull(igMap, 'Instance groups should exist for frame 0');

            // Track 0 should have instances from both cameras
            var track0Groups = igMap.get(0);
            assertNotNull(track0Groups, 'Track 0 groups should exist');
            assertEqual(track0Groups.length, 1, 'One group for track 0');
            assertNotNull(track0Groups[0].getInstance('back'), 'Track 0 should have back instance');
            assertNotNull(track0Groups[0].getInstance('side'), 'Track 0 should have side instance');

            // Track 1 should have instances from both cameras
            var track1Groups = igMap.get(1);
            assertNotNull(track1Groups, 'Track 1 groups should exist');
            assertEqual(track1Groups.length, 1, 'One group for track 1');
            assertNotNull(track1Groups[0].getInstance('back'), 'Track 1 should have back instance');
            assertNotNull(track1Groups[0].getInstance('side'), 'Track 1 should have side instance');
        });

        it('should handle frames with only one camera', function () {
            var skeleton = new Skeleton('test', ['A'], []);
            var session = new Session([], skeleton, ['track_0']);

            var fg = new FrameGroup(10);
            fg.addInstance('back', new Instance([[1, 2]], 0, 'predicted', 1.0));
            session.addFrameGroup(fg);

            rebuildInstanceGroupsForFrames(session, [10]);

            var igMap = session.instanceGroups.get(10);
            assertNotNull(igMap, 'Instance groups should exist');
            var groups = igMap.get(0);
            assertEqual(groups.length, 1, 'One group');
            assertNotNull(groups[0].getInstance('back'), 'Has back instance');
            assertNull(groups[0].getInstance('side'), 'No side instance yet');
        });
    });

    // --- Full additive merge flow (data model only, no DOM) ---

    describe('Full additive merge flow', function () {

        it('should merge two single-camera SLPs into one multi-camera session', function () {
            var skeleton = new Skeleton('mouse', ['Nose', 'Tail'], [[0, 1]]);
            var cam1 = new Camera('back', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);

            // --- First SLP load (creates session) ---
            var session = new Session([cam1], skeleton, ['track_0']);
            var fg0 = new FrameGroup(0);
            fg0.addInstance('back', new Instance([[100, 200], [300, 400]], 0, 'predicted', 0.9));
            session.addFrameGroup(fg0);
            var fg5 = new FrameGroup(5);
            fg5.addInstance('back', new Instance([[110, 210], [310, 410]], 0, 'predicted', 0.88));
            session.addFrameGroup(fg5);

            // Build initial instance groups
            rebuildInstanceGroupsForFrames(session, [0, 5]);

            assertEqual(session.cameras.length, 1, 'Session starts with 1 camera');
            assertEqual(session.numFrames, 2, 'Session starts with 2 frames');

            // --- Second SLP load (additive merge) ---
            var incomingSkeleton = new Skeleton('mouse', ['Nose', 'Tail'], [[0, 1]]);

            // Validate
            var skelResult = validateSkeletonCompatibility(session.skeleton, incomingSkeleton);
            assertNull(skelResult.error, 'Skeletons should be compatible');

            // New camera
            var cam2 = new Camera('side', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);

            // Check duplicate camera names
            var isDup = session.cameras.some(function (c) { return c.name === cam2.name; });
            assert(!isDup, 'side should not be duplicate');

            // Merge tracks
            var trackRemap = mergeTracksIntoSession(session, ['track_0']);
            assertEqual(trackRemap.get(0), 0, 'Track maps to existing');

            // Add camera
            session.cameras.push(cam2);

            // Merge frames
            var slpData2 = {
                frames: [
                    { frameIdx: 0, videoIdx: 0, instances: [{ points: [[150, 250], [350, 450]], trackIdx: 0, type: 'predicted', score: 0.85 }] },
                    { frameIdx: 5, videoIdx: 0, instances: [{ points: [[160, 260], [360, 460]], trackIdx: 0, type: 'predicted', score: 0.82 }] },
                    { frameIdx: 10, videoIdx: 0, instances: [{ points: [[170, 270], [370, 470]], trackIdx: 0, type: 'predicted', score: 0.80 }] }
                ]
            };
            var affected = mergeSlpFramesIntoSession(session, slpData2, { 0: 'side' }, [cam2], trackRemap, skelResult.reorderMap);

            // Rebuild instance groups
            rebuildInstanceGroupsForFrames(session, affected);

            // Verify
            assertEqual(session.cameras.length, 2, 'Session now has 2 cameras');
            assertEqual(session.numFrames, 3, 'Session has 3 frames (0, 5, 10)');

            // Frame 0: both cameras
            var fg0Check = session.frameGroups.get(0);
            assertEqual(fg0Check.getInstances('back').length, 1, 'Frame 0: 1 back instance');
            assertEqual(fg0Check.getInstances('side').length, 1, 'Frame 0: 1 side instance');

            // Instance group for frame 0: track 0 should have both cameras
            var ig0 = session.instanceGroups.get(0);
            var ig0Track0 = ig0.get(0);
            assertEqual(ig0Track0.length, 1, 'Frame 0 track 0: 1 group');
            assertNotNull(ig0Track0[0].getInstance('back'), 'Group has back');
            assertNotNull(ig0Track0[0].getInstance('side'), 'Group has side');

            // Frame 10: side only
            var fg10 = session.frameGroups.get(10);
            assertEqual(fg10.getInstances('back').length, 0, 'Frame 10: no back instance');
            assertEqual(fg10.getInstances('side').length, 1, 'Frame 10: 1 side instance');
        });

        it('should handle node reordering in full merge flow', function () {
            // Existing: nodes in order [A, B, C]
            var existingSkel = new Skeleton('test', ['A', 'B', 'C'], [[0, 1], [1, 2]]);
            var cam1 = new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            var session = new Session([cam1], existingSkel, ['track_0']);

            var fg = new FrameGroup(0);
            // Points in existing order: A=[10,11], B=[20,21], C=[30,31]
            fg.addInstance('cam1', new Instance([[10, 11], [20, 21], [30, 31]], 0, 'predicted', 1.0));
            session.addFrameGroup(fg);
            rebuildInstanceGroupsForFrames(session, [0]);

            // Incoming: same nodes but order [C, A, B]
            var incomingSkel = new Skeleton('test', ['C', 'A', 'B'], [[0, 1], [1, 2]]);
            var skelResult = validateSkeletonCompatibility(session.skeleton, incomingSkel);
            assertNull(skelResult.error, 'Skeletons should be compatible');
            assertNotNull(skelResult.reorderMap, 'Should have reorder map');
            // reorderMap: incoming[0]=C->existing[2], incoming[1]=A->existing[0], incoming[2]=B->existing[1]
            assertDeepEqual(skelResult.reorderMap, [2, 0, 1]);

            var cam2 = new Camera('cam2', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            session.cameras.push(cam2);

            var trackRemap = mergeTracksIntoSession(session, ['track_0']);
            var slpData = {
                frames: [{
                    frameIdx: 0, videoIdx: 0,
                    instances: [{
                        // Points in INCOMING order: C=[130,131], A=[110,111], B=[120,121]
                        points: [[130, 131], [110, 111], [120, 121]],
                        trackIdx: 0, type: 'predicted', score: 1.0
                    }]
                }]
            };

            var affected = mergeSlpFramesIntoSession(session, slpData, { 0: 'cam2' }, [cam2], trackRemap, skelResult.reorderMap);
            rebuildInstanceGroupsForFrames(session, affected);

            // Verify cam2 points are in existing order [A, B, C]
            var fgCheck = session.frameGroups.get(0);
            var cam2Insts = fgCheck.getInstances('cam2');
            assertEqual(cam2Insts.length, 1, 'Should have 1 cam2 instance');
            assertDeepEqual(cam2Insts[0].points[0], [110, 111], 'Node A at position 0');
            assertDeepEqual(cam2Insts[0].points[1], [120, 121], 'Node B at position 1');
            assertDeepEqual(cam2Insts[0].points[2], [130, 131], 'Node C at position 2');
        });
    });
});
