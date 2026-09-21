/**
 * _bench-3dviewer-hidden.mjs — what does hiding the 3D viewer / info panel
 * actually save, on a REAL lazy-loaded project?
 *
 * Investigation tool, not an assertion (the `_bench-` prefix keeps it out of
 * suite runs). It answers a specific question: the panel gates added in the
 * `\` / `I` toggle fix skip rendering and DOM work — but do they skip any of
 * the lazy loader's per-frame hydration, which is what actually dominates a
 * big project?
 *
 * Method: build a synthetic multi-camera `.slp`, reopen it through the real
 * `handleLoadProjectSlpLazy` so most frames are NOT resident, then scrub a
 * fresh frame range under each panel configuration and report, per config:
 *
 *   - COLD pass over a range nobody has touched: includes lazy hydration.
 *   - WARM pass over the SAME range, now resident: pure render + DOM cost.
 *   - frames hydrated (`session.frameGroups.size` delta) — the I/O proxy.
 *   - `renderer.render` calls and `updateSkeleton` (geometry rebuild) calls.
 *
 * Each config gets its OWN disjoint range so the cold numbers are comparable;
 * the warm pass re-walks that same range.
 *
 *   FRAMES=3000 CAMS=4 NODES=15 SCRUB=120 node tests/e2e/_bench-3dviewer-hidden.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8462);
const FRAMES = Number(process.env.FRAMES || 3000);
const CAMS = Number(process.env.CAMS || 4);
const NODES = Number(process.env.NODES || 15);
const SCRUB = Number(process.env.SCRUB || 120);

const log = (...a) => console.log(...a);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-bench3d-'));
const fixturePath = path.join(outDir, 'fixture.slp');

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    page.on('pageerror', e => log('  [pageerror]', String(e).slice(0, 200)));

    let sink = { fd: null, bytes: 0, target: null };
    await page.exposeFunction('__benchWrite', (b64) => {
        const buf = Buffer.from(b64, 'base64');
        if (sink.fd === null) sink.fd = fs.openSync(sink.target, 'w');
        fs.writeSync(sink.fd, buf);
        sink.bytes += buf.length;
    });

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm, { timeout: 120000 });
    log('app booted');

    await page.evaluate(() => {
        window.__benchB64 = (u8) => {
            let s = ''; const C = 0x8000;
            for (let o = 0; o < u8.length; o += C) s += String.fromCharCode.apply(null, u8.subarray(o, o + C));
            return btoa(s);
        };
    });

    // ---------------- build a fixture big enough to come back lazy -----------
    log(`building fixture: ${FRAMES} frames x ${CAMS} cams x ${NODES} nodes ...`);
    sink = { fd: null, bytes: 0, target: fixturePath };
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
            return new Camera(n, M, [0, 0, 0, 0, 0], [0, a, 0],
                [-40 * Math.sin(a), 0, 40 * (1 - Math.cos(a))], [512, 512]);
        });
        const skeleton = new Skeleton('skeleton', nodeNames,
            nodeNames.slice(1).map((_, i) => [i, i + 1]));
        const session = new Session(cameras, skeleton, ['track_0', 'track_1'], 'BenchFixture');
        session.identities = [{ id: 0, name: 'animal0' }, { id: 1, name: 'animal1' }];
        const xy = (f, c, k) => [180 + (f % 97) * 1.5 + c * 11 + k * 3, 200 + (f % 89) * 1.25 + c * 7 + k * 2];
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const groups = [];
            for (let a = 0; a < 2; a++) {
                const g = new InstanceGroup(f * 2 + a + 1, a);
                camNames.forEach((cn, ci) => {
                    const inst = new Instance(nodeNames.map((_, k) => {
                        const p = xy(f, ci, k);
                        return a === 0 ? p : [p[0] + 120, p[1] + 60];
                    }), a, 'predicted', 1);
                    inst._rawInstIndex = a;
                    fg.addInstance(cn, inst);
                    g.addInstance(cn, inst);
                });
                g.points3d = new Float64Array(NODES * 3).fill(0)
                    .map((_, i) => (f % 31) + i * 0.5 + a * 40);
                groups.push(g);
                for (let ci = 0; ci < camNames.length; ci++) session.setFrameIdentity(f, camNames[ci], a, a);
            }
            session.instanceGroups.set(f, groups);
        }
        const views = camNames.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES }));
        const videoFiles = camNames.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const labels = fileio.buildSlpLabelsAllViews(session, views, videoFiles);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        await window.__benchWrite(window.__benchB64(bytes));
    }, { FRAMES, CAMS, NODES });
    if (sink.fd !== null) fs.closeSync(sink.fd);
    log(`fixture written: ${sink.bytes.toLocaleString()} bytes`);

    // ---------------- reopen it through the real lazy loader ----------------
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__benchPick';
        inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
    });
    await page.setInputFiles('#__benchPick', fixturePath);
    await page.evaluate(() => {
        window.__benchLoad = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('/loading/session-loader.js');
                await sl.handleLoadProjectSlpLazy(document.getElementById('__benchPick').files[0]);
                window.__benchLoad.done = true;
            } catch (e) { window.__benchLoad.err = String(e && e.stack || e).slice(0, 400); }
        })();
    });
    for (let i = 0; i < 1200; i++) {
        const s = await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || ''));
            if (b) { b.click(); return 'clicked'; }
            return window.__benchLoad.done ? 'done' : (window.__benchLoad.err ? 'err' : 'wait');
        });
        if (s === 'done' || s === 'err') break;
        await new Promise(r => setTimeout(r, 250));
    }
    const loadErr = await page.evaluate(() => window.__benchLoad.err);
    if (loadErr) throw new Error('lazy reopen failed: ' + loadErr);

    const pre = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        return { resident: s.frameGroups.size, lazy: !!s.lazyLoader, igFrames: s.instanceGroups.size };
    });
    log(`reopened lazily: lazyLoader=${pre.lazy}, resident=${pre.resident}/${FRAMES}, ` +
        `instanceGroup frames=${pre.igFrames}`);
    if (!pre.lazy || pre.resident > FRAMES / 10) {
        log('!! NOT lazy enough — numbers below would not answer the question. Raise FRAMES.');
    }

    // ---------------- instrumentation ---------------------------------------
    await page.evaluate(() => {
        window.__benchCounters = { render: 0, updateSkeleton: 0 };
        window.__benchInstrument = () => {
            const vp = window.__lucid.viewport3d;
            if (!vp || vp.__benchWrapped) return !!vp;
            const realRender = vp.renderer.render.bind(vp.renderer);
            vp.renderer.render = function (...a) { window.__benchCounters.render++; return realRender(...a); };
            const realUS = vp.updateSkeleton.bind(vp);
            vp.updateSkeleton = function (...a) { window.__benchCounters.updateSkeleton++; return realUS(...a); };
            vp.__benchWrapped = true;
            return true;
        };
        window.__benchInstrument();

        /**
         * Walk `frames`, doing per frame exactly what an interactive scrub
         * does: hydrate if needed, redraw the overlays, update the seekbar
         * (which is what drives the 3D viewport).
         */
        window.__benchScrub = async (frames) => {
            const [tri, rd, uw] = await Promise.all([
                import('/pose/triangulation.js'), import('/ui/rendering.js'), import('/ui/ui-wiring.js'),
            ]);
            const st = window.__lucid.state;
            const s = st.session;
            const c0 = { ...window.__benchCounters };
            const res0 = s.frameGroups.size;
            const t0 = performance.now();
            for (const f of frames) {
                st.currentFrame = f;
                await tri.ensureLazyFrameData(f);
                rd.drawAllOverlays(f);
                uw.updateSeekbar(f);
            }
            const ms = performance.now() - t0;
            return {
                ms: +ms.toFixed(1),
                perFrame: +(ms / frames.length).toFixed(2),
                hydrated: s.frameGroups.size - res0,
                render: window.__benchCounters.render - c0.render,
                updateSkeleton: window.__benchCounters.updateSkeleton - c0.updateSkeleton,
            };
        };

        window.__benchSetPanels = (show3d, showInfo) => {
            const vp = document.getElementById('viewport3dContainer');
            const wrap = document.getElementById('infoPanelWrapper');
            const uwP = import('/ui/ui-wiring.js');
            return uwP.then((uw) => {
                if (vp.classList.contains('collapsed') === show3d) uw.toggle3DViewport();
                if (wrap.classList.contains('collapsed') === showInfo) uw.toggleInfoPanel();
                window.__benchInstrument();
                return {
                    vp3dCollapsed: vp.classList.contains('collapsed'),
                    infoCollapsed: wrap.classList.contains('collapsed'),
                };
            });
        };
    });

    const CONFIGS = [
        { name: 'both shown        ', show3d: true, showInfo: true },
        { name: '3D hidden         ', show3d: false, showInfo: true },
        { name: 'info hidden       ', show3d: true, showInfo: false },
        { name: 'both hidden       ', show3d: false, showInfo: false },
    ];

    // Disjoint, untouched range per config so COLD numbers are comparable.
    // Start well past 0 — the reopen already hydrated the first frames.
    const base = Math.floor(FRAMES * 0.2);
    const gap = Math.floor((FRAMES - base) / CONFIGS.length);

    log(`\nscrubbing ${SCRUB} frames per config (cold = first visit, warm = same range again)\n`);
    log('config              | cold ms/frame | warm ms/frame | hydrated | render | geomRebuild');
    log('--------------------+---------------+---------------+----------+--------+------------');

    const rows = [];
    for (let i = 0; i < CONFIGS.length; i++) {
        const c = CONFIGS[i];
        const start = base + i * gap;
        const frames = Array.from({ length: SCRUB }, (_, k) => start + k);

        const panels = await page.evaluate(([a, b]) => window.__benchSetPanels(a, b), [c.show3d, c.showInfo]);
        await page.waitForTimeout(500); // let the width transition settle

        const cold = await page.evaluate((f) => window.__benchScrub(f), frames);
        const warm = await page.evaluate((f) => window.__benchScrub(f), frames);

        rows.push({ c, panels, cold, warm });
        log(`${c.name}|${String(cold.perFrame).padStart(14)} |${String(warm.perFrame).padStart(14)} |` +
            `${String(cold.hydrated).padStart(9)} |${String(warm.render).padStart(7)} |` +
            `${String(warm.updateSkeleton).padStart(11)}`);
    }

    const shown = rows[0], no3d = rows[1], noInfo = rows[2], neither = rows[3];
    const pct = (a, b) => b === 0 ? 'n/a' : (((a - b) / a) * 100).toFixed(0) + '%';

    log(`\n--- warm scrub (pure render + DOM cost) ---`);
    log(`  hiding 3D      : ${shown.warm.perFrame} -> ${no3d.warm.perFrame} ms/frame  (${pct(shown.warm.perFrame, no3d.warm.perFrame)} faster)`);
    log(`  hiding info    : ${shown.warm.perFrame} -> ${noInfo.warm.perFrame} ms/frame  (${pct(shown.warm.perFrame, noInfo.warm.perFrame)} faster)`);
    log(`  hiding both    : ${shown.warm.perFrame} -> ${neither.warm.perFrame} ms/frame  (${pct(shown.warm.perFrame, neither.warm.perFrame)} faster)`);

    log(`\n--- cold scrub (includes lazy hydration) ---`);
    log(`  hiding 3D      : ${shown.cold.perFrame} -> ${no3d.cold.perFrame} ms/frame  (${pct(shown.cold.perFrame, no3d.cold.perFrame)} faster)`);
    log(`  hiding both    : ${shown.cold.perFrame} -> ${neither.cold.perFrame} ms/frame  (${pct(shown.cold.perFrame, neither.cold.perFrame)} faster)`);

    log(`\n--- frames HYDRATED per cold pass (the lazy-loader I/O) ---`);
    for (const r of rows) log(`  ${r.c.name}: ${r.cold.hydrated}`);
    log(`  -> identical means hiding a panel skips NO lazy loading. The gates are`);
    log(`     downstream of hydration; the loader is driven by the video canvases.`);

    log(`\n--- 3D work actually skipped (warm pass) ---`);
    for (const r of rows) {
        log(`  ${r.c.name}: renderer.render=${r.warm.render}  updateSkeleton=${r.warm.updateSkeleton}`);
    }
    log(`  NOTE render=0 in every row: the scrub loop above is tight enough to`);
    log(`  starve rAF, so it does NOT capture the standing render loop. That is`);
    log(`  measured separately below — its saving is ON TOP of the numbers above.`);

    // ---------------- the standing render loop ------------------------------
    // The cost the scrub loop can't see: an IDLE app with the panel open still
    // renders the whole scene every frame. Measure the idle rate, then the cost
    // of one render, to get main-thread ms/second spent on a viewport nobody is
    // looking at.
    log(`\n--- standing render loop while IDLE (what the scrub loop missed) ---`);
    await page.evaluate(([a, b]) => window.__benchSetPanels(a, b), [true, true]);
    await page.waitForTimeout(500);
    const idle = await page.evaluate(async () => {
        const vp = window.__lucid.viewport3d;
        const c0 = window.__benchCounters.render;
        const t0 = performance.now();
        await new Promise(r => setTimeout(r, 1500));
        const elapsed = performance.now() - t0;
        const renders = window.__benchCounters.render - c0;

        // Cost of one render on this scene, measured directly.
        const N = 60;
        const s0 = performance.now();
        for (let i = 0; i < N; i++) vp.renderer.render(vp.scene, vp.threeCamera);
        const msPerRender = (performance.now() - s0) / N;

        return {
            rendersPerSec: +(renders / (elapsed / 1000)).toFixed(1),
            msPerRender: +msPerRender.toFixed(3),
            sceneObjects: vp.scene.children.reduce((n, c) => { let k = 0; c.traverse(() => k++); return n + k; }, 0),
        };
    });
    const hiddenIdle = await page.evaluate(async ([a, b]) => {
        await window.__benchSetPanels(a, b);
        await new Promise(r => setTimeout(r, 500));
        const c0 = window.__benchCounters.render;
        const t0 = performance.now();
        await new Promise(r => setTimeout(r, 1500));
        const elapsed = performance.now() - t0;
        return {
            rendersPerSec: +((window.__benchCounters.render - c0) / (elapsed / 1000)).toFixed(1),
        };
    }, [false, true]);

    log(`  3D shown : ${idle.rendersPerSec} renders/sec x ${idle.msPerRender} ms = ` +
        `${(idle.rendersPerSec * idle.msPerRender).toFixed(1)} ms of main thread per second`);
    log(`  3D hidden: ${hiddenIdle.rendersPerSec} renders/sec = 0 ms`);
    log(`  (scene objects: ${idle.sceneObjects}; ms/render scales with scene complexity —`);
    log(`   more cameras, more animals and more nodes all push it up)`);
} catch (e) {
    console.error('FATAL', e);
} finally {
    if (browser) await browser.close();
    server.kill();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
}
