/**
 * _probe-capabilities.mjs — what does each INSTALLED browser support that
 * LUCID's playback depends on? (Chrome, Safari, Firefox — the real apps, not
 * Playwright's engine builds.)
 *
 * Serves the repo (with HTTP Range support — Safari won't play <video>
 * without it) plus the two benchmark datasets' videos (symlinked under the
 * gitignored verify/probe-media/), opens tests/e2e/_probe-capabilities.html
 * in each browser with `open -a`, and collects the JSON report each page
 * POSTs back. Reports land in verify/probe-results/<browser>-<run>.json and a
 * side-by-side summary is printed.
 *
 * PAGE=_verify-playback-loop.html runs the app's real playback loop instead,
 * on barcode test clips (frame number burned into the pixels) from
 * verify/barcode/, built with ffmpeg's geq filter — e.g. for 60 fps H.264:
 *   ffmpeg -f lavfi -i color=c=gray:s=1280x1024:r=60:d=12 -vf "geq=lum='if(lt(Y,64),
 *     if(mod(floor(N/pow(2,floor(X/80))),2),235,16),60+mod(X/4+Y/4+N*3,120))':cb=128:cr=128"
 *     -c:v libx264 -crf 14 -bf 2 -g 60 -pix_fmt yuv420p verify/barcode/h264-60.mp4
 * (also h264-150.mp4 at r=150, and hevc-60.mp4 with libx265 -tag:v hvc1).
 *
 * Not a test. Usage:
 *     node tests/e2e/_probe-capabilities.mjs
 *   env: BROWSERS=chrome,safari,firefox  PORT=8140
 *        HARDFIGHT=<dir> MIMICA=<dir>    (per-camera session folders)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8140);
const BROWSERS = (process.env.BROWSERS || 'chrome,safari,firefox').split(',').map(s => s.trim()).filter(Boolean);
const APPS = { chrome: 'Google Chrome', safari: 'Safari', firefox: 'Firefox', edge: 'Microsoft Edge' };
const HARDFIGHT = process.env.HARDFIGHT || '/Users/soline/Documents/luc3d/LabMeetingPrep/Oline/20260605_133431-HardFight_1kModels';
const MIMICA = process.env.MIMICA || '/Users/soline/Documents/luc3d/LabMeetingPrep/Mimica/20260709171244_labMeetingPrep';
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const PAGE = process.env.PAGE || '_probe-capabilities.html';
const VERIFY = PAGE.includes('verify');

// ---- media: one mp4 per camera folder, symlinked into verify/probe-media ----
const mediaDir = path.join(repoRoot, 'verify', 'probe-media');
const resultsDir = path.join(repoRoot, 'verify', 'probe-results');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });
function linkCameras(root, tag) {
    if (!fs.existsSync(root)) return [];
    const urls = [];
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    for (const d of dirs) {
        const mp4 = fs.readdirSync(path.join(root, d)).find(f => /\.mp4$/i.test(f) && !f.startsWith('.'));
        if (!mp4) continue;
        const name = `${tag}-${urls.length}.mp4`;
        const dst = path.join(mediaDir, name);
        try { fs.unlinkSync(dst); } catch (e) {}
        fs.symlinkSync(path.join(root, d, mp4), dst);
        // Alternate loopback hostnames: browsers allow only 6 HTTP/1.1
        // connections per host and every progressively-loading <video> holds
        // one, so 8 cameras on one host starve the last two (the app itself
        // plays local Files via blob URLs, with no such limit). The second
        // host is cross-origin, hence CORS below + crossOrigin in the page.
        const host = urls.length % 2 === 0 ? 'localhost' : '127.0.0.1';
        urls.push(`http://${host}:${PORT}/verify/probe-media/${name}`);
    }
    return urls;
}
// HARDFIGHT_HVC1: the same HEVC re-tagged hev1 -> hvc1 (lossless remux;
// Safari only plays HEVC-in-MP4 tagged hvc1). Built under verify/ by:
//   ffmpeg -t 60 -i in.mp4 -c copy -tag:v hvc1 out.mp4
const HARDFIGHT_HVC1 = process.env.HARDFIGHT_HVC1 || path.join(repoRoot, 'verify', 'probe-remux', 'HardFight_hvc1');
// ONLY_EXTRA=1 skips the original HEVC/H.264 sets (to test just the extras).
const ONLY_EXTRA = process.env.ONLY_EXTRA === '1';
const media = ONLY_EXTRA ? { hardfight: [], hardfightHvc1: [], mimica: [], fps: {} }
    : { hardfight: linkCameras(HARDFIGHT, 'hardfight'), hardfightHvc1: linkCameras(HARDFIGHT_HVC1, 'hardfight-hvc1'),
        mimica: linkCameras(MIMICA, 'mimica'), fps: { hardfight: 60, mimica: 150.1066 } };
// Extra per-camera sets, e.g. the datasets transcoded to AV1 (15 s each):
//   ffmpeg -t 15 -i in.mp4 -an -c:v libsvtav1 -preset 8 -crf 30 -g <fps> out.mp4
media.extra = [
    { name: 'hardfight-av1', fps: 60, dir: path.join(repoRoot, 'verify', 'probe-remux', 'HardFight_av1') },
    { name: 'mimica-av1', fps: 150.1066, dir: path.join(repoRoot, 'verify', 'probe-remux', 'Mimica_av1') },
].map(x => ({ name: x.name, fps: x.fps, urls: linkCameras(x.dir, x.name) })).filter(x => x.urls.length);
// Files for the decoder's unplayable-codec messages: a real hev1-tagged camera
// recording, an AV1 clip, and an H.264 control (same origin).
media.errorCases = {};
{
    const hf = linkCameras(HARDFIGHT, 'errcase-hev1').slice(0, 1);
    if (hf.length) media.errorCases.hev1_real = hf[0].replace(/^http:\/\/[^/]+/, '');
    for (const [k, f] of [['av1_clip', 'av1-60.mp4'], ['h264_clip', 'h264-60.mp4']]) {
        if (fs.existsSync(path.join(repoRoot, 'verify', 'barcode', f))) media.errorCases[k] = '/verify/barcode/' + f;
    }
}

// ---- static server with Range + POST /result -------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.mp4': 'video/mp4',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.map': 'application/json' };
const received = new Map();
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'range',
            'Access-Control-Allow-Methods': 'GET, HEAD' });
        return res.end();
    }
    if (url.pathname === '/progress') {
        console.log(`  [${url.searchParams.get('browser')}] ${url.searchParams.get('step')}` +
            (url.searchParams.get('hidden') === 'true' ? '  (TAB HIDDEN — rAF is throttled)' : ''));
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/result') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const b = url.searchParams.get('browser') || 'unknown';
            fs.writeFileSync(path.join(resultsDir, `${b}-${RUN}.json`), body);
            try { received.set(b, JSON.parse(body)); } catch (e) { received.set(b, { parseError: String(e) }); }
            res.writeHead(204); res.end();
        });
        return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(repoRoot, path.normalize(p));
    if (!file.startsWith(repoRoot)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
        const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
        const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (range) {
            let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
            let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
            if (start >= st.size || end >= st.size || start > end) {
                res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end();
            }
            res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*',
                'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1,
                'Cache-Control': 'no-store' });
            fs.createReadStream(file, { start, end }).pipe(res);
        } else {
            res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size,
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store' });
            if (req.method === 'HEAD') return res.end();
            fs.createReadStream(file).pipe(res);
        }
    });
});
await new Promise(r => server.listen(PORT, r));
console.log(`serving ${repoRoot} on http://localhost:${PORT}  (hardfight ${media.hardfight.length} cams, mimica ${media.mimica.length} cams)`);

// Verify page: per-camera symlinks to the barcode clips, all SAME-origin
// (the page reads its canvases back; a cross-origin video would taint them).
function barcodeSet(name, file, fps, cams) {
    const src = path.join(repoRoot, 'verify', 'barcode', file);
    if (!fs.existsSync(src)) return null;
    const dir = path.join(repoRoot, 'verify', 'barcode-cams'); fs.mkdirSync(dir, { recursive: true });
    const urls = [];
    for (let i = 0; i < cams; i++) {
        const dst = path.join(dir, `${name}-${i}.mp4`);
        try { fs.unlinkSync(dst); } catch (e) {}
        fs.symlinkSync(src, dst);
        urls.push(`/verify/barcode-cams/${name}-${i}.mp4`);
    }
    return { name, fps, urls };
}
const SETS = process.env.SETS ? process.env.SETS.split(',') : ['hevc60x8', 'h264-60x5', 'h264-150x5'];
const verifyMedia = { sets: [barcodeSet('hevc60x8', 'hevc-60.mp4', 60, 8), barcodeSet('h264-60x5', 'h264-60.mp4', 60, 5),
                             barcodeSet('h264-150x5', 'h264-150.mp4', 150, 5),
                             barcodeSet('av1-60x5', 'av1-60.mp4', 60, 5), barcodeSet('av1-60x8', 'av1-60.mp4', 60, 8),
                             barcodeSet('av1-150x5', 'av1-150.mp4', 150, 5)]
                    .filter(Boolean).filter(x => SETS.includes(x.name)) };
const pageUrl = (b) => `http://localhost:${PORT}/tests/e2e/${PAGE}?browser=${b}&run=${RUN}` +
    (process.env.READBACK === '0' ? '&readback=0' : '') + (process.env.LOOP ? '&loop=' + process.env.LOOP : '') +
    `&media=${encodeURIComponent(JSON.stringify(VERIFY ? verifyMedia : media))}`;

for (const b of BROWSERS) {
    const app = APPS[b];
    if (!app) { console.log(`skip unknown browser ${b}`); continue; }
    console.log(`\n=== ${b}: open -a "${app}"`);
    spawn('open', ['-a', app, pageUrl(b)], { stdio: 'ignore' });
    const t0 = Date.now();
    while (!received.has(b) && Date.now() - t0 < 5 * 60 * 1000) await new Promise(r => setTimeout(r, 1000));
    console.log(received.has(b) ? `  report received in ${((Date.now() - t0) / 1000).toFixed(0)} s` : '  NO REPORT within 5 min');
}

// ---- summary -----------------------------------------------------------------
if (VERIFY) {
    for (const b of BROWSERS) {
        const r = received.get(b); if (!r) continue;
        console.log(`\n${b}  (${(r.ua || '').replace(/^.*?\) /, '').slice(0, 60)})`);
        for (const [name, x] of Object.entries(r.sets || {})) {
            if (x.error) { console.log(`  ${name.padEnd(11)} ERROR ${x.error.slice(0, 160)}`); continue; }
            const avg = (a) => (a.reduce((p, c) => p + c, 0) / a.length).toFixed(1);
            const modes = [...new Set(x.mode)].join('/');
            console.log(`  ${name.padEnd(11)} ${x.refreshHz} Hz  fps ${[...new Set(x.decoderFps || [])].join('/')}  mode ${modes.padEnd(9)} painted==overlay ${x.readback === false ? 'n/a (no read-back)' : Math.min(...x.paintedEqualsOverlayPct) + '–' + Math.max(...x.paintedEqualsOverlayPct) + '%'}` +
                `  new images/s ${avg(x.distinctPaintedPerSec)} (ideal ${x.idealNewImagesPerSec})  irregular ${x.irregularDurationPct}%` +
                `  steps ${JSON.stringify(x.stepsPerRefresh)}  cam spread ${JSON.stringify(x.cameraSpread)}`);
            if (x.estimators && Object.keys(x.estimators).length) console.log(`  ${''.padEnd(11)} fallback estimators (exact %): ` +
                Object.entries(x.estimators).map(([k, v]) => `${k} ${v.exactPct}`).join('  ') + `  [${x.alignmentSamples} samples]`);
            const worst = x.paintedMinusOverlay.reduce((w, h, i) => (x.paintedEqualsOverlayPct[i] < x.paintedEqualsOverlayPct[w] ? i : w), 0);
            if (x.paintedEqualsOverlayPct[worst] < 99.5) console.log(`  ${''.padEnd(11)} worst camera painted-minus-overlay: ${JSON.stringify(x.paintedMinusOverlay[worst])}`);
        }
    }
    console.log(`\nreports: ${resultsDir}/*-${RUN}.json`);
    server.close();
    process.exit(0);
}
const rows = [];
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function row(label, pathOrFn) {
    rows.push([label, ...BROWSERS.map(b => {
        const r = received.get(b); if (!r) return '—';
        const v = typeof pathOrFn === 'function' ? pathOrFn(r) : get(r, pathOrFn);
        return v === undefined ? '?' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    })]);
}
row('refresh (Hz)', 'checks.display.rafHz');
for (const k of ['importMaps', 'webAssembly', 'webgl2', 'videoFrame', 'videoDecoder', 'videoEncoder', 'rVFC',
                 'getVideoPlaybackQuality', 'showSaveFilePicker', 'webkitdirectory', 'moduleWorker', 'longTaskObserver']) {
    row(k, `checks.apis.${k}`);
}
row('HEVC canPlayType', 'checks.codecs.hevc_hvc1.canPlayType');
row('H.264 canPlayType', 'checks.codecs.h264_high.canPlayType');
row('WebCodecs decode HEVC/H.264', r => { const d = get(r, 'checks.codecs.webcodecsDecode'); return d ? `${d.hevc}/${d.h264}` : null; });
row('AV1 canPlayType L4.0 / L5.0', r => `${get(r, 'checks.codecs.av1_l40.canPlayType')} / ${get(r, 'checks.codecs.av1_l50.canPlayType')}`);
row('AV1 WebCodecs decode L4.0 / L5.0', r => `${get(r, 'checks.codecs.webcodecsDecode.av1_l40')} / ${get(r, 'checks.codecs.webcodecsDecode.av1_l50')}`);
for (const k of ['hevc60', 'h264_60', 'h264_150', 'av1_60', 'av1_150']) {
    row(`mediaCapabilities ${k} (sup/smooth/HW)`, r => { const m = get(r, `checks.codecs.mediaCapabilities.${k}`);
        return m ? (m.error ? 'ERR' : `${m.supported ? 'Y' : 'N'}/${m.smooth ? 'Y' : 'N'}/${m.powerEfficient ? 'Y' : 'N'}`) : null; });
}
row('WebCodecs encode H.264', 'checks.codecs.webcodecsEncode.h264');
const setNames = [...new Set([...received.values()].flatMap(r => Object.keys(r.checks || {}))
    .filter(k => k.includes(':')).map(k => k.split(':')[0]))];
for (const set of setNames) {
    for (const v of ['single-detached', 'all-detached', 'single-attached', 'all-attached']) {
        const key = `checks.${set}:${v}`;
        const P = v.startsWith('single') ? `${key}.play` : key;
        row(`${set} ${v}`, r => {
            const e = get(r, `${key}.error`); if (e) return 'ERR ' + e.slice(0, 40);
            const d = get(r, `${P}.distinctPerSec`); if (!d) return null;
            const avg = (a) => a && a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(0) : '-';
            return `ts ${avg(d.vfTs)} clk ${avg(d.clock)} rvfc ${avg(d.rvfc)} pix ${avg(d.pixels)}`;
        });
    }
    row(`${set} all-detached capture ms`, `checks.${set}:all-detached.videoFrameCapture.msPerRefresh`);
}
for (const k of ['hev1_real', 'av1_clip', 'h264_clip']) {
    row(`decoder: ${k}`, r => { const d = get(r, `checks.decoderErrors.${k}`); if (!d) return null;
        return d.loaded ? `loads (fps ${(+d.fps).toFixed(0)})` : (d.diagnosis ? `${d.diagnosis.kind}` : 'ERR ' + d.message.slice(0, 40)); });
}
row('app boots', r => { const a = get(r, 'checks.appBoot'); return a ? (a.booted ? `yes (${a.ms} ms)` : 'NO') : null; });
const w0 = Math.max(...rows.map(r => r[0].length));
const ws = BROWSERS.map((_, i) => Math.min(48, Math.max(BROWSERS[i].length, ...rows.map(r => String(r[i + 1]).length))));
console.log('\n' + 'check'.padEnd(w0) + '  ' + BROWSERS.map((b, i) => b.padEnd(ws[i])).join('  '));
for (const r of rows) console.log(r[0].padEnd(w0) + '  ' + r.slice(1).map((c, i) => String(c).slice(0, 48).padEnd(ws[i])).join('  '));
console.log(`\nreports: ${resultsDir}/*-${RUN}.json`);
server.close();
