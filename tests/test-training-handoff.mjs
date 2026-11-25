/**
 * test-training-handoff.mjs — pose/training-handoff.js (post-training inference, DOM-free):
 *   1. the targets: Nothing first, the Inference panel's targets (no custom range), default Random sample;
 *   2. every trainable model type maps to an Inference panel pipeline (box types do not);
 *   3. `trainedModels`: one entry per fully trained group, folders in model order, incomplete groups named;
 *   4. `skeletonChangeProblem`: same names in any order pass; added / removed nodes are named.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    POST_TRAINING_TARGETS, POST_TRAINING_DEFAULTS, inferencePipelineFor, trainedModels, skeletonChangeProblem, handoffPlan,
} from '../pose/training-handoff.js';
import { MODEL_TYPE_OPTIONS } from '../ui/training-args.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// §1 targets.
assert.equal(POST_TRAINING_TARGETS[0][0], 'nothing');
assert.equal(POST_TRAINING_DEFAULTS.target, 'random');
assert.equal(POST_TRAINING_DEFAULTS.sampleCount, 20);
assert.equal(POST_TRAINING_DEFAULTS.existingPredictions, 'replace');
assert.equal(POST_TRAINING_DEFAULTS.skipUserLabeled, false);
assert.ok(POST_TRAINING_TARGETS.some((t) => t[0] === POST_TRAINING_DEFAULTS.target));
// Every target but Nothing is one the Inference panel's runner knows (ui/inference-panel.js TARGET_OPTIONS).
const inf = fs.readFileSync(path.join(root, 'ui', 'inference-panel.js'), 'utf8');
const block = inf.slice(inf.indexOf('const TARGET_OPTIONS'), inf.indexOf('];', inf.indexOf('const TARGET_OPTIONS')));
for (const [v] of POST_TRAINING_TARGETS.slice(1)) assert.ok(block.includes("'" + v + "'"), 'Inference panel target ' + v);
assert.ok(!POST_TRAINING_TARGETS.some((t) => t[0] === 'custom'), 'no custom range after training');

// §2 pipelines.
for (const o of MODEL_TYPE_OPTIONS) {
    const p = inferencePipelineFor(o.value);
    if (o.value === 'bbox' || o.value === 'top_down_bbox') assert.equal(p, null, o.value);
    else assert.ok(p && inf.includes("value: '" + p + "'"), o.value + ' -> ' + p);
}
assert.equal(inferencePipelineFor('top_down'), 'top-down');
assert.equal(inferencePipelineFor('bottom_up_id'), 'bottom-up-id');

// §3 trained models.
const groups = [
    { id: 'view:cam1', name: 'cam1', views: ['cam1'] },
    { id: 'view:cam2', name: 'cam2', views: ['cam2'] },
    { id: 'view:cam3', name: 'cam3', views: ['cam3'] },
];
const rows = [
    { groupId: 'view:cam1', status: 'completed', modelDir: '/runs/c1.centroid' },
    { groupId: 'view:cam1', status: 'completed', modelDir: '/runs/c1.centered_instance' },
    { groupId: 'view:cam2', status: 'completed', modelDir: '/runs/c2.centroid' },
    { groupId: 'view:cam2', status: 'completed', modelDir: null },          // worker did not say where
    { groupId: 'view:cam3', status: 'failed', modelDir: null },
];
const tm = trainedModels(rows, groups);
assert.deepEqual(tm.models, [{ groupId: 'view:cam1', name: 'cam1', views: ['cam1'], paths: ['/runs/c1.centroid', '/runs/c1.centered_instance'] }]);
assert.deepEqual(tm.incomplete, ['cam2', 'cam3']);
const shared = trainedModels([{ groupId: 'all', status: 'completed', modelDir: '/r/a' }], [{ id: 'all', name: 'all views', views: ['a', 'b'] }]);
assert.deepEqual(shared.models[0].views, ['a', 'b']);
assert.deepEqual(trainedModels([], groups).models, []);
assert.deepEqual(trainedModels(rows, []).models, []);

// §3b which model each view gets after training (a view in several models), and one pipeline at a time.
{
    const snap = [
        { id: 'top', name: 'Top', views: ['mid', 't1', 't2'], modelType: 'top_down' },
        { id: 'side', name: 'Side', views: ['mid', 's1'], modelType: 'top_down' },
        { id: 'all', name: 'All', views: ['mid', 't1', 't2', 's1', 's2'], modelType: 'bottom_up' },
    ];
    const trained = snap.map((m) => ({ groupId: m.id, name: m.name, views: m.views.slice(), paths: ['/r/' + m.id] }));
    // By default each view gets its most specific model: mid → Side (2 views), t1/t2 → Top, s1 → Side, s2 → All (bottom-up).
    const p1 = handoffPlan(trained, snap, {});
    assert.equal(p1.modelType, 'top_down');
    assert.deepEqual(p1.models.map((m) => [m.name, m.views]), [['Top', ['t1', 't2']], ['Side', ['mid', 's1']]]);
    assert.deepEqual(p1.skipped, ['All']);
    // The user's pick wins when that model trained the view.
    const p2 = handoffPlan(trained, snap, { mid: 'top', s1: 'all', t1: 'nope' });
    assert.deepEqual(p2.models.map((m) => [m.name, m.views]), [['Top', ['mid', 't1', 't2']]]);
    assert.equal(p2.modelType, 'top_down');
    assert.deepEqual(p2.skipped, ['All']);
    // One model: everything it trained, nothing skipped.
    const one = handoffPlan([trained[2]], [snap[2]], {});
    assert.deepEqual([one.modelType, one.models[0].views, one.skipped], ['bottom_up', ['mid', 't1', 't2', 's1', 's2'], []]);
    // A model whose rows did not all finish is not in `trained`: its views fall to the others.
    const p3 = handoffPlan(trained.filter((t) => t.groupId !== 'side'), snap, {});
    assert.deepEqual(p3.models.map((m) => [m.name, m.views]), [['Top', ['mid', 't1', 't2']]]);
    assert.deepEqual(p3.skipped, ['All']);
    assert.deepEqual(handoffPlan([], snap, {}), { modelType: null, models: [], skipped: [] });
}

// §4 skeleton.
assert.equal(skeletonChangeProblem(['head', 'tail'], ['tail', 'head']), null);
assert.equal(skeletonChangeProblem([], []), null);
const msg = skeletonChangeProblem(['head', 'tail'], ['head', 'thorax']);
assert.ok(/added thorax/.test(msg) && /removed tail/.test(msg), msg);

console.log('test-training-handoff: ok');
