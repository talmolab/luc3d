#!/usr/bin/env node
// scripts/stamp-version.mjs — make a deployed copy of LUCID cache-safe.
//
//   node scripts/stamp-version.mjs <site-dir> <version>
//
// Rewrites, IN PLACE, every same-site code reference in <site-dir> to carry
// `?v=<version>`: relative ES-module imports (`from`, `import()`, side-effect
// `import '…'`, `export … from`), worker/module URLs built with `new URL('…', …)`,
// `<script src>` and stylesheet `<link href>` tags, and importmap entries.
//
// Why: luc3d.sleap.ai sits behind Cloudflare, which serves .js/.css with a 4-hour
// cache lifetime — in the browser AND per Cloudflare data centre — while
// index.html is revalidated within minutes. LUCID loads ~70 un-versioned ES
// modules, so after a deploy a visitor could run the NEW index.html with OLD
// modules for hours (seen 2026-10-04 on PR #249's preview: even an Incognito
// window got stale modules from one data centre). With every reference stamped,
// a new index.html names new URLs all the way down, so no cache can mix builds.
//
// Consistency is the whole game: an ES module's identity IS its URL, so a file
// reached through a stamped URL in one place and an unstamped one in another
// would be instantiated TWICE (two `state` objects, two timelines…). So every
// rule stamps the same way, and after rewriting the script re-scans with a
// BROADER pattern and fails (exit 1) if any relative module reference was left
// unstamped — a deploy must never ship a half-stamped tree.
//
// Not touched: absolute URLs (CDN, data:, blob:), bare importmap specifiers
// (`'h5wasm'` — their importmap target is stamped instead), specifiers that
// already carry a query (e.g. a worker URL busted per call with `?v=Date.now()`),
// and Node-only code that never runs in the browser (`tests/e2e/`, `scripts/`,
// and `tests/**/*.mjs`).
//
// Idempotent: a stamped specifier has a `?`, which no rule matches again.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ABS = '(?![a-z][\\w+.-]*:|//)';            // not a scheme URL, not protocol-relative
const SPEC_JS = '[^\'"`?#\\s]+\\.m?js';           // a path ending .js / .mjs, no query yet

/** Stamp one file's text. Returns {text, count}. `isHtml` adds the tag + importmap rules. */
export function stampText(text, version, isHtml) {
    const q = '?v=' + version;
    let count = 0;
    const bump = (s) => { count++; return s; };
    // R1: static / dynamic / side-effect imports and `export … from` with a RELATIVE specifier.
    text = text.replace(new RegExp('(\\b(?:from|import)\\s*\\(?\\s*)([\'"])(\\.{1,2}/' + SPEC_JS + ')\\2', 'g'),
        (m, pre, qt, spec) => bump(pre + qt + spec + q + qt));
    // R2: `new URL('<path>.js', base)` — workers and module URLs (relative to import.meta.url or document.baseURI).
    text = text.replace(new RegExp('(\\bnew\\s+URL\\(\\s*)([\'"])(' + ABS + SPEC_JS + ')\\2(\\s*,)', 'g'),
        (m, pre, qt, spec, post) => bump(pre + qt + spec + q + qt + post));
    if (isHtml) {
        // R3: <script src="…js">
        text = text.replace(new RegExp('(<script\\b[^>]*?\\bsrc\\s*=\\s*)(["\'])(' + ABS + SPEC_JS + ')\\2', 'gi'),
            (m, pre, qt, spec) => bump(pre + qt + spec + q + qt));
        // R4: <link … href="…css"> (stylesheets)
        text = text.replace(new RegExp('(<link\\b[^>]*?\\bhref\\s*=\\s*)(["\'])(' + ABS + '[^"\'?#\\s]+\\.css)\\2', 'gi'),
            (m, pre, qt, spec) => bump(pre + qt + spec + q + qt));
        // R5: importmap entries pointing at relative files
        text = text.replace(/(<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open, body, close) =>
            open + body.replace(new RegExp('(:\\s*)"(\\.{1,2}/[^"?#\\s]+\\.m?js)"', 'g'), (mm, pre, spec) => bump(pre + '"' + spec + q + '"')) + close);
    }
    return { text, count };
}

/**
 * Relative module references a rewrite left unstamped (should be none). Broader
 * than the rewrite rules on purpose: it also catches root-absolute (`/x.js`) and
 * odd spacing, so a pattern the rules miss fails loudly instead of shipping.
 */
export function findUnstamped(text, isHtml) {
    const out = [];
    const scan = (re) => { let m; while ((m = re.exec(text))) out.push(m[0].slice(0, 120)); };
    scan(/\b(?:from|import)\s*\(?\s*(['"])((?:\.{1,2}\/|\/(?!\/))[^'"?#]*?\.m?js)\1/g);
    scan(new RegExp('\\bnew\\s+URL\\(\\s*([\'"])(' + ABS + '[^\'"?#]*?\\.m?js)\\1\\s*,', 'g'));
    if (isHtml) {
        scan(new RegExp('<script\\b[^>]*?\\bsrc\\s*=\\s*(["\'])(' + ABS + '[^"\'?#]*?\\.m?js)\\1', 'gi'));
        scan(new RegExp('<link\\b[^>]*?\\bhref\\s*=\\s*(["\'])(' + ABS + '[^"\'?#]*?\\.css)\\1', 'gi'));
    }
    return out;
}

/** Which files under the site the browser can load as code (Node-only code is skipped). */
function shouldProcess(rel) {
    const p = rel.split(path.sep).join('/');
    if (/(^|\/)(node_modules|\.git)\//.test(p)) return false;
    if (p.startsWith('tests/e2e/') || p.startsWith('scripts/')) return false;
    if (p.startsWith('tests/') && p.endsWith('.mjs')) return false;
    return /\.(m?js|html)$/.test(p);
}

function walk(dir, base, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name), rel = path.relative(base, abs);
        if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') walk(abs, base, out); }
        else if (e.isFile() && shouldProcess(rel)) out.push(rel);
    }
    return out;
}

/** Stamp a whole site directory. Returns {files, refs, problems}. */
export function stampSite(root, version) {
    if (!/^[A-Za-z0-9._-]{4,64}$/.test(version)) throw new Error('version must be 4-64 chars of [A-Za-z0-9._-], got "' + version + '"');
    let files = 0, refs = 0;
    const problems = [];
    for (const rel of walk(root, root, [])) {
        const abs = path.join(root, rel), isHtml = rel.endsWith('.html');
        const before = fs.readFileSync(abs, 'utf8');
        const { text, count } = stampText(before, version, isHtml);
        if (count) { fs.writeFileSync(abs, text); files++; refs += count; }
        for (const u of findUnstamped(text, isHtml)) problems.push(rel + ': ' + u);
    }
    return { files, refs, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [root, version] = process.argv.slice(2);
    if (!root || !version) { console.error('usage: node scripts/stamp-version.mjs <site-dir> <version>'); process.exit(2); }
    const r = stampSite(path.resolve(root), version);
    console.log(`stamp-version: ?v=${version} on ${r.refs} references in ${r.files} files under ${root}`);
    if (r.problems.length) {
        console.error('stamp-version: relative module references left UNSTAMPED (would load those modules twice):');
        r.problems.forEach(p => console.error('  ' + p));
        process.exit(1);
    }
}
