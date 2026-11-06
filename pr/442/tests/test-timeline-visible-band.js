/**
 * test-timeline-visible-band.js — the timeline canvas covers only a BAND of its
 * content around the visible rows, not the whole content height.
 *
 * The canvas used to be the timeline's full content height inside the scroll
 * wrapper: on a 17-camera, 561-row project 3,600 x 12,704 device pixels
 * (~183 MB), every redraw rasterizing all of it though the wrapper showed about
 * a sixth. Now a spacer carries the content height (so the scroll range and the
 * native scrolling are unchanged), and the canvas is a band — the visible
 * height plus one margin above and below — positioned in content coordinates.
 * A scroll that nears the band's edge re-centres it and redraws.
 *
 * What would go wrong, and is checked here:
 *  - the band showing the wrong rows (drawing not in content coordinates):
 *    pixels in the band must equal a full-height reference canvas's pixels
 *    at the same content rows;
 *  - the scroll range shrinking (the spacer not carrying the height);
 *  - a scroll past the band not moving it (blank rows), or a scroll inside it
 *    redrawing for nothing;
 *  - the playhead element no longer lining up with the rows.
 *
 * Browser-only: needs a real 2D canvas and real layout/scrolling.
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

    // Many cameras x tracks, so the content is far taller than the container.
    function buildTallSession(cams, tracksPerCam, nFrames) {
        var skel = new Skeleton('s', ['a', 'b'], [[0, 1]]);
        var cameras = [], names = [];
        for (var c = 0; c < cams; c++) {
            cameras.push(new Camera('cam' + c, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0], [640, 480]));
        }
        for (var t = 0; t < tracksPerCam; t++) names.push('track_' + t);
        var session = new Session(cameras, skel, names);
        session._uploadedCameras = cameras.map(function (x) { return x.name; });
        for (var f = 0; f < nFrames; f++) {
            var fg = new FrameGroup(f);
            for (var ci = 0; ci < cams; ci++) {
                for (var tt = 0; tt < tracksPerCam; tt++) {
                    if ((f + 3 * tt + 5 * ci) % 7 === 0) continue;
                    var inst = new Instance([[10, 10], [20, 20]], f, 'predicted', 1);
                    inst.trackIdx = tt;
                    fg.addInstance('cam' + ci, inst);
                }
            }
            session.addFrameGroup(fg);
        }
        return session;
    }

    function make(h) {
        var container = createContainer(700, h || 150);
        var tl = new Timeline(container, { totalFrames: 200 });
        tl.setData(buildTallSession(8, 10, 200));
        // setData sizes the container to its 30%-of-window fit; pin it small
        // so the content overflows by a wide margin.
        container.style.height = (h || 150) + 'px';
        tl.resize();
        return { tl: tl, container: container };
    }

    function cleanup(o) {
        if (o.tl) o.tl.destroy();
        if (o.container && o.container.parentNode) o.container.remove();
    }

    // A full-height reference rendering of the same timeline: the old
    // behaviour (one canvas = whole content), drawn by the same redraw().
    function referenceRows(tl, contentTop, rows) {
        var ref = document.createElement('canvas');
        var dpr = tl._effDpr;
        ref.width = tl._canvas.width;
        ref.height = Math.floor(tl._cssHeight * dpr);
        var saved = { ctx: tl._ctx, top: tl._bandTop, h: tl._bandHeight };
        tl._ctx = ref.getContext('2d');
        tl._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        tl._bandTop = 0; tl._bandHeight = tl._cssHeight;
        tl.redraw();
        tl._ctx = saved.ctx; tl._bandTop = saved.top; tl._bandHeight = saved.h;
        tl.redraw();
        return ref.getContext('2d').getImageData(0, Math.round(contentTop * dpr), ref.width, rows).data;
    }
    function bandRows(tl, contentTop, rows) {
        var dpr = tl._effDpr;
        return tl._canvas.getContext('2d').getImageData(0, Math.round((contentTop - tl._bandTop) * dpr), tl._canvas.width, rows).data;
    }
    function meanAbsDiff(a, b) {
        if (a.length !== b.length) return Infinity;
        var sum = 0;
        for (var i = 0; i < a.length; i++) sum += a[i] > b[i] ? a[i] - b[i] : b[i] - a[i];
        return sum / a.length;
    }
    // Two independently rasterized canvases are not byte-identical in Chrome
    // (GPU vs software readback); a genuinely different picture differs by
    // several /255 on average. Same rule as test-timeline-playback-playhead.js.
    var MAX_MEAN_DIFF = 1.0;

    function spyTrackBars(tl) {
        var n = { count: 0 };
        var orig = tl._drawTrackBars;
        tl._drawTrackBars = function () { n.count++; return orig.apply(this, arguments); };
        return n;
    }

    function scrollTo(tl, top) {
        tl._trackScrollEl.scrollTop = top;
        tl._handleTrackScroll();    // the 'scroll' event's handler, run synchronously
    }

    describe('Timeline visible band', function () {

        it('precondition: the content is much taller than the visible area', function () {
            var o = make();
            try {
                assertTrue(o.tl._cssHeight > 4 * o.tl._viewHeight,
                    'content ' + o.tl._cssHeight + ' px vs visible ' + o.tl._viewHeight + ' px');
            } finally { cleanup(o); }
        });

        it('the canvas is a band, and the spacer keeps the full scroll range', function () {
            var o = make();
            try {
                var tl = o.tl, viewH = tl._viewHeight;
                assertEqual(tl._spacerEl.style.height, tl._cssHeight + 'px', 'spacer = content height');
                assertTrue(tl._trackScrollEl.scrollHeight >= tl._cssHeight,
                    'scroll range is the whole content (' + tl._trackScrollEl.scrollHeight + ')');
                var bandH = parseFloat(tl._canvas.style.height);
                assertTrue(bandH < tl._cssHeight, 'band ' + bandH + ' px < content ' + tl._cssHeight + ' px');
                assertTrue(bandH <= viewH + 2 * Math.max(viewH, 256) + 1, 'band at most visible + 2 margins');
                assertEqual(tl._canvas.height, Math.floor(bandH * tl._effDpr), 'backing store = band x dpr');
            } finally { cleanup(o); }
        });

        it('draws the band in content coordinates: same pixels as a full-height canvas', function () {
            var o = make();
            try {
                var tl = o.tl;
                scrollTo(tl, Math.round(tl._cssHeight * 0.45));      // middle of the content
                var top = tl._trackScrollEl.scrollTop;
                assertTrue(top >= tl._bandTop && top + tl._viewHeight <= tl._bandTop + tl._bandHeight,
                    'the visible rows are inside the band (band ' + tl._bandTop + '+' + tl._bandHeight + ', view ' + top + ')');
                var rows = Math.floor(tl._viewHeight * tl._effDpr) - 2;
                var d = meanAbsDiff(bandRows(tl, top, rows), referenceRows(tl, top, rows));
                assertTrue(d <= MAX_MEAN_DIFF, 'visible rows match the full-height reference (mean diff ' + d.toFixed(3) + '/255)');
            } finally { cleanup(o); }
        });

        it('a scroll inside the band costs no redraw; past it, the band follows and redraws', function () {
            var o = make();
            try {
                var tl = o.tl;
                scrollTo(tl, 0);
                var spy = spyTrackBars(tl);
                scrollTo(tl, 10);                                    // well inside the band
                assertEqual(spy.count, 0, 'small scroll: no redraw');
                var far = tl._cssHeight - tl._viewHeight;            // the bottom
                scrollTo(tl, far);
                assertEqual(spy.count, 1, 'scroll past the band: one redraw');
                assertTrue(far >= tl._bandTop && far + tl._viewHeight <= tl._bandTop + tl._bandHeight + 1,
                    'the band now covers the bottom rows (band ' + tl._bandTop + '+' + tl._bandHeight + ')');
                assertEqual(tl._canvas.style.top, tl._bandTop + 'px', 'the canvas sits at the band top');
                var rows = Math.floor(tl._viewHeight * tl._effDpr) - 2;
                var d = meanAbsDiff(bandRows(tl, far, rows), referenceRows(tl, far, rows));
                assertTrue(d <= MAX_MEAN_DIFF, 'bottom rows (labels included) match the reference (mean diff ' + d.toFixed(3) + '/255)');
            } finally { cleanup(o); }
        });

        it('the playhead element still spans the content rows', function () {
            var o = make();
            try {
                var tl = o.tl;
                tl.setCurrentFrame(120);
                var lay = tl._layout;
                assertEqual(parseFloat(tl._playheadLineEl.style.height), lay.labelAreaTop,
                    'line runs to the label area at the bottom of the CONTENT, not of the band');
                assertEqual(tl._playheadEl.parentNode, tl._trackScrollEl, 'scrolls with the rows');
            } finally { cleanup(o); }
        });

        it('a content that fits needs no band: the canvas is the whole of it', function () {
            var container = createContainer(700, 400);
            var tl = new Timeline(container, { totalFrames: 200 });
            try {
                tl.setData(buildTallSession(1, 3, 200));
                container.style.height = '400px';
                tl.resize();
                assertEqual(tl._bandTop, 0, 'band at the top');
                assertEqual(tl._bandHeight, tl._cssHeight, 'band = content');
            } finally {
                tl.destroy();
                container.remove();
            }
        });
    });
})();
