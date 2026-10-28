/**
 * test-module-specifiers-resolve.mjs — every relative module reference in the
 * app names a file that exists, resolved the way the BROWSER resolves it.
 *
 * A dynamic `import()` or a worker URL is only fetched when its code path runs,
 * so a wrong path ships silently until that path is taken. `ensureSleapIO`
 * (`import-export/save-load.js`) imported `'./lib/sleap-io/index.browser.js'`
 * for months: a specifier resolves against the IMPORTING MODULE, so that named
 * `import-export/lib/…`, which does not exist. It only ran when the
 * `window.SleapIO` bridge in `index.html` was missing, so it never visibly
 * failed — esbuild found it during a bundling experiment.
 *
 * Covered, with the base each one resolves against:
 *   - `import … from '…'`, `export … from '…'`, side-effect `import '…'` and
 *     `import('…')`                         → the file containing it
 *   - `new URL('…', import.meta.url)`        → the file containing it
 *   - `new URL('…', document.baseURI)`       → the repo root (index.html's dir)
 *   - module `<script>` bodies in index.html → the repo root
 * A literal query (`'x.js?v=' + Date.now()`) is dropped before the lookup.
 * Bare specifiers (`'h5wasm'`) and absolute URLs are the importmap's / CDN's
 * business and are skipped. Comments are scanned too: a JSDoc
 * `{import('./x.js').T}` naming a moved file is stale as well.
 *
 * Run:  node tests/test-module-specifiers-resolve.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIRS = ['pose', 'ui', 'loading', 'import-export'];
const APP_FILES = ['app.js', 'demo-data.js'];

let passed = 0, failed = 0; const failures = [];
function check(ok, m) {
    if (ok) passed++;
    else { failed++; failures.push(m); console.error('  ✗ ' + m); }
}

const REL = /^\.{1,2}\//;
/**
 * Every relative reference in `text`, as {spec, base: 'file'|'root', line}.
 * Exported shape kept local; the negative control below calls it on a string.
 */
function scan(text) {
    const out = [];
    const lineOf = (i) => text.slice(0, i).split('\n').length;
    const push = (spec, base, i) => out.push({ spec: spec.replace(/[?#].*$/, ''), base, line: lineOf(i) });
    let m;
    // from '…' / import '…' / import('…')
    const imp = /\b(?:from|import)\s*\(?\s*(['"])([^'"`\s]+)\1/g;
    while ((m = imp.exec(text))) if (REL.test(m[2])) push(m[2], 'file', m.index);
    // new URL('…', import.meta.url | document.baseURI)
    const url = /\bnew\s+URL\(\s*(['"])([^'"`\s]+)\1\s*(?:\+[^,]*)?,\s*(import\.meta\.url|document\.baseURI)\b/g;
    while ((m = url.exec(text))) {
        if (/^[a-z][\w+.-]*:|^\/\//i.test(m[2])) continue;   // absolute URL
        push(m[2], m[3] === 'document.baseURI' ? 'root' : 'file', m.index);
    }
    return out;
}

function resolveRef(ref, fileDir) {
    return path.resolve(ref.base === 'root' ? ROOT : fileDir, ref.spec);
}
const isFile = (p) => existsSync(p) && statSync(p).isFile();

function walk(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (/\.m?js$/.test(e.name)) out.push(p);
    }
    return out;
}

// ── 1. Every app module ─────────────────────────────────────────────────────
const files = [...APP_DIRS.flatMap(d => walk(path.join(ROOT, d))), ...APP_FILES.map(f => path.join(ROOT, f))];
check(files.length > 100, `found the app modules (${files.length})`);
let refs = 0, dynamic = 0, workers = 0;
for (const f of files) {
    const text = readFileSync(f, 'utf-8');
    for (const ref of scan(text)) {
        refs++;
        const target = resolveRef(ref, path.dirname(f));
        check(isFile(target),
            `${path.relative(ROOT, f)}:${ref.line} references '${ref.spec}' → ${path.relative(ROOT, target)}, which does not exist`);
    }
    dynamic += (text.match(/\bimport\(\s*['"]\.{1,2}\//g) || []).length;
    workers += (text.match(/\bnew\s+URL\(\s*['"]/g) || []).length;
}
// Guards against a scanner that silently matches nothing.
check(refs > 300, `scanned a plausible number of references (${refs})`);
check(dynamic >= 2, `saw relative dynamic import()s (${dynamic})`);
check(workers >= 5, `saw new URL(...) worker/module URLs (${workers})`);

// ── 2. index.html's inline module scripts (base = repo root) ────────────────
{
    const html = readFileSync(path.join(ROOT, 'index.html'), 'utf-8').replace(/<!--[\s\S]*?-->/g, '');
    const bodies = [...html.matchAll(/<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    check(bodies.length > 0, 'found index.html module scripts');
    for (const body of bodies) {
        for (const ref of scan(body)) {
            const target = path.resolve(ROOT, ref.spec);
            check(isFile(target), `index.html module script references '${ref.spec}', which does not exist`);
        }
    }
}

// ── 3. Negative controls: the scanner catches the bug it was written for ─────
{
    const bad = "async function ensureSleapIO() {\n    var mod = await import('./lib/sleap-io/index.browser.js');\n}";
    const r = scan(bad);
    check(r.length === 1 && r[0].spec === './lib/sleap-io/index.browser.js' && r[0].line === 2,
        'negative control: the pre-fix ensureSleapIO specifier is scanned');
    check(!isFile(resolveRef(r[0], path.join(ROOT, 'import-export'))),
        'negative control: the pre-fix specifier does NOT resolve from import-export/');
    check(isFile(resolveRef({ spec: '../lib/sleap-io/index.browser.js', base: 'file' }, path.join(ROOT, 'import-export'))),
        'the fixed specifier resolves from import-export/');
    const w = scan("new Worker(new URL('loading/nope-worker.js?v=' + Date.now(), document.baseURI))");
    check(w.length === 1 && w[0].base === 'root' && w[0].spec === 'loading/nope-worker.js'
        && !isFile(resolveRef(w[0], ROOT)),
        'negative control: a missing document.baseURI worker URL is caught, query dropped');
    check(scan("import('h5wasm'); import('https://cdn.example/x.js'); new URL('https://x/y.js', import.meta.url)").length === 0,
        'bare and absolute specifiers are skipped');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.error('  - ' + f); process.exit(1); }
