/**
 * reopen-folder-session-settings.mjs — a project `.slp` reopened through
 * File ▸ Load Single Session Folder ("single-slp" mode,
 * `handleLoadSessionFolderSingleSlp`) brings back every per-session setting
 * saved in its `metadata.lucid`.
 *
 * That loader builds its Session by hand and used to restore only what
 * `restoreGroupingAndUnlink` reads (identities, trustTracks, frameIdentityMap,
 * grouping). It never called `readVisibilityMetadata` or `readPlaneMetadata`,
 * so a project reopened this way silently came back with default brightness /
 * contrast / rotation, nothing hidden, no ID Switches checklist and no planes —
 * while every other project reader restored them. This drives the real app:
 *
 *  1. Load a seed project through the folder loader (real videos, real views),
 *     change every Visibility setting and build Define Planes state on it, and
 *     save through the real `saveAs()` -> `buildSlpBytes` writer. Every key in
 *     VISIBILITY_METADATA_KEYS and PLANE_METADATA_KEYS must be in the file, so
 *     a failure below is the reader's and not the writer's.
 *  2. In a fresh page, reopen that folder. Each setting comes back on the
 *     session, and the ones that are drawn reach the screen: the canvas CSS
 *     filter, `view.rotation` (which the renderer and hit-testing read) and
 *     the model's attached placements. Stale planes left in the empty app are
 *     REPLACED — the `resetPlaneState()` negative control; without it
 *     `readPlaneMetadata` refuses to restore into a non-empty model.
 *  3. The same loader is also the Sessions list's "Add session folder": it ADDS
 *     a session rather than replacing the project. Adding the same project's
 *     folder again must keep the open planes (no wipe, no duplicated nodes),
 *     give the new session its own settings, and seat its 2D on the open nodes.
 *  4. Adding a folder from a DIFFERENT project must leave the open planes alone
 *     and must NOT seat the file's 2D: plane-node IDs are minted per project
 *     from 1, so the other file's node 1 would land on this project's node 1.
 *     Negative control: `readPlaneMetadata` alone does seat them.
 *
 * Run: node reopen-folder-session-settings.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8218);
const VIDEO = path.join(repoRoot, 'tests', 'fixtures', 'barcode-60', 'barcode-60.mp4');
const CAMS = ['camA', 'camB'];

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A session folder: `<name>/project.slp` + `<name>/videos/<cam>.mp4`. */
function writeFolder(root, name, slpBytes) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'videos'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.slp'), slpBytes);
    for (const cam of CAMS) fs.copyFileSync(VIDEO, path.join(dir, 'videos', cam + '.mp4'));
    return dir;
}

async function openApp(page) {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 20000 });
}

/** Reopen `dir` through the real loader, answering its folder picker. */
async function loadFolder(page, dir) {
    page.once('filechooser', fc => fc.setFiles(dir));
    await page.evaluate(async () => {
        const m = await import('/loading/session-loader.js');
        await m.handleLoadSessionFolderSingleSlp();
    });
}

/**
 * Build a small calibrated project `.slp` in the page (runs in the browser).
 * With `spec.planes`, the page's plane model gets a plane of its own first —
 * used for the "another project" file, built in a page of its own.
 */
async function buildProjectSlp(spec) {
    const pd = await import('/pose/pose-data.js');
    const AS = await import('/ui/app-state.js');
    const fileio = await import('/import-export/file-io.js');
    const vf = await import('/ui/video-filters.js');
    const P = await import('/ui/plane-definition.js');
    const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
    const K = [[500, 0, 128], [0, 500, 16], [0, 0, 1]];
    const cams = spec.cams.map((n, i) =>
        new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [256, 32]));
    const s = new Session(cams, new Skeleton('skeleton', ['n0', 'n1', 'n2'], [[0, 1], [1, 2]]),
        ['t0', 't1'], spec.name);
    const ids = ['mouseA', 'mouseB'].map(n => s.addIdentity(n).id);
    for (let f = 0; f < 3; f++) {
        const fg = new FrameGroup(f); s.addFrameGroup(fg);
        const groups = [0, 1].map(t => {
            const g = new InstanceGroup(f * 10 + t + 1, ids[t]);
            for (const cn of spec.cams) {
                const inst = new Instance([[20 + t * 60 + f, 8], [30 + t * 60, 12], [40 + t * 60, 16]], t, 'user', 1);
                g.addInstance(cn, inst); fg.addInstance(cn, inst);
            }
            g.points3d = [[t, 0, 1], [t, 1, 1], [t, 2, 1]];
            return g;
        });
        s.instanceGroups.set(f, groups);
    }
    for (const cn of Object.keys(spec.brightness || {})) vf.setSessionBrightness(s, cn, spec.brightness[cn]);
    const views = spec.cams.map(n => ({ name: n, videoWidth: 256, videoHeight: 32, frameCount: 60 }));
    if (spec.planes) {
        AS.state.session = s; AS.state.sessions = [s]; AS.state.views = views;
        const model = P.planeModel();
        const other = P.createPlane('other-plane');
        const nodes = ['x0', 'x1', 'x2'].map(n => model.createNodeInPlane(n, other));
        P.placePlaneOnView(other, 'camA', 100, 16);
        const inst = model.getInstance('camA');
        nodes.forEach((n, k) => inst.setPoint(model.pool.indexOf(n.id), 90 + 10 * k, 10 + k));
    }
    const labels = fileio.buildSlpLabelsAllViews(s, views,
        spec.cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' })));
    return Array.from(await window.SleapIO.saveSlpToBytes(labels));
}

/** Every visibility / plane key in a parsed file's first session (browser). */
async function fileKeys(bytes) {
    const fileio = await import('/import-export/file-io.js');
    const vmeta = await import('/import-export/visibility-metadata.js');
    const PM = await import('/import-export/plane-metadata.js');
    const slpData = await fileio.parseSlpViaSleapIO(new File([new Uint8Array(bytes)], 'project.slp'), () => {});
    const sd = (slpData.sessions || [])[0];
    const lucid = (sd && sd.metadata && sd.metadata.lucid) || {};
    const has = k => Object.prototype.hasOwnProperty.call(lucid, k);
    return {
        visibility: vmeta.VISIBILITY_METADATA_KEYS.filter(has),
        planes: PM.PLANE_METADATA_KEYS.filter(has),
        declaredVisibility: vmeta.VISIBILITY_METADATA_KEYS,
        declaredPlanes: PM.PLANE_METADATA_KEYS,
        placementNodeIds: (lucid.planePlacements || []).flatMap(p => (p.points || []).map(e => e.n)),
        lucid,
    };
}

/**
 * What the writers would store for `session` right now (browser). Comparing
 * these before save and after reopen covers every key each module owns.
 */
async function settingsOf(sessionIdx) {
    const AS = await import('/ui/app-state.js');
    const vmeta = await import('/import-export/visibility-metadata.js');
    const PM = await import('/import-export/plane-metadata.js');
    const s = AS.state.sessions[sessionIdx];
    const planes = PM.writePlaneMetadata({}, s);
    return {
        visibility: vmeta.writeVisibilityMetadata({}, s),
        project: { planeNodes: planes.planeNodes, planes: planes.planes,
                   meshObjects: planes.meshObjects, planeOrigin: planes.planeOrigin },
        placements: planes.planePlacements || null,
    };
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-folder-settings-'));
let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;   // absent demo assets
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });

    // =================================================================
    // 1. Load a project, change everything, save through the real writer
    // =================================================================
    await openApp(page);
    const seedDir = writeFolder(tmpRoot, 'seed_session',
        Buffer.from(await page.evaluate(buildProjectSlp, { name: 'Seed', cams: CAMS })));
    await loadFolder(page, seedDir);

    const saved = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const vf = await import('/ui/video-filters.js');
        const P = await import('/ui/plane-definition.js');
        const O = await import('/ui/origin-definition.js');
        const review = await import('/ui/id-switch-review.js');
        const saveLoad = await import('/import-export/save-load.js');
        const s = AS.state.session;
        const out = { sessions: AS.state.sessions.length, views: AS.state.views.map(v => v.name) };

        // ---- Visibility: brightness, contrast, rotation, the hidden sets ----
        vf.setSessionBrightness(s, 'camA', 150);
        vf.setSessionContrast(s, 'camB', -40);
        vf.setSessionRotation(s, 'camB', 90);
        window.TimelineVisibility.toggleCameraVisibility(s, 'camB');
        window.TimelineVisibility.toggleTrackVisibility(s, 't1');
        window.TimelineVisibility.toggleIdentityVisibility(s, 'mouseB');
        // The animal count rides the same module once `numAnimals` is a
        // declared key (talmolab/luc3d#312). Until then nothing writes it, and
        // the checks below compare only the keys the module declares.
        s.numAnimals = 3;

        // ---- the ID Switches checklist (shapes as in pose/id-switch-check.js) ----
        const pt = (frame, a, b, score, extra) => Object.assign(
            { frame, nameA: a, nameB: b, identityA: a, identityB: b, score }, extra || {});
        const results = {
            size: { ok: true, encounters: new Array(12).fill(0), sampleHz: 15, step: 4, fps: 60, fpsFromVideo: true,
                    flags: [pt(20, 'mouseA', 'mouseB', -40.5), pt(41, 'mouseA', 'mouseB', -9, { followOf: 20 })],
                    changes: [pt(55, 'mouseA', 'mouseB', 2.5, { kind: 'end' })] },
        };
        review.linkIdSwitchResults(results);
        s._idSwitch = { results, reviewed: new Set([review.idSwitchRowKey(results.size.flags[0])]),
                        showRepeats: false, current: null };

        // ---- Define Planes: two planes sharing an edge, 2D on both views,
        //      a fit, a mesh object and an origin ----
        const model = P.planeModel();
        const floor = P.createPlane('floor');
        const wall = P.createPlane('wall');
        const a0 = model.createNodeInPlane('a0', floor);
        const s0 = model.createNodeInPlane('s0', floor);
        const s1 = model.createNodeInPlane('s1', floor);
        model.addNodeToPlane(wall, s0.id);
        model.addNodeToPlane(wall, s1.id);
        const b0 = model.createNodeInPlane('b0', wall);
        floor.addEdge(a0.id, s0.id);
        floor.addEdge(s0.id, s1.id);
        floor.filled = true;
        a0.setPoint3d([0, 0, 0]); s0.setPoint3d([10, 0, 0]); s1.setPoint3d([10, 10, 0]);
        floor.planeFit = { centroid: [20 / 3, 10 / 3, 0], normal: [0, 0, 1], rms: 0.01, nPoints: 3 };
        P.placePlaneOnView(floor, 'camA', 60, 16);
        P.placePlaneOnView(wall, 'camB', 120, 16);
        const iA = model.getInstance('camA');
        const iB = model.getInstance('camB');
        [[a0, 50.5, 8.25], [s0, 60, 12], [s1, 70, 20]].forEach(([n, x, y]) => iA.setPoint(model.pool.indexOf(n.id), x, y));
        [[s0, 110, 9], [b0, 130, 22]].forEach(([n, x, y]) => iB.setPoint(model.pool.indexOf(n.id), x, y));
        iB.nulledNodes.add(model.pool.indexOf(s1.id));
        model.meshObjects.createObject('cage').addPlane(floor.id);
        const frame = (await import('/pose/origin-frame.js')).buildOriginFrame([10, 10, 0], [0, 0, 1]);
        frame.sourcePlane = 'floor'; frame.sourceNode = 's1';
        O.originState.frame = frame;
        out.nodeIds = model.pool.ids();

        // ---- save through the real Save As path, into a stand-in file handle
        //      (headless Chromium rejects the real picker with AbortError) ----
        const chunks = [];
        window.showSaveFilePicker = async () => ({
            name: 'project.slp',
            createWritable: async () => ({
                write: async (c) => { chunks.push(new Uint8Array(c.buffer ? c.slice(0) : c)); },
                close: async () => {},
                abort: async () => {},
            }),
        });
        await saveLoad.saveAs();
        out.status = document.getElementById('statusText') ? document.getElementById('statusText').textContent : '';
        out.cleanAfterSave = AS.state.isDirty === false;
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const bytes = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
        out.bytes = Array.from(bytes);
        return out;
    });
    const expected = await page.evaluate(settingsOf, 0);
    const savedKeys = await page.evaluate(fileKeys, saved.bytes);

    console.log('\n-- 1. the saved file carries every setting --');
    check(saved.sessions === 1 && eq(saved.views, CAMS),
        `the seed project loaded through the folder loader (sessions ${saved.sessions}, views ${JSON.stringify(saved.views)})`);
    check(/^Saved/.test(saved.status) && saved.cleanAfterSave, `Save As went through (status "${saved.status}")`);
    check(eq(savedKeys.visibility, savedKeys.declaredVisibility),
        `every Visibility key is written (got ${JSON.stringify(savedKeys.visibility)})`);
    check(eq(savedKeys.planes, savedKeys.declaredPlanes),
        `every Define Planes key is written (got ${JSON.stringify(savedKeys.planes)})`);

    // =================================================================
    // 2. A fresh app reopens it through the folder loader
    // =================================================================
    const reopenDir = writeFolder(tmpRoot, 'reopen_session', Buffer.from(saved.bytes));
    await openApp(page);
    // Planes left in an app with no project open — the reset is what removes them.
    const stale = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const P = await import('/ui/plane-definition.js');
        const p = P.createPlane('stale-plane');
        P.planeModel().createNodeInPlane('stale-node', p);
        // Creating it marked the app unsaved; the load is what is measured below.
        (await import('/import-export/save-load.js')).clearDirty();
        return { sessions: AS.state.sessions.length, planes: P.planeModel().planes.map(q => q.name) };
    });
    await loadFolder(page, reopenDir);
    const reopened = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const P = await import('/ui/plane-definition.js');
        const vf = await import('/ui/video-filters.js');
        const s = AS.state.session;
        const view = n => AS.state.views.find(v => v.name === n);
        const slider = (table, i) => {
            const el = document.querySelectorAll('#' + table + ' input[type=range]')[i];
            return el ? el.value : null;
        };
        return {
            sessions: AS.state.sessions.length,
            name: s && s.name,
            brightness: s.videoBrightness, contrast: s.videoContrast, rotation: s.videoRotation,
            hidden: [s._hiddenCameras, s._hiddenTracks, s._hiddenIdentities].map(x => Array.from(x || []).sort()),
            reviewed: s._idSwitch ? Array.from(s._idSwitch.reviewed) : null,
            filters: { camA: view('camA').canvas.style.filter, camB: view('camB').canvas.style.filter },
            expectedFilters: { camA: vf.buildVideoFilter(150, 0), camB: vf.buildVideoFilter(100, -40) },
            viewRotation: { camA: view('camA').rotation, camB: view('camB').rotation },
            brightnessSlider: slider('visVideoBrightnessTable', 0),
            rotationSlider: slider('visVideoRotationTable', 1),
            planes: P.planeModel().planes.map(p => p.name),
            attached: P.planeModel().placements === s.planePlacements,
            dirty: AS.state.isDirty,
        };
    });
    const got = await page.evaluate(settingsOf, 0);

    console.log('\n-- 2. reopened through File ▸ Load Single Session Folder --');
    check(reopened.sessions === 1 && reopened.name === 'reopen_session',
        `one session, named after the folder (got ${reopened.sessions}, "${reopened.name}")`);
    check(eq(reopened.brightness, { camA: 150 }), `brightness restored (got ${JSON.stringify(reopened.brightness)})`);
    check(eq(reopened.contrast, { camB: -40 }), `contrast restored (got ${JSON.stringify(reopened.contrast)})`);
    check(eq(reopened.rotation, { camB: 90 }), `rotation restored (got ${JSON.stringify(reopened.rotation)})`);
    check(eq(reopened.hidden, [['camB'], ['t1'], ['mouseB']]),
        `hidden camera / track / identity restored (got ${JSON.stringify(reopened.hidden)})`);
    check(reopened.reviewed && reopened.reviewed.length === 1, 'the ID Switches checklist and its ticked row are back');
    check(eq(got.visibility, expected.visibility),
        'every Visibility key reads back exactly as it was saved');
    check(eq(reopened.filters, reopened.expectedFilters) && reopened.filters.camA === 'brightness(1.5)',
        `the real canvases are filtered (got ${JSON.stringify(reopened.filters)})`);
    check(reopened.viewRotation.camB === 90 && !reopened.viewRotation.camA,
        `the rotated view is rotated — the renderer reads view.rotation (got ${JSON.stringify(reopened.viewRotation)})`);
    check(reopened.brightnessSlider === '150' && reopened.rotationSlider === '90',
        `the Visibility tables show the restored values (brightness ${reopened.brightnessSlider}, rotation ${reopened.rotationSlider})`);
    check(eq(got.project, expected.project),
        'the plane pool, planes, mesh object and origin read back exactly');
    check(eq(got.placements, expected.placements),
        'and this session\'s per-view 2D, every point on its own node, the nulled one still nulled');
    check(reopened.attached, 'the plane model is drawing this session\'s 2D');
    check(eq(stale.planes, ['stale-plane']) && stale.sessions === 0,
        'negative control: the empty app held a stale plane before the load');
    check(eq(reopened.planes, ['floor', 'wall']),
        `and the load REPLACED it — resetPlaneState() ran (got ${JSON.stringify(reopened.planes)})`);
    check(reopened.dirty === false, 'a reopened project is not marked unsaved');

    // =================================================================
    // 3. "Add session folder" — the same project's folder, added again
    // =================================================================
    await loadFolder(page, reopenDir);
    const added = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const P = await import('/ui/plane-definition.js');
        return {
            sessions: AS.state.sessions.length,
            active: AS.state.activeSessionIdx,
            poolSize: P.planeModel().pool.size,
            status: document.getElementById('statusText') ? document.getElementById('statusText').textContent : '',
        };
    });
    const first = await page.evaluate(settingsOf, 0);
    const second = await page.evaluate(settingsOf, 1);

    console.log('\n-- 3. adding the same project\'s folder as a second session --');
    check(added.sessions === 2 && added.active === 1, `a session was ADDED (got ${added.sessions}, active ${added.active})`);
    check(eq(first.project, expected.project) && added.poolSize === saved.nodeIds.length,
        `the open planes are kept — not wiped, no node duplicated (pool ${added.poolSize})`);
    check(eq(second.visibility, expected.visibility), 'the added session gets its own Visibility settings');
    check(eq(second.placements, expected.placements), 'and its 2D, seated on the open project\'s nodes');
    check(eq(first.placements, expected.placements), 'while the first session\'s 2D is untouched');
    check(/^Loaded session/.test(added.status), `no conflict reported (status "${added.status}")`);

    // =================================================================
    // 4. "Add session folder" — a folder from ANOTHER project
    // =================================================================
    const page2 = await browser.newPage();
    await openApp(page2);
    const otherBytes = await page2.evaluate(buildProjectSlp,
        { name: 'Other', cams: CAMS, planes: true, brightness: { camA: 30 } });
    const otherKeys = await page2.evaluate(fileKeys, otherBytes);
    await page2.close();
    const otherDir = writeFolder(tmpRoot, 'other_session', Buffer.from(otherBytes));

    // What readPlaneMetadata alone would do with that file — the guard's negative control.
    const unguarded = await page.evaluate(async (lucid) => {
        const pd = await import('/pose/pose-data.js');
        const PM = await import('/import-export/plane-metadata.js');
        const scratch = new pd.Session([], new pd.Skeleton('s', ['n0'], []), ['t0'], 'scratch');
        PM.readPlaneMetadata(scratch, lucid);
        let seated = 0;
        scratch.planePlacements.forEach(inst => { for (let i = 0; i < inst.numNodes; i++) if (inst.hasPoint(i)) seated++; });
        return { seated, conflict: PM.planeMetadataConflict(lucid) };
    }, otherKeys.lucid);

    await loadFolder(page, otherDir);
    const foreign = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const P = await import('/ui/plane-definition.js');
        const s = AS.state.sessions[2];
        return {
            sessions: AS.state.sessions.length,
            placements: s ? s.planePlacements.size : -1,
            brightness: s ? s.videoBrightness : null,
            planes: P.planeModel().planes.map(p => p.name),
            status: document.getElementById('statusText') ? document.getElementById('statusText').textContent : '',
        };
    });
    const afterForeign = await page.evaluate(settingsOf, 0);

    console.log('\n-- 4. adding a folder from another project --');
    check(otherKeys.placementNodeIds.length === 3 &&
        otherKeys.placementNodeIds.every(id => saved.nodeIds.includes(id)),
        `the other file's 2D names node IDs the open project also has (${JSON.stringify(otherKeys.placementNodeIds)})`);
    check(unguarded.seated === 3,
        `negative control: readPlaneMetadata alone seats ${unguarded.seated} of them on this project's nodes`);
    check(typeof unguarded.conflict === 'string', `planeMetadataConflict flags it ("${unguarded.conflict}")`);
    check(foreign.sessions === 3, `the session was still added (got ${foreign.sessions})`);
    check(foreign.placements === 0, `but none of its 2D was seated (got ${foreign.placements} placed views)`);
    check(eq(foreign.planes, ['floor', 'wall']) && eq(afterForeign.project, expected.project),
        `the open project's planes are unchanged (got ${JSON.stringify(foreign.planes)})`);
    check(eq(foreign.brightness, { camA: 30 }),
        `its Visibility settings are still read (got ${JSON.stringify(foreign.brightness)})`);
    check(/its planes were not added/.test(foreign.status), `the status bar says why (got "${foreign.status}")`);
} catch (err) {
    console.error('\nFATAL', err);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'} — ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
