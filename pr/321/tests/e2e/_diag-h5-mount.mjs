/**
 * _diag-h5-mount.mjs — is WORKERFS available on the main thread?
 *
 * `openFromFile` in the vendored sleap-io bundle mounts a picked File via
 * WORKERFS (lazy, file-backed, no copy) *if available*, and otherwise falls back
 * to `file.arrayBuffer()` + `fs.writeFile` — copying the WHOLE file into
 * h5wasm's WASM heap, which is hard-capped at 2 GiB (`getHeapMax`).
 *
 * For the real 1.4 GB project that fallback would consume ~70% of the WASM heap
 * for the lifetime of the session, leaving too little for the writer to build an
 * output file — which is what a save-after-reload has to do.
 *
 * Not a test. Usage: node _diag-h5-mount.mjs [port]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.argv[2] || 8104);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] });
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.h5wasm !== undefined || window.__lucid, { timeout: 20000 });

    const r = await page.evaluate(async () => {
        const out = {};
        // The app exposes h5wasm as a global (index.html <script>), and the ESM
        // build is importable too — check whichever is present.
        let mod = window.h5wasm;
        if (mod && typeof mod.ready?.then === 'function') mod = await mod.ready;
        if (!mod) {
            try {
                const m = await import('/lib/h5wasm/hdf5_hl.js');
                mod = await m.ready;
                out.via = 'esm';
            } catch (e) { out.importErr = String(e).slice(0, 200); }
        } else {
            out.via = 'global';
        }
        if (!mod) return out;

        const FS = mod.FS || (window.h5wasm && window.h5wasm.FS);
        out.hasFS = !!FS;
        out.hasMount = !!(FS && FS.mount);
        out.filesystems = FS && FS.filesystems ? Object.keys(FS.filesystems) : null;
        out.hasWORKERFS = !!(FS && FS.filesystems && FS.filesystems.WORKERFS);

        // Can we actually mount one? (availability != it works on this thread)
        if (out.hasWORKERFS) {
            try {
                const f = new File([new Uint8Array(16)], 'probe.bin');
                FS.mkdir('/__probe');
                FS.mount(FS.filesystems.WORKERFS, { files: [f] }, '/__probe');
                out.mountWorks = true;
                FS.unmount('/__probe'); FS.rmdir('/__probe');
            } catch (e) {
                out.mountWorks = false;
                out.mountErr = String(e && e.message || e).slice(0, 200);
                try { FS.rmdir('/__probe'); } catch (e2) {}
            }
        }
        out.isWorker = typeof WorkerGlobalScope !== 'undefined';
        out.wasmHeapMB = mod.HEAPU8 ? +(mod.HEAPU8.length / 1048576).toFixed(0) : null;
        return out;
    });

    console.log(JSON.stringify(r, null, 2));
    console.log('\n  WORKERFS available :', r.hasWORKERFS);
    console.log('  WORKERFS mounts    :', r.mountWorks);
    console.log(r.mountWorks
        ? '\n=> Picked Files mount lazily; no full copy into the 2 GiB WASM heap.'
        : '\n=> FALLBACK PATH: the whole file is copied into the WASM heap on open.');
} catch (e) {
    console.error('FATAL', String(e).slice(0, 400));
} finally {
    if (browser) await browser.close();
    server.kill();
}
