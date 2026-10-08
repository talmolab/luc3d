/**
 * _real-single-camera.mjs — single-camera Track All + ID-switch checks on a REAL
 * SLEAP predictions file, through the real File ▸ Load SLP path (an
 * investigation tool, not a suite test: it needs a local .slp + its video).
 *
 *   SLP=<predictions.slp> VIDEO=<its .mp4> N=<animals> [IMAGE=1] [OUT=<result.json>] [HEADED=1] \
 *     node tests/e2e/_real-single-camera.mjs
 *
 * Opens the .slp with Load SLP (the File System Access pickers are removed so
 * the app falls back to plain file inputs, which Playwright answers), picks the
 * video with "Select Video Files", answers Track All's animal-count prompt with
 * N, waits for Track All and its automatic checks (coat brightness on one
 * camera, per the Tracking Wizard), optionally runs Tracks ▸
 * Check ID Switches (Images), and writes OUT: every detection's frame, its
 * position in the frame's instance list, its new track and two coordinates (to
 * join it to other copies of the file), plus every scored encounter and the
 * ID Switches tab's rows.
 *
 * SAVE=<file.slp> then saves the project (File ▸ Save, downloaded since the
 * File System Access pickers are gone) to that path, to check what SLEAP reads.
 *
 * ROUTE_CHECK=<file> serves that file in place of pose/id-switch-check.js (to
 * measure an unmerged version of the checks on the same tracking).
 *
 * Real Chrome (HEVC). Headless by default; HEADED=1 takes the machine-wide
 * browser lock (scripts/browser-lock.mjs).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8291);
const { SLP, VIDEO } = process.env;
const N = process.env.N || '3';
if (!SLP || !VIDEO) { console.error('set SLP=<predictions.slp> VIDEO=<video.mp4>'); process.exit(2); }
const HEADED = process.env.HEADED === '1';
const t0 = Date.now(), el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const log = m => console.log(`[${el()}] ${m}`);

let release = async () => {};
if (HEADED) {
    const { acquireBrowserLock } = await import(path.join(repoRoot, 'scripts', 'browser-lock.mjs'));
    release = await acquireBrowserLock({ label: '_real-single-camera' });
}
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
let browser;
try {
    browser = await chromium.launch({ channel: 'chrome', headless: !HEADED, args: ['--enable-unsafe-webgpu'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    await page.addInitScript(() => { delete window.showOpenFilePicker; delete window.showDirectoryPicker; delete window.showSaveFilePicker; });
    page.on('pageerror', e => log('[pageerror] ' + String(e).slice(0, 300)));
    page.on('dialog', d => { log('[dialog] ' + d.message().slice(0, 100)); d.accept(N); });
    page.on('console', m => { const t = m.text(); if (/TrackAll|id-switch|error/i.test(t)) log('[console] ' + t.slice(0, 200)); });
    if (process.env.ROUTE_CHECK) {
        const body = fs.readFileSync(process.env.ROUTE_CHECK, 'utf8');
        await page.route(/\/pose\/id-switch-check\.js(\?.*)?$/, r => r.fulfill({ body, contentType: 'text/javascript' }));
    }
    const files = [SLP, VIDEO];
    page.on('filechooser', fc => { const f = files.shift(); log('[filechooser] ' + path.basename(f)); fc.setFiles(f); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 30000 });
    await page.evaluate(() => document.getElementById('menuLoadSlp').click());
    await page.getByText('Select Video Files').click({ timeout: 60000 });
    await page.waitForFunction(() => {
        const s = window.__lucid.state;
        return s.session && s.views && s.views.length && s.views.every(v => v.decoder && v.decoder.samples && v.decoder.samples.length);
    }, { timeout: 300000 });
    const info = await page.evaluate(() => {
        const s = window.__lucid.state, ses = s.session;
        return { cameras: ses.cameras.map(c => c.name), views: s.views.map(v => v.cameraName || v.name), frames: ses.frameGroups.size,
                 tracks: ses.tracks.length, fps: s.fps };
    });
    log('loaded: ' + JSON.stringify(info));

    const status = () => page.evaluate(() => (document.getElementById('statusText') || document.getElementById('status') || {}).textContent || '');
    await page.evaluate(() => document.getElementById('tbTrackAll').click());
    await page.waitForFunction(() => /Tracked \d+ animal|Track All error/.test(((document.getElementById('statusText') || document.getElementById('status') || {}).textContent) || ''), { timeout: 600000 });
    // the automatic checks append to the same status line (on one camera: coat brightness, after a note about size)
    await page.waitForFunction(() => /ID-switch check \((body size|coat brightness|images)\): (?!not run)/.test(((document.getElementById('statusText') || document.getElementById('status') || {}).textContent) || ''), { timeout: 900000 }).catch(() => {});
    log('status: ' + await status());

    if (process.env.IMAGE === '1') {
        const tImg = Date.now();
        await page.evaluate(async () => { const m = await import('/ui/id-switch-modal.js'); await m.runIdSwitchChecks({ image: true }); });
        log('image check done in ' + ((Date.now() - tImg) / 1000).toFixed(0) + ' s: ' + await status());
    }

    const out = await page.evaluate(() => {
        const s = window.__lucid.state, ses = s.session, cam = ses.cameras[0].name, det = [];
        const keys = Array.from(ses.frameGroups.keys()).sort((a, b) => a - b);
        for (const f of keys) {
            const fg = ses.frameGroups.get(f);
            const list = (fg.instances.get(cam) || []).concat((fg.unlinkedInstances.get(cam) || []).map(u => u.instance));
            list.forEach((inst, q) => {
                let a = -1; for (let k = 0; k < inst.numNodes; k++) if (inst.hasPoint(k)) { a = k; break; }
                det.push([f, q, inst.trackIdx == null ? -1 : inst.trackIdx, a, a >= 0 ? inst.getX(a) : NaN, a >= 0 ? inst.getY(a) : NaN,
                          ses.getIdentityIdForUnlinkedInstance(cam, inst, f) ?? -1]);
            });
        }
        const st = ses._idSwitch, results = {};
        if (st) for (const [cue, r] of Object.entries(st.results)) {
            results[cue] = r && r.ok ? { encounters: r.encounters.map(e => ({ frame: e.frame, startFrame: e.startFrame, a: e.identityA, b: e.identityB, score: e.score, flagged: e.flagged, kind: e.kind || null })),
                                       changes: r.changes.map(e => ({ frame: e.frame, a: e.identityA, b: e.identityB, kind: e.kind, look: e.look || null })),
                                       flags: r.flags.map(e => ({ frame: e.frame, startFrame: e.startFrame, a: e.identityA, b: e.identityB, kind: e.kind || null, continues: !!e.continues, look: e.look || null, score: e.score })),
                                       moments: (r.moments || []).map(e => ({ frame: e.frame, startFrame: e.startFrame, a: e.identityA, b: e.identityB, score: e.score, side: e.side, look: e.look })),
                                       candidates: (ses._idSwitchCandidates || []).length,
                                       sampleHz: r.sampleHz, closeDistance: r.closeDistance,
                                       timing: r.timing || null, crops: r.crops || null, debug: r._debug || null }
                                    : { ok: false, reason: r && r.reason };
        }
        return { tracks: ses.tracks, identities: ses.identities.map(i => i.name), det, results };
    });
    log(`tracks ${out.tracks.length}, identities ${out.identities.length}, detections ${out.det.length}; checks: ` +
        Object.entries(out.results).map(([c, r]) => c + ' ' + (r.encounters ? r.encounters.length + ' encounters' : r.reason)).join(', '));
    if (process.env.OUT) { fs.writeFileSync(process.env.OUT, JSON.stringify(Object.assign({ info }, out))); log('wrote ' + process.env.OUT); }
    if (process.env.SAVE) {
        const [dl] = await Promise.all([
            page.waitForEvent('download', { timeout: 600000 }),
            page.evaluate(async () => { const m = await import('/import-export/save-load.js'); await m.saveProjectSlp(); }),
        ]);
        await dl.saveAs(process.env.SAVE);
        log('saved ' + process.env.SAVE + ': ' + await status());
    }
} finally {
    if (browser) await browser.close();
    server.kill();
    await release();
}
