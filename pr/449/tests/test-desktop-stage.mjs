/**
 * test-desktop-stage.mjs — scripts/desktop/stage_frontend.py, the frontend the
 * desktop app (src-tauri/) embeds as `frontendDist: "../dist-desktop"`.
 *
 * Stages into a temp directory and checks the result INDEPENDENTLY of the
 * script's own verifier (that is re-checked separately, with negative controls):
 *   1. only runtime files ship: index.html + the app dirs + lib/; no tests/,
 *      scripts/, docs/, sample_session/, src-tauri/, .github/, *.md, launchers,
 *      server.py, test-worker.html, offline-deps.json
 *   2. CDN URLs are pre-rewritten to ./lib/ like the offline bundle: outside lib/
 *      only offline-deps.json's documented `unmapped` URL is left
 *   3. every relative module reference (imports, workers built with
 *      `new URL(…, import.meta.url | document.baseURI)`, importmap entries,
 *      <script src>, <link href>) names a staged file
 *   4. stamp-version ran: lucid-release / lucid-commit filled, ?v= on app.js,
 *      the modulepreload block present
 *   5. --out safety: repo root, empty path, a source dir and a foreign
 *      directory are refused and left untouched; a previous stage is re-wiped
 *   6. --verify-only catches a missing import and an unmapped CDN URL
 *
 * Skips (exit 0, with the reason) when the offline packages cannot be fetched.
 *
 * Run:  node tests/test-desktop-stage.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'desktop', 'stage_frontend.py');
const PY = process.platform === 'win32' ? 'py' : 'python3';
const EXIT_FETCH = 3;

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function group(n) { console.log('\n• ' + n); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-desktop-stage-'));
// Run from an unrelated cwd: the script must find the repo from its own path.
const stage = (...args) => spawnSync(PY, [SCRIPT, ...args], { cwd: tmp, encoding: 'utf8' });

const OUT = path.join(tmp, 'stage');
const LABEL = 'desktop 9.9.9', COMMIT = 'abcdef123456';
const r = stage('--out', OUT, '--label', LABEL, '--commit', COMMIT);
if (r.status === EXIT_FETCH) {
    console.log('SKIP: the offline packages could not be fetched (no network?):');
    console.log((r.stderr || '').trim().split('\n').slice(-3).map(l => '      ' + l).join('\n'));
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
}
if (r.status !== 0) {
    console.error(r.stdout + r.stderr);
    console.error(`FAIL: stage_frontend.py exited ${r.status}`);
    process.exit(1);
}

const walk = (dir, base = dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, base, out);
        else out.push(path.relative(base, p).split(path.sep).join('/'));
    }
    return out;
};
const files = walk(OUT);
const has = (rel) => fs.existsSync(path.join(OUT, rel));
const read = (rel) => fs.readFileSync(path.join(OUT, rel), 'utf8');

group('1. only what the app loads at runtime');
{
    for (const f of ['index.html', 'app.js', 'styles.css', 'demo-data.js', 'pose/initialization.js',
        'loading/slp-import-worker.js', 'import-export/file-io.js', 'ui/sessions-panes.js',
        'icons/favicon-32.png', 'lib/h5wasm/h5wasm.iife.js', 'lib/sleap-io/index.browser.js',
        'lib/three/three.min.js', 'lib/three/OrbitControls.js', 'lib/mp4box/mp4box.all.js',
        'lib/dockview-core/main.esm.mjs', 'lib/dockview-core/dockview.css', 'lib/yaml/browser/index.js',
        'lib/LICENSES.txt', 'lib/three/LICENSE', 'lib/yaml/LICENSE', 'lib/h5wasm/LICENSE.txt'])
        ok(has(f), `${f} is staged`);
    for (const f of ['tests', 'scripts', 'docs', 'sample_session', 'src-tauri', '.github', '.git',
        'server.py', 'test-worker.html', 'offline-deps.json', 'lucid.jpg', 'dist-desktop',
        'README-OFFLINE.txt', 'start-linux.sh', 'start-macos.command', 'start-windows.ps1'])
        ok(!has(f), `${f} is NOT staged`);
    const top = new Set(fs.readdirSync(OUT));
    const allowed = new Set(['index.html', 'app.js', 'styles.css', 'demo-data.js',
        'icons', 'pose', 'ui', 'loading', 'import-export', 'lib']);
    ok([...top].every(n => allowed.has(n)), `top level is only the app (${[...top].sort().join(', ')})`);
    ok(!files.some(f => f.endsWith('.md')), 'no .md file anywhere');
    ok(!files.some(f => path.basename(f) === '.gitignore'), 'no .gitignore anywhere');
    ok(files.length > 200, `a plausible number of files (${files.length})`);
}

group('2. CDN URLs pre-rewritten like the offline bundle');
{
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'offline-deps.json'), 'utf8'));
    const unmapped = new Set(Object.keys(manifest.unmapped || {}));
    // Unreachable defaults inside vendored code (see LIB_UNREACHABLE_CDN in the script).
    const libOk = new Set(['https://unpkg.com/mp4box@0.5.4/dist/mp4box.all.min.js',
        'https://cdn.jsdelivr.net/npm/h5wasm@0.10.2/dist/iife/h5wasm.js']);
    const left = [];
    for (const f of files.filter(f => /\.(html|m?js|css)$/.test(f))) {
        for (const m of read(f).matchAll(/https:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com)\/[^"'\s)]+/g)) {
            const url = m[0].replace(/[;,]+$/, '');
            if (f.startsWith('lib/') ? !libOk.has(url) : !unmapped.has(url)) left.push(`${f}: ${url}`);
        }
    }
    ok(left.length === 0, 'no CDN URL left but the documented ones' + (left.length ? ':\n      ' + left.join('\n      ') : ''));
    const transformers = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm';
    ok(unmapped.has(transformers) && read('ui/image-embedder.js').includes(transformers),
        'the documented unmapped transformers URL is the one left (image ID-switch check is online-only)');
    const html = read('index.html');
    ok(html.includes('"./lib/yaml/browser/index.js?v='), 'importmap yaml → ./lib/yaml/browser/index.js');
    ok(/src="\.\/lib\/three\/three\.min\.js\?v=/.test(html), 'three.js <script> → ./lib/');
    ok(/href="\.\/lib\/dockview-core\/dockview\.css\?v=/.test(html), 'dockview css → ./lib/');
    ok(read('ui/sessions-panes.js').includes("'../lib/dockview-core/main.esm.mjs?v="),
        'ui/ dockview import is depth-relative (../lib/)');
}

group('3. every relative module reference resolves to a staged file');
{
    const strip = (s) => s.replace(/[?#].*$/, '');
    let refs = 0, workers = 0;
    const missing = [];
    const checkRef = (from, spec, baseDir) => {
        if (/^[a-z][\w+.-]*:|^\/\//i.test(spec)) return;              // absolute
        refs++;
        if (spec.startsWith('/')) { missing.push(`${from}: root-absolute ${spec}`); return; }
        const target = path.resolve(baseDir, strip(spec));
        if (!target.startsWith(OUT + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile())
            missing.push(`${from}: ${spec}`);
    };
    for (const f of files.filter(f => /\.m?js$/.test(f))) {
        const text = read(f), dir = path.dirname(path.join(OUT, f));
        for (const m of text.matchAll(/\b(?:from|import)\s*\(?\s*(['"])([^'"`\s]+)\1/g))
            if (/^\.{1,2}\/|^\//.test(m[2])) checkRef(f, m[2], dir);
        for (const m of text.matchAll(/\bnew\s+URL\(\s*(['"])([^'"`\s]+)\1\s*(?:\+[^,]*)?,\s*(import\.meta\.url|document\.baseURI)\b/g)) {
            workers++;
            checkRef(f, m[2], m[3] === 'document.baseURI' ? OUT : dir);
        }
        for (const m of text.matchAll(/\bimportScripts\(\s*(['"])([^'"`\s]+)\1/g)) checkRef(f, m[2], dir);
    }
    const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '');
    const map = JSON.parse(html.match(/<script\b[^>]*type="importmap"[^>]*>([\s\S]*?)<\/script>/)[1]).imports;
    for (const spec of Object.values(map)) checkRef('index.html importmap', spec, OUT);
    for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*(["'])([^"']+)\1/gi))
        checkRef('index.html', m[2], OUT);
    ok(missing.length === 0, 'all resolve' + (missing.length ? ':\n      ' + missing.slice(0, 20).join('\n      ') : ''));
    ok(refs > 500, `scanned a plausible number of references (${refs})`);
    ok(workers >= 8, `saw the worker / module new URL()s (${workers})`);
    for (const w of ['loading/slp-import-worker.js', 'loading/frame-worker.js', 'pose/tracker-worker.js',
        'pose/triangulation-worker.js', 'ui/image-model-worker.js', 'ui/image-crop-worker.js'])
        ok(has(w), `worker ${w} is staged`);
}

group('4. stamped: version label, ?v=, modulepreload');
{
    const html = read('index.html');
    ok(html.includes(`<meta name="lucid-release" content="${LABEL}">`), `lucid-release = "${LABEL}"`);
    ok(html.includes(`<meta name="lucid-commit" content="${COMMIT}">`), `lucid-commit = ${COMMIT}`);
    ok(html.includes(`<script type="module" src="app.js?v=${COMMIT}">`), 'app.js carries ?v=<commit>');
    ok(html.includes('<!-- modulepreload: generated by scripts/preload-modules.mjs -->'), 'modulepreload block present');
    // The repo's own index.html stays unstamped (CLAUDE.md: tags empty in the repo).
    const repoHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    ok(repoHtml.includes('<meta name="lucid-release" content="">'), 'the repo index.html is untouched');
}

group('5. --out safety');
{
    const before = fs.readdirSync(ROOT).sort().join(',');
    for (const [what, out] of [['repo root', ROOT], ['repo root (relative ".")', '.'],
        ['empty path', ''], ['a source dir inside the repo', 'ui'], ['the repo parent', path.dirname(ROOT)],
        ['the filesystem root', path.parse(ROOT).root]]) {
        const rr = stage('--out', out);
        ok(rr.status === 2, `${what} refused (exit ${rr.status}${rr.status === 0 ? ' — WIPED?' : ''})`);
    }
    ok(fs.readdirSync(ROOT).sort().join(',') === before && fs.existsSync(path.join(ROOT, 'ui', 'ui-wiring.js')),
        'the repo is intact');
    const foreign = path.join(tmp, 'foreign');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'precious.txt'), 'keep me');
    const rf = stage('--out', foreign);
    ok(rf.status === 2 && fs.existsSync(path.join(foreign, 'precious.txt')),
        `a foreign non-empty dir outside the repo is refused and untouched (exit ${rf.status})`);
    // A previous stage is re-wiped: a stray file in it must disappear.
    fs.writeFileSync(path.join(OUT, 'ui', 'stale-leftover.js'), '// from an old stage');
    const again = stage('--out', OUT, '--label', LABEL, '--commit', COMMIT);
    ok(again.status === 0, `re-staging over a previous stage succeeds (exit ${again.status})`);
    ok(!has('ui/stale-leftover.js'), 'a leftover from the previous stage is wiped');
}

group('6. --verify-only negative controls');
{
    const bad = path.join(tmp, 'bad');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'index.html'),
        '<html><head><script type="importmap">{"imports":{"x":"./lib/x.js"}}</script>' +
        '<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js"></script></head>' +
        '<body><script type="module" src="app.js"></script></body></html>');
    fs.writeFileSync(path.join(bad, 'app.js'),
        "import './present.js';\nimport { y } from './missing.js';\nimport z from 'not-in-map';\n" +
        "const w = new Worker(new URL('loading/gone-worker.js?v=' + Date.now(), document.baseURI));\n" +
        "const u = 'https://cdn.jsdelivr.net/npm/left@1.0.0/+esm';\n");
    fs.writeFileSync(path.join(bad, 'present.js'), 'export {};\n');
    const rv = spawnSync(PY, [SCRIPT, '--verify-only', bad], { encoding: 'utf8' });
    const err = rv.stderr || '';
    ok(rv.status === 1, `a broken tree fails (exit ${rv.status})`);
    ok(err.includes("'./missing.js'"), 'reports the missing import');
    ok(err.includes("'loading/gone-worker.js?v='") || err.includes('gone-worker.js'), 'reports the missing document.baseURI worker');
    ok(err.includes("'./lib/x.js'"), 'reports the dangling importmap entry');
    ok(err.includes("'not-in-map'"), 'reports a bare import missing from the importmap');
    ok(err.includes('three@0.147.0') && /not rewritten/.test(err), 'reports a mapped CDN URL that was not rewritten');
    ok(err.includes('left@1.0.0'), 'reports an unmapped CDN URL');
    ok(!err.includes('present.js'), 'does not report a reference that resolves');
    const rg = spawnSync(PY, [SCRIPT, '--verify-only', OUT], { encoding: 'utf8' });
    ok(rg.status === 0, `the real stage passes --verify-only (exit ${rg.status})`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failed ? '✗ FAIL' : '✓ PASS'} — ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.error('  - ' + f.split('\n')[0]); process.exit(1); }
