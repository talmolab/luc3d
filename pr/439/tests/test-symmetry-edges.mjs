/**
 * test-symmetry-edges.mjs — which node names pair up for the Visibility panel's
 * Symmetry Edges. The pairs come from the names alone, so a false pair draws a
 * line between unrelated nodes, and a missed one makes the toggle look broken.
 */
import { symmetricNodePairs, symmetryEdgesFor } from '../ui/overlays.js';

let passed = 0, failed = 0;
const check = (c, m) => { if (c) { passed++; console.log('  ✓ ' + m); } else { failed++; console.log('  ✗ ' + m); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const named = (names) => symmetricNodePairs(names).map(p => [names[p[0]], names[p[1]]]);

// A real skeleton (labels.v015_threeFemales): both spellings in one project.
const REAL = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
    'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
check(same(symmetricNodePairs(REAL), [[2, 1], [10, 11], [12, 13]]), 'a real skeleton gives its 3 pairs and nothing else');

for (const [l, r] of [
    ['Ear_L', 'Ear_R'], ['ear_l', 'ear_r'], ['L_ear', 'R_ear'], ['ear-L', 'ear-R'], ['ear L', 'ear R'], ['paw.l', 'paw.r'],
    ['left_ear', 'right_ear'], ['Left Ear', 'Right Ear'], ['ear_left', 'ear_right'], ['leftEar', 'rightEar'], ['earLeft', 'earRight'],
    ['leftear', 'rightear'],
    ['EarL', 'EarR'], ['LEar', 'REar'], ['Paw_L1', 'Paw_R1'], ['PawL2', 'PawR2'], ['fore_L_paw', 'fore_R_paw'],
    ['Ear_L', 'ear_r'],
]) {
    check(same(named([l, 'Nose', r]), [[l, r]]), `${l} pairs with ${r}`);
}

for (const names of [
    ['Ear_L', 'Nose'],                        // no opposite
    ['Ear_L', 'Paw_R'],                       // different parts
    ['Paw_L1', 'Paw_R2'],                     // different digits
    ['LED', 'RED'],                           // an acronym, not a side
    ['Bal', 'Bar'],                           // ordinary words
    ['Tail', 'Tair'],
    ['L', 'R_x'],
    ['Ear_L', 'Ear_L', 'Ear_R'],              // ambiguous: two lefts
    [],
]) {
    check(same(symmetricNodePairs(names), []), `no pair in ${JSON.stringify(names)}`);
}
check(same(named(['Ear_R', 'Paw_L', 'Ear_L', 'Paw_R']), [['Paw_L', 'Paw_R'], ['Ear_L', 'Ear_R']]),
    'several pairs come back in order of the left node');

const skeleton = { nodes: ['Ear_L', 'Ear_R', 'Paw_L', 'Paw_R'], edges: [[1, 0]] };
check(same(symmetryEdgesFor(skeleton), [[2, 3]]), 'a pair that is already an edge is left out, either direction');
check(same(symmetryEdgesFor({ nodes: [{ name: 'a_l' }, { name: 'a_r' }], edges: [] }), [[0, 1]]), 'node objects work too');
skeleton.edges.length = 0;
check(same(symmetryEdgesFor(skeleton), [[0, 1], [2, 3]]), 'removing an edge in place is noticed');
skeleton.nodes[3] = 'Tail';
check(same(symmetryEdgesFor(skeleton), [[0, 1]]), 'renaming a node in place is noticed');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
