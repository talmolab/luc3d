/**
 * _diag-calib-frame-invariance.mjs — capture TRACKING + TRIANGULATION under
 * two calibrations that differ only by a rigid change of world frame.
 *
 * Diagnostic (`_diag-`, excluded from suite runs). Run it once before a change
 * to `triangulatePointDLT` and once after, then diff the two JSON files: that
 * is what says whether a fix moved the trusted baseline and whether it made the
 * two frames agree.
 *
 * It drives the REAL `CrossViewTracker` and the REAL `triangulatePoints` from
 * the served app, over real 2D detections, so nothing here is a re-implementation.
 *
 * Records, for each calibration:
 *   - the tracker's per-frame cross-view grouping (FRESH detections only —
 *     `detsByCam` retains stale anchors, which are not this frame's decision)
 *   - 3D + per-point reprojection error for a FIXED grouping, so triangulation
 *     is measured independently of tracking
 *
 * Usage: OUT=/path/out.json PORT=8412 node _diag-calib-frame-invariance.mjs
 * Needs tempdata/calibtest/{dets.json,calibration.toml,calibration-rebased.toml}.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8412);
const OUT = process.env.OUT || path.join(repoRoot, 'tempdata', 'calibtest', 'capture.json');

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const result = await page.evaluate(async () => {
        const FIO = await import('/import-export/file-io.js');
        const PD  = await import('/pose/pose-data.js');
        const TRI = await import('/pose/triangulation.js');
        const CVT = await import('/pose/cross-view-tracker.js');

        const dets = await (await fetch('/tempdata/calibtest/dets.json')).json();
        const load = async (u) => {
            const cams = FIO.parseCalibrationTOML(await (await fetch(u)).text());
            const m = {}; cams.forEach(c => m[c.name] = c); return m;
        };
        const OLD = await load('/tempdata/calibtest/calibration.toml');
        const NEW = await load('/tempdata/calibtest/calibration-rebased.toml');
        const CAMS = ['back', 'backL', 'mid', 'midL', 'top', 'topL'];

        // ---- run the real tracker, recording the fresh grouping per frame ----
        function runTracker(cal) {
            const order = CAMS.map(n => cal[n]);
            const tracker = new CVT.CrossViewTracker({});
            const groups = [];
            for (let i = 0; i < dets.n; i++) {
                const f = dets.start + i;
                const m = new Map();
                for (const cn of CAMS) {
                    const rows = (dets.cams[cn] || {})[String(f)] || [];
                    m.set(cn, rows.map((r, slot) => new CVT.Detection(
                        new PD.Instance(r.pts, r.track, 'predicted', r.score), cal[cn], f, slot)));
                }
                tracker.trackFrame(m, order);
                const g = tracker.targets.map(t => {
                    const parts = [];
                    for (const [cn, d] of t.detsByCam) if (d.frameIdx === f) parts.push(cn + ':' + d.slot);
                    parts.sort(); return parts.join(',');
                }).filter(s => s.length).sort();
                groups.push(g);
            }
            return groups;
        }

        // ---- triangulate one group, exactly as _retriangulate does ----
        function triGroup(f, slots, cal) {
            const obs = [], ext = [], pix = [], cams = [];
            for (const s of slots) {
                const [cn, slot] = [s.slice(0, s.indexOf(':')), +s.slice(s.indexOf(':') + 1)];
                const r = dets.cams[cn][String(f)][slot];
                const cam = cal[cn];
                obs.push(r.pts.map(p => p ? CVT.normalizePoint(p, cam) : null));
                pix.push(r.pts); cams.push(cam); ext.push(cam.extrinsicMatrix);
            }
            const perNode = [];
            for (let k = 0; k < dets.nNodes; k++) perNode.push(obs.map(o => o[k]));
            const X = TRI.triangulatePoints(perNode, ext);
            const errs = [];
            for (let k = 0; k < dets.nNodes; k++) {
                const p = [X[3 * k], X[3 * k + 1], X[3 * k + 2]];
                if (!isFinite(p[0])) { errs.push(null); continue; }
                let se = 0, n = 0;
                for (let v = 0; v < cams.length; v++) {
                    const t = pix[v][k]; if (!t) continue;
                    const q = TRI.reprojectPoint(p, cams[v].projectionMatrix); if (!q) continue;
                    se += (q[0] - t[0]) ** 2 + (q[1] - t[1]) ** 2; n++;
                }
                errs.push(n ? +Math.sqrt(se / n).toFixed(4) : null);
            }
            return { X: Array.from(X, v => isFinite(v) ? +v.toFixed(4) : null), errs };
        }

        function triAll(groupsPerFrame, cal) {
            const out = [];
            for (let i = 0; i < groupsPerFrame.length; i++) {
                const f = dets.start + i;
                out.push(groupsPerFrame[i].map(g => triGroup(f, g.split(','), cal)));
            }
            return out;
        }

        const trackOld = runTracker(OLD);
        const trackNew = runTracker(NEW);
        // FIXED grouping (the old calibration's) for both, so triangulation is
        // isolated from tracking.
        const triOldFixed = triAll(trackOld, OLD);
        const triNewFixed = triAll(trackOld, NEW);
        // And each calibration with its OWN tracking, which is what a user sees.
        const triNewOwn = triAll(trackNew, NEW);

        return {
            frames: dets.n, start: dets.start, nNodes: dets.nNodes,
            trackOld, trackNew, triOldFixed, triNewFixed, triNewOwn,
        };
    });

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result));
    console.log('wrote', OUT, (fs.statSync(OUT).size / 1e6).toFixed(1) + ' MB');
    console.log('frames', result.frames);
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}
