/**
 * _diag-cue-dump.mjs — investigation tool, not a test. Track All on one per-camera session
 * folder, then read every identity's tail (the band cue's `{wide, sharp}` reads) at every
 * keyframe AND one frame per second, and save them with the contacts, so the identity engine
 * can be replayed offline under any sampling rule (`tests/e2e/_diag-replay-identity-cues.mjs`).
 *   DIR=<session folder> OUT=<dir> ANIMALS=5 node tests/e2e/_diag-cue-dump.mjs
 *   writes OUT/index.json and OUT/features.f32 (per sample, per identity, per view: wide then sharp, 64 floats each; NaN = no sharp read)
 *   env: PORT=9311
 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 9311), OUT = process.env.OUT, DIR = process.env.DIR;
const ANIMALS = Number(process.env.ANIMALS || 5), SAMPLES = Number(process.env.SAMPLES || 300), STRIPS = Number(process.env.STRIPS || 16);
fs.mkdirSync(OUT, { recursive: true });
const log = (m) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(repoRoot, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(repoRoot)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
    });
}).listen(PORT);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    page.on('pageerror', (e) => log('pageerror ' + String(e).slice(0, 200)));
    page.on('console', (m) => { const t = m.text(); if (/TrackAll|tail/i.test(t)) log('console ' + t.slice(0, 300)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 120000 });
    await page.evaluate(async () => {
        const st = await import('./ui/settings.js');
        st.setTrackingThresholds({ autoSwitchCheck: 0, autoImageSwitchCheck: 0 });
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__dir';
        inp.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(inp);
        setInterval(() => { for (const b of document.querySelectorAll('button')) { const t = b.textContent.trim(); if ((t === 'Continue' || t === 'OK') && b.offsetParent !== null) b.click(); } }, 300);
    });
    await page.setInputFiles('#__dir', DIR);
    await page.evaluate(async () => {
        const sl = await import('./loading/session-loader.js');
        await sl.handleLoadSessionFolderPerCamera(Array.from(document.getElementById('__dir').files).filter((f) => !/(^|\/)\.|calibration_images/.test(f.webkitRelativePath || f.name)), false);
    });
    await page.waitForFunction(() => { const s = window.__lucid.state.session; return s && s.cameras && s.cameras.length > 1 && window.__lucid.state.views && window.__lucid.state.views.some((v) => v.decoder); }, null, { polling: 1000 });
    await new Promise((r) => setTimeout(r, 3000));
    let fd = fs.openSync(path.join(OUT, 'features.f32'), 'w');
    await page.exposeFunction('__dumpChunk', (b64) => { fs.writeSync(fd, Buffer.from(b64, 'base64')); });
    log('loaded; tracking');
    const index = await page.evaluate(async ({ animals }) => {
        const s = window.__lucid.state.session, st = window.__lucid.state, fps = st.fps || s.fps;
        const tr = await import('./pose/tracker.js');
        tr.setTrackerNumAnimals(animals); tr.setTailMarkedIdentity(null);
        await tr.trackAll();
        document.querySelectorAll('.track-summary-modal button').forEach((b) => { if (/close/i.test(b.textContent)) b.click(); });
        const tm = await import('./pose/tail-mark.js'), ic = await import('./pose/identity-cues.js');
        const { createTailMarkReader } = await import('./ui/tail-mark-reader.js');
        const emb = await import('./ui/image-embedder.js');
        const views = st.views.filter((v) => v.decoder);
        const frames = [...s.instanceGroups.keys()].sort((a, b) => a - b);
        const keys = Array.from(await emb.keyframeIndices(views[0].decoder)).filter((k) => k >= frames[0] && k <= frames[frames.length - 1]);
        const perSecond = tm.planTailMarkSamples(frames, null, fps);
        const samples = [...new Set(keys.concat(perSecond))].sort((a, b) => a - b);
        const idents = s.identities.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
        const ids = idents.map((i) => i.id);
        const reader = createTailMarkReader(s, fps, tm.TAIL_BAND_READ);
        const counts = [], L = 64;
        let buf = [], bufLen = 0;
        const flush = async () => {
            if (!bufLen) return;
            const all = new Float32Array(bufLen); let o = 0; for (const a of buf) { all.set(a, o); o += a.length; }
            const bytes = new Uint8Array(all.buffer); let t = '';
            for (let k = 0; k < bytes.length; k += 0x8000) t += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
            await window.__dumpChunk(btoa(t)); buf = []; bufLen = 0;
        };
        await reader.open(samples);
        try {
            for (let t = 0; t < samples.length; t++) {
                const r = await reader.next(samples[t]);
                const row = ids.map((id) => {
                    const f = (r && r.scores.get(id)) || [];
                    f.forEach((x) => {
                        const a = new Float32Array(2 * L); a.set(x.wide, 0);
                        if (x.sharp) a.set(x.sharp, L); else a.fill(NaN, L);
                        buf.push(a); bufLen += a.length;
                    });
                    return f.length;
                });
                counts.push(row);
                if (bufLen > 4e6) await flush();
            }
        } finally { reader.close(); }
        await flush();
        return { fps, names: idents.map((i) => i.name), ids, frames: [frames[0], frames[frames.length - 1], frames.length], dense: frames.length === frames[frames.length - 1] - frames[0] + 1,
            keyframes: keys, perSecond, samples, counts, L, contactRuns: ic.pairContactRuns(s, fps, ids) };
    }, { animals: ANIMALS });
    fs.closeSync(fd);
    fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
    log(`dumped ${index.samples.length} samples (${index.keyframes.length} keyframes, ${index.perSecond.length} per second)`);
} finally {
    await browser.close();
    server.close();
}
