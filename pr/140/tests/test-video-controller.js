/**
 * test-video-controller.js - Tests for VideoController (video.js)
 *
 * Tests: seekToFrame, scrubToFrame, togglePlayback, startPlayback, stopPlayback,
 * zoom/pan helpers, and callback invocation.
 * Uses mock decoders (no real video files needed).
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertNotNull,
        assertTrue, assertFalse, assertGreaterThan } = TestFramework;

    // Mock decoder - simulates OnDemandVideoDecoder without real video
    function createMockDecoder(width, height, totalFrames) {
        var w = width || 640;
        var h = height || 480;
        // Create a real offscreen canvas that drawImage can accept
        var offCanvas = document.createElement('canvas');
        offCanvas.width = w;
        offCanvas.height = h;

        return {
            samples: new Array(totalFrames || 100),
            _fps: 30,
            _videoReady: true,
            videoTrack: { video: { width: w, height: h } },
            cache: new Map(),
            lastSeekedFrame: null,
            playingNative: false,
            pausedNative: false,
            _mockCanvas: offCanvas,

            getFrame: function (frameIndex) {
                this.lastSeekedFrame = frameIndex;
                // Return a canvas element (valid for drawImage)
                return Promise.resolve(this._mockCanvas);
            },
            drawCurrentFrame: function (ctx, w, h) {
                // Mock: just fill with a color
                return true;
            },
            getCurrentFrameIndex: function () {
                return this.lastSeekedFrame || 0;
            },
            playNative: function () {
                this.playingNative = true;
            },
            pauseNative: function () {
                this.pausedNative = true;
                this.playingNative = false;
            },
            seekNative: function (frameIndex) {
                this.lastSeekedFrame = frameIndex;
            },
        };
    }

    // Mock canvas with a stubbed 2d context
    function createMockCanvas(width, height) {
        var canvas = document.createElement('canvas');
        canvas.width = width || 640;
        canvas.height = height || 480;
        return canvas;
    }

    function createMockView(name, width, height, totalFrames) {
        var canvas = createMockCanvas(width, height);
        var overlayCanvas = createMockCanvas(width, height);
        return {
            name: name || 'cam1',
            decoder: createMockDecoder(width, height, totalFrames),
            canvas: canvas,
            ctx: canvas.getContext('2d'),
            overlayCanvas: overlayCanvas,
            overlayCtx: overlayCanvas.getContext('2d'),
            videoWidth: width || 640,
            videoHeight: height || 480,
        };
    }

    function createTestState(numViews, totalFrames) {
        numViews = numViews || 1;
        totalFrames = totalFrames || 100;
        var views = [];
        for (var i = 0; i < numViews; i++) {
            views.push(createMockView('cam' + i, 640, 480, totalFrames));
        }
        return {
            views: views,
            currentFrame: 0,
            totalFrames: totalFrames,
            fps: 30,
            isPlaying: false,
            playInterval: null,
        };
    }

    describe('VideoController - Construction', function () {
        it('creates controller with state and callbacks', function () {
            var state = createTestState();
            var ctrl = new VideoController(state, {});
            assertNotNull(ctrl);
            assertEqual(ctrl.state, state);
        });
    });

    describe('VideoController - seekToFrame', function () {
        var state, ctrl, overlaysCalled, seekbarFrame;

        beforeEach(function () {
            overlaysCalled = false;
            seekbarFrame = -1;
            state = createTestState(2, 100);
            ctrl = new VideoController(state, {
                drawOverlays: function (f) { overlaysCalled = true; },
                updateSeekbar: function (f) { seekbarFrame = f; },
            });
        });

        it('updates state.currentFrame', async function () {
            await ctrl.seekToFrame(42);
            assertEqual(state.currentFrame, 42);
        });

        it('clamps negative frames to 0', async function () {
            await ctrl.seekToFrame(-5);
            assertEqual(state.currentFrame, 0);
        });

        it('clamps frames exceeding total to totalFrames-1', async function () {
            await ctrl.seekToFrame(999);
            assertEqual(state.currentFrame, 99);
        });

        it('calls drawOverlays callback', async function () {
            await ctrl.seekToFrame(10);
            assertTrue(overlaysCalled, 'drawOverlays should be called');
        });

        it('calls updateSeekbar callback with correct frame', async function () {
            await ctrl.seekToFrame(25);
            assertEqual(seekbarFrame, 25);
        });

        it('seeks all views in parallel', async function () {
            await ctrl.seekToFrame(33);
            for (var i = 0; i < state.views.length; i++) {
                assertEqual(state.views[i].decoder.lastSeekedFrame, 33,
                    'View ' + i + ' should seek to frame 33');
            }
        });
    });

    describe('VideoController - scrubToFrame', function () {
        var state, ctrl, seekbarFrame;

        beforeEach(function () {
            seekbarFrame = -1;
            state = createTestState(1, 100);
            ctrl = new VideoController(state, {
                updateSeekbar: function (f) { seekbarFrame = f; },
            });
        });

        it('scrubs to target frame', async function () {
            ctrl.scrubToFrame(50);
            // Wait for async processing
            await new Promise(function (r) { setTimeout(r, 50); });
            assertEqual(state.currentFrame, 50);
        });

        it('coalesces rapid scrub requests', async function () {
            // Fire multiple scrubs rapidly
            ctrl.scrubToFrame(10);
            ctrl.scrubToFrame(20);
            ctrl.scrubToFrame(30);
            ctrl.scrubToFrame(40);
            // Wait for processing
            await new Promise(function (r) { setTimeout(r, 100); });
            // Should end at last target (40), possibly skipping intermediate
            assertEqual(state.currentFrame, 40, 'Should end at last scrub target');
        });
    });

    describe('VideoController - Playback', function () {
        var state, ctrl, playbackState;

        beforeEach(function () {
            playbackState = null;
            state = createTestState(2, 100);
            ctrl = new VideoController(state, {
                onPlaybackStateChange: function (isPlaying) { playbackState = isPlaying; },
                drawOverlays: function () {},
                updateSeekbar: function () {},
            });
        });

        it('togglePlayback starts playback when stopped', function () {
            assertFalse(state.isPlaying);
            ctrl.togglePlayback();
            assertTrue(state.isPlaying, 'Should be playing after toggle');
            assertTrue(playbackState, 'Callback should report playing');
            ctrl.stopPlayback(); // cleanup
        });

        it('togglePlayback stops playback when playing', function () {
            ctrl.startPlayback();
            assertTrue(state.isPlaying);
            ctrl.togglePlayback();
            assertFalse(state.isPlaying, 'Should be stopped after toggle');
            assertFalse(playbackState, 'Callback should report stopped');
        });

        it('startPlayback does nothing if already playing', function () {
            ctrl.startPlayback();
            assertTrue(state.isPlaying);
            ctrl.startPlayback(); // should not error
            assertTrue(state.isPlaying);
            ctrl.stopPlayback();
        });

        it('startPlayback calls playNative on decoders', function () {
            ctrl.startPlayback();
            for (var i = 0; i < state.views.length; i++) {
                assertTrue(state.views[i].decoder.playingNative,
                    'Decoder ' + i + ' should be playing');
            }
            ctrl.stopPlayback();
        });

        it('stopPlayback calls pauseNative on decoders', function () {
            ctrl.startPlayback();
            ctrl.stopPlayback();
            for (var i = 0; i < state.views.length; i++) {
                assertTrue(state.views[i].decoder.pausedNative,
                    'Decoder ' + i + ' should be paused');
            }
        });

        it('stopPlayback cancels animation frame', function () {
            ctrl.startPlayback();
            assertNotNull(ctrl._playRAF, 'Should have RAF handle');
            ctrl.stopPlayback();
            // _playRAF should be cleared
            assertTrue(ctrl._playRAF === null || ctrl._playRAF === undefined,
                'RAF handle should be cleared');
        });
    });

    describe('VideoController - Zoom', function () {
        var state, ctrl;

        beforeEach(function () {
            state = createTestState(2, 100);
            ctrl = new VideoController(state, {});
        });

        it('initZoom sets default zoom state', function () {
            var view = state.views[0];
            ctrl.initZoom(view);
            assertNotNull(view.zoom);
            assertEqual(view.zoom.scale, 1.0);
            assertEqual(view.zoom.offsetX, 0);
            assertEqual(view.zoom.offsetY, 0);
        });

        it('zoomVideo changes scale', function () {
            var view = state.views[0];
            ctrl.initZoom(view);
            ctrl.zoomVideo(view, 2.0);
            assertEqual(view.zoom.scale, 2.0);
        });

        it('zoomVideo clamps scale to range [0.25, 10]', function () {
            var view = state.views[0];
            ctrl.initZoom(view);
            ctrl.zoomVideo(view, 100); // would be 100x
            assertEqual(view.zoom.scale, 10, 'Should clamp to 10');
            ctrl.zoomVideo(view, 0.001); // would be 0.01
            assertTrue(view.zoom.scale >= 0.25, 'Should not go below 0.25');
        });

        it('resetZoom restores default', function () {
            var view = state.views[0];
            ctrl.initZoom(view);
            ctrl.zoomVideo(view, 3.0);
            ctrl.resetZoom(view);
            assertEqual(view.zoom.scale, 1.0);
            assertEqual(view.zoom.offsetX, 0);
            assertEqual(view.zoom.offsetY, 0);
        });

        it('zoomAllVideos applies to all views', function () {
            ctrl.initZoom(state.views[0]);
            ctrl.initZoom(state.views[1]);
            ctrl.zoomAllVideos(2.0);
            for (var i = 0; i < state.views.length; i++) {
                assertEqual(state.views[i].zoom.scale, 2.0,
                    'View ' + i + ' should be at 2x zoom');
            }
        });

        it('resetAllZoom resets all views', function () {
            ctrl.initZoom(state.views[0]);
            ctrl.initZoom(state.views[1]);
            ctrl.zoomAllVideos(3.0);
            ctrl.resetAllZoom();
            for (var i = 0; i < state.views.length; i++) {
                assertEqual(state.views[i].zoom.scale, 1.0,
                    'View ' + i + ' should be at 1x zoom');
            }
        });

        it('zoomVideo with cursor position adjusts offset', function () {
            var view = state.views[0];
            ctrl.initZoom(view);
            // Zoom in at position (100, 100) by 2x
            ctrl.zoomVideo(view, 2.0, 100, 100);
            assertEqual(view.zoom.scale, 2.0);
            // Offset should be adjusted so (100,100) stays in place
            // At 1x with offset 0: content point = (100, 100)
            // At 2x: offset should be 100 - 100*2 = -100
            assertEqual(view.zoom.offsetX, -100);
            assertEqual(view.zoom.offsetY, -100);
        });
    });

    describe('VideoController - Views without decoders', function () {
        it('seekToFrame skips views without decoder', async function () {
            var state = createTestState(1, 100);
            // Add a view with no decoder
            state.views.push({
                name: 'empty',
                decoder: null,
                canvas: createMockCanvas(),
                ctx: createMockCanvas().getContext('2d'),
                overlayCanvas: createMockCanvas(),
                overlayCtx: createMockCanvas().getContext('2d'),
            });

            var ctrl = new VideoController(state, {});
            // Should not throw
            await ctrl.seekToFrame(10);
            assertEqual(state.currentFrame, 10);
        });
    });

})();
