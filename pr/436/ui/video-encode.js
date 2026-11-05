// ui/video-encode.js — the app's ONE video-encoding seam.
//
// WHY THIS EXISTS (and why it is not sleap-io.js): sleap-io.js has no browser
// video encoder. Its only encoder, `renderVideo()`, spawns a native `ffmpeg`
// binary and is exported solely from the Node entry — never from
// `src/index.browser.ts` — and its own docs say so outright ("there is no
// encoder in the JS port", docs/cropping.md). Confirmed against the source at
// every ref, not just the vendored pin. So encoding is the one piece of the
// export pipeline LUCID has to own.
//
// It owns it as thinly as possible, on top of **mediabunny** — the library
// sleap-io.js itself depends on for decode and which LUCID already vendors in
// full (`lib/mediabunny/mediabunny.min.mjs`, importmap `mediabunny`). That
// replaces the hand-rolled WebCodecs `VideoEncoder` + mp4-muxer pairing that
// used to be duplicated in ui/overlay-export-modal.js and ui/export-modals.js.
//
// What mediabunny does that the hand-rolled path did not:
//   * **Streams to disk.** The old path buffered the entire .mp4 in an
//     `ArrayBufferTarget` until `finalize()`. At medium/1080p30 that is roughly
//     0.93 MB/s of output, so a 10k-frame clip held ~310 MB in RAM — inside
//     V8's pointer-compressed cage, which a Chrome renderer hard-caps near 4 GB
//     (see CLAUDE.md on luc3d #185/#190/#191/#193). Given a `fileHandle` this
//     writes through a `StreamTarget` at a bounded footprint instead.
//   * **moov-at-front while streaming.** Because callers know the frame count up
//     front, `fastStart: 'reserve'` reserves the sample-table space, streams
//     `mdat`, then seeks back and writes `moov` ahead of it — a seekable file
//     without ever holding it in memory. NOTE mediabunny defaults `fastStart` to
//     `'in-memory'` for a BufferTarget but to `false` (moov last) for a
//     StreamTarget, so it is always passed explicitly here.
//   * **Real backpressure.** `source.add()` returns a promise that settles when
//     the encoder has room, replacing a `while (encodeQueueSize > 12) await
//     setTimeout(0)` spin. It also *rejects* on encoder failure, so a dead
//     encoder surfaces as a rejected await instead of an unbounded spin against
//     a queue that will never drain (the old `error:` callback only logged).
//
// Deliberately NOT changed: H.264 only, the callers' own bitrate maths, and a
// keyframe every 60 frames. Codec fallback (VP9/AV1) is a separate decision —
// this module just makes it a one-line change when someone wants it.

import {
    Output,
    Mp4OutputFormat,
    CanvasSource,
    BufferTarget,
    StreamTarget,
    canEncodeVideo,
} from 'mediabunny';

export const MP4_MIME = 'video/mp4';

/** Historical LUCID keyframe cadence, in frames. */
export const KEYFRAME_INTERVAL_FRAMES = 60;

/** True when the platform has WebCodecs video encoding at all. */
export function videoEncodingAvailable() {
    return typeof VideoEncoder !== 'undefined';
}

/**
 * Resolve the H.264 encoder config for W x H, honouring the caller's preferred
 * full codec string (LUCID picks an explicit level via `h264CodecFor()` /
 * `V3D_RES`) but degrading to mediabunny's own level pick when this machine
 * cannot encode that exact string.
 *
 * `canEncodeVideo` *validates* `fullCodecString` against the codec and throws a
 * TypeError on a mismatch, so a malformed preference is caught here rather than
 * at `start()` time, mid-export.
 *
 * @returns {Promise<{codec:string, fullCodecString?:string}|null>} null when
 *   this browser cannot encode H.264 at this size at all.
 */
export async function resolveH264Config(width, height, bitrate, preferredCodecString) {
    if (!videoEncodingAvailable()) return null;

    if (preferredCodecString) {
        try {
            var okExact = await canEncodeVideo('avc', {
                width: width, height: height, bitrate: bitrate,
                fullCodecString: preferredCodecString,
            });
            if (okExact) return { codec: 'avc', fullCodecString: preferredCodecString };
        } catch (e) {
            // Malformed/mismatched preference — fall back to the plain codec.
            console.warn('[video-encode] ignoring codec string ' + preferredCodecString + ':', e.message);
        }
    }

    try {
        if (await canEncodeVideo('avc', { width: width, height: height, bitrate: bitrate })) {
            return { codec: 'avc' };
        }
    } catch (e) { /* treated as unsupported below */ }

    return null;
}

/**
 * Create an .mp4 writer that encodes successive states of ONE canvas.
 *
 * The canvas is sampled at each `addFrame()` call (mediabunny's CanvasSource
 * reads it then), so callers draw into it and then call `addFrame`, exactly as
 * they previously did with `new VideoFrame(canvas, …)`.
 *
 * Destination:
 *   * `fileHandle` given → streamed straight to that file, bounded memory. With
 *     `frameCount` also given the file gets a front-loaded `moov`.
 *   * otherwise → buffered in memory; `finish()` hands back a Blob to download.
 *
 * @param {Object} opts
 * @param {HTMLCanvasElement} opts.canvas   frame source; its size must equal width/height
 * @param {number} opts.width               encoder width (even; see `evenDim()`)
 * @param {number} opts.height              encoder height (even)
 * @param {number} opts.fps                 output frame rate
 * @param {number} opts.bitrate             target bits/sec
 * @param {number} [opts.frameCount]        exact number of frames to be added
 * @param {string} [opts.fullCodecString]   preferred H.264 level, e.g. 'avc1.420028'
 * @param {number} [opts.keyFrameEveryFrames=60]
 * @param {FileSystemFileHandle} [opts.fileHandle]
 * @returns {Promise<{addFrame:Function, finish:Function, cancel:Function,
 *                    streaming:boolean, codec:string, fastStart:(string|false)}>}
 */
export async function createMp4Writer(opts) {
    var canvas = opts.canvas;
    var width = opts.width, height = opts.height;
    var fps = opts.fps, bitrate = opts.bitrate;

    if (!canvas) throw new Error('createMp4Writer requires a canvas');
    // A silent size mismatch would make mediabunny rescale every frame rather
    // than fail, so it is worth being loud: the caller's bitrate/codec were
    // chosen for width x height, and the file would claim those dimensions.
    if (canvas.width !== width || canvas.height !== height) {
        throw new Error('createMp4Writer: canvas is ' + canvas.width + '×' + canvas.height +
            ' but the encoder was configured for ' + width + '×' + height);
    }
    if (!(fps > 0)) throw new Error('createMp4Writer: fps must be positive');
    if (!(bitrate > 0)) throw new Error('createMp4Writer: bitrate must be positive');

    var keyEvery = opts.keyFrameEveryFrames > 0
        ? Math.floor(opts.keyFrameEveryFrames) : KEYFRAME_INTERVAL_FRAMES;
    var frameCount = (typeof opts.frameCount === 'number' && opts.frameCount > 0)
        ? Math.floor(opts.frameCount) : null;

    var cfg = await resolveH264Config(width, height, bitrate, opts.fullCodecString);
    if (!cfg) {
        throw new Error('This browser cannot encode H.264 video at ' + width + '×' + height +
            '. Video export needs WebCodecs (Chrome, Edge or a recent Safari).');
    }

    // --- destination ------------------------------------------------------
    var streaming = !!opts.fileHandle;
    var target, fastStart;
    if (streaming) {
        var writable = await opts.fileHandle.createWritable();
        target = new StreamTarget(writable);
        // 'reserve' needs an exact upper bound on packets; without one, fall
        // back to a trailing moov (still a valid, still-streamed .mp4).
        fastStart = frameCount ? 'reserve' : false;
    } else {
        target = new BufferTarget();
        fastStart = 'in-memory';
    }

    var output = new Output({
        format: new Mp4OutputFormat({ fastStart: fastStart }),
        target: target,
    });

    var sourceConfig = {
        codec: cfg.codec,
        bitrate: bitrate,
        // mediabunny expresses this in SECONDS. keyEvery/fps reproduces the
        // historical "keyframe every `keyEvery` frames" exactly: with
        // timestamps of outIdx/fps, floor(ts / (keyEvery/fps)) ticks over at
        // precisely outIdx = keyEvery, 2*keyEvery, … The per-frame `keyFrame`
        // flag in addFrame() is OR'd with this, so the two agree rather than
        // compounding into extra keyframes.
        keyFrameInterval: keyEvery / fps,
    };
    if (cfg.fullCodecString) sourceConfig.fullCodecString = cfg.fullCodecString;

    var source = new CanvasSource(canvas, sourceConfig);

    var trackMeta = { frameRate: fps };
    if (fastStart === 'reserve') trackMeta.maximumPacketCount = frameCount;
    output.addVideoTrack(source, trackMeta);

    await output.start();

    var added = 0;
    var done = false;

    /**
     * Encode the canvas's CURRENT contents as output frame `outIdx`.
     * Awaiting this is what applies encoder backpressure.
     */
    async function addFrame(outIdx) {
        if (done) throw new Error('addFrame after finish/cancel');
        if (frameCount != null && added >= frameCount) {
            // Would blow mediabunny's reserved sample table; say why.
            throw new Error('addFrame: more frames added than the declared frameCount (' +
                frameCount + ')');
        }
        await source.add(outIdx / fps, 1 / fps, { keyFrame: (outIdx % keyEvery) === 0 });
        added++;
    }

    /**
     * Flush, mux and close. Returns the finished bytes for the buffered path;
     * for the streamed path the file is already on disk (mediabunny closes the
     * writable itself) and `blob` is null.
     */
    async function finish() {
        if (done) throw new Error('finish after finish/cancel');
        done = true;
        await output.finalize();
        if (streaming) return { streamed: true, blob: null, frames: added };
        var buf = target.buffer;
        return {
            streamed: false,
            blob: new Blob([buf], { type: MP4_MIME }),
            frames: added,
        };
    }

    /**
     * Abandon the export. NOTE mediabunny closes the underlying writable here
     * too, which for a FileSystemWritableFileStream COMMITS whatever was
     * written — so a cancelled streamed export leaves a partial, unplayable
     * .mp4 on disk. Callers should say so.
     */
    async function cancel() {
        if (done) return;
        done = true;
        try { await output.cancel(); } catch (e) { /* already torn down */ }
    }

    return {
        addFrame: addFrame,
        finish: finish,
        cancel: cancel,
        streaming: streaming,
        codec: cfg.fullCodecString || cfg.codec,
        fastStart: fastStart,
        get framesAdded() { return added; },
    };
}
