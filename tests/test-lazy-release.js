/**
 * test-lazy-release.js — unit tests for the phase-5 lazy memory-bounding
 * primitives: Session.numFrames on lazy sessions, and SioLazyLoader's
 * releaseFrame / releaseWindow / capInternalCaches / close (which drop BOTH the
 * loader's own adapted-dict cache AND the underlying sleap-io.js
 * `Labels._lazyFrameList.cache`, the otherwise-unbounded typed-frame cache).
 *
 * The sleap-io.js internals are stubbed with plain Maps/arrays (the same shape the
 * real lazy reader produces: `_lazyFrameList.cache` keyed by store row,
 * `_lazyDataStore.framesData.frame_idx` mapping row -> video frame), so these
 * exercise the REAL SioLazyLoader methods without needing a real `.slp` read.
 */

(function () {
    const { describe, it, assertEqual, assertTrue, assertFalse } = TestFramework;

    // Build a SioLazyLoader with one or more fake cameras. Each fake camera's
    // labeled frames occupy contiguous store rows 0..n-1 mapping to video frames
    // `frameIdxs[r]`.
    function makeLoader(camFrameIdxs) {
        const loader = new SioLazyLoader();
        camFrameIdxs.forEach(function (frameIdxs, ci) {
            const camName = 'cam' + ci;
            const cache = new Map();
            const rowMap = new Map();
            frameIdxs.forEach(function (f, row) {
                cache.set(row, { __row: row });        // typed LabeledFrame stub
                rowMap.set(f, row);
            });
            loader.labelsByCam.set(camName, {
                _lazyFrameList: { cache: cache },
                _lazyDataStore: { framesData: { frame_idx: frameIdxs.slice() } },
            });
            loader.frameRowByCam.set(camName, rowMap);
        });
        loader.nFrames = Math.max.apply(null, [0].concat(camFrameIdxs.flat())) + 1;
        return loader;
    }

    function lflCache(loader, camName) {
        return loader.labelsByCam.get(camName)._lazyFrameList.cache;
    }

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
        it('drops the typed frame from every camera plus the adapted-dict cache', function () {
            const loader = makeLoader([[10, 11, 12], [10, 11, 12]]);
            // Seed the adapted-dict LRU as getFrameSync would.
            loader.cache.set(11, new Map());
            loader.cacheOrder = [11];

            loader.releaseFrame(11);

            assertFalse(loader.cache.has(11), 'adapted-dict cache dropped frame 11');
            assertEqual(loader.cacheOrder.indexOf(11), -1, 'cacheOrder pruned');
            // frame 11 -> row 1 in both cameras
            assertFalse(lflCache(loader, 'cam0').has(1), 'cam0 typed frame row 1 dropped');
            assertFalse(lflCache(loader, 'cam1').has(1), 'cam1 typed frame row 1 dropped');
            assertTrue(lflCache(loader, 'cam0').has(0), 'untouched frame 10 (row 0) kept');
            assertTrue(lflCache(loader, 'cam0').has(2), 'untouched frame 12 (row 2) kept');
        });

        it('is a safe no-op when a camera has no _lazyFrameList', function () {
            const loader = new SioLazyLoader();
            loader.labelsByCam.set('cam0', {}); // no _lazyFrameList / _lazyDataStore
            loader.frameRowByCam.set('cam0', new Map([[3, 0]]));
            loader.releaseFrame(3); // must not throw
            assertTrue(true, 'no throw on missing internals');
        });
    });

    describe('SioLazyLoader.releaseWindow', function () {
        it('drops a half-open [start,end) range and keeps the rest', function () {
            const loader = makeLoader([[0, 1, 2, 3, 4]]);
            loader.releaseWindow(1, 3); // frames 1,2 -> rows 1,2
            const c = lflCache(loader, 'cam0');
            assertTrue(c.has(0), 'row 0 (frame 0) kept');
            assertFalse(c.has(1), 'row 1 (frame 1) dropped');
            assertFalse(c.has(2), 'row 2 (frame 2) dropped');
            assertTrue(c.has(3), 'row 3 (frame 3) kept — end is exclusive');
            assertTrue(c.has(4), 'row 4 (frame 4) kept');
        });
    });

    describe('SioLazyLoader.capInternalCaches', function () {
        it('evicts typed frames far from the current frame once past maxKeep', function () {
            // frames 0..9 in rows 0..9; maxKeep=3, currentFrame=5 → keep |f-5|<=3
            const loader = makeLoader([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]]);
            loader.capInternalCaches(5, 3);
            const c = lflCache(loader, 'cam0');
            // kept: frames 2..8 (rows 2..8); dropped: 0,1,9 (rows 0,1,9)
            assertFalse(c.has(0), 'far frame 0 dropped');
            assertFalse(c.has(1), 'far frame 1 dropped');
            assertTrue(c.has(2), 'boundary frame 2 kept');
            assertTrue(c.has(8), 'boundary frame 8 kept');
            assertFalse(c.has(9), 'far frame 9 dropped');
        });

        it('is a no-op when the cache is within maxKeep', function () {
            const loader = makeLoader([[0, 1, 2]]);
            loader.capInternalCaches(0, 1000);
            assertEqual(lflCache(loader, 'cam0').size, 3, 'nothing dropped under cap');
        });
    });

    describe('SioLazyLoader.close', function () {
        it('clears the internal per-camera typed-frame caches too', function () {
            const loader = makeLoader([[0, 1, 2], [0, 1, 2]]);
            const c0 = lflCache(loader, 'cam0');
            const c1 = lflCache(loader, 'cam1');
            loader.close();
            assertEqual(c0.size, 0, 'cam0 internal cache cleared');
            assertEqual(c1.size, 0, 'cam1 internal cache cleared');
            assertEqual(loader.labelsByCam.size, 0, 'labelsByCam cleared');
        });
    });
})();
