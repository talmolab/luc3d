/**
 * test-server-revalidation.mjs — server.py must never let a browser keep a cached
 * copy that differs from the file on disk.
 *
 * The stdlib's SimpleHTTPRequestHandler answers If-Modified-Since with 304
 * whenever the file is NOT NEWER than the browser's date. When the file behind a
 * URL gets OLDER (checking out an older branch, or another worktree having served
 * the same localhost:8080 URL with newer files) the browser keeps its newer copy
 * forever: on 2026-11-25 the desktop app's shared WKWebView cache handed one
 * checkout another branch's ui/rendering.js, whose import 404'd, and the app hung
 * on "Initializing...". server.py revalidates by exact ETag only.
 *
 *   1. a plain file: 200 + strong ETag + Cache-Control: no-cache + exact
 *      Content-Length; 304 (same ETag) on a matching If-None-Match; HEAD agrees;
 *      a directory's index.html too
 *   2. the reproduction: the file is replaced by DIFFERENT bytes of the SAME size
 *      with an OLDER mtime (in place, and by rename like a checkout) -> 200 with
 *      the new body for the old ETag, for an If-Modified-Since newer than the
 *      file, and for both; the new ETag then validates
 *   3. keep-alive: one socket carries 200s, 304s and HEADs back to back
 *   4. the --offline rewritten body: its ETag is the hash of the bytes sent, so it
 *      validates itself, not the CDN body served online (nor the reverse), and an
 *      older replacement still gets a 200
 *
 * Runs server.py with a temp directory as its cwd (what it serves). The offline
 * case runs server.main([port, '--offline']) with only the lib/ install check
 * replaced, so it needs no `offline_deps.py install`.
 *
 * Run:  node tests/test-server-revalidation.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.platform === 'win32' ? 'py' : 'python3';

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function group(n) { console.log('\n• ' + n); }

const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function request(port, method, urlPath, headers = {}, agent = false) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode, headers: res.headers,
                body: Buffer.concat(chunks), reused: req.reusedSocket,
            }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(10000, () => req.destroy(new Error(`${method} ${urlPath} timed out`)));
        req.end();
    });
}

function launch(args, root) {
    const proc = spawn(PY, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.log = '';
    proc.stdout.on('data', d => { proc.log += d; });
    proc.stderr.on('data', d => { proc.log += d; });
    return proc;
}

async function waitUp(port, proc) {
    for (let i = 0; i < 150; i++) {
        if (proc.exitCode !== null) break;
        try { await request(port, 'GET', '/index.html'); return true; }
        catch { await new Promise(r => setTimeout(r, 100)); }
    }
    console.error(`server on port ${port} never came up:\n${proc.log}`);
    return false;
}

const isStrongEtag = (t) => typeof t === 'string' && /^"[^"]+"$/.test(t);
const setOld = (p) => { const t = new Date('2020-01-01T00:00:00Z'); fs.utimesSync(p, t, t); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-server-reval-'));
const file = (name) => path.join(tmp, name);

// A CDN URL the offline rewrite maps, read from the manifest so a version bump
// does not break this test.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'offline-deps.json'), 'utf8'));
const [cdnUrl, localPath] = Object.values(manifest.packages)
    .flatMap(p => Object.entries(p.replaces || {}))[0];

const A = "export const v = 'AAAA';\n";
const B = "export const v = 'BBBB';\n";          // same length as A: size cannot tell them apart
fs.writeFileSync(file('index.html'), '<!doctype html><title>t</title>\n');
fs.writeFileSync(file('mod.js'), A);
fs.writeFileSync(file('moved.js'), A);
fs.writeFileSync(file('cdn.js'), `import '${cdnUrl}';\n${A}`);

const procs = [];
try {
    const port = await freePort();
    const online = launch([path.join(ROOT, 'server.py'), String(port)], tmp);
    procs.push(online);

    // --offline without the lib/ install check: everything else is main()'s.
    const offlinePort = await freePort();
    const harness = [
        'import sys',
        'sys.path.insert(0, sys.argv[1])',
        'import server',
        'od = server.offline_deps',
        'server.enable_offline = lambda: od.replacement_map(od.load_manifest())',
        'sys.exit(server.main([sys.argv[2], "--offline"]))',
    ].join('\n');
    const offline = launch(['-c', harness, ROOT, String(offlinePort)], tmp);
    procs.push(offline);

    if (!(await waitUp(port, online)) || !(await waitUp(offlinePort, offline))) {
        ok(false, 'servers start');
        throw new Error('servers did not start');
    }

    group('1. plain file: strong ETag, 304 only on a matching If-None-Match');
    const r1 = await request(port, 'GET', '/mod.js');
    const etag1 = r1.headers.etag;
    const lastMod1 = r1.headers['last-modified'];
    ok(r1.status === 200, `GET 200 (got ${r1.status})`);
    ok(r1.body.toString() === A, 'GET body is the file');
    ok(isStrongEtag(etag1), `GET carries a strong ETag (got ${etag1})`);
    ok(r1.headers['cache-control'] === 'no-cache', `Cache-Control: no-cache (got ${r1.headers['cache-control']})`);
    ok(Number(r1.headers['content-length']) === r1.body.length, 'Content-Length is the body length');

    const r2 = await request(port, 'GET', '/mod.js', { 'If-None-Match': etag1 });
    ok(r2.status === 304, `matching If-None-Match -> 304 (got ${r2.status})`);
    ok(r2.body.length === 0, '304 has no body');
    ok(r2.headers.etag === etag1, '304 repeats the ETag');
    ok(r2.headers['cache-control'] === 'no-cache', '304 keeps Cache-Control: no-cache');

    const r3 = await request(port, 'GET', '/mod.js', { 'If-None-Match': `"nope", ${etag1}` });
    ok(r3.status === 304, `an If-None-Match list containing the ETag -> 304 (got ${r3.status})`);
    const r4 = await request(port, 'GET', '/mod.js', { 'If-None-Match': `W/${etag1}` });
    ok(r4.status === 200, `a weak W/ form of the ETag is not an exact match -> 200 (got ${r4.status})`);
    const r5 = await request(port, 'GET', '/mod.js', { 'If-None-Match': '"something-else"' });
    ok(r5.status === 200 && r5.body.toString() === A, `a different ETag -> 200 + body (got ${r5.status})`);

    const h1 = await request(port, 'HEAD', '/mod.js');
    ok(h1.status === 200 && h1.body.length === 0, `HEAD 200, no body (got ${h1.status})`);
    ok(h1.headers.etag === etag1, 'HEAD has the same ETag');
    ok(Number(h1.headers['content-length']) === Buffer.byteLength(A), 'HEAD has the file\'s Content-Length');
    const h2 = await request(port, 'HEAD', '/mod.js', { 'If-None-Match': etag1 });
    ok(h2.status === 304, `HEAD with matching If-None-Match -> 304 (got ${h2.status})`);

    const d1 = await request(port, 'GET', '/');
    ok(d1.status === 200 && isStrongEtag(d1.headers.etag), `GET / serves index.html with an ETag (${d1.status}, ${d1.headers.etag})`);
    const d2 = await request(port, 'GET', '/', { 'If-None-Match': d1.headers.etag });
    ok(d2.status === 304, `GET / with its ETag -> 304 (got ${d2.status})`);

    const m0 = await request(port, 'GET', '/moved.js');
    ok(m0.status === 200 && isStrongEtag(m0.headers.etag), 'GET /moved.js 200 with an ETag');

    group('2. a different file with an OLDER mtime is never answered 304');
    // In place: same inode, same size; only the bytes and an older mtime differ.
    fs.writeFileSync(file('mod.js'), B);
    setOld(file('mod.js'));
    // By rename, the way a checkout replaces a file.
    fs.writeFileSync(file('moved.js.tmp'), B);
    setOld(file('moved.js.tmp'));
    fs.renameSync(file('moved.js.tmp'), file('moved.js'));

    const s1 = await request(port, 'GET', '/mod.js', { 'If-None-Match': etag1 });
    ok(s1.status === 200, `old ETag -> 200 (got ${s1.status})`);
    ok(s1.body.toString() === B, 'old ETag -> the NEW body');
    ok(isStrongEtag(s1.headers.etag) && s1.headers.etag !== etag1, `a new ETag (${s1.headers.etag} vs ${etag1})`);

    const s2 = await request(port, 'GET', '/mod.js', { 'If-Modified-Since': lastMod1 });
    ok(s2.status === 200, `If-Modified-Since newer than the file -> 200, not 304 (got ${s2.status})`);
    ok(s2.body.toString() === B, 'If-Modified-Since newer than the file -> the NEW body');

    const s3 = await request(port, 'GET', '/mod.js', { 'If-None-Match': etag1, 'If-Modified-Since': lastMod1 });
    ok(s3.status === 200 && s3.body.toString() === B, `old ETag + newer If-Modified-Since -> 200 + new body (got ${s3.status})`);

    const future = new Date(Date.now() + 365 * 86400e3).toUTCString();
    const s4 = await request(port, 'GET', '/mod.js', { 'If-Modified-Since': future });
    ok(s4.status === 200, `If-Modified-Since alone never 304s, even in the future (got ${s4.status})`);

    const s5 = await request(port, 'GET', '/mod.js', { 'If-None-Match': s1.headers.etag });
    ok(s5.status === 304, `the new ETag validates (got ${s5.status})`);

    const s6 = await request(port, 'GET', '/moved.js', { 'If-None-Match': m0.headers.etag, 'If-Modified-Since': m0.headers['last-modified'] });
    ok(s6.status === 200 && s6.body.toString() === B, `renamed-over older file -> 200 + new body (got ${s6.status})`);

    group('3. keep-alive: one socket carries 200, 304 and HEAD back to back');
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const seq = [
        ['GET', '/mod.js', {}],
        ['GET', '/mod.js', { 'If-None-Match': s1.headers.etag }],
        ['HEAD', '/mod.js', {}],
        ['GET', '/mod.js', { 'If-Modified-Since': future }],
        ['GET', '/moved.js', { 'If-None-Match': s6.headers.etag }],
        ['GET', '/index.html', {}],
    ];
    const got = [];
    for (const [m, p, h] of seq) got.push(await request(port, m, p, h, agent));
    agent.destroy();
    ok(got.map(g => g.status).join() === '200,304,200,200,304,200',
        `statuses on one connection (got ${got.map(g => g.status).join()})`);
    ok(got.slice(1).every(g => g.reused), 'every request after the first reused the socket');
    ok(got[3].body.toString() === B, 'the body after a 304 and a HEAD is intact');

    group('4. --offline rewritten body: ETag of the bytes sent');
    const o1 = await request(offlinePort, 'GET', '/cdn.js');
    const oBody = o1.body.toString();
    ok(o1.status === 200, `GET 200 (got ${o1.status})`);
    ok(oBody.includes(`./${localPath}`) && !oBody.includes(cdnUrl), 'the body is rewritten to lib/');
    ok(Number(o1.headers['content-length']) === o1.body.length, 'Content-Length is the rewritten body length');
    ok(isStrongEtag(o1.headers.etag), `strong ETag (got ${o1.headers.etag})`);
    ok(o1.headers['cache-control'] === 'no-cache', 'Cache-Control: no-cache');

    const o2 = await request(offlinePort, 'GET', '/cdn.js', { 'If-None-Match': o1.headers.etag });
    ok(o2.status === 304 && o2.headers.etag === o1.headers.etag, `matching If-None-Match -> 304 (got ${o2.status})`);
    const oh = await request(offlinePort, 'HEAD', '/cdn.js');
    ok(oh.status === 200 && oh.body.length === 0 && oh.headers.etag === o1.headers.etag
        && Number(oh.headers['content-length']) === o1.body.length, 'HEAD agrees with GET');

    // Toggling --offline changes the body but not the file: neither mode's ETag
    // may validate the other's body.
    const n1 = await request(port, 'GET', '/cdn.js');
    ok(n1.body.toString().includes(cdnUrl), 'online serves the CDN URL');
    ok(n1.headers.etag !== o1.headers.etag, 'online and offline ETags differ');
    const x1 = await request(offlinePort, 'GET', '/cdn.js', { 'If-None-Match': n1.headers.etag, 'If-Modified-Since': future });
    ok(x1.status === 200 && x1.body.toString() === oBody, `online ETag -> offline 200 + rewritten body (got ${x1.status})`);
    const x2 = await request(port, 'GET', '/cdn.js', { 'If-None-Match': o1.headers.etag, 'If-Modified-Since': future });
    ok(x2.status === 200 && x2.body.toString().includes(cdnUrl), `offline ETag -> online 200 + CDN body (got ${x2.status})`);

    fs.writeFileSync(file('cdn.js'), `import '${cdnUrl}';\n${B}`);
    setOld(file('cdn.js'));
    const o3 = await request(offlinePort, 'GET', '/cdn.js', { 'If-None-Match': o1.headers.etag, 'If-Modified-Since': o1.headers['last-modified'] });
    ok(o3.status === 200 && o3.body.toString().includes("'BBBB'"), `older replacement -> 200 + new body (got ${o3.status})`);
    ok(o3.headers.etag !== o1.headers.etag, 'and a new ETag');

    const kagent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const k = [];
    k.push(await request(offlinePort, 'GET', '/cdn.js', {}, kagent));
    k.push(await request(offlinePort, 'GET', '/cdn.js', { 'If-None-Match': o3.headers.etag }, kagent));
    k.push(await request(offlinePort, 'HEAD', '/cdn.js', {}, kagent));
    k.push(await request(offlinePort, 'GET', '/mod.js', {}, kagent));
    kagent.destroy();
    ok(k.map(g => g.status).join() === '200,304,200,200' && k.slice(1).every(g => g.reused),
        `keep-alive on the rewritten path (${k.map(g => `${g.status}${g.reused ? 'r' : ''}`).join()})`);
} catch (e) {
    ok(false, `threw: ${e && e.stack || e}`);
} finally {
    for (const p of procs) p.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failed ? '✗ FAIL' : '✓ PASS'} — ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.error('  - ' + f.split('\n')[0]); process.exit(1); }
