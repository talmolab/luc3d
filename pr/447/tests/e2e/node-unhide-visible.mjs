/**
 * node-unhide-visible.mjs — un-hiding a node that was saved hidden writes it
 * VISIBLE again.
 *
 * Bug: a user node saved hidden comes back from the file with BOTH flags set —
 * `nulledNodes` and the occlusion bit (the file's `visible=0`). Right-click
 * un-hide removed it from `nulledNodes` only, and every writer saves
 * `visible = !nulled && !occluded`, so the stale bit kept `points[:, 2]` at 0:
 * the node looked restored in LUC3D but stayed hidden in SLEAP / sleap-io.
 * `Instance.toggleNulled` now clears the bit when un-hiding.
 *
 * Asserted here:
 *  A. EAGER reopen (session folder + project .slp, real videos): a real
 *     right-click un-hides a grouped node and an unlinked node; both flags
 *     clear; File ▸ Save As writes them `visible`; a node that was never hidden
 *     is unchanged; hiding one again writes it invisible again.
 *  B. LAZY reopen (`handleLoadProjectSlpLazy`): the same un-hide through the
 *     interaction manager, then File ▸ Save As AND the By Cam export, whose
 *     store copy compares members with their store rows
 *     (`_memberDiffersFromStore`) — the stale bit made an un-hidden member look
 *     unedited there, so the row's `visible=0` was copied.
 *
 * Confirmed to fail without the fix.
 *
 * Run: node tests/e2e/node-unhide-visible.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8293);
const CAMS = ['side', 'back', 'mid'];
const HID = 1;                       // the hidden node ("neck")
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

// In-page helpers: build the project, save through the real Save As, read back.
async function installHelpers(page) {
    await page.evaluate(() => {
        window.__h = {
            // A grouped instance in side + back (side's node HID hidden) and an
            // unlinked one in mid (node HID hidden). x offsets tell them apart.
            async buildBytes(cams, hid) {
                const pd = await import('/pose/pose-data.js');
                const fio = await import('/import-export/file-io.js');
                const { Skeleton, Camera, Instance, UnlinkedInstance, FrameGroup, InstanceGroup, Session } = pd;
                const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
                const cameras = cams.map((n, i) => new Camera(n, mtx, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [512, 512]));
                const session = new Session(cameras, new Skeleton('sk', ['nose', 'neck', 'tail'], [[0, 1], [1, 2]]), ['track_0'], 'Unhide');
                const fg = new FrameGroup(0);
                session.addFrameGroup(fg);
                const group = new InstanceGroup(1, -1);
                ['side', 'back'].forEach((cn, i) => {
                    const inst = new Instance([[100 + i, 200], [200 + i, 250], [300 + i, 300]], 0, 'user', 1);
                    if (cn === 'side') inst.nulledNodes = new Set([hid]);
                    fg.addInstance(cn, inst);
                    group.addInstance(cn, inst);
                });
                group.points3d = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
                session.instanceGroups.set(0, [group]);
                const ul = new Instance([[110, 210], [220, 260], [330, 310]], null, 'user', 1);
                ul.nulledNodes = new Set([hid]);
                fg.addUnlinkedInstance('mid', new UnlinkedInstance(ul, 'mid'));
                const views = cams.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: 100 }));
                const vf = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
                return Array.from(await window.SleapIO.saveSlpToBytes(fio.buildSlpLabelsAllViews(session, views, vf)));
            },
            // The three instances of frame 0, wherever they sit.
            insts() {
                const s = window.__lucid.state.session;
                const g = (s.instanceGroups.get(0) || [])[0];
                const fg = s.frameGroups.get(0) || s.getFrameGroup(0);
                return {
                    group: g,
                    side: g && g.instances.get('side'),
                    back: g && g.instances.get('back'),
                    mid: fg && fg.getUnlinkedInstances('mid')[0] && fg.getUnlinkedInstances('mid')[0].instance,
                };
            },
            flags(hid) {
                const r = {};
                for (const [k, inst] of Object.entries(window.__h.insts())) {
                    if (k === 'group') continue;
                    r[k] = inst ? { nulled: !!(inst.nulledNodes && inst.nulledNodes.has(hid)), occ: inst.isOccluded(hid) } : null;
                }
                return r;
            },
            async saveAs() {
                const SL = await import('/import-export/save-load.js');
                const parts = [];
                window.showSaveFilePicker = async () => ({
                    name: 'p.slp',
                    createWritable: async () => ({
                        write: async (c) => {
                            const u = c instanceof Uint8Array ? c : c instanceof Blob
                                ? new Uint8Array(await c.arrayBuffer()) : c && c.data !== undefined
                                    ? new Uint8Array(c.data instanceof Blob ? await c.data.arrayBuffer() : c.data)
                                    : new Uint8Array(c.buffer || c);
                            parts.push(u.slice());
                        },
                        close: async () => {}, seek: async () => {}, truncate: async () => {},
                    }),
                });
                await SL.saveAs({ skipSizeWarning: true });
                const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n);
                let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
                return out;
            },
            // visible flag of node `hid` per camera on frame 0, keyed by the
            // instance's nose x (101 = back, 100 = side, 110 = mid).
            async readVisible(bytes, hid) {
                const rb = await window.SleapIO.readSlpStreaming(new File([bytes], 'r.slp'),
                    { lazy: false, openVideos: false, h5wasmUrl: new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href });
                const out = {};
                for (const lf of rb.labeledFrames) {
                    if (lf.frameIdx !== 0) continue;
                    for (const inst of lf.instances) {
                        const x = Math.round(inst.points[0].xy[0]);
                        const name = x === 100 ? 'side' : x === 101 ? 'back' : x === 110 ? 'mid' : 'x' + x;
                        out[name] = !!inst.points[hid].visible;
                    }
                }
                return out;
            },
        };
    });
}

const browser = await chromium.launch();
let tmp = null;
try {
    // ---------------------------------------------------------------- A. eager
    console.log('A. eager reopen, real right-click, File ▸ Save As');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });
    await installHelpers(page);
    const bytes1 = Buffer.from(await page.evaluate(([c, h]) => window.__h.buildBytes(c, h), [CAMS, HID]));

    const v0 = await page.evaluate(([b, h]) => window.__h.readVisible(new Uint8Array(b), h), [Array.from(bytes1), HID]);
    check(v0.side === false && v0.mid === false && v0.back === true,
        `fixture: side and mid saved hidden, back visible (${JSON.stringify(v0)})`);

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-unhide-'));
    const fixture = path.join(tmp, 'unhide_session');
    fs.mkdirSync(path.join(fixture, 'videos'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'project.slp'), bytes1);
    fs.writeFileSync(path.join(fixture, 'calibration.toml'), calibrationToml());
    for (const cam of CAMS) fs.copyFileSync(path.join(REPO, 'sample_session', cam + '.mp4'), path.join(fixture, 'videos', cam + '.mp4'));

    page.once('filechooser', fc => fc.setFiles(fixture));
    await page.evaluate(async () => { (await import('/loading/session-loader.js')).handleLoadSessionFolderSingleSlp(); });
    await page.waitForFunction(() => {
        const s = window.__lucid.state;
        return s.views.length === 3 && s.views.every(v => v.overlayCanvas && v.videoWidth > 0) &&
            s.session && (s.session.instanceGroups.get(0) || []).length === 1;
    }, null, { timeout: 60000 });
    await page.waitForTimeout(800);

    let f = await page.evaluate(h => window.__h.flags(h), HID);
    check(f.side && f.side.nulled && f.side.occ && f.mid && f.mid.nulled && f.mid.occ,
        `reopened: hidden nodes carry both flags (${JSON.stringify(f)})`);
    check(f.back && !f.back.nulled && !f.back.occ, 'reopened: the never-hidden node carries neither');

    const rightClick = async (cam, which) => {
        const [x, y] = await page.evaluate(([c, w, h]) => {
            const inst = window.__h.insts()[w];
            const v = window.__lucid.state.views.find(q => q.name === c);
            const r = (v.canvas || v.overlayCanvas).getBoundingClientRect();
            return [r.left + inst.getX(h) * r.width / v.videoWidth, r.top + inst.getY(h) * r.height / v.videoHeight];
        }, [cam, which, HID]);
        await page.mouse.click(x, y, { button: 'right' });
    };
    const settle = (which, want) => page.waitForFunction(([w, h, want]) => {
        const i = window.__h.insts()[w];
        return !!(i.nulledNodes && i.nulledNodes.has(h)) === want;
    }, [which, HID, want], { timeout: 5000 }).catch(() => {});

    await rightClick('side', 'side'); await settle('side', false);
    await rightClick('mid', 'mid'); await settle('mid', false);
    f = await page.evaluate(h => window.__h.flags(h), HID);
    check(f.side && !f.side.nulled && !f.side.occ, `grouped un-hide clears both flags (${JSON.stringify(f.side)})`);
    check(f.mid && !f.mid.nulled && !f.mid.occ, `unlinked un-hide clears both flags (${JSON.stringify(f.mid)})`);
    check(await page.evaluate(() => window.__lucid.state.isDirty), 'the un-hide marks the project dirty');

    const bytes2 = await page.evaluate(() => window.__h.saveAs().then(b => Array.from(b)));
    const v2 = await page.evaluate(([b, h]) => window.__h.readVisible(new Uint8Array(b), h), [bytes2, HID]);
    check(v2.side === true && v2.mid === true && v2.back === true,
        `Save As writes the un-hidden nodes visible (${JSON.stringify(v2)})`);

    await rightClick('side', 'side'); await settle('side', true);
    const bytes3 = await page.evaluate(() => window.__h.saveAs().then(b => Array.from(b)));
    const v3 = await page.evaluate(([b, h]) => window.__h.readVisible(new Uint8Array(b), h), [bytes3, HID]);
    check(v3.side === false && v3.mid === true, `hiding it again writes it invisible again (${JSON.stringify(v3)})`);
    await page.close();

    // ----------------------------------------------------------------- B. lazy
    console.log('B. lazy reopen, Save As + By Cam store copy');
    const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page2.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page2.goto(BASE);
    await page2.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });
    await installHelpers(page2);
    const lz = await page2.evaluate(async ([b, h]) => {
        const sl = await import('/loading/session-loader.js');
        const skip = setInterval(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim().startsWith('Skip'));
            if (btn) btn.click();
        }, 200);
        await sl.handleLoadProjectSlpLazy(new File([new Uint8Array(b)], 'project.slp'));
        clearInterval(skip);
        const s = window.__lucid.state.session;
        if (!s.lazyLoader) return { lazy: false };
        const tri = await import('/pose/triangulation.js');
        if (tri.ensureLazyFrameData) await tri.ensureLazyFrameData(0);
        const before = window.__h.flags(h);
        const { side, mid, group } = window.__h.insts();
        if (!side || !mid) return { lazy: true, before, missing: true };
        // The same calls a right-click makes (grouped → _toggleNodeNull; unlinked → toggleNulled).
        window.__lucid.interactionManager._toggleNodeNull('side', group, h);
        // (the old inline toggle when the method is absent, so this half fails
        // on an unfixed build instead of throwing)
        if (typeof mid.toggleNulled === 'function') mid.toggleNulled(h); else mid.nulledNodes.delete(h);
        return { lazy: true, before, after: window.__h.flags(h) };
    }, [Array.from(bytes1), HID]);
    check(lz.lazy, 'the project reopened lazily');
    check(!lz.missing, 'frame 0\'s instances are resident');
    if (lz.before && lz.after) {
        check(lz.before.side.nulled && lz.before.side.occ && lz.before.mid.nulled && lz.before.mid.occ,
            `lazy reopen: hidden nodes carry both flags (${JSON.stringify(lz.before)})`);
        check(!lz.after.side.nulled && !lz.after.side.occ && !lz.after.mid.nulled && !lz.after.mid.occ,
            `lazy un-hide clears both flags (${JSON.stringify(lz.after)})`);
        const b4 = await page2.evaluate(() => window.__h.saveAs().then(b => Array.from(b)));
        const v4 = await page2.evaluate(([b, h]) => window.__h.readVisible(new Uint8Array(b), h), [b4, HID]);
        check(v4.side === true && v4.mid === true && v4.back === true, `lazy Save As writes them visible (${JSON.stringify(v4)})`);
        const bc = await page2.evaluate(async (h) => {
            const fio = await import('/import-export/file-io.js');
            const s = window.__lucid.state.session;
            const FILTER = { user: true, predicted: true, reprojected: false };
            const blobs = await fio.exportCamerasSlpStreaming(s, ['side', 'mid'].map(n => ({ cameraName: n, videoFileInfo: null })), null, FILTER);
            const out = {};
            for (const b of blobs) Object.assign(out, await window.__h.readVisible(b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : b, h));
            return out;
        }, HID);
        check(bc.side === true && bc.mid === true, `By Cam export writes them visible (${JSON.stringify(bc)})`);
    }
    await page2.close();
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
