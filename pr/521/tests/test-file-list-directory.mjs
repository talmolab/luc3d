/**
 * test-file-list-directory.mjs — `loading/file-list-directory.js`
 * (`directoryHandleFromFileList`), the read-only directory-handle stand-in that
 * lets the handle-based folder readers (Load Multiple Sessions) run on a
 * `webkitdirectory` pick, plus `canReadDirectoryHandles` (`ui/browser-hints.js`),
 * which decides when they must.
 *
 * Files are fake File-likes ({name, webkitRelativePath}): the module only reads
 * those two fields, and `getFile()` must hand back the SAME object (the
 * original, disk-backed File), which identity checks prove.
 */
import { directoryHandleFromFileList, FileListDirectoryHandle } from '../loading/file-list-directory.js';
import { canReadDirectoryHandles } from '../ui/browser-hints.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
async function rejects(promise, name, msg) {
    try { await promise; check(false, msg + ' (did not reject)'); }
    catch (e) { check(e && e.name === name, msg + ` (${e && e.name})`); }
}

const file = (rel) => ({ name: rel.split('/').pop(), webkitRelativePath: rel, size: rel.length });

// A multi-session parent folder, listed in a deliberately shuffled order.
const files = [
    file('parent/sessB/cam1/0.mp4'),
    file('parent/skeleton.json'),
    file('parent/sessA/calibration.toml'),
    file('parent/sessA/cam1/0.mp4'),
    file('parent/sessA/cam0/0.mp4'),
    file('parent/sessA/cam0/labels.v001.slp'),
    file('parent/sessB/calibration.toml'),
    file('parent/notes/deep/deeper/readme.txt'),
];

console.log('\n1. Root and kinds');
const root = directoryHandleFromFileList(files);
check(root instanceof FileListDirectoryHandle, 'returns a directory handle');
check(root.kind === 'directory', 'root kind is directory');
check(root.name === 'parent', `root is the picked folder, named by the first path segment (${root.name})`);

console.log('\n2. Entries are sorted by name, files and folders together');
{
    const ents = [];
    for await (const [n, h] of root.entries()) ents.push(n + ':' + h.kind);
    check(ents.join(',') === 'notes:directory,sessA:directory,sessB:directory,skeleton.json:file',
        `entries() (${ents})`);
    const keys = [];
    for await (const k of root.keys()) keys.push(k);
    check(keys.join(',') === 'notes,sessA,sessB,skeleton.json', 'keys() in the same order');
    const vals = [];
    for await (const v of root.values()) vals.push(v.name);
    check(vals.join(',') === keys.join(','), 'values() in the same order');
    const viaIter = [];
    for await (const [n] of root) viaIter.push(n);
    check(viaIter.join(',') === keys.join(','), '[Symbol.asyncIterator] is entries()');
}

console.log('\n3. Nested folders and getFile');
{
    const sessA = await root.getDirectoryHandle('sessA');
    check(sessA.kind === 'directory' && sessA.name === 'sessA', 'getDirectoryHandle(sessA)');
    const names = [];
    for await (const [n, h] of sessA) names.push(n + ':' + h.kind);
    check(names.join(',') === 'calibration.toml:file,cam0:directory,cam1:directory', `sessA lists (${names})`);
    const cam0 = await sessA.getDirectoryHandle('cam0');
    const slp = await cam0.getFileHandle('labels.v001.slp');
    check(slp.kind === 'file' && slp.name === 'labels.v001.slp', 'getFileHandle in a nested folder');
    check(await slp.getFile() === files[5], 'getFile() returns the ORIGINAL File object');
    const deep = await (await (await root.getDirectoryHandle('notes')).getDirectoryHandle('deep')).getDirectoryHandle('deeper');
    const readme = await deep.getFileHandle('readme.txt');
    check(await readme.getFile() === files[7], 'four levels down');
    check(JSON.stringify(await root.resolve(readme)) === '["notes","deep","deeper","readme.txt"]',
        'resolve() gives the path from the root');
    check(await sessA.resolve(readme) === null, 'resolve() is null outside the folder');
    check(await slp.isSameEntry(await cam0.getFileHandle('labels.v001.slp')), 'isSameEntry on the same file');
}

console.log('\n4. Errors');
{
    await rejects(root.getFileHandle('missing.txt'), 'NotFoundError', 'getFileHandle: not found -> NotFoundError');
    await rejects(root.getDirectoryHandle('missing'), 'NotFoundError', 'getDirectoryHandle: not found -> NotFoundError');
    await rejects(root.getFileHandle('sessA'), 'TypeMismatchError', 'getFileHandle on a folder -> TypeMismatchError');
    await rejects(root.getDirectoryHandle('skeleton.json'), 'TypeMismatchError',
        'getDirectoryHandle on a file -> TypeMismatchError');
    await rejects(root.getFileHandle('new.txt', { create: true }), 'NotAllowedError', 'create: true -> NotAllowedError');
    await rejects(root.removeEntry('skeleton.json'), 'NotAllowedError', 'removeEntry -> NotAllowedError');
    const sk = await root.getFileHandle('skeleton.json');
    await rejects(sk.createWritable(), 'NotAllowedError', 'createWritable -> NotAllowedError');
    check(await root.queryPermission({ mode: 'read' }) === 'granted', 'read permission granted');
    check(await root.queryPermission({ mode: 'readwrite' }) === 'denied', 'readwrite permission denied');
}

console.log('\n5. The walk Load Multiple Sessions does (enumerateDirectoryHandle\'s shape)');
{
    async function walk(dir, prefix) {
        const out = [];
        for await (const [name, h] of dir) {
            const rel = prefix + '/' + name;
            if (h.kind === 'file') out.push(rel + '=' + ((await h.getFile()).webkitRelativePath));
            else out.push(...await walk(h, rel));
        }
        return out;
    }
    const sessB = await root.getDirectoryHandle('sessB');
    const got = await walk(sessB, 'sessB');
    check(got.join(';') === 'sessB/calibration.toml=parent/sessB/calibration.toml;sessB/cam1/0.mp4=parent/sessB/cam1/0.mp4',
        `walks one session folder (${got.join(';')})`);
}

console.log('\n6. Odd inputs');
{
    const flat = directoryHandleFromFileList([{ name: 'a.txt', webkitRelativePath: '' }, { name: 'b.txt' }]);
    check(flat.name === '' && flat.kind === 'directory', 'files without a relative path: nameless root');
    const ks = []; for await (const k of flat.keys()) ks.push(k);
    check(ks.join(',') === 'a.txt,b.txt', 'holding them by name');
    const two = directoryHandleFromFileList([file('x/1.txt'), file('y/2.txt')]);
    check(two.name === '', 'two top folders: nameless root');
    const ks2 = []; for await (const k of two.keys()) ks2.push(k);
    check(ks2.join(',') === 'x,y', 'holding both');
    const one = directoryHandleFromFileList([file('only.txt')]);
    check(one.name === '' && (await one.getFileHandle('only.txt')).kind === 'file',
        'a lone top-level FILE is not mistaken for the root folder');
    const empty = directoryHandleFromFileList([]);
    const ke = []; for await (const k of empty.keys()) ke.push(k);
    check(empty.kind === 'directory' && ke.length === 0, 'an empty pick is an empty folder');
    check(directoryHandleFromFileList(null).kind === 'directory', 'null is an empty folder');
    const clash = directoryHandleFromFileList([file('p/a'), file('p/a/b.txt')]);
    check((await clash.getFileHandle('a')).kind === 'file', 'a file/folder clash keeps the first, skips the other');
    const dup = [file('p/d.txt'), file('p/d.txt')];
    check(await (await directoryHandleFromFileList(dup).getFileHandle('d.txt')).getFile() === dup[0],
        'a duplicate path keeps the first');
}

console.log('\n7. canReadDirectoryHandles');
{
    const picker = async () => {};
    check(canReadDirectoryHandles({ showDirectoryPicker: picker }) === true, 'plain browser with the API: true');
    check(canReadDirectoryHandles({}) === false, 'no API: false');
    check(canReadDirectoryHandles({ showDirectoryPicker: true }) === false, 'non-function picker: false');
    check(canReadDirectoryHandles({ showDirectoryPicker: picker, lucidDesktop: { isDesktop: true, fsaWriteOnly: true } }) === false,
        'desktop app with the write-only polyfill: false');
    check(canReadDirectoryHandles({ showDirectoryPicker: picker, lucidDesktop: { isDesktop: true, fsaWriteOnly: false } }) === true,
        'desktop app with the native API (WebView2): true');
    check(canReadDirectoryHandles({ lucidDesktop: { isDesktop: true, fsaWriteOnly: true } }) === false,
        'desktop app without any picker: false');
    check(canReadDirectoryHandles() === false, 'Node (no window): false');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
