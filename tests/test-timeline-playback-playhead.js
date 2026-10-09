/**
 * test-timeline-playback-playhead.js — the timeline's playhead is an ELEMENT,
 * not canvas paint, so changing frame repaints nothing.
 *
 * The playhead is the only frame-dependent thing on the timeline. It used to be
 * painted into the canvas, so every frame step — and every playback frame, which
 * needed its own snapshot-and-blit fast path — repainted every track bar, marker
 * and label to move it. On a 17-camera, 561-row project the canvas is
 * 3,600 x 12,704 device pixels; repainting it on each step of a held arrow key
 * outran the GPU at a Retina scale factor, and Chrome's 2D-canvas rate limiter
 * then blocked the page for 230-450 ms every ~0.6 s (traced:
 * `CanvasRenderingContext2D::FinalizeFrame` -> "GPU backpressure"). Now
 * `setCurrentFrame` moves a positioned element (`_positionPlayhead`) and the
 * canvas is repainted only when what it shows changes.
 *
 * What would go wrong, and is checked here:
 *  - a frame step still repainting the canvas (the regression itself);
 *  - the old painted playhead left in the canvas (two playheads, or one stuck);
 *  - the element at the wrong place or length, or shown off-window;
 *  - a scroll of the visible window NOT repainting (bars would not follow);
 *  - a "modified" flag set without a redraw never appearing — frame steps used
 *    to be what made it show (`setFrameModified` now asks for one, coalesced).
 *
 * Browser-only: needs a real 2D canvas for getImageData and real layout.
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

    function samePixels(a, b) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    // The canvas columns within 2 CSS px of x, over the track area (above the
    // label area). Wide enough to cover a 2.5 px line or a 1 px dense bin
    // whichever device pixel it rounds to.
    function columnPixels(tl, cssX) {
        var c = tl._canvas;
        var scale = c.width / tl._cssWidth;
        var x0 = Math.max(0, Math.round((cssX - 2) * scale));
        var w = Math.max(1, Math.round(4 * scale));
        var bottom = Math.floor(((tl._layout && tl._layout.showLabels) ? tl._layout.labelAreaTop : tl._cssHeight) * scale) - 8;
        return c.getContext('2d').getImageData(x0, 0, w, Math.max(1, bottom)).data;
    }
    // Pure-white pixels there. The track bars and background are never pure
    // white; the old painted playhead was (#ffffff at full opacity).
    function whiteInColumn(tl, cssX) {
        var col = columnPixels(tl, cssX), n = 0;
        for (var i = 0; i < col.length; i += 4) if (col[i] === 255 && col[i + 1] === 255 && col[i + 2] === 255) n++;
        return n;
    }
    // Summed brightness there — the "modified" lines are white at 70-85%
    // opacity, so they brighten the column without being pure white.
    function columnBrightness(tl, cssX) {
        var col = columnPixels(tl, cssX), sum = 0;
        for (var i = 0; i < col.length; i += 4) sum += col[i] + col[i + 1] + col[i + 2];
        return sum;
    }

    function playheadX(tl) {
        var m = /translateX\(([-\d.]+)px\)/.exec(tl._playheadEl.style.transform || '');
        return m ? parseFloat(m[1]) : NaN;
    }
    function near(a, b) { return Math.abs(a - b) < 1e-6; }

    // Count full repaints via the most expensive layer.
    function spyTrackBars(tl) {
        var n = { count: 0 };
        var orig = tl._drawTrackBars;
        tl._drawTrackBars = function () { n.count++; return orig.apply(this, arguments); };
        return n;
    }

    function nextFrame() {
        return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
    }

    describe('Timeline playhead element', function () {

        it('a frame step moves the playhead element and repaints nothing', function () {
            var o = make();
            try {
                o.tl.setCurrentFrame(40);
                var spy = spyTrackBars(o.tl);
                var before = pixels(o.tl);
                o.tl.setCurrentFrame(120);
                assertEqual(spy.count, 0, 'a frame step must not repaint the track bars');
                assertTrue(samePixels(before, pixels(o.tl)), 'the canvas is untouched by a frame step');
                assertEqual(o.tl._playheadEl.style.display, 'block', 'playhead shown');
                assertTrue(near(playheadX(o.tl), o.tl._frameToX(120.5)),
                    'playhead at frame 120 (' + playheadX(o.tl) + ' vs ' + o.tl._frameToX(120.5) + ')');
            } finally { cleanup(o); }
        });

        it('stays right across many steps, with no repaint', function () {
            var o = make();
            try {
                o.tl.setCurrentFrame(0);
                var spy = spyTrackBars(o.tl);
                for (var f = 1; f <= 60; f++) o.tl.setCurrentFrame(f * 4);
                assertEqual(spy.count, 0, '60 steps, no repaint');
                assertTrue(near(playheadX(o.tl), o.tl._frameToX(240.5)), 'playhead at the last frame');
            } finally { cleanup(o); }
        });

        it('the canvas carries no playhead: its paint does not depend on the frame', function () {
            var o = make();
            try {
                o.tl.setCurrentFrame(40);
                o.tl.redraw();
                var x40 = o.tl._frameToX(40.5);
                assertEqual(whiteInColumn(o.tl, x40), 0, 'no white playhead painted at frame 40');
                o.tl.setCurrentFrame(200);
                o.tl.redraw();
                assertEqual(whiteInColumn(o.tl, x40), 0, 'nothing left behind at frame 40 either');
                assertEqual(whiteInColumn(o.tl, o.tl._frameToX(200.5)), 0, 'and none painted at frame 200');
            } finally { cleanup(o); }
        });

        it('has the painted playhead\'s geometry: a line to the label area, a triangle on its foot', function () {
            var o = make();
            try {
                o.tl.setCurrentFrame(77);
                var lay = o.tl._layout;
                var bottom = lay.showLabels ? lay.labelAreaTop : o.tl._cssHeight;
                assertEqual(parseFloat(o.tl._playheadLineEl.style.height), bottom, 'line runs to the label area');
                assertEqual(parseFloat(o.tl._playheadHeadEl.style.top), bottom - 6, 'triangle stands on the line\'s foot');
                assertEqual(o.tl._playheadLineEl.style.width, '2.5px', 'line width as painted (2.5 px)');
                assertEqual(o.tl._playheadEl.parentNode, o.tl._trackScrollEl, 'inside the scroll wrapper, so it scrolls with the rows');
                assertEqual(o.tl._playheadEl.style.pointerEvents, 'none', 'the canvas keeps every pointer event');
            } finally { cleanup(o); }
        });

        it('following the frame out of a zoomed window scrolls it AND repaints', function () {
            var o = make();
            try {
                o.tl.setZoom(10);   // ~30 frames visible
                o.tl.setCurrentFrame(5);
                var spy = spyTrackBars(o.tl);
                var scroll0 = o.tl._scrollFrame;
                o.tl.setCurrentFrame(200);
                assertTrue(o.tl._scrollFrame !== scroll0, 'window scrolled to follow the playhead');
                assertEqual(spy.count, 1, 'a scrolled window is repainted (the bars moved)');
                assertTrue(near(playheadX(o.tl), o.tl._frameToX(200.5)), 'playhead at frame 200 in the new window');
                o.tl.setCurrentFrame(199);                      // 200 is the window's last frame; 199 is inside it
                assertEqual(spy.count, 1, 'a step inside the window repaints nothing');
            } finally { cleanup(o); }
        });

        it('is hidden when the frame is outside the visible window', function () {
            var o = make();
            try {
                o.tl.setZoom(10);
                o.tl.setCurrentFrame(5);
                assertEqual(o.tl._playheadEl.style.display, 'block', 'shown in the window');
                o.tl._scrollFrame = 200;    // pan away (what drag / wheel / scrollbar do)
                o.tl._clampScroll();
                o.tl.redraw();
                assertEqual(o.tl._playheadEl.style.display, 'none', 'hidden once its frame is off-window');
            } finally { cleanup(o); }
        });

        it('a resize re-lays it out', function () {
            var o = make();
            try {
                o.tl.setCurrentFrame(150);
                o.container.style.width = '520px';
                o.container.style.height = '220px';
                o.tl.resize();
                var lay = o.tl._layout;
                var bottom = lay.showLabels ? lay.labelAreaTop : o.tl._cssHeight;
                assertTrue(near(playheadX(o.tl), o.tl._frameToX(150.5)), 'x follows the new width');
                assertEqual(parseFloat(o.tl._playheadLineEl.style.height), bottom, 'length follows the new height');
            } finally { cleanup(o); }
        });

        it('the playback flag changes nothing: no repaint either', function () {
            var o = make();
            try {
                o.tl.setCurrentFrame(10, { playback: true });
                var spy = spyTrackBars(o.tl);
                for (var f = 11; f <= 40; f++) o.tl.setCurrentFrame(f, { playback: true });
                o.tl.setCurrentFrame(40);                       // stopPlayback's settle call: same frame
                o.tl.setCurrentFrame(41);
                assertEqual(spy.count, 0, 'playback frames, the settle call and a step: no repaint');
                assertTrue(near(playheadX(o.tl), o.tl._frameToX(41.5)), 'playhead at frame 41');
            } finally { cleanup(o); }
        });

        it('a click on the timeline moves the playhead without a repaint', function () {
            var o = make();
            try {
                var spy = spyTrackBars(o.tl);
                var rect = o.tl._canvas.getBoundingClientRect();
                o.tl._handleMouseDown({ button: 0, offsetX: 400, offsetY: 20, shiftKey: false, preventDefault: function () {} });
                o.tl._handleMouseUp({ button: 0, clientX: rect.left + 400, clientY: rect.top + 20 });
                assertEqual(spy.count, 0, 'no repaint for a click');
                assertTrue(near(playheadX(o.tl), o.tl._frameToX(o.tl._currentFrame + 0.5)), 'playhead at the clicked frame');
            } finally { cleanup(o); }
        });

        it('setFrameModified repaints once, on the next frame, and the white line appears', async function () {
            var o = make();
            try {
                o.tl.setCurrentFrame(20);
                await nextFrame();                              // let the ResizeObserver's first callback (a resize = a repaint) land
                var spy = spyTrackBars(o.tl);
                var x = o.tl._frameToX(150.5);
                var before = columnBrightness(o.tl, x);
                o.tl.setFrameModified(150, true);
                o.tl.setFrameModified(150, true);               // unchanged: no further request
                o.tl.setFrameModified(151, true);
                assertEqual(spy.count, 0, 'not synchronous');
                await nextFrame();
                assertEqual(spy.count, 1, 'one coalesced repaint for three calls');
                var after = columnBrightness(o.tl, x);
                assertTrue(after > before * 1.2, 'the modified line at frame 150 is painted (brightness ' + before + ' -> ' + after + ')');
                o.tl.setFrameModified(150, true);               // already set
                await nextFrame();
                assertEqual(spy.count, 1, 'setting an already-set flag asks for nothing');
            } finally { cleanup(o); }
        });
    });
})();
