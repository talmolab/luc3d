/**
 * video-codec-diagnosis.js — explain WHY a video won't play in this browser.
 *
 * When the <video> element rejects a file the browser only says "error code 4"
 * (MEDIA_ERR_SRC_NOT_SUPPORTED). This reads the file's actual video codec from
 * its MP4 sample description and turns the failure into a specific, actionable
 * message. Measured cases (tests/e2e/_probe-capabilities.mjs, macOS 26, M2 Pro):
 *
 *   - HEVC tagged `hev1`: Safari plays HEVC-in-MP4 only when tagged `hvc1`
 *     (canPlayType: hev1 "", hvc1 "probably"). A lossless re-tag fixes it.
 *   - AV1: Safari decodes AV1 only with hardware AV1 decode (Apple M3 or newer);
 *     Chrome and Firefox decode it in software.
 *   - HEVC on a browser with no HEVC at all, or any other undecodable codec:
 *     suggest another browser or converting to H.264.
 *
 * Reading is cheap even for multi-GB recordings: it walks top-level box headers
 * with random-access reads (`Blob.slice`, or HTTP Range for URLs) and reads only
 * the `moov` box (recordings usually keep it at the END of the file).
 *
 * Returns null (no diagnosis) when the codec can't be read or the browser
 * claims to support it — then the original error stands (e.g. a corrupt file).
 */

// Video sample-entry fourcc -> human name.
const VIDEO_ENTRIES = {
    avc1: 'H.264', avc3: 'H.264', hev1: 'HEVC (H.265)', hvc1: 'HEVC (H.265)',
    dvh1: 'Dolby Vision HEVC', dvhe: 'Dolby Vision HEVC', av01: 'AV1',
    vp09: 'VP9', vp08: 'VP8', mp4v: 'MPEG-4 Part 2',
    apch: 'Apple ProRes', apcn: 'Apple ProRes', apcs: 'Apple ProRes', apco: 'Apple ProRes', ap4h: 'Apple ProRes',
};

// A representative codecs= string per fourcc for canPlayType (profile/level
// matching common 1280x1024 camera recordings).
const PROBE_CODECS = {
    avc1: 'avc1.640028', avc3: 'avc3.640028', hev1: 'hev1.1.6.L120.90', hvc1: 'hvc1.1.6.L120.90',
    dvh1: 'dvh1.05.06', dvhe: 'dvhe.05.06', av01: 'av01.0.08M.08', vp09: 'vp09.00.40.08', vp08: 'vp8',
    mp4v: 'mp4v.20.9', apch: 'apch', apcn: 'apcn', apcs: 'apcs', apco: 'apco', ap4h: 'ap4h',
};

const MAX_MOOV_BYTES = 64 * 1024 * 1024;

async function sourceSize(source) {
    if (typeof Blob !== 'undefined' && source instanceof Blob) return source.size;
    if (typeof source === 'string') {
        const r = await fetch(source, { method: 'HEAD' });
        const n = Number(r.headers.get('Content-Length'));
        return r.ok && n > 0 ? n : null;
    }
    return null;
}

async function readRange(source, start, end) {
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
        return new Uint8Array(await source.slice(start, end).arrayBuffer());
    }
    if (typeof source === 'string') {
        const r = await fetch(source, { headers: { Range: 'bytes=' + start + '-' + (end - 1) } });
        if (r.status !== 206) {   // no Range support: don't download the whole file
            try { if (r.body) r.body.cancel(); } catch (e) { /* ignore */ }
            return null;
        }
        return new Uint8Array(await r.arrayBuffer());
    }
    return null;
}

function fourcc(bytes, at) {
    return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

/**
 * The first video sample-entry fourcc found in a `moov` box's bytes. Every
 * `stsd` (size, 'stsd', version/flags, entry_count) is followed by its first
 * sample entry (size, TYPE); audio entries (mp4a, …) are skipped.
 * @param {Uint8Array} moov
 * @returns {string|null}
 */
export function videoFourccFromMoov(moov) {
    for (let i = 4; i + 20 <= moov.length; i++) {
        if (moov[i] !== 0x73 || fourcc(moov, i) !== 'stsd') continue;   // 's'
        const type = fourcc(moov, i + 16);
        if (VIDEO_ENTRIES[type]) return type;
        if (type === 'encv') return 'encv';
    }
    return null;
}

/**
 * Read a file's video codec fourcc from its MP4/MOV sample description.
 * @param {Blob|string} source - File/Blob, or a URL (needs HTTP Range support)
 * @returns {Promise<{fourcc: string, codecName: string}|null>}
 */
export async function sniffMp4VideoCodec(source) {
    const size = await sourceSize(source);
    if (!size) return null;
    let off = 0;
    for (let n = 0; n < 64 && off + 8 <= size; n++) {
        const h = await readRange(source, off, Math.min(off + 16, size));
        if (!h || h.length < 8) return null;
        let boxSize = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
        const type = fourcc(h, 4);
        let header = 8;
        if (boxSize === 1) {             // 64-bit size
            if (h.length < 16) return null;
            boxSize = (((h[8] << 24) >>> 0) + (h[9] << 16) + (h[10] << 8) + h[11]) * 4294967296 +
                (((h[12] << 24) >>> 0) + (h[13] << 16) + (h[14] << 8) + h[15]);
            header = 16;
        } else if (boxSize === 0) {      // to end of file
            boxSize = size - off;
        }
        if (boxSize < header) return null;
        if (type === 'moov') {
            if (boxSize > MAX_MOOV_BYTES) return null;
            const moov = await readRange(source, off, off + boxSize);
            const fc = moov && videoFourccFromMoov(moov);
            return fc ? { fourcc: fc, codecName: fc === 'encv' ? 'encrypted video' : VIDEO_ENTRIES[fc] } : null;
        }
        off += boxSize;
    }
    return null;
}

function defaultCanPlayType(type) {
    try { return document.createElement('video').canPlayType(type) || ''; } catch (e) { return ''; }
}

function defaultIsSafari() {
    try {
        const ua = navigator.userAgent;
        return /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|Edg|Firefox|FxiOS)\//.test(ua);
    } catch (e) { return false; }
}

function fileStem(name) {
    return String(name || 'video').replace(/^.*[\/\\]/, '').replace(/\.[^.]+$/, '');
}

/**
 * Build the user-facing explanation for a codec this browser can't play.
 * Pure: `canPlayType` and `isSafari` are injected (tests).
 *
 * @param {string} fourccCode - sample-entry fourcc (e.g. 'hev1', 'av01')
 * @param {string} fileName
 * @param {{canPlayType?: function(string): string, isSafari?: boolean}} [env]
 * @returns {{fourcc: string, codecName: string, kind: string, message: string}|null}
 *   null when the browser says it can play this codec (nothing to explain).
 */
export function explainUnplayableCodec(fourccCode, fileName, env) {
    env = env || {};
    const canPlay = env.canPlayType || defaultCanPlayType;
    const safari = env.isSafari != null ? env.isSafari : defaultIsSafari();
    const name = String(fileName || 'video').replace(/^.*[\/\\]/, '');
    const stem = fileStem(name);
    const browser = safari ? 'Safari' : 'this browser';
    const codecName = VIDEO_ENTRIES[fourccCode] || (fourccCode === 'encv' ? 'encrypted video' : fourccCode);
    const supported = (fc) => PROBE_CODECS[fc] ? canPlay('video/mp4; codecs="' + PROBE_CODECS[fc] + '"') !== '' : false;
    const toH264 = 'ffmpeg -i "' + name + '" -c:v libx264 -crf 18 "' + stem + '_h264.mp4"';

    if (fourccCode === 'encv') {
        return { fourcc: fourccCode, codecName, kind: 'encrypted',
            message: name + ': the video track is encrypted (DRM), which LUCID cannot play.' };
    }
    if (supported(fourccCode)) return null;

    if (fourccCode === 'hev1' && supported('hvc1')) {
        return { fourcc: fourccCode, codecName, kind: 'hevc-hev1-tag',
            message: name + ': HEVC video tagged "hev1", which ' + browser + ' only plays when tagged "hvc1". '
                + 'Fix it losslessly (no re-encoding, seconds per file): ffmpeg -i "' + name + '" -c copy -tag:v hvc1 "'
                + stem + '_hvc1.mp4" — or open the project in Chrome or Firefox.' };
    }
    if (fourccCode === 'av01') {
        return { fourcc: fourccCode, codecName, kind: 'av1-unsupported',
            message: name + ': AV1 video, which ' + browser + ' cannot decode'
                + (safari ? ' (Safari decodes AV1 only on Macs with Apple M3 or newer)' : '')
                + '. Open the project in a recent Chrome or Firefox, or convert to H.264: ' + toH264 };
    }
    if (fourccCode === 'hev1' || fourccCode === 'hvc1') {
        return { fourcc: fourccCode, codecName, kind: 'hevc-unsupported',
            message: name + ': HEVC (H.265) video, which ' + browser + ' cannot decode. '
                + 'Open the project in Chrome or Safari, or convert to H.264: ' + toH264 };
    }
    return { fourcc: fourccCode, codecName, kind: 'unsupported',
        message: name + ': ' + codecName + ' video, which ' + browser + ' cannot decode. Convert to H.264: ' + toH264 };
}

/**
 * Diagnose a video the browser refused to load.
 * @param {Blob|string} source
 * @param {string} [fileName] - defaults to the File's name / URL's last segment
 * @returns {Promise<{fourcc, codecName, kind, message}|null>}
 */
export async function diagnoseUnplayableVideo(source, fileName, env) {
    const name = fileName || (source && source.name) ||
        (typeof source === 'string' ? decodeURIComponent(source.split('?')[0].split('/').pop()) : 'video');
    const codec = await sniffMp4VideoCodec(source);
    if (!codec) return null;
    return explainUnplayableCodec(codec.fourcc, name, env);
}

/**
 * One-line reason for a failed video load, for the loaders' status messages:
 * the codec diagnosis attached by OnDemandVideoDecoder.init when there is one,
 * else the error text (with the old generic hint for decoder errors).
 * @param {string} name - the file's display name
 * @param {Error|any} err
 * @returns {string}
 */
export function videoLoadFailureText(name, err) {
    if (err && err.codecDiagnosis && err.codecDiagnosis.message) return err.codecDiagnosis.message;
    const msg = (err && err.message) || String(err);
    if (msg.indexOf('NO_SUPPORTED_STREAMS') >= 0 || msg.indexOf('DEMUXER_ERROR') >= 0 || msg.indexOf('Video error code 4') >= 0) {
        return name + ' (this browser cannot decode it — try Chrome, or transcode to H.264: ffmpeg -i input.mp4 -c:v libx264 -crf 18 output.mp4)';
    }
    return name + ': ' + msg;
}
