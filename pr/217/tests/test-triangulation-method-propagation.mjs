/**
 * test-triangulation-method-propagation.mjs — a SOURCE-LEVEL guard that no caller
 * relies on `triangulateAndReproject`'s silent DLT default.
 *
 * `triangulateAndReproject(group, cameras, options)` resolves its method as
 * `options.method === 'ba' ? 'ba' : 'dlt'`. That default is SILENT: a caller that
 * omits `method` does not get "whatever this group already used", it gets DLT.
 * Two separate user-visible bugs came from exactly that omission:
 *
 *   * `ui/rendering.js`'s lazy reprojection fill re-solved BA groups with DLT and
 *     wrote DLT's error into `state.triangulationResults`, so the Info Panel
 *     showed DLT's number under a "Bundle Adjustment" label.
 *   * The two grouping sweeps in `ui/export-modals.js` re-solved every group with
 *     DLT and stamped `triangulationMethod = 'dlt'`, silently downgrading a whole
 *     project's 3D — including what save/export then wrote to disk.
 *
 * Both are fixed, and each has a behavioral e2e test. This test guards the
 * INVARIANT those fixes established, which behavior tests cannot: **every call
 * site passes an explicit `method`.** That is checkable by reading the source;
 * "every caller that forgot happened to want DLT" is not. A new caller that
 * forgets is the whole failure mode, and it arrives silently — no crash, no wrong
 * shape, just quietly worse 3D — so a static check is the cheap guard.
 *
 * The one intentionally-DLT caller (the O(nRef x nOther) Hungarian cost matrix in
 * `ui/identity-assignment.js`, whose temporary 3D is discarded) passes
 * `{ method: 'dlt' }` explicitly for this reason.
 *
 * Deliberately a source scan rather than a runtime assert/warn inside
 * `triangulateAndReproject`: that function is called once per candidate PAIR
 * inside the cost matrix, so a runtime warning would fire O(n*m) times per
 * auto-assign — noise in a legitimate path, which is exactly what the guard must
 * not create.
 *
 * Run:  node tests/test-triangulation-method-propagation.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['pose', 'ui', 'import-export', 'loading'];

let passed = 0, failed = 0;
const check = (cond, msg) => {
    console.log((cond ? '  ok   ' : '  FAIL ') + msg);
    if (cond) passed++; else failed++;
};

/** Every `.js` under the app source dirs (never `lib/`, `tests/`, `scripts/`). */
function sourceFiles() {
    const out = [];
    for (const d of DIRS) {
        const dir = path.join(repoRoot, d);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.js')) out.push(path.join(d, f));
        }
    }
    return out;
}

/**
 * Find `triangulateAndReproject(...)` calls and split their arguments. Bracket-
 * balanced scan from the opening paren, so a nested call or an object literal in
 * an earlier argument cannot fool the comma splitting.
 */
function callsIn(text) {
    const calls = [];
    const needle = 'triangulateAndReproject(';
    let i = 0;
    while ((i = text.indexOf(needle, i)) !== -1) {
        // Skip the definition itself and any comment/doc mention.
        const lineStart = text.lastIndexOf('\n', i) + 1;
        const lineEnd = text.indexOf('\n', i);
        const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
        if (/^\s*(\*|\/\/)/.test(line) || /function\s+triangulateAndReproject/.test(line)) {
            i += needle.length;
            continue;
        }
        let depth = 0, j = i + needle.length - 1, argStart = j + 1;
        const args = [];
        for (; j < text.length; j++) {
            const c = text[j];
            if (c === '(' || c === '[' || c === '{') depth++;
            else if (c === ')' || c === ']' || c === '}') {
                depth--;
                if (depth === 0) { args.push(text.slice(argStart, j)); break; }
            } else if (c === ',' && depth === 1) {
                args.push(text.slice(argStart, j));
                argStart = j + 1;
            }
        }
        calls.push({
            line: text.slice(0, i).split('\n').length,
            nArgs: args.length,
            third: (args[2] || '').trim(),
        });
        i = j > i ? j : i + needle.length;
    }
    return calls;
}

console.log('triangulation method propagation:');

const all = [];
for (const rel of sourceFiles()) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const c of callsIn(text)) all.push({ file: rel, ...c });
}

check(all.length >= 10,
    `found the call sites to audit (${all.length}) — if this collapses the scan ` +
    `has stopped matching and the guard is dead`);

const optionless = all.filter(c => c.nArgs < 3);
check(optionless.length === 0,
    `EVERY triangulateAndReproject call passes an options object (${all.length} ` +
    `sites). An offender would silently get DLT: ` +
    JSON.stringify(optionless.map(c => `${c.file}:${c.line}`)));

const noMethod = all.filter(c => c.nArgs >= 3 && !/method/.test(c.third));
check(noMethod.length === 0,
    `...and every options object names a \`method\` ` +
    `(offenders: ${JSON.stringify(noMethod.map(c => `${c.file}:${c.line} -> ${c.third.slice(0, 60)}`))})`);

// Exactly one caller may hardcode 'dlt': the cost matrix, whose 3D is discarded.
const hardcodedDlt = all.filter(c => /method:\s*'dlt'/.test(c.third));
check(hardcodedDlt.length === 1 && hardcodedDlt[0].file === 'ui/identity-assignment.js',
    `exactly ONE caller hardcodes method:'dlt' — the Hungarian cost matrix, whose ` +
    `temporary 3D is discarded (got ${JSON.stringify(hardcodedDlt.map(c => `${c.file}:${c.line}`))})`);

// Everyone else must RESOLVE the method: from the group's own recorded method,
// from the user's Settings default, or from one threaded in by their caller.
const RESOLVERS = /resolveTriangulationMethod|triangulationMethod|method:\s*(method|_m|prefMethod|prefMethodT|triMethod)\b/;
const unresolved = all.filter(c =>
    !/method:\s*'dlt'/.test(c.third) && !RESOLVERS.test(c.third));
check(unresolved.length === 0,
    `every other caller RESOLVES its method (the group's own method, the Settings ` +
    `default, or one threaded in) rather than inventing one ` +
    `(offenders: ${JSON.stringify(unresolved.map(c => `${c.file}:${c.line} -> ${c.third.slice(0, 60)}`))})`);

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
