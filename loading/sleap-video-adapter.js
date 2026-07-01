/**
 * sleap-video-adapter.js — SleapVideoDecoder
 *
 * Wraps sleap-io.js's video backends (via `loadVideo`) behind the same
 * interface LUCID's `OnDemandVideoDecoder` exposes, so it is a drop-in
 * replacement everywhere a decoder is consumed (VideoController, thumbnails,
 * session-loader metadata extraction, etc.).
 *
 * Why this exists: sleap-io.js's backends stream over HTTP **Range requests**
 * (206 Partial Content) for remote URLs, fetching only the bytes each frame
 * needs instead of downloading the whole file into memory. This is the fix for
 * the "load large video from the server without crashing Chrome" problem, and
 * it is the point of the GUI — to load `.slp`/`.mp4` through sleap-io.js.
 *
 * Backend selection is handled by sleap-io's `createVideoBackend`:
 *   - MP4 + WebCodecs        → Mp4BoxVideoBackend   (Range streaming for URLs)
 *   - webm/mkv/mov/ogg/ts    → MediaBunnyVideoBackend (needs real mediabunny;
 *                              currently stubbed — see index.html import map)
 *   - embedded frames (.slp) → Hdf5 / StreamingHdf5VideoBackend
 *   - no WebCodecs           → MediaVideoBackend (HTML5 <video>)
 *
 * Interface parity with OnDemandVideoDecoder (see MODULES.md):
 *   async init(source)                     source: File | Blob | URL string
 *   async getFrame(i) -> ImageBitmap|null
 *   .samples (Array; .length = frameCount)
 *   .videoTrack.video.{width,height}, .codec, .timescale, .duration
 *   ._fps, .fileSize, .keyframeIndices, .config, .onProgress
 *   seekNative(i) / playNative() / pauseNative()
 *   drawCurrentFrame(ctx,w,h) -> boolean
 *   getCurrentFrameIndex() -> number
 *   close()
 */

import { videoLog } from './video.js';

function getSleapIO() {
    var SIO = (typeof window !== 'undefined') ? window.SleapIO : null;
    if (!SIO || typeof SIO.loadVideo !== 'function') {
        throw new Error('sleap-io.js not ready (window.SleapIO.loadVideo missing)');
    }
    return SIO;
}

export class SleapVideoDecoder {
    constructor(options) {
        options = options || {};
        this.cacheSize = options.cacheSize || 60;
        this.lookahead = options.lookahead || 10;
        this._onProgress = (typeof options.onProgress === 'function') ? options.onProgress : null;
        this.onProgress = null; // settable field, read by _emitProgress (parity with OnDemandVideoDecoder)

        // sleap-io.js Video model + backend
        this.video = null;

        // Decoded-frame LRU cache: frameIndex -> ImageBitmap
        this.cache = new Map();
        this._pending = new Map(); // frameIndex -> Promise<ImageBitmap|null> (dedupe in-flight decodes)

        // Metadata surfaces read by the rest of the app
        this.samples = [];
        this.keyframeIndices = [];
        this.videoTrack = null;
        this.config = null;
        this.fileSize = 0;
        this._fps = 30;

        // Playback state (wall-clock playhead; sleap decode is async so we can't
        // rely on a native <video> element the way OnDemandVideoDecoder does)
        this._videoEl = null; // intentionally null — VideoController guards on this
        this._playing = false;
        this._lastFrame = 0;       // current frame while paused/scrubbing
        this._playheadFrame = 0;   // decode-paced playhead during playback
        this._playBitmap = null;   // latest decoded frame to draw during playback

        this.sourceType = null; // "file" | "url"
        this.url = null;
        this.file = null;
    }

    _emitProgress(event) {
        var fn = this.onProgress || this._onProgress;
        if (typeof fn !== 'function') return;
        try { fn(event); } catch (e) {
            console.warn('[SleapVideoDecoder onProgress threw]:', e);
        }
    }

    /**
     * @param {File|Blob|string} source  local File/Blob or an http(s):// URL
     * @param {Object} [opts]  { fpsHint } used when the container carries no fps
     */
    async init(source, opts) {
        opts = opts || {};
        var SIO = getSleapIO();

        if (source instanceof Blob || source instanceof File) {
            this.file = source;
            this.sourceType = 'file';
            this.fileSize = source.size || 0;
        } else if (typeof source === 'string') {
            this.url = source;
            this.sourceType = 'url';
        } else {
            throw new Error('SleapVideoDecoder: unsupported source type');
        }

        this._emitProgress({ phase: 'canplay', ratio: 0 });

        // loadVideo() picks and opens the right backend. For URLs it probes for
        // Range support (206) and streams; for Blobs it slices on demand.
        this.video = await SIO.loadVideo(source, { openBackend: true });

        // IMPORTANT: createVideoBackend() returns the backend WITHOUT awaiting
        // its async init() (the constructor just kicks off `this.ready =
        // this.init()`). init() is what fills in shape/fps/the frame table, so
        // we MUST await readiness before reading them — otherwise shape is
        // undefined and the app sees 0 frames (frame 0/0, no video).
        var backend = this.video.backend || this.video._backend || null;
        if (backend && backend.ready && typeof backend.ready.then === 'function') {
            await backend.ready;
        }

        // shape: [frameCount, height, width, channels]
        var shape = this.video.shape || (backend && backend.shape) || [];
        var frameCount = shape[0] || 0;
        var height = shape[1] || 0;
        var width = shape[2] || 0;

        this._fps = this.video.fps || opts.fpsHint || 30;

        // Build the pseudo sample table the app reads (.samples.length = frameCount).
        // Set timescale = fps and duration = frameCount so the app's fps formula
        //   samples.length / (videoTrack.duration / videoTrack.timescale)
        // evaluates back to this._fps.
        this.samples = new Array(frameCount);
        for (var i = 0; i < frameCount; i++) {
            this.samples[i] = { index: i };
        }
        this.keyframeIndices = frameCount > 0 ? [0] : [];

        this.videoTrack = {
            video: { width: width, height: height },
            codec: 'sleap-io',
            timescale: this._fps || 30,
            duration: frameCount,
        };
        this.config = { codec: 'sleap-io', codedWidth: width, codedHeight: height };

        this._emitProgress({ phase: 'canplay', ratio: 1 });
        this._emitProgress({ phase: 'mp4box', ratio: 1 });

        videoLog('sleap-io backend loaded: ' + width + 'x' + height + ' ' +
            frameCount + ' frames @ ' + (this._fps || 0).toFixed(2) + 'fps (' +
            this.sourceType + (this.sourceType === 'url' ? ' streaming' : '') + ')');

        return this;
    }

    /**
     * Normalize whatever sleap-io returns into a drawable ImageBitmap.
     * Backends may return ImageBitmap | VideoFrame | ImageData | Uint8Array(encoded).
     */
    async _toBitmap(frame) {
        if (frame == null) return null;
        if (typeof ImageBitmap !== 'undefined' && frame instanceof ImageBitmap) {
            return frame;
        }
        // WebCodecs VideoFrame
        if (typeof VideoFrame !== 'undefined' && frame instanceof VideoFrame) {
            try {
                var bmp = await createImageBitmap(frame);
                return bmp;
            } finally {
                try { frame.close(); } catch (e) { /* ignore */ }
            }
        }
        if (typeof ImageData !== 'undefined' && frame instanceof ImageData) {
            return await createImageBitmap(frame);
        }
        // Encoded bytes (PNG/JPEG), e.g. some embedded-frame paths
        if (frame instanceof Uint8Array || frame instanceof ArrayBuffer) {
            var blob = new Blob([frame]);
            return await createImageBitmap(blob);
        }
        // Unknown — let createImageBitmap try, else give up
        try { return await createImageBitmap(frame); } catch (e) { return null; }
    }

    _cacheGet(i) {
        if (!this.cache.has(i)) return undefined;
        var v = this.cache.get(i);
        this.cache.delete(i);
        this.cache.set(i, v); // LRU bump
        return v;
    }

    _cachePut(i, bmp) {
        this.cache.set(i, bmp);
        while (this.cache.size > this.cacheSize) {
            var oldest = this.cache.keys().next().value;
            var old = this.cache.get(oldest);
            this.cache.delete(oldest);
            if (old && typeof old.close === 'function') {
                try { old.close(); } catch (e) { /* ignore */ }
            }
        }
    }

    async getFrame(frameIndex) {
        if (frameIndex < 0 || frameIndex >= this.samples.length) {
            return null;
        }
        this._lastFrame = frameIndex;

        var cached = this._cacheGet(frameIndex);
        if (cached !== undefined) return cached;

        if (this._pending.has(frameIndex)) {
            return await this._pending.get(frameIndex);
        }

        var self = this;
        var p = (async function () {
            try {
                var raw = await self.video.getFrame(frameIndex);
                var bmp = await self._toBitmap(raw);
                if (bmp) self._cachePut(frameIndex, bmp);
                return bmp;
            } catch (e) {
                videoLog('sleap-io getFrame(' + frameIndex + ') failed: ' + e.message, 'warn');
                return null;
            } finally {
                self._pending.delete(frameIndex);
            }
        })();
        this._pending.set(frameIndex, p);
        return await p;
    }

    // --- Playback: DECODE-PACED playhead ------------------------------------
    // WebCodecs decode (esp. for heavy/high-res video) is often slower than
    // real time. A wall-clock playhead races ahead of the decoder, so every
    // draw misses the cache and the screen "barely updates". Instead we advance
    // the playhead one frame at a time AS FRAMES DECODE, throttled to at most
    // real time — so playback shows every frame and smoothly slows down under
    // load rather than skipping to undecoded frames.
    // VideoController.onFrame() (RAF) reads getCurrentFrameIndex() + draws via
    // drawCurrentFrame(); this async loop is what actually advances the playhead.

    seekNative(frameIndex) {
        this._lastFrame = frameIndex;
        this._playheadFrame = frameIndex;
        this._prefetch(frameIndex); // warm the cache around the seek target
    }

    playNative() {
        if (this._playing) return;
        this._playing = true;
        this._playheadFrame = this._lastFrame;
        this._runPlayLoop();
    }

    pauseNative() {
        this._playing = false;
    }

    async _runPlayLoop() {
        var self = this;
        var fps = this._fps || 30;
        var frameDurMs = 1000 / fps;
        var now = function () { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); };
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

        var anchorTime = now();
        var anchorFrame = this._playheadFrame;

        while (this._playing) {
            var next = this._playheadFrame + 1;
            if (next >= this.samples.length) { this._playing = false; break; }

            var bmp = await this.getFrame(next); // decodes; backend also reads ahead
            if (!this._playing) break;
            if (bmp) {
                this._playBitmap = bmp;
                this._playheadFrame = next;
            }
            this._prefetch(next + 1);

            // Throttle to real time: don't run faster than fps. If decode is
            // slower, we naturally fall behind and play at decode speed.
            var targetMs = (next - anchorFrame) * frameDurMs;
            var actualMs = now() - anchorTime;
            var waitMs = targetMs - actualMs;
            if (waitMs > 1) {
                await sleep(waitMs);
            } else if (waitMs < -500) {
                // Falling behind — re-anchor so we don't try to "catch up" by racing.
                anchorTime = now();
                anchorFrame = this._playheadFrame;
            }
        }
        void self;
    }

    getCurrentFrameIndex() {
        return this._playing ? this._playheadFrame : this._lastFrame;
    }

    /**
     * Synchronous draw for the RAF loop. During playback the decode loop keeps
     * `_playBitmap` pointing at the latest decoded frame, so this always has
     * something to draw; while paused/scrubbing it draws the cached frame.
     */
    drawCurrentFrame(ctx, width, height) {
        var bmp;
        if (this._playing && this._playBitmap) {
            bmp = this._playBitmap;
        } else {
            bmp = this._cacheGet(this._lastFrame);
            if (bmp === undefined) { this.getFrame(this._lastFrame); return false; }
        }
        try {
            ctx.drawImage(bmp, 0, 0, width, height);
            return true;
        } catch (e) {
            return false;
        }
    }

    _prefetch(fromFrame) {
        var end = Math.min(fromFrame + this.lookahead, this.samples.length - 1);
        for (var i = fromFrame; i <= end; i++) {
            if (!this.cache.has(i) && !this._pending.has(i)) {
                this.getFrame(i); // fire-and-forget; fills cache
            }
        }
    }

    close() {
        this.pauseNative();
        if (this.video && typeof this.video.close === 'function') {
            try { this.video.close(); } catch (e) { /* ignore */ }
        }
        this.video = null;
        this.cache.forEach(function (bmp) {
            if (bmp && typeof bmp.close === 'function') {
                try { bmp.close(); } catch (e) { /* ignore */ }
            }
        });
        this.cache.clear();
        this._pending.clear();
    }
}
