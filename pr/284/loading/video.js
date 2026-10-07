/**
 * video.js - Video decoding and multi-view playback for mv-gui
 *
 * OnDemandVideoDecoder: Hybrid decoder that uses HTML5 <video> for instant loading
 * and WebCodecs + mp4box.js for frame-accurate on-demand decoding.
 * VideoController: Synchronized multi-view playback controller with overlay support.
 *
 * Dependencies: mp4box.all.min.js (MP4Box)
 */

import { shouldIgnoreShortcut } from '../ui/keyboard-target.js?v=f1d241615fc7';
import { diagnoseUnplayableVideo } from './video-codec-diagnosis.js?v=f1d241615fc7';

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------
export function videoLog(msg, level) {
    level = level || "log";
    if (typeof window !== "undefined" && window.logMessage) {
        window.logMessage("[video] " + msg, level);
    } else {
        if (level === "error") {
            console.error("[video] " + msg);
        } else if (level === "warn") {
            console.warn("[video] " + msg);
        } else {
            console.log("[video] " + msg);
        }
    }
}

/** A paused-stepping decode stream with no request for this long is closed (OnDemandVideoDecoder._mbGetFrame). */
export const STEP_CURSOR_IDLE_MS = 3000;

/**
 * Frames decoded and kept per backward step (OnDemandVideoDecoder._decodeBackChunk):
 * a step back must decode from the keyframe anyway, so it keeps up to this many
 * frames ending at the target and the next steps back are cache hits. Must stay
 * well under the decoder's frame cache (60 in the app). `window.LUCID_STEP_BACK_CHUNK`
 * overrides it; 0 or 1 turns it off.
 */
export const STEP_BACK_CHUNK = 24;

/**
 * After landing on a frame by a jump (not a step), wait this long and, if no
 * other frame was asked for meanwhile, decode the chunk before it in the
 * background so even the FIRST step back is a cache hit (OnDemandVideoDecoder._mbGetFrame).
 */
export const STEP_BACK_WARM_MS = 250;

/** Index of the frame nearest timestamp `t` in the sorted `times` (within half a frame), or -1. */
function frameNearTime(times, t) {
    var lo = 0, hi = times.length - 1;
    while (lo < hi) { var m = (lo + hi) >> 1; if (times[m] < t) lo = m + 1; else hi = m; }
    if (lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t)) lo--;
    var half = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) / 2 : Infinity;
    return Math.abs(times[lo] - t) <= half ? lo : -1;
}

// ---------------------------------------------------------------------------
// OnDemandVideoDecoder
// ---------------------------------------------------------------------------
export class OnDemandVideoDecoder {
    constructor(options = {}) {
        this.cacheSize = options.cacheSize || 30;
        this.lookahead = options.lookahead || 5;
        this._onProgress = (options && typeof options.onProgress === 'function') ? options.onProgress : null;
        this.onProgress = null; // settable field; read by _emitProgress
        this.cache = new Map();
        this.samples = [];
        this.keyframeIndices = [];
        this.decoder = null;
        this.config = null;
        this.videoTrack = null;
        this.mp4boxFile = null;
        this.url = null;
        this.fileSize = 0;
        this.supportsRangeRequests = false;
        this.isDecoding = false;
        this.pendingFrame = null;
        this.CHUNK_SIZE = 1024 * 1024; // 1 MB

        // HTML5 video element for fast loading and fallback frame extraction
        this._videoEl = null;
        this._videoReady = false;
        this._offCanvas = null;
        this._offCtx = null;
        this._mp4Initialized = false;
        this._mp4InitPromise = null;
        this._html5SeekLock = null; // Prevent concurrent HTML5 seeks
        this._html5Moved = false;   // <video> played or frame-start-seeked since _getFrameHTML5 last positioned it
        this._mbBackend = null; // Optional mediabunny frame-accurate backend (issue #115)
        this._mbUnavailable = null; // why there is no _mbBackend: { reason: 'codec'|'init', ... } (see _initMediabunny)
        this._stepCursor = null; // open decode stream for paused forward steps (see _mbGetFrame)
        this._keySink = null;    // mediabunny EncodedPacketSink: which keyframe a frame needs

        // Source reference for mp4box lazy init
        this._source = null;
    }

    /**
     * Await the <video> element's load; if the browser rejects the file, try to
     * say WHY (video-codec-diagnosis.js reads the codec from the MP4 and checks
     * it against this browser) and throw that instead of a bare "error code 4".
     * The diagnosis is attached as `err.codecDiagnosis`; the original error is
     * `err.cause`. Undiagnosable failures (corrupt file, …) rethrow unchanged.
     */
    async _awaitPlayable(metadataPromise, source) {
        try {
            await metadataPromise;
        } catch (loadErr) {
            var diag = null;
            try { diag = await diagnoseUnplayableVideo(source); } catch (e) { /* keep the original error */ }
            if (!diag) throw loadErr;
            videoLog('Cannot play ' + diag.codecName + ' video: ' + diag.message, 'error');
            var err = new Error(diag.message);
            err.codecDiagnosis = diag;
            err.cause = loadErr;
            throw err;
        }
    }

    async init(source) {
        this._source = source;

        // --- Phase 1: Instant load via HTML5 <video> element ---
        this._videoEl = document.createElement("video");
        this._videoEl.muted = true;
        this._videoEl.playsInline = true;
        this._videoEl.preload = "auto";

        // Set up event listeners BEFORE setting src to avoid race condition.
        // Wait for 'canplay' (not just 'loadedmetadata') so the first frame is available to draw.
        // Read the error off the ELEMENT this listener was attached to, not
        // off `self._videoEl`. `close()` clears `src` and calls `load()`, which
        // fires a last `error` event — asynchronously, by which time `close()`
        // has already nulled `self._videoEl`, so reading through `self` threw
        // `Cannot read properties of null` out of an event handler. The
        // `once: true` listener outlives a successful load, so every decoder
        // that is closed rather than garbage-collected hits this.
        var el = this._videoEl;
        var metadataPromise = new Promise(function (resolve, reject) {
            if (el.readyState >= 3) {
                resolve();
                return;
            }
            el.addEventListener("canplay", function () { resolve(); }, { once: true });
            el.addEventListener("error", function () {
                var err = el.error;
                var msg = err ? ("Video error code " + err.code + ": " + (err.message || "unknown")) : "Browser could not load video";
                reject(new Error(msg));
            }, { once: true });
        });

        // Now set the src (triggers loading)
        if (source instanceof Blob || source instanceof File) {
            this.file = source;
            this.sourceType = "file";
            this.fileSize = source.size;
            this.supportsRangeRequests = true;
            this._videoEl.src = URL.createObjectURL(source);
        } else if (typeof source === "string") {
            this.url = source;
            this.sourceType = "url";
            this._videoEl.src = source;
            // Probe for file size and range support (non-blocking, don't delay metadata)
            try {
                var headResp = await fetch(source, { method: "HEAD" });
                if (headResp.ok) {
                    var acceptRanges = headResp.headers.get("Accept-Ranges");
                    this.supportsRangeRequests = acceptRanges === "bytes";
                    var contentLength = headResp.headers.get("Content-Length");
                    this.fileSize = contentLength ? parseInt(contentLength, 10) : 0;
                }
            } catch (e) {
                videoLog("HEAD request failed: " + e.message, "warn");
            }
        } else {
            throw new Error("Unsupported source type");
        }

        // Wait for video metadata (browser parses moov natively - very fast)
        this._emitProgress({ phase: 'canplay', ratio: 0 });
        await this._awaitPlayable(metadataPromise, source);
        this._emitProgress({ phase: 'canplay', ratio: 1 });

        var width = this._videoEl.videoWidth;
        var height = this._videoEl.videoHeight;
        var duration = this._videoEl.duration;

        // Use 30fps as default estimate; will be corrected once mp4box parses moov
        var fps = 30;
        this._fps = fps;
        var totalFrames = Math.round(duration * fps);

        // Create offscreen canvas for HTML5 frame capture
        this._offCanvas = document.createElement("canvas");
        this._offCanvas.width = width;
        this._offCanvas.height = height;
        this._offCtx = this._offCanvas.getContext("2d");

        // Build pseudo video track info for compatibility
        this.videoTrack = {
            video: { width: width, height: height },
            codec: "html5",
            timescale: fps,
            duration: Math.round(duration * fps),
        };
        this.config = {
            codec: "html5",
            codedWidth: width,
            codedHeight: height,
        };

        // Build pseudo-samples (frame index -> timing info)
        this.samples = new Array(totalFrames);
        for (var i = 0; i < totalFrames; i++) {
            this.samples[i] = {
                index: i,
                cts: Math.round(i * 1000000 / fps),
                duration: Math.round(1000000 / fps),
                is_sync: false,
                offset: 0,
                size: 0,
            };
        }

        // Mark estimated keyframes every ~1 second
        var kfInterval = Math.max(1, Math.round(fps));
        this.keyframeIndices = [];
        for (var j = 0; j < totalFrames; j += kfInterval) {
            this.samples[j].is_sync = true;
            this.keyframeIndices.push(j);
        }
        if (totalFrames > 0) {
            this.samples[0].is_sync = true;
            if (this.keyframeIndices[0] !== 0) {
                this.keyframeIndices.unshift(0);
            }
        }

        this._videoReady = true;

        // Initialize mp4box for frame-accurate WebCodecs decoding.
        // Without this, HTML5 fallback uses frameIndex/30 which drifts on non-30fps video.
        try {
            await this._initMp4box();
        } catch (e) {
            videoLog("MP4Box init failed (HTML5 fallback will be used): " + e.message, "warn");
            this._emitProgress({ phase: 'mp4box', error: e });
        }

        // Frame-accurate mediabunny backend (issue #115). HTML5
        // `<video>.currentTime` seeking is NOT frame-accurate — it can return a
        // frame a whole GOP behind the one requested, so the pose overlay ends
        // up drawn on a stale video frame. mediabunny (via sleap-io.js's
        // MediaBunnyVideoBackend) seeks + decodes exact frames via WebCodecs.
        // ON BY DEFAULT — only per-frame stepping/seeking (getFrame) goes
        // through mediabunny; playback still uses the HTML5 element, and any
        // init/decode failure falls back to the HTML5 path transparently. To
        // force the old (frame-inaccurate) HTML5 seek, set
        //   localStorage.LUCID_VIDEO_BACKEND = 'html5'   (then reload)
        // or window.LUCID_VIDEO_BACKEND = 'html5' before loading a session.
        this._mbUnavailable = null;
        if (this._mediabunnyEnabled() && (source instanceof Blob || source instanceof File)) {
            try {
                await this._initMediabunny(source);
            } catch (e) {
                videoLog("Mediabunny backend init failed (HTML5 seek will be used): " + e.message, "warn");
                this._mbBackend = null;
                this._mbUnavailable = { reason: 'init', message: e.message };
            }
        }

        videoLog("Video loaded: " + width + "x" + height + " " + this.samples.length + " frames @ " + this._fps.toFixed(2) + "fps (" + (this.fileSize / 1048576).toFixed(1) + " MB)"
            + (this._mbBackend ? " [mediabunny frame-accurate]" : ""));
    }

    /**
     * Whether to use the frame-accurate mediabunny backend (issue #115).
     * DEFAULT ON — only an explicit `LUCID_VIDEO_BACKEND` of `'html5'` (or
     * `'legacy'`) opts back out to the old HTML5 `<video>` seek. Read from
     * `window` first, then `localStorage`. Note: `localStorage` is per-origin,
     * so a default-off approach would silently disable the fix on any origin
     * where the flag wasn't set (e.g. a PR preview vs localhost) — hence
     * default-on with an explicit opt-out.
     */
    _mediabunnyEnabled() {
        try {
            var v = null;
            if (typeof window !== 'undefined' && window.LUCID_VIDEO_BACKEND) {
                v = String(window.LUCID_VIDEO_BACKEND).toLowerCase();
            } else if (typeof localStorage !== 'undefined') {
                var ls = localStorage.getItem('LUCID_VIDEO_BACKEND');
                if (ls) v = String(ls).toLowerCase();
            }
            return !(v === 'html5' || v === 'legacy');
        } catch (e) {
            // localStorage may throw in some sandboxes — default to the fix.
            return true;
        }
    }

    /**
     * Initialize the mediabunny frame-accurate backend for this source and adopt
     * its authoritative frame count / fps. Leaves the HTML5 `<video>` element in
     * place for playback + as the getFrame fallback.
     */
    async _initMediabunny(source) {
        var SIO = (typeof window !== 'undefined') ? window.SleapIO : null;
        var Backend = SIO && SIO.MediaBunnyVideoBackend;
        if (!Backend || typeof Backend.fromBlob !== 'function') {
            throw new Error('MediaBunnyVideoBackend unavailable (sleap-io.js not loaded)');
        }
        var name = (source && source.name) ? source.name : 'video.mp4';
        this._mbBackend = await Backend.fromBlob(source, name, { cacheSize: this.cacheSize });

        // Adopt mediabunny's authoritative frame count + fps. Keep `this.samples`
        // as the frame-count carrier the rest of the class reads (`.length`),
        // resizing it to match so bounds checks and the timeline agree.
        var n = this._mbBackend.numFrames;
        if (n && n !== this.samples.length) {
            var resized = new Array(n);
            for (var i = 0; i < n; i++) {
                resized[i] = this.samples[i] || { index: i, is_sync: false, offset: 0, size: 0 };
            }
            this.samples = resized;
        }
        if (this._mbBackend.fps && this._mbBackend.fps > 0) {
            this._fps = this._mbBackend.fps;
        }

        // Demuxing is not decoding: Firefox 157 reads an HEVC file's index fine
        // (so the backend above initializes) but has no WebCodecs HEVC decoder,
        // so EVERY decode then failed and fell back to the <video> seek anyway —
        // 1,544 "decode failed, falling back" warnings in one 8-camera stepping
        // run. Ask once. The frame count and fps adopted above are container
        // metadata and stay.
        var undecodable = await this._mbCannotDecode(this._mbBackend);
        if (undecodable) {
            try { this._mbBackend.close(); } catch (_) {}
            this._mbBackend = null;
            this._mbUnavailable = undecodable;
            videoLog("This browser cannot decode " + (undecodable.codecString || undecodable.codec || 'this codec')
                + " with WebCodecs: stepping uses <video> seeks instead", "warn");
            return;
        }
        videoLog("Mediabunny ready: " + n + " frames, fps=" + (this._fps ? this._fps.toFixed(2) : '?')
            + " (frame-accurate decode)");
    }

    /**
     * `{ reason: 'codec', codec, codecString }` when this browser's WebCodecs
     * reports it cannot decode the backend's video track, else null. Uses
     * mediabunny's `canDecode()` — `VideoDecoder.isConfigSupported` on the
     * track's full decoder config (codec string + hvcC/avcC description).
     * Measured (verify/seek-probe.html, barcode clips): false for HEVC in
     * Firefox 157 (whose decode then throws "cannot be decoded by this
     * browser"); true for H.264 there and for HEVC + H.264 in Chrome, Brave and
     * Safari. A check that cannot be asked (no `canDecode`, or it throws)
     * answers null: the per-frame fallback in getFrame still covers a failure.
     */
    async _mbCannotDecode(be) {
        try {
            var track = be && be.input && await be.input.getPrimaryVideoTrack();
            if (!track || typeof track.canDecode !== 'function') return null;
            if (await track.canDecode()) return null;
            var codecString = null;
            try { codecString = await track.getCodecParameterString(); } catch (_) { /* name only */ }
            return { reason: 'codec', codec: track.codec || null, codecString: codecString };
        } catch (e) {
            return null;
        }
    }

    _emitProgress(event) {
        var fn = this.onProgress || this._onProgress;
        if (typeof fn !== 'function') return;
        try {
            fn(event);
        } catch (e) {
            console.warn('[OnDemandVideoDecoder onProgress callback threw]:', e);
        }
    }

    /**
     * Background mp4box initialization for WebCodecs precise decoding.
     * Does not block the UI - video is already usable via HTML5 element.
     */
    async _initMp4box() {
        var self = this;
        this.mp4boxFile = MP4Box.createFile();

        var ready = new Promise(function (resolve, reject) {
            self.mp4boxFile.onError = reject;
            self.mp4boxFile.onReady = resolve;
        });

        var offset = 0;
        var moovParsed = false;
        ready.then(function () { moovParsed = true; });

        while (offset < this.fileSize && !moovParsed) {
            var chunkSize = Math.min(this.CHUNK_SIZE, this.fileSize - offset);
            var buffer = await this.readChunk(offset, chunkSize);
            buffer.fileStart = offset;
            var next = this.mp4boxFile.appendBuffer(buffer);
            offset = (next !== undefined) ? next : (offset + chunkSize);
            await new Promise(function (r) { setTimeout(r, 0); });
            if (typeof self._onProgress === 'function') {
                self._onProgress({ phase: 'mp4box', ratio: Math.min(offset / self.fileSize, 0.999) });
            }
        }

        var info = await ready;

        var videoTrackInfo = info.tracks.find(function (t) { return t.type === "video"; });
        if (!videoTrackInfo) {
            throw new Error("No video track found in MP4");
        }

        var trak = this.mp4boxFile.getTrackById(videoTrackInfo.id);
        var codec = videoTrackInfo.codec;
        var description = this.getCodecDescription(trak);

        this.config = {
            codec: codec,
            codedWidth: videoTrackInfo.video.width,
            codedHeight: videoTrackInfo.video.height,
        };
        if (description) {
            this.config.description = description;
        }

        // No WebCodecs support check here: this pass never decodes with
        // WebCodecs (see below — the <video> element decodes); it only reads the
        // container's sample table for the real frame count and FPS, which is
        // codec-independent. A check that returned early when WebCodecs can't
        // decode the codec (Firefox 157 + HEVC) left `_fps` at the 30 fps
        // placeholder, halving every frame index for 60 fps video — measured
        // with tests/e2e/_verify-playback-loop.html (barcode frame numbers).

        // Get real sample table for accurate frame count and FPS
        var mp4Samples = this.mp4boxFile.getTrackSamplesInfo(videoTrackInfo.id);
        if (mp4Samples && mp4Samples.length > 0) {
            // Update frame count and FPS from real sample data
            var realFrameCount = mp4Samples.length;
            if (this._videoEl && this._videoEl.duration > 0) {
                this._fps = realFrameCount / this._videoEl.duration;
            }

            // Rebuild pseudo-samples with correct count (for samples.length)
            var width = this.videoTrack.video.width;
            var height = this.videoTrack.video.height;
            this.samples = new Array(realFrameCount);
            for (var si = 0; si < realFrameCount; si++) {
                this.samples[si] = {
                    index: si,
                    cts: Math.round(si * 1000000 / this._fps),
                    duration: Math.round(1000000 / this._fps),
                    is_sync: false,
                    offset: 0,
                    size: 0,
                };
            }
            var kfInterval = Math.max(1, Math.round(this._fps));
            this.keyframeIndices = [];
            for (var ki = 0; ki < realFrameCount; ki += kfInterval) {
                this.samples[ki].is_sync = true;
                this.keyframeIndices.push(ki);
            }
            if (realFrameCount > 0 && this.keyframeIndices[0] !== 0) {
                this.keyframeIndices.unshift(0);
            }

            // Update videoTrack with real info
            this.videoTrack = videoTrackInfo;

            // Do NOT enable WebCodecs decoding (_mp4Initialized stays false).
            // WebCodecs mp4box samples are in decode order which doesn't match
            // display order for videos with B-frames. The HTML5 <video> element
            // handles B-frame reordering natively and gives correct frames.
            // We only use mp4box for accurate FPS and frame count.

            videoLog("MP4Box ready: " + realFrameCount + " frames, fps=" + this._fps.toFixed(2) + " (using HTML5 decode with accurate FPS)");
        } else {
            videoLog("MP4Box returned no samples, keeping HTML5 mode", "warn");
        }
        if (typeof this._onProgress === 'function') {
            this._onProgress({ phase: 'mp4box', ratio: 1 });
        }
        // Release mp4box resources - we only needed it for metadata
        this.mp4boxFile = null;
    }

    async readChunk(offset, size) {
        if (this.sourceType === "file") {
            var slice = this.file.slice(offset, offset + size);
            var arrayBuffer = await slice.arrayBuffer();
            return arrayBuffer;
        }

        // URL source
        if (this.supportsRangeRequests) {
            var end = Math.min(offset + size - 1, this.fileSize - 1);
            var resp = await fetch(this.url, {
                headers: { Range: "bytes=" + offset + "-" + end },
            });
            return await resp.arrayBuffer();
        } else {
            // No range requests - fetch entire file (only once, then cache)
            if (!this._fullBuffer) {
                var resp2 = await fetch(this.url);
                this._fullBuffer = await resp2.arrayBuffer();
                this.fileSize = this._fullBuffer.byteLength;
            }
            return this._fullBuffer.slice(offset, offset + size);
        }
    }

    getCodecDescription(trak) {
        // Extract codec-specific data (avcC / hvcC / etc.) from the sample entry
        for (var idx = 0; idx < trak.mdia.minf.stbl.stsd.entries.length; idx++) {
            var entry = trak.mdia.minf.stbl.stsd.entries[idx];
            // avcC for H.264
            if (entry.avcC) {
                var stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                entry.avcC.write(stream);
                return new Uint8Array(stream.buffer, 8); // skip box header
            }
            // hvcC for H.265
            if (entry.hvcC) {
                var stream2 = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                entry.hvcC.write(stream2);
                return new Uint8Array(stream2.buffer, 8);
            }
            // vpcC for VP9
            if (entry.vpcC) {
                var stream3 = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                entry.vpcC.write(stream3);
                return new Uint8Array(stream3.buffer, 8);
            }
            // av1C for AV1
            if (entry.av1C) {
                var stream4 = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                entry.av1C.write(stream4);
                return new Uint8Array(stream4.buffer, 8);
            }
        }
        return undefined;
    }

    findKeyframeBefore(frameIndex) {
        var best = 0;
        for (var i = 0; i < this.keyframeIndices.length; i++) {
            if (this.keyframeIndices[i] <= frameIndex) {
                best = this.keyframeIndices[i];
            } else {
                break;
            }
        }
        return best;
    }

    /**
     * One paused frame from the mediabunny backend, keeping a decode stream OPEN
     * between calls so stepping forward costs one decoded frame instead of every
     * frame since the keyframe. `MediaBunnyVideoBackend.getFrame` opens a fresh
     * decoder per frame and decodes from the frame's keyframe — on P-frame
     * recordings with a keyframe every 250 frames, ~125 frames per camera for
     * every arrow-key step. Here the stream (mediabunny `samples(t)`, which
     * decodes from the keyframe once and then keeps a few frames ahead) serves
     * every request at or after its position that needs no newer keyframe;
     * anything else (a step back, a jump past the next keyframe) reopens it at
     * the target — exactly the fresh decode it replaces. Results go into the
     * backend's frame cache like `getFrame`'s, so a step back over frames just
     * shown is still a cache hit. Idle streams close after STEP_CURSOR_IDLE_MS;
     * playback, a source switch and `close()` close them at once. Any failure
     * falls back to the backend's own `getFrame`. `window.LUCID_STEP_CURSOR = 0`
     * turns it off. Callers serialize (getFrame's `_mbSeekLock`).
     */
    async _mbGetFrame(frameIndex) {
        var prev = this._lastStepFrame;
        var bitmap = await this._mbGetFrameOnce(frameIndex);
        // landed by a jump (seekbar, a flagged switch, end of playback) and still there: once the frame
        // is on screen, warm the chunk behind it so even the first step back is a cache hit
        var jumped = !(prev != null && Math.abs(frameIndex - prev) <= 3);
        if (bitmap && jumped && this._lastStepFrame === frameIndex && this._stepCursorEnabled()) this._scheduleBackWarm(frameIndex);
        return bitmap;
    }

    _stepCursorEnabled() {
        return !(typeof window !== 'undefined' && window.LUCID_STEP_CURSOR === 0);
    }

    async _mbGetFrameOnce(frameIndex) {
        var be = this._mbBackend;
        var off = !this._stepCursorEnabled();
        if (off || !be.sink || typeof be.sink.samples !== 'function' || !be._frameTimes || !be.cache) return be.getFrame(frameIndex);
        var prev = this._lastStepFrame;
        this._lastStepFrame = frameIndex;
        var back = prev != null && prev - frameIndex >= 1 && prev - frameIndex <= 3;   // a step BACK
        // anything but a step back makes the background chunk moot: stop it (frees its decoder)
        if (!back && this._backPrefetch) { this._backPrefetch.cancelled = true; this._backPrefetch = null; }
        if (this._backWarmTimer) { clearTimeout(this._backWarmTimer); this._backWarmTimer = null; }
        var hit = be.cache.get(frameIndex);
        if (hit) { be.cache.delete(frameIndex); be.cache.set(frameIndex, hit); if (back) this._prefetchBack(frameIndex); return hit; }
        if (be.decodingPromise) { await be.decodingPromise; if (be.cache.has(frameIndex)) return be.cache.get(frameIndex); }
        // the background prefetch is decoding this frame: wait for it rather than decode it twice
        var bp = this._backPrefetch;
        if (bp && !bp.cancelled && frameIndex <= bp.end && frameIndex > bp.end - this._backChunkSize()) {
            await bp.promise;
            hit = be.cache.get(frameIndex);
            if (hit) { be.cache.delete(frameIndex); be.cache.set(frameIndex, hit); if (back) this._prefetchBack(frameIndex); return hit; }
        }
        var ts = be._frameTimes[frameIndex];
        if (ts == null) return null;
        // a step back: decode the run up to it once and keep it, and start on the run before it
        if (back) {
            try {
                var chunkHit = await this._decodeBackChunk(frameIndex);
                if (chunkHit) { this._prefetchBack(frameIndex); return chunkHit; }
            } catch (e) {
                videoLog("Back-step chunk failed for frame " + frameIndex + " (" + e.message + "), decoding it alone", "warn");
            }
        }
        try {
            var c = this._stepCursor;
            if (!(c && c.backend === be && frameIndex >= c.next && await this._sameKeyframeRun(c, ts))) {
                this._closeStepStream();
                c = this._stepCursor = { backend: be, it: be.sink.samples(ts)[Symbol.asyncIterator](), next: frameIndex, nextTs: ts, timer: null };
            }
            if (c.timer) { clearTimeout(c.timer); c.timer = null; }
            var times = be._frameTimes, half = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) / 2 : Infinity;
            for (;;) {
                var r = await c.it.next();
                if (r.done || !r.value) throw new Error('stream ended before frame ' + frameIndex);
                var sample = r.value;
                if (sample.timestamp < ts - half) { sample.close(); continue; }   // passed over on the way
                if (sample.timestamp > ts + half) { sample.close(); throw new Error('stream skipped frame ' + frameIndex); }
                var vf = sample.toVideoFrame();
                var bitmap = await createImageBitmap(vf);
                vf.close(); sample.close();
                c.next = frameIndex + 1;
                c.nextTs = times[frameIndex + 1] != null ? times[frameIndex + 1] : Infinity;
                be.cacheFrame(frameIndex, bitmap);
                var self = this;
                c.timer = setTimeout(function () { if (self._stepCursor === c) self._closeStepStream(); }, STEP_CURSOR_IDLE_MS);
                return bitmap;
            }
        } catch (e) {
            this._closeStepStream();
            videoLog("Step cursor failed for frame " + frameIndex + " (" + e.message + "), decoding it alone", "warn");
            return be.getFrame(frameIndex);
        }
    }

    /** Can the open stream reach `ts` without passing a newer keyframe (i.e. is advancing it no costlier than reopening)? */
    async _sameKeyframeRun(c, ts) {
        var keyTs = await this._keyTimestamp(c.backend, ts);
        return keyTs != null && keyTs <= c.nextTs;
    }

    /** Timestamp of the keyframe that frame time `ts` decodes from (mediabunny's packet index), or null. */
    async _keyTimestamp(be, ts) {
        if (!this._keySink) {
            var mb = await import('mediabunny');
            this._keySink = new mb.EncodedPacketSink(await be.input.getPrimaryVideoTrack());
        }
        var key = await this._keySink.getKeyPacket(ts);
        return key ? key.timestamp : null;
    }

    /**
     * A step back: frame `f` has to be decoded from its keyframe whatever happens,
     * so decode that run once and cache up to STEP_BACK_CHUNK frames ending at `f`
     * (never earlier than its keyframe — that would be a second run), making the
     * next steps back cache hits instead of one keyframe-to-frame decode EACH (up to
     * 250 frames per camera on the field recordings). Returns `f`'s bitmap, or null
     * when chunking is off (the caller then decodes `f` alone).
     */
    async _decodeBackChunk(f) {
        var be = this._mbBackend, n = this._backChunkSize();
        if (!(n > 1)) return null;
        var start = await this._backChunkStart(be, f, n);
        return this._decodeIntoCache(be, start, f);
    }

    /**
     * Frames per backward chunk: STEP_BACK_CHUNK (or `window.LUCID_STEP_BACK_CHUNK`),
     * at most 40% of the frame cache, so the chunk on screen and the one being
     * prefetched behind it (`_prefetchBack`) both fit without evicting each other.
     */
    _backChunkSize() {
        var n = (typeof window !== 'undefined' && window.LUCID_STEP_BACK_CHUNK != null) ? Math.floor(+window.LUCID_STEP_BACK_CHUNK) : STEP_BACK_CHUNK;
        return this._mbBackend ? Math.min(n, Math.floor(this._mbBackend.cacheSize * 0.4)) : 0;
    }

    /** First frame of the chunk ending at `f`: n frames back, but never before `f`'s keyframe. */
    async _backChunkStart(be, f, n) {
        var times = be._frameTimes, keyTs = await this._keyTimestamp(be, times[f]);
        var kf = keyTs == null ? -1 : frameNearTime(times, keyTs);
        return Math.max(kf >= 0 ? kf : 0, f - n + 1);
    }

    /** Decode frames [start, end] in one run into the backend's cache (skipping cached ones); returns `end`'s bitmap. `job.cancelled` stops it. */
    async _decodeIntoCache(be, start, end, job) {
        var times = be._frameTimes;
        var half = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) / 2 : 0;
        var out = null;
        for await (var sample of be.sink.samples(times[start], times[end] + half)) {
            if (this._mbBackend !== be || (job && job.cancelled)) { sample.close(); break; }   // closed / switched / moved on
            var i = frameNearTime(times, sample.timestamp);
            if (i < start || i > end || be.cache.has(i)) { sample.close(); continue; }
            var vf = sample.toVideoFrame();
            var bitmap = await createImageBitmap(vf);
            vf.close(); sample.close();
            this._cacheNear(be, i, bitmap);
            if (i === end) out = bitmap;
        }
        return out;
    }

    /**
     * Cache a chunk frame, evicting (when full) the cached frame FARTHEST from where
     * the user is, not the least recently used: while stepping back, the frames not
     * yet reached are the least recently used ones, and plain LRU evicted exactly
     * those (measured: a hitch every ~30 steps with keyframes every 30 frames).
     */
    _cacheNear(be, i, bitmap) {
        var here = this._lastStepFrame != null ? this._lastStepFrame : i;
        while (be.cache.size >= be.cacheSize) {
            var far = null, farD = -1;
            be.cache.forEach(function (_, k) { var d = Math.abs(k - here); if (d > farD) { farD = d; far = k; } });
            if (far === null) break;
            var old = be.cache.get(far);
            if (old && old.close) old.close();
            be.cache.delete(far);
        }
        be.cache.set(i, bitmap);
    }

    /**
     * While stepping back, decode the chunk BEFORE the cached run that ends at `f`
     * in the background (its own decoder; not under getFrame's lock), so that run's
     * first frame is not followed by a pause for the next chunk. One at a time;
     * nothing to do when a chunk's worth is already cached behind `f`. A request
     * for a frame it is decoding waits for it (`_mbGetFrame`).
     * `window.LUCID_STEP_BACK_PREFETCH = 0` turns it off.
     */
    /** After STEP_BACK_WARM_MS with no other request, prefetch the chunk behind landed frame `f`. */
    _scheduleBackWarm(f) {
        if (this._backWarmTimer) clearTimeout(this._backWarmTimer);
        var self = this;
        this._backWarmTimer = setTimeout(function () {
            self._backWarmTimer = null;
            if (self._lastStepFrame === f) self._prefetchBack(f);
        }, STEP_BACK_WARM_MS);
    }

    _prefetchBack(f) {
        var be = this._mbBackend, n = this._backChunkSize();
        if (this._backPrefetch || !be || !(n > 1)) return;
        if (typeof window !== 'undefined' && window.LUCID_STEP_BACK_PREFETCH === 0) return;
        var low = f;
        while (low > 0 && be.cache.has(low - 1) && f - low < n) low--;
        if (low <= 0 || f - low >= n) return;
        var self = this, job = { end: low - 1, promise: null };
        job.promise = (async function () {
            var start = await self._backChunkStart(be, job.end, n);
            await self._decodeIntoCache(be, start, job.end, job);
        })().catch(function (e) {
            videoLog("Back-step prefetch failed (" + e.message + ")", "warn");
        }).then(function () { if (self._backPrefetch === job) self._backPrefetch = null; });
        this._backPrefetch = job;
    }

    /**
     * Stop all paused-stepping work: the forward stream, a back-step prefetch and a
     * pending warm-up (frees their decoders and buffered frames). For playback,
     * source switches and close.
     */
    releaseStepCursor() {
        if (this._backWarmTimer) { clearTimeout(this._backWarmTimer); this._backWarmTimer = null; }
        if (this._backPrefetch) { this._backPrefetch.cancelled = true; this._backPrefetch = null; }
        this._closeStepStream();
    }

    /** Close just the forward-stepping stream (reopened at a jump, or idle). */
    _closeStepStream() {
        var c = this._stepCursor;
        this._stepCursor = null;
        if (!c) return;
        if (c.timer) clearTimeout(c.timer);
        try { if (c.it && c.it.return) c.it.return(); } catch (_) { /* ignore */ }
    }

    async getFrame(frameIndex) {
        if (frameIndex < 0 || frameIndex >= this.samples.length) {
            videoLog("Frame index out of range: " + frameIndex, "warn");
            return null;
        }

        // Frame-accurate mediabunny backend (opt-in, issue #115) — tried
        // BEFORE the shared this.cache below, not after. That cache is ALSO
        // written by the HTML5/WebCodecs fallback paths (_getFrameHTML5's
        // addToCache); if this exact frame EVER fell through to HTML5 for any
        // reason (a transient decode hiccup, the brief window before
        // mediabunny finished initializing, anything) it would get cached
        // there, and EVERY future request for that same index — even a
        // single, deliberate, non-racing re-visit — would return the cached,
        // frame-INACCURATE HTML5 bitmap forever, permanently bypassing
        // mediabunny for that one index. Mediabunny keeps its own internal
        // cache (`_mbBackend.cache`), so checking it first costs nothing extra
        // once it already has the frame, and guarantees a poisoned HTML5
        // cache entry can never permanently shadow the correct decode.
        //
        // Serialize concurrent calls into the backend (issue #115 followup) —
        // mirrors _getFrameHTML5's _html5SeekLock a few lines down, and for the
        // same reason. Rapid arrow-key stepping (or auto-repeat) fires overlapping
        // getFrame() calls before the previous one resolves; the mediabunny
        // backend's single-frame decode has no internal queue (only its
        // multi-frame decodeRange does), so two overlapping decodes racing the
        // same underlying WebCodecs decoder can return the WRONG frame or fail
        // outright for one of them — which then falls through to the HTML5 path
        // below for that one frame, i.e. it briefly LOOKS like the pre-#115
        // frame-inaccurate behavior for a single frame, then "snaps back" once
        // the race clears on the next step (unless the wrong result gets
        // cached below, per the above).
        if (this._mbBackend) {
            while (this._mbSeekLock) { await this._mbSeekLock; }
            var resolveMbLock;
            this._mbSeekLock = new Promise(function (r) { resolveMbLock = r; });
            try {
                var mbFrame = await this._mbGetFrame(frameIndex);
                if (mbFrame) return mbFrame;
                videoLog("Mediabunny returned no frame for " + frameIndex + ", falling back to HTML5", "warn");
            } catch (e) {
                videoLog("Mediabunny decode failed for frame " + frameIndex + ": " + e.message + ", falling back to HTML5", "warn");
            } finally {
                this._mbSeekLock = null;
                resolveMbLock();
            }
        }

        // Shared HTML5/WebCodecs cache — mediabunny never writes here, so a
        // hit here only ever means a PRIOR fallback decode for this index.
        if (this.cache.has(frameIndex)) {
            var cached = this.cache.get(frameIndex);
            this.cache.delete(frameIndex);
            this.cache.set(frameIndex, cached);
            return cached;
        }

        // Try WebCodecs path if mp4box is initialized
        if (this._mp4Initialized) {
            try {
                return await this._getFrameWebCodecs(frameIndex);
            } catch (e) {
                videoLog("WebCodecs decode failed for frame " + frameIndex + ": " + e.message + ", falling back to HTML5", "warn");
            }
        }

        // HTML5 video fallback (always works)
        return await this._getFrameHTML5(frameIndex);
    }

    /**
     * The `<video>.currentTime` a stepping seek to `frameIndex` sets: the middle
     * of the frame's presentation interval, `(i + 0.5) / fps` (why: _getFrameHTML5).
     */
    html5SeekTime(frameIndex) {
        var fps = this._fps > 0 ? this._fps : 30;
        return (frameIndex + 0.5) / fps;
    }

    /**
     * Get a frame using the HTML5 <video> element (always works, slower than
     * mediabunny; the path for codecs this browser's WebCodecs cannot decode).
     */
    async _getFrameHTML5(frameIndex) {
        if (!this._videoEl || !this._videoReady) return null;

        // Serialize HTML5 seeks — concurrent seeks on the same <video> element
        // cause the browser to serve stale frames, leading to scrambled output
        while (this._html5SeekLock) {
            await this._html5SeekLock;
        }

        var self = this;
        var resolveLock;
        this._html5SeekLock = new Promise(function (r) { resolveLock = r; });

        try {
            // Seek to the MIDDLE of the frame's interval, not its start. A seek
            // to exactly i/fps sits on the boundary with frame i-1, and browsers
            // round it either way: measured on barcode clips (verify/seek-probe.html,
            // 8 cameras), Firefox 157 showed i-1 for every frame with i % 3 == 2
            // at 60 and 150 fps (63–70% exact), Chrome, Brave and Safari for most
            // frames (7–33%). (i + 0.5)/fps was exact in all 2,160 Firefox seeks
            // (HEVC + H.264) and all H.264 seeks in the other three. rVFC cannot
            // verify it in Firefox: its mediaTime echoes the seek target.
            var time = this.html5SeekTime(frameIndex);

            // Only seek if we're not already at the target time. The tolerance
            // must scale with the frame rate: a fixed constant (e.g. 10 ms)
            // spans multiple frames on high-fps video (at 400 fps a 10 ms band
            // covers ~4 frames), so adjacent-frame requests never re-seek and
            // the display freezes. Half a frame period is the canonical
            // "already on this frame?" threshold — the gap between adjacent
            // frames (1/fps) always exceeds it, so every step re-seeks, while a
            // redundant request for the current frame still short-circuits.
            // Around the frame's middle, that band is the frame's own interval.
            // But only trust currentTime if THIS method put it there: after
            // playback (or a frame-start seek) the picture need not match it —
            // in Firefox the +0 pause re-decode drew the frame AFTER the paused
            // one on 1 pause in 10 by skipping the seek (`_html5Moved`).
            var framePeriod = (this._fps > 0) ? (1 / this._fps) : (1 / 30);
            var currentTime = this._videoEl.currentTime;
            if (this._html5Moved || Math.abs(currentTime - time) > framePeriod / 2) {
                var seekPromise = new Promise(function (resolve) {
                    self._videoEl.addEventListener("seeked", function () { resolve(); }, { once: true });
                    setTimeout(resolve, 5000);
                });
                this._videoEl.currentTime = time;
                await seekPromise;
                this._html5Moved = false;
            }

            // Ensure the video has renderable data (readyState >= 2 = HAVE_CURRENT_DATA)
            if (this._videoEl.readyState < 2) {
                await new Promise(function (resolve) {
                    self._videoEl.addEventListener("canplay", function () { resolve(); }, { once: true });
                    setTimeout(resolve, 5000);
                });
            }

            this._offCtx.drawImage(this._videoEl, 0, 0);
            var bitmap = await createImageBitmap(this._offCanvas);
            this.addToCache(frameIndex, bitmap);
            return bitmap;
        } finally {
            this._html5SeekLock = null;
            resolveLock();
        }
    }

    /**
     * Get a frame using WebCodecs (precise, requires mp4box init).
     */
    async _getFrameWebCodecs(frameIndex) {
        // Decode from nearest keyframe through requested frame + lookahead
        var keyframe = this.findKeyframeBefore(frameIndex);
        var endFrame = Math.min(frameIndex + this.lookahead, this.samples.length - 1);

        await this.decodeRange(keyframe, endFrame);

        // Return from cache
        if (this.cache.has(frameIndex)) {
            var frame = this.cache.get(frameIndex);
            this.cache.delete(frameIndex);
            this.cache.set(frameIndex, frame);
            return frame;
        }

        return null;
    }

    async decodeRange(startFrame, endFrame) {
        // Coalesce overlapping decode requests
        if (this.isDecoding) {
            // Wait for current decode to finish, then retry
            this.pendingFrame = { start: startFrame, end: endFrame };
            return;
        }

        this.isDecoding = true;
        try {
            await this._decodeRangeInternal(startFrame, endFrame);
        } finally {
            this.isDecoding = false;

            // Process pending request if any
            if (this.pendingFrame) {
                var pending = this.pendingFrame;
                this.pendingFrame = null;
                await this.decodeRange(pending.start, pending.end);
            }
        }
    }

    async _decodeRangeInternal(startFrame, endFrame) {
        // Check if all frames are already cached
        var allCached = true;
        for (var i = startFrame; i <= endFrame; i++) {
            if (!this.cache.has(i)) {
                allCached = false;
                break;
            }
        }
        if (allCached) return;

        // Read sample data for the range
        var sampleDataMap = await this.readSampleDataRange(startFrame, endFrame);

        // Create a fresh decoder for this range
        var self = this;
        return new Promise(function (resolve, reject) {
            var framesToDecode = new Map(); // cts -> frameIndex
            for (var i = startFrame; i <= endFrame; i++) {
                var sample = self.samples[i];
                framesToDecode.set(sample.cts, i);
            }

            var decodedCount = 0;
            var totalExpected = endFrame - startFrame + 1;

            var decoder = new VideoDecoder({
                output: function (videoFrame) {
                    var cts = videoFrame.timestamp;
                    var matchedIndex = -1;

                    if (framesToDecode.has(cts)) {
                        matchedIndex = framesToDecode.get(cts);
                    } else {
                        var bestDist = Infinity;
                        for (var entry of framesToDecode) {
                            var dist = Math.abs(entry[0] - cts);
                            if (dist < bestDist) {
                                bestDist = dist;
                                matchedIndex = entry[1];
                            }
                        }
                    }

                    if (matchedIndex >= 0 && matchedIndex >= startFrame && matchedIndex <= endFrame) {
                        self.addToCache(matchedIndex, videoFrame);
                        framesToDecode.delete(self.samples[matchedIndex].cts);
                    } else {
                        videoFrame.close();
                    }

                    decodedCount++;
                    if (decodedCount >= totalExpected) {
                        resolve();
                    }
                },
                error: function (e) {
                    videoLog("Decoder error: " + e.message, "error");
                    reject(e);
                },
            });

            decoder.configure(self.config);

            for (var i = startFrame; i <= endFrame; i++) {
                var sample = self.samples[i];
                var sampleData = sampleDataMap.get(i);
                if (!sampleData) {
                    videoLog("Missing sample data for frame " + i, "warn");
                    decodedCount++;
                    if (decodedCount >= totalExpected) {
                        resolve();
                    }
                    continue;
                }

                var chunk = new EncodedVideoChunk({
                    type: sample.is_sync ? "key" : "delta",
                    timestamp: sample.cts,
                    duration: sample.duration,
                    data: sampleData,
                });

                decoder.decode(chunk);
            }

            decoder.flush().then(function () {
                decoder.close();
                resolve();
            }).catch(function (e) {
                videoLog("Decoder flush error: " + e.message, "error");
                try { decoder.close(); } catch (_) {}
                resolve();
            });
        });
    }

    async readSampleDataRange(startFrame, endFrame) {
        var sampleDataMap = new Map();

        // Collect byte ranges needed
        var ranges = [];
        for (var i = startFrame; i <= endFrame; i++) {
            var sample = this.samples[i];
            ranges.push({
                index: i,
                offset: sample.offset,
                size: sample.size,
            });
        }

        // Sort by offset for sequential reading
        ranges.sort(function (a, b) { return a.offset - b.offset; });

        // Merge nearby ranges into larger reads to reduce I/O
        var mergedReads = [];
        var current = null;

        for (var j = 0; j < ranges.length; j++) {
            var range = ranges[j];
            if (!current) {
                current = {
                    offset: range.offset,
                    end: range.offset + range.size,
                    samples: [range],
                };
            } else {
                var gap = range.offset - current.end;
                if (gap < 65536) {
                    current.end = Math.max(current.end, range.offset + range.size);
                    current.samples.push(range);
                } else {
                    mergedReads.push(current);
                    current = {
                        offset: range.offset,
                        end: range.offset + range.size,
                        samples: [range],
                    };
                }
            }
        }
        if (current) {
            mergedReads.push(current);
        }

        // Read merged ranges and extract sample data
        for (var k = 0; k < mergedReads.length; k++) {
            var read = mergedReads[k];
            var readSize = read.end - read.offset;
            var buffer = await this.readChunk(read.offset, readSize);

            for (var m = 0; m < read.samples.length; m++) {
                var s = read.samples[m];
                var localOffset = s.offset - read.offset;
                var data = new Uint8Array(buffer, localOffset, s.size);
                sampleDataMap.set(s.index, data);
            }
        }

        return sampleDataMap;
    }

    addToCache(frameIndex, videoFrame) {
        // Evict oldest if at capacity
        if (this.cache.size >= this.cacheSize) {
            var oldest = this.cache.keys().next().value;
            var oldFrame = this.cache.get(oldest);
            if (oldFrame && typeof oldFrame.close === "function") {
                oldFrame.close();
            }
            this.cache.delete(oldest);
        }

        this.cache.set(frameIndex, videoFrame);
    }

    /**
     * Draw the current video frame directly to a canvas context (fast, no async).
     * Used during native playback to avoid the seek + createImageBitmap overhead.
     */
    drawCurrentFrame(ctx, width, height) {
        if (this._videoEl && this._videoEl.readyState >= 2) {
            ctx.drawImage(this._videoEl, 0, 0, width, height);
            return true;
        }
        return false;
    }

    /**
     * Snapshot the frame the <video> element would draw right now as a
     * WebCodecs `VideoFrame`, together with ITS frame index — derived from the
     * captured frame's own timestamp, so drawing `frame` and overlaying `index`
     * can never disagree (unlike `drawCurrentFrame` + a clock-derived index).
     * Used by the per-refresh playback loop (`VideoController.startPlayback`).
     *
     * Returns null when it can't (no WebCodecs, not enough data yet, capture
     * threw); the caller falls back to `drawCurrentFrame` + `getCurrentFrameIndex`.
     * The CALLER owns the returned frame and must `close()` it.
     *
     * @returns {{frame: VideoFrame, index: number}|null}
     */
    captureCurrentFrame() {
        var el = this._videoEl;
        if (!el || el.readyState < 2 || typeof VideoFrame !== 'function') return null;
        try {
            var frame = new VideoFrame(el);
            return { frame: frame, index: Math.round((frame.timestamp / 1e6) * this._fps) };
        } catch (e) {
            return null;
        }
    }

    /**
     * Get the current frame index based on the video element's currentTime.
     *
     * Uses `floor` (not `round`): the <video> element displays the frame whose
     * presentation interval [i/fps, (i+1)/fps) contains `currentTime`, i.e.
     * `floor(currentTime * fps)`. `round` overshoots by one once `currentTime`
     * passes a frame's midpoint, which made the pose overlay run ONE FRAME AHEAD
     * of the video during playback and when paused (a pre-existing bug the
     * frame-accurate mediabunny backend exposed, since stepping is now exact so
     * the mismatch is visible). Only the playback loop calls this. The small
     * epsilon absorbs float error at exact frame boundaries.
     */
    getCurrentFrameIndex() {
        if (!this._videoEl) return 0;
        return Math.floor(this._videoEl.currentTime * this._fps + 1e-6);
    }

    /**
     * Start native HTML5 video playback (fast, no per-frame seeking).
     */
    playNative() {
        if (this._videoEl) {
            this._html5Moved = true;
            this._videoEl.play().catch(function () {});
        }
    }

    /**
     * Pause native HTML5 video playback.
     */
    pauseNative() {
        if (this._videoEl) {
            this._videoEl.pause();
        }
    }

    /**
     * Seek the HTML5 video element to a specific frame time (for sync).
     */
    seekNative(frameIndex) {
        if (this._videoEl) {
            this._html5Moved = true;
            this._videoEl.currentTime = frameIndex / this._fps;
        }
    }

    /**
     * Seek the HTML5 video element to a frame and resolve once the seek has
     * SETTLED (the `seeked` event), so a following `play()` isn't rejected for
     * racing an in-flight seek. Resolves immediately if already on the frame.
     *
     * This matters because the frame-accurate mediabunny backend decodes without
     * moving `_videoEl.currentTime`, so after scrubbing the element is stale and
     * `startPlayback`'s pre-play seek is a REAL seek. Calling `play()` while that
     * seek is in flight makes the browser reject it (silently, via playNative's
     * `.catch`), which left playback stuck — "play does nothing after scrubbing"
     * (issue #115 followup). Bounded by a timeout so a missing `seeked` never
     * wedges playback.
     */
    seekNativeSettled(frameIndex) {
        var self = this;
        return new Promise(function (resolve) {
            var el = self._videoEl;
            if (!el) return resolve();
            var time = frameIndex / self._fps;
            var framePeriod = (self._fps > 0) ? (1 / self._fps) : (1 / 30);
            // Also already there when _getFrameHTML5 parked the element on this
            // frame's middle: (i+0.5)/fps - i/fps comes out a hair over half a
            // frame for ~30% of frames in floating point, and re-seeking to the
            // frame START would land on i-1 in Firefox (see _getFrameHTML5).
            if (Math.abs(el.currentTime - time) <= framePeriod / 2
                || el.currentTime === self.html5SeekTime(frameIndex)) {
                return resolve();   // already on this frame — no seek needed
            }
            var done = false;
            function finish() {
                if (done) return;
                done = true;
                el.removeEventListener('seeked', finish);
                resolve();
            }
            el.addEventListener('seeked', finish, { once: true });
            setTimeout(finish, 2000);   // never hang if `seeked` doesn't fire
            self._html5Moved = true;
            el.currentTime = time;
        });
    }

    /**
     * Switch to a new source, reusing the existing video element to avoid
     * Chrome browser-process crashes from repeated element creation/destruction.
     */
    async switchSource(source) {
        // Clear cached frames
        for (var entry of this.cache) {
            if (entry[1] && typeof entry[1].close === "function") {
                entry[1].close();
            }
        }
        this.cache.clear();

        // Close WebCodecs decoder if active
        if (this.decoder) {
            try { this.decoder.close(); } catch (_) {}
            this.decoder = null;
        }

        // Release the frame-accurate mediabunny backend bound to the OLD
        // source (issue #115 regression). Without this, `_mbBackend` keeps
        // pointing at the previous video after a pooled-decoder session
        // switch, so every subsequent getFrame() silently decodes from the
        // WRONG video — frame-accurate for a video nobody is looking at
        // anymore, which reads as the pose overlay drifting off the video.
        // Re-initialized below, after the new element's metadata loads.
        this.releaseStepCursor();
        this._keySink = null;
        if (this._mbBackend) {
            try { this._mbBackend.close(); } catch (_) {}
            this._mbBackend = null;
        }

        this._source = source;
        this.file = source;
        this.sourceType = "file";
        this.fileSize = source.size;
        this.supportsRangeRequests = true;
        this.mp4boxFile = null;
        this._mp4boxReady = false;

        // Revoke old blob URL
        if (this._videoEl && this._videoEl.src && this._videoEl.src.startsWith("blob:")) {
            URL.revokeObjectURL(this._videoEl.src);
        }

        // Reuse existing video element — just change src. Captured locally for
        // the same reason as in `init()`: `close()` nulls `this._videoEl` while
        // a last `error` event is still in flight.
        var el = this._videoEl;
        var metadataPromise = new Promise(function (resolve, reject) {
            el.addEventListener("canplay", function () { resolve(); }, { once: true });
            el.addEventListener("error", function () {
                var err = el.error;
                reject(new Error(err ? "Video error " + err.code : "Video load failed"));
            }, { once: true });
        });

        this._html5Moved = false;   // a new source starts at 0, on frame 0
        this._videoEl.src = URL.createObjectURL(source);
        this._emitProgress({ phase: 'canplay', ratio: 0 });
        await this._awaitPlayable(metadataPromise, source);
        this._emitProgress({ phase: 'canplay', ratio: 1 });

        var width = this._videoEl.videoWidth;
        var height = this._videoEl.videoHeight;
        var duration = this._videoEl.duration;
        var fps = 30;
        this._fps = fps;
        var totalFrames = Math.round(duration * fps);

        // Resize offscreen canvas if needed
        if (this._offCanvas.width !== width || this._offCanvas.height !== height) {
            this._offCanvas.width = width;
            this._offCanvas.height = height;
        }

        this.videoTrack = {
            video: { width: width, height: height },
            codec: "html5",
            timescale: fps,
            duration: Math.round(duration * fps),
        };
        this.config = { codec: "html5", codedWidth: width, codedHeight: height };

        this.samples = new Array(totalFrames);
        for (var i = 0; i < totalFrames; i++) {
            this.samples[i] = { index: i, cts: Math.round(i * 1000000 / fps), duration: Math.round(1000000 / fps), is_sync: false, offset: 0, size: 0 };
        }
        var kfInterval = Math.max(1, Math.round(fps));
        this.keyframeIndices = [];
        for (var j = 0; j < totalFrames; j += kfInterval) {
            this.samples[j].is_sync = true;
            this.keyframeIndices.push(j);
        }
        if (totalFrames > 0) {
            this.samples[0].is_sync = true;
            if (this.keyframeIndices[0] !== 0) this.keyframeIndices.unshift(0);
        }

        this._videoReady = true;
        this.isDecoding = false;
        this.pendingFrame = null;

        // Re-parse mp4 metadata so samples.length reflects the real sample
        // table (vs the duration-times-30-fps estimate computed above).
        try {
            await this._initMp4box();
        } catch (e) {
            videoLog("MP4Box re-init failed (HTML5 fallback will be used): " + e.message, "warn");
            this._emitProgress({ phase: 'mp4box', error: e });
        }

        // Re-initialize the frame-accurate mediabunny backend for the NEW
        // source (issue #115) — mirrors init()'s setup. Must happen for every
        // switchSource(), not just the first init(), or a reused pooled
        // decoder keeps stepping through the previous video after a session
        // switch/reopen.
        this._mbUnavailable = null;
        if (this._mediabunnyEnabled() && (source instanceof Blob || source instanceof File)) {
            try {
                await this._initMediabunny(source);
            } catch (e) {
                videoLog("Mediabunny backend init failed on source switch (HTML5 seek will be used): " + e.message, "warn");
                this._mbBackend = null;
                this._mbUnavailable = { reason: 'init', message: e.message };
            }
        }

        videoLog("Source switched: " + (source.name || "file") + " (" + width + "x" + height + ", ~" + totalFrames + " frames)"
            + (this._mbBackend ? " [mediabunny frame-accurate]" : ""));
    }

    close() {
        // Close all cached frames
        for (var entry of this.cache) {
            if (entry[1] && typeof entry[1].close === "function") {
                entry[1].close();
            }
        }
        this.cache.clear();

        if (this.decoder) {
            try {
                this.decoder.close();
            } catch (_) {}
            this.decoder = null;
        }

        // Release the mediabunny backend (frees its Input/decoder + cached frames)
        this.releaseStepCursor();
        this._keySink = null;
        if (this._mbBackend) {
            try { this._mbBackend.close(); } catch (_) {}
            this._mbBackend = null;
        }

        // Release HTML5 video element
        if (this._videoEl) {
            var src = this._videoEl.src;
            this._videoEl.pause();
            this._videoEl.src = "";
            this._videoEl.load();
            if (src.startsWith("blob:")) {
                URL.revokeObjectURL(src);
            }
            this._videoEl = null;
        }

        this.samples = [];
        this.keyframeIndices = [];
        this.mp4boxFile = null;
        this.config = null;
        this.videoTrack = null;
        videoLog("Decoder closed");
    }
}

// ---------------------------------------------------------------------------
// EmbeddedVideoDecoder - On-demand frame extraction from SLP via frame-worker
// ---------------------------------------------------------------------------
export class EmbeddedVideoDecoder {
    /**
     * Decoder for embedded video frames in SLP files.
     * Uses a frame-worker.js Web Worker with SLPPackageReader for on-demand
     * frame extraction (one frame at a time, no bulk loading).
     *
     * @param {Object} options
     * @param {Worker} options.worker - frame-worker.js Worker instance
     * @param {Object} options.videoInfo - Video metadata from SLPPackageReader.getVideos()
     * @param {number} [options.cacheSize=60] - Number of decoded ImageBitmaps to cache
     */
    constructor(options) {
        this._worker = options.worker;
        this._videoInfo = options.videoInfo;
        this.cacheSize = options.cacheSize || 60;
        this.cache = new Map();
        this._pending = new Map();
        this._closed = false;

        var info = this._videoInfo;
        var width = info.width || 0;
        var height = info.height || 0;

        // Build display frame → embedded index lookup
        this._displayToEmbedded = new Map();
        var maxDisplayFrame = 0;
        var frameNumbers = info.frameNumbers || [];
        for (var i = 0; i < frameNumbers.length; i++) {
            var df = frameNumbers[i];
            this._displayToEmbedded.set(df, i);
            if (df > maxDisplayFrame) maxDisplayFrame = df;
        }
        if (frameNumbers.length === 0) {
            for (var j = 0; j < info.frameCount; j++) {
                this._displayToEmbedded.set(j, j);
            }
            maxDisplayFrame = Math.max(info.frameCount - 1, 0);
        }

        var totalFrames = maxDisplayFrame + 1;
        this.samples = new Array(totalFrames);
        for (var k = 0; k < totalFrames; k++) {
            this.samples[k] = { index: k };
        }

        this.videoTrack = {
            video: { width: width, height: height },
            codec: 'embedded',
            timescale: 30,
            duration: totalFrames,
        };

        this._fps = 30;

        // Listen for frame responses from the worker
        var self = this;
        this._messageHandler = function (e) {
            if (e.data.type === 'frame' && e.data.videoKey === info.key) {
                self._handleFrameResult(e.data);
            }
        };
        this._worker.addEventListener('message', this._messageHandler);

        videoLog("EmbeddedVideoDecoder: " + info.frameCount + " embedded frames, " +
            width + "x" + height + ", videoKey=" + info.key);
    }

    /** @private */
    async _handleFrameResult(data) {
        var embeddedIdx = data.embeddedIdx;
        var displayFrame = data.displayFrame;
        var pending = this._pending.get(embeddedIdx);
        if (!pending) return;

        try {
            var format = data.format || 'png';
            var mimeType = format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : 'image/png';
            var blob = new Blob([data.pngBytes], { type: mimeType });
            var bitmap = await createImageBitmap(blob);
            this._addToCache(displayFrame, bitmap);
            pending.resolve(bitmap);
        } catch (err) {
            pending.resolve(null);
        }
        this._pending.delete(embeddedIdx);
    }

    hasFrame(displayFrame) {
        return this._displayToEmbedded.has(displayFrame);
    }

    async getFrame(displayFrame) {
        if (this._closed) return null;
        if (displayFrame < 0 || displayFrame >= this.samples.length) return null;

        // Check cache
        if (this.cache.has(displayFrame)) {
            var cached = this.cache.get(displayFrame);
            this.cache.delete(displayFrame);
            this.cache.set(displayFrame, cached);
            return cached;
        }

        var embeddedIdx = this._displayToEmbedded.get(displayFrame);
        if (embeddedIdx === undefined) return null;

        // Check if already pending
        if (this._pending.has(embeddedIdx)) {
            return this._pending.get(embeddedIdx).promise;
        }

        // Request frame from worker
        var resolve;
        var promise = new Promise(function (res) { resolve = res; });
        this._pending.set(embeddedIdx, { promise: promise, resolve: resolve });

        this._worker.postMessage({
            type: 'getFrame',
            videoKey: this._videoInfo.key,
            embeddedIdx: embeddedIdx
        });

        return promise;
    }

    /** @private */
    _addToCache(displayFrame, bitmap) {
        if (this.cache.size >= this.cacheSize) {
            var oldest = this.cache.keys().next().value;
            var oldBitmap = this.cache.get(oldest);
            if (oldBitmap && typeof oldBitmap.close === "function") oldBitmap.close();
            this.cache.delete(oldest);
        }
        this.cache.set(displayFrame, bitmap);
    }

    seekNative(frameIndex) {}
    playNative() {}
    pauseNative() {}
    drawCurrentFrame(ctx, width, height) { return false; }
    getCurrentFrameIndex() { return 0; }

    close() {
        this._closed = true;
        if (this._messageHandler && this._worker) {
            this._worker.removeEventListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        for (var entry of this.cache) {
            if (entry[1] && typeof entry[1].close === "function") entry[1].close();
        }
        this.cache.clear();
        for (var p of this._pending.values()) p.resolve(null);
        this._pending.clear();
        this.samples = [];
        this.videoTrack = null;
        videoLog("EmbeddedVideoDecoder closed");
    }
}

// ---------------------------------------------------------------------------
// Playback presentation schedule (per-refresh loop)
// ---------------------------------------------------------------------------

/**
 * Decides which frame index SHOULD be on screen at each display refresh during
 * native playback, from a frame clock locked to the refresh timestamps.
 *
 * Why: the per-refresh loop can only show whatever frame a `<video>` hands it
 * at that moment. Sampling a free-running video clock once per refresh makes
 * frames whose boundary falls near a refresh flip between being held 3 and 1
 * refreshes (60 fps on 120 Hz: ~30% of frames irregular, measured with
 * tests/e2e/_bench-playback.mjs). A clock that advances by exactly
 * `rate * refreshInterval` per refresh gives the ideal cadence instead (2,2,2…
 * for 60 fps on 120 Hz; 1,1,1,2… for 150 fps).
 *
 * The clock is anchored on the primary view's captured frame and its phase is
 * chosen so frame boundaries sit as far as possible from refresh instants
 * (a frame is `step` refreshes long with `step = rate * period`; for
 * `step <= 1` the boundary is put `step/2` into the refresh interval, e.g. a
 * quarter frame for 60 fps on 120 Hz). Clock drift is absorbed by a slow,
 * dead-banded correction (rare whole adjustments rather than continuous
 * nudges, which would themselves move boundaries back and forth); a large
 * disagreement (stall, seek, rate change) re-anchors.
 *
 * Pure (no DOM, no timers): `update()` is fed the refresh timestamp, the
 * primary's captured index and the content rate, and returns the target.
 */
export class PlaybackSchedule {
    constructor() {
        this.reset();
    }

    reset() {
        this._t0 = null;      // anchor time (ms, refresh timestamp)
        this._i0 = 0;         // continuous frame position p at the anchor
        this._rate = 0;       // frames per ms
        this._phase = 0.5;    // frac(p) chosen at the anchor (boundary margin)
        this._ea = 0;         // smoothed clock error (frames)
        this._lastNow = null;
        this._period = null;  // refresh interval (ms), measured before anchoring
        this._deltas = [];    // first few refresh intervals
    }

    /**
     * @param {number} now - refresh timestamp (ms; the rAF callback argument)
     * @param {number} capturedIdx - frame index the primary view handed us now
     * @param {number} rate - content frames per ms (fps * playbackRate / 1000)
     * @returns {number} the frame index that should be on screen this refresh
     */
    update(now, capturedIdx, rate) {
        if (this._lastNow != null) this._observeInterval(now - this._lastNow);
        this._lastNow = now;
        // The anchor phase depends on frames-per-refresh, so don't anchor until
        // the refresh interval is measured (a 60 Hz guess on a 120 Hz display
        // put frame boundaries exactly ON refresh instants, where microsecond
        // timestamp jitter flips frames between 1 and 3 refreshes for the whole
        // playback). Until then, show what was captured.
        if (this._period == null) return capturedIdx;

        // Only schedule when a frame spans MORE than one refresh (60 fps on
        // 120 Hz, 30 on 60): then the question is on WHICH refresh each frame
        // changes, which naive sampling answers irregularly. When the video is
        // as fast as the display or faster (60 on 60, 150 on 120), every
        // refresh simply shows the newest frame; a schedule there can only add
        // holds (simulated 59.94 fps on 60 Hz: 11–18% irregular scheduled vs
        // 5–8% naive).
        if (rate * this._period >= 0.9) {
            this._t0 = null;            // re-anchor if the ratio changes later
            return capturedIdx;
        }

        if (this._t0 == null || rate !== this._rate) {
            this._anchor(now, capturedIdx, rate);
        } else {
            // Error between where the captures say the video is and the model.
            // At the anchor p = capturedIdx + phase, so that is the expected
            // relation; quantization noise (±0.5) averages out in `_ea`.
            var err = (capturedIdx + this._phase) - this._position(now);
            var step = this._rate * this._period;
            if (Math.abs(err) > Math.max(3, 2 * step)) {
                this._anchor(now, capturedIdx, rate);
            } else {
                this._ea = 0.9 * this._ea + 0.1 * err;
                // Correct only GENUINE drift (the video and refresh clocks both
                // run off the system clock, so it is rare; stalls/seeks
                // re-anchor above): the anchor's single capture leaves a
                // constant offset of up to ~½ frame, which must not trigger a
                // correction — each one shifts the cadence by a refresh. Then
                // correct in units that keep frame boundaries where the anchor
                // put them (whole frames, or whole refresh-steps when a step is
                // under a frame).
                var unit = Math.min(step, 1);
                if (Math.abs(this._ea) > Math.max(0.8, 0.75 * unit)) {
                    this._i0 += Math.round(this._ea / unit) * unit;
                    this._ea = 0;
                }
            }
        }
        return Math.floor(this._position(now));
    }

    _observeInterval(dt) {
        if (!(dt > 3 && dt < 50)) return;
        if (this._period == null) {
            this._deltas.push(dt);
            // min of the first few: a missed vsync only ever makes one LONGER
            if (this._deltas.length >= 4) this._period = Math.min.apply(null, this._deltas);
            return;
        }
        if (Math.abs(dt - this._period) < 0.25 * this._period) {
            this._period = 0.95 * this._period + 0.05 * dt;
        }
    }

    _position(now) {
        return this._i0 + (now - this._t0) * this._rate;
    }

    _anchor(now, capturedIdx, rate) {
        this._rate = rate;
        // Refresh instants land at frac(p) = phase + k*step (mod 1). Put them
        // half a lattice spacing away from a boundary: ¼ frame for 60 fps on
        // 120 Hz (step ½), ⅛ for 150 on 120 (step 1¼), ½ for 60 on 60 (step 1).
        var step = rate * this._period;
        var fs = step - Math.floor(step);
        var frac = (fs < 0.02 || fs > 0.98) ? 0.5 : fs / 2;
        // …and run the clock one phase-preserving unit BEHIND the captures
        // (a refresh-step when steps are under a frame, else a whole frame),
        // so the frame each slot needs has normally been captured already —
        // otherwise capture jitter leaves it missing and the loop holds the old
        // frame a refresh then double-steps. Costs ≤ 1 frame of latency, never
        // alignment.
        var lag = Math.min(step, 1);
        this._t0 = now;
        this._i0 = capturedIdx + frac - lag;
        this._ea = 0;
        this._phase = frac - lag;
    }
}

/**
 * For one view at one refresh, pick which frame to show: the one already on
 * the canvas (`shownIdx`), one captured earlier and held (`pendingIdx`), or
 * this refresh's capture (`capIdx`). Any argument may be null.
 *
 * - The schedule hasn't moved past the shown frame (`target <= shownIdx`):
 *   keep it (never run ahead of the schedule).
 * - It has: show the NEWER candidate closest to `target` (lower on ties) —
 *   never hold the old frame while a newer one is available. With 150 fps on a
 *   120 Hz display the loop can only capture ~4 of every 5 frames, so the exact
 *   target frame is often missing; a plain "closest, ties keep the lower" rule
 *   then held the old frame whenever it and the next capture were equally far
 *   from the target (measured: ~20% of frames held twice in a bad pass).
 * - Nothing on screen yet: the candidate closest to `target`.
 *
 * @returns {'shown'|'pending'|'cap'|null}
 */
export function pickScheduledFrame(target, shownIdx, pendingIdx, capIdx) {
    if (shownIdx != null && target <= shownIdx) return 'shown';
    // Among frames newer than the one on screen: the largest not past the
    // target; failing that, the smallest past it (never run further ahead than
    // needed — running ahead makes the NEXT refresh hold).
    var below = null, belowIdx = -Infinity, above = null, aboveIdx = Infinity;
    var cands = [['pending', pendingIdx], ['cap', capIdx]];
    for (var i = 0; i < cands.length; i++) {
        var idx = cands[i][1];
        if (idx == null || (shownIdx != null && idx <= shownIdx)) continue;
        if (idx <= target) { if (idx > belowIdx) { below = cands[i][0]; belowIdx = idx; } }
        else if (idx < aboveIdx) { above = cands[i][0]; aboveIdx = idx; }
    }
    if (below) return below;
    if (above) return above;
    return shownIdx != null ? 'shown' : null;
}

/**
 * Whether this browser's requestVideoFrameCallback is COALESCED — fires at a
 * fixed low rate covering several presented pictures per callback — rather
 * than once per presented picture.
 *
 * Measured with tests/e2e/_probe-capabilities.mjs on real browsers: Firefox
 * fires ~24 callbacks/s whatever the video rate (2–6 pictures each, while the
 * picture itself changes 49–120×/s); Safari fires once per picture it shows
 * (callbacks/s == picture changes/s, even when it can only show ~24/s with 8
 * cameras); Chrome once per presented frame. rVFC exposes nothing that tells
 * the two cases apart (Safari also reports presentedFrames +2 per callback),
 * so this is the one engine check: Gecko.
 */
function rvfcCallbacksCoalesced() {
    try { return /\bFirefox\//.test(navigator.userAgent); } catch (e) { return false; }
}

/**
 * Whether `new VideoFrame(<video>)` is pointless, so never called: WebKit.
 * Measured in Safari 27 on off-DOM playing `<video>`s made like the decoder's
 * (verify/probe-paint.html, barcode clips): the timestamp is 0 or an exact
 * copy of `currentTime` — the CLOCK, never the captured frame's own time — and
 * named the captured picture in 0–3% of captures. A clock reading can still
 * pass `judgeVideoFrameTimestamps` (the old judge passed it at 150 fps, and
 * the picture then lagged the overlay by 1–13 frames; one on the frame grid
 * would pass the current one), while drawing the captures cost ~25% of the
 * pictures Safari presents. Skipping even the judging captures loses nothing,
 * and the engine is the only signal before the first one. (Every iOS browser
 * is WebKit, hence no `Safari/` test.)
 */
function videoFrameCaptureUnsafe() {
    try {
        var ua = navigator.userAgent;
        return /AppleWebKit\//.test(ua) && !/(Chrome|Chromium|Firefox)\//.test(ua);
    } catch (e) { return false; }
}

/**
 * Decide, per decoder, whether `new VideoFrame(<video>).timestamp` tracks the
 * picture — the per-refresh loop's frame index depends on it. Chrome: yes.
 * Safari 27: 0 or the clock (and never asked — `videoFrameCaptureUnsafe`).
 * Firefox 157: a constant. Judged once the video clock has advanced a few
 * frames since the first capture: usable only if the timestamp moved, agrees
 * with the clock to within max(3 frames, 50 ms) — the presented frame trails
 * the clock by the compositor's latency, which at 150 fps on a 60 Hz display
 * exceeds 3 frames and made Brave fall back mid-session — and is not simply
 * the clock itself (equal to `currentTime` to the microsecond while off the
 * frame grid: a real frame's timestamp sits on it). Cached on the decoder as
 * `_vfTimestamps` ('ok' | 'bad'); undefined while undecided.
 *
 * @returns {'ok'|'bad'|undefined}
 */
function judgeVideoFrameTimestamps(dec, cap) {
    var el = dec._videoEl;
    if (!el || !cap || !cap.frame) return undefined;
    var fps = dec._fps || 30;
    var ctIdx = Math.floor(el.currentTime * fps + 1e-6);
    var chk = dec._vfTsCheck;
    if (!chk || ctIdx < chk.ct) {   // first look (or the clock went back: a seek) — start over
        dec._vfTsCheck = { ts: cap.frame.timestamp, ct: ctIdx };
        return undefined;
    }
    if (ctIdx - chk.ct < 4) return undefined;
    var ts = cap.frame.timestamp;
    var moved = ts !== chk.ts;
    var agrees = Math.abs(cap.index - ctIdx) <= Math.max(3, Math.ceil(0.05 * fps));
    var pos = ts / 1e6 * fps;
    var isClock = Math.abs(ts - el.currentTime * 1e6) < 1 && Math.abs(pos - Math.round(pos)) > 0.02;
    dec._vfTsCheck = null;
    dec._vfTimestamps = (moved && agrees && !isClock) ? 'ok' : 'bad';
    videoLog('Playback: VideoFrame timestamps ' + (dec._vfTimestamps === 'ok'
        ? 'track the video — painting captured frames'
        : 'do NOT track the video in this browser — drawing the <video> directly, frame index from '
          + (el.requestVideoFrameCallback ? 'requestVideoFrameCallback' : 'its clock')));
    return dec._vfTimestamps;
}

/**
 * Which frame `drawImage(<video>)` paints at a given instant, in a browser
 * whose requestVideoFrameCallback is COALESCED (Firefox — see
 * `rvfcCallbacksCoalesced`), from those callbacks alone.
 *
 * Firefox queues decoded frames with wall-clock due times T_k = T_0 + k/fps
 * and `drawImage` paints the last one due by the instant of the call, so the
 * painted frame is floor(t·r + φ) with r = frames/ms and one unknown phase φ
 * per element (measured: the picture-implied φ is constant to ~0.02 frame over
 * a 2.5 s playback, verify/ff-phase.mjs). Each callback bounds T_m of the
 * frame it reports: `expectedDisplayTime == now` ("composited") means
 * T_m ∈ (now − P, now]; `expectedDisplayTime > now` (the next frame, due by
 * the next refresh) means T_m ∈ (now, expectedDisplayTime] — P the refresh
 * interval, read off the latter. Every bound is one refresh wide and, since
 * callbacks fire on refreshes, 60 fps on 120 Hz keeps landing on the same two
 * phases, so the intersection stays ~½ frame wide: a draw is CERTAIN only when
 * no frame boundary can fall between the instant and the bound's edges.
 * With ≤ ~½ frame per refresh (60 fps at 120 Hz) `VideoController` skips an
 * uncertain refresh when the next would be certain — the frame lands one
 * refresh later, at no cost in cadence; with more (60 fps at 60 Hz, where
 * every bound is a whole refresh wide; 150 fps) it draws the midpoint guess.
 * The previous projection, `round(mediaTime + (now − callback))`, ran 1–3
 * frames AHEAD of the picture: it projected from the callback rather than the
 * frame's due time, and rounded.
 *
 * A bound that contradicts the others replaces them — frames arriving late
 * at once, a jump AHEAD only once the next callback confirms it (Firefox
 * sometimes reports a frame ~10 ahead that is never painted) — and a callback
 * that only re-reports a frame (the paused start frame, a stall) is ignored.
 * Pure — unit-tested in tests/test-playback-frame-sync.js.
 */
export class CoalescedFrameClock {
    constructor() { this.reset(); }

    reset() {
        this._lo = -Infinity;   // φ ∈ [_lo, _hi)
        this._hi = Infinity;
        this._rate = 0;         // frames per ms
        this._period = null;    // refresh interval (ms), from 'next-frame' callbacks
        this._fallbackPeriod = null;   // …or as measured by the caller, until then
        this._lastNow = null;
        this._suspect = null;   // an unconfirmed jump ahead: {lo, hi}
        this.lastIndex = null;  // frame index of the latest callback
    }

    /**
     * @param {number} now - the callback's `now` (ms)
     * @param {number} index - round(metadata.mediaTime * fps)
     * @param {number|undefined} expectedDisplayTime - metadata.expectedDisplayTime (ms)
     * @param {number} rate - frames per ms (fps * playbackRate / 1000)
     * @param {number} [fallbackPeriod] - refresh interval to assume until one is seen (ms)
     */
    observe(now, index, expectedDisplayTime, rate, fallbackPeriod) {
        if (rate !== this._rate) { this.reset(); this._rate = rate; }
        if (fallbackPeriod) this._fallbackPeriod = fallbackPeriod;
        var edt = (typeof expectedDisplayTime === 'number') ? expectedDisplayTime : now;
        var E = 0.25;   // ms of slack on every bound (vsync timestamp jitter; wider only lost certainty, measured)
        var L, H;
        if (edt - now > 0.5) {           // the next frame, due by the next refresh
            this._period = edt - now;
            L = index - (edt + E) * rate;
            H = index - (now - E) * rate;
        } else {
            // Already due (T_m <= now) while the NEXT frame isn't due by the
            // next refresh: T_m > now + P - 1/fps. When a frame is shorter than
            // a refresh that can't happen with frames queued on time — the
            // decoder is behind — so assume only that m is under a frame old.
            // Only for a NEW frame, though: the first callback of a playback
            // reports the paused start frame, which is on screen because of
            // the pause, not the frame clock — measured 1–20 ms outside this
            // bound, and on EITHER side (it pinned the phase ~6 ms early and
            // the frame one ahead for cameras drawn late in the refresh) — and
            // a stall keeps reporting one frame long after it was due. Such a
            // callback says nothing about the clock.
            if (this.lastIndex == null || index <= this.lastIndex) {
                // Reported frame went BACK (seek, decoder glitch — measured
                // once: 154 -> 147 mid-play): the clock is unknown again.
                if (this.lastIndex != null && index < this.lastIndex - 1) {
                    var keepRate = this._rate, keepP = this._period, keepFP = this._fallbackPeriod;
                    this.reset();
                    this._rate = keepRate; this._period = keepP; this._fallbackPeriod = keepFP;
                }
                this._suspect = null;
                this._lastNow = now;
                this.lastIndex = index;
                return;
            }
            var P = this._period || this._fallbackPeriod || 1000 / 60, F = 1 / rate;
            var back = F > P ? F - P : F;
            L = index - (now + E) * rate;
            H = index - (now - back - E) * rate;
        }
        // Slack for clock drift between callbacks (≤ 0.05 frame/s).
        if (this._lastNow != null) {
            var w = 5e-5 * Math.max(0, now - this._lastNow);
            this._lo -= w; this._hi += w;
        }
        var lo = Math.max(this._lo, L), hi = Math.min(this._hi, H);
        if (lo < hi) {
            this._lo = lo; this._hi = hi;
            this._suspect = null;
        } else if (L >= this._hi && !(this._suspect && L < this._suspect.hi && H > this._suspect.lo)) {
            // Puts the frame further AHEAD than the clock allows. Firefox
            // occasionally reports a frame ~10 ahead that is never painted
            // (measured, 8 HEVC cameras: 448 -> 460 -> 452 within 80 ms), so
            // adopt it only once the next callback agrees. Not its index
            // either, or the true frame after it would look like a step back.
            this._suspect = { lo: L, hi: H };
            this._lastNow = now;
            return;
        } else {
            // Behind the clock (frames arriving late), or an ahead jump the
            // next callback confirmed: start over from the latest evidence.
            if (this._suspect && L < this._suspect.hi && H > this._suspect.lo) {
                L = Math.max(L, this._suspect.lo); H = Math.min(H, this._suspect.hi);
            }
            this._lo = L; this._hi = H;
            this._suspect = null;
        }
        this._lastNow = now;
        this.lastIndex = index;
    }

    /**
     * The frame painted at wall time `t` (ms; performance.now()).
     * @param {number} t
     * @param {number} [slackMs] - uncertainty of `t` itself (Firefox rounds
     *   performance.now() to 1 ms)
     * @returns {{index: number, certain: boolean, step: number|null}|null} —
     *   `index` is the midpoint guess when not `certain`; `step` is frames per
     *   refresh (null until a refresh interval is seen); null until a
     *   callback has said something about the frame clock
     */
    frameAt(t, slackMs) {
        if (!isFinite(this._lo) || !isFinite(this._hi)) return null;
        var s = slackMs || 0, r = this._rate;
        var a = Math.floor((t - s) * r + this._lo + 1e-9);
        var b = Math.floor((t + s) * r + this._hi - 1e-9);
        var mid = Math.floor(t * r + (this._lo + this._hi) / 2);
        var P = this._period || this._fallbackPeriod;
        // With a jump ahead awaiting confirmation, nothing is certain.
        return { index: a === b ? a : mid, certain: a === b && !this._suspect, step: P ? r * P : null };
    }
}

// ---------------------------------------------------------------------------
// VideoController - Synchronized multi-view playback with overlay support
// ---------------------------------------------------------------------------
export class VideoController {
    /**
     * @param {Object} state - Shared application state
     *   state.views: Array of { name, decoder, canvas, ctx, overlayCanvas, overlayCtx }
     *   state.currentFrame: number
     *   state.totalFrames: number
     *   state.fps: number
     *   state.isPlaying: boolean
     *   state.playInterval: number|null
     * @param {Object} callbacks
     *   callbacks.updateSeekbar: (frameIndex) => void
     *   callbacks.drawOverlays: (frameIndex) => void
     *   callbacks.onPlaybackStateChange: (isPlaying) => void
     *   callbacks.log: (msg, level) => void
     */
    constructor(state, callbacks) {
        this.state = state;
        this.callbacks = callbacks || {};
        this._scrubPending = false;
        this._scrubTarget = null;
        this._isSeeking = false;
    }

    /**
     * Seek all views to the given frame in parallel, render, and call callbacks.
     */
    async seekToFrame(frameIndex) {
        if (frameIndex < 0) frameIndex = 0;
        if (frameIndex >= this.state.totalFrames) frameIndex = this.state.totalFrames - 1;

        this.state.currentFrame = frameIndex;

        // Decode all views in parallel
        var views = this.state.views.filter(function (v) { return v.decoder; });
        var framePromises = views.map(function (view) {
            return view.decoder.getFrame(frameIndex).catch(function (e) {
                videoLog("Error decoding frame " + frameIndex + " for view " + view.name + ": " + e.message, "error");
                return null;
            });
        });

        var frames = await Promise.all(framePromises);

        // Render each frame to its canvas and clear/redraw overlays
        for (var i = 0; i < views.length; i++) {
            var view = views[i];
            var videoFrame = frames[i];

            if (videoFrame && view.ctx && view.canvas) {
                // Draw video frame to the main canvas
                view.ctx.drawImage(videoFrame, 0, 0, view.canvas.width, view.canvas.height);
            }

            // Clear the overlay canvas for fresh overlay drawing
            if (view.overlayCtx && view.overlayCanvas) {
                view.overlayCtx.clearRect(0, 0, view.overlayCanvas.width, view.overlayCanvas.height);
            }
        }

        // Call overlay drawing callback (e.g., render pose skeletons)
        // Wrapped in try-catch so seekbar always updates even if overlays fail
        if (this.callbacks.drawOverlays) {
            try {
                this.callbacks.drawOverlays(frameIndex);
            } catch (e) {
                console.error('[seekToFrame] drawOverlays error:', e);
            }
        }

        // Update seekbar position
        if (this.callbacks.updateSeekbar) {
            this.callbacks.updateSeekbar(frameIndex);
        }
    }

    /**
     * Coalesced seeking during scrubbing - drops intermediate frames
     * to keep the UI responsive during fast mouse drags.
     */
    scrubToFrame(frame) {
        // Scrubbing implies pausing. Stop native playback first so the rAF play
        // loop and the scrub don't fight over the frame and `state.isPlaying`
        // stays consistent with reality (a stuck `isPlaying` makes the play
        // button no-op — issue #115 followup).
        if (this.state.isPlaying) this.stopPlayback();

        this._scrubTarget = frame;

        if (this._isSeeking) {
            // Already seeking, the target is saved and will be processed
            return;
        }

        this._processScrub();
    }

    async _processScrub() {
        if (this._scrubTarget === null) return;

        this._isSeeking = true;
        var target = this._scrubTarget;
        this._scrubTarget = null;

        try {
            await this.seekToFrame(target);
        } catch (e) {
            videoLog("Scrub seek error: " + e.message, "error");
        }

        this._isSeeking = false;

        // If another scrub came in while we were seeking, process it
        if (this._scrubTarget !== null) {
            this._processScrub();
        }
    }

    /**
     * Toggle playback on/off.
     */
    togglePlayback() {
        if (this.state.isPlaying) {
            this.stopPlayback();
        } else {
            this.startPlayback();
        }
    }

    /**
     * Whether buffered mediabunny playback is enabled. OPT-IN only
     * (`window.LUCID_PLAYBACK_BACKEND='buffered'` / `'mediabunny'`): the
     * buffered path is frame-accurate but DECODE-BOUND — WebCodecs can't
     * software-decode real-time multi-view HEVC, so it plays in choppy spurts.
     * The native <video> path (default) plays smoothly; frame-accurate STEPPING
     * still uses the mediabunny backend regardless of this setting, so only
     * continuous playback differs.
     */
    _bufferedPlaybackEnabled() {
        try {
            var flag = (typeof window !== 'undefined') && window.LUCID_PLAYBACK_BACKEND;
            return flag === 'buffered' || flag === 'mediabunny';
        } catch (_) { /* ignore */ }
        return false;
    }

    /**
     * Which loop drives NATIVE playback:
     * - `'refresh'` (default): redraw on every display refresh from per-view
     *   `VideoFrame` captures, each view overlaid at its own captured frame.
     * - `'rvfc'` (opt-in via `window.LUCID_PLAYBACK_LOOP='rvfc'`): the previous
     *   loop, driven by the PRIMARY view's requestVideoFrameCallback — every
     *   view redrawn at the primary's presented-frame index. Kept for A/B.
     * @returns {'refresh'|'rvfc'}
     */
    _playbackLoopMode() {
        try {
            if (typeof window !== 'undefined' && window.LUCID_PLAYBACK_LOOP === 'rvfc') return 'rvfc';
        } catch (_) { /* ignore */ }
        return 'refresh';
    }

    /**
     * Buffered, video-led playback off the mediabunny decode cache.
     *
     * Producer: `pump(view)` keeps decoding CHUNK-sized ranges ahead of the
     * playhead into each backend's LRU cache (serialized per backend via
     * `view._mbBusy` so two `decodeRange` streams never run on one sink at once).
     * The backend `cacheSize` is enlarged to `W + CHUNK + margin` so the whole
     * read-ahead window survives eviction, and restored on stop.
     *
     * Consumer: a wall-clock rAF loop computes the real-time target frame, then
     * advances `drawn` only to the newest frame <= target that is decoded in
     * EVERY view (`allCached`). `paint(f)` draws each view's cached bitmap and
     * the pose overlay for that SAME `f` synchronously — so the overlay can
     * never lead the video. Under decode pressure it drops frames (jumps `drawn`
     * forward to stay real-time) or holds the last frame during an underrun;
     * either way video and overlay share one index. Tunables:
     * `window.LUCID_PLAYBACK_BUFFER` (frames ahead), `LUCID_PLAYBACK_CHUNK`.
     */
    _startBufferedPlayback(views) {
        var self = this;
        var now = function () {
            return (typeof performance !== 'undefined' && performance.now)
                ? performance.now() : Date.now();
        };
        var fps = this.state.fps || (views[0].decoder && views[0].decoder._fps) || 30;
        var speed = this.state.speedMultiplier || 1.0;
        var startFrame = this.state.currentFrame;
        var total = this.state.totalFrames;

        var win = (typeof window !== 'undefined') ? window : {};
        var W = win.LUCID_PLAYBACK_BUFFER || Math.max(24, Math.round(fps));   // ~1s read-ahead
        var CHUNK = win.LUCID_PLAYBACK_CHUNK || 12;                            // decode granularity
        var MARGIN = 16;

        // Enlarge each backend's cache so the read-ahead window survives LRU
        // eviction; remember the original size to restore on stop.
        views.forEach(function (v) {
            var b = v.decoder._mbBackend;
            v._mbSavedCacheSize = b.cacheSize;
            b.cacheSize = Math.max(b.cacheSize, W + CHUNK + MARGIN);
            v._mbFrontier = startFrame;   // next frame index this view still needs decoded
            v._mbBusy = false;
        });
        self._bufViews = views;   // for stopPlayback cleanup

        self._playTarget = startFrame;
        var drawn = startFrame - 1;
        var startTime = now();

        function pump(v) {
            var b = v.decoder && v.decoder._mbBackend;
            if (!b || v._mbBusy || !self.state.isPlaying) return;
            var want = Math.min(self._playTarget + W, total - 1);
            var start = Math.max(v._mbFrontier, drawn + 1);   // skip frames already passed
            if (start > want) { v._mbFrontier = start; return; }   // buffer full enough
            var end = Math.min(start + CHUNK - 1, want);
            v._mbBusy = true;
            b.prefetch(start, end).then(function () {
                v._mbFrontier = end + 1;
                v._mbBusy = false;
                if (self.state.isPlaying) pump(v);   // keep filling toward `want`
            }).catch(function () { v._mbBusy = false; });
        }

        function allCached(f) {
            for (var i = 0; i < views.length; i++) {
                var b = views[i].decoder._mbBackend;
                if (!b || !b.cache || !b.cache.has(f)) return false;
            }
            return true;
        }

        // Optional instrumentation (window.LUCID_PLAYBACK_DEBUG) — one line/sec:
        // achieved fps, mean video-draw ms, mean overlay ms, underrun ratio and
        // buffer depth. This tells us whether playback is DECODE-bound (high
        // underrun, deep buffer never fills) or OVERLAY-bound (high overlay ms).
        var DEBUG = !!(win.LUCID_PLAYBACK_DEBUG);
        var dbg = { painted: 0, drawMs: 0, ovMs: 0, under: 0, ticks: 0, last: startTime };

        function paint(f) {
            var t0 = DEBUG ? now() : 0;
            for (var i = 0; i < views.length; i++) {
                var view = views[i];
                var b = view.decoder._mbBackend;
                var bmp = b.cache.get(f);
                if (bmp && view.ctx && view.canvas) {
                    // Touch LRU order so the just-shown frame isn't evicted next.
                    b.cache.delete(f); b.cache.set(f, bmp);
                    view.ctx.drawImage(bmp, 0, 0, view.canvas.width, view.canvas.height);
                }
                if (view.overlayCtx && view.overlayCanvas) {
                    view.overlayCtx.clearRect(0, 0, view.overlayCanvas.width, view.overlayCanvas.height);
                }
            }
            var t1 = DEBUG ? now() : 0;
            self.state.currentFrame = f;
            if (self.callbacks.drawOverlays) self.callbacks.drawOverlays(f);
            if (self.callbacks.updateSeekbar) self.callbacks.updateSeekbar(f);
            if (DEBUG) { dbg.painted++; dbg.drawMs += (t1 - t0); dbg.ovMs += (now() - t1); }
        }

        function loop() {
            if (!self.state.isPlaying) return;
            var elapsed = (now() - startTime) / 1000;
            var target = startFrame + Math.floor(elapsed * fps * speed);
            if (target > total - 1) target = total - 1;
            self._playTarget = target;

            if (target > drawn) {
                // Advance to the newest frame <= target decoded in ALL views.
                var f = target;
                while (f > drawn && !allCached(f)) f--;
                if (f > drawn) { drawn = f; paint(f); }
                else if (DEBUG) { dbg.under++; }   // underrun — held last frame
            }

            for (var i = 0; i < views.length; i++) pump(views[i]);

            if (DEBUG) {
                dbg.ticks++;
                var tn = now();
                if (tn - dbg.last >= 1000) {
                    var secs = (tn - dbg.last) / 1000;
                    var minFrontier = Infinity;
                    for (var vi = 0; vi < views.length; vi++) {
                        minFrontier = Math.min(minFrontier, views[vi]._mbFrontier);
                    }
                    videoLog('[buffered] ' + (dbg.painted / secs).toFixed(1) + ' fps'
                        + ' | draw ' + (dbg.painted ? (dbg.drawMs / dbg.painted).toFixed(1) : '0') + 'ms'
                        + ' overlay ' + (dbg.painted ? (dbg.ovMs / dbg.painted).toFixed(1) : '0') + 'ms'
                        + ' | underrun ' + dbg.under + '/' + dbg.ticks
                        + ' | buffered ' + (minFrontier - 1 - drawn) + ' ahead (drawn=' + drawn + ' target=' + target + ')');
                    dbg.painted = 0; dbg.drawMs = 0; dbg.ovMs = 0; dbg.under = 0; dbg.ticks = 0; dbg.last = tn;
                }
            }

            if (drawn >= total - 1 && target >= total - 1) { self.stopPlayback(); return; }
            self._playRAF = requestAnimationFrame(loop);
        }

        // Prime the buffer, then start the clock/loop.
        for (var i = 0; i < views.length; i++) pump(views[i]);
        self._playRAF = requestAnimationFrame(loop);
    }

    /**
     * Start playback using native HTML5 video play + requestAnimationFrame.
     * This is much faster than per-frame seeking because the browser handles
     * decoding natively and we just draw the current video frame each animation frame.
     */
    startPlayback() {
        if (this.state.isPlaying) return;

        this.state.isPlaying = true;
        var self = this;
        // playback decodes on its own; free the paused-stepping streams' decoders
        this.state.views.forEach(function (v) { if (v.decoder && v.decoder.releaseStepCursor) v.decoder.releaseStepCursor(); });

        // ------------------------------------------------------------------
        // Buffered mediabunny playback (issue #115 follow-up) — OPT-IN.
        //
        // The buffered path is VIDEO-LED and frame-accurate: it only advances to
        // a frame already decoded in the cache of EVERY view, then paints that
        // frame's video bitmap AND its pose overlay for the SAME index in one
        // synchronous pass, so the overlay can never lead the video. BUT it is
        // decode-bound — WebCodecs can't sustain real-time multi-view HEVC
        // decode, so it plays in choppy spurts. It is therefore OPT-IN only
        // (`_bufferedPlaybackEnabled()`, via `window.LUCID_PLAYBACK_BACKEND`);
        // the default is the smooth native <video> path below. Frame-accurate
        // stepping/seeking uses the mediabunny backend on BOTH paths, so only
        // continuous playback differs.
        var allViews = this.state.views.filter(function (v) { return v.decoder; });
        var mbViews = allViews.filter(function (v) { return v.decoder._mbBackend; });
        if (allViews.length > 0 && mbViews.length === allViews.length
            && this._bufferedPlaybackEnabled()) {
            this._startBufferedPlayback(allViews);
            if (this.callbacks.onPlaybackStateChange) {
                this.callbacks.onPlaybackStateChange(true);
            }
            videoLog("Playback started (buffered mediabunny)");
            return;
        }

        // Start native playback on all decoders
        // Compute effective playback rate: (desired FPS / native FPS) * speed multiplier
        var speedMult = this.state.speedMultiplier || 1.0;
        var views = this.state.views.filter(function (v) { return v.decoder; });
        var nativeFps = (views.length > 0 && views[0].decoder.videoTrack && views[0].decoder.videoTrack.duration > 0)
            ? views[0].decoder.samples.length / (views[0].decoder.videoTrack.duration / views[0].decoder.videoTrack.timescale)
            : (this.state.fps || 30);
        var rate = ((this.state.fps || 30) / nativeFps) * speedMult;
        // Seek every view to the current frame and WAIT for the seek to settle
        // before calling play(): play() while a seek is in flight is rejected by
        // the browser (swallowed by playNative's `.catch`), which left playback
        // stuck after scrubbing (issue #115 followup — mediabunny stepping no
        // longer moves `_videoEl.currentTime`, so this pre-play seek is real).
        var startFrame = this.state.currentFrame;
        Promise.all(views.map(function (v) {
            var d = v.decoder;
            if (d._videoEl) d._videoEl.playbackRate = rate;
            if (typeof d.seekNativeSettled === 'function') return d.seekNativeSettled(startFrame);
            if (d.seekNative) d.seekNative(startFrame);
            return Promise.resolve();
        })).then(function () {
            if (!self.state.isPlaying) return;   // user paused during the seek wait
            for (var i = 0; i < views.length; i++) {
                if (views[i].decoder.playNative) views[i].decoder.playNative();
            }
            startLoop();
        });

        // Draw one playback frame: paint the video and the pose overlay for the
        // SAME index — `frameIdx`, which is the presented-frame index from rVFC
        // `mediaTime` (so it tracks the frame actually on screen, not the clock).
        // Returns false if playback should stop (past the end / paused).
        function drawPlaybackFrame(frameIdx) {
            if (!self.state.isPlaying) return false;
            if (frameIdx >= self.state.totalFrames) { self.stopPlayback(); return false; }
            self.state.currentFrame = frameIdx;

            var currentViews = self.state.views.filter(function (v) { return v.decoder; });
            for (var j = 0; j < currentViews.length; j++) {
                var view = currentViews[j];
                if (view.decoder.drawCurrentFrame) {
                    view.decoder.drawCurrentFrame(view.ctx, view.canvas.width, view.canvas.height);
                }
                if (view.overlayCtx && view.overlayCanvas) {
                    view.overlayCtx.clearRect(0, 0, view.overlayCanvas.width, view.overlayCanvas.height);
                }
            }
            if (self.callbacks.drawOverlays) self.callbacks.drawOverlays(frameIdx);
            if (self.callbacks.updateSeekbar) self.callbacks.updateSeekbar(frameIdx);
            return true;
        }

        // Per-refresh playback (the default — see `_playbackLoopMode`). Each
        // display refresh, capture every view's current video frame as a
        // VideoFrame (`decoder.captureCurrentFrame`), and paint EXACTLY the
        // frame chosen for that view, overlaying it at that frame's own index:
        // video and overlay cannot disagree in any view, and the redraw rate is
        // the display's — not whatever rate Chrome happens to present the
        // (off-page) primary <video> at, which for high-fps video was measured
        // to vary at random between ~60 and ~120 Hz per playback start on a
        // 120 Hz display (tests/e2e/_bench-playback.mjs, 150 fps project).
        //
        // WHICH frame each view shows is set by a PlaybackSchedule — a frame
        // clock locked to the refresh timestamps — so frames are held for a
        // regular number of refreshes instead of whatever the sampling phase
        // gives. A capture that arrives a refresh early is held (`pending`) and
        // shown in its slot; all views aim at the same scheduled frame. A
        // refresh where no view's frame changes draws nothing.
        var schedule = new PlaybackSchedule();
        var shown = null;     // per view: index currently painted on its canvas
        var pending = null;   // per view: {frame, index} captured early, held for its slot
        function closeCap(c) {
            if (c && c.frame) { try { c.frame.close(); } catch (e) { /* ignore */ } }
        }
        // Fallback for views whose VideoFrame timestamps are unusable (Safari,
        // Firefox — see judgeVideoFrameTimestamps): draw the <video> directly
        // and take the frame index from its requestVideoFrameCallback
        // (Safari, one callback per shown picture: painted IN the callback at
        // its `mediaTime`; Firefox, ~24 coalesced callbacks/s: painted on the
        // refresh, indexed by a CoalescedFrameClock evaluated at the instant
        // of the draw), else from its clock when there is no rVFC.
        // rVFC is registered ONLY for those views: registering it on every
        // view changed Chrome's presentation behaviour.
        //
        // Until a view's first callback its index is UNKNOWN (null) and its
        // canvas keeps the paused frame it showed — `startFrame`. The clock is
        // not a stand-in: after the pre-play seek Safari's `drawImage` keeps
        // painting the PRE-seek picture until it presents a new one, which
        // overlaid frame 279 on a picture of frame 66 (verify/pause-xb.html).
        var coalesced = rvfcCallbacksCoalesced();
        var fallback = [];   // per view: { el, id, mt, clock|null, skips, firstIdx, trusted, painted }
        self._refreshFallback = fallback;   // diagnostics only (tests/e2e/_verify-playback-loop.html)
        var refreshMs = null;                // display refresh interval (ms), as PlaybackSchedule measures it
        var refreshDeltas = [], lastNow = null;
        function fallbackState(j, view) {
            var dec = view.decoder, el = dec._videoEl;
            var f = fallback[j];
            if (!f && el && typeof el.requestVideoFrameCallback === 'function') {
                f = fallback[j] = { el: el, id: null, mt: null, clock: coalesced ? new CoalescedFrameClock() : null,
                    skips: 0, firstIdx: null, trusted: false, painted: null };
                var onVF = function (cbNow, md) {
                    if (fallback[j] !== f || !self.state.isPlaying) return;
                    f.mt = md && typeof md.mediaTime === 'number' ? md.mediaTime : el.currentTime;
                    var fps = dec._fps || self.state.fps || 30;
                    var vi = Math.round(f.mt * fps);
                    if (f.clock) {
                        f.clock.observe(cbNow, vi, md && md.expectedDisplayTime,
                            fps * (el.playbackRate || 1) / 1000, refreshMs);
                    } else {
                        // One callback per shown picture (Safari): paint it
                        // HERE, where `drawImage` and `mediaTime` are the same
                        // frame (measured 100%); by the refresh a 150 fps
                        // video could already be 1–2 frames on. But not until
                        // the reported frame first CHANGES: the first callback
                        // after the pre-play seek carries stale metadata —
                        // the pre-seek frame (541 over a picture of 210), or
                        // the seek target over the frame before it.
                        if (f.firstIdx == null) f.firstIdx = vi;
                        else if (vi !== f.firstIdx) f.trusted = true;
                        if (f.trusted && vi !== f.painted && view.ctx && view.canvas && dec.drawCurrentFrame
                            && dec.drawCurrentFrame(view.ctx, view.canvas.width, view.canvas.height) !== false) {
                            f.painted = vi;
                        }
                    }
                    f.id = el.requestVideoFrameCallback(onVF);
                };
                f.id = el.requestVideoFrameCallback(onVF);
            }
            return f;
        }
        // The frame a fallback view's `drawImage(<video>)` paints at time `t`
        // (performance.now(); {index, certain}), or null while unknown (above).
        function fallbackFrame(j, view, t) {
            var dec = view.decoder;
            var f = fallbackState(j, view);
            if (!f) {
                var ci = dec.getCurrentFrameIndex ? dec.getCurrentFrameIndex() : null;
                return ci == null ? null : { index: ci, certain: true };
            }
            if (f.clock) return f.mt == null ? null : f.clock.frameAt(t, 1);   // Firefox rounds now() to 1 ms
            return f.painted == null ? null : { index: f.painted, certain: true, painted: true };
        }
        // Held VideoFrames and fallback rVFCs must not outlive playback
        // (stopPlayback calls this).
        self._refreshCleanup = function () {
            if (pending) for (var p = 0; p < pending.length; p++) closeCap(pending[p]);
            pending = null;
            shown = null;
            for (var r = 0; r < fallback.length; r++) {
                var fb = fallback[r];
                if (fb && fb.id != null && fb.el.cancelVideoFrameCallback) {
                    try { fb.el.cancelVideoFrameCallback(fb.id); } catch (e) { /* ignore */ }
                }
            }
            fallback = [];
            self._refreshFallback = fallback;
        };
        function drawRefreshFrame(now) {
            if (!self.state.isPlaying) return false;
            var cur = self.state.views.filter(function (v) { return v.decoder; });
            if (!cur.length) return false;
            var n = cur.length;
            if (!shown || shown.length !== n) {
                if (pending) for (var q = 0; q < pending.length; q++) closeCap(pending[q]);
                shown = new Array(n).fill(null);
                pending = new Array(n).fill(null);
                schedule.reset();
            }
            if (lastNow != null) {
                // min of the first few (a missed vsync only makes one longer), then tracked
                var dt = now - lastNow;
                if (dt > 3 && dt < 50) {
                    if (refreshMs == null) {
                        refreshDeltas.push(dt);
                        if (refreshDeltas.length >= 4) refreshMs = Math.min.apply(null, refreshDeltas);
                    } else if (Math.abs(dt - refreshMs) < 0.25 * refreshMs) {
                        refreshMs = 0.95 * refreshMs + 0.05 * dt;
                    }
                }
            }
            lastNow = now;
            var caps = new Array(n), idx = new Array(n);
            var live = new Array(n).fill(false);   // painted from the <video> itself (fallback)
            var keep = new Array(n).fill(false);   // capture retained as pending
            try {
                for (var j = 0; j < n; j++) {
                    var dec = cur[j].decoder;
                    if (dec._vfTimestamps === undefined && videoFrameCaptureUnsafe()) {
                        dec._vfTimestamps = 'bad';
                        videoLog('Playback: WebKit — never capturing VideoFrames from a <video> (their timestamps are the clock); '
                            + 'drawing the <video> directly, frame index from requestVideoFrameCallback');
                    }
                    var tsMode = dec._vfTimestamps;
                    caps[j] = (tsMode !== 'bad' && dec.captureCurrentFrame) ? dec.captureCurrentFrame() : null;
                    if (caps[j] && tsMode === undefined) tsMode = judgeVideoFrameTimestamps(dec, caps[j]);
                    if (caps[j] && tsMode === 'ok') {
                        idx[j] = caps[j].index;
                    } else if (caps[j] && tsMode === undefined) {
                        // Still judging the timestamps: nothing about this
                        // view's picture is known yet — keep the paused frame.
                        closeCap(caps[j]); caps[j] = null;
                        idx[j] = null;
                    } else {
                        // Unusable timestamps, or no capture: paint the
                        // <video> itself, index from rVFC / clock.
                        closeCap(caps[j]); caps[j] = null;
                        live[j] = true;
                        var ff = fallbackFrame(j, cur[j], performance.now());
                        idx[j] = ff ? ff.index : null;
                    }
                }
                var dec0 = cur[0].decoder, primaryEl = dec0._videoEl;
                if ((idx[0] != null && idx[0] >= self.state.totalFrames) || (primaryEl && primaryEl.ended)) {
                    self.stopPlayback();
                    return false;
                }
                var rate = (dec0._fps || self.state.fps || 30) *
                    ((primaryEl && primaryEl.playbackRate) || 1) / 1000;
                // The schedule follows the primary's CAPTURES; with none, every
                // captured view simply shows its newest frame.
                var target = (idx[0] != null && !live[0]) ? schedule.update(now, idx[0], rate) : Infinity;

                var changed = false;
                for (var k = 0; k < n; k++) {
                    var view = cur[k];
                    if (live[k]) {
                        // Painted live: the frame is whatever the <video> shows
                        // at the instant of the draw, so take the index THEN
                        // (8 views take milliseconds to draw). Firefox: when a
                        // frame boundary may fall right at that instant, a
                        // frame spans ~2+ refreshes (60 fps on 120 Hz) and the
                        // next refresh would be certain, keep the frame already
                        // on the canvas (before the first draw, the paused one)
                        // instead — the new one lands certain a refresh later,
                        // normally with every frame still shown for the same
                        // number of refreshes. With ~1 frame per refresh a skip
                        // would be a hold then a jump, so there it draws the
                        // midpoint guess. An estimate never steps backwards
                        // (Firefox's picture doesn't).
                        var tDraw = performance.now();
                        var fbk = idx[k] == null ? null : fallbackFrame(k, view, tDraw);
                        if (!fbk) continue;
                        var fs = fallback[k];
                        var est = !!(fs && fs.clock);
                        if (est && !fbk.certain && fbk.step != null && fbk.step <= 0.55 && fs.skips < 2) {
                            var nxt = fs.clock.frameAt(tDraw + (refreshMs || 1000 / 60), 1);
                            if (nxt && nxt.certain) { fs.skips++; continue; }
                        }
                        if (fs) fs.skips = 0;
                        if (shown[k] != null && (est ? fbk.index <= shown[k] : fbk.index === shown[k])) continue;
                        if (fbk.painted) { shown[k] = fbk.index; changed = true; continue; }   // drawn in its rVFC
                        if (view.ctx && view.canvas && view.decoder.drawCurrentFrame
                            && view.decoder.drawCurrentFrame(view.ctx, view.canvas.width, view.canvas.height) !== false) {
                            shown[k] = fbk.index;
                            changed = true;
                        }
                        continue;
                    }
                    var pend = pending[k];
                    // No SECONDARY view may run ahead of the primary: the
                    // schedule is a free-running clock, so on a >60 Hz display
                    // `target` can reach a frame only some views have captured
                    // yet, and those would paint it while the primary holds —
                    // cameras one frame apart, with the overlay drawn at the
                    // primary's index.
                    var tk = (k === 0 || shown[0] == null || live[0]) ? target : Math.min(target, shown[0]);
                    var pick = pickScheduledFrame(tk, shown[k], pend ? pend.index : null, idx[k]);
                    if (pick === 'cap' && idx[k] !== shown[k]) {
                        if (view.ctx && view.canvas) view.ctx.drawImage(caps[k].frame, 0, 0, view.canvas.width, view.canvas.height);
                        shown[k] = idx[k];
                        changed = true;
                    } else if (pick === 'pending' && pend.index !== shown[k]) {
                        if (view.ctx && view.canvas) view.ctx.drawImage(pend.frame, 0, 0, view.canvas.width, view.canvas.height);
                        shown[k] = pend.index;
                        changed = true;
                    }
                    // Hold at most ONE future frame (the earliest still ahead of
                    // the screen); everything else is released.
                    var cand = caps[k] && idx[k] > shown[k] ? caps[k] : null;
                    var curPend = pending[k] && pending[k].index > shown[k] ? pending[k] : null;
                    if (pending[k] && pending[k] !== curPend) { closeCap(pending[k]); pending[k] = null; }
                    if (cand && (!curPend || cand.index < curPend.index)) {
                        if (curPend) closeCap(curPend);
                        pending[k] = cand;
                        keep[k] = true;
                    }
                }
                if (!changed) return true;   // nothing new on screen: keep the last image

                // A view not yet drawn still shows the paused frame.
                var mainIdx = shown[0] != null ? shown[0] : startFrame;
                self.state.currentFrame = mainIdx;
                var viewFrames = {};
                for (var m = 0; m < n; m++) {
                    var v = cur[m];
                    if (v.overlayCtx && v.overlayCanvas) {
                        v.overlayCtx.clearRect(0, 0, v.overlayCanvas.width, v.overlayCanvas.height);
                    }
                    viewFrames[v.name] = shown[m] != null ? shown[m] : startFrame;
                }
                if (self.callbacks.drawOverlays) self.callbacks.drawOverlays(mainIdx, viewFrames);
                if (self.callbacks.updateSeekbar) self.callbacks.updateSeekbar(mainIdx);
                return true;
            } finally {
                // VideoFrames hold decoder/GPU buffers: release every capture
                // that wasn't kept as a pending frame.
                for (var c = 0; c < caps.length; c++) if (!keep[c]) closeCap(caps[c]);
            }
        }

        function startLoop() {
            var live = self.state.views.filter(function (v) { return v.decoder; });
            var primaryDec = live.length ? live[0].decoder : null;
            var primaryEl = primaryDec && primaryDec._videoEl;
            var fps = (primaryDec && primaryDec._fps) || self.state.fps || 30;

            if (self._playbackLoopMode() === 'refresh' && typeof requestAnimationFrame === 'function') {
                videoLog('Playback loop: per-refresh, scheduled per-view VideoFrame capture');
                var onRefresh = function (now) {
                    if (!self.state.isPlaying) return;
                    var keepGoing = true;
                    try { keepGoing = drawRefreshFrame(now); }
                    catch (e) { console.error('[playback] refresh draw failed:', e); }
                    if (keepGoing !== false && self.state.isPlaying) self._playRAF = requestAnimationFrame(onRefresh);
                };
                self._playRAF = requestAnimationFrame(onRefresh);
                return;
            }

            // Opt-in (`window.LUCID_PLAYBACK_LOOP='rvfc'`): the previous loop.
            // Prefer requestVideoFrameCallback: its `metadata.mediaTime` is the
            // timestamp of the frame ACTUALLY PRESENTED on screen. Deriving the
            // overlay frame from that (instead of the <video>.currentTime clock,
            // which leads the painted frame by the decode/compositor latency)
            // keeps the pose overlay locked to the displayed video frame — fixes
            // "the tracking leads the video during playback" (issue #115 followup).
            if (primaryEl && typeof primaryEl.requestVideoFrameCallback === 'function') {
                videoLog('Playback loop: requestVideoFrameCallback (presented-frame accurate)');
                var onVF = function (now, metadata) {
                    if (!self.state.isPlaying) return;
                    var t = (metadata && typeof metadata.mediaTime === 'number')
                        ? metadata.mediaTime : primaryEl.currentTime;
                    if (typeof window !== 'undefined' && window.LUCID_PLAYBACK_DEBUG) {
                        videoLog('rVFC mediaTime=' + t.toFixed(4) + ' currentTime=' + primaryEl.currentTime.toFixed(4)
                            + ' → frame ' + Math.round(t * fps));
                    }
                    if (drawPlaybackFrame(Math.round(t * fps))) {
                        self._playRVFCEl = primaryEl;
                        self._playRVFC = primaryEl.requestVideoFrameCallback(onVF);
                    }
                };
                self._playRVFCEl = primaryEl;
                self._playRVFC = primaryEl.requestVideoFrameCallback(onVF);
            } else {
                // Fallback (no rVFC): rAF loop; getCurrentFrameIndex uses floor.
                videoLog('Playback loop: requestAnimationFrame fallback (no requestVideoFrameCallback)');
                var onFrame = function () {
                    if (!self.state.isPlaying) return;
                    var d0 = (self.state.views.filter(function (v) { return v.decoder; })[0] || {}).decoder;
                    var frameIdx = (d0 && d0.getCurrentFrameIndex) ? d0.getCurrentFrameIndex() : self.state.currentFrame;
                    if (drawPlaybackFrame(frameIdx)) self._playRAF = requestAnimationFrame(onFrame);
                };
                self._playRAF = requestAnimationFrame(onFrame);
            }
        }

        if (this.callbacks.onPlaybackStateChange) {
            this.callbacks.onPlaybackStateChange(true);
        }

        videoLog("Playback started (native)");
    }

    /**
     * Stop playback.
     */
    stopPlayback() {
        var wasPlaying = this.state.isPlaying;
        // Cancel animation frame
        if (this._playRAF) {
            cancelAnimationFrame(this._playRAF);
            this._playRAF = null;
        }
        // Cancel the requestVideoFrameCallback playback loop, if used.
        if (this._playRVFC != null) {
            try {
                if (this._playRVFCEl && typeof this._playRVFCEl.cancelVideoFrameCallback === 'function') {
                    this._playRVFCEl.cancelVideoFrameCallback(this._playRVFC);
                }
            } catch (e) { /* non-fatal */ }
            this._playRVFC = null;
            this._playRVFCEl = null;
        }
        // Release VideoFrames the per-refresh loop was holding for later slots.
        if (this._refreshCleanup) {
            try { this._refreshCleanup(); } catch (e) { /* non-fatal */ }
            this._refreshCleanup = null;
        }
        // Clear legacy interval if any
        if (this.state.playInterval) {
            clearInterval(this.state.playInterval);
            this.state.playInterval = null;
        }

        // Restore the mediabunny backend cache sizes bumped for buffered
        // playback (so idle/seek memory returns to the smaller working set).
        if (this._bufViews) {
            for (var b = 0; b < this._bufViews.length; b++) {
                var bv = this._bufViews[b];
                if (bv.decoder && bv.decoder._mbBackend && typeof bv._mbSavedCacheSize === 'number') {
                    bv.decoder._mbBackend.cacheSize = bv._mbSavedCacheSize;
                }
                bv._mbBusy = false;
            }
            this._bufViews = null;
        }

        // Pause all native video elements
        var views = this.state.views.filter(function (v) { return v.decoder; });
        for (var i = 0; i < views.length; i++) {
            if (views[i].decoder.pauseNative) {
                views[i].decoder.pauseNative();
            }
        }

        this.state.isPlaying = false;

        // Settle the info panel, timeline and status bar to the exact final
        // frame: during playback those auxiliary updates are throttled (~10 Hz)
        // or reduced (timeline playhead-only, status-bar counters skipped), so
        // on stop they can be stale. With isPlaying now false these run the
        // full, unthrottled updates. (The 3D viewport already follows every
        // frame.)
        if (wasPlaying) {
            try { if (this.callbacks.drawOverlays) this.callbacks.drawOverlays(this.state.currentFrame); } catch (e) { /* non-fatal */ }
            try { if (this.callbacks.updateSeekbar) this.callbacks.updateSeekbar(this.state.currentFrame); } catch (e) { /* non-fatal */ }
        }

        if (this.callbacks.onPlaybackStateChange) {
            this.callbacks.onPlaybackStateChange(false);
        }

        videoLog("Playback stopped");
    }

    /**
     * User-initiated pause. Stops playback, then re-decodes the frame it stopped
     * on (`state.currentFrame`) through `getFrame`'s frame-accurate path
     * (mediabunny, or the mid-frame `<video>` seek where WebCodecs cannot
     * decode), so every camera rests on exactly that frame with its overlay.
     *
     * In Chrome/Brave this repaints the picture already on screen: the
     * per-refresh loop paints each view's captured VideoFrame and overlays it
     * at that frame's own index. It is needed where playback is less exact —
     * the Safari/Firefox fallback loop (timestamps judged 'bad') can still
     * overlay a frame off the drawn picture (Firefox's index is an estimate:
     * CoalescedFrameClock), and on any browser a secondary camera can stop a
     * frame out of step with camera 0, whose index `stopPlayback` redraws
     * every overlay at.
     *
     * It used to step ONE FRAME FORWARD (current + 1), copying the manual
     * "press next frame after pausing" fix from the old loop, whose overlay
     * index came from `<video>.currentTime` and led the picture. With the
     * per-refresh loop that step was itself the jump on every pause: measured
     * with barcode clips in Chrome, Brave, Safari and Firefox at 60 and 120 Hz,
     * +1 moved the skeleton on 95–100% of pauses, while +0 ended aligned in
     * 100% of camera-pauses. Chrome/Brave's skeletons stayed still in 90–100%
     * at 120 Hz and on 60 fps video; for 150 fps video on a 60 Hz display it
     * was 68–95%, because there the cameras drift out of step during playback
     * and the re-decode brings each to camera 0's frame. (Firefox HEVC was the
     * one exception to alignment, at ~50%, until its stepping moved to
     * mid-frame `<video>` seeks — see `_getFrameHTML5`'s `_html5Moved` —
     * which brought +0 there to 100%.)
     *
     * Internal stops (scrub, teardown, end-of-video) call `stopPlayback()`
     * directly and skip this re-decode; only the explicit pause controls use it.
     */
    pausePlayback() {
        var wasPlaying = this.state.isPlaying;
        this.stopPlayback();
        if (!wasPlaying) return;
        // seekToFrame decodes via getFrame's frame-accurate path and redraws
        // the video + overlay for the SAME index → guaranteed aligned.
        this.seekToFrame(this.state.currentFrame);
    }

    /**
     * Setup seekbar for mouse-based scrubbing.
     * @param {HTMLElement} seekbar - The seekbar container element
     * @param {Function} updateVisual - (frameIndex) => void, updates seekbar visual position
     */
    setupSeekbar(seekbar, updateVisual) {
        var isDragging = false;
        var self = this;

        var getFrameFromEvent = function (e) {
            var rect = seekbar.getBoundingClientRect();
            var fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            return Math.round(fraction * (self.state.totalFrames - 1));
        };

        seekbar.addEventListener("mousedown", function (e) {
            isDragging = true;
            var frame = getFrameFromEvent(e);
            if (updateVisual) updateVisual(frame);
            self.scrubToFrame(frame);
            e.preventDefault();
        });

        document.addEventListener("mousemove", function (e) {
            if (!isDragging) return;
            var frame = getFrameFromEvent(e);
            if (updateVisual) updateVisual(frame);
            self.scrubToFrame(frame);
            e.preventDefault();
        });

        document.addEventListener("mouseup", function () {
            if (!isDragging) return;
            isDragging = false;
        });
    }

    /**
     * Setup keyboard handlers for video navigation, playback, and zoom.
     */
    setupKeyboardHandlers() {
        var self = this;
        document.addEventListener("keydown", function (e) {
            if (shouldIgnoreShortcut(e)) return;

            switch (e.key) {
                case "ArrowRight":
                    e.preventDefault();
                    if (e.shiftKey) {
                        self.seekToFrame(self.state.currentFrame + 10);
                    } else {
                        self.seekToFrame(self.state.currentFrame + 1);
                    }
                    break;

                case "ArrowLeft":
                    e.preventDefault();
                    if (e.shiftKey) {
                        self.seekToFrame(self.state.currentFrame - 10);
                    } else {
                        self.seekToFrame(self.state.currentFrame - 1);
                    }
                    break;

                case " ":
                    e.preventDefault();
                    self.togglePlayback();
                    break;

                case "Home":
                    e.preventDefault();
                    self.seekToFrame(0);
                    break;

                case "End":
                    e.preventDefault();
                    self.seekToFrame(self.state.totalFrames - 1);
                    break;

                case "+":
                case "=":
                    e.preventDefault();
                    self.zoomAllVideos(1.2);
                    break;

                case "-":
                case "_":
                    e.preventDefault();
                    self.zoomAllVideos(1 / 1.2);
                    break;

                case "0":
                    e.preventDefault();
                    self.resetAllZoom();
                    break;
            }
        });

        videoLog("Keyboard handlers installed");
    }

    // -----------------------------------------------------------------------
    // Zoom and pan
    // -----------------------------------------------------------------------

    initZoom(view) {
        view.zoom = {
            scale: 1.0,
            offsetX: 0,
            offsetY: 0,
            baseW: 0,   // wrapper base display size the offsets are valid for;
            baseH: 0,   // set by applyZoom, used by reapplyZoom to anchor on resize
        };
    }

    applyZoom(view) {
        if (!view.zoom) return;

        var z = view.zoom;
        var rot = view.rotation || 0;
        var transform;
        if (rot === 0) {
            transform = "translate(" + z.offsetX + "px, " + z.offsetY + "px) scale(" + z.scale + ")";
        } else {
            // Rotate around wrapper center using cached CSS dimensions (avoids reflow)
            var cX = view.canvas ? parseFloat(view.canvas.style.width) / 2 || 0 : 0;
            var cY = view.canvas ? parseFloat(view.canvas.style.height) / 2 || 0 : 0;
            transform = "translate(" + z.offsetX + "px, " + z.offsetY + "px) translate(" + cX + "px, " + cY + "px) rotate(" + rot + "deg) translate(" + (-cX) + "px, " + (-cY) + "px) scale(" + z.scale + ")";
        }

        var wrapper = view.wrapper || (view.canvas ? view.canvas.parentElement : null);
        if (wrapper && wrapper.classList.contains('canvas-wrapper')) {
            wrapper.style.transform = transform;
            wrapper.style.transformOrigin = "0 0";
        } else {
            if (view.canvas) {
                view.canvas.style.transform = transform;
                view.canvas.style.transformOrigin = "0 0";
            }
            if (view.overlayCanvas) {
                view.overlayCanvas.style.transform = transform;
                view.overlayCanvas.style.transformOrigin = "0 0";
            }
        }

        var cell = view.canvas ? view.canvas.closest('.video-cell') : null;
        if (cell) {
            var isZoomed = Math.abs(z.scale - 1.0) > 0.01;
            cell.classList.toggle('zoomed', isZoomed);
            var unzoomBtn = cell.querySelector('.unzoom-btn');
            if (unzoomBtn) unzoomBtn.style.display = isZoomed ? '' : 'none';
        }

        // Record the base display size the current offsets are valid for, so the
        // next reapplyZoom (after a cell resize) can rescale the pan offset to keep
        // the same region centered. Transform changes don't dirty layout, so this
        // offsetWidth read stays cheap except right after an actual resize.
        if (wrapper) {
            var bw = wrapper.offsetWidth;
            var bh = wrapper.offsetHeight;
            if (bw > 0 && bh > 0) { z.baseW = bw; z.baseH = bh; }
        }
    }

    /**
     * Compute the axis-aligned bounding box of the wrapper after the
     * `translate(cX,cY) rotate(rot) translate(-cX,-cY) scale(s)` CSS
     * transform used by `applyZoom` (without the outer pan translation).
     *
     * Returns {width, height, left, top} where `left`/`top` are offsets
     * from the wrapper's pre-transform top-left corner — i.e., add
     * `flexOff{X,Y} + offsetX/Y` to get the on-screen bbox edges.
     *
     * For 90° / 270° rotations the effective width and height are
     * swapped (and the bbox shifts when scale != 1), which is why
     * clamping offsetX/Y against `wW * scale` / `wH * scale` used to
     * cut off the rotated edges at high zoom.
     *
     * @param {number} wW - wrapper CSS width (px)
     * @param {number} wH - wrapper CSS height (px)
     * @param {number} scale - zoom scale
     * @param {number} rot - rotation in degrees
     * @returns {{width:number, height:number, left:number, top:number}}
     */
    _rotatedBBox(wW, wH, scale, rot) {
        var r = ((rot || 0) % 360 + 360) % 360;
        var s = scale;
        var cX = wW / 2, cY = wH / 2;

        // Fast paths for the four cardinal rotations (the only ones the
        // UI exposes today). Formulas derived from applying the CSS
        // transform to the wrapper's four corners and taking min/max.
        if (r === 0) {
            return { width: wW * s, height: wH * s, left: 0, top: 0 };
        }
        if (r === 90) {
            return {
                width: wH * s, height: wW * s,
                left: cX + cY - wH * s,
                top: cY - cX,
            };
        }
        if (r === 180) {
            return {
                width: wW * s, height: wH * s,
                left: 2 * cX - wW * s,
                top: 2 * cY - wH * s,
            };
        }
        if (r === 270) {
            return {
                width: wH * s, height: wW * s,
                left: cX - cY,
                top: cX + cY - wW * s,
            };
        }
        // Arbitrary angle — general bbox via the 4 corners.
        var a = r * Math.PI / 180;
        var ca = Math.cos(a), sa = Math.sin(a);
        var corners = [[-cX, -cY], [wW * s - cX, -cY],
                       [wW * s - cX, wH * s - cY], [-cX, wH * s - cY]];
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (var i = 0; i < 4; i++) {
            var rx = ca * corners[i][0] - sa * corners[i][1];
            var ry = sa * corners[i][0] + ca * corners[i][1];
            if (rx < minX) minX = rx;
            if (rx > maxX) maxX = rx;
            if (ry < minY) minY = ry;
            if (ry > maxY) maxY = ry;
        }
        return {
            width: maxX - minX,
            height: maxY - minY,
            left: cX + minX,
            top: cY + minY,
        };
    }

    /**
     * Compute the minimum zoom scale for a view. Allows zooming out
     * until BOTH dimensions of the rotated bounding box are smaller than
     * the cell — for 90°/270° rotations the effective dimensions are
     * swapped, so a pre-rotation portrait that fits the cell vertically
     * may still overflow horizontally post-rotation (or vice versa).
     */
    _getMinScale(view) {
        var wrapper = view.wrapper || (view.canvas ? view.canvas.parentElement : null);
        var container = view.canvas ? view.canvas.closest('.video-cell') : null;
        if (!wrapper || !container) return 1.0;
        var wW = wrapper.offsetWidth;
        var wH = wrapper.offsetHeight;
        var cW = container.clientWidth;
        var cH = container.clientHeight;
        if (wW <= 0 || wH <= 0) return 1.0;
        // Effective dims at scale=1 under the current rotation. Use the
        // rotated bbox so 90°/270° and off-axis rotations all work.
        var bboxAtOne = this._rotatedBBox(wW, wH, 1.0, view.rotation || 0);
        var scaleW = cW / bboxAtOne.width;
        var scaleH = cH / bboxAtOne.height;
        return Math.max(0.25, Math.min(scaleW, scaleH));
    }

    /**
     * Constrain offsets so the video content stays reasonably positioned.
     * When scaled content covers a dimension: allow panning within it.
     * When it doesn't cover: center in that dimension.
     *
     * Uses the rotated bounding box so 90°/270° rotations can be panned
     * far enough to reveal the rotated edges — the previous version
     * clamped against `wW*scale` / `wH*scale`, which is wrong whenever
     * rotation swaps the effective width and height.
     */
    _constrainOffsets(z, view) {
        var wrapper = view.wrapper || (view.canvas ? view.canvas.parentElement : null);
        var container = view.canvas ? view.canvas.closest('.video-cell') : null;
        if (!wrapper || !container) return;
        var wW = wrapper.offsetWidth;
        var wH = wrapper.offsetHeight;
        var cW = container.clientWidth;
        var cH = container.clientHeight;
        if (wW <= 0 || wH <= 0) return;
        // The wrapper is flex-centered. Its CSS top-left is at:
        var flexOffX = (cW - wW) / 2;
        var flexOffY = (cH - wH) / 2;
        // On-screen bbox (excluding the outer offset translation):
        //   bbox_left = flexOffX + bbox.left + z.offsetX
        //   bbox_top  = flexOffY + bbox.top  + z.offsetY
        var bbox = this._rotatedBBox(wW, wH, z.scale, view.rotation || 0);
        var bboxLeft0 = flexOffX + bbox.left;
        var bboxTop0 = flexOffY + bbox.top;

        if (bbox.width >= cW) {
            // Allow panning so bbox edges can reach container edges.
            var maxOx = -bboxLeft0;
            var minOx = cW - bboxLeft0 - bbox.width;
            z.offsetX = Math.max(minOx, Math.min(maxOx, z.offsetX));
        } else {
            // Bbox fits — center it within the container.
            z.offsetX = (cW - bbox.width) / 2 - bboxLeft0;
        }
        if (bbox.height >= cH) {
            var maxOy = -bboxTop0;
            var minOy = cH - bboxTop0 - bbox.height;
            z.offsetY = Math.max(minOy, Math.min(maxOy, z.offsetY));
        } else {
            z.offsetY = (cH - bbox.height) / 2 - bboxTop0;
        }
    }

    zoomVideo(view, factor, cssX, cssY) {
        if (!view.zoom) this.initZoom(view);

        var z = view.zoom;
        var oldScale = z.scale;
        var minScale = this._getMinScale(view);
        var newScale = Math.max(minScale, Math.min(10, oldScale * factor));

        if (cssX !== undefined && cssY !== undefined) {
            var contentX = (cssX - z.offsetX) / oldScale;
            var contentY = (cssY - z.offsetY) / oldScale;
            z.offsetX = cssX - contentX * newScale;
            z.offsetY = cssY - contentY * newScale;
        }

        z.scale = newScale;
        this._constrainOffsets(z, view);
        this.applyZoom(view);
        if (this.callbacks.onZoomChange) this.callbacks.onZoomChange();
    }

    resetZoom(view) {
        if (!view.zoom) this.initZoom(view);
        view.zoom.scale = 1.0;
        view.zoom.offsetX = 0;
        view.zoom.offsetY = 0;
        this.applyZoom(view);
        if (this.callbacks.onZoomChange) this.callbacks.onZoomChange();
    }

    reapplyZoom(view) {
        if (!view.zoom) return;
        var z = view.zoom;
        // If the wrapper's base display size changed (the cell was resized),
        // rescale the pan offset proportionally so the same image region stays
        // centered. Preserving the centered content point across a base-size
        // change of wW -> wW' (scale fixed) works out to offset *= wW'/wW, so a
        // zoomed image no longer jumps when the camera view is resized.
        var wrapper = view.wrapper || (view.canvas ? view.canvas.parentElement : null);
        if (wrapper && z.baseW > 0 && z.baseH > 0) {
            var newW = wrapper.offsetWidth;
            var newH = wrapper.offsetHeight;
            if (newW > 0 && newH > 0 && (newW !== z.baseW || newH !== z.baseH)) {
                z.offsetX *= newW / z.baseW;
                z.offsetY *= newH / z.baseH;
            }
        }
        this._constrainOffsets(z, view);
        this.applyZoom(view);
    }

    zoomToRect(view, x1, y1, x2, y2, container) {
        if (!view.zoom) this.initZoom(view);

        var z = view.zoom;
        var rectW = Math.abs(x2 - x1);
        var rectH = Math.abs(y2 - y1);
        if (rectW < 5 || rectH < 5) return;

        var containerW = container.clientWidth;
        var containerH = container.clientHeight;

        var contentX1 = (Math.min(x1, x2) - z.offsetX) / z.scale;
        var contentY1 = (Math.min(y1, y2) - z.offsetY) / z.scale;
        var contentX2 = (Math.max(x1, x2) - z.offsetX) / z.scale;
        var contentY2 = (Math.max(y1, y2) - z.offsetY) / z.scale;
        var contentW = contentX2 - contentX1;
        var contentH = contentY2 - contentY1;

        var newScale = Math.min(containerW / contentW, containerH / contentH);
        var minScale = this._getMinScale(view);
        var clampedScale = Math.max(minScale, Math.min(10, newScale));

        var contentCenterX = (contentX1 + contentX2) / 2;
        var contentCenterY = (contentY1 + contentY2) / 2;
        z.offsetX = containerW / 2 - contentCenterX * clampedScale;
        z.offsetY = containerH / 2 - contentCenterY * clampedScale;
        z.scale = clampedScale;
        this._constrainOffsets(z, view);

        this.applyZoom(view);
        if (this.callbacks.onZoomChange) this.callbacks.onZoomChange();
    }

    zoomAllVideos(factor) {
        for (var i = 0; i < this.state.views.length; i++) {
            this.zoomVideo(this.state.views[i], factor);
        }
    }

    resetAllZoom() {
        for (var i = 0; i < this.state.views.length; i++) {
            this.resetZoom(this.state.views[i]);
        }
        videoLog("Zoom reset on all views");
    }

    setupZoomHandlers(view, container) {
        if (!view.zoom) this.initZoom(view);
        var self = this;

        // Remove previous document-level handlers to prevent stacking
        if (view._zoomDocMoveHandler) {
            document.removeEventListener("mousemove", view._zoomDocMoveHandler);
        }
        if (view._zoomDocUpHandler) {
            document.removeEventListener("mouseup", view._zoomDocUpHandler);
        }
        if (view._zoomKeyHandler) {
            document.removeEventListener("keydown", view._zoomKeyHandler);
        }
        if (view._zoomContextHandler && view._zoomContainer) {
            view._zoomContainer.removeEventListener("contextmenu", view._zoomContextHandler);
        }

        // ---- Mouse wheel zoom (cursor-centered) ----
        container.addEventListener("wheel", function (e) {
            e.preventDefault();
            // Alt/Option turns the wheel into the instance-rotation control
            // (`ui/interaction.js` `onWheel`, issue #198), so zoom stands down
            // for as long as the key is held. The rotation handler lives on the
            // OVERLAY CANVAS, which does not fill this cell — a video narrower
            // or shorter than its pane leaves letterbox margin where no canvas
            // sits under the cursor. Without this guard, an Option+scroll that
            // strayed into that margin mid-gesture zoomed instead, yanking the
            // view out from under the skeleton being rotated. Releasing Option
            // brings zoom straight back.
            if (e.altKey) return;
            var factor = e.deltaY < 0 ? 1.10 : 1 / 1.10;
            var rect = container.getBoundingClientRect();
            var cssX = e.clientX - rect.left;
            var cssY = e.clientY - rect.top;
            self.zoomVideo(view, factor, cssX, cssY);
        }, { passive: false });

        // ---- Drag state for pan / box zoom ----
        var isPanning = false;
        var isBoxZooming = false;
        var lastX = 0;
        var lastY = 0;
        var boxStartX = 0;
        var boxStartY = 0;
        var boxOverlay = null;
        var dragStartX = 0;
        var dragStartY = 0;
        var leftDragPending = false;

        container.addEventListener("mousedown", function (e) {
            // Skip ALL zoom logic if the interaction manager is handling a drag
            // TODO(Pass 3): replace window.__mvguiDragging with explicit
            // callback/event from InteractionManager once video.js is a module.
            if (window.__mvguiDragging || e._consumedByInteraction) return;

            if (e.button === 1) {
                isPanning = true;
                lastX = e.clientX;
                lastY = e.clientY;
                e.preventDefault();
                return;
            }

            if (e.button === 0) {
                leftDragPending = true;
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                lastX = e.clientX;
                lastY = e.clientY;

                var rect = container.getBoundingClientRect();
                boxStartX = e.clientX - rect.left;
                boxStartY = e.clientY - rect.top;
            }
        });

        var isZoomed = function () {
            if (!view.zoom) return false;
            // Consider zoomed if scale is meaningfully different from 1.0
            // (either zoomed in OR zoomed out from CSS-fit)
            return Math.abs(view.zoom.scale - 1.0) > 0.05;
        };

        view._zoomDocMoveHandler = function (e) {
            // Skip if interaction manager owns the mouse
            if (window.__mvguiDragging) {
                leftDragPending = false;
                return;
            }

            if (isPanning) {
                var dx = e.clientX - lastX;
                var dy = e.clientY - lastY;
                lastX = e.clientX;
                lastY = e.clientY;

                view.zoom.offsetX += dx;
                view.zoom.offsetY += dy;
                self._constrainOffsets(view.zoom, view);
                self.applyZoom(view);
                return;
            }

            if (leftDragPending && !window.__mvguiDragging) {
                var dx2 = e.clientX - dragStartX;
                var dy2 = e.clientY - dragStartY;
                if (Math.abs(dx2) < 3 && Math.abs(dy2) < 3) return;

                leftDragPending = false;

                if (isZoomed()) {
                    isPanning = true;
                    lastX = e.clientX;
                    lastY = e.clientY;
                } else {
                    isBoxZooming = true;
                    boxOverlay = document.createElement("div");
                    boxOverlay.className = "box-zoom-overlay";
                    boxOverlay.style.left = boxStartX + "px";
                    boxOverlay.style.top = boxStartY + "px";
                    boxOverlay.style.width = "0px";
                    boxOverlay.style.height = "0px";
                    container.appendChild(boxOverlay);
                }
            }

            if (isBoxZooming && boxOverlay) {
                var rect = container.getBoundingClientRect();
                var currentX = e.clientX - rect.left;
                var currentY = e.clientY - rect.top;

                var x = Math.min(boxStartX, currentX);
                var y = Math.min(boxStartY, currentY);
                var w = Math.abs(currentX - boxStartX);
                var h = Math.abs(currentY - boxStartY);

                boxOverlay.style.left = x + "px";
                boxOverlay.style.top = y + "px";
                boxOverlay.style.width = w + "px";
                boxOverlay.style.height = h + "px";
            }
        };

        view._zoomDocUpHandler = function (e) {
            leftDragPending = false;

            // Skip zoom actions if interaction manager owns the mouse
            if (window.__mvguiDragging) return;

            if (e.button === 1 && isPanning) {
                isPanning = false;
            }

            if (e.button === 0 && isPanning) {
                isPanning = false;
            }

            if (e.button === 0 && isBoxZooming) {
                isBoxZooming = false;
                var rect = container.getBoundingClientRect();
                var endX = e.clientX - rect.left;
                var endY = e.clientY - rect.top;

                if (boxOverlay && boxOverlay.parentNode) {
                    boxOverlay.parentNode.removeChild(boxOverlay);
                }
                boxOverlay = null;

                self.zoomToRect(view, boxStartX, boxStartY, endX, endY, container);
            }
        };

        // Escape key cancels an in-progress box zoom
        view._zoomKeyHandler = function (e) {
            if (e.key === 'Escape' && isBoxZooming) {
                isBoxZooming = false;
                if (boxOverlay && boxOverlay.parentNode) {
                    boxOverlay.parentNode.removeChild(boxOverlay);
                }
                boxOverlay = null;
            }
        };

        // Right-click cancels an in-progress box zoom
        view._zoomContextHandler = function (e) {
            if (isBoxZooming) {
                e.preventDefault();
                isBoxZooming = false;
                if (boxOverlay && boxOverlay.parentNode) {
                    boxOverlay.parentNode.removeChild(boxOverlay);
                }
                boxOverlay = null;
            }
        };

        document.addEventListener("mousemove", view._zoomDocMoveHandler);
        document.addEventListener("mouseup", view._zoomDocUpHandler);
        document.addEventListener("keydown", view._zoomKeyHandler);
        view._zoomContainer = container;
        container.addEventListener("contextmenu", view._zoomContextHandler);
    }
}
