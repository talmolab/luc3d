/**
 * animal-outlines.mjs — Visibility ▸ Animal Outlines and the Outlines tab's
 * flags on bad outlines (ui/animal-outlines.js, ui/outline-flags-panel.js), in
 * the real app on a two-camera clip of two bright "mice" with tails
 * (tests/fixtures/outline-mice/, cam1 = cam0 mirrored; they touch around
 * frames 40-56).
 *
 *  §1 `O` turns the overlay on; each camera gets an empty arena (the static
 *     bright square belongs to it) and a single-animal area model.
 *  §2 Apart (frame 10): each mouse's body and tail are its own, the floor and
 *     the square nobody's; both cameras.
 *  §3 Touching (frame 48): one blob, a crossing, split by nearest skeleton:
 *     each head stays with its mouse, and each tail too (traced).
 *  §4 A mouse with no detection in a camera (frame 20, cam1) is outlined from
 *     its 3D projected there (source '3d'), not given to the other mouse.
 *  §5 Shift+O over a mouse opens the flag dialog with that mouse chosen; a
 *     reason + note + Enter flags it; the list shows it, a click on a row goes
 *     to its frame, ✕ removes one; the project is marked unsaved.
 *  §6 Export… downloads a ZIP: manifest, README, background, frame, label image
 *     (its labels match the outline) and preview per flagged camera frame.
 *  §7 Save → reopen (eager and lazy readers; eager and streaming writers)
 *     brings the flags back; a project without flags writes no key.
 *  §6c Keypoints off their own outline (A's tail keypoints put on B's tail on
 *     frame 30 in cam0) make a suspect: listed for the frame, found by Check…
 *     over all 90 frames (and nothing else), flagged with one click.
 *  §6b B turns the brush on: a left stroke from mouse A onto the floor draws A
 *     there, a right stroke erases B under it, Cmd/Ctrl+Z undoes; painting
 *     selects no pose; the camera frame shows its correction; Esc stops.
 *  §7b The corrected outline is saved, reopened pixel for pixel, and exported
 *     (edited, with the computed outline beside it).
 *  §8 During playback nothing is computed.
 *
 * Screenshots of the overlay and the flag dialog go to $SHOTS when set.
 * Run: node tests/e2e/animal-outlines.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const FIX = path.join(repoRoot, 'tests', 'fixtures', 'outline-mice');
const SHOTS = process.env.SHOTS || '';
const { unzipStore } = await import(pathToFileURL(path.join(repoRoot, 'import-export', 'outline-export.js')).href);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

async function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}
const PORT = Number(process.env.PORT) || await freePort();
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: repoRoot, stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
    const ok = await new Promise(r => { const c = net.connect(PORT, '127.0.0.1', () => { c.end(); r(true); }); c.on('error', () => r(false)); });
    if (ok) break;
    await new Promise(r => setTimeout(r, 100));
}

// Decode an 8-bit grey PNG made by encodePngGray (one IDAT, filter 0 rows).
function decodeGrayPng(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = 8, w = 0, h = 0; const idat = [];
    while (o < buf.length) {
        const len = dv.getUint32(o), type = String.fromCharCode(...buf.subarray(o + 4, o + 8));
        const data = buf.subarray(o + 8, o + 8 + len);
        if (type === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); }
        if (type === 'IDAT') idat.push(data);
        o += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) px.set(raw.subarray(y * (w + 1) + 1, y * (w + 1) + 1 + w), y * w);
    return { w, h, px };
}

// The mice, as the fixture draws them (cam0; cam1 mirrors x).
const A = (N) => ({ cx: 40 + 2.5 * N, y: 108, dir: 1 });
const B = (N) => ({ cx: 280 - 2.5 * N, y: 128, dir: -1 });
const mx = (cam, x) => cam === 'cam1' ? 319 - x : x;

let browser;
try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;
        console.log('  [console.error]', t.slice(0, 300));
    });
    await page.goto(`http://127.0.0.1:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });
    await page.waitForTimeout(400);

    page.once('filechooser', fc => fc.setFiles([path.join(FIX, 'cam0.mp4'), path.join(FIX, 'cam1.mp4')]));
    await page.evaluate(() => document.getElementById('btnLoadVideos').click());
    await page.waitForFunction(() => window.__lucid.state.views.filter(v => v.decoder && v.decoder.samples && v.decoder.samples.length).length === 2 &&
        document.getElementById('loadingOverlay').classList.contains('hidden'), null, { timeout: 60000 });

    // Poses: a 6-node mouse skeleton; each mouse an ungrouped prediction per camera and frame.
    await page.evaluate(async () => {
        window.__ao = await import('/ui/animal-outlines.js');
        const pd = await import('/pose/pose-data.js');
        const s = window.__lucid.state.session;
        s.skeleton = new pd.Skeleton('mouse', ['Nose', 'Head', 'Trunk', 'TTI', 'Tail_0', 'TailTip'], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]);
        s.tracks = ['A', 'B'];
        // a calibration, so the saved project can reopen lazily (§7)
        const K = [[400, 0, 160], [0, 400, 120], [0, 0, 1]];
        s.cameras = [new pd.Camera('cam0', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [320, 240]),
            new pd.Camera('cam1', K, [0, 0, 0, 0, 0], [0, 0.3, 0], [-100, 0, 0], [320, 240])];
        const pose = (cx, y, dir, cam) => {
            const m = (x) => cam === 'cam1' ? 319 - x : x;
            return [[m(cx + dir * 24), y], [m(cx + dir * 14), y], [m(cx), y], [m(cx - dir * 22), y], [m(cx - dir * 40), y], [m(cx - dir * 60), y]];
        };
        for (let N = 0; N < 90; N++) {
            for (const cam of ['cam0', 'cam1']) {
                s.addUnlinkedInstance(N, cam, new pd.Instance(pose(40 + 2.5 * N, 108, 1, cam), 0, 'predicted', 0.9));
                s.addUnlinkedInstance(N, cam, new pd.Instance(pose(280 - 2.5 * N, 128, -1, cam), 1, 'predicted', 0.9));
            }
        }
        // §4's frame: mouse B is a group with a detection in cam0 only and 3D
        // that projects into cam1 (as `group.reprojections`, what a solve leaves).
        const N = 20, fg = s.getFrameGroup(N);
        const bu = fg.getUnlinkedInstances('cam0').find(u => u.instance.trackIdx === 1);
        fg.removeUnlinkedById(bu.id);
        const b1 = fg.getUnlinkedInstances('cam1').find(u => u.instance.trackIdx === 1);
        fg.removeUnlinkedById(b1.id);
        fg.addInstance('cam0', bu.instance);
        const g = new pd.InstanceGroup(900, -1);
        g.addInstance('cam0', bu.instance);
        g.reprojections = { cam1: pose(280 - 2.5 * N, 128, -1, 'cam1') };
        s.instanceGroups.set(N, [g]);
        // §6c's frame: mouse A's tail keypoints in cam0 lie on mouse B's tail (a bad pose)
        const ua = s.getFrameGroup(30).getUnlinkedInstances('cam0').find(u => u.instance.trackIdx === 0).instance;
        const bx = 280 - 2.5 * 30;
        ua.setPoint(4, bx + 40, 128); ua.setPoint(5, bx + 55, 128);
        window.__lucid.videoController.seekToFrame(10);
    });
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 10, null, { timeout: 15000 });

    // ---------------------------------------------------------------- §1
    console.log('\n§1 O turns the outlines on; empty arenas and area models');
    check(await page.evaluate(() => !document.getElementById('visOutlines').checked), 'off by default');
    await page.mouse.move(5, 5);
    await page.keyboard.press('o');
    check(await page.evaluate(() => document.getElementById('visOutlines').checked), 'O turns Visibility ▸ Animal Outlines on');
    await page.waitForFunction(() => {
        const ao = window.__ao, s = window.__lucid.state.session;
        return ['cam0', 'cam1'].every(c => { const st = ao.outlineCameraState(s, c); return st && (st.status === 'ready' || st.status === 'failed'); });
    }, null, { timeout: 60000, polling: 200 });
    const cams = await page.evaluate(async () => {
        const ao = await import('/ui/animal-outlines.js');
        const s = window.__lucid.state.session;
        return ['cam0', 'cam1'].map(c => {
            const st = ao.outlineCameraState(s, c);
            return { status: st.status, error: st.error, frames: st.frames && st.frames.length, model: st.model, bgSquare: st.bg && st.bg[207 * 320 + (c === 'cam1' ? 319 - 297 : 297)], bgFloor: st.bg && st.bg[20 * 320 + 160], pool: ao.__outlinePoolInfo() };
        });
    });
    for (const [i, c] of cams.entries()) {
        check(c.status === 'ready', `cam${i}: empty arena ready (${c.status}${c.error ? ': ' + c.error : ''}; ${c.frames} frames sampled)`);
        check(c.bgSquare >= 170, `cam${i}: the static bright square is part of the empty arena (${c.bgSquare})`);
        check(c.bgFloor < 60, `cam${i}: the floor is dark in it (${c.bgFloor})`);
        check(c.model && c.model.median > 800 && c.model.median < 1400, `cam${i}: single-animal area ${c.model && Math.round(c.model.median)} ± ${c.model && Math.round(c.model.sd)} px`);
    }
    console.log('  (pool: ' + JSON.stringify(cams[0].pool) + ')');

    async function outlinesAt(frame) {
        await page.evaluate((f) => window.__lucid.videoController.seekToFrame(f), frame);
        await page.waitForFunction((f) => {
            const ao = window.__ao, s = window.__lucid.state.session;
            return window.__lucid.state.currentFrame === f && ['cam0', 'cam1'].every(c => { const d = ao.drawnOutlines(s, c); return d && d.frame === f; });
        }, frame, { timeout: 30000, polling: 100 });
        return page.evaluate(async (f) => {
            const ao = await import('/ui/animal-outlines.js');
            const s = window.__lucid.state.session;
            const out = {};
            for (const c of ['cam0', 'cam1']) {
                const d = ao.drawnOutlines(s, c);
                out[c] = { names: d.animals.map(a => a.name), sources: d.animals.map(a => a.source), blobs: d.result.blobs, labels: Array.from(ao.entryLabels(d)), w: d.w,
                    contours: d.result.contours.map(l => l.length) };
            }
            return out;
        }, frame);
    }
    const lab = (o, cam, x, y) => { const L = o[cam]; const v = L.labels[Math.round(y) * L.w + Math.round(mx(cam, x))]; return v ? L.names[v - 1] : null; };

    // ---------------------------------------------------------------- §2
    console.log('\n§2 apart: bodies and tails are their own mouse\'s');
    const f10 = await outlinesAt(10);
    for (const cam of ['cam0', 'cam1']) {
        const a = A(10), b = B(10);
        check(lab(f10, cam, a.cx, a.y) === 'A' && lab(f10, cam, b.cx, b.y) === 'B', `${cam}: each body is its mouse's`);
        check(lab(f10, cam, a.cx - 45, a.y) === 'A' && lab(f10, cam, b.cx + 45, b.y) === 'B', `${cam}: each tail is its mouse's`);
        check(lab(f10, cam, 297, 207) === null && lab(f10, cam, 160, 20) === null, `${cam}: the floor and the static square are nobody's`);
        check(f10[cam].blobs.length === 2 && f10[cam].blobs.every(b => b.kind === 'individual'), `${cam}: two individual blobs (${f10[cam].blobs.map(b => b.kind)})`);
        check(f10[cam].contours.every(n => n >= 1), `${cam}: an outline per mouse`);
    }
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'outlines-apart.png') }); }

    // ---------------------------------------------------------------- §3
    console.log('\n§3 touching: one crossing blob, split by skeleton, tails traced');
    const f48 = await outlinesAt(48);
    for (const cam of ['cam0', 'cam1']) {
        const a = A(48), b = B(48);
        const crossing = f48[cam].blobs.find(bl => bl.kind === 'crossing');
        check(!!crossing && crossing.animals.length === 2, `${cam}: a crossing blob holding both mice (${f48[cam].blobs.map(bl => bl.kind + ':' + bl.area)})`);
        check(lab(f48, cam, a.cx + 20, a.y) === 'A' && lab(f48, cam, b.cx - 20, b.y) === 'B', `${cam}: each head stays with its mouse`);
        check(lab(f48, cam, a.cx - 45, a.y) === 'A' && lab(f48, cam, b.cx + 45, b.y) === 'B', `${cam}: each tail stays with its mouse`);
    }
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'outlines-touching.png') });

    // ---------------------------------------------------------------- §4
    console.log('\n§4 no detection in a camera: the 3D projected stands in');
    const f20 = await outlinesAt(20);
    const b20 = B(20);
    check(f20.cam1.sources.includes('3d'), 'cam1 at frame 20 has an animal from projected 3D: ' + f20.cam1.sources.join());
    const who = lab(f20, 'cam1', b20.cx, b20.y);
    const idx3d = f20.cam1.sources.indexOf('3d');
    check(who != null && who === f20.cam1.names[idx3d], `cam1: B's blob is outlined as the projected animal (${who})`);
    check(lab(f20, 'cam1', A(20).cx, 108) === 'A', 'cam1: A keeps its own');

    // ---------------------------------------------------------------- §5
    console.log('\n§5 flagging with Shift+O');
    await outlinesAt(45);
    await page.evaluate(() => document.querySelector('.panel-tab[data-tab="tabOutlines"]').click());
    const pt = await page.evaluate(({ x, y }) => {
        const v = window.__lucid.state.views.find(v => v.name === 'cam0');
        const r = v.overlayCanvas.getBoundingClientRect();
        return { x: r.left + x * r.width / v.videoWidth, y: r.top + y * r.height / v.videoHeight };
    }, { x: A(45).cx - 5, y: 108 });
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.move(pt.x + 1, pt.y);
    await page.keyboard.press('Shift+O');
    await page.waitForSelector('.outline-flag-modal', { timeout: 5000 });
    const dlg = await page.evaluate(() => ({
        cam: document.getElementById('outlineFlagCamera').value,
        checked: (() => { const r = document.querySelector('input[name="outlineFlagAnimal"]:checked'); return r ? r.closest('label').textContent.trim() : null; })(),
        okDisabled: document.getElementById('outlineFlagOk').disabled,
    }));
    check(dlg.cam === 'cam0', 'the dialog is for the view under the pointer (cam0)');
    check(dlg.checked === 'A', 'the mouse under the pointer is chosen: ' + dlg.checked);
    check(dlg.okDisabled, 'Flag waits for a reason');
    await page.click('input[name="outlineFlagReason"][value="tail"]');
    await page.fill('#outlineFlagNote', 'tail across B');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'flag-dialog.png') });
    await page.focus('#outlineFlagNote');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.outline-flag-modal'), null, { timeout: 5000 });
    // a second flag from the tab's button, on cam1, "several / not sure"
    await page.evaluate(() => { window.__lucid.interactionManager.lastInteractedView = 'cam1'; window.__lucid.interactionManager.lastCursorPos = null; });
    await page.click('#outlineFlagBtn');
    await page.waitForSelector('.outline-flag-modal');
    await page.click('input[name="outlineFlagReason"][value="bleed"]');
    await page.click('#outlineFlagOk');
    // and an Esc-cancelled one
    await page.keyboard.press('Shift+O');
    await page.waitForSelector('.outline-flag-modal');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.outline-flag-modal'));
    const flags = await page.evaluate(() => ({ list: window.__lucid.state.session.outlineFlags, dirty: window.__lucid.state.isDirty,
        rows: Array.from(document.querySelectorAll('#outlineFlagList .outline-flag-row')).map(r => r.textContent) }));
    check(flags.list.length === 2, 'two flags (Esc flagged nothing): ' + flags.list.length);
    const f0 = flags.list.find(f => f.camera === 'cam0'), f1 = flags.list.find(f => f.camera === 'cam1');
    check(f0 && f0.frame === 45 && f0.animal === 'A' && f0.track === 0 && f0.reason === 'tail' && f0.note === 'tail across B' && f0.source === '2d',
        'cam0 flag: frame 45, A (track 0, its own detection), tail, the note');
    check(f1 && f1.animal === null && f1.reason === 'bleed', 'cam1 flag: several / not sure, bleed');
    check(flags.rows.length === 2 && /^46cam0A/.test(flags.rows[0].replace(/\s+/g, '')), 'the list shows them (frames 1-based): ' + flags.rows[0]);
    check(flags.dirty === true, 'the project is marked unsaved');
    if (SHOTS) {
        await page.screenshot({ path: path.join(SHOTS, 'flag-list.png') });
    }
    await page.evaluate(() => window.__lucid.videoController.seekToFrame(5));
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 5);
    await page.click('#outlineFlagList .outline-flag-row[data-i="0"] td');
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 45, null, { timeout: 10000 }).catch(() => {});
    check(await page.evaluate(() => window.__lucid.state.currentFrame) === 45, 'a click on a row goes to its frame');
    await page.click('#outlineFlagList .outline-flag-del[data-del="1"]');
    check(await page.evaluate(() => window.__lucid.state.session.outlineFlags.length) === 1, '✕ removes a flag');
    await page.click('#outlineFlagBtn');
    await page.waitForSelector('.outline-flag-modal');
    await page.selectOption('#outlineFlagCamera', 'cam1');
    await page.click('input[name="outlineFlagReason"][value="bleed"]');
    await page.click('#outlineFlagOk');

    // ---------------------------------------------------------------- §6c
    console.log('\n§6c suspect outlines: keypoints off their outline');
    const f30 = await outlinesAt(30);
    const sus = await page.evaluate(() => {
        const d = window.__ao.drawnOutlines(window.__lucid.state.session, 'cam0');
        const d1 = window.__ao.drawnOutlines(window.__lucid.state.session, 'cam1');
        return { cam0: d.suspects.map(x => x.reason + ':' + d.animals[x.animal].name + ':' + x.detail), cam1: d1.suspects.length,
            rows: Array.from(document.querySelectorAll('#outlineSuspectList .outline-suspect-row')).map(r => r.textContent) };
    });
    check(sus.cam0.length === 1 && /^tail:A:2 of 2 tail keypoints outside A.s outline \(2 on B.s\)/.test(sus.cam0[0]), 'cam0, frame 30: A\'s tail keypoints are on B\'s tail: ' + sus.cam0.join());
    check(sus.cam1 === 0, 'cam1 (a good pose) has no suspect');
    check(sus.rows.length === 1 && /Tail on the wrong animal/.test(sus.rows[0]), 'the Outlines tab lists it for this frame');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'suspect.png') });
    await page.evaluate(() => window.__lucid.videoController.seekToFrame(0));
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 0);
    await page.fill('#outlineScanN', '90');
    await page.click('#outlineScanBtn');
    await page.waitForFunction(() => document.getElementById('loadingOverlay').classList.contains('hidden') && !document.getElementById('outlineScanBtn').disabled, null, { timeout: 120000 });
    const scan = await page.evaluate(() => {
        const sc = window.__ao.outlineScan(window.__lucid.state.session);
        return { frames: sc && sc.frames, found: sc ? sc.results.map(r => r.frame + ':' + r.camera + ':' + r.reason) : [] };
    });
    check(scan.frames === 90 && scan.found.length === 1 && scan.found[0] === '30:cam0:tail', `Check… over every frame finds just that one (${scan.found.join(' ') || 'none'})`);
    await page.evaluate(() => window.__lucid.videoController.seekToFrame(30));
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 30 && document.querySelector('#outlineSuspectList .outline-suspect-flag'), null, { timeout: 15000 });
    const nFlagsBefore = await page.evaluate(() => window.__lucid.state.session.outlineFlags.length);
    await page.click('#outlineSuspectList .outline-suspect-flag');
    const fl = await page.evaluate(() => window.__lucid.state.session.outlineFlags.find(f => f.frame === 30));
    check(fl && fl.camera === 'cam0' && fl.animal === 'A' && fl.reason === 'tail' && /tail keypoints outside/.test(fl.note), 'Flag turns it into a flag, the reason and the finding as its note');
    check(await page.evaluate(() => document.querySelectorAll('#outlineSuspectList .outline-suspect-flag').length) === 0, 'and the row now reads flagged');
    // keep §6/§7 counts as they were
    await page.evaluate(async () => { const of = await import('/pose/outline-flags.js'); of.removeOutlineFlag(window.__lucid.state.session, { frame: 30, camera: 'cam0', animal: 'A' }); });
    check(await page.evaluate(() => window.__lucid.state.session.outlineFlags.length) === nFlagsBefore, '(flag removed again for the next steps)');

    // ---------------------------------------------------------------- §6
    console.log('\n§6 Export… writes a ZIP of the flagged frames and their outlines');
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#outlineExportBtn')]);
    const zipPath = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'outline-flags-')), 'x.zip');
    await download.saveAs(zipPath);
    check(/^outline-flags_.*\.zip$/.test(download.suggestedFilename()), 'downloaded ' + download.suggestedFilename());
    const files = unzipStore(new Uint8Array(fs.readFileSync(zipPath)));
    const names = files.map(f => f.name);
    const get = (n) => files.find(f => f.name === n);
    check(names.includes('manifest.json') && names.includes('README.txt'), 'manifest.json and README.txt');
    const man = JSON.parse(Buffer.from(get('manifest.json').data).toString('utf8'));
    check(man.format === 'lucid-outline-flags' && man.version === 1 && man.entries.length === 2, 'manifest: format, version, 2 camera frames');
    const e0 = man.entries.find(e => e.camera === 'cam0');
    check(e0 && e0.frame === 45 && e0.files && names.includes(e0.files.frame) && names.includes(e0.files.labels) && names.includes(e0.files.preview),
        'cam0 frame 45: frame, labels and preview files');
    check(names.includes('backgrounds/cam0.png') && names.includes('backgrounds/cam1.png') && man.cameras.cam0 && man.cameras.cam0.area_model,
        'each camera\'s empty arena and area model');
    const png = decodeGrayPng(Buffer.from(get(e0.files.labels).data));
    const lv = png.px[108 * png.w + Math.round(A(45).cx)];
    check(png.w === 320 && png.h === 240 && lv > 0 && e0.animals[lv - 1].name === 'A', 'the label image numbers A\'s pixels as manifest animal ' + lv);
    const bgPng = decodeGrayPng(Buffer.from(get('backgrounds/cam0.png').data));
    check(bgPng.px[207 * 320 + 297] >= 170, 'the background PNG holds the empty arena');

    // ---------------------------------------------------------------- §6b
    console.log('\n§6b the brush: hold left to draw, right to erase, undo');
    await outlinesAt(10);
    const toClient = (cam, x, y) => page.evaluate(({ cam, x, y }) => {
        const v = window.__lucid.state.views.find(v => v.name === cam);
        const r = v.overlayCanvas.getBoundingClientRect();
        return { x: r.left + x * r.width / v.videoWidth, y: r.top + y * r.height / v.videoHeight };
    }, { cam, x, y });
    const labelAt = (cam, x, y) => page.evaluate(({ cam, x, y }) => {
        const d = window.__ao.drawnOutlines(window.__lucid.state.session, cam);
        const L = d && window.__ao.entryLabels(d);
        return L ? L[Math.floor(y) * d.w + Math.floor(x)] : -1;
    }, { cam, x, y });
    await page.mouse.move(5, 5);
    await page.keyboard.press('b');
    check(await page.evaluate(() => document.body.classList.contains('outline-brush-on')), 'B turns the brush on');
    await page.evaluate(async () => (await import('/ui/outline-brush.js')).setBrushRadius(4));
    const a10 = A(10), b10 = B(10);
    check(await labelAt('cam0', a10.cx, 140) === 0, 'before: the floor below A is nobody\'s');
    // left: from A's body down onto the floor
    let p0 = await toClient('cam0', a10.cx, a10.y), p1 = await toClient('cam0', a10.cx, 140);
    await page.mouse.move(p0.x, p0.y); await page.mouse.down({ button: 'left' });
    for (let k = 1; k <= 6; k++) await page.mouse.move(p0.x, p0.y + (p1.y - p0.y) * k / 6);
    await page.mouse.up({ button: 'left' });
    await page.waitForTimeout(150);
    const aLabel = await labelAt('cam0', a10.cx, a10.y);
    check(aLabel > 0 && await labelAt('cam0', a10.cx, 140) === aLabel, 'a left stroke that starts on A draws A onto the floor');
    check(await page.evaluate(() => !window.__lucid.interactionManager.selectedInstanceGroup && !window.__lucid.interactionManager.selectedUnlinked),
        'painting does not select a pose');
    // right: across B's body
    p0 = await toClient('cam0', b10.cx - 6, b10.y); p1 = await toClient('cam0', b10.cx + 6, b10.y);
    await page.mouse.move(p0.x, p0.y); await page.mouse.down({ button: 'right' });
    for (let k = 1; k <= 4; k++) await page.mouse.move(p0.x + (p1.x - p0.x) * k / 4, p0.y);
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(150);
    check(await labelAt('cam0', b10.cx, b10.y) === 0, 'a right stroke erases B under the brush');
    check(await labelAt('cam0', b10.cx + 20, b10.y) > 0, '…and only there');
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForTimeout(150);
    check(await labelAt('cam0', b10.cx, b10.y) > 0, 'Cmd/Ctrl+Z undoes the erase');
    check(await labelAt('cam0', a10.cx, 140) === aLabel, '…and keeps the stroke before it');
    const ed = await page.evaluate(async () => {
        const oe = await import('/pose/outline-edits.js');
        const e = oe.outlineEditAt(window.__lucid.state.session, 10, 'cam0');
        const d = window.__ao.drawnOutlines(window.__lucid.state.session, 'cam0');
        return { edit: !!e, strokes: e && e.undo.length, drawnEdited: !!(d && d.edited), rows: document.querySelectorAll('#outlineEditList .outline-edit-row').length,
            dirty: window.__lucid.state.isDirty, sum: e ? e.labels.reduce((s, v, i) => (s + v * (i % 9973)) % 1000003, 0) : null };
    });
    check(ed.edit && ed.strokes === 1 && ed.drawnEdited, 'the camera frame now shows its corrected outline (one stroke left after the undo)');
    check(ed.rows === 1 && ed.dirty, 'the Outlines tab lists it; the project is unsaved');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'brush.png') });
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => !document.body.classList.contains('outline-brush-on')), 'Esc puts the brush away');
    const editSum = ed.sum;

    // ---------------------------------------------------------------- §7
    console.log('\n§7 save → reopen keeps the flags; no flags, no key');
    const saved = await page.evaluate(async () => {
        const fileio = await import('/import-export/file-io.js');
        const st = window.__lucid.state;
        const labels = fileio.buildSlpLabelsAllViews(st.session, st.views, st.videoFiles);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        const back = await fileio.parseSlpViaSleapIO(new File([bytes], 'x.slp'), () => {});
        const meta = await import('/import-export/outline-flags-metadata.js');
        const pd = await import('/pose/pose-data.js');
        const plain = meta.writeOutlineFlagsMetadata({}, new pd.Session([], st.session.skeleton, [], 'plain'));
        let b64 = '';
        for (let i = 0; i < bytes.length; i += 8192) b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        const oe = back.sessions[0].metadata.lucid.outlineEdits;
        return { flags: back.sessions[0].metadata.lucid.outlineFlags, edits: oe && oe.edits.map(e => e.frame + ':' + e.camera + ':' + e.w + 'x' + e.h), plainKeys: Object.keys(plain), b64: btoa(b64) };
    });
    check(saved.flags && saved.flags.v === 1 && saved.flags.flags.length === 2, 'the eager writer puts both flags in metadata.lucid.outlineFlags');
    check(saved.plainKeys.length === 0, 'a session without flags writes no key');
    check(saved.edits && saved.edits.join() === '10:cam0:320x240', 'the corrected outline is saved too (metadata.lucid.outlineEdits)');
    for (const route of ['eager', 'lazy']) {
        const p2 = await context.newPage();
        p2.on('pageerror', e => { console.log('  [pageerror ' + route + ']', String(e).slice(0, 300)); fails++; });
        await p2.goto(`http://127.0.0.1:${PORT}/index.html`);
        await p2.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });
        const got = await p2.evaluate(async ({ route, b64 }) => {
            const skip = setInterval(() => {
                if (document.getElementById('videoSelectOverlay')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }, 50);
            const file = new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'saved.slp');
            if (route === 'eager') await (await import('/import-export/slp-import.js')).handleLoadSlpFile(file);
            else await (await import('/loading/session-loader.js')).handleLoadProjectSlpLazy(file);
            clearInterval(skip);
            const s = window.__lucid.state.session;
            let again = null;
            if (route === 'lazy') {
                // the streaming writer, from the lazily reopened project
                const sl = await import('/import-export/save-load.js');
                const fileio = await import('/import-export/file-io.js');
                try {
                    const bytes = await sl.saveAllSessionsStreaming([s]);
                    const back = await fileio.parseSlpViaSleapIO(new File([bytes], 'y.slp'), () => {});
                    again = back.sessions[0].metadata.lucid.outlineFlags || null;
                } catch (e) { again = { error: String(e && e.message || e) }; }
            }
            const oe = await import('/pose/outline-edits.js');
            const e = oe.outlineEditAt(s, 10, 'cam0');
            const sum = e ? e.labels.reduce((t, v, i) => (t + v * (i % 9973)) % 1000003, 0) : null;
            return { lazy: !!(s.lazyLoader || s._lazyReopened), flags: s.outlineFlags, again, sum, status: (document.getElementById('statusText') || document.getElementById('status') || {}).textContent };
        }, { route, b64: saved.b64 });
        check(got.lazy === (route === 'lazy'), `${route}: reopened that way` + (got.lazy === (route === 'lazy') ? '' : ' (' + got.status + ')'));
        check(got.flags && got.flags.length === 2 && got.flags.some(f => f.camera === 'cam0' && f.animal === 'A' && f.note === 'tail across B'),
            `${route}: the flags are back on the session`);
        check(got.sum === editSum, `${route}: the corrected outline is back, pixel for pixel`);
        if (route === 'lazy') check(got.again && got.again.flags && got.again.flags.length === 2, 'the streaming writer keeps them too' + (got.again && got.again.error ? ': ' + got.again.error : ''));
        await p2.close();
    }

    console.log('\n§7b the export carries the corrected outline');
    const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#outlineExportBtn')]);
    const zip2 = path.join(path.dirname(zipPath), 'y.zip');
    await dl2.saveAs(zip2);
    const files2 = unzipStore(new Uint8Array(fs.readFileSync(zip2)));
    const man2 = JSON.parse(Buffer.from(files2.find(f => f.name === 'manifest.json').data).toString('utf8'));
    const e10 = man2.entries.find(e => e.frame === 10 && e.camera === 'cam0');
    check(man2.entries.length === 3 && e10 && e10.edited === true && e10.flags.length === 0, 'the corrected camera frame is exported (not flagged, edited)');
    check(e10 && e10.files.labels_auto && files2.some(f => f.name === e10.files.labels_auto), 'with the computed outline beside it');
    const lp = decodeGrayPng(Buffer.from(files2.find(f => f.name === e10.files.labels).data));
    check(lp.px[140 * lp.w + Math.round(A(10).cx)] > 0 && e10.animals[lp.px[140 * lp.w + Math.round(A(10).cx)] - 1].name === 'A', 'its label image holds the stroke as A');

    // ---------------------------------------------------------------- §8
    console.log('\n§8 playback computes nothing');
    const play = await page.evaluate(async () => {
        const ao = await import('/ui/animal-outlines.js');
        const s = window.__lucid.state.session;
        const before = ao.cachedOutlines ? 0 : 0;
        // new poses on frame 71 (Check… cached every frame): an outline drawn there must be computed
        const u = s.getFrameGroup(71).getUnlinkedInstances('cam0')[0].instance;
        u.setPoint(2, u.getX(2) + 1, u.getY(2));
        window.__lucid.state.isPlaying = true;
        window.__lucid.state.currentFrame = 71;
        (await import('/ui/rendering.js')).drawAllOverlays(71);
        await new Promise(r => setTimeout(r, 300));
        const d = ao.drawnOutlines(s, 'cam0');
        window.__lucid.state.isPlaying = false;
        return { drawn70: !!(d && d.frame === 71), before };
    });
    check(!play.drawn70, 'no outline was computed for a frame shown during playback');
} catch (e) {
    console.log('  ✗ threw: ' + (e && e.stack || e));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
