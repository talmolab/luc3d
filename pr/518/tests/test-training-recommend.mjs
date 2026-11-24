/**
 * test-training-recommend.mjs — pose/training-recommend.js: sleap-app's pipeline recommendation,
 * skeleton compatibility and arborescence checks (same rules and messages).
 */
import assert from 'node:assert/strict';
import { recommendPipeline, skeletonCompatibility, isSkeletonConnected, arborescenceProblems, arborescenceMessage } from '../pose/training-recommend.js';

const inst = (x0, y0, w) => [[x0, y0, true], [x0 + w, y0 + w, true], [NaN, NaN, false]];

// §1 recommendation.
assert.equal(recommendPipeline({ frames: [] }), null);
assert.equal(recommendPipeline({ frames: [{ instances: [], maxDim: 512 }], numEdges: 1, trackCount: 0 }), null, 'no user instance: no suggestion');
assert.equal(recommendPipeline({ frames: [{ instances: [inst(0, 0, 100)], maxDim: 512 }], numEdges: 1 }).recommended, 'single_animal');
const small = recommendPipeline({ frames: [{ instances: [inst(0, 0, 20), inst(100, 100, 20)], maxDim: 512 }], numEdges: 2, trackCount: 2 });
assert.equal(small.recommended, 'top_down');
assert.match(small.reason, /Animals are small \(~4% of frame\)/);
assert.deepEqual(small.alternatives, ['bottom_up', 'top_down_id']);
const big = recommendPipeline({ frames: [{ instances: [inst(0, 0, 200), inst(100, 100, 200)], maxDim: 512 }], numEdges: 2, trackCount: 1 });
assert.equal(big.recommended, 'bottom_up');
assert.deepEqual(big.alternatives, ['top_down']);
const noEdges = recommendPipeline({ frames: [{ instances: [inst(0, 0, 200), inst(100, 100, 200)], maxDim: 512 }], numEdges: 0, trackCount: 0 });
assert.equal(noEdges.recommended, 'top_down');
assert.match(noEdges.reason, /No skeleton edges/);
// LUCID: each view against ITS OWN size — 100 px is small in a 2000 px camera, large in a 400 px one.
const mixed = recommendPipeline({ frames: [
    { instances: [inst(0, 0, 100), inst(300, 300, 100)], maxDim: 2000 },
    { instances: [inst(0, 0, 100), inst(200, 200, 100)], maxDim: 400 },
], numEdges: 2, trackCount: 0 });
assert.match(mixed.reason, /~15% of frame/, 'average of 5 % and 25 %');

// §2 skeleton compatibility.
assert.equal(isSkeletonConnected({ nodes: ['a'], edges: [] }), true);
assert.equal(isSkeletonConnected({ nodes: ['a', 'b', 'c'], edges: [[0, 1]] }), false);
assert.equal(isSkeletonConnected({ nodes: ['a', 'b', 'c'], edges: [[0, 1], [2, 1]] }), true);
const none = skeletonCompatibility({ nodes: ['a', 'b'], edges: [] });
assert.ok(none.disabledTypes.has('bottom_up') && none.disabledTypes.has('bottom_up_id') && !none.disabledTypes.has('top_down'));
const split = skeletonCompatibility({ nodes: ['a', 'b', 'c'], edges: [[0, 1]] });
assert.equal(split.warnings.get('bottom_up'), 'Bottom-Up works best with a fully connected skeleton');

// §3 arborescence.
assert.equal(arborescenceProblems({ nodes: ['a', 'b', 'c'], edges: [[0, 1], [1, 2]] }), null);
const two = arborescenceProblems({ nodes: ['a', 'b', 'c'], edges: [[0, 2], [1, 2]] });
assert.deepEqual(two.roots, ['a', 'b']);
assert.deepEqual(two.multiParent, ['c']);
const cyc = arborescenceProblems({ nodes: ['a', 'b', 'c'], edges: [[0, 1], [1, 2], [2, 0]] });
assert.equal(cyc.cycles.length, 1);
assert.match(arborescenceMessage(cyc), /^Bottom-Up needs a skeleton that is a tree with one root\. The edges form a cycle: a → b → c → a\.$/);
assert.match(arborescenceMessage(two), /several root nodes \(nodes no edge points to\): a, b\. These nodes are the target of more than one edge: c\./);

console.log('test-training-recommend: ok');
