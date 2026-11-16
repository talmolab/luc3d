/**
 * video-select-prompt-cancel.mjs — the video-select prompt has a way out (#337).
 *
 * File ▸ Load Project… on a labels `.json` with no video manifest (what File ▸
 * Export Labels (JSON) writes) asks for the video files through
 * `forceVideoSelection` (loading/session-loader.js). That prompt used to resolve
 * only on a non-empty pick: no Cancel, Esc did nothing, a cancelled picker left
 * it up, and it covered the whole UI — a user without the videos at hand had to
 * reload the page. It also said "SLP loaded" for a `.json` and showed
 * "Expected: (unknown)".
 *
 * Asserted, through the real app (menu clicks; the File System Access pickers,
 * which headless Chromium lacks, are stood in for):
 *  1. The prompt names a project, not an SLP; has no "Expected:" line when the
 *     file names no videos; and offers Continue Without Video.
 *  2. Esc closes it and the load FINISHES without video: the labels and cameras
 *     are there, the status says so, the menu bar takes clicks again, and the
 *     project is navigable — `totalFrames` reaches the last labeled frame, it
 *     opens on the first one with its groups, and ArrowRight steps.
 * 2b. A File ▸ Load Videos… where NOTHING decodes keeps it navigable: the
 *     failure is reported and totalFrames stays at the labels' count — it
 *     used to collapse to 0 (`adoptLabeledFrameCount` in handleLoadVideos).
 *  3. Recovery: File ▸ Load Videos… then attaches the videos to their cameras
 *     and a labeled frame shows its groups, with the frame count from video.
 *  4. A cancelled file picker leaves the prompt up; Continue Without Video
 *     then gets out the same way.
 *  5. `forceVideoSelection` directly: a caller's title and a non-empty
 *     "Expected:" line are shown, Esc resolves [], and the Esc listener is
 *     removed with the overlay.
 *
 * Negative control, run once: on the pre-fix build §1, §2 and §4 fail (the
 * "SLP"/"(unknown)" wording, no Continue button, the overlay survives Esc and
 * still covers the menu bar, the load never finishes, frame 0 only). §3 passes
 * there too — the recovery itself already worked; it was unreachable. §2b
 * failed before `handleLoadVideos` called `adoptLabeledFrameCount` (totalFrames
 * 0, ArrowRight back to frame 0).
 *
 * Run: node tests/e2e/video-select-prompt-cancel.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8347);
const CAMS = ['back', 'mid', 'side', 'top'];
// The demo clips are 21 frames long, so every labeled frame must be < 21 for
// §3 to find it again once the videos are attached.
const LABELED = [5, 10, 15];
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-337-'));

async function openApp() {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 850 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    return page;
}

// File ▸ Load Project… with `text` as the picked file; waits for the prompt.
async function loadProjectJson(page, text) {
    await page.evaluate((text) => {
        const f = new File([text], 'labels_export.json', { type: 'application/json' });
        window.showOpenFilePicker = async () => [{ getFile: async () => f }];
    }, text);
    await page.evaluate(() => document.getElementById('menuLoadProject').click());
    await page.waitForSelector('#videoSelectOverlay', { timeout: 20000 });
}

const loadFinished = (page) => page.waitForFunction(
    () => /^Project loaded|^Load error/.test(document.getElementById('statusText').textContent),
    null, { timeout: 20000 }).then(() => true, () => false);

const snap = (page) => page.evaluate(() => {
    const s = window.__lucid.state;
    const keys = s.session ? Array.from(s.session.frameGroups.keys()).sort((a, b) => a - b) : [];
    const hit = document.elementFromPoint(20, 12);
    return {
        overlay: !!document.getElementById('videoSelectOverlay'),
        status: document.getElementById('statusText').textContent,
        views: s.views.length,
        cameras: s.session ? s.session.cameras.length : 0,
        labeled: keys,
        totalFrames: s.totalFrames,
        currentFrame: s.currentFrame,
        groupsHere: s.session ? (s.session.instanceGroups.get(s.currentFrame) || []).length : 0,
        menuHit: hit ? (hit.id || hit.className || hit.tagName) : null,
    };
});

try {
    // ── Fixture: a labels .json written by the real Export Labels ──────────
    // The demo session has no 2D labels of its own, so two animals are put on
    // every camera on the LABELED frames first.
    let jsonText;
    {
        const page = await openApp();
        await page.evaluate(async ({ LABELED }) => {
            await (await import('/pose/initialization.js')).loadDemoSession();
            const { Instance, FrameGroup } = await import('/pose/pose-data.js');
            const s = window.__lucid.state.session;
            const nN = s.skeleton.nodes.length;
            for (const f of LABELED) {
                let fg = s.frameGroups.get(f);
                if (!fg) { fg = new FrameGroup(f); s.addFrameGroup(fg); }
                for (const cam of s.cameras) for (let a = 0; a < 2; a++) {
                    fg.addInstance(cam.name, new Instance(
                        Array.from({ length: nN }, (_, n) => [100 + 200 * a + 10 * n, 100 + 5 * n + f]), a, 'user', 1));
                }
            }
            // No save picker → Export Labels takes its download path.
            window.showSaveFilePicker = undefined;
        }, { LABELED });
        const dl = page.waitForEvent('download', { timeout: 30000 });
        await page.evaluate(() => document.getElementById('menuExportLabels').click());
        const jsonPath = path.join(tmpDir, 'labels_export.json');
        await (await dl).saveAs(jsonPath);
        jsonText = fs.readFileSync(jsonPath, 'utf8');
        const j = JSON.parse(jsonText);
        check(j.version === undefined && j.videoManifest === undefined,
            'fixture: the export carries no version and no video manifest (the legacy load path)');
        check(JSON.stringify(Object.keys(j.frames).map(Number)) === JSON.stringify(LABELED),
            `fixture: the export holds the labeled frames (${Object.keys(j.frames)})`);
        await page.context().close();
    }

    // ── §1–§3: the prompt, Esc, and attaching videos afterwards ────────────
    console.log('§1 the prompt');
    {
        const page = await openApp();
        await loadProjectJson(page, jsonText);
        const p = await page.$eval('#videoSelectOverlay', el => ({
            text: el.innerText,
            buttons: Array.from(el.querySelectorAll('button')).map(b => b.textContent),
        }));
        check(/^Project loaded/.test(p.text) && !/SLP/.test(p.text), `the title names a project, not an SLP ("${p.text.split('\n')[0]}")`);
        check(!/Expected/.test(p.text) && !/unknown/.test(p.text), 'no "Expected: (unknown)" line when the file names no videos');
        check(p.buttons.includes('Continue Without Video'), `it offers Continue Without Video (${p.buttons.join(' | ')})`);

        console.log('§2 Esc continues without video');
        await page.keyboard.press('Escape');
        check(await loadFinished(page), 'the load finishes');
        let s = await snap(page);
        check(!s.overlay, 'the prompt is gone');
        check(/without video/.test(s.status) && /Load Videos/.test(s.status), `the status says so ("${s.status}")`);
        check(s.views === 0 && s.cameras === CAMS.length, `no views, ${s.cameras} cameras`);
        check(JSON.stringify(s.labeled) === JSON.stringify(LABELED), `the labels are loaded (${s.labeled})`);
        check(s.menuHit !== 'videoSelectOverlay', `the menu bar takes clicks again (hit: ${s.menuHit})`);
        check(s.totalFrames === LABELED[LABELED.length - 1] + 1, `totalFrames reaches the last labeled frame (${s.totalFrames})`);
        check(s.currentFrame === LABELED[0] && s.groupsHere === 2,
            `it opens on the first labeled frame with its groups (frame ${s.currentFrame}, ${s.groupsHere} groups)`);
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(300);
        s = await snap(page);
        check(s.currentFrame === LABELED[0] + 1, `ArrowRight steps (frame ${s.currentFrame})`);

        console.log('§2b File ▸ Load Videos… where nothing decodes keeps the project navigable');
        const fcBad = page.waitForEvent('filechooser');
        await page.evaluate(() => document.getElementById('menuLoadVideos').click());
        await (await fcBad).setFiles([{ name: 'not-a-video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not a video') }]);
        await page.waitForFunction(() => /failed to load/.test(document.getElementById('statusText').textContent),
            null, { timeout: 20000 }).catch(() => {});
        s = await snap(page);
        check(/All videos failed to load/.test(s.status), `the failure is reported ("${s.status.slice(0, 60)}…")`);
        check(s.views === 0 && s.totalFrames === LABELED[LABELED.length - 1] + 1,
            `totalFrames still reaches the last labeled frame (${s.totalFrames}), not 0`);
        const before2b = s.currentFrame;
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(300);
        s = await snap(page);
        check(s.currentFrame === before2b + 1, `ArrowRight still steps (frame ${before2b} → ${s.currentFrame})`);

        console.log('§3 File ▸ Load Videos… afterwards');
        const fc = page.waitForEvent('filechooser');
        await page.evaluate(() => document.getElementById('menuLoadVideos').click());
        await (await fc).setFiles(CAMS.map(n => path.join(repoRoot, 'sample_session', n + '.mp4')));
        await page.waitForFunction(() => window.__lucid.state.views.length === 4, null, { timeout: 60000 }).catch(() => {});
        await page.evaluate(async (f) => (await import('/pose/initialization.js')).navigateToFrame(f), LABELED[1]);
        await page.waitForFunction((f) => window.__lucid.state.currentFrame === f, LABELED[1], { timeout: 10000 }).catch(() => {});
        s = await snap(page);
        const assigned = await page.evaluate(() => window.__lucid.state.videoFiles.map(v => v.name + '->' + v.assignedCamera));
        check(s.views === 4 && assigned.every(a => a.split('->')[0] === a.split('->')[1]),
            `the videos attach to their cameras (${assigned.join(', ')})`);
        check(s.totalFrames === 21, `the frame count now comes from the video (${s.totalFrames})`);
        check(s.currentFrame === LABELED[1] && s.groupsHere === 2,
            `a labeled frame shows its groups (frame ${s.currentFrame}, ${s.groupsHere} groups)`);
        await page.context().close();
    }

    // ── §4: a cancelled picker, then the button ────────────────────────────
    console.log('§4 a cancelled picker, then Continue Without Video');
    {
        const page = await openApp();
        await loadProjectJson(page, jsonText);
        const fc = page.waitForEvent('filechooser');
        await page.click('#videoSelectOverlay button:has-text("Select Video Files")');
        await (await fc).setFiles([]);
        await page.waitForTimeout(500);
        check((await snap(page)).overlay, 'a cancelled picker leaves the prompt up');
        await page.click('#videoSelectOverlay button:has-text("Continue Without Video")');
        check(await loadFinished(page), 'the load finishes');
        const s = await snap(page);
        check(!s.overlay && /without video/.test(s.status) && JSON.stringify(s.labeled) === JSON.stringify(LABELED),
            `the button continues without video, labels loaded ("${s.status}")`);
        await page.context().close();
    }

    // ── §5: forceVideoSelection directly ───────────────────────────────────
    console.log('§5 forceVideoSelection(refInfo, options)');
    {
        const page = await openApp();
        await page.evaluate(async () => {
            const m = await import('/loading/session-loader.js');
            window.__pick = m.forceVideoSelection('cam1.mp4, cam2.mp4', { title: 'SLP loaded — now select the video file(s)' });
        });
        const text = await page.$eval('#videoSelectOverlay', el => el.innerText);
        check(/^SLP loaded/.test(text), `the caller's title is shown ("${text.split('\n')[0]}")`);
        check(/Expected: cam1\.mp4, cam2\.mp4/.test(text), 'a non-empty "Expected:" line is shown');
        await page.keyboard.press('Escape');
        const res = await page.evaluate(async () => { const r = await window.__pick; return Array.isArray(r) ? r.length : String(r); });
        check(res === 0, `Esc resolves [] (${res})`);
        // A second prompt (the default title, no refInfo): if the first one's
        // Esc listener had been left behind, this Esc would resolve it again
        // and leave this overlay up.
        await page.evaluate(async () => {
            const m = await import('/loading/session-loader.js');
            window.__pick2 = m.forceVideoSelection('');
        });
        const t2 = await page.$eval('#videoSelectOverlay', el => el.innerText);
        check(/^Select the video file\(s\)/.test(t2) && !/Expected/.test(t2), `default title is neutral, no empty "Expected:" ("${t2.split('\n')[0]}")`);
        await page.keyboard.press('Escape');
        const res2 = await page.evaluate(async () => (await window.__pick2).length);
        const left = await page.evaluate(() => document.querySelectorAll('#videoSelectOverlay').length);
        check(res2 === 0 && left === 0, 'the second prompt closes on its own Esc, and no overlay is left behind');
        await page.context().close();
    }
} catch (e) {
    console.log('  ✗ threw:', e && e.stack || e);
    fails++;
} finally {
    await browser.close();
    server.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nPASS video-select-prompt-cancel' : `\nFAIL video-select-prompt-cancel (${fails})`);
process.exit(fails === 0 ? 0 : 1);
