/**
 * _diag-tail-bands.mjs — investigation tool, not a test. Track All on one per-camera
 * session folder, then, at sampled frames, read every identity's tail in every camera
 * from TTI to TailTip and dump the profiles (with where each tail node falls along
 * them) and straightened strips, to see where bands are and what each view shows.
 *   DIR=<session folder> OUT=<dir> ANIMALS=5 node tests/e2e/_diag-tail-bands.mjs
 *   env: PORT=9311  SAMPLES=300  STRIPS=16
 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = '/Users/soline/Desktop/luc3d/.claude/worktrees/vigorous-allen-82cd73';
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
    log('loaded; tracking');
    const res = await page.evaluate(async ({ animals, N }) => {
        const s = window.__lucid.state.session, st = window.__lucid.state, fps = st.fps || s.fps;
        const tr = await import('./pose/tracker.js');
        tr.setTrackerNumAnimals(animals); tr.setTailMarkedIdentity(null);
        let t = performance.now(); await tr.trackAll(); const trackMs = performance.now() - t;
        document.querySelectorAll('.track-summary-modal button').forEach((b) => { if (/close/i.test(b.textContent)) b.click(); });
        const tm = await import('./pose/tail-mark.js'), ic = await import('./pose/identity-cues.js');
        const { createTailMarkReader } = await import('./ui/tail-mark-reader.js');
        const emb = await import('./ui/image-embedder.js');
        const views = st.views.filter((v) => v.decoder);
        const frames = [...s.instanceGroups.keys()].sort((a, b) => a - b);
        const keys = await emb.keyframeIndices(views[0].decoder);
        const gaps = []; for (let i = 1; i < keys.length; i++) gaps.push(keys[i] - keys[i - 1]); gaps.sort((a, b) => a - b);
        const out = { trackMs, fps, nViews: views.length, size: [views[0].decoder.width, views[0].decoder.height], keyGapMedian: gaps[gaps.length >> 1], nKeys: keys.length };
        const sharp = Object.assign({}, tm.TAIL_BAND_READ);
        const samples = await createTailMarkReader(s, fps, sharp).plan(frames);
        out.samples = samples.length;
        const sub = samples.slice(0, N);
        // A: decode only
        t = performance.now();
        const rs = views.map((v) => emb.streamingReader(v.decoder, sub, sub));
        for (const f of sub) { const ims = await Promise.all(rs.map((r) => r.get(f))); ims.forEach((im) => im && im.close()); }
        rs.forEach((r) => r.close());
        out.decodeOnlyMs = performance.now() - t;
        const timeDecode = async (list, skip) => {
            const sk = skip ? await Promise.all(views.map((v) => emb.unreferencedSkipper(v.decoder))) : views.map(() => null);
            const count = { skipped: 0 };
            const a = performance.now();
            const rr = views.map((v, i) => emb.streamingReader(v.decoder, list, list, sk[i], count));
            for (const f of list) { const ims = await Promise.all(rr.map((r) => r.get(f))); ims.forEach((im) => im && im.close()); }
            rr.forEach((r) => r.close());
            return { ms: performance.now() - a, n: list.length, skipped: count.skipped, skipperOn: sk.filter(Boolean).length };
        };
        const span = sub[sub.length - 1];
        out.skipB = await timeDecode(sub, true);
        out.keyframesOnly = await timeDecode(Array.from(keys).filter((k) => k <= span), false);
        return out;
    }, { animals: ANIMALS, N: SAMPLES });
    log(JSON.stringify(res));
} finally {
    await browser.close();
    server.close();
}
