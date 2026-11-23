/**
 * test-skeleton-chain-editor.mjs — the model half of Settings ▸ Triangulation Wizard ▸ Skeleton check's node tiles
 * (ui/skeleton-chain-editor.js): parts from and to the setting's text, a tile dropped from the bank, within a part,
 * into another part, onto New part and back onto the bank, a click adding a node, and a tile taken out.
 * The dragging itself is tests/e2e/skeleton-check.mjs §7.
 *
 * Run: node tests/test-skeleton-chain-editor.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const E = await import(pathToFileURL(path.join(ROOT, 'ui/skeleton-chain-editor.js')).href);
let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) { if (cond) passed++; else { failed++; failures.push(msg); console.error('  ✗ ' + msg); } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const BANK = -1;

console.log('• text');
{
    const text = 'Nose, Head, Neck\nTTI, Tail_0, Tail_1';
    const parts = E.textToParts(text);
    ok(eq(parts, [['Nose', 'Head', 'Neck'], ['TTI', 'Tail_0', 'Tail_1']]), 'the setting\'s text gives one part per line');
    ok(E.partsToText(parts) === text, 'and the parts give the same text back');
    ok(E.partsToText([['A'], [], ['B', 'C']]) === 'A\nB, C', 'an empty part writes nothing');
    ok(eq(E.textToParts(''), []), 'no text: no parts');
}

console.log('• dropping a tile');
{
    const P = [['TTI', 'Tail_0', 'Tail_2'], ['Head', 'Nose']];
    ok(eq(E.dropTile(P, { name: 'Tail_1', part: BANK, index: -1 }, { part: 0, index: 2 }), [['TTI', 'Tail_0', 'Tail_1', 'Tail_2'], ['Head', 'Nose']]),
        'from the bank into a part, where it is dropped (the bank keeps it)');
    ok(eq(E.dropTile(P, { name: 'TTI', part: BANK, index: -1 }, { part: 0, index: 3 }), P),
        'a node the part already holds changes nothing');
    ok(eq(E.dropTile(P, { name: 'Tail_2', part: 0, index: 2 }, { part: 0, index: 1 }), [['TTI', 'Tail_2', 'Tail_0'], ['Head', 'Nose']]),
        'within a part: moved earlier');
    ok(eq(E.dropTile(P, { name: 'TTI', part: 0, index: 0 }, { part: 0, index: 3 }), [['Tail_0', 'Tail_2', 'TTI'], ['Head', 'Nose']]),
        'within a part: moved to the end');
    ok(eq(E.dropTile(P, { name: 'Tail_0', part: 0, index: 1 }, { part: 0, index: 2 }), P), 'within a part: dropped where it was');
    ok(eq(E.dropTile(P, { name: 'Nose', part: 1, index: 1 }, { part: 0, index: 0 }), [['Nose', 'TTI', 'Tail_0', 'Tail_2'], ['Head']]),
        'into another part: moved there');
    ok(eq(E.dropTile([['A', 'B'], ['C', 'A']], { name: 'A', part: 1, index: 1 }, { part: 0, index: 2 }), [['A', 'B'], ['C', 'A']]),
        'into another part that already holds it: nothing changes');
    ok(eq(E.dropTile(P, { name: 'Neck', part: BANK, index: -1 }, { part: 2, index: 0 }), [...P, ['Neck']]), 'onto New part: a new part');
    ok(eq(E.dropTile(P, { name: 'Nose', part: 1, index: 1 }, { part: 2, index: 0 }), [['TTI', 'Tail_0', 'Tail_2'], ['Head'], ['Nose']]),
        'a part\'s tile onto New part: moved into a new part');
    ok(eq(E.dropTile(P, { name: 'Head', part: 1, index: 0 }, { part: BANK, index: 0 }), [['TTI', 'Tail_0', 'Tail_2'], ['Nose']]),
        'back onto the bank: out of its part');
    ok(eq(E.dropTile([['A'], ['B', 'C']], { name: 'A', part: 0, index: 0 }, { part: 1, index: 1 }), [['B', 'A', 'C']]),
        'a part emptied by a move goes');
}

console.log('• clicking and taking out');
{
    let r = E.appendTile([], 'Nose', 0);
    ok(eq(r.parts, [['Nose']]) && r.part === 0, 'a click with no part starts one');
    r = E.appendTile(r.parts, 'Head', r.part);
    r = E.appendTile(r.parts, 'Neck', r.part);
    ok(eq(r.parts, [['Nose', 'Head', 'Neck']]), 'clicks add nodes in order to the selected part');
    ok(eq(E.appendTile(r.parts, 'Head', 0).parts, r.parts), 'a node the part holds is not added twice');
    ok(eq(E.appendTile(r.parts, 'TTI', 1).parts, [['Nose', 'Head', 'Neck'], ['TTI']]), 'New part selected: a new part');
    ok(eq(E.removeTile(r.parts, 0, 1), [['Nose', 'Neck']]), 'a tile\'s × takes it out');
    ok(eq(E.removeTile([['A']], 0, 0), []), 'and an emptied part goes');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
