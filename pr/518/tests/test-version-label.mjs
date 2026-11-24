/**
 * test-version-label.mjs — ui/version-label.js, the release shown beside the
 * menu bar's Settings button ("v1.0.5" on the live page).
 *
 * Pins what each deploy channel's stamped <meta> tags turn into: a release tag
 * alone, `dev` / `PR #<n>` with the commit beside them, and nothing at all for
 * an unstamped working tree. The stamping half is tests/test-stamp-version.mjs;
 * the real menu bar on a stamped copy is tests/e2e/stamped-build.mjs.
 *
 * Run: node tests/test-version-label.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { formatVersionLabel, showVersionLabel } = await import(pathToFileURL(path.join(ROOT, 'ui', 'version-label.js')).href);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('✗ ' + m); } };
const eq = (a, b, m) => ok(a === b, m + (a === b ? '' : `\n    got:  ${a}\n    want: ${b}`));
const C = '67978a8b1234';

// --- what each channel reads
eq(formatVersionLabel('v1.0.5', C).text, 'v1.0.5', 'a release reads as its tag alone');
eq(formatVersionLabel('v1.0.5', C).title, `LUCID v1.0.5 (commit ${C})`, '…with the commit in the tooltip');
eq(formatVersionLabel('v1.0.6-1', C).text, 'v1.0.6-1', 'a pre-release tag is a tag too');
eq(formatVersionLabel('dev', C).text, 'dev · 67978a8b', 'dev shows the commit, or two deploys read the same');
eq(formatVersionLabel('dev', C).title, `LUCID dev build (commit ${C})`, 'dev tooltip');
eq(formatVersionLabel('PR #123', C).text, 'PR #123 · 67978a8b', 'a PR preview shows its number and commit');
eq(formatVersionLabel('', C).text, '67978a8b', 'stamped without a label: just the commit');
eq(formatVersionLabel('dev', '').text, 'dev', 'a label with no commit is shown as is');
eq(formatVersionLabel('v1.0', C).text, 'v1.0 · 67978a8b', 'not a vX.Y.Z tag, so it is not shown as one');
eq(formatVersionLabel('', ''), null, 'an unstamped working tree has no label');
eq(formatVersionLabel(undefined, undefined), null, '…including when the tags are missing');
eq(formatVersionLabel(' v1.0.5 ', ` ${C} `).text, 'v1.0.5', 'whitespace around a stamped value is ignored');

// --- the DOM half, against a stand-in document
function fakeDoc(metas) {
    const el = { textContent: 'stale', title: 'stale', hidden: false };
    return {
        el,
        getElementById: (id) => (id === 'menuBarVersion' ? el : null),
        querySelector: (sel) => {
            const name = /meta\[name="([^"]+)"\]/.exec(sel)?.[1];
            return name in metas ? { content: metas[name] } : null;
        },
    };
}
let d = fakeDoc({ 'lucid-release': 'v1.0.5', 'lucid-commit': C });
showVersionLabel(d);
ok(d.el.textContent === 'v1.0.5' && !d.el.hidden, 'stamped tags fill and show the label');
eq(d.el.title, `LUCID v1.0.5 (commit ${C})`, '…and its tooltip');
d = fakeDoc({ 'lucid-release': '', 'lucid-commit': '' });
showVersionLabel(d);
ok(d.el.hidden && d.el.textContent === '' && d.el.title === '', 'empty tags hide the label and clear it');
d = fakeDoc({});
showVersionLabel(d);
ok(d.el.hidden, 'no tags at all: hidden');
let threw = false;
try { showVersionLabel({ getElementById: () => null, querySelector: () => null }); } catch { threw = true; }
ok(!threw, 'a page without the label element is left alone');

console.log(fail ? `✗ FAIL — ${pass} passed, ${fail} failed` : `✓ PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
