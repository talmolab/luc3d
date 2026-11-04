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
 *  6. macOS: LUCID's in-page menus (File, Edit, Calibrate, …) mirrored into the
 *     native menu bar (`set_app_menu`; clicks come back as
 *     `window.__lucidNativeMenuAction(key)`), and the in-page ones hidden once
 *     that worked (`<html data-lucid-native-menu="1">`).
 *  7. macOS: a file `<input>` clicked without user activation (WebKit would
 *     drop it) asks for one click in the page instead.
 *  8. Updates: Check for Updates… (macOS luc3d menu / Help menu elsewhere),
 *     a silent check 10 s after start and every 6 h with a small notice, the
 *     update channel, and install-then-restart, never over unsaved work.
 *  `lucidDesktop.sleapNn` — thin wrappers for the (feature-gated) sleap-nn
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
                title: opts.title != null ? String(opts.title) : 'luc3d',
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
            throw new DOMException('luc3d: ' + name + ' is ' + Math.round(size / MIB) +
                ' MiB; reading a file over ' + (GETFILE_MAX / MIB) + ' MiB through a save handle is not ' +
                'supported. Open it with luc3d\'s Open/Load commands instead.', 'NotSupportedError');
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
        return Promise.reject(new DOMException('luc3d cannot delete files', 'NotSupportedError'));
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
        return m.replace(/^NOT_GRANTED:\s*/, 'luc3d was not given access to ');
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
                message: 'luc3d could not save "' + name + '"' + (path ? ' to ' + path : '') +
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
                    message: 'luc3d has unsaved changes. Close anyway?',
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
    // ------------------------------------------------------------------
    // 6. macOS: LUCID's menus in the native menu bar
    // ------------------------------------------------------------------

    /*
     * The in-page menu bar (#menuBar) is read into a spec
     *   [{label, items: [{key, label, enabled, checked?, submenu?} | {separator: true}]}]
     * and sent with `set_app_menu`; Rust builds
     *   luc3d | File | Edit | Calibrate | Tracks | View | Hot Keys | Window | Help.
     * A native click calls window.__lucidNativeMenuAction(key) through WKWebView's
     * evaluateJavaScript (a forced user gesture), which clicks the same element
     * a user would have: same handlers, so a new in-page item works natively
     * with no extra wiring. Once Rust has installed the bar, `<html
     * data-lucid-native-menu="1">` hides the in-page menus; never before, so a
     * failure leaves the page its own menus. The bar itself stays while it holds
     * anything else (Edit Group / assignment toasts); the build label moves to
     * About luc3d.
     *
     * Reading the DOM: a top-level `.menu-item` with a `.menu-dropdown` is a
     * menu; one without (Hot Keys) acts on click, so it becomes a menu with one
     * item; `.menu-bar-button`s (Docs, Settings) repeat Help items and are left
     * out. In a dropdown: `.menu-separator`; `.menu-dropdown-item` (its own
     * `.menu-dropdown` is a submenu; a `.trail-check` tick or aria-checked makes
     * it a check item; `.disabled`, aria-disabled or pointer-events:none
     * disables it, as body.origin-mode-lock does to the whole bar); a wrapper
     * holding items is walked through; any other element with text is a
     * heading (shown, inert). Hidden items are left out. Shortcut hints are
     * not part of a label, and items get no native accelerators: LUCID's own
     * key handler has them.
     *
     * Kept current: a debounced resend on any change under #menuBar or of
     * <body>'s class, after input, and on a slow poll (some state behind a
     * label or tick, such as the frame rate or the zoom, changes no menu DOM).
     * LUCID refreshes such labels when a menu OPENS, on `mouseenter` of the
     * top-level `.menu-item` or of a `.has-submenu` parent; native menus have
     * no open event the page could see, so that cue is given before every
     * read. Only a changed spec is sent.
     */
    var NATIVE_MENU_ACTION = '__lucidNativeMenuAction';
    var MENU_SYNC_DEBOUNCE_MS = 50;
    var MENU_INPUT_DEBOUNCE_MS = 150;
    var MENU_POLL_MS = 750;
    var SKIP_IN_LABEL = '.shortcut-hint, .shortcut, .submenu-arrow, .trail-check, .trail-shade-swatch, .menu-dropdown';
    var nm = {
        keys: new Map(), observer: null, timer: null, sending: false, again: false,
        lastSent: null, lastFailed: null, installed: false, stopped: false,
    };

    function styleOf(el) {
        try { return window.getComputedStyle(el); } catch (e) { return null; }
    }

    /** An element's visible text, without shortcut hints, ticks, arrows or nested menus. */
    function menuLabel(el) {
        var text = '';
        (function walk(node) {
            for (var c = node.firstChild; c; c = c.nextSibling) {
                if (c.nodeType === 3) { text += c.data; continue; }
                if (c.nodeType !== 1 || c.hidden || c.matches(SKIP_IN_LABEL)) continue;
                // A right-floated span is a shortcut hint too (File ▸ Save's "Ctrl+S").
                // Read inline: WebKit computes float as none on a flex item.
                if (c.style && (c.style.cssFloat || c.style.float) === 'right') continue;
                var st = styleOf(c);
                if (st && st.display === 'none') continue;
                text += ' ';
                walk(c);
                text += ' ';
            }
        })(el);
        return text.replace(/\s+/g, ' ').trim().replace(/\.\.\.$/, '…');
    }

    function menuEntryHidden(el) {
        if (el.hidden) return true;
        var st = styleOf(el);
        return !!st && st.display === 'none';
    }

    function menuEntryEnabled(el) {
        if (el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true' ||
            el.hasAttribute('disabled')) return false;
        // pointer-events:none on the entry or any ancestor (body.origin-mode-lock
        // sets it on the whole bar). Each ancestor is asked: inside a
        // display:none subtree WebKit can report a stale inherited value.
        for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
            var st = styleOf(n);
            if (st && st.pointerEvents === 'none') return false;
        }
        return true;
    }

    /** true/false for a check item, undefined for a plain one. */
    function menuEntryChecked(el) {
        var aria = el.getAttribute('aria-checked');
        if (aria === 'true' || aria === 'false') return aria === 'true';
        var tick = el.querySelector(':scope > .trail-check, :scope > span > .trail-check');
        if (tick) return tick.textContent.trim() !== '';
        return undefined;
    }

    function menuKey(el, path) {
        var key = (el.id && document.getElementById(el.id) === el) ? el.id : 'path:' + path;
        if (nm.keys.has(key)) key = 'path:' + path;
        nm.keys.set(key, el);
        return key;
    }

    function menuEntries(container, path) {
        var out = [];
        var kids = container.children;
        for (var i = 0; i < kids.length; i++) {
            var c = kids[i];
            if (menuEntryHidden(c)) continue;
            var p = path + '.' + i;
            if (c.classList.contains('menu-separator')) { out.push({ separator: true }); continue; }
            if (c.classList.contains('menu-dropdown-item')) {
                var spec = { key: menuKey(c, p), label: menuLabel(c), enabled: menuEntryEnabled(c) };
                var sub = c.querySelector(':scope > .menu-dropdown');
                if (sub) {
                    spec.submenu = menuEntries(sub, p);
                } else {
                    var checked = menuEntryChecked(c);
                    if (checked !== undefined) spec.checked = checked;
                }
                out.push(spec);
                continue;
            }
            if (c.querySelector('.menu-dropdown-item, .menu-separator')) {
                Array.prototype.push.apply(out, menuEntries(c, p));   // a role=group wrapper
                continue;
            }
            var heading = menuLabel(c);
            if (heading) out.push({ label: heading, enabled: false });
        }
        return out;
    }

    function collectLabels(items, into) {
        items.forEach(function (it) {
            if (it.label) into.add(it.label);
            if (it.submenu) collectLabels(it.submenu, into);
        });
        return into;
    }

    /** {menus, about} for set_app_menu, rebuilding the key → element map. */
    function buildMenuSpec(bar) {
        nm.keys = new Map();
        var entries = [];
        var kids = bar.children;
        for (var i = 0; i < kids.length; i++) {
            var el = kids[i];
            // Not menuEntryHidden: our own CSS hides these once the native bar is up.
            if (!el.classList.contains('menu-item') || el.hidden || el.style.display === 'none') continue;
            var label = menuLabel(el);
            if (!label) continue;
            var dropdown = el.querySelector(':scope > .menu-dropdown');
            if (dropdown) {
                entries.push({ label: label, items: menuEntries(dropdown, 'm' + i) });
            } else {
                entries.push({
                    label: label,
                    button: el.classList.contains('menu-bar-button'),
                    items: [{ key: menuKey(el, 'm' + i), label: 'Show ' + label, enabled: menuEntryEnabled(el) }],
                });
            }
        }
        var inMenus = new Set();
        entries.forEach(function (e) { if (!e.button) collectLabels(e.items, inMenus); });
        var menus = entries
            .filter(function (e) { return !(e.button && inMenus.has(e.label)); })
            .map(function (e) { return { label: e.label, items: e.items }; });
        var v = document.getElementById('menuBarVersion');
        var vText = v && !v.hidden ? (v.textContent || '').trim() : '';
        return { menus: menus, about: vText ? { text: vText, title: v.title || '' } : null };
    }

    /** What a pointer opening each menu would make LUCID refresh (see above). */
    function cueMenuOpen(bar) {
        var els = bar.querySelectorAll(':scope > .menu-item, .has-submenu');
        for (var i = 0; i < els.length; i++) {
            try {
                els[i].dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: false }));
            } catch (e) { console.error(LOG + ' menu refresh threw', e); }
        }
    }

    /** `data-lucid-menus-only` on the bar while it holds nothing but menus and the build label. */
    function markMenusOnly(bar) {
        var only = true;
        for (var i = 0; i < bar.children.length; i++) {
            var cl = bar.children[i].classList;
            if (!cl.contains('menu-item') && !cl.contains('menu-bar-version')) { only = false; break; }
        }
        if (only !== bar.hasAttribute('data-lucid-menus-only')) {
            if (only) bar.setAttribute('data-lucid-menus-only', '');
            else bar.removeAttribute('data-lucid-menus-only');
        }
    }

    function setNativeMenuInstalled(on) {
        nm.installed = on;
        var root = document.documentElement;
        if (on) root.dataset.lucidNativeMenu = '1';
        else delete root.dataset.lucidNativeMenu;
    }

    function scheduleMenuSync(delay) {
        if (nm.stopped || nm.timer) return;
        nm.timer = setTimeout(function () {
            nm.timer = null;
            syncNativeMenu();
        }, delay == null ? MENU_SYNC_DEBOUNCE_MS : delay);
    }

    function syncNativeMenu() {
        if (nm.stopped) return;
        if (nm.sending) { nm.again = true; return; }
        var bar = document.getElementById('menuBar');
        if (!bar) return;
        cueMenuOpen(bar);
        if (nm.observer) nm.observer.takeRecords();   // the cue's own rewrites
        var payload = buildMenuSpec(bar);
        var json = JSON.stringify(payload);
        if ((nm.installed && json === nm.lastSent) || json === nm.lastFailed) return;
        nm.sending = true;
        call('set_app_menu', payload).then(function (ok) {
            if (ok !== true) {
                // Not macOS after all: the page keeps its own menus, for good.
                nm.stopped = true;
                setNativeMenuInstalled(false);
                return;
            }
            nm.lastSent = json;
            nm.lastFailed = null;
            setNativeMenuInstalled(true);
        }, function (err) {
            console.error(LOG + ' the native menu bar was not updated; showing the in-page menus:', err);
            nm.lastFailed = json;
            nm.lastSent = null;
            setNativeMenuInstalled(false);
        }).then(function () {
            nm.sending = false;
            if (nm.again) { nm.again = false; scheduleMenuSync(); }
        });
    }

    /** A native menu click (called by Rust inside evaluateJavaScript). */
    function nativeMenuAction(key) {
        var el = nm.keys.get(String(key));
        if (!el || !el.isConnected || !menuEntryEnabled(el)) {
            scheduleMenuSync(0);   // the native copy is stale
            return false;
        }
        // Synchronously, inside the evaluateJavaScript call: its forced user
        // gesture is what lets a file picker opened by the handler appear.
        el.click();
        scheduleMenuSync();
        return true;
    }

    function startNativeMenu() {
        if (platform !== 'macos' || typeof document.getElementById !== 'function' ||
            typeof MutationObserver !== 'function') return;
        var bar = document.getElementById('menuBar');
        if (!bar) return;   // not LUCID
        Object.defineProperty(window, NATIVE_MENU_ACTION, {
            value: nativeMenuAction, writable: false, configurable: false, enumerable: false,
        });
        var style = document.createElement('style');
        style.id = 'lucid-native-menu-style';
        // The menus hide; so does the build label (it is in About luc3d now).
        // The bar itself hides unless it holds something else: Edit Group and
        // manual assignment put their toast (with its buttons) in it.
        // (data-lucid-menus-only rather than :has(), which older WKWebViews lack.)
        style.textContent =
            'html[data-lucid-native-menu="1"] #menuBar > .menu-item,' +
            'html[data-lucid-native-menu="1"] #menuBar > .menu-bar-version,' +
            'html[data-lucid-native-menu="1"] #menuBar[data-lucid-menus-only] { display: none !important; }\n';
        (document.head || document.documentElement).appendChild(style);
        markMenusOnly(bar);
        nm.observer = new MutationObserver(function () {
            markMenusOnly(bar);   // synchronously: a toast shows before the next paint
            scheduleMenuSync();
        });
        nm.observer.observe(bar, { subtree: true, childList: true, attributes: true, characterData: true });
        if (document.body) nm.observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        ['pointerup', 'keyup', 'wheel'].forEach(function (type) {
            window.addEventListener(type, function () { scheduleMenuSync(MENU_INPUT_DEBOUNCE_MS); },
                { capture: true, passive: true });
        });
        setInterval(function () {
            if (document.visibilityState !== 'hidden') scheduleMenuSync(0);
        }, MENU_POLL_MS);
        scheduleMenuSync(0);
    }

    // ------------------------------------------------------------------
    // 7. macOS: file pickers that lost their user activation
    // ------------------------------------------------------------------

    /**
     * WebKit opens an `<input type=file>` panel only with transient user
     * activation (FileInputType::handleDOMActivateEvent consumes it); without
     * it the click is dropped silently and LUCID would wait forever. A native
     * menu click has activation only while the shim's synchronous `el.click()`
     * runs (WKWebView's evaluateJavaScript forces a user gesture, and apps
     * built against the macOS 14+ SDK lose it when the script returns), so a
     * handler that awaits before picking would be dropped. Here such a click
     * becomes a one-button prompt in the page whose Choose click is the
     * gesture. A click that has activation opens the panel directly, as before.
     */
    var pickerPrompt = null;   // {input, close}

    function needsPickerGesture() {
        var ua = window.navigator && window.navigator.userActivation;
        return !!ua && ua.isActive === false;
    }

    function askForPickerGesture(input, origClick) {
        if (pickerPrompt) pickerPrompt.close(false);
        var folder = !!input.webkitdirectory;
        var overlay = document.createElement('div');
        overlay.className = 'multi-frame-modal-overlay';
        overlay.id = 'lucidPickerGesture';
        var modal = document.createElement('div');
        modal.className = 'multi-frame-modal';
        modal.style.maxWidth = '420px';
        var h = document.createElement('h3');
        h.textContent = folder ? 'Choose a folder' : (input.multiple ? 'Choose files' : 'Choose a file');
        var p = document.createElement('p');
        p.textContent = 'Click Choose to open the ' + (folder ? 'folder' : 'file') + ' chooser.';
        var actions = document.createElement('div');
        actions.className = 'modal-actions';
        var cancel = document.createElement('button');
        cancel.id = 'lucidPickerCancel';
        cancel.textContent = 'Cancel';
        var choose = document.createElement('button');
        choose.id = 'lucidPickerChoose';
        choose.className = 'primary';
        choose.textContent = folder ? 'Choose Folder…' : 'Choose…';
        actions.appendChild(cancel);
        actions.appendChild(choose);
        modal.appendChild(h);
        modal.appendChild(p);
        modal.appendChild(actions);
        overlay.appendChild(modal);

        function close(open) {
            document.removeEventListener('keydown', onKey, true);
            if (overlay.parentNode) overlay.remove();
            if (pickerPrompt && pickerPrompt.input === input) pickerPrompt = null;
            // Inside the click (or Return) handler: this call has activation.
            if (open) origClick.call(input);
            else input.dispatchEvent(new Event('cancel'));   // pickFiles/pickFolder resolve empty
        }
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
            else if (e.key === 'Enter' && e.target !== cancel) { e.preventDefault(); e.stopPropagation(); close(true); }
        }
        cancel.addEventListener('click', function () { close(false); });
        choose.addEventListener('click', function () { close(true); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(false); });
        document.addEventListener('keydown', onKey, true);
        (document.body || document.documentElement).appendChild(overlay);
        try { choose.focus(); } catch (e) { /* not focusable yet */ }
        pickerPrompt = { input: input, close: close };
    }

    function installPickerGestureFallback() {
        if (platform !== 'macos' || typeof HTMLInputElement !== 'function') return;
        var proto = HTMLInputElement.prototype;
        var origClick = proto.click;
        proto.click = function () {
            if (this.type === 'file' && !this.disabled && needsPickerGesture()) {
                askForPickerGesture(this, origClick);
                return;
            }
            return origClick.apply(this, arguments);
        };
    }
    installPickerGestureFallback();

    // ------------------------------------------------------------------
    // 8. Updates
    // ------------------------------------------------------------------

    /*
     * Rust (src/updates.rs) picks the manifest for the channel, verifies the
     * signature and installs; this part owns the conversation:
     *   - Check for Updates… (macOS: luc3d menu, via __lucidUpdates.menu('check');
     *     Windows/Linux: added to the page's Help menu): up to date → a note;
     *     newer → "Install and restart?".
     *   - Never with unsaved work: pageHasUnsavedWork() before offering, again
     *     after the question and again right before restarting.
     *   - Install: a progress card (LUCID's own card classes) with downloaded /
     *     total, then restart_app.
     *   - Automatically 10 s after start and every 6 h: silent unless there is
     *     something new, then a small dismissible notice, once per version per
     *     run.
     *   - Update Channel ▸ X (macOS menu): set_update_channel, then a check that
     *     also offers an OLDER version (allowDowngrade), so leaving dev for
     *     stable offers stable.
     */
    var UPDATE_TIMING = window.__lucidUpdateCheckTiming || {};   // test aid
    var UPDATE_FIRST_CHECK_MS = UPDATE_TIMING.first != null ? UPDATE_TIMING.first : 10 * 1000;
    var UPDATE_EVERY_MS = UPDATE_TIMING.every != null ? UPDATE_TIMING.every : 6 * 3600 * 1000;
    var up = { user: false, silent: null, noticed: new Set(), notice: null };

    function updateMessage(message, kind) {
        return call('message_dialog', { title: 'luc3d', message: message, kind: kind || 'info' })
            .catch(function (err) { console.error(LOG + ' could not show a dialog:', err, message); });
    }

    function blockedByUnsavedWork() {
        var dirty = false;
        try { dirty = pageHasUnsavedWork(); } catch (e) { console.error(LOG, 'beforeunload probe failed', e); dirty = true; }
        if (dirty) updateMessage('Save your project first, then choose Check for Updates again.', 'warning');
        return dirty;
    }

    function formatMB(bytes) { return (bytes / MIB).toFixed(1) + ' MB'; }

    /** The install card: LUCID's progress-card look, blocking the page while it shows. */
    function updateProgressCard(version) {
        var overlay = document.createElement('div');
        overlay.className = 'loading-overlay';
        overlay.id = 'lucidUpdateProgress';
        overlay.style.zIndex = '10050';
        var card = document.createElement('div');
        card.className = 'loading-card';
        card.setAttribute('role', 'status');
        var title = document.createElement('h3');
        title.className = 'loading-title';
        title.textContent = 'Updating luc3d to ' + version;
        var line = document.createElement('div');
        line.className = 'loading-line';
        line.id = 'lucidUpdateStatus';
        line.textContent = 'Downloading…';
        var bar = document.createElement('div');
        bar.className = 'loading-progress';
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        var track = document.createElement('div');
        track.className = 'loading-progress-track';
        var fill = document.createElement('div');
        fill.className = 'loading-progress-fill';
        fill.id = 'lucidUpdateFill';
        track.appendChild(fill);
        bar.appendChild(track);
        card.appendChild(title);
        card.appendChild(line);
        card.appendChild(bar);
        overlay.appendChild(card);
        (document.body || document.documentElement).appendChild(overlay);
        return {
            progress: function (done, total) {
                var frac = total ? Math.min(1, done / total) : 0;
                fill.style.transform = 'scaleX(' + frac + ')';
                bar.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
                line.textContent = 'Downloading… ' + formatMB(done) + (total ? ' of ' + formatMB(total) : '');
            },
            status: function (text) { line.textContent = text; },
            close: function () { if (overlay.parentNode) overlay.remove(); },
        };
    }

    async function installUpdate(found, allowDowngrade) {
        var Channel = tauriChannelCtor();
        if (!Channel) throw new Error('window.__TAURI__.core.Channel is unavailable');
        var card = updateProgressCard(found.version);
        var channel = new Channel();
        channel.onmessage = function (msg) {
            if (!msg) return;
            if (msg.event === 'progress' && msg.data) card.progress(msg.data.downloaded || 0, msg.data.total || 0);
            else if (msg.event === 'installed') card.status('Installed. Restarting…');
        };
        try {
            await call('install_update', { expectedVersion: found.version, allowDowngrade: !!allowDowngrade, onEvent: channel });
        } catch (err) {
            card.close();
            await updateMessage('The update could not be installed.\n\n' + errorText(err), 'error');
            return;
        }
        card.status('Installed. Restarting…');
        var dirty = true;
        try { dirty = pageHasUnsavedWork(); } catch (e) { /* treat as dirty */ }
        if (dirty) {
            card.close();
            await updateMessage('luc3d ' + found.version + ' is installed. Save your project, then quit and reopen luc3d to use it.', 'warning');
            return;
        }
        await call('restart_app', {});
    }

    /** "Install and restart?" for a found update (refusing with unsaved work). */
    async function offerUpdate(found, allowDowngrade) {
        if (blockedByUnsavedWork()) return;
        var ok = await lucidDesktop.confirm(
            'luc3d ' + found.version + ' is available (you have ' + found.currentVersion + ', ' +
            found.channel + ' channel). Install and restart?',
            { title: 'Update available', okLabel: 'Install and Restart', cancelLabel: 'Later' });
        if (!ok || blockedByUnsavedWork()) return;
        hideUpdateNotice();
        await installUpdate(found, allowDowngrade);
    }

    function hideUpdateNotice() {
        if (up.notice && up.notice.parentNode) up.notice.remove();
        up.notice = null;
    }

    function showUpdateNotice(found) {
        if (up.noticed.has(found.version)) return;
        up.noticed.add(found.version);
        hideUpdateNotice();
        var box = document.createElement('div');
        box.id = 'lucidUpdateNotice';
        box.setAttribute('role', 'status');
        box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:10040;display:flex;align-items:center;' +
            'gap:10px;padding:10px 12px;border-radius:8px;font-size:13px;' +
            'background:var(--bg-secondary,#252526);color:var(--text-primary,#ddd);' +
            'border:1px solid var(--border-color,#444);box-shadow:0 8px 32px rgba(0,0,0,.5)';
        var text = document.createElement('span');
        text.textContent = 'luc3d ' + found.version + ' is available';
        var install = document.createElement('button');
        install.id = 'lucidUpdateInstall';
        install.className = 'primary';
        install.textContent = 'Install…';
        var later = document.createElement('button');
        later.id = 'lucidUpdateLater';
        later.textContent = 'Later';
        install.addEventListener('click', function () {
            hideUpdateNotice();
            runUpdateFlow(function () { return offerUpdate(found, false); });
        });
        later.addEventListener('click', hideUpdateNotice);
        box.appendChild(text);
        box.appendChild(install);
        box.appendChild(later);
        (document.body || document.documentElement).appendChild(box);
        up.notice = box;
    }

    /**
     * One user-facing update conversation at a time (a second click while one
     * is open does nothing); it waits for a background check in flight rather
     * than being dropped. A background check is skipped while anything runs.
     */
    function runUpdateFlow(fn, silent) {
        var log = function (err) {
            (silent ? console.warn : console.error)(LOG + ' update ' + (silent ? 'check' : '') + ' failed:', err);
        };
        if (silent) {
            if (up.user || up.silent) return Promise.resolve(false);
            up.silent = Promise.resolve().then(fn).catch(log).then(function () { up.silent = null; return true; });
            return up.silent;
        }
        if (up.user) return Promise.resolve(false);
        up.user = true;
        return Promise.resolve(up.silent).then(fn).catch(log).then(function () { up.user = false; return true; });
    }

    /** opts: {silent, allowDowngrade}. */
    function checkForUpdates(opts) {
        opts = opts || {};
        return runUpdateFlow(async function () {
            var info = await call('get_update_info', {});
            if (!info || !info.updaterConfigured) {
                if (!opts.silent) await updateMessage('This build of luc3d cannot update itself.', 'info');
                return;
            }
            var found;
            try {
                found = await call('check_update', { allowDowngrade: !!opts.allowDowngrade });
            } catch (err) {
                if (!opts.silent) await updateMessage('Could not check for updates.\n\n' + errorText(err), 'error');
                return;
            }
            if (!found) {
                if (!opts.silent) {
                    await updateMessage('luc3d ' + info.currentVersion + ' is up to date (' + info.channel + ' channel).', 'info');
                }
                return;
            }
            if (opts.silent) { showUpdateNotice(found); return; }
            await offerUpdate(found, !!opts.allowDowngrade);
        }, !!opts.silent);
    }

    async function switchUpdateChannel(channel) {
        try {
            await call('set_update_channel', { channel: channel });
        } catch (err) {
            await updateMessage('Could not switch the update channel.\n\n' + errorText(err), 'error');
            return;
        }
        await checkForUpdates({ allowDowngrade: true });
    }

    /** Native menu items (macOS) call this through evaluateJavaScript. */
    function updatesMenuAction(action) {
        action = String(action || '');
        if (action === 'check') { checkForUpdates({}); return true; }
        if (action.indexOf('channel:') === 0) { switchUpdateChannel(action.slice(8)); return true; }
        return false;
    }

    /** Windows/Linux: Help ▸ Check for Updates… in the page's own menu. */
    function addHelpMenuUpdateItem() {
        if (platform === 'macos') return;   // in the native luc3d menu there
        var help = document.getElementById('menuHelp');
        if (!help || document.getElementById('menuCheckUpdates')) return;
        var item = document.createElement('div');
        item.className = 'menu-dropdown-item';
        item.id = 'menuCheckUpdates';
        item.textContent = 'Check for Updates…';
        item.addEventListener('click', function () { checkForUpdates({}); });
        help.appendChild(item);
    }

    function startUpdates() {
        Object.defineProperty(window, '__lucidUpdates', {
            value: Object.freeze({ menu: updatesMenuAction }),
            writable: false, configurable: false, enumerable: false,
        });
        try { addHelpMenuUpdateItem(); } catch (e) { console.error(LOG + ' Help menu update item:', e); }
        var auto = function () { checkForUpdates({ silent: true }); };
        setTimeout(auto, UPDATE_FIRST_CHECK_MS);
        if (UPDATE_EVERY_MS > 0) setInterval(auto, UPDATE_EVERY_MS);
    }

    function onDocumentReady() {
        startCloseGuard();
        try { startNativeMenu(); } catch (e) { console.error(LOG + ' native menu setup failed; the in-page menus stay:', e); }
        try { startUpdates(); } catch (e) { console.error(LOG + ' update checks not started:', e); }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onDocumentReady, { once: true });
    } else {
        onDocumentReady();
    }
})();
