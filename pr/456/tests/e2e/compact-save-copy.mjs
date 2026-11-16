/**
 * compact-save-copy.mjs — how a big project is saved: column chunks (LUCID local
 * patch "column chunks") on every save, and File ▸ Save Compact Copy (patch
 * "compact save", import-export/compact-save.js, ui/compact-save-modal.js).
 *
 * A LUC3D session with 72,000 predicted keypoint rows (one full 65,536-row column
 * chunk and a partial one) and 36,000 instances is saved by the in-memory writer,
 * reopened lazily, and saved again by the streaming writer large projects use.
 *  1. Both writers store the 2D tables in 65,536-row chunks of ONE column, and the
 *     lazy re-save holds the same values as the first save. No compact marker.
 *  2. Save Compact Copy: the dialog says what is rounded and lost, has Cancel
 *     focused, and Esc cancels without writing.
 *  3. Continue: predicted x/y are multiples of 1/64 px and within 1/128 px of the
 *     full save, scores multiples of 1/1024; visibility, user keypoints, frames
 *     and instances are exact; the file carries the `lucid_compact` marker.
 *  4. The open project is untouched: same file handle, still unsaved if it was.
 *  5. Reopening the copy says it is a compact copy; saving it again keeps the
 *     marker (its data stay rounded).
 *
 * Run: node tests/e2e/compact-save-copy.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT || 8296);
let fails = 0;
const check = (c, m, extra) => { console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
if (server.exitCode !== null) { console.error(`port ${PORT} is in use; pass PORT= a free port`); process.exit(2); }

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(300000);
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.SleapIO && window.h5wasm && window.__lucid, null, { timeout: 120000 });

    // Save-picker stand-ins that keep what is written; a reader for those files; the session.
    await page.evaluate(async () => {
        window.__files = {};
        window.__handle = (name) => ({
            name, kind: 'file',
            createWritable: async () => {
                const parts = [];
                return {
                    write: async (c) => { const u = c instanceof Uint8Array ? c : new Uint8Array(c.buffer || c); parts.push(u.slice()); },
                    close: async () => {
                        const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
                        let o = 0;
                        for (const p of parts) { out.set(p, o); o += p.length; }
                        window.__files[name] = out;
                    },
                    abort: async () => {},
                };
            },
        });
        window.showSaveFilePicker = async (o) => window.__handle((o && o.suggestedName) || 'saved.slp');
        window.__read = async (bytes, tag) => {
            const h5 = await import('h5wasm');
            await h5.ready;
            const p = '/__' + tag + '.slp';
            h5.FS.writeFile(p, bytes);
            const f = new h5.File(p, 'r'), out = {};
            for (const n of ['frames', 'instances', 'points', 'pred_points']) {
                const d = f.get(n);
                out[n] = { shape: d.shape, chunks: d.metadata.chunks, value: Array.from(d.value, Number) };
            }
            out.provenance = JSON.parse(f.get('metadata').attrs.json.value).provenance || null;
            f.close();
            h5.FS.unlink(p);
            return out;
        };

        const pd = await import('./pose/pose-data.js'), AS = await import('./ui/app-state.js');
        const NODES = ['a', 'b', 'c', 'd'];
        const cam = (n, rvec, tvec) => new pd.Camera(n, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
        const CAMS = [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3])];
        const s = new pd.Session(CAMS, new pd.Skeleton('sk', NODES, []), ['t0', 't1'], 'fixture');
        const val = (k) => Math.sin(k * 12.9898) * 300.123457 + 320;
        let seed = 0;
        const FRAMES = 9000;
        for (let f = 0; f < FRAMES; f++) {
            const fg = new pd.FrameGroup(f);
            for (const c of CAMS) {
                const k = seed++ * 4;
                const pred = new pd.Instance(NODES.map((_, i) => [val(k + i), val(k + i + 0.5)]), f % 2, 'predicted', 0.9);
                pred.setPointScores(NODES.map((_, i) => Math.abs(Math.sin(k + i)) * 0.99));
                fg.addInstance(c.name, pred);
                fg.addInstance(c.name, new pd.Instance(NODES.map((_, i) => [val(k + i + 0.25), val(k + i + 0.75)]), (f + 1) % 2, 'user', null));
            }
            s.addFrameGroup(fg);
        }
        AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
        AS.state.totalFrames = FRAMES; AS.state.currentFrame = 0; AS.state.views = []; AS.state.fps = 30;
        AS.state.triangulationResults = new Map();
    });

    console.log('1. Save, by both writers');
    await page.evaluate(async () => {
        const st = (await import('./ui/app-state.js')).state;
        st.slpFileHandle = window.__handle('eager.slp');
        await (await import('./import-export/save-load.js')).quickSave();
        const sl = await import('./loading/session-loader.js');
        window.__opening = sl.handleLoadProjectSlpLazy(new File([window.__files['eager.slp']], 'eager.slp'));
    });
    await page.getByRole('button', { name: /Skip/ }).click();
    await page.evaluate(() => window.__opening);
    check(await page.evaluate(() => !!(window.__lucid.state.session && window.__lucid.state.session.lazyLoader)), 'the saved project reopened lazily');
    await page.evaluate(async () => {
        const st = (await import('./ui/app-state.js')).state;
        st.slpFileHandle = window.__handle('full.slp');
        await (await import('./import-export/save-load.js')).quickSave();
    });
    const full = await page.evaluate(async () => {
        const e = await window.__read(window.__files['eager.slp'], 'eager'), g = await window.__read(window.__files['full.slp'], 'full');
        const sorted = (t, w) => { const rows = []; for (let i = 0; i < t.value.length; i += w) rows.push(t.value.slice(i, i + w).join(',')); return rows.sort().join(';'); };
        return {
            chunks: { eagerPred: e.pred_points.chunks, eagerInst: e.instances.chunks, pred: g.pred_points.chunks, inst: g.instances.chunks },
            rows: { pred: g.pred_points.shape[0], inst: g.instances.shape[0] },
            samePred: sorted(e.pred_points, 5) === sorted(g.pred_points, 5),
            samePoints: sorted(e.points, 4) === sorted(g.points, 4),
            provenance: g.provenance,
        };
    });
    check(full.rows.pred > 65536 && full.rows.inst > 8192 && full.rows.inst < 65536, 'the fixture fills one column chunk and part of another', full.rows);
    check(Object.values(full.chunks).every((c) => JSON.stringify(c) === '[65536,1]'), 'both writers store the 2D tables in 65,536-row chunks of one column', full.chunks);
    check(full.samePred && full.samePoints, 'the lazy re-save holds the same keypoints as the first save', full);
    check(!(full.provenance && full.provenance.lucid_compact), 'a normal save writes no compact marker');

    console.log('2. the dialog');
    const handleBefore = await page.evaluate(async () => {
        const st = (await import('./ui/app-state.js')).state;
        st.isDirty = true;
        window.__compactPick = (o) => Promise.resolve(window.__handle(o.suggestedName));
        window.__c = (await import('./import-export/save-load.js')).saveCompactCopy({ pickFile: (o) => window.__compactPick(o) });
        return st.slpFileHandle.name;
    });
    await page.locator('.compact-save-modal').waitFor();
    const dlg = await page.evaluate(() => ({ text: document.querySelector('.compact-save-modal').textContent, focus: document.activeElement && document.activeElement.id }));
    check(/1\/64 pixel/.test(dlg.text) && /at most 0\.0078 px/.test(dlg.text) && /1\/1024/.test(dlg.text), 'it says what is rounded and by how much');
    check(/What is lost/.test(dlg.text) && /exact equality/.test(dlg.text), 'and what is lost');
    check(/user\) keypoints/.test(dlg.text) && /not changed/.test(dlg.text), 'and what is kept, and that the open project is not changed');
    check(dlg.focus === 'compactSaveCancel', 'Cancel has the focus', dlg.focus);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__c);
    check(await page.evaluate(() => !document.querySelector('.compact-save-modal') && !Object.keys(window.__files).some((n) => /compact/.test(n))), 'Esc cancels and writes nothing');

    console.log('3. Save Compact Copy');
    await page.evaluate(async () => { window.__c = (await import('./import-export/save-load.js')).saveCompactCopy({ pickFile: (o) => window.__compactPick(o) }); });
    await page.locator('#compactSaveContinue').click();
    await page.evaluate(() => window.__c);
    const compact = await page.evaluate(async () => {
        const name = Object.keys(window.__files).find((n) => /compact/.test(n));
        if (!name) return { name: null, status: document.getElementById('statusText').textContent };
        const src = await window.__read(window.__files['full.slp'], 'src'), got = await window.__read(window.__files[name], 'cmp');
        const P = src.pred_points.value, Q = got.pred_points.value;
        let xyOff = 0, xyMax = 0, scoreOff = 0, flagsDiffer = 0, changed = 0;
        for (let i = 0; i < P.length; i += 5) {
            for (const c of [0, 1]) {
                if (Q[i + c] * 64 !== Math.round(Q[i + c] * 64)) xyOff++;
                xyMax = Math.max(xyMax, Math.abs(Q[i + c] - P[i + c]));
            }
            if (P[i] !== Q[i]) changed++;
            if (Q[i + 4] * 1024 !== Math.round(Q[i + 4] * 1024)) scoreOff++;
            if (P[i + 2] !== Q[i + 2] || P[i + 3] !== Q[i + 3]) flagsDiffer++;
        }
        const exact = {};
        for (const n of ['frames', 'instances', 'points']) exact[n] = src[n].value.length === got[n].value.length && src[n].value.every((v, i) => Object.is(v, got[n].value[i]));
        return { name, xyOff, xyMax, scoreOff, flagsDiffer, exact, changed, marker: got.provenance && got.provenance.lucid_compact,
            size: [window.__files['full.slp'].length, window.__files[name].length], status: document.getElementById('statusText').textContent };
    });
    check(!!compact.name, 'a compact copy was written', compact.status);
    check(compact.xyOff === 0 && compact.xyMax <= 1 / 128 + 1e-12 && compact.changed > 0, 'predicted x/y are rounded to 1/64 px, each by at most 1/128 px', compact);
    check(compact.scoreOff === 0, 'scores are multiples of 1/1024');
    check(compact.flagsDiffer === 0, 'visibility is unchanged');
    check(Object.values(compact.exact || {}).every(Boolean), 'user keypoints, frames and instances are exact', compact.exact);
    check(compact.marker && compact.marker.xy_px === 1 / 64, 'the copy carries the compact marker', compact.marker);
    check(compact.size && compact.size[1] < compact.size[0], 'and is smaller: ' + JSON.stringify(compact.size));
    check(/compact copy/i.test(compact.status) && /rounded/.test(compact.status), 'the status says it saved a rounded copy: ' + compact.status);

    console.log('4. the open project');
    const after = await page.evaluate(async () => { const st = (await import('./ui/app-state.js')).state; return { handle: st.slpFileHandle && st.slpFileHandle.name, dirty: st.isDirty }; });
    check(after.handle === handleBefore, 'still linked to its own file', after);
    check(after.dirty === true, 'and still unsaved', after);

    console.log('5. reopening the copy');
    await page.evaluate(async () => {
        const name = Object.keys(window.__files).find((n) => /compact/.test(n));
        (await import('./ui/app-state.js')).state.isDirty = false;
        const sl = await import('./loading/session-loader.js');
        window.__opening = sl.handleLoadProjectSlpLazy(new File([window.__files[name]], name));
    });
    await page.getByRole('button', { name: /Skip/ }).click();
    const reopened = await page.evaluate(async () => {
        await window.__opening;
        const status = document.getElementById('statusText').textContent;
        (await import('./ui/app-state.js')).state.slpFileHandle = window.__handle('resaved.slp');
        await (await import('./import-export/save-load.js')).quickSave();
        const got = await window.__read(window.__files['resaved.slp'], 'resaved');
        return { status, marker: got.provenance && got.provenance.lucid_compact };
    });
    check(/compact copy/.test(reopened.status) && /1\/64 px/.test(reopened.status), 'opening it says it is a compact copy: ' + reopened.status);
    check(!!reopened.marker, 'saving it again keeps the marker');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\nFAILED: ${fails}` : '\nAll passed.');
process.exit(fails ? 1 : 0);
