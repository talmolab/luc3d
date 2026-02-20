/**
 * video.js - Video decoding and multi-view playback for mv-gui
 *
 * OnDemandVideoDecoder: Hybrid decoder that uses HTML5 <video> for instant loading
 * and WebCodecs + mp4box.js for frame-accurate on-demand decoding.
 * VideoController: Synchronized multi-view playback controller with overlay support.
 *
 * Dependencies: mp4box.all.min.js (MP4Box)
 */

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------
function videoLog(msg, level) {
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

// ---------------------------------------------------------------------------
// OnDemandVideoDecoder
// ---------------------------------------------------------------------------
class OnDemandVideoDecoder {
    constructor(options = {}) {
        this.cacheSize = options.cacheSize || 30;
        this.lookahead = options.lookahead || 5;
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

        // Source reference for mp4box lazy init
        this._source = null;
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
        var self = this;
        var metadataPromise = new Promise(function (resolve, reject) {
            if (self._videoEl.readyState >= 3) {
                resolve();
                return;
            }
            self._videoEl.addEventListener("canplay", function () { resolve(); }, { once: true });
            self._videoEl.addEventListener("error", function () {
                var err = self._videoEl.error;
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
        await metadataPromise;

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

        // Background mp4box initialization is disabled - HTML5 video handles
        // playback and seeking. Re-enable for frame-accurate WebCodecs decoding
        // by calling decoder.initWebCodecs() manually.
        // this._mp4InitPromise = this._initMp4box().catch(...);

        videoLog("Video loaded: " + width + "x" + height + " " + totalFrames + " frames @ " + fps.toFixed(1) + "fps (" + (this.fileSize / 1048576).toFixed(1) + " MB)");
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

        // Check if WebCodecs supports this codec
        var support = await VideoDecoder.isConfigSupported(this.config);
        if (!support.supported) {
            videoLog("WebCodecs does not support " + codec + ", using HTML5 fallback", "warn");
            this.mp4boxFile = null;
            return;
        }

        // Get real sample table
        var mp4Samples = this.mp4boxFile.getTrackSamplesInfo(videoTrackInfo.id);
        if (mp4Samples && mp4Samples.length > 0) {
            this.samples = mp4Samples;
            this.keyframeIndices = [];
            for (var i = 0; i < mp4Samples.length; i++) {
                if (mp4Samples[i].is_sync) {
                    this.keyframeIndices.push(i);
                }
            }

            // Update videoTrack with real info
            this.videoTrack = videoTrackInfo;
            this._mp4Initialized = true;
            videoLog("MP4Box ready: " + codec + " " + mp4Samples.length + " samples, " + this.keyframeIndices.length + " keyframes");
        } else {
            videoLog("MP4Box returned no samples, keeping HTML5 mode", "warn");
            this.mp4boxFile = null;
        }
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

    async getFrame(frameIndex) {
        if (frameIndex < 0 || frameIndex >= this.samples.length) {
            videoLog("Frame index out of range: " + frameIndex, "warn");
            return null;
        }

        // Check cache first
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
     * Get a frame using the HTML5 <video> element (always works, slightly less precise).
     */
    async _getFrameHTML5(frameIndex) {
        if (!this._videoEl || !this._videoReady) return null;

        var self = this;
        var time = frameIndex / this._fps;

        // Only seek if we're not already at the target time
        var currentTime = this._videoEl.currentTime;
        if (Math.abs(currentTime - time) > 0.01) {
            // Set up seeked listener BEFORE changing currentTime to avoid race condition
            var seekPromise = new Promise(function (resolve) {
                self._videoEl.addEventListener("seeked", function () { resolve(); }, { once: true });
                setTimeout(resolve, 1000);
            });
            this._videoEl.currentTime = time;
            await seekPromise;
        }

        // Ensure the video has renderable data (readyState >= 2 = HAVE_CURRENT_DATA)
        if (this._videoEl.readyState < 2) {
            await new Promise(function (resolve) {
                self._videoEl.addEventListener("canplay", function () { resolve(); }, { once: true });
                setTimeout(resolve, 1000);
            });
        }

        this._offCtx.drawImage(this._videoEl, 0, 0);
        var bitmap = await createImageBitmap(this._offCanvas);
        this.addToCache(frameIndex, bitmap);
        return bitmap;
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
     * Get the current frame index based on the video element's currentTime.
     */
    getCurrentFrameIndex() {
        if (!this._videoEl) return 0;
        return Math.round(this._videoEl.currentTime * this._fps);
    }

    /**
     * Start native HTML5 video playback (fast, no per-frame seeking).
     */
    playNative() {
        if (this._videoEl) {
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
            this._videoEl.currentTime = frameIndex / this._fps;
        }
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
// VideoController - Synchronized multi-view playback with overlay support
// ---------------------------------------------------------------------------
class VideoController {
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

            if (videoFrame) {
                // Draw video frame to the main canvas
                view.ctx.drawImage(videoFrame, 0, 0, view.canvas.width, view.canvas.height);
            }

            // Clear the overlay canvas for fresh overlay drawing
            if (view.overlayCtx && view.overlayCanvas) {
                view.overlayCtx.clearRect(0, 0, view.overlayCanvas.width, view.overlayCanvas.height);
            }
        }

        // Call overlay drawing callback (e.g., render pose skeletons)
        if (this.callbacks.drawOverlays) {
            this.callbacks.drawOverlays(frameIndex);
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
     * Start playback using native HTML5 video play + requestAnimationFrame.
     * This is much faster than per-frame seeking because the browser handles
     * decoding natively and we just draw the current video frame each animation frame.
     */
    startPlayback() {
        if (this.state.isPlaying) return;

        this.state.isPlaying = true;
        var self = this;

        // Start native playback on all decoders
        var views = this.state.views.filter(function (v) { return v.decoder; });
        for (var i = 0; i < views.length; i++) {
            var d = views[i].decoder;
            if (d.seekNative) {
                d.seekNative(this.state.currentFrame);
                d.playNative();
            }
        }

        // Use requestAnimationFrame to draw frames and update UI in sync
        function onFrame() {
            if (!self.state.isPlaying) return;

            var currentViews = self.state.views.filter(function (v) { return v.decoder; });
            var frameIdx = self.state.currentFrame;

            // Get current frame index from first decoder
            if (currentViews.length > 0 && currentViews[0].decoder.getCurrentFrameIndex) {
                frameIdx = currentViews[0].decoder.getCurrentFrameIndex();
            }

            if (frameIdx >= self.state.totalFrames) {
                self.stopPlayback();
                return;
            }

            self.state.currentFrame = frameIdx;

            // Draw each view directly from its video element (fast - no async)
            for (var j = 0; j < currentViews.length; j++) {
                var view = currentViews[j];
                if (view.decoder.drawCurrentFrame) {
                    view.decoder.drawCurrentFrame(view.ctx, view.canvas.width, view.canvas.height);
                }

                // Clear overlay for redraw
                if (view.overlayCtx && view.overlayCanvas) {
                    view.overlayCtx.clearRect(0, 0, view.overlayCanvas.width, view.overlayCanvas.height);
                }
            }

            // Update overlays and seekbar
            if (self.callbacks.drawOverlays) {
                self.callbacks.drawOverlays(frameIdx);
            }
            if (self.callbacks.updateSeekbar) {
                self.callbacks.updateSeekbar(frameIdx);
            }

            self._playRAF = requestAnimationFrame(onFrame);
        }

        this._playRAF = requestAnimationFrame(onFrame);

        if (this.callbacks.onPlaybackStateChange) {
            this.callbacks.onPlaybackStateChange(true);
        }

        videoLog("Playback started (native)");
    }

    /**
     * Stop playback.
     */
    stopPlayback() {
        // Cancel animation frame
        if (this._playRAF) {
            cancelAnimationFrame(this._playRAF);
            this._playRAF = null;
        }
        // Clear legacy interval if any
        if (this.state.playInterval) {
            clearInterval(this.state.playInterval);
            this.state.playInterval = null;
        }

        // Pause all native video elements
        var views = this.state.views.filter(function (v) { return v.decoder; });
        for (var i = 0; i < views.length; i++) {
            if (views[i].decoder.pauseNative) {
                views[i].decoder.pauseNative();
            }
        }

        this.state.isPlaying = false;

        if (this.callbacks.onPlaybackStateChange) {
            this.callbacks.onPlaybackStateChange(false);
        }

        videoLog("Playback stopped");
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
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) {
                return;
            }

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
        };
    }

    applyZoom(view) {
        if (!view.zoom) return;

        var z = view.zoom;
        var transform = "translate(" + z.offsetX + "px, " + z.offsetY + "px) scale(" + z.scale + ")";

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
            if (z.scale > 1.01 || Math.abs(z.offsetX) > 1 || Math.abs(z.offsetY) > 1) {
                cell.classList.add('zoomed');
            } else {
                cell.classList.remove('zoomed');
            }
        }
    }

    zoomVideo(view, factor, cssX, cssY) {
        if (!view.zoom) this.initZoom(view);

        var z = view.zoom;
        var oldScale = z.scale;
        var newScale = Math.max(0.25, Math.min(10, oldScale * factor));

        if (cssX !== undefined && cssY !== undefined) {
            var contentX = (cssX - z.offsetX) / oldScale;
            var contentY = (cssY - z.offsetY) / oldScale;
            z.offsetX = cssX - contentX * newScale;
            z.offsetY = cssY - contentY * newScale;
        }

        z.scale = newScale;
        this.applyZoom(view);
    }

    resetZoom(view) {
        if (!view.zoom) this.initZoom(view);
        view.zoom.scale = 1.0;
        view.zoom.offsetX = 0;
        view.zoom.offsetY = 0;
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
        var clampedScale = Math.max(0.25, Math.min(10, newScale));

        var contentCenterX = (contentX1 + contentX2) / 2;
        var contentCenterY = (contentY1 + contentY2) / 2;
        z.offsetX = containerW / 2 - contentCenterX * clampedScale;
        z.offsetY = containerH / 2 - contentCenterY * clampedScale;
        z.scale = clampedScale;

        this.applyZoom(view);
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

        // ---- Mouse wheel zoom (cursor-centered) ----
        container.addEventListener("wheel", function (e) {
            e.preventDefault();
            var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            var rect = container.getBoundingClientRect();
            var cssX = e.clientX - rect.left;
            var cssY = e.clientY - rect.top;
            self.zoomVideo(view, factor, cssX, cssY);
        }, { passive: false });

        // ---- Double-click to reset zoom ----
        container.addEventListener("dblclick", function (e) {
            if (view.zoom && (view.zoom.scale > 1.01 || view.zoom.scale < 0.99 ||
                Math.abs(view.zoom.offsetX) > 1 || Math.abs(view.zoom.offsetY) > 1)) {
                e.preventDefault();
                e.stopPropagation();
                self.resetZoom(view);
            }
        });

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
            return view.zoom.scale > 1.05 ||
                Math.abs(view.zoom.offsetX) > 2 ||
                Math.abs(view.zoom.offsetY) > 2;
        };

        document.addEventListener("mousemove", function (e) {
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
                self.applyZoom(view);
                return;
            }

            if (leftDragPending) {
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
        });

        document.addEventListener("mouseup", function (e) {
            leftDragPending = false;

            // Skip zoom actions if interaction manager owns the mouse
            if (window.__mvguiDragging) return;

            if (e.button === 1 && isPanning) {
                isPanning = false;
            }

            if (e.button === 0 && isPanning) {
                isPanning = false;
            }

            if (isBoxZooming) {
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
        });
    }
}
