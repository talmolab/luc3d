/**
 * Why is calibrat3 lower? Re-run ONLY the solver, on identical detections, one factor
 * at a time.
 *
 * The end-to-end comparison says calibrat3's calibrations reproject better. It does not
 * say why, and the cheapest sceptical explanation is that calibrat3 simply throws more
 * observations away: it rejects outliers in rounds down to a 1 px point-error threshold.
 * If that were the whole story the win would be a scoring artefact rather than a better
 * calibration -- so the configuration that matters most here is `no-rejection`, which
 * sets the final threshold to 0 and collapses the schedule to a single round that keeps
 * every point (ui/stage-extrinsics.js: `finalThr > 0 ? outlierSchedule(...) : [Infinity]`).
 *
 * Rejection CANNOT flatter the score directly -- the score is computed by aniposelib on
 * Anipose's detections, over every observation, and what calibrat3 rejects only changes
 * what it FITS. But rejection could still buy a better centre at the cost of a worse
 * tail, which is exactly what this ablation makes visible.
 *
 * The session is RESTORED from disk, so every configuration sees byte-identical corners
 * and only the solver changes. Intrinsics are recomputed from scratch first, because a
 * saved session carries SBA-refined intrinsics and starting from those would hand each
 * configuration the previous one's answer.
 *
 *   SESSION=<folder> SAVED=<session.json> OUT=<results.json> TOML_DIR=<dir> \
 *   [REF_CAM=Camera6] node ablation.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

await page.goto(`${BASE}/index.html`);
await page.waitForFunction(() => document.getElementById('workerStatus').classList.contains('ok'), null, { timeout: 180000 });
await page.setInputFiles('#folderInput', process.env.SESSION);
await page.waitForFunction(() => window.__calibrat3.state.views.length >= 2 && window.__calibrat3.state.totalFrames > 0, null, { timeout: 600000 });
await page.setInputFiles('#sessionInput', process.env.SAVED);
await page.waitForFunction(() => window.__calibrat3.state.detections && window.__calibrat3.state.detections.size > 0 && window.__calibrat3.state.intrinsics.filter(Boolean).length > 0, null, { timeout: 300000 });
const names = await page.evaluate(() => window.__calibrat3.state.views.map(v => v.name));
step(`restored: ${names.length} views, ${await page.evaluate(() => window.__calibrat3.state.detections.size)} frames of detections`);

// A saved session carries SBA-REFINED intrinsics. Every configuration must start from
// the same per-camera fit, or configuration k is silently initialised by configuration
// k-1 and the ablation measures the order it was run in.
await page.evaluate(() => { window.__calibrat3.state.intrinsics = []; document.getElementById('computeIntrinsicsBtn').click(); });
await page.waitForFunction((n) => window.__calibrat3.state.intrinsics.filter(Boolean).length === n && !document.getElementById('computeIntrinsicsBtn').disabled, names.length, { timeout: 1800000 });
step('intrinsics recomputed from the detections (stage-3 defaults)');

if (process.env.REF_CAM) {
    const idx = names.findIndex((n) => n === process.env.REF_CAM);
    if (idx < 0) throw new Error(`REF_CAM ${process.env.REF_CAM} not in ${names.join(', ')}`);
    await page.selectOption('#referenceCamera', String(idx));
    step(`reference camera ${names[idx]}`);
}

await page.evaluate(() => { window.__calibrat3.state.reproj = null; document.getElementById('computeExtrinsicsBtn').click(); });
await page.waitForFunction(() => window.__calibrat3.state.reproj !== null && !document.getElementById('computeExtrinsicsBtn').disabled, null, { timeout: 1800000 });
const initial = await page.evaluate(() => { const s = window.__calibrat3.state.reproj.summary; return { median: s.overall.median, mean: s.overall.mean, p95: s.overall.p95 }; });
step(`initial extrinsics (no bundle adjustment): median ${initial.median.toFixed(3)} px p95 ${initial.p95.toFixed(2)}`);

//: One factor at a time from the shipped default. `thr: 0` is the no-rejection arm.
const BASE_CFG = { iters: 100, loss: 'none', lossParam: 1.0, policy: 'aggressive', rounds: 6,
                   thr: 1, start: 0, maxPoints: 20000, intr: true, model: 'fxfy-c-k1-k2',
                   principal: 'centre', rigidity: 'anipose', plane: 0 };
const VARIANTS = [
    ['default', {}, 'the shipped configuration'],
    ['no-rejection', { thr: 0 }, 'one round, every point kept'],
    ['anipose-model', { model: 'f-k1' }, "aniposelib's intrinsics: one focal + k1, principal point pinned"],
    ['anipose-model-no-rejection', { model: 'f-k1', thr: 0 }, "aniposelib's intrinsics, no rejection"],
    ['intrinsics-fixed', { intr: false }, 'extrinsics and points only'],
    ['no-board-term', { rigidity: 'off' }, 'no rigid-board prior'],
];

const results = [];
for (const [tag, over, note] of VARIANTS) {
    const cfg = { ...BASE_CFG, ...over };
    await page.evaluate((c) => {
        const set = (id, v) => { const e = document.getElementById(id); if (!e) return; if (e.type === 'checkbox') e.checked = v; else e.value = String(v); };
        set('sbaMaxIterations', c.iters); set('sbaRobustLoss', c.loss); set('sbaLossParam', c.lossParam);
        set('sbaRejectPolicy', c.policy); set('sbaOutlierRounds', c.rounds); set('sbaOutlierThreshold', c.thr);
        set('sbaOutlierStart', c.start); set('sbaMaxPoints', c.maxPoints);
        set('sbaOptIntrinsics', c.intr); set('sbaOptExtrinsics', true); set('sbaOptPoints', true);
        set('sbaIntrModel', c.model); set('sbaPrincipal', c.principal);
        set('sbaBoardRigidity', c.rigidity); set('sbaCameraPlane', c.plane);
    }, cfg);
    await page.waitForSelector('#runSbaBtn:not([disabled])', { timeout: 120000 });
    const t = Date.now();
    await page.evaluate(() => document.getElementById('runSbaBtn').click());
    await page.waitForTimeout(1500);
    await page.waitForSelector('#runSbaBtn:not([disabled])', { timeout: 7200000 });
    const r = await page.evaluate(() => {
        const s = window.__calibrat3.state, o = s.reproj.summary.overall;
        return { median: o.median, mean: o.mean, p95: o.p95, applied: !!s.sbaResult,
                 rounds: s.sbaResult ? s.sbaResult.rounds.length : 0,
                 pointsTotal: s.sbaResult ? s.sbaResult.meta.pointsTotal : null,
                 pointsExcluded: s.sbaResult ? s.sbaResult.meta.pointsExcluded : null,
                 obsTotal: s.sbaResult ? s.sbaResult.meta.observationsTotal : null,
                 obsExcluded: s.sbaResult ? s.sbaResult.meta.observationsExcluded : null };
    });
    r.seconds = (Date.now() - t) / 1000;
    if (r.applied) {
        const toml = await page.evaluate(async () => (await import('./ui/stage-export.js')).buildToml());
        writeFileSync(`${process.env.TOML_DIR}/${tag}.toml`, toml);
    }
    results.push({ tag, note, cfg, initial, ...r });
    step(`${tag.padEnd(28)} in-app median ${r.median.toFixed(3)} p95 ${r.p95.toFixed(2)} | ` +
         `${r.rounds} round(s), fit dropped ${r.pointsExcluded}/${r.pointsTotal} points ` +
         `(${r.obsExcluded}/${r.obsTotal} obs) | ${r.seconds.toFixed(0)}s${r.applied ? '' : ' NOT APPLIED'}`);
    writeFileSync(process.env.OUT, JSON.stringify({ names, initial, results }, null, 1));
    // Revert so the next configuration starts from the same initial extrinsics.
    if (r.applied) {
        await page.evaluate(() => document.getElementById('revertSbaBtn').click());
        await page.waitForFunction(() => window.__calibrat3.state.sbaResult === null && !document.getElementById('extrinsicsProgress').classList.contains('active'), null, { timeout: 1800000 });
    }
}
await browser.close();
console.log('\nDONE');
