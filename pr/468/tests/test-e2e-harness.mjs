/**
 * test-e2e-harness.mjs — the e2e files' server (`tests/e2e/lib/harness.mjs`
 * `startServer`) must answer as Python's `http.server` did, and its CDN cache
 * must tell pinned URLs from ones that can change.
 *
 * Every Playwright file used to spawn `python3 -m http.server <fixed port>` and
 * sleep 1.2 s; they now serve the app from Node on a free port. The tests were
 * written against Python's answers, so §1 asks both servers the same questions
 * about the same tree and compares status, Content-Type and body (skipped when
 * there is no `python3`). The rest pins what the files rely on: free ports, a
 * loud failure on a taken `PORT=`, no escaping the root, never keeping the
 * process alive, CORS for a second origin, and the cache's URL rules.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, mimeTypeFor, resolveUrlPath, isPinnedUrl, CACHED_HOSTS } from './e2e/lib/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const check = (cond, msg, extra) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  ✗ FAIL ' + msg + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};
const section = (t) => console.log('\n' + t);

// A small tree with the kinds of files the app serves.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luc3d-harness-test-'));
const site = path.join(tmp, 'site');
const write = (rel, body) => { fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true }); fs.writeFileSync(path.join(site, rel), body); };
write('index.html', '<!doctype html><title>root</title>');
write('app.js', 'export const x = 1;\n');
write('mod.mjs', 'export default 2;\n');
write('styles.css', 'body{}\n');
write('data.json', '{"a":1}');
write('lib/h5wasm/hdf5.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
write('tests/fixtures/x.slp', Buffer.from([137, 72, 68, 70, 13, 10, 26, 10]));
write('calib/calibration.toml', '[cam_0]\nname = "a"\n');
write('videos/a.mp4', Buffer.alloc(64, 1));
write('with space/a b.txt', 'spaced');
write('nested/index.html', '<p>nested</p>');
write('listing/one.txt', '1');
write('listing/sub/two.txt', '2');
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside the root');

async function get(base, p, init) {
    const r = await fetch(base + p, { redirect: 'manual', ...init });
    const body = Buffer.from(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type'), location: r.headers.get('location'), body, headers: r.headers };
}

const portIsFree = (port) => new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
});

const PATHS = ['/', '/index.html', '/app.js', '/app.js?v=abc123', '/mod.mjs', '/styles.css', '/data.json',
    '/lib/h5wasm/hdf5.wasm', '/tests/fixtures/x.slp', '/calib/calibration.toml', '/videos/a.mp4',
    '/with%20space/a%20b.txt', '/nested', '/nested/', '/nested?x=1', '/missing.js', '/../secret.txt',
    '/%2e%2e/secret.txt', '/listing/'];

try {
    const server = await startServer(site);
    const base = server.url;

    // ------------------------------------------------------------------------
    section('1. Same answers as python3 -m http.server');
    const py = spawnSync('python3', ['--version']);
    if (py.status !== 0) {
        console.log('  (skipped: no python3)');
    } else {
        const pyPort = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
        const pyServer = spawn('python3', ['-m', 'http.server', String(pyPort)], { cwd: site, stdio: 'ignore' });
        try {
            const pyBase = `http://localhost:${pyPort}`;
            for (let i = 0; i < 100; i++) { try { await fetch(pyBase + '/'); break; } catch { await new Promise(r => setTimeout(r, 50)); } }
            for (const p of PATHS) {
                const [a, b] = [await get(base, p), await get(pyBase, p)];
                const sameBody = p === '/listing/' ? a.body.includes('two') === b.body.includes('two') : a.body.equals(b.body);
                // Python adds "; charset=utf-8" only to its listing page. Its type
                // for an extension the browser does not act on comes from the
                // machine's own mime.types (.toml: octet-stream on macOS,
                // application/toml on Ubuntu), so only the ones it acts on are
                // compared; §2 pins the rest.
                const typeOf = r => (r.type || '').split(';')[0];
                const typed = a.status !== 200 || /\.(m?js|wasm|css|html|json|mp4)(\?|$)|\/$/.test(p);
                check(a.status === b.status && (!typed || typeOf(a) === typeOf(b)) && (a.status !== 200 || sameBody) && a.location === b.location,
                    `${p}: ${a.status} ${typeOf(a) || '-'}${a.location ? ' -> ' + a.location : ''}`,
                    { node: [a.status, a.type, a.location], python: [b.status, b.type, b.location] });
            }
            const [a, b] = [await get(base, '/app.js', { method: 'HEAD' }), await get(pyBase, '/app.js', { method: 'HEAD' })];
            check(a.status === b.status && a.body.length === 0 && a.headers.get('content-length') === b.headers.get('content-length'),
                'HEAD: same status and Content-Length, no body');
            const [c, d] = [await get(base, '/app.js', { method: 'POST' }), await get(pyBase, '/app.js', { method: 'POST' })];
            check(c.status === d.status && c.status === 501, `POST: ${c.status}, as Python (${d.status})`);
            const lm = (await get(pyBase, '/app.js')).headers.get('last-modified');
            const [e, f] = [await get(base, '/app.js', { headers: { 'if-modified-since': lm } }), await get(pyBase, '/app.js', { headers: { 'if-modified-since': lm } })];
            check(e.status === 304 && f.status === 304, `If-Modified-Since: 304 (Python ${f.status})`);
            check((await get(base, '/app.js')).headers.get('last-modified') === lm, 'the same Last-Modified');
        } finally { pyServer.kill(); }
    }

    // ------------------------------------------------------------------------
    section('2. What the e2e files rely on');
    check((await get(base, '/app.js')).type === 'text/javascript', 'a module script is text/javascript (Chromium refuses octet-stream)');
    check((await get(base, '/lib/h5wasm/hdf5.wasm')).type === 'application/wasm', '.wasm is application/wasm (streaming compile needs it)');
    check((await get(base, '/app.js?v=abc123')).body.toString() === 'export const x = 1;\n', 'a stamped ?v= URL serves the file');
    check((await get(base, '/%2e%2e/secret.txt')).status === 404 && (await get(base, '/../secret.txt')).status === 404,
        'no way out of the root');
    check((await get(base, '/nested')).location === '/nested/', 'a directory without its slash redirects to it');
    check(mimeTypeFor('x.SLP') === 'application/octet-stream' && mimeTypeFor('c.toml') === 'application/octet-stream' && mimeTypeFor('a.H5') === 'application/x-hdf5',
        'unknown types (.slp, .toml) are octet-stream on every machine; case does not matter');
    check(resolveUrlPath(site, '/a/%ZZ') === null, 'a malformed escape is refused, not thrown');

    // ------------------------------------------------------------------------
    section('3. Ports');
    const s2 = await startServer(site, { port: 0 });
    check(s2.port !== server.port && s2.port > 0, `two servers get two free ports (${server.port}, ${s2.port})`);
    let err = null;
    try { await startServer(site, { port: s2.port }); } catch (e) { err = e; }
    check(err && /already in use/.test(err.message), 'a taken port fails loudly, never serves another tree', err && err.message);
    process.env.PORT = String(s2.port);
    err = null;
    try { await startServer(site); } catch (e) { err = e; }
    delete process.env.PORT;
    check(err && /already in use/.test(err.message), 'so does a taken PORT=');
    const freed = s2.port;
    s2.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 50));
    check(await portIsFree(freed), 'kill() (as files call it) frees the port');

    // ------------------------------------------------------------------------
    section('4. A second origin (a model package server)');
    const seen = [];
    const pkg = await startServer(site, { port: 0, cors: true, onRequest: (req) => seen.push(req.method + ' ' + req.url) });
    const r1 = await get(pkg.url, '/data.json?x=1');
    check(r1.status === 200 && r1.headers.get('access-control-allow-origin') === '*', 'cors: every answer allows any origin');
    const r2 = await get(pkg.url, '/data.json', { method: 'OPTIONS' });
    check(r2.status === 204, 'a preflight gets 204');
    check(seen.join('|') === 'GET /data.json?x=1|OPTIONS /data.json', 'onRequest sees each request, query included', seen);
    check(!(await get(base, '/data.json')).headers.get('access-control-allow-origin'), 'without cors no CORS header (as Python)');
    pkg.close();

    // ------------------------------------------------------------------------
    section('5. The server never keeps a test alive');
    const harnessUrl = new URL('./e2e/lib/harness.mjs', import.meta.url).href;
    const t0 = Date.now();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const { startServer } = await import(${JSON.stringify(harnessUrl)}); await startServer(${JSON.stringify(site)}); console.log('started');`],
        { encoding: 'utf8', timeout: 10000 });
    check(child.status === 0 && child.stdout.includes('started') && Date.now() - t0 < 5000,
        `a script that starts a server and never stops it still exits (${Date.now() - t0} ms)`, child.stderr);

    // ------------------------------------------------------------------------
    section('6. CDN cache: which URLs, and which are pinned');
    const pinned = [
        'https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js',
        'https://cdn.jsdelivr.net/npm/yaml@2.8.0/+esm',
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm',
        'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/webgpu/+esm',
        'https://huggingface.co/org/model/resolve/0123456789abcdef0123456789abcdef01234567/onnx/model.onnx',
    ];
    const notPinned = [
        'https://cdn.jsdelivr.net/npm/onnxruntime-common/+esm',
        'https://cdn.jsdelivr.net/npm/left-pad@latest/index.js',
        'https://cdn.jsdelivr.net/npm/left-pad@1.3/index.js',   // (not a package offline-deps.json pins: its check reads every such URL)
        'https://huggingface.co/org/model/resolve/main/onnx/model.onnx',
    ];
    check(pinned.every(isPinnedUrl), 'exact versions and commit revisions are pinned', pinned.filter(u => !isPinnedUrl(u)));
    check(!notPinned.some(isPinnedUrl), 'no version, a range, a tag or a branch is not (checked before reuse)', notPinned.filter(isPinnedUrl));
    const hosts = ['https://cdn.jsdelivr.net/npm/x@1.0.0/a.js', 'https://huggingface.co/a/b/resolve/main/c', 'https://cas-bridge.xethub.hf.co/x', 'https://unpkg.com/mp4box@0.5.4/x.js'];
    check(hosts.every(u => CACHED_HOSTS.test(u)), 'the CDN and model hosts go through the cache');
    check(!['http://localhost:8080/index.html', 'https://example.com/cdn.jsdelivr.net/x', 'http://cdn.jsdelivr.net/npm/x@1.0.0/a.js']
        .some(u => CACHED_HOSTS.test(u)), 'nothing else does (the app, other hosts, plain http)');

    server.close();
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
