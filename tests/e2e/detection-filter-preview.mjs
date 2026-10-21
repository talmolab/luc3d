/**
 * detection-filter-preview.mjs — Settings ▸ Tracking Wizard says what share of
 * the loaded detections the detection filters would remove, per camera, and
 * updates as the values are typed (ui/detection-filter-preview.js).
 *
 * Asserted, in the real modal over a synthetic two-camera session whose "side"
 * camera scores lower than "top" (the low-side-camera case that motivated it):
 *  1. The readout sits right under the two filter fields, and the walk does not
 *     start until the wizard is shown.
 *  2. At the defaults (0, 0) nothing is removed.
 *  3. Typing a minimum instance score updates the per-camera and total shares
 *     live, before Apply; "Fail both" counts detections failing both filters.
 *  4. Switching a camera off greys its row and drops it from the total.
 *  4b. A camera losing far more than the others is flagged — row tag and a
 *     sentence naming it — and the flag goes when it no longer applies.
 *  5. The mean-point-confidence preview shows per-camera medians and the share
 *     below its own (non-persisted) threshold.
 *  6. Cancel stores nothing; the filters keep their old values.
 *  7. Missing instance scores and point scores are SAID, not shown as 0%.
 *  8. An empty session and no session each get a sentence, not a table.
 *
 * Run: node tests/e2e/detection-filter-preview.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8297);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // A session: per frame, 'top' has two good predictions (score 0.9, all 4
    // points, confidence 0.9); 'side' has one good one and one low one (score
    // 0.4, confidence 0.6), and every 4th frame side's low one has only 2 points.
    // `scores: false` builds the same session with every score 0 and no point
    // scores; `frames: 0` an empty one.
    const build = (opts) => page.evaluate(async (o) => {
        const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
        const S = await import('/ui/settings.js');
        S.setTrackingThresholds({ filterMinVisibleNodes: 0, filterMinInstanceScore: 0 });
        S.setCameraWeights({ top: 1, side: 1 });
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = ['top', 'side'].map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
        const s = new pd.Session(cams, new pd.Skeleton('m', ['a', 'b', 'c', 'd'], []), [], 'S');
        const pts = (n) => [[1, 1], [2, 2], [3, 3], [4, 4]].map((p, k) => (k < n ? p : null));
        const mk = (n, score, conf) => {
            const inst = new pd.Instance(pts(n), 0, 'predicted', o.scores ? score : 0);
            if (o.scores) inst.setPointScores([conf, conf, conf, conf]);
            return inst;
        };
        for (let f = 0; f < o.frames; f++) {
            const fg = new pd.FrameGroup(f);
            fg.addUnlinkedInstance('top', new pd.UnlinkedInstance(mk(4, 0.9, 0.9), 'top'));
            fg.addUnlinkedInstance('top', new pd.UnlinkedInstance(mk(4, 0.9, 0.9), 'top'));
            fg.addUnlinkedInstance('side', new pd.UnlinkedInstance(mk(4, 0.9, 0.9), 'side'));
            fg.addUnlinkedInstance('side', new pd.UnlinkedInstance(mk(f % 4 === 0 ? 2 : 4, 0.4, 0.6), 'side'));
            s.frameGroups.set(f, fg);
        }
        AS.state.sessions = o.none ? [] : [s]; AS.state.session = o.none ? null : s; AS.state.activeSessionIdx = 0;
    }, Object.assign({ scores: true, frames: 400, none: false }, opts));

    const openSettings = () => page.evaluate(() => document.getElementById('menuSettings').click());
    const openWizard = () => page.evaluate(() => document.querySelector('.settings-nav-item[data-panel="wizard"]').click());
    const waitCounted = () => page.waitForFunction(() => {
        const r = document.querySelector('[data-testid="detection-filter-preview"]');
        return r && !/Counting detections/.test(r.textContent);
    }, { timeout: 10000 });
    const rows = () => page.evaluate(() => {
        const root = document.querySelector('[data-testid="detection-filter-preview"]');
        const t = root.querySelector('.dfp-filters');
        if (!t) return null;
        return Array.from(t.querySelectorAll('tbody tr')).map(tr => ({
            cam: tr.getAttribute('data-camera'), excluded: tr.classList.contains('dfp-excluded'),
            cells: Array.from(tr.children).map(td => td.textContent.trim()),
        }));
    });
    const type = (label, value) => page.evaluate(([l, v]) => {
        const i = document.querySelector(`.settings-num-input[aria-label="${l}"]`);
        i.value = String(v); i.dispatchEvent(new Event('input', { bubbles: true }));
    }, [label, value]);

    // ---- 1. placement, lazy start ----
    await build({});
    await openSettings();
    const before = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="detection-filter-preview"]');
        const prev = r && r.previousElementSibling;
        const prev2 = prev && prev.previousElementSibling;
        return {
            present: !!r,
            counting: r ? /Counting detections/.test(r.textContent) : false,
            afterScore: !!prev && !!prev.querySelector('.settings-num-input[aria-label="Min instance score (filter)"]'),
            afterVis: !!prev2 && !!prev2.querySelector('.settings-num-input[aria-label="Min visible nodes (filter)"]'),
        };
    });
    check(before.present && before.afterScore && before.afterVis, 'the readout sits right under the two filter fields');
    await new Promise(r => setTimeout(r, 300));
    check(await page.evaluate(() => /Counting detections/.test(document.querySelector('[data-testid="detection-filter-preview"]').textContent)),
        'nothing is counted while another panel is showing');
    await openWizard();
    await waitCounted();

    // ---- 2. defaults ----
    let r = await rows();
    check(r && r.length === 3 && r[0].cam === 'top' && r[1].cam === 'side' && r[2].cells[0] === 'All tracked cameras',
        'one row per camera and a total');
    check(r[0].cells[1] === '800' && r[1].cells[1] === '800' && r[2].cells[1] === '1,600', `detections per camera (${r.map(x => x.cells[1]).join(' / ')})`);
    check(r.every(x => x.cells[4].startsWith('0%')), 'at 0 / 0 nothing is removed');

    // ---- 3. live update ----
    await type('Min instance score (filter)', 0.5);
    r = await rows();
    check(r[0].cells[3].startsWith('0%') && r[1].cells[3] === '50.0% (400)' && r[2].cells[3] === '25.0% (400)',
        `a minimum score of 0.5 removes half of side, none of top (${r.map(x => x.cells[3]).join(' / ')})`);
    await type('Min visible nodes (filter)', 3);
    r = await rows();
    check(r[1].cells[2] === '12.5% (100)' && r[1].cells[4] === '50.0% (400)' && r[1].cells[5] === '12.5% (100)',
        `side: too few nodes 12.5%, removed 50%, fail both 12.5% (${r[1].cells.join(' | ')})`);
    check(r[2].cells[4] === '25.0% (400)', 'total removed follows');
    const flag = () => page.evaluate(() => {
        const root = document.querySelector('[data-testid="detection-filter-preview"]');
        const t = root.querySelector('.dfp-filters');
        const n = Array.from(root.querySelectorAll('.dfp-outlier-note')).map(e => e.textContent);
        return { rows: Array.from(t.querySelectorAll('tr.dfp-flagged')).map(tr => tr.getAttribute('data-camera')),
            tags: Array.from(t.querySelectorAll('.dfp-tag-warn')).map(e => e.textContent), note: n[0] || '' };
    });
    let fl = await flag();
    check(fl.rows.join() === 'side' && fl.tags.includes('loses far more'), `the camera losing far more is flagged (${fl.rows.join()})`);
    check(/^side loses 50\.0% of its detections, against 0% for the other cameras \(median\)\. The total \(25\.0%\) hides this\.$/.test(fl.note),
        `and named in a sentence: "${fl.note}"`);
    const stored = await page.evaluate(async () => (await import('/ui/settings.js')).getTrackingThreshold('filterMinInstanceScore'));
    check(stored === 0, 'the readout moves before Apply; nothing is stored yet');

    // ---- 4. a camera switched off ----
    await page.evaluate(() => document.querySelector('.settings-toggle input[aria-label="Include view side in tracking"]').click());
    r = await rows();
    check(r[1].excluded && /excluded/.test(r[1].cells[0]), 'an excluded camera is greyed and tagged');
    fl = await flag();
    check(fl.rows.length === 0 && !fl.note, 'an excluded camera is not flagged');
    check(r[2].cells[1] === '800' && r[2].cells[4].startsWith('0%'), `it leaves the total (${r[2].cells.join(' | ')})`);
    await page.evaluate(() => document.querySelector('.settings-toggle input[aria-label="Include view side in tracking"]').click());

    // ---- 5. mean point confidence preview ----
    const mps = await page.evaluate(() => {
        const t = document.querySelector('[data-testid="detection-filter-preview"] .dfp-mps-table');
        const read = () => Array.from(t.querySelectorAll('tbody tr')).map(tr => Array.from(tr.children).map(td => td.textContent.trim()));
        return { rows: read(), bars: t.querySelectorAll('.dfp-bar').length, below: t.querySelectorAll('.dfp-bar-below').length };
    });
    check(mps.rows.length === 2 && mps.rows[0][1] === '0.90' && mps.rows[1][1] === '0.75', `medians per camera (${mps.rows.map(x => x[1]).join(' / ')})`);
    check(mps.rows[1][3] === '50.0% (400)' && mps.rows[0][3] === '0%', `share below 0.75: side 50%, top 0% (${mps.rows.map(x => x[3]).join(' / ')})`);
    check(mps.bars === 20 && mps.below > 0, 'a ten-bar distribution per camera, bars under the threshold marked');
    const mpsFlag = await page.evaluate(() => {
        const sec = document.querySelector('[data-testid="detection-filter-preview"] .dfp-mps');
        return { rows: Array.from(sec.querySelectorAll('tr.dfp-flagged')).map(tr => tr.getAttribute('data-camera')),
            note: (sec.querySelector('.dfp-outlier-note') || {}).textContent || '' };
    });
    check(mpsFlag.rows.join() === 'side' && /^side has 50\.0% below 0\.75, against 0% for the other cameras \(median\)\.$/.test(mpsFlag.note),
        `the confidence preview flags it too: "${mpsFlag.note}"`);
    await type('Preview mean point confidence threshold', 0.95);
    const mps2 = await page.evaluate(() => Array.from(document.querySelectorAll('.dfp-mps-table tbody tr')).map(tr => tr.lastChild.textContent.trim()));
    check(mps2[0] === '100% (800)' && mps2[1] === '100% (800)', `the preview threshold updates its column (${mps2.join(' / ')})`);

    // Back to 0 / 0: nothing removed, nothing flagged.
    await type('Min instance score (filter)', 0); await type('Min visible nodes (filter)', 0);
    fl = await flag();
    check(fl.rows.length === 0 && !fl.note, 'at 0 / 0 nothing is flagged');

    // ---- 6. Cancel ----
    await page.click('.settings-btn-cancel');
    const after = await page.evaluate(async () => { const S = await import('/ui/settings.js');
        return [S.getTrackingThreshold('filterMinVisibleNodes'), S.getTrackingThreshold('filterMinInstanceScore')]; });
    check(after[0] === 0 && after[1] === 0, 'Cancel stores nothing');

    // ---- 7. missing scores ----
    await build({ scores: false });
    await openSettings(); await openWizard(); await waitCounted();
    const miss = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="detection-filter-preview"]');
        return {
            text: root.textContent,
            tags: Array.from(root.querySelectorAll('.dfp-tag-warn')).map(e => e.textContent),
            mpsTable: !!root.querySelector('.dfp-mps-table'),
        };
    });
    check(/no instance scores/.test(miss.text) && miss.tags.filter(t => t === 'no scores').length === 2,
        'missing instance scores are said, overall and per camera');
    check(/no per-point confidence/.test(miss.text) && !miss.mpsTable, 'missing point scores are said instead of a table');
    await type('Min instance score (filter)', 0.5);
    r = await rows();
    check(r[2].cells[3] === '100% (1,600)' && r[1].cells[3] === '100% (800)no scores' && /removes every predicted detection/.test(await page.evaluate(() =>
        document.querySelector('[data-testid="detection-filter-preview"]').textContent)),
        'and a minimum above 0 is shown removing every prediction, as tracking would');
    await page.click('.settings-btn-cancel');

    // ---- 8. empty / no session ----
    await build({ frames: 0 });
    await openSettings(); await openWizard(); await waitCounted();
    const empty = await page.evaluate(() => { const r = document.querySelector('[data-testid="detection-filter-preview"]');
        return { text: r.textContent, table: !!r.querySelector('table') }; });
    check(/no detections/.test(empty.text) && !empty.table, 'an empty session gets a sentence, no table');
    await page.click('.settings-btn-cancel');

    await build({ none: true });
    await openSettings(); await openWizard();
    const none = await page.evaluate(() => document.querySelector('[data-testid="detection-filter-preview"]').textContent);
    check(/Load a session/.test(none), 'no session: asks for one');
    await page.click('.settings-btn-cancel');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) {
    console.error(e); fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\nFAIL — ${fails} check(s)` : '\nPASS');
process.exit(fails ? 1 : 0);
