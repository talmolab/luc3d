/**
 * file-list-directory.js — a read-only stand-in for a File System Access
 * directory handle, built from the files an `<input webkitdirectory>` returns.
 *
 * Why: LUCID's folder readers that need to look at a folder's TREE (Load
 * Multiple Sessions: which subfolders are sessions, a parent skeleton .json)
 * walk a `FileSystemDirectoryHandle`. Where the browser cannot give a READ
 * handle — Safari and Firefox have no `showDirectoryPicker`, and the desktop
 * app's WebKit webviews have only a write-capable polyfill
 * (`window.lucidDesktop.fsaWriteOnly`) whose handles cannot produce
 * disk-backed `File`s — the folder is picked with `webkitdirectory` instead,
 * and this module turns that flat list back into a tree with the same shape,
 * so the handle-based code runs unchanged on top of it.
 *
 * `getFile()` returns the ORIGINAL `File` from the input: disk-backed, so the
 * WORKERFS / FileReaderSync / blob-URL readers stream it without copying.
 *
 * What it mimics (the read half of FileSystemDirectoryHandle /
 * FileSystemFileHandle): `kind`, `name`, `entries()`, `keys()`, `values()`,
 * `[Symbol.asyncIterator]` (= entries), `getDirectoryHandle(name)`,
 * `getFileHandle(name)`, `resolve(handle)`, `isSameEntry(handle)`,
 * `queryPermission` / `requestPermission` ('granted' for read, 'denied' for
 * readwrite), and `getFile()` on files. Writes (`{create: true}`,
 * `removeEntry`, `createWritable`) reject with NotAllowedError.
 *
 * Order: a directory lists its entries sorted by name (code-unit order), so a
 * walk is the same whatever order the OS handed the files in. (Real handles
 * promise no order either; every caller that cares sorts.)
 *
 * Limits of the source: `webkitdirectory` lists files only, so an EMPTY folder
 * is absent from the tree. Paths are split on '/' (every browser's
 * `webkitRelativePath` separator, Windows included).
 *
 * DOM-free and import-free (Node tests load it directly).
 */

function domError(name, message) {
    if (typeof DOMException === 'function') {
        try { return new DOMException(message, name); } catch (e) { /* fall through */ }
    }
    var err = new Error(message);
    err.name = name;
    return err;
}

function sortedNames(map) {
    return Array.from(map.keys()).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
}

function permissionFor(desc) {
    return (desc && desc.mode === 'readwrite') ? 'denied' : 'granted';
}

/**
 * A read-only file handle over one picked `File`.
 */
export class FileListFileHandle {
    constructor(name, file, parent) {
        this.kind = 'file';
        this.name = name;
        this._file = file;
        this._parent = parent || null;
    }
    /** The original, disk-backed File from the input. */
    async getFile() { return this._file; }
    async createWritable() { throw domError('NotAllowedError', 'This folder was opened read-only.'); }
    async createSyncAccessHandle() { throw domError('NotAllowedError', 'This folder was opened read-only.'); }
    async isSameEntry(other) { return other === this; }
    async queryPermission(desc) { return permissionFor(desc); }
    async requestPermission(desc) { return permissionFor(desc); }
}

/**
 * A read-only directory handle over the picked files under one folder.
 */
export class FileListDirectoryHandle {
    constructor(name, parent) {
        this.kind = 'directory';
        this.name = name;
        this._parent = parent || null;
        this._children = new Map();   // name -> handle
    }

    async *entries() {
        var names = sortedNames(this._children);
        for (var i = 0; i < names.length; i++) yield [names[i], this._children.get(names[i])];
    }
    async *keys() {
        var names = sortedNames(this._children);
        for (var i = 0; i < names.length; i++) yield names[i];
    }
    async *values() {
        var names = sortedNames(this._children);
        for (var i = 0; i < names.length; i++) yield this._children.get(names[i]);
    }
    [Symbol.asyncIterator]() { return this.entries(); }

    _child(name, kind, opts) {
        if (opts && opts.create) {
            return Promise.reject(domError('NotAllowedError', 'This folder was opened read-only.'));
        }
        var h = this._children.get(String(name));
        if (!h) {
            return Promise.reject(domError('NotFoundError',
                'No ' + (kind === 'file' ? 'file' : 'folder') + ' named "' + name + '" in "' + this.name + '".'));
        }
        if (h.kind !== kind) {
            return Promise.reject(domError('TypeMismatchError',
                '"' + name + '" in "' + this.name + '" is a ' + (h.kind === 'file' ? 'file' : 'folder') + '.'));
        }
        return Promise.resolve(h);
    }
    getDirectoryHandle(name, opts) { return this._child(name, 'directory', opts); }
    getFileHandle(name, opts) { return this._child(name, 'file', opts); }
    async removeEntry() { throw domError('NotAllowedError', 'This folder was opened read-only.'); }

    /** Names from this folder down to `other`, or null when it is not inside. */
    async resolve(other) {
        var path = [];
        for (var h = other; h; h = h._parent) {
            if (h === this) return path.reverse();
            path.push(h.name);
        }
        return null;
    }
    async isSameEntry(other) { return other === this; }
    async queryPermission(desc) { return permissionFor(desc); }
    async requestPermission(desc) { return permissionFor(desc); }
}

/**
 * Build a read-only directory tree from a `webkitdirectory` file list.
 *
 * Every file is placed by its `webkitRelativePath` ("parent/session/cam/0.mp4";
 * a file without one, by its `name`). When all files share one top folder — as
 * a `webkitdirectory` pick always does — that folder is returned (its name is
 * the picked folder's). Otherwise a nameless root ('') holding the top-level
 * entries is returned. A path that would put a file where a folder already is
 * (or the reverse) is skipped: a real file system cannot produce one.
 *
 * @param {ArrayLike<File>} files  e.g. `input.files` or `pickFolder()`'s array
 * @returns {FileListDirectoryHandle}
 */
export function directoryHandleFromFileList(files) {
    var root = new FileListDirectoryHandle('', null);
    var list = files ? Array.from(files) : [];
    for (var i = 0; i < list.length; i++) {
        var f = list[i];
        if (!f) continue;
        var rel = (typeof f.webkitRelativePath === 'string' && f.webkitRelativePath) ? f.webkitRelativePath : f.name;
        var parts = String(rel || '').split('/').filter(function (p) { return p !== '' && p !== '.'; });
        if (parts.length === 0) continue;
        var dir = root, ok = true;
        for (var p = 0; p < parts.length - 1; p++) {
            var next = dir._children.get(parts[p]);
            if (!next) {
                next = new FileListDirectoryHandle(parts[p], dir);
                dir._children.set(parts[p], next);
            } else if (next.kind !== 'directory') {
                ok = false;
                break;
            }
            dir = next;
        }
        if (!ok) continue;
        var leaf = parts[parts.length - 1];
        if (dir._children.has(leaf)) continue;
        dir._children.set(leaf, new FileListFileHandle(leaf, f, dir));
    }
    if (root._children.size === 1) {
        var only = root._children.values().next().value;
        if (only.kind === 'directory') {
            only._parent = null;
            return only;
        }
    }
    return root;
}
