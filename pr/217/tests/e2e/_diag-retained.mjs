/**
 * _diag-retained.mjs — after a real reload, clear every structure reachable from
 * app state, then ask V8 (via CDP Runtime.queryObjects) what is STILL alive.
 *
 * Context: `_real-roundtrip.mjs ... ATTRIBUTE=1` shows ~2.5 GB surviving a full
 * strip of `state`, with both h5wasm WASM heaps at 18 MB and the loader promise
 * already resolved. Something outside app state retains it. `queryObjects`
 * returns every live object with a given prototype, which turns that from a
 * guess into a count.
 *
 * Not a test. Usage: node _diag-retained.mjs <saved.slp> [port]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const SLP = process.argv[2];
const PORT = Number(process.argv[3] || 8105);
if (!SLP) { console.error('usage: node _diag-retained.mjs <saved.slp> [port]'); process.exit(2); }
const SLP_ABS = path.isAbsolute(SLP) ? SLP : path.join(repoRoot, SLP);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));

let browser;
try {
    browser = await chromium.launch({ args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] });
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.SleapIO, { timeout: 30000 });

    // dismiss modals
    await page.evaluate(() => setInterval(() => {
        for (const b of document.querySelectorAll('button')) {
            const t = b.textContent.trim();
            if ((t === 'Continue' || t.startsWith('Skip') || t === 'Cancel') && b.offsetParent) b.click();
        }
    }, 250));

    await page.evaluate(() => {
        const i = document.createElement('input');
        i.type = 'file'; i.id = '__p'; i.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(i);
    });
    await page.setInputFiles('#__p', SLP_ABS);
    console.log('loading…');
    await page.evaluate(() => {
        window.__r = { done: false, err: null };
        (async () => {
            const sl = await import('/loading/session-loader.js');
            sl.handleLoadProjectSlpLazy(document.getElementById('__p').files[0])
                .then(() => { window.__r.done = true; })
                .catch(e => { window.__r.err = String(e).slice(0, 300); });
        })();
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 20 * 60 * 1000) {
        const st = await page.evaluate(() => ({ d: window.__r.done, e: window.__r.err }));
        if (st.d || st.e) { console.log('loader done:', st.d, st.e || ''); break; }
        await new Promise(r => setTimeout(r, 3000));
    }

    // Strip everything reachable from app state.
    const before = await page.evaluate(async () => {
        const gc = async () => { for (let i = 0; i < 5; i++) window.gc && window.gc(); await new Promise(r => setTimeout(r, 200)); };
        const st = window.__lucid.state;
        await gc();
        const b = performance.memory.usedJSHeapSize / 1048576;
        for (const s of (st.sessions || [])) {
            s.instanceGroups = new Map(); s.frameGroups = new Map();
            s.frameIdentityMap = new Map(); s.triangulationResults = new Map();
            if (s.lazyLoader) { try { s.lazyLoader.close(); } catch (e) {} s.lazyLoader = null; }
        }
        st.sessions = []; st.session = null; st.views = []; st.videoFiles = [];
        st.triangulationResults = new Map();
        await gc();
        return { before: +b.toFixed(0), after: +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) };
    });
    console.log(`heap ${before.before} -> ${before.after} MB after stripping app state`);

    // Ask V8 what is still alive, by prototype.
    const client = await page.context().newCDPSession(page);
    const PROTOS = [
        ['LUCID Instance',        `(await import('/pose/pose-data.js')).Instance.prototype`],
        ['LUCID InstanceGroup',   `(await import('/pose/pose-data.js')).InstanceGroup.prototype`],
        ['LUCID FrameGroup',      `(await import('/pose/pose-data.js')).FrameGroup.prototype`],
        ['SIO Instance',          `window.SleapIO.Instance.prototype`],
        ['SIO PredictedInstance', `window.SleapIO.PredictedInstance.prototype`],
        ['SIO LabeledFrame',      `window.SleapIO.LabeledFrame.prototype`],
        ['SIO Instance3D',        `window.SleapIO.Instance3D.prototype`],
        ['SIO InstanceGroup',     `window.SleapIO.InstanceGroup.prototype`],
        ['SIO FrameGroup',        `window.SleapIO.FrameGroup.prototype`],
        ['Float64Array',          `Float64Array.prototype`],
        ['Float32Array',          `Float32Array.prototype`],
        ['Int32Array',            `Int32Array.prototype`],
        ['Uint8Array',            `Uint8Array.prototype`],
        ['Map',                   `Map.prototype`],
        ['ArrayBuffer',           `ArrayBuffer.prototype`],
    ];
    console.log('\n  live objects by prototype (after the strip):');
    for (const [label, expr] of PROTOS) {
        try {
            const { result } = await client.send('Runtime.evaluate', {
                expression: `(async () => ${expr})()`, awaitPromise: true, returnByValue: false,
            });
            if (!result || !result.objectId) { console.log(`    ${label.padEnd(24)} (no prototype)`); continue; }
            const q = await client.send('Runtime.queryObjects', { prototypeObjectId: result.objectId });
            const cnt = await client.send('Runtime.callFunctionOn', {
                objectId: q.objects.objectId,
                functionDeclaration: `function () {
                    let n = this.length, bytes = 0;
                    for (const o of this) {
                        if (ArrayBuffer.isView(o)) bytes += o.byteLength;
                        else if (o instanceof ArrayBuffer) bytes += o.byteLength;
                    }
                    return JSON.stringify({ n, mb: +(bytes / 1048576).toFixed(1) });
                }`,
                returnByValue: true,
            });
            const v = JSON.parse(cnt.result.value);
            console.log(`    ${label.padEnd(24)} ${String(v.n).padStart(10)}` +
                        (v.mb > 0 ? `   ${String(v.mb).padStart(8)} MB of backing store` : ''));
        } catch (e) {
            console.log(`    ${label.padEnd(24)} ERR ${String(e.message || e).slice(0, 80)}`);
        }
    }
} catch (e) {
    console.error('FATAL', String(e).slice(0, 400));
} finally {
    if (browser) await browser.close();
    server.kill();
}
