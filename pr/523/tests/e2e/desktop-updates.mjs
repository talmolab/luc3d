/**
 * desktop-updates.mjs — the desktop shim's update flow (`src-tauri/js/lucid-desktop.js`
 * §8), against the real LUCID page with a mock `__TAURI_INTERNALS__` standing
 * in for the Rust commands (get_update_info, check_update, install_update,
 * set_update_channel, restart_app, message_dialog, ask_dialog).
 *
 *   1. Linux: Help ▸ Check for Updates… exists (last Help item); up to date →
 *      "luc3d 1.0.5 is up to date (stable channel)."; a build that cannot
 *      update says so and never calls check_update; a failed check shows the
 *      error.
 *   2. Available → "Install and restart?" with versions and channel →
 *      install_update {expectedVersion} with a progress card (downloaded /
 *      total, bar) → restart_app. Declining installs nothing.
 *   3. Unsaved work: refused before asking; refused if it appears while the
 *      question is open; installed but NOT restarted if it appears during the
 *      download.
 *   4. Auto-check: silent while up to date or failing; a newer version shows
 *      the notice once per version (Later dismisses, the next check does not
 *      bring it back, a newer version does); Install… leads to the question.
 *   5. macOS: no Help item (the native luc3d menu has it); __lucidUpdates.menu
 *      ('check') runs the check; 'channel:dev' sets the channel and checks
 *      with allowDowngrade; Windows has the Help item.
 *
 * Usage: node tests/e2e/desktop-updates.mjs [PORT]   (default 9721, or $PORT)
 *        BROWSER=webkit node tests/e2e/desktop-updates.mjs
 */
import * as playwright from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const SHIM = path.join(repoRoot, 'src-tauri', 'js', 'lucid-desktop.js');
const PORT = Number(process.argv[2] || process.env.PORT || 9721);
const BASE = `http://localhost:${PORT}`;
const BROWSER = process.env.BROWSER || 'chromium';

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 900)));
    if (!c) fails++;
};
const section = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Runs in the page before the shim.
function installMock(cfg) {
    const UA = {
        macos: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
        windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)',
    }[cfg.platform];
    const PLATFORM = { macos: 'MacIntel', windows: 'Win32', linux: 'Linux x86_64' }[cfg.platform];
    const def = (k, v) => Object.defineProperty(Navigator.prototype, k, { get: () => v, configurable: true });
    def('userAgent', UA);
    def('platform', PLATFORM);
    def('userAgentData', undefined);

    const calls = [];
    const info = Object.assign({
        currentVersion: '1.0.5', channel: 'stable', channels: ['stable', 'latest', 'dev'], updaterConfigured: true,
    }, cfg.info || {});
    let gateOpen;
    const mock = {
        calls, info,
        checks: (cfg.checks || []).slice(),   // queued check_update answers (null | update | {error})
        ask: cfg.ask === undefined ? true : cfg.ask,
        dirtyOnAsk: false, dirtyDuringInstall: false,
        restarted: 0,
        gate: new Promise(r => { gateOpen = r; }),
        release: () => gateOpen(),
        named: (n) => calls.filter(c => c.cmd === n),
    };
    class Channel { constructor() { this.onmessage = null; } toJSON() { return '__CHANNEL__:mock'; } }
    window.__TAURI_INTERNALS__ = {
        async invoke(cmd, args) {
            const name = String(cmd).replace('plugin:lucid|', '');
            calls.push({ cmd: name, args: JSON.parse(JSON.stringify(args === undefined ? null : args)) });
            switch (name) {
                case 'get_update_info': return JSON.parse(JSON.stringify(info));
                case 'check_update': {
                    const r = mock.checks.length ? mock.checks.shift() : null;
                    if (r && r.error) throw r.error;
                    return r ? Object.assign({ currentVersion: info.currentVersion, channel: info.channel, notes: null, pubDate: null }, r) : null;
                }
                case 'set_update_channel': info.channel = args.channel; return null;
                case 'install_update': {
                    const ch = args.onEvent;
                    ch.onmessage({ event: 'progress', data: { downloaded: 1048576, total: 4194304 } });
                    if (mock.dirtyDuringInstall) window.__lucid.state.isDirty = true;
                    await mock.gate;
                    ch.onmessage({ event: 'progress', data: { downloaded: 4194304, total: 4194304 } });
                    ch.onmessage({ event: 'installed' });
                    return null;
                }
                case 'restart_app': mock.restarted++; return null;
                case 'ask_dialog':
                    if (mock.dirtyOnAsk) window.__lucid.state.isDirty = true;
                    return mock.ask;
                case 'message_dialog': return null;
                case 'set_app_menu': return cfg.platform === 'macos';
                case 'system_info': return { os: cfg.platform, arch: 'x86_64', cpus: 8, totalMemoryBytes: 1, appVersion: info.currentVersion, tauriVersion: '2', desktop: true };
                default: return null;
            }
        },
    };
    window.__TAURI__ = { core: { Channel }, event: { listen() { return Promise.resolve(() => {}); } } };
    // Auto-check timing (test aid read by the shim): off unless the test asks.
    window.__lucidUpdateCheckTiming = cfg.timing || { first: 1e9, every: 0 };
    window.__mock = mock;
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await sleep(1200);
let browser;

async function openApp(cfg) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 400)); fails++; });
    await page.addInitScript(installMock, cfg);
    await page.addInitScript({ path: SHIM });
    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && document.getElementById('menuHelp'),
        null, { timeout: 60000 });
    await page.waitForFunction(() => window.__lucidUpdates, null, { timeout: 10000 });
    return page;
}

const calls = (page, name) => page.evaluate(n => window.__mock.named(n).map(c => c.args), name);
async function waitCalls(page, name, n, what) {
    try {
        await page.waitForFunction(([nm, k]) => window.__mock.named(nm).length >= k, [name, n], { timeout: 8000 });
        return true;
    } catch (e) {
        check(false, 'timed out waiting for ' + what, await calls(page, name));
        return false;
    }
}
const clickHelpUpdate = (page) => page.evaluate(() => document.getElementById('menuCheckUpdates').click());
const UPDATE = { version: '1.0.6', notes: 'n', pubDate: '2026-11-01T00:00:00Z' };

try {
    browser = await playwright[BROWSER].launch();

    section('1. Linux: Help ▸ Check for Updates…, up to date, no key, failed check');
    {
        const page = await openApp({ platform: 'linux', checks: [null, { error: 'GitHub releases: timed out' }] });
        const help = await page.evaluate(() => [...document.querySelectorAll('#menuHelp > .menu-dropdown-item')].map(e => e.id + '=' + e.textContent));
        check(help[help.length - 1] === 'menuCheckUpdates=Check for Updates…', 'last Help item is Check for Updates…', help);
        await clickHelpUpdate(page);
        if (await waitCalls(page, 'message_dialog', 1, 'up-to-date note')) {
            const m = (await calls(page, 'message_dialog'))[0];
            check(m.message === 'luc3d 1.0.5 is up to date (stable channel).' && m.kind === 'info', 'up to date: info note', m);
        }
        check((await calls(page, 'check_update'))[0].allowDowngrade === false, 'a plain check does not allow downgrades');
        await clickHelpUpdate(page);
        if (await waitCalls(page, 'message_dialog', 2, 'error note')) {
            const m = (await calls(page, 'message_dialog'))[1];
            check(m.kind === 'error' && /Could not check for updates/.test(m.message) && /timed out/.test(m.message), 'a failed check is reported', m);
        }
        await page.close();

        const p2 = await openApp({ platform: 'linux', info: { updaterConfigured: false } });
        await clickHelpUpdate(p2);
        if (await waitCalls(p2, 'message_dialog', 1, 'no-key note')) {
            check((await calls(p2, 'message_dialog'))[0].message === 'This build of luc3d cannot update itself.', 'unsigned build says it cannot update');
        }
        check((await calls(p2, 'check_update')).length === 0, '…and never checks');
        await p2.close();
    }

    section('2. Available → question → progress card → restart');
    {
        const page = await openApp({ platform: 'linux', checks: [UPDATE, UPDATE] });
        await clickHelpUpdate(page);
        await waitCalls(page, 'ask_dialog', 1, 'the install question');
        const q = (await calls(page, 'ask_dialog'))[0];
        check(q.message === 'luc3d 1.0.6 is available (you have 1.0.5, stable channel). Install and restart?', 'question names both versions and the channel', q);
        check(q.okLabel === 'Install and Restart' && q.cancelLabel === 'Later', 'buttons: Install and Restart / Later', q);
        await waitCalls(page, 'install_update', 1, 'install');
        const inst = (await calls(page, 'install_update'))[0];
        check(inst.expectedVersion === '1.0.6' && inst.allowDowngrade === false, 'install_update pins the offered version', inst);
        const card = await page.evaluate(() => {
            const c = document.getElementById('lucidUpdateProgress');
            return c && {
                title: c.querySelector('.loading-title').textContent,
                status: document.getElementById('lucidUpdateStatus').textContent,
                pct: c.querySelector('[role=progressbar]').getAttribute('aria-valuenow'),
                fill: document.getElementById('lucidUpdateFill').style.transform,
                cls: c.className,
            };
        });
        check(card && card.title === 'Updating luc3d to 1.0.6', 'progress card shows', card);
        check(card && card.status === 'Downloading… 1.0 MB of 4.0 MB' && card.pct === '25' && card.fill === 'scaleX(0.25)', 'card shows downloaded / total and the bar', card);
        check(card && card.cls === 'loading-overlay', 'card uses LUCID’s progress-card look', card);
        check(await page.evaluate(() => window.__mock.restarted) === 0, 'no restart before the install finished');
        await page.evaluate(() => window.__mock.release());
        await page.waitForFunction(() => window.__mock.restarted > 0, null, { timeout: 5000 }).catch(() => {});
        check(await page.evaluate(() => window.__mock.restarted) === 1, 'restart_app after install');
        check(await page.evaluate(() => document.getElementById('lucidUpdateStatus').textContent) === 'Installed. Restarting…', 'card says Restarting');
        await page.close();

        const p2 = await openApp({ platform: 'linux', checks: [UPDATE], ask: false });
        await clickHelpUpdate(p2);
        await waitCalls(p2, 'ask_dialog', 1, 'the question');
        await sleep(300);
        check((await calls(p2, 'install_update')).length === 0 && !(await p2.$('#lucidUpdateProgress')), 'Later installs nothing');
        await p2.close();
    }

    section('3. Unsaved work is never lost');
    {
        const page = await openApp({ platform: 'linux', checks: [UPDATE, UPDATE, UPDATE] });
        await page.evaluate(() => { window.__lucid.state.isDirty = true; });
        await clickHelpUpdate(page);
        if (await waitCalls(page, 'message_dialog', 1, 'save-first note')) {
            const m = (await calls(page, 'message_dialog'))[0];
            check(m.message === 'Save your project first, then choose Check for Updates again.' && m.kind === 'warning', 'dirty: save first', m);
        }
        check((await calls(page, 'ask_dialog')).length === 0 && (await calls(page, 'install_update')).length === 0, 'dirty: no question, no install');

        await page.evaluate(() => { window.__lucid.state.isDirty = false; window.__mock.dirtyOnAsk = true; });
        await clickHelpUpdate(page);
        await waitCalls(page, 'message_dialog', 2, 'second save-first note');
        check((await calls(page, 'install_update')).length === 0, 'work made while the question was open: no install');

        await page.evaluate(() => { window.__lucid.state.isDirty = false; window.__mock.dirtyOnAsk = false; window.__mock.dirtyDuringInstall = true; window.__mock.release(); });
        await clickHelpUpdate(page);
        await waitCalls(page, 'message_dialog', 3, 'installed-not-restarted note');
        const m = (await calls(page, 'message_dialog'))[2];
        check(/luc3d 1\.0\.6 is installed\. Save your project, then quit and reopen/.test(m.message), 'work made during the download: installed, not restarted', m);
        check(await page.evaluate(() => window.__mock.restarted) === 0 && !(await page.$('#lucidUpdateProgress')), 'no restart, card gone');
        await page.close();
    }

    section('4. Automatic checks: silent, then a notice once per version');
    {
        const page = await openApp({
            platform: 'linux',
            timing: { first: 200, every: 300 },
            checks: [null, { error: 'offline' }, UPDATE, UPDATE, UPDATE, { version: '1.0.7' }],
        });
        await waitCalls(page, 'check_update', 2, 'two silent checks');
        check((await calls(page, 'message_dialog')).length === 0, 'up to date / failing auto-checks are silent');
        await page.waitForSelector('#lucidUpdateNotice', { timeout: 5000 }).catch(() => {});
        const text = await page.evaluate(() => { const n = document.getElementById('lucidUpdateNotice'); return n && n.textContent; });
        check(text === 'luc3d 1.0.6 is availableInstall…Later', 'notice: version, Install…, Later', text);
        check((await calls(page, 'ask_dialog')).length === 0, 'an auto-check never asks by itself');
        await page.click('#lucidUpdateLater');
        check(!(await page.$('#lucidUpdateNotice')), 'Later dismisses it');
        await waitCalls(page, 'check_update', 5, 'more checks of the same version');
        await sleep(100);
        check(!(await page.$('#lucidUpdateNotice')), 'the same version does not come back');
        await waitCalls(page, 'check_update', 6, 'a check finding 1.0.7');
        await page.waitForSelector('#lucidUpdateNotice', { timeout: 5000 }).catch(() => {});
        const t2 = await page.evaluate(() => { const n = document.getElementById('lucidUpdateNotice'); return n && n.textContent; });
        check(t2 && t2.startsWith('luc3d 1.0.7 is available'), 'a newer version brings it back', t2);
        await page.evaluate(() => { window.__mock.ask = false; window.__mock.checks.length = 0; });
        await page.click('#lucidUpdateInstall');
        await waitCalls(page, 'ask_dialog', 1, 'Install… question');
        check(/^luc3d 1\.0\.7 is available/.test((await calls(page, 'ask_dialog'))[0].message), 'Install… asks first');
        check(!(await page.$('#lucidUpdateNotice')), 'notice gone after Install…');
        await page.close();
    }

    section('5. macOS menu actions, update channel; Windows Help item');
    {
        const page = await openApp({ platform: 'macos', checks: [null, { version: '1.0.6-dev.12' }], ask: false });
        check(!(await page.$('#menuCheckUpdates')), 'macOS: no in-page Help item (the luc3d menu has it)');
        await page.waitForFunction(() => window.__mock.named('set_app_menu').length > 0, null, { timeout: 8000 }).catch(() => {});
        const spec = (await calls(page, 'set_app_menu')).pop();
        const helpLabels = spec && spec.menus.find(m => m.label === 'Help').items.map(i => i.label);
        check(helpLabels && !helpLabels.includes('Check for Updates…'), 'native Help menu spec has no update item', helpLabels);
        check(await page.evaluate(() => {
            const d = Object.getOwnPropertyDescriptor(window, '__lucidUpdates');
            return d && !d.writable && !d.configurable && Object.isFrozen(d.value);
        }), '__lucidUpdates is fixed');
        await page.evaluate(() => window.__lucidUpdates.menu('check'));
        await waitCalls(page, 'message_dialog', 1, 'menu check');
        check((await calls(page, 'check_update'))[0].allowDowngrade === false, "menu('check') runs a plain check");
        await page.evaluate(() => window.__lucidUpdates.menu('channel:dev'));
        await waitCalls(page, 'ask_dialog', 1, 'channel switch question');
        check(JSON.stringify(await calls(page, 'set_update_channel')) === JSON.stringify([{ channel: 'dev' }]), 'channel set to dev');
        check((await calls(page, 'check_update'))[1].allowDowngrade === true, 'the switch checks with allowDowngrade');
        check(/luc3d 1\.0\.6-dev\.12 is available \(you have 1\.0\.5, dev channel\)/.test((await calls(page, 'ask_dialog'))[0].message), 'question names the new channel');
        check(await page.evaluate(() => window.__lucidUpdates.menu('bogus')) === false, 'unknown action ignored');
        await page.close();

        const win = await openApp({ platform: 'windows' });
        check(!!(await win.$('#menuCheckUpdates')), 'Windows: Help ▸ Check for Updates…');
        await win.close();
    }
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
