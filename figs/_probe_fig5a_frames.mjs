/**
 * Investigation tool, not a figure source: sweep the trimmed 8-camera session and
 * record each animal's all-views mean reprojection error per frame, to find frames
 * where NO animal's solve is contaminated (fig5a review 2026-08: the staged frame
 * 150 shows animal 2's detector locked onto its reflection in the glass partition,
 * ~12 px mean, tail keypoints drawn on the wall — find frames where that lock-on
 * is absent instead of hand-picking by eye).
 *
 * Usage: node figs/_probe_fig5a_frames.mjs   (env: PORT, NANIMALS, STEP)
 * Writes figs/out/_probe_fig5a_frames.json
 */
import fs from 'node:fs';
import {
    launch, loadSession, gotoFrame, trackAll, triangulateAll, reprojErrors,
    done, log, CAMS,
} from './_drive.mjs';

const NANIMALS = Number(process.env.NANIMALS || 3);
const STEP = Number(process.env.STEP || 5);

const ctx = await launch({ port: Number(process.env.PORT || 8093), width: 1600, height: 900, scale: 1 });
const { page } = ctx;
try {
    await loadSession(page, { cams: CAMS });
    await trackAll(page, NANIMALS);
    await triangulateAll(page);
    const nFrames = await page.evaluate(() => window.__lucid.state.totalFrames || 300);
    const sweep = [];
    for (let f = 0; f < nFrames; f += STEP) {
        await gotoFrame(page, f);
        const errs = await reprojErrors(page);
        const means = (errs || []).map(r => Number(r.meanError));
        sweep.push({ frame: f, means, max: means.length ? Math.max(...means) : null });
        if (f % 50 === 0) log(`[probe] frame ${f}: ${means.map(m => m?.toFixed?.(2)).join(' ')}`);
    }
    fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
    fs.writeFileSync(new URL('./out/_probe_fig5a_frames.json', import.meta.url),
        JSON.stringify({ nAnimals: NANIMALS, step: STEP, sweep }, null, 1));
    const ranked = sweep.filter(s => s.means.length === NANIMALS && s.max != null)
        .sort((a, b) => a.max - b.max).slice(0, 12);
    log('[probe] best frames by max animal mean error:');
    for (const r of ranked) log(`  f${r.frame}  max=${r.max.toFixed(2)}  [${r.means.map(m => m.toFixed(2)).join(', ')}]`);
} finally {
    await done(ctx);
}
