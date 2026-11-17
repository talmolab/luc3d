/**
 * test-preload-modules.mjs — scripts/preload-modules.mjs, the deploy step that
 * lists the page's whole startup module graph as `<link rel="modulepreload">`
 * so a cold start fetches it at once instead of one import level at a time.
 *
 * Pins: which specifiers count as static (dynamic `import()` and commented-out
 * imports do not), importmap resolution, that a `<script src>` root is not
 * preloaded but an inline module's imports are, that stamped specifiers are
 * copied verbatim (a preload must be the importer's exact URL), the block's
 * position right after the importmap, idempotency, and the missing-file report.
 * The real-tree half — every preload used, nothing at startup left out — is in
 * tests/e2e/stamped-build.mjs.
 *
 * Run: node tests/test-preload-modules.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = await import(pathToFileURL(path.join(ROOT, 'scripts', 'preload-modules.mjs')).href);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('✗ ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + `\n    got:  ${JSON.stringify(a)}\n    want: ${JSON.stringify(b)}`);

// --- staticSpecifiers
eq(P.staticSpecifiers(`import { a } from './a.js';\nimport b from "../b.mjs"\nimport './side.js';\nexport * from './re.js';\nexport { x } from 'bare';`),
   ['./a.js', '../b.mjs', './side.js', './re.js', 'bare'], 'static import forms');
eq(P.staticSpecifiers(`const m = await import('./lazy.js'); import ('./lazy2.js');`), [], 'dynamic import() is not static');
eq(P.staticSpecifiers(`// import './gone.js';\n/* import './gone2.js'; */\nimport './kept.js';`), ['./kept.js'], 'commented-out imports ignored');
eq(P.staticSpecifiers(`import{x}from"./chunk-AB12.js?v=abc";`), ['./chunk-AB12.js?v=abc'], 'minified form, query kept');
eq(P.staticSpecifiers(`import {\n  a,\n  b\n} from './multi.js';`), ['./multi.js'], 'multi-line import clause');
eq(P.staticSpecifiers(`const url = 'https://x/y.js'; import './z.js';`), ['./z.js'], 'a // inside a string is not a comment');

// --- a small site
const site = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-preload-'));
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true }); fs.writeFileSync(path.join(site, rel), text); };
put('index.html', `<!DOCTYPE html><html><head>
    <script defer src="./lib/classic.js?v=V1"></script>
    <script type="importmap">{ "imports": { "dep": "./lib/dep.mjs?v=V1", "cdn": "https://cdn.example/cdn.js" } }</script>
</head><body>
    <script type="module">
        import { S } from './lib/sio/index.js?v=V1';
        window.S = S;
    </script>
    <script type="module" src="app.js?v=V1"></script>
</body></html>
`);
put('app.js', `import './pose/a.js?v=V1';`);
put('pose/a.js', `import { b } from '../ui/b.js?v=V1';\nimport dep from 'dep';\nimport C from 'cdn';\nconst lazy = () => import('./lazy.js?v=V1');`);
put('ui/b.js', `import './c.js?v=V1';\nimport { a } from '../pose/a.js?v=V1';`);   // a cycle back to a.js
put('ui/c.js', `export const c = 1;`);
put('pose/lazy.js', `import './never.js';`);
put('lib/dep.mjs', `export default 1;`);
put('lib/sio/index.js', `export * from './chunk.js?v=V1';`);
put('lib/sio/chunk.js', `import dep from 'dep'; export const S = dep;`);

const g = P.moduleGraph(site);
eq(g.local.sort(), ['./lib/dep.mjs?v=V1', './lib/sio/chunk.js?v=V1', './lib/sio/index.js?v=V1', './pose/a.js?v=V1', './ui/b.js?v=V1', './ui/c.js?v=V1'],
   'graph: inline-module imports + the static closure of app.js, importmap resolved, stamps copied, cycle visited once, no root, no lazy');
eq(g.remote, ['https://cdn.example/cdn.js'], 'graph: the CDN module the importmap names');
eq(g.missing, [], 'graph: nothing missing');

P.preloadSite(site);
const html1 = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
const links = [...html1.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1]);
eq(links.length, 7, 'site: 6 same-site + 1 CDN preload');
ok(!links.some(h => /app\.js|classic\.js|lazy\.js/.test(h)), 'site: no preload for a <script src> root, a classic script, or a dynamic import');
ok(html1.indexOf('modulepreload') > html1.indexOf('</script>', html1.indexOf('importmap')), 'site: the block comes after the importmap');
ok(html1.indexOf('modulepreload') < html1.indexOf('<script type="module"'), 'site: …and before the first module script');
P.preloadSite(site);
eq(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), html1, 'site: idempotent (re-running replaces the block, not adds one)');

put('ui/c.js', `import './gone.js';`);
eq(P.moduleGraph(site).missing.map(u => u.replace(/^https:\/\/[^/]+/, '')), ['/ui/gone.js'], 'missing: a static import of a file that is not deployed is reported');
fs.rmSync(site, { recursive: true, force: true });

console.log(fail ? `✗ FAIL — ${pass} passed, ${fail} failed` : `✓ PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
