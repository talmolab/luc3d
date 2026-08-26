/**
 * _diag-percam-export-reimport.mjs — INVESTIGATION TOOL, not an assertion.
 *
 * Reproduces the reported "export the .slp files, drop them back into the
 * session folder, reload, and only some views come back" bug at its narrowest
 * seam: LUCID's own per-camera export bytes fed to the reader that
 * `handleLoadSessionFolderPerCamera` actually uses (`parseSlpH5`, the raw
 * h5wasm worker), one camera at a time.
 *
 * The folder loader swallows a parse failure —
 *   parseSlpH5(bestSlp).catch(function (e) { return null; })
 *   ... if (!slpData) continue;
 * — so a camera whose file the worker cannot read silently contributes no
 * annotations while the status bar still reports "Loaded N camera(s)". If the
 * failure is per-camera, that is exactly "only some of the views".
 *
 * Also runs the TYPED reader (`parseSlpViaSleapIO`) on the same bytes for
 * comparison, since the single-.slp session loader uses that one instead.
 *
 * Run: node tests/e2e/_diag-percam-export-reimport.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8261);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 300)));
    page.on('console', m => {
        const t = m.text();
        if (m.type() === 'error') console.log('  [console.error]', t.slice(0, 300));
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const out = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const fio = await import('/import-export/file-io.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session } = pd;

        const CAMS = ['cam1', 'cam2', 'cam3'];
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = CAMS.map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [640, 480]));
        const skel = new Skeleton('sk', ['nose', 'body', 'tail'], [[0, 1], [1, 2]]);
        const session = new Session(cams, skel, ['track_0', 'track_1'], 'PerCamExport');

        // 10 frames, 2 animals per camera, plain user instances.
        for (let f = 0; f < 10; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            for (const cn of CAMS) {
                for (let t = 0; t < 2; t++) {
                    fg.addInstance(cn, new Instance(
                        [[10 + f + t * 50, 20], [30 + f + t * 50, 40], [50 + f + t * 50, 60]],
                        t, 'user', 1));
                }
            }
        }

        const results = [];
        for (const cn of CAMS) {
            const vfi = {
                videoPath: cn + '/' + cn + '.mp4',
                file: null,
                videoWidth: 640, videoHeight: 480, frameCount: 10,
            };
            const row = { cam: cn };
            let blob = null;
            try {
                blob = await fio.exportSlpClientSide(session, cn, false, vfi, cn + '_v1.slp', null);
                row.exportBytes = blob.size;
            } catch (e) {
                row.exportError = String(e && e.message || e);
                results.push(row);
                continue;
            }
            const file = new File([blob], cn + '_v1.slp', { type: 'application/x-hdf5' });

            // --- the reader handleLoadSessionFolderPerCamera uses ---
            try {
                const raw = await fio.parseSlpH5(file);
                row.raw = raw ? {
                    frames: (raw.frames || []).length,
                    instances: (raw.frames || []).reduce((a, fr) => a + (fr.instances || []).length, 0),
                    videos: (raw.videos || []).length,
                    tracks: raw.tracks || null,
                    nodes: raw.skeleton ? (raw.skeleton.nodes || []).length : null,
                    videoIdxs: Array.from(new Set((raw.frames || []).map(fr => fr.videoIdx))),
                    frameIdxs: (raw.frames || []).slice(0, 5).map(fr => fr.frameIdx),
                } : null;
            } catch (e) {
                row.rawError = String(e && e.message || e);
            }

            // --- the reader the single-.slp loader uses, for comparison ---
            try {
                const typed = await fio.parseSlpViaSleapIO(file);
                row.typed = typed ? {
                    frames: (typed.frames || []).length,
                    instances: (typed.frames || []).reduce((a, fr) => a + (fr.instances || []).length, 0),
                    videos: (typed.videos || []).length,
                } : null;
            } catch (e) {
                row.typedError = String(e && e.message || e);
            }
            results.push(row);
        }
        return results;
    });

    console.log(JSON.stringify(out, null, 2));

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
