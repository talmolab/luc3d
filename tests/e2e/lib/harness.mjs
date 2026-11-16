/**
 * harness.mjs — what every e2e file needs before its first check: a server for
 * the app and a browser.
 *
 * ## startServer(root)
 *
 * Serves `root` (default: the repo) from THIS process on a port the system
 * picks, and resolves once it is listening. It replaced
 *
 *     const server = spawn('python3', ['-m', 'http.server', String(PORT)], …);
 *     await new Promise(r => setTimeout(r, 1200));
 *
 * in every file, which cost three things:
 *   - 1.2 s of sleep per file (the server answers in ~0.09 s);
 *   - a fixed port per file: when another session's server already held it,
 *     the spawn failed silently and the test ran against THAT worktree's code;
 *   - a Python process that outlived a killed test and kept its port.
 * Here the port is free by construction (or `PORT=`, which fails loudly when
 * taken), and the server goes when the process does.
 *
 * It answers like Python's `http.server` (SimpleHTTPRequestHandler), which the
 * tests were written against: GET/HEAD only, the same MIME types, no Range
 * support, a trailing-slash redirect for directories, index.html or a listing,
 * Last-Modified / If-Modified-Since, and no Cache-Control.
 *
 * ## launchBrowser(options)
 *
 * `chromium.launch(options)`, plus a disk cache for the CDN and model hosts
 * (`CACHED_HOSTS`) on every context the browser makes. Each test starts with an
 * empty browser profile, so without it every page fetched three.js, mp4box,
 * dockview and yaml from jsdelivr again, and every image-check test downloaded
 * the model (the fp32 one is ~86 MB) from huggingface.co again; under load a
 * stalled CDN script also left the app unbooted ("THREE is not defined").
 * - A version-pinned URL (`pkg@1.2.3`, or a 40-hex Hugging Face revision) is
 *   served from disk as is.
 * - Any other URL (`resolve/main/…`) is checked with a HEAD request first and
 *   fetched again if its ETag changed, so a re-uploaded model is never stale.
 * - A test's own `route()` runs before this one (Playwright runs the newest
 *   handler first), so tests that block or stub the network still do.
 * `LUC3D_E2E_CDN_CACHE=0` turns it off; `LUC3D_E2E_CACHE=<dir>` moves it
 * (default: `<os tmpdir>/luc3d-e2e-cache`, shared by every worktree).
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ---------------------------------------------------------------------------
// Static server
// ---------------------------------------------------------------------------

// Python 3.12's answers for these (mimetypes + SimpleHTTPRequestHandler's own
// extensions_map); anything else is application/octet-stream, as there.
export const MIME_TYPES = {
    '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska', '.ts': 'video/mp2t', '.h5': 'application/x-hdf5',
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.xml': 'application/xml',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
    '.bz2': 'application/x-bzip2', '.xz': 'application/x-xz', '.py': 'text/x-python',
    '.sh': 'application/x-sh', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

export function mimeTypeFor(file) {
    return MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** The file a URL path names under `root`, or null when it would leave it. */
export function resolveUrlPath(root, urlPath) {
    let p = urlPath.split('?')[0].split('#')[0];
    try { p = decodeURIComponent(p); } catch { return null; }
    // Like Python's translate_path: drop empty, '.' and '..' parts.
    const parts = p.split('/').filter(s => s && s !== '.' && s !== '..');
    const file = path.join(root, ...parts);
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return { file, trailingSlash: p.endsWith('/') };
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Python's send_error page.
function sendError(req, res, code, message, explain) {
    const body = `<!DOCTYPE HTML>\n<html lang="en">\n    <head>\n        <meta charset="utf-8">\n        <title>Error response</title>\n    </head>\n`
        + `    <body>\n        <h1>Error response</h1>\n        <p>Error code: ${code}</p>\n        <p>Message: ${escapeHtml(message)}.</p>\n`
        + `        <p>Error code explanation: ${code} - ${escapeHtml(explain)}.</p>\n    </body>\n</html>\n`;
    res.writeHead(code, { 'Content-Type': 'text/html;charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
}
const notFound = (req, res) => sendError(req, res, 404, 'File not found', 'Nothing matches the given URI');

async function serveStatic(root, req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendError(req, res, 501, `Unsupported method ('${req.method}')`, 'Server does not support this operation');
    }
    const url = req.url || '/';
    const target = resolveUrlPath(root, url);
    if (!target) return notFound(req, res);
    let file = target.file;
    let st;
    try { st = await fsp.stat(file); } catch { return notFound(req, res); }
    if (st.isDirectory()) {
        if (!target.trailingSlash) {
            const [p, q] = url.split('?');
            res.writeHead(301, { Location: p + '/' + (q !== undefined ? '?' + q : ''), 'Content-Length': 0 });
            return res.end();
        }
        const index = path.join(file, 'index.html');
        try { st = await fsp.stat(index); file = index; } catch {
            const names = (await fsp.readdir(file, { withFileTypes: true }))
                .map(d => d.name + (d.isDirectory() ? '/' : '')).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            const body = '<!DOCTYPE HTML>\n<html lang="en">\n<head><meta charset="utf-8"><title>Directory listing</title></head>\n<body>\n<ul>\n'
                + names.map(n => `<li><a href="${encodeURI(n)}">${escapeHtml(n)}</a></li>`).join('\n') + '\n</ul>\n</body>\n</html>\n';
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
            return res.end(req.method === 'HEAD' ? undefined : body);
        }
    }
    const mtime = Math.floor(st.mtimeMs / 1000);
    const ims = Date.parse(req.headers['if-modified-since'] || '');
    if (!Number.isNaN(ims) && mtime <= Math.floor(ims / 1000)) { res.writeHead(304); return res.end(); }
    res.writeHead(200, {
        'Content-Type': mimeTypeFor(file),
        'Content-Length': st.size,
        'Last-Modified': new Date(mtime * 1000).toUTCString(),
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

/**
 * Serve `root` on `port` (default: `PORT` from the environment, else one the
 * system picks). Resolves once listening. `kill()` is an alias of `close()`, so
 * a file's `server.kill('SIGTERM')` keeps working. The server never keeps the
 * process alive by itself.
 * @param {string} [root]
 * @param {object} [options]
 * @param {number} [options.port]  0 for a free one whatever `PORT` says
 * @param {boolean} [options.cors]  allow any origin (a second, cross-origin
 *   server such as a model package's), answering preflights with 204
 * @param {(req: http.IncomingMessage) => void} [options.onRequest]  sees every request
 * @returns {Promise<{port: number, url: string, close(): void, kill(): void}>}
 */
export async function startServer(root = repoRoot, { port, cors = false, onRequest } = {}) {
    if (port === undefined) port = process.env.PORT ? Number(process.env.PORT) : 0;
    const server = http.createServer((req, res) => {
        if (onRequest) onRequest(req);
        if (cors) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', '*');
            if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
        }
        serveStatic(root, req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
    });
    await new Promise((resolve, reject) => {
        server.once('error', (e) => reject(e.code === 'EADDRINUSE'
            ? new Error(`startServer: port ${port} is already in use (another server?). Leave PORT unset to get a free one.`)
            : e));
        server.listen(port, resolve);
    });
    server.unref();
    const actual = server.address().port;
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        server.closeAllConnections();
        server.close();
    };
    return { port: actual, url: `http://localhost:${actual}`, close, kill: close };
}

// ---------------------------------------------------------------------------
// Browser with a disk cache for CDN and model downloads
// ---------------------------------------------------------------------------

export const CACHED_HOSTS = /^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|huggingface\.co|[a-z0-9-]+\.(hf\.co|huggingface\.co|xethub\.hf\.co))\//;

/** Can this URL's content change? Pinned ones are served from disk without asking. */
export function isPinnedUrl(url) {
    if (/^https:\/\/(cdn\.jsdelivr\.net\/npm|unpkg\.com)\/(@[^/]+\/)?[^/@]+@\d+\.\d+\.\d+[^/]*\//.test(url)) return true;
    if (/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//.test(url)) return true;
    return false;
}

export function cacheDir() {
    return process.env.LUC3D_E2E_CACHE || path.join(os.tmpdir(), 'luc3d-e2e-cache');
}

function cacheEnabled() {
    return process.env.LUC3D_E2E_CDN_CACHE !== '0';
}

// Headers that describe the transfer, not the content: the body on disk is
// already decoded and sized.
const DROP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection',
    'keep-alive', 'set-cookie', 'date', 'age', 'via', 'alt-svc', 'x-cache', 'cf-ray', 'server-timing']);

/** What a HEAD of `url` says about its version (not its signed redirect). */
async function remoteValidator(url) {
    const r = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (r.status >= 400) throw new Error('HTTP ' + r.status);
    const v = ['x-linked-etag', 'etag', 'x-repo-commit', 'last-modified']
        .map(h => r.headers.get(h)).filter(Boolean).join(' ');
    if (!v) throw new Error('no validator');
    return v;
}

async function readEntry(key) {
    try {
        const meta = JSON.parse(await fsp.readFile(path.join(cacheDir(), key + '.json'), 'utf8'));
        await fsp.access(path.join(cacheDir(), key + '.body'));
        return meta;
    } catch { return null; }
}

async function writeEntry(key, meta, body) {
    const dir = cacheDir();
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    // Body first, then its metadata: a reader that finds the metadata finds the body.
    await fsp.writeFile(path.join(dir, key + '.body' + tmp), body);
    await fsp.rename(path.join(dir, key + '.body' + tmp), path.join(dir, key + '.body'));
    await fsp.writeFile(path.join(dir, key + '.json' + tmp), JSON.stringify(meta));
    await fsp.rename(path.join(dir, key + '.json' + tmp), path.join(dir, key + '.json'));
}

// Above this, a body is not handed to the page through Playwright: one 86 MB
// `route.fulfill` closed the page. The browser is sent to a local server that
// serves the cache folder instead (a cross-origin redirect, as Hugging Face's
// own CDN redirect is). Scripts stay below it: a redirected module would
// resolve its root-relative imports against the local server.
const FULFILL_LIMIT = 16 * 1024 * 1024;

/** Serves `/<key>` from the cache with its saved Content-Type (e.g. application/wasm, which streaming compile needs). */
async function startCacheServer() {
    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
        const key = (req.url || '').slice(1).split('?')[0];
        const meta = /^[0-9a-f]{64}$/.test(key) ? await readEntry(key) : null;
        if (!meta) return notFound(req, res);
        const file = path.join(cacheDir(), key + '.body');
        const st = await fsp.stat(file).catch(() => null);
        if (!st) return notFound(req, res);
        res.writeHead(200, { 'Content-Type': meta.headers['content-type'] || 'application/octet-stream', 'Content-Length': st.size });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, resolve); });
    server.unref();
    return `http://localhost:${server.address().port}`;
}
let cacheServer = null;
async function redirectToCacheServer(route, key) {
    if (!cacheServer) cacheServer = startCacheServer();
    return route.fulfill({
        status: 302,
        headers: { location: `${await cacheServer}/${key}`, 'access-control-allow-origin': '*' },
    });
}

async function fulfillFromDisk(route, key, meta) {
    const size = (await fsp.stat(path.join(cacheDir(), key + '.body'))).size;
    if (size > FULFILL_LIMIT) return redirectToCacheServer(route, key);
    const contentType = meta.headers['content-type'] || 'application/octet-stream';
    return route.fulfill({
        status: 200,
        headers: { ...meta.headers, 'access-control-allow-origin': '*' },
        // Given `path`, Playwright takes the type from the file's extension
        // (`.body`: octet-stream, which Chromium will not run) unless told.
        contentType,
        path: path.join(cacheDir(), key + '.body'),
    });
}

async function cdnCacheHandler(route) {
    try {
        return await cachedResponse(route);
    } catch {
        // The page went away mid-fetch, or the disk failed: let the request go
        // on as if there were no cache (and never fail a test from in here).
        return route.fallback().catch(() => {});
    }
}

async function cachedResponse(route) {
    const req = route.request();
    if (req.method() !== 'GET' || req.headers()['range']) return route.fallback();
    const url = req.url();
    const key = crypto.createHash('sha256').update(url).digest('hex');
    const pinned = isPinnedUrl(url);
    const meta = await readEntry(key);
    let validator = null;
    if (meta) {
        if (pinned) return fulfillFromDisk(route, key, meta);
        try { validator = await remoteValidator(url); } catch { return route.fallback(); }
        if (validator === meta.validator) return fulfillFromDisk(route, key, meta);
    }
    let resp;
    try { resp = await route.fetch({ timeout: 300000 }); } catch { return route.fallback(); }
    const body = await resp.body();
    const headers = {};
    for (const [k, v] of Object.entries(resp.headers())) if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    if (resp.status() === 200) {
        if (!pinned && validator === null) { try { validator = await remoteValidator(url); } catch { /* not cached */ } }
        if (pinned || validator !== null) {
            const meta = { url, headers, validator, savedAt: new Date().toISOString() };
            if (await writeEntry(key, meta, body).then(() => true, () => false)) return fulfillFromDisk(route, key, meta);
        }
    }
    // Not cacheable: pass it on as fetched (or, if too big for that, fetch it again).
    if (body.length > FULFILL_LIMIT) return route.fallback();
    return route.fulfill({ status: resp.status(), headers: { ...headers, 'access-control-allow-origin': '*' }, body });
}

const cachedContexts = new WeakSet();

/** Route the CDN and model hosts of `context` through the disk cache (once). */
export async function installCdnCache(context) {
    if (!cacheEnabled() || cachedContexts.has(context)) return;
    cachedContexts.add(context);
    await context.route(u => CACHED_HOSTS.test(u.href), cdnCacheHandler);
}

/**
 * `chromium.launch(options)` whose every context (from `newContext` or
 * `newPage`) goes through the disk cache for CDN and model downloads.
 */
export async function launchBrowser(options) {
    // Imported here so the server half loads without Playwright (Node tests).
    const { chromium } = await import('playwright');
    // LUC3D_E2E_CHANNEL=chrome runs Google Chrome instead of Playwright's own
    // Chromium build, which on Linux cannot decode or encode H.264 (every video
    // fixture is H.264). CI sets it; a file's own `channel` still wins.
    const channel = process.env.LUC3D_E2E_CHANNEL;
    const browser = await chromium.launch(channel ? { channel, ...options } : options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (opts) => {
        const context = await newContext(opts);
        await installCdnCache(context);
        return context;
    };
    // Playwright's newPage goes through newContext; this covers it if it ever stops.
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (opts) => {
        const page = await newPage(opts);
        await installCdnCache(page.context());
        return page;
    };
    return browser;
}
