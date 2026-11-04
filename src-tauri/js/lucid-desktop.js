/*
 * lucid-desktop.js — the LUCID desktop (Tauri 2) initialization script.
 *
 * Injected by the Rust shell as the main window's initialization script, so it
 * runs in every page load BEFORE any page script. Classic script, one IIFE, no
 * imports, ES2020 — it must run unchanged in WKWebView (macOS), WebKitGTK
 * (Linux) and WebView2 (Windows). The web build never loads it, and no LUCID
 * module imports it: LUCID only feature-detects what it installs.
 *
 * Inert unless `window.__TAURI_INTERNALS__` exists (so a copy of this file in a
 * normal browser does nothing), and idempotent (a second run is a no-op).
 *
 * What it does (contract: luc3d-app-contract.md, "JS shim"):
 *  1. `window.lucidDesktop` — {isDesktop, fsaWriteOnly, platform, systemInfo(),
 *     revealPath(p), openExternal(url), sleapNn{...}} and
 *     `<html data-lucid-desktop="1">`.
 *  2. Where the webview has no File System Access API (WKWebView, WebKitGTK):
 *     `showSaveFilePicker` / `showDirectoryPicker` polyfills backed by the
 *     `lucid` plugin's native dialogs and positioned, atomic writes
 *     (write_open → write_chunk… → write_commit: a temp sibling renamed over
 *     the target, so nothing is visible at the target until close() — that is
 *     what makes File ▸ Save over the open project safe). Handles are
 *     WRITE-capable; their reads (`getFile`) are capped, so
 *     `lucidDesktop.fsaWriteOnly = true` tells LUCID to read folders through
 *     `<input webkitdirectory>` instead.
 *  3. Download routing (every desktop platform): `<a download>` / blob: / data:
 *     clicks become a native Save dialog plus the same native write.
 *  4. External links (`window.open`, `<a target=_blank>`, mailto:) open in the
 *     system browser.
 *  5. Close guard: the window's close button asks LUCID (through a synthetic
 *     `beforeunload`) whether there is unsaved work, and asks the user.
 *  6. `lucidDesktop.sleapNn` — thin wrappers for the (feature-gated) sleap-nn
 *     commands; unused by the app in iteration 1.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined') return;
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') return;
    if (window.__lucidDesktopShimInstalled) return;
    try {
        Object.defineProperty(window, '__lucidDesktopShimInstalled', { value: true, configurable: false });
    } catch (e) {
        return;   // someone already defined it non-configurably: treat as installed
    }

    var CMD = 'plugin:lucid|';
    var MIB = 1024 * 1024;
    var MAX_IPC_CHUNK = 32 * MIB;     // largest raw body sent in one write_chunk
    var BLOB_SLICE = 8 * MIB;         // Blobs are read this much at a time, never whole
    var READ_SLICE = 8 * MIB;         // getFile() reads in slices of this size
    var GETFILE_MAX = 512 * MIB;      // larger files must go through LUCID's open paths
    var REVOKE_GRACE_MS = 2 * 60 * 1000;
    var LOG = '[lucid-desktop]';

    // ------------------------------------------------------------------
    // invoke
    // ------------------------------------------------------------------

    function toError(e, cmd) {
        if (e instanceof Error) return e;
        if (typeof DOMException !== 'undefined' && e instanceof DOMException) return e;
        var msg = typeof e === 'string' ? e
            : (e && typeof e.message === 'string') ? e.message
                : (function () { try { return JSON.stringify(e); } catch (x) { return String(e); } })();
        if (/^NOT_GRANTED\b/.test(msg)) return new DOMException(msg, 'NotAllowedError');
        var err = new Error(msg);
        err.command = cmd;
        return err;
    }

    /** invoke `plugin:lucid|<name>`; rejections become Error/DOMException (LUCID reads err.message). */
    function call(name, args, options) {
        var cmd = CMD + name;
        var p;
        try {
            p = options === undefined ? internals.invoke(cmd, args === undefined ? {} : args)
                : internals.invoke(cmd, args, options);
        } catch (e) {
            return Promise.reject(toError(e, cmd));
        }
        return Promise.resolve(p).catch(function (e) { throw toError(e, cmd); });
    }

    function toU8(v) {
        if (v instanceof Uint8Array) return v;
        if (v instanceof ArrayBuffer) return new Uint8Array(v);
        if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        if (Array.isArray(v)) return Uint8Array.from(v);
        if (v == null) return new Uint8Array(0);
        throw new TypeError(LOG + ' unexpected binary response');
    }

    function abortError() {
        return new DOMException('The user aborted a request.', 'AbortError');
    }

    // ------------------------------------------------------------------
    // platform + window.lucidDesktop
    // ------------------------------------------------------------------

    var platform = (function () {
        var nav = window.navigator || {};
        var s = String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || '') + ' ' +
            String(nav.userAgent || '');
        if (/Win/i.test(s)) return 'windows';
        if (/Mac|iPhone|iPad/i.test(s)) return 'macos';
        if (/Linux|X11|BSD/i.test(s)) return 'linux';
        return 'unknown';
    })();

    var systemInfoPromise = null;

    function tauriChannelCtor() {
        var t = window.__TAURI__;
        return (t && t.core && typeof t.core.Channel === 'function') ? t.core.Channel : null;
    }

    var lucidDesktop = {
        isDesktop: true,
        fsaWriteOnly: false,
        platform: platform,
        systemInfo: function () {
            if (!systemInfoPromise) {
                systemInfoPromise = call('system_info', {});
                systemInfoPromise.catch(function () { systemInfoPromise = null; });
            }
            return systemInfoPromise;
        },
        revealPath: function (path) { return call('reveal_path', { path: String(path) }); },
        /**
         * Native OK/Cancel dialog → Promise<boolean>. WKWebView implements no JS
         * dialogs (`window.confirm()` returns false at once there), so LUCID's
         * async confirm helpers call this when it exists. `window.confirm` itself
         * is NOT replaced: it is synchronous and a native dialog cannot be.
         */
        confirm: function (message, opts) {
            opts = opts || {};
            return call('ask_dialog', {
                title: opts.title != null ? String(opts.title) : 'LUCID',
                message: String(message == null ? '' : message),
                okLabel: opts.okLabel != null ? String(opts.okLabel) : 'OK',
                cancelLabel: opts.cancelLabel != null ? String(opts.cancelLabel) : 'Cancel',
            }).then(function (ok) { return ok === true; });
        },
        openExternal: function (url) { return call('open_external_url', { url: String(url) }); },
        sleapNn: {
            status: function () { return call('sleap_nn_status', {}); },
            /**
             * Run `program args…` natively, streaming ProcessEvents
             * ({event:'stdout'|'stderr', data:{line}} | {event:'finished', data:{success, code}})
             * to `onEvent`. Resolves to the command's bool result.
             */
            runPythonCommand: function (program, args, onEvent) {
                var Channel = tauriChannelCtor();
                if (!Channel) return Promise.reject(new Error(LOG + ' window.__TAURI__.core.Channel is unavailable'));
                var channel = new Channel();
                channel.onmessage = function (msg) {
                    if (typeof onEvent !== 'function') return;
                    try { onEvent(msg); } catch (e) { console.error(LOG, 'sleapNn onEvent threw', e); }
                };
                return call('run_python_command', {
                    program: String(program),
                    args: (args || []).map(String),
                    onEvent: channel,
                });
            },
            cancel: function () { return call('cancel_command', {}); },
            detectUv: function () { return call('detect_uv', {}); },
            detectGpu: function () { return call('detect_gpu', {}); },
        },
    };

    // Debug/test aid (non-enumerable): how many Blobs the download router holds.
    Object.defineProperty(lucidDesktop, '_retainedBlobCount', {
        value: function () { return blobsByUrl.size; }, enumerable: false,
    });

    Object.defineProperty(window, 'lucidDesktop', {
        value: lucidDesktop, writable: false, configurable: false, enumerable: true,
    });

    function markDocument() {
        var el = document.documentElement;
        if (!el) return false;
        if (el.dataset.lucidDesktop !== '1') el.dataset.lucidDesktop = '1';
        return true;
    }
    if (!markDocument()) {
        try {
            var mo = new MutationObserver(function () { if (markDocument()) mo.disconnect(); });
            mo.observe(document, { childList: true });
        } catch (e) { /* fall through to DOMContentLoaded */ }
        document.addEventListener('DOMContentLoaded', markDocument);
    }

    // ------------------------------------------------------------------
    // paths
    // ------------------------------------------------------------------

    function sepOf(path) {
        return (/^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)) ? '\\' : '/';
    }
    function joinPath(dir, name) {
        return /[\\/]$/.test(dir) ? dir + name : dir + sepOf(dir) + name;
    }
    function baseName(path) {
        var t = String(path).replace(/[\\/]+$/, '');
        var i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
        var b = i >= 0 ? t.slice(i + 1) : t;
        return b || String(path);
    }
    function checkEntryName(name) {
        if (typeof name !== 'string' || name === '' || name === '.' || name === '..' ||
            /[\\/\0]/.test(name)) {
            throw new TypeError("Name is not allowed: '" + String(name) + "'");
        }
    }

    var MIME_BY_EXT = {
        json: 'application/json', txt: 'text/plain', csv: 'text/csv', toml: 'application/toml',
        yaml: 'application/yaml', yml: 'application/yaml', html: 'text/html', xml: 'application/xml',
        mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
        webm: 'video/webm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        svg: 'image/svg+xml', pdf: 'application/pdf', zip: 'application/zip',
        h5: 'application/x-hdf5', hdf5: 'application/x-hdf5', stl: 'model/stl', glb: 'model/gltf-binary',
    };
    function extOf(name) {
        var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
        return m ? m[1].toLowerCase() : '';
    }
    function mimeFor(name) { return MIME_BY_EXT[extOf(name)] || ''; }

    // ------------------------------------------------------------------
    // native write session (FileSystemWritableFileStream semantics)
    // ------------------------------------------------------------------

    var leakRegistry = (typeof FinalizationRegistry === 'function')
        ? new FinalizationRegistry(function (id) {
            // A writable dropped without close()/abort(): discard its temp file.
            call('write_abort', { id: id }).catch(function () { /* already gone */ });
        })
        : null;

    function isPosInt(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n; }

    function blobBytes(blob) {
        if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
        return new Response(blob).arrayBuffer();
    }

    /**
     * One native write session. `apply(chunk)` implements the
     * FileSystemWritableFileStream chunk semantics: a cursor starting at 0 (even
     * with keepExistingData, per spec), writes at the cursor (or at
     * `position`), seek, truncate (clamping the cursor). Every byte goes to Rust
     * as a positioned raw-body write_chunk of at most 32 MiB.
     */
    function NativeWriteSession(id, initialSize) {
        this.id = id;
        this.pos = 0;
        this.size = initialSize || 0;
        this.finished = false;
    }
    NativeWriteSession.open = function (path, keepExistingData) {
        return call('write_open', { path: path, keepExistingData: !!keepExistingData }).then(function (r) {
            var id = r && typeof r === 'object' ? r.id : r;
            var session = new NativeWriteSession(id, 0);
            if (!keepExistingData) return session;
            return call('path_stat', { path: path }).then(function (st) {
                session.size = st && st.exists && st.isFile ? Number(st.size) || 0 : 0;
                return session;
            }, function () { return session; });
        });
    };
    NativeWriteSession.prototype._send = function (bytes, offset) {
        // Send a view only when it spans its whole buffer: the postMessage IPC
        // fallback may serialize the underlying buffer rather than the view.
        var body = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength &&
            bytes.buffer instanceof ArrayBuffer) ? bytes : bytes.slice();
        return call('write_chunk', body, {
            headers: { 'x-lucid-write-id': String(this.id), 'x-lucid-offset': String(offset) },
        });
    };
    NativeWriteSession.prototype._writeBytes = async function (u8) {
        if (u8.byteLength === 0) {
            // A zero-byte write past EOF still extends the file with zeros (spec).
            if (this.pos > this.size) await this._truncate(this.pos);
            return;
        }
        for (var off = 0; off < u8.byteLength; off += MAX_IPC_CHUNK) {
            var piece = u8.subarray(off, Math.min(u8.byteLength, off + MAX_IPC_CHUNK));
            await this._send(piece, this.pos);
            this.pos += piece.byteLength;
            if (this.pos > this.size) this.size = this.pos;
        }
    };
    NativeWriteSession.prototype._writeBlob = async function (blob) {
        var total = blob.size;
        if (total === 0) return this._writeBytes(new Uint8Array(0));
        for (var off = 0; off < total; off += BLOB_SLICE) {
            var ab = await blobBytes(blob.slice(off, Math.min(total, off + BLOB_SLICE)));
            await this._writeBytes(new Uint8Array(ab));
        }
    };
    NativeWriteSession.prototype._writeData = function (data) {
        if (typeof data === 'string') return this._writeBytes(new TextEncoder().encode(data));
        if (data instanceof ArrayBuffer) return this._writeBytes(new Uint8Array(data));
        if (typeof SharedArrayBuffer === 'function' && data instanceof SharedArrayBuffer) {
            return this._writeBytes(new Uint8Array(data).slice());
        }
        if (ArrayBuffer.isView(data)) {
            return this._writeBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        }
        if (typeof Blob !== 'undefined' && data instanceof Blob) return this._writeBlob(data);
        return Promise.reject(new TypeError(
            'The provided value is not of type \'(ArrayBuffer or ArrayBufferView or Blob or USVString or WriteParams)\''));
    };
    NativeWriteSession.prototype._truncate = async function (size) {
        await call('write_truncate', { id: this.id, size: size });
        this.size = size;
        if (this.pos > size) this.pos = size;
    };
    NativeWriteSession.prototype.apply = async function (chunk) {
        if (this.finished) throw new TypeError('The stream is closed.');
        var isParams = chunk !== null && typeof chunk === 'object' && !(chunk instanceof ArrayBuffer) &&
            !ArrayBuffer.isView(chunk) && !(typeof Blob !== 'undefined' && chunk instanceof Blob) &&
            !(typeof SharedArrayBuffer === 'function' && chunk instanceof SharedArrayBuffer);
        if (!isParams) return this._writeData(chunk);
        var type = chunk.type;
        if (type === 'write') {
            if (chunk.position !== undefined && chunk.position !== null) {
                if (!isPosInt(chunk.position)) throw new TypeError('Invalid write position: ' + chunk.position);
                this.pos = chunk.position;
            }
            if (chunk.data === undefined || chunk.data === null) {
                throw new TypeError('write requires a data argument');
            }
            return this._writeData(chunk.data);
        }
        if (type === 'seek') {
            if (!isPosInt(chunk.position)) throw new TypeError('seek requires a position argument');
            this.pos = chunk.position;
            return;
        }
        if (type === 'truncate') {
            if (!isPosInt(chunk.size)) throw new TypeError('truncate requires a size argument');
            return this._truncate(chunk.size);
        }
        throw new TypeError('Invalid write command type: ' + String(type));
    };
    NativeWriteSession.prototype.commit = async function () {
        if (this.finished) throw new TypeError('The stream is closed.');
        this.finished = true;
        return call('write_commit', { id: this.id });
    };
    NativeWriteSession.prototype.abort = async function () {
        if (this.finished) return;
        this.finished = true;
        try { await call('write_abort', { id: this.id }); } catch (e) { /* best effort */ }
    };

    /**
     * The writable returned by createWritable(): a real WritableStream subclass
     * (mediabunny's StreamTarget checks `instanceof WritableStream` and writes
     * `{type:'write', data, position}` through getWriter()). The stream's queue
     * serializes every chunk, so writes land in call order. close() commits
     * (the temp file is renamed over the target); abort() discards it.
     */
    var NativeWritableFileStream = null;
    if (typeof WritableStream === 'function') {
        try {
            NativeWritableFileStream = class NativeWritableFileStream extends WritableStream {
                constructor(session) {
                    super({
                        write: function (chunk) {
                            return session.apply(chunk).catch(function (err) {
                                // A failed write errors the stream; never leave its temp behind.
                                if (leakRegistry) leakRegistry.unregister(session);
                                return session.abort().then(function () { throw err; });
                            });
                        },
                        close: function () {
                            if (leakRegistry) leakRegistry.unregister(session);
                            return session.commit().then(function () { /* resolves undefined */ });
                        },
                        abort: function () {
                            if (leakRegistry) leakRegistry.unregister(session);
                            return session.abort();
                        },
                    });
                    if (leakRegistry) leakRegistry.register(this, session.id, session);
                }
                // Like FileSystemWritableFileStream: take the writer, QUEUE the chunk,
                // release the lock at once, return the write's promise. Overlapping
                // un-awaited write()/seek()/truncate()/close() calls then queue in
                // call order instead of throwing "locked".
                write(data) {
                    var w;
                    try { w = this.getWriter(); } catch (e) { return Promise.reject(e); }
                    var p = w.write(data);
                    w.releaseLock();
                    return p;
                }
                seek(position) { return this.write({ type: 'seek', position: position }); }
                truncate(size) { return this.write({ type: 'truncate', size: size }); }
            };
        } catch (e) {
            NativeWritableFileStream = null;   // no subclassable WritableStream
        }
    }

    // ------------------------------------------------------------------
    // handles
    // ------------------------------------------------------------------

    function defineHandleBasics(obj, kind, path) {
        Object.defineProperty(obj, 'kind', { value: kind, enumerable: true });
        Object.defineProperty(obj, 'name', { value: baseName(path), enumerable: true });
        Object.defineProperty(obj, 'path', { value: path, enumerable: false });
    }
    function sameEntry(a, b) {
        return !!b && typeof b === 'object' && b.kind === a.kind && typeof b.path === 'string' && b.path === a.path;
    }
    function granted() { return Promise.resolve('granted'); }

    function NativeFileHandle(path) { defineHandleBasics(this, 'file', path); }
    NativeFileHandle.prototype.createWritable = function (opts) {
        if (!NativeWritableFileStream) {
            return Promise.reject(new DOMException('This webview has no WritableStream', 'NotSupportedError'));
        }
        return NativeWriteSession.open(this.path, !!(opts && opts.keepExistingData)).then(function (session) {
            return new NativeWritableFileStream(session);
        });
    };
    NativeFileHandle.prototype.getFile = async function () {
        var path = this.path, name = this.name;
        var st = await call('path_stat', { path: path });
        if (!st || !st.exists) throw new DOMException('A requested file or directory could not be found: ' + name, 'NotFoundError');
        if (!st.isFile) throw new DOMException(name + ' is not a file', 'TypeMismatchError');
        var size = Number(st.size) || 0;
        if (size > GETFILE_MAX) {
            throw new DOMException('LUCID desktop: ' + name + ' is ' + Math.round(size / MIB) +
                ' MiB; reading a file over ' + (GETFILE_MAX / MIB) + ' MiB through a save handle is not ' +
                'supported. Open it with LUCID\'s Open/Load commands instead.', 'NotSupportedError');
        }
        var parts = [];
        var off = 0;
        while (off < size) {
            var len = Math.min(READ_SLICE, size - off);
            var bytes = toU8(await call('read_range', { path: path, offset: off, length: len }));
            if (bytes.byteLength === 0) break;
            parts.push(bytes);
            off += bytes.byteLength;
        }
        return new File(parts, name, {
            type: mimeFor(name),
            lastModified: Math.round(Number(st.mtimeMs) || Date.now()),
        });
    };
    NativeFileHandle.prototype.isSameEntry = function (other) { return Promise.resolve(sameEntry(this, other)); };
    NativeFileHandle.prototype.queryPermission = granted;
    NativeFileHandle.prototype.requestPermission = granted;

    function NativeDirectoryHandle(path) { defineHandleBasics(this, 'directory', path); }
    NativeDirectoryHandle.prototype.getFileHandle = async function (name, opts) {
        checkEntryName(name);
        var child = joinPath(this.path, name);
        var st = await call('path_stat', { path: child });
        if (st && st.exists) {
            if (!st.isFile) throw new DOMException(name + ' is a directory, not a file', 'TypeMismatchError');
            return new NativeFileHandle(child);
        }
        if (!(opts && opts.create)) {
            throw new DOMException('A requested file or directory could not be found: ' + name, 'NotFoundError');
        }
        // Like the real API, create the (empty) file now.
        var session = await NativeWriteSession.open(child, false);
        await session.commit();
        return new NativeFileHandle(child);
    };
    NativeDirectoryHandle.prototype.getDirectoryHandle = async function (name, opts) {
        checkEntryName(name);
        var child = joinPath(this.path, name);
        var st = await call('path_stat', { path: child });
        if (st && st.exists) {
            if (!st.isDir) throw new DOMException(name + ' is a file, not a directory', 'TypeMismatchError');
            return new NativeDirectoryHandle(child);
        }
        if (!(opts && opts.create)) {
            throw new DOMException('A requested file or directory could not be found: ' + name, 'NotFoundError');
        }
        await call('make_dir', { path: child });
        return new NativeDirectoryHandle(child);
    };
    NativeDirectoryHandle.prototype.removeEntry = function () {
        return Promise.reject(new DOMException('LUCID desktop cannot delete files', 'NotSupportedError'));
    };
    NativeDirectoryHandle.prototype.entries = async function* () {
        var list = await call('list_dir', { path: this.path });
        for (var i = 0; i < (list || []).length; i++) {
            var e = list[i];
            var child = joinPath(this.path, e.name);
            yield [e.name, e.kind === 'directory' ? new NativeDirectoryHandle(child) : new NativeFileHandle(child)];
        }
    };
    NativeDirectoryHandle.prototype.values = async function* () {
        for await (var pair of this.entries()) yield pair[1];
    };
    NativeDirectoryHandle.prototype.keys = async function* () {
        for await (var pair of this.entries()) yield pair[0];
    };
    NativeDirectoryHandle.prototype[Symbol.asyncIterator] = function () { return this.entries(); };
    NativeDirectoryHandle.prototype.isSameEntry = function (other) { return Promise.resolve(sameEntry(this, other)); };
    NativeDirectoryHandle.prototype.queryPermission = granted;
    NativeDirectoryHandle.prototype.requestPermission = granted;
    /** Best effort: the path segments from this directory to `other`, or null. */
    NativeDirectoryHandle.prototype.resolve = function (other) {
        if (!other || typeof other.path !== 'string') return Promise.resolve(null);
        var base = this.path.replace(/[\\/]+$/, '');
        var p = other.path;
        if (p === this.path || p === base) return Promise.resolve([]);
        if (p.length > base.length + 1 && p.slice(0, base.length) === base && /[\\/]/.test(p.charAt(base.length))) {
            return Promise.resolve(p.slice(base.length + 1).split(/[\\/]+/).filter(Boolean));
        }
        return Promise.resolve(null);
    };

    // ------------------------------------------------------------------
    // 2. picker polyfills (only where the webview lacks the API)
    // ------------------------------------------------------------------

    function typesToFilters(types) {
        var filters = [];
        (Array.isArray(types) ? types : []).forEach(function (t) {
            var exts = [];
            var accept = (t && t.accept) || {};
            Object.keys(accept).forEach(function (mime) {
                var v = accept[mime];
                (Array.isArray(v) ? v : [v]).forEach(function (e) {
                    if (typeof e === 'string' && e.replace(/^\./, '')) {
                        var x = e.replace(/^\./, '');
                        if (exts.indexOf(x) < 0) exts.push(x);
                    }
                });
            });
            if (exts.length) {
                filters.push({
                    name: (t && t.description) || exts.map(function (x) { return '.' + x; }).join(', '),
                    extensions: exts,
                });
            }
        });
        return filters;
    }

    if (typeof window.showSaveFilePicker !== 'function' && NativeWritableFileStream) {
        var defineFn = function (name, fn) {
            Object.defineProperty(window, name, { value: fn, writable: true, configurable: true, enumerable: false });
        };
        defineFn('showSaveFilePicker', function showSaveFilePicker(opts) {
            opts = opts || {};
            var args = { filters: typesToFilters(opts.types) };
            if (typeof opts.suggestedName === 'string' && opts.suggestedName) args.suggestedName = opts.suggestedName;
            return call('pick_save_path', args).then(function (path) {
                if (!path) throw abortError();
                return new NativeFileHandle(String(path));
            });
        });
        defineFn('showDirectoryPicker', function showDirectoryPicker(opts) {
            var title = (opts && opts.mode === 'readwrite') ? 'Choose a folder to save into' : 'Choose a folder';
            return call('pick_directory', { title: title }).then(function (path) {
                if (!path) throw abortError();
                return new NativeDirectoryHandle(String(path));
            });
        });
        lucidDesktop.fsaWriteOnly = true;
    }

    // ------------------------------------------------------------------
    // 3. download routing
    // ------------------------------------------------------------------

    var blobsByUrl = new Map();   // blob: URL -> {blob, revoked, timer}
    var origCreateObjectURL = URL.createObjectURL;
    var origRevokeObjectURL = URL.revokeObjectURL;
    if (typeof origCreateObjectURL === 'function') {
        URL.createObjectURL = function (obj) {
            var url = origCreateObjectURL.apply(URL, arguments);
            if (typeof Blob !== 'undefined' && obj instanceof Blob) {
                blobsByUrl.set(url, { blob: obj, revoked: false, consumed: false, timer: null });
            }
            return url;
        };
    }
    if (typeof origRevokeObjectURL === 'function') {
        URL.revokeObjectURL = function (url) {
            var entry = blobsByUrl.get(url);
            if (entry && entry.consumed) {
                blobsByUrl.delete(url);   // a download already holds it: nothing to keep
            } else if (entry && !entry.revoked) {
                // Not grabbed by a download yet: keep the Blob a while in case one
                // still comes for this URL.
                entry.revoked = true;
                entry.timer = setTimeout(function () { blobsByUrl.delete(url); }, REVOKE_GRACE_MS);
            }
            return origRevokeObjectURL.apply(URL, arguments);
        };
    }

    function takeBlob(url) {
        var entry = blobsByUrl.get(url);
        if (!entry) return null;
        if (entry.revoked) {   // consumed AND revoked: release it now, not at the grace timeout
            clearTimeout(entry.timer);
            blobsByUrl.delete(url);
        } else {
            entry.consumed = true;   // dropped as soon as the page revokes the URL
        }
        return entry.blob;
    }

    function percentDecodeBytes(s) {
        var out = [];
        var enc = new TextEncoder();
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            if (c === '%' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
                out.push(parseInt(s.substr(i + 1, 2), 16));
                i += 2;
            } else {
                var cp = s.codePointAt(i);
                if (cp > 0xffff) i++;
                var b = enc.encode(String.fromCodePoint(cp));
                for (var k = 0; k < b.length; k++) out.push(b[k]);
            }
        }
        return new Uint8Array(out);
    }

    function dataUrlToBlob(href) {
        var comma = href.indexOf(',');
        if (comma < 0) throw new TypeError('Malformed data: URL');
        var meta = href.slice(5, comma);
        var payload = href.slice(comma + 1);
        var isB64 = /;base64$/i.test(meta);
        var mime = meta.replace(/;base64$/i, '').split(';')[0] || 'text/plain';
        var bytes;
        if (isB64) {
            var bin = atob(decodeURIComponent(payload).replace(/\s+/g, ''));
            bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
            bytes = percentDecodeBytes(payload);
        }
        return new Blob([bytes], { type: mime });
    }

    function nameFromUrl(href) {
        try {
            var u = new URL(href, document.baseURI);
            if (u.protocol === 'blob:' || u.protocol === 'data:') return 'download';
            var seg = decodeURIComponent(u.pathname.split('/').pop() || '');
            return seg || 'download';
        } catch (e) {
            return 'download';
        }
    }

    function filtersForName(name) {
        var ext = extOf(name);
        return ext ? [{ name: ext.toUpperCase() + ' file', extensions: [ext] }] : [];
    }

    function isDownloadAnchor(a) {
        if (!a || !a.hasAttribute) return false;
        if (a.hasAttribute('download')) return true;
        return /^\s*(blob|data):/i.test(a.getAttribute('href') || '');
    }

    /** Grab the anchor's bytes SYNCHRONOUSLY (the page may revoke right after click). */
    function downloadSource(a) {
        var href = a.href || a.getAttribute('href') || '';
        if (/^blob:/i.test(href)) {
            var blob = takeBlob(href);
            return blob ? { blob: blob } : { url: href };
        }
        if (/^data:/i.test(href)) return { dataUrl: href };
        return { url: href };
    }

    function materialize(source) {
        if (source.blob) return Promise.resolve(source.blob);
        if (source.dataUrl) return Promise.resolve(dataUrlToBlob(source.dataUrl));
        return fetch(source.url).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + source.url);
            return r.blob();
        });
    }

    /** Write `blob` to a native path through the same atomic write session as the pickers. */
    async function writeBlobToPath(path, blob) {
        var session = await NativeWriteSession.open(path, false);
        try {
            await session.apply(blob);
        } catch (err) {
            await session.abort();
            throw err;
        }
        return session.commit();
    }

    function errorText(err) {
        var m = err && typeof err.message === 'string' && err.message ? err.message : String(err);
        return m.replace(/^NOT_GRANTED:\s*/, 'LUCID was not given access to ');
    }

    function routeDownload(a) {
        var suggested = a.getAttribute('download') || nameFromUrl(a.href || a.getAttribute('href') || '');
        var source = downloadSource(a);
        var path = null;
        (async function () {
            path = await call('pick_save_path', { suggestedName: suggested, filters: filtersForName(suggested) });
            if (!path) return;   // cancelled: nothing to do
            var blob = await materialize(source);
            source = null;
            await writeBlobToPath(String(path), blob);
            console.info(LOG + ' saved ' + suggested + ' (' + blob.size + ' bytes) to ' + path);
        })().catch(function (err) {
            // The page has already reported success (it only clicked a link): say
            // natively that the file was NOT saved, which file, and why.
            console.error(LOG + ' saving ' + suggested + ' failed:', err);
            var name = path ? baseName(String(path)) : suggested;
            call('message_dialog', {
                title: 'Could not save ' + name,
                message: 'LUCID could not save "' + name + '"' + (path ? ' to ' + path : '') +
                    '. The file was not saved.\n\n' + errorText(err),
                kind: 'error',
            }).catch(function (e2) { console.error(LOG + ' could not show the error dialog:', e2); });
        });
    }

    // ------------------------------------------------------------------
    // 4. external links
    // ------------------------------------------------------------------

    function externalUrl(href) {
        if (href == null || href === '') return null;
        var u;
        try { u = new URL(String(href), document.baseURI); } catch (e) { return null; }
        if (u.protocol === 'mailto:') return u.href;
        if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== window.location.origin) return u.href;
        return null;
    }
    function opensNewWindow(a) {
        var t = (a.getAttribute('target') || '').trim().toLowerCase();
        return t !== '' && t !== '_self' && t !== '_parent' && t !== '_top';
    }
    function openExternalQuiet(url) {
        lucidDesktop.openExternal(url).catch(function (err) {
            console.error(LOG + ' opening ' + url + ' failed:', err);
        });
    }

    var origWindowOpen = window.open;
    window.open = function (url) {
        var ext = externalUrl(url);
        if (ext) { openExternalQuiet(ext); return null; }
        return origWindowOpen.apply(window, arguments);
    };

    /** true when the anchor was handled here (caller must not run the default). */
    function handleAnchor(a) {
        if (isDownloadAnchor(a)) { routeDownload(a); return true; }
        var href = a.getAttribute('href');
        if (href) {
            var ext = externalUrl(a.href);
            if (ext && (opensNewWindow(a) || /^mailto:/i.test(ext))) { openExternalQuiet(ext); return true; }
        }
        return false;
    }

    if (typeof HTMLAnchorElement === 'function') {
        // Detached anchors (`a.click()` without appending, as LUCID's file-io.js helpers do)
        // dispatch to no document listener, so the method itself is patched too.
        var origAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            if (handleAnchor(this)) return;
            return origAnchorClick.apply(this, arguments);
        };
    }
    document.addEventListener('click', function (e) {
        if (e.defaultPrevented) return;
        if (typeof e.button === 'number' && e.button !== 0) return;
        var t = e.target;
        if (t && t.nodeType !== 1) t = t.parentElement;
        var a = t && typeof t.closest === 'function' ? t.closest('a[href]') : null;
        if (!a || !(a instanceof HTMLAnchorElement)) return;
        if (handleAnchor(a)) e.preventDefault();
    }, true);

    // ------------------------------------------------------------------
    // 5. close guard
    // ------------------------------------------------------------------

    /**
     * Ask the page whether it has unsaved work, the way a browser does: a
     * cancelable `beforeunload`. LUCID's handler (ui/ui-wiring.js) calls
     * preventDefault() AND sets returnValue = ''; a page may also only set
     * returnValue to a message, or return one from window.onbeforeunload. A
     * plain Event would coerce returnValue to a boolean, so the property is
     * shadowed on the instance to see what was assigned.
     */
    function pageHasUnsavedWork() {
        var ev = new Event('beforeunload', { cancelable: true });
        var assigned = false, assignedValue;
        try {
            Object.defineProperty(ev, 'returnValue', {
                configurable: true,
                get: function () { return assigned ? assignedValue : !ev.defaultPrevented; },
                set: function (v) { assigned = true; assignedValue = v; },
            });
        } catch (e) { /* keep the native accessor */ }
        var handlerResult;
        var prop = window.onbeforeunload;
        if (typeof prop === 'function') {
            window.onbeforeunload = function (e) { handlerResult = prop.call(this, e); return undefined; };
        }
        try {
            window.dispatchEvent(ev);
        } finally {
            if (typeof prop === 'function') window.onbeforeunload = prop;
        }
        if (ev.defaultPrevented) return true;
        if (assigned && (assignedValue === false || (typeof assignedValue === 'string' && assignedValue !== ''))) return true;
        if (typeof handlerResult === 'string' || handlerResult === false) return true;
        return false;
    }

    var closeInFlight = false;
    function onCloseRequested() {
        // Acknowledge at once ("JS is alive"): Rust force-closes only on a second
        // close request >5 s after an UNACKNOWLEDGED one (hung-page escape hatch),
        // so a user who picks Cancel and closes again later is asked again.
        call('set_close_guard', { enabled: true }).catch(function (err) {
            console.error(LOG + ' close guard acknowledgement failed:', err);
        });
        if (closeInFlight) return;
        closeInFlight = true;
        (async function () {
            var dirty = false;
            try { dirty = pageHasUnsavedWork(); } catch (e) { console.error(LOG, 'beforeunload probe failed', e); }
            if (dirty) {
                var ok = await call('ask_dialog', {
                    title: 'Unsaved changes',
                    message: 'LUCID has unsaved changes. Close anyway?',
                    okLabel: 'Close',
                    cancelLabel: 'Cancel',
                });
                if (!ok) return;
            }
            await call('confirm_close', {});
        })().catch(function (err) {
            console.error(LOG + ' close request failed:', err);
        }).then(function () { closeInFlight = false; });
    }

    function whenEventApi(cb) {
        var tries = 0;
        (function poll() {
            var t = window.__TAURI__;
            if (t && t.event && typeof t.event.listen === 'function') { cb(t.event); return; }
            if (++tries > 400) {   // ~20 s: no event API, so never prevent closing
                console.warn(LOG + ' window.__TAURI__.event is unavailable; close guard not enabled');
                return;
            }
            setTimeout(poll, 50);
        })();
    }

    function startCloseGuard() {
        whenEventApi(function (eventApi) {
            Promise.resolve()
                .then(function () { return eventApi.listen('lucid://close-requested', onCloseRequested); })
                .then(function () { return call('set_close_guard', { enabled: true }); })
                .catch(function (err) { console.error(LOG + ' close guard setup failed:', err); });
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startCloseGuard, { once: true });
    } else {
        startCloseGuard();
    }
})();
