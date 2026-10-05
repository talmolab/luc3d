/**
 * test-timeline-playback-playhead.js — the timeline's playback fast path.
 *
 * During playback `ui/rendering.js` calls `timeline.setCurrentFrame(f,
 * { playback: true })`. Only the playhead depends on the current frame, so the
 * timeline restores a snapshot of everything below the playhead (taken by its
 * last full `redraw()`) and draws just the playhead, instead of repainting
 * every track bar / marker / label — a full redraw on a 175-track project cost
 * ~4.5 ms plus a forced style recalc inside the video-frame callback, which
 * made playback drop frames (tests/e2e/_bench-playback.mjs).
 *
 * The risk of such a cache is showing something stale, so these compare the
 * canvas against a full redraw — bit-exactly where a snapshot is blitted, and
 * by mean difference where the two sides are independently rasterized (see
 * MAX_MEAN_DIFF) — plus the fallbacks (scrolled window, resized canvas) and
 * that leaving playback mode drops the cache and redraws in full.
 *
 * Browser-only: needs a real 2D canvas for getImageData.
 */
(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertTrue = TF.assertTrue;
    var assertEqual = TF.assertEqual;

    function createContainer(width, height) {
        var div = document.createElement('div');
        div.style.width = width + 'px';
        div.style.height = height + 'px';
        div.style.position = 'fixed';
        div.style.top = '-9999px';
        div.style.left = '0';
        div.style.display = 'flex';
        div.style.flexDirection = 'column';
        document.body.appendChild(div);
        return div;
    }

    function buildSession(numTracks, nFrames) {
        var skel = new Skeleton('s', ['a', 'b'], [[0, 1]]);
        var cam = new Camera('camA', [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0], [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0], [640, 480]);
        var trackNames = [];
        for (var t = 0; t < numTracks; t++) trackNames.push('track_' + t);
        var session = new Session([cam], skel, trackNames);
        session._uploadedCameras = ['camA'];
        // Varied, gappy occupancy so the track bars are not a flat fill.
        for (var f = 0; f < nFrames; f++) {
            var fg = new FrameGroup(f);
            for (var t2 = 0; t2 < numTracks; t2++) {
                if ((f + 7 * t2) % 11 === 0) continue;
                var inst = new Instance([[10, 10], [20, 20]], f, 'predicted', 1);
                inst.trackIdx = t2;
                fg.addInstance('camA', inst);
            }
            session.addFrameGroup(fg);
        }
        return session;
    }

    function make() {
        var container = createContainer(700, 160);
        var tl = new Timeline(container, { totalFrames: 300 });
        tl.setData(buildSession(6, 300));
        tl.resize();
        return { tl: tl, container: container };
    }

    function cleanup(o) {
        if (o.tl) o.tl.destroy();
        if (o.container && o.container.parentNode) o.container.remove();
    }

    function pixels(tl) {
        var c = tl._canvas;
        return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    }

    // Bit-equality — the contract for the blit cases: restoring a snapshot
    // reproduces the bytes exactly, so anything else is a real defect.
    function samePixels(a, b) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    // Mean absolute per-channel difference (0..255).
    function meanAbsDiff(a, b) {
        if (a.length !== b.length) return Infinity;
        var sum = 0;
        for (var i = 0; i < a.length; i++) sum += a[i] > b[i] ? a[i] - b[i] : b[i] - a[i];
        return sum / a.length;
    }

    // The two FALLBACK cases cannot use bit-equality: they rasterize the same
    // vector content twice and compare the passes. Chrome serves the first
    // couple of getImageData calls on a canvas from the GPU and then gives up
    // on acceleration and re-rasterizes in software, and the two engines do
    // not agree to the byte (~13% of bytes differ, nearly all by 1/255); a
    // real GPU is also not bit-reproducible once `setZoom` puts content on
    // fractional device pixels (12 bytes differing by up to 15/255 at dpr 2 —
    // which is why a fixed per-channel tolerance fitted at dpr 1 still failed
    // on a Retina display). Compare by MEAN difference, not by bytes: byte
    // counts do not separate the cases (same content across rasterizers moved
    // 62,637 bytes, a genuinely stale frame 82,874), but the mean does —
    // at most 0.27/255 versus 5.2/255, twenty times clear, in every
    // configuration measured (headless/headed x dpr 1/2, Chromium and Chrome).
    var MAX_MEAN_DIFF = 1.0;

    // Count full redraws via the most expensive layer.
    function spyTrackBars(tl) {
        var n = { count: 0 };
        var orig = tl._drawTrackBars;
        tl._drawTrackBars = function () { n.count++; return orig.apply(this, arguments); };
        return n;
    }

    describe('Timeline playback playhead fast path', function () {

        it('moves the playhead without a full redraw, pixel-identical to one', function () {
            var o = make();
            try {
                o.tl.setCurrentFrame(40, { playback: true });   // enters playback mode: full redraw + snapshot
                var spy = spyTrackBars(o.tl);
                o.tl.setCurrentFrame(120, { playback: true });  // fast path
                assertEqual(spy.count, 0, 'fast path must not repaint the track bars');
                var fast = pixels(o.tl);
                o.tl.redraw();                                   // reference: full redraw at the same frame
                assertEqual(spy.count, 1, 'reference redraw ran');
                // Equality also proves the snapshot excluded the OLD playhead
                // (frame 40): had it been baked in, the fast frame would show two.
                assertTrue(samePixels(fast, pixels(o.tl)), 'fast-path canvas == full redraw canvas');
            } finally { cleanup(o); }
        });

        it('stays correct across many fast steps', function () {
            var o = make();
            try {
                o.tl.setCurrentFrame(0, { playback: true });
                for (var f = 1; f <= 60; f++) o.tl.setCurrentFrame(f * 4, { playback: true });
                var fast = pixels(o.tl);
                o.tl.redraw();
                assertTrue(samePixels(fast, pixels(o.tl)), 'canvas after 60 fast steps == full redraw');
            } finally { cleanup(o); }
        });

        it('falls back to a full redraw when the visible window scrolls', function () {
            var o = make();
            try {
                o.tl.setZoom(10);   // ~30 frames visible
                o.tl.setCurrentFrame(5, { playback: true });
                var spy = spyTrackBars(o.tl);
                var scroll0 = o.tl._scrollFrame;
                o.tl.setCurrentFrame(200, { playback: true });   // far outside the window
                assertTrue(o.tl._scrollFrame !== scroll0, 'window scrolled to follow the playhead');
                assertEqual(spy.count, 1, 'scrolled window must be fully redrawn, not blitted');
                var fast = pixels(o.tl);
                o.tl.redraw();
                assertTrue(meanAbsDiff(fast, pixels(o.tl)) <= MAX_MEAN_DIFF, 'scrolled frame == full redraw');
            } finally { cleanup(o); }
        });

        it('re-snapshots after a resize during playback', function () {
            var o = make();
            try {
                o.tl.setCurrentFrame(10, { playback: true });
                o.container.style.width = '520px';
                o.tl.resize();                                   // full redraw at the new size (re-snapshots)
                var spy = spyTrackBars(o.tl);
                o.tl.setCurrentFrame(90, { playback: true });
                assertEqual(spy.count, 0, 'fast path still used after resize');
                var fast = pixels(o.tl);
                o.tl.redraw();
                assertTrue(meanAbsDiff(fast, pixels(o.tl)) <= MAX_MEAN_DIFF, 'post-resize fast frame == full redraw');
            } finally { cleanup(o); }
        });

        it('leaving playback mode drops the cache and redraws in full, even on the same frame', function () {
            var o = make();
            try {
                o.tl.setCurrentFrame(10, { playback: true });
                o.tl.setCurrentFrame(50, { playback: true });
                assertTrue(!!o.tl._staticCache, 'snapshot exists while playing');
                var spy = spyTrackBars(o.tl);
                o.tl.setCurrentFrame(50);                        // stopPlayback's settle call: same frame, no flag
                assertEqual(spy.count, 1, 'stop forces one full redraw');
                assertEqual(o.tl._staticCache, null, 'snapshot released');
                assertEqual(o.tl._playbackMode, false, 'playback mode cleared');
                o.tl.setCurrentFrame(60);                        // ordinary step: still a full redraw
                assertEqual(spy.count, 2, 'non-playback steps always fully redraw');
            } finally { cleanup(o); }
        });
    });
})();
