/**
 * test-save-load-lazy-risk.js — unit tests for `estimateLazySaveRiskBytes`
 * (import-export/save-load.js), the size-warning heuristic added to
 * `buildSlpBytes` so a large lazy multi-camera project gets a chance to
 * cancel before a merged Save/Save As is likely to crash the tab, instead of
 * silently attempting it and losing all unsaved work.
 *
 * Dynamic-imports save-load.js (not statically bridged into the test page —
 * its import graph is heavy, see MODULES.md). save-load.js transitively
 * imports pose/initialization.js the same way test-lazy-reopen.js's
 * slp-import.js import does (init() fails gracefully without the app DOM,
 * and ES modules are singleton-cached, so re-importing here after
 * test-lazy-reopen.js has already run is a no-op either way). Registered
 * after test-lazy-reopen.js in test-runner.html for the same reason that
 * file states: keep any init() side effects out of the other suites.
 */
(function () {
    const { describe, it, assertEqual, assertTrue, assertFalse } = TestFramework;

    describe('estimateLazySaveRiskBytes — large lazy-project save warning', function () {
        it('returns 0 for a session with no lazyLoader', async function () {
            const { estimateLazySaveRiskBytes } = await import('../import-export/save-load.js');
            const fakeSession = { lazyLoader: null, cameras: [{ name: 'a' }] };
            assertEqual(estimateLazySaveRiskBytes([fakeSession]), 0);
        });

        it('scales with frames x cameras (via labelsByCam)', async function () {
            const { estimateLazySaveRiskBytes } = await import('../import-export/save-load.js');
            const small = [{
                lazyLoader: { nFrames: 1000, labelsByCam: new Map([['a', {}], ['b', {}]]) },
                cameras: [{ name: 'a' }, { name: 'b' }],
            }];
            const big = [{
                lazyLoader: { nFrames: 180000, labelsByCam: new Map([['a', {}], ['b', {}], ['c', {}], ['d', {}], ['e', {}]]) },
                cameras: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }],
            }];
            const smallEst = estimateLazySaveRiskBytes(small);
            const bigEst = estimateLazySaveRiskBytes(big);
            assertTrue(bigEst > smallEst, 'more frames x cameras -> larger estimate');
            // 180000 frames x 5 cams vs 1000 x 2: ratio should match (180000*5)/(1000*2) = 450x.
            const ratio = bigEst / smallEst;
            assertTrue(ratio > 440 && ratio < 460, 'estimate scales linearly with frame x camera pairs');
        });

        it('the real bug-report project (180,210 frames x 5 cameras) crosses the warn threshold', async function () {
            // Real numbers confirmed via h5py against the actual per-camera
            // .slp files in the bug report — not an assumption.
            const { estimateLazySaveRiskBytes } = await import('../import-export/save-load.js');
            const cams = ['21241563', '21369048', '21372315', '21372316', '22085397'].map(function (n) { return { name: n }; });
            const session = {
                lazyLoader: { nFrames: 180210, labelsByCam: new Map(cams.map(function (c) { return [c.name, {}]; })) },
                cameras: cams,
            };
            const est = estimateLazySaveRiskBytes([session]);
            // ~1.5 GB is buildSlpBytes's LAZY_SAVE_WARN_BYTES threshold — this
            // is the actual condition that gates the confirm() prompt.
            assertTrue(est > 1.5e9, 'estimate for the real bug-report project exceeds the warn threshold (' +
                (est / 1e9).toFixed(2) + ' GB estimated)');
        });

        it('sums frame x camera pairs across multiple sessions being exported together', async function () {
            const { estimateLazySaveRiskBytes } = await import('../import-export/save-load.js');
            const one = { lazyLoader: { nFrames: 50000, labelsByCam: new Map([['a', {}]]) }, cameras: [{ name: 'a' }] };
            const two = { lazyLoader: { nFrames: 50000, labelsByCam: new Map([['a', {}]]) }, cameras: [{ name: 'a' }] };
            const combined = estimateLazySaveRiskBytes([one, two]);
            const single = estimateLazySaveRiskBytes([one]);
            assertEqual(combined, single * 2, 'two equal sessions sum linearly');
        });

        it('falls back to cameras.length when labelsByCam is absent (non-SioLazyLoader lazyLoader)', async function () {
            const { estimateLazySaveRiskBytes } = await import('../import-export/save-load.js');
            const session = { lazyLoader: { nFrames: 1000 }, cameras: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
            const est = estimateLazySaveRiskBytes([session]);
            assertTrue(est > 0, 'still produces a positive estimate using cameras.length as the camera count');
        });
    });
})();
