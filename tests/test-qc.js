/**
 * test-qc.js - Tests for the QC metrics engine
 */

(function () {
    var describe = TestFramework.describe;
    var it = TestFramework.it;
    var assert = TestFramework.assert;
    var assertApprox = TestFramework.assertApprox;
    var assertEqual = TestFramework.assertEqual;
    var assertTrue = TestFramework.assertTrue;

    // ============================================
    // Utility function tests
    // ============================================

    describe('QC Metrics Engine', function () {

        it('QC module is loaded', function () {
            assert(typeof QC === 'object', 'QC should be a global object');
            assert(typeof QC.runFullAnalysis === 'function', 'QC.runFullAnalysis should be a function');
            assert(typeof QC.computeReprojMetrics === 'function', 'QC.computeReprojMetrics should be a function');
            assert(typeof QC.computeLimbLengths === 'function', 'QC.computeLimbLengths should be a function');
        });

        it('Utility: mean', function () {
            assertApprox(QC._mean([1, 2, 3, 4, 5]), 3, 0.001, 'mean of 1-5 should be 3');
            assertApprox(QC._mean([10]), 10, 0.001, 'mean of single value');
            assertApprox(QC._mean([]), 0, 0.001, 'mean of empty array');
        });

        it('Utility: stddev', function () {
            assertApprox(QC._stddev([2, 4, 4, 4, 5, 5, 7, 9]), 2.138, 0.01, 'sample stddev');
            assertApprox(QC._stddev([5]), 0, 0.001, 'stddev of single value');
            assertApprox(QC._stddev([]), 0, 0.001, 'stddev of empty');
        });

        it('Utility: percentile', function () {
            var sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
            assertApprox(QC._percentile(sorted, 50), 5.5, 0.01, 'P50 of 1-10');
            assertApprox(QC._percentile(sorted, 0), 1, 0.01, 'P0');
            assertApprox(QC._percentile(sorted, 100), 10, 0.01, 'P100');
            assertApprox(QC._percentile(sorted, 95), 9.55, 0.01, 'P95');
        });

        it('Utility: dist3d', function () {
            assertApprox(QC._dist3d([0, 0, 0], [3, 4, 0]), 5, 0.001, 'distance 3-4-5');
            assertApprox(QC._dist3d([1, 1, 1], [1, 1, 1]), 0, 0.001, 'zero distance');
            assertApprox(QC._dist3d([0, 0, 0], [1, 1, 1]), Math.sqrt(3), 0.001, 'diagonal');
        });

        // ============================================
        // Reprojection Error Metrics
        // ============================================

        it('computeReprojMetrics: basic', function () {
            var triResult = {
                errors: {
                    'CamA': [1.0, 2.0, 3.0],
                    'CamB': [1.5, 2.5, 12.0],
                },
                meanError: 3.67,
            };

            var metrics = QC.computeReprojMetrics(triResult);

            assert(metrics.meanError === 3.67, 'meanError should match input');
            assertEqual(metrics.perKeypoint.length, 3, 'should have 3 keypoints');
            assertApprox(metrics.perKeypoint[0], 1.25, 0.01, 'keypoint 0 mean error');
            assertApprox(metrics.perKeypoint[2], 7.5, 0.01, 'keypoint 2 mean error');
            assert(metrics.maxError > 7, 'max error should be high');
            assert(metrics.severity === 'medium' || metrics.severity === 'high',
                'severity should be medium or high for error 3.67');
        });

        it('computeReprojMetrics: outlier detection', function () {
            var triResult = {
                errors: {
                    'CamA': [1.0, 15.0, 2.0],
                    'CamB': [1.0, 14.0, 2.0],
                },
                meanError: 5.83,
            };

            var metrics = QC.computeReprojMetrics(triResult);

            assert(metrics.outlierKeypoints.length >= 1, 'should detect outlier keypoints');
            assert(metrics.outlierKeypoints.indexOf(1) >= 0, 'keypoint 1 should be flagged');
        });

        it('computeReprojMetrics: severity classification', function () {
            var low = QC.computeReprojMetrics({ errors: { 'A': [0.5] }, meanError: 0.5 });
            assertEqual(low.severity, 'low', 'error 0.5 should be low severity');

            var med = QC.computeReprojMetrics({ errors: { 'A': [4.0] }, meanError: 4.0 });
            assertEqual(med.severity, 'medium', 'error 4.0 should be medium severity');

            var high = QC.computeReprojMetrics({ errors: { 'A': [15.0] }, meanError: 15.0 });
            assertEqual(high.severity, 'high', 'error 15.0 should be high severity');
        });

        // ============================================
        // Limb Length Consistency
        // ============================================

        it('computeLimbLengths: basic', function () {
            var points3d = [
                [0, 0, 0],
                [3, 4, 0],
                [3, 4, 5],
            ];
            var edges = [[0, 1], [1, 2]];

            var lengths = QC.computeLimbLengths(points3d, edges);

            assertEqual(lengths.length, 2, 'should have 2 edge lengths');
            assertApprox(lengths[0], 5, 0.001, 'edge 0-1 length should be 5');
            assertApprox(lengths[1], 5, 0.001, 'edge 1-2 length should be 5');
        });

        it('computeLimbLengths: null points', function () {
            var points3d = [[0, 0, 0], null, [3, 4, 5]];
            var edges = [[0, 1], [1, 2]];

            var lengths = QC.computeLimbLengths(points3d, edges);

            assert(lengths[0] === null, 'edge with null point should be null');
            assert(lengths[1] === null, 'edge with null point should be null');
        });

        it('computeLimbLengthStats: flag high CV', function () {
            var edges = [[0, 1]];
            var triResults = new Map();

            triResults.set(0, [{ group: { trackIdx: 0 }, points3d: [[0, 0, 0], [10, 0, 0]] }]);
            triResults.set(1, [{ group: { trackIdx: 0 }, points3d: [[0, 0, 0], [10.1, 0, 0]] }]);
            triResults.set(2, [{ group: { trackIdx: 0 }, points3d: [[0, 0, 0], [20, 0, 0]] }]);

            var stats = QC.computeLimbLengthStats(triResults, edges, 0);

            assertEqual(stats.perEdge.length, 1, 'should have 1 edge stat');
            assertEqual(stats.perEdge[0].values.length, 3, 'should have 3 measurements');
            assert(stats.perEdge[0].cv > 0.1, 'CV should be high due to outlier');
            assert(stats.flaggedEdges.length > 0, 'should flag the inconsistent edge');
        });

        // ============================================
        // Temporal Smoothness
        // ============================================

        it('computeTemporalMetrics: basic velocity', function () {
            var triResults = new Map();

            triResults.set(0, [{ group: { trackIdx: 0 }, points3d: [[0, 0, 0], [1, 0, 0]] }]);
            triResults.set(1, [{ group: { trackIdx: 0 }, points3d: [[10, 0, 0], [11, 0, 0]] }]);
            triResults.set(2, [{ group: { trackIdx: 0 }, points3d: [[11, 0, 0], [12, 0, 0]] }]);

            var metrics = QC.computeTemporalMetrics(triResults, 0, 2);

            assertEqual(metrics.frameIndices.length, 3, 'should have 3 frames');
            assert(metrics.maxVelocity >= 10, 'max velocity should be at least 10');
            assertEqual(metrics.meanVelocity.length, 2, 'should have 2 velocity measurements');
        });

        it('computeTemporalMetrics: single frame', function () {
            var triResults = new Map();
            triResults.set(0, [{ group: { trackIdx: 0 }, points3d: [[0, 0, 0]] }]);

            var metrics = QC.computeTemporalMetrics(triResults, 0, 1);

            assertEqual(metrics.maxVelocity, 0, 'single frame should have zero max velocity');
            assertEqual(metrics.flaggedFrames.length, 0, 'no frames should be flagged');
        });

        // ============================================
        // Completeness Scoring
        // ============================================

        it('computeCompletenessMetrics: full coverage', function () {
            var group = new InstanceGroup(1, 0);
            group.addInstance('CamA', new Instance([[1, 2], [3, 4], [5, 6]], 0, 'user', 1));
            group.addInstance('CamB', new Instance([[7, 8], [9, 10], [11, 12]], 0, 'user', 1));

            var cameras = [{ name: 'CamA' }, { name: 'CamB' }];

            var metrics = QC.computeCompletenessMetrics(group, cameras, 3);

            assertApprox(metrics.overallCompleteness, 1.0, 0.01, 'full completeness');
            assertEqual(metrics.missingKeypoints.length, 0, 'no missing keypoints');
            assertEqual(metrics.severity, 'low', 'should be low severity');
        });

        it('computeCompletenessMetrics: partial coverage', function () {
            var group = new InstanceGroup(1, 0);
            group.addInstance('CamA', new Instance([[1, 2], null, [5, 6]], 0, 'user', 1));
            group.addInstance('CamB', new Instance([null, null, [11, 12]], 0, 'user', 1));

            var cameras = [{ name: 'CamA' }, { name: 'CamB' }];

            var metrics = QC.computeCompletenessMetrics(group, cameras, 3);

            assertEqual(metrics.keypointVisibility[0], 1, 'keypoint 0 visible in 1 cam');
            assertEqual(metrics.keypointVisibility[1], 0, 'keypoint 1 visible in 0 cams');
            assertEqual(metrics.keypointVisibility[2], 2, 'keypoint 2 visible in 2 cams');
            assertEqual(metrics.missingKeypoints.length, 2, '2 missing keypoints');
            assert(metrics.overallCompleteness < 1.0, 'completeness < 100%');
        });

        // ============================================
        // Error Classification
        // ============================================

        it('classifyErrors: miss detection with node names', function () {
            var reprojMetrics = {
                meanError: 2.0, maxError: 3.0,
                perKeypoint: [2.0, 3.0], perCamera: {},
                outlierKeypoints: [], severity: 'low',
            };
            var completenessMetrics = {
                missingKeypoints: [1], severity: 'medium', overallCompleteness: 0.5,
            };

            var issues = QC.classifyErrors(reprojMetrics, completenessMetrics, null, null, ['nose', 'elbow']);

            assert(issues.length >= 1, 'should detect at least 1 issue');
            var missIssues = issues.filter(function (i) { return i.type === 'miss'; });
            assertEqual(missIssues.length, 1, 'should detect 1 miss issue');
            assert(missIssues[0].keypoints.indexOf(1) >= 0, 'keypoint 1 should be flagged');
            assert(missIssues[0].description.indexOf('elbow') >= 0, 'should mention elbow by name');
        });

        it('classifyErrors: reprojection outlier with per-camera detail', function () {
            var reprojMetrics = {
                meanError: 8.0, maxError: 15.0,
                perKeypoint: [2.0, 15.0], perCamera: {},
                outlierKeypoints: [1], severity: 'high',
            };
            var completenessMetrics = {
                missingKeypoints: [], severity: 'low', overallCompleteness: 1.0,
            };
            var rawErrors = {
                'CamA': [1.0, 1.5],
                'CamB': [3.0, 28.5],
            };

            var issues = QC.classifyErrors(reprojMetrics, completenessMetrics, null, rawErrors, ['nose', 'elbow']);

            var reprojIssues = issues.filter(function (i) { return i.type === 'reprojection' || i.type === 'inversion'; });
            assert(reprojIssues.length >= 1, 'should detect reprojection issue');
            // The description should mention the specific camera and error
            assert(reprojIssues[0].description.indexOf('elbow') >= 0, 'should name the bodypart');
            assert(reprojIssues[0].description.indexOf('CamB') >= 0, 'should name the outlier camera');
        });

        it('classifyErrors: jitter detection', function () {
            var reprojMetrics = {
                meanError: 2.0, maxError: 3.0,
                perKeypoint: [2.0], perCamera: {},
                outlierKeypoints: [], severity: 'low',
            };
            var completenessMetrics = {
                missingKeypoints: [], severity: 'low', overallCompleteness: 1.0,
            };
            var temporalInfo = { isJitter: true, jitterKeypoints: [0] };

            var issues = QC.classifyErrors(reprojMetrics, completenessMetrics, temporalInfo, null, ['nose']);

            var jitterIssues = issues.filter(function (i) { return i.type === 'jitter'; });
            assertEqual(jitterIssues.length, 1, 'should detect jitter');
        });

        // ============================================
        // Per-Keypoint Per-Camera Error Analysis
        // ============================================

        it('computePerKeypointCameraErrors: identifies outlier camera', function () {
            var triResults = new Map();
            // elbow has 20px error in CamB but 1px in CamA across many frames
            for (var f = 0; f < 5; f++) {
                triResults.set(f, [{
                    group: { trackIdx: 0 },
                    points3d: [[0, 0, 0], [1, 1, 1]],
                    errors: { 'CamA': [1.0, 1.0], 'CamB': [1.0, 20.0] },
                    meanError: 5.75,
                }]);
            }

            var result = QC.computePerKeypointCameraErrors(triResults, ['nose', 'elbow'], ['CamA', 'CamB']);

            assert(result.outliers.length >= 1, 'should detect outlier');
            var elbowOutlier = result.outliers.find(function (o) { return o.keypointName === 'elbow'; });
            assert(elbowOutlier, 'should flag elbow as outlier');
            assertEqual(elbowOutlier.outlierCam, 'CamB', 'CamB should be the outlier camera');
            assertApprox(elbowOutlier.outlierMean, 20.0, 0.1, 'outlier mean should be ~20');
        });

        it('computePerKeypointCameraErrors: no outliers when errors uniform', function () {
            var triResults = new Map();
            triResults.set(0, [{
                group: { trackIdx: 0 },
                points3d: [[0, 0, 0], [1, 1, 1]],
                errors: { 'CamA': [2.0, 2.0], 'CamB': [2.0, 2.0] },
                meanError: 2.0,
            }]);

            var result = QC.computePerKeypointCameraErrors(triResults, ['nose', 'elbow'], ['CamA', 'CamB']);

            assertEqual(result.outliers.length, 0, 'no outliers when errors are uniform');
        });

        it('computePerKeypointCameraErrors: per-camera summary', function () {
            var triResults = new Map();
            triResults.set(0, [{
                group: { trackIdx: 0 },
                points3d: [[0, 0, 0]],
                errors: { 'CamA': [3.0], 'CamB': [6.0] },
                meanError: 4.5,
            }]);

            var result = QC.computePerKeypointCameraErrors(triResults, ['nose'], ['CamA', 'CamB']);

            assert(result.perCameraSummary['CamA'], 'should have CamA summary');
            assert(result.perCameraSummary['CamB'], 'should have CamB summary');
            assertApprox(result.perCameraSummary['CamA'].mean, 3.0, 0.01, 'CamA mean');
            assertApprox(result.perCameraSummary['CamB'].mean, 6.0, 0.01, 'CamB mean');
        });

        // ============================================
        // Composite QC Score
        // ============================================

        it('computeCompositeScore: perfect', function () {
            var reprojMetrics = { meanError: 0 };
            var completenessMetrics = { overallCompleteness: 1.0 };

            var score = QC.computeCompositeScore(reprojMetrics, completenessMetrics, 0, 0, 10);

            assertEqual(score, 100, 'perfect data should score 100');
        });

        it('computeCompositeScore: terrible', function () {
            var reprojMetrics = { meanError: 20 };
            var completenessMetrics = { overallCompleteness: 0 };

            var score = QC.computeCompositeScore(reprojMetrics, completenessMetrics, 0.5, 100, 10);

            assert(score < 20, 'terrible data should score < 20, got: ' + score);
        });

        it('computeCompositeScore: moderate', function () {
            var reprojMetrics = { meanError: 3 };
            var completenessMetrics = { overallCompleteness: 0.8 };

            var score = QC.computeCompositeScore(reprojMetrics, completenessMetrics, 0.05, 2, 10);

            assert(score >= 40 && score <= 90, 'moderate data should score 40-90, got: ' + score);
        });

        // ============================================
        // Navigation Helpers
        // ============================================

        it('nextFlaggedFrame: forward', function () {
            var flagged = new Set([5, 10, 20, 30]);

            assertEqual(QC.nextFlaggedFrame(flagged, 0), 5, 'next after 0 should be 5');
            assertEqual(QC.nextFlaggedFrame(flagged, 5), 10, 'next after 5 should be 10');
            assertEqual(QC.nextFlaggedFrame(flagged, 25), 30, 'next after 25 should be 30');
        });

        it('nextFlaggedFrame: wrap around', function () {
            var flagged = new Set([5, 10, 20]);

            assertEqual(QC.nextFlaggedFrame(flagged, 20), 5, 'should wrap to 5');
            assertEqual(QC.nextFlaggedFrame(flagged, 25), 5, 'should wrap to 5 after 25');
        });

        it('prevFlaggedFrame: backward', function () {
            var flagged = new Set([5, 10, 20, 30]);

            assertEqual(QC.prevFlaggedFrame(flagged, 30), 20, 'prev before 30 should be 20');
            assertEqual(QC.prevFlaggedFrame(flagged, 15), 10, 'prev before 15 should be 10');
        });

        it('prevFlaggedFrame: wrap around', function () {
            var flagged = new Set([5, 10, 20]);

            assertEqual(QC.prevFlaggedFrame(flagged, 5), 20, 'should wrap to 20');
        });

        it('nextFlaggedFrame: empty set', function () {
            assert(QC.nextFlaggedFrame(new Set(), 0) === null, 'empty set should return null');
        });

        // ============================================
        // Full Analysis Integration
        // ============================================

        it('runFullAnalysis: minimal session', function () {
            var skeleton = new Skeleton('test', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            var cam1 = new Camera('CamA',
                [[500, 0, 256], [0, 500, 256], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [512, 512]);
            var cam2 = new Camera('CamB',
                [[500, 0, 256], [0, 500, 256], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0.5, 0, 0], [10, 0, 0], [512, 512]);
            var session = new Session([cam1, cam2], skeleton, ['track_0']);

            var group = new InstanceGroup(1, 0);
            group.addInstance('CamA', new Instance([[100, 100], [200, 200], [300, 100]], 0, 'user', 1));
            group.addInstance('CamB', new Instance([[110, 105], [210, 210], [305, 105]], 0, 'user', 1));

            var triResults = new Map();
            triResults.set(0, [{
                group: group,
                points3d: [[1, 2, 10], [3, 4, 12], [5, 1, 11]],
                reprojections: {
                    'CamA': [[101, 101], [201, 201], [301, 101]],
                    'CamB': [[111, 106], [211, 211], [306, 106]],
                },
                errors: {
                    'CamA': [1.41, 1.41, 1.41],
                    'CamB': [1.41, 1.41, 1.41],
                },
                meanError: 1.41,
            }]);

            var results = QC.runFullAnalysis(session, triResults);

            assert(results.globalStats.totalFrames > 0, 'should have analyzed frames');
            assert(typeof results.globalStats.meanScore === 'number', 'should compute mean score');
            assert(results.globalStats.meanScore >= 0 && results.globalStats.meanScore <= 100,
                'score should be 0-100, got: ' + results.globalStats.meanScore);
            assert(results.flaggedFrames instanceof Set, 'flaggedFrames should be a Set');
            assert(Array.isArray(results.sortedIssues), 'sortedIssues should be an array');
            assert(results.bodypartCameraErrors, 'should include bodypartCameraErrors');
            assert(Array.isArray(results.bodypartCameraErrors.outliers), 'outliers should be array');
        });

        it('runFullAnalysis: empty triangulation', function () {
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var session = new Session([], skeleton, []);
            var triResults = new Map();

            var results = QC.runFullAnalysis(session, triResults);

            assertEqual(results.globalStats.totalFrames, 0, 'no frames');
            assertEqual(results.globalStats.totalIssues, 0, 'no issues');
            assertEqual(results.globalStats.meanScore, 100, 'empty analysis should score 100');
        });
    });
})();
