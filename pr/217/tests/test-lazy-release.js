/**
 * test-lazy-release.js — unit tests for the phase-5 lazy memory-bounding
 * primitives: Session.numFrames on lazy sessions, and SioLazyLoader's
 * releaseFrame / releaseWindow / close, which now delegate to sleap-io.js's
 * PUBLIC lazy frame-release API (`labels.releaseFrame(row)` +
 * `labels.frameCacheLimit`) instead of reaching into the private
 * `_lazyFrameList.cache`.
 *
 * The per-camera lazy `Labels` are stubbed with a `releaseFrame(row)` spy (the
 * same surface the real bundle exposes), so these exercise the REAL SioLazyLoader
 * delegation without a real `.slp` read. The `(row = camera's videoFrameIdx→
 * store-row)` mapping is the loader's `frameRowByCam`.
 */

(function () {
    const { describe, it, assertEqual, assertTrue, assertFalse, assertDeepEqual } = TestFramework;

    function makeLoader(camFrameIdxs) {
        const loader = new SioLazyLoader();
        camFrameIdxs.forEach(function (frameIdxs, ci) {
            const camName = 'cam' + ci;
            const rowMap = new Map();
            frameIdxs.forEach(function (f, row) { rowMap.set(f, row); });
            loader.labelsByCam.set(camName, {
                _released: [],
                frameCacheLimit: undefined,
                releaseFrame(row) { this._released.push(row); },
            });
            loader.frameRowByCam.set(camName, rowMap);
        });
        loader.nFrames = Math.max.apply(null, [0].concat(camFrameIdxs.flat())) + 1;
        return loader;
    }
    function released(loader, camName) { return loader.labelsByCam.get(camName)._released; }

    describe('Session.numFrames (lazy)', function () {
        it('non-lazy session reports frameGroups.size', function () {
            const s = new Session('s');
            s.frameGroups.set(0, {});
            s.frameGroups.set(5, {});
            assertEqual(s.numFrames, 2, 'non-lazy → frameGroups.size');
        });

        it('lazy session reports the loader total, not the visited count', function () {
            const s = new Session('s');
            s.frameGroups.set(100, {}); // only one visited/resident frame
            s.lazyLoader = { nFrames: 108000 };
            assertEqual(s.numFrames, 108000, 'lazy → lazyLoader.nFrames');
        });
    });

    describe('SioLazyLoader.releaseFrame', function () {
        it('delegates to labels.releaseFrame(row) per camera and drops the adapted cache', function () {
            const loader = makeLoader([[10, 11, 12], [10, 11, 12]]);
            loader.cache.set(11, new Map()); // seed the adapted-dict LRU
            loader.cacheOrder = [11];

            loader.releaseFrame(11); // frame 11 -> row 1 in both cameras

            assertFalse(loader.cache.has(11), 'adapted-dict cache dropped frame 11');
            assertEqual(loader.cacheOrder.indexOf(11), -1, 'cacheOrder pruned');
            assertDeepEqual(released(loader, 'cam0'), [1], 'cam0 released store row 1');
            assertDeepEqual(released(loader, 'cam1'), [1], 'cam1 released store row 1');
        });

        it('is a safe no-op when a camera lacks a releaseFrame method (older bundle)', function () {
            const loader = new SioLazyLoader();
            loader.labelsByCam.set('cam0', {}); // no releaseFrame
            loader.frameRowByCam.set('cam0', new Map([[3, 0]]));
            loader.releaseFrame(3); // must not throw
            assertTrue(true, 'no throw when releaseFrame absent');
        });

        it('releases nothing for a frame absent from a camera row map', function () {
            const loader = makeLoader([[0, 1, 2]]);
            loader.releaseFrame(99);
            assertDeepEqual(released(loader, 'cam0'), [], 'unknown frame → no release call');
        });
    });

    describe('SioLazyLoader.releaseWindow', function () {
        it('releases a half-open [start,end) range by row', function () {
            const loader = makeLoader([[0, 1, 2, 3, 4]]);
            loader.releaseWindow(1, 3); // frames 1,2 -> rows 1,2; 3 excluded
            assertDeepEqual(released(loader, 'cam0'), [1, 2], 'rows 1,2 released; end exclusive');
        });
    });

    describe('SioLazyLoader.close', function () {
        it('drops the per-camera labels refs and the adapted cache', function () {
            const loader = makeLoader([[0, 1, 2], [0, 1, 2]]);
            loader.cache.set(0, new Map());
            loader.close();
            assertEqual(loader.labelsByCam.size, 0, 'labelsByCam cleared');
            assertEqual(loader.cache.size, 0, 'adapted cache cleared');
        });
    });
})();
