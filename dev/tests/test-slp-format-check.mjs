/**
 * test-slp-format-check.mjs — the rule for refusing a `.slp` too new to read.
 *
 * Python sleap-io 0.10 writes SLP format 3.0 by default, and LUC3D's readers,
 * knowing only the 2.x layout, read such a file as 0 frames with no error. The
 * rule and its wording live in `loading/slp-format-check.js`, a module with no
 * imports so this test can load it. `tests/e2e/slp-newer-format.mjs` covers the
 * real readers and loaders, and that the vendored reader's copy of the wording
 * matches this one. ESM, so `tests/run-mjs-tests.mjs` picks it up.
 */
import {
    SLP_FORMAT_ID_LIMIT, newerSlpFormatMessage, checkSlpFormatAttrs,
    isNewerSlpFormatError, slpReadErrorStatus,
} from '../loading/slp-format-check.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};

const thrownBy = (attrs, name) => {
    try { checkSlpFormatAttrs(attrs, name); } catch (e) { return e; }
    return null;
};

console.log('\n1. Refused at or above 3.0, in either attribute shape');
{
    check(SLP_FORMAT_ID_LIMIT === 3, 'the limit is 3.0');
    for (const id of [3, 3.1, 4]) {
        const wrapped = thrownBy({ format_id: { value: id } }, 'mice.slp');
        check(wrapped && wrapped.formatId === id, `${id}, as h5wasm gives it ({ value })`);
        check(thrownBy({ format_id: id }, 'mice.slp') !== null, `${id}, bare`);
    }
}

console.log('\n2. Everything else passes, a file with no format_id included');
{
    for (const id of [1, 1.2, 2.8, 2.99]) {
        check(thrownBy({ format_id: { value: id } }) === null, `${id}`);
    }
    check(thrownBy({ json: { value: '{}' } }) === null, 'attributes with no format_id');
    check(thrownBy({}) === null, 'no attributes');
    check(thrownBy(null) === null, 'no /metadata at all');
    check(thrownBy({ format_id: { value: 'not a number' } }) === null, 'a format_id that is not a number');
}

console.log('\n3. The message');
{
    const e = thrownBy({ format_id: { value: 3 } }, 'mice.slp');
    check(e.message === 'mice.slp uses SLP format 3.0, which is newer than this version of LUC3D'
        + ' supports (max 2.x). Update LUC3D to read it, or re-save the file from Python sleap-io'
        + ' with `legacy_format=True`.', `says what to do: ${e.message}`);
    check(!/sleap-io\.js/.test(e.message), 'and does not name a library LUC3D users have not heard of');
    check(newerSlpFormatMessage(4, 'a.slp').startsWith('a.slp uses SLP format 4.0,'), 'whole versions keep their .0');
    check(newerSlpFormatMessage(3.1, 'a.slp').startsWith('a.slp uses SLP format 3.1,'), 'others are as they are');
    for (const name of [undefined, null, '']) {
        check(newerSlpFormatMessage(3, name).startsWith('This file uses SLP format 3.0,'), `no name (${JSON.stringify(name)})`);
    }
}

console.log('\n4. Telling a refusal from any other failure');
{
    const refusal = thrownBy({ format_id: 3 }, 'mice.slp');
    check(refusal.name === 'UnsupportedSlpFormatError', 'it has the vendored error\'s name');
    check(isNewerSlpFormatError(refusal), 'a refusal is one');
    // What `parseSlpH5` rebuilds from the worker's message, and the vendored class.
    const named = new Error('x'); named.name = 'UnsupportedSlpFormatError';
    check(isNewerSlpFormatError(named), 'by name, so it holds across the worker and the bundle');
    for (const other of [new Error('corrupt'), new TypeError('x'), 'text', null, undefined]) {
        check(!isNewerSlpFormatError(other), `${String(other)} is not`);
    }
}

console.log('\n5. Status text');
{
    const refusal = thrownBy({ format_id: 3 }, 'mice.slp');
    check(slpReadErrorStatus('SLP parse error', refusal) === refusal.message,
        'a refusal stands alone: nothing failed to parse');
    check(slpReadErrorStatus('SLP parse error', new Error('bad')) === 'SLP parse error: bad', 'anything else keeps its prefix');
    check(slpReadErrorStatus('Oops', 'text') === 'Oops: text', 'and a thrown string works too');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
