/**
 * overlay-export-node-labels.mjs — real-browser test for the `Show node labels`
 * toggle in File ▸ "Export Video Overlays" (issue #223).
 *
 * Before #223 the only way to get node names out of an exported overlay was to
 * drag "Node label size" to 0 — an off switch hidden at the bottom of a numeric
 * range, which reads as "make them tiny" and is the reason the issue was filed.
 * The toggle is now the gate and the size is only a size.
 *
 * What only a real browser can show, and what this therefore asserts:
 *  - the toggle exists in the User and Reprojection Appearance groups, beside
 *    `Show nodes` / `Show edges`, and NOT in Predicted — the live app hardcodes
 *    `predictedOpts.showLabels: false`, so a predicted toggle would be offering
 *    a layer the app cannot draw
 *  - `Node label size` floors at 1, so there is exactly ONE off switch
 *  - flipping it actually stops the node names being PAINTED, measured on the
 *    modal's own live preview with a `fillText` spy, over three flips so both
 *    directions are covered — the whole point is the pixels, and a settings
 *    assertion alone would pass on a build that wired the toggle to nothing
 *  - the marker and edge for that node are still drawn, so the toggle removes
 *    the label and nothing else
 *  - it survives a close/reopen, like every other appearance setting
 *  - a blob from an older build, where `labelSize: 0` WAS the off switch, comes
 *    back with labels off AND a usable size — otherwise the upgrade would both
 *    resurrect the labels and leave the new toggle dead
 *
 * Runs against a synthetic in-memory session — no video fixture required, so it
 * works in a worktree. The tiles render black; the overlays are what is measured.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8126);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- synthetic session: 2 CALIBRATED cameras, 40 frames, one group ------
    // The node names are deliberately nothing else in the UI says, so a spy that
    // sees "head" has seen a NODE label and not a track chip or a camera caption.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const names = ['cam1', 'cam2'];
        const cams = names.map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [100 * (i + 1), 0, 0], [0.1 * (i + 1), 0.2, 0.3], [640, 480]));
        const skel = new Skeleton('sk', ['zorblax', 'quibnar'], [[0, 1]]);
        const session = new Session(cams, skel, ['t0'], 'NodeLabelTest');

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const g = new InstanceGroup(1, -1);
        for (const n of names) {
            const inst = new Instance([[160, 180], [300, 320]], 0, 'user', 1);
            g.addInstance(n, inst);
            fg.addInstance(n, inst);
        }
        session.instanceGroups.set(0, [g]);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 40;
        AS.state.currentFrame = 0;
        AS.state.fps = 30;
        AS.state.triangulationResults = new Map();
        AS.state.views = names.map(n => ({
            name: n, decoder: null, canvas: null, ctx: null,
            overlayCanvas: null, overlayCtx: null, videoWidth: 640, videoHeight: 480,
        }));
        try { localStorage.removeItem('overlayExportSettings.v1'); } catch (e) { /* ignore */ }
    });

    const openModal = async () => {
        await page.evaluate(() => document.getElementById('menuExportOverlayVideo').click());
        await page.waitForSelector('#ovExportOverlay', { timeout: 10000 });
        await page.waitForTimeout(700);
    };
    await openModal();

    // ---- the toggle is where the other two "show" switches are --------------
    // Scoped per appearance GROUP, because `data-ov` carries only the key and
    // `showLabels` is deliberately the same key in both groups (as `showNodes`
    // and `showEdges` already are).
    const groups = await page.evaluate(() => {
        const out = {};
        document.querySelectorAll('#ovSettings details').forEach(d => {
            const title = d.querySelector('summary').textContent.trim();
            out[title] = Array.from(d.querySelectorAll('[data-ov]')).map(b => ({
                key: b.getAttribute('data-ov'),
                label: b.closest('div').textContent.trim(),
            }));
        });
        return out;
    });
    const keysOf = g => (groups[g] || []).map(e => e.key);
    check(keysOf('User Appearance').includes('showLabels'),
        `User Appearance has a node-label toggle (got ${keysOf('User Appearance').join(', ')})`);
    check(keysOf('Reprojection Appearance').includes('showLabels'),
        `Reprojection Appearance has one too (got ${keysOf('Reprojection Appearance').join(', ')})`);
    check(!keysOf('Predicted Appearance').includes('showLabels'),
        'Predicted Appearance has NO node-label toggle — the app has no such layer');
    const userEntry = (groups['User Appearance'] || []).find(e => e.key === 'showLabels');
    check(userEntry && userEntry.label === 'Show node labels',
        `…and it is labelled "Show node labels" (got ${JSON.stringify(userEntry && userEntry.label)})`);
    // It sits WITH the other two switches rather than off among the numbers.
    const order = keysOf('User Appearance');
    check(order.indexOf('showLabels') === order.indexOf('showEdges') + 1,
        `the toggle follows Show edges directly (order: ${order.join(', ')})`);

    // ---- the size field is a size, not a second off switch ------------------
    const mins = await page.evaluate(() => {
        const out = {};
        document.querySelectorAll('#ovSettings details').forEach(d => {
            const title = d.querySelector('summary').textContent.trim();
            // `addNumber` builds its row as a <label>; `addCheck` uses a <div>.
            Array.from(d.querySelectorAll('label, div')).forEach(r => {
                if (!/^Node label size/.test(r.textContent.trim())) return;
                const inp = r.querySelector('input[type="number"]');
                if (inp) out[title] = inp.min;
            });
        });
        return out;
    });
    check(mins['User Appearance'] === '1',
        `User "Node label size" floors at 1, not 0 (got ${mins['User Appearance']})`);
    check(mins['Reprojection Appearance'] === '1',
        `Reprojection gained its own size field, also floored at 1 (got ${mins['Reprojection Appearance']})`);

    // ---- the toggle actually stops the PAINTING -----------------------------
    // Spy on the live preview rather than on `settings`: a build that wired the
    // checkbox to a key nothing reads would pass a settings-only assertion.
    const painted = await page.evaluate(async () => {
        const proto = CanvasRenderingContext2D.prototype;
        const realFill = proto.fillText;
        const realArc = proto.arc;
        const realLineTo = proto.lineTo;
        let texts = [], arcs = 0, lines = 0;
        proto.fillText = function (t) { texts.push(String(t)); return realFill.apply(this, arguments); };
        proto.arc = function () { arcs++; return realArc.apply(this, arguments); };
        proto.lineTo = function () { lines++; return realLineTo.apply(this, arguments); };
        const box = Array.from(document.querySelectorAll('#ovSettings details'))
            .find(d => /User Appearance/.test(d.querySelector('summary').textContent))
            .querySelector('[data-ov="showLabels"]');
        // Sample the repaint the CLICK causes: the preview is debounced off
        // `onChange`, so counting without flipping anything counts an idle modal.
        const flip = async () => {
            texts = []; arcs = 0; lines = 0;
            box.click();
            await new Promise(r => setTimeout(r, 1200));
            return { texts: texts.slice(), arcs, lines };
        };
        if (!box.checked) { box.click(); await new Promise(r => setTimeout(r, 600)); }
        const off = await flip();                        // ON  -> OFF
        const on = await flip();                         // OFF -> ON
        const again = await flip();                      // ON  -> OFF again
        box.click();                                     // leave it ON
        await new Promise(r => setTimeout(r, 600));
        proto.fillText = realFill; proto.arc = realArc; proto.lineTo = realLineTo;
        const nodeNames = s => s.texts.filter(t => t === 'zorblax' || t === 'quibnar').length;
        return {
            on: nodeNames(on), off: nodeNames(off), again: nodeNames(again),
            marksOn: on.arcs, marksOff: off.arcs,
            edgesOn: on.lines, edgesOff: off.lines,
        };
    });
    check(painted.on > 0,
        `with the toggle ON the preview paints node names (got ${painted.on})`);
    check(painted.off === 0,
        `with it OFF not one node name is painted (got ${painted.off})`);
    check(painted.again === 0,
        `and turning it off again removes them again (got ${painted.again})`);
    // The toggle removes the LABEL and nothing else — the skeleton stays.
    check(painted.marksOff > 0 && painted.marksOff === painted.marksOn,
        `node markers are untouched (${painted.marksOn} on vs ${painted.marksOff} off)`);
    check(painted.edgesOff > 0 && painted.edgesOff === painted.edgesOn,
        `edges are untouched (${painted.edgesOn} on vs ${painted.edgesOff} off)`);

    // ---- it is remembered, like every other appearance setting --------------
    const persisted = await page.evaluate(async () => {
        const box = Array.from(document.querySelectorAll('#ovSettings details'))
            .find(d => /User Appearance/.test(d.querySelector('summary').textContent))
            .querySelector('[data-ov="showLabels"]');
        box.click();                                     // OFF
        await new Promise(r => setTimeout(r, 300));
        return JSON.parse(localStorage.getItem('overlayExportSettings.v1') || '{}').user.showLabels;
    });
    check(persisted === false, `turning it off is written to storage (got ${persisted})`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await openModal();
    const reopened = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#ovSettings details'))
            .find(d => /User Appearance/.test(d.querySelector('summary').textContent))
            .querySelector('[data-ov="showLabels"]').checked);
    check(reopened === false, 'and it comes back off after a close/reopen');

    // ---- an older build's blob upgrades without surprises -------------------
    // `labelSize: 0` was the off switch then, and such a blob carries no
    // `showLabels`. Left alone, the new default would resurrect the labels the
    // user had turned off — and the toggle would be DEAD, since 0px draws
    // nothing. The fold must give back BOTH halves: off, and a usable size.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const upgraded = await page.evaluate(async () => {
        localStorage.setItem('overlayExportSettings.v1', JSON.stringify({
            user: { labelSize: 0, labelAlpha: 0.9, nodeSize: 4 },
            reproj: { labelSize: 0 },
        }));
        const M = await import('/ui/overlay-export-modal.js');
        const s = M.loadOverlayExportSettings();
        return {
            show: s.user.showLabels, size: s.user.labelSize,
            repShow: s.reproj.showLabels, repSize: s.reproj.labelSize,
        };
    });
    check(upgraded.show === false,
        `an old labelSize-of-0 still means labels OFF (got ${upgraded.show})`);
    check(upgraded.size > 0,
        `…at a size the toggle can turn back on (got ${upgraded.size})`);
    check(upgraded.repShow === false && upgraded.repSize > 0,
        `the reprojection half folds the same way (${upgraded.repShow} / ${upgraded.repSize})`);

    check(errs.length === 0, `no page errors (${errs.slice(0, 3).join(' | ')})`);
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} check(s)`);
process.exit(fails === 0 ? 0 : 1);
