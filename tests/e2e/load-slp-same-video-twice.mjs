/**
 * load-slp-same-video-twice.mjs — File ▸ Load SLP on a video the session
 * already has never adds its camera a second time.
 *
 * ## The bug
 * With a session open, Load SLP merges the file in as more cameras
 * (`handleAddSlp`), renaming a camera whose name is taken to `<name>_2`. So
 * opening a one-video SLEAP file, continuing without its video, then opening
 * the same file again to get the video made a TWO-camera session of one video:
 * the original camera (no view) and `<name>_2` (the view), every detection
 * twice and grouped across the pair. The ID Switches tab then asked for
 * "tracked identities with 3D" and Track All took the multi-camera path —
 * single-camera tracking (PR #291) never ran.
 *
 * Asserted, through the real menus (the File System Access pickers, which
 * headless Chromium lacks, are removed so the app falls back to file inputs):
 *  1. Load SLP, Continue Without Video: one camera, no view.
 *  2. Load SLP again on the same file, picking its video at the prompt: still
 *     ONE camera with its own name, now with a view; the detections are not
 *     added again (same count, none grouped); the status says it was already
 *     there and that the video was attached; the ID Switches tab asks for Track
 *     All in the single-camera words (no "with 3D"); the timeline lists the
 *     file's two tracks on that camera.
 *  3. Load SLP a third time (the camera has its video now): nothing changes,
 *     and the status says nothing was added and how to open it on its own.
 *  4. A file whose video has the same name in another folder (campy names every
 *     video 0.mp4) is a different camera and is still added, as `<name>_2`.
 *  5. After a reopen the session knows a camera's video only by the name the
 *     saved project kept (here set by hand: `barcode-60.mp4`). A file whose
 *     video has that name in some folder may be the same video or another
 *     camera's: with the same frame count Load SLP asks ("The same video?");
 *     Cancel adds nothing, "Add as another camera" adds it. With a different
 *     frame count it is another video and is added without asking.
 *
 * Negative control, run once: on the pre-fix build §2 fails (two cameras, the
 * view on `<name>_2`, twice the detections, the "with 3D" wording) and §3 adds
 * a third camera.
 *
 * Run: node tests/e2e/load-slp-same-video-twice.mjs
 */
import { startServer, launchBrowser, repoRoot } from './lib/harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VIDEO = path.join(repoRoot, 'tests', 'fixtures', 'barcode-60', 'barcode-60.mp4');   // 60 frames, 256 x 32
const CAM = 'barcode-60';
let fails = 0;
const check = (c, m, extra) => { console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  — ' + JSON.stringify(extra))); if (!c) fails++; };

const server = await startServer();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-load-twice-'));
let browser;
try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { delete window.showOpenFilePicker; delete window.showDirectoryPicker; delete window.showSaveFilePicker; });
    page.on('pageerror', e => { console.log('  ✗ page error: ' + e.message); fails++; });
    await page.goto(`${server.url}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });

    // A one-video SLEAP predictions file: two animals on two tracks in every frame.
    const writeSlp = async (name, videoPath, frames = 60) => {
        const bytes = await page.evaluate(async ([videoPath, frames]) => {
            const SIO = window.SleapIO;
            const skeleton = new SIO.Skeleton({ name: 'sk', nodes: ['head', 'body', 'tail'], edges: [[0, 1], [1, 2]] });
            const video = new SIO.Video({ filename: videoPath });
            video.backendMetadata = { shape: [frames, 32, 256, 1] };   // as SLEAP writes it: videos_json's backend shape
            const tA = new SIO.Track('track_0'), tB = new SIO.Track('track_1');
            const animal = (x, track) => new SIO.PredictedInstance({ skeleton, track, score: 0.9,
                points: [0, 10, 20].map(d => ({ xy: [x + d, 16], visible: true, complete: true, score: 0.9 })) });
            const lfs = [];
            for (let f = 0; f < frames; f++) lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: [animal(20 + f, tA), animal(200 - f, tB)] }));
            return Array.from(await SIO.saveSlpToBytes(new SIO.Labels({ skeletons: [skeleton], videos: [video], tracks: [tA, tB], labeledFrames: lfs })));
        }, [videoPath, frames]);
        const p = path.join(tmpDir, name);
        fs.writeFileSync(p, Buffer.from(bytes));
        return p;
    };
    const slpA = await writeSlp('preds.slp', '/data/rec_a/barcode-60.mp4');
    const slpB = await writeSlp('other.slp', '/data/rec_b/barcode-60.mp4');
    const slpC = await writeSlp('cam_c.slp', '/data/rec_c/barcode-60.mp4');        // same name, same frame count
    const slpD = await writeSlp('cam_d.slp', '/data/rec_d/barcode-60.mp4', 50);    // same name, 50 frames

    const idle = () => page.waitForFunction(() => {
        const o = document.getElementById('loadingOverlay');
        return !document.getElementById('videoSelectOverlay') && !(o && o.offsetParent);
    }, null, { timeout: 60000 });
    /** File ▸ Load SLP on `slp`; at the video prompt pick `video`, or continue without one. `same`: answer
     *  "The same video?" ('cancel' / 'add'); the question's text lands in `asked.text`, or '' when not asked. */
    const asked = { text: '' };
    const loadSlp = async (slp, video, same) => {
        asked.text = '';
        const before = await page.evaluate(() => document.getElementById('statusText').textContent);
        const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.evaluate(() => document.getElementById('menuLoadSlp').click())]);
        await fc.setFiles(slp);
        // the prompt, the question, or (refused) a new status without one
        const waitNext = () => page.waitForFunction((before) => !!document.getElementById('videoSelectOverlay') ||
            !!document.querySelector('.same-video-modal') ||
            (document.getElementById('statusText').textContent !== before && !/^Pick SLP|^Reading|^Merging/.test(document.getElementById('statusText').textContent)), before, { timeout: 60000 });
        await waitNext();
        if (await page.evaluate(() => !!document.querySelector('.same-video-modal'))) {
            asked.text = await page.evaluate(() => document.querySelector('.same-video-modal').textContent);
            if (same === 'add') await page.click('#sameVideoOk'); else await page.keyboard.press('Escape');
            await page.waitForFunction(() => !document.querySelector('.same-video-modal'));
            await waitNext();
        }
        if (await page.evaluate(() => !!document.getElementById('videoSelectOverlay'))) {
            if (video) {
                const [vc] = await Promise.all([page.waitForEvent('filechooser'), page.click('text=Select Video Files')]);
                await vc.setFiles(video);
            } else await page.keyboard.press('Escape');
        }
        await idle();
        await page.waitForTimeout(500);
    };
    const snap = () => page.evaluate(async () => {
        const SC = await import('/pose/single-camera-tracking.js');
        const st = window.__lucid.state, s = st.session;
        let dets = 0, grouped = 0;
        for (const fg of s.frameGroups.values()) {
            for (const list of fg.instances.values()) { dets += list.length; grouped += list.length; }
            for (const list of fg.unlinkedInstances.values()) dets += list.length;
        }
        const tl = window.__lucid.timeline;
        return {
            cams: s.cameras.map(c => c.name), views: st.views.map(v => v.cameraName || v.name), dets, grouped,
            single: SC.singleCameraName(s), status: document.getElementById('statusText').textContent,
            idPanel: (document.getElementById('idSwitchPanel') || {}).innerText || '',
            rows: tl && tl._trackSegments ? tl._trackSegments.filter(r => r.segments.length).map(r => r.trackName + '@' + r.cameraName) : null,
        };
    });

    console.log('1. Load SLP, Continue Without Video');
    await loadSlp(slpA, null);
    let s = await snap();
    check(s.cams.length === 1 && s.cams[0] === CAM, 'one camera, named after the video', s.cams);
    check(s.views.length === 0, 'no view yet', s.views);
    check(s.dets === 120, 'every detection loaded once (2 animals x 60 frames)', s.dets);

    console.log('2. Load SLP again on the same file, picking its video');
    await loadSlp(slpA, VIDEO);
    s = await snap();
    check(s.cams.length === 1 && s.cams[0] === CAM, 'still ONE camera, with its own name (no "_2" copy)', s.cams);
    check(s.views.length === 1 && s.views[0] === CAM, 'the video is attached to that camera', s.views);
    check(s.dets === 120 && s.grouped === 0, 'the detections are not added again, and none is grouped across copies', { dets: s.dets, grouped: s.grouped });
    check(s.single === CAM, 'it is a single-camera session (Track All runs SLEAP\'s tracker)', s.single);
    check(/Already in this session: barcode-60/.test(s.status) && /attached its video/.test(s.status), 'the status says it was already there and the video was attached', s.status);
    check(/Run Track All first: the checks need tracked identities\./.test(s.idPanel) && !/with 3D/.test(s.idPanel), 'the ID Switches tab uses the single-camera words', s.idPanel.slice(0, 160));
    await page.click('#timelineModeToggle [data-mode="tracks"]');
    await page.waitForTimeout(200);
    s = await snap();
    check(JSON.stringify(s.rows) === JSON.stringify(['track_0@' + CAM, 'track_1@' + CAM]), 'the timeline lists the two tracks on that camera', s.rows);

    console.log('3. Load SLP a third time (the camera has its video)');
    await loadSlp(slpA, VIDEO);
    s = await snap();
    check(s.cams.length === 1 && s.views.length === 1 && s.dets === 120, 'nothing changes', { cams: s.cams, views: s.views, dets: s.dets });
    check(/Already in this session: barcode-60\. Nothing was added; to open preds\.slp on its own, use File ▸ New Project first/.test(s.status), 'the status says nothing was added, and how to open it on its own', s.status);

    console.log('4. The same video name in another folder is another camera');
    await loadSlp(slpB, null);
    s = await snap();
    check(JSON.stringify(s.cams) === JSON.stringify([CAM, CAM + '_2']), 'added as "' + CAM + '_2"', s.cams);
    check(s.dets === 240, 'with its own detections', s.dets);

    console.log('5. After a reopen: a video known only by its name may be another camera\'s');
    await page.evaluate(() => {            // what a reopened project knows: the saved short name and its frame count
        const S = window.__lucid.state.session;
        S.slpVideoByCamera['barcode-60'] = 'barcode-60.mp4';
        S.slpVideoFramesByCamera['barcode-60'] = 60;
    });
    await loadSlp(slpC, null, 'cancel');
    s = await snap();
    check(/The same video\?/.test(asked.text) && /camera barcode-60: \/data\/rec_c\/barcode-60\.mp4/.test(asked.text),
        'the same name and frame count: Load SLP asks which it is, naming the camera and the video', asked.text.slice(0, 200));
    check(s.cams.length === 2 && s.dets === 240, 'Cancel (it is the same video): nothing is added', { cams: s.cams, dets: s.dets });
    await loadSlp(slpC, null, 'add');
    s = await snap();
    check(s.cams.length === 3 && s.dets === 360, '"Add as another camera": it is added, with its detections', { cams: s.cams, dets: s.dets });
    await loadSlp(slpD, null, 'add');
    s = await snap();
    check(asked.text === '' && s.cams.length === 4, 'a different frame count: another video, added without asking', { asked: asked.text.slice(0, 60), cams: s.cams });
} finally {
    if (browser) await browser.close();
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
