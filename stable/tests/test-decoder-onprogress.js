/**
 * test-decoder-onprogress.js — Feature: per-decoder loading progress events.
 *
 * Specifies the new `onProgress` callback option on OnDemandVideoDecoder.
 * The decoder must emit structured `{ phase, ratio }` events at the four
 * spec'd points (per prompts.md "Per-video loading progress modal", design
 * section "Decoder-side progress hook"):
 *
 *   - Phase 2 start: { phase: 'canplay', ratio: 0 }
 *   - Phase 2 end:   { phase: 'canplay', ratio: 1 }
 *   - Phase 3 mid:   { phase: 'mp4box', ratio: r } with 0 < r < 1
 *   - Phase 3 end:   { phase: 'mp4box', ratio: 1 }
 *
 * Both init() and switchSource() share the same _initMp4box plumbing, so
 * wiring the callback into one path covers the other for free. We pin
 * the contract via switchSource() (the simpler entry — no fetch HEAD
 * fallback) and verify the source-level wiring inside _initMp4box
 * separately via a regex/source-walk so the chunk-loop emission is also
 * locked in.
 *
 * Test strategy mirrors test-switchsource-mp4box-await.js:
 *   - getDecoderClass() resolves OnDemandVideoDecoder in both sandboxes.
 *   - Stub _videoEl so canplay fires immediately.
 *   - Replace _initMp4box with a stub that emits 3 fake mp4box ratios
 *     (0.33, 0.66, 1) by calling self._onProgress(...) — so that test 1
 *     pins the callback contract independent of the real chunk loop.
 *   - A second sub-test does a source-text scan of _initMp4box to verify
 *     the production code emits a `{ phase: 'mp4box', ratio: ... }` event
 *     from inside the chunk loop AND a final ratio:1 event.
 *
 * Pre-fix: ALL assertions fail because:
 *   1. The constructor does not accept `onProgress`.
 *   2. switchSource never invokes any callback.
 *   3. _initMp4box's source contains no progress emission.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;

    function getDecoderClass() {
        if (typeof OnDemandVideoDecoder === 'function') return OnDemandVideoDecoder;
        if (typeof window !== 'undefined' && typeof window.OnDemandVideoDecoder === 'function') {
            return window.OnDemandVideoDecoder;
        }
        throw new Error('OnDemandVideoDecoder not loaded into sandbox');
    }

    function makeStubVideoEl(opts) {
        return {
            videoWidth: opts.width,
            videoHeight: opts.height,
            duration: opts.duration,
            src: '',
            error: null,
            readyState: 4,
            addEventListener: function (evt, cb) {
                if (evt === 'canplay') setTimeout(cb, 0);
            },
            removeEventListener: function () {},
            muted: false,
            playsInline: false,
            preload: '',
        };
    }

    function makeStubOffCanvas(w, h) {
        return { width: w, height: h, getContext: function () { return {}; } };
    }

    function loadVideoSource() {
        if (typeof __readSource === 'function') {
            return __readSource('loading/video.js');
        }
        if (typeof XMLHttpRequest !== 'undefined') {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', '../loading/video.js', false);
            xhr.send(null);
            if (xhr.status === 200 || xhr.status === 0) return xhr.responseText;
            throw new Error('Failed to fetch video.js: ' + xhr.status);
        }
        throw new Error('No source loader available');
    }

    describe('OnDemandVideoDecoder onProgress callback', function () {
        it('emits Phase-2 (canplay) start, Phase-2 end, Phase-3 (mp4box) mid, and Phase-3 end events', async function () {
            var DecoderClass = getDecoderClass();
            var events = [];
            var onProgress = function (ev) { events.push(ev); };

            // Pass onProgress in the constructor options bag.
            var decoder = new DecoderClass({
                cacheSize: 60,
                lookahead: 10,
                onProgress: onProgress,
            });

            var WIDTH = 640;
            var HEIGHT = 480;
            var DURATION = 100;

            decoder._videoEl = makeStubVideoEl({ width: WIDTH, height: HEIGHT, duration: DURATION });
            decoder._offCanvas = makeStubOffCanvas(WIDTH, HEIGHT);
            decoder._offCtx = {};
            decoder.cache = new Map();
            decoder.fileSize = 1024 * 1024;
            decoder.sourceType = 'file';

            // Stub _initMp4box: emit three intermediate mp4box events plus
            // the final ratio:1 itself, so we can verify the callback path
            // exists in switchSource. The real _initMp4box's chunk-loop
            // emission is tested separately via source-walk below.
            decoder._initMp4box = function () {
                var self = this;
                return new Promise(function (resolve) {
                    var i = 0;
                    function step() {
                        i++;
                        if (i < 3) {
                            if (typeof self._onProgress === 'function') {
                                self._onProgress({ phase: 'mp4box', ratio: i / 3 });
                            }
                            setTimeout(step, 0);
                        } else {
                            if (typeof self._onProgress === 'function') {
                                self._onProgress({ phase: 'mp4box', ratio: 1 });
                            }
                            resolve();
                        }
                    }
                    setTimeout(step, 0);
                });
            };

            var mockFile;
            if (typeof File === 'function') {
                mockFile = new File([new Uint8Array(1024)], 'mock.mp4', { type: 'video/mp4' });
            } else {
                mockFile = { name: 'mock.mp4', size: 1024 };
            }

            await decoder.switchSource(mockFile);

            // 1. Phase 2 start: { phase: 'canplay', ratio: 0 }
            var canplayStart = events.filter(function (e) {
                return e && e.phase === 'canplay' && e.ratio === 0;
            });
            assertTrue(
                canplayStart.length >= 1,
                'Expected at least one { phase: "canplay", ratio: 0 } event ' +
                '(Phase 2 start). Got events: ' + JSON.stringify(events)
            );

            // 2. Phase 2 end: { phase: 'canplay', ratio: 1 }
            var canplayEnd = events.filter(function (e) {
                return e && e.phase === 'canplay' && e.ratio === 1;
            });
            assertTrue(
                canplayEnd.length >= 1,
                'Expected at least one { phase: "canplay", ratio: 1 } event ' +
                '(Phase 2 end). Got events: ' + JSON.stringify(events)
            );

            // 3. Mid-Phase-3: at least one mp4box event with 0 < ratio < 1.
            // Note: the real chunk-loop emission is what the production
            // path will use; this stubbed test verifies the callback wiring
            // can deliver such events out of switchSource.
            var midMp4box = events.filter(function (e) {
                return e && e.phase === 'mp4box' && e.ratio > 0 && e.ratio < 1;
            });
            assertTrue(
                midMp4box.length >= 1,
                'Expected at least one { phase: "mp4box", ratio: r } event ' +
                'with 0 < r < 1 (mid Phase 3). Got events: ' + JSON.stringify(events)
            );

            // 4. Phase 3 end: exactly one { phase: 'mp4box', ratio: 1 }
            var mp4boxEnd = events.filter(function (e) {
                return e && e.phase === 'mp4box' && e.ratio === 1;
            });
            assertEqual(
                mp4boxEnd.length, 1,
                'Expected exactly one { phase: "mp4box", ratio: 1 } event ' +
                '(Phase 3 end). Got events: ' + JSON.stringify(events)
            );

            // 5. Every event has a phase that is "canplay" or "mp4box".
            for (var ei = 0; ei < events.length; ei++) {
                var ev = events[ei];
                var ok = ev && (ev.phase === 'canplay' || ev.phase === 'mp4box');
                assertTrue(
                    ok,
                    'Every onProgress event must have phase === "canplay" or "mp4box". ' +
                    'Got event[' + ei + '] = ' + JSON.stringify(ev)
                );
            }
        });

        it('_initMp4box source emits onProgress from inside the chunk loop and a final ratio:1', function () {
            // Source-walk: even with the stub-driven contract test above
            // passing post-fix, the production code must actually emit
            // progress from inside the real chunk loop. This regex/scan
            // catches a regression where someone removes the emission.
            var src;
            try { src = loadVideoSource(); } catch (e) { throw e; }

            // Locate _initMp4box body (brace-walk).
            var startIdx = src.indexOf('async _initMp4box(');
            if (startIdx < 0) startIdx = src.indexOf('_initMp4box(');
            assertTrue(startIdx >= 0, '_initMp4box not found in loading/video.js');
            var braceStart = src.indexOf('{', startIdx);
            var depth = 0;
            var endIdx = -1;
            for (var i = braceStart; i < src.length; i++) {
                var ch = src[i];
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) { endIdx = i; break; }
                }
            }
            assertTrue(endIdx > braceStart, 'Failed to locate end of _initMp4box body');
            var body = src.slice(braceStart + 1, endIdx);

            // Locate the chunk loop (`while (offset < this.fileSize ...)`).
            var loopIdx = body.indexOf('while (offset < this.fileSize');
            assertTrue(
                loopIdx >= 0,
                '_initMp4box chunk-loop (`while (offset < this.fileSize ...)`) not found ' +
                '— production code shape changed; update the test.'
            );

            // Brace-walk the loop body.
            var loopBraceStart = body.indexOf('{', loopIdx);
            var loopDepth = 0;
            var loopEndIdx = -1;
            for (var j = loopBraceStart; j < body.length; j++) {
                var c = body[j];
                if (c === '{') loopDepth++;
                else if (c === '}') {
                    loopDepth--;
                    if (loopDepth === 0) { loopEndIdx = j; break; }
                }
            }
            assertTrue(loopEndIdx > loopBraceStart, 'Failed to locate end of chunk-loop body');
            var loopBody = body.slice(loopBraceStart + 1, loopEndIdx);

            // The chunk loop must invoke a progress callback with phase 'mp4box'.
            // Match either `this._onProgress({ phase: 'mp4box'` or
            // `_onProgress({ phase: "mp4box"` (single or double quote).
            var loopEmits = /_onProgress\s*\(\s*\{[^}]*phase\s*:\s*['"]mp4box['"]/.test(loopBody);
            assertTrue(
                loopEmits,
                'Expected the chunk loop in _initMp4box to invoke ' +
                'this._onProgress({ phase: "mp4box", ratio: ... }) after each ' +
                'appendBuffer iteration. Loop body did not contain such a call.'
            );

            // After the chunk loop, _initMp4box must emit a final ratio:1
            // (covers the post-loop / onReady success path).
            var afterLoop = body.slice(loopEndIdx + 1);
            var finalEmits = /_onProgress\s*\(\s*\{[^}]*phase\s*:\s*['"]mp4box['"][^}]*ratio\s*:\s*1\b/.test(afterLoop);
            assertTrue(
                finalEmits,
                'Expected _initMp4box to emit a final ' +
                '{ phase: "mp4box", ratio: 1 } event after the chunk loop completes ' +
                '(Phase 3 end). No such call found after the loop.'
            );
        });
    });
})();
