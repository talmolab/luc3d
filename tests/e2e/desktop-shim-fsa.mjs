/**
 * desktop-shim-fsa.mjs — the Tauri desktop shim (`src-tauri/js/lucid-desktop.js`)
 * in a headless Chromium that is made to look like WKWebView / WebKitGTK.
 *
 * Before any page script runs, `showSaveFilePicker` / `showDirectoryPicker` /
 * `showOpenFilePicker` are deleted (no File System Access API, as in WebKit),
 * and a mock `window.__TAURI_INTERNALS__` is installed that implements every
 * command of the `lucid` plugin contract over an in-memory filesystem: raw-body
 * `write_chunk` read from `options.headers`, temp-file + rename write sessions,
 * and NOT_GRANTED enforcement (only picked paths may be touched). A mock
 * `window.__TAURI__.event.listen` (installed LATE, to exercise the shim's retry)
 * and `core.Channel` stand in for the rest. The shim is then added as an init
 * script, exactly as the Rust shell does.
 *
 *   a) the writable: instanceof WritableStream; positioned / out-of-order
 *      writes, seek, truncate (cursor clamp), string / Blob / ArrayBuffer /
 *      DataView / offset-view inputs; getWriter() with {type:'write',position}
 *      chunks (mediabunny's StreamTarget); a 40 MiB Blob is streamed in
 *      slices and no chunk exceeds 32 MiB; nothing is visible at the target
 *      until close(); abort() leaves the target untouched; keepExistingData;
 *      bad params error the stream and leave no temp; cancel = AbortError;
 *      getFile() reads in <= 8 MiB slices, refuses > 512 MiB.
 *   b) a REAL LUCID File ▸ Save (quickSave) through the polyfill, for an
 *      eager and a lazy (streaming) project: the bytes equal what LUCID's
 *      download path produces, routed through the shim AND captured raw
 *      without it (clock frozen so the files are comparable); a second Save
 *      reuses the handle (no dialog) and writes identical bytes.
 *   c) File ▸ Export Calibration (an <a download> blob export LUCID revokes
 *      synchronously) → pick_save_path with the right name + filter, bytes
 *      match; cancel writes nothing; a data: URL and a user-clicked anchor too.
 *   d) a directory export through showDirectoryPicker({mode:'readwrite'}):
 *      LUCID's real Export SLEAP File Per Session, then the handle API
 *      (create, NotFound/TypeMismatch, bad names, values()/keys()/entries(),
 *      resolve, isSameEntry, removeEntry).
 *   e) close guard: dirty → ask_dialog; Cancel keeps it open; Close →
 *      confirm_close; clean → confirm_close without asking.
 *   f) inert without __TAURI_INTERNALS__; with the native API (WebView2):
 *      no polyfills, fsaWriteOnly false, download routing still on;
 *      idempotent when injected twice; external links; sleapNn wrappers.
 *
 * Usage: node tests/e2e/desktop-shim-fsa.mjs [PORT]   (default 9273, or $PORT)
 *        BROWSER=webkit node tests/e2e/desktop-shim-fsa.mjs   (Playwright WebKit: no
 *        File System Access API natively, like WKWebView; the WebView2 case is skipped)
 */
import * as playwright from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const SHIM = path.join(repoRoot, 'src-tauri', 'js', 'lucid-desktop.js');
const PORT = Number(process.argv[2] || process.env.PORT || 9273);
const BASE = `http://localhost:${PORT}`;
const BLANK = `${BASE}/__desktop_shim_blank.html`;
const MIB = 1024 * 1024;
const BROWSER = process.env.BROWSER || 'chromium';
const IS_CHROMIUM = BROWSER === 'chromium';

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 800)));
    if (!c) fails++;
};
const section = (t) => console.log('\n' + t);

// ---------------------------------------------------------------------------
// The mock Tauri runtime (runs in the page before the shim). `cfg.deleteFsa`
// removes the File System Access API like WKWebView; `cfg.tauri` installs
// __TAURI_INTERNALS__ at all.
// ---------------------------------------------------------------------------
function installMock(cfg) {
    if (cfg.deleteFsa) {
        for (const k of ['showSaveFilePicker', 'showDirectoryPicker', 'showOpenFilePicker']) {
            let o = window;
            while (o) { try { delete o[k]; } catch (e) { /* */ } o = Object.getPrototypeOf(o); }
        }
    }
    if (!cfg.tauri) return;

    const files = new Map();          // path -> {buf: Uint8Array, size, mtimeMs, fakeSize?}
    const dirs = new Set(['/']);
    const grants = [];                // {path, dir}
    const writes = new Map();         // id -> {temp, final}
    const calls = [];                 // {cmd, args}
    const chunks = [];                // {id, offset, len}
    const reads = [];                 // {path, offset, length, got}
    const listeners = new Map();      // event -> [cb]
    let nextId = 1;

    const fail = (msg) => { throw msg; };   // Tauri rejects with the Err string
    const parentOf = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
    const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
    const checkPath = (p) => {
        if (typeof p !== 'string' || !p.startsWith('/')) fail('path must be absolute: ' + p);
        if (p.split('/').includes('..')) fail('path must not contain ..: ' + p);
    };
    const isGranted = (p) => grants.some(g => g.path === p ||
        (g.dir && p.startsWith(g.path.replace(/\/$/, '') + '/')));
    const needGrant = (p) => { checkPath(p); if (!isGranted(p)) fail('NOT_GRANTED: ' + p); };
    const mkdirp = (p) => { while (p && p !== '/') { dirs.add(p); p = parentOf(p); } };
    const fileOf = (p) => files.get(p);
    const ensureCap = (f, n) => {
        if (f.buf.length >= n) return;
        const nb = new Uint8Array(Math.max(n, f.buf.length * 2));
        nb.set(f.buf.subarray(0, f.size));
        f.buf = nb;
    };
    const writeAt = (f, off, bytes) => {
        ensureCap(f, off + bytes.length);
        if (off > f.size) f.buf.fill(0, f.size, off);
        f.buf.set(bytes, off);
        f.size = Math.max(f.size, off + bytes.length);
        f.mtimeMs = Date.now();
    };
    const content = (f) => f.buf.slice(0, f.size);
    const newFile = (bytes) => {
        const f = { buf: new Uint8Array(0), size: 0, mtimeMs: Date.now() };
        if (bytes) writeAt(f, 0, bytes);
        return f;
    };
    const queues = { savePaths: [], dirPaths: [], askAnswers: [] };
    const sleep0 = () => new Promise(r => setTimeout(r, 0));

    const handlers = {
        pick_save_path(a) {
            const p = queues.savePaths.shift();
            if (p == null) return null;
            mkdirp(parentOf(p));
            grants.push({ path: p, dir: false });
            return p;
        },
        pick_directory() {
            const p = queues.dirPaths.shift();
            if (p == null) return null;
            mkdirp(p);
            grants.push({ path: p, dir: true });
            return p;
        },
        path_stat({ path }) {
            needGrant(path);
            const f = fileOf(path);
            if (f) return { exists: true, isFile: true, isDir: false, size: f.fakeSize || f.size, mtimeMs: f.mtimeMs };
            if (dirs.has(path)) return { exists: true, isFile: false, isDir: true, size: 0, mtimeMs: 0 };
            return { exists: false, isFile: false, isDir: false, size: 0, mtimeMs: 0 };
        },
        read_range({ path, offset, length }) {
            needGrant(path);
            const f = fileOf(path);
            if (!f) fail('ENOENT: ' + path);
            const out = f.buf.slice(Math.min(offset, f.size), Math.min(f.size, offset + length));
            reads.push({ path, offset, length, got: out.length });
            return out.buffer;
        },
        list_dir({ path }) {
            needGrant(path);
            if (!dirs.has(path)) fail('not a directory: ' + path);
            const out = [];
            for (const [p, f] of files) if (parentOf(p) === path) out.push({ name: baseOf(p), kind: 'file', size: f.size, mtimeMs: f.mtimeMs });
            for (const d of dirs) if (d !== '/' && d !== path && parentOf(d) === path) out.push({ name: baseOf(d), kind: 'directory', size: 0, mtimeMs: 0 });
            return out.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
        },
        make_dir({ path }) { needGrant(path); mkdirp(path); return null; },
        write_open({ path, keepExistingData }) {
            needGrant(path);
            if (!dirs.has(parentOf(path))) fail('ENOENT parent: ' + path);
            if (dirs.has(path)) fail('is a directory: ' + path);
            const temp = parentOf(path).replace(/\/$/, '') + '/.' + baseOf(path) + '.lucid-partial-' + Math.random().toString(36).slice(2, 8);
            const src = fileOf(path);
            files.set(temp, newFile(keepExistingData && src ? content(src) : null));
            const id = nextId++;
            writes.set(id, { temp, final: path });
            return { id };
        },
        write_chunk(body, options) {
            if (!(body instanceof Uint8Array || body instanceof ArrayBuffer)) fail('write_chunk needs a raw body');
            const h = (options && options.headers) || {};
            const id = Number(h['x-lucid-write-id']);
            const off = Number(h['x-lucid-offset']);
            const w = writes.get(id);
            if (!w) fail('no write session ' + id);
            if (!Number.isFinite(off) || off < 0) fail('bad offset');
            const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
            chunks.push({ id, offset: off, len: bytes.length, wholeBuffer: bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength });
            writeAt(fileOf(w.temp), off, bytes);
            return null;
        },
        write_truncate({ id, size }) {
            const w = writes.get(id);
            if (!w) fail('no write session ' + id);
            const f = fileOf(w.temp);
            if (size < f.size) { f.buf.fill(0, size, f.size); f.size = size; } else { ensureCap(f, size); f.buf.fill(0, f.size, size); f.size = size; }
            return null;
        },
        write_commit({ id }) {
            const w = writes.get(id);
            if (!w) fail('no write session ' + id);
            const f = fileOf(w.temp);
            files.delete(w.temp);
            files.set(w.final, f);
            writes.delete(id);
            return { size: f.size };
        },
        write_abort({ id }) {
            const w = writes.get(id);
            if (!w) return null;
            files.delete(w.temp);
            writes.delete(id);
            return null;
        },
        reveal_path() { return null; },
        open_external_url({ url }) { if (!/^(https?|mailto):/.test(url)) fail('scheme'); return null; },
        ask_dialog() { return queues.askAnswers.length ? queues.askAnswers.shift() : false; },
        set_close_guard() { return null; },
        confirm_close() { return null; },
        system_info() { return { os: 'linux', arch: 'x86_64', cpus: 8, totalMemoryBytes: 1, appVersion: '0.0.0', tauriVersion: '2', desktop: true }; },
        sleap_nn_status() { return { available: false, reason: 'not included in this build' }; },
        run_python_command({ program, args, onEvent }) {
            onEvent.__emit({ event: 'stdout', data: { line: program + ' ' + args.join(' ') } });
            onEvent.__emit({ event: 'stderr', data: { line: 'warn' } });
            onEvent.__emit({ event: 'finished', data: { success: true, code: 0 } });
            return true;
        },
        cancel_command() { return null; },
        detect_uv() { return { available: false }; },
        detect_gpu() { return 'cpu'; },
    };

    window.__TAURI_INTERNALS__ = {
        async invoke(cmd, args, options) {
            if (Math.random() < 0.3) await sleep0();   // jitter: order must come from the shim
            if (!cmd.startsWith('plugin:lucid|')) throw 'unknown plugin command ' + cmd;
            const name = cmd.slice('plugin:lucid|'.length);
            const h = handlers[name];
            if (!h) throw 'unknown command ' + name;
            calls.push({ cmd: name, args: name === 'write_chunk' ? { len: args.length, headers: options && options.headers } : args });
            return h(args, options);
        },
    };

    class Channel {
        constructor() { this.id = nextId++; this._h = () => {}; }
        set onmessage(h) { this._h = h; }
        get onmessage() { return this._h; }
        __emit(m) { this._h(m); }
    }
    window.__TAURI__ = { core: { Channel } };
    // The event API arrives late: the shim must retry.
    setTimeout(() => {
        window.__TAURI__.event = {
            listen(name, cb) {
                if (!listeners.has(name)) listeners.set(name, []);
                listeners.get(name).push(cb);
                return Promise.resolve(() => {});
            },
        };
    }, 300);

    window.__mock = {
        files, dirs, grants, writes, calls, chunks, reads, listeners, queues,
        callsOf: (n) => calls.filter(c => c.cmd === n),
        read: (p) => { const f = fileOf(p); return f ? content(f) : null; },
        text: (p) => { const f = fileOf(p); return f ? new TextDecoder().decode(content(f)) : null; },
        put: (p, bytes, opts) => { mkdirp(parentOf(p)); const f = newFile(bytes); if (opts && opts.fakeSize) f.fakeSize = opts.fakeSize; files.set(p, f); },
        temps: () => [...files.keys()].filter(p => p.includes('.lucid-partial-')),
        emit: (name, payload) => { for (const cb of listeners.get(name) || []) cb({ event: name, id: 1, payload }); },
        sha: async (p) => {
            const f = fileOf(p);
            if (!f) return null;
            const d = await crypto.subtle.digest('SHA-256', content(f));
            return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
        },
        invoke: (c, a, o) => window.__TAURI_INTERNALS__.invoke(c, a, o),
    };
}

// ---------------------------------------------------------------------------

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
let browser;

async function newShimPage(cfg, { twice = false } = {}) {
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 400)); fails++; });
    page.on('console', m => {
        // §c fetches a revoked blob: URL on purpose (ERR_FILE_NOT_FOUND).
        const loc = (m.location && m.location().url) || '';
        if (m.type() === 'error' && !/ERR_FILE_NOT_FOUND/.test(m.text()) && !loc.startsWith('blob:')) console.log('  [console.error]', m.text().slice(0, 300));
    });
    await page.route('**/__desktop_shim_blank.html', route => route.fulfill({
        status: 200, contentType: 'text/html', body: '<!doctype html><html><head><title>blank</title></head><body><p>blank</p></body></html>',
    }));
    await page.addInitScript(installMock, cfg);
    await page.addInitScript({ path: SHIM });
    if (twice) await page.addInitScript({ path: SHIM });
    return page;
}

try {
    browser = await playwright[BROWSER].launch({ headless: true });
    console.log('browser: ' + BROWSER + ' ' + browser.version());

    // =======================================================================
    section('a) NativeFileHandle / writable semantics (WKWebView-like page)');
    {
        const page = await newShimPage({ deleteFsa: true, tauri: true });
        await page.goto(BLANK);
        const r = await page.evaluate(async () => {
            const M = window.__mock;
            const out = {};
            const arr = (p) => Array.from(M.read(p) || []);
            out.fsaWriteOnly = window.lucidDesktop.fsaWriteOnly;
            out.isDesktop = window.lucidDesktop.isDesktop;
            out.dataset = document.documentElement.dataset.lucidDesktop;
            out.hasOpenPicker = typeof window.showOpenFilePicker;

            // cancel
            try { await showSaveFilePicker({ suggestedName: 'x.bin' }); out.cancel = 'resolved'; } catch (e) { out.cancel = e.name; out.cancelIsDom = e instanceof DOMException; }

            M.queues.savePaths.push('/out/a.bin');
            const h = await showSaveFilePicker({
                suggestedName: 'a.bin',
                types: [{ description: 'Binary', accept: { 'application/octet-stream': ['.bin', '.dat'] } }],
            });
            out.pickArgs = M.callsOf('pick_save_path').at(-1).args;
            out.handle = { kind: h.kind, name: h.name, keys: Object.keys(h), path: h.path };
            const w = await h.createWritable();
            out.isWS = w instanceof WritableStream;
            await w.write({ type: 'write', position: 10, data: new Uint8Array([1, 2, 3]) });
            await w.write({ type: 'write', position: 0, data: 'AB' });
            await w.seek(5);
            await w.write(new DataView(Uint8Array.of(9, 9).buffer));
            await w.write(new Blob(['xyz']));
            await w.write(Uint8Array.of(7).buffer);
            await w.truncate(12);
            await w.write('Q');
            out.visibleBeforeClose = M.read('/out/a.bin') !== null;
            out.tempsDuring = M.temps().length;
            await w.close();
            out.a = arr('/out/a.bin');
            out.tempsAfter = M.temps().length;

            // truncate clamps the cursor; an offset view writes only its bytes
            M.queues.savePaths.push('/out/b.bin');
            const hb = await showSaveFilePicker({});
            const wb = await hb.createWritable();
            await wb.write('abcdef');
            await wb.truncate(3);
            await wb.write(new Uint8Array([0, 1, 90, 90, 4, 5]).subarray(2, 3));   // 'Z'
            await wb.write({ type: 'write', data: new Float32Array([1.5]) , position: 8 });   // pads with zeros
            await wb.close();
            out.b = arr('/out/b.bin');
            out.bExpectTail = Array.from(new Uint8Array(new Float32Array([1.5]).buffer));

            // getWriter with mediabunny-style positioned chunks, issued without awaiting
            M.queues.savePaths.push('/out/c.bin');
            const hc = await showSaveFilePicker({});
            const wc = await hc.createWritable();
            const writer = wc.getWriter();
            writer.write({ type: 'write', data: Uint8Array.of(4, 4), position: 4 });
            writer.write({ type: 'write', data: Uint8Array.of(1, 1, 1, 1), position: 0 });
            writer.write({ type: 'write', data: Uint8Array.of(5), position: 6 });
            await writer.close();
            out.c = arr('/out/c.bin');

            // overwrite: nothing visible until close; then exactly the new bytes
            const wo = await h.createWritable();
            await wo.write('new');
            out.duringOverwrite = M.text('/out/a.bin').length;
            await wo.close();
            out.afterOverwrite = M.text('/out/a.bin');

            // abort leaves the target untouched
            const wa = await h.createWritable();
            await wa.write('garbage-garbage');
            await wa.abort();
            out.afterAbort = M.text('/out/a.bin');
            out.tempsAfterAbort = M.temps().length;

            // keepExistingData copies, cursor starts at 0
            M.put('/out/k.txt', new TextEncoder().encode('abcdef'));
            M.queues.savePaths.push('/out/k.txt');
            const hk = await showSaveFilePicker({});
            const wk = await hk.createWritable({ keepExistingData: true });
            await wk.write('XY');
            await wk.close();
            out.keep = M.text('/out/k.txt');

            // bad params: TypeError, stream errored, temp discarded, target untouched
            const we = await h.createWritable();
            try { await we.write({ type: 'seek' }); out.badSeek = 'resolved'; } catch (e) { out.badSeek = e.name; }
            try { await we.write({ type: 'write' }); out.afterErr = 'resolved'; } catch (e) { out.afterErr = e.name; }
            try { await we.write(12345); } catch (e) { out.badType = e.name; }
            out.tempsAfterErr = M.temps().length;
            out.afterErrTarget = M.text('/out/a.bin');
            const we2 = await h.createWritable();
            try { await we2.write(12345); out.badType = 'resolved'; } catch (e) { out.badType = e.name; }
            out.tempsAfterErr2 = M.temps().length;

            // 40 MiB Blob: streamed in slices, no chunk > 32 MiB; 40 MiB Uint8Array: split at 32 MiB
            const N = 40 * 1024 * 1024;
            const big = new Uint8Array(N);
            for (let i = 0; i < N; i++) big[i] = (i * 7 + (i >> 13)) & 255;
            M.queues.savePaths.push('/out/big-blob.bin');
            const hbb = await showSaveFilePicker({});
            const wbb = await hbb.createWritable();
            const id1 = M.callsOf('write_open').length;
            const before = M.chunks.length;
            await wbb.write(new Blob([big]));
            await wbb.close();
            const blobChunks = M.chunks.slice(before);
            out.blobChunkCount = blobChunks.length;
            out.blobMaxChunk = Math.max(...blobChunks.map(c => c.len));
            const before2 = M.chunks.length;
            M.queues.savePaths.push('/out/big-u8.bin');
            const hbu = await showSaveFilePicker({});
            const wbu = await hbu.createWritable();
            await wbu.write(big);
            await wbu.close();
            const u8Chunks = M.chunks.slice(before2);
            out.u8Chunks = u8Chunks.map(c => c.len);
            out.allWholeBuffer = M.chunks.every(c => c.wholeBuffer);
            const eq = (p) => { const a = M.read(p); if (!a || a.length !== N) return false; for (let i = 0; i < N; i++) if (a[i] !== big[i]) return false; return true; };
            out.bigBlobOk = eq('/out/big-blob.bin');
            out.bigU8Ok = eq('/out/big-u8.bin');
            out.maxChunkAll = Math.max(...M.chunks.map(c => c.len));

            // getFile: 8 MiB slices; > 512 MiB refused
            const nReads = M.reads.length;
            const f = await hbb.getFile();
            const fr = M.reads.slice(nReads);
            out.getFile = { name: f.name, size: f.size, isFile: f instanceof File, maxRead: Math.max(...fr.map(x => x.length)), nReads: fr.length };
            const fb = new Uint8Array(await f.arrayBuffer());
            let same = fb.length === N; for (let i = 0; same && i < N; i += 4093) same = fb[i] === big[i];
            out.getFileSame = same;
            const fk = await hk.getFile();
            out.getFileKeep = { text: await fk.text(), type: fk.type, lm: fk.lastModified > 0 };
            M.put('/out/huge.slp', new Uint8Array(4), { fakeSize: 600 * 1024 * 1024 });
            M.queues.savePaths.push('/out/huge.slp');
            const hh = await showSaveFilePicker({});
            try { await hh.getFile(); out.huge = 'resolved'; } catch (e) { out.huge = e.name; out.hugeMsg = e.message; }

            out.same = [await h.isSameEntry(h), await h.isSameEntry(hb), await h.queryPermission({ mode: 'readwrite' }), await h.requestPermission()];

            // NOT_GRANTED enforcement in the mock reaches the page as NotAllowedError via the shim
            try { await M.invoke('plugin:lucid|write_open', { path: '/etc/passwd', keepExistingData: false }); out.notGranted = 'resolved'; } catch (e) { out.notGranted = String(e); }
            M.queues.dirPaths.push('/out');
            const dout = await showDirectoryPicker();
            M.grants.length = 0;   // revoke everything: a handle op must surface NotAllowedError
            try { await dout.getFileHandle('a.bin'); out.revoked = 'resolved'; } catch (e) { out.revoked = e.name; }
            return out;
        });
        check(r.isDesktop === true && r.fsaWriteOnly === true, 'lucidDesktop.isDesktop and fsaWriteOnly are true without the native API', r);
        check(r.dataset === '1', '<html data-lucid-desktop="1">');
        check(r.hasOpenPicker === 'undefined', 'showOpenFilePicker is NOT polyfilled (reads stay on <input type=file>)');
        check(r.cancel === 'AbortError' && r.cancelIsDom, 'a cancelled save dialog rejects with an AbortError DOMException', r.cancel);
        check(JSON.stringify(r.pickArgs) === JSON.stringify({ filters: [{ name: 'Binary', extensions: ['bin', 'dat'] }], suggestedName: 'a.bin' }),
            'types[].accept maps to dialog filters; suggestedName passed', r.pickArgs);
        check(r.handle.kind === 'file' && r.handle.name === 'a.bin' && r.handle.path === '/out/a.bin' &&
            JSON.stringify(r.handle.keys) === '["kind","name"]', 'file handle: kind/name enumerable, path non-enumerable', r.handle);
        check(r.isWS, 'createWritable() returns an instance of WritableStream');
        check(!r.visibleBeforeClose && r.tempsDuring === 1, 'nothing at the target until close (a temp sibling holds the bytes)', r);
        check(JSON.stringify(r.a) === JSON.stringify([65, 66, 0, 0, 0, 9, 9, 120, 121, 122, 7, 81]) && r.tempsAfter === 0,
            'positioned write, seek, DataView, Blob, ArrayBuffer, truncate, string → expected bytes; temp renamed away', r.a);
        check(JSON.stringify(r.b) === JSON.stringify([97, 98, 99, 90, 0, 0, 0, 0, ...r.bExpectTail]),
            'truncate clamps the cursor; an offset view writes only its own bytes; a write past EOF pads with zeros', r.b);
        check(JSON.stringify(r.c) === JSON.stringify([1, 1, 1, 1, 4, 4, 5]), 'getWriter() with un-awaited {type:"write",position} chunks (StreamTarget) lands in order', r.c);
        check(r.duringOverwrite === 12 && r.afterOverwrite === 'new', 'Save over an existing file: old bytes intact until close, then exactly the new bytes', r);
        check(r.afterAbort === 'new' && r.tempsAfterAbort === 0, 'abort() leaves the target untouched and deletes the temp', r);
        check(r.keep === 'XYcdef', 'keepExistingData copies the file and the cursor starts at 0', r.keep);
        check(r.badSeek === 'TypeError' && r.afterErr === 'TypeError' && r.tempsAfterErr === 0 && r.afterErrTarget === 'new',
            'a seek without position is a TypeError, errors the stream, discards its temp, target untouched', r);
        check(r.badType === 'TypeError' && r.tempsAfterErr2 === 0, 'a non-writable value is a TypeError (temp discarded)', r);
        check(r.bigBlobOk && r.blobChunkCount >= 5 && r.blobMaxChunk <= 8 * 1024 * 1024,
            '40 MiB Blob streamed in <= 8 MiB slices and written byte-exact', { n: r.blobChunkCount, max: r.blobMaxChunk });
        check(r.bigU8Ok && JSON.stringify(r.u8Chunks) === JSON.stringify([32 * MIB, 8 * MIB]),
            '40 MiB Uint8Array split into 32 MiB + 8 MiB raw-body chunks, byte-exact', r.u8Chunks);
        check(r.maxChunkAll <= 32 * MIB && r.allWholeBuffer, 'no write_chunk body exceeds 32 MiB; every body spans its whole buffer', r.maxChunkAll);
        check(r.getFile.isFile && r.getFile.name === 'big-blob.bin' && r.getFile.size === 40 * MIB && r.getFile.maxRead <= 8 * MIB &&
            r.getFile.nReads === 5 && r.getFileSame, 'getFile() reads in 8 MiB slices into a File with the right name and bytes', r.getFile);
        check(r.getFileKeep.text === 'XYcdef' && r.getFileKeep.type === 'text/plain' && r.getFileKeep.lm, 'getFile() type from extension, lastModified set', r.getFileKeep);
        check(r.huge === 'NotSupportedError' && /512 MiB/.test(r.hugeMsg), 'getFile() refuses a file over 512 MiB with a clear NotSupportedError', r.hugeMsg);
        check(JSON.stringify(r.same) === '[true,false,"granted","granted"]', 'isSameEntry compares paths; permissions are granted', r.same);
        check(/NOT_GRANTED: \/etc\/passwd/.test(r.notGranted), 'mock enforces NOT_GRANTED for an unpicked path', r.notGranted);
        check(r.revoked === 'NotAllowedError', 'a NOT_GRANTED error surfaces as NotAllowedError', r.revoked);
        await page.close();
    }

    // =======================================================================
    section('b) real LUCID File ▸ Save through the polyfill (eager + lazy streaming)');
    const app = await newShimPage({ deleteFsa: true, tauri: true });
    await app.clock.setFixedTime(new Date('2026-01-02T03:04:05Z'));
    await app.goto(`${BASE}/index.html`);
    await app.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    await app.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const fileio = await import('/import-export/file-io.js');
        const lazyMod = await import('/loading/sio-lazy-loader.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;
        const NODES = 4, CAMS = ['camA', 'camB'];
        const skel = () => new Skeleton('skeleton', Array.from({ length: NODES }, (_, i) => 'n' + i),
            Array.from({ length: NODES - 1 }, (_, i) => [i, i + 1]));
        const camera = (name, i) => new Camera(name, [[1000, 0, 128], [0, 1000, 128], [0, 0, 1]],
            [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [256, 256]);
        const pts = (f, k) => [50 + k + (f % 100), 60 + k];
        function eagerSession() {
            const session = new Session(CAMS.map(camera), skel(), ['t0'], 'eager');
            for (let f = 0; f < 50; f++) {
                const fg = new FrameGroup(f); session.addFrameGroup(fg);
                for (const cn of CAMS) fg.addInstance(cn, new Instance(Array.from({ length: NODES }, (_, k) => pts(f, k)), 0, 'user', 1));
            }
            return session;
        }
        async function lazySession(FRAMES) {
            const session = new Session(CAMS.map(camera), skel(), ['t0'], 'lazy');
            const loader = new SioLazyLoader();
            for (let ci = 0; ci < CAMS.length; ci++) {
                const s = new Session([camera(CAMS[ci], ci)], skel(), ['t0'], 'lazy');
                for (let f = 0; f < FRAMES; f++) {
                    const fg = new FrameGroup(f); s.addFrameGroup(fg);
                    fg.addInstance(CAMS[ci], new Instance(Array.from({ length: NODES }, (_, k) => pts(f, k)), 0, 'predicted', 0.9));
                }
                const labels = fileio.buildSlpLabels(s, CAMS[ci], false,
                    { videoWidth: 256, videoHeight: 256, frameCount: FRAMES, videoPath: CAMS[ci] + '.mp4' });
                await loader.open(CAMS[ci], new File([await window.SleapIO.saveSlpToBytes(labels)], CAMS[ci] + '.slp'));
            }
            session.lazyLoader = loader;
            const id = session.addIdentity('Red').id;
            for (let f = 0; f < FRAMES; f++) {
                const g = new InstanceGroup(f + 1, id);
                for (const cn of CAMS) g.addInstance(cn, new Instance(Array.from({ length: NODES }, (_, k) => pts(f, k)), 0, 'predicted', 0.9));
                g.points3d = new Float64Array(NODES * 3).fill(1);
                session.instanceGroups.set(f, [g]);
            }
            return session;
        }
        window.__fx = {
            async use(kind) {
                const session = kind === 'eager' ? eagerSession() : await lazySession(3000);
                AS.state.sessions = [session];
                AS.state.session = session;
                AS.state.activeSessionIdx = 0;
                AS.state.views = CAMS.map(cn => ({ name: cn, videoWidth: 256, videoHeight: 256, frameCount: 3000 }));
                AS.state.videoFiles = CAMS.map(cn => ({ name: cn + '.mp4', assignedCamera: cn, videoPath: cn + '.mp4', sessionIdx: 0 }));
                AS.state.cameraDirMap = { camA: 'camA_dir', camB: 'camB_dir' };
                AS.state.slpFileHandle = null;
                AS.state.isSaving = false;
            },
            // The bytes LUCID's download path produces, captured raw (shim bypassed).
            async rawDownload() {
                const SL = await import('/import-export/save-load.js');
                const shimClick = HTMLAnchorElement.prototype.click;
                let got;
                const done = new Promise(res => { got = res; });
                HTMLAnchorElement.prototype.click = function () {
                    const href = this.href;
                    fetch(href).then(r => r.arrayBuffer()).then(b => got(new Uint8Array(b)));
                };
                try { await SL.saveProjectSlp(); } finally { HTMLAnchorElement.prototype.click = shimClick; }
                const bytes = await done;
                const d = await crypto.subtle.digest('SHA-256', bytes);
                return { len: bytes.length, sha: [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('') };
            },
        };
    });

    const waitIdle = () => app.waitForFunction(() => !window.__lucid.state.isSaving, null, { timeout: 120000 });
    const waitFile = (p) => app.waitForFunction((p) => window.__mock.read(p) !== null, p, { timeout: 120000 });
    for (const kind of ['eager', 'lazy']) {
        await app.evaluate((k) => window.__fx.use(k), kind);
        const target = `/proj/${kind}.slp`;
        const r1 = await app.evaluate(async (target) => {
            const M = window.__mock;
            M.queues.savePaths.push(target);
            const nChunks = M.chunks.length;
            document.getElementById('menuSaveProject').click();   // File ▸ Save
            await new Promise(r => setTimeout(r, 50));
            while (window.__lucid.state.isSaving || !M.read(target)) await new Promise(r => setTimeout(r, 50));
            const st = window.__lucid.state;
            return {
                pick: M.callsOf('pick_save_path').at(-1).args,
                handleName: st.slpFileHandle && st.slpFileHandle.name,
                dirty: st.isDirty,
                status: (document.getElementById('statusText') || document.getElementById('status') || {}).textContent || '',
                sha: await M.sha(target), len: M.read(target).length,
                chunks: M.chunks.length - nChunks,
                temps: M.temps().length,
                hdf5: Array.from(M.read(target).slice(0, 8)),
            };
        }, target);
        check(r1.pick.suggestedName === `${kind}.slp` && JSON.stringify(r1.pick.filters) === JSON.stringify([{ name: 'SLEAP Labels', extensions: ['slp'] }]),
            `${kind}: File ▸ Save opened the native save dialog with ${kind}.slp and the SLEAP filter`, r1.pick);
        check(r1.handleName === `${kind}.slp` && r1.dirty === false && r1.temps === 0, `${kind}: state.slpFileHandle kept, project clean, no temp left`, r1);
        check(JSON.stringify(r1.hdf5) === JSON.stringify([0x89, 72, 68, 70, 13, 10, 26, 10]) && r1.len > 1000, `${kind}: an HDF5 file of ${r1.len} bytes in ${r1.chunks} write_chunk(s)`);

        // Same project through the download path, routed by the shim.
        const dlTarget = `/proj/${kind}-download.slp`;
        await app.evaluate(async (t) => {
            window.__mock.queues.savePaths.push(t);
            const SL = await import('/import-export/save-load.js');
            await SL.saveProjectSlp();
        }, dlTarget);
        await waitFile(dlTarget);
        const dl = await app.evaluate(async (t) => ({ sha: await window.__mock.sha(t), pick: window.__mock.callsOf('pick_save_path').at(-1).args }), dlTarget);
        const raw = await app.evaluate(() => window.__fx.rawDownload());
        check(dl.sha === r1.sha && raw.sha === r1.sha && raw.len === r1.len,
            `${kind}: Save via the polyfill == download routed by the shim == raw web download (sha ${r1.sha.slice(0, 12)}…)`, { save: r1.sha, dl: dl.sha, raw: raw.sha });
        check(dl.pick.suggestedName === `${kind}.slp`, `${kind}: the routed download suggested ${kind}.slp`, dl.pick);

        // Second Save reuses the handle: no dialog, same bytes, written over the open file.
        const r2 = await app.evaluate(async (target) => {
            const M = window.__mock;
            const picks = M.callsOf('pick_save_path').length;
            const opens = M.callsOf('write_open').length;
            const SL = await import('/import-export/save-load.js');
            SL.markDirty();
            document.getElementById('menuSaveProject').click();
            await new Promise(r => setTimeout(r, 50));
            while (window.__lucid.state.isSaving) await new Promise(r => setTimeout(r, 50));
            return { picks: M.callsOf('pick_save_path').length - picks, opens: M.callsOf('write_open').length - opens, sha: await M.sha(target), dirty: window.__lucid.state.isDirty };
        }, target);
        check(r2.picks === 0 && r2.opens === 1 && r2.sha === r1.sha && !r2.dirty, `${kind}: second Save writes over the open file without a dialog, identical bytes`, r2);
    }
    await waitIdle();

    // =======================================================================
    section('c) <a download> exports (Export Calibration) routed to the native dialog');
    {
        await app.evaluate((k) => window.__fx.use(k), 'eager');
        const r = await app.evaluate(async () => {
            const M = window.__mock;
            const fileio = await import('/import-export/file-io.js');
            const expected = fileio.exportCalibrationTOML(window.__lucid.state.session.cameras);
            const out = {};
            // cancel first: nothing written, no error
            const n0 = M.calls.length;
            document.getElementById('menuExportCalib').click();
            await new Promise(r => setTimeout(r, 300));
            out.cancelCalls = M.calls.slice(n0).map(c => c.cmd);
            M.queues.savePaths.push('/exports/calibration.toml');
            let revokedUrl = null;
            const realRevoke = URL.revokeObjectURL;
            URL.revokeObjectURL = function (u) { revokedUrl = u; return realRevoke.call(URL, u); };
            document.getElementById('menuExportCalib').click();
            URL.revokeObjectURL = realRevoke;
            out.revokedSync = !!revokedUrl;
            try { await fetch(revokedUrl); out.urlDead = false; } catch (e) { out.urlDead = true; }
            while (!M.read('/exports/calibration.toml')) await new Promise(r => setTimeout(r, 20));
            out.pick = M.callsOf('pick_save_path').at(-1).args;
            out.same = M.text('/exports/calibration.toml') === expected;
            out.len = expected.length;

            // data: URL anchor, appended to the DOM and clicked by the user (capture listener path)
            const a = document.createElement('a');
            a.href = 'data:text/plain;charset=utf-8,h%C3%A9llo%20world';
            a.download = 'hello.txt';
            a.textContent = 'dl';
            a.id = 'shimDataLink';
            a.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:#fff';
            document.body.appendChild(a);
            M.queues.savePaths.push('/exports/hello.txt');
            return out;
        });
        check(JSON.stringify(r.cancelCalls) === '["pick_save_path"]', 'cancelled Export Calibration: only the dialog, nothing written', r.cancelCalls);
        check(r.revokedSync && r.urlDead, 'LUCID revoked the blob URL synchronously after a.click() (the URL is dead)', r);
        check(r.pick.suggestedName === 'calibration.toml' && JSON.stringify(r.pick.filters) === JSON.stringify([{ name: 'TOML file', extensions: ['toml'] }]),
            'routed to pick_save_path with suggestedName calibration.toml and a TOML filter', r.pick);
        check(r.same && r.len > 50, 'calibration.toml bytes match exportCalibrationTOML()', r);
        await app.click('#shimDataLink');
        await waitFile('/exports/hello.txt');
        const t = await app.evaluate(() => { document.getElementById('shimDataLink').remove(); return window.__mock.text('/exports/hello.txt'); });
        check(t === 'héllo world', 'a user-clicked data: URL download is decoded and saved', t);
        const base64 = await app.evaluate(async () => {
            const M = window.__mock;
            M.queues.savePaths.push('/exports/b64.bin');
            const a = document.createElement('a');
            a.href = 'data:application/octet-stream;base64,AAEC/w==';
            a.download = 'b64.bin';
            a.click();
            while (!M.read('/exports/b64.bin')) await new Promise(r => setTimeout(r, 20));
            return Array.from(M.read('/exports/b64.bin'));
        });
        check(JSON.stringify(base64) === '[0,1,2,255]', 'a detached base64 data: anchor is decoded', base64);
    }

    // =======================================================================
    section('d) directory export through showDirectoryPicker({mode:"readwrite"})');
    {
        await app.evaluate((k) => window.__fx.use(k), 'eager');
        const ps = await app.evaluate(async () => {
            const M = window.__mock;
            M.queues.dirPaths.push('/exp');
            const EM = await import('/ui/export-modals.js');
            EM.showSlpExportPerSessionModal();
            const btn = document.getElementById('slpPsExport');
            if (!btn) return { error: 'no modal' };
            btn.click();
            const t0 = Date.now();
            while (Date.now() - t0 < 30000) {
                const done = ['/exp/camA_dir/camA_v1.slp', '/exp/camB_dir/camB_v1.slp'].every(p => M.read(p) && M.read(p).length > 0);
                if (done) break;
                await new Promise(r => setTimeout(r, 50));
            }
            const head = (p) => M.read(p) ? Array.from(M.read(p).slice(0, 4)) : null;
            return {
                pickDir: M.callsOf('pick_directory').at(-1) && M.callsOf('pick_directory').at(-1).args,
                files: [...M.files.keys()].filter(p => p.startsWith('/exp/')).sort(),
                headA: head('/exp/camA_dir/camA_v1.slp'), headB: head('/exp/camB_dir/camB_v1.slp'),
                makeDirs: M.callsOf('make_dir').map(c => c.args.path),
                errorText: (document.getElementById('slpPsError') || {}).textContent || '',
            };
        });
        check(JSON.stringify(ps.files) === JSON.stringify(['/exp/camA_dir/camA_v1.slp', '/exp/camB_dir/camB_v1.slp']) &&
            JSON.stringify(ps.headA) === '[137,72,68,70]' && JSON.stringify(ps.headB) === '[137,72,68,70]',
            'Export SLEAP File Per Session wrote one HDF5 .slp per camera into created subfolders', ps);
        check(JSON.stringify(ps.makeDirs) === JSON.stringify(['/exp/camA_dir', '/exp/camB_dir']), 'getDirectoryHandle({create:true}) → make_dir', ps.makeDirs);
        await app.evaluate(() => document.querySelectorAll('.multi-frame-modal-overlay').forEach(o => o.remove()));

        const r = await app.evaluate(async () => {
            const M = window.__mock;
            const out = {};
            try { await showDirectoryPicker({ mode: 'readwrite' }); out.cancel = 'resolved'; } catch (e) { out.cancel = e.name; }
            M.queues.dirPaths.push('/h');
            const d = await showDirectoryPicker({ mode: 'readwrite' });
            out.d = { kind: d.kind, name: d.name, path: d.path };
            const sub = await d.getDirectoryHandle('cam1', { create: true });
            const fh = await sub.getFileHandle('x.slp', { create: true });
            out.createdEmpty = M.read('/h/cam1/x.slp') && M.read('/h/cam1/x.slp').length === 0;
            const w = await fh.createWritable();
            await w.write(new Blob(['payload']));
            await w.close();
            out.payload = M.text('/h/cam1/x.slp');
            const again = await sub.getFileHandle('x.slp', { create: true });   // existing: not truncated
            out.notTruncated = M.text('/h/cam1/x.slp');
            out.sameEntry = await again.isSameEntry(fh);
            const errName = async (fn) => { try { await fn(); return 'resolved'; } catch (e) { return e.name; } };
            out.missingFile = await errName(() => d.getFileHandle('nope.txt'));
            out.missingDir = await errName(() => d.getDirectoryHandle('nope'));
            out.fileAsDir = await errName(() => sub.getDirectoryHandle('x.slp'));
            out.dirAsFile = await errName(() => d.getFileHandle('cam1'));
            out.badNames = [];
            for (const n of ['..', '.', 'a/b', 'a\\b', '']) out.badNames.push(await errName(() => d.getFileHandle(n, { create: true })));
            out.remove = await errName(() => d.removeEntry('cam1'));
            await d.getFileHandle('z.txt', { create: true });
            out.values = [];
            for await (const h of d.values()) out.values.push(h.kind + ':' + h.name);
            out.keys = [];
            for await (const k of d.keys()) out.keys.push(k);
            out.entries = [];
            for await (const [k, h] of d) out.entries.push(k + '=' + h.kind);
            out.resolve = await d.resolve(fh);
            out.resolveOther = await sub.resolve(d);
            out.perm = await d.queryPermission({ mode: 'readwrite' });
            return out;
        });
        check(r.cancel === 'AbortError', 'a cancelled folder dialog rejects with AbortError');
        check(r.d.kind === 'directory' && r.d.name === 'h' && r.d.path === '/h', 'directory handle kind/name/path', r.d);
        check(r.createdEmpty && r.payload === 'payload' && r.notTruncated === 'payload' && r.sameEntry,
            'getFileHandle({create:true}) creates an empty file; existing files are not truncated', r);
        check(r.missingFile === 'NotFoundError' && r.missingDir === 'NotFoundError', 'missing entries → NotFoundError', r);
        check(r.fileAsDir === 'TypeMismatchError' && r.dirAsFile === 'TypeMismatchError', 'wrong kind → TypeMismatchError', r);
        check(r.badNames.every(n => n === 'TypeError'), 'names with / \\ . .. or empty → TypeError', r.badNames);
        check(r.remove === 'NotSupportedError', 'removeEntry → NotSupportedError');
        check(JSON.stringify(r.values) === '["directory:cam1","file:z.txt"]' && JSON.stringify(r.keys) === '["cam1","z.txt"]' &&
            JSON.stringify(r.entries) === '["cam1=directory","z.txt=file"]', 'values()/keys()/entries()/for await iterate list_dir', r);
        check(JSON.stringify(r.resolve) === '["cam1","x.slp"]' && r.resolveOther === null && r.perm === 'granted', 'resolve() and permissions', r);
    }

    // =======================================================================
    section('e) close guard');
    {
        await app.waitForFunction(() => window.__mock.callsOf('set_close_guard').length > 0, null, { timeout: 15000 });
        const g = await app.evaluate(() => ({
            guard: window.__mock.callsOf('set_close_guard').map(c => c.args),
            listening: (window.__mock.listeners.get('lucid://close-requested') || []).length,
        }));
        check(JSON.stringify(g.guard) === '[{"enabled":true}]' && g.listening === 1,
            'after the late event API appeared: one close-requested listener, then set_close_guard({enabled:true})', g);
        const r = await app.evaluate(async () => {
            const M = window.__mock;
            const SL = await import('/import-export/save-load.js');
            const wait = (ms) => new Promise(r => setTimeout(r, ms));
            const out = {};
            SL.markDirty();
            const guardBefore = M.callsOf('set_close_guard').length;
            M.queues.askAnswers.push(false);
            M.emit('lucid://close-requested');
            M.emit('lucid://close-requested');   // a second request while the first is open is ignored
            await wait(200);
            out.ask1 = M.callsOf('ask_dialog').map(c => c.args);
            // every request is acknowledged at once, before any dialog (Rust force-closes
            // only after an UNacknowledged request), even one ignored as a duplicate
            out.acks = M.callsOf('set_close_guard').length - guardBefore;
            out.close1 = M.callsOf('confirm_close').length;
            out.stillDirty = window.__lucid.state.isDirty;
            M.queues.askAnswers.push(true);
            M.emit('lucid://close-requested');
            await wait(200);
            out.ask2 = M.callsOf('ask_dialog').length;
            out.close2 = M.callsOf('confirm_close').length;
            SL.clearDirty();
            M.emit('lucid://close-requested');
            await wait(200);
            out.ask3 = M.callsOf('ask_dialog').length;
            out.close3 = M.callsOf('confirm_close').length;
            // a page that only assigns returnValue (legacy style) also counts as unsaved
            const legacy = (e) => { e.returnValue = 'unsaved'; };
            window.addEventListener('beforeunload', legacy);
            M.queues.askAnswers.push(false);
            M.emit('lucid://close-requested');
            await wait(200);
            window.removeEventListener('beforeunload', legacy);
            out.ask4 = M.callsOf('ask_dialog').length;
            out.close4 = M.callsOf('confirm_close').length;
            return out;
        });
        check(r.ask1.length === 1 && JSON.stringify(r.ask1[0]) === JSON.stringify({ title: 'Unsaved changes', message: 'LUCID has unsaved changes. Close anyway?', okLabel: 'Close', cancelLabel: 'Cancel' }),
            'dirty project: ask_dialog asked once with the contract text', r.ask1);
        check(r.acks === 2, 'each close request is acknowledged with set_close_guard', r.acks);
        check(r.close1 === 0 && r.stillDirty, 'Cancel keeps the window open (no confirm_close)', r);
        check(r.ask2 === 2 && r.close2 === 1, 'Close → confirm_close', r);
        check(r.ask3 === 2 && r.close3 === 2, 'clean project → confirm_close without asking', r);
        check(r.ask4 === 3 && r.close4 === 2, 'a beforeunload that only sets returnValue counts as unsaved', r);
    }
    await app.close();

    // =======================================================================
    section('f) inert / WebView2 / idempotent / links / sleapNn');
    {
        const page = await newShimPage({ deleteFsa: false, tauri: false });
        await page.goto(BLANK);
        const r = await page.evaluate((IS_CHROMIUM_PAGE) => ({
            ld: typeof window.lucidDesktop,
            ssp: IS_CHROMIUM_PAGE ? (typeof window.showSaveFilePicker === 'function' && /\[native code\]/.test(String(window.showSaveFilePicker)))
                : typeof window.showSaveFilePicker === 'undefined',
            click: /\[native code\]/.test(String(HTMLAnchorElement.prototype.click)),
            create: /\[native code\]/.test(String(URL.createObjectURL)),
            open: /\[native code\]/.test(String(window.open)),
            ds: document.documentElement.dataset.lucidDesktop,
        }), IS_CHROMIUM);
        check(r.ld === 'undefined' && r.ssp && r.click && r.create && r.open && r.ds === undefined,
            'without __TAURI_INTERNALS__ the shim does nothing (no lucidDesktop, natives untouched)', r);
        await page.close();
    }
    {
        // Chromium = WebView2: the native API exists. (WebKit has none: polyfilled.)
        // Shim injected twice (idempotent).
        const page = await newShimPage({ deleteFsa: false, tauri: true }, { twice: true });
        await page.goto(BLANK);
        const r = await page.evaluate(async () => {
            const M = window.__mock;
            const out = {
                fsaWriteOnly: window.lucidDesktop.fsaWriteOnly,
                sspNative: /\[native code\]/.test(String(window.showSaveFilePicker)),
                sdpNative: /\[native code\]/.test(String(window.showDirectoryPicker)),
            };
            M.queues.savePaths.push('/dl/report.csv');
            const url = URL.createObjectURL(new Blob(['a,b\n1,2\n'], { type: 'text/csv' }));
            const a = document.createElement('a');
            a.href = url; a.download = 'report.csv';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            while (!M.read('/dl/report.csv')) await new Promise(r => setTimeout(r, 20));
            await new Promise(r => setTimeout(r, 100));
            out.csv = M.text('/dl/report.csv');
            out.picks = M.callsOf('pick_save_path').map(c => c.args);
            out.opens = M.callsOf('write_open').length;

            // external links
            out.winOpen = window.open('https://example.org/docs?a=1', '_blank');
            const ext = document.createElement('a');
            ext.href = 'https://sleap.ai/'; ext.target = '_blank'; ext.textContent = 'ext';
            document.body.appendChild(ext);
            const local = document.createElement('a');
            local.href = '/same-origin-page.html'; local.target = '_blank';
            document.body.appendChild(local);
            const plain = document.createElement('a');
            plain.href = 'https://example.com/plain';   // no target: not routed
            document.body.appendChild(plain);
            const mail = document.createElement('a');
            mail.href = 'mailto:lucid@example.org';
            document.body.appendChild(mail);
            const seen = [];
            const bubble = (e) => { const t = e.target.closest('a'); seen.push([t.getAttribute('href'), e.defaultPrevented]); e.preventDefault(); };
            window.addEventListener('click', bubble);
            ext.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            local.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            plain.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            mail.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            window.removeEventListener('click', bubble);
            await new Promise(r => setTimeout(r, 50));
            out.seen = seen;
            out.external = M.callsOf('open_external_url').map(c => c.args.url);

            // sleapNn + misc wrappers
            const events = [];
            out.run = await window.lucidDesktop.sleapNn.runPythonCommand('uv', ['run', 'x'], (m) => events.push(m));
            out.events = events;
            out.status = await window.lucidDesktop.sleapNn.status();
            out.gpu = await window.lucidDesktop.sleapNn.detectGpu();
            out.sys = (await window.lucidDesktop.systemInfo()).desktop;
            await window.lucidDesktop.revealPath('/dl/report.csv');
            out.reveal = M.callsOf('reveal_path').map(c => c.args);
            out.platform = window.lucidDesktop.platform;
            return out;
        });
        if (IS_CHROMIUM) check(r.fsaWriteOnly === false && r.sspNative && r.sdpNative, 'WebView2 (native API present): no picker polyfills, fsaWriteOnly false', r);
        else check(r.fsaWriteOnly === true && !r.sspNative && !r.sdpNative, 'WebKit (no native API): pickers polyfilled, fsaWriteOnly true', r);
        check(r.csv === 'a,b\n1,2\n' && r.picks.length === 1 && r.opens === 1 &&
            JSON.stringify(r.picks[0]) === JSON.stringify({ suggestedName: 'report.csv', filters: [{ name: 'CSV file', extensions: ['csv'] }] }),
            'download routing is on, and runs once although the shim was injected twice', r);
        check(r.winOpen === null, 'window.open(external) returns null');
        // (sorted: the mock's invoke jitter may record the three calls in any order)
        check(JSON.stringify([...r.external].sort()) === JSON.stringify(['https://example.org/docs?a=1', 'https://sleap.ai/', 'mailto:lucid@example.org']),
            'external http(s) window.open / target=_blank / mailto: → open_external_url', r.external);
        check(JSON.stringify(r.seen) === JSON.stringify([['https://sleap.ai/', true], ['/same-origin-page.html', false], ['https://example.com/plain', false], ['mailto:lucid@example.org', true]]),
            'same-origin target=_blank and plain links are left to the default', r.seen);
        check(r.run === true && r.events.length === 3 && r.events[0].data.line === 'uv run x' && r.events[2].event === 'finished',
            'sleapNn.runPythonCommand streams ProcessEvents through a Channel', r.events);
        check(r.status.available === false && r.gpu === 'cpu' && r.sys === true && JSON.stringify(r.reveal) === '[{"path":"/dl/report.csv"}]' && (IS_CHROMIUM ? r.platform === 'linux' : ['macos', 'linux'].includes(r.platform)),
            'sleapNn.status/detectGpu, systemInfo, revealPath, platform', r);
        await page.close();
    }

    console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
} catch (err) {
    fails++;
    console.log('*** ERROR ***', (err && err.stack) || String(err));
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
}
process.exit(fails === 0 ? 0 : 1);
