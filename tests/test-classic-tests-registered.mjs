/**
 * test-classic-tests-registered.mjs — every classic `tests/test-*.js` file has
 * a `<script>` tag in `tests/test-runner.html`, the only runner for them.
 *
 * Nothing discovers those files: one that is not tagged there never runs, and
 * nothing says so. Four were run only by the retired `tests/run-node.js` vm
 * runner, which had been red for months — one of them had been testing nothing
 * since luc3d #189. So a file that should not run must be listed below, with
 * the reason, rather than simply left untagged.
 *
 * Run:  node tests/test-classic-tests-registered.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Classic test files that are deliberately NOT run, and why.
const UNREGISTERED = {};

let passed = 0, failed = 0; const failures = [];
function check(ok, m) {
    if (ok) passed++;
    else { failed++; failures.push(m); console.error('  ✗ ' + m); }
}

const onDisk = readdirSync(HERE).filter(f => /^test-.*\.js$/.test(f)).sort();
// Comments out first, so a commented-out tag does not count as registered.
const html = readFileSync(path.join(HERE, 'test-runner.html'), 'utf-8').replace(/<!--[\s\S]*?-->/g, '');
const tagged = [...html.matchAll(/<script\s+src="(test-[^"]+\.js)"/g)].map(m => m[1]);

check(onDisk.length > 50 && tagged.length > 50, `found the files (${onDisk.length} on disk, ${tagged.length} tagged)`);
for (const f of onDisk) {
    if (UNREGISTERED[f]) check(!tagged.includes(f), `${f} is listed as unregistered but has a tag`);
    else check(tagged.includes(f), `${f} has no <script> tag in tests/test-runner.html, so it never runs`);
}
for (const f of tagged) check(onDisk.includes(f), `tests/test-runner.html tags ${f}, which does not exist`);
for (const f of Object.keys(UNREGISTERED)) check(onDisk.includes(f), `UNREGISTERED lists ${f}, which does not exist`);
const dupes = tagged.filter((f, i) => tagged.indexOf(f) !== i);
check(dupes.length === 0, `tagged more than once: ${dupes.join(', ')}`);

console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
