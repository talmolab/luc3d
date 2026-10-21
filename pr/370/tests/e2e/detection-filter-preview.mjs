/**
 * detection-filter-preview.mjs — Settings ▸ Tracking Wizard says what share of
 * the loaded detections the detection filters would remove, per camera, and
 * updates as the values are typed (ui/detection-filter-preview.js).
 *
 * Asserted, in the real modal over a synthetic two-camera session whose "side"
 * camera scores lower than "top" (the low-side-camera case that motivated it):
 *  1. The readout sits right under the three filter fields, and the walk does
 *     not start until the wizard is shown.
 *  2. At the defaults (0, 0, 0) nothing is removed.
 *  3. Typing a minimum updates the per-camera and total shares live, before
 *     Apply; "Fail 2+" counts detections failing more than one filter.
 *  4. Switching a camera off greys its row and drops it from the total.
 *  4b. A camera losing far more than the others is flagged — per filter cell,
 *     row tag and a sentence naming it — and the flag goes when it no longer
 *     applies.
 *  5. The min mean node score is a real filter: it counts in "Removed", and the
 *     distributions of all three quantities mark the bars each filter removes.
 *  6. Cancel stores nothing; the filters keep their old values.
 *  7. Missing instance scores and node scores are SAID, not shown as 0%.
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
        S.setTrackingThresholds({ filterMinVisibleNodes: 0, filterMinInstanceScore: 0, filterMinMeanNodeScore: 0 });
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
        const prev3 = prev2 && prev2.previousElementSibling;
        const has = (e, l) => !!e && !!e.querySelector(`.settings-num-input[aria-label="${l}"]`);
        return {
            present: !!r,
            order: has(prev, 'Min mean node score (filter)') && has(prev2, 'Min instance score (filter)') && has(prev3, 'Min visible nodes (filter)'),
        };
    });
    check(before.present && before.order, 'the readout sits right under the three filter fields');
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
    check(r[0].cells.length === 7 && r.every(x => x.cells[5].startsWith('0%')), 'seven columns; at 0 / 0 / 0 nothing is removed');

    // ---- 3. live update ----
    await type('Min instance score (filter)', 0.5);
    r = await rows();
    check(r[0].cells[3].startsWith('0%') && r[1].cells[3] === '50.0% (400)' && r[2].cells[3] === '25.0% (400)',
        `a minimum score of 0.5 removes half of side, none of top (${r.map(x => x.cells[3]).join(' / ')})`);
    await type('Min visible nodes (filter)', 3);
    r = await rows();
    check(r[1].cells[2] === '12.5% (100)' && r[1].cells[5] === '50.0% (400)' && r[1].cells[6] === '12.5% (100)',
        `side: too few nodes 12.5%, removed 50%, fail 2+ 12.5% (${r[1].cells.join(' | ')})`);
    check(r[2].cells[5] === '25.0% (400)', 'total removed follows');
    const flag = () => page.evaluate(() => {
        const root = document.querySelector('[data-testid="detection-filter-preview"]');
        const t = root.querySelector('.dfp-filters');
        const n = Array.from(root.querySelectorAll('.dfp-outlier-note')).map(e => e.textContent);
        return { rows: Array.from(t.querySelectorAll('tr.dfp-flagged')).map(tr => tr.getAttribute('data-camera')),
            tags: Array.from(t.querySelectorAll('.dfp-tag-warn')).map(e => e.textContent), note: n[0] || '' };
    });
    let fl = await flag();
    check(fl.rows.join() === 'side' && fl.tags.includes('loses far more'), `the camera losing far more is flagged (${fl.rows.join()})`);
    const cellFlags = await page.evaluate(() => Array.from(document.querySelectorAll('.dfp-filters td.dfp-cell-flag'))
        .map(td => td.closest('tr').getAttribute('data-camera') + ':' + td.getAttribute('data-filter')).join());
    check(cellFlags === 'side:failVisible,side:failScore', `each filter's own column flags it too (${cellFlags})`);
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
    check(r[2].cells[1] === '800' && r[2].cells[5].startsWith('0%'), `it leaves the total (${r[2].cells.join(' | ')})`);
    await page.evaluate(() => document.querySelector('.settings-toggle input[aria-label="Include view side in tracking"]').click());

    // ---- 5. the mean node score filter, and the three distributions ----
    // side's weak detections score 0.6 per node (0.3 mean on the 2-node ones:
    // a missing node counts as 0), so 0.75 removes all 400 of them.
    await type('Min mean node score (filter)', 0.75);
    r = await rows();
    check(r[0].cells[4].startsWith('0%') && r[1].cells[4] === '50.0% (400)', `node score 0.75 removes side's weak half (${r[1].cells[4]})`);
    check(r[1].cells[5] === '50.0% (400)' && r[1].cells[6] === '50.0% (400)', `it counts in Removed and in Fail 2+ (${r[1].cells.join(' | ')})`);
    const dist = await page.evaluate(() => {
        const t = document.querySelector('[data-testid="detection-filter-preview"] .dfp-dist-table');
        const cell = (tr, k) => tr.querySelector(`td[data-hist="${k}"]`);
        return {
            heads: Array.from(t.querySelectorAll('th')).map(th => th.textContent),
            rows: Array.from(t.querySelectorAll('tbody tr')).map(tr => ['visible', 'score', 'nodeScore'].map(k => ({
                median: (cell(tr, k).querySelector('.dfp-median') || {}).textContent,
                bars: cell(tr, k).querySelectorAll('.dfp-bar').length,
                below: cell(tr, k).querySelectorAll('.dfp-bar-below').length,
            }))),
        };
    });
    check(dist.heads.join('|') === 'Camera|Visible nodes (0 → 4)|Instance score (0 → 1)|Mean node score (0 → 1)', `one chart per filter (${dist.heads.join(' | ')})`);
    const med = dist.rows.map(row => row.map(c => c.median).join('/')).join(' ; ');
    check(med === '4/0.90/0.90 ; 4/0.65/0.75', `medians per camera and quantity (${med})`);
    const shape = dist.rows.map(row => row.map(c => c.bars + ':' + c.below).join('/')).join(' ; ');
    check(shape === '5:3/10:5/10:7 ; 5:3/10:5/10:7', `the bars each filter removes are marked, in all three charts (${shape})`);

    // Back to 0 / 0: nothing removed, nothing flagged.
    await type('Min instance score (filter)', 0); await type('Min visible nodes (filter)', 0); await type('Min mean node score (filter)', 0);
    fl = await flag();
    const marked = await page.evaluate(() => document.querySelectorAll('.dfp-dist-table .dfp-bar-below').length);
    check(fl.rows.length === 0 && !fl.note && marked === 0, 'at 0 / 0 / 0 nothing is flagged and no bar is marked');

    // ---- 6. Cancel ----
    await page.click('.settings-btn-cancel');
    const after = await page.evaluate(async () => { const S = await import('/ui/settings.js');
        return [S.getTrackingThreshold('filterMinVisibleNodes'), S.getTrackingThreshold('filterMinInstanceScore'), S.getTrackingThreshold('filterMinMeanNodeScore')]; });
    check(after.every(v => v === 0), 'Cancel stores nothing');

    // ---- 7. missing scores ----
    await build({ scores: false });
    await openSettings(); await openWizard(); await waitCounted();
    const miss = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="detection-filter-preview"]');
        return {
            text: root.textContent,
            tags: Array.from(root.querySelectorAll('.dfp-tag-warn')).map(e => e.textContent),
            nodeCells: Array.from(root.querySelectorAll('.dfp-dist-table td[data-hist="nodeScore"]')).map(td => td.textContent),
        };
    });
    check(/no instance scores/.test(miss.text) && miss.tags.filter(t => t === 'no scores').length === 2,
        'missing instance scores are said, overall and per camera');
    check(/carry no node scores/.test(miss.text) && miss.tags.filter(t => t === 'no node scores').length === 2 &&
        miss.nodeCells.every(t => t === 'no node scores'), 'missing node scores are said: a note, a tag per camera, and in the chart');
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
