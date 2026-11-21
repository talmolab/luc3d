/**
 * save-target-handle.mjs — File ▸ Save writes to the OPEN project's file, never
 * to one a replaced project was opened from.
 *
 * `state.slpFileHandle` is the file File ▸ Save writes over without asking. It
 * used to be set by the File menu before a load started and cleared by nothing
 * but Save As, so:
 *   - after New Project (or closing the last session), building a project from
 *     a folder and pressing Ctrl+S overwrote the previous project's .slp;
 *   - a load cancelled at its first prompt left the open project pointed at the
 *     file it did NOT open, and the next Save wrote it there;
 *   - Load SLP on an analysis .h5 made Save write .slp bytes over the .h5.
 * Now the loader adopts the handle only once it replaces the open project, and
 * New Project / closing the last session forget it.
 *
 *   1. New Project forgets the file.
 *   2. Load SLP adopts the picked .slp's handle.
 *   3. A Load Project cancelled at its first prompt keeps the open project's file.
 *   4. Closing the last session forgets the file.
 *   5. Load SLP on a non-.slp file leaves no handle (Save will ask).
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(repoRoot, 'tests', 'fixtures', 'slp-compound', 'sleap-compound-small.slp');
const server = await startServer(repoRoot);
const PORT = server.port;
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const browser = await launchBrowser();

const handleName = (page) => page.evaluate(() => {
    const h = window.__lucid.state.slpFileHandle;
    return h ? h.name : null;
});

// Stub showOpenFilePicker to hand back `name` (bytes from the fixture), as a
// handle whose identity the checks can recognise.
async function stubPicker(page, name) {
    await page.evaluate(({ name }) => {
        const file = new File([window.__fixtureBytes], name);
        window.showOpenFilePicker = async () => [{ kind: 'file', name, __stub: true, getFile: async () => file }];
    }, { name });
}

// Load SLP through the File menu, then close the videos prompt (Esc: no videos).
async function loadSlpViaMenu(page, name) {
    await stubPicker(page, name);
    await page.evaluate(() => document.getElementById('menuLoadSlp').click());
    await page.waitForSelector('#videoSelectOverlay', { timeout: 30000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('videoSelectOverlay'), null, { timeout: 10000 });
}

try {
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    const bytes = fs.readFileSync(FIXTURE).toString('base64');
    await page.evaluate((b64) => {
        window.__fixtureBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        window.confirm = () => true;
    }, bytes);

    console.log('1. New Project forgets the file');
    {
        await page.evaluate(async () => {
            window.__lucid.state.slpFileHandle = { kind: 'file', name: 'old-project.slp' };
            (await import('./import-export/save-load.js')).newProject(true);
        });
        check(await handleName(page) === null, 'no handle after New Project');
    }

    console.log('\n2. Load SLP adopts the picked .slp');
    {
        await loadSlpViaMenu(page, 'picked.slp');
        const r = await page.evaluate(() => {
            const s = window.__lucid.state;
            return { sessions: s.sessions.length, name: s.slpFileHandle && s.slpFileHandle.name, stub: !!(s.slpFileHandle && s.slpFileHandle.__stub) };
        });
        check(r.sessions > 0, 'the .slp opened (' + r.sessions + ' sessions)');
        check(r.name === 'picked.slp' && r.stub, 'Save writes to the picked file (' + r.name + ')');
    }

    console.log('\n3. A cancelled Load Project keeps the open project\'s file');
    {
        await stubPicker(page, 'other.slp');
        // The first prompt of a load: discard the imported 3D points? → Cancel.
        await page.evaluate(() => { window.__lucid.state.has3dImportWithoutSession = true; });
        await page.evaluate(() => document.getElementById('menuLoadProject').click());
        await page.getByRole('button', { name: 'Cancel' }).click();
        await page.waitForFunction(() => /Load cancelled/.test(document.getElementById('statusText').textContent),
            null, { timeout: 10000 });
        await page.evaluate(() => { window.__lucid.state.has3dImportWithoutSession = false; });
        check(await handleName(page) === 'picked.slp', 'still picked.slp, not the file it did not open (' + await handleName(page) + ')');
    }

    console.log('\n4. Closing the last session forgets the file');
    {
        const r = await page.evaluate(async () => {
            const sp = await import('./ui/sessions-panes.js');
            const s = window.__lucid.state;
            while (s.sessions.length) sp.removeSession(s.sessions.length - 1);
            return { sessions: s.sessions.length, name: s.slpFileHandle ? s.slpFileHandle.name : null };
        });
        check(r.sessions === 0 && r.name === null, 'no sessions, no handle (' + JSON.stringify(r) + ')');
    }

    console.log('\n5. Load SLP on a non-.slp file leaves no handle');
    {
        await page.evaluate(() => { window.__lucid.state.slpFileHandle = { kind: 'file', name: 'stale.slp' }; });
        // An .h5 name on .slp bytes: the loader reads it the same, but Save must
        // never write .slp bytes over an .h5.
        await loadSlpViaMenu(page, 'analysis.h5');
        const r = await page.evaluate(() => ({ sessions: window.__lucid.state.sessions.length,
            name: window.__lucid.state.slpFileHandle ? window.__lucid.state.slpFileHandle.name : null }));
        check(r.sessions > 0, 'the file opened (' + r.sessions + ' sessions)');
        check(r.name === null, 'no handle: Save will ask where to write (' + r.name + ')');
    }
} catch (e) {
    console.log('  ✗ threw:', e && e.stack || e);
    fails++;
} finally {
    await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS save-target-handle' : `\nFAIL save-target-handle (${fails})`);
process.exit(fails === 0 ? 0 : 1);
