/**
 * test-desktop-shim-inert.mjs — Node checks of the desktop init script
 * (`src-tauri/js/lucid-desktop.js`) that need no browser:
 *
 *   1. it parses as a CLASSIC script (the Rust shell injects it as an
 *      initialization script: no `import`/`export`, no top-level await);
 *   2. with no `window.__TAURI_INTERNALS__` it touches nothing (the web build
 *      could load a copy of it and nothing would change);
 *   3. with a stub Tauri runtime it installs `window.lucidDesktop` once and a
 *      second run is a no-op (idempotent).
 *
 * The real behaviour (pickers, writes, downloads, close guard) is covered in a
 * browser by tests/e2e/desktop-shim-fsa.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'js', 'lucid-desktop.js'), 'utf8');

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

// 1. classic-script syntax
let script;
try { script = new vm.Script(SRC, { filename: 'lucid-desktop.js' }); check(true, 'parses as a classic script'); } catch (e) {
    check(false, 'parses as a classic script: ' + e.message);
}
check(!/^\s*(import|export)\s/m.test(SRC), 'no import/export statements');

// 2. inert without __TAURI_INTERNALS__
if (script) {
    const win = {};
    const ctx = vm.createContext({ window: win, URL: { createObjectURL() {}, revokeObjectURL() {} } });
    const createBefore = ctx.URL.createObjectURL;
    script.runInContext(ctx);
    check(Object.keys(win).length === 0 && ctx.URL.createObjectURL === createBefore,
        'without __TAURI_INTERNALS__ nothing is defined or patched');
}

// 3. installs once with a stub runtime; second run is a no-op
if (script) {
    const listeners = [];
    const calls = [];
    class FakeEl { constructor() { this.dataset = {}; } }
    const document = {
        documentElement: new FakeEl(),
        readyState: 'complete',
        baseURI: 'http://localhost:1234/',
        addEventListener: (t, f) => listeners.push(t),
    };
    function HTMLAnchorElement() {}
    HTMLAnchorElement.prototype.click = function () {};
    const win = {
        __TAURI_INTERNALS__: { invoke: (cmd, args) => { calls.push(cmd); return Promise.resolve(null); } },
        navigator: { platform: 'MacIntel', userAgent: 'x' },
        location: { origin: 'http://localhost:1234' },
        open() { return null; },
    };
    const ctx = vm.createContext({
        window: win, document, HTMLAnchorElement, navigator: win.navigator,
        URL: class { static createObjectURL() { return 'blob:x'; } static revokeObjectURL() {} },
        Blob: class {}, TextEncoder, setTimeout, clearTimeout, console, Promise, Map,
        DOMException: class extends Error { constructor(m, n) { super(m); this.name = n; } },
        WritableStream: class { constructor() {} },
    });
    win.document = document;
    script.runInContext(ctx);
    const ld = win.lucidDesktop;
    check(!!ld && ld.isDesktop === true && ld.platform === 'macos', 'installs window.lucidDesktop (platform from navigator)');
    check(ld && ld.fsaWriteOnly === true && typeof win.showSaveFilePicker === 'function' && typeof win.showDirectoryPicker === 'function',
        'without the native API: picker polyfills installed, fsaWriteOnly true');
    check(document.documentElement.dataset.lucidDesktop === '1', 'marks <html data-lucid-desktop="1">');
    const clickAfterFirst = HTMLAnchorElement.prototype.click;
    const sspAfterFirst = win.showSaveFilePicker;
    const nListeners = listeners.length;
    script.runInContext(ctx);
    check(win.lucidDesktop === ld && HTMLAnchorElement.prototype.click === clickAfterFirst &&
        win.showSaveFilePicker === sspAfterFirst && listeners.length === nListeners, 'a second run changes nothing (idempotent)');
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
