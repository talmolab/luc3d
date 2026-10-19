/**
 * _diag-project-slp-in-session-folder.mjs — does the per-camera (and therefore
 * multi-session) loader read a root-level `project.slp`?
 *
 * Investigation tool, not an assertion: `_diag-*` is excluded from suite runs.
 *
 * The file is JUNK BYTES named `project.slp`, so any attempt to read it shows
 * up as a parse error. Two runs, and the second is what makes the first mean
 * something:
 *
 *   A. `sess/project.slp`      — at the session root, where a real project sits
 *   B. `sess/cam0/project.slp` — positive control: a file the loader DOES look
 *      at, so if this run is also silent the probe is measuring nothing.
 *
 * No calibration in the stub, so the missing-camera-directory popup — which
 * awaits a click — never opens.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const repoRoot = new URL('../..', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8288);
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const browser = await chromium.launch();

async function run(where, relPaths) {
    console.log(`\n=== project.slp at ${where} ===`);
    console.log('   files handed to the loader: ' + relPaths.join(', '));
    const page = await browser.newPage();
    const logs = [];
    page.on('console', m => logs.push(m.type() + ': ' + m.text()));
    page.on('pageerror', e => logs.push('pageerror: ' + String(e)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const outcome = await page.evaluate(async (paths) => {
        const loader = await import('/loading/session-loader.js');
        const mk = (relPath) => {
            const f = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])],
                relPath.split('/').pop(), { type: 'application/octet-stream' });
            Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
            return f;
        };
        const files = paths.map(mk);
        // A camera dir holding an .slp but no video stops on the missing-video
        // popup, which awaits a click. Dismiss it after a beat so the loader
        // gets as far as actually OPENING the file — that is the control.
        const dismiss = setInterval(() => {
            const btns = Array.from(document.querySelectorAll('button'))
                .filter(b => b.textContent.trim() === 'Continue' && b.offsetParent);
            if (btns.length) btns[btns.length - 1].click();
        }, 500);
        const raced = await Promise.race([
            loader.handleLoadSessionFolderPerCamera(files, false).then(() => 'returned'),
            new Promise(r => setTimeout(() => r('still running (waiting on something)'), 15000)),
        ]).catch(e => 'threw: ' + (e && e.message));
        clearInterval(dismiss);
        return {
            raced,
            status: (document.getElementById('statusText')
                || document.getElementById('status') || {}).textContent || '',
            openModals: Array.from(document.querySelectorAll(
                '.multi-frame-modal-overlay, .plane-confirm-overlay, .modal-overlay'))
                .map(el => (el.querySelector('h3') || {}).textContent || el.className),
        };
    }, relPaths);

    console.log('   loader:', outcome.raced);
    console.log('   status:', outcome.status.slice(0, 130));
    if (outcome.openModals.length) console.log('   modals open:', JSON.stringify(outcome.openModals));
    const mentions = logs.filter(l => /project\.slp/i.test(l));
    const errors = logs.filter(l => /^(error|pageerror)/.test(l) && !/Failed to load resource|404/.test(l));
    console.log('   log lines naming project.slp: ' + mentions.length);
    mentions.forEach(l => console.log('      ' + l.slice(0, 150)));
    console.log('   error lines: ' + errors.length);
    errors.slice(0, 5).forEach(l => console.log('      ' + l.slice(0, 220)));
    await page.close();
}

try {
    await run('the SESSION ROOT', ['sess/project.slp', 'sess/cam0/placeholder.txt']);
    await run('a CAMERA DIR (control)', ['sess/cam0/project.slp']);
} finally {
    await browser.close();
    server.kill();
}
