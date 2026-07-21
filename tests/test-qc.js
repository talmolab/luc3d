/**
 * test-qc.js — Unit/integration tests for the QC engine (pose/qc.js).
 *
 * Covers: 2D duplicate detection (IOU + node-distance), low-node-count,
 * symmetric swap classification, reprojection-vs-inversion, auto-thresholds,
 * histogram binning, consecutive-frame grouping, flagged-frame navigation, and
 * the "conservative triangulation" contract (runProjectQC does NOT re-triangulate
 * clean/cached groups: result.triCalls === 0).
 *
 * Relies on the test-runner ESM→global bridge for: QC functions (pose/qc.js),
 * Session/Camera/Skeleton/Instance/InstanceGroup/FrameGroup (pose-data.js) and
 * `state` (app-state.js).
 */

(function () {
    const { describe, it, assertEqual, assertApprox, assertTrue, assertNotNull } = TestFramework;

    function available() {
        return typeof analyzeFrame === 'function' && typeof runProjectQC === 'function' &&
            typeof Session === 'function' && typeof Camera === 'function';
    }

    function clone(pts) { return pts.map(function (p) { return p == null ? null : [p[0], p[1]]; }); }

    function makeCam(name, tvec) {
        return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], tvec, [640, 480]);
    }

    function makeSession() {
        const skel = new Skeleton('s', ['n0', 'n1', 'n2', 'n3'], [[0, 1], [1, 2], [2, 3]]);
        return new Session([makeCam('a', [0, 0, 0]), makeCam('b', [20, 0, 0])], skel, ['t0', 't1'], 'S');
    }

    const BASE_PTS = [[100, 100], [110, 110], [120, 120], [130, 130]];

    // -------------------------------------------------------------------
    describe('QC — 2D duplicate detection (IOU + node distance)', function () {
        it('flags two coincident instances in the same view as duplicate', function () {
            if (!available()) return;
            const session = makeSession();
            const fg = new FrameGroup(0);
            fg.addInstance('a', new Instance(clone(BASE_PTS), 0, 'user', 1));
            fg.addInstance('a', new Instance(clone(BASE_PTS), 1, 'user', 1)); // sits exactly on top
            session.frameGroups.set(0, fg);
            state.session = session; state.currentFrame = 0; state.triangulationResults = new Map();

            const res = analyzeFrame(session, 0, makeThresholds());
            const dup = res.issues.filter(function (i) { return i.type === 'duplicate'; });
            assertEqual(dup.length, 1, 'exactly one duplicate issue');
            assertApprox(dup[0].values.meanNodeDist, 0, 1e-6, 'coincident => 0 node distance');
        });

        it('does NOT flag well-separated instances', function () {
            if (!available()) return;
            const session = makeSession();
            const fg = new FrameGroup(0);
            fg.addInstance('a', new Instance(clone(BASE_PTS), 0, 'user', 1));
            const far = BASE_PTS.map(function (p) { return [p[0] + 400, p[1] + 400]; });
            fg.addInstance('a', new Instance(far, 1, 'user', 1));
            session.frameGroups.set(0, fg);
            state.session = session; state.currentFrame = 0; state.triangulationResults = new Map();

            const res = analyzeFrame(session, 0, makeThresholds());
            assertEqual(res.issues.filter(function (i) { return i.type === 'duplicate'; }).length, 0, 'no duplicate');
        });
    });

    // -------------------------------------------------------------------
    describe('QC — low node count', function () {
        it('flags an instance with too few visible nodes', function () {
            if (!available()) return;
            const session = makeSession();
            const fg = new FrameGroup(0);
            // Only 1 of 4 nodes visible; minNodes = max(2, floor(0.3*4)=1) = 2.
            fg.addInstance('a', new Instance([[100, 100], null, null, null], 0, 'user', 1));
            session.frameGroups.set(0, fg);
            state.session = session; state.currentFrame = 0; state.triangulationResults = new Map();

            const res = analyzeFrame(session, 0, makeThresholds());
            const low = res.issues.filter(function (i) { return i.type === 'low_nodes'; });
            assertEqual(low.length, 1, 'one low_nodes issue');
            assertEqual(low[0].values.visibleNodes, 1, 'reports 1 visible node');
        });

        it('does NOT flag a fully-labeled instance', function () {
            if (!available()) return;
            const session = makeSession();
            const fg = new FrameGroup(0);
            fg.addInstance('a', new Instance(clone(BASE_PTS), 0, 'user', 1));
            session.frameGroups.set(0, fg);
            state.session = session; state.currentFrame = 0; state.triangulationResults = new Map();

            const res = analyzeFrame(session, 0, makeThresholds());
            assertEqual(res.issues.filter(function (i) { return i.type === 'low_nodes'; }).length, 0, 'no low_nodes');
        });
    });

    // -------------------------------------------------------------------
    describe('QC — node-swap / chimera detection is symmetric', function () {
        function rawWith(swaps) {
            return {
                session: makeSession(),
                thresholds: makeThresholds(),
                coverage: { total: 1, triangulated: 1 },
                globalStats: {},
                raw: { perFrame: new Map([[0, { frameIdx: 0, swaps: swaps }]]) },
            };
        }
        it('flags a node swap when BOTH directions cross', function () {
            if (!available()) return;
            // A's detection near B's reprojection (dAB<0.8*dAA) AND vice-versa.
            const km = [{ kp: 0, cam: 'a', dAA: 10, dAB: 1, dBB: 10, dBA: 1 },
                        { kp: 1, cam: 'a', dAA: 10, dAB: 1, dBB: 10, dBA: 1 },
                        { kp: 2, cam: 'a', dAA: 10, dAB: 1, dBB: 10, dBA: 1 }];
            const r = classify(rawWith([{ trackA: 0, trackB: 1, kpMargins: km }]));
            assertEqual(r.issuesByType.node_swap || 0, 1, 'one node_swap issue');
            assertEqual(r.sortedIssues[0].severity, 'high', '3 crossed nodes => high');
        });
        it('does NOT flag when only one direction crosses (old false-positive case)', function () {
            if (!available()) return;
            // A crosses (dAB<0.8*dAA) but B does not (dBA=9 not < 0.8*10=8).
            const km = [{ kp: 0, cam: 'a', dAA: 10, dAB: 1, dBB: 10, dBA: 9 }];
            const r = classify(rawWith([{ trackA: 0, trackB: 1, kpMargins: km }]));
            assertEqual(r.issuesByType.node_swap || 0, 0, 'asymmetric => no node_swap');
        });
    });

    // -------------------------------------------------------------------
    describe('QC — ID switch (temporal) is distinct from node swap', function () {
        it('flags an ID switch when two identities exchange positions', async function () {
            if (!available()) return;
            const session = makeSession();
            const idA = session.addIdentity('A');
            const idB = session.addIdentity('B');
            state.session = session;
            state.triangulationResults = new Map();
            // Two identities sit far apart and move smoothly, then SWAP positions at f=10.
            for (let f = 0; f <= 20; f++) {
                const swapped = (f >= 10);
                const posA = swapped ? [100, 0, 50] : [0, 0, 50];
                const posB = swapped ? [0, 0, 50] : [100, 0, 50];
                const mk = function (id, base) {
                    const g = new InstanceGroup(f, id); g.identityId = id;
                    g.addInstance('a', new Instance(clone(BASE_PTS), 0, 'user', 1));
                    g.addInstance('b', new Instance(clone(BASE_PTS), 0, 'user', 1));
                    g.points3d = [base, [base[0], 10, 50], [base[0], 20, 50], [base[0], 30, 50]];
                    g.markClean();
                    return { group: g, points3d: g.points3d,
                        reprojections: { a: clone(BASE_PTS), b: clone(BASE_PTS) },
                        errors: { a: [1, 1, 1, 1], b: [1, 1, 1, 1] },
                        errorsUndistorted: { a: [1, 1, 1, 1], b: [1, 1, 1, 1] }, meanError: 1, method: 'dlt' };
                };
                const eA = mk(idA.id, posA), eB = mk(idB.id, posB);
                session.instanceGroups.set(f, [eA.group, eB.group]);
                state.triangulationResults.set(f, [eA, eB]);
            }
            const result = await runProjectQC(session, { thresholds: makeThresholds() });
            assertTrue((result.issuesByType.id_switch || 0) >= 1, 'flagged an ID switch at the crossover');
            assertTrue(result.sortedIssues.some(function (i) { return i.type === 'id_switch' && i.frameIdx === 10; }),
                'ID switch at the swap frame');
        });
    });

    // -------------------------------------------------------------------
    describe('QC — reprojection vs inversion classification', function () {
        function rawWithGroup(group) {
            return {
                session: makeSession(),
                thresholds: makeThresholds({ reprojHigh: 10 }),
                coverage: { total: 1, triangulated: 1 },
                globalStats: {},
                raw: { perFrame: new Map([[0, { frameIdx: 0, groups: [group] }]]) },
            };
        }
        it('labels single-camera-concentrated error as inversion', function () {
            if (!available()) return;
            const group = {
                trackIdx: 0, numKp: 1, camSeen: [3],
                perNode: [mean3(40, 1, 1)],                    // cross-cam mean > 10 => outlier
                perNodeCam: [[{ cam: 'a', err: 40 }, { cam: 'b', err: 1 }, { cam: 'c', err: 1 }]],
            };
            const r = classify(rawWithGroup(group));
            assertEqual(r.issuesByType.inversion || 0, 1, 'inversion (worst >> others)');
        });
        it('labels broadly-high error as reprojection', function () {
            if (!available()) return;
            const group = {
                trackIdx: 0, numKp: 1, camSeen: [3],
                perNode: [mean3(20, 18, 19)],
                perNodeCam: [[{ cam: 'a', err: 20 }, { cam: 'b', err: 18 }, { cam: 'c', err: 19 }]],
            };
            const r = classify(rawWithGroup(group));
            assertEqual(r.issuesByType.reprojection || 0, 1, 'plain reprojection');
        });
        function mean3(a, b, c) { return (a + b + c) / 3; }
    });

    // -------------------------------------------------------------------
    describe('QC — thresholds / histogram / grouping / navigation', function () {
        it('percentile interpolates', function () {
            if (typeof percentile !== 'function') return;
            assertApprox(percentile([1, 2, 3, 4, 5], 50), 3, 1e-9);
        });
        it('buildHistogram counts outliers above threshold', function () {
            if (typeof buildHistogram !== 'function') return;
            const h = buildHistogram([1, 2, 3, 100], 50, 40);
            assertEqual(h.outlierCount, 1, 'one value above 50');
            assertTrue(h.bins > 0);
        });
        it('computeAutoThresholds returns P95', function () {
            if (typeof computeAutoThresholds !== 'function') return;
            const vals = []; for (let i = 1; i <= 100; i++) vals.push(i);
            const auto = computeAutoThresholds({ reproj: vals, epipolar: [], velocity: [], limbZ: [] }, 95);
            assertApprox(auto.reproj, 95.05, 1.0, 'P95 ~ 95');
        });
        it('groupConsecutiveIssues merges runs and picks a representative', function () {
            if (typeof groupConsecutiveIssues !== 'function') return;
            const issues = [
                { type: 'reprojection', severity: 'high', frameIdx: 10, trackIdx: 0, description: 'x' },
                { type: 'reprojection', severity: 'high', frameIdx: 11, trackIdx: 0, description: 'x' },
                { type: 'reprojection', severity: 'high', frameIdx: 12, trackIdx: 0, description: 'x' },
                { type: 'reprojection', severity: 'high', frameIdx: 40, trackIdx: 0, description: 'x' },
            ];
            const runs = groupConsecutiveIssues(issues, 2, 200);
            assertEqual(runs.length, 2, 'two runs (10-12 and 40)');
            assertEqual(runs[0].startFrame, 10);
            assertEqual(runs[0].endFrame, 12);
            assertTrue(runs[0].representative >= 10 && runs[0].representative <= 12);
        });
        it('next/prevFlaggedFrame wrap around', function () {
            if (typeof nextFlaggedFrame !== 'function') return;
            const set = new Set([5, 20, 50]);
            assertEqual(nextFlaggedFrame(set, 20), 50);
            assertEqual(nextFlaggedFrame(set, 50), 5, 'wraps');
            assertEqual(prevFlaggedFrame(set, 20), 5);
            assertEqual(prevFlaggedFrame(set, 5), 50, 'wraps');
        });
    });

    // -------------------------------------------------------------------
    describe('QC — pure cache read (never re-triangulates)', function () {
        it('runProjectQC reads cache and does ZERO triangulation', async function () {
            if (!available()) return;
            const session = makeSession();
            // A clean, already-triangulated group with cached errors.
            const g = new InstanceGroup(0, 0);
            g.addInstance('a', new Instance(clone(BASE_PTS), 0, 'user', 1));
            g.addInstance('b', new Instance(clone(BASE_PTS), 0, 'user', 1));
            g.points3d = [[0, 0, 50], [0, 0, 50], [0, 0, 50], [0, 0, 50]];
            g.markClean();
            session.instanceGroups.set(0, [g]);
            const fg = new FrameGroup(0);
            fg.addInstance('a', g.getInstance('a'));
            fg.addInstance('b', g.getInstance('b'));
            session.frameGroups.set(0, fg);
            state.session = session;
            state.triangulationResults = new Map([[0, [{
                group: g, points3d: g.points3d,
                reprojections: { a: clone(BASE_PTS), b: clone(BASE_PTS) },
                errors: { a: [20, 1, 1, 1], b: [1, 1, 1, 1] },
                errorsUndistorted: { a: [20, 1, 1, 1], b: [1, 1, 1, 1] },
                meanError: 5, method: 'dlt',
            }]]]);

            const result = await runProjectQC(session, { thresholds: makeThresholds() });
            assertEqual(result.triCalls, 0, 'never triangulated clean/cached groups');
            assertEqual(result.coverage.total, 1, 'one frame swept');
            assertNotNull(result.flaggedFrames, 'produced a flagged-frame set');
            assertTrue(result.flaggedFrames instanceof Set);
        });

        it('runProjectQC does NOT triangulate a dirty/missing group — reports it uncovered', async function () {
            if (!available()) return;
            const session = makeSession();
            const g = new InstanceGroup(0, 0);
            g.addInstance('a', new Instance(clone(BASE_PTS), 0, 'user', 1));
            g.addInstance('b', new Instance([[140, 100], [150, 110], [160, 120], [170, 130]], 0, 'user', 1));
            g.points3d = null; g.markDirty();           // not yet triangulated
            session.instanceGroups.set(0, [g]);
            state.session = session;
            state.triangulationResults = new Map();      // no cache

            const result = await runProjectQC(session, { thresholds: makeThresholds() });
            assertEqual(result.triCalls, 0, 'QC never re-triangulates, even for a missing group');
            assertEqual(result.coverage.triangulated, 0, 'missing group reported as not covered');
        });
    });

    // -------------------------------------------------------------------
    describe('QC — conservative defaults do not flag a clean dataset', function () {
        // The core regression guard for the "it flags every frame" report: a large,
        // clean, low-error session (mean reproj ~2px, smooth motion, stable limbs,
        // one animal per view) must leave the overwhelming majority of frames unflagged.
        it('flags only a tiny fraction of frames on clean, low-error data', async function () {
            if (!available()) return;
            const session = makeSession();
            state.session = session;
            state.triangulationResults = new Map();
            const N = 200;
            for (let f = 0; f < N; f++) {
                const dx = (f % 7);                              // small bounded drift (0..6 px)
                const pa = BASE_PTS.map(function (p) { return [p[0] + dx, p[1]]; });
                const pb = BASE_PTS.map(function (p) { return [p[0] + dx + 20, p[1]]; });
                const fg = new FrameGroup(f);
                const g = new InstanceGroup(f, -1);
                const ia = new Instance(pa, 0, 'user', 1);
                const ib = new Instance(pb, 0, 'user', 1);
                g.addInstance('a', ia); g.addInstance('b', ib);
                fg.addInstance('a', ia); fg.addInstance('b', ib);
                g.points3d = [[dx, 0, 50], [dx, 10, 50], [dx, 20, 50], [dx, 30, 50]];
                g.markClean();
                session.frameGroups.set(f, fg);
                session.instanceGroups.set(f, [g]);
                state.triangulationResults.set(f, [{
                    group: g, points3d: g.points3d,
                    reprojections: { a: pa, b: pb },
                    errors: { a: [2, 2, 2, 2], b: [2, 2, 2, 2] },        // ~2px per node
                    errorsUndistorted: { a: [2, 2, 2, 2], b: [2, 2, 2, 2] },
                    meanError: 2, method: 'dlt',
                }]);
            }
            const result = await runProjectQC(session, { thresholds: makeThresholds() });
            assertTrue(result.globalStats.flaggedFrameCount <= N * 0.05,
                'clean data should flag <=5% of frames, got ' +
                result.globalStats.flaggedFrameCount + '/' + N +
                ' (issues: ' + JSON.stringify(result.issuesByType) + ')');
        });
    });

    // -------------------------------------------------------------------
    describe('QC — temporal jitter + limb length', function () {
        it('classify emits jitter (velocity>threshold) and limb_outlier (z>threshold)', function () {
            if (!available()) return;
            const raw = {
                session: makeSession(),
                thresholds: makeThresholds({ velThresh: 10, limbZ: 3, enable2dJitter: true }),
                coverage: { total: 1, triangulated: 0 },
                globalStats: {},
                raw: {
                    perFrame: new Map([[0, {
                        frameIdx: 0,
                        temporal: [{ velocity: 100, view: 'a', space: '2d', trackIdx: 0, label: 't0' }],
                        limb: [{ edges: [{ edge: 0, length: 50, z: 6 }], view: null, space: '3d', trackIdx: null, label: 'A' }],
                    }]]),
                },
            };
            const r = classify(raw);
            assertEqual(r.issuesByType.jitter || 0, 1, 'one jitter');
            assertEqual(r.issuesByType.limb_outlier || 0, 1, 'one limb_outlier');
            // z=6 (>5) => high severity limb outlier present.
            assertTrue(r.sortedIssues.some(function (i) { return i.type === 'limb_outlier' && i.severity === 'high'; }));
        });

        it('runProjectQC computes 2D per-track velocity and flags a sudden jump', async function () {
            if (!available()) return;
            const session = makeSession();
            state.session = session;
            state.triangulationResults = new Map();
            for (let f = 0; f <= 12; f++) {
                const fg = new FrameGroup(f);
                const shift = (f === 12) ? 500 : 0;                    // one big jump at the end
                const pts = BASE_PTS.map(function (p) { return [p[0] + shift, p[1]]; });
                fg.addInstance('a', new Instance(pts, 0, 'user', 1));  // track 0 across all frames
                session.frameGroups.set(f, fg);
            }
            const result = await runProjectQC(session, { thresholds: makeThresholds({ enable2dJitter: true }) });
            assertTrue(result.distributions.velocity.length > 0, '2D velocities were computed');
            assertTrue((result.issuesByType.jitter || 0) >= 1, 'flagged the 2D jitter frame');
        });

        it('runProjectQC uses 3D identity series when identities exist', async function () {
            if (!available()) return;
            const session = makeSession();
            const idt = session.addIdentity('A');
            state.session = session;
            state.triangulationResults = new Map();
            for (let f = 0; f <= 12; f++) {
                const g = new InstanceGroup(f, idt.id);
                g.identityId = idt.id;
                g.addInstance('a', new Instance(clone(BASE_PTS), 0, 'user', 1));
                g.addInstance('b', new Instance(clone(BASE_PTS), 0, 'user', 1));
                const shift = (f === 12) ? 500 : 0;
                const p3 = [[shift, 0, 50], [shift, 10, 50], [shift, 20, 50], [shift, 30, 50]];
                g.points3d = p3; g.markClean();
                session.instanceGroups.set(f, [g]);
                state.triangulationResults.set(f, [{
                    group: g, points3d: p3,
                    reprojections: { a: clone(BASE_PTS), b: clone(BASE_PTS) },
                    errors: { a: [1, 1, 1, 1], b: [1, 1, 1, 1] },
                    errorsUndistorted: { a: [1, 1, 1, 1], b: [1, 1, 1, 1] },
                    meanError: 1, method: 'dlt',
                }]);
            }
            const result = await runProjectQC(session, { thresholds: makeThresholds() });
            assertTrue(result.distributions.velocity3d.length > 0, '3D velocities were computed');
            assertTrue((result.issuesByType.jitter || 0) >= 1, 'flagged the 3D jitter frame');
            // The jitter description should mention 3D space.
            assertTrue(result.sortedIssues.some(function (i) { return i.type === 'jitter' && /3d/.test(i.description); }),
                '3D jitter labeled as 3d');
        });
    });
})();
