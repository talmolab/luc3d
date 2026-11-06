/**
 * _real-tail-marks.mjs — Track All with tail marks on, on real per-camera session
 * folders, then a held-out check. Not a test (needs the recordings and real Chrome's
 * video decoders); no display needed. For each session writes one JSON to OUT:
 * what the pass read and swapped, and, on HELDOUT random frames it never read, how
 * many have the marks on the chosen identity after the swaps. Usage:
 *   DIRS=<file of folders> OUT=<dir> MARKED=id_0 node tests/e2e/_real-tail-marks.mjs
 *   env: HELDOUT=200  PORT=8170  LIMIT=<n>  SKIP=<n>  BROWSER_HEADLESS=0
 *        PAUSE_FILE=<path>: start no new session while this file exists
 *        EXTRA='{"<name>":[frames]}': also cut crops of these frames, with what each tail read
 *        SAVE=1: keep the automatic body-size ID-switch check on, and save each tracked project with File >
 *          Save As to <folder>/<folder name>_luc3d_tailmarks.slp (SAVE_DIR=<dir> puts them there instead).
 *          Written to a .partial name and renamed when complete; an existing file is never replaced.
 *        FORCE=1: a session refused as having no marks is run anyway, to look at it
 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 8170), HELDOUT = Number(process.env.HELDOUT || 200);
const MARKED = process.env.MARKED || 'id_0', OUT = process.env.OUT;
const MAX_CROPS = Number(process.env.MAX_CROPS || 12);
const EXTRA = JSON.parse(process.env.EXTRA || '{}');
const SAVE = !!process.env.SAVE;
const savePath = (dir) => path.join(process.env.SAVE_DIR || dir, path.basename(dir) + '_luc3d_tailmarks.slp');
const dirs = fs.readFileSync(process.env.DIRS, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
    .slice(Number(process.env.SKIP || 0), process.env.LIMIT ? Number(process.env.SKIP || 0) + Number(process.env.LIMIT) : undefined);
fs.mkdirSync(OUT, { recursive: true });
const log = (m) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);

// In-process, so it runs the same on a machine with no python3 on the PATH.
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
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-precise-memory-info'] });
try {
    for (const dir of dirs) {
        const name = path.basename(dir), dest = path.join(OUT, name + '.json');
        if (fs.existsSync(dest)) continue;
        if (SAVE && fs.existsSync(savePath(dir))) { log(`${name}: SKIPPED, ${savePath(dir)} already exists`); continue; }
        while (process.env.PAUSE_FILE && fs.existsSync(process.env.PAUSE_FILE)) await new Promise((r) => setTimeout(r, 15000));
        const page = await browser.newPage();
        page.setDefaultTimeout(0);
        page.on('pageerror', (e) => log('  pageerror ' + String(e).slice(0, 200)));
        // File > Save As streams here: a .partial file, renamed once the save completes
        let saveFd = null, saveBytes = 0;
        const partial = savePath(dir) + '.partial';
        if (SAVE) {
            await page.exposeFunction('__appendChunkBase64', (b64) => {
                if (saveFd === null) saveFd = fs.openSync(partial, 'w');
                const buf = Buffer.from(b64, 'base64');
                fs.writeSync(saveFd, buf); saveBytes += buf.length;
            });
        }
        try {
            await page.goto(`http://localhost:${PORT}/index.html`);
            await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 120000 });
            await page.evaluate(async (save) => {
                const st = await import('./ui/settings.js');
                st.setTrackingThresholds({ autoSwitchCheck: save ? 1 : 0, autoImageSwitchCheck: 0 });
                const inp = document.createElement('input');
                inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__dir';
                inp.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(inp);
                setInterval(() => { for (const b of document.querySelectorAll('button')) { const t = b.textContent.trim(); if ((t === 'Continue' || t === 'OK') && b.offsetParent !== null) b.click(); } }, 300);
            }, SAVE);
            await page.setInputFiles('#__dir', dir);
            const t0 = Date.now();
            await page.evaluate(async () => {
                const sl = await import('./loading/session-loader.js');
                await sl.handleLoadSessionFolderPerCamera(Array.from(document.getElementById('__dir').files).filter((f) => !/(^|\/)\.|calibration_images/.test(f.webkitRelativePath || f.name)), false);
            });
            await page.waitForFunction(() => { const s = window.__lucid.state.session; return s && s.cameras && s.cameras.length > 1 && window.__lucid.state.views && window.__lucid.state.views.some((v) => v.decoder); }, null, { polling: 1000 });
            await new Promise((r) => setTimeout(r, 3000));
            const res = await page.evaluate(async ({ marked, heldout, maxCrops, force, extra }) => {
                const s = window.__lucid.state.session;
                const tr = await import('./pose/tracker.js');
                tr.setTrackerNumAnimals(2);
                tr.setTailMarkedIdentity(marked);
                const t0 = performance.now();
                await tr.trackAll();
                const trackMs = performance.now() - t0;
                let r = s._tailMarkResult;
                document.querySelectorAll('.track-summary-modal button').forEach((b) => { if (/close/i.test(b.textContent)) b.click(); });
                const out = { trackMs, result: r, identities: s.identities.map((i) => i.name), status: document.getElementById('statusText').textContent };
                if (r && !r.ok && /no tail marks/.test(r.reason) && force) {
                    // refused for too little separation: look anyway, undoing nothing (the pass had changed nothing)
                    const tm = await import('./pose/tail-mark.js');
                    const rd = (await import('./ui/tail-mark-reader.js')).createTailMarkReader(s, window.__lucid.state.fps || s.fps);
                    out.refused = r;
                    r = out.result = await tm.resolveTailMarks(s, { markedName: marked, fps: window.__lucid.state.fps || s.fps, reader: rd, minTeachingSamples: 1, minTemplateDifference: 0 });
                }
                if (!r || !r.ok) return out;
                // held out: random frames the pass never read; do the marks sit on the chosen identity?
                const { createTailMarkReader } = await import('./ui/tail-mark-reader.js');
                const reader = createTailMarkReader(s, window.__lucid.state.fps || s.fps);
                const target = s.identities.find((i) => i.name === marked).id, other = s.identities.find((i) => i.name !== marked).id;
                const frames = [...s.instanceGroups.keys()];
                const tm0 = await import('./pose/tail-mark.js');
                const tpl = { marked: Float32Array.from(r.marked), plain: Float32Array.from(r.plain) };
                let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
                const rows = [];
                for (let i = 0; i < heldout; i++) {
                    const f = frames[Math.floor(rnd() * frames.length)];
                    const e = await reader.at(f);
                    const vt = (e.scores.get(target) || []).map((x) => tm0.tailVote(x, tpl)), vo = (e.scores.get(other) || []).map((x) => tm0.tailVote(x, tpl));
                    rows.push([f, vt.reduce((a, v) => a + v, 0), vo.reduce((a, v) => a + v, 0), vt, vo]);
                }
                out.heldout = rows;
                // an independent check that uses no tail marks: each animal's body size per 30 s, from the 3D.
                const { SIZE_BONES } = await import('./pose/id-switch-check.js');
                const { readPoint3d } = await import('./pose/pose-data.js');
                const names = s.skeleton.nodes.map((n) => (typeof n === 'string' ? n : n.name));
                const bones = SIZE_BONES.filter((b) => names.includes(b[0]) && names.includes(b[1])).map((b) => [names.indexOf(b[0]), names.indexOf(b[1])]);
                const fps = window.__lucid.state.fps || s.fps, binLen = Math.round(30 * fps), bins = new Map();
                const p = [0, 0, 0], q = [0, 0, 0];
                frames.sort((a, b) => a - b);
                for (let i = 0; i < frames.length; i += 15) {
                    for (const g of s.instanceGroups.get(frames[i]) || []) {
                        if (!g.points3d) continue;
                        let sum = 0, n = 0;
                        for (const [a, b] of bones) if (readPoint3d(g.points3d, a, p) && readPoint3d(g.points3d, b, q)) { sum += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); n++; }
                        if (n < bones.length * 0.75) continue;
                        const k = Math.floor(frames[i] / binLen) + (g.identityId === target ? 'T' : 'O');
                        if (!bins.has(k)) bins.set(k, []);
                        bins.get(k).push(sum / n);
                    }
                }
                // what to look at: both sides of each label change, and held-out frames the wrong animal won.
                const wanted = [];
                r.runs.slice(1).forEach((run) => { wanted.push(['change', run.frame - Math.round(0.5 * fps)], ['change', run.frame + Math.round(0.5 * fps)]); });
                rows.filter((x) => x[2] > x[1] + 1).forEach((x) => wanted.push(['wrong', x[0]]));
                out.crops = [];
                const views = window.__lucid.state.views.filter((v) => v.decoder);
                const tti = names.indexOf('TTI'), R = 56;
                const toCut = wanted.slice(0, maxCrops).concat(extra.map((f) => ['extra', f]));
                out.extraReads = [];
                for (const [kind, f] of toCut) {
                    if (!s.instanceGroups.has(f)) continue;
                    const sheet = new OffscreenCanvas(views.length * (2 * R + 2), 2 * (2 * R + 2) + 14), g2 = sheet.getContext('2d');
                    g2.fillStyle = '#400'; g2.fillRect(0, 0, sheet.width, sheet.height);
                    g2.fillStyle = '#fff'; g2.font = '11px sans-serif';
                    g2.fillText(kind + ' f' + f + '  top: ' + marked + '  bottom: other', 2, 11);
                    const images = await Promise.all(views.map((v) => v.decoder.getFrame(f)));
                    if (kind === 'extra') {
                        const tailMod = await import('./pose/tail-mark.js');
                        const rows2 = [];
                        const cv = new OffscreenCanvas(images[0].displayWidth || images[0].width, images[0].displayHeight || images[0].height), c2 = cv.getContext('2d', { willReadFrequently: true });
                        const { hydrateFrameMembers2d: h2, releaseFrameMembers2d: r2 } = await import('./pose/lazy-residency.js');
                        const hy = h2(s, f) > 0;
                        images.forEach((img, vi) => {
                            c2.drawImage(img, 0, 0);
                            const d3 = c2.getImageData(0, 0, cv.width, cv.height).data, gray = new Uint8Array(cv.width * cv.height);
                            for (let k = 0; k < gray.length; k++) gray[k] = d3[k * 4 + 1];
                            (s.instanceGroups.get(f) || []).forEach((grp) => {
                                const inst = grp.instances && grp.instances.get(views[vi].cameraName || views[vi].name);
                                if (!inst) return;
                                const poly = [];
                                ['TTI', 'Tail_0', 'Tail_1'].forEach((n) => { const q3 = inst.getPoint(names.indexOf(n)); poly.push(q3 ? q3[0] : NaN, q3 ? q3[1] : NaN); });
                                const pr = tailMod.readTailProfile(gray, cv.width, cv.height, poly);
                                rows2.push({ view: vi, who: grp.identityId === target ? 'T' : 'O', poly: poly.map((v) => Math.round(v)), bg: pr && Math.round(pr.background), score: pr && +tailMod.tailBandScore(tailMod.normalizeTailProfile(pr.profile, pr.background)).toFixed(3), profile: pr && Array.from(pr.profile).map((v) => Math.round(v)) });
                            });
                        });
                        // straightened tails, magnified: faint bands show here when they do not in a crop
                        const SC = 4, HW = 7, stripW = 90;
                        const strips = new OffscreenCanvas(views.length * (stripW * SC + 4), 2 * ((2 * HW + 1) * SC + 4) + 14), g3 = strips.getContext('2d');
                        g3.fillStyle = '#123'; g3.fillRect(0, 0, strips.width, strips.height);
                        g3.fillStyle = '#fff'; g3.font = '11px sans-serif'; g3.fillText('f' + f + ' straightened TTI->Tail_1, top: ' + marked + ', bottom: other', 2, 11);
                        images.forEach((img, vi) => {
                            c2.drawImage(img, 0, 0);
                            const d4 = c2.getImageData(0, 0, cv.width, cv.height).data;
                            (s.instanceGroups.get(f) || []).forEach((grp) => {
                                const inst = grp.instances && grp.instances.get(views[vi].cameraName || views[vi].name);
                                if (!inst) return;
                                const P = ['TTI', 'Tail_0', 'Tail_1'].map((n) => inst.getPoint(names.indexOf(n))).filter((q4) => q4 && isFinite(q4[0]));
                                if (P.length < 2) return;
                                const segs = []; let tot = 0;
                                for (let k = 1; k < P.length; k++) { const L = Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]); segs.push(L); tot += L; }
                                const row = grp.identityId === target ? 0 : 1;
                                const im = new ImageData(stripW, 2 * HW + 1);
                                for (let u = 0; u < stripW; u++) {
                                    let t2 = u / (stripW - 1) * tot, k = 0;
                                    while (k < segs.length - 1 && t2 > segs[k]) { t2 -= segs[k]; k++; }
                                    const a = P[k], b = P[k + 1], L = segs[k] || 1, dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L;
                                    const cx = a[0] + dx * t2, cy = a[1] + dy * t2;
                                    for (let o = -HW; o <= HW; o++) {
                                        const ix = Math.round(cx - dy * o), iy = Math.round(cy + dx * o), q5 = ((o + HW) * stripW + u) * 4;
                                        const g = (ix >= 0 && iy >= 0 && ix < cv.width && iy < cv.height) ? d4[(iy * cv.width + ix) * 4 + 1] : 0;
                                        im.data[q5] = im.data[q5 + 1] = im.data[q5 + 2] = g; im.data[q5 + 3] = 255;
                                    }
                                }
                                const tmp = new OffscreenCanvas(stripW, 2 * HW + 1); tmp.getContext('2d').putImageData(im, 0, 0);
                                g3.imageSmoothingEnabled = false;
                                g3.drawImage(tmp, vi * (stripW * SC + 4), 14 + row * ((2 * HW + 1) * SC + 4), stripW * SC, (2 * HW + 1) * SC);
                            });
                        });
                        const sb = await strips.convertToBlob({ type: 'image/png' });
                        const sbytes = new Uint8Array(await sb.arrayBuffer());
                        let sbin = ''; for (let b5 = 0; b5 < sbytes.length; b5++) sbin += String.fromCharCode(sbytes[b5]);
                        out.crops.push({ kind: 'strip', frame: f, png: btoa(sbin) });
                        if (hy) r2(s, f);
                        out.extraReads.push({ frame: f, rows: rows2 });
                    }
                    const { hydrateFrameMembers2d, releaseFrameMembers2d } = await import('./pose/lazy-residency.js');
                    const hyd = hydrateFrameMembers2d(s, f) > 0;
                    images.forEach((img, vi) => {
                        (s.instanceGroups.get(f) || []).forEach((grp) => {
                            const inst = grp.instances && grp.instances.get(views[vi].cameraName || views[vi].name);
                            const p0 = inst && inst.getPoint(tti);
                            if (!p0 || !img) return;
                            const row = grp.identityId === target ? 0 : 1, x = vi * (2 * R + 2), y = 14 + row * (2 * R + 2);
                            g2.drawImage(img, p0[0] - R, p0[1] - R, 2 * R, 2 * R, x, y, 2 * R, 2 * R);
                            ['TTI', 'Tail_0', 'Tail_1'].forEach((n) => {
                                const q2 = inst.getPoint(names.indexOf(n));
                                if (!q2) return;
                                g2.strokeStyle = '#f33'; g2.beginPath(); g2.arc(q2[0] - p0[0] + R + x, q2[1] - p0[1] + R + y, 1.5, 0, 7); g2.stroke();
                            });
                        });
                    });
                    if (hyd) releaseFrameMembers2d(s, f);
                    const blob = await sheet.convertToBlob({ type: 'image/png' });
                    const bytes = new Uint8Array(await blob.arrayBuffer());
                    let bin = ''; for (let b2 = 0; b2 < bytes.length; b2++) bin += String.fromCharCode(bytes[b2]);
                    out.crops.push({ kind, frame: f, png: btoa(bin) });
                }
                out.size = Object.fromEntries([...bins].map(([k, v]) => { v.sort((a, b) => a - b); return [k, v[v.length >> 1]]; }));
                return out;
            }, { marked: MARKED, heldout: HELDOUT, maxCrops: MAX_CROPS, force: !!process.env.FORCE, extra: EXTRA[name] || [] });
            if (SAVE && res.result && res.result.ok) {
                const sv = await page.evaluate(async () => {
                    const s = window.__lucid.state.session;
                    // what the ID Switches tab will list when the project is opened
                    const { idSwitchMarkers } = await import('./ui/id-switch-review.js');
                    const r2 = s._idSwitch && s._idSwitch.results && s._idSwitch.results.size;
                    const sizeFlags = r2 && r2.ok ? idSwitchMarkers(r2).map((m) => [m.frame, m.kind || '']) : null;
                    const saveLoad = await import('./import-export/save-load.js');
                    const toB64 = (bytes) => { let t = ''; for (let o = 0; o < bytes.length; o += 0x8000) t += String.fromCharCode.apply(null, bytes.subarray(o, o + 0x8000)); return btoa(t); };
                    window.showSaveFilePicker = async () => ({
                        createWritable: async () => ({
                            write: async (chunk) => { await window.__appendChunkBase64(toB64(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer || chunk))); },
                            close: async () => {},
                        }),
                    });
                    let err = null;
                    try { await saveLoad.saveAs({ skipSizeWarning: true }); } catch (e) { err = String(e && e.stack || e).slice(0, 400); }
                    return { err, dirty: window.__lucid.state.isDirty, sizeFlags, sizeCheck: r2 ? (r2.ok ? 'ok' : r2.reason) : 'not run' };
                });
                if (saveFd !== null) { fs.closeSync(saveFd); saveFd = null; }
                res.save = Object.assign(sv, { bytes: saveBytes });
                if (!sv.err && !sv.dirty && saveBytes > 1e6) { fs.renameSync(partial, savePath(dir)); res.save.path = savePath(dir); }
                else { try { fs.unlinkSync(partial); } catch (e) { /* none written */ } res.save.failed = true; }
            }
            res.dir = dir; res.totalMs = Date.now() - t0;
            (res.crops || []).forEach((c) => {
                fs.mkdirSync(path.join(OUT, 'crops'), { recursive: true });
                fs.writeFileSync(path.join(OUT, 'crops', `${name}_${c.kind}_${c.frame}.png`), Buffer.from(c.png, 'base64'));
                delete c.png;
            });
            fs.writeFileSync(dest, JSON.stringify(res));
            const r = res.result;
            const ho = res.heldout || [];
            const conf = ho.filter((x) => r && Math.abs(x[1] - x[2]) > 1);
            log(`${name}: ${r && r.ok ? `swapped ${r.swapped}, changes ${r.changes}, samples ${r.samples}+${r.reads}, perView ${r.perView.toFixed(2)}, templates ${r.difference.toFixed(3)} from ${r.teaching}, pass ${(r.elapsedMs / 1000).toFixed(1)} s; held out ${conf.filter((x) => x[1] > x[2]).length}/${conf.length} confident (${ho.length})` : 'NOT RUN: ' + (r && r.reason)}; track+pass ${(res.trackMs / 1000).toFixed(0)} s;${res.save ? (res.save.path ? ` saved ${(res.save.bytes / 1e6).toFixed(0)} MB,` : ` SAVE FAILED ${res.save.err || (res.save.dirty ? 'still dirty' : 'empty')},`) : ''} total ${(res.totalMs / 1000).toFixed(0)} s`);
        } catch (e) {
            log(`${name}: FAILED ${String(e).slice(0, 300)}`);
        } finally { await page.close(); }
    }
} finally {
    await browser.close();
    server.close();
}
