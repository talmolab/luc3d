/**
 * _diag-calib-notice-shot.mjs — render the multi-session calibration note and
 * save a PNG of it, so the copy and the layout can be LOOKED at.
 *
 * Investigation tool, not an assertion: `_diag-*` is excluded from suite runs.
 * The behaviour is pinned by `multi-session-calibration-notice.mjs`.
 *
 * Fixtures are the REAL calibrations from `tests/fixtures/multi-session-calib/`,
 * so the shot shows the modal a user of `small_multi_session` actually gets.
 *
 * Run: node _diag-calib-notice-shot.mjs [outDir]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const outDir = process.argv[2] || repoRoot;
const PORT = Number(process.env.PORT || 8291);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const fio = await import('/import-export/file-io.js');
        const AS = await import('/ui/app-state.js');
        const notice = await import('/ui/calibration-notice.js');
        window.__show = async (specs) => {
            const out = [];
            for (const spec of specs) {
                const toml = await (await fetch(
                    '/tests/fixtures/multi-session-calib/' + spec.calib)).text();
                const cams = fio.parseCalibrationTOML(toml).map(c => new pd.Camera(
                    c.name, c.matrix, c.dist, c.rvec, c.tvec, c.size));
                if (spec.refocus) {
                    const c = cams.find(x => x.name === spec.refocus);
                    c.matrix = [[900, 0, 639.5], [0, 900, 511.5], [0, 0, 1]];
                }
                out.push(new pd.Session(
                    cams, new pd.Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], spec.name));
            }
            AS.state.sessions = out;
            AS.state.session = out[0];
            AS.state.activeSessionIdx = 0;
            return !!notice.noteSessionCalibrationDivergence(out);
        };
    });

    const shots = [
        ['calib-notice-two-groups.png', [
            { name: '10072022120554_small', calib: 'calibration.toml' },
            { name: '10072022131531_small', calib: 'calibration.toml' },
            { name: '10072022145420_small', calib: 'calibration-rebased.toml' },
            { name: '10072022193448_small', calib: 'calibration.toml' },
        ]],
        // Three groups, to check the stack still reads when it is not just A and B.
        ['calib-notice-three-groups.png', [
            { name: 'sessionA', calib: 'calibration.toml' },
            { name: 'sessionB', calib: 'calibration.toml' },
            { name: 'sessionC', calib: 'calibration-rebased.toml' },
            // `refocus` names a camera to re-focus, rather than passing a
            // function: page.evaluate serializes its argument, so a closure
            // cannot cross into the page.
            { name: 'sessionD', calib: 'calibration.toml', refocus: 'mid' },
        ]],
    ];

    for (const [file, specs] of shots) {
        const shown = await page.evaluate(s => window.__show(s), specs);
        if (!shown) { console.log(file + ': no divergence reported — nothing to shoot'); continue; }
        const dest = path.join(outDir, file);
        await page.locator('.calib-notice-modal').screenshot({ path: dest });
        const box = await page.locator('.calib-notice-modal').boundingBox();
        console.log(`${file}  ${Math.round(box.width)}x${Math.round(box.height)}px`);
        await page.keyboard.press('Escape');
    }
} finally {
    if (browser) await browser.close();
    server.kill();
}
