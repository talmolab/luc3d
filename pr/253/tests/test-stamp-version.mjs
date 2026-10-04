/**
 * test-stamp-version.mjs — scripts/stamp-version.mjs, the deploy step that adds
 * `?v=<version>` to every same-site code reference so Cloudflare's 4-hour cache
 * can never mix two deploys (see the script's header).
 *
 * Pins each rewrite rule, what must NOT be touched (CDN URLs, bare importmap
 * specifiers, already-queried worker URLs), idempotency, and that the safety
 * scan catches a reference the rules would miss. The real-tree half — a stamped
 * copy of the app loading every module exactly once and passing the browser
 * suite — is tests/e2e/stamped-build.mjs.
 *
 * Run: node tests/test-stamp-version.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = await import(pathToFileURL(path.join(ROOT, 'scripts', 'stamp-version.mjs')).href);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('✗ ' + m); } };
const eq = (a, b, m) => ok(a === b, m + (a === b ? '' : `\n    got:  ${a}\n    want: ${b}`));
const V = 'abc123def456';
const js = (t) => S.stampText(t, V, false).text;
const html = (t) => S.stampText(t, V, true).text;

// --- JS rules
eq(js(`import { a } from './x.js';`), `import { a } from './x.js?v=${V}';`, 'static import');
eq(js(`import b from "../ui/y.mjs"`), `import b from "../ui/y.mjs?v=${V}"`, 'double quotes, .mjs, parent dir');
eq(js(`export * from './z.js';`), `export * from './z.js?v=${V}';`, 'export … from');
eq(js(`import './side.js';`), `import './side.js?v=${V}';`, 'side-effect import');
eq(js(`const m = await import('./lazy.js');`), `const m = await import('./lazy.js?v=${V}');`, 'dynamic import');
eq(js(`import{x}from"./chunk-AB12.js";`), `import{x}from"./chunk-AB12.js?v=${V}";`, 'minified bundle form');
eq(js(`new Worker(new URL('./w.js', import.meta.url), { type: 'module' })`),
   `new Worker(new URL('./w.js?v=${V}', import.meta.url), { type: 'module' })`, 'worker URL relative to import.meta.url');
eq(js(`new URL('pose/triangulation-worker.js', document.baseURI)`),
   `new URL('pose/triangulation-worker.js?v=${V}', document.baseURI)`, 'worker URL relative to document.baseURI');
// --- left alone
const keep = [
    `import * as T from 'https://cdn.jsdelivr.net/npm/x@1/+esm';`,
    `import h5 from 'h5wasm';`,
    `new URL('loading/slp-import-worker.js?v=' + Date.now(), document.baseURI)`,
    `const s = 'not an import ./x.js';`,
    `new URL('./data.json', import.meta.url)`,
];
for (const k of keep) eq(js(k), k, 'untouched: ' + k);
// --- idempotent
const once = js(`import { a } from './x.js'; new URL('./w.js', import.meta.url);`);
eq(js(once), once, 'stamping twice changes nothing');
eq(S.stampText(once, V, false).count, 0, '…and counts nothing the second time');

// --- HTML rules
eq(html(`<link rel="stylesheet" href="styles.css">`), `<link rel="stylesheet" href="styles.css?v=${V}">`, 'stylesheet link');
eq(html(`<link rel="stylesheet" href="https://cdn.x/y.css">`), `<link rel="stylesheet" href="https://cdn.x/y.css">`, 'CDN stylesheet untouched');
eq(html(`<script type="module" src="app.js"></script>`), `<script type="module" src="app.js?v=${V}"></script>`, 'module script src');
eq(html(`<script src="./lib/h5wasm/h5wasm.iife.js"></script>`), `<script src="./lib/h5wasm/h5wasm.iife.js?v=${V}"></script>`, 'classic script src');
eq(html(`<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js"></script>`),
   `<script src="https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js"></script>`, 'CDN script untouched');
eq(html(`<script type="importmap">{ "imports": { "h5wasm": "./lib/h5wasm/hdf5_hl.js", "yaml": "https://cdn/yaml.js" } }</script>`),
   `<script type="importmap">{ "imports": { "h5wasm": "./lib/h5wasm/hdf5_hl.js?v=${V}", "yaml": "https://cdn/yaml.js" } }</script>`, 'importmap: relative entry stamped, CDN entry not');
eq(html(`<script type="module">import { a } from './lib/x.js';</script>`),
   `<script type="module">import { a } from './lib/x.js?v=${V}';</script>`, 'inline module script imports');

// --- the safety scan
ok(S.findUnstamped(once, false).length === 0, 'a fully stamped file has no unstamped references');
ok(S.findUnstamped(`import x from '/ui/abs.js';`, false).length === 1, 'scan catches a root-absolute import the rules do not stamp');
ok(S.findUnstamped(`import x from './a.js';`, false).length === 1, 'scan catches an unstamped relative import');
ok(S.findUnstamped(`<script src="app.js"></script>`, true).length === 1, 'scan catches an unstamped script tag');
let threw = false; try { S.stampSite(ROOT, 'bad version!'); } catch (e) { threw = true; }
ok(threw, 'a version with unsafe characters is refused before touching anything');

console.log(fail ? `✗ FAIL — ${pass} passed, ${fail} failed` : `✓ PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
