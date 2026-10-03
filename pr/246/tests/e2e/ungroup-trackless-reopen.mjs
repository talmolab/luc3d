/**
 * ungroup-trackless-reopen.mjs — regression test for the luc3d #201 recurrence
 * reported against PR #202: on a REAL project, ungrouping a group that showed
 * "id_0" still reset every Ungrouped row to "—".
 *
 * The #202 fix retained identity by stamping `frameIdentityMap` — which is
 * keyed by raw trackIdx and therefore CANNOT represent a TRACKLESS instance
 * (null track = one shared per-camera slot). Untracked predictions and manual
 * annotations are exactly that state, so for them the retention never fired
 * and the identity (living only on `group.identityId`) died with the group.
 *
 * This drives the reporter's actual path end to end:
 *   trackless project (identity ONLY on group.identityId, empty
 *   frameIdentityMap) -> REAL save (buildSlpLabelsAllViews + saveSlpToBytes,
 *   SLP 2.8 columnar) -> REAL lazy reopen (handleLoadProjectSlpLazy) ->
 *   hydrate a mid-project frame -> ungroup BOTH groups via the real UI ->
 *   read the Ungrouped Instances table -> switch ONE view's ID via the real
 *   dropdown -> regroup -> the animal keeps its name.
 *
 * Run: node tests/e2e/ungroup-trackless-reopen.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8246);
const FRAMES = Number(process.env.FRAMES || 500);
const CAMS = 3, NODES = 3;

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const fixturePath = path.join(repoRoot, '_ungroup-trackless-fixture.slp');

let browser;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 300)); });

    let sinkFd = null;
    await page.exposeFunction('__tstWrite', (b64) => {
        if (sinkFd === null) sinkFd = fs.openSync(fixturePath, 'w');
        fs.writeSync(sinkFd, Buffer.from(b64, 'base64'));
    });

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm && window.__lucid, { timeout: 120000 });

    // ---- fixture: TRACKLESS members, identity only on group.identityId ----
    await page.evaluate(async ({ FRAMES, CAMS, NODES }) => {
        const [pd, fileio] = await Promise.all([
            import('/pose/pose-data.js'), import('/import-export/file-io.js'),
        ]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const camNames = Array.from({ length: CAMS }, (_, i) => 'cam' + i);
        const nodeNames = Array.from({ length: NODES }, (_, i) => 'n' + i);
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        const cameras = camNames.map((n, i) => {
            const a = (i / CAMS) * 1.2 - 0.6;
            return new Camera(n, M, [0, 0, 0, 0, 0], [0, a, 0], [-40 * Math.sin(a), 0, 40 * (1 - Math.cos(a))], [512, 512]);
        });
        const skeleton = new Skeleton('skeleton', nodeNames, nodeNames.slice(1).map((_, i) => [i, i + 1]));
        const session = new Session(cameras, skeleton, [], 'UngroupTrackless');
        session.identities = [{ id: 0, name: 'id_0' }, { id: 1, name: 'id_1' }];
        const xy = (f, c, k) => [180 + (f % 97) * 1.5 + c * 11 + k * 3, 200 + (f % 89) * 1.25 + c * 7 + k * 2];
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const groupsThisFrame = [];
            for (let a = 0; a < 2; a++) {
                const g = new InstanceGroup(f * 2 + a + 1, a);
                camNames.forEach((cn, ci) => {
                    // trackIdx null — untracked predictions / manual annotation.
                    const inst = new Instance(
                        nodeNames.map((_, k) => {
                            const p = xy(f, ci, k);
                            return a === 0 ? p : [p[0] + 120, p[1] + 60];
                        }), null, 'predicted', 1);
                    inst._rawInstIndex = a;
                    fg.addInstance(cn, inst);
                    g.addInstance(cn, inst);
                });
                g.points3d = new Float64Array(NODES * 3).fill(0).map((_, i) => (f % 31) + i * 0.5 + a * 40);
                groupsThisFrame.push(g);
                // NO setFrameIdentity — the map has nothing for a null track.
            }
            session.instanceGroups.set(f, groupsThisFrame);
        }
        const views = camNames.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES }));
        const videoFiles = camNames.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const labels = fileio.buildSlpLabelsAllViews(session, views, videoFiles);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        let s = ''; const C = 0x8000;
        for (let o = 0; o < bytes.length; o += C) s += String.fromCharCode.apply(null, bytes.subarray(o, o + C));
        await window.__tstWrite(btoa(s));
    }, { FRAMES, CAMS, NODES });
    if (sinkFd !== null) { fs.closeSync(sinkFd); sinkFd = null; }

    // ---- REAL lazy reopen ----
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__tstPick';
        inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
    });
    await page.setInputFiles('#__tstPick', fixturePath);
    await page.evaluate(() => {
        window.__tstLoad = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('/loading/session-loader.js');
                await sl.handleLoadProjectSlpLazy(document.getElementById('__tstPick').files[0]);
                window.__tstLoad.done = true;
            } catch (e) { window.__tstLoad.err = String(e && e.stack || e).slice(0, 500); }
        })();
    });
    for (let i = 0; i < 400; i++) {
        const s = await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || ''));
            if (b) { b.click(); return 'clicked'; }
            return window.__tstLoad.done ? 'done' : (window.__tstLoad.err ? 'err' : 'wait');
        });
        if (s === 'done' || s === 'err') break;
        await new Promise(r => setTimeout(r, 250));
    }
    const loadErr = await page.evaluate(() => window.__tstLoad.err);
    check(!loadErr, 'lazy reopen completed', loadErr || undefined);

    // ---- hydrate a mid-project frame, sanity the reopened state ----
    const F = Math.floor(FRAMES / 2);
    const pre = await page.evaluate(async (F) => {
        const tri = await import('/pose/triangulation.js');
        await tri.ensureLazyFrameData(F);
        const st = window.__lucid.state;
        st.currentFrame = F;
        const s = st.session;
        const gs = s.instanceGroups.get(F) || [];
        return {
            resident: s.frameGroups.size,
            groupIds: gs.map(g => g.identityId),
            trackless: gs.every(g => [...g.instances.values()].every(i => i.trackIdx == null)),
        };
    }, F);
    check(pre.groupIds.join(',') === '0,1',
        `reopened groups still carry identityId 0 and 1 at frame ${F}`, pre.groupIds);
    check(pre.trackless, 'precondition: every member is TRACKLESS (the reported state)');
    check(pre.resident < FRAMES / 4, 'lazy precondition: most frames not resident', { resident: pre.resident });

    // ---- ungroup BOTH groups via the real UI, read the table ----
    const readRows = `(() => {
        const rows = [];
        let camera = null;
        for (const tr of document.querySelectorAll('#unlinkedTable tbody tr')) {
            if (tr.classList.contains('unlinked-camera-header')) { camera = tr.textContent.trim(); continue; }
            const sels = tr.querySelectorAll('select');
            const idSel = sels[1];
            const opt = idSel ? idSel.options[idSel.selectedIndex] : null;
            rows.push({ camera, id: opt ? opt.textContent : null });
        }
        return rows;
    })()`;
    const after = await page.evaluate(async ({ F, readRowsSrc }) => {
        const wiring = await import('/ui/ui-wiring.js');
        const ip = await import('/ui/info-panel.js');
        const s = window.__lucid.state.session;
        for (const g of [...(s.instanceGroups.get(F) || [])]) wiring.unlinkGroup(g);
        ip.updateInfoPanel();
        return { rows: eval(readRowsSrc), groupsLeft: (s.instanceGroups.get(F) || []).length };
    }, { F, readRowsSrc: readRows });
    check(after.groupsLeft === 0, 'both groups were ungrouped', { left: after.groupsLeft });
    check(after.rows.length === 6, '6 ungrouped rows (2 animals x 3 cameras)', { got: after.rows.length });
    console.log('    rows:', JSON.stringify(after.rows));
    const dashes = after.rows.filter(r => r.id === '—' || r.id == null);
    check(dashes.length === 0, 'NO row lost its ID to "—" (the reported bug)', { dashes: dashes.length });
    check(after.rows.filter(r => r.id === 'id_0').length === 3, 'id_0 retained in all 3 views');
    check(after.rows.filter(r => r.id === 'id_1').length === 3, 'id_1 retained in all 3 views');

    // ---- switch ONE view's id_0 row to id_1 via the real dropdown ----
    const oneView = await page.evaluate(async ({ readRowsSrc }) => {
        const ip = await import('/ui/info-panel.js');
        let camera = null, target = null;
        for (const tr of document.querySelectorAll('#unlinkedTable tbody tr')) {
            if (tr.classList.contains('unlinked-camera-header')) { camera = tr.textContent.trim(); continue; }
            const sels = tr.querySelectorAll('select');
            const idSel = sels[1];
            if (camera === 'cam1' && idSel && idSel.options[idSel.selectedIndex].textContent === 'id_0') {
                target = idSel; break;
            }
        }
        if (!target) return { error: 'no cam1 id_0 row found' };
        target.value = '1';
        target.dispatchEvent(new Event('change', { bubbles: true }));
        ip.updateInfoPanel();
        return {
            rows: eval(readRowsSrc),
            status: (document.getElementById('statusText') || {}).textContent || null,
        };
    }, { readRowsSrc: readRows });
    check(!oneView.error, 'found and drove cam1\'s id_0 dropdown', oneView.error || undefined);
    console.log('    after 1-view switch:', JSON.stringify(oneView.rows));
    const byCam = (cam) => oneView.rows.filter(r => r.camera === cam).map(r => r.id).sort();
    check(byCam('cam1').join(',') === 'id_0,id_1',
        'cam1 still has one of each — the other row took the vacated id_0', byCam('cam1'));
    for (const cam of ['cam0', 'cam2']) {
        check(byCam(cam).join(',') === 'id_0,id_1', `${cam} untouched`, byCam(cam));
    }

    // ---- regroup the three rows now reading id_0: identity must survive ----
    const regrouped = await page.evaluate(async (F) => {
        const s = window.__lucid.state.session;
        const fg = s.getFrameGroup(F);
        const picked = [];
        for (const cn of ['cam0', 'cam1', 'cam2']) {
            for (const ul of (fg.getUnlinkedInstances(cn) || [])) {
                const v = s.getIdentityIdForUnlinkedInstance(cn, ul.instance, F);
                if (v === 0) { picked.push(ul); break; }
            }
        }
        if (picked.length !== 3) return { error: 'expected 3 id_0 rows, got ' + picked.length };
        const g = s.createGroupFromUnlinked(F, picked);
        const ident = s.getIdentity(g.identityId);
        return {
            name: ident ? ident.name : null,
            members: g.instances.size,
            memberLevelIds: [...g.instances.values()].map(i => i.identityId),
        };
    }, F);
    check(!regrouped.error, 'regrouped the three id_0 rows', regrouped.error || undefined);
    check(regrouped.members === 3, 'regrouped group has 3 views', { got: regrouped.members });
    check(regrouped.name === 'id_0', 'regrouping keeps the animal\'s ID', { got: regrouped.name });
    check((regrouped.memberLevelIds || []).every(v => v == null),
        'the group consumed the instance-level retained copies', regrouped.memberLevelIds);

    check(errs.length === 0, 'no page/console errors', errs.length ? errs.slice(0, 3) : undefined);
    await browser.close();
} finally {
    server.kill();
    if (!process.env.KEEP) { try { fs.unlinkSync(fixturePath); } catch {} }
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
