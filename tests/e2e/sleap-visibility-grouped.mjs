/**
 * sleap-visibility-grouped.mjs — a hide or un-hide made OUTSIDE LUC3D (SLEAP,
 * sleap-io) on a GROUPED node is honoured when LUC3D reopens the file.
 *
 * Bug: for a group member LUC3D took its hidden nodes only from its own
 * metadata copy (`instanceMeta[cam].nulledNodes` in
 * `/session_data/instance_group_meta`). SLEAP edits the file's `visible` flag
 * and passes that metadata through unchanged, so a node hidden in SLEAP was
 * drawn and triangulated as normal, and one un-hidden in SLEAP stayed hidden.
 * Now the file's visibility decides for placed user nodes
 * (`fileNulledNodes`, import-export/import-track-resolve.js); the metadata is
 * still written (older builds read it) and used only for a node with no
 * position.
 *
 * The "SLEAP edit" is made the way SLEAP makes it — load with sleap-io, flip
 * `visible`, save — using sleap-io.js in the page (`readSlpStreaming` +
 * `saveSlpToBytes`), and the test first asserts the metadata really came
 * through unchanged, so it cannot pass vacuously.
 *
 * Reopened two ways: eagerly (`handleLoadSessionFolderSingleSlp`, which
 * rebuilds groups through the same `reconstructInstanceGroupsFromSession` as
 * File ▸ Load SLP) and lazily (`handleLoadProjectSlpLazy`, where a member's hidden nodes are
 * settled when its 2D arrives, `adoptMemberRow`).
 *
 * Run: node tests/e2e/sleap-visibility-grouped.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8297);
const CAMS = ['side', 'back', 'mid'];
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

function calibrationToml() {
    const M = '[ [ 1000.0, 0.0, 255.5,], [ 0.0, 1000.0, 255.5,], [ 0.0, 0.0, 1.0,],]';
    let out = '';
    CAMS.forEach((name, i) => {
        out += `[cam_${i}]\nname = "${name}"\nsize = [ 512, 512,]\n`;
        out += `matrix = ${M}\ndistortions = [ 0.0, 0.0, 0.0, 0.0, 0.0,]\n`;
        out += `rotation = [ 0.0, ${0.1 * i}, 0.0,]\ntranslation = [ ${10 * i}.0, 0.0, 0.0,]\n\n`;
    });
    return out + `[metadata]\nadjusted = false\n`;
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const BASE = `http://localhost:${PORT}/index.html`;

async function boot(browser) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });
    await page.evaluate(() => {
        // One group over side/back/mid (user instances). LUC3D hides node 1 on
        // `side` (metadata + visible=0); `back` and `mid` show everything.
        // Nose x tells the cameras apart: side 100, back 101, mid 102.
        window.__build = async (cams) => {
            const pd = await import('/pose/pose-data.js');
            const fio = await import('/import-export/file-io.js');
            const { Skeleton, Camera, Instance, FrameGroup, InstanceGroup, Session } = pd;
            const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
            const cameras = cams.map((n, i) => new Camera(n, mtx, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [512, 512]));
            const session = new Session(cameras, new Skeleton('sk', ['nose', 'neck', 'tail'], [[0, 1], [1, 2]]), ['track_0'], 'Vis');
            const fg = new FrameGroup(0);
            session.addFrameGroup(fg);
            const group = new InstanceGroup(1, -1);
            cams.forEach((cn, i) => {
                const inst = new Instance([[100 + i, 200], [200 + i, 250], [300 + i, 300]], 0, 'user', 1);
                if (cn === 'side') inst.nulledNodes = new Set([1]);
                fg.addInstance(cn, inst);
                group.addInstance(cn, inst);
            });
            group.points3d = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
            session.instanceGroups.set(0, [group]);
            const views = cams.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: 100 }));
            const vf = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
            return await window.SleapIO.saveSlpToBytes(fio.buildSlpLabelsAllViews(session, views, vf));
        };
        const h5url = () => new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href;
        // Edit like SLEAP: load with sleap-io, flip `visible`, save.
        // edits: [[noseX, node, visible], ...]
        window.__sleapEdit = async (bytes, edits) => {
            const labels = await window.SleapIO.readSlpStreaming(new File([bytes], 'in.slp'),
                { lazy: false, openVideos: false, h5wasmUrl: h5url() });
            let n = 0;
            for (const lf of labels.labeledFrames) for (const inst of lf.instances) {
                const x = Math.round(inst.points[0].xy[0]);
                for (const [nx, node, vis] of edits) if (nx === x) { inst.points[node].visible = vis; n++; }
            }
            return { bytes: await window.SleapIO.saveSlpToBytes(labels), edited: n };
        };
        // Per camera: the file's visible flags + the metadata copy of hidden nodes.
        window.__inspect = async (bytes) => {
            const labels = await window.SleapIO.readSlpStreaming(new File([bytes], 'r.slp'),
                { lazy: false, openVideos: false, h5wasmUrl: h5url() });
            const vis = {};
            for (const lf of labels.labeledFrames) for (const inst of lf.instances) {
                vis[Math.round(inst.points[0].xy[0])] = inst.points.map(p => !!p.visible);
            }
            const meta = [];
            for (const s of labels.sessions || []) for (const [, fg] of s.frameGroups) for (const ig of fg.instanceGroups) {
                meta.push(JSON.stringify(ig.metadata || {}));
            }
            return { vis, meta };
        };
        // Hidden nodes of each camera's member on frame 0, after a reopen.
        window.__hidden = () => {
            const s = window.__lucid.state.session;
            const g = (s.instanceGroups.get(0) || [])[0];
            if (!g) return null;
            const out = {};
            for (const [cam, inst] of g.instances) out[cam] = inst.nulledNodes ? Array.from(inst.nulledNodes).sort() : [];
            return out;
        };
    });
    return page;
}

const browser = await chromium.launch();
let tmp = null;
try {
    const page = await boot(browser);
    const luc = await page.evaluate(c => window.__build(c).then(b => Array.from(b)), CAMS);
    // SLEAP: un-hide side's node 1, hide back's node 2, leave mid alone.
    const ed = await page.evaluate(b => window.__sleapEdit(new Uint8Array(b), [[100, 1, true], [101, 2, false]])
        .then(r => ({ bytes: Array.from(r.bytes), edited: r.edited })), luc);
    check(ed.edited === 2, `sleap-io made both edits (${ed.edited})`);
    const before = await page.evaluate(b => window.__inspect(new Uint8Array(b)), luc);
    const after = await page.evaluate(b => window.__inspect(new Uint8Array(b)), ed.bytes);
    check(JSON.stringify(after.vis[100]) === '[true,true,true]' && JSON.stringify(after.vis[101]) === '[true,true,false]',
        `the edited file says: side all visible, back node 2 hidden (${JSON.stringify(after.vis)})`);
    check(after.meta.length === 1 && after.meta[0] === before.meta[0] && /"nulledNodes":\[1\]/.test(after.meta[0]),
        `the metadata copy came through the edit unchanged, still listing side node 1 (${after.meta[0]})`);
    await page.close();

    // ---- A. eager reopen (session folder + project .slp) ----
    console.log('A. eager reopen');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-sleapvis-'));
    const fixture = path.join(tmp, 'vis_session');
    fs.mkdirSync(path.join(fixture, 'videos'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'project.slp'), Buffer.from(ed.bytes));
    fs.writeFileSync(path.join(fixture, 'calibration.toml'), calibrationToml());
    for (const cam of CAMS) fs.copyFileSync(path.join(REPO, 'sample_session', cam + '.mp4'), path.join(fixture, 'videos', cam + '.mp4'));
    const pageA = await boot(browser);
    pageA.once('filechooser', fc => fc.setFiles(fixture));
    await pageA.evaluate(async () => { (await import('/loading/session-loader.js')).handleLoadSessionFolderSingleSlp(); });
    await pageA.waitForFunction(() => {
        const s = window.__lucid.state.session;
        return s && (s.instanceGroups.get(0) || []).length === 1 && window.__lucid.state.views.length === 3;
    }, null, { timeout: 60000 });
    const hA = await pageA.evaluate(() => window.__hidden());
    check(hA && hA.side.length === 0, `side node 1, un-hidden in SLEAP, is shown (hidden: ${JSON.stringify(hA && hA.side)})`);
    check(hA && JSON.stringify(hA.back) === '[2]', `back node 2, hidden in SLEAP, is hidden (hidden: ${JSON.stringify(hA && hA.back)})`);
    check(hA && hA.mid.length === 0, 'mid, untouched, has nothing hidden');
    await pageA.close();

    // ---- B. lazy reopen ----
    console.log('B. lazy reopen');
    const pageB = await boot(browser);
    const hB = await pageB.evaluate(async (b) => {
        const sl = await import('/loading/session-loader.js');
        const skip = setInterval(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim().startsWith('Skip'));
            if (btn) btn.click();
        }, 200);
        await sl.handleLoadProjectSlpLazy(new File([new Uint8Array(b)], 'project.slp'));
        clearInterval(skip);
        const s = window.__lucid.state.session;
        const tri = await import('/pose/triangulation.js');
        await tri.ensureLazyFrameData(0);
        const g = (s.instanceGroups.get(0) || [])[0];
        return { lazy: !!s.lazyLoader, hidden: window.__hidden(),
            stillPending: !g || Array.from(g.instances.values()).some(m => m._lazy2d) };
    }, ed.bytes);
    check(hB.lazy, 'reopened lazily');
    check(hB.hidden && hB.hidden.side.length === 0, `lazy: side node 1 is shown (hidden: ${JSON.stringify(hB.hidden && hB.hidden.side)})`);
    check(hB.hidden && JSON.stringify(hB.hidden.back) === '[2]', `lazy: back node 2 is hidden (hidden: ${JSON.stringify(hB.hidden && hB.hidden.back)})`);
    check(!hB.stillPending, 'lazy: frame 0\'s members have their 2D');
    await pageB.close();

    // ---- C. control: LUC3D's own hide, no SLEAP edit, still round-trips ----
    console.log('C. control: unedited LUC3D file');
    const pageC = await boot(browser);
    const hC = await pageC.evaluate(async (b) => {
        const sl = await import('/loading/session-loader.js');
        const skip = setInterval(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim().startsWith('Skip'));
            if (btn) btn.click();
        }, 200);
        await sl.handleLoadProjectSlpLazy(new File([new Uint8Array(b)], 'project.slp'));
        clearInterval(skip);
        await (await import('/pose/triangulation.js')).ensureLazyFrameData(0);
        return window.__hidden();
    }, luc);
    check(hC && JSON.stringify(hC.side) === '[1]' && hC.back.length === 0 && hC.mid.length === 0,
        `LUC3D's own hide reopens hidden, nothing else (${JSON.stringify(hC)})`);
    await pageC.close();
} catch (e) {
    console.log('  ✗ threw:', e && e.stack || e);
    fails++;
} finally {
    await browser.close();
    server.kill();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fails ? `\nFAIL — ${fails} check(s) failed` : '\nPASS');
process.exit(fails ? 1 : 0);
