/**
 * occlusion-roundtrip.mjs — end-to-end regression test (real browser).
 *
 * The bug (branch eric/occlusion-skeleton-issue): occluding a node on a user
 * label, saving the project as `.slp`, then reopening the project via
 * "Load Session Folder" dropped the occlusion (and the whole InstanceGroup
 * grouping) — the session-folder single-SLP loader rebuilt the session FLAT
 * from raw poses and ignored the project `.slp`'s `sessions_json`
 * (grouping / per-instance `nulledNodes` / identities). It also ordered the 2D
 * viewers by folder file-enumeration order instead of calibration camera order.
 *
 * This test exercises the real round-trip in headless Chromium:
 *   Phase A — build a project (3 cameras, one grouped user instance whose node
 *             1 is occluded via `nulledNodes`) and SAVE it to `.slp` bytes using
 *             the app's real save path (`buildSlpLabelsAllViews` +
 *             `SleapIO.saveSlpToBytes`).
 *   Phase B — assemble a session folder on disk (project.slp + calibration.toml
 *             + videos/<cam>.mp4 from the sample_session fixtures) and REOPEN it
 *             through the real `handleLoadSessionFolderSingleSlp` path (driving
 *             the folder picker). Then assert the occlusion, grouping, 3D
 *             points, and camera order all came back.
 *
 * How to run (see tests/e2e/README.md):
 *   1. cd tests/e2e && npm install        # playwright + chromium
 *   2. from the repo root: python3 -m http.server 8080
 *   3. node tests/e2e/occlusion-roundtrip.mjs
 *      # or: BASE=http://localhost:8080 node tests/e2e/occlusion-roundtrip.mjs
 *
 * Exit code 0 = all assertions pass, 1 = a regression (or driver error).
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const BASE = process.env.BASE || 'http://localhost:8080';

// Calibration/session camera order is deliberately NON-alphabetical (side,
// back, mid) so the camera-order assertion actually discriminates the fix:
// the folder enumerates videos alphabetically (back, mid, side), so only the
// calibration-index sort produces [side, back, mid].
const CAM_ORDER = ['side', 'back', 'mid'];
const OCCLUDED_NODE = 1;                       // "neck" — it HAS a real position
const PT1 = [300, 400];                        // node-1 xy (must survive)
const POINTS3D = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];

let failures = 0;
function check(cond, msg) {
    if (cond) { console.log('    ✓ ' + msg); }
    else { console.log('    ✗ ' + msg); failures++; }
}

// A valid sleap-io TOML calibration for the three cameras, in CAM_ORDER.
function calibrationToml() {
    const M = '[ [ 1000.0, 0.0, 255.5,], [ 0.0, 1000.0, 255.5,], [ 0.0, 0.0, 1.0,],]';
    let out = '';
    CAM_ORDER.forEach((name, i) => {
        out += `[cam_${i}]\n`;
        out += `name = "${name}"\n`;
        out += `size = [ 512, 512,]\n`;
        out += `matrix = ${M}\n`;
        out += `distortions = [ 0.0, 0.0, 0.0, 0.0, 0.0,]\n`;
        out += `rotation = [ 0.0, ${0.1 * i}, 0.0,]\n`;
        out += `translation = [ ${10 * i}.0, 0.0, 0.0,]\n\n`;
    });
    out += `[metadata]\nadjusted = false\n`;
    return out;
}

// Phase A: build the occluded project in-page and return the .slp bytes.
async function buildOccludedSlpBytes(page) {
    const arr = await page.evaluate(async ({ camNames, occ, pt1, pts3d }) => {
        const [pd, fileio] = await Promise.all([
            import('/pose/pose-data.js'),
            import('/import-export/file-io.js'),
        ]);
        const { Skeleton, Camera, Instance, FrameGroup, InstanceGroup, Session } = pd;
        const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
        const cameras = camNames.map((n, i) =>
            new Camera(n, mtx, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [512, 512]));
        const skeleton = new Skeleton('skeleton', ['nose', 'neck', 'tail'], [[0, 1], [1, 2]]);
        const session = new Session(cameras, skeleton, ['track_0'], 'RoundTrip');
        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const group = new InstanceGroup(1, -1);
        camNames.forEach((cn) => {
            const inst = new Instance([[100, 200], [pt1[0], pt1[1]], [500, 600]], 0, 'user', 1);
            inst.nulledNodes = new Set([occ]);   // occlude node `occ` (it has a real xy)
            fg.addInstance(cn, inst);
            group.addInstance(cn, inst);
        });
        group.points3d = pts3d;
        session.instanceGroups.set(0, [group]);

        const views = camNames.map((n) => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: 100 }));
        const videoFiles = camNames.map((n) => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));

        const labels = fileio.buildSlpLabelsAllViews(session, views, videoFiles);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        return Array.from(bytes);
    }, { camNames: CAM_ORDER, occ: OCCLUDED_NODE, pt1: PT1, pts3d: POINTS3D });
    return Buffer.from(arr);
}

// Assemble the session folder on disk: root .slp + calibration.toml + videos/.
function writeFixture(slpBytes) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-rt-'));
    const fixture = path.join(root, 'roundtrip_session');
    fs.mkdirSync(path.join(fixture, 'videos'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'project.slp'), slpBytes);
    fs.writeFileSync(path.join(fixture, 'calibration.toml'), calibrationToml());
    for (const cam of CAM_ORDER) {
        fs.copyFileSync(
            path.join(REPO, 'sample_session', cam + '.mp4'),
            path.join(fixture, 'videos', cam + '.mp4'));
    }
    return { root, fixture };
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    let tmpRoot = null;
    try {
        const page = await browser.newPage();
        page.on('pageerror', e => { console.log('    [pageerror] ' + e.message); failures++; });
        await page.goto(BASE, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 20000 });
        await page.waitForTimeout(400);

        console.log('  Phase A: build + occlude + save project .slp');
        const slpBytes = await buildOccludedSlpBytes(page);
        check(slpBytes.length > 0, `saved a non-empty .slp (${slpBytes.length} bytes)`);

        const { root, fixture } = writeFixture(slpBytes);
        tmpRoot = root;
        console.log('  Phase B: reopen the session folder (real load path)');

        // The folder picker (pickFolder) opens a webkitdirectory <input>; feed
        // it the fixture directory. Playwright sets webkitRelativePath for each
        // file under it (roundtrip_session/...), which the loader scans.
        page.once('filechooser', async fc => { await fc.setFiles(fixture); });
        // Fire the real reopen path and wait for it to finish (video decode incl).
        await page.evaluate(async () => {
            const m = await import('/loading/session-loader.js');
            await m.handleLoadSessionFolderSingleSlp();
        });

        // Wait for the 3 views + the restored instance group.
        await page.waitForFunction(() => {
            const s = window.__lucid.state;
            const g = s.session && s.session.instanceGroups.get(0);
            return s.views.length >= 3 && g && g.length > 0;
        }, null, { timeout: 40000 }).catch(() => {});

        const res = await page.evaluate(({ cam }) => {
            const s = window.__lucid.state;
            const sess = s.session;
            const groups = (sess && sess.instanceGroups.get(0)) || [];
            const g = groups[0];
            const inst = g && g.instances.get(cam);
            return {
                views: s.views.map(v => v.name),
                groupCount: groups.length,
                nulled: inst && inst.nulledNodes ? Array.from(inst.nulledNodes) : null,
                pt1: inst ? inst.points[1] : null,
                points3d: g ? g.points3d : null,
            };
        }, { cam: CAM_ORDER[0] });

        console.log('    state:', JSON.stringify(res));

        // 1) The InstanceGroup grouping survived (was dropped entirely before).
        check(res.groupCount >= 1, 'the project .slp\'s InstanceGroup was restored (grouping not dropped)');

        // 2) THE bug: the occluded node came back flagged as occluded.
        check(res.nulled != null && res.nulled.includes(OCCLUDED_NODE),
            `occluded node ${OCCLUDED_NODE} restored in nulledNodes (got ${JSON.stringify(res.nulled)})`);

        // 3) The occluded node keeps its real position (not NaN / not dropped).
        check(res.pt1 != null && Math.abs(res.pt1[0] - PT1[0]) < 1 && Math.abs(res.pt1[1] - PT1[1]) < 1,
            `occluded node keeps its position ~${JSON.stringify(PT1)} (got ${JSON.stringify(res.pt1)})`);

        // 4) 3D points round-tripped.
        check(res.points3d != null && Math.abs(res.points3d[0][0] - POINTS3D[0][0]) < 1e-6,
            `group 3D points restored (got ${JSON.stringify(res.points3d && res.points3d[0])})`);

        // 5) Camera order follows calibration order. NOTE: this is a best-effort
        // invariant, not a strong guard for the ordering fix — the real bug
        // depends on OS folder-enumeration order, which Playwright's directory
        // upload does not reproduce (it tends to enumerate in calibration order
        // anyway). The occlusion/grouping round-trip (checks 1–4) is the guard.
        check(JSON.stringify(res.views) === JSON.stringify(CAM_ORDER),
            `2D viewers in calibration camera order ${JSON.stringify(CAM_ORDER)} (got ${JSON.stringify(res.views)})`);

        await page.close();
    } finally {
        await browser.close();
        if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
}

await main();
console.log(failures === 0
    ? '\nPASS: occlusion + grouping + camera order survive the project .slp round-trip.'
    : `\nFAIL: ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
