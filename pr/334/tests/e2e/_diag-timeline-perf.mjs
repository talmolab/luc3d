/**
 * _diag-timeline-perf.mjs — timing diagnostic (no browser UI clicking).
 *
 * Measures how long `_buildIdentitySegments` (via setDisplayMode('identities'))
 * takes when session.frameIdentityMap is large, to check whether the new
 * frameIdentityMap fallback pass (added for the ID-Timeline lazy-loading fix)
 * is the source of user-reported lag when switching to Identities view.
 *
 * Run: node tests/e2e/_diag-timeline-perf.mjs   (with the app served on :8080)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const repoRoot = '/root/vast/eric/sleap-3d-gui/scratch/repos/lucid';
const PORT = Number(process.env.PORT || 8084);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    for (const NF of [1000, 10000, 50000, 100000]) {
        const r = await page.evaluate(async (NF) => {
            const pd = await import('/pose/pose-data.js');
            const initMod = await import('/pose/initialization.js');
            const AS = await import('/ui/app-state.js');
            const { Skeleton, Camera, Session } = pd;

            const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
            const cams = [
                new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 40], [640, 480]),
                new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.2, 0], [-8, 0, 42], [640, 480]),
            ];
            const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
            const session = new Session(cams, skel, ['track_0'], 'PerfTest');
            session.addIdentity('Red');
            const redId = session.identities[0].id;

            // Directly populate frameIdentityMap (skip real SLP I/O — isolates
            // JUST the timeline-rebuild cost, not save/load overhead).
            const t0build = performance.now();
            for (let f = 0; f < NF; f++) {
                session.frameIdentityMap.set(f + ':camA:0', redId);
                session.frameIdentityMap.set(f + ':camB:0', redId);
            }
            const buildMs = performance.now() - t0build;

            if (!window.__lucid.timeline) initMod.setupTimeline();
            const timeline = window.__lucid.timeline;

            AS.state.sessions = [session];
            AS.state.activeSessionIdx = 0;
            AS.state.session = session;
            AS.state.totalFrames = NF;

            const t0setData = performance.now();
            timeline.setData(session);
            const setDataMs = performance.now() - t0setData;

            const t0mode = performance.now();
            timeline.setDisplayMode('identities');
            const modeMs = performance.now() - t0mode;

            // Second call (same mode) — isolates any one-time vs per-call cost.
            const t0mode2 = performance.now();
            timeline.setDisplayMode('identities');
            const modeMs2 = performance.now() - t0mode2;

            const rowCount = (timeline._trackSegments || []).length;
            return { NF, buildMs, setDataMs, modeMs, modeMs2, rowCount, mapSize: session.frameIdentityMap.size };
        }, NF);
        console.log(`NF=${r.NF.toString().padStart(6)}  mapSize=${r.mapSize.toString().padStart(7)}  ` +
            `buildMap=${r.buildMs.toFixed(1)}ms  setData=${r.setDataMs.toFixed(1)}ms  ` +
            `setDisplayMode(1st)=${r.modeMs.toFixed(1)}ms  setDisplayMode(2nd)=${r.modeMs2.toFixed(1)}ms  rows=${r.rowCount}`);
    }

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
