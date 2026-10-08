/**
 * percam-slp-choice-and-failure.mjs — the other two ways a per-camera folder
 * reload loses one view's annotations, both of which look identical to the user
 * ("some views came back, some didn't") and neither of which used to say
 * anything in the UI.
 *
 *  1. **A leftover `_vN` outranks the file you just wrote.** Selection is
 *     "highest `_vN`, unversioned counts as 0", and "Export SLEAP File By Cam"
 *     writes `<stem>_v<N+1>.slp` every time, so directories accumulate
 *     versions. Put fresh annotations in `<stem>.slp` while an older
 *     `<stem>_v1.slp` is still sitting there — which is what "replacing the
 *     .slp file" means when the original had no suffix — and the STALE file
 *     wins, while the console cheerfully reports it as "highest version".
 *
 *     The version rule is deliberately KEPT (mtime survives neither copying nor
 *     syncing reliably, so it must not decide which file is authoritative); the
 *     fix is that the load now says a newer file was left unread, and that
 *     `lastModified` breaks a same-version tie that folder-enumeration order
 *     used to settle arbitrarily.
 *
 *  2. **An unreadable `.slp` fails silently.** The parse was
 *     `parseSlpH5(bestSlp).catch(() => null)` followed by `if (!slpData)
 *     continue`, and the closing status counts matched DIRECTORIES rather than
 *     successful parses — so a corrupt file produced an empty view under
 *     "Loaded 3 camera(s)", success-styled.
 *
 * Every camera below is set up so the assertions can name which file was read:
 * the two candidates carry different track names and different instance counts.
 *
 * Run: node tests/e2e/percam-slp-choice-and-failure.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8272);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrs = [];
    page.on('pageerror', e => pageErrs.push(String(e).slice(0, 300)));

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const r = await page.evaluate(async () => {
        const enc = await import('/ui/video-encode.js');
        const loader = await import('/loading/session-loader.js');
        const fio = await import('/import-export/file-io.js');
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');

        const CAMS = ['cam1', 'cam2', 'cam3'];
        const NFRAMES = 12, W = 320, H = 240, ROOT = 'sess';

        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const cctx = canvas.getContext('2d');
        const wr = await enc.createMp4Writer({
            canvas, width: W, height: H, fps: 10,
            bitrate: 400000, frameCount: NFRAMES, keyFrameEveryFrames: 4,
        });
        for (let i = 0; i < NFRAMES; i++) {
            cctx.fillStyle = 'rgb(' + (20 * i) + ',40,80)'; cctx.fillRect(0, 0, W, H);
            await wr.addFrame(i);
        }
        const mp4 = (await wr.finish()).blob;

        let toml = '';
        CAMS.forEach((cn, i) => {
            toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [' + W + ', ' + H + ']\n'
                + 'matrix = [[600.0, 0.0, 160.0], [0.0, 600.0, 120.0], [0.0, 0.0, 1.0]]\n'
                + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\n'
                + 'rotation = [0.0, ' + (0.2 * i) + ', 0.0]\ntranslation = ['
                + (15 * i) + ', 0.0, 0.0]\n\n';
        });

        function mkFile(bits, relPath, type, lastModified) {
            const f = new File(bits, relPath.split('/').pop(),
                { type: type || 'application/octet-stream', lastModified: lastModified });
            Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
            return f;
        }

        // A one-camera .slp whose track name and instance count identify it.
        async function makeSlp(cam, tag, perFrame) {
            const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
            const cams = CAMS.map((n, i) =>
                new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [W, H]));
            const skel = new pd.Skeleton('sk', ['nose', 'body', 'tail'], [[0, 1], [1, 2]]);
            const s = new pd.Session(cams, skel, [tag + '_track'], 'gen');
            for (let f = 0; f < 4; f++) {
                const fg = new pd.FrameGroup(f);
                s.addFrameGroup(fg);
                for (let t = 0; t < perFrame; t++) {
                    fg.addInstance(cam, new pd.Instance(
                        [[10 + f, 20], [30 + f, 40], [50 + f, 60]], 0, 'user', 1));
                }
            }
            const vfi = {
                videoPath: ROOT + '/' + cam + '/' + cam + '.mp4', file: null,
                videoWidth: W, videoHeight: H, frameCount: NFRAMES,
            };
            return await fio.exportSlpClientSide(s, cam, false, vfi, cam + '.slp', null);
        }

        const OLD_T = 1000, NEW_T = 2000;   // fake mtimes: NEW written after OLD
        const files = [mkFile([toml], ROOT + '/calibration.toml', 'text/plain')];
        for (const cn of CAMS) files.push(mkFile([mp4], ROOT + '/' + cn + '/' + cn + '.mp4', 'video/mp4'));

        // cam1 — fresh unversioned file, stale `_v1` still in the directory.
        files.push(mkFile([await makeSlp('cam1', 'NEW', 3)], ROOT + '/cam1/cam1.slp', 'application/x-hdf5', NEW_T));
        files.push(mkFile([await makeSlp('cam1', 'OLD', 1)], ROOT + '/cam1/cam1_v1.slp', 'application/x-hdf5', OLD_T));
        // cam2 — control: only the fresh unversioned file.
        files.push(mkFile([await makeSlp('cam2', 'NEW', 3)], ROOT + '/cam2/cam2.slp', 'application/x-hdf5', NEW_T));
        // cam3 — an unreadable .slp.
        files.push(mkFile([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], ROOT + '/cam3/cam3.slp', 'application/x-hdf5', NEW_T));

        AS.state.sessions = []; AS.state.activeSessionIdx = 0;
        AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
        await loader.handleLoadSessionFolderPerCamera(files, false);

        const s = AS.state.session, per = {};
        for (const c of s.cameras) per[c.name] = 0;
        for (const [, fg] of s.frameGroups) {
            for (const [cn, xs] of fg.instances) per[cn] = (per[cn] || 0) + xs.length;
            for (const [cn, xs] of fg.unlinkedInstances) per[cn] = (per[cn] || 0) + xs.length;
        }
        const statusEl = document.getElementById('statusText');

        // --- chooseCameraSlp on its own, where the rules are visible ---------
        const f = (name, lm) => ({ name: name, lastModified: lm });
        const choice = {
            versionWins: loader.chooseCameraSlp([f('a.slp', NEW_T), f('a_v1.slp', OLD_T)]).file.name,
            higherVersionWins: loader.chooseCameraSlp([f('a_v2.slp', OLD_T), f('a_v1.slp', NEW_T)]).file.name,
            mtimeBreaksTie: loader.chooseCameraSlp([f('a.slp', OLD_T), f('b.slp', NEW_T)]).file.name,
            mtimeBreaksTieVersioned: loader.chooseCameraSlp([f('a_v3.slp', NEW_T), f('b_v3.slp', OLD_T)]).file.name,
            newerFlagged: (loader.chooseCameraSlp([f('a.slp', NEW_T), f('a_v1.slp', OLD_T)]).newer || {}).name || null,
            noFalseFlagWhenChosenIsNewest:
                loader.chooseCameraSlp([f('a_v2.slp', NEW_T), f('a_v1.slp', OLD_T)]).newer,
            noFalseFlagOnEqualMtime:
                loader.chooseCameraSlp([f('a.slp', NEW_T), f('a_v1.slp', NEW_T)]).newer,
            singleFile: loader.chooseCameraSlp([f('only.slp', NEW_T)]).file.name,
            threeDeeSuffix: loader.chooseCameraSlp([f('a_3D_v5.slp', OLD_T), f('a_v2.slp', NEW_T)]).file.name,
        };

        return {
            views: AS.state.views.map(v => v.name),
            tracks: s.tracks,
            perCam: per,
            status: statusEl ? statusEl.textContent : null,
            // The severity lives on #statusDot, not on the text node — see
            // save-load.js setStatus.
            statusDot: (document.getElementById('statusDot') || {}).className || null,
            choice,
        };
    });

    console.log('  measured:', JSON.stringify(r).slice(0, 700));

    // ---- selection rules ---------------------------------------------------
    const c = r.choice;
    check(c.versionWins === 'a_v1.slp',
        `the "highest _vN" rule is unchanged — a leftover _v1 still outranks an unversioned file (got ${c.versionWins})`);
    check(c.higherVersionWins === 'a_v2.slp',
        `higher version wins regardless of mtime (got ${c.higherVersionWins})`);
    check(c.mtimeBreaksTie === 'b.slp',
        `mtime breaks a same-version tie instead of folder order (got ${c.mtimeBreaksTie})`);
    check(c.mtimeBreaksTieVersioned === 'a_v3.slp',
        `…including between two equally-versioned names (got ${c.mtimeBreaksTieVersioned})`);
    check(c.newerFlagged === 'a.slp',
        `a newer-but-unread file is reported so the user can act on it (got ${c.newerFlagged})`);
    check(c.noFalseFlagWhenChosenIsNewest === null,
        'no warning when the chosen file IS the newest');
    check(c.noFalseFlagOnEqualMtime === null,
        'no warning on equal mtimes — a folder copied in one go must stay quiet');
    check(c.singleFile === 'only.slp', 'a lone file is chosen unconditionally');
    check(c.threeDeeSuffix === 'a_3D_v5.slp',
        `the _3D_vN naming variant still parses as a version (got ${c.threeDeeSuffix})`);

    // ---- what actually loaded ---------------------------------------------
    check(r.views.length === 3, `all 3 views exist (got ${JSON.stringify(r.views)})`);
    check(r.perCam.cam2 === 12, `control camera loaded its fresh file (got ${r.perCam.cam2}, want 12)`);
    check(r.perCam.cam1 === 4,
        `cam1 still loads the highest-version file, stale or not — behavior deliberately unchanged (got ${r.perCam.cam1})`);
    check(r.tracks.indexOf('OLD_track') >= 0,
        'and it is demonstrably the OLD file (its track name is present)');

    // ---- and the load now SAYS so -----------------------------------------
    check(/could not be read/.test(r.status || ''),
        `the unreadable cam3 file is reported in the status line (got "${r.status}")`);
    check(/cam3/.test(r.status || ''),
        'and the status names the camera that failed');
    check(/cam3\.slp/.test(r.status || ''),
        'and names the file');
    check(/error/.test(r.statusDot || ''),
        `the status indicator is styled as an error, not success (got "${r.statusDot}")`);
    check(r.perCam.cam3 === 0,
        'cam3 still has no data — this fix makes the loss visible, it does not invent data');

    check(pageErrs.length === 0, `no uncaught page errors (got ${JSON.stringify(pageErrs.slice(0, 2))})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
