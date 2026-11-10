/**
 * connect-e2e.mjs — the boot every `tests/e2e/connect-*.mjs` shares.
 *
 * Node-side (Playwright), like track-setup.js: a `python3 -m http.server` on
 * `PORT` (env, else the file's default), one headless Chromium, a ✓/✗ `check`
 * counter, pageerror capture, the app boot wait, and the two ways the tests
 * reach the Connect store from the page (`pair` and `store`).
 *
 *   await runConnectE2E(9393, async ({ browser, BASE }) => {
 *       const page = await watchPage(await browser.newPage());
 *       await bootApp(page, BASE);
 *       check(...);
 *   });
 *
 * `runConnectE2E` closes the browser and the server, prints the summary and
 * exits 1 on any failed check or page error. A throw from the body propagates
 * (non-zero exit) unless `onError` takes it.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let fails = 0;

/** One ✓/✗ line; `extra` (JSON, cut to 700 chars) is printed only on a failure. */
export function check(ok, msg, extra) {
    console.log((ok ? '  ✓ ' : '  ✗ ') + msg + (ok || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 700)));
    if (!ok) fails++;
}

/** Counts a failure that is not a `check` (a page error, a throw caught by `onError`). */
export function fail() { fails++; }

/**
 * Counts every page error as a failure; `consoleTypes` (a RegExp over the console message type)
 * also prints those console lines. Returns the page.
 */
export function watchPage(page, { consoleTypes } = {}) {
    page.on('pageerror', (e) => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    if (consoleTypes) page.on('console', (m) => { if (consoleTypes.test(m.type())) console.log('  [console.' + m.type() + ']', m.text().slice(0, 300)); });
    return page;
}

/** Opens the app and waits for the Connect rail button (the panel rail is up). */
export async function bootApp(page, BASE, { timeout = 30000 } = {}) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.panel-rail-btn[data-tab="tabConnect"]', { timeout });
}

/** Pairs `worker` at `addr` through the store (`pairWithCode`), as the pairing form would. */
export async function pair(page, worker, addr) {
    const code = await worker.mintPairCode({ addrs: [addr] });
    await page.evaluate((c) => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().pairWithCode(c)), code);
}

/** Runs `fn(useConnectStore.getState(), arg)` in the page (`fn` is serialized: no closures) and returns its result. */
export function store(page, fn, arg) {
    return page.evaluate(async ([src, a]) => {
        const { useConnectStore } = await import('./pose/connect/store.js');
        return (0, eval)('(' + src + ')')(useConnectStore.getState(), a);
    }, [fn.toString(), arg]);
}

/**
 * Serves the repo, launches Chromium and runs `body({ browser, BASE, PORT })`; then closes both,
 * prints the summary and exits (1 on any failure).
 * @param {number} defaultPort  used when `PORT` is not set
 * @param {(t: {browser: import('playwright').Browser, BASE: string, PORT: number}) => Promise<void>} body
 * @param {{onError?: (e: Error) => (void|Promise<void>)}} [opts]  takes a throw from the body (before the browser closes)
 */
export async function runConnectE2E(defaultPort, body, { onError } = {}) {
    const PORT = Number(process.env.PORT || defaultPort);
    const BASE = `http://localhost:${PORT}`;
    const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
    let browser;
    try {
        await new Promise((r) => setTimeout(r, 800));
        browser = await chromium.launch();
        await body({ browser, BASE, PORT });
    } catch (e) {
        if (!onError) throw e;
        await onError(e);
    } finally {
        if (browser) await browser.close();
        server.kill();
    }
    console.log(fails ? `\n${fails} FAILED` : '\nall passed');
    process.exit(fails ? 1 : 0);
}
