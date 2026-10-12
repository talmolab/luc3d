/**
 * videos-panel-buttons.mjs — the Videos tab's two buttons (luc3d #216).
 *
 * §1  `Load Videos` works WITH NO SESSION LOADED. That is the bug: both
 *     handlers used to be installed inside `updateInfoPanel`, which returns
 *     early when `state.session` is null — so on a freshly-opened app, exactly
 *     when you reach for the button, it carried no handler and clicking it did
 *     nothing, while `File ▸ Load Videos…` (wired at setup) worked. The test
 *     clicks it on a fresh page, so it FAILS on the pre-fix build.
 *
 * §2  The labels: `Load Videos` (it opens the same picker as the File menu
 *     item, so it is named after it) and `Remove Video`.
 *
 * §3  `Remove Video` removes the WHOLE video. It used to splice
 *     `state.videoFiles` and delete the view's `.video-cell` element, leaving
 *     the dockview panel docked and titled with an empty body, plus a live
 *     thumbnail in the view strip. Asserted here: the pane is gone from
 *     `paneManager.api.panels`, no `.video-cell` for it survives in the DOM,
 *     the view-strip item is gone, and the OTHER video keeps all three.
 *
 * §4  The decoder is closed (nothing will fetch a frame from it again) and
 *     taken out of the cross-session decoder pool.
 *
 * §5  `session.videoFileIndices` is remapped across the splice — they are
 *     indices into `state.videoFiles`, so removing one shifts every later one.
 *
 * §6  Removing the last video empties the dock and resets the frame count.
 *
 * Fixtures: two tiny H.264 clips generated here with ffmpeg (headless Chromium
 * cannot decode the HEVC the real sessions ship). Skips with a note if ffmpeg
 * is missing.
 *
 * Run: node tests/e2e/videos-panel-buttons.mjs
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8152);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

// --- fixtures ---------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-videos-panel-'));
const mk = (name, src) => {
    const out = path.join(tmp, name);
    const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', `${src}=size=320x240:rate=10`, '-frames:v', '20',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
    return (r.status === 0 && fs.existsSync(out)) ? out : null;
};
const camA = mk('camA.mp4', 'testsrc');
const camB = mk('camB.mp4', 'testsrc2');
const camC = mk('camC.mp4', 'smptebars');
if (!camA || !camB || !camC) {
    console.log('  (ffmpeg unavailable — skipping videos-panel-buttons.mjs)');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const snapshot = (page) => page.evaluate(() => {
    const s = window.__lucid.state;
    const pm = window.__lucid.paneManager;
    return {
        views: s.views.map(v => v.name),
        videoFiles: s.videoFiles.map(v => v.assignedCamera || v.name),
        panes: (pm && pm.api) ? pm.api.panels.map(p => p.params && p.params.viewName) : [],
        docked: pm ? Array.from(pm.dockedViews.keys()) : [],
        cells: Array.from(document.querySelectorAll('.video-cell'))
            .map(el => el.getAttribute('data-view-name')).filter(Boolean),
        strip: Array.from(document.querySelectorAll('.view-strip-item'))
            .map(el => el.getAttribute('data-view-name')),
        totalFrames: s.totalFrames,
        vfi: s.session ? s.session.videoFileIndices.slice() : null,
        cameras: s.session ? s.session.cameras.map(c => c.name) : null,
        dockEmptyHidden: !!document.getElementById('videoDockEmpty')
            && document.getElementById('videoDockEmpty').classList.contains('hidden'),
    };
});

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid, { timeout: 20000 });
    await page.waitForTimeout(600);

    // Open the Videos tab (it may be demoted into the "More ▾" overflow).
    await page.evaluate(() => {
        document.querySelectorAll('.panel-tab').forEach((t) => {
            if (t.getAttribute('data-tab') === 'tabVideos') t.click();
        });
    });
    await page.waitForTimeout(200);

    // ---- §2 labels ---------------------------------------------------------
    console.log('\n§2 button labels');
    const labels = await page.evaluate(() => ({
        load: document.getElementById('btnLoadVideos')
            && document.getElementById('btnLoadVideos').textContent.replace(/\s+/g, ' ').trim(),
        remove: document.getElementById('btnRemoveVideo')
            && document.getElementById('btnRemoveVideo').textContent.replace(/\s+/g, ' ').trim(),
        removeDisabled: document.getElementById('btnRemoveVideo').disabled,
        stale: !!document.getElementById('btnAddVideos'),
    }));
    check(labels.load === 'Load Videos', 'the load button reads "Load Videos" (was "Add Videos")');
    check(labels.remove === 'Remove Video', 'the remove button reads "Remove Video" (was "Remove")');
    check(labels.stale === false, 'no #btnAddVideos left behind');
    check(labels.removeDisabled === true, 'Remove Video starts disabled (nothing selected)');

    // ---- §1 Load Videos with NO session -----------------------------------
    console.log('\n§1 Load Videos on a fresh app (no session)');
    check(await page.evaluate(() => !window.__lucid.state.session), 'precondition: no session loaded');

    let picked = false;
    page.once('filechooser', (fc) => { picked = true; fc.setFiles([camA, camB]); });
    await page.click('#btnLoadVideos');
    await page.waitForTimeout(400);
    check(picked, 'clicking Load Videos opens the file picker');
    await page.waitForFunction(() => window.__lucid.state.views.length >= 2, null, { timeout: 60000 });

    let s = await snapshot(page);
    check(s.views.join() === 'camA,camB', 'both videos became views: ' + s.views.join());
    check(s.panes.slice().sort().join() === 'camA,camB', 'both are docked as panes: ' + s.panes.join());
    check(s.strip.slice().sort().join() === 'camA,camB', 'both have a view-strip thumbnail');
    check(s.vfi && s.vfi.join() === '0,1', 'session.videoFileIndices = ' + JSON.stringify(s.vfi));

    // ---- §3 Remove Video ---------------------------------------------------
    console.log('\n§3 Remove Video takes the pane and the thumbnail with it');
    // Keep a handle on the entry + decoder the removal is about to drop, so §4
    // can inspect them after they leave `state.videoFiles`.
    await page.evaluate(() => {
        const vf = window.__lucid.state.videoFiles.find(v => (v.assignedCamera || v.name) === 'camA');
        window.__removed = { vf: vf, decoder: vf.decoder };
    });

    await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#videosTable tbody tr'));
        const row = rows.find(r => r.children[0].textContent === 'camA');
        row.click();
    });
    check(await page.evaluate(() => !document.getElementById('btnRemoveVideo').disabled),
        'selecting a row enables Remove Video');

    await page.click('#btnRemoveVideo');
    await page.waitForTimeout(800);

    s = await snapshot(page);
    check(s.views.join() === 'camB', 'camA left state.views: ' + s.views.join());
    check(s.videoFiles.join() === 'camB', 'camA left state.videoFiles: ' + s.videoFiles.join());
    check(s.panes.indexOf('camA') < 0, 'camA has NO dockview pane left (this is the blank-panel bug)');
    check(s.docked.indexOf('camA') < 0, 'camA is out of paneManager.dockedViews');
    check(s.cells.indexOf('camA') < 0, 'no .video-cell for camA survives in the DOM');
    check(s.strip.indexOf('camA') < 0, 'camA lost its view-strip thumbnail');
    check(s.panes.join() === 'camB' && s.strip.join() === 'camB' && s.cells.join() === 'camB',
        'camB keeps its pane, cell and thumbnail');
    check(await page.evaluate(() => document.getElementById('btnRemoveVideo').disabled),
        'Remove Video is disabled again (its row is gone)');
    check(await page.evaluate(() => Array.from(document.querySelectorAll('#videosTable tbody tr'))
        .map(r => r.children[0].textContent).join()) === 'camB',
        'the Videos table lists only camB');
    check(s.cameras.indexOf('camA') >= 0,
        'the session KEEPS the camA camera (calibration + annotation are not the video)');

    // ---- §4 decoder torn down ---------------------------------------------
    console.log('\n§4 the decoder is released');
    const dec = await page.evaluate(() => {
        const s2 = window.__lucid.state;
        const d = window.__removed.decoder;
        return {
            detached: window.__removed.vf.decoder === null,
            closed: d.decoder === null && d._mbBackend === null,
            cacheEmpty: d.cache.size === 0,
            inPool: (s2.decoderPool || []).indexOf(d) >= 0,
            inCold: (s2._decoderPoolCold || []).indexOf(d) >= 0,
        };
    });
    check(dec.detached, 'the video file entry no longer points at its decoder');
    check(dec.closed, 'decoder.close() ran (WebCodecs decoder + mediabunny backend released)');
    check(dec.cacheEmpty, 'its decoded-frame cache was emptied');
    check(!dec.inPool && !dec.inCold, 'it is out of the cross-session decoder pool');

    // ---- §5 index remap ----------------------------------------------------
    console.log('\n§5 session.videoFileIndices survives the splice');
    check(s.vfi.join() === '0', 'remapped to ' + JSON.stringify(s.vfi) + ' (stale would be [1])');
    check(await page.evaluate(() => {
        const st = window.__lucid.state;
        return st.session.videoFileIndices.every(i => !!st.videoFiles[i]);
    }), 'every index still resolves to a loaded video');

    // ---- §7 removing while in single-view ("solo") mode --------------------
    // Done before §6, which empties the dock. Three separate failures live
    // here, all from state that names a view by POSITION or by a stale
    // snapshot:
    //   a) `g` restores `savedGridLayout`, the snapshot `v` took — which still
    //      lists the removed view, so `fromJSON` rebuilds an empty pane
    //      wearing its name;
    //   b) `state.singleViewIndex` indexes `state.views`, so removing a view
    //      BEFORE the solo'd one slides the next camera into its slot and solo
    //      silently shows a different view;
    //   c) removing the solo'd view itself closes the only pane, leaving the
    //      dock empty while views remain.
    console.log('\n§7 removing a video while solo (v) does not leave a ghost pane on g');
    // Addressed by NAME throughout: §3 already removed camA, so the reload
    // below appends rather than starting clean and `state.views` is not in
    // alphabetical order. An index-based fixture here would be the very bug
    // under test, written into its own test.
    const solo = async (name) => {
        await page.evaluate((n) => {
            const item = document.querySelector('.view-strip-item[data-view-name="' + n + '"]');
            if (item) item.click();
        }, name);
        await page.waitForTimeout(150);
        await page.keyboard.press('v');
        await page.waitForTimeout(500);
    };
    const removeByName = async (name) => {
        await page.evaluate((n) => {
            const rows = [...document.querySelectorAll('#videosTable tbody tr')];
            const row = rows.find(r => r.children[0].textContent === n);
            if (row) row.click();
        }, name);
        await page.click('#btnRemoveVideo');
        await page.waitForTimeout(700);
    };
    const pressG = async () => {
        await page.evaluate(() => document.body.click());
        await page.keyboard.press('g');
        await page.waitForTimeout(700);
    };
    const mode = () => page.evaluate(() => ({
        mode: window.__lucid.state.viewMode,
        soloName: (window.__lucid.state.views[window.__lucid.state.singleViewIndex] || {}).name,
    }));

    // Get back to three views (§3 left only camB), then read the live order.
    page.once('filechooser', (fc) => fc.setFiles([camA, camC]));
    await page.click('#btnLoadVideos');
    await page.waitForFunction(() => window.__lucid.state.views.length >= 3, null, { timeout: 60000 });
    await page.waitForTimeout(600);
    s = await snapshot(page);
    check(s.views.length === 3, 'precondition: three views (' + s.views.join() + ')');
    const [first, second, third] = s.views;

    // (b) solo the SECOND view, then remove the FIRST — the one before it.
    await solo(second);
    check((await mode()).soloName === second, 'v solos ' + second);
    await removeByName(first);
    let m = await mode();
    check(m.soloName === second,
        'solo stays on ' + second + ' after removing the view before it (positional drift would give '
        + third + ') — got ' + m.soloName);
    s = await snapshot(page);
    check(s.panes.join() === second, 'still exactly one pane, and it is ' + second + ': ' + JSON.stringify(s.panes));

    // (a) back to grid — the snapshot `v` took still lists the removed view.
    const live = [second, third].sort().join();
    await pressG();
    s = await snapshot(page);
    check((await mode()).mode === 'grid', 'g returns to grid mode');
    check(s.panes.slice().sort().join() === live,
        'the restored grid holds exactly the live views, no ' + first + ' ghost: ' + JSON.stringify(s.panes));
    check(s.cells.slice().sort().join() === live, 'and no ghost .video-cell: ' + JSON.stringify(s.cells));

    // (c) solo a view, then remove THAT view.
    await solo(second);
    check((await mode()).soloName === second, 'v solos ' + second + ' again');
    await removeByName(second);
    m = await mode();
    s = await snapshot(page);
    check(m.soloName === third, 'solo falls to the next view when the solo\'d one is removed (got ' + m.soloName + ')');
    check(s.panes.join() === third,
        'the dock re-renders that view instead of being left empty: ' + JSON.stringify(s.panes));
    await pressG();
    s = await snapshot(page);
    check(s.panes.join() === third, 'and g still restores only the live view: ' + JSON.stringify(s.panes));

    // ---- §6 removing the last one ------------------------------------------
    console.log('\n§6 removing the last video empties the dock');
    await page.evaluate(() => {
        document.querySelectorAll('#videosTable tbody tr').forEach(r => r.click());
    });
    await page.click('#btnRemoveVideo');
    await page.waitForTimeout(800);
    s = await snapshot(page);
    check(s.views.length === 0 && s.videoFiles.length === 0, 'no views or video files left');
    check(s.panes.length === 0 && s.cells.length === 0, 'no panes left in the dock');
    check(s.strip.length === 0, 'the view strip is empty');
    check(s.totalFrames === 0, 'the frame count reset to 0');
    check(s.dockEmptyHidden === false, 'the dock\'s empty-state message is showing again');

    await browser.close();
} finally {
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
