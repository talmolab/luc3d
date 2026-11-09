/**
 * test-no-sync-dialogs.mjs — app source never calls `confirm(` / `prompt(` /
 * `alert(` directly; every question goes through `ui/ask.js`.
 *
 * Why: the macOS desktop app runs in WKWebView, and wry implements none of its
 * JavaScript dialog panels. There `window.confirm()` returns false and
 * `window.prompt()` returns null IMMEDIATELY, showing nothing (and `alert()`
 * shows nothing), so a direct call silently cancels the action every time.
 * `askConfirm` / `askText` / `askAlert` (ui/ask.js) return Promises: the same
 * native dialog in a browser, a working dialog in the desktop app.
 *
 * Scans ui/, loading/, pose/, import-export/ (recursively), app.js and
 * demo-data.js — not lib/ or tests/ — after blanking comments, strings,
 * template-literal text and regex literals, so prose that mentions
 * `confirm()` does not count. Method calls on other objects
 * (`lucidDesktop.confirm(`) are allowed; `window.` / `globalThis.` / `self.`
 * are not.
 *
 * Run:  node tests/test-no-sync-dialogs.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['ui', 'loading', 'pose', 'import-export'];
const FILES = ['app.js', 'demo-data.js'];
const ALLOWED = new Set(['ui/ask.js']);

let passed = 0, failed = 0; const failures = [];
function check(ok, m) {
    if (ok) passed++;
    else { failed++; failures.push(m); console.error('  ✗ ' + m); }
}

/**
 * Replace comments, string / template text and regex literals with spaces
 * (newlines kept, so line numbers survive). `${…}` inside templates stays code.
 */
function blankNonCode(src) {
    const out = src.split('');
    const n = src.length;
    const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
    // Stack of contexts: 'code' (with a brace depth) or 'tmpl'.
    const stack = [{ kind: 'code', depth: 0 }];
    let i = 0;
    let lastSig = '';          // last significant code char, for regex-vs-divide
    let lastWord = '';
    const regexAfterWords = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
    while (i < n) {
        const top = stack[stack.length - 1];
        const c = src[i];
        if (top.kind === 'tmpl') {
            if (c === '\\') { blank(i, i + 2); i += 2; continue; }
            if (c === '`') { stack.pop(); i++; lastSig = '`'; lastWord = ''; continue; }
            if (c === '$' && src[i + 1] === '{') { stack.push({ kind: 'code', depth: 0 }); i += 2; lastSig = '{'; continue; }
            blank(i, i + 1); i++; continue;
        }
        // code
        if (c === '/' && src[i + 1] === '/') {
            let j = src.indexOf('\n', i); if (j < 0) j = n;
            blank(i, j); i = j; continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2;
            blank(i, j); i = j; continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
            blank(i + 1, j); i = j + 1; lastSig = c; lastWord = ''; continue;
        }
        if (c === '`') { stack.push({ kind: 'tmpl' }); i++; continue; }
        if (c === '/') {
            const isRegex = lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig) || regexAfterWords.has(lastWord);
            if (isRegex) {
                let j = i + 1, inClass = false;
                while (j < n && src[j] !== '\n') {
                    if (src[j] === '\\') { j += 2; continue; }
                    if (src[j] === '[') inClass = true;
                    else if (src[j] === ']') inClass = false;
                    else if (src[j] === '/' && !inClass) break;
                    j++;
                }
                blank(i + 1, j); i = j + 1;
                while (i < n && /[a-z]/i.test(src[i])) i++;
                lastSig = '/'; lastWord = ''; continue;
            }
        }
        if (c === '{') top.depth++;
        if (c === '}') {
            if (top.depth === 0 && stack.length > 1) { stack.pop(); i++; continue; }  // end of ${…}
            top.depth--;
        }
        if (/[A-Za-z0-9_$]/.test(c)) {
            let j = i; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
            lastWord = src.slice(i, j); lastSig = 'w'; i = j; continue;
        }
        if (!/\s/.test(c)) { lastSig = c; lastWord = ''; }
        i++;
    }
    return out.join('');
}

const CALL_RE = /(^|[^\w$.])((?:(?:window|globalThis|self)\s*\.\s*)?)(confirm|prompt|alert)\s*\(/g;

/** Direct dialog calls in `src`: [{line, call}]. */
function findDialogCalls(src) {
    const code = blankNonCode(src);
    const hits = [];
    let m;
    CALL_RE.lastIndex = 0;
    while ((m = CALL_RE.exec(code))) {
        const at = m.index + m[1].length;
        // A declaration `function confirm(` is not a call.
        if (/\bfunction\s*$/.test(code.slice(Math.max(0, at - 20), at))) continue;
        hits.push({ line: code.slice(0, at).split('\n').length, call: (m[2] + m[3]).replace(/\s+/g, '') });
    }
    return hits;
}

// ── self-test of the scanner ─────────────────────────────────────────────
{
    const pos = [
        "if (!confirm('x')) return;",
        "var ok = window.confirm('y');",
        "var s = prompt('a', 1);",
        "globalThis.alert('z');",
        "self . prompt ('q')",
        "f(`${confirm('t')}`);",
        "var re = /\"/; confirm('after a regex holding a quote');",
    ];
    for (const s of pos) check(findDialogCalls(s).length === 1, `scanner flags: ${s}`);
    const neg = [
        "// confirm('in a line comment')",
        "/* window.prompt('in a block comment') */",
        "var s = 'confirm(\"in a string\")';",
        "var t = `alert(in template text)`;",
        "lucidDesktop.confirm('method on another object');",
        "askConfirm('helper'); askText('x'); askAlert('y');",
        "function confirm(a) { return a; }",
        "var re = /confirm\\(/;",
        "x.prompt(1); obj.alert(2);",
        "var n = a / b; confirmed(1); prompted(2);",
    ];
    for (const s of neg) check(findDialogCalls(s).length === 0, `scanner ignores: ${s}`);
}

// ── the scan ─────────────────────────────────────────────────────────────
function walk(dir, acc) {
    for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, acc);
        else if (/\.m?js$/.test(name)) acc.push(p);
    }
    return acc;
}
const files = [];
for (const d of DIRS) walk(path.join(ROOT, d), files);
for (const f of FILES) files.push(path.join(ROOT, f));

check(files.length > 100, `found the app source (${files.length} files)`);
check(files.some(f => f.endsWith(path.join('ui', 'ask.js'))), 'ui/ask.js exists');

const offenders = [];
for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    for (const h of findDialogCalls(readFileSync(f, 'utf-8'))) offenders.push(`${rel}:${h.line}  ${h.call}(`);
}
check(offenders.length === 0,
    'direct confirm()/prompt()/alert() calls in app source:\n      ' + offenders.join('\n      ') +
    '\n    These silently return false/null (and show nothing) in the macOS desktop app, where ' +
    'WKWebView has no JavaScript dialogs. Use askConfirm / askText / askAlert from ui/ask.js ' +
    '(Promise-returning; the same native dialog in a browser).');

console.log(`\ntest-no-sync-dialogs: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
