/**
 * image-model-package.mjs — a model PACKAGE for the image ID-switch check
 * (ui/image-model-package.js, ui/image-model-dialog.js), with a real model.
 *
 * The built-in model's fp32 files (config.json, onnx/model.onnx) are downloaded
 * once and wrapped as a package with a manifest (lucid-model.json, as
 * scripts/make_image_model_package.py writes it). Same weights, so the package
 * must give the built-in model's vectors exactly. Asserted:
 *  1. From a local folder (files as <input webkitdirectory> gives them): the key
 *     is the SHA-256 the manifest declares plus its fields; transformers.js loads
 *     it on the main thread AND in a CPU model worker (each realm serves the files
 *     through its own `env.fetch` hook), and both give the built-in model's
 *     vectors bit for bit. No request goes out for the package's files, and
 *     nothing of it lands in Cache Storage.
 *  2. From a URL (a local server here): only the manifest is fetched up front,
 *     the key equals the folder's (the manifest lists the weights' hashes), the
 *     weights come from that server, and the vectors are the same.
 *  2b. The downloaded weights are checked against the manifest's SHA-256: a server
 *     whose model.onnx differs by one byte fails the load (in a CPU worker and on
 *     the page) with the reason, and nothing of it is cached; a wrong copy already
 *     in Cache Storage is deleted and downloaded again, and the run is right.
 *  3. The dialog: Esc changes nothing; loading the folder and "Use this model"
 *     sets the session's choice (key, name, input, threshold, folder) and marks
 *     the project dirty; the ID Switches tab names the model.
 *  4. A session whose folder model is not loaded is refused with the reason (no
 *     silent fall-back to another model); its URL model reloads by itself.
 *
 * Run: node tests/e2e/image-model-package.mjs   (downloads the ~86 MB fp32 model once; skips offline)
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const src = fs.readFileSync(path.join(repoRoot, 'ui', 'image-embedder.js'), 'utf8');
const MODEL_ID = src.match(/IMAGE_MODEL_ID = '([^']+)'/)[1];
const REVISION = src.match(/IMAGE_MODEL_REVISION = '([0-9a-f]{40})'/)[1];
// the built-in model's files at its pinned commit (the ones the app loads), not whatever the repo's main holds now
const HF = `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/`;
const dir = path.join(os.tmpdir(), 'lucid-image-model-package-test', MODEL_ID.replace('/', '__') + '@' + REVISION.slice(0, 12));
fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
try {
    for (const f of ['config.json', 'onnx/model.onnx']) {
        const p = path.join(dir, f);
        if (fs.existsSync(p) && fs.statSync(p).size > 0) continue;
        const r = await fetch(HF + f);
        if (!r.ok) throw new Error(f + ': HTTP ' + r.status);
        fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
    }
} catch (e) { console.log('SKIP — the model is not reachable (' + e.message + ')'); process.exit(0); }
const fp32 = fs.readFileSync(path.join(dir, 'onnx', 'model.onnx'));
const SHA = crypto.createHash('sha256').update(fp32).digest('hex');
const MANIFEST = { format: 'lucid-image-model', version: 1, name: 'Built-in weights as a package', base: 'facebook/dinov3-vits16-pretrain-lvd1689m',
    license: 'DINOv3 License', input: 192, crop: 160, threshold: -1.2, fp16: false, sha256: { 'onnx/model.onnx': SHA },
    training: { method: 'none (test)' }, validation: { note: 'same weights as the built-in model' } };
fs.writeFileSync(path.join(dir, 'lucid-model.json'), JSON.stringify(MANIFEST, null, 2));
// a server whose weights are not the manifest's: one byte changed, same manifest (so the same key)
const TAMPER_AT = 1 << 20;
fs.mkdirSync(path.join(dir, 'tampered', 'onnx'), { recursive: true });
fs.copyFileSync(path.join(dir, 'lucid-model.json'), path.join(dir, 'tampered', 'lucid-model.json'));
fs.copyFileSync(path.join(dir, 'config.json'), path.join(dir, 'tampered', 'config.json'));
{ const bad = Buffer.from(fp32); bad[TAMPER_AT] ^= 0xff; fs.writeFileSync(path.join(dir, 'tampered', 'onnx', 'model.onnx'), bad); }

const server = await startServer(repoRoot);
const PORT = server.port;
// the package's own server: a second origin, so it must send CORS headers
// (Python's http.server sent none, so this used to be a tiny Python one)
const reqLog = path.join(dir, '..', 'requests.log');
fs.writeFileSync(reqLog, '');
const pkgServer = await startServer(dir, { port: 0, cors: true, onRequest: (req) => fs.appendFileSync(reqLog, req.url + '\n') });
const PKG_PORT = pkgServer.port;

let browser;
try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [], pkgRequests = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('request', r => { if (r.url().includes('lucid-pkg/')) pkgRequests.push(r.url()); });
    page.on('worker', w => w.on('request', r => { if (r.url().includes('lucid-pkg/')) pkgRequests.push(r.url()); }));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    // ---- 1. from a local folder
    const r1 = await page.evaluate(async ({ PKG_PORT, SHA }) => {
        const P = await import('/ui/image-model-package.js'), E = await import('/ui/image-embedder.js'), M = await import('/pose/image-model-manifest.js');
        const files = [];
        for (const p of ['lucid-model.json', 'config.json', 'onnx/model.onnx']) {
            const b = await (await fetch('http://127.0.0.1:' + PKG_PORT + '/' + p)).blob();
            const f = new File([b], p.split('/').pop());
            Object.defineProperty(f, 'webkitRelativePath', { value: 'my-package/' + p });
            files.push(f);
        }
        window.__pkgFiles = files;
        const pkg = await P.loadModelPackageFromFiles(files);
        const manifest = M.parseModelManifest(await files[0].text(), E.CROP).manifest;
        const expectKey = M.hexOf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(M.modelKeyMaterial(manifest, { 'onnx/model.onnx': SHA }))));
        // the same 3 inputs through the built-in model and the package, on the main thread (wasm) and in a CPU worker
        let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
        const n = 3, SZ = 3 * 192 * 192, data = Float32Array.from({ length: n * SZ }, () => (rnd() - 0.5) * 4);
        const T = await E.importTransformers();
        P.installModelPackageFetch(T);
        const cls = async (id, isPkg) => {
            const m = await P.withPackageCachePolicy(T, isPkg ? pkg : null, () => T.AutoModel.from_pretrained(id, E.pretrainedOptions(isPkg ? pkg : E.BUILTIN_IMAGE_MODEL, { device: 'wasm', dtype: 'fp32' })));
            const res = await m({ pixel_values: new T.Tensor('float32', data.slice(), [n, 3, 192, 192]) });
            const hs = res.last_hidden_state, tok = hs.dims[1], dim = hs.dims[2], out = [];
            for (let i = 0; i < n; i++) out.push(Float32Array.from(hs.data.subarray(i * tok * dim, i * tok * dim + dim)));
            return out;
        };
        const ref = await cls(E.IMAGE_MODEL_ID, false), main = await cls(pkg.id, true);
        E.setActiveImageModel(pkg);
        const pool = await E.createCpuModelPool(1);
        const worker = await pool.run(data.slice(), n);
        pool.terminate();
        E.setActiveImageModel(null);
        const diff = (a, b) => { let d = 0; a.forEach((v, i) => { for (let k = 0; k < v.length; k++) d = Math.max(d, Math.abs(v[k] - b[i][k])); }); return d; };
        const cacheKeys = [];
        for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) if (req.url.includes('lucid-pkg/')) cacheKeys.push(req.url);
        return { key: pkg.key, expectKey, id: pkg.id, name: pkg.name, folder: pkg.source.folder, input: pkg.input, mb: pkg.mb,
                 mainDiff: diff(ref, main), workerDiff: diff(ref, worker), dims: [ref.length, ref[0].length], cacheKeys };
    }, { PKG_PORT, SHA });
    check(r1.key === r1.expectKey && r1.id === 'lucid-pkg/' + r1.key.slice(0, 16), `folder package: key = SHA-256 of its fields and weights (${r1.key.slice(0, 16)}…)`);
    check(r1.folder === 'my-package' && r1.input === 192 && r1.mb.fp32 === Math.round(fp32.length / 1e6), `…named after its folder, input ${r1.input} px, ${r1.mb.fp32} MB fp32`);
    check(r1.dims[0] === 3 && r1.dims[1] === 384 && r1.mainDiff === 0, `main thread: the package gives the built-in model's CLS vectors bit for bit (max diff ${r1.mainDiff})`);
    check(r1.workerDiff === 0, `CPU worker: the same, through the worker's own fetch hook (max diff ${r1.workerDiff})`);
    check(pkgRequests.length === 0, `no request went out for the package's files (${pkgRequests.length})`);
    check(r1.cacheKeys.length === 0, `nothing of the local package was copied into Cache Storage (${r1.cacheKeys.length})`);

    // ---- 2. from a URL
    fs.writeFileSync(reqLog, '');
    const r2 = await page.evaluate(async ({ PKG_PORT }) => {
        const P = await import('/ui/image-model-package.js'), E = await import('/ui/image-embedder.js');
        const before = P.registeredModelPackages().length;
        const pkg = await P.loadModelPackageFromUrl('http://localhost:' + PKG_PORT + '/');
        const sameObject = P.registeredModelPackages().length === before;      // same key: the folder package is reused
        P.clearModelPackages();
        const fresh = await P.loadModelPackageFromUrl('http://localhost:' + PKG_PORT + '/lucid-model.json');
        const afterManifest = performance.now();
        E.setActiveImageModel(fresh);
        const pool = await E.createCpuModelPool(1);
        let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
        const n = 3, SZ = 3 * 192 * 192, data = Float32Array.from({ length: n * SZ }, () => (rnd() - 0.5) * 4);
        const out = await pool.run(data, n);
        pool.terminate();
        E.setActiveImageModel(null);
        return { key: pkg.key, freshKey: fresh.key, sameObject, kind: fresh.source.kind, base: fresh.source.base, first: Array.from(out[0].slice(0, 4)), afterManifest };
    }, { PKG_PORT });
    const served = fs.readFileSync(reqLog, 'utf8').split('\n').filter(Boolean);
    check(r2.key === r1.key && r2.freshKey === r1.key && r2.sameObject, `URL package: the same key as the folder (the manifest lists the weights' hash)`);
    check(r2.kind === 'url' && r2.base === `http://localhost:${PKG_PORT}/`, `…its files come from ${r2.base}`);
    check(served.filter(p => p.startsWith('/lucid-model.json')).length === 2 && served.some(p => p.startsWith('/onnx/model.onnx')) && served.some(p => p.startsWith('/config.json')),
          `the server saw the manifest (twice: two loads) and, on first use, config.json and the weights: ${[...new Set(served.map(p => p.split('?')[0]))].join(', ')}`);

    // ---- 2b. the weights are checked against the manifest
    const r2b = await page.evaluate(async ({ PKG_PORT, TAMPER_AT }) => {
        const P = await import('/ui/image-model-package.js'), E = await import('/ui/image-embedder.js');
        const cache = await caches.open('transformers-cache');
        const cached = async (id) => (await cache.keys()).map(r => r.url).filter(u => u.includes(id + '/'));
        // drop what §2 cached for this key, so the tampered server's weights are downloaded
        P.clearModelPackages();
        const bad = await P.loadModelPackageFromUrl('http://localhost:' + PKG_PORT + '/tampered/');
        for (const u of await cached(bad.id)) await cache.delete(u);
        E.setActiveImageModel(bad);
        let workerErr = null, pageErr = null;
        try { const pool = await E.createCpuModelPool(1); pool.terminate(); } catch (e) { workerErr = e.message; }
        const T = await E.importTransformers();
        P.installModelPackageFetch(T);
        try { await P.withPackageCachePolicy(T, bad, () => T.AutoModel.from_pretrained(bad.id, E.pretrainedOptions(bad, { device: 'wasm', dtype: 'fp32' }))); } catch (e) { pageErr = e.message; }
        const afterBad = await cached(bad.id);
        E.setActiveImageModel(null);
        // a wrong copy already in the cache (cached before downloads were checked): deleted, downloaded again
        P.clearModelPackages();
        const good = await P.loadModelPackageFromUrl('http://localhost:' + PKG_PORT + '/');
        const weightsUrl = P.packageCacheUrl(T, good.id, 'onnx/model.onnx');
        const wrong = new Uint8Array(await (await fetch('http://localhost:' + PKG_PORT + '/tampered/onnx/model.onnx')).arrayBuffer());
        await cache.put(weightsUrl, new Response(wrong, { headers: { 'content-length': String(wrong.length) } }));
        E.setActiveImageModel(good);
        const pool = await E.createCpuModelPool(1);
        let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
        const n = 3, SZ = 3 * 192 * 192, data = Float32Array.from({ length: n * SZ }, () => (rnd() - 0.5) * 4);
        const out = await pool.run(data, n);
        pool.terminate();
        E.setActiveImageModel(null);
        const now = await cache.match(weightsUrl);
        const nowBytes = now ? new Uint8Array(await now.arrayBuffer()) : null;
        return { workerErr, pageErr, afterBad, first: Array.from(out[0].slice(0, 4)),
                 recached: !!nowBytes && nowBytes.length === wrong.length, fixed: !!nowBytes && nowBytes[TAMPER_AT] !== wrong[TAMPER_AT] };
    }, { PKG_PORT, TAMPER_AT });
    const MISMATCH = /onnx\/model\.onnx from http:\/\/localhost:\d+\/tampered\/ does not match the SHA-256 in lucid-model\.json/;
    check(MISMATCH.test(r2b.workerErr || ''), `weights one byte off the manifest: the CPU worker refuses them ("${(r2b.workerErr || 'loaded').slice(0, 140)}")`);
    check(MISMATCH.test(r2b.pageErr || ''), `…and so does the page (WebGPU / WebNN path) ("${(r2b.pageErr || 'loaded').slice(0, 80)}…")`);
    check(!r2b.afterBad.some(u => u.endsWith('onnx/model.onnx')), `…and the wrong weights were not cached (${r2b.afterBad.map(u => u.split('/').pop()).join(', ') || 'nothing'})`);
    check(r2b.recached && r2b.fixed, 'a wrong cached copy is deleted and the right weights downloaded in its place');
    check(JSON.stringify(r2b.first) === JSON.stringify(r2.first), `…and the run gives the right model's vectors (${r2b.first.map(v => v.toFixed(4)).join(', ')})`);

    // ---- 3. the dialog
    const r3 = await page.evaluate(async () => {
        const D = await import('/ui/image-model-dialog.js'), P = await import('/ui/image-model-package.js'), AS = await import('/ui/app-state.js');
        const pd = await import('/pose/pose-data.js');
        P.clearModelPackages();
        const session = new pd.Session([], new pd.Skeleton('sk', ['Nose', 'TTI'], []), []);
        AS.state.sessions = [session]; AS.state.session = session; AS.state.activeSessionIdx = 0; AS.state.isDirty = false;
        // Esc: nothing changes
        let p = D.showImageModelDialog(session);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const escChanged = await p, escModel = session.imageModel, escDirty = AS.state.isDirty;
        // load the folder, pick it, use it
        p = D.showImageModelDialog(session, { pickFiles: () => Promise.resolve(window.__pkgFiles) });
        document.getElementById('imageModelFolder').click();
        for (let i = 0; i < 600 && document.querySelectorAll('.image-model-option input').length < 2; i++) await new Promise(r => setTimeout(r, 50));
        const options = [...document.querySelectorAll('.image-model-option input')].map(i => [i.value.slice(0, 8), i.checked]);
        const details = document.querySelector('.image-model-details').textContent;
        document.getElementById('imageModelUse').click();
        const changed = await p;
        const line = D.imageModelLineHtml(session);
        return { escChanged, escModel, escDirty, options, details, changed, choice: session.imageModel, dirty: AS.state.isDirty, line };
    });
    check(r3.escChanged === false && r3.escModel === null && !r3.escDirty, 'Esc closes the dialog and changes nothing');
    check(r3.options.length === 2 && r3.options[1][1] === true && r3.options[1][0] === r1.key.slice(0, 8), `loading the folder adds it and selects it (${JSON.stringify(r3.options)})`);
    check(/Trained from/.test(r3.details) && /−1\.2/.test(r3.details) && /same weights as the built-in model/.test(r3.details), 'its details show the base, the threshold and the validation note');
    check(r3.changed === true && r3.dirty && r3.choice && r3.choice.key === r1.key && r3.choice.folder === 'my-package' && r3.choice.input === 192 && r3.choice.threshold === -1.2,
          `"Use this model" sets the session's choice and marks the project dirty: ${JSON.stringify(r3.choice)}`);
    check(/Built-in weights as a package/.test(r3.line) && /−1\.2/.test(r3.line) && !/not loaded/.test(r3.line), 'the ID Switches line names the model and its threshold');

    // ---- 4. a folder model not loaded is refused; a URL model reloads
    const r4 = await page.evaluate(async ({ PKG_PORT }) => {
        const D = await import('/ui/image-model-dialog.js'), P = await import('/ui/image-model-package.js'), AS = await import('/ui/app-state.js');
        const session = AS.state.session;
        P.clearModelPackages();
        let reason = null;
        try { await D.resolveSessionImageModel(session); } catch (e) { reason = e.message; }
        const line = D.imageModelLineHtml(session);
        session.imageModel = Object.assign({}, session.imageModel, { url: 'http://localhost:' + PKG_PORT + '/' });
        delete session.imageModel.folder;
        const viaUrl = await D.resolveSessionImageModel(session);
        session.imageModel = null;
        const builtin = await D.resolveSessionImageModel(session);
        return { reason, line, urlKey: viaUrl && viaUrl.key, urlKind: viaUrl && viaUrl.source.kind, builtin };
    }, { PKG_PORT });
    check(r4.reason && /not loaded/.test(r4.reason) && /Built-in weights as a package/.test(r4.reason), `an unloaded folder model is refused with the reason: "${r4.reason}"`);
    check(/not loaded/.test(r4.line), 'the ID Switches line says it is not loaded');
    check(r4.urlKey === r1.key && r4.urlKind === 'url', 'a URL model reloads by itself, the same key');
    check(r4.builtin === null, 'no choice = the built-in model');

    check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join(' | ') : ''}`);
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill(); pkgServer.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
