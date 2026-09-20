/**
 * _diag-triangulate-all-after-reopen.mjs — what does Triangulate All do to a
 * LAZILY REOPENED project?
 *
 * REPORTED (user, real project): after reopen -> Triangulate All, the instance
 * info panel kept reprojections only for the frame they were sitting on and
 * "deleted the rest"; a second attempt appeared to clear the 3D/IDs for
 * instances in most-but-not-all cameras (the first camera kept them).
 *
 * HYPOTHESIS from reading the code (`pose/triangulation.js`):
 *
 *  A. `triangulateAllFrames` never hydrates lazy 2D — there is no
 *     `ensureLazyFrameData`/`batchLoadLazyFrames` call in it. A reopened project
 *     builds its group members as NULL-FILLED PLACEHOLDER `Instance`s
 *     (`reconstructInstanceGroupsFromSessionLazy`), so `hasAnyUsablePoint()` is
 *     false, `viewsWithLabels < 2`, and the sweep `continue`s. Those groups keep
 *     their loaded `points3d` but get NO `reprojections` and no
 *     `state.triangulationResults` entry — while `setReprojErrorVisible(true)`
 *     turns the reprojection UI on globally. Hence "only the frame I was on has
 *     reprojections".
 *
 *  B. For frames that ARE resident, the sweep re-triangulates from whatever 2D
 *     happens to be hydrated. If hydration is PARTIAL (some cameras real, others
 *     still placeholders) it can triangulate from a subset >= 2 and then
 *     OVERWRITE the good loaded `points3d` and rebuild `usedCameras` from only
 *     the hydrated cameras — which would explain "most but not all cameras".
 *
 * This measures both: how many frames actually triangulate, whether any group's
 * loaded 3D is destroyed, and whether `usedCameras` shrinks.
 *
 * Run: node tests/e2e/_diag-triangulate-all-after-reopen.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8199);

const log = (m) => console.log(m);
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', e => log('[pageerror] ' + String(e).slice(0, 300)));
    page.on('console', m => {
        const t = m.text();
        if (/triangulate-all|Triangulated|No frames to triangulate/.test(t)) log('  [page] ' + t.slice(0, 200));
    });

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm, { timeout: 120000 });

    // ---- 1. build + save a calibrated multi-frame project ----
    const built = await page.evaluate(async () => {
        const [pd, fileio] = await Promise.all([
            import('/pose/pose-data.js'), import('/import-export/file-io.js'),
        ]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const CAMS = ['camA', 'camB', 'camC'];
        const NODES = ['nose', 'neck', 'tail'];
        const NFRAMES = 8;
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        // Real, distinct extrinsics so triangulation is well-conditioned.
        const RV = [[0, 0, 0], [0, 0.6, 0], [0, -0.6, 0]];
        const TV = [[0, 0, 0], [-40, 0, 5], [40, 0, 5]];
        const cameras = CAMS.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], RV[i], TV[i], [512, 512]));
        const skeleton = new Skeleton('skeleton', NODES, [[0, 1], [1, 2]]);
        const session = new Session(cameras, skeleton, ['track_0'], 'TriAfterReopen');
        session.identities = [{ id: 0, name: 'animal0' }];

        for (let f = 0; f < NFRAMES; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const g = new InstanceGroup(f + 1, 0);
            CAMS.forEach((cn, ci) => {
                const inst = new Instance(
                    NODES.map((_, k) => [200 + f * 3 + ci * 12 + k * 4, 240 + f * 2 + ci * 5 + k * 3]),
                    0, 'user', 1);
                inst._rawInstIndex = 0;
                fg.addInstance(cn, inst);
                g.addInstance(cn, inst);
            });
            g.points3d = new Float64Array([
                1 + f, 2 + f, 30 + f, 4 + f, 5 + f, 31 + f, 7 + f, 8 + f, 32 + f,
            ]);
            g.usedCameras = new Set(CAMS);
            session.instanceGroups.set(f, [g]);
            session.setIdentityForFrame && session.setIdentityForFrame(f, 0);
        }
        const views = CAMS.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: NFRAMES }));
        const videoFiles = CAMS.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const labels = fileio.buildSlpLabelsAllViews(session, views, videoFiles);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        window.__slpBytes = bytes;
        return { bytes: bytes.length, NFRAMES, CAMS };
    });
    log(`built + saved: ${built.bytes} bytes, ${built.NFRAMES} frames, ${built.CAMS.length} cameras`);

    // ---- 2. lazily REOPEN it through the real app loader ----
    await page.evaluate(async () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__p';
        inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
        const dt = new DataTransfer();
        dt.items.add(new File([window.__slpBytes], 'tri.slp', { type: 'application/octet-stream' }));
        inp.files = dt.files;
        window.__r = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('/loading/session-loader.js');
                await sl.handleLoadProjectSlpLazy(inp.files[0]);
                window.__r.done = true;
            } catch (e) { window.__r.err = String(e && e.stack || e).slice(0, 400); }
        })();
    });
    for (let i = 0; i < 120; i++) {
        const st = await page.evaluate(() => {
            const skip = [...document.querySelectorAll('button')].find(b => /Skip|Later/i.test(b.textContent || ''));
            if (skip) { skip.click(); return 'clicked'; }
            return window.__r.done ? 'done' : (window.__r.err ? 'err' : 'wait');
        });
        if (st === 'done' || st === 'err') break;
        await new Promise(r => setTimeout(r, 250));
    }

    // ---- 3. snapshot 3D BEFORE, run Triangulate All, snapshot AFTER ----
    const res = await page.evaluate(async () => {
        const tri = await import('/pose/triangulation.js');
        const st = window.__lucid.state;
        const s = st.session;
        const out = { err: window.__r.err };

        const snap = () => {
            const rows = [];
            for (const [f, groups] of s.instanceGroups) {
                for (const g of groups) {
                    const p = g.points3d;
                    rows.push({
                        f,
                        n3d: p ? (p.length / 3) | 0 : 0,
                        // Sum only finite coords: NaN-ing the array is a real failure
                        // mode and must not read as "unchanged".
                        sum: p ? Array.from(p).reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0) : 0,
                        nNaN: p ? Array.from(p).filter(v => !Number.isFinite(v)).length : 0,
                        used: g.usedCameras ? g.usedCameras.size : -1,
                        nReproj: g.reprojections ? Object.keys(g.reprojections).length : 0,
                        members: g.instances ? g.instances.size : 0,
                        // How many members carry REAL 2D vs a null placeholder?
                        withUsable2d: g.instances
                            ? [...g.instances.values()].filter(i => i && i.hasAnyUsablePoint && i.hasAnyUsablePoint()).length
                            : -1,
                    });
                }
            }
            return rows;
        };

        out.before = snap();
        out.residentFramesBefore = s.frameGroups ? s.frameGroups.size : 0;
        out.triResultsBefore = st.triangulationResults ? st.triangulationResults.size : 0;

        await tri.triangulateAllFrames('dlt');

        out.after = snap();
        out.residentFramesAfter = s.frameGroups ? s.frameGroups.size : 0;
        out.triResultsAfter = st.triangulationResults ? st.triangulationResults.size : 0;
        out.status = (document.getElementById('statusText') || {}).textContent || '';
        return out;
    });

    if (res.err) log('reopen error: ' + res.err);
    log('');
    log(`resident frameGroups: before=${res.residentFramesBefore} after=${res.residentFramesAfter}`);
    log(`triangulationResults: before=${res.triResultsBefore} after=${res.triResultsAfter}  (of ${res.before.length} groups)`);
    log(`status: ${res.status}`);
    log('');
    log('  frame | 3D pts | finite-sum        | NaNs | usedCams | reproj | members(real 2D)');
    const byF = new Map(res.after.map(r => [r.f, r]));
    let wiped = 0, naned = 0, shrunk = 0, noReproj = 0;
    for (const b of res.before) {
        const a = byF.get(b.f);
        if (!a) continue;
        const flag = [];
        if (a.n3d === 0 && b.n3d > 0) { flag.push('3D-WIPED'); wiped++; }
        if (a.nNaN > b.nNaN) { flag.push('NaN-INTRODUCED'); naned++; }
        if (a.sum !== b.sum) flag.push('3D-CHANGED');
        if (a.used < b.used) { flag.push('usedCameras-SHRANK'); shrunk++; }
        if (a.nReproj === 0) noReproj++;
        log(`  ${String(b.f).padStart(5)} | ${String(a.n3d).padStart(6)} | ${String(a.sum).padStart(17)} | ` +
            `${String(a.nNaN).padStart(4)} | ${String(a.used).padStart(8)} | ${String(a.nReproj).padStart(6)} | ` +
            `${a.members}(${a.withUsable2d})   ${flag.join(' ')}`);
    }
    log('');
    log(`SUMMARY: ${res.before.length} groups — 3D wiped: ${wiped}, NaN introduced: ${naned}, ` +
        `usedCameras shrank: ${shrunk}, groups with NO reprojections after: ${noReproj}`);
} catch (err) {
    log('FATAL ' + String(err).slice(0, 500));
} finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    server.kill();
}
process.exit(0);
