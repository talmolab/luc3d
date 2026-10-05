/**
 * run-mjs-tests.mjs — runner for the native-ESM Node tests, `tests/test-*.mjs`.
 *
 * ## Why this file exists
 *
 * There were three test populations and only two runners:
 *
 *   tests/*.js         classic scripts  -> tests/run-node.js (vm sandbox) and
 *                                         tests/test-runner.html (browser)
 *   tests/e2e/*.mjs    Playwright       -> run individually
 *   tests/test-*.mjs   native ESM       -> NOTHING
 *
 * So eight ESM test files were orphaned: nothing imported them, no runner
 * referenced them, and `run-unit-tests.mjs` reporting "1201/1201 passed" never
 * touched them. Four had been broken for some time, including a hard
 * `ReferenceError: ptsB is not defined` in `pose/tracker.js` that had been live
 * since the luc3d #185 typed-array refactor, plus three test files left reading
 * pre-#185 shapes (boxed `Instance.points`, boxed `points3d` rows, legacy string
 * `frameIdentityMap` keys). None of it was visible because nothing ran them.
 *
 * Each file is spawned in its own process (they are standalone, set their own exit
 * code, and some install module loader hooks that must not leak between files).
 *
 * Usage:
 *   node tests/run-mjs-tests.mjs            # all
 *   node tests/run-mjs-tests.mjs trails id  # only files matching a substring
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const filters = process.argv.slice(2);

// `test-*.mjs` only: other .mjs files here are shared helpers (e.g.
// `tracker-gui-hooks.mjs`, a module-loader hook), not runnable suites.
const files = readdirSync(__dirname)
    .filter(f => f.startsWith('test-') && f.endsWith('.mjs'))
    .filter(f => filters.length === 0 || filters.some(s => f.includes(s)))
    .sort();

if (files.length === 0) {
    console.error('no matching tests/test-*.mjs');
    process.exit(1);
}

const run = (file) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join('tests', file)], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => resolve({ file, code, out }));
});

console.log(`running ${files.length} ESM test file(s)\n`);
const results = [];
for (const f of files) results.push(await run(f));

let failed = 0;
for (const r of results) {
    // Suites print their own "✓ PASS — N passed, M failed" summary; surface it
    // when present so the runner's output is useful on its own.
    const summary = (r.out.match(/[✓✗] (?:PASS|FAIL) — \d+ passed, \d+ failed/) ||
        r.out.match(/\d+ passed, \d+ failed/) || [''])[0];
    const okMark = r.code === 0 ? 'ok  ' : 'FAIL';
    console.log(`  ${okMark} ${r.file.padEnd(38)} ${summary}`);
    if (r.code !== 0) {
        failed++;
        // Only the failure lines, so one broken file does not bury the rest.
        const lines = r.out.split('\n').filter(l => /✗|Error|error:|not defined|expected/.test(l));
        for (const l of lines.slice(0, 14)) console.log(`         ${l.trim().slice(0, 200)}`);
        if (lines.length > 14) console.log(`         ... ${lines.length - 14} more line(s)`);
    }
}

console.log('');
console.log(failed === 0
    ? `PASS — ${results.length}/${results.length} ESM test files`
    : `FAIL — ${failed} of ${results.length} ESM test files failed`);
process.exit(failed === 0 ? 0 : 1);
