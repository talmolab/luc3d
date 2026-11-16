/**
 * occlusion-roundtrip.mjs — end-to-end regression test (real browser).
 *
 * The bug (branch eric/occlusion-skeleton-issue): occluding a node on a user
 * label, saving the project as `.slp`, then reopening the project dropped the
 * occlusion. Two distinct failure modes, both covered here:
 *
 *   GROUPED   — an occluded node on an instance that IS in an InstanceGroup.
 *               Was dropped because the session-folder loader rebuilt the
 *               session FLAT and ignored the project `.slp`'s `sessions_json`
 *               (grouping / per-instance `nulledNodes`). Fixed by routing that
 *               loader through the shared `restoreGroupingAndUnlink`.
 *   UNLINKED  — an occluded node on an UNGROUPED (unlinked) user instance, e.g.
 *               a prediction converted to a user label that was never grouped.
 *               `buildSlpLabelsAllViews` only writes the `nulledNodes` FLAG for
 *               grouped instances, so the flag was lost — even though the point
 *               is saved as finite-xy + visible:false (the occlusion IS in the
 *               file). Fixed by reconstructing `nulledNodes` from that
 *               finite-but-invisible signal on load (pass-1 build).
 *
 * Each scenario: build the project in-page, SAVE it to `.slp` via the app's
 * real save path (`buildSlpLabelsAllViews` + `SleapIO.saveSlpToBytes`),
 * assemble a session folder (project.slp + calibration.toml + videos/<cam>.mp4
 * from sample_session), then REOPEN it through the real
 * `handleLoadSessionFolderSingleSlp` and assert the occlusion survives.
 *
 * How to run (see tests/e2e/README.md):
 *   1. cd tests/e2e && npm install
 *   2. from the repo root: python3 -m http.server 8080
 *   3. node tests/e2e/occlusion-roundtrip.mjs
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

const CAM_ORDER = ['side', 'back', 'mid'];
const OCCLUDED_NODE = 1;                        // "neck" — it HAS a real position
const PT1 = [300, 400];                         // node-1 xy (must survive)
const POINTS3D = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];

let failures = 0;
function check(cond, msg) {
    if (cond) { console.log('    ✓ ' + msg); }
    else { console.log('    ✗ ' + msg); failures++; }
}

function calibrationToml() {
    const M = '[ [ 1000.0, 0.0, 255.5,], [ 0.0, 1000.0, 255.5,], [ 0.0, 0.0, 1.0,],]';
    let out = '';
    CAM_ORDER.forEach((name, i) => {
        out += `[cam_${i}]\nname = "${name}"\nsize = [ 512, 512,]\n`;
        out += `matrix = ${M}\ndistortions = [ 0.0, 0.0, 0.0, 0.0, 0.0,]\n`;
        out += `rotation = [ 0.0, ${0.1 * i}, 0.0,]\ntranslation = [ ${10 * i}.0, 0.0, 0.0,]\n\n`;
    });
    out += `[metadata]\nadjusted = false\n`;
    return out;
}

// Build the occluded project in-page and return the .slp bytes.
// mode: 'grouped' → instance lives in an InstanceGroup;
//       'unlinked' → instance is an ungrouped (unlinked) user label.
async function buildOccludedSlpBytes(page, mode) {
    const arr = await page.evaluate(async ({ camNames, occ, pt1, pts3d, mode }) => {
        const [pd, fileio] = await Promise.all([
            import('/pose/pose-data.js'),
            import('/import-export/file-io.js'),
        ]);
        const { Skeleton, Camera, Instance, UnlinkedInstance, FrameGroup, InstanceGroup, Session } = pd;
        const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
        const cameras = camNames.map((n, i) =>
            new Camera(n, mtx, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [512, 512]));
        const skeleton = new Skeleton('skeleton', ['nose', 'neck', 'tail'], [[0, 1], [1, 2]]);
        const session = new Session(cameras, skeleton, ['track_0'], 'RoundTrip');
        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);

        if (mode === 'grouped') {
            const group = new InstanceGroup(1, -1);
            camNames.forEach((cn) => {
                const inst = new Instance([[100, 200], [pt1[0], pt1[1]], [500, 600]], 0, 'user', 1);
                inst.nulledNodes = new Set([occ]);
                fg.addInstance(cn, inst);
                group.addInstance(cn, inst);
            });
            group.points3d = pts3d;
            session.instanceGroups.set(0, [group]);
        } else {
            // UNLINKED: a user instance occluded but never grouped.
            camNames.forEach((cn) => {
                const inst = new Instance([[100, 200], [pt1[0], pt1[1]], [500, 600]], 0, 'user', 1);
                inst.nulledNodes = new Set([occ]);
                fg.addUnlinkedInstance(cn, new UnlinkedInstance(inst, cn));
            });
        }

        const views = camNames.map((n) => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: 100 }));
        const videoFiles = camNames.map((n) => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const labels = fileio.buildSlpLabelsAllViews(session, views, videoFiles);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        return Array.from(bytes);
    }, { camNames: CAM_ORDER, occ: OCCLUDED_NODE, pt1: PT1, pts3d: POINTS3D, mode });
    return Buffer.from(arr);
}

function writeFixture(slpBytes) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-rt-'));
    const fixture = path.join(root, 'roundtrip_session');
    fs.mkdirSync(path.join(fixture, 'videos'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'project.slp'), slpBytes);
    fs.writeFileSync(path.join(fixture, 'calibration.toml'), calibrationToml());
    for (const cam of CAM_ORDER) {
        fs.copyFileSync(path.join(REPO, 'sample_session', cam + '.mp4'),
            path.join(fixture, 'videos', cam + '.mp4'));
    }
    return { root, fixture };
}

// Reopen the fixture folder via the real load path and read back the occlusion
// state for camera CAM_ORDER[0], whether the instance came back grouped or
// unlinked.
async function reopenAndInspect(page, fixture) {
    page.once('filechooser', async fc => { await fc.setFiles(fixture); });
    await page.evaluate(async () => {
        const m = await import('/loading/session-loader.js');
        await m.handleLoadSessionFolderSingleSlp();
    });
    await page.waitForFunction(() => {
        const s = window.__lucid.state;
        if (s.views.length < 3) return false;
        const fg = s.session && s.session.frameGroups.get(0);
        return !!fg;
    }, null, { timeout: 40000 }).catch(() => {});

    return await page.evaluate(({ cam }) => {
        const s = window.__lucid.state;
        const sess = s.session;
        const fg = sess && sess.frameGroups.get(0);
        // Look for the instance in a group first, else in the unlinked pool.
        let inst = null, grouped = false;
        const groups = (sess && sess.instanceGroups.get(0)) || [];
        if (groups[0] && groups[0].instances.get(cam)) { inst = groups[0].instances.get(cam); grouped = true; }
        if (!inst && fg) {
            const uls = fg.getUnlinkedInstances(cam) || [];
            if (uls[0]) inst = uls[0].instance;
        }
        return {
            views: s.views.map(v => v.name),
            found: !!inst,
            grouped,
            nulled: inst && inst.nulledNodes ? Array.from(inst.nulledNodes) : null,
            pt1: inst ? inst.getPoint(1) : null,
        };
    }, { cam: CAM_ORDER[0] });
}

async function runScenario(browser, label, mode) {
    console.log(`  Scenario ${label} (${mode}): build + occlude + save, then reopen`);
    const page = await browser.newPage();
    let tmpRoot = null;
    try {
        page.on('pageerror', e => { console.log('    [pageerror] ' + e.message); failures++; });
        await page.goto(BASE, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 20000 });
        await page.waitForTimeout(400);

        const slpBytes = await buildOccludedSlpBytes(page, mode);
        check(slpBytes.length > 0, `saved a non-empty .slp (${slpBytes.length} bytes)`);

        const { root, fixture } = writeFixture(slpBytes);
        tmpRoot = root;
        const res = await reopenAndInspect(page, fixture);
        console.log('    state:', JSON.stringify(res));

        check(res.found, 'the occluded instance was restored on reopen');
        check(res.nulled != null && res.nulled.includes(OCCLUDED_NODE),
            `occluded node ${OCCLUDED_NODE} restored in nulledNodes (got ${JSON.stringify(res.nulled)})`);
        check(res.pt1 != null && Math.abs(res.pt1[0] - PT1[0]) < 1 && Math.abs(res.pt1[1] - PT1[1]) < 1,
            `occluded node keeps its position ~${JSON.stringify(PT1)} (got ${JSON.stringify(res.pt1)})`);
    } finally {
        await page.close();
        if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        await runScenario(browser, 'A', 'grouped');
        await runScenario(browser, 'B', 'unlinked');
    } finally {
        await browser.close();
    }
}

await main();
console.log(failures === 0
    ? '\nPASS: occlusion survives the project .slp round-trip (grouped + unlinked).'
    : `\nFAIL: ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
