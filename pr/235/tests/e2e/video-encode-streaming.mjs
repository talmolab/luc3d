/**
 * video-encode-streaming.mjs — real-browser test for ui/video-encode.js, the
 * single video-encoding seam behind "Export Video Overlays" and "Export 3D
 * Video".
 *
 * WHY THIS EXISTS SEPARATELY from overlay-export-modal.mjs: that test drives the
 * modal, and a headless Chromium's `showSaveFilePicker()` rejects instantly with
 * AbortError, so the modal can only ever reach the BUFFERED path there. The
 * streaming path — the entire point of moving off mp4-muxer — is therefore
 * unreachable through the UI under test automation. This drives `createMp4Writer`
 * directly with a stand-in file handle so the streamed output can be inspected
 * byte for byte.
 *
 * What it pins:
 *  - the streamed path writes a real MP4 through a WritableStream, using
 *    POSITION-based writes (which is what makes it work against a
 *    FileSystemWritableFileStream, and what `fastStart: 'reserve'` needs)
 *  - `moov` lands BEFORE `mdat` on both paths, i.e. the file is seekable /
 *    progressively playable rather than needing the tail first. On the streamed
 *    path that is only true because we pass `fastStart: 'reserve'`; mediabunny
 *    DEFAULTS a StreamTarget to a trailing moov, so this assertion is what stops
 *    a silent regression to a non-seekable file.
 *  - the reserved sample table is bounded by frameCount, and overrunning it is
 *    reported clearly instead of corrupting the file
 *  - a canvas/encoder size mismatch fails loudly rather than silently rescaling
 *  - encoded dimensions match what was asked for
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8121);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });

    // index.html carries the importmap that resolves the bare `mediabunny`
    // specifier, so the module under test has to be loaded from that page.
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Encode a few frames of a moving square, both streamed and buffered.
    const out = await page.evaluate(async () => {
        const { createMp4Writer, videoEncodingAvailable } = await import('/ui/video-encode.js');

        const W = 320, H = 240, FPS = 10, N = 24;

        function makeCanvas() {
            const c = document.createElement('canvas');
            c.width = W; c.height = H;
            return c;
        }
        function paint(canvas, i) {
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#101820';
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = '#e0c060';
            ctx.fillRect((i * 9) % (W - 40), 60, 40, 40);
        }

        /**
         * Stand-in for a FileSystemFileHandle. Records mediabunny's
         * position-based writes so we can (a) prove it uses them and (b)
         * reassemble the file exactly as the filesystem would.
         */
        function fakeHandle() {
            const writes = [];
            let closed = false;
            return {
                writes,
                get closed() { return closed; },
                async createWritable() {
                    return new WritableStream({
                        write(chunk) {
                            if (chunk && chunk.type === 'write') {
                                writes.push({ position: chunk.position, data: new Uint8Array(chunk.data) });
                            } else if (chunk && chunk.type === 'truncate') {
                                writes.push({ truncate: chunk.size });
                            } else {
                                // A plain (non-positional) write — record it so the
                                // assertion below can catch the change.
                                writes.push({ position: null, data: new Uint8Array(chunk) });
                            }
                        },
                        close() { closed = true; },
                        abort() { closed = true; },
                    });
                },
            };
        }

        function assemble(writes) {
            let end = 0;
            for (const w of writes) {
                if (!w.data) continue;
                end = Math.max(end, (w.position || 0) + w.data.byteLength);
            }
            const buf = new Uint8Array(end);
            for (const w of writes) {
                if (!w.data) continue;
                buf.set(w.data, w.position || 0);
            }
            return buf;
        }

        // Byte offset of a 4-char box type, or -1.
        function findBox(bytes, tag) {
            const t = [...tag].map(c => c.charCodeAt(0));
            for (let i = 0; i + 3 < bytes.length; i++) {
                if (bytes[i] === t[0] && bytes[i + 1] === t[1] && bytes[i + 2] === t[2] && bytes[i + 3] === t[3]) return i;
            }
            return -1;
        }

        // Width/height out of the avc1 VisualSampleEntry:
        //   'avc1' + 6 reserved + 2 data_reference_index
        //          + 16 pre_defined/reserved + width(2) + height(2)
        // 'avc1' ALSO appears in the ftyp compatible-brand list, so every
        // occurrence is checked and only a real VisualSampleEntry (6 zero
        // reserved bytes then data_reference_index == 1) is accepted — same
        // approach as tests/e2e/overlay-export-modal.mjs.
        function avc1Dims(bytes) {
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let at = 0; at + 32 < bytes.length; at++) {
                if (!(bytes[at] === 0x61 && bytes[at + 1] === 0x76 &&
                      bytes[at + 2] === 0x63 && bytes[at + 3] === 0x31)) continue;   // 'avc1'
                const body = at + 4;
                let reservedZero = true;
                for (let k = 0; k < 6; k++) if (bytes[body + k] !== 0) { reservedZero = false; break; }
                if (!reservedZero || dv.getUint16(body + 6) !== 1) continue;
                return { w: dv.getUint16(body + 24), h: dv.getUint16(body + 26) };
            }
            return null;
        }

        const result = { available: videoEncodingAvailable(), W, H, FPS, N };

        // ---- streamed ------------------------------------------------------
        const handle = fakeHandle();
        const sCanvas = makeCanvas();
        const sw = await createMp4Writer({
            canvas: sCanvas, width: W, height: H, fps: FPS,
            bitrate: 800000, frameCount: N, fullCodecString: 'avc1.42001F',
            fileHandle: handle,
        });
        result.streamingFlag = sw.streaming;
        result.fastStart = sw.fastStart;
        result.codec = sw.codec;
        for (let i = 0; i < N; i++) { paint(sCanvas, i); await sw.addFrame(i); }

        // Overrunning the declared frameCount must be reported, not silently
        // corrupt the reserved sample table.
        try { await sw.addFrame(N); result.overrunThrew = false; }
        catch (e) { result.overrunThrew = true; result.overrunMsg = e.message; }

        const sres = await sw.finish();
        const bytes = assemble(handle.writes);
        result.streamed = sres.streamed;
        result.streamedBlobIsNull = sres.blob === null;
        result.streamedFrames = sres.frames;
        result.streamWriteCount = handle.writes.length;
        result.allWritesPositional = handle.writes.every(w => w.truncate !== undefined || typeof w.position === 'number');
        result.streamClosed = handle.closed;
        result.streamBytes = bytes.byteLength;
        result.sFtyp = findBox(bytes, 'ftyp');
        result.sMoov = findBox(bytes, 'moov');
        result.sMdat = findBox(bytes, 'mdat');
        result.sDims = avc1Dims(bytes);

        // ---- buffered ------------------------------------------------------
        const bCanvas = makeCanvas();
        const bw = await createMp4Writer({
            canvas: bCanvas, width: W, height: H, fps: FPS,
            bitrate: 800000, frameCount: N, fullCodecString: 'avc1.42001F',
        });
        result.bufferedStreamingFlag = bw.streaming;
        result.bufferedFastStart = bw.fastStart;
        for (let i = 0; i < N; i++) { paint(bCanvas, i); await bw.addFrame(i); }
        const bres = await bw.finish();
        const bbytes = new Uint8Array(await bres.blob.arrayBuffer());
        result.bufferedStreamed = bres.streamed;
        result.bufferedBytes = bbytes.byteLength;
        result.bFtyp = findBox(bbytes, 'ftyp');
        result.bMoov = findBox(bbytes, 'moov');
        result.bMdat = findBox(bbytes, 'mdat');
        result.bDims = avc1Dims(bbytes);

        // ---- size mismatch must fail loudly -------------------------------
        try {
            const wrong = document.createElement('canvas');
            wrong.width = 100; wrong.height = 80;
            await createMp4Writer({ canvas: wrong, width: W, height: H, fps: FPS, bitrate: 800000 });
            result.mismatchThrew = false;
        } catch (e) { result.mismatchThrew = true; result.mismatchMsg = e.message; }

        return result;
    });

    console.log('\n-- ui/video-encode.js --');
    check(out.available, 'WebCodecs video encoding is available in this browser');

    console.log('\n-- streamed path --');
    check(out.streamingFlag === true, 'a fileHandle puts the writer in streaming mode');
    check(out.fastStart === 'reserve',
        `a known frameCount selects fastStart 'reserve' (got ${JSON.stringify(out.fastStart)})`);
    check(out.codec === 'avc1.42001F', `the requested H.264 level is honoured (got ${out.codec})`);
    check(out.streamed === true && out.streamedBlobIsNull,
        'finish() reports streamed and hands back no Blob (the file is already written)');
    check(out.streamedFrames === out.N, `all ${out.N} frames were encoded (got ${out.streamedFrames})`);
    check(out.streamWriteCount > 0, `the WritableStream received writes (got ${out.streamWriteCount})`);
    check(out.allWritesPositional === true,
        'every write is position-based (required for FileSystemWritableFileStream + reserve)');
    check(out.streamClosed === true, 'finalize() closed the writable itself');
    check(out.streamBytes > 1000, `streamed output is a non-trivial file (${out.streamBytes} bytes)`);
    check(out.sFtyp >= 0, 'streamed output is a real MP4 (ftyp box)');
    check(out.sMoov >= 0 && out.sMdat >= 0, 'streamed output has both moov and mdat');
    check(out.sMoov < out.sMdat,
        `streamed moov precedes mdat — seekable, not tail-indexed (moov@${out.sMoov} < mdat@${out.sMdat})`);
    check(out.sDims && out.sDims.w === out.W && out.sDims.h === out.H,
        `streamed avc1 dimensions are ${out.W}x${out.H} (got ${JSON.stringify(out.sDims)})`);
    check(out.overrunThrew === true,
        `exceeding the declared frameCount is reported (${out.overrunMsg || 'no message'})`);

    console.log('\n-- buffered path (no fileHandle) --');
    check(out.bufferedStreamingFlag === false, 'no fileHandle means no streaming');
    check(out.bufferedFastStart === 'in-memory',
        `buffered output uses fastStart 'in-memory' (got ${JSON.stringify(out.bufferedFastStart)})`);
    check(out.bufferedStreamed === false, 'finish() reports a Blob rather than a written file');
    check(out.bufferedBytes > 1000, `buffered output is a non-trivial file (${out.bufferedBytes} bytes)`);
    check(out.bFtyp >= 0, 'buffered output is a real MP4 (ftyp box)');
    check(out.bMoov >= 0 && out.bMoov < out.bMdat,
        `buffered moov precedes mdat (moov@${out.bMoov} < mdat@${out.bMdat})`);
    check(out.bDims && out.bDims.w === out.W && out.bDims.h === out.H,
        `buffered avc1 dimensions are ${out.W}x${out.H} (got ${JSON.stringify(out.bDims)})`);

    console.log('\n-- guards --');
    check(out.mismatchThrew === true,
        `a canvas that disagrees with width/height is rejected (${out.mismatchMsg || 'no message'})`);

    console.log('');
    check(errs.length === 0, 'no page errors / console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}

console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
