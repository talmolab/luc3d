/**
 * video-playback.mjs — real-browser integration test for seek / scrub / play.
 *
 * Drives the ACTUAL app (load a video → VideoController) and asserts the things
 * the unit/streaming tests never did:
 *   - seekToFrame(N) moves state.currentFrame to N and the frame is decodable.
 *   - startPlayback() advances through multiple distinct frames (not stuck).
 *   - playback TERMINATES on its own at end-of-stream (state.isPlaying → false).
 *
 * The last one is the regression the sleap backend hit: its getCurrentFrameIndex
 * caps at totalFrames-1, so VideoController's `frameIdx >= totalFrames` stop
 * never fired → playback hung on the last frame with isPlaying stuck true.
 *
 * Backend is whatever the app defaults to; override with LUCID_VIDEO_BACKEND via
 * the BACKEND env (sleap | legacy) to A/B.
 *
 *   BASE=http://localhost:8085 [BACKEND=sleap] node tests/e2e/video-playback.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const BASE = process.env.BASE || 'http://localhost:8085';
const BACKEND = process.env.BACKEND || '';           // '' = app default
const VIDEO = path.join(REPO, 'sample_session', 'back.mp4');

let failures = 0;
function check(cond, msg) { console.log((cond ? '    ✓ ' : '    ✗ ') + msg); if (!cond) failures++; }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('filechooser', async fc => { await fc.setFiles([VIDEO]); });
page.on('pageerror', e => { if (!/Dockview/.test(e.message)) console.log('    [pageerror] ' + e.message.slice(0, 140)); });

await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 10000 });
await page.waitForFunction(() => window.SleapIO, null, { timeout: 10000 });
if (BACKEND) await page.evaluate(b => localStorage.setItem('LUCID_VIDEO_BACKEND', b), BACKEND);

await page.evaluate(() => document.getElementById('menuLoadVideos').click());
await page.waitForFunction(() => window.__lucid.state.views.length > 0, null, { timeout: 20000 });
await page.waitForTimeout(1200);

const meta = await page.evaluate(() => {
    const s = window.__lucid.state, d = s.views[0] && s.views[0].decoder;
    return { decoder: d ? d.constructor.name : null, totalFrames: s.totalFrames };
});
console.log(`  backend=${BACKEND || '(default)'} decoder=${meta.decoder} totalFrames=${meta.totalFrames}`);
check(meta.totalFrames > 5, `loaded a video with a usable frame count (${meta.totalFrames})`);

// --- SEEK / SCRUB ---
console.log('  seek/scrub:');
for (const N of [5, 15, 3]) {
    const r = await page.evaluate(async (n) => {
        const vc = window.__lucid.videoController, s = window.__lucid.state, d = s.views[0].decoder;
        await vc.seekToFrame(n);
        let bmpW = 0;
        try { const b = await d.getFrame(n); bmpW = b && b.width ? b.width : 0; } catch (e) { /* */ }
        return { cur: s.currentFrame, bmpW };
    }, N);
    check(r.cur === N, `seekToFrame(${N}) → state.currentFrame=${r.cur}`);
    check(r.bmpW > 0, `frame ${N} decodes to a drawable bitmap (w=${r.bmpW})`);
}

// --- PLAYBACK ---
console.log('  playback:');
const play = await page.evaluate(async () => {
    const vc = window.__lucid.videoController, s = window.__lucid.state;
    await vc.seekToFrame(0);
    const seen = new Set();
    let sawStop = false;
    (vc.startPlayback ? vc.startPlayback() : vc.togglePlayback());
    for (let i = 0; i < 120; i++) {           // up to ~3s
        await new Promise(r => setTimeout(r, 25));
        seen.add(s.currentFrame);
        if (!s.isPlaying) { sawStop = true; break; }
    }
    if (s.isPlaying && vc.stopPlayback) vc.stopPlayback();
    return { distinct: seen.size, frames: Array.from(seen).sort((a, b) => a - b), sawStop, stillPlaying: s.isPlaying };
});
console.log(`    visited ${play.distinct} distinct frames: [${play.frames.slice(0, 12)}${play.frames.length > 12 ? '…' : ''}]`);
check(play.distinct >= 3, `playback advanced through ≥3 distinct frames (got ${play.distinct})`);
check(play.sawStop, `playback TERMINATED on its own at end-of-stream (isPlaying → false)`);

await browser.close();
console.log(failures === 0 ? '\nPASS: seek, scrub, and playback all work.' : `\nFAIL: ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
