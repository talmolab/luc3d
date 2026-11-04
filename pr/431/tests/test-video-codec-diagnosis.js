/**
 * test-video-codec-diagnosis.js — loading/video-codec-diagnosis.js.
 *
 * When the browser refuses a video ("error code 4"), the decoder reads the
 * file's codec from its MP4 sample description and explains what to do —
 * measured cases: Safari won't play HEVC tagged `hev1` (lossless re-tag to
 * `hvc1` fixes it) and has no AV1 without hardware decode (Apple M3+).
 *
 * Synthetic MP4s are built in memory: real recordings keep `moov` at the END
 * (after hundreds of MB of `mdat`), so the reader must walk box headers and
 * read only `moov`, never the whole file.
 */
(function () {
    var TF = TestFramework;
    var describe = TF.describe, it = TF.it, assertEqual = TF.assertEqual, assertTrue = TF.assertTrue;

    function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
    function str(s) { return s.split('').map(function (c) { return c.charCodeAt(0); }); }
    function box(type, payload) { return u32(8 + payload.length).concat(str(type), payload); }
    // stsd with one sample entry of `entryType` (entry body is padding).
    function stsd(entryType) {
        return box('stsd', [0, 0, 0, 0].concat(u32(1), u32(16), str(entryType), [0, 0, 0, 0, 0, 0, 0, 0]));
    }
    // moov holding an audio track's stsd first, then the video track's.
    function moov(videoType) {
        return box('moov', box('trak', stsd('mp4a')).concat(box('trak', stsd(videoType))));
    }
    var FTYP = box('ftyp', str('isom').concat(u32(512), str('isomiso2')));

    // An MP4 Blob: ftyp, a big mdat, then moov (like a camera recording).
    function mp4MoovAtEnd(videoType, mdatBytes) {
        var mdatHdr = u32(8 + mdatBytes).concat(str('mdat'));
        return new Blob([new Uint8Array(FTYP.concat(mdatHdr)), new Uint8Array(mdatBytes), new Uint8Array(moov(videoType))]);
    }

    // Wrap a Blob so we can count how many bytes the reader slices out.
    function counting(blob) {
        var stats = { bytes: 0 };
        var wrapped = new Blob([blob]);
        var origSlice = wrapped.slice.bind(wrapped);
        wrapped.slice = function (a, b) { var p = origSlice(a, b); stats.bytes += p.size; return p; };
        return { blob: wrapped, stats: stats };
    }

    describe('video-codec-diagnosis: reading the codec from the MP4', function () {
        it('finds the video codec in a moov at the END, reading only headers + moov', async function () {
            if (typeof sniffMp4VideoCodec === 'undefined') return;
            var c = counting(mp4MoovAtEnd('hev1', 3 * 1024 * 1024));
            var r = await sniffMp4VideoCodec(c.blob);
            assertEqual(r && r.fourcc, 'hev1', 'hev1 found (audio stsd skipped)');
            assertEqual(r.codecName, 'HEVC (H.265)', 'named');
            assertTrue(c.stats.bytes < 4096, 'read ' + c.stats.bytes + ' bytes of a 3 MB file');
        });

        it('handles moov first, AV1, and 64-bit box sizes', async function () {
            if (typeof sniffMp4VideoCodec === 'undefined') return;
            var first = new Blob([new Uint8Array(FTYP.concat(moov('av01')))]);
            var r1 = await sniffMp4VideoCodec(first);
            assertEqual(r1 && r1.fourcc, 'av01', 'AV1 with moov first');
            // mdat with size==1 + 64-bit largesize
            var payload = 1000;
            var big = u32(1).concat(str('mdat'), u32(0), u32(16 + payload));
            var b64 = new Blob([new Uint8Array(FTYP.concat(big)), new Uint8Array(payload), new Uint8Array(moov('avc1'))]);
            var r2 = await sniffMp4VideoCodec(b64);
            assertEqual(r2 && r2.fourcc, 'avc1', 'walked past a 64-bit mdat');
        });

        it('returns null for something that is not an MP4', async function () {
            if (typeof sniffMp4VideoCodec === 'undefined') return;
            var r = await sniffMp4VideoCodec(new Blob([new Uint8Array(str('not a video at all, just text'))]));
            assertEqual(r, null, 'no diagnosis');
        });
    });

    describe('video-codec-diagnosis: explaining what to do', function () {
        // canPlayType as measured on Safari 27 (M2 Pro) / Chrome 154 / an HEVC-less browser.
        var SAFARI = function (t) { return /hvc1|avc1/.test(t) ? 'probably' : ''; };
        var CHROME = function (t) { return /hvc1|hev1|avc1|av01/.test(t) ? 'probably' : ''; };
        var NO_HEVC = function (t) { return /avc1|av01/.test(t) ? 'probably' : ''; };

        it('Safari + hev1-tagged HEVC: the lossless re-tag command', function () {
            if (typeof explainUnplayableCodec === 'undefined') return;
            var d = explainUnplayableCodec('hev1', 'Camera0_mid.mp4', { canPlayType: SAFARI, isSafari: true });
            assertEqual(d.kind, 'hevc-hev1-tag', 'kind');
            assertTrue(d.message.indexOf('-c copy -tag:v hvc1') >= 0, 'gives the re-tag command');
            assertTrue(d.message.indexOf('"Camera0_mid.mp4"') >= 0 && d.message.indexOf('Camera0_mid_hvc1.mp4') >= 0, 'with this file\'s names');
            assertTrue(d.message.indexOf('Safari') >= 0, 'names the browser');
        });

        it('Safari + AV1: explains the M3 requirement and the alternatives', function () {
            if (typeof explainUnplayableCodec === 'undefined') return;
            var d = explainUnplayableCodec('av01', 'cam.mp4', { canPlayType: SAFARI, isSafari: true });
            assertEqual(d.kind, 'av1-unsupported', 'kind');
            assertTrue(/M3/.test(d.message) && /Chrome or Firefox/.test(d.message) && /libx264/.test(d.message), d.message);
        });

        it('HEVC in a non-Chromium browser with no HEVC: suggests Safari/Chrome or H.264 (and not the re-tag)', function () {
            if (typeof explainUnplayableCodec === 'undefined') return;
            var d = explainUnplayableCodec('hvc1', 'cam.mp4', { canPlayType: NO_HEVC, isSafari: false, isChromium: false });
            assertEqual(d.kind, 'hevc-unsupported', 'kind');
            assertTrue(d.message.indexOf('-tag:v') < 0 && /libx264/.test(d.message), d.message);
            assertTrue(d.message.indexOf('this browser') >= 0, 'generic browser wording off Safari');
            assertTrue(d.steps.length === 2 && /-fps_mode passthrough/.test(d.command), 'steps + a frame-keeping command');
        });

        // WebGL renderers as reported: a Windows 11 VM with no GPU (Chrome 155),
        // Chrome with acceleration off, and a real GPU.
        var BASIC = 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)';
        var SWIFT = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
        var RTX = 'ANGLE (NVIDIA, NVIDIA RTX 4000 Ada Generation (0x000027B0) Direct3D11 vs_5_0 ps_5_0, D3D11)';

        it('HEVC in Chrome with no GPU: says Chrome needs one, names the adapter, gives the steps', function () {
            if (typeof explainUnplayableCodec === 'undefined') return;
            var d = explainUnplayableCodec('hvc1', 'Camera0_topB.mp4', { canPlayType: NO_HEVC, isSafari: false, isChromium: true, renderer: BASIC });
            assertEqual(d.kind, 'hevc-no-gpu', 'kind');
            assertTrue(/no H\.265 decoder of their own/.test(d.why), 'why: ' + d.why);
            assertTrue(d.why.indexOf('"Microsoft Basic Render Driver"') >= 0, 'adapter named without ANGLE wrapping: ' + d.why);
            assertTrue(/GPU/.test(d.steps[0]) && /driver/.test(d.steps[0]), 'first step: a GPU and its driver');
            assertTrue(/Remote Desktop/.test(d.steps[1]), 'RDP policy');
            assertTrue(/Microsoft Basic Render Driver/.test(d.message) && /libx264/.test(d.message), 'one-line form: ' + d.message);
            assertTrue(!/open the project in Chrome/i.test(d.message), 'never tells a Chrome user to use Chrome');
        });

        it('HEVC in Chrome drawing in SwiftShader: points at graphics acceleration', function () {
            if (typeof explainUnplayableCodec === 'undefined') return;
            var d = explainUnplayableCodec('hev1', 'cam.mp4', { canPlayType: NO_HEVC, isSafari: false, isChromium: true, renderer: SWIFT });
            assertEqual(d.kind, 'hevc-gpu-no-decode', 'kind');
            assertTrue(/SwiftShader/.test(d.why) && /graphics acceleration/.test(d.steps[0]), d.why);
        });

        it('HEVC in Chrome with a GPU but no decode: driver / acceleration, names the GPU', function () {
            if (typeof explainUnplayableCodec === 'undefined') return;
            var d = explainUnplayableCodec('hvc1', 'cam.mp4', { canPlayType: NO_HEVC, isSafari: false, isChromium: true, renderer: RTX });
            assertEqual(d.kind, 'hevc-gpu-no-decode', 'kind');
            assertTrue(d.why.indexOf('"NVIDIA RTX 4000 Ada Generation"') >= 0, d.why);
            assertTrue(/chrome:\/\/gpu/.test(d.steps.join(' ')), 'chrome://gpu check');
            var u = explainUnplayableCodec('hvc1', 'cam.mp4', { canPlayType: NO_HEVC, isSafari: false, isChromium: true, renderer: '' });
            assertEqual(u.kind, 'hevc-gpu-no-decode', 'unknown renderer: the setting/driver advice');
        });

        it('rendererHasGpu: software and virtual adapters are not GPUs', function () {
            if (typeof rendererHasGpu === 'undefined') return;
            assertEqual(rendererHasGpu(BASIC), false, 'Basic Render Driver');
            assertEqual(rendererHasGpu(SWIFT), false, 'SwiftShader');
            assertEqual(rendererHasGpu('llvmpipe (LLVM 15.0.7, 256 bits)'), false, 'llvmpipe');
            assertEqual(rendererHasGpu('ANGLE (VMware, Inc., VMware SVGA 3D (0x00000405) Direct3D11 vs_5_0 ps_5_0, D3D11)'), false, 'VMware');
            assertEqual(rendererHasGpu(RTX), true, 'NVIDIA');
            assertEqual(rendererHasGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)'), true, 'Apple');
            assertEqual(rendererHasGpu(''), null, 'unknown');
        });

        it('no diagnosis when the browser says it can play the codec', function () {
            if (typeof explainUnplayableCodec === 'undefined') return;
            assertEqual(explainUnplayableCodec('av01', 'cam.mp4', { canPlayType: CHROME, isSafari: false }), null, 'AV1 on Chrome');
            assertEqual(explainUnplayableCodec('hev1', 'cam.mp4', { canPlayType: CHROME, isSafari: false }), null, 'hev1 on Chrome');
        });

        it('other undecodable codecs get a generic convert hint', function () {
            if (typeof explainUnplayableCodec === 'undefined') return;
            var d = explainUnplayableCodec('vp09', 'cam.mp4', { canPlayType: SAFARI, isSafari: true });
            assertEqual(d.kind, 'unsupported', 'kind');
            assertTrue(/VP9/.test(d.message) && /libx264/.test(d.message), d.message);
        });

        it('videoLoadFailureText prefers the diagnosis, keeps a hint for bare decoder errors', function () {
            if (typeof videoLoadFailureText === 'undefined') return;
            var e = new Error('x'); e.codecDiagnosis = { message: 'cam.mp4: AV1 video, …' };
            assertEqual(videoLoadFailureText('cam', e), 'cam.mp4: AV1 video, …', 'diagnosis wins');
            assertTrue(/libx264/.test(videoLoadFailureText('cam', new Error('Video error code 4: x'))), 'legacy hint');
            assertEqual(videoLoadFailureText('cam', new Error('boom')), 'cam: boom', 'other errors pass through');
        });
    });

    describe('OnDemandVideoDecoder.init attaches the diagnosis', function () {
        it('a file the <video> element rejects comes back with err.codecDiagnosis', async function () {
            if (typeof OnDemandVideoDecoder === 'undefined' || typeof sniffMp4VideoCodec === 'undefined') return;
            // Valid box structure naming an AV1 track, but no decodable media:
            // the element fails to load it; whatever this browser supports,
            // the reader must have identified the track.
            var file = new File([mp4MoovAtEnd('av01', 4096)], 'broken-av1.mp4', { type: 'video/mp4' });
            var dec = new OnDemandVideoDecoder({});
            var err = null;
            try { await dec.init(file); } catch (e) { err = e; }
            assertTrue(!!err, 'init rejected');
            if (err && err.codecDiagnosis) {
                assertEqual(err.codecDiagnosis.fourcc, 'av01', 'codec identified');
                assertTrue(err.message.indexOf('broken-av1.mp4') === 0, 'message starts with the file name');
                assertTrue(!!err.cause, 'original error kept as cause');
            } else {
                // A browser that claims AV1 support gets no diagnosis (corrupt
                // file, not a codec problem) — the original error must stand.
                assertTrue(/Video error|load/i.test(err.message), 'original error kept: ' + err.message);
            }
        });
    });
})();
