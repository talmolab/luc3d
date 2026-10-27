/**
 * new-project-then-load.mjs — File ▸ New Project, then loading a project
 * `.slp` and picking its session folder for the videos, loads.
 *
 * ## The bug
 * `newProject` sets the 3D viewport's skeleton to null. The loaders seek to
 * the first labeled frame — which draws it in 3D — BEFORE they set the new
 * skeleton, so `Viewport3D.updateSkeleton` read `null.edges` and the load
 * failed with "SLP load error: Cannot read properties of null (reading
 * 'edges')". A fresh page never showed it: the viewport starts with an empty
 * skeleton, not null. Several loaders seek first (Load SLP, Load Project, Add
 * SLP, switching sessions), and removing the last session nulls the skeleton
 * too, so the viewport now draws a null skeleton as one with no edges.
 *
 * Asserted (a project `.slp` with no videos inside, two calibrated cameras,
 * a 3D group on its first labeled frame; the session folder written to disk
 * and picked through the prompt's Select Session Folder):
 *  1. Load SLP on a fresh page loads (baseline; it also creates the viewport).
 *  2. File ▸ New Project (the menu), then Load SLP again: no error, the views
 *     come back, the viewport has the file's skeleton, and the 3D group is
 *     drawn with its edge.
 *  3. New Project, then Load Project on the same file (the eager reopen,
 *     `handleLoadProject`, which also seeks first): the same.
 *  4. The viewport itself: a null skeleton draws the group's nodes and no
 *     edges instead of throwing.
 *
 * Negative control, run once: without the viewport change §2 and §3 fail
 * with the "reading 'edges'" error and §4 throws.
 *
 * Run: node tests/e2e/new-project-then-load.mjs   (spawns its own http.server;
 * PORT= to move it)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8379);
const CAMS = ['Camera0', 'Camera1'];

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-newproj-'));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); });
    page.on('dialog', d => d.accept());   // New Project's "Unsaved changes" confirm
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    // The session folder: <Camera>/0.mp4, 20 frames each.
    const video = Buffer.from(await page.evaluate(async () => {
        const enc = await import('/ui/video-encode.js');
        const canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = 120;
        const cctx = canvas.getContext('2d');
        const wr = await enc.createMp4Writer({ canvas, width: 160, height: 120, fps: 20,
            bitrate: 300000, frameCount: 20, keyFrameEveryFrames: 5 });
        for (let i = 0; i < 20; i++) {
            cctx.fillStyle = 'rgb(' + (10 * i) + ',60,90)'; cctx.fillRect(0, 0, 160, 120);
            await wr.addFrame(i);
        }
        const buf = new Uint8Array(await (await wr.finish()).blob.arrayBuffer());
        let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
        return btoa(s);
    }), 'base64');
    const dir = path.join(tmpRoot, 'session1');
    for (const cam of CAMS) {
        fs.mkdirSync(path.join(dir, cam), { recursive: true });
        fs.writeFileSync(path.join(dir, cam, '0.mp4'), video);
    }

    // The project .slp: no videos inside; a 3D group on frame 3, the first
    // labeled frame, so the load's seek draws it.
    const slpBytes = await page.evaluate(async (CAMS) => {
        const pd = await import('/pose/pose-data.js');
        const fio = await import('/import-export/file-io.js');
        const K = [[60, 0, 80], [0, 60, 60], [0, 0, 1]];
        const cams = CAMS.map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [-150 * i, 0, 600], [160, 120]));
        const session = new pd.Session(cams, new pd.Skeleton('skeleton', ['a', 'b'], [[0, 1]]), ['track_0'], 'session1');
        const fg = new pd.FrameGroup(3); session.addFrameGroup(fg);
        const g = new pd.InstanceGroup(1, -1);
        cams.forEach(c => { const inst = new pd.Instance([[70, 50], [90, 60]], 0, 'user', 1); fg.addInstance(c.name, inst); g.addInstance(c.name, inst); });
        g.points3d = [[0, 0, 0], [20, 10, 0]];
        session.instanceGroups.set(3, [g]);
        const views = cams.map(c => ({ name: c.name, videoWidth: 160, videoHeight: 120, frameCount: 20 }));
        const vfs = cams.map(c => ({ name: c.name, assignedCamera: c.name, videoPath: c.name + '/0.mp4' }));
        return Array.from(await window.SleapIO.saveSlpToBytes(fio.buildSlpLabelsAllViews(session, views, vfs)));
    }, CAMS);

    /** Run `loader` ('slp' | 'project') on the file and answer the video
     *  prompt with the session folder; returns what the app shows after. */
    async function load(loader) {
        errs.length = 0;
        await page.evaluate(({ bytes, loader }) => {
            const file = new File([new Uint8Array(bytes)], 'project.slp');
            window.__load = (async () => {
                if (loader === 'slp') await (await import('/import-export/slp-import.js')).handleLoadSlpFile(file);
                else await (await import('/import-export/save-load.js')).handleLoadProject(file);
            })().then(() => 'done', e => 'ERR ' + e);
        }, { bytes: slpBytes, loader });
        await page.waitForSelector('#videoSelectOverlay', { timeout: 20000 });
        page.once('filechooser', async (fc) => { await fc.setFiles(dir); });
        await page.click('#videoSelectOverlay >> text=Select Session Folder');
        const outcome = await page.evaluate(() => window.__load);
        await page.waitForTimeout(300);
        return page.evaluate(async (outcome) => {
            const s = window.__lucid.state;
            const AS = await import('/ui/app-state.js');
            const vp = AS.viewport3d;
            const inst = vp && vp._skeletonGroup ? vp._skeletonGroup.children : [];
            const names = inst.flatMap(g => g.children.map(c => c.name));
            return {
                outcome,
                status: document.getElementById('statusText').textContent,
                views: s.views.map(v => v.name),
                frame: s.currentFrame,
                skeleton: vp && vp.skeleton ? vp.skeleton.nodes.length + ' nodes / ' + vp.skeleton.edges.length + ' edges' : String(vp && vp.skeleton),
                nodes3d: names.filter(n => /^node_/.test(n)).length,
                edges3d: names.filter(n => /^edge_/.test(n)).length,
            };
        }, outcome);
    }

    function checkLoaded(r) {
        console.log('  measured:', JSON.stringify(r));
        check(r.outcome === 'done' && !/error/i.test(r.status), `the load finishes ("${r.status}")`);
        check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
        check(r.views.slice().sort().join(',') === CAMS.join(','), `the views come back (${r.views})`);
        check(r.frame === 3, `it opens on the first labeled frame (${r.frame})`);
        check(r.skeleton === '2 nodes / 1 edges', `the 3D viewport has the file's skeleton (${r.skeleton})`);
        check(r.nodes3d === 2 && r.edges3d === 1, `the 3D group is drawn with its edge (${r.nodes3d} nodes, ${r.edges3d} edges)`);
    }

    const newProjectFromMenu = () => page.evaluate(() => document.getElementById('menuNewProject').click());

    console.log('1. Load SLP on a fresh page');
    checkLoaded(await load('slp'));

    console.log('\n2. File ▸ New Project, then Load SLP');
    await newProjectFromMenu();
    check(await page.evaluate(async () => (await import('/ui/app-state.js')).viewport3d.skeleton === null),
        'precondition: New Project leaves the viewport without a skeleton');
    checkLoaded(await load('slp'));

    console.log('\n3. File ▸ New Project, then Load Project');
    await newProjectFromMenu();
    checkLoaded(await load('project'));

    console.log('\n4. The viewport draws a null skeleton as one with no edges');
    const v = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const vp = AS.viewport3d;
        const groups = window.__lucid.state.session.instanceGroups.get(3);
        const saved = vp.skeleton;
        vp.skeleton = null;
        let err = null;
        try { vp.setFrame(groups); } catch (e) { err = String(e); }
        const names = vp._skeletonGroup.children.flatMap(g => g.children.map(c => c.name));
        vp.skeleton = saved;
        vp.setFrame(groups);
        return { err, nodes: names.filter(n => /^node_/.test(n)).length, edges: names.filter(n => /^edge_/.test(n)).length };
    });
    check(v.err === null, `setFrame with a null skeleton does not throw (${v.err})`);
    check(v.nodes === 2 && v.edges === 0, `it draws the nodes and no edges (${v.nodes} nodes, ${v.edges} edges)`);
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(fails ? `\nFAIL — ${fails} check(s) failed` : '\nPASS — New Project, then load');
process.exit(fails ? 1 : 0);
