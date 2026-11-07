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
    log('loaded; tracking');
    const t0 = Date.now();
    await page.evaluate(async (animals) => {
        const tr = await import('./pose/tracker.js');
        tr.setTrackerNumAnimals(animals);
        tr.setTailMarkedIdentity(null);
        await tr.trackAll();
        document.querySelectorAll('.track-summary-modal button').forEach((b) => { if (/close/i.test(b.textContent)) b.click(); });
    }, ANIMALS);
    log(`tracked in ${((Date.now() - t0) / 1000).toFixed(0)} s; reading tails`);
    const res = await page.evaluate(async ({ nSamples, nStrips }) => {
        const s = window.__lucid.state.session;
        const tm = await import('./pose/tail-mark.js');
        const { hydrateFrameMembers2d, releaseFrameMembers2d } = await import('./pose/lazy-residency.js');
        const names = s.skeleton.nodes.map((n) => (typeof n === 'string' ? n : n.name));
        const chain = ['TTI', 'Tail_0', 'Tail_1', 'Tail_2', 'TailTip'].map((n) => names.indexOf(n));
        const views = window.__lucid.state.views.filter((v) => v.decoder);
        const cams = views.map((v) => v.cameraName || v.name);
        const frames = [...s.instanceGroups.keys()].sort((a, b) => a - b);
        const picks = [];
        for (let i = 0; i < nSamples; i++) picks.push(frames[Math.floor((i + 0.5) * frames.length / nSamples)]);
        const idName = new Map(s.identities.map((i) => [i.id, i.name]));
        const rows = [], strips = [];
        let cv = null, c2 = null;
        const L = 96;
        const VARIANTS = [[0, 0.85, 1 / 20], [0, 0.6, 1 / 12], [0, 0.6, 1 / 20], [0, 0.5, 1 / 30], [0.2, 0.6, 1 / 20], [0.2, 0.5, 1 / 30]];
        for (let pi = 0; pi < picks.length; pi++) {
            const f = picks[pi];
            const images = await Promise.all(views.map((v) => Promise.resolve(v.decoder.getFrame(f)).catch(() => null)));
            const hy = hydrateFrameMembers2d(s, f) > 0;
            const groups = (s.instanceGroups.get(f) || []).filter((g) => g.identityId != null);
            const wantStrip = pi % Math.max(1, Math.floor(nSamples / nStrips)) === 0;
            const SC = 3, HW = 8, SW = 120;
            let sheet = null, g3 = null;
            if (wantStrip) {
                sheet = new OffscreenCanvas(views.length * (SW * SC + 6), groups.length * ((2 * HW + 1) * SC + 14) + 16);
                g3 = sheet.getContext('2d'); g3.fillStyle = '#123'; g3.fillRect(0, 0, sheet.width, sheet.height);
                g3.fillStyle = '#fff'; g3.font = '12px sans-serif';
                g3.fillText('f' + f + '  TTI → TailTip, ticks at Tail_0/1/2; columns: ' + cams.join(' | '), 2, 12);
            }
            images.forEach((img, vi) => {
                if (!img) return;
                const iw = img.displayWidth || img.width, ih = img.displayHeight || img.height;
                if (!cv) { cv = new OffscreenCanvas(iw, ih); c2 = cv.getContext('2d', { willReadFrequently: true }); }
                else if (cv.width !== iw || cv.height !== ih) { cv.width = iw; cv.height = ih; }
                c2.drawImage(img, 0, 0);
                const d = c2.getImageData(0, 0, iw, ih).data, gray = new Uint8Array(iw * ih);
                for (let k = 0; k < gray.length; k++) gray[k] = (77 * d[k * 4] + 150 * d[k * 4 + 1] + 29 * d[k * 4 + 2]) >> 8;
                groups.forEach((grp, gi) => {
                    const inst = grp.instances && grp.instances.get(cams[vi]);
                    if (!inst) return;
                    const pts = chain.map((n) => { const q = n >= 0 ? inst.getPoint(n) : null; return q && isFinite(q[0]) ? [q[0], q[1]] : null; });
                    // the arc length at each node (null when missing)
                    const at = [0]; let tot = 0, last = pts[0];
                    for (let k = 1; k < pts.length; k++) {
                        if (!pts[k] || !last) { at.push(null); if (pts[k]) last = null; continue; }
                        tot += Math.hypot(pts[k][0] - last[0], pts[k][1] - last[1]); at.push(tot); last = pts[k];
                    }
                    const poly = []; pts.forEach((p) => poly.push(p ? p[0] : NaN, p ? p[1] : NaN));
                    // full TTI..TailTip (stopping at the first missing node)
                    const firstMissing = pts.findIndex((p) => !p);
                    const full = firstMissing < 0 ? poly : poly.slice(0, 2 * firstMissing);
                    const pr = full.length >= 4 ? tm.readTailProfile(gray, iw, ih, full, L) : null;
                    const x = pr ? tm.normalizeTailProfile(pr.profile, pr.background) : null;
                    // what the pass reads now: TTI..Tail_1
                    const pr1 = pts[0] && pts[1] ? tm.readTailProfile(gray, iw, ih, poly.slice(0, pts[2] ? 6 : 4)) : null;
                    const x1 = pr1 ? tm.normalizeTailProfile(pr1.profile, pr1.background) : null;
                    // the same, started a share of TTI..Tail_0 before TTI (away from Tail_0)
                    // variants: extension before TTI (share of TTI..Tail_0), percentile across, half width share
                    const ext = {};
                    if (pts[0] && pts[1]) {
                        VARIANTS.forEach(([e, q, w]) => {
                            const bx = pts[0][0] + e * (pts[0][0] - pts[1][0]), by = pts[0][1] + e * (pts[0][1] - pts[1][1]);
                            const pe = tm.readTailProfile(gray, iw, ih, (e ? [bx, by] : []).concat(poly.slice(0, pts[2] ? 6 : 4)), undefined, { percentile: q, widthShare: w });
                            const xe = pe ? tm.normalizeTailProfile(pe.profile, pe.background) : null;
                            ext[`v${e}_${q}_${w.toFixed(3)}`] = xe ? Array.from(xe, (v) => +v.toFixed(3)) : null;
                        });
                    }
                    rows.push(Object.assign({ f, cam: vi, id: idName.get(grp.identityId), at, raw: pr ? Array.from(pr.profile, (v) => Math.round(v)) : null, bg: pr ? Math.round(pr.background) : null,
                        x: x ? Array.from(x, (v) => +v.toFixed(3)) : null, x1: x1 ? Array.from(x1, (v) => +v.toFixed(3)) : null }, ext));
                    if (sheet && pts[0] && pts[1]) {
                        const P = pts.slice(0, firstMissing < 0 ? pts.length : firstMissing);
                        const segs = []; let T = 0;
                        for (let k = 1; k < P.length; k++) { const l = Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]); segs.push(l); T += l; }
                        const im = new ImageData(SW, 2 * HW + 1);
                        for (let u = 0; u < SW; u++) {
                            let t2 = u / (SW - 1) * T, k = 0;
                            while (k < segs.length - 1 && t2 > segs[k]) { t2 -= segs[k]; k++; }
                            const a = P[k], b = P[k + 1], l = segs[k] || 1, dx = (b[0] - a[0]) / l, dy = (b[1] - a[1]) / l;
                            const cx = a[0] + dx * t2, cy = a[1] + dy * t2;
                            for (let o = -HW; o <= HW; o++) {
                                const ix = Math.round(cx - dy * o), iy = Math.round(cy + dx * o), q5 = ((o + HW) * SW + u) * 4;
                                const g = (ix >= 0 && iy >= 0 && ix < iw && iy < ih) ? gray[iy * iw + ix] : 0;
                                im.data[q5] = im.data[q5 + 1] = im.data[q5 + 2] = g; im.data[q5 + 3] = 255;
                            }
                        }
                        const tmp = new OffscreenCanvas(SW, 2 * HW + 1); tmp.getContext('2d').putImageData(im, 0, 0);
                        g3.imageSmoothingEnabled = false;
                        const ox = vi * (SW * SC + 6), oy = 16 + gi * ((2 * HW + 1) * SC + 14);
                        g3.fillStyle = '#ff0'; g3.fillText(idName.get(grp.identityId) + ' ' + Math.round(T) + 'px', ox + 2, oy + 11);
                        g3.drawImage(tmp, ox, oy + 13, SW * SC, (2 * HW + 1) * SC);
                        g3.fillStyle = '#f33';
                        at.forEach((a, k) => { if (a != null && k > 0 && T > 0 && a <= T) g3.fillRect(ox + a / T * SW * SC - 1, oy + 13, 2, 6); });
                    }
                });
            });
            if (hy) releaseFrameMembers2d(s, f);
            if (sheet) {
                const blob = await sheet.convertToBlob({ type: 'image/png' });
                const bytes = new Uint8Array(await blob.arrayBuffer());
                let bin = ''; for (let o = 0; o < bytes.length; o += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(o, o + 0x8000));
                strips.push({ f, png: btoa(bin) });
            }
        }
        return { cams, identities: s.identities.map((i) => i.name), rows, strips };
    }, { nSamples: SAMPLES, nStrips: STRIPS });
    fs.mkdirSync(path.join(OUT, 'strips'), { recursive: true });
    res.strips.forEach((st) => fs.writeFileSync(path.join(OUT, 'strips', `f${st.f}.png`), Buffer.from(st.png, 'base64')));
    delete res.strips;
    fs.writeFileSync(path.join(OUT, 'tails.json'), JSON.stringify(res));
    log(`wrote ${res.rows.length} tail reads`);
} finally {
    await browser.close();
    server.close();
}
