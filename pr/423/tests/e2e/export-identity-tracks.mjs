/**
 * export-identity-tracks.mjs — a per-camera SLEAP export of a LAZILY reopened
 * project writes identities as tracks, on every frame, with the real coordinates.
 *
 * A project with a proofreading swap is saved and reopened through the real lazy
 * path, so only a window of frames is resident and the store still holds the raw
 * per-camera tracks. The two cameras number the animals in opposite directions.
 * The eager and hand-built lazy cases are in tests/test-export-identity-tracks.js.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 8197);
const FRAMES = 200;
const SWAP = 120;

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 600)));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => check(false, 'page error', String(e)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 60000 });

    const result = await page.evaluate(async ({ FRAMES, SWAP }) => {
        const pd = await import('./pose/pose-data.js');
        const fio = await import('./import-export/file-io.js');
        const sl = await import('./loading/session-loader.js');
        const CAMS = ['camA', 'camB'];
        const camera = (n, i) => new pd.Camera(n, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, i, 0], [i * 50, 0, 0], [640, 480]);
        const s = new pd.Session(CAMS.map(camera), new pd.Skeleton('sk', ['nose', 'tail'], [[0, 1]]), ['track_0', 'track_1'], 'S');
        const ids = [s.addIdentity('id_0'), s.addIdentity('id_1')];
        for (let f = 0; f < FRAMES; f++) {
            const fg = new pd.FrameGroup(f);
            const groups = [];
            for (let animal = 0; animal < 2; animal++) {
                const g = new pd.InstanceGroup(f * 2 + animal + 1, ids[animal].id);
                CAMS.forEach((cam, c) => {
                    const trk = c === 0 ? animal : 1 - animal;
                    const inst = new pd.Instance([[(animal + 1) * 100, f], [(animal + 1) * 100, f + 1]], trk, 'predicted', 0.9);
                    fg.addInstance(cam, inst);
                    g.addInstance(cam, inst);
                    s.setFrameIdentity(f, cam, trk, ids[animal].id);
                });
                groups.push(g);
            }
            s.addFrameGroup(fg);
            s.instanceGroups.set(f, groups);
        }
        s.swapIdentitiesForward(SWAP, ids[0].id, ids[1].id);

        const views = CAMS.map((n) => ({ name: n, videoWidth: 640, videoHeight: 480, frameCount: FRAMES }));
        const videoFiles = CAMS.map((n) => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const bytes = await window.SleapIO.saveSlpToBytes(fio.buildSlpLabelsAllViews(s, views, videoFiles));

        const skip = setInterval(() => {
            const b = [...document.querySelectorAll('button')].find((x) => /Skip|Later/i.test(x.textContent || '') && x.offsetParent !== null);
            if (b) b.click();
        }, 200);
        await sl.handleLoadProjectSlpLazy(new File([bytes], 'project.slp'));
        clearInterval(skip);

        const lazy = window.__lucid.state.session;
        const out = { lazy: !!lazy.lazyLoader, resident: lazy.frameGroups.size, cams: {} };
        for (const cam of CAMS) {
            const blob = await fio.exportSlpMultiSession([{ session: lazy, cameraName: cam, videoFileInfo: null }], null,
                { user: true, predicted: true, reprojected: false });
            const rb = await window.SleapIO.readSlpStreaming(new File([new Uint8Array(await blob.arrayBuffer())], cam + '.slp'),
                { lazy: false, openVideos: false, h5wasmUrl: new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href });
            const frames = {};
            for (const lf of rb.labeledFrames) {
                frames[lf.frameIdx] = {};
                for (const inst of lf.instances) frames[lf.frameIdx][inst.points[0].xy[0]] = inst.track ? inst.track.name : null;
            }
            out.cams[cam] = { tracks: rb.tracks.map((t) => t.name), nFrames: rb.labeledFrames.length, frames };
        }
        return out;
    }, { FRAMES, SWAP });

    check(result.lazy && result.resident < FRAMES, 'the reopened project is lazy, only part of it resident', [result.lazy, result.resident]);
    for (const [cam, r] of Object.entries(result.cams)) {
        check(r.nFrames === FRAMES, `${cam}: every frame exported`, r.nFrames);
        check(JSON.stringify(r.tracks) === '["track_0","track_1"]', `${cam}: tracks are the identities, not the raw list`, r.tracks);
        let wrong = 0;
        for (let f = 0; f < FRAMES; f++) {
            const first = f < SWAP ? 'track_0' : 'track_1', second = f < SWAP ? 'track_1' : 'track_0';
            if (r.frames[f][100] !== first || r.frames[f][200] !== second) wrong++;
        }
        check(wrong === 0, `${cam}: each animal (by its real x) is on the same track in both cameras, swapping at frame ${SWAP}`, [wrong, r.frames[0], r.frames[SWAP]]);
    }
} finally {
    await browser.close();
    server.kill();
}
console.log(fails ? `\nFAIL: ${fails}` : '\nPASS');
process.exit(fails ? 1 : 0);
