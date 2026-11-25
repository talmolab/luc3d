/**
 * training-crop-preview.mjs — a model's crop size and crop preview in the Models modal (Training ▸ Edit models…;
 * sleap-app AnchorPartField, `cropWarnings.ts`; sizes from pose/training-crop-size.js), on the shared two-view
 * session (cam1, cam2, 320x240, user instances A=(11+f, 22) B=(33+f, 44) on frames 0-5):
 *   1. Top-Down: "Crop Size 112 px (Auto)" (100 px floor + 56 px padding for ±180° / scale 1.1, stride 16), each
 *      Anchor Part node with its visibility (100%);
 *   2. the eye draws a dashed orange square around each animal in every view (pixels on the overlay canvas),
 *      centred on the centre of mass (Auto) or the anchor node, 112 video px wide; off again clears it;
 *   3. Full Configuration ▸ Centered Instance: "Auto: 112 px from your labels."; Crop Size 64 -> "64 px" and
 *      sleap-app's "only 64px after input scaling" warning in the modal and the dialog; 16 -> also "clipped";
 *   4. two models (One per view): each its own crop, and the preview draws on the shown model's views only;
 *      closing the modal drops the preview at once; Bottom-Up hides the row and drops the preview.
 * Usage: node tests/e2e/training-crop-preview.mjs   (PORT= to move its server; SHOT=file.png screenshots the preview)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTrainingSession } from './fixtures/training-session.js';
import { openModels } from './fixtures/training-models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9398);
const BASE = `http://localhost:${PORT}`;

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 900)));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
let browser;
try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', (e) => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('dialog', (d) => d.accept());
    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    await page.waitForSelector('.panel-rail-btn[data-tab="tabTraining"]', { state: 'attached' });
    await page.evaluate(async () => { (await import('./ui/training-panel.js')).showTrainingPanel(); });
    await loadTrainingSession(page);
    await openModels(page);
    await page.selectOption('#trnModelType', 'top_down');
    await page.waitForFunction(() => document.getElementById('trnCrop') && !document.getElementById('trnCrop').hidden);

    /** The panel's crop line, the eye, the preview and each view's orange pixels (redrawn first unless `noRedraw`). */
    const S = (noRedraw) => page.evaluate(async (noRedraw) => {
        const P = await import('./ui/anchor-crop-preview.js');
        const AS = (await import('./ui/app-state.js')).state;
        if (!noRedraw) (await import('./ui/rendering.js')).drawAllOverlays(AS.currentFrame);
        else await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const out = { text: document.querySelector('#trnCrop .trn-crop-size').textContent, rowHidden: document.getElementById('trnCrop').hidden,
            eye: document.getElementById('trnCropPreview').getAttribute('aria-pressed'), preview: P.anchorCropPreview() && P.anchorCropPreview().byView,
            warnings: Array.from(document.querySelectorAll('#trnCropWarnings p')).map((p) => p.textContent), views: {} };
        for (const v of AS.views) {
            const fg = AS.session.frameGroups.get(AS.currentFrame);
            const c = v.overlayCanvas, ctx = c.getContext('2d');
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            let orange = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && Math.abs(d[i] - 249) < 12 && Math.abs(d[i + 1] - 115) < 14 && Math.abs(d[i + 2] - 22) < 14) orange++;
            out.views[v.name] = { orange, squares: P.previewSquares(v, fg, AS.session) };
        }
        return out;
    }, !!noRedraw);

    console.log('\n1. Crop Size and Anchor Part');
    const s1 = await S();
    check(s1.text === '112 px (Auto)' && !s1.rowHidden, 'Top-Down: Crop Size 112 px (Auto)', s1);
    const opts = await page.$$eval('#trnAnchor option', (os) => os.map((o) => o.value + '=' + o.textContent));
    check(opts.join() === '=Auto,A=A (100%),B=B (100%)', 'Anchor Part: Auto, then each node with its visibility', opts);
    check(s1.eye === 'false' && s1.preview === null && s1.views.cam1.orange === 0, 'preview off: nothing drawn', s1.views);

    console.log('\n2. The preview');
    await page.click('#trnCropPreview');
    const s2 = await S();
    const sq = s2.views.cam1.squares[0] || {};
    check(s2.eye === 'true' && s2.preview && s2.preview.cam1.cropSize === 112 && s2.preview.cam2.cropSize === 112, 'eye on: both views get the 112 px crop', s2.preview);
    check(s2.views.cam1.squares.length === 1 && sq.x === 22 && sq.y === 33 && sq.side === 112, 'Auto: centred on the centre of mass (22, 33), 112 px', s2.views.cam1.squares);
    check(s2.views.cam1.orange > 100 && s2.views.cam2.orange > 100, 'dashed orange squares drawn on both views', { cam1: s2.views.cam1.orange, cam2: s2.views.cam2.orange });
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
    await page.selectOption('#trnAnchor', 'B');
    const s2b = await S();
    const sqb = s2b.views.cam1.squares[0] || {};
    check(sqb.x === 33 && sqb.y === 44 && s2b.text === '112 px (Auto)', 'anchor B: centred on B (33, 44)', s2b.views.cam1.squares);
    const f7 = await page.evaluate(async () => {
        const P = await import('./ui/anchor-crop-preview.js');
        const AS = (await import('./ui/app-state.js')).state;
        const v = AS.views.find((x) => x.name === 'cam1'), fg = AS.session.frameGroups.get(7);
        return { both: P.previewSquares(v, fg, AS.session).length, noPred: P.previewSquares(v, fg, AS.session, { showUser: true, showPredicted: false }).length,
            noUser0: P.previewSquares(v, AS.session.frameGroups.get(0), AS.session, { showUser: false, showPredicted: true }).length };
    });
    check(f7.both === 1 && f7.noPred === 0 && f7.noUser0 === 0, 'squares only for the instances the view shows (Predictions / User off)', f7);
    await page.click('#trnCropPreview');
    const s2c = await S();
    check(s2c.eye === 'false' && s2c.preview === null && s2c.views.cam1.orange === 0 && s2c.views.cam2.orange === 0, 'eye off: the squares are gone', s2c.views);

    console.log('\n3. Full Configuration ▸ Crop Size');
    await page.click('#trnFullConfig');
    await page.waitForSelector('#trnConfigDialog');
    await page.click('#trnConfigDialog .tcd-tabs .trn-seg-btn:has-text("Centered Instance")');
    const field = '#trnConfigDialog .tcd-field[data-field="cropSize"] input';
    await page.waitForSelector(field);
    const note = () => page.$$eval('#tcdCropNote p', (ps) => ps.map((p) => p.textContent));
    check((await note()).join() === 'Auto: 112 px from your labels.', 'dialog: "Auto: 112 px from your labels."', await note());
    await page.fill(field, '64');
    await page.dispatchEvent(field, 'change');
    const n64 = await note();
    check(n64.length === 1 && /only 64px after input scaling/.test(n64[0]), 'Crop Size 64: sleap-app\'s "only 64px" warning in the dialog', n64);
    await page.fill(field, '16');
    await page.dispatchEvent(field, 'change');
    const n16 = await note();
    check(n16.length === 2 && /smaller than the largest labeled instance \(22px\)/.test(n16[1]), 'Crop Size 16: also "clipped"', n16);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#trnConfigDialog', { state: 'detached' });
    const s3 = await S();
    check(s3.text === '16 px' && s3.warnings.length === 2, 'modal: "16 px" and both warnings', s3);
    await page.click('#trnFullConfig');
    await page.click('#trnConfigDialog .tcd-tabs .trn-seg-btn:has-text("Centered Instance")');
    await page.fill(field, '');
    await page.dispatchEvent(field, 'change');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#trnConfigDialog', { state: 'detached' });
    const s3b = await S();
    check(s3b.text === '112 px (Auto)' && s3b.warnings.length === 0, 'Crop Size empty again: Auto, no warning', s3b);

    console.log('\n4. Two models, closing the modal, Bottom-Up');
    await page.click('#trnMmSplitEach');
    await page.waitForFunction(() => document.querySelectorAll('#trnMmModels .trn-mm-card').length === 2);
    // A split makes new models (the ★ type): both go Top-Down; cam2's is shown last.
    await page.selectOption('#trnModelType', 'top_down');
    await page.click('#trnMmModels .trn-mm-card:nth-child(2) .trn-mm-name');
    await page.waitForFunction(() => document.getElementById('trnMmName').value === 'cam2');
    await page.selectOption('#trnModelType', 'top_down');
    await page.waitForFunction(() => document.getElementById('trnCrop') && !document.getElementById('trnCrop').hidden);
    await page.click('#trnCropPreview');
    const s4 = await S();
    check(s4.preview && Object.keys(s4.preview).join() === 'cam2' && s4.text === '112 px (Auto)' && s4.views.cam2.orange > 100 && s4.views.cam1.orange === 0,
        'the shown model (cam2): its own crop, drawn on its view only', { preview: s4.preview, cam1: s4.views.cam1.orange, cam2: s4.views.cam2.orange });
    await page.click('#trnMmModels .trn-mm-card:nth-child(1) .trn-mm-name');
    const s4a = await S();
    check(s4a.preview && Object.keys(s4a.preview).join() === 'cam1' && s4a.views.cam1.orange > 100 && s4a.views.cam2.orange === 0,
        'showing cam1\'s model moves the preview to cam1', { preview: s4a.preview, cam1: s4a.views.cam1.orange, cam2: s4a.views.cam2.orange });
    await page.click('#trnMmCancel');
    await page.waitForFunction(() => !document.getElementById('trnModelsModal'));
    const s4b = await page.evaluate(async () => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const P = await import('./ui/anchor-crop-preview.js');
        const AS = (await import('./ui/app-state.js')).state;
        const v = AS.views.find((x) => x.name === 'cam1');
        return { preview: P.anchorCropPreview(), squares: P.previewSquares(v, AS.session.frameGroups.get(AS.currentFrame), AS.session).length };
    });
    check(s4b.preview === null && s4b.squares === 0, 'modal closed: the preview is gone at once', s4b);
    const cards = await page.$$eval('#trnModelCards .trn-sum-card', (cs) => cs.length);
    check(cards === 1, 'Cancel kept the one model', cards);
    await openModels(page);
    await page.selectOption('#trnModelType', 'bottom_up');
    const s4d = await S();
    check(s4d.rowHidden && s4d.preview === null && s4d.views.cam1.orange === 0, 'Bottom-Up: no Crop Size row, preview dropped', s4d);
} catch (e) {
    console.log('  ✗ threw: ' + (e && e.stack || e));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
