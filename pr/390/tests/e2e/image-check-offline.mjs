/**
 * image-check-offline.mjs — the image ID-switch check without the network
 * (ui/image-embedder.js `asModelDownloadFailure` / `importTransformers`,
 * ui/id-switch-modal.js `runImage`).
 *
 * The check downloads its runtime (transformers.js, cdn.jsdelivr.net) and its
 * model (huggingface.co) on first use. Offline both downloads reject with a bare
 * TypeError, and the status line used to print it verbatim: "failed — Failed to
 * fetch dynamically imported module: https://cdn.jsdelivr.net/…", or for the
 * weights just "failed — Failed to fetch". It now reports MODEL_OFFLINE_REASON as
 * the reason the check cannot run, like its other preflight gates.
 *
 * The app boots with the network; every off-localhost request is then ABORTED
 * (not throttled, so nothing is served from the HTTP cache). The weights case
 * serves a stub runtime whose `from_pretrained` fetches from huggingface.co, so
 * the test needs no network at all. Asserted, on the GPU path (main thread) and
 * the CPU path (module workers) alike:
 *  1. Runtime blocked: the reason, a warning, no "Failed to fetch", no results stored.
 *  2. Weights blocked: the same reason.
 *  3. A retry after the runtime comes back re-imports it in the same page — Chrome
 *     keeps a failed dynamic import of the same URL failed until a reload.
 *  4. After Track All (`auto`): "skipped — <reason>" on the pass's status line.
 *  5. Negative controls: any other error is still "failed — <message>"; a skeleton
 *     without TTI is a reason too.
 *
 * Run: node tests/e2e/image-check-offline.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8276);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

// A stand-in for transformers.js whose model download goes to huggingface.co (blocked)
const STUB_RUNTIME = `export const env = {}; export class Tensor {} export const stub = 'runtime-stub';
export const AutoModel = { from_pretrained: async (id) => {
    await fetch('https://huggingface.co/' + id + '/resolve/main/config.json');
    throw new Error('stub runtime: the weights download was not blocked');
} };`;

let browser;
try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
    // 'open' until the app has booted; then 'blocked' (nothing off localhost) or 'weights' (stub runtime, no weights)
    let mode = 'open';
    const runtimeRequests = [];
    await context.route('**/*', route => {
        const url = route.request().url();
        if (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
        if (mode === 'open') return route.continue();
        if (url.includes('@huggingface/transformers')) {
            runtimeRequests.push(mode);
            if (mode === 'weights') return route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: STUB_RUNTIME });
        }
        return route.abort();
    });
    const page = await context.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    await page.evaluate(async () => {
        // A tracked session (two identities with 3D) and one camera "with video": what runImage needs to start
        window.__buildTracked = async (nodes) => {
            const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
            const session = new pd.Session([], new pd.Skeleton('m', nodes, []), [], 'OfflineFixture');
            session.addIdentity('id_0'); session.addIdentity('id_1');
            let gid = 1;
            for (let f = 0; f < 600; f++) session.instanceGroups.set(f, [0, 1].map(k => {
                const g = new pd.InstanceGroup(gid++, session.identities[k].id);
                g.points3d = Float64Array.from({ length: nodes.length * 3 }, (_, i) => 200 * k + i + f / 100); return g; }));
            AS.state.sessions = [session]; AS.state.activeSessionIdx = 0; AS.state.session = session;
            AS.state.totalFrames = 600; AS.state.currentFrame = 0; AS.state.fps = 30;
            AS.state.views = [{ name: 'c0', decoder: { getFrame: async () => null } }];
            delete session._idSwitch;
        };
        window.__run = async (opts) => {
            const M = await import('/ui/id-switch-modal.js'); const E = await import('/ui/image-embedder.js');
            const device = opts.device;
            const inject = opts.throws ? { createEmbedder: async () => { throw new Error(opts.throws); } }
                : { createEmbedder: (s, o) => E.createImageEmbedder(s, Object.assign({}, o, { device: device, cpuWorkers: 1 })) };
            const res = await M.runIdSwitchChecks({ image: true, auto: !!opts.auto, statusPrefix: opts.auto ? 'Assigned 2 identities' : undefined, inject });
            const st = document.getElementById('statusText');
            return { res: res && res.image ? { ok: res.image.ok, reason: res.image.reason, failed: !!res.image.failed } : null,
                status: st.textContent, warning: document.getElementById('statusDot').classList.contains('warning'),
                stored: !!(window.__lucid.state.session._idSwitch && window.__lucid.state.session._idSwitch.results.image),
                dialogs: document.querySelectorAll('.id-switch-progress').length };
        };
    });
    const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip'];
    const REASON = await page.evaluate(async () => (await import('/ui/image-embedder.js')).MODEL_OFFLINE_REASON);
    check(/internet connection/.test(REASON) && REASON.includes('huggingface.co') && REASON.includes('cdn.jsdelivr.net'),
        'the reason names the cause and both hosts: "' + REASON + '"');
    const offlineCase = (r, label, prefix) => {
        check(r.res && r.res.ok === false && r.res.reason === REASON && !r.res.failed, label + ': the check returns the reason, not a failure');
        check(r.status === prefix + REASON, label + ': status reads "' + r.status.slice(0, 130) + '"');
        check(!/fetch/i.test(r.status), label + ': no "Failed to fetch" in the status');
        check(!r.stored, label + ': no results stored');
        check(r.dialogs === 0, label + ': the progress dialog is closed');
    };

    for (const device of ['webgpu', 'cpu']) {
        const where = device === 'webgpu' ? 'GPU path' : 'CPU path (worker)';
        console.log('\n' + where);
        await page.evaluate((n) => window.__buildTracked(n), NODES);
        // ---- 1. runtime blocked
        mode = 'blocked';
        const n0 = runtimeRequests.length;
        let r = await page.evaluate((d) => window.__run({ device: d }), device);
        check(runtimeRequests.length > n0, where + ': the runtime download was attempted (and blocked)');
        offlineCase(r, where + ', runtime blocked', 'Check ID Switches (images): ');
        check(r.warning, where + ', runtime blocked: shown as a warning');
        // ---- 2. + 3. runtime back (stub), weights still blocked: re-imported in this page, then the weights fail
        mode = 'weights';
        const n1 = runtimeRequests.length;
        r = await page.evaluate((d) => window.__run({ device: d }), device);
        check(runtimeRequests.slice(n1).includes('weights'), where + ': the retry re-requested the runtime');
        offlineCase(r, where + ', weights blocked', 'Check ID Switches (images): ');
    }
    // 3. the runtime imported after the earlier failure IS the one now served (no reload)
    const stub = await page.evaluate(async () => (await (await import('/ui/image-embedder.js')).importTransformers()).stub);
    check(stub === 'runtime-stub', 'after a failed import, importTransformers() loads the runtime again in the same page (got ' + stub + ')');

    // ---- 4. after Track All
    console.log('\nAfter Track All');
    mode = 'blocked';
    await page.evaluate((n) => window.__buildTracked(n), NODES);
    let r = await page.evaluate(() => window.__run({ device: 'cpu', auto: true }));
    offlineCase(r, 'auto, offline', 'Assigned 2 identities · ID-switch check (images): skipped — ');

    // ---- 5. negative controls
    console.log('\nNegative controls');
    r = await page.evaluate(() => window.__run({ throws: 'the GPU device was lost' }));
    check(r.res && r.res.failed && r.status === 'Check ID Switches (images): failed — the GPU device was lost',
        'any other error is still a failure: "' + r.status + '"');
    await page.evaluate(() => window.__buildTracked(['Nose', 'Ear_R', 'Ear_L', 'TailTip']));
    r = await page.evaluate(() => window.__run({ device: 'cpu' }));
    check(r.res && !r.res.failed && r.status === 'Check ID Switches (images): needs Nose and TTI nodes in the skeleton to align crops',
        'a skeleton without TTI is a reason, not a failure: "' + r.status + '"');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
}
console.log(fails ? `\nFAIL — ${fails} check(s) failed` : '\nPASS');
process.exit(fails ? 1 : 0);
