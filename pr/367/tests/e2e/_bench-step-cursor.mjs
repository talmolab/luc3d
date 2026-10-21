/**
 * _bench-step-cursor.mjs — how long a PAUSED frame takes to appear in every view
 * when stepping / jumping, with and without the open stepping stream
 * (loading/video.js `OnDemandVideoDecoder._mbGetFrame`, `LUCID_STEP_CURSOR`).
 *
 * Opens every .mp4 of a folder as an OnDemandVideoDecoder (the app's decoder, cache 60 as in the app,
 * mediabunny backend) and times "all views show frame f" for: single forward
 * steps (arrow key), single back steps beyond anything shown, random jumps, and
 * a held arrow key (steps requested back-to-back). Each scenario runs with the
 * cursor off (LUCID_STEP_CURSOR = 0: today's fresh decode per frame) and on.
 * Also checks every stepped frame is pixel-identical between the two. Then holds
 * the LEFT arrow (72 steps back) for each back-step chunk size
 * (`LUCID_STEP_BACK_CHUNK`, `_decodeBackChunk`): per-step latency, steps/s, the
 * frame cache's peak size, and pixels vs no chunking.
 *
 * Not a test (needs HEVC: real Google Chrome, headed). Usage:
 *     DIRS=<dir>[,<dir>…] node tests/e2e/_bench-step-cursor.mjs
 *   env: PORT=8134
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DIRS = (process.env.DIRS || '').split(',').filter(Boolean);
const PORT = Number(process.env.PORT || 8134);
if (!DIRS.length) { console.error('set DIRS'); process.exit(2); }
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
// a visible browser window: one such run at a time across sessions (scripts/browser-lock.mjs)
const releaseBrowserLock = await acquireBrowserLock({ label: '_bench-step-cursor' });
let browser;
try {
    browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--window-size=900,600'] });
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.SleapIO && window.SleapIO.MediaBunnyVideoBackend, null, { timeout: 30000 });
    await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = '__v'; document.body.appendChild(i); });
    for (const dir of DIRS) {
        await page.setInputFiles('#__v', fs.readdirSync(dir).filter(f => f.endsWith('.mp4')).sort().map(f => path.join(dir, f)));
        const r = await page.evaluate(async () => {
            const { OnDemandVideoDecoder } = await import('./loading/video.js');
            const decs = [];
            for (const f of document.getElementById('__v').files) { const d = new OnDemandVideoDecoder({ cacheSize: window.__CACHE || 60 }); await d.init(f); decs.push(d); }
            const n = decs[0].samples.length;
            const clear = () => decs.forEach(d => { d.releaseStepCursor(); d._mbBackend.cache.forEach(b => b.close()); d._mbBackend.cache.clear(); });
            const show = async (f) => { const t = performance.now(); const bms = await Promise.all(decs.map(d => d.getFrame(f))); return { ms: performance.now() - t, bms }; };
            const px = (bm) => { const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height).data; };
            const med = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
            const p90 = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)]; };
            const out = {}, firstPx = {};
            for (const mode of ['off', 'on']) {
                window.LUCID_STEP_CURSOR = mode === 'off' ? 0 : undefined;
                let seed = 5; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
                clear(); await show(400);
                const fwd = [], back = [], jump = [], held = [];
                let same = 0, compared = 0;
                for (let k = 0; k < 4; k++) {
                    const s = 600 + Math.floor(rnd() * (n - 1200));
                    clear(); await show(s);                          // land somewhere (e.g. a flagged switch)…
                    for (let i = 1; i <= 20; i++) {                  // …then step forward through it
                        const { ms, bms } = await show(s + i); fwd.push(ms);
                        if (k === 0 && i <= 5) {                     // pixels: on vs off, camera 0
                            const key = s + i, p = px(bms[0]);
                            if (mode === 'off') firstPx[key] = p; else { compared++; if (firstPx[key] && firstPx[key].every((v, j) => v === p[j])) same++; }
                        }
                        await new Promise(r => setTimeout(r, 30));   // a person pressing the key
                    }
                    for (let i = 1; i <= 10; i++) back.push((await show(s - i)).ms);   // back past where we landed: not cached
                }
                for (let i = 0; i < 20; i++) { clear(); jump.push((await show(Math.floor(rnd() * (n - 1)))).ms); }
                const s2 = 600 + Math.floor(rnd() * (n - 1200)); clear(); await show(s2);
                const t0 = performance.now(); for (let i = 1; i <= 60; i++) await show(s2 + i); held.push(60 / ((performance.now() - t0) / 1000));
                out[mode] = { fwd: [med(fwd), p90(fwd)], back: [med(back), p90(back)], jump: [med(jump), p90(jump)], heldFps: held[0], same, compared };
            }
            // held LEFT arrow: 72 steps back from a mid-recording frame — as fast as frames come (throughput),
            // and paced at 30 steps/s (a key's auto-repeat: a step taking > 50 ms is a visible hitch)
            window.LUCID_STEP_CURSOR = undefined;
            out.back = {};
            const s3 = 2000;
            const refPx = {};
            const variants = window.__BACK_VARIANTS || [['off', 0, 0], ['chunk 24', 24, 0], ['chunk 24 + prefetch', 24, 1]];
            for (const [label, chunk, prefetch] of variants) {
                window.LUCID_STEP_BACK_CHUNK = chunk;
                window.LUCID_STEP_BACK_PREFETCH = prefetch ? undefined : 0;
                const res = {};
                for (const paced of [false, true]) {
                    clear(); decs.forEach(d => { d._lastStepFrame = null; });
                    await show(s3); await new Promise(r => setTimeout(r, 1500));   // settle (no prefetch in flight)
                    const per = []; let same = 0, compared = 0;
                    const t0 = performance.now();
                    for (let i = 1; i <= 72; i++) {
                        const ts0 = performance.now();
                        const { ms, bms } = await show(s3 - i); per.push(ms);
                        if (!paced && i % 9 === 0) {                     // pixels vs no chunking, camera 0
                            const p = px(bms[0]);
                            if (chunk === 0) refPx[i] = p; else { compared++; if (refPx[i] && refPx[i].every((v, j) => v === p[j])) same++; }
                        }
                        if (paced) { const wait = 1000 / 30 - (performance.now() - ts0); if (wait > 0) await new Promise(r => setTimeout(r, wait)); }
                    }
                    const total = performance.now() - t0;
                    res[paced ? 'paced' : 'fast'] = { med: med(per), p90: p90(per), max: Math.max(...per), stepsPerS: 72 / (total / 1000),
                        hitches: per.filter(x => x > 50).length, hitchAt: per.map((x, i) => x > 50 ? `#${i + 1}:${Math.round(x)}ms` : null).filter(Boolean), same, compared };
                }
                res.peakFrames = decs.reduce((a, d) => a + d._mbBackend.cache.size, 0);
                out.back[label] = res;
            }
            window.LUCID_STEP_BACK_PREFETCH = undefined;
            window.LUCID_STEP_BACK_CHUNK = undefined;
            decs.forEach(d => d.close());
            return out;
        });
        const f = (a) => `${Math.round(a[0])} ms (p90 ${Math.round(a[1])})`;
        console.log(`\n• ${path.basename(dir)}`);
        for (const m of ['off', 'on']) console.log(`  cursor ${m.padEnd(3)}: step forward ${f(r[m].fwd)} · step back ${f(r[m].back)} · jump ${f(r[m].jump)} · held key ${r[m].heldFps.toFixed(1)} frames/s`);
        console.log(`  stepped frames pixel-identical on vs off: ${r.on.same}/${r.on.compared}`);
        console.log('  held left arrow, 72 steps back (all views):');
        for (const [label, b] of Object.entries(r.back)) {
            const f = b.fast, p = b.paced;
            console.log(`    ${label.padEnd(20)} as fast as possible: ${f.stepsPerS.toFixed(1)} steps/s, worst ${Math.round(f.max)} ms · ` +
                `at 30 steps/s: ${p.hitches} of 72 steps > 50 ms [${p.hitchAt.slice(0, 8).join(' ')}] (achieved ${p.stepsPerS.toFixed(1)}/s) · cache ${b.peakFrames} frames` +
                (f.compared ? ` · pixel-identical ${f.same}/${f.compared}` : ''));
        }
    }
} finally {
    if (browser) await browser.close().catch(() => {});
    await releaseBrowserLock();
    server.kill();
}
