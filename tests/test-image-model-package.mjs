/**
 * test-image-model-package.mjs — image-model packages for the image ID-switch
 * check: the manifest (pose/image-model-manifest.js), loading a package from a
 * folder's files (ui/image-model-package.js: hashes, the key, refusals), the
 * transformers.js fetch hook that serves its files, and the saved choice.
 *
 * Run:  node tests/test-image-model-package.mjs
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const M = await import(pathToFileURL(path.join(ROOT, 'pose', 'image-model-manifest.js')).href);
const P = await import(pathToFileURL(path.join(ROOT, 'ui', 'image-model-package.js')).href);

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error('  ✗ ' + m); } }
function eq(a, e, m) { ok(a === e, `${m} (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`); }
function group(n) { console.log('\n• ' + n); }

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const BASE = { format: 'lucid-image-model', version: 1, name: 'SLAP fine-tune', base: 'facebook/dinov2-small', license: 'Apache-2.0',
    input: 168, crop: 160, threshold: -1, fp16: false };

group('parseModelManifest');
{
    const r = M.parseModelManifest(JSON.stringify(BASE), 160);
    ok(r.ok, 'a valid manifest parses');
    eq(r.manifest.input, 168, 'input kept');
    eq(r.manifest.fp16, false, 'fp16 false');
    const bad = (patch, crop, what) => {
        const x = M.parseModelManifest(Object.assign({}, BASE, patch), crop == null ? 160 : crop);
        ok(!x.ok && typeof x.error === 'string', what + ' is refused (' + (x.error || 'accepted') + ')');
    };
    bad({ format: 'other' }, null, 'another format');
    bad({ version: 2 }, null, 'version 2');
    bad({ name: '' }, null, 'no name');
    bad({ input: 170 }, null, 'input not a multiple of 14 or 16');
    bad({ input: 1024 }, null, 'input too large');
    bad({ crop: 224 }, null, 'a crop the app does not cut');
    bad({ threshold: 1 }, null, 'a positive threshold');
    bad({ threshold: 'x' }, null, 'a non-number threshold');
    bad({ sha256: { 'onnx/model.onnx': 'abc' } }, null, 'a malformed hash');
    ok(!M.parseModelManifest('{', 160).ok, 'bad JSON is refused');
    ok(M.validModelInput(192) && M.validModelInput(224) && M.validModelInput(168) && !M.validModelInput(100), 'validModelInput');
    bad({ cropRule: 0 }, null, 'crop rule 0');
    bad({ cropRule: 1.5 }, null, 'a fractional crop rule');
    eq(r.manifest.cropRule, 1, 'no cropRule: rule 1 (written before the field)');
    eq(M.parseModelManifest(Object.assign({}, BASE, { cropRule: 2 }), 160).manifest.cropRule, 2, 'cropRule kept');
    eq(M.modelKeyMaterial(M.parseModelManifest(Object.assign({}, BASE, { cropRule: 2 }), 160).manifest, {}),
        M.modelKeyMaterial(r.manifest, {}), 'cropRule is not part of the model key (adding it to an old manifest keeps its key)');
}

group('cropRuleDiffers: an older package on a skeleton the rules cut differently');
{
    const T_TAIL = ['nose', 'head', 'ear_left', 'ear_right', 'trunk', 'tti', 'tail_tip', 't0', 't1', 't2', 'neck'];
    const SLAP = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2'];
    eq(M.CROP_RULE, 2, 'this LUCID cuts by rule 2');
    eq(M.cropRuleDiffers(1, T_TAIL), true, 'rule 1 on a skeleton naming tail segments t0, t1…: different crops');
    eq(M.cropRuleDiffers(2, T_TAIL), false, 'rule 2 on it: the same');
    eq(M.cropRuleDiffers(1, SLAP), false, 'rule 1 on a skeleton whose tail is named tail…: the same crops');
    eq(M.cropRuleDiffers(1, []), false, 'no skeleton: nothing to say');
    eq(M.cropRuleDiffers(3, SLAP), true, 'a newer rule than this LUCID\'s: taken to differ on any skeleton');
}

group('packageBaseUrl');
{
    eq(M.packageBaseUrl('olinesn/my-model'), 'https://huggingface.co/olinesn/my-model/resolve/main/', 'a Hugging Face repo id');
    eq(M.packageBaseUrl('https://lab.example/models/rig1'), 'https://lab.example/models/rig1/', 'an https folder gains its slash');
    eq(M.packageBaseUrl('https://lab.example/models/rig1/lucid-model.json'), 'https://lab.example/models/rig1/', 'the manifest URL itself');
    eq(M.packageBaseUrl('http://localhost:8080/pkg'), 'http://localhost:8080/pkg/', 'http on localhost');
    eq(M.packageBaseUrl('http://lab.example/pkg'), null, 'plain http elsewhere is refused');
    eq(M.packageBaseUrl('ftp://x/y'), null, 'other schemes are refused');
}

/** A File the way <input webkitdirectory> gives it: with its path inside the picked folder. */
function file(rel, content) {
    const f = new File([content], rel.split('/').pop());
    Object.defineProperty(f, 'webkitRelativePath', { value: rel });
    return f;
}
const W32 = new Uint8Array(4096).map((_, i) => (i * 7 + 3) & 255), W16 = new Uint8Array(2048).map((_, i) => (i * 5 + 1) & 255);
function folder(manifest, extra) {
    const files = [file('pkg/lucid-model.json', JSON.stringify(manifest)), file('pkg/config.json', '{"model_type":"dinov2"}'),
        file('pkg/onnx/model.onnx', W32), file('pkg/onnx/model_quantized.onnx', new Uint8Array(10))];
    return files.concat(extra || []);
}

group('loadModelPackageFromFiles');
{
    P.clearModelPackages();
    const pkg = await P.loadModelPackageFromFiles(folder(BASE));
    eq(pkg.name, 'SLAP fine-tune', 'name');
    eq(pkg.input, 168, 'input');
    eq(pkg.threshold, -1, 'threshold');
    eq(pkg.id, 'lucid-pkg/' + pkg.key.slice(0, 16), 'repo id from the key');
    ok(/^[0-9a-f]{64}$/.test(pkg.key), 'the key is a SHA-256');
    eq(pkg.source.folder, 'pkg', 'the folder name is kept');
    ok(!('onnx/model_quantized.onnx' in pkg.source.files), 'weights the app never loads are not kept');
    eq(P.registeredModelPackage(pkg.key), pkg, 'registered under its key');
    const expectKey = sha(M.modelKeyMaterial(M.parseModelManifest(BASE, 160).manifest, { 'onnx/model.onnx': sha(W32) }));
    eq(pkg.key, expectKey, 'key = SHA-256 of the key material');

    const renamed = await P.loadModelPackageFromFiles(folder(Object.assign({}, BASE, { name: 'Renamed' })));
    eq(renamed.key, pkg.key, 'renaming the model keeps its key (same model)');
    const otherW = folder(BASE); otherW[2] = file('pkg/onnx/model.onnx', W16);
    ok((await P.loadModelPackageFromFiles(otherW)).key !== pkg.key, 'other weights, another key');
    ok((await P.loadModelPackageFromFiles(folder(Object.assign({}, BASE, { input: 224 })))).key !== pkg.key, 'another input side, another key');

    const declared = await P.loadModelPackageFromFiles(folder(Object.assign({}, BASE, { sha256: { 'onnx/model.onnx': sha(W32) } })));
    eq(declared.key, pkg.key, 'a correct declared hash loads, same key');
    let err = null;
    try { await P.loadModelPackageFromFiles(folder(Object.assign({}, BASE, { sha256: { 'onnx/model.onnx': sha(W16) } }))); } catch (e) { err = e; }
    ok(err && /does not match the SHA-256/.test(err.message), 'a wrong declared hash is refused: ' + (err && err.message));

    const noFp16 = await P.loadModelPackageFromFiles(folder(Object.assign({}, BASE, { fp16: true })));
    eq(noFp16.fp16, false, 'fp16 claimed without model_fp16.onnx falls back to fp32');
    const withFp16 = await P.loadModelPackageFromFiles(folder(Object.assign({}, BASE, { fp16: true }), [file('pkg/onnx/model_fp16.onnx', W16)]));
    eq(withFp16.fp16, true, 'fp16 with its file');
    ok(withFp16.key !== pkg.key, 'fp16 on is another key');
    ok('onnx/model_fp16.onnx' in withFp16.source.files, 'the fp16 weights are served');

    const top = [file('lucid-model.json', JSON.stringify(BASE)), file('config.json', '{}'), file('onnx/model.onnx', W32)];
    eq((await P.loadModelPackageFromFiles(top)).key, pkg.key, 'a manifest at the top level works too');
    for (const [files, what] of [[[file('pkg/config.json', '{}')], 'no manifest'],
                                 [[file('pkg/lucid-model.json', JSON.stringify(BASE)), file('pkg/config.json', '{}')], 'no weights'],
                                 [folder(Object.assign({}, BASE, { crop: 192 })), 'a wrong crop']]) {
        let e2 = null;
        try { await P.loadModelPackageFromFiles(files); } catch (e) { e2 = e; }
        ok(!!e2, what + ' is refused: ' + (e2 && e2.message));
    }
}

group('the transformers.js fetch hook');
{
    P.clearModelPackages();
    const pkg = await P.loadModelPackageFromFiles(folder(BASE));
    const calls = [];
    const T = { env: { fetch: async (u) => { calls.push(String(u)); return new Response('net', { status: 200 }); }, useBrowserCache: true } };
    P.installModelPackageFetch(T);
    P.installModelPackageFetch(T);                        // twice: still one wrapper
    const url = (p) => 'https://huggingface.co/' + pkg.id + '/resolve/main/' + p;
    const r = await T.env.fetch(url('onnx/model.onnx'));
    eq(r.status, 200, 'a package file is served');
    eq(r.headers.get('content-length'), String(W32.length), 'with its length');
    const got = new Uint8Array(await r.arrayBuffer());
    ok(got.length === W32.length && got.every((v, i) => v === W32[i]), 'the bytes are the file');
    eq((await T.env.fetch(url('generation_config.json'))).status, 404, 'a file the package lacks is a 404, not a network request');
    eq(calls.length, 0, 'no network for the package');
    await T.env.fetch('https://huggingface.co/olinesn/dinov3-vits16-lucid/resolve/main/onnx/model_fp16.onnx');
    eq(calls.length, 1, 'other URLs go to the original fetch');
    eq(JSON.stringify(P.packageFileOf(url('onnx/model.onnx'))), JSON.stringify({ repo: pkg.id, path: 'onnx/model.onnx' }), 'packageFileOf');
    eq(P.packageFileOf('https://huggingface.co/olinesn/x/resolve/main/a'), null, 'not a package URL');
    let during = null;
    await P.withPackageCachePolicy(T, pkg, async () => { during = T.env.useBrowserCache; });
    eq(during, false, 'browser cache off while a local package loads');
    eq(T.env.useBrowserCache, true, 'and back on after');
    const tr = P.modelPackageTransfer(pkg);
    eq(tr.repo, pkg.id, 'transfer: repo id');
    eq(tr.source.kind, 'files', 'transfer: its files');
    eq(P.modelPackageTransfer({ builtin: true }), null, 'no transfer for the built-in model');
}

group('a URL package\'s downloads are checked against its manifest');
{
    P.clearModelPackages();
    const W = new Uint8Array(200000).map((_, i) => (i * 31 + 7) & 255);   // the weights the manifest names
    const BAD = W.slice(); BAD[123456] ^= 1;                              // one bit changed
    const CFG = new TextEncoder().encode('{"model_type":"dinov2"}');
    const manifest = Object.assign({}, BASE, { sha256: { 'onnx/model.onnx': sha(W) } });
    const realFetch = globalThis.fetch;
    let serve = W, served = [];
    globalThis.fetch = async (u) => {                                     // the package's server (the manifest)
        if (String(u).endsWith('lucid-model.json')) return new Response(JSON.stringify(manifest), { status: 200 });
        return new Response('', { status: 404 });
    };
    const pkg = await P.loadModelPackageFromUrl('https://models.example/rig1/');
    globalThis.fetch = realFetch;
    // transformers.js's fetch, as the network answers: the weights (in 7 chunks, as a download arrives), config, a Range read
    const chunked = (bytes, headers) => new Response(new ReadableStream({
        start(c) { for (let i = 0; i < bytes.length; i += 30000) c.enqueue(bytes.slice(i, i + 30000)); c.close(); } }), { status: 200, headers });
    const T = { env: { useBrowserCache: true, fetch: async (u, init) => {
        served.push(String(u));
        if (init && init.headers && init.headers.Range) return new Response(serve.slice(0, 1), { status: 206, headers: { 'content-range': 'bytes 0-0/' + serve.length } });
        if (String(u).endsWith('config.json')) return new Response(CFG, { status: 200 });
        return chunked(serve, { 'content-length': String(serve.length) });
    } } };
    P.installModelPackageFetch(T);
    const url = (p) => 'https://huggingface.co/' + pkg.id + '/resolve/main/' + p;
    const read = async (r) => { const rd = r.body.getReader(); const got = []; let n = 0;   // as readResponse does
        for (;;) { const { done, value } = await rd.read(); if (done) break; got.push(value); n += value.length; }
        return { n, bytes: new Uint8Array(await new Blob(got).arrayBuffer()) }; };

    const good = await read(await T.env.fetch(url('onnx/model.onnx')));
    ok(good.n === W.length && good.bytes.every((v, i) => v === W[i]), 'the right weights pass through unchanged, chunk by chunk');
    eq(served[0], 'https://models.example/rig1/onnx/model.onnx', 'fetched from the package\'s own URL');

    serve = BAD;
    let err = null;
    try { await read(await T.env.fetch(url('onnx/model.onnx'))); } catch (e) { err = e; }
    ok(!!err && /does not match the SHA-256 in lucid-model\.json/.test(err.message), 'weights that differ by one bit fail the read: ' + (err && err.message));
    err = null;
    try { await (await T.env.fetch(url('onnx/model.onnx'))).arrayBuffer(); } catch (e) { err = e; }
    ok(!!err, '…also read whole (arrayBuffer), as transformers.js does without a progress callback');
    // a compressed transfer: the body is longer than content-length says
    serve = W;
    const T2 = { env: { useBrowserCache: true, fetch: async () => chunked(W, { 'content-length': '1000' }) } };
    P.installModelPackageFetch(T2);
    const comp = await read(await T2.env.fetch(url('onnx/model.onnx')));
    ok(comp.n === W.length, 'a body longer than its content-length is still checked whole, and passes');
    serve = BAD;
    const partial = await T.env.fetch(url('onnx/model.onnx'), { headers: { Range: 'bytes=0-0' } });
    eq(partial.status, 206, 'a Range read (a 206, not the whole file) is left alone');
    const cfg = await read(await T.env.fetch(url('config.json')));
    ok(cfg.n === CFG.length, 'a file with no SHA-256 in the manifest passes unchecked');
    eq(P.verifiedResponse(new Response('x', { status: 404 }), sha(W), 'onnx/model.onnx', 'b').status, 404, 'an error status passes as it is');
    // the CPU workers get the hashes too
    const tr = P.modelPackageTransfer(pkg);
    eq(tr.source.kind, 'url', 'transfer: a URL package');
    eq(tr.source.sha256['onnx/model.onnx'], sha(W), 'transfer: carries the SHA-256 for the worker\'s own hook');
    // a worker realm: serve from the transfer alone
    P.clearModelPackages();
    P.serveModelPackage(tr.repo, tr.source);
    err = null;
    try { await read(await T.env.fetch(url('onnx/model.onnx'))); } catch (e) { err = e; }
    ok(!!err, 'a worker serving from the transfer checks too (tampered weights fail)');

    group('…and copies already in the browser cache');
    P.clearModelPackages();
    globalThis.fetch = async (u) => String(u).endsWith('lucid-model.json') ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response('', { status: 404 });
    const pkg2 = await P.loadModelPackageFromUrl('https://models.example/rig1/');
    globalThis.fetch = realFetch;
    const store = new Map(), opened = [], deletes = [];
    let reads = 0;
    globalThis.caches = { open: async (name) => { opened.push(name); return {
        match: async (u) => { if (!store.has(u)) return undefined; reads++; return new Response(store.get(u)); },
        delete: async (u) => { deletes.push(u); return store.delete(u); } }; } };
    const cacheUrl = P.packageCacheUrl(null, pkg2.id, 'onnx/model.onnx');
    eq(cacheUrl, 'https://huggingface.co/' + pkg2.id + '/resolve/main/onnx/model.onnx', 'the cache key is transformers.js\'s remote URL for the file');
    store.set(cacheUrl, BAD);
    const del = await P.checkCachedPackageFiles(null, pkg2);
    ok(JSON.stringify(del) === JSON.stringify(['onnx/model.onnx']) && !store.has(cacheUrl) && opened[0] === 'transformers-cache',
       'a wrong cached copy (cached before this check existed) is deleted, so it is downloaded again (' + JSON.stringify(del) + ')');
    store.set(cacheUrl, W);
    reads = 0;
    eq((await P.checkCachedPackageFiles(null, pkg2)).length, 0, 'a right cached copy is kept');
    const r1 = reads;
    await P.checkCachedPackageFiles(null, pkg2);
    ok(r1 === 1 && reads === 1, 'and is read once per page, not on every load (' + reads + ' reads)');
    let loaded = false;
    store.set(cacheUrl, BAD); P.clearModelPackages();
    globalThis.fetch = async (u) => String(u).endsWith('lucid-model.json') ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response('', { status: 404 });
    const pkg3 = await P.loadModelPackageFromUrl('https://models.example/rig1/');
    globalThis.fetch = realFetch;
    await P.withPackageCachePolicy(T, pkg3, async () => { loaded = !store.has(cacheUrl); });
    ok(loaded, 'withPackageCachePolicy checks the cache before the load starts');
    deletes.length = 0;
    const folderPkg = await P.loadModelPackageFromFiles(folder(BASE));
    eq((await P.checkCachedPackageFiles(null, folderPkg)).length + deletes.length, 0, 'a folder package is not looked up in the cache');
    delete globalThis.caches;
    eq((await P.checkCachedPackageFiles(null, pkg3)).length, 0, 'no Cache Storage (Node, a private window): nothing to check');
}

group('the saved choice');
{
    P.clearModelPackages();
    const pkg = await P.loadModelPackageFromFiles(folder(BASE));
    const c = M.modelChoiceOf(pkg);
    eq(JSON.stringify(Object.keys(c).sort()), JSON.stringify(['folder', 'input', 'key', 'name', 'threshold']), 'a folder package saves key, name, input, threshold, folder');
    eq(JSON.stringify(M.ingestModelChoice(JSON.parse(JSON.stringify(c)))), JSON.stringify(c), 'round trip');
    eq(M.ingestModelChoice(null), null, 'absent = built-in');
    eq(M.ingestModelChoice({ key: 'short', input: 168, threshold: -1 }), null, 'a malformed key = built-in');
    eq(M.ingestModelChoice(Object.assign({}, c, { input: 7 })), null, 'a bad input = built-in');
    const u = M.ingestModelChoice(Object.assign({}, c, { url: 'javascript:alert(1)' }));
    ok(u && !('url' in u), 'a non-web URL is dropped');
    eq(M.modelChoiceOf(null), null, 'no package, no choice');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
