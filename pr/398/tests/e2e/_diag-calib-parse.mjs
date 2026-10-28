/**
 * _diag-calib-parse.mjs — run the APP's own calibration parser over a real
 * folder's two .toml files and print the camera geometry it produces.
 *
 * Diagnostic, not an assertion (hence `_diag-`, excluded from suite runs).
 * The point is to take the user's actual files through `parseCalibrationTOML`
 * + `Camera` rather than a stand-in, so a formatting difference between the
 * hand-written `calibration.toml` and the one `Set as New Calibration` writes
 * cannot hide behind a re-implementation.
 *
 * Usage: FOLDER=/path/to/session node _diag-calib-parse.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8279);
const FOLDER = process.env.FOLDER;
if (!FOLDER) { console.error('set FOLDER='); process.exit(2); }

const texts = {};
for (const f of ['calibration.toml', 'calibration-rebased.toml']) {
    const p = path.join(FOLDER, f);
    if (fs.existsSync(p)) texts[f] = fs.readFileSync(p, 'utf8');
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const out = await page.evaluate(async (texts) => {
        const FIO = await import('/import-export/file-io.js');
        const res = {};
        for (const [fname, text] of Object.entries(texts)) {
            let cams;
            try {
                cams = FIO.parseCalibrationTOML(text);
            } catch (e) {
                res[fname] = { error: String(e) };
                continue;
            }
            res[fname] = {
                n: cams.length,
                cams: cams.map(c => {
                    // centre = -R^T t, using whatever the Camera object exposes
                    const R = c.rotationMatrix, t = c.tvec;
                    const C = [0, 1, 2].map(i =>
                        -(R[0][i] * t[0] + R[1][i] * t[1] + R[2][i] * t[2]));
                    const axis = [R[2][0], R[2][1], R[2][2]];
                    return {
                        name: c.name,
                        size: c.size,
                        fy: c.matrix ? c.matrix[1][1] : null,
                        dist0: c.dist ? c.dist[0] : null,
                        centre: C.map(v => Math.round(v * 10) / 10),
                        axis: axis.map(v => Math.round(v * 1000) / 1000),
                    };
                }),
            };
        }
        return res;
    }, texts);

    for (const [fname, r] of Object.entries(out)) {
        console.log('='.repeat(84));
        console.log(fname, r.error ? 'PARSE ERROR: ' + r.error : `— ${r.n} cameras`);
        console.log('='.repeat(84));
        if (r.error) continue;
        for (const c of r.cams) {
            console.log(`  ${String(c.name).padEnd(7)} size=${JSON.stringify(c.size)} `
                + `fy=${c.fy} k1=${c.dist0}`);
            console.log(`  ${''.padEnd(7)} centre=(${c.centre.join(', ')})  axis=(${c.axis.join(', ')})`);
        }
        console.log();
    }
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}
