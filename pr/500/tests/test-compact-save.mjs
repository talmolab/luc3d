/**
 * test-compact-save.mjs — import-export/compact-save.js: the rounding steps, the
 * switch a compact save turns on (and always off again), the marker a compact
 * file carries, and the note LUC3D shows when one is opened; with
 * import-export/slp-provenance.js, that only a compact save writes the marker and
 * that a later save of a compact file keeps it. The writer side and the dialog
 * are tests/e2e/compact-save-copy.mjs.
 *
 * Run:  node tests/test-compact-save.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mod = (f) => pathToFileURL(path.join(HERE, '..', 'import-export', f)).href;
const C = await import(mod('compact-save.js'));
const P = await import(mod('slp-provenance.js'));

let passed = 0, failed = 0; const failures = [];
function eq(a, e, m) {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) passed++;
    else { failed++; failures.push(`${m} (expected ${E}, got ${A})`); console.error('  ✗ ' + m); }
}
function ok(c, m) { eq(!!c, true, m); }

// ---- the steps: binary fractions, so a rounded value is exact in float32 and float64
for (const [k, v] of Object.entries(C.COMPACT_STEPS)) {
    ok(Number.isInteger(Math.log2(1 / v)), k + ' is a power-of-two fraction');
}
ok(Math.fround(Math.round(1234.56789 * 64) / 64) === Math.round(1234.56789 * 64) / 64, 'a rounded pixel coordinate is exact in float32');

// ---- the switch
eq(globalThis.__lucidCompactSave, undefined, 'off before a compact save');
eq(C.compactProvenanceExtra(), null, 'no marker outside a compact save');
let during = null, extra = null;
await C.withCompactSave(async () => { during = globalThis.__lucidCompactSave; extra = C.compactProvenanceExtra(); });
eq(during, C.COMPACT_STEPS, 'the writer sees the steps while it runs');
ok(extra && extra[C.COMPACT_PROVENANCE_KEY] && extra[C.COMPACT_PROVENANCE_KEY].xy_px === C.COMPACT_STEPS.xy, 'and the marker is offered');
eq(globalThis.__lucidCompactSave, undefined, 'off again after');
let threw = false;
try { await C.withCompactSave(async () => { throw new Error('disk full'); }); } catch (e) { threw = e.message === 'disk full'; }
ok(threw, 'a failing save rethrows');
eq(globalThis.__lucidCompactSave, undefined, 'and is off again too');
eq(C.compactSaveActive(), false, 'not active after a failure');
let nested = false;
await C.withCompactSave(async () => { try { await C.withCompactSave(async () => {}); } catch (e) { nested = true; } });
ok(nested, 'a second compact save while one runs is refused');

// ---- provenance: only a compact save writes the marker; a later save keeps it
const plain = P.buildSaveProvenance([{ name: 's', fileProvenance: null }]);
eq(plain[C.COMPACT_PROVENANCE_KEY], undefined, 'a normal save writes no marker');
let compactProv = null;
await C.withCompactSave(async () => { compactProv = P.buildSaveProvenance([{ name: 's', fileProvenance: null }]); });
ok(C.compactRoundingOf(compactProv), 'a compact save marks the file');
eq(compactProv.source, 'lucid', 'and is still a LUC3D file');
const reopened = P.fileSessionProvenance(compactProv, ['s'], 0);
ok(C.compactRoundingOf(reopened), 'the marker comes back on the reopened session');
const resaved = P.buildSaveProvenance([{ name: 's', fileProvenance: reopened }]);
ok(C.compactRoundingOf(resaved), 'and a normal save of that file keeps it: its data stay rounded');
const campy = { campy_session: { id: 1 } };
let withCampy = null;
await C.withCompactSave(async () => { withCampy = P.buildSaveProvenance([{ name: 's', fileProvenance: campy }]); });
ok(withCampy.campy_session && C.compactRoundingOf(withCampy), 'beside a recording\'s own provenance');

// ---- the note on opening
const note = C.withCompactNote('Reopened x.slp', 'success', { fileProvenance: reopened });
eq(note.kind, 'warning', 'a compact file opens with a warning');
ok(/compact copy/.test(note.message) && /1\/64 px/.test(note.message) && /1\/1024 mm/.test(note.message), 'that says what was rounded: ' + note.message);
eq(C.withCompactNote('Reopened x.slp', 'success', { fileProvenance: null }), { message: 'Reopened x.slp', kind: 'success' }, 'a full-precision file opens as before');
eq(C.withCompactNote('Bad', 'error', { fileProvenance: reopened }).kind, 'error', 'an error stays an error');
eq(C.withCompactNote('Reopened', 'success', null).message, 'Reopened', 'no session: unchanged');

console.log(`\ntest-compact-save: ${passed} passed, ${failed} failed`);
if (failed) { failures.forEach((f) => console.error(' - ' + f)); process.exit(1); }
