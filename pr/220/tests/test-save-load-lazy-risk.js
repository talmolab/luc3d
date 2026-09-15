/**
 * test-save-load-lazy-risk.js — unit tests for `estimateSaveCagePressureBytes`
 * (import-export/save-load.js), the size-warning model that gates the confirm()
 * prompt in `buildSlpBytes` before a merged Save/Save As on a large project.
 *
 * REWRITTEN for luc3d #189. The old `estimateLazySaveRiskBytes` returned
 * `frames x cameras x 11.4 KB` and never looked at the data — it reported
 * "~10.3 GB" for the real bug-report project and would have reported the same
 * 10.3 GB for a project containing zero instances. The merged save of that
 * project has since been measured SUCCEEDING (1,404,804,682 bytes in 49.5 s at
 * a 2,891 MB baseline), so the old prompt was steering users away from an
 * operation that works. The tests below pin the new model's shape: it prices
 * resident grouping, so it responds to both project size AND memory work.
 *
 * Dynamic-imports save-load.js (not statically bridged into the test page — its
 * import graph is heavy, see MODULES.md). Registered after test-lazy-reopen.js
 * in test-runner.html for the reason that file states: keep init() side effects
 * out of the other suites.
 */
(function () {
    const { describe, it, assertEqual, assertTrue, assertFalse } = TestFramework;

    // Minimal stand-ins: the estimator only reads `instances.size`, `points3d`
    // truthiness, and `frameIdentityMap.size`.
    function fakeGroup(nCams, has3d) {
        return {
            instances: new Map(Array.from({ length: nCams }, (_, i) => ['cam' + i, {}])),
            points3d: has3d ? new Float64Array(3) : null,
        };
    }
    function fakeSession(nFrames, nGroupsPerFrame, nCams, opts) {
        opts = opts || {};
        const instanceGroups = new Map();
        for (let f = 0; f < nFrames; f++) {
            instanceGroups.set(f, Array.from({ length: nGroupsPerFrame },
                () => fakeGroup(nCams, opts.has3d !== false)));
        }
        return {
            instanceGroups,
            frameIdentityMap: new Map(
                Array.from({ length: opts.fimEntries || 0 }, (_, i) => [i, 0])),
            cameras: Array.from({ length: nCams }, (_, i) => ({ name: 'cam' + i })),
            lazyLoader: opts.lazyLoader !== undefined ? opts.lazyLoader : { nFrames },
        };
    }

    describe('estimateSaveCagePressureBytes — merged-save warning model', function () {

        it('an empty project costs nothing', async function () {
            const { estimateSaveCagePressureBytes } = await import('../import-export/save-load.js');
            assertEqual(estimateSaveCagePressureBytes([fakeSession(0, 0, 0)]), 0);
            assertEqual(estimateSaveCagePressureBytes([{}]), 0, 'a session with no instanceGroups');
            assertEqual(estimateSaveCagePressureBytes([]), 0, 'nothing to export');
        });

        it('a HUGE but UNGROUPED lazy project costs ~nothing (the old model\'s core error)', async function () {
            // 180,210 frames x 5 cameras with nothing triangulated. The old
            // heuristic reported 10.3 GB here purely from frames x cameras; the
            // streaming writer's actual cost is bounded by its frame cache.
            const { estimateSaveCagePressureBytes } = await import('../import-export/save-load.js');
            const sess = fakeSession(0, 0, 5, { lazyLoader: { nFrames: 180210 } });
            assertEqual(estimateSaveCagePressureBytes([sess]), 0,
                'no grouping resident -> no cage pressure, regardless of frame count');
        });

        it('scales with GROUPED members, not with frame count', async function () {
            const { estimateSaveCagePressureBytes } = await import('../import-export/save-load.js');
            // Same frame count, 4x the members.
            const lean = estimateSaveCagePressureBytes([fakeSession(100, 1, 2)]);
            const fat = estimateSaveCagePressureBytes([fakeSession(100, 2, 4)]);
            assertTrue(lean > 0, 'grouped project has a positive estimate');
            assertTrue(fat > lean * 3, 'more members per frame -> proportionally larger estimate');
        });

        it('is dominated by live Instance members', async function () {
            const { estimateSaveCagePressureBytes } = await import('../import-export/save-load.js');
            const withMembers = estimateSaveCagePressureBytes([fakeSession(50, 1, 5)]);
            const noMembers = estimateSaveCagePressureBytes([fakeSession(50, 1, 0)]);
            assertTrue(withMembers > noMembers * 5,
                'members are the dominant term (they were 79% of the measured baseline)');
        });

        it('counts frameIdentityMap entries', async function () {
            const { estimateSaveCagePressureBytes } = await import('../import-export/save-load.js');
            const without = estimateSaveCagePressureBytes([fakeSession(10, 1, 2, { fimEntries: 0 })]);
            const with100k = estimateSaveCagePressureBytes([fakeSession(10, 1, 2, { fimEntries: 100000 })]);
            assertTrue(with100k > without, 'per-detection identity entries add pressure');
        });

        it('sums across multiple sessions exported together', async function () {
            const { estimateSaveCagePressureBytes } = await import('../import-export/save-load.js');
            const one = fakeSession(20, 1, 3);
            const two = fakeSession(20, 1, 3);
            assertEqual(estimateSaveCagePressureBytes([one, two]),
                estimateSaveCagePressureBytes([one]) * 2, 'two equal sessions sum linearly');
        });

        it('lands in the right ballpark for the REAL bug-report project', async function () {
            // 531,799 instance groups, 2,627,453 grouped 2D members, all with 3D
            // — the actual numbers from the 180,210-frame x 5-camera project.
            // Measured live baseline there: 2,891 MB. The estimate must be the
            // same ORDER as that, not 4x it like the old 10.3 GB figure.
            const { estimateSaveCagePressureBytes } = await import('../import-export/save-load.js');
            const N_GROUPS = 531799, N_MEMBERS = 2627453, N_FIM = 2627453;
            const sess = {
                instanceGroups: new Map([[0, [{
                    // One synthetic group standing in for the totals, so the test
                    // stays O(1) instead of allocating half a million objects.
                    instances: { size: N_MEMBERS },
                    points3d: new Float64Array(3),
                }]]]),
                frameIdentityMap: { size: N_FIM },
            };
            // Group-shell term is negligible at this ratio; members dominate.
            const est = estimateSaveCagePressureBytes([sess]);
            const gb = est / 1e9;
            assertTrue(gb > 1.5 && gb < 4.0,
                'estimate is the same order as the measured 2.9 GB baseline, got ' + gb.toFixed(2) + ' GB');
            assertTrue(gb < 10.3,
                'and is nowhere near the old frames x cameras figure of 10.3 GB');
        });

        it('responds to memory optimisation — the property the old model lacked', async function () {
            // Halving the grouped members (or their per-object cost) must move
            // the number. The old formula was constant w.r.t. every such change.
            const { estimateSaveCagePressureBytes } = await import('../import-export/save-load.js');
            const before = estimateSaveCagePressureBytes([fakeSession(100, 2, 4)]);
            const after = estimateSaveCagePressureBytes([fakeSession(100, 1, 4)]);
            assertTrue(after < before * 0.6, 'halving grouped members roughly halves the estimate');
        });
    });

    describe('getCageLimitBytes — the tab\'s hard JS-heap ceiling', function () {
        it('reports a plausible ceiling', async function () {
            const { getCageLimitBytes } = await import('../import-export/save-load.js');
            const cap = getCageLimitBytes();
            assertTrue(cap >= 1e9 && cap <= 8e9, 'ceiling in a sane range, got ' + (cap / 1e9).toFixed(2) + ' GB');
        });

        it('matches performance.memory when Chrome exposes it', async function () {
            const { getCageLimitBytes } = await import('../import-export/save-load.js');
            if (typeof performance === 'undefined' || !performance.memory) return;
            assertEqual(getCageLimitBytes(), performance.memory.jsHeapSizeLimit);
        });
    });
})();
